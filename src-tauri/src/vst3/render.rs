//! Rendering ahead of the device, so a slow block is not a gap in the sound.
//!
//! The default path renders inside the audio callback: the device asks for a
//! block, the plugins fill it, and it goes straight out. That is the simplest
//! thing that works and it is right up until one plugin is occasionally slow.
//! The deadline for a block is the time that block takes to *play* — ten
//! milliseconds at a typical Windows buffer — and a detailed sampled instrument
//! can spend forty on the one block that carries a chord's attacks. Every one of
//! those is a gap in the stream, which is heard as a click, and it lands at note
//! boundaries because that is where the work is, not because anything odd is
//! sent there.
//!
//! Rendering ahead breaks that link. A thread of its own fills a ring with
//! audio, the callback does nothing but copy out of it, and a block that takes
//! forty milliseconds spends slack in the ring rather than missing a deadline.
//! What still has to hold is the *average*: the plugins must render a second of
//! audio in less than a second. Measured on the library this was built for, they
//! render it in about a quarter of a second and only the peaks miss, which is
//! exactly the shape a ring fixes.
//!
//! What it costs is latency, in the same way and for the same reason a bigger
//! buffer does. The frame counter the clock is anchored to runs ahead of what is
//! being heard by however much is in the ring, so a note sounds that much later
//! than the webview's own instruments play it. An instrument's Nudge is the
//! remedy, which is what it was already there for.
//!
//! Off is a real path, not a headroom of zero: with nothing being rendered ahead
//! the callback renders as it always did, so the two can be compared rather than
//! one trusted.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::engine::Renderer;

/// Largest headroom offered, in milliseconds.
///
/// The ring is sized for this once and the target moved inside it, so changing
/// the setting never has to rebuild anything. Past a fifth of a second the delay
/// between a key and its sound is worse than the dropout it cures.
pub const MAX_HEADROOM_MS: u32 = 200;

/// Frames the pump renders at a time when the device has not said otherwise.
///
/// Small enough that the ring reaches its target smoothly and a Stop is heard
/// promptly, large enough that the per-block overhead is nothing.
const DEFAULT_BLOCK: usize = 512;

/// How long the pump waits before looking again when there is nothing to do.
///
/// A backstop rather than the mechanism: the callback wakes it the moment it
/// takes audio out. This is what keeps it running if a wake is ever missed.
const IDLE: Duration = Duration::from_millis(2);

/// Audio rendered ahead of the device, and the thread rendering it.
pub struct Ahead {
    /// Interleaved stereo waiting to be played.
    ///
    /// Stereo rather than the device's channel layout, so audio already rendered
    /// survives the device being changed underneath it. The callback spreads it.
    ///
    /// Behind a lock only so that a stream being replaced can hand it to the new
    /// callback; like the renderer's lock it is only ever `try_lock`ed from the
    /// audio thread, so that thread still never blocks.
    consumer: Mutex<rtrb::Consumer<f32>>,
    /// How full the pump keeps the ring, in samples.
    ///
    /// Zero parks the pump and hands rendering back to the audio callback, which
    /// is the path every session took before this existed.
    target: AtomicUsize,
    /// Frames the pump renders at a time.
    block: AtomicUsize,
    stop: AtomicBool,
    /// The pump, so the callback can wake it the moment it takes audio out.
    thread: Mutex<Option<thread::Thread>>,
}

impl Ahead {
    /// Sample rate is the session's, and fixes how many samples a millisecond is.
    pub(super) fn start(shared: Arc<Mutex<Renderer>>, sample_rate: f64) -> Arc<Ahead> {
        let capacity = ring_samples(MAX_HEADROOM_MS, sample_rate);
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(capacity);

        let ahead = Arc::new(Ahead {
            consumer: Mutex::new(consumer),
            target: AtomicUsize::new(0),
            block: AtomicUsize::new(DEFAULT_BLOCK),
            stop: AtomicBool::new(false),
            thread: Mutex::new(None),
        });

        let pump = Arc::clone(&ahead);
        let handle = thread::Builder::new()
            .name("vst3-render".to_string())
            .spawn(move || {
                pro_audio_priority();
                run(&pump, shared, producer);
            })
            .expect("the render thread could not be started");

        *ahead.thread.lock().unwrap() = Some(handle.thread().clone());
        ahead
    }

    /// Keep `ms` of audio ahead of the device, or none at all.
    ///
    /// Takes effect on the pump's next pass. Lowering it does not throw away what
    /// is already rendered — the ring simply drains to the new level, which is
    /// the quietest way to make the change.
    pub fn set_headroom(&self, ms: u32, sample_rate: f64) {
        let samples = if ms == 0 {
            0
        } else {
            ring_samples(ms.min(MAX_HEADROOM_MS), sample_rate)
        };
        self.target.store(samples, Ordering::Relaxed);
        self.wake();
    }

    /// How big a block the pump renders, following the device's own.
    pub fn set_block(&self, frames: Option<u32>) {
        let frames = frames.map_or(DEFAULT_BLOCK, |f| (f as usize).max(1));
        self.block.store(frames, Ordering::Relaxed);
    }

    /// Fill `out` from the ring, spreading it across `channels`.
    ///
    /// `None` means the caller should render for itself: nothing is being
    /// rendered ahead, and nothing is left over from when something was.
    /// `Some(n)` is the frames it could not fill — the ring having run dry,
    /// which is the one thing that can still be heard as a gap once rendering is
    /// ahead, and so the one worth counting.
    ///
    /// Audio already in the ring is played out even after the setting has been
    /// turned off, rather than thrown away. Discarding it would leave the frame
    /// counter that far ahead of what has actually been heard, and everything
    /// placed against it — every note in the next look-ahead pass — that far out
    /// of place until the next clock sync pulled it back.
    pub fn take(&self, out: &mut [f32], channels: usize) -> Option<usize> {
        let frames = out.len() / channels;
        let engaged = self.target.load(Ordering::Relaxed) > 0;

        let Ok(mut consumer) = self.consumer.try_lock() else {
            // Only ever contended while a stream is being replaced. Silence is
            // what the old device should be producing anyway — but only if this
            // is the path in use, or a device change would silence a callback
            // that is perfectly able to render for itself.
            if !engaged {
                return None;
            }
            out.fill(0.0);
            self.wake();
            return Some(frames);
        };

        let available = consumer.slots() / 2;
        if !engaged && available == 0 {
            return None;
        }

        let taken = available.min(frames);

        if taken > 0 {
            // `read_chunk` hands back the ring's own memory, in up to two pieces
            // where it wraps, so nothing is copied twice.
            if let Ok(chunk) = consumer.read_chunk(taken * 2) {
                let (first, second) = chunk.as_slices();
                let split = first.len() / 2;
                super::engine::spread(first, &mut out[..split * channels], channels);
                super::engine::spread(
                    second,
                    &mut out[split * channels..taken * channels],
                    channels,
                );
                chunk.commit_all();
            }
        }

        out[taken * channels..].fill(0.0);
        self.wake();
        Some(frames - taken)
    }

    fn wake(&self) {
        // `try_lock` because this is called from the audio callback: a missed
        // wake costs the pump one idle period, and blocking there would cost a
        // block of audio.
        if let Ok(thread) = self.thread.try_lock() {
            if let Some(thread) = thread.as_ref() {
                thread.unpark();
            }
        }
    }
}

impl Drop for Ahead {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(thread) = self.thread.lock() {
            if let Some(thread) = thread.as_ref() {
                thread.unpark();
            }
        }
        // Deliberately not joined. The pump takes the renderer's lock, and this
        // may well be dropped by the thread that holds it; the thread ends on its
        // own when it next sees the flag, and it holds nothing the process needs
        // back.
    }
}

/// Samples of interleaved stereo in `ms` at `sample_rate`, at least one block.
fn ring_samples(ms: u32, sample_rate: f64) -> usize {
    let frames = (sample_rate * f64::from(ms) / 1000.0) as usize;
    frames.max(DEFAULT_BLOCK) * 2
}

/// The pump: keep the ring at its target, and sleep the rest of the time.
fn run(ahead: &Ahead, shared: Arc<Mutex<Renderer>>, mut producer: rtrb::Producer<f32>) {
    while !ahead.stop.load(Ordering::Relaxed) {
        let target = ahead.target.load(Ordering::Relaxed);
        if target == 0 {
            // Nothing to do: the callback is rendering for itself. A long park,
            // because the only thing that ends it is the setting changing.
            thread::park_timeout(Duration::from_millis(50));
            continue;
        }

        let block = ahead.block.load(Ordering::Relaxed);
        let filled = producer.buffer().capacity() - producer.slots();
        if filled >= target || producer.slots() < block * 2 {
            thread::park_timeout(IDLE);
            continue;
        }

        // The lock is taken per block rather than held across several, so a
        // device change waiting on it waits at most one block.
        let Ok(mut renderer) = shared.lock() else {
            return;
        };
        let mix = renderer.render_stereo(block);

        if let Ok(mut chunk) = producer.write_chunk_uninit(mix.len()) {
            let (first, second) = chunk.as_mut_slices();
            for (slot, sample) in first.iter_mut().zip(mix.iter()) {
                slot.write(*sample);
            }
            for (slot, sample) in second.iter_mut().zip(mix[first.len()..].iter()) {
                slot.write(*sample);
            }
            // Safe: every slot handed out was just written, in the two pieces the
            // ring's wrap divides them into.
            unsafe { chunk.commit_all() };
        }
    }
}

/// Ask Windows to schedule this thread as audio.
///
/// cpal does this for the thread it owns and nothing does it for ours, which
/// would leave the thread that renders the sound at ordinary priority while the
/// one that merely copies it out is not. Failure is ignored: the characteristic
/// is an optimisation, and a thread that did not get it still renders.
#[cfg(windows)]
fn pro_audio_priority() {
    use windows::core::w;
    use windows::Win32::System::Threading::{AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority};
    use windows::Win32::System::Threading::AVRT_PRIORITY_HIGH;

    unsafe {
        let mut index = 0u32;
        if let Ok(handle) = AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut index) {
            let _ = AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH);
        }
    }
}

#[cfg(not(windows))]
fn pro_audio_priority() {}
