//! Placing events from the webview's clock onto the audio stream's clock.
//!
//! The app has two clocks and no way to merge them. Notes are scheduled against
//! the webview's `AudioContext.currentTime`, which is driven by whatever device
//! Web Audio opened. Plugins render on a cpal stream driven by a different
//! device. Two audio devices free-run against each other, so a fixed offset
//! measured once at startup drifts — enough to hear within a minute.
//!
//! So the offset is never fixed. The webview sends its current time
//! periodically, each message re-anchoring the mapping against the stream's
//! sample counter as it stands right then. Because notes are only ever placed a
//! fraction of a second ahead, an event is always converted against an anchor
//! that is at most one sync interval old, and error cannot accumulate: it stays
//! bounded by the one-way IPC latency, which is around a millisecond and
//! inaudible.

/// A measured correspondence between the two clocks.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Anchor {
    /// The webview's clock reading, in seconds.
    host_time: f64,
    /// The stream's frame counter at the moment that reading arrived.
    frame: u64,
}

/// Converts host times to stream frames.
#[derive(Debug, Clone)]
pub struct Clock {
    sample_rate: f64,
    anchor: Option<Anchor>,
}

impl Clock {
    pub fn new(sample_rate: f64) -> Clock {
        Clock {
            sample_rate,
            anchor: None,
        }
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Whether a mapping has been established yet.
    ///
    /// Before the first sync there is no way to place an event, and guessing
    /// would put notes in the wrong place rather than merely late.
    pub fn is_synced(&self) -> bool {
        self.anchor.is_some()
    }

    /// Record that the webview clock read `host_time` when the stream was at
    /// `frame`. Replaces any previous anchor outright.
    ///
    /// Deliberately not smoothed or filtered. Smoothing trades a bounded error
    /// for a lagging one, and the raw measurement is already good to about a
    /// millisecond.
    pub fn sync(&mut self, host_time: f64, frame: u64) {
        self.anchor = Some(Anchor { host_time, frame });
    }

    /// Forget the mapping — used when the stream restarts and the frame counter
    /// no longer means what the anchor says it means.
    pub fn reset(&mut self) {
        self.anchor = None;
    }

    /// The stream frame an event at `host_time` belongs on.
    ///
    /// `None` before the first sync. The result may be *behind* the current
    /// frame if the event arrived late; that is the caller's problem to clamp,
    /// and is deliberately not hidden here — losing the distinction between
    /// "slightly late" and "on time" would hide a real scheduling failure.
    pub fn frame_for(&self, host_time: f64) -> Option<i64> {
        let anchor = self.anchor?;
        let delta = (host_time - anchor.host_time) * self.sample_rate;

        // A non-finite host time can only come from a bug or a hostile caller;
        // either way it must not be cast to an integer.
        if !delta.is_finite() {
            return None;
        }

        Some(anchor.frame as i64 + delta.round() as i64)
    }

    /// How many frames long `seconds` is. Used to turn a note's duration into
    /// the offset of its note-off.
    pub fn frames_in(&self, seconds: f64) -> i64 {
        if !seconds.is_finite() || seconds <= 0.0 {
            return 0;
        }
        (seconds * self.sample_rate).round() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    #[test]
    fn places_nothing_before_the_first_sync() {
        let clock = Clock::new(SR);
        assert!(!clock.is_synced());
        assert_eq!(clock.frame_for(1.0), None);
    }

    #[test]
    fn places_an_event_relative_to_the_anchor() {
        let mut clock = Clock::new(SR);
        clock.sync(10.0, 480_000);

        // Exactly on the anchor.
        assert_eq!(clock.frame_for(10.0), Some(480_000));
        // A quarter second later is 12000 frames later.
        assert_eq!(clock.frame_for(10.25), Some(492_000));
    }

    // An event whose time has already passed must stay distinguishable from one
    // that is on time; clamping is the caller's decision, not the clock's.
    #[test]
    fn reports_a_late_event_as_a_frame_in_the_past() {
        let mut clock = Clock::new(SR);
        clock.sync(10.0, 480_000);

        assert_eq!(clock.frame_for(9.9), Some(480_000 - 4_800));
    }

    // The whole point of the design: re-anchoring means error never builds up,
    // however far the two devices have drifted apart in the meantime.
    #[test]
    fn a_later_sync_absorbs_drift_rather_than_accumulating_it() {
        let mut clock = Clock::new(SR);
        clock.sync(0.0, 0);

        // Ten minutes on, the stream has run 30ms fast relative to the webview.
        let drifted_frame = (600.0 * SR) as u64 + 1_440;
        clock.sync(600.0, drifted_frame);

        // An event 100ms out is still placed 100ms out — from where the stream
        // actually is, not from where the original anchor predicted.
        assert_eq!(clock.frame_for(600.1), Some(drifted_frame as i64 + 4_800));
    }

    #[test]
    fn reset_forgets_the_mapping() {
        let mut clock = Clock::new(SR);
        clock.sync(1.0, 100);
        clock.reset();

        assert!(!clock.is_synced());
        assert_eq!(clock.frame_for(1.0), None);
    }

    #[test]
    fn rejects_a_non_finite_host_time() {
        let mut clock = Clock::new(SR);
        clock.sync(0.0, 0);

        assert_eq!(clock.frame_for(f64::NAN), None);
        assert_eq!(clock.frame_for(f64::INFINITY), None);
    }

    #[test]
    fn converts_a_duration_to_frames() {
        let clock = Clock::new(SR);
        assert_eq!(clock.frames_in(0.5), 24_000);
        assert_eq!(clock.frames_in(1.0 / 3.0), 16_000);
    }

    // A zero or negative duration is a degenerate note, not a note that plays
    // backwards; it must not produce a note-off before its note-on.
    #[test]
    fn a_non_positive_duration_is_zero_frames() {
        let clock = Clock::new(SR);
        assert_eq!(clock.frames_in(0.0), 0);
        assert_eq!(clock.frames_in(-1.0), 0);
        assert_eq!(clock.frames_in(f64::NAN), 0);
    }

    #[test]
    fn honours_a_non_standard_sample_rate() {
        let mut clock = Clock::new(44_100.0);
        clock.sync(0.0, 0);
        assert_eq!(clock.frame_for(1.0), Some(44_100));
        assert_eq!(clock.frames_in(2.0), 88_200);
    }
}
