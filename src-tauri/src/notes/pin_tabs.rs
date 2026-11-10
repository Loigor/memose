use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::notes::model::Note;
use crate::notes::Db;

pub const KEY: &str = "pin_tabs";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PinTabHit {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub fn tab_at(hits: &[PinTabHit], x: f64, y: f64) -> Option<&str> {
    hits.iter()
        .find(|hit| x >= hit.x && y >= hit.y && x < hit.x + hit.w && y < hit.y + hit.h)
        .map(|hit| hit.id.as_str())
}

/// Local pin-tab workspace. JSON shape is the later sync memo body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinTabs {
    #[serde(default = "pin_tabs_version")]
    pub version: u32,
    #[serde(default)]
    pub active_id: String,
    #[serde(default)]
    pub tabs: Vec<PinTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinTab {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_hue")]
    pub hue: u16,
    #[serde(default)]
    pub swatches: Vec<u16>,
    #[serde(default)]
    pub notes: Vec<PinTabNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinTabNote {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<i32>,
}

fn pin_tabs_version() -> u32 {
    1
}

fn default_hue() -> u16 {
    48
}

impl PinTabNote {
    fn of(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            x: None,
            y: None,
            w: None,
            h: None,
        }
    }
}

impl PinTab {
    fn fresh(hue: u16) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: String::new(),
            hue: clamp_hue(hue),
            swatches: Vec::new(),
            notes: Vec::new(),
        }
    }
}

impl PinTabs {
    fn empty() -> Self {
        Self {
            version: 1,
            active_id: String::new(),
            tabs: Vec::new(),
        }
    }

    pub fn active_note_ids(&self) -> HashSet<String> {
        self.tabs
            .iter()
            .find(|tab| tab.id == self.active_id)
            .map(|tab| tab.notes.iter().map(|note| note.id.clone()).collect())
            .unwrap_or_default()
    }

    fn place_note(&mut self, tab_id: &str, note_id: &str) {
        for tab in &mut self.tabs {
            tab.notes.retain(|note| note.id != note_id);
        }
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.notes.push(PinTabNote::of(note_id));
        }
    }
}

fn clamp_hue(hue: u16) -> u16 {
    hue.min(359)
}

fn clamp_swatches(swatches: &[u16]) -> Vec<u16> {
    swatches
        .iter()
        .copied()
        .filter(|hue| *hue <= 359)
        .take(6)
        .collect()
}

fn next_hue(tabs: &[PinTab]) -> u16 {
    let prev = tabs.last().map(|tab| tab.hue).unwrap_or(48);
    (prev + 137) % 360
}

fn parse(raw: Option<&str>) -> PinTabs {
    raw.and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_else(PinTabs::empty)
}

fn ensure_tabs(state: &mut PinTabs) {
    if state.tabs.is_empty() {
        let tab = PinTab::fresh(48);
        state.active_id = tab.id.clone();
        state.tabs.push(tab);
    }
    if !state.tabs.iter().any(|tab| tab.id == state.active_id) {
        state.active_id = state.tabs[0].id.clone();
    }
}

fn drop_unpinned(state: &mut PinTabs, pinned: &[Note]) {
    let pinned_ids: HashSet<&str> = pinned.iter().map(|note| note.id.as_str()).collect();
    for tab in &mut state.tabs {
        tab.notes
            .retain(|note| pinned_ids.contains(note.id.as_str()));
    }
}

fn adopt_orphans(state: &mut PinTabs, pinned: &[Note]) {
    let assigned: HashSet<String> = state
        .tabs
        .iter()
        .flat_map(|tab| tab.notes.iter().map(|note| note.id.clone()))
        .collect();
    let Some(active) = state.tabs.iter_mut().find(|tab| tab.id == state.active_id) else {
        return;
    };
    for note in pinned {
        if !assigned.contains(&note.id) {
            active.notes.push(PinTabNote::of(&note.id));
        }
    }
}

impl Db {
    fn read_pin_tabs(&self) -> Result<PinTabs, AppError> {
        Ok(parse(self.get_meta(KEY)?.as_deref()))
    }

    pub fn save_pin_tabs(&self, state: &PinTabs) -> Result<(), AppError> {
        let json = serde_json::to_string(state)
            .map_err(|err| AppError::Message(format!("pin tabs encode failed: {err}")))?;
        self.set_meta(KEY, &json)
    }

    pub fn pin_tabs(&self) -> Result<PinTabs, AppError> {
        let pinned = self.list_pinned()?;
        let mut state = self.read_pin_tabs()?;
        ensure_tabs(&mut state);
        drop_unpinned(&mut state, &pinned);
        adopt_orphans(&mut state, &pinned);
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn add_pin_tab(&self) -> Result<PinTabs, AppError> {
        let mut state = self.pin_tabs()?;
        let tab = PinTab::fresh(next_hue(&state.tabs));
        state.active_id = tab.id.clone();
        state.tabs.push(tab);
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn select_pin_tab(&self, id: &str) -> Result<PinTabs, AppError> {
        let mut state = self.pin_tabs()?;
        if !state.tabs.iter().any(|tab| tab.id == id) {
            return Err(AppError::Message("pin tab not found".into()));
        }
        state.active_id = id.to_string();
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn update_pin_tab(
        &self,
        id: &str,
        name: Option<String>,
        hue: Option<u16>,
        swatches: Option<Vec<u16>>,
    ) -> Result<PinTabs, AppError> {
        let mut state = self.pin_tabs()?;
        let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) else {
            return Err(AppError::Message("pin tab not found".into()));
        };
        if let Some(name) = name {
            tab.name = name.chars().take(40).collect();
        }
        if let Some(hue) = hue {
            tab.hue = clamp_hue(hue);
        }
        if let Some(swatches) = swatches {
            tab.swatches = clamp_swatches(&swatches);
        }
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn assign_pinned_note(&self, note_id: &str, new_tab: bool) -> Result<PinTabs, AppError> {
        let pinned = self.list_pinned()?;
        let mut state = self.read_pin_tabs()?;
        drop_unpinned(&mut state, &pinned);
        if new_tab {
            let tab = PinTab::fresh(next_hue(&state.tabs));
            let id = tab.id.clone();
            state.tabs.push(tab);
            state.active_id = id.clone();
            state.place_note(&id, note_id);
        } else {
            ensure_tabs(&mut state);
            let others: Vec<Note> = pinned
                .iter()
                .filter(|note| note.id != note_id)
                .cloned()
                .collect();
            adopt_orphans(&mut state, &others);
            let active = state.active_id.clone();
            state.place_note(&active, note_id);
        }
        ensure_tabs(&mut state);
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn move_pinned_note_to_tab(
        &self,
        note_id: &str,
        tab_id: &str,
    ) -> Result<PinTabs, AppError> {
        let mut state = self.pin_tabs()?;
        if !state.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(AppError::Message("pin tab not found".into()));
        }
        state.place_note(tab_id, note_id);
        state.active_id = tab_id.to_string();
        self.save_pin_tabs(&state)?;
        Ok(state)
    }

    pub fn unassign_pinned_note(&self, note_id: &str) -> Result<PinTabs, AppError> {
        let mut state = self.read_pin_tabs()?;
        for tab in &mut state.tabs {
            tab.notes.retain(|note| note.id != note_id);
        }
        self.save_pin_tabs(&state)?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_memory().expect("memory db")
    }

    #[test]
    fn first_pin_makes_one_tab() {
        let db = db();
        let note = db.publish_note(None, "alpha").unwrap();
        db.set_pinned(&note.id, true).unwrap();
        let state = db.assign_pinned_note(&note.id, true).unwrap();
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.tabs[0].notes.len(), 1);
        assert_eq!(state.tabs[0].notes[0].id, note.id);
        assert_eq!(state.active_id, state.tabs[0].id);
    }

    #[test]
    fn pin_while_open_adds_to_current_tab() {
        let db = db();
        let first = db.publish_note(None, "one").unwrap();
        db.set_pinned(&first.id, true).unwrap();
        db.assign_pinned_note(&first.id, true).unwrap();
        let second = db.publish_note(None, "two").unwrap();
        db.set_pinned(&second.id, true).unwrap();
        let state = db.assign_pinned_note(&second.id, false).unwrap();
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.tabs[0].notes.len(), 2);
        assert!(state.tabs[0].notes.iter().any(|note| note.id == second.id));
    }

    #[test]
    fn pin_while_closed_starts_a_new_tab() {
        let db = db();
        let first = db.publish_note(None, "one").unwrap();
        db.set_pinned(&first.id, true).unwrap();
        db.assign_pinned_note(&first.id, true).unwrap();
        let second = db.publish_note(None, "two").unwrap();
        db.set_pinned(&second.id, true).unwrap();
        let state = db.assign_pinned_note(&second.id, true).unwrap();
        assert_eq!(state.tabs.len(), 2);
        assert_eq!(state.tabs[0].notes.len(), 1);
        assert_eq!(state.tabs[1].notes.len(), 1);
        assert_eq!(state.tabs[1].notes[0].id, second.id);
        assert_eq!(state.active_id, state.tabs[1].id);
    }

    #[test]
    fn existing_pins_migrate_into_one_tab() {
        let db = db();
        let first = db.publish_note(None, "one").unwrap();
        let second = db.publish_note(None, "two").unwrap();
        db.set_pinned(&first.id, true).unwrap();
        db.set_pinned(&second.id, true).unwrap();
        let state = db.pin_tabs().unwrap();
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.tabs[0].notes.len(), 2);
    }

    #[test]
    fn add_tab_selects_an_empty_workspace() {
        let db = db();
        let note = db.publish_note(None, "one").unwrap();
        db.set_pinned(&note.id, true).unwrap();
        db.assign_pinned_note(&note.id, true).unwrap();
        let state = db.add_pin_tab().unwrap();
        assert_eq!(state.tabs.len(), 2);
        let active = state
            .tabs
            .iter()
            .find(|tab| tab.id == state.active_id)
            .unwrap();
        assert!(active.notes.is_empty());
        assert_ne!(active.hue, state.tabs[0].hue);
    }

    #[test]
    fn unpin_drops_the_note_from_tabs() {
        let db = db();
        let note = db.publish_note(None, "one").unwrap();
        db.set_pinned(&note.id, true).unwrap();
        db.assign_pinned_note(&note.id, true).unwrap();
        db.set_pinned(&note.id, false).unwrap();
        let state = db.unassign_pinned_note(&note.id).unwrap();
        assert!(state.tabs[0].notes.is_empty());
        assert!(db.pin_tabs().unwrap().tabs[0].notes.is_empty());
    }

    #[test]
    fn update_renames_and_recolors() {
        let db = db();
        let state = db.pin_tabs().unwrap();
        let id = state.active_id.clone();
        let next = db
            .update_pin_tab(&id, Some("Desk".into()), Some(200), Some(vec![200, 12]))
            .unwrap();
        assert_eq!(next.tabs[0].name, "Desk");
        assert_eq!(next.tabs[0].hue, 200);
        assert_eq!(next.tabs[0].swatches, vec![200, 12]);
    }

    #[test]
    fn move_note_switches_tab_and_takes_the_note() {
        let db = db();
        let note = db.publish_note(None, "one").unwrap();
        db.set_pinned(&note.id, true).unwrap();
        db.assign_pinned_note(&note.id, true).unwrap();
        let dest = db.add_pin_tab().unwrap().active_id;
        let state = db.move_pinned_note_to_tab(&note.id, &dest).unwrap();
        assert_eq!(state.active_id, dest);
        let dest_tab = state.tabs.iter().find(|tab| tab.id == dest).unwrap();
        assert!(dest_tab.notes.iter().any(|item| item.id == note.id));
        assert_eq!(
            state
                .tabs
                .iter()
                .filter(|tab| tab.notes.iter().any(|item| item.id == note.id))
                .count(),
            1
        );
    }

    #[test]
    fn tab_at_hits_the_button_rect() {
        let hits = vec![
            PinTabHit {
                id: "a".into(),
                x: 8.0,
                y: 0.0,
                w: 100.0,
                h: 12.0,
            },
            PinTabHit {
                id: "b".into(),
                x: 110.0,
                y: 0.0,
                w: 100.0,
                h: 12.0,
            },
        ];
        assert_eq!(tab_at(&hits, 20.0, 4.0), Some("a"));
        assert_eq!(tab_at(&hits, 150.0, 4.0), Some("b"));
        assert_eq!(tab_at(&hits, 300.0, 4.0), None);
    }
}
