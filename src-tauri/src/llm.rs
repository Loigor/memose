//! Chat model edits through an OpenAI-compatible server.
//!
//! The base URL carries the version prefix, such as `https://api.openai.com/v1`
//! or `http://localhost:11434/v1`. Paths are joined after it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::notes::Db;

pub const LLM_ENABLED: &str = "llm_enabled";
pub const LLM_BASE_URL: &str = "llm_base_url";
pub const LLM_API_KEY: &str = "llm_api_key";
pub const LLM_MODEL: &str = "llm_model";
pub const LLM_PRESETS: &str = "llm_presets";
/// Host the user allowed to receive offline-only memos.
pub const LLM_PRIVATE_OK_HOST: &str = "llm_private_ok_host";

/// Local models on a CPU can take minutes for a long memo.
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
const MODELS_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PRESETS: usize = 12;

const ROLE: &str = "You are an assistant built into a note-taking app. The user is looking at a note and sends a request. Reply in the language of the request unless it asks for another one.";
const ASK_RULES: &str = "Answer the request directly and briefly. Use the note as context. If the note does not hold the answer, use your general knowledge. Do not repeat or rewrite the note.";
const CLASSIFY_RULES: &str = "A user of a note-taking app sends a request about their note. Decide whether the request asks to change the text of the note itself.\nYES: rewrite, fix, correct, translate, reformat, shorten, extend, sort, reorder, or add or remove something in the note.\nNO: a question, a count, an explanation, a summary, an opinion, a list of items taken from the note, or writing something new.\nReply with exactly one word: YES or NO.";
/// Earlier prompts of the same memo sent along as chat history.
const HISTORY_TURNS: usize = 6;
/// Longest earlier reply kept in the history, in characters.
const HISTORY_REPLY_CHARS: usize = 1500;
const HISTORY_RULES: &str = "Earlier requests in this chat and your replies come first, for reference. The note may have changed since then. The last message holds the note as it is now and the request to answer.";
const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(30);

/// The part of the note a request can replace.
fn subject(selected: bool) -> &'static str {
    if selected {
        "selected part"
    } else {
        "note"
    }
}

fn system_prompt(mode: Mode, selected: bool) -> String {
    let what = subject(selected);
    let rules = match mode {
        Mode::Ask => ASK_RULES.to_string(),
        Mode::Edit => format!(
            "The request asks you to change the {what}. Reply with the complete revised {what} and nothing else: no introduction, no explanation, no code fence. Keep the markdown formatting, and keep everything the request does not ask to change."
        ),
        // `Auto` is settled by `wants_edit` before the prompt is built.
        Mode::Auto => ASK_RULES.to_string(),
    };
    format!("{ROLE}\n{rules}")
}

/// The note first and the request last, so the model answers the request instead of continuing the note.
fn user_prompt(instruction: &str, text: &str, context: Option<&str>) -> String {
    let request = instruction.trim();
    match context {
        Some(note) => format!(
            "<note>\n{note}\n</note>\n\n<selected>\n{text}\n</selected>\n\nThe request is about the selected part of the note.\n\nRequest: {request}"
        ),
        None => format!("<note>\n{text}\n</note>\n\nRequest: {request}"),
    }
}

/// What a prompt is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// The model decides from the instruction.
    #[default]
    Auto,
    /// A question about the memo. The memo is not changed.
    Ask,
    /// A rewrite of the memo, reviewed as a diff.
    Edit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyKind {
    Answer,
    Edit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub kind: ReplyKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub instruction: String,
    #[serde(default)]
    pub mode: Mode,
}

/// One prompt in a memo's chat, with its state and result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    pub id: String,
    pub note_id: String,
    /// Memo title when the prompt was sent, for the running list.
    pub title: String,
    pub instruction: String,
    pub mode: Mode,
    /// `running`, `answer`, `edit`, `applied`, `dismissed`, `error`, or `cancelled`.
    pub status: String,
    /// The answer, the proposed memo text, or the error.
    pub text: String,
    /// Memo text the prompt is about: the whole memo or the selected lines. An edit replaces it.
    pub source: String,
    /// First and last memo line of a selection, counted from 1. Empty for the whole memo.
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    /// The prompt is about a selection, even when its lines could not be found.
    pub selection: bool,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// Ids of the changes the user took from a proposed edit, once it is applied.
    pub accepted: Vec<u32>,
}

pub const RUNNING: &str = "running";
/// Finished prompts kept per memo.
pub const CHAT_KEEP: usize = 30;

pub fn default_presets() -> Vec<Preset> {
    let preset = |name: &str, mode: Mode, instruction: &str| Preset {
        name: name.into(),
        instruction: instruction.into(),
        mode,
    };
    vec![
        preset(
            "Summarize",
            Mode::Ask,
            "Summarize the text in a few short bullet points. Use the language of the text.",
        ),
        preset(
            "Action items",
            Mode::Ask,
            "List the action items from the text as a markdown task list (`- [ ] item`). Name the owner and date when the text gives them. Use the language of the text.",
        ),
        preset(
            "Clean up wording",
            Mode::Edit,
            "Fix spelling, grammar, and punctuation. Keep the meaning, the structure, and the language. Change as little as possible.",
        ),
    ]
}

pub fn presets(db: &Db) -> Result<Vec<Preset>, AppError> {
    let stored = db
        .get_meta(LLM_PRESETS)?
        .and_then(|raw| serde_json::from_str::<Vec<Preset>>(&raw).ok());
    Ok(stored.unwrap_or_else(default_presets))
}

pub fn store_presets(db: &Db, presets: &[Preset]) -> Result<(), AppError> {
    let clean: Vec<Preset> = presets
        .iter()
        .map(|preset| Preset {
            name: preset.name.trim().chars().take(40).collect(),
            instruction: preset.instruction.trim().chars().take(2000).collect(),
            mode: preset.mode,
        })
        .filter(|preset| !preset.name.is_empty() && !preset.instruction.is_empty())
        .take(MAX_PRESETS)
        .collect();
    let raw = serde_json::to_string(&clean)
        .map_err(|err| AppError::Message(format!("could not store presets: {err}")))?;
    db.set_meta(LLM_PRESETS, &raw)
}

/// Trims the URL and checks the scheme. Empty stays empty.
pub fn clean_base(url: &str) -> Result<String, AppError> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(AppError::Message(
            "model server URL must start with http:// or https://".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Joins a path such as `/chat/completions` after the versioned base URL.
pub fn api_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim().trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Ollama's own API sits beside its `/v1` compatibility prefix.
pub fn ollama_root(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string()
}

/// Host part of the base URL, without port, user info, or brackets.
pub fn host_of(base: &str) -> String {
    let rest = base
        .trim()
        .split_once("://")
        .map_or(base.trim(), |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    host.to_ascii_lowercase()
}

/// True when the server runs on this computer, so text does not leave it.
pub fn is_local(base: &str) -> bool {
    let host = host_of(base);
    if host == "localhost" {
        return true;
    }
    // Only a real loopback address counts. A name such as `127.example.com` is a remote host.
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

fn with_key(request: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

/// Error text from a failed call. The body is cut short and never holds the key.
async fn failure(response: reqwest::Response) -> AppError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            let error = value.get("error")?;
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
                .map(str::to_string)
        })
        .unwrap_or(body);
    let detail: String = detail.trim().chars().take(300).collect();
    if detail.is_empty() {
        AppError::Message(format!("model server returned {status}"))
    } else {
        AppError::Message(format!("model server returned {status}: {detail}"))
    }
}

fn unreachable(err: &reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::Message("the model server took too long to answer".into())
    } else if err.is_connect() {
        AppError::Message("could not reach the model server".into())
    } else {
        AppError::Message("the request to the model server failed".into())
    }
}

/// One system message and one user message, for helpers outside the memo chat.
/// Returns the model's text as it came.
pub async fn complete(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let body = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let request = http
        .post(api_url(base, "chat/completions"))
        .timeout(timeout)
        .json(&body);
    let response = with_key(request, key)
        .send()
        .await
        .map_err(|err| unreachable(&err))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| AppError::Message("the model server sent an unreadable answer".into()))?;
    Ok(payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

/// Asks the model whether a request wants the note changed. One short call without the note.
/// It sets no token limit or temperature: reasoning models need room to think before the word,
/// and some hosted models reject those fields.
/// Any failure or unclear reply counts as no, so an `Auto` prompt never replaces the memo by accident.
async fn wants_edit(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    instruction: &str,
) -> bool {
    let body = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": CLASSIFY_RULES },
            { "role": "user", "content": format!("Request: {}\n\nDoes it ask to change the note's text? YES or NO.", instruction.trim()) },
        ],
    });
    let request = http
        .post(api_url(base, "chat/completions"))
        .timeout(CLASSIFY_TIMEOUT)
        .json(&body);
    let Ok(response) = with_key(request, key).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(payload) = response.json::<Value>().await else {
        return false;
    };
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .is_some_and(says_yes)
}

fn says_yes(reply: &str) -> bool {
    let word: String = clean_answer(reply, "")
        .chars()
        .skip_while(|ch| !ch.is_ascii_alphabetic())
        .take_while(char::is_ascii_alphabetic)
        .collect();
    word.eq_ignore_ascii_case("yes")
}

/// One earlier exchange: the request and what the model replied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub request: String,
    pub reply: String,
}

/// The finished prompts of a memo's chat as history: the newest few, oldest first.
/// A proposed edit is noted in one line, because the note in the next message already shows its outcome.
pub fn history(log: &[ChatEntry]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = log
        .iter()
        .rev()
        .filter_map(|entry| {
            let reply = match entry.status.as_str() {
                "answer" => {
                    let mut text: String = entry.text.chars().take(HISTORY_REPLY_CHARS).collect();
                    if entry.text.chars().count() > HISTORY_REPLY_CHARS {
                        text.push('…');
                    }
                    text
                }
                "applied" => "(I proposed a revised text and the user applied it.)".to_string(),
                "edit" | "dismissed" => {
                    "(I proposed a revised text. The user has not applied it.)".to_string()
                }
                _ => return None,
            };
            Some(Turn {
                request: entry.instruction.clone(),
                reply,
            })
        })
        .take(HISTORY_TURNS)
        .collect();
    turns.reverse();
    turns
}

fn messages(
    mode: Mode,
    instruction: &str,
    text: &str,
    context: Option<&str>,
    history: &[Turn],
) -> Vec<Value> {
    let mut system = system_prompt(mode, context.is_some());
    if !history.is_empty() {
        system = format!("{system}\n{HISTORY_RULES}");
    }
    let mut out = vec![json!({ "role": "system", "content": system })];
    for turn in history {
        out.push(json!({ "role": "user", "content": format!("Request: {}", turn.request) }));
        out.push(json!({ "role": "assistant", "content": turn.reply }));
    }
    out.push(json!({ "role": "user", "content": user_prompt(instruction, text, context) }));
    out
}

/// One prompt. `Auto` first asks the model whether the request is an edit.
/// `text` is what the request is about: the whole note, or the selected part with the whole note as `context`.
#[allow(clippy::too_many_arguments)]
pub async fn ask(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    mode: Mode,
    instruction: &str,
    text: &str,
    context: Option<&str>,
    history: &[Turn],
) -> Result<Reply, AppError> {
    let mode = match mode {
        Mode::Auto if wants_edit(http, base, key, model, instruction).await => Mode::Edit,
        Mode::Auto => Mode::Ask,
        fixed => fixed,
    };
    let body = json!({
        "model": model,
        "stream": false,
        "messages": messages(mode, instruction, text, context, history),
    });
    let request = http
        .post(api_url(base, "chat/completions"))
        .timeout(CHAT_TIMEOUT)
        .json(&body);
    let response = with_key(request, key)
        .send()
        .await
        .map_err(|err| unreachable(&err))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| AppError::Message("the model server sent an unreadable answer".into()))?;
    let raw = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reply = read_reply(mode, raw, text);
    if reply.text.is_empty() {
        return Err(AppError::Message("the model returned no text".into()));
    }
    Ok(reply)
}

/// Sorts the model's text into an answer or an edit. `Auto` is settled before this and counts as an answer.
pub fn read_reply(mode: Mode, raw: &str, source: &str) -> Reply {
    let kind = if mode == Mode::Edit {
        ReplyKind::Edit
    } else {
        ReplyKind::Answer
    };
    Reply {
        kind,
        text: clean_answer(raw, source),
    }
}

/// Removes a leading reasoning block and a code fence the model wrapped around the whole answer.
pub fn clean_answer(raw: &str, source: &str) -> String {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix("<think>") {
        if let Some((_, after)) = rest.split_once("</think>") {
            text = after.trim();
        }
    }
    if !source.trim_start().starts_with("```") {
        if let Some(inner) = unwrap_fence(text) {
            text = inner;
        }
    }
    text.trim_matches('\n').trim_end().to_string()
}

fn unwrap_fence(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("```")?;
    let (info, body) = rest.split_once('\n')?;
    if info.contains('`') {
        return None;
    }
    let inner = body.trim_end().strip_suffix("```")?;
    if inner
        .lines()
        .any(|line| line.trim_start().starts_with("```"))
    {
        return None;
    }
    Some(inner.trim_end_matches('\n'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<String>,
    /// The server is Ollama, so missing models can be pulled by name.
    pub ollama: bool,
}

/// Model ids from `GET {base}/models`, plus whether the server is Ollama.
pub async fn list_models(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
) -> Result<ModelList, AppError> {
    let request = http.get(api_url(base, "models")).timeout(MODELS_TIMEOUT);
    let response = with_key(request, key)
        .send()
        .await
        .map_err(|err| unreachable(&err))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| AppError::Message("the model server sent an unreadable answer".into()))?;
    let models = parse_models(&payload);
    let version = format!("{}/api/version", ollama_root(base));
    let ollama = match http.get(version).timeout(MODELS_TIMEOUT).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<Value>()
            .await
            .is_ok_and(|value| value.get("version").is_some()),
        _ => false,
    };
    Ok(ModelList { models, ollama })
}

pub fn parse_models(payload: &Value) -> Vec<String> {
    let items = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(Value::as_array);
    let mut models: Vec<String> = items
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
        })
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_join_after_the_versioned_base() {
        assert_eq!(
            api_url("https://api.openai.com/v1", "/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            api_url("https://api.groq.com/openai/v1/", "models"),
            "https://api.groq.com/openai/v1/models"
        );
        assert_eq!(
            api_url("http://localhost:11434/v1", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn ollama_root_drops_the_compatibility_prefix() {
        assert_eq!(
            ollama_root("http://localhost:11434/v1/"),
            "http://localhost:11434"
        );
        assert_eq!(ollama_root("http://box:11434"), "http://box:11434");
    }

    #[test]
    fn loopback_hosts_are_local() {
        assert!(is_local("http://localhost:11434/v1"));
        assert!(is_local("http://127.0.0.1:1234/v1"));
        assert!(is_local("http://[::1]:8080/v1"));
        assert!(!is_local("https://api.openai.com/v1"));
        assert!(!is_local("https://localhost.example.com/v1"));
        assert!(!is_local("https://127.example.com/v1"));
        assert!(!is_local("https://127.0.0.1.nip.io/v1"));
        assert!(is_local("http://0.0.0.0:8000/v1"));
        assert_eq!(
            host_of("https://user:pw@Api.Groq.com:443/openai/v1"),
            "api.groq.com"
        );
    }

    #[test]
    fn base_url_needs_a_scheme() {
        assert_eq!(clean_base("  ").unwrap(), "");
        assert_eq!(
            clean_base("http://localhost:11434/v1/").unwrap(),
            "http://localhost:11434/v1"
        );
        assert!(clean_base("localhost:11434").is_err());
    }

    #[test]
    fn answer_loses_reasoning_and_an_outer_fence() {
        assert_eq!(
            clean_answer("<think>hmm</think>\n\nHello there", "hello"),
            "Hello there"
        );
        assert_eq!(
            clean_answer("```markdown\n- one\n- two\n```", "one two"),
            "- one\n- two"
        );
    }

    #[test]
    fn answer_keeps_fences_that_belong_to_the_text() {
        let two = "```js\na\n```\ntext\n```js\nb\n```";
        assert_eq!(clean_answer(two, "plain"), two);
        let code = "```js\nlet a = 1;\n```";
        assert_eq!(clean_answer(code, "```js\nvar a = 1\n```"), code);
    }

    fn entry(instruction: &str, status: &str, text: &str) -> ChatEntry {
        ChatEntry {
            id: instruction.into(),
            note_id: "n".into(),
            title: String::new(),
            instruction: instruction.into(),
            mode: Mode::Auto,
            status: status.into(),
            text: text.into(),
            source: "note".into(),
            line_start: None,
            line_end: None,
            selection: false,
            started_at: 0,
            finished_at: Some(1),
            accepted: Vec::new(),
        }
    }

    #[test]
    fn earlier_answers_are_sent_as_history_before_the_note() {
        let log = vec![
            entry("How many tasks?", "answer", "Three."),
            entry("Broken", "error", "timeout"),
            entry("Fix typos", "applied", "the whole note"),
            entry("Still going", RUNNING, ""),
        ];
        let turns = history(&log);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].request, "How many tasks?");
        assert_eq!(turns[0].reply, "Three.");
        assert!(turns[1].reply.contains("applied"));
        assert!(!turns[1].reply.contains("the whole note"));
        let sent = messages(Mode::Ask, "And how many are done?", "- a", None, &turns);
        assert_eq!(sent.len(), 6);
        assert!(sent[0]["content"]
            .as_str()
            .unwrap()
            .contains("Earlier requests"));
        assert_eq!(sent[1]["content"], "Request: How many tasks?");
        assert_eq!(sent[2]["role"], "assistant");
        assert!(sent[5]["content"]
            .as_str()
            .unwrap()
            .ends_with("Request: And how many are done?"));
        assert_eq!(messages(Mode::Ask, "q", "n", None, &[]).len(), 2);
    }

    #[test]
    fn history_keeps_the_newest_turns_and_cuts_long_replies() {
        let log: Vec<ChatEntry> = (0..10)
            .map(|i| entry(&format!("q{i}"), "answer", &"x".repeat(4000)))
            .collect();
        let turns = history(&log);
        assert_eq!(turns.len(), HISTORY_TURNS);
        assert_eq!(turns[0].request, "q4");
        assert_eq!(turns[5].request, "q9");
        assert_eq!(turns[0].reply.chars().count(), HISTORY_REPLY_CHARS + 1);
    }

    #[test]
    fn only_a_clear_yes_makes_an_auto_prompt_an_edit() {
        assert!(says_yes("YES"));
        assert!(says_yes(" **Yes.**"));
        assert!(says_yes("<think>fix is a change</think>yes"));
        assert!(!says_yes("NO"));
        assert!(!says_yes("Yesterday"));
        assert!(!says_yes("count"));
        assert!(!says_yes(""));
    }

    #[test]
    fn a_fixed_mode_decides_the_kind() {
        let asked = read_reply(Mode::Ask, "It says <revised> once.", "note");
        assert_eq!(asked.kind, ReplyKind::Answer);
        let auto = read_reply(Mode::Auto, "There are 3 tasks.", "- a");
        assert_eq!(auto.kind, ReplyKind::Answer);
        let edited = read_reply(Mode::Edit, "Answer the phone.", "answer teh phone");
        assert_eq!(edited.kind, ReplyKind::Edit);
        assert_eq!(edited.text, "Answer the phone.");
        let xml = read_reply(
            Mode::Edit,
            "intro\n<revised>\nbody",
            "intro\n<revised>\nbdy",
        );
        assert_eq!(xml.text, "intro\n<revised>\nbody");
    }

    #[test]
    fn the_request_comes_after_the_note() {
        let whole = user_prompt(" How many tasks? ", "- a\n- b", None);
        assert!(whole.starts_with("<note>\n- a\n- b\n</note>"));
        assert!(whole.ends_with("Request: How many tasks?"));
        let part = user_prompt("Fix it", "- b", Some("- a\n- b"));
        assert!(part.contains("<selected>\n- b\n</selected>"));
        assert!(part.ends_with("Request: Fix it"));
        assert!(system_prompt(Mode::Edit, true).contains("revised selected part"));
        assert!(system_prompt(Mode::Ask, false).contains("Do not repeat or rewrite the note"));
    }

    #[test]
    fn stored_presets_without_a_mode_are_auto() {
        let parsed: Vec<Preset> =
            serde_json::from_str(r#"[{"name":"Old","instruction":"Do it."}]"#).unwrap();
        assert_eq!(parsed[0].mode, Mode::Auto);
    }

    #[test]
    fn model_ids_come_from_openai_and_ollama_shapes() {
        let openai = json!({ "data": [{ "id": "gpt-4o-mini" }, { "id": "gpt-4o" }] });
        assert_eq!(parse_models(&openai), vec!["gpt-4o", "gpt-4o-mini"]);
        let ollama = json!({ "models": [{ "name": "qwen2.5:7b" }] });
        assert_eq!(parse_models(&ollama), vec!["qwen2.5:7b"]);
        assert!(parse_models(&json!({})).is_empty());
    }

    #[test]
    fn stored_presets_drop_empty_rows() {
        let db = Db::open_memory().unwrap();
        assert_eq!(presets(&db).unwrap(), default_presets());
        store_presets(
            &db,
            &[
                Preset {
                    name: " Shorten ".into(),
                    instruction: "Make it shorter.".into(),
                    mode: Mode::Edit,
                },
                Preset {
                    name: String::new(),
                    instruction: "x".into(),
                    mode: Mode::Auto,
                },
            ],
        )
        .unwrap();
        let stored = presets(&db).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].name, "Shorten");
    }
}
