//! Size limits the useMemos server applies to this user.
//!
//! Current servers expose them per user at `users/{user}/usage`. Older servers
//! keep one content limit in the `MEMO_RELATED` setting. The oldest have a
//! fixed 8 KiB. Sizes are UTF-8 bytes. Zero means unlimited.

use reqwest::StatusCode;
use serde_json::Value;

use crate::error::AppError;

use super::super::db::{Db, LIMITS_CHECKED_AT, MEMO_CONTENT_BYTES, UPLOAD_BYTES};
use super::{db_call, now_ms, trim_base, ApiFlavor};

/// Content limit assumed when the server does not report one.
pub const FALLBACK_CONTENT_BYTES: u64 = 8192;
const RECHECK_MS: i64 = 60 * 60 * 1000;
const QUOTA_REASON: &str = "QUOTA_EXCEEDED";
const CONTENT_METRIC: &str = "MEMO_CONTENT_BYTES";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerLimits {
    /// Largest memo body in bytes. Zero is unlimited.
    pub memo_content_bytes: u64,
    /// Largest single upload in bytes. Zero is unlimited or unknown.
    pub upload_bytes: u64,
}

impl ServerLimits {
    pub const FALLBACK: Self = Self {
        memo_content_bytes: FALLBACK_CONTENT_BYTES,
        upload_bytes: 0,
    };

    pub fn content_fits(self, content: &str) -> bool {
        self.memo_content_bytes == 0 || content.len() as u64 <= self.memo_content_bytes
    }
}

/// Limits stored by the last probe, or the fallback before any probe.
pub fn stored(db: &Db) -> Result<ServerLimits, AppError> {
    let content = db.get_meta(MEMO_CONTENT_BYTES)?;
    let upload = db.get_meta(UPLOAD_BYTES)?;
    Ok(ServerLimits {
        memo_content_bytes: content
            .and_then(|value| value.parse().ok())
            .unwrap_or(FALLBACK_CONTENT_BYTES),
        upload_bytes: upload.and_then(|value| value.parse().ok()).unwrap_or(0),
    })
}

fn store(db: &Db, limits: ServerLimits) -> Result<(), AppError> {
    db.set_meta(MEMO_CONTENT_BYTES, &limits.memo_content_bytes.to_string())?;
    db.set_meta(UPLOAD_BYTES, &limits.upload_bytes.to_string())?;
    db.set_meta(LIMITS_CHECKED_AT, &now_ms().to_string())
}

/// Stored limits, refreshed from the server when the last probe is over an hour old.
/// A network failure keeps the stored values.
pub(super) async fn current(
    http: &reqwest::Client,
    db: &Db,
    base: &str,
    token: &str,
    flavor: ApiFlavor,
) -> ServerLimits {
    let (known, checked_at) = db_call(db.clone(), |db| {
        let checked = db
            .get_meta(LIMITS_CHECKED_AT)?
            .and_then(|value| value.parse::<i64>().ok());
        Ok((stored(&db)?, checked))
    })
    .await
    .unwrap_or((ServerLimits::FALLBACK, None));
    if checked_at.is_some_and(|stamp| now_ms() - stamp < RECHECK_MS) {
        return known;
    }
    match fetch(http, base, token, flavor).await {
        Ok(limits) => {
            let _ = db_call(db.clone(), move |db| store(&db, limits)).await;
            limits
        }
        Err(err) => {
            eprintln!("memose: limit probe failed: {err}");
            known
        }
    }
}

/// Reads the limits from the server. Errors only when the server cannot be reached.
pub async fn fetch(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    flavor: ApiFlavor,
) -> Result<ServerLimits, AppError> {
    let base = trim_base(base);
    if flavor == ApiFlavor::Latest {
        if let Some(me) = get_json(http, &format!("{base}/api/auth/me"), token).await? {
            if let Some(user) = user_name(&me) {
                let url = format!("{base}/api/{user}/usage");
                if let Some(usage) = get_json(http, &url, token).await? {
                    return Ok(parse_usage(&usage));
                }
            }
        }
    }
    let prefixes = match flavor {
        ApiFlavor::Latest => ["/api", "/api/v1"],
        ApiFlavor::V1 => ["/api/v1", "/api"],
    };
    for prefix in prefixes {
        for scope in ["instance", "workspace"] {
            let url = format!("{base}{prefix}/{scope}/settings/MEMO_RELATED");
            if let Some(setting) = get_json(http, &url, token).await? {
                if let Some(limit) = parse_memo_related(&setting) {
                    return Ok(ServerLimits {
                        memo_content_bytes: limit,
                        upload_bytes: 0,
                    });
                }
            }
        }
    }
    Ok(ServerLimits::FALLBACK)
}

async fn get_json(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<Option<Value>, AppError> {
    let response = http.get(url).bearer_auth(token).send().await?;
    if response.status() != StatusCode::OK {
        return Ok(None);
    }
    Ok(response.json::<Value>().await.ok())
}

fn user_name(me: &Value) -> Option<&str> {
    me.get("user")
        .unwrap_or(me)
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| name.starts_with("users/") && !name.contains(['?', '#', ' ']))
}

/// int64 fields arrive as JSON strings from the gateway, and as numbers elsewhere.
fn as_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::String(text) => text.trim().parse().ok(),
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

/// An unset limit is unlimited.
pub fn parse_usage(usage: &Value) -> ServerLimits {
    let limits = usage.get("limits");
    let field = |key: &str| as_u64(limits.and_then(|limits| limits.get(key))).unwrap_or(0);
    ServerLimits {
        memo_content_bytes: field("memoContentBytes"),
        upload_bytes: field("uploadBytes"),
    }
}

/// Older servers always report a positive limit here.
pub fn parse_memo_related(setting: &Value) -> Option<u64> {
    let inner = setting.get("memoRelatedSetting").unwrap_or(setting);
    as_u64(inner.get("contentLengthLimit")).filter(|limit| *limit > 0)
}

/// Content limit named in a `QUOTA_EXCEEDED` refusal body.
pub fn quota_content_limit(body: &str) -> Option<u64> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return quota_limit_in_cut_body(body);
    };
    value.get("details")?.as_array()?.iter().find_map(|detail| {
        if detail.get("reason").and_then(Value::as_str) != Some(QUOTA_REASON) {
            return None;
        }
        let metadata = detail.get("metadata")?;
        if metadata.get("metric").and_then(Value::as_str) != Some(CONTENT_METRIC) {
            return None;
        }
        as_u64(metadata.get("limit")).filter(|limit| *limit > 0)
    })
}

/// Error bodies are cut to 500 characters before they reach here, which can break the JSON.
fn quota_limit_in_cut_body(body: &str) -> Option<u64> {
    if !body.contains(QUOTA_REASON) {
        return None;
    }
    let after_metric = body.split_once(CONTENT_METRIC)?.1;
    let after_key = after_metric.split_once("\"limit\":")?.1;
    let digits: String = after_key
        .trim_start_matches([' ', '"'])
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok().filter(|limit| *limit > 0)
}

/// Remembers a limit the server reported while refusing a push.
pub(super) fn remember_content_limit(db: &Db, limit: u64) -> Result<(), AppError> {
    let mut limits = stored(db)?;
    limits.memo_content_bytes = limit;
    store(db, limits)
}

pub fn too_long_message(size: usize, limit: u64) -> String {
    format!(
        "Too long for this server ({} / {})",
        kilobytes(size as u64),
        kilobytes(limit)
    )
}

fn kilobytes(bytes: u64) -> String {
    let tenths = (bytes * 10 + 512) / 1024;
    if tenths.is_multiple_of(10) {
        format!("{} KB", tenths / 10)
    } else {
        format!("{}.{} KB", tenths / 10, tenths % 10)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn usage_limits_read_strings_and_numbers() {
        let limits = parse_usage(&json!({
            "name": "users/ann/usage",
            "limits": { "memoContentBytes": "16384", "uploadBytes": 1048576 }
        }));
        assert_eq!(limits.memo_content_bytes, 16384);
        assert_eq!(limits.upload_bytes, 1_048_576);
    }

    #[test]
    fn unset_or_zero_usage_limit_is_unlimited() {
        assert_eq!(parse_usage(&json!({})).memo_content_bytes, 0);
        let zero = parse_usage(&json!({ "limits": { "memoContentBytes": "0" } }));
        assert_eq!(zero.memo_content_bytes, 0);
        assert!(zero.content_fits(&"x".repeat(100_000)));
    }

    #[test]
    fn memo_related_setting_gives_the_older_limit() {
        let nested = json!({ "memoRelatedSetting": { "contentLengthLimit": 20000 } });
        assert_eq!(parse_memo_related(&nested), Some(20000));
        assert_eq!(
            parse_memo_related(&json!({ "memoRelatedSetting": {} })),
            None
        );
    }

    #[test]
    fn content_size_is_counted_in_bytes() {
        let limits = ServerLimits::FALLBACK;
        let text = "ä".repeat(5000);
        assert_eq!(text.chars().count(), 5000);
        assert!(!limits.content_fits(&text));
        assert!(limits.content_fits(&"a".repeat(8192)));
        assert!(!limits.content_fits(&"a".repeat(8193)));
    }

    #[test]
    fn quota_refusal_names_the_content_limit() {
        let body = r#"{"code":8,"message":"quota exceeded","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXCEEDED","domain":"memos","metadata":{"metric":"MEMO_CONTENT_BYTES","limit":"4096","usage":"5000"}}]}"#;
        assert_eq!(quota_content_limit(body), Some(4096));
        let other = body.replace("MEMO_CONTENT_BYTES", "STORAGE_BYTES");
        assert_eq!(quota_content_limit(&other), None);
        assert_eq!(quota_content_limit("not json"), None);
        let cut = &body[..body.len() - 20];
        assert_eq!(quota_content_limit(cut), Some(4096));
    }

    #[test]
    fn too_long_message_shows_both_sizes() {
        assert_eq!(
            too_long_message(9318, 8192),
            "Too long for this server (9.1 KB / 8 KB)"
        );
    }
}
