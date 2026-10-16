mod auth;
mod commands;
mod error;
mod media;
mod mouse_hook;
mod notes;
mod shortcuts;
mod state;
mod tray;
mod window_ctl;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

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
                    let Some(state) = app.try_state::<state::AppState>() else {
                        return;
                    };
                    let binds = state
                        .shortcuts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    drop(state);
                    if shortcuts::same(shortcut, &binds.new_memo) {
                        window_ctl::show_fresh_memo(app);
                    } else if shortcuts::same(shortcut, &binds.toggle_pinned) {
                        window_ctl::toggle_pinned(app);
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
            let binds = shortcuts::load(&app.state::<state::AppState>().db);
            *app.state::<state::AppState>()
                .shortcuts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = binds.clone();
            if let Err(err) = shortcuts::install(app.handle(), &binds) {
                eprintln!("memose: shortcuts unavailable ({err})");
            }
            mouse_hook::start(app.handle().clone());
            window_ctl::watch_offscreen_hover(app.handle().clone());
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
            commands::save_media_file,
            commands::paste_clipboard_media,
            commands::reveal_media,
            commands::open_media_file,
            commands::media_path,
            commands::current_media_preview,
            commands::open_media_preview,
            commands::close_media_preview,
            commands::list_recent,
            commands::get_settings,
            commands::save_settings,
            commands::list_memo_spaces,
            commands::set_note_audience,
            commands::delete_note,
            commands::get_shortcuts,
            commands::mouse_chord,
            commands::save_shortcut,
            commands::clear_memos,
            commands::test_memos,
            commands::get_theme,
            commands::set_theme,
            commands::save_look,
            commands::set_pinned_opacity,
            commands::publish_note,
            commands::get_note,
            commands::resolve_conflict,
            commands::set_pinned,
            commands::hide_memos,
            commands::hide_composer,
            commands::set_autostart,
            commands::set_snap_memos,
            commands::set_collapsed,
            commands::stack_chain,
            commands::set_window_height,
            commands::begin_memo_drag,
            commands::end_memo_drag,
            commands::slide_into_view,
            commands::slide_back,
            commands::begin_corner_resize,
            commands::detach_stack
        ])
        .run(tauri::generate_context!())
        .expect("error while running memose");
}
