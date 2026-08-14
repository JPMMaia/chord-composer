//! Placing parameter changes on the stream's frame counter.
//!
//! The parameter twin of `events.rs`, and deliberately a separate module rather
//! than a third `EventKind`: a parameter change rides `inputParameterChanges`
//! rather than the event list, and the note scheduler's bookkeeping — which
//! pitches are sounding, offs sorting before ons — has nothing to say about it.
//!
//! Everything here runs on the audio thread and nothing in it allocates: the
//! buffer is sized once and a change that would overflow it is refused rather
//! than growing it.

use vst3::Steinberg::Vst::{ParamID, ParamValue};

/// One parameter change, placed on the stream's frame counter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamPoint {
    /// Absolute stream frame. May be in the past for a change that arrived late.
    pub frame: i64,
    pub id: ParamID,
    /// Normalised 0..=1, the range VST3 works in.
    pub value: ParamValue,
}

/// The pending parameter changes for one plugin.
pub struct ParamScheduler {
    /// Sorted by frame, and among equal frames in the order they were pushed.
    /// Never grows past its initial capacity.
    pending: Vec<ParamPoint>,
    /// Changes refused because the buffer was full, for diagnostics.
    dropped: u64,
}

impl ParamScheduler {
    /// `capacity` is the most changes that may be in flight at once, across
    /// every parameter. It bounds how far ahead the host may automate.
    pub fn new(capacity: usize) -> ParamScheduler {
        ParamScheduler {
            pending: Vec::with_capacity(capacity),
            dropped: 0,
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Queue one change. Returns false when the buffer is full.
    ///
    /// Unlike a note there is no pairing to preserve, so a refused change costs
    /// only that one breakpoint: the curve arrives a little coarser rather than
    /// leaving something stuck, which is why this can refuse singly where
    /// `Scheduler::schedule_note` has to refuse in twos.
    pub fn schedule(&mut self, id: ParamID, value: ParamValue, frame: i64) -> bool {
        if self.pending.len() == self.pending.capacity() {
            self.dropped += 1;
            return false;
        }

        // Sorted insert, keeping equal frames in push order: two changes to one
        // parameter on the same frame must resolve to the later one, and a queue
        // reports the last point it was given.
        let at = self.pending.partition_point(|p| p.frame <= frame);
        self.pending.insert(at, ParamPoint { frame, id, value });
        true
    }

    /// Abandon everything pending.
    ///
    /// Unlike [`super::events::Scheduler::stop_all`] this queues nothing in
    /// return. A note has to be released or it hangs; a parameter simply stays
    /// where the curve left it, which is what stopping mid-sweep should do —
    /// the host has no better value to put there than the plugin's own.
    pub fn clear(&mut self) {
        self.pending.clear();
    }

    /// Hand every change due before `block_end` to `emit`, as an offset into the
    /// block.
    ///
    /// A change from before `block_start` arrived late and is clamped to offset
    /// 0, exactly as [`super::events::Scheduler::take_due`] clamps a late note:
    /// applying it a fraction late is the only option once its moment has
    /// passed, and far better than dropping it.
    pub fn take_due<F: FnMut(u32, ParamID, ParamValue)>(
        &mut self,
        block_start: i64,
        block_end: i64,
        mut emit: F,
    ) {
        let count = self.pending.partition_point(|p| p.frame < block_end);

        for point in self.pending.drain(..count) {
            // Saturating, not plain subtraction: a late change's frame can sit
            // arbitrarily far behind the block start.
            let offset = point.frame.saturating_sub(block_start).max(0) as u32;
            emit(offset, point.id, point.value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect what a block would emit.
    fn due(s: &mut ParamScheduler, start: i64, end: i64) -> Vec<(u32, ParamID, ParamValue)> {
        let mut out = Vec::new();
        s.take_due(start, end, |offset, id, value| out.push((offset, id, value)));
        out
    }

    #[test]
    fn a_change_comes_out_at_its_offset_into_the_block() {
        let mut s = ParamScheduler::new(16);
        s.schedule(7, 0.25, 1_128);

        assert_eq!(due(&mut s, 1_000, 1_512), vec![(128, 7, 0.25)]);
    }

    #[test]
    fn changes_come_out_in_frame_order_whatever_order_they_arrived_in() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.9, 400);
        s.schedule(1, 0.1, 100);
        s.schedule(1, 0.5, 200);

        assert_eq!(
            due(&mut s, 0, 512),
            vec![(100, 1, 0.1), (200, 1, 0.5), (400, 1, 0.9)]
        );
    }

    // Two curves on one plugin interleave rather than being kept apart: the
    // block wants everything in frame order, and the queues are split later.
    #[test]
    fn two_parameters_interleave_by_frame() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.1, 300);
        s.schedule(2, 0.2, 100);

        assert_eq!(due(&mut s, 0, 512), vec![(100, 2, 0.2), (300, 1, 0.1)]);
    }

    // Same frame, same parameter: the later push must come out last, so that a
    // queue's final point is the one that wins.
    #[test]
    fn changes_on_one_frame_keep_the_order_they_were_pushed_in() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.1, 256);
        s.schedule(1, 0.2, 256);

        assert_eq!(due(&mut s, 0, 512), vec![(256, 1, 0.1), (256, 1, 0.2)]);
    }

    // Half-open, for the same reason the note scheduler's window is: consecutive
    // blocks share a boundary and a change landing on it belongs to exactly one.
    #[test]
    fn the_block_boundary_is_half_open() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.5, 512);

        assert!(due(&mut s, 0, 512).is_empty());
        assert_eq!(due(&mut s, 512, 1_024), vec![(0, 1, 0.5)]);
    }

    #[test]
    fn a_late_change_is_clamped_to_the_start_of_the_block() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.5, 10);

        assert_eq!(due(&mut s, 1_000, 1_512), vec![(0, 1, 0.5)]);
    }

    #[test]
    fn a_change_beyond_the_block_waits_for_its_own() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.5, 900);

        assert!(due(&mut s, 0, 512).is_empty());
        assert_eq!(s.pending_len(), 1);
        assert_eq!(due(&mut s, 512, 1_024), vec![(388, 1, 0.5)]);
    }

    #[test]
    fn a_full_scheduler_refuses_rather_than_growing() {
        let mut s = ParamScheduler::new(2);
        assert!(s.schedule(1, 0.1, 0));
        assert!(s.schedule(1, 0.2, 1));
        assert!(!s.schedule(1, 0.3, 2));

        assert_eq!(s.pending_len(), 2);
        assert_eq!(s.dropped(), 1);
    }

    // A stop abandons the curve and queues nothing in return — the parameter
    // stays where it was, unlike a note, which has to be released.
    #[test]
    fn clearing_abandons_everything_pending() {
        let mut s = ParamScheduler::new(16);
        s.schedule(1, 0.5, 100);
        s.clear();

        assert!(due(&mut s, 0, 512).is_empty());
    }
}
