'use strict';

const {
  app, BrowserWindow, WebContentsView, ipcMain, nativeImage, net,
  Tray, Menu, shell, screen, nativeTheme,
} = require('electron');

// Dark everywhere by default: pages pick their own dark theme via prefers-color-scheme
// (Google sign-in, consent, etc.) instead of Echoes overriding their styles.
nativeTheme.themeSource = 'dark';
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { DiscordPresence } = require('./discord');
const { extractAccent, upscaleArt } = require('./color');

const YTM_URL = 'https://music.youtube.com/';
const TITLEBAR_H = 48;
const PLAYERBAR_H = 92;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');

/* ------------------------------------------------------------------ */
/* User agent — Google refuses sign-in from UAs that mention Electron,  */
/* and from embedded Chromium in general. On its sign-in pages Echoes   */
/* presents as Firefox (headers + page), which Google accepts.          */
/* ------------------------------------------------------------------ */
const chromeMajor = process.versions.chrome.split('.')[0];
const UA_PLATFORM = IS_WIN
  ? 'Windows NT 10.0; Win64; x64'
  : IS_MAC ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
const FF_PLATFORM = IS_WIN
  ? 'Windows NT 10.0; Win64; x64'
  : IS_MAC ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64';
const FIREFOX_UA = `Mozilla/5.0 (${FF_PLATFORM}; rv:145.0) Gecko/20100101 Firefox/145.0`;
app.userAgentFallback = CHROME_UA;
// Keep decoding video frames while the YouTube Music view is off-screen (video background).
app.commandLine.appendSwitch('disable-features', 'BackgroundVideoTrackOptimization');

const isGoogleAccounts = (url) => {
  try { return /(^|\.)accounts\.google\./.test(new URL(url).hostname); } catch { return false; }
};
const isAllowedInApp = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return /(^|\.)youtube\.com$/.test(hostname)
      || /(^|\.)google\.[a-z.]+$/.test(hostname)
      || /(^|\.)gstatic\.com$/.test(hostname);
  } catch { return false; }
};
const isMusicUrl = (url) => {
  try { return new URL(url).hostname === 'music.youtube.com'; } catch { return false; }
};

/* ------------------------------------------------------------------ */
if (IS_WIN) app.setAppUserModelId('io.github.echoes.app');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let ytm = null;
let tray = null;
let mode = 'normal'; // normal | nowplaying | mini
let restoreBounds = null;
let restoreMaximized = false;
let lastState = {};
let lastArt = '';
let lastAccent = null;
let quitting = false;

const DEFAULT_ACCENT = { accent: 'rgb(255, 78, 106)', deep: 'rgb(26, 11, 18)' };
const DEFAULT_SETTINGS = {
  videoBackground: true, // use the music video as the app background when available
  softFocus: true, // blur the background
  dynamicAccent: true, // tint UI from album art
  closeToTray: false,
  adBlock: true, // uBlock Origin filter lists via @ghostery/adblocker-electron
  discordPresence: false, // show "Listening to YouTube Music" on Discord
  powerSaving: false, // lowest CPU/GPU/RAM: no video background, lowest video quality, slow timers
};
const settings = () => ({ ...DEFAULT_SETTINGS, ...(store.get('settings') || {}) });
// Power saving overrides the video background without changing the user's own choice.
const videoBgOn = () => { const s = settings(); return s.videoBackground && !s.powerSaving; };

const presence = new DiscordPresence({ homepage: require(path.join(ROOT, 'package.json')).homepage });

const injectCSS = fs.readFileSync(path.join(ROOT, 'src', 'inject', 'theme.css'), 'utf8');
const bridgeJS = fs.readFileSync(path.join(ROOT, 'src', 'inject', 'bridge.js'), 'utf8');

const toShell = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const toYtm = (cmd) => {
  if (ytm && !ytm.webContents.isDestroyed()) ytm.webContents.send('ytm:cmd', cmd);
};

/* ------------------------------------------------------------------ */
function sanitizeBounds(b) {
  const fallback = { width: 1320, height: 860 };
  if (!b || !b.width || !b.height) return fallback;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80
    && b.y < a.y + a.height - 40 && b.y + 40 > a.y);
  return visible ? b : { width: b.width, height: b.height };
}

function layout() {
  if (!win || !ytm) return;
  const [w, h] = win.getContentSize();
  if (mode === 'normal') {
    ytm.setVisible(true);
    ytm.setBounds({ x: 0, y: TITLEBAR_H, width: w, height: Math.max(0, h - TITLEBAR_H - PLAYERBAR_H) });
  } else if (videoBgOn()) {
    // Park the view off-screen instead of hiding it, so Chromium keeps decoding video frames.
    ytm.setVisible(true);
    ytm.setBounds({ x: -20000, y: 0, width: 1280, height: 720 });
  } else {
    ytm.setVisible(false);
  }
}

function updateVideoStream() {
  if (!win || !ytm) return;
  const visible = win.isVisible() && !win.isMinimized();
  const enabled = videoBgOn() && visible;
  const big = mode === 'nowplaying' || mode === 'mini';
  toYtm({ type: 'bg-video', value: { enabled, fps: big ? 24 : 12, width: big ? 640 : 320 } });
}

/* ------------------------------------------------------------------ */
/* Ad blocker. uBlock Origin itself can't run in Electron (no extension */
/* webRequest support), so this uses Ghostery's engine with uBlock      */
/* Origin's filter lists. The compiled engine is cached on disk.        */
/* ------------------------------------------------------------------ */
const ADBLOCK_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
let blocker = null;
let blockerLoading = null;
let blockerSession = null;
function loadBlocker() {
  if (blocker) return Promise.resolve(blocker);
  if (blockerLoading) return blockerLoading;
  const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    if (Date.now() - fs.statSync(cachePath).mtimeMs > ADBLOCK_MAX_AGE) fs.unlinkSync(cachePath);
  } catch { /* no cache yet */ }
  blockerLoading = ElectronBlocker.fromPrebuiltAdsAndTracking(
    (url, init) => net.fetch(url, init),
    { path: cachePath, read: fs.promises.readFile, write: fs.promises.writeFile },
  ).then((b) => { blocker = b; return b; })
    .finally(() => { blockerLoading = null; });
  return blockerLoading;
}
// Google's sign-in refuses browsers whose page scripts or requests look tampered with ("This
// browser or app may not be secure"), and uBlock Origin's privacy lists block some of the
// requests its checks rely on. So the blocker leaves Google account pages completely alone.
const SIGN_IN_HOST = /^https:\/\/(accounts\.google\.[a-z.]+|accounts\.youtube\.com|myaccount\.google\.com|gds\.google\.com)(\/|$)/i;
const isSignInPage = (url) => SIGN_IN_HOST.test(url || '');
function touchesSignIn(details) {
  let page = '';
  try { page = details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : ''; } catch { /* gone */ }
  const frame = details.frame && details.frame.url;
  return isSignInPage(details.url) || isSignInPage(page) || isSignInPage(frame) || isSignInPage(details.referrer);
}

let adBlockOn = false;
let adBlockPreloadId;
function enableAdBlock(ses, b) {
  if (adBlockOn) return;
  adBlockOn = true;
  if (DEV) console.log('[adblock] on');
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => (touchesSignIn(d) ? cb({}) : b.onBeforeRequest(d, cb)));
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => (touchesSignIn(d) ? cb({}) : b.onHeadersReceived(d, cb)));
  adBlockPreloadId = ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => (isSignInPage(url) ? undefined : b.onInjectCosmeticFilters(e, url, msg)));
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => b.onIsMutationObserverEnabled(e));
}
function disableAdBlock(ses) {
  if (!adBlockOn) return;
  adBlockOn = false;
  if (DEV) console.log('[adblock] off');
  ses.webRequest.onBeforeRequest(null);
  ses.webRequest.onHeadersReceived(null);
  if (adBlockPreloadId !== undefined) { ses.unregisterPreloadScript(adBlockPreloadId); adBlockPreloadId = undefined; }
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
  ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
}

// While a Google sign-in page is open the blocker is unhooked entirely (no request filters, no
// injected script): Google refuses sign-in when anything on those pages looks altered.
let signingIn = false;
const adBlockWanted = () => settings().adBlock && !signingIn;

async function syncAdBlock(ses) {
  if (ses) blockerSession = ses;
  if (!blockerSession) return;
  try {
    if (adBlockWanted()) {
      const b = await loadBlocker();
      if (adBlockWanted()) enableAdBlock(blockerSession, b);
    } else {
      disableAdBlock(blockerSession);
    }
  } catch (err) {
    console.error('Ad blocker:', err && err.message ? err.message : err);
  }
}

function sendPower() {
  toYtm({ type: 'power', value: !!settings().powerSaving });
}

function applySettings() {
  const s = settings();
  sendPower();
  syncAdBlock();
  presence.setEnabled(s.discordPresence);
  toShell('settings:changed', s);
  layout();
  updateVideoStream();
  toShell('player:accent', s.dynamicAccent ? (lastAccent || DEFAULT_ACCENT) : DEFAULT_ACCENT);
}

function setMode(next) {
  if (!win || next === mode) return;
  const prev = mode;

  if (next === 'mini') {
    restoreMaximized = win.isMaximized();
    if (restoreMaximized) win.unmaximize();
    restoreBounds = win.getBounds();
    const { workArea: wa } = screen.getDisplayMatching(restoreBounds);
    const saved = store.get('miniBounds');
    win.setMinimumSize(240, 240);
    win.setBounds(saved ? sanitizeBounds(saved) : {
      width: 340, height: 340, x: wa.x + wa.width - 364, y: wa.y + wa.height - 364,
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setAspectRatio(1);
    if (IS_MAC) win.setWindowButtonVisibility(false);
  } else if (prev === 'mini') {
    store.set('miniBounds', win.getBounds());
    win.setAlwaysOnTop(false);
    win.setAspectRatio(0);
    win.setMinimumSize(880, 600);
    if (restoreBounds) win.setBounds(restoreBounds);
    if (restoreMaximized) win.maximize();
    if (IS_MAC) win.setWindowButtonVisibility(true);
  }

  mode = next;
  layout();
  updateVideoStream();
  toShell('view:mode', mode);
  if (mode === 'normal') ytm.webContents.focus(); else win.webContents.focus();
}

/* ------------------------------------------------------------------ */
function updateThumbar() {
  if (!IS_WIN || !win) return;
  const icon = (n) => nativeImage.createFromPath(path.join(ASSETS, 'thumb', `${n}.png`));
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: icon('prev'), click: () => toYtm({ type: 'prev' }) },
    lastState.playing
      ? { tooltip: 'Pause', icon: icon('pause'), click: () => toYtm({ type: 'toggle' }) }
      : { tooltip: 'Play', icon: icon('play'), click: () => toYtm({ type: 'toggle' }) },
    { tooltip: 'Next', icon: icon('next'), click: () => toYtm({ type: 'next' }) },
  ]);
}

function updateTray() {
  if (!tray) return;
  const label = lastState.title ? `${lastState.title} — ${lastState.artist || ''}` : 'Nothing playing';
  tray.setToolTip(lastState.title ? `Echoes · ${label}` : 'Echoes');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: label.length > 60 ? label.slice(0, 57) + '…' : label, enabled: false },
    { type: 'separator' },
    { label: lastState.playing ? 'Pause' : 'Play', click: () => toYtm({ type: 'toggle' }) },
    { label: 'Next', click: () => toYtm({ type: 'next' }) },
    { label: 'Previous', click: () => toYtm({ type: 'prev' }) },
    { type: 'separator' },
    { label: 'Show Echoes', click: showWindow },
    { label: mode === 'mini' ? 'Exit Mini Player' : 'Mini Player', click: () => { showWindow(); setMode(mode === 'mini' ? 'normal' : 'mini'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ */
function handleShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = IS_MAC ? input.meta : input.control;
    const key = input.key.toLowerCase();
    let handled = true;
    if (mod && input.shift && key === 'm') setMode(mode === 'mini' ? 'normal' : 'mini');
    else if (mod && input.shift && key === 'f') setMode(mode === 'nowplaying' ? 'normal' : 'nowplaying');
    else if (mod && key === ',' && mode !== 'mini') setMode(mode === 'settings' ? 'normal' : 'settings');
    else if (input.alt && key === 'arrowleft') ytm.webContents.navigationHistory.goBack();
    else if (input.alt && key === 'arrowright') ytm.webContents.navigationHistory.goForward();
    else if (mod && key === 'r') ytm.webContents.reload();
    else if (mod && key === 'arrowright') toYtm({ type: 'next' });
    else if (mod && key === 'arrowleft') toYtm({ type: 'prev' });
    else if (DEV && mod && input.shift && key === 'i') win.webContents.openDevTools({ mode: 'detach' });
    else if (DEV && mod && input.shift && key === 'j') ytm.webContents.openDevTools({ mode: 'detach' });
    else handled = false;
    if (handled) event.preventDefault();
  });
}

function sendNavState() {
  const h = ytm.webContents.navigationHistory;
  toShell('nav:state', { canBack: h.canGoBack(), canForward: h.canGoForward() });
}

/* ------------------------------------------------------------------ */
function createWindow() {
  const bounds = sanitizeBounds(store.get('bounds'));

  win = new BrowserWindow({
    ...bounds,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: IS_MAC,
    titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#07070a',
    title: 'Echoes',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  ytm = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ytm.js'),
      partition: 'persist:ytm',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  ytm.setBackgroundColor('#00000000');
  win.contentView.addChildView(ytm);
  layout();

  setupYtmSession(ytm.webContents.session);
  setupYtmContents(ytm.webContents);
  handleShortcuts(win.webContents);
  handleShortcuts(ytm.webContents);

  const startUrl = store.get('lastUrl');
  ytm.webContents.loadURL(startUrl && isMusicUrl(startUrl) ? startUrl : YTM_URL);

  win.once('ready-to-show', () => {
    if (store.get('maximized')) win.maximize();
    win.show();
  });
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => {
      layout();
      toShell('window:maximized', win.isMaximized() || win.isFullScreen());
    });
  }
  for (const ev of ['minimize', 'restore', 'hide', 'show']) win.on(ev, updateVideoStream);
  win.on('close', (e) => {
    if (!quitting && settings().closeToTray && tray) {
      e.preventDefault();
      win.hide();
      return;
    }
    if (mode === 'mini') store.set('miniBounds', win.getBounds());
    else {
      store.set('bounds', win.getNormalBounds());
      store.set('maximized', win.isMaximized());
    }
    store.flush();
  });
  win.on('closed', () => { win = null; ytm = null; });

  // Hide in-app links that leave YouTube Music from the shell renderer too.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  updateThumbar();
}

function setupYtmSession(ses) {
  ses.setUserAgent(CHROME_UA);
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'] },
    (details, cb) => {
      const headers = details.requestHeaders;
      headers['User-Agent'] = FIREFOX_UA;
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase().startsWith('sec-ch-ua')) delete headers[k];
      }
      cb({ requestHeaders: headers });
    },
  );
  syncAdBlock(ses);
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'notifications']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
}

function setupYtmContents(wc) {
  // Don't call wc.setUserAgent() here: changing the UA mid-navigation cancels the navigation
  // (Sign in silently did nothing). The Google accounts UA is swapped per request in
  // setupYtmSession, and the preload makes navigator.userAgent match on those pages.
  wc.on('will-navigate', (e, url) => {
    if (!isAllowedInApp(url)) { e.preventDefault(); shell.openExternal(url); return; }
  });
  wc.on('did-start-navigation', (e, legacyUrl, _inPlace, legacyMain) => {
    const url = (e && e.url) || legacyUrl;
    const isMain = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : legacyMain;
    if (!isMain) return;
    const next = isSignInPage(url);
    if (next === signingIn) return;
    signingIn = next;
    syncAdBlock();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isGoogleAccounts(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('dom-ready', () => {
    const url = wc.getURL();
    toShell('ytm:loading', false);
    if (!isMusicUrl(url)) {
      // Not YouTube Music (Google sign-in, consent...): no restyling. The view is normally
      // transparent, so give these pages a dark canvas to draw their own dark theme on.
      ytm.setBackgroundColor('#131314');
      return;
    }
    ytm.setBackgroundColor('#00000000');
    wc.insertCSS(injectCSS);
    wc.executeJavaScript(bridgeJS).then(() => { sendPower(); updateVideoStream(); }).catch(() => {});
  });
  wc.on('did-start-loading', () => toShell('ytm:loading', true));
  wc.on('did-stop-loading', () => toShell('ytm:loading', false));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) toShell('ytm:error', { code, desc, url });
  });
  const onNav = (_e, url) => {
    sendNavState();
    if (isMusicUrl(url) && !/\/watch/.test(url)) store.set('lastUrl', url);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('render-process-gone', () => setTimeout(() => wc.reload(), 800));
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Synced lyrics from LRCLIB (lrclib.net): free, open, no account.     */
/* ------------------------------------------------------------------ */
const lyricsCache = new Map();
const cleanTitle = (t) => String(t || '')
  .replace(/\s*[([](feat\.?|ft\.?|with|prod\.?)[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|radio edit|single version|mono|stereo).*$/i, '')
  .trim();
async function lrclib(pathAndQuery) {
  const res = await net.fetch(`https://lrclib.net${pathAndQuery}`, {
    headers: { 'User-Agent': `Echoes/${app.getVersion()} (desktop YouTube Music client)` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}
async function findLyrics({ title, artist, album, duration }) {
  const track = cleanTitle(title);
  const artistName = String(artist || '').split(/,|&| x | feat\.? /i)[0].trim();
  if (!track || !artistName) return null;
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  const dur = Math.round(Number(duration) || 0);
  let hit = await lrclib(`/api/get?${q({ track_name: track, artist_name: artistName, album_name: album, duration: dur || '' })}`).catch(() => null);
  if (!hit || !hit.syncedLyrics) {
    const list = await lrclib(`/api/search?${q({ track_name: track, artist_name: artistName })}`).catch(() => null);
    if (Array.isArray(list)) {
      hit = list.find((x) => x.syncedLyrics && (!dur || Math.abs((x.duration || 0) - dur) <= 4))
        || list.find((x) => x.syncedLyrics) || hit;
    }
  }
  if (!hit) return null;
  return { synced: hit.syncedLyrics || '', plain: hit.plainLyrics || '', instrumental: !!hit.instrumental, duration: Number(hit.duration) || 0 };
}
ipcMain.handle('lyrics:get', async (e, query) => {
  if (!ytm || e.sender !== ytm.webContents || !query) return null;
  const key = `${query.title}\u0000${query.artist}\u0000${Math.round(query.duration || 0)}`;
  if (!lyricsCache.has(key)) {
    lyricsCache.set(key, findLyrics(query).catch(() => null));
    if (lyricsCache.size > 200) lyricsCache.delete(lyricsCache.keys().next().value);
  }
  return lyricsCache.get(key);
});

// Hand the preload the Firefox UA so Google's sign-in JS sees the same UA as the request headers.
ipcMain.on('ytm:accounts-ua', (e) => { e.returnValue = FIREFOX_UA; });
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

ipcMain.on('nav:back', () => ytm && ytm.webContents.navigationHistory.goBack());
ipcMain.on('nav:forward', () => ytm && ytm.webContents.navigationHistory.goForward());
ipcMain.on('nav:home', () => toYtm({ type: 'home' }));
ipcMain.on('nav:reload', () => ytm && ytm.webContents.reload());

ipcMain.on('view:set', (_e, next) => {
  if (['normal', 'nowplaying', 'mini', 'settings'].includes(next)) setMode(next);
});

ipcMain.handle('settings:get', () => settings());
ipcMain.on('settings:set', (_e, key, value) => {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) || typeof value !== 'boolean') return;
  store.set('settings', { ...settings(), [key]: value });
  applySettings();
});

ipcMain.on('ytm:frame', (e, frame) => {
  if (!ytm || e.sender !== ytm.webContents || !(frame instanceof Uint8Array)) return;
  if (frame.byteLength > 2_000_000) return;
  toShell('player:frame', frame);
});

ipcMain.on('player:cmd', (_e, cmd) => {
  if (cmd && typeof cmd.type === 'string') toYtm(cmd);
});

ipcMain.handle('app:info', () => ({
  platform: process.platform, version: app.getVersion(), mode,
  maximized: win ? win.isMaximized() : false,
}));

ipcMain.on('ytm:state', async (e, state) => {
  if (!ytm || e.sender !== ytm.webContents || !state) return;
  const playingChanged = state.playing !== lastState.playing;
  const trackChanged = state.title !== lastState.title || state.artist !== lastState.artist;
  state.artHi = upscaleArt(state.art, 1200);
  lastState = state;
  presence.update({ ...state, artMedium: upscaleArt(state.art, 512) });
  toShell('player:state', state);

  if (playingChanged) updateThumbar();
  if (playingChanged || trackChanged) updateTray();
  if (trackChanged && win) win.setTitle(state.title ? `${state.title} · ${state.artist}` : 'Echoes');

  if (state.art && state.art !== lastArt) {
    lastArt = state.art;
    const accent = await extractAccent(net, nativeImage, upscaleArt(state.art, 120)).catch(() => null);
    if (accent && lastArt === state.art) {
      lastAccent = accent;
      if (settings().dynamicAccent) toShell('player:accent', accent);
    }
  }
});

ipcMain.on('ytm:queue', (e, queue) => {
  if (!ytm || e.sender !== ytm.webContents) return;
  toShell('player:queue', Array.isArray(queue) ? queue.slice(0, 80) : []);
});

ipcMain.on('shell:ready', () => {
  toShell('settings:changed', settings());
  if (lastState.title) toShell('player:state', lastState);
  toShell('view:mode', mode);
  if (ytm) sendNavState();
});

/* ------------------------------------------------------------------ */
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; presence.setEnabled(false); });

app.whenReady().then(() => {
  store.load(app.getPath('userData'));
  createWindow();
  presence.setEnabled(settings().discordPresence);

  const trayImg = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (!trayImg.isEmpty()) {
    tray = new Tray(trayImg);
    tray.on('click', showWindow);
    updateTray();
  }

  app.on('activate', () => {
    if (!win) createWindow(); else showWindow();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
