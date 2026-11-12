use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::notes::PinTabs;
use crate::state::AppState;
use crate::window_ctl;

#[derive(Debug, PartialEq, Eq)]
enum TrayEntry {
    Action { id: String, label: String },
    Separator,
}

fn tray_entries(
    pinned_mode: bool,
    tab_bar_enabled: bool,
    tabs: Option<&PinTabs>,
) -> Vec<TrayEntry> {
    let mut entries = vec![TrayEntry::Action {
        id: "organize".into(),
        label: "Auto organize".into(),
    }];
    if pinned_mode && !tab_bar_enabled {
        entries.push(TrayEntry::Separator);
        if let Some(tabs) = tabs {
            for (index, tab) in tabs.tabs.iter().enumerate() {
                let name = tab.name.trim();
                entries.push(TrayEntry::Action {
                    id: format!("pin-tab:{}", tab.id),
                    label: if name.is_empty() {
                        format!("Tab #{}", index + 1)
                    } else {
                        name.to_string()
                    },
                });
            }
        }
        entries.push(TrayEntry::Action {
            id: "create-pin-tab".into(),
            label: "Create new tab".into(),
        });
        entries.push(TrayEntry::Separator);
    }
    entries.extend([
        TrayEntry::Action {
            id: "settings".into(),
            label: "Settings".into(),
        },
        TrayEntry::Separator,
        TrayEntry::Action {
            id: "quit".into(),
            label: "Quit".into(),
        },
    ]);
    entries
}

fn current_entries(app: &AppHandle) -> Vec<TrayEntry> {
    let state = app.state::<AppState>();
    let pinned_mode = state.pinned_mode.load(Ordering::SeqCst);
    let tab_bar_enabled = window_ctl::pin_tab_bar_enabled(app);
    let tabs = (pinned_mode && !tab_bar_enabled)
        .then(|| state.db.pin_tabs().ok())
        .flatten();
    tray_entries(pinned_mode, tab_bar_enabled, tabs.as_ref())
}

fn populate_menu(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    while !menu.items()?.is_empty() {
        menu.remove_at(0)?;
    }
    for entry in current_entries(app) {
        match entry {
            TrayEntry::Action { id, label } => {
                let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
                menu.append(&item)?;
            }
            TrayEntry::Separator => {
                let item = PredefinedMenuItem::separator(app)?;
                menu.append(&item)?;
            }
        }
    }
    Ok(())
}

pub fn attach(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    populate_menu(app.handle(), &menu)?;
    let mut icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if let Some(tab_id) = id.strip_prefix("pin-tab:") {
                let state = app.state::<AppState>();
                if let Err(err) = state.db.select_pin_tab(tab_id) {
                    eprintln!("memose: select tray tab failed: {err}");
                    return;
                }
                window_ctl::apply_pin_tab(app);
                let _ = app.emit("pin-tabs-changed", ());
                refresh(app);
                return;
            }
            match id {
                "create-pin-tab" => {
                    let state = app.state::<AppState>();
                    if let Err(err) = state.db.add_pin_tab() {
                        eprintln!("memose: create tray tab failed: {err}");
                        return;
                    }
                    window_ctl::apply_pin_tab(app);
                    let _ = app.emit("pin-tabs-changed", ());
                    refresh(app);
                }
                "organize" => window_ctl::organize_pinned(app),
                "settings" => window_ctl::show_settings(app),
                "quit" => app.exit(0),
                _ => {}
            }
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
    if let Some(state) = app.try_state::<AppState>() {
        *state
            .tray_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(menu);
    }
    Ok(())
}

pub fn refresh(app: &AppHandle) {
    let menu = app.try_state::<AppState>().and_then(|state| {
        state
            .tray_menu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    });
    if let Some(menu) = menu {
        if let Err(err) = populate_menu(app, &menu) {
            eprintln!("memose: tray menu refresh failed: {err}");
        }
    }
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
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs() -> PinTabs {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "activeId": "second",
            "tabs": [
                { "id": "first", "name": "", "hue": 48 },
                { "id": "second", "name": "Work", "hue": 210 }
            ]
        }))
        .unwrap()
    }

    fn action_ids(entries: &[TrayEntry]) -> Vec<&str> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                TrayEntry::Action { id, .. } => Some(id.as_str()),
                TrayEntry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn tray_keeps_settings_before_quit() {
        assert_eq!(
            action_ids(&tray_entries(false, true, None)),
            ["organize", "settings", "quit"]
        );
    }

    #[test]
    fn hidden_bar_in_pinned_mode_adds_tabs_and_create() {
        let entries = tray_entries(true, false, Some(&tabs()));
        assert_eq!(
            action_ids(&entries),
            [
                "organize",
                "pin-tab:first",
                "pin-tab:second",
                "create-pin-tab",
                "settings",
                "quit"
            ]
        );
        assert!(matches!(
            &entries[2],
            TrayEntry::Action { label, .. } if label == "Tab #1"
        ));
        assert!(matches!(entries[1], TrayEntry::Separator));
        assert!(matches!(entries[5], TrayEntry::Separator));
    }
}
