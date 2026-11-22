//! `cargo run --example lookup -- TITLE ARTIST SECONDS`
fn main() {
    let a: Vec<String> = std::env::args().collect();
    match lewisis_core::lyrics::lookup(&a[1], &a[2], a[3].parse().unwrap()) {
        Ok(Some(found)) => println!("found ({} lines, instrumental {}): {}…", found.text.lines().count(), found.instrumental, found.text.lines().next().unwrap_or("").chars().take(12).collect::<String>()),
        Ok(None) => println!("nothing matched"),
        Err(e) => println!("error: {e}"),
    }
}
