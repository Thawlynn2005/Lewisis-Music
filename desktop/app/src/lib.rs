//! Lewisis' Music as a desktop app (Tauri 2).
//!
//! * The window shows the same interface as the web version (`static/`).
//! * `desktop.js` routes the interface's `/api/...` calls to the commands
//!   below, which answer them with `lewisis-core` (see `backend.rs`).
//! * Sound comes from `lewisis-engine` through CPAL (see `player.rs`), not
//!   from the web view.
//! * Covers are served by a read-only `media:` protocol.
//!
//! Everything is stored in the operating system's app-data folder (or in
//! `LEWISIS_MUSIC_DATA`, if set), in the same layout as the web version's
//! `data/` folder.

mod backend;
mod player;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use backend::{ApiError, Backend};
use lewisis_engine::ReverbKind;
use player::Player;
use serde::Deserialize;
use serde_json::Value;
use tauri::http::{Response as HttpResponse, StatusCode, header};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

struct App {
    backend: Arc<Backend>,
    player: Player,
}

/// Run blocking work off the interface thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, ApiError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::new(500, format!("The task failed: {e}")))
}

// ---- the web version's API ---------------------------------------------------

/// Any JSON request the interface makes (`GET /api/tracks`, `PUT
/// /api/playlists/<id>`, …).
#[tauri::command]
async fn api(method: String, path: String, body: Option<Value>, app: State<'_, App>) -> Result<Value, ApiError> {
    let backend = app.backend.clone();
    blocking(move || backend.route(&method.to_uppercase(), &path, body)).await?
}

fn header_text(request: &Request<'_>, name: &str) -> String {
    let raw = request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    percent_decode(raw)
}

/// A request that carries a file (the interface's `FormData` uploads): a song
/// to add, a cover picture, or a picture to convert for preview. The file is
/// the raw body; `x-path` says where it was going and `x-name` its name.
#[tauri::command]
async fn api_upload(request: Request<'_>, app: State<'_, App>) -> Result<Response, ApiError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ApiError::new(400, "No file was sent."));
    };
    let bytes = bytes.clone();
    let path = header_text(&request, "x-path");
    let name = header_text(&request, "x-name");
    let backend = app.backend.clone();
    blocking(move || {
        let route = path.split('?').next().unwrap_or("").trim_end_matches('/');
        if route == "/api/images/convert" {
            if bytes.len() > lewisis_core::pictures::MAX_BYTES {
                return Err(ApiError::new(400, "That picture is too large (the limit is 40 MB)."));
            }
            let picture = lewisis_core::pictures::normalise(&bytes)?;
            return Ok(Response::new(picture.bytes));
        }
        let json = if route == "/api/tracks" {
            backend.add_bytes(&name, &bytes, path.contains("skipDuplicates=1"))?
        } else {
            backend.set_cover(route, &bytes)?
        };
        Ok(Response::new(json.to_string()))
    })
    .await?
}

/// Add songs chosen in the native file picker (copied, never moved).
#[tauri::command]
async fn import_files(paths: Vec<PathBuf>, skip_duplicates: bool, app: State<'_, App>) -> Result<Value, ApiError> {
    let backend = app.backend.clone();
    blocking(move || {
        let files: Vec<(PathBuf, String)> = paths
            .into_iter()
            .map(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                (p, name)
            })
            .collect();
        backend.add_paths(&files, skip_duplicates)
    })
    .await?
}

/// Settings → Migrate: copy in every song under a folder. Progress arrives as
/// `migrate-progress` events.
#[tauri::command]
async fn migrate_folder(folder: PathBuf, app: State<'_, App>, handle: AppHandle) -> Result<Value, ApiError> {
    let backend = app.backend.clone();
    blocking(move || {
        backend.migrate(&folder, |done, total, name| {
            let _ = handle.emit("migrate-progress", serde_json::json!({"done": done, "total": total, "name": name}));
            true
        })
    })
    .await?
}

/// Whether the separation model is installed, and where.
#[tauri::command]
fn separation_model(app: State<'_, App>) -> Option<PathBuf> {
    app.backend.model()
}

/// Copy a separation model file (made with `tools/export_demucs_onnx.py`)
/// into the app's data folder, after checking that it loads.
#[tauri::command]
async fn install_model(path: PathBuf, app: State<'_, App>) -> Result<PathBuf, ApiError> {
    let backend = app.backend.clone();
    blocking(move || {
        lewisis_core::separate::Separator::load(&path).map_err(|e| ApiError::new(400, format!("That isn't a model Lewisis' Music can use: {e}")))?;
        let target = backend.model_install_path();
        if let Some(folder) = target.parent() {
            std::fs::create_dir_all(folder).map_err(|e| ApiError::new(500, e.to_string()))?;
        }
        let part = target.with_extension("onnx.part");
        std::fs::copy(&path, &part).map_err(|e| ApiError::new(500, format!("Could not copy the model: {e}")))?;
        std::fs::rename(&part, &target).map_err(|e| ApiError::new(500, e.to_string()))?;
        log::info!("Installed the separation model at {}", target.display());
        backend.prepare_in_background(None);
        Ok(target)
    })
    .await?
}

/// Where the app keeps its data and logs (shown in the log for support).
#[tauri::command]
fn app_info(app: State<'_, App>, handle: AppHandle) -> Value {
    serde_json::json!({
        "version": handle.package_info().version.to_string(),
        "data": app.backend.store.root(),
        "logs": handle.path().app_log_dir().ok(),
        "model": app.backend.model(),
    })
}

// ---- playback ----------------------------------------------------------------

#[tauri::command]
async fn player_load(track_id: String, stem: String, start: f64, app: State<'_, App>) -> Result<Value, ApiError> {
    let (backend, player) = (app.backend.clone(), app.player.clone());
    blocking(move || {
        let files = backend.audio_files(&track_id, &stem)?;
        let duration = player.load(files, start).map_err(|e| ApiError::new(500, e))?;
        let duration = duration.or_else(|| backend.store.track(&track_id).ok().map(|t| t.duration));
        Ok(serde_json::json!({"duration": duration}))
    })
    .await?
}

#[tauri::command]
fn player_unload(app: State<'_, App>) {
    app.player.unload();
}

#[tauri::command]
fn player_play(app: State<'_, App>) -> Result<(), ApiError> {
    app.player.play().map_err(|e| ApiError::new(503, e))
}

#[tauri::command]
fn player_pause(app: State<'_, App>) {
    app.player.pause();
}

#[tauri::command]
fn player_seek(seconds: f64, app: State<'_, App>) {
    app.player.seek(seconds);
}

#[tauri::command]
fn player_volume(gain: f32, app: State<'_, App>) {
    app.player.set_volume(gain);
}

#[tauri::command]
fn player_layers(vocals: f32, music: f32, app: State<'_, App>) {
    app.player.set_layer_gains(vocals, music);
}

#[tauri::command]
fn player_speed(speed: f32, keep_pitch: bool, app: State<'_, App>) {
    app.player.set_speed(speed, keep_pitch);
}

#[tauri::command]
fn player_reverb(kind: ReverbKind, amount: f32, app: State<'_, App>) {
    app.player.set_reverb(kind, amount);
}

#[derive(Deserialize)]
struct LoopRegion {
    start: f64,
    end: Option<f64>,
}

#[tauri::command]
fn player_loop(region: Option<LoopRegion>, app: State<'_, App>) {
    app.player.set_loop(region.map(|r| (r.start, r.end)));
}

#[tauri::command]
fn player_status(app: State<'_, App>) -> player::Status {
    app.player.status()
}

/// Tells the interface how playback is going: `player-status` four times a
/// second while playing (like a browser's `timeupdate`), and straight away
/// when a song ends or fails.
fn report_playback(handle: AppHandle, player: Player) {
    std::thread::Builder::new()
        .name("playback events".into())
        .spawn(move || {
            let mut ticks = 0u32;
            let mut was_playing = false;
            loop {
                std::thread::sleep(Duration::from_millis(50));
                ticks += 1;
                let status = player.status();
                let changed = status.playing != was_playing;
                was_playing = status.playing;
                if status.ended || status.error.is_some() || changed || (status.playing && ticks.is_multiple_of(5)) {
                    let _ = handle.emit("player-status", &status);
                }
            }
        })
        .expect("could not start the playback events thread");
}

// ---- covers ------------------------------------------------------------------

/// `media://localhost/track/<id>` and `media://localhost/playlist/<id>`
/// (`http://media.localhost/…` on Windows): cover pictures, read-only, from
/// the covers folder only.
fn serve_media(backend: &Backend, uri: &tauri::http::Uri) -> HttpResponse<Vec<u8>> {
    let parts: Vec<String> = uri.path().trim_matches('/').split('/').map(percent_decode).collect();
    let file = match parts.as_slice() {
        [kind, id] if !id.contains(['/', '\\', '.']) => backend.cover_file(kind, id),
        _ => None,
    };
    let Some(file) = file else {
        return HttpResponse::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "png" => "image/png",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            HttpResponse::builder()
                .header(header::CONTENT_TYPE, mime)
                // The interface adds ?v=<version> whenever a picture changes.
                .header(header::CACHE_CONTROL, "max-age=86400")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(bytes)
                .unwrap()
        }
        Err(_) => HttpResponse::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- start-up ----------------------------------------------------------------

fn data_folder(handle: &AppHandle) -> Result<PathBuf, String> {
    if let Some(folder) = std::env::var_os("LEWISIS_MUSIC_DATA") {
        return Ok(PathBuf::from(folder));
    }
    handle.path().app_data_dir().map_err(|e| format!("Could not find the app-data folder: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("symphonia_core", log::LevelFilter::Warn)
        .level_for("symphonia_bundle_mp3", log::LevelFilter::Error)
        .level_for("lofty", log::LevelFilter::Error)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("lewisis-music".into()) }),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ])
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
        .build();

    tauri::Builder::default()
        .plugin(log)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let data = data_folder(&handle)?;
            let resources = handle.path().resource_dir().ok();
            log::info!("Lewisis' Music {} starting; data in {}", handle.package_info().version, data.display());
            let backend = Backend::open(&data, resources.as_deref())
                .map_err(|e| format!("Could not open the music library in {}: {e}", data.display()))?;
            match backend.model() {
                Some(model) => log::info!("Separation model: {}", model.display()),
                None => log::info!("No separation model installed; Separate Audio will ask for one."),
            }
            let prepare = backend.clone();
            std::thread::spawn(move || prepare.prepare_in_background(None));
            let player = Player::start();
            report_playback(handle.clone(), player.clone());
            app.manage(App { backend, player });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Development only: LEWISIS_MUSIC_SELFTEST=<script.js> runs a test
            // script in the window once the page has loaded.
            #[cfg(debug_assertions)]
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && let Some(script) = std::env::var_os("LEWISIS_MUSIC_SELFTEST")
                && let Ok(code) = std::fs::read_to_string(script)
            {
                let _ = webview.eval(code);
            }
            #[cfg(not(debug_assertions))]
            let _ = (webview, payload);
        })
        .register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
            let backend = context.app_handle().state::<App>().backend.clone();
            let uri = request.uri().clone();
            std::thread::spawn(move || responder.respond(serve_media(&backend, &uri)));
        })
        .invoke_handler(tauri::generate_handler![
            api,
            api_upload,
            import_files,
            migrate_folder,
            separation_model,
            install_model,
            app_info,
            player_load,
            player_unload,
            player_play,
            player_pause,
            player_seek,
            player_volume,
            player_layers,
            player_speed,
            player_reverb,
            player_loop,
            player_status,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            log::error!("Lewisis' Music could not start: {error}");
            eprintln!("Lewisis' Music could not start: {error}");
            std::process::exit(1);
        });
}
