// Renders the app/tray/taskbar icons from SVG to PNG using Electron's offscreen renderer.
// Usage: npm run icons
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff8a7a"/>
      <stop offset=".45" stop-color="#ff3d6e"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
    <radialGradient id="shine" cx=".3" cy=".2" r=".8">
      <stop offset="0" stop-color="#fff" stop-opacity=".35"/>
      <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="220" fill="url(#shine)"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="18"/>
  <circle cx="512" cy="512" r="380" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="14"/>
  <g stroke="#fff" stroke-linecap="round" stroke-width="64">
    <path d="M332 452v120" opacity=".8"/>
    <path d="M452 352v320"/>
    <path d="M572 402v220"/>
    <path d="M692 467v90" opacity=".8"/>
  </g>
</svg>`;

const trayIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a8a"/><stop offset=".5" stop-color="#ff3d6e"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
  <circle cx="16" cy="16" r="15" fill="url(#g)"/>
  <g stroke="#fff" stroke-linecap="round" stroke-width="2.6"><path d="M10 13.5v5"/><path d="M14 9.5v13"/><path d="M18 11.5v9"/><path d="M22 14v4"/></g>
</svg>`;

const trayTemplate = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g stroke="#000" stroke-linecap="round" stroke-width="3.2"><path d="M7 13v6"/><path d="M13 7v18"/><path d="M19 10v12"/><path d="M25 13.5v5"/></g>
</svg>`;

const glyph = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff">${body}</svg>`;
const thumbs = {
  play: glyph('<path d="M7.5 5.27v13.46a1.1 1.1 0 0 0 1.68.93l10.6-6.73a1.1 1.1 0 0 0 0-1.86L9.18 4.34a1.1 1.1 0 0 0-1.68.93z"/>'),
  pause: glyph('<rect x="6" y="4.5" width="4.2" height="15" rx="1.3"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.3"/>'),
  next: glyph('<path d="M5 6.1v11.8a1 1 0 0 0 1.55.83l8.6-5.9a1 1 0 0 0 0-1.66l-8.6-5.9A1 1 0 0 0 5 6.1z"/><rect x="16.6" y="5" width="2.6" height="14" rx="1.3"/>'),
  prev: glyph('<path d="M19 6.1v11.8a1 1 0 0 1-1.55.83l-8.6-5.9a1 1 0 0 1 0-1.66l8.6-5.9A1 1 0 0 1 19 6.1z"/><rect x="4.8" y="5" width="2.6" height="14" rx="1.3"/>'),
};

function render(svg, size) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: size, height: size, show: false, frame: false, transparent: true,
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
    win.webContents.setFrameRate(10);
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:${size}px;height:${size}px;display:block"></body></html>`;
    let done = false;
    win.webContents.on('paint', (_e, _dirty, image) => {
      if (done || !win.__ready || image.isEmpty()) return;
      done = true;
      const png = image.resize({ width: size, height: size }).toPNG();
      win.destroy();
      resolve(png);
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => { win.__ready = true; win.webContents.invalidate(); }, 300);
    });
    win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`).catch(reject);
  });
}

app.on('window-all-closed', () => { /* keep running between renders */ });

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(OUT, 'thumb'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), appIcon.trim());
  fs.writeFileSync(path.join(OUT, 'icon.png'), await render(appIcon, 1024));
  fs.writeFileSync(path.join(OUT, 'tray.png'), await render(trayIcon, 32));
  fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), await render(trayTemplate, 22));
  fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), await render(trayTemplate, 44));
  for (const [name, svg] of Object.entries(thumbs)) {
    fs.writeFileSync(path.join(OUT, 'thumb', `${name}.png`), await render(svg, 32));
  }
  console.log('Icons written to', OUT);
  app.quit();
});
