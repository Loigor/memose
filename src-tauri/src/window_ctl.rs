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
        WindowEvent::Focused(false) => {
            slide_back(&handle, WINDOW);
            schedule_resign(&handle);
        }
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

/// How close a memo edge must be to a screen edge before it catches.
const EDGE_CATCH: i32 = 36;
const MEMO_CATCH: i32 = 36;
const STACK_LIMIT: usize = 8;

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
    if right_gap <= catch && right_gap <= left_gap {
        x = area_right.saturating_sub(card_w).saturating_sub(pad_x);
    } else if left_gap <= catch {
        x = area_x.saturating_sub(pad_x);
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
        let overlap_x = right.min(other_right).saturating_sub(left.max(other_left));
        let overlap_y = bottom.min(other_bottom).saturating_sub(top.max(other_top));
        if overlap_x > catch && overlap_y > catch {
            continue;
        }
        for edge in [right, left] {
            for other in [other_left, other_right] {
                let delta = other.saturating_sub(edge);
                let distance = delta.abs();
                if distance <= catch
                    && best_dx.is_none_or(|(best, best_delta)| {
                        distance < best || (distance == best && delta > best_delta)
                    })
                {
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
            if note.id == except || note.stack_host.is_some() {
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

fn place_at() -> &'static Mutex<HashMap<String, (i32, i32, i32, i32)>> {
    static PLACE: LazyLock<Mutex<HashMap<String, (i32, i32, i32, i32)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &PLACE
}

fn place_pin(app: &AppHandle, id: &str, window: &WebviewWindow) {
    let label = pin_label(id);
    suppress_settle(&label, Duration::from_millis(500));
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
        .filter(|note| note.id != except && note.stack_host.is_none())
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

fn height_sizing() -> &'static Mutex<HashMap<String, Instant>> {
    static SIZING: LazyLock<Mutex<HashMap<String, Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &SIZING
}

fn suppress_settle(label: &str, duration: Duration) {
    if let Ok(mut map) = height_sizing().lock() {
        map.insert(label.to_string(), Instant::now() + duration);
    }
}

fn height_sizing_active(label: &str) -> bool {
    height_sizing()
        .lock()
        .ok()
        .and_then(|map| map.get(label).copied())
        .is_some_and(|until| Instant::now() < until)
}

fn schedule_settle(app: &AppHandle, label: &str, note_id: Option<String>, resize: bool) {
    if height_sizing_active(label) || park_quiet(label) {
        return;
    }
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
    if resize_active(label)
        || drag_active(label)
        || height_sizing_active(label)
        || follow_active(note_id.unwrap_or(""))
    {
        return;
    }
    if snap_enabled(app) && !park_quiet(label) {
        if resize {
            suppress_settle(label, Duration::from_millis(350));
            snap_resized_edges(app, &window);
        } else if !aim_pending(note_id.unwrap_or("")) {
            suppress_settle(label, Duration::from_millis(350));
            snap_moved_corner(app, &window);
        }
    }
    if let Some(id) = note_id {
        if parks().lock().ok().is_none_or(|parked| !parked.contains_key(label)) {
            save_pin_frame(app, id, &window);
        }
    }
}

fn closer_snap(current: i32, screen: i32, memo: i32) -> i32 {
    let screen_move = (screen - current).abs();
    let memo_move = (memo - current).abs();
    if screen_move == 0 {
        memo
    } else if memo_move == 0 {
        screen
    } else if screen_move < memo_move {
        screen
    } else if memo_move < screen_move {
        memo
    } else if memo >= screen {
        memo
    } else {
        screen
    }
}

fn closer_snap_x(current: i32, screen: i32, memo: i32) -> i32 {
    let screen_move = (screen - current).abs();
    let memo_move = (memo - current).abs();
    if screen_move == 0 {
        memo
    } else if memo_move == 0 {
        screen
    } else if memo > current && screen < current {
        // When caught between a screen edge on the left and a memo on the right,
        // prioritize snapping to the right.
        memo
    } else if screen > current && memo < current {
        screen
    } else if screen_move < memo_move {
        screen
    } else if memo_move < screen_move {
        memo
    } else {
        screen.max(memo)
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

fn snap_target_for_origin(
    app: &AppHandle,
    window: &WebviewWindow,
    raw_x: i32,
    raw_y: i32,
) -> Option<(i32, i32)> {
    let Ok(scale) = window.scale_factor() else {
        return None;
    };
    let Some(monitor) = monitor_containing(app, raw_x, raw_y) else {
        return None;
    };
    let area = monitor.work_area();
    let pad_x = (CARD_PAD_X * scale).round() as i32;
    let pad_top = (CARD_PAD_TOP * scale).round() as i32;
    let Ok(size) = window.outer_size() else {
        return None;
    };
    let card_w = (size.width as i32 - pad_x.saturating_mul(2)).max(1);
    let card_h = (size.height as i32 - pad_top - (CARD_PAD_BOTTOM * scale).round() as i32).max(1);
    let catch = (f64::from(EDGE_CATCH) * scale).round() as i32;
    let (screen_x, screen_y) = snap_screen_edges(
        raw_x,
        raw_y,
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
        raw_x,
        raw_y,
        card_w,
        card_h,
        pad_x,
        pad_top,
        &neighbor_cards(app, window),
        memo_catch,
    );
    Some((
        closer_snap_x(raw_x, screen_x, memo_x),
        closer_snap(raw_y, screen_y, memo_y),
    ))
}

fn snap_moved_corner(app: &AppHandle, window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Some((x, y)) = snap_target_for_origin(app, window, position.x, position.y) else {
        return;
    };
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
    let left = position.x + pad_x;
    let right = position.x + size.width as i32 - pad_x;
    let bottom = position.y + size.height as i32 - pad_bottom;
    let area_left = area.position.x;
    let area_right = area.position.x + area.size.width as i32;
    let area_bottom = area.position.y + area.size.height as i32;
    let mut x = position.x;
    let mut width = size.width as i32;
    let mut height = size.height as i32;
    if (left - area_left).abs() <= threshold {
        let target_x = area_left - pad_x;
        if target_x != position.x {
            let next = width + (position.x - target_x);
            if next >= min_w {
                x = target_x;
                width = next;
            }
        }
    }
    if (right - area_right).abs() <= threshold {
        let next = area_right + pad_x - x;
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
    if x == position.x && width == size.width as i32 && height == size.height as i32 {
        return;
    }
    if x != position.x {
        let _ = window.set_position(PhysicalPosition::new(x, position.y));
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

const STACK_HOLD: Duration = Duration::from_millis(750);
const STACK_STILL_RADIUS: i32 = 10;

struct StackAim {
    host: String,
    anchor: (i32, i32),
    since: Instant,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeEdge {
    East,
    South,
    West,
    SouthEast,
    SouthWest,
}

pub fn resize_frame(
    start_x: i32,
    start_y: i32,
    start_w: i32,
    start_h: i32,
    dx: i32,
    dy: i32,
    min_w: i32,
    min_h: i32,
    edge: ResizeEdge,
) -> (i32, i32, i32, i32) {
    let width = match edge {
        ResizeEdge::East | ResizeEdge::SouthEast => start_w.saturating_add(dx).max(min_w),
        ResizeEdge::West | ResizeEdge::SouthWest => start_w.saturating_sub(dx).max(min_w),
        ResizeEdge::South => start_w,
    };
    let height = match edge {
        ResizeEdge::South | ResizeEdge::SouthEast | ResizeEdge::SouthWest => {
            start_h.saturating_add(dy).max(min_h)
        }
        ResizeEdge::East | ResizeEdge::West => start_h,
    };
    let x = match edge {
        ResizeEdge::West | ResizeEdge::SouthWest => {
            start_x.saturating_add(start_w.saturating_sub(width))
        }
        ResizeEdge::East | ResizeEdge::South | ResizeEdge::SouthEast => start_x,
    };
    (x, start_y, width, height)
}

pub fn begin_corner_resize(
    app: AppHandle,
    label: String,
    edge: ResizeEdge,
    done: std::sync::mpsc::Sender<()>,
) {
    let finish = |done: std::sync::mpsc::Sender<()>| {
        let _ = done.send(());
    };
    let Some(window) = app.get_webview_window(&label) else {
        finish(done);
        return;
    };
    let (Ok(cursor), Ok(pos), Ok(size), Ok(scale)) = (
        app.cursor_position(),
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
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
    let start_win_x = pos.x;
    let start_win_y = pos.y;
    let start_w = size.width as i32;
    let start_h = size.height as i32;
    let min_w = (220.0 * scale).round().max(1.0) as i32;
    let min_h = (140.0 * scale).round().max(1.0) as i32;
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut saw_down = false;
        let mut last_rect = (start_win_x, start_win_y, start_w, start_h);
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
            let prev_rect = last_rect;
            let posted = app.run_on_main_thread(move || {
                let mut next_rect = prev_rect;
                if let (Ok(cursor), Some(window)) =
                    (app2.cursor_position(), app2.get_webview_window(&label2))
                {
                    let dx = cursor.x.round() as i32 - start_x;
                    let dy = cursor.y.round() as i32 - start_y;
                    let (x, y, width, height) = resize_frame(
                        start_win_x,
                        start_win_y,
                        start_w,
                        start_h,
                        dx,
                        dy,
                        min_w,
                        min_h,
                        edge,
                    );
                    if (x, y) != (prev_rect.0, prev_rect.1) {
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                    if (width, height) != (prev_rect.2, prev_rect.3) {
                        let _ = window.set_size(PhysicalSize::new(
                            width.max(1) as u32,
                            height.max(1) as u32,
                        ));
                    }
                    next_rect = (x, y, width, height);
                }
                let _ = tx.send(next_rect);
            });
            if posted.is_err() {
                break;
            }
            if let Ok(rect) = rx.recv_timeout(Duration::from_millis(80)) {
                last_rect = rect;
            }
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

pub fn set_window_height(app: &AppHandle, label: &str, logical_height: i32) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if let Ok(mut map) = height_sizing().lock() {
        map.insert(label.to_string(), Instant::now() + Duration::from_millis(300));
    }
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let height = ((f64::from(logical_height.max(96))) * scale).round().max(1.0) as u32;
    let width = size.width.max(1);
    let _ = window.set_size(PhysicalSize::new(width, height));
    if let Some(id) = label.strip_prefix("pin-") {
        if parks().lock().ok().is_none_or(|parked| !parked.contains_key(label)) {
            save_pin_frame(app, id, &window);
        }
    }
}

pub fn begin_memo_drag(app: AppHandle, label: String) {
    if let Ok(mut parked) = parks().lock() {
        parked.remove(&label);
    }
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    let (Ok(cursor), Ok(start_pos)) = (app.cursor_position(), window.outer_position()) else {
        return;
    };
    let inserted = dragging()
        .lock()
        .map(|mut labels| labels.insert(label.clone()))
        .unwrap_or(false);
    if !inserted {
        return;
    }
    let grab_x = cursor.x.round() as i32 - start_pos.x;
    let grab_y = cursor.y.round() as i32 - start_pos.y;
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut saw_down = false;
        let mut last_pos = (start_pos.x, start_pos.y);
        while started.elapsed() < Duration::from_secs(20) {
            if !drag_active(&label) {
                return;
            }
            let down = left_button_down();
            if down {
                saw_down = true;
            } else if saw_down || started.elapsed() > Duration::from_millis(200) {
                break;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let app2 = app.clone();
            let label2 = label.clone();
            let prev_pos = last_pos;
            let posted = app.run_on_main_thread(move || {
                let mut next_pos = prev_pos;
                if drag_active(&label2) {
                    if let (Ok(cursor), Some(window)) =
                        (app2.cursor_position(), app2.get_webview_window(&label2))
                    {
                        let raw_x = cursor.x.round() as i32 - grab_x;
                        let raw_y = cursor.y.round() as i32 - grab_y;
                        let (mut x, mut y) = (raw_x, raw_y);
                        let guest_id = label2.strip_prefix("pin-");
                        if let Some(id) = guest_id {
                            arm_stack_attach(&app2, id, &window);
                        }
                        if snap_enabled(&app2) && !aim_pending(guest_id.unwrap_or("")) {
                            if let Some(snapped) = snap_target_for_origin(&app2, &window, raw_x, raw_y) {
                                x = snapped.0;
                                y = snapped.1;
                            }
                        }
                        if (x, y) != prev_pos {
                            let _ = window.set_position(PhysicalPosition::new(x, y));
                            next_pos = (x, y);
                        }
                    }
                }
                let _ = tx.send(next_pos);
            });
            if posted.is_err() {
                break;
            }
            if let Ok(pos) = rx.recv_timeout(Duration::from_millis(80)) {
                last_pos = pos;
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        let app2 = app.clone();
        let label2 = label.clone();
        let _ = app.run_on_main_thread(move || {
            finish_memo_drag(&app2, &label2);
        });
    });
}

pub fn end_memo_drag(app: &AppHandle, label: &str) {
    finish_memo_drag(app, label);
}

fn finish_memo_drag(app: &AppHandle, label: &str) {
    let was_dragging = dragging()
        .lock()
        .map(|mut labels| labels.remove(label))
        .unwrap_or(false);
    let note_id = label.strip_prefix("pin-");
    if let Some(guest_id) = note_id {
        if let Some(aim) = stack_aims().lock().ok().and_then(|mut aims| aims.remove(guest_id)) {
            show_aim(app, &aim.host, "off");
            if aim.ready {
                if let Some(window) = app.get_webview_window(label) {
                    if attach_if_covering(app, guest_id, &window, Some(&aim.host)) {
                        return;
                    }
                }
            }
        }
    }
    if was_dragging {
        settle_window(app, label, note_id, false);
    }
}

fn show_aim(app: &AppHandle, host_id: &str, mode: &str) {
    if let Some(window) = app.get_webview_window(&pin_label(host_id)) {
        let _ = window.emit("stack-aim", mode);
    }
}

fn clear_aim(app: &AppHandle, guest_id: &str) {
    if let Some(aim) = stack_aims().lock().ok().and_then(|mut aims| aims.remove(guest_id)) {
        show_aim(app, &aim.host, "off");
    }
}

fn arm_stack_attach(app: &AppHandle, guest_id: &str, window: &WebviewWindow) {
    let target = stack_target(app, guest_id, window);
    let cursor = app
        .cursor_position()
        .ok()
        .map(|point| (point.x.round() as i32, point.y.round() as i32))
        .unwrap_or((0, 0));
    let mut aims = stack_aims().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match target {
        Some(host) => {
            if let Some(aim) = aims.get_mut(guest_id) {
                if aim.host == host {
                    let moved = (cursor.0 - aim.anchor.0).abs() > STACK_STILL_RADIUS
                        || (cursor.1 - aim.anchor.1).abs() > STACK_STILL_RADIUS;
                    if moved && !aim.ready {
                        aim.anchor = cursor;
                        aim.since = Instant::now();
                        return;
                    }
                    if !aim.ready && aim.since.elapsed() >= STACK_HOLD {
                        aim.ready = true;
                        show_aim(app, &host, "ready");
                    }
                    return;
                }
            }
            if let Some(previous) = aims.remove(guest_id) {
                show_aim(app, &previous.host, "off");
            }
            show_aim(app, &host, "hold");
            aims.insert(
                guest_id.to_string(),
                StackAim {
                    host,
                    anchor: cursor,
                    since: Instant::now(),
                    ready: false,
                },
            );
        }
        None => {
            if let Some(previous) = aims.remove(guest_id) {
                show_aim(app, &previous.host, "off");
            }
        }
    }
}

const STACK_NOTE_OPEN_H: f64 = 420.0;
const STACK_NOTE_BAR_H: f64 = 52.0;

fn resize_stack_window(app: &AppHandle, root_id: &str) {
    resize_stack_window_with_open(app, root_id, None);
}

fn resize_stack_window_with_open(app: &AppHandle, root_id: &str, held_open: Option<&str>) {
    let label = pin_label(root_id);
    if app.get_webview_window(&label).is_none() {
        return;
    }
    let db = app.state::<AppState>().db.clone();
    let Ok(Some(root_note)) = db.get(root_id) else {
        return;
    };
    let chain = db.chain_after(root_id).unwrap_or_default();
    let root_bar = root_note.collapsed && held_open != Some(root_id);
    let mut opens = if root_bar { 0usize } else { 1usize };
    let mut bars = if root_bar { 1usize } else { 0usize };
    for note in &chain {
        if note.collapsed && held_open != Some(note.id.as_str()) {
            bars += 1;
        } else {
            opens += 1;
        }
    }
    let logical_height = (CARD_PAD_TOP
        + CARD_PAD_BOTTOM
        + (opens as f64) * STACK_NOTE_OPEN_H
        + (bars as f64) * STACK_NOTE_BAR_H)
        .round() as i32;
    set_window_height(app, &label, logical_height);
}

fn attach_if_covering(
    app: &AppHandle,
    guest_id: &str,
    window: &WebviewWindow,
    preferred_host: Option<&str>,
) -> bool {
    let Some(root_id) = stack_target(app, guest_id, window)
        .or_else(|| preferred_host.map(str::to_string))
    else {
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
    let total = already + 1 + incoming + 1;
    let held_open = if total >= 4 {
        let _ = db.set_collapsed(&root_id, true);
        if let Ok(chain) = db.chain_after(&root_id) {
            for note in chain {
                let _ = db.set_collapsed(&note.id, true);
            }
        }
        Some(guest_id)
    } else {
        None
    };
    let extra = card_logical_height(window);
    resize_stack_window_with_open(app, &root_id, held_open);
    let _ = app.emit("stack-changed", extra);
    close_pinned(app, guest_id);
    if let Some(host_window) = app.get_webview_window(&pin_label(&root_id)) {
        let _ = host_window.set_focus();
    }
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
    let cursor = app
        .cursor_position()
        .ok()
        .map(|point| (point.x.round() as i32, point.y.round() as i32))?;
    let mut best: Option<(i64, String)> = None;
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
        let inset_x = (24.0 * scale).round().min(f64::from(width) * 0.2) as i32;
        let inset_y = (16.0 * scale).round().min(f64::from(height) * 0.2) as i32;
        let point_inside = |(px, py): (i32, i32)| {
            px >= left + inset_x
                && px < left + width - inset_x
                && py >= top + inset_y
                && py < top + height - inset_y
        };
        if !point_inside(cursor) {
            continue;
        }
        let cx = left + width / 2;
        let cy = top + height / 2;
        let dx = i64::from(cursor.0) - i64::from(cx);
        let dy = i64::from(cursor.1) - i64::from(cy);
        let dist = dx * dx + dy * dy;
        if best.as_ref().is_none_or(|(best_dist, best_id)| {
            dist < *best_dist || (dist == *best_dist && id < best_id.as_str())
        }) {
            best = Some((dist, id.to_string()));
        }
    }
    best.map(|(_, id)| id)
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
    let host_opacity = db
        .get(&root)
        .ok()
        .flatten()
        .map(|note| note.opacity)
        .unwrap_or(100);
    keep_stack_look(&db, guest_id, host_opacity, shown_theme);
    if let Ok(chain) = db.chain_after(guest_id) {
        for note in chain {
            keep_stack_look(&db, &note.id, host_opacity, shown_theme);
        }
    }
    if db.set_stack_host(guest_id, None).is_err() {
        return;
    }
    let _ = db.set_collapsed(guest_id, false);
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
        resize_stack_window(app, &root);
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

fn keep_stack_look(db: &crate::notes::Db, id: &str, opacity: u8, shown_theme: Option<&str>) {
    let Ok(Some(note)) = db.get(id) else {
        return;
    };
    let theme = note.theme.as_deref().or(shown_theme);
    let _ = db.save_look(
        id,
        opacity,
        note.hue_light,
        note.hue_dark,
        &note.swatches,
        theme,
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
    let pull_sq = i64::from(pull) * i64::from(pull);
    std::thread::spawn(move || {
        let mut last = (origin_x, origin_y);
        let started = Instant::now();
        while left_button_down() && started.elapsed() < Duration::from_secs(20) {
            let (tx, rx) = std::sync::mpsc::channel();
            let app2 = app.clone();
            let id = guest_id.clone();
            let posted = app.run_on_main_thread(move || {
                let point = app2.cursor_position().ok().map(|cursor| {
                    let raw_x = cursor.x.round() as i32 - grab_x;
                    let raw_y = cursor.y.round() as i32 - grab_y;
                    let dx = i64::from(raw_x) - i64::from(origin_x);
                    let dy = i64::from(raw_y) - i64::from(origin_y);
                    let pulled_far = dx * dx + dy * dy >= pull_sq;
                    let (mut x, mut y) = (raw_x, raw_y);
                    if let Some(window) = app2.get_webview_window(&pin_label(&id)) {
                        if pulled_far {
                            arm_stack_attach(&app2, &id, &window);
                            if snap_enabled(&app2) && !aim_pending(&id) {
                                if let Some(snapped) = snap_target_for_origin(&app2, &window, raw_x, raw_y) {
                                    x = snapped.0;
                                    y = snapped.1;
                                }
                            }
                        } else {
                            clear_aim(&app2, &id);
                        }
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                    (raw_x, raw_y)
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
        let pulled = dx * dx + dy * dy >= pull_sq;
        let app2 = app.clone();
        let id = guest_id.clone();
        let parent = parent.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(mut active) = following().lock() {
                active.remove(&id);
            }
            let db = app2.state::<AppState>().db.clone();
            if !pulled {
                clear_aim(&app2, &id);
                let _ = db.set_stack_host(&id, Some(&parent));
                close_pinned(&app2, &id);
                let root = db.stack_root_id(&parent).unwrap_or(parent);
                if app2.get_webview_window(&pin_label(&root)).is_some() {
                    resize_stack_window(&app2, &root);
                    let _ = app2.emit("stack-changed", 0_i32);
                }
                return;
            }
            let label = pin_label(&id);
            if let Some(aim) = stack_aims().lock().ok().and_then(|mut aims| aims.remove(&id)) {
                show_aim(&app2, &aim.host, "off");
                if aim.ready {
                    if let Some(window) = app2.get_webview_window(&label) {
                        if attach_if_covering(&app2, &id, &window, Some(&aim.host)) {
                            return;
                        }
                    }
                }
            }
            settle_window(&app2, &label, Some(&id), false);
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
    let host_note = db.get(id).ok().flatten();
    let parent = host_note.as_ref().and_then(|note| note.stack_host.clone());
    let child = db.guest_of(id).ok().flatten();
    if let Some(child) = &child {
        let _ = db.set_stack_host(&child.id, parent.as_deref());
    }
    if let Some(parent) = parent {
        let _ = db.set_stack_host(id, None);
        let root = db.stack_root_id(&parent).unwrap_or(parent);
        if app.get_webview_window(&pin_label(&root)).is_some() {
            resize_stack_window(app, &root);
            let _ = app.emit("stack-changed", 0_i32);
        }
    } else if let Some(child) = child {
        if let Some(host) = &host_note {
            keep_stack_look(&db, &child.id, host.opacity, host.theme.as_deref());
        }
        let child_collapsed = child.collapsed;
        let tail_len = db.chain_after(&child.id).map(|chain| chain.len()).unwrap_or(0);
        let frame = app
            .get_webview_window(&pin_label(id))
            .and_then(|win| {
                let pos = win.outer_position().ok()?;
                let size = win.outer_size().ok()?;
                let scale = win.scale_factor().unwrap_or(1.0);
                let h = if tail_len == 0 && !child_collapsed {
                    (CARD_HEIGHT * scale).round() as i32
                } else {
                    size.height as i32
                };
                Some((pos.x, pos.y, size.width as i32, h))
            })
            .or_else(|| {
                let note = host_note?;
                let h = if tail_len == 0 && !child_collapsed {
                    CARD_HEIGHT as i32
                } else {
                    note.win_h?
                };
                Some((note.win_x?, note.win_y?, note.win_w?, h))
            });
        if let Some(frame) = frame {
            if let Ok(mut pending) = place_at().lock() {
                pending.insert(child.id.clone(), frame);
            }
        }
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
    if width >= area_w || height >= area_h {
        return None;
    }
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
    if size.width as i32 >= area.size.width as i32 || size.height as i32 >= area.size.height as i32 {
        return;
    }
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

fn hover_cursors() -> &'static Mutex<HashMap<String, (i32, i32)>> {
    static CURSORS: LazyLock<Mutex<HashMap<String, (i32, i32)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &CURSORS
}

fn clear_hover_cursors(app: &AppHandle) {
    let Ok(mut cursors) = hover_cursors().lock() else {
        return;
    };
    for (label, _) in cursors.drain() {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.emit_to(&label, "window-cursor", Option::<(i32, i32)>::None);
        }
    }
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
        clear_hover_cursors(app);
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
    let mut cursor_hits: HashMap<String, Option<(i32, i32)>> = HashMap::new();
    for (label, window) in app.webview_windows() {
        if label == SETTINGS || label == PREVIEW || !window.is_visible().unwrap_or(false) {
            cursor_hits.insert(label, None);
            continue;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            continue;
        };
        let over_window = cx >= position.x
            && cy >= position.y
            && cx < position.x.saturating_add(size.width as i32)
            && cy < position.y.saturating_add(size.height as i32);
        let local = if over_window {
            let scale = window.scale_factor().unwrap_or(1.0).max(0.01);
            Some((
                ((cursor.x - f64::from(position.x)) / scale).round() as i32,
                ((cursor.y - f64::from(position.y)) / scale).round() as i32,
            ))
        } else {
            None
        };
        cursor_hits.insert(label.clone(), local);
        hits.push((label, over_window, window.is_focused().unwrap_or(false)));
    }
    if let Ok(mut cursors) = hover_cursors().lock() {
        cursors.retain(|label, _| {
            if cursor_hits.contains_key(label) {
                true
            } else {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.emit_to(label, "window-cursor", Option::<(i32, i32)>::None);
                }
                false
            }
        });
        for (label, next_pos) in cursor_hits {
            match next_pos {
                Some(pos) => {
                    if cursors.insert(label.clone(), pos) != Some(pos) {
                        if let Some(window) = app.get_webview_window(&label) {
                            let _ = window.emit_to(&label, "window-cursor", Some(pos));
                        }
                    }
                }
                None => {
                    if cursors.remove(&label).is_some() {
                        if let Some(window) = app.get_webview_window(&label) {
                            let _ = window.emit_to(&label, "window-cursor", Option::<(i32, i32)>::None);
                        }
                    }
                }
            }
        }
    }
    let Ok(mut over) = hover_over().lock() else {
        return;
    };
    let parked_labels: HashSet<String> = parks()
        .lock()
        .ok()
        .map(|parked| {
            parked
                .iter()
                .filter(|(_, park)| park.quiet_until <= Instant::now())
                .map(|(label, _)| label.clone())
                .collect()
        })
        .unwrap_or_default();
    let mut next = HashSet::new();
    for (label, is_over, focused) in hits {
        let was_over = over.contains(&label) || (!is_over && !focused && parked_labels.contains(&label));
        match offscreen_hover_step(was_over, is_over, focused) {
            HoverStep::Reveal => slide_into_view(app, &label),
            HoverStep::Restore => slide_back(app, &label),
            HoverStep::Idle => {}
        }
        if is_over {
            next.insert(label);
        }
    }
    *over = next;
}

pub fn watch_offscreen_hover(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(40));
            if gesture_blocks_hover() || left_button_down() {
                continue;
            }
            let state = app.state::<AppState>();
            let any_hover = hover_over()
                .lock()
                .ok()
                .is_some_and(|over| !over.is_empty());
            let any_cursor = hover_cursors()
                .lock()
                .ok()
                .is_some_and(|cursors| !cursors.is_empty());
            let has_pins = app
                .webview_windows()
                .keys()
                .any(|label| label.starts_with("pin-"));
            if !state.pinned_mode.load(Ordering::SeqCst)
                && !state.shown.load(Ordering::SeqCst)
                && !has_pins
                && !any_hover
                && !any_cursor
            {
                continue;
            }
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
        assert_eq!(slide_card_into_view(-140, 0, 300, 800, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-140, -50, 300, 900, 0, 0, 1000, 800), None);
        assert_eq!(slide_card_into_view(-140, 40, 1000, 200, 0, 0, 1000, 800), None);
    }

    #[test]
    fn the_bottom_right_corner_changes_the_window_size() {
        assert_eq!(
            resize_frame(0, 0, 400, 500, 30, -20, 220, 140, ResizeEdge::SouthEast),
            (0, 0, 430, 480)
        );
        assert_eq!(
            resize_frame(0, 0, 400, 500, -300, -400, 220, 140, ResizeEdge::SouthEast),
            (0, 0, 220, 140)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, -40, 30, 220, 140, ResizeEdge::SouthWest),
            (60, 50, 440, 530)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 300, 30, 220, 140, ResizeEdge::West),
            (280, 50, 220, 500)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 50, 40, 220, 140, ResizeEdge::East),
            (100, 50, 450, 500)
        );
        assert_eq!(
            resize_frame(100, 50, 400, 500, 50, 40, 220, 140, ResizeEdge::South),
            (100, 50, 400, 540)
        );
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
        // Deep overlap on both axes is ignored so memos can be dropped onto each other to stack.
        let (x, y) = snap_memo_edges(100, 8, 100, 80, 0, 0, &neighbors, 22);
        assert_eq!((x, y), (100, 8));
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
    fn stacked_pins_step_apart() {
        assert_eq!(nudge_origin(10, 20, &[], 36), (10, 20));
        assert_eq!(nudge_origin(10, 20, &[(10, 20)], 36), (46, 56));
        assert_eq!(nudge_origin(10, 20, &[(10, 20), (46, 56)], 36), (82, 92));
        assert_eq!(nudge_origin(80, 20, &[(10, 20)], 36), (80, 20));
    }

    #[test]
    fn snapping_between_left_screen_edge_and_right_neighbor_prioritizes_right() {
        let layout = organize_grid(0, 0, 1400, 900, 408, 476, 24, 24, 32, 4);
        let first_x = layout.origin_x;
        let second = visual_card(
            layout.origin_x + layout.step_x,
            layout.origin_y,
            408,
            476,
            24,
            24,
            32,
        );
        let (screen_x, _) =
            snap_screen_edges(first_x, layout.origin_y, 360, 420, 24, 24, 0, 0, 1400, 900, 36);
        let (memo_x, _) =
            snap_memo_edges(first_x, layout.origin_y, 360, 420, 24, 24, &[second], 36);
        let chosen_x = super::closer_snap_x(first_x, screen_x, memo_x);
        assert_eq!(chosen_x, memo_x);
        assert!(chosen_x > first_x);
    }
}
