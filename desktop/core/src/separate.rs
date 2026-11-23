//! Splitting a song into vocals (acapella) and everything else (instrumental /
//! karaoke) with the htdemucs neural network, run through ONNX Runtime.
//!
//! This is a line-by-line port of what the Python version did with PyTorch
//! (`demucs.apply.apply_model` with `split=True, overlap=0.1, shifts=0`):
//! normalise, cut the song into 7.8-second chunks that overlap by 10 %, run each
//! chunk, blend the overlaps with triangular cross-fades, undo the normalising.
//! The model file is made by `tools/export_demucs_onnx.py`.

use std::path::Path;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use crate::audio_file::{self, Stereo};
use crate::{Error, Result};

/// The model works at this sample rate.
pub const SAMPLE_RATE: u32 = 44_100;
/// One chunk: 7.8 s at 44.1 kHz, fixed by the exported model.
pub const SEGMENT: usize = 343_980;
/// How much neighbouring chunks overlap (the Python version used 0.1 too).
pub const OVERLAP: f32 = 0.1;
/// The model's outputs, in order.
pub const SOURCES: [&str; 4] = ["drums", "bass", "other", "vocals"];

fn model_error(e: impl std::fmt::Display) -> Error {
    Error::invalid(format!("The separation model failed: {e}"))
}

/// The ONNX Runtime library's file name on this system. The app ships
/// Microsoft's build of ONNX Runtime 1.31 and loads it at run time.
pub const RUNTIME_LIBRARY: &str = if cfg!(target_os = "windows") {
    "onnxruntime.dll"
} else if cfg!(target_os = "macos") {
    "libonnxruntime.dylib"
} else {
    "libonnxruntime.so"
};

/// Creates ONNX Runtime's worker threads at low priority (see [`crate::priority`]).
struct LowPriorityThreads;

impl ort::environment::ThreadManager for LowPriorityThreads {
    type Thread = std::thread::JoinHandle<()>;

    fn create(&self, work: impl FnOnce() + Send + 'static) -> ort::Result<Self::Thread> {
        std::thread::Builder::new()
            .name("separation".into())
            .spawn(move || {
                crate::priority::lower_current_thread();
                work();
            })
            .map_err(|e| ort::Error::new(format!("could not start a separation thread: {e}")))
    }

    fn join(thread: Self::Thread) -> ort::Result<()> {
        let _ = thread.join();
        Ok(())
    }
}

/// The two halves of a song.
pub struct Stems {
    pub vocals: Stereo,
    pub instrumental: Stereo,
}

/// A loaded separation model.
pub struct Separator {
    session: Session,
    _environment: ort::environment::Environment,
}

impl Separator {
    /// Load ONNX Runtime from `runtime` (its library file, see
    /// [`RUNTIME_LIBRARY`]) and the model from `model`. The runtime is loaded
    /// once per process; later calls reuse it.
    pub fn load(model: &Path, runtime: &Path) -> Result<Self> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        // `init_from` must come before any other ONNX Runtime call: it loads the library.
        let environment = ort::init_from(runtime)
            .map_err(|e| Error::invalid(format!("Could not load ONNX Runtime from {}: {e}", runtime.display())))?
            .with_name("lewisis-music")
            .build()
            .map_err(model_error)?;
        let session = Session::builder(&environment)
            .map_err(model_error)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(model_error)?
            // Leave a core for the interface and the music, run the model's
            // threads at low priority, and don't let idle ones spin.
            .with_intra_threads(threads.saturating_sub(1).max(1))
            .map_err(model_error)?
            .with_inter_threads(1)
            .map_err(model_error)?
            .with_intra_op_spinning(false)
            .map_err(model_error)?
            .with_thread_manager(LowPriorityThreads)
            .map_err(model_error)?
            .commit_from_file(model)
            .map_err(model_error)?;
        Ok(Self { session, _environment: environment })
    }

    /// Run the model on one chunk: 2 × SEGMENT samples in, 4 × 2 × SEGMENT out.
    fn run_chunk(&mut self, chunk: Vec<f32>) -> Result<Vec<f32>> {
        let input = Tensor::from_array(([1usize, 2, SEGMENT], chunk.into_boxed_slice())).map_err(model_error)?;
        let outputs = self.session.run(ort::inputs!["mix" => input]).map_err(model_error)?;
        let (_, data) = outputs["stems"].try_extract_tensor::<f32>().map_err(model_error)?;
        Ok(data.to_vec())
    }

    /// Split stereo 44.1 kHz audio. `progress` is told how far along it is
    /// (0–1) after each chunk and returns `false` to stop (then `Ok(None)`).
    pub fn separate(&mut self, mix: &Stereo, mut progress: impl FnMut(f32) -> bool) -> Result<Option<Stems>> {
        assert_eq!(mix.sample_rate, SAMPLE_RATE, "resample to 44.1 kHz first");
        let length = mix.frames();

        // Same normalisation as the Demucs command-line tool: mean and
        // (unbiased) standard deviation of the mono mix-down.
        let mono: Vec<f64> = mix.left.iter().zip(&mix.right).map(|(l, r)| (*l as f64 + *r as f64) / 2.0).collect();
        let mean = mono.iter().sum::<f64>() / length as f64;
        let variance = mono.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (length.max(2) - 1) as f64;
        let std = variance.sqrt() + 1e-8;
        let normalise = |v: f32| ((v as f64 - mean) / std) as f32;
        let channels = [&mix.left, &mix.right];

        // Triangular cross-fade weights, as in demucs.apply.
        let half = SEGMENT / 2;
        let weight: Vec<f32> = (1..=half).chain((1..=SEGMENT - half).rev()).map(|w| w as f32 / half as f32).collect();
        let stride = ((1.0 - OVERLAP) * SEGMENT as f32) as usize;
        let offsets: Vec<usize> = (0..length).step_by(stride).collect();

        let mut out = vec![vec![0.0f32; length]; SOURCES.len() * 2]; // [source * 2 + channel][frame]
        let mut sum_weight = vec![0.0f32; length];
        for (done, &offset) in offsets.iter().enumerate() {
            let chunk_length = SEGMENT.min(length - offset);
            // A short last chunk is padded with the music before it (and silence
            // past the end), centred, exactly like TensorChunk.padded.
            let delta = SEGMENT - chunk_length;
            let start = offset as i64 - (delta / 2) as i64;
            let mut input = vec![0.0f32; 2 * SEGMENT];
            for (c, channel) in channels.iter().enumerate() {
                for j in 0..SEGMENT {
                    let at = start + j as i64;
                    if at >= 0 && (at as usize) < length {
                        input[c * SEGMENT + j] = normalise(channel[at as usize]);
                    }
                }
            }
            let output = self.run_chunk(input)?;
            let trim = delta / 2; // centre-trim back to the chunk's own length
            for (row, target) in out.iter_mut().enumerate() {
                let base = row * SEGMENT + trim;
                for j in 0..chunk_length {
                    target[offset + j] += weight[j] * output[base + j];
                }
            }
            for j in 0..chunk_length {
                sum_weight[offset + j] += weight[j];
            }
            if !progress((done + 1) as f32 / offsets.len() as f32) {
                return Ok(None);
            }
        }

        let finish = |row: &Vec<f32>| -> Vec<f32> {
            row.iter().zip(&sum_weight).map(|(v, w)| ((*v / *w) as f64 * std + mean) as f32).collect()
        };
        let vocal = SOURCES.iter().position(|s| *s == "vocals").unwrap();
        let mut stems = Stems {
            vocals: Stereo { left: finish(&out[vocal * 2]), right: finish(&out[vocal * 2 + 1]), sample_rate: SAMPLE_RATE },
            instrumental: Stereo { left: vec![0.0; length], right: vec![0.0; length], sample_rate: SAMPLE_RATE },
        };
        for source in (0..SOURCES.len()).filter(|s| *s != vocal) {
            for (sum, v) in stems.instrumental.left.iter_mut().zip(finish(&out[source * 2])) {
                *sum += v;
            }
            for (sum, v) in stems.instrumental.right.iter_mut().zip(finish(&out[source * 2 + 1])) {
                *sum += v;
            }
        }
        Ok(Some(stems))
    }
}

/// Decode a song, split it, and save `vocals.flac` and `instrumental.flac` in
/// `out_dir`. `stage` is told "loading", "separating" and "saving";
/// `progress` as in [`Separator::separate`]. Returns `false` if stopped.
pub fn separate_file(
    separator: &mut Separator,
    song: &Path,
    out_dir: &Path,
    mut stage: impl FnMut(&str),
    progress: impl FnMut(f32) -> bool,
) -> Result<bool> {
    stage("loading");
    let mix = audio_file::resample(audio_file::decode(song)?, SAMPLE_RATE)?;
    stage("separating");
    let Some(stems) = separator.separate(&mix, progress)? else { return Ok(false) };
    stage("saving");
    std::fs::create_dir_all(out_dir)?;
    // Both are written under temporary names and only then renamed, so the two
    // stems appear together.
    audio_file::write_flac(&out_dir.join("vocals.flac"), &stems.vocals)?;
    audio_file::write_flac(&out_dir.join("instrumental.flac"), &stems.instrumental)?;
    Ok(true)
}
