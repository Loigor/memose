use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
    WindowEvent,
};

use crate::error::AppError;
use crate::media;
use crate::notes::request_sync;
use crate::state::AppState;

const PREVIEW: &str = "media-preview";
const PREVIEW_GRACE: Duration = Duration::from_millis(300);

const WINDOW: &str = "main";
const SETTINGS: &str = "settings";
const CARD_WIDTH: f64 = 408.0;
const CARD_HEIGHT: f64 = 476.0;
const FOCUS_GRACE: Duration = Duration::from_millis(200);
const FLUSH_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Hidden,
    Shown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gesture {
    HotkeyOrTray { focused: bool },
    FocusLost { suppress_blur: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    ShowAtCursor,
    HideAndSave,
    Ignore,
}

pub fn transition(state: Visibility, gesture: Gesture) -> (Visibility, Action) {
    match (state, gesture) {
        (_, Gesture::FocusLost { suppress_blur: true }) => (state, Action::Ignore),
        (Visibility::Hidden, Gesture::FocusLost { .. }) => (Visibility::Hidden, Action::Ignore),
        (Visibility::Shown, Gesture::FocusLost { suppress_blur: false }) => {
            (Visibility::Shown, Action::Ignore)
        }
        (Visibility::Hidden, Gesture::HotkeyOrTray { .. }) => {
            (Visibility::Shown, Action::ShowAtCursor)
        }
        (Visibility::Shown, Gesture::HotkeyOrTray { focused: true }) => {
            (Visibility::Hidden, Action::HideAndSave)
        }
        (Visibility::Shown, Gesture::HotkeyOrTray { focused: false }) => {
            (Visibility::Shown, Action::ShowAtCursor)
        }
    }
}

pub fn attach(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW) else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_and_save(&handle, true);
        }
        WindowEvent::Focused(false) => on_blur(&handle),
        _ => {}
    });
}

pub fn show_composer(app: &AppHandle) {
    app.state::<AppState>()
        .shown
        .store(true, Ordering::SeqCst);
    present(app, false);
}

pub fn show_fresh_memo(app: &AppHandle) {
    app.state::<AppState>()
        .shown
        .store(true, Ordering::SeqCst);
    present(app, true);
}

pub fn hide_composer(app: &AppHandle) {
    if app.state::<AppState>().shown.load(Ordering::SeqCst) {
        hide_and_save(app, false);
    }
}

pub fn hide_memos(app: &AppHandle) {
    hide_pinned(app);
    let shown = app.state::<AppState>().shown.load(Ordering::SeqCst);
    let visible = app
        .get_webview_window(WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if shown || visible {
        hide_and_save(app, false);
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    match tauri::WebviewWindowBuilder::new(
        app,
        SETTINGS,
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(420.0, 480.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(true)
    .center()
    .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("memose: settings window failed: {err}"),
    }
}

fn on_blur(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.set_always_on_top(true);
    }
}

fn hide_and_save(app: &AppHandle, from_blur: bool) {
    let state = app.state::<AppState>();
    if state.hiding.swap(true, Ordering::SeqCst) {
        return;
    }
    state.suppress_blur.store(true, Ordering::SeqCst);
    state.shown.store(false, Ordering::SeqCst);
    if from_blur {
        *state
            .blur_hidden_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    *state
        .flush_content
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    *state
        .flush_note_id
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    *state
        .flush_tx
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(tx);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.emit("composer-flush", generation);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let signaled = tokio::time::timeout(FLUSH_TIMEOUT, rx).await.is_ok();
        if !signaled {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let state = app.state::<AppState>();
        let reopened = state.generation.load(Ordering::SeqCst) != generation;
        let content = state
            .flush_content
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let note_id = state
            .flush_note_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let db = state.db.clone();
        drop(state);
        let committed = tokio::task::spawn_blocking(move || match (content, note_id) {
            (Some(content), Some(id)) => db.save_edit(&id, &content).map(|(_changed, sync)| sync),
            (Some(content), None) => db.finalize_content(&content),
            (None, _) if !reopened => db.finalize_stored_draft(),
            (None, _) => Ok(false),
        })
        .await
        .unwrap_or(Ok(false))
        .unwrap_or(false);
        let state = app.state::<AppState>();
        state.handled_flush.store(generation, Ordering::SeqCst);
        if reopened {
            state.hiding.store(false, Ordering::SeqCst);
            drop(state);
            if committed {
                request_sync(&app);
            }
            return;
        }
        drop(state);
        hide_window(&app);
        if committed {
            request_sync(&app);
        }
    });
}

pub fn submit_flush(
    app: &AppHandle,
    generation: u64,
    content: String,
    note_id: Option<String>,
) {
    let state = app.state::<AppState>();
    if state.handled_flush.load(Ordering::SeqCst) == generation && generation != 0 {
        return;
    }
    *state
        .flush_content
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(content);
    *state
        .flush_note_id
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = note_id;
    let sender = {
        let mut guard = state
            .flush_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.take()
    };
    if let Some(tx) = sender {
        let _ = tx.send(());
    }
}

fn hide_window(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.suppress_blur.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    if !pin_windows_visible(app) {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    state.shown.store(false, Ordering::SeqCst);
    state.hiding.store(false, Ordering::SeqCst);
}

fn present(app: &AppHandle, fresh: bool) {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.hiding.store(false, Ordering::SeqCst);
    state.suppress_blur.store(true, Ordering::SeqCst);
    state.shown.store(true, Ordering::SeqCst);
    *state
        .blur_hidden_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.set_size(LogicalSize::new(CARD_WIDTH, CARD_HEIGHT));
        let _ = place_at_cursor(app, &window);
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(
            if fresh {
                "composer-fresh"
            } else {
                "composer-focus"
            },
            generation,
        );
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_GRACE).await;
        app.state::<AppState>()
            .suppress_blur
            .store(false, Ordering::SeqCst);
    });
}

fn place_at_cursor(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let cursor = app.cursor_position()?;
    let monitors = app.available_monitors()?;
    let monitor = monitors.iter().find(|monitor| contains(monitor, cursor)).cloned();
    let monitor = match monitor {
        Some(monitor) => Some(monitor),
        None => window.current_monitor()?.or(app.primary_monitor()?),
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = window.scale_factor()?;
    let (x, y) = clamp_position(
        cursor.x.round() as i32,
        cursor.y.round() as i32,
        (CARD_WIDTH * scale).round() as i32,
        (CARD_HEIGHT * scale).round() as i32,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    );
    window.set_position(PhysicalPosition::new(x, y))
}

fn contains(monitor: &tauri::Monitor, cursor: PhysicalPosition<f64>) -> bool {
    let position = monitor.position();
    let size = monitor.size();
    cursor.x >= position.x as f64
        && cursor.y >= position.y as f64
        && cursor.x < position.x as f64 + size.width as f64
        && cursor.y < position.y as f64 + size.height as f64
}

pub fn open_media_preview(app: &AppHandle, name: &str) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let _ = media::resolve(&state.media_dir, name)?;
    *state
        .preview_name
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(name.to_string());
    *state
        .preview_opened_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
    state.preview_open.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(PREVIEW) {
        let _ = window.emit("show-media", name);
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        PREVIEW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Preview")
    .inner_size(840.0, 640.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .center()
    .initialization_script("document.documentElement.classList.add('lightbox-window')");
    #[cfg(target_os = "windows")]
    let builder = builder
        .no_redirection_bitmap(true)
        .background_color(tauri::window::Color(0, 0, 0, 0));
    let window = builder
        .build()
        .map_err(|err| AppError::Message(err.to_string()))?;
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let state = handle.state::<AppState>();
            let too_soon = state
                .preview_opened_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some_and(|opened| opened.elapsed() < PREVIEW_GRACE);
            if !too_soon {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    close_media_preview(&handle);
                });
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let state = handle.state::<AppState>();
            state.preview_open.store(false, Ordering::SeqCst);
            *state
                .preview_name
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        _ => {}
    });
    let _ = window.emit("show-media", name);
    let _ = window.set_focus();
    Ok(())
}

pub fn close_media_preview(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.preview_open.store(false, Ordering::SeqCst);
    *state
        .preview_name
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    if let Some(window) = app.get_webview_window(PREVIEW) {
        let _ = window.close();
    }
}

fn pin_label(id: &str) -> String {
    format!("pin-{id}")
}

pub fn free_slot(
    occupied: &[(i32, i32, i32, i32)],
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    cell_w: i32,
    cell_h: i32,
    gap: i32,
) -> (i32, i32) {
    let gap = gap.max(0);
    let cell_w = cell_w.max(1);
    let cell_h = cell_h.max(1);
    let columns = ((area_w.saturating_sub(gap)) / (cell_w + gap)).max(1);
    let rows = ((area_h.saturating_sub(gap)) / (cell_h + gap)).max(1);
    for row in 0..rows {
        for col in 0..columns {
            let x = area_x + gap + col * (cell_w + gap);
            let y = area_y + gap + row * (cell_h + gap);
            let blocked = occupied.iter().any(|&(ox, oy, ow, oh)| {
                rects_overlap(x, y, cell_w, cell_h, ox, oy, ow.max(1), oh.max(1), gap)
            });
            if !blocked {
                return clamp_position(x, y, cell_w, cell_h, area_x, area_y, area_w, area_h);
            }
        }
    }
    clamp_position(
        area_x + gap,
        area_y + gap,
        cell_w,
        cell_h,
        area_x,
        area_y,
        area_w,
        area_h,
    )
}

fn rects_overlap(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    ox: i32,
    oy: i32,
    ow: i32,
    oh: i32,
    pad: i32,
) -> bool {
    x < ox.saturating_add(ow).saturating_add(pad)
        && x.saturating_add(w).saturating_add(pad) > ox
        && y < oy.saturating_add(oh).saturating_add(pad)
        && y.saturating_add(h).saturating_add(pad) > oy
}

pub fn grid_slot(
    index: usize,
    columns: usize,
    origin_x: i32,
    origin_y: i32,
    cell_w: i32,
    cell_h: i32,
    gap: i32,
) -> (i32, i32) {
    let columns = columns.max(1);
    let col = (index % columns) as i32;
    let row = (index / columns) as i32;
    (
        origin_x + col * (cell_w + gap),
        origin_y + row * (cell_h + gap),
    )
}

pub fn toggle_pinned(app: &AppHandle) {
    if pin_windows_visible(app) {
        hide_pinned(app);
        if !composer_open(app) {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        return;
    }
    show_pinned(app);
}

pub fn show_pinned(app: &AppHandle) {
    let notes = match app.state::<AppState>().db.list_pinned() {
        Ok(notes) => notes,
        Err(err) => {
            eprintln!("memose: pinned notes failed: {err}");
            return;
        }
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    for note in notes {
        open_pin(app, &note.id);
    }
    dismiss_composer(app);
    request_sync(app);
}

pub fn organize_pinned(app: &AppHandle) {
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
    let cell_w = (CARD_WIDTH * scale).round() as i32;
    let cell_h = (CARD_HEIGHT * scale).round() as i32;
    let gap = (16.0 * scale).round() as i32;
    let columns = ((area.size.width as i32) / (cell_w + gap)).max(1) as usize;
    for (index, note) in notes.iter().enumerate() {
        let (x, y) = grid_slot(
            index,
            columns,
            area.position.x + gap,
            area.position.y + gap,
            cell_w,
            cell_h,
            gap,
        );
        let _ = app
            .state::<AppState>()
            .db
            .save_frame(&note.id, x, y, cell_w, cell_h);
        open_pin(app, &note.id);
    }
}

pub fn place_in_free_space(app: &AppHandle, id: &str) {
    let Some(monitor) = monitor_for_placement(app) else {
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let cell_w = (CARD_WIDTH * scale).round() as i32;
    let cell_h = (CARD_HEIGHT * scale).round() as i32;
    let gap = (16.0 * scale).round() as i32;
    let (x, y) = free_slot(
        &occupied_rects(app, id),
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        cell_w,
        cell_h,
        gap,
    );
    let _ = app
        .state::<AppState>()
        .db
        .save_frame(id, x, y, cell_w, cell_h);
}

pub fn dismiss_composer(app: &AppHandle) {
    if composer_open(app) {
        hide_and_save(app, false);
    }
}

fn monitor_for_placement(app: &AppHandle) -> Option<tauri::Monitor> {
    let point = app
        .get_webview_window(WINDOW)
        .filter(|window| window.is_visible().unwrap_or(false))
        .and_then(|window| window.outer_position().ok())
        .map(|position| PhysicalPosition::new(position.x as f64, position.y as f64))
        .or_else(|| app.cursor_position().ok());
    let monitors = app.available_monitors().ok()?;
    point
        .and_then(|point| {
            monitors
                .iter()
                .find(|monitor| contains(monitor, point))
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn occupied_rects(app: &AppHandle, except: &str) -> Vec<(i32, i32, i32, i32)> {
    let mut rects = Vec::new();
    if let Ok(notes) = app.state::<AppState>().db.list_pinned() {
        for note in notes {
            if note.id == except {
                continue;
            }
            if let (Some(x), Some(y), Some(w), Some(h)) = (note.win_x, note.win_y, note.win_w, note.win_h)
            {
                rects.push((x, y, w, h));
            }
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        if window.is_visible().unwrap_or(false) {
            if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
                rects.push((position.x, position.y, size.width as i32, size.height as i32));
            }
        }
    }
    rects
}

pub fn open_pinned(app: &AppHandle, id: &str) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    open_pin(app, id);
}

pub fn close_pinned(app: &AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window(&pin_label(id)) {
        let _ = window.hide();
    }
}

fn pin_windows_visible(app: &AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        label.starts_with("pin-") && window.is_visible().unwrap_or(false)
    })
}

fn composer_open(app: &AppHandle) -> bool {
    app.state::<AppState>().shown.load(Ordering::SeqCst)
        || app
            .get_webview_window(WINDOW)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
}

fn hide_pinned(app: &AppHandle) {
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

fn open_pin(app: &AppHandle, id: &str) {
    // Building a WebView2 window pumps the Windows message loop. Doing that
    // inside the click that requested the pin re-enters the webview and
    // crashes the process. Post the creation onto the UI thread instead.
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let _ = app.run_on_main_thread(move || open_pin_window(&app, &id));
        });
        return;
    }
    #[cfg(not(target_os = "windows"))]
    open_pin_window(app, id);
}

fn open_pin_window(app: &AppHandle, id: &str) {
    let label = pin_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        place_pin(app, id, &window);
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.emit("show-pin", id);
        return;
    }
    let script = format!(
        "document.documentElement.dataset.noteId={id:?};document.documentElement.classList.add('pin-window');"
    );
    let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Memose")
        .inner_size(CARD_WIDTH, CARD_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
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
    let _ = window.emit("show-pin", id);
    let note_id = id.to_string();
    let handle = app.clone();
    let accept_moves_at = Instant::now() + Duration::from_millis(250);
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if Instant::now() < accept_moves_at {
                return;
            }
            if let Some(window) = handle.get_webview_window(&pin_label(&note_id)) {
                if window.is_visible().unwrap_or(false) {
                    save_pin_frame(&handle, &note_id, &window);
                }
            }
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

fn place_pin(app: &AppHandle, id: &str, window: &WebviewWindow) {
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
    let Some((x, y)) = note
        .win_x
        .zip(note.win_y)
        .or_else(|| {
            app.cursor_position()
                .ok()
                .map(|cursor| (cursor.x.round() as i32, cursor.y.round() as i32))
        })
    else {
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

fn pinned_origins(app: &AppHandle, except: &str) -> Vec<(i32, i32)> {
    app.state::<AppState>()
        .db
        .list_pinned()
        .unwrap_or_default()
        .into_iter()
        .filter(|note| note.id != except)
        .filter_map(|note| note.win_x.zip(note.win_y))
        .collect()
}

const PIN_CASCADE: i32 = 36;

fn nudge_origin(x: i32, y: i32, taken: &[(i32, i32)], step: i32) -> (i32, i32) {
    let step = step.max(1);
    let mut x = x;
    let mut y = y;
    for _ in 0..32 {
        let blocked = taken
            .iter()
            .any(|(ox, oy)| (ox - x).abs() <= 8 && (oy - y).abs() <= 8);
        if !blocked {
            return (x, y);
        }
        x = x.saturating_add(step);
        y = y.saturating_add(step);
    }
    (x, y)
}

fn save_pin_frame(app: &AppHandle, id: &str, window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let _ = app.state::<AppState>().db.save_frame(
        id,
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    );
}

pub fn clamp_position(
    cursor_x: i32,
    cursor_y: i32,
    window_w: i32,
    window_h: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
) -> (i32, i32) {
    let mut x = cursor_x;
    let mut y = cursor_y;
    let right = area_x.saturating_add(area_w);
    let bottom = area_y.saturating_add(area_h);
    if x.saturating_add(window_w) > right {
        x = right.saturating_sub(window_w);
    }
    if y.saturating_add(window_h) > bottom {
        y = bottom.saturating_sub(window_h);
    }
    if x < area_x {
        x = area_x;
    }
    if y < area_y {
        y = area_y;
    }
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_hotkey_shows_at_cursor() {
        let (state, action) = transition(
            Visibility::Hidden,
            Gesture::HotkeyOrTray { focused: false },
        );
        assert_eq!(state, Visibility::Shown);
        assert_eq!(action, Action::ShowAtCursor);
    }

    #[test]
    fn shown_and_focused_hides() {
        let (state, action) = transition(
            Visibility::Shown,
            Gesture::HotkeyOrTray { focused: true },
        );
        assert_eq!(state, Visibility::Hidden);
        assert_eq!(action, Action::HideAndSave);
    }

    #[test]
    fn shown_but_unfocused_moves_to_cursor() {
        let (state, action) = transition(
            Visibility::Shown,
            Gesture::HotkeyOrTray { focused: false },
        );
        assert_eq!(state, Visibility::Shown);
        assert_eq!(action, Action::ShowAtCursor);
    }

    #[test]
    fn blur_leaves_the_card_visible() {
        let (state, action) = transition(
            Visibility::Shown,
            Gesture::FocusLost { suppress_blur: false },
        );
        assert_eq!(state, Visibility::Shown);
        assert_eq!(action, Action::Ignore);
    }

    #[test]
    fn self_hide_blur_is_ignored() {
        let (state, action) = transition(
            Visibility::Shown,
            Gesture::FocusLost { suppress_blur: true },
        );
        assert_eq!(state, Visibility::Shown);
        assert_eq!(action, Action::Ignore);
    }

    #[test]
    fn blur_while_hidden_is_ignored() {
        let (state, action) = transition(
            Visibility::Hidden,
            Gesture::FocusLost {
                suppress_blur: false,
            },
        );
        assert_eq!(state, Visibility::Hidden);
        assert_eq!(action, Action::Ignore);
    }

    #[test]
    fn clamp_keeps_the_card_inside_the_work_area() {
        let (x, y) = clamp_position(1900, 1000, 380, 440, 0, 0, 1920, 1080);
        assert_eq!(x, 1920 - 380);
        assert_eq!(y, 1080 - 440);
        let (x, y) = clamp_position(12, 20, 380, 440, 0, 0, 1920, 1080);
        assert_eq!((x, y), (12, 20));
    }

    #[test]
    fn grid_fills_rows_across_the_screen() {
        assert_eq!(grid_slot(0, 3, 10, 20, 100, 80, 8), (10, 20));
        assert_eq!(grid_slot(2, 3, 10, 20, 100, 80, 8), (10 + 2 * 108, 20));
        assert_eq!(grid_slot(3, 3, 10, 20, 100, 80, 8), (10, 20 + 88));
    }

    #[test]
    fn free_slot_skips_occupied_cards() {
        let cell = (100, 80);
        let gap = 8;
        assert_eq!(free_slot(&[], 0, 0, 400, 300, cell.0, cell.1, gap), (8, 8));
        let first = (8, 8, 100, 80);
        assert_eq!(
            free_slot(&[first], 0, 0, 400, 300, cell.0, cell.1, gap),
            (8 + 108, 8)
        );
        let second = (8 + 108, 8, 100, 80);
        assert_eq!(
            free_slot(&[first, second], 0, 0, 220, 300, cell.0, cell.1, gap),
            (8, 8 + 88)
        );
    }

    #[test]
    fn stacked_pins_step_apart() {
        assert_eq!(nudge_origin(10, 20, &[], 36), (10, 20));
        assert_eq!(nudge_origin(10, 20, &[(10, 20)], 36), (46, 56));
        assert_eq!(nudge_origin(10, 20, &[(10, 20), (46, 56)], 36), (82, 92));
        assert_eq!(nudge_origin(80, 20, &[(10, 20)], 36), (80, 20));
    }
}
