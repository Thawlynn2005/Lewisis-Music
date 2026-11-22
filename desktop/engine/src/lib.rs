//! The audio engine of Lewisis' Music: everything between a song file and the
//! speakers — decoding, the vocals / music mix, speed, reverb and volume.
//! It produces stereo samples; the app hands them to Rodio / CPAL.

pub mod decoder;
pub mod engine;
pub mod feeder;
pub mod resample;
pub mod reverb;
pub mod stretch;

/// A problem to show the listener.
#[derive(Debug, Clone)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub use engine::{Engine, Renderer};
pub use reverb::Kind as ReverbKind;
