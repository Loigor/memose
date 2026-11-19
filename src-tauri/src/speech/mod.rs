//! Recording and speech to text.
//!
//! One recording runs at a time. A thread owns the microphone, cuts the sound into
//! slices at pauses, and hands them to a task that turns each slice into text. The
//! windows hear about it through events: `speech-state`, `speech-level`,
//! `speech-chunk`, and `speech-done`.

pub mod audio;
pub mod engine;
pub mod permission;
mod polish;

pub use polish::{polish, stored_level, Level, PolishContext};

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
use crate::openai;
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
/// The user is told this long before the recording stops by itself.
const END_WARNING_SECONDS: u64 = 60;
/// Sound waiting for the recognizer is kept under this much, so a recognizer slower than
/// speech does not fill memory. Past it, live text stops.
const MAX_BACKLOG_SECONDS: usize = 120;
/// The model is dropped this long after the last recording, to give its memory back.
const ENGINE_IDLE: Duration = Duration::from_secs(90);
const SERVER_TIMEOUT: Duration = Duration::from_secs(120);
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
    let tail = previous
        .char_indices()
        .rev()
        .nth(199)
        .map_or(previous, |(at, _)| &previous[at..]);
    if !tail.trim().is_empty() {
        form = form.text("prompt", tail.to_string());
    }
    let key = recognizer.key.as_deref();
    let request = http
        .post(openai::api_url(&recognizer.base, "audio/transcriptions"))
        .timeout(SERVER_TIMEOUT)
        .multipart(form);
    let response = openai::with_key(request, key)
        .send()
        .await
        .map_err(|err| openai::unreachable(&err, "speech server"))?;
    if !response.status().is_success() {
        return Err(openai::failure(response, "speech server", key).await);
    }
    let body = response.text().await.unwrap_or_default();
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
    /// A model download runs, so a second one or a removal waits.
    pub downloading: AtomicBool,
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

/// Something the user should know while the recording goes on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoticeEvent {
    session_id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    session_id: String,
    note_id: Option<String>,
    purpose: Purpose,
    /// Markdown lines of the saved recording, one per file, when sound was kept.
    /// A long recording is saved in several files.
    audio: Vec<String>,
    /// Why the recording ended early or lost something, for the user to read.
    error: Option<String>,
}

enum Work {
    /// A piece of speech, its number, and the silence before it in ms.
    Slice(u32, Vec<f32>, u32),
    /// One full file of the kept sound. The recording goes on in the next file.
    Part(Vec<i16>),
    /// Capture ended. Holds the last file of the kept sound, and a capture error if any.
    End(Vec<i16>, Option<String>),
}

/// Sound handed to the recognizer and not yet turned into text, in samples.
#[derive(Default)]
struct Backlog(std::sync::atomic::AtomicUsize);

impl Backlog {
    /// Counts `len` samples in, unless the backlog would then pass `limit`.
    fn admit(&self, len: usize, limit: usize) -> bool {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |queued| {
                (queued + len <= limit).then_some(queued + len)
            })
            .is_ok()
    }

    /// Holds `len` samples in the backlog until the returned guard is dropped.
    fn taken(&self, len: usize) -> Queued<'_> {
        Queued { backlog: self, len }
    }
}

/// A slice the recognizer works on. It leaves the backlog when dropped.
struct Queued<'a> {
    backlog: &'a Backlog,
    len: usize,
}

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.backlog.0.fetch_sub(self.len, Ordering::SeqCst);
    }
}

/// What `start` needs to know.
pub struct StartOptions {
    pub purpose: Purpose,
    pub note_id: Option<String>,
    /// Label of the window that started the recording.
    pub window: String,
    pub keep_audio: bool,
    /// Samples in one saved file. A longer recording goes on in a new file.
    pub part_samples: usize,
    pub device: String,
    pub recognizer: Recognizer,
}

/// What the microphone thread needs to know.
struct Capture {
    plan: ChunkPlan,
    /// Samples per saved file, when the sound is kept.
    keep: Option<usize>,
    /// Slices go to a recognizer.
    slices: bool,
}

fn lock_active(state: &AppState) -> std::sync::MutexGuard<'_, Option<Active>> {
    state
        .speech
        .active
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sends an event only to the window the recording writes into: the level and the words
/// arrive many times a second, and no other window uses them.
fn to_recorder<S: Serialize + Clone>(app: &AppHandle, name: &str, payload: S) {
    if let Some(window) = recording_window(&app.state::<AppState>()) {
        let _ = app.emit_to(window.as_str(), name, payload);
    }
}

fn notice(app: &AppHandle, id: &str, message: String) {
    to_recorder(
        app,
        "speech-notice",
        NoticeEvent {
            session_id: id.to_string(),
            message,
        },
    );
}

/// Label of the window a running recording writes into.
pub fn recording_window(state: &AppState) -> Option<String> {
    lock_active(state)
        .as_ref()
        .map(|active| active.window.clone())
}

pub fn current(state: &AppState) -> Option<StateEvent> {
    lock_active(state).as_ref().map(|active| StateEvent {
        recording: true,
        session_id: active.id.clone(),
        note_id: active.note_id.clone(),
        purpose: active.purpose,
    })
}

/// Asks the running recording to end. Its text and its `speech-done` event still arrive.
pub fn stop(state: &AppState) {
    if let Some(active) = lock_active(state).as_ref() {
        active.stop.store(true, Ordering::SeqCst);
    }
}

/// Starts a recording and returns its id once the microphone is open.
pub fn start(app: &AppHandle, options: StartOptions) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let id = uuid::Uuid::new_v4().to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));
    // The slot is taken now and the lock let go, so windows asking for the recording state
    // do not wait while the microphone opens.
    {
        let mut active = lock_active(&state);
        if active.is_some() {
            return Err(AppError::Message("a recording is already running".into()));
        }
        *active = Some(Active {
            id: id.clone(),
            note_id: options.note_id.clone(),
            purpose: options.purpose,
            window: options.window.clone(),
            stop: stop_flag.clone(),
        });
    }
    let give_up = |message: String| {
        let mut active = lock_active(&state);
        if active.as_ref().is_some_and(|held| held.id == id) {
            *active = None;
        }
        stop_flag.store(true, Ordering::SeqCst);
        AppError::Message(message)
    };
    let (work_tx, work_rx) = tokio::sync::mpsc::unbounded_channel::<Work>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let setup = Capture {
        plan: match options.purpose {
            Purpose::Memo => ChunkPlan::DICTATION,
            Purpose::Prompt => ChunkPlan::PROMPT,
        },
        keep: (options.keep_audio && options.purpose == Purpose::Memo)
            .then_some(options.part_samples.max(1)),
        slices: options.recognizer.source != Source::Off,
    };
    let backlog = Arc::new(Backlog::default());
    {
        let app = app.clone();
        let id = id.clone();
        let stop_flag = stop_flag.clone();
        let device = options.device.clone();
        let backlog = backlog.clone();
        std::thread::Builder::new()
            .name("memose-mic".into())
            .spawn(move || {
                capture(
                    &app, &id, &device, &setup, &backlog, &stop_flag, &work_tx, &ready_tx,
                );
            })
            .map_err(|err| give_up(format!("could not start recording: {err}")))?;
    }
    match ready_rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => {}
        Ok(Err(message)) => return Err(give_up(message)),
        Err(_) => return Err(give_up("the microphone did not start".into())),
    }

    let event = StateEvent {
        recording: true,
        session_id: id.clone(),
        note_id: options.note_id.clone(),
        purpose: options.purpose,
    };
    state.speech.uses.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("speech-state", &event);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        work(app, event, options.recognizer, backlog, work_rx).await;
    });
    Ok(id)
}

/// Collects the kept sound and hands it out in files of at most `limit` samples.
struct Parts {
    limit: usize,
    current: Vec<i16>,
}

impl Parts {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            current: Vec::new(),
        }
    }

    /// Adds sound. Returns the files that became full.
    fn push(&mut self, pcm: &[i16]) -> Vec<Vec<i16>> {
        self.current.extend_from_slice(pcm);
        let mut full = Vec::new();
        while self.current.len() >= self.limit {
            let rest = self.current.split_off(self.limit);
            full.push(std::mem::replace(&mut self.current, rest));
        }
        full
    }
}

fn behind_message(kept: bool) -> String {
    let minutes = MAX_BACKLOG_SECONDS / 60;
    if kept {
        format!(
            "Speech recognition is more than {minutes} minutes behind, so live text stops here. \
             The recording goes on. Re-analyze it afterwards to get the rest as text."
        )
    } else {
        format!(
            "Speech recognition fell more than {minutes} minutes behind, so the recording stopped. \
             The text heard so far is kept."
        )
    }
}

/// Runs on its own thread: owns the microphone until the stop flag is set.
#[allow(clippy::too_many_arguments)]
fn capture(
    app: &AppHandle,
    id: &str,
    device: &str,
    setup: &Capture,
    backlog: &Backlog,
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
    let mut chunker = Chunker::new(setup.plan);
    let mut mono = Vec::new();
    let mut parts = setup.keep.map(Parts::new);
    let backlog_limit = audio::RATE as usize * MAX_BACKLOG_SECONDS;
    // Live text stopped because the recognizer fell behind. Kept sound still goes on.
    let mut behind = false;
    let mut warned_end = false;
    let mut seq = 0_u32;
    let started = Instant::now();
    let mut last_level = Instant::now();
    let mut error = None;
    // A microphone the system will not share delivers exact zeros instead of failing.
    let mut any_sound = false;
    'capture: loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let elapsed = started.elapsed().as_secs();
        if elapsed >= MAX_SECONDS {
            error = Some(format!(
                "The recording stopped by itself after {} minutes. Start a new one to go on.",
                MAX_SECONDS / 60
            ));
            break;
        }
        if !warned_end && elapsed + END_WARNING_SECONDS >= MAX_SECONDS {
            warned_end = true;
            notice(
                app,
                id,
                format!(
                    "The recording stops by itself in a minute, at {} minutes.",
                    MAX_SECONDS / 60
                ),
            );
        }
        if !any_sound && started.elapsed() >= SILENT_DEVICE {
            error = Some(silent_device_message());
            // Silence is not worth keeping as a recording.
            parts = None;
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
        // A full file is saved now and the recording goes on in the next one, so each file
        // stays under the attachment and upload limits.
        if let Some(parts) = parts.as_mut() {
            for part in parts.push(&audio::to_pcm(&mono)) {
                let _ = work.send(Work::Part(part));
            }
        }
        for slice in chunker.push(&mono) {
            let pause = chunker.take_pause();
            if !setup.slices || behind {
                continue;
            }
            if !backlog.admit(slice.len(), backlog_limit) {
                behind = true;
                if parts.is_none() {
                    // Nothing else of the recording would be kept, so it ends here.
                    error = Some(behind_message(false));
                    break 'capture;
                }
                notice(app, id, behind_message(true));
                continue;
            }
            let _ = work.send(Work::Slice(seq, slice, pause));
            seq += 1;
        }
        if last_level.elapsed() >= Duration::from_millis(120) {
            last_level = Instant::now();
            to_recorder(
                app,
                "speech-level",
                LevelEvent {
                    session_id: id.to_string(),
                    level: (chunker.take_level() * 6.0).min(1.0),
                },
            );
        }
    }
    drop(stream);
    if setup.slices && !behind {
        if let Some(slice) = chunker.finish() {
            let pause = chunker.take_pause();
            // The last slice is short and nothing follows it, so it is always taken.
            backlog.admit(slice.len(), usize::MAX);
            let _ = work.send(Work::Slice(seq, slice, pause));
        }
    }
    if behind && error.is_none() {
        error = Some(
            "Live text stopped early because speech recognition fell behind. \
             Re-analyze the recording to get the rest as text."
                .into(),
        );
    }
    let last = parts.map(|parts| parts.current).unwrap_or_default();
    let _ = work.send(Work::End(last, error));
}

/// Name of file `number` (from 1) of a recording.
fn part_name(session_id: &str, number: usize) -> String {
    let short = &session_id[..8.min(session_id.len())];
    if number <= 1 {
        format!("voice-{short}.wav")
    } else {
        format!("voice-{short}-{number}.wav")
    }
}

/// Saves one file of a recording with the words heard while it was recorded.
/// Returns its Markdown line.
fn save_part(state: &AppState, name: &str, pcm: &[i16], heard: &str) -> Result<String, AppError> {
    let line = crate::media::save_named(
        &state.media_dir,
        &audio::wav_bytes(pcm),
        Some(name),
        Some("audio/wav"),
    )?;
    if let Some(media) = crate::media::parse_media_token(&line) {
        let _ = state.db.save_recording(&media.name, heard);
    }
    Ok(line)
}

/// Turns slices into text in order, saves the kept sound file by file, then closes the recording.
async fn work(
    app: AppHandle,
    event: StateEvent,
    recognizer: Recognizer,
    backlog: Arc<Backlog>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Work>,
) {
    let state = app.state::<AppState>();
    let engine = state.speech.engine.clone();
    let http = state.http.clone();
    let mut heard = String::new();
    let mut failure: Option<String> = None;
    let mut audio_lines = Vec::new();
    let mut parts_saved = 0_usize;
    // Where the words of the file being recorded start in `heard`.
    let mut part_from = 0_usize;
    let mut save = |pcm: &[i16], heard: &str, failure: &mut Option<String>| {
        parts_saved += 1;
        let words = heard[part_from..].trim();
        part_from = heard.len();
        match save_part(
            &state,
            &part_name(&event.session_id, parts_saved),
            pcm,
            words,
        ) {
            Ok(line) => {
                audio_lines.push(line);
                true
            }
            Err(err) => {
                failure.get_or_insert(format!("the recording was not saved: {err}"));
                false
            }
        }
    };

    if recognizer.source == Source::Local {
        let dir = engine_dir(&app);
        let engine = engine.clone();
        let model = recognizer.local_model;
        let language = recognizer.language.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            let mut slot = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            ensure_engine(&mut slot, &dir?, model, &language).map(|_| ())
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
                let _queued = backlog.taken(samples.len());
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
                        to_recorder(
                            &app,
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
            Work::Part(pcm) => {
                if !save(&pcm, &heard, &mut failure) {
                    // The next file would fail the same way, so the recording ends here.
                    stop(&state);
                }
            }
            Work::End(pcm, capture_error) => {
                if failure.is_none() {
                    failure = capture_error;
                }
                if !pcm.is_empty() {
                    save(&pcm, &heard, &mut failure);
                }
                break;
            }
        }
    }

    *lock_active(&state) = None;
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
            audio: audio_lines,
            error: failure,
        },
    );

    release_later(&app).await;
}

/// The loaded model, loaded first when none is. A model or language picked since the last
/// recording replaces the loaded one, and the old one is freed before the new one loads.
fn ensure_engine<'a>(
    slot: &'a mut Option<Engine>,
    dir: &std::path::Path,
    model: engine::ModelId,
    language: &str,
) -> Result<&'a mut Engine, AppError> {
    if !slot
        .as_ref()
        .is_some_and(|loaded| loaded.is(model, language))
    {
        *slot = None;
        *slot = Some(Engine::load(dir, model, language)?);
    }
    slot.as_mut()
        .ok_or_else(|| AppError::Message("the speech model is not loaded".into()))
}

/// Gives the model's memory back unless it is used again soon.
async fn release_later(app: &AppHandle) {
    let state = app.state::<AppState>();
    let engine = state.speech.engine.clone();
    let uses = state.speech.uses.clone();
    let seen = uses.load(Ordering::SeqCst);
    tokio::time::sleep(ENGINE_IDLE).await;
    let state = app.state::<AppState>();
    let idle = uses.load(Ordering::SeqCst) == seen && lock_active(&state).is_none();
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
                let loaded = ensure_engine(&mut slot, &dir, model, &language)?;
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
    fn kept_sound_rolls_over_into_files_of_the_part_size() {
        let mut parts = Parts::new(10);
        assert!(parts.push(&[1; 6]).is_empty());
        let full = parts.push(&[2; 17]);
        assert_eq!(full.len(), 2);
        assert_eq!(full[0], [1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
        assert_eq!(full[1], [2; 10]);
        assert_eq!(parts.current, [2; 3], "the rest starts the next file");
        let total: usize = full.iter().map(Vec::len).sum::<usize>() + parts.current.len();
        assert_eq!(total, 23, "no sound is lost at a boundary");
    }

    #[test]
    fn the_backlog_refuses_sound_past_its_limit_until_slices_are_done() {
        let backlog = Backlog::default();
        assert!(backlog.admit(60, 100));
        assert!(!backlog.admit(50, 100));
        {
            let _working = backlog.taken(60);
            assert!(!backlog.admit(50, 100));
        }
        assert!(backlog.admit(50, 100), "a finished slice makes room");
        assert!(backlog.admit(50, 100));
        assert!(!backlog.admit(1, 100));
    }

    #[test]
    fn files_of_one_recording_share_its_name() {
        let id = "0123abcd-ffff-4444-8888-000000000000";
        assert_eq!(part_name(id, 1), "voice-0123abcd.wav");
        assert_eq!(part_name(id, 2), "voice-0123abcd-2.wav");
        assert_eq!(part_name(id, 3), "voice-0123abcd-3.wav");
    }

    #[test]
    fn source_names_round_trip() {
        for source in [Source::Local, Source::Server, Source::Off] {
            assert_eq!(Source::parse(Some(source.as_str())), source);
        }
        assert_eq!(Source::parse(None), Source::Local);
    }
}
