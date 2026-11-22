//! The desktop app's replacement for the Flask server: the same routes, the
//! same JSON and the same error messages, answered by `lewisis-core` instead
//! of Python. The interface's `api()` calls arrive here through Tauri
//! commands (see `desktop.js`), so `app.js` works unchanged.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lewisis_core::lyrics::{self, LyricsStore};
use lewisis_core::queue::Queue;
use lewisis_core::separate::{self, Separator};
use lewisis_core::store::{Added, PlaylistEdit, TrackEdit};
use lewisis_core::{Error as CoreError, Store, Track, migrate, pictures};
use serde::Serialize;
use serde_json::{Value, json};

/// An answer the interface shows as an error, with the HTTP status the
/// Flask version would have sent.
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub status: u16,
    pub error: String,
    /// Extra fields some errors carry (e.g. the separation state).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, error: message.into(), extra: Default::default() }
    }
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        let status = match error {
            CoreError::NotFound(_) => 404,
            CoreError::Invalid(_) => 400,
            CoreError::Io(_) | CoreError::Json(_) => 500,
        };
        if status == 500 {
            log::error!("{error}");
        }
        ApiError::new(status, error.to_string())
    }
}

pub type ApiResult = Result<Value, ApiError>;

/// Where the separation model can be found, in order of preference.
pub fn model_candidates(data_dir: &Path, resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("LEWISIS_MUSIC_MODEL") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(data_dir.join("models").join(MODEL_FILE));
    candidates.extend(bundled(resource_dir, MODEL_FILE));
    candidates
}

/// Where the ONNX Runtime library that runs the model can be found: shipped
/// in the app's resources (see `tools/fetch_onnxruntime.py`), or named by
/// `LEWISIS_MUSIC_ORT` / `ORT_DYLIB_PATH`.
pub fn runtime_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> =
        ["LEWISIS_MUSIC_ORT", "ORT_DYLIB_PATH"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
    candidates.extend(bundled(resource_dir, separate::RUNTIME_LIBRARY));
    if let Some(folder) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        candidates.push(folder.join(separate::RUNTIME_LIBRARY));
    }
    candidates
}

/// A file shipped in the app's `resources/` folder (and, when developing,
/// the same folder in the source tree).
fn bundled(resource_dir: Option<&Path>, name: &str) -> Vec<PathBuf> {
    let mut places = Vec::new();
    if let Some(resources) = resource_dir {
        places.push(resources.join("resources").join(name));
        places.push(resources.join(name));
    }
    if cfg!(debug_assertions) {
        places.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(name));
    }
    places
}

pub const MODEL_FILE: &str = "htdemucs.onnx";

pub struct Backend {
    pub store: Store,
    pub lyrics: LyricsStore,
    pub queue: Queue,
    model_candidates: Vec<PathBuf>,
    runtime_candidates: Vec<PathBuf>,
}

impl Backend {
    pub fn open(data_dir: &Path, resource_dir: Option<&Path>) -> Result<Arc<Self>, CoreError> {
        Self::open_with(data_dir, model_candidates(data_dir, resource_dir), runtime_candidates(resource_dir))
    }

    /// Like [`open`](Self::open), with the places to look for the model and
    /// for ONNX Runtime given explicitly.
    pub fn open_with(data_dir: &Path, candidates: Vec<PathBuf>, runtimes: Vec<PathBuf>) -> Result<Arc<Self>, CoreError> {
        let store = Store::open(data_dir)?;
        let lyrics = LyricsStore::new(store.lyrics_dir())?;

        // The model is loaded the first time a song is separated, then kept.
        let loaded: Arc<Mutex<Option<Separator>>> = Arc::default();
        let (finder, runtime_finder) = (candidates.clone(), runtimes.clone());
        let runner: Arc<lewisis_core::queue::Runner> = Arc::new(move |song, out_dir, stage, progress| {
            let mut slot = loaded.lock().unwrap_or_else(|p| p.into_inner());
            if slot.is_none() {
                let model = find_model(&finder)
                    .ok_or_else(|| CoreError::invalid("The separation model is not installed."))?;
                let runtime = find_model(&runtime_finder).ok_or_else(|| CoreError::invalid(RUNTIME_MISSING))?;
                log::info!("Loading the separation model from {} with {}", model.display(), runtime.display());
                *slot = Some(Separator::load(&model, &runtime)?);
            }
            let separator = slot.as_mut().unwrap();
            separate::separate_file(separator, song, out_dir, |s| stage(s), &mut *progress)
        });
        let queue = Queue::new(store.stems_dir(), runner);
        let backend = Arc::new(Self { store, lyrics, queue, model_candidates: candidates, runtime_candidates: runtimes });
        if let Err(error) = backend.store.fill_in_genres() {
            log::warn!("Could not fill in genres: {error}");
        }
        Ok(backend)
    }

    pub fn model(&self) -> Option<PathBuf> {
        find_model(&self.model_candidates)
    }

    /// The ONNX Runtime library, if this installation has one.
    pub fn runtime(&self) -> Option<PathBuf> {
        find_model(&self.runtime_candidates)
    }

    /// Where an installed model goes (the app's own data folder).
    pub fn model_install_path(&self) -> PathBuf {
        self.store.root().join("models").join(MODEL_FILE)
    }

    fn public_track(&self, track: &Track) -> Value {
        let stems = serde_json::to_value(self.queue.status(&track.id)).unwrap_or(Value::Null);
        track.public(stems)
    }

    /// Queue songs to be separated ahead of time, if that setting is on.
    pub fn prepare_in_background(&self, tracks: Option<Vec<Track>>) {
        let Ok(settings) = self.store.settings() else { return };
        if !settings.auto_prepare || self.model().is_none() || self.runtime().is_none() {
            return;
        }
        let tracks = match tracks {
            Some(tracks) => tracks,
            None => self.store.tracks().unwrap_or_default(),
        };
        for track in tracks {
            if !self.queue.has_stems(&track.id) {
                self.queue.request(&track.id, &self.store.audio_path(&track), false);
            }
        }
    }

    /// Answer one request: `GET /api/tracks`, `PUT /api/tracks/<id>` and so on.
    pub fn route(&self, method: &str, path: &str, body: Option<Value>) -> ApiResult {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        let body = body.unwrap_or(Value::Null);
        match (method, parts.as_slice()) {
            ("GET", ["api", "tracks"]) => {
                let tracks = self.store.tracks()?;
                Ok(Value::Array(tracks.iter().map(|t| self.public_track(t)).collect()))
            }
            ("DELETE", ["api", "tracks", id]) => {
                self.store.delete_track(id)?;
                self.queue.forget(id);
                self.lyrics.forget(id);
                Ok(json!({"ok": true}))
            }
            ("PUT", ["api", "tracks", id]) => {
                let edit: TrackEdit = serde_json::from_value(clean_edit(body)).unwrap_or_default();
                let track = self.store.edit_track(id, edit)?;
                Ok(self.public_track(&track))
            }
            ("DELETE", ["api", "tracks", id, "cover"]) => {
                let track = self.store.remove_track_cover(id)?;
                Ok(self.public_track(&track))
            }
            ("GET", ["api", "tracks", id, "lyrics"]) => self.lyrics_for(id),
            ("PUT", ["api", "tracks", id, "lyrics"]) => {
                self.store.track(id)?;
                let text = body.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if text.is_empty() {
                    return Err(ApiError::new(400, "There are no lyrics to save."));
                }
                self.lyrics.save(id, "manual", &text, false)?;
                self.lyrics_for(id)
            }
            ("DELETE", ["api", "tracks", id, "lyrics"]) => {
                self.store.track(id)?;
                self.lyrics.remove(id)?;
                self.lyrics_for(id)
            }
            ("POST", ["api", "tracks", id, "lyrics", "search"]) => {
                // Sends the song's title, artist and length to lrclib.net.
                let track = self.store.track(id)?;
                let found = lyrics::lookup(&track.title, &track.artist, track.duration)
                    .map_err(|e| ApiError::new(502, e.to_string()))?;
                if let Some(found) = found {
                    self.lyrics.save(id, "online", &found.text, found.instrumental)?;
                }
                let mut view = self.lyrics_for(id)?;
                view["searched"] = json!(true);
                Ok(view)
            }
            ("POST", ["api", "tracks", id, "separate"]) => {
                let track = self.store.track(id)?;
                if self.runtime().is_none() {
                    let mut error = ApiError::new(503, RUNTIME_MISSING);
                    error.extra.insert("state".into(), json!("error"));
                    return Err(error);
                }
                if self.model().is_none() {
                    let mut error = ApiError::new(
                        503,
                        "AI separation needs its model file, which isn't installed yet. \
                         Choose \"Install separation model\" to add it.",
                    );
                    error.extra.insert("state".into(), json!("error"));
                    error.extra.insert("needsModel".into(), json!(true));
                    return Err(error);
                }
                let status = self.queue.request(id, &self.store.audio_path(&track), true);
                Ok(serde_json::to_value(status).unwrap_or(Value::Null))
            }
            ("GET", ["api", "stems"]) => {
                let mut all = serde_json::Map::new();
                for track in self.store.tracks()? {
                    all.insert(track.id.clone(), serde_json::to_value(self.queue.status(&track.id)).unwrap_or(Value::Null));
                }
                Ok(Value::Object(all))
            }
            ("GET", ["api", "playlists"]) => Ok(Value::Array(self.store.playlists()?.iter().map(|p| p.public()).collect())),
            ("POST", ["api", "playlists"]) => {
                let edit: PlaylistEdit = serde_json::from_value(body).unwrap_or_default();
                Ok(self.store.create_playlist(edit)?.public())
            }
            ("PUT", ["api", "playlists", id]) => {
                let edit: PlaylistEdit = serde_json::from_value(body).unwrap_or_default();
                Ok(self.store.update_playlist(id, edit)?.public())
            }
            ("DELETE", ["api", "playlists", id]) => {
                self.store.delete_playlist(id)?;
                Ok(json!({"ok": true}))
            }
            ("DELETE", ["api", "playlists", id, "cover"]) => Ok(self.store.remove_playlist_cover(id)?.public()),
            ("GET", ["api", "settings"]) => Ok(serde_json::to_value(self.store.settings()?).unwrap_or(Value::Null)),
            ("PUT", ["api", "settings"]) => {
                let settings = match body.get("autoPrepare").and_then(Value::as_bool) {
                    Some(on) => self.store.set_auto_prepare(on)?,
                    None => self.store.settings()?,
                };
                if settings.auto_prepare {
                    self.prepare_in_background(None);
                } else {
                    self.queue.cancel_background();
                }
                Ok(serde_json::to_value(settings).unwrap_or(Value::Null))
            }
            _ => {
                let _ = query;
                Err(ApiError::new(404, format!("Unknown request: {method} {path}")))
            }
        }
    }

    fn lyrics_for(&self, id: &str) -> ApiResult {
        let track = self.store.track(id)?;
        let view = lyrics::describe(&self.lyrics, id, &self.store.audio_path(&track));
        Ok(serde_json::to_value(view).unwrap_or(Value::Null))
    }

    /// `POST /api/tracks`: songs dropped on the window or chosen in the
    /// browser-style file picker arrive as bytes, one file per call.
    pub fn add_bytes(&self, name: &str, bytes: &[u8], skip_duplicates: bool) -> ApiResult {
        let dir = self.store.root().join("incoming");
        std::fs::create_dir_all(&dir).map_err(CoreError::from)?;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = dir.join(format!("{}-{}-{n}.part", std::process::id(), rand_suffix()));
        std::fs::write(&temp, bytes).map_err(CoreError::from)?;
        let result = self.add_paths(&[(temp.clone(), name.to_string())], skip_duplicates);
        let _ = std::fs::remove_file(&temp);
        result
    }

    /// Add songs from files on disk (the native file picker). Each is copied
    /// into the library; the originals are never changed.
    pub fn add_paths(&self, files: &[(PathBuf, String)], skip_duplicates: bool) -> ApiResult {
        let mut known: Option<HashSet<String>> = if skip_duplicates { Some(self.store.library_hashes()?) } else { None };
        let (mut added, mut rejected, mut duplicates) = (Vec::new(), Vec::new(), Vec::new());
        let mut new_tracks = Vec::new();
        for (path, name) in files {
            match self.store.add_file(path, name, known.as_mut()) {
                Ok(Added::Added(track)) => {
                    added.push(self.public_track(&track));
                    new_tracks.push(track);
                }
                Ok(Added::Duplicate) => duplicates.push(json!(name)),
                Ok(Added::Rejected) => rejected.push(json!(if name.is_empty() { "(unnamed)" } else { name })),
                Err(error) => {
                    log::warn!("Could not add {name}: {error}");
                    rejected.push(json!(name));
                }
            }
        }
        self.prepare_in_background(Some(new_tracks));
        Ok(json!({"added": added, "rejected": rejected, "duplicates": duplicates}))
    }

    /// `POST /api/tracks/<id>/cover` and `POST /api/playlists/<id>/cover`.
    pub fn set_cover(&self, path: &str, bytes: &[u8]) -> ApiResult {
        if bytes.len() > pictures::MAX_BYTES {
            return Err(ApiError::new(400, "That picture is too large (the limit is 40 MB)."));
        }
        let picture = pictures::normalise(bytes)?;
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        match parts.as_slice() {
            ["api", "tracks", id, "cover"] => {
                let track = self.store.set_track_cover(id, &picture)?;
                Ok(self.public_track(&track))
            }
            ["api", "playlists", id, "cover"] => Ok(self.store.set_playlist_cover(id, &picture)?.public()),
            _ => Err(ApiError::new(404, format!("Unknown request: POST {path}"))),
        }
    }

    /// Migrate: every song under a folder, copied in, duplicates skipped.
    pub fn migrate(&self, folder: &Path, progress: impl FnMut(usize, usize, &str) -> bool) -> ApiResult {
        let summary = migrate::migrate(&self.store, folder, progress)?;
        self.prepare_in_background(None);
        Ok(serde_json::to_value(summary).unwrap_or(Value::Null))
    }

    /// The files to play for a song: the original, one stem, or both stems
    /// (Separate Audio, vocals first).
    pub fn audio_files(&self, id: &str, stem: &str) -> Result<Vec<PathBuf>, ApiError> {
        let track = self.store.track(id)?;
        let files = match stem {
            "original" => vec![self.store.audio_path(&track)],
            "vocals" | "instrumental" => vec![self.queue.stem_path(id, stem)],
            "mix" => vec![self.queue.stem_path(id, "vocals"), self.queue.stem_path(id, "instrumental")],
            _ => return Err(ApiError::new(400, "Unknown stem")),
        };
        if files.iter().any(|f| !f.is_file()) {
            return Err(ApiError::new(404, "Audio not available"));
        }
        Ok(files)
    }

    /// A cover picture's file, for the `media:` protocol.
    pub fn cover_file(&self, kind: &str, id: &str) -> Option<PathBuf> {
        match kind {
            "track" => self.store.track(id).ok().and_then(|t| self.store.cover_path(&t)),
            "playlist" => self.store.playlist_cover_path(id).ok().flatten(),
            _ => None,
        }
        .filter(|p| p.is_file())
    }
}

const RUNTIME_MISSING: &str = "AI separation can't run: this installation is missing ONNX Runtime. Reinstall Lewisis' Music to restore it.";

fn find_model(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// The Python version treated `null` as an empty string for these fields and
/// accepted genres as one string; do the same.
fn clean_edit(mut body: Value) -> Value {
    if let Some(object) = body.as_object_mut() {
        for key in ["title", "artist", "album", "type"] {
            if object.get(key).is_some_and(Value::is_null) {
                object.insert(key.into(), json!(""));
            }
        }
        if let Some(Value::String(one)) = object.get("genres") {
            let one = one.clone();
            object.insert("genres".into(), json!([one]));
        }
        if object.get("genres").is_some_and(Value::is_null) {
            object.insert("genres".into(), json!([]));
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A backend whose model and ONNX Runtime are looked for only in the
    /// test's own folder (so files on the developer's machine don't count).
    fn backend() -> (tempfile::TempDir, Arc<Backend>) {
        let dir = tempfile::tempdir().unwrap();
        let (model, runtime) = (dir.path().join("model.onnx"), dir.path().join(separate::RUNTIME_LIBRARY));
        let backend = Backend::open_with(dir.path(), vec![model], vec![runtime]).unwrap();
        (dir, backend)
    }

    #[test]
    fn answers_like_the_flask_server() {
        let (dir, api) = backend();
        assert_eq!(api.route("GET", "/api/tracks", None).unwrap(), json!([]));
        let song = dir.path().join("in.wav");
        std::fs::write(&song, b"RIFF-not-really").unwrap();
        let added = api.add_paths(&[(song.clone(), "Band - Song.wav".into())], false).unwrap();
        let id = added["added"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(added["added"][0]["artist"], "Band");
        assert_eq!(added["added"][0]["stems"]["state"], "none");

        let again = api.add_paths(&[(song, "Copy.wav".into())], true).unwrap();
        assert_eq!(again["duplicates"], json!(["Copy.wav"]));

        let edited = api.route("PUT", &format!("/api/tracks/{id}"), Some(json!({"title": "New", "type": "Sad"}))).unwrap();
        assert_eq!((edited["title"].as_str(), edited["type"].as_str()), (Some("New"), Some("sad")));
        let bad = api.route("PUT", &format!("/api/tracks/{id}"), Some(json!({"title": " "}))).unwrap_err();
        assert_eq!((bad.status, bad.error.as_str()), (400, "A song needs a title."));

        let playlist = api.route("POST", "/api/playlists", Some(json!({"name": "", "trackIds": [id, id, "nope"]}))).unwrap();
        assert_eq!(playlist["name"], "New Playlist");
        assert_eq!(playlist["trackIds"], json!([id]));

        let lyrics = api.route("PUT", &format!("/api/tracks/{id}/lyrics"), Some(json!({"text": "[00:01.00]Hi\n[00:02.00]There"}))).unwrap();
        assert_eq!((lyrics["found"].as_bool(), lyrics["synced"].as_bool()), (Some(true), Some(true)));
        let removed = api.route("DELETE", &format!("/api/tracks/{id}/lyrics"), None).unwrap();
        assert_eq!(removed["removed"], true);

        // No ONNX Runtime: separation can't run, and installing a model wouldn't help.
        let no_runtime = api.route("POST", &format!("/api/tracks/{id}/separate"), None).unwrap_err();
        assert_eq!(no_runtime.status, 503);
        assert!(no_runtime.error.contains("ONNX Runtime"), "{}", no_runtime.error);
        assert!(!no_runtime.extra.contains_key("needsModel"));
        // ONNX Runtime present but no model: the interface offers to install one.
        std::fs::write(dir.path().join(separate::RUNTIME_LIBRARY), b"stand-in").unwrap();
        let missing = api.route("POST", &format!("/api/tracks/{id}/separate"), None).unwrap_err();
        assert_eq!(missing.status, 503);
        assert_eq!(missing.extra["needsModel"], true);

        assert_eq!(api.route("PUT", "/api/settings", Some(json!({"autoPrepare": false}))).unwrap()["autoPrepare"], false);
        assert_eq!(api.route("DELETE", &format!("/api/tracks/{id}"), None).unwrap(), json!({"ok": true}));
        assert_eq!(api.route("GET", "/api/stems", None).unwrap(), json!({}));
        assert_eq!(api.route("GET", "/api/nothing", None).unwrap_err().status, 404);
    }
}
