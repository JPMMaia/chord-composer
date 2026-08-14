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

/// The fixture's automatable parameter. Kept in step with `test-synth`'s
/// `GAIN_PARAM` by hand: the fixture is loaded as a library at runtime, not
/// linked, so there is no constant to share.
const GAIN_PARAM: u32 = 0;

/// The fixture's hidden, MIDI-only gain, and the controllers it maps.
///
/// CC 20 reaches `CC_GAIN_PARAM` and is audible; CC 1 reaches the fixture's inert
/// `SECRET_PARAM` and is not. Kept in step with `test-synth` by hand, as
/// `GAIN_PARAM` is.
const CC_GAIN_PARAM: u32 = 3;
const AUDIBLE_CC: u16 = 20;
const INERT_CC: u16 = 1;
/// A controller the fixture deliberately does not map.
const UNMAPPED_CC: u16 = 74;

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

#[test]
fn the_parameter_list_is_the_automatable_ones() {
    let plugin = load();
    let controller = plugin.controller_handle().expect("the fixture has a controller");

    let params = chord_composer_lib::vst3::plugin::list_params(&controller);

    // The fixture publishes four; the read-only one and the two hidden ones are
    // not automation targets and must not be offered as though they were.
    assert_eq!(params.len(), 1, "got {params:?}");
    assert_eq!(params[0].id, GAIN_PARAM);
    assert_eq!(params[0].title, "Gain");
    assert_eq!(params[0].units, "dB");
    assert_eq!(params[0].step_count, 0);
}

#[test]
fn a_scheduled_parameter_change_reaches_the_plugin() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);
    plugin.param_scheduler.schedule(GAIN_PARAM, 0.0, 0);

    let peaks = render(&mut plugin, 0, 2);
    assert_eq!(peaks[1], 0.0, "a gain of zero should silence the note");
}

// The assertion this whole path exists for. A host that ignored the sample
// offset — applying the value at the start of the block instead — would silence
// the *entire* block, and the first half would be zero too.
#[test]
fn a_parameter_change_takes_effect_at_the_sample_it_was_placed_on() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);
    // Half way through the second block.
    let at = BLOCK as i64 + (BLOCK / 2) as i64;
    plugin.param_scheduler.schedule(GAIN_PARAM, 0.0, at);

    let mut out = vec![0.0f32; BLOCK * 2];
    plugin.process_into(&mut out, BLOCK, 0);
    out.fill(0.0);
    plugin.process_into(&mut out, BLOCK, BLOCK as i64);

    // Interleaved stereo, so frame N is samples 2N and 2N+1.
    let before = peak(&out[..BLOCK]);
    let after = peak(&out[BLOCK..]);

    assert!(before > 0.0, "should still sound before the change: {before}");
    assert_eq!(after, 0.0, "should be silent from the change onward");
}

#[test]
fn a_parameter_change_holds_until_the_next_one() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);
    plugin.param_scheduler.schedule(GAIN_PARAM, 0.0, 0);
    // Nothing more is scheduled, so the third block still carries the change
    // made in the first: a parameter holds rather than reverting.
    let peaks = render(&mut plugin, 0, 3);

    assert_eq!(&peaks[1..], &[0.0, 0.0], "got {peaks:?}");
}

#[test]
fn two_parameter_changes_in_one_block_both_land() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);
    // Down at a quarter of the way in, back up at three quarters.
    plugin.param_scheduler.schedule(GAIN_PARAM, 0.0, (BLOCK / 4) as i64);
    plugin.param_scheduler.schedule(GAIN_PARAM, 1.0, (BLOCK * 3 / 4) as i64);

    let mut out = vec![0.0f32; BLOCK * 2];
    plugin.process_into(&mut out, BLOCK, 0);

    let middle = peak(&out[BLOCK / 2..BLOCK * 3 / 2]);
    let end = peak(&out[BLOCK * 3 / 2..]);

    assert_eq!(middle, 0.0, "the middle stretch should be silenced");
    assert!(end > 0.0, "and it should come back: {end}");
}

// A parameter is not a note: stopping abandons the curve but leaves the value
// where it reached, because the host has nothing better to put there.
#[test]
fn clearing_the_curve_leaves_the_parameter_where_it_was() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000 * 10);
    plugin.param_scheduler.schedule(GAIN_PARAM, 0.0, 0);
    render(&mut plugin, 0, 1);

    plugin.param_scheduler.clear();

    let after = render(&mut plugin, BLOCK as i64, 2);
    assert_eq!(after, vec![0.0, 0.0], "the gain should still be down");
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

// --- MIDI controllers --------------------------------------------------------
//
// In VST3 a plugin is sent no MIDI stream: a controller reaches it as a parameter
// change on whatever `ParamID` `IMidiMapping` names for it. These prove the
// naming, and that a change addressed as a controller travels the same
// sample-accurate path an ordinary parameter does.

#[test]
fn the_controller_list_is_the_ones_the_plugin_maps() {
    let plugin = load();
    let controller = plugin.controller_handle().expect("the fixture has a controller");

    let mapped = chord_composer_lib::vst3::plugin::list_cc(&controller);

    // Two of the 128 asked about, which is the point: a host that read the
    // out-parameter without checking the result would come back with all 128.
    assert_eq!(mapped.len(), 2, "got {mapped:?}");

    let audible = mapped.iter().find(|cc| cc.controller == AUDIBLE_CC);
    assert_eq!(audible.map(|cc| cc.param_id), Some(CC_GAIN_PARAM));
    // Two controllers, two different parameters — a host that collapsed them
    // would drive the wrong one.
    let inert = mapped.iter().find(|cc| cc.controller == INERT_CC);
    assert!(inert.is_some_and(|cc| cc.param_id != CC_GAIN_PARAM), "got {inert:?}");

    assert!(!mapped.iter().any(|cc| cc.controller == UNMAPPED_CC));
}

// The parameter a controller resolves to is hidden, so it is absent from the
// parameter picker — which is exactly how real plugins publish their CC proxies.
// Reconciling the two lists would hide a working target.
#[test]
fn a_mapped_controller_names_a_parameter_the_picker_does_not_offer() {
    let plugin = load();
    let controller = plugin.controller_handle().expect("the fixture has a controller");

    let params = chord_composer_lib::vst3::plugin::list_params(&controller);
    assert!(!params.iter().any(|p| p.id == CC_GAIN_PARAM), "got {params:?}");
}

#[test]
fn a_change_sent_as_a_controller_takes_effect_at_its_own_sample() {
    let mut plugin = load();
    plugin.scheduler.schedule_note(60, 100, 0, 48_000);

    // Addressed the way the command layer does it: resolve, then schedule.
    let controller = plugin.controller_handle().expect("controller");
    let id = chord_composer_lib::vst3::plugin::list_cc(&controller)
        .into_iter()
        .find(|cc| cc.controller == AUDIBLE_CC)
        .expect("CC 20 is mapped")
        .param_id;

    let at = BLOCK as i64 + (BLOCK / 2) as i64;
    plugin.param_scheduler.schedule(id, 0.0, at);

    let mut out = vec![0.0f32; BLOCK * 2];
    plugin.process_into(&mut out, BLOCK, 0);
    out.fill(0.0);
    plugin.process_into(&mut out, BLOCK, BLOCK as i64);

    assert!(peak(&out[..BLOCK]) > 0.0, "should still sound before the change");
    assert_eq!(peak(&out[BLOCK..]), 0.0, "should be silent from the change onward");
}

// The failure mode this guards is silent and specific: `getMidiControllerAssignment`
// leaves its out-parameter untouched when it refuses, so a host that trusts it
// over the result binds every unmapped controller to whatever was in that
// variable — parameter 0, the audible gain, if it was zeroed.
#[test]
fn an_unmapped_controller_drives_nothing_rather_than_parameter_zero() {
    let plugin = load();
    let controller = plugin.controller_handle().expect("controller");

    let mapped = chord_composer_lib::vst3::plugin::list_cc(&controller);
    assert!(
        !mapped.iter().any(|cc| cc.param_id == GAIN_PARAM),
        "an unmapped controller was bound to the gain: {mapped:?}"
    );
}
