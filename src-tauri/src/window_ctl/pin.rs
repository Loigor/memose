use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use super::composer::{composer_open, dismiss_composer};
use super::geom::{first_open_tile, grid_slot, nudge_origin, organize_grid, visual_card};
use super::{
    contains, drag_active, follow_active, hide_pin_tabs, monitor_for_placement, parks, pin_label,
    place_at, raise_pin_tabs, save_pin_frame, schedule_resign, schedule_settle, show_pin_tabs,
    slide_back, snap_enabled, suppress_settle, CARD_HEIGHT, CARD_PAD_BOTTOM, CARD_PAD_TOP,
    CARD_PAD_X, CARD_WIDTH, ORGANIZE_GAP, WINDOW,
};
use crate::notes::request_sync;
use crate::state::AppState;

const PIN_CASCADE: i32 = 36;

pub fn toggle_pinned(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.pinned_mode.load(Ordering::SeqCst) {
        state.pinned_mode.store(false, Ordering::SeqCst);
        hide_pinned(app);
        hide_pin_tabs(app);
        if !composer_open(app) {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        return;
    }
    state.pinned_mode.store(true, Ordering::SeqCst);
    open_pinned_windows(app);
    dismiss_composer(app);
    request_sync(app);
}

fn active_pin_note_ids(app: &tauri::AppHandle) -> HashSet<String> {
    match app.state::<AppState>().db.pin_tabs() {
        Ok(state) => state.active_note_ids(),
        Err(err) => {
            eprintln!("memose: pin tabs failed: {err}");
            HashSet::new()
        }
    }
}

pub(super) fn open_pinned_windows(app: &tauri::AppHandle) {
    let notes = match app.state::<AppState>().db.list_pinned() {
        Ok(notes) => notes,
        Err(err) => {
            eprintln!("memose: pinned notes failed: {err}");
            return;
        }
    };
    let active = active_pin_note_ids(app);
    let mut keep = HashSet::new();
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    for note in notes {
        if note.stack_host.is_some() || !active.contains(&note.id) {
            continue;
        }
        keep.insert(note.id.clone());
        open_pin(app, &note.id);
    }
    for (label, window) in app.webview_windows() {
        let Some(id) = label.strip_prefix("pin-") else {
            continue;
        };
        if keep.contains(id) {
            continue;
        }
        if window.is_visible().unwrap_or(false) {
            save_pin_frame(app, id, &window);
        }
        let _ = window.set_always_on_top(false);
        let _ = window.hide();
    }
    if app.state::<AppState>().pinned_mode.load(Ordering::SeqCst) {
        show_pin_tabs(app);
    }
}

pub fn organize_pinned(app: &tauri::AppHandle) {
    let notes = match app.state::<AppState>().db.list_pinned() {
        Ok(notes) => notes,
        Err(err) => {
            eprintln!("memose: pinned notes failed: {err}");
            return;
        }
    };
    if notes.is_empty() {
        return;
    }
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| contains(monitor, cursor))
        .cloned()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let layout = organize_grid(
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        (CARD_WIDTH * scale).round() as i32,
        (CARD_HEIGHT * scale).round() as i32,
        (CARD_PAD_X * scale).round() as i32,
        (CARD_PAD_TOP * scale).round() as i32,
        (CARD_PAD_BOTTOM * scale).round() as i32,
        (ORGANIZE_GAP * scale).round() as i32,
    );
    let win_w = (CARD_WIDTH * scale).round() as i32;
    let win_h = (CARD_HEIGHT * scale).round() as i32;
    let active = active_pin_note_ids(app);
    let notes: Vec<_> = notes
        .into_iter()
        .filter(|note| note.stack_host.is_none() && active.contains(&note.id))
        .collect();
    for (index, note) in notes.iter().enumerate() {
        let (x, y) = grid_slot(
            index,
            layout.columns,
            layout.origin_x,
            layout.origin_y,
            layout.step_x,
            layout.step_y,
            0,
        );
        let label = pin_label(&note.id);
        suppress_settle(&label, Duration::from_millis(600));
        if let Ok(mut parked) = parks().lock() {
            parked.remove(&label);
        }
        let _ = app
            .state::<AppState>()
            .db
            .save_frame(&note.id, x, y, win_w, win_h);
        open_pin(app, &note.id);
    }
}

pub fn place_for_pin(app: &tauri::AppHandle, id: &str) {
    if snap_enabled(app) {
        if let Some(window) = app.get_webview_window(WINDOW) {
            if window.is_visible().unwrap_or(false) {
                if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    let _ = app.state::<AppState>().db.save_frame(
                        id,
                        position.x,
                        position.y,
                        size.width as i32,
                        size.height as i32,
                    );
                    return;
                }
            }
        }
    }
    place_in_free_space(app, id);
}

fn place_in_free_space(app: &tauri::AppHandle, id: &str) {
    let Some(monitor) = monitor_for_placement(app) else {
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_top = (CARD_PAD_TOP * scale).round() as i32;
    let pad_bottom = (CARD_PAD_BOTTOM * scale).round() as i32;
    let gap = (ORGANIZE_GAP * scale).round() as i32;
    let win_w = (CARD_WIDTH * scale).round() as i32;
    let win_h = (CARD_HEIGHT * scale).round() as i32;
    let layout = organize_grid(
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        win_w,
        win_h,
        pad_x,
        pad_top,
        pad_bottom,
        gap,
    );
    let occupied: Vec<(i32, i32, i32, i32)> = occupied_rects(app, id)
        .into_iter()
        .map(|(x, y, w, h)| visual_card(x, y, w, h, pad_x, pad_top, pad_bottom))
        .collect();
    let card = visual_card(0, 0, win_w, win_h, pad_x, pad_top, pad_bottom);
    let (x, y) = first_open_tile(
        &occupied,
        layout.origin_x,
        layout.origin_y,
        layout.step_x,
        layout.step_y,
        pad_x,
        pad_top,
        card.2,
        card.3,
        layout.columns,
        layout.rows,
        gap,
    );
    let _ = app
        .state::<AppState>()
        .db
        .save_frame(id, x, y, win_w, win_h);
}

fn occupied_rects(app: &tauri::AppHandle, except: &str) -> Vec<(i32, i32, i32, i32)> {
    let mut rects = Vec::new();
    if let Ok(notes) = app.state::<AppState>().db.list_pinned() {
        for note in notes {
            if note.id == except || note.stack_host.is_some() {
                continue;
            }
            if let (Some(x), Some(y), Some(w), Some(h)) =
                (note.win_x, note.win_y, note.win_w, note.win_h)
            {
                rects.push((x, y, w, h));
            }
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        if window.is_visible().unwrap_or(false) {
            if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                rects.push((
                    position.x,
                    position.y,
                    size.width as i32,
                    size.height as i32,
                ));
            }
        }
    }
    rects
}

pub fn open_pinned(app: &tauri::AppHandle, id: &str) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    open_pin(app, id);
}

pub fn close_pinned(app: &tauri::AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window(&pin_label(id)) {
        let _ = window.destroy();
    }
}

pub(super) fn hide_pinned(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        let Some(id) = label.strip_prefix("pin-") else {
            continue;
        };
        if window.is_visible().unwrap_or(false) {
            save_pin_frame(app, id, &window);
        }
        let _ = window.set_always_on_top(false);
        let _ = window.hide();
    }
}

pub(super) fn open_pin(app: &tauri::AppHandle, id: &str) {
    // Building a WebView2 window pumps the Windows message loop. Doing that
    // inside the click that requested the pin re-enters the webview and
    // crashes the process. Post the creation onto the UI thread instead.
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_pin_window(&handle, &id));
        });
    }
    #[cfg(not(target_os = "windows"))]
    open_pin_window(app, id);
}

fn open_pin_window(app: &tauri::AppHandle, id: &str) {
    let label = pin_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        if !drag_active(&label) {
            place_pin(app, id, &window);
        }
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.emit_to(&label, "show-pin", id);
        raise_pin_tabs(app);
        return;
    }
    let id_js = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into());
    let theme_js = match app
        .state::<AppState>()
        .db
        .get(id)
        .ok()
        .flatten()
        .and_then(|note| note.theme)
        .as_deref()
    {
        Some("dark") => "\"dark\"",
        Some("light") => "\"light\"",
        _ => "null",
    };
    let script = format!(
        "globalThis.__memosePin={id_js};\
         globalThis.__memoseTheme={theme_js};\
         if(document.documentElement){{\
           document.documentElement.dataset.noteId={id_js};\
           document.documentElement.classList.add('pin-window');\
         }}"
    );
    let page = format!("index.html?pin={id}");
    let builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(page.into()))
            .title("Memose")
            .inner_size(CARD_WIDTH, CARD_HEIGHT)
            .position(-10000.0, -10000.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .shadow(false)
            .visible(false)
            .initialization_script(&script);
    #[cfg(target_os = "windows")]
    // A second DwmEnableBlurBehindWindow call aborts the process. This flag
    // keeps the window transparent without that call.
    let builder = builder
        .no_redirection_bitmap(true)
        .background_color(tauri::window::Color(0, 0, 0, 0));
    let window = match builder.build() {
        Ok(window) => window,
        Err(err) => {
            eprintln!("memose: could not open pinned note: {err}");
            return;
        }
    };
    place_pin(app, id, &window);
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.emit_to(&label, "show-pin", id);
    raise_pin_tabs(app);
    let note_id = id.to_string();
    let handle = app.clone();
    let accept_moves_at = Instant::now() + Duration::from_millis(250);
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            slide_back(&handle, &pin_label(&note_id));
            schedule_resign(&handle);
        }
        WindowEvent::Moved(_) => {
            if follow_active(&note_id) || Instant::now() < accept_moves_at {
                return;
            }
            let label = pin_label(&note_id);
            schedule_settle(&handle, &label, Some(note_id.clone()), false);
        }
        WindowEvent::Resized(_) => {
            if Instant::now() < accept_moves_at {
                return;
            }
            let label = pin_label(&note_id);
            schedule_settle(&handle, &label, Some(note_id.clone()), true);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window(&pin_label(&note_id)) {
                if window.is_visible().unwrap_or(false) {
                    save_pin_frame(&handle, &note_id, &window);
                }
                let _ = window.set_always_on_top(false);
                let _ = window.hide();
            }
        }
        _ => {}
    });
}

fn place_pin(app: &tauri::AppHandle, id: &str, window: &WebviewWindow) {
    let label = pin_label(id);
    suppress_settle(&label, Duration::from_millis(500));
    if let Some((x, y, width, height)) = place_at()
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(id))
    {
        let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = app
            .state::<AppState>()
            .db
            .save_frame(id, x, y, width, height);
        return;
    }
    let Ok(Some(note)) = app.state::<AppState>().db.get(id) else {
        return;
    };
    let (width, height) = match (note.win_w, note.win_h) {
        (Some(width), Some(height)) => (width.max(1), height.max(1)),
        _ => match window.outer_size() {
            Ok(size) => (size.width.max(1) as i32, size.height.max(1) as i32),
            Err(_) => (CARD_WIDTH as i32, CARD_HEIGHT as i32),
        },
    };
    let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
    let Some((x, y)) = note.win_x.zip(note.win_y).or_else(|| {
        app.cursor_position()
            .ok()
            .map(|cursor| (cursor.x.round() as i32, cursor.y.round() as i32))
    }) else {
        return;
    };
    let taken = pinned_origins(app, id);
    let (x, y) = nudge_origin(x, y, &taken, PIN_CASCADE);
    if note.win_x != Some(x) || note.win_y != Some(y) {
        let _ = app
            .state::<AppState>()
            .db
            .save_frame(id, x, y, width, height);
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn pinned_origins(app: &tauri::AppHandle, except: &str) -> Vec<(i32, i32)> {
    app.state::<AppState>()
        .db
        .list_pinned()
        .unwrap_or_default()
        .into_iter()
        .filter(|note| note.id != except && note.stack_host.is_none())
        .filter_map(|note| note.win_x.zip(note.win_y))
        .collect()
}
