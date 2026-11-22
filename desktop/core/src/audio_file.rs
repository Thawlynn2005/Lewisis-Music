//! Whole-file audio helpers: decode any supported song to stereo samples,
//! change its sample rate, and save stereo audio as 16-bit FLAC.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::{Error, Result};

/// Stereo audio held in memory: one vector per channel.
#[derive(Debug, Clone, Default)]
pub struct Stereo {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub sample_rate: u32,
}

impl Stereo {
    pub fn frames(&self) -> usize {
        self.left.len()
    }
}

fn decode_error(error: DecodeError) -> Error {
    Error::invalid(format!("This song could not be decoded: {error}"))
}

/// Decode a whole song. Mono becomes two identical channels; more than two
/// channels keep the first two (as the Python version did).
pub fn decode(path: &Path) -> Result<Stereo> {
    let file = File::open(path)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(decode_error)?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| Error::invalid("This file has no audio in it."))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(decode_error)?;

    let mut out = Stereo { sample_rate: track.codec_params.sample_rate.unwrap_or(44_100), ..Default::default() };
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(DecodeError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(DecodeError::ResetRequired) => break,
            Err(e) => return Err(decode_error(e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(DecodeError::DecodeError(_)) => continue, // skip a damaged frame, like players do
            Err(e) => return Err(decode_error(e)),
        };
        let spec = *decoded.spec();
        out.sample_rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let buf = buffer.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if buf.capacity() < decoded.capacity() * channels {
            *buf = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks_exact(channels) {
            out.left.push(frame[0]);
            out.right.push(if channels > 1 { frame[1] } else { frame[0] });
        }
    }
    if out.left.is_empty() {
        return Err(Error::invalid("The audio file is empty."));
    }
    Ok(out)
}

/// Change the sample rate (high-quality FFT resampling).
pub fn resample(audio: Stereo, rate: u32) -> Result<Stereo> {
    use rubato::audioadapter_buffers::direct::InterleavedSlice;
    use rubato::{Fft, FixedSync, Resampler};

    if audio.sample_rate == rate || audio.frames() == 0 {
        return Ok(Stereo { sample_rate: rate, ..audio });
    }
    let failed = |e: &dyn std::fmt::Display| Error::invalid(format!("Could not change the sample rate: {e}"));
    let frames = audio.frames();
    let interleaved: Vec<f32> = audio.left.iter().zip(&audio.right).flat_map(|(l, r)| [*l, *r]).collect();
    let mut resampler =
        Fft::<f32>::new(audio.sample_rate as usize, rate as usize, 1024, 2, FixedSync::Both).map_err(|e| failed(&e))?;
    let capacity = resampler.process_all_needed_output_len(frames);
    let mut output = vec![0.0f32; capacity * 2];
    let input = InterleavedSlice::new(&interleaved, 2, frames).map_err(|e| failed(&e))?;
    let mut output_adapter = InterleavedSlice::new_mut(&mut output, 2, capacity).map_err(|e| failed(&e))?;
    let (_, produced) =
        resampler.process_all_into_buffer(&input, &mut output_adapter, frames, None).map_err(|e| failed(&e))?;
    let mut out = Stereo { sample_rate: rate, left: Vec::with_capacity(produced), right: Vec::with_capacity(produced) };
    for frame in output[..produced * 2].as_chunks::<2>().0 {
        out.left.push(frame[0]);
        out.right.push(frame[1]);
    }
    Ok(out)
}

/// flacenc records the (shorter) last block as the stream's minimum block
/// size, but the FLAC format says that field leaves the last block out; strict
/// readers (Symphonia, which plays the stems) then refuse the file. Every
/// block but the last has the maximum size, so make the minimum equal to it.
fn fix_min_block_size(bytes: &mut [u8]) {
    // "fLaC", then the STREAMINFO block header (type 0), then min/max block size.
    if bytes.len() >= 12 && &bytes[..4] == b"fLaC" && bytes[4] & 0x7f == 0 {
        let (min, max) = (8..10, 10..12);
        let max_size = [bytes[max.start], bytes[max.start + 1]];
        bytes[min].copy_from_slice(&max_size);
    }
}

/// Save stereo audio as a 16-bit FLAC file (written to a temporary name first,
/// then moved into place, so a half-written file is never left behind).
pub fn write_flac(path: &Path, audio: &Stereo) -> Result<()> {
    use flacenc::bitsink::ByteSink;
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let to_i16 = |s: f32| (s.clamp(-1.0, 1.0) * 32767.0).round() as i32;
    let samples: Vec<i32> = audio.left.iter().zip(&audio.right).flat_map(|(l, r)| [to_i16(*l), to_i16(*r)]).collect();
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| Error::invalid(format!("FLAC settings: {e:?}")))?;
    let source = flacenc::source::MemSource::from_samples(&samples, 2, 16, audio.sample_rate as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| Error::invalid(format!("Could not save the FLAC file: {e:?}")))?;
    let mut sink = ByteSink::new();
    stream.write(&mut sink).map_err(|e| Error::invalid(format!("Could not save the FLAC file: {e:?}")))?;
    let mut bytes = sink.as_slice().to_vec();
    fix_min_block_size(&mut bytes);
    let part = path.with_extension("flac.part");
    std::fs::write(&part, &bytes)?;
    std::fs::rename(&part, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_flac_reads_back_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stem.flac");
        // Not a whole number of blocks, so the last block is short.
        let n = 4096 * 3 + 1000;
        let wave: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        let audio = Stereo { left: wave.clone(), right: wave.iter().map(|v| -v).collect(), sample_rate: 44_100 };
        write_flac(&path, &audio).unwrap();
        let back = decode(&path).unwrap();
        assert_eq!(back.frames(), n);
        assert_eq!(back.sample_rate, 44_100);
        let worst = back.left.iter().zip(&wave).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(worst < 1e-4, "worst {worst}");
    }
}
