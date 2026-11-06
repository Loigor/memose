use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::notes::model::{MemoSpace, SpaceView, PENDING, SYNCED};

use super::{canonical_visibility, get_meta, Db, MEMO_SPACE, MEMO_VISIBILITY, SPACE_CATALOG};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredSpace {
    name: String,
    title: String,
    #[serde(default)]
    synced: bool,
    #[serde(default)]
    hue: Option<u16>,
}

impl From<StoredSpace> for SpaceView {
    fn from(space: StoredSpace) -> Self {
        Self {
            name: space.name,
            title: space.title,
            synced: space.synced,
            hue: space.hue,
        }
    }
}

fn load_spaces(conn: &Connection) -> Result<Vec<StoredSpace>, AppError> {
    let Some(raw) = get_meta(conn, SPACE_CATALOG)? else {
        return Ok(Vec::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_spaces(conn: &Connection, spaces: &[StoredSpace]) -> Result<(), AppError> {
    let raw = serde_json::to_string(spaces).map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SPACE_CATALOG, raw],
    )?;
    Ok(())
}

fn noted_spaces(conn: &Connection) -> Result<HashSet<String>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT trim(remote_space) FROM notes WHERE ifnull(trim(remote_space), '') != ''",
    )?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = HashSet::new();
    for name in names {
        let name = name?;
        if !name.is_empty() {
            out.insert(name);
        }
    }
    Ok(out)
}

pub(super) fn space_hue_value(conn: &Connection, space: &str) -> Result<Option<u16>, AppError> {
    if space.trim().is_empty() {
        return Ok(None);
    }
    Ok(load_spaces(conn)?
        .into_iter()
        .find(|item| item.name == space)
        .and_then(|item| item.hue))
}

fn space_title(name: &str) -> String {
    name.rsplit('/')
        .next()
        .filter(|title| !title.is_empty())
        .unwrap_or(name)
        .to_string()
}

fn sort_spaces(mut spaces: Vec<StoredSpace>) -> Vec<StoredSpace> {
    spaces.sort_by(|left, right| {
        right
            .synced
            .cmp(&left.synced)
            .then_with(|| {
                left.title
                    .to_ascii_lowercase()
                    .cmp(&right.title.to_ascii_lowercase())
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    spaces
}

fn visible_spaces(spaces: &[StoredSpace]) -> Vec<(String, String, bool)> {
    spaces
        .iter()
        .map(|space| (space.name.clone(), space.title.clone(), space.synced))
        .collect()
}

impl Db {
    pub fn store_space_catalog(&self, remote: &[MemoSpace]) -> Result<bool, AppError> {
        self.with(|conn| {
            let previous = load_spaces(conn)?;
            let noted = noted_spaces(conn)?;
            let mut next = HashMap::new();
            for old in &previous {
                if noted.contains(&old.name) || old.hue.is_some() {
                    next.insert(
                        old.name.clone(),
                        StoredSpace {
                            synced: false,
                            ..old.clone()
                        },
                    );
                }
            }
            for space in remote {
                let hue = next.get(&space.name).and_then(|item| item.hue);
                next.insert(
                    space.name.clone(),
                    StoredSpace {
                        name: space.name.clone(),
                        title: space.title.clone(),
                        synced: true,
                        hue,
                    },
                );
            }
            let stored = sort_spaces(next.into_values().collect());
            let changed = visible_spaces(&previous) != visible_spaces(&stored);
            save_spaces(conn, &stored)?;
            Ok(changed)
        })
    }

    pub fn remember_space(&self, name: &str, title: &str) -> Result<(), AppError> {
        let name = name.trim();
        let title = title.trim();
        if name.is_empty() || title.is_empty() {
            return Err(AppError::Message("space needs a name and title".into()));
        }
        self.with(|conn| {
            let mut spaces = load_spaces(conn)?;
            if let Some(existing) = spaces.iter_mut().find(|space| space.name == name) {
                existing.title = title.to_string();
                existing.synced = true;
            } else {
                spaces.push(StoredSpace {
                    name: name.to_string(),
                    title: title.to_string(),
                    synced: true,
                    hue: None,
                });
            }
            save_spaces(conn, &sort_spaces(spaces))?;
            Ok(())
        })
    }

    pub fn list_known_spaces(&self) -> Result<Vec<SpaceView>, AppError> {
        self.with(|conn| {
            let mut spaces = load_spaces(conn)?;
            for name in noted_spaces(conn)? {
                if spaces.iter().any(|space| space.name == name) {
                    continue;
                }
                spaces.push(StoredSpace {
                    title: space_title(&name),
                    name,
                    synced: false,
                    hue: None,
                });
            }
            Ok(sort_spaces(spaces)
                .into_iter()
                .map(SpaceView::from)
                .collect())
        })
    }

    pub fn set_space_hue(&self, name: &str, hue: Option<u16>) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Message("choose a space".into()));
        }
        let hue = hue.filter(|value| *value <= 359);
        self.with(|conn| {
            let mut spaces = load_spaces(conn)?;
            if let Some(existing) = spaces.iter_mut().find(|space| space.name == name) {
                existing.hue = hue;
            } else {
                spaces.push(StoredSpace {
                    title: space_title(name),
                    name: name.to_string(),
                    synced: false,
                    hue,
                });
            }
            save_spaces(conn, &sort_spaces(spaces))?;
            Ok(())
        })
    }

    pub fn forget_space(&self, name: &str) -> Result<bool, AppError> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::Message("choose a space".into()));
        }
        self.with(|conn| {
            let spaces = load_spaces(conn)?;
            if spaces
                .iter()
                .any(|space| space.name == name && space.synced)
            {
                return Err(AppError::Message(
                    "that space is still on the server".into(),
                ));
            }
            let queued = conn.execute(
                "UPDATE notes
                 SET visibility = CASE WHEN visibility = 'SPACE' THEN 'PRIVATE' ELSE visibility END,
                     remote_space = '',
                     sync_state = CASE
                         WHEN sync_state = ?1 AND remote_name IS NOT NULL THEN ?2
                         ELSE sync_state
                     END
                 WHERE trim(ifnull(remote_space, '')) = ?3",
                params![SYNCED, PENDING, name],
            )? > 0;
            let default = get_meta(conn, MEMO_SPACE)?.unwrap_or_default();
            if default.trim() == name {
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![MEMO_SPACE, ""],
                )?;
                let visibility = canonical_visibility(
                    &get_meta(conn, MEMO_VISIBILITY)?.unwrap_or_else(|| "PRIVATE".into()),
                );
                if visibility == "SPACE" {
                    conn.execute(
                        "INSERT INTO meta (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![MEMO_VISIBILITY, "PRIVATE"],
                    )?;
                }
            }
            let kept: Vec<StoredSpace> = spaces
                .into_iter()
                .filter(|space| space.name != name)
                .collect();
            save_spaces(conn, &kept)?;
            Ok(queued)
        })
    }
}
