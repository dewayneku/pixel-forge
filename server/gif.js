// Animated GIF encoder (GIF89a): one shared color table, per-frame delays,
// 1-bit transparency, loops forever by default.
import { buildPalette, mapToPalette } from '../web/imagetools.js';

// LZW compression as the GIF spec wants it (variable code size, up to 12 bits).
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let dict = new Map();
  const out = [];
  let buf = 0, nbits = 0;
  const emit = (code) => {
    buf |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) { out.push(buf & 0xff); buf >>>= 8; nbits -= 8; }
  };
  emit(clear);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = cur * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (nbits > 0) out.push(buf & 0xff);
  return out;
}

/**
 * frames: [{ data: RGBA Uint8ClampedArray (w*h*4), delay: ms }]
 * Pixels with alpha < 128 become transparent. If the frames use more than 255
 * colors they are reduced to 255 first (GIF's limit, one slot is transparency).
 */
export function encodeGif(frames, w, h, { loop = 0 } = {}) {
  if (!frames.length) throw new Error('No frames to encode.');
  // Collect colors; index 0 is reserved for transparent.
  let datas = frames.map((f) => f.data);
  const colors = new Map();
  let tooMany = false;
  for (const d of datas) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (!colors.has(key)) colors.set(key, colors.size + 1);
      if (colors.size > 255) { tooMany = true; break; }
    }
    if (tooMany) break;
  }
  let reduced = false;
  if (tooMany) {
    const pal = buildPalette(datas, 255);
    datas = datas.map((d) => mapToPalette({ width: w, height: h, data: d }, pal, { despeckle: false }).image.data);
    colors.clear();
    for (const c of pal) colors.set((c[0] << 16) | (c[1] << 8) | c[2], colors.size + 1);
    reduced = true;
  }
  const count = colors.size + 1;
  let bits = 1;
  while (1 << bits < count) bits++;
  const tableSize = 1 << bits;
  const minCode = Math.max(2, bits);

  const bytes = [];
  const u16 = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const str = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };

  str('GIF89a');
  u16(w); u16(h);
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  const table = new Array(tableSize * 3).fill(0);
  for (const [key, idx] of colors) {
    table[idx * 3] = key >> 16; table[idx * 3 + 1] = (key >> 8) & 0xff; table[idx * 3 + 2] = key & 0xff;
  }
  bytes.push(...table);
  // Loop forever (or `loop` times).
  bytes.push(0x21, 0xff, 0x0b); str('NETSCAPE2.0'); bytes.push(0x03, 0x01); u16(loop); bytes.push(0x00);

  datas.forEach((d, fi) => {
    // Delay is in hundredths of a second; browsers treat 0-1 as "slow", so keep >= 2.
    const cs = Math.max(2, Math.round((frames[fi].delay || 100) / 10));
    // Graphic control: dispose to background (clears the frame), index 0 transparent.
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | 1); u16(cs); bytes.push(0, 0);
    bytes.push(0x2c); u16(0); u16(0); u16(w); u16(h); bytes.push(0);
    const idx = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < idx.length; p++, i += 4) {
      idx[p] = d[i + 3] < 128 ? 0 : colors.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    const data = lzw(idx, minCode);
    bytes.push(minCode);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n);
      for (let j = 0; j < n; j++) bytes.push(data[i + j]);
    }
    bytes.push(0);
  });
  bytes.push(0x3b);
  return { buffer: Buffer.from(bytes), colors: colors.size, reduced };
}
