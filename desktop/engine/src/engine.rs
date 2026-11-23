//! The player: [`Engine`] is held by the app and takes the listener's
//! commands; [`Renderer`] lives on the audio thread and makes the sound.
//!
//! ```text
//! song file(s) ─► feeder ─► [keep pitch: stretcher] ─► varispeed ─► vocals × a + music × b
//!                                                                     ─► reverb (dry/wet) ─► volume ─► speakers
//! ```
//! Every level change glides (30 ms, like the browser version's
//! `setTargetAtTime`), and play / pause / seek fade in and out over a few
//! milliseconds, so nothing ever clicks.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use crate::Error;
use crate::feeder::{Feeder, Frame4, LoopRegion, Reader, Supply};
use crate::resample::Resampler;
use crate::reverb::{self, Kind, Reverb};
use crate::stretch::Stretcher;

/// An `f32` that both threads can read and write.
#[derive(Default)]
struct AtomicF32(AtomicU32);
impl AtomicF32 {
    fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Relaxed))
    }
    fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Relaxed)
    }
}

/// What the listener has set; read by the audio thread every block.
struct Params {
    playing: AtomicBool,
    volume: AtomicF32,
    /// Layer gains: the vocals and the instruments in Separate Audio (one
    /// file plays as layer one at 1, layer two at 0).
    gain_a: AtomicF32,
    gain_b: AtomicF32,
    speed: AtomicF32,
    keep_pitch: AtomicBool,
    dry: AtomicF32,
    wet: AtomicF32,
}

/// What the audio thread reports back.
struct Status {
    /// The song frame now coming out of the speakers.
    position: AtomicU64,
    /// Counts songs that played to the end.
    ended: AtomicU64,
    playing: AtomicBool,
}

/// A loaded song, handed to the audio thread.
struct Song {
    reader: Reader,
    sample_rate: u32,
}

enum ToAudio {
    Song(Box<Song>),
    Unload,
    Reverb(Box<Reverb>),
}

/// Things the audio thread is done with, dropped on the app's side so the
/// audio thread never frees memory.
enum Trash {
    Song(#[allow(dead_code)] Box<Song>),
    Reverb(#[allow(dead_code)] Box<Reverb>),
}

/// The app's handle on the player.
pub struct Engine {
    params: Arc<Params>,
    status: Arc<Status>,
    to_audio: Sender<ToAudio>,
    trash: Receiver<Trash>,
    device_rate: u32,
    feeder: Option<Feeder>,
    song_rate: u32,
    song_frames: Option<u64>,
    reverb_kind: Kind,
    reverb_amount: f32,
    seen_ended: u64,
}

impl Engine {
    /// A player for a sound card running at `device_rate`. Hand the
    /// [`Renderer`] to the audio output.
    pub fn new(device_rate: u32) -> (Self, Renderer) {
        let params = Arc::new(Params {
            playing: AtomicBool::new(false),
            volume: AtomicF32::new(1.0),
            gain_a: AtomicF32::new(1.0),
            gain_b: AtomicF32::new(0.0),
            speed: AtomicF32::new(1.0),
            keep_pitch: AtomicBool::new(true),
            dry: AtomicF32::new(1.0),
            wet: AtomicF32::new(0.0),
        });
        let status =
            Arc::new(Status { position: AtomicU64::new(0), ended: AtomicU64::new(0), playing: AtomicBool::new(false) });
        let (to_audio, from_app) = mpsc::channel();
        let (to_trash, trash) = mpsc::channel();
        let mut first_reverb = Box::new(Reverb::new(device_rate));
        first_reverb.set_kind(Kind::default());
        let renderer = Renderer::new(device_rate, params.clone(), status.clone(), from_app, to_trash, first_reverb);
        let engine = Self {
            params,
            status,
            to_audio,
            trash,
            device_rate,
            feeder: None,
            song_rate: device_rate,
            song_frames: None,
            reverb_kind: Kind::default(),
            reverb_amount: 0.0,
            seen_ended: 0,
        };
        (engine, renderer)
    }

    fn empty_trash(&self) {
        while self.trash.try_recv().is_ok() {}
    }

    fn frames(&self, seconds: f64) -> u64 {
        (seconds.max(0.0) * self.song_rate as f64).round() as u64
    }

    /// Load a song (one file, or the vocals and instruments as two) and start
    /// at `start` seconds. Returns its length in seconds, if known.
    pub fn load(&mut self, files: &[PathBuf], start: f64, repeat: Option<(f64, Option<f64>)>) -> Result<Option<f64>, Error> {
        self.empty_trash();
        let rate = crate::decoder::FileDecoder::open(&files[0])?.sample_rate();
        let to_frames = |s: f64| (s.max(0.0) * rate as f64).round() as u64;
        let region = repeat.map(|(a, b)| LoopRegion { start: to_frames(a), end: b.map(to_frames) });
        let (feeder, reader) = Feeder::open(files, to_frames(start), region)?;
        self.song_rate = feeder.sample_rate();
        self.song_frames = feeder.frames();
        self.status.position.store(to_frames(start), Relaxed);
        let _ = self.to_audio.send(ToAudio::Song(Box::new(Song { reader, sample_rate: self.song_rate })));
        self.feeder = Some(feeder);
        self.seen_ended = self.status.ended.load(Relaxed);
        Ok(self.duration())
    }

    /// Stop and forget the song.
    pub fn unload(&mut self) {
        self.params.playing.store(false, Relaxed);
        let _ = self.to_audio.send(ToAudio::Unload);
        self.feeder = None;
        self.empty_trash();
    }

    pub fn has_song(&self) -> bool {
        self.feeder.is_some()
    }

    pub fn play(&self) {
        if self.feeder.is_some() {
            self.params.playing.store(true, Relaxed);
        }
    }

    pub fn pause(&self) {
        self.params.playing.store(false, Relaxed);
    }

    /// Whether sound is coming out (false once a song has ended).
    pub fn is_playing(&self) -> bool {
        self.params.playing.load(Relaxed) && self.status.playing.load(Relaxed)
    }

    pub fn seek(&self, seconds: f64) {
        if let Some(feeder) = &self.feeder {
            let mut frame = self.frames(seconds);
            if let Some(total) = self.song_frames {
                frame = frame.min(total);
            }
            self.status.position.store(frame, Relaxed);
            feeder.seek(frame);
        }
    }

    /// Where the song is, in seconds.
    pub fn position(&self) -> f64 {
        self.status.position.load(Relaxed) as f64 / self.song_rate as f64
    }

    pub fn duration(&self) -> Option<f64> {
        self.song_frames.map(|f| f as f64 / self.song_rate as f64)
    }

    /// True once each time a song plays to its end.
    pub fn take_ended(&mut self) -> bool {
        let ended = self.status.ended.load(Relaxed);
        let fresh = ended != self.seen_ended;
        self.seen_ended = ended;
        fresh
    }

    /// The song file could not be read.
    pub fn error(&self) -> Option<String> {
        self.feeder.as_ref().and_then(|f| f.error())
    }

    /// Overall volume, 0–1 (linear gain; the app applies its own curve).
    pub fn set_volume(&self, gain: f32) {
        self.params.volume.set(gain.max(0.0));
    }

    /// The two Separate Audio levels (linear gains).
    pub fn set_layer_gains(&self, a: f32, b: f32) {
        self.params.gain_a.set(a.max(0.0));
        self.params.gain_b.set(b.max(0.0));
    }

    /// 0.5–2.0. With `keep_pitch`, faster stays in tune; without, it rises
    /// like a record played fast.
    pub fn set_speed(&self, speed: f32, keep_pitch: bool) {
        self.params.speed.set(speed.clamp(0.25, 4.0));
        self.params.keep_pitch.store(keep_pitch, Relaxed);
    }

    /// Which reverb, and how much (0–1).
    pub fn set_reverb(&mut self, kind: Kind, amount: f32) {
        self.empty_trash();
        if kind != self.reverb_kind {
            let mut fresh = Box::new(Reverb::new(self.device_rate));
            fresh.set_kind(kind);
            let _ = self.to_audio.send(ToAudio::Reverb(fresh));
            self.reverb_kind = kind;
        }
        self.reverb_amount = amount.clamp(0.0, 1.0);
        let (dry, wet) = reverb::mix_gains(self.reverb_amount, kind);
        self.params.dry.set(dry);
        self.params.wet.set(wet);
    }

    /// The A–B loop: repeat from `start` to `end` seconds (`None` = the end of
    /// the song, i.e. repeat the whole song with no gap). `None` turns it off.
    pub fn set_loop(&self, region: Option<(f64, Option<f64>)>) {
        if let Some(feeder) = &self.feeder {
            feeder.set_loop(region.map(|(a, b)| LoopRegion { start: self.frames(a), end: b.map(|b| self.frames(b)) }));
        }
    }
}

/// A one-pole glide towards a target, like Web Audio's `setTargetAtTime`.
struct Glide {
    value: f32,
    coefficient: f32,
}
impl Glide {
    fn new(value: f32, seconds: f32, rate: u32) -> Self {
        Self { value, coefficient: 1.0 - (-1.0 / (seconds * rate as f32)).exp() }
    }
    #[inline]
    fn next(&mut self, target: f32) -> f32 {
        self.value += (target - self.value) * self.coefficient;
        if (target - self.value).abs() < 1e-6 {
            self.value = target;
        }
        self.value
    }
}

/// Leaves everything below 0.9 alone and rounds peaks off smoothly instead
/// of cutting them flat (loud reverbs can push past full scale).
#[inline]
fn soft_clip(x: f32) -> f32 {
    const KNEE: f32 = 0.9;
    let magnitude = x.abs();
    if magnitude <= KNEE {
        x
    } else {
        (KNEE + (1.0 - KNEE) * ((magnitude - KNEE) / (1.0 - KNEE)).tanh()).copysign(x)
    }
}

/// Frames read from the feeder at a time.
const READ: usize = 1024;
/// Output frames processed together (the reverb works in blocks).
const BLOCK: usize = 512;

/// The audio-thread side.
pub struct Renderer {
    rate: u32,
    params: Arc<Params>,
    status: Arc<Status>,
    from_app: Receiver<ToAudio>,
    trash: Sender<Trash>,
    song: Option<Box<Song>>,
    resampler: Resampler,
    stretcher: Stretcher,
    stretching: bool,
    /// The song has no more frames; flush what is left in the pipeline.
    draining: bool,
    reverb: Box<Reverb>,
    /// The previous reverb, faded out over a few ms after a switch.
    old_reverb: Option<(Box<Reverb>, usize)>,
    /// Frames of reverb tail still ringing after the music stopped.
    tail: usize,
    reverb_live: bool,
    // Glides.
    volume: Glide,
    gain_a: Glide,
    gain_b: Glide,
    dry: Glide,
    wet: Glide,
    speed: Glide,
    /// The play / pause fade: 0 = silent, 1 = full.
    fade: f32,
    fade_step: f32,
    // Scratch space (allocated once).
    read: Vec<Frame4>,
    marks: Vec<u64>,
    left: Vec<f32>,
    right: Vec<f32>,
    old_left: Vec<f32>,
    old_right: Vec<f32>,
}

impl Renderer {
    fn new(
        rate: u32,
        params: Arc<Params>,
        status: Arc<Status>,
        from_app: Receiver<ToAudio>,
        trash: Sender<Trash>,
        reverb: Box<Reverb>,
    ) -> Self {
        let glide = |v| Glide::new(v, 0.03, rate);
        Self {
            rate,
            params,
            status,
            from_app,
            trash,
            song: None,
            resampler: Resampler::new(),
            stretcher: Stretcher::new(44_100),
            stretching: false,
            draining: false,
            reverb,
            old_reverb: None,
            tail: 0,
            reverb_live: false,
            volume: glide(1.0),
            gain_a: glide(1.0),
            gain_b: glide(0.0),
            dry: glide(1.0),
            wet: glide(0.0),
            speed: glide(1.0),
            fade: 0.0,
            fade_step: 1.0 / (0.008 * rate as f32),
            read: vec![[0.0; 4]; READ],
            marks: vec![0; READ],
            left: vec![0.0; BLOCK],
            right: vec![0.0; BLOCK],
            old_left: vec![0.0; BLOCK],
            old_right: vec![0.0; BLOCK],
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn take_messages(&mut self) {
        while let Ok(message) = self.from_app.try_recv() {
            match message {
                ToAudio::Song(song) => {
                    self.stretcher = Stretcher::new(song.sample_rate);
                    if let Some(old) = self.song.replace(song) {
                        let _ = self.trash.send(Trash::Song(old));
                    }
                    self.restart_pipeline();
                }
                ToAudio::Unload => {
                    if let Some(old) = self.song.take() {
                        let _ = self.trash.send(Trash::Song(old));
                    }
                    self.restart_pipeline();
                }
                ToAudio::Reverb(fresh) => {
                    let old = std::mem::replace(&mut self.reverb, fresh);
                    if let Some((older, _)) = self.old_reverb.replace((old, (0.03 * self.rate as f32) as usize)) {
                        let _ = self.trash.send(Trash::Reverb(older));
                    }
                    self.reverb_live = false; // the new one starts clean
                }
            }
        }
    }

    /// Start the speed stages afresh (new song or a jump) and fade in.
    fn restart_pipeline(&mut self) {
        self.resampler.reset();
        self.stretcher.reset();
        self.draining = false;
        self.fade = 0.0;
    }

    /// Pull frames from the song into the speed stages until the varispeed
    /// can make one more output frame. Returns `false` if it can't (the
    /// decoder is behind, or the song is over).
    fn fill(&mut self, speed: f64) -> bool {
        let Some(song) = self.song.as_mut() else { return false };
        while !self.resampler.ready() {
            if self.stretching {
                if self.stretcher.has_output() {
                    let mut n = 0;
                    while n < READ {
                        let Some((frame, mark)) = self.stretcher.pop() else { break };
                        self.read[n] = frame;
                        self.marks[n] = mark;
                        n += 1;
                    }
                    self.resampler.push(&self.read[..n], &self.marks[..n]);
                    continue;
                }
                if self.stretcher.step(speed) {
                    continue;
                }
            }
            // Needs input from the song.
            if self.draining {
                return false;
            }
            match song.reader.read(&mut self.read, &mut self.marks) {
                Supply::Frames(0) => return false,
                Supply::Frames(n) => {
                    if self.stretching {
                        self.stretcher.push(&self.read[..n], &self.marks[..n]);
                    } else {
                        self.resampler.push(&self.read[..n], &self.marks[..n]);
                    }
                }
                Supply::Ended => {
                    // Push silence through so the last real frames come out.
                    self.draining = true;
                    let end = song.reader.position();
                    let pad = vec![[0.0; 4]; 2_048];
                    let marks = vec![end; 2_048];
                    if self.stretching {
                        self.stretcher.push(&pad, &marks);
                    } else {
                        self.resampler.push(&pad, &marks);
                    }
                }
            }
        }
        true
    }

    /// Fill an interleaved stereo buffer.
    pub fn render(&mut self, out: &mut [f32]) {
        self.take_messages();
        for block in out.chunks_mut(BLOCK * 2) {
            self.render_block(block);
        }
    }

    fn render_block(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        let params = &self.params;
        let wants_play = params.playing.load(Relaxed) && self.song.is_some();
        let keep_pitch = params.keep_pitch.load(Relaxed);
        let target_speed = params.speed.get();
        let (target_volume, target_a, target_b) = (params.volume.get(), params.gain_a.get(), params.gain_b.get());
        let (target_dry, target_wet) = (params.dry.get(), params.wet.get());

        // A seek happened: start the speed stages from the new place.
        if let Some(song) = self.song.as_mut()
            && song.reader.jumped()
        {
            self.status.position.store(song.reader.position(), Relaxed);
            self.resampler.reset();
            self.stretcher.reset();
            self.draining = false;
            self.fade = 0.0;
        }

        // Keep pitch only does anything away from 1×.
        let stretch_now = keep_pitch && (target_speed - 1.0).abs() > 1e-3;
        if stretch_now != self.stretching {
            self.stretching = stretch_now;
            self.stretcher.reset();
        }
        let song_rate = self.song.as_ref().map_or(self.rate, |s| s.sample_rate);
        let base_step = song_rate as f64 / self.rate as f64;

        let mut sounding = false;
        let mut ended = false;
        for i in 0..frames {
            let speed = self.speed.next(target_speed) as f64;
            let fade_target = if wants_play && !ended { 1.0 } else { 0.0 };
            // Paused and faded out: stop taking from the song.
            let mut frame = [0.0f32; 4];
            if wants_play || self.fade > 0.0 {
                let step = if self.stretching { base_step } else { base_step * speed };
                if self.fill(if self.stretching { speed } else { 1.0 }) {
                    frame = self.resampler.next(step);
                    sounding = true;
                } else if self.draining {
                    ended = true;
                }
            }
            if self.fade < fade_target {
                self.fade = (self.fade + self.fade_step).min(1.0);
            } else if self.fade > fade_target {
                self.fade = (self.fade - self.fade_step).max(0.0);
            }
            let a = self.gain_a.next(target_a) * self.fade;
            let b = self.gain_b.next(target_b) * self.fade;
            self.left[i] = frame[0] * a + frame[2] * b;
            self.right[i] = frame[1] * a + frame[3] * b;
        }
        if let Some(mark) = self.resampler.mark()
            && sounding
        {
            self.status.position.store(mark, Relaxed);
        }

        // Reverb: runs while it's turned up, and keeps ringing after the music
        // stops until its tail has died away.
        let reverb_wanted = target_wet > 0.0 || self.wet.value > 1e-5;
        if sounding {
            self.tail = (12.0 * self.rate as f32) as usize; // longer than any reverb
        } else {
            self.tail = self.tail.saturating_sub(frames);
        }
        let (left, right) = (&mut self.left[..frames], &mut self.right[..frames]);
        if reverb_wanted && self.tail > 0 {
            if !self.reverb_live {
                self.reverb.reset();
                self.reverb_live = true;
            }
            // The previous reverb (just switched away from) fades out.
            if let Some((old, remaining)) = self.old_reverb.as_mut() {
                self.old_left[..frames].copy_from_slice(left);
                self.old_right[..frames].copy_from_slice(right);
                old.process(&mut self.old_left[..frames], &mut self.old_right[..frames], 0.0, 1.0);
                *remaining = remaining.saturating_sub(frames);
            }
            let dry = self.dry.next(target_dry);
            let wet = self.wet.next(target_wet);
            for _ in 1..frames {
                self.dry.next(target_dry);
                self.wet.next(target_wet);
            }
            self.reverb.process(left, right, dry, wet);
            if let Some((_, remaining)) = &self.old_reverb {
                let total = (0.03 * self.rate as f32).max(1.0);
                let level = *remaining as f32 / total;
                for i in 0..frames {
                    left[i] += self.old_left[i] * wet * level;
                    right[i] += self.old_right[i] * wet * level;
                }
            }
        } else {
            self.reverb_live = false;
            let dry = self.dry.next(target_dry);
            for _ in 1..frames {
                self.dry.next(target_dry);
                self.wet.next(target_wet);
            }
            for i in 0..frames {
                left[i] *= dry;
                right[i] *= dry;
            }
        }
        if let Some((_, 0)) = self.old_reverb {
            let (old, _) = self.old_reverb.take().unwrap();
            let _ = self.trash.send(Trash::Reverb(old));
        }

        for i in 0..frames {
            let volume = self.volume.next(target_volume);
            out[i * 2] = soft_clip(left[i] * volume);
            out[i * 2 + 1] = soft_clip(right[i] * volume);
        }

        if ended {
            self.params.playing.store(false, Relaxed);
            if let Some(total) = self.song.as_ref().map(|s| s.reader.position()) {
                self.status.position.store(total, Relaxed);
            }
            self.status.ended.fetch_add(1, Relaxed);
            self.draining = false;
            self.resampler.reset();
            self.stretcher.reset();
        }
        self.status.playing.store(wants_play && !ended, Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Duration;

    /// A stereo 16-bit WAV of a sine tone.
    fn tone(dir: &std::path::Path, name: &str, seconds: f64, rate: u32, freq: f64) -> PathBuf {
        let path = dir.join(name);
        let frames = (seconds * rate as f64) as u32;
        let mut f = std::fs::File::create(&path).unwrap();
        let data = frames * 4;
        for chunk in [&b"RIFF"[..], &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(), &2u16.to_le_bytes()] {
            f.write_all(chunk).unwrap();
        }
        for chunk in [&rate.to_le_bytes()[..], &(rate * 4).to_le_bytes(), &4u16.to_le_bytes(), &16u16.to_le_bytes(), b"data", &data.to_le_bytes()] {
            f.write_all(chunk).unwrap();
        }
        for i in 0..frames {
            let v = ((2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() * 16_000.0) as i16;
            f.write_all(&v.to_le_bytes()).unwrap();
            f.write_all(&v.to_le_bytes()).unwrap();
        }
        path
    }

    /// Render `seconds` of output, giving the decoder thread time to keep up.
    fn render(renderer: &mut Renderer, seconds: f64) -> Vec<f32> {
        let mut out = vec![0.0; (seconds * renderer.rate as f64) as usize * 2];
        for block in out.chunks_mut(1024) {
            renderer.render(block);
            std::thread::sleep(Duration::from_micros(200));
        }
        out
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|x| x * x).sum::<f32>() / samples.len().max(1) as f32).sqrt()
    }

    #[test]
    fn plays_pauses_seeks_and_ends() {
        let dir = tempfile::tempdir().unwrap();
        let song = tone(dir.path(), "a.wav", 1.0, 44_100, 440.0);
        let (mut engine, mut renderer) = Engine::new(48_000);
        let length = engine.load(&[song], 0.0, None).unwrap();
        assert!((length.unwrap() - 1.0).abs() < 1e-6);
        std::thread::sleep(Duration::from_millis(50));

        // Paused: silence.
        assert_eq!(rms(&render(&mut renderer, 0.1)), 0.0);
        engine.play();
        let out = render(&mut renderer, 0.3);
        assert!(rms(&out[2_000..]) > 0.3, "should be playing");
        assert!((engine.position() - 0.3).abs() < 0.03, "position {}", engine.position());

        engine.pause();
        render(&mut renderer, 0.05);
        let paused_at = engine.position();
        assert_eq!(rms(&render(&mut renderer, 0.1)), 0.0);
        assert_eq!(engine.position(), paused_at);

        engine.seek(0.8);
        engine.play();
        std::thread::sleep(Duration::from_millis(30));
        render(&mut renderer, 0.1);
        assert!((engine.position() - 0.9).abs() < 0.03, "position {}", engine.position());
        render(&mut renderer, 0.3);
        assert!(engine.take_ended(), "should have ended");
        assert!(!engine.is_playing());
        assert!(!engine.take_ended(), "ended is reported once");
    }

    #[test]
    fn speed_changes_how_fast_the_song_goes() {
        let dir = tempfile::tempdir().unwrap();
        let song = tone(dir.path(), "a.wav", 5.0, 44_100, 440.0);
        for keep_pitch in [false, true] {
            let (mut engine, mut renderer) = Engine::new(44_100);
            engine.load(std::slice::from_ref(&song), 0.0, None).unwrap();
            engine.set_speed(1.5, keep_pitch);
            engine.play();
            std::thread::sleep(Duration::from_millis(50));
            render(&mut renderer, 1.0);
            let position = engine.position();
            assert!((position - 1.5).abs() < 0.08, "keep pitch {keep_pitch}: {position}");
        }
    }

    #[test]
    fn separate_audio_levels_mix_the_two_layers() {
        let dir = tempfile::tempdir().unwrap();
        let vocals = tone(dir.path(), "v.wav", 2.0, 44_100, 440.0);
        let music = tone(dir.path(), "m.wav", 2.0, 44_100, 440.0);
        let (mut engine, mut renderer) = Engine::new(44_100);
        engine.load(&[vocals, music], 0.0, None).unwrap();
        engine.set_layer_gains(1.0, 0.0);
        engine.play();
        std::thread::sleep(Duration::from_millis(50));
        let one = rms(&render(&mut renderer, 0.3)[8_000..]);
        engine.set_layer_gains(1.0, 1.0);
        render(&mut renderer, 0.2);
        let both = rms(&render(&mut renderer, 0.2));
        assert!((both / one - 2.0).abs() < 0.05, "one {one}, both {both}");
        engine.set_layer_gains(0.0, 0.0);
        render(&mut renderer, 0.3);
        assert!(rms(&render(&mut renderer, 0.1)) < 1e-3);
    }

    #[test]
    fn reverb_rings_on_after_pause() {
        let dir = tempfile::tempdir().unwrap();
        let song = tone(dir.path(), "a.wav", 3.0, 44_100, 440.0);
        let (mut engine, mut renderer) = Engine::new(44_100);
        engine.load(&[song], 0.0, None).unwrap();
        engine.set_reverb(Kind::Hall, 0.5);
        engine.play();
        std::thread::sleep(Duration::from_millis(50));
        render(&mut renderer, 0.5);
        engine.pause();
        render(&mut renderer, 0.05);
        let tail = rms(&render(&mut renderer, 0.2));
        assert!(tail > 1e-3, "the hall should still ring: {tail}");
    }
}
