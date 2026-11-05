'use strict';

// Album-art accent color extraction. Runs in the main process so CORS never matters.

/** Ask Google's image CDN for a square JPEG at the given size. */
function upscaleArt(url, size) {
  if (!url || typeof url !== 'string') return '';
  if (/(googleusercontent\.com|ggpht\.com)/.test(url)) {
    if (/=w\d+-h\d+[^/]*$/.test(url)) return url.replace(/=w\d+-h\d+[^/]*$/, `=w${size}-h${size}-l90-rj`);
    if (/=s\d+[^/]*$/.test(url)) return url.replace(/=s\d+[^/]*$/, `=s${size}-rj`);
    if (!url.includes('=')) return `${url}=w${size}-h${size}-l90-rj`;
  }
  return url;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255));
}

const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

async function extractAccent(net, nativeImage, url) {
  if (!url) return null;
  const res = await net.fetch(url, { headers: { Accept: 'image/jpeg,image/png;q=0.9' } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  let img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  img = img.resize({ width: 24, height: 24, quality: 'good' });
  const bmp = img.toBitmap(); // BGRA

  const BINS = 18;
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = { r: 0, g: 0, b: 0, n: 0 };

  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
    if (a < 128) continue;
    total.r += r; total.g += g; total.b += b; total.n++;
    const [h, s, l] = rgbToHsl(r, g, b);
    const score = s * s * Math.max(0, 1 - Math.abs(l - 0.55) * 1.7);
    if (score <= 0.02) continue;
    const bin = bins[Math.min(BINS - 1, Math.floor(h * BINS))];
    bin.w += score; bin.r += r * score; bin.g += g * score; bin.b += b * score;
  }

  const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
  let base;
  if (best.w < 0.6) {
    // Mostly monochrome artwork: use a soft, cool neutral.
    base = [205, 205, 220];
  } else {
    base = [best.r / best.w, best.g / best.w, best.b / best.w];
  }

  let [h, s, l] = rgbToHsl(...base);
  if (best.w >= 0.6) s = Math.min(1, Math.max(s, 0.5));
  l = Math.min(0.7, Math.max(0.58, l));
  const accent = hslToRgb(h, s, l);
  const deep = hslToRgb(h, Math.min(s, 0.6), 0.1);
  const avg = total.n ? [total.r / total.n, total.g / total.n, total.b / total.n].map(Math.round) : [20, 20, 28];

  return { accent: css(accent), deep: css(deep), average: css(avg) };
}

module.exports = { extractAccent, upscaleArt };
