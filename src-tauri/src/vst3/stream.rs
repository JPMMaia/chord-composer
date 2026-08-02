//! An in-memory `IBStream`, for reading and writing plugin state.
//!
//! `IComponent::getState` and `setState` are the only way to capture what a
//! plugin is set to, and both talk exclusively in streams. VST3 provides no
//! implementation, so the host has to supply one.

use std::cell::UnsafeCell;
use std::ffi::c_void;

use vst3::Steinberg::{
    int32, int64, kInvalidArgument, kResultOk, tresult, IBStream, IBStreamTrait, IBStream_,
};
use vst3::Class;

/// A growable byte buffer presented as a VST3 stream.
pub struct MemoryStream {
    inner: UnsafeCell<Inner>,
}

struct Inner {
    bytes: Vec<u8>,
    /// Read/write position. May sit at `bytes.len()`, meaning "at the end".
    cursor: usize,
}

// SAFETY: a stream is handed to exactly one plugin call at a time and never
// shared between threads. The COM machinery requires `Sync` regardless.
unsafe impl Sync for MemoryStream {}

impl MemoryStream {
    /// An empty stream, for a plugin to write its state into.
    pub fn empty() -> MemoryStream {
        MemoryStream::from_bytes(Vec::new())
    }

    /// A stream positioned at the start of `bytes`, for a plugin to read.
    pub fn from_bytes(bytes: Vec<u8>) -> MemoryStream {
        MemoryStream {
            inner: UnsafeCell::new(Inner { bytes, cursor: 0 }),
        }
    }

    /// Everything written so far.
    ///
    /// # Safety
    /// The caller must be the only one touching the stream — which, after the
    /// plugin call that filled it has returned, it is.
    pub unsafe fn take(&self) -> Vec<u8> {
        std::mem::take(&mut (*self.inner.get()).bytes)
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(&self, buffer: *mut c_void, num_bytes: int32, num_read: *mut int32) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let inner = &mut *self.inner.get();

        let available = inner.bytes.len().saturating_sub(inner.cursor);
        let count = available.min(num_bytes as usize);

        std::ptr::copy_nonoverlapping(
            inner.bytes[inner.cursor..].as_ptr(),
            buffer as *mut u8,
            count,
        );
        inner.cursor += count;

        // Null is legal and means the caller does not care how much it got.
        if !num_read.is_null() {
            *num_read = count as int32;
        }
        kResultOk
    }

    unsafe fn write(
        &self,
        buffer: *mut c_void,
        num_bytes: int32,
        num_written: *mut int32,
    ) -> tresult {
        if buffer.is_null() || num_bytes < 0 {
            return kInvalidArgument;
        }
        let inner = &mut *self.inner.get();
        let count = num_bytes as usize;

        // A write past the end extends the buffer; a write in the middle
        // overwrites. Both are legal for a seekable stream.
        let end = inner.cursor + count;
        if end > inner.bytes.len() {
            inner.bytes.resize(end, 0);
        }
        std::ptr::copy_nonoverlapping(
            buffer as *const u8,
            inner.bytes[inner.cursor..].as_mut_ptr(),
            count,
        );
        inner.cursor = end;

        if !num_written.is_null() {
            *num_written = count as int32;
        }
        kResultOk
    }

    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let inner = &mut *self.inner.get();
        let len = inner.bytes.len() as int64;

        let base = match mode {
            m if m == IBStream_::IStreamSeekMode_::kIBSeekSet as int32 => 0,
            m if m == IBStream_::IStreamSeekMode_::kIBSeekCur as int32 => inner.cursor as int64,
            m if m == IBStream_::IStreamSeekMode_::kIBSeekEnd as int32 => len,
            _ => return kInvalidArgument,
        };

        // Clamped rather than rejected: seeking past the end is how a plugin
        // asks for the stream to be extended by the next write.
        let target = (base + pos).clamp(0, len);
        inner.cursor = target as usize;

        if !result.is_null() {
            *result = target;
        }
        kResultOk
    }

    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if pos.is_null() {
            return kInvalidArgument;
        }
        *pos = (*self.inner.get()).cursor as int64;
        kResultOk
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst3::{ComWrapper, Interface};

    /// Drive the stream through its COM interface, as a plugin would.
    fn com(stream: MemoryStream) -> vst3::ComPtr<IBStream> {
        ComWrapper::new(stream).to_com_ptr::<IBStream>().unwrap()
    }

    fn write(s: &vst3::ComPtr<IBStream>, bytes: &[u8]) -> int32 {
        let mut written = 0;
        unsafe {
            assert_eq!(
                s.write(bytes.as_ptr() as *mut c_void, bytes.len() as int32, &mut written),
                kResultOk
            );
        }
        written
    }

    fn read(s: &vst3::ComPtr<IBStream>, count: usize) -> Vec<u8> {
        let mut buf = vec![0u8; count];
        let mut got = 0;
        unsafe {
            assert_eq!(
                s.read(buf.as_mut_ptr() as *mut c_void, count as int32, &mut got),
                kResultOk
            );
        }
        buf.truncate(got as usize);
        buf
    }

    fn seek(s: &vst3::ComPtr<IBStream>, pos: int64, mode: int32) -> int64 {
        let mut result = 0;
        unsafe {
            assert_eq!(s.seek(pos, mode, &mut result), kResultOk);
        }
        result
    }

    const SET: int32 = IBStream_::IStreamSeekMode_::kIBSeekSet;
    const CUR: int32 = IBStream_::IStreamSeekMode_::kIBSeekCur;
    const END: int32 = IBStream_::IStreamSeekMode_::kIBSeekEnd;

    #[test]
    fn writes_then_reads_back() {
        let stream = com(MemoryStream::empty());
        assert_eq!(write(&stream, b"hello"), 5);

        seek(&stream, 0, SET);
        assert_eq!(read(&stream, 5), b"hello");
    }

    #[test]
    fn reading_past_the_end_returns_what_is_there() {
        let stream = com(MemoryStream::from_bytes(b"ab".to_vec()));
        assert_eq!(read(&stream, 16), b"ab");
        // And nothing at all once exhausted.
        assert_eq!(read(&stream, 4), b"");
    }

    #[test]
    fn tracks_its_position() {
        let stream = com(MemoryStream::empty());
        write(&stream, b"abcdef");

        let mut pos = 0;
        unsafe {
            assert_eq!(stream.tell(&mut pos), kResultOk);
        }
        assert_eq!(pos, 6);
    }

    #[test]
    fn seeks_from_start_current_and_end() {
        let stream = com(MemoryStream::from_bytes(b"abcdef".to_vec()));

        assert_eq!(seek(&stream, 2, SET), 2);
        assert_eq!(read(&stream, 2), b"cd");

        assert_eq!(seek(&stream, -1, CUR), 3);
        assert_eq!(read(&stream, 1), b"d");

        assert_eq!(seek(&stream, 0, END), 6);
        assert_eq!(read(&stream, 1), b"");
    }

    #[test]
    fn a_seek_out_of_range_is_clamped_rather_than_failing() {
        let stream = com(MemoryStream::from_bytes(b"abc".to_vec()));
        assert_eq!(seek(&stream, 999, SET), 3);
        assert_eq!(seek(&stream, -999, SET), 0);
    }

    #[test]
    fn writing_in_the_middle_overwrites_without_truncating() {
        let stream = com(MemoryStream::empty());
        write(&stream, b"aaaa");
        seek(&stream, 1, SET);
        write(&stream, b"bb");

        seek(&stream, 0, SET);
        assert_eq!(read(&stream, 4), b"abba");
    }

    #[test]
    fn rejects_a_null_buffer() {
        let stream = com(MemoryStream::empty());
        unsafe {
            let mut n = 0;
            assert_eq!(stream.read(std::ptr::null_mut(), 4, &mut n), kInvalidArgument);
            assert_eq!(stream.write(std::ptr::null_mut(), 4, &mut n), kInvalidArgument);
        }
    }

    // A plugin is allowed to pass null when it does not care about the count.
    #[test]
    fn tolerates_a_null_count() {
        let stream = com(MemoryStream::empty());
        unsafe {
            let bytes = b"xy";
            assert_eq!(
                stream.write(bytes.as_ptr() as *mut c_void, 2, std::ptr::null_mut()),
                kResultOk
            );
        }
    }

    #[test]
    fn an_unknown_seek_mode_is_rejected() {
        let stream = com(MemoryStream::empty());
        unsafe {
            let mut result = 0;
            assert_eq!(stream.seek(0, 99, &mut result), kInvalidArgument);
        }
    }

    #[test]
    fn interface_id_is_the_vst3_one() {
        // Guards against the wrapper accidentally exposing the wrong interface.
        assert_eq!(IBStream::IID.len(), 16);
    }
}
