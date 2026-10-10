use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::AppError;

pub const MAX_MEDIA_BYTES: usize = 25 * 1024 * 1024;

pub fn save(dir: &Path, bytes: &[u8]) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::Message("empty media".into()));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(AppError::Message("media is larger than 25 MB".into()));
    }
    let extension = sniff(bytes).ok_or_else(|| AppError::Message("unsupported media".into()))?;
    fs::create_dir_all(dir)?;
    let name = format!("{}.{}", Uuid::new_v4(), extension);
    let path = dir.join(&name);
    fs::write(&path, bytes)?;
    Ok(markdown(&name))
}

pub fn resolve(dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    if !valid_name(name) {
        return Err(AppError::Message("invalid media name".into()));
    }
    let path = dir.join(name);
    if !path.is_file() {
        return Err(AppError::Message("media file is missing".into()));
    }
    Ok(path)
}

pub fn markdown(name: &str) -> String {
    format!("![](memose-media/{name})")
}

pub fn content_for_remote(content: &str) -> String {
    let mut result = String::new();
    let mut rest = content;
    while let Some(start) = rest.find("![](memose-media/") {
        result.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.find(')') {
            rest = &after[end + 1..];
        } else {
            result.push_str(after);
            return cleanup(&result);
        }
    }
    result.push_str(rest);
    cleanup(&result)
}

fn cleanup(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn valid_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        && matches!(
            extension,
            "png" | "jpg" | "gif" | "webp" | "mp4" | "webm" | "mov"
        )
}

fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        if &bytes[8..12] == b"qt  " {
            Some("mov")
        } else {
            Some("mp4")
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_writes_a_file_and_keeps_bytes_out_of_the_reference() {
        let dir = std::env::temp_dir().join(format!("memose-media-{}", Uuid::new_v4()));
        let png: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-image";
        let markdown = save(&dir, png).unwrap();
        assert!(markdown.starts_with("![](memose-media/"));
        assert!(markdown.ends_with(".png)"));
        assert!(!markdown.contains("rest-of-image"));
        let name = markdown
            .trim_start_matches("![](memose-media/")
            .trim_end_matches(')');
        let stored = fs::read(dir.join(name)).unwrap();
        assert_eq!(stored, png);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_text_omits_local_media_refs() {
        let content = "hello\n![](memose-media/abc.png)\nworld";
        assert_eq!(content_for_remote(content), "hello\nworld");
        assert_eq!(content_for_remote("![](memose-media/abc.png)"), "");
    }
}
