// The sprite document: canvas size, layers, frames, palette and pixel data ("cels").
// A cel is the pixels of one layer on one frame, stored as RGBA bytes.

let counter = 0;
export const uid = (prefix) =>
  prefix + Date.now().toString(36).slice(-4) + (counter++).toString(36) + Math.random().toString(36).slice(2, 5);

export const MAX_SIZE = 1024;

export const DEFAULT_PALETTE = [
  '#000000', '#ffffff', '#3b3b4f', '#7a7a8c', '#c4c4d4', '#8b2e2e', '#d94e4e', '#f2a65a',
  '#f7e26b', '#4e9a4e', '#a3d977', '#2e5b8b', '#5aa9e6', '#7d4e9a', '#e07bb8', '#8b5a3c',
];

export function parseColor(c) {
  if (c == null) return [0, 0, 0, 0];
  if (Array.isArray(c)) return normalize([c[0] | 0, c[1] | 0, c[2] | 0, c[3] == null ? 255 : c[3] | 0]);
  let s = String(c).trim().toLowerCase();
  if (s === '' || s === 'transparent' || s === 'none' || s === 'clear' || s === 'erase') return [0, 0, 0, 0];
  if (s[0] === '#') s = s.slice(1);
  if (!/^[0-9a-f]+$/.test(s)) throw new Error(`Invalid color "${c}". Use #rgb, #rrggbb, #rrggbbaa or "transparent".`);
  if (s.length === 3 || s.length === 4) s = [...s].map((ch) => ch + ch).join('');
  if (s.length === 6) s += 'ff';
  if (s.length !== 8) throw new Error(`Invalid color "${c}". Use #rgb, #rrggbb, #rrggbbaa or "transparent".`);
  return normalize([0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16)));
}

// Fully transparent pixels are always stored as 0,0,0,0 so comparisons are exact.
const normalize = (c) => (c[3] === 0 ? [0, 0, 0, 0] : c.map((v) => Math.max(0, Math.min(255, v))));

const h2 = (n) => n.toString(16).padStart(2, '0');
export function toHex(c) {
  if (c[3] === 0) return 'transparent';
  return '#' + h2(c[0]) + h2(c[1]) + h2(c[2]) + (c[3] === 255 ? '' : h2(c[3]));
}

export const toB64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
function fromB64(s, len) {
  const buf = Buffer.from(s, 'base64');
  if (buf.length !== len) throw new Error('Cel data has the wrong size for this canvas.');
  return new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

export function checkSize(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIZE || h > MAX_SIZE) {
    throw new Error(`Canvas size must be whole numbers between 1 and ${MAX_SIZE}.`);
  }
}

function isEmpty(cel) {
  for (let i = 3; i < cel.length; i += 4) if (cel[i] !== 0) return false;
  return true;
}

export class SpriteDoc {
  constructor(w = 32, h = 32) {
    this.reset(w, h);
  }

  reset(w, h) {
    checkSize(w, h);
    this.width = w;
    this.height = h;
    this.layers = [{ id: uid('L'), name: 'Layer 1', visible: true, opacity: 1 }];
    this.frames = [{ id: uid('F'), duration: 100 }];
    this.palette = [...DEFAULT_PALETTE];
    this.cels = new Map();
  }

  get celSize() {
    return this.width * this.height * 4;
  }

  key(layerId, frameId) {
    return layerId + ':' + frameId;
  }

  cel(layerId, frameId, create = true) {
    const k = this.key(layerId, frameId);
    let c = this.cels.get(k);
    if (!c && create) {
      c = new Uint8ClampedArray(this.celSize);
      this.cels.set(k, c);
    }
    return c;
  }

  layerIndex(id) {
    return this.layers.findIndex((l) => l.id === id);
  }

  frameIndex(id) {
    return this.frames.findIndex((f) => f.id === id);
  }

  // Layers are referred to by name, id, or number (1 = bottom layer).
  resolveLayer(ref, fallbackId) {
    if (ref === undefined || ref === null || ref === '') {
      return this.layers.find((l) => l.id === fallbackId) || this.layers[this.layers.length - 1];
    }
    if (typeof ref === 'number' || /^-?\d+$/.test(String(ref))) {
      const n = Number(ref);
      const l = this.layers[n - 1];
      if (!l) throw new Error(`No layer number ${n}. There are ${this.layers.length} layers (1 = bottom).`);
      return l;
    }
    const s = String(ref);
    const l = this.layers.find((x) => x.id === s) || this.layers.find((x) => x.name.toLowerCase() === s.toLowerCase());
    if (!l) throw new Error(`No layer "${s}". Layers (bottom to top): ${this.layers.map((x) => x.name).join(', ')}`);
    return l;
  }

  // Frames are referred to by number (1 = first, as shown in the timeline) or id.
  resolveFrame(ref, fallbackId) {
    if (ref === undefined || ref === null || ref === '') {
      return this.frames.find((f) => f.id === fallbackId) || this.frames[0];
    }
    if (typeof ref === 'number' || /^-?\d+$/.test(String(ref))) {
      const n = Number(ref);
      const f = this.frames[n - 1];
      if (!f) throw new Error(`No frame ${n}. There are ${this.frames.length} frames (numbered from 1).`);
      return f;
    }
    const f = this.frames.find((x) => x.id === String(ref));
    if (!f) throw new Error(`No frame with id "${ref}".`);
    return f;
  }

  meta() {
    return {
      width: this.width,
      height: this.height,
      layers: this.layers.map((l) => ({ ...l })),
      frames: this.frames.map((f) => ({ ...f })),
      palette: [...this.palette],
    };
  }

  serialize() {
    const cels = {};
    for (const [k, v] of this.cels) if (!isEmpty(v)) cels[k] = toB64(v);
    return { format: 'pixel-forge', version: 1, ...this.meta(), cels };
  }

  load(data) {
    if (!data || typeof data !== 'object') throw new Error('Not a project file.');
    checkSize(data.width, data.height);
    if (!Array.isArray(data.layers) || !data.layers.length) throw new Error('Project has no layers.');
    if (!Array.isArray(data.frames) || !data.frames.length) throw new Error('Project has no frames.');
    const width = data.width, height = data.height;
    const layers = data.layers.map((l, i) => ({
      id: String(l.id || uid('L')),
      name: String(l.name || `Layer ${i + 1}`),
      visible: l.visible !== false,
      opacity: typeof l.opacity === 'number' ? Math.max(0, Math.min(1, l.opacity)) : 1,
    }));
    const frames = data.frames.map((f) => ({
      id: String(f.id || uid('F')),
      duration: Math.max(10, Math.round(Number(f.duration) || 100)),
    }));
    const cels = new Map();
    for (const [k, v] of Object.entries(data.cels || {})) {
      const [l, f] = k.split(':');
      if (layers.some((x) => x.id === l) && frames.some((x) => x.id === f)) cels.set(k, fromB64(v, width * height * 4));
    }
    Object.assign(this, { width, height, layers, frames, cels });
    this.palette = Array.isArray(data.palette) ? data.palette.map(String) : [...DEFAULT_PALETTE];
  }

  snapshot() {
    return { meta: this.meta(), cels: new Map([...this.cels].map(([k, v]) => [k, v.slice()])) };
  }

  restore(s) {
    Object.assign(this, s.meta);
    this.cels = s.cels;
  }

  // Blend visible layers (or the given layers, visible or not) into one RGBA image.
  composite(frameId, layerIds = null) {
    const out = new Uint8ClampedArray(this.celSize);
    for (const layer of this.layers) {
      if (layerIds ? !layerIds.includes(layer.id) : !layer.visible) continue;
      const src = this.cels.get(this.key(layer.id, frameId));
      if (src) blendInto(out, src, layer.opacity ?? 1);
    }
    return out;
  }
}

export function blendInto(out, src, opacity) {
  for (let i = 0; i < src.length; i += 4) {
    const sa = (src[i + 3] / 255) * opacity;
    if (sa <= 0) continue;
    const da = out[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) out[i + c] = (src[i + c] * sa + out[i + c] * da * (1 - sa)) / oa;
    out[i + 3] = oa * 255;
  }
}
