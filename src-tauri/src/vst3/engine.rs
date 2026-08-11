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
    /// Device switches, sent to the thread that owns the stream along with a
    /// channel to answer on. Requests are answered rather than fired and
    /// forgotten, so the picker can say what went wrong.
    switches: Mutex<mpsc::Sender<Switch>>,
    /// Keeps the audio thread — and with it the stream — alive.
    _stream_thread: std::thread::JoinHandle<()>,
}

/// A request to move rendering to another device, and where to report back.
struct Switch {
    /// The endpoint's name, or `None` for whatever the system default is.
    name: Option<String>,
    reply: mpsc::Sender<Result<(), String>>,
}

impl Engine {
    /// Open an output device and start the audio thread.
    ///
    /// `preferred` names the endpoint to open; the system default is used when
    /// it is absent or no longer connected.
    pub fn start(preferred: Option<String>) -> Result<Engine, String> {
        let (tx, rx) = rtrb::RingBuffer::new(QUEUE_CAPACITY);
        let (retire_tx, retire_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (switch_tx, switch_rx) = mpsc::channel::<Switch>();
        let peak = Arc::new(AtomicU32::new(0));
        let callback_peak = Arc::clone(&peak);

        // The stream is neither `Send` nor `Sync`, so it lives out its life on
        // the thread that made it. This thread exists purely to own it — and,
        // now, to be the one place a stream is ever replaced.
        let stream_thread = std::thread::spawn(move || {
            match build_stream(rx, retire_tx, callback_peak, preferred.as_deref()) {
                Ok((mut stream, shared, sample_rate)) => {
                    let _ = ready_tx.send(Ok(sample_rate));
                    // Parking would be enough to keep the stream alive, but the
                    // thread has work now: it waits for switches instead, and
                    // ends when the engine that sends them is dropped.
                    while let Ok(switch) = switch_rx.recv() {
                        let result =
                            switch_device(&mut stream, &shared, sample_rate, switch.name.as_deref());
                        let _ = switch.reply.send(result);
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
            switches: Mutex::new(switch_tx),
            _stream_thread: stream_thread,
        })
    }

    /// Move rendering to the endpoint called `name`, or to the system default.
    ///
    /// Plugins keep playing throughout: only the stream underneath them is
    /// replaced. Blocks until the swap has happened, so the picker reports a
    /// device that could not be opened instead of quietly appearing to work.
    pub fn set_output_device(&self, name: Option<&str>) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.switches
            .lock()
            .unwrap()
            .send(Switch {
                name: name.map(str::to_string),
                reply: reply_tx,
            })
            .map_err(|_| "the audio thread is not running".to_string())?;

        reply_rx
            .recv()
            .map_err(|_| "the audio thread stopped while switching device".to_string())?
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

/// Everything the audio callback works on, in one place.
///
/// Split out of the callback so that the *stream* can be replaced — when the
/// user picks another output device — without losing the plugins, the clock or
/// the command queue along with it. A cpal stream owns its callback and hands
/// nothing back when it is dropped, so anything that has to outlive one cannot
/// live inside it.
struct Renderer {
    rx: rtrb::Consumer<Command>,
    retire: mpsc::Sender<Box<SendPlugin>>,
    peak: Arc<AtomicU32>,
    clock: Clock,
    slots: Vec<Slot>,
    /// Interleaved stereo scratch, mixed once per block and then spread across
    /// however many channels the device actually has.
    mix: Vec<f32>,
    frame: i64,
    /// Channel count of the device currently being rendered to. Re-read on
    /// every switch, because the next device need not be stereo either.
    device_channels: usize,
}

impl Renderer {
    fn new(
        rx: rtrb::Consumer<Command>,
        retire: mpsc::Sender<Box<SendPlugin>>,
        peak: Arc<AtomicU32>,
        sample_rate: f64,
        device_channels: usize,
    ) -> Renderer {
        Renderer {
            rx,
            retire,
            peak,
            clock: Clock::new(sample_rate),
            slots: Vec::with_capacity(MAX_PLUGINS),
            mix: vec![0.0f32; MAX_BLOCK * 2],
            frame: 0,
            device_channels,
        }
    }

    /// One block: drain the queue, then mix every plugin into `out`.
    fn render(&mut self, out: &mut [f32]) {
        // Drain commands first: a note that arrived for this block should be
        // heard in it, not in the next one.
        while let Ok(command) = self.rx.pop() {
            apply(
                command,
                &mut self.slots,
                &mut self.clock,
                self.frame,
                &self.retire,
            );
        }

        let channels = self.device_channels;
        let frames_total = out.len() / channels;
        let mut done = 0;

        // A device asking for more than the plugins were set up for is split
        // rather than truncated.
        while done < frames_total {
            let frames = (frames_total - done).min(MAX_BLOCK);
            let block_start = self.frame + done as i64;

            self.mix[..frames * 2].fill(0.0);
            for slot in self.slots.iter_mut() {
                slot.plugin.0.process_into(&mut self.mix, frames, block_start);
            }

            let block_peak = self.mix[..frames * 2]
                .iter()
                .fold(0.0f32, |a, s| a.max(s.abs()));
            if block_peak > f32::from_bits(self.peak.load(Ordering::Relaxed)) {
                self.peak.store(block_peak.to_bits(), Ordering::Relaxed);
            }

            for f in 0..frames {
                let left = self.mix[f * 2];
                let right = self.mix[f * 2 + 1];
                let base = (done + f) * channels;

                match channels {
                    1 => out[base] = (left + right) * 0.5,
                    _ => {
                        out[base] = left;
                        out[base + 1] = right;
                        for extra in out[base + 2..base + channels].iter_mut() {
                            *extra = 0.0;
                        }
                    }
                }
            }

            done += frames;
        }

        self.frame += frames_total as i64;
    }
}

/// The renderer, shared between the audio callback and the thread that swaps
/// streams over.
///
/// The audio thread only ever `try_lock`s it, so it still never blocks — the
/// promise the rest of this module is built on. The one time the lock is
/// contended is a device switch, and for those few milliseconds the callback
/// writes silence, which is what the old device should be producing anyway.
type Shared = Arc<Mutex<Renderer>>;

/// The endpoint called `name`, if this machine has one.
fn named_device(name: &str) -> Option<cpal::Device> {
    cpal::default_host()
        .output_devices()
        .ok()?
        .find(|device| device.name().is_ok_and(|found| found == name))
}

/// The system default endpoint.
fn default_device() -> Result<cpal::Device, String> {
    cpal::default_host()
        .default_output_device()
        .ok_or("no audio output device".to_string())
}

/// The endpoint to *start* on: the saved one, or the default if it has gone.
///
/// Falling back rather than failing, because this runs at engine start with a
/// setting that may be months old. A keyboard unplugged since then must not be
/// what stops the app making any sound at all.
fn start_device(name: Option<&str>) -> Result<cpal::Device, String> {
    match name.and_then(named_device) {
        Some(device) => Ok(device),
        None => default_device(),
    }
}

/// The endpoint to *switch* to, which must be the one that was asked for.
///
/// Unlike starting up, this answers a choice the user is making right now. A
/// silent fall back to the default would leave the picker showing a device that
/// is not the one playing — the exact confusion it exists to end.
fn switch_target(name: Option<&str>) -> Result<cpal::Device, String> {
    match name {
        None => default_device(),
        Some(wanted) => named_device(wanted).ok_or_else(|| format!("{wanted} is not connected")),
    }
}

/// A config for `device` at `sample_rate`, or `None` if it cannot run at it.
///
/// The session's sample rate is fixed when the engine starts, because every
/// plugin is instantiated for it. So a device is only usable here if it can
/// meet that rate; re-rating the whole graph mid-session would mean rebuilding
/// every plugin and losing its state.
fn config_at(device: &cpal::Device, sample_rate: f64) -> Option<cpal::SupportedStreamConfig> {
    let rate = cpal::SampleRate(sample_rate as u32);
    device
        .supported_output_configs()
        .ok()?
        .find(|range| {
            range.sample_format() == cpal::SampleFormat::F32
                && range.min_sample_rate() <= rate
                && range.max_sample_rate() >= rate
        })
        .map(|range| range.with_sample_rate(rate))
}

/// Open a stream on `device` and start it, rendering from `shared`.
fn open_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    shared: &Shared,
) -> Result<cpal::Stream, String> {
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    // Ask for a bounded block so the plugins' `maxSamplesPerBlock` is honoured.
    stream_config.buffer_size = cpal::BufferSize::Default;

    let renderer = Arc::clone(shared);
    let stream = device
        .build_output_stream(
            &stream_config,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| match renderer.try_lock() {
                Ok(mut renderer) => renderer.render(out),
                // A switch is in progress and this stream is on its way out, or
                // is the one just built and not yet configured. Either way the
                // buffer must still be written, or the device repeats whatever
                // was last in it.
                Err(_) => out.fill(0.0),
            },
            |err| eprintln!("vst3: audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the audio stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("could not start the audio stream: {e}"))?;
    Ok(stream)
}

/// Build the first output stream, and with it the renderer everything after
/// this shares.
fn build_stream(
    rx: rtrb::Consumer<Command>,
    retire: mpsc::Sender<Box<SendPlugin>>,
    peak: Arc<AtomicU32>,
    preferred: Option<&str>,
) -> Result<(cpal::Stream, Shared, f64), String> {
    let device = start_device(preferred)?;
    // The device's own default config, not a requested one: this is what fixes
    // the session's sample rate, so it should be the rate the hardware likes.
    let config = device
        .default_output_config()
        .map_err(|e| format!("no default output config: {e}"))?;

    let sample_rate = config.sample_rate().0 as f64;
    let shared: Shared = Arc::new(Mutex::new(Renderer::new(
        rx,
        retire,
        peak,
        sample_rate,
        config.channels() as usize,
    )));

    let stream = open_stream(&device, &config, &shared)?;
    Ok((stream, shared, sample_rate))
}

/// Move rendering onto `name`, keeping everything that is loaded and playing.
///
/// The new stream is opened *before* the old one is let go, so a device that
/// cannot be opened leaves the engine exactly as it was rather than silent. The
/// renderer lock is held across the swap, which is what stops the two streams
/// rendering the same block twice on the way through.
fn switch_device(
    current: &mut cpal::Stream,
    shared: &Shared,
    sample_rate: f64,
    name: Option<&str>,
) -> Result<(), String> {
    let device = switch_target(name)?;
    let config = config_at(&device, sample_rate).ok_or_else(|| {
        format!(
            "{} cannot run at {} Hz, which is the rate this session's plugins were built for",
            device.name().unwrap_or_else(|_| "that device".to_string()),
            sample_rate as u32
        )
    })?;

    let mut renderer = shared.lock().unwrap();
    let stream = open_stream(&device, &config, shared)?;
    renderer.device_channels = config.channels() as usize;

    // The old stream is dropped here, while the lock is still held, so its
    // callback cannot render one last block against the new channel count.
    let old = std::mem::replace(current, stream);
    drop(old);
    drop(renderer);

    Ok(())
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
