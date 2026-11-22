//! Sound output: the engine from `lewisis-engine`, played through the
//! operating system's default output device with CPAL (ALSA on Linux, WASAPI
//! on Windows, CoreAudio on macOS).
//!
//! The CPAL stream lives on its own thread ("audio output"); the engine's
//! renderer runs inside the stream's callback, and the engine's controller
//! sits behind a mutex here, used by the Tauri commands. Nothing slow (decoding,
//! building a reverb) ever runs on the interface thread or in the callback.
//!
//! If the output device disappears or changes its sample rate (headphones
//! unplugged, a different default chosen), the stream is rebuilt and the song
//! carries on from where it was, with every setting kept.

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use lewisis_engine::{Engine, Renderer, ReverbKind};
use serde::Serialize;

/// Everything the listener has set, so a rebuilt engine can be put back
/// exactly as it was.
#[derive(Clone)]
struct Wanted {
    files: Vec<PathBuf>,
    playing: bool,
    volume: f32,
    gains: (f32, f32),
    speed: f32,
    keep_pitch: bool,
    reverb: (ReverbKind, f32),
    repeat: Option<(f64, Option<f64>)>,
}

impl Default for Wanted {
    fn default() -> Self {
        Self {
            files: Vec::new(),
            playing: false,
            volume: 1.0,
            gains: (1.0, 0.0),
            speed: 1.0,
            keep_pitch: false,
            reverb: (ReverbKind::default(), 0.0),
            repeat: None,
        }
    }
}

struct Inner {
    engine: Option<Engine>,
    wanted: Wanted,
    /// The output device's name, for the log.
    device: String,
}

/// What the interface is told about playback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub position: f64,
    pub duration: Option<f64>,
    pub playing: bool,
    pub ended: bool,
    pub error: Option<String>,
    pub has_device: bool,
}

#[derive(Clone)]
pub struct Player {
    inner: Arc<Mutex<Inner>>,
    output: Sender<OutputCommand>,
}

enum OutputCommand {
    Rebuild,
}

impl Player {
    pub fn start() -> Self {
        let inner = Arc::new(Mutex::new(Inner { engine: None, wanted: Wanted::default(), device: String::new() }));
        let (output, commands) = mpsc::channel();
        let player = Self { inner, output };
        let worker = player.clone();
        std::thread::Builder::new()
            .name("audio output".into())
            .spawn(move || worker.run_output(commands))
            .expect("could not start the audio output thread");
        player
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Owns the CPAL stream; rebuilds it when the device fails or changes.
    fn run_output(self, commands: mpsc::Receiver<OutputCommand>) {
        let (errors, stream_errors) = mpsc::channel::<cpal::Error>();
        loop {
            let built = self.build_stream(errors.clone());
            let (stream, device_id, rate) = match built {
                Ok(built) => built,
                Err(error) => {
                    log::warn!("No sound output yet: {error}. Trying again shortly.");
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };
            // Wait for a reason to rebuild: an error from the stream, a
            // request, or (checked every two seconds) a new default device.
            loop {
                match commands.recv_timeout(Duration::from_secs(2)) {
                    Ok(OutputCommand::Rebuild) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                if let Ok(error) = stream_errors.try_recv() {
                    match error.kind() {
                        cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => {
                            log::debug!("Audio output: {error}");
                            continue;
                        }
                        _ => {
                            log::warn!("Audio output stopped: {error}. Reconnecting.");
                            break;
                        }
                    }
                }
                let host = cpal::default_host();
                let now = host.default_output_device().and_then(|d| d.id().ok());
                if now.is_some() && now != device_id {
                    log::info!("The default sound output changed; switching to it.");
                    break;
                }
            }
            drop(stream);
            let _ = rate;
            while stream_errors.try_recv().is_ok() {}
        }
    }

    /// Open the default output device and (re)create the engine at its
    /// sample rate.
    fn build_stream(
        &self,
        errors: Sender<cpal::Error>,
    ) -> Result<(cpal::Stream, Option<cpal::DeviceId>, u32), String> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or("no output device")?;
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let rate = config.sample_rate;
        let channels = config.channels as usize;

        let renderer = self.replace_engine(rate, device.to_string());
        let on_error = move |error: cpal::Error| {
            let _ = errors.send(error);
        };
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, channels, renderer, on_error),
            SampleFormat::F64 => build::<f64>(&device, config, channels, renderer, on_error),
            SampleFormat::I16 => build::<i16>(&device, config, channels, renderer, on_error),
            SampleFormat::I32 => build::<i32>(&device, config, channels, renderer, on_error),
            SampleFormat::U16 => build::<u16>(&device, config, channels, renderer, on_error),
            SampleFormat::U8 => build::<u8>(&device, config, channels, renderer, on_error),
            SampleFormat::I8 => build::<i8>(&device, config, channels, renderer, on_error),
            other => return Err(format!("unsupported sample format {other}")),
        }?;
        stream.play().map_err(|e| e.to_string())?;
        log::info!("Sound output: {device} at {rate} Hz, {channels} channel(s), {format}");
        Ok((stream, device.id().ok(), rate))
    }

    /// A fresh engine at `rate`, with the song and every setting carried over.
    fn replace_engine(&self, rate: u32, device: String) -> Renderer {
        let (mut engine, renderer) = Engine::new(rate);
        let mut inner = self.lock();
        let position = inner.engine.as_ref().map(|e| e.position()).unwrap_or(0.0);
        let wanted = inner.wanted.clone();
        engine.set_volume(wanted.volume);
        engine.set_layer_gains(wanted.gains.0, wanted.gains.1);
        engine.set_speed(wanted.speed, wanted.keep_pitch);
        engine.set_reverb(wanted.reverb.0, wanted.reverb.1);
        if !wanted.files.is_empty() {
            match engine.load(&wanted.files, position, wanted.repeat) {
                Ok(_) if wanted.playing => engine.play(),
                Ok(_) => {}
                Err(error) => log::error!("Could not reload the song after the output changed: {error}"),
            }
        }
        inner.engine = Some(engine);
        inner.device = device;
        renderer
    }

    fn with_engine<T>(&self, f: impl FnOnce(&mut Engine, &mut Wanted) -> T) -> Result<T, String> {
        let mut inner = self.lock();
        let Inner { engine, wanted, .. } = &mut *inner;
        match engine.as_mut() {
            Some(engine) => Ok(f(engine, wanted)),
            None => Err("No sound output device was found. Check that speakers or headphones are connected.".into()),
        }
    }

    /// Load a song (one file, or the vocals and instruments as two) and
    /// return its length in seconds.
    pub fn load(&self, files: Vec<PathBuf>, start: f64) -> Result<Option<f64>, String> {
        self.with_engine(|engine, wanted| {
            wanted.files = files.clone();
            wanted.playing = false;
            engine.pause();
            engine.load(&files, start, wanted.repeat).map_err(|e| e.to_string())
        })?
    }

    pub fn unload(&self) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.files.clear();
            wanted.playing = false;
            engine.unload();
        });
    }

    pub fn play(&self) -> Result<(), String> {
        self.with_engine(|engine, wanted| {
            wanted.playing = true;
            engine.play();
        })
    }

    pub fn pause(&self) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.playing = false;
            engine.pause();
        });
    }

    pub fn seek(&self, seconds: f64) {
        let _ = self.with_engine(|engine, _| engine.seek(seconds));
    }

    pub fn set_volume(&self, gain: f32) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.volume = gain;
            engine.set_volume(gain);
        });
    }

    pub fn set_layer_gains(&self, a: f32, b: f32) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.gains = (a, b);
            engine.set_layer_gains(a, b);
        });
    }

    pub fn set_speed(&self, speed: f32, keep_pitch: bool) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.speed = speed;
            wanted.keep_pitch = keep_pitch;
            engine.set_speed(speed, keep_pitch);
        });
    }

    pub fn set_reverb(&self, kind: ReverbKind, amount: f32) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.reverb = (kind, amount);
            engine.set_reverb(kind, amount);
        });
    }

    pub fn set_loop(&self, region: Option<(f64, Option<f64>)>) {
        let _ = self.with_engine(|engine, wanted| {
            wanted.repeat = region;
            engine.set_loop(region);
        });
    }

    /// Where playback is, and whether a song has just ended (reported once).
    pub fn status(&self) -> Status {
        let mut inner = self.lock();
        let has_device = inner.engine.is_some();
        let Some(engine) = inner.engine.as_mut() else {
            return Status { position: 0.0, duration: None, playing: false, ended: false, error: None, has_device };
        };
        let ended = engine.take_ended();
        let status = Status {
            position: engine.position(),
            duration: engine.duration(),
            playing: engine.is_playing(),
            ended,
            error: engine.error(),
            has_device,
        };
        if ended {
            inner.wanted.playing = false;
        }
        status
    }

    /// Ask for the output to be reopened (e.g. after the system wakes up).
    #[allow(dead_code)]
    pub fn reconnect(&self) {
        let _ = self.output.send(OutputCommand::Rebuild);
    }
}

/// Interleaved stereo from the engine → the device's own sample type and
/// channel count (mono gets both sides mixed; extra channels stay silent).
fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    mut renderer: Renderer,
    on_error: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let mut stereo: Vec<f32> = Vec::new();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let frames = data.len() / channels.max(1);
                if stereo.len() < frames * 2 {
                    stereo.resize(frames * 2, 0.0);
                }
                renderer.render(&mut stereo[..frames * 2]);
                for (frame, out) in data.chunks_mut(channels.max(1)).enumerate() {
                    let (l, r) = (stereo[frame * 2], stereo[frame * 2 + 1]);
                    if channels == 1 {
                        out[0] = T::from_sample((l + r) * 0.5);
                        continue;
                    }
                    for (c, sample) in out.iter_mut().enumerate() {
                        *sample = T::from_sample(match c {
                            0 => l,
                            1 => r,
                            _ => 0.0,
                        });
                    }
                }
            },
            on_error,
            None,
        )
        .map_err(|e| e.to_string())
}
