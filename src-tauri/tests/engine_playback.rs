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

use chord_composer_lib::vst3::{engine::Engine, module::Module};

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
    // `None` is the system default, which is the only endpoint a test can assume.
    match Engine::start(None) {
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
