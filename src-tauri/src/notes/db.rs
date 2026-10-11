use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::AppError;

use super::model::{commit_state, Note, CONFLICT, DRAFT, ERROR, LOCAL, PENDING, REMOTE, SYNCED};

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppError> {
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self, AppError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self, AppError> {
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 2000;
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sync_state TEXT NOT NULL,
                remote_name TEXT,
                last_error TEXT
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;
        ensure_pin_columns(&conn)?;
        ensure_sync_columns(&conn)?;
        ensure_look_columns(&conn)?;
        ensure_audience_columns(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, AppError>) -> Result<T, AppError> {
        let conn = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&conn)
    }

    pub fn upsert_draft(&self, content: &str) -> Result<Option<Note>, AppError> {
        let trimmed = content.trim();
        self.with(|conn| {
            if trimmed.is_empty() {
                conn.execute("DELETE FROM notes WHERE sync_state = ?1", params![DRAFT])?;
                return Ok(None);
            }
            let now = now_ms();
            if let Some(existing) = draft(conn)? {
                conn.execute(
                    "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
                    params![trimmed, now, existing.id],
                )?;
                return note_by_id(conn, &existing.id);
            }
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO notes (id, content, created_at, updated_at, sync_state, remote_name, last_error)
                 VALUES (?1, ?2, ?3, ?3, ?4, NULL, NULL)",
                params![id, trimmed, now, DRAFT],
            )?;
            note_by_id(conn, &id)
        })
    }

    pub fn load_draft(&self) -> Result<Option<Note>, AppError> {
        self.with(draft)
    }

    pub fn finalize_content(&self, content: &str) -> Result<bool, AppError> {
        let trimmed = content.trim().to_string();
        self.with(|conn| {
            if trimmed.is_empty() {
                conn.execute("DELETE FROM notes WHERE sync_state = ?1", params![DRAFT])?;
                return Ok(false);
            }
            let state = commit_state(has_base_url(conn)?);
            let now = now_ms();
            if let Some(existing) = draft(conn)? {
                conn.execute(
                    "UPDATE notes
                     SET content = ?1, updated_at = ?2, sync_state = ?3, last_error = NULL
                     WHERE id = ?4",
                    params![trimmed, now, state, existing.id],
                )?;
            } else {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO notes (id, content, created_at, updated_at, sync_state, remote_name, last_error)
                     VALUES (?1, ?2, ?3, ?3, ?4, NULL, NULL)",
                    params![id, trimmed, now, state],
                )?;
            }
            Ok(true)
        })
    }

    pub fn finalize_stored_draft(&self) -> Result<bool, AppError> {
        let content = self.with(draft)?.map(|note| note.content).unwrap_or_default();
        self.finalize_content(&content)
    }

    pub fn save_edit(&self, id: &str, content: &str) -> Result<(bool, bool), AppError> {
        let trimmed = content.trim().to_string();
        if trimmed.is_empty() {
            return Ok((false, false));
        }
        self.with(|conn| {
            let linked = conn
                .query_row(
                    "SELECT sync_state, remote_name, content FROM notes WHERE id = ?1 AND sync_state != ?2",
                    params![id, DRAFT],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((state, remote_name, existing)) = linked else {
                return Ok((false, false));
            };
            let queued = state == PENDING || state == ERROR;
            if existing == trimmed {
                return Ok((false, queued));
            }
            let push_edit = state == SYNCED && remote_name.is_some();
            conn.execute(
                "UPDATE notes
                 SET base_content = COALESCE(base_content, content),
                     content = ?1,
                     updated_at = ?2,
                     sync_state = CASE WHEN ?3 THEN ?4 ELSE sync_state END
                 WHERE id = ?5",
                params![trimmed, now_ms(), push_edit, PENDING, id],
            )?;
            Ok((true, push_edit || queued))
        })
    }

    pub fn list_recent(&self, limit: u32) -> Result<Vec<Note>, AppError> {
        let limit = limit.clamp(1, 200);
        self.with(|conn| {
            let mut stmt = conn.prepare(LIST_RECENT)?;
            let rows = stmt.query_map(params![DRAFT, limit], map_note)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })
    }

    pub fn pending_and_errors(&self) -> Result<Vec<Note>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(LIST_PENDING)?;
            let rows = stmt.query_map(params![PENDING, ERROR], map_note)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Note>, AppError> {
        self.with(|conn| note_by_id(conn, id))
    }

    pub fn publish_note(&self, id: Option<&str>, content: &str) -> Result<Note, AppError> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Err(AppError::Message("empty note".into()));
        }
        if let Some(id) = id {
            if let Some(existing) = self.get(id)? {
                if existing.sync_state == DRAFT {
                    self.finalize_content(trimmed)?;
                } else {
                    let _ = self.save_edit(id, trimmed)?;
                }
                return self
                    .get(id)?
                    .ok_or_else(|| AppError::Message("note disappeared".into()));
            }
        }
        let draft = self
            .upsert_draft(trimmed)?
            .ok_or_else(|| AppError::Message("empty note".into()))?;
        self.finalize_content(trimmed)?;
        self.get(&draft.id)?
            .ok_or_else(|| AppError::Message("note disappeared".into()))
    }

    pub fn remember_audience(&self, id: &str, visibility: &str, space: &str) -> Result<(), AppError> {
        let visibility = canonical_visibility(visibility);
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET visibility = ?1, remote_space = ?2 WHERE id = ?3",
                params![visibility, space.trim(), id],
            )?;
            Ok(())
        })
    }

    pub fn set_audience(&self, id: &str, visibility: &str, space: &str) -> Result<bool, AppError> {
        let visibility = canonical_visibility(visibility);
        let space = space.trim().to_string();
        if visibility == "SPACE" && space.is_empty() {
            return Err(AppError::Message(
                "space members visibility needs a space".into(),
            ));
        }
        self.with(|conn| {
            let linked: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT sync_state, remote_name FROM notes WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((state, remote_name)) = linked else {
                return Ok(false);
            };
            let push = (state == SYNCED || state == PENDING || state == ERROR) && remote_name.is_some();
            conn.execute(
                "UPDATE notes
                 SET visibility = ?1,
                     remote_space = ?2,
                     sync_state = CASE WHEN ?3 THEN ?4 ELSE sync_state END
                 WHERE id = ?5",
                params![visibility, space, push && state == SYNCED, PENDING, id],
            )?;
            Ok(push)
        })
    }

    pub fn delete_note(&self, id: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET pinned = ?1 WHERE id = ?2 AND sync_state != ?3",
                params![pinned, id, DRAFT],
            )?;
            Ok(())
        })
    }

    pub fn save_frame(&self, id: &str, x: i32, y: i32, w: i32, h: i32) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET win_x = ?1, win_y = ?2, win_w = ?3, win_h = ?4 WHERE id = ?5",
                params![x, y, w, h, id],
            )?;
            Ok(())
        })
    }

    pub fn save_look(
        &self,
        id: &str,
        opacity: u8,
        hue_light: Option<u16>,
        hue_dark: Option<u16>,
        swatches: &[u16],
    ) -> Result<(), AppError> {
        let opacity = opacity.min(100);
        let hue_light = hue_light.filter(|hue| *hue <= 359);
        let hue_dark = hue_dark.filter(|hue| *hue <= 359);
        let stored = encode_swatches(swatches);
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET opacity = ?1, hue_light = ?2, hue_dark = ?3, swatches = ?4
                 WHERE id = ?5",
                params![opacity, hue_light, hue_dark, stored, id],
            )?;
            Ok(())
        })
    }

    pub fn set_pinned_opacity(&self, opacity: u8) -> Result<(), AppError> {
        let opacity = opacity.min(100);
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET opacity = ?1 WHERE pinned = 1 AND sync_state != ?2",
                params![opacity, DRAFT],
            )?;
            Ok(())
        })
    }

    pub fn list_pinned(&self) -> Result<Vec<Note>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(LIST_PINNED)?;
            let rows = stmt.query_map(params![DRAFT], map_note)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })
    }

    pub fn remember_remote_name(&self, id: &str, remote_name: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET remote_name = ?1 WHERE id = ?2 AND sync_state IN (?3, ?4)",
                params![remote_name, id, PENDING, ERROR],
            )?;
            Ok(())
        })
    }

    pub fn complete_push(&self, id: &str, remote_name: &str, pushed: &str) -> Result<bool, AppError> {
        self.with(|conn| {
            let now = now_ms();
            let changed = conn.execute(
                "UPDATE notes
                 SET sync_state = ?1,
                     remote_name = ?2,
                     last_error = NULL,
                     base_content = content,
                     remote_content = NULL,
                     remote_updated_at = ?3
                 WHERE id = ?4 AND content = ?5",
                params![SYNCED, remote_name, now, id, pushed],
            )?;
            Ok(changed == 1)
        })
    }

    pub fn mark_synced(&self, id: &str, remote_name: &str) -> Result<(), AppError> {
        self.with(|conn| {
            let now = now_ms();
            conn.execute(
                "UPDATE notes
                 SET sync_state = ?1,
                     remote_name = ?2,
                     last_error = NULL,
                     updated_at = ?3,
                     base_content = content,
                     remote_content = NULL,
                     remote_updated_at = ?3
                 WHERE id = ?4",
                params![SYNCED, remote_name, now, id],
            )?;
            Ok(())
        })
    }

    pub fn mark_local(&self, id: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET sync_state = ?1, last_error = NULL, updated_at = ?2 WHERE id = ?3",
                params![LOCAL, now_ms(), id],
            )?;
            Ok(())
        })
    }

    pub fn mark_error(&self, id: &str, message: &str) -> Result<(), AppError> {
        let message: String = message.chars().take(500).collect();
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET sync_state = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
                params![ERROR, message, now_ms(), id],
            )?;
            Ok(())
        })
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, AppError> {
        self.with(|conn| get_meta(conn, key))
    }

    pub fn clear_meta(&self, key: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
            Ok(())
        })
    }

    pub fn set_base_url(&self, url: &str) -> Result<(), AppError> {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            self.clear_meta(BASE_URL)?;
            self.clear_meta(API_FLAVOR)?;
            return Ok(());
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            return Err(AppError::Message(
                "server URL must start with http:// or https://".into(),
            ));
        }
        let previous = self.get_meta(BASE_URL)?;
        self.set_meta(BASE_URL, &trimmed)?;
        if previous.as_deref() != Some(trimmed.as_str()) {
            self.clear_meta(API_FLAVOR)?;
        }
        Ok(())
    }

    pub fn access_token(&self) -> Result<Option<String>, AppError> {
        Ok(self
            .get_meta(ACCESS_TOKEN)?
            .filter(|token| !token.is_empty()))
    }

    pub fn set_access_token(&self, token: &str) -> Result<(), AppError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return self.clear_access_token();
        }
        self.set_meta(ACCESS_TOKEN, trimmed)
    }

    pub fn clear_access_token(&self) -> Result<(), AppError> {
        self.clear_meta(ACCESS_TOKEN)
    }

    pub fn remote_link(&self, remote_name: &str) -> Result<Option<RemoteLink>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, sync_state, base_content, remote_updated_at
                 FROM notes WHERE remote_name = ?1 AND sync_state != ?2
                 LIMIT 1",
            )?;
            let mut rows = stmt.query(params![remote_name, DRAFT])?;
            let Some(row) = rows.next()? else {
                return Ok(None);
            };
            Ok(Some(RemoteLink {
                id: row.get(0)?,
                content: row.get(1)?,
                sync_state: row.get(2)?,
                base_content: row.get(3)?,
                remote_updated_at: row.get(4)?,
            }))
        })
    }

    pub fn insert_remote_stub(
        &self,
        remote_name: &str,
        preview: &str,
        created_at: i64,
        updated_at: i64,
        visibility: &str,
        space: &str,
    ) -> Result<(), AppError> {
        let id = Uuid::new_v4().to_string();
        self.with(|conn| {
            conn.execute(
                "INSERT INTO notes (
                    id, content, created_at, updated_at, sync_state, remote_name, last_error, remote_updated_at, visibility, remote_space
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?4, ?7, ?8)",
                params![
                    id,
                    preview,
                    created_at,
                    updated_at,
                    REMOTE,
                    remote_name,
                    canonical_visibility(visibility),
                    space
                ],
            )?;
            Ok(())
        })
    }

    pub fn touch_remote_stub(
        &self,
        id: &str,
        preview: &str,
        updated_at: i64,
        visibility: &str,
        space: &str,
    ) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET content = ?1, updated_at = ?2, remote_updated_at = ?2, visibility = ?3, remote_space = ?4
                 WHERE id = ?5 AND sync_state = ?6",
                params![preview, updated_at, canonical_visibility(visibility), space, id, REMOTE],
            )?;
            Ok(())
        })
    }

    pub fn apply_server_body(
        &self,
        id: &str,
        content: &str,
        updated_at: i64,
        visibility: &str,
        space: &str,
    ) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET content = ?1,
                     base_content = ?1,
                     remote_content = NULL,
                     remote_updated_at = ?2,
                     sync_state = ?3,
                     last_error = NULL,
                     updated_at = ?2,
                     visibility = ?5,
                     remote_space = ?6
                 WHERE id = ?4",
                params![content, updated_at, SYNCED, id, canonical_visibility(visibility), space],
            )?;
            Ok(())
        })
    }

    pub fn acknowledge_remote(&self, id: &str, updated_at: i64) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET remote_updated_at = ?1 WHERE id = ?2",
                params![updated_at, id],
            )?;
            Ok(())
        })
    }

    pub fn store_conflict(&self, id: &str, server_content: &str, updated_at: i64) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET sync_state = ?1, remote_content = ?2, remote_updated_at = ?3, last_error = NULL
                 WHERE id = ?4",
                params![CONFLICT, server_content, updated_at, id],
            )?;
            Ok(())
        })
    }

    pub fn resolve_local(&self, id: &str, updated_at: i64) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET sync_state = ?1,
                     base_content = content,
                     remote_content = NULL,
                     remote_updated_at = ?2,
                     last_error = NULL,
                     updated_at = ?2
                 WHERE id = ?3",
                params![SYNCED, updated_at, id],
            )?;
            Ok(())
        })
    }

    pub fn resolve_remote(&self, id: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes
                 SET content = remote_content,
                     base_content = remote_content,
                     sync_state = ?1,
                     remote_content = NULL,
                     last_error = NULL,
                     updated_at = remote_updated_at
                 WHERE id = ?2 AND remote_content IS NOT NULL",
                params![SYNCED, id],
            )?;
            Ok(())
        })
    }
}

pub struct RemoteLink {
    pub id: String,
    pub content: String,
    pub sync_state: String,
    pub base_content: Option<String>,
    pub remote_updated_at: Option<i64>,
}

pub const BASE_URL: &str = "base_url";
pub const MEMO_VISIBILITY: &str = "memo_visibility";
pub const MEMO_SPACE: &str = "memo_space";

pub fn canonical_visibility(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "PROTECTED" => "PROTECTED".into(),
        "PUBLIC" => "PUBLIC".into(),
        "SPACE" => "SPACE".into(),
        _ => "PRIVATE".into(),
    }
}
pub const API_FLAVOR: &str = "api_flavor";
pub const THEME: &str = "theme";
pub const ACCESS_TOKEN: &str = "access_token";
pub const KEYCHAIN_IMPORTED: &str = "keychain_imported";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn has_base_url(conn: &Connection) -> Result<bool, AppError> {
    Ok(get_meta(conn, BASE_URL)?
        .map(|url| !url.is_empty())
        .unwrap_or(false))
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

macro_rules! note_sql {
    ($tail:literal) => {
        concat!(
            "SELECT id, content, created_at, updated_at, sync_state, remote_name, last_error, pinned, win_x, win_y, win_w, win_h, opacity, hue_light, hue_dark, swatches, visibility, remote_space ",
            $tail
        )
    };
}

const LIST_RECENT: &str = note_sql!(
    "FROM notes WHERE sync_state != ?1 ORDER BY updated_at DESC, created_at DESC LIMIT ?2"
);
const LIST_PENDING: &str =
    note_sql!("FROM notes WHERE sync_state IN (?1, ?2) ORDER BY created_at ASC");
const LIST_PINNED: &str =
    note_sql!("FROM notes WHERE pinned = 1 AND sync_state != ?1 ORDER BY updated_at DESC");
const LOAD_DRAFT: &str = note_sql!("FROM notes WHERE sync_state = ?1 LIMIT 1");
const LOAD_NOTE: &str = note_sql!("FROM notes WHERE id = ?1");

fn draft(conn: &Connection) -> Result<Option<Note>, AppError> {
    let mut stmt = conn.prepare(LOAD_DRAFT)?;
    let mut rows = stmt.query(params![DRAFT])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_note(row)?))
    } else {
        Ok(None)
    }
}

fn note_by_id(conn: &Connection, id: &str) -> Result<Option<Note>, AppError> {
    let mut stmt = conn.prepare(LOAD_NOTE)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_note(row)?))
    } else {
        Ok(None)
    }
}

fn ensure_pin_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (name, ddl) in [
        (
            "pinned",
            "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
        ),
        ("win_x", "ALTER TABLE notes ADD COLUMN win_x INTEGER"),
        ("win_y", "ALTER TABLE notes ADD COLUMN win_y INTEGER"),
        ("win_w", "ALTER TABLE notes ADD COLUMN win_w INTEGER"),
        ("win_h", "ALTER TABLE notes ADD COLUMN win_h INTEGER"),
    ] {
        if !names.iter().any(|existing| existing == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

fn ensure_sync_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (name, ddl) in [
        ("base_content", "ALTER TABLE notes ADD COLUMN base_content TEXT"),
        ("remote_content", "ALTER TABLE notes ADD COLUMN remote_content TEXT"),
        (
            "remote_updated_at",
            "ALTER TABLE notes ADD COLUMN remote_updated_at INTEGER",
        ),
    ] {
        if !names.iter().any(|existing| existing == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

fn ensure_look_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (name, ddl) in [
        (
            "opacity",
            "ALTER TABLE notes ADD COLUMN opacity INTEGER NOT NULL DEFAULT 100",
        ),
        ("hue_light", "ALTER TABLE notes ADD COLUMN hue_light INTEGER"),
        ("hue_dark", "ALTER TABLE notes ADD COLUMN hue_dark INTEGER"),
        ("swatches", "ALTER TABLE notes ADD COLUMN swatches TEXT"),
    ] {
        if !names.iter().any(|existing| existing == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

fn encode_swatches(swatches: &[u16]) -> Option<String> {
    let hues: Vec<u16> = swatches
        .iter()
        .copied()
        .filter(|hue| *hue <= 359)
        .take(6)
        .collect();
    if hues.is_empty() {
        None
    } else {
        Some(
            hues.iter()
                .map(|hue| hue.to_string())
                .collect::<Vec<_>>()
                .join(","),
        )
    }
}

fn parse_swatches(raw: Option<String>) -> Vec<u16> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    raw.split(',')
        .filter_map(|part| part.trim().parse::<u16>().ok())
        .filter(|hue| *hue <= 359)
        .take(6)
        .collect()
}

fn hue_column(value: Option<i64>) -> Option<u16> {
    value.and_then(|hue| u16::try_from(hue).ok()).filter(|hue| *hue <= 359)
}

fn map_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let pinned: i64 = row.get(7)?;
    let opacity: i64 = row.get(12)?;
    Ok(Note {
        id: row.get(0)?,
        content: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        sync_state: row.get(4)?,
        remote_name: row.get(5)?,
        last_error: row.get(6)?,
        pinned: pinned != 0,
        win_x: row.get(8)?,
        win_y: row.get(9)?,
        win_w: row.get(10)?,
        win_h: row.get(11)?,
        opacity: opacity.clamp(0, 100) as u8,
        hue_light: hue_column(row.get(13)?),
        hue_dark: hue_column(row.get(14)?),
        swatches: parse_swatches(row.get(15)?),
        visibility: row.get(16)?,
        space: row.get(17)?,
    })
}

fn ensure_audience_columns(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    for (name, ddl) in [
        ("visibility", "ALTER TABLE notes ADD COLUMN visibility TEXT"),
        ("remote_space", "ALTER TABLE notes ADD COLUMN remote_space TEXT"),
    ] {
        if !names.iter().any(|existing| existing == name) {
            conn.execute(ddl, [])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::model::{LOCAL, PENDING, SYNCED};

    fn db() -> Db {
        Db::open_memory().expect("memory db")
    }

    #[test]
    fn upsert_draft_then_load() {
        let db = db();
        let saved = db.upsert_draft("  hello  ").unwrap().unwrap();
        assert_eq!(saved.content, "hello");
        assert_eq!(saved.sync_state, DRAFT);
        let loaded = db.load_draft().unwrap().unwrap();
        assert_eq!(loaded.id, saved.id);
        let updated = db.upsert_draft("hello again").unwrap().unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(updated.content, "hello again");
    }

    #[test]
    fn empty_upsert_discards_draft() {
        let db = db();
        db.upsert_draft("keep").unwrap();
        assert!(db.upsert_draft("   ").unwrap().is_none());
        assert!(db.load_draft().unwrap().is_none());
    }

    #[test]
    fn finalize_empty_discards_draft() {
        let db = db();
        db.upsert_draft("temp").unwrap();
        assert!(!db.finalize_content("  ").unwrap());
        assert!(db.load_draft().unwrap().is_none());
        assert!(db.list_recent(10).unwrap().is_empty());
    }

    #[test]
    fn finalize_without_server_is_local() {
        let db = db();
        assert!(db.finalize_content("a local note").unwrap());
        let notes = db.list_recent(10).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "a local note");
        assert_eq!(notes[0].sync_state, LOCAL);
        assert!(db.pending_and_errors().unwrap().is_empty());
    }

    #[test]
    fn finalize_with_server_is_pending_then_sync_updates() {
        let db = db();
        db.set_base_url("https://memos.example").unwrap();
        db.upsert_draft("ship it").unwrap();
        assert!(db.finalize_content("ship it").unwrap());
        let pending = db.pending_and_errors().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sync_state, PENDING);
        db.mark_synced(&pending[0].id, "memos/abc").unwrap();
        let notes = db.list_recent(10).unwrap();
        assert_eq!(notes[0].sync_state, SYNCED);
        assert_eq!(notes[0].remote_name.as_deref(), Some("memos/abc"));
        db.mark_error(&notes[0].id, "offline").unwrap();
        let errored = db.pending_and_errors().unwrap();
        assert_eq!(errored[0].sync_state, ERROR);
        assert_eq!(errored[0].last_error.as_deref(), Some("offline"));
    }

    #[test]
    fn save_edit_updates_a_synced_note_without_queueing_another() {
        let db = db();
        db.finalize_content("original title\nbody").unwrap();
        let note = db.list_recent(10).unwrap().remove(0);
        db.mark_synced(&note.id, "memos/abc").unwrap();
        assert_eq!(
            db.save_edit(&note.id, "original title\nbody").unwrap(),
            (false, false)
        );
        assert_eq!(db.list_recent(10).unwrap()[0].sync_state, SYNCED);
        assert_eq!(
            db.save_edit(&note.id, "renamed\nstill here").unwrap(),
            (true, true)
        );
        let notes = db.list_recent(10).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, note.id);
        assert_eq!(notes[0].content, "renamed\nstill here");
        assert_eq!(notes[0].sync_state, PENDING);
        assert_eq!(notes[0].remote_name.as_deref(), Some("memos/abc"));
        assert_eq!(db.save_edit(&note.id, "   ").unwrap(), (false, false));
        assert_eq!(db.list_recent(10).unwrap()[0].content, "renamed\nstill here");

        db.set_base_url("https://memos.example").unwrap();
        db.finalize_content("queued").unwrap();
        let pending = db.pending_and_errors().unwrap().remove(0);
        assert_eq!(db.save_edit(&pending.id, "queued edit").unwrap(), (true, true));
        assert_eq!(db.pending_and_errors().unwrap()[0].content, "queued edit");
        assert_eq!(db.pending_and_errors().unwrap()[0].sync_state, PENDING);
    }

    #[test]
    fn editing_a_synced_note_keeps_the_server_baseline() {
        let db = db();
        db.finalize_content("server copy").unwrap();
        let note = db.list_recent(10).unwrap().remove(0);
        db.mark_synced(&note.id, "memos/abc").unwrap();
        let link = db.remote_link("memos/abc").unwrap().unwrap();
        assert_eq!(link.base_content.as_deref(), Some("server copy"));
        db.save_edit(&note.id, "local edit").unwrap();
        let link = db.remote_link("memos/abc").unwrap().unwrap();
        assert_eq!(link.content, "local edit");
        assert_eq!(link.base_content.as_deref(), Some("server copy"));
    }

    #[test]
    fn access_token_is_stored_with_settings() {
        let db = db();
        assert!(db.access_token().unwrap().is_none());
        db.set_access_token("  secret  ").unwrap();
        assert_eq!(db.access_token().unwrap().as_deref(), Some("secret"));
        db.clear_access_token().unwrap();
        assert!(db.access_token().unwrap().is_none());
    }

    #[test]
    fn look_stays_on_the_note() {
        let db = db();
        let draft = db.upsert_draft("colored").unwrap().unwrap();
        assert_eq!(draft.opacity, 100);
        assert!(draft.hue_light.is_none());
        assert!(draft.swatches.is_empty());
        db.save_look(&draft.id, 40, Some(200), Some(400), &[12, 200, 400])
            .unwrap();
        db.finalize_content("colored").unwrap();
        db.save_edit(&draft.id, "colored more").unwrap();
        let note = db.get(&draft.id).unwrap().unwrap();
        assert_eq!(note.opacity, 40);
        assert_eq!(note.hue_light, Some(200));
        assert!(note.hue_dark.is_none());
        assert_eq!(note.swatches, vec![12, 200]);
    }

    #[test]
    fn pinned_opacity_sets_the_same_value_on_every_pin() {
        let db = db();
        let first = db.upsert_draft("one").unwrap().unwrap();
        db.finalize_content("one").unwrap();
        let second = db.upsert_draft("two").unwrap().unwrap();
        db.finalize_content("two").unwrap();
        let loose = db.upsert_draft("loose").unwrap().unwrap();
        db.finalize_content("loose").unwrap();
        db.set_pinned(&first.id, true).unwrap();
        db.set_pinned(&second.id, true).unwrap();
        db.save_look(&first.id, 80, Some(12), None, &[]).unwrap();
        db.set_pinned_opacity(25).unwrap();
        let first = db.get(&first.id).unwrap().unwrap();
        assert_eq!(first.opacity, 25);
        assert_eq!(first.hue_light, Some(12));
        assert_eq!(db.get(&second.id).unwrap().unwrap().opacity, 25);
        assert_eq!(db.get(&loose.id).unwrap().unwrap().opacity, 100);
    }

    #[test]
    fn pinned_note_keeps_its_frame() {
        let db = db();
        let draft = db.upsert_draft("keep me").unwrap().unwrap();
        db.finalize_content("keep me").unwrap();
        db.set_pinned(&draft.id, true).unwrap();
        db.save_frame(&draft.id, 12, 34, 400, 480).unwrap();
        let pinned = db.list_pinned().unwrap();
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].id, draft.id);
        assert!(pinned[0].pinned);
        assert_eq!(pinned[0].win_x, Some(12));
        assert_eq!(pinned[0].win_y, Some(34));
        assert_eq!(pinned[0].win_w, Some(400));
        assert_eq!(pinned[0].win_h, Some(480));
        db.set_pinned(&draft.id, false).unwrap();
        assert!(db.list_pinned().unwrap().is_empty());
    }

    #[test]
    fn list_recent_puts_the_latest_edit_first() {
        let db = db();
        db.finalize_content("older").unwrap();
        let older = db.list_recent(10).unwrap().remove(0);
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.finalize_content("newer").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.save_edit(&older.id, "older, edited last").unwrap();
        let notes = db.list_recent(10).unwrap();
        assert_eq!(notes[0].id, older.id);
        assert_eq!(notes[1].content, "newer");
    }

    #[test]
    fn list_recent_skips_the_open_draft() {
        let db = db();
        db.finalize_content("saved").unwrap();
        db.upsert_draft("still typing").unwrap();
        let notes = db.list_recent(10).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "saved");
    }

    #[test]
    fn changing_base_url_clears_detected_flavor() {
        let db = db();
        db.set_base_url("https://one.example").unwrap();
        db.set_meta(API_FLAVOR, "v1").unwrap();
        db.set_base_url("https://one.example").unwrap();
        assert_eq!(db.get_meta(API_FLAVOR).unwrap().as_deref(), Some("v1"));
        db.set_base_url("https://two.example/").unwrap();
        assert_eq!(db.get_meta(BASE_URL).unwrap().as_deref(), Some("https://two.example"));
        assert!(db.get_meta(API_FLAVOR).unwrap().is_none());
    }

    #[test]
    fn audience_change_on_a_synced_note_queues_it_and_delete_removes_it() {
        let db = db();
        let draft = db.upsert_draft("keep").unwrap().unwrap();
        db.finalize_content("keep").unwrap();
        db.mark_synced(&draft.id, "memos/abc").unwrap();
        assert!(db.set_audience(&draft.id, "PUBLIC", "").unwrap());
        let note = db.get(&draft.id).unwrap().unwrap();
        assert_eq!(note.visibility.as_deref(), Some("PUBLIC"));
        assert_eq!(note.space.as_deref(), Some(""));
        assert_eq!(note.sync_state, PENDING);
        assert!(db.set_audience(&draft.id, "SPACE", "").is_err());
        db.delete_note(&draft.id).unwrap();
        assert!(db.get(&draft.id).unwrap().is_none());
    }
}
