use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::state::AppState;
use crate::window_ctl;

pub fn attach(app: &tauri::App) -> tauri::Result<()> {
    let launch_at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let show = MenuItem::with_id(app, "show", "Show note", true, None::<&str>)?;
    let organize = MenuItem::with_id(app, "organize", "Auto organize", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Launch at login",
        true,
        launch_at_login,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show, &organize, &settings, &autostart, &separator, &quit],
    )?;

    let mut icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                window_ctl::show_from_tray(app, None);
            }
            "organize" => window_ctl::organize_pinned(app),
            "settings" => window_ctl::show_settings(app),
            "autostart" => {
                if let Err(err) = set_launch_at_login(app, None) {
                    eprintln!("memose: launch at login failed: {err}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                window_ctl::show_from_tray(
                    tray.app_handle(),
                    Some(window_ctl::TrayAnchor::from_rect(rect)),
                );
            }
        });
    if let Some(icon) = icon.take() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    if let Some(item) = app.try_state::<AppState>() {
        *item
            .autostart_item
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(autostart);
    }
    Ok(())
}

pub fn set_launch_at_login(app: &AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    let next = match enabled {
        Some(enabled) => enabled,
        None => !app.autolaunch().is_enabled().unwrap_or(false),
    };
    if next {
        app.autolaunch().enable().map_err(|err| err.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|err| err.to_string())?;
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(item) = state
            .autostart_item
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = item.set_checked(next);
        }
    }
    Ok(next)
}
