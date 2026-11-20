#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use arboard::{Clipboard, ImageData};
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{
    imageops, DynamicImage, ExtendedColorType, GenericImageView, ImageDecoder, ImageEncoder,
    ImageFormat, ImageReader, RgbaImage,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CreateMutexW;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};

const ICO_MAX: u32 = 256;
const UNDO_LIMIT: usize = 10;
const UNDO_BUDGET_BYTES: usize = 256 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;
const PREVIEW_MAX: u32 = 2560;
const MIN_CROP_SIZE: i64 = 2;
const DEFAULT_SIZES: [u32; 6] = [256, 128, 64, 48, 32, 16];
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static NEXT_CONTENT_ID: AtomicU64 = AtomicU64::new(1);
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
const SINGLE_INSTANCE_NAME: &str = "Local\\IcoCreator-com.dsh.icocreator";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    last_open_dir: String,
    last_save_dir: String,
    last_batch_dir: String,
    ico_sizes: Vec<u32>,
    square_mode: String,
    ratio: String,
    custom_ratio: [i64; 2],
    guides: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            last_open_dir: String::new(),
            last_save_dir: String::new(),
            last_batch_dir: String::new(),
            ico_sizes: DEFAULT_SIZES.to_vec(),
            square_mode: "pad".into(),
            ratio: "free".into(),
            custom_ratio: [16, 9],
            guides: true,
        }
    }
}

fn clean_settings(mut s: Settings) -> Settings {
    let d = Settings::default();
    if s.square_mode != "pad" && s.square_mode != "center" && s.square_mode != "stretch" {
        s.square_mode = d.square_mode;
    }
    if !matches!(
        s.ratio.as_str(),
        "free" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "custom"
    ) {
        s.ratio = d.ratio;
    }
    s.ico_sizes.retain(|&v| (1..=ICO_MAX).contains(&v));
    s.ico_sizes.sort_unstable_by(|a, b| b.cmp(a));
    s.ico_sizes.dedup();
    s.custom_ratio[0] = s.custom_ratio[0].clamp(1, 100_000);
    s.custom_ratio[1] = s.custom_ratio[1].clamp(1, 100_000);
    s
}

fn settings_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("settings.json")))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageState {
    name: String,
    src_path: Option<String>,
    width: u32,
    height: u32,
    ext: String,
    bytes: u64,
    edited: bool,
    preview_path: String,
    version: u64,
    is_ico: bool,
    undo_depth: usize,
    undo_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveIcoResult {
    path: String,
    requested: Vec<u32>,
    sizes: Vec<u32>,
    skipped: Vec<u32>,
    source_side: u32,
    edited: bool,
    image_version: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPngResult {
    count: usize,
    first: String,
    folder: String,
    files: Vec<String>,
    requested: Vec<u32>,
    sizes: Vec<u32>,
    skipped: Vec<u32>,
    source_side: u32,
    edited: bool,
    image_version: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchResult {
    ok: Vec<String>,
    errors: Vec<BatchError>,
    items: Vec<BatchItemResult>,
    cancelled: bool,
    processed: usize,
    total: usize,
    remaining: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchError {
    path: String,
    message: String,
    stage: String,
}

struct BatchSuccess {
    dest: PathBuf,
    actual: Vec<u32>,
    skipped: Vec<u32>,
    source_side: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchItemResult {
    source: String,
    output: Option<String>,
    requested: Vec<u32>,
    actual: Vec<u32>,
    skipped: Vec<u32>,
    source_side: u32,
    stage: String,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchProgress {
    index: usize,
    total: usize,
    name: String,
}

#[derive(Clone)]
struct HistoryEntry {
    img: Arc<RgbaImage>,
    content_id: u64,
}

struct Inner {
    img: Option<Arc<RgbaImage>>,
    src_path: Option<PathBuf>,
    name: String,
    ext: String,
    is_ico: bool,
    undo: VecDeque<HistoryEntry>,
    content_id: u64,
    saved_content_id: Option<u64>,
    undo_truncated: bool,
    version: u64,
    initial_path: Option<String>,
    square_cache: Option<(u64, String, Arc<RgbaImage>)>,
    batch_cancel: Arc<AtomicBool>,
    batch_active: Arc<AtomicBool>,
}

impl Inner {
    fn new() -> Self {
        Inner {
            img: None,
            src_path: None,
            name: String::new(),
            ext: String::new(),
            is_ico: false,
            undo: VecDeque::new(),
            content_id: 0,
            saved_content_id: None,
            undo_truncated: false,
            version: 0,
            initial_path: initial_arg(),
            square_cache: None,
            batch_cancel: Arc::new(AtomicBool::new(false)),
            batch_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn initial_arg() -> Option<String> {
    std::env::args_os()
        .nth(1)
        .map(|s| s.to_string_lossy().to_string())
        .filter(|p| !p.is_empty() && Path::new(p).is_file())
}

fn lock_inner(shared: &Arc<Mutex<Inner>>) -> MutexGuard<'_, Inner> {
    // 一次 panic 不应让后续所有命令永久失败；恢复内部状态继续服务
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn check_pixel_budget(width: u32, height: u32) -> Result<(), String> {
    if (width as u64) * (height as u64) > MAX_PIXELS {
        return Err("图片像素数超过 1 亿，已拒绝打开".into());
    }
    Ok(())
}

#[derive(Debug)]
struct LoadedSource {
    img: RgbaImage,
    ext: String,
    is_ico: bool,
}

fn open_error(path: &Path, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("文件不存在：{}", path.display()),
        std::io::ErrorKind::PermissionDenied => format!(
            "文件被占用或没有权限读取：{}（系统错误：{error}）",
            path.display()
        ),
        _ => format!("无法打开文件：{}（系统错误：{error}）", path.display()),
    }
}

fn decode_source(path: &Path) -> Result<(DynamicImage, ImageFormat), String> {
    let metadata = fs::metadata(path).map_err(|error| open_error(path, &error))?;
    if !metadata.is_file() {
        return Err(format!("路径不是文件：{}", path.display()));
    }
    let reader = ImageReader::open(path).map_err(|error| open_error(path, &error))?;
    let reader = reader.with_guessed_format().map_err(|error| {
        format!(
            "无法识别图片内容（不是支持的图片或文件损坏）：{}（{error}）",
            path.display()
        )
    })?;
    let format = reader.format().ok_or_else(|| {
        format!(
            "无法识别图片内容（不是支持的图片或文件损坏）：{}",
            path.display()
        )
    })?;
    let mut decoder = reader.into_decoder().map_err(|error| {
        format!(
            "无法解码图片（内容损坏或格式不支持）：{}（{error}）",
            path.display()
        )
    })?;
    let (width, height) = decoder.dimensions();
    // image_dimensions 在部分畸形容器上可能失败；以解码器实际尺寸再校验一次，
    // 避免在分配整张 RGBA 缓冲后才发现超过上限。
    check_pixel_budget(width, height)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|error| {
        format!(
            "图片解码失败（文件可能损坏）：{}（{error}）",
            path.display()
        )
    })?;
    check_pixel_budget(img.width(), img.height())?;
    img.apply_orientation(orientation);
    Ok((img, format))
}

fn load_source(path: &Path) -> Result<LoadedSource, String> {
    // 先嗅探文件内容，不把扩展名当作安全边界；资源预算仍由 decode_source 统一执行。
    let (img, format) = decode_source(path)?;
    let ext = format
        .extensions_str()
        .first()
        .map(|value| (*value).to_string())
        .unwrap_or_default();
    Ok(LoadedSource {
        img: img.into_rgba8(),
        ext,
        is_ico: format == ImageFormat::Ico,
    })
}

struct CropRegion<'a> {
    image: &'a RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl GenericImageView for CropRegion<'_> {
    type Pixel = image::Rgba<u8>;

    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        *self.image.get_pixel(self.x + x, self.y + y)
    }
}

fn smart_resize(img: &RgbaImage, max_w: u32, max_h: u32) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    if scale >= 1.0 {
        return img.clone();
    }
    let tw = ((w as f64 * scale).round() as u32).max(1);
    let th = ((h as f64 * scale).round() as u32).max(1);
    let factor = (w / (tw * 2).max(1)).min(h / (th * 2).max(1));
    let src = if factor > 1 {
        imageops::resize(img, w / factor, h / factor, imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    imageops::resize(&src, tw, th, imageops::FilterType::Triangle)
}

/// 生成用于 ICO 编码的正方形母图（边长不超过 256）。
///
/// 先成方、后缩到 256 是关键：如果先把长边压到 256 再成方，宽图在
/// center 模式下会只剩 64×64，导致 256/128 档位被错误跳过。
fn square_master(img: &RgbaImage, mode: &str) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return RgbaImage::new(1, 1);
    }
    match mode {
        "center" => {
            let side = w.min(h);
            let target = side.min(ICO_MAX);
            let l = (w - side) / 2;
            let t = (h - side) / 2;
            let view = CropRegion {
                image: img,
                x: l,
                y: t,
                width: side,
                height: side,
            };
            imageops::resize(&view, target, target, imageops::FilterType::Lanczos3)
        }
        "stretch" => {
            let side = w.max(h).min(ICO_MAX);
            imageops::resize(img, side, side, imageops::FilterType::Lanczos3)
        }
        _ => {
            let side = w.max(h).min(ICO_MAX);
            let scale = side as f64 / w.max(h) as f64;
            let tw = ((w as f64 * scale).round() as u32).max(1);
            let th = ((h as f64 * scale).round() as u32).max(1);
            let scaled = if tw == w && th == h {
                img.clone()
            } else {
                imageops::resize(img, tw, th, imageops::FilterType::Lanczos3)
            };
            let mut out = RgbaImage::new(side, side);
            let ox = (side - tw) / 2;
            let oy = (side - th) / 2;
            imageops::overlay(&mut out, &scaled, ox as i64, oy as i64);
            out
        }
    }
}

fn normalized_sizes(sizes: &[u32]) -> Vec<u32> {
    let mut v: Vec<u32> = sizes
        .iter()
        .copied()
        .filter(|size| (1..=ICO_MAX).contains(size))
        .collect();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v.dedup();
    v
}

fn skipped_sizes(requested: &[u32], actual: &[u32], side: u32) -> Vec<u32> {
    requested
        .iter()
        .copied()
        .filter(|size| *size > side && !actual.contains(size))
        .collect()
}

fn final_sizes(square: &RgbaImage, sizes: &[u32]) -> Vec<u32> {
    let side = square.width().min(square.height());
    normalized_sizes(sizes)
        .into_iter()
        .filter(|size| *size <= ICO_MAX.min(side))
        .collect()
}

fn encode_png(rgba: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let enc = PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, PngFilter::Adaptive);
    enc.write_image(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
        ExtendedColorType::Rgba8,
    )
    .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(buf)
}

fn encode_ico(square: &RgbaImage, sizes: &[u32]) -> Result<Vec<u8>, String> {
    let mut frames: Vec<(u32, Vec<u8>)> = Vec::new();
    for &s in sizes {
        let frame = imageops::resize(square, s, s, imageops::FilterType::Lanczos3);
        frames.push((s, encode_png(&frame)?));
    }
    let count = frames.len() as u16;
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    let mut offset = 6 + 16 * frames.len() as u32;
    let mut entries = Vec::new();
    let mut data = Vec::new();
    for (s, png) in &frames {
        entries.push(*s as u8);
        entries.push(*s as u8);
        entries.push(0);
        entries.push(0);
        entries.extend_from_slice(&1u16.to_le_bytes());
        entries.extend_from_slice(&32u16.to_le_bytes());
        entries.extend_from_slice(&(png.len() as u32).to_le_bytes());
        entries.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
        data.extend_from_slice(png);
    }
    out.extend_from_slice(&entries);
    out.extend_from_slice(&data);
    Ok(out)
}

fn preview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("previews")
        .join(std::process::id().to_string()))
}

fn atomic_temp_path(path: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    path.with_file_name(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        nonce,
        seq
    ))
}

fn write_temp_file(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建输出目录 {}：{e}", parent.display()))?;
    for _ in 0..32 {
        let tmp = atomic_temp_path(path);
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(mut file) => {
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| {
                        let _ = fs::remove_file(&tmp);
                        format!("无法写入临时文件 {}：{e}", tmp.display())
                    })?;
                return Ok(tmp);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建临时文件 {}：{error}", tmp.display())),
        }
    }
    Err(format!("无法创建唯一临时文件：{}", path.display()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = write_temp_file(path, bytes)?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("无法完成文件写入 {}：{error}", path.display())
    })
}

#[derive(Debug)]
enum WriteNewError {
    Collision,
    Message(String),
}

#[cfg(windows)]
fn commit_new_file(tmp: &Path, dest: &Path) -> Result<(), WriteNewError> {
    let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if ok != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(80) | Some(183) => Err(WriteNewError::Collision),
        _ => Err(WriteNewError::Message(format!(
            "无法提交新文件 {}：{error}",
            dest.display()
        ))),
    }
}

#[cfg(not(windows))]
fn commit_new_file(tmp: &Path, dest: &Path) -> Result<(), WriteNewError> {
    match fs::rename(tmp, dest) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(WriteNewError::Collision)
        }
        Err(error) => Err(WriteNewError::Message(format!(
            "无法提交新文件 {}：{error}",
            dest.display()
        ))),
    }
}

/// 写入一个此前不存在的目标；绝不替换竞争期间出现的文件。
fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<(), WriteNewError> {
    let tmp = write_temp_file(path, bytes).map_err(WriteNewError::Message)?;
    let result = commit_new_file(&tmp, path);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_unique_atomic(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    for n in 1..=10_000 {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let candidate = dir.join(name);
        match write_atomic_new(&candidate, bytes) {
            Ok(()) => return Ok(candidate),
            Err(WriteNewError::Collision) => continue,
            Err(WriteNewError::Message(message)) => return Err(message),
        }
    }
    Err(format!(
        "同名输出过多，无法在 {} 中生成唯一文件名",
        dir.display()
    ))
}

fn write_preview(app: &AppHandle, img: &RgbaImage, version: u64) -> Result<String, String> {
    let dir = preview_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("preview-{version}.png"));
    let preview = smart_resize(img, PREVIEW_MAX, PREVIEW_MAX);
    let bytes = encode_png(&preview)?;
    // 预览先写完再提交状态；清理旧预览延迟到提交成功之后。
    write_atomic(&path, &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

fn cleanup_current_previews(app: &AppHandle, keep: &str) {
    let Ok(dir) = preview_dir(app) else {
        return;
    };
    let keep = Path::new(keep);
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p != keep && p.extension().is_some_and(|e| e == "png") {
                let _ = fs::remove_file(p);
            }
        }
    }
}

/// 清理其他实例遗留超过一天的预览目录，避免 appLocalData 长期膨胀。
fn cleanup_stale_previews(app: &AppHandle) {
    let Ok(root) = app.path().app_local_data_dir().map(|p| p.join("previews")) else {
        return;
    };
    let Ok(rd) = fs::read_dir(&root) else {
        return;
    };
    let current = std::process::id().to_string();
    let now = std::time::SystemTime::now();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == current || !entry.path().is_dir() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age.as_secs() > 24 * 60 * 60);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[derive(Clone)]
struct Snapshot {
    img: Arc<RgbaImage>,
    src_path: Option<PathBuf>,
    name: String,
    ext: String,
    is_ico: bool,
    undo: VecDeque<HistoryEntry>,
    content_id: u64,
    saved_content_id: Option<u64>,
    undo_truncated: bool,
    version: u64,
}

fn next_content_id() -> u64 {
    NEXT_CONTENT_ID.fetch_add(1, Ordering::Relaxed)
}

fn snapshot_is_edited(snapshot: &Snapshot) -> bool {
    snapshot.saved_content_id != Some(snapshot.content_id)
}

fn take_snapshot(inner: &Inner) -> Result<Snapshot, String> {
    Ok(Snapshot {
        img: inner.img.clone().ok_or("尚未打开图片")?,
        src_path: inner.src_path.clone(),
        name: inner.name.clone(),
        ext: inner.ext.clone(),
        is_ico: inner.is_ico,
        undo: inner.undo.clone(),
        content_id: inner.content_id,
        saved_content_id: inner.saved_content_id,
        undo_truncated: inner.undo_truncated,
        version: inner.version,
    })
}

fn image_state_from_snapshot(snapshot: &Snapshot, preview_path: String) -> ImageState {
    let bytes = snapshot
        .src_path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok().map(|m| m.len()))
        .unwrap_or(0);
    ImageState {
        name: snapshot.name.clone(),
        src_path: snapshot
            .src_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        width: snapshot.img.width(),
        height: snapshot.img.height(),
        ext: snapshot.ext.to_uppercase(),
        bytes,
        edited: snapshot_is_edited(snapshot),
        preview_path,
        version: snapshot.version,
        is_ico: snapshot.is_ico,
        undo_depth: snapshot.undo.len(),
        undo_truncated: snapshot.undo_truncated,
    }
}

fn commit_snapshot(
    app: &AppHandle,
    shared: &Arc<Mutex<Inner>>,
    expected_version: u64,
    snapshot: Snapshot,
    preview_path: String,
) -> Result<ImageState, String> {
    let mut inner = lock_inner(shared);
    if inner.version != expected_version {
        drop(inner);
        let _ = fs::remove_file(&preview_path);
        return Err("图片状态已变化，请重试".into());
    }
    inner.img = Some(snapshot.img.clone());
    inner.src_path = snapshot.src_path.clone();
    inner.name = snapshot.name.clone();
    inner.ext = snapshot.ext.clone();
    inner.is_ico = snapshot.is_ico;
    inner.undo = snapshot.undo.clone();
    inner.content_id = snapshot.content_id;
    inner.saved_content_id = snapshot.saved_content_id;
    inner.undo_truncated = snapshot.undo_truncated;
    inner.version = snapshot.version;
    inner.square_cache = None;
    let state = image_state_from_snapshot(&snapshot, preview_path);
    drop(inner);
    cleanup_current_previews(app, &state.preview_path);
    Ok(state)
}

fn unique_live_bytes(undo: &VecDeque<HistoryEntry>, current: &Arc<RgbaImage>) -> usize {
    let mut seen = HashSet::new();
    let mut total = 0usize;
    let current_ptr = Arc::as_ptr(current) as usize;
    seen.insert(current_ptr);
    total += current.as_raw().len();
    for entry in undo {
        let ptr = Arc::as_ptr(&entry.img) as usize;
        if seen.insert(ptr) {
            total += entry.img.as_raw().len();
        }
    }
    total
}

fn trim_undo(
    undo: &mut VecDeque<HistoryEntry>,
    current: &Arc<RgbaImage>,
    limit: usize,
    budget_bytes: usize,
) -> usize {
    let mut removed = 0;
    while undo.len() > limit {
        undo.pop_front();
        removed += 1;
    }
    while !undo.is_empty() && unique_live_bytes(undo, current) > budget_bytes {
        undo.pop_front();
        removed += 1;
    }
    removed
}

fn prepare_edit_with_budget(
    snapshot: &Snapshot,
    image: RgbaImage,
    limit: usize,
    budget_bytes: usize,
) -> Result<Snapshot, String> {
    let candidate = Arc::new(image);
    let mut undo = snapshot.undo.clone();
    undo.push_back(HistoryEntry {
        img: snapshot.img.clone(),
        content_id: snapshot.content_id,
    });
    let removed = trim_undo(&mut undo, &candidate, limit, budget_bytes);
    if undo.is_empty() {
        return Err(
            "当前图片在 256 MiB 撤销预算内无法保留上一步，编辑未执行；可先缩小图片后重试".into(),
        );
    }
    Ok(Snapshot {
        img: candidate,
        src_path: snapshot.src_path.clone(),
        name: snapshot.name.clone(),
        ext: snapshot.ext.clone(),
        is_ico: snapshot.is_ico,
        undo,
        content_id: next_content_id(),
        saved_content_id: snapshot.saved_content_id,
        undo_truncated: snapshot.undo_truncated || removed > 0,
        version: snapshot.version + 1,
    })
}

fn prepare_edit(snapshot: &Snapshot, image: RgbaImage) -> Result<Snapshot, String> {
    prepare_edit_with_budget(snapshot, image, UNDO_LIMIT, UNDO_BUDGET_BYTES)
}

fn apply_undo_model(snapshot: &Snapshot) -> Result<Snapshot, String> {
    let mut undo = snapshot.undo.clone();
    let previous = undo.pop_back().ok_or("没有可撤销的操作")?;
    Ok(Snapshot {
        img: previous.img,
        src_path: snapshot.src_path.clone(),
        name: snapshot.name.clone(),
        ext: snapshot.ext.clone(),
        is_ico: snapshot.is_ico,
        undo,
        content_id: previous.content_id,
        saved_content_id: snapshot.saved_content_id,
        undo_truncated: snapshot.undo_truncated,
        version: snapshot.version + 1,
    })
}

fn square_for_snapshot(
    shared: &Arc<Mutex<Inner>>,
    snapshot: &Snapshot,
    mode: &str,
) -> Arc<RgbaImage> {
    let cached = {
        let inner = lock_inner(shared);
        inner
            .square_cache
            .as_ref()
            .filter(|(version, cached_mode, _)| *version == snapshot.version && cached_mode == mode)
            .map(|(_, _, image)| image.clone())
    };
    if let Some(image) = cached {
        return image;
    }
    let square = Arc::new(square_master(&snapshot.img, mode));
    let mut inner = lock_inner(shared);
    if inner.version == snapshot.version {
        inner.square_cache = Some((snapshot.version, mode.to_string(), square.clone()));
    }
    square
}

fn mark_saved_checkpoint(shared: &Arc<Mutex<Inner>>, snapshot: &Snapshot) -> bool {
    let mut inner = lock_inner(shared);
    if inner.version == snapshot.version {
        inner.saved_content_id = Some(snapshot.content_id);
    }
    inner.saved_content_id != Some(inner.content_id)
}
#[tauri::command]
async fn load_image(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Inner>>>,
    path: String,
) -> Result<ImageState, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let loaded = load_source(&p)?;
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "图片".into());
        let content_id = next_content_id();
        let (base_version, snapshot) = {
            let inner = lock_inner(&shared);
            let base_version = inner.version;
            (
                base_version,
                Snapshot {
                    img: Arc::new(loaded.img),
                    src_path: Some(p),
                    name,
                    ext: loaded.ext,
                    is_ico: loaded.is_ico,
                    undo: VecDeque::new(),
                    content_id,
                    saved_content_id: Some(content_id),
                    undo_truncated: false,
                    version: base_version + 1,
                },
            )
        };
        let preview_path = write_preview(&app, &snapshot.img, snapshot.version)?;
        commit_snapshot(&app, &shared, base_version, snapshot, preview_path)
    })
    .await
    .map_err(|e| format!("加载图片失败：{e}"))?
}

#[tauri::command]
async fn paste_clipboard(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Inner>>>,
) -> Result<ImageState, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut clip = Clipboard::new()
            .map_err(|_| "剪贴板里没有图片（先复制或截图一张图片，再按 Ctrl+V）".to_string())?;
        let data = clip
            .get_image()
            .map_err(|_| "剪贴板里没有图片（先复制或截图一张图片，再按 Ctrl+V）".to_string())?;
        let width = data.width as u32;
        let height = data.height as u32;
        check_pixel_budget(width, height)?;
        let img = RgbaImage::from_raw(width, height, data.bytes.into_owned())
            .ok_or("剪贴板图片数据异常")?;
        let content_id = next_content_id();
        let (base_version, snapshot) = {
            let inner = lock_inner(&shared);
            let base_version = inner.version;
            (
                base_version,
                Snapshot {
                    img: Arc::new(img),
                    src_path: None,
                    name: "剪贴板图片".into(),
                    ext: "png".into(),
                    is_ico: false,
                    undo: VecDeque::new(),
                    content_id,
                    saved_content_id: None,
                    undo_truncated: false,
                    version: base_version + 1,
                },
            )
        };
        let preview_path = write_preview(&app, &snapshot.img, snapshot.version)?;
        commit_snapshot(&app, &shared, base_version, snapshot, preview_path)
    })
    .await
    .map_err(|e| format!("粘贴失败：{e}"))?
}

#[tauri::command]
async fn rotate(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Inner>>>,
    op: String,
) -> Result<ImageState, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let rotated = match op.as_str() {
            "cw" => imageops::rotate90(snapshot.img.as_ref()),
            "ccw" => imageops::rotate270(snapshot.img.as_ref()),
            "flip_h" => imageops::flip_horizontal(snapshot.img.as_ref()),
            "flip_v" => imageops::flip_vertical(snapshot.img.as_ref()),
            _ => return Err(format!("未知的旋转操作：{op}")),
        };
        let candidate = prepare_edit(&snapshot, rotated)?;
        let preview_path = write_preview(&app, &candidate.img, candidate.version)?;
        commit_snapshot(&app, &shared, snapshot.version, candidate, preview_path)
    })
    .await
    .map_err(|e| format!("旋转失败：{e}"))?
}

#[tauri::command]
async fn apply_crop(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Inner>>>,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
) -> Result<ImageState, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let iw = snapshot.img.width() as i64;
        let ih = snapshot.img.height() as i64;
        let x = x.clamp(0, (iw - 1).max(0));
        let y = y.clamp(0, (ih - 1).max(0));
        let w = w.clamp(1, iw - x);
        let h = h.clamp(1, ih - y);
        if w < MIN_CROP_SIZE || h < MIN_CROP_SIZE {
            return Err(format!(
                "选区至少需要 {}×{} 像素，编辑未执行",
                MIN_CROP_SIZE, MIN_CROP_SIZE
            ));
        }
        let cropped = imageops::crop_imm(
            snapshot.img.as_ref(),
            x as u32,
            y as u32,
            w as u32,
            h as u32,
        )
        .to_image();
        let candidate = prepare_edit(&snapshot, cropped)?;
        let preview_path = write_preview(&app, &candidate.img, candidate.version)?;
        commit_snapshot(&app, &shared, snapshot.version, candidate, preview_path)
    })
    .await
    .map_err(|e| format!("裁切失败：{e}"))?
}

#[tauri::command]
async fn undo(app: AppHandle, state: State<'_, Arc<Mutex<Inner>>>) -> Result<ImageState, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let candidate = apply_undo_model(&snapshot)?;
        let preview_path = write_preview(&app, &candidate.img, candidate.version)?;
        commit_snapshot(&app, &shared, snapshot.version, candidate, preview_path)
    })
    .await
    .map_err(|e| format!("撤销失败：{e}"))?
}

#[tauri::command]
async fn copy_image(
    state: State<'_, Arc<Mutex<Inner>>>,
    mode: String,
) -> Result<(u32, u32), String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let square = square_for_snapshot(&shared, &snapshot, &mode);
        let (w, h) = (square.width(), square.height());
        let mut clip = Clipboard::new()
            .map_err(|_| "复制到剪贴板失败（可能被其他程序占用），稍后再试".to_string())?;
        clip.set_image(ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(square.as_raw().clone()),
        })
        .map_err(|_| "复制到剪贴板失败（可能被其他程序占用），稍后再试".to_string())?;
        Ok((w, h))
    })
    .await
    .map_err(|e| format!("复制失败：{e}"))?
}

#[tauri::command]
async fn save_ico(
    state: State<'_, Arc<Mutex<Inner>>>,
    path: String,
    sizes: Vec<u32>,
    mode: String,
) -> Result<SaveIcoResult, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let requested = normalized_sizes(&sizes);
        if requested.is_empty() {
            return Err("没有选择有效的 ICO 尺寸".into());
        }
        let square = square_for_snapshot(&shared, &snapshot, &mode);
        let final_s = final_sizes(&square, &requested);
        if final_s.is_empty() {
            return Err("所选尺寸都大于源图，无法生成图标（请勾选更小尺寸）".into());
        }
        let side = square.width().min(square.height());
        let skipped = skipped_sizes(&requested, &final_s, side);
        let data = encode_ico(&square, &final_s)?;
        let dest = PathBuf::from(&path);
        match write_atomic_new(&dest, &data) {
            Ok(()) => {}
            Err(WriteNewError::Collision) => {
                return Err(format!(
                    "目标文件已存在，为避免多实例覆盖，请另存：{}",
                    dest.display()
                ))
            }
            Err(WriteNewError::Message(message)) => return Err(message),
        }
        let edited = mark_saved_checkpoint(&shared, &snapshot);
        Ok(SaveIcoResult {
            path: dest.to_string_lossy().to_string(),
            requested,
            sizes: final_s,
            skipped,
            source_side: side,
            edited,
            image_version: snapshot.version,
        })
    })
    .await
    .map_err(|e| format!("保存失败：{e}"))?
}

#[tauri::command]
async fn export_pngs(
    state: State<'_, Arc<Mutex<Inner>>>,
    out_dir: String,
    sizes: Vec<u32>,
    mode: String,
) -> Result<ExportPngResult, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let inner = lock_inner(&shared);
            take_snapshot(&inner)?
        };
        let stem = snapshot
            .src_path
            .as_ref()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "图标".into());
        let requested = normalized_sizes(&sizes);
        if requested.is_empty() {
            return Err("没有选择有效的 PNG 尺寸".into());
        }
        let square = square_for_snapshot(&shared, &snapshot, &mode);
        let final_s = final_sizes(&square, &requested);
        if final_s.is_empty() {
            return Err("所选尺寸都大于源图，无法导出 PNG（请勾选更小尺寸）".into());
        }
        let side = square.width().min(square.height());
        let skipped = skipped_sizes(&requested, &final_s, side);
        let dir = PathBuf::from(&out_dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut paths = Vec::new();
        for size in &final_s {
            let frame = imageops::resize(
                square.as_ref(),
                *size,
                *size,
                imageops::FilterType::Lanczos3,
            );
            let bytes = encode_png(&frame)?;
            let dest = write_unique_atomic(&dir, &format!("{stem}_{size}x{size}"), "png", &bytes)?;
            paths.push(dest.to_string_lossy().to_string());
        }
        let first = paths.first().cloned().ok_or("没有可导出的文件")?;
        let edited = mark_saved_checkpoint(&shared, &snapshot);
        Ok(ExportPngResult {
            count: paths.len(),
            first,
            folder: dir.to_string_lossy().to_string(),
            files: paths,
            requested,
            sizes: final_s,
            skipped,
            source_side: side,
            edited,
            image_version: snapshot.version,
        })
    })
    .await
    .map_err(|e| format!("导出失败：{e}"))?
}

#[tauri::command]
async fn batch_convert(
    app: AppHandle,
    state: State<'_, Arc<Mutex<Inner>>>,
    paths: Vec<String>,
    out_dir: String,
    sizes: Vec<u32>,
    mode: String,
) -> Result<BatchResult, String> {
    let shared = state.inner().clone();
    let (cancel, active) = {
        let inner = lock_inner(&shared);
        (inner.batch_cancel.clone(), inner.batch_active.clone())
    };
    // 在进入 spawn_blocking 前登记任务，避免极快点击取消时丢失取消请求。
    active.store(true, Ordering::SeqCst);
    cancel.store(false, Ordering::SeqCst);
    let task_cancel = cancel.clone();
    let task_active = active.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let cancel = task_cancel;
        let active = task_active;
        let run = (|| -> Result<BatchResult, String> {
            let out = PathBuf::from(&out_dir);
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let requested = normalized_sizes(&sizes);
            if requested.is_empty() {
                active.store(false, Ordering::SeqCst);
                return Err("没有选择有效的 ICO 尺寸".into());
            }
            let total = paths.len();
            let mut ok = Vec::new();
            let mut errors = Vec::new();
            let mut items = Vec::new();
            let mut processed = 0usize;
            let mut cancelled = false;
            for (i, p) in paths.iter().enumerate() {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                let path = PathBuf::from(p);
                let _ = app.emit(
                    "batch-progress",
                    BatchProgress {
                        index: i,
                        total,
                        name: path
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default(),
                    },
                );
                let result = (|| -> Result<BatchSuccess, (String, String)> {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(("cancelled".into(), String::new()));
                    }
                    let loaded = load_source(&path).map_err(|message| ("读取".into(), message))?;
                    if cancel.load(Ordering::SeqCst) {
                        return Err(("cancelled".into(), String::new()));
                    }
                    let square = square_master(&loaded.img, &mode);
                    if cancel.load(Ordering::SeqCst) {
                        return Err(("cancelled".into(), String::new()));
                    }
                    let final_s = final_sizes(&square, &requested);
                    if final_s.is_empty() {
                        return Err((
                            "尺寸".into(),
                            "所选尺寸都大于源图，无法生成图标（请勾选更小尺寸）".into(),
                        ));
                    }
                    let data = encode_ico(&square, &final_s)
                        .map_err(|message| ("编码".into(), message))?;
                    if cancel.load(Ordering::SeqCst) {
                        return Err(("cancelled".into(), String::new()));
                    }
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "icon".into());
                    let dest = write_unique_atomic(&out, &stem, "ico", &data)
                        .map_err(|message| ("写入".into(), message))?;
                    let skipped =
                        skipped_sizes(&requested, &final_s, square.width().min(square.height()));
                    Ok(BatchSuccess {
                        dest,
                        actual: final_s,
                        skipped,
                        source_side: square.width().min(square.height()),
                    })
                })();
                match result {
                    Ok(success) => {
                        let output = success.dest.to_string_lossy().to_string();
                        ok.push(output.clone());
                        items.push(BatchItemResult {
                            source: p.clone(),
                            output: Some(output),
                            requested: requested.clone(),
                            actual: success.actual,
                            skipped: success.skipped,
                            source_side: success.source_side,
                            stage: "完成".into(),
                            message: None,
                        });
                        processed = i + 1;
                    }
                    Err((stage, _message)) if stage == "cancelled" => {
                        cancelled = true;
                        break;
                    }
                    Err((stage, message)) => {
                        errors.push(BatchError {
                            path: p.clone(),
                            message: message.clone(),
                            stage: stage.clone(),
                        });
                        items.push(BatchItemResult {
                            source: p.clone(),
                            output: None,
                            requested: requested.clone(),
                            actual: Vec::new(),
                            skipped: Vec::new(),
                            source_side: 0,
                            stage,
                            message: Some(message),
                        });
                        processed = i + 1;
                    }
                }
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
            }
            Ok(BatchResult {
                ok,
                errors,
                items,
                cancelled,
                processed,
                total,
                remaining: total.saturating_sub(processed),
            })
        })();
        active.store(false, Ordering::SeqCst);
        cancel.store(false, Ordering::SeqCst);
        run
    });
    let result = joined.await;
    if result.is_err() {
        active.store(false, Ordering::SeqCst);
        cancel.store(false, Ordering::SeqCst);
    }
    result.map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_batch(state: State<'_, Arc<Mutex<Inner>>>) -> bool {
    let inner = lock_inner(state.inner());
    if !inner.batch_active.load(Ordering::SeqCst) {
        return false;
    }
    inner.batch_cancel.store(true, Ordering::SeqCst);
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsSource {
    Primary,
    Backup,
    Default,
}

fn parse_settings_text(text: &str) -> Option<Settings> {
    serde_json::from_str::<Settings>(text)
        .ok()
        .map(clean_settings)
}

fn read_settings_with_source(path: &Path) -> (Settings, SettingsSource) {
    if let Ok(text) = fs::read_to_string(path) {
        if let Some(settings) = parse_settings_text(&text) {
            return (settings, SettingsSource::Primary);
        }
    }
    let backup = path.with_extension("json.bak");
    if let Ok(text) = fs::read_to_string(backup) {
        if let Some(settings) = parse_settings_text(&text) {
            return (settings, SettingsSource::Backup);
        }
    }
    (Settings::default(), SettingsSource::Default)
}

fn read_settings(path: &Path) -> Settings {
    read_settings_with_source(path).0
}

fn write_settings_atomic(path: &Path, text: &str) -> Result<(), String> {
    // 只有解析成功的旧主文件才允许成为备份；损坏主文件绝不能覆盖唯一有效备份。
    if let Ok(previous) = fs::read(path) {
        if let Ok(previous_text) = String::from_utf8(previous) {
            if let Some(previous_settings) = parse_settings_text(&previous_text) {
                let normalized = serde_json::to_vec_pretty(&previous_settings)
                    .map_err(|error| format!("无法规范化设置备份：{error}"))?;
                let backup = path.with_extension("json.bak");
                write_atomic(&backup, &normalized)?;
            }
        }
    }
    write_atomic(path, text.as_bytes())
}

#[tauri::command]
fn load_settings() -> Settings {
    let _guard = SETTINGS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    read_settings(&settings_path())
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let clean = clean_settings(settings);
    let text = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?;
    write_settings_atomic(&settings_path(), &text)
}

#[tauri::command]
fn take_initial_path(state: State<'_, Arc<Mutex<Inner>>>) -> Option<String> {
    lock_inner(state.inner()).initial_path.take()
}

fn run_self_test() -> Result<(), String> {
    let started = std::time::Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let at = args
        .iter()
        .position(|a| a == "--self-test")
        .ok_or("缺少 --self-test")?;
    let input = PathBuf::from(args.get(at + 1).ok_or("缺少输入图片")?);
    let out_dir = PathBuf::from(args.get(at + 2).ok_or("缺少输出目录")?);
    fs::create_dir_all(&out_dir).map_err(|e| format!("无法创建输出目录：{e}"))?;

    let loaded = load_source(&input)?;
    let square = square_master(&loaded.img, "pad");
    let sizes = final_sizes(&square, &[256, 128, 64, 48, 32, 24, 16]);
    if sizes.is_empty() {
        return Err("测试图片太小，无法生成任何 ICO 档位".into());
    }
    let ico = encode_ico(&square, &sizes)?;
    let ico_path = out_dir.join("self-test.ico");
    fs::write(&ico_path, &ico).map_err(|e| e.to_string())?;

    let decoded = image::load_from_memory_with_format(&ico, image::ImageFormat::Ico)
        .map_err(|e| format!("生成的 ICO 无法读回：{e}"))?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err("生成的 ICO 尺寸为 0".into());
    }

    for size in &sizes {
        let frame = imageops::resize(&square, *size, *size, imageops::FilterType::Lanczos3);
        let path = out_dir.join(format!("self-test-{}x{}.png", size, size));
        frame.save(&path).map_err(|e| e.to_string())?;
    }

    println!(
        "IcoCreator self-test PASS: {} sizes, ICO {} bytes, elapsed {} ms",
        sizes.len(),
        ico.len(),
        started.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(windows)]
struct SingleInstanceGuard(HANDLE);

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> Result<Option<SingleInstanceGuard>, String> {
    acquire_single_instance_named(SINGLE_INSTANCE_NAME)
}

#[cfg(windows)]
fn acquire_single_instance_named(name: &str) -> Result<Option<SingleInstanceGuard>, String> {
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "无法创建单实例锁（系统错误：{}）",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(handle);
        }
        return Ok(None);
    }
    Ok(Some(SingleInstanceGuard(handle)))
}

#[cfg(windows)]
fn show_already_running_notice() {
    let text: Vec<u16> = "IcoCreator 已在运行。请切换到现有窗口；若看不到窗口，请先结束旧进程。"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let caption: Vec<u16> = "IcoCreator".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

#[cfg(not(windows))]
struct SingleInstanceGuard;

#[cfg(not(windows))]
fn acquire_single_instance() -> Result<Option<SingleInstanceGuard>, String> {
    Ok(Some(SingleInstanceGuard))
}

fn main() {
    if std::env::args().any(|a| a == "--self-test") {
        match run_self_test() {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("IcoCreator self-test FAIL: {error}");
                std::process::exit(1);
            }
        }
    }

    let _instance = match acquire_single_instance() {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            #[cfg(windows)]
            show_already_running_notice();
            return;
        }
        Err(error) => {
            eprintln!("IcoCreator startup failed: {error}");
            return;
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            cleanup_stale_previews(app.handle());
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let area = monitor.work_area();
                    let scale = monitor.scale_factor().max(0.5);
                    let avail_w = (area.size.width as f64 / scale).floor() as u32;
                    let avail_h = (area.size.height as f64 / scale).floor() as u32;
                    let w = 1280u32.min(avail_w.saturating_sub(16)).max(900);
                    let h = 800u32.min(avail_h.saturating_sub(16)).max(600);
                    let _ = win.set_size(tauri::LogicalSize::new(w as f64, h as f64));
                    let _ = win.center();
                }
            }
            Ok(())
        })
        .manage(Arc::new(Mutex::new(Inner::new())))
        .invoke_handler(tauri::generate_handler![
            load_image,
            paste_clipboard,
            rotate,
            apply_crop,
            undo,
            copy_image,
            save_ico,
            export_pngs,
            batch_convert,
            cancel_batch,
            load_settings,
            save_settings,
            take_initial_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageFormat;
    use std::sync::Barrier;
    use std::thread;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn basic_snapshot(saved: bool) -> Snapshot {
        let content_id = next_content_id();
        Snapshot {
            img: Arc::new(RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 60, 255]))),
            src_path: None,
            name: "test.png".into(),
            ext: "png".into(),
            is_ico: false,
            undo: VecDeque::new(),
            content_id,
            saved_content_id: saved.then_some(content_id),
            undo_truncated: false,
            version: 1,
        }
    }

    #[test]
    fn ico_contains_every_requested_frame() {
        let src = RgbaImage::from_fn(300, 180, |x, y| {
            if x < 20 || y < 20 {
                image::Rgba([0, 0, 0, 0])
            } else {
                image::Rgba([(x % 256) as u8, (y % 256) as u8, 120, 255])
            }
        });
        let square = square_master(&src, "pad");
        assert_eq!((square.width(), square.height()), (256, 256));
        let sizes = [256u32, 128, 64, 48, 32, 16];
        let data = encode_ico(&square, &sizes).expect("encode ico");
        assert_eq!(&data[0..4], &[0, 0, 1, 0]);
        let count = u16::from_le_bytes([data[4], data[5]]) as usize;
        assert_eq!(count, sizes.len());
        for (i, size) in sizes.iter().enumerate() {
            let at = 6 + i * 16;
            assert_eq!(data[at] as u32, *size % 256);
            assert_eq!(data[at + 1] as u32, *size % 256);
            assert_eq!(u16::from_le_bytes([data[at + 4], data[at + 5]]), 1);
            assert_eq!(u16::from_le_bytes([data[at + 6], data[at + 7]]), 32);
            let len = u32::from_le_bytes([data[at + 8], data[at + 9], data[at + 10], data[at + 11]])
                as usize;
            let off =
                u32::from_le_bytes([data[at + 12], data[at + 13], data[at + 14], data[at + 15]])
                    as usize;
            assert!(off + len <= data.len());
            assert_eq!(&data[off..off + 8], b"\x89PNG\r\n\x1a\n");
        }
        let decoded =
            image::load_from_memory_with_format(&data, ImageFormat::Ico).expect("decode ico");
        assert_eq!(decoded.width().max(decoded.height()), 256);
    }

    #[test]
    fn square_modes_match_expected_shape() {
        let src = RgbaImage::from_pixel(200, 100, image::Rgba([255, 0, 0, 255]));
        assert_eq!(square_master(&src, "center").dimensions(), (100, 100));
        assert_eq!(square_master(&src, "stretch").dimensions(), (200, 200));
        let pad = square_master(&src, "pad");
        assert_eq!(pad.dimensions(), (200, 200));
        assert_eq!(pad.get_pixel(0, 0)[3], 0);
    }

    #[test]
    fn center_mode_keeps_256_available_for_wide_images() {
        let src = RgbaImage::from_pixel(1200, 300, image::Rgba([0, 128, 255, 255]));
        let square = square_master(&src, "center");
        assert_eq!(square.dimensions(), (256, 256));
        let sizes = final_sizes(&square, &[256, 128, 64, 48, 32, 16]);
        assert_eq!(sizes, vec![256, 128, 64, 48, 32, 16]);
        assert_eq!(square.get_pixel(128, 128)[0], 0);
    }

    #[test]
    fn undo_budget_counts_current_and_history_buffers() {
        let current = Arc::new(RgbaImage::new(512, 512));
        let mut undo: VecDeque<HistoryEntry> = VecDeque::new();
        for _ in 0..6 {
            undo.push_back(HistoryEntry {
                img: Arc::new(RgbaImage::new(512, 512)),
                content_id: next_content_id(),
            });
        }
        // 当前 1 MiB + 历史 3 MiB = 4 MiB，超出预算的旧项被淘汰。
        trim_undo(&mut undo, &current, 10, 4 * 1024 * 1024);
        assert_eq!(undo.len(), 3);
    }

    #[test]
    fn edit_rejects_when_no_undo_snapshot_fits_budget() {
        let snapshot = basic_snapshot(true);
        let original = snapshot.img.clone();
        let result = prepare_edit_with_budget(&snapshot, RgbaImage::new(8, 8), 10, 1);
        assert!(result.is_err());
        assert!(Arc::ptr_eq(&original, &snapshot.img));
        assert!(snapshot.undo.is_empty());
    }

    #[test]
    fn dirty_state_survives_history_truncation_and_undo_to_saved_checkpoint() {
        let mut snapshot = basic_snapshot(true);
        for _ in 0..11 {
            snapshot =
                prepare_edit_with_budget(&snapshot, RgbaImage::new(8, 8), 10, usize::MAX).unwrap();
        }
        assert!(snapshot_is_edited(&snapshot));
        assert_eq!(snapshot.undo.len(), 10);
        for _ in 0..10 {
            snapshot = apply_undo_model(&snapshot).unwrap();
        }
        assert!(snapshot_is_edited(&snapshot));
        let saved_id = snapshot.content_id;
        snapshot.saved_content_id = Some(saved_id);
        assert!(!snapshot_is_edited(&snapshot));
        let edited =
            prepare_edit_with_budget(&snapshot, RgbaImage::new(8, 8), 10, usize::MAX).unwrap();
        let undone = apply_undo_model(&edited).unwrap();
        assert_eq!(undone.content_id, saved_id);
        assert!(!snapshot_is_edited(&undone));
    }

    #[test]
    fn settings_atomic_write_replaces_whole_file_and_keeps_valid_backup() {
        let dir = temp_dir("ico-settings");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"icoSizes":[16]}"#).unwrap();
        write_settings_atomic(&path, r#"{"icoSizes":[32]}"#).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"icoSizes":[32]}"#);
        let backup = path.with_extension("json.bak");
        let backup_settings = parse_settings_text(&fs::read_to_string(&backup).unwrap()).unwrap();
        assert_eq!(backup_settings.ico_sizes, vec![16]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_primary_never_overwrites_valid_backup_during_recovery() {
        let dir = temp_dir("ico-settings-recovery");
        let path = dir.join("settings.json");
        let backup = path.with_extension("json.bak");
        fs::write(&path, "{broken").unwrap();
        fs::write(
            &backup,
            r#"{"icoSizes":[32],"squareMode":"center","ratio":"custom","customRatio":[4,3],"guides":false}"#,
        )
        .unwrap();
        let (recovered, source) = read_settings_with_source(&path);
        assert_eq!(source, SettingsSource::Backup);
        assert_eq!(recovered.ico_sizes, vec![32]);
        write_settings_atomic(&path, r#"{"icoSizes":[16]}"#).unwrap();
        let backup_after = parse_settings_text(&fs::read_to_string(&backup).unwrap()).unwrap();
        assert_eq!(backup_after.ico_sizes, vec![32]);
        fs::write(&path, "{broken-again").unwrap();
        let (again, source) = read_settings_with_source(&path);
        assert_eq!(source, SettingsSource::Backup);
        assert_eq!(again.ico_sizes, vec![32]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_missing_fields_use_defaults() {
        let dir = temp_dir("ico-settings-default");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"icoSizes":[16]}"#).unwrap();
        let settings = read_settings(&path);
        assert_eq!(settings.ico_sizes, vec![16]);
        assert_eq!(settings.square_mode, "pad");
        assert!(settings.guides);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_cleaning_preserves_user_choices_and_rejects_bad_values() {
        let kept = clean_settings(Settings {
            ico_sizes: vec![],
            square_mode: "center".into(),
            ratio: "16:9".into(),
            custom_ratio: [100_001, 0],
            ..Default::default()
        });
        assert!(kept.ico_sizes.is_empty());
        assert_eq!(kept.square_mode, "center");
        assert_eq!(kept.ratio, "16:9");
        assert_eq!(kept.custom_ratio, [100_000, 1]);
        let bad = clean_settings(Settings {
            square_mode: "bogus".into(),
            ratio: "bogus".into(),
            ico_sizes: vec![0, 16, 16, 9999, 256],
            ..Default::default()
        });
        assert_eq!(bad.square_mode, "pad");
        assert_eq!(bad.ratio, "free");
        assert_eq!(bad.ico_sizes, vec![256, 16]);
    }

    #[test]
    fn unique_outputs_do_not_replace_existing_files() {
        let dir = temp_dir("ico-unique");
        let first = write_unique_atomic(&dir, "photo", "png", b"first").unwrap();
        let second = write_unique_atomic(&dir, "photo", "png", b"second").unwrap();
        assert_eq!(first.file_name().unwrap(), "photo.png");
        assert_eq!(second.file_name().unwrap(), "photo-2.png");
        assert_eq!(fs::read(&first).unwrap(), b"first");
        assert_eq!(fs::read(&second).unwrap(), b"second");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_unique_writes_keep_all_products() {
        let dir = temp_dir("ico-race");
        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();
        for index in 0..8u8 {
            let dir = dir.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                write_unique_atomic(&dir, "same", "ico", &[index; 16]).unwrap()
            }));
        }
        let paths: Vec<PathBuf> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(paths.len(), 8);
        let unique: HashSet<PathBuf> = paths.iter().cloned().collect();
        assert_eq!(unique.len(), 8);
        for path in paths {
            assert!(path.exists());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exact_new_output_never_replaces_competitor() {
        let dir = temp_dir("ico-exact");
        let path = dir.join("out.ico");
        write_atomic_new(&path, b"first").unwrap();
        assert!(matches!(
            write_atomic_new(&path, b"second"),
            Err(WriteNewError::Collision)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"first");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_replace_keeps_old_file_until_commit_and_leaves_no_temp() {
        let dir = temp_dir("ico-atomic");
        let path = dir.join("out.ico");
        fs::write(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn content_sniffing_accepts_renamed_extensionless_and_jfif_files() {
        let dir = temp_dir("ico-sniff");
        let source = RgbaImage::from_pixel(4, 4, image::Rgba([12, 34, 56, 255]));
        let renamed = dir.join("renamed.txt");
        let extensionless = dir.join("extensionless");
        let jfif = dir.join("sample.jfif");
        let tiff = dir.join("sample.tiff");
        DynamicImage::ImageRgba8(source.clone())
            .save_with_format(&renamed, ImageFormat::Png)
            .unwrap();
        DynamicImage::ImageRgba8(source.clone())
            .save_with_format(&extensionless, ImageFormat::Png)
            .unwrap();
        DynamicImage::ImageRgba8(source.clone())
            .save_with_format(&jfif, ImageFormat::Jpeg)
            .unwrap();
        DynamicImage::ImageRgba8(source)
            .save_with_format(&tiff, ImageFormat::Tiff)
            .unwrap();
        assert_eq!(load_source(&renamed).unwrap().ext, "png");
        assert_eq!(load_source(&extensionless).unwrap().ext, "png");
        assert!(matches!(
            load_source(&jfif).unwrap().ext.as_str(),
            "jpg" | "jpeg"
        ));
        assert!(matches!(
            load_source(&tiff).unwrap().ext.as_str(),
            "tif" | "tiff"
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_and_missing_files_report_distinct_stages() {
        let dir = temp_dir("ico-errors");
        let corrupt = dir.join("bad.png");
        fs::write(&corrupt, b"not an image").unwrap();
        let corrupt_error = load_source(&corrupt).unwrap_err();
        assert!(corrupt_error.contains("识别") || corrupt_error.contains("解码"));
        assert!(!corrupt_error.contains("不存在"));
        let missing_error = load_source(&dir.join("missing.png")).unwrap_err();
        assert!(missing_error.contains("不存在"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn locked_file_reports_open_or_permission_error() {
        use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
        };
        let dir = temp_dir("ico-locked");
        let path = dir.join("locked.png");
        let source = RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]));
        DynamicImage::ImageRgba8(source)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(handle, std::ptr::null_mut());
        let error = load_source(&path).unwrap_err();
        assert!(error.contains("占用") || error.contains("打开") || error.contains("权限"));
        unsafe {
            CloseHandle(handle);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn single_instance_mutex_is_process_wide() {
        let name = format!("Local\\IcoCreator-test-{}", std::process::id());
        let first = acquire_single_instance_named(&name)
            .unwrap()
            .expect("first mutex");
        assert!(acquire_single_instance_named(&name).unwrap().is_none());
        drop(first);
    }

    #[test]
    fn icon_sizes_skip_sources_smaller_than_request() {
        let square = RgbaImage::from_pixel(100, 100, image::Rgba([0, 0, 0, 255]));
        assert_eq!(
            final_sizes(&square, &[256, 128, 64, 48, 32, 16]),
            vec![64, 48, 32, 16]
        );
        assert_eq!(final_sizes(&square, &[256, 128]), Vec::<u32>::new());
        assert_eq!(skipped_sizes(&[256, 128, 16], &[16], 100), vec![256, 128]);
    }

    #[test]
    fn pixel_budget_rejects_over_limit() {
        assert!(check_pixel_budget(10_000, 10_000).is_ok());
        assert!(check_pixel_budget(10_001, 10_000).is_err());
    }

    #[test]
    #[ignore = "需要真实机器性能门禁，手动通过 qa/test-perf.cmd 运行"]
    fn full_pipeline_for_20mp_photo_stays_interactive() {
        let started = std::time::Instant::now();
        let source = RgbaImage::from_pixel(4000, 5000, image::Rgba([32, 144, 220, 255]));
        let square = square_master(&source, "pad");
        let sizes = final_sizes(&square, &[256, 128, 64, 48, 32, 24, 16]);
        let data = encode_ico(&square, &sizes).expect("encode benchmark ico");
        let elapsed = started.elapsed();
        println!(
            "IcoCreator: 4000x5000 square + 7-size ICO = {} ms, {} bytes",
            elapsed.as_millis(),
            data.len()
        );
        assert_eq!(sizes, vec![256, 128, 64, 48, 32, 24, 16]);
        assert!(elapsed.as_millis() < 2500);
    }
}
