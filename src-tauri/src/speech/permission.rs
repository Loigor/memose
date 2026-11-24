//! Microphone permission.
//!
//! macOS gives an app that may not use the microphone silent sound instead of an error,
//! and only lists an app under Privacy & Security › Microphone after it has asked.
//! So the app asks through AVFoundation before it opens the microphone.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(target_os = "macos"),
    expect(dead_code, reason = "only the macOS permission check builds these")
)]
pub enum Access {
    /// The system has not asked yet. The next recording asks.
    Unknown,
    Granted,
    /// The user said no, or a policy forbids it. Only System Settings can change it.
    Denied,
    /// The platform has no such permission.
    NotNeeded,
}

/// Who macOS asks on behalf of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub access: Access,
    /// The app runs outside an app bundle (`tauri dev`). macOS then asks for, and lists,
    /// the app that started it, such as the terminal or the editor.
    pub borrowed: bool,
}

/// True when this executable sits inside an `.app` bundle.
fn bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.to_str()
                .map(|path| path.contains(".app/Contents/MacOS/"))
        })
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::time::Duration;

    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    use super::Access;

    pub fn access() -> Access {
        // SAFETY: a read of a framework constant and a class method without side effects.
        let Some(media) = (unsafe { AVMediaTypeAudio }) else {
            return Access::NotNeeded;
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
        match status {
            AVAuthorizationStatus::Authorized => Access::Granted,
            AVAuthorizationStatus::NotDetermined => Access::Unknown,
            _ => Access::Denied,
        }
    }

    /// Shows the system prompt when it has not been answered, and waits for the answer.
    pub fn request() -> Access {
        let current = access();
        if current != Access::Unknown {
            return current;
        }
        let Some(media) = (unsafe { AVMediaTypeAudio }) else {
            return Access::NotNeeded;
        };
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: the handler is `Send`-safe (it only sends on a channel) and lives in an RcBlock.
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &handler);
        }
        // The user may take a while to answer the prompt.
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => Access::Granted,
            Ok(false) => Access::Denied,
            Err(_) => access(),
        }
    }
}

pub fn status() -> Permission {
    #[cfg(target_os = "macos")]
    let access = mac::access();
    #[cfg(not(target_os = "macos"))]
    let access = Access::NotNeeded;
    Permission {
        access,
        borrowed: cfg!(target_os = "macos") && !bundled(),
    }
}

/// Asks when needed. Call it off the main thread: it waits for the user.
pub fn request() -> Permission {
    #[cfg(target_os = "macos")]
    let access = mac::request();
    #[cfg(not(target_os = "macos"))]
    let access = Access::NotNeeded;
    Permission {
        access,
        borrowed: cfg!(target_os = "macos") && !bundled(),
    }
}

/// What to tell the user when the microphone may not be used.
pub fn denied_message(borrowed: bool) -> String {
    if borrowed {
        "Memose runs from a terminal, so macOS decides for the app that started it. Allow that app (for example Cursor or Terminal) in System Settings › Privacy & Security › Microphone, then start it again.".into()
    } else {
        "Memose may not use the microphone. Allow it in System Settings › Privacy & Security › Microphone.".into()
    }
}

/// Opens the Microphone page of the system privacy settings.
pub fn open_settings() -> Result<(), crate::error::AppError> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|err| {
                crate::error::AppError::Message(format!("could not open System Settings: {err}"))
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|err| {
                crate::error::AppError::Message(format!("could not open Settings: {err}"))
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_runs_are_not_inside_a_bundle() {
        assert!(!bundled());
        let found = status();
        if cfg!(target_os = "macos") {
            assert!(found.borrowed);
        } else {
            assert_eq!(found.access, Access::NotNeeded);
        }
    }

    #[test]
    fn messages_name_the_right_app() {
        assert!(denied_message(true).contains("terminal"));
        assert!(denied_message(false).contains("Allow it"));
    }
}
