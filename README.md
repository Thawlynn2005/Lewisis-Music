# Lewisis' Music

A local music player for your own MP3, WAV and FLAC files, with:

- **Speed** — slowed to nightcore (0.5× – 2×). Pitch follows speed by default; switch on *Keep pitch* to change tempo only.
- **Reverb** — 0% to 100%, with six types to choose from: Room, Studio, Hall, Cathedral, Plate and Echo.
- **Acapella** — removes the instruments, leaving vocals only.
- **Karaoke** — removes the vocals, leaving the instrumental.
- **Playlists** — create playlists and fill them with songs from your library.
- **Light and dark mode.**
- Play / pause, previous / next, seek, volume, shuffle, loop (playlist or single song), search.

## Run

```bash
./run.sh
```

The first run installs everything into `.venv` (about 900 MB). The player then opens at <http://127.0.0.1:5055>. Use `./run.sh --port 6000` for a different port, or `--no-browser` to stop it opening a tab.

Shortcuts: `Space` play/pause, `←` / `→` seek 5 seconds.

## Library and playlists

**Songs** is the general library: press *Add Music* or drop files anywhere in the window. Press *New Playlist* in the sidebar to name a playlist and tick the songs that belong in it. A song's `⋯` menu adds it to a playlist, removes it from the one you are viewing, or deletes it from the library.

## How acapella and karaoke work

The [Demucs](https://github.com/facebookresearch/demucs) AI model splits each song into a vocal track and an instrumental track. On a 4-core laptop CPU this takes roughly half the song's length. Both versions are saved, so each song is only ever split once and afterwards switches instantly.

With **Prepare ahead** switched on (the default), every song in the library is split in the background, starting when it is added, so the buttons are instant by the time you use them. If you press Acapella or Karaoke on a song that is not ready, that song jumps the queue; it keeps playing and switches over by itself. Prepare ahead uses the processor while it works and about 40 MB of disk per song; switch it off to split songs only on demand.

The very first use downloads the model (about 80 MB).

## Where things are stored

Everything is kept in `data/` next to this file: `data/music` (songs), `data/covers` (cover art), `data/stems` (separated vocals and instrumentals), plus `library.json`, `playlists.json` and `settings.json`. Deleting a song in the app deletes its copy and stems, never your original file.

## Layout

- `server.py` — web server, library, playlists and audio streaming (Flask)
- `separator.py` — background AI separation queue (Demucs)
- `static/` — the interface and audio engine (plain HTML/CSS/JS, Web Audio API), fonts in `static/fonts`
