//! The built-in recognizer: NVIDIA Parakeet v3 through ONNX Runtime.
//!
//! Neither the runtime library nor the model ships with the app. Both are downloaded
//! into the app data folder when the user asks for them, checked against a known
//! SHA-256, and loaded only while a recording runs.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams};
use transcribe_rs::onnx::Quantization;

use crate::error::AppError;

const MODEL_DIR: &str = "parakeet-tdt-0.6b-v3-int8";
const MODEL_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const MODEL_SHA256: &str = "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77";
const MODEL_BYTES: u64 = 478_517_071;
/// Files that must exist for the model to load.
const MODEL_FILES: [&str; 4] = [
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

const RUNTIME_BASE: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.24.2/";

/// One platform's ONNX Runtime download.
struct Runtime {
    archive: &'static str,
    sha256: &'static str,
    bytes: u64,
    /// Path of the library inside the archive.
    member: &'static str,
    /// Name the library is stored under.
    file: &'static str,
}

/// The runtime for this build target, when ONNX Runtime publishes one.
fn runtime() -> Option<Runtime> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(Runtime {
            archive: "onnxruntime-osx-arm64-1.24.2.tgz",
            sha256: "0af4fa503e8ea285245b47ee42d0a7461b8156a81270857da0c1d4ecf858abde",
            bytes: 31_604_221,
            member: "onnxruntime-osx-arm64-1.24.2/lib/libonnxruntime.1.24.2.dylib",
            file: "libonnxruntime.dylib",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(Runtime {
            archive: "onnxruntime-linux-x64-1.24.2.tgz",
            sha256: "43725474ba5663642e17684717946693850e2005efbd724ac72da278fead25e6",
            bytes: 8_123_282,
            member: "onnxruntime-linux-x64-1.24.2/lib/libonnxruntime.so.1.24.2",
            file: "libonnxruntime.so",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(Runtime {
            archive: "onnxruntime-linux-aarch64-1.24.2.tgz",
            sha256: "6715b3d19965a2a6981e78ed4ba24f17a8c30d2d26420dbed10aac7ceca0085e",
            bytes: 7_135_756,
            member: "onnxruntime-linux-aarch64-1.24.2/lib/libonnxruntime.so.1.24.2",
            file: "libonnxruntime.so",
        })
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(Runtime {
            archive: "onnxruntime-win-x64-1.24.2.zip",
            sha256: "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0",
            bytes: 74_075_355,
            member: "onnxruntime-win-x64-1.24.2/lib/onnxruntime.dll",
            file: "onnxruntime.dll",
        })
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Some(Runtime {
            archive: "onnxruntime-win-arm64-1.24.2.zip",
            sha256: "dd8180d98e5a0ead7ead99029acc80b86a8b905b9aba4cc978e388039bb5823b",
            bytes: 74_960_464,
            member: "onnxruntime-win-arm64-1.24.2/lib/onnxruntime.dll",
            file: "onnxruntime.dll",
        })
    } else {
        // Intel Macs: ONNX Runtime no longer publishes a build for them.
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The built-in recognizer can run on this computer.
    pub supported: bool,
    /// The runtime library and the model are both on disk.
    pub installed: bool,
    /// Size of what is still to download, in bytes.
    pub download_bytes: u64,
    /// Disk space the installed files use, in bytes.
    pub disk_bytes: u64,
}

fn runtime_path(dir: &Path) -> Option<PathBuf> {
    runtime().map(|runtime| dir.join(runtime.file))
}

fn model_path(dir: &Path) -> PathBuf {
    dir.join(MODEL_DIR)
}

fn model_ready(dir: &Path) -> bool {
    let model = model_path(dir);
    MODEL_FILES.iter().all(|name| model.join(name).is_file())
}

fn runtime_ready(dir: &Path) -> bool {
    runtime_path(dir).is_some_and(|path| path.is_file())
}

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                dir_bytes(&path)
            } else {
                entry.metadata().map_or(0, |meta| meta.len())
            }
        })
        .sum()
}

pub fn status(dir: &Path) -> Status {
    let Some(runtime) = runtime() else {
        return Status {
            supported: false,
            installed: false,
            download_bytes: 0,
            disk_bytes: 0,
        };
    };
    let has_runtime = runtime_ready(dir);
    let has_model = model_ready(dir);
    let mut download_bytes = 0;
    if !has_runtime {
        download_bytes += runtime.bytes;
    }
    if !has_model {
        download_bytes += MODEL_BYTES;
    }
    Status {
        supported: true,
        installed: has_runtime && has_model,
        download_bytes,
        disk_bytes: dir_bytes(dir),
    }
}

/// Deletes the runtime and the model. A loaded model keeps working until it is dropped.
pub fn remove(dir: &Path) -> Result<(), AppError> {
    if dir.is_dir() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// Download progress, sent to the settings window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    /// `runtime`, `model`, `unpacking`, `done`, or `error`.
    pub stage: String,
    pub error: Option<String>,
}

/// Streams `url` into `path`, hashing as it goes. The file is removed when the hash does not match.
async fn fetch(
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    sha256: &str,
    mut on_bytes: impl FnMut(u64),
) -> Result<(), AppError> {
    let mut response = http
        .get(url)
        .timeout(Duration::from_secs(3 * 60 * 60))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "download failed with status {}",
            response.status().as_u16()
        )));
    }
    let mut file = std::fs::File::create(path)?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk)?;
        on_bytes(chunk.len() as u64);
    }
    drop(file);
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != sha256 {
        let _ = std::fs::remove_file(path);
        return Err(AppError::Message(
            "the download did not match its checksum and was discarded".into(),
        ));
    }
    Ok(())
}

/// Entries may only land inside the target folder.
fn safe_member(path: &Path) -> bool {
    path.components()
        .all(|part| matches!(part, std::path::Component::Normal(_)))
}

fn unpack_tgz_member(archive: &Path, member: &str, target: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar.entries()? {
        let mut entry = entry?;
        if entry.path()?.to_string_lossy().trim_start_matches("./") == member {
            let mut out = std::fs::File::create(target)?;
            std::io::copy(&mut entry, &mut out)?;
            return Ok(());
        }
    }
    Err(AppError::Message(
        "the runtime archive does not hold the library".into(),
    ))
}

#[cfg(windows)]
fn unpack_zip_member(archive: &Path, member: &str, target: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| AppError::Message(format!("could not read the runtime archive: {err}")))?;
    let mut entry = zip
        .by_name(member)
        .map_err(|_| AppError::Message("the runtime archive does not hold the library".into()))?;
    let mut out = std::fs::File::create(target)?;
    std::io::copy(&mut entry, &mut out)?;
    Ok(())
}

fn unpack_runtime(archive: &Path, runtime: &Runtime, target: &Path) -> Result<(), AppError> {
    if runtime.archive.ends_with(".zip") {
        #[cfg(windows)]
        return unpack_zip_member(archive, runtime.member, target);
        #[cfg(not(windows))]
        return Err(AppError::Message("zip archives are for Windows".into()));
    }
    unpack_tgz_member(archive, runtime.member, target)
}

/// Unpacks the model archive into `dir`. Only plain files under the model folder are written.
fn unpack_model(archive: &Path, dir: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string());
        let Some(name) = name.filter(|name| !name.starts_with("._")) else {
            continue;
        };
        if !safe_member(&path) || !path.starts_with(MODEL_DIR) {
            continue;
        }
        let target = model_path(dir);
        std::fs::create_dir_all(&target)?;
        let mut out = std::fs::File::create(target.join(name))?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// Downloads whatever is missing. `report` gets the running total.
pub async fn install(
    http: &reqwest::Client,
    dir: &Path,
    report: impl Fn(Progress) + Send + Sync,
) -> Result<(), AppError> {
    let runtime = runtime().ok_or_else(|| {
        AppError::Message("the built-in recognizer is not available on this computer".into())
    })?;
    std::fs::create_dir_all(dir)?;
    let total = status(dir).download_bytes;
    let mut received = 0_u64;
    let mut last = 0_u64;
    let mut tick = |stage: &str, received: u64, force: bool| {
        // One report per megabyte is enough for a progress bar.
        if force || received - last >= 1_000_000 {
            last = received;
            report(Progress {
                received,
                total,
                stage: stage.into(),
                error: None,
            });
        }
    };

    if !runtime_ready(dir) {
        let archive = dir.join(format!("{}.part", runtime.archive));
        tick("runtime", received, true);
        fetch(
            http,
            &format!("{RUNTIME_BASE}{}", runtime.archive),
            &archive,
            runtime.sha256,
            |bytes| {
                received += bytes;
                tick("runtime", received, false);
            },
        )
        .await?;
        let target = dir.join(runtime.file);
        let unpacked = {
            let archive = archive.clone();
            let part = dir.join(format!("{}.part", runtime.file));
            tokio::task::spawn_blocking(move || {
                unpack_runtime(&archive, &runtime, &part)?;
                std::fs::rename(&part, &target)?;
                Ok::<(), AppError>(())
            })
            .await
            .map_err(|err| AppError::Message(format!("unpacking stopped: {err}")))?
        };
        let _ = std::fs::remove_file(&archive);
        unpacked?;
    }

    if !model_ready(dir) {
        let archive = dir.join("model.tar.gz.part");
        tick("model", received, true);
        fetch(http, MODEL_URL, &archive, MODEL_SHA256, |bytes| {
            received += bytes;
            tick("model", received, false);
        })
        .await?;
        tick("unpacking", received, true);
        let unpacked = {
            let archive = archive.clone();
            let dir = dir.to_path_buf();
            tokio::task::spawn_blocking(move || unpack_model(&archive, &dir))
                .await
                .map_err(|err| AppError::Message(format!("unpacking stopped: {err}")))?
        };
        let _ = std::fs::remove_file(&archive);
        unpacked?;
        if !model_ready(dir) {
            return Err(AppError::Message(
                "the model archive is missing files".into(),
            ));
        }
    }
    Ok(())
}

/// The runtime library is loaded once per run of the app. The result is remembered,
/// because a second attempt after a failure would not pick up a new file anyway.
static RUNTIME_LOADED: OnceLock<Result<(), String>> = OnceLock::new();

fn load_runtime(dir: &Path) -> Result<(), AppError> {
    // Loading must never be tried without the file: the ONNX bindings wait forever for it.
    let path = runtime_path(dir)
        .filter(|path| path.is_file())
        .ok_or_else(|| AppError::Message("download the speech model in Settings first".into()))?;
    RUNTIME_LOADED
        .get_or_init(|| {
            ort::init_from(&path)
                .map(|builder| {
                    builder.commit();
                })
                .map_err(|err| format!("could not load the speech runtime: {err}"))
        })
        .clone()
        .map_err(AppError::Message)
}

/// A loaded model. It holds about 1.3 GB of memory, so it lives only while recording is in use.
pub struct Engine {
    model: ParakeetModel,
}

impl Engine {
    /// Loads the runtime and the model. Takes about a second. Call it off the async threads.
    pub fn load(dir: &Path) -> Result<Self, AppError> {
        if !model_ready(dir) {
            return Err(AppError::Message(
                "download the speech model in Settings first".into(),
            ));
        }
        load_runtime(dir)?;
        let model = ParakeetModel::load(&model_path(dir), &Quantization::Int8)
            .map_err(|err| AppError::Message(format!("could not load the speech model: {err}")))?;
        Ok(Self { model })
    }

    /// Text of one slice of 16 kHz mono speech. The language is detected by the model.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, AppError> {
        self.model
            .transcribe_with(samples, &ParakeetParams::default())
            .map(|result| result.text.trim().to_string())
            .map_err(|err| AppError::Message(format!("speech recognition failed: {err}")))
    }
}

/// Reads the first bytes of a file, to tell an archive from an error page in tests.
#[cfg(test)]
fn head(path: &Path, len: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0; len];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut buf))
        .unwrap_or(0);
    buf.truncate(read);
    buf
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("memose-speech-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tgz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn status_reports_what_is_missing() {
        let dir = temp_dir("status");
        let empty = status(&dir);
        if !empty.supported {
            return;
        }
        assert!(!empty.installed);
        assert!(empty.download_bytes > MODEL_BYTES);
        let model = model_path(&dir);
        std::fs::create_dir_all(&model).unwrap();
        for name in MODEL_FILES {
            std::fs::write(model.join(name), b"x").unwrap();
        }
        let partly = status(&dir);
        assert!(!partly.installed);
        assert!(partly.download_bytes < MODEL_BYTES);
        std::fs::write(runtime_path(&dir).unwrap(), b"lib").unwrap();
        let full = status(&dir);
        assert!(full.installed);
        assert_eq!(full.download_bytes, 0);
        assert_eq!(full.disk_bytes, 7);
        remove(&dir).unwrap();
        assert!(!status(&dir).installed);
    }

    #[test]
    fn model_archive_unpacks_only_its_own_files() {
        let dir = temp_dir("unpack");
        let archive = dir.join("model.tar.gz");
        let mut entries: Vec<(String, &[u8])> = MODEL_FILES
            .iter()
            .map(|name| (format!("{MODEL_DIR}/{name}"), b"data".as_slice()))
            .collect();
        entries.push((format!("{MODEL_DIR}/._vocab.txt"), b"mac"));
        entries.push(("elsewhere/evil.txt".to_string(), b"no"));
        let borrowed: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(path, bytes)| (path.as_str(), *bytes))
            .collect();
        std::fs::File::create(&archive)
            .unwrap()
            .write_all(&tgz(&borrowed))
            .unwrap();
        assert_eq!(head(&archive, 2), [0x1f, 0x8b]);
        unpack_model(&archive, &dir).unwrap();
        assert!(model_ready(&dir));
        assert!(!model_path(&dir).join("._vocab.txt").exists());
        assert!(!dir.join("elsewhere").exists());
        remove(&dir).unwrap();
    }

    #[test]
    fn runtime_library_is_taken_out_of_its_archive() {
        let dir = temp_dir("runtime");
        let archive = dir.join("rt.tgz");
        std::fs::write(
            &archive,
            tgz(&[
                ("pkg/lib/other.txt", b"no"),
                ("pkg/lib/libonnx.so", b"library"),
            ]),
        )
        .unwrap();
        let target = dir.join("lib.out");
        unpack_tgz_member(&archive, "pkg/lib/libonnx.so", &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"library");
        assert!(unpack_tgz_member(&archive, "pkg/lib/missing", &target).is_err());
        remove(&dir).unwrap();
    }

    #[test]
    fn loading_without_files_fails_at_once() {
        let dir = temp_dir("load");
        let started = std::time::Instant::now();
        assert!(Engine::load(&dir).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        remove(&dir).unwrap();
    }

    /// Runs the real model. Needs the downloaded files and a 16 kHz mono 16-bit WAV:
    /// `MEMOSE_SPEECH_DIR=… MEMOSE_SPEECH_WAV=… cargo test real_model -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_model_transcribes_a_recording_cut_into_slices() {
        use crate::speech::audio::{ChunkPlan, Chunker};
        let dir = PathBuf::from(std::env::var("MEMOSE_SPEECH_DIR").expect("MEMOSE_SPEECH_DIR"));
        let wav =
            std::fs::read(std::env::var("MEMOSE_SPEECH_WAV").expect("MEMOSE_SPEECH_WAV")).unwrap();
        let data = wav
            .windows(4)
            .position(|w| w == b"data")
            .expect("data chunk")
            + 8;
        let samples: Vec<f32> = wav[data..]
            .chunks_exact(2)
            .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
            .collect();
        assert!(status(&dir).installed);
        let mut engine = Engine::load(&dir).unwrap();
        let mut chunker = Chunker::new(ChunkPlan::DICTATION);
        let mut slices = chunker.push(&samples);
        slices.extend(chunker.finish());
        assert!(!slices.is_empty());
        let text: Vec<String> = slices
            .iter()
            .map(|slice| engine.transcribe(slice).unwrap())
            .collect();
        println!("slices: {}", slices.len());
        println!("{}", text.join(" | "));
        assert!(text.iter().any(|part| !part.is_empty()));
    }

    #[test]
    fn unsafe_archive_paths_are_refused() {
        assert!(safe_member(Path::new("model/vocab.txt")));
        assert!(!safe_member(Path::new("../vocab.txt")));
        assert!(!safe_member(Path::new("/etc/passwd")));
    }
}
