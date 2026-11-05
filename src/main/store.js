'use strict';

// Tiny JSON-backed key/value store for window bounds and similar state.
const fs = require('fs');
const path = require('path');

let file = null;
let data = {};
let timer = null;

function load(dir) {
  file = path.join(dir, 'echoes-state.json');
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
}

function get(key, fallback) {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
}

function set(key, value) {
  data[key] = value;
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(timer);
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

module.exports = { load, get, set, flush };
