use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use tauri::Emitter;

use crate::error::AppError;
use crate::media;
use crate::state::AppState;

use super::db::{canonical_visibility, Db, RemoteLink, API_FLAVOR, BASE_URL, MEMO_SPACE, MEMO_VISIBILITY};
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

    pub fn spaces_path(self) -> &'static str {
        match self {
            Self::Latest => "/api/spaces",
            Self::V1 => "/api/v1/spaces",
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
        return materialize_remote(&state.db, &state.http, &state.media_dir, &id).await;
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
            let media_dir = state.media_dir.clone();
            let _ = reply.send(materialize_remote(&db, &http, &media_dir, &id).await);
        }
        Job::KeepLocal(id, reply) => {
            let state = app.state::<AppState>();
            let db = state.db.clone();
            let http = state.http.clone();
            let media_dir = state.media_dir.clone();
            let _ = reply.send(push_local_choice(&db, &http, &media_dir, &id).await);
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
    let media_dir = state.media_dir.clone();
    let mut retries = 0;
    let mut report = DrainReport::default();
    loop {
        match drain(db.clone(), &http, &media_dir, refresh && retries == 0).await {
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

async fn drain(
    db: Db,
    http: &reqwest::Client,
    media_dir: &std::path::Path,
    refresh: bool,
) -> Result<DrainReport, AppError> {
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
        match refresh_index(http, &db, media_dir, &base, &token, flavor).await {
            Ok(()) => indexed = true,
            Err(err) => eprintln!("memose: remote list failed: {err}"),
        }
    }
    let notes = db_call(db.clone(), |db| db.pending_and_errors()).await?;
    let mut retry = false;
    let mut did_push = false;
    for note in notes {
        let refs = media::extract_refs(&note.content);
        let remote = media::content_for_remote(&note.content);
        if remote.is_empty() && refs.is_empty() && note.remote_name.is_none() {
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
        let (default_visibility, default_space) = db_call(db.clone(), |db| {
            Ok((
                db.get_meta(MEMO_VISIBILITY)?.unwrap_or_else(|| "PRIVATE".into()),
                db.get_meta(MEMO_SPACE)?.unwrap_or_default(),
            ))
        })
        .await?;
        let (visibility, space) = push_audience(
            note.visibility.as_deref(),
            note.space.as_deref(),
            &default_visibility,
            &default_space,
        );
        let pushed = if let Some(name) = note.remote_name.clone() {
            update_memo(http, &base, flavor, &token, &name, &remote, &visibility, &space)
                .await
                .map(|()| name)
        } else {
            create_memo(http, &base, flavor, &token, &remote, &visibility, &space).await
        };
        match pushed {
            Ok(name) => {
                if !refs.is_empty() {
                    if let Err(err) = sync_memo_attachments(
                        http,
                        &db,
                        media_dir,
                        &base,
                        flavor,
                        &token,
                        &name,
                        &refs,
                    )
                    .await
                    {
                        eprintln!("memose: attachment upload failed: {err}");
                    }
                }
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
                    let visibility = visibility.clone();
                    let space = space.clone();
                    let _ = db_call(db.clone(), move |db| {
                        db.remember_audience(&id, &visibility, &space)
                    })
                    .await;
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
    media_dir: &std::path::Path,
    base: &str,
    token: &str,
    flavor: ApiFlavor,
) -> Result<(), AppError> {
    let mut page_token = String::new();
    for _ in 0..4 {
        let page = list_memos(http, base, flavor, token, &page_token).await?;
        for memo in page.memos {
            apply_remote_memo(http, db, media_dir, base, token, memo).await?;
        }
        if page.next_page_token.is_empty() {
            break;
        }
        page_token = page.next_page_token;
    }
    Ok(())
}

async fn apply_remote_memo(
    http: &reqwest::Client,
    db: &Db,
    media_dir: &std::path::Path,
    base: &str,
    token: &str,
    memo: RemoteMemo,
) -> Result<(), AppError> {
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
            let visibility = memo.visibility.clone();
            let space = memo.space.clone();
            db_call(db.clone(), move |db| {
                db.insert_remote_stub(&name, &preview, created, updated, &visibility, &space)
            })
            .await
        }
        RemoteChange::UpdateStub => {
            let Some(link) = link else {
                return Ok(());
            };
            let preview = preview_line(&memo.content);
            let updated = memo.updated_at;
            let visibility = memo.visibility.clone();
            let space = memo.space.clone();
            db_call(db.clone(), move |db| {
                db.touch_remote_stub(&link.id, &preview, updated, &visibility, &space)
            })
            .await
        }
        RemoteChange::Pull | RemoteChange::Conflict => {
            let Some(link) = link else {
                return Ok(());
            };
            let id = link.id;
            let raw = link.content;
            let downloaded = download_remote_attachments(
                http,
                db,
                media_dir,
                base,
                token,
                &memo.name,
                &memo.attachments,
            )
            .await;
            let server_with_att = append_markdown_lines(&memo.content, &downloaded);
            let updated = memo.updated_at;
            let local_text = media::content_for_remote(&raw);
            if local_text == memo.content.trim() && downloaded.is_empty() {
                return db_call(db.clone(), move |db| db.acknowledge_remote(&id, updated)).await;
            }
            let merged = media::merge_local_media(&raw, &server_with_att);
            if change == RemoteChange::Conflict {
                return db_call(db.clone(), move |db| db.store_conflict(&id, &merged, updated)).await;
            }
            let visibility = memo.visibility.clone();
            let space = memo.space.clone();
            db_call(db.clone(), move |db| {
                db.apply_server_body(&id, &merged, updated, &visibility, &space)
            })
            .await
        }
    }
}

pub async fn materialize_remote(
    db: &Db,
    http: &reqwest::Client,
    media_dir: &std::path::Path,
    id: &str,
) -> Result<super::model::Note, AppError> {
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
    let downloaded = download_remote_attachments(
        http,
        db,
        media_dir,
        &base,
        &token,
        &full.name,
        &full.attachments,
    )
    .await;
    let updated = full.updated_at;
    let content = append_markdown_lines(&full.content, &downloaded);
    let visibility = full.visibility.clone();
    let space = full.space.clone();
    let id_owned = note.id.clone();
    db_call(db.clone(), move |db| {
        db.apply_server_body(&id_owned, &content, updated, &visibility, &space)
    })
    .await?;
    let id_owned = note.id;
    db_call(db.clone(), move |db| {
        db.get(&id_owned)?
            .ok_or_else(|| AppError::Message("note disappeared".into()))
    })
    .await
}

pub async fn push_local_choice(
    db: &Db,
    http: &reqwest::Client,
    media_dir: &std::path::Path,
    id: &str,
) -> Result<super::model::Note, AppError> {
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
    let (default_visibility, default_space) = db_call(db.clone(), |db| {
        Ok((
            db.get_meta(MEMO_VISIBILITY)?.unwrap_or_else(|| "PRIVATE".into()),
            db.get_meta(MEMO_SPACE)?.unwrap_or_default(),
        ))
    })
    .await?;
    let refs = media::extract_refs(&note.content);
    let remote = media::content_for_remote(&note.content);
    let (visibility, space) = push_audience(
        note.visibility.as_deref(),
        note.space.as_deref(),
        &default_visibility,
        &default_space,
    );
    update_memo(http, &base, flavor, &token, &name, &remote, &visibility, &space).await?;
    if !refs.is_empty() {
        let _ = sync_memo_attachments(http, db, media_dir, &base, flavor, &token, &name, &refs).await;
    }
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
    visibility: &str,
    space: &str,
) -> Result<String, AppError> {
    let url = format!("{}{}", trim_base(base), flavor.path());
    let response = http
        .post(url)
        .bearer_auth(token)
        .json(&create_body(content, visibility, space))
        .send()
        .await?;
    let status = response.status();
    if status == StatusCode::BAD_REQUEST && !space.is_empty() {
        return Box::pin(create_memo(http, base, flavor, token, content, visibility, "")).await;
    }
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

#[derive(Clone, Debug)]
struct RemoteAttachment {
    name: String,
    filename: String,
    mime_type: String,
}

struct RemoteMemo {
    name: String,
    content: String,
    created_at: i64,
    updated_at: i64,
    visibility: String,
    space: String,
    attachments: Vec<RemoteAttachment>,
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

#[allow(clippy::too_many_arguments)]
async fn update_memo(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    name: &str,
    content: &str,
    visibility: &str,
    space: &str,
) -> Result<(), AppError> {
    let response = http
        .patch(memo_url(base, flavor, name))
        .bearer_auth(token)
        .query(&[("updateMask", "content,visibility,space")])
        .json(&json!({
            "content": content,
            "visibility": canonical_visibility(visibility),
            "space": if space.is_empty() { Value::Null } else { json!(space) },
        }))
        .send()
        .await?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    if status == StatusCode::BAD_REQUEST {
        let response = http
            .patch(memo_url(base, flavor, name))
            .bearer_auth(token)
            .query(&[("updateMask", "content,visibility")])
            .json(&json!({
                "content": content,
                "visibility": canonical_visibility(visibility),
            }))
            .send()
            .await?;
        let retry_status = response.status();
        if retry_status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Memos {
            status: retry_status.as_u16(),
            body: truncate(&body),
        });
    }
    let body = response.text().await.unwrap_or_default();
    Err(AppError::Memos {
        status: status.as_u16(),
        body: truncate(&body),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoSpace {
    pub name: String,
    pub title: String,
}

pub async fn list_spaces(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
) -> Result<Vec<MemoSpace>, AppError> {
    let url = format!(
        "{}{}?pageSize=100",
        trim_base(base),
        flavor.spaces_path()
    );
    let response = http.get(&url).bearer_auth(token).send().await?;
    let status = response.status();
    if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
        return Ok(Vec::new());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Memos {
            status: status.as_u16(),
            body: truncate(&body),
        });
    }
    let body = response.text().await?;
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let items = value
        .get("spaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| {
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
        })
        .collect())
}

pub async fn delete_remote_memo(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    name: &str,
) -> Result<(), AppError> {
    let url = memo_url(base, flavor, name);
    let forced = delete_once(http, token, &format!("{url}?force=true")).await?;
    if forced.is_success() || forced == StatusCode::NOT_FOUND {
        return Ok(());
    }
    if forced == StatusCode::BAD_REQUEST {
        let plain = delete_once(http, token, &url).await?;
        if plain.is_success() || plain == StatusCode::NOT_FOUND {
            return Ok(());
        }
        return Err(AppError::Memos {
            status: plain.as_u16(),
            body: String::new(),
        });
    }
    Err(AppError::Memos {
        status: forced.as_u16(),
        body: String::new(),
    })
}

async fn delete_once(http: &reqwest::Client, token: &str, url: &str) -> Result<StatusCode, AppError> {
    let response = http.delete(url).bearer_auth(token).send().await?;
    let status = response.status();
    if status.is_success() || status == StatusCode::NOT_FOUND || status == StatusCode::BAD_REQUEST {
        return Ok(status);
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
    let memos = items.iter().filter_map(parse_memo_object).collect();
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
                        .and_then(|id| id.as_i64().map(|n| n.to_string()).or_else(|| id.as_str().map(str::to_string)))
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
            if !out.iter().any(|existing: &RemoteAttachment| existing.name == name) {
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

fn append_markdown_lines(content: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        return content.to_string();
    }
    let mut parts = Vec::new();
    let trimmed = content.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    for line in lines {
        let already_in_content = trimmed.lines().any(|existing| existing.trim() == line.trim());
        if !already_in_content && !parts.iter().any(|p| p == line) {
            parts.push(line.clone());
        }
    }
    parts.join("\n")
}

#[allow(clippy::too_many_arguments)]
async fn sync_memo_attachments(
    http: &reqwest::Client,
    db: &Db,
    media_dir: &std::path::Path,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    memo_name: &str,
    refs: &[media::MediaRef],
) -> Result<(), AppError> {
    let mut remote_names = Vec::new();
    for item in refs {
        let local_name = item.name.clone();
        let existing = db_call(db.clone(), {
            let local_name = local_name.clone();
            move |db| db.media_upload_for_local(&local_name)
        })
        .await?;
        if let Some((remote_name, uploaded_memo)) = existing {
            remote_names.push(remote_name.clone());
            if uploaded_memo == memo_name {
                continue;
            }
        }
        let Ok(path) = media::resolve(media_dir, &item.name) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let filename = if !item.label.trim().is_empty() {
            item.label.trim().to_string()
        } else {
            item.name.clone()
        };
        let mime_type = media::mime_for_name(&filename);
        let remote_res = upload_attachment(
            http,
            base,
            flavor,
            token,
            memo_name,
            &filename,
            mime_type,
            &bytes,
        )
        .await?;
        remote_names.push(remote_res.clone());
        let memo_owned = memo_name.to_string();
        let filename_owned = filename.clone();
        let _ = db_call(db.clone(), move |db| {
            db.record_media_upload(&local_name, &remote_res, &memo_owned, &filename_owned)
        })
        .await;
    }
    if !remote_names.is_empty() {
        let _ = link_memo_attachments(http, base, flavor, token, memo_name, &remote_names).await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn upload_attachment(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    memo_name: &str,
    filename: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    let encoded = media::base64_encode(bytes);
    let body = json!({
        "filename": filename,
        "type": mime_type,
        "content": encoded,
        "memo": memo_name,
    });
    let endpoints = match flavor {
        ApiFlavor::Latest => [
            "/api/v1/attachments",
            "/api/v1/resources",
            "/api/attachments",
            "/api/resources",
        ],
        ApiFlavor::V1 => [
            "/api/v1/resources",
            "/api/v1/attachments",
            "/api/resources",
            "/api/attachments",
        ],
    };
    let mut last_err = AppError::Message("attachment upload failed".into());
    for endpoint in endpoints {
        let url = format!("{}{}", trim_base(base), endpoint);
        let Ok(response) = http.post(&url).bearer_auth(token).json(&body).send().await else {
            continue;
        };
        let status = response.status();
        if status.is_success() {
            if let Ok(payload) = response.json::<Value>().await {
                if let Some(name) = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return Ok(name.to_string());
                }
            }
        } else {
            let text = response.text().await.unwrap_or_default();
            last_err = AppError::Memos {
                status: status.as_u16(),
                body: truncate(&text),
            };
        }
    }
    Err(last_err)
}

async fn link_memo_attachments(
    http: &reqwest::Client,
    base: &str,
    flavor: ApiFlavor,
    token: &str,
    memo_name: &str,
    remote_names: &[String],
) -> Result<(), AppError> {
    let items: Vec<Value> = remote_names.iter().map(|n| json!({ "name": n })).collect();
    let uses_attachments = remote_names.iter().any(|n| n.starts_with("attachments/"));
    let field = if uses_attachments { "attachments" } else { "resources" };
    let url = memo_url(base, flavor, memo_name);
    let _ = http
        .patch(&url)
        .bearer_auth(token)
        .query(&[("updateMask", field)])
        .json(&json!({ field: items }))
        .send()
        .await;
    Ok(())
}

async fn download_remote_attachments(
    http: &reqwest::Client,
    db: &Db,
    media_dir: &std::path::Path,
    base: &str,
    token: &str,
    memo_name: &str,
    attachments: &[RemoteAttachment],
) -> Vec<String> {
    let mut lines = Vec::new();
    for att in attachments {
        let remote_name = att.name.clone();
        let cached = db_call(db.clone(), {
            let remote_name = remote_name.clone();
            move |db| db.media_local_for_remote(&remote_name)
        })
        .await
        .ok()
        .flatten();
        if let Some((local_name, filename)) = cached {
            if media::resolve(media_dir, &local_name).is_ok() {
                lines.push(media::format_markdown(&local_name, &filename));
                continue;
            }
        }
        let encoded_file = urlencoding_token(&att.filename);
        let url = format!("{}/file/{}/{}", trim_base(base), att.name.trim_start_matches('/'), encoded_file);
        let Ok(response) = http.get(&url).bearer_auth(token).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response.bytes().await else {
            continue;
        };
        let Ok(md) = media::save_named(
            media_dir,
            &bytes,
            Some(&att.filename),
            Some(&att.mime_type),
        ) else {
            continue;
        };
        if let Some(parsed) = media::parse_media_token(&md) {
            let local_name = parsed.name;
            let remote_owned = att.name.clone();
            let memo_owned = memo_name.to_string();
            let filename_owned = att.filename.clone();
            let _ = db_call(db.clone(), move |db| {
                db.record_media_upload(&local_name, &remote_owned, &memo_owned, &filename_owned)
            })
            .await;
        }
        lines.push(md);
    }
    lines
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
    let mut millis: i64 = 0;
    let rest = if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped.chars().take_while(|ch| ch.is_ascii_digit()).count();
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
        let body = create_body("hello **there**", "PRIVATE", "");
        assert_eq!(body["content"], "hello **there**");
        assert_eq!(body["visibility"], "PRIVATE");
        assert!(body.get("space").is_none());
        let placed = create_body("hello", "space", "spaces/team");
        assert_eq!(placed["visibility"], "SPACE");
        assert_eq!(placed["space"], "spaces/team");
    }

    #[test]
    fn push_audience_prefers_the_note_then_the_default() {
        assert_eq!(
            push_audience(None, None, "PROTECTED", "spaces/team"),
            ("PROTECTED".into(), "spaces/team".into())
        );
        assert_eq!(
            push_audience(Some("PUBLIC"), Some(""), "PRIVATE", "spaces/team"),
            ("PUBLIC".into(), String::new())
        );
        assert_eq!(
            push_audience(Some("SPACE"), Some(""), "PRIVATE", ""),
            ("PRIVATE".into(), String::new())
        );
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
    async fn delete_retries_without_force_when_the_server_rejects_it() {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let base = spawn_server(vec![(400, "{}"), (200, "{}")], hits.clone());
        delete_remote_memo(&test_client(), &base, ApiFlavor::V1, "memos_pat_test", "memos/abc")
            .await
            .unwrap();
        let paths = hits.lock().unwrap().clone();
        assert!(paths[0].contains("DELETE") && paths[0].contains("force=true"));
        assert!(paths[1].contains("DELETE") && !paths[1].contains("force=true"));
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
            "PRIVATE",
            "",
        )
        .await
        .unwrap();
        assert_eq!(name, "memos/abc123");
        let captured = bodies.lock().unwrap().join("");
        assert!(captured.contains("\"content\":\"note body\""));
        assert!(captured.contains("\"visibility\":\"PRIVATE\""));
        assert!(!captured.contains("memos_pat_test"));
    }

    #[test]
    fn rfc3339_timestamps_and_local_media_merging_stay_consistent() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01.250Z"), Some(1_250));
        assert_eq!(parse_rfc3339_ms("1970-01-01T02:00:00+02:00"), Some(0));
        assert_eq!(parse_rfc3339_ms("invalid-date"), None);

        let local = "hello\n![pic](memose-media/12345678-pic.png)";
        let merged = crate::media::merge_local_media(local, "updated remote text");
        assert_eq!(merged, "updated remote text\n![pic](memose-media/12345678-pic.png)");

        let appended = append_markdown_lines(
            &merged,
            &["![pic](memose-media/12345678-pic.png)".to_string(), "[doc.pdf](memose-media/87654321-doc.pdf)".to_string()],
        );
        assert_eq!(
            appended,
            "updated remote text\n![pic](memose-media/12345678-pic.png)\n[doc.pdf](memose-media/87654321-doc.pdf)"
        );
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
