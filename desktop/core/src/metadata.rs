//! Reading a song file's own details: title, artist, album, length, cover,
//! genres and lyrics. Unreadable tags never stop a song from being added.

use std::path::Path;
use std::sync::LazyLock;

use lofty::file::TaggedFile;
use lofty::prelude::*;
use lofty::tag::Tag;
use regex::Regex;

/// What a song file says about itself.
#[derive(Debug, Default, Clone)]
pub struct SongInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Seconds.
    pub duration: f64,
    /// The embedded cover picture and its MIME type, if any.
    pub cover: Option<(Vec<u8>, String)>,
    pub genres: Vec<String>,
    /// Lyrics stored in the file ("" if none); see [`embedded_lyrics`].
    pub lyrics: String,
}

static ARTIST_TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.+?)\s+-\s+(.+)$").unwrap());

fn tags_of(tagged: TaggedFile) -> (Vec<Tag>, f64) {
    let duration = tagged.properties().duration().as_secs_f64();
    (tagged.tags().to_vec(), duration)
}

fn all_tags(path: &Path) -> Option<(Vec<Tag>, f64)> {
    lofty::read_from_path(path).ok().map(tags_of)
}

fn all_tags_in(data: &[u8]) -> Option<(Vec<Tag>, f64)> {
    let probe = lofty::probe::Probe::new(std::io::Cursor::new(data)).guess_file_type().ok()?;
    probe.read().ok().map(tags_of)
}

fn first_text(tags: &[Tag], read: impl Fn(&Tag) -> Option<String>) -> String {
    tags.iter()
        .find_map(|tag| read(tag).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

/// Title / artist / album / length / cover / genres / lyrics, with the file
/// name as a fallback for the title ("Artist - Title.mp3").
pub fn read(path: &Path, original_name: &str) -> SongInfo {
    info_from(all_tags(path), original_name)
}

/// The same as [`read`], for a song held in memory (the web version).
pub fn read_bytes(data: &[u8], original_name: &str) -> SongInfo {
    info_from(all_tags_in(data), original_name)
}

fn info_from(found: Option<(Vec<Tag>, f64)>, original_name: &str) -> SongInfo {
    let mut info = SongInfo::default();
    if let Some((tags, duration)) = found {
        info.duration = duration;
        info.title = first_text(&tags, |t| t.title().map(|s| s.into_owned()));
        info.artist = first_text(&tags, |t| {
            t.artist().map(|s| s.into_owned()).or_else(|| t.get_string(ItemKey::AlbumArtist).map(str::to_string))
        });
        info.album = first_text(&tags, |t| t.album().map(|s| s.into_owned()));
        info.cover = tags.iter().find_map(|tag| {
            tag.pictures().first().map(|p| {
                let mime = p.mime_type().map(|m| m.as_str().to_string()).unwrap_or_default();
                (p.data().to_vec(), mime)
            })
        });
        info.genres = crate::genres::clean(tags.iter().flat_map(|t| t.get_strings(ItemKey::Genre)));
        info.lyrics = lyrics_in(&tags);
    }

    if info.title.is_empty() {
        let stem = Path::new(original_name)
            .file_stem()
            .map(|s| s.to_string_lossy().replace('_', " ").trim().to_string())
            .unwrap_or_default();
        match ARTIST_TITLE.captures(&stem) {
            Some(found) if info.artist.is_empty() => {
                info.artist = found[1].trim().to_string();
                info.title = found[2].trim().to_string();
            }
            _ => info.title = if stem.is_empty() { "Untitled".into() } else { stem },
        }
    }
    info
}

/// Genres stored in the song file's own tags.
pub fn genres(path: &Path) -> Vec<String> {
    match all_tags(path) {
        Some((tags, _)) => crate::genres::clean(tags.iter().flat_map(|t| t.get_strings(ItemKey::Genre))),
        None => vec![],
    }
}

/// Lyrics stored in the song file ("" if there are none). When the file holds
/// more than one version, a timed (LRC) one is preferred.
pub fn embedded_lyrics(path: &Path) -> String {
    all_tags(path).map(|(tags, _)| lyrics_in(&tags)).unwrap_or_default()
}

fn lyrics_in(tags: &[Tag]) -> String {
    let texts: Vec<String> = tags
        .iter()
        .flat_map(|tag| {
            tag.get_strings(ItemKey::Lyrics).chain(tag.get_strings(ItemKey::UnsyncLyrics)).map(|t| t.trim().to_string())
        })
        .filter(|t| !t.is_empty())
        .collect();
    texts
        .iter()
        .find(|text| crate::lyrics::parse(text).synced)
        .or_else(|| texts.first())
        .cloned()
        .unwrap_or_default()
}
