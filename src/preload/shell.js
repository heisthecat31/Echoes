'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('echoes', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  ready: () => ipcRenderer.send('shell:ready'),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    onMaximized: on('window:maximized'),
  },
  nav: {
    back: () => ipcRenderer.send('nav:back'),
    forward: () => ipcRenderer.send('nav:forward'),
    home: () => ipcRenderer.send('nav:home'),
    reload: () => ipcRenderer.send('nav:reload'),
    onState: on('nav:state'),
    onLoading: on('ytm:loading'),
    onError: on('ytm:error'),
  },
  player: {
    send: (type, value) => ipcRenderer.send('player:cmd', { type, value }),
    onState: on('player:state'),
    onQueue: on('player:queue'),
    onAccent: on('player:accent'),
    onFrame: on('player:frame'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.send('settings:set', key, value),
    onChange: on('settings:changed'),
  },
  view: {
    set: (mode) => ipcRenderer.send('view:set', mode),
    onMode: on('view:mode'),
  },
});
