//! The library (songs), playlists and settings, kept as JSON files next to the
//! songs themselves:
//!
//! ```text
//! <root>/library.json    songs        <root>/music/<id>.<ext>    the audio
//! <root>/playlists.json  playlists    <root>/covers/<id>.<ext>   pictures
//! <root>/settings.json   settings     <root>/stems/<id>/…        vocals / instrumental
//!                                     <root>/lyrics/<id>.json    saved lyrics
//! ```
//!
//! Every change is a read–modify–write under one lock, and files are replaced
//! atomically, so a crash never leaves half a library behind.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::pictures::Picture;
use crate::{Error, Result, genres, metadata};

/// The audio formats a song can be added in.
pub const AUDIO_EXTENSIONS: &[&str] = &[".mp3", ".wav", ".flac"];
/// The moods a song's "Type" can be, chosen by the listener.
pub const TYPES: &[&str] = &["happy", "sad", "quiet", "energetic"];
const PICTURE_EXTENSIONS: &[&str] = &[".jpg", ".png", ".webp", ".gif"];

fn null_default<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> std::result::Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// One song in the library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub title: String,
    #[serde(default, deserialize_with = "null_default")]
    pub artist: String,
    #[serde(default, deserialize_with = "null_default")]
    pub album: String,
    /// Seconds.
    #[serde(default, deserialize_with = "null_default")]
    pub duration: f64,
    /// ".mp3", ".wav" or ".flac".
    #[serde(default, deserialize_with = "null_default")]
    pub ext: String,
    /// The file name inside `music/`.
    #[serde(default, deserialize_with = "null_default")]
    pub file: String,
    /// The file name inside `covers/`, if the song has a cover.
    #[serde(default)]
    pub cover: Option<String>,
    /// When it was added (seconds since 1970).
    #[serde(default, deserialize_with = "null_default")]
    pub added: i64,
    /// Mood: "", "happy", "sad", "quiet" or "energetic".
    #[serde(rename = "type", default, deserialize_with = "null_default")]
    pub kind: String,
    /// `None` only for songs added before genres existed (filled in once).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    /// A fingerprint of the audio file, to spot the same song twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Changes whenever the cover does, so the interface fetches the new one.
    #[serde(rename = "coverVersion", default, skip_serializing_if = "is_zero")]
    pub cover_version: i64,
    /// Anything else in the file, kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Track {
    /// The song as the interface sees it (same shape as the Python version).
    pub fn public(&self, stems: Value) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "duration": self.duration,
            "format": self.ext.trim_start_matches('.').to_uppercase(),
            "hasCover": self.cover.is_some(),
            "type": self.kind,
            "genres": self.genres.clone().unwrap_or_default(),
            "coverVersion": self.cover_version,
            "stems": stems,
        })
    }
}

/// One playlist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub name: String,
    #[serde(rename = "trackIds", default, deserialize_with = "null_default")]
    pub track_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(rename = "coverVersion", default, skip_serializing_if = "is_zero")]
    pub cover_version: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub created: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Playlist {
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "trackIds": self.track_ids,
            "hasCover": self.cover.is_some(),
            "coverVersion": self.cover_version,
        })
    }
}

/// Player-wide settings stored on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// Split every song into vocals / instrumental ahead of time.
    #[serde(rename = "autoPrepare", default = "yes")]
    pub auto_prepare: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
fn yes() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self { auto_prepare: true, extra: Map::new() }
    }
}

/// Changes to a song's info; `None` leaves that field as it is.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct TrackEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub genres: Option<Vec<String>>,
}

/// Changes to a playlist; `None` leaves that field as it is.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct PlaylistEdit {
    pub name: Option<String>,
    #[serde(rename = "trackIds")]
    pub track_ids: Option<Vec<String>>,
}

/// What happened to one file offered to the library.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // made once per song; boxing gains nothing
pub enum Added {
    Added(Track),
    /// Not a song (wrong kind of file).
    Rejected,
    /// The same audio is already in the library (only when skipping duplicates).
    Duplicate,
}

/// Write `value` as pretty JSON, replacing the file in one step.
pub fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json")
    ));
    fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(T::default()),
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}
/// Collapse runs of spaces and cut to `max` characters.
fn tidy(text: &str, max: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// A fingerprint of a file's contents.
pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The library on disk. Cheap to share between threads (`Arc<Store>`).
pub struct Store {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        for folder in ["music", "covers", "stems", "lyrics"] {
            fs::create_dir_all(root.join(folder))?;
        }
        Ok(Self { root, lock: Mutex::new(()) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn music_dir(&self) -> PathBuf {
        self.root.join("music")
    }
    pub fn covers_dir(&self) -> PathBuf {
        self.root.join("covers")
    }
    pub fn stems_dir(&self) -> PathBuf {
        self.root.join("stems")
    }
    pub fn lyrics_dir(&self) -> PathBuf {
        self.root.join("lyrics")
    }
    fn library_file(&self) -> PathBuf {
        self.root.join("library.json")
    }
    fn playlists_file(&self) -> PathBuf {
        self.root.join("playlists.json")
    }
    fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---- songs ---------------------------------------------------------

    pub fn tracks(&self) -> Result<Vec<Track>> {
        let _guard = self.guard();
        read_json(&self.library_file())
    }

    pub fn track(&self, id: &str) -> Result<Track> {
        self.tracks()?.into_iter().find(|t| t.id == id).ok_or_else(|| Error::not_found("Track"))
    }

    /// Where a song's audio file is.
    pub fn audio_path(&self, track: &Track) -> PathBuf {
        self.music_dir().join(&track.file)
    }

    /// Where a song's cover is, if it has one.
    pub fn cover_path(&self, track: &Track) -> Option<PathBuf> {
        track.cover.as_ref().map(|name| self.covers_dir().join(name))
    }

    fn change_track(&self, id: &str, change: impl FnOnce(&mut Track)) -> Result<Track> {
        let _guard = self.guard();
        let mut tracks: Vec<Track> = read_json(&self.library_file())?;
        let track = tracks.iter_mut().find(|t| t.id == id).ok_or_else(|| Error::not_found("Track"))?;
        change(track);
        let changed = track.clone();
        write_json_atomic(&self.library_file(), &tracks)?;
        Ok(changed)
    }

    /// Fingerprints of every song (worked out once for older songs).
    pub fn library_hashes(&self) -> Result<HashSet<String>> {
        let missing: Vec<(String, PathBuf)> = self
            .tracks()?
            .iter()
            .filter(|t| t.hash.is_none())
            .map(|t| (t.id.clone(), self.audio_path(t)))
            .collect();
        // Outside the lock: this reads whole files.
        let found: Vec<(String, String)> =
            missing.into_iter().filter_map(|(id, path)| file_hash(&path).ok().map(|h| (id, h))).collect();
        let _guard = self.guard();
        let mut tracks: Vec<Track> = read_json(&self.library_file())?;
        if !found.is_empty() {
            for track in tracks.iter_mut() {
                if track.hash.is_none()
                    && let Some((_, hash)) = found.iter().find(|(id, _)| *id == track.id)
                {
                    track.hash = Some(hash.clone());
                }
            }
            write_json_atomic(&self.library_file(), &tracks)?;
        }
        Ok(tracks.into_iter().filter_map(|t| t.hash).collect())
    }

    /// Copy a song file into `music/` and add it to the library. Nothing already
    /// there is removed. With `skip_duplicates` (Migrate), a song whose audio is
    /// already in the library is skipped. `known` caches the fingerprints across
    /// a batch of files.
    pub fn add_file(&self, source: &Path, original_name: &str, known: Option<&mut HashSet<String>>) -> Result<Added> {
        let ext = Path::new(original_name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            return Ok(Added::Rejected);
        }
        let digest = file_hash(source)?;
        if let Some(known) = &known
            && known.contains(&digest)
        {
            return Ok(Added::Duplicate);
        }
        let id = new_id();
        let path = self.music_dir().join(format!("{id}{ext}"));
        fs::copy(source, &path)?;

        let info = metadata::read(&path, original_name);
        let mut cover = None;
        if let Some((data, _mime)) = &info.cover
            && let Ok(picture) = crate::pictures::normalise(data)
        {
            let name = format!("{id}{}", picture.extension);
            fs::write(self.covers_dir().join(&name), &picture.bytes)?;
            cover = Some(name);
        }
        let track = Track {
            id: id.clone(),
            title: info.title,
            artist: info.artist,
            album: info.album,
            duration: (info.duration * 100.0).round() / 100.0,
            ext,
            file: path.file_name().unwrap().to_string_lossy().into_owned(),
            cover,
            added: now_secs(),
            kind: String::new(),
            genres: Some(info.genres),
            hash: Some(digest.clone()),
            cover_version: 0,
            extra: Map::new(),
        };
        {
            let _guard = self.guard();
            let mut tracks: Vec<Track> = read_json(&self.library_file())?;
            tracks.push(track.clone());
            write_json_atomic(&self.library_file(), &tracks)?;
        }
        if let Some(known) = known {
            known.insert(digest);
        }
        Ok(Added::Added(track))
    }

    /// Remove a song: from the library, from every playlist, and its own copy
    /// of the audio and cover (never the listener's original file).
    pub fn delete_track(&self, id: &str) -> Result<Track> {
        let track = {
            let _guard = self.guard();
            let mut tracks: Vec<Track> = read_json(&self.library_file())?;
            let at = tracks.iter().position(|t| t.id == id).ok_or_else(|| Error::not_found("Track"))?;
            let track = tracks.remove(at);
            write_json_atomic(&self.library_file(), &tracks)?;
            let mut playlists: Vec<Playlist> = read_json(&self.playlists_file())?;
            for playlist in playlists.iter_mut() {
                playlist.track_ids.retain(|t| t != id);
            }
            write_json_atomic(&self.playlists_file(), &playlists)?;
            track
        };
        let _ = fs::remove_file(self.audio_path(&track));
        if let Some(cover) = self.cover_path(&track) {
            let _ = fs::remove_file(cover);
        }
        Ok(track)
    }

    /// Change a song's title, artist, album, type (mood) or genres. Only the
    /// library's own record changes; the audio file is left exactly as it is.
    pub fn edit_track(&self, id: &str, edit: TrackEdit) -> Result<Track> {
        let title = edit.title.as_deref().map(|t| tidy(t, 200));
        if title.as_deref() == Some("") {
            return Err(Error::invalid("A song needs a title."));
        }
        let kind = edit.kind.as_deref().map(|k| k.trim().to_lowercase());
        if let Some(kind) = &kind
            && !kind.is_empty()
            && !TYPES.contains(&kind.as_str())
        {
            return Err(Error::invalid("Unknown type. Choose Happy, Sad, Quiet or Energetic."));
        }
        self.change_track(id, |track| {
            if let Some(title) = title {
                track.title = title;
            }
            if let Some(artist) = &edit.artist {
                track.artist = tidy(artist, 200);
            }
            if let Some(album) = &edit.album {
                track.album = tidy(album, 200);
            }
            if let Some(kind) = kind {
                track.kind = kind;
            }
            if let Some(list) = &edit.genres {
                track.genres = Some(genres::clean(list));
            }
        })
    }

    fn remove_pictures(&self, stem: &str) {
        for ext in PICTURE_EXTENSIONS {
            let _ = fs::remove_file(self.covers_dir().join(format!("{stem}{ext}")));
        }
    }

    pub fn set_track_cover(&self, id: &str, picture: &Picture) -> Result<Track> {
        self.track(id)?;
        self.remove_pictures(id);
        let name = format!("{id}{}", picture.extension);
        fs::write(self.covers_dir().join(&name), &picture.bytes)?;
        self.change_track(id, |t| {
            t.cover = Some(name);
            t.cover_version = now_millis();
        })
    }

    pub fn remove_track_cover(&self, id: &str) -> Result<Track> {
        self.track(id)?;
        self.remove_pictures(id);
        self.change_track(id, |t| {
            t.cover = None;
            t.cover_version = now_millis();
        })
    }

    /// Songs added before genres existed get the genres from their files, once.
    pub fn fill_in_genres(&self) -> Result<()> {
        let _guard = self.guard();
        let mut tracks: Vec<Track> = read_json(&self.library_file())?;
        let mut changed = false;
        for track in tracks.iter_mut().filter(|t| t.genres.is_none()) {
            track.genres = Some(metadata::genres(&self.music_dir().join(&track.file)));
            changed = true;
        }
        if changed {
            write_json_atomic(&self.library_file(), &tracks)?;
        }
        Ok(())
    }

    // ---- playlists -----------------------------------------------------

    pub fn playlists(&self) -> Result<Vec<Playlist>> {
        let _guard = self.guard();
        read_json(&self.playlists_file())
    }

    pub fn playlist_cover_path(&self, id: &str) -> Result<Option<PathBuf>> {
        let playlist = self.playlists()?.into_iter().find(|p| p.id == id).ok_or_else(|| Error::not_found("Playlist"))?;
        Ok(playlist.cover.map(|name| self.covers_dir().join(name)))
    }

    /// A playlist name (default "New Playlist", at most 80 characters).
    fn clean_name(name: Option<&str>) -> String {
        let name: String = name.unwrap_or("").trim().chars().take(80).collect();
        if name.is_empty() { "New Playlist".into() } else { name }
    }

    /// Only songs that exist, each once, in the order given.
    fn clean_track_ids(&self, ids: &[String]) -> Result<Vec<String>> {
        let known: HashSet<String> = read_json::<Vec<Track>>(&self.library_file())?.into_iter().map(|t| t.id).collect();
        let mut seen = HashSet::new();
        Ok(ids.iter().filter(|id| known.contains(*id) && seen.insert((*id).clone())).cloned().collect())
    }

    pub fn create_playlist(&self, edit: PlaylistEdit) -> Result<Playlist> {
        let _guard = self.guard();
        let playlist = Playlist {
            id: new_id(),
            name: Self::clean_name(edit.name.as_deref()),
            track_ids: self.clean_track_ids(&edit.track_ids.unwrap_or_default())?,
            cover: None,
            cover_version: 0,
            created: now_secs(),
            extra: Map::new(),
        };
        let mut playlists: Vec<Playlist> = read_json(&self.playlists_file())?;
        playlists.push(playlist.clone());
        write_json_atomic(&self.playlists_file(), &playlists)?;
        Ok(playlist)
    }

    fn change_playlist(&self, id: &str, change: impl FnOnce(&mut Playlist) -> Result<()>) -> Result<Playlist> {
        let _guard = self.guard();
        let mut playlists: Vec<Playlist> = read_json(&self.playlists_file())?;
        let playlist = playlists.iter_mut().find(|p| p.id == id).ok_or_else(|| Error::not_found("Playlist"))?;
        change(playlist)?;
        let changed = playlist.clone();
        write_json_atomic(&self.playlists_file(), &playlists)?;
        Ok(changed)
    }

    pub fn update_playlist(&self, id: &str, edit: PlaylistEdit) -> Result<Playlist> {
        let ids = match &edit.track_ids {
            Some(ids) => Some({
                let _guard = self.guard();
                self.clean_track_ids(ids)?
            }),
            None => None,
        };
        self.change_playlist(id, |playlist| {
            if edit.name.is_some() {
                playlist.name = Self::clean_name(edit.name.as_deref());
            }
            if let Some(ids) = ids {
                playlist.track_ids = ids;
            }
            Ok(())
        })
    }

    pub fn delete_playlist(&self, id: &str) -> Result<()> {
        {
            let _guard = self.guard();
            let mut playlists: Vec<Playlist> = read_json(&self.playlists_file())?;
            let before = playlists.len();
            playlists.retain(|p| p.id != id);
            if playlists.len() == before {
                return Err(Error::not_found("Playlist"));
            }
            write_json_atomic(&self.playlists_file(), &playlists)?;
        }
        self.remove_pictures(&format!("pl-{id}"));
        Ok(())
    }

    pub fn set_playlist_cover(&self, id: &str, picture: &Picture) -> Result<Playlist> {
        self.change_playlist(id, |_| Ok(()))?; // must exist
        let stem = format!("pl-{id}");
        self.remove_pictures(&stem);
        let name = format!("{stem}{}", picture.extension);
        fs::write(self.covers_dir().join(&name), &picture.bytes)?;
        self.change_playlist(id, |p| {
            p.cover = Some(name);
            p.cover_version = now_millis();
            Ok(())
        })
    }

    pub fn remove_playlist_cover(&self, id: &str) -> Result<Playlist> {
        self.change_playlist(id, |_| Ok(()))?;
        self.remove_pictures(&format!("pl-{id}"));
        self.change_playlist(id, |p| {
            p.cover = None;
            p.cover_version = now_millis();
            Ok(())
        })
    }

    // ---- settings ------------------------------------------------------

    pub fn settings(&self) -> Result<Settings> {
        let _guard = self.guard();
        let path = self.settings_file();
        if !path.exists() {
            return Ok(Settings::default());
        }
        read_json::<Option<Settings>>(&path).map(Option::unwrap_or_default)
    }

    pub fn set_auto_prepare(&self, on: bool) -> Result<Settings> {
        let mut settings = self.settings()?;
        settings.auto_prepare = on;
        let _guard = self.guard();
        write_json_atomic(&self.settings_file(), &settings)?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn song(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_the_python_library_format() {
        let (dir, store) = store();
        fs::write(
            dir.path().join("library.json"),
            r#"[{"id": "6d9bc6e92f56", "title": "Alibi", "artist": "Joan", "album": "Lucid Dreaming",
                 "type": "", "genres": [], "duration": 213.2, "ext": ".mp3", "file": "6d9bc6e92f56.mp3",
                 "cover": "6d9bc6e92f56.jpg", "added": 1794000000, "hash": "ab", "custom": 7},
                {"id": "old", "title": "Old", "artist": "", "album": "", "duration": 10, "ext": ".wav",
                 "file": "old.wav", "cover": null, "added": 1}]"#,
        )
        .unwrap();
        let tracks = store.tracks().unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].public(json!({"state": "none"}))["format"], "MP3");
        assert_eq!(tracks[0].extra["custom"], 7);
        assert_eq!(tracks[1].genres, None); // older songs get theirs filled in once
        store.fill_in_genres().unwrap();
        assert_eq!(store.track("old").unwrap().genres, Some(vec![]));
        // Unknown fields survive a save.
        store.edit_track("6d9bc6e92f56", TrackEdit { title: Some("  Alibi  (Live) ".into()), ..Default::default() }).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(dir.path().join("library.json")).unwrap()).unwrap();
        assert_eq!(saved[0]["title"], "Alibi (Live)");
        assert_eq!(saved[0]["custom"], 7);
    }

    #[test]
    fn adds_songs_and_skips_duplicates_when_asked() {
        let (dir, store) = store();
        let a = song(dir.path(), "Test Band - First.wav", b"RIFF-not-really-audio-1");
        let b = song(dir.path(), "Copy.wav", b"RIFF-not-really-audio-1");
        let notes = song(dir.path(), "notes.txt", b"hello");
        let Added::Added(first) = store.add_file(&a, "Test Band - First.wav", None).unwrap() else { panic!() };
        assert_eq!((first.artist.as_str(), first.title.as_str()), ("Test Band", "First"));
        assert_eq!(store.add_file(&notes, "notes.txt", None).unwrap(), Added::Rejected);
        let mut known = store.library_hashes().unwrap();
        assert_eq!(store.add_file(&b, "Copy.wav", Some(&mut known)).unwrap(), Added::Duplicate);
        assert!(matches!(store.add_file(&b, "Copy.wav", None).unwrap(), Added::Added(_)));
        assert_eq!(store.tracks().unwrap().len(), 2);
        assert_eq!(fs::read_dir(store.music_dir()).unwrap().count(), 2);
    }

    #[test]
    fn edits_check_their_input() {
        let (dir, store) = store();
        let a = song(dir.path(), "a.wav", b"x");
        let Added::Added(track) = store.add_file(&a, "a.wav", None).unwrap() else { panic!() };
        let bad_title = store.edit_track(&track.id, TrackEdit { title: Some("   ".into()), ..Default::default() });
        assert_eq!(bad_title.unwrap_err().to_string(), "A song needs a title.");
        let bad_type = store.edit_track(&track.id, TrackEdit { kind: Some("angry".into()), ..Default::default() });
        assert!(bad_type.is_err());
        let edited = store
            .edit_track(
                &track.id,
                TrackEdit { kind: Some("Energetic".into()), genres: Some(vec!["rock".into(), "Metal".into(), "ROCK".into()]), ..Default::default() },
            )
            .unwrap();
        assert_eq!(edited.kind, "energetic");
        assert_eq!(edited.genres, Some(vec!["rock".to_string(), "Metal".to_string()]));
        assert_eq!(store.track("nope").unwrap_err().to_string(), "Track not found");
    }

    #[test]
    fn playlists_keep_known_songs_once_and_lose_deleted_ones() {
        let (dir, store) = store();
        let Added::Added(a) = store.add_file(&song(dir.path(), "a.wav", b"1"), "a.wav", None).unwrap() else { panic!() };
        let Added::Added(b) = store.add_file(&song(dir.path(), "b.wav", b"2"), "b.wav", None).unwrap() else { panic!() };
        let list = store
            .create_playlist(PlaylistEdit { name: Some("  ".into()), track_ids: Some(vec![a.id.clone(), "ghost".into(), a.id.clone(), b.id.clone()]) })
            .unwrap();
        assert_eq!(list.name, "New Playlist");
        assert_eq!(list.track_ids, vec![a.id.clone(), b.id.clone()]);
        store.delete_track(&a.id).unwrap();
        assert_eq!(store.playlists().unwrap()[0].track_ids, vec![b.id.clone()]);
        let renamed = store.update_playlist(&list.id, PlaylistEdit { name: Some("Road Trip".into()), track_ids: None }).unwrap();
        assert_eq!((renamed.name.as_str(), renamed.track_ids.len()), ("Road Trip", 1));
        store.delete_playlist(&list.id).unwrap();
        assert!(store.delete_playlist(&list.id).is_err());
    }

    #[test]
    fn settings_default_to_preparing_ahead() {
        let (_dir, store) = store();
        assert!(store.settings().unwrap().auto_prepare);
        assert!(!store.set_auto_prepare(false).unwrap().auto_prepare);
        assert!(!store.settings().unwrap().auto_prepare);
    }
}
