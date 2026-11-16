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

const EDIT_RULES: &str = "Apply the instruction to the note the user sends. Reply with the complete resulting note only. Keep it as markdown when the note is markdown. Do not add an introduction, an explanation, or a surrounding code fence.";
const ASK_RULES: &str = "Answer the instruction using the note the user sends. Do not rewrite the note. Be brief and direct, and use the language of the instruction.";
const AUTO_RULES: &str = "The user sends an instruction and a note. Decide what the instruction needs.\n- If it asks to change the note (rewrite, fix, translate, format, shorten, extend, reorder), the first line of your reply is exactly EDIT and the following lines are the complete revised note.\n- If it asks about the note or asks for something that must not replace it (count, find, explain, summarize, list, give an opinion), the first line of your reply is exactly ANSWER and the following lines are the answer.\nWrite nothing before that first line. Do not wrap the reply in a code fence.";

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
    /// Memo text that was sent. An edit is compared against it.
    pub source: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
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
    host == "localhost" || host == "::1" || host == "0.0.0.0" || host.starts_with("127.")
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

/// One chat-completions call. `Auto` lets the model say whether it answered or edited.
pub async fn ask(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    mode: Mode,
    instruction: &str,
    text: &str,
) -> Result<Reply, AppError> {
    let rules = match mode {
        Mode::Auto => AUTO_RULES,
        Mode::Ask => ASK_RULES,
        Mode::Edit => EDIT_RULES,
    };
    let body = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": rules },
            { "role": "user", "content": format!("Instruction: {}\n\nNote:\n{text}", instruction.trim()) },
        ],
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

/// Sorts the model's text into an answer or an edit.
/// In `Auto`, a reply without the marker line is an answer, so the memo is never replaced by accident.
pub fn read_reply(mode: Mode, raw: &str, source: &str) -> Reply {
    let cleaned = clean_answer(raw, source);
    let (kind, body) = match mode {
        Mode::Ask => (ReplyKind::Answer, cleaned.as_str()),
        Mode::Edit => (ReplyKind::Edit, cleaned.as_str()),
        Mode::Auto => {
            let (first, rest) = cleaned.split_once('\n').unwrap_or((cleaned.as_str(), ""));
            let marker: String = first
                .chars()
                .filter(char::is_ascii_alphabetic)
                .collect::<String>()
                .to_ascii_uppercase();
            match marker.as_str() {
                "EDIT" => (ReplyKind::Edit, rest),
                "ANSWER" => (ReplyKind::Answer, rest),
                _ => (ReplyKind::Answer, cleaned.as_str()),
            }
        }
    };
    let text = if kind == ReplyKind::Edit {
        clean_answer(body, source)
    } else {
        body.trim().to_string()
    };
    Reply { kind, text }
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

    #[test]
    fn auto_reply_is_sorted_by_its_first_line() {
        let edit = read_reply(Mode::Auto, "EDIT\nHello there.", "hello there");
        assert_eq!(edit.kind, ReplyKind::Edit);
        assert_eq!(edit.text, "Hello there.");
        let answer = read_reply(
            Mode::Auto,
            "**ANSWER:**\nThere are 3 tasks.",
            "- a\n- b\n- c",
        );
        assert_eq!(answer.kind, ReplyKind::Answer);
        assert_eq!(answer.text, "There are 3 tasks.");
        let fenced = read_reply(Mode::Auto, "EDIT\n```markdown\n- one\n```", "one");
        assert_eq!(fenced.text, "- one");
    }

    #[test]
    fn auto_reply_without_a_marker_never_replaces_the_memo() {
        let reply = read_reply(Mode::Auto, "There are 3 tasks.", "- a\n- b\n- c");
        assert_eq!(reply.kind, ReplyKind::Answer);
        assert_eq!(reply.text, "There are 3 tasks.");
    }

    #[test]
    fn a_fixed_mode_ignores_marker_words() {
        let asked = read_reply(Mode::Ask, "EDIT\nis a word in the note.", "note");
        assert_eq!(asked.kind, ReplyKind::Answer);
        assert_eq!(asked.text, "EDIT\nis a word in the note.");
        let edited = read_reply(Mode::Edit, "Answer the phone.", "answer teh phone");
        assert_eq!(edited.kind, ReplyKind::Edit);
        assert_eq!(edited.text, "Answer the phone.");
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
