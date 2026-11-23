//! Lewisis' Music — everything that does not need a window or a sound card:
//! the library, playlists, settings, song info, covers, genres and lyrics.
//!
//! The files on disk use exactly the same layout and JSON as the Python version
//! of the player (`library.json`, `playlists.json`, `settings.json`,
//! `lyrics/<id>.json`, `music/`, `covers/`, `stems/`), so an existing `data`
//! folder can be used as it is.

pub mod audio_file;
pub mod genres;
pub mod lyrics;
pub mod metadata;
pub mod migrate;
pub mod pictures;
pub mod priority;
pub mod queue;
pub mod separate;
pub mod store;

pub use store::{Playlist, Settings, Store, Track};

/// Errors shown to the listener. The messages are the same ones the Python
/// version sends, so the interface reads them out unchanged.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Something asked for does not exist ("Track not found").
    #[error("{0}")]
    NotFound(String),
    /// The request itself can't be carried out ("A song needs a title.").
    #[error("{0}")]
    Invalid(String),
    #[error("Could not read or write a file: {0}")]
    Io(#[from] std::io::Error),
    #[error("A saved file is damaged: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn not_found(what: &str) -> Self {
        Error::NotFound(format!("{what} not found"))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Error::Invalid(message.into())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
