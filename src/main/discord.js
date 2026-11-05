'use strict';

// Discord Rich Presence: shows "Listening to YouTube Music" with the current song.
//
// Uses a public Discord Application ID (Rich Presence needs nothing else). Override it with
// the ECHOES_DISCORD_CLIENT_ID environment variable to use your own application.
const DISCORD_CLIENT_ID = process.env.ECHOES_DISCORD_CLIENT_ID || '1094259991013228704';

const { Client } = require('@xhayper/discord-rpc');

const DEV = process.argv.includes('--dev');
const LISTENING = 2; // ActivityType.Listening
const RETRY_MS = 15_000;
const MIN_UPDATE_MS = 4_000; // Discord allows ~5 activity updates per 20 s

// Discord requires 2–128 characters for text fields.
const fit = (s, fallback = '') => {
  let t = String(s || fallback).trim();
  if (t.length > 128) t = `${t.slice(0, 127)}…`;
  if (t.length === 1) t = `${t} `;
  return t;
};

class DiscordPresence {
  constructor({ homepage }) {
    this.homepage = homepage;
    this.enabled = false;
    this.client = null;
    this.ready = false;
    this.retryTimer = null;
    this.lastKey = '';
    this.lastSentAt = 0;
    this.pending = null;
    this.pendingTimer = null;
    this.state = null;
  }

  get configured() { return !!DISCORD_CLIENT_ID; }

  setEnabled(on) {
    on = !!on && this.configured;
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.connect();
    else this.disconnect();
  }

  connect() {
    if (!this.enabled || this.client) return;
    const client = new Client({ clientId: DISCORD_CLIENT_ID });
    this.client = client;
    client.on('ready', () => {
      this.ready = true;
      this.lastKey = '';
      if (this.state) this.update(this.state);
    });
    client.on('disconnected', () => this.reset(true));
    client.login().catch(() => this.reset(true)); // Discord not running: try again later
  }

  reset(retry) {
    const c = this.client;
    this.client = null;
    this.ready = false;
    if (c) c.destroy().catch(() => {});
    clearTimeout(this.retryTimer);
    if (retry && this.enabled) this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.pendingTimer);
    const c = this.client;
    if (c && this.ready && c.user) c.user.clearActivity().catch(() => {});
    this.reset(false);
  }

  update(state) {
    this.state = state;
    if (!this.enabled || !this.ready || !this.client || !this.client.user) return;

    const show = state && state.hasTrack && state.playing && !state.ad && state.title;
    const startMs = show ? Math.round(Date.now() - (state.time || 0) * 1000) : 0;
    // Skip updates unless the song, play state, or position (beyond a few seconds) changed.
    const key = show ? `${state.videoId}|${state.title}|${Math.round(startMs / 5000)}` : 'clear';
    if (key === this.lastKey) return;

    const activity = show ? this.activityFor(state, startMs) : null;
    const wait = MIN_UPDATE_MS - (Date.now() - this.lastSentAt);
    this.pending = { key, activity };
    if (wait > 0) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flush(), wait);
      return;
    }
    this.flush();
  }

  flush() {
    const p = this.pending;
    this.pending = null;
    if (!p || !this.ready || !this.client || !this.client.user) return;
    this.lastKey = p.key;
    this.lastSentAt = Date.now();
    const user = this.client.user;
    (p.activity ? user.setActivity(p.activity) : user.clearActivity())
      .then((res) => { if (DEV) console.log('[discord]', p.activity ? `set "${p.activity.details}" ->` : 'cleared', res ? JSON.stringify({ name: res.name, type: res.type, buttons: res.buttons }) : ''); })
      .catch((err) => { this.lastKey = ''; if (DEV) console.log('[discord] error', err && err.message); });
  }

  activityFor(s, startMs) {
    const buttons = [];
    if (s.videoId) {
      buttons.push({ label: 'Play on YouTube Music', url: `https://music.youtube.com/watch?v=${encodeURIComponent(s.videoId)}` });
    }
    if (/^https:\/\//.test(this.homepage || '')) buttons.push({ label: 'Echoes', url: this.homepage });
    const art = /^https:\/\//.test(s.artMedium || s.art || '') ? (s.artMedium || s.art) : undefined;
    return {
      type: LISTENING,
      name: 'YouTube Music',
      statusDisplayType: 2, // member list shows the song title instead of the app name
      details: fit(s.title, 'Unknown song'),
      state: fit(s.artist, 'Unknown artist'),
      largeImageKey: art && art.length <= 256 ? art : undefined,
      largeImageText: s.album ? fit(s.album) : undefined,
      startTimestamp: startMs,
      endTimestamp: s.duration > 0 ? startMs + Math.round(s.duration * 1000) : undefined,
      buttons: buttons.length ? buttons : undefined,
    };
  }
}

module.exports = { DiscordPresence };
