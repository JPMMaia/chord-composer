//! Reading and writing project files on the desktop build.
//!
//! The webview cannot touch the disk, and the official filesystem plugin is not a
//! fit here: the paths it will accept come from the session's scope, which the save
//! dialog widens one file at a time and which is dropped when the app restarts. Two
//! things this feature needs fall outside that — writing the auto-save sidecar, which
//! is a *different* path from the one the dialog handed back, and quick-saving to the
//! remembered file after a restart, when the scope is empty again.
//!
//! So the picker stays a plugin and the I/O lives here. These commands take a full
//! path from the frontend and act on it, which is the same trust the app already
//! places in the frontend everywhere else — it is one program, not a sandbox host.

use std::path::Path;
use std::time::UNIX_EPOCH;

/// Read a UTF-8 file whole. The frontend parses it; a missing or unreadable file is
/// an error rather than an empty string, so a failed read never looks like a project
/// with nothing in it.
#[tauri::command]
pub fn project_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

/// Write a UTF-8 file whole, creating it if needed.
///
/// The write goes to a temporary file in the same directory and is then renamed over
/// the target, so an interrupted save leaves the previous file intact rather than a
/// half-written one. The auto-save sidecar in particular is written every few seconds
/// while the user works, and it is the one file that has to be trustworthy after a
/// crash — a truncated recovery file would be worse than none.
#[tauri::command]
pub fn project_write(path: String, contents: String) -> Result<(), String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
    }

    let temporary = target.with_extension("tmp-write");
    std::fs::write(&temporary, contents.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", temporary.display()))?;
    std::fs::rename(&temporary, target).map_err(|e| {
        // Leaving the temporary behind after a failed rename would accumulate one
        // file per failed save, so it goes even though the save itself is lost.
        let _ = std::fs::remove_file(&temporary);
        format!("Could not save {path}: {e}")
    })
}

#[tauri::command]
pub fn project_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Delete a file, treating "it was not there" as success — the caller is clearing an
/// auto-save that may never have been written.
#[tauri::command]
pub fn project_remove(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {path}: {e}")),
    }
}

/// Last-modified time in milliseconds since the epoch, or null when the file is
/// missing or the platform will not say. The frontend compares it against the
/// project file's to decide whether an auto-save is worth offering back.
#[tauri::command]
pub fn project_modified_ms(path: String) -> Option<f64> {
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    let since_epoch = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since_epoch.as_secs_f64() * 1000.0)
}
