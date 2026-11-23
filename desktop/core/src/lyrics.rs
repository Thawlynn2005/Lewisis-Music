//! Lyrics: reading them (timed LRC or plain), saving the listener's own, and
//! deciding what the lyrics page shows.
//!
//! Where lyrics come from, in this order:
//!   1. lyrics the listener saved for the song (pasted in, or found online),
//!   2. lyrics stored inside the song file itself,
//!   3. an online lookup at lrclib.net — only when the listener asks for it
//!      (that part lives in the app, which owns the network).
//!
//! Timed lyrics use the LRC format: "[01:23.45] words", one line per timestamp.

#[cfg(feature = "native")]
use std::fs;
#[cfg(feature = "native")]
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
use crate::{Error, Result};

/// The longest lyrics that are kept, in characters.
pub const MAX_CHARS: usize = 200_000;

static STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]").unwrap());
// Per-word times in "enhanced" LRC.
static WORD_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>").unwrap());
// [ar:Artist], [ti:Title], ...
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[[A-Za-z#][A-Za-z]*:[^\]]*\]$").unwrap());
static OFFSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\[offset:\s*([+-]?\d+)\s*\]$").unwrap());
// "(Official Video)", "[Live]" and the like, removed for a second search attempt.
static BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[(\[{][^)\]}]*[)\]}]").unwrap());

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    /// Seconds into the song, for timed lyrics.
    pub time: Option<f64>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Parsed {
    pub synced: bool,
    pub lines: Vec<Line>,
}

/// Turn raw lyrics into lines, timed if most of them carry a timestamp.
pub fn parse(text: &str) -> Parsed {
    let mut timed: Vec<(f64, String)> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    let mut offset = 0.0;
    for raw in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let line = raw.trim();
        if let Some(found) = OFFSET.captures(line) {
            offset = found[1].parse::<f64>().unwrap_or(0.0) / 1000.0;
            continue;
        }
        if META.is_match(line) {
            continue;
        }
        let mut stamps = Vec::new();
        let mut rest = line;
        while let Some(found) = STAMP.captures(rest) {
            let minutes: f64 = found[1].parse().unwrap_or(0.0);
            let seconds: f64 = found[2].parse().unwrap_or(0.0);
            let fraction = found.get(3).map_or(0.0, |f| format!("0.{}", f.as_str()).parse().unwrap_or(0.0));
            stamps.push(minutes * 60.0 + seconds + fraction);
            rest = rest[found.get(0).unwrap().end()..].trim_start();
        }
        let words = WORD_STAMP.replace_all(rest, "").trim().to_string();
        for stamp in &stamps {
            timed.push(((stamp - offset).max(0.0), words.clone()));
        }
        plain.push(words);
    }

    let worded = plain.iter().filter(|line| !line.is_empty()).count();
    if timed.len() >= 2 && timed.len() as f64 >= worded as f64 / 2.0 {
        timed.sort_by(|a, b| a.0.total_cmp(&b.0)); // stable, like Python's sort
        let lines = timed
            .into_iter()
            .map(|(time, text)| Line { time: Some((time * 100.0).round() / 100.0), text })
            .collect();
        return Parsed { synced: true, lines };
    }

    // Collapse runs of blank lines into one verse break.
    let mut lines: Vec<Line> = Vec::new();
    let mut blank = true;
    for words in plain {
        if !words.is_empty() {
            lines.push(Line { time: None, text: words });
            blank = false;
        } else if !blank {
            lines.push(Line { time: None, text: String::new() });
            blank = true;
        }
    }
    while lines.last().is_some_and(|line| line.text.is_empty()) {
        lines.pop();
    }
    Parsed { synced: false, lines }
}

/// What is saved for one song in `lyrics/<id>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// "manual", "online" or "removed".
    pub source: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub instrumental: bool,
}

/// Saved lyrics, one small JSON file per song.
#[cfg(feature = "native")]
pub struct LyricsStore {
    folder: PathBuf,
}

#[cfg(feature = "native")]
impl LyricsStore {
    pub fn new(folder: impl Into<PathBuf>) -> Result<Self> {
        let folder = folder.into();
        fs::create_dir_all(&folder)?;
        Ok(Self { folder })
    }

    fn file(&self, track_id: &str) -> PathBuf {
        self.folder.join(format!("{track_id}.json"))
    }

    pub fn load(&self, track_id: &str) -> Option<Saved> {
        let text = fs::read_to_string(self.file(track_id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, track_id: &str, source: &str, text: &str, instrumental: bool) -> Result<()> {
        let saved = Saved {
            source: source.to_string(),
            text: text.chars().take(MAX_CHARS).collect(),
            instrumental,
        };
        crate::store::write_json_atomic(&self.file(track_id), &saved)
    }

    /// Forget a song's lyrics entirely (the song was deleted).
    pub fn forget(&self, track_id: &str) {
        let _ = fs::remove_file(self.file(track_id));
    }

    /// Remember that the listener removed this song's lyrics: none are shown
    /// (not even the ones inside the file) until some are pasted or searched for.
    pub fn remove(&self, track_id: &str) -> Result<()> {
        self.save(track_id, "removed", "", false)
    }
}

/// What the lyrics page should show for one song (the same shape the Python
/// version sends to the interface).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub found: bool,
    pub source: Option<String>,
    pub instrumental: bool,
    pub synced: bool,
    pub lines: Vec<Line>,
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
}

#[cfg(feature = "native")]
pub fn describe(store: &LyricsStore, track_id: &str, audio_path: &Path) -> View {
    let saved = store.load(track_id);
    if let Some(saved) = &saved
        && saved.source == "removed"
    {
        return View {
            found: false,
            source: None,
            instrumental: false,
            synced: false,
            lines: vec![],
            text: String::new(),
            removed: true,
        };
    }
    let (source, text, instrumental) = match saved {
        Some(saved) => (saved.source, saved.text, saved.instrumental),
        None => ("file".to_string(), crate::metadata::embedded_lyrics(audio_path), false),
    };
    let parsed = parse(&text);
    let found = instrumental || !parsed.lines.is_empty();
    View {
        found,
        source: found.then_some(source),
        instrumental,
        synced: parsed.synced,
        lines: parsed.lines,
        text: if found { text } else { String::new() },
        removed: false,
    }
}

/// One result from an online lyrics search.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub instrumental: bool,
}

/// The best search result for a song of `duration` seconds: the closest in
/// length, preferring timed lyrics. A result more than 12 s off is a different
/// recording, whose timings would be wrong, so it is skipped.
pub fn best_match(results: &[Candidate], duration: f64) -> Option<&Candidate> {
    let usable = |c: &&Candidate| {
        c.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty())
            || c.plain_lyrics.as_deref().is_some_and(|s| !s.is_empty())
            || c.instrumental
    };
    let mut best: Option<(&Candidate, f64)> = None;
    for candidate in results.iter().filter(usable) {
        let gap = if duration > 0.0 { (candidate.duration.unwrap_or(0.0) - duration).abs() } else { 0.0 };
        if duration > 0.0 && gap > 12.0 {
            continue;
        }
        let timed = candidate.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty());
        let score = gap + if timed { 0.0 } else { 6.0 };
        if best.is_none_or(|(_, best_score)| score < best_score) {
            best = Some((candidate, score));
        }
    }
    best.map(|(candidate, _)| candidate)
}

/// The titles to try, in order: as it is, then without "(Official Video)" etc.
pub fn search_titles(title: &str) -> Vec<String> {
    let title = title.trim();
    let mut titles = vec![title.to_string()];
    let cleaned = BRACKETS.replace_all(title, "").trim().to_string();
    if !cleaned.is_empty() && cleaned != title {
        titles.push(cleaned);
    }
    titles
}

// ---- online lookup ----------------------------------------------------------

#[cfg(feature = "native")]
const LRCLIB: &str = "https://lrclib.net/api";
/// Deliberately generic: says nothing about the listener.
#[cfg(feature = "native")]
const USER_AGENT: &str = "LocalMusicPlayer/1.0";

/// What an online lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub text: String,
    pub instrumental: bool,
}

/// Search lrclib.net for a song's lyrics. `Ok(None)` means nothing matched;
/// `Err` means the service could not be reached. Blocking: run it off the
/// interface thread.
#[cfg(feature = "native")]
pub fn lookup(title: &str, artist: &str, duration: f64) -> Result<Option<Found>> {
    let (title, artist) = (title.trim(), artist.trim());
    if title.is_empty() {
        return Ok(None);
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(12)))
        .user_agent(USER_AGENT)
        .http_status_as_error(false)
        .build()
        .into();
    for name in search_titles(title) {
        let mut request = agent.get(format!("{LRCLIB}/search")).header("Accept", "application/json");
        request = if artist.is_empty() {
            request.query("q", &name)
        } else {
            request.query("track_name", &name).query("artist_name", artist)
        };
        let unreachable = |_| Error::invalid("Could not reach the lyrics service. Check your internet connection.");
        let mut response = request.call().map_err(unreachable)?;
        let status = response.status().as_u16();
        if status == 404 {
            continue;
        }
        if status >= 400 {
            return Err(Error::invalid(format!("The lyrics service answered with an error ({status}).")));
        }
        let results: Vec<serde_json::Value> = response.body_mut().read_json().map_err(unreachable)?;
        // Skip anything that isn't a proper result rather than failing.
        let results: Vec<Candidate> = results.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
        if let Some(best) = best_match(&results, duration) {
            let text = best.synced_lyrics.as_deref().filter(|s| !s.is_empty()).or(best.plain_lyrics.as_deref()).unwrap_or("");
            return Ok(Some(Found { text: text.trim().to_string(), instrumental: best.instrumental }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(time: f64, text: &str) -> Line {
        Line { time: Some(time), text: text.into() }
    }
    fn plain(text: &str) -> Line {
        Line { time: None, text: text.into() }
    }

    #[test]
    fn timed_lyrics_match_the_python_version() {
        let sample = "[ti:Test]\n[offset:+500]\n[00:01.00]first line\n[00:03.50][00:09.00]chorus words\n[00:06.25]<00:06.25>word <00:06.80>by word\n\n[00:12]\n";
        let parsed = parse(sample);
        assert!(parsed.synced);
        assert_eq!(
            parsed.lines,
            vec![
                line(0.5, "first line"),
                line(3.0, "chorus words"),
                line(5.75, "word by word"),
                line(8.5, "chorus words"),
                line(11.5, ""),
            ]
        );
    }

    #[test]
    fn plain_lyrics_keep_one_break_between_verses() {
        let parsed = parse("verse one\nline two\n\n\nverse two\n");
        assert!(!parsed.synced);
        assert_eq!(parsed.lines, vec![plain("verse one"), plain("line two"), plain(""), plain("verse two")]);
        assert_eq!(parse("").lines, vec![]);
    }

    #[test]
    fn removed_lyrics_stay_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = LyricsStore::new(dir.path()).unwrap();
        let song = dir.path().join("none.mp3");
        store.save("a", "online", "[00:01.00]one\n[00:02.00]two", false).unwrap();
        assert_eq!(describe(&store, "a", &song).source.as_deref(), Some("online"));
        store.remove("a").unwrap();
        let view = describe(&store, "a", &song);
        assert!(!view.found && view.removed);
        store.save("a", "manual", "typed again", false).unwrap();
        assert_eq!(describe(&store, "a", &song).source.as_deref(), Some("manual"));
    }

    #[test]
    fn picks_the_closest_timed_match() {
        let results = vec![
            Candidate { duration: Some(300.0), synced_lyrics: Some("[00:01.00]wrong".into()), ..Default::default() },
            Candidate { duration: Some(201.0), plain_lyrics: Some("plain only".into()), ..Default::default() },
            Candidate { duration: Some(203.0), synced_lyrics: Some("[00:01.00]right".into()), ..Default::default() },
            Candidate { duration: Some(200.0), ..Default::default() },
        ];
        let best = best_match(&results, 200.0).unwrap();
        assert_eq!(best.synced_lyrics.as_deref(), Some("[00:01.00]right"));
        assert_eq!(search_titles("Song (Official Video)"), ["Song (Official Video)", "Song"]);
    }
}
