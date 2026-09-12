//! The audio engine driven exactly as the webview drives it, against a real
//! output device.
//!
//! `plugin_render.rs` proves a plugin renders when told to. This proves the rest
//! of the chain: the command queue, the clock anchor, slot management and the
//! cpal callback. It is the only test that can catch "everything looks right and
//! nothing comes out".
//!
//! Skipped when the machine has no audio output — a headless CI box is not a
//! failure, it just cannot answer the question.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use chord_composer_lib::vst3::{engine::Engine, module::Module, plugin::ResetMode};

#[cfg(windows)]
const DLL_NAME: &str = "test_synth.dll";
#[cfg(not(windows))]
const DLL_NAME: &str = "libtest_synth.so";

const TRACK: &str = "track-under-test";

fn fixture() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>");
    let built = profile.join(DLL_NAME);

    // Built every time, not just when missing. Cargo will no-op when it is
    // already current, and a stale fixture is far worse than a second of build:
    // it fails these tests for reasons that have nothing to do with the host.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "test-synth", "--manifest-path"])
        .arg(&manifest)
        .status()
        .expect("could not run cargo");
    assert!(status.success(), "building the test synth failed");

    assert!(built.exists(), "test synth not found at {}", built.display());
    built
}

fn class_id(path: &Path) -> String {
    Module::load(path)
        .expect("module loads")
        .classes()
        .into_iter()
        .next()
        .expect("one class")
        .class_id
}

/// An engine on the default output device, or `None` if there isn't one.
fn engine() -> Option<Engine> {
    // `None` is the system default, which is the only endpoint a test can assume,
    // and `None` again is the device's own block size — the only one it will
    // certainly take.
    match Engine::start(None, None) {
        Ok(engine) => Some(engine),
        Err(err) => {
            eprintln!("skipping: no usable audio output ({err})");
            None
        }
    }
}

/// Let the audio thread run for long enough to render several blocks.
fn render_for(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[test]
fn a_scheduled_note_reaches_the_output_device() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    assert!(engine.is_loaded(TRACK));

    // Nothing scheduled yet, so nothing should be coming out.
    render_for(120);
    assert_eq!(engine.take_peak(), 0.0, "silent before anything is scheduled");

    // The webview's clock is arbitrary; the anchor is what ties it to the
    // stream. Schedule just far enough ahead to survive the IPC hop.
    engine.sync(0.0).expect("sync");
    engine
        .schedule(TRACK, 60, 100, 0.03, 1.0)
        .expect("schedule");

    render_for(400);
    let peak = engine.take_peak();
    assert!(peak > 0.0, "nothing came out of the audio device");

    // The fixture emits a 0.2-amplitude sine, so anything wildly off means the
    // signal is being mangled somewhere between the plugin and the device.
    assert!(peak <= 1.0, "output is out of range: {peak}");
}

#[test]
fn a_note_that_was_never_scheduled_makes_no_sound() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.sync(0.0).expect("sync");

    render_for(250);
    assert_eq!(engine.take_peak(), 0.0);
}

// Without an anchor there is no way to know where a note belongs, and guessing
// would put it in the wrong place rather than merely late.
#[test]
fn notes_scheduled_before_the_first_sync_are_dropped_rather_than_misplaced() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    engine.schedule(TRACK, 60, 100, 0.03, 1.0).expect("schedule");

    render_for(300);
    assert_eq!(engine.take_peak(), 0.0);
}

#[test]
fn stopping_silences_a_sounding_note() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.sync(0.0).expect("sync");
    // Ten seconds long, so only a stop can end it.
    engine.schedule(TRACK, 60, 100, 0.03, 10.0).expect("schedule");

    render_for(300);
    assert!(engine.take_peak() > 0.0, "should be sounding");

    engine.stop(TRACK).expect("stop");
    render_for(150);
    engine.take_peak();

    render_for(200);
    assert_eq!(engine.take_peak(), 0.0, "should be silent after a stop");
}

#[test]
fn unloading_a_track_silences_it() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 10.0).expect("schedule");

    render_for(300);
    assert!(engine.take_peak() > 0.0);

    engine.unload(TRACK).expect("unload");
    assert!(!engine.is_loaded(TRACK));

    render_for(200);
    engine.take_peak();
    render_for(200);
    assert_eq!(engine.take_peak(), 0.0);
}

// What quitting does. Every track at once, and — unlike `unload` — it waits for
// the audio thread to hand the plugins back, because at shutdown there is no
// later call to collect them and a plugin left uncollected is never terminated.
#[test]
fn unloading_everything_silences_every_track() {
    const OTHER: &str = "second-track-under-test";

    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.load(OTHER, &path, &cid).expect("second plugin loads");
    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 10.0).expect("schedule");
    engine.schedule(OTHER, 64, 100, 0.03, 10.0).expect("schedule");

    render_for(300);
    assert!(engine.take_peak() > 0.0);

    engine.unload_all();
    assert!(!engine.is_loaded(TRACK));
    assert!(!engine.is_loaded(OTHER));

    render_for(200);
    engine.take_peak();
    render_for(200);
    assert_eq!(engine.take_peak(), 0.0);
}

// Scheduling for a track with no plugin is not an error: the webview's pool can
// dispatch a note a moment before the native side has finished loading.
#[test]
fn scheduling_for_an_unknown_track_is_ignored() {
    let Some(engine) = engine() else { return };

    engine.sync(0.0).expect("sync");
    engine
        .schedule("no-such-track", 60, 100, 0.03, 1.0)
        .expect("should not error");

    render_for(200);
    assert_eq!(engine.take_peak(), 0.0);
}

#[test]
fn volume_scales_what_reaches_the_device() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.sync(0.0).expect("sync");

    engine.schedule(TRACK, 60, 100, 0.03, 2.0).expect("schedule");
    render_for(400);
    let full = engine.take_peak();
    assert!(full > 0.0);

    engine.set_gain(TRACK, 0.1).expect("gain");
    render_for(250);
    let quiet = engine.take_peak();

    assert!(quiet > 0.0, "should still be sounding");
    assert!(quiet < full * 0.5, "{quiet} should be well below {full}");
}

/// The fixture's default "preset" bytes, mirrored from the plugin.
const DEFAULT_BLOB: [u8; 4] = [1, 2, 3, 4];

#[test]
fn plugin_state_round_trips() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    assert_eq!(engine.get_state(TRACK).expect("get"), DEFAULT_BLOB);

    engine.set_state(TRACK, vec![9, 8, 7, 6]).expect("set");
    assert_eq!(engine.get_state(TRACK).expect("get"), vec![9, 8, 7, 6]);
}

// A fresh instance must come up on its own defaults, or a "restored" project
// would silently inherit whatever the last one happened to be set to. Detaching
// is what makes an instance fresh — the webview unloads a track's plugin before
// putting a different one on it.
#[test]
fn a_plugin_loaded_after_an_unload_starts_from_its_defaults() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_state(TRACK, vec![9, 8, 7, 6]).expect("set");

    engine.unload(TRACK).expect("unload");
    engine.load(TRACK, &path, &cid).expect("plugin reloads");

    assert_eq!(engine.get_state(TRACK).expect("get"), DEFAULT_BLOB);
}

// The same plugin is loaded onto the same track more than once by design: the
// editor loads on demand and Play loads again. Rebuilding it would throw away
// everything the user set up in the editor — and leave that editor attached to
// a component on its way to being terminated.
#[test]
fn re_loading_the_same_plugin_leaves_it_exactly_as_it_was() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_state(TRACK, vec![9, 8, 7, 6]).expect("set");

    engine.load(TRACK, &path, &cid).expect("second load");

    assert_eq!(engine.get_state(TRACK).expect("get"), vec![9, 8, 7, 6]);
}

#[test]
fn state_for_a_track_with_no_plugin_is_an_error_rather_than_a_panic() {
    let Some(engine) = engine() else { return };

    assert!(engine.get_state("no-such-track").is_err());
    assert!(engine.set_state("no-such-track", vec![1]).is_err());
}

/// The reported-latency read, which is a control-side query rather than an
/// audio-thread one: it casts the component reference the engine already keeps for
/// state, exactly as `Plugin::load` does to get its processor.
///
/// The figure itself is informational — nothing in the app compensates for it — so
/// what matters is that asking is safe and that the answer is in milliseconds.
#[test]
fn a_loaded_plugin_reports_its_own_latency_in_milliseconds() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    let ms = engine.latency_ms(TRACK).expect("a loaded plugin answers");

    // The fixture declares no latency, like most instrument plugins — which is
    // precisely why the manual per-instrument offset exists beside this number.
    assert_eq!(ms, 0.0, "the test synth declares no latency");
}

/// Asked about a track hosting nothing, so the panel can offer the offset control
/// on every instrument and simply omit the reported figure where there is none.
#[test]
fn a_track_with_no_plugin_reports_no_latency() {
    let Some(engine) = engine() else { return };

    assert!(engine.latency_ms("never-loaded").is_none());
}

/// Unloading takes the component reference with it, so the query must go back to
/// answering nothing rather than reading through a stale pointer.
#[test]
fn latency_stops_being_reported_once_the_plugin_is_unloaded() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    assert!(engine.latency_ms(TRACK).is_some());

    engine.unload(TRACK).expect("unloads");
    assert!(engine.latency_ms(TRACK).is_none());
}

// --- Block size and rendering ahead ---------------------------------------
//
// These exist because of a crackle: a detailed sampled library can spend forty
// milliseconds on the block carrying a chord's attacks, against a deadline of
// ten, and every one of those is a gap in the stream. A bigger block lengthens
// the deadline; rendering ahead breaks the link between the two. Both rebuild or
// re-aim the stream underneath the plugins, so what matters here is that sound
// keeps coming out across the change.

/// Asking for a block size rebuilds the stream, and the plugins keep playing.
#[test]
fn sound_survives_a_change_of_block_size() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 4.0).expect("schedule");
    render_for(200);
    assert!(engine.take_peak() > 0.0, "silent before the change");

    // A device may refuse the size and fall back to its own, which is reported
    // rather than failed — either way it has to still be making sound.
    engine.set_buffer_size(Some(1024)).expect("the stream re-opens");

    render_for(300);
    assert!(engine.take_peak() > 0.0, "silent after the change");
}

/// And going back to the device's own preference is the same journey in reverse.
#[test]
fn sound_survives_going_back_to_the_device_block_size() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_buffer_size(Some(2048)).expect("the stream re-opens");

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 4.0).expect("schedule");
    render_for(250);
    assert!(engine.take_peak() > 0.0, "silent at the chosen size");

    engine.set_buffer_size(None).expect("the stream re-opens");

    render_for(300);
    assert!(engine.take_peak() > 0.0, "silent back on the device's own size");
}

/// Rendering ahead moves the work onto another thread. The audio must arrive
/// exactly as it did, only earlier — which from out here means: it arrives.
#[test]
fn sound_comes_out_while_rendering_ahead() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_headroom(100);

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 4.0).expect("schedule");

    // Longer than without, because the first sound has the headroom to cross
    // before it is heard — which is the latency the setting costs, working.
    render_for(600);
    assert!(engine.take_peak() > 0.0, "nothing came out of the ring");
}

/// Off has to stay a real path, so the two can be compared rather than one
/// trusted. Turning it back off must hand rendering to the callback cleanly.
#[test]
fn sound_survives_rendering_ahead_being_turned_off_again() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_headroom(50);

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 6.0).expect("schedule");
    render_for(400);
    assert!(engine.take_peak() > 0.0, "silent while rendering ahead");

    engine.set_headroom(0);

    render_for(300);
    assert!(engine.take_peak() > 0.0, "silent once rendering in the callback again");
}

/// The device can be changed while audio is being rendered ahead of it. The ring
/// holds stereo precisely so that what is already in it survives the journey.
#[test]
fn sound_survives_a_device_change_while_rendering_ahead() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.set_headroom(100);

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 6.0).expect("schedule");
    render_for(400);
    assert!(engine.take_peak() > 0.0, "silent before the change");

    // Back to the system default, which is the one endpoint a test can assume.
    engine.set_output_device(None).expect("the stream re-opens");

    render_for(400);
    assert!(engine.take_peak() > 0.0, "silent after the device changed");
}

/// The counters have to be true with no environment variable set: they are what
/// the settings dialog shows, and the whole point is choosing a buffer by
/// evidence rather than by feel.
#[test]
fn the_health_counters_report_without_the_trace() {
    let Some(engine) = engine() else { return };

    render_for(200);
    let health = engine.take_health();

    assert!(health.sample_rate > 0.0, "no sample rate reported");
    assert!(health.block > 0, "no block size reported — nothing was rendered");

    // Reading is destructive, so the next reading is the stretch since this one
    // rather than a total. That is what makes it a reading of *now*.
    let again = engine.take_health();
    assert!(again.worst_us < health.worst_us || again.worst_us == 0 || health.worst_us == 0);
}

// --- Putting an instrument back the way it loaded -------------------------
//
// A detailed sampled instrument can get slower the longer it plays, and no
// buffer cures a cost that keeps climbing — it only puts off the moment the
// shortfall is heard. These cover the host's half: that the handover is safe,
// that the instrument still plays afterwards, and that the host's own picture of
// what is sounding goes with it.

/// The plugin keeps playing across a reset, which is the whole point of doing it
/// in place rather than unloading and loading again.
#[test]
fn an_instrument_still_sounds_after_being_reset() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 6.0).expect("schedule");
    render_for(200);
    assert!(engine.take_peak() > 0.0, "silent before the reset");

    assert_eq!(engine.reset_all(ResetMode::Active), Ok(1));

    // A reset takes the sounding notes with it, so something has to be asked for
    // again before there is anything to hear.
    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 64, 100, 0.03, 2.0).expect("schedule");
    render_for(400);
    assert!(engine.take_peak() > 0.0, "silent after the reset");
}

/// The notes a reset cut are gone, not merely quiet. If the host went on
/// believing they were held, the next Stop would release notes nothing is
/// playing — and this is the counter that would show it climbing for the rest of
/// the session.
#[test]
fn a_reset_leaves_nothing_sounding() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");

    engine.sync(0.0).expect("sync");
    engine.schedule(TRACK, 60, 100, 0.03, 6.0).expect("schedule");
    render_for(200);

    engine.reset_all(ResetMode::Active).expect("resets");

    // Let any block already in flight finish, then discard everything measured
    // up to here — including the note that was legitimately sounding before the
    // reset. `take_peak` reads destructively, so this is what makes the next
    // reading mean "since the reset" rather than "ever".
    render_for(60);
    engine.take_peak();

    // Nothing was scheduled after the reset, so anything coming out now would be
    // a voice the reset was supposed to have taken.
    render_for(200);
    assert_eq!(engine.take_peak(), 0.0, "something was left sounding");
}

/// Asked of a session with nothing loaded. Zero rather than an error: an empty
/// project is an ordinary state, and this runs from a Stop handler.
#[test]
fn resetting_with_nothing_loaded_is_not_an_error() {
    let Some(engine) = engine() else { return };

    assert_eq!(engine.reset_all(ResetMode::Active), Ok(0));
    assert_eq!(engine.reset("never-loaded", ResetMode::Active), Ok(0));
}

/// One track at a time, for a manual reset that must not interrupt the others.
#[test]
fn resetting_one_track_leaves_the_others_alone() {
    const OTHER: &str = "second-track-under-test";
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    engine.load(OTHER, &path, &cid).expect("second plugin loads");
    // A plugin reaches the renderer's slots when the audio thread next drains
    // the command queue, not when `load` returns. A reset before that finds
    // nothing to reset — which is correct, and would make this prove nothing.
    render_for(120);

    assert_eq!(engine.reset(TRACK, ResetMode::Active), Ok(1));
    assert_eq!(engine.reset_all(ResetMode::Active), Ok(2));
}

/// Every mode has to survive the round trip, because which one actually clears a
/// given instrument is a property of that instrument.
#[test]
fn every_reset_mode_leaves_the_plugin_usable() {
    let Some(engine) = engine() else { return };

    let path = fixture();
    let cid = class_id(&path);
    engine.load(TRACK, &path, &cid).expect("plugin loads");
    // As above: the plugin is in flight to the audio thread until a block has
    // been rendered.
    render_for(120);

    for mode in [
        ResetMode::Processing,
        ResetMode::Active,
        ResetMode::Setup,
        ResetMode::State,
    ] {
        assert_eq!(engine.reset_all(mode), Ok(1), "{mode:?} did not come back");

        engine.sync(0.0).expect("sync");
        engine.schedule(TRACK, 60, 100, 0.03, 1.0).expect("schedule");
        render_for(250);
        assert!(engine.take_peak() > 0.0, "silent after {mode:?}");
    }
}
