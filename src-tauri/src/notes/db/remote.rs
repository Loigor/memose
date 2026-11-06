use rusqlite::params;
use uuid::Uuid;

use crate::error::AppError;
use crate::notes::model::{CONFLICT, DRAFT, ERROR, LOCAL, PENDING, REMOTE, SYNCED};

use super::{canonical_visibility, now_ms, Db};

pub struct RemoteLink {
    pub id: String,
    pub content: String,
    pub sync_state: String,
    pub base_content: Option<String>,
    pub remote_updated_at: Option<i64>,
    pub visibility: Option<String>,
}

impl Db {
    pub fn remember_remote_name(&self, id: &str, remote_name: &str) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET remote_name = ?1 WHERE id = ?2 AND sync_state IN (?3, ?4)",
                params![remote_name, id, PENDING, ERROR],
            )?;
            Ok(())
        })
    }

    pub fn complete_push(
        &self,
        id: &str,
        remote_name: &str,
        pushed: &str,
    ) -> Result<bool, AppError> {
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

    #[cfg(test)]
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

    pub fn remote_link(&self, remote_name: &str) -> Result<Option<RemoteLink>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, sync_state, base_content, remote_updated_at, visibility
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
                visibility: row.get(5)?,
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
                params![
                    preview,
                    updated_at,
                    canonical_visibility(visibility),
                    space,
                    id,
                    REMOTE
                ],
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
                params![
                    content,
                    updated_at,
                    SYNCED,
                    id,
                    canonical_visibility(visibility),
                    space
                ],
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

    pub fn store_conflict(
        &self,
        id: &str,
        server_content: &str,
        updated_at: i64,
    ) -> Result<(), AppError> {
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
