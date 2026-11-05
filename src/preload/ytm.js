'use strict';

// Runs in the YouTube Music page (isolated world). Exposes a narrow channel the main-world
// bridge (src/inject/bridge.js) uses to report player state and receive commands.
const { contextBridge, ipcRenderer } = require('electron');

// Google sign-in: present as Firefox to match the request headers (see main.js), and hide
// passkeys (WebAuthn): Electron has no working passkey UI, so Google's passkey attempt fails.
if (/(^|\.)accounts\.google\./.test(location.hostname) || location.hostname === 'accounts.youtube.com') {
  try {
    const accountsUA = ipcRenderer.sendSync('ytm:accounts-ua');
    contextBridge.executeInMainWorld({
      args: [accountsUA],
      func: (ua) => {
        if (ua) {
          const nav = Navigator.prototype;
          Object.defineProperty(nav, 'userAgent', { get: () => ua, configurable: true });
          Object.defineProperty(nav, 'appVersion', { get: () => ua.replace(/^Mozilla\//, ''), configurable: true });
          Object.defineProperty(nav, 'vendor', { get: () => '', configurable: true });
          try { delete nav.userAgentData; } catch { /* ignore */ }
        }
        try { delete window.PublicKeyCredential; } catch { /* ignore */ }
        try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch { /* ignore */ }
        const creds = navigator.credentials;
        if (!creds) return;
        const reject = () => Promise.reject(new DOMException('Passkeys are not supported here.', 'NotSupportedError'));
        for (const m of ['get', 'create']) {
          const orig = creds[m] && creds[m].bind(creds);
          if (!orig) continue;
          Object.defineProperty(creds, m, {
            configurable: true,
            value: (opts) => (opts && opts.publicKey ? reject() : orig(opts)),
          });
        }
      },
    });
  } catch { /* ignore */ }
}

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
