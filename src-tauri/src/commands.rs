use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;
use crate::notes::{self, request_sync, Note};
use crate::state::AppState;
use crate::tray;
use crate::window_ctl;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    base_url: String,
    has_token: bool,
    launch_at_login: bool,
}

#[tauri::command]
pub fn upsert_draft(state: State<AppState>, content: String) -> Result<Option<Note>, AppError> {
    state.db.upsert_draft(&content)
}

#[tauri::command]
pub fn load_draft(state: State<AppState>) -> Result<Option<Note>, AppError> {
    state.db.load_draft()
}

#[tauri::command]
pub fn finalize_composer(
    app: AppHandle,
    generation: u64,
    content: String,
    note_id: Option<String>,
) -> Result<(), AppError> {
    window_ctl::submit_flush(&app, generation, content, note_id);
    Ok(())
}

#[tauri::command]
pub fn commit_note(app: AppHandle, state: State<'_, AppState>, content: String) -> Result<(), AppError> {
    if state.db.finalize_content(&content)? {
        request_sync(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn save_media(state: State<'_, AppState>, bytes: Vec<u8>) -> Result<String, AppError> {
    crate::media::save(&state.media_dir, &bytes)
}

#[tauri::command]
pub fn media_path(state: State<'_, AppState>, name: String) -> Result<String, AppError> {
    crate::media::resolve(&state.media_dir, &name).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn current_media_preview(state: State<'_, AppState>) -> Option<String> {
    state
        .preview_name
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
pub fn open_media_preview(app: AppHandle, name: String) -> Result<(), AppError> {
    window_ctl::open_media_preview(&app, &name)
}

#[tauri::command]
pub fn close_media_preview(app: AppHandle) {
    window_ctl::close_media_preview(&app);
}

#[tauri::command]
pub fn save_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<(), AppError> {
    let (changed, sync) = state.db.save_edit(&id, &content)?;
    if sync {
        request_sync(&app);
    }
    if changed {
        let _ = app.emit("notes-changed", ());
    }
    Ok(())
}

#[tauri::command]
pub fn list_recent(state: State<AppState>, limit: Option<u32>) -> Result<Vec<Note>, AppError> {
    state.db.list_recent(limit.unwrap_or(8))
}

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<AppState>) -> Result<SettingsView, AppError> {
    Ok(SettingsView {
        base_url: state.db.get_meta(notes::BASE_URL)?.unwrap_or_default(),
        has_token: state.db.access_token()?.is_some(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
    })
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<AppState>,
    base_url: String,
    token: Option<String>,
) -> Result<(), AppError> {
    state.db.set_base_url(&base_url)?;
    match token.as_deref().map(str::trim) {
        Some("") => state.db.clear_access_token()?,
        Some(value) => state.db.set_access_token(value)?,
        None => {}
    }
    request_sync(&app);
    Ok(())
}

#[tauri::command]
pub fn clear_memos(state: State<AppState>) -> Result<(), AppError> {
    state.db.set_base_url("")?;
    state.db.clear_access_token()?;
    Ok(())
}

#[tauri::command]
pub async fn test_memos(state: State<'_, AppState>) -> Result<String, AppError> {
    let db = state.db.clone();
    let http = state.http.clone();
    drop(state);
    let base = db
        .get_meta(notes::BASE_URL)?
        .filter(|url| !url.is_empty())
        .ok_or_else(|| AppError::Message("server URL is not set".into()))?;
    let token = db
        .access_token()?
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Message("access token is not set".into()))?;
    let flavor = notes::probe(&http, &base, &token).await?;
    db.set_meta(notes::API_FLAVOR, flavor.as_str())?;
    Ok(flavor.as_str().to_string())
}

#[tauri::command]
pub fn get_theme(state: State<AppState>) -> Result<String, AppError> {
    let theme = state.db.get_meta(notes::THEME)?.unwrap_or_else(|| "light".into());
    Ok(if theme == "dark" { "dark" } else { "light" }.into())
}

#[tauri::command]
pub fn set_theme(state: State<AppState>, theme: String) -> Result<(), AppError> {
    let theme = if theme == "dark" { "dark" } else { "light" };
    state.db.set_meta(notes::THEME, theme)
}

#[tauri::command]
pub fn publish_note(
    state: State<'_, AppState>,
    id: Option<String>,
    content: String,
) -> Result<Note, AppError> {
    state.db.publish_note(id.as_deref(), &content)
}

#[tauri::command]
pub async fn get_note(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Note, AppError> {
    let db = state.db.clone();
    drop(state);
    let note = db
        .get(&id)?
        .ok_or_else(|| AppError::Message("note not found".into()))?;
    if note.sync_state == notes::REMOTE {
        notes::request_materialize(&app, id).await
    } else {
        Ok(note)
    }
}

#[tauri::command]
pub async fn resolve_conflict(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    choice: String,
) -> Result<Note, AppError> {
    let db = state.db.clone();
    drop(state);
    match choice.as_str() {
        "local" => notes::request_keep_local(&app, id).await,
        "remote" => {
            db.resolve_remote(&id)?;
            db.get(&id)?
                .ok_or_else(|| AppError::Message("note not found".into()))
        }
        _ => Err(AppError::Message("unknown conflict choice".into())),
    }
}

#[tauri::command]
pub fn set_pinned(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
    from_composer: bool,
) -> Result<(), AppError> {
    if pinned {
        window_ctl::place_in_free_space(&app, &id);
    }
    state.db.set_pinned(&id, pinned)?;
    if pinned {
        window_ctl::open_pinned(&app, &id);
        if !from_composer {
            window_ctl::dismiss_composer(&app);
        }
    } else {
        window_ctl::close_pinned(&app, &id);
    }
    Ok(())
}

#[tauri::command]
pub fn hide_memos(app: AppHandle) {
    window_ctl::hide_memos(&app);
}

#[tauri::command]
pub fn hide_composer(app: AppHandle) {
    window_ctl::hide_composer(&app);
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tray::set_launch_at_login(&app, Some(enabled))
}
