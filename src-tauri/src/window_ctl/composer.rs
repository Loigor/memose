use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

use super::drag::{schedule_settle, slide_back, slide_into_view_sized};
use super::pin::{hide_pinned, open_pinned_windows};
use super::{
    clamp_position, contains, hide_pin_tabs, schedule_resign, snap_enabled, snap_screen_edges,
    tray_card_origin, CARD_HEIGHT, CARD_PAD_BOTTOM, CARD_PAD_TOP, CARD_PAD_X, CARD_WIDTH,
    EDGE_CATCH, FOCUS_GRACE, WINDOW,
};
use crate::notes::request_sync;
use crate::state::AppState;

const FLUSH_TIMEOUT: Duration = Duration::from_millis(500);

pub fn attach(app: &tauri::AppHandle) {
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
        WindowEvent::Focused(false) => {
            slide_back(&handle, WINDOW);
            schedule_resign(&handle);
        }
        WindowEvent::Moved(_) => schedule_settle(&handle, WINDOW, None, false),
        WindowEvent::Resized(_) => schedule_settle(&handle, WINDOW, None, true),
        _ => {}
    });
}

pub fn show_composer(app: &tauri::AppHandle) {
    app.state::<AppState>().shown.store(true, Ordering::SeqCst);
    present(app, false);
}

pub fn show_fresh_memo(app: &tauri::AppHandle) {
    if composer_open(app) {
        cycle_composer(app);
        return;
    }
    app.state::<AppState>().shown.store(true, Ordering::SeqCst);
    present(app, true);
}

pub fn hide_composer(app: &tauri::AppHandle) {
    if app.state::<AppState>().shown.load(Ordering::SeqCst) {
        hide_and_save(app, false);
    }
}

pub fn hide_memos(app: &tauri::AppHandle) {
    app.state::<AppState>()
        .pinned_mode
        .store(false, Ordering::SeqCst);
    hide_pinned(app);
    hide_pin_tabs(app);
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

pub(super) fn hide_and_save(app: &tauri::AppHandle, from_blur: bool) {
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
            if committed {
                request_sync(&app);
            }
            return;
        }
        hide_window(&app);
        if committed {
            request_sync(&app);
        }
    });
}

pub fn submit_flush(
    app: &tauri::AppHandle,
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

fn hide_window(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.suppress_blur.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    if !super::pin_windows_visible(app) {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    state.shown.store(false, Ordering::SeqCst);
    state.hiding.store(false, Ordering::SeqCst);
}

pub fn apply_composer_size(app: &tauri::AppHandle, width: Option<i32>, height: Option<i32>) {
    let Some(window) = app.get_webview_window(WINDOW) else {
        return;
    };
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {
            let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
            slide_into_view_sized(app, WINDOW, width, height);
        }
        _ => {
            let _ = window.set_size(LogicalSize::new(CARD_WIDTH, CARD_HEIGHT));
        }
    }
}

fn cycle_composer(app: &tauri::AppHandle) {
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

fn present(app: &tauri::AppHandle, fresh: bool) {
    present_at(app, fresh, None);
}

fn present_at(app: &tauri::AppHandle, fresh: bool, anchor: Option<TrayAnchor>) {
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
    app: tauri::AppHandle,
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

fn order_composer_front(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    fresh: bool,
    generation: u64,
) {
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
    app: &tauri::AppHandle,
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

fn place_at_cursor(app: &tauri::AppHandle, window: &WebviewWindow) -> Option<(i32, i32)> {
    let cursor = app.cursor_position().ok()?;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .find(|monitor| contains(monitor, cursor))
        .cloned();
    let monitor = match monitor {
        Some(monitor) => Some(monitor),
        None => window
            .current_monitor()
            .ok()?
            .or(app.primary_monitor().ok()?),
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

pub fn show_from_tray(app: &tauri::AppHandle, anchor: Option<TrayAnchor>) {
    let anchor = anchor.or_else(|| tray_anchor(app));
    open_pinned_windows(app);
    app.state::<AppState>().shown.store(true, Ordering::SeqCst);
    present_at(app, true, anchor);
    request_sync(app);
}

fn tray_anchor(app: &tauri::AppHandle) -> Option<TrayAnchor> {
    let tray = app.tray_by_id("main")?;
    tray.rect().ok().flatten().map(TrayAnchor::from_rect)
}

pub fn dismiss_composer(app: &tauri::AppHandle) {
    if composer_open(app) {
        hide_and_save(app, false);
    }
}

pub(super) fn composer_open(app: &tauri::AppHandle) -> bool {
    app.state::<AppState>().shown.load(Ordering::SeqCst)
        || app
            .get_webview_window(WINDOW)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
}
