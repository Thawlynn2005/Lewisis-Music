//! A background thread that decodes a song a couple of seconds ahead of what
//! is playing, so the audio thread never waits on the disk or the decoder.
//!
//! A song is one file, or two played in lock-step (the vocals and the
//! instrumental from Separate Audio). Frames carry both as four channels:
//! layer one's left/right, then layer two's (silent when there is only one).
//!
//! Seeking and the A–B loop happen here too. Every chunk knows which frame of
//! the song it starts at, so a loop's jump back is seamless and the position
//! the audio thread reports is always exact.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::Error;
use crate::decoder::{FileDecoder, Frame};

/// Two stereo layers side by side.
pub type Frame4 = [f32; 4];

/// How far ahead to decode, in seconds.
const AHEAD_SECONDS: f64 = 2.0;
/// Frames per chunk.
const CHUNK: usize = 4096;

/// A run of frames that starts at a known frame of the song.
#[derive(Debug)]
pub struct Chunk {
    pub start: u64,
    pub frames: Vec<Frame4>,
}

/// The repeating part of a song: from `start` to `end` (`None` = the end of
/// the song), in frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopRegion {
    pub start: u64,
    pub end: Option<u64>,
}

#[derive(Default)]
struct Ring {
    chunks: VecDeque<Chunk>,
    /// Frames waiting in `chunks`.
    buffered: usize,
    /// Changes on every seek, so the reader knows to forget its place.
    generation: u64,
    /// Where the next decoded frame will be.
    cursor: u64,
    /// The decoder reached the end of the song (and there is no loop).
    ended: bool,
    error: Option<String>,
    /// The audio thread has drained the ring and wants more.
    hungry: bool,
}

struct Shared {
    ring: Mutex<Ring>,
    /// Wakes the decoder thread when the reader takes frames.
    room: Condvar,
}

enum Command {
    /// Go to a frame; the ring was already emptied for this generation.
    Seek(u64, u64),
    Loop(Option<LoopRegion>),
    Stop,
}

/// The control side, held by the engine.
pub struct Feeder {
    shared: Arc<Shared>,
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
    rate: u32,
    frames: Option<u64>,
    layers: usize,
}

impl Feeder {
    /// Open one or two files (two must have the same sample rate) and start
    /// decoding from `start` (in frames).
    pub fn open(paths: &[PathBuf], start: u64, region: Option<LoopRegion>) -> Result<(Self, Reader), Error> {
        assert!(matches!(paths.len(), 1 | 2), "a song is one or two files");
        let mut decoders = paths.iter().map(|p| FileDecoder::open(p)).collect::<Result<Vec<_>, _>>()?;
        let rate = decoders[0].sample_rate();
        if decoders.iter().any(|d| d.sample_rate() != rate) {
            return Err(Error("The two halves of this song don't match; separate it again.".into()));
        }
        let frames = decoders.iter().filter_map(|d| d.frames()).max();
        if start > 0 {
            for decoder in decoders.iter_mut() {
                decoder.seek(start)?;
            }
        }
        let shared = Arc::new(Shared {
            ring: Mutex::new(Ring { cursor: start, ..Default::default() }),
            room: Condvar::new(),
        });
        let (commands, receiver) = mpsc::channel();
        let ahead = (rate as f64 * AHEAD_SECONDS) as usize;
        let worker = Worker {
            shared: shared.clone(),
            layers: decoders.into_iter().map(|d| Layer { decoder: d, pending: Vec::new(), ended: false }).collect(),
            cursor: start,
            region,
            ahead,
            generation: 0,
        };
        let thread = std::thread::Builder::new()
            .name("song decoder".into())
            .spawn(move || worker.run(receiver))
            .map_err(|e| Error(format!("Could not start the decoder: {e}")))?;
        let layers = paths.len();
        let reader = Reader { shared: shared.clone(), generation: 0, offset: 0, position: start };
        Ok((Self { shared, commands, thread: Some(thread), rate, frames, layers }, reader))
    }

    pub fn sample_rate(&self) -> u32 {
        self.rate
    }

    pub fn frames(&self) -> Option<u64> {
        self.frames
    }

    pub fn layers(&self) -> usize {
        self.layers
    }

    pub fn seek(&self, frame: u64) {
        // The ring is emptied right away, so nothing old plays after a seek.
        let generation = {
            let mut ring = self.shared.ring.lock().unwrap();
            ring.chunks.clear();
            ring.buffered = 0;
            ring.generation += 1;
            ring.cursor = frame;
            ring.ended = false;
            ring.error = None;
            ring.generation
        };
        let _ = self.commands.send(Command::Seek(frame, generation));
        self.shared.room.notify_all();
    }

    pub fn set_loop(&self, region: Option<LoopRegion>) {
        let _ = self.commands.send(Command::Loop(region));
        self.shared.room.notify_all();
    }

    /// The decoder failed (a damaged file); the message to show.
    pub fn error(&self) -> Option<String> {
        self.shared.ring.lock().unwrap().error.clone()
    }
}

impl Drop for Feeder {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        self.shared.room.notify_all();
        if let Some(thread) = self.thread.take() {
            // Not joined: the audio thread may be the one dropping this, and
            // the decoder notices the Stop within a few milliseconds.
            drop(thread);
        }
    }
}

/// What the reader found when it asked for frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Supply {
    /// Some frames (maybe fewer than asked, if the decoder is behind).
    Frames(usize),
    /// The song is over.
    Ended,
}

/// The audio-thread side: takes decoded frames in order.
pub struct Reader {
    shared: Arc<Shared>,
    generation: u64,
    /// How far into the front chunk we are.
    offset: usize,
    /// The song frame of the next frame we hand out.
    position: u64,
}

impl Reader {
    /// The song frame the next frame comes from.
    pub fn position(&self) -> u64 {
        self.position
    }

    /// Whether a seek happened since the last read (then the position is
    /// already the new one). Call before reading.
    pub fn jumped(&mut self) -> bool {
        let ring = self.shared.ring.lock().unwrap();
        if ring.generation == self.generation {
            return false;
        }
        self.generation = ring.generation;
        self.offset = 0;
        self.position = ring.cursor;
        true
    }

    /// Fill as much of `out` as is ready, and `marks` with the song frame
    /// each one came from.
    pub fn read(&mut self, out: &mut [Frame4], marks: &mut [u64]) -> Supply {
        let mut ring = self.shared.ring.lock().unwrap();
        if ring.generation != self.generation {
            self.generation = ring.generation;
            self.offset = 0;
            self.position = ring.cursor;
        }
        let mut filled = 0;
        while filled < out.len() {
            let Some(front) = ring.chunks.front() else { break };
            if self.offset == 0 {
                self.position = front.start;
            }
            let take = (front.frames.len() - self.offset).min(out.len() - filled);
            out[filled..filled + take].copy_from_slice(&front.frames[self.offset..self.offset + take]);
            for (i, mark) in marks[filled..filled + take].iter_mut().enumerate() {
                *mark = front.start + (self.offset + i) as u64;
            }
            filled += take;
            self.offset += take;
            self.position = front.start + self.offset as u64;
            if self.offset == front.frames.len() {
                ring.chunks.pop_front();
                self.offset = 0;
                if let Some(next) = ring.chunks.front() {
                    self.position = next.start;
                }
            }
        }
        ring.buffered = ring.buffered.saturating_sub(filled);
        if filled == 0 && ring.chunks.is_empty() && (ring.ended || ring.error.is_some()) {
            return Supply::Ended;
        }
        if ring.chunks.is_empty() {
            ring.hungry = true;
        }
        drop(ring);
        self.shared.room.notify_one();
        Supply::Frames(filled)
    }
}

struct Layer {
    decoder: FileDecoder,
    pending: Vec<Frame>,
    ended: bool,
}

struct Worker {
    shared: Arc<Shared>,
    layers: Vec<Layer>,
    /// The song frame the next pushed chunk starts at.
    cursor: u64,
    region: Option<LoopRegion>,
    ahead: usize,
    /// The ring generation this worker is decoding for; anything decoded
    /// for an older one (a seek came in meanwhile) is thrown away.
    generation: u64,
}

impl Worker {
    fn run(mut self, commands: Receiver<Command>) {
        loop {
            // Take every waiting command first.
            loop {
                match commands.try_recv() {
                    Ok(Command::Stop) | Err(mpsc::TryRecvError::Disconnected) => return,
                    Ok(command) => self.apply(command),
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            let wanted = {
                let ring = self.shared.ring.lock().unwrap();
                ring.buffered < self.ahead && !ring.ended && ring.error.is_none()
            };
            if !wanted {
                // Sleep until the reader makes room or a command arrives.
                let ring = self.shared.ring.lock().unwrap();
                let _ = self.shared.room.wait_timeout(ring, Duration::from_millis(25));
                match commands.recv_timeout(Duration::from_millis(1)) {
                    Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                    Ok(command) => self.apply(command),
                    Err(RecvTimeoutError::Timeout) => {}
                }
                continue;
            }
            if let Err(error) = self.decode_chunk() {
                let mut ring = self.shared.ring.lock().unwrap();
                if ring.generation == self.generation {
                    ring.error = Some(error.0);
                }
            }
        }
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Seek(frame, generation) => {
                // The ring was already cleared by `Feeder::seek`.
                self.generation = generation;
                if let Err(error) = self.jump(frame) {
                    self.shared.ring.lock().unwrap().error = Some(error.0);
                }
            }
            Command::Loop(region) => {
                self.region = region;
                let Some(LoopRegion { start, end: Some(end) }) = region else { return };
                // If the new end is inside what is already decoded, cut it
                // there and carry on from the start dot.
                let mut ring = self.shared.ring.lock().unwrap();
                if ring.generation != self.generation {
                    return; // a seek is on its way; it starts afresh anyway
                }
                let first = ring.chunks.front().map(|c| c.start);
                let Some(first) = first else { return };
                if end <= first || end >= self.cursor {
                    return; // not in the decoded part (or already behind us)
                }
                let mut kept = VecDeque::new();
                let mut buffered = 0;
                while let Some(mut chunk) = ring.chunks.pop_front() {
                    let chunk_end = chunk.start + chunk.frames.len() as u64;
                    if chunk.start >= end || chunk_end < chunk.start {
                        break;
                    }
                    if chunk_end > end && chunk.start < end {
                        chunk.frames.truncate((end - chunk.start) as usize);
                    }
                    buffered += chunk.frames.len();
                    kept.push_back(chunk);
                    if chunk_end >= end {
                        break;
                    }
                }
                ring.chunks = kept;
                ring.buffered = buffered;
                drop(ring);
                if let Err(error) = self.jump(start) {
                    self.shared.ring.lock().unwrap().error = Some(error.0);
                }
            }
            Command::Stop => {}
        }
    }

    /// Move every layer to `frame`; the next chunk starts there.
    fn jump(&mut self, frame: u64) -> Result<(), Error> {
        for layer in self.layers.iter_mut() {
            layer.decoder.seek(frame)?;
            layer.pending.clear();
            layer.ended = false;
        }
        self.cursor = frame;
        Ok(())
    }

    fn decode_chunk(&mut self) -> Result<(), Error> {
        for layer in self.layers.iter_mut() {
            while !layer.ended && layer.pending.len() < CHUNK {
                if !layer.decoder.next(&mut layer.pending)? {
                    layer.ended = true;
                }
            }
        }
        let all_ended = self.layers.iter().all(|l| l.ended);
        let longest = self.layers.iter().map(|l| l.pending.len()).max().unwrap_or(0);
        let mut count = longest.min(CHUNK);
        // Stop at the loop's end dot.
        let loop_end = self.region.and_then(|r| r.end);
        if let Some(end) = loop_end
            && self.cursor < end
        {
            count = count.min((end - self.cursor) as usize);
        }

        let mut frames = Vec::with_capacity(count);
        for i in 0..count {
            let mut frame = [0.0; 4];
            for (l, layer) in self.layers.iter().enumerate() {
                if let Some(f) = layer.pending.get(i) {
                    frame[l * 2] = f[0];
                    frame[l * 2 + 1] = f[1];
                }
            }
            frames.push(frame);
        }
        for layer in self.layers.iter_mut() {
            let n = count.min(layer.pending.len());
            layer.pending.drain(..n);
        }
        let start = self.cursor;
        self.cursor += count as u64;

        let reached_loop_end = loop_end.is_some_and(|end| start < end && self.cursor >= end);
        let reached_song_end = all_ended && self.layers.iter().all(|l| l.pending.is_empty());
        let wrap = self.region.filter(|_| reached_loop_end || reached_song_end);

        {
            let mut ring = self.shared.ring.lock().unwrap();
            if ring.generation != self.generation {
                return Ok(()); // a seek came in while decoding: throw this away
            }
            if count > 0 {
                ring.chunks.push_back(Chunk { start, frames });
                ring.buffered += count;
            }
            ring.hungry = false;
            if reached_song_end && wrap.is_none() {
                ring.ended = true;
            }
        }
        if let Some(region) = wrap {
            self.jump(region.start)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A 16-bit stereo WAV where every frame's left sample counts up (so a
    /// frame's value says where in the song it came from).
    fn counting_wav(dir: &std::path::Path, name: &str, frames: u32, rate: u32) -> PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        let data_len = frames * 4;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&rate.to_le_bytes()).unwrap();
        file.write_all(&(rate * 4).to_le_bytes()).unwrap();
        file.write_all(&4u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_len.to_le_bytes()).unwrap();
        for i in 0..frames {
            let value = (i % 30_000) as i16;
            file.write_all(&value.to_le_bytes()).unwrap();
            file.write_all(&(-value).to_le_bytes()).unwrap();
        }
        path
    }

    fn sample_of(frame: u64) -> f32 {
        (frame % 30_000) as f32 / 32768.0
    }

    /// Read until `n` frames arrive (waiting for the decoder thread).
    fn read_frames(reader: &mut Reader, n: usize) -> (Vec<Frame4>, Vec<u64>, bool) {
        let mut out = Vec::new();
        let mut positions = Vec::new();
        let mut buffer = [[0.0; 4]; 1000];
        let mut marks = [0u64; 1000];
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while out.len() < n {
            assert!(std::time::Instant::now() < deadline, "timed out");
            let want = (n - out.len()).min(buffer.len());
            positions.push(reader.position());
            match reader.read(&mut buffer[..want], &mut marks[..want]) {
                Supply::Frames(got) => out.extend_from_slice(&buffer[..got]),
                Supply::Ended => return (out, positions, true),
            }
            if out.len() < n {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        (out, positions, false)
    }

    #[test]
    fn plays_from_start_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let song = counting_wav(dir.path(), "a.wav", 20_000, 8_000);
        let (feeder, mut reader) = Feeder::open(&[song], 0, None).unwrap();
        assert_eq!(feeder.frames(), Some(20_000));
        let (frames, _, ended) = read_frames(&mut reader, 30_000);
        assert!(ended);
        assert_eq!(frames.len(), 20_000);
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(frame[0], sample_of(i as u64), "frame {i}");
            assert_eq!(frame[2], 0.0);
        }
    }

    #[test]
    fn seeking_lands_on_the_exact_frame() {
        let dir = tempfile::tempdir().unwrap();
        let song = counting_wav(dir.path(), "a.wav", 40_000, 8_000);
        let (feeder, mut reader) = Feeder::open(&[song], 12_345, None).unwrap();
        let (frames, _, _) = read_frames(&mut reader, 10);
        assert_eq!(frames[0][0], sample_of(12_345));
        feeder.seek(31_000);
        let (frames, _, _) = read_frames(&mut reader, 10);
        assert_eq!(frames[0][0], sample_of(31_000));
        assert_eq!(reader.position(), 31_010);
    }

    #[test]
    fn two_layers_play_together() {
        let dir = tempfile::tempdir().unwrap();
        let a = counting_wav(dir.path(), "vocals.wav", 10_000, 8_000);
        let b = counting_wav(dir.path(), "music.wav", 10_000, 8_000);
        let (_feeder, mut reader) = Feeder::open(&[a, b], 0, None).unwrap();
        let (frames, _, _) = read_frames(&mut reader, 9_000);
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(frame[0], frame[2], "frame {i}");
            assert_eq!(frame[1], frame[3]);
        }
    }

    #[test]
    fn loops_seamlessly() {
        let dir = tempfile::tempdir().unwrap();
        let song = counting_wav(dir.path(), "a.wav", 40_000, 8_000);
        let region = LoopRegion { start: 1_000, end: Some(6_000) };
        let (_feeder, mut reader) = Feeder::open(&[song], 0, Some(region)).unwrap();
        let (frames, _, ended) = read_frames(&mut reader, 20_000);
        assert!(!ended);
        let mut expected = 0u64;
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(frame[0], sample_of(expected), "frame {i}");
            expected += 1;
            if expected == 6_000 {
                expected = 1_000;
            }
        }
    }

    #[test]
    fn repeating_the_whole_song_never_ends() {
        let dir = tempfile::tempdir().unwrap();
        let song = counting_wav(dir.path(), "a.wav", 5_000, 8_000);
        let region = LoopRegion { start: 0, end: None };
        let (_feeder, mut reader) = Feeder::open(&[song], 0, Some(region)).unwrap();
        let (frames, _, ended) = read_frames(&mut reader, 16_000);
        assert!(!ended);
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(frame[0], sample_of(i as u64 % 5_000), "frame {i}");
        }
    }

    #[test]
    fn a_new_loop_end_cuts_what_was_decoded_ahead() {
        let dir = tempfile::tempdir().unwrap();
        let song = counting_wav(dir.path(), "a.wav", 40_000, 8_000);
        let (feeder, mut reader) = Feeder::open(&[song], 0, None).unwrap();
        let (_, _, _) = read_frames(&mut reader, 2_000);
        // Let it decode well past 5 000 first.
        std::thread::sleep(Duration::from_millis(100));
        feeder.set_loop(Some(LoopRegion { start: 500, end: Some(5_000) }));
        std::thread::sleep(Duration::from_millis(50));
        let (frames, _, _) = read_frames(&mut reader, 4_000);
        // 2 000..5 000, then back to 500.
        assert_eq!(frames[0][0], sample_of(2_000));
        assert_eq!(frames[2_999][0], sample_of(4_999));
        assert_eq!(frames[3_000][0], sample_of(500));
    }
}
