//! A minimal VST3 instrument, built only to test the host.
//!
//! Real plugins are a bad way to find out whether a host is correct. A sample
//! library renders silence until its content is loaded, a synth renders silence
//! until a patch is chosen, and neither tells you which end is at fault. This
//! one is unconditional: send it a note and it emits a sine, every time.
//!
//! Not shipped with the app — it exists so `cargo run --example render` has
//! something whose silence is unambiguously the host's fault.

#![allow(non_snake_case)]

use std::cell::UnsafeCell;
use std::ffi::{c_char, c_void, CString};

use vst3::Steinberg::Vst::{
    BusDirections_, BusInfo, BusInfo_, BusTypes_, Event_::EventTypes_, IAudioProcessor,
    IAudioProcessorTrait, IComponent, IComponentTrait, IEventListTrait, IoMode, MediaType,
    BusDirection, MediaTypes_, ProcessData, ProcessSetup, RoutingInfo, SpeakerArrangement,
    SymbolicSampleSizes_::kSample32, TChar,
};
use vst3::Steinberg::{
    int32, kInvalidArgument, kResultFalse, kResultOk, tresult, uint32, FIDString,
    FUnknown, IBStream, IBStreamTrait, IPluginBase, IPluginBaseTrait, IPluginFactory,
    IPluginFactoryTrait,
    PClassInfo, PClassInfo_, PFactoryInfo, PFactoryInfo_, TBool, TUID,
};
use vst3::{uid, Class, ComRef, ComWrapper};

const PLUGIN_NAME: &str = "Chord Composer Test Synth";
const VOICES: usize = 16;

fn copy_cstring(src: &str, dst: &mut [c_char]) {
    let c_string = CString::new(src).unwrap_or_default();
    let bytes = c_string.as_bytes_with_nul();

    for (src, dst) in bytes.iter().zip(dst.iter_mut()) {
        *dst = *src as c_char;
    }
    if bytes.len() > dst.len() {
        if let Some(last) = dst.last_mut() {
            *last = 0;
        }
    }
}

fn copy_wstring(src: &str, dst: &mut [TChar]) {
    let mut len = 0;
    for (src, dst) in src.encode_utf16().zip(dst.iter_mut()) {
        *dst = src;
        len += 1;
    }
    if len < dst.len() {
        dst[len] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

#[derive(Clone, Copy, Default)]
struct Voice {
    pitch: i16,
    /// Radians per frame.
    step: f32,
    phase: f32,
    on: bool,
}

/// The fixture's "preset": four opaque bytes, so a host's state round-trip has
/// something to actually round-trip.
pub const DEFAULT_BLOB: [u8; 4] = [1, 2, 3, 4];

struct State {
    sample_rate: f32,
    voices: [Voice; VOICES],
    blob: [u8; 4],
}

pub struct TestSynth {
    state: UnsafeCell<State>,
}

// SAFETY: a host is required to call `process` from one thread at a time, and
// nothing else here touches the state.
unsafe impl Sync for TestSynth {}

impl TestSynth {
    const CID: TUID = uid(0x43484F52, 0x44435054, 0x53594E54, 0x48303031);

    fn new() -> TestSynth {
        TestSynth {
            state: UnsafeCell::new(State {
                sample_rate: 48_000.0,
                voices: [Voice::default(); VOICES],
                blob: DEFAULT_BLOB,
            }),
        }
    }
}

impl Class for TestSynth {
    type Interfaces = (IComponent, IAudioProcessor);
}

impl IPluginBaseTrait for TestSynth {
    unsafe fn initialize(&self, _context: *mut FUnknown) -> tresult {
        kResultOk
    }
    unsafe fn terminate(&self) -> tresult {
        kResultOk
    }
}

impl IComponentTrait for TestSynth {
    unsafe fn getControllerClassId(&self, _class_id: *mut TUID) -> tresult {
        // Single-component design: no separate controller to hand back.
        kResultFalse
    }

    unsafe fn setIoMode(&self, _mode: IoMode) -> tresult {
        kResultOk
    }

    unsafe fn getBusCount(&self, media_type: MediaType, dir: BusDirection) -> int32 {
        match (media_type as i32, dir as i32) {
            // One stereo output, one event input. An instrument, so no audio in.
            (MediaTypes_::kAudio, BusDirections_::kOutput) => 1,
            (MediaTypes_::kEvent, BusDirections_::kInput) => 1,
            _ => 0,
        }
    }

    unsafe fn getBusInfo(
        &self,
        media_type: MediaType,
        dir: BusDirection,
        index: int32,
        bus: *mut BusInfo,
    ) -> tresult {
        if index != 0 || bus.is_null() {
            return kInvalidArgument;
        }
        let bus = &mut *bus;
        bus.mediaType = media_type;
        bus.direction = dir;
        bus.busType = BusTypes_::kMain as i32;
        bus.flags = BusInfo_::BusFlags_::kDefaultActive as uint32;

        match (media_type as i32, dir as i32) {
            (MediaTypes_::kAudio, BusDirections_::kOutput) => {
                bus.channelCount = 2;
                copy_wstring("Output", &mut bus.name);
                kResultOk
            }
            (MediaTypes_::kEvent, BusDirections_::kInput) => {
                bus.channelCount = 1;
                copy_wstring("Event In", &mut bus.name);
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }

    unsafe fn getRoutingInfo(
        &self,
        _in_info: *mut RoutingInfo,
        _out_info: *mut RoutingInfo,
    ) -> tresult {
        kResultFalse
    }

    unsafe fn activateBus(
        &self,
        _media_type: MediaType,
        _dir: BusDirection,
        _index: int32,
        _state: TBool,
    ) -> tresult {
        kResultOk
    }

    unsafe fn setActive(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn setState(&self, state: *mut IBStream) -> tresult {
        let Some(stream) = ComRef::from_raw(state) else {
            return kInvalidArgument;
        };
        let mut blob = [0u8; 4];
        let mut read = 0;
        if stream.read(blob.as_mut_ptr() as *mut c_void, 4, &mut read) != kResultOk || read != 4 {
            return kResultFalse;
        }
        (*self.state.get()).blob = blob;
        kResultOk
    }

    unsafe fn getState(&self, state: *mut IBStream) -> tresult {
        let Some(stream) = ComRef::from_raw(state) else {
            return kInvalidArgument;
        };
        let blob = (*self.state.get()).blob;
        let mut written = 0;
        if stream.write(blob.as_ptr() as *mut c_void, 4, &mut written) != kResultOk {
            return kResultFalse;
        }
        kResultOk
    }
}

impl IAudioProcessorTrait for TestSynth {
    unsafe fn setBusArrangements(
        &self,
        _inputs: *mut SpeakerArrangement,
        _num_ins: int32,
        _outputs: *mut SpeakerArrangement,
        _num_outs: int32,
    ) -> tresult {
        kResultOk
    }

    unsafe fn getBusArrangement(
        &self,
        _dir: BusDirection,
        _index: int32,
        arr: *mut SpeakerArrangement,
    ) -> tresult {
        if arr.is_null() {
            return kInvalidArgument;
        }
        // kSpeakerL | kSpeakerR
        *arr = 0x3;
        kResultOk
    }

    unsafe fn canProcessSampleSize(&self, symbolic_sample_size: int32) -> tresult {
        if symbolic_sample_size == kSample32 as i32 {
            kResultOk
        } else {
            kResultFalse
        }
    }

    unsafe fn getLatencySamples(&self) -> uint32 {
        0
    }

    unsafe fn setupProcessing(&self, setup: *mut ProcessSetup) -> tresult {
        if setup.is_null() {
            return kInvalidArgument;
        }
        (*self.state.get()).sample_rate = (*setup).sampleRate as f32;
        kResultOk
    }

    unsafe fn setProcessing(&self, _state: TBool) -> tresult {
        kResultOk
    }

    unsafe fn process(&self, data: *mut ProcessData) -> tresult {
        if data.is_null() {
            return kInvalidArgument;
        }
        let data = &mut *data;
        let state = &mut *self.state.get();

        // Events first, so a note landing on frame 0 sounds in this block.
        // Sample-accurate placement is not simulated: the host's placement is
        // what is under test, and it is asserted on the host side.
        if let Some(events) = ComRef::from_raw(data.inputEvents) {
            let count = events.getEventCount();
            for i in 0..count {
                let mut event = std::mem::zeroed();
                if events.getEvent(i, &mut event) != kResultOk {
                    continue;
                }
                match event.r#type as i32 {
                    EventTypes_::kNoteOnEvent => {
                        let note = event.__field0.noteOn;
                        if let Some(voice) = state.voices.iter_mut().find(|v| !v.on) {
                            let hz = 440.0 * 2f32.powf((note.pitch as f32 - 69.0) / 12.0);
                            voice.pitch = note.pitch;
                            voice.step = std::f32::consts::TAU * hz / state.sample_rate;
                            voice.phase = 0.0;
                            voice.on = true;
                        }
                    }
                    EventTypes_::kNoteOffEvent => {
                        let note = event.__field0.noteOff;
                        for voice in state.voices.iter_mut() {
                            if voice.on && voice.pitch == note.pitch {
                                voice.on = false;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if data.numOutputs < 1 || data.outputs.is_null() {
            return kResultOk;
        }
        let bus = &mut *data.outputs;
        let frames = data.numSamples.max(0) as usize;
        let channels = bus.numChannels.max(0) as usize;
        if channels == 0 || bus.__field0.channelBuffers32.is_null() {
            return kResultOk;
        }

        let buffers =
            std::slice::from_raw_parts(bus.__field0.channelBuffers32, channels);

        for channel in buffers.iter().take(channels) {
            if channel.is_null() {
                continue;
            }
            let out = std::slice::from_raw_parts_mut(*channel, frames);
            out.fill(0.0);
        }

        for voice in state.voices.iter_mut().filter(|v| v.on) {
            let mut phase = voice.phase;
            for frame in 0..frames {
                let sample = phase.sin() * 0.2;
                for channel in buffers.iter().take(channels) {
                    if !channel.is_null() {
                        *(*channel).add(frame) += sample;
                    }
                }
                phase += voice.step;
                if phase > std::f32::consts::TAU {
                    phase -= std::f32::consts::TAU;
                }
            }
            voice.phase = phase;
        }

        bus.silenceFlags = 0;
        kResultOk
    }

    unsafe fn getTailSamples(&self) -> uint32 {
        0
    }
}

struct Factory;

impl Class for Factory {
    type Interfaces = (IPluginFactory,);
}

impl IPluginFactoryTrait for Factory {
    unsafe fn getFactoryInfo(&self, info: *mut PFactoryInfo) -> tresult {
        let info = &mut *info;
        copy_cstring("Chord Composer", &mut info.vendor);
        copy_cstring("https://example.invalid", &mut info.url);
        copy_cstring("nobody@example.invalid", &mut info.email);
        info.flags = PFactoryInfo_::FactoryFlags_::kUnicode as int32;
        kResultOk
    }

    unsafe fn countClasses(&self) -> int32 {
        1
    }

    unsafe fn getClassInfo(&self, index: int32, info: *mut PClassInfo) -> tresult {
        if index != 0 {
            return kInvalidArgument;
        }
        let info = &mut *info;
        info.cid = TestSynth::CID;
        info.cardinality = PClassInfo_::ClassCardinality_::kManyInstances as int32;
        copy_cstring("Audio Module Class", &mut info.category);
        copy_cstring(PLUGIN_NAME, &mut info.name);
        kResultOk
    }

    unsafe fn createInstance(
        &self,
        cid: FIDString,
        iid: FIDString,
        obj: *mut *mut c_void,
    ) -> tresult {
        if *(cid as *const TUID) != TestSynth::CID {
            return kInvalidArgument;
        }
        let instance = ComWrapper::new(TestSynth::new())
            .to_com_ptr::<FUnknown>()
            .unwrap();
        let ptr = instance.as_ptr();
        ((*(*ptr).vtbl).queryInterface)(ptr, iid as *mut TUID, obj)
    }
}

#[no_mangle]
extern "system" fn InitDll() -> bool {
    true
}

#[no_mangle]
extern "system" fn ExitDll() -> bool {
    true
}

#[no_mangle]
extern "system" fn GetPluginFactory() -> *mut IPluginFactory {
    ComWrapper::new(Factory)
        .to_com_ptr::<IPluginFactory>()
        .unwrap()
        .into_raw()
}

/// Silences the unused-import warning: `IPluginBase` is needed as a supertrait
/// bound for `IComponent`.
const _: Option<IPluginBase> = None;
