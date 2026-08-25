//! One instantiated plugin: set up for playback, and rendered a block at a time.
//!
//! The lifecycle a VST3 plugin insists on is rigid and every step matters:
//! create → `initialize` with a host context → describe the processing → turn
//! the buses on → `setActive` → `setProcessing`. Skipping any of it produces a
//! plugin that loads without complaint and then renders silence, which is the
//! single most common way to lose an afternoon here.

use std::ffi::c_void;
use std::ptr;

use vst3::Steinberg::Vst::{
    BusDirections_::{kInput, kOutput},
    Event, IAudioProcessor, IAudioProcessorTrait, IComponent, IComponentHandler, IComponentTrait,
    IConnectionPoint, IConnectionPointTrait, IEditController, IEditControllerTrait, IEventList,
    IMidiMapping, IMidiMappingTrait, IParameterChanges,
    MediaTypes_::{kAudio, kEvent},
    ParamID, ParameterInfo,
    ParameterInfo_::ParameterFlags_::{kCanAutomate, kIsHidden, kIsReadOnly},
    ProcessData, ProcessModes_::kRealtime, ProcessSetup, SymbolicSampleSizes_::kSample32,
};
use vst3::Steinberg::{
    kResultOk, FUnknown, IBStream, IBStreamTrait, IBStream_, IPluginBaseTrait, IPluginFactoryTrait,
    TUID,
};
use vst3::{ComPtr, ComWrapper, Interface};

use super::events::{Event as NoteEvent, EventKind, Scheduler};
use super::host::{read_wstring, ComponentHandler, EventList, HostApplication, ParameterChanges};
use super::module::{tuid_from_hex, Module};
use super::params::ParamScheduler;
use super::stream::MemoryStream;

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
const PARAM_CAPACITY: usize = 2048;

/// How many distinct parameters may change within one block.
///
/// One lane per parameter in the timeline, and a block is a few milliseconds —
/// automating thirty-two at once is already far past what anyone draws.
const PARAM_QUEUE_CAPACITY: usize = 32;

/// How many changes one parameter may carry within one block.
const PARAM_POINT_CAPACITY: usize = 64;

/// The most channels one bus may have. Anything past the first two is rendered
/// but not listened to.
const MAX_CHANNELS: usize = 32;

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
    max_block: usize,
    gain: f32,
    /// What the last `process` returned. Silence with a failing result is a
    /// host bug; silence with `kResultOk` is a plugin that had nothing to say.
    last_process: i32,

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
            let controller =
                build_controller(&module, &component, &host_unknown, &handler);

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
            // Orchestral libraries routinely present a dozen or more outputs
            // `ProcessData` has to describe
            // every *active* bus, so activating them all and then passing
            // buffers for one is a contract violation, and the plugin's
            // recourse is to render silence. Which is exactly what it does.
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
                max_block,
                gain: 1.0,
                last_process: kResultOk,
                _module: module,
            })
        }
    }

    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.clamp(0.0, 1.0);
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

    /// Render `frames` frames and add them into `out`, which is interleaved
    /// stereo.
    ///
    /// Adds rather than overwrites, because several plugins share one output
    /// stream — the caller zeroes the buffer once per block and each plugin
    /// mixes itself in.
    pub fn process_into(&mut self, out: &mut [f32], frames: usize, block_start: i64) {
        let frames = frames.min(self.max_block);
        if frames == 0 {
            return;
        }

        // SAFETY: the event list and the parameter changes are only touched
        // here, on the audio thread, and the plugin has finished reading the
        // previous block's copies before this call returns to us.
        unsafe {
            self.event_list.clear();

            let list = &self.event_list;
            self.scheduler
                .take_due(block_start, block_start + frames as i64, |offset, event| {
                    list.add(to_vst_event(offset, event));
                });

            self.param_changes.clear();

            let changes = &self.param_changes;
            self.param_scheduler.take_due(
                block_start,
                block_start + frames as i64,
                |offset, id, value| {
                    changes.add_point(id, offset as i32, value);
                },
            );
        }

        for buffer in &mut self.buffers {
            buffer[..frames].fill(0.0);
        }
        for (i, buffer) in self.buffers.iter_mut().enumerate() {
            self.channel_ptrs[i] = buffer.as_mut_ptr();
        }

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
                processContext: ptr::null_mut(),
            };

            self.last_process = self.processor.process(&mut data);
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
) -> Option<ComPtr<IEditController>> {
    let mut cid: TUID = std::mem::zeroed();
    let separate = component.getControllerClassId(&mut cid) == kResultOk;

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
        // editor in step with its processing.
        if let (Some(a), Some(b)) = (
            component.cast::<IConnectionPoint>(),
            controller.cast::<IConnectionPoint>(),
        ) {
            a.connect(b.as_ptr());
            b.connect(a.as_ptr());
        }
    }

    Some(controller)
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
}
