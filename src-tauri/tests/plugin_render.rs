//! End-to-end host tests against a real `.vst3` on disk.
//!
//! The unit tests cover the arithmetic; this covers the part that can only be
//! wrong against an actual plugin — instantiate, set up, activate the right
//! buses, feed an event list, `process`, get audio back. The plugin is the
//! bundled test synth rather than anything installed, because a fixture that
//! always sounds is the only one whose silence means the host is broken.

use std::path::{Path, PathBuf};
use std::process::Command;

use chord_composer_lib::vst3::{module::Module, plugin::Plugin};

const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK: usize = 512;

/// `target/<profile>/`, worked out from the test binary's own location
/// (`target/<profile>/deps/<test>.exe`).
fn target_profile_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent()
        .and_then(Path::parent)
        .expect("target/<profile>")
        .to_path_buf()
}

/// The built test synth, building it first if it is not there.
///
/// Cargo will not build a `cdylib` just because a test wants one, and the
/// fixture cannot be a dependency — the host has to `LoadLibrary` a file, not
/// link a crate. So the build is asked for explicitly. It is safe to do here:
/// the outer cargo has finished building and released its lock by the time
/// tests run.
fn fixture() -> PathBuf {
    let built = target_profile_dir().join(format!("{}test_synth{}", DLL_PREFIX, DLL_SUFFIX));

    // Built every time, not just when missing: cargo no-ops when it is current,
    // and a stale fixture fails these tests for reasons unrelated to the host.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "test-synth", "--manifest-path"])
        .arg(&manifest)
        .status()
        .expect("could not run cargo to build the test synth");
    assert!(status.success(), "building the test synth failed");

    assert!(built.exists(), "test synth not found at {}", built.display());
    built
}

#[cfg(windows)]
const DLL_PREFIX: &str = "";
#[cfg(windows)]
const DLL_SUFFIX: &str = ".dll";
#[cfg(not(windows))]
const DLL_PREFIX: &str = "lib";
#[cfg(not(windows))]
const DLL_SUFFIX: &str = ".so";

fn load() -> Plugin {
    let path = fixture();
    let module = Module::load(&path).expect("module loads");
    let info = module
        .classes()
        .into_iter()
        .next()
        .expect("the fixture exposes an audio plug-in class");

    Plugin::load(&path, &info.class_id, SAMPLE_RATE, BLOCK).expect("plugin instantiates")
}

fn peak(buffer: &[f32]) -> f32 {
    buffer.iter().fold(0.0f32, |a, s| a.max(s.abs()))
}

/// Render `blocks` blocks from `from`, returning the peak of each.
fn render(plugin: &mut Plugin, from: i64, blocks: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; BLOCK * 2];
    (0..blocks)
        .map(|i| {
            out.fill(0.0);
            plugin.process_into(&mut out, BLOCK, from + (i * BLOCK) as i64);
            peak(&out)
        })
        .collect()
}

#[test]
fn the_fixture_describes_itself_as_an_instrument() {
    let path = fixture();
    let module = Module::load(&path).expect("module loads");
    let classes = module.classes();

    assert_eq!(classes.len(), 1);
    assert!(classes[0].is_instrument());
    assert_eq!(classes[0].name, "Chord Composer Test Synth");
}

#[test]
fn a_plugin_with_nothing_scheduled_is_silent() {
    let mut plugin = load();
    assert_eq!(render(&mut plugin, 0, 4), vec![0.0; 4]);
}

#[test]
fn a_scheduled_note_produces_audio() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);

    let peaks = render(&mut plugin, 0, 4);
    assert!(peaks.iter().all(|p| *p > 0.0), "got {peaks:?}");
}

// The webview never sends a note-off; the host synthesises it from the note's
// duration. If that is wrong the note sounds forever, which is the single most
// visible failure this host can have.
#[test]
fn a_note_stops_when_its_duration_runs_out() {
    let mut plugin = load();
    // One block long, so the second block is already past the release.
    plugin
        .scheduler
        .schedule_note(60, 100, 0, BLOCK as i64);

    let peaks = render(&mut plugin, 0, 3);

    assert!(peaks[0] > 0.0, "should sound in the first block");
    assert_eq!(&peaks[1..], &[0.0, 0.0], "should be released after it");
}

#[test]
fn a_note_stays_silent_until_its_moment() {
    let mut plugin = load();
    // Starts in the third block.
    plugin
        .scheduler
        .schedule_note(60, 100, BLOCK as i64 * 2, 48_000);

    let peaks = render(&mut plugin, 0, 4);

    assert_eq!(&peaks[..2], &[0.0, 0.0], "silent before it starts");
    assert!(peaks[2] > 0.0, "sounds once it arrives");
}

#[test]
fn several_notes_sound_together() {
    let mut plugin = load();
    let mut one = load();

    for pitch in [60, 64, 67] {
        plugin.scheduler.schedule_note(pitch, 100, 0, 48_000);
    }
    one.scheduler.schedule_note(60, 100, 0, 48_000);

    let chord = render(&mut plugin, 0, 2);
    let single = render(&mut one, 0, 2);

    assert!(
        chord[1] > single[1],
        "a chord should be louder than one note: {chord:?} vs {single:?}"
    );
}

// Stop is what the transport's Stop button reaches, and a plugin left sounding
// after it is the most obvious possible bug.
#[test]
fn stopping_releases_a_sounding_note() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000 * 10);

    assert!(render(&mut plugin, 0, 1)[0] > 0.0);

    plugin.scheduler.stop_all();

    let after = render(&mut plugin, BLOCK as i64, 2);
    assert_eq!(after, vec![0.0, 0.0], "nothing should still be sounding");
}

#[test]
fn gain_scales_the_output() {
    let mut loud = load();
    let mut quiet = load();

    loud.scheduler.schedule_note(60, 100, 0, 48_000);
    quiet.scheduler.schedule_note(60, 100, 0, 48_000);
    quiet.set_gain(0.25);

    let loud_peak = render(&mut loud, 0, 2)[1];
    let quiet_peak = render(&mut quiet, 0, 2)[1];

    assert!(
        (quiet_peak - loud_peak * 0.25).abs() < 1e-3,
        "{quiet_peak} should be a quarter of {loud_peak}"
    );
}

// `process_into` adds rather than overwrites, because several plugins share one
// output buffer and each mixes itself in.
#[test]
fn rendering_adds_into_the_buffer_rather_than_replacing_it() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);

    let mut out = vec![0.5f32; BLOCK * 2];
    plugin.process_into(&mut out, BLOCK, 0);

    // The synth starts at phase zero, so its first sample is zero; the 0.5
    // already in the buffer has to still be there.
    assert!((out[0] - 0.5).abs() < 1e-6, "got {}", out[0]);
    assert!(out.iter().any(|s| (*s - 0.5).abs() > 1e-3), "nothing was added");
}
