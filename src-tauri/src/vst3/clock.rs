//! Placing events from the webview's clock onto the audio stream's clock.
//!
//! The app has two clocks and no way to merge them. Notes are scheduled against
//! the webview's `AudioContext.currentTime`, which is driven by whatever device
//! Web Audio opened. Plugins render on a cpal stream driven by a different
//! device. Two audio devices free-run against each other, so a fixed offset
//! measured once at startup drifts — enough to hear within a minute.
//!
//! So the offset is measured over and over: the webview sends its current time
//! periodically, and each message is one reading of how far ahead of it the
//! stream is.
//!
//! # Why the latest reading is not the best one
//!
//! A reading is taken in the webview and used in the audio callback, and the
//! journey between is a Tauri IPC hop onto a busy main thread. That delay is
//! never measured — by the time the audio thread pairs `host_time` with a frame,
//! the webview's clock has already moved on by however long the message took.
//!
//! The delay is therefore a *one-sided* error: it can only make the stream look
//! further ahead of the webview than it really is, never less far. Which means
//! the smallest offset ever observed is the most accurate one, and each reading
//! is evidence of an upper bound rather than a measurement. This is the same
//! reasoning a clock-synchronisation protocol uses on a round trip, and the same
//! conclusion: keep the best, not the last.
//!
//! Taking the last reading instead is what this module used to do, and the cost
//! was not subtle. The delay varies by four to nine milliseconds from one message
//! to the next on a busy frame, so the mapping moved by that much twice a second.
//! A note landing five milliseconds out is inaudible, but an automation curve
//! sampled every ten milliseconds is not: a mapping that jumps *backwards* by
//! half a grid step makes the next pass's points land behind the ones already
//! queued, and [`super::params::ParamScheduler`] then has to pull every one of
//! them forward onto a single sample to keep the curve from walking backwards.
//! Dozens of controller steps applied at one instant is a click, and the block
//! carrying them takes long enough to make the rest of the stream late too.
//!
//! # Drift still has to be tracked
//!
//! A minimum that only ever falls would eventually be wrong in the other
//! direction, because the two devices really are drifting apart. So the kept
//! offset is allowed to creep up by [`DRIFT_PER_SYNC`] each time: far more than
//! any crystal's error, far less than the jitter being rejected.

/// How far the kept offset may creep upward between readings.
///
/// Two audio devices drift by at most a few hundred parts per million, which over
/// a half-second sync interval is a fraction of a millisecond. This is generous
/// against that and still an order of magnitude below the IPC jitter it exists to
/// reject.
const DRIFT_PER_SYNC: f64 = 0.0005;

/// A reading this far from the kept offset is not jitter.
///
/// The webview's clock restarting — a new `AudioContext` — moves the offset by
/// however long the old one had been running, and no amount of creeping would
/// ever catch up with that. Past this, the reading is treated as a new reference
/// rather than as evidence about the old one.
const RESYNC_THRESHOLD: f64 = 1.0;

/// Converts host times to stream frames.
#[derive(Debug, Clone)]
pub struct Clock {
    sample_rate: f64,
    /// Seconds the stream's clock reads ahead of the webview's: the best estimate
    /// so far, not the most recent one. See the module comment.
    offset: Option<f64>,
}

impl Clock {
    pub fn new(sample_rate: f64) -> Clock {
        Clock {
            sample_rate,
            offset: None,
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
        self.offset.is_some()
    }

    /// The offset in use, for the trace. `None` before the first sync.
    pub fn offset(&self) -> Option<f64> {
        self.offset
    }

    /// Record that the webview clock read `host_time` when the stream was at
    /// `frame`, and answer with the offset now in use.
    ///
    /// Kept only if it is better than what is already known — smaller, or within
    /// the creep this sync is allowed. A reading further out than
    /// [`RESYNC_THRESHOLD`] replaces everything, because at that distance it is
    /// not the same clock any more.
    pub fn sync(&mut self, host_time: f64, frame: u64) -> f64 {
        let observed = frame as f64 / self.sample_rate - host_time;
        if !observed.is_finite() {
            return self.offset.unwrap_or(0.0);
        }

        let kept = match self.offset {
            None => observed,
            Some(kept) if (observed - kept).abs() > RESYNC_THRESHOLD => observed,
            // `min`, not the newer value: a late message inflates the offset and
            // can never deflate it, so the lower of the two is the honest one.
            Some(kept) => observed.min(kept + DRIFT_PER_SYNC),
        };

        self.offset = Some(kept);
        kept
    }

    /// Forget the mapping — used when the stream restarts and the frame counter
    /// no longer means what the offset says it means.
    pub fn reset(&mut self) {
        self.offset = None;
    }

    /// The stream frame an event at `host_time` belongs on.
    ///
    /// `None` before the first sync. The result may be *behind* the current
    /// frame if the event arrived late; that is the caller's problem to clamp,
    /// and is deliberately not hidden here — losing the distinction between
    /// "slightly late" and "on time" would hide a real scheduling failure.
    pub fn frame_for(&self, host_time: f64) -> Option<i64> {
        let offset = self.offset?;
        let at = (host_time + offset) * self.sample_rate;

        // A non-finite host time can only come from a bug or a hostile caller;
        // either way it must not be cast to an integer.
        if !at.is_finite() {
            return None;
        }

        Some(at.round() as i64)
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
    fn places_an_event_against_the_measured_offset() {
        let mut clock = Clock::new(SR);
        clock.sync(10.0, 480_000);

        // Exactly on the reading.
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

    // The whole point of the design: a reading delayed on its way here makes the
    // stream look further ahead than it is, and acting on it moves every future
    // event. The one that arrived promptly already said where the stream was, so
    // the mapping may move by the drift it is allowed and not by the delay.
    #[test]
    fn a_delayed_reading_barely_moves_the_mapping() {
        let mut clock = Clock::new(SR);
        // Prompt: the stream is one second ahead of the webview.
        clock.sync(10.0, (11.0 * SR) as u64);
        let placed = clock.frame_for(10.5).expect("synced");

        // Half a second later, a reading that spent 9 ms in transit: the webview
        // had really reached 10.509 by the time this was paired with a frame.
        clock.sync(10.5, (11.5 * SR) as u64 + (0.009 * SR) as u64);

        let moved = (clock.frame_for(10.5).expect("synced") - placed).abs();
        let creep = (DRIFT_PER_SYNC * SR).ceil() as i64;
        assert!(moved <= creep, "moved {moved} frames, creep is {creep}");
        // And nothing like the 432 frames the delay would have moved it.
        assert!(moved < (0.009 * SR) as i64 / 4);
    }

    // The converse, and what makes this a measurement rather than a filter: a
    // reading that implies a *smaller* offset can only be a more direct one.
    #[test]
    fn a_prompter_reading_is_taken_at_once() {
        let mut clock = Clock::new(SR);
        clock.sync(10.0, (11.009 * SR) as u64);
        clock.sync(10.5, (11.5 * SR) as u64);

        // The second reading says the stream is one second ahead, not 1.009.
        assert_eq!(clock.frame_for(11.0), Some((12.0 * SR) as i64));
    }

    // Rejecting jitter must not mean ignoring the drift the readings exist to
    // track. Sixty syncs is thirty seconds; the creep has to cover a real
    // divergence within a handful of them.
    #[test]
    fn the_offset_creeps_up_to_follow_a_drifting_device() {
        let mut clock = Clock::new(SR);
        clock.sync(0.0, 0);

        // The stream pulls 10 ms ahead, and says so on every sync from now on.
        for i in 1..=60 {
            let host = i as f64 * 0.5;
            clock.sync(host, ((host + 0.010) * SR) as u64);
        }

        let offset = clock.offset().expect("synced");
        assert!(offset > 0.009, "expected the drift to be followed, got {offset}");
    }

    // A single sync may not move the mapping by more than the creep, however far
    // out the reading is — that is what stops one busy frame in the webview from
    // pushing every queued event.
    #[test]
    fn one_reading_can_only_creep() {
        let mut clock = Clock::new(SR);
        clock.sync(0.0, 0);
        clock.sync(0.5, ((0.5 + 0.060) * SR) as u64);

        let offset = clock.offset().expect("synced");
        assert!(offset <= DRIFT_PER_SYNC + f64::EPSILON, "got {offset}");
    }

    // A new `AudioContext` starts its clock again from zero. No amount of
    // creeping would ever reach that, so it has to be recognised as a different
    // clock rather than as a very late message.
    #[test]
    fn a_restarted_webview_clock_is_taken_as_a_new_reference() {
        let mut clock = Clock::new(SR);
        clock.sync(600.0, (600.0 * SR) as u64);

        // The webview's clock restarts; the stream's counter does not.
        clock.sync(0.5, (600.5 * SR) as u64);

        assert_eq!(clock.frame_for(1.0), Some((601.0 * SR) as i64));
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

    // A reading that cannot be a reading must not become the mapping, or every
    // event after it is placed nowhere.
    #[test]
    fn a_non_finite_reading_is_ignored() {
        let mut clock = Clock::new(SR);
        clock.sync(1.0, SR as u64);
        let before = clock.offset();

        clock.sync(f64::NAN, SR as u64);

        assert_eq!(clock.offset(), before);
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
