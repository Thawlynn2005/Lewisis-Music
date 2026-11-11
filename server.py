"""Lewisis' Music — a local music player with speed, reverb, playlists and
AI vocal / instrumental separation.

Run with:  ./run.sh      (or: .venv/bin/python server.py)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file

from separator import STEMS, Separator

BASE_DIR = Path(__file__).resolve().parent
# Songs, cover art, playlists and separated stems live here
# (override with the LEWISIS_MUSIC_DATA environment variable).
DATA_DIR = Path(os.environ.get("LEWISIS_MUSIC_DATA") or BASE_DIR / "data")
MUSIC_DIR = DATA_DIR / "music"
COVER_DIR = DATA_DIR / "covers"
STEMS_DIR = DATA_DIR / "stems"
LIBRARY_FILE = DATA_DIR / "library.json"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac"}
COVER_TYPES = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
               "image/webp": ".webp", "image/gif": ".gif"}
DEFAULT_SETTINGS = {"autoPrepare": True}

for folder in (MUSIC_DIR, COVER_DIR, STEMS_DIR):
    folder.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

separator = Separator(STEMS_DIR)
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
        "stems": separator.status(track["id"]),
    }


def public_playlist(playlist: dict) -> dict:
    return {"id": playlist["id"], "name": playlist["name"], "trackIds": playlist["trackIds"]}


def prepare_in_background(tracks: list[dict] | None = None) -> None:
    """Queue songs for separation ahead of time, if the setting is on."""
    if not load_settings()["autoPrepare"] or not separator.available():
        return
    for track in tracks if tracks is not None else load_library():
        if not separator.has_stems(track["id"]):
            separator.request(track["id"], MUSIC_DIR / track["file"], urgent=False)


# ---- metadata -------------------------------------------------------------

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


@app.post("/api/tracks")
def add_tracks():
    added, rejected = [], []
    for upload in request.files.getlist("files"):
        name = Path(upload.filename or "").name
        ext = Path(name).suffix.lower()
        if ext not in AUDIO_TYPES:
            rejected.append(name or "(unnamed)")
            continue
        track_id = uuid.uuid4().hex[:12]
        path = MUSIC_DIR / f"{track_id}{ext}"
        upload.save(path)
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
            "duration": round(meta["duration"], 2),
            "ext": ext,
            "file": path.name,
            "cover": cover_name,
            "added": int(time.time()),
        }
        with _data_lock:
            tracks = load_library()
            tracks.append(track)
            save_library(tracks)
        prepare_in_background([track])
        added.append(public_track(track))
    return jsonify({"added": added, "rejected": rejected})


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
    (MUSIC_DIR / track["file"]).unlink(missing_ok=True)
    if track.get("cover"):
        (COVER_DIR / track["cover"]).unlink(missing_ok=True)
    return jsonify({"ok": True})


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
    return jsonify({"ok": True})


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
    prepare_in_background()
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
