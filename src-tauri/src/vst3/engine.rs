//! The audio thread, and the queue that feeds it.
//!
//! One cpal output stream carries every hosted plugin. The webview never talks
//! to it directly: commands go onto a lock-free queue and are drained at the top
//! of each block, so the audio callback never takes a lock, never allocates and
//! never blocks. Plugins are built and destroyed on other threads and only
//! *handed* to the audio thread, for the same reason.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use vst3::Steinberg::Vst::IComponentTrait;
use vst3::Steinberg::{kResultOk, IBStream};
use vst3::ComWrapper;

use super::clock::Clock;
use super::plugin::Plugin;
use super::stream::MemoryStream;

/// How many plugins may be loaded at once. Fixed so the audio thread's table
/// never has to grow.
const MAX_PLUGINS: usize = 32;

/// Commands in flight. Generous: a scheduling tick can carry a chord's worth of
/// notes and the queue is drained every block.
const QUEUE_CAPACITY: usize = 4096;

/// The largest block the audio device is allowed to ask for. Plugins are set up
/// for this, and a device asking for more is split across several calls.
const MAX_BLOCK: usize = 2048;

/// A slot index in the audio thread's plugin table.
type SlotId = u32;

/// What a track currently hosts.
struct Hosted {
    slot: SlotId,
    /// Which plugin class is in that slot, so a redundant load can be
    /// recognised as one.
    class_id: String,
}

/// A `Plugin` on its way to or from the audio thread.
///
/// VST3 explicitly allows a component to be created on one thread and processed
/// on another — it is how every DAW works — but COM pointers carry no such
/// promise in Rust's type system, so the guarantee is asserted here.
struct SendPlugin(Plugin);
unsafe impl Send for SendPlugin {}

/// A control-side reference to a plugin's component, for reading and writing
/// its state while the audio thread owns the plugin itself.
struct SendComponent(vst3::ComPtr<vst3::Steinberg::Vst::IComponent>);
unsafe impl Send for SendComponent {}

/// A control-side reference to a plugin's edit controller, for opening its
/// editor from the main thread.
pub struct SendController(pub vst3::ComPtr<vst3::Steinberg::Vst::IEditController>);
unsafe impl Send for SendController {}

enum Command {
    Insert { slot: SlotId, plugin: Box<SendPlugin> },
    Remove { slot: SlotId },
    Note { slot: SlotId, pitch: i16, velocity: u8, host_time: f64, duration: f64 },
    Gain { slot: SlotId, gain: f32 },
    /// Release everything sounding on one plugin.
    Stop { slot: SlotId },
    /// Release everything sounding, everywhere.
    StopAll,
    /// Re-anchor the clock. `host_time` has already been corrected for the
    /// delay between the webview reading it and this command being queued.
    Sync { host_time: f64 },
}

/// The control-side handle. Cheap to clone commands into from any thread.
pub struct Engine {
    /// `Producer` is `Send` but not `Sync`; commands arrive from arbitrary Tauri
    /// command threads, so it is behind a lock. The audio thread never touches
    /// this lock — only the consumer end, which needs none.
    tx: Mutex<rtrb::Producer<Command>>,
    /// Plugins the audio thread has handed back, waiting to be dropped here
    /// rather than on it.
    retired: Mutex<mpsc::Receiver<Box<SendPlugin>>>,
    /// What each track hosts, and where.
    slots: Mutex<HashMap<String, Hosted>>,
    /// Control-side component references, for state.
    components: Mutex<HashMap<String, SendComponent>>,
    /// Control-side controller references, for the editor.
    controllers: Mutex<HashMap<String, SendController>>,
    /// Loudest sample rendered since this was last read, as `f32` bits.
    ///
    /// The only way to ask "did anything actually come out" from outside the
    /// audio thread. A single atomic, so the callback pays almost nothing.
    peak: Arc<AtomicU32>,
    sample_rate: f64,
    /// Keeps the audio thread — and with it the stream — alive.
    _stream_thread: std::thread::JoinHandle<()>,
}

impl Engine {
    /// Open the default output device and start the audio thread.
    pub fn start() -> Result<Engine, String> {
        let (tx, rx) = rtrb::RingBuffer::new(QUEUE_CAPACITY);
        let (retire_tx, retire_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let peak = Arc::new(AtomicU32::new(0));
        let callback_peak = Arc::clone(&peak);

        // The stream is neither `Send` nor `Sync`, so it lives out its life on
        // the thread that made it. This thread exists purely to own it.
        let stream_thread = std::thread::spawn(move || {
            match build_stream(rx, retire_tx, callback_peak) {
                Ok((stream, sample_rate)) => {
                    if stream.play().is_err() {
                        let _ = ready_tx.send(Err("could not start the audio stream".to_string()));
                        return;
                    }
                    let _ = ready_tx.send(Ok(sample_rate));
                    loop {
                        std::thread::park();
                    }
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                }
            }
        });

        let sample_rate = ready_rx
            .recv()
            .map_err(|_| "the audio thread stopped before it started".to_string())??;

        Ok(Engine {
            tx: Mutex::new(tx),
            retired: Mutex::new(retire_rx),
            slots: Mutex::new(HashMap::new()),
            components: Mutex::new(HashMap::new()),
            controllers: Mutex::new(HashMap::new()),
            peak,
            sample_rate,
            _stream_thread: stream_thread,
        })
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// The loudest sample rendered since the last call, and reset.
    ///
    /// Reading destructively is what makes this answer "did anything come out
    /// *recently*" rather than "ever".
    pub fn take_peak(&self) -> f32 {
        f32::from_bits(self.peak.swap(0, Ordering::Relaxed))
    }

    fn send(&self, command: Command) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .push(command)
            .map_err(|_| "the audio thread is not keeping up".to_string())
    }

    /// Drop anything the audio thread has handed back.
    ///
    /// Called from the control side because a plugin's destructor calls into
    /// third-party code, which may allocate or block — neither is allowed on the
    /// audio thread.
    fn collect_retired(&self) {
        let retired = self.retired.lock().unwrap();
        while retired.try_recv().is_ok() {}
    }

    /// Load `class_id` from `path` and attach it to `track_id`, replacing
    /// whatever that track had.
    ///
    /// A track already hosting this exact plugin is left strictly alone. The
    /// call arrives more than once by design — the editor loads on demand and
    /// Play loads again — and a second instance would come up on its defaults,
    /// discarding whatever was set up in the plugin's own editor and leaving
    /// that editor attached to a component about to be terminated.
    pub fn load(&self, track_id: &str, path: &PathBuf, class_id: &str) -> Result<(), String> {
        if self.hosts(track_id, class_id) {
            return Ok(());
        }

        self.collect_retired();

        // Built here, on this thread: loading a plugin reads files, allocates
        // and can take seconds.
        let plugin = Plugin::load(path, class_id, self.sample_rate, MAX_BLOCK)?;

        // Taken before the plugin is handed over, because afterwards it belongs
        // to the audio thread.
        self.components
            .lock()
            .unwrap()
            .insert(track_id.to_string(), SendComponent(plugin.component_handle()));

        let mut controllers = self.controllers.lock().unwrap();
        match plugin.controller_handle() {
            Some(controller) => {
                controllers.insert(track_id.to_string(), SendController(controller));
            }
            // A plugin with no controller has no editor either; drop any stale
            // entry so the UI does not offer to open one.
            None => {
                controllers.remove(track_id);
            }
        }
        drop(controllers);

        let mut slots = self.slots.lock().unwrap();
        // Reusing the track's slot when it had one: a track changing plugin
        // must not leak the slot the old one occupied.
        let slot = match slots.get(track_id) {
            Some(existing) => existing.slot,
            None => {
                let used: Vec<SlotId> = slots.values().map(|h| h.slot).collect();
                (0..MAX_PLUGINS as SlotId)
                    .find(|s| !used.contains(s))
                    .ok_or("no free plugin slots")?
            }
        };
        slots.insert(
            track_id.to_string(),
            Hosted {
                slot,
                class_id: class_id.to_string(),
            },
        );
        drop(slots);

        self.send(Command::Insert {
            slot,
            plugin: Box::new(SendPlugin(plugin)),
        })
    }

    /// A track's edit controller, for opening its editor.
    pub fn controller(&self, track_id: &str) -> Option<vst3::ComPtr<vst3::Steinberg::Vst::IEditController>> {
        self.controllers
            .lock()
            .unwrap()
            .get(track_id)
            .map(|c| c.0.clone())
    }

    pub fn unload(&self, track_id: &str) -> Result<(), String> {
        self.components.lock().unwrap().remove(track_id);
        self.controllers.lock().unwrap().remove(track_id);

        let hosted = self.slots.lock().unwrap().remove(track_id);
        if let Some(hosted) = hosted {
            self.send(Command::Remove { slot: hosted.slot })?;
        }
        self.collect_retired();
        Ok(())
    }

    /// The plugin's own opaque state — its preset, in effect.
    pub fn get_state(&self, track_id: &str) -> Result<Vec<u8>, String> {
        let components = self.components.lock().unwrap();
        let component = components
            .get(track_id)
            .ok_or_else(|| format!("no plugin loaded for {track_id}"))?;

        let stream = ComWrapper::new(MemoryStream::empty());
        let ptr = stream
            .to_com_ptr::<IBStream>()
            .ok_or("could not build a stream")?;

        // SAFETY: the component is live, and the stream outlives the call.
        unsafe {
            if component.0.getState(ptr.as_ptr()) != kResultOk {
                return Err(format!("{track_id}: the plugin would not give up its state"));
            }
            Ok(stream.take())
        }
    }

    /// Restore state previously captured by [`Engine::get_state`].
    pub fn set_state(&self, track_id: &str, bytes: Vec<u8>) -> Result<(), String> {
        let components = self.components.lock().unwrap();
        let component = components
            .get(track_id)
            .ok_or_else(|| format!("no plugin loaded for {track_id}"))?;

        let stream = ComWrapper::new(MemoryStream::from_bytes(bytes));
        let ptr = stream
            .to_com_ptr::<IBStream>()
            .ok_or("could not build a stream")?;

        // SAFETY: as above.
        unsafe {
            if component.0.setState(ptr.as_ptr()) != kResultOk {
                return Err(format!("{track_id}: the plugin rejected the state"));
            }
        }
        Ok(())
    }

    /// Whether a track currently has a plugin.
    pub fn is_loaded(&self, track_id: &str) -> bool {
        self.slots.lock().unwrap().contains_key(track_id)
    }

    /// Whether `track_id` already hosts exactly `class_id`.
    fn hosts(&self, track_id: &str, class_id: &str) -> bool {
        self.slots
            .lock()
            .unwrap()
            .get(track_id)
            .is_some_and(|hosted| hosted.class_id == class_id)
    }

    fn slot_of(&self, track_id: &str) -> Option<SlotId> {
        self.slots.lock().unwrap().get(track_id).map(|h| h.slot)
    }

    /// Schedule one note. `host_time` and `duration` are in the webview's
    /// clock domain, in seconds.
    pub fn schedule(
        &self,
        track_id: &str,
        pitch: i16,
        velocity: u8,
        host_time: f64,
        duration: f64,
    ) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        self.send(Command::Note {
            slot,
            pitch,
            velocity,
            host_time,
            duration,
        })
    }

    pub fn set_gain(&self, track_id: &str, gain: f32) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        self.send(Command::Gain { slot, gain })
    }

    /// Release everything sounding on one track's plugin.
    pub fn stop(&self, track_id: &str) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        self.send(Command::Stop { slot })
    }

    pub fn stop_all(&self) -> Result<(), String> {
        self.send(Command::StopAll)
    }

    /// Re-anchor the clock against the webview's.
    ///
    /// `host_time` is what `AudioContext.currentTime` read in the webview. By
    /// the time the audio thread sees this command a block boundary may have
    /// passed, and it can only observe its own frame counter at block starts —
    /// so the elapsed wall time between here and there is measured and folded
    /// into `host_time` before it is used. Without that correction the anchor
    /// jitters by up to a block period, and every note placed against it jitters
    /// with it.
    pub fn sync(&self, host_time: f64) -> Result<(), String> {
        let queued_at = Instant::now();
        self.send(Command::Sync {
            host_time: host_time + queued_at.elapsed().as_secs_f64(),
        })
    }
}

/// One slot in the audio thread's plugin table.
struct Slot {
    id: SlotId,
    plugin: Box<SendPlugin>,
}

/// Build the output stream and the callback that drives every plugin.
fn build_stream(
    mut rx: rtrb::Consumer<Command>,
    retire: mpsc::Sender<Box<SendPlugin>>,
    peak: Arc<AtomicU32>,
) -> Result<(cpal::Stream, f64), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no audio output device")?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("no default output config: {e}"))?;

    let sample_rate = config.sample_rate().0 as f64;
    let device_channels = config.channels() as usize;
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    // Ask for a bounded block so the plugins' `maxSamplesPerBlock` is honoured.
    stream_config.buffer_size = cpal::BufferSize::Default;

    let mut clock = Clock::new(sample_rate);
    let mut slots: Vec<Slot> = Vec::with_capacity(MAX_PLUGINS);
    // Interleaved stereo scratch, mixed once per block and then spread across
    // however many channels the device actually has.
    let mut mix = vec![0.0f32; MAX_BLOCK * 2];
    let mut frame: i64 = 0;

    let callback = move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
        // Drain commands first: a note that arrived for this block should be
        // heard in it, not in the next one.
        while let Ok(command) = rx.pop() {
            apply(command, &mut slots, &mut clock, frame, &retire);
        }

        let frames_total = out.len() / device_channels;
        let mut done = 0;

        // A device asking for more than the plugins were set up for is split
        // rather than truncated.
        while done < frames_total {
            let frames = (frames_total - done).min(MAX_BLOCK);
            let block_start = frame + done as i64;

            mix[..frames * 2].fill(0.0);
            for slot in slots.iter_mut() {
                slot.plugin.0.process_into(&mut mix, frames, block_start);
            }

            let block_peak = mix[..frames * 2].iter().fold(0.0f32, |a, s| a.max(s.abs()));
            if block_peak > f32::from_bits(peak.load(Ordering::Relaxed)) {
                peak.store(block_peak.to_bits(), Ordering::Relaxed);
            }

            for f in 0..frames {
                let left = mix[f * 2];
                let right = mix[f * 2 + 1];
                let base = (done + f) * device_channels;

                match device_channels {
                    1 => out[base] = (left + right) * 0.5,
                    _ => {
                        out[base] = left;
                        out[base + 1] = right;
                        for extra in out[base + 2..base + device_channels].iter_mut() {
                            *extra = 0.0;
                        }
                    }
                }
            }

            done += frames;
        }

        frame += frames_total as i64;
    };

    let stream = device
        .build_output_stream(
            &stream_config,
            callback,
            |err| eprintln!("vst3: audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the audio stream: {e}"))?;

    Ok((stream, sample_rate))
}

/// Apply one command on the audio thread.
fn apply(
    command: Command,
    slots: &mut Vec<Slot>,
    clock: &mut Clock,
    frame: i64,
    retire: &mpsc::Sender<Box<SendPlugin>>,
) {
    match command {
        Command::Insert { slot: id, plugin } => {
            // Replacing rather than adding, so changing a track's plugin does
            // not leak the old one's slot.
            if let Some(existing) = slots.iter().position(|s| s.id == id) {
                let old = slots.swap_remove(existing);
                let _ = retire.send(old.plugin);
            }
            if slots.len() < slots.capacity() {
                slots.push(Slot { id, plugin });
            } else {
                let _ = retire.send(plugin);
            }
        }
        Command::Remove { slot: id } => {
            if let Some(at) = slots.iter().position(|s| s.id == id) {
                let old = slots.swap_remove(at);
                // Handed back rather than dropped here: the destructor calls
                // into the plugin, which may allocate or block.
                let _ = retire.send(old.plugin);
            }
        }
        Command::Note {
            slot: id,
            pitch,
            velocity,
            host_time,
            duration,
        } => {
            let Some(at) = clock.frame_for(host_time) else {
                return;
            };
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin
                    .0
                    .scheduler
                    .schedule_note(pitch, velocity, at, clock.frames_in(duration));
            }
        }
        Command::Gain { slot: id, gain } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.set_gain(gain);
            }
        }
        Command::Stop { slot: id } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.scheduler.stop_all();
            }
        }
        Command::StopAll => {
            for slot in slots.iter_mut() {
                slot.plugin.0.scheduler.stop_all();
            }
        }
        Command::Sync { host_time } => {
            clock.sync(host_time, frame.max(0) as u64);
        }
    }
}
