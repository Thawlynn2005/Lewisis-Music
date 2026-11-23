//! Split one song into vocals and instrumental:
//! `cargo run --release --example separate -- MODEL.onnx SONG OUT_DIR [ONNX_RUNTIME_LIBRARY]`
//! (the library defaults to `$ORT_DYLIB_PATH`; get it with `tools/fetch_onnxruntime.py`)
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (model, song, out) = (&args[1], &args[2], &args[3]);
    let runtime = args.get(4).cloned().or_else(|| std::env::var("ORT_DYLIB_PATH").ok()).expect("give the ONNX Runtime library");
    let started = Instant::now();
    let mut separator = lewisis_core::separate::Separator::load(model.as_ref(), runtime.as_ref()).expect("model");
    println!("model loaded in {:.1} s", started.elapsed().as_secs_f32());
    let started = Instant::now();
    let finished = lewisis_core::separate::separate_file(
        &mut separator,
        song.as_ref(),
        out.as_ref(),
        |stage| println!("stage: {stage}"),
        |p| {
            println!("  {:>3.0}%", p * 100.0);
            true
        },
    )
    .expect("separate");
    println!("finished={finished} in {:.1} s", started.elapsed().as_secs_f32());
}
