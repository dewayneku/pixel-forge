// Every action on the document, used by both the browser editor and the MCP bridge.
// Each method gets (params, ctx). Mutating methods record what changed in ctx.changes
// so the server can broadcast it, and set ctx.summary for the activity feed.
import fs from 'node:fs';
import path from 'node:path';
import { parseColor, toHex, uid, checkSize, DEFAULT_PALETTE } from './doc.js';
import { encodePng, decodePng, present } from './png.js';
import { encodeGif } from './gif.js';
import { shapePoints } from '../web/shapes.js';
import { removeBackground, detectSprites, packBoxes, buildPalette, mapToPalette, countColors } from '../web/imagetools.js';
import jpeg from 'jpeg-js';

export class Changes {
  constructor(doc) {
    this.doc = doc;
    this.px = new Map(); // celKey -> [x, y, r, g, b, a, ...]
    this.full = new Set(); // celKeys replaced wholesale
    this.struct = false; // layers/frames/size/palette changed: send a full snapshot
  }
  paint(l, f, x, y, c) {
    const d = this.doc;
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return false;
    const cel = d.cel(l, f);
    const i = (y * d.width + x) * 4;
    if (cel[i] === c[0] && cel[i + 1] === c[1] && cel[i + 2] === c[2] && cel[i + 3] === c[3]) return false;
    cel[i] = c[0]; cel[i + 1] = c[1]; cel[i + 2] = c[2]; cel[i + 3] = c[3];
    const k = d.key(l, f);
    if (!this.full.has(k)) {
      let a = this.px.get(k);
      if (!a) this.px.set(k, (a = []));
      a.push(x, y, c[0], c[1], c[2], c[3]);
    }
    return true;
  }
  cel(l, f) {
    const k = this.doc.key(l, f);
    this.full.add(k);
    this.px.delete(k);
  }
  structure() {
    this.struct = true;
  }
}

export const methods = {};
export const MUTATING = new Set();
const ro = (name, fn) => (methods[name] = fn);
const mut = (name, fn) => {
  methods[name] = fn;
  MUTATING.add(name);
};

const int = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number.`);
  return Math.round(n);
};

function target(p, ctx) {
  const d = ctx.doc;
  const layer = d.resolveLayer(p.layer, ctx.defaults.layerId);
  const frame = d.resolveFrame(p.frame, ctx.defaults.frameId);
  return { layer, frame, l: layer.id, f: frame.id, label: `"${layer.name}" frame ${d.frameIndex(frame.id) + 1}` };
}

function frameInfo(d) {
  return d.frames.map((f, i) => ({ number: i + 1, id: f.id, duration_ms: f.duration }));
}
function layerInfo(d) {
  return d.layers.map((l, i) => ({ number: i + 1, name: l.name, id: l.id, visible: l.visible, opacity: l.opacity }));
}

// ---------------------------------------------------------------- reading

ro('getDocument', (p, ctx) => {
  const d = ctx.doc;
  const ui = ctx.defaults;
  const f = d.frames.find((x) => x.id === ui.frameId);
  const l = d.layers.find((x) => x.id === ui.layerId);
  return {
    editor_url: ctx.editorUrl,
    width: d.width,
    height: d.height,
    frames: frameInfo(d),
    layers_bottom_to_top: layerInfo(d),
    palette: d.palette,
    user_view: ui.frameId
      ? { frame: f ? d.frameIndex(f.id) + 1 : null, layer: l?.name ?? null, color: ui.color, tool: ui.tool, playing: ui.playing }
      : null,
    editors_open: ctx.clients.filter((c) => c.role === 'browser').length,
    undo_steps: ctx.history.undo.length,
    redo_steps: ctx.history.redo.length,
  };
});

ro('getProject', (p, ctx) => ctx.doc.serialize());

ro('getActivity', (p, ctx) => {
  const since = Number(p.since) || 0;
  const limit = Math.min(200, Number(p.limit) || 30);
  return ctx.activity.filter((e) => e.seq > since).slice(-limit);
});

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!$%&*+=?@^~<>/|';
ro('getPixels', (p, ctx) => {
  const d = ctx.doc;
  const t = target(p, ctx);
  const x0 = Math.max(0, int(p.x ?? 0, 'x')), y0 = Math.max(0, int(p.y ?? 0, 'y'));
  const w = Math.min(d.width - x0, int(p.w ?? d.width, 'w')), h = Math.min(d.height - y0, int(p.h ?? d.height, 'h'));
  if (w <= 0 || h <= 0) throw new Error('Region is outside the canvas.');
  if (w > 128 || h > 128) throw new Error('Region too large to print; read at most 128x128 at a time.');
  const src = p.composite ? d.composite(t.f) : d.cel(t.l, t.f, false) || new Uint8ClampedArray(d.celSize);
  const legend = { '.': 'transparent' };
  const byColor = new Map();
  const rows = [];
  for (let y = y0; y < y0 + h; y++) {
    let row = '';
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * d.width + x) * 4;
      if (src[i + 3] === 0) { row += '.'; continue; }
      const hex = toHex([src[i], src[i + 1], src[i + 2], src[i + 3]]);
      let ch = byColor.get(hex);
      if (!ch) {
        // Out of single characters: mark the rest '?' rather than give them a wrong color.
        ch = CHARS[byColor.size] || '?';
        byColor.set(hex, ch);
        if (ch !== '?') legend[ch] = hex;
      }
      row += ch;
    }
    rows.push(row);
  }
  return {
    source: p.composite ? `frame ${d.frameIndex(t.f) + 1} (all visible layers)` : t.label,
    origin: { x: x0, y: y0 },
    size: { w, h },
    legend,
    rows,
    note: byColor.size > CHARS.length
      ? `This region has ${byColor.size} colors; only ${CHARS.length} fit in the legend and "?" marks the rest. Read a smaller region, or use reduce_colors to clean the colors up first.`
      : undefined,
  };
});

function autoScale(d, target = 384) {
  return Math.max(1, Math.min(32, Math.floor(target / Math.max(d.width, d.height))));
}
function bgParam(b) {
  if (!b || b === 'checker') return 'checker';
  if (b === 'transparent' || b === 'none') return 'transparent';
  return parseColor(b);
}

ro('renderFrame', (p, ctx) => {
  const d = ctx.doc;
  const frame = d.resolveFrame(p.frame, ctx.defaults.frameId);
  let layerIds = null;
  if (p.layer !== undefined && p.layer !== null && p.layer !== '') layerIds = [d.resolveLayer(p.layer).id];
  const scale = p.scale ? Math.max(1, Math.min(64, int(p.scale, 'scale'))) : autoScale(d);
  const img = present(d.composite(frame.id, layerIds), d.width, d.height, {
    scale,
    background: bgParam(p.background),
    grid: !!p.grid,
  });
  return {
    frame: d.frameIndex(frame.id) + 1,
    scale,
    width: img.width,
    height: img.height,
    png: encodePng(img.data, img.width, img.height).toString('base64'),
  };
});

function sheet(d, { columns, scale, background, padding = 0 }) {
  const n = d.frames.length;
  const cols = Math.max(1, Math.min(n, columns ? int(columns, 'columns') : n));
  const rows = Math.ceil(n / cols);
  const fw = d.width, fh = d.height;
  const W = cols * fw + (cols - 1) * padding, H = rows * fh + (rows - 1) * padding;
  const out = new Uint8ClampedArray(W * H * 4);
  const frames = [];
  d.frames.forEach((f, i) => {
    const cx = (i % cols) * (fw + padding), cy = Math.floor(i / cols) * (fh + padding);
    const src = d.composite(f.id);
    for (let y = 0; y < fh; y++) out.set(src.subarray(y * fw * 4, (y + 1) * fw * 4), ((cy + y) * W + cx) * 4);
    frames.push({ frame: i + 1, x: cx * scale, y: cy * scale, w: fw * scale, h: fh * scale, duration: f.duration });
  });
  const img = present(out, W, H, { scale, background });
  return { img, frames, cols, rows };
}

ro('renderSheet', (p, ctx) => {
  const d = ctx.doc;
  const scale = p.scale ? Math.max(1, Math.min(32, int(p.scale, 'scale'))) : 1;
  const s = sheet(d, { columns: p.columns, scale, background: bgParam(p.background ?? 'transparent'), padding: p.padding ? int(p.padding, 'padding') : 0 });
  return {
    width: s.img.width,
    height: s.img.height,
    columns: s.cols,
    rows: s.rows,
    frames: s.frames,
    png: encodePng(s.img.data, s.img.width, s.img.height).toString('base64'),
  };
});

// ---------------------------------------------------------------- drawing

mut('setPixels', (p, ctx) => {
  const t = target(p, ctx);
  let n = 0;
  if (Array.isArray(p.px)) {
    const a = p.px;
    for (let i = 0; i + 5 < a.length; i += 6) {
      const c = a[i + 5] === 0 ? [0, 0, 0, 0] : [a[i + 2], a[i + 3], a[i + 4], a[i + 5]];
      if (ctx.changes.paint(t.l, t.f, a[i] | 0, a[i + 1] | 0, c)) n++;
    }
  }
  if (Array.isArray(p.pixels)) {
    for (const q of p.pixels) if (ctx.changes.paint(t.l, t.f, int(q.x, 'x'), int(q.y, 'y'), parseColor(q.color))) n++;
  }
  // Hand-drawn strokes arrive in many small pieces under one txn; only the first is logged.
  ctx.summary = p.txn ? `drew on ${t.label}` : `drew ${n} px on ${t.label}`;
  return { changed: n };
});

mut('drawGrid', (p, ctx) => {
  const t = target(p, ctx);
  if (!Array.isArray(p.rows)) throw new Error('"rows" must be an array of strings.');
  const legend = {};
  for (const [ch, col] of Object.entries(p.legend || {})) {
    if ([...ch].length !== 1) throw new Error(`Legend keys must be single characters, got "${ch}".`);
    legend[ch] = parseColor(col);
  }
  const ox = int(p.x ?? 0, 'x'), oy = int(p.y ?? 0, 'y');
  let n = 0, skipped = 0;
  p.rows.forEach((row, ry) => {
    [...String(row)].forEach((ch, rx) => {
      const c = legend[ch];
      if (!c) { skipped++; return; }
      if (ctx.changes.paint(t.l, t.f, ox + rx, oy + ry, c)) n++;
    });
  });
  ctx.summary = `drew a ${Math.max(0, ...p.rows.map((r) => [...String(r)].length))}x${p.rows.length} pixel grid on ${t.label}`;
  return { changed: n, untouched_cells: skipped };
});

mut('drawShape', (p, ctx) => {
  const t = target(p, ctx);
  const c = parseColor(p.color);
  const pts = shapePoints(p.shape, int(p.x0, 'x0'), int(p.y0, 'y0'), int(p.x1, 'x1'), int(p.y1, 'y1'), !!p.filled);
  let n = 0;
  for (const [x, y] of pts) if (ctx.changes.paint(t.l, t.f, x, y, c)) n++;
  ctx.summary = `drew a ${p.filled ? 'filled ' : ''}${p.shape} on ${t.label}`;
  return { changed: n };
});

mut('fill', (p, ctx) => {
  const d = ctx.doc;
  const t = target(p, ctx);
  const c = parseColor(p.color);
  const x = int(p.x, 'x'), y = int(p.y, 'y');
  if (x < 0 || y < 0 || x >= d.width || y >= d.height) throw new Error('Fill point is outside the canvas.');
  const cel = d.cel(t.l, t.f);
  const W = d.width, H = d.height;
  const at = (i) => [cel[i], cel[i + 1], cel[i + 2], cel[i + 3]];
  const tc = at((y * W + x) * 4);
  const same = (i) => cel[i] === tc[0] && cel[i + 1] === tc[1] && cel[i + 2] === tc[2] && cel[i + 3] === tc[3];
  let n = 0;
  if (p.contiguous === false) {
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (same((yy * W + xx) * 4) && ctx.changes.paint(t.l, t.f, xx, yy, c)) n++;
  } else {
    const seen = new Uint8Array(W * H);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const j = cy * W + cx;
      if (seen[j] || !same(j * 4)) continue;
      seen[j] = 1;
      if (ctx.changes.paint(t.l, t.f, cx, cy, c)) n++;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }
  ctx.summary = `filled ${n} px on ${t.label}`;
  return { changed: n };
});

mut('editCel', (p, ctx) => {
  const d = ctx.doc;
  const t = target(p, ctx);
  const W = d.width, H = d.height;
  const src = d.cel(t.l, t.f);
  const out = new Uint8ClampedArray(d.celSize);
  const copyPx = (sx, sy, dx, dy) => {
    const si = (sy * W + sx) * 4, di = (dy * W + dx) * 4;
    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
  };
  switch (p.action) {
    case 'clear':
      break;
    case 'shift': {
      const dx = int(p.dx ?? 0, 'dx'), dy = int(p.dy ?? 0, 'dy');
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let sx = x - dx, sy = y - dy;
          if (p.wrap) { sx = ((sx % W) + W) % W; sy = ((sy % H) + H) % H; }
          if (sx >= 0 && sy >= 0 && sx < W && sy < H) copyPx(sx, sy, x, y);
        }
      break;
    }
    case 'flip_h':
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) copyPx(W - 1 - x, y, x, y);
      break;
    case 'flip_v':
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) copyPx(x, H - 1 - y, x, y);
      break;
    case 'copy_from': {
      const fl = p.from_layer !== undefined ? d.resolveLayer(p.from_layer) : t.layer;
      const ff = p.from_frame !== undefined ? d.resolveFrame(p.from_frame) : t.frame;
      const other = d.cel(fl.id, ff.id, false);
      if (other) out.set(other);
      break;
    }
    case 'replace_color': {
      const from = parseColor(p.from_color), to = parseColor(p.to_color);
      out.set(src);
      for (let i = 0; i < out.length; i += 4)
        if (out[i] === from[0] && out[i + 1] === from[1] && out[i + 2] === from[2] && out[i + 3] === from[3]) out.set(to, i);
      break;
    }
    default:
      throw new Error(`Unknown action "${p.action}". Use clear, shift, flip_h, flip_v, copy_from or replace_color.`);
  }
  src.set(out);
  ctx.changes.cel(t.l, t.f);
  ctx.summary = `${p.action.replace('_', ' ')} on ${t.label}`;
  return { ok: true };
});

// ---------------------------------------------------------------- frames & layers

mut('frames', (p, ctx) => {
  const d = ctx.doc;
  const cur = d.resolveFrame(p.frame === 'all' ? undefined : p.frame, ctx.defaults.frameId);
  const ci = d.frameIndex(cur.id);
  ctx.changes.structure();
  switch (p.action) {
    case 'add':
    case 'duplicate': {
      const count = Math.max(1, Math.min(64, int(p.count ?? 1, 'count')));
      const at = p.to !== undefined ? Math.max(0, Math.min(d.frames.length, int(p.to, 'to') - 1)) : ci + 1;
      const made = [];
      for (let k = 0; k < count; k++) {
        const nf = { id: uid('F'), duration: p.duration ? Math.max(10, int(p.duration, 'duration')) : cur.duration };
        if (p.action === 'duplicate')
          for (const l of d.layers) {
            const c = d.cel(l.id, cur.id, false);
            if (c) d.cels.set(d.key(l.id, nf.id), c.slice());
          }
        d.frames.splice(at + k, 0, nf);
        made.push(nf);
      }
      ctx.summary = `${p.action === 'add' ? 'added' : 'duplicated frame ' + (ci + 1) + ' into'} ${count} frame${count > 1 ? 's' : ''}`;
      return { created: made.map((f) => ({ number: d.frameIndex(f.id) + 1, id: f.id })), frames: frameInfo(d) };
    }
    case 'delete': {
      if (d.frames.length <= 1) throw new Error("Can't delete the only frame.");
      d.frames.splice(ci, 1);
      for (const l of d.layers) d.cels.delete(d.key(l.id, cur.id));
      ctx.summary = `deleted frame ${ci + 1}`;
      return { frames: frameInfo(d) };
    }
    case 'move': {
      const to = Math.max(1, Math.min(d.frames.length, int(p.to, 'to')));
      d.frames.splice(ci, 1);
      d.frames.splice(to - 1, 0, cur);
      ctx.summary = `moved frame ${ci + 1} to ${to}`;
      return { frames: frameInfo(d) };
    }
    case 'set_duration': {
      const ms = Math.max(10, Math.min(60000, int(p.duration, 'duration')));
      const list = p.frame === 'all' ? d.frames : [cur];
      for (const f of list) f.duration = ms;
      ctx.summary = `set ${p.frame === 'all' ? 'all frames' : 'frame ' + (ci + 1)} to ${ms}ms`;
      return { frames: frameInfo(d) };
    }
    default:
      throw new Error(`Unknown action "${p.action}". Use add, duplicate, delete, move or set_duration.`);
  }
});

mut('layers', (p, ctx) => {
  const d = ctx.doc;
  ctx.changes.structure();
  if (p.action === 'add') {
    const nl = { id: uid('L'), name: p.name ? String(p.name) : `Layer ${d.layers.length + 1}`, visible: true, opacity: 1 };
    const cur = d.layers.find((l) => l.id === ctx.defaults.layerId);
    const at = p.to !== undefined ? Math.max(0, Math.min(d.layers.length, int(p.to, 'to') - 1)) : cur ? d.layerIndex(cur.id) + 1 : d.layers.length;
    d.layers.splice(at, 0, nl);
    ctx.summary = `added layer "${nl.name}"`;
    return { created: { number: at + 1, name: nl.name, id: nl.id }, layers_bottom_to_top: layerInfo(d) };
  }
  const L = d.resolveLayer(p.layer, ctx.defaults.layerId);
  const li = d.layerIndex(L.id);
  switch (p.action) {
    case 'duplicate': {
      const nl = { ...L, id: uid('L'), name: p.name ? String(p.name) : `${L.name} copy` };
      for (const f of d.frames) {
        const c = d.cel(L.id, f.id, false);
        if (c) d.cels.set(d.key(nl.id, f.id), c.slice());
      }
      d.layers.splice(li + 1, 0, nl);
      ctx.summary = `duplicated layer "${L.name}"`;
      return { created: { number: li + 2, name: nl.name, id: nl.id }, layers_bottom_to_top: layerInfo(d) };
    }
    case 'delete': {
      if (d.layers.length <= 1) throw new Error("Can't delete the only layer.");
      d.layers.splice(li, 1);
      for (const f of d.frames) d.cels.delete(d.key(L.id, f.id));
      ctx.summary = `deleted layer "${L.name}"`;
      return { layers_bottom_to_top: layerInfo(d) };
    }
    case 'move': {
      const to = Math.max(1, Math.min(d.layers.length, int(p.to, 'to')));
      d.layers.splice(li, 1);
      d.layers.splice(to - 1, 0, L);
      ctx.summary = `moved layer "${L.name}" to position ${to}`;
      return { layers_bottom_to_top: layerInfo(d) };
    }
    case 'update': {
      const bits = [];
      if (p.name !== undefined) { bits.push(`renamed "${L.name}" to "${p.name}"`); L.name = String(p.name); }
      if (p.visible !== undefined) { L.visible = !!p.visible; bits.push(`${L.visible ? 'showed' : 'hid'} "${L.name}"`); }
      if (p.opacity !== undefined) { L.opacity = Math.max(0, Math.min(1, Number(p.opacity))); bits.push(`set "${L.name}" opacity ${Math.round(L.opacity * 100)}%`); }
      ctx.summary = bits.join(', ') || 'updated a layer';
      return { layers_bottom_to_top: layerInfo(d) };
    }
    default:
      throw new Error(`Unknown action "${p.action}". Use add, duplicate, delete, move or update.`);
  }
});

mut('setPalette', (p, ctx) => {
  const d = ctx.doc;
  const colors = (p.colors || []).map((c) => toHex(parseColor(c)));
  if (p.mode === 'append') d.palette.push(...colors.filter((c) => !d.palette.includes(c)));
  else if (p.mode === 'remove') d.palette = d.palette.filter((c) => !colors.includes(c));
  else if (p.mode === 'reset') d.palette = [...DEFAULT_PALETTE];
  else d.palette = colors;
  ctx.changes.structure();
  ctx.summary = `updated the palette (${d.palette.length} colors)`;
  return { palette: d.palette };
});

// ---------------------------------------------------------------- canvas

mut('newDocument', (p, ctx) => {
  const w = int(p.width ?? 32, 'width'), h = int(p.height ?? 32, 'height');
  ctx.doc.reset(w, h);
  ctx.changes.structure();
  ctx.summary = `started a new ${w}x${h} sprite`;
  return { width: w, height: h };
});

const ANCHORS = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};
mut('resize', (p, ctx) => {
  const d = ctx.doc;
  const w = int(p.width, 'width'), h = int(p.height, 'height');
  checkSize(w, h);
  const [ax, ay] = ANCHORS[p.anchor || 'center'] || ANCHORS.center;
  const ox = Math.floor((w - d.width) * ax), oy = Math.floor((h - d.height) * ay);
  for (const [k, src] of d.cels) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < d.height; y++)
      for (let x = 0; x < d.width; x++) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        out.set(src.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4), (ny * w + nx) * 4);
      }
    d.cels.set(k, out);
  }
  d.width = w;
  d.height = h;
  ctx.changes.structure();
  ctx.summary = `resized the canvas to ${w}x${h}`;
  return { width: w, height: h };
});

// ---------------------------------------------------------------- files

function resolvePath(p, ctx, ext) {
  if (!p) throw new Error('A file path is required.');
  let full = path.isAbsolute(p) ? p : path.join(ctx.projectsDir, p);
  if (ext && !path.extname(full)) full += ext;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

ro('saveProject', (p, ctx) => {
  const file = resolvePath(p.path, ctx, '.forge.json');
  fs.writeFileSync(file, JSON.stringify(ctx.doc.serialize()));
  return { saved: file };
});

mut('loadProject', (p, ctx) => {
  const file = resolvePath(p.path, ctx);
  ctx.doc.load(JSON.parse(fs.readFileSync(file, 'utf8')));
  ctx.changes.structure();
  ctx.summary = `opened ${path.basename(file)}`;
  return { loaded: file, width: ctx.doc.width, height: ctx.doc.height, frames: ctx.doc.frames.length, layers: ctx.doc.layers.length };
});

mut('loadProjectData', (p, ctx) => {
  ctx.doc.load(p.data);
  ctx.changes.structure();
  ctx.summary = 'opened a project file';
  return { ok: true };
});

// ---------------------------------------------------------------- import

function sliceImage(img, p) {
  const fw = p.frame_width ? int(p.frame_width, 'frame_width') : img.width;
  const fh = p.frame_height ? int(p.frame_height, 'frame_height') : img.height;
  const margin = p.margin ? int(p.margin, 'margin') : 0;
  const spacing = p.spacing ? int(p.spacing, 'spacing') : 0;
  if (fw < 1 || fh < 1 || fw + margin > img.width || fh + margin > img.height)
    throw new Error(`Frame size ${fw}x${fh} doesn't fit in the ${img.width}x${img.height} image.`);
  const cols = Math.floor((img.width - 2 * margin + spacing) / (fw + spacing)) || 1;
  const rows = Math.floor((img.height - 2 * margin + spacing) / (fh + spacing)) || 1;
  const skipEmpty = p.skip_empty !== false;
  const max = p.count ? int(p.count, 'count') : Infinity;
  const slices = [];
  for (let r = 0; r < rows && slices.length < max; r++)
    for (let c = 0; c < cols && slices.length < max; c++) {
      const sx = margin + c * (fw + spacing), sy = margin + r * (fh + spacing);
      const data = new Uint8ClampedArray(fw * fh * 4);
      let any = false;
      for (let y = 0; y < fh; y++) {
        const row = img.data.subarray(((sy + y) * img.width + sx) * 4, ((sy + y) * img.width + sx + fw) * 4);
        data.set(row, y * fw * 4);
        if (!any) for (let i = 3; i < row.length; i += 4) if (row[i]) { any = true; break; }
      }
      if (any || !skipEmpty) slices.push(data);
    }
  if (!slices.length) throw new Error('The image is fully transparent; nothing to import.');
  return { fw, fh, cols, rows, slices };
}

function blit(src, sw, sh, dst, dw, dh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= dw) continue;
      const si = (y * sw + x) * 4, di = (dy * dw + dx) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
}

function imageColors(slices, limit = 64) {
  const set = new Set();
  for (const s of slices)
    for (let i = 0; i < s.length; i += 4) {
      if (!s[i + 3]) continue;
      set.add(toHex([s[i], s[i + 1], s[i + 2], s[i + 3]]));
      if (set.size > limit) return null;
    }
  return [...set];
}

function decodeImageFile(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    return { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) };
  }
  throw new Error('Only PNG and JPEG files can be imported here. (The editor\'s Import button also takes GIF, WebP and BMP.)');
}

function loadImage(p, ctx) {
  let img;
  if (p.rgba) {
    const buf = Buffer.from(p.rgba, 'base64');
    const w = int(p.width, 'width'), h = int(p.height, 'height');
    if (buf.length !== w * h * 4) throw new Error('Image data does not match its size.');
    img = { width: w, height: h, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) };
  } else if (p.png) {
    img = decodePng(Buffer.from(p.png, 'base64'));
  } else if (p.path) {
    const file = path.isAbsolute(p.path) ? p.path : path.join(ctx.projectsDir, p.path);
    if (!fs.existsSync(file)) throw new Error(`No file at ${file}`);
    img = decodeImageFile(fs.readFileSync(file));
  } else throw new Error('Give an image path (or image data) to import.');
  if (img.width > 8192 || img.height > 8192) throw new Error('Image is too large (max 8192 px on a side).');
  let background = null;
  if (p.remove_background) {
    const r = removeBackground(img, {
      color: p.bg_color ? parseColor(p.bg_color) : null,
      tolerance: p.bg_tolerance ?? 40,
      edgesOnly: p.bg_edges_only !== false,
    });
    img = r.image;
    background = r.color ? toHex([...r.color, 255]) : 'already transparent';
  }
  return { img, background };
}

function findSprites(img, p) {
  return detectSprites(img, {
    gap: p.gap ? int(p.gap, 'gap') : 0,
    minPixels: p.min_pixels ? int(p.min_pixels, 'min_pixels') : 12,
    region: p.region || null,
  });
}

// Either a regular grid, or individual sprites (detected, picked by number, or given as boxes).
function cutImage(img, p) {
  if (p.boxes || p.detect || p.pick) {
    const found = p.boxes ? null : findSprites(img, p);
    let boxes = p.boxes || found;
    if (p.pick) {
      boxes = p.pick.map((n) => {
        const b = found[int(n, 'pick') - 1];
        if (!b) {
          const hint = found.length <= 1 && !p.remove_background
            ? ' The image probably has a solid background; add remove_background: true.'
            : ' Use analyze_image to see the numbers.';
          throw new Error(`There is no sprite #${n}; ${found.length} found.${hint}`);
        }
        return b;
      });
    }
    if (p.count) boxes = boxes.slice(0, int(p.count, 'count'));
    if (!boxes.length) throw new Error('No sprites found. Try remove_background, or a smaller min_pixels.');
    const { fw, fh, slices } = packBoxes(img, boxes, p.align || 'bottom');
    return { fw, fh, slices, how: `${boxes.length} sprite${boxes.length > 1 ? 's' : ''}${found ? ` (of ${found.length} found)` : ''}, packed into ${fw}x${fh} frames` };
  }
  const { fw, fh, cols, rows, slices } = sliceImage(img, p);
  return { fw, fh, slices, how: `${cols}x${rows} grid of ${fw}x${fh}` };
}

// Tiny 3x5 digits for numbering sprites on the analysis image.
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
function drawLabel(img, W, H, x, y, text, s) {
  const tw = text.length * 4 * s + s, th = 7 * s;
  x = Math.max(0, Math.min(W - tw, x));
  y = Math.max(0, Math.min(H - th, y));
  const put = (px, py, c) => { if (px >= 0 && py >= 0 && px < W && py < H) img.set(c, (py * W + px) * 4); };
  for (let yy = 0; yy < th; yy++) for (let xx = 0; xx < tw; xx++) put(x + xx, y + yy, [20, 20, 30, 255]);
  [...text].forEach((ch, k) => {
    const g = DIGITS[ch];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
      if (g[r * 3 + c] === '1')
        for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) put(x + s + k * 4 * s + c * s + xx, y + s + r * s + yy, [255, 230, 80, 255]);
  });
}
function drawBox(img, W, H, b, s, c) {
  const x0 = b.x * s, y0 = b.y * s, x1 = (b.x + b.w) * s - 1, y1 = (b.y + b.h) * s - 1;
  for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) if (y < H && x < W) img.set(c, (y * W + x) * 4);
  for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) if (y < H && x < W) img.set(c, (y * W + x) * 4);
}

ro('analyzeImage', (p, ctx) => {
  const { img, background } = loadImage(p, ctx);
  const sprites = findSprites(img, p);
  const scale = p.scale ? Math.max(1, Math.min(8, int(p.scale, 'scale'))) : Math.max(1, Math.min(4, Math.floor(1400 / Math.max(img.width, img.height))));
  const view = present(img.data, img.width, img.height, { scale, background: 'checker' });
  sprites.forEach((b) => drawBox(view.data, view.width, view.height, b, scale, [255, 0, 200, 255]));
  const ls = scale >= 3 ? 2 : 1;
  sprites.forEach((b, i) => drawLabel(view.data, view.width, view.height, b.x * scale, b.y * scale - 7 * ls, String(i + 1), ls));
  return {
    size: `${img.width}x${img.height}`,
    background_removed: background,
    sprites: sprites.map((b, i) => ({ n: i + 1, x: b.x, y: b.y, w: b.w, h: b.h })),
    png: encodePng(view.data, view.width, view.height).toString('base64'),
  };
});

mut('importImage', (p, ctx) => {
  const d = ctx.doc;
  const { img, background } = loadImage(p, ctx);
  const cutResult = cutImage(img, p);
  const { fw, fh, how } = cutResult;
  let { slices } = cutResult;

  // Optional color cleanup, done on the frames being imported so the palette fits them.
  let cleanup = null;
  if (p.reduce_colors || p.snap_to_palette || p.reduce_palette) {
    const before = countColors(concatData(slices));
    const pal = p.reduce_palette ? p.reduce_palette.map((c) => parseColor(c).slice(0, 3))
      : p.snap_to_palette ? ctx.doc.palette.map((c) => parseColor(c)).filter((c) => c[3]).map((c) => c.slice(0, 3))
      : buildPalette(slices, Math.max(2, Math.min(256, int(p.reduce_colors, 'reduce_colors'))));
    let specks = 0;
    slices = slices.map((sl) => {
      const r = mapToPalette({ width: fw, height: fh, data: sl }, pal, { despeckle: p.despeckle !== false });
      specks += r.specks;
      return r.image.data;
    });
    cleanup = { colors_before: before, colors_after: pal.length, stray_pixels_removed: specks, palette: p.snap_to_palette ? null : pal.map((c) => toHex([...c, 255])) };
  }
  const mode = p.mode || 'new';
  const duration = p.duration ? Math.max(10, int(p.duration, 'duration')) : 100;
  const ox = p.x ? int(p.x, 'x') : 0, oy = p.y ? int(p.y, 'y') : 0;
  ctx.changes.structure();
  let where;

  if (mode === 'new') {
    d.reset(fw, fh);
    d.layers[0].name = p.layer_name ? String(p.layer_name) : 'Imported';
    d.frames = slices.map(() => ({ id: uid('F'), duration }));
    slices.forEach((s, i) => d.cels.set(d.key(d.layers[0].id, d.frames[i].id), s));
    where = `as a new ${fw}x${fh} sprite`;
  } else if (mode === 'frames') {
    const L = d.resolveLayer(p.layer, ctx.defaults.layerId);
    const cur = d.resolveFrame(p.frame, ctx.defaults.frameId);
    const at = d.frameIndex(cur.id) + 1;
    const made = slices.map(() => ({ id: uid('F'), duration }));
    d.frames.splice(at, 0, ...made);
    slices.forEach((s, i) => blit(s, fw, fh, d.cel(L.id, made[i].id), d.width, d.height, ox, oy));
    where = `as new frames ${at + 1}-${at + made.length} on "${L.name}"`;
  } else if (mode === 'layer') {
    const nl = { id: uid('L'), name: p.layer_name ? String(p.layer_name) : 'Imported', visible: true, opacity: 1 };
    const curL = d.layers.find((l) => l.id === ctx.defaults.layerId);
    d.layers.splice(curL ? d.layerIndex(curL.id) + 1 : d.layers.length, 0, nl);
    const start = d.frameIndex(d.resolveFrame(p.frame, ctx.defaults.frameId).id);
    while (d.frames.length < start + slices.length) d.frames.push({ id: uid('F'), duration });
    slices.forEach((s, i) => blit(s, fw, fh, d.cel(nl.id, d.frames[start + i].id), d.width, d.height, ox, oy));
    where = `on new layer "${nl.name}" from frame ${start + 1}`;
  } else throw new Error(`Unknown mode "${mode}". Use new, frames or layer.`);

  let palette = null;
  if (cleanup?.palette) {
    palette = cleanup.palette; // a cleaned-up import always brings its palette along
    d.palette = palette;
  } else if (p.use_palette) {
    palette = imageColors(slices);
    if (palette) d.palette = palette;
  }
  const clipped = mode !== 'new' && (fw + ox > d.width || fh + oy > d.height || ox < 0 || oy < 0);
  ctx.summary = `imported ${slices.length} frame${slices.length > 1 ? 's' : ''} (${fw}x${fh}) ${where}`;
  return {
    imported_frames: slices.length,
    cut: how,
    background_removed: background ?? undefined,
    placed: where,
    clipped_to_canvas: clipped || undefined,
    palette_set: cleanup?.palette ? palette.length + ' colors' : p.use_palette ? (palette ? palette.length + ' colors' : 'skipped: more than 64 colors') : undefined,
    color_cleanup: cleanup ? { before: cleanup.colors_before, after: cleanup.colors_after, stray_pixels_removed: cleanup.stray_pixels_removed } : undefined,
    frames: frameInfo(d),
  };
});

function concatData(list) {
  const out = new Uint8ClampedArray(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

// Reduce an existing sprite to a small clean palette (or snap it to the current palette).
mut('reduceColors', (p, ctx) => {
  const d = ctx.doc;
  let cels = [];
  const scope = p.scope || 'all';
  if (scope === 'all') cels = [...d.cels.keys()];
  else {
    const t = target(p, ctx);
    if (scope === 'frame') cels = d.layers.map((l) => d.key(l.id, t.f));
    else if (scope === 'layer') cels = d.frames.map((f) => d.key(t.l, f.id));
    else if (scope === 'cel') cels = [d.key(t.l, t.f)];
    else throw new Error(`Unknown scope "${scope}". Use all, frame, layer or cel.`);
  }
  cels = cels.filter((k) => d.cels.has(k));
  if (!cels.length) throw new Error('There are no pixels to clean up.');
  const datas = cels.map((k) => d.cels.get(k));
  const before = countColors(concatData(datas));
  const snap = !!p.snap_to_palette;
  const pal = snap
    ? d.palette.map((c) => parseColor(c)).filter((c) => c[3]).map((c) => c.slice(0, 3))
    : buildPalette(datas, Math.max(2, Math.min(256, int(p.colors ?? 24, 'colors'))));
  if (!pal.length) throw new Error('The palette is empty.');
  let specks = 0;
  for (const k of cels) {
    const r = mapToPalette({ width: d.width, height: d.height, data: d.cels.get(k) }, pal, { despeckle: p.despeckle !== false });
    d.cels.get(k).set(r.image.data);
    specks += r.specks;
  }
  if (!snap && p.set_palette !== false) d.palette = pal.map((c) => toHex([...c, 255]));
  ctx.changes.structure();
  ctx.summary = snap
    ? `snapped ${scope === 'all' ? 'the sprite' : 'the ' + scope} to the palette (${before} colors → ${pal.length})`
    : `reduced ${scope === 'all' ? 'the sprite' : 'the ' + scope} from ${before} to ${pal.length} colors`;
  return { colors_before: before, colors_after: pal.length, stray_pixels_removed: specks, palette: snap ? undefined : d.palette };
});

// Animated GIF of every frame with its own timing. Transparent background by default
// (GIF transparency is on/off), or a solid color.
function makeGif(d, p) {
  const scale = p.scale ? Math.max(1, Math.min(32, int(p.scale, 'scale'))) : 1;
  const bg = !p.background || p.background === 'transparent' ? 'transparent' : parseColor(p.background);
  const frames = d.frames.map((f) => ({
    data: present(d.composite(f.id), d.width, d.height, { scale, background: bg }).data,
    delay: f.duration,
  }));
  const g = encodeGif(frames, d.width * scale, d.height * scale);
  const fast = d.frames.filter((f) => f.duration < 20).length;
  return {
    g,
    info: {
      width: d.width * scale, height: d.height * scale, frames: frames.length, scale,
      colors: g.colors, bytes: g.buffer.length,
      note: [
        g.reduced ? 'More than 255 colors, so the GIF was reduced to 255.' : null,
        fast ? `${fast} frame(s) are shorter than 20 ms; GIF timing is in 10 ms steps and most viewers play them slower.` : null,
      ].filter(Boolean).join(' ') || undefined,
    },
  };
}

ro('renderGif', (p, ctx) => {
  const { g, info } = makeGif(ctx.doc, p);
  return { ...info, gif: g.buffer.toString('base64') };
});

ro('exportPng', (p, ctx) => {
  const d = ctx.doc;
  const scale = p.scale ? Math.max(1, Math.min(32, int(p.scale, 'scale'))) : 1;
  if (p.gif) {
    const file = resolvePath(p.path.replace(/\.png$/i, ''), ctx, '.gif');
    const { g, info } = makeGif(d, p);
    fs.writeFileSync(file, g.buffer);
    return { image: file, ...info };
  }
  if (p.sheet) {
    const file = resolvePath(p.path, ctx, '.png');
    const s = sheet(d, { columns: p.columns, scale, background: 'transparent' });
    fs.writeFileSync(file, encodePng(s.img.data, s.img.width, s.img.height));
    const meta = file.replace(/\.png$/i, '') + '.json';
    fs.writeFileSync(meta, JSON.stringify({ image: path.basename(file), frameWidth: d.width * scale, frameHeight: d.height * scale, frames: s.frames }, null, 2));
    return { image: file, metadata: meta, frames: s.frames.length };
  }
  const f = d.resolveFrame(p.frame, ctx.defaults.frameId);
  const file = resolvePath(p.path, ctx, '.png');
  const img = present(d.composite(f.id), d.width, d.height, { scale });
  fs.writeFileSync(file, encodePng(img.data, img.width, img.height));
  return { image: file, frame: d.frameIndex(f.id) + 1 };
});
