//! The built-in recognizers, run through ONNX Runtime: NVIDIA Parakeet v3 and Canary 1B v2.
//!
//! Neither the runtime library nor a model ships with the app. They are downloaded into
//! the app data folder when the user asks for them, checked against a known SHA-256, and
//! loaded only while recording or re-analysis uses them.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use transcribe_rs::onnx::canary::{CanaryModel, CanaryParams};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams};
use transcribe_rs::onnx::Quantization;

use crate::error::AppError;

/// A speech model the app can download and run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelId {
    Parakeet,
    Canary,
}

impl ModelId {
    pub const ALL: [Self; 2] = [Self::Parakeet, Self::Canary];

    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("canary") => Self::Canary,
            _ => Self::Parakeet,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parakeet => "parakeet",
            Self::Canary => "canary",
        }
    }

    fn spec(self) -> &'static ModelSpec {
        match self {
            Self::Parakeet => &PARAKEET,
            Self::Canary => &CANARY,
        }
    }
}

/// One file of a model, fetched on its own.
struct ModelFile {
    url: &'static str,
    name: &'static str,
    sha256: &'static str,
    bytes: u64,
}

enum Source {
    /// One archive with a folder of the model's name.
    Archive {
        url: &'static str,
        sha256: &'static str,
        bytes: u64,
    },
    Files(&'static [ModelFile]),
}

/// What the settings show for a model. Memory and speed were measured on an Apple M1 Pro,
/// running on the CPU, with three Finnish test clips.
struct ModelSpec {
    name: &'static str,
    summary: &'static str,
    /// The folder under the speech folder.
    dir: &'static str,
    /// Files that must exist for the model to load.
    files: &'static [&'static str],
    source: Source,
    /// Disk space once installed, in bytes.
    disk_bytes: u64,
    /// Peak memory while it runs, in MB.
    memory_mb: u32,
    /// How many times faster than real time.
    speed: u32,
    /// Seconds to load before the first words.
    load_secs: f32,
    /// The language must be named; the model does not detect it.
    needs_language: bool,
}

const PARAKEET: ModelSpec = ModelSpec {
    name: "Parakeet v3",
    summary:
        "Fast. Finds the language by itself. 25 European languages, Finnish and English among them.",
    dir: "parakeet-tdt-0.6b-v3-int8",
    files: &[
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
        "nemo128.onnx",
        "vocab.txt",
    ],
    source: Source::Archive {
        url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
        sha256: "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77",
        bytes: 478_517_071,
    },
    disk_bytes: 670_620_000,
    memory_mb: 1270,
    speed: 23,
    load_secs: 1.2,
    needs_language: false,
};

const CANARY: ModelSpec = ModelSpec {
    name: "Canary 1B v2",
    summary: "More accurate, about half as fast. The same 25 European languages; set the language below.",
    dir: "canary-1b-v2-int8",
    files: &["encoder-model.int8.onnx", "decoder-model.int8.onnx", "nemo128.onnx", "vocab.txt"],
    source: Source::Files(&[
        ModelFile {
            url: "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/encoder-model.int8.onnx",
            name: "encoder-model.int8.onnx",
            sha256: "6d96e9945898e5ace48f4efecd459ca1df81859730be27b8af6b197639403ee1",
            bytes: 859_078_138,
        },
        ModelFile {
            url: "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/decoder-model.int8.onnx",
            name: "decoder-model.int8.onnx",
            sha256: "52d83aa7aad41fbbe4f9dfcd341d784735a6eb4c6eb0d3290fc27a0d8ac39abf",
            bytes: 170_040_374,
        },
        ModelFile {
            url: "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/vocab.txt",
            name: "vocab.txt",
            sha256: "2c9efe6104fd29522ea27ce0e3aef5d37c690af4e5a4232e643e23ca403ffea3",
            bytes: 208_022,
        },
        ModelFile {
            url: "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/config.json",
            name: "config.json",
            sha256: "f90ace8e35326dcd47c7330b230644fa0835083ed1e89e2f59aa08ba10d74f54",
            bytes: 68,
        },
        // Canary's repository has no audio preprocessor. It uses the same one as Parakeet.
        ModelFile {
            url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx",
            name: "nemo128.onnx",
            sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
            bytes: 139_764,
        },
    ]),
    disk_bytes: 1_029_466_366,
    memory_mb: 1770,
    speed: 12,
    load_secs: 5.6,
    needs_language: true,
};

impl Source {
    fn bytes(&self) -> u64 {
        match self {
            Self::Archive { bytes, .. } => *bytes,
            Self::Files(files) => files.iter().map(|file| file.bytes).sum(),
        }
    }
}

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: ModelId,
    pub name: &'static str,
    pub summary: &'static str,
    pub installed: bool,
    /// What a download fetches now, the runtime included when it is missing.
    pub download_bytes: u64,
    /// Disk space once installed.
    pub disk_bytes: u64,
    pub memory_mb: u32,
    pub speed: u32,
    pub load_secs: f32,
    pub needs_language: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The built-in recognizers can run on this computer.
    pub supported: bool,
    /// The runtime and `model` are both on disk.
    pub installed: bool,
    /// The model in use.
    pub model: ModelId,
    /// What a download of `model` fetches now, in bytes.
    pub download_bytes: u64,
    /// Disk space the speech folder uses, in bytes.
    pub disk_bytes: u64,
    pub models: Vec<ModelStatus>,
}

fn runtime_path(dir: &Path) -> Option<PathBuf> {
    runtime().map(|runtime| dir.join(runtime.file))
}

fn model_path(dir: &Path, id: ModelId) -> PathBuf {
    dir.join(id.spec().dir)
}

fn model_ready(dir: &Path, id: ModelId) -> bool {
    let model = model_path(dir, id);
    id.spec()
        .files
        .iter()
        .all(|name| model.join(name).is_file())
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

pub fn status(dir: &Path, model: ModelId) -> Status {
    let runtime = runtime();
    let missing_runtime = match &runtime {
        Some(runtime) if !runtime_ready(dir) => runtime.bytes,
        _ => 0,
    };
    let models: Vec<ModelStatus> = ModelId::ALL
        .iter()
        .map(|id| {
            let spec = id.spec();
            let installed = runtime.is_some() && model_ready(dir, *id);
            ModelStatus {
                id: *id,
                name: spec.name,
                summary: spec.summary,
                installed: installed && missing_runtime == 0,
                download_bytes: if model_ready(dir, *id) {
                    0
                } else {
                    spec.source.bytes()
                } + missing_runtime,
                disk_bytes: spec.disk_bytes,
                memory_mb: spec.memory_mb,
                speed: spec.speed,
                load_secs: spec.load_secs,
                needs_language: spec.needs_language,
            }
        })
        .collect();
    let chosen = models.iter().find(|item| item.id == model);
    Status {
        supported: runtime.is_some(),
        installed: chosen.is_some_and(|item| item.installed),
        model,
        download_bytes: chosen.map_or(0, |item| item.download_bytes),
        disk_bytes: dir_bytes(dir),
        models,
    }
}

/// Deletes one model. The runtime goes too when no model is left.
/// A loaded model keeps working until it is dropped.
pub fn remove(dir: &Path, id: ModelId) -> Result<(), AppError> {
    let path = model_path(dir, id);
    if path.is_dir() {
        std::fs::remove_dir_all(&path)?;
    }
    if ModelId::ALL.iter().all(|other| !model_ready(dir, *other)) && dir.is_dir() {
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

/// Unpacks a model archive into `dir`. Only plain files under the model folder are written.
fn unpack_model(archive: &Path, dir: &Path, id: ModelId) -> Result<(), AppError> {
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
        if !safe_member(&path) || !path.starts_with(id.spec().dir) {
            continue;
        }
        let target = model_path(dir, id);
        std::fs::create_dir_all(&target)?;
        let mut out = std::fs::File::create(target.join(name))?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// Downloads what `id` needs that is missing. `report` gets the running total.
pub async fn install(
    http: &reqwest::Client,
    dir: &Path,
    id: ModelId,
    report: impl Fn(Progress) + Send + Sync,
) -> Result<(), AppError> {
    let runtime = runtime().ok_or_else(|| {
        AppError::Message("the built-in recognizer is not available on this computer".into())
    })?;
    std::fs::create_dir_all(dir)?;
    let total = status(dir, id).download_bytes;
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

    if !model_ready(dir, id) {
        let target = model_path(dir, id);
        match &id.spec().source {
            Source::Archive { url, sha256, .. } => {
                let archive = dir.join(format!("{}.tar.gz.part", id.as_str()));
                tick("model", received, true);
                fetch(http, url, &archive, sha256, |bytes| {
                    received += bytes;
                    tick("model", received, false);
                })
                .await?;
                tick("unpacking", received, true);
                let unpacked = {
                    let archive = archive.clone();
                    let dir = dir.to_path_buf();
                    tokio::task::spawn_blocking(move || unpack_model(&archive, &dir, id))
                        .await
                        .map_err(|err| AppError::Message(format!("unpacking stopped: {err}")))?
                };
                let _ = std::fs::remove_file(&archive);
                unpacked?;
            }
            Source::Files(files) => {
                std::fs::create_dir_all(&target)?;
                tick("model", received, true);
                for file in files.iter() {
                    let done = target.join(file.name);
                    if done.is_file() {
                        received += file.bytes;
                        continue;
                    }
                    let part = target.join(format!("{}.part", file.name));
                    fetch(http, file.url, &part, file.sha256, |bytes| {
                        received += bytes;
                        tick("model", received, false);
                    })
                    .await?;
                    std::fs::rename(&part, &done)?;
                }
            }
        }
        if !model_ready(dir, id) {
            return Err(AppError::Message(
                "the model download is missing files".into(),
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

enum Loaded {
    Parakeet(ParakeetModel),
    Canary(CanaryModel),
}

/// A loaded model. It holds well over a gigabyte of memory, so it lives only while in use.
pub struct Engine {
    id: ModelId,
    language: String,
    model: Loaded,
}

impl Engine {
    /// Loads the runtime and a model. Takes one to six seconds. Call it off the async threads.
    pub fn load(dir: &Path, id: ModelId, language: &str) -> Result<Self, AppError> {
        if !model_ready(dir, id) {
            return Err(AppError::Message(format!(
                "download {} in Settings first",
                id.spec().name
            )));
        }
        load_runtime(dir)?;
        let path = model_path(dir, id);
        let failed = |err: transcribe_rs::TranscribeError| {
            AppError::Message(format!("could not load the speech model: {err}"))
        };
        let model = match id {
            ModelId::Parakeet => {
                Loaded::Parakeet(ParakeetModel::load(&path, &Quantization::Int8).map_err(failed)?)
            }
            ModelId::Canary => {
                Loaded::Canary(CanaryModel::load(&path, &Quantization::Int8).map_err(failed)?)
            }
        };
        Ok(Self {
            id,
            language: language.to_string(),
            model,
        })
    }

    /// True when this engine is `id` set up for `language`.
    pub fn is(&self, id: ModelId, language: &str) -> bool {
        self.id == id && (self.language == language || !id.spec().needs_language)
    }

    /// Text of one slice of 16 kHz mono speech.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, AppError> {
        let result = match &mut self.model {
            Loaded::Parakeet(model) => model.transcribe_with(samples, &ParakeetParams::default()),
            Loaded::Canary(model) => {
                let language = if self.language.is_empty() {
                    "en".to_string()
                } else {
                    self.language.clone()
                };
                model.transcribe_with(
                    samples,
                    &CanaryParams {
                        language: Some(language),
                        ..Default::default()
                    },
                )
            }
        };
        result
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

    fn fake_install(dir: &Path, id: ModelId) {
        let model = model_path(dir, id);
        std::fs::create_dir_all(&model).unwrap();
        for name in id.spec().files {
            std::fs::write(model.join(name), b"x").unwrap();
        }
    }

    #[test]
    fn status_reports_each_model_and_what_is_missing() {
        let dir = temp_dir("status");
        let empty = status(&dir, ModelId::Parakeet);
        if !empty.supported {
            return;
        }
        assert!(!empty.installed);
        assert_eq!(empty.models.len(), 2);
        assert!(empty.download_bytes > PARAKEET.source.bytes());
        fake_install(&dir, ModelId::Parakeet);
        let partly = status(&dir, ModelId::Parakeet);
        assert!(!partly.installed, "the runtime is still missing");
        assert!(partly.download_bytes < PARAKEET.source.bytes());
        std::fs::write(runtime_path(&dir).unwrap(), b"lib").unwrap();
        let full = status(&dir, ModelId::Parakeet);
        assert!(full.installed);
        assert_eq!(full.download_bytes, 0);
        let canary = status(&dir, ModelId::Canary);
        assert!(!canary.installed);
        assert_eq!(canary.download_bytes, CANARY.source.bytes());
        assert!(canary
            .models
            .iter()
            .any(|item| item.id == ModelId::Parakeet && item.installed));
        remove(&dir, ModelId::Parakeet).unwrap();
        assert!(!dir.exists(), "the runtime goes with the last model");
    }

    #[test]
    fn removing_one_model_keeps_the_other_and_the_runtime() {
        let dir = temp_dir("remove");
        if runtime().is_none() {
            return;
        }
        fake_install(&dir, ModelId::Parakeet);
        fake_install(&dir, ModelId::Canary);
        std::fs::write(runtime_path(&dir).unwrap(), b"lib").unwrap();
        remove(&dir, ModelId::Canary).unwrap();
        assert!(model_ready(&dir, ModelId::Parakeet));
        assert!(!model_ready(&dir, ModelId::Canary));
        assert!(runtime_ready(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn canary_download_sizes_add_up() {
        assert_eq!(CANARY.source.bytes(), CANARY.disk_bytes);
        assert_eq!(ModelId::parse(Some("canary")), ModelId::Canary);
        assert_eq!(ModelId::parse(None), ModelId::Parakeet);
    }

    #[test]
    fn model_archive_unpacks_only_its_own_files() {
        let dir = temp_dir("unpack");
        let archive = dir.join("model.tar.gz");
        let folder = PARAKEET.dir;
        let mut entries: Vec<(String, &[u8])> = PARAKEET
            .files
            .iter()
            .map(|name| (format!("{folder}/{name}"), b"data".as_slice()))
            .collect();
        entries.push((format!("{folder}/._vocab.txt"), b"mac"));
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
        unpack_model(&archive, &dir, ModelId::Parakeet).unwrap();
        assert!(model_ready(&dir, ModelId::Parakeet));
        assert!(!model_path(&dir, ModelId::Parakeet)
            .join("._vocab.txt")
            .exists());
        assert!(!dir.join("elsewhere").exists());
        std::fs::remove_dir_all(&dir).unwrap();
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
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn loading_without_files_fails_at_once() {
        let dir = temp_dir("load");
        let started = std::time::Instant::now();
        assert!(Engine::load(&dir, ModelId::Parakeet, "").is_err());
        assert!(Engine::load(&dir, ModelId::Canary, "fi").is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::remove_dir_all(&dir).unwrap();
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
        let samples = crate::speech::wav_samples(&wav).unwrap();
        let id = ModelId::parse(std::env::var("MEMOSE_SPEECH_MODEL").ok().as_deref());
        let language = std::env::var("MEMOSE_SPEECH_LANGUAGE").unwrap_or_default();
        assert!(status(&dir, id).installed);
        let mut engine = Engine::load(&dir, id, &language).unwrap();
        // The same cut as re-analysis of a saved recording.
        let mut chunker = Chunker::new(ChunkPlan {
            pause_ms: 900,
            max_ms: 28_000,
        });
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
