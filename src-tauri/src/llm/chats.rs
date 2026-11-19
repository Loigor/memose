//! The chat of each memo and the prompts still running. Kept in memory until the app quits,
//! and bounded: a few memos, a few prompts each.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use tokio::sync::oneshot;

use super::{ChatEntry, RUNNING};
use crate::error::AppError;

/// Finished prompts kept per memo.
const CHAT_KEEP: usize = 30;
/// Memos whose chat is kept. The one used longest ago goes first, unless a prompt still runs there.
const MEMOS_KEEP: usize = 20;

#[derive(Default)]
pub struct Chats {
    logs: Mutex<HashMap<String, Vec<ChatEntry>>>,
    /// Cancel senders of running prompts, by request id.
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

/// A running prompt. Dropping it forgets its cancel sender.
pub struct Running<'a> {
    chats: &'a Chats,
    id: String,
    pub cancelled: oneshot::Receiver<()>,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.chats.cancels).remove(&self.id);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn last_used(log: &[ChatEntry]) -> i64 {
    log.iter().map(|item| item.started_at).max().unwrap_or(0)
}

impl Chats {
    /// The chat of one memo, oldest first.
    pub fn log(&self, note_id: &str) -> Vec<ChatEntry> {
        lock(&self.logs).get(note_id).cloned().unwrap_or_default()
    }

    /// Adds a running prompt to its memo's chat, drops the oldest finished prompts and memos
    /// over the limits, and registers its cancel.
    pub fn start(&self, entry: ChatEntry) -> Result<Running<'_>, AppError> {
        let (tx, cancelled) = oneshot::channel();
        {
            let mut cancels = lock(&self.cancels);
            if cancels.contains_key(&entry.id) {
                return Err(AppError::Message("this prompt is already running".into()));
            }
            cancels.insert(entry.id.clone(), tx);
        }
        let id = entry.id.clone();
        let mut logs = lock(&self.logs);
        let log = logs.entry(entry.note_id.clone()).or_default();
        log.push(entry);
        let mut extra = log.len().saturating_sub(CHAT_KEEP);
        log.retain(|item| {
            let drop = extra > 0 && item.status != RUNNING;
            extra -= usize::from(drop);
            !drop
        });
        while logs.len() > MEMOS_KEEP {
            let idle = logs
                .iter()
                .filter(|(_, log)| log.iter().all(|item| item.status != RUNNING))
                .min_by_key(|(_, log)| last_used(log))
                .map(|(note, _)| note.clone());
            match idle {
                Some(note) => logs.remove(&note),
                None => break,
            };
        }
        Ok(Running {
            chats: self,
            id,
            cancelled,
        })
    }

    /// Records how a prompt ended. None when its chat was cleared meanwhile.
    pub fn finish(&self, note_id: &str, id: &str, status: &str, text: String) -> Option<ChatEntry> {
        let mut logs = lock(&self.logs);
        let item = logs
            .get_mut(note_id)?
            .iter_mut()
            .find(|item| item.id == id)?;
        item.status = status.into();
        item.text = text;
        item.finished_at = Some(crate::notes::now_ms());
        Some(item.clone())
    }

    pub fn cancel(&self, id: &str) {
        if let Some(cancel) = lock(&self.cancels).remove(id) {
            let _ = cancel.send(());
        }
    }

    /// Prompts still running, across all memos, oldest first. Memo text is left out.
    pub fn jobs(&self) -> Vec<ChatEntry> {
        let mut jobs: Vec<ChatEntry> = lock(&self.logs)
            .values()
            .flatten()
            .filter(|item| item.status == RUNNING)
            .map(|item| ChatEntry {
                source: String::new(),
                ..item.clone()
            })
            .collect();
        jobs.sort_by_key(|item| item.started_at);
        jobs
    }

    /// Records what happened to a proposed edit: `applied` or `dismissed`, and which changes were taken.
    pub fn mark(&self, note_id: &str, id: &str, status: String, accepted: Vec<u32>) {
        let mut logs = lock(&self.logs);
        let found = logs
            .get_mut(note_id)
            .and_then(|log| log.iter_mut().find(|item| item.id == id));
        if let Some(item) = found.filter(|item| item.status == "edit") {
            item.status = status;
            item.accepted = accepted;
        }
    }

    /// Drops the finished prompts of one memo. Running ones stay.
    pub fn clear(&self, note_id: &str) {
        let mut logs = lock(&self.logs);
        if let Some(log) = logs.get_mut(note_id) {
            log.retain(|item| item.status == RUNNING);
            if log.is_empty() {
                logs.remove(note_id);
            }
        }
    }

    /// Drops one memo's chat and stops its running prompts, as when the memo is deleted.
    pub fn forget(&self, note_id: &str) {
        let removed = lock(&self.logs).remove(note_id).unwrap_or_default();
        for item in removed.iter().filter(|item| item.status == RUNNING) {
            self.cancel(&item.id);
        }
    }

    /// Drops every chat and stops every prompt, as when prompts are turned off.
    pub fn forget_all(&self) {
        lock(&self.logs).clear();
        for (_, cancel) in lock(&self.cancels).drain() {
            let _ = cancel.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Mode;

    fn entry(note: &str, id: &str, started_at: i64) -> ChatEntry {
        ChatEntry {
            id: id.into(),
            note_id: note.into(),
            title: String::new(),
            instruction: "do it".into(),
            mode: Mode::Ask,
            status: RUNNING.into(),
            text: String::new(),
            source: "memo".into(),
            line_start: None,
            line_end: None,
            selection: false,
            started_at,
            finished_at: None,
            accepted: Vec::new(),
        }
    }

    #[test]
    fn old_finished_prompts_and_idle_memos_are_dropped() {
        let chats = Chats::default();
        for at in 0..(CHAT_KEEP as i64 + 5) {
            let id = format!("a{at}");
            drop(chats.start(entry("a", &id, at)).unwrap());
            chats.finish("a", &id, "answer", "ok".into());
        }
        assert_eq!(chats.log("a").len(), CHAT_KEEP);
        assert_eq!(chats.log("a")[0].id, "a5");
        let busy = chats.start(entry("busy", "b", 0)).unwrap();
        for memo in 0..MEMOS_KEEP {
            let note = format!("m{memo}");
            drop(chats.start(entry(&note, &note, 100 + memo as i64)).unwrap());
            chats.finish(&note, &note, "answer", "ok".into());
        }
        assert!(
            chats.log("a").is_empty(),
            "the memo used longest ago went first"
        );
        assert_eq!(
            chats.log("busy").len(),
            1,
            "a running prompt keeps its memo"
        );
        drop(busy);
    }

    #[test]
    fn a_request_id_runs_once_and_forgetting_a_memo_cancels_it() {
        let chats = Chats::default();
        let mut running = chats.start(entry("n", "r", 1)).unwrap();
        assert!(chats.start(entry("n", "r", 2)).is_err());
        chats.forget("n");
        assert!(running.cancelled.try_recv().is_ok());
        assert!(chats.log("n").is_empty());
        drop(running);
        assert!(chats.start(entry("n", "r", 3)).is_ok());
    }
}
