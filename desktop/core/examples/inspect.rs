//! Prints what Lewisis' Music reads from song files: `cargo run --example inspect -- FILE...`
fn main() {
    for path in std::env::args().skip(1) {
        let path = std::path::Path::new(&path);
        let info = lewisis_core::metadata::read(path, &path.file_name().unwrap().to_string_lossy());
        let lyrics = lewisis_core::metadata::embedded_lyrics(path);
        println!(
            "{}\t{}\t{}\t{:.2}\tcover={}\tgenres={:?}\tlyrics={}",
            info.title, info.artist, info.album, info.duration,
            info.cover.as_ref().map_or("none".into(), |(d, m)| format!("{m} {}B", d.len())),
            info.genres, lyrics.lines().count()
        );
    }
}
