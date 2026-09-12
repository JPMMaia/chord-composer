//! One instantiated plugin: set up for playback, and rendered a block at a time.
//!
//! The lifecycle a VST3 plugin insists on is rigid and every step matters:
//! create → `initialize` with a host context → describe the processing → turn
//! the buses on → `setActive` → `setProcessing`. Skipping any of it produces a
//! plugin that loads without complaint and then renders silence, which is the
//! single most common way to lose an afternoon here.

use std::ffi::c_void;
use std::ptr;
use std::time::{Duration, Instant};

use vst3::Steinberg::Vst::{
    BusDirections_::{kInput, kOutput},
    Event, IAudioProcessor, IAudioProcessorTrait, IComponent, IComponentHandler, IComponentTrait,
    IConnectionPoint, IConnectionPointTrait, IEditController, IEditControllerTrait, IEventList,
    IMidiMapping, IMidiMappingTrait, IParameterChanges,
    MediaTypes_::{kAudio, kEvent},
    ParamID, ParameterInfo,
    ParameterInfo_::ParameterFlags_::{kCanAutomate, kIsHidden, kIsReadOnly},
    ProcessContext, ProcessContext_::StatesAndFlags_ as ContextFlags, ProcessData,
    ProcessModes_::kRealtime, ProcessSetup, SymbolicSampleSizes_::kSample32,
};
use vst3::Steinberg::{
    kResultOk, FUnknown, IBStream, IBStreamTrait, IBStream_, IPluginBaseTrait, IPluginFactoryTrait,
    TUID,
};
use vst3::{ComPtr, ComWrapper, Interface};

use super::events::{Event as NoteEvent, EventKind, Scheduler};
use super::host::{
    read_wstring, ComponentHandler, ConnectionProxy, EventList, HostApplication, ParameterChanges,
};
use super::module::{tuid_from_hex, Module};
use super::params::ParamScheduler;
use super::stream::MemoryStream;
use super::trace::{self, Record};

/// How many note events may be in flight for one plugin.
///
/// Two per note, and the host schedules at most a fraction of a second ahead,
/// so this is far above anything a real arrangement produces. It exists to
/// bound the audio thread's memory, not to be reached.
const EVENT_CAPACITY: usize = 512;

/// How many parameter changes may be in flight for one plugin.
///
/// Larger than `EVENT_CAPACITY` because a curve is *sampled* rather than sent
/// breakpoint by breakpoint — nothing downstream interpolates a plugin
/// parameter, so a ramp reaches it as a series of points. At the webview's
/// 10 ms grid over a 200 ms look-ahead window that is twenty points per lane per
/// pass, and this leaves room for a hundred lanes at once.
///
/// A controller lane can be denser than the grid, because the host walks a jump
/// through the steps between rather than sending it — see the webview's
/// `controllerRamp`. Its own floor is a millisecond between values, so the worst
/// a lane can ask for is two hundred points in one window rather than twenty, and
/// ten such lanes at once would reach this. What arrives past it is counted
/// rather than silently dropped: see [`ParamScheduler::dropped`].
const PARAM_CAPACITY: usize = 2048;

/// How many distinct parameters may change within one block.
///
/// One lane per parameter in the timeline, and a block is a few milliseconds —
/// automating thirty-two at once is already far past what anyone draws.
const PARAM_QUEUE_CAPACITY: usize = 32;

/// How many changes one parameter may carry within one block.
///
/// Above what a walked jump can produce: a millisecond apart at the closest, so
/// ten in a 480-frame block and forty-three in the largest one this host asks
/// for.
const PARAM_POINT_CAPACITY: usize = 64;

/// The most channels one bus may have. Anything past the first two is rendered
/// but not listened to.
const MAX_CHANNELS: usize = 32;

/// How often a plugin reports what it is holding and what it cost.
///
/// A fault that builds does so over minutes, so a line a second is enough to
/// see the slope and rare enough to read.
const HEALTH_INTERVAL: Duration = Duration::from_secs(1);

/// Where the host's transport is, as a `ProcessContext` states it.
///
/// A plugin handed no process context has no tempo, no time signature and no way
/// to tell playing from idling — and every real host hands one over. The output
/// stream here runs whether or not anything is being played, so `playing` is the
/// only thing that distinguishes the two, and only the webview knows it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transport {
    /// Whether the webview's transport is rolling.
    pub playing: bool,
    pub tempo: f64,
    /// Beats per measure and the beat's note value, taken from the bar the
    /// playhead is in rather than from the project: each bar carries its own.
    pub time_sig: (i32, i32),
    /// Monotonic nanoseconds, for `ProcessContext::systemTime`. Carried in rather
    /// than read here so one callback's plugins all report the same moment, and
    /// so the clock is read once a block instead of once a plugin.
    pub system_time: i64,
}

impl Default for Transport {
    /// Stopped, at the tempo and signature a project opens on: what holds before
    /// the webview has said anything, and what an idling stream is doing.
    fn default() -> Transport {
        Transport {
            playing: false,
            tempo: 120.0,
            time_sig: (4, 4),
            system_time: 0,
        }
    }
}

impl Transport {
    /// Rolling at `tempo` in 4/4 — what an offline render is doing, and better
    /// than leaving a plugin to guess.
    pub fn rolling(tempo: f64) -> Transport {
        Transport {
            playing: true,
            tempo,
            ..Transport::default()
        }
    }
}

/// What a plugin reports about its own configuration.
#[derive(Debug, Clone, Copy)]
pub struct Diagnostics {
    pub audio_outputs: i32,
    pub audio_inputs: i32,
    pub event_inputs: i32,
    pub accepts_f32: bool,
    pub last_process: i32,
    pub latency: u32,
}

/// How much of a plugin to put back the way it was.
///
/// Four rungs of the same ladder, cheapest first. Which one actually clears a
/// given instrument's accumulated cost is a question about that instrument, not
/// about VST3, so it is measured rather than assumed — `examples/soak.rs`
/// applies one on an interval and prints what the cost curve does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ResetMode {
    /// Stop and restart processing. The plugin is told the stream broke, which
    /// is the cue to clear its own buffers, and nothing more.
    Processing,
    /// Deactivate and reactivate the component. Entitled to free and reallocate
    /// everything the instrument holds, which is what makes it the candidate.
    #[default]
    Active,
    /// As `Active`, re-stating the processing setup while it is inactive.
    Setup,
    /// Hand the plugin its own state back, which is what loading a preset does.
    State,
}

/// A plugin instance wired up and ready to render.
///
/// Field order matters on drop for the same reason it does in `Module`: the
/// COM objects live inside the module's address space and must be released
/// before it is unloaded.
pub struct Plugin {
    processor: ComPtr<IAudioProcessor>,
    component: ComPtr<IComponent>,

    /// Kept alive because the plugin holds a borrowed pointer to it.
    _host: ComWrapper<HostApplication>,
    _handler: ComWrapper<ComponentHandler>,
    /// The half of the plugin that owns parameters and the editor.
    ///
    /// Absent only for a plugin that offers neither, which is rare but legal.
    controller: Option<ComPtr<IEditController>>,
    /// The host objects the plugin's two halves talk through. Dropping one breaks
    /// that connection, so they are held for as long as the plugin is.
    _connections: Vec<ComWrapper<ConnectionProxy>>,
    event_list: ComWrapper<EventList>,
    param_changes: ComWrapper<ParameterChanges>,

    /// Per-channel output, reused every block.
    buffers: Vec<Vec<f32>>,
    /// Pointers into `buffers`, in the shape VST3 wants. Rebuilt per block
    /// because the plugin may write through them.
    channel_ptrs: Vec<*mut f32>,
    /// Channels on the main output bus, as the plugin reports them.
    channels: usize,

    pub scheduler: Scheduler,
    pub param_scheduler: ParamScheduler,
    /// The rate the plugin was set up for. Needed per block, because a
    /// `ProcessContext` states it and the musical time is derived from it.
    sample_rate: f64,
    max_block: usize,
    gain: f32,
    /// What the last `process` returned. Silence with a failing result is a
    /// host bug; silence with `kResultOk` is a plugin that had nothing to say.
    last_process: i32,
    /// Set when a reset left the component deactivated and it would not come
    /// back — the one way this type can reach a state VST3 has no name for.
    ///
    /// `process` on a deactivated component hands buffers to something that has
    /// freed whatever it was using them for, so from here it is not processed at
    /// all. The track goes silent, which is the honest outcome and vastly better
    /// than the alternative, and it stays that way until the plugin is loaded
    /// again.
    dormant: bool,

    /// Which engine slot this plugin was put in, so that a trace record — which
    /// has to be copyable and fixed-size — can name the track it belongs to
    /// without carrying the track's id.
    trace_slot: u32,
    /// The schedulers' overflow counters as the trace last reported them, so
    /// that a count which has not moved is not written again every block.
    traced_overflow: (u64, u64, u64, u64),
    /// Points a block's parameter queues had no room for.
    ///
    /// The last place a change can be lost, and the one place that said nothing
    /// about it: `ParameterChanges::add_point` answers with a bool and every
    /// caller used to drop it. A full queue means one parameter moved more times
    /// within a single block than `PARAM_POINT_CAPACITY` allows, which is a fault
    /// upstream rather than a curve being drawn quickly.
    queue_full: u64,
    /// What `process` has cost since the last health line, and when that was.
    ///
    /// Measured only while the trace is on: a `process` call is the one place in
    /// this file where two clock reads would be worth noticing.
    process_blocks: u64,
    process_total: Duration,
    process_max: Duration,
    health_at: Instant,

    /// The module must outlive every object created from it.
    _module: Module,
}

impl Plugin {
    /// Instantiate `class_id` out of the module at `path` and make it ready to
    /// render at `sample_rate` in blocks of at most `max_block` frames.
    pub fn load(
        path: &std::path::Path,
        class_id: &str,
        sample_rate: f64,
        max_block: usize,
    ) -> Result<Plugin, String> {
        // Here as well as in the engine, so that a plugin rendered without one
        // — the `render` example, and the tests that drive `process_into`
        // directly — is logged like any other.
        trace::start(sample_rate);

        let cid = tuid_from_hex(class_id).ok_or_else(|| format!("bad class id {class_id}"))?;
        let module = Module::load(path)?;

        // SAFETY: every pointer below is either freshly obtained from the
        // plugin or points at a local that outlives the call.
        unsafe {
            let component = create_instance::<IComponent>(module.factory(), &cid)
                .ok_or_else(|| format!("{class_id}: could not create the component"))?;

            let host = ComWrapper::new(HostApplication);
            let host_unknown = host
                .to_com_ptr::<FUnknown>()
                .ok_or("could not build the host context")?;

            if component.initialize(host_unknown.as_ptr()) != kResultOk {
                return Err(format!("{class_id}: initialize failed"));
            }

            let processor = component
                .cast::<IAudioProcessor>()
                .ok_or_else(|| format!("{class_id}: no IAudioProcessor"))?;

            let handler = ComWrapper::new(ComponentHandler);
            let (controller, connections) =
                match build_controller(&module, &component, &host_unknown, &handler) {
                    Some(built) => (Some(built.controller), built.connections),
                    None => (None, Vec::new()),
                };

            let mut setup = ProcessSetup {
                processMode: kRealtime as i32,
                symbolicSampleSize: kSample32 as i32,
                maxSamplesPerBlock: max_block as i32,
                sampleRate: sample_rate,
            };
            if processor.setupProcessing(&mut setup) != kResultOk {
                return Err(format!("{class_id}: setupProcessing failed"));
            }

            // Buses default to inactive. An instrument with its event input
            // switched off silently ignores every note it is sent.
            activate_all_buses(&component, kEvent as i32, kInput as i32);

            // Exactly one audio output, and every other one off.
            //
            // Orchestral libraries routinely present a dozen or more outputs and
            // only one of them is listened to here. `ProcessData` has to describe
            // every *active* bus, so activating them all and then passing buffers
            // for one is a contract violation, and the plugin's recourse is to
            // render silence. Which is exactly what it does.
            //
            // Activating all of them and giving each a buffer is the other legal
            // shape, and the one every DAW uses. It was tried here against the
            // plugin whose note handling costs tens of milliseconds and made no
            // measurable difference, so this keeps the cheaper arrangement: 31
            // buses of silence to clear per block is real work on the audio
            // thread, and it bought nothing.
            let main = main_output_bus(&component)
                .ok_or_else(|| format!("{class_id}: no audio output bus"))?;

            let outputs = component.getBusCount(kAudio as i32, kOutput as i32);
            for index in 0..outputs {
                let on = if index == main.index { 1 } else { 0 };
                component.activateBus(kAudio as i32, kOutput as i32, index, on);
            }

            let channels = (main.channel_count.max(1) as usize).min(MAX_CHANNELS);

            if component.setActive(1) != kResultOk {
                return Err(format!("{class_id}: setActive failed"));
            }
            processor.setProcessing(1);

            Ok(Plugin {
                processor,
                component,
                _host: host,
                _handler: handler,
                controller,
                _connections: connections,
                event_list: ComWrapper::new(EventList::new(EVENT_CAPACITY)),
                param_changes: ComWrapper::new(ParameterChanges::new(
                    PARAM_QUEUE_CAPACITY,
                    PARAM_POINT_CAPACITY,
                )),
                buffers: vec![vec![0.0; max_block]; channels],
                channel_ptrs: vec![ptr::null_mut(); channels],
                channels,
                scheduler: Scheduler::new(EVENT_CAPACITY),
                param_scheduler: ParamScheduler::new(PARAM_CAPACITY, PARAM_QUEUE_CAPACITY),
                sample_rate,
                max_block,
                gain: 1.0,
                last_process: kResultOk,
                dormant: false,
                trace_slot: u32::MAX,
                traced_overflow: (0, 0, 0, 0),
                queue_full: 0,
                process_blocks: 0,
                process_total: Duration::ZERO,
                process_max: Duration::ZERO,
                health_at: Instant::now(),
                _module: module,
            })
        }
    }

    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.clamp(0.0, 1.0);
    }

    /// Name the slot this plugin is about to be handed to the audio thread for.
    ///
    /// Only the trace reads it: see [`Plugin::trace_slot`].
    pub fn set_trace_slot(&mut self, slot: u32) {
        self.trace_slot = slot;
    }

    /// A second reference to the component, for the control thread.
    ///
    /// State is read and written from outside the audio thread while the
    /// plugin itself is owned by it. VST3 permits `getState`/`setState` from
    /// the UI thread — it is how every DAW saves a project mid-session — and
    /// COM's reference counting is what makes holding a second pointer safe.
    pub fn component_handle(&self) -> ComPtr<IComponent> {
        self.component.clone()
    }

    /// A second reference to the edit controller, for opening the editor from
    /// the UI thread while the audio thread owns the plugin.
    pub fn controller_handle(&self) -> Option<ComPtr<IEditController>> {
        self.controller.clone()
    }

    /// What the plugin says about itself, for diagnosing silence.
    pub fn diagnostics(&self) -> Diagnostics {
        // SAFETY: the component is live for as long as `self` is.
        unsafe {
            Diagnostics {
                audio_outputs: self.component.getBusCount(kAudio as i32, kOutput as i32),
                audio_inputs: self.component.getBusCount(kAudio as i32, kInput as i32),
                event_inputs: self.component.getBusCount(kEvent as i32, kInput as i32),
                accepts_f32: self.processor.canProcessSampleSize(kSample32 as i32) == kResultOk,
                last_process: self.last_process,
                latency: self.processor.getLatencySamples(),
            }
        }
    }

    /// Put the plugin back to how it was the moment it finished loading.
    ///
    /// A detailed sampled instrument can get slower the longer it plays: the
    /// harp library this was written for climbs from 2.5 ms a block to 43 ms
    /// over two and a half minutes, driven with nothing but notes and a
    /// controller. Reloading it inside the plugin's own editor clears that.
    /// This is the same thing asked for over VST3, without re-streaming the
    /// gigabytes of samples a real reload would.
    ///
    /// # Safety of the caller, not of this function
    ///
    /// None of these calls may happen while a `process` call is in flight, and
    /// this type has no way to know. The engine guarantees it by holding the
    /// renderer's lock, which is the only thing that stops both the audio
    /// callback and the render-ahead pump at once. Do not reach for a
    /// component handle and call this from a Tauri thread.
    pub fn reset(&mut self, mode: ResetMode) -> Result<(), String> {
        // The order is `Drop`'s, which is `load`'s in reverse, and then
        // `load`'s again. A plugin torn down out of order is entitled to
        // crash, and several do.
        //
        // SAFETY: the component is live for as long as `self` is, and the
        // caller has guaranteed that nothing is processing it.
        unsafe {
            match mode {
                ResetMode::Processing => {
                    self.processor.setProcessing(0);
                    self.processor.setProcessing(1);
                }
                ResetMode::Active | ResetMode::Setup => {
                    self.processor.setProcessing(0);
                    if self.component.setActive(0) != kResultOk {
                        return Err("the plugin would not deactivate".to_string());
                    }

                    // Re-stating the setup is only legal while inactive, which
                    // is the one reason this mode exists separately: some
                    // plugins treat it as the cue to rebuild their DSP, and
                    // some ignore it.
                    if mode == ResetMode::Setup {
                        let mut setup = ProcessSetup {
                            processMode: kRealtime as i32,
                            symbolicSampleSize: kSample32 as i32,
                            maxSamplesPerBlock: self.max_block as i32,
                            sampleRate: self.sample_rate,
                        };
                        self.processor.setupProcessing(&mut setup);
                    }

                    if self.component.setActive(1) != kResultOk {
                        self.dormant = true;
                        return Err("the plugin would not come back".to_string());
                    }
                    self.processor.setProcessing(1);
                }
                ResetMode::State => {
                    let saved = ComWrapper::new(MemoryStream::empty());
                    let out = saved
                        .to_com_ptr::<IBStream>()
                        .ok_or("could not build a stream")?;
                    if self.component.getState(out.as_ptr()) != kResultOk {
                        return Err("the plugin would not give up its state".to_string());
                    }

                    let back = ComWrapper::new(MemoryStream::from_bytes(saved.take()));
                    let into = back
                        .to_com_ptr::<IBStream>()
                        .ok_or("could not build a stream")?;
                    let mut at = 0i64;
                    into.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut at);
                    if self.component.setState(into.as_ptr()) != kResultOk {
                        return Err("the plugin rejected its own state".to_string());
                    }
                }
            }
        }

        // Whatever the plugin just forgot, the host has to forget with it. A
        // note-off for a voice that no longer exists is the least of it: the
        // sounding set is what a later Stop releases from, and it would go on
        // naming pitches nothing is playing for the rest of the session.
        self.scheduler.forget();
        self.param_scheduler.clear();
        for buffer in &mut self.buffers {
            buffer.fill(0.0);
        }
        self.last_process = kResultOk;

        // So the health line after a reset describes the instrument as it is
        // now rather than averaging it with how it was before.
        self.process_blocks = 0;
        self.process_total = Duration::ZERO;
        self.process_max = Duration::ZERO;

        Ok(())
    }

    /// Render `frames` frames and add them into `out`, which is interleaved
    /// stereo.
    ///
    /// Adds rather than overwrites, because several plugins share one output
    /// stream — the caller zeroes the buffer once per block and each plugin
    /// mixes itself in.
    pub fn process_into(
        &mut self,
        out: &mut [f32],
        frames: usize,
        block_start: i64,
        transport: Transport,
    ) {
        // A component a failed reset left deactivated. Handing it buffers would
        // be handing them to something that has freed what it was using them
        // for; a silent track is the honest outcome. See `Plugin::dormant`.
        if self.dormant {
            return;
        }

        let frames = frames.min(self.max_block);
        if frames == 0 {
            return;
        }

        // Read once and held for the whole block, so that a trace switched on
        // midway cannot produce events without the summary that counts them.
        let tracing = trace::enabled();
        let slot = self.trace_slot;
        let block_end = block_start + frames as i64;
        let mut events = 0usize;
        let mut params = 0usize;
        let mut queue_full = 0u64;

        // SAFETY: the event list and the parameter changes are only touched
        // here, on the audio thread, and the plugin has finished reading the
        // previous block's copies before this call returns to us.
        unsafe {
            self.event_list.clear();

            let list = &self.event_list;
            self.scheduler
                .take_due(block_start, block_end, |offset, event| {
                    let vst = to_vst_event(offset, event);

                    if tracing {
                        // Read back off the VST3 event rather than recomputed
                        // from ours, so that the log says what the plugin was
                        // handed and not what it ought to have been handed.
                        trace::emit(match event.kind {
                            EventKind::NoteOn { .. } => Record::NoteOn {
                                slot,
                                pitch: vst.__field0.noteOn.pitch,
                                velocity: vst.__field0.noteOn.velocity,
                                offset,
                                frame: block_start + offset as i64,
                            },
                            EventKind::NoteOff => Record::NoteOff {
                                slot,
                                pitch: vst.__field0.noteOff.pitch,
                                offset,
                                frame: block_start + offset as i64,
                            },
                        });
                    }
                    events += 1;

                    list.add(vst);
                });

            self.param_changes.clear();

            let changes = &self.param_changes;
            self.param_scheduler
                .take_due(block_start, block_end, |offset, id, value| {
                    if tracing {
                        trace::emit(Record::ParamPoint {
                            slot,
                            id,
                            value,
                            offset,
                            frame: block_start + offset as i64,
                        });
                    }
                    params += 1;

                    if !changes.add_point(id, offset as i32, value) {
                        queue_full += 1;
                    }
                });
        }

        for buffer in &mut self.buffers {
            buffer[..frames].fill(0.0);
        }
        for (i, buffer) in self.buffers.iter_mut().enumerate() {
            self.channel_ptrs[i] = buffer.as_mut_ptr();
        }

        let previous_result = self.last_process;
        // Filled in by the timed call below, and read by the trace after it.
        let mut spent = Duration::ZERO;

        // SAFETY: `bus`, `data` and everything they point at live until the
        // `process` call returns.
        unsafe {
            let mut bus = vst3::Steinberg::Vst::AudioBusBuffers {
                numChannels: self.channels as i32,
                silenceFlags: 0,
                __field0: vst3::Steinberg::Vst::AudioBusBuffers__type0 {
                    channelBuffers32: self.channel_ptrs.as_mut_ptr(),
                },
            };

            let event_list_ptr = self
                .event_list
                .to_com_ptr::<IEventList>()
                .map(|p| p.as_ptr())
                .unwrap_or(ptr::null_mut());

            let param_changes_ptr = self
                .param_changes
                .to_com_ptr::<IParameterChanges>()
                .map(|p| p.as_ptr())
                .unwrap_or(ptr::null_mut());

            // Stated rather than left null. A plugin with no context cannot tell
            // playing from idling, has no tempo to sync to, and has no timeline
            // to place a parameter change on; every real host supplies one, and
            // a plugin that works everywhere else is entitled to expect it.
            let mut context = self.context(block_start, transport);

            let mut data = ProcessData {
                processMode: kRealtime as i32,
                symbolicSampleSize: kSample32 as i32,
                numSamples: frames as i32,
                numInputs: 0,
                numOutputs: 1,
                inputs: ptr::null_mut(),
                outputs: &mut bus,
                inputParameterChanges: param_changes_ptr,
                outputParameterChanges: ptr::null_mut(),
                inputEvents: event_list_ptr,
                outputEvents: ptr::null_mut(),
                processContext: &mut context,
            };

            // Read around the call rather than once per block, so a run with
            // the trace off pays nothing for the measurement.
            let started = tracing.then(Instant::now);
            self.last_process = self.processor.process(&mut data);
            if let Some(started) = started {
                spent = started.elapsed();
                self.process_blocks += 1;
                self.process_total += spent;
                self.process_max = self.process_max.max(spent);
            }
        }

        self.queue_full += queue_full;

        if tracing {
            // Every block would be a hundred lines a second saying nothing. A
            // block that carried something is what the log is for, and so is a
            // result that has just changed — a plugin that starts refusing to
            // process is otherwise indistinguishable from one playing quietly.
            //
            // And so is a block that took too long, whether or not it carried
            // anything: a dropout cannot be attributed without knowing which
            // block overran, and the ones that carry nothing are exactly the ones
            // a "blocks that carried something" rule would hide. A quarter of the
            // deadline, so the blocks on the way to overrunning are in the log
            // too rather than only the ones already past it.
            let budget = frames as f64 / self.sample_rate;
            let slow = spent.as_secs_f64() * 4.0 > budget;

            if events > 0 || params > 0 || slow || self.last_process != previous_result {
                trace::emit(Record::Process {
                    slot,
                    frames,
                    block_start,
                    events,
                    params,
                    result: self.last_process,
                    spent_us: spent.as_micros() as u64,
                });
            }

            // Refusals and reorderings are counters nothing else ever reads.
            // Reported when they move, which is the only moment they mean
            // anything.
            let overflow = (
                self.scheduler.dropped(),
                self.param_scheduler.dropped(),
                self.param_scheduler.reordered(),
                self.queue_full,
            );
            if overflow != self.traced_overflow {
                self.traced_overflow = overflow;
                trace::emit(Record::Overflow {
                    slot,
                    notes: overflow.0,
                    params: overflow.1,
                    reordered: overflow.2,
                    queue_full: overflow.3,
                });
            }

            // What is being held, and what it cost. On an interval rather than
            // on a change, because the thing being looked for is a slope: a
            // queue or a voice count that only ever goes up, or a `process`
            // call that takes longer every minute.
            if self.health_at.elapsed() >= HEALTH_INTERVAL {
                self.health_at = Instant::now();
                trace::emit(Record::Health {
                    slot,
                    notes_pending: self.scheduler.pending_len() as u32,
                    notes_sounding: self.scheduler.sounding_len() as u32,
                    params_pending: self.param_scheduler.pending_len() as u32,
                    blocks: self.process_blocks,
                    process_total_us: self.process_total.as_micros() as u64,
                    process_max_us: self.process_max.as_micros() as u64,
                });
                self.process_blocks = 0;
                self.process_total = Duration::ZERO;
                self.process_max = Duration::ZERO;
            }
        }

        // Down to interleaved stereo. A mono bus feeds both sides rather than
        // playing out of one speaker; anything past the second channel is a
        // surround or aux channel this app has no use for.
        let gain = self.gain;
        let right_channel = if self.channels > 1 { 1 } else { 0 };
        for frame in 0..frames {
            out[frame * 2] += self.buffers[0][frame] * gain;
            out[frame * 2 + 1] += self.buffers[right_channel][frame] * gain;
        }
    }

    /// This block's `ProcessContext`. See [`process_context`].
    fn context(&self, block_start: i64, transport: Transport) -> ProcessContext {
        process_context(self.sample_rate, block_start, transport)
    }
}

/// Where this block sits, in every frame of reference VST3 offers.
///
/// Zeroed and then filled, so the fields this host cannot speak for — the cycle
/// markers, the chord, the SMPTE offset — read as nothing rather than as whatever
/// the stack held. None of their validity flags is set either, which is how a
/// plugin knows not to trust them.
fn process_context(
    sample_rate: f64,
    block_start: i64,
    transport: Transport,
) -> ProcessContext {
    // SAFETY: every field is a plain integer, float or POD struct.
    let mut context: ProcessContext = unsafe { std::mem::zeroed() };

    let mut state = ContextFlags::kSystemTimeValid as u32
        | ContextFlags::kContTimeValid as u32
        | ContextFlags::kProjectTimeMusicValid as u32
        | ContextFlags::kTempoValid as u32
        | ContextFlags::kTimeSigValid as u32;
    if transport.playing {
        state |= ContextFlags::kPlaying as u32;
    }

    context.state = state;
    context.sampleRate = sample_rate;
    // The stream's own counter for both: it is the only timeline this host has,
    // it never goes backwards, and a plugin needs it continuous rather than
    // anchored to anything in particular.
    context.projectTimeSamples = block_start;
    context.continousTimeSamples = block_start;
    context.systemTime = transport.system_time;
    // Quarter notes, which is what the musical fields are measured in.
    context.projectTimeMusic = block_start as f64 / sample_rate * transport.tempo / 60.0;
    context.tempo = transport.tempo;
    context.timeSigNumerator = transport.time_sig.0;
    context.timeSigDenominator = transport.time_sig.1;

    context
}

impl Drop for Plugin {
    fn drop(&mut self) {
        // The teardown sequence mirrors the setup one. A plugin torn down out
        // of order is entitled to crash, and several do.
        unsafe {
            self.processor.setProcessing(0);
            self.component.setActive(0);
            self.component.terminate();
        }
    }
}

/// Ask a factory for one object of `class_id`, as interface `I`.
unsafe fn create_instance<I: Interface>(
    factory: &ComPtr<vst3::Steinberg::IPluginFactory>,
    cid: &TUID,
) -> Option<ComPtr<I>> {
    let mut obj: *mut c_void = ptr::null_mut();
    let iid = I::IID;

    let result = factory.createInstance(
        cid.as_ptr(),
        iid.as_ptr() as *const _,
        &mut obj,
    );

    if result != kResultOk || obj.is_null() {
        return None;
    }

    ComPtr::from_raw(obj as *mut I)
}

/// A plugin's controller half, and what keeps it talking to the processing half.
struct Controller {
    controller: ComPtr<IEditController>,
    /// The host objects the two were connected through, for the plugin to hold.
    connections: Vec<ComWrapper<ConnectionProxy>>,
}

/// Create the plugin's edit controller and wire it to the component.
///
/// VST3 splits a plugin in two: a component that processes audio and a
/// controller that owns parameters and the editor. They are separate objects,
/// on purpose, so a host can run them in different processes — which means the
/// host is responsible for introducing them to each other. A controller that is
/// never connected shows an editor whose knobs do nothing.
///
/// Some plugins are "single-component" and implement both on one object. Those
/// report no controller class, and must not be initialised a second time.
unsafe fn build_controller(
    module: &Module,
    component: &ComPtr<IComponent>,
    host: &ComPtr<FUnknown>,
    handler: &ComWrapper<ComponentHandler>,
) -> Option<Controller> {
    let mut cid: TUID = std::mem::zeroed();
    let separate = component.getControllerClassId(&mut cid) == kResultOk;
    let mut connections = Vec::new();

    let controller = if separate {
        let created = create_instance::<IEditController>(module.factory(), &cid);
        if let Some(controller) = &created {
            if controller.initialize(host.as_ptr()) != kResultOk {
                return None;
            }
        }
        created
    } else {
        // Single-component: the object is already initialised.
        component.cast::<IEditController>()
    }?;

    if let Some(handler) = handler.to_com_ptr::<IComponentHandler>() {
        controller.setComponentHandler(handler.as_ptr());
    }

    // The controller starts blank; it learns the current settings by being
    // handed the component's state. Without this the editor opens showing
    // defaults while the audio plays something else.
    if separate {
        let stream = ComWrapper::new(MemoryStream::empty());
        if let Some(ptr) = stream.to_com_ptr::<IBStream>() {
            if component.getState(ptr.as_ptr()) == kResultOk {
                let mut at = 0i64;
                ptr.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut at);
                controller.setComponentState(ptr.as_ptr());
            }
        }

        // The two-way connection carries the messages a plugin uses to keep its
        // editor in step with its processing — and it goes *through the host*
        // rather than half to half. VST3 asks for that, because the host is the
        // only party that knows which thread a message arrived on and a
        // controller's handler does not belong inside `process`. See
        // `ConnectionProxy`.
        if let (Some(a), Some(b)) = (
            component.cast::<IConnectionPoint>(),
            controller.cast::<IConnectionPoint>(),
        ) {
            let to_controller = ComWrapper::new(ConnectionProxy::to(b.clone()));
            let to_component = ComWrapper::new(ConnectionProxy::to(a.clone()));

            match (
                to_controller.to_com_ptr::<IConnectionPoint>(),
                to_component.to_com_ptr::<IConnectionPoint>(),
            ) {
                (Some(for_component), Some(for_controller)) => {
                    a.connect(for_component.as_ptr());
                    b.connect(for_controller.as_ptr());
                    connections.push(to_controller);
                    connections.push(to_component);
                }
                // A proxy that will not give up a COM pointer is unusable, and a
                // direct connection is much better than none. In practice
                // `ComWrapper` always obliges for a declared interface, so this
                // never fires.
                _ => {
                    a.connect(b.as_ptr());
                    b.connect(a.as_ptr());
                }
            }
        }
    }

    Some(Controller {
        controller,
        connections,
    })
}

/// One automatable parameter, as the webview needs to describe it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamInfo {
    /// VST3's `ParamID`. Stable for a given plugin version, and what a curve
    /// stores — the index is not, because the list can be filtered.
    pub id: u32,
    pub title: String,
    /// "Hz", "dB", "%" — often empty, and only ever shown beside the title.
    pub units: String,
    /// Normalised 0..=1: what the parameter reads before anything drives it.
    pub default_normalized: f64,
    /// 0 for a continuous parameter, N for a switch or list with N+1 positions.
    pub step_count: i32,
}

/// The parameters worth offering as automation targets.
///
/// Filtered, not merely listed. A plugin routinely publishes hundreds of
/// entries — internal state, meters, program slots — and the ones that answer
/// "what can I automate" are those flagged `kCanAutomate` and not flagged
/// read-only or hidden. An unfiltered list is not a menu anyone can use.
pub fn list_params(controller: &ComPtr<IEditController>) -> Vec<ParamInfo> {
    // SAFETY: the controller is live for the duration of the call, and every
    // pointer handed to it points at a local.
    unsafe {
        let count = controller.getParameterCount().max(0);
        let mut out = Vec::new();

        for index in 0..count {
            let mut info: ParameterInfo = std::mem::zeroed();
            if controller.getParameterInfo(index, &mut info) != kResultOk {
                continue;
            }

            let automatable = info.flags & kCanAutomate != 0;
            let excluded = info.flags & (kIsReadOnly | kIsHidden) != 0;
            if !automatable || excluded {
                continue;
            }

            out.push(ParamInfo {
                id: info.id,
                title: read_wstring(&info.title),
                units: read_wstring(&info.units),
                default_normalized: info.defaultNormalizedValue,
                step_count: info.stepCount,
            });
        }

        out
    }
}

/// The MIDI controller numbers a host may ask a plugin about.
///
/// 0..=127 are the continuous controllers. VST3 continues past them —
/// `kAfterTouch` is 128 and `kPitchBend` 129 — but those are not what a plugin's
/// MIDI-learn binds and offering them would be a different feature.
const CC_COUNT: u16 = 128;

/// The event bus and channel every CC is addressed on.
///
/// Notes go out on bus 0, channel 0 and nothing here can vary that
/// (`to_vst_event`, and `events::Event` carries no channel at all). A CC
/// resolved for any other channel would arrive somewhere the notes did not.
const CC_BUS: i32 = 0;
const CC_CHANNEL: i16 = 0;

/// A MIDI controller this plugin accepts, and the parameter it arrives as.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcInfo {
    /// The controller number, 0..=127.
    pub controller: u16,
    /// The `ParamID` a change on that controller must be sent as.
    pub param_id: u32,
}

/// The controllers this plugin has a mapping for.
///
/// In VST3 there is no MIDI stream into a plugin: a host that wants to send CC
/// asks `IMidiMapping` which parameter stands for it, and then sends an ordinary
/// parameter change on that id. So this is the whole of the CC support — after
/// it, a controller is just another `ParamID` and rides machinery that already
/// exists.
///
/// Empty when the plugin implements no `IMidiMapping`, which is also how the UI
/// learns not to offer a MIDI-learn panel it could not follow through on.
///
/// The ids here are deliberately *not* cross-checked against `list_params`: a
/// plugin normally flags its CC proxies hidden, so the two sets barely overlap
/// and reconciling them would only hide working targets.
pub fn list_cc(controller: &ComPtr<IEditController>) -> Vec<CcInfo> {
    // SAFETY: the controller is live for the duration of the call, and `id`
    // points at a local that outlives every use of it.
    unsafe {
        let Some(mapping) = controller.cast::<IMidiMapping>() else {
            return Vec::new();
        };

        let mut out = Vec::new();
        for cc in 0..CC_COUNT {
            let mut id: ParamID = 0;
            // The result is what says whether there is a mapping. A plugin that
            // refuses leaves `id` untouched, so reading it anyway would bind the
            // controller to whatever parameter 0 happens to be — silently, and
            // audibly wrong.
            if mapping.getMidiControllerAssignment(CC_BUS, CC_CHANNEL, cc as i16, &mut id)
                != kResultOk
            {
                continue;
            }

            out.push(CcInfo {
                controller: cc,
                param_id: id,
            });
        }

        out
    }
}

/// The output bus to actually listen to.
struct MainBus {
    index: i32,
    channel_count: i32,
}

/// The plugin's main audio output.
///
/// The one flagged `kMain` if there is one, else the first. A library with
/// sixteen outputs puts the full mix on its main bus and individual sections on
/// the rest, so this is the difference between hearing the orchestra and
/// hearing the first violins.
unsafe fn main_output_bus(component: &ComPtr<IComponent>) -> Option<MainBus> {
    use vst3::Steinberg::Vst::BusTypes_::kMain;

    let count = component.getBusCount(kAudio as i32, kOutput as i32);
    let mut fallback = None;

    for index in 0..count {
        let mut info: vst3::Steinberg::Vst::BusInfo = std::mem::zeroed();
        if component.getBusInfo(kAudio as i32, kOutput as i32, index, &mut info) != kResultOk {
            continue;
        }

        let bus = MainBus {
            index,
            channel_count: info.channelCount,
        };
        if info.busType == kMain as i32 {
            return Some(bus);
        }
        fallback.get_or_insert(bus);
    }

    fallback
}

/// Switch on every bus of a given kind and direction.
unsafe fn activate_all_buses(component: &ComPtr<IComponent>, media: i32, direction: i32) {
    let count = component.getBusCount(media, direction);
    for index in 0..count {
        component.activateBus(media, direction, index, 1);
    }
}

/// Translate one of our note events into the VST3 wire form.
fn to_vst_event(offset: u32, event: NoteEvent) -> Event {
    use vst3::Steinberg::Vst::Event_::EventTypes_::{kNoteOffEvent, kNoteOnEvent};

    // Zeroed rather than field-by-field: `Event` carries a union, and the
    // fields of the variant we are not using still have to be defined.
    let mut out: Event = unsafe { std::mem::zeroed() };
    out.busIndex = 0;
    out.sampleOffset = offset as i32;
    out.ppqPosition = 0.0;
    out.flags = 0;

    match event.kind {
        EventKind::NoteOn { velocity } => {
            out.r#type = kNoteOnEvent as u16;
            out.__field0.noteOn.channel = 0;
            out.__field0.noteOn.pitch = event.pitch;
            out.__field0.noteOn.tuning = 0.0;
            // VST3 velocity is normalised, unlike MIDI's 0-127.
            out.__field0.noteOn.velocity = velocity as f32 / 127.0;
            out.__field0.noteOn.length = 0;
            // -1 means "no note id": releases are matched by pitch, which is
            // what a note-off carrying the same -1 will do.
            out.__field0.noteOn.noteId = -1;
        }
        EventKind::NoteOff => {
            out.r#type = kNoteOffEvent as u16;
            out.__field0.noteOff.channel = 0;
            out.__field0.noteOff.pitch = event.pitch;
            out.__field0.noteOff.velocity = 0.0;
            out.__field0.noteOff.noteId = -1;
            out.__field0.noteOff.tuning = 0.0;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_on_becomes_a_vst_note_on_with_normalised_velocity() {
        let event = to_vst_event(
            64,
            NoteEvent {
                frame: 0,
                pitch: 60,
                kind: EventKind::NoteOn { velocity: 127 },
            },
        );

        use vst3::Steinberg::Vst::Event_::EventTypes_::kNoteOnEvent;
        assert_eq!(event.r#type, kNoteOnEvent as u16);
        assert_eq!(event.sampleOffset, 64);
        unsafe {
            assert_eq!(event.__field0.noteOn.pitch, 60);
            assert_eq!(event.__field0.noteOn.velocity, 1.0);
            assert_eq!(event.__field0.noteOn.noteId, -1);
        }
    }

    #[test]
    fn a_mid_range_velocity_lands_in_the_middle() {
        let event = to_vst_event(
            0,
            NoteEvent {
                frame: 0,
                pitch: 60,
                kind: EventKind::NoteOn { velocity: 64 },
            },
        );
        unsafe {
            let v = event.__field0.noteOn.velocity;
            assert!((v - 0.504).abs() < 0.01, "got {v}");
        }
    }

    #[test]
    fn a_note_off_becomes_a_vst_note_off() {
        let event = to_vst_event(
            8,
            NoteEvent {
                frame: 0,
                pitch: 72,
                kind: EventKind::NoteOff,
            },
        );

        use vst3::Steinberg::Vst::Event_::EventTypes_::kNoteOffEvent;
        assert_eq!(event.r#type, kNoteOffEvent as u16);
        assert_eq!(event.sampleOffset, 8);
        unsafe {
            assert_eq!(event.__field0.noteOff.pitch, 72);
            // Matched by pitch, like the note-on it releases.
            assert_eq!(event.__field0.noteOff.noteId, -1);
        }
    }

    const SR: f64 = 48_000.0;

    /// Whether a context has one of the validity flags set.
    fn has(context: &ProcessContext, flag: u32) -> bool {
        context.state & flag != 0
    }

    // The fields this host can actually speak for, and the flags that say so. A
    // plugin reads the flags first; a value with no flag behind it is worse than
    // no value at all.
    #[test]
    fn a_context_states_the_rate_the_frame_and_the_meter() {
        let context = process_context(
            SR,
            96_000,
            Transport {
                playing: true,
                tempo: 90.0,
                time_sig: (7, 8),
                system_time: 1_234,
            },
        );

        assert_eq!(context.sampleRate, SR);
        assert_eq!(context.projectTimeSamples, 96_000);
        assert_eq!(context.continousTimeSamples, 96_000);
        assert_eq!(context.systemTime, 1_234);
        assert_eq!(context.tempo, 90.0);
        assert_eq!(context.timeSigNumerator, 7);
        assert_eq!(context.timeSigDenominator, 8);

        assert!(has(&context, ContextFlags::kTempoValid as u32));
        assert!(has(&context, ContextFlags::kTimeSigValid as u32));
        assert!(has(&context, ContextFlags::kContTimeValid as u32));
        assert!(has(&context, ContextFlags::kSystemTimeValid as u32));
    }

    // The stream runs whether or not anything is being played, so this flag is
    // the only thing that tells a plugin which it is.
    #[test]
    fn only_a_rolling_transport_reads_as_playing() {
        let rolling = process_context(SR, 0, Transport::rolling(120.0));
        let idle = process_context(SR, 0, Transport::default());

        assert!(has(&rolling, ContextFlags::kPlaying as u32));
        assert!(!has(&idle, ContextFlags::kPlaying as u32));
    }

    // Quarter notes, which is the unit every musical field in a context uses. At
    // 120 BPM a quarter note is half a second, so two seconds is four of them.
    #[test]
    fn musical_time_is_the_tempo_applied_to_the_frame_count() {
        let context = process_context(SR, (SR * 2.0) as i64, Transport::rolling(120.0));

        assert!(has(&context, ContextFlags::kProjectTimeMusicValid as u32));
        assert!((context.projectTimeMusic - 4.0).abs() < 1e-9, "got {}", context.projectTimeMusic);
    }

    // Claiming a cycle, a chord or a SMPTE offset this host knows nothing about
    // would have a plugin act on whatever the stack held.
    #[test]
    fn a_context_claims_nothing_it_cannot_answer_for() {
        let context = process_context(SR, 4_096, Transport::rolling(120.0));

        for unflagged in [
            ContextFlags::kCycleValid as u32,
            ContextFlags::kCycleActive as u32,
            ContextFlags::kChordValid as u32,
            ContextFlags::kSmpteValid as u32,
            ContextFlags::kClockValid as u32,
            ContextFlags::kBarPositionValid as u32,
            ContextFlags::kRecording as u32,
        ] {
            assert!(!has(&context, unflagged), "flag {unflagged} should not be set");
        }

        assert_eq!(context.cycleStartMusic, 0.0);
        assert_eq!(context.cycleEndMusic, 0.0);
        assert_eq!(context.smpteOffsetSubframes, 0);
        assert_eq!(context.samplesToNextClock, 0);
    }

    // A stream that has only just started is the one moment the musical clock is
    // at zero, and a plugin must not read that as "no context".
    #[test]
    fn the_first_block_is_a_real_position_rather_than_an_absent_one() {
        let context = process_context(SR, 0, Transport::rolling(100.0));

        assert_eq!(context.projectTimeSamples, 0);
        assert_eq!(context.projectTimeMusic, 0.0);
        assert!(has(&context, ContextFlags::kProjectTimeMusicValid as u32));
    }
}
