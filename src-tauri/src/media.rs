use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use uuid::Uuid;

use crate::error::AppError;

pub const MAX_MEDIA_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRef {
    pub name: String,
    pub label: String,
    pub is_media: bool,
}

#[cfg(test)]
pub fn save(dir: &Path, bytes: &[u8]) -> Result<String, AppError> {
    save_named(dir, bytes, None, None)
}

pub fn save_named(
    dir: &Path,
    bytes: &[u8],
    filename: Option<&str>,
    mime: Option<&str>,
) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::Message("empty file".into()));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(AppError::Message("file is larger than 32 MB".into()));
    }

    #[cfg(target_os = "macos")]
    let converted = if is_tiff(bytes) {
        tiff_to_png(bytes)
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let converted: Option<Vec<u8>> = None;

    let payload = converted.as_deref().unwrap_or(bytes);
    let orig_name = filename
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_generic_clipboard_name(s));

    let ext = if converted.is_some() {
        "png".to_string()
    } else if let Some(sniffed) = sniff(payload) {
        sniffed.to_string()
    } else if let Some(ext) = orig_name.and_then(extension_from_filename) {
        ext
    } else if let Some(ext) = filename.and_then(extension_from_filename) {
        ext
    } else if let Some(ext) = mime.and_then(extension_from_mime) {
        ext.to_string()
    } else {
        "bin".to_string()
    };

    fs::create_dir_all(dir)?;
    let stored_name = build_stored_name(orig_name, &ext);
    let path = dir.join(&stored_name);
    fs::write(&path, payload)?;

    let display_label = orig_name
        .map(|raw| ensure_extension(raw, &ext))
        .unwrap_or_default();
    Ok(format_markdown(&stored_name, &display_label))
}

pub fn save_file_path(dir: &Path, source: &Path) -> Result<String, AppError> {
    if !source.is_file() {
        return Err(AppError::Message("file does not exist".into()));
    }
    let metadata = fs::metadata(source)?;
    if metadata.len() == 0 {
        return Err(AppError::Message("empty file".into()));
    }
    if metadata.len() > MAX_MEDIA_BYTES as u64 {
        return Err(AppError::Message("file is larger than 32 MB".into()));
    }
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let bytes = fs::read(source)?;
    save_named(dir, &bytes, Some(filename), None)
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

pub fn reveal_in_folder(dir: &Path, name: &str) -> Result<(), AppError> {
    let path = resolve(dir, name)?;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|err| AppError::Message(format!("could not reveal file: {err}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|err| AppError::Message(format!("could not reveal file: {err}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = path.parent().unwrap_or(dir);
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|err| AppError::Message(format!("could not reveal file: {err}")))?;
    }
    Ok(())
}

pub fn open_file(dir: &Path, name: &str) -> Result<(), AppError> {
    let path = resolve(dir, name)?;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|err| AppError::Message(format!("could not open file: {err}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|err| AppError::Message(format!("could not open file: {err}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|err| AppError::Message(format!("could not open file: {err}")))?;
    }
    Ok(())
}

pub fn paste_clipboard(dir: &Path) -> Result<Vec<String>, AppError> {
    #[cfg(target_os = "macos")]
    {
        paste_clipboard_macos(dir)
    }
    #[cfg(target_os = "windows")]
    {
        paste_clipboard_windows(dir)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = dir;
        Ok(Vec::new())
    }
}

pub fn format_markdown(stored_name: &str, label: &str) -> String {
    let clean_label = sanitize_markdown_label(label);
    let ext = stored_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if is_previewable_media_ext(&ext) {
        format!("![{clean_label}](memose-media/{stored_name})")
    } else {
        let shown = if clean_label.is_empty() {
            stored_name.to_string()
        } else {
            clean_label
        };
        format!("[{shown}](memose-media/{stored_name})")
    }
}

pub fn is_previewable_media_ext(ext: &str) -> bool {
    is_image_ext(ext) || is_video_ext(ext) || is_audio_ext(ext)
}

pub fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" | "heic" | "heif" | "tif" | "tiff"
    )
}

pub fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "ogv" | "avi"
    )
}

pub fn is_audio_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" | "opus" | "weba" | "wma"
    )
}

pub fn mime_for_name(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        "wma" => "audio/x-ms-wma",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "rtf" => "application/rtf",
        _ => "application/octet-stream",
    }
}

pub fn extract_refs(content: &str) -> Vec<MediaRef> {
    let mut refs = Vec::new();
    for parsed in extract_inline_tokens(content) {
        if !refs.iter().any(|existing: &MediaRef| existing.name == parsed.name) {
            refs.push(parsed);
        }
    }
    refs
}

pub fn parse_media_token(trimmed: &str) -> Option<MediaRef> {
    let (is_bang, rest) = if let Some(r) = trimmed.strip_prefix("![") {
        (true, r)
    } else {
        (false, trimmed.strip_prefix('[')?)
    };
    let (label, after_bracket) = rest.split_once("](memose-media/")?;
    let name_part = after_bracket.strip_suffix(')')?;
    let name = name_part.split(['#', '?']).next().unwrap_or(name_part);
    if !valid_name(name) {
        return None;
    }
    let clean_label = label.split('|').next().unwrap_or(label);
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    Some(MediaRef {
        name: name.to_string(),
        label: clean_label.to_string(),
        is_media: is_bang || is_previewable_media_ext(&ext),
    })
}

fn extract_inline_tokens(text: &str) -> Vec<MediaRef> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("](memose-media/") {
        let before = &rest[..pos];
        let after = &rest[pos + 15..];
        let Some(end) = after.find(')') else {
            break;
        };
        if let Some(open_idx) = before.rfind('[') {
            let start = if open_idx > 0 && before.as_bytes()[open_idx - 1] == b'!' {
                open_idx - 1
            } else {
                open_idx
            };
            let token = &rest[start..pos + 15 + end + 1];
            if let Some(parsed) = parse_media_token(token) {
                out.push(parsed);
            }
        }
        rest = &after[end + 1..];
    }
    out
}

pub fn content_for_remote(content: &str) -> String {
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if parse_media_token(trimmed).is_some() {
            continue;
        }
        let stripped = strip_inline_media(trimmed);
        if !stripped.is_empty() {
            lines.push(stripped);
        }
    }
    lines.join("\n")
}

pub fn merge_local_media(local_content: &str, remote_text: &str) -> String {
    let local_refs: Vec<String> = local_content
        .lines()
        .map(str::trim)
        .filter(|line| parse_media_token(line).is_some())
        .map(str::to_string)
        .collect();
    if local_refs.is_empty() {
        return remote_text.to_string();
    }
    let mut parts = Vec::new();
    let trimmed_remote = remote_text.trim();
    if !trimmed_remote.is_empty() {
        parts.push(trimmed_remote.to_string());
    }
    for line in local_refs {
        if !parts.iter().any(|p| p == &line) {
            parts.push(line);
        }
    }
    parts.join("\n")
}

fn strip_inline_media(line: &str) -> String {
    let mut result = String::new();
    let mut rest = line;
    while let Some(pos) = rest.find("](memose-media/") {
        let before = &rest[..pos];
        let open_bracket = before.rfind('[');
        let Some(open_idx) = open_bracket else {
            result.push_str(&rest[..pos + 15]);
            rest = &rest[pos + 15..];
            continue;
        };
        let start = if open_idx > 0 && before.as_bytes()[open_idx - 1] == b'!' {
            open_idx - 1
        } else {
            open_idx
        };
        result.push_str(&rest[..start]);
        let after = &rest[pos + 15..];
        if let Some(end) = after.find(')') {
            rest = &after[end + 1..];
        } else {
            return result.trim().to_string();
        }
    }
    result.push_str(rest);
    result.trim().to_string()
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn valid_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && !extension.is_empty()
        && extension.len() <= 12
        && !name.contains("..")
        && stem
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
        && extension.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn is_generic_clipboard_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "image.png" | "image.jpg" | "image.jpeg" | "image.tiff" | "image.tif" | "image.gif" | "image.webp" | "blob" | "clipboard"
    )
}

fn extension_from_filename(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    let clean: String = ext
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn extension_from_mime(mime: &str) -> Option<&'static str> {
    let essence = mime.split(';').next().unwrap_or(mime).trim().to_ascii_lowercase();
    match essence.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/avif" => Some("avif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/tiff" => Some("tiff"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/x-matroska" => Some("mkv"),
        "video/ogg" => Some("ogv"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/ogg" => Some("ogg"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/aac" => Some("aac"),
        "audio/flac" => Some("flac"),
        "audio/webm" => Some("weba"),
        "application/pdf" => Some("pdf"),
        "text/plain" => Some("txt"),
        "text/markdown" => Some("md"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        "application/zip" => Some("zip"),
        _ => None,
    }
}

fn build_stored_name(orig_name: Option<&str>, ext: &str) -> String {
    let uuid = Uuid::new_v4().to_string();
    let Some(raw) = orig_name else {
        return format!("{uuid}.{ext}");
    };
    let stem = raw
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(raw);
    let sanitized: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(48)
        .collect();
    if sanitized.is_empty() {
        format!("{uuid}.{ext}")
    } else {
        let short = &uuid[..8];
        format!("{short}-{sanitized}.{ext}")
    }
}

fn ensure_extension(filename: &str, ext: &str) -> String {
    if filename.rsplit_once('.').is_some_and(|(_, e)| !e.is_empty()) {
        filename.to_string()
    } else {
        format!("{filename}.{ext}")
    }
}

fn sanitize_markdown_label(label: &str) -> String {
    label
        .chars()
        .filter(|ch| *ch != '\n' && *ch != '\r')
        .map(|ch| match ch {
            '[' => '(',
            ']' => ')',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn is_tiff(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && (&bytes[0..4] == b"II*\x00" || &bytes[0..4] == b"MM\x00*")
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
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Some("wav")
    } else if bytes.starts_with(b"%PDF-") {
        Some("pdf")
    } else if bytes.starts_with(b"OggS") {
        Some("ogg")
    } else if bytes.starts_with(b"fLaC") {
        Some("flac")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
    {
        Some("mp3")
    } else if bytes.len() >= 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"qt  " {
            Some("mov")
        } else if brand == b"M4A " || brand == b"M4B " {
            Some("m4a")
        } else if brand == b"heic" || brand == b"heix" || brand == b"mif1" {
            Some("heic")
        } else if brand == b"avif" {
            Some("avif")
        } else {
            Some("mp4")
        }
    } else if is_tiff(bytes) {
        Some("tiff")
    } else if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        Some("bmp")
    } else {
        // ZIP-based Office formats (PK\x03\x04) and unknown binary formats fall back to filename/MIME hints.
        None
    }
}

#[cfg(target_os = "macos")]
struct AutoreleasePool(*mut std::ffi::c_void);

#[cfg(target_os = "macos")]
impl AutoreleasePool {
    unsafe fn new() -> Self {
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_autoreleasePoolPush() -> *mut std::ffi::c_void;
        }
        Self(objc_autoreleasePoolPush())
    }
}

#[cfg(target_os = "macos")]
impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_autoreleasePoolPop(pool: *mut std::ffi::c_void);
        }
        unsafe {
            objc_autoreleasePoolPop(self.0);
        }
    }
}

#[cfg(target_os = "macos")]
fn tiff_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::ffi::{c_char, c_void};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    unsafe {
        let _pool = AutoreleasePool::new();
        let send_data: unsafe extern "C" fn(*mut c_void, *mut c_void, *const u8, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_obj1: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_rep: unsafe extern "C" fn(*mut c_void, *mut c_void, usize, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_len: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let send_bytes: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const u8 =
            std::mem::transmute(objc_msgSend as *const ());

        let ns_data_cls = objc_getClass(c"NSData".as_ptr());
        let sel_data = sel_registerName(c"dataWithBytes:length:".as_ptr());
        let ns_data = send_data(ns_data_cls, sel_data, bytes.as_ptr(), bytes.len());
        if ns_data.is_null() {
            return None;
        }

        let rep_cls = objc_getClass(c"NSBitmapImageRep".as_ptr());
        let sel_rep = sel_registerName(c"imageRepWithData:".as_ptr());
        let rep = send_obj1(rep_cls, sel_rep, ns_data);
        if rep.is_null() {
            return None;
        }

        // NSBitmapImageFileTypePNG = 4
        let sel_png = sel_registerName(c"representationUsingType:properties:".as_ptr());
        let png_data = send_rep(rep, sel_png, 4, std::ptr::null_mut());
        if png_data.is_null() {
            return None;
        }

        let len = send_len(png_data, sel_registerName(c"length".as_ptr()));
        let ptr = send_bytes(png_data, sel_registerName(c"bytes".as_ptr()));
        if len == 0 || ptr.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(ptr, len).to_vec())
    }
}

#[cfg(target_os = "macos")]
fn paste_clipboard_macos(dir: &Path) -> Result<Vec<String>, AppError> {
    use std::ffi::{c_char, c_void, CStr};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    unsafe {
        let _pool = AutoreleasePool::new();
        let send0: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_str: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_obj1: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_count: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let send_idx: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_utf8: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const c_char =
            std::mem::transmute(objc_msgSend as *const ());
        let send_bytes: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const u8 =
            std::mem::transmute(objc_msgSend as *const ());

        let ns_string_cls = objc_getClass(c"NSString".as_ptr());
        let sel_utf8_str = sel_registerName(c"stringWithUTF8String:".as_ptr());
        let make_nsstring = |s: &CStr| -> *mut c_void {
            send_str(ns_string_cls, sel_utf8_str, s.as_ptr())
        };

        let pb_cls = objc_getClass(c"NSPasteboard".as_ptr());
        let pb = send0(pb_cls, sel_registerName(c"generalPasteboard".as_ptr()));
        if pb.is_null() {
            return Ok(Vec::new());
        }

        // 1. Check for copied files from Finder (NSFilenamesPboardType)
        let sel_prop = sel_registerName(c"propertyListForType:".as_ptr());
        let filenames_type = make_nsstring(c"NSFilenamesPboardType");
        let file_array = send_obj1(pb, sel_prop, filenames_type);
        let mut results = Vec::new();
        if !file_array.is_null() {
            let count = send_count(file_array, sel_registerName(c"count".as_ptr()));
            let sel_obj_at = sel_registerName(c"objectAtIndex:".as_ptr());
            let sel_cstr = sel_registerName(c"UTF8String".as_ptr());
            for i in 0..count {
                let item = send_idx(file_array, sel_obj_at, i);
                if item.is_null() {
                    continue;
                }
                let cstr = send_utf8(item, sel_cstr);
                if cstr.is_null() {
                    continue;
                }
                if let Ok(path_str) = CStr::from_ptr(cstr).to_str() {
                    let path = PathBuf::from(path_str);
                    if path.is_file() {
                        if let Ok(md) = save_file_path(dir, &path) {
                            results.push(md);
                        }
                    }
                }
            }
            if !results.is_empty() {
                return Ok(results);
            }
        }

        // 2. Also check public.file-url if NSFilenamesPboardType was empty
        let sel_str_for = sel_registerName(c"stringForType:".as_ptr());
        let file_url_type = make_nsstring(c"public.file-url");
        let file_url_ns = send_obj1(pb, sel_str_for, file_url_type);
        if !file_url_ns.is_null() {
            let ns_url_cls = objc_getClass(c"NSURL".as_ptr());
            let url = send_obj1(ns_url_cls, sel_registerName(c"URLWithString:".as_ptr()), file_url_ns);
            if !url.is_null() {
                let path_ns = send0(url, sel_registerName(c"path".as_ptr()));
                if !path_ns.is_null() {
                    let cstr = send_utf8(path_ns, sel_registerName(c"UTF8String".as_ptr()));
                    if !cstr.is_null() {
                        if let Ok(path_str) = CStr::from_ptr(cstr).to_str() {
                            let path = PathBuf::from(path_str);
                            if path.is_file() {
                                if let Ok(md) = save_file_path(dir, &path) {
                                    return Ok(vec![md]);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. Check for PNG, JPEG, or TIFF image data on clipboard
        let sel_data_for = sel_registerName(c"dataForType:".as_ptr());
        let plain_text = send_obj1(pb, sel_str_for, make_nsstring(c"public.utf8-plain-text"));
        if !plain_text.is_null() {
            let cstr = send_utf8(plain_text, sel_registerName(c"UTF8String".as_ptr()));
            if !cstr.is_null() && !CStr::from_ptr(cstr).to_bytes().is_empty() {
                return Ok(Vec::new());
            }
        }

        let sel_len = sel_registerName(c"length".as_ptr());
        let sel_bytes = sel_registerName(c"bytes".as_ptr());

        for uti in [c"public.png", c"public.jpeg", c"public.tiff"] {
            let data = send_obj1(pb, sel_data_for, make_nsstring(uti));
            if data.is_null() {
                continue;
            }
            let len = send_count(data, sel_len);
            let ptr = send_bytes(data, sel_bytes);
            if len == 0 || ptr.is_null() {
                continue;
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            if let Ok(md) = save_named(dir, slice, None, None) {
                return Ok(vec![md]);
            }
        }

        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn paste_clipboard_windows(dir: &Path) -> Result<Vec<String>, AppError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    const CF_HDROP: u32 = 15;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut std::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(hdrop: *mut std::ffi::c_void, index: u32, buf: *mut u16, size: u32) -> u32;
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Ok(Vec::new());
        }
        let _guard = ClipboardGuard;
        let mut results = Vec::new();
        let hdrop = GetClipboardData(CF_HDROP);
        if !hdrop.is_null() {
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; (len + 1) as usize];
                let copied = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), len + 1);
                if copied > 0 {
                    let path = PathBuf::from(OsString::from_wide(&buf[..copied as usize]));
                    if path.is_file() {
                        if let Ok(md) = save_file_path(dir, &path) {
                            results.push(md);
                        }
                    }
                }
            }
        }
        Ok(results)
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
    fn save_named_preserves_document_links_and_audio_previews() {
        let dir = std::env::temp_dir().join(format!("memose-media-{}", Uuid::new_v4()));
        let pdf = b"%PDF-1.7 sample document";
        let doc_md = save_named(&dir, pdf, Some("Project Plan.pdf"), Some("application/pdf")).unwrap();
        assert!(doc_md.starts_with("[Project Plan.pdf](memose-media/"));
        assert!(doc_md.ends_with("-Project_Plan.pdf)"));
        let parsed = parse_media_token(&doc_md).unwrap();
        assert_eq!(parsed.label, "Project Plan.pdf");
        assert!(!parsed.is_media);

        let mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x00audio";
        let audio_md = save_named(&dir, mp3, Some("voice.mp3"), Some("audio/mpeg")).unwrap();
        assert!(audio_md.starts_with("![voice.mp3](memose-media/"));
        let parsed_audio = parse_media_token(&audio_md).unwrap();
        assert_eq!(parsed_audio.label, "voice.mp3");
        assert!(parsed_audio.is_media);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_text_omits_local_media_refs() {
        let content = "hello\n![](memose-media/abc.png)\n[report.pdf](memose-media/123-report.pdf)\nworld";
        assert_eq!(content_for_remote(content), "hello\nworld");
        assert_eq!(content_for_remote("![](memose-media/abc.png)"), "");
        assert_eq!(content_for_remote("[report.pdf](memose-media/123-report.pdf)"), "");
        let inline = "before ![photo.jpg](memose-media/abc.png#w=200&side=1) after";
        assert_eq!(content_for_remote(inline), "before  after");
        let refs = extract_refs(inline);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "abc.png");
        assert_eq!(refs[0].label, "photo.jpg");
    }

    #[test]
    fn resolve_rejects_path_traversal_and_invalid_names() {
        let dir = std::env::temp_dir().join(format!("memose-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let valid_file = "12345678-valid_file.png";
        fs::write(dir.join(valid_file), b"png").unwrap();

        assert!(resolve(&dir, "../etc/passwd").is_err());
        assert!(resolve(&dir, "sub/file.png").is_err());
        assert!(resolve(&dir, "sub\\file.png").is_err());
        assert!(resolve(&dir, ".hidden.png").is_err());
        assert!(resolve(&dir, "noextension").is_err());
        assert!(resolve(&dir, "bad$char.png").is_err());
        assert!(resolve(&dir, "12345678-missing.png").is_err());
        assert!(resolve(&dir, valid_file).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_media_token_handles_pipe_widths_fragments_and_rejects_traversal() {
        let piped = parse_media_token("![diagram.png|320](memose-media/12345678-diagram.png#w=320)").unwrap();
        assert_eq!(piped.name, "12345678-diagram.png");
        assert_eq!(piped.label, "diagram.png");
        assert!(piped.is_media);

        assert!(parse_media_token("![](memose-media/../secret.png)").is_none());
        assert!(parse_media_token("![label](https://example.com/a.png)").is_none());
    }

    #[test]
    fn base64_encode_and_magic_detection_cover_common_formats() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"hello memose 1.0!"), "aGVsbG8gbWVtb3NlIDEuMCE=");

        // Office ZIP containers (PK\x03\x04) defer to the filename extension instead of misclassifying.
        let dir = std::env::temp_dir().join(format!("memose-media-{}", Uuid::new_v4()));
        let docx_bytes = b"PK\x03\x04fake-docx-archive";
        let docx_md = save_named(&dir, docx_bytes, Some("Spec.docx"), None).unwrap();
        assert!(docx_md.starts_with("[Spec.docx](memose-media/"));
        assert!(docx_md.ends_with("-Spec.docx)"));
        let _ = fs::remove_dir_all(&dir);
    }
}
