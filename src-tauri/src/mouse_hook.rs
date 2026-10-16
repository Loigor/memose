use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use tauri::AppHandle;

use crate::shortcuts;

struct Press {
    button: u8,
    alt: bool,
    ctrl: bool,
    shift: bool,
    meta: bool,
}

static TX: Mutex<Option<Sender<Press>>> = Mutex::new(None);

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Press>();
    if let Ok(mut slot) = TX.lock() {
        *slot = Some(tx);
    }
    std::thread::spawn(move || {
        while let Ok(press) = rx.recv() {
            let app = app.clone();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                shortcuts::dispatch_mouse(&handle, press.button, press.alt, press.ctrl, press.shift, press.meta);
            });
        }
    });
    std::thread::spawn(listen);
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn emit(button: u8, alt: bool, ctrl: bool, shift: bool, meta: bool) {
    let Ok(slot) = TX.lock() else {
        return;
    };
    if let Some(tx) = slot.as_ref() {
        let _ = tx.send(Press {
            button,
            alt,
            ctrl,
            shift,
            meta,
        });
    }
}

#[cfg(target_os = "macos")]
fn listen() {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};

    type MachPort = *mut c_void;
    type Event = *mut c_void;

    const SESSION: u32 = 1;
    const HEAD: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const BUTTON_NUMBER: u32 = 3;
    const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
    const SHIFT: u64 = 0x0002_0000;
    const CONTROL: u64 = 0x0004_0000;
    const ALTERNATE: u64 = 0x0008_0000;
    const COMMAND: u64 = 0x0010_0000;

    static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    unsafe extern "C" fn callback(
        _proxy: *mut c_void,
        kind: u32,
        event: Event,
        _user: *mut c_void,
    ) -> Event {
        if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER {
            let tap = TAP.load(Ordering::Relaxed);
            if !tap.is_null() {
                CGEventTapEnable(tap, true);
            }
            return event;
        }
        let button = CGEventGetIntegerValueField(event, BUTTON_NUMBER) as u8;
        let mouse = button.saturating_add(1);
        if (3..=8).contains(&mouse) {
            let flags = CGEventGetFlags(event);
            emit(
                mouse,
                flags & ALTERNATE != 0,
                flags & CONTROL != 0,
                flags & SHIFT != 0,
                flags & COMMAND != 0,
            );
        }
        event
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events: u64,
            callback: unsafe extern "C" fn(*mut c_void, u32, Event, *mut c_void) -> Event,
            user: *mut c_void,
        ) -> MachPort;
        fn CGEventTapEnable(tap: MachPort, enable: bool);
        fn CGEventGetFlags(event: Event) -> u64;
        fn CGEventGetIntegerValueField(event: Event, field: u32) -> i64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFRunLoopCommonModes: *const c_void;
        fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: MachPort, order: isize) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
    }

    unsafe {
        let mask = 1u64 << OTHER_MOUSE_DOWN;
        let tap = CGEventTapCreate(SESSION, HEAD, LISTEN_ONLY, mask, callback, std::ptr::null_mut());
        if tap.is_null() {
            eprintln!("memose: side-button shortcuts from other apps need Accessibility permission");
            return;
        }
        TAP.store(tap, Ordering::Relaxed);
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        CFRunLoopRun();
    }
}

#[cfg(target_os = "windows")]
fn listen() {
    use std::ffi::c_void;

    const WH_MOUSE_LL: i32 = 14;
    const WM_MBUTTONDOWN: usize = 0x0207;
    const WM_XBUTTONDOWN: usize = 0x020B;
    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    #[repr(C)]
    #[allow(dead_code)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct Hook {
        pt: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }

    unsafe extern "system" fn proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 {
            let button = if wparam == WM_MBUTTONDOWN {
                3
            } else if wparam == WM_XBUTTONDOWN {
                let data = &*(lparam as *const Hook);
                let which = (data.mouse_data >> 16) & 0xFFFF;
                if which == 1 {
                    4
                } else if which == 2 {
                    5
                } else {
                    0
                }
            } else {
                0
            };
            if (3..=8).contains(&button) {
                let down = |key: i32| GetAsyncKeyState(key) as u16 & 0x8000 != 0;
                emit(button, down(VK_MENU), down(VK_CONTROL), down(VK_SHIFT), down(VK_LWIN) || down(VK_RWIN));
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(
            id: i32,
            hook: unsafe extern "system" fn(i32, usize, isize) -> isize,
            module: *mut c_void,
            thread: u32,
        ) -> *mut c_void;
        fn CallNextHookEx(hook: *mut c_void, code: i32, wparam: usize, lparam: isize) -> isize;
        fn GetMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
    }

    unsafe {
        let hook = SetWindowsHookExW(WH_MOUSE_LL, proc, std::ptr::null_mut(), 0);
        if hook.is_null() {
            eprintln!("memose: could not listen for side-button shortcuts");
            return;
        }
        let mut msg = std::mem::zeroed::<Msg>();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn listen() {}
