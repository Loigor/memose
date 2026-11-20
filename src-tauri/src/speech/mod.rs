//! Recording and speech to text.
//!
//! One recording runs at a time. A thread owns the microphone, cuts the sound into
//! slices at pauses, and hands them to a task that turns each slice into text. The
//! windows hear about it through events: `speech-state`, `speech-level`,
//! `speech-chunk`, and `speech-done`.

pub mod audio;
pub mod engine;
pub mod permission;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;
use crate::llm;
use crate::notes::Db;
use crate::state::AppState;

use audio::{ChunkPlan, Chunker, Resampler};
use engine::Engine;

pub const SPEECH_ENABLED: &str = "speech_enabled";
/// `local` for the built-in recognizer, `server` for an OpenAI-compatible speech server, `off` for sound only.
pub const SPEECH_SOURCE: &str = "speech_source";
pub const SPEECH_BASE_URL: &str = "speech_base_url";
pub const SPEECH_API_KEY: &str = "speech_api_key";
pub const SPEECH_MODEL: &str = "speech_model";
pub const SPEECH_LANGUAGE: &str = "speech_language";
/// The built-in model in use: `parakeet` or `canary`.
pub const SPEECH_LOCAL_MODEL: &str = "speech_local_model";
pub const SPEECH_DEVICE: &str = "speech_device";
pub const SPEECH_KEEP_AUDIO: &str = "speech_keep_audio";
pub const SPEECH_POLISH: &str = "speech_polish";
/// Improvement level for live dictation, 1 to 4.
pub const SPEECH_POLISH_LEVEL: &str = "speech_polish_level";

/// A microphone that has given only exact zeros for this long is not shared with the app.
const SILENT_DEVICE: Duration = Duration::from_millis(1500);

fn silent_device_message() -> String {
    if cfg!(target_os = "macos") {
        permission::denied_message(permission::status().borrowed)
    } else {
        "The microphone gives no sound. Check that it is connected and not muted.".into()
    }
}

/// A recording stops by itself after this long.
const MAX_SECONDS: u64 = 30 * 60;
/// The model is dropped this long after the last recording, to give its memory back.
const ENGINE_IDLE: Duration = Duration::from_secs(90);
const SERVER_TIMEOUT: Duration = Duration::from_secs(120);
const POLISH_TIMEOUT: Duration = Duration::from_secs(120);
/// Rules every improvement level shares.
const POLISH_COMMON: &str = "Reply with the corrected text only. Reply in the language of the text and never translate it. Do not add content, do not answer questions in it, do not add line breaks, and do not explain.";
/// Level 2. Each level after it does everything the one before does, and more.
const POLISH_IMPROVED: &str = "You fix text that a speech recognizer heard. Add punctuation and capital letters. Fix words that are clearly recognition errors. Keep the speaker's own words, dialect, and word order.";
/// Level 3: level 2, then proof-reading.
const POLISH_PROOF: &str = "You fix and proof-read text that a speech recognizer heard. First add punctuation and capital letters and fix words that are clearly recognition errors. Then proof-read it: correct spelling and grammar, so it reads as correct standard written language. Keep the meaning, the tone, and everything that was said.";
/// Level 4: level 3, using the note around the words.
const POLISH_CONTEXT: &str = "You fix and proof-read text that a user dictated into a note. You also get the note text before and after it. First add punctuation and capital letters and fix words that are clearly recognition errors. Then proof-read it: correct spelling and grammar, so it reads as correct standard written language. Use the note to pick the right names, terms, and form, and apply spoken corrections such as \"no, I mean\" or \"scratch that\". Keep the meaning, the tone, and everything that was said.";

/// Added at High and Max: the speaker restarting a sentence or saying it again reworded.
const POLISH_CORRECTIONS: &str = "The speaker may correct themselves: they stop and say a phrase or sentence again, reworded. When a later part of the dictated text says an earlier part again, keep only the later version and remove the earlier one. Text in <later> was said right after the dictated text and is not yours to change; when it says the end of the dictated text again, remove that end from your reply. If <later> says all of the dictated text again, reply with [restated] only. Remove nothing that is not said again.";
/// The reply that means every word was said again later.
const RESTATED: &str = "[restated]";

/// Names of the languages the built-in models know, for telling the chat model which one
/// the text is in. Matches the list in the settings window.
const LANGUAGE_NAMES: [(&str, &str); 25] = [
    ("bg", "Bulgarian"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("en", "English"),
    ("es", "Spanish"),
    ("et", "Estonian"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("it", "Italian"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("mt", "Maltese"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sv", "Swedish"),
    ("uk", "Ukrainian"),
];

/// The system prompt for one improvement level. A chosen spoken language is named, so a
/// small model does not guess it or drift into English.
fn polish_rules(level: Level, language: &str) -> String {
    let rules = match level {
        Level::Context => POLISH_CONTEXT,
        Level::Proofread => POLISH_PROOF,
        _ => POLISH_IMPROVED,
    };
    let code = language.trim();
    if code.is_empty() {
        return format!("{rules} {POLISH_COMMON}");
    }
    let name = LANGUAGE_NAMES
        .iter()
        .find(|(known, _)| *known == code)
        .map_or_else(
            || format!("the language with code \"{code}\""),
            |(_, name)| (*name).to_string(),
        );
    format!("{rules} The text is in {name}; use correct {name} words and spelling. {POLISH_COMMON}")
}

/// How much the chat model may change dictated text: the effort level shown as Low, Medium,
/// High, and Max.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Low: as the recognizer heard it. No model.
    Basic = 1,
    /// Medium: punctuation, capitals, and clear recognition errors. Dialect stays.
    Improved = 2,
    /// High: spelling and grammar into standard written language.
    Proofread = 3,
    /// Max: proof-read with the memo around the words as context.
    Context = 4,
}

impl Level {
    pub const DEFAULT: Self = Self::Improved;

    pub fn from_number(value: u8) -> Self {
        match value {
            1 => Self::Basic,
            3 => Self::Proofread,
            4 => Self::Context,
            _ => Self::Improved,
        }
    }

    /// The share of the heard words a reply must keep. A reply that keeps fewer is the model
    /// rewriting on its own, and the words stay as heard.
    fn min_kept(self) -> f32 {
        match self {
            Self::Basic => 1.0,
            Self::Improved => 0.6,
            Self::Proofread | Self::Context => 0.35,
        }
    }
}

/// The saved level for live dictation.
pub fn stored_level(db: &Db) -> Result<Level, AppError> {
    if let Some(value) = db
        .get_meta(SPEECH_POLISH_LEVEL)?
        .and_then(|v| v.parse::<u8>().ok())
    {
        return Ok(Level::from_number(value));
    }
    // Before levels there was an on/off switch.
    Ok(match db.get_meta(SPEECH_POLISH)?.as_deref() {
        Some("0") => Level::Basic,
        _ => Level::DEFAULT,
    })
}

fn plain_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|ch| ch.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

/// Share of the heard words that the reply keeps in order, ignoring case and punctuation.
pub fn kept_share(heard: &str, reply: &str) -> f32 {
    let a = plain_words(heard);
    let b = plain_words(reply);
    if a.is_empty() {
        return 1.0;
    }
    let mut row = vec![0_usize; b.len() + 1];
    for word in &a {
        let mut diagonal = 0;
        for (j, other) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if word == other {
                diagonal + 1
            } else {
                row[j + 1].max(row[j])
            };
            diagonal = above;
        }
    }
    row[b.len()] as f32 / a.len() as f32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    /// Dictation into a memo. The sound can be kept as an attachment.
    Memo,
    /// A spoken prompt for the model. The sound is never kept.
    Prompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Local,
    Server,
    Off,
}

impl Source {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("server") => Self::Server,
            Some("off") => Self::Off,
            _ => Self::Local,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Server => "server",
            Self::Off => "off",
        }
    }
}

/// Where a recording's text comes from, read from settings when it starts.
#[derive(Debug, Clone)]
pub struct Recognizer {
    pub source: Source,
    pub base: String,
    pub key: Option<String>,
    pub model: String,
    pub language: String,
    /// The built-in model, for the `local` source.
    pub local_model: engine::ModelId,
}

/// The speech server falls back to the model server when it has no address of its own.
pub fn server_base(db: &Db) -> Result<String, AppError> {
    let own = db.get_meta(SPEECH_BASE_URL)?.unwrap_or_default();
    if !own.is_empty() {
        return Ok(own);
    }
    Ok(db.get_meta(llm::LLM_BASE_URL)?.unwrap_or_default())
}

fn server_key(db: &Db) -> Result<Option<String>, AppError> {
    let own_base = db.get_meta(SPEECH_BASE_URL)?.unwrap_or_default();
    if own_base.is_empty() {
        return db.get_meta(llm::LLM_API_KEY);
    }
    db.get_meta(SPEECH_API_KEY)
}

pub fn recognizer(db: &Db) -> Result<Recognizer, AppError> {
    Ok(Recognizer {
        source: Source::parse(db.get_meta(SPEECH_SOURCE)?.as_deref()),
        base: server_base(db)?,
        key: server_key(db)?,
        model: db.get_meta(SPEECH_MODEL)?.unwrap_or_default(),
        language: db.get_meta(SPEECH_LANGUAGE)?.unwrap_or_default(),
        local_model: engine::ModelId::parse(db.get_meta(SPEECH_LOCAL_MODEL)?.as_deref()),
    })
}

/// Folder of the built-in recognizer's files.
pub fn engine_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("speech"))
        .map_err(|err| AppError::Message(format!("app data folder is unavailable: {err}")))
}

/// Names of the microphones the system offers.
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    let mut names: Vec<String> = devices.filter_map(|device| device.name().ok()).collect();
    names.sort();
    names.dedup();
    names
}

fn pick_device(name: &str) -> Result<cpal::Device, AppError> {
    let host = cpal::default_host();
    if !name.is_empty() {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(found) = devices.find(|device| device.name().is_ok_and(|n| n == name)) {
                return Ok(found);
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| AppError::Message("no microphone was found".into()))
}

/// One slice sent to an OpenAI-compatible speech server.
pub async fn transcribe_remote(
    http: &reqwest::Client,
    recognizer: &Recognizer,
    wav: Vec<u8>,
    previous: &str,
) -> Result<String, AppError> {
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|err| AppError::Message(format!("could not build the upload: {err}")))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("model", recognizer.model.clone())
        .text("response_format", "json");
    if !recognizer.language.is_empty() {
        form = form.text("language", recognizer.language.clone());
    }
    // The end of what was already heard keeps names and spelling steady across slices.
    let tail: String = {
        let chars: Vec<char> = previous.chars().collect();
        chars[chars.len().saturating_sub(200)..].iter().collect()
    };
    if !tail.trim().is_empty() {
        form = form.text("prompt", tail);
    }
    let mut request = http
        .post(llm::api_url(&recognizer.base, "audio/transcriptions"))
        .timeout(SERVER_TIMEOUT)
        .multipart(form);
    if let Some(key) = recognizer.key.as_deref().filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|err| {
        if err.is_connect() {
            AppError::Message("could not reach the speech server".into())
        } else if err.is_timeout() {
            AppError::Message("the speech server took too long to answer".into())
        } else {
            AppError::Message("the request to the speech server failed".into())
        }
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail: String = body.trim().chars().take(200).collect();
        return Err(AppError::Message(format!(
            "speech server returned {}: {detail}",
            status.as_u16()
        )));
    }
    let text = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or(body);
    Ok(text.trim().to_string())
}

/// Share of the words a reply drops that are said again in the reply or in `later`. A
/// correction drops the words of the first try, which mostly come back reworded.
fn restated_share(heard: &str, reply: &str, later: &str) -> f32 {
    let mut left: Vec<String> = plain_words(reply);
    let mut dropped = Vec::new();
    for word in plain_words(heard) {
        match left.iter().position(|other| *other == word) {
            Some(at) => {
                left.remove(at);
            }
            None => dropped.push(word),
        }
    }
    if dropped.is_empty() {
        return 1.0;
    }
    let again: std::collections::HashSet<String> = plain_words(reply)
        .into_iter()
        .chain(plain_words(later))
        .collect();
    dropped.iter().filter(|word| again.contains(*word)).count() as f32 / dropped.len() as f32
}

/// Whether a reply that removed a correction's first try may replace what was heard.
fn correction_allowed(level: Level, heard: &str, reply: &str, later: &str) -> bool {
    kept_share(heard, reply) >= level.min_kept()
        || (kept_share(heard, reply) >= 0.25 && restated_share(heard, reply, later) >= 0.6)
}

/// What one improvement pass gets besides the dictated words.
#[derive(Debug, Default, Clone, Copy)]
pub struct PolishContext<'a> {
    /// Note text before and after the dictation, for the Max level.
    pub before: &'a str,
    pub after: &'a str,
    /// Remove a first try that the speaker said again (High and Max).
    pub corrections: bool,
    /// Words said right after the dictated text, which may say its end again.
    pub later: &'a str,
}

/// Lets the chat model tidy dictated text, using the note around the cursor. With
/// corrections, an empty reply means every word was said again in `later`.
pub async fn polish(
    http: &reqwest::Client,
    db: &Db,
    level: Level,
    dictated: &str,
    context: PolishContext<'_>,
) -> Result<String, AppError> {
    let PolishContext {
        before,
        after,
        corrections,
        later,
    } = context;
    if level == Level::Basic || dictated.trim().is_empty() {
        return Ok(dictated.to_string());
    }
    let base = db
        .get_meta(llm::LLM_BASE_URL)?
        .filter(|url| !url.is_empty())
        .ok_or_else(|| AppError::Message("model server URL is not set".into()))?;
    let model = db
        .get_meta(llm::LLM_MODEL)?
        .filter(|model| !model.is_empty())
        .ok_or_else(|| AppError::Message("model is not set".into()))?;
    let key = db.get_meta(llm::LLM_API_KEY)?;
    let mut user = match level {
        Level::Context => format!(
            "<before>\n{before}\n</before>\n\n<after>\n{after}\n</after>\n\n<dictated>\n{dictated}\n</dictated>"
        ),
        _ => format!("<dictated>\n{dictated}\n</dictated>"),
    };
    let later = if corrections { later.trim() } else { "" };
    if !later.is_empty() {
        user.push_str(&format!("\n\n<later>\n{later}\n</later>"));
    }
    let mut rules = polish_rules(level, &db.get_meta(SPEECH_LANGUAGE)?.unwrap_or_default());
    if corrections {
        rules = format!("{POLISH_CORRECTIONS} {rules}");
    }
    let raw = llm::complete(
        http,
        &base,
        key.as_deref(),
        &model,
        &rules,
        &user,
        POLISH_TIMEOUT,
    )
    .await?;
    let cleaned = llm::clean_answer(&raw, "");
    let cleaned = cleaned
        .trim()
        .trim_start_matches("<dictated>")
        .trim_end_matches("</dictated>")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    judge_reply(level, dictated, &cleaned, corrections, later)
}

/// Decides what a pass's reply turns the heard words into.
fn judge_reply(
    level: Level,
    dictated: &str,
    reply: &str,
    corrections: bool,
    later: &str,
) -> Result<String, AppError> {
    let reply = reply.trim();
    if corrections && !later.is_empty() && (reply == RESTATED || reply.is_empty()) {
        // Everything was said again later: only allowed when most words do come back.
        return Ok(if restated_share(dictated, "", later) >= 0.6 {
            String::new()
        } else {
            dictated.to_string()
        });
    }
    if reply.is_empty() || reply == RESTATED {
        return Err(AppError::Message("the model returned no text".into()));
    }
    let allowed = if corrections {
        correction_allowed(level, dictated, reply, later)
    } else {
        kept_share(dictated, reply) >= level.min_kept()
    };
    Ok(if allowed {
        reply.to_string()
    } else {
        dictated.to_string()
    })
}

/// The recording that is running now.
pub struct Active {
    pub id: String,
    pub note_id: Option<String>,
    pub purpose: Purpose,
    /// Label of the window the words go into. It stays on screen until the recording ends.
    pub window: String,
    stop: Arc<AtomicBool>,
}

/// Recording state kept on `AppState`.
#[derive(Default)]
pub struct SpeechState {
    pub active: Mutex<Option<Active>>,
    /// The loaded model, shared between recordings and dropped when idle.
    engine: Arc<Mutex<Option<Engine>>>,
    /// Counts recordings, so an idle timer knows whether a newer one started.
    uses: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub recording: bool,
    pub session_id: String,
    pub note_id: Option<String>,
    pub purpose: Purpose,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkEvent {
    session_id: String,
    seq: u32,
    text: String,
    /// Silence before this piece, in ms. A long one starts a new paragraph.
    pause_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
    session_id: String,
    level: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    session_id: String,
    note_id: Option<String>,
    purpose: Purpose,
    /// Markdown line of the saved recording, when sound was kept.
    audio: Option<String>,
    error: Option<String>,
}

enum Work {
    /// A piece of speech, its number, and the silence before it in ms.
    Slice(u32, Vec<f32>, u32),
    /// Capture ended. Holds the whole recording when it is to be kept, and a capture error if any.
    End(Vec<i16>, Option<String>),
}

/// What `start` needs to know.
pub struct StartOptions {
    pub purpose: Purpose,
    pub note_id: Option<String>,
    /// Label of the window that started the recording.
    pub window: String,
    pub keep_audio: bool,
    pub device: String,
    pub recognizer: Recognizer,
}

/// Label of the window a running recording writes into.
pub fn recording_window(state: &AppState) -> Option<String> {
    state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|active| active.window.clone())
}

pub fn current(state: &AppState) -> Option<StateEvent> {
    let active = state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active.as_ref().map(|active| StateEvent {
        recording: true,
        session_id: active.id.clone(),
        note_id: active.note_id.clone(),
        purpose: active.purpose,
    })
}

/// Asks the running recording to end. Its text and its `speech-done` event still arrive.
pub fn stop(state: &AppState) {
    let active = state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(active) = active.as_ref() {
        active.stop.store(true, Ordering::SeqCst);
    }
}

/// Starts a recording and returns its id once the microphone is open.
pub fn start(app: &AppHandle, options: StartOptions) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let mut active = state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.is_some() {
        return Err(AppError::Message("a recording is already running".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (work_tx, work_rx) = tokio::sync::mpsc::unbounded_channel::<Work>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let plan = match options.purpose {
        Purpose::Memo => ChunkPlan::DICTATION,
        Purpose::Prompt => ChunkPlan::PROMPT,
    };
    let keep = options.keep_audio && options.purpose == Purpose::Memo;
    let slices = options.recognizer.source != Source::Off;
    {
        let app = app.clone();
        let id = id.clone();
        let stop_flag = stop_flag.clone();
        let device = options.device.clone();
        std::thread::Builder::new()
            .name("memose-mic".into())
            .spawn(move || {
                capture(
                    &app, &id, &device, plan, keep, slices, &stop_flag, &work_tx, &ready_tx,
                );
            })
            .map_err(|err| AppError::Message(format!("could not start recording: {err}")))?;
    }
    match ready_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => {}
        Ok(Err(message)) => return Err(AppError::Message(message)),
        Err(_) => {
            stop_flag.store(true, Ordering::SeqCst);
            return Err(AppError::Message("the microphone did not start".into()));
        }
    }

    let event = StateEvent {
        recording: true,
        session_id: id.clone(),
        note_id: options.note_id.clone(),
        purpose: options.purpose,
    };
    *active = Some(Active {
        id: id.clone(),
        note_id: options.note_id.clone(),
        purpose: options.purpose,
        window: options.window.clone(),
        stop: stop_flag,
    });
    drop(active);
    state.speech.uses.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("speech-state", &event);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        work(app, event, options.recognizer, work_rx).await;
    });
    Ok(id)
}

/// Runs on its own thread: owns the microphone until the stop flag is set.
#[allow(clippy::too_many_arguments)]
fn capture(
    app: &AppHandle,
    id: &str,
    device: &str,
    plan: ChunkPlan,
    keep: bool,
    slices: bool,
    stop: &AtomicBool,
    work: &tokio::sync::mpsc::UnboundedSender<Work>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let failed = Arc::new(Mutex::new(None::<String>));
    let opened = (|| -> Result<(cpal::Stream, u32, u16), AppError> {
        let device = pick_device(device)?;
        let config = device
            .default_input_config()
            .map_err(|err| AppError::Message(format!("the microphone cannot be used: {err}")))?;
        let rate = config.sample_rate().0;
        let channels = config.channels();
        let on_error = {
            let failed = failed.clone();
            move |err: cpal::StreamError| {
                *failed
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some(format!("the microphone stopped: {err}"));
            }
        };
        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(data.to_vec());
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(data.iter().map(|s| f32::from(*s) / 32768.0).collect());
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(
                        data.iter()
                            .map(|s| (f32::from(*s) - 32768.0) / 32768.0)
                            .collect(),
                    );
                },
                on_error,
                None,
            ),
            other => {
                return Err(AppError::Message(format!(
                    "the microphone format {other:?} is not supported"
                )))
            }
        }
        .map_err(|err| AppError::Message(format!("the microphone cannot be opened: {err}")))?;
        stream
            .play()
            .map_err(|err| AppError::Message(format!("the microphone cannot be started: {err}")))?;
        Ok((stream, rate, channels))
    })();
    let (stream, rate, channels) = match opened {
        Ok(opened) => {
            let _ = ready.send(Ok(()));
            opened
        }
        Err(err) => {
            let _ = ready.send(Err(err.to_string()));
            return;
        }
    };

    let mut resampler = Resampler::new(rate, channels);
    let mut chunker = Chunker::new(plan);
    let mut mono = Vec::new();
    let mut all: Vec<i16> = Vec::new();
    let keep_cap = crate::media::MAX_MEDIA_BYTES / 2 - 64;
    let mut seq = 0_u32;
    let started = Instant::now();
    let mut last_level = Instant::now();
    let mut error = None;
    // A microphone the system will not share delivers exact zeros instead of failing.
    let mut any_sound = false;
    loop {
        if stop.load(Ordering::SeqCst) || started.elapsed().as_secs() >= MAX_SECONDS {
            break;
        }
        if !any_sound && started.elapsed() >= SILENT_DEVICE {
            error = Some(silent_device_message());
            // Silence is not worth keeping as a recording.
            all.clear();
            break;
        }
        if let Some(message) = failed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            error = Some(message);
            break;
        }
        let Ok(data) = rx.recv_timeout(Duration::from_millis(60)) else {
            continue;
        };
        any_sound = any_sound || data.iter().any(|sample| *sample != 0.0);
        mono.clear();
        resampler.push(&data, &mut mono);
        if keep && all.len() < keep_cap {
            all.extend(audio::to_pcm(&mono));
        }
        for slice in chunker.push(&mono) {
            let pause = chunker.take_pause();
            if slices {
                let _ = work.send(Work::Slice(seq, slice, pause));
                seq += 1;
            }
        }
        if last_level.elapsed() >= Duration::from_millis(120) {
            last_level = Instant::now();
            let _ = app.emit(
                "speech-level",
                LevelEvent {
                    session_id: id.to_string(),
                    level: (chunker.take_level() * 6.0).min(1.0),
                },
            );
        }
    }
    drop(stream);
    if slices {
        if let Some(slice) = chunker.finish() {
            let pause = chunker.take_pause();
            let _ = work.send(Work::Slice(seq, slice, pause));
        }
    }
    let _ = work.send(Work::End(all, error));
}

/// Turns slices into text in order, then closes the recording.
async fn work(
    app: AppHandle,
    event: StateEvent,
    recognizer: Recognizer,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Work>,
) {
    let state = app.state::<AppState>();
    let engine = state.speech.engine.clone();
    let http = state.http.clone();
    let mut heard = String::new();
    let mut failure: Option<String> = None;
    let mut audio_line = None;

    if recognizer.source == Source::Local {
        let dir = engine_dir(&app);
        let engine = engine.clone();
        let model = recognizer.local_model;
        let language = recognizer.language.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            let mut slot = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // A model or language picked since the last recording replaces the loaded one.
            if !slot
                .as_ref()
                .is_some_and(|loaded| loaded.is(model, &language))
            {
                *slot = None;
                *slot = Some(Engine::load(&dir?, model, &language)?);
            }
            Ok::<(), AppError>(())
        })
        .await;
        if let Some(message) = match loaded {
            Ok(Ok(())) => None,
            Ok(Err(err)) => Some(err.to_string()),
            Err(err) => Some(format!("the speech model stopped: {err}")),
        } {
            failure = Some(message);
            stop(&state);
        }
    }

    while let Some(item) = rx.recv().await {
        match item {
            Work::Slice(seq, samples, pause_ms) => {
                if failure.is_some() {
                    continue;
                }
                let text = match recognizer.source {
                    Source::Off => continue,
                    Source::Local => {
                        let engine = engine.clone();
                        tokio::task::spawn_blocking(move || {
                            let mut slot = engine
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            match slot.as_mut() {
                                Some(engine) => engine.transcribe(&samples),
                                None => {
                                    Err(AppError::Message("the speech model is not loaded".into()))
                                }
                            }
                        })
                        .await
                        .unwrap_or_else(|err| {
                            Err(AppError::Message(format!(
                                "the speech model stopped: {err}"
                            )))
                        })
                    }
                    Source::Server => {
                        let wav = audio::wav_bytes(&audio::to_pcm(&samples));
                        transcribe_remote(&http, &recognizer, wav, &heard).await
                    }
                };
                match text {
                    Ok(text) if !text.is_empty() => {
                        if !heard.is_empty() {
                            heard.push(' ');
                        }
                        heard.push_str(&text);
                        let _ = app.emit(
                            "speech-chunk",
                            ChunkEvent {
                                session_id: event.session_id.clone(),
                                seq,
                                text,
                                pause_ms,
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(err) => {
                        failure = Some(err.to_string());
                        stop(&state);
                    }
                }
            }
            Work::End(pcm, capture_error) => {
                if failure.is_none() {
                    failure = capture_error;
                }
                if !pcm.is_empty() {
                    let name = format!("voice-{}.wav", &event.session_id[..8]);
                    match crate::media::save_named(
                        &state.media_dir,
                        &audio::wav_bytes(&pcm),
                        Some(&name),
                        Some("audio/wav"),
                    ) {
                        Ok(line) => {
                            if let Some(media) = crate::media::parse_media_token(&line) {
                                let _ = state.db.save_recording(&media.name, &heard);
                            }
                            audio_line = Some(line);
                        }
                        Err(err) => {
                            failure.get_or_insert(format!("the recording was not saved: {err}"));
                        }
                    }
                }
                break;
            }
        }
    }

    *state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    let _ = app.emit(
        "speech-state",
        StateEvent {
            recording: false,
            ..event.clone()
        },
    );
    let _ = app.emit(
        "speech-done",
        DoneEvent {
            session_id: event.session_id.clone(),
            note_id: event.note_id.clone(),
            purpose: event.purpose,
            audio: audio_line,
            error: failure,
        },
    );

    release_later(&app).await;
}

/// Gives the model's memory back unless it is used again soon.
async fn release_later(app: &AppHandle) {
    let state = app.state::<AppState>();
    let engine = state.speech.engine.clone();
    let uses = state.speech.uses.clone();
    let seen = uses.load(Ordering::SeqCst);
    tokio::time::sleep(ENGINE_IDLE).await;
    let state = app.state::<AppState>();
    let idle = uses.load(Ordering::SeqCst) == seen
        && state
            .speech
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none();
    if idle {
        let _ = tokio::task::spawn_blocking(move || {
            engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
        })
        .await;
    }
}

/// Samples of a WAV file as 16 kHz mono. Handles 16-bit PCM at any rate and channel count.
pub fn wav_samples(bytes: &[u8]) -> Result<Vec<f32>, AppError> {
    let bad = || AppError::Message("the recording is not a WAV file this app can read".into());
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let mut at = 12;
    let (mut channels, mut rate, mut bits) = (0_u16, 0_u32, 0_u16);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().map_err(|_| bad())?) as usize;
        let body = at + 8;
        let end = (body + len).min(bytes.len());
        if id == b"fmt " && end >= body + 16 {
            let format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
            channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().map_err(|_| bad())?);
            bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            if format != 1 {
                return Err(bad());
            }
        } else if id == b"data" {
            if bits != 16 || channels == 0 || rate == 0 {
                return Err(bad());
            }
            let raw: Vec<f32> = bytes[body..end]
                .chunks_exact(2)
                .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
                .collect();
            if rate == audio::RATE && channels == 1 {
                return Ok(raw);
            }
            let mut out = Vec::with_capacity(raw.len());
            Resampler::new(rate, channels).push(&raw, &mut out);
            return Ok(out);
        }
        at = body + len + (len & 1);
    }
    Err(bad())
}

/// Turns a whole saved recording into text again, cut at pauses, with the recognizer in settings.
pub async fn transcribe_file(app: &AppHandle, path: &std::path::Path) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let recognizer = recognizer(&state.db)?;
    if recognizer.source == Source::Off {
        return Err(AppError::Message("speech to text is turned off".into()));
    }
    let bytes = std::fs::read(path)?;
    let slices = tokio::task::spawn_blocking(move || {
        let samples = wav_samples(&bytes)?;
        // Long pieces give the recognizer the most context. It still cuts at pauses.
        let mut chunker = Chunker::new(ChunkPlan {
            pause_ms: 900,
            max_ms: 28_000,
        });
        let mut slices = chunker.push(&samples);
        slices.extend(chunker.finish());
        Ok::<_, AppError>(slices)
    })
    .await
    .map_err(|err| AppError::Message(format!("reading the recording stopped: {err}")))??;
    if slices.is_empty() {
        return Err(AppError::Message(
            "no speech was found in the recording".into(),
        ));
    }
    let mut heard = String::new();
    match recognizer.source {
        Source::Local => {
            state.speech.uses.fetch_add(1, Ordering::SeqCst);
            let engine = state.speech.engine.clone();
            let dir = engine_dir(app)?;
            let model = recognizer.local_model;
            let language = recognizer.language.clone();
            let text = tokio::task::spawn_blocking(move || {
                let mut slot = engine
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if !slot
                    .as_ref()
                    .is_some_and(|loaded| loaded.is(model, &language))
                {
                    *slot = None;
                    *slot = Some(Engine::load(&dir, model, &language)?);
                }
                let loaded = slot
                    .as_mut()
                    .ok_or_else(|| AppError::Message("the speech model is not loaded".into()))?;
                let mut parts = Vec::new();
                for slice in &slices {
                    let part = loaded.transcribe(slice)?;
                    if !part.is_empty() {
                        parts.push(part);
                    }
                }
                Ok::<_, AppError>(parts.join(" "))
            })
            .await
            .map_err(|err| AppError::Message(format!("the speech model stopped: {err}")))?;
            let release = app.clone();
            tauri::async_runtime::spawn(async move { release_later(&release).await });
            heard = text?;
        }
        Source::Server => {
            for slice in slices {
                let wav = audio::wav_bytes(&audio::to_pcm(&slice));
                let part = transcribe_remote(&state.http, &recognizer, wav, &heard).await?;
                if !part.is_empty() {
                    if !heard.is_empty() {
                        heard.push(' ');
                    }
                    heard.push_str(&part);
                }
            }
        }
        Source::Off => {}
    }
    Ok(heard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_server_falls_back_to_the_model_server() {
        let db = Db::open_memory().unwrap();
        db.set_meta(llm::LLM_BASE_URL, "http://localhost:11434/v1")
            .unwrap();
        db.set_meta(llm::LLM_API_KEY, "model-key").unwrap();
        let shared = recognizer(&db).unwrap();
        assert_eq!(shared.source, Source::Local);
        assert_eq!(shared.base, "http://localhost:11434/v1");
        assert_eq!(shared.key.as_deref(), Some("model-key"));
        db.set_meta(SPEECH_BASE_URL, "http://localhost:5092/v1")
            .unwrap();
        db.set_meta(SPEECH_SOURCE, "server").unwrap();
        let own = recognizer(&db).unwrap();
        assert_eq!(own.source, Source::Server);
        assert_eq!(own.base, "http://localhost:5092/v1");
        assert_eq!(
            own.key, None,
            "the model server's key is not sent to another host"
        );
    }

    /// Opens the real default microphone for two seconds and prints what arrives.
    /// `cargo test mic_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn mic_probe() {
        let device = pick_device("").expect("a microphone");
        let config = device.default_input_config().expect("a format");
        println!("device {:?} {:?}", device.name(), config);
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let stream = device
            .build_input_stream(
                &config.clone().into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = tx.send(data.to_vec());
                },
                |err| println!("stream error {err}"),
                None,
            )
            .expect("stream");
        stream.play().expect("play");
        let started = Instant::now();
        let (mut count, mut peak, mut nonzero) = (0_usize, 0_f32, 0_usize);
        while started.elapsed() < Duration::from_secs(2) {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(100)) {
                count += data.len();
                nonzero += data.iter().filter(|s| **s != 0.0).count();
                peak = data.iter().fold(peak, |p, s| p.max(s.abs()));
            }
        }
        println!("samples {count} nonzero {nonzero} peak {peak}");
    }

    #[test]
    fn wav_files_of_other_formats_are_read_as_16k_mono() {
        let mut stereo = Vec::new();
        for _ in 0..48_000 {
            stereo.extend_from_slice(&[1000_i16, 3000_i16]);
        }
        let mut wav = audio::wav_bytes(&stereo);
        // Rewrite the header as 48 kHz stereo.
        wav[22..24].copy_from_slice(&2_u16.to_le_bytes());
        wav[24..28].copy_from_slice(&48_000_u32.to_le_bytes());
        let samples = wav_samples(&wav).unwrap();
        assert!((samples.len() as i64 - 16_000).abs() <= 1);
        assert!((samples[100] - 2000.0 / 32768.0).abs() < 1e-4);
        let own = audio::wav_bytes(&[0, 16384, -16384]);
        assert_eq!(wav_samples(&own).unwrap(), vec![0.0, 0.5, -0.5]);
        assert!(wav_samples(b"not a wav file").is_err());
    }

    #[test]
    fn a_reply_that_rewrites_too_much_keeps_the_words_as_heard() {
        assert!((kept_share("mä meen kauppaan", "Mä meen kauppaan.") - 1.0).abs() < 1e-6);
        let heard = "no niin elikkä me sovittiin et julkasu siirretään";
        let light = "No niin, elikkä me sovittiin, et julkaisu siirretään.";
        assert!(kept_share(heard, light) >= Level::Improved.min_kept());
        let rewrite = "Sovimme, että julkaisua siirretään.";
        assert!(kept_share(heard, rewrite) < Level::Improved.min_kept());
        assert!(kept_share("", "anything") >= 1.0);
    }

    #[test]
    fn a_restarted_sentence_may_drop_its_first_try() {
        let heard = "What is the worst? Time. When is the worst time?";
        let fixed = "When is the worst time?";
        // Without corrections the guard keeps the words as heard at the quick level.
        assert_eq!(
            judge_reply(Level::Improved, heard, fixed, false, "").unwrap(),
            heard
        );
        assert_eq!(
            judge_reply(Level::Improved, heard, fixed, true, "").unwrap(),
            fixed
        );
        // Dropping words that are never said again is still refused.
        let invented = "When?";
        assert_eq!(
            judge_reply(Level::Proofread, heard, invented, true, "").unwrap(),
            heard
        );
    }

    #[test]
    fn a_paragraph_said_again_after_it_is_removed() {
        let heard = "What is the worst? Time.";
        let later = "When is the worst time?";
        assert_eq!(
            judge_reply(Level::Proofread, heard, "[restated]", true, later).unwrap(),
            ""
        );
        // The end said again is removed; the rest stays.
        let paragraph = "We ship on Friday. What is the worst? Time.";
        assert_eq!(
            judge_reply(
                Level::Proofread,
                paragraph,
                "We ship on Friday.",
                true,
                later
            )
            .unwrap(),
            "We ship on Friday."
        );
        // Something else said later is no reason to remove the paragraph.
        assert_eq!(
            judge_reply(
                Level::Proofread,
                heard,
                "[restated]",
                true,
                "Buy milk tomorrow."
            )
            .unwrap(),
            heard
        );
        // Without corrections an empty reply is an error, as before.
        assert!(judge_reply(Level::Proofread, heard, "", false, later).is_err());
    }

    #[test]
    fn a_chosen_language_is_named_to_the_chat_model() {
        let detect = polish_rules(Level::Improved, "");
        assert!(detect.starts_with(POLISH_IMPROVED) && detect.ends_with(POLISH_COMMON));
        assert!(!detect.contains("The text is in"));
        let finnish = polish_rules(Level::Proofread, "fi");
        assert!(finnish.starts_with(POLISH_PROOF));
        assert!(finnish.contains("The text is in Finnish; use correct Finnish words"));
        assert!(polish_rules(Level::Context, "ja").contains("the language with code \"ja\""));
    }

    #[test]
    fn the_level_comes_from_the_old_switch_until_one_is_saved() {
        let db = Db::open_memory().unwrap();
        assert_eq!(stored_level(&db).unwrap(), Level::Improved);
        db.set_meta(SPEECH_POLISH, "0").unwrap();
        assert_eq!(stored_level(&db).unwrap(), Level::Basic);
        db.set_meta(SPEECH_POLISH_LEVEL, "4").unwrap();
        assert_eq!(stored_level(&db).unwrap(), Level::Context);
        assert_eq!(Level::from_number(9), Level::Improved);
    }

    #[test]
    fn source_names_round_trip() {
        for source in [Source::Local, Source::Server, Source::Off] {
            assert_eq!(Source::parse(Some(source.as_str())), source);
        }
        assert_eq!(Source::parse(None), Source::Local);
    }
}
