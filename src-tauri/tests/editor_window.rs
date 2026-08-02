//! Opening a real plugin's editor in a real window.
//!
//! # Why most of this is `#[ignore]`d
//!
//! A VST3 editor expects to be attached on a thread that is running a Win32
//! message loop. In the app that is Tauri's main thread, which pumps messages
//! continuously. A `cargo test` harness thread pumps nothing, and a real plugin
// — blocks inside `attached` waiting for messages that will never be delivered.
// The test does not fail; it hangs, which is worse.
//!
//! So the cases that need a real editor are marked `#[ignore]` and are a manual
//! check: `cargo test --test editor_window -- --ignored` from a context that
//! pumps, or simply pressing "Open plugin editor" in the running app.
//!
//! The bundled test synth cannot stand in here: it deliberately has no editor,
//! which is what makes it useless for this and ideal for everything else.

#![cfg(windows)]

use chord_composer_lib::vst3::{editor, plugin::Plugin, scan};

const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK: usize = 512;
const TRACK: &str = "editor-track";

/// The first installed instrument that actually offers an editor.
fn plugin_with_editor() -> Option<(Plugin, String)> {
    for info in scan::scan() {
        let Ok(plugin) = Plugin::load(info.path.as_ref(), &info.class_id, SAMPLE_RATE, BLOCK)
        else {
            continue;
        };
        if plugin.controller_handle().is_some() {
            return Some((plugin, info.name));
        }
    }
    eprintln!("skipping: no installed plugin offers an editor");
    None
}

/// Loading a plugin now also builds and connects its edit controller. That runs
/// on every load, editor or not, so a plugin that chokes on it would be silent
/// rather than merely un-editable — worth its own check, and safe to run
/// because it never touches a window.
#[test]
fn loading_a_plugin_also_wires_up_its_controller() {
    let Some((plugin, name)) = plugin_with_editor() else {
        return;
    };

    assert!(
        plugin.controller_handle().is_some(),
        "{name} reported a controller and then did not provide one"
    );
    // Still usable for audio afterwards — the controller wiring must not have
    // disturbed the processing setup.
    let diagnostics = plugin.diagnostics();
    assert!(diagnostics.audio_outputs > 0);
    assert!(diagnostics.accepts_f32);
}

#[test]
fn closing_a_track_with_no_editor_is_harmless() {
    editor::close("never-opened");
    assert!(!editor::is_open("never-opened"));
}

#[test]
fn nothing_is_open_to_begin_with() {
    assert!(!editor::is_open(TRACK));
}

#[test]
#[ignore = "needs a thread running a Win32 message loop; see the module comment"]
fn a_plugin_editor_opens_and_closes() {
    let Some((plugin, name)) = plugin_with_editor() else {
        return;
    };
    let controller = plugin.controller_handle().expect("checked above");

    editor::open(TRACK, &name, &controller).expect("editor opens");
    assert!(editor::is_open(TRACK));

    editor::close(TRACK);
    assert!(!editor::is_open(TRACK));
}

// Two windows for one track would leave the first orphaned — attached to a
// window nothing will ever close.
#[test]
#[ignore = "needs a thread running a Win32 message loop; see the module comment"]
fn opening_twice_does_not_make_a_second_window() {
    const TRACK2: &str = "editor-track-2";

    let Some((plugin, name)) = plugin_with_editor() else {
        return;
    };
    let controller = plugin.controller_handle().expect("checked above");

    editor::open(TRACK2, &name, &controller).expect("editor opens");
    editor::open(TRACK2, &name, &controller).expect("second open is a no-op");
    assert!(editor::is_open(TRACK2));

    editor::close(TRACK2);
    assert!(!editor::is_open(TRACK2));
}
