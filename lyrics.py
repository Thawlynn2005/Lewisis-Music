"""Lyrics for Lewisis' Music.

Lyrics come from three places, in this order:
  1. lyrics the listener saved for the song (pasted in, or found online),
  2. lyrics stored inside the song file itself (ID3 / Vorbis tags),
  3. an online lookup at lrclib.net — only when the listener asks for it.

Timed lyrics use the LRC format: "[01:23.45] words", one line per timestamp.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LRCLIB = "https://lrclib.net/api"
USER_AGENT = "LocalMusicPlayer/1.0"          # deliberately generic: says nothing about the listener
MAX_CHARS = 200_000

_STAMP = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_WORD_STAMP = re.compile(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>")       # per-word times in "enhanced" LRC
_META = re.compile(r"^\[[A-Za-z#][A-Za-z]*:[^\]]*\]$")               # [ar:Artist], [ti:Title], ...
_OFFSET = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]$", re.IGNORECASE)
_BRACKETS = re.compile(r"\s*[\(\[\{][^\)\]\}]*[\)\]\}]")


def parse(text: str) -> dict:
    """Turn raw lyrics into {"synced": bool, "lines": [{"time": seconds | None, "text": str}]}."""
    timed, plain, offset = [], [], 0.0
    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        found = _OFFSET.match(line)
        if found:
            offset = int(found.group(1)) / 1000.0
            continue
        if _META.match(line):
            continue
        stamps, rest = [], line
        while True:
            found = _STAMP.match(rest)
            if not found:
                break
            minutes, seconds, fraction = found.groups()
            stamps.append(int(minutes) * 60 + int(seconds) + (float("0." + fraction) if fraction else 0.0))
            rest = rest[found.end():].lstrip()
        words = _WORD_STAMP.sub("", rest).strip()
        if stamps:
            timed.extend((max(0.0, stamp - offset), words) for stamp in stamps)
        plain.append(words)

    worded = [line for line in plain if line]
    if len(timed) >= 2 and len(timed) >= len(worded) / 2:
        timed.sort(key=lambda item: item[0])
        return {"synced": True, "lines": [{"time": round(t, 2), "text": words} for t, words in timed]}

    lines, blank = [], True                    # collapse runs of blank lines into one verse break
    for words in plain:
        if words:
            lines.append({"time": None, "text": words})
            blank = False
        elif not blank:
            lines.append({"time": None, "text": ""})
            blank = True
    while lines and not lines[-1]["text"]:
        lines.pop()
    return {"synced": False, "lines": lines}


def embedded(path: Path) -> str:
    """Lyrics stored in the song file's own tags, or "" if there are none."""
    try:
        import mutagen

        audio = mutagen.File(str(path))
        tags = getattr(audio, "tags", None)
        if tags is None:
            return ""
        synced, unsynced = "", ""
        for key in list(tags.keys()):
            name = str(key)
            if name.startswith("SYLT"):                       # ID3 timed lyrics (milliseconds)
                frame = tags[key]
                if getattr(frame, "format", 2) == 2 and frame.text:
                    synced = "\n".join(
                        f"[{ms // 60000:02d}:{(ms % 60000) / 1000:05.2f}]{words.strip()}"
                        for words, ms in frame.text)
            elif name.startswith("USLT"):                     # ID3 plain lyrics
                unsynced = unsynced or str(getattr(tags[key], "text", "") or "")
            elif name.lower() in ("syncedlyrics", "lyrics", "unsyncedlyrics", "lyrics-xxx"):
                value = tags[key]
                value = value[0] if isinstance(value, (list, tuple)) and value else value
                if name.lower() == "syncedlyrics":
                    synced = synced or str(value or "")
                else:
                    unsynced = unsynced or str(value or "")
        return (synced or unsynced).strip()
    except Exception as exc:                                   # unreadable tags are simply "no lyrics"
        print(f"[lyrics] {path.name}: {exc}")
        return ""


class Store:
    """Saved lyrics, one small JSON file per song."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)

    def _file(self, track_id: str) -> Path:
        return self.folder / f"{track_id}.json"

    def load(self, track_id: str) -> dict | None:
        try:
            return json.loads(self._file(track_id).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def save(self, track_id: str, source: str, text: str, instrumental: bool = False) -> None:
        payload = {"source": source, "text": text[:MAX_CHARS], "instrumental": instrumental}
        tmp = self._file(track_id).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._file(track_id))

    def forget(self, track_id: str) -> None:
        self._file(track_id).unlink(missing_ok=True)

    def remove(self, track_id: str) -> None:
        """Remember that the listener removed this song's lyrics."""
        self.save(track_id, "removed", "")


def describe(store: Store, track_id: str, audio_path: Path) -> dict:
    """What the lyrics page should show for one song."""
    saved = store.load(track_id)
    if saved and saved.get("source") == "removed":
        # The listener threw these lyrics out. Show none (not even the ones inside
        # the file) and do not look them up again unless asked.
        return {"found": False, "source": None, "instrumental": False, "synced": False,
                "lines": [], "text": "", "removed": True}
    if saved:
        source, text, instrumental = saved.get("source", "manual"), saved.get("text", ""), bool(saved.get("instrumental"))
    else:
        source, text, instrumental = "file", embedded(audio_path), False
    parsed = parse(text)
    found = instrumental or bool(parsed["lines"])
    return {
        "found": found,
        "source": source if found else None,
        "instrumental": instrumental,
        "synced": parsed["synced"],
        "lines": parsed["lines"],
        "text": text if found else "",
    }


# ---- online lookup ----------------------------------------------------------

class LookupFailed(Exception):
    """The lyrics service could not be reached (as opposed to "no lyrics found")."""


def _get(endpoint: str, params: dict):
    url = f"{LRCLIB}/{endpoint}?{urllib.parse.urlencode({k: v for k, v in params.items() if v})}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise LookupFailed(f"The lyrics service answered with an error ({error.code}).") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise LookupFailed("Could not reach the lyrics service. Check your internet connection.") from error


def _best(results, duration: float):
    """The closest match by length, preferring timed lyrics."""
    best, best_score = None, None
    for item in results or []:
        if not isinstance(item, dict):
            continue
        if not (item.get("syncedLyrics") or item.get("plainLyrics") or item.get("instrumental")):
            continue
        gap = abs(float(item.get("duration") or 0) - duration) if duration else 0.0
        if duration and gap > 12:                       # a different recording: timings would be wrong
            continue
        score = gap + (0 if item.get("syncedLyrics") else 6)
        if best_score is None or score < best_score:
            best, best_score = item, score
    return best


def lookup(title: str, artist: str, duration: float) -> dict | None:
    """Search lrclib.net. Returns {"text", "instrumental"} or None when nothing matches."""
    title, artist = (title or "").strip(), (artist or "").strip()
    if not title:
        return None
    attempts = [title]
    cleaned = _BRACKETS.sub("", title).strip()          # "Song (Official Video)" → "Song"
    if cleaned and cleaned != title:
        attempts.append(cleaned)
    for name in attempts:
        params = {"track_name": name, "artist_name": artist} if artist else {"q": name}
        match = _best(_get("search", params), duration)
        if match:
            return {
                "text": (match.get("syncedLyrics") or match.get("plainLyrics") or "").strip(),
                "instrumental": bool(match.get("instrumental")),
            }
    return None
