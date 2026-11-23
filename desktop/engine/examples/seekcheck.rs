//! Checks that seeking lands on exactly the same samples as reading from the
//! start: `cargo run --release --example seekcheck -- SONG...`
use lewisis_engine::decoder::FileDecoder;

fn main() {
    for path in std::env::args().skip(1) {
        let path = std::path::PathBuf::from(path);
        let mut whole = Vec::new();
        let mut d = FileDecoder::open(&path).unwrap();
        while d.next(&mut whole).unwrap() {}
        let mut worst = 0.0f32;
        let mut misses = 0;
        for k in 1..40u64 {
            let at = whole.len() as u64 * k / 41 + k * 37;
            let mut part = Vec::new();
            d.seek(at).unwrap();
            while part.len() < 2048 && d.next(&mut part).unwrap() {}
            let diff = part.iter().zip(&whole[at as usize..]).take(2048).map(|(a, b)| (a[0] - b[0]).abs().max((a[1] - b[1]).abs())).fold(0.0, f32::max);
            if diff > 1e-4 { misses += 1; }
            worst = worst.max(diff);
        }
        println!("{} rate {} frames header {:?} decoded {} | seeks off: {misses}/39, worst diff {worst:.2e}",
            path.file_name().unwrap().to_string_lossy(), d.sample_rate(), d.frames(), whole.len());
    }
}
