use std::str::FromStr;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::error::AppError;
use crate::notes::Db;

pub const KEY: &str = "shortcuts";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinds {
    pub new_memo: String,
    pub toggle_pinned: String,
    pub preview: String,
    pub hide: String,
    pub random_hue: String,
    pub gesture: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredBinds {
    new_memo: Option<String>,
    toggle_pinned: Option<String>,
    preview: Option<String>,
    hide: Option<String>,
    random_hue: Option<String>,
    gesture: Option<String>,
}

impl ShortcutBinds {
    pub fn defaults() -> Self {
        Self {
            new_memo: command_alt("KeyN"),
            toggle_pinned: command_alt("KeyP"),
            preview: command("Enter"),
            hide: "Escape".into(),
            random_hue: "alt+Enter".into(),
            gesture: "Alt".into(),
        }
    }

    pub fn assign(&mut self, id: &str, binding: &str) -> Result<(), AppError> {
        if id == "gesture" {
            self.gesture = binding.to_string();
            return Ok(());
        }
        let slot = match id {
            "newMemo" => &mut self.new_memo,
            "togglePinned" => &mut self.toggle_pinned,
            "preview" => &mut self.preview,
            "hide" => &mut self.hide,
            "randomHue" => &mut self.random_hue,
            _ => return Err(AppError::Message("unknown shortcut".into())),
        };
        *slot = binding.to_string();
        Ok(())
    }
}

pub fn load(db: &Db) -> ShortcutBinds {
    let defaults = ShortcutBinds::defaults();
    let Ok(Some(raw)) = db.get_meta(KEY) else {
        return defaults;
    };
    let Ok(stored) = serde_json::from_str::<StoredBinds>(&raw) else {
        return defaults;
    };
    ShortcutBinds {
        new_memo: stored
            .new_memo
            .and_then(|binding| canonical(&binding).ok())
            .unwrap_or(defaults.new_memo),
        toggle_pinned: stored
            .toggle_pinned
            .and_then(|binding| canonical(&binding).ok())
            .unwrap_or(defaults.toggle_pinned),
        preview: stored
            .preview
            .and_then(|binding| canonical(&binding).ok())
            .unwrap_or(defaults.preview),
        hide: stored
            .hide
            .and_then(|binding| canonical(&binding).ok())
            .unwrap_or(defaults.hide),
        random_hue: stored
            .random_hue
            .and_then(|binding| canonical(&binding).ok())
            .unwrap_or(defaults.random_hue),
        gesture: stored
            .gesture
            .and_then(|binding| canonical_modifier(&binding).ok())
            .unwrap_or(defaults.gesture),
    }
}

pub fn normalize(binds: &ShortcutBinds) -> Result<ShortcutBinds, AppError> {
    let next = ShortcutBinds {
        new_memo: canonical(&binds.new_memo)?,
        toggle_pinned: canonical(&binds.toggle_pinned)?,
        preview: canonical(&binds.preview)?,
        hide: canonical(&binds.hide)?,
        random_hue: canonical(&binds.random_hue)?,
        gesture: canonical_modifier(&binds.gesture)?,
    };
    require_modifier(&next.new_memo)?;
    require_modifier(&next.toggle_pinned)?;
    let keys = [
        &next.new_memo,
        &next.toggle_pinned,
        &next.preview,
        &next.hide,
        &next.random_hue,
    ];
    for (index, key) in keys.iter().enumerate() {
        if keys.iter().skip(index + 1).any(|other| other == key) {
            return Err(AppError::Message("shortcuts must be different".into()));
        }
    }
    Ok(next)
}

pub fn install(app: &AppHandle, binds: &ShortcutBinds) -> Result<(), AppError> {
    let new_memo = parse_shortcut(&binds.new_memo)?;
    let toggle_pinned = parse_shortcut(&binds.toggle_pinned)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|err| AppError::Message(err.to_string()))?;
    app.global_shortcut()
        .register(new_memo)
        .map_err(|err| AppError::Message(err.to_string()))?;
    if let Err(err) = app.global_shortcut().register(toggle_pinned) {
        let _ = app.global_shortcut().unregister_all();
        return Err(AppError::Message(err.to_string()));
    }
    Ok(())
}

pub fn publish(app: &AppHandle, binds: &ShortcutBinds) {
    let _ = app.emit("shortcuts-changed", binds);
}

pub fn same(pressed: &Shortcut, binding: &str) -> bool {
    parse_shortcut(binding).ok().as_ref() == Some(pressed)
}

fn parse_shortcut(binding: &str) -> Result<Shortcut, AppError> {
    Shortcut::from_str(binding).map_err(|err| AppError::Message(err.to_string()))
}

fn canonical(binding: &str) -> Result<String, AppError> {
    Ok(parse_shortcut(binding)?.to_string())
}

fn canonical_modifier(value: &str) -> Result<String, AppError> {
    match value.trim().to_lowercase().as_str() {
        "alt" | "option" => Ok("Alt".into()),
        "control" | "ctrl" => Ok("Control".into()),
        "shift" => Ok("Shift".into()),
        "super" | "command" | "cmd" | "meta" => Ok("Super".into()),
        _ => Err(AppError::Message(
            "choose Alt, Control, Shift, or Command".into(),
        )),
    }
}

fn require_modifier(binding: &str) -> Result<(), AppError> {
    let shortcut = parse_shortcut(binding)?;
    if shortcut.mods.is_empty() {
        return Err(AppError::Message(
            "new memo and toggle pinned need a modifier key".into(),
        ));
    }
    Ok(())
}

fn command(key: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        format!("super+{key}")
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!("control+{key}")
    }
}

fn command_alt(key: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        format!("super+alt+{key}")
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!("control+alt+{key}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn alt_enter_is_only_the_alt_key() {
        let binding = canonical("Alt+Enter").unwrap();
        let shortcut = parse_shortcut(&binding).unwrap();
        assert_eq!(shortcut.mods, Modifiers::ALT);
        assert_eq!(shortcut.key, Code::Enter);
    }

    #[test]
    fn defaults_parse_and_stay_unique() {
        let binds = normalize(&ShortcutBinds::defaults()).unwrap();
        assert_eq!(binds.random_hue.to_lowercase(), "alt+enter");
        assert!(binds.new_memo.to_lowercase().contains("alt+"));
        assert_ne!(binds.new_memo, binds.toggle_pinned);
        assert_ne!(binds.preview, binds.random_hue);
    }

    #[test]
    fn duplicate_binds_are_rejected() {
        let mut binds = ShortcutBinds::defaults();
        binds.preview = binds.random_hue.clone();
        assert!(normalize(&binds).is_err());
    }

    #[test]
    fn global_bind_needs_a_modifier() {
        let mut binds = ShortcutBinds::defaults();
        binds.new_memo = "N".into();
        assert!(normalize(&binds).is_err());
    }

    #[test]
    fn stored_json_fills_only_the_saved_bind() {
        let db = crate::notes::Db::open_memory().unwrap();
        db.set_meta(KEY, r#"{"randomHue":"shift+H"}"#).unwrap();
        let binds = load(&db);
        let defaults = ShortcutBinds::defaults();
        assert_eq!(binds.new_memo, defaults.new_memo);
        assert_eq!(binds.random_hue.to_lowercase(), "shift+keyh");
        assert_eq!(binds.gesture, "Alt");
    }

    #[test]
    fn gesture_accepts_a_modifier_name() {
        let mut binds = ShortcutBinds::defaults();
        binds.gesture = "option".into();
        assert_eq!(normalize(&binds).unwrap().gesture, "Alt");
        binds.gesture = "ctrl".into();
        assert_eq!(normalize(&binds).unwrap().gesture, "Control");
    }

    #[test]
    fn gesture_rejects_a_full_shortcut() {
        let mut binds = ShortcutBinds::defaults();
        binds.gesture = "Alt+N".into();
        assert!(normalize(&binds).is_err());
    }
}
