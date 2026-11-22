//! Reading one song file a packet at a time, as stereo frames, with
//! sample-accurate seeking.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, Decoder, DecoderOptions};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

use crate::Error;

/// How much to decode before a seek target and throw away (two MP3 frames).
const PRE_ROLL: u64 = 2304;

/// One stereo frame.
pub type Frame = [f32; 2];

pub struct FileDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    rate: u32,
    time_base: Option<TimeBase>,
    frames: Option<u64>,
    buffer: Option<SampleBuffer<f32>>,
    /// Frames still to throw away after a seek landed a little early.
    skip: u64,
}

fn failed(error: DecodeError) -> Error {
    Error(format!("This song could not be played: {error}"))
}

impl FileDecoder {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let file = File::open(path).map_err(|e| Error(format!("Could not open the song: {e}")))?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        // Gapless: trims the encoder's padding from MP3s, as browsers do.
        let options = FormatOptions { enable_gapless: true, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &options, &MetadataOptions::default())
            .map_err(failed)?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| Error("This file has no audio in it.".into()))?;
        let params = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).map_err(failed)?;
        Ok(Self {
            track_id: track.id,
            rate: params.sample_rate.unwrap_or(44_100),
            time_base: params.time_base,
            frames: params.n_frames,
            format,
            decoder,
            buffer: None,
            skip: 0,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.rate
    }

    /// The song's length in frames, if the file says.
    pub fn frames(&self) -> Option<u64> {
        self.frames
    }

    /// A position in the file's own time units, in frames.
    fn ts_to_frames(&self, ts: u64) -> u64 {
        match self.time_base {
            Some(tb) => {
                let time = tb.calc_time(ts);
                (time.seconds as f64 * self.rate as f64 + time.frac * self.rate as f64).round() as u64
            }
            None => ts,
        }
    }

    /// Decode the next packet onto the end of `out`. Returns `false` at the
    /// end of the song.
    pub fn next(&mut self, out: &mut Vec<Frame>) -> Result<bool, Error> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(DecodeError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
                Err(DecodeError::ResetRequired) => return Ok(false),
                Err(e) => return Err(failed(e)),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(DecodeError::DecodeError(_)) => continue, // skip a damaged frame, like players do
                Err(e) => return Err(failed(e)),
            };
            let spec = *decoded.spec();
            let channels = spec.channels.count().max(1);
            if self.buffer.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
                self.buffer = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
            }
            let buffer = self.buffer.as_mut().unwrap();
            buffer.copy_interleaved_ref(decoded);
            let mut frames = buffer.samples().chunks_exact(channels);
            let skip = (self.skip as usize).min(frames.len());
            self.skip -= skip as u64;
            for frame in frames.by_ref().skip(skip) {
                out.push([frame[0], if channels > 1 { frame[1] } else { frame[0] }]);
            }
            return Ok(true);
        }
    }

    /// Jump to a frame. The next [`next`](Self::next) starts exactly there.
    pub fn seek(&mut self, frame: u64) -> Result<(), Error> {
        // Start a little earlier and throw that part away: MP3 frames borrow
        // bits from the ones before them, so the first frame after a jump
        // would otherwise come out garbled (a click).
        let from = frame.saturating_sub(PRE_ROLL);
        let time = Time::new(from / self.rate as u64, (from % self.rate as u64) as f64 / self.rate as f64);
        let seeked = self
            .format
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) })
            .map_err(failed)?;
        self.decoder.reset();
        // Formats land on a packet boundary at or before the wanted frame.
        self.skip = frame.saturating_sub(self.ts_to_frames(seeked.actual_ts));
        Ok(())
    }
}
