/* Lewisis' Music — player logic.
 *
 * Audio path:  <audio> ──► dry gain ─────────────► master gain ──► speakers
 *                     └──► convolver ─► wet gain ──┘
 * Speed is the element's playbackRate; reverb is the dry/wet balance through
 * a convolver whose impulse response depends on the chosen reverb type.
 * Acapella / karaoke swap the element's source to an AI-separated stem.
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    loopOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    playlist: '<svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18a3 3 0 1 0 3 3V8h3V6h-5z"/></svg>',
  };
  const MODE_LABEL = { vocals: 'Acapella', instrumental: 'Karaoke' };
  const SETTINGS_KEY = 'lewisis-music.settings';
  const THEME_KEY = 'lewisis-music.theme';
  const MOTION_KEY = 'lewisis-music.motion';

  // Each reverb type is a recipe for a synthetic impulse response.
  const REVERBS = {
    room:      { label: 'Room',      seconds: 0.9,  decay: 3.2, preDelay: 0.004, damping: [0.25, 0.75], early: 6,  level: 1.5 },
    studio:    { label: 'Studio',    seconds: 0.45, decay: 3.6, preDelay: 0.002, damping: [0.12, 0.55], early: 4,  level: 1.3 },
    hall:      { label: 'Hall',      seconds: 2.8,  decay: 2.4, preDelay: 0.02,  damping: [0.3, 0.85],  early: 8,  level: 1.6 },
    cathedral: { label: 'Cathedral', seconds: 6.5,  decay: 1.9, preDelay: 0.045, damping: [0.45, 0.93], early: 10, level: 1.7 },
    plate:     { label: 'Plate',     seconds: 2.0,  decay: 2.9, preDelay: 0,     damping: [0.04, 0.3],  early: 0,  level: 1.4 },
    echo:      { label: 'Echo',      seconds: 3.4,  echo: { delay: 0.32, feedback: 0.56 },              level: 1.5 },
  };

  const el = {
    list: $('#trackList'), tableHead: $('#tableHead'),
    emptyLibrary: $('#emptyLibrary'), emptyPlaylist: $('#emptyPlaylist'), noResults: $('#noResults'),
    viewArt: $('#viewArt'), viewKind: $('#viewKind'), viewTitle: $('#viewTitle'), viewSub: $('#viewSub'),
    playAll: $('#playAllBtn'), shuffleAll: $('#shuffleAllBtn'), addMusic: $('#addMusicBtn'),
    editPlaylist: $('#editPlaylistBtn'), deletePlaylist: $('#deletePlaylistBtn'),
    search: $('#search'), playlistNav: $('#playlistNav'),
    fileInput: $('#fileInput'), drop: $('#dropOverlay'),
    cover: $('#cover'), title: $('#title'), artist: $('#artist'), modeTag: $('#modeTag'),
    seek: $('#seek'), cur: $('#curTime'), dur: $('#durTime'),
    play: $('#playBtn'), prev: $('#prevBtn'), next: $('#nextBtn'), shuffle: $('#shuffleBtn'), loop: $('#loopBtn'),
    mute: $('#muteBtn'), volume: $('#volume'),
    speed: $('#speed'), speedVal: $('#speedVal'), keepPitch: $('#keepPitch'),
    reverb: $('#reverb'), reverbVal: $('#reverbVal'), reverbTypes: $('#reverbTypes'),
    stemBtns: [...document.querySelectorAll('.stem-btn')],
    stemBar: $('#stemBar'), stemText: $('#stemText'),
    autoPrepare: $('#autoPrepare'), prepLabel: $('#prepLabel'),
    menu: $('#menu'), toasts: $('#toasts'),
    dialog: $('#playlistDialog'), dlgForm: $('#playlistForm'), dlgTitle: $('#dlgTitle'), dlgName: $('#dlgName'),
    dlgFilter: $('#dlgFilter'), dlgSongs: $('#dlgSongs'), dlgEmpty: $('#dlgEmpty'), dlgCount: $('#dlgCount'),
    dlgCancel: $('#dlgCancel'), dlgSave: $('#dlgSave'),
  };

  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  })();

  const state = {
    tracks: [],
    playlists: [],
    view: 'library',        // what the song list shows: 'library' or a playlist id
    context: 'library',     // where the playing queue came from
    queue: [],              // track ids in playback order
    current: null,          // id of the loaded track
    mode: 'original',       // what the listener asked for: original | vocals | instrumental
    activeStem: 'original', // what is actually loaded in the <audio> element
    wantPlaying: false,
    loading: false,
    seeking: false,
    filter: '',
    loaded: false,          // false until the library has arrived (skeletons show meanwhile)
    pendingUploads: 0,      // songs being added right now (shown as skeleton rows)
    autoPrepare: true,
    shuffle: !!saved.shuffle,
    loop: ['off', 'all', 'one'].includes(saved.loop) ? saved.loop : 'off',
    volume: clamp(saved.volume ?? 80, 0, 100),
    muted: false,
    speed: clamp(saved.speed ?? 100, 50, 200),
    keepPitch: !!saved.keepPitch,
    reverb: clamp(saved.reverb ?? 0, 0, 100),
    reverbType: REVERBS[saved.reverbType] ? saved.reverbType : 'hall',
  };

  const audio = new Audio();
  audio.preload = 'auto';
  let justAdded = new Set();      // ids of rows that should animate in on the next render
  let newPlaylistId = null;       // sidebar item that should animate in
  let shownTrackId = null;        // track currently shown in the player display

  // ───────────── helpers ─────────────
  function clamp(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  }
  function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60), m = Math.floor(seconds / 60) % 60, h = Math.floor(seconds / 3600);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  }
  function summary(tracks) {
    if (!tracks.length) return 'No songs yet';
    const minutes = Math.max(1, Math.round(tracks.reduce((sum, t) => sum + (t.duration || 0), 0) / 60));
    const length = minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
    return `${tracks.length} song${tracks.length === 1 ? '' : 's'} · ${length}`;
  }
  function tint(id) {
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 45% 58%)`;
  }
  const coverUrl = (id) => `/api/tracks/${id}/cover`;
  const loadedArt = new Set();
  function paintArt(node, track) {
    const hasArt = !!(track && track.hasCover);
    const url = hasArt ? coverUrl(track.id) : '';
    node.classList.toggle('has-art', hasArt);
    node.classList.remove('art-loading', 'art-in');
    node.dataset.art = url;
    node.style.backgroundColor = track && !hasArt ? tint(track.id) : '';
    node.style.backgroundImage = hasArt && loadedArt.has(url) ? `url("${url}")` : '';
    if (!hasArt || loadedArt.has(url)) return;
    node.classList.add('art-loading');              // skeleton shimmer until the picture arrives
    const image = new Image();
    image.onload = image.onerror = () => {
      loadedArt.add(url);
      if (node.dataset.art !== url) return;         // the node shows something else by now
      node.style.backgroundImage = `url("${url}")`;
      node.classList.replace('art-loading', 'art-in');
    };
    image.src = url;
  }
  // Restarts a CSS animation by removing and re-adding its class.
  function replay(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }
  const setBuffering = (on) => document.body.classList.toggle('is-buffering', on);
  const rowFor = (id) => [...el.list.children].find((row) => row.dataset.id === id);
  function animateOut(row) {
    if (!row || document.documentElement.classList.contains('no-motion')) return Promise.resolve();
    row.classList.add('row-out');
    return new Promise((resolve) => setTimeout(resolve, 230));
  }
  function skeletonRow() {
    const row = document.createElement('li');
    row.className = 'track skeleton-row';
    row.setAttribute('aria-hidden', 'true');
    row.innerHTML = '<span class="sk sk-num"></span>'
      + '<div class="t-main"><div class="sk sk-thumb"></div><div class="sk sk-line sk-title"></div></div>'
      + '<span class="sk sk-line sk-artist t-artist"></span><span class="sk sk-line sk-album t-album"></span>'
      + '<span class="sk sk-line sk-time"></span><span></span>';
    return row;
  }
  function fill(range) {
    const span = range.max - range.min;
    range.style.setProperty('--p', `${span > 0 ? ((range.value - range.min) / span) * 100 : 0}%`);
  }
  function saveSettings() {
    const { shuffle, loop, volume, speed, keepPitch, reverb, reverbType } = state;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ shuffle, loop, volume, speed, keepPitch, reverb, reverbType })); } catch { /* private mode */ }
  }
  function toast(message, kind = '') {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    el.toasts.append(node);
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 350); }, kind === 'error' ? 6000 : 3200);
  }
  async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.error) data.error = `Request failed (${response.status})`;
    return data;
  }
  const sendJson = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => ({ error: 'Could not reach the player. Is it still running?' }));
  const trackById = (id) => state.tracks.find((t) => t.id === id);
  const playlistById = (id) => state.playlists.find((p) => p.id === id);
  const currentTrack = () => trackById(state.current);
  const audioUrl = (id, stem) => `/api/tracks/${id}/audio?stem=${stem}`;
  function viewTracks(view = state.view) {
    if (view === 'library') return state.tracks;
    const playlist = playlistById(view);
    return playlist ? playlist.trackIds.map(trackById).filter(Boolean) : [];
  }

  // ───────────── theme ─────────────
  let themeTimer = null;
  function applyTheme(theme, persist) {
    if (persist && theme !== document.documentElement.dataset.theme) {   // cross-fade the colours
      document.documentElement.classList.add('theme-anim');
      clearTimeout(themeTimer);
      themeTimer = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
    }
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ } }
  }

  // ───────────── audio graph ─────────────
  let ctx = null, dryGain, wetGain, masterGain, convolver;
  const impulses = {};

  function makeImpulse(context, recipe) {
    const rate = context.sampleRate;
    const length = Math.floor(rate * recipe.seconds);
    const buffer = context.createBuffer(2, length, rate);

    if (recipe.echo) {            // distinct repeats that bounce left / right and fade
      const step = Math.floor(rate * recipe.echo.delay);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let n = 1; n * step < length; n++) {
          const gain = Math.pow(recipe.echo.feedback, n - 1) * ((n + channel) % 2 ? 1 : 0.35);
          const width = n * 3;    // later repeats are softer / duller
          for (let k = 0; k < width && n * step + k < length; k++) data[n * step + k] += gain / width;
        }
      }
      return buffer;
    }

    const preDelay = Math.floor(rate * recipe.preDelay);
    const [dampStart, dampEnd] = recipe.damping;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let low = 0;
      for (let i = preDelay; i < length; i++) {
        const t = (i - preDelay) / (length - preDelay);
        const damping = dampStart + (dampEnd - dampStart) * t;   // the tail gets darker over time
        low = low * damping + (Math.random() * 2 - 1) * (1 - damping);
        data[i] = low * Math.pow(1 - t, recipe.decay);
      }
      for (let n = 0; n < recipe.early; n++) {                    // a few early wall reflections
        const at = preDelay + Math.floor(rate * (0.004 + Math.random() * 0.012 * (n + 1)));
        if (at < length) data[at] += (Math.random() > 0.5 ? 1 : -1) * 0.5 / (n + 1);
      }
    }
    return buffer;
  }

  function ensureGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(audio);
    convolver = ctx.createConvolver();
    dryGain = ctx.createGain();
    wetGain = ctx.createGain();
    masterGain = ctx.createGain();
    source.connect(dryGain).connect(masterGain);
    source.connect(convolver).connect(wetGain).connect(masterGain);
    masterGain.connect(ctx.destination);
    applyReverbType();
    applyReverb(true);
    applyVolume(true);
  }
  function ramp(param, value, instant) {
    if (instant) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, 0.03);
  }
  function applyVolume(instant = false) {
    el.volume.value = state.volume; fill(el.volume);
    el.volume.title = `Volume ${Math.round(state.volume)}%`;
    const silent = state.muted || state.volume === 0;
    el.mute.innerHTML = silent ? ICON.muted : ICON.volume;
    el.mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
    if (ctx) ramp(masterGain.gain, state.muted ? 0 : Math.pow(state.volume / 100, 2), instant);
  }
  function applyReverbType() {
    for (const pill of el.reverbTypes.children) pill.setAttribute('aria-checked', String(pill.dataset.reverbType === state.reverbType));
    if (!ctx) return;
    impulses[state.reverbType] ||= makeImpulse(ctx, REVERBS[state.reverbType]);
    convolver.buffer = impulses[state.reverbType];
    applyReverb();
  }
  function applyReverb(instant = false) {
    el.reverb.value = state.reverb; fill(el.reverb);
    el.reverbVal.textContent = `${Math.round(state.reverb)}%`;
    if (!ctx) return;
    const mix = state.reverb / 100;
    // Equal-power style crossfade; at 100% the direct sound is almost gone.
    ramp(dryGain.gain, Math.cos(mix * Math.PI / 2 * 0.86), instant);
    ramp(wetGain.gain, Math.sin(mix * Math.PI / 2) * REVERBS[state.reverbType].level, instant);
  }
  function applySpeed() {
    const rate = state.speed / 100;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    audio.preservesPitch = state.keepPitch;
    audio.mozPreservesPitch = state.keepPitch;
    audio.webkitPreservesPitch = state.keepPitch;
    el.speed.value = state.speed; fill(el.speed);
    el.speedVal.textContent = `${rate.toFixed(2)}×`;
    el.keepPitch.checked = state.keepPitch;
    document.querySelectorAll('[data-speed]').forEach((pill) => pill.classList.toggle('on', Number(pill.dataset.speed) === state.speed));
  }

  // ───────────── playback ─────────────
  let loadToken = 0;

  function wantedStem(track) {
    return state.mode !== 'original' && track.stems.state === 'done' ? state.mode : 'original';
  }

  function loadSource(track, stem, time = 0, autoplay = true) {
    const token = ++loadToken;
    state.activeStem = stem;
    state.loading = true;
    setBuffering(true);
    audio.src = audioUrl(track.id, stem);
    applySpeed();
    audio.addEventListener('loadedmetadata', () => {
      if (token !== loadToken) return;
      if (time > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(time, Math.max(0, audio.duration - 0.25));
      state.loading = false;
      if (autoplay) play();
    }, { once: true });
    renderStems();
  }

  function play() {
    if (!currentTrack()) {
      const first = viewTracks()[0];
      if (first) playTrack(first.id, true, state.view);
      return;
    }
    ensureGraph();
    if (ctx.state === 'suspended') ctx.resume();
    state.wantPlaying = true;
    audio.play().catch(() => { /* interrupted by a newer load */ });
    renderPlayState();
  }
  function pause() {
    state.wantPlaying = false;
    audio.pause();
    renderPlayState();
  }
  function togglePlay() { state.wantPlaying ? pause() : play(); }

  function playTrack(id, autoplay = true, context = null) {
    const track = trackById(id);
    if (!track) return;
    state.current = id;
    if ((context && context !== state.context) || !state.queue.includes(id)) {
      if (context) state.context = context;
      rebuildQueue();
    }
    state.wantPlaying = autoplay;
    if (state.mode !== 'original' && track.stems.state !== 'done') requestSeparation(track);
    loadSource(track, wantedStem(track), 0, autoplay);
    renderNowPlaying();
    renderActiveRow(true);
    renderPlayState();
  }

  function rebuildQueue() {
    if (state.context !== 'library' && !playlistById(state.context)) state.context = 'library';
    const ids = viewTracks(state.context).map((t) => t.id);
    if (state.shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      const at = ids.indexOf(state.current);
      if (at > 0) { ids.splice(at, 1); ids.unshift(state.current); }
    }
    state.queue = ids;
  }

  function next(auto = false) {
    if (!state.queue.length) return;
    if (auto && state.loop === 'one') { audio.currentTime = 0; play(); return; }
    let index = state.queue.indexOf(state.current) + 1;
    if (index >= state.queue.length) {
      if (auto && state.loop === 'off') {       // end of the playlist
        pause();
        audio.currentTime = 0;
        return;
      }
      if (state.shuffle) {
        const last = state.current;
        state.current = null;                   // reshuffle for the next lap
        rebuildQueue();
        if (state.queue.length > 1 && state.queue[0] === last) state.queue.push(state.queue.shift());
        state.current = last;
      }
      index = 0;
    }
    playTrack(state.queue[index]);
  }
  function prev() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3 || state.queue.length === 1) { audio.currentTime = 0; if (state.wantPlaying) play(); return; }
    const index = state.queue.indexOf(state.current) - 1;
    playTrack(state.queue[(index + state.queue.length) % state.queue.length]);
  }
  function playView(shuffled) {
    const tracks = viewTracks();
    if (!tracks.length) return;
    if (shuffled && !state.shuffle) { state.shuffle = true; renderToggles(); saveSettings(); }
    const start = shuffled ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0];
    state.current = start.id;
    state.context = state.view;
    rebuildQueue();
    playTrack(start.id, true);
  }

  // ───────────── acapella / karaoke ─────────────
  let pollTimer = null;
  const isBusy = (track) => track.stems.state === 'queued' || track.stems.state === 'running';

  function setMode(mode) {
    state.mode = mode;
    applyMode();
  }

  function applyMode() {
    const track = currentTrack();
    if (track) {
      if (state.mode !== 'original' && track.stems.state !== 'done') requestSeparation(track);
      const stem = wantedStem(track);
      if (stem !== state.activeStem) loadSource(track, stem, audio.currentTime, state.wantPlaying);
    }
    renderStems();
  }

  // Tells the server someone is waiting for this song, so it jumps the queue.
  async function requestSeparation(track) {
    if (track.stems.state === 'none' || track.stems.state === 'error') track.stems = { state: 'queued', progress: 0 };
    renderStems(); renderBadges();
    const data = await api(`/api/tracks/${track.id}/separate`, { method: 'POST' }).catch(() => ({ state: 'error', error: 'Could not reach the player. Is it still running?' }));
    if (!trackById(track.id)) return;
    if (data.error && !data.state) data.state = 'error';
    const before = track.stems.state;
    track.stems = data;
    if (before !== data.state) stemStateChanged(track);
    if (isBusy(track)) schedulePoll();
    renderStems(); renderBadges();
  }

  function schedulePoll() {
    if (!pollTimer) pollTimer = setTimeout(poll, 1000);
  }
  async function poll() {
    pollTimer = null;
    const statuses = await api('/api/stems').catch(() => null);
    if (statuses && !statuses.error) {
      for (const track of state.tracks) {
        const fresh = statuses[track.id];
        if (!fresh) continue;
        const before = track.stems.state;
        track.stems = fresh;
        if (before !== fresh.state) stemStateChanged(track);
      }
    }
    renderStems(); renderBadges();
    if (state.tracks.some(isBusy)) schedulePoll();
  }

  function stemStateChanged(track) {
    const isCurrent = track.id === state.current;
    if (track.stems.state === 'done') {
      if (isCurrent && state.mode !== 'original') applyMode();
    } else if (track.stems.state === 'error' && isCurrent && state.mode !== 'original') {
      toast(`Couldn't separate “${track.title}”: ${track.stems.error || 'unknown error'}`, 'error');
      state.mode = 'original';
    }
  }

  async function setAutoPrepare(on) {
    state.autoPrepare = on;
    const result = await sendJson('/api/settings', 'PUT', { autoPrepare: on });
    if (result.error) { toast(result.error, 'error'); return; }
    state.autoPrepare = !!result.autoPrepare;
    await poll();
  }

  // ───────────── rendering: sidebar & song list ─────────────
  function renderSidebar() {
    document.querySelector('[data-view="library"]').classList.toggle('active', state.view === 'library');
    if (!state.loaded) {
      el.playlistNav.innerHTML = '<div class="side-item sk-item" aria-hidden="true"><span class="sk sk-icon"></span><span class="sk sk-line"></span></div>'.repeat(3);
      return;
    }
    el.playlistNav.replaceChildren(...state.playlists.map((playlist) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = playlist.id === newPlaylistId ? 'side-item item-new' : 'side-item';
      button.dataset.view = playlist.id;
      button.classList.toggle('active', state.view === playlist.id);
      button.innerHTML = ICON.playlist;
      const name = document.createElement('span');
      name.textContent = playlist.name;
      button.append(name);
      return button;
    }));
    newPlaylistId = null;
  }

  function trackRow(track, index) {
    const row = document.createElement('li');
    row.className = 'track';
    row.dataset.id = track.id;
    row.tabIndex = 0;
    row.style.setProperty('--i', Math.min(index, 14));   // stagger for the entrance animation
    if (justAdded.has(track.id)) row.classList.add('row-new');

    const num = document.createElement('span');
    num.className = 't-num';
    num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>';
    const number = document.createElement('b');
    number.textContent = index + 1;
    num.prepend(number);

    const main = document.createElement('div');
    main.className = 't-main';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.innerHTML = ICON.note;
    paintArt(thumb, track);
    const text = document.createElement('div');
    text.className = 't-text';
    const titleRow = document.createElement('div');
    titleRow.className = 't-title-row';
    const title = document.createElement('span');
    title.className = 't-title';
    title.textContent = track.title;
    const badge = document.createElement('span');
    badge.className = 't-badge';
    badge.textContent = 'done';
    titleRow.append(title, badge);
    const sub = document.createElement('span');
    sub.className = 't-sub';
    sub.textContent = track.artist || `${track.format} file`;
    text.append(titleRow, sub);
    main.append(thumb, text);

    const artist = document.createElement('span');
    artist.className = 't-artist';
    artist.textContent = track.artist || '—';
    const album = document.createElement('span');
    album.className = 't-album';
    album.textContent = track.album || '—';
    const duration = document.createElement('span');
    duration.className = 't-dur';
    duration.textContent = fmtTime(track.duration);

    const more = document.createElement('button');
    more.className = 't-more';
    more.type = 'button';
    more.setAttribute('aria-label', `More options for ${track.title}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = ICON.more;

    row.append(num, main, artist, album, duration, more);
    return row;
  }

  function renderViewArt(tracks) {
    const covers = tracks.filter((t) => t.hasCover);
    el.viewArt.className = 'view-art';
    el.viewArt.replaceChildren();
    const tile = (track) => {
      const node = document.createElement('div');
      node.className = 'tile';
      node.style.backgroundImage = `url("${coverUrl(track.id)}")`;
      return node;
    };
    if (covers.length >= 4) { el.viewArt.classList.add('mosaic'); el.viewArt.append(...covers.slice(0, 4).map(tile)); }
    else if (covers.length) { el.viewArt.classList.add('single'); el.viewArt.append(tile(covers[0])); }
    else el.viewArt.innerHTML = ICON.playlist;
  }

  // `animate` plays the entrance animation (used when the view itself changes,
  // not for every re-render such as typing in the search box).
  function renderView(animate = false) {
    if (!state.loaded) {
      el.viewSub.innerHTML = '<span class="sk sk-line sk-sub"></span>';
      el.list.classList.remove('enter');
      el.list.replaceChildren(...Array.from({ length: 6 }, skeletonRow));
      el.playAll.disabled = el.shuffleAll.disabled = true;
      return;
    }
    if (state.view !== 'library' && !playlistById(state.view)) state.view = 'library';
    const isLibrary = state.view === 'library';
    const playlist = isLibrary ? null : playlistById(state.view);
    const all = viewTracks();

    el.viewKind.textContent = isLibrary ? 'Library' : 'Playlist';
    el.viewTitle.textContent = isLibrary ? 'Songs' : playlist.name;
    el.viewSub.textContent = summary(all);
    el.viewArt.hidden = isLibrary;
    if (!isLibrary) renderViewArt(all);
    el.addMusic.hidden = !isLibrary;
    el.editPlaylist.hidden = el.deletePlaylist.hidden = isLibrary;
    disarm(el.deletePlaylist, 'Delete Playlist');
    el.playAll.disabled = el.shuffleAll.disabled = all.length === 0;

    const query = state.filter.trim().toLowerCase();
    const shown = all.filter((t) => !query || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query));
    const pending = isLibrary && !query ? state.pendingUploads : 0;
    el.list.classList.toggle('enter', animate);
    el.list.replaceChildren(...shown.map(trackRow), ...Array.from({ length: pending }, skeletonRow));
    if (animate) replay($('.view-head'), 'enter');
    el.tableHead.hidden = shown.length + pending === 0;
    el.emptyLibrary.hidden = !(isLibrary && all.length === 0 && pending === 0);
    el.emptyPlaylist.hidden = !(!isLibrary && all.length === 0);
    el.noResults.hidden = !(all.length > 0 && shown.length === 0);
    renderActiveRow(false);
    renderBadges();
  }
  function renderActiveRow(scroll) {
    for (const row of el.list.children) {
      const active = row.dataset.id === state.current;
      row.classList.toggle('active', active);
      row.classList.toggle('playing', active && state.wantPlaying);
      if (active && scroll) row.scrollIntoView({ block: 'nearest' });
    }
  }
  function renderBadges() {
    for (const row of el.list.children) {
      const track = trackById(row.dataset.id);
      if (!track) continue;
      row.classList.toggle('has-stems', track.stems.state === 'done');
      row.classList.toggle('is-busy', isBusy(track));
      const badge = row.querySelector('.t-badge');
      badge.textContent = isBusy(track) ? 'preparing' : 'done';
      badge.title = isBusy(track) ? 'Being prepared for Acapella and Karaoke…' : 'Acapella and Karaoke are ready';
    }
    const ready = state.tracks.filter((t) => t.stems.state === 'done').length;
    el.autoPrepare.checked = state.autoPrepare;
    el.prepLabel.textContent = state.tracks.length ? `Prepare ahead · ${ready}/${state.tracks.length} ready` : 'Prepare ahead';
  }

  // ───────────── rendering: player ─────────────
  function renderNowPlaying() {
    const track = currentTrack();
    el.title.textContent = track ? track.title : 'Not Playing';
    el.artist.textContent = track ? [track.artist, track.album].filter(Boolean).join(' — ') : '';
    el.cover.innerHTML = ICON.note;
    paintArt(el.cover, track);
    el.cover.style.color = track && !track.hasCover ? 'rgba(255,255,255,.9)' : '';
    el.seek.disabled = !track;
    if (!track) { el.seek.value = 0; fill(el.seek); el.cur.textContent = el.dur.textContent = '0:00'; }
    else el.dur.textContent = fmtTime(track.duration);
    if ((track ? track.id : null) !== shownTrackId) {
      shownTrackId = track ? track.id : null;
      replay($('.lcd-body'), 'swap');
    }
    document.title = track ? `${track.title} — Lewisis' Music` : "Lewisis' Music";
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = track ? new MediaMetadata({
        title: track.title, artist: track.artist, album: track.album,
        artwork: track.hasCover ? [{ src: coverUrl(track.id) }] : [],
      }) : null;
    }
    renderStems();
  }
  function renderPlayState() {
    el.play.innerHTML = state.wantPlaying ? ICON.pause : ICON.play;
    el.play.setAttribute('aria-label', state.wantPlaying ? 'Pause' : 'Play');
    renderActiveRow(false);
  }
  function renderToggles() {
    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    el.shuffle.title = `Shuffle: ${state.shuffle ? 'on' : 'off'}`;
    el.loop.setAttribute('aria-pressed', String(state.loop !== 'off'));
    el.loop.innerHTML = state.loop === 'one' ? ICON.loopOne : ICON.loop;
    el.loop.title = { off: 'Loop: off', all: 'Loop: whole playlist', one: 'Loop: this song' }[state.loop];
    el.loop.setAttribute('aria-label', el.loop.title);
  }
  function renderProgress() {
    if (state.seeking) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (currentTrack()?.duration || 0);
    el.seek.max = duration || 100;
    el.seek.value = state.loading ? el.seek.value : audio.currentTime;
    fill(el.seek);
    el.cur.textContent = fmtTime(Number(el.seek.value));
    el.dur.textContent = fmtTime(duration);
  }
  function renderStems() {
    const track = currentTrack();
    const stems = track ? track.stems : { state: 'none' };
    for (const button of el.stemBtns) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));

    const playingStem = track && state.activeStem !== 'original';
    el.modeTag.hidden = !playingStem;
    if (playingStem) el.modeTag.textContent = MODE_LABEL[state.activeStem];

    const waiting = state.mode !== 'original';
    const busy = track && isBusy(track) && (waiting || stems.state === 'running');
    el.stemBar.hidden = !busy;
    el.stemText.classList.toggle('error', stems.state === 'error');
    let text;
    if (!track) {
      text = waiting
        ? `${MODE_LABEL[state.mode]} is on for the next song you play.`
        : 'Play a song, then switch on Acapella or Karaoke.';
    } else if (stems.state === 'queued') {
      el.stemBar.classList.add('indeterminate');
      text = waiting ? 'Starting… it will switch over by itself.' : 'Waiting its turn to be prepared.';
    } else if (stems.state === 'running') {
      const separating = stems.stage === 'separating' || stems.stage === 'saving';
      const percent = Math.round((stems.progress || 0) * 100);
      el.stemBar.classList.toggle('indeterminate', !separating);
      el.stemBar.firstElementChild.style.width = `${percent}%`;
      text = separating ? `Separating vocals from music… ${percent}%` : 'Starting the AI…';
      if (waiting) text += ' It will switch over by itself.';
    } else if (stems.state === 'error') {
      text = stems.error || 'Separation failed.';
    } else if (playingStem) {
      text = state.activeStem === 'vocals' ? 'Instruments removed. You are hearing vocals only.' : 'Vocals removed. Sing along!';
    } else if (stems.state === 'done') {
      text = 'Ready. Both versions of this song switch on instantly.';
    } else {
      text = 'Not prepared yet. Switching on takes about half the song’s length the first time.';
    }
    el.stemText.textContent = text;
  }

  // ───────────── menus ─────────────
  let menuAnchor = null;

  function closeMenu() {
    if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
    menuAnchor = null;
    el.menu.hidden = true;
  }
  function showMenu(anchor, items) {
    closeMenu();
    el.menu.replaceChildren(...items.map((item) => {
      if (item.separator) return document.createElement('hr');
      if (item.heading) {
        const heading = document.createElement('div');
        heading.className = 'menu-heading';
        heading.textContent = item.heading;
        return heading;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `menu-item${item.danger ? ' danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.disabled = !!item.disabled;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(label);
      if (item.checked) button.insertAdjacentHTML('beforeend', ICON.check);
      button.addEventListener('click', () => {
        if (item.confirm && !button.dataset.armed) { button.dataset.armed = '1'; label.textContent = item.confirm; return; }
        closeMenu();
        item.action();
      });
      return button;
    }));
    el.menu.hidden = false;
    const anchorBox = anchor.getBoundingClientRect(), menuBox = el.menu.getBoundingClientRect();
    let top = anchorBox.bottom + 4;
    if (top + menuBox.height > window.innerHeight - 8) top = Math.max(8, anchorBox.top - menuBox.height - 4);
    el.menu.style.top = `${top}px`;
    el.menu.style.left = `${Math.max(8, Math.min(anchorBox.right - menuBox.width, window.innerWidth - menuBox.width - 8))}px`;
    menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
  }

  function openTrackMenu(track, anchor) {
    const items = [{ heading: 'Add to playlist' }];
    for (const playlist of state.playlists) {
      const already = playlist.trackIds.includes(track.id);
      items.push({ label: playlist.name, checked: already, disabled: already, action: () => addToPlaylist(playlist, track) });
    }
    items.push({ label: 'New Playlist…', action: () => openPlaylistDialog(null, [track.id]) });
    items.push({ separator: true });
    const playlist = playlistById(state.view);
    if (playlist) items.push({ label: 'Remove from This Playlist', action: () => removeFromPlaylist(playlist, track) });
    items.push({ label: 'Delete from Library', danger: true, confirm: 'Click again to delete', action: () => removeTrack(track.id) });
    showMenu(anchor, items);
  }

  // Two-step confirmation for destructive buttons.
  function disarm(button, label) { button.classList.remove('danger'); button.dataset.armed = ''; button.textContent = label; }
  function armOrConfirm(button, label, confirmLabel) {
    if (button.dataset.armed) { disarm(button, label); return true; }
    button.dataset.armed = '1';
    button.classList.add('danger');
    button.textContent = confirmLabel;
    setTimeout(() => { if (button.dataset.armed) disarm(button, label); }, 3500);
    return false;
  }

  // ───────────── playlists ─────────────
  function playlistChanged(playlist) {
    if (state.context === playlist.id) rebuildQueue();
    renderSidebar();
    renderView();
  }
  async function savePlaylist(playlist, fields) {
    const result = await sendJson(`/api/playlists/${playlist.id}`, 'PUT', fields);
    if (result.error) { toast(result.error, 'error'); return false; }
    Object.assign(playlist, result);
    playlistChanged(playlist);
    return true;
  }
  async function addToPlaylist(playlist, track) {
    if (await savePlaylist(playlist, { trackIds: [...playlist.trackIds, track.id] })) toast(`Added “${track.title}” to ${playlist.name}`);
  }
  async function removeFromPlaylist(playlist, track) {
    await animateOut(rowFor(track.id));
    if (!await savePlaylist(playlist, { trackIds: playlist.trackIds.filter((id) => id !== track.id) })) renderView();
  }
  async function deletePlaylist(playlist) {
    const result = await api(`/api/playlists/${playlist.id}`, { method: 'DELETE' }).catch(() => ({ error: 'Could not delete the playlist.' }));
    if (result.error) { toast(result.error, 'error'); return; }
    state.playlists = state.playlists.filter((p) => p.id !== playlist.id);
    if (state.context === playlist.id) { state.context = 'library'; rebuildQueue(); }
    state.view = 'library';
    renderSidebar();
    renderView(true);
    toast(`Deleted playlist “${playlist.name}”`);
  }

  const dialogState = { playlist: null, selected: new Set() };

  function openPlaylistDialog(playlist, preselected = []) {
    closeMenu();
    dialogState.playlist = playlist;
    dialogState.selected = new Set(playlist ? playlist.trackIds : preselected);
    el.dlgTitle.textContent = playlist ? 'Edit Playlist' : 'New Playlist';
    el.dlgSave.textContent = playlist ? 'Save' : 'Create';
    el.dlgName.value = playlist ? playlist.name : '';
    el.dlgFilter.value = '';
    renderDialogSongs();
    el.dialog.showModal();
    el.dlgName.focus();
  }
  function renderDialogSongs() {
    const query = el.dlgFilter.value.trim().toLowerCase();
    const shown = state.tracks.filter((t) => !query || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query));
    el.dlgSongs.replaceChildren(...shown.map((track) => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = track.id;
      box.checked = dialogState.selected.has(track.id);
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.innerHTML = ICON.note;
      paintArt(thumb, track);
      const text = document.createElement('div');
      text.className = 't-text';
      const title = document.createElement('span');
      title.className = 't-title';
      title.textContent = track.title;
      const sub = document.createElement('span');
      sub.className = 't-sub';
      sub.style.display = 'block';
      sub.textContent = track.artist || `${track.format} file`;
      text.append(title, sub);
      const time = document.createElement('span');
      time.className = 'd-time';
      time.textContent = fmtTime(track.duration);
      label.append(box, thumb, text, time);
      item.append(label);
      return item;
    }));
    el.dlgSongs.hidden = state.tracks.length === 0;
    el.dlgEmpty.hidden = state.tracks.length > 0;
    renderDialogCount();
  }
  function renderDialogCount() {
    const count = dialogState.selected.size;
    el.dlgCount.textContent = `${count} song${count === 1 ? '' : 's'} selected`;
  }
  async function submitPlaylistDialog() {
    const { playlist, selected } = dialogState;
    const name = el.dlgName.value.trim();
    if (playlist) {
      // Keep the existing order, then append newly ticked songs in library order.
      const kept = playlist.trackIds.filter((id) => selected.has(id));
      const added = state.tracks.map((t) => t.id).filter((id) => selected.has(id) && !kept.includes(id));
      if (!await savePlaylist(playlist, { name: name || playlist.name, trackIds: [...kept, ...added] })) return;
    } else {
      const trackIds = state.tracks.map((t) => t.id).filter((id) => selected.has(id));
      const created = await sendJson('/api/playlists', 'POST', { name: name || `Playlist ${state.playlists.length + 1}`, trackIds });
      if (created.error) { toast(created.error, 'error'); return; }
      state.playlists.push(created);
      state.view = newPlaylistId = created.id;
      state.filter = el.search.value = '';
      renderSidebar();
      renderView(true);
    }
    closeDialog();
  }
  function closeDialog() {            // plays the closing animation, then closes
    if (!el.dialog.open || el.dialog.classList.contains('closing')) return;
    el.dialog.classList.add('closing');
    setTimeout(() => { el.dialog.classList.remove('closing'); el.dialog.close(); }, 160);
  }

  // ───────────── library ─────────────
  async function loadEverything() {
    const [tracks, playlists, settings] = await Promise.all([
      api('/api/tracks').catch(() => null), api('/api/playlists').catch(() => null), api('/api/settings').catch(() => null),
    ]);
    if (!Array.isArray(tracks)) {
      toast('Could not load your library. Is the player still running?', 'error');
      state.loaded = true; renderSidebar(); renderView();
      return;
    }
    state.tracks = tracks;
    state.playlists = Array.isArray(playlists) ? playlists : [];
    if (settings && typeof settings.autoPrepare === 'boolean') state.autoPrepare = settings.autoPrepare;
    state.loaded = true;
    rebuildQueue();
    renderSidebar();
    renderView(true);
    renderNowPlaying();
    if (tracks.some(isBusy)) schedulePoll();
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    const accepted = files.filter((f) => /\.(mp3|wav|flac)$/i.test(f.name));
    const skipped = files.length - accepted.length;
    if (!accepted.length) { if (files.length) toast('Only MP3, WAV and FLAC files can be added.', 'error'); return; }
    // Placeholder rows stand in for the songs until the player has read them.
    state.pendingUploads += accepted.length;
    if (state.view === 'library' && !state.filter.trim()) {
      renderView();
      el.list.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else toast(`Adding ${accepted.length} song${accepted.length === 1 ? '' : 's'}…`);
    const form = new FormData();
    for (const file of accepted) form.append('files', file, file.name);
    const result = await api('/api/tracks', { method: 'POST', body: form }).catch(() => ({ error: 'Upload failed. Is the player still running?' }));
    state.pendingUploads -= accepted.length;
    if (result.error) { renderView(); toast(result.error, 'error'); return; }
    state.tracks.push(...result.added);
    justAdded = new Set(result.added.map((t) => t.id));
    if (state.context === 'library') {
      if (state.shuffle) state.queue.push(...result.added.map((t) => t.id)); else rebuildQueue();
    }
    renderView();
    justAdded = new Set();
    if (result.added.some(isBusy)) schedulePoll();
    const rejected = skipped + (result.rejected?.length || 0);
    toast(`Added ${result.added.length} song${result.added.length === 1 ? '' : 's'} to your library` + (rejected ? ` · skipped ${rejected} unsupported file${rejected === 1 ? '' : 's'}` : ''));
  }

  async function removeTrack(id) {
    const track = trackById(id);
    if (!track) return;
    const result = await api(`/api/tracks/${id}`, { method: 'DELETE' }).catch(() => ({ error: 'Could not delete the song.' }));
    if (result.error) { toast(result.error, 'error'); return; }
    await animateOut(rowFor(id));
    const wasCurrent = state.current === id;
    const wasPlaying = state.wantPlaying;
    const following = state.queue[state.queue.indexOf(id) + 1];
    state.tracks = state.tracks.filter((t) => t.id !== id);
    for (const playlist of state.playlists) playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== id);
    state.queue = state.queue.filter((queued) => queued !== id);
    if (wasCurrent) {
      loadToken++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setBuffering(false);
      state.current = null;
      state.wantPlaying = false;
      state.activeStem = 'original';
      if (following && wasPlaying) playTrack(following);
      else { renderNowPlaying(); renderPlayState(); }
    }
    renderView();
    toast(`Deleted “${track.title}”`);
  }

  // ───────────── events ─────────────
  el.play.addEventListener('click', togglePlay);
  el.next.addEventListener('click', () => next(false));
  el.prev.addEventListener('click', prev);
  el.shuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    rebuildQueue(); renderToggles(); saveSettings();
  });
  el.loop.addEventListener('click', () => {
    state.loop = { off: 'all', all: 'one', one: 'off' }[state.loop];
    renderToggles(); saveSettings();
  });
  el.playAll.addEventListener('click', () => playView(false));
  el.shuffleAll.addEventListener('click', () => playView(true));

  el.seek.addEventListener('input', () => { state.seeking = true; fill(el.seek); el.cur.textContent = fmtTime(Number(el.seek.value)); });
  el.seek.addEventListener('change', () => {
    if (currentTrack() && !state.loading) audio.currentTime = Number(el.seek.value);
    state.seeking = false;
  });

  el.volume.addEventListener('input', () => { state.volume = Number(el.volume.value); state.muted = false; applyVolume(); saveSettings(); });
  el.mute.addEventListener('click', () => { state.muted = !state.muted; applyVolume(); });

  el.speed.addEventListener('input', () => { state.speed = Number(el.speed.value); applySpeed(); saveSettings(); });
  el.keepPitch.addEventListener('change', () => { state.keepPitch = el.keepPitch.checked; applySpeed(); saveSettings(); });
  document.querySelectorAll('[data-speed]').forEach((pill) => pill.addEventListener('click', () => { state.speed = Number(pill.dataset.speed); applySpeed(); saveSettings(); }));

  el.reverb.addEventListener('input', () => { state.reverb = Number(el.reverb.value); applyReverb(); saveSettings(); });
  el.reverbTypes.replaceChildren(...Object.entries(REVERBS).map(([key, recipe]) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill';
    pill.setAttribute('role', 'radio');
    pill.dataset.reverbType = key;
    pill.textContent = recipe.label;
    pill.addEventListener('click', () => {
      state.reverbType = key;
      if (state.reverb === 0) state.reverb = 35;     // choosing a type should be audible
      applyReverbType(); applyReverb(); saveSettings();
    });
    return pill;
  }));

  for (const button of el.stemBtns) {
    button.addEventListener('click', () => setMode(state.mode === button.dataset.mode ? 'original' : button.dataset.mode));
  }
  el.autoPrepare.addEventListener('change', () => setAutoPrepare(el.autoPrepare.checked));

  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.themeChoice, true)));
  const motionToggle = $('#motionToggle');
  motionToggle.checked = !document.documentElement.classList.contains('no-motion');
  motionToggle.addEventListener('change', () => {
    document.documentElement.classList.toggle('no-motion', !motionToggle.checked);
    try { localStorage.setItem(MOTION_KEY, motionToggle.checked ? 'on' : 'off'); } catch { /* private mode */ }
  });

  // Sidebar navigation
  document.querySelector('.side-nav').addEventListener('click', (event) => {
    const item = event.target.closest('[data-view]');
    if (!item) return;
    if (item.dataset.view === state.view && !state.filter) return;
    state.view = item.dataset.view;
    state.filter = el.search.value = '';
    renderSidebar();
    renderView(true);
    $('#content').scrollTop = 0;
  });
  $('#newPlaylistBtn').addEventListener('click', () => openPlaylistDialog(null));
  $('#newPlaylistRow').addEventListener('click', () => openPlaylistDialog(null));
  el.editPlaylist.addEventListener('click', () => { const playlist = playlistById(state.view); if (playlist) openPlaylistDialog(playlist); });
  el.deletePlaylist.addEventListener('click', () => {
    const playlist = playlistById(state.view);
    if (playlist && armOrConfirm(el.deletePlaylist, 'Delete Playlist', 'Click again to delete')) deletePlaylist(playlist);
  });

  // Song list
  el.list.addEventListener('click', (event) => {
    const row = event.target.closest('.track');
    if (!row) return;
    const more = event.target.closest('.t-more');
    if (more) {
      if (menuAnchor === more) closeMenu(); else openTrackMenu(trackById(row.dataset.id), more);
      return;
    }
    if (row.dataset.id === state.current) togglePlay(); else playTrack(row.dataset.id, true, state.view);
  });
  el.list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.classList.contains('track')) return;
    event.target.dataset.id === state.current ? togglePlay() : playTrack(event.target.dataset.id, true, state.view);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!el.menu.hidden && !el.menu.contains(event.target) && !event.target.closest('.t-more')) closeMenu();
  });
  $('#content').addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  // Playlist dialog
  el.dlgFilter.addEventListener('input', renderDialogSongs);
  el.dlgSongs.addEventListener('change', (event) => {
    if (event.target.checked) dialogState.selected.add(event.target.value); else dialogState.selected.delete(event.target.value);
    renderDialogCount();
  });
  el.dlgCancel.addEventListener('click', closeDialog);
  el.dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
  el.dlgForm.addEventListener('submit', (event) => { event.preventDefault(); submitPlaylistDialog(); });
  el.dialog.addEventListener('click', (event) => { if (event.target === el.dialog) closeDialog(); });

  // Adding music
  el.search.addEventListener('input', () => { state.filter = el.search.value; renderView(); });
  el.addMusic.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });

  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (event) => { if (hasFiles(event)) { dragDepth++; el.drop.hidden = false; } });
  window.addEventListener('dragleave', (event) => { if (hasFiles(event) && --dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
  window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0; el.drop.hidden = true;
    addFiles(event.dataTransfer.files);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeMenu(); return; }
    if (el.dialog.open) return;
    if (event.target.closest('input, textarea, button, [contenteditable]') && !(event.target.type === 'range' && event.code === 'Space')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.code === 'ArrowRight' && currentTrack()) audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || Infinity);
    else if (event.code === 'ArrowLeft' && currentTrack()) audio.currentTime = Math.max(audio.currentTime - 5, 0);
  });

  audio.addEventListener('timeupdate', renderProgress);
  audio.addEventListener('durationchange', renderProgress);
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('waiting', () => setBuffering(true));
  for (const type of ['canplay', 'playing', 'error']) audio.addEventListener(type, () => setBuffering(false));
  audio.addEventListener('pause', () => {
    // Paused from outside the app (media keys, headphones) rather than by us.
    if (!state.loading && !audio.ended && state.wantPlaying && audio.src) { state.wantPlaying = false; renderPlayState(); }
  });
  audio.addEventListener('play', () => { if (!state.wantPlaying) { state.wantPlaying = true; renderPlayState(); } });
  audio.addEventListener('error', () => {
    const track = currentTrack();
    if (!track || !audio.src) return;
    state.loading = false;
    if (state.activeStem !== 'original') {          // fall back to the full song
      state.mode = 'original';
      loadSource(track, 'original', 0, state.wantPlaying);
      toast('That version could not be played, so the original is playing instead.', 'error');
    } else {
      toast(`“${track.title}” could not be played.`, 'error');
      pause();
    }
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  }

  // ───────────── start ─────────────
  applyTheme(document.documentElement.dataset.theme, false);
  applyVolume(true);
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
