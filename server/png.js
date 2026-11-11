// Minimal PNG encoder plus helpers to scale sprites up for viewing.
import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Decode a (non-interlaced) PNG of any standard color type and bit depth into RGBA.
export function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || SIG.some((b, i) => buf[i] !== b)) throw new Error('Not a PNG file.');
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (name === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
  }
  if (!w || !h) throw new Error('PNG has no image header.');
  if (interlace) throw new Error('Interlaced PNGs are not supported; re-save the image without interlacing.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`Unsupported PNG color type ${type}.`);
  const bitsPP = channels * depth;
  const stride = Math.ceil((w * bitsPP) / 8);
  const bpp = Math.max(1, bitsPP >> 3);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[o + i - bpp] : 0;
      const b = y > 0 ? px[o - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[o - stride + i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[o + i] = v & 0xff;
    }
  }
  const max = (1 << depth) - 1;
  const sample = (y, n) => {
    // n-th sample in row y, returned at full bit depth
    if (depth === 8) return px[y * stride + n];
    if (depth === 16) return px.readUInt16BE(y * stride + n * 2);
    const bit = n * depth;
    return (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const s = x * channels;
      let r, g, b, al = 255;
      if (type === 3) {
        const idx = sample(y, s);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range.');
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) al = trns[idx];
      } else if (type === 0 || type === 4) {
        const v = sample(y, s);
        r = g = b = to8(v);
        if (type === 4) al = to8(sample(y, s + 1));
        else if (trns && trns.length >= 2 && v === trns.readUInt16BE(0)) al = 0;
      } else {
        const R = sample(y, s), G = sample(y, s + 1), B = sample(y, s + 2);
        r = to8(R); g = to8(G); b = to8(B);
        if (type === 6) al = to8(sample(y, s + 3));
        else if (trns && trns.length >= 6 && R === trns.readUInt16BE(0) && G === trns.readUInt16BE(2) && B === trns.readUInt16BE(4)) al = 0;
      }
      if (al === 0) r = g = b = 0;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = al;
    }
  return { width: w, height: h, data: out };
}

// Nearest-neighbour upscale, optional background and pixel grid.
export function present(src, w, h, { scale = 1, background = 'transparent', grid = false } = {}) {
  const W = w * scale, H = h * scale;
  const out = new Uint8ClampedArray(W * H * 4);
  let bg = null;
  if (Array.isArray(background)) bg = background;
  for (let Y = 0; Y < H; Y++) {
    const y = (Y / scale) | 0;
    for (let X = 0; X < W; X++) {
      const x = (X / scale) | 0;
      const si = (y * w + x) * 4, di = (Y * W + X) * 4;
      let base = null;
      if (background === 'checker') {
        const v = ((X >> 3) + (Y >> 3)) & 1 ? 0xe4 : 0xf6;
        base = [v, v, v, 255];
      } else if (bg) base = bg;
      const a = src[si + 3] / 255;
      if (base) {
        for (let c = 0; c < 3; c++) out[di + c] = src[si + c] * a + base[c] * (1 - a);
        out[di + 3] = 255;
      } else {
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
      }
      if (grid && scale >= 4 && (X % scale === 0 || Y % scale === 0)) {
        out[di] *= 0.82; out[di + 1] *= 0.82; out[di + 2] *= 0.82;
        if (out[di + 3] < 60) out[di + 3] = 60;
      }
    }
  }
  return { data: out, width: W, height: H };
}
