# Lewisis' Music

A local music player for your own MP3, WAV and FLAC files, with:

- **Speed** — slowed to nightcore (0.5× – 2×). Pitch follows speed by default; switch on *Keep pitch* to change tempo only.
- **Reverb** — 0% to 100%, with nine types to choose from: Room, Studio, Chamber, Hall, Cathedral, Arena, Cave, Tunnel and Plate.
- **Acapella** — removes the instruments, leaving vocals only.
- **Karaoke** — removes the vocals, leaving the instrumental.
- **Separate Audio** — in the `⋯` menu on the lyrics page: vocals and instruments play side by side, each with its own volume slider in the player bar.
- **Lyrics** — a full-screen page that shows the words of the playing song and follows along with the music.
- **Playlists** — create playlists and fill them with songs from your library.
- **Settings › Customization** — light or dark mode, eight colours, nine themes (Default, Skeuomorphism, Maximalism, Minimalism, Claymorphism, Liquid Glass, Flat Design, Fluent Design, Material Design) and an animations switch.
- Play / pause, previous / next, seek, volume, shuffle, loop (playlist or single song), search.
- **Loop a part of a song** — with *Loop: this song* on, two dots appear on the seek bar at the start and end. Drag them (or use the arrow keys) around the part you want; it repeats until you turn the loop off. Double-click a dot to put it back.

## Run

```bash
./run.sh
```

The first run installs everything into `.venv` (about 900 MB). The player then opens at <http://127.0.0.1:5055>. Use `./run.sh --port 6000` for a different port, or `--no-browser` to stop it opening a tab.

Hotkeys: `Space` play/pause, `←` / `→` 5 seconds back/forward, `Shift` + `←` / `→` previous/next song, `↑` / `↓` volume, `M` mute, `S` shuffle, `L` loop, `[` / `]` / `\` slower/faster/normal speed, `A` acapella, `K` karaoke, `F` lyrics page, `B` sidebar, `/` search, `,` settings. Change any of them in *Settings › Hotkeys*. `Esc` always closes windows and the lyrics page.

## Desktop app (Windows, macOS, Linux)

The same player also comes as an installable desktop app, built with [Tauri 2](https://tauri.app) and Rust from `desktop/`. It shows the same interface (`static/`), but everything the Python server did is done in Rust, and the sound comes from a native audio engine instead of the browser. People who install it don't need Python, Node.js or Rust; the web version above keeps working on its own.

### Install

Download the installer for your system from the latest run of the **Desktop build** workflow (Actions tab → *Desktop build* → *Artifacts*), or from a release:

| System | File | How to install |
| --- | --- | --- |
| Linux (Debian, Ubuntu, Mint…) | `Lewisis Music_3.0.0_amd64.deb` | `sudo apt install ./Lewisis\ Music_3.0.0_amd64.deb`, then open *Lewisis Music* from the app menu |
| Linux (any) | `Lewisis Music_3.0.0_amd64.AppImage` | `chmod +x Lewisis*.AppImage` and run it |
| Windows 10/11 | `Lewisis Music_3.0.0_x64-setup.exe` or `…_x64_en-US.msi` | run it. Windows SmartScreen may warn about an unknown publisher (the app isn't code-signed): *More info → Run anyway* |
| macOS 11+ (Apple Silicon) | `Lewisis Music_3.0.0_aarch64.dmg` | open it and drag the app to Applications. It isn't notarised, so the first time right-click it → *Open* (or run `xattr -dr com.apple.quarantine "/Applications/Lewisis Music.app"`) |

Runtime needs: on Linux, WebKitGTK 4.1 and ALSA (`libwebkit2gtk-4.1-0`, `libasound2`), which the `.deb` installs by itself and every current desktop distribution already has. Windows uses the WebView2 runtime that ships with Windows 10/11 (the installer fetches it if missing). macOS needs nothing extra.

**Your music in the desktop app.** It keeps its own library in the system's app-data folder, in exactly the same layout as `data/`:

- Linux: `~/.local/share/com.lewisis.music/`
- Windows: `%APPDATA%\com.lewisis.music\`
- macOS: `~/Library/Application Support/com.lewisis.music/`

To bring everything over from the web version (songs, covers, playlists, lyrics, separated stems), quit the app and copy the *contents* of `data/` into that folder. To add just the songs, use *Settings › Migrate*. To use another folder altogether, start the app with `LEWISIS_MUSIC_DATA=/path/to/folder`. Logs go to `~/.local/share/com.lewisis.music/logs/` on Linux, `%LOCALAPPDATA%\com.lewisis.music\logs\` on Windows, and `~/Library/Logs/com.lewisis.music/` on macOS.

**AI separation** (Acapella, Karaoke, Separate Audio) runs the same Demucs model through ONNX Runtime. Installers made by the workflow include the model (about 160 MB) and Microsoft's ONNX Runtime 1.31 library for that system, which the app loads when it first separates a song. In a build without it, the app asks for the model file (`htdemucs.onnx`) the first time it's needed and keeps a copy in its data folder.

**Differences from the web version.** Repeating a song or an A–B part is gapless. HEIC photos can be used as covers on macOS only (on Windows and Linux, convert them to JPEG first). Media keys and headphone buttons aren't connected yet.

### Develop

You need [Rust](https://rustup.rs) (stable) and the Tauri CLI:

```bash
cargo install tauri-cli --version "^2" --locked
```

On Linux (Debian/Ubuntu) also install:

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libasound2-dev patchelf file
```

Windows needs the *Desktop development with C++* workload of Visual Studio Build Tools; macOS needs the Xcode command-line tools (`xcode-select --install`).

Run it in development (the interface is served straight from `static/`; reload the window with `Ctrl+R` after editing it):

```bash
cd desktop/app && cargo tauri dev
```

AI separation needs two files in `desktop/app/resources/` (neither is kept in git): ONNX Runtime, which this downloads from Microsoft's NuGet package and checks against a pinned checksum,

```bash
python3 desktop/tools/fetch_onnxruntime.py
```

and the model, made from the Demucs weights (this needs the web version's `.venv`, which has PyTorch and Demucs):

```bash
.venv/bin/pip install onnx onnxruntime
.venv/bin/python desktop/tools/export_demucs_onnx.py desktop/app/resources/htdemucs.onnx --fp16
```

Run the tests (the separation test also runs the model when given both files):

```bash
cd desktop && cargo test --workspace
```

```bash
cd desktop && LEWISIS_TEST_MODEL=$PWD/app/resources/htdemucs.onnx ORT_DYLIB_PATH=$PWD/app/resources/libonnxruntime.so cargo test --workspace
```

### Build the Linux installers

```bash
cd desktop/app && NO_STRIP=true cargo tauri build --bundles deb,appimage
```

The `.deb` and `.AppImage` appear in `desktop/target/release/bundle/deb/` and `desktop/target/release/bundle/appimage/`. Whatever is in `desktop/app/resources/` is bundled, so fetch ONNX Runtime and make the model first (see above) for AI separation to work in the installed app.

### Build for Windows and macOS

Windows and macOS installers are built on GitHub's own Windows and macOS machines by `.github/workflows/desktop-build.yml`. It runs when changes to `desktop/` or `static/` are pushed to `main`, on pull requests, and by hand (*Actions → Desktop build → Run workflow*). Each run uploads `lewisis-music-Linux`, `lewisis-music-Windows` and `lewisis-music-macOS` as artifacts. Pushing a tag such as `v3.0.0` also creates a draft release with the installers attached:

```bash
git tag v3.0.0 && git push origin v3.0.0
```

## Lyrics and sound controls

Click the player bar at the top (or the corner-arrows button in its display) to open the full-screen page. It shows the song's lyrics next to its cover, with the player bar and the Speed, Reverb and Vocals & music controls underneath. *Back* (or `Esc`) returns to your library. Click any timed line to jump to that part of the song.

Lyrics come from, in this order: lyrics you saved for the song, lyrics stored inside the song file, and — only if you press *Find Lyrics Online* or switch on *Settings › Lyrics › Find lyrics online automatically* — a lookup at [lrclib.net](https://lrclib.net), which is sent the song's title, artist and length. You can also paste the words in, or import a `.lrc` file. Lines that start with a time like `[00:12.50]` follow the music; plain text is shown as it is. If the lyrics are wrong, the `⋯` button at the top right of the page removes them; the song then goes back to having none and is not looked up again unless you ask.

The button at the left end of the player bar hides or shows the sidebar. On the lyrics page, the double-arrow button beside the player bar hides the player bar, and the one beside the sound panel hides the sound controls; each button then waits in the bottom-right corner to bring its panel back. Music without words? Untick *Show Lyrics* in the `⋯` menu at the top right of the lyrics page to see just the cover.

## Settings

Press *Settings* at the bottom of the sidebar, then *Customization*. Every choice applies straight away and is remembered by the browser. Liquid Glass bends light at the panel edges in Chromium-based browsers (Chrome, Edge, Brave); other browsers show it as frosted glass.

## Library and playlists

**Migrate a folder.** *Settings › Migrate › Choose Folder…* picks a folder; every MP3, WAV and FLAC file in it (and in the folders inside it) is copied into `data/music` and added to your library, in folder order. Songs already in the library stay, songs whose contents you already have are skipped, and your original files are not moved or changed. Your browser may ask you to confirm sharing the folder's files with the page; the desktop app opens your system's own folder picker.

**Songs** is the general library: press *Add Music* or drop files anywhere in the window. Press *New Playlist* in the sidebar to name a playlist and tick the songs that belong in it. A song's `⋯` menu adds it to a playlist, removes it from the one you are viewing, or deletes it from the library.

**Playlist photos.** Choose a photo when you create or edit a playlist, or click the picture at the top of a playlist to add, change or remove it. Without a photo, a playlist shows the covers of its songs.

**Song info.** A song's `⋯` menu also has *Edit Song Info…*, where you can change its title, artist, album, cover, **type** (Happy, Sad, Quiet or Energetic) and **genres** (as many as you like; type one and press Enter, or pick a suggestion). Genres already stored in a song's file are filled in when it is added.

**Photos.** Covers and playlist photos can be JPEG, PNG, HEIC / HEIF (iPhone photos), AVIF, WebP, GIF, BMP, TIFF and more. They are turned the right way up, scaled to at most 1400 px and saved as JPEG (or PNG if they have see-through parts); hidden photo details such as location are left out.

**Filters.** Above the song list, *Type*, *Genre* and *Artist* narrow it down (several genres can be ticked; songs with any of them are shown). Play, Shuffle and Next only use the songs that pass the filters. *Clear filters* shows everything again. The list has *Type* and *Genres* columns; narrower windows hide Album, then Genres. This changes how the song is shown in the player; the music file itself is left as it is.

## How acapella and karaoke work

The [Demucs](https://github.com/facebookresearch/demucs) AI model splits each song into a vocal track and an instrumental track. On a 4-core laptop CPU this takes roughly half the song's length. Both versions are saved, so each song is only ever split once and afterwards switches instantly.

With **Prepare ahead** switched on (the default), every song in the library is split in the background, starting when it is added, so the buttons are instant by the time you use them. If you press Acapella or Karaoke on a song that is not ready, that song jumps the queue; it keeps playing and switches over by itself. Prepare ahead uses the processor while it works and about 40 MB of disk per song; switch it off to split songs only on demand.

The very first use downloads the model (about 80 MB).

## Where things are stored

The web version keeps everything in `data/` next to this file (the desktop app uses its own app-data folder, see above): `data/music` (songs), `data/covers` (cover art), `data/stems` (separated vocals and instrumentals), `data/lyrics` (lyrics you saved or found online), plus `library.json`, `playlists.json` and `settings.json`. Deleting a song in the app deletes its copy and stems, never your original file.

## Layout

- `server.py` — web server, library, playlists and audio streaming (Flask)
- `separator.py` — background AI separation queue (Demucs)
- `lyrics.py` — lyrics: reading them from song files, saving them, and the online lookup
- `static/` — the interface and audio engine (plain HTML/CSS/JS, Web Audio API), fonts in `static/fonts`. `style.css` holds the layout and the Default look; `ui-styles.css` holds the other eight themes. `desktop.js` connects the interface to the desktop app (in a browser it does nothing).
- `desktop/` — the desktop app (Rust workspace):
  - `core/` — library, playlists, settings, song info, covers, genres, lyrics (with the lrclib.net lookup), Migrate, and AI separation through ONNX Runtime
  - `engine/` — the audio engine: streaming decoding (Symphonia), gapless A–B loops, speed with or without keeping pitch, the nine reverbs, the Separate Audio mix, volume
  - `app/` — the Tauri app: the commands the interface calls, sound output (CPAL), the `media:` protocol for covers, `tauri.conf.json` and the permissions in `capabilities/`
  - `tools/export_demucs_onnx.py` — turns the Demucs model into `htdemucs.onnx`
- `.github/workflows/desktop-build.yml` — builds the installers for all three systems
