//! IPC for recording: settings, the speech models, the microphone, and dictation.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{flag, save_flag, save_server};
use crate::error::AppError;
use crate::llm;
use crate::openai;
use crate::speech;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechSettingsView {
    enabled: bool,
    /// `local`, `server`, or `off`.
    source: String,
    /// The speech server's own address. Empty uses the model server.
    base_url: String,
    /// Address in use for the `server` source, after the fallback.
    server_url: String,
    server_host: String,
    server_local: bool,
    has_key: bool,
    model: String,
    language: String,
    device: String,
    keep_audio: bool,
    /// How much the chat model improves dictated text while it arrives, 1 to 4.
    polish_level: u8,
    /// The chat model is set up, so `polish` can work.
    polish_ready: bool,
    engine: speech::engine::Status,
    /// Whether the system lets the app use the microphone.
    microphone: speech::permission::Permission,
    /// A recording that is running now, in any window.
    recording: Option<speech::StateEvent>,
}

#[tauri::command]
pub async fn get_speech_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SpeechSettingsView, AppError> {
    let base_url = state
        .db
        .get_meta(speech::SPEECH_BASE_URL)?
        .unwrap_or_default();
    let server_url = speech::server_base(&state.db)?;
    // The model folder is measured on disk, so not on the thread that runs the windows.
    let dir = speech::engine_dir(&app)?;
    let model =
        speech::engine::ModelId::parse(state.db.get_meta(speech::SPEECH_LOCAL_MODEL)?.as_deref());
    let engine = tokio::task::spawn_blocking(move || speech::engine::status(&dir, model))
        .await
        .map_err(|err| AppError::Message(format!("could not read the speech model: {err}")))?;
    Ok(SpeechSettingsView {
        enabled: flag(&state, speech::SPEECH_ENABLED, false)?,
        source: speech::Source::parse(state.db.get_meta(speech::SPEECH_SOURCE)?.as_deref())
            .as_str()
            .to_string(),
        server_host: openai::host_of(&server_url),
        server_local: openai::is_local(&server_url),
        has_key: state
            .db
            .get_meta(speech::SPEECH_API_KEY)?
            .is_some_and(|key| !key.is_empty()),
        model: state.db.get_meta(speech::SPEECH_MODEL)?.unwrap_or_default(),
        language: state
            .db
            .get_meta(speech::SPEECH_LANGUAGE)?
            .unwrap_or_default(),
        device: state
            .db
            .get_meta(speech::SPEECH_DEVICE)?
            .unwrap_or_default(),
        keep_audio: flag(&state, speech::SPEECH_KEEP_AUDIO, false)?,
        polish_level: speech::stored_level(&state.db)? as u8,
        polish_ready: llm::Server::load(&state.db).is_ok(),
        engine,
        microphone: speech::permission::status(),
        recording: speech::current(&state),
        base_url,
        server_url,
    })
}

/// Saves the given fields and leaves the rest. An empty key removes the saved key.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_speech_settings(
    app: AppHandle,
    state: State<AppState>,
    enabled: Option<bool>,
    source: Option<String>,
    base_url: Option<String>,
    key: Option<String>,
    model: Option<String>,
    language: Option<String>,
    device: Option<String>,
    keep_audio: Option<bool>,
    polish_level: Option<u8>,
    local_model: Option<String>,
) -> Result<(), AppError> {
    save_server(
        &state,
        (speech::SPEECH_BASE_URL, speech::SPEECH_API_KEY),
        base_url,
        key,
    )?;
    if let Some(source) = source {
        let source = speech::Source::parse(Some(source.trim()));
        state.db.set_meta(speech::SPEECH_SOURCE, source.as_str())?;
    }
    if let Some(model) = model {
        state.db.set_meta(speech::SPEECH_MODEL, model.trim())?;
    }
    if let Some(language) = language {
        let code: String = language
            .trim()
            .chars()
            .filter(char::is_ascii_alphabetic)
            .take(3)
            .collect();
        state
            .db
            .set_meta(speech::SPEECH_LANGUAGE, &code.to_ascii_lowercase())?;
    }
    if let Some(device) = device {
        state.db.set_meta(speech::SPEECH_DEVICE, device.trim())?;
    }
    save_flag(&state, speech::SPEECH_ENABLED, enabled)?;
    save_flag(&state, speech::SPEECH_KEEP_AUDIO, keep_audio)?;
    if let Some(model) = local_model {
        let model = speech::engine::ModelId::parse(Some(model.trim()));
        state
            .db
            .set_meta(speech::SPEECH_LOCAL_MODEL, model.as_str())?;
    }
    if let Some(level) = polish_level {
        let level = speech::Level::from_number(level) as u8;
        state
            .db
            .set_meta(speech::SPEECH_POLISH_LEVEL, &level.to_string())?;
    }
    let _ = app.emit("speech-settings-changed", ());
    Ok(())
}

/// Names of the microphones the system offers.
#[tauri::command]
pub async fn speech_devices() -> Vec<String> {
    tokio::task::spawn_blocking(speech::input_devices)
        .await
        .unwrap_or_default()
}

/// Holds the download slot, so two downloads do not write one file and a model is not
/// removed while it downloads.
struct Downloading<'a>(&'a AppState);

impl<'a> Downloading<'a> {
    fn begin(state: &'a AppState) -> Result<Self, AppError> {
        state
            .speech
            .downloading
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::Message("a speech model is downloading; wait for it".into()))?;
        Ok(Self(state))
    }
}

impl Drop for Downloading<'_> {
    fn drop(&mut self) {
        self.0.speech.downloading.store(false, Ordering::Release);
    }
}

/// Downloads the built-in recognizer. Progress arrives as `speech-download` events.
#[tauri::command]
pub async fn speech_download(
    app: AppHandle,
    state: State<'_, AppState>,
    model: Option<String>,
) -> Result<(), AppError> {
    let dir = speech::engine_dir(&app)?;
    let id = match model.as_deref() {
        Some(name) => speech::engine::ModelId::parse(Some(name)),
        None => speech::engine::ModelId::parse(
            state.db.get_meta(speech::SPEECH_LOCAL_MODEL)?.as_deref(),
        ),
    };
    let _downloading = Downloading::begin(&state)?;
    let http = state.http.clone();
    let report = {
        let app = app.clone();
        move |progress: speech::engine::Progress| {
            let _ = app.emit("speech-download", progress);
        }
    };
    let result = speech::engine::install(&http, &dir, id, &report).await;
    let status = speech::engine::status(&dir, id);
    report(speech::engine::Progress {
        received: 0,
        total: status.download_bytes,
        stage: if result.is_ok() { "done" } else { "error" }.into(),
        error: result.as_ref().err().map(ToString::to_string),
    });
    let _ = app.emit("speech-settings-changed", ());
    result
}

/// Deletes the built-in recognizer's files.
#[tauri::command]
pub fn speech_remove_model(
    app: AppHandle,
    state: State<AppState>,
    model: Option<String>,
) -> Result<(), AppError> {
    if speech::current(&state).is_some() {
        return Err(AppError::Message("stop the recording first".into()));
    }
    let _downloading = Downloading::begin(&state)?;
    let id = speech::engine::ModelId::parse(
        model
            .or(state.db.get_meta(speech::SPEECH_LOCAL_MODEL)?)
            .as_deref(),
    );
    speech::engine::remove(&speech::engine_dir(&app)?, id)?;
    let _ = app.emit("speech-settings-changed", ());
    Ok(())
}

/// Starts recording. `purpose` is `memo` for dictation or `prompt` for a spoken model prompt.
#[tauri::command]
pub async fn speech_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    purpose: speech::Purpose,
    note_id: Option<String>,
) -> Result<String, AppError> {
    if !flag(&state, speech::SPEECH_ENABLED, false)? {
        return Err(AppError::Message("recording is turned off".into()));
    }
    let recognizer = speech::recognizer(&state.db)?;
    let keep_audio = flag(&state, speech::SPEECH_KEEP_AUDIO, false)?;
    match recognizer.source {
        speech::Source::Local => {
            let status = speech::engine::status(&speech::engine_dir(&app)?, recognizer.local_model);
            if !status.supported {
                return Err(AppError::Message(
                    "the built-in recognizer is not available on this computer; use a speech server".into(),
                ));
            }
            if !status.installed {
                return Err(AppError::Message(
                    "download the chosen speech model in Settings first".into(),
                ));
            }
        }
        speech::Source::Server => {
            if recognizer.base.is_empty() {
                return Err(AppError::Message("speech server URL is not set".into()));
            }
            if recognizer.model.is_empty() {
                return Err(AppError::Message("speech model is not set".into()));
            }
            if purpose == speech::Purpose::Memo {
                refuse_remote_for_offline(&state, &recognizer, note_id.as_deref())?;
            }
        }
        speech::Source::Off => {
            if purpose == speech::Purpose::Prompt {
                return Err(AppError::Message(
                    "speech to text is turned off, so a prompt cannot be spoken".into(),
                ));
            }
            if !keep_audio {
                return Err(AppError::Message(
                    "turn on speech to text or keeping the recording first".into(),
                ));
            }
        }
    }
    // Asks the system first, so a missing permission is an error instead of silent sound.
    let permission = tokio::task::spawn_blocking(speech::permission::request)
        .await
        .map_err(|err| AppError::Message(format!("recording did not start: {err}")))?;
    let _ = app.emit("speech-settings-changed", ());
    if permission.access == speech::permission::Access::Denied {
        return Err(AppError::Message(speech::permission::denied_message(
            permission.borrowed,
        )));
    }
    let options = speech::StartOptions {
        purpose,
        note_id,
        window: window.label().to_string(),
        keep_audio,
        // Each saved file of a long recording stays under the server's upload limit.
        part_samples: speech::audio::part_samples(
            crate::notes::limits::stored(&state.db)?.upload_bytes,
        ),
        device: state
            .db
            .get_meta(speech::SPEECH_DEVICE)?
            .unwrap_or_default(),
        recognizer,
    };
    let handle = app.clone();
    tokio::task::spawn_blocking(move || speech::start(&handle, options))
        .await
        .map_err(|err| AppError::Message(format!("recording did not start: {err}")))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingInfo {
    name: String,
    /// What the recognizer gave while recording.
    heard: String,
    /// The recording's text as it was put into the memo.
    text: String,
}

/// Recordings made in this app among the given media names.
#[tauri::command]
pub fn recordings_info(
    state: State<AppState>,
    names: Vec<String>,
) -> Result<Vec<RecordingInfo>, AppError> {
    let names: Vec<String> = names.into_iter().take(200).collect();
    Ok(state
        .db
        .recordings(&names)?
        .into_iter()
        .map(|(name, heard, text)| RecordingInfo { name, heard, text })
        .collect())
}

/// Remembers the text a recording put into the memo.
#[tauri::command]
pub fn recording_set_text(
    state: State<AppState>,
    name: String,
    text: String,
) -> Result<(), AppError> {
    state.db.set_recording_text(&name, &text)?;
    Ok(())
}

/// Turns a whole saved recording into text again.
#[tauri::command]
pub async fn recording_transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    note_id: Option<String>,
) -> Result<String, AppError> {
    let path = crate::media::resolve(&state.media_dir, &name)?;
    if speech::current(&state).is_some() {
        return Err(AppError::Message("stop the recording first".into()));
    }
    let recognizer = speech::recognizer(&state.db)?;
    if recognizer.source == speech::Source::Server {
        refuse_remote_for_offline(&state, &recognizer, note_id.as_deref())?;
    }
    speech::transcribe_file(&app, &path).await
}

/// Asks the system for the microphone now, from settings, instead of at the first recording.
#[tauri::command]
pub async fn speech_request_microphone(
    app: AppHandle,
) -> Result<speech::permission::Permission, AppError> {
    let permission = tokio::task::spawn_blocking(speech::permission::request)
        .await
        .map_err(|err| AppError::Message(format!("the request stopped: {err}")))?;
    let _ = app.emit("speech-settings-changed", ());
    Ok(permission)
}

/// Opens the microphone page of the system privacy settings.
#[tauri::command]
pub fn speech_open_privacy() -> Result<(), AppError> {
    speech::permission::open_settings()
}

/// Ends the running recording. Its last text and `speech-done` follow as events.
#[tauri::command]
pub fn speech_stop(state: State<AppState>) {
    speech::stop(&state);
}

/// Improves dictated text with the chat model at `level` (1 to 4). Only level 4 uses `before` and `after`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn speech_polish(
    state: State<'_, AppState>,
    note_id: Option<String>,
    before: String,
    after: String,
    dictated: String,
    level: u8,
    corrections: Option<bool>,
    later: Option<String>,
) -> Result<String, AppError> {
    if dictated.trim().is_empty() {
        return Ok(String::new());
    }
    let server = llm::Server::for_note(&state.db, note_id.as_deref())?;
    speech::polish(
        &state.http,
        &server,
        &state.db,
        speech::Level::from_number(level),
        &dictated,
        speech::PolishContext {
            before: &before,
            after: &after,
            corrections: corrections.unwrap_or(false),
            later: later.as_deref().unwrap_or(""),
        },
    )
    .await
}

/// An offline-only memo is not spoken to a speech server on another computer.
fn refuse_remote_for_offline(
    state: &AppState,
    recognizer: &speech::Recognizer,
    note_id: Option<&str>,
) -> Result<(), AppError> {
    if !openai::is_local(&recognizer.base) && state.db.offline_only(note_id)? {
        return Err(AppError::Message(
            "this memo is kept on this computer only; use the built-in recognizer for it".into(),
        ));
    }
    Ok(())
}
