"""Lewisis' Music — a local music player with speed, reverb, playlists and
AI vocal / instrumental separation.

Run with:  ./run.sh      (or: .venv/bin/python server.py)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import threading
import time
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file

# Pictures (covers, playlist photos) are opened with Pillow, plus pillow-heif for
# the HEIC / HEIF photos iPhones take. Without them only JPEG, PNG, WebP and GIF work.
try:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 90_000_000           # refuse absurdly huge images
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        pass
except ImportError:
    Image = None

import lyrics
from separator import STEMS, Separator

BASE_DIR = Path(__file__).resolve().parent
# Songs, cover art, lyrics, playlists and separated stems live here
# (override with the LEWISIS_MUSIC_DATA environment variable).
DATA_DIR = Path(os.environ.get("LEWISIS_MUSIC_DATA") or BASE_DIR / "data")
MUSIC_DIR = DATA_DIR / "music"
COVER_DIR = DATA_DIR / "covers"
STEMS_DIR = DATA_DIR / "stems"
LYRICS_DIR = DATA_DIR / "lyrics"
LIBRARY_FILE = DATA_DIR / "library.json"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac"}
COVER_TYPES = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
               "image/webp": ".webp", "image/gif": ".gif"}
DEFAULT_SETTINGS = {"autoPrepare": True}
MAX_IMAGE_BYTES = 40 * 1024 * 1024
COVER_SIDE = 1400                                   # covers are stored no larger than this
TYPES = ("happy", "sad", "quiet", "energetic")     # a song's mood; chosen by the listener
MAX_GENRES = 15

for folder in (MUSIC_DIR, COVER_DIR, STEMS_DIR):
    folder.mkdir(parents=True, exist_ok=True)

# The page and its files are served from the root ("/app.js", "/style.css"),
# the same paths the desktop app uses, so one index.html works for both.
app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

separator = Separator(STEMS_DIR)
lyrics_store = lyrics.Store(LYRICS_DIR)
_data_lock = threading.RLock()


# ---- storage --------------------------------------------------------------

def _read_json(path: Path, default):
    with _data_lock:
        if not path.is_file():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return default


def _write_json(path: Path, value) -> None:
    with _data_lock:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)


def load_library() -> list[dict]:
    return _read_json(LIBRARY_FILE, [])


def save_library(tracks: list[dict]) -> None:
    _write_json(LIBRARY_FILE, tracks)


def load_playlists() -> list[dict]:
    return _read_json(PLAYLISTS_FILE, [])


def save_playlists(playlists: list[dict]) -> None:
    _write_json(PLAYLISTS_FILE, playlists)


def load_settings() -> dict:
    return {**DEFAULT_SETTINGS, **_read_json(SETTINGS_FILE, {})}


def find_track(track_id: str) -> dict:
    for track in load_library():
        if track["id"] == track_id:
            return track
    abort(404, description="Track not found")


def public_track(track: dict) -> dict:
    return {
        "id": track["id"],
        "title": track["title"],
        "artist": track["artist"],
        "album": track["album"],
        "duration": track["duration"],
        "format": track["ext"].lstrip(".").upper(),
        "hasCover": bool(track.get("cover")),
        "type": track.get("type") or "",
        "genres": track.get("genres") or [],
        "coverVersion": track.get("coverVersion", 0),     # changes when the picture does, so browsers refetch it
        "stems": separator.status(track["id"]),
    }


def public_playlist(playlist: dict) -> dict:
    return {"id": playlist["id"], "name": playlist["name"], "trackIds": playlist["trackIds"],
            "hasCover": bool(playlist.get("cover")), "coverVersion": playlist.get("coverVersion", 0)}


def prepare_in_background(tracks: list[dict] | None = None) -> None:
    """Queue songs for separation ahead of time, if the setting is on."""
    if not load_settings()["autoPrepare"] or not separator.available():
        return
    for track in tracks if tracks is not None else load_library():
        if not separator.has_stems(track["id"]):
            separator.request(track["id"], MUSIC_DIR / track["file"], urgent=False)


# ---- pictures -------------------------------------------------------------

def _image_extension(data: bytes) -> str | None:
    """The kind of picture, judged by its first bytes rather than its name."""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"GIF8":
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def uploaded_picture() -> bytes:
    upload = request.files.get("image")
    if upload is None:
        abort(400, description="No picture was sent.")
    data = upload.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        abort(400, description="That picture is too large (the limit is 40 MB).")
    return data


def normalise_picture(data: bytes) -> tuple[bytes, str]:
    """Any picture Pillow can open (JPEG, PNG, HEIC, HEIF, AVIF, WebP, GIF, BMP,
    TIFF, ICO, …) becomes a JPEG, or a PNG if it has see-through parts: turned
    the right way up, no larger than COVER_SIDE, and without its hidden details
    (camera, location and so on). Returns (bytes, extension)."""
    if Image is None:                                  # no Pillow: accept the common kinds as they are
        extension = _image_extension(data)
        if extension is None:
            abort(400, description="That file is not a JPEG, PNG, WebP or GIF picture.")
        return data, extension
    try:
        with Image.open(io.BytesIO(data)) as opened:
            picture = ImageOps.exif_transpose(opened)  # first frame only, for animations
            picture.thumbnail((COVER_SIDE, COVER_SIDE), Image.Resampling.LANCZOS)
            see_through = picture.mode in ("RGBA", "LA", "PA") or (
                picture.mode == "P" and "transparency" in picture.info)
            out = io.BytesIO()
            if see_through:
                picture.convert("RGBA").save(out, "PNG", optimize=True)
                return out.getvalue(), ".png"
            picture.convert("RGB").save(out, "JPEG", quality=90, optimize=True, progressive=True)
            return out.getvalue(), ".jpg"
    except Image.DecompressionBombError:
        abort(400, description="That picture is too large to open.")
    except Exception:
        abort(400, description="That file is not a picture Lewisis' Music can open.")


def save_picture(stem: str) -> str:
    """Store the uploaded picture as covers/<stem>.<ext> and return its file name."""
    data, extension = normalise_picture(uploaded_picture())
    remove_picture(stem)
    name = f"{stem}{extension}"
    (COVER_DIR / name).write_bytes(data)
    return name


@app.post("/api/images/convert")
def convert_picture():
    """Turns a picture the browser cannot show (HEIC, TIFF, …) into one it can,
    so it can be previewed before it is saved."""
    data, extension = normalise_picture(uploaded_picture())
    mimetype = "image/png" if extension == ".png" else "image/jpeg"
    return send_file(io.BytesIO(data), mimetype=mimetype, download_name=f"picture{extension}")


def remove_picture(stem: str) -> None:
    for extension in set(COVER_TYPES.values()):
        (COVER_DIR / f"{stem}{extension}").unlink(missing_ok=True)


# ---- metadata -------------------------------------------------------------

def clean_genres(values) -> list[str]:
    """A tidy list of genres: no blanks, no repeats (ignoring case), each one
    short, and "Pop; Rock" or "Pop/Rock" split into separate genres."""
    if isinstance(values, str):
        values = [values]
    genres, seen = [], set()
    for value in values or []:
        for part in re.split(r"[;,/\x00]", str(value or "")):
            name = " ".join(part.split())[:40]
            if name and name.casefold() not in seen:
                seen.add(name.casefold())
                genres.append(name)
    return genres[:MAX_GENRES]


def read_genres(path: Path) -> list[str]:
    """Genres stored in the song file's own tags."""
    try:
        import mutagen

        audio = mutagen.File(str(path))
        tags = getattr(audio, "tags", None)
        if tags is None:
            return []
        values = []
        if hasattr(tags, "getall"):                       # ID3 (MP3, WAV)
            for frame in tags.getall("TCON"):
                values.extend(getattr(frame, "genres", None) or frame.text)
        else:                                             # Vorbis comments (FLAC)
            for key in ("genre", "GENRE"):
                found = tags.get(key)
                if found:
                    values.extend(found if isinstance(found, list) else [found])
        return clean_genres(values)
    except Exception as exc:
        print(f"[genres] {path.name}: {exc}")
        return []


def fill_in_genres() -> None:
    """Songs added before genres existed get the genres from their files, once."""
    with _data_lock:
        tracks = load_library()
        missing = [t for t in tracks if "genres" not in t]
        for track in missing:
            track["genres"] = read_genres(MUSIC_DIR / track["file"])
        if missing:
            save_library(tracks)

def _first_tag(tags, *keys) -> str:
    for key in keys:
        try:
            value = tags.get(key)
        except Exception:
            value = None
        if value is None:
            continue
        if hasattr(value, "text"):
            value = value.text
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        if value:
            return str(value).strip()
    return ""


def read_metadata(path: Path, original_name: str) -> dict:
    """Title / artist / album / duration / embedded cover art, with the file
    name as a fallback ("Artist - Title.mp3")."""
    meta = {"title": "", "artist": "", "album": "", "duration": 0.0, "cover": None}
    try:
        import mutagen
        from mutagen.flac import FLAC

        audio = mutagen.File(str(path))
        if audio is not None:
            meta["duration"] = float(getattr(audio.info, "length", 0.0) or 0.0)
            tags = audio.tags
            if tags is not None:
                meta["title"] = _first_tag(tags, "title", "TIT2")
                meta["artist"] = _first_tag(tags, "artist", "TPE1", "albumartist", "TPE2")
                meta["album"] = _first_tag(tags, "album", "TALB")
                for key in list(tags.keys()):
                    if str(key).startswith("APIC"):
                        frame = tags[key]
                        meta["cover"] = (frame.data, frame.mime)
                        break
            if isinstance(audio, FLAC) and audio.pictures:
                picture = audio.pictures[0]
                meta["cover"] = (picture.data, picture.mime)
    except Exception as exc:  # unreadable tags should never block an import
        print(f"[metadata] {original_name}: {exc}")

    if not meta["duration"]:
        try:
            import soundfile as sf

            info = sf.info(str(path))
            meta["duration"] = info.frames / float(info.samplerate)
        except Exception:
            pass

    if not meta["title"]:
        stem = Path(original_name).stem.replace("_", " ").strip()
        match = re.match(r"^(?P<artist>.+?)\s+-\s+(?P<title>.+)$", stem)
        if match and not meta["artist"]:
            meta["artist"] = match["artist"].strip()
            meta["title"] = match["title"].strip()
        else:
            meta["title"] = stem or "Untitled"
    return meta


# ---- routes: page ---------------------------------------------------------

@app.get("/")
def index():
    return send_file(BASE_DIR / "static" / "index.html")


# ---- routes: library ------------------------------------------------------

@app.get("/api/tracks")
def list_tracks():
    return jsonify([public_track(t) for t in load_library()])


def file_hash(path: Path) -> str:
    """A fingerprint of a song file's contents, to spot the same song twice."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def library_hashes() -> set[str]:
    """Fingerprints of every song in the library (worked out once for older songs)."""
    missing = {t["id"]: t["file"] for t in load_library() if not t.get("hash")}
    found = {}
    for track_id, file in missing.items():           # outside the lock: this reads whole files
        try:
            found[track_id] = file_hash(MUSIC_DIR / file)
        except OSError:
            pass
    with _data_lock:
        tracks = load_library()
        if found:
            for track in tracks:
                if track["id"] in found and not track.get("hash"):
                    track["hash"] = found[track["id"]]
            save_library(tracks)
        return {t["hash"] for t in tracks if t.get("hash")}


@app.post("/api/tracks")
def add_tracks():
    """Copy uploaded songs into data/music and add them to the library. Nothing
    already there is removed. With ?skipDuplicates=1 (used by Migrate), songs
    whose contents are already in the library are skipped."""
    added, rejected, duplicates = [], [], []
    skip_duplicates = request.args.get("skipDuplicates") == "1"
    known = library_hashes() if skip_duplicates else set()
    for upload in request.files.getlist("files"):
        name = Path(upload.filename or "").name
        ext = Path(name).suffix.lower()
        if ext not in AUDIO_TYPES:
            rejected.append(name or "(unnamed)")
            continue
        track_id = uuid.uuid4().hex[:12]
        path = MUSIC_DIR / f"{track_id}{ext}"
        upload.save(path)
        digest = file_hash(path)
        if skip_duplicates and digest in known:
            path.unlink(missing_ok=True)
            duplicates.append(name)
            continue
        known.add(digest)
        meta = read_metadata(path, name)
        cover_name = None
        if meta["cover"]:
            data, mime = meta["cover"]
            cover_ext = COVER_TYPES.get((mime or "").lower())
            if cover_ext and data:
                cover_name = f"{track_id}{cover_ext}"
                (COVER_DIR / cover_name).write_bytes(data)
        track = {
            "id": track_id,
            "title": meta["title"],
            "artist": meta["artist"],
            "album": meta["album"],
            "type": "",
            "genres": read_genres(path),
            "duration": round(meta["duration"], 2),
            "ext": ext,
            "file": path.name,
            "cover": cover_name,
            "added": int(time.time()),
            "hash": digest,
        }
        with _data_lock:
            tracks = load_library()
            tracks.append(track)
            save_library(tracks)
        prepare_in_background([track])
        added.append(public_track(track))
    return jsonify({"added": added, "rejected": rejected, "duplicates": duplicates})


@app.delete("/api/tracks/<track_id>")
def delete_track(track_id):
    with _data_lock:
        track = find_track(track_id)
        save_library([t for t in load_library() if t["id"] != track_id])
        playlists = load_playlists()
        for playlist in playlists:
            playlist["trackIds"] = [i for i in playlist["trackIds"] if i != track_id]
        save_playlists(playlists)
    separator.forget(track_id)
    lyrics_store.forget(track_id)
    (MUSIC_DIR / track["file"]).unlink(missing_ok=True)
    if track.get("cover"):
        (COVER_DIR / track["cover"]).unlink(missing_ok=True)
    return jsonify({"ok": True})


def _update_track(track_id: str, change) -> dict:
    """Apply `change(track)` to one song in the library and save it."""
    with _data_lock:
        tracks = load_library()
        for track in tracks:
            if track["id"] == track_id:
                change(track)
                save_library(tracks)
                return track
    abort(404, description="Track not found")


@app.put("/api/tracks/<track_id>")
def edit_track(track_id):
    """Change a song's title, artist, album, type (mood) or genres. Only the
    library's own record changes; the audio file is left exactly as it is."""
    body = request.get_json(silent=True) or {}
    fields = {}
    for key in ("title", "artist", "album"):
        if key in body:
            fields[key] = " ".join(str(body[key] or "").split())[:200]
    if "type" in body:
        kind = str(body["type"] or "").strip().lower()
        if kind and kind not in TYPES:
            abort(400, description="Unknown type. Choose Happy, Sad, Quiet or Energetic.")
        fields["type"] = kind
    if "genres" in body:
        fields["genres"] = clean_genres(body["genres"])
    if "title" in fields and not fields["title"]:
        abort(400, description="A song needs a title.")
    return jsonify(public_track(_update_track(track_id, lambda track: track.update(fields))))


@app.post("/api/tracks/<track_id>/cover")
def set_track_cover(track_id):
    find_track(track_id)
    name = save_picture(track_id)
    return jsonify(public_track(_update_track(
        track_id, lambda track: track.update(cover=name, coverVersion=int(time.time() * 1000)))))


@app.delete("/api/tracks/<track_id>/cover")
def delete_track_cover(track_id):
    find_track(track_id)
    remove_picture(track_id)
    return jsonify(public_track(_update_track(
        track_id, lambda track: track.update(cover=None, coverVersion=int(time.time() * 1000)))))


@app.get("/api/tracks/<track_id>/audio")
def track_audio(track_id):
    track = find_track(track_id)
    stem = request.args.get("stem", "original")
    if stem == "original":
        path = MUSIC_DIR / track["file"]
        mimetype = AUDIO_TYPES[track["ext"]]
    elif stem in STEMS:
        path = separator.stem_path(track_id, stem)
        mimetype = "audio/flac"
    else:
        abort(400, description="Unknown stem")
    if not path.is_file():
        abort(404, description="Audio not available")
    return send_file(path, mimetype=mimetype, conditional=True)


@app.get("/api/tracks/<track_id>/cover")
def track_cover(track_id):
    track = find_track(track_id)
    if not track.get("cover"):
        abort(404)
    return send_file(COVER_DIR / track["cover"], conditional=True, max_age=86400)


# ---- routes: lyrics -------------------------------------------------------

def _lyrics_for(track: dict) -> dict:
    return lyrics.describe(lyrics_store, track["id"], MUSIC_DIR / track["file"])


@app.get("/api/tracks/<track_id>/lyrics")
def get_lyrics(track_id):
    return jsonify(_lyrics_for(find_track(track_id)))


@app.put("/api/tracks/<track_id>/lyrics")
def put_lyrics(track_id):
    """Save lyrics the listener typed, pasted or imported."""
    track = find_track(track_id)
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()
    if not text:
        abort(400, description="There are no lyrics to save.")
    lyrics_store.save(track_id, "manual", text)
    return jsonify(_lyrics_for(track))


@app.delete("/api/tracks/<track_id>/lyrics")
def delete_lyrics(track_id):
    track = find_track(track_id)
    lyrics_store.remove(track_id)               # stays removed until lyrics are pasted or searched for again
    return jsonify(_lyrics_for(track))


@app.post("/api/tracks/<track_id>/lyrics/search")
def search_lyrics(track_id):
    """Look the song up online. Sends its title, artist and length to lrclib.net."""
    track = find_track(track_id)
    try:
        match = lyrics.lookup(track["title"], track["artist"], float(track.get("duration") or 0))
    except lyrics.LookupFailed as error:
        return jsonify({"error": str(error)}), 502
    if not match:
        return jsonify({**_lyrics_for(track), "searched": True})
    lyrics_store.save(track_id, "online", match["text"], match["instrumental"])
    return jsonify({**_lyrics_for(track), "searched": True})


# ---- routes: playlists ----------------------------------------------------

def _clean_playlist_fields(body: dict, current: dict | None = None) -> dict:
    fields = {}
    if "name" in body or current is None:
        name = str(body.get("name") or "").strip()[:80]
        fields["name"] = name or "New Playlist"
    if "trackIds" in body or current is None:
        known = {t["id"] for t in load_library()}
        seen, track_ids = set(), []
        for track_id in body.get("trackIds") or []:
            if track_id in known and track_id not in seen:
                seen.add(track_id)
                track_ids.append(track_id)
        fields["trackIds"] = track_ids
    return fields


@app.get("/api/playlists")
def list_playlists():
    return jsonify([public_playlist(p) for p in load_playlists()])


@app.post("/api/playlists")
def create_playlist():
    body = request.get_json(silent=True) or {}
    playlist = {"id": uuid.uuid4().hex[:12], "created": int(time.time()),
                **_clean_playlist_fields(body)}
    with _data_lock:
        playlists = load_playlists()
        playlists.append(playlist)
        save_playlists(playlists)
    return jsonify(public_playlist(playlist))


@app.put("/api/playlists/<playlist_id>")
def update_playlist(playlist_id):
    body = request.get_json(silent=True) or {}
    with _data_lock:
        playlists = load_playlists()
        for playlist in playlists:
            if playlist["id"] == playlist_id:
                playlist.update(_clean_playlist_fields(body, playlist))
                save_playlists(playlists)
                return jsonify(public_playlist(playlist))
    abort(404, description="Playlist not found")


@app.delete("/api/playlists/<playlist_id>")
def delete_playlist(playlist_id):
    with _data_lock:
        playlists = load_playlists()
        remaining = [p for p in playlists if p["id"] != playlist_id]
        if len(remaining) == len(playlists):
            abort(404, description="Playlist not found")
        save_playlists(remaining)
    remove_picture(f"pl-{playlist_id}")
    return jsonify({"ok": True})


def _update_playlist(playlist_id: str, change) -> dict:
    with _data_lock:
        playlists = load_playlists()
        for playlist in playlists:
            if playlist["id"] == playlist_id:
                change(playlist)
                save_playlists(playlists)
                return playlist
    abort(404, description="Playlist not found")


@app.get("/api/playlists/<playlist_id>/cover")
def playlist_cover(playlist_id):
    for playlist in load_playlists():
        if playlist["id"] == playlist_id and playlist.get("cover"):
            return send_file(COVER_DIR / playlist["cover"], conditional=True, max_age=86400)
    abort(404)


@app.post("/api/playlists/<playlist_id>/cover")
def set_playlist_cover(playlist_id):
    _update_playlist(playlist_id, lambda playlist: None)            # 404s if it does not exist
    name = save_picture(f"pl-{playlist_id}")
    return jsonify(public_playlist(_update_playlist(
        playlist_id, lambda playlist: playlist.update(cover=name, coverVersion=int(time.time() * 1000)))))


@app.delete("/api/playlists/<playlist_id>/cover")
def delete_playlist_cover(playlist_id):
    _update_playlist(playlist_id, lambda playlist: None)
    remove_picture(f"pl-{playlist_id}")
    return jsonify(public_playlist(_update_playlist(
        playlist_id, lambda playlist: playlist.update(cover=None, coverVersion=int(time.time() * 1000)))))


# ---- routes: separation ---------------------------------------------------

@app.post("/api/tracks/<track_id>/separate")
def separate_track(track_id):
    track = find_track(track_id)
    missing = separator.missing_modules()
    if missing:
        return jsonify({
            "state": "error",
            "error": "AI separation is not installed (missing: "
                     + ", ".join(missing) + "). Run ./run.sh to install it.",
        }), 503
    return jsonify(separator.request(track_id, MUSIC_DIR / track["file"], urgent=True))


@app.get("/api/stems")
def stems_status():
    return jsonify({t["id"]: separator.status(t["id"]) for t in load_library()})


@app.get("/api/settings")
def get_settings():
    return jsonify(load_settings())


@app.put("/api/settings")
def put_settings():
    body = request.get_json(silent=True) or {}
    settings = load_settings()
    if "autoPrepare" in body:
        settings["autoPrepare"] = bool(body["autoPrepare"])
    _write_json(SETTINGS_FILE, settings)
    if settings["autoPrepare"]:
        prepare_in_background()
    else:
        separator.cancel_background()
    return jsonify(settings)


@app.errorhandler(404)
@app.errorhandler(400)
def json_error(error):
    return jsonify({"error": error.description}), error.code


def main() -> None:
    parser = argparse.ArgumentParser(description="Lewisis' Music")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("LEWISIS_MUSIC_PORT", 5055)))
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    url = f"http://127.0.0.1:{args.port}"
    print(f"\n  Lewisis' Music is running at {url}\n  Press Ctrl+C to stop.\n")
    if not separator.available():
        print("  Note: AI separation packages are missing:",
              ", ".join(separator.missing_modules()), "\n")
    fill_in_genres()
    prepare_in_background()
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
