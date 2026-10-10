use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use tauri::Emitter;

use crate::error::AppError;
use crate::media;
use crate::state::AppState;

use super::db::{Db, RemoteLink, API_FLAVOR, BASE_URL};
use super::model::{Note, MEMOS_CONTENT_LIMIT, REMOTE};

pub enum Job {
    Cycle,
    Materialize(String, tokio::sync::oneshot::Sender<Result<Note, AppError>>),
    KeepLocal(String, tokio::sync::oneshot::Sender<Result<Note, AppError>>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFlavor {
    Latest,
    V1,
}

impl ApiFlavor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::V1 => "v1",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Latest => "/api/memos",
            Self::V1 => "/api/v1/memos",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "latest" => Some(Self::Latest),
            "v1" => Some(Self::V1),
            _ => None,
        }
    }
}

pub fn create_body(content: &str) -> Value {
    json!({
        "content": content,
        "visibility": "PRIVATE"
    })
}

pub fn start_worker(app: AppHandle) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    {
        let state = app.state::<AppState>();
        *state
            .sync_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        while let Some(job) = rx.recv().await {
            run_job(&app, &mut rx, job).await;
        }
    });
}

pub fn request_sync(app: &AppHandle) {
    send(app, Job::Cycle);
}

pub async fn request_materialize(app: &AppHandle, id: String) -> Result<Note, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !send(app, Job::Materialize(id.clone(), tx)) {
        let state = app.state::<AppState>();
        return materialize_remote(&state.db, &state.http, &id).await;
    }
    match rx.await {
        Ok(result) => result,
        Err(_) => Err(AppError::Message("sync stopped".into())),
    }
}

pub async fn request_keep_local(app: &AppHandle, id: String) -> Result<Note, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    send(app, Job::KeepLocal(id, tx));
    match rx.await {
        Ok(result) => result,
        Err(_) => Err(AppError::Message("sync stopped".into())),
    }
}

fn send(app: &AppHandle, job: Job) -> bool {
    let state = app.state::<AppState>();
    let guard = state
        .sync_tx
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.as_ref().is_some_and(|tx| tx.send(job).is_ok())
}

async fn run_job(
    app: &AppHandle,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Job>,
    job: Job,
) {
    match job {
        Job::Cycle => {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let mut later = Vec::new();
            while let Ok(next) = rx.try_recv() {
                match next {
                    Job::Cycle => {}
                    other => later.push(other),
                }
            }
            for job in later {
                finish_job(app, job).await;
            }
            run_cycle(app).await;
        }
        other => finish_job(app, other).await,
    }
}

async fn finish_job(app: &AppHandle, job: Job) {
    match job {
        Job::Cycle => {}
        Job::Materialize(id, reply) => {
            let state = app.state::<AppState>();
            let db = state.db.clone();
            let http = state.http.clone();
            drop(state);
            let _ = reply.send(materialize_remote(&db, &http, &id).await);
        }
        Job::KeepLocal(id, reply) => {
            let state = app.state::<AppState>();
            let db = state.db.clone();
            let http = state.http.clone();
            drop(state);
            let _ = reply.send(push_local_choice(&db, &http, &id).await);
            let _ = app.emit("notes-changed", ());
        }
    }
}

const INDEX_INTERVAL: Duration = Duration::from_secs(20);

fn index_due(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let last = state
        .last_index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    last.as_ref()
        .is_none_or(|stamp| stamp.elapsed() >= INDEX_INTERVAL)
}

fn mark_index(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state
        .last_index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(std::time::Instant::now());
}

async fn run_cycle(app: &AppHandle) {
    let refresh = index_due(app);
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let http = state.http.clone();
    drop(state);
    let mut retries = 0;
    let mut report = DrainReport::default();
    loop {
        match drain(db.clone(), &http, refresh && retries == 0).await {
            Ok(next) => {
                report.pushed |= next.pushed;
                report.indexed |= next.indexed;
                if next.retry && retries < 2 {
                    retries += 1;
                    continue;
                }
                break;
            }
            Err(err) => {
                eprintln!("memose: sync failed: {err}");
                break;
            }
        }
    }
    if report.indexed {
        mark_index(app);
    }
    if report.indexed || report.pushed {
        let _ = app.emit("notes-changed", ());
    }
}

#[derive(Default)]
struct DrainReport {
    retry: bool,
    indexed: bool,
    pushed: bool,
}

async fn drain(db: Db, http: &reqwest::Client, refresh: bool) -> Result<DrainReport, AppError> {
    let base = match db_call(db.clone(), |db| db.get_meta(BASE_URL)).await? {
        Some(url) if !url.is_empty() => url,
        _ => return Ok(DrainReport::default()),
    };
    let Some(token) = db_call(db.clone(), |db| db.access_token()).await? else {
        return Ok(DrainReport::default());
    };
    let flavor = match db_call(db.clone(), |db| db.get_meta(API_FLAVOR)).await? {
        Some(stored) => match ApiFlavor::parse(&stored) {
            Some(flavor) => flavor,
            None => detect_and_store(http, &db, &base, &token).await?,
        },
        None => detect_and_store(http, &db, &base, &token).await?,
    };
    let mut indexed = false;
    if refresh {
        match refresh_index(http, &db, &base, &token, flavor).await {
            Ok(()) => indexed = true,
            Err(err) => eprintln!("memose: remote list failed: {err}"),
        }
    }
    let notes = db_call(db.clone(), |db| db.pending_and_errors()).await?;
    let mut retry = false;
    let mut did_push = false;
    for note in notes {
        let remote = media::content_for_remote(&note.content);
        if remote.is_empty() && note.remote_name.is_none() {
            db_call(db.clone(), {
                let id = note.id.clone();
                move |db| {
                    db.mark_local(&id)?;
                    Ok(())
                }
            })
            .await?;
            continue;
        }
        if remote.chars().count() > MEMOS_CONTENT_LIMIT {
            db_call(db.clone(), {
                let id = note.id.clone();
                move |db| {
                    db.mark_error(&id, "content exceeds 8192 characters")?;
                    Ok(())
                }
            })
            .await?;
            continue;
        }
        let pushed = if let Some(name) = note.remote_name.clone() {
            update_memo(http, &base, flavor, &token, &name, &remote)
                .await
                .map(|()| name)
        } else {
            create_memo(http, &base, flavor, &token, &remote).await
        };
        match pushed {
            Ok(name) => {
                let id = note.id.clone();
                let content = note.content.clone();
                let stored = db_call(db.clone(), {
                    let id = id.clone();
                    let name = name.clone();
                    move |db| db.complete_push(&id, &name, &content)
                })
                .await?;
                if stored {
                    did_push = true;
                } else {
                    db_call(db.clone(), move |db| db.remember_remote_name(&id, &name)).await?;
                    retry = true;
                }
            }
            Err(err) => {
                let message = err.to_string();
                db_call(db.clone(), {
                    let id = note.id.clone();
                    move |db| {
                        db.mark_error(&id, &message)?;
                        Ok(())
                    }
                })
                .await?;
            }
        }
    }
    Ok(DrainReport {
        retry,
        indexed,
        pushed: did_push,
    })
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
    let Some(stored) = local.remote_updated_at else {
        return RemoteChange::Unchanged;
    };
    if remote_updated <= stored {
        return RemoteChange::Unchanged;
    }
    if local.sync_state == REMOTE {
        return RemoteChange::UpdateStub;
    }
    let base = local.base_content.as_deref().unwrap_or(local.content.as_str());
    let local_text = media::content_for_remote(&local.content);
    let base_text = media::content_for_remote(base);
    if local_text == base_text {
        RemoteChange::Pull
    } else {
        RemoteChange::Conflict
    }
}

async fn refresh_index(
    http: &reqwest::Client,
    db: &Db,
    base: &str,
    token: &str,
    flavor: ApiFlavor,
) -> Result<(), AppError> {
    let mut page_token = String::new();
    for _ in 0..4 {
        let page = list_memos(http, base, flavor, token, &page_token).await?;
        for memo in page.memos {
            apply_remote_memo(db, memo).await?;
        }
        if page.next_page_token.is_empty() {
            break;
        }
        page_token = page.next_page_token;
    }
    Ok(())
}

async fn apply_remote_memo(db: &Db, memo: RemoteMemo) -> Result<(), AppError> {
    let link = db_call(db.clone(), {
        let name = memo.name.clone();
        move |db| db.remote_link(&name)
    })
    .await?;
    let change = remote_change(link.as_ref(), memo.updated_at);
    match change {
        RemoteChange::Unchanged => Ok(()),
        RemoteChange::New => {
            let preview = preview_line(&memo.content);
            let created = memo.created_at;
            let updated = memo.updated_at;
            let name = memo.name;
            db_call(db.clone(), move |db| {
                db.insert_remote_stub(&name, &preview, created, updated)
            })
            .await
        }
        RemoteChange::UpdateStub => {
            let Some(link) = link else {
                return Ok(());
            };
            let preview = preview_line(&memo.content);
            let updated = memo.updated_at;
            db_call(db.clone(), move |db| {
                db.touch_remote_stub(&link.id, &preview, updated)
            })
            .await
        }
        RemoteChange::Pull | RemoteChange::Conflict => {
            let Some(link) = link else {
                return Ok(());
            };
            let id = link.id;
            let raw = link.content;
            let server = memo.content;
            let updated = memo.updated_at;
            let local_text = media::content_for_remote(&raw);
            if local_text == server {
                return db_call(db.clone(), move |db| db.acknowledge_remote(&id, updated)).await;
            }
            if change == RemoteChange::Conflict || raw != local_text {
                return db_call(db.clone(), move |db| db.store_conflict(&id, &server, updated)).await;
            }
            db_call(db.clone(), move |db| db.apply_server_body(&id, &server, updated)).await
        }
    }
}

pub async fn materialize_remote(db: &Db, http: &reqwest::Client, id: &str) -> Result<super::model::Note, AppError> {
    let id_owned = id.to_string();
    let note = db_call(db.clone(), move |db| db.get(&id_owned)).await?;
    let Some(note) = note else {
        return Err(AppError::Message("note not found".into()));
    };
    if note.sync_state != REMOTE {
        return Ok(note);
    }
    let Some(name) = note.remote_name.clone() else {
        return Ok(note);
    };
    let (base, token, flavor) = sync_context(db, http).await?;
    let full = get_memo(http, &base, flavor, &token, &name).await?;
    let updated = full.updated_at;
    let content = full.content;
    let id_owned = note.id.clone();
    db_call(db.clone(), move |db| {
        db.apply_server_body(&id_owned, &content, updated)
    })
    .await?;
    let id_owned = note.id;
    db_call(db.clone(), move |db| {
        db.get(&id_owned)?
            .ok_or_else(|| AppError::Message("note disappeared".into()))
    })
    .await
}

pub async fn push_local_choice(db: &Db, http: &reqwest::Client, id: &str) -> Result<super::model::Note, AppError> {
    let id_owned = id.to_string();
    let note = db_call(db.clone(), move |db| {
        db.get(&id_owned)?
            .ok_or_else(|| AppError::Message("note not found".into()))
    })
    .await?;
    let name = note
        .remote_name
        .clone()
        .ok_or_else(|| AppError::Message("memo has no server copy".into()))?;
    let (base, token, flavor) = sync_context(db, http).await?;
    let remote = media::content_for_remote(&note.content);
    update_memo(http, &base, flavor, &token, &name, &remote).await?;
    let updated = now_ms();
    let id_owned = note.id.clone();
    db_call(db.clone(), move |db| db.resolve_local(&id_owned, updated)).await?;
    let id_owned = note.id;
    db_call(db.clone(), move |db| {
        db.get(&id_owned)?
            .ok_or_else(|| AppError::Message("note disappeared".into()))
    })
    .await
}

async fn sync_context(db: &Db, _http: &reqwest::Client) -> Result<(String, String, ApiFlavor), AppError> {
    let base = db_call(db.clone(), |db| db.get_meta(BASE_URL))
        .await?
        .filter(|url| !url.is_empty())
        .ok_or_else(|| AppError::Message("server URL is not set".into()))?;
    let token = db_call(db.clone(), |db| db.access_token())
        .await?
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::Message("access token is not set".into()))?;
    let flavor = match db_call(db.clone(), |db| db.get_meta(API_FLAVOR)).await? {
        Some(stored) => ApiFlavor::parse(&stored).unwrap_or(ApiFlavor::V1),
        None => ApiFlavor::V1,
    };
    Ok((base, token, flavor))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

async fn detect_and_store(
    http: &reqwest::Client,
    db: &Db,
    base: &str,
    token: &str,
) -> Result<ApiFlavor, AppError> {
    let flavor = probe(http, base, token).await?;
    let stored = flavor.as_str().to_string();
    db_call(db.clone(), move |db| {
        db.set_meta(API_FLAVOR, &stored)?;
        Ok(())
    })
    .await?;
    Ok(flavor)
}

pub async fn probe(http: &reqwest::Client, base: &str, token: &str) -> Result<ApiFlavor, AppError> {
    let latest = format!(
        "{}{}?pageSize=1",
        trim_base(base),
        ApiFlavor::Latest.path()
    );
    let latest_status = request_status(http, &latest, token).await?;
    if latest_status == StatusCode::NOT_FOUND || latest_status == StatusCode::GONE {
        let v1 = format!("{}{}", trim_base(base), ApiFlavor::V1.path());
        let v1_status = request_status(http, &format!("{v1}?pageSize=1"), token).await?;
        if v1_status.is_success() {
            return Ok(ApiFlavor::V1);
        }
        return Err(AppError::Memos {
            status: v1_status.as_u16(),
            body: "memos API probe failed".into(),
        });
    }
    if latest_status.is_success() {
        return Ok(ApiFlavor::Latest);
    }
    Err(AppError::Memos {
        status: latest_status.as_u16(),
        body: "memos API probe failed".into(),
    })
}

pub async fn create_memo(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    content: &str,
) -> Result<String, AppError> {
    let url = format!("{}{}", trim_base(base), flavor.path());
    let response = http
        .post(url)
        .bearer_auth(token)
        .json(&create_body(content))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Memos {
            status: status.as_u16(),
            body: truncate(&body),
        });
    }
    let payload: Value = response.json().await?;
    payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::Message("memos response missing name".into()))
}

struct RemoteMemo {
    name: String,
    content: String,
    created_at: i64,
    updated_at: i64,
}

struct MemoPage {
    memos: Vec<RemoteMemo>,
    next_page_token: String,
}

async fn list_memos(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    page_token: &str,
) -> Result<MemoPage, AppError> {
    let mut url = format!(
        "{}{}?pageSize=50",
        trim_base(base),
        flavor.path()
    );
    if !page_token.is_empty() {
        url.push_str("&pageToken=");
        url.push_str(&urlencoding_token(page_token));
    }
    let response = http.get(url).bearer_auth(token).send().await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Memos {
            status: status.as_u16(),
            body: truncate(&body),
        });
    }
    let body = response.text().await?;
    parse_memo_page(&body)
}

fn urlencoding_token(token: &str) -> String {
    token
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn get_memo(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    name: &str,
) -> Result<RemoteMemo, AppError> {
    let response = http
        .get(memo_url(base, flavor, name))
        .bearer_auth(token)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Memos {
            status: status.as_u16(),
            body: truncate(&body),
        });
    }
    let body = response.text().await?;
    parse_memo_object(&serde_json::from_str(&body).unwrap_or(Value::Null))
        .ok_or_else(|| AppError::Message("memos response missing memo".into()))
}

async fn update_memo(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    name: &str,
    content: &str,
) -> Result<(), AppError> {
    let response = http
        .patch(memo_url(base, flavor, name))
        .bearer_auth(token)
        .query(&[("updateMask", "content")])
        .json(&json!({ "content": content }))
        .send()
        .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(AppError::Memos {
        status: status.as_u16(),
        body: truncate(&body),
    })
}

fn memo_url(base: &str, flavor: ApiFlavor, name: &str) -> String {
    let uid = name.rsplit('/').next().filter(|part| !part.is_empty()).unwrap_or(name);
    format!("{}{}/{}", trim_base(base), flavor.path(), uid)
}

fn preview_line(content: &str) -> String {
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Memo");
    line.chars().take(80).collect()
}

fn parse_memo_page(body: &str) -> Result<MemoPage, AppError> {
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
    let memos = items.iter().filter_map(|item| parse_memo_object(item)).collect();
    Ok(MemoPage {
        memos,
        next_page_token: next,
    })
}

fn parse_memo_object(value: &Value) -> Option<RemoteMemo> {
    if value
        .get("state")
        .or_else(|| value.get("rowStatus"))
        .and_then(Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("ARCHIVED") || state.eq_ignore_ascii_case("DELETED"))
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
                .and_then(|id| id.as_i64().map(|id| id.to_string()).or_else(|| id.as_str().map(str::to_string)))
                .map(|id| format!("memos/{id}"))
        })?;
    if name.is_empty() {
        return None;
    }
    let content = value.get("content").and_then(Value::as_str).unwrap_or("").to_string();
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
    Some(RemoteMemo {
        name,
        content,
        created_at,
        updated_at,
    })
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

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
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
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let mut unix = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
    let rest = value.get(19..).unwrap_or("");
    let rest = if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped.chars().take_while(|ch| ch.is_ascii_digit()).count();
        stripped.get(digits..).unwrap_or("")
    } else {
        rest
    };
    if rest != "Z" && !rest.is_empty() {
        let sign = rest.chars().next()?;
        let hours: i64 = rest.get(1..3)?.parse().ok()?;
        let minutes: i64 = rest.get(4..6)?.parse().ok()?;
        let offset = hours * 3_600 + minutes * 60;
        unix -= if sign == '+' { offset } else { -offset };
    }
    Some(unix.saturating_mul(1000))
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> i64 {
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + u64::from(day_of_year);
    i64::from(era) * 146_097 + day_of_era as i64 - 719_468
}

fn trim_base(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

fn truncate(value: &str) -> String {
    value.chars().take(500).collect()
}

async fn request_status(
    http: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<StatusCode, AppError> {
    let response = http.get(url).bearer_auth(token).send().await?;
    Ok(response.status())
}

async fn db_call<T: Send + 'static>(
    db: Db,
    f: impl FnOnce(Db) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || f(db))
        .await
        .map_err(|err| AppError::Message(format!("database thread stopped: {err}")))?
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[test]
    fn remote_list_keeps_names_and_times() {
        let page = parse_memo_page(
            r#"{"memos":[{"name":"memos/abc","content":"Hello\n\nmore","createTime":"2024-06-01T12:00:00Z","updateTime":"2024-06-02T08:30:00Z","state":"NORMAL"},{"name":"memos/old","content":"gone","state":"ARCHIVED"}],"nextPageToken":"next"}"#,
        )
        .unwrap();
        assert_eq!(page.next_page_token, "next");
        assert_eq!(page.memos.len(), 1);
        assert_eq!(page.memos[0].name, "memos/abc");
        assert_eq!(page.memos[0].created_at, 1_717_243_200_000);
        assert_eq!(preview_line(&page.memos[0].content), "Hello");
    }

    #[test]
    fn unchanged_server_memo_is_left_alone() {
        let local = RemoteLink {
            id: "1".into(),
            content: "hello".into(),
            sync_state: "synced".into(),
            base_content: Some("hello".into()),
            remote_updated_at: Some(50),
        };
        assert_eq!(remote_change(None, 10), RemoteChange::New);
        assert_eq!(remote_change(Some(&local), 50), RemoteChange::Unchanged);
        assert_eq!(remote_change(Some(&local), 60), RemoteChange::Pull);
        let dirty = RemoteLink {
            base_content: Some("hello".into()),
            content: "edited".into(),
            ..local
        };
        assert_eq!(remote_change(Some(&dirty), 60), RemoteChange::Conflict);
        let stub = RemoteLink {
            content: "Hello".into(),
            sync_state: REMOTE.into(),
            base_content: None,
            remote_updated_at: Some(50),
            ..dirty
        };
        assert_eq!(remote_change(Some(&stub), 60), RemoteChange::UpdateStub);
    }

    #[test]
    fn create_body_is_private_markdown() {
        let body = create_body("hello **there**");
        assert_eq!(body["content"], "hello **there**");
        assert_eq!(body["visibility"], "PRIVATE");
    }

    #[tokio::test]
    async fn probe_falls_back_when_latest_is_gone() {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let base = spawn_server(vec![
            (410, "{}"),
            (200, r#"{"memos":[]}"#),
        ], hits.clone());
        let flavor = probe(&test_client(), &base, "memos_pat_test").await.unwrap();
        assert_eq!(flavor, ApiFlavor::V1);
        let paths = hits.lock().unwrap().clone();
        assert!(paths.iter().any(|path| path.contains("/api/memos")));
        assert!(paths.iter().any(|path| path.contains("/api/v1/memos")));
    }

    #[tokio::test]
    async fn create_memo_posts_private_body_and_reads_name() {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let base = spawn_server_capturing(
            vec![(200, r#"{"name":"memos/abc123"}"#)],
            hits,
            bodies.clone(),
        );
        let name = create_memo(
            &test_client(),
            &base,
            ApiFlavor::Latest,
            "memos_pat_test",
            "note body",
        )
        .await
        .unwrap();
        assert_eq!(name, "memos/abc123");
        let captured = bodies.lock().unwrap().join("");
        assert!(captured.contains("\"content\":\"note body\""));
        assert!(captured.contains("\"visibility\":\"PRIVATE\""));
        assert!(!captured.contains("memos_pat_test"));
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .build()
            .unwrap()
    }

    fn spawn_server(responses: Vec<(u16, &'static str)>, hits: Arc<Mutex<Vec<String>>>) -> String {
        spawn_server_capturing(responses, hits, Arc::new(Mutex::new(Vec::new())))
    }

    fn spawn_server_capturing(
        responses: Vec<(u16, &'static str)>,
        hits: Arc<Mutex<Vec<String>>>,
        bodies: Arc<Mutex<Vec<String>>>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let text = read_request(&mut stream);
                if let Some(line) = text.lines().next() {
                    hits.lock().unwrap().push(line.to_string());
                }
                if let Some(index) = text.find("\r\n\r\n") {
                    bodies.lock().unwrap().push(text[index + 4..].to_string());
                }
                let header = format!(
                    "HTTP/1.1 {status} STATUS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = Vec::new();
        let mut tmp = [0_u8; 2048];
        loop {
            match stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    let text = String::from_utf8_lossy(&buf);
                    if let Some(header_end) = text.find("\r\n\r\n") {
                        let body_len = text[..header_end]
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                if name.eq_ignore_ascii_case("content-length") {
                                    value.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                        if text.len() >= header_end + 4 + body_len {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }
}
