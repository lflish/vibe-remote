// Reads pixels out of a PNG (as returned by CDP's Page.captureScreenshot or
// Electron's NativeImage.toPNG), for the GUI smoke scripts' checks of what is
// actually painted: the terminal's theme colors, the first frame of a cold
// start. No dependency: 8-bit RGB / RGBA, non-interlaced, which is what both
// sources produce.

import { inflateSync } from 'node:zlib';

/** Decodes `buf` (a PNG file) into { width, height, at(x, y) → [r, g, b, a] }. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || data[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, color type ${color}, interlace ${data[12]})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 0xff;
    }
  }
  const at = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * channels;
    return [px[i], px[i + 1], px[i + 2], channels === 4 ? px[i + 3] : 255];
  };
  return { width, height, at };
}

/** '#RRGGBB' → [r, g, b]. */
export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #RRGGBB color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbHex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** Largest per-channel difference between two colors. */
export const colorDistance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * Counts the pixels of `img` inside the rectangle (in image pixels) that are
 * within `tolerance` of `rgb`, sampling every `step` pixels. Returns
 * { match, total }.
 */
export function countColor(img, rect, rgb, tolerance = 6, step = 1) {
  let match = 0;
  let total = 0;
  const x1 = Math.min(img.width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.floor(rect.y + rect.height));
  for (let y = Math.max(0, Math.ceil(rect.y)); y < y1; y += step) {
    for (let x = Math.max(0, Math.ceil(rect.x)); x < x1; x += step) {
      total++;
      if (colorDistance(img.at(x, y), rgb) <= tolerance) match++;
    }
  }
  return { match, total };
}

/** The colors of the rectangle, most frequent first: [{ hex, share }]. */
export function dominantColors(img, rect, step = 2, top = 4) {
  const counts = new Map();
  let total = 0;
  const x1 = Math.min(img.width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.floor(rect.y + rect.height));
  for (let y = Math.max(0, Math.ceil(rect.y)); y < y1; y += step) {
    for (let x = Math.max(0, Math.ceil(rect.x)); x < x1; x += step) {
      const hex = rgbHex(img.at(x, y));
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      total++;
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([hex, n]) => ({ hex, share: Math.round((n / total) * 1000) / 1000 }));
}
