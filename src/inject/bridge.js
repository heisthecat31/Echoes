// Injected into music.youtube.com's MAIN world by the main process.
// Reads the YT player + Media Session and reports state; executes shell commands.
(() => {
  if (window.__echoesBridgeLoaded) return;
  window.__echoesBridgeLoaded = true;
  const api = window.__echoes;
  if (!api) return;

  const $ = (sel, root = document) => root.querySelector(sel);
  const first = (sels, root = document) => {
    for (const s of sels) { const el = root.querySelector(s); if (el) return el; }
    return null;
  };
  const player = () => document.getElementById('movie_player');
  const bar = () => $('ytmusic-player-bar');
  const video = () => $('video');
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  const press = (el) => {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return true;
  };

  // Timers that slow down in power saving mode. Each runs at `fast` ms normally, `slow` ms when saving.
  let powerSaving = false;
  const timers = [];
  function every(fast, slow, fn) {
    const t = { fast, slow, fn, id: 0 };
    t.start = () => { clearInterval(t.id); t.id = setInterval(fn, powerSaving ? slow : fast); };
    timers.push(t);
    t.start();
  }
  // In power saving mode, ask YT for its lowest video quality: far less decoding work, and the
  // audio is unaffected. Re-applied as tracks change.
  // Only touches tracks that are actually showing video: asking an audio-only song for a quality
  // makes YT load a video stream it didn't need (and pause while it does).
  let qualityLowered = false;
  function applyQuality() {
    const p = player();
    const v = video();
    if (!p || typeof p.setPlaybackQualityRange !== 'function') return;
    try {
      if (powerSaving) {
        if (!v || !(v.videoWidth > 0)) return;
        if (typeof p.getPlaybackQuality === 'function' && p.getPlaybackQuality() === 'tiny') return;
        p.setPlaybackQualityRange('tiny', 'tiny');
        qualityLowered = true;
      } else if (qualityLowered) {
        p.setPlaybackQualityRange('auto', 'auto');
        qualityLowered = false;
      }
    } catch { /* ignore */ }
  }

  function metadata() {
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    const b = bar();
    const p = player();
    const vd = (p && p.getVideoData && p.getVideoData()) || {};
    let art = '';
    if (m && m.artwork && m.artwork.length) art = m.artwork[m.artwork.length - 1].src;
    if (!art && b) { const img = $('img.image', b); if (img) art = img.src; }
    return {
      title: (m && m.title) || text(b && $('.title', b)) || vd.title || '',
      artist: (m && m.artist) || vd.author || '',
      album: (m && m.album) || '',
      art,
      videoId: vd.video_id || '',
    };
  }

  function likeStatus() {
    const el = $('ytmusic-player-bar ytmusic-like-button-renderer');
    return (el && el.getAttribute('like-status')) || 'INDIFFERENT';
  }

  function repeatMode() {
    const b = bar();
    if (!b) return 'NONE';
    const attr = b.getAttribute('repeat-mode') || b.getAttribute('repeat-mode_');
    if (attr) return attr;
    const btn = $('.repeat', b);
    const label = ((btn && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || '').toLowerCase();
    if (label.includes('one')) return 'ONE';
    if (label.includes('all')) return 'ALL';
    return 'NONE';
  }

  // Ads play through the same player: the time and duration are the ad's, but the Media Session
  // still names the song, so without this the song appears to have the ad's length.
  const adShowing = () => {
    const p = player();
    return !!(p && p.classList && p.classList.contains('ad-showing'));
  };

  // Song position. The <video> element's clock is NOT the song's: YT streams one track after
  // another into the same element, so after a skip it keeps counting from the previous song.
  // YT Music's own (hidden) progress bar always shows the right numbers, so it's the reference;
  // the player API is used for sub-second precision when it agrees with it.
  function trackTime() {
    const p = player();
    const v = video();
    const has = (fn) => p && typeof p[fn] === 'function';
    const pb = $('ytmusic-player-bar #progress-bar');
    const barNow = pb ? Number(pb.getAttribute('aria-valuenow')) : NaN;
    const barMax = pb ? Number(pb.getAttribute('aria-valuemax')) : NaN;
    let time = has('getCurrentTime') ? p.getCurrentTime() : NaN;
    let duration = has('getDuration') ? p.getDuration() : NaN;
    if (Number.isFinite(barNow) && (!Number.isFinite(time) || Math.abs(time - barNow) > 1.5)) time = barNow;
    if (Number.isFinite(barMax) && barMax > 0 && (!Number.isFinite(duration) || Math.abs(duration - barMax) > 2)) duration = barMax;
    if (!Number.isFinite(time)) time = v ? v.currentTime : 0;
    if (!Number.isFinite(duration) || duration <= 0) duration = v && Number.isFinite(v.duration) ? v.duration : 0;
    return { time: Math.max(0, time), duration };
  }

  function snapshot() {
    const p = player();
    const v = video();
    let meta = metadata();
    const ad = adShowing();
    if (ad) {
      meta = {
        ...meta,
        title: 'Advertisement',
        artist: meta.title ? `${meta.title} plays after this` : '',
        album: '',
      };
    }
    const has = (fn) => p && typeof p[fn] === 'function';
    const ps = has('getPlayerState') ? p.getPlayerState() : -1;
    return {
      ...meta,
      playing: v ? !v.paused && !v.ended : ps === 1,
      buffering: ps === 3,
      ...trackTime(),
      volume: has('getVolume') ? p.getVolume() : (v ? Math.round(v.volume * 100) : 100),
      muted: has('isMuted') ? p.isMuted() : (v ? v.muted : false),
      like: likeStatus(),
      repeat: repeatMode(),
      ad,
      hasTrack: !!meta.title,
      hasVideo: !!(v && v.videoWidth > 0),
    };
  }

  let lastKey = '';
  let lastSent = 0;
  function emit(force) {
    const s = snapshot();
    const key = JSON.stringify({ ...s, time: Math.round(s.time) });
    const now = Date.now();
    if (!force && key === lastKey && now - lastSent < 2000) return;
    lastKey = key; lastSent = now;
    api.state(s);
  }

  let lastQueueKey = '';
  function emitQueue() {
    const items = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')]
      .filter((el) => !el.closest('#counterpart-renderer'));
    const queue = items.slice(0, 80).map((el, index) => {
      // YT Music only fills a row's <img> once it scrolls into view; the row's data always
      // has the thumbnail, so prefer that.
      const data = el.data || (el.__data && el.__data.data);
      const thumbs = data && data.thumbnail && data.thumbnail.thumbnails;
      const img = $('img', el);
      return {
        index,
        title: text($('.song-title', el)),
        artist: text($('.byline', el)),
        duration: text($('.duration', el)),
        art: (thumbs && thumbs.length && thumbs[thumbs.length - 1].url) || (img ? img.src : ''),
        current: el.hasAttribute('selected') || el.getAttribute('play-button-state') === 'playing'
          || el.getAttribute('play-button-state') === 'paused',
      };
    });
    const key = JSON.stringify(queue);
    if (key === lastQueueKey) return;
    lastQueueKey = key;
    api.queue(queue);
  }

  // Attach media listeners (the <video> element can be swapped by YT).
  let boundVideo = null;
  function bindVideo() {
    const v = video();
    if (!v || v === boundVideo) return;
    boundVideo = v;
    for (const ev of ['play', 'pause', 'playing', 'seeked', 'volumechange', 'loadedmetadata', 'durationchange', 'ended', 'waiting']) {
      v.addEventListener(ev, () => emit(true));
    }
  }

  // ---- Video background: stream small JPEG frames of the music video to the shell ----
  const bg = { enabled: false, fps: 12, width: 320, timer: 0, busy: false, lastT: -1 };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  function grabFrame() {
    const v = video();
    if (!v || bg.busy || v.readyState < 2 || !v.videoWidth) return;
    if (v.paused && v.currentTime === bg.lastT) return; // one frame is enough while paused
    bg.lastT = v.currentTime;
    const w = bg.width;
    const h = Math.round((w * v.videoHeight) / v.videoWidth);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    try { ctx.drawImage(v, 0, 0, w, h); } catch { return; }
    bg.busy = true;
    try {
      canvas.toBlob((blob) => {
        if (!blob) { bg.busy = false; return; }
        blob.arrayBuffer().then((buf) => { api.frame(new Uint8Array(buf)); bg.busy = false; }, () => { bg.busy = false; });
      }, 'image/jpeg', 0.75);
    } catch { bg.busy = false; } // tainted canvas: give up quietly
  }
  function configureBg(cfg) {
    Object.assign(bg, cfg || {});
    clearInterval(bg.timer);
    bg.lastT = -1;
    if (bg.enabled) bg.timer = setInterval(grabFrame, Math.round(1000 / Math.max(1, Math.min(30, bg.fps))));
  }

  every(500, 1000, () => { bindVideo(); emit(false); });
  every(1500, 5000, emitQueue);
  every(4000, 4000, () => { if (powerSaving) applyQuality(); });
  new MutationObserver(() => emit(true)).observe(document.documentElement, {
    subtree: true, attributes: true, attributeFilter: ['like-status', 'repeat-mode', 'repeat-mode_'],
  });

  const setVolume = (value) => {
    const p = player();
    const vol = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (p && p.setVolume) p.setVolume(vol);
    if (p && vol > 0 && p.isMuted && p.isMuted()) p.unMute();
    const slider = $('ytmusic-player-bar #volume-slider');
    if (slider) slider.value = vol;
    try {
      localStorage.setItem('yt-player-volume', JSON.stringify({
        data: JSON.stringify({ volume: vol, muted: false }), creation: Date.now(), expiration: Date.now() + 2592e6,
      }));
    } catch { /* ignore */ }
  };

  api.onCommand((cmd) => {
    const p = player();
    const b = bar();
    switch (cmd && cmd.type) {
      case 'toggle':
        if (!press(b && first(['#play-pause-button', '.play-pause-button'], b))) {
          if (p) (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo());
        }
        break;
      case 'play': if (p) p.playVideo(); break;
      case 'pause': if (p) p.pauseVideo(); break;
      case 'next':
        if (!press(b && $('.next-button', b)) && p) p.nextVideo();
        break;
      case 'prev':
        if (!press(b && $('.previous-button', b)) && p) p.previousVideo();
        break;
      case 'seek':
        if (p && p.seekTo) p.seekTo(Math.max(0, Number(cmd.value) || 0), true);
        else if (video()) video().currentTime = Number(cmd.value) || 0;
        break;
      case 'volume': setVolume(cmd.value); break;
      case 'mute':
        if (p && p.isMuted) (p.isMuted() ? p.unMute() : p.mute());
        break;
      case 'like':
        press(first([
          'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button',
          'ytmusic-player-bar ytmusic-like-button-renderer .like',
          'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like',
        ]));
        break;
      case 'dislike':
        press(first([
          'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-dislike button',
          'ytmusic-player-bar ytmusic-like-button-renderer .dislike',
          'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-dislike',
        ]));
        break;
      case 'shuffle': press(b && first(['.shuffle', 'tp-yt-paper-icon-button.shuffle'], b)); break;
      case 'repeat': press(b && first(['.repeat', 'tp-yt-paper-icon-button.repeat'], b)); break;
      case 'queue-play': {
        const items = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')]
          .filter((el) => !el.closest('#counterpart-renderer'));
        const item = items[Number(cmd.value)];
        // Clicking the row's text doesn't play it; its play button does.
        if (item) press($('ytmusic-play-button-renderer', item) || $('.song-info', item) || item);
        break;
      }
      case 'lyrics': {
        // Open YT Music's player page (its own bar, which normally does this, is hidden) and
        // switch to the Lyrics tab; pressing again while it's open closes it.
        const layout = $('ytmusic-app-layout');
        const host = $('ytmusic-app') || layout;
        const store = host && (host.ytmusicReduxBehavior || (layout && layout.ytmusicReduxBehavior));
        if (!store || !store.store) break;
        const open = layout && layout.getAttribute('player-ui-state') === 'PLAYER_PAGE_OPEN';
        const lyricsTab = () => [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab')]
          .find((t) => /lyric/i.test(t.textContent || ''));
        const onLyrics = lyricsTab() && lyricsTab().getAttribute('aria-selected') === 'true';
        if (open && onLyrics) {
          store.store.dispatch({ type: 'SET_PLAYER_PAGE_INFO', payload: { open: false } });
          store.store.dispatch({ type: 'SET_PLAYER_UI_STATE', payload: 'PLAYER_BAR_ONLY' });
          break;
        }
        if (!open) {
          store.store.dispatch({ type: 'SET_PLAYER_PAGE_INFO', payload: { open: true } });
          store.store.dispatch({ type: 'SET_PLAYER_UI_STATE', payload: 'PLAYER_PAGE_OPEN' });
        }
        let tries = 0;
        const pick = () => {
          const t = lyricsTab();
          if (t && t.getAttribute('aria-disabled') !== 'true') press(t);
          else if (tries++ < 20) setTimeout(pick, 150);
        };
        setTimeout(pick, 150);
        break;
      }
      case 'power': {
        const on = !!cmd.value;
        if (on === powerSaving) return;
        powerSaving = on;
        timers.forEach((t) => t.start());
        applyQuality();
        return;
      }
      case 'bg-video': configureBg(cmd.value); return;
      case 'home': {
        const link = first([
          'ytmusic-guide-entry-renderer:first-of-type tp-yt-paper-item',
          'ytmusic-pivot-bar-item-renderer[tab-id="FEmusic_home"]',
          'ytmusic-nav-bar a#logo, ytmusic-nav-bar .left-content a',
        ]);
        if (!press(link)) location.assign('/');
        break;
      }
      default: break;
    }
    setTimeout(() => emit(true), 80);
    setTimeout(() => emit(true), 400);
  });

  emit(true);

  /* ---------- Synced lyrics ---------- */
  // YT Music mostly has unsynced lyrics. Fetch timed lyrics (LRCLIB, via the main process) and
  // draw them in our own panel over the Lyrics tab, so YT Music's own elements are never touched.
  const root = document.documentElement;
  let lyr = { key: '', lines: null, loading: false };
  let lyrPanel = null;
  let lyrActive = -1;
  let userScrollUntil = 0;

  const parseLrc = (lrc) => {
    const out = [];
    for (const raw of String(lrc || '').split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const textPart = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: textPart });
    }
    return out.sort((x, y) => x.t - y.t);
  };

  function ensurePanel() {
    if (lyrPanel) return lyrPanel;
    lyrPanel = document.createElement('div');
    lyrPanel.id = 'echoes-lyrics';
    lyrPanel.addEventListener('wheel', () => { userScrollUntil = Date.now() + 3500; }, { passive: true });
    lyrPanel.addEventListener('click', (e) => {
      const line = e.target.closest('.el-line');
      const p = player();
      if (!line || !lyr.lines) return;
      const l = lyr.lines[Number(line.dataset.i)];
      if (!l) return;
      if (p && p.seekTo) p.seekTo(l.t + 0.01, true);
      else if (video()) video().currentTime = l.t + 0.01;
      userScrollUntil = 0;
    });
    document.body.appendChild(lyrPanel);
    return lyrPanel;
  }

  function renderLines() {
    const panel = ensurePanel();
    panel.textContent = '';
    const frag = document.createDocumentFragment();
    const pad = () => { const d = document.createElement('div'); d.className = 'el-pad'; return d; };
    frag.appendChild(pad());
    lyr.lines.forEach((l, i) => {
      const d = document.createElement('div');
      d.className = 'el-line' + (l.text ? '' : ' el-gap');
      d.dataset.i = i;
      d.textContent = l.text || '♪';
      frag.appendChild(d);
    });
    frag.appendChild(pad());
    panel.appendChild(frag);
    lyrActive = -1;
  }

  function loadLyrics(meta, duration) {
    const key = `${meta.title}\u0000${meta.artist}`;
    if (key === lyr.key || !meta.title || !api.lyrics) return;
    lyr = { key, lines: null, loading: true };
    api.lyrics({ title: meta.title, artist: meta.artist, album: meta.album, duration }).then((res) => {
      if (lyr.key !== key) return;
      const lines = res && res.synced ? parseLrc(res.synced) : [];
      lyr = { key, lines: lines.length ? lines : null, duration: (res && res.duration) || 0, loading: false };
      if (lyr.lines) renderLines();
    }).catch(() => { if (lyr.key === key) lyr.loading = false; });
  }

  function lyricsTick() {
    const layout = $('ytmusic-app-layout');
    const open = !!layout && layout.getAttribute('player-ui-state') === 'PLAYER_PAGE_OPEN';
    root.classList.toggle('echoes-player-open', open);

    const v = video();
    const meta = metadata();
    if (meta.title) loadLyrics(meta, trackTime().duration);

    const lyricsTab = [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab')]
      .find((t) => /lyric/i.test(t.textContent || ''));
    const tabSelected = !!lyricsTab && lyricsTab.getAttribute('aria-selected') === 'true';
    const host = $('ytmusic-player-page #tab-renderer');
    // Timed lyrics fit the version they were timed against. A music video ("Video" mode) is
    // usually a different length with an intro, so the lines would land early or late; in that
    // case leave YT Music's own (unsynced) lyrics showing instead.
    const playingDur = trackTime().duration;
    const sameVersion = !lyr.duration || !playingDur || Math.abs(lyr.duration - playingDur) <= 3;
    const show = open && tabSelected && !!lyr.lines && !!host && sameVersion;
    root.classList.toggle('echoes-synced-lyrics', show);
    if (!show) { if (lyrPanel) lyrPanel.style.display = 'none'; return; }

    const panel = ensurePanel();
    const r = host.getBoundingClientRect();
    panel.style.display = 'block';
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.width = `${r.width}px`;
    panel.style.height = `${r.height}px`;

    if (adShowing()) return; // the clock belongs to the ad; hold the lyrics where they are
    const t = trackTime().time + 0.15;
    let idx = -1;
    for (let i = 0; i < lyr.lines.length && lyr.lines[i].t <= t; i++) idx = i;
    if (idx !== lyrActive) {
      const nodes = panel.querySelectorAll('.el-line');
      if (nodes[lyrActive]) nodes[lyrActive].classList.remove('el-active');
      nodes.forEach((n, i) => n.classList.toggle('el-past', i < idx));
      lyrActive = idx;
      const cur = nodes[idx];
      if (cur) {
        cur.classList.add('el-active');
        if (Date.now() > userScrollUntil) {
          panel.scrollTo({ top: cur.offsetTop - panel.clientHeight / 2 + cur.offsetHeight / 2, behavior: 'smooth' });
        }
      }
    }
  }
  every(200, 1000, lyricsTick);

  /* ---------- Playlist art in the sidebar ---------- */
  // YT Music's guide data has no thumbnails, so look them up from the library playlists page
  // through the app's own (authenticated) network manager and add them to the guide entries.
  const thumbs = new Map(); // browseId -> url
  let thumbsFetchedAt = 0;
  let thumbsLoading = null;

  async function loadThumbs() {
    if (thumbsLoading) return thumbsLoading;
    if (Date.now() - thumbsFetchedAt < 60_000) return null;
    const app = $('ytmusic-app');
    const nm = app && (app.networkManager || app.networkManager_);
    if (!nm || typeof nm.fetch !== 'function') return null;
    thumbsLoading = (async () => {
      try {
        const res = await nm.fetch('/browse', { browseId: 'FEmusic_liked_playlists' });
        // The response object shares sub-objects (and may link back to app state), so a naive
        // recursive walk explodes and hangs the page. Visit each object once, iteratively, capped.
        const seen = new WeakSet();
        const stack = [[res, 0]];
        let budget = 200_000;
        while (stack.length && budget-- > 0) {
          const [o, depth] = stack.pop();
          if (!o || typeof o !== 'object' || seen.has(o) || depth > 40) continue;
          seen.add(o);
          const r = o.musicTwoRowItemRenderer;
          if (r) {
            const id = r.navigationEndpoint?.browseEndpoint?.browseId;
            const list = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
            if (id && list && list.length) thumbs.set(id, list[0].url);
            continue;
          }
          if (o instanceof Node || o === window) continue;
          for (const k in o) {
            if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
            const v = o[k];
            if (v && typeof v === 'object') stack.push([v, depth + 1]);
          }
        }
      } catch { /* signed out or API changed: leave the guide as is */ }
      thumbsFetchedAt = Date.now();
      thumbsLoading = null;
    })();
    return thumbsLoading;
  }

  function decorateGuide() {
    let missing = false;
    for (const entry of document.querySelectorAll('ytmusic-guide-entry-renderer')) {
      const data = entry.data || (entry.__data && entry.__data.data);
      const id = data?.navigationEndpoint?.browseEndpoint?.browseId;
      const pageType = data?.navigationEndpoint?.browseEndpoint
        ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      if (!id || !/PLAYLIST/.test(pageType || '')) continue;
      const item = $('tp-yt-paper-item', entry);
      if (!item) continue;
      const url = thumbs.get(id);
      if (!url) { missing = true; continue; }
      let img = $(':scope > img.echoes-guide-thumb', item);
      if (!img) {
        img = document.createElement('img');
        img.className = 'echoes-guide-thumb';
        img.alt = '';
        img.loading = 'lazy';
        item.prepend(img);
      }
      if (img.getAttribute('src') !== url) img.src = url;
    }
    if (missing) loadThumbs()?.then(decorateGuide);
  }

  // A cheap periodic check; YT Music mutates the DOM constantly, so a page-wide observer is wasteful.
  if (window.__echoesGuideArt) { setInterval(decorateGuide, 2000); decorateGuide(); }
})();
