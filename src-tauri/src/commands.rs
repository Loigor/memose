use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;
use crate::notes::{self, request_sync, Note, SpaceView};
use crate::shortcuts::{self, ShortcutBinds};
use crate::state::AppState;
use crate::tray;
use crate::window_ctl;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    base_url: String,
    has_token: bool,
    launch_at_login: bool,
    visibility: String,
    space: String,
    snap_memos: bool,
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
pub fn commit_note(
    app: AppHandle,
    state: State<'_, AppState>,
    content: String,
) -> Result<(), AppError> {
    if state.db.finalize_content(&content)? {
        request_sync(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn save_media(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    filename: Option<String>,
    mime: Option<String>,
) -> Result<String, AppError> {
    crate::media::save_named(
        &state.media_dir,
        &bytes,
        filename.as_deref(),
        mime.as_deref(),
    )
}

#[tauri::command]
pub fn save_media_file(state: State<'_, AppState>, path: String) -> Result<String, AppError> {
    crate::media::save_file_path(&state.media_dir, std::path::Path::new(&path))
}

#[tauri::command]
pub fn paste_clipboard_media(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    crate::media::paste_clipboard(&state.media_dir)
}

#[tauri::command]
pub fn reveal_media(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    crate::media::reveal_in_folder(&state.media_dir, &name)
}

#[tauri::command]
pub fn open_media_file(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    crate::media::open_file(&state.media_dir, &name)
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
        visibility: notes::canonical_visibility(
            &state
                .db
                .get_meta(notes::MEMO_VISIBILITY)?
                .unwrap_or_else(|| "PRIVATE".into()),
        ),
        space: state.db.get_meta(notes::MEMO_SPACE)?.unwrap_or_default(),
        snap_memos: state.db.get_meta(notes::SNAP_MEMOS)?.as_deref() == Some("1"),
    })
}

#[tauri::command]
pub fn set_snap_memos(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state
        .db
        .set_meta(notes::SNAP_MEMOS, if enabled { "1" } else { "0" })?;
    let _ = app.emit("snap-changed", enabled);
    Ok(())
}

#[tauri::command]
pub fn set_collapsed(state: State<AppState>, id: String, collapsed: bool) -> Result<(), AppError> {
    state.db.set_collapsed(&id, collapsed)
}

#[tauri::command]
pub fn stack_chain(state: State<AppState>, host_id: String) -> Result<Vec<Note>, AppError> {
    state.db.chain_after(&host_id)
}

#[tauri::command]
pub fn set_window_height(app: AppHandle, label: String, height: i32) {
    window_ctl::set_window_height(&app, &label, height);
}

#[tauri::command]
pub fn begin_memo_drag(app: AppHandle, label: String) {
    window_ctl::begin_memo_drag(app, label);
}

#[tauri::command]
pub fn end_memo_drag(app: AppHandle, label: String) {
    window_ctl::end_memo_drag(&app, &label);
}

#[tauri::command]
pub fn slide_into_view(app: AppHandle, label: String) {
    window_ctl::slide_into_view(&app, &label);
}

#[tauri::command]
pub fn slide_back(app: AppHandle, label: String) {
    window_ctl::slide_back(&app, &label);
}

#[tauri::command]
pub async fn begin_corner_resize(app: AppHandle, label: String, edge: Option<String>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let resize_edge = match edge.as_deref() {
        Some("w") => window_ctl::ResizeEdge::West,
        Some("e") => window_ctl::ResizeEdge::East,
        Some("s") => window_ctl::ResizeEdge::South,
        Some("sw") => window_ctl::ResizeEdge::SouthWest,
        _ => window_ctl::ResizeEdge::SouthEast,
    };
    window_ctl::begin_corner_resize(app, label, resize_edge, tx);
    let _ = tauri::async_runtime::spawn_blocking(move || rx.recv()).await;
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn detach_stack(
    app: AppHandle,
    guest_id: String,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    theme: Option<String>,
    grab_x: Option<i32>,
    grab_y: Option<i32>,
    pull: Option<i32>,
) -> Result<(), AppError> {
    let at = match (x, y, w, h) {
        (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
        _ => None,
    };
    let follow = match (grab_x, grab_y, pull) {
        (Some(grab_x), Some(grab_y), Some(pull)) => Some((grab_x, grab_y, pull)),
        _ => None,
    };
    window_ctl::detach_guest(&app, &guest_id, at, theme.as_deref(), follow);
    Ok(())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<AppState>,
    base_url: Option<String>,
    token: Option<String>,
    visibility: Option<String>,
    space: Option<String>,
) -> Result<(), AppError> {
    if let Some(base_url) = base_url {
        state.db.set_base_url(&base_url)?;
    }
    match token.as_deref().map(str::trim) {
        Some("") => state.db.clear_access_token()?,
        Some(value) => state.db.set_access_token(value)?,
        None => {}
    }
    if let Some(visibility) = visibility {
        let visibility = notes::canonical_visibility(&visibility);
        let space = space.unwrap_or_default();
        if visibility == "SPACE" && space.trim().is_empty() {
            return Err(AppError::Message(
                "space members visibility needs a space".into(),
            ));
        }
        state.db.set_meta(notes::MEMO_VISIBILITY, &visibility)?;
        state.db.set_meta(notes::MEMO_SPACE, space.trim())?;
    }
    let _ = app.emit("settings-changed", ());
    request_sync(&app);
    Ok(())
}

#[tauri::command]
pub async fn list_memo_spaces(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SpaceView>, AppError> {
    if let Some((base, token, flavor)) = memos_context(&state)? {
        match notes::list_spaces(&state.http, &base, flavor, &token).await {
            Ok(remote) => {
                if state.db.store_space_catalog(&remote)? {
                    let _ = app.emit("spaces-changed", ());
                }
            }
            Err(err) => eprintln!("memose: space list failed: {err}"),
        }
    }
    state.db.list_known_spaces()
}

#[tauri::command]
pub async fn create_memo_space(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
    name: Option<String>,
) -> Result<SpaceView, AppError> {
    let (base, token, flavor) = memos_context(&state)?
        .ok_or_else(|| AppError::Message("connect useMemos to create a space".into()))?;
    let space_id = name
        .as_deref()
        .and_then(notes::space_uid)
        .map(str::to_string);
    let created = notes::create_space(
        &state.http,
        &base,
        flavor,
        &token,
        &title,
        space_id.as_deref(),
    )
    .await?;
    state.db.remember_space(&created.name, &created.title)?;
    let _ = app.emit("spaces-changed", ());
    request_sync(&app);
    state
        .db
        .list_known_spaces()?
        .into_iter()
        .find(|space| space.name == created.name)
        .ok_or_else(|| AppError::Message("space disappeared".into()))
}

#[tauri::command]
pub fn forget_memo_space(
    app: AppHandle,
    state: State<AppState>,
    name: String,
) -> Result<(), AppError> {
    let queued = state.db.forget_space(&name)?;
    if queued {
        request_sync(&app);
    }
    let _ = app.emit("spaces-changed", ());
    let _ = app.emit("settings-changed", ());
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
pub fn set_space_hue(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    hue: Option<u16>,
) -> Result<(), AppError> {
    state.db.set_space_hue(&name, hue)?;
    let _ = app.emit("spaces-changed", ());
    Ok(())
}

fn memos_context(
    state: &State<'_, AppState>,
) -> Result<Option<(String, String, notes::ApiFlavor)>, AppError> {
    let base = state.db.get_meta(notes::BASE_URL)?.unwrap_or_default();
    let Some(token) = state.db.access_token()? else {
        return Ok(None);
    };
    if base.is_empty() {
        return Ok(None);
    }
    let flavor = state
        .db
        .get_meta(notes::API_FLAVOR)?
        .as_deref()
        .and_then(notes::ApiFlavor::parse)
        .unwrap_or(notes::ApiFlavor::Latest);
    Ok(Some((base, token, flavor)))
}

#[tauri::command]
pub fn set_note_audience(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    visibility: String,
    space: String,
) -> Result<(), AppError> {
    if state.db.set_audience(&id, &visibility, &space)? {
        request_sync(&app);
    }
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn delete_note(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let note = state.db.get(&id)?;
    let Some(note) = note else {
        return Ok(());
    };
    if let Some(name) = note.remote_name.as_deref() {
        let base = state.db.get_meta(notes::BASE_URL)?.unwrap_or_default();
        if let Some(token) = state.db.access_token()? {
            if !base.is_empty() {
                let flavor = state
                    .db
                    .get_meta(notes::API_FLAVOR)?
                    .as_deref()
                    .and_then(notes::ApiFlavor::parse)
                    .unwrap_or(notes::ApiFlavor::Latest);
                notes::delete_remote_memo(&state.http, &base, flavor, &token, name).await?;
            }
        }
    }
    window_ctl::prepare_remove(&app, &id);
    state.db.delete_note(&id)?;
    window_ctl::close_pinned(&app, &id);
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
pub fn mouse_chord(app: AppHandle, button: u8, alt: bool, ctrl: bool, shift: bool, meta: bool) {
    shortcuts::dispatch_mouse(&app, button, alt, ctrl, shift, meta);
}

#[tauri::command]
pub fn get_shortcuts(state: State<AppState>) -> ShortcutBinds {
    state
        .shortcuts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
pub fn save_shortcut(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    binding: String,
) -> Result<ShortcutBinds, AppError> {
    let previous = state
        .shortcuts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let mut next = previous.clone();
    next.assign(&id, &binding)?;
    let next = shortcuts::normalize(&next)?;
    if let Err(err) = shortcuts::install(&app, &next) {
        let _ = shortcuts::install(&app, &previous);
        return Err(err);
    }
    let stored = serde_json::to_string(&next).map_err(|err| AppError::Message(err.to_string()))?;
    state.db.set_meta(shortcuts::KEY, &stored)?;
    *state
        .shortcuts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = next.clone();
    shortcuts::publish(&app, &next);
    Ok(next)
}

#[tauri::command]
pub fn clear_memos(app: AppHandle, state: State<AppState>) -> Result<(), AppError> {
    state.db.set_base_url("")?;
    state.db.clear_access_token()?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn test_memos(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppError> {
    let db = state.db.clone();
    let http = state.http.clone();
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
    let _ = app.emit("settings-changed", ());
    Ok(flavor.as_str().to_string())
}

#[tauri::command]
pub fn get_theme(state: State<AppState>) -> Result<String, AppError> {
    let theme = state
        .db
        .get_meta(notes::THEME)?
        .unwrap_or_else(|| "light".into());
    Ok(if theme == "dark" { "dark" } else { "light" }.into())
}

#[tauri::command]
pub fn save_look(
    state: State<AppState>,
    id: String,
    opacity: u8,
    hue_light: Option<u16>,
    hue_dark: Option<u16>,
    swatches: Vec<u16>,
    theme: Option<String>,
) -> Result<(), AppError> {
    state.db.save_look(
        &id,
        opacity,
        hue_light,
        hue_dark,
        &swatches,
        theme.as_deref(),
    )
}

#[tauri::command]
pub fn set_pinned_opacity(
    app: AppHandle,
    state: State<AppState>,
    opacity: u8,
    persist: Option<bool>,
) -> Result<(), AppError> {
    let opacity = opacity.min(100);
    let _ = app.emit("pinned-opacity", opacity);
    if persist.unwrap_or(true) {
        state.db.set_pinned_opacity(opacity)?;
    }
    Ok(())
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
pub async fn get_note(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    materialize: Option<bool>,
) -> Result<Note, AppError> {
    let db = state.db.clone();
    let note = db
        .get(&id)?
        .ok_or_else(|| AppError::Message("note not found".into()))?;
    if note.sync_state == notes::REMOTE && materialize.unwrap_or(true) {
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
        window_ctl::place_for_pin(&app, &id);
    } else {
        window_ctl::prepare_remove(&app, &id);
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
    let _ = app.emit("notes-changed", ());
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
