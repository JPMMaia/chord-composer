//! A plugin's own editor, in a native window.
//!
//! A VST3 editor is not something the host draws. The plugin hands back an
//! `IPlugView` and the host gives it a native window to live inside; everything
//! after that — knobs, meters, skin — is the plugin's own code drawing into it.
//!
//! Two constraints shape all of this:
//!
//! - **It cannot go in the webview's window.** The webview covers its client
//!   area completely, so the editor gets its own top-level window.
//! - **It is main-thread only.** VST3 editors have UI-thread affinity, and
//!   Tauri's command handlers do not run on the main thread. Every entry point
//!   here marshals across before it touches a view.

#![cfg(windows)]

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Mutex;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRect, CreateWindowExW, DefWindowProcW, DestroyWindow, LoadCursorW,
    RegisterClassExW, SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, HMENU, IDC_ARROW,
    SWP_NOMOVE, SWP_NOZORDER, SW_SHOW, WINDOW_EX_STYLE, WM_CLOSE, WM_DESTROY, WNDCLASSEXW,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

use vst3::Steinberg::Vst::{IEditController, IEditControllerTrait, ViewType};
use vst3::Steinberg::{
    kPlatformTypeHWND, kResultOk, tresult, IPlugFrame, IPlugFrameTrait, IPlugView, IPlugViewTrait,
    ViewRect,
};
use vst3::{Class, ComPtr, ComWrapper};

/// The window class every editor window is created from. Registered once.
const CLASS_NAME: &str = "ChordComposerPluginEditor";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// One open editor: the plugin's view and the window it is attached to.
struct OpenEditor {
    view: ComPtr<IPlugView>,
    frame: ComWrapper<PlugFrame>,
    hwnd: HWND,
}

// SAFETY: only ever created, touched and dropped on the main thread; the map
// below is what carries them between calls, and every access marshals first.
unsafe impl Send for OpenEditor {}

/// Editors currently open, by track id.
static OPEN: Mutex<Option<HashMap<String, OpenEditor>>> = Mutex::new(None);

/// The host side of view resizing.
///
/// A plugin that changes its own size — switching to an expanded panel, say —
/// tells the host through this, and the host is what actually resizes the
/// window. Without it such plugins are clipped.
struct PlugFrame {
    hwnd: Cell<isize>,
}

// SAFETY: as `OpenEditor` — main thread only.
unsafe impl Sync for PlugFrame {}

impl Class for PlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for PlugFrame {
    unsafe fn resizeView(&self, view: *mut IPlugView, new_size: *mut ViewRect) -> tresult {
        if new_size.is_null() {
            return kResultOk;
        }
        let rect = *new_size;
        let hwnd = HWND(self.hwnd.get() as *mut _);

        if !hwnd.is_invalid() {
            resize_to(hwnd, &rect);
        }
        // The plugin only actually adopts the size once told the host complied.
        if let Some(view) = vst3::ComRef::from_raw(view) {
            view.onSize(new_size);
        }
        kResultOk
    }
}

/// Size the window so its *client* area matches the view exactly.
///
/// The view's rect is the drawing area; a window's is the drawing area plus its
/// frame and title bar. Setting the latter to the former crops the editor by
/// however thick the chrome is.
fn resize_to(hwnd: HWND, view: &ViewRect) {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: view.right - view.left,
        bottom: view.bottom - view.top,
    };

    unsafe {
        let _ = AdjustWindowRect(&mut rect, WS_OVERLAPPEDWINDOW, false);
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOMOVE | SWP_NOZORDER,
        );
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        // Closing the editor must detach the view first. Destroying a window
        // with a plugin still drawing into it crashes the plugin, not the host.
        WM_CLOSE => {
            close_by_hwnd(hwnd);
            LRESULT(0)
        }
        // The editor is one window among several; its death is not the app's.
        WM_DESTROY => LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Register the window class, once per process.
fn ensure_class() -> Result<(), String> {
    static REGISTERED: Mutex<bool> = Mutex::new(false);
    let mut registered = REGISTERED.lock().unwrap();
    if *registered {
        return Ok(());
    }

    unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandle: {e}"))?;
        let class_name = wide(CLASS_NAME);

        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };

        if RegisterClassExW(&class) == 0 {
            return Err("could not register the editor window class".to_string());
        }
    }

    *registered = true;
    Ok(())
}

/// Open `controller`'s editor in a new window. Main thread only.
pub fn open(track_id: &str, title: &str, controller: &ComPtr<IEditController>) -> Result<(), String> {
    // Already open: bring it forward rather than making a second one.
    {
        let guard = OPEN.lock().unwrap();
        if let Some(map) = guard.as_ref() {
            if let Some(existing) = map.get(track_id) {
                unsafe {
                    let _ = ShowWindow(existing.hwnd, SW_SHOW);
                }
                return Ok(());
            }
        }
    }

    ensure_class()?;

    // SAFETY: main thread, and every pointer outlives the call it is used in.
    unsafe {
        let view = ComPtr::from_raw(controller.createView(ViewType::kEditor))
            .ok_or("this plugin has no editor")?;

        if view.isPlatformTypeSupported(kPlatformTypeHWND) != kResultOk {
            return Err("this plugin's editor cannot be hosted in a Windows window".to_string());
        }

        let mut size = ViewRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        };
        // A plugin that will not state a size gets the default above rather
        // than a zero-sized window.
        view.getSize(&mut size);

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: size.right - size.left,
            bottom: size.bottom - size.top,
        };
        let _ = AdjustWindowRect(&mut rect, WS_OVERLAPPEDWINDOW, false);

        let instance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandle: {e}"))?;
        let class_name = wide(CLASS_NAME);
        let window_title = wide(title);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(window_title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            i32::MIN, // CW_USEDEFAULT
            i32::MIN,
            rect.right - rect.left,
            rect.bottom - rect.top,
            HWND::default(),
            HMENU::default(),
            windows::Win32::Foundation::HINSTANCE::from(instance),
            None,
        )
        .map_err(|e| format!("could not create the editor window: {e}"))?;

        let frame = ComWrapper::new(PlugFrame {
            hwnd: Cell::new(hwnd.0 as isize),
        });
        if let Some(ptr) = frame.to_com_ptr::<IPlugFrame>() {
            // Set before `attached`: a plugin may ask to resize during it.
            view.setFrame(ptr.as_ptr());
        }

        if view.attached(hwnd.0 as *mut _, kPlatformTypeHWND) != kResultOk {
            let _ = DestroyWindow(hwnd);
            return Err("the plugin refused to attach its editor".to_string());
        }

        let _ = ShowWindow(hwnd, SW_SHOW);

        OPEN.lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(track_id.to_string(), OpenEditor { view, frame, hwnd });
    }

    Ok(())
}

/// Close a track's editor, if it has one open. Main thread only.
pub fn close(track_id: &str) {
    let editor = OPEN
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|map| map.remove(track_id));

    if let Some(editor) = editor {
        detach(editor);
    }
}

/// The reverse of `open`, in the order the plugin requires.
fn detach(editor: OpenEditor) {
    // SAFETY: main thread. `removed` must come before the window goes away.
    unsafe {
        editor.view.setFrame(std::ptr::null_mut());
        editor.view.removed();
        let _ = DestroyWindow(editor.hwnd);
    }
    drop(editor.frame);
}

/// Close whichever editor owns `hwnd`. Called from the window procedure.
fn close_by_hwnd(hwnd: HWND) {
    let editor = {
        let mut guard = OPEN.lock().unwrap();
        let Some(map) = guard.as_mut() else { return };
        let key = map
            .iter()
            .find(|(_, e)| e.hwnd == hwnd)
            .map(|(k, _)| k.clone());
        key.and_then(|k| map.remove(&k))
    };

    if let Some(editor) = editor {
        detach(editor);
    }
}

/// Whether a track's editor is currently open.
pub fn is_open(track_id: &str) -> bool {
    OPEN.lock()
        .unwrap()
        .as_ref()
        .is_some_and(|map| map.contains_key(track_id))
}
