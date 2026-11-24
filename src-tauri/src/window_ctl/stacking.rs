//! The pinned tab strip stays above the memos. Memos and the strip are both
//! always on top, and within that band the window clicked last comes first,
//! so a memo picked under the strip would cover it.

use tauri::{AppHandle, Manager, WebviewWindow};

use super::{is_pin_strip, pinned_always_on_top};

/// Bring every tab strip in front of the memos, without taking focus.
pub(super) fn raise_strips(app: &AppHandle) {
    let on_top = pinned_always_on_top(app);
    for (label, window) in app.webview_windows() {
        if is_pin_strip(&label) && window.is_visible().unwrap_or(false) {
            raise_strip(&window, on_top);
        }
    }
}

/// Put one strip in front of the memos. `on_top`: memos float above other apps.
pub(super) fn raise_strip(window: &WebviewWindow, on_top: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || raise_now(&target, on_top));
}

#[cfg(target_os = "macos")]
fn raise_now(window: &WebviewWindow, on_top: bool) {
    use std::ffi::{c_char, c_void};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    // Memos float at NSFloatingWindowLevel (3); one level up keeps the strip
    // above them and still under menus, panels, and the Dock.
    const ABOVE_FLOATING: isize = 4;
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    if ns_window.is_null() {
        return;
    }
    unsafe {
        if on_top {
            let set_level: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) =
                std::mem::transmute(objc_msgSend as *const ());
            set_level(
                ns_window,
                sel_registerName(c"setLevel:".as_ptr()),
                ABOVE_FLOATING,
            );
        }
        let order_front: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        order_front(
            ns_window,
            sel_registerName(c"orderFrontRegardless".as_ptr()),
        );
    }
}

#[cfg(target_os = "windows")]
fn raise_now(window: &WebviewWindow, on_top: bool) {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const HWND_TOP: isize = 0;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        SetWindowPos(
            hwnd.0.cast(),
            if on_top { HWND_TOPMOST } else { HWND_TOP },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn raise_now(window: &WebviewWindow, on_top: bool) {
    if on_top {
        let _ = window.set_always_on_top(true);
    }
}
