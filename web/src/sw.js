/* Lewisis' Music (web version) — the "server", running in the visitor's browser.
 *
 * The interface (static/app.js) talks to /api/... exactly as it talks to the
 * Flask server or the desktop app. On the website this service worker answers
 * those requests from the visitor's own browser storage (store.js), so their
 * music never leaves their computer. Song details, covers, lyrics parsing and
 * genre tidying come from the same Rust code as the desktop app (WebAssembly).
 */
"use strict";
importScripts("/store.js", "/wasm/lewisis_wasm.js");

const { get, put, remove, entries, ordered, announce } = self.LewisisStore;
const core = wasm_bindgen({ module_or_path: "/wasm/lewisis_wasm_bg.wasm" }).then(() => wasm_bindgen);

const AUDIO_TYPES = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac" };
const TYPES = ["happy", "sad", "quiet", "energetic"];
const STEMS = ["vocals", "instrumental"];
const MAX_PICTURE = 40 * 1024 * 1024;
const LRCLIB = "https://lrclib.net/api";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
     const url = new URL(event.request.url);
     if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return; // the site's own files: from the network
     event.respondWith(
          route(event.request, url).catch(error => {
               if (error instanceof Problem) return json({ error: error.message, ...error.extra }, error.status);
               console.error(error);
               return json({ error: String(error?.message || error) }, 500);
          }),
     );
});

// ───────────── helpers ─────────────
class Problem extends Error {
     constructor(status, message, extra = {}) {
          super(message);
          this.status = status;
          this.extra = extra;
     }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const tidy = (text, max) => String(text ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, max);
const extensionOf = name => (/\.[^./\\]+$/.exec(name || "")?.[0] || "").toLowerCase();
async function sha256(buffer) {
     const digest = await crypto.subtle.digest("SHA-256", buffer);
     return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function nextSeq(store) {
     const all = await ordered(store);
     return (all.at(-1)?.seq || 0) + 1;
}

// A file from the browser storage, with Range support so the player can seek.
function serveBlob(request, blob, extraHeaders = {}) {
     const size = blob.size;
     const headers = { "Content-Type": blob.type || "application/octet-stream", "Accept-Ranges": "bytes", ...extraHeaders };
     const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
     if (!range) return new Response(blob, { headers: { ...headers, "Content-Length": String(size) } });
     let start, end;
     if (range[1] === "") {
          start = Math.max(0, size - Number(range[2]));
          end = size - 1;
     } else {
          start = Number(range[1]);
          end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
     }
     if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
     return new Response(blob.slice(start, end + 1), {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
     });
}

// ───────────── the library ─────────────
async function status(id) {
     const job = await get("jobs", id);
     if (!job) return { state: "none", progress: 0 };
     const { state, progress = 0, stage, error } = job;
     return { state, progress, ...(stage ? { stage } : {}), ...(error ? { error } : {}) };
}
async function publicTrack(track) {
     return {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          format: track.ext.replace(".", "").toUpperCase(),
          hasCover: !!track.hasCover,
          type: track.type || "",
          genres: track.genres || [],
          coverVersion: track.coverVersion || 0,
          stems: await status(track.id),
     };
}
const publicPlaylist = p => ({ id: p.id, name: p.name, trackIds: p.trackIds, hasCover: !!p.hasCover, coverVersion: p.coverVersion || 0 });
async function findTrack(id) {
     const track = await get("tracks", id);
     if (!track) throw new Problem(404, "Track not found");
     return track;
}
async function findPlaylist(id) {
     const playlist = await get("playlists", id);
     if (!playlist) throw new Problem(404, "Playlist not found");
     return playlist;
}
async function settings() {
     return { autoPrepare: false, ...((await get("settings", "settings")) || {}) };
}

// Songs to separate ahead of time, if that setting is on (the page does the work).
async function prepareInBackground(tracks) {
     if (!(await settings()).autoPrepare) return;
     for (const track of tracks || (await ordered("tracks"))) {
          const job = await get("jobs", track.id);
          if (!job || job.state === "error") await put("jobs", track.id, { state: "queued", progress: 0, urgent: false, queuedAt: Date.now() });
     }
     announce({ type: "queue" });
}

async function addSongs(files, skipDuplicates) {
     const added = [], rejected = [], duplicates = [];
     const tracks = await ordered("tracks");
     const known = new Set(skipDuplicates ? tracks.map(t => t.hash).filter(Boolean) : []);
     let seq = (tracks.at(-1)?.seq || 0) + 1;
     const { readSong, normalisePicture } = await core;
     const fresh = [];
     for (const file of files) {
          const name = (file.name || "").split(/[\\/]/).pop();
          const ext = extensionOf(name);
          if (!AUDIO_TYPES[ext]) {
               rejected.push(name || "(unnamed)");
               continue;
          }
          const buffer = await file.arrayBuffer();
          const hash = await sha256(buffer);
          if (skipDuplicates && known.has(hash)) {
               duplicates.push(name);
               continue;
          }
          known.add(hash);
          const id = newId();
          let info;
          try {
               info = readSong(new Uint8Array(buffer), name);
          } catch {
               info = { title: name.replace(/\.[^.]+$/, ""), artist: "", album: "", duration: 0, genres: [], lyrics: "", cover: null };
          }
          let hasCover = false;
          if (info.cover) {
               try {
                    const picture = normalisePicture(info.cover);
                    await put("covers", `track:${id}`, new Blob([picture.bytes], { type: picture.mime }));
                    hasCover = true;
               } catch {
                    /* an unreadable embedded picture never stops a song being added */
               }
          }
          await put("files", id, new Blob([buffer], { type: AUDIO_TYPES[ext] }));
          const track = {
               id,
               title: info.title,
               artist: info.artist,
               album: info.album,
               type: "",
               genres: info.genres,
               duration: info.duration,
               ext,
               hasCover,
               coverVersion: 0,
               added: Math.floor(Date.now() / 1000),
               hash,
               fileLyrics: info.lyrics || "",
               seq: seq++,
          };
          await put("tracks", id, track);
          fresh.push(track);
          added.push(await publicTrack(track));
     }
     await prepareInBackground(fresh);
     return { added, rejected, duplicates };
}

async function deleteTrack(id) {
     await findTrack(id);
     for (const [key, playlist] of await entries("playlists"))
          if (playlist.trackIds.includes(id)) await put("playlists", key, { ...playlist, trackIds: playlist.trackIds.filter(t => t !== id) });
     await Promise.all([
          remove("tracks", id),
          remove("files", id),
          remove("covers", `track:${id}`),
          remove("lyrics", id),
          remove("jobs", id),
          ...STEMS.map(stem => remove("stems", `${id}/${stem}`)),
     ]);
     announce({ type: "forget", id });
     return { ok: true };
}

async function editTrack(id, body) {
     const track = await findTrack(id);
     const fields = {};
     for (const key of ["title", "artist", "album"]) if (key in body) fields[key] = tidy(body[key], 200);
     if ("type" in body) {
          const kind = String(body.type ?? "").trim().toLowerCase();
          if (kind && !TYPES.includes(kind)) throw new Problem(400, "Unknown type. Choose Happy, Sad, Quiet or Energetic.");
          fields.type = kind;
     }
     if ("genres" in body) {
          const values = Array.isArray(body.genres) ? body.genres : body.genres == null ? [] : [body.genres];
          fields.genres = (await core).cleanGenres(values.map(String));
     }
     if ("title" in fields && !fields.title) throw new Problem(400, "A song needs a title.");
     const changed = { ...track, ...fields };
     await put("tracks", id, changed);
     return publicTrack(changed);
}

async function picture(request) {
     const form = await request.formData();
     const upload = form.get("image");
     if (!upload || typeof upload === "string") throw new Problem(400, "No picture was sent.");
     if (upload.size > MAX_PICTURE) throw new Problem(400, "That picture is too large (the limit is 40 MB).");
     try {
          return (await core).normalisePicture(new Uint8Array(await upload.arrayBuffer()));
     } catch (error) {
          throw new Problem(400, typeof error === "string" ? error : "That file is not a picture Lewisis' Music can open.");
     }
}

// ───────────── lyrics ─────────────
async function describeLyrics(track) {
     const saved = await get("lyrics", track.id);
     if (saved?.source === "removed") return { found: false, source: null, instrumental: false, synced: false, lines: [], text: "", removed: true };
     const [source, text, instrumental] = saved ? [saved.source, saved.text || "", !!saved.instrumental] : ["file", track.fileLyrics || "", false];
     const parsed = (await core).parseLyrics(text);
     const found = instrumental || parsed.lines.length > 0;
     return { found, source: found ? source : null, instrumental, synced: parsed.synced, lines: parsed.lines, text: found ? text : "" };
}

// Sends the song's title, artist and length to lrclib.net (only when asked).
async function searchLyrics(track) {
     const { searchTitles, bestLyrics } = await core;
     const title = (track.title || "").trim(), artist = (track.artist || "").trim();
     if (title) {
          for (const name of searchTitles(title)) {
               const params = new URLSearchParams(artist ? { track_name: name, artist_name: artist } : { q: name });
               let response;
               try {
                    response = await fetch(`${LRCLIB}/search?${params}`, { headers: { Accept: "application/json" } });
               } catch {
                    throw new Problem(502, "Could not reach the lyrics service. Check your internet connection.");
               }
               if (response.status === 404) continue;
               if (!response.ok) throw new Problem(502, `The lyrics service answered with an error (${response.status}).`);
               const results = await response.json().catch(() => []);
               const match = bestLyrics(Array.isArray(results) ? results : [], Number(track.duration) || 0);
               if (match) {
                    await put("lyrics", track.id, { source: "online", text: match.text, instrumental: match.instrumental });
                    break;
               }
          }
     }
     return { ...(await describeLyrics(track)), searched: true };
}

// ───────────── playlists ─────────────
async function cleanTrackIds(ids) {
     const known = new Set((await ordered("tracks")).map(t => t.id));
     const seen = new Set();
     return (Array.isArray(ids) ? ids : []).filter(id => known.has(id) && !seen.has(id) && seen.add(id));
}
const cleanName = name => String(name ?? "").trim().slice(0, 80) || "New Playlist";

// ───────────── the routes (the same as server.py) ─────────────
async function route(request, url) {
     const method = request.method.toUpperCase();
     const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map(decodeURIComponent);
     const body = async () => (method === "GET" || method === "DELETE" ? {} : request.json().catch(() => ({})));
     const is = (verb, ...pattern) => method === verb && parts.length === pattern.length && pattern.every((p, i) => p === "*" || p === parts[i]);
     const id = parts[2];

     if (is("GET", "api", "tracks")) return json(await Promise.all((await ordered("tracks")).map(publicTrack)));
     if (is("POST", "api", "tracks")) {
          const form = await request.formData();
          const files = form.getAll("files").filter(f => typeof f !== "string");
          return json(await addSongs(files, url.searchParams.get("skipDuplicates") === "1"));
     }
     if (is("DELETE", "api", "tracks", "*")) return json(await deleteTrack(id));
     if (is("PUT", "api", "tracks", "*")) return json(await editTrack(id, await body()));
     if (is("POST", "api", "tracks", "*", "cover")) {
          const track = await findTrack(id);
          const p = await picture(request);
          await put("covers", `track:${id}`, new Blob([p.bytes], { type: p.mime }));
          const changed = { ...track, hasCover: true, coverVersion: Date.now() };
          await put("tracks", id, changed);
          return json(await publicTrack(changed));
     }
     if (is("DELETE", "api", "tracks", "*", "cover")) {
          const track = await findTrack(id);
          await remove("covers", `track:${id}`);
          const changed = { ...track, hasCover: false, coverVersion: Date.now() };
          await put("tracks", id, changed);
          return json(await publicTrack(changed));
     }
     if (is("GET", "api", "tracks", "*", "audio")) {
          await findTrack(id);
          const stem = url.searchParams.get("stem") || "original";
          if (stem !== "original" && !STEMS.includes(stem)) throw new Problem(400, "Unknown stem");
          const blob = await get(stem === "original" ? "files" : "stems", stem === "original" ? id : `${id}/${stem}`);
          if (!blob) throw new Problem(404, "Audio not available");
          return serveBlob(request, blob);
     }
     if (is("GET", "api", "tracks", "*", "cover") || is("GET", "api", "playlists", "*", "cover")) {
          const blob = await get("covers", `${parts[1] === "tracks" ? "track" : "playlist"}:${id}`);
          if (!blob) return new Response(null, { status: 404 });
          return serveBlob(request, blob, { "Cache-Control": "max-age=86400" });
     }
     if (is("GET", "api", "tracks", "*", "lyrics")) return json(await describeLyrics(await findTrack(id)));
     if (is("PUT", "api", "tracks", "*", "lyrics")) {
          const track = await findTrack(id);
          const text = String((await body()).text ?? "").trim();
          if (!text) throw new Problem(400, "There are no lyrics to save.");
          await put("lyrics", id, { source: "manual", text, instrumental: false });
          return json(await describeLyrics(track));
     }
     if (is("DELETE", "api", "tracks", "*", "lyrics")) {
          const track = await findTrack(id);
          await put("lyrics", id, { source: "removed", text: "", instrumental: false });
          return json(await describeLyrics(track));
     }
     if (is("POST", "api", "tracks", "*", "lyrics", "search")) return json(await searchLyrics(await findTrack(id)));

     if (is("GET", "api", "playlists")) return json((await ordered("playlists")).map(publicPlaylist));
     if (is("POST", "api", "playlists")) {
          const b = await body();
          const playlist = {
               id: newId(),
               created: Math.floor(Date.now() / 1000),
               name: cleanName(b.name),
               trackIds: await cleanTrackIds(b.trackIds),
               hasCover: false,
               coverVersion: 0,
               seq: await nextSeq("playlists"),
          };
          await put("playlists", playlist.id, playlist);
          return json(publicPlaylist(playlist));
     }
     if (is("PUT", "api", "playlists", "*")) {
          const playlist = await findPlaylist(id);
          const b = await body();
          if ("name" in b) playlist.name = cleanName(b.name);
          if ("trackIds" in b) playlist.trackIds = await cleanTrackIds(b.trackIds);
          await put("playlists", id, playlist);
          return json(publicPlaylist(playlist));
     }
     if (is("DELETE", "api", "playlists", "*")) {
          await findPlaylist(id);
          await remove("playlists", id);
          await remove("covers", `playlist:${id}`);
          return json({ ok: true });
     }
     if (is("POST", "api", "playlists", "*", "cover")) {
          const playlist = await findPlaylist(id);
          const p = await picture(request);
          await put("covers", `playlist:${id}`, new Blob([p.bytes], { type: p.mime }));
          const changed = { ...playlist, hasCover: true, coverVersion: Date.now() };
          await put("playlists", id, changed);
          return json(publicPlaylist(changed));
     }
     if (is("DELETE", "api", "playlists", "*", "cover")) {
          const playlist = await findPlaylist(id);
          await remove("covers", `playlist:${id}`);
          const changed = { ...playlist, hasCover: false, coverVersion: Date.now() };
          await put("playlists", id, changed);
          return json(publicPlaylist(changed));
     }

     // AI separation: queued here, done by the page (see browser.js).
     if (is("POST", "api", "tracks", "*", "separate")) {
          await findTrack(id);
          const job = await get("jobs", id);
          if (!job || job.state === "error" || job.state === "none" || (job.state === "queued" && !job.urgent))
               await put("jobs", id, { state: "queued", progress: 0, urgent: true, queuedAt: Date.now() });
          announce({ type: "queue" });
          return json(await status(id));
     }
     if (is("GET", "api", "stems")) {
          const all = {};
          for (const track of await ordered("tracks")) all[track.id] = await status(track.id);
          return json(all);
     }
     if (is("GET", "api", "settings")) return json(await settings());
     if (is("PUT", "api", "settings")) {
          const b = await body();
          const current = await settings();
          if ("autoPrepare" in b) current.autoPrepare = !!b.autoPrepare;
          await put("settings", "settings", current);
          if (current.autoPrepare) await prepareInBackground();
          else {
               for (const [key, job] of await entries("jobs")) if (job.state === "queued" && !job.urgent) await remove("jobs", key);
               announce({ type: "queue" });
          }
          return json(current);
     }
     if (is("POST", "api", "images", "convert")) {
          const p = await picture(request);
          return new Response(new Blob([p.bytes], { type: p.mime }), { headers: { "Content-Type": p.mime } });
     }
     throw new Problem(404, `Unknown request: ${method} ${url.pathname}`);
}
