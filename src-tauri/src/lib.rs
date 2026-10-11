mod auth;
mod commands;
mod error;
mod media;
mod notes;
mod state;
mod tray;
mod window_ctl;

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window_ctl::show_composer(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    match shortcut.key {
                        Code::KeyN => window_ctl::show_fresh_memo(app),
                        Code::KeyP => window_ctl::toggle_pinned(app),
                        _ => {}
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            let _ = app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_data_dir()?;
            let media_dir = dir.join("media");
            std::fs::create_dir_all(&media_dir)?;
            let db = notes::Db::open(dir.join("memose.db"))?;
            auth::import_legacy_token(&db)?;
            app.manage(state::AppState::new(db, media_dir)?);
            window_ctl::attach(app.handle());
            tray::attach(app)?;
            register_shortcut(app.handle());
            notes::start_worker(app.handle().clone());
            notes::request_sync(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::upsert_draft,
            commands::load_draft,
            commands::finalize_composer,
            commands::commit_note,
            commands::save_edit,
            commands::save_media,
            commands::media_path,
            commands::current_media_preview,
            commands::open_media_preview,
            commands::close_media_preview,
            commands::list_recent,
            commands::get_settings,
            commands::save_settings,
            commands::clear_memos,
            commands::test_memos,
            commands::get_theme,
            commands::set_theme,
            commands::save_look,
            commands::publish_note,
            commands::get_note,
            commands::resolve_conflict,
            commands::set_pinned,
            commands::hide_memos,
            commands::hide_composer,
            commands::set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running memose");
}

fn register_shortcut(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER | Modifiers::ALT;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL | Modifiers::ALT;
    for code in [Code::KeyN, Code::KeyP] {
        let shortcut = Shortcut::new(Some(modifiers), code);
        if let Err(err) = app.global_shortcut().register(shortcut) {
            eprintln!("memose: global shortcut unavailable ({err}); use the tray icon");
        }
    }
}
