//! IPC for model prompts: settings, the memo chats, and running prompts.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{flag, save_flag, save_server};
use crate::error::AppError;
use crate::llm;
use crate::notes;
use crate::openai;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettingsView {
    llm_enabled: bool,
    llm_base_url: String,
    has_llm_key: bool,
    llm_model: String,
    /// Host of the model server, shown before text is sent to it.
    llm_host: String,
    /// The model server runs on this computer.
    llm_local: bool,
    /// Host already allowed to receive offline-only memos.
    private_ok_host: String,
    presets: Vec<llm::Preset>,
    /// What "Restore defaults" puts back.
    default_presets: Vec<llm::Preset>,
}

#[tauri::command]
pub fn get_ai_settings(state: State<AppState>) -> Result<AiSettingsView, AppError> {
    let base = state.db.get_meta(llm::LLM_BASE_URL)?.unwrap_or_default();
    Ok(AiSettingsView {
        llm_enabled: flag(&state, llm::LLM_ENABLED, false)?,
        has_llm_key: state
            .db
            .get_meta(llm::LLM_API_KEY)?
            .is_some_and(|key| !key.is_empty()),
        llm_model: state.db.get_meta(llm::LLM_MODEL)?.unwrap_or_default(),
        llm_host: openai::host_of(&base),
        llm_local: openai::is_local(&base),
        private_ok_host: state
            .db
            .get_meta(llm::LLM_PRIVATE_OK_HOST)?
            .unwrap_or_default(),
        presets: llm::presets(&state.db)?,
        default_presets: llm::default_presets(),
        llm_base_url: base,
    })
}

/// Saves the given fields and leaves the rest. An empty key removes the saved key.
/// Turning prompts off drops every chat and stops the prompts still running.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_ai_settings(
    app: AppHandle,
    state: State<AppState>,
    llm_enabled: Option<bool>,
    llm_base_url: Option<String>,
    llm_key: Option<String>,
    llm_model: Option<String>,
    presets: Option<Vec<llm::Preset>>,
    private_ok_host: Option<String>,
) -> Result<(), AppError> {
    save_server(
        &state,
        (llm::LLM_BASE_URL, llm::LLM_API_KEY),
        llm_base_url,
        llm_key,
    )?;
    save_flag(&state, llm::LLM_ENABLED, llm_enabled)?;
    if llm_enabled == Some(false) {
        state.chats.forget_all();
    }
    if let Some(model) = llm_model {
        state.db.set_meta(llm::LLM_MODEL, model.trim())?;
    }
    if let Some(presets) = presets {
        llm::store_presets(&state.db, &presets)?;
    }
    if let Some(host) = private_ok_host {
        state.db.set_meta(llm::LLM_PRIVATE_OK_HOST, host.trim())?;
    }
    let _ = app.emit("ai-settings-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn llm_models(state: State<'_, AppState>) -> Result<llm::ModelList, AppError> {
    let (base, key) = llm::base_and_key(&state.db)?;
    llm::list_models(&state.http, &base, key.as_deref()).await
}

/// Sends one prompt about a memo and records it in that memo's chat.
/// The result is an answer or a proposed edit. `llm_cancel` with the same id stops it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn llm_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    note_id: String,
    title: String,
    instruction: String,
    mode: llm::Mode,
    text: String,
    context: Option<String>,
    line_start: Option<u32>,
    line_end: Option<u32>,
) -> Result<llm::ChatEntry, AppError> {
    if instruction.trim().is_empty() {
        return Err(AppError::Message("write an instruction first".into()));
    }
    // An empty memo is fine: the prompt then asks for new text. An empty selection is not.
    if context.is_some() && text.trim().is_empty() {
        return Err(AppError::Message(
            "the selected lines have no text to send".into(),
        ));
    }
    let server = llm::Server::for_note(&state.db, Some(&note_id))?;
    let history = llm::history(&state.chats.log(&note_id));
    let mut running = state.chats.start(llm::ChatEntry {
        id: request_id.clone(),
        note_id: note_id.clone(),
        title: title.trim().chars().take(80).collect(),
        instruction: instruction.trim().to_string(),
        mode,
        status: llm::RUNNING.into(),
        text: String::new(),
        source: text.clone(),
        line_start,
        line_end,
        selection: context.is_some(),
        started_at: notes::now_ms(),
        finished_at: None,
        accepted: Vec::new(),
    })?;
    let _ = app.emit("llm-changed", &note_id);
    let result = tokio::select! {
        reply = llm::ask(&state.http, &server, mode, &instruction, &text, context.as_deref(), &history) => reply.map(Some),
        _ = &mut running.cancelled => Ok(None),
    };
    drop(running);
    let (status, body) = match result {
        Ok(Some(reply)) => match reply.kind {
            llm::ReplyKind::Answer => ("answer", reply.text),
            llm::ReplyKind::Edit => ("edit", reply.text),
        },
        Ok(None) => ("cancelled", String::new()),
        Err(err) => ("error", err.to_string()),
    };
    let finished = state.chats.finish(&note_id, &request_id, status, body);
    let _ = app.emit("llm-changed", &note_id);
    finished.ok_or_else(|| AppError::Message("the prompt was cleared".into()))
}

#[tauri::command]
pub fn llm_cancel(state: State<AppState>, request_id: String) {
    state.chats.cancel(&request_id);
}

/// Prompts and results of one memo, oldest first.
#[tauri::command]
pub fn llm_chat(state: State<AppState>, note_id: String) -> Vec<llm::ChatEntry> {
    state.chats.log(&note_id)
}

/// Prompts still running, across all memos. Memo text is left out.
#[tauri::command]
pub fn llm_jobs(state: State<AppState>) -> Vec<llm::ChatEntry> {
    state.chats.jobs()
}

/// Records what happened to a proposed edit: `applied` or `dismissed`, and which changes were taken.
#[tauri::command]
pub fn llm_mark(
    app: AppHandle,
    state: State<AppState>,
    note_id: String,
    request_id: String,
    status: String,
    accepted: Option<Vec<u32>>,
) -> Result<(), AppError> {
    if status != "applied" && status != "dismissed" {
        return Err(AppError::Message("unknown prompt state".into()));
    }
    state
        .chats
        .mark(&note_id, &request_id, status, accepted.unwrap_or_default());
    let _ = app.emit("llm-changed", &note_id);
    Ok(())
}

/// Drops the finished prompts of one memo. Running ones stay.
#[tauri::command]
pub fn llm_clear_chat(app: AppHandle, state: State<AppState>, note_id: String) {
    state.chats.clear(&note_id);
    let _ = app.emit("llm-changed", &note_id);
}
