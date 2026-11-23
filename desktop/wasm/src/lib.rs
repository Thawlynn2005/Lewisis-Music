//! The web version of Lewisis' Music keeps each visitor's library in their own
//! browser. These are the parts it shares with the desktop app, compiled to
//! WebAssembly, so both read song info, covers and lyrics exactly the same way:
//! song details and embedded covers/lyrics, cover pictures, the lyrics format,
//! genre tidying, choosing an online lyrics match, and FLAC for separated stems.

use lewisis_core::{audio_file, genres, lyrics, metadata, pictures};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Song {
    title: String,
    artist: String,
    album: String,
    duration: f64,
    genres: Vec<String>,
    lyrics: String,
    #[serde(with = "serde_bytes")]
    cover: Option<Vec<u8>>,
    cover_mime: String,
}

/// What a song file (its bytes) says about itself; `name` is its file name,
/// used for the title when the file has none ("Artist - Title.mp3").
#[wasm_bindgen(js_name = readSong)]
pub fn read_song(bytes: &[u8], name: &str) -> Result<JsValue, JsValue> {
    let info = metadata::read_bytes(bytes, name);
    let (cover, cover_mime) = match info.cover {
        Some((data, mime)) if !data.is_empty() => (Some(data), mime),
        _ => (None, String::new()),
    };
    to_js(&Song {
        title: info.title,
        artist: info.artist,
        album: info.album,
        duration: (info.duration * 100.0).round() / 100.0,
        genres: info.genres,
        lyrics: info.lyrics,
        cover,
        cover_mime,
    })
}

#[derive(Serialize)]
struct Picture {
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
    extension: &'static str,
    mime: &'static str,
}

/// Any picture (JPEG, PNG, WebP, GIF, BMP, TIFF, ICO) as a cover: turned the
/// right way up, at most 1400 px, saved as JPEG (PNG if see-through), with the
/// photo's hidden details left out. Throws the message to show if it can't.
#[wasm_bindgen(js_name = normalisePicture)]
pub fn normalise_picture(bytes: &[u8]) -> Result<JsValue, JsValue> {
    if bytes.len() > pictures::MAX_BYTES {
        return Err(JsValue::from_str("That picture is too large (the limit is 40 MB)."));
    }
    let picture = pictures::normalise(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mime = picture.mime();
    to_js(&Picture { mime, extension: picture.extension, bytes: picture.bytes })
}

/// Lyrics text → `{ synced, lines: [{ time, text }] }`.
#[wasm_bindgen(js_name = parseLyrics)]
pub fn parse_lyrics(text: &str) -> Result<JsValue, JsValue> {
    to_js(&lyrics::parse(text))
}

/// A tidy list of genres from any list of strings.
#[wasm_bindgen(js_name = cleanGenres)]
pub fn clean_genres(values: Vec<String>) -> Vec<String> {
    genres::clean(values)
}

/// The titles to search lrclib.net for, in order.
#[wasm_bindgen(js_name = searchTitles)]
pub fn search_titles(title: &str) -> Vec<String> {
    lyrics::search_titles(title)
}

#[derive(Serialize)]
struct Found {
    text: String,
    instrumental: bool,
}

/// The best lrclib.net search result for a song of `duration` seconds, or null.
#[wasm_bindgen(js_name = bestLyrics)]
pub fn best_lyrics(results: JsValue, duration: f64) -> Result<JsValue, JsValue> {
    let results: Vec<serde_json::Value> = serde_wasm_bindgen::from_value(results).unwrap_or_default();
    let candidates: Vec<lyrics::Candidate> = results.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
    match lyrics::best_match(&candidates, duration) {
        Some(best) => {
            let text = best.synced_lyrics.as_deref().filter(|s| !s.is_empty()).or(best.plain_lyrics.as_deref()).unwrap_or("");
            to_js(&Found { text: text.trim().to_string(), instrumental: best.instrumental })
        }
        None => Ok(JsValue::NULL),
    }
}

/// Stereo samples (−1…1) as a 16-bit FLAC file.
#[wasm_bindgen(js_name = encodeFlac)]
pub fn encode_flac(left: Vec<f32>, right: Vec<f32>, sample_rate: u32) -> Result<Vec<u8>, JsValue> {
    audio_file::encode_flac(&audio_file::Stereo { left, right, sample_rate }).map_err(|e| JsValue::from_str(&e.to_string()))
}
