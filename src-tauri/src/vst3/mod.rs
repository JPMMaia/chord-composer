//! Native VST3 hosting.
//!
//! The app's sound normally comes from Web Audio inside the webview. This module
//! is the other half: plugins loaded into this process, driven by note events the
//! webview sends over Tauri's IPC, rendered to the system's audio device.

pub mod clock;
#[cfg(windows)]
pub mod editor;
pub mod engine;
pub mod events;
pub mod host;
pub mod module;
pub mod params;
pub mod plugin;
pub mod scan;
pub mod stream;

use std::sync::Mutex;

use engine::Engine;
use module::PluginInfo;

/// Everything native the app owns, behind Tauri's managed state.
///
/// The audio engine is started on first use rather than at launch: opening an
/// output device is not free, and a session that never touches a plugin should
/// never take one.
#[derive(Default)]
pub struct Vst3State {
    catalog: Mutex<Option<Vec<PluginInfo>>>,
    engine: Mutex<Option<Engine>>,
    /// The output endpoint the user picked, by name. `None` means the system
    /// default.
    ///
    /// Kept here rather than only inside the engine because the engine may not
    /// exist yet: a device can be chosen in a session that never loads a
    /// plugin, and the choice has to survive until one is.
    output_device: Mutex<Option<String>>,
}

impl Vst3State {
    /// The installed instruments, scanning on first call.
    ///
    /// Scanning loads every plugin on the machine, so the answer is remembered.
    /// `rescan` is how the user picks up a plugin installed since launch.
    pub fn catalog(&self, rescan: bool) -> Vec<PluginInfo> {
        let mut guard = self.catalog.lock().unwrap();
        if rescan || guard.is_none() {
            *guard = Some(scan::scan());
        }
        guard.clone().unwrap_or_default()
    }

    /// The path a class id was found at, from the last scan.
    fn path_of(&self, class_id: &str) -> Option<String> {
        self.catalog(false)
            .into_iter()
            .find(|p| p.class_id == class_id)
            .map(|p| p.path)
    }

    /// Run `f` against the audio engine, starting it if it is not running.
    fn with_engine<T>(&self, f: impl FnOnce(&Engine) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.engine.lock().unwrap();
        if guard.is_none() {
            let preferred = self.output_device.lock().unwrap().clone();
            *guard = Some(Engine::start(preferred)?);
        }
        f(guard.as_ref().expect("just started"))
    }

    /// Play plugins through the endpoint called `name`, or the system default.
    ///
    /// Remembered whether or not the engine is running, so a device chosen
    /// before the first plugin is loaded is the one that plugin comes up on.
    pub fn set_output_device(&self, name: Option<String>) -> Result<(), String> {
        *self.output_device.lock().unwrap() = name.clone();

        // Deliberately does not go through `with_engine`: choosing where sound
        // would come out must not be what opens an audio device.
        let guard = self.engine.lock().unwrap();
        match guard.as_ref() {
            Some(engine) => engine.set_output_device(name.as_deref()),
            None => Ok(()),
        }
    }
}

/// Play hosted plugins through a named output endpoint.
///
/// The webview's own sound is moved separately, with `AudioContext.setSinkId` —
/// the two engines have entirely separate device handles, so one picker has to
/// drive both. See `src/engine/audioOutput.ts`.
#[tauri::command]
pub fn vst3_set_output_device(
    state: tauri::State<'_, Vst3State>,
    name: Option<String>,
) -> Result<(), String> {
    state.set_output_device(name)
}

/// Every VST3 instrument installed on this machine.
#[tauri::command]
pub fn vst3_list(state: tauri::State<'_, Vst3State>) -> Vec<PluginInfo> {
    state.catalog(false)
}

/// Re-read the install directories, picking up anything newly installed.
#[tauri::command]
pub fn vst3_scan(state: tauri::State<'_, Vst3State>) -> Vec<PluginInfo> {
    state.catalog(true)
}

/// Attach a plugin to a track, replacing whatever it had.
#[tauri::command]
pub fn vst3_load(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    class_id: String,
) -> Result<(), String> {
    let path = state
        .path_of(&class_id)
        .ok_or_else(|| format!("no installed plugin with class id {class_id}"))?;

    state.with_engine(|engine| engine.load(&track_id, &path.into(), &class_id))
}

/// Detach a track's plugin.
///
/// Any editor it has open is closed first, and waited for: the window holds an
/// `IPlugView` belonging to the component that is about to be terminated, and a
/// plugin still drawing into a window whose component has gone takes the app
/// down with it.
#[tauri::command]
pub fn vst3_unload(
    #[allow(unused_variables)] app: tauri::AppHandle,
    state: tauri::State<'_, Vst3State>,
    track_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        if editor::is_open(&track_id) {
            let id = track_id.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                editor::close(&id);
                let _ = tx.send(());
            })
            .map_err(|e| format!("could not reach the main thread: {e}"))?;
            let _ = rx.recv();
        }
    }

    state.with_engine(|engine| engine.unload(&track_id))
}

/// One scheduled note, as the webview describes it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledNote {
    pub midi_note: i16,
    pub velocity: u8,
    /// Absolute time on the webview's clock, in seconds.
    pub when: f64,
    pub duration: f64,
}

/// Schedule a batch of notes.
///
/// A batch rather than one call per note: the webview's scheduler dispatches
/// every due note in one synchronous pass, and a round trip each would put
/// hundreds of IPC calls in the path of a chord.
#[tauri::command]
pub fn vst3_schedule(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    notes: Vec<ScheduledNote>,
) -> Result<(), String> {
    state.with_engine(|engine| {
        for note in &notes {
            engine.schedule(&track_id, note.midi_note, note.velocity, note.when, note.duration)?;
        }
        Ok(())
    })
}

/// The parameters a track's plugin offers as automation targets.
///
/// Loads the plugin if the track has one but has not needed it yet, for the same
/// reason `vst3_open_editor` does: a plugin is otherwise only instantiated at the
/// first Play, and being unable to pick a parameter until you have pressed Play
/// would be a strange way to have to work.
#[tauri::command]
pub fn vst3_list_params(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    class_id: String,
) -> Result<Vec<plugin::ParamInfo>, String> {
    let path = state
        .path_of(&class_id)
        .ok_or_else(|| format!("no installed plugin with class id {class_id}"))?;

    state.with_engine(|engine| {
        if !engine.is_loaded(&track_id) {
            engine.load(&track_id, &path.clone().into(), &class_id)?;
        }
        Ok(engine.list_params(&track_id))
    })
}

/// The MIDI controllers a track's plugin accepts.
///
/// Loads on demand exactly as `vst3_list_params` does, and for the same reason.
/// An empty list means the plugin implements no `IMidiMapping` — it cannot be
/// sent CC at all, and the UI offers no MIDI learn.
#[tauri::command]
pub fn vst3_list_cc(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    class_id: String,
) -> Result<Vec<plugin::CcInfo>, String> {
    let path = state
        .path_of(&class_id)
        .ok_or_else(|| format!("no installed plugin with class id {class_id}"))?;

    state.with_engine(|engine| {
        if !engine.is_loaded(&track_id) {
            engine.load(&track_id, &path.clone().into(), &class_id)?;
        }
        Ok(engine.list_cc(&track_id))
    })
}

/// What a curve drives.
///
/// Both kinds end up as a parameter change on a `ParamID`, which is why they
/// share a command: in VST3 a MIDI controller *is* a parameter, one the plugin
/// names through `IMidiMapping` rather than through its parameter list.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Param { param_id: u32 },
    Cc { controller: u16 },
}

impl Target {
    /// The parameter to actually drive, or `None` when the plugin maps no such
    /// controller.
    ///
    /// A refusal is dropped rather than guessed at: falling back to any id would
    /// drive an unrelated parameter, which is worse than doing nothing and much
    /// harder to notice.
    fn resolve(self, engine: &engine::Engine, track_id: &str) -> Option<u32> {
        match self {
            Target::Param { param_id } => Some(param_id),
            Target::Cc { controller } => engine.cc_param_id(track_id, controller),
        }
    }
}

/// One scheduled change, as the webview describes it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTarget {
    pub target: Target,
    /// Normalised 0..=1 — the range `AutomationPoint.value` already uses, so a
    /// point travels from the curve to the plugin unconverted.
    pub value: f64,
    /// Absolute time on the webview's clock, in seconds.
    pub when: f64,
}

/// Schedule a batch of changes.
///
/// A batch for the same reason `vst3_schedule` is one: a scheduling pass emits
/// every due point of every curve in one synchronous loop, and a round trip each
/// would put the whole automation stack in the path of every tick.
#[tauri::command]
pub fn vst3_automate(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    params: Vec<ScheduledTarget>,
) -> Result<(), String> {
    state.with_engine(|engine| {
        for param in &params {
            let Some(id) = param.target.resolve(engine, &track_id) else {
                continue;
            };
            engine.automate(&track_id, id, param.value, param.when)?;
        }
        Ok(())
    })
}

/// Drive a target now, rather than at a moment in the future.
///
/// What states a level rather than scheduling one: the pin at Play, and a
/// preview while the curve is being drawn.
#[tauri::command]
pub fn vst3_set_target(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    target: Target,
    value: f64,
) -> Result<(), String> {
    state.with_engine(|engine| {
        let Some(id) = target.resolve(engine, &track_id) else {
            return Ok(());
        };
        engine.set_param(&track_id, id, value)
    })
}

/// Wiggle a MIDI controller so an armed plugin control binds to it.
///
/// This is the app standing in for the hardware knob a plugin's "learn MIDI CC"
/// expects: the user arms a control in the plugin's own editor, and this sends
/// the controller it should learn.
///
/// Returns as soon as the sweep is queued rather than when it is heard. It is
/// placed on the audio thread's own frame counter, so it needs neither a clock
/// anchor nor a running transport — only the stream, which is always running.
#[tauri::command]
pub fn vst3_learn_cc(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    controller: u16,
) -> Result<(), String> {
    state.with_engine(|engine| engine.learn_cc(&track_id, controller))
}

/// Sound a note now and hold it until `vst3_release`.
///
/// What a held key needs, and what `vst3_schedule` cannot express: a scheduled
/// note carries its length up front, so playing a key through it means guessing
/// how long it will be held. Guessing long leaves a plugin with a slow release —
/// an orchestral library, typically — sounding well after the key came up.
#[tauri::command]
pub fn vst3_hold(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    midi_note: i16,
    velocity: u8,
) -> Result<(), String> {
    state.with_engine(|engine| engine.hold(&track_id, midi_note, velocity))
}

/// Release a note held by `vst3_hold`.
#[tauri::command]
pub fn vst3_release(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    midi_note: i16,
) -> Result<(), String> {
    state.with_engine(|engine| engine.release(&track_id, midi_note))
}

/// Re-anchor the native clock against the webview's.
#[tauri::command]
pub fn vst3_sync(state: tauri::State<'_, Vst3State>, host_time: f64) -> Result<(), String> {
    state.with_engine(|engine| engine.sync(host_time))
}

#[tauri::command]
pub fn vst3_set_volume(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    volume: f32,
) -> Result<(), String> {
    state.with_engine(|engine| engine.set_gain(&track_id, volume))
}

/// Release everything sounding on one track's plugin.
#[tauri::command]
pub fn vst3_stop(state: tauri::State<'_, Vst3State>, track_id: String) -> Result<(), String> {
    state.with_engine(|engine| engine.stop(&track_id))
}

/// Release everything sounding, on every plugin.
#[tauri::command]
pub fn vst3_stop_all(state: tauri::State<'_, Vst3State>) -> Result<(), String> {
    state.with_engine(|engine| engine.stop_all())
}

/// Open a track's plugin in its own window.
///
/// VST3 editors have main-thread affinity and Tauri's command handlers do not
/// run there, so the work is marshalled across. The command returns as soon as
/// the window has opened — or failed to.
#[cfg(windows)]
#[tauri::command]
pub fn vst3_open_editor(
    app: tauri::AppHandle,
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    class_id: String,
    title: String,
) -> Result<(), String> {
    // Loaded on demand, because a plugin is otherwise only instantiated at the
    // first Play — and being unable to open a synth's editor until you have
    // pressed Play would be a strange way to have to work.
    let path = state
        .path_of(&class_id)
        .ok_or_else(|| format!("no installed plugin with class id {class_id}"))?;

    let controller = state.with_engine(|engine| {
        if !engine.is_loaded(&track_id) {
            engine.load(&track_id, &path.clone().into(), &class_id)?;
        }
        engine
            .controller(&track_id)
            .ok_or_else(|| "this plugin has no editor".to_string())
    })?;

    let wrapped = engine::SendController(controller);
    let (tx, rx) = std::sync::mpsc::channel();

    app.run_on_main_thread(move || {
        let _ = tx.send(editor::open(&track_id, &title, &wrapped.0));
    })
    .map_err(|e| format!("could not reach the main thread: {e}"))?;

    rx.recv()
        .map_err(|_| "the main thread did not answer".to_string())?
}

/// Close a track's editor window.
#[cfg(windows)]
#[tauri::command]
pub fn vst3_close_editor(app: tauri::AppHandle, track_id: String) -> Result<(), String> {
    app.run_on_main_thread(move || editor::close(&track_id))
        .map_err(|e| format!("could not reach the main thread: {e}"))
}

/// Whether a track's editor window is open.
#[cfg(windows)]
#[tauri::command]
pub fn vst3_editor_is_open(track_id: String) -> bool {
    editor::is_open(&track_id)
}

/// Whether a track's plugin offers an editor at all.
#[tauri::command]
pub fn vst3_has_editor(state: tauri::State<'_, Vst3State>, track_id: String) -> bool {
    let guard = state.engine.lock().unwrap();
    guard
        .as_ref()
        .is_some_and(|e| e.controller(&track_id).is_some())
}

/// What a track's plugin reports its own latency to be, in milliseconds.
///
/// Null when the track hosts no plugin. Informational: nothing in the app
/// compensates for it, and an instrument plugin answering 0 while plainly sounding
/// late is the ordinary case — which is what the per-instrument offset is for.
#[tauri::command]
pub fn vst3_latency(state: tauri::State<'_, Vst3State>, track_id: String) -> Option<f64> {
    let guard = state.engine.lock().unwrap();
    guard.as_ref()?.latency_ms(&track_id)
}

/// A track's plugin state, base64'd for the project file.
///
/// Returns null when the track has no plugin — saving a project must not fail
/// because one track happens to be a soundfont.
#[tauri::command]
pub fn vst3_get_state(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let guard = state.engine.lock().unwrap();
    let Some(engine) = guard.as_ref() else {
        return Ok(None);
    };
    if !engine.is_loaded(&track_id) {
        return Ok(None);
    }

    let bytes = engine.get_state(&track_id)?;
    Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Restore a track's plugin state from a project file.
#[tauri::command]
pub fn vst3_set_state(
    state: tauri::State<'_, Vst3State>,
    track_id: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("plugin state is not valid base64: {e}"))?;

    state.with_engine(|engine| engine.set_state(&track_id, bytes.clone()))
}

/// The loudest sample the plugins have rendered since this was last asked.
///
/// A diagnostic rather than a meter for the UI: it is the only way to tell
/// "playing but silent" from "not playing" without listening.
#[tauri::command]
pub fn vst3_peak_level(state: tauri::State<'_, Vst3State>) -> f32 {
    let guard = state.engine.lock().unwrap();
    guard.as_ref().map_or(0.0, |e| e.take_peak())
}

/// Whether a track currently has a plugin loaded.
#[tauri::command]
pub fn vst3_is_loaded(state: tauri::State<'_, Vst3State>, track_id: String) -> bool {
    let guard = state.engine.lock().unwrap();
    guard.as_ref().is_some_and(|e| e.is_loaded(&track_id))
}
