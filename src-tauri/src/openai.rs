//! Calls to OpenAI-compatible servers, shared by the chat model and the speech server.
//!
//! A base URL carries the version prefix, such as `https://api.openai.com/v1`
//! or `http://localhost:11434/v1`. Paths are joined after it.

use serde_json::Value;

use crate::error::AppError;

/// Trims the URL and checks the scheme. Empty stays empty.
pub fn clean_base(url: &str) -> Result<String, AppError> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(AppError::Message(
            "server URL must start with http:// or https://".into(),
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

fn usable_key(key: Option<&str>) -> Option<&str> {
    key.map(str::trim).filter(|key| !key.is_empty())
}

pub fn with_key(request: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match usable_key(key) {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

/// Error text from a failed call to `server`, such as "model server". The body is cut short,
/// and the key is taken out in case a proxy echoes the request back.
pub async fn failure(response: reqwest::Response, server: &str, key: Option<&str>) -> AppError {
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
    let detail = match usable_key(key) {
        Some(key) => detail.replace(key, "…"),
        None => detail,
    };
    let detail: String = detail.trim().chars().take(300).collect();
    if detail.is_empty() {
        AppError::Message(format!("{server} returned {status}"))
    } else {
        AppError::Message(format!("{server} returned {status}: {detail}"))
    }
}

/// Error text for a call to `server` that got no reply.
pub fn unreachable(err: &reqwest::Error, server: &str) -> AppError {
    if err.is_timeout() {
        AppError::Message(format!("the {server} took too long to answer"))
    } else if err.is_connect() {
        AppError::Message(format!("could not reach the {server}"))
    } else {
        AppError::Message(format!("the request to the {server} failed"))
    }
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
}
