//! Turning scheduled notes into the note-on/note-off pairs a plugin expects.
//!
//! The webview never sends a note-off. Its Web Audio backends are given a note
//! and a duration and handle the release themselves (`soundfontInstrument.ts`),
//! so the scheduler was built to describe a note as a single event with a
//! length. A VST3 plugin has no such notion — it needs the off as an event in
//! its own right — so the pair is synthesised here.
//!
//! Everything in this module runs on the audio thread. Nothing in it allocates:
//! the pending buffer is sized once and a schedule that would overflow it is
//! refused rather than growing.

/// A note-on or note-off, placed on the stream's frame counter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Event {
    /// Absolute stream frame. May be in the past for an event that arrived late.
    pub frame: i64,
    pub pitch: i16,
    pub kind: EventKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// Velocity is already normalised to 0..=1, the range VST3 works in.
    NoteOn { velocity: u8 },
    NoteOff,
}

impl EventKind {
    /// Off sorts before on, so that a note repeated on the same frame is
    /// released before it is struck again instead of being cut off by its own
    /// predecessor.
    fn order(&self) -> u8 {
        match self {
            EventKind::NoteOff => 0,
            EventKind::NoteOn { .. } => 1,
        }
    }
}

/// Anything scheduled at or before this frame is "immediately" — used for the
/// note-offs that a stop has to emit without knowing the current frame.
const IMMEDIATELY: i64 = i64::MIN;

/// The pending events for one plugin, and which of its notes are sounding.
pub struct Scheduler {
    /// Sorted by `(frame, kind)`. Never grows past its initial capacity.
    pending: Vec<Event>,
    /// Pitches currently held down, so a stop knows what to release.
    sounding: Vec<i16>,
    /// Events refused because the buffer was full, for diagnostics.
    dropped: u64,
}

impl Scheduler {
    /// `capacity` is the most events that may be in flight at once. Two per
    /// note, so it bounds how much the host may schedule ahead.
    pub fn new(capacity: usize) -> Scheduler {
        Scheduler {
            pending: Vec::with_capacity(capacity),
            // 128 MIDI pitches is the hard ceiling on simultaneously held notes.
            sounding: Vec::with_capacity(128),
            dropped: 0,
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Schedule a note as its on/off pair.
    ///
    /// Returns false when the buffer is full — both events are refused together,
    /// because half a note is worse than none: a note-on with no matching off
    /// sounds forever.
    pub fn schedule_note(
        &mut self,
        pitch: i16,
        velocity: u8,
        frame: i64,
        duration_frames: i64,
    ) -> bool {
        if self.pending.len() + 2 > self.pending.capacity() {
            self.dropped += 2;
            return false;
        }

        // A zero-length note still has to release, or it hangs. One frame is
        // the shortest thing the stream can express.
        let off_frame = frame.saturating_add(duration_frames.max(1));

        self.insert(Event {
            frame,
            pitch,
            kind: EventKind::NoteOn { velocity },
        });
        self.insert(Event {
            frame: off_frame,
            pitch,
            kind: EventKind::NoteOff,
        });
        true
    }

    /// Insert keeping `pending` sorted. Does not allocate: the caller has
    /// already checked there is room.
    fn insert(&mut self, event: Event) {
        let key = (event.frame, event.kind.order());
        let at = self
            .pending
            .partition_point(|e| (e.frame, e.kind.order()) <= key);
        self.pending.insert(at, event);
    }

    /// Abandon everything pending and release every sounding note.
    ///
    /// The offs are queued rather than returned so that they travel the same
    /// path as any other event and land in the next block the host renders.
    /// Relying on the plugin to honour CC 123 instead would be a gamble — not
    /// every plugin does.
    pub fn stop_all(&mut self) {
        self.pending.clear();

        // `sounding` is drained into `pending`, which was just emptied, so the
        // capacity is guaranteed to be there.
        for pitch in std::mem::take(&mut self.sounding) {
            self.pending.push(Event {
                frame: IMMEDIATELY,
                pitch,
                kind: EventKind::NoteOff,
            });
        }
        // Cleared above; restore the capacity `take` moved out.
        self.sounding.reserve(128);
    }

    /// Hand every event due before `block_end` to `emit`, as an offset into the
    /// block.
    ///
    /// `block_start` is the frame the block begins at. An event from before it
    /// arrived late and is clamped to offset 0 — playing it a fraction late is
    /// the only option once its moment has passed, and is far better than
    /// dropping it.
    pub fn take_due<F: FnMut(u32, Event)>(&mut self, block_start: i64, block_end: i64, mut emit: F) {
        let count = self.pending.partition_point(|e| e.frame < block_end);

        for event in self.pending.drain(..count) {
            // Saturating, not plain subtraction: the `IMMEDIATELY` sentinel a
            // stop uses is `i64::MIN`, which underflows against any block start.
            let offset = event.frame.saturating_sub(block_start).max(0) as u32;

            match event.kind {
                EventKind::NoteOn { .. } => {
                    if !self.sounding.contains(&event.pitch) {
                        self.sounding.push(event.pitch);
                    }
                }
                EventKind::NoteOff => {
                    self.sounding.retain(|p| *p != event.pitch);
                }
            }

            emit(offset, event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect what a block would emit.
    fn due(s: &mut Scheduler, start: i64, end: i64) -> Vec<(u32, Event)> {
        let mut out = Vec::new();
        s.take_due(start, end, |offset, e| out.push((offset, e)));
        out
    }

    fn on(velocity: u8) -> EventKind {
        EventKind::NoteOn { velocity }
    }

    #[test]
    fn a_note_becomes_an_on_and_an_off() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 1_000, 480);

        let events = due(&mut s, 0, 2_000);
        assert_eq!(
            events,
            vec![
                (1_000, Event { frame: 1_000, pitch: 60, kind: on(100) }),
                (1_480, Event { frame: 1_480, pitch: 60, kind: EventKind::NoteOff }),
            ]
        );
    }

    // Half-open, for the same reason `notesInWindow` is: consecutive blocks
    // share a boundary, and an event landing on it must belong to exactly one.
    #[test]
    fn the_block_boundary_is_half_open() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 512, 100);

        assert!(due(&mut s, 0, 512).is_empty(), "512 belongs to the next block");
        assert_eq!(due(&mut s, 512, 1_024).len(), 2);
    }

    #[test]
    fn an_event_is_emitted_as_an_offset_into_its_block() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 1_100, 10);

        let events = due(&mut s, 1_024, 1_536);
        assert_eq!(events[0].0, 76);
    }

    // Once an event's moment has passed, late is the only option left; dropping
    // it would silently lose a note.
    #[test]
    fn a_late_event_is_clamped_to_the_start_of_the_block() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 900, 10);

        let events = due(&mut s, 1_024, 1_536);
        assert_eq!(events[0].0, 0);
    }

    #[test]
    fn events_come_out_in_frame_order_however_they_went_in() {
        let mut s = Scheduler::new(16);
        s.schedule_note(64, 100, 2_000, 10);
        s.schedule_note(60, 100, 1_000, 10);
        s.schedule_note(62, 100, 1_500, 10);

        let frames: Vec<i64> = due(&mut s, 0, 4_000).iter().map(|(_, e)| e.frame).collect();
        let mut sorted = frames.clone();
        sorted.sort();
        assert_eq!(frames, sorted);
    }

    // Otherwise the repeat's note-on is immediately cancelled by the previous
    // note's note-off, and the second note never sounds.
    #[test]
    fn an_off_precedes_an_on_that_lands_on_the_same_frame() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 0, 480);
        s.schedule_note(60, 100, 480, 480);

        let events = due(&mut s, 0, 1_000);
        let at_480: Vec<EventKind> = events
            .iter()
            .filter(|(_, e)| e.frame == 480)
            .map(|(_, e)| e.kind)
            .collect();

        assert_eq!(at_480, vec![EventKind::NoteOff, on(100)]);
    }

    #[test]
    fn a_zero_length_note_still_releases() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 100, 0);

        let events = due(&mut s, 0, 1_000);
        assert_eq!(events.len(), 2);
        assert!(events[1].1.frame > events[0].1.frame, "the off must follow the on");
    }

    #[test]
    fn stop_releases_every_sounding_note() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 0, 48_000);
        s.schedule_note(64, 100, 0, 48_000);
        // Sound them, leaving their offs far in the future.
        assert_eq!(due(&mut s, 0, 512).len(), 2);

        s.stop_all();

        let events = due(&mut s, 512, 1_024);
        let mut pitches: Vec<i16> = events.iter().map(|(_, e)| e.pitch).collect();
        pitches.sort();

        assert_eq!(pitches, vec![60, 64]);
        assert!(events.iter().all(|(offset, e)| *offset == 0 && e.kind == EventKind::NoteOff));
    }

    #[test]
    fn stop_abandons_notes_that_had_not_sounded_yet() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 100_000, 480);

        s.stop_all();

        assert_eq!(s.pending_len(), 0);
        assert!(due(&mut s, 0, 200_000).is_empty());
    }

    #[test]
    fn a_second_stop_has_nothing_left_to_release() {
        let mut s = Scheduler::new(16);
        s.schedule_note(60, 100, 0, 48_000);
        due(&mut s, 0, 512);

        s.stop_all();
        assert_eq!(due(&mut s, 512, 1_024).len(), 1);

        s.stop_all();
        assert!(due(&mut s, 1_024, 2_048).is_empty());
    }

    // A note-on with no matching off sounds forever, so the pair is refused
    // together or not at all.
    #[test]
    fn a_full_buffer_refuses_a_whole_note_rather_than_half_of_one() {
        let mut s = Scheduler::new(2);
        assert!(s.schedule_note(60, 100, 0, 10));
        assert!(!s.schedule_note(64, 100, 0, 10));

        assert_eq!(s.pending_len(), 2);
        assert_eq!(s.dropped(), 2);

        let events = due(&mut s, 0, 1_000);
        assert!(events.iter().all(|(_, e)| e.pitch == 60));
    }

    // The audio thread must not allocate. Capacity never moving is the property
    // that guarantees it.
    #[test]
    fn scheduling_never_grows_the_buffer() {
        let mut s = Scheduler::new(64);
        let capacity = s.pending.capacity();

        for i in 0..32 {
            assert!(s.schedule_note(60 + (i % 12) as i16, 100, i as i64 * 100, 50));
        }
        s.stop_all();
        due(&mut s, 0, 100_000);

        assert_eq!(s.pending.capacity(), capacity);
    }
}
