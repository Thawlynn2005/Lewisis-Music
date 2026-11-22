/* Lewisis' Music — player logic.
 *
 * Audio path:  <audio> ──► dry gain ─────────────► master gain ──► speakers
 *                     └──► convolver ─► wet gain ──┘
 * Speed is the element's playbackRate; reverb is the dry/wet balance through
 * a convolver whose impulse response depends on the chosen reverb type.
 * Acapella / karaoke swap the element's source to an AI-separated stem.
 */
(() => {
     "use strict";

     // The desktop app's bridge (desktop.js); null in a normal browser.
     const desktop = window.LewisisDesktop || null;

     const $ = selector => document.querySelector(selector);
     const ICON = {
          play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
          pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
          loop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
          loopOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>',
          volume: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
          muted: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>',
          note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
          search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
          edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
          more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
          check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
          close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
          camera: '<svg viewBox="0 0 24 24"><path d="M9 3 7.17 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.17L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.2a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z"/></svg>',
          playlist:
               '<svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18a3 3 0 1 0 3 3V8h3V6h-5z"/></svg>',
     };
     const MODE_LABEL = { vocals: "Acapella", instrumental: "Karaoke", mix: "Separated" };
     const SETTINGS_KEY = "lewisis-music.settings";
     const THEME_KEY = "lewisis-music.theme";
     const MOTION_KEY = "lewisis-music.motion";
     const UI_KEY = "lewisis-music.ui";
     const ACCENT_KEY = "lewisis-music.accent";
     const SIDEBAR_KEY = "lewisis-music.sidebar";
     const AUTO_LYRICS_KEY = "lewisis-music.autoLyrics";
     const SHOW_LYRICS_KEY = "lewisis-music.showLyrics";
     const NP_BAR_KEY = "lewisis-music.npBar";
     const NP_SOUND_KEY = "lewisis-music.npSound";

     // Settings › Customization: "Theme" is the UI style, "Colour" the accent. The ids match [data-ui] / [data-accent] in the stylesheets.
     const UI_STYLES = [
          { id: "default", label: "Default", hint: "Clean floating panels" },
          {
               id: "skeuo",
               label: "Skeuomorphism",
               hint: "Metal, knobs and real buttons",
          },
          {
               id: "maximal",
               label: "Maximalism",
               hint: "Loud, bold and playful",
          },
          { id: "minimal", label: "Minimalism", hint: "Only what is needed" },
          {
               id: "clay",
               label: "Claymorphism",
               hint: "Soft, puffy and friendly",
          },
          {
               id: "liquid",
               label: "Liquid Glass",
               hint: "Clear glass that bends light",
          },
          {
               id: "flat",
               label: "Flat Design",
               hint: "Solid colour, no shadows",
          },
          {
               id: "fluent",
               label: "Fluent Design",
               hint: "Calm layers and soft light",
          },
          {
               id: "material",
               label: "Material Design",
               hint: "Tonal colour and ripples",
          },
     ];
     const ACCENTS = [
          { id: "red", label: "Red", color: "#dc143c" },
          { id: "orange", label: "Orange", color: "#c9420d" },
          { id: "gold", label: "Gold", color: "#f2b01e", on: "#241a00" },
          { id: "green", label: "Green", color: "#15803d" },
          { id: "teal", label: "Teal", color: "#0f7b80" },
          { id: "blue", label: "Blue", color: "#2563eb" },
          { id: "purple", label: "Purple", color: "#7c3aed" },
          { id: "pink", label: "Pink", color: "#d6246e" },
     ];

     // Each reverb type is a recipe for a synthetic impulse response: how long it
     // rings (seconds), how fast it dies away (decay), the gap before it starts
     // (preDelay), how dull the tail gets (damping, start → end), how many early
     // wall reflections there are, and optionally a metallic ring (flutter).
     // A song's mood ("Type"), chosen by the listener in Edit Song Info.
     const TYPES = [
          { id: "happy", label: "Happy", color: "#e8a400" },
          { id: "sad", label: "Sad", color: "#3b82f6" },
          { id: "quiet", label: "Quiet", color: "#8b7cf6" },
          { id: "energetic", label: "Energetic", color: "#f0532d" },
     ];
     const typeById = id => TYPES.find(t => t.id === id);
     // Offered while typing genres; any other genre can be typed in too.
     const GENRE_SUGGESTIONS = [
          "Pop", "Rock", "Rap", "Hip-Hop", "R&B", "Indie", "Alternative", "Electronic",
          "EDM", "House", "Future House", "Progressive House", "Deep House", "Techno",
          "Trance", "Dubstep", "Drum & Bass", "Lo-fi", "Jazz", "Classical", "Soul",
          "Country", "Folk", "Metal", "K-Pop", "Latin", "Reggaeton", "Acoustic",
     ];

     const REVERBS = {
          room: {
               label: "Room",
               seconds: 0.9,
               decay: 3.2,
               preDelay: 0.004,
               damping: [0.25, 0.75],
               early: 6,
               level: 1.5,
          },
          studio: {
               label: "Studio",
               seconds: 0.45,
               decay: 3.6,
               preDelay: 0.002,
               damping: [0.12, 0.55],
               early: 4,
               level: 1.3,
          },
          chamber: {
               label: "Chamber",
               seconds: 1.5,
               decay: 2.8,
               preDelay: 0.008,
               damping: [0.3, 0.8],
               early: 7,
               level: 1.5,
          },
          hall: {
               label: "Hall",
               seconds: 2.8,
               decay: 2.4,
               preDelay: 0.02,
               damping: [0.3, 0.85],
               early: 8,
               level: 1.6,
          },
          cathedral: {
               label: "Cathedral",
               seconds: 6.5,
               decay: 1.9,
               preDelay: 0.045,
               damping: [0.45, 0.93],
               early: 10,
               level: 1.7,
          },
          arena: {
               label: "Arena",
               seconds: 4.5,
               decay: 2.1,
               preDelay: 0.07,
               damping: [0.2, 0.86],
               early: 14,
               level: 1.7,
          },
          cave: {
               label: "Cave",
               seconds: 5.5,
               decay: 1.6,
               preDelay: 0.03,
               damping: [0.62, 0.96],
               early: 14,
               level: 1.9,
          },
          tunnel: {
               label: "Tunnel",
               seconds: 2.8,
               decay: 2.2,
               preDelay: 0.012,
               damping: [0.2, 0.7],
               early: 6,
               level: 1.0,
               flutter: { delay: 0.043, feedback: 0.8 },
          },
          plate: {
               label: "Plate",
               seconds: 2.0,
               decay: 2.9,
               preDelay: 0,
               damping: [0.04, 0.3],
               early: 0,
               level: 1.4,
          },
     };

     const el = {
          list: $("#trackList"),
          tableHead: $("#tableHead"),
          emptyLibrary: $("#emptyLibrary"),
          emptyPlaylist: $("#emptyPlaylist"),
          noResults: $("#noResults"),
          hotkeyList: $("#hotkeyList"),
          hkResetAll: $("#hkResetAll"),
          hud: $("#hud"),
          folderInput: $("#folderInput"),
          migChoose: $("#migChoose"),
          migCard: $("#migCard"),
          migIcon: $("#migIcon"),
          migFolder: $("#migFolder"),
          migSummary: $("#migSummary"),
          migBar: $("#migBar"),
          migNow: $("#migNow"),
          migIssues: $("#migIssues"),
          migStart: $("#migStart"),
          migStop: $("#migStop"),
          migShow: $("#migShow"),
          noResultsText: $("#noResultsText"),
          noResultsClear: $("#noResultsClear"),
          filterBar: $("#filterBar"),
          filterClear: $("#filterClear"),
          filterCount: $("#filterCount"),
          filterChips: [...document.querySelectorAll(".filter-chip")],
          viewArt: $("#viewArt"),
          viewKind: $("#viewKind"),
          viewTitle: $("#viewTitle"),
          viewSub: $("#viewSub"),
          playAll: $("#playAllBtn"),
          shuffleAll: $("#shuffleAllBtn"),
          addMusic: $("#addMusicBtn"),
          editPlaylist: $("#editPlaylistBtn"),
          deletePlaylist: $("#deletePlaylistBtn"),
          search: $("#search"),
          playlistNav: $("#playlistNav"),
          fileInput: $("#fileInput"),
          drop: $("#dropOverlay"),
          cover: $("#cover"),
          title: $("#title"),
          artist: $("#artist"),
          modeTag: $("#modeTag"),
          seek: $("#seek"),
          seekTrack: $(".seek-track"),
          loopRange: $("#loopRange"),
          loopA: $("#loopA"),
          loopB: $("#loopB"),
          cur: $("#curTime"),
          dur: $("#durTime"),
          play: $("#playBtn"),
          prev: $("#prevBtn"),
          next: $("#nextBtn"),
          shuffle: $("#shuffleBtn"),
          loop: $("#loopBtn"),
          mute: $("#muteBtn"),
          mixVocals: $("#mixVocals"),
          mixMusic: $("#mixMusic"),
          mixer: $("#mixer"),
          volume: $("#volume"),
          speed: $("#speed"),
          speedVal: $("#speedVal"),
          keepPitch: $("#keepPitch"),
          reverb: $("#reverb"),
          reverbVal: $("#reverbVal"),
          reverbTypes: $("#reverbTypes"),
          stemBtns: [...document.querySelectorAll(".stem-btn")],
          stemBar: $("#stemBar"),
          stemText: $("#stemText"),
          autoPrepare: $("#autoPrepare"),
          prepLabel: $("#prepLabel"),
          menu: $("#menu"),
          toasts: $("#toasts"),
          dialog: $("#playlistDialog"),
          dlgForm: $("#playlistForm"),
          dlgTitle: $("#dlgTitle"),
          dlgName: $("#dlgName"),
          dlgFilter: $("#dlgFilter"),
          dlgSongs: $("#dlgSongs"),
          dlgEmpty: $("#dlgEmpty"),
          dlgCount: $("#dlgCount"),
          dlgCancel: $("#dlgCancel"),
          dlgSave: $("#dlgSave"),
          settings: $("#settingsDialog"),
          setModules: $("#setModules"),
          accentChoices: $("#accentChoices"),
          accentName: $("#accentName"),
          uiChoices: $("#uiChoices"),
          uiName: $("#uiName"),
          favicon: $("#favicon"),
          dlgPhoto: $("#dlgPhoto"),
          dlgPhotoChoose: $("#dlgPhotoChoose"),
          dlgPhotoRemove: $("#dlgPhotoRemove"),
          trackDialog: $("#trackDialog"),
          trackForm: $("#trackForm"),
          trkCover: $("#trkCover"),
          trkCoverChoose: $("#trkCoverChoose"),
          trkCoverRemove: $("#trkCoverRemove"),
          trkName: $("#trkName"),
          trkArtist: $("#trkArtist"),
          trkAlbum: $("#trkAlbum"),
          trkType: $("#trkType"),
          trkGenres: $("#trkGenres"),
          trkGenreChips: $("#trkGenreChips"),
          trkGenreInput: $("#trkGenreInput"),
          trkGenreSuggest: $("#trkGenreSuggest"),
          trkSave: $("#trkSave"),
          trkCancel: $("#trkCancel"),
          imageInput: $("#imageInput"),
          main: $("#main"),
          playerbar: $("#playerbar"),
          sidebarBtn: $("#sidebarBtn"),
          npOpen: $("#npOpen"),
          np: $("#nowPlaying"),
          npDock: $("#npDock"),
          npBack: $("#npBack"),
          npBackdrop: $("#npBackdrop"),
          npArt: $("#npArt"),
          npTitle: $("#npTitle"),
          npArtist: $("#npArtist"),
          lyrics: $("#lyrics"),
          lyricsMenuBtn: $("#lyricsMenuBtn"),
          lyricsDialog: $("#lyricsDialog"),
          lyricsForm: $("#lyricsForm"),
          lyricsText: $("#lyricsText"),
          lyImport: $("#lyImport"),
          lyCancel: $("#lyCancel"),
          lrcInput: $("#lrcInput"),
          autoLyrics: $("#autoLyrics"),
          npBarRow: $("#npBarRow"),
          npSoundRow: $("#npSoundRow"),
          npTray: $("#npTray"),
          foldBar: $("#foldBar"),
          foldSound: $("#foldSound"),
     };
     const root = document.documentElement;
     const motionOn = () => !root.classList.contains("no-motion");
     const remember = (key, value) => {
          try {
               localStorage.setItem(key, value);
          } catch {
               /* private mode */
          }
     };

     const saved = (() => {
          try {
               return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
          } catch {
               return {};
          }
     })();

     const state = {
          tracks: [],
          playlists: [],
          view: "library", // what the song list shows: 'library' or a playlist id
          context: "library", // where the playing queue came from
          queue: [], // track ids in playback order
          current: null, // id of the loaded track
          mode: "original", // what the listener asked for: original | vocals | instrumental
          activeStem: "original", // what is actually loaded in the <audio> element
          wantPlaying: false,
          loading: false,
          seeking: false,
          filter: "",
          loaded: false, // false until the library has arrived (skeletons show meanwhile)
          pendingUploads: 0, // songs being added right now (shown as skeleton rows)
          // Filters on the song list: type ("" any, "none" not set), genres
          // (lower-case, any of them) and one artist (lower-case).
          filters: { type: "", genres: [], artist: "" },
          autoPrepare: true,
          shuffle: !!saved.shuffle,
          loop: ["off", "all", "one"].includes(saved.loop) ? saved.loop : "off",
          volume: clamp(saved.volume ?? 80, 0, 100),
          muted: false,
          speed: clamp(saved.speed ?? 100, 50, 200),
          keepPitch: !!saved.keepPitch,
          reverb: clamp(saved.reverb ?? 0, 0, 100),
          reverbType: REVERBS[saved.reverbType] ? saved.reverbType : "hall",
          mixVocals: clamp(saved.mixVocals ?? 100, 0, 100), // Separate Audio: vocals volume
          mixMusic: clamp(saved.mixMusic ?? 100, 0, 100), // Separate Audio: instruments volume
     };

     const audio = desktop ? desktop.audio : new Audio();
     // Separate Audio plays two files at once: `audio` the vocals and `follower`
     // the instruments. The follower copies everything `audio` does (play,
     // pause, seek, speed) and is nudged back whenever the two drift apart.
     const follower = desktop ? desktop.follower : new Audio();
     follower.preload = "auto";
     audio.preload = "auto";
     let justAdded = new Set(); // ids of rows that should animate in on the next render
     let newPlaylistId = null; // sidebar item that should animate in
     let shownTrackId = null; // track currently shown in the player display

     // ───────────── helpers ─────────────
     function clamp(value, min, max) {
          const n = Number(value);
          return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
     }
     function fmtTime(seconds) {
          if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
          const s = Math.floor(seconds % 60),
               m = Math.floor(seconds / 60) % 60,
               h = Math.floor(seconds / 3600);
          return (
               (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) +
               `:${String(s).padStart(2, "0")}`
          );
     }
     function summary(tracks) {
          if (!tracks.length) return "No songs yet";
          const minutes = Math.max(
               1,
               Math.round(
                    tracks.reduce((sum, t) => sum + (t.duration || 0), 0) / 60,
               ),
          );
          const length =
               minutes >= 60
                    ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
                    : `${minutes} min`;
          return `${tracks.length} song${tracks.length === 1 ? "" : "s"} · ${length}`;
     }
     function tint(id) {
          let hash = 0;
          for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
          return `hsl(${hash % 360} 45% 58%)`;
     }
     // The version changes whenever the picture does, so the browser fetches the new one.
     const coverUrl = track =>
          desktop
               ? desktop.coverUrl("track", track.id, track.coverVersion)
               : `/api/tracks/${track.id}/cover?v=${track.coverVersion || 0}`;
     const playlistCoverUrl = playlist =>
          desktop
               ? desktop.coverUrl("playlist", playlist.id, playlist.coverVersion)
               : `/api/playlists/${playlist.id}/cover?v=${playlist.coverVersion || 0}`;
     const loadedArt = new Set();
     function paintArt(node, track) {
          const hasArt = !!(track && track.hasCover);
          const url = hasArt ? coverUrl(track) : "";
          node.classList.toggle("has-art", hasArt);
          node.classList.remove("art-loading", "art-in");
          node.dataset.art = url;
          node.style.backgroundColor = track && !hasArt ? tint(track.id) : "";
          node.style.backgroundImage =
               hasArt && loadedArt.has(url) ? `url("${url}")` : "";
          if (!hasArt || loadedArt.has(url)) return;
          node.classList.add("art-loading"); // skeleton shimmer until the picture arrives
          const image = new Image();
          image.onload = image.onerror = () => {
               loadedArt.add(url);
               if (node.dataset.art !== url) return; // the node shows something else by now
               node.style.backgroundImage = `url("${url}")`;
               node.classList.replace("art-loading", "art-in");
          };
          image.src = url;
     }
     // Restarts a CSS animation by removing and re-adding its class.
     function replay(node, className) {
          node.classList.remove(className);
          void node.offsetWidth;
          node.classList.add(className);
     }
     const setBuffering = on =>
          document.body.classList.toggle("is-buffering", on);
     const rowFor = id =>
          [...el.list.children].find(row => row.dataset.id === id);
     function animateOut(row) {
          if (!row || !motionOn()) return Promise.resolve();
          row.classList.add("row-out");
          return new Promise(resolve => setTimeout(resolve, 230));
     }
     function skeletonRow() {
          const row = document.createElement("li");
          row.className = "track skeleton-row";
          row.setAttribute("aria-hidden", "true");
          row.innerHTML =
               '<span class="sk sk-num"></span>' +
               '<div class="t-main"><div class="sk sk-thumb"></div><div class="sk sk-line sk-title"></div></div>' +
               '<span class="sk sk-line sk-artist t-artist"></span><span class="sk sk-line sk-album t-album"></span>' +
               '<span class="sk sk-line sk-type t-type"></span><span class="sk sk-line sk-genres t-genres"></span>' +
               '<span class="sk sk-line sk-time"></span><span></span>';
          return row;
     }
     function fill(range) {
          const span = range.max - range.min;
          range.style.setProperty(
               "--p",
               `${span > 0 ? ((range.value - range.min) / span) * 100 : 0}%`,
          );
     }
     function saveSettings() {
          const {
               shuffle,
               loop,
               volume,
               speed,
               keepPitch,
               reverb,
               reverbType,
               mixVocals,
               mixMusic,
          } = state;
          try {
               localStorage.setItem(
                    SETTINGS_KEY,
                    JSON.stringify({
                         shuffle,
                         loop,
                         volume,
                         speed,
                         keepPitch,
                         reverb,
                         reverbType,
                         mixVocals,
                         mixMusic,
                    }),
               );
          } catch {
               /* private mode */
          }
     }
     function toast(message, kind = "") {
          const node = document.createElement("div");
          node.className = `toast ${kind}`;
          node.textContent = message;
          el.toasts.append(node);
          setTimeout(
               () => {
                    node.classList.add("out");
                    setTimeout(() => node.remove(), 350);
               },
               kind === "error" ? 6000 : 3200,
          );
     }
     async function api(path, options) {
          const response = await (desktop ? desktop.fetch : fetch)(path, options);
          const data = await response.json().catch(() => ({}));
          if (!response.ok && !data.error)
               data.error = `Request failed (${response.status})`;
          return data;
     }
     const sendJson = (path, method, body) =>
          api(path, {
               method,
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify(body),
          }).catch(() => ({
               error: "Could not reach the player. Is it still running?",
          }));
     const trackById = id => state.tracks.find(t => t.id === id);
     const playlistById = id => state.playlists.find(p => p.id === id);
     const currentTrack = () => trackById(state.current);
     const audioUrl = (id, stem) => `/api/tracks/${id}/audio?stem=${stem}`;
     // "A, B feat. C" → ["A", "B", "C"], so each artist can be picked on their own.
     function artistsOf(track) {
          return (track.artist || "")
               .split(/\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing)\s*/i)
               .map(name => name.trim())
               .filter(Boolean);
     }
     const filtersOn = () =>
          !!(state.filters.type || state.filters.genres.length || state.filters.artist);
     function matchesFilters(track) {
          const { type, genres, artist } = state.filters;
          if (type === "none" ? track.type : type && track.type !== type) return false;
          if (
               genres.length &&
               !(track.genres || []).some(g => genres.includes(g.toLowerCase()))
          )
               return false;
          if (artist && !artistsOf(track).some(a => a.toLowerCase() === artist))
               return false;
          return true;
     }
     // The songs of a view that pass the filters: what Play and the queue use.
     const filteredTracks = (view = state.view) => viewTracks(view).filter(matchesFilters);

     function viewTracks(view = state.view) {
          if (view === "library") return state.tracks;
          const playlist = playlistById(view);
          return playlist
               ? playlist.trackIds.map(trackById).filter(Boolean)
               : [];
     }

     // ───────────── liquid glass ─────────────
     // In the Liquid Glass style, panels bend whatever is behind them at the rim like
     // a real lens: a displacement map shaped to each panel, used as an SVG
     // backdrop-filter. Only Chromium can do that; elsewhere they stay frosted glass.
     const lens = (() => {
          const TARGETS = [
               [".sidebar, .playerbar, .sound", 5],
               [".menu, .dialog", 16],
          ]; // selector, frost (px)
          const capable =
               /Chrom(e|ium)\//.test(navigator.userAgent) &&
               !!(
                    window.CSS &&
                    CSS.supports &&
                    CSS.supports("backdrop-filter", "url(#x)")
               ) &&
               !window.matchMedia("(prefers-reduced-transparency: reduce)")
                    .matches;
          const built = new Map(); // element → { key, filter, frost, timer }
          let holder = null,
               observer = null,
               serial = 0;

          // Signed distance to a rounded box centred on the origin (negative inside).
          function distance(px, py, halfW, halfH, r) {
               const qx = Math.abs(px) - halfW + r,
                    qy = Math.abs(py) - halfH + r;
               return (
                    Math.min(Math.max(qx, qy), 0) +
                    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) -
                    r
               );
          }
          // How far light bends at a given depth into the rim (0 = edge, 1 = flat middle):
          // the slope of a rounded dome put through Snell's law for glass.
          function bend(depth) {
               const u = 1 - Math.min(1, Math.max(0, depth));
               const flat = Math.pow(1 - u ** 4, 0.75);
               if (flat < 1e-6) return 0;
               const angle = Math.atan(Math.min(u ** 3 / flat, 8));
               return Math.sin(angle - Math.asin(Math.sin(angle) / 1.5));
          }
          // Red = sideways shift, green = vertical shift, mid-grey = none.
          function displacementMap(width, height, radius, bevel) {
               const canvas = document.createElement("canvas");
               canvas.width = width;
               canvas.height = height;
               const context = canvas.getContext("2d");
               const image = context.createImageData(width, height),
                    data = image.data;
               const halfW = width / 2,
                    halfH = height / 2,
                    r = Math.min(radius, halfW, halfH);
               const table = Float32Array.from(
                    { length: bevel + 1 },
                    (_, d) => bend(d / bevel) * 1.35,
               );
               const clamp1 = v => Math.max(-1, Math.min(1, v));
               for (let y = 0; y < height; y++) {
                    const py = y - halfH + 0.5;
                    for (let x = 0; x < width; x++) {
                         const px = x - halfW + 0.5,
                              i = (y * width + x) << 2;
                         const d = distance(px, py, halfW, halfH, r);
                         data[i] = data[i + 1] = data[i + 2] = 128;
                         data[i + 3] = d > 0 ? 0 : 255;
                         if (d > 0 || -d >= bevel) continue;
                         const strength = table[Math.round(-d)];
                         const gx =
                              (distance(px + 1, py, halfW, halfH, r) -
                                   distance(px - 1, py, halfW, halfH, r)) /
                              2;
                         const gy =
                              (distance(px, py + 1, halfW, halfH, r) -
                                   distance(px, py - 1, halfW, halfH, r)) /
                              2;
                         data[i] = 128 + clamp1(-gx * strength) * 127;
                         data[i + 1] = 128 + clamp1(-gy * strength) * 127;
                    }
               }
               context.putImageData(image, 0, 0);
               return canvas.toDataURL();
          }
          function build(node) {
               const entry = built.get(node);
               const width = node.offsetWidth,
                    height = node.offsetHeight;
               if (!entry || width < 24 || height < 24) return;
               const radius =
                    parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
               const key = `${width}x${height}r${radius}`;
               if (entry.key === key) return;
               const bevel = Math.round(Math.min(24, width / 2, height / 2));
               const scale = Math.round(bevel * 1.9);
               const id = `lens-${++serial}`; // a fresh id each time: browsers cache filters by id
               holder.insertAdjacentHTML(
                    "beforeend",
                    `<filter id="${id}" color-interpolation-filters="sRGB" x="-10%" y="-10%" width="120%" height="120%">` +
                         `<feImage href="${displacementMap(width, height, radius, bevel)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="map"/>` +
                         `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`,
               );
               if (entry.filter) entry.filter.remove();
               entry.key = key;
               entry.filter = holder.lastElementChild;
               node.style.backdropFilter = `url(#${id}) blur(${entry.frost}px) saturate(1.8) brightness(1.06)`;
          }
          function stop() {
               if (observer) observer.disconnect();
               observer = null;
               for (const [node, entry] of built) {
                    clearTimeout(entry.timer);
                    node.style.backdropFilter = "";
                    if (entry.filter) entry.filter.remove();
               }
               built.clear();
          }
          function refresh() {
               const on = capable && root.dataset.ui === "liquid";
               root.classList.toggle("lens", on);
               if (!on) {
                    stop();
                    return;
               }
               if (observer) return;
               if (!holder) {
                    holder = document.createElementNS(
                         "http://www.w3.org/2000/svg",
                         "svg",
                    );
                    holder.setAttribute("aria-hidden", "true");
                    holder.style.cssText =
                         "position:absolute;width:0;height:0;overflow:hidden";
                    document.body.append(holder);
               }
               observer = new ResizeObserver(entries => {
                    for (const { target } of entries) {
                         // rebuild once the size has settled
                         const entry = built.get(target);
                         if (!entry) continue;
                         clearTimeout(entry.timer);
                         if (entry.key)
                              entry.timer = setTimeout(
                                   () => build(target),
                                   140,
                              );
                         else build(target);
                    }
               });
               for (const [selector, frost] of TARGETS) {
                    for (const node of document.querySelectorAll(selector)) {
                         built.set(node, {
                              key: "",
                              filter: null,
                              frost,
                              timer: 0,
                         });
                         observer.observe(node);
                    }
               }
          }
          return { refresh };
     })();

     // ───────────── design: light / dark, theme colour, UI style ─────────────
     let themeTimer = null;
     // Applies a change of look. Where the browser can, the new look sweeps out in
     // a circle from `origin` (the control that was pressed); otherwise it cross-fades.
     function restyle(change, origin) {
          if (!motionOn()) {
               change();
               return;
          }
          if (!document.startViewTransition) {
               root.classList.add("theme-anim");
               clearTimeout(themeTimer);
               themeTimer = setTimeout(
                    () => root.classList.remove("theme-anim"),
                    450,
               );
               change();
               return;
          }
          const box = origin ? origin.getBoundingClientRect() : null;
          const x = box ? box.left + box.width / 2 : window.innerWidth / 2;
          const y = box ? box.top + box.height / 2 : window.innerHeight / 2;
          root.style.setProperty("--vt-x", `${x}px`);
          root.style.setProperty("--vt-y", `${y}px`);
          root.style.setProperty(
               "--vt-r",
               `${Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)))}px`,
          );
          // A second change while one is still sweeping simply cuts the first short.
          const transition = document.startViewTransition(change);
          transition.ready.catch(() => {});
          transition.finished.catch(() => {});
     }
     // Marks one option of a radio group as chosen and makes it the tab stop.
     function markChoice(group, isChosen) {
          [...group.querySelectorAll('[role="radio"]')].forEach(
               (radio, index) => {
                    const on = isChosen(radio);
                    radio.setAttribute("aria-checked", String(on));
                    radio.tabIndex = on ? 0 : -1;
                    if (on) group.style.setProperty("--i", index); // where a sliding thumb should sit
               },
          );
     }
     // What the listener has chosen. Kept here, not read back from the page, so that
     // several quick changes in a row always end on the last one chosen.
     const design = {
          theme: root.dataset.theme === "light" ? "light" : "dark",
          accent: (
               ACCENTS.find(a => a.id === root.dataset.accent) || ACCENTS[0]
          ).id,
          ui: (UI_STYLES.find(u => u.id === root.dataset.ui) || UI_STYLES[0])
               .id,
     };
     function renderDesign() {
          const accent = ACCENTS.find(a => a.id === design.accent);
          const style = UI_STYLES.find(u => u.id === design.ui);
          root.dataset.theme = design.theme;
          root.dataset.accent = accent.id;
          root.dataset.ui = style.id;
          markChoice(
               $(".segmented"),
               radio => radio.dataset.themeChoice === design.theme,
          );
          markChoice(
               el.accentChoices,
               radio => radio.dataset.choice === accent.id,
          );
          markChoice(el.uiChoices, radio => radio.dataset.choice === style.id);
          el.accentName.textContent = accent.label;
          el.uiName.textContent = style.label;
          el.favicon.href =
               "data:image/svg+xml," +
               encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${accent.color}"/>` +
                         `<path d="M12.5 9.5v13l10-6.5z" fill="${accent.on || "white"}"/></svg>`,
               );
          lens.refresh();
     }
     // `what` is 'theme', 'accent' or 'ui'; `origin` is the control that was pressed.
     function chooseDesign(what, value, storageKey, origin) {
          if (design[what] === value) return;
          design[what] = value;
          remember(storageKey, value);
          restyle(renderDesign, origin);
          if (what === "accent") replay(el.accentName, "bump");
          if (what === "ui") replay(el.uiName, "bump");
     }
     function renderDesignChoices() {
          const radio = (className, id, index) => {
               const button = document.createElement("button");
               button.type = "button";
               button.className = className;
               button.setAttribute("role", "radio");
               button.dataset.choice = id;
               button.style.setProperty("--i", index);
               return button;
          };
          el.accentChoices.replaceChildren(
               ...ACCENTS.map((accent, index) => {
                    const button = radio("swatch", accent.id, index);
                    button.title = accent.label;
                    button.setAttribute("aria-label", accent.label);
                    button.style.setProperty("--c", accent.color);
                    if (accent.on)
                         button.style.setProperty("--on-c", accent.on);
                    button.innerHTML = ICON.check;
                    button.addEventListener("click", () =>
                         chooseDesign("accent", accent.id, ACCENT_KEY, button),
                    );
                    return button;
               }),
          );
          el.uiChoices.replaceChildren(
               ...UI_STYLES.map((style, index) => {
                    const button = radio("ui-card", style.id, index);
                    button.innerHTML =
                         `<span class="ui-preview" data-style="${style.id}" aria-hidden="true"><i></i><b><u></u><u></u><em></em></b></span>` +
                         `<span class="ui-name">${style.label}</span><span class="ui-hint">${style.hint}</span><span class="ui-tick" aria-hidden="true">${ICON.check}</span>`;
                    button.addEventListener("click", () =>
                         chooseDesign("ui", style.id, UI_KEY, button),
                    );
                    return button;
               }),
          );
          [...document.querySelectorAll(".set-group")].forEach((group, index) =>
               group.style.setProperty("--i", index),
          );
     }
     // Arrow keys move between the options of a radio group, as in a native one.
     function radioKeys(group) {
          group.addEventListener("keydown", event => {
               const step = {
                    ArrowRight: 1,
                    ArrowDown: 1,
                    ArrowLeft: -1,
                    ArrowUp: -1,
               }[event.key];
               const radios = [...group.querySelectorAll('[role="radio"]')];
               const at = radios.indexOf(document.activeElement);
               if (!step || at < 0) return;
               event.preventDefault();
               const target =
                    radios[(at + step + radios.length) % radios.length];
               target.focus();
               target.click();
          });
     }

     // ───────────── settings window ─────────────
     function selectModule(id) {
          for (const tab of el.setModules.children) {
               const on = tab.dataset.module === id;
               tab.setAttribute("aria-selected", String(on));
               tab.tabIndex = on ? 0 : -1;
          }
          for (const panel of el.settings.querySelectorAll(".set-panel")) {
               panel.hidden = panel.dataset.panel !== id;
               if (!panel.hidden) {
                    replay(panel, "enter");
                    panel.querySelector(".set-body").scrollTop = 0;
               }
          }
     }
     function openSettings() {
          closeMenu();
          el.settings.showModal();
          selectModule("design");
     }

     // ───────────── audio graph ─────────────
     let ctx = null,
          dryGain,
          wetGain,
          masterGain,
          convolver;
     const impulses = {};

     function makeImpulse(context, recipe) {
          const rate = context.sampleRate;
          const length = Math.floor(rate * recipe.seconds);
          const buffer = context.createBuffer(2, length, rate);

          const preDelay = Math.floor(rate * recipe.preDelay);
          const [dampStart, dampEnd] = recipe.damping;
          for (let channel = 0; channel < 2; channel++) {
               const data = buffer.getChannelData(channel);
               let low = 0;
               for (let i = preDelay; i < length; i++) {
                    const t = (i - preDelay) / (length - preDelay);
                    const damping = dampStart + (dampEnd - dampStart) * t; // the tail gets darker over time
                    low =
                         low * damping +
                         (Math.random() * 2 - 1) * (1 - damping);
                    data[i] = low * Math.pow(1 - t, recipe.decay);
               }
               for (let n = 0; n < recipe.early; n++) {
                    // a few early wall reflections
                    const at =
                         preDelay +
                         Math.floor(
                              rate * (0.004 + Math.random() * 0.012 * (n + 1)),
                         );
                    if (at < length)
                         data[at] +=
                              ((Math.random() > 0.5 ? 1 : -1) * 0.5) / (n + 1);
               }
               if (recipe.flutter) {
                    // sound bouncing between two close walls
                    const step = Math.floor(
                         rate * recipe.flutter.delay * (channel ? 1.07 : 1),
                    );
                    for (let i = preDelay + step; i < length; i++)
                         data[i] += data[i - step] * recipe.flutter.feedback;
               }
          }
          return buffer;
     }

     let vocalsGain, musicGain;
     function ensureGraph() {
          if (ctx || desktop) return; // the desktop app plays through its own engine
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          // audio ─► vocalsGain ─┐
          // follower ─► musicGain ─┴► mix ─► dry / reverb ─► master
          const mix = ctx.createGain();
          vocalsGain = ctx.createGain();
          musicGain = ctx.createGain();
          ctx.createMediaElementSource(audio).connect(vocalsGain).connect(mix);
          ctx.createMediaElementSource(follower).connect(musicGain).connect(mix);
          convolver = ctx.createConvolver();
          dryGain = ctx.createGain();
          wetGain = ctx.createGain();
          masterGain = ctx.createGain();
          mix.connect(dryGain).connect(masterGain);
          mix.connect(convolver).connect(wetGain).connect(masterGain);
          masterGain.connect(ctx.destination);
          applyReverbType();
          applyReverb(true);
          applyVolume(true);
          applyMix(true);
     }
     // The two Separate Audio volumes (the main volume still sets the overall level).
     function applyMix(instant = false) {
          el.mixVocals.value = state.mixVocals;
          el.mixMusic.value = state.mixMusic;
          fill(el.mixVocals);
          fill(el.mixMusic);
          el.mixVocals.closest(".mix-row").title = `Vocals ${Math.round(state.mixVocals)}%`;
          el.mixMusic.closest(".mix-row").title = `Instruments ${Math.round(state.mixMusic)}%`;
          const mixing = state.activeStem === "mix";
          desktop?.player.layers(
               mixing ? Math.pow(state.mixVocals / 100, 2) : 1,
               mixing ? Math.pow(state.mixMusic / 100, 2) : 0,
          );
          if (!ctx) return;
          ramp(vocalsGain.gain, mixing ? Math.pow(state.mixVocals / 100, 2) : 1, instant);
          ramp(musicGain.gain, mixing ? Math.pow(state.mixMusic / 100, 2) : 0, instant);
     }
     function ramp(param, value, instant) {
          if (instant) param.value = value;
          else param.setTargetAtTime(value, ctx.currentTime, 0.03);
     }
     function applyVolume(instant = false) {
          el.volume.value = state.volume;
          fill(el.volume);
          el.volume.title = `Volume ${Math.round(state.volume)}%`;
          const silent = state.muted || state.volume === 0;
          el.mute.innerHTML = silent ? ICON.muted : ICON.volume;
          el.mute.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
          desktop?.player.volume(state.muted ? 0 : Math.pow(state.volume / 100, 2));
          if (ctx)
               ramp(
                    masterGain.gain,
                    state.muted ? 0 : Math.pow(state.volume / 100, 2),
                    instant,
               );
     }
     function applyReverbType() {
          for (const pill of el.reverbTypes.children)
               pill.setAttribute(
                    "aria-checked",
                    String(pill.dataset.reverbType === state.reverbType),
               );
          desktop?.player.reverb(state.reverbType, state.reverb / 100);
          if (!ctx) return;
          impulses[state.reverbType] ||= makeImpulse(
               ctx,
               REVERBS[state.reverbType],
          );
          convolver.buffer = impulses[state.reverbType];
          applyReverb();
     }
     function applyReverb(instant = false) {
          el.reverb.value = state.reverb;
          fill(el.reverb);
          el.reverbVal.textContent = `${Math.round(state.reverb)}%`;
          desktop?.player.reverb(state.reverbType, state.reverb / 100);
          if (!ctx) return;
          const mix = state.reverb / 100;
          // Equal-power style crossfade; at 100% the direct sound is almost gone.
          ramp(dryGain.gain, Math.cos(((mix * Math.PI) / 2) * 0.86), instant);
          ramp(
               wetGain.gain,
               Math.sin((mix * Math.PI) / 2) * REVERBS[state.reverbType].level,
               instant,
          );
     }
     function applySpeed() {
          const rate = state.speed / 100;
          audio.defaultPlaybackRate = rate;
          audio.playbackRate = rate;
          audio.preservesPitch = state.keepPitch;
          audio.mozPreservesPitch = state.keepPitch;
          audio.webkitPreservesPitch = state.keepPitch;
          follower.defaultPlaybackRate = follower.playbackRate = rate;
          follower.preservesPitch = follower.mozPreservesPitch = follower.webkitPreservesPitch = state.keepPitch;
          el.speed.value = state.speed;
          fill(el.speed);
          el.speedVal.textContent = `${rate.toFixed(2)}×`;
          el.keepPitch.checked = state.keepPitch;
          document
               .querySelectorAll("[data-speed]")
               .forEach(pill =>
                    pill.classList.toggle(
                         "on",
                         Number(pill.dataset.speed) === state.speed,
                    ),
               );
     }

     // ───────────── playback ─────────────
     let loadToken = 0;

     // "original", "vocals", "instrumental", or "mix" (Separate Audio: both at once).
     function wantedStem(track) {
          return state.mode !== "original" && track.stems.state === "done"
               ? state.mode
               : "original";
     }
     function stopFollower() {
          follower.pause();
          if (follower.getAttribute("src")) {
               follower.removeAttribute("src");
               follower.load();
          }
     }
     // Puts the follower exactly where the main player is.
     function syncFollower() {
          if (state.activeStem !== "mix" || !follower.getAttribute("src")) return;
          if (Math.abs(follower.currentTime - audio.currentTime) > 0.06) follower.currentTime = audio.currentTime;
          if (audio.paused) follower.pause();
          else if (follower.paused) follower.play().catch(() => {});
     }
     function renderMixer() {
          const on = state.mode === "mix";
          root.classList.toggle("mixing", on);
          root.classList.toggle("mix-live", state.activeStem === "mix");
          el.mixer.setAttribute("aria-hidden", String(!on));
          el.mixVocals.tabIndex = el.mixMusic.tabIndex = on ? 0 : -1;
     }

     function loadSource(track, stem, time = 0, autoplay = true) {
          const token = ++loadToken;
          state.activeStem = stem;
          state.loading = true;
          setBuffering(true);
          audio.src = audioUrl(track.id, stem === "mix" ? "vocals" : stem);
          if (stem === "mix") follower.src = audioUrl(track.id, "instrumental");
          else stopFollower();
          applySpeed();
          applyMix(true);
          renderMixer();
          audio.addEventListener(
               "loadedmetadata",
               () => {
                    if (token !== loadToken) return;
                    if (time > 0 && Number.isFinite(audio.duration))
                         audio.currentTime = Math.min(
                              time,
                              Math.max(0, audio.duration - 0.25),
                         );
                    state.loading = false;
                    if (stem === "mix") follower.currentTime = audio.currentTime;
                    if (autoplay) play();
               },
               { once: true },
          );
          renderStems();
     }

     function play() {
          if (!currentTrack()) {
               const first = viewTracks()[0];
               if (first) playTrack(first.id, true, state.view);
               return;
          }
          ensureGraph();
          if (ctx?.state === "suspended") ctx.resume();
          state.wantPlaying = true;
          audio.play().catch(() => {
               /* interrupted by a newer load */
          });
          renderPlayState();
     }
     function pause() {
          state.wantPlaying = false;
          audio.pause();
          renderPlayState();
     }
     function togglePlay() {
          state.wantPlaying ? pause() : play();
     }

     function playTrack(id, autoplay = true, context = null) {
          const track = trackById(id);
          if (!track) return;
          state.current = id;
          if (
               (context && context !== state.context) ||
               !state.queue.includes(id)
          ) {
               if (context) state.context = context;
               rebuildQueue();
          }
          state.wantPlaying = autoplay;
          if (state.mode !== "original" && track.stems.state !== "done")
               requestSeparation(track);
          loadSource(track, wantedStem(track), 0, autoplay);
          renderNowPlaying();
          renderActiveRow(true);
          renderPlayState();
     }

     function rebuildQueue() {
          if (state.context !== "library" && !playlistById(state.context))
               state.context = "library";
          const ids = filteredTracks(state.context).map(t => t.id);
          if (state.shuffle) {
               for (let i = ids.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [ids[i], ids[j]] = [ids[j], ids[i]];
               }
               const at = ids.indexOf(state.current);
               if (at > 0) {
                    ids.splice(at, 1);
                    ids.unshift(state.current);
               }
          }
          state.queue = ids;
     }

     function next(auto = false) {
          if (!state.queue.length) return;
          if (auto && state.loop === "one") {
               audio.currentTime = loopActive() ? loopRegion().a : 0;
               play();
               return;
          }
          let index = state.queue.indexOf(state.current) + 1;
          if (index >= state.queue.length) {
               if (auto && state.loop === "off") {
                    // end of the playlist
                    pause();
                    audio.currentTime = 0;
                    return;
               }
               if (state.shuffle) {
                    const last = state.current;
                    state.current = null; // reshuffle for the next lap
                    rebuildQueue();
                    if (state.queue.length > 1 && state.queue[0] === last)
                         state.queue.push(state.queue.shift());
                    state.current = last;
               }
               index = 0;
          }
          playTrack(state.queue[index]);
     }
     function prev() {
          if (!state.queue.length) return;
          if (audio.currentTime > 3 || state.queue.length === 1) {
               audio.currentTime = 0;
               if (state.wantPlaying) play();
               return;
          }
          const index = state.queue.indexOf(state.current) - 1;
          playTrack(
               state.queue[(index + state.queue.length) % state.queue.length],
          );
     }
     function playView(shuffled) {
          const tracks = filteredTracks();
          if (!tracks.length) return;
          if (shuffled && !state.shuffle) {
               state.shuffle = true;
               renderToggles();
               saveSettings();
          }
          const start = shuffled
               ? tracks[Math.floor(Math.random() * tracks.length)]
               : tracks[0];
          state.current = start.id;
          state.context = state.view;
          rebuildQueue();
          playTrack(start.id, true);
     }

     // ───────────── acapella / karaoke ─────────────
     let pollTimer = null;
     const isBusy = track =>
          track.stems.state === "queued" || track.stems.state === "running";

     // ⋯ menu › Separate Audio: vocals and instruments play side by side, each
     // with its own volume in the player bar.
     function toggleSeparate() {
          const on = state.mode !== "mix";
          setMode(on ? "mix" : "original");
          const track = currentTrack();
          if (on && track && track.stems.state !== "done")
               toast("Separating vocals and music… it switches on by itself when ready.");
     }
     function setMode(mode) {
          state.mode = mode;
          applyMode();
     }

     function applyMode() {
          renderMixer();
          const track = currentTrack();
          if (track) {
               if (state.mode !== "original" && track.stems.state !== "done")
                    requestSeparation(track);
               const stem = wantedStem(track);
               if (stem !== state.activeStem)
                    loadSource(
                         track,
                         stem,
                         audio.currentTime,
                         state.wantPlaying,
                    );
          }
          renderStems();
     }

     // Tells the server someone is waiting for this song, so it jumps the queue.
     async function requestSeparation(track) {
          if (track.stems.state === "none" || track.stems.state === "error")
               track.stems = { state: "queued", progress: 0 };
          renderStems();
          renderBadges();
          const data = await api(`/api/tracks/${track.id}/separate`, {
               method: "POST",
          }).catch(() => ({
               state: "error",
               error: "Could not reach the player. Is it still running?",
          }));
          if (!trackById(track.id)) return;
          if (data.error && !data.state) data.state = "error";
          const before = track.stems.state;
          track.stems = data;
          if (before !== data.state) stemStateChanged(track);
          if (isBusy(track)) schedulePoll();
          renderStems();
          renderBadges();
     }

     function schedulePoll() {
          if (!pollTimer) pollTimer = setTimeout(poll, 1000);
     }
     async function poll() {
          pollTimer = null;
          const statuses = await api("/api/stems").catch(() => null);
          if (statuses && !statuses.error) {
               for (const track of state.tracks) {
                    const fresh = statuses[track.id];
                    if (!fresh) continue;
                    const before = track.stems.state;
                    track.stems = fresh;
                    if (before !== fresh.state) stemStateChanged(track);
               }
          }
          renderStems();
          renderBadges();
          if (state.tracks.some(isBusy)) schedulePoll();
     }

     function stemStateChanged(track) {
          const isCurrent = track.id === state.current;
          if (track.stems.state === "done") {
               if (isCurrent && state.mode !== "original") applyMode();
          } else if (
               track.stems.state === "error" &&
               isCurrent &&
               state.mode !== "original"
          ) {
               toast(
                    `Couldn't separate “${track.title}”: ${track.stems.error || "unknown error"}`,
                    "error",
               );
               state.mode = "original";
          }
     }

     async function setAutoPrepare(on) {
          state.autoPrepare = on;
          const result = await sendJson("/api/settings", "PUT", {
               autoPrepare: on,
          });
          if (result.error) {
               toast(result.error, "error");
               return;
          }
          state.autoPrepare = !!result.autoPrepare;
          await poll();
     }

     // ───────────── rendering: sidebar & song list ─────────────
     function renderSidebar() {
          document
               .querySelector('[data-view="library"]')
               .classList.toggle("active", state.view === "library");
          if (!state.loaded) {
               el.playlistNav.innerHTML =
                    '<div class="side-item sk-item" aria-hidden="true"><span class="sk sk-icon"></span><span class="sk sk-line"></span></div>'.repeat(
                         3,
                    );
               return;
          }
          el.playlistNav.replaceChildren(
               ...state.playlists.map(playlist => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className =
                         playlist.id === newPlaylistId
                              ? "side-item item-new"
                              : "side-item";
                    button.dataset.view = playlist.id;
                    button.classList.toggle(
                         "active",
                         state.view === playlist.id,
                    );
                    button.innerHTML = ICON.playlist;
                    const name = document.createElement("span");
                    name.textContent = playlist.name;
                    button.append(name);
                    return button;
               }),
          );
          newPlaylistId = null;
     }

     function trackRow(track, index) {
          const row = document.createElement("li");
          row.className = "track";
          row.dataset.id = track.id;
          row.tabIndex = 0;
          row.style.setProperty("--i", Math.min(index, 14)); // stagger for the entrance animation
          if (justAdded.has(track.id)) row.classList.add("row-new");

          const num = document.createElement("span");
          num.className = "t-num";
          num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>';
          const number = document.createElement("b");
          number.textContent = index + 1;
          num.prepend(number);

          const main = document.createElement("div");
          main.className = "t-main";
          const thumb = document.createElement("div");
          thumb.className = "thumb";
          thumb.innerHTML = ICON.note;
          paintArt(thumb, track);
          const text = document.createElement("div");
          text.className = "t-text";
          const titleRow = document.createElement("div");
          titleRow.className = "t-title-row";
          const title = document.createElement("span");
          title.className = "t-title";
          title.textContent = track.title;
          const badge = document.createElement("span");
          badge.className = "t-badge";
          titleRow.append(title, badge);
          const sub = document.createElement("span");
          sub.className = "t-sub";
          sub.textContent = track.artist || `${track.format} file`;
          text.append(titleRow, sub);
          main.append(thumb, text);

          const artist = document.createElement("span");
          artist.className = "t-artist";
          artist.textContent = track.artist || "—";
          const album = document.createElement("span");
          album.className = "t-album";
          album.textContent = track.album || "—";
          const type = document.createElement("span");
          type.className = "t-type";
          const kind = typeById(track.type);
          if (kind) {
               const tag = document.createElement("span");
               tag.className = "type-tag";
               tag.style.setProperty("--tc", kind.color);
               tag.textContent = kind.label;
               type.append(tag);
          } else type.innerHTML = '<span class="none">—</span>';
          const genres = document.createElement("span");
          genres.className = "t-genres";
          const list = track.genres || [];
          if (list.length) {
               genres.title = list.join(", ");
               // Two genres, or one in narrower windows; the rest as "+n".
               list.slice(0, 2).forEach((name, index) => {
                    const chip = document.createElement("span");
                    chip.className = index ? "g-chip g-second" : "g-chip";
                    chip.textContent = name;
                    genres.append(chip);
               });
               if (list.length > 2)
                    genres.insertAdjacentHTML("beforeend", `<span class="g-more g-more-wide">+${list.length - 2}</span>`);
               if (list.length > 1)
                    genres.insertAdjacentHTML("beforeend", `<span class="g-more g-more-narrow">+${list.length - 1}</span>`);
          } else genres.innerHTML = '<span class="none">—</span>';
          const duration = document.createElement("span");
          duration.className = "t-dur";
          duration.textContent = fmtTime(track.duration);

          const more = document.createElement("button");
          more.className = "t-more";
          more.type = "button";
          more.setAttribute("aria-label", `More options for ${track.title}`);
          more.setAttribute("aria-haspopup", "menu");
          more.innerHTML = ICON.more;

          row.append(num, main, artist, album, type, genres, duration, more);
          return row;
     }

     function renderViewArt(playlist, tracks) {
          const covers = tracks.filter(t => t.hasCover);
          el.viewArt.className = "view-art";
          el.viewArt.replaceChildren();
          const tile = url => {
               const node = document.createElement("div");
               node.className = "tile";
               node.style.backgroundImage = `url("${url}")`;
               return node;
          };
          if (playlist.hasCover) {
               el.viewArt.classList.add("single");
               el.viewArt.append(tile(playlistCoverUrl(playlist)));
          } else if (covers.length >= 4) {
               el.viewArt.classList.add("mosaic");
               el.viewArt.append(
                    ...covers.slice(0, 4).map(t => tile(coverUrl(t))),
               );
          } else if (covers.length) {
               el.viewArt.classList.add("single");
               el.viewArt.append(tile(coverUrl(covers[0])));
          } else el.viewArt.innerHTML = ICON.playlist;
          el.viewArt.insertAdjacentHTML(
               "beforeend",
               `<span class="art-edit">${ICON.camera}${playlist.hasCover ? "Change Photo" : "Add Photo"}</span>`,
          );
     }

     // `animate` plays the entrance animation (used when the view itself changes,
     // not for every re-render such as typing in the search box).
     // `animate` plays the rows' entrance; `head` also replays the heading's.
     function renderView(animate = false, head = animate) {
          if (!state.loaded) {
               el.viewSub.innerHTML = '<span class="sk sk-line sk-sub"></span>';
               el.list.classList.remove("enter");
               el.list.replaceChildren(
                    ...Array.from({ length: 6 }, skeletonRow),
               );
               el.playAll.disabled = el.shuffleAll.disabled = true;
               return;
          }
          if (state.view !== "library" && !playlistById(state.view))
               state.view = "library";
          const isLibrary = state.view === "library";
          const playlist = isLibrary ? null : playlistById(state.view);
          const all = viewTracks();

          el.viewKind.textContent = isLibrary ? "Library" : "Playlist";
          el.viewTitle.textContent = isLibrary ? "Songs" : playlist.name;
          el.viewSub.textContent = summary(all);
          el.viewArt.hidden = isLibrary;
          if (!isLibrary) renderViewArt(playlist, all);
          el.addMusic.hidden = !isLibrary;
          el.editPlaylist.hidden = el.deletePlaylist.hidden = isLibrary;
          disarm(el.deletePlaylist, "Delete Playlist");
          const matched = all.filter(matchesFilters);
          el.playAll.disabled = el.shuffleAll.disabled = matched.length === 0;

          const query = state.filter.trim().toLowerCase();
          const shown = matched.filter(
               t =>
                    !query ||
                    `${t.title} ${t.artist} ${t.album} ${t.type || ""} ${(t.genres || []).join(" ")}`
                         .toLowerCase()
                         .includes(query),
          );
          const pending =
               isLibrary && !query && !filtersOn() ? state.pendingUploads : 0;
          el.list.classList.toggle("enter", animate);
          el.list.replaceChildren(
               ...shown.map(trackRow),
               ...Array.from({ length: pending }, skeletonRow),
          );
          if (head) replay($(".view-head"), "enter");
          el.tableHead.hidden = shown.length + pending === 0;
          el.emptyLibrary.hidden = !(
               isLibrary &&
               all.length === 0 &&
               pending === 0
          );
          el.emptyPlaylist.hidden = !(!isLibrary && all.length === 0);
          el.noResults.hidden = !(all.length > 0 && shown.length === 0);
          el.noResultsText.textContent = filtersOn()
               ? query
                    ? "No songs match your search and filters."
                    : "No songs match your filters."
               : "No songs match your search.";
          el.noResultsClear.hidden = !filtersOn();
          el.filterBar.hidden = all.length === 0;
          el.filterCount.textContent = filtersOn()
               ? `${matched.length} of ${all.length} song${all.length === 1 ? "" : "s"}`
               : "";
          renderActiveRow(false);
          renderBadges();
     }
     // ───────────── filters: Type, Genre, Artist ─────────────
     // Display names, keyed by their lower-case form, across the whole library.
     function genreNames() {
          const names = new Map();
          for (const t of state.tracks)
               for (const g of t.genres || []) if (!names.has(g.toLowerCase())) names.set(g.toLowerCase(), g);
          return names;
     }
     function artistNames() {
          const names = new Map();
          for (const t of state.tracks)
               for (const a of artistsOf(t)) if (!names.has(a.toLowerCase())) names.set(a.toLowerCase(), a);
          return names;
     }
     // How many songs in the current view have each genre / artist.
     function filterOptions(kind) {
          const names = kind === "genre" ? genreNames() : artistNames();
          const counts = new Map();
          for (const t of viewTracks()) {
               const keys = new Set(
                    kind === "genre"
                         ? (t.genres || []).map(g => g.toLowerCase())
                         : artistsOf(t).map(a => a.toLowerCase()),
               );
               for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
          }
          // A chosen one stays listed (with 0) even in a view that lacks it, so it can be unticked.
          const chosen = kind === "genre" ? state.filters.genres : [state.filters.artist].filter(Boolean);
          for (const key of chosen) if (!counts.has(key)) counts.set(key, 0);
          return [...counts].map(([key, count]) => ({ key, count, label: names.get(key) || key }));
     }

     function setFilter(kind, value) {
          const f = state.filters;
          if (kind === "all") Object.assign(f, { type: "", genres: [], artist: "" });
          else if (kind === "type") f.type = value;
          else if (kind === "artist") f.artist = value;
          else if (value === null) f.genres = [];
          else f.genres = f.genres.includes(value) ? f.genres.filter(g => g !== value) : [...f.genres, value];
          rebuildQueue(); // Play, Next and Shuffle follow the filters
          renderFilters(kind);
          renderView(true, false);
     }

     function openFilterMenu(kind, anchor, refresh = false) {
          if (!refresh && menuAnchor === anchor) {
               closeMenu();
               return;
          }
          const f = state.filters;
          const tracks = viewTracks();
          let items;
          if (kind === "type") {
               items = [
                    { label: "Any Type", checked: !f.type, action: () => setFilter("type", "") },
                    { separator: true },
                    ...TYPES.map(t => ({
                         label: t.label,
                         color: t.color,
                         count: tracks.filter(x => x.type === t.id).length,
                         checked: f.type === t.id,
                         action: () => setFilter("type", t.id),
                    })),
                    {
                         label: "Not Set",
                         count: tracks.filter(x => !x.type).length,
                         checked: f.type === "none",
                         action: () => setFilter("type", "none"),
                    },
               ];
          } else if (kind === "genre") {
               // Several genres can be ticked (songs with any of them); the menu stays open.
               const again = () => openFilterMenu("genre", anchor, true);
               items = [
                    {
                         label: "Any Genre",
                         checked: !f.genres.length,
                         stay: true,
                         action: () => {
                              setFilter("genre", null);
                              again();
                         },
                    },
                    { separator: true },
               ];
               const options = filterOptions("genre").sort(
                    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
               );
               if (!options.length) items.push({ label: "No genres yet. Add them in Edit Song Info.", disabled: true });
               for (const o of options)
                    items.push({
                         label: o.label,
                         count: o.count,
                         checked: f.genres.includes(o.key),
                         stay: true,
                         action: () => {
                              setFilter("genre", o.key);
                              again();
                         },
                    });
          } else {
               items = [
                    { label: "All Artists", checked: !f.artist, action: () => setFilter("artist", "") },
                    { separator: true },
               ];
               const options = filterOptions("artist").sort((a, b) =>
                    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
               );
               if (!options.length) items.push({ label: "No artists yet", disabled: true });
               for (const o of options)
                    items.push({
                         label: o.label,
                         count: o.count,
                         checked: f.artist === o.key,
                         action: () => setFilter("artist", o.key),
                    });
          }
          showMenu(anchor, items, refresh);
     }

     // The chips show what is chosen; the one that just changed gives a little pop.
     function renderFilters(changed) {
          const f = state.filters;
          for (const chip of el.filterChips) {
               const kind = chip.dataset.filter;
               let value = "";
               if (kind === "type") value = f.type === "none" ? "Not set" : typeById(f.type)?.label || "";
               else if (kind === "genre" && f.genres.length) {
                    value = genreNames().get(f.genres[0]) || f.genres[0];
                    if (f.genres.length > 1) value += ` +${f.genres.length - 1}`;
               } else if (kind === "artist" && f.artist) value = artistNames().get(f.artist) || f.artist;
               const shown = chip.querySelector(".fc-value");
               const before = shown.textContent;
               shown.textContent = value;
               chip.classList.toggle("on", !!value);
               const name = chip.querySelector(".fc-label").textContent;
               chip.setAttribute("aria-label", value ? `${name}: ${value}` : `Filter by ${name.toLowerCase()}`);
               if (before !== value && (changed === kind || changed === "all")) replay(chip, "bump");
          }
          el.filterClear.hidden = !filtersOn();
     }

     function renderActiveRow(scroll) {
          for (const row of el.list.children) {
               const active = row.dataset.id === state.current;
               row.classList.toggle("active", active);
               row.classList.toggle("playing", active && state.wantPlaying);
               if (active && scroll) row.scrollIntoView({ block: "nearest" });
          }
     }
     function renderBadges() {
          for (const row of el.list.children) {
               const track = trackById(row.dataset.id);
               if (!track) continue;
               row.classList.toggle("has-stems", track.stems.state === "done");
               row.classList.toggle("is-busy", isBusy(track));
               const badge = row.querySelector(".t-badge");
               const look = isBusy(track) ? "busy" : "ready";
               if (badge.dataset.look !== look) {
                    // only touch the DOM when it changes
                    badge.dataset.look = look;
                    if (look === "busy") badge.textContent = "preparing";
                    else badge.innerHTML = ICON.check;
                    badge.title =
                         look === "busy"
                              ? "Being prepared for Acapella and Karaoke…"
                              : "Acapella and Karaoke are ready";
                    badge.setAttribute("aria-label", badge.title);
               }
          }
          const ready = state.tracks.filter(
               t => t.stems.state === "done",
          ).length;
          el.autoPrepare.checked = state.autoPrepare;
          el.prepLabel.textContent = state.tracks.length
               ? `Prepare ahead · ${ready}/${state.tracks.length} ready`
               : "Prepare ahead";
     }

     // ───────────── rendering: player ─────────────
     function renderNowPlaying() {
          const track = currentTrack();
          el.title.textContent = track ? track.title : "Not Playing";
          el.artist.textContent = track
               ? [track.artist, track.album].filter(Boolean).join(" — ")
               : "";
          el.cover.innerHTML = ICON.note;
          paintArt(el.cover, track);
          el.cover.style.color =
               track && !track.hasCover ? "rgba(255,255,255,.9)" : "";
          el.seek.disabled = !track;
          if (!track) {
               el.seek.value = 0;
               fill(el.seek);
               el.cur.textContent = el.dur.textContent = "0:00";
          } else el.dur.textContent = fmtTime(track.duration);
          if ((track ? track.id : null) !== shownTrackId) {
               shownTrackId = track ? track.id : null;
               replay($(".lcd-body"), "swap");
          }
          renderNowPlayingPage();
          if (np.open && lyrics.trackId !== (track ? track.id : null))
               showLyrics(track);
          document.title = track
               ? `${track.title} — Lewisis' Music`
               : "Lewisis' Music";
          if ("mediaSession" in navigator) {
               navigator.mediaSession.metadata = track
                    ? new MediaMetadata({
                           title: track.title,
                           artist: track.artist,
                           album: track.album,
                           artwork: track.hasCover
                                ? [{ src: coverUrl(track) }]
                                : [],
                      })
                    : null;
          }
          renderStems();
     }
     function renderPlayState() {
          el.play.innerHTML = state.wantPlaying ? ICON.pause : ICON.play;
          el.play.setAttribute(
               "aria-label",
               state.wantPlaying ? "Pause" : "Play",
          );
          root.classList.toggle("is-playing", state.wantPlaying);
          if (np.open) lyricsLoop();
          loopWatch();
          renderActiveRow(false);
     }
     // ───────────── A–B loop (with "Loop: this song") ─────────────
     // Two dots on the seek bar mark the part of the song that repeats. They
     // start at 0:00 and at the end; each song remembers its own for the session.
     const loopRegions = new Map(); // track id → { a, b } in seconds (b = null: the end)
     const MIN_LOOP = 1; // the shortest part that can be looped, in seconds
     const loopActive = () => state.loop === "one" && !!currentTrack();
     function songLength() {
          const d = audio.duration;
          return Number.isFinite(d) && d > 0 ? d : currentTrack()?.duration || 0;
     }
     function loopRegion() {
          const track = currentTrack();
          const len = songLength();
          const saved = (track && loopRegions.get(track.id)) || { a: 0, b: null };
          const b = saved.b == null ? len : Math.min(saved.b, len);
          const a = Math.min(saved.a, Math.max(0, b - MIN_LOOP));
          return { a, b, len, whole: a <= 0 && b >= len - 0.05 };
     }
     function renderLoop() {
          const on = loopActive() && songLength() > MIN_LOOP * 2;
          if (desktop) {
               // The engine repeats the part itself, with no gap.
               const region = on ? loopRegion() : null;
               desktop.player.loop(
                    region
                         ? { start: region.a, end: region.whole ? null : region.b }
                         : loopActive()
                           ? { start: 0, end: null }
                           : null,
               );
          }
          el.seekTrack.classList.toggle("looping", on);
          el.loopRange.setAttribute("aria-hidden", String(!on));
          el.loopA.tabIndex = el.loopB.tabIndex = on ? 0 : -1;
          if (!on) return;
          const { a, b, len } = loopRegion();
          el.loopRange.style.setProperty("--a", a / len);
          el.loopRange.style.setProperty("--b", b / len);
          const describe = (dot, now, min, max, what) => {
               dot.setAttribute("aria-valuemin", Math.round(min));
               dot.setAttribute("aria-valuemax", Math.round(max));
               dot.setAttribute("aria-valuenow", Math.round(now));
               dot.setAttribute("aria-valuetext", fmtTime(now));
               dot.firstElementChild.textContent = fmtTime(now);
               dot.title = `Loop ${what} ${fmtTime(now)}. Drag to move, double-click to reset.`;
          };
          describe(el.loopA, a, 0, b - MIN_LOOP, "starts at");
          describe(el.loopB, b, a + MIN_LOOP, len, "ends at");
     }
     // Moves one dot. On release (`settle`), playback jumps into the new part
     // if it is now outside it.
     function setLoopEnd(end, seconds, settle) {
          const track = currentTrack();
          if (!track) return;
          let { a, b, len } = loopRegion();
          if (end === "a") a = clamp(seconds, 0, b - MIN_LOOP);
          else b = clamp(seconds, a + MIN_LOOP, len);
          loopRegions.set(track.id, { a, b: b >= len - 0.05 ? null : b });
          renderLoop();
          if (settle) keepInsideLoop(true);
     }
     // Past the end dot, go back to the start dot.
     function keepInsideLoop(settle = false) {
          if (!loopActive() || state.loading || el.loopRange.querySelector(".dragging")) return;
          const { a, b, whole } = loopRegion();
          if (whole) return; // the whole song: the normal "ended → start again" does it
          const t = audio.currentTime;
          // (The desktop engine jumps back by itself; only a seek past the end dot needs help.)
          if ((desktop ? t >= b + 0.25 : t >= b - 0.02) || (settle && t < a)) {
               audio.currentTime = a;
               replay(el.loopA, "pulse");
          }
     }
     // Checks every frame while playing, so the jump back lands right on the dot.
     let loopFrame = 0;
     function loopWatch() {
          cancelAnimationFrame(loopFrame);
          const step = () => {
               keepInsideLoop();
               if (state.wantPlaying && loopActive()) loopFrame = requestAnimationFrame(step);
          };
          step();
     }

     function renderToggles() {
          el.shuffle.setAttribute("aria-pressed", String(state.shuffle));
          el.shuffle.title = `Shuffle: ${state.shuffle ? "on" : "off"}`;
          el.loop.setAttribute("aria-pressed", String(state.loop !== "off"));
          el.loop.innerHTML = state.loop === "one" ? ICON.loopOne : ICON.loop;
          el.loop.title = {
               off: "Loop: off",
               all: "Loop: whole playlist",
               one: "Loop: this song (drag the two dots on the seek bar to repeat just a part)",
          }[state.loop];
          el.loop.setAttribute("aria-label", el.loop.title);
          renderLoop();
          loopWatch();
     }
     function renderProgress() {
          if (state.seeking) return;
          const duration =
               Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration
                    : currentTrack()?.duration || 0;
          el.seek.max = duration || 100;
          el.seek.value = state.loading ? el.seek.value : audio.currentTime;
          fill(el.seek);
          el.cur.textContent = fmtTime(Number(el.seek.value));
          el.dur.textContent = fmtTime(duration);
          renderLoop();
     }
     function renderStems() {
          const track = currentTrack();
          const stems = track ? track.stems : { state: "none" };
          for (const button of el.stemBtns)
               button.setAttribute(
                    "aria-pressed",
                    String(button.dataset.mode === state.mode),
               );

          const playingStem = track && state.activeStem !== "original";
          el.modeTag.hidden = !playingStem;
          if (playingStem)
               el.modeTag.textContent = MODE_LABEL[state.activeStem];

          const waiting = state.mode !== "original";
          const busy =
               track && isBusy(track) && (waiting || stems.state === "running");
          el.stemBar.hidden = !busy;
          el.stemText.classList.toggle("error", stems.state === "error");
          let text;
          if (!track) {
               text = waiting
                    ? `${MODE_LABEL[state.mode]} is on for the next song you play.`
                    : "Play a song, then switch on Acapella or Karaoke.";
          } else if (stems.state === "queued") {
               el.stemBar.classList.add("indeterminate");
               text = waiting
                    ? "Starting… it will switch over by itself."
                    : "Waiting its turn to be prepared.";
          } else if (stems.state === "running") {
               const separating =
                    stems.stage === "separating" || stems.stage === "saving";
               const percent = Math.round((stems.progress || 0) * 100);
               el.stemBar.classList.toggle("indeterminate", !separating);
               el.stemBar.firstElementChild.style.width = `${percent}%`;
               text = separating
                    ? `Separating vocals from music… ${percent}%`
                    : "Starting the AI…";
               if (waiting) text += " It will switch over by itself.";
          } else if (stems.state === "error") {
               text = stems.error || "Separation failed.";
          } else if (playingStem) {
               text = {
                    vocals: "Instruments removed. You are hearing vocals only.",
                    instrumental: "Vocals removed. Sing along!",
                    mix: "Vocals and music separated. Set each one's volume in the player bar.",
               }[state.activeStem];
          } else if (stems.state === "done") {
               text = "Ready. Both versions of this song switch on instantly.";
          } else {
               text =
                    "Not prepared yet. Switching on takes about half the song’s length the first time.";
          }
          el.stemText.textContent = text;
     }

     // ───────────── now playing: the full-screen lyrics page ─────────────
     const np = { open: false, moves: 0 };

     function renderNowPlayingPage() {
          const track = currentTrack();
          el.npTitle.textContent = track ? track.title : "Not Playing";
          el.npArtist.textContent = track
               ? [track.artist, track.album].filter(Boolean).join(" — ")
               : "";
          el.npArt.innerHTML = ICON.note;
          paintArt(el.npArt, track);
          const shown = el.npBackdrop.dataset.for || "";
          const wanted = track ? `${track.id}:${track.coverVersion || 0}` : "";
          if (shown !== wanted) {
               el.npBackdrop.dataset.for = wanted;
               el.npBackdrop.style.backgroundImage =
                    track && track.hasCover
                         ? `url("${coverUrl(track)}")`
                         : track
                           ? `radial-gradient(circle at 30% 30%, ${tint(track.id)}, transparent 70%)`
                           : "";
               if (np.open) {
                    replay(el.npBackdrop, "swap");
                    replay($(".np-meta"), "swap");
               }
          }
     }

     // Opens or closes the page. Where the browser can, the player bar and the cover
     // glide between their two places; otherwise the page simply slides up.
     function setNowPlaying(open) {
          if (np.open === open) return;
          closeMenu();
          const apply = () => {
               np.open = open;
               root.classList.toggle("np-open", open);
               el.np.hidden = !open;
               if (open) el.npBarRow.prepend(el.playerbar);
               else el.main.prepend(el.playerbar);
               if (open) {
                    renderNowPlayingPage();
                    replay(el.np, "enter");
                    showLyrics(currentTrack());
                    lyricsLoop();
               }
          };
          const settle = () =>
               (open ? el.npBack : el.npOpen).focus({ preventScroll: true });
          if (!motionOn() || !document.startViewTransition) {
               apply();
               if (open && motionOn()) replay(el.np, "fallback-in");
               settle();
               return;
          }
          const move = ++np.moves;
          root.classList.add("vt-np");
          root.classList.toggle("vt-np-close", !open);
          const transition = document.startViewTransition(apply);
          transition.ready.catch(() => {});
          transition.finished
               .catch(() => {})
               .then(() => {
                    if (move === np.moves)
                         root.classList.remove("vt-np", "vt-np-close");
               });
          transition.updateCallbackDone.then(settle, () => {});
     }

     // ───────────── lyrics ─────────────
     const lyrics = {
          cache: new Map(), // track id → what the server said
          tried: new Set(), // track ids already looked up online this session
          trackId: null, // the song the page is showing
          lines: [], // the lines on screen (timed lyrics only)
          active: -1,
          holdUntil: 0, // while the listener scrolls by hand, don't scroll for them
          frame: 0,
          shown: (() => {
               try {
                    return localStorage.getItem(SHOW_LYRICS_KEY) !== "off";
               } catch {
                    return true;
               }
          })(),
          auto: (() => {
               try {
                    return localStorage.getItem(AUTO_LYRICS_KEY) === "on";
               } catch {
                    return false;
               }
          })(),
     };

     function lyricsMessage(title, note, ...extra) {
          el.lyrics.className = "np-lyrics message";
          const heading = document.createElement("p");
          heading.className = "ly-title";
          heading.textContent = title;
          const text = document.createElement("p");
          text.className = "ly-text-note";
          text.textContent = note;
          el.lyrics.replaceChildren(heading, ...(note ? [text] : []), ...extra);
          lyrics.lines = [];
          lyrics.active = -1;
     }
     function lyricsSkeleton() {
          el.lyrics.className = "np-lyrics message";
          el.lyrics.innerHTML = '<span class="sk sk-ly"></span>'.repeat(5);
          lyrics.lines = [];
          lyrics.active = -1;
     }
     function button(className, html, onClick) {
          const node = document.createElement("button");
          node.type = "button";
          node.className = className;
          node.innerHTML = html;
          node.addEventListener("click", onClick);
          return node;
     }
     function renderNoLyrics(track, data) {
          const actions = document.createElement("div");
          actions.className = "ly-actions";
          actions.append(
               button("btn primary", `${ICON.search}Find Lyrics Online`, () =>
                    findLyricsOnline(track),
               ),
               button("btn", `${ICON.edit}Paste or Type Lyrics`, () =>
                    openLyricsDialog(track),
               ),
          );
          const always = document.createElement("label");
          always.className = "switch ly-always";
          always.innerHTML =
               '<input type="checkbox"><span class="knob"></span>Always look online for songs without lyrics';
          always.firstChild.checked = lyrics.auto;
          always.firstChild.addEventListener("change", event =>
               setAutoLyrics(event.target.checked),
          );
          lyricsMessage(
               data.searched
                    ? "No lyrics found online"
                    : "No lyrics for this song yet",
               data.searched
                    ? "Nothing matched this song’s title and artist. You can paste the words in yourself."
                    : "Looking online sends this song’s title, artist and length to lrclib.net. Or paste the words in yourself.",
               actions,
               always,
          );
     }

     function renderLyrics(track, data) {
          if (!track) {
               lyricsMessage(
                    "Nothing is playing",
                    "Play a song and its lyrics will show here.",
               );
               return;
          }
          if (data.error) {
               lyricsMessage(
                    "Lyrics could not be loaded",
                    data.error,
                    button("btn", "Try Again", () => {
                         lyrics.cache.delete(track.id);
                         showLyrics(track);
                    }),
               );
               return;
          }
          if (!data.found) {
               renderNoLyrics(track, data);
               return;
          }
          if (data.instrumental && !data.lines.length) {
               lyricsMessage("♪ Instrumental", "This song has no words.");
               return;
          }

          // Timed lyrics: blank lines only stay as a "· · ·" pause when the gap is long.
          let shown = data.lines;
          if (data.synced) {
               shown = data.lines.filter(
                    (line, index) =>
                         line.text ||
                         (data.lines[index + 1]
                              ? data.lines[index + 1].time - line.time
                              : 0) >= 6,
               );
          }
          el.lyrics.className = data.synced ? "np-lyrics" : "np-lyrics plain";
          el.lyrics.replaceChildren(
               ...shown.map((line, index) => {
                    if (!data.synced && !line.text) {
                         const gap = document.createElement("div");
                         gap.className = "ly-break";
                         return gap;
                    }
                    const node = document.createElement("p");
                    node.className = line.text ? "ly-line" : "ly-line rest";
                    node.textContent = line.text || "• • •";
                    if (data.synced) {
                         node.dataset.index = index;
                         node.dataset.time = line.time;
                    }
                    return node;
               }),
          );
          lyrics.lines = data.synced ? shown : [];
          lyrics.active = -1;
          lyrics.holdUntil = 0;
          el.lyrics.scrollTop = 0;
          syncLyrics(true);
          // Lines near the current one arrive first, the rest ripple outwards.
          const centre = Math.max(lyrics.active, 0);
          [...el.lyrics.children].forEach((node, index) =>
               node.style.setProperty(
                    "--i",
                    Math.min(Math.abs(index - centre), 12),
               ),
          );
          replay(el.lyrics, "enter");
     }

     async function showLyrics(track) {
          if (!lyrics.shown) {
               // Lyrics are switched off: load nothing, and look nothing up online.
               lyrics.trackId = null;
               return;
          }
          lyrics.trackId = track ? track.id : null;
          if (!track) {
               renderLyrics(null);
               return;
          }
          let data = lyrics.cache.get(track.id);
          if (!data) {
               lyricsSkeleton();
               data = await api(`/api/tracks/${track.id}/lyrics`).catch(() => ({
                    error: "Could not reach the player. Is it still running?",
               }));
               if (!data.error) lyrics.cache.set(track.id, data);
               if (lyrics.trackId !== track.id) return; // the song changed while we waited
          }
          if (
               !data.error &&
               !data.found &&
               !data.removed &&
               lyrics.auto &&
               !lyrics.tried.has(track.id)
          ) {
               findLyricsOnline(track, true);
               return;
          }
          renderLyrics(track, data);
     }

     async function findLyricsOnline(track, quiet = false) {
          lyrics.tried.add(track.id);
          if (lyrics.trackId === track.id) lyricsSkeleton();
          const data = await api(`/api/tracks/${track.id}/lyrics/search`, {
               method: "POST",
          }).catch(() => ({
               error: "Could not reach the player. Is it still running?",
          }));
          if (!trackById(track.id)) return;
          if (data.error) {
               if (!quiet) toast(data.error, "error");
               if (lyrics.trackId === track.id)
                    renderLyrics(
                         track,
                         lyrics.cache.get(track.id) || {
                              found: false,
                              lines: [],
                         },
                    );
               return;
          }
          lyrics.cache.set(track.id, data);
          if (lyrics.trackId === track.id) renderLyrics(track, data);
          if (data.found && !quiet) toast(`Found lyrics for “${track.title}”`);
     }

     // Throws out a song's lyrics (wrong ones found online, for example). The song
     // goes back to "No lyrics yet" and is not looked up again unless asked.
     async function removeLyrics(track) {
          const data = await api(`/api/tracks/${track.id}/lyrics`, {
               method: "DELETE",
          }).catch(() => ({ error: "Could not remove the lyrics." }));
          if (data.error) {
               toast(data.error, "error");
               return;
          }
          lyrics.cache.set(track.id, data);
          if (lyrics.trackId === track.id) renderLyrics(track, data);
          toast(`Removed the lyrics for “${track.title}”`);
     }
     // The ⋯ menu on the lyrics page: "Remove Lyrics" while there are lyrics on
     // screen, and always "Show Lyrics", which hides or brings back the lyrics box
     // (for music without words, like EDM).
     function openLyricsMenu() {
          const track = currentTrack();
          const data = track && lyrics.cache.get(track.id);
          const items = [];
          if (lyrics.shown && data && data.found) {
               items.push({
                    label: "Remove Lyrics",
                    danger: true,
                    confirm: "Click again to remove",
                    action: () => removeLyrics(track),
               });
               items.push({ separator: true });
          }
          items.push({
               label: "Show Lyrics",
               checked: lyrics.shown,
               action: () => setShowLyrics(!lyrics.shown, true),
          });
          items.push({
               label: "Separate Audio",
               checked: state.mode === "mix",
               action: toggleSeparate,
          });
          showMenu(el.lyricsMenuBtn, items);
     }

     function setAutoLyrics(on) {
          lyrics.auto = on;
          el.autoLyrics.checked = on;
          remember(AUTO_LYRICS_KEY, on ? "on" : "off");
          const track = currentTrack();
          const data = track && lyrics.cache.get(track.id);
          if (
               on &&
               np.open &&
               track &&
               data &&
               !data.found &&
               !data.removed &&
               !lyrics.tried.has(track.id)
          )
               findLyricsOnline(track, true);
     }

     // Highlights the line being sung and keeps it in the middle of the page.
     // Moving on to the next line is a glide, not a jump: the page is scrolled at
     // once, every line is held where it was on screen, and then each is let go a
     // moment after the one above it, so the lines flow up one after another.
     function syncLyrics(jump = false) {
          const lines = lyrics.lines;
          if (!lines.length) return;
          const now = audio.currentTime + 0.18; // lead slightly, so the line lands with the voice
          let index = -1;
          for (let i = 0; i < lines.length && lines[i].time <= now; i++)
               index = i;
          if (index === lyrics.active && !jump) return;
          lyrics.active = index;
          const nodes = [...el.lyrics.children];
          const target = nodes[Math.max(index, 0)];
          const held = !jump && performance.now() < lyrics.holdUntil; // the listener is scrolling by hand
          const top = target
               ? target.offsetTop -
                 (el.lyrics.clientHeight - target.offsetHeight) / 2
               : 0;
          const glide = !!target && !jump && !held && motionOn();

          if (glide) {
               // Where each line is right now, including any glide still under way.
               const offsets = nodes.map(
                    node =>
                         parseFloat(
                              (getComputedStyle(node).translate || "").split(
                                   " ",
                              )[1],
                         ) || 0,
               );
               const before = el.lyrics.scrollTop;
               el.lyrics.scrollTop = top;
               const moved = el.lyrics.scrollTop - before;
               nodes.forEach((node, i) => {
                    node.style.transition = "none";
                    node.style.translate = `0 ${offsets[i] + moved}px`;
               });
               void el.lyrics.offsetHeight; // lock that in before letting go
          } else if (target && !held) {
               el.lyrics.scrollTop = top;
          }
          nodes.forEach((node, i) => {
               node.classList.toggle("active", i === index);
               node.classList.toggle("past", i < index);
               node.style.setProperty("--n", Math.min(Math.abs(i - index), 6));
               node.style.setProperty(
                    "--d",
                    `${Math.max(0, Math.min(i - index + 1, 9)) * 38}ms`,
               );
               node.style.transition = "";
               node.style.translate = "";
          });
     }
     function lyricsLoop() {
          cancelAnimationFrame(lyrics.frame);
          if (!lyrics.shown) return;
          const step = () => {
               if (!np.open) return;
               syncLyrics();
               if (state.wantPlaying)
                    lyrics.frame = requestAnimationFrame(step);
          };
          step();
     }

     let lyricsDialogTrack = null;
     function openLyricsDialog(track) {
          lyricsDialogTrack = track;
          const data = lyrics.cache.get(track.id);
          $("#lyTitle").textContent = `Lyrics for “${track.title}”`;
          el.lyricsText.value = data && data.found ? data.text : "";
          el.lyricsDialog.showModal();
          el.lyricsText.focus();
     }
     async function saveLyricsDialog() {
          const track = lyricsDialogTrack;
          const text = el.lyricsText.value.trim();
          if (!track || !text) {
               toast("Type or paste some lyrics first.", "error");
               return;
          }
          const data = await sendJson(`/api/tracks/${track.id}/lyrics`, "PUT", {
               text,
          });
          if (data.error) {
               toast(data.error, "error");
               return;
          }
          lyrics.cache.set(track.id, data);
          if (lyrics.trackId === track.id) renderLyrics(track, data);
          closeDialog(el.lyricsDialog);
          toast(
               data.synced
                    ? "Lyrics saved. They will follow the music."
                    : "Lyrics saved",
          );
     }

     // Keeps the sung line in the middle while the lyrics box changes size
     // (for example while the controls below fold away).
     function centreLyrics() {
          if (!lyrics.lines.length || performance.now() < lyrics.holdUntil) return;
          const target = el.lyrics.children[Math.max(lyrics.active, 0)];
          if (target)
               el.lyrics.scrollTop =
                    target.offsetTop -
                    (el.lyrics.clientHeight - target.offsetHeight) / 2;
     }

     // Settings › Lyrics › Show lyrics. Off: the lyrics box disappears and the
     // cover takes the stage (handy for music without words).
     function setShowLyrics(on, persist) {
          lyrics.shown = on;
          root.classList.toggle("no-lyrics", !on);
          el.autoLyrics.closest(".set-group").classList.toggle("dimmed", !on);
          if (persist) remember(SHOW_LYRICS_KEY, on ? "on" : "off");
          if (on && np.open) {
               showLyrics(currentTrack());
               lyricsLoop();
          }
     }

     // Each panel on the lyrics page (the player bar, the sound controls) has a
     // button beside it that tucks it away. The button then glides to the
     // bottom-right corner and waits there to bring its panel back.
     const PANELS = {
          bar: { cls: "np-hide-bar", key: NP_BAR_KEY, label: "player bar" },
          sound: { cls: "np-hide-sound", key: NP_SOUND_KEY, label: "sound controls" },
     };
     function setPanelHidden(name, hidden, persist) {
          const panel = PANELS[name];
          const button = name === "bar" ? el.foldBar : el.foldSound;
          const home = name === "bar" ? el.npBarRow : el.npSoundRow;
          const was = root.classList.contains(panel.cls);
          const hadFocus = document.activeElement === button;
          const first = button.getBoundingClientRect();

          root.classList.toggle(panel.cls, hidden);
          home.closest(".np-fold").inert = hidden;
          if (!hidden) home.append(button);
          else if (name === "bar") el.npTray.prepend(button); // Player before Sound
          else el.npTray.append(button);
          const what = `${hidden ? "Show" : "Hide"} ${panel.label}`;
          button.setAttribute("aria-label", what);
          button.setAttribute("aria-expanded", String(!hidden));
          button.title = what;
          if (persist) remember(panel.key, hidden ? "hidden" : "shown");
          if (hadFocus) button.focus({ preventScroll: true });

          // Glide from where it was to where it is now.
          if (np.open && was !== hidden && motionOn()) {
               const last = button.getBoundingClientRect();
               const dx = first.left + first.width / 2 - (last.left + last.width / 2);
               const dy = first.top + first.height / 2 - (last.top + last.height / 2);
               button.animate(
                    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
                    { duration: 650, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
               );
          }
     }

     // ───────────── sidebar ─────────────
     function setSidebar(shown, persist) {
          root.classList.toggle("side-hidden", !shown);
          el.sidebarBtn.setAttribute("aria-pressed", String(shown));
          el.sidebarBtn.title = shown ? "Hide sidebar" : "Show sidebar";
          if (persist) remember(SIDEBAR_KEY, shown ? "shown" : "hidden");
     }

     // ───────────── menus ─────────────
     let menuAnchor = null;

     function closeMenu() {
          if (menuAnchor) menuAnchor.setAttribute("aria-expanded", "false");
          menuAnchor = null;
          el.menu.hidden = true;
     }
     // `refresh` re-draws an open menu in place (no pop-in), keeping keyboard focus.
     function showMenu(anchor, items, refresh = false) {
          const focusAt = refresh
               ? [...el.menu.querySelectorAll(".menu-item")].indexOf(document.activeElement)
               : -1;
          if (!refresh) closeMenu();
          el.menu.replaceChildren(
               ...items.map(item => {
                    if (item.separator) return document.createElement("hr");
                    if (item.heading) {
                         const heading = document.createElement("div");
                         heading.className = "menu-heading";
                         heading.textContent = item.heading;
                         return heading;
                    }
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = `menu-item${item.danger ? " danger" : ""}`;
                    button.setAttribute("role", "menuitem");
                    button.disabled = !!item.disabled;
                    if (item.color) {
                         const dot = document.createElement("span");
                         dot.className = "menu-dot";
                         dot.style.setProperty("--tc", item.color);
                         button.append(dot);
                    }
                    const label = document.createElement("span");
                    label.className = "menu-label";
                    label.textContent = item.label;
                    button.append(label);
                    if (item.count != null)
                         button.insertAdjacentHTML("beforeend", `<span class="menu-count">${item.count}</span>`);
                    if (item.checked)
                         button.insertAdjacentHTML("beforeend", ICON.check);
                    if (item.stay) {
                         button.setAttribute("role", "menuitemcheckbox");
                         button.setAttribute("aria-checked", String(!!item.checked));
                    }
                    button.addEventListener("click", () => {
                         if (item.confirm && !button.dataset.armed) {
                              button.dataset.armed = "1";
                              label.textContent = item.confirm;
                              return;
                         }
                         if (!item.stay) closeMenu();
                         item.action();
                    });
                    return button;
               }),
          );
          if (refresh && !el.menu.hidden) {
               const again = el.menu.querySelectorAll(".menu-item")[focusAt];
               if (again) again.focus({ preventScroll: true });
               return;
          }
          el.menu.hidden = false;
          const anchorBox = anchor.getBoundingClientRect(),
               menuBox = el.menu.getBoundingClientRect();
          let top = anchorBox.bottom + 4;
          if (top + menuBox.height > window.innerHeight - 8)
               top = Math.max(8, anchorBox.top - menuBox.height - 4);
          el.menu.style.top = `${top}px`;
          el.menu.style.left = `${Math.max(8, Math.min(anchorBox.right - menuBox.width, window.innerWidth - menuBox.width - 8))}px`;
          menuAnchor = anchor;
          anchor.setAttribute("aria-expanded", "true");
     }

     function openTrackMenu(track, anchor) {
          const items = [
               {
                    label: "Edit Song Info",
                    action: () => openTrackDialog(track),
               },
               { separator: true },
               { heading: "Add to playlist" },
          ];
          for (const playlist of state.playlists) {
               const already = playlist.trackIds.includes(track.id);
               items.push({
                    label: playlist.name,
                    checked: already,
                    disabled: already,
                    action: () => addToPlaylist(playlist, track),
               });
          }
          items.push({
               label: "New Playlist…",
               action: () => openPlaylistDialog(null, [track.id]),
          });
          items.push({ separator: true });
          const playlist = playlistById(state.view);
          if (playlist)
               items.push({
                    label: "Remove from This Playlist",
                    action: () => removeFromPlaylist(playlist, track),
               });
          items.push({
               label: "Delete from Library",
               danger: true,
               confirm: "Click again to delete",
               action: () => removeTrack(track.id),
          });
          showMenu(anchor, items);
     }

     // Two-step confirmation for destructive buttons.
     function disarm(button, label) {
          button.classList.remove("danger");
          button.dataset.armed = "";
          button.textContent = label;
     }
     function armOrConfirm(button, label, confirmLabel) {
          if (button.dataset.armed) {
               disarm(button, label);
               return true;
          }
          button.dataset.armed = "1";
          button.classList.add("danger");
          button.textContent = confirmLabel;
          setTimeout(() => {
               if (button.dataset.armed) disarm(button, label);
          }, 3500);
          return false;
     }

     // ───────────── playlists ─────────────
     function playlistChanged(playlist) {
          if (state.context === playlist.id) rebuildQueue();
          renderSidebar();
          renderView();
     }
     async function savePlaylist(playlist, fields) {
          const result = await sendJson(
               `/api/playlists/${playlist.id}`,
               "PUT",
               fields,
          );
          if (result.error) {
               toast(result.error, "error");
               return false;
          }
          Object.assign(playlist, result);
          playlistChanged(playlist);
          return true;
     }
     async function addToPlaylist(playlist, track) {
          if (
               await savePlaylist(playlist, {
                    trackIds: [...playlist.trackIds, track.id],
               })
          )
               toast(`Added “${track.title}” to ${playlist.name}`);
     }
     async function removeFromPlaylist(playlist, track) {
          await animateOut(rowFor(track.id));
          if (
               !(await savePlaylist(playlist, {
                    trackIds: playlist.trackIds.filter(id => id !== track.id),
               }))
          )
               renderView();
     }
     async function deletePlaylist(playlist) {
          const result = await api(`/api/playlists/${playlist.id}`, {
               method: "DELETE",
          }).catch(() => ({ error: "Could not delete the playlist." }));
          if (result.error) {
               toast(result.error, "error");
               return;
          }
          state.playlists = state.playlists.filter(p => p.id !== playlist.id);
          if (state.context === playlist.id) {
               state.context = "library";
               rebuildQueue();
          }
          state.view = "library";
          renderSidebar();
          renderView(true);
          toast(`Deleted playlist “${playlist.name}”`);
     }

     // ───────────── pictures: playlist photos and song covers ─────────────
     let onImagePicked = null;
     function pickImage(callback) {
          // opens the file chooser; `callback` gets the chosen picture
          onImagePicked = callback;
          el.imageInput.click();
     }
     // Big photos are scaled down before they are sent, so covers stay light.
     // Pictures this browser cannot show by itself (HEIC / HEIF from iPhones,
     // TIFF, …) are converted by the player first, so they can be previewed and
     // saved like any other. Returns null (after saying why) if it can't be opened.
     async function readablePicture(file) {
          try {
               (await createImageBitmap(file)).close();
               return file;
          } catch {
               /* not one the browser can decode: let the player convert it */
          }
          const form = new FormData();
          form.append("image", file, file.name || "picture");
          try {
               const response = await (desktop ? desktop.fetch : fetch)("/api/images/convert", { method: "POST", body: form });
               if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    toast(data.error || "That file is not a picture Lewisis' Music can open.", "error");
                    return null;
               }
               const blob = await response.blob();
               return new File([blob], blob.type === "image/png" ? "picture.png" : "picture.jpg", { type: blob.type });
          } catch {
               toast("Could not reach the player. Is it still running?", "error");
               return null;
          }
     }
     async function imageForUpload(file) {
          const bitmap = await createImageBitmap(file);
          const longest = Math.max(bitmap.width, bitmap.height);
          if (longest <= 1400 && file.size <= 1500000) return file;
          const scale = Math.min(1, 1400 / longest);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          const context = canvas.getContext("2d");
          context.fillStyle = "#fff"; // behind see-through pictures
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return new Promise(resolve =>
               canvas.toBlob(blob => resolve(blob || file), "image/jpeg", 0.9),
          );
     }
     async function uploadPicture(path, file) {
          let picture;
          try {
               picture = await imageForUpload(file);
          } catch {
               return {
                    error: "That file is not a picture this browser can open.",
               };
          }
          const form = new FormData();
          form.append("image", picture, "picture");
          return api(path, { method: "POST", body: form }).catch(() => ({
               error: "Could not reach the player. Is it still running?",
          }));
     }
     // A picture button in a dialog: shows the current picture, a just-chosen one, or an icon.
     // `choice` is undefined (keep what is there), a File (new picture) or null (remove it).
     function paintPick(button, removeLink, currentUrl, choice, icon) {
          if (button.dataset.preview) {
               URL.revokeObjectURL(button.dataset.preview);
               button.dataset.preview = "";
          }
          let url = choice === undefined ? currentUrl : "";
          if (choice)
               url = button.dataset.preview = URL.createObjectURL(choice);
          button.classList.toggle("has-art", !!url);
          button.style.backgroundImage = url ? `url("${url}")` : "";
          button.innerHTML = `${icon}<span class="art-edit">${ICON.camera}</span>`;
          removeLink.hidden = !url;
     }

     // Playlist photo, from the picture at the top of a playlist.
     async function setPlaylistPhoto(playlist, file) {
          const result = file
               ? await uploadPicture(
                      `/api/playlists/${playlist.id}/cover`,
                      file,
                 )
               : await api(`/api/playlists/${playlist.id}/cover`, {
                      method: "DELETE",
                 }).catch(() => ({ error: "Could not remove the photo." }));
          if (result.error) {
               toast(result.error, "error");
               return false;
          }
          Object.assign(playlist, result);
          if (state.view === playlist.id) {
               renderView();
               replay(el.viewArt, "art-in");
          }
          return true;
     }
     function openViewArtMenu() {
          const playlist = playlistById(state.view);
          if (!playlist) return;
          if (menuAnchor === el.viewArt) {
               closeMenu();
               return;
          }
          const choose = () =>
               pickImage(async file => {
                    if (await setPlaylistPhoto(playlist, file))
                         toast("Playlist photo updated");
               });
          if (!playlist.hasCover) {
               choose();
               return;
          }
          showMenu(el.viewArt, [
               { label: "Choose Another Photo", action: choose },
               {
                    label: "Remove Photo",
                    danger: true,
                    action: async () => {
                         if (await setPlaylistPhoto(playlist, null))
                              toast("Playlist photo removed");
                    },
               },
          ]);
     }

     // Song info: title, artist, album and cover.
     const trackEdit = { track: null, cover: undefined, type: "", genres: [] };

     // Type: one of "Not set" + TYPES.
     function renderTypePick() {
          el.trkType.replaceChildren(
               ...[{ id: "", label: "Not set" }, ...TYPES].map(t => {
                    const option = document.createElement("button");
                    option.type = "button";
                    option.className = "type-opt";
                    option.dataset.type = t.id;
                    option.setAttribute("role", "radio");
                    if (t.color) option.style.setProperty("--tc", t.color);
                    option.textContent = t.label;
                    option.addEventListener("click", () => {
                         trackEdit.type = t.id;
                         markChoice(el.trkType, radio => radio.dataset.type === trackEdit.type);
                    });
                    return option;
               }),
          );
     }

     // Genres: chips you can remove, a box to type new ones, and suggestions.
     const genreKey = name => name.trim().toLowerCase();
     function knownGenres() {
          const used = new Map(); // genres already in the library, most used first
          for (const t of state.tracks)
               for (const g of t.genres || []) {
                    const entry = used.get(genreKey(g));
                    if (entry) entry.n++;
                    else used.set(genreKey(g), { name: g, n: 1 });
               }
          const list = [...used.values()].sort((a, b) => b.n - a.n).map(e => e.name);
          for (const g of GENRE_SUGGESTIONS) if (!used.has(genreKey(g))) list.push(g);
          return list;
     }
     function addGenre(text) {
          for (const part of text.split(/[,;/]/)) {
               const typed = part.replace(/\s+/g, " ").trim().slice(0, 40);
               if (!typed) continue;
               // "future house" becomes "Future House" when that genre is known.
               const name = knownGenres().find(g => genreKey(g) === genreKey(typed)) || typed;
               if (trackEdit.genres.some(g => genreKey(g) === genreKey(name))) continue;
               if (trackEdit.genres.length >= 15) {
                    toast("A song can have up to 15 genres.", "error");
                    break;
               }
               trackEdit.genres.push(name);
               renderGenreChips(name);
          }
          el.trkGenreInput.value = "";
          renderGenreSuggest();
     }
     function removeGenre(name, chip) {
          trackEdit.genres = trackEdit.genres.filter(g => g !== name);
          const done = () => {
               renderGenreChips();
               renderGenreSuggest();
          };
          if (chip && motionOn()) {
               chip.classList.add("out");
               setTimeout(done, 150);
          } else done();
     }
     function renderGenreChips(fresh) {
          el.trkGenreChips.replaceChildren(
               ...trackEdit.genres.map(name => {
                    const chip = document.createElement("span");
                    chip.className = name === fresh ? "g-chip new" : "g-chip";
                    const label = document.createElement("span");
                    label.textContent = name;
                    const remove = document.createElement("button");
                    remove.type = "button";
                    remove.className = "g-remove";
                    remove.setAttribute("aria-label", `Remove ${name}`);
                    remove.innerHTML = ICON.close;
                    remove.addEventListener("click", event => {
                         event.stopPropagation();
                         removeGenre(name, chip);
                         el.trkGenreInput.focus();
                    });
                    chip.append(label, remove);
                    return chip;
               }),
          );
     }
     function renderGenreSuggest(enter = false) {
          const query = genreKey(el.trkGenreInput.value);
          const chosen = new Set(trackEdit.genres.map(genreKey));
          const options = knownGenres()
               .filter(g => !chosen.has(genreKey(g)) && (!query || genreKey(g).includes(query)))
               .slice(0, 12);
          el.trkGenreSuggest.classList.toggle("enter", enter);
          el.trkGenreSuggest.replaceChildren(
               ...options.map((name, index) => {
                    const option = document.createElement("button");
                    option.type = "button";
                    option.className = "pill";
                    option.textContent = name;
                    option.title = `Add ${name}`;
                    option.style.setProperty("--i", index);
                    option.addEventListener("click", () => {
                         addGenre(name);
                         el.trkGenreInput.focus();
                    });
                    return option;
               }),
          );
     }
     function paintTrackPick() {
          const track = trackEdit.track;
          paintPick(
               el.trkCover,
               el.trkCoverRemove,
               track.hasCover ? coverUrl(track) : "",
               trackEdit.cover,
               ICON.note,
          );
     }
     function openTrackDialog(track) {
          closeMenu();
          trackEdit.track = track;
          trackEdit.cover = undefined;
          trackEdit.type = track.type || "";
          trackEdit.genres = [...(track.genres || [])];
          markChoice(el.trkType, radio => radio.dataset.type === trackEdit.type);
          el.trkGenreInput.value = "";
          renderGenreChips();
          renderGenreSuggest(true);
          el.trkName.value = track.title;
          el.trkArtist.value = track.artist || "";
          el.trkAlbum.value = track.album || "";
          $("#trkFile").textContent =
               `${track.format} · ${fmtTime(track.duration)}`;
          paintTrackPick();
          el.trackDialog.showModal();
          el.trkName.focus();
          el.trkName.select();
     }
     async function saveTrackDialog() {
          const track = trackEdit.track;
          const title = el.trkName.value.trim();
          if (!track) return;
          if (!title) {
               toast("A song needs a title.", "error");
               el.trkName.focus();
               return;
          }
          el.trkSave.disabled = true;
          let result = await sendJson(`/api/tracks/${track.id}`, "PUT", {
               title,
               artist: el.trkArtist.value,
               album: el.trkAlbum.value,
               type: trackEdit.type,
               genres: (addGenre(el.trkGenreInput.value), trackEdit.genres), // keep a genre typed but not yet added
          });
          if (!result.error && trackEdit.cover)
               result = await uploadPicture(
                    `/api/tracks/${track.id}/cover`,
                    trackEdit.cover,
               );
          else if (
               !result.error &&
               trackEdit.cover === null &&
               track.hasCover
          ) {
               result = await api(`/api/tracks/${track.id}/cover`, {
                    method: "DELETE",
               }).catch(() => ({ error: "Could not remove the cover." }));
          }
          el.trkSave.disabled = false;
          if (result.error) {
               toast(result.error, "error");
               return;
          }
          const renamed =
               result.title !== track.title || result.artist !== track.artist;
          Object.assign(track, result, { stems: track.stems }); // keep the live separation state
          if (renamed) lyrics.tried.delete(track.id); // a corrected name deserves a fresh lyrics search
          if (filtersOn()) rebuildQueue(); // the song may now be in or out of the filters
          renderView();
          renderFilters();
          if (state.current === track.id) renderNowPlaying();
          closeDialog(el.trackDialog);
          toast(`Saved “${track.title}”`);
     }

     const dialogState = {
          playlist: null,
          selected: new Set(),
          photo: undefined,
     };

     function openPlaylistDialog(playlist, preselected = []) {
          closeMenu();
          dialogState.playlist = playlist;
          dialogState.selected = new Set(
               playlist ? playlist.trackIds : preselected,
          );
          el.dlgTitle.textContent = playlist ? "Edit Playlist" : "New Playlist";
          el.dlgSave.textContent = playlist ? "Save" : "Create";
          el.dlgName.value = playlist ? playlist.name : "";
          el.dlgFilter.value = "";
          dialogState.photo = undefined;
          paintPlaylistPick();
          renderDialogSongs();
          el.dialog.showModal();
          el.dlgName.focus();
     }
     function paintPlaylistPick() {
          const playlist = dialogState.playlist;
          paintPick(
               el.dlgPhoto,
               el.dlgPhotoRemove,
               playlist && playlist.hasCover ? playlistCoverUrl(playlist) : "",
               dialogState.photo,
               ICON.playlist,
          );
     }
     function renderDialogSongs() {
          const query = el.dlgFilter.value.trim().toLowerCase();
          const shown = state.tracks.filter(
               t =>
                    !query ||
                    `${t.title} ${t.artist} ${t.album}`
                         .toLowerCase()
                         .includes(query),
          );
          el.dlgSongs.replaceChildren(
               ...shown.map(track => {
                    const item = document.createElement("li");
                    const label = document.createElement("label");
                    const box = document.createElement("input");
                    box.type = "checkbox";
                    box.value = track.id;
                    box.checked = dialogState.selected.has(track.id);
                    const thumb = document.createElement("div");
                    thumb.className = "thumb";
                    thumb.innerHTML = ICON.note;
                    paintArt(thumb, track);
                    const text = document.createElement("div");
                    text.className = "t-text";
                    const title = document.createElement("span");
                    title.className = "t-title";
                    title.textContent = track.title;
                    const sub = document.createElement("span");
                    sub.className = "t-sub";
                    sub.style.display = "block";
                    sub.textContent = track.artist || `${track.format} file`;
                    text.append(title, sub);
                    const time = document.createElement("span");
                    time.className = "d-time";
                    time.textContent = fmtTime(track.duration);
                    label.append(box, thumb, text, time);
                    item.append(label);
                    return item;
               }),
          );
          el.dlgSongs.hidden = state.tracks.length === 0;
          el.dlgEmpty.hidden = state.tracks.length > 0;
          renderDialogCount();
     }
     function renderDialogCount() {
          const count = dialogState.selected.size;
          el.dlgCount.textContent = `${count} song${count === 1 ? "" : "s"} selected`;
     }
     async function submitPlaylistDialog() {
          const { playlist, selected } = dialogState;
          const name = el.dlgName.value.trim();
          if (playlist) {
               // Keep the existing order, then append newly ticked songs in library order.
               const kept = playlist.trackIds.filter(id => selected.has(id));
               const added = state.tracks
                    .map(t => t.id)
                    .filter(id => selected.has(id) && !kept.includes(id));
               if (
                    !(await savePlaylist(playlist, {
                         name: name || playlist.name,
                         trackIds: [...kept, ...added],
                    }))
               )
                    return;
               if (
                    dialogState.photo ||
                    (dialogState.photo === null && playlist.hasCover)
               )
                    await setPlaylistPhoto(playlist, dialogState.photo);
          } else {
               const trackIds = state.tracks
                    .map(t => t.id)
                    .filter(id => selected.has(id));
               const created = await sendJson("/api/playlists", "POST", {
                    name: name || `Playlist ${state.playlists.length + 1}`,
                    trackIds,
               });
               if (created.error) {
                    toast(created.error, "error");
                    return;
               }
               state.playlists.push(created);
               if (dialogState.photo) {
                    const withPhoto = await uploadPicture(
                         `/api/playlists/${created.id}/cover`,
                         dialogState.photo,
                    );
                    if (withPhoto.error) toast(withPhoto.error, "error");
                    else Object.assign(created, withPhoto);
               }
               state.view = newPlaylistId = created.id;
               state.filter = el.search.value = "";
               renderSidebar();
               renderView(true);
          }
          closeDialog();
     }
     function closeDialog(dialog = el.dialog) {
          // plays the closing animation, then closes
          if (!dialog.open || dialog.classList.contains("closing")) return;
          dialog.classList.add("closing");
          setTimeout(
               () => {
                    dialog.classList.remove("closing");
                    dialog.close();
               },
               motionOn() ? 160 : 0,
          );
     }

     // ───────────── library ─────────────
     async function loadEverything() {
          const [tracks, playlists, settings] = await Promise.all([
               api("/api/tracks").catch(() => null),
               api("/api/playlists").catch(() => null),
               api("/api/settings").catch(() => null),
          ]);
          if (!Array.isArray(tracks)) {
               toast(
                    "Could not load your library. Is the player still running?",
                    "error",
               );
               state.loaded = true;
               renderSidebar();
               renderView();
               return;
          }
          state.tracks = tracks;
          state.playlists = Array.isArray(playlists) ? playlists : [];
          if (settings && typeof settings.autoPrepare === "boolean")
               state.autoPrepare = settings.autoPrepare;
          state.loaded = true;
          rebuildQueue();
          renderSidebar();
          renderView(true);
          renderNowPlaying();
          if (tracks.some(isBusy)) schedulePoll();
     }

     // ───────────── Settings › Migrate: add a whole folder ─────────────
     // The folder's MP3 / WAV / FLAC files (subfolders too) are sent one at a
     // time, in folder order, and copied into data/music. Songs already in the
     // library are skipped by the server (it compares their contents).
     const migrate = { songs: [], others: 0, folder: "", running: false, stop: false };
     const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
     const FOLDER_ICON = el.migIcon.innerHTML;

     function scanFolder(entries) {
          if (migrate.running) return;
          const visible = entries.filter(e => !e.path.split("/").some(part => part.startsWith(".")));
          migrate.songs = visible
               .filter(e => /\.(mp3|wav|flac)$/i.test(e.path))
               .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
          migrate.others = visible.length - migrate.songs.length;
          migrate.folder = (entries[0]?.path.includes("/") && entries[0].path.split("/")[0]) || "Chosen folder";
          el.migCard.hidden = false;
          replay(el.migCard, "enter");
          el.migCard.classList.remove("running", "done");
          el.migIcon.innerHTML = FOLDER_ICON;
          el.migFolder.textContent = migrate.folder;
          el.migBar.hidden = true;
          el.migNow.textContent = "";
          el.migIssues.hidden = true;
          el.migStop.hidden = el.migShow.hidden = true;
          const count = migrate.songs.length;
          el.migSummary.textContent = count
               ? `Found ${plural(count, "song")}` +
                 (migrate.others ? ` (${plural(migrate.others, "other file")} will be left out).` : ".")
               : "No MP3, WAV or FLAC files in this folder.";
          el.migStart.hidden = !count;
          el.migStart.textContent = `Migrate ${plural(count, "Song")}`;
          if (count) el.migStart.focus({ preventScroll: true });
     }

     async function runMigration() {
          const songs = migrate.songs;
          if (!songs.length || migrate.running) return;
          Object.assign(migrate, { running: true, stop: false });
          let added = 0, duplicates = 0;
          const failed = [];
          el.migCard.classList.add("running");
          el.migStart.hidden = true;
          el.migStop.hidden = false;
          el.migChoose.disabled = true;
          el.migBar.hidden = false;
          el.migIssues.hidden = true;
          const bar = el.migBar.firstElementChild;
          bar.style.width = "0%";
          let done = 0;
          for (const { file, path } of songs) {
               if (migrate.stop) break;
               el.migSummary.textContent = `Copying ${done + 1} of ${songs.length}…`;
               el.migNow.textContent = path;
               const form = new FormData();
               form.append("files", file, file.name);
               const result = await api("/api/tracks?skipDuplicates=1", { method: "POST", body: form }).catch(() => ({
                    error: "Could not reach the player.",
               }));
               if (result.error || result.rejected?.length) failed.push(path);
               duplicates += result.duplicates?.length || 0;
               if (result.added?.length) {
                    added += result.added.length;
                    state.tracks.push(...result.added);
                    justAdded = new Set(result.added.map(t => t.id));
                    if (state.loaded) renderView();
                    justAdded = new Set();
               }
               done++;
               bar.style.width = `${(done / songs.length) * 100}%`;
          }
          Object.assign(migrate, { running: false });
          if (state.context === "library") rebuildQueue();
          renderFilters();
          if (state.tracks.some(isBusy)) schedulePoll();

          const stopped = done < songs.length;
          el.migCard.classList.remove("running");
          el.migCard.classList.add("done");
          el.migIcon.innerHTML = ICON.check;
          el.migStop.hidden = true;
          el.migChoose.disabled = false;
          el.migNow.textContent = "";
          el.migShow.hidden = !added;
          el.migSummary.textContent =
               (stopped ? `Stopped after ${done} of ${songs.length}. ` : "") +
               (added || !duplicates
                    ? `Added ${plural(added, "song")}.` +
                      (duplicates ? ` ${plural(duplicates, "song")} ${duplicates === 1 ? "was" : "were"} already in your library.` : "")
                    : `Nothing new: ${duplicates === 1 ? "that song is" : `all ${duplicates} songs are`} already in your library.`) +
               (failed.length ? ` ${plural(failed.length, "file")} couldn't be added:` : "");
          el.migIssues.hidden = !failed.length;
          el.migIssues.replaceChildren(
               ...failed.map(name => {
                    const item = document.createElement("li");
                    item.textContent = name;
                    return item;
               }),
          );
          if (!el.settings.open) toast(`Migration finished: added ${plural(added, "song")}`);
     }

     // `upload` replaces the browser upload (the desktop app's native picker
     // hands over file paths instead of file contents).
     async function addFiles(fileList, upload = null) {
          const files = [...fileList];
          const accepted = files.filter(f => /\.(mp3|wav|flac)$/i.test(f.name));
          const skipped = files.length - accepted.length;
          if (!accepted.length) {
               if (files.length)
                    toast(
                         "Only MP3, WAV and FLAC files can be added.",
                         "error",
                    );
               return;
          }
          // Placeholder rows stand in for the songs until the player has read them.
          state.pendingUploads += accepted.length;
          if (state.view === "library" && !state.filter.trim()) {
               renderView();
               el.list.lastElementChild?.scrollIntoView({
                    block: "nearest",
                    behavior: "smooth",
               });
          } else
               toast(
                    `Adding ${accepted.length} song${accepted.length === 1 ? "" : "s"}…`,
               );
          const form = new FormData();
          if (!upload) for (const file of accepted) form.append("files", file, file.name);
          const result = await (
               upload
                    ? upload(accepted)
                    : api("/api/tracks", {
                           method: "POST",
                           body: form,
                      })
          ).catch(() => ({
               error: "Upload failed. Is the player still running?",
          }));
          state.pendingUploads -= accepted.length;
          if (result.error) {
               renderView();
               toast(result.error, "error");
               return;
          }
          state.tracks.push(...result.added);
          justAdded = new Set(result.added.map(t => t.id));
          if (state.context === "library") {
               if (state.shuffle)
                    state.queue.push(...result.added.map(t => t.id));
               else rebuildQueue();
          }
          renderView();
          justAdded = new Set();
          if (result.added.some(isBusy)) schedulePoll();
          const rejected = skipped + (result.rejected?.length || 0);
          toast(
               `Added ${result.added.length} song${result.added.length === 1 ? "" : "s"} to your library` +
                    (rejected
                         ? ` · skipped ${rejected} unsupported file${rejected === 1 ? "" : "s"}`
                         : ""),
          );
     }

     async function removeTrack(id) {
          const track = trackById(id);
          if (!track) return;
          const result = await api(`/api/tracks/${id}`, {
               method: "DELETE",
          }).catch(() => ({ error: "Could not delete the song." }));
          if (result.error) {
               toast(result.error, "error");
               return;
          }
          await animateOut(rowFor(id));
          const wasCurrent = state.current === id;
          const wasPlaying = state.wantPlaying;
          const following = state.queue[state.queue.indexOf(id) + 1];
          state.tracks = state.tracks.filter(t => t.id !== id);
          for (const playlist of state.playlists)
               playlist.trackIds = playlist.trackIds.filter(
                    trackId => trackId !== id,
               );
          state.queue = state.queue.filter(queued => queued !== id);
          lyrics.cache.delete(id);
          if (wasCurrent) {
               loadToken++;
               audio.pause();
               audio.removeAttribute("src");
               audio.load();
               stopFollower();
               setBuffering(false);
               state.current = null;
               state.wantPlaying = false;
               state.activeStem = "original";
               if (following && wasPlaying) playTrack(following);
               else {
                    renderNowPlaying();
                    renderPlayState();
               }
          }
          renderView();
          toast(`Deleted “${track.title}”`);
     }

     // ───────────── events ─────────────
     el.play.addEventListener("click", togglePlay);
     el.next.addEventListener("click", () => next(false));
     el.prev.addEventListener("click", prev);
     el.shuffle.addEventListener("click", () => {
          state.shuffle = !state.shuffle;
          rebuildQueue();
          renderToggles();
          saveSettings();
     });
     el.loop.addEventListener("click", () => {
          state.loop = { off: "all", all: "one", one: "off" }[state.loop];
          renderToggles();
          saveSettings();
     });
     el.playAll.addEventListener("click", () => playView(false));
     el.shuffleAll.addEventListener("click", () => playView(true));

     // Loop dots: drag them, use the arrow keys (Shift for 5 s), or double-click to reset.
     const dotTime = event => {
          const box = el.loopRange.getBoundingClientRect();
          return clamp((event.clientX - box.left) / box.width, 0, 1) * songLength();
     };
     for (const dot of [el.loopA, el.loopB]) {
          const end = dot.dataset.end;
          dot.addEventListener("pointerdown", event => {
               if (!loopActive()) return;
               event.preventDefault();
               event.stopPropagation();
               dot.setPointerCapture(event.pointerId);
               dot.classList.add("dragging");
               dot.focus({ preventScroll: true, focusVisible: false });
          });
          dot.addEventListener("pointermove", event => {
               if (dot.classList.contains("dragging")) setLoopEnd(end, dotTime(event), false);
          });
          dot.addEventListener("pointerup", event => {
               if (!dot.classList.contains("dragging")) return;
               dot.classList.remove("dragging");
               setLoopEnd(end, dotTime(event), true);
          });
          dot.addEventListener("pointercancel", () => dot.classList.remove("dragging"));
          dot.addEventListener("dblclick", () => setLoopEnd(end, end === "a" ? 0 : songLength(), true));
          dot.addEventListener("keydown", event => {
               const { a, b } = loopRegion();
               const now = end === "a" ? a : b;
               const step = event.shiftKey ? 5 : 1;
               const to = {
                    ArrowLeft: now - step, ArrowDown: now - step,
                    ArrowRight: now + step, ArrowUp: now + step,
                    PageDown: now - 10, PageUp: now + 10,
                    Home: 0, End: songLength(),
               }[event.key];
               if (to === undefined) return;
               event.preventDefault();
               event.stopPropagation();
               setLoopEnd(end, to, true);
          });
     }

     el.seek.addEventListener("input", () => {
          state.seeking = true;
          fill(el.seek);
          el.cur.textContent = fmtTime(Number(el.seek.value));
     });
     el.seek.addEventListener("change", () => {
          if (currentTrack() && !state.loading)
               audio.currentTime = Number(el.seek.value);
          state.seeking = false;
     });

     el.volume.addEventListener("input", () => {
          state.volume = Number(el.volume.value);
          state.muted = false;
          applyVolume();
          saveSettings();
     });
     el.mute.addEventListener("click", () => {
          state.muted = !state.muted;
          applyVolume();
     });

     el.speed.addEventListener("input", () => {
          state.speed = Number(el.speed.value);
          applySpeed();
          saveSettings();
     });
     el.keepPitch.addEventListener("change", () => {
          state.keepPitch = el.keepPitch.checked;
          applySpeed();
          saveSettings();
     });
     document.querySelectorAll("[data-speed]").forEach(pill =>
          pill.addEventListener("click", () => {
               state.speed = Number(pill.dataset.speed);
               applySpeed();
               saveSettings();
          }),
     );

     el.reverb.addEventListener("input", () => {
          state.reverb = Number(el.reverb.value);
          applyReverb();
          saveSettings();
     });
     el.reverbTypes.replaceChildren(
          ...Object.entries(REVERBS).map(([key, recipe]) => {
               const pill = document.createElement("button");
               pill.type = "button";
               pill.className = "pill";
               pill.setAttribute("role", "radio");
               pill.dataset.reverbType = key;
               pill.textContent = recipe.label;
               pill.addEventListener("click", () => {
                    state.reverbType = key;
                    if (state.reverb === 0) state.reverb = 35; // choosing a type should be audible
                    applyReverbType();
                    applyReverb();
                    saveSettings();
               });
               return pill;
          }),
     );

     for (const button of el.stemBtns) {
          button.addEventListener("click", () =>
               setMode(
                    state.mode === button.dataset.mode
                         ? "original"
                         : button.dataset.mode,
               ),
          );
     }
     el.autoPrepare.addEventListener("change", () =>
          setAutoPrepare(el.autoPrepare.checked),
     );

     // Settings
     renderDesignChoices();
     document
          .querySelectorAll("[data-theme-choice]")
          .forEach(button =>
               button.addEventListener("click", () =>
                    chooseDesign(
                         "theme",
                         button.dataset.themeChoice,
                         THEME_KEY,
                         button,
                    ),
               ),
          );
     [$(".segmented"), el.accentChoices, el.uiChoices].forEach(radioKeys);
     const motionToggle = $("#motionToggle");
     motionToggle.checked = motionOn();
     motionToggle.addEventListener("change", () => {
          root.classList.toggle("no-motion", !motionToggle.checked);
          remember(MOTION_KEY, motionToggle.checked ? "on" : "off");
     });
     $("#settingsBtn").addEventListener("click", openSettings);
     $("#setClose").addEventListener("click", () => closeDialog(el.settings));
     el.setModules.addEventListener("click", event => {
          const tab = event.target.closest("[data-module]");
          if (tab) selectModule(tab.dataset.module);
     });
     el.settings.addEventListener("cancel", event => {
          event.preventDefault();
          closeDialog(el.settings);
     });
     el.settings.addEventListener("click", event => {
          if (event.target === el.settings) closeDialog(el.settings);
     });

     // Pictures and song info
     el.imageInput.addEventListener("change", () => {
          const file = el.imageInput.files[0];
          el.imageInput.value = "";
          const callback = onImagePicked;
          onImagePicked = null;
          if (file && callback)
               readablePicture(file).then(picture => picture && callback(picture));
     });
     el.viewArt.addEventListener("click", openViewArtMenu);
     el.viewArt.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
               event.preventDefault();
               openViewArtMenu();
          }
     });
     const choosePlaylistPhoto = () =>
          pickImage(file => {
               dialogState.photo = file;
               paintPlaylistPick();
               replay(el.dlgPhoto, "swap");
          });
     el.dlgPhoto.addEventListener("click", choosePlaylistPhoto);
     el.dlgPhotoChoose.addEventListener("click", choosePlaylistPhoto);
     el.dlgPhotoRemove.addEventListener("click", () => {
          dialogState.photo = null;
          paintPlaylistPick();
     });
     const chooseTrackCover = () =>
          pickImage(file => {
               trackEdit.cover = file;
               paintTrackPick();
               replay(el.trkCover, "swap");
          });
     el.trkCover.addEventListener("click", chooseTrackCover);
     el.trkCoverChoose.addEventListener("click", chooseTrackCover);
     el.trkCoverRemove.addEventListener("click", () => {
          trackEdit.cover = null;
          paintTrackPick();
     });
     el.trackForm.addEventListener("submit", event => {
          event.preventDefault();
          saveTrackDialog();
     });
     el.trkCancel.addEventListener("click", () => closeDialog(el.trackDialog));
     el.trackDialog.addEventListener("cancel", event => {
          event.preventDefault();
          closeDialog(el.trackDialog);
     });
     el.trackDialog.addEventListener("click", event => {
          if (event.target === el.trackDialog) closeDialog(el.trackDialog);
     });

     // Lyrics page and sidebar
     el.playerbar.addEventListener("click", event => {
          // anywhere on the bar that is not a control
          if (!np.open && !event.target.closest("button, input, label"))
               setNowPlaying(true);
     });
     el.npOpen.addEventListener("click", () => setNowPlaying(true));
     el.npBack.addEventListener("click", () => setNowPlaying(false));
     el.lyricsMenuBtn.addEventListener("click", () => {
          if (menuAnchor === el.lyricsMenuBtn) closeMenu();
          else openLyricsMenu();
     });
     el.sidebarBtn.addEventListener("click", () =>
          setSidebar(root.classList.contains("side-hidden"), true),
     );
     el.lyrics.addEventListener("click", event => {
          // jump to a line by clicking it
          const line = event.target.closest(".ly-line[data-time]");
          if (!line || !currentTrack() || state.loading) return;
          audio.currentTime = Number(line.dataset.time);
          lyrics.holdUntil = 0;
          syncLyrics(false);
          if (!state.wantPlaying) play();
     });
     for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
          el.lyrics.addEventListener(
               type,
               () => {
                    lyrics.holdUntil = performance.now() + 3500;
               },
               { passive: true },
          );
     }
     audio.addEventListener("seeked", () => {
          if (np.open) {
               lyrics.holdUntil = 0;
               syncLyrics(true);
          }
     });
     el.autoLyrics.checked = lyrics.auto;
     for (const button of [el.foldBar, el.foldSound]) {
          const name = button.dataset.panel;
          button.addEventListener("click", () =>
               setPanelHidden(name, !root.classList.contains(PANELS[name].cls), true),
          );
     }
     new ResizeObserver(centreLyrics).observe(el.lyrics);
     el.autoLyrics.addEventListener("change", () =>
          setAutoLyrics(el.autoLyrics.checked),
     );
     el.lyricsForm.addEventListener("submit", event => {
          event.preventDefault();
          saveLyricsDialog();
     });
     el.lyCancel.addEventListener("click", () => closeDialog(el.lyricsDialog));
     el.lyricsDialog.addEventListener("cancel", event => {
          event.preventDefault();
          closeDialog(el.lyricsDialog);
     });
     el.lyricsDialog.addEventListener("click", event => {
          if (event.target === el.lyricsDialog) closeDialog(el.lyricsDialog);
     });
     el.lyImport.addEventListener("click", () => el.lrcInput.click());
     el.lrcInput.addEventListener("change", async () => {
          const file = el.lrcInput.files[0];
          el.lrcInput.value = "";
          if (!file) return;
          if (file.size > 500000) {
               toast("That file is too large to be lyrics.", "error");
               return;
          }
          el.lyricsText.value = await file.text();
     });

     // Fluent Design: a soft "reveal" light follows the pointer across each panel.
     let spotFrame = 0,
          spotPanel = null;
     document.addEventListener(
          "pointermove",
          event => {
               if (root.dataset.ui !== "fluent" || spotFrame || !motionOn())
                    return;
               spotFrame = requestAnimationFrame(() => {
                    spotFrame = 0;
                    const panel = event.target.closest
                         ? event.target.closest(
                                ".playerbar, .content, .sound, .dialog",
                           )
                         : null;
                    if (spotPanel && spotPanel !== panel) {
                         spotPanel.style.removeProperty("--mx");
                         spotPanel.style.removeProperty("--my");
                    }
                    spotPanel = panel;
                    if (!panel) return;
                    const box = panel.getBoundingClientRect();
                    panel.style.setProperty(
                         "--mx",
                         `${Math.round(event.clientX - box.left)}px`,
                    );
                    panel.style.setProperty(
                         "--my",
                         `${Math.round(event.clientY - box.top)}px`,
                    );
               });
          },
          { passive: true },
     );

     // Material Design: an ink ripple spreads from wherever a control is pressed.
     const RIPPLE_TARGETS =
          ".btn, .pill, .tbtn, .stem-btn, .side-item, .track, .menu-item, .ui-card, .segmented button";
     document.addEventListener(
          "pointerdown",
          event => {
               if (
                    root.dataset.ui !== "material" ||
                    !motionOn() ||
                    !event.target.closest
               )
                    return;
               const target = event.target.closest(RIPPLE_TARGETS);
               if (
                    !target ||
                    target.disabled ||
                    event.target.closest(".t-more")
               )
                    return;
               const box = target.getBoundingClientRect();
               const x = event.clientX - box.left,
                    y = event.clientY - box.top;
               const ink = document.createElement("i");
               ink.className = "ripple";
               ink.style.setProperty("--x", `${x}px`);
               ink.style.setProperty("--y", `${y}px`);
               ink.style.setProperty(
                    "--d",
                    `${2 * Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y))}px`,
               );
               target.append(ink);
               setTimeout(() => ink.remove(), 650);
          },
          { passive: true },
     );

     // Sidebar navigation
     document.querySelector(".side-nav").addEventListener("click", event => {
          const item = event.target.closest("[data-view]");
          if (!item) return;
          if (item.dataset.view === state.view && !state.filter) return;
          state.view = item.dataset.view;
          state.filter = el.search.value = "";
          renderSidebar();
          renderView(true);
          $("#content").scrollTop = 0;
     });
     $("#newPlaylistBtn").addEventListener("click", () =>
          openPlaylistDialog(null),
     );
     $("#newPlaylistRow").addEventListener("click", () =>
          openPlaylistDialog(null),
     );
     el.editPlaylist.addEventListener("click", () => {
          const playlist = playlistById(state.view);
          if (playlist) openPlaylistDialog(playlist);
     });
     el.deletePlaylist.addEventListener("click", () => {
          const playlist = playlistById(state.view);
          if (
               playlist &&
               armOrConfirm(
                    el.deletePlaylist,
                    "Delete Playlist",
                    "Click again to delete",
               )
          )
               deletePlaylist(playlist);
     });

     // Song list
     el.list.addEventListener("click", event => {
          const row = event.target.closest(".track");
          if (!row) return;
          const more = event.target.closest(".t-more");
          if (more) {
               if (menuAnchor === more) closeMenu();
               else openTrackMenu(trackById(row.dataset.id), more);
               return;
          }
          if (row.dataset.id === state.current) togglePlay();
          else playTrack(row.dataset.id, true, state.view);
     });
     el.list.addEventListener("keydown", event => {
          if (
               event.key !== "Enter" ||
               !event.target.classList.contains("track")
          )
               return;
          event.target.dataset.id === state.current
               ? togglePlay()
               : playTrack(event.target.dataset.id, true, state.view);
     });
     document.addEventListener("pointerdown", event => {
          if (
               !el.menu.hidden &&
               !el.menu.contains(event.target) &&
               !event.target.closest(".t-more, #viewArt, #lyricsMenuBtn, .filter-chip")
          )
               closeMenu();
     });
     $("#content").addEventListener("scroll", closeMenu);
     window.addEventListener("resize", closeMenu);

     // Playlist dialog
     el.dlgFilter.addEventListener("input", renderDialogSongs);
     el.dlgSongs.addEventListener("change", event => {
          if (event.target.checked)
               dialogState.selected.add(event.target.value);
          else dialogState.selected.delete(event.target.value);
          renderDialogCount();
     });
     el.dlgCancel.addEventListener("click", () => closeDialog());
     el.dialog.addEventListener("cancel", event => {
          event.preventDefault();
          closeDialog();
     });
     el.dlgForm.addEventListener("submit", event => {
          event.preventDefault();
          submitPlaylistDialog();
     });
     el.dialog.addEventListener("click", event => {
          if (event.target === el.dialog) closeDialog();
     });

     // Adding music
     // ───────────── Settings › Hotkeys ─────────────
     // Each action has a default key; the listener's own choices are saved in the
     // browser. A key is stored by its position on the keyboard (event.code, like
     // "KeyM" or "ArrowRight"), with any Ctrl / Alt / Shift / Meta in front.
     const HOTKEYS = [
          { group: "Playback", id: "playPause", label: "Play / pause", key: "Space" },
          { id: "next", label: "Next song", key: "Shift+ArrowRight" },
          { id: "prev", label: "Previous song", key: "Shift+ArrowLeft" },
          { id: "seekForward", label: "Forward 5 seconds", key: "ArrowRight" },
          { id: "seekBack", label: "Back 5 seconds", key: "ArrowLeft" },
          { id: "shuffle", label: "Shuffle on / off", key: "KeyS" },
          { id: "loop", label: "Loop (off, playlist, this song)", key: "KeyL" },
          { group: "Sound", id: "volumeUp", label: "Volume up", key: "ArrowUp" },
          { id: "volumeDown", label: "Volume down", key: "ArrowDown" },
          { id: "mute", label: "Mute / unmute", key: "KeyM" },
          { id: "speedUp", label: "Faster", key: "BracketRight" },
          { id: "speedDown", label: "Slower", key: "BracketLeft" },
          { id: "speedReset", label: "Normal speed", key: "Backslash" },
          { group: "Vocals & music", id: "acapella", label: "Acapella on / off", key: "KeyA" },
          { id: "karaoke", label: "Karaoke on / off", key: "KeyK" },
          { group: "Screens", id: "lyrics", label: "Open / close the lyrics page", key: "KeyF" },
          { id: "sidebar", label: "Show / hide the sidebar", key: "KeyB" },
          { id: "search", label: "Search songs", key: "Slash" },
          { id: "settings", label: "Settings", key: "Comma" },
     ];
     const HOTKEYS_KEY = "lewisis-music.hotkeys";
     const hotkeys = (() => {
          let saved = {};
          try {
               saved = JSON.parse(localStorage.getItem(HOTKEYS_KEY)) || {};
          } catch {
               /* private mode or a broken value: use the defaults */
          }
          return Object.fromEntries(HOTKEYS.map(h => [h.id, typeof saved[h.id] === "string" ? saved[h.id] : h.key]));
     })();
     const saveHotkeys = () => remember(HOTKEYS_KEY, JSON.stringify(hotkeys));
     const actionFor = combo => HOTKEYS.find(h => hotkeys[h.id] === combo);
     const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

     // "Shift+ArrowRight" from a key press (null for a lone Shift, Ctrl, …).
     // Some virtual and remote keyboards leave event.code empty: work it out from
     // the character typed instead.
     const CODE_FOR_KEY = {
          " ": "Space", "[": "BracketLeft", "]": "BracketRight", "/": "Slash", "\\": "Backslash",
          ",": "Comma", ".": "Period", ";": "Semicolon", "'": "Quote", "-": "Minus", "=": "Equal", "`": "Backquote",
          "{": "BracketLeft", "}": "BracketRight", "?": "Slash", "|": "Backslash", "<": "Comma", ">": "Period",
          ":": "Semicolon", '"': "Quote", _: "Minus", "+": "Equal", "~": "Backquote",
     };
     function codeOf(event) {
          if (event.code) return event.code;
          const key = event.key || "";
          if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
          if (/^[0-9]$/.test(key)) return "Digit" + key;
          return CODE_FOR_KEY[key] || key;
     }
     function comboOf(event) {
          const code = codeOf(event);
          if (!code || MODIFIER_CODES.test(code) || /^(Shift|Control|Alt|Meta)$/.test(event.key)) return null;
          const parts = [];
          if (event.ctrlKey) parts.push("Ctrl");
          if (event.altKey) parts.push("Alt");
          if (event.shiftKey) parts.push("Shift");
          if (event.metaKey) parts.push("Meta");
          parts.push(code);
          return parts.join("+");
     }
     const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
     const KEY_NAMES = {
          Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Backspace: "Backspace", Delete: "Delete",
          ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "Page Up", PageDown: "Page Down",
          Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
          Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`", IntlBackslash: "\\",
          Ctrl: IS_MAC ? "⌃" : "Ctrl", Alt: IS_MAC ? "⌥" : "Alt", Shift: "Shift", Meta: IS_MAC ? "⌘" : "Super",
     };
     function keyName(part) {
          if (KEY_NAMES[part]) return KEY_NAMES[part];
          if (/^Key[A-Z]$/.test(part)) return part.slice(3);
          if (/^Digit\d$/.test(part)) return part.slice(5);
          if (/^Numpad/.test(part)) return "Num " + part.slice(6);
          return part;
     }
     const comboText = combo => (combo ? combo.split("+").map(keyName).join(" + ") : "no shortcut");
     function keysHtml(combo) {
          if (!combo) return '<span class="none">Not set</span>';
          return combo
               .split("+")
               .map(part => `<kbd>${keyName(part).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</kbd>`)
               .join('<span class="hk-plus">+</span>');
     }

     // The little notice that tells you what a hotkey just did.
     function hud(text, icon = "") {
          el.hud.innerHTML = icon;
          el.hud.append(text);
          replay(el.hud, "show");
     }
     const stemModeIs = mode => state.mode === mode;
     const HOTKEY_ACTIONS = {
          playPause: () => {
               togglePlay();
               if (currentTrack()) hud(state.wantPlaying ? "Playing" : "Paused", state.wantPlaying ? ICON.play : ICON.pause);
          },
          next: () => next(false),
          prev: () => prev(),
          seekForward: () => {
               if (currentTrack()) audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || Infinity);
          },
          seekBack: () => {
               if (currentTrack()) audio.currentTime = Math.max(audio.currentTime - 5, 0);
          },
          shuffle: () => {
               el.shuffle.click();
               hud(`Shuffle ${state.shuffle ? "on" : "off"}`);
          },
          loop: () => {
               el.loop.click();
               hud({ off: "Loop off", all: "Loop: whole playlist", one: "Loop: this song" }[state.loop], state.loop === "one" ? ICON.loopOne : ICON.loop);
          },
          volumeUp: () => changeVolume(5),
          volumeDown: () => changeVolume(-5),
          mute: () => {
               el.mute.click();
               hud(state.muted ? "Muted" : `Volume ${Math.round(state.volume)}%`, state.muted ? ICON.muted : ICON.volume);
          },
          speedUp: () => changeSpeed(state.speed + 5),
          speedDown: () => changeSpeed(state.speed - 5),
          speedReset: () => changeSpeed(100),
          acapella: () => {
               setMode(stemModeIs("vocals") ? "original" : "vocals");
               hud(stemModeIs("vocals") ? "Acapella on" : "Acapella off");
          },
          karaoke: () => {
               setMode(stemModeIs("instrumental") ? "original" : "instrumental");
               hud(stemModeIs("instrumental") ? "Karaoke on" : "Karaoke off");
          },
          lyrics: () => setNowPlaying(!np.open),
          sidebar: () => {
               if (!np.open) el.sidebarBtn.click();
          },
          search: () => {
               if (np.open) setNowPlaying(false);
               if (root.classList.contains("side-hidden")) setSidebar(true, true);
               setTimeout(() => el.search.focus(), np.open ? 450 : 0);
          },
          settings: () => openSettings(),
     };
     function changeVolume(by) {
          state.volume = clamp(state.volume + by, 0, 100);
          state.muted = false;
          applyVolume();
          saveSettings();
          hud(`Volume ${Math.round(state.volume)}%`, state.volume ? ICON.volume : ICON.muted);
     }
     function changeSpeed(to) {
          state.speed = clamp(to, 50, 200);
          applySpeed();
          saveSettings();
          hud(`Speed ${(state.speed / 100).toFixed(2)}×`);
     }

     // The list in Settings › Hotkeys. Click a shortcut, press keys: done.
     // Esc cancels; Backspace or Delete removes the shortcut.
     let recording = null; // { id, button } while waiting for keys
     const RESET_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
     function renderHotkeys(fresh) {
          const sections = [];
          let section = null;
          for (const hotkey of HOTKEYS) {
               if (hotkey.group) {
                    section = document.createElement("section");
                    section.className = "hk-section";
                    section.innerHTML = `<h4>${hotkey.group}</h4>`;
                    sections.push(section);
               }
               const row = document.createElement("div");
               row.className = "hk-row";
               row.dataset.id = hotkey.id;
               row.classList.toggle("changed", hotkeys[hotkey.id] !== hotkey.key);
               const name = document.createElement("span");
               name.className = "hk-name";
               name.id = `hk-${hotkey.id}`;
               name.textContent = hotkey.label;
               const key = document.createElement("button");
               key.type = "button";
               key.className = hotkey.id === fresh ? "hk-key set" : "hk-key";
               key.innerHTML = keysHtml(hotkeys[hotkey.id]);
               key.setAttribute("aria-describedby", name.id);
               key.setAttribute("aria-label", `${hotkey.label}: ${comboText(hotkeys[hotkey.id])}. Press to change.`);
               key.addEventListener("click", () => startRecording(hotkey.id, key));
               const reset = document.createElement("button");
               reset.type = "button";
               reset.className = "hk-reset";
               reset.innerHTML = RESET_ICON;
               reset.title = `Back to ${comboText(hotkey.key)}`;
               reset.setAttribute("aria-label", `Reset ${hotkey.label} to ${comboText(hotkey.key)}`);
               reset.addEventListener("click", () => assignHotkey(hotkey.id, hotkey.key));
               row.append(name, key, reset);
               section.append(row);
          }
          el.hotkeyList.replaceChildren(...sections);
     }
     function startRecording(id, button) {
          stopRecording();
          recording = { id, button };
          button.classList.add("recording");
          button.textContent = "Press keys…";
          button.focus({ preventScroll: true });
     }
     function stopRecording() {
          if (!recording) return;
          const { id, button } = recording;
          recording = null;
          button.classList.remove("recording");
          button.innerHTML = keysHtml(hotkeys[id]);
     }
     // Gives `id` the key `combo`. If another action had it, that one is left
     // without a shortcut (and briefly highlighted) so no key does two things.
     function assignHotkey(id, combo) {
          recording = null;
          const other = combo && HOTKEYS.find(h => h.id !== id && hotkeys[h.id] === combo);
          if (other) hotkeys[other.id] = "";
          hotkeys[id] = combo;
          saveHotkeys();
          renderHotkeys(id);
          const button = el.hotkeyList.querySelector(`.hk-row[data-id="${id}"] .hk-key`);
          if (button) button.focus({ preventScroll: true });
          if (other) {
               const row = el.hotkeyList.querySelector(`.hk-row[data-id="${other.id}"]`);
               if (row) replay(row, "bumped");
               toast(`${comboText(combo)} was used for “${other.label}”, which now has no shortcut.`);
          }
     }
     // While recording, every key press goes here first.
     window.addEventListener(
          "keydown",
          event => {
               if (!recording) return;
               event.preventDefault();
               event.stopPropagation(); // also keeps Esc from closing Settings
               if (event.key === "Escape" || event.key === "Tab") {
                    stopRecording();
                    return;
               }
               const combo = comboOf(event);
               if (!combo) return; // only Shift / Ctrl / … so far: wait for the real key
               if (combo === "Backspace" || combo === "Delete") assignHotkey(recording.id, "");
               else assignHotkey(recording.id, combo);
          },
          true,
     );
     document.addEventListener("pointerdown", event => {
          if (recording && !recording.button.contains(event.target)) stopRecording();
     });
     el.hkResetAll.addEventListener("click", () => {
          stopRecording();
          for (const h of HOTKEYS) hotkeys[h.id] = h.key;
          saveHotkeys();
          renderHotkeys();
          replay(el.hotkeyList, "enter");
          toast("Hotkeys are back to their defaults");
     });
     renderHotkeys();

     // Settings › Migrate
     el.migChoose.addEventListener("click", () => el.folderInput.click());
     el.folderInput.addEventListener("change", () => {
          const entries = [...el.folderInput.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
          el.folderInput.value = "";
          if (entries.length) scanFolder(entries);
     });
     el.migStart.addEventListener("click", runMigration);
     el.migStop.addEventListener("click", () => {
          migrate.stop = true;
          el.migStop.disabled = true;
          el.migSummary.textContent = "Stopping after this song…";
          setTimeout(() => (el.migStop.disabled = false), 400);
     });
     el.migShow.addEventListener("click", () => {
          closeDialog(el.settings);
          state.view = "library";
          state.filter = el.search.value = "";
          renderSidebar();
          renderView(true);
          setTimeout(() => el.list.lastElementChild?.scrollIntoView({ block: "nearest", behavior: motionOn() ? "smooth" : "auto" }), 250);
     });

     // Filters
     for (const chip of el.filterChips)
          chip.addEventListener("click", () => openFilterMenu(chip.dataset.filter, chip));
     el.filterClear.addEventListener("click", () => setFilter("all"));
     el.noResultsClear.addEventListener("click", () => setFilter("all"));

     // Edit Song Info: type and genres
     renderTypePick();
     radioKeys(el.trkType);
     el.trkGenres.addEventListener("click", event => {
          if (event.target === el.trkGenres || event.target === el.trkGenreChips) el.trkGenreInput.focus();
     });
     el.trkGenreInput.addEventListener("input", () => {
          if (/[,;]/.test(el.trkGenreInput.value)) addGenre(el.trkGenreInput.value);
          else renderGenreSuggest();
     });
     el.trkGenreInput.addEventListener("keydown", event => {
          if (event.key === "Enter") {
               event.preventDefault(); // Enter adds the genre rather than saving
               addGenre(el.trkGenreInput.value);
          } else if (event.key === "Backspace" && !el.trkGenreInput.value && trackEdit.genres.length) {
               const chips = el.trkGenreChips.children;
               removeGenre(trackEdit.genres[trackEdit.genres.length - 1], chips[chips.length - 1]);
          }
     });

     el.search.addEventListener("input", () => {
          state.filter = el.search.value;
          renderView();
     });
     el.addMusic.addEventListener("click", () => {
          if (!desktop) return el.fileInput.click();
          desktop
               .pickSongs()
               .then(files => files.length && addFiles(files, desktop.importFiles))
               .catch(error => toast(String(error?.message || error), "error"));
     });
     el.fileInput.addEventListener("change", () => {
          addFiles(el.fileInput.files);
          el.fileInput.value = "";
     });

     let dragDepth = 0;
     const hasFiles = event =>
          [...(event.dataTransfer?.types || [])].includes("Files");
     window.addEventListener("dragenter", event => {
          if (hasFiles(event)) {
               dragDepth++;
               el.drop.hidden = false;
          }
     });
     window.addEventListener("dragleave", event => {
          if (hasFiles(event) && --dragDepth <= 0) {
               dragDepth = 0;
               el.drop.hidden = true;
          }
     });
     window.addEventListener("dragover", event => {
          if (hasFiles(event)) event.preventDefault();
     });
     window.addEventListener("drop", event => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth = 0;
          el.drop.hidden = true;
          addFiles(event.dataTransfer.files);
     });

     window.addEventListener("keydown", event => {
          if (event.key === "Escape") {
               if (!el.menu.hidden) closeMenu();
               else if (np.open && !document.querySelector("dialog[open]"))
                    setNowPlaying(false);
               return;
          }
          if (document.querySelector("dialog[open]")) return;
          if (event.target.closest('textarea, [contenteditable], input:not([type="range"]):not([type="checkbox"])'))
               return; // typing in a box
          const combo = comboOf(event);
          if (!combo) return;
          // Let focused controls keep their own keys: Space / Enter press a button,
          // the arrow keys move a slider.
          if (event.target.closest("button, [role=button], li.track") && /^(Space|Enter|NumpadEnter)$/.test(combo)) return;
          if (event.target.type === "range" && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(combo)) return;
          const action = actionFor(combo);
          if (!action) return;
          event.preventDefault();
          HOTKEY_ACTIONS[action.id]();
     });

     audio.addEventListener("timeupdate", renderProgress);
     audio.addEventListener("timeupdate", () => keepInsideLoop()); // also when the tab is in the background
     audio.addEventListener("durationchange", renderProgress);
     audio.addEventListener("ended", () => next(true));
     audio.addEventListener("waiting", () => setBuffering(true));
     for (const type of ["canplay", "playing", "error"])
          audio.addEventListener(type, () => setBuffering(false));
     audio.addEventListener("pause", () => {
          // Paused from outside the app (media keys, headphones) rather than by us.
          if (
               !state.loading &&
               !audio.ended &&
               state.wantPlaying &&
               audio.src
          ) {
               state.wantPlaying = false;
               renderPlayState();
          }
     });
     audio.addEventListener("play", () => {
          if (!state.wantPlaying) {
               state.wantPlaying = true;
               renderPlayState();
          }
     });
     // Separate Audio: the instruments follow the vocals.
     audio.addEventListener("play", syncFollower);
     audio.addEventListener("pause", () => follower.pause());
     audio.addEventListener("seeked", syncFollower);
     audio.addEventListener("waiting", () => follower.pause());
     audio.addEventListener("playing", syncFollower);
     audio.addEventListener("timeupdate", syncFollower); // the drift check, a few times a second
     follower.addEventListener("canplay", syncFollower); // start it as soon as it is able to
     follower.addEventListener("error", () => {
          if (state.activeStem === "mix" && follower.getAttribute("src")) audio.dispatchEvent(new Event("error"));
     });
     for (const [slider, key] of [
          [el.mixVocals, "mixVocals"],
          [el.mixMusic, "mixMusic"],
     ])
          slider.addEventListener("input", () => {
               state[key] = Number(slider.value);
               applyMix();
               saveSettings();
          });

     audio.addEventListener("error", () => {
          const track = currentTrack();
          if (!track || !audio.src) return;
          state.loading = false;
          if (state.activeStem !== "original") {
               // fall back to the full song
               state.mode = "original";
               loadSource(track, "original", 0, state.wantPlaying);
               toast(
                    "That version could not be played, so the original is playing instead.",
                    "error",
               );
          } else {
               toast(`“${track.title}” could not be played.`, "error");
               pause();
          }
     });

     if ("mediaSession" in navigator) {
          navigator.mediaSession.setActionHandler("play", play);
          navigator.mediaSession.setActionHandler("pause", pause);
          navigator.mediaSession.setActionHandler("previoustrack", prev);
          navigator.mediaSession.setActionHandler("nexttrack", () =>
               next(false),
          );
     }

     // ───────────── start ─────────────
     renderDesign();
     renderFilters();
     setSidebar(!root.classList.contains("side-hidden"), false);
     setShowLyrics(lyrics.shown, false);
     for (const name of Object.keys(PANELS)) {
          let hidden = false;
          try {
               hidden = localStorage.getItem(PANELS[name].key) === "hidden";
          } catch {
               /* private mode */
          }
          setPanelHidden(name, hidden, false);
     }
     setTimeout(() => root.classList.add("booted"), 1500);
     applyVolume(true);
     applyMix(true);
     renderMixer();
     applyReverbType();
     applyReverb(true);
     applySpeed();
     renderToggles();
     renderPlayState();
     renderSidebar();
     renderView();
     renderNowPlaying();
     [el.seek, el.volume, el.speed, el.reverb].forEach(fill);
     loadEverything();
})();
