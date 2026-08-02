//! Loading a `.vst3` from disk and getting at its plugin factory.
//!
//! A VST3 "module" on Windows is either a plain DLL named `Something.vst3`, or —
//! far more commonly since VST 3.6.10 — a *bundle*: a directory of that name with
//! the actual DLL buried at `Contents/x86_64-win/Something.vst3`. Both forms are
//! in the wild simultaneously, so both are resolved here rather than at the call
//! site.

use std::ffi::{c_char, CStr, OsStr};
use std::path::{Path, PathBuf};

use vst3::Steinberg::{
    IPluginFactory, IPluginFactory2, IPluginFactory2Trait, IPluginFactoryTrait, PClassInfo,
    PClassInfo2, TUID,
};
use vst3::ComPtr;

/// The `PClassInfo::category` value marking a class as an audio plug-in.
/// Spelled out because the SDK defines it as a C `#define`, which the binding
/// generator does not emit.
const K_VST_AUDIO_EFFECT_CLASS: &str = "Audio Module Class";

/// The architecture subdirectory inside a bundle. 32-bit hosts are not a target.
const ARCH_DIR: &str = "x86_64-win";

/// Everything the app needs to know about one plugin class, flattened for IPC.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// The 16-byte TUID as 32 lowercase hex characters.
    ///
    /// These are the raw bytes exactly as the plugin reports them, not the
    /// SDK's canonical registry formatting. That is deliberate: the id is only
    /// ever compared against itself and used to find this plugin again, so a
    /// consistent encoding matters and a *canonical* one does not.
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    /// The plugin's own subcategory string, e.g. `Instrument|Synth`.
    pub sub_categories: String,
    /// Absolute path to the `.vst3` the class was found in.
    pub path: String,
}

impl PluginInfo {
    /// Whether the class makes sound of its own, as opposed to processing it.
    ///
    /// Only instruments can sit on a track, because a track is a source of
    /// notes and nothing else. Effects are out of scope.
    pub fn is_instrument(&self) -> bool {
        self.sub_categories
            .split('|')
            .any(|part| part.eq_ignore_ascii_case("Instrument"))
    }
}

/// `GetPluginFactory` — the one export every VST3 module must have.
type GetPluginFactoryProc = unsafe extern "system" fn() -> *mut IPluginFactory;
/// `InitDll` — optional, but must be called before the factory if present.
type InitDllProc = unsafe extern "system" fn() -> bool;
/// `ExitDll` — the counterpart to `InitDll`.
type ExitDllProc = unsafe extern "system" fn() -> bool;

/// A loaded VST3 module and its factory.
///
/// Field order is load-bearing: Rust drops fields in declaration order, and the
/// factory is a COM object living inside the library's address space. Releasing
/// it after the library unloaded would call a vtable that is no longer mapped.
pub struct Module {
    factory: ComPtr<IPluginFactory>,
    library: libloading::Library,
    path: PathBuf,
}

impl Module {
    /// Load the module at `path`, which may be either a bundle or a bare DLL.
    pub fn load(path: &Path) -> Result<Module, String> {
        let dll = resolve_binary(path)
            .ok_or_else(|| format!("no loadable binary inside {}", path.display()))?;

        // SAFETY: loading arbitrary third-party code is the entire point of a
        // plugin host. There is no way to make this safe, only deliberate.
        unsafe {
            let library = libloading::Library::new(&dll)
                .map_err(|e| format!("{}: {e}", dll.display()))?;

            // `InitDll` runs the module's static initialisers. A module that has
            // one and does not get it called may hand back a null factory.
            if let Ok(init) = library.get::<InitDllProc>(b"InitDll\0") {
                if !init() {
                    return Err(format!("{}: InitDll returned false", dll.display()));
                }
            }

            let get_factory = library
                .get::<GetPluginFactoryProc>(b"GetPluginFactory\0")
                .map_err(|e| format!("{}: no GetPluginFactory export: {e}", dll.display()))?;

            let raw = get_factory();
            let factory = ComPtr::from_raw(raw)
                .ok_or_else(|| format!("{}: GetPluginFactory returned null", dll.display()))?;

            Ok(Module {
                factory,
                library,
                path: path.to_path_buf(),
            })
        }
    }

    pub fn factory(&self) -> &ComPtr<IPluginFactory> {
        &self.factory
    }

    /// Every audio plug-in class the module exposes.
    ///
    /// Classes that are not audio plug-ins — the controller-only and
    /// helper classes some modules also register — are filtered out here, so
    /// callers never have to know they existed.
    pub fn classes(&self) -> Vec<PluginInfo> {
        // SAFETY: `self.factory` is non-null and the library is still loaded.
        unsafe {
            let factory2 = self.factory.cast::<IPluginFactory2>();
            let count = self.factory.countClasses();
            let mut out = Vec::new();

            for index in 0..count {
                // `IPluginFactory2` carries vendor, version and subcategories;
                // `IPluginFactory` carries none of them. Modules predating the
                // former still exist, so fall back rather than skipping them.
                let info = match &factory2 {
                    Some(f2) => {
                        let mut raw = std::mem::zeroed::<PClassInfo2>();
                        if f2.getClassInfo2(index, &mut raw) != vst3::Steinberg::kResultOk {
                            continue;
                        }
                        self.describe2(&raw)
                    }
                    None => {
                        let mut raw = std::mem::zeroed::<PClassInfo>();
                        if self.factory.getClassInfo(index, &mut raw)
                            != vst3::Steinberg::kResultOk
                        {
                            continue;
                        }
                        self.describe(&raw)
                    }
                };

                if let Some(info) = info {
                    out.push(info);
                }
            }

            out
        }
    }

    fn describe2(&self, raw: &PClassInfo2) -> Option<PluginInfo> {
        if c_string(&raw.category) != K_VST_AUDIO_EFFECT_CLASS {
            return None;
        }
        Some(PluginInfo {
            class_id: hex_tuid(&raw.cid),
            name: c_string(&raw.name),
            vendor: c_string(&raw.vendor),
            version: c_string(&raw.version),
            sub_categories: c_string(&raw.subCategories),
            path: self.path.to_string_lossy().into_owned(),
        })
    }

    fn describe(&self, raw: &PClassInfo) -> Option<PluginInfo> {
        if c_string(&raw.category) != K_VST_AUDIO_EFFECT_CLASS {
            return None;
        }
        Some(PluginInfo {
            class_id: hex_tuid(&raw.cid),
            name: c_string(&raw.name),
            vendor: String::new(),
            version: String::new(),
            // A factory this old predates subcategories. Claiming it is an
            // instrument is the useful guess: it is what the user is looking at.
            sub_categories: "Instrument".to_string(),
            path: self.path.to_string_lossy().into_owned(),
        })
    }
}

impl Drop for Module {
    fn drop(&mut self) {
        // `ExitDll` must run after the factory is released, and the factory is
        // released when this function returns — hence the explicit ordering
        // here rather than relying on field drop order alone.
        unsafe {
            if let Ok(exit) = self.library.get::<ExitDllProc>(b"ExitDll\0") {
                let _ = exit();
            }
        }
    }
}

/// The DLL to actually hand to `LoadLibrary`.
///
/// Returns `None` when the path is a bundle with no binary for this
/// architecture — a 32-bit-only plugin on a 64-bit host, typically.
fn resolve_binary(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }

    if !path.is_dir() {
        return None;
    }

    // A bundle names its binary after the bundle itself.
    let file_name = path.file_name()?;
    let candidate = path.join("Contents").join(ARCH_DIR).join(file_name);
    if candidate.is_file() {
        return Some(candidate);
    }

    // Some bundles name the binary differently from the directory. Take whatever
    // single `.vst3` is in the arch directory rather than giving up.
    let arch_dir = path.join("Contents").join(ARCH_DIR);
    let entry = std::fs::read_dir(arch_dir)
        .ok()?
        .flatten()
        .find(|e| e.path().extension() == Some(OsStr::new("vst3")))?;

    Some(entry.path())
}

/// A fixed-size, NUL-padded C string field as a Rust `String`.
///
/// Plugin-supplied and therefore not to be trusted: a field with no NUL at all
/// is read to its end rather than running off it, and invalid UTF-8 is replaced
/// rather than rejected.
fn c_string(buf: &[c_char]) -> String {
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast(), buf.len()) };
    match CStr::from_bytes_until_nul(bytes) {
        Ok(s) => s.to_string_lossy().into_owned(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// A TUID as 32 lowercase hex characters, matching `instrumentRef.ts`.
pub fn hex_tuid(cid: &TUID) -> String {
    let mut s = String::with_capacity(32);
    for byte in cid {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", *byte as u8);
    }
    s
}

/// The inverse of [`hex_tuid`], for turning a stored id back into a TUID.
pub fn tuid_from_hex(hex: &str) -> Option<TUID> {
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut cid: TUID = [0; 16];
    for (i, slot) in cid.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()? as c_char;
    }
    Some(cid)
}

/// Whether two class ids name the same class.
pub fn tuid_matches(cid: &TUID, hex: &str) -> bool {
    hex_tuid(cid) == hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_tuid_round_trips() {
        let cid: TUID = [
            0x56, 0x53, 0x54, 0x41, 0x6d, 0x73, 0x6e, 0x6f, 0x53, 0x75, 0x72, 0x67, 0x65, 0x20,
            0x58, 0xab_u8 as c_char,
        ];
        let hex = hex_tuid(&cid);
        assert_eq!(hex, "565354416d736e6f53757267652058ab");
        assert_eq!(tuid_from_hex(&hex), Some(cid));
        assert!(tuid_matches(&cid, &hex));
    }

    #[test]
    fn tuid_from_hex_rejects_malformed() {
        assert_eq!(tuid_from_hex(""), None);
        assert_eq!(tuid_from_hex("abc"), None);
        // 32 characters but not hex.
        assert_eq!(tuid_from_hex(&"z".repeat(32)), None);
        // Valid hex, wrong length.
        assert_eq!(tuid_from_hex(&"ab".repeat(15)), None);
    }

    #[test]
    fn c_string_stops_at_nul() {
        let mut buf = [0 as c_char; 8];
        for (i, b) in b"hi\0junk".iter().enumerate() {
            buf[i] = *b as c_char;
        }
        assert_eq!(c_string(&buf), "hi");
    }

    #[test]
    fn c_string_tolerates_a_field_with_no_terminator() {
        let buf: Vec<c_char> = b"abcd".iter().map(|b| *b as c_char).collect();
        assert_eq!(c_string(&buf), "abcd");
    }

    #[test]
    fn is_instrument_reads_the_subcategory_list() {
        let mut info = PluginInfo {
            class_id: "0".repeat(32),
            name: "X".into(),
            vendor: String::new(),
            version: String::new(),
            sub_categories: "Instrument|Synth".into(),
            path: String::new(),
        };
        assert!(info.is_instrument());

        info.sub_categories = "Fx|Delay".into();
        assert!(!info.is_instrument());

        // Substring matches must not count: "Instrumental" is not "Instrument".
        info.sub_categories = "Instrumental".into();
        assert!(!info.is_instrument());
    }
}
