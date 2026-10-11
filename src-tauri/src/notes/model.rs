use serde::Serialize;

pub const DRAFT: &str = "draft";
pub const PENDING: &str = "pending";
pub const SYNCED: &str = "synced";
pub const ERROR: &str = "error";
pub const LOCAL: &str = "local";
pub const REMOTE: &str = "remote";
pub const CONFLICT: &str = "conflict";

pub const MEMOS_CONTENT_LIMIT: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub sync_state: String,
    pub remote_name: Option<String>,
    pub last_error: Option<String>,
    pub pinned: bool,
    pub win_x: Option<i32>,
    pub win_y: Option<i32>,
    pub win_w: Option<i32>,
    pub win_h: Option<i32>,
    pub opacity: u8,
    pub hue_light: Option<u16>,
    pub hue_dark: Option<u16>,
    pub swatches: Vec<u16>,
    /// useMemos audience. Empty until the note is placed.
    pub visibility: Option<String>,
    /// useMemos space resource name, such as `spaces/team`. Empty means unassigned.
    pub space: Option<String>,
}

pub fn commit_state(has_server: bool) -> &'static str {
    if has_server { PENDING } else { LOCAL }
}
