use serde_json::{json, Value};

use crate::error::AppError;
use crate::media;

use super::super::db::{canonical_visibility, RemoteLink};
use super::super::model::{is_offline_private, MemoSpace, REMOTE};
use super::{now_ms, ApiFlavor};

pub fn create_body(content: &str, visibility: &str, space: &str) -> Value {
    let mut body = json!({
        "content": content,
        "visibility": canonical_visibility(visibility),
    });
    if !space.is_empty() {
        body["space"] = json!(space);
    }
    body
}

pub fn push_audience(
    visibility: Option<&str>,
    space: Option<&str>,
    default_visibility: &str,
    default_space: &str,
) -> (String, String) {
    let visibility = match visibility.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => canonical_visibility(value),
        None => canonical_visibility(default_visibility),
    };
    let space = match space {
        Some(value) => value.trim().to_string(),
        None => default_space.trim().to_string(),
    };
    if visibility == "SPACE" && space.is_empty() {
        ("PRIVATE".into(), String::new())
    } else {
        (visibility, space)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteChange {
    New,
    Unchanged,
    UpdateStub,
    Pull,
    Conflict,
}

pub fn remote_change(local: Option<&RemoteLink>, remote_updated: i64) -> RemoteChange {
    let Some(local) = local else {
        return RemoteChange::New;
    };
    if local.visibility.as_deref().is_some_and(is_offline_private) {
        return RemoteChange::Unchanged;
    }
    let Some(stored) = local.remote_updated_at else {
        return RemoteChange::Unchanged;
    };
    if remote_updated <= stored {
        return RemoteChange::Unchanged;
    }
    if local.sync_state == REMOTE {
        return RemoteChange::UpdateStub;
    }
    let base = local
        .base_content
        .as_deref()
        .unwrap_or(local.content.as_str());
    let local_text = media::content_for_remote(&local.content);
    let base_text = media::content_for_remote(base);
    if local_text == base_text {
        RemoteChange::Pull
    } else {
        RemoteChange::Conflict
    }
}

#[derive(Clone, Debug)]
pub(super) struct RemoteAttachment {
    pub(super) name: String,
    pub(super) filename: String,
    pub(super) mime_type: String,
}

pub(super) struct RemoteMemo {
    pub(super) name: String,
    pub(super) content: String,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
    pub(super) visibility: String,
    pub(super) space: String,
    pub(super) attachments: Vec<RemoteAttachment>,
}

pub(super) struct MemoPage {
    pub(super) memos: Vec<RemoteMemo>,
    pub(super) next_page_token: String,
}

pub(super) fn parse_space_page(body: &str) -> (Vec<MemoSpace>, String) {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let items = value
        .get("spaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let spaces = items.iter().filter_map(parse_space_item).collect();
    let next = value
        .get("nextPageToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (spaces, next)
}

pub(super) fn parse_space_item(item: &Value) -> Option<MemoSpace> {
    let name = item.get("name").and_then(Value::as_str)?.trim();
    if name.is_empty() {
        return None;
    }
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or(name);
    Some(MemoSpace {
        name: name.to_string(),
        title: title.to_string(),
    })
}

pub fn create_space_body(title: &str, flavor: ApiFlavor, space_id: &str) -> Value {
    match flavor {
        ApiFlavor::Latest => json!({ "title": title }),
        ApiFlavor::V1 => {
            let mut body = json!({ "space": { "title": title } });
            if !space_id.is_empty() {
                body["spaceId"] = json!(space_id);
            }
            body
        }
    }
}

pub fn space_uid(name: &str) -> Option<&str> {
    name.strip_prefix("spaces/")
        .map(str::trim)
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

pub(super) fn preview_line(content: &str) -> String {
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Memo");
    line.chars().take(80).collect()
}

pub(super) fn parse_memo_page(body: &str) -> Result<MemoPage, AppError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| AppError::Message(format!("memos list was not json: {err}")))?;
    let (items, next) = if let Some(items) = value.get("memos").and_then(Value::as_array) {
        let next = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        (items, next)
    } else if let Some(items) = value.as_array() {
        (items, String::new())
    } else {
        return Ok(MemoPage {
            memos: Vec::new(),
            next_page_token: String::new(),
        });
    };
    let memos = items.iter().filter_map(parse_memo_object).collect();
    Ok(MemoPage {
        memos,
        next_page_token: next,
    })
}

pub(super) fn parse_memo_object(value: &Value) -> Option<RemoteMemo> {
    if value
        .get("state")
        .or_else(|| value.get("rowStatus"))
        .and_then(Value::as_str)
        .is_some_and(|state| {
            state.eq_ignore_ascii_case("ARCHIVED") || state.eq_ignore_ascii_case("DELETED")
        })
    {
        return None;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .get("id")
                .and_then(|id| {
                    id.as_i64()
                        .map(|id| id.to_string())
                        .or_else(|| id.as_str().map(str::to_string))
                })
                .map(|id| format!("memos/{id}"))
        })?;
    if name.is_empty() {
        return None;
    }
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = value
        .get("createTime")
        .or_else(|| value.get("createdTs"))
        .or_else(|| value.get("createdAt"))
        .and_then(parse_time)
        .unwrap_or_else(now_ms);
    let updated_at = value
        .get("updateTime")
        .or_else(|| value.get("updatedTs"))
        .or_else(|| value.get("updatedAt"))
        .and_then(parse_time)
        .unwrap_or(created_at);
    let visibility = value
        .get("visibility")
        .and_then(Value::as_str)
        .map(canonical_visibility)
        .unwrap_or_else(|| "PRIVATE".into());
    let space = value
        .get("space")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let attachments = parse_remote_attachments(value);
    Some(RemoteMemo {
        name,
        content,
        created_at,
        updated_at,
        visibility,
        space,
        attachments,
    })
}

fn parse_remote_attachments(value: &Value) -> Vec<RemoteAttachment> {
    let mut out = Vec::new();
    for key in ["attachments", "resources", "resourceList"] {
        let Some(items) = value.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    item.get("id")
                        .and_then(|id| {
                            id.as_i64()
                                .map(|n| n.to_string())
                                .or_else(|| id.as_str().map(str::to_string))
                        })
                        .map(|id| format!("resources/{id}"))
                });
            let Some(name) = name.filter(|s| !s.is_empty()) else {
                continue;
            };
            let filename = item
                .get("filename")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("attachment")
                .to_string();
            let mime_type = item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !out
                .iter()
                .any(|existing: &RemoteAttachment| existing.name == name)
            {
                out.push(RemoteAttachment {
                    name,
                    filename,
                    mime_type,
                });
            }
        }
    }
    out
}

pub(super) fn append_markdown_lines(content: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        return content.to_string();
    }
    let mut parts = Vec::new();
    let trimmed = content.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    for line in lines {
        let already_in_content = trimmed
            .lines()
            .any(|existing| existing.trim() == line.trim());
        if !already_in_content && !parts.iter().any(|p| p == line) {
            parts.push(line.clone());
        }
    }
    parts.join("\n")
}

fn parse_time(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(normalize_unix(number));
    }
    if let Some(number) = value.as_u64() {
        return Some(normalize_unix(number as i64));
    }
    let text = value.as_str()?;
    if let Ok(number) = text.parse::<i64>() {
        return Some(normalize_unix(number));
    }
    parse_rfc3339_ms(text)
}

fn normalize_unix(number: i64) -> i64 {
    if number.abs() > 10_000_000_000 {
        number
    } else {
        number.saturating_mul(1000)
    }
}

pub(super) fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 19 {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: u32 = value.get(11..13)?.parse().ok()?;
    let minute: u32 = value.get(14..16)?.parse().ok()?;
    let second: u32 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let mut unix =
        days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
    let rest = value.get(19..).unwrap_or("");
    let mut millis: i64 = 0;
    let rest = if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .count();
        if digits == 0 {
            return None;
        }
        let frac = &stripped[..digits.min(3)];
        let parsed: i64 = frac.parse().ok()?;
        millis = match frac.len() {
            1 => parsed * 100,
            2 => parsed * 10,
            _ => parsed,
        };
        stripped.get(digits..).unwrap_or("")
    } else {
        rest
    };
    if rest != "Z" && !rest.is_empty() {
        let sign = rest.chars().next()?;
        if sign != '+' && sign != '-' {
            return None;
        }
        let hours: i64 = rest.get(1..3)?.parse().ok()?;
        let minutes: i64 = rest.get(4..6)?.parse().ok()?;
        let offset = hours * 3_600 + minutes * 60;
        unix -= if sign == '+' { offset } else { -offset };
    }
    Some(unix.saturating_mul(1000).saturating_add(millis))
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> i64 {
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + u64::from(day_of_year);
    i64::from(era) * 146_097 + day_of_era as i64 - 719_468
}
