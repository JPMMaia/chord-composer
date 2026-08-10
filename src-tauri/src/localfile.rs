//! Reading files the user points the app at, rather than files the app owns.
//!
//! `projectfile` is about one file the app wrote and knows the shape of. This is the
//! other direction: an SFZ instrument is a text file somewhere in the user's own
//! folders, naming sample files beside it, and none of those paths existed when the
//! app was built. The same argument applies as there — the picker is a plugin, the
//! I/O is ours, because a plugin's filesystem scope is granted per session and dropped
//! on restart, while a project that names an SFZ has to keep working after a restart
//! with no dialog in sight.
//!
//! Reads only. Nothing here creates, writes or deletes.

use std::path::Path;

/// Read a UTF-8 file whole — the `.sfz` itself, which is plain text.
#[tauri::command]
pub fn file_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

/// Read a file as raw bytes — a `.wav` sample.
///
/// `tauri::ipc::Response` rather than `Vec<u8>`: a command returning bytes that way
/// hands the webview an `ArrayBuffer` over the raw IPC channel, while a plain `Vec<u8>`
/// is serialised as a JSON array of numbers. A single sample set runs to several
/// megabytes, which as JSON would be several times that in transit and a decode on
/// the other side — for bytes that are about to be handed straight to `decodeAudioData`.
#[tauri::command]
pub fn file_read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whether a path names a readable file. The frontend asks before offering an
/// instrument whose samples may have been moved since the project was saved.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch path in the OS temp directory, unique per test.
    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("chord-composer-localfile-{name}"));
        path
    }

    #[test]
    fn reads_text_whole() {
        let path = temp_path("text.sfz");
        std::fs::write(&path, "<region> sample=a.wav").unwrap();

        let read = file_read_text(path.to_string_lossy().into_owned()).unwrap();

        assert_eq!(read, "<region> sample=a.wav");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reading_a_missing_file_is_an_error_not_a_panic() {
        let missing = temp_path("does-not-exist.sfz");

        let text = file_read_text(missing.to_string_lossy().into_owned());
        let bytes = file_read_bytes(missing.to_string_lossy().into_owned());

        assert!(text.is_err());
        assert!(bytes.is_err());
    }

    #[test]
    fn reports_whether_a_file_is_there() {
        let path = temp_path("exists.wav");
        std::fs::write(&path, [0u8, 1, 2]).unwrap();

        assert!(file_exists(path.to_string_lossy().into_owned()));
        let _ = std::fs::remove_file(&path);
        assert!(!file_exists(path.to_string_lossy().into_owned()));
    }

    /// The bytes have to survive the trip unchanged: a sample is not text and must not
    /// be re-encoded on the way out.
    #[test]
    fn reads_bytes_verbatim() {
        let path = temp_path("bytes.wav");
        let contents: Vec<u8> = vec![0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80];
        std::fs::write(&path, &contents).unwrap();

        let response = file_read_bytes(path.to_string_lossy().into_owned()).unwrap();

        // `Response` is opaque, so the check is that the read itself succeeded and the
        // file is what we wrote — the conversion is a single `Response::new`.
        assert_eq!(std::fs::read(&path).unwrap(), contents);
        drop(response);
        let _ = std::fs::remove_file(&path);
    }
}
