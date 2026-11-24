//! macOS keeps every window's top edge below the menu bar, borderless ones too.
//! A memo window carries a transparent shadow gutter above its card, so that
//! rule stopped the card a gutter's height short of the top of the screen.
//! Untitled windows skip the rule here; titled windows (settings) keep it.

#[cfg(target_os = "macos")]
pub(super) fn allow_above_menu_bar(window: &tauri::WebviewWindow) {
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Once;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    type Constrain = unsafe extern "C" fn(*mut c_void, *mut c_void, Rect, *mut c_void) -> Rect;
    type StyleMask = unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn object_getClass(obj: *mut c_void) -> *mut c_void;
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn class_getSuperclass(cls: *mut c_void) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_getInstanceMethod(cls: *mut c_void, sel: *mut c_void) -> *mut c_void;
        fn method_getImplementation(method: *mut c_void) -> *mut c_void;
        fn class_addMethod(
            cls: *mut c_void,
            sel: *mut c_void,
            imp: *mut c_void,
            types: *const c_char,
        ) -> bool;
        fn objc_msgSend();
    }

    const TITLED: usize = 1;
    static ORIGINAL: AtomicUsize = AtomicUsize::new(0);
    static INSTALL: Once = Once::new();

    unsafe extern "C" fn constrain(
        this: *mut c_void,
        cmd: *mut c_void,
        rect: Rect,
        screen: *mut c_void,
    ) -> Rect {
        let style_mask: StyleMask = std::mem::transmute(objc_msgSend as *const ());
        let mask = style_mask(this, sel_registerName(c"styleMask".as_ptr()));
        let original = ORIGINAL.load(Ordering::SeqCst);
        if mask & TITLED == 0 || original == 0 {
            return rect;
        }
        let original: Constrain = std::mem::transmute(original);
        original(this, cmd, rect, screen)
    }

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    if ns_window.is_null() {
        return;
    }
    INSTALL.call_once(|| unsafe {
        let ns_window_class = objc_getClass(c"NSWindow".as_ptr());
        if ns_window_class.is_null() {
            return;
        }
        // Add the override to tao's own NSWindow subclass, under any KVO class.
        let mut class = object_getClass(ns_window);
        while !class.is_null() && class_getSuperclass(class) != ns_window_class {
            class = class_getSuperclass(class);
        }
        if class.is_null() {
            return;
        }
        let sel = sel_registerName(c"constrainFrameRect:toScreen:".as_ptr());
        let method = class_getInstanceMethod(ns_window_class, sel);
        if method.is_null() {
            return;
        }
        ORIGINAL.store(method_getImplementation(method) as usize, Ordering::SeqCst);
        class_addMethod(
            class,
            sel,
            constrain as *mut c_void,
            c"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@".as_ptr(),
        );
    });
}

#[cfg(not(target_os = "macos"))]
pub(super) fn allow_above_menu_bar(_window: &tauri::WebviewWindow) {}
