use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::PathBuf;

use crate::error::AppError;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::save_file_path;
#[cfg(target_os = "macos")]
use super::save_named;

pub fn paste_clipboard(dir: &Path) -> Result<Vec<String>, AppError> {
    #[cfg(target_os = "macos")]
    {
        paste_clipboard_macos(dir)
    }
    #[cfg(target_os = "windows")]
    {
        paste_clipboard_windows(dir)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = dir;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
struct AutoreleasePool(*mut std::ffi::c_void);

#[cfg(target_os = "macos")]
impl AutoreleasePool {
    unsafe fn new() -> Self {
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_autoreleasePoolPush() -> *mut std::ffi::c_void;
        }
        Self(objc_autoreleasePoolPush())
    }
}

#[cfg(target_os = "macos")]
impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_autoreleasePoolPop(pool: *mut std::ffi::c_void);
        }
        unsafe {
            objc_autoreleasePoolPop(self.0);
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn tiff_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::ffi::{c_char, c_void};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    unsafe {
        let _pool = AutoreleasePool::new();
        let send_data: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            *const u8,
            usize,
        ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let send_obj1: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_rep: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            usize,
            *mut c_void,
        ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let send_len: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let send_bytes: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const u8 =
            std::mem::transmute(objc_msgSend as *const ());

        let ns_data_cls = objc_getClass(c"NSData".as_ptr());
        let sel_data = sel_registerName(c"dataWithBytes:length:".as_ptr());
        let ns_data = send_data(ns_data_cls, sel_data, bytes.as_ptr(), bytes.len());
        if ns_data.is_null() {
            return None;
        }

        let rep_cls = objc_getClass(c"NSBitmapImageRep".as_ptr());
        let sel_rep = sel_registerName(c"imageRepWithData:".as_ptr());
        let rep = send_obj1(rep_cls, sel_rep, ns_data);
        if rep.is_null() {
            return None;
        }

        // NSBitmapImageFileTypePNG = 4
        let sel_png = sel_registerName(c"representationUsingType:properties:".as_ptr());
        let png_data = send_rep(rep, sel_png, 4, std::ptr::null_mut());
        if png_data.is_null() {
            return None;
        }

        let len = send_len(png_data, sel_registerName(c"length".as_ptr()));
        let ptr = send_bytes(png_data, sel_registerName(c"bytes".as_ptr()));
        if len == 0 || ptr.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(ptr, len).to_vec())
    }
}

#[cfg(target_os = "macos")]
fn paste_clipboard_macos(dir: &Path) -> Result<Vec<String>, AppError> {
    use std::ffi::{c_char, c_void, CStr};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    unsafe {
        let _pool = AutoreleasePool::new();
        let send0: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_str: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_obj1: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_count: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let send_idx: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_utf8: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const c_char =
            std::mem::transmute(objc_msgSend as *const ());
        let send_bytes: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const u8 =
            std::mem::transmute(objc_msgSend as *const ());

        let ns_string_cls = objc_getClass(c"NSString".as_ptr());
        let sel_utf8_str = sel_registerName(c"stringWithUTF8String:".as_ptr());
        let make_nsstring =
            |s: &CStr| -> *mut c_void { send_str(ns_string_cls, sel_utf8_str, s.as_ptr()) };

        let pb_cls = objc_getClass(c"NSPasteboard".as_ptr());
        let pb = send0(pb_cls, sel_registerName(c"generalPasteboard".as_ptr()));
        if pb.is_null() {
            return Ok(Vec::new());
        }

        // 1. Check for copied files from Finder (NSFilenamesPboardType)
        let sel_prop = sel_registerName(c"propertyListForType:".as_ptr());
        let filenames_type = make_nsstring(c"NSFilenamesPboardType");
        let file_array = send_obj1(pb, sel_prop, filenames_type);
        let mut results = Vec::new();
        if !file_array.is_null() {
            let count = send_count(file_array, sel_registerName(c"count".as_ptr()));
            let sel_obj_at = sel_registerName(c"objectAtIndex:".as_ptr());
            let sel_cstr = sel_registerName(c"UTF8String".as_ptr());
            for i in 0..count {
                let item = send_idx(file_array, sel_obj_at, i);
                if item.is_null() {
                    continue;
                }
                let cstr = send_utf8(item, sel_cstr);
                if cstr.is_null() {
                    continue;
                }
                if let Ok(path_str) = CStr::from_ptr(cstr).to_str() {
                    let path = PathBuf::from(path_str);
                    if path.is_file() {
                        if let Ok(md) = save_file_path(dir, &path) {
                            results.push(md);
                        }
                    }
                }
            }
            if !results.is_empty() {
                return Ok(results);
            }
        }

        // 2. Also check public.file-url if NSFilenamesPboardType was empty
        let sel_str_for = sel_registerName(c"stringForType:".as_ptr());
        let file_url_type = make_nsstring(c"public.file-url");
        let file_url_ns = send_obj1(pb, sel_str_for, file_url_type);
        if !file_url_ns.is_null() {
            let ns_url_cls = objc_getClass(c"NSURL".as_ptr());
            let url = send_obj1(
                ns_url_cls,
                sel_registerName(c"URLWithString:".as_ptr()),
                file_url_ns,
            );
            if !url.is_null() {
                let path_ns = send0(url, sel_registerName(c"path".as_ptr()));
                if !path_ns.is_null() {
                    let cstr = send_utf8(path_ns, sel_registerName(c"UTF8String".as_ptr()));
                    if !cstr.is_null() {
                        if let Ok(path_str) = CStr::from_ptr(cstr).to_str() {
                            let path = PathBuf::from(path_str);
                            if path.is_file() {
                                if let Ok(md) = save_file_path(dir, &path) {
                                    return Ok(vec![md]);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Check for PNG, JPEG, or TIFF image data on clipboard
        let sel_data_for = sel_registerName(c"dataForType:".as_ptr());
        let plain_text = send_obj1(pb, sel_str_for, make_nsstring(c"public.utf8-plain-text"));
        if !plain_text.is_null() {
            let cstr = send_utf8(plain_text, sel_registerName(c"UTF8String".as_ptr()));
            if !cstr.is_null() && !CStr::from_ptr(cstr).to_bytes().is_empty() {
                return Ok(Vec::new());
            }
        }

        let sel_len = sel_registerName(c"length".as_ptr());
        let sel_bytes = sel_registerName(c"bytes".as_ptr());

        for uti in [c"public.png", c"public.jpeg", c"public.tiff"] {
            let data = send_obj1(pb, sel_data_for, make_nsstring(uti));
            if data.is_null() {
                continue;
            }
            let len = send_count(data, sel_len);
            let ptr = send_bytes(data, sel_bytes);
            if len == 0 || ptr.is_null() {
                continue;
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            if let Ok(md) = save_named(dir, slice, None, None) {
                return Ok(vec![md]);
            }
        }

        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn paste_clipboard_windows(dir: &Path) -> Result<Vec<String>, AppError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const CF_HDROP: u32 = 15;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(
            hdrop: *mut std::ffi::c_void,
            index: u32,
            buf: *mut u16,
            size: u32,
        ) -> u32;
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Ok(Vec::new());
        }
        let _guard = ClipboardGuard;
        let mut results = Vec::new();
        let hdrop = GetClipboardData(CF_HDROP);
        if !hdrop.is_null() {
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; (len + 1) as usize];
                let copied = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), len + 1);
                if copied > 0 {
                    let path = PathBuf::from(OsString::from_wide(&buf[..copied as usize]));
                    if path.is_file() {
                        if let Ok(md) = save_file_path(dir, &path) {
                            results.push(md);
                        }
                    }
                }
            }
        }
        Ok(results)
    }
}
