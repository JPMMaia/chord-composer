//! The COM objects a plugin expects its *host* to provide.
//!
//! A plugin is handed a context during `initialize` and asks it questions —
//! chiefly "who are you" and "make me one of these". Refusing to provide one at
//! all makes some plugins fail to load outright, so these are minimal but real.

use std::cell::UnsafeCell;
use std::ffi::c_void;

use vst3::Steinberg::Vst::{
    Event, IComponentHandler, IComponentHandlerTrait, IEventList, IEventListTrait, IHostApplication,
    IHostApplicationTrait, ParamID, ParamValue, String128, TChar,
};
use vst3::Steinberg::{int32, kNotImplemented, kResultOk, tresult, TUID};
use vst3::Class;

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

#[cfg(test)]
mod tests {
    use super::*;
    use vst3::Steinberg::Vst::Event_::EventTypes_::kNoteOnEvent;
    use vst3::ComWrapper;

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
