# Lewisis' Music

A local music player for your own MP3, WAV and FLAC files, with:

- **Speed** — slowed to nightcore (0.5× – 2×). Pitch follows speed by default; switch on *Keep pitch* to change tempo only.
- **Reverb** — 0% to 100%, with nine types to choose from: Room, Studio, Chamber, Hall, Cathedral, Arena, Cave, Tunnel and Plate.
- **Acapella** — removes the instruments, leaving vocals only.
- **Karaoke** — removes the vocals, leaving the instrumental.
- **Lyrics** — a full-screen page that shows the words of the playing song and follows along with the music.
- **Playlists** — create playlists and fill them with songs from your library.
- **Settings › Customization** — light or dark mode, eight colours, nine themes (Default, Skeuomorphism, Maximalism, Minimalism, Claymorphism, Liquid Glass, Flat Design, Fluent Design, Material Design) and an animations switch.
- Play / pause, previous / next, seek, volume, shuffle, loop (playlist or single song), search.

## Run

```bash
./run.sh
```

The first run installs everything into `.venv` (about 900 MB). The player then opens at <http://127.0.0.1:5055>. Use `./run.sh --port 6000` for a different port, or `--no-browser` to stop it opening a tab.

Shortcuts: `Space` play/pause, `←` / `→` seek 5 seconds, `Esc` leaves the lyrics page.

## Lyrics and sound controls

Click the player bar at the top (or the corner-arrows button in its display) to open the full-screen page. It shows the song's lyrics next to its cover, with the player bar and the Speed, Reverb and Vocals & music controls underneath. *Back* (or `Esc`) returns to your library. Click any timed line to jump to that part of the song.

Lyrics come from, in this order: lyrics you saved for the song, lyrics stored inside the song file, and — only if you press *Find Lyrics Online* or switch on *Settings › Lyrics › Find lyrics online automatically* — a lookup at [lrclib.net](https://lrclib.net), which is sent the song's title, artist and length. You can also paste the words in, or import a `.lrc` file. Lines that start with a time like `[00:12.50]` follow the music; plain text is shown as it is. If the lyrics are wrong, the `⋯` button at the top right of the page removes them; the song then goes back to having none and is not looked up again unless you ask.

The button at the left end of the player bar hides or shows the sidebar.

## Settings

Press *Settings* at the bottom of the sidebar, then *Customization*. Every choice applies straight away and is remembered by the browser. Liquid Glass bends light at the panel edges in Chromium-based browsers (Chrome, Edge, Brave); other browsers show it as frosted glass.

## Library and playlists

**Songs** is the general library: press *Add Music* or drop files anywhere in the window. Press *New Playlist* in the sidebar to name a playlist and tick the songs that belong in it. A song's `⋯` menu adds it to a playlist, removes it from the one you are viewing, or deletes it from the library.

**Playlist photos.** Choose a photo when you create or edit a playlist, or click the picture at the top of a playlist to add, change or remove it. Without a photo, a playlist shows the covers of its songs.

**Song info.** A song's `⋯` menu also has *Edit Song Info…*, where you can change its title, artist, album and cover. This changes how the song is shown in the player; the music file itself is left as it is.

## How acapella and karaoke work

The [Demucs](https://github.com/facebookresearch/demucs) AI model splits each song into a vocal track and an instrumental track. On a 4-core laptop CPU this takes roughly half the song's length. Both versions are saved, so each song is only ever split once and afterwards switches instantly.

With **Prepare ahead** switched on (the default), every song in the library is split in the background, starting when it is added, so the buttons are instant by the time you use them. If you press Acapella or Karaoke on a song that is not ready, that song jumps the queue; it keeps playing and switches over by itself. Prepare ahead uses the processor while it works and about 40 MB of disk per song; switch it off to split songs only on demand.

The very first use downloads the model (about 80 MB).

## Where things are stored

Everything is kept in `data/` next to this file: `data/music` (songs), `data/covers` (cover art), `data/stems` (separated vocals and instrumentals), `data/lyrics` (lyrics you saved or found online), plus `library.json`, `playlists.json` and `settings.json`. Deleting a song in the app deletes its copy and stems, never your original file.

## Layout

- `server.py` — web server, library, playlists and audio streaming (Flask)
- `separator.py` — background AI separation queue (Demucs)
- `lyrics.py` — lyrics: reading them from song files, saving them, and the online lookup
- `static/` — the interface and audio engine (plain HTML/CSS/JS, Web Audio API), fonts in `static/fonts`. `style.css` holds the layout and the Default look; `ui-styles.css` holds the other eight themes.
