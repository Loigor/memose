use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
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
            .and_then(|binding| canonical_list(&binding).ok())
            .unwrap_or(defaults.new_memo),
        toggle_pinned: stored
            .toggle_pinned
            .and_then(|binding| canonical_list(&binding).ok())
            .unwrap_or(defaults.toggle_pinned),
        preview: stored
            .preview
            .and_then(|binding| canonical_list(&binding).ok())
            .unwrap_or(defaults.preview),
        hide: stored
            .hide
            .and_then(|binding| canonical_list(&binding).ok())
            .unwrap_or(defaults.hide),
        random_hue: stored
            .random_hue
            .and_then(|binding| canonical_list(&binding).ok())
            .unwrap_or(defaults.random_hue),
        gesture: stored
            .gesture
            .and_then(|binding| canonical_modifier(&binding).ok())
            .unwrap_or(defaults.gesture),
    }
}

pub fn normalize(binds: &ShortcutBinds) -> Result<ShortcutBinds, AppError> {
    let next = ShortcutBinds {
        new_memo: canonical_list(&binds.new_memo)?,
        toggle_pinned: canonical_list(&binds.toggle_pinned)?,
        preview: canonical_list(&binds.preview)?,
        hide: canonical_list(&binds.hide)?,
        random_hue: canonical_list(&binds.random_hue)?,
        gesture: canonical_modifier(&binds.gesture)?,
    };
    require_modifier(&next.new_memo)?;
    require_modifier(&next.toggle_pinned)?;
    let mut seen = Vec::new();
    for binding in [
        &next.new_memo,
        &next.toggle_pinned,
        &next.preview,
        &next.hide,
        &next.random_hue,
    ] {
        for part in split_binds(binding) {
            let key = part.to_lowercase();
            if seen.iter().any(|other: &String| other == &key) {
                return Err(AppError::Message("shortcuts must be different".into()));
            }
            seen.push(key);
        }
    }
    Ok(next)
}

pub fn install(app: &AppHandle, binds: &ShortcutBinds) -> Result<(), AppError> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|err| AppError::Message(err.to_string()))?;
    for binding in keyboard_parts(&binds.new_memo)
        .into_iter()
        .chain(keyboard_parts(&binds.toggle_pinned))
    {
        let shortcut = parse_shortcut(&binding)?;
        if let Err(err) = app.global_shortcut().register(shortcut) {
            let _ = app.global_shortcut().unregister_all();
            return Err(AppError::Message(err.to_string()));
        }
    }
    Ok(())
}

pub fn publish(app: &AppHandle, binds: &ShortcutBinds) {
    let _ = app.emit("shortcuts-changed", binds);
}

pub fn same(pressed: &Shortcut, binding: &str) -> bool {
    keyboard_parts(binding)
        .iter()
        .any(|part| parse_shortcut(part).ok().as_ref() == Some(pressed))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MouseChord {
    button: u8,
    alt: bool,
    ctrl: bool,
    shift: bool,
    meta: bool,
}

type MouseBounce = (Instant, u8, bool, bool, bool, bool);

static LAST_MOUSE: Mutex<Option<MouseBounce>> = Mutex::new(None);

pub fn dispatch_mouse(app: &AppHandle, button: u8, alt: bool, ctrl: bool, shift: bool, meta: bool) {
    if !(3..=8).contains(&button) {
        return;
    }
    {
        let mut last = LAST_MOUSE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        if let Some((when, pressed, last_alt, last_ctrl, last_shift, last_meta)) = *last {
            if pressed == button
                && last_alt == alt
                && last_ctrl == ctrl
                && last_shift == shift
                && last_meta == meta
                && now.duration_since(when) < Duration::from_millis(150)
            {
                return;
            }
        }
        *last = Some((now, button, alt, ctrl, shift, meta));
    }
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let binds = state
        .shortcuts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if mouse_matches(&binds.new_memo, button, alt, ctrl, shift, meta) {
        crate::window_ctl::show_fresh_memo(app);
        return;
    }
    if mouse_matches(&binds.toggle_pinned, button, alt, ctrl, shift, meta) {
        crate::window_ctl::toggle_pinned(app);
        return;
    }
    let _ = app.emit(
        "mouse-chord",
        MouseChord {
            button,
            alt,
            ctrl,
            shift,
            meta,
        },
    );
}

fn parse_shortcut(binding: &str) -> Result<Shortcut, AppError> {
    Shortcut::from_str(binding).map_err(|err| AppError::Message(err.to_string()))
}

fn split_binds(binding: &str) -> Vec<String> {
    binding
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn canonical(binding: &str) -> Result<String, AppError> {
    Ok(parse_shortcut(binding)?.to_string())
}

fn canonical_list(binding: &str) -> Result<String, AppError> {
    let parts = split_binds(binding);
    if parts.is_empty() {
        return Err(AppError::Message("choose a shortcut".into()));
    }
    let mut stored = Vec::new();
    for part in parts {
        let next = if is_mouse_binding(&part) {
            canonical_mouse(&part)?
        } else {
            canonical(&part)?
        };
        if stored.iter().any(|kept: &String| kept.eq_ignore_ascii_case(&next)) {
            continue;
        }
        stored.push(next);
    }
    if stored.is_empty() {
        return Err(AppError::Message("choose a shortcut".into()));
    }
    Ok(stored.join(", "))
}

fn is_mouse_binding(binding: &str) -> bool {
    binding.split('+').any(|token| {
        let name = token.trim().to_lowercase();
        name.starts_with("mouse") && name.len() > 5 && name[5..].parse::<u8>().is_ok()
    })
}

fn canonical_mouse(binding: &str) -> Result<String, AppError> {
    let mut alt = false;
    let mut ctrl = false;
    let mut shift = false;
    let mut meta = false;
    let mut button: Option<u8> = None;
    for token in binding.split('+').map(str::trim).filter(|token| !token.is_empty()) {
        match token.to_lowercase().as_str() {
            "alt" | "option" => alt = true,
            "control" | "ctrl" => ctrl = true,
            "shift" => shift = true,
            "super" | "command" | "cmd" | "meta" => meta = true,
            other if other.starts_with("mouse") => {
                let number: u8 = other[5..]
                    .parse()
                    .map_err(|_| AppError::Message("use Mouse4 or Mouse5".into()))?;
                if !(3..=8).contains(&number) || button.is_some() {
                    return Err(AppError::Message("use Mouse4 or Mouse5".into()));
                }
                button = Some(number);
            }
            _ => {
                return Err(AppError::Message(format!("unknown key {token}")));
            }
        }
    }
    let Some(button) = button else {
        return Err(AppError::Message("use Mouse4 or Mouse5".into()));
    };
    let mut parts = Vec::new();
    if ctrl {
        parts.push("control".to_string());
    }
    if alt {
        parts.push("alt".to_string());
    }
    if shift {
        parts.push("shift".to_string());
    }
    if meta {
        parts.push("super".to_string());
    }
    parts.push(format!("Mouse{button}"));
    Ok(parts.join("+"))
}

fn keyboard_parts(binding: &str) -> Vec<String> {
    split_binds(binding)
        .into_iter()
        .filter(|part| !is_mouse_binding(part))
        .collect()
}

fn mouse_matches(binding: &str, button: u8, alt: bool, ctrl: bool, shift: bool, meta: bool) -> bool {
    split_binds(binding).into_iter().any(|part| {
        let Ok(stored) = canonical_mouse(&part) else {
            return false;
        };
        let Ok(flags) = mouse_flags(&stored) else {
            return false;
        };
        flags == (button, alt, ctrl, shift, meta)
    })
}

fn mouse_flags(binding: &str) -> Result<(u8, bool, bool, bool, bool), AppError> {
    let stored = canonical_mouse(binding)?;
    let mut alt = false;
    let mut ctrl = false;
    let mut shift = false;
    let mut meta = false;
    let mut button = 0;
    for token in stored.split('+') {
        match token {
            "alt" => alt = true,
            "control" => ctrl = true,
            "shift" => shift = true,
            "super" => meta = true,
            other if other.starts_with("Mouse") => {
                button = other[5..].parse().unwrap_or(0);
            }
            _ => {}
        }
    }
    Ok((button, alt, ctrl, shift, meta))
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
    for part in split_binds(binding) {
        let held = if is_mouse_binding(&part) {
            mouse_flags(&part)?.1 || mouse_flags(&part)?.2 || mouse_flags(&part)?.3 || mouse_flags(&part)?.4
        } else {
            !parse_shortcut(&part)?.mods.is_empty()
        };
        if !held {
            return Err(AppError::Message(
                "new memo and toggle pinned need a modifier key".into(),
            ));
        }
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
    fn one_action_can_keep_a_key_and_a_side_button() {
        let mut binds = ShortcutBinds::defaults();
        binds.new_memo = format!("{}, alt+mouse4", binds.new_memo);
        let next = normalize(&binds).unwrap();
        assert!(next.new_memo.contains(','));
        assert!(next.new_memo.to_lowercase().contains("mouse4"));
        assert!(next.new_memo.to_lowercase().contains("alt+"));
    }

    #[test]
    fn a_side_button_still_needs_a_modifier_for_new_memo() {
        let mut binds = ShortcutBinds::defaults();
        binds.new_memo = "Mouse4".into();
        assert!(normalize(&binds).is_err());
    }

    #[test]
    fn the_same_side_button_cannot_belong_to_two_actions() {
        let mut binds = ShortcutBinds::defaults();
        binds.preview = format!("{}, alt+Mouse4", binds.preview);
        binds.hide = "alt+Mouse4".into();
        assert!(normalize(&binds).is_err());
    }

    #[test]
    fn gesture_rejects_a_full_shortcut() {
        let mut binds = ShortcutBinds::defaults();
        binds.gesture = "Alt+N".into();
        assert!(normalize(&binds).is_err());
    }
}
