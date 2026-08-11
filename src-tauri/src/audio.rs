//! Which speakers the app plays through.
//!
//! The app makes sound in two places — Web Audio inside the webview, and the
//! cpal stream that carries the hosted VST3 plugins — and each has its own idea
//! of what a device is. This module owns the native half of that: enumerating
//! the machine's output endpoints by name.
//!
//! The names are the join between the two halves. The webview can only name a
//! device after the user has granted a media permission, and even then it holds
//! opaque per-origin ids; cpal names the same endpoints outright, with no
//! permission and no salting. So the picker is built from this list, and the
//! webview matches its own devices against these names — see
//! `src/engine/audioOutput.ts`.

use cpal::traits::{DeviceTrait, HostTrait};

/// One output endpoint, as the picker shows it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    /// The endpoint's friendly name, e.g. `Speakers (Realtek(R) Audio)`. Also
    /// its identity: cpal offers nothing more stable, and it is what the
    /// webview's device labels can be compared against.
    pub name: String,
    /// Whether this is the endpoint Windows would pick on its own.
    pub is_default: bool,
}

/// Every output endpoint this machine has, the default one first.
///
/// Deliberately independent of the VST3 engine: asking what devices exist must
/// not open one. A session that never loads a plugin still has a picker.
pub fn output_devices() -> Vec<OutputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let mut devices: Vec<OutputDevice> = match host.output_devices() {
        Ok(found) => found
            .filter_map(|device| device.name().ok())
            .map(|name| {
                let is_default = name == default_name;
                OutputDevice { name, is_default }
            })
            .collect(),
        // No enumeration means no picker, not a broken app: the caller falls
        // back to whatever the system default is, which is what it had anyway.
        Err(_) => Vec::new(),
    };

    // The default first, because it is the answer for most users and the one
    // the picker starts on. The rest keep the order the host gave them.
    devices.sort_by_key(|device| !device.is_default);
    devices
}

/// The machine's output endpoints, for the audio settings picker.
#[tauri::command]
pub fn audio_output_devices() -> Vec<OutputDevice> {
    output_devices()
}
