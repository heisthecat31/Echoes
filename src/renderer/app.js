/* Echoes — shell renderer.
   Talks to the main process through window.echoes (see src/preload/shell.js).
   When opened in a plain browser it falls back to a demo API so the UI can be designed
   without Electron. */
(() => {
  'use strict';

  const R = window.echoes || createDemoApi();
  const body = document.body;
  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  body.classList.add(`platform-${R.platform}`, 'booting');

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */
  let state = {
    title: '', artist: '', album: '', art: '', artHi: '',
    playing: false, time: 0, duration: 0, volume: 100, muted: false,
    like: 'INDIFFERENT', repeat: 'NONE', hasTrack: false,
  };
  let stateAt = performance.now();
  let scrubbing = null; // { ratio } while dragging a seek slider
  let mode = 'normal';
  let queue = [];

  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const setText = (sel, value) => $$(sel).forEach((el) => {
    if (el.textContent !== value) el.textContent = value;
  });
  const currentTime = () => {
    if (!state.playing) return state.time;
    return Math.min(state.duration || Infinity, state.time + (performance.now() - stateAt) / 1000);
  };

  /* ------------------------------------------------------------------ */
  /* Artwork + ambient                                                  */
  /* ------------------------------------------------------------------ */
  const ambLayers = $$('.amb-art');
  let ambIndex = 0;
  let shownArt = '';

  function preload(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(false);
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }

  async function showArt(small, hi) {
    const key = hi || small;
    if (key === shownArt) return;
    shownArt = key;
    $$('[data-art]').forEach((img) => { img.src = small || hi || ''; });
    const ok = await preload(hi);
    if (shownArt !== key) return;
    const src = ok ? hi : small;
    $$('[data-art-hi]').forEach((img) => { img.src = src || ''; });
    ambIndex = 1 - ambIndex;
    const next = ambLayers[ambIndex];
    const prev = ambLayers[1 - ambIndex];
    next.style.backgroundImage = src ? `url("${src.replace(/"/g, '%22')}")` : 'none';
    next.classList.add('on');
    prev.classList.remove('on');
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                             */
  /* ------------------------------------------------------------------ */
  function render() {
    const s = state;
    body.classList.toggle('playing', !!s.playing);
    $('#playerbar').classList.toggle('no-track', !s.hasTrack);

    setText('[data-title]', s.title || 'Nothing playing');
    setText('[data-artist]', s.artist || '');
    setText('[data-album]', s.album || '');
    setText('[data-sub]', s.hasTrack
      ? [s.artist, s.album].filter(Boolean).join('  ·  ')
      : 'Pick something to listen to');

    showArt(s.art, s.artHi);

    $$('.like').forEach((b) => {
      b.classList.toggle('liked', s.like === 'LIKE');
      b.setAttribute('aria-pressed', String(s.like === 'LIKE'));
    });
    $$('[data-cmd="dislike"]').forEach((b) => b.classList.toggle('disliked', s.like === 'DISLIKE'));
    $$('.repeat').forEach((b) => {
      b.classList.toggle('on', s.repeat !== 'NONE');
      b.classList.toggle('repeat-one', s.repeat === 'ONE');
      b.dataset.tip = s.repeat === 'ONE' ? 'Repeat one' : s.repeat === 'ALL' ? 'Repeat all' : 'Repeat';
    });
    $$('.play').forEach((b) => b.setAttribute('aria-label', s.playing ? 'Pause' : 'Play'));

    const vol = $('.volume');
    vol.classList.toggle('muted', s.muted || s.volume === 0);
    vol.classList.toggle('low', s.volume > 0 && s.volume < 45);
    if (!volDragging) setSlider($('[data-volume]'), s.muted ? 0 : s.volume / 100);

    setText('[data-duration]', fmt(s.duration));
  }

  function renderQueue(items) {
    queue = items || [];
    const list = $('[data-queue]');
    list.replaceChildren();
    const count = $('[data-queue-count]');
    if (!queue.length) {
      const li = document.createElement('li');
      li.className = 'q-empty';
      li.textContent = 'Your queue will show up here once something is playing.';
      list.append(li);
      count.textContent = '';
      return;
    }
    const cur = queue.findIndex((q) => q.current);
    const upcoming = cur >= 0 ? queue.length - cur - 1 : queue.length;
    count.textContent = `${upcoming} track${upcoming === 1 ? '' : 's'}`;
    for (const q of queue) {
      const li = document.createElement('li');
      li.className = `q-item${q.current ? ' current' : ''}`;
      li.dataset.index = q.index;
      li.tabIndex = 0;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (q.art) img.src = q.art;
      const meta = document.createElement('div');
      meta.className = 'q-meta';
      const t = document.createElement('div'); t.className = 'q-title'; t.textContent = q.title;
      const a = document.createElement('div'); a.className = 'q-artist'; a.textContent = q.artist;
      meta.append(t, a);
      const d = document.createElement('span'); d.className = 'q-dur'; d.textContent = q.duration || '';
      li.append(img, meta, d);
      list.append(li);
    }
    if (mode === 'nowplaying') scrollQueueToCurrent();
  }

  function scrollQueueToCurrent() {
    const cur = $('.q-item.current');
    if (cur) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('[data-queue]').addEventListener('click', (e) => {
    const li = e.target.closest('.q-item');
    if (li) R.player.send('queue-play', Number(li.dataset.index));
  });
  $('[data-queue]').addEventListener('keydown', (e) => {
    const li = e.target.closest('.q-item');
    if (li && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      R.player.send('queue-play', Number(li.dataset.index));
    }
  });

  /* ------------------------------------------------------------------ */
  /* Sliders                                                            */
  /* ------------------------------------------------------------------ */
  function setSlider(el, ratio) {
    if (!el) return;
    el.style.setProperty('--p', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
  }

  function attachSlider(el, { onInput, onCommit, tip }) {
    const ratioOf = (e) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    const tipEl = $('.hover-tip', el);
    let dragging = false;
    el.addEventListener('pointermove', (e) => {
      const ratio = ratioOf(e);
      el.style.setProperty('--h', `${ratio * 100}%`);
      if (tipEl && tip) tipEl.textContent = tip(ratio);
      if (dragging) onInput(ratio);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      onInput(ratioOf(e));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      onCommit(ratioOf(e));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const current = parseFloat(el.style.getPropertyValue('--p')) / 100 || 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); onCommit(Math.min(1, current + step)); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); onCommit(Math.max(0, current - step)); }
    });
  }

  $$('[data-seek]').forEach((el) => attachSlider(el, {
    tip: (r) => fmt(r * state.duration),
    onInput: (r) => { scrubbing = { ratio: r }; },
    onCommit: (r) => {
      scrubbing = null;
      if (!state.duration) return;
      const t = r * state.duration;
      state.time = t;
      stateAt = performance.now();
      R.player.send('seek', t);
    },
  }));

  let volDragging = false;
  let volTimer = 0;
  const volEl = $('[data-volume]');
  attachSlider(volEl, {
    onInput: (r) => {
      volDragging = true;
      setSlider(volEl, r);
      state.volume = Math.round(r * 100);
      state.muted = false;
      clearTimeout(volTimer);
      volTimer = setTimeout(() => R.player.send('volume', state.volume), 30);
      render();
    },
    onCommit: (r) => {
      volDragging = false;
      state.volume = Math.round(r * 100);
      state.muted = false;
      setSlider(volEl, r);
      R.player.send('volume', state.volume);
      render();
    },
  });
  volEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, state.volume + (e.deltaY < 0 ? 5 : -5)));
    state.volume = v; state.muted = false;
    R.player.send('volume', v);
    render();
  }, { passive: false });

  /* ------------------------------------------------------------------ */
  /* Progress animation loop                                            */
  /* ------------------------------------------------------------------ */
  const seekEls = $$('[data-seek]');
  let lastTimeText = '';
  function frame() {
    const dur = state.duration || 0;
    const t = scrubbing ? scrubbing.ratio * dur : currentTime();
    const ratio = dur ? t / dur : 0;
    for (const el of seekEls) setSlider(el, ratio);
    const text = fmt(t);
    if (text !== lastTimeText) {
      lastTimeText = text;
      setText('[data-time]', text);
      setText('[data-remaining]', `-${fmt(Math.max(0, dur - t))}`);
    }
    // Power saving: redraw once a second (the time only changes that often) instead of every frame.
    if (body.classList.contains('power-saving') && !scrubbing) setTimeout(() => requestAnimationFrame(frame), 1000);
    else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ------------------------------------------------------------------ */
  /* Commands                                                           */
  /* ------------------------------------------------------------------ */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    R.player.send(cmd);
    // Optimistic UI so the click feels instant.
    if (cmd === 'toggle' && state.hasTrack) {
      state.time = currentTime(); stateAt = performance.now();
      state.playing = !state.playing;
    } else if (cmd === 'like') {
      state.like = state.like === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
    } else if (cmd === 'dislike') {
      state.like = state.like === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';
    } else if (cmd === 'mute') {
      state.muted = !state.muted;
    }
    render();
  });

  const setMode = (m) => R.view.set(m);
  $('#nav-back').onclick = () => R.nav.back();
  $('#nav-forward').onclick = () => R.nav.forward();
  $('#nav-home').onclick = () => R.nav.home();
  $('#nav-reload').onclick = () => R.nav.reload();
  $('#tb-nowplaying').onclick = () => setMode(mode === 'nowplaying' ? 'normal' : 'nowplaying');
  $('#tb-mini').onclick = () => setMode('mini');
  $('#tb-settings').onclick = () => setMode(mode === 'settings' ? 'normal' : 'settings');
  $('#st-close').onclick = () => setMode('normal');
  $('#pb-mini').onclick = () => setMode('mini');
  $('#pb-art').onclick = () => setMode('nowplaying');
  $('#pb-queue').onclick = () => setMode('nowplaying');
  // Opens YouTube Music's own player page on its Lyrics tab (synced lyrics live there).
  $('#pb-lyrics').onclick = () => { setMode('normal'); R.player.send('lyrics'); };
  $('#np-close').onclick = () => setMode('normal');
  $('#mini-expand').onclick = () => setMode('normal');
  $('#mini-close').onclick = () => R.window.close();
  $('#win-min').onclick = () => R.window.minimize();
  $('#win-max').onclick = () => R.window.toggleMaximize();
  $('#win-close').onclick = () => R.window.close();
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) R.window.toggleMaximize();
  });
  $('#error-retry').onclick = () => R.nav.reload();

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape' && (mode === 'nowplaying' || mode === 'settings')) setMode('normal');
    else if (e.key === ' ' && !e.target.closest('button, .q-item')) { e.preventDefault(); $('.play').click(); }
    else if (mode !== 'normal' && e.key === 'ArrowRight' && !e.target.closest('.slider')) R.player.send('seek', currentTime() + 5);
    else if (mode !== 'normal' && e.key === 'ArrowLeft' && !e.target.closest('.slider')) R.player.send('seek', Math.max(0, currentTime() - 5));
  });

  /* ------------------------------------------------------------------ */
  /* Tooltips                                                           */
  /* ------------------------------------------------------------------ */
  const tooltip = $('#tooltip');
  let tipTimer = 0;
  let tipTarget = null;
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el === tipTarget) return;
    tipTarget = el;
    clearTimeout(tipTimer);
    tooltip.classList.remove('show');
    if (!el || mode === 'mini') return;
    tipTimer = setTimeout(() => {
      tooltip.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      const tr = tooltip.getBoundingClientRect();
      const below = r.top < 80;
      let x = r.left + r.width / 2 - tr.width / 2;
      x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
      const y = below ? r.bottom + 8 : r.top - tr.height - 8;
      tooltip.style.transform = '';
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
      tooltip.classList.add('show');
    }, 480);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tooltip.classList.remove('show'); });

  /* ------------------------------------------------------------------ */
  /* Wiring to main                                                     */
  /* ------------------------------------------------------------------ */
  R.player.onState((s) => {
    state = { ...state, ...s };
    stateAt = performance.now();
    if (!s.hasVideo) body.classList.remove('has-video');
    render();
  });

  /* ---- Music video background frames ---- */
  const videoCanvases = $$('[data-video]').map((c) => ({ c, ctx: c.getContext('2d', { alpha: false }) }));
  let videoTimer = 0;
  let drawing = false;
  R.player.onFrame(async (bytes) => {
    if (drawing || !body.classList.contains('video-on')) return;
    drawing = true;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      for (const { c, ctx } of videoCanvases) {
        if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0);
      }
      bmp.close();
      body.classList.add('has-video');
      clearTimeout(videoTimer);
      videoTimer = setTimeout(() => { if (!state.playing || !state.hasVideo) body.classList.remove('has-video'); }, 2500);
    } catch { /* bad frame */ }
    drawing = false;
  });

  /* ---- Settings ---- */
  const applySettings = (st) => {
    if (!st) return;
    const videoBg = !!st.videoBackground && !st.powerSaving;
    body.classList.toggle('video-on', videoBg);
    body.classList.toggle('soft-focus', !!st.softFocus);
    body.classList.toggle('power-saving', !!st.powerSaving);
    if (!videoBg) body.classList.remove('has-video');
    $$('[data-setting]').forEach((input) => { input.checked = !!st[input.dataset.setting]; });
  };
  $$('[data-setting]').forEach((input) => {
    input.addEventListener('change', () => R.settings.set(input.dataset.setting, input.checked));
  });
  R.settings.onChange(applySettings);
  R.settings.get().then(applySettings);
  if (R.info) R.info().then((i) => setText('[data-version]', i && i.version ? `v${i.version}` : '')).catch(() => {});
  R.player.onQueue(renderQueue);
  R.player.onAccent((a) => {
    if (!a) return;
    root.style.setProperty('--accent', a.accent);
    root.style.setProperty('--deep', a.deep);
  });
  R.view.onMode((m) => {
    mode = m;
    body.classList.remove('mode-normal', 'mode-nowplaying', 'mode-mini', 'mode-settings');
    body.classList.add(`mode-${m}`);
    $('#tb-nowplaying use').setAttribute('href', m === 'nowplaying' ? '#i-collapse' : '#i-expand');
    if (m === 'nowplaying') setTimeout(scrollQueueToCurrent, 350);
  });
  R.window.onMaximized((max) => {
    $('#win-max use').setAttribute('href', max ? '#i-restore' : '#i-max');
    $('#win-max').setAttribute('aria-label', max ? 'Restore' : 'Maximize');
  });
  R.nav.onState(({ canBack, canForward }) => {
    $('#nav-back').disabled = !canBack;
    $('#nav-forward').disabled = !canForward;
  });
  R.nav.onLoading((loading) => {
    body.classList.toggle('is-loading', loading);
    if (loading) $('.error-card').hidden = true;
    else setTimeout(() => body.classList.remove('booting'), 250);
  });
  R.nav.onError(({ desc }) => {
    body.classList.remove('booting');
    $('.error-desc').textContent = `${desc || 'Network error'}. Check your connection and try again.`;
    $('.error-card').hidden = false;
  });

  render();
  R.ready();

  /* ================================================================== */
  /* Demo API — only used when opened outside Electron                  */
  /* ================================================================== */
  function createDemoApi() {
    const listeners = {};
    const on = (ch) => (cb) => { (listeners[ch] ||= []).push(cb); };
    const emit = (ch, v) => (listeners[ch] || []).forEach((cb) => cb(v));
    const artFor = (a, b, c) => `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'><defs><radialGradient id='g' cx='30%' cy='25%' r='90%'><stop offset='0' stop-color='${a}'/><stop offset='.55' stop-color='${b}'/><stop offset='1' stop-color='${c}'/></radialGradient></defs><rect width='400' height='400' fill='url(#g)'/><circle cx='280' cy='290' r='70' fill='${a}' opacity='.35'/><circle cx='120' cy='130' r='36' fill='#fff' opacity='.18'/></svg>`)}`;
    const tracks = [
      { title: 'Neon Tides', artist: 'Lumen Drive', album: 'Afterglow', duration: 214, colors: ['#ff8a5b', '#e83f6f', '#2b1055'], accent: 'rgb(255, 104, 122)', deep: 'rgb(30, 10, 22)' },
      { title: 'Glass Gardens', artist: 'Mira Sol', album: 'Hothouse', duration: 187, colors: ['#7cf5c5', '#1f9e89', '#0b2240'], accent: 'rgb(84, 230, 186)', deep: 'rgb(8, 26, 26)' },
      { title: 'Velvet Static', artist: 'Low Orbit Choir', album: 'Signal / Noise', duration: 243, colors: ['#a78bfa', '#6d28d9', '#111133'], accent: 'rgb(168, 140, 255)', deep: 'rgb(18, 12, 38)' },
      { title: 'Paper Planets', artist: 'Juno & the Lakes', album: 'Small Gravity', duration: 199, colors: ['#ffd36e', '#f08a24', '#3d1c02'], accent: 'rgb(255, 190, 92)', deep: 'rgb(32, 18, 6)' },
      { title: 'Cold Water Hymn', artist: 'Arden Vale', album: 'Northern Rooms', duration: 262, colors: ['#8ec5ff', '#3b6fd8', '#0a1630'], accent: 'rgb(120, 172, 255)', deep: 'rgb(8, 16, 34)' },
    ];
    let i = 0;
    const s = { playing: true, time: 42, volume: 72, muted: false, like: 'INDIFFERENT', repeat: 'NONE', hasTrack: true, hasVideo: true };
    const demoSettings = { videoBackground: true, softFocus: true, dynamicAccent: true, closeToTray: false, adBlock: true, discordPresence: false, powerSaving: false };
    let demoMode = new URLSearchParams(location.search).get('mode') || 'normal';
    const push = () => {
      const t = tracks[i];
      const art = artFor(...t.colors);
      emit('player:state', { ...s, title: t.title, artist: t.artist, album: t.album, duration: t.duration, art, artHi: art });
    };
    const pushQueue = () => emit('player:queue', tracks.map((t, index) => ({
      index, title: t.title, artist: t.artist, art: artFor(...t.colors),
      duration: fmt(t.duration), current: index === i,
    })));
    const load = (n) => {
      i = (n + tracks.length) % tracks.length;
      s.time = 0;
      emit('player:accent', { accent: tracks[i].accent, deep: tracks[i].deep });
      push(); pushQueue();
    };
    setInterval(() => {
      if (!s.playing) return;
      s.time += 1;
      if (s.time >= tracks[i].duration) load(i + 1); else push();
    }, 1000);
    return {
      platform: 'demo',
      ready: () => setTimeout(() => {
        emit('ytm:loading', false);
        emit('view:mode', demoMode);
        emit('nav:state', { canBack: true, canForward: false });
        load(0); s.time = 42; push();
        // Fake "music video" so the video background can be previewed in a browser.
        const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
        const cx = cv.getContext('2d');
        setInterval(() => {
          if (!s.playing) return;
          const t = performance.now() / 1000;
          const [c1, c2, c3] = tracks[i].colors;
          const g = cx.createLinearGradient(160 + Math.cos(t) * 160, 0, 160 - Math.cos(t) * 160, 180);
          g.addColorStop(0, c1); g.addColorStop(0.5, c2); g.addColorStop(1, c3);
          cx.fillStyle = g; cx.fillRect(0, 0, 320, 180);
          for (let k = 0; k < 5; k++) {
            cx.fillStyle = 'rgba(255,255,255,0.18)';
            cx.beginPath();
            cx.arc(160 + Math.sin(t * (0.6 + k * 0.2) + k) * 130, 90 + Math.cos(t * (0.5 + k * 0.15) + k) * 60, 18 + k * 6, 0, 7);
            cx.fill();
          }
          cv.toBlob((b) => b && b.arrayBuffer().then((buf) => emit('player:frame', new Uint8Array(buf))), 'image/jpeg', 0.8);
        }, 1000 / 20);
      }, 300),
      window: { minimize() {}, toggleMaximize() {}, close() {}, onMaximized: on('window:maximized') },
      nav: { back() {}, forward() {}, home() {}, reload() {}, onState: on('nav:state'), onLoading: on('ytm:loading'), onError: on('ytm:error') },
      player: {
        send(type, value) {
          if (type === 'toggle') s.playing = !s.playing;
          if (type === 'next') return load(i + 1);
          if (type === 'prev') return load(i - 1);
          if (type === 'queue-play') return load(value);
          if (type === 'seek') s.time = value;
          if (type === 'volume') { s.volume = value; s.muted = false; }
          if (type === 'mute') s.muted = !s.muted;
          if (type === 'like') s.like = s.like === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
          if (type === 'dislike') s.like = s.like === 'DISLIKE' ? 'INDIFFERENT' : 'DISLIKE';
          if (type === 'repeat') s.repeat = { NONE: 'ALL', ALL: 'ONE', ONE: 'NONE' }[s.repeat];
          push();
        },
        onState: on('player:state'), onQueue: on('player:queue'), onAccent: on('player:accent'), onFrame: on('player:frame'),
      },
      view: { set(m) { demoMode = m; emit('view:mode', m); }, onMode: on('view:mode') },
      settings: {
        get: () => Promise.resolve({ ...demoSettings }),
        set(k, v) { demoSettings[k] = v; emit('settings:changed', { ...demoSettings }); },
        onChange: on('settings:changed'),
      },
      info: () => Promise.resolve({ version: '1.0.0' }),
    };
  }
})();
