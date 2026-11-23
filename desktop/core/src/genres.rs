//! Genre lists: tidy, de-duplicated, and split when a tag packs several into one.

/// The most genres one song can have.
pub const MAX_GENRES: usize = 15;
/// The longest one genre name can be, in characters.
pub const MAX_GENRE_CHARS: usize = 40;

/// A tidy list of genres: no blanks, no repeats (ignoring case), each one
/// short, and "Pop; Rock" or "Pop/Rock" split into separate genres.
pub fn clean<I, S>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut genres: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for value in values {
        for part in value.as_ref().split([';', ',', '/', '\0']) {
            let name: String = part.split_whitespace().collect::<Vec<_>>().join(" ");
            let name: String = name.chars().take(MAX_GENRE_CHARS).collect();
            let key = name.to_lowercase();
            if !name.is_empty() && !seen.contains(&key) {
                seen.push(key);
                genres.push(name);
            }
        }
    }
    genres.truncate(MAX_GENRES);
    genres
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn matches_the_python_version() {
        // Same cases (and answers) as server.clean_genres in the Python player.
        assert_eq!(
            clean(["Pop; rock", "pop", "  Future   House ", "Hip-Hop/Rap", ""]),
            ["Pop", "rock", "Future House", "Hip-Hop", "Rap"]
        );
        assert_eq!(clean(["EDM, Progressive House"]), ["EDM", "Progressive House"]);
    }

    #[test]
    fn limits_count_and_length() {
        let many: Vec<String> = (0..30).map(|i| format!("G{i}")).collect();
        assert_eq!(clean(&many).len(), 15);
        assert_eq!(clean(["x".repeat(60)])[0].chars().count(), 40);
    }
}
