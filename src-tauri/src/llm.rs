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

const OUTPUT_RULES: &str = "Reply with the resulting text only. Keep it as markdown when the input is markdown. Do not add an introduction, an explanation, or a surrounding code fence.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub instruction: String,
}

pub fn default_presets() -> Vec<Preset> {
    let preset = |name: &str, instruction: &str| Preset {
        name: name.into(),
        instruction: instruction.into(),
    };
    vec![
        preset(
            "Summarize",
            "Summarize the text in a few short bullet points. Use the language of the text.",
        ),
        preset(
            "Action items",
            "List the action items from the text as a markdown task list (`- [ ] item`). Name the owner and date when the text gives them. Use the language of the text.",
        ),
        preset(
            "Clean up wording",
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

/// One chat-completions call. Returns the model's text with wrappers removed.
pub async fn chat(
    http: &reqwest::Client,
    base: &str,
    key: Option<&str>,
    model: &str,
    instruction: &str,
    text: &str,
) -> Result<String, AppError> {
    let body = json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": format!("{}\n\n{OUTPUT_RULES}", instruction.trim()) },
            { "role": "user", "content": text },
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
    let answer = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|raw| clean_answer(raw, text))
        .unwrap_or_default();
    if answer.is_empty() {
        return Err(AppError::Message("the model returned no text".into()));
    }
    Ok(answer)
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
                },
                Preset {
                    name: String::new(),
                    instruction: "x".into(),
                },
            ],
        )
        .unwrap();
        let stored = presets(&db).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].name, "Shorten");
    }
}
