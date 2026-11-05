'use strict';

// Runs in the YouTube Music page (isolated world). Exposes a narrow channel the main-world
// bridge (src/inject/bridge.js) uses to report player state and receive commands.
const { contextBridge, ipcRenderer } = require('electron');

// Google's sign-in pages are left completely untouched: any change to their scripts or browser
// identity makes Google refuse the sign-in ("This browser or app may not be secure").

let commandHandler = null;
ipcRenderer.on('ytm:cmd', (_e, cmd) => {
  if (commandHandler) {
    try { commandHandler(cmd); } catch { /* ignore */ }
  }
});

contextBridge.exposeInMainWorld('__echoes', {
  state: (s) => ipcRenderer.send('ytm:state', s),
  queue: (q) => ipcRenderer.send('ytm:queue', q),
  frame: (bytes) => ipcRenderer.send('ytm:frame', bytes),
  lyrics: (query) => ipcRenderer.invoke('lyrics:get', query),
  onCommand: (cb) => { commandHandler = cb; },
});
