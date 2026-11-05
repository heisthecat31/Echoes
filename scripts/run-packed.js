'use strict';

// Launches the unpacked build from `electron-builder --dir`, so the process is Echoes.exe
// (named "Echoes" in Task Manager) instead of the generic electron.exe that `npm start` uses.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const dist = path.join(__dirname, '..', 'dist');
const candidates = {
  win32: [path.join(dist, 'win-unpacked', 'Echoes.exe')],
  darwin: [path.join(dist, 'mac', 'Echoes.app', 'Contents', 'MacOS', 'Echoes'),
    path.join(dist, 'mac-arm64', 'Echoes.app', 'Contents', 'MacOS', 'Echoes')],
  linux: [path.join(dist, 'linux-unpacked', 'echoes')],
}[process.platform] || [];

const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('No unpacked build found. Run `npm run pack` first.');
  process.exit(1);
}
spawn(exe, process.argv.slice(2), { detached: true, stdio: 'ignore' }).unref();
