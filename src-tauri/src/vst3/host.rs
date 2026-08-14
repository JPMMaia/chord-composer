//! The COM objects a plugin expects its *host* to provide.
//!
//! A plugin is handed a context during `initialize` and asks it questions —
//! chiefly "who are you" and "make me one of these". Refusing to provide one at
//! all makes some plugins fail to load outright, so these are minimal but real.

use std::cell::UnsafeCell;
use std::ffi::c_void;

use vst3::Steinberg::Vst::{
    Event, IComponentHandler, IComponentHandlerTrait, IEventList, IEventListTrait, IHostApplication,
    IHostApplicationTrait, IParamValueQueue, IParamValueQueueTrait, IParameterChanges,
    IParameterChangesTrait, ParamID, ParamValue, String128, TChar,
};
use vst3::Steinberg::{int32, kNotImplemented, kResultOk, tresult, TUID};
use vst3::{Class, ComPtr, ComWrapper};

/// Write a Rust string into a fixed-size UTF-16 field, always NUL-terminated.
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

/// Read a fixed-size UTF-16 field a plugin filled in.
///
/// The inverse of [`copy_wstring`], and untrusting in the same way `module.rs`'s
/// `c_string` is: a field with no NUL at all is read to its end rather than off
/// it, and an unpaired surrogate is replaced rather than rejected. Parameter
/// titles come from arbitrary third-party code and are only ever shown in a menu.
pub fn read_wstring(src: &[TChar]) -> String {
    let len = src.iter().position(|c| *c == 0).unwrap_or(src.len());
    String::from_utf16_lossy(&src[..len])
}

/// The host context handed to every plugin's `initialize`.
pub struct HostApplication;

impl Class for HostApplication {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for HostApplication {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kNotImplemented;
        }
        copy_wstring("Chord Composer", &mut *name);
        kResultOk
    }

    /// Plugins use this to ask the host for helper objects, most often a
    /// message or attribute-list implementation for component/controller
    /// communication.
    ///
    /// Declining is legal and every plugin has to cope with it. Providing the
    /// message objects only matters once component and controller are separate
    /// and talking, which is the editor's concern rather than audio's.
    unsafe fn createInstance(
        &self,
        _cid: *mut TUID,
        _iid: *mut TUID,
        _obj: *mut *mut c_void,
    ) -> tresult {
        kNotImplemented
    }
}

/// Receives parameter edits the plugin's own UI makes.
///
/// Every plugin with an editor calls these, and a null handler makes some of
/// them refuse to open one. For now the edits are only recorded — routing them
/// to the audio thread is what the editor phase adds.
pub struct ComponentHandler;

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for ComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn performEdit(&self, _id: ParamID, _value_normalized: ParamValue) -> tresult {
        kResultOk
    }

    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn restartComponent(&self, _flags: int32) -> tresult {
        kResultOk
    }
}

/// The note events for one block, in the form the plugin reads them.
///
/// Lives for the lifetime of the plugin and is refilled each block rather than
/// rebuilt, because it is touched from the audio thread and allocating there is
/// not allowed. `UnsafeCell` rather than `RefCell` for the same reason: the
/// borrow flag would be dead weight on a buffer only ever touched by one thread.
pub struct EventList {
    events: UnsafeCell<Vec<Event>>,
}

// SAFETY: only ever touched from the audio thread. The COM machinery requires
// `Sync` because a plugin could in principle hold the pointer across threads;
// nothing in this host hands it anywhere else.
unsafe impl Sync for EventList {}

impl EventList {
    pub fn new(capacity: usize) -> EventList {
        EventList {
            events: UnsafeCell::new(Vec::with_capacity(capacity)),
        }
    }

    /// Empty the list for a new block. Keeps the allocation.
    ///
    /// # Safety
    /// The caller must not be holding a reference handed out by `add`, and must
    /// be the only thread touching this list.
    pub unsafe fn clear(&self) {
        (*self.events.get()).clear();
    }

    /// Append one event, if there is room. Never allocates.
    ///
    /// # Safety
    /// As `clear`.
    pub unsafe fn add(&self, event: Event) -> bool {
        let events = &mut *self.events.get();
        if events.len() == events.capacity() {
            return false;
        }
        events.push(event);
        true
    }
}

impl Class for EventList {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for EventList {
    unsafe fn getEventCount(&self) -> int32 {
        (*self.events.get()).len() as int32
    }

    unsafe fn getEvent(&self, index: int32, e: *mut Event) -> tresult {
        let events = &*self.events.get();
        let Some(event) = usize::try_from(index).ok().and_then(|i| events.get(i)) else {
            return kNotImplemented;
        };
        if e.is_null() {
            return kNotImplemented;
        }
        *e = *event;
        kResultOk
    }

    /// The host fills this list; a plugin writing back into its own input event
    /// list is not something this host has any use for.
    unsafe fn addEvent(&self, _e: *mut Event) -> tresult {
        kNotImplemented
    }
}

/// One parameter's changes within a block: a value, at a sample offset.
///
/// The audio-thread rules are `EventList`'s, for the same reason — fixed
/// capacity, `UnsafeCell` rather than `RefCell`, refilled rather than rebuilt.
///
/// VST3 requires the points in a queue to be **sorted by sample offset**, which
/// this does not enforce: the only thing that fills it is `ParamScheduler`,
/// which drains in frame order, so the invariant holds by construction.
pub struct ParamValueQueue {
    id: UnsafeCell<ParamID>,
    points: UnsafeCell<Vec<(int32, ParamValue)>>,
}

// SAFETY: as `EventList` — only ever touched from the audio thread.
unsafe impl Sync for ParamValueQueue {}

impl ParamValueQueue {
    pub fn new(capacity: usize) -> ParamValueQueue {
        ParamValueQueue {
            id: UnsafeCell::new(0),
            points: UnsafeCell::new(Vec::with_capacity(capacity)),
        }
    }

    /// Empty the queue and point it at another parameter. Keeps the allocation.
    ///
    /// # Safety
    /// The caller must be the only thread touching this queue, and must not be
    /// holding a reference into it.
    pub unsafe fn reset(&self, id: ParamID) {
        *self.id.get() = id;
        (*self.points.get()).clear();
    }

    /// The parameter this queue currently carries changes for.
    ///
    /// # Safety
    /// As `reset`.
    pub unsafe fn id(&self) -> ParamID {
        *self.id.get()
    }

    /// Append one point, if there is room. Never allocates.
    ///
    /// # Safety
    /// As `reset`.
    pub unsafe fn add_point(&self, offset: int32, value: ParamValue) -> bool {
        let points = &mut *self.points.get();
        if points.len() == points.capacity() {
            return false;
        }
        points.push((offset, value));
        true
    }
}

impl Class for ParamValueQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ParamValueQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        *self.id.get()
    }

    unsafe fn getPointCount(&self) -> int32 {
        (*self.points.get()).len() as int32
    }

    unsafe fn getPoint(
        &self,
        index: int32,
        sample_offset: *mut int32,
        value: *mut ParamValue,
    ) -> tresult {
        let points = &*self.points.get();
        let Some((offset, v)) = usize::try_from(index).ok().and_then(|i| points.get(i)) else {
            return kNotImplemented;
        };
        if sample_offset.is_null() || value.is_null() {
            return kNotImplemented;
        }
        *sample_offset = *offset;
        *value = *v;
        kResultOk
    }

    /// The host fills this queue, exactly as it fills the event list; a plugin
    /// writing back into its own *input* changes has nowhere for that to go.
    unsafe fn addPoint(
        &self,
        _sample_offset: int32,
        _value: ParamValue,
        _index: *mut int32,
    ) -> tresult {
        kNotImplemented
    }
}

/// The parameter changes for one block: at most one queue per parameter.
///
/// Every queue is allocated up front and reused, so a block claims queues rather
/// than creating them. `handles` holds each queue's COM pointer, taken once at
/// construction, because `getParameterData` has to answer with a raw pointer and
/// building one on the audio thread would mean touching the COM refcount there.
///
/// The pointers handed out are *borrowed*: VST3's contract for
/// `getParameterData` transfers no ownership, and the queues live as long as
/// this object does.
pub struct ParameterChanges {
    queues: Vec<ComWrapper<ParamValueQueue>>,
    handles: Vec<ComPtr<IParamValueQueue>>,
    /// How many queues are claimed this block. Always ≤ `queues.len()`.
    used: UnsafeCell<usize>,
}

// SAFETY: as `EventList`.
unsafe impl Sync for ParameterChanges {}

impl ParameterChanges {
    /// Room for `queues` distinct parameters, each holding `points` changes.
    pub fn new(queues: usize, points: usize) -> ParameterChanges {
        let wrapped: Vec<ComWrapper<ParamValueQueue>> = (0..queues)
            .map(|_| ComWrapper::new(ParamValueQueue::new(points)))
            .collect();

        // A queue that will not give up a COM pointer is unusable, and dropping
        // it here rather than at `getParameterData` keeps the two vectors index-
        // aligned. In practice `ComWrapper` always obliges for a declared
        // interface, so this filter never fires.
        let mut queues = Vec::with_capacity(wrapped.len());
        let mut handles = Vec::with_capacity(wrapped.len());
        for queue in wrapped {
            if let Some(handle) = queue.to_com_ptr::<IParamValueQueue>() {
                queues.push(queue);
                handles.push(handle);
            }
        }

        ParameterChanges {
            queues,
            handles,
            used: UnsafeCell::new(0),
        }
    }

    /// Release every queue for a new block. Keeps the allocations.
    ///
    /// # Safety
    /// The caller must be the only thread touching this object, and the plugin
    /// must no longer be reading the previous block's queues.
    pub unsafe fn clear(&self) {
        *self.used.get() = 0;
    }

    /// Record `value` for parameter `id` at `offset` frames into the block.
    ///
    /// Returns false when there is no room — either every queue is claimed by
    /// another parameter, or this parameter's queue is full. Refused rather than
    /// grown, as `Scheduler` refuses: the audio thread does not allocate.
    ///
    /// # Safety
    /// As `clear`.
    pub unsafe fn add_point(&self, id: ParamID, offset: int32, value: ParamValue) -> bool {
        let used = *self.used.get();

        // A parameter already claimed this block keeps its queue: VST3 wants one
        // queue per parameter, not one per change.
        for queue in &self.queues[..used] {
            if queue.id() == id {
                return queue.add_point(offset, value);
            }
        }

        let Some(queue) = self.queues.get(used) else {
            return false;
        };
        queue.reset(id);
        *self.used.get() = used + 1;
        queue.add_point(offset, value)
    }
}

impl Class for ParameterChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParameterChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        *self.used.get() as int32
    }

    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        let used = *self.used.get();
        match usize::try_from(index).ok().filter(|i| *i < used) {
            Some(i) => self.handles[i].as_ptr(),
            None => std::ptr::null_mut(),
        }
    }

    /// Only meaningful on *output* parameter changes, which this host does not
    /// collect. Declining is legal, and null is what a plugin has to cope with.
    unsafe fn addParameterData(&self, _id: *const ParamID, _index: *mut int32) -> *mut IParamValueQueue {
        std::ptr::null_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst3::Steinberg::Vst::Event_::EventTypes_::kNoteOnEvent;
    use vst3::ComWrapper;

    /// Wrap a queue pointer `getParameterData` handed out, without taking it.
    ///
    /// That call transfers no ownership — the `ParameterChanges` still owns the
    /// queue — so the `ComPtr` built here must not release on drop.
    unsafe fn borrowed(ptr: *mut IParamValueQueue) -> std::mem::ManuallyDrop<ComPtr<IParamValueQueue>> {
        std::mem::ManuallyDrop::new(ComPtr::from_raw(ptr).expect("a claimed queue"))
    }

    fn note_on(pitch: i16) -> Event {
        let mut event: Event = unsafe { std::mem::zeroed() };
        event.r#type = kNoteOnEvent as u16;
        // Writing a union field is safe; only reading one needs `unsafe`.
        event.__field0.noteOn.pitch = pitch;
        event
    }

    #[test]
    fn copy_wstring_terminates() {
        let mut buf = [0u16; 8];
        copy_wstring("hi", &mut buf);
        assert_eq!(&buf[..3], &['h' as u16, 'i' as u16, 0]);
    }

    // A name longer than the field must not run off the end, and must still be
    // a valid C string when the plugin reads it.
    #[test]
    fn copy_wstring_truncates_and_still_terminates() {
        let mut buf = [1u16; 4];
        copy_wstring("abcdefgh", &mut buf);
        assert_eq!(buf[3], 0);
    }

    #[test]
    fn event_list_reports_what_was_added() {
        let list = EventList::new(4);
        unsafe {
            assert!(list.add(note_on(60)));
            assert!(list.add(note_on(64)));

            assert_eq!(list.getEventCount(), 2);

            let mut out: Event = std::mem::zeroed();
            assert_eq!(list.getEvent(1, &mut out), kResultOk);
            assert_eq!(out.__field0.noteOn.pitch, 64);
        }
    }

    #[test]
    fn event_list_refuses_to_grow_past_its_capacity() {
        let list = EventList::new(2);
        unsafe {
            assert!(list.add(note_on(60)));
            assert!(list.add(note_on(61)));
            assert!(!list.add(note_on(62)));
            assert_eq!(list.getEventCount(), 2);
        }
    }

    #[test]
    fn event_list_clears_without_dropping_its_capacity() {
        let list = EventList::new(4);
        unsafe {
            list.add(note_on(60));
            list.clear();
            assert_eq!(list.getEventCount(), 0);
            assert!(list.add(note_on(61)), "capacity survived the clear");
        }
    }

    #[test]
    fn event_list_rejects_an_out_of_range_index() {
        let list = EventList::new(4);
        unsafe {
            let mut out: Event = std::mem::zeroed();
            assert_ne!(list.getEvent(0, &mut out), kResultOk);
            assert_ne!(list.getEvent(-1, &mut out), kResultOk);
        }
    }

    #[test]
    fn read_wstring_stops_at_nul() {
        let mut buf = [0u16; 8];
        copy_wstring("Cutoff", &mut buf);
        assert_eq!(read_wstring(&buf), "Cutoff");
    }

    // A plugin that fills the field to its last cell leaves no terminator. The
    // read must stop at the end rather than run past it.
    #[test]
    fn read_wstring_tolerates_a_field_with_no_terminator() {
        let buf: Vec<u16> = "abcd".encode_utf16().collect();
        assert_eq!(read_wstring(&buf), "abcd");
    }

    #[test]
    fn a_queue_reports_the_points_it_was_given() {
        let queue = ParamValueQueue::new(4);
        unsafe {
            queue.reset(7);
            assert!(queue.add_point(0, 0.25));
            assert!(queue.add_point(128, 0.75));

            assert_eq!(queue.getParameterId(), 7);
            assert_eq!(queue.getPointCount(), 2);

            let (mut offset, mut value) = (0i32, 0f64);
            assert_eq!(queue.getPoint(1, &mut offset, &mut value), kResultOk);
            assert_eq!((offset, value), (128, 0.75));
        }
    }

    #[test]
    fn a_queue_refuses_to_grow_past_its_capacity() {
        let queue = ParamValueQueue::new(2);
        unsafe {
            queue.reset(1);
            assert!(queue.add_point(0, 0.0));
            assert!(queue.add_point(1, 0.1));
            assert!(!queue.add_point(2, 0.2));
            assert_eq!(queue.getPointCount(), 2);
        }
    }

    #[test]
    fn resetting_a_queue_empties_it_without_dropping_its_capacity() {
        let queue = ParamValueQueue::new(2);
        unsafe {
            queue.reset(1);
            queue.add_point(0, 0.5);
            queue.reset(2);

            assert_eq!(queue.getParameterId(), 2);
            assert_eq!(queue.getPointCount(), 0);
            assert!(queue.add_point(0, 0.5), "capacity survived the reset");
        }
    }

    #[test]
    fn a_queue_rejects_an_out_of_range_index() {
        let queue = ParamValueQueue::new(4);
        unsafe {
            let (mut offset, mut value) = (0i32, 0f64);
            assert_ne!(queue.getPoint(0, &mut offset, &mut value), kResultOk);
            assert_ne!(queue.getPoint(-1, &mut offset, &mut value), kResultOk);
        }
    }

    // One queue per parameter is what VST3 asks for — two changes to the same
    // parameter must land in one queue, not two.
    #[test]
    fn changes_to_one_parameter_share_a_queue() {
        let changes = ParameterChanges::new(4, 8);
        unsafe {
            assert!(changes.add_point(3, 0, 0.1));
            assert!(changes.add_point(3, 64, 0.9));

            assert_eq!(changes.getParameterCount(), 1);

            let queue = borrowed(changes.getParameterData(0));
            assert_eq!(queue.getParameterId(), 3);
            assert_eq!(queue.getPointCount(), 2);
        }
    }

    #[test]
    fn changes_to_two_parameters_get_a_queue_each() {
        let changes = ParameterChanges::new(4, 8);
        unsafe {
            assert!(changes.add_point(3, 0, 0.1));
            assert!(changes.add_point(9, 0, 0.2));

            assert_eq!(changes.getParameterCount(), 2);
            for (index, expected) in [(0, 3u32), (1, 9u32)] {
                let queue = borrowed(changes.getParameterData(index));
                assert_eq!(queue.getParameterId(), expected);
            }
        }
    }

    #[test]
    fn parameter_changes_refuse_more_parameters_than_they_have_queues() {
        let changes = ParameterChanges::new(2, 8);
        unsafe {
            assert!(changes.add_point(1, 0, 0.1));
            assert!(changes.add_point(2, 0, 0.2));
            assert!(!changes.add_point(3, 0, 0.3));
            assert_eq!(changes.getParameterCount(), 2);
        }
    }

    #[test]
    fn clearing_parameter_changes_releases_every_queue() {
        let changes = ParameterChanges::new(2, 8);
        unsafe {
            changes.add_point(1, 0, 0.1);
            changes.add_point(2, 0, 0.2);
            changes.clear();

            assert_eq!(changes.getParameterCount(), 0);
            // The queues came back, and come back empty rather than carrying the
            // previous block's points.
            assert!(changes.add_point(5, 0, 0.5));
            let queue = borrowed(changes.getParameterData(0));
            assert_eq!(queue.getParameterId(), 5);
            assert_eq!(queue.getPointCount(), 1);
        }
    }

    #[test]
    fn parameter_changes_reject_an_out_of_range_index() {
        let changes = ParameterChanges::new(2, 8);
        unsafe {
            assert!(changes.getParameterData(0).is_null());
            changes.add_point(1, 0, 0.1);
            assert!(changes.getParameterData(1).is_null());
            assert!(changes.getParameterData(-1).is_null());
        }
    }

    #[test]
    fn the_host_names_itself() {
        let host = ComWrapper::new(HostApplication);
        let ptr = host.to_com_ptr::<IHostApplication>().unwrap();

        let mut name: String128 = [0; 128];
        unsafe {
            assert_eq!(ptr.getName(&mut name), kResultOk);
        }

        let len = name.iter().position(|c| *c == 0).unwrap();
        assert_eq!(String::from_utf16(&name[..len]).unwrap(), "Chord Composer");
    }
}
