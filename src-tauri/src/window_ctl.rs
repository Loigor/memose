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
    let script = format!(
        "globalThis.__memosePin={id_js};\
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
