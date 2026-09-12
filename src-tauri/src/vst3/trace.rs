//! A log of everything this host hands a plugin.
//!
//! When a plugin plays the wrong note, plays it at the wrong moment, or plays
//! nothing at all, the question is always the same: what did we actually send
//! it, and when. Nothing else in the app can answer that. The webview knows
//! what it *asked* for, the audio thread converts it against a clock that moves
//! underneath it, and the plugin itself is a black box.
//!
//! So a note is traced at each of the three points it passes through, and the
//! three lines together are the answer:
//!
//! * `schedule` — what the webview asked for, on the webview's clock.
//! * `placed` — the stream frame that moment converted to.
//! * `note-on` / `note-off` — the VST3 event handed to the plugin, at the
//!   sample offset into the block it was handed in.
//!
//! Off unless `CHORD_COMPOSER_VST3_LOG` is set, and off costs one relaxed
//! atomic load at each trace point.
//!
//! # Turning it on
//!
//! ```powershell
//! $env:CHORD_COMPOSER_VST3_LOG = "1"                  # to the console
//! $env:CHORD_COMPOSER_VST3_LOG = "C:\temp\vst3.log"   # appended to a file
//! npm run tauri dev
//! ```
//!
//! A note being sounded then reads:
//!
//! ```text
//!    12.104  vst3  schedule      track=piano slot=0 pitch=60 vel=100 when=25.7220 dur=0.4800
//!    12.105  vst3  placed        track=piano slot=0 pitch=60 (C4) vel=100 when=25.7220 ... frame=1234688 at=25.7227s len=23040
//!    12.110  vst3  note-on       track=piano slot=0 pitch=60 (C4) vel=0.787 offset=128 frame=1234688 at=25.7227s
//!    12.110  vst3  process       track=piano slot=0 frames=512 block=1234560 at=25.7200s events=1 params=0 result=0
//! ```
//!
//! The leading column is seconds since the log opened — wall clock, and the
//! only thing in a line that is not the audio stream's own time.
//!
//! # A fault that builds rather than one that happens
//!
//! The lines above each describe one moment, which is the wrong shape for the
//! other kind of audio fault: the one that is inaudible for a minute and
//! unbearable after five. So two more are written once a second, and are read by
//! their slope rather than their value.
//!
//! * `health` — what each plugin is holding (queued notes, queued parameter
//!   changes, pitches still down) and what its `process` cost. A count that only
//!   goes up is a leak; a cost that only goes up is a plugin being asked to do
//!   more every minute.
//! * `load` — what a whole callback cost against the deadline it had, which is
//!   the time the frames it produced take to play. `late` counts the callbacks
//!   that overran, and every one of those has already been heard.
//! * `callbacks` — the same interval seen from the other side: what the plugins
//!   asked of the host. A plugin that cannot get something it needs rarely says
//!   so; it does something more expensive instead, and how often it keeps asking
//!   is the only sign.
//!
//! # Not on the audio thread
//!
//! The audio thread may not allocate, lock or block, and formatting a line does
//! all three. So the audio side pushes fixed-size [`Record`]s onto a lock-free
//! queue — `try_lock`ing the producer, so that even a lock held by something
//! unexpected costs a dropped line rather than a glitch — and a drain thread
//! does the formatting and the writing.
//!
//! Lines produced off the audio thread are staged separately and merged with
//! the queue by timestamp before writing, so the log reads in the order things
//! happened rather than in the order they were formatted.

use std::collections::HashMap;
use std::fmt::Arguments;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rtrb::{Consumer, Producer, RingBuffer};

/// Where the log goes, and whether there is one at all.
///
/// `off`/`0` or unset for no log, `1`/`on`/`stderr` for the console, and
/// anything else for a file path to append to.
pub const LOG_VAR: &str = "CHORD_COMPOSER_VST3_LOG";

/// How many records may wait to be formatted.
///
/// A block carrying a chord is a dozen records and blocks come a hundred times
/// a second, so this is several seconds of headroom at the drain interval
/// below.
const RING_CAPACITY: usize = 4096;

/// How many control-side lines may wait to be written, in case the drain
/// thread has stopped and nothing is emptying them.
const STAGED_LIMIT: usize = 16_384;

/// How often the drain thread writes what it has.
///
/// Long enough that it costs nothing, short enough that a log being watched
/// live still feels live.
const DRAIN_INTERVAL: Duration = Duration::from_millis(50);

/// How long [`flush`] waits for the drain thread to catch up. A few intervals,
/// and short enough that a thread which has already stopped costs a quit a
/// blink.
const FLUSH_WAIT: Duration = Duration::from_millis(250);

/// Read at every trace point, so a run with the log off pays one relaxed load
/// and nothing else.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// The audio thread's end of the queue.
///
/// Behind a `Mutex` only because a `Producer` is not `Sync`; the audio thread
/// is the one thread that ever takes it, and it takes it with `try_lock`.
static PRODUCER: Mutex<Option<Producer<(Instant, Record)>>> = Mutex::new(None);

static STATE: OnceLock<State> = OnceLock::new();

/// Everything the drain thread and the control side share.
struct State {
    /// What every timestamp in the log is measured from.
    started: Instant,
    /// `f64` bits. Re-read on each engine start, because the rate is the
    /// device's and the next device need not run at the same one.
    sample_rate: AtomicU64,
    out: Mutex<Box<dyn Write + Send>>,
    /// Lines formatted off the audio thread, waiting to be merged in.
    staged: Mutex<Vec<(Instant, String)>>,
    /// Which track sits in each engine slot, so a record carrying a slot can be
    /// written with the name the user knows it by.
    ///
    /// Never pruned: a record already queued still has to be formattable after
    /// its plugin has gone, and a slot reused by another track overwrites the
    /// entry anyway.
    labels: Mutex<HashMap<u32, String>>,
    /// Records the queue had no room for.
    lost: AtomicU64,
    /// How many times the drain thread has written what it had. Counted so that
    /// [`flush`] can tell that everything recorded before it was called has
    /// been written, without sharing the queue with the thread that reads it.
    passes: AtomicU64,
}

/// One thing sent to a plugin, in a form the audio thread can produce without
/// allocating.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Record {
    /// A scheduled note converted onto the stream clock.
    Placed {
        slot: u32,
        pitch: i16,
        velocity: u8,
        /// The webview clock reading it was asked for at.
        host_time: f64,
        duration: f64,
        frame: i64,
        duration_frames: i64,
        /// False when the scheduler was full and refused the pair.
        accepted: bool,
    },
    /// A note dropped because no clock anchor has arrived yet.
    Unanchored {
        slot: u32,
        pitch: i16,
        host_time: f64,
    },
    /// A parameter change converted onto the stream clock. `host_time` is
    /// absent for a change stated for the next block rather than scheduled.
    ParamPlaced {
        slot: u32,
        id: u32,
        value: f64,
        host_time: Option<f64>,
        frame: i64,
        accepted: bool,
    },
    /// A parameter change dropped for want of a clock anchor.
    ParamUnanchored {
        slot: u32,
        id: u32,
        host_time: f64,
    },
    /// A note-on in the event list handed to the plugin.
    NoteOn {
        slot: u32,
        pitch: i16,
        /// Normalised, exactly as the plugin receives it.
        velocity: f32,
        /// Samples into the block.
        offset: u32,
        frame: i64,
    },
    /// A note-off in the event list handed to the plugin.
    NoteOff {
        slot: u32,
        pitch: i16,
        offset: u32,
        frame: i64,
    },
    /// A point in the parameter changes handed to the plugin.
    ParamPoint {
        slot: u32,
        id: u32,
        value: f64,
        offset: u32,
        frame: i64,
    },
    /// One `process` call that carried something or took too long, what it
    /// returned, and what it cost.
    ///
    /// `spent_us` is what makes this the line a dropout is read off: `health` says
    /// some block in the last second was slow, and only this says *which* block
    /// and what was in it.
    Process {
        slot: u32,
        frames: usize,
        block_start: i64,
        events: usize,
        params: usize,
        result: i32,
        spent_us: u64,
    },
    /// The clock took a reading: the webview read `host_time` when the stream
    /// stood at `frame`, having waited `waited` seconds on the queue.
    ///
    /// `observed` is the offset that reading implies and `kept` the one now in
    /// use. They differ whenever the reading was late, which is most of the time
    /// and is the whole reason [`super::clock::Clock`] keeps the best rather than
    /// the last — the gap between these two columns is the jitter being rejected.
    Anchor {
        host_time: f64,
        frame: i64,
        waited: f64,
        observed: f64,
        kept: f64,
    },
    /// A scheduler refused work, or pulled a change forward. Reported when the
    /// counts move, because both are silent failures otherwise.
    Overflow {
        slot: u32,
        notes: u64,
        params: u64,
        reordered: u64,
        /// Points a block's parameter queues had no room for.
        queue_full: u64,
    },
    /// What one plugin is holding, and what it cost, over the last interval.
    ///
    /// The record for a fault that *builds*: a queue that only grows, a note-off
    /// that never came, a `process` call that takes longer every minute. None of
    /// those is visible in a single block, which is why they need a line of
    /// their own rather than another column on `process`.
    Health {
        slot: u32,
        /// Note events still waiting to be handed over.
        notes_pending: u32,
        /// Pitches the plugin is holding down. A count that climbs and never
        /// comes back down is a note-off that was never sent.
        notes_sounding: u32,
        /// Parameter changes still waiting to be handed over.
        params_pending: u32,
        /// How many `process` calls the figures below cover.
        blocks: u64,
        /// Time spent inside `process`, summed and at its worst.
        process_total_us: u64,
        process_max_us: u64,
    },
    /// What the whole callback cost over the last interval.
    ///
    /// A block has a deadline — the time the frames in it take to play — and
    /// overrunning it is what a dropout *is*. Measured across every plugin at
    /// once, because they are rendered one after another on the one thread.
    Load {
        /// How many callbacks the figures below cover.
        callbacks: u64,
        /// Frames rendered in them, so the deadline is derivable.
        frames: u64,
        render_total_us: u64,
        render_max_us: u64,
        /// Callbacks that took longer than the frames they produced will play
        /// for. Every one of these is a dropout.
        late: u64,
    },
    /// What the plugins asked of the host over the last interval.
    ///
    /// The other direction, and the one nothing else records. A plugin that
    /// cannot get something it needs from its host does not usually say so; it
    /// does something more expensive instead, and the only sign is how often it
    /// keeps asking.
    Callbacks {
        /// `createInstance` calls this host refused. See `host::REFUSED_INSTANCES`.
        refused_instances: u64,
        /// Parameter edits the plugin's own UI made.
        param_edits: u64,
        restarts: u64,
        /// Messages one half of a plugin sent the other, through the host's
        /// connection proxy.
        messages: u64,
    },
}

/// Whether anything is being logged.
#[inline]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Open the log, if the environment asks for one, and start draining it.
///
/// Called wherever a plugin might be about to be rendered — the audio engine
/// starting, or a plugin being loaded for an offline render — because either
/// is the start of something worth logging. Everything after the first call
/// only re-states the sample rate, so the queue and the thread reading it are
/// the process's, not any one engine's.
pub fn start(sample_rate: f64) {
    let state = match STATE.get() {
        Some(state) => state,
        None => {
            let Some(out) = sink_from_env() else {
                return;
            };
            STATE.get_or_init(|| State {
                started: Instant::now(),
                sample_rate: AtomicU64::new(sample_rate.to_bits()),
                out: Mutex::new(out),
                staged: Mutex::new(Vec::new()),
                labels: Mutex::new(HashMap::new()),
                lost: AtomicU64::new(0),
                passes: AtomicU64::new(0),
            })
        }
    };

    state
        .sample_rate
        .store(sample_rate.to_bits(), Ordering::Relaxed);
    ENABLED.store(true, Ordering::Relaxed);

    let mut producer = PRODUCER.lock().unwrap();
    if producer.is_some() {
        return;
    }
    let (tx, rx) = RingBuffer::new(RING_CAPACITY);
    *producer = Some(tx);
    // Released before the thread is spawned, so that an audio thread already
    // rendering is held up for as little as possible — and `emit` only ever
    // tries for this lock, so even that costs a line rather than a block.
    drop(producer);

    std::thread::spawn(move || drain(rx));

    log(
        "start",
        format_args!("sample-rate={sample_rate} ring={RING_CAPACITY}"),
    );
}

/// Wait for everything recorded so far to reach the log.
///
/// The drain thread writes on an interval and dies with the process, so a quit
/// otherwise takes the last interval's worth of records with it — which is
/// exactly the part of the log that matters when the thing being diagnosed is
/// the quit.
///
/// Bounded, and never fatal: a drain thread that has stopped costs the quit a
/// blink rather than hanging it.
pub fn flush() {
    if !enabled() {
        return;
    }
    let Some(state) = STATE.get() else {
        return;
    };

    // Two passes, not one: a pass may already have been under way when this was
    // called, and it may have collected its batch before the last record was
    // pushed. The pass after it is the first that is guaranteed to have seen it.
    let wanted = state.passes.load(Ordering::Relaxed) + 2;
    let deadline = Instant::now() + FLUSH_WAIT;

    while state.passes.load(Ordering::Relaxed) < wanted {
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Record one thing sent to a plugin. Safe to call from the audio thread.
pub fn emit(record: Record) {
    if !enabled() {
        return;
    }
    let stamped = (Instant::now(), record);

    // `try_lock`, never `lock`. Nothing but the audio thread takes this, so it
    // succeeds in practice — and if it ever did not, a diagnostic must lose a
    // line rather than block the callback.
    let Ok(mut guard) = PRODUCER.try_lock() else {
        lost();
        return;
    };
    match guard.as_mut() {
        Some(tx) => {
            if tx.push(stamped).is_err() {
                lost();
            }
        }
        None => lost(),
    }
}

/// Write one line from a thread that is allowed to allocate.
///
/// `kind` is the first column and `args` the rest. Neither is formatted when
/// the log is off, which is what makes a call site free then.
pub fn log(kind: &str, args: Arguments<'_>) {
    if !enabled() {
        return;
    }
    let Some(state) = STATE.get() else {
        return;
    };

    let mut staged = state.staged.lock().unwrap();
    if staged.len() >= STAGED_LIMIT {
        return;
    }
    staged.push((Instant::now(), line(kind, args)));
}

/// Say which track occupies an engine slot, so records carrying that slot can
/// be written with the track's name.
pub fn label(slot: u32, track: &str) {
    if !enabled() {
        return;
    }
    if let Some(state) = STATE.get() {
        state.labels.lock().unwrap().insert(slot, track.to_string());
    }
}

fn lost() {
    if let Some(state) = STATE.get() {
        state.lost.fetch_add(1, Ordering::Relaxed);
    }
}

/// Where the log goes, or nowhere at all.
enum Sink<'a> {
    Off,
    Stderr,
    File(&'a str),
}

/// Read the variable. Split out from opening anything so it can be tested.
fn sink_of(value: &str) -> Sink<'_> {
    let trimmed = value.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "" | "0" | "off" | "false" | "no" => Sink::Off,
        "1" | "on" | "true" | "yes" | "stderr" => Sink::Stderr,
        _ => Sink::File(trimmed),
    }
}

fn sink_from_env() -> Option<Box<dyn Write + Send>> {
    let value = std::env::var(LOG_VAR).ok()?;

    match sink_of(&value) {
        Sink::Off => None,
        Sink::Stderr => Some(Box::new(std::io::stderr())),
        // Appended to rather than truncated: the run before this one is
        // usually the run that went wrong.
        Sink::File(path) => match std::fs::OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => Some(Box::new(file)),
            Err(err) => {
                eprintln!("vst3: cannot write the trace to {path}: {err}; using stderr");
                Some(Box::new(std::io::stderr()))
            }
        },
    }
}

/// Format, merge and write, for as long as the process runs.
///
/// Deliberately not tied to an engine's life: a plugin can be rendered without
/// one, and a log that stopped when the audio device was let go would end
/// exactly where a device problem becomes interesting.
fn drain(mut rx: Consumer<(Instant, Record)>) {
    let Some(state) = STATE.get() else {
        return;
    };
    let mut batch: Vec<(Instant, String)> = Vec::new();

    loop {
        // Re-read each pass rather than once: the rate belongs to the output
        // device, and the next device need not run at the same one.
        let sample_rate = f64::from_bits(state.sample_rate.load(Ordering::Relaxed));

        while let Ok((at, record)) = rx.pop() {
            let track = state
                .labels
                .lock()
                .unwrap()
                .get(&record.slot())
                .cloned()
                .unwrap_or_else(|| "?".to_string());
            batch.push((at, render(&record, &track, sample_rate)));
        }

        batch.append(&mut state.staged.lock().unwrap());

        let lost = state.lost.swap(0, Ordering::Relaxed);
        if lost > 0 {
            batch.push((
                Instant::now(),
                line("lost", format_args!("records={lost} (the queue was full)")),
            ));
        }

        if !batch.is_empty() {
            // The two sources are collected a moment apart, so sorting is what
            // puts the log back into the order things actually happened.
            batch.sort_by_key(|(at, _)| *at);

            let mut out = state.out.lock().unwrap();
            for (at, text) in batch.drain(..) {
                let seconds = at.duration_since(state.started).as_secs_f64();
                let _ = writeln!(out, "{seconds:>9.3}  vst3  {text}");
            }
            let _ = out.flush();
        }

        // Counted after the writing, so a `flush` that sees this has seen the
        // records that went with it.
        state.passes.fetch_add(1, Ordering::Relaxed);

        std::thread::sleep(DRAIN_INTERVAL);
    }
}

impl Record {
    /// The slot this record concerns, for looking up the track's name. The
    /// clock belongs to no plugin, so it answers with a slot nothing is ever
    /// labelled with.
    fn slot(&self) -> u32 {
        match *self {
            Record::Placed { slot, .. }
            | Record::Unanchored { slot, .. }
            | Record::ParamPlaced { slot, .. }
            | Record::ParamUnanchored { slot, .. }
            | Record::NoteOn { slot, .. }
            | Record::NoteOff { slot, .. }
            | Record::ParamPoint { slot, .. }
            | Record::Process { slot, .. }
            | Record::Overflow { slot, .. }
            | Record::Health { slot, .. } => slot,
            // Neither belongs to a plugin: the clock is the stream's, and the
            // load is every plugin's at once.
            Record::Anchor { .. } | Record::Load { .. } | Record::Callbacks { .. } => u32::MAX,
        }
    }
}

/// One line's worth of columns, without the timestamp.
fn line(kind: &str, args: Arguments<'_>) -> String {
    format!("{kind:<13} {args}")
}

/// Render a record as the body of a line.
///
/// Pure, so that the format is testable without a running engine.
fn render(record: &Record, track: &str, sample_rate: f64) -> String {
    // Every frame is given as a time as well, because a frame count answers
    // "in what order" and only a time answers "when".
    let at = |frame: i64| frame as f64 / sample_rate;

    // Rendered once here and ignored in the arms below, so that a plugin with
    // no slot — one being rendered offline, or the clock, which belongs to no
    // plugin at all — reads as a dash rather than as four billion.
    let slot = match record.slot() {
        u32::MAX => "-".to_string(),
        slot => slot.to_string(),
    };

    match *record {
        Record::Placed {
            slot: _,
            pitch,
            velocity,
            host_time,
            duration,
            frame,
            duration_frames,
            accepted,
        } => line(
            "placed",
            format_args!(
                "track={track} slot={slot} pitch={pitch} ({}) vel={velocity} \
                 when={host_time:.4} dur={duration:.4} frame={frame} at={:.4}s \
                 len={duration_frames}{}",
                note_name(pitch),
                at(frame),
                if accepted { "" } else { " REFUSED=scheduler-full" }
            ),
        ),
        Record::Unanchored {
            slot: _,
            pitch,
            host_time,
        } => line(
            "dropped",
            format_args!(
                "track={track} slot={slot} pitch={pitch} when={host_time:.4} \
                 reason=no-clock-anchor"
            ),
        ),
        Record::ParamPlaced {
            slot: _,
            id,
            value,
            host_time,
            frame,
            accepted,
        } => line(
            "placed-param",
            format_args!(
                "track={track} slot={slot} param={id} value={value:.6} when={} \
                 frame={frame} at={:.4}s{}",
                match host_time {
                    Some(host_time) => format!("{host_time:.4}"),
                    None => "now".to_string(),
                },
                at(frame),
                if accepted { "" } else { " REFUSED=scheduler-full" }
            ),
        ),
        Record::ParamUnanchored {
            slot: _,
            id,
            host_time,
        } => line(
            "dropped-param",
            format_args!(
                "track={track} slot={slot} param={id} when={host_time:.4} \
                 reason=no-clock-anchor"
            ),
        ),
        Record::NoteOn {
            slot: _,
            pitch,
            velocity,
            offset,
            frame,
        } => line(
            "note-on",
            format_args!(
                "track={track} slot={slot} pitch={pitch} ({}) vel={velocity:.3} \
                 offset={offset} frame={frame} at={:.4}s",
                note_name(pitch),
                at(frame)
            ),
        ),
        Record::NoteOff {
            slot: _,
            pitch,
            offset,
            frame,
        } => line(
            "note-off",
            format_args!(
                "track={track} slot={slot} pitch={pitch} ({}) offset={offset} \
                 frame={frame} at={:.4}s",
                note_name(pitch),
                at(frame)
            ),
        ),
        Record::ParamPoint {
            slot: _,
            id,
            value,
            offset,
            frame,
        } => line(
            "param",
            format_args!(
                "track={track} slot={slot} param={id} value={value:.6} \
                 offset={offset} frame={frame} at={:.4}s",
                at(frame)
            ),
        ),
        Record::Process {
            slot: _,
            frames,
            block_start,
            events,
            params,
            result,
            spent_us,
        } => line(
            "process",
            format_args!(
                "track={track} slot={slot} frames={frames} block={block_start} \
                 at={:.4}s events={events} params={params} result={result} \
                 spent={spent_us}us{}{}",
                at(block_start),
                if result == 0 { "" } else { " FAILED" },
                // The deadline is this block's own frames: once the call takes
                // longer than they take to play, the stream cannot keep ahead of
                // the device and the gap is heard.
                if (spent_us as f64) > frames as f64 / sample_rate * 1e6 {
                    " OVER"
                } else {
                    ""
                }
            ),
        ),
        Record::Anchor {
            host_time,
            frame,
            waited,
            observed,
            kept,
        } => line(
            "anchor",
            format_args!(
                "host={host_time:.4} frame={frame} at={:.4}s waited={waited:.4} \
                 observed={observed:.6} kept={kept:.6} rejected={:.1}ms",
                at(frame),
                (observed - kept) * 1000.0
            ),
        ),
        Record::Overflow {
            slot: _,
            notes,
            params,
            reordered,
            queue_full,
        } => line(
            "overflow",
            format_args!(
                "track={track} slot={slot} notes-dropped={notes} \
                 params-dropped={params} params-reordered={reordered} \
                 queue-full={queue_full}"
            ),
        ),
        Record::Health {
            slot: _,
            notes_pending,
            notes_sounding,
            params_pending,
            blocks,
            process_total_us,
            process_max_us,
        } => line(
            "health",
            format_args!(
                "track={track} slot={slot} notes-pending={notes_pending} \
                 sounding={notes_sounding} params-pending={params_pending} \
                 blocks={blocks} process-avg={:.0}us process-max={process_max_us}us",
                mean(process_total_us, blocks)
            ),
        ),
        Record::Load {
            callbacks,
            frames,
            render_total_us,
            render_max_us,
            late,
        } => line(
            "load",
            format_args!(
                "callbacks={callbacks} frames={frames} render-avg={:.0}us \
                 render-max={render_max_us}us budget={:.0}us late={late}{}",
                mean(render_total_us, callbacks),
                // The deadline one callback had: what the frames it produced
                // take to play. A render time anywhere near it is a dropout
                // waiting for the next busy moment.
                mean((frames as f64 / sample_rate * 1e6) as u64, callbacks),
                if late > 0 { " LATE" } else { "" }
            ),
        ),
        Record::Callbacks {
            refused_instances,
            param_edits,
            restarts,
            messages,
        } => line(
            "callbacks",
            format_args!(
                "refused-instances={refused_instances} param-edits={param_edits} \
                 restarts={restarts} messages={messages}"
            ),
        ),
    }
}

/// An average that answers zero rather than dividing by it.
fn mean(total: u64, count: u64) -> f64 {
    if count == 0 {
        return 0.0;
    }
    total as f64 / count as f64
}

/// A MIDI pitch as a name, because 61 and 73 are not distinguishable at a
/// glance and C#4 and C#5 are.
fn note_name(pitch: i16) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    if !(0..128).contains(&pitch) {
        return "?".to_string();
    }
    // The convention the app's own keyboard uses: middle C, pitch 60, is C4.
    format!("{}{}", NAMES[pitch as usize % 12], pitch / 12 - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    #[test]
    fn the_log_is_off_unless_it_is_asked_for() {
        assert!(matches!(sink_of(""), Sink::Off));
        assert!(matches!(sink_of("0"), Sink::Off));
        assert!(matches!(sink_of("off"), Sink::Off));
        assert!(matches!(sink_of("OFF"), Sink::Off));
    }

    #[test]
    fn a_switch_goes_to_the_console_and_anything_else_to_a_file() {
        assert!(matches!(sink_of("1"), Sink::Stderr));
        assert!(matches!(sink_of("stderr"), Sink::Stderr));

        match sink_of(" C:\\logs\\vst3.log ") {
            Sink::File(path) => assert_eq!(path, "C:\\logs\\vst3.log"),
            _ => panic!("a path is a path"),
        }
    }

    // The line a plugin's behaviour is actually read off: what it was sent,
    // where in the block, and at what moment on the stream's own clock.
    #[test]
    fn a_note_on_carries_pitch_velocity_offset_and_time() {
        let text = render(
            &Record::NoteOn {
                slot: 0,
                pitch: 60,
                velocity: 0.787,
                offset: 128,
                frame: 96_128,
            },
            "piano",
            SR,
        );

        assert!(text.starts_with("note-on"), "got {text}");
        assert!(text.contains("track=piano"));
        assert!(text.contains("pitch=60 (C4)"));
        assert!(text.contains("vel=0.787"));
        assert!(text.contains("offset=128"));
        assert!(text.contains("at=2.0027s"), "got {text}");
    }

    // Both clocks on one line is the whole point of `placed`: it is the only
    // place the webview's time and the stream frame appear together.
    #[test]
    fn a_placed_note_shows_the_webview_time_and_the_frame_it_became() {
        let text = render(
            &Record::Placed {
                slot: 1,
                pitch: 64,
                velocity: 100,
                host_time: 25.722,
                duration: 0.48,
                frame: 1_234_688,
                duration_frames: 23_040,
                accepted: true,
            },
            "strings",
            SR,
        );

        assert!(text.contains("when=25.7220"));
        assert!(text.contains("frame=1234688"));
        assert!(text.contains("len=23040"));
        assert!(!text.contains("REFUSED"));
    }

    #[test]
    fn a_refused_note_says_so() {
        let text = render(
            &Record::Placed {
                slot: 0,
                pitch: 60,
                velocity: 100,
                host_time: 1.0,
                duration: 0.5,
                frame: 48_000,
                duration_frames: 24_000,
                accepted: false,
            },
            "piano",
            SR,
        );

        assert!(text.contains("REFUSED=scheduler-full"), "got {text}");
    }

    #[test]
    fn an_untimed_parameter_change_reads_as_now() {
        let text = render(
            &Record::ParamPlaced {
                slot: 0,
                id: 7,
                value: 0.25,
                host_time: None,
                frame: 4_096,
                accepted: true,
            },
            "piano",
            SR,
        );

        assert!(text.contains("when=now"), "got {text}");
        assert!(text.contains("param=7"));
    }

    // A non-zero result is the difference between "the plugin had nothing to
    // say" and "the host is holding it wrong", so it must not be quiet.
    #[test]
    fn a_failing_process_call_is_marked() {
        let ok = render(
            &Record::Process {
                slot: 0,
                frames: 512,
                block_start: 0,
                events: 2,
                params: 0,
                result: 0,
                spent_us: 120,
            },
            "piano",
            SR,
        );
        let bad = render(
            &Record::Process {
                slot: 0,
                frames: 512,
                block_start: 0,
                events: 2,
                params: 0,
                result: -1,
                spent_us: 120,
            },
            "piano",
            SR,
        );

        assert!(!ok.contains("FAILED"));
        assert!(bad.contains("FAILED"));
        assert!(ok.contains("spent=120us"));
    }

    // The line a dropout is actually found on: which block overran, and what was
    // in it. 512 frames at 48 kHz have 10.6 ms to be produced in.
    #[test]
    fn a_block_that_took_longer_than_it_plays_for_is_marked() {
        let over = render(
            &Record::Process {
                slot: 0,
                frames: 512,
                block_start: 0,
                events: 6,
                params: 1,
                result: 0,
                spent_us: 40_000,
            },
            "harp",
            SR,
        );
        let under = render(
            &Record::Process {
                slot: 0,
                frames: 512,
                block_start: 0,
                events: 6,
                params: 1,
                result: 0,
                spent_us: 9_000,
            },
            "harp",
            SR,
        );

        assert!(over.contains("spent=40000us OVER"), "got {over}");
        assert!(!under.contains("OVER"), "got {under}");
    }

    #[test]
    fn the_clock_anchor_belongs_to_no_track() {
        let record = Record::Anchor {
            host_time: 12.5,
            frame: 600_000,
            waited: 0.0012,
            observed: 0.0140,
            kept: 0.0050,
        };
        assert_eq!(record.slot(), u32::MAX);

        let text = render(&record, "?", SR);
        assert!(text.contains("host=12.5000"));
        assert!(text.contains("waited=0.0012"));
        // The gap between the two is the jitter that was thrown away.
        assert!(text.contains("rejected=9.0ms"), "got {text}");
    }

    // A plugin rendered outside the engine — the `render` example — has no
    // slot to be in, and saying so is better than printing the sentinel.
    #[test]
    fn a_plugin_with_no_slot_reads_as_a_dash() {
        let text = render(
            &Record::NoteOn {
                slot: u32::MAX,
                pitch: 60,
                velocity: 1.0,
                offset: 0,
                frame: 0,
            },
            "?",
            SR,
        );

        assert!(text.contains("slot=-"), "got {text}");
    }

    // The line a fault that builds is read off: a queue or a voice count that
    // only goes up, and the cost of the call that has to keep up with it.
    #[test]
    fn a_health_line_carries_what_is_held_and_what_it_cost() {
        let text = render(
            &Record::Health {
                slot: 2,
                notes_pending: 6,
                notes_sounding: 4,
                params_pending: 31,
                blocks: 100,
                process_total_us: 45_000,
                process_max_us: 1_200,
            },
            "harp",
            SR,
        );

        assert!(text.starts_with("health"), "got {text}");
        assert!(text.contains("notes-pending=6"));
        assert!(text.contains("sounding=4"));
        assert!(text.contains("params-pending=31"));
        assert!(text.contains("process-avg=450us"), "got {text}");
        assert!(text.contains("process-max=1200us"));
    }

    // A dropout is a callback that overran its own frames, so the budget has to
    // be on the line next to what was actually spent.
    #[test]
    fn a_load_line_states_the_deadline_beside_the_cost() {
        let text = render(
            &Record::Load {
                callbacks: 100,
                frames: 48_000,
                render_total_us: 300_000,
                render_max_us: 7_000,
                late: 0,
            },
            "?",
            SR,
        );

        assert!(text.starts_with("load"), "got {text}");
        assert!(text.contains("render-avg=3000us"), "got {text}");
        // 480 frames a callback, at 48 kHz: ten milliseconds to render them in.
        assert!(text.contains("budget=10000us"), "got {text}");
        assert!(!text.contains("LATE"));
    }

    #[test]
    fn a_callback_that_overran_is_marked() {
        let text = render(
            &Record::Load {
                callbacks: 100,
                frames: 48_000,
                render_total_us: 900_000,
                render_max_us: 21_000,
                late: 7,
            },
            "?",
            SR,
        );

        assert!(text.contains("late=7 LATE"), "got {text}");
    }

    // A refusal that keeps being asked for is the shape of this line's point.
    #[test]
    fn a_callbacks_line_counts_what_the_host_would_not_provide() {
        let text = render(
            &Record::Callbacks {
                refused_instances: 2_400,
                param_edits: 0,
                restarts: 1,
                messages: 17,
            },
            "?",
            SR,
        );

        assert!(text.starts_with("callbacks"), "got {text}");
        assert!(text.contains("refused-instances=2400"));
        assert!(text.contains("param-edits=0"));
        assert!(text.contains("restarts=1"));
        assert!(text.contains("messages=17"));
    }

    // The load belongs to every plugin at once, so it can name none of them.
    #[test]
    fn the_render_load_belongs_to_no_track() {
        let record = Record::Load {
            callbacks: 1,
            frames: 480,
            render_total_us: 1,
            render_max_us: 1,
            late: 0,
        };
        assert_eq!(record.slot(), u32::MAX);
    }

    #[test]
    fn pitches_are_named_the_way_the_app_names_them() {
        assert_eq!(note_name(60), "C4");
        assert_eq!(note_name(61), "C#4");
        assert_eq!(note_name(21), "A0");
        assert_eq!(note_name(127), "G9");
        assert_eq!(note_name(-1), "?");
    }
}
