//! The COM objects a plugin expects its *host* to provide.
//!
//! A plugin is handed a context during `initialize` and asks it questions —
//! chiefly "who are you" and "make me one of these". Refusing to provide one at
//! all makes some plugins fail to load outright, so these are minimal but real.

use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use vst3::Steinberg::Vst::IAttributeList_::AttrID;
use vst3::Steinberg::Vst::{
    Event, IAttributeList, IAttributeListTrait, IComponentHandler, IComponentHandlerTrait,
    IConnectionPoint, IConnectionPointTrait, IEventList, IEventListTrait, IHostApplication,
    IHostApplicationTrait, IMessage, IMessageTrait, IParamValueQueue, IParamValueQueueTrait,
    IParameterChanges, IParameterChangesTrait, ParamID, ParamValue, String128, TChar,
};
use vst3::Steinberg::{
    int32, int64, kInvalidArgument, kNotImplemented, kResultFalse, kResultOk, tresult, uint32,
    FIDString, TUID,
};
use vst3::{Class, ComPtr, ComWrapper, Interface};

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

/// How often plugins have called back into the host, by kind.
///
/// Counted rather than traced where they happen: these arrive from the plugin's
/// own threads, the audio thread among them, and a plugin that makes one of
/// these calls per parameter change makes it fifty times a second. A relaxed add
/// is the only thing cheap enough to stand in their way.
///
/// [`REFUSED_INSTANCES`] is the one that says something about this host rather
/// than about the plugin. Every real host answers `createInstance` with a
/// message or attribute-list object and this one does not, so a plugin that
/// needs one — to tell its own editor that a parameter moved, typically — is a
/// plugin doing something else instead. A count that tracks the parameter
/// changes being sent is that something.
pub static REFUSED_INSTANCES: AtomicU64 = AtomicU64::new(0);

/// Parameter edits the plugin's own UI made, through [`ComponentHandler`].
pub static PARAM_EDITS: AtomicU64 = AtomicU64::new(0);

/// Times a plugin has asked the host to reconsider something about it.
pub static RESTARTS: AtomicU64 = AtomicU64::new(0);

/// Messages a plugin has sent from one of its halves to the other, through the
/// [`ConnectionProxy`] that sits between them.
pub static MESSAGES: AtomicU64 = AtomicU64::new(0);

/// The counts since this was last called, and reset.
///
/// Read destructively so the figures describe one interval rather than the whole
/// session, which is what makes a rate out of them.
pub fn take_callback_counts() -> (u64, u64, u64, u64) {
    (
        REFUSED_INSTANCES.swap(0, Ordering::Relaxed),
        PARAM_EDITS.swap(0, Ordering::Relaxed),
        RESTARTS.swap(0, Ordering::Relaxed),
        MESSAGES.swap(0, Ordering::Relaxed),
    )
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
    /// The two a plugin actually asks for are provided: a message, and the
    /// attribute list it carries. Those are what the component and the
    /// controller send each other, and a plugin that cannot have one does
    /// something else instead of saying so.
    ///
    /// Anything else is still declined, and counted — see [`REFUSED_INSTANCES`],
    /// which is how an unmet need shows up at all.
    unsafe fn createInstance(
        &self,
        cid: *mut TUID,
        iid: *mut TUID,
        obj: *mut *mut c_void,
    ) -> tresult {
        if cid.is_null() || iid.is_null() || obj.is_null() {
            return kInvalidArgument;
        }
        *obj = ptr::null_mut();

        // Both ids are asked for and both are the interface's own: VST3 has no
        // separate class id for either of these, so the class a plugin names is
        // the interface it wants.
        if names::<IMessage>(cid) && names::<IMessage>(iid) {
            if let Some(message) = ComWrapper::new(HostMessage::new()).to_com_ptr::<IMessage>() {
                // The reference goes to the caller, which releases it when done.
                *obj = message.into_raw() as *mut c_void;
                return kResultOk;
            }
        }

        if names::<IAttributeList>(cid) && names::<IAttributeList>(iid) {
            if let Some(list) =
                ComWrapper::new(HostAttributeList::new()).to_com_ptr::<IAttributeList>()
            {
                *obj = list.into_raw() as *mut c_void;
                return kResultOk;
            }
        }

        REFUSED_INSTANCES.fetch_add(1, Ordering::Relaxed);
        kNotImplemented
    }
}

/// Whether the `TUID` at `id` names interface `I`.
///
/// A `TUID` is sixteen signed bytes and an `Interface::IID` sixteen unsigned
/// ones, so the two cannot be compared until something says that a byte is a
/// byte.
unsafe fn names<I: Interface>(id: *const TUID) -> bool {
    *(id as *const [u8; 16]) == I::IID
}

/// One attribute of a message, in whichever of VST3's four kinds it was set as.
///
/// Which kind matters: a plugin that sets an integer and reads a float gets a
/// refusal rather than a reinterpreted bit pattern, which is what the SDK's own
/// implementation does and what a plugin's round trip through it relies on.
///
/// The payloads are boxed rather than held inline because `getBinary` hands out a
/// pointer *into* what is stored, and the map may rehash while the plugin still
/// holds it. Rehashing moves a `Vec`'s three words; it never moves the heap block
/// a `Box` names.
enum Attribute {
    Int(int64),
    Float(f64),
    /// UTF-16 and NUL-terminated, exactly as `setString` was given it.
    Text(Box<[TChar]>),
    Binary(Box<[u8]>),
}

/// The attribute list a [`HostMessage`] carries.
///
/// VST3 names attributes with C strings and offers no way to enumerate them, so a
/// map keyed by the name is the whole of the data structure.
///
/// Behind a `Mutex` rather than an `UnsafeCell`, unlike everything else in this
/// file: the event list and the parameter changes belong to the audio thread
/// alone, while a message is filled in on whichever thread the plugin chose and
/// read on whichever thread it is delivered to.
pub struct HostAttributeList {
    attributes: Mutex<HashMap<CString, Attribute>>,
}

impl HostAttributeList {
    pub fn new() -> HostAttributeList {
        HostAttributeList {
            attributes: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for HostAttributeList {
    fn default() -> HostAttributeList {
        HostAttributeList::new()
    }
}

/// An attribute name, or `None` for the null a plugin must not pass but might.
unsafe fn attribute_key(id: AttrID) -> Option<CString> {
    if id.is_null() {
        return None;
    }
    Some(CStr::from_ptr(id).to_owned())
}

impl Class for HostAttributeList {
    type Interfaces = (IAttributeList,);
}

impl IAttributeListTrait for HostAttributeList {
    unsafe fn setInt(&self, id: AttrID, value: int64) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        self.attributes.lock().unwrap().insert(key, Attribute::Int(value));
        kResultOk
    }

    unsafe fn getInt(&self, id: AttrID, value: *mut int64) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        if value.is_null() {
            return kInvalidArgument;
        }
        match self.attributes.lock().unwrap().get(&key) {
            // Matched through the reference rather than under it, so `found` is
            // the value and not a borrow of the map this guard is about to drop.
            Some(&Attribute::Int(found)) => {
                *value = found;
                kResultOk
            }
            // Absent and present-as-another-kind are both "not this", which is
            // all a caller can act on either way.
            _ => kResultFalse,
        }
    }

    unsafe fn setFloat(&self, id: AttrID, value: f64) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        self.attributes.lock().unwrap().insert(key, Attribute::Float(value));
        kResultOk
    }

    unsafe fn getFloat(&self, id: AttrID, value: *mut f64) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        if value.is_null() {
            return kInvalidArgument;
        }
        match self.attributes.lock().unwrap().get(&key) {
            Some(&Attribute::Float(found)) => {
                *value = found;
                kResultOk
            }
            _ => kResultFalse,
        }
    }

    unsafe fn setString(&self, id: AttrID, string: *const TChar) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        if string.is_null() {
            return kInvalidArgument;
        }

        // Read to its NUL and stored with one, so `getString` can always hand
        // back something a plugin may treat as a string however short the buffer.
        let mut text = Vec::new();
        let mut at = string;
        while *at != 0 {
            text.push(*at);
            at = at.add(1);
        }
        text.push(0);

        self.attributes
            .lock()
            .unwrap()
            .insert(key, Attribute::Text(text.into_boxed_slice()));
        kResultOk
    }

    /// `size_in_bytes` is bytes, and a `TChar` is two of them.
    unsafe fn getString(&self, id: AttrID, string: *mut TChar, size_in_bytes: uint32) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        let room = size_in_bytes as usize / std::mem::size_of::<TChar>();
        if string.is_null() || room == 0 {
            return kInvalidArgument;
        }

        let attributes = self.attributes.lock().unwrap();
        let Some(Attribute::Text(text)) = attributes.get(&key) else {
            return kResultFalse;
        };

        // One short of the room, so the terminator always fits. A truncated
        // string is much better than one the caller reads off the end of.
        let copied = text.len().min(room) - 1;
        ptr::copy_nonoverlapping(text.as_ptr(), string, copied);
        *string.add(copied) = 0;
        kResultOk
    }

    unsafe fn setBinary(&self, id: AttrID, data: *const c_void, size_in_bytes: uint32) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        if data.is_null() && size_in_bytes > 0 {
            return kInvalidArgument;
        }

        let bytes = std::slice::from_raw_parts(data as *const u8, size_in_bytes as usize).to_vec();
        self.attributes
            .lock()
            .unwrap()
            .insert(key, Attribute::Binary(bytes.into_boxed_slice()));
        kResultOk
    }

    /// Hands out a pointer into what is stored rather than a copy, which is what
    /// the interface asks for: the list owns the bytes and outlives the call.
    unsafe fn getBinary(
        &self,
        id: AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut uint32,
    ) -> tresult {
        let Some(key) = attribute_key(id) else {
            return kInvalidArgument;
        };
        if data.is_null() || size_in_bytes.is_null() {
            return kInvalidArgument;
        }

        let attributes = self.attributes.lock().unwrap();
        let Some(Attribute::Binary(bytes)) = attributes.get(&key) else {
            return kResultFalse;
        };

        *data = bytes.as_ptr() as *const c_void;
        *size_in_bytes = bytes.len() as uint32;
        kResultOk
    }
}

/// What a plugin sends from one of its halves to the other.
///
/// Created on demand through [`HostApplication::createInstance`], because a
/// plugin has no way to make one for itself: the message and the attribute list
/// it carries are the *host's* classes, and a host that will not provide them is
/// a host the two halves cannot talk across.
pub struct HostMessage {
    id: Mutex<CString>,
    /// Kept alive for as long as the message is, because `getAttributes` answers
    /// with a borrowed pointer to it.
    _attributes: ComWrapper<HostAttributeList>,
    /// That pointer, taken once here. Building one per call would touch the COM
    /// refcount on whichever thread asked and leak a reference every time, since
    /// the interface hands none over.
    handle: Option<ComPtr<IAttributeList>>,
}

// SAFETY: the name is behind a `Mutex` and the attribute list is itself `Sync`;
// a message crosses threads by design, which is the whole reason it exists.
unsafe impl Send for HostMessage {}
unsafe impl Sync for HostMessage {}

impl HostMessage {
    pub fn new() -> HostMessage {
        let attributes = ComWrapper::new(HostAttributeList::new());
        let handle = attributes.to_com_ptr::<IAttributeList>();

        HostMessage {
            // Unnamed until the plugin says otherwise, which it always does.
            id: Mutex::new(CString::default()),
            _attributes: attributes,
            handle,
        }
    }
}

impl Default for HostMessage {
    fn default() -> HostMessage {
        HostMessage::new()
    }
}

impl Class for HostMessage {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for HostMessage {
    /// A pointer into the stored name, which stays put until `setMessageID`
    /// replaces it — the same lifetime the SDK's own message gives it.
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.lock().unwrap().as_ptr()
    }

    unsafe fn setMessageID(&self, id: FIDString) {
        let named = if id.is_null() {
            CString::default()
        } else {
            CStr::from_ptr(id).to_owned()
        };
        *self.id.lock().unwrap() = named;
    }

    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        match &self.handle {
            Some(handle) => handle.as_ptr(),
            None => ptr::null_mut(),
        }
    }
}

/// The host's seat between a plugin's two halves.
///
/// VST3 has the component and the controller talk over `IConnectionPoint`, and
/// says the host should interpose an object of its own rather than wiring the two
/// to each other. The host is the only party that knows which thread a message
/// arrived on, and a controller's notify handler belongs on the UI thread rather
/// than inside `process`.
///
/// This forwards, as Steinberg's own reference host does, and counts — see
/// [`MESSAGES`]. The count is the point: moving a message to another thread means
/// copying it, and the copy is only worth its cost once a plugin is actually
/// sending from the audio thread. Until this object existed there was no way to
/// find out whether any plugin here sends one at all.
pub struct ConnectionProxy {
    peer: ComPtr<IConnectionPoint>,
}

// SAFETY: the peer is one half of a plugin, which VST3 requires to be callable
// from the thread the other half sends on.
unsafe impl Send for ConnectionProxy {}
unsafe impl Sync for ConnectionProxy {}

impl ConnectionProxy {
    /// Forward to `peer`, the half on the far side of this proxy.
    pub fn to(peer: ComPtr<IConnectionPoint>) -> ConnectionProxy {
        ConnectionProxy { peer }
    }
}

impl Class for ConnectionProxy {
    type Interfaces = (IConnectionPoint,);
}

impl IConnectionPointTrait for ConnectionProxy {
    /// The host made this connection and holds both ends already, so a plugin
    /// naming its peer again changes nothing. Accepted rather than refused: a
    /// plugin is entitled to be told its own wiring is in place.
    unsafe fn connect(&self, _other: *mut IConnectionPoint) -> tresult {
        kResultOk
    }

    unsafe fn disconnect(&self, _other: *mut IConnectionPoint) -> tresult {
        kResultOk
    }

    unsafe fn notify(&self, message: *mut IMessage) -> tresult {
        MESSAGES.fetch_add(1, Ordering::Relaxed);
        self.peer.notify(message)
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
        PARAM_EDITS.fetch_add(1, Ordering::Relaxed);
        kResultOk
    }

    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }

    unsafe fn restartComponent(&self, _flags: int32) -> tresult {
        RESTARTS.fetch_add(1, Ordering::Relaxed);
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

    /// A UTF-16 NUL-terminated buffer, as `setString` is given one.
    fn wide(text: &str) -> Vec<TChar> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // The round trip a plugin's two halves rely on: whatever one side set, the
    // other reads back unchanged.
    #[test]
    fn an_attribute_list_returns_each_kind_as_it_was_set() {
        let list = HostAttributeList::new();
        let count = c"count";
        let level = c"level";
        let name = c"name";
        let blob = c"blob";

        unsafe {
            assert_eq!(list.setInt(count.as_ptr(), -7), kResultOk);
            assert_eq!(list.setFloat(level.as_ptr(), 0.25), kResultOk);
            assert_eq!(list.setString(name.as_ptr(), wide("héllo").as_ptr()), kResultOk);
            assert_eq!(list.setBinary(blob.as_ptr(), [1u8, 2, 3].as_ptr() as *const c_void, 3), kResultOk);

            let mut found_int = 0i64;
            assert_eq!(list.getInt(count.as_ptr(), &mut found_int), kResultOk);
            assert_eq!(found_int, -7);

            let mut found_float = 0.0f64;
            assert_eq!(list.getFloat(level.as_ptr(), &mut found_float), kResultOk);
            assert_eq!(found_float, 0.25);

            let mut text: [TChar; 16] = [0; 16];
            assert_eq!(list.getString(name.as_ptr(), text.as_mut_ptr(), 32), kResultOk);
            assert_eq!(read_wstring(&text), "héllo");

            let mut data: *const c_void = ptr::null();
            let mut size = 0u32;
            assert_eq!(list.getBinary(blob.as_ptr(), &mut data, &mut size), kResultOk);
            assert_eq!(size, 3);
            assert_eq!(std::slice::from_raw_parts(data as *const u8, 3), [1, 2, 3]);
        }
    }

    // Reinterpreting the bits of one kind as another would hand a plugin a
    // plausible-looking lie; saying "not that" is the only honest answer.
    #[test]
    fn an_attribute_read_as_the_wrong_kind_is_refused() {
        let list = HostAttributeList::new();
        let count = c"count";

        unsafe {
            list.setInt(count.as_ptr(), 3);

            let mut found = 0.0f64;
            assert_eq!(list.getFloat(count.as_ptr(), &mut found), kResultFalse);
            assert_eq!(found, 0.0, "nothing is written on a refusal");
        }
    }

    #[test]
    fn an_absent_attribute_is_refused_rather_than_invented() {
        let list = HostAttributeList::new();
        unsafe {
            let mut found = 0i64;
            assert_eq!(list.getInt(c"missing".as_ptr(), &mut found), kResultFalse);
        }
    }

    // A plugin is entitled to treat what it gets back as a string, so the
    // terminator has to fit even when the text does not.
    #[test]
    fn a_string_too_long_for_the_buffer_is_truncated_and_still_terminated() {
        let list = HostAttributeList::new();
        let name = c"name";

        unsafe {
            list.setString(name.as_ptr(), wide("abcdef").as_ptr());

            // Room for four `TChar`s, so three characters and the NUL.
            let mut text: [TChar; 4] = [9; 4];
            assert_eq!(list.getString(name.as_ptr(), text.as_mut_ptr(), 8), kResultOk);

            assert_eq!(read_wstring(&text), "abc");
            assert_eq!(text[3], 0);
        }
    }

    #[test]
    fn an_attribute_with_no_name_is_rejected_rather_than_stored() {
        let list = HostAttributeList::new();
        unsafe {
            assert_eq!(list.setInt(ptr::null(), 1), kInvalidArgument);
            assert_eq!(list.setFloat(ptr::null(), 1.0), kInvalidArgument);
        }
    }

    // The two halves of a message: what it is called, and what it carries.
    #[test]
    fn a_message_carries_a_name_and_an_attribute_list() {
        let message = HostMessage::new();

        unsafe {
            assert!(!message.getAttributes().is_null());

            message.setMessageID(c"kGainChanged".as_ptr());
            assert_eq!(CStr::from_ptr(message.getMessageID()).to_str().unwrap(), "kGainChanged");
        }
    }

    #[test]
    fn a_message_starts_unnamed_rather_than_null() {
        let message = HostMessage::new();
        unsafe {
            assert_eq!(CStr::from_ptr(message.getMessageID()).to_bytes(), b"");
        }
    }

    // The gap this closes: a plugin cannot make either of these for itself, and a
    // host that refuses to is a host whose plugins cannot talk across their halves.
    #[test]
    fn the_host_provides_the_message_objects_a_plugin_asks_for() {
        let host = HostApplication;
        REFUSED_INSTANCES.store(0, Ordering::Relaxed);

        for wanted in [as_tuid(&IMessage::IID), as_tuid(&IAttributeList::IID)] {
            let mut cid = wanted;
            let mut iid = wanted;
            let mut obj: *mut c_void = ptr::null_mut();

            unsafe {
                assert_eq!(host.createInstance(&mut cid, &mut iid, &mut obj), kResultOk);
                assert!(!obj.is_null());
                // The reference was handed over, so this test owns it.
                drop(ComPtr::<IMessage>::from_raw(obj as *mut IMessage));
            }
        }

        assert_eq!(REFUSED_INSTANCES.load(Ordering::Relaxed), 0);
    }

    // Anything else is still declined — and counted, because a need this host
    // cannot meet shows up nowhere else.
    #[test]
    fn an_unknown_class_is_declined_and_counted() {
        let host = HostApplication;
        REFUSED_INSTANCES.store(0, Ordering::Relaxed);

        let mut cid = as_tuid(&IHostApplication::IID);
        let mut iid = cid;
        let mut obj: *mut c_void = ptr::null_mut();

        unsafe {
            assert_eq!(host.createInstance(&mut cid, &mut iid, &mut obj), kNotImplemented);
            assert!(obj.is_null());
        }

        assert_eq!(REFUSED_INSTANCES.load(Ordering::Relaxed), 1);
    }

    /// An interface id as the `TUID` a plugin would pass it as.
    fn as_tuid(iid: &[u8; 16]) -> TUID {
        let mut out: TUID = [0; 16];
        for (byte, slot) in iid.iter().zip(out.iter_mut()) {
            *slot = *byte as std::ffi::c_char;
        }
        out
    }

    /// What [`Peer`] has been notified of. A static rather than a field, because
    /// the proxy takes the only handle to the peer it forwards to.
    static PEER_NOTIFIED: AtomicU64 = AtomicU64::new(0);

    /// A connection point that only records that it was reached.
    struct Peer;

    impl Class for Peer {
        type Interfaces = (IConnectionPoint,);
    }

    impl IConnectionPointTrait for Peer {
        unsafe fn connect(&self, _other: *mut IConnectionPoint) -> tresult {
            kResultOk
        }
        unsafe fn disconnect(&self, _other: *mut IConnectionPoint) -> tresult {
            kResultOk
        }
        unsafe fn notify(&self, _message: *mut IMessage) -> tresult {
            PEER_NOTIFIED.fetch_add(1, Ordering::Relaxed);
            kResultOk
        }
    }

    // The proxy's whole job for now: nothing is lost on the way through, and the
    // host can say how much went through it.
    #[test]
    fn the_connection_proxy_forwards_to_the_far_half_and_counts() {
        let peer = ComWrapper::new(Peer);
        let proxy = ConnectionProxy::to(peer.to_com_ptr::<IConnectionPoint>().unwrap());

        MESSAGES.store(0, Ordering::Relaxed);
        PEER_NOTIFIED.store(0, Ordering::Relaxed);

        let message = ComWrapper::new(HostMessage::new());
        let handed = message.to_com_ptr::<IMessage>().unwrap();

        unsafe {
            assert_eq!(proxy.notify(handed.as_ptr()), kResultOk);
            assert_eq!(proxy.notify(handed.as_ptr()), kResultOk);
        }

        assert_eq!(PEER_NOTIFIED.load(Ordering::Relaxed), 2);
        assert_eq!(MESSAGES.load(Ordering::Relaxed), 2);
    }
}
