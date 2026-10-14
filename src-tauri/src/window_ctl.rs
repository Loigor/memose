use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{LazyLock, Mutex};
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
// Shadow gutter on `body` in styles.css. Auto-organize overlaps this so the
// visible notes sit a few pixels apart.
const CARD_PAD_X: f64 = 24.0;
const CARD_PAD_TOP: f64 = 24.0;
const CARD_PAD_BOTTOM: f64 = 32.0;
const ORGANIZE_GAP: f64 = 4.0;
const FOCUS_GRACE: Duration = Duration::from_millis(200);
const RESIGN_GRACE: Duration = Duration::from_millis(140);
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
            (Visibility::Hidden, Action::HideAndSave)
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
    // The window is created at a parked spot. Keep it hidden until present()
    // has moved it to the cursor, so the first frame is not the screen center.
    let _ = window.hide();
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_and_save(&handle, true);
        }
        WindowEvent::Focused(false) => schedule_resign(&handle),
        WindowEvent::Moved(_) => schedule_settle(&handle, WINDOW, None, false),
        WindowEvent::Resized(_) => schedule_settle(&handle, WINDOW, None, true),
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
    if composer_open(app) {
        cycle_composer(app);
        return;
    }
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
    app.state::<AppState>()
        .pinned_mode
        .store(false, Ordering::SeqCst);
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
    .inner_size(420.0, 600.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(true)
    .center()
    .build()
    {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    schedule_resign(&handle);
                }
            });
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("memose: settings window failed: {err}"),
    }
}

fn schedule_resign(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESIGN_GRACE).await;
        for _ in 0..4 {
            if !app.state::<AppState>().suppress_blur.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(FOCUS_GRACE).await;
        }
        if app.state::<AppState>().suppress_blur.load(Ordering::SeqCst) {
            return;
        }
        if any_window_focused(&app) {
            return;
        }
        hide_on_resign(&app);
    });
}

fn any_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

fn hide_on_resign(app: &AppHandle) {
    if app.state::<AppState>().pinned_mode.load(Ordering::SeqCst) {
        hide_composer(app);
        return;
    }
    hide_pinned(app);
    let shown = app.state::<AppState>().shown.load(Ordering::SeqCst);
    let visible = app
        .get_webview_window(WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if shown || visible {
        hide_and_save(app, true);
    } else {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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

fn cycle_composer(app: &AppHandle) {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.hiding.store(false, Ordering::SeqCst);
    state.suppress_blur.store(true, Ordering::SeqCst);
    state.shown.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("composer-cycle", generation);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_GRACE).await;
        app.state::<AppState>()
            .suppress_blur
            .store(false, Ordering::SeqCst);
    });
}

fn present(app: &AppHandle, fresh: bool) {
    present_at(app, fresh, None);
}

fn present_at(app: &AppHandle, fresh: bool, anchor: Option<TrayAnchor>) {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.hiding.store(false, Ordering::SeqCst);
    state.suppress_blur.store(true, Ordering::SeqCst);
    state.shown.store(true, Ordering::SeqCst);
    *state
        .blur_hidden_at
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    if let Some(window) = app.get_webview_window(WINDOW) {
        // Stay hidden while the frame moves. Showing first paints the card at
        // the screen center, then it jumps once the cursor position applies.
        let _ = window.hide();
        let _ = window.set_size(LogicalSize::new(CARD_WIDTH, CARD_HEIGHT));
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let point = anchor
            .and_then(|anchor| place_near_tray(app, &window, anchor))
            .or_else(|| place_at_cursor(app, &window));
        match point {
            Some((x, y)) => reveal_when_placed(app.clone(), window, x, y, fresh, generation),
            None => order_composer_front(app, &window, fresh, generation),
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_GRACE).await;
        app.state::<AppState>()
            .suppress_blur
            .store(false, Ordering::SeqCst);
    });
}

fn reveal_when_placed(
    app: AppHandle,
    window: WebviewWindow,
    x: i32,
    y: i32,
    fresh: bool,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..20 {
            if position_is(&window, x, y) {
                break;
            }
            let _ = window.hide();
            let _ = window.set_position(PhysicalPosition::new(x, y));
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        let app_for_show = app.clone();
        let _ = app.run_on_main_thread(move || {
            order_composer_front(&app_for_show, &window, fresh, generation);
        });
    });
}

fn position_is(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(pos) = window.outer_position() else {
        return false;
    };
    (pos.x - x).abs() <= 2 && (pos.y - y).abs() <= 2
}

fn order_composer_front(app: &AppHandle, window: &WebviewWindow, fresh: bool, generation: u64) {
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
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FOCUS_GRACE).await;
        app.state::<AppState>()
            .suppress_blur
            .store(false, Ordering::SeqCst);
    });
}

fn place_near_tray(
    app: &AppHandle,
    window: &WebviewWindow,
    anchor: TrayAnchor,
) -> Option<(i32, i32)> {
    let point = PhysicalPosition::new(anchor.x as f64 + 1.0, anchor.y as f64 + 1.0);
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|monitor| contains(monitor, point))
        .cloned()
        .or(window.current_monitor().ok()?)
        .or(app.primary_monitor().ok()?);
    let monitor = monitor?;
    let area = monitor.work_area();
    let scale = window.scale_factor().ok()?;
    let (x, y) = tray_card_origin(
        anchor.x,
        anchor.y,
        anchor.width.max(1),
        anchor.height.max(1),
        (CARD_WIDTH * scale).round() as i32,
        (CARD_HEIGHT * scale).round() as i32,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        (8.0 * scale).round() as i32,
    );
    window.set_position(PhysicalPosition::new(x, y)).ok()?;
    Some((x, y))
}

pub fn tray_card_origin(
    icon_x: i32,
    icon_y: i32,
    icon_w: i32,
    icon_h: i32,
    win_w: i32,
    win_h: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    gap: i32,
) -> (i32, i32) {
    let icon_mid_x = icon_x.saturating_add(icon_w / 2);
    let icon_mid_y = icon_y.saturating_add(icon_h / 2);
    let area_mid_x = area_x.saturating_add(area_w / 2);
    let area_mid_y = area_y.saturating_add(area_h / 2);
    let x = if icon_mid_x > area_mid_x {
        icon_x.saturating_add(icon_w).saturating_sub(win_w)
    } else {
        icon_x
    };
    let y = if icon_mid_y < area_mid_y {
        icon_y.saturating_add(icon_h).saturating_add(gap)
    } else {
        icon_y.saturating_sub(gap).saturating_sub(win_h)
    };
    clamp_position(x, y, win_w, win_h, area_x, area_y, area_w, area_h)
}

fn place_at_cursor(app: &AppHandle, window: &WebviewWindow) -> Option<(i32, i32)> {
    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors.iter().find(|monitor| contains(monitor, cursor)).cloned();
    let monitor = match monitor {
        Some(monitor) => Some(monitor),
        None => window.current_monitor().ok()?.or(app.primary_monitor().ok()?),
    };
    let monitor = monitor?;
    let area = monitor.work_area();
    let scale = window.scale_factor().ok()?;
    let (mut x, mut y) = clamp_position(
        cursor.x.round() as i32,
        cursor.y.round() as i32,
        (CARD_WIDTH * scale).round() as i32,
        (CARD_HEIGHT * scale).round() as i32,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    );
    if snap_enabled(app) {
        let pad_x = (CARD_PAD_X * scale).round() as i32;
        let pad_top = (CARD_PAD_TOP * scale).round() as i32;
        let card_w = ((CARD_WIDTH - CARD_PAD_X * 2.0) * scale).round() as i32;
        let card_h = ((CARD_HEIGHT - CARD_PAD_TOP - CARD_PAD_BOTTOM) * scale).round() as i32;
        let catch = (f64::from(EDGE_CATCH) * scale).round() as i32;
        (x, y) = snap_screen_edges(
            x,
            y,
            card_w.max(1),
            card_h.max(1),
            pad_x,
            pad_top,
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
            catch,
        );
    }
    window.set_position(PhysicalPosition::new(x, y)).ok()?;
    Some((x, y))
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
                let closing = handle.clone();
                tauri::async_runtime::spawn(async move {
                    close_media_preview(&closing);
                });
                schedule_resign(&handle);
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

#[allow(dead_code)]
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

const SNAP_COLUMNS: i32 = 5;
const SNAP_ROWS: i32 = 3;
/// How close a memo edge must be to a screen edge before it catches.
const EDGE_CATCH: i32 = 36;
const MEMO_CATCH: i32 = 22;
const STACK_LIMIT: usize = 8;

pub fn snap_anchors(area_x: i32, area_y: i32, area_w: i32, area_h: i32, card_w: i32, card_h: i32) -> Vec<(i32, i32)> {
    let span_x = (area_w - card_w).max(0);
    let span_y = (area_h - card_h).max(0);
    let mut points = Vec::with_capacity((SNAP_COLUMNS * SNAP_ROWS) as usize);
    for row in 0..SNAP_ROWS {
        for col in 0..SNAP_COLUMNS {
            let x = area_x + span_x * col / (SNAP_COLUMNS - 1);
            let y = area_y + span_y * row / (SNAP_ROWS - 1);
            points.push((x, y));
        }
    }
    points
}

fn point_dist(ax: i32, ay: i32, bx: i32, by: i32) -> i32 {
    let dx = i64::from(ax) - i64::from(bx);
    let dy = i64::from(ay) - i64::from(by);
    dx.saturating_mul(dx)
        .saturating_add(dy.saturating_mul(dy))
        .isqrt() as i32
}

fn approach(from: i32, to: i32, num: i32, den: i32) -> i32 {
    let den = i64::from(den).max(1);
    let delta = i64::from(to) - i64::from(from);
    (i64::from(from) + delta * i64::from(num) / den) as i32
}

/// Pull a window origin toward the nearest grid point. `hold` is the visual
/// anchor already locked. Catch eases in slowly; lock sticks until release.
pub fn magnet_origin(
    desired_x: i32,
    desired_y: i32,
    pad_x: i32,
    pad_y: i32,
    anchors: &[(i32, i32)],
    hold: Option<(i32, i32)>,
    catch: i32,
    lock: i32,
    release: i32,
) -> (i32, i32, Option<(i32, i32)>) {
    let vx = desired_x.saturating_add(pad_x);
    let vy = desired_y.saturating_add(pad_y);
    if let Some((hx, hy)) = hold {
        let away = point_dist(vx, vy, hx, hy);
        if away < release {
            let hold_band = (release / 2).max(lock);
            if away <= hold_band {
                return (hx.saturating_sub(pad_x), hy.saturating_sub(pad_y), Some((hx, hy)));
            }
            let span = (release - hold_band).max(1);
            let crept = away - hold_band;
            let num = crept.saturating_mul(crept);
            let den = span.saturating_mul(span).max(1);
            let x = approach(hx, vx, num, den);
            let y = approach(hy, vy, num, den);
            return (x.saturating_sub(pad_x), y.saturating_sub(pad_y), Some((hx, hy)));
        }
    }
    let Some((ax, ay)) = nearest_anchor(vx, vy, anchors, Some(catch)) else {
        return (desired_x, desired_y, None);
    };
    let away = point_dist(vx, vy, ax, ay);
    if away <= lock {
        return (ax.saturating_sub(pad_x), ay.saturating_sub(pad_y), Some((ax, ay)));
    }
    let span = (catch - lock).max(1);
    let into = catch.saturating_sub(away);
    let num = into.saturating_mul(into);
    let den = span.saturating_mul(span).max(1);
    let x = approach(vx, ax, num, den);
    let y = approach(vy, ay, num, den);
    (x.saturating_sub(pad_x), y.saturating_sub(pad_y), None)
}

/// Move the window origin so a card edge that is against the work area sticks to it.
/// Other positions stay where the pointer put them.
pub fn snap_screen_edges(
    origin_x: i32,
    origin_y: i32,
    card_w: i32,
    card_h: i32,
    pad_x: i32,
    pad_top: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    catch: i32,
) -> (i32, i32) {
    let left = origin_x.saturating_add(pad_x);
    let top = origin_y.saturating_add(pad_top);
    let right = left.saturating_add(card_w);
    let bottom = top.saturating_add(card_h);
    let area_right = area_x.saturating_add(area_w);
    let area_bottom = area_y.saturating_add(area_h);
    let mut x = origin_x;
    let mut y = origin_y;
    let left_gap = (left - area_x).abs();
    let right_gap = (right - area_right).abs();
    if left_gap <= catch && left_gap <= right_gap {
        x = area_x.saturating_sub(pad_x);
    } else if right_gap <= catch {
        x = area_right.saturating_sub(card_w).saturating_sub(pad_x);
    }
    let top_gap = (top - area_y).abs();
    let bottom_gap = (bottom - area_bottom).abs();
    if top_gap <= catch && top_gap <= bottom_gap {
        y = area_y.saturating_sub(pad_top);
    } else if bottom_gap <= catch {
        y = area_bottom.saturating_sub(card_h).saturating_sub(pad_top);
    }
    (x, y)
}

fn axis_gap(start: i32, end: i32, other_start: i32, other_end: i32) -> i32 {
    if end < other_start {
        other_start - end
    } else if other_end < start {
        start - other_end
    } else {
        0
    }
}

/// Nudge a card so a nearby memo's left, right, top, or bottom edge lines up.
/// A deep overlap is left alone so a memo can still be dropped onto another.
pub fn snap_memo_edges(
    origin_x: i32,
    origin_y: i32,
    card_w: i32,
    card_h: i32,
    pad_x: i32,
    pad_top: i32,
    neighbors: &[(i32, i32, i32, i32)],
    catch: i32,
) -> (i32, i32) {
    let left = origin_x.saturating_add(pad_x);
    let top = origin_y.saturating_add(pad_top);
    let right = left.saturating_add(card_w);
    let bottom = top.saturating_add(card_h);
    let mut best_dx: Option<(i32, i32)> = None;
    let mut best_dy: Option<(i32, i32)> = None;
    for &(other_left, other_top, other_w, other_h) in neighbors {
        let other_right = other_left.saturating_add(other_w);
        let other_bottom = other_top.saturating_add(other_h);
        if axis_gap(left, right, other_left, other_right) > catch
            || axis_gap(top, bottom, other_top, other_bottom) > catch
        {
            continue;
        }
        for edge in [left, right] {
            for other in [other_left, other_right] {
                let delta = other.saturating_sub(edge);
                let distance = delta.abs();
                if distance <= catch && best_dx.is_none_or(|(best, _)| distance < best) {
                    best_dx = Some((distance, delta));
                }
            }
        }
        for edge in [top, bottom] {
            for other in [other_top, other_bottom] {
                let delta = other.saturating_sub(edge);
                let distance = delta.abs();
                if distance <= catch && best_dy.is_none_or(|(best, _)| distance < best) {
                    best_dy = Some((distance, delta));
                }
            }
        }
    }
    (
        origin_x.saturating_add(best_dx.map(|(_, delta)| delta).unwrap_or(0)),
        origin_y.saturating_add(best_dy.map(|(_, delta)| delta).unwrap_or(0)),
    )
}

pub fn nearest_line(value: i32, lines: &[i32], max_distance: i32) -> Option<i32> {
    let points: Vec<(i32, i32)> = lines.iter().map(|line| (*line, 0)).collect();
    nearest_anchor(value, 0, &points, Some(max_distance)).map(|(x, _)| x)
}

pub fn nearest_anchor(
    x: i32,
    y: i32,
    points: &[(i32, i32)],
    max_distance: Option<i32>,
) -> Option<(i32, i32)> {
    let mut best: Option<(i64, i32, i32)> = None;
    for &(px, py) in points {
        let dx = i64::from(x) - i64::from(px);
        let dy = i64::from(y) - i64::from(py);
        let dist = dx * dx + dy * dy;
        if best.map(|(score, _, _)| dist < score).unwrap_or(true) {
            best = Some((dist, px, py));
        }
    }
    let (dist, px, py) = best?;
    if let Some(max) = max_distance {
        let max = i64::from(max);
        if dist > max * max {
            return None;
        }
    }
    Some((px, py))
}

fn snap_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .db
        .get_meta(crate::notes::SNAP_MEMOS)
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

struct OrganizeGrid {
    origin_x: i32,
    origin_y: i32,
    step_x: i32,
    step_y: i32,
    columns: usize,
    rows: usize,
}

fn organize_grid(
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    win_w: i32,
    win_h: i32,
    pad_x: i32,
    pad_top: i32,
    pad_bottom: i32,
    gap: i32,
) -> OrganizeGrid {
    let gap = gap.max(0);
    let card_w = (win_w - pad_x.saturating_mul(2)).max(1);
    let card_h = (win_h - pad_top - pad_bottom).max(1);
    let step_x = card_w + gap;
    let step_y = card_h + gap;
    let columns = ((area_w.saturating_sub(gap)) / step_x).max(1) as usize;
    let rows = ((area_h.saturating_sub(gap)) / step_y).max(1) as usize;
    OrganizeGrid {
        origin_x: area_x + gap - pad_x,
        origin_y: area_y + gap - pad_top,
        step_x,
        step_y,
        columns,
        rows,
    }
}

fn visual_card(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    pad_x: i32,
    pad_top: i32,
    pad_bottom: i32,
) -> (i32, i32, i32, i32) {
    (
        x + pad_x,
        y + pad_top,
        (w - pad_x.saturating_mul(2)).max(1),
        (h - pad_top - pad_bottom).max(1),
    )
}

fn first_open_tile(
    occupied: &[(i32, i32, i32, i32)],
    origin_x: i32,
    origin_y: i32,
    step_x: i32,
    step_y: i32,
    pad_x: i32,
    pad_top: i32,
    card_w: i32,
    card_h: i32,
    columns: usize,
    rows: usize,
    gap: i32,
) -> (i32, i32) {
    let columns = columns.max(1);
    let rows = rows.max(1);
    for row in 0..rows {
        for col in 0..columns {
            let x = origin_x + col as i32 * step_x;
            let y = origin_y + row as i32 * step_y;
            let blocked = occupied.iter().any(|&(ox, oy, ow, oh)| {
                rects_overlap(x + pad_x, y + pad_top, card_w, card_h, ox, oy, ow, oh, gap)
            });
            if !blocked {
                return (x, y);
            }
        }
    }
    (origin_x, origin_y)
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
    let state = app.state::<AppState>();
    if state.pinned_mode.load(Ordering::SeqCst) {
        state.pinned_mode.store(false, Ordering::SeqCst);
        hide_pinned(app);
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

#[derive(Clone, Copy)]
pub struct TrayAnchor {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl TrayAnchor {
    pub fn from_rect(rect: tauri::Rect) -> Self {
        let position = rect.position.to_physical(1.0);
        let size = rect.size.to_physical(1.0);
        Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }
    }
}

pub fn show_from_tray(app: &AppHandle, anchor: Option<TrayAnchor>) {
    let anchor = anchor.or_else(|| tray_anchor(app));
    open_pinned_windows(app);
    app.state::<AppState>()
        .shown
        .store(true, Ordering::SeqCst);
    present_at(app, true, anchor);
    request_sync(app);
}

fn tray_anchor(app: &AppHandle) -> Option<TrayAnchor> {
    let tray = app.tray_by_id("main")?;
    tray.rect().ok().flatten().map(TrayAnchor::from_rect)
}

fn open_pinned_windows(app: &AppHandle) {
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
        if note.stack_host.is_some() {
            continue;
        }
        open_pin(app, &note.id);
    }
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
    let notes: Vec<_> = notes.into_iter().filter(|note| note.stack_host.is_none()).collect();
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
        let _ = app
            .state::<AppState>()
            .db
            .save_frame(&note.id, x, y, win_w, win_h);
        open_pin(app, &note.id);
    }
}

pub fn place_for_pin(app: &AppHandle, id: &str) {
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

pub fn place_in_free_space(app: &AppHandle, id: &str) {
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
        let _ = window.destroy();
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
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_pin_window(&handle, &id));
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
        let _ = window.emit_to(&label, "show-pin", id);
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
    let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(page.into()))
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
    let note_id = id.to_string();
    let handle = app.clone();
    let accept_moves_at = Instant::now() + Duration::from_millis(250);
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => schedule_resign(&handle),
        WindowEvent::Moved(_) => {
            if follow_active(&note_id) || Instant::now() < accept_moves_at {
                return;
            }
            let label = pin_label(&note_id);
            if drag_active(&label) {
                if let Some(window) = handle.get_webview_window(&label) {
                    arm_stack_attach(&handle, &note_id, &window);
                }
            }
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

fn place_at() -> &'static Mutex<HashMap<String, (i32, i32, i32, i32)>> {
    static PLACE: LazyLock<Mutex<HashMap<String, (i32, i32, i32, i32)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &PLACE
}

fn place_pin(app: &AppHandle, id: &str, window: &WebviewWindow) {
    if let Some((x, y, width, height)) = place_at().lock().ok().and_then(|mut pending| pending.remove(id)) {
        let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = app.state::<AppState>().db.save_frame(id, x, y, width, height);
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

fn schedule_settle(app: &AppHandle, label: &str, note_id: Option<String>, resize: bool) {
    let ticket = {
        let state = app.state::<AppState>();
        let mut tickets = state
            .settle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = tickets.get(label).copied().unwrap_or((0, false, Instant::now()));
        let next = previous.0.wrapping_add(1);
        // A resize also emits a move. Keep the resize so an edge can still meet the screen.
        let resize = resize || (previous.1 && previous.2.elapsed() < Duration::from_millis(200));
        tickets.insert(label.to_string(), (next, resize, Instant::now()));
        next
    };
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let current = {
            let state = app.state::<AppState>();
            let tickets = state
                .settle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tickets.get(&label).copied()
        };
        let Some((current_ticket, resize, _)) = current else {
            return;
        };
        if current_ticket != ticket {
            return;
        }
        let _ = app.clone().run_on_main_thread(move || {
            settle_window(&app, &label, note_id.as_deref(), resize);
        });
    });
}

fn settle_window(app: &AppHandle, label: &str, note_id: Option<&str>, resize: bool) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if resize_active(label) {
        return;
    }
    if snap_enabled(app) && !park_quiet(label) {
        if resize {
            snap_resized_edges(app, &window);
        } else if !aim_pending(note_id.unwrap_or("")) {
            snap_moved_corner(app, &window);
        }
    }
    if let Some(id) = note_id {
        save_pin_frame(app, id, &window);
    }
}

fn closer_snap(current: i32, screen: i32, memo: i32) -> i32 {
    let screen_move = (screen - current).abs();
    let memo_move = (memo - current).abs();
    if screen_move == 0 {
        memo
    } else if memo_move == 0 || screen_move <= memo_move {
        screen
    } else {
        memo
    }
}

fn neighbor_cards(app: &AppHandle, window: &WebviewWindow) -> Vec<(i32, i32, i32, i32)> {
    let self_label = window.label();
    let mut cards = Vec::new();
    for (label, other) in app.webview_windows() {
        if label == self_label || !label.starts_with("pin-") || !other.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(position), Ok(size), Ok(other_scale)) = (
            other.outer_position(),
            other.outer_size(),
            other.scale_factor(),
        ) else {
            continue;
        };
        let pad_x = (CARD_PAD_X * other_scale).round() as i32;
        let pad_top = (CARD_PAD_TOP * other_scale).round() as i32;
        let pad_bottom = (CARD_PAD_BOTTOM * other_scale).round() as i32;
        cards.push((
            position.x + pad_x,
            position.y + pad_top,
            (size.width as i32 - pad_x.saturating_mul(2)).max(1),
            (size.height as i32 - pad_top - pad_bottom).max(1),
        ));
    }
    cards
}

fn snap_moved_corner(app: &AppHandle, window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Some(monitor) = monitor_containing(app, position.x, position.y) else {
        return;
    };
    let area = monitor.work_area();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_top = (CARD_PAD_TOP * scale).round() as i32;
    let Ok(size) = window.outer_size() else {
        return;
    };
    let card_w = (size.width as i32 - pad_x.saturating_mul(2)).max(1);
    let card_h = (size.height as i32 - pad_top - (CARD_PAD_BOTTOM * scale).round() as i32).max(1);
    let catch = (f64::from(EDGE_CATCH) * scale).round() as i32;
    let (screen_x, screen_y) = snap_screen_edges(
        position.x,
        position.y,
        card_w,
        card_h,
        pad_x,
        pad_top,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        catch,
    );
    let memo_catch = (f64::from(MEMO_CATCH) * scale).round() as i32;
    let (memo_x, memo_y) = snap_memo_edges(
        position.x,
        position.y,
        card_w,
        card_h,
        pad_x,
        pad_top,
        &neighbor_cards(app, window),
        memo_catch,
    );
    let x = closer_snap(position.x, screen_x, memo_x);
    let y = closer_snap(position.y, screen_y, memo_y);
    if (x - position.x).abs() <= 2 && (y - position.y).abs() <= 2 {
        return;
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn snap_resized_edges(app: &AppHandle, window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Some(monitor) = monitor_containing(app, position.x, position.y) else {
        return;
    };
    let area = monitor.work_area();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_bottom = (CARD_PAD_BOTTOM * scale).round() as i32;
    let threshold = (f64::from(EDGE_CATCH) * scale).round() as i32;
    let min_w = (220.0 * scale).round() as i32;
    let min_h = (140.0 * scale).round() as i32;
    let right = position.x + size.width as i32 - pad_x;
    let bottom = position.y + size.height as i32 - pad_bottom;
    let area_right = area.position.x + area.size.width as i32;
    let area_bottom = area.position.y + area.size.height as i32;
    let mut width = size.width as i32;
    let mut height = size.height as i32;
    if (right - area_right).abs() <= threshold {
        let next = area_right + pad_x - position.x;
        if next >= min_w {
            width = next;
        }
    }
    if (bottom - area_bottom).abs() <= threshold {
        let next = area_bottom + pad_bottom - position.y;
        if next >= min_h {
            height = next;
        }
    }
    if width == size.width as i32 && height == size.height as i32 {
        return;
    }
    let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
}

fn chain_contains(db: &crate::notes::Db, start: &str, target: &str) -> bool {
    let mut current = start.to_string();
    for _ in 0..STACK_LIMIT {
        if current == target {
            return true;
        }
        let Ok(Some(guest)) = db.guest_of(&current) else {
            return false;
        };
        current = guest.id;
    }
    false
}

const STACK_HOLD: Duration = Duration::from_millis(1200);

struct StackAim {
    ticket: u64,
    host: String,
    ready: bool,
}

fn stack_aims() -> &'static Mutex<HashMap<String, StackAim>> {
    static AIMS: LazyLock<Mutex<HashMap<String, StackAim>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &AIMS
}

fn aim_pending(guest_id: &str) -> bool {
    stack_aims()
        .lock()
        .ok()
        .and_then(|aims| aims.get(guest_id).map(|_| ()))
        .is_some()
}

fn dragging() -> &'static Mutex<HashSet<String>> {
    static DRAGGING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    &DRAGGING
}

fn drag_active(label: &str) -> bool {
    dragging()
        .lock()
        .ok()
        .and_then(|labels| labels.get(label).map(|_| ()))
        .is_some()
}

fn corner_resizing() -> &'static Mutex<HashSet<String>> {
    static RESIZING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    &RESIZING
}

fn resize_active(label: &str) -> bool {
    corner_resizing()
        .lock()
        .ok()
        .and_then(|labels| labels.get(label).map(|_| ()))
        .is_some()
}

/// New outer size while dragging the bottom-right corner. `dx` and `dy` are cursor travel.
pub fn southeast_size(start_w: i32, start_h: i32, dx: i32, dy: i32, min_w: i32, min_h: i32) -> (i32, i32) {
    (
        start_w.saturating_add(dx).max(min_w),
        start_h.saturating_add(dy).max(min_h),
    )
}

pub fn begin_corner_resize(app: AppHandle, label: String, done: std::sync::mpsc::Sender<()>) {
    let finish = |done: std::sync::mpsc::Sender<()>| {
        let _ = done.send(());
    };
    let Some(window) = app.get_webview_window(&label) else {
        finish(done);
        return;
    };
    let (Ok(cursor), Ok(size), Ok(scale)) = (app.cursor_position(), window.outer_size(), window.scale_factor()) else {
        finish(done);
        return;
    };
    if let Ok(mut labels) = corner_resizing().lock() {
        if !labels.insert(label.clone()) {
            finish(done);
            return;
        }
    }
    let start_x = cursor.x.round() as i32;
    let start_y = cursor.y.round() as i32;
    let start_w = size.width as i32;
    let start_h = size.height as i32;
    let min_w = (220.0 * scale).round().max(1.0) as i32;
    let min_h = (140.0 * scale).round().max(1.0) as i32;
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut saw_down = false;
        while started.elapsed() < Duration::from_secs(20) {
            let down = left_button_down();
            if down {
                saw_down = true;
            } else if saw_down || started.elapsed() > Duration::from_millis(200) {
                break;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let app2 = app.clone();
            let label2 = label.clone();
            let posted = app.run_on_main_thread(move || {
                let applied = app2.cursor_position().ok().map(|cursor| {
                    let dx = cursor.x.round() as i32 - start_x;
                    let dy = cursor.y.round() as i32 - start_y;
                    let (width, height) = southeast_size(start_w, start_h, dx, dy, min_w, min_h);
                    if let Some(window) = app2.get_webview_window(&label2) {
                        let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
                    }
                });
                let _ = tx.send(applied);
            });
            if posted.is_err() {
                break;
            }
            let _ = rx.recv_timeout(Duration::from_millis(80));
            std::thread::sleep(Duration::from_millis(12));
        }
        if let Ok(mut labels) = corner_resizing().lock() {
            labels.remove(&label);
        }
        let app2 = app.clone();
        let label2 = label.clone();
        let _ = app.run_on_main_thread(move || {
            schedule_settle(&app2, &label2, label2.strip_prefix("pin-").map(str::to_string), true);
        });
        finish(done);
    });
}

pub fn begin_memo_drag(label: &str) {
    if let Ok(mut labels) = dragging().lock() {
        labels.insert(label.to_string());
    }
    if let Ok(mut parked) = parks().lock() {
        parked.remove(label);
    }
}

pub fn end_memo_drag(app: &AppHandle, label: &str) {
    if let Ok(mut labels) = dragging().lock() {
        labels.remove(label);
    }
    let Some(guest_id) = label.strip_prefix("pin-") else {
        return;
    };
    let aim = stack_aims().lock().ok().and_then(|mut aims| aims.remove(guest_id));
    let Some(aim) = aim else {
        return;
    };
    show_aim(app, &aim.host, "off");
    if !aim.ready {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = attach_if_covering(app, guest_id, &window);
}

fn show_aim(app: &AppHandle, host_id: &str, mode: &str) {
    if let Some(window) = app.get_webview_window(&pin_label(host_id)) {
        let _ = window.emit("stack-aim", mode);
    }
}

fn aim_checked() -> &'static Mutex<HashMap<String, Instant>> {
    static CHECKED: LazyLock<Mutex<HashMap<String, Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &CHECKED
}

fn arm_stack_attach(app: &AppHandle, guest_id: &str, window: &WebviewWindow) {
    if !snap_enabled(app) {
        return;
    }
    {
        let mut checked = aim_checked()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if checked
            .get(guest_id)
            .is_some_and(|at| at.elapsed() < Duration::from_millis(90))
        {
            return;
        }
        checked.insert(guest_id.to_string(), Instant::now());
    }
    let target = stack_target(app, guest_id, window);
    let ticket = {
        let mut aims = stack_aims().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match (&target, aims.get(guest_id)) {
            (Some(host), Some(aim)) if aim.host == *host => return,
            (None, None) => return,
            _ => {}
        }
        let previous = aims.remove(guest_id);
        if let Some(previous) = &previous {
            show_aim(app, &previous.host, "off");
        }
        let Some(host) = target else {
            return;
        };
        let ticket = previous.map(|aim| aim.ticket).unwrap_or(0).wrapping_add(1);
        aims.insert(
            guest_id.to_string(),
            StackAim {
                ticket,
                host: host.clone(),
                ready: false,
            },
        );
        show_aim(app, &host, "hold");
        ticket
    };
    let app = app.clone();
    let guest_id = guest_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STACK_HOLD).await;
        let host = {
            let aims = stack_aims().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(aim) = aims.get(&guest_id) else {
                return;
            };
            if aim.ticket != ticket || aim.ready {
                return;
            }
            aim.host.clone()
        };
        let _ = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(&pin_label(&guest_id)) else {
                return;
            };
            let still = stack_target(&app, &guest_id, &window).as_deref() == Some(host.as_str());
            if !still {
                show_aim(&app, &host, "off");
                if let Ok(mut aims) = stack_aims().lock() {
                    if aims.get(&guest_id).is_some_and(|aim| aim.ticket == ticket) {
                        aims.remove(&guest_id);
                    }
                }
                return;
            }
            if let Ok(mut aims) = stack_aims().lock() {
                if let Some(aim) = aims.get_mut(&guest_id) {
                    if aim.ticket == ticket {
                        aim.ready = true;
                    }
                }
            }
            show_aim(&app, &host, "ready");
        });
    });
}

fn attach_if_covering(app: &AppHandle, guest_id: &str, window: &WebviewWindow) -> bool {
    let Some(root_id) = stack_target(app, guest_id, window) else {
        return false;
    };
    let db = app.state::<AppState>().db.clone();
    if chain_contains(&db, guest_id, &root_id) {
        return false;
    }
    let Ok(tail) = db.stack_tail(&root_id) else {
        return false;
    };
    if tail == guest_id {
        return false;
    }
    let incoming = db.chain_after(guest_id).map(|chain| chain.len()).unwrap_or(0);
    let already = db.chain_after(&root_id).map(|chain| chain.len()).unwrap_or(0);
    if already + 1 + incoming > STACK_LIMIT {
        return false;
    }
    if db.set_stack_host(guest_id, Some(&tail)).is_err() {
        return false;
    }
    let extra = card_logical_height(window);
    let _ = app.emit("stack-changed", extra);
    close_pinned(app, guest_id);
    true
}

fn card_logical_height(window: &WebviewWindow) -> i32 {
    let Ok(size) = window.outer_size() else {
        return 0;
    };
    let Ok(scale) = window.scale_factor() else {
        return 0;
    };
    let pad = ((CARD_PAD_TOP + CARD_PAD_BOTTOM) * scale).round() as i32;
    let card = size.height as i32 - pad;
    if scale <= f64::EPSILON {
        return card.max(1);
    }
    (card.max(1) as f64 / scale).round() as i32
}

fn stack_target(app: &AppHandle, guest_id: &str, _window: &WebviewWindow) -> Option<String> {
    let db = app.state::<AppState>().db.clone();
    let cursor = app.cursor_position().ok()?;
    let vx = cursor.x.round() as i32;
    let vy = cursor.y.round() as i32;
    for (label, other) in app.webview_windows() {
        let Some(id) = label.strip_prefix("pin-") else {
            continue;
        };
        if id == guest_id || !other.is_visible().unwrap_or(false) {
            continue;
        }
        if db.get(id).ok().flatten().and_then(|note| note.stack_host).is_some() {
            continue;
        }
        if chain_contains(&db, guest_id, id) {
            continue;
        }
        let Ok(other_pos) = other.outer_position() else {
            continue;
        };
        let Ok(other_size) = other.outer_size() else {
            continue;
        };
        let Ok(scale) = other.scale_factor() else {
            continue;
        };
        let pad_x = (CARD_PAD_X * scale).round() as i32;
        let pad_top = (CARD_PAD_TOP * scale).round() as i32;
        let left = other_pos.x + pad_x;
        let top = other_pos.y + pad_top;
        let width = (other_size.width as i32 - pad_x.saturating_mul(2)).max(1);
        let height = (other_size.height as i32 - pad_top - (CARD_PAD_BOTTOM * scale).round() as i32).max(1);
        if vx >= left && vx < left + width && vy >= top && vy < top + height {
            return Some(id.to_string());
        }
    }
    None
}

pub fn detach_guest(
    app: &AppHandle,
    guest_id: &str,
    at: Option<(i32, i32, i32, i32)>,
    shown_theme: Option<&str>,
    follow: Option<(i32, i32, i32)>,
) {
    let db = app.state::<AppState>().db.clone();
    let parent = db
        .get(guest_id)
        .ok()
        .flatten()
        .and_then(|note| note.stack_host);
    let Some(parent) = parent else {
        return;
    };
    let root = db.stack_root_id(&parent).unwrap_or(parent.clone());
    if let Some(theme) = shown_theme {
        let inherited = db
            .get(guest_id)
            .ok()
            .flatten()
            .and_then(|note| note.theme)
            .is_none();
        keep_shown_theme(&db, guest_id, theme);
        if inherited {
            if let Ok(chain) = db.chain_after(guest_id) {
                for note in chain {
                    keep_shown_theme(&db, &note.id, theme);
                }
            }
        }
    }
    if db.set_stack_host(guest_id, None).is_err() {
        return;
    }
    if let Some(place) = at {
        if let Ok(mut pending) = place_at().lock() {
            pending.insert(guest_id.to_string(), place);
        }
    }
    if follow.is_some() {
        if let Ok(mut active) = following().lock() {
            active.insert(guest_id.to_string());
        }
    }
    open_pinned(app, guest_id);
    if app.get_webview_window(&pin_label(&root)).is_some() {
        let _ = app.emit("stack-changed", 0_i32);
    }
    if let Some((grab_x, grab_y, pull)) = follow {
        let (origin_x, origin_y) = at.map(|(x, y, _, _)| (x, y)).unwrap_or((0, 0));
        follow_detached(
            app.clone(),
            guest_id.to_string(),
            parent,
            origin_x,
            origin_y,
            grab_x,
            grab_y,
            pull.max(1),
        );
    }
}

fn keep_shown_theme(db: &crate::notes::Db, id: &str, theme: &str) {
    let Ok(Some(note)) = db.get(id) else {
        return;
    };
    if note.theme.is_some() {
        return;
    }
    let _ = db.save_look(
        id,
        note.opacity,
        note.hue_light,
        note.hue_dark,
        &note.swatches,
        Some(theme),
    );
}

fn following() -> &'static Mutex<HashSet<String>> {
    static FOLLOWING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    &FOLLOWING
}

fn follow_active(id: &str) -> bool {
    following()
        .lock()
        .ok()
        .and_then(|ids| ids.get(id).map(|_| ()))
        .is_some()
}

fn follow_detached(
    app: AppHandle,
    guest_id: String,
    parent: String,
    origin_x: i32,
    origin_y: i32,
    grab_x: i32,
    grab_y: i32,
    pull: i32,
) {
    std::thread::spawn(move || {
        let mut last = (origin_x, origin_y);
        let started = Instant::now();
        while left_button_down() && started.elapsed() < Duration::from_secs(20) {
            let (tx, rx) = std::sync::mpsc::channel();
            let app2 = app.clone();
            let id = guest_id.clone();
            let posted = app.run_on_main_thread(move || {
                let point = app2.cursor_position().ok().map(|cursor| {
                    let x = cursor.x.round() as i32 - grab_x;
                    let y = cursor.y.round() as i32 - grab_y;
                    if let Some(window) = app2.get_webview_window(&pin_label(&id)) {
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                    (x, y)
                });
                let _ = tx.send(point);
            });
            if posted.is_err() {
                break;
            }
            if let Ok(Some(point)) = rx.recv_timeout(Duration::from_millis(80)) {
                last = point;
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        let dx = i64::from(last.0) - i64::from(origin_x);
        let dy = i64::from(last.1) - i64::from(origin_y);
        let pull = i64::from(pull);
        let pulled = dx * dx + dy * dy >= pull * pull;
        let app2 = app.clone();
        let id = guest_id.clone();
        let parent = parent.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(mut active) = following().lock() {
                active.remove(&id);
            }
            let db = app2.state::<AppState>().db.clone();
            if !pulled {
                let _ = db.set_stack_host(&id, Some(&parent));
                close_pinned(&app2, &id);
                let root = db.stack_root_id(&parent).unwrap_or(parent);
                if app2.get_webview_window(&pin_label(&root)).is_some() {
                    let _ = app2.emit("stack-changed", 0_i32);
                }
                return;
            }
            if let Some(window) = app2.get_webview_window(&pin_label(&id)) {
                save_pin_frame(&app2, &id, &window);
            }
        });
    });
}

#[cfg(target_os = "macos")]
fn left_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> u8;
    }
    unsafe { CGEventSourceButtonState(0, 0) != 0 }
}

#[cfg(target_os = "windows")]
fn left_button_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(0x01) < 0 }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn left_button_down() -> bool {
    false
}

pub fn prepare_remove(app: &AppHandle, id: &str) {
    let db = app.state::<AppState>().db.clone();
    let parent = db.get(id).ok().flatten().and_then(|note| note.stack_host);
    let child = db.guest_of(id).ok().flatten();
    if let Some(child) = &child {
        let _ = db.set_stack_host(&child.id, parent.as_deref());
    }
    if let Some(parent) = parent {
        let _ = db.set_stack_host(id, None);
        let root = db.stack_root_id(&parent).unwrap_or(parent);
        if app.get_webview_window(&pin_label(&root)).is_some() {
            let _ = app.emit("stack-changed", 0_i32);
        }
    } else if let Some(child) = child {
        open_pin(app, &child.id);
    }
}

fn overlap_span(start: i32, length: i32, area_start: i32, area_end: i32) -> i32 {
    let end = start.saturating_add(length);
    area_end.min(end).saturating_sub(area_start.max(start))
}

/// Where to put a card that is even slightly, or almost entirely, off the left, right, or bottom.
/// `None` when the card is fully on screen or fully past that edge.
pub fn slide_card_into_view(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
) -> Option<(i32, i32)> {
    let area_right = area_x.saturating_add(area_w);
    let area_bottom = area_y.saturating_add(area_h);
    let mut next_left = left;
    let mut next_top = top;
    let mut moved = false;
    if left < area_x && overlap_span(left, width, area_x, area_right) > 0 {
        next_left = area_x;
        moved = true;
    } else if left.saturating_add(width) > area_right && overlap_span(left, width, area_x, area_right) > 0 {
        next_left = area_right.saturating_sub(width);
        moved = true;
    }
    if top.saturating_add(height) > area_bottom && overlap_span(top, height, area_y, area_bottom) > 0 {
        next_top = area_bottom.saturating_sub(height);
        moved = true;
    }
    if moved { Some((next_left, next_top)) } else { None }
}

struct Park {
    home_x: i32,
    home_y: i32,
    ticket: u64,
    quiet_until: Instant,
}

fn parks() -> &'static Mutex<HashMap<String, Park>> {
    static PARKS: LazyLock<Mutex<HashMap<String, Park>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    &PARKS
}

fn park_quiet(label: &str) -> bool {
    parks()
        .lock()
        .ok()
        .and_then(|parked| parked.get(label).map(|park| park.quiet_until > Instant::now()))
        .unwrap_or(false)
}

fn glide_window(app: AppHandle, label: String, ticket: u64, from_x: i32, from_y: i32, to_x: i32, to_y: i32, clear: bool) {
    tauri::async_runtime::spawn(async move {
        let steps = 8;
        for step in 1..=steps {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let t = step as f64 / steps as f64;
            let eased = 1.0 - (1.0 - t).powi(3);
            let x = from_x + ((to_x - from_x) as f64 * eased).round() as i32;
            let y = from_y + ((to_y - from_y) as f64 * eased).round() as i32;
            let done = step == steps;
            let app2 = app.clone();
            let label2 = label.clone();
            let _ = app.run_on_main_thread(move || {
                let current = parks().lock().ok().and_then(|parked| {
                    parked.get(&label2).filter(|park| park.ticket == ticket).map(|_| ())
                });
                if current.is_none() || drag_active(&label2) {
                    return;
                }
                if let Some(window) = app2.get_webview_window(&label2) {
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
                if done && clear {
                    if let Ok(mut parked) = parks().lock() {
                        if parked.get(&label2).is_some_and(|park| park.ticket == ticket) {
                            parked.remove(&label2);
                        }
                    }
                }
            });
        }
    });
}

pub fn slide_into_view(app: &AppHandle, label: &str) {
    if drag_active(label) || resize_active(label) || follow_active(label.strip_prefix("pin-").unwrap_or("")) {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Some(monitor) = monitor_containing(app, position.x, position.y) else {
        return;
    };
    let area = monitor.work_area();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_top = (CARD_PAD_TOP * scale).round() as i32;
    let pad_bottom = (CARD_PAD_BOTTOM * scale).round() as i32;
    let left = position.x + pad_x;
    let top = position.y + pad_top;
    let width = (size.width as i32 - pad_x.saturating_mul(2)).max(1);
    let height = (size.height as i32 - pad_top - pad_bottom).max(1);
    let Some((next_left, next_top)) = slide_card_into_view(
        left,
        top,
        width,
        height,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    ) else {
        return;
    };
    let target_x = next_left - pad_x;
    let target_y = next_top - pad_top;
    if (target_x - position.x).abs() <= 1 && (target_y - position.y).abs() <= 1 {
        return;
    }
    let ticket = {
        let Ok(mut parked) = parks().lock() else {
            return;
        };
        let home_x = parked.get(label).map(|park| park.home_x).unwrap_or(position.x);
        let home_y = parked.get(label).map(|park| park.home_y).unwrap_or(position.y);
        let ticket = parked.get(label).map(|park| park.ticket).unwrap_or(0).wrapping_add(1);
        parked.insert(
            label.to_string(),
            Park {
                home_x,
                home_y,
                ticket,
                quiet_until: Instant::now() + Duration::from_millis(500),
            },
        );
        ticket
    };
    glide_window(
        app.clone(),
        label.to_string(),
        ticket,
        position.x,
        position.y,
        target_x,
        target_y,
        false,
    );
}

pub fn slide_back(app: &AppHandle, label: &str) {
    if drag_active(label) || resize_active(label) {
        if let Ok(mut parked) = parks().lock() {
            parked.remove(label);
        }
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let (home_x, home_y, ticket) = {
        let Ok(mut parked) = parks().lock() else {
            return;
        };
        let Some(park) = parked.get(label) else {
            return;
        };
        if (position.x - park.home_x).abs() <= 1 && (position.y - park.home_y).abs() <= 1 {
            parked.remove(label);
            return;
        }
        let ticket = park.ticket.wrapping_add(1);
        let home = (park.home_x, park.home_y, ticket);
        if let Some(park) = parked.get_mut(label) {
            park.ticket = ticket;
            park.quiet_until = Instant::now() + Duration::from_millis(500);
        }
        home
    };
    glide_window(app.clone(), label.to_string(), ticket, position.x, position.y, home_x, home_y, true);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoverStep {
    Idle,
    Reveal,
    Restore,
}

/// What to do when the cursor enters or leaves a memo that is not the active window.
pub fn offscreen_hover_step(was_over: bool, is_over: bool, focused: bool) -> HoverStep {
    if focused || is_over == was_over {
        HoverStep::Idle
    } else if is_over {
        HoverStep::Reveal
    } else {
        HoverStep::Restore
    }
}

fn hover_over() -> &'static Mutex<HashSet<String>> {
    static OVER: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
    &OVER
}

fn gesture_blocks_hover() -> bool {
    let dragging = dragging().lock().ok().is_some_and(|labels| !labels.is_empty());
    let resizing = corner_resizing().lock().ok().is_some_and(|labels| !labels.is_empty());
    dragging || resizing
}

fn tick_offscreen_hover(app: &AppHandle) {
    if gesture_blocks_hover() {
        if let Ok(mut over) = hover_over().lock() {
            over.clear();
        }
        return;
    }
    if left_button_down() {
        return;
    }
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let cx = cursor.x.round() as i32;
    let cy = cursor.y.round() as i32;
    let mut hits = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == SETTINGS || label == PREVIEW || !window.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            continue;
        };
        let over_window = cx >= position.x
            && cy >= position.y
            && cx < position.x.saturating_add(size.width as i32)
            && cy < position.y.saturating_add(size.height as i32);
        hits.push((label, over_window, window.is_focused().unwrap_or(false)));
    }
    let Ok(mut over) = hover_over().lock() else {
        return;
    };
    let mut next = HashSet::new();
    for (label, is_over, focused) in hits {
        let was_over = over.contains(&label);
        match offscreen_hover_step(was_over, is_over, focused) {
            HoverStep::Reveal => slide_into_view(app, &label),
            HoverStep::Restore => slide_back(app, &label),
            HoverStep::Idle => {}
        }
        if is_over && !focused {
            next.insert(label);
        }
    }
    *over = next;
}

pub fn watch_offscreen_hover(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let (tx, rx) = std::sync::mpsc::channel();
            let app2 = app.clone();
            let posted = app.run_on_main_thread(move || {
                tick_offscreen_hover(&app2);
                let _ = tx.send(());
            });
            if posted.is_err() {
                break;
            }
            let _ = rx.recv_timeout(Duration::from_millis(120));
        }
    });
}

pub fn move_towards(app: &AppHandle, label: &str, x: i32, y: i32) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if !snap_enabled(app) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Some(monitor) = monitor_containing(app, x, y) else {
        let _ = window.set_position(PhysicalPosition::new(x, y));
        return;
    };
    let area = monitor.work_area();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_top = (CARD_PAD_TOP * scale).round() as i32;
    let size = window.outer_size().unwrap_or(PhysicalSize::new(1, 1));
    let card_w = (size.width as i32 - pad_x.saturating_mul(2)).max(1);
    let card_h = (size.height as i32 - pad_top - (CARD_PAD_BOTTOM * scale).round() as i32).max(1);
    let catch = (f64::from(EDGE_CATCH) * scale).round() as i32;
    let (nx, ny) = snap_screen_edges(
        x,
        y,
        card_w,
        card_h,
        pad_x,
        pad_top,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
        catch,
    );
    let _ = window.set_position(PhysicalPosition::new(nx, ny));
}

pub fn end_snap_drag(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let mut holds = state
        .drag_hold
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    holds.remove(label);
}

fn monitor_containing(app: &AppHandle, x: i32, y: i32) -> Option<tauri::Monitor> {
    let point = PhysicalPosition::new(f64::from(x), f64::from(y));
    let monitors = app.available_monitors().ok()?;
    monitors
        .into_iter()
        .find(|monitor| contains(monitor, point))
        .or_else(|| app.primary_monitor().ok().flatten())
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
    fn blur_hides_the_card() {
        let (state, action) = transition(
            Visibility::Shown,
            Gesture::FocusLost { suppress_blur: false },
        );
        assert_eq!(state, Visibility::Hidden);
        assert_eq!(action, Action::HideAndSave);
    }

    #[test]
    fn tray_card_sits_under_a_top_right_icon() {
        let (x, y) = tray_card_origin(1800, 0, 40, 24, 400, 500, 0, 28, 1920, 1052, 8);
        assert_eq!(x, 1440);
        assert_eq!(y, 32);
    }

    #[test]
    fn tray_card_sits_above_a_bottom_right_icon() {
        let (x, y) = tray_card_origin(1800, 1040, 40, 40, 400, 500, 0, 0, 1920, 1000, 8);
        assert_eq!(x, 1440);
        assert_eq!(y, 500);
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
    fn five_by_three_anchors_span_the_work_area() {
        let points = snap_anchors(0, 0, 1000, 600, 200, 100);
        assert_eq!(points.len(), 15);
        assert_eq!(points[0], (0, 0));
        assert_eq!(points[4], (800, 0));
        assert_eq!(points[10], (0, 500));
        assert_eq!(points[14], (800, 500));
    }

    #[test]
    fn nearest_anchor_keeps_a_close_corner_and_ignores_a_far_one() {
        let points = snap_anchors(0, 0, 1000, 600, 200, 100);
        assert_eq!(nearest_anchor(10, 12, &points, Some(48)), Some((0, 0)));
        assert_eq!(nearest_anchor(400, 250, &points, Some(48)), None);
        assert!(nearest_anchor(400, 250, &points, None).is_some());
    }

    #[test]
    fn nearest_line_snaps_an_edge_that_is_close() {
        assert_eq!(nearest_line(190, &[0, 200, 400], 48), Some(200));
        assert_eq!(nearest_line(120, &[0, 200, 400], 48), None);
    }

    #[test]
    fn magnet_locks_close_holds_and_then_lets_go() {
        let anchors = [(0, 0), (400, 0)];
        let (x, y, hold) = magnet_origin(10, 8, 0, 0, &anchors, None, 156, 64, 240);
        assert_eq!((x, y), (0, 0));
        assert_eq!(hold, Some((0, 0)));
        let (x, y, hold) = magnet_origin(100, 0, 0, 0, &anchors, hold, 156, 64, 240);
        assert_eq!((x, y), (0, 0));
        assert_eq!(hold, Some((0, 0)));
        let (x, y, hold) = magnet_origin(400, 0, 0, 0, &anchors, Some((0, 0)), 156, 64, 240);
        assert_eq!((x, y), (400, 0));
        assert_eq!(hold, Some((400, 0)));
    }

    #[test]
    fn hovering_an_unfocused_memo_reveals_it_and_leaving_restores_it() {
        use super::HoverStep;
        assert_eq!(offscreen_hover_step(false, true, false), HoverStep::Reveal);
        assert_eq!(offscreen_hover_step(true, false, false), HoverStep::Restore);
        assert_eq!(offscreen_hover_step(true, true, false), HoverStep::Idle);
        assert_eq!(offscreen_hover_step(true, false, true), HoverStep::Idle);
    }

    #[test]
    fn a_half_hidden_memo_slides_back_onto_the_screen() {
        let shown = slide_card_into_view(-150, 40, 300, 200, 0, 0, 1000, 800);
        assert_eq!(shown, Some((0, 40)));
        let right = slide_card_into_view(850, 40, 300, 200, 0, 0, 1000, 800);
        assert_eq!(right, Some((700, 40)));
        let bottom = slide_card_into_view(40, 700, 300, 200, 0, 0, 1000, 800);
        assert_eq!(bottom, Some((40, 600)));
        assert_eq!(slide_card_into_view(40, 40, 300, 200, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-8, 40, 300, 200, 0, 0, 1000, 800), Some((0, 40)));
        assert_eq!(slide_card_into_view(-294, 40, 300, 200, 0, 0, 1000, 800), Some((0, 40)));
        assert_eq!(slide_card_into_view(-400, 40, 300, 200, 0, 0, 1000, 800), None);
    }

    #[test]
    fn the_bottom_right_corner_changes_the_window_size() {
        assert_eq!(southeast_size(400, 500, 30, -20, 220, 140), (430, 480));
        assert_eq!(southeast_size(400, 500, -300, -400, 220, 140), (220, 140));
    }

    #[test]
    fn a_memo_lines_up_with_a_nearby_memo_edge() {
        let neighbors = [(110, 0, 100, 80)];
        let (x, y) = snap_memo_edges(0, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (10, 0));
        let (x, y) = snap_memo_edges(400, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (400, 0));
        let (x, y) = snap_memo_edges(50, 0, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (50, 0));
    }

    #[test]
    fn a_memo_moves_freely_until_it_meets_a_screen_edge() {
        let (x, y) = snap_screen_edges(200, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (200, 150));
        let (x, y) = snap_screen_edges(10, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (0, 150));
        let (x, y) = snap_screen_edges(680, 150, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (700, 150));
        let (x, y) = snap_screen_edges(200, 590, 300, 200, 0, 0, 0, 0, 1000, 800, 36);
        assert_eq!((x, y), (200, 600));
    }

    #[test]
    fn magnet_eases_toward_a_point_before_locking() {
        let anchors = [(0, 0)];
        let (x, y, hold) = magnet_origin(120, 0, 0, 0, &anchors, None, 156, 64, 240);
        assert!(hold.is_none());
        assert!(x > 0 && x < 120);
        assert_eq!(y, 0);
        let (x, y, hold) = magnet_origin(500, 400, 0, 0, &anchors, None, 156, 64, 240);
        assert_eq!((x, y), (500, 400));
        assert!(hold.is_none());
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
    fn organized_notes_leave_a_few_pixels_between_cards() {
        let layout = organize_grid(0, 0, 1400, 900, 408, 476, 24, 24, 32, 4);
        assert_eq!(layout.step_x, 364);
        assert_eq!(layout.step_y, 424);
        let first = visual_card(layout.origin_x, layout.origin_y, 408, 476, 24, 24, 32);
        let second = visual_card(
            layout.origin_x + layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert_eq!(first.0, 4);
        assert_eq!(second.0 - (first.0 + first.2), 4);
        let below = visual_card(
            layout.origin_x,
            layout.origin_y + layout.step_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert_eq!(below.1 - (first.1 + first.3), 4);
        let last_col = (layout.columns - 1) as i32;
        let last = visual_card(
            layout.origin_x + last_col * layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        assert!(last.0 + last.2 <= 1400 - 4);
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
