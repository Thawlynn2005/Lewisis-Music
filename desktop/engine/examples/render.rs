//! Renders part of a song through the engine into a WAV, to listen to and to
//! time: `cargo run --release --example render -- SONG OUT.wav SPEED KEEP(0/1) REVERB(kind) AMOUNT [SECONDS]`
use std::io::Write;
use std::time::{Duration, Instant};

use lewisis_engine::{Engine, ReverbKind};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let song = std::path::PathBuf::from(&args[1]);
    let speed: f32 = args[3].parse().unwrap();
    let keep = &args[4] == "1";
    let kind: ReverbKind = serde_json::from_str(&format!("\"{}\"", args[5])).unwrap();
    let amount: f32 = args[6].parse().unwrap();
    let seconds: f64 = args.get(7).map_or(20.0, |s| s.parse().unwrap());
    let rate = 48_000;
    let (mut engine, mut renderer) = Engine::new(rate);
    engine.load(&[song], 30.0, None).unwrap();
    engine.set_speed(speed, keep);
    engine.set_reverb(kind, amount);
    engine.play();
    std::thread::sleep(Duration::from_millis(100));
    let mut out = vec![0.0f32; (seconds * rate as f64) as usize * 2];
    let mut busy = Duration::ZERO;
    for block in out.chunks_mut(1024) {
        let t = Instant::now();
        renderer.render(block);
        busy += t.elapsed();
        std::thread::sleep(Duration::from_micros(300)); // let the decoder keep up
    }
    println!("rendered {seconds} s in {:.0} ms of work ({:.1}% of one core), position now {:.2} s",
        busy.as_secs_f64() * 1e3, busy.as_secs_f64() / seconds * 100.0, engine.position());
    let mut f = std::fs::File::create(&args[2]).unwrap();
    let data = (out.len() * 2) as u32;
    f.write_all(b"RIFF").unwrap(); f.write_all(&(36 + data).to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap(); f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap(); f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&rate.to_le_bytes()).unwrap(); f.write_all(&(rate * 4).to_le_bytes()).unwrap();
    f.write_all(&4u16.to_le_bytes()).unwrap(); f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap(); f.write_all(&data.to_le_bytes()).unwrap();
    for s in out { f.write_all(&((s * 32767.0) as i16).to_le_bytes()).unwrap(); }
}
