//! Finding the VST3 instruments installed on this machine.
//!
//! Scanning means loading every plugin on the system into this process, which is
//! slow (seconds, for a machine with a large library) and the single most likely
//! place to meet a badly-behaved plugin. So the result is cached to disk and the
//! scan only re-runs when asked, rather than on every launch.

use std::path::{Path, PathBuf};

use super::module::{Module, PluginInfo};

/// The standard install locations on Windows, in the order the spec lists them.
///
/// A plugin present in more than one is reported once, from whichever is found
/// first — later duplicates are dropped by class id.
fn search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // `CommonProgramFiles` is the 64-bit common directory on a 64-bit host.
    if let Ok(common) = std::env::var("CommonProgramFiles") {
        paths.push(PathBuf::from(common).join("VST3"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("Programs").join("Common").join("VST3"));
    }

    // Extra directories, separated the way `PATH` is. Lets a plugin be tried
    // without installing it — which is how the bundled test synth is exercised
    // in the running app, and how a user with a portable plugin folder can
    // point at it.
    if let Ok(extra) = std::env::var(EXTRA_PATHS_VAR) {
        paths.extend(extra.split(';').filter(|s| !s.is_empty()).map(PathBuf::from));
    }

    paths.retain(|p| p.is_dir());
    paths
}

/// Environment variable naming extra directories to scan.
pub const EXTRA_PATHS_VAR: &str = "CHORD_COMPOSER_VST3_PATH";

/// Every `.vst3` under `root`, following the vendor subdirectories that
/// installers commonly create.
///
/// A `.vst3` *directory* is a bundle and is itself the result — the walk does
/// not descend into it, or it would find the DLL inside and report it twice.
fn collect_modules(root: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    // Vendor nesting is one or two deep in practice; the bound is what stops a
    // symlink loop from turning a scan into a hang.
    if depth > 4 {
        return;
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vst3")) {
            out.push(path);
        } else if path.is_dir() {
            collect_modules(&path, out, depth + 1);
        }
    }
}

/// Load every installed module and report the instrument classes found.
///
/// A module that fails to load is skipped rather than aborting the scan: one
/// broken plugin must not cost the user every other plugin they own.
pub fn scan() -> Vec<PluginInfo> {
    let mut module_paths = Vec::new();
    for root in search_paths() {
        collect_modules(&root, &mut module_paths, 0);
    }

    let mut found: Vec<PluginInfo> = Vec::new();

    for path in module_paths {
        match Module::load(&path) {
            Ok(module) => {
                for info in module.classes() {
                    if !info.is_instrument() {
                        continue;
                    }
                    if found.iter().any(|f| f.class_id == info.class_id) {
                        continue;
                    }
                    found.push(info);
                }
            }
            Err(err) => {
                eprintln!("vst3: skipping {}: {err}", path.display());
            }
        }
    }

    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_modules_treats_a_bundle_as_a_leaf() {
        let tmp = std::env::temp_dir().join(format!("cc-vst3-scan-{}", std::process::id()));
        let bundle = tmp.join("Vendor").join("Thing.vst3");
        let inner = bundle.join("Contents").join("x86_64-win");
        std::fs::create_dir_all(&inner).unwrap();
        // The binary inside the bundle shares the `.vst3` extension; finding it
        // as well would report the same plugin twice.
        std::fs::write(inner.join("Thing.vst3"), b"not a real dll").unwrap();

        let mut out = Vec::new();
        collect_modules(&tmp, &mut out, 0);

        assert_eq!(out, vec![bundle]);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_modules_is_quiet_about_a_missing_root() {
        let mut out = Vec::new();
        collect_modules(Path::new("Z:\\definitely\\not\\here"), &mut out, 0);
        assert!(out.is_empty());
    }

    #[test]
    fn collect_modules_bounds_its_depth() {
        let tmp = std::env::temp_dir().join(format!("cc-vst3-deep-{}", std::process::id()));
        let mut deep = tmp.clone();
        for i in 0..8 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("Buried.vst3"), b"x").unwrap();

        let mut out = Vec::new();
        collect_modules(&tmp, &mut out, 0);
        assert!(out.is_empty(), "should not have descended that far");

        std::fs::remove_dir_all(&tmp).ok();
    }
}
