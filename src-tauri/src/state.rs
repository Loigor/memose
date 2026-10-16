use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;
use std::time::Instant;

use tauri::menu::CheckMenuItem;
use tauri::Wry;

use crate::notes::Job;
use crate::notes::Db;
use crate::shortcuts::ShortcutBinds;

pub struct AppState {
    pub db: Db,
    pub media_dir: PathBuf,
    pub http: reqwest::Client,
    pub flush_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub flush_content: Mutex<Option<String>>,
    pub flush_note_id: Mutex<Option<String>>,
    pub shown: AtomicBool,
    /// Pins stay up across app switches. Tray-shown pins do not set this.
    pub pinned_mode: AtomicBool,
    pub suppress_blur: AtomicBool,
    pub hiding: AtomicBool,
    pub generation: AtomicU64,
    pub handled_flush: AtomicU64,
    pub sync_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Job>>>,
    pub last_index: Mutex<Option<Instant>>,
    pub blur_hidden_at: Mutex<Option<Instant>>,
    pub autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    pub preview_open: AtomicBool,
    pub preview_name: Mutex<Option<String>>,
    pub preview_opened_at: Mutex<Option<Instant>>,
    pub shortcuts: Mutex<ShortcutBinds>,
    /// Per-window drag settle tickets: ticket, resize gesture, last event time.
    pub settle: Mutex<HashMap<String, (u64, bool, Instant)>>,
}

impl AppState {
    pub fn new(db: Db, media_dir: PathBuf) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("memose/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            db,
            media_dir,
            http,
            flush_tx: Mutex::new(None),
            flush_content: Mutex::new(None),
            flush_note_id: Mutex::new(None),
            shown: AtomicBool::new(false),
            pinned_mode: AtomicBool::new(false),
            suppress_blur: AtomicBool::new(true),
            hiding: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            handled_flush: AtomicU64::new(0),
            sync_tx: Mutex::new(None),
            last_index: Mutex::new(None),
            blur_hidden_at: Mutex::new(None),
            autostart_item: Mutex::new(None),
            preview_open: AtomicBool::new(false),
            preview_name: Mutex::new(None),
            preview_opened_at: Mutex::new(None),
            shortcuts: Mutex::new(ShortcutBinds::defaults()),
            settle: Mutex::new(HashMap::new()),
        })
    }
}
