//! Plays a chord pattern through a real plugin for minutes and reports what each
//! `process` call cost, so a fault that *builds* can be attributed.
//!
//! The trace inside the running app can say that a plugin's `process` call grows
//! from a quarter of a millisecond to forty over two minutes of playing. What it
//! cannot say is whose fault that is: the app's clock, its scheduler, its audio
//! device and the webview driving all three are between the note and the plugin.
//!
//! This removes every one of them. There is no audio device, no webview, no
//! clock: notes are placed on the block counter directly and blocks are rendered
//! as fast as the CPU can, so a cost that still climbs here belongs to the plugin
//! and the patch loaded into it, and one that does not belongs to the app.
//!
//! ```powershell
//! # The state blob is a plugin preset, as a project file stores it.
//! cargo run --release --example soak -- --path "C:\Program Files\Common Files\VST3\Kontakt 8.vst3" `
//!     --state harp.b64 --seconds 180
//! ```
//!
//! `--state` is optional: without it the plugin comes up on its defaults, which
//! for a sampler means an empty rack and nothing to measure. A project file keeps
//! one per track, under the track's `vst3State`, so a line of Python pulls one out:
//!
//! ```text
//! python -c "import json;print(next(t['vst3State'] for t in json.load(open('song.json'))['tracks'] if t['name']=='Harp'))" > harp.b64
//! ```
//!
//! Run it against the patch that misbehaves *and* one that does not. A cost that
//! climbs for one and holds steady for the other is the answer on its own.

use std::thread::sleep;
use std::time::{Duration, Instant};

use chord_composer_lib::vst3::{
    module::Module,
    plugin::{list_cc, Plugin, ResetMode, Transport},
    scan,
    stream::MemoryStream,
};

const SAMPLE_RATE: f64 = 48_000.0;

/// The app's own block size on a typical Windows device, so the deadline here is
/// the deadline there. `--block` varies it, which is how the deadline itself gets
/// tested rather than only what is sent.
const DEFAULT_BLOCK: usize = 480;

/// The chord, as MIDI pitches. A four-note harp voicing; `--notes` takes a prefix.
const CHORD: [i16; 4] = [57, 60, 64, 67];

/// What to send, so one thing at a time can be varied and the cost watched.
struct Args {
    path: Option<String>,
    class_id: Option<String>,
    state: Option<String>,
    seconds: f64,
    /// Seconds between chords.
    interval: f64,
    /// How long before the next chord each note is released, in milliseconds.
    ///
    /// Zero is what the app's own timeline produces: a note-off landing on the
    /// very sample the next note-on does, because the scheduler pulls an
    /// overlapping release back onto the next attack. No DAW does that — a MIDI
    /// timeline always leaves at least a tick — so it is the first thing to vary.
    gap_ms: f64,
    /// Notes per chord.
    notes: usize,
    velocity: u8,
    /// Frames per `process` call, and so the deadline each one has.
    block: usize,
    /// Milliseconds between the notes of one chord.
    ///
    /// Zero is a chord: every note on the same sample, which is what a quantised
    /// timeline produces. Spreading them is the one thing left that changes how
    /// much work lands in a single block without changing how much work there is.
    stagger_ms: f64,
    /// Which MIDI controller to sweep, or none.
    ///
    /// A controller is not a stream in VST3: it is whatever `ParamID` the plugin
    /// names for it, so this is resolved through `IMidiMapping` and then sent as
    /// an ordinary parameter change — exactly the path the app's automation
    /// takes.
    cc: Option<u16>,
    /// Seconds for one full sweep up and back down.
    cc_period: f64,
    /// The increment the sweep is sent in, in controller steps.
    ///
    /// One is what the app sends now: every step the curve passes through, in
    /// order. A larger number is the fault being tested — a curve that skips, so
    /// a patch which plays a string per step is handed several steps at once.
    cc_step: u16,
    /// Seconds between resets, or zero for none.
    ///
    /// The question this whole flag exists to answer: a cost that climbs the
    /// longer an instrument plays is cleared by reloading it inside the plugin's
    /// own editor, so does asking the same thing over VST3 clear it too? With
    /// this on, a curve that works is a sawtooth and one that does not is the
    /// same climb it always was.
    reset_every: f64,
    /// How much of the plugin to put back. See `ResetMode`.
    reset_mode: ResetMode,
    /// Render no faster than the audio it produces.
    ///
    /// Off, this renders as fast as the CPU can, which is what makes a soak of
    /// three minutes take twenty seconds. That is right for measuring what a
    /// block *costs* and wrong for measuring what it *contains*: a streaming
    /// sampler reads its samples from disk on its own thread, and starving that
    /// thread makes it render silence while still charging for the voices. Any
    /// claim about the audio needs this on.
    paced: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        path: None,
        class_id: None,
        state: None,
        seconds: 180.0,
        interval: 1.5,
        gap_ms: 0.0,
        notes: CHORD.len(),
        velocity: 127,
        block: DEFAULT_BLOCK,
        stagger_ms: 0.0,
        cc: None,
        cc_period: 3.0,
        cc_step: 1,
        reset_every: 0.0,
        reset_mode: ResetMode::Active,
        paced: false,
    };

    let mut rest = std::env::args().skip(1);
    while let Some(flag) = rest.next() {
        let number = |fallback: f64, given: Option<String>| {
            given.and_then(|s| s.parse().ok()).unwrap_or(fallback)
        };
        match flag.as_str() {
            "--path" => args.path = rest.next(),
            "--state" => args.state = rest.next(),
            "--seconds" => args.seconds = number(180.0, rest.next()),
            "--interval" => args.interval = number(1.5, rest.next()),
            "--gap" => args.gap_ms = number(0.0, rest.next()),
            "--notes" => args.notes = (number(4.0, rest.next()) as usize).clamp(1, CHORD.len()),
            "--velocity" => args.velocity = number(127.0, rest.next()).clamp(1.0, 127.0) as u8,
            "--stagger" => args.stagger_ms = number(0.0, rest.next()),
            "--cc" => args.cc = Some(number(11.0, rest.next()).clamp(0.0, 127.0) as u16),
            "--cc-period" => args.cc_period = number(3.0, rest.next()).max(0.1),
            "--cc-step" => args.cc_step = number(1.0, rest.next()).clamp(1.0, 127.0) as u16,
            "--reset-every" => args.reset_every = number(0.0, rest.next()).max(0.0),
            "--reset-mode" => {
                args.reset_mode = match rest.next().as_deref() {
                    Some("processing") => ResetMode::Processing,
                    Some("active") => ResetMode::Active,
                    Some("setup") => ResetMode::Setup,
                    Some("state") => ResetMode::State,
                    other => {
                        eprintln!("unknown reset mode {other:?}");
                        std::process::exit(1);
                    }
                }
            }
            "--paced" => args.paced = true,
            "--block" => {
                args.block = (number(DEFAULT_BLOCK as f64, rest.next()) as usize).clamp(32, 8192)
            }
            other if other.starts_with("--") => {
                // Without this an unrecognised flag becomes the class id and the
                // run fails several seconds later for a reason that has nothing
                // to do with the typo.
                eprintln!("unknown flag {other}");
                std::process::exit(1);
            }
            other => args.class_id = Some(other.to_string()),
        }
    }
    args
}

fn main() {
    let args = parse_args();

    let (path, class_id) = match resolve(&args) {
        Some(found) => found,
        None => {
            eprintln!("no plugin to soak: give --path <file.vst3> or an installed class id");
            std::process::exit(1);
        }
    };

    let mut plugin = match Plugin::load(path.as_ref(), &class_id, SAMPLE_RATE, args.block) {
        Ok(plugin) => plugin,
        Err(err) => {
            eprintln!("load failed: {err}");
            std::process::exit(1);
        }
    };

    if let Some(file) = &args.state {
        match load_state(&mut plugin, file) {
            Ok(bytes) => println!("state restored: {bytes} bytes"),
            Err(err) => {
                eprintln!("state failed: {err}");
                std::process::exit(1);
            }
        }
    }

    println!("{:#?}", plugin.diagnostics());
    println!(
        "\nsoaking {:.0}s: {} note(s) every {}s, {}ms apart, released {}ms early, velocity {}",
        args.seconds, args.notes, args.interval, args.stagger_ms, args.gap_ms, args.velocity
    );
    println!(
        "{}-frame blocks, {:.1} ms of deadline each",
        args.block,
        args.block as f64 / SAMPLE_RATE * 1000.0
    );

    // The controller to sweep, as the `ParamID` the plugin names for it. Resolved
    // once: `IMidiMapping` is what makes a controller reachable at all, and a
    // plugin with no mapping for it cannot be sent it by any means.
    let cc_param = args.cc.and_then(|cc| {
        let controller = plugin.controller_handle()?;
        let found = list_cc(&controller)
            .into_iter()
            .find(|info| info.controller == cc)?;
        println!(
            "CC {cc} is parameter {:#x}, swept 0-127-0 every {}s in steps of {}",
            found.param_id, args.cc_period, args.cc_step
        );
        Some(found.param_id)
    });
    if args.cc.is_some() && cc_param.is_none() {
        eprintln!("the plugin has no mapping for that controller: nothing to sweep");
        std::process::exit(1);
    }

    println!("\na step past {POP_THRESHOLD} between neighbouring samples is flagged\n");
    println!(
        "{:>8}  {:>9}  {:>10}  {:>10}  {:>8}",
        "played", "sounding", "spent", "worst", "step"
    );

    let transport = Transport::rolling(120.0);
    let mut out = vec![0.0f32; args.block * 2];

    let chord_frames = (args.interval * SAMPLE_RATE) as i64;
    // How long a note actually sounds. Shortening it is what puts clear air
    // between a release and the next attack of the same pitch.
    let held = (chord_frames - (args.gap_ms / 1000.0 * SAMPLE_RATE) as i64).max(1);
    let stagger = args.stagger_ms / 1000.0 * SAMPLE_RATE;
    let blocks = (args.seconds * SAMPLE_RATE / args.block as f64) as i64;
    let mut next_chord = 0i64;
    let mut worst_in_window = 0u128;
    let mut sum_in_window = 0u128;
    let mut blocks_in_window = 0u128;
    let mut reported = -1i64;

    // The first reset is after one interval, not at zero: a reset before the
    // instrument has had time to get slow proves nothing.
    let reset_frames = (args.reset_every * SAMPLE_RATE) as i64;
    let mut next_reset = if reset_frames > 0 { reset_frames } else { i64::MAX };

    // The frames notes begin and end on, so a discontinuity in the output can be
    // attributed. A plucked attack *is* a step between two samples and a
    // legitimate one; the telling steps are the ones with no note under them.
    let mut upcoming: Vec<(i64, bool)> = Vec::new();

    // Carried across blocks: the step from the last sample of one block to the
    // first of the next is the one a per-block scan would miss, and the one a
    // block that missed its deadline actually produces.
    let mut previous = [0.0f32; 2];
    let mut last_cc: Option<u16> = None;

    let mut worst = Worst::default();
    let mut peak = 0.0f32;
    let soak_began = Instant::now();

    for block in 0..blocks {
        let block_start = block * args.block as i64;
        let block_end = block_start + args.block as i64;
        let played = block_start / SAMPLE_RATE as i64;

        // The second just finished, printed whatever happened in it. The lines
        // below are filtered to the blocks worth looking at, which is right for
        // finding a fault and useless for watching a curve: a reset that works
        // shows up there as an *absence*. This is the curve.
        if played != reported {
            if reported >= 0 && blocks_in_window > 0 {
                println!(
                    "{reported:>7}s  {:>9}  {:>8}us  {:>8}us     mean/worst",
                    plugin.scheduler.sounding_len(),
                    sum_in_window / blocks_in_window,
                    worst_in_window,
                );
            }
            reported = played;
            worst_in_window = 0;
            sum_in_window = 0;
            blocks_in_window = 0;
        }

        // Between two `process` calls, on the one thread, with nothing else
        // touching the plugin — which is the whole reason this measurement
        // belongs here rather than in the app.
        let mut had_reset = false;
        if block_start >= next_reset {
            let began = Instant::now();
            let outcome = plugin.reset(args.reset_mode);
            let took = began.elapsed();
            match outcome {
                Ok(()) => println!(
                    "{played:>7}s  reset ({:?}) took {:.1} ms",
                    args.reset_mode,
                    took.as_secs_f64() * 1000.0
                ),
                Err(err) => println!("{played:>7}s  reset ({:?}) failed: {err}", args.reset_mode),
            }
            had_reset = true;
            next_reset += reset_frames;

            // The plugin forgot its voices and the scheduler forgot with it, so
            // this tool's own record of what is in flight is stale too.
            upcoming.clear();
            last_cc = None;
        }

        // One chord per interval. With no gap each note is released on the very
        // sample the next is struck, which is what the app's timeline produces.
        if block_start >= next_chord {
            for (i, pitch) in CHORD.iter().take(args.notes).enumerate() {
                let at = next_chord + (i as f64 * stagger) as i64;
                plugin
                    .scheduler
                    .schedule_note(*pitch, args.velocity, at, held);
                upcoming.push((at, true));
                upcoming.push((at + held, false));
            }
            next_chord += chord_frames;
        }

        // The controller, walked the way the app walks it: a value a millisecond
        // apart at the closest, and only where the value it would send changed.
        if let Some(id) = cc_param {
            let first = block_start * 1000 / SAMPLE_RATE as i64;
            let last = block_end * 1000 / SAMPLE_RATE as i64;
            for ms in first..=last {
                let frame = ms * SAMPLE_RATE as i64 / 1000;
                if frame < block_start || frame >= block_end {
                    continue;
                }

                let value = swept(frame, args.cc_period, args.cc_step);
                if last_cc == Some(value) {
                    continue;
                }
                last_cc = Some(value);
                plugin
                    .param_scheduler
                    .schedule(id, value as f64 / 127.0, frame);
            }
        }

        // What this block carries, taken rather than searched so the list does
        // not grow for the length of the run.
        let mut had_on = false;
        let mut had_off = false;
        upcoming.retain(|(frame, on)| {
            if *frame >= block_end {
                return true;
            }
            if *on {
                had_on = true;
            } else {
                had_off = true;
            }
            false
        });

        out.fill(0.0);
        let started = Instant::now();
        plugin.process_into(&mut out, args.block, block_start, transport);
        let spent = started.elapsed().as_micros();

        let step = biggest_step(&out, args.block, &mut previous);
        worst.record(step, had_reset, had_on, had_off);
        worst_in_window = worst_in_window.max(spent);
        sum_in_window += spent;
        blocks_in_window += 1;
        for sample in &out[..args.block * 2] {
            peak = peak.max(sample.abs());
        }

        // Held back to the moment this block's audio would have been wanted, so
        // the plugin's own streaming thread has the time it would really have.
        if args.paced {
            let due = Duration::from_secs_f64(block_end as f64 / SAMPLE_RATE);
            if let Some(wait) = due.checked_sub(soak_began.elapsed()) {
                sleep(wait);
            }
        }

        // Every block that missed a quarter of its deadline or stepped far enough
        // to be heard, so the shape of both faults is visible without a line per
        // block.
        let carried = plugin.scheduler.sounding_len();

        let budget_us = args.block as f64 / SAMPLE_RATE * 1e6;
        let popped = step > POP_THRESHOLD;
        if spent * 4 > budget_us as u128 || popped {
            println!(
                "{played:>7}s  {carried:>9}  {spent:>8}us  {:>8}us  {step:>8.4}{}{}{}{}",
                worst_in_window,
                if spent as f64 > budget_us { "  OVER" } else { "" },
                if popped { "  STEP" } else { "" },
                if had_on { "  on" } else { "" },
                if had_off { "  off" } else { "" },
            );
        }
    }

    worst.report();
    println!("\npeak output level {peak:.4}");
    if peak < 0.001 {
        println!(
            "nothing was rendered: the numbers above say what the blocks cost, not what they \
             contained. Try --paced, and check the preset plays these pitches."
        );
    }
    println!("\ndone");
}

/// A step between neighbouring samples past this is a click rather than a
/// waveform.
///
/// A full-scale sine at 1 kHz moves 0.13 between samples at 48 kHz, so this is
/// above anything musical below that pitch and far below a discontinuity. It is a
/// screen, not a verdict: a plucked attack legitimately steps this far, which is
/// why the summary keeps the note-on case apart from the rest.
const POP_THRESHOLD: f32 = 0.15;

/// The biggest step between neighbouring samples in one block, counting the join
/// with the block before it.
///
/// Interleaved stereo, so each channel is walked on its own stride: the gap
/// between the left and right of one frame is not a step in either channel.
fn biggest_step(out: &[f32], frames: usize, previous: &mut [f32; 2]) -> f32 {
    let mut worst = 0.0f32;

    for channel in 0..2 {
        let mut last = previous[channel];
        for frame in 0..frames {
            let sample = out[frame * 2 + channel];
            worst = worst.max((sample - last).abs());
            last = sample;
        }
        previous[channel] = last;
    }

    worst
}

/// The value a swept controller reads at one frame, in controller steps.
///
/// A triangle rather than a ramp, so the sweep spends its whole life moving and
/// never rests at an end: movement is what is being tested.
fn swept(frame: i64, period: f64, step: u16) -> u16 {
    let phase = (frame as f64 / SAMPLE_RATE / period).fract();
    let ideal = if phase < 0.5 {
        phase * 2.0
    } else {
        2.0 - phase * 2.0
    } * 127.0;

    // Snapped to the increment being tested. One is every step the curve passes
    // through; larger is a curve that skips, which is the fault.
    let step = step.max(1) as f64;
    ((ideal / step).round() * step).clamp(0.0, 127.0) as u16
}

/// The worst step seen, kept apart by what the block it landed in carried.
///
/// The whole point of the split. A step under a note-on is an attack and proves
/// nothing; a step under a note-off is a voice cut rather than released; and a
/// step under neither is the output moving on its own, which is what a controller
/// jump does.
#[derive(Default)]
struct Worst {
    reset: f32,
    attack: f32,
    release: f32,
    alone: f32,
    popped_reset: u64,
    popped_attack: u64,
    popped_release: u64,
    popped_alone: u64,
}

impl Worst {
    fn record(&mut self, step: f32, had_reset: bool, had_on: bool, had_off: bool) {
        // A reset outranks the rest: it cuts every voice at once, so a step in
        // that block says nothing about the note that happened to be under it.
        let (worst, count) = if had_reset {
            (&mut self.reset, &mut self.popped_reset)
        } else if had_on {
            (&mut self.attack, &mut self.popped_attack)
        } else if had_off {
            (&mut self.release, &mut self.popped_release)
        } else {
            (&mut self.alone, &mut self.popped_alone)
        };

        *worst = worst.max(step);
        if step > POP_THRESHOLD {
            *count += 1;
        }
    }

    fn report(&self) {
        println!("\nbiggest step between neighbouring samples, by what the block carried");
        println!("{:>24}  {:>10}  {:>14}", "", "worst step", "blocks past it");
        println!(
            "{:>24}  {:>10.4}  {:>14}",
            "a note beginning", self.attack, self.popped_attack
        );
        println!(
            "{:>24}  {:>10.4}  {:>14}",
            "a note ending", self.release, self.popped_release
        );
        println!(
            "{:>24}  {:>10.4}  {:>14}",
            "neither", self.alone, self.popped_alone
        );
        println!(
            "{:>24}  {:>10.4}  {:>14}",
            "a reset", self.reset, self.popped_reset
        );
    }
}

/// The module path and class id to soak, from the arguments or the first
/// installed instrument.
fn resolve(args: &Args) -> Option<(String, String)> {
    if let Some(path) = &args.path {
        let module = Module::load(path.as_ref()).ok()?;
        let class = match &args.class_id {
            Some(wanted) => module.classes().into_iter().find(|c| &c.class_id == wanted)?,
            None => module.classes().into_iter().next()?,
        };
        return Some((path.clone(), class.class_id));
    }

    let installed = scan::scan();
    let found = match &args.class_id {
        Some(wanted) => installed.into_iter().find(|p| &p.class_id == wanted)?,
        None => installed.into_iter().next()?,
    };
    Some((found.path, found.class_id))
}

/// Restore a preset from a base64 file, as the app does at load.
fn load_state(plugin: &mut Plugin, file: &str) -> Result<usize, String> {
    use base64::Engine as _;
    use vst3::Steinberg::{kResultOk, IBStream, IBStreamTrait, IBStream_};
    use vst3::{ComWrapper, Steinberg::Vst::IComponentTrait};

    let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| format!("{file} is not base64: {e}"))?;
    let len = bytes.len();

    let component = plugin.component_handle();
    let stream = ComWrapper::new(MemoryStream::from_bytes(bytes));
    let ptr = stream
        .to_com_ptr::<IBStream>()
        .ok_or("could not build a stream")?;

    // SAFETY: the stream outlives the call, and `setState` is the same use the
    // engine makes of a component from a control thread.
    unsafe {
        let mut at = 0i64;
        ptr.seek(0, IBStream_::IStreamSeekMode_::kIBSeekSet as i32, &mut at);
        if component.setState(ptr.as_ptr()) != kResultOk {
            return Err("the plugin refused the state".to_string());
        }
    }

    Ok(len)
}
