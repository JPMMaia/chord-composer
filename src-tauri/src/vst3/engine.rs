//! The audio thread, and the queue that feeds it.
//!
//! One cpal output stream carries every hosted plugin. The webview never talks
//! to it directly: commands go onto a lock-free queue and are drained at the top
//! of each block, so the audio callback never takes a lock, never allocates and
//! never blocks. Plugins are built and destroyed on other threads and only
//! *handed* to the audio thread, for the same reason.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use vst3::Steinberg::Vst::IComponentTrait;
use vst3::Steinberg::{kResultOk, IBStream};
use vst3::ComWrapper;

use super::clock::Clock;
use super::plugin::{Plugin, ResetMode, Transport};
use super::stream::MemoryStream;
use super::render::Ahead;
use super::trace::{self, Record};

/// How many plugins may be loaded at once. Fixed so the audio thread's table
/// never has to grow.
const MAX_PLUGINS: usize = 32;

/// Commands in flight. Generous: a scheduling tick can carry a chord's worth of
/// notes and the queue is drained every block.
const QUEUE_CAPACITY: usize = 4096;

/// The largest block the audio device is allowed to ask for. Plugins are set up
/// for this, and a device asking for more is split across several calls.
const MAX_BLOCK: usize = 2048;

/// How often the renderer reports what a callback is costing.
///
/// The plugins' own interval, so the two lines can be read against each other.
const LOAD_INTERVAL: Duration = Duration::from_secs(1);

/// How long `unload_all` waits for the audio thread to hand its plugins back.
///
/// Several blocks' worth at any sensible buffer size, and short enough that a
/// stream which has already died costs the quit a blink rather than a hang.
const RETIRE_WAIT: Duration = Duration::from_millis(200);

/// A slot index in the audio thread's plugin table.
type SlotId = u32;

/// The values sent to make a plugin's MIDI learn notice a controller.
///
/// A single value would not do: a control resting where it already is has not
/// moved, and a plugin waiting to learn is waiting for movement. Ending in the
/// middle leaves the control it binds somewhere usable rather than at an extreme.
const LEARN_SWEEP: [f64; 5] = [0.0, 1.0, 0.0, 1.0, 0.5];

/// The gap between them, in seconds.
///
/// Several audio blocks apart, so they reach the plugin as five changes over
/// time rather than five points crowded into one block.
const LEARN_STEP_SECONDS: f64 = 0.04;

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
    /// Sound a note now and hold it until a `Release` for the same pitch.
    Hold { slot: SlotId, pitch: i16, velocity: u8 },
    Release { slot: SlotId, pitch: i16 },
    Gain { slot: SlotId, gain: f32 },
    /// Drive one plugin parameter to `value`, normalised 0..=1.
    ///
    /// `host_time` of `None` means "in the next block" — what a preview from the
    /// picker and the pin at Play both want, neither of which has a moment in
    /// the future to aim at.
    Param { slot: SlotId, id: u32, value: f64, host_time: Option<f64> },
    /// Wiggle one parameter across the next few blocks.
    ///
    /// Its own command rather than a handful of `Param`s because the values have
    /// to be *spread in time*: sent untimed they would all land in the block
    /// being assembled, arriving as one change at one offset — a value, not the
    /// movement a plugin waiting to learn a controller is listening for. `step`
    /// is the gap between them in frames.
    LearnSweep { slot: SlotId, id: u32, step: i64 },
    /// Release everything sounding on one plugin.
    Stop { slot: SlotId },
    /// Release everything sounding, everywhere.
    StopAll,
    /// Say what the webview's transport is doing, so a plugin can be told.
    ///
    /// Carried through the same queue as the notes rather than read from a
    /// shared cell, so a tempo change lands on a block boundary like everything
    /// else and a plugin never sees two tempos inside one block.
    Transport {
        playing: bool,
        tempo: f64,
        numerator: i32,
        denominator: i32,
    },
    /// Re-anchor the clock.
    ///
    /// `queued_at` is when this command was put on the queue, and travels with
    /// it so that the audio thread can measure how long it waited: the anchor is
    /// only usable if `host_time` is corrected forward by that wait. Correcting
    /// it on the sending side is not possible — the wait has not happened yet.
    Sync { host_time: f64, queued_at: Instant },
}

/// What the audio thread has cost lately, published for the UI to read.
///
/// Plain atomics rather than the trace, because this has to be true whether or
/// not `CHORD_COMPOSER_VST3_LOG` is set: the trace exists to be read afterwards
/// by someone debugging, and this exists to be read *now* by someone choosing a
/// buffer size. The callback pays a handful of relaxed stores for it.
#[derive(Default)]
pub struct Health {
    /// Callbacks that took longer than the audio they produced will play for.
    /// Every one of these has already been heard as a gap.
    late: AtomicU64,
    /// The worst single callback, in microseconds.
    worst_us: AtomicU64,
    /// Time spent rendering, in microseconds.
    spent_us: AtomicU64,
    /// Audio produced in that time, in microseconds — the deadline `spent_us`
    /// was running against. The two together are the load.
    produced_us: AtomicU64,
    /// Frames the device asked for that could not be filled.
    ///
    /// Zero while rendering happens inside the callback, where there is nothing
    /// to run short of. It is the render-ahead ring that can be empty.
    starved: AtomicU64,
    /// Frames in the last callback, so the UI can say what block size the device
    /// settled on rather than what was asked for.
    block: AtomicU64,
}

impl Health {
    /// Fold one callback in.
    fn account(&self, spent: Duration, frames: usize, sample_rate: f64) {
        let spent_us = spent.as_micros() as u64;
        let produced_us = (frames as f64 / sample_rate * 1e6) as u64;

        self.spent_us.fetch_add(spent_us, Ordering::Relaxed);
        self.produced_us.fetch_add(produced_us, Ordering::Relaxed);
        self.block.store(frames as u64, Ordering::Relaxed);
        self.worst_us.fetch_max(spent_us, Ordering::Relaxed);
        if spent_us > produced_us {
            self.late.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Frames the device wanted and did not get.
    fn starve(&self, frames: usize) {
        self.starved.fetch_add(frames as u64, Ordering::Relaxed);
    }

    /// Everything since the last read, and reset.
    ///
    /// Destructive for the same reason `take_peak` is: what the user is asking
    /// is whether it is dropping out *now*, and a total that only ever grows
    /// cannot answer that. The UI polls this once a second.
    fn take(&self, sample_rate: f64) -> AudioHealth {
        let spent_us = self.spent_us.swap(0, Ordering::Relaxed);
        let produced_us = self.produced_us.swap(0, Ordering::Relaxed);

        AudioHealth {
            late: self.late.swap(0, Ordering::Relaxed),
            worst_us: self.worst_us.swap(0, Ordering::Relaxed),
            starved: self.starved.swap(0, Ordering::Relaxed),
            load: if produced_us == 0 {
                0.0
            } else {
                spent_us as f64 / produced_us as f64
            },
            block: self.block.load(Ordering::Relaxed) as u32,
            sample_rate,
        }
    }
}

/// One reading of `Health`, on its way to the webview.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioHealth {
    /// Callbacks that missed their deadline since the last reading.
    pub late: u64,
    /// The worst of them, in microseconds.
    pub worst_us: u64,
    /// Frames the device asked for and did not get.
    pub starved: u64,
    /// Render time over deadline: 1.0 means rendering took exactly as long as
    /// the audio it produced, which is the edge.
    pub load: f64,
    /// Frames in the last callback.
    pub block: u32,
    pub sample_rate: f64,
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
    /// Which `ParamID` each track's plugin receives a given MIDI controller as.
    ///
    /// Filled once per track from `IMidiMapping` and dropped with the plugin.
    /// Cached because a CC curve resolves the same controller twenty times per
    /// look-ahead pass and each resolution is a COM call on a Tauri thread.
    cc_maps: Mutex<HashMap<String, HashMap<u16, u32>>>,
    /// Loudest sample rendered since this was last read, as `f32` bits.
    ///
    /// The only way to ask "did anything actually come out" from outside the
    /// audio thread. A single atomic, so the callback pays almost nothing.
    peak: Arc<AtomicU32>,
    /// What the audio thread is costing, for the settings dialog to read.
    health: Arc<Health>,
    /// Audio rendered ahead of the device, and the thread rendering it.
    ahead: Arc<Ahead>,
    sample_rate: f64,
    /// Stream rebuilds — a device change or a block size change — sent to the
    /// thread that owns the stream along with a channel to answer on. Requests
    /// are answered rather than fired and forgotten, so the picker can say what
    /// went wrong.
    switches: Mutex<mpsc::Sender<Request>>,
    /// Keeps the audio thread — and with it the stream — alive.
    _stream_thread: std::thread::JoinHandle<()>,
}

/// Something only the thread that owns the stream may do.
///
/// Two things qualify, for the same underlying reason: that thread holds the
/// `cpal::Stream`, and it is the one place the renderer's lock is taken from
/// outside the audio path. Everything here is answered rather than fired and
/// forgotten, so the settings panel can say what went wrong.
enum Request {
    /// Build a new output stream — a device change, a block size change, or
    /// both.
    ///
    /// A request that changes one must leave the other exactly as it is, so the
    /// outer `Option` is "this request is changing it" and the inner value is
    /// what to change it to.
    Reopen {
        /// The endpoint to play through. Inner `None` is the system default.
        device: Option<Option<String>>,
        /// Frames per block to ask the device for. Inner `None` is the device's
        /// own preference, which is what every session had before this was
        /// settable.
        buffer: Option<Option<u32>>,
        /// `Ok(Some(..))` when it worked but not as asked — a buffer size the
        /// device would not take, say.
        reply: mpsc::Sender<Result<Option<String>, String>>,
    },
    /// Put hosted plugins back the way they were when they loaded.
    Reset {
        /// The one slot to reset, or every slot.
        slot: Option<SlotId>,
        mode: ResetMode,
        /// How many instruments were put back.
        reply: mpsc::Sender<Result<usize, String>>,
    },
}

impl Engine {
    /// Open an output device and start the audio thread.
    ///
    /// `preferred` names the endpoint to open; the system default is used when
    /// it is absent or no longer connected.
    pub fn start(preferred: Option<String>, buffer: Option<u32>) -> Result<Engine, String> {
        let (tx, rx) = rtrb::RingBuffer::new(QUEUE_CAPACITY);
        let (retire_tx, retire_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (switch_tx, switch_rx) = mpsc::channel::<Request>();
        let peak = Arc::new(AtomicU32::new(0));
        let callback_peak = Arc::clone(&peak);
        let health = Arc::new(Health::default());
        let callback_health = Arc::clone(&health);

        // The stream is neither `Send` nor `Sync`, so it lives out its life on
        // the thread that made it. This thread exists purely to own it — and,
        // now, to be the one place a stream is ever replaced.
        let stream_thread = std::thread::spawn(move || {
            // The switch path opens streams of its own, and each one's callback
            // needs the same counters this one's does.
            let switch_health = Arc::clone(&callback_health);
            match build_stream(
                rx,
                retire_tx,
                callback_peak,
                callback_health,
                preferred.as_deref(),
                buffer,
            ) {
                Ok((mut stream, shared, sample_rate, opened, ahead)) => {
                    let _ = ready_tx.send(Ok((sample_rate, Arc::clone(&ahead))));

                    // What the stream is on now, so a request changing only one
                    // of the two can re-open with the other as it stands. The
                    // device is the one that was *opened*, not the one that was
                    // asked for: start-up falls back when a remembered endpoint
                    // has been unplugged, and a later buffer change must not
                    // then fail over a device nobody is playing through.
                    let mut device = opened;
                    let mut block = buffer;

                    // Parking would be enough to keep the stream alive, but the
                    // thread has work now: it waits for requests instead, and
                    // ends when the engine that sends them is dropped.
                    while let Ok(request) = switch_rx.recv() {
                        match request {
                            Request::Reopen {
                                device: wanted,
                                buffer: wanted_buffer,
                                reply,
                            } => {
                                let wanted_device = wanted.clone().unwrap_or(device.clone());
                                let wanted_block = wanted_buffer.unwrap_or(block);

                                let result = reopen_stream(
                                    &mut stream,
                                    &shared,
                                    &switch_health,
                                    &ahead,
                                    sample_rate,
                                    wanted_device.as_deref(),
                                    wanted_block,
                                );
                                // Only once it worked: a request that failed
                                // left the stream exactly as it was, and so
                                // must this.
                                if result.is_ok() {
                                    device = wanted_device;
                                    block = wanted_block;
                                }
                                let _ = reply.send(result);
                            }
                            Request::Reset { slot, mode, reply } => {
                                let _ = reply.send(reset_plugins(&shared, slot, mode));
                            }
                        }
                    }
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                }
            }
        });

        let (sample_rate, ahead) = ready_rx
            .recv()
            .map_err(|_| "the audio thread stopped before it started".to_string())??;
        ahead.set_block(buffer);

        Ok(Engine {
            tx: Mutex::new(tx),
            retired: Mutex::new(retire_rx),
            slots: Mutex::new(HashMap::new()),
            components: Mutex::new(HashMap::new()),
            controllers: Mutex::new(HashMap::new()),
            cc_maps: Mutex::new(HashMap::new()),
            peak,
            health,
            ahead,
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
    pub fn set_output_device(&self, name: Option<&str>) -> Result<Option<String>, String> {
        trace::log(
            "device",
            format_args!("switch-to={}", name.unwrap_or("<system default>")),
        );

        self.reopen(Some(name.map(str::to_string)), None)
    }

    /// Ask the device for blocks of `frames`, or for whatever it prefers.
    ///
    /// The stream is rebuilt underneath the plugins, exactly as a device change
    /// rebuilds it, and for the same reason: a block size is decided when the
    /// stream is opened and cannot be changed on a live one. Nothing about the
    /// plugins changes — `MAX_BLOCK` is what they were set up for and a bigger
    /// block is split, so this never rebuilds an instrument or loses its state.
    pub fn set_buffer_size(&self, frames: Option<u32>) -> Result<Option<String>, String> {
        trace::log(
            "device",
            format_args!(
                "buffer-frames={}",
                frames.map_or_else(|| "<device default>".to_string(), |f| f.to_string())
            ),
        );

        // The pump follows the device rather than keeping a size of its own: a
        // block the device is happy with is a block the plugins are happy with,
        // and one number to reason about beats two.
        self.ahead.set_block(frames);
        self.reopen(None, Some(frames))
    }

    /// Keep `ms` of already-rendered audio in front of the device.
    ///
    /// Zero renders in the audio callback as every session did before this
    /// existed. Takes effect on the pump's next pass — no stream is rebuilt,
    /// because nothing about the device changes.
    pub fn set_headroom(&self, ms: u32) {
        trace::log("device", format_args!("headroom-ms={ms}"));
        self.ahead.set_headroom(ms, self.sample_rate);
    }

    /// Put every hosted instrument back the way it was when it loaded.
    ///
    /// A detailed sampled instrument can get slower the longer it plays — the
    /// harp library this was written against climbs from 2.5 ms a block to over
    /// 40 ms in two and a half minutes — and reloading it inside its own editor
    /// is what clears that. This asks for the same thing over VST3, without
    /// re-streaming the samples a real reload would.
    ///
    /// Answers how many instruments were put back. Zero is not a failure: it is
    /// a session with nothing loaded.
    pub fn reset_all(&self, mode: ResetMode) -> Result<usize, String> {
        trace::log("reset", format_args!("every track mode={mode:?}"));
        self.request_reset(None, mode)
    }

    /// The same, for one track. Answers 0 for a track hosting nothing.
    pub fn reset(&self, track_id: &str, mode: ResetMode) -> Result<usize, String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(0);
        };
        trace::log("reset", format_args!("track={track_id} mode={mode:?}"));
        self.request_reset(Some(slot), mode)
    }

    fn request_reset(&self, slot: Option<SlotId>, mode: ResetMode) -> Result<usize, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.switches
            .lock()
            .unwrap()
            .send(Request::Reset {
                slot,
                mode,
                reply: reply_tx,
            })
            .map_err(|_| "the audio thread is not running".to_string())?;

        reply_rx
            .recv()
            .map_err(|_| "the audio thread stopped while resetting".to_string())?
    }

    /// Hand a request to the thread that owns the stream, and wait for it.
    ///
    /// Answered rather than fired and forgotten, so the settings panel can say
    /// what went wrong instead of quietly appearing to have worked.
    fn reopen(
        &self,
        device: Option<Option<String>>,
        buffer: Option<Option<u32>>,
    ) -> Result<Option<String>, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.switches
            .lock()
            .unwrap()
            .send(Request::Reopen {
                device,
                buffer,
                reply: reply_tx,
            })
            .map_err(|_| "the audio thread is not running".to_string())?;

        reply_rx
            .recv()
            .map_err(|_| "the audio thread stopped while re-opening the stream".to_string())?
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

    /// What the audio thread has cost since the last call, and reset.
    pub fn take_health(&self) -> AudioHealth {
        self.health.take(self.sample_rate)
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
        let mut plugin = Plugin::load(path, class_id, self.sample_rate, MAX_BLOCK)?;

        // Taken before the plugin is handed over, because afterwards it belongs
        // to the audio thread.
        self.components
            .lock()
            .unwrap()
            .insert(track_id.to_string(), SendComponent(plugin.component_handle()));

        // A different plugin is in the slot now, so whatever the last one mapped
        // its controllers to says nothing about this one. Past the early return
        // above, the plugin is always a new instance.
        self.cc_maps.lock().unwrap().remove(track_id);

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

        // From here on the plugin belongs to a slot, and the trace can write
        // that slot's records with the track's own name.
        plugin.set_trace_slot(slot);
        trace::label(slot, track_id);
        // Guarded, unlike every other call site: what the plugin says about
        // itself is a handful of COM calls, and an argument to `format_args!`
        // is evaluated whether or not the log wants it.
        if trace::enabled() {
            trace::log(
                "load",
                format_args!(
                    "track={track_id} slot={slot} class={class_id} path={} {:?}",
                    path.display(),
                    plugin.diagnostics()
                ),
            );
        }

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

    /// What `track_id`'s plugin says its own latency is, in milliseconds.
    ///
    /// `None` when the track hosts no plugin, or when the plugin offers no
    /// `IAudioProcessor` — the same cast `Plugin::load` makes, done here from the
    /// control side against the component reference kept for state. It is a plain
    /// read of a value the plugin already holds, so it needs no trip through the
    /// audio thread.
    ///
    /// Reported only. Nothing compensates for it: most instrument plugins answer 0
    /// whatever they actually do, which is exactly why the manual per-instrument
    /// offset exists, and showing the two side by side is what makes that visible.
    pub fn latency_ms(&self, track_id: &str) -> Option<f64> {
        use vst3::Steinberg::Vst::IAudioProcessorTrait;

        let components = self.components.lock().unwrap();
        let processor = components
            .get(track_id)?
            .0
            .cast::<vst3::Steinberg::Vst::IAudioProcessor>()?;

        // SAFETY: the component reference is alive for as long as the entry is, and
        // the processor was queried from it just now.
        let samples = unsafe { processor.getLatencySamples() };

        Some(f64::from(samples) / self.sample_rate * 1000.0)
    }

    pub fn unload(&self, track_id: &str) -> Result<(), String> {
        trace::log("unload", format_args!("track={track_id}"));

        self.components.lock().unwrap().remove(track_id);
        self.controllers.lock().unwrap().remove(track_id);
        self.cc_maps.lock().unwrap().remove(track_id);

        let hosted = self.slots.lock().unwrap().remove(track_id);
        if let Some(hosted) = hosted {
            self.send(Command::Remove { slot: hosted.slot })?;
        }
        self.collect_retired();
        Ok(())
    }

    /// Unload every track's plugin, waiting for the audio thread to hand each
    /// one back.
    ///
    /// The quit path, and the one place that wait matters. `unload` can afford
    /// to leave a plugin sitting on the retire channel — there is always a
    /// later call to collect it — but at shutdown there is no later call, and a
    /// plugin left there is one whose `terminate` never runs.
    pub fn unload_all(&self) {
        self.components.lock().unwrap().clear();
        self.controllers.lock().unwrap().clear();
        self.cc_maps.lock().unwrap().clear();

        let hosted: Vec<Hosted> = self
            .slots
            .lock()
            .unwrap()
            .drain()
            .map(|(_, hosted)| hosted)
            .collect();
        let expected = hosted.len();
        for hosted in hosted {
            let _ = self.send(Command::Remove { slot: hosted.slot });
        }

        // Removals are drained at the top of a block, so nothing has come back
        // yet. Bounded rather than a plain blocking wait: an audio thread that
        // has already stopped would otherwise hang the quit it is part of.
        let deadline = Instant::now() + RETIRE_WAIT;
        let mut collected = 0;
        while collected < expected {
            {
                let retired = self.retired.lock().unwrap();
                while retired.try_recv().is_ok() {
                    collected += 1;
                }
            }
            if collected >= expected || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
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

        let len = bytes.len();
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
        trace::log("set-state", format_args!("track={track_id} bytes={len}"));
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
            trace::log(
                "schedule",
                format_args!("track={track_id} pitch={pitch} IGNORED=no-plugin"),
            );
            return Ok(());
        };
        trace::log(
            "schedule",
            format_args!(
                "track={track_id} slot={slot} pitch={pitch} vel={velocity} \
                 when={host_time:.4} dur={duration:.4}"
            ),
        );
        self.send(Command::Note {
            slot,
            pitch,
            velocity,
            host_time,
            duration,
        })
    }

    /// Sound one note now and hold it down.
    ///
    /// For a key being held, whose length is not known when it starts — so it
    /// carries no time and no duration, and goes out in the next block rather
    /// than being placed on the clock. [`Engine::release`] ends it.
    pub fn hold(&self, track_id: &str, pitch: i16, velocity: u8) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "hold",
            format_args!("track={track_id} slot={slot} pitch={pitch} vel={velocity}"),
        );
        self.send(Command::Hold {
            slot,
            pitch,
            velocity,
        })
    }

    /// Release a note held by [`Engine::hold`].
    pub fn release(&self, track_id: &str, pitch: i16) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "release",
            format_args!("track={track_id} slot={slot} pitch={pitch}"),
        );
        self.send(Command::Release { slot, pitch })
    }

    /// The parameters a track's plugin offers as automation targets.
    ///
    /// Empty for a track with no plugin, or one whose plugin has no controller —
    /// both are ordinary states, not errors: the picker simply has nothing to
    /// offer.
    pub fn list_params(&self, track_id: &str) -> Vec<crate::vst3::plugin::ParamInfo> {
        match self.controller(track_id) {
            Some(controller) => crate::vst3::plugin::list_params(&controller),
            None => Vec::new(),
        }
    }

    /// The MIDI controllers a track's plugin accepts, and what they arrive as.
    ///
    /// Empty for a track with no plugin, and for a plugin that implements no
    /// `IMidiMapping` — neither is an error, it just means there is no MIDI
    /// learn to offer.
    pub fn list_cc(&self, track_id: &str) -> Vec<crate::vst3::plugin::CcInfo> {
        match self.controller(track_id) {
            Some(controller) => crate::vst3::plugin::list_cc(&controller),
            None => Vec::new(),
        }
    }

    /// The `ParamID` a controller arrives as, or `None` if it is not mapped.
    ///
    /// Resolved for the whole plugin at once on the first miss rather than one
    /// controller at a time: the answer comes from a single pass over
    /// `IMidiMapping`, and a track's curves ask about the same few controllers
    /// over and over.
    pub fn cc_param_id(&self, track_id: &str, controller: u16) -> Option<u32> {
        if let Some(map) = self.cc_maps.lock().unwrap().get(track_id) {
            return map.get(&controller).copied();
        }

        // Built with the lock released: `list_cc` is 128 COM calls, and two
        // threads racing to it would only compute the same answer twice rather
        // than hold each other up behind a call into a plugin.
        let built: HashMap<u16, u32> = self
            .list_cc(track_id)
            .into_iter()
            .map(|cc| (cc.controller, cc.param_id))
            .collect();

        self.cc_maps
            .lock()
            .unwrap()
            .entry(track_id.to_string())
            .or_insert(built)
            .get(&controller)
            .copied()
    }

    /// Wiggle a controller so a plugin control armed to learn one binds to it.
    ///
    /// Fails rather than going quiet when the plugin maps no such controller:
    /// the panel that offers this can then say so, where a silent no-op would
    /// look exactly like a plugin that was never armed.
    pub fn learn_cc(&self, track_id: &str, controller: u16) -> Result<(), String> {
        let param_id = self
            .cc_param_id(track_id, controller)
            .ok_or_else(|| format!("this plugin has no mapping for CC {controller}"))?;

        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "learn-cc",
            format_args!("track={track_id} slot={slot} cc={controller} param={param_id}"),
        );
        self.send(Command::LearnSweep {
            slot,
            id: param_id,
            step: (self.sample_rate * LEARN_STEP_SECONDS) as i64,
        })
    }

    /// Drive a parameter at a moment on the webview's clock.
    pub fn automate(
        &self,
        track_id: &str,
        param_id: u32,
        value: f64,
        host_time: f64,
    ) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "automate",
            format_args!(
                "track={track_id} slot={slot} param={param_id} value={value:.6} \
                 when={host_time:.4}"
            ),
        );
        self.send(Command::Param {
            slot,
            id: param_id,
            value,
            host_time: Some(host_time),
        })
    }

    /// Tell a plugin's controller half where a parameter has got to.
    ///
    /// VST3 makes the host responsible for this, and it is easy to miss: the
    /// *processor* is driven through `inputParameterChanges`, the *controller*
    /// learns nothing from that, and a host that never says anything leaves the
    /// two halves disagreeing about every automated parameter for as long as it
    /// runs. What a plugin does about that is its own business, and some do
    /// something expensive.
    ///
    /// Best-effort, and never from the audio thread: this calls into the plugin's
    /// UI half, which may allocate and lock. The same control-side use of the
    /// controller that `open_editor` and `get_state` already make.
    pub fn acknowledge_param(&self, track_id: &str, param_id: u32, value: f64) {
        let Some(controller) = self.controller(track_id) else {
            return;
        };
        // SAFETY: the controller reference is alive for as long as its entry is.
        unsafe {
            use vst3::Steinberg::Vst::IEditControllerTrait;
            controller.setParamNormalized(param_id, value);
        }
    }

    /// Drive a parameter in the next block, and tell the controller about it.
    pub fn set_param(&self, track_id: &str, param_id: u32, value: f64) -> Result<(), String> {
        self.acknowledge_param(track_id, param_id, value);

        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "set-param",
            format_args!("track={track_id} slot={slot} param={param_id} value={value:.6} when=now"),
        );
        self.send(Command::Param {
            slot,
            id: param_id,
            value,
            host_time: None,
        })
    }

    pub fn set_gain(&self, track_id: &str, gain: f32) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log(
            "volume",
            format_args!("track={track_id} slot={slot} gain={gain:.4}"),
        );
        self.send(Command::Gain { slot, gain })
    }

    /// Release everything sounding on one track's plugin.
    pub fn stop(&self, track_id: &str) -> Result<(), String> {
        let Some(slot) = self.slot_of(track_id) else {
            return Ok(());
        };
        trace::log("stop", format_args!("track={track_id} slot={slot}"));
        self.send(Command::Stop { slot })
    }

    pub fn stop_all(&self) -> Result<(), String> {
        trace::log("stop-all", format_args!("every track"));
        self.send(Command::StopAll)
    }

    /// Say what the webview's transport is doing, for every plugin's process
    /// context.
    ///
    /// Only the webview knows any of this: the output stream runs whether or not
    /// anything is playing, and nothing native has ever been told the tempo. A
    /// plugin given no context at all cannot sync to a tempo, cannot tell playing
    /// from idling, and has no timeline to place a change on.
    pub fn set_transport(
        &self,
        playing: bool,
        tempo: f64,
        numerator: i32,
        denominator: i32,
    ) -> Result<(), String> {
        trace::log(
            "transport",
            format_args!(
                "playing={playing} tempo={tempo:.3} time-sig={numerator}/{denominator}"
            ),
        );
        self.send(Command::Transport {
            playing,
            tempo,
            numerator,
            denominator,
        })
    }

    /// Re-anchor the clock against the webview's.
    ///
    /// `host_time` is what `AudioContext.currentTime` read in the webview. By
    /// the time the audio thread sees this command a block boundary may have
    /// passed, and it can only observe its own frame counter at block starts —
    /// so the wait is measured *there*, by `Command::Sync`'s `queued_at`, and
    /// folded into `host_time` at the moment the anchor is taken. Without that
    /// correction the anchor jitters by up to a block period on every re-sync,
    /// and everything placed against it jitters with it: a note lands a few
    /// milliseconds out, which nobody hears, but an automation curve converted
    /// against two anchors in turn can hand the plugin a value that goes
    /// *backwards*, which is audible as a click.
    pub fn sync(&self, host_time: f64) -> Result<(), String> {
        self.send(Command::Sync {
            host_time,
            queued_at: Instant::now(),
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
pub(super) struct Renderer {
    rx: rtrb::Consumer<Command>,
    retire: mpsc::Sender<Box<SendPlugin>>,
    peak: Arc<AtomicU32>,
    /// The counters the settings dialog reads. Written every callback, whether
    /// or not the trace is on.
    health: Arc<Health>,
    clock: Clock,
    slots: Vec<Slot>,
    /// Interleaved stereo scratch, mixed once per block and then spread across
    /// however many channels the device actually has.
    mix: Vec<f32>,
    frame: i64,
    /// What the webview says its transport is doing, for the process context.
    transport: Transport,
    /// What `ProcessContext::systemTime` is measured from. Any fixed moment will
    /// do — a plugin reads it as a clock, not as a date.
    started: Instant,
    /// What the callback has cost since the last load line, and when that was.
    ///
    /// The trace's own copy of what `health` carries, kept separately because
    /// the two are read on different terms: this one is flushed to the log once
    /// a second whatever anybody does, `health` when the UI asks. `late` is the
    /// count that matters in both: a callback that took longer than its own
    /// frames will play for has already been heard as a dropout.
    render_callbacks: u64,
    render_frames: u64,
    render_total: Duration,
    render_max: Duration,
    render_late: u64,
    load_at: Instant,
}

impl Renderer {
    fn new(
        rx: rtrb::Consumer<Command>,
        retire: mpsc::Sender<Box<SendPlugin>>,
        peak: Arc<AtomicU32>,
        health: Arc<Health>,
        sample_rate: f64,
    ) -> Renderer {
        Renderer {
            rx,
            retire,
            peak,
            health,
            clock: Clock::new(sample_rate),
            slots: Vec::with_capacity(MAX_PLUGINS),
            mix: vec![0.0f32; MAX_BLOCK * 2],
            frame: 0,
            transport: Transport::default(),
            started: Instant::now(),
            render_callbacks: 0,
            render_frames: 0,
            render_total: Duration::ZERO,
            render_max: Duration::ZERO,
            render_late: 0,
            load_at: Instant::now(),
        }
    }

    /// One block: drain the queue, then mix every plugin into interleaved stereo.
    ///
    /// Answers the mix rather than writing to the device, because two different
    /// things want it — the audio callback, which spreads it across the device's
    /// channels and hands it straight over, and the render-ahead pump, which puts
    /// it in a ring for a later callback to take. Stereo is what makes that ring
    /// worth having: it is one layout whatever the device is.
    ///
    /// At most `MAX_BLOCK` frames, which is what every plugin was set up for.
    pub(super) fn render_stereo(&mut self, frames: usize) -> &[f32] {
        // Around the whole thing, not just the plugins: draining the queue is on
        // the same deadline as `process` is.
        //
        // Unconditional, unlike the trace it used to be tied to. One
        // `Instant::now` per block is tens of nanoseconds against a millisecond
        // budget, and the alternative was that nothing counted dropouts at all
        // unless somebody had thought to set an environment variable first.
        let started = Instant::now();
        let frames = frames.min(MAX_BLOCK);

        // Drain commands first: a note that arrived for this block should be
        // heard in it, not in the next one.
        while let Ok(command) = self.rx.pop() {
            apply(
                command,
                &mut self.slots,
                &mut self.clock,
                &mut self.transport,
                self.frame,
                &self.retire,
            );
        }

        // One clock read for the whole block, so every plugin in it is told the
        // same moment and the reading costs one call rather than one per plugin.
        let mut transport = self.transport;
        transport.system_time = self.started.elapsed().as_nanos() as i64;

        self.mix[..frames * 2].fill(0.0);
        for slot in self.slots.iter_mut() {
            slot.plugin
                .0
                .process_into(&mut self.mix, frames, self.frame, transport);
        }

        let block_peak = self.mix[..frames * 2]
            .iter()
            .fold(0.0f32, |a, s| a.max(s.abs()));
        if block_peak > f32::from_bits(self.peak.load(Ordering::Relaxed)) {
            self.peak.store(block_peak.to_bits(), Ordering::Relaxed);
        }

        self.frame += frames as i64;
        self.account(started.elapsed(), frames);

        &self.mix[..frames * 2]
    }

    /// Fold one callback's cost in, and report the interval when it is up.
    ///
    /// The deadline is the frames this callback produced: once rendering them
    /// takes longer than playing them does, the stream cannot keep ahead of the
    /// device and the gap is heard.
    fn account(&mut self, spent: Duration, frames: usize) {
        // The UI's copy first, and whatever else happens: this is the one a user
        // with no environment variable set is going to read.
        self.health.account(spent, frames, self.clock.sample_rate());

        // Everything below only feeds the log, so it is worth nothing when there
        // is no log. Returning here also keeps the accumulators from counting a
        // whole session into a line that will never be printed.
        if !trace::enabled() {
            return;
        }

        let budget = Duration::from_secs_f64(frames as f64 / self.clock.sample_rate());

        self.render_callbacks += 1;
        self.render_frames += frames as u64;
        self.render_total += spent;
        self.render_max = self.render_max.max(spent);
        if spent > budget {
            self.render_late += 1;
        }

        if self.load_at.elapsed() < LOAD_INTERVAL {
            return;
        }
        self.load_at = Instant::now();

        trace::emit(Record::Load {
            callbacks: self.render_callbacks,
            frames: self.render_frames,
            render_total_us: self.render_total.as_micros() as u64,
            render_max_us: self.render_max.as_micros() as u64,
            late: self.render_late,
        });

        // On the same interval, so the two halves of the conversation can be
        // read against each other: what the host asked of the plugins above,
        // and what they asked of the host here.
        let (refused_instances, param_edits, restarts, messages) =
            super::host::take_callback_counts();
        trace::emit(Record::Callbacks {
            refused_instances,
            param_edits,
            restarts,
            messages,
        });

        self.render_callbacks = 0;
        self.render_frames = 0;
        self.render_total = Duration::ZERO;
        self.render_max = Duration::ZERO;
        self.render_late = 0;
    }
}

/// Spread interleaved stereo across however many channels the device has.
///
/// Mono is the sum rather than one side, which is what stops a part panned hard
/// disappearing on a laptop speaker. Anything past the second channel is left
/// silent: a surround endpoint gets a stereo pair at the front, which is all this
/// app has to say.
pub(super) fn spread(mix: &[f32], out: &mut [f32], channels: usize) {
    let frames = out.len() / channels;

    for f in 0..frames {
        let left = mix[f * 2];
        let right = mix[f * 2 + 1];
        let base = f * channels;

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
}

/// Render straight into the device's buffer, on the thread it asked from.
///
/// The path taken when nothing is being rendered ahead, and the one every
/// session took before that existed. A device asking for more than the plugins
/// were set up for is split rather than truncated.
fn render_into(renderer: &mut Renderer, out: &mut [f32], channels: usize) {
    let frames_total = out.len() / channels;
    let mut done = 0;

    while done < frames_total {
        let frames = (frames_total - done).min(MAX_BLOCK);
        let mix = renderer.render_stereo(frames);
        spread(
            mix,
            &mut out[done * channels..(done + frames) * channels],
            channels,
        );
        done += frames;
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
///
/// Answers the name it settled on as well, so the thread that owns the stream
/// knows what to re-open when only the block size changes. `None` means the
/// system default — including the case where a remembered endpoint was gone and
/// the default was taken instead.
fn start_device(name: Option<&str>) -> Result<(cpal::Device, Option<String>), String> {
    match name.and_then(named_device) {
        Some(device) => Ok((device, name.map(str::to_string))),
        None => default_device().map(|device| (device, None)),
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

/// The block size to ask for, given what the device says it will take.
///
/// `None` asks for nothing, which is what every session did before this was
/// settable: on WASAPI that means the device's own period, around ten
/// milliseconds. A bigger block is the manual's first suggestion for a sample
/// library that crackles, and it works on two counts — the deadline for a block
/// is the time that block will play for, so a longer one is a longer deadline,
/// and cpal hands the size on to `IAudioClient::Initialize` as a buffer
/// duration, so the ring in front of the device grows with it and a late render
/// eats slack rather than leaving a gap.
///
/// Clamped rather than refused when the device declares a range it falls
/// outside: the nearest size it will take is closer to what was asked for than
/// silently doing nothing is. A device that declares no range at all is asked
/// directly, and `open_stream` falls back if it turns the request down.
fn requested_buffer(config: &cpal::SupportedStreamConfig, frames: Option<u32>) -> cpal::BufferSize {
    let Some(frames) = frames else {
        return cpal::BufferSize::Default;
    };

    match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => {
            cpal::BufferSize::Fixed(frames.clamp(*min.max(&1), *max))
        }
        cpal::SupportedBufferSize::Unknown => cpal::BufferSize::Fixed(frames),
    }
}

/// Open a stream on `device` and start it, rendering from `shared`.
///
/// Answers the note to show the user alongside the stream: `None` when the
/// stream is exactly what was asked for, and a sentence when it is not.
fn open_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    shared: &Shared,
    health: &Arc<Health>,
    ahead: &Arc<Ahead>,
    buffer: Option<u32>,
) -> Result<(cpal::Stream, Option<String>), String> {
    match try_open(
        device,
        config,
        shared,
        health,
        ahead,
        requested_buffer(config, buffer),
    ) {
        Ok(stream) => Ok((stream, None)),
        // A device that will not take the block size asked for still has to
        // play. Falling back keeps the sound rather than the setting, and says
        // so: a silent fall back would leave the panel showing a buffer size
        // that is not the one running, which is the confusion the answer exists
        // to end.
        Err(err) if buffer.is_some() => {
            let stream = try_open(device, config, shared, health, ahead, cpal::BufferSize::Default)?;
            Ok((
                stream,
                Some(format!(
                    "That block size was refused ({err}), so the device's own is being used."
                )),
            ))
        }
        Err(err) => Err(err),
    }
}

/// One attempt at a stream, at exactly the block size given.
fn try_open(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    shared: &Shared,
    health: &Arc<Health>,
    ahead: &Arc<Ahead>,
    buffer_size: cpal::BufferSize,
) -> Result<cpal::Stream, String> {
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    stream_config.buffer_size = buffer_size;

    let renderer = Arc::clone(shared);
    let starved = Arc::clone(health);
    let pump = Arc::clone(ahead);
    let channels = (config.channels() as usize).max(1);
    let stream = device
        .build_output_stream(
            &stream_config,
            move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // Taking audio that is already rendered, or rendering it here:
                // the second is what every session did before the pump existed
                // and is still what runs with no headroom asked for.
                if let Some(short) = pump.take(out, channels) {
                    if short > 0 {
                        starved.starve(short);
                    }
                    return;
                }

                match renderer.try_lock() {
                    Ok(mut renderer) => render_into(&mut renderer, out, channels),
                    // A switch is in progress and this stream is on its way out,
                    // or is the one just built and not yet configured. Either way
                    // the buffer must still be written, or the device repeats
                    // whatever was last in it — and it is still silence the
                    // device asked for and did not get, so it is counted as such.
                    Err(_) => {
                        out.fill(0.0);
                        starved.starve(out.len() / channels);
                    }
                }
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

/// Put hosted plugins back the way they loaded, on the thread that owns the
/// renderer.
///
/// **Holding the renderer's lock is the whole safety argument.** It is the one
/// thing that stops the audio callback and the render-ahead pump at once, so
/// nothing can be inside `process` while a plugin is being deactivated. Reaching
/// for a control-side component handle and calling this from a Tauri thread
/// would look identical and be a use-after-free in third-party code: the plugin
/// would go on being handed buffers it had already freed.
///
/// The cost is that the callback writes silence for as long as this takes,
/// counted as starved — unless audio is being rendered ahead, in which case the
/// callback is draining the ring and never wants the lock at all. That is the
/// case this is meant to run in.
///
/// One plugin refusing does not spare the rest: they are independent, and an
/// instrument that could have been put back should be.
fn reset_plugins(shared: &Shared, only: Option<SlotId>, mode: ResetMode) -> Result<usize, String> {
    let mut renderer = shared
        .lock()
        .map_err(|_| "the renderer is no longer usable".to_string())?;

    let mut done = 0usize;
    let mut asked = 0usize;
    let mut failure: Option<String> = None;

    for slot in renderer.slots.iter_mut() {
        if only.is_some_and(|wanted| wanted != slot.id) {
            continue;
        }
        asked += 1;
        match slot.plugin.0.reset(mode) {
            Ok(()) => done += 1,
            Err(err) => {
                failure.get_or_insert(err);
            }
        }
    }

    match failure {
        None => Ok(done),
        Some(err) => Err(format!("put {done} of {asked} instruments back: {err}")),
    }
}

/// Build the first output stream, and with it the renderer everything after
/// this shares.
fn build_stream(
    rx: rtrb::Consumer<Command>,
    retire: mpsc::Sender<Box<SendPlugin>>,
    peak: Arc<AtomicU32>,
    health: Arc<Health>,
    preferred: Option<&str>,
    buffer: Option<u32>,
) -> Result<(cpal::Stream, Shared, f64, Option<String>, Arc<Ahead>), String> {
    let (device, opened) = start_device(preferred)?;
    // The device's own default config, not a requested one: this is what fixes
    // the session's sample rate, so it should be the rate the hardware likes.
    let config = device
        .default_output_config()
        .map_err(|e| format!("no default output config: {e}"))?;

    let sample_rate = config.sample_rate().0 as f64;

    // Before anything is rendered, so that the first note of the session is in
    // the log along with the rest.
    trace::start(sample_rate);
    trace::log(
        "device",
        format_args!(
            "name={} channels={} sample-rate={sample_rate}",
            device.name().unwrap_or_else(|_| "?".to_string()),
            config.channels()
        ),
    );

    let health_for_stream = Arc::clone(&health);
    let shared: Shared = Arc::new(Mutex::new(Renderer::new(
        rx,
        retire,
        peak,
        health,
        sample_rate,
    )));

    // Before the stream, so the callback it is handed is the one that will be
    // draining it — and so a pump that cannot start fails the engine rather than
    // leaving a callback reaching for a ring nobody fills.
    let ahead = Ahead::start(Arc::clone(&shared), sample_rate);

    let (stream, _) = open_stream(
        &device,
        &config,
        &shared,
        &health_for_stream,
        &ahead,
        buffer,
    )?;
    Ok((stream, shared, sample_rate, opened, ahead))
}

/// Move rendering onto `name`, keeping everything that is loaded and playing.
///
/// The new stream is opened *before* the old one is let go, so a device that
/// cannot be opened leaves the engine exactly as it was rather than silent. The
/// renderer lock is held across the swap, which is what stops the two streams
/// rendering the same block twice on the way through.
fn reopen_stream(
    current: &mut cpal::Stream,
    shared: &Shared,
    health: &Arc<Health>,
    ahead: &Arc<Ahead>,
    sample_rate: f64,
    name: Option<&str>,
    buffer: Option<u32>,
) -> Result<Option<String>, String> {
    let device = switch_target(name)?;
    let config = config_at(&device, sample_rate).ok_or_else(|| {
        format!(
            "{} cannot run at {} Hz, which is the rate this session's plugins were built for",
            device.name().unwrap_or_else(|_| "that device".to_string()),
            sample_rate as u32
        )
    })?;

    // Held across the swap so the two streams cannot render the same block; the
    // pump waits on it for at most the block it is in. Nothing already rendered
    // is thrown away — the ring holds stereo, so it outlives the device it was
    // going to be played on.
    let renderer = shared.lock().unwrap();
    let (stream, note) = open_stream(&device, &config, shared, health, ahead, buffer)?;

    // The old stream is dropped here, while the lock is still held, so its
    // callback cannot render one last block against the new channel count.
    let old = std::mem::replace(current, stream);
    drop(old);
    drop(renderer);

    Ok(note)
}

/// Apply one command on the audio thread.
fn apply(
    command: Command,
    slots: &mut Vec<Slot>,
    clock: &mut Clock,
    transport: &mut Transport,
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
                trace::emit(Record::Unanchored {
                    slot: id,
                    pitch,
                    host_time,
                });
                return;
            };
            let duration_frames = clock.frames_in(duration);
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                let accepted =
                    slot.plugin
                        .0
                        .scheduler
                        .schedule_note(pitch, velocity, at, duration_frames);

                trace::emit(Record::Placed {
                    slot: id,
                    pitch,
                    velocity,
                    host_time,
                    duration,
                    frame: at,
                    duration_frames,
                    accepted,
                });
            }
        }
        Command::Hold {
            slot: id,
            pitch,
            velocity,
        } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.scheduler.hold_note(pitch, velocity);
            }
        }
        Command::Release { slot: id, pitch } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.scheduler.release_note(pitch);
            }
        }
        Command::Gain { slot: id, gain } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.set_gain(gain);
            }
        }
        Command::Param {
            slot: id,
            id: param,
            value,
            host_time,
        } => {
            // An untimed change goes out in the block being assembled; a timed
            // one is placed on the clock exactly as a note is, and is dropped
            // the same way when no anchor has arrived yet.
            let at = match host_time {
                Some(host_time) => match clock.frame_for(host_time) {
                    Some(at) => at,
                    None => {
                        trace::emit(Record::ParamUnanchored {
                            slot: id,
                            id: param,
                            host_time,
                        });
                        return;
                    }
                },
                None => frame,
            };
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                // An untimed change *replaces* this parameter's future rather
                // than joining it: it says "the value is this, as of now", and a
                // curve's queued points are exactly what that overrides.
                if host_time.is_none() {
                    slot.plugin.0.param_scheduler.drop_param(param);
                }
                let accepted = slot.plugin.0.param_scheduler.schedule(param, value, at);

                trace::emit(Record::ParamPlaced {
                    slot: id,
                    id: param,
                    value,
                    host_time,
                    frame: at,
                    accepted,
                });
            }
        }
        Command::LearnSweep {
            slot: id,
            id: param,
            step,
        } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                // Measured from the block being assembled, so the sweep starts
                // immediately and needs no clock anchor — a plugin is armed by
                // hand, with the transport almost always stopped.
                for (i, value) in LEARN_SWEEP.iter().enumerate() {
                    let at = frame + i as i64 * step;
                    let accepted = slot.plugin.0.param_scheduler.schedule(param, *value, at);

                    trace::emit(Record::ParamPlaced {
                        slot: id,
                        id: param,
                        value: *value,
                        host_time: None,
                        frame: at,
                        accepted,
                    });
                }
            }
        }
        Command::Stop { slot: id } => {
            if let Some(slot) = slots.iter_mut().find(|s| s.id == id) {
                slot.plugin.0.scheduler.stop_all();
                // The curve is abandoned but the parameter is left where it
                // reached: unlike a note, nothing hangs, and the host has no
                // better value to impose than the plugin's own.
                slot.plugin.0.param_scheduler.clear();
            }
        }
        Command::StopAll => {
            for slot in slots.iter_mut() {
                slot.plugin.0.scheduler.stop_all();
                slot.plugin.0.param_scheduler.clear();
            }
        }
        Command::Transport {
            playing,
            tempo,
            numerator,
            denominator,
        } => {
            // The system time is the renderer's to fill in per callback; nothing
            // the webview sends has anything to say about it.
            transport.playing = playing;
            transport.tempo = tempo;
            transport.time_sig = (numerator, denominator);
        }
        Command::Sync {
            host_time,
            queued_at,
        } => {
            // `frame` is this callback's starting frame, so the anchor says
            // "the webview clock read X when the stream stood here". X has to
            // be advanced by however long the command sat on the queue, which
            // is only knowable now. A clock read costs nothing and happens
            // twice a second.
            let waited = queued_at.elapsed().as_secs_f64();
            let host_time = host_time + waited;
            let frame = frame.max(0);

            let observed = frame as f64 / clock.sample_rate() - host_time;
            let kept = clock.sync(host_time, frame as u64);

            trace::emit(Record::Anchor {
                host_time,
                frame,
                waited,
                observed,
                kept,
            });
        }
    }
}
