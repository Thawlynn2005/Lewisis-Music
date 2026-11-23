//! Migrate: bring in every song from a folder (and the folders inside it).
//! Songs are copied into the library; nothing in the chosen folder or already
//! in the library is changed, and songs already in the library are skipped.

use std::path::{Path, PathBuf};

use crate::Result;
use crate::store::{AUDIO_EXTENSIONS, Added, Store};

/// What a migration did.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Summary {
    /// Songs that were found in the folder.
    pub found: usize,
    pub added: usize,
    /// Already in the library.
    pub duplicates: usize,
    /// Could not be read (damaged files).
    pub failed: usize,
}

/// Whether a file is a song the library takes (MP3, WAV or FLAC).
pub fn is_song(path: &Path) -> bool {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

/// Every file under `folder` (and the folders inside it), in name order,
/// leaving out hidden files and folders (names starting with "."), as a
/// browser does when a folder is chosen. Folder links are not followed, so a
/// link loop can't trap it.
pub fn visible_files(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(path);
            } else if (kind.is_file() || kind.is_symlink()) && path.is_file() {
                files.push(path);
            }
        }
    }
    files.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    files
}

/// Every song file under `folder`, in name order (see [`visible_files`]).
pub fn find_songs(folder: &Path) -> Vec<PathBuf> {
    visible_files(folder).into_iter().filter(|p| is_song(p)).collect()
}

/// Copy every song under `folder` into the library. `progress` is told
/// (songs done, songs in all, the current file's name) and returns `false`
/// to stop early.
pub fn migrate(store: &Store, folder: &Path, mut progress: impl FnMut(usize, usize, &str) -> bool) -> Result<Summary> {
    let songs = find_songs(folder);
    let mut summary = Summary { found: songs.len(), ..Default::default() };
    let mut known = store.library_hashes()?;
    for (done, song) in songs.iter().enumerate() {
        let name = song.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !progress(done, songs.len(), &name) {
            break;
        }
        match store.add_file(song, &name, Some(&mut known)) {
            Ok(Added::Added(_)) => summary.added += 1,
            Ok(Added::Duplicate) => summary.duplicates += 1,
            Ok(Added::Rejected) | Err(_) => summary.failed += 1,
        }
    }
    progress(songs.len(), songs.len(), "");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn copies_new_songs_from_every_subfolder_and_skips_the_rest() {
        let library = tempfile::tempdir().unwrap();
        let store = Store::open(library.path()).unwrap();
        let existing = library.path().join("Already.mp3");
        fs::write(&existing, b"song-0").unwrap();
        store.add_file(&existing, "Already.mp3", None).unwrap();

        let folder = tempfile::tempdir().unwrap();
        let root = folder.path();
        fs::create_dir_all(root.join("Album/Disc 2")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("b - One.mp3"), b"song-1").unwrap();
        fs::write(root.join("Album/Two.FLAC"), b"song-2").unwrap();
        fs::write(root.join("Album/Disc 2/Three.wav"), b"song-3").unwrap();
        fs::write(root.join("Album/Same as one.mp3"), b"song-1").unwrap();
        fs::write(root.join("Album/Old copy.mp3"), b"song-0").unwrap();
        fs::write(root.join("Album/cover.jpg"), b"picture").unwrap();
        fs::write(root.join(".hidden/Secret.mp3"), b"song-9").unwrap();

        let mut seen = Vec::new();
        let summary = migrate(&store, root, |done, total, name| {
            seen.push((done, total, name.to_string()));
            true
        })
        .unwrap();
        assert_eq!((summary.found, summary.added, summary.duplicates, summary.failed), (5, 3, 2, 0));
        assert_eq!(seen.first().unwrap().1, 5);
        assert_eq!(seen.last().unwrap().0, 5);
        assert_eq!(store.tracks().unwrap().len(), 4);
        // The chosen folder is left exactly as it was.
        assert!(root.join("b - One.mp3").exists() && root.join("Album/Old copy.mp3").exists());

        // Running it again adds nothing.
        let again = migrate(&store, root, |_, _, _| true).unwrap();
        assert_eq!((again.added, again.duplicates), (0, 5));
    }
}
