/* Lewisis' Music — the desktop app's bridge (Tauri 2).
 *
 * Loaded before app.js. In a normal browser (the web version) it does nothing
 * and app.js talks to the Flask server as always. In the desktop app it
 * provides, as `window.LewisisDesktop`:
 *
 *   fetch(path, options)  the same /api/... requests, answered by Rust through
 *                         Tauri commands, returned as real `Response` objects
 *   audio, follower       stand-ins for the two <audio> elements: the sound
 *                         comes from the native engine (decoding, speed,
 *                         reverb and the Separate Audio mix all happen in Rust)
 *   player                the engine's volume / mix / reverb / loop controls
 *   coverUrl()            cover pictures through the read-only media: protocol
 *   pickSongs(), importFiles()   the native "Add music" file picker
 */
(() => {
     "use strict";

     const tauri = window.__TAURI__;
     if (!tauri?.core) {
          window.LewisisDesktop = null;
          return;
     }
     const { invoke } = tauri.core;
     const dialog = tauri.dialog;
     // Linux and macOS draw the window with WebKit; Windows uses Chromium
     // (WebView2), like the browsers the web version is made for. A few
     // effects are done differently on WebKit (see app.js and style.css).
     const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium|Edg\//.test(navigator.userAgent);
     document.documentElement.classList.add("desktop-app");
     if (webkit) {
          document.documentElement.classList.add("webkit-view");
          // style.css blurs the page itself while a dialog is open (WebKit leaves
          // backdrop blurs out of its view-transition pictures). These two
          // classes say when; a watcher is much cheaper here than :has().
          const dialogs = [...document.querySelectorAll("dialog.dialog")];
          const mark = () => {
               const open = dialogs.filter(d => d.open && !d.classList.contains("closing"));
               document.documentElement.classList.toggle("dialog-open", open.length > 0);
               document.documentElement.classList.toggle("settings-open", open.some(d => d.classList.contains("settings")));
          };
          const watcher = new MutationObserver(mark);
          dialogs.forEach(d => watcher.observe(d, { attributes: true, attributeFilter: ["open", "class"] }));
     }

     // ───────────── diagnostics ─────────────
     // Interface errors go to the app's log file as well as the console.
     const log = (level, message) =>
          invoke("plugin:log|log", { level, message: String(message), keyValues: {} }).catch(() => {});
     window.addEventListener("error", event => log(5, `${event.message} (${event.filename}:${event.lineno})`));
     window.addEventListener("unhandledrejection", event => log(5, `Unhandled: ${event.reason?.stack || event.reason}`));

     // ───────────── the /api/... requests ─────────────
     const json = (data, status = 200) =>
          new Response(JSON.stringify(data ?? {}), { status, headers: { "Content-Type": "application/json" } });

     // A file from a FormData upload, sent to Rust as raw bytes.
     async function upload(path, name, blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return invoke("api_upload", bytes, {
               headers: { "x-path": encodeURIComponent(path), "x-name": encodeURIComponent(name || "") },
          });
     }

     const sniffImage = bytes => (bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg");

     // Errors from the Rust side arrive as { status, error, ... } (the same
     // fields the Flask version answered with).
     function errorResponse(error) {
          if (error && typeof error === "object" && "status" in error) {
               const { status, ...rest } = error;
               return json(rest, status);
          }
          log(5, `Request failed: ${error?.stack || error}`);
          return json({ error: String(error?.message || error || "Something went wrong.") }, 500);
     }

     async function desktopFetch(path, options = {}) {
          const method = (options.method || "GET").toUpperCase();
          const body = options.body;
          try {
               if (body instanceof FormData) {
                    if (path.startsWith("/api/images/convert")) {
                         const file = body.get("image");
                         const bytes = new Uint8Array(await upload(path, file?.name, file));
                         const type = sniffImage(bytes);
                         return new Response(new Blob([bytes], { type }), { status: 200, headers: { "Content-Type": type } });
                    }
                    if (/^\/api\/tracks\/?(\?|$)/.test(path)) {
                         // Several songs: one call each, results merged like the server did.
                         const merged = { added: [], rejected: [], duplicates: [] };
                         for (const file of body.getAll("files")) {
                              try {
                                   const result = await upload(path, file.name, file);
                                   merged.added.push(...(result.added || []));
                                   merged.rejected.push(...(result.rejected || []));
                                   merged.duplicates.push(...(result.duplicates || []));
                              } catch (error) {
                                   log(4, `Could not add ${file.name}: ${error?.error || error}`);
                                   merged.rejected.push(file.name);
                              }
                         }
                         return json(merged);
                    }
                    const file = body.get("image");
                    if (!file) return json({ error: "No picture was sent." }, 400);
                    return json(await upload(path, file.name || "picture", file));
               }
               const data = await invoke("api", {
                    method,
                    path,
                    body: typeof body === "string" && body ? JSON.parse(body) : null,
               });
               return json(data);
          } catch (error) {
               // Separation without its model: offer to install it, then try again.
               if (error?.needsModel && (await offerModel())) return desktopFetch(path, options);
               return errorResponse(error);
          }
     }

     // ───────────── the separation model ─────────────
     let offering = null;
     function offerModel() {
          offering ||= (async () => {
               try {
                    const choose = await dialog.ask(
                         "Separate Audio, Acapella and Karaoke use an AI model file (htdemucs.onnx) that isn't installed yet.\n\nChoose the model file now?",
                         { title: "Install separation model", kind: "info", okLabel: "Choose File…", cancelLabel: "Not Now" },
                    );
                    if (!choose) return false;
                    // Rust opens the file picker itself and checks the model loads.
                    return !!(await invoke("install_model"));
               } catch (error) {
                    await dialog.message(error?.error || String(error), { title: "Install separation model", kind: "error" });
                    return false;
               } finally {
                    setTimeout(() => (offering = null));
               }
          })();
          return offering;
     }

     // ───────────── covers ─────────────
     // Custom protocols are media://localhost/… on Linux and macOS, and
     // http://media.localhost/… on Windows.
     const MEDIA = /Windows/.test(navigator.userAgent) ? "http://media.localhost/" : "media://localhost/";
     const coverUrl = (kind, id, version) => `${MEDIA}${kind}/${encodeURIComponent(id)}?v=${version || 0}`;

     // ───────────── "Add Music" and Migrate ─────────────
     // The system's own file and folder pickers, opened by Rust; only what is
     // picked there can be imported.
     const pickSongs = () => invoke("pick_songs"); // [{ path, name }]
     // Settings › Migrate: the chosen folder's files as the web version's
     // folder input gives them, [{ file: { name, path }, path: "Folder/sub/song.mp3" }],
     // or null if cancelled.
     async function pickFolder() {
          const folder = await invoke("pick_folder");
          if (!folder) return null;
          return folder.files.map(({ path, rel }) => ({ file: { name: rel.split("/").pop(), path }, path: rel }));
     }
     const importFiles = (files, skipDuplicates = false) =>
          invoke("import_files", { paths: files.map(f => f.path), skipDuplicates });

     // ───────────── the player ─────────────
     // Behaves like the parts of HTMLAudioElement that app.js uses: src,
     // play(), pause(), currentTime, duration, paused, ended, playbackRate,
     // preservesPitch, and the usual events.
     class NativeAudio extends EventTarget {
          constructor(main = null) {
               super();
               this.main = main; // set on the follower: it only mirrors the main one
               this._src = "";
               this._paused = true;
               this._ended = false;
               this._position = 0; // seconds, as of _at
               this._at = performance.now();
               this._duration = NaN;
               this._rate = 1;
               this._keepPitch = true;
               this._loading = null;
               this._loadId = 0;
               this._speedQueued = false;
               this.error = null;
               this.readyState = 0;
               this.preload = "auto";
               this.defaultPlaybackRate = 1;
               this.mozPreservesPitch = this.webkitPreservesPitch = true;
          }
          _emit(type) {
               this.dispatchEvent(new Event(type));
          }

          get src() {
               return this._src ? new URL(this._src, location.href).href : "";
          }
          set src(value) {
               this._src = String(value || "");
               if (!this.main) this._scheduleLoad();
          }
          getAttribute(name) {
               return name === "src" ? this._src || null : null;
          }
          removeAttribute(name) {
               if (name === "src") this._src = "";
          }
          load() {
               if (!this.main && !this._src) {
                    this._loadId++;
                    this._loading = null;
                    this._paused = true;
                    this._duration = NaN;
                    this._position = 0;
                    invoke("player_unload").catch(() => {});
               }
          }

          // Both src assignments for Separate Audio happen in the same task,
          // so the actual load waits a microtask to see whether the follower
          // got the instruments too.
          _scheduleLoad() {
               const id = ++this._loadId;
               this._paused = true;
               this._ended = false;
               this._position = 0;
               this._at = performance.now();
               this._duration = NaN;
               this.readyState = 0;
               this.error = null;
               this._loading = new Promise(resolve => queueMicrotask(resolve)).then(() => this._load(id));
          }
          async _load(id) {
               if (id !== this._loadId) return;
               const match = this._src.match(/\/api\/tracks\/([^/]+)\/audio\?stem=(\w+)/);
               if (!match) return;
               const trackId = decodeURIComponent(match[1]);
               let stem = match[2];
               const partner = desktop.follower._src;
               if (stem === "vocals" && partner.includes(`/api/tracks/${match[1]}/audio?stem=instrumental`)) stem = "mix";
               this._emit("loadstart");
               try {
                    const { duration } = await invoke("player_load", { trackId, stem, start: 0 });
                    if (id !== this._loadId) return;
                    this._duration = Number.isFinite(duration) ? duration : NaN;
                    this.readyState = 4;
                    for (const type of ["durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) this._emit(type);
               } catch (error) {
                    if (id !== this._loadId) return;
                    this.error = { code: 4, message: error?.error || String(error) };
                    log(4, `Could not play ${trackId} (${stem}): ${this.error.message}`);
                    this._emit("error");
               }
          }

          play() {
               if (this.main) return Promise.resolve();
               if (!this._src) return Promise.reject(new DOMException("There is no song to play.", "NotSupportedError"));
               const id = this._loadId;
               const starting = this._paused;
               this._position = this.currentTime;
               this._at = performance.now();
               this._paused = false;
               this._ended = false;
               if (starting) this._emit("play");
               return (this._loading || Promise.resolve())
                    .then(() => {
                         if (id !== this._loadId || this._paused) throw new DOMException("The play() request was interrupted.", "AbortError");
                         if (this.error) throw new DOMException(this.error.message, "NotSupportedError");
                         return invoke("player_play");
                    })
                    .then(() => {
                         this._at = performance.now();
                         this._emit("playing");
                    })
                    .catch(error => {
                         if (error?.name !== "AbortError" && id === this._loadId) {
                              this._paused = true;
                              this._emit("pause");
                         }
                         throw error;
                    });
          }
          pause() {
               if (this.main || this._paused) return;
               this._position = this.currentTime;
               this._at = performance.now();
               this._paused = true;
               invoke("player_pause").catch(() => {});
               this._emit("pause");
          }

          get paused() {
               return this.main ? this.main.paused : this._paused;
          }
          get ended() {
               return this.main ? this.main.ended : this._ended;
          }
          get duration() {
               return this.main ? this.main.duration : this._duration;
          }
          get currentTime() {
               if (this.main) return this.main.currentTime;
               let time = this._position;
               if (!this._paused) {
                    const moved = ((performance.now() - this._at) / 1000) * this._rate;
                    time += moved;
                    // The engine jumps back at the loop's end dot by itself.
                    const loop = player.region;
                    if (loop && this._position <= (loop.end ?? this._duration) && time > (loop.end ?? this._duration)) {
                         const end = loop.end ?? this._duration;
                         const length = end - loop.start;
                         if (length > 0) time = loop.start + ((time - end) % length);
                    }
               }
               if (Number.isFinite(this._duration)) time = Math.min(time, this._duration);
               return Math.max(0, time);
          }
          set currentTime(value) {
               if (this.main) return;
               const seconds = Math.max(0, Number(value) || 0);
               const id = this._loadId;
               this._position = seconds;
               this._at = performance.now();
               this._ended = false;
               this._emit("seeking");
               (this._loading || Promise.resolve())
                    .then(() => (id === this._loadId ? invoke("player_seek", { seconds }) : null))
                    .then(() => {
                         if (id !== this._loadId) return;
                         this._at = performance.now();
                         this._emit("timeupdate");
                         this._emit("seeked");
                    })
                    .catch(() => {});
          }

          get playbackRate() {
               return this.main ? this.main.playbackRate : this._rate;
          }
          set playbackRate(value) {
               if (this.main) return;
               this._position = this.currentTime;
               this._at = performance.now();
               this._rate = Number(value) || 1;
               this._syncSpeed();
          }
          get preservesPitch() {
               return this.main ? this.main.preservesPitch : this._keepPitch;
          }
          set preservesPitch(value) {
               if (this.main) return;
               this._keepPitch = !!value;
               this._syncSpeed();
          }
          _syncSpeed() {
               if (this._speedQueued) return;
               this._speedQueued = true;
               queueMicrotask(() => {
                    this._speedQueued = false;
                    invoke("player_speed", { speed: this._rate, keepPitch: this._keepPitch }).catch(() => {});
               });
          }

          // A status report from the engine.
          _status(status) {
               if (this.main || !this._src) return;
               if (Number.isFinite(status.duration) && status.duration > 0 && status.duration !== this._duration) {
                    this._duration = status.duration;
                    this._emit("durationchange");
               }
               if (status.error) {
                    this.error = { code: 3, message: status.error };
                    log(4, `Playback error: ${status.error}`);
                    this._emit("error");
                    return;
               }
               if (status.ended) {
                    this._position = Number.isFinite(this._duration) ? this._duration : status.position;
                    this._at = performance.now();
                    this._paused = true;
                    this._ended = true;
                    this._emit("timeupdate");
                    this._emit("pause");
                    this._emit("ended");
                    return;
               }
               if (!this._paused && status.playing) {
                    this._position = status.position;
                    this._at = performance.now();
                    this._emit("timeupdate");
               }
          }
     }

     // ───────────── engine controls used by app.js ─────────────
     const player = {
          region: null,
          _regionKey: "null",
          volume: gain => invoke("player_volume", { gain }).catch(() => {}),
          layers: (vocals, music) => invoke("player_layers", { vocals, music }).catch(() => {}),
          reverb: (kind, amount) => invoke("player_reverb", { kind, amount }).catch(() => {}),
          // The A–B loop ({ start, end }, end null = the end of the song), or null.
          loop(region) {
               const key = JSON.stringify(region);
               if (key === this._regionKey) return;
               this._regionKey = key;
               this.region = region;
               invoke("player_loop", { region }).catch(() => {});
          },
     };

     const audio = new NativeAudio();
     const follower = new NativeAudio(audio);
     const desktop = {
          fetch: desktopFetch,
          audio,
          follower,
          player,
          coverUrl,
          pickSongs,
          pickFolder,
          importFiles,
          webkit,
     };
     window.LewisisDesktop = desktop;

     tauri.event.listen("player-status", event => audio._status(event.payload));
     invoke("app_info")
          .then(info => log(3, `Interface ready (version ${info.version}; data in ${info.data})`))
          .catch(() => {});
})();
