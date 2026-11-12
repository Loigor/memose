mod composer;
mod drag;
mod geom;
mod pin;

pub use composer::{
    apply_composer_size, attach, dismiss_composer, hide_composer, hide_memos, show_composer,
    show_fresh_memo, show_from_tray, submit_flush, TrayAnchor,
};
pub use drag::{
    begin_corner_resize, begin_memo_drag, detach_guest, end_memo_drag, prepare_remove,
    set_pin_tab_hits, set_window_height, slide_back, slide_into_view, sync_screen_edges,
    watch_offscreen_hover,
};
pub use pin::{close_pinned, open_pinned, organize_pinned, place_for_pin, toggle_pinned};

pub use geom::{
    clamp_position, resize_frame, slide_card_into_view, snap_memo_edges, snap_screen_edges,
    tray_card_origin, ResizeEdge,
};

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};

use crate::error::AppError;
use crate::media;
use crate::state::AppState;
use crate::tray;

pub(crate) use geom::{normalize_pin_edge, normalize_pin_screen};
use geom::{strip_edge_name, strip_frame};

const PREVIEW: &str = "media-preview";
const PREVIEW_GRACE: Duration = Duration::from_millis(300);

const WINDOW: &str = "main";
const SETTINGS: &str = "settings";
const PIN_TABS: &str = "pinned-tabs";
const STRIP_H: f64 = 12.0;

fn is_pin_strip(label: &str) -> bool {
    label == PIN_TABS || label.starts_with("pinned-tabs-")
}

fn pin_strip_label(index: usize) -> String {
    if index == 0 {
        PIN_TABS.to_string()
    } else {
        format!("pinned-tabs-{index}")
    }
}

fn strip_index(label: &str) -> Option<usize> {
    if label == PIN_TABS {
        return Some(0);
    }
    label.strip_prefix("pinned-tabs-")?.parse().ok()
}

fn strip_edges() -> &'static Mutex<HashMap<String, String>> {
    static EDGES: LazyLock<Mutex<HashMap<String, String>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &EDGES
}
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
    .inner_size(580.0, 640.0)
    .min_inner_size(480.0, 480.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(true)
    .center()
    .build()
    {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) => schedule_resign(&handle),
                WindowEvent::Destroyed => apply_switcher_policy(&handle),
                _ => {}
            });
            apply_app_icon(app, &window);
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("memose: settings window failed: {err}"),
    }
}

pub fn hide_pin_tabs(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if is_pin_strip(&label) {
            let _ = window.hide();
        }
    }
}

pub fn show_pin_tabs(app: &AppHandle) {
    if !pin_tab_bar_enabled(app) {
        hide_pin_tabs(app);
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show_pin_tabs_window(&handle));
        });
    }
    #[cfg(not(target_os = "windows"))]
    show_pin_tabs_window(app);
}

pub fn apply_pin_tab(app: &AppHandle) {
    if app.state::<AppState>().pinned_mode.load(Ordering::SeqCst) {
        pin::open_pinned_windows(app);
    }
}

fn raise_pin_tabs(app: &AppHandle) {
    if !app.state::<AppState>().pinned_mode.load(Ordering::SeqCst) {
        return;
    }
    for (label, window) in app.webview_windows() {
        if is_pin_strip(&label) {
            style_desktop_window(app, &window, true);
        }
    }
}

fn show_pin_tabs_window(app: &AppHandle) {
    let (screen, edge) = saved_pin_place(app);
    let monitors = monitors_for_strips(app, &screen);
    if monitors.is_empty() {
        return;
    }
    for (index, monitor) in monitors.iter().enumerate() {
        let label = pin_strip_label(index);
        let Some(window) = open_pin_strip(app, &label) else {
            continue;
        };
        let hidden = !window.is_visible().unwrap_or(false);
        place_strip(&window, monitor, edge, hidden);
        let _ = window.show();
        style_desktop_window(app, &window, true);
    }
    let keep = monitors.len();
    if let Ok(mut edges) = strip_edges().lock() {
        edges.retain(|label, _| strip_index(label).is_some_and(|index| index < keep));
    }
    let extras: Vec<WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| {
            is_pin_strip(label) && strip_index(label).is_some_and(|index| index >= keep)
        })
        .map(|(_, window)| window)
        .collect();
    for window in extras {
        let _ = window.close();
    }
}

fn open_pin_strip(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(label) {
        return Some(window);
    }
    let script =
        "if(document.documentElement){document.documentElement.classList.add('pin-tabs-window');}";
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("pin-tabs.html".into()),
    )
    .title("Memose")
    .inner_size(800.0, STRIP_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(pinned_always_on_top(app))
    .skip_taskbar(!show_in_switcher(app))
    .resizable(false)
    .shadow(false)
    .focused(false)
    .visible(false)
    .initialization_script(script);
    #[cfg(target_os = "windows")]
    let builder = builder
        .no_redirection_bitmap(true)
        .background_color(tauri::window::Color(0, 0, 0, 0));
    match builder.build() {
        Ok(window) => Some(window),
        Err(err) => {
            eprintln!("memose: could not open pinned tabs: {err}");
            None
        }
    }
}

fn saved_pin_place(app: &AppHandle) -> (String, geom::StripEdge) {
    let state = app.state::<AppState>();
    let screen = state
        .db
        .get_meta(crate::notes::PIN_TAB_SCREEN)
        .ok()
        .flatten()
        .unwrap_or_default();
    let edge = state
        .db
        .get_meta(crate::notes::PIN_TAB_EDGE)
        .ok()
        .flatten()
        .unwrap_or_default();
    (normalize_pin_screen(&screen), geom::strip_edge(&edge))
}

fn monitor_key_of(monitor: &tauri::Monitor) -> String {
    let name = monitor.name().map(String::as_str).unwrap_or("");
    let trimmed = name.trim();
    let position = monitor.position();
    let named = (!trimmed.is_empty()).then_some(trimmed);
    geom::monitor_key(named, position.x, position.y)
}

fn monitors_for_strips(app: &AppHandle, screen: &str) -> Vec<tauri::Monitor> {
    if screen == "all" {
        return app.available_monitors().unwrap_or_default();
    }
    if screen.starts_with("display:") {
        if let Some(found) = app
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .find(|monitor| monitor_key_of(monitor) == screen)
        {
            return vec![found];
        }
    }
    monitor_for_placement(app).into_iter().collect()
}

fn strip_thickness(window: &WebviewWindow, edge: geom::StripEdge, scale: f64, reset: bool) -> u32 {
    let collapsed = (STRIP_H * scale).round().max(1.0) as u32;
    if reset {
        return collapsed;
    }
    let Ok(size) = window.outer_size() else {
        return collapsed;
    };
    match edge {
        geom::StripEdge::Left | geom::StripEdge::Right => size.width.max(1),
        geom::StripEdge::Top | geom::StripEdge::Bottom => size.height.max(1),
    }
}

fn place_strip(
    window: &WebviewWindow,
    monitor: &tauri::Monitor,
    edge: geom::StripEdge,
    reset: bool,
) {
    let area = monitor.work_area();
    let scale = monitor.scale_factor().max(0.5);
    let name = strip_edge_name(edge);
    let previous = strip_edges()
        .lock()
        .ok()
        .and_then(|edges| edges.get(window.label()).cloned());
    let reset = reset || previous.as_deref() != Some(name);
    let thick = strip_thickness(window, edge, scale, reset);
    let (x, y, width, height) = strip_frame(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        thick,
        edge,
    );
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    if let Ok(mut edges) = strip_edges().lock() {
        edges.insert(window.label().to_string(), name.to_string());
    }
    let _ = window.emit_to(window.label(), "pin-strip-edge", name);
}

pub(crate) fn pin_strip_edge(label: &str) -> String {
    strip_edges()
        .lock()
        .ok()
        .and_then(|edges| edges.get(label).cloned())
        .unwrap_or_else(|| "top".into())
}

pub(crate) fn display_choices(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };
    monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let trimmed = monitor.name().map(String::as_str).unwrap_or("").trim();
            let label = if trimmed.is_empty() {
                format!("Display {}", index + 1)
            } else {
                trimmed.to_string()
            };
            (monitor_key_of(monitor), label)
        })
        .collect()
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
        composer::hide_composer(app);
        return;
    }
    pin::hide_pinned(app);
    let shown = app.state::<AppState>().shown.load(Ordering::SeqCst);
    let visible = app
        .get_webview_window(WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if shown || visible {
        composer::hide_and_save(app, true);
    } else {
        apply_switcher_policy(app);
    }
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
    let builder =
        tauri::WebviewWindowBuilder::new(app, PREVIEW, tauri::WebviewUrl::App("index.html".into()))
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

/// How close a memo edge must be to a screen edge before it catches.
const EDGE_CATCH: i32 = 36;

fn snap_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .db
        .get_meta(crate::notes::SNAP_MEMOS)
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

pub(crate) fn pin_tab_bar_enabled(app: &AppHandle) -> bool {
    let saved = app
        .state::<AppState>()
        .db
        .get_meta(crate::notes::PIN_TAB_BAR_ENABLED)
        .ok()
        .flatten();
    effective_pin_tab_bar_enabled(saved.as_deref())
}

fn effective_pin_tab_bar_enabled(saved: Option<&str>) -> bool {
    saved != Some("0")
}

pub(super) fn effective_show_in_switcher(requested: bool, always_on_top: bool) -> bool {
    requested || !always_on_top
}

pub(crate) fn pinned_always_on_top(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .db
        .get_meta(crate::notes::PINNED_ALWAYS_ON_TOP)
        .ok()
        .flatten()
        .as_deref()
        != Some("0")
}

pub(crate) fn show_in_switcher(app: &AppHandle) -> bool {
    let requested = app
        .state::<AppState>()
        .db
        .get_meta(crate::notes::SHOW_IN_SWITCHER)
        .ok()
        .flatten()
        .as_deref()
        == Some("1");
    effective_show_in_switcher(requested, pinned_always_on_top(app))
}

fn apply_app_icon(app: &AppHandle, window: &WebviewWindow) {
    if let Some(icon) = app.default_window_icon() {
        let _ = window.set_icon(icon.clone());
    }
}

pub(super) fn style_desktop_window(app: &AppHandle, window: &WebviewWindow, pin_like: bool) {
    let skip = !show_in_switcher(app);
    let _ = window.set_skip_taskbar(skip);
    if pin_like {
        let _ = window.set_always_on_top(pinned_always_on_top(app));
    }
    apply_app_icon(app, window);
}

pub fn apply_desktop_prefs(app: &AppHandle) {
    let switcher = show_in_switcher(app);
    for (label, window) in app.webview_windows() {
        // Composer stays off the switcher; alt-tab should land on pinned memos.
        if label == PREVIEW || label == SETTINGS || label == WINDOW {
            continue;
        }
        let pin_like = label.starts_with("pin-") || is_pin_strip(&label);
        style_desktop_window(app, &window, pin_like);
    }
    apply_switcher_policy(app);
    if switcher {
        let state = app.state::<AppState>();
        if !state.pinned_mode.swap(true, Ordering::SeqCst) {
            pin::open_pinned_windows(app);
        }
    }
    tray::refresh(app);
}

pub(super) fn apply_switcher_policy(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if show_in_switcher(app) {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            return;
        }
        let composer = app
            .get_webview_window(WINDOW)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        let settings = app
            .get_webview_window(SETTINGS)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        let policy = if composer || settings {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
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

type FrameRect = (i32, i32, i32, i32);
type PlaceMap = HashMap<String, FrameRect>;

fn place_at() -> &'static Mutex<PlaceMap> {
    static PLACE: LazyLock<Mutex<PlaceMap>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    &PLACE
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

#[cfg(test)]
mod desktop_prefs_tests {
    use super::{effective_pin_tab_bar_enabled, effective_show_in_switcher};

    #[test]
    fn switcher_turns_on_when_pins_are_not_always_on_top() {
        assert!(effective_show_in_switcher(false, false));
        assert!(!effective_show_in_switcher(false, true));
        assert!(effective_show_in_switcher(true, true));
        assert!(effective_show_in_switcher(true, false));
    }

    #[test]
    fn pin_tab_bar_defaults_on() {
        assert!(effective_pin_tab_bar_enabled(None));
        assert!(effective_pin_tab_bar_enabled(Some("1")));
        assert!(!effective_pin_tab_bar_enabled(Some("0")));
    }

    #[test]
    fn extra_strips_use_their_own_labels() {
        assert_eq!(super::pin_strip_label(0), "pinned-tabs");
        assert_eq!(super::pin_strip_label(2), "pinned-tabs-2");
        assert_eq!(super::strip_index("pinned-tabs"), Some(0));
        assert_eq!(super::strip_index("pinned-tabs-2"), Some(2));
        assert!(super::is_pin_strip("pinned-tabs"));
        assert!(super::is_pin_strip("pinned-tabs-2"));
        assert!(!super::is_pin_strip("pin-note"));
    }
}
