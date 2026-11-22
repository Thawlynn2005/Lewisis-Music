//! Runs the real separation model through the ONNX Runtime library that the
//! app ships, loaded at run time.
//!
//! Needs the model and the library:
//!   LEWISIS_TEST_MODEL=path/to/htdemucs.onnx  (tools/export_demucs_onnx.py)
//!   ORT_DYLIB_PATH=path/to/libonnxruntime.so  (tools/fetch_onnxruntime.py)
//! Without them the test only says so; CI sets LEWISIS_REQUIRE_SEPARATION_TEST=1
//! so that missing files fail the build instead.

use std::path::PathBuf;

use lewisis_core::audio_file::Stereo;
use lewisis_core::separate::{SAMPLE_RATE, Separator};

fn inputs() -> Option<(PathBuf, PathBuf)> {
    let model = std::env::var_os("LEWISIS_TEST_MODEL").map(PathBuf::from);
    let runtime = std::env::var_os("ORT_DYLIB_PATH").map(PathBuf::from);
    match (model, runtime) {
        (Some(model), Some(runtime)) => Some((model, runtime)),
        _ if std::env::var_os("LEWISIS_REQUIRE_SEPARATION_TEST").is_some() => {
            panic!("LEWISIS_TEST_MODEL and ORT_DYLIB_PATH must both be set")
        }
        _ => {
            eprintln!("separation test not run: set LEWISIS_TEST_MODEL and ORT_DYLIB_PATH to run it");
            None
        }
    }
}

#[test]
fn separates_a_clip_through_the_bundled_runtime() {
    let Some((model, runtime)) = inputs() else { return };
    let mut separator = Separator::load(&model, &runtime).expect("load ONNX Runtime and the model");

    // 3 seconds: a low tone panned left plus a gliding tone in the middle.
    let frames = SAMPLE_RATE as usize * 3;
    let mut mix = Stereo { left: Vec::with_capacity(frames), right: Vec::with_capacity(frames), sample_rate: SAMPLE_RATE };
    for i in 0..frames {
        let t = i as f32 / SAMPLE_RATE as f32;
        let bass = (2.0 * std::f32::consts::PI * 110.0 * t).sin() * 0.3;
        let glide = (2.0 * std::f32::consts::PI * (300.0 + 80.0 * t) * t).sin() * 0.2;
        mix.left.push(bass + glide);
        mix.right.push(bass * 0.4 + glide);
    }

    let mut reports = 0;
    let stems = separator
        .separate(&mix, |fraction| {
            assert!((0.0..=1.0).contains(&fraction));
            reports += 1;
            true
        })
        .expect("run the model")
        .expect("not stopped");
    assert!(reports >= 1);

    for stem in [&stems.vocals, &stems.instrumental] {
        assert_eq!(stem.frames(), frames);
        assert_eq!(stem.sample_rate, SAMPLE_RATE);
        assert!(stem.left.iter().chain(&stem.right).all(|v| v.is_finite()));
    }
    // The two halves add back up to the song (Demucs's sources sum to its input).
    let (mut signal, mut error) = (0.0f64, 0.0f64);
    for i in 0..frames {
        for (m, v, s) in [(mix.left[i], stems.vocals.left[i], stems.instrumental.left[i]), (mix.right[i], stems.vocals.right[i], stems.instrumental.right[i])] {
            signal += (m as f64).powi(2);
            error += (m as f64 - v as f64 - s as f64).powi(2);
        }
    }
    let snr = 10.0 * (signal / error.max(1e-12)).log10();
    assert!(snr > 15.0, "vocals + instrumental differ from the mix: {snr:.1} dB");
    // Tones without a voice belong to the instrumental.
    let energy = |s: &Stereo| s.left.iter().chain(&s.right).map(|v| (*v as f64).powi(2)).sum::<f64>();
    assert!(energy(&stems.instrumental) > energy(&stems.vocals), "the instruments ended up in the vocals");
}
