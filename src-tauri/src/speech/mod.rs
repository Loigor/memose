//! Recording and speech to text.
//!
//! One recording runs at a time. A thread owns the microphone, cuts the sound into
//! slices at pauses, and hands them to a task that turns each slice into text. The
//! windows hear about it through events: `speech-state`, `speech-level`,
//! `speech-chunk`, and `speech-done`.

pub mod audio;
pub mod engine;

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
pub const SPEECH_DEVICE: &str = "speech_device";
pub const SPEECH_KEEP_AUDIO: &str = "speech_keep_audio";
pub const SPEECH_POLISH: &str = "speech_polish";

/// A recording stops by itself after this long.
const MAX_SECONDS: u64 = 30 * 60;
/// The model is dropped this long after the last recording, to give its memory back.
const ENGINE_IDLE: Duration = Duration::from_secs(90);
const SERVER_TIMEOUT: Duration = Duration::from_secs(90);
const POLISH_TIMEOUT: Duration = Duration::from_secs(60);
const POLISH_RULES: &str = "You clean up text that a user is dictating into a note. You get the note text before the cursor, the note text after it, and the dictated text as a speech recognizer heard it. Rewrite only the dictated text: fix punctuation, capitalization, and words that were clearly misheard, using the note to pick the right words and the right form (continue a list with list items, for example). Apply spoken corrections such as \"no, I mean\" or \"scratch that\". Keep the language and the meaning. Do not add content, do not answer questions in it, and do not repeat the note text. Reply with the cleaned dictated text only.";

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

/// Lets the chat model tidy dictated text, using the note around the cursor.
pub async fn polish(
    http: &reqwest::Client,
    db: &Db,
    before: &str,
    after: &str,
    dictated: &str,
) -> Result<String, AppError> {
    let base = db
        .get_meta(llm::LLM_BASE_URL)?
        .filter(|url| !url.is_empty())
        .ok_or_else(|| AppError::Message("model server URL is not set".into()))?;
    let model = db
        .get_meta(llm::LLM_MODEL)?
        .filter(|model| !model.is_empty())
        .ok_or_else(|| AppError::Message("model is not set".into()))?;
    let key = db.get_meta(llm::LLM_API_KEY)?;
    let user = format!(
        "<before>\n{before}\n</before>\n\n<after>\n{after}\n</after>\n\n<dictated>\n{dictated}\n</dictated>"
    );
    let raw = llm::complete(
        http,
        &base,
        key.as_deref(),
        &model,
        POLISH_RULES,
        &user,
        POLISH_TIMEOUT,
    )
    .await?;
    let cleaned = llm::clean_answer(&raw, "");
    let cleaned = cleaned
        .trim()
        .trim_start_matches("<dictated>")
        .trim_end_matches("</dictated>")
        .trim();
    if cleaned.is_empty() {
        return Err(AppError::Message("the model returned no text".into()));
    }
    Ok(cleaned.to_string())
}

/// The recording that is running now.
pub struct Active {
    pub id: String,
    pub note_id: Option<String>,
    pub purpose: Purpose,
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
    Slice(u32, Vec<f32>),
    /// Capture ended. Holds the whole recording when it is to be kept, and a capture error if any.
    End(Vec<i16>, Option<String>),
}

/// What `start` needs to know.
pub struct StartOptions {
    pub purpose: Purpose,
    pub note_id: Option<String>,
    pub keep_audio: bool,
    pub device: String,
    pub recognizer: Recognizer,
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
    loop {
        if stop.load(Ordering::SeqCst) || started.elapsed().as_secs() >= MAX_SECONDS {
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
        mono.clear();
        resampler.push(&data, &mut mono);
        if keep && all.len() < keep_cap {
            all.extend(audio::to_pcm(&mono));
        }
        for slice in chunker.push(&mono) {
            if slices {
                let _ = work.send(Work::Slice(seq, slice));
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
            let _ = work.send(Work::Slice(seq, slice));
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
        let loaded = tokio::task::spawn_blocking(move || {
            let mut slot = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slot.is_none() {
                *slot = Some(Engine::load(&dir?)?);
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
            Work::Slice(seq, samples) => {
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
                        Ok(line) => audio_line = Some(line),
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

    // Give the model's memory back unless another recording starts soon.
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
    fn source_names_round_trip() {
        for source in [Source::Local, Source::Server, Source::Off] {
            assert_eq!(Source::parse(Some(source.as_str())), source);
        }
        assert_eq!(Source::parse(None), Source::Local);
    }
}
