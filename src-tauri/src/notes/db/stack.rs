use rusqlite::params;

use crate::error::AppError;
use crate::notes::model::{Note, DRAFT};

use super::{map_note, Db, LIST_PINNED};

impl Db {
    pub fn set_collapsed(&self, id: &str, collapsed: bool) -> Result<(), AppError> {
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET collapsed = ?1 WHERE id = ?2",
                params![collapsed, id],
            )?;
            Ok(())
        })
    }

    pub fn set_stack_host(&self, id: &str, host: Option<&str>) -> Result<(), AppError> {
        if let Some(host_id) = host {
            if host_id == id {
                return Err(AppError::Message("a memo cannot stack on itself".into()));
            }
            if self.chain_after(id)?.iter().any(|note| note.id == host_id) {
                return Err(AppError::Message("stack cycle detected".into()));
            }
        }
        self.with(|conn| {
            conn.execute(
                "UPDATE notes SET stack_host = ?1 WHERE id = ?2",
                params![host, id],
            )?;
            Ok(())
        })
    }

    /// Notes under `host_id`, in stack order. Each note keeps its own child.
    pub fn chain_after(&self, host_id: &str) -> Result<Vec<Note>, AppError> {
        let mut chain = Vec::new();
        let mut current = host_id.to_string();
        for _ in 0..8 {
            let Some(guest) = self.guest_of(&current)? else {
                break;
            };
            if guest.id == host_id || chain.iter().any(|note: &Note| note.id == guest.id) {
                break;
            }
            current = guest.id.clone();
            chain.push(guest);
        }
        Ok(chain)
    }

    pub fn stack_tail(&self, root_id: &str) -> Result<String, AppError> {
        let chain = self.chain_after(root_id)?;
        Ok(chain
            .last()
            .map(|note| note.id.clone())
            .unwrap_or_else(|| root_id.to_string()))
    }

    /// Walk parents to the note that owns the window.
    pub fn stack_root_id(&self, id: &str) -> Result<String, AppError> {
        let mut current = id.to_string();
        for _ in 0..8 {
            let Some(note) = self.get(&current)? else {
                break;
            };
            let Some(host) = note.stack_host else {
                break;
            };
            if host == current {
                break;
            }
            current = host;
        }
        Ok(current)
    }

    pub fn guest_of(&self, host_id: &str) -> Result<Option<Note>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, created_at, updated_at, sync_state, remote_name, last_error, pinned, win_x, win_y, win_w, win_h, opacity, hue_light, hue_dark, swatches, visibility, remote_space, collapsed, stack_host, theme, coder FROM notes WHERE stack_host = ?1 LIMIT 1",
            )?;
            let mut rows = stmt.query(params![host_id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(map_note(row)?))
            } else {
                Ok(None)
            }
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

    pub fn list_pinned(&self) -> Result<Vec<Note>, AppError> {
        self.with(|conn| {
            let mut stmt = conn.prepare(LIST_PINNED)?;
            let rows = stmt.query_map(params![DRAFT], map_note)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })
    }
}
