pub mod vst3;

/// The native half of Chord Composer.
///
/// The webview keeps making its own sound through Web Audio; everything here is
/// additive, so a build with no plugins installed behaves exactly like the
/// browser build.
pub fn run() {
    tauri::Builder::default()
        .manage(vst3::Vst3State::default())
        .invoke_handler(tauri::generate_handler![
            vst3::vst3_list,
            vst3::vst3_scan,
            vst3::vst3_load,
            vst3::vst3_unload,
            vst3::vst3_schedule,
            vst3::vst3_sync,
            vst3::vst3_set_volume,
            vst3::vst3_stop,
            vst3::vst3_stop_all,
            vst3::vst3_is_loaded,
            vst3::vst3_peak_level,
            vst3::vst3_get_state,
            vst3::vst3_set_state,
            vst3::vst3_has_editor,
            vst3::vst3_open_editor,
            vst3::vst3_close_editor,
            vst3::vst3_editor_is_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
