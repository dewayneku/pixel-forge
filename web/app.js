// Pixel Forge editor. The server owns the document; this page mirrors it, sends edits,
// and redraws whenever anyone (you, another tab, or Claude) changes something.
import { linePoints, shapePoints, brushPoints } from './shapes.js';
import { guessBackground, removeBackground, detectSprites, buildPalette, mapToPalette, countColors } from './imagetools.js';

const $ = (s) => document.querySelector(s);
const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64];

const S = {
  w: 32, h: 32, layers: [], frames: [], palette: [], cels: new Map(),
  frameId: null, layerId: null,
  tool: 'pencil', color: [0, 0, 0, 255], brush: 1, fillShapes: false,
  zoom: 12, panX: 0, panY: 0, autoFit: true, playFrameId: null, onion: true, grid: true, playing: false,
  connected: false, agents: [], highlights: [], hover: null, loaded: false,
};

// ---------------------------------------------------------------- colors

const h2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (c) => (c[3] === 0 ? 'transparent' : '#' + h2(c[0]) + h2(c[1]) + h2(c[2]) + (c[3] === 255 ? '' : h2(c[3])));
function parseHex(s) {
  s = String(s).replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('');
  if (s.length === 6) s += 'ff';
  return [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16));
}
const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

// ---------------------------------------------------------------- network

let ws, rpcSeq = 0;
const pending = new Map();

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    S.connected = true;
    ws.send(JSON.stringify({ type: 'hello', role: 'browser' }));
    updatePresence();
  };
  ws.onclose = () => {
    S.connected = false;
    updatePresence();
    for (const p of pending.values()) p.rej(new Error('Disconnected from Pixel Forge server'));
    pending.clear();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}

function rpc(method, params = {}) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== 1) return rej(new Error('Not connected to the Pixel Forge server'));
    const id = ++rpcSeq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
  });
}
const call = (m, p) => rpc(m, p).catch((e) => { toast(e.message, 'error'); throw e; });
const target = () => ({ layer: S.layerId, frame: S.frameId });

function b64ToCel(s) {
  const bin = atob(s);
  const a = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot': loadDoc(msg.doc); break;
    case 'px': {
      const cel = getCel(msg.key);
      const px = msg.px;
      for (let i = 0; i < px.length; i += 6) {
        const o = (px[i + 1] * S.w + px[i]) * 4;
        cel[o] = px[i + 2]; cel[o + 1] = px[i + 3]; cel[o + 2] = px[i + 4]; cel[o + 3] = px[i + 5];
      }
      dirty(msg.key.split(':')[1]);
      break;
    }
    case 'cel':
      if (msg.data) S.cels.set(msg.key, b64ToCel(msg.data));
      else S.cels.delete(msg.key);
      dirty(msg.key.split(':')[1]);
      break;
    case 'rpcResult': {
      const p = pending.get(msg.id);
      if (!p) break;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error)) : p.res(msg.result);
      break;
    }
    case 'activity':
      addActivity(msg.entry);
      if (msg.entry.agent && !msg.replay) {
        toast(`<b>${esc(msg.entry.by)}</b> ${esc(msg.entry.text)}`, 'agent', true);
        flashStage();
      }
      break;
    case 'presence':
      S.agents = msg.clients.filter((c) => c.role === 'agent');
      updatePresence();
      break;
    case 'annotate': {
      const a = msg.annotation;
      if (a.frameId && a.frameId !== S.frameId && S.frames.some((f) => f.id === a.frameId)) selectFrame(a.frameId);
      S.highlights.push({ ...a, until: performance.now() + 10000 });
      requestRender();
      setTimeout(requestRender, 10050);
      break;
    }
  }
}

function getCel(key) {
  let c = S.cels.get(key);
  if (!c) S.cels.set(key, (c = new Uint8ClampedArray(S.w * S.h * 4)));
  return c;
}

function loadDoc(d) {
  const sizeChanged = d.width !== S.w || d.height !== S.h || !S.loaded;
  S.w = d.width; S.h = d.height;
  S.layers = d.layers; S.frames = d.frames; S.palette = d.palette;
  S.cels = new Map(Object.entries(d.cels).map(([k, v]) => [k, b64ToCel(v)]));
  if (!S.frames.some((f) => f.id === S.frameId)) S.frameId = S.frames[0].id;
  if (!S.layers.some((l) => l.id === S.layerId)) S.layerId = S.layers[S.layers.length - 1].id;
  S.loaded = true;
  if (sizeChanged) fitZoom();
  renderLayers();
  renderPalette();
  renderTimeline();
  syncFrameControls();
  updateStatus();
  previewDirty = true;
  requestRender();
  reportUi();
}

// Tell the server what we're looking at, so Claude's edits default to it.
let uiTimer = null;
function reportUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    rpc('setUiState', { frameId: S.frameId, layerId: S.layerId, color: toHex(S.color), tool: S.tool, playing: S.playing }).catch(() => {});
  }, 120);
}

// ---------------------------------------------------------------- compositing

function composite(fid, out) {
  out = out && out.length === S.w * S.h * 4 ? out : new Uint8ClampedArray(S.w * S.h * 4);
  out.fill(0);
  for (const L of S.layers) {
    if (!L.visible) continue;
    const src = S.cels.get(L.id + ':' + fid);
    if (!src) continue;
    const op = L.opacity ?? 1;
    for (let i = 0; i < src.length; i += 4) {
      const sa = (src[i + 3] / 255) * op;
      if (sa <= 0) continue;
      const da = out[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) out[i + c] = (src[i + c] * sa + out[i + c] * da * (1 - sa)) / oa;
      out[i + 3] = oa * 255;
    }
  }
  return out;
}

function frameToCanvas(fid, canvas) {
  if (canvas.width !== S.w || canvas.height !== S.h) { canvas.width = S.w; canvas.height = S.h; }
  canvas.getContext('2d').putImageData(new ImageData(composite(fid), S.w, S.h), 0, 0);
  return canvas;
}

// ---------------------------------------------------------------- main view

const view = $('#view');
const vctx = view.getContext('2d');
const offMain = document.createElement('canvas');
const offOnion = document.createElement('canvas');
let dpr = 1, rq = false;

const checker = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3a46'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#30303b'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  return vctx.createPattern(c, 'repeat');
})();

function resizeView() {
  const r = view.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  view.width = Math.round(r.width * dpr);
  view.height = Math.round(r.height * dpr);
  // Keep the sprite fitted to the window until the user zooms or pans themselves
  // (the first fit can happen before the page has its final size).
  if (S.autoFit && S.loaded) fitZoom();
  requestRender();
}
new ResizeObserver(resizeView).observe(view);

function fitZoom() {
  const r = view.getBoundingClientRect();
  const fit = Math.min((r.width - 40) / S.w, (r.height - 40) / S.h);
  S.zoom = [...ZOOMS].reverse().find((z) => z <= fit) || 1;
  S.panX = S.panY = 0;
  S.autoFit = true;
  updateStatus();
}

function origin() {
  const cw = view.width / dpr, ch = view.height / dpr;
  return { x: Math.round(cw / 2 - (S.w * S.zoom) / 2 + S.panX), y: Math.round(ch / 2 - (S.h * S.zoom) / 2 + S.panY) };
}

function requestRender() {
  if (rq) return;
  rq = true;
  requestAnimationFrame(render);
}

function render() {
  rq = false;
  if (!S.loaded) return;
  const g = vctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, view.width, view.height);
  const o = origin(), z = S.zoom, W = S.w * z, H = S.h * z;

  g.save();
  g.translate(o.x, o.y);
  g.fillStyle = checker;
  g.fillRect(0, 0, W, H);
  g.restore();

  const fi = S.frames.findIndex((f) => f.id === S.frameId);
  if (S.onion && S.frames.length > 1 && !S.playing) {
    const prev = S.frames[(fi - 1 + S.frames.length) % S.frames.length];
    g.globalAlpha = 0.28;
    g.drawImage(frameToCanvas(prev.id, offOnion), o.x, o.y, W, H);
    g.globalAlpha = 1;
  }
  // While playing, the main view shows the animation too.
  const shown = S.playing && S.playFrameId ? S.playFrameId : S.frameId;
  g.drawImage(frameToCanvas(shown, offMain), o.x, o.y, W, H);

  if (S.grid && z >= 8) {
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 1; x < S.w; x++) { g.moveTo(o.x + x * z + 0.5, o.y); g.lineTo(o.x + x * z + 0.5, o.y + H); }
    for (let y = 1; y < S.h; y++) { g.moveTo(o.x, o.y + y * z + 0.5); g.lineTo(o.x + W, o.y + y * z + 0.5); }
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.strokeRect(o.x - 0.5, o.y - 0.5, W + 1, H + 1);

  // Shape being dragged, or brush footprint under the cursor.
  let ghost = null;
  if (drag?.mode === 'shape') ghost = shapePoints(drag.tool, drag.a.x, drag.a.y, drag.b.x, drag.b.y, S.fillShapes);
  else if (S.hover && !drag && ['pencil', 'eraser'].includes(S.tool)) ghost = brushPoints(S.hover.x, S.hover.y, S.brush);
  if (ghost) {
    g.fillStyle = S.tool === 'eraser' ? 'rgba(255,255,255,0.25)' : css([...S.color.slice(0, 3), Math.max(90, S.color[3] * 0.7)]);
    for (const [x, y] of ghost) if (x >= 0 && y >= 0 && x < S.w && y < S.h) g.fillRect(o.x + x * z, o.y + y * z, z, z);
  }

  // Claude's "look here" boxes.
  const now = performance.now();
  S.highlights = S.highlights.filter((h) => h.until > now);
  for (const h of S.highlights) {
    if (h.frameId !== S.frameId) continue;
    const x = o.x + h.x * z, y = o.y + h.y * z;
    g.setLineDash([6, 4]);
    g.lineWidth = 2;
    g.strokeStyle = '#e8a43c';
    g.strokeRect(x - 1, y - 1, h.w * z + 2, h.h * z + 2);
    g.setLineDash([]);
    if (h.message) {
      const text = `${h.by}: ${h.message}`.slice(0, 80);
      g.font = '12px system-ui, sans-serif';
      const tw = g.measureText(text).width + 12;
      const ty = Math.max(0, y - 24);
      g.fillStyle = '#e8a43c';
      g.fillRect(x - 1, ty, tw, 20);
      g.fillStyle = '#1a1206';
      g.fillText(text, x + 5, ty + 14);
    }
  }
}

// ---------------------------------------------------------------- input

let drag = null, spaceDown = false;

function toPixel(e) {
  const r = view.getBoundingClientRect();
  const o = origin();
  return { x: Math.floor((e.clientX - r.left - o.x) / S.zoom), y: Math.floor((e.clientY - r.top - o.y) / S.zoom) };
}
const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < S.w && p.y < S.h;
const newTxn = () => Math.random().toString(36).slice(2);

view.addEventListener('contextmenu', (e) => e.preventDefault());

view.addEventListener('pointerdown', (e) => {
  if (!S.loaded) return;
  view.setPointerCapture(e.pointerId);
  const p = toPixel(e);
  if (e.button === 1 || spaceDown || S.tool === 'pan') {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY };
    view.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  let tool = S.tool;
  if (e.button === 2) tool = 'eraser';
  if (e.altKey) tool = 'picker';
  switch (tool) {
    case 'pencil':
    case 'eraser':
      drag = { mode: 'draw', tool, txn: newTxn(), last: p };
      strokeTo(p, p, tool, drag.txn);
      break;
    case 'line':
    case 'rect':
    case 'ellipse':
      drag = { mode: 'shape', tool, a: p, b: p };
      requestRender();
      break;
    case 'fill':
      if (inside(p)) call('fill', { ...target(), x: p.x, y: p.y, color: toHex(S.color), contiguous: !e.shiftKey });
      break;
    case 'picker':
      pick(p);
      break;
  }
});

view.addEventListener('pointermove', (e) => {
  const p = toPixel(e);
  S.hover = inside(p) ? p : null;
  if (drag?.mode === 'pan') {
    S.autoFit = false;
    S.panX = drag.px + e.clientX - drag.sx;
    S.panY = drag.py + e.clientY - drag.sy;
  } else if (drag?.mode === 'draw') {
    if (p.x !== drag.last.x || p.y !== drag.last.y) strokeTo(drag.last, p, drag.tool, drag.txn);
    drag.last = p;
  } else if (drag?.mode === 'shape') {
    drag.b = p;
  }
  updateStatus();
  requestRender();
});

view.addEventListener('pointerleave', () => { S.hover = null; requestRender(); updateStatus(); });

function endDrag() {
  if (drag?.mode === 'shape') {
    const { a, b, tool } = drag;
    call('drawShape', { ...target(), shape: tool, x0: a.x, y0: a.y, x1: b.x, y1: b.y, color: toHex(S.color), filled: S.fillShapes });
  }
  drag = null;
  view.style.cursor = '';
  requestRender();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

function strokeTo(a, b, tool, txn) {
  const color = tool === 'eraser' ? [0, 0, 0, 0] : S.color;
  const seen = new Set();
  const px = [];
  const cel = getCel(S.layerId + ':' + S.frameId);
  for (const [lx, ly] of linePoints(a.x, a.y, b.x, b.y))
    for (const [x, y] of brushPoints(lx, ly, S.brush)) {
      if (x < 0 || y < 0 || x >= S.w || y >= S.h) continue;
      const k = y * S.w + x;
      if (seen.has(k)) continue;
      seen.add(k);
      px.push(x, y, ...color);
      cel.set(color, k * 4); // draw immediately; the server echo confirms it
    }
  if (!px.length) return;
  dirty(S.frameId);
  rpc('setPixels', { ...target(), px, txn }).catch((e) => toast(e.message, 'error'));
}

function pick(p) {
  if (!inside(p)) return;
  const c = composite(S.frameId);
  const i = (p.y * S.w + p.x) * 4;
  if (c[i + 3] === 0) return;
  setColor([c[i], c[i + 1], c[i + 2], Math.round(c[i + 3])]);
}

view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = view.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const o = origin();
  const fx = (mx - o.x) / S.zoom, fy = (my - o.y) / S.zoom;
  let i = ZOOMS.indexOf(S.zoom);
  if (i < 0) i = ZOOMS.findIndex((z) => z > S.zoom);
  i = Math.max(0, Math.min(ZOOMS.length - 1, i + (e.deltaY < 0 ? 1 : -1)));
  S.zoom = ZOOMS[i];
  S.autoFit = false;
  const cw = view.width / dpr, ch = view.height / dpr;
  S.panX = mx - fx * S.zoom - cw / 2 + (S.w * S.zoom) / 2;
  S.panY = my - fy * S.zoom - ch / 2 + (S.h * S.zoom) / 2;
  updateStatus();
  requestRender();
}, { passive: false });

function updateStatus() {
  const pos = S.hover ? `${S.hover.x}, ${S.hover.y}` : '–';
  $('#status').textContent = `${S.w}×${S.h}  ·  ${pos}  ·  ${S.zoom * 100}%`;
}

// ---------------------------------------------------------------- tools & colors

function setTool(t) {
  S.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  view.style.cursor = t === 'pan' ? 'grab' : '';
  reportUi();
  requestRender();
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function setColor(c) {
  S.color = c;
  $('#color').value = toHex([c[0], c[1], c[2], 255]).slice(0, 7);
  $('#alpha').value = c[3];
  $('#color-hex').textContent = toHex(c);
  renderPalette();
  reportUi();
}
$('#color').addEventListener('input', (e) => setColor([...parseHex(e.target.value).slice(0, 3), S.color[3] || 255]));
$('#alpha').addEventListener('input', (e) => setColor([...S.color.slice(0, 3), Number(e.target.value)]));
$('#brush').addEventListener('input', (e) => { S.brush = Math.max(1, Math.min(16, Number(e.target.value) || 1)); requestRender(); });
$('#fill-shapes').addEventListener('change', (e) => (S.fillShapes = e.target.checked));

function renderPalette() {
  const box = $('#palette');
  box.innerHTML = '';
  const cur = toHex(S.color);
  for (const hex of S.palette) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (hex === cur ? ' current' : '');
    sw.style.background = hex;
    sw.title = hex;
    sw.onclick = () => setColor(parseHex(hex));
    sw.oncontextmenu = (e) => { e.preventDefault(); call('setPalette', { colors: [hex], mode: 'remove' }); };
    box.appendChild(sw);
  }
}
$('#pal-add').onclick = () => call('setPalette', { colors: [toHex(S.color)], mode: 'append' });
$('#btn-gb').onclick = async () => {
  const a = prompt(
    'Convert the current frame to the Game Boy sprite style (replaces the sprite; undo brings it back).\n\n' +
    'Type gen1 or gen2, optionally followed by a tone (lighter, darker, darkest) and "color" for Game Boy Color tints.\n' +
    'Examples: gen2   ·   gen1 darker   ·   gen2 darkest color',
    'gen2');
  if (!a) return;
  const w = a.toLowerCase().split(/\s+/);
  const preset = w.includes('gen1') ? 'gen1' : 'gen2';
  const tone = ['lighter', 'darker', 'darkest'].find((t) => w.includes(t)) || 'auto';
  const colors = w.some((x) => x.startsWith('colo')) ? 'auto' : 'gray';
  const r = await call('gbConvert', { preset, tone, colors, frame: S.frameId }).catch(() => null);
  if (!r) return;
  fitZoom();
  const off = Object.values(r.style.metrics).filter((m) => m.ok === false).length;
  toast(`${r.preset}: ${r.size}${off ? ` · ${off} style checks to touch up` : ' · all style checks pass'}`);
};
$('#pal-reduce').onclick = async () => {
  const a = prompt('Clean up the colors of the whole sprite.\n\nHow many colors to keep? (e.g. 16 or 24)\nOr type "palette" to snap every pixel to the current palette.\n\nUndo restores the original.', '24');
  if (!a) return;
  const snap = /^\s*pal/i.test(a);
  const n = Number(a);
  if (!snap && !(n >= 2)) return toast('Enter a number of colors, or "palette".', 'error');
  const r = await call('reduceColors', snap ? { snap_to_palette: true } : { colors: Math.min(256, Math.round(n)) }).catch(() => null);
  if (r) toast(`${r.colors_before} colors → ${r.colors_after}${r.stray_pixels_removed ? ` · ${r.stray_pixels_removed} stray pixels removed` : ''}`);
};

// ---------------------------------------------------------------- layers

function renderLayers() {
  const list = $('#layers');
  list.innerHTML = '';
  [...S.layers].reverse().forEach((L) => {
    const row = document.createElement('div');
    row.className = 'layer' + (L.id === S.layerId ? ' active' : '');
    const eye = document.createElement('button');
    eye.className = 'eye' + (L.visible ? '' : ' off');
    eye.textContent = '👁';
    eye.title = L.visible ? 'Hide' : 'Show';
    eye.onclick = (e) => { e.stopPropagation(); call('layers', { action: 'update', layer: L.id, visible: !L.visible }); };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = L.name;
    row.append(eye, name);
    row.onclick = () => selectLayer(L.id);
    row.ondblclick = () => {
      const n = prompt('Layer name', L.name);
      if (n && n !== L.name) call('layers', { action: 'update', layer: L.id, name: n });
    };
    list.appendChild(row);
  });
  const cur = S.layers.find((l) => l.id === S.layerId);
  $('#layer-opacity').value = Math.round((cur?.opacity ?? 1) * 100);
}

function selectLayer(id) {
  S.layerId = id;
  renderLayers();
  reportUi();
}

const layerIdx = () => S.layers.findIndex((l) => l.id === S.layerId);
$('#layer-add').onclick = () => call('layers', { action: 'add' }).then((r) => selectLayer(r.created.id));
$('#layer-dup').onclick = () => call('layers', { action: 'duplicate', layer: S.layerId }).then((r) => selectLayer(r.created.id));
$('#layer-del').onclick = () => call('layers', { action: 'delete', layer: S.layerId });
$('#layer-up').onclick = () => call('layers', { action: 'move', layer: S.layerId, to: layerIdx() + 2 });
$('#layer-down').onclick = () => call('layers', { action: 'move', layer: S.layerId, to: Math.max(1, layerIdx()) });
let opacityTxn = null;
$('#layer-opacity').addEventListener('pointerdown', () => (opacityTxn = newTxn()));
$('#layer-opacity').addEventListener('input', (e) =>
  call('layers', { action: 'update', layer: S.layerId, opacity: Number(e.target.value) / 100, txn: opacityTxn }));

// ---------------------------------------------------------------- frames & timeline

const thumbs = new Map(); // frameId -> canvas
const dirtyThumbs = new Set();
let thumbTimer = null;

function dirty(fid) {
  dirtyThumbs.add(fid);
  if (!thumbTimer) thumbTimer = setTimeout(flushThumbs, 120);
  requestRender();
  previewDirty = true;
}
function flushThumbs() {
  thumbTimer = null;
  for (const fid of dirtyThumbs) { const c = thumbs.get(fid); if (c) frameToCanvas(fid, c); }
  dirtyThumbs.clear();
}

function renderTimeline() {
  const box = $('#frames');
  box.innerHTML = '';
  thumbs.clear();
  S.frames.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'frame' + (f.id === S.frameId ? ' active' : '');
    cell.dataset.id = f.id;
    const c = document.createElement('canvas');
    frameToCanvas(f.id, c);
    thumbs.set(f.id, c);
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = `${i + 1} · ${f.duration}ms`;
    cell.append(c, num);
    cell.onclick = () => { if (S.playing) togglePlay(false); selectFrame(f.id); };
    box.appendChild(cell);
  });
}

function selectFrame(id) {
  S.frameId = id;
  document.querySelectorAll('.frame').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  document.querySelector(`.frame[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncFrameControls();
  requestRender();
  previewDirty = true;
  reportUi();
}

function syncFrameControls() {
  const f = S.frames.find((x) => x.id === S.frameId);
  if (f && document.activeElement !== $('#frame-duration')) $('#frame-duration').value = f.duration;
}

const frameIdx = () => S.frames.findIndex((f) => f.id === S.frameId);
$('#frame-add').onclick = () => call('frames', { action: 'add', frame: S.frameId }).then((r) => selectFrame(r.created[0].id));
$('#frame-dup').onclick = () => call('frames', { action: 'duplicate', frame: S.frameId }).then((r) => selectFrame(r.created[0].id));
$('#frame-del').onclick = () => call('frames', { action: 'delete', frame: S.frameId });
$('#frame-left').onclick = () => call('frames', { action: 'move', frame: S.frameId, to: Math.max(1, frameIdx()) });
$('#frame-right').onclick = () => call('frames', { action: 'move', frame: S.frameId, to: frameIdx() + 2 });
$('#frame-duration').addEventListener('change', (e) => call('frames', { action: 'set_duration', frame: S.frameId, duration: Number(e.target.value) }));
$('#onion').addEventListener('change', (e) => { S.onion = e.target.checked; requestRender(); });
$('#grid').addEventListener('change', (e) => { S.grid = e.target.checked; requestRender(); });

// ---------------------------------------------------------------- playback preview

const prev = $('#preview');
let previewDirty = true, playIdx = 0, playAcc = 0, lastT = performance.now();

function togglePlay(on = !S.playing) {
  S.playing = on;
  $('#play').textContent = on ? '❚❚' : '▶';
  $('#play').classList.toggle('active', on);
  playIdx = Math.max(0, frameIdx());
  playAcc = 0;
  document.querySelectorAll('.frame.playing').forEach((el) => el.classList.remove('playing'));
  previewDirty = true;
  reportUi();
  requestRender();
}
$('#play').onclick = () => togglePlay();

function tick(t) {
  const dt = t - lastT;
  lastT = t;
  if (S.loaded) {
    let fid = S.frameId;
    if (S.playing && S.frames.length) {
      playAcc += dt;
      playIdx %= S.frames.length;
      while (playAcc >= S.frames[playIdx].duration) {
        playAcc -= S.frames[playIdx].duration;
        playIdx = (playIdx + 1) % S.frames.length;
        previewDirty = true;
      }
      fid = S.frames[playIdx].id;
      if (fid !== S.playFrameId) { S.playFrameId = fid; requestRender(); }
    }
    if (previewDirty) {
      previewDirty = false;
      const box = $('#preview-box').getBoundingClientRect();
      // Whole-number zoom for small sprites; shrink to fit for big ones.
      let scale = Math.min((box.width - 16) / S.w, (box.height - 16) / S.h);
      if (scale >= 1) scale = Math.floor(scale);
      frameToCanvas(fid, prev);
      prev.style.width = S.w * scale + 'px';
      prev.style.height = S.h * scale + 'px';
      if (S.playing) {
        document.querySelectorAll('.frame').forEach((el) => el.classList.toggle('playing', el.dataset.id === fid));
      }
      const total = S.frames.reduce((s, f) => s + f.duration, 0);
      $('#fps-label').textContent = `${S.frames.length} frame${S.frames.length > 1 ? 's' : ''} · ${(total / 1000).toFixed(2)}s`;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- file actions

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const pngBlob = (b64) => new Blob([b64ToCel(b64)], { type: 'image/png' });

$('#btn-new').onclick = () => {
  const s = prompt('New sprite size (width x height). This replaces the current sprite — undo can bring it back.', `${S.w}x${S.h}`);
  const m = s && s.match(/(\d+)\s*[x×, ]\s*(\d+)/i);
  if (m) call('newDocument', { width: Number(m[1]), height: Number(m[2]) });
};
$('#btn-save').onclick = async () => {
  const data = await call('getProject');
  download('sprite.forge.json', new Blob([JSON.stringify(data)], { type: 'application/json' }));
};
$('#btn-open').onclick = () => $('#file-open').click();
$('#file-open').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    await call('loadProjectData', { data: JSON.parse(await f.text()) });
  } catch (err) {
    toast('Could not open: ' + err.message, 'error');
  }
});
$('#btn-export-frame').onclick = async () => {
  const r = await call('renderFrame', { frame: S.frameId, scale: Number($('#export-scale').value), background: 'transparent' });
  download(`frame-${r.frame}.png`, pngBlob(r.png));
};
$('#btn-export-sheet').onclick = async () => {
  const r = await call('renderSheet', { scale: Number($('#export-scale').value) });
  download('spritesheet.png', pngBlob(r.png));
  download('spritesheet.json', new Blob([JSON.stringify({ image: 'spritesheet.png', frames: r.frames }, null, 2)], { type: 'application/json' }));
};
$('#btn-export-gif').onclick = async () => {
  const r = await call('renderGif', { scale: Number($('#export-scale').value) });
  download('animation.gif', new Blob([b64ToCel(r.gif)], { type: 'image/gif' }));
  toast(`GIF: ${r.frames} frames, ${r.width}×${r.height}, ${(r.bytes / 1024).toFixed(1)} KB${r.note ? ' · ' + r.note : ''}`);
};
$('#btn-undo').onclick = () => call('undo');
$('#btn-redo').onclick = () => call('redo');

// ---------------------------------------------------------------- import

// The dialog keeps the original image, a cleaned-up copy (background removed), and the
// sprites found in it. The same functions run on the server, so what you see is what you get.
const imp = { file: null, src: null, proc: null, procCanvas: document.createElement('canvas'), boxes: [], sel: [], scale: 1, palette: null };
const num = (sel, def = 0) => Math.max(0, Math.round(Number($(sel).value)) || def);
const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
const boxKey = (b) => `${b.x},${b.y},${b.w},${b.h}`;

function guessFrame(w, h) {
  if (w > h && w % h === 0) return [h, h]; // horizontal strip of square frames
  if (h > w && h % w === 0) return [w, w]; // vertical strip
  return [w, h];
}

async function openImport(file) {
  if (!file || !file.type.startsWith('image/')) return toast('That file is not an image.', 'error');
  let bmp;
  try {
    bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    return toast(`Could not read ${file.name} as an image.`, 'error');
  }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  imp.file = file;
  imp.src = g.getImageData(0, 0, bmp.width, bmp.height);
  imp.sel = [];
  const W = bmp.width, H = bmp.height;

  // Sensible defaults: solid border -> remove it; strip -> grid; anything else -> find sprites.
  const bg = guessBackground({ width: W, height: H, data: imp.src.data });
  $('#import-bg').checked = !!bg;
  $('#import-bg-color').value = bg ? toHex([...bg, 255]) : '#ffffff';
  const [fw, fh] = guessFrame(W, H);
  const strip = fw !== W || fh !== H;
  $('#import-cut').value = !strip && Math.max(W, H) > 64 ? 'detect' : 'grid';
  $('#import-fw').value = fw;
  $('#import-fh').value = fh;
  // Zoom in enough that small sprites are easy to click; the preview scrolls.
  const box = $('#import-preview-box').getBoundingClientRect();
  const fit = Math.min((box.width || 640) / W, (box.height || 300) / H);
  $('#import-zoom').value = fit >= 2 ? 'fit' : String(Math.min(4, Math.max(2, Math.ceil(fit * 2))));
  $('#import-mode').value = fw === S.w && fh === S.h ? 'frames' : 'new';
  $('#import-duration').value = S.frames.find((f) => f.id === S.frameId)?.duration ?? 100;
  $('#import-clean').checked = file.type === 'image/jpeg';
  $('#import-info').textContent = `${file.name} · ${W}×${H}px`;
  $('#import-dialog').showModal();
  reprocess();
}

function importGrid() {
  const W = imp.src.width, H = imp.src.height;
  const fw = num('#import-fw', W) || W, fh = num('#import-fh', H) || H;
  const sp = num('#import-spacing'), mg = num('#import-margin');
  const cols = Math.max(1, Math.floor((W - 2 * mg + sp) / (fw + sp)));
  const rows = Math.max(1, Math.floor((H - 2 * mg + sp) / (fh + sp)));
  return { W, H, fw, fh, sp, mg, cols, rows };
}

const detecting = () => $('#import-cut').value === 'detect';
const chosenBoxes = () => (imp.sel.length ? imp.sel : imp.boxes);

// Re-run background removal and detection, then redraw. Debounced while sliders move.
let reprocTimer = null;
function reprocess(delay = 0) {
  clearTimeout(reprocTimer);
  reprocTimer = setTimeout(() => {
    if (!imp.src) return;
    let img = { width: imp.src.width, height: imp.src.height, data: imp.src.data };
    if ($('#import-bg').checked) {
      img = removeBackground(img, {
        color: parseHex($('#import-bg-color').value).slice(0, 3),
        tolerance: num('#import-bg-tol', 0),
        edgesOnly: $('#import-bg-edges').checked,
      }).image;
    }
    imp.proc = img;
    if (detecting()) {
      imp.boxes = detectSprites(img, { gap: num('#import-gap'), minPixels: num('#import-min', 1) || 1 });
      const keep = new Set(imp.boxes.map(boxKey));
      imp.sel = imp.sel.filter((b) => keep.has(boxKey(b)));
    }
    recolor();
  }, delay);
}

// Color cleanup preview. The palette is built from the pixels that will actually be
// imported (the chosen sprites), and that exact palette is sent to the server.
function recolor() {
  let img = imp.proc;
  imp.palette = null;
  const box = $('#import-pal');
  box.innerHTML = '';
  if ($('#import-clean').checked && img) {
    // Only the pixels that will be imported count (the chosen sprites, or the whole image).
    const parts = detecting()
      ? chosenBoxes().map((b) => {
          const out = new Uint8ClampedArray(b.w * b.h * 4);
          for (let y = 0; y < b.h; y++) out.set(img.data.subarray(((b.y + y) * img.width + b.x) * 4, ((b.y + y) * img.width + b.x + b.w) * 4), y * b.w * 4);
          return out;
        })
      : [img.data];
    let pal;
    if ($('#import-snap').checked) {
      pal = S.palette.map((h) => parseHex(h)).filter((c) => c[3]).map((c) => c.slice(0, 3));
    } else {
      pal = buildPalette(parts, Math.max(2, Math.min(256, num('#import-colors', 24))));
      imp.palette = pal;
    }
    const before = countColors(parts.length === 1 ? parts[0] : new Uint8ClampedArray(parts.flatMap((a) => [...a])));
    img = mapToPalette(img, pal, { despeckle: $('#import-despeckle').checked }).image;
    for (const c of pal) {
      const sw = document.createElement('span');
      sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
      box.appendChild(sw);
    }
    box.title = `${before} colors → ${pal.length}`;
  }
  const pc = imp.procCanvas;
  pc.width = img.width; pc.height = img.height;
  pc.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  drawImportPreview();
}

function drawImportPreview() {
  if (!imp.src) return;
  const W = imp.src.width, H = imp.src.height;
  const box = $('#import-preview-box').getBoundingClientRect();
  const z = $('#import-zoom').value;
  let s = z === 'fit' ? Math.min((box.width - 8) / W, (box.height - 8) / H) : Number(z);
  if (z === 'fit' && s >= 1) s = Math.floor(s);
  imp.scale = s;
  const c = $('#import-preview');
  c.width = Math.max(1, Math.round(W * s));
  c.height = Math.max(1, Math.round(H * s));
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = s < 1;
  x.drawImage(imp.procCanvas, 0, 0, c.width, c.height);
  x.lineWidth = 1;
  const det = detecting();
  $('#grid-opts').hidden = det;
  $('#detect-opts').hidden = !det;
  c.classList.toggle('picking', det);

  let msg;
  if (det) {
    const order = new Map(imp.sel.map((b, i) => [boxKey(b), i + 1]));
    for (const b of imp.boxes) {
      const n = order.get(boxKey(b));
      x.strokeStyle = n ? '#ffd23c' : 'rgba(255,60,200,0.9)';
      x.lineWidth = n ? 2 : 1;
      x.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s - 1, b.h * s - 1);
      if (n) {
        x.fillStyle = 'rgba(255,210,60,0.18)';
        x.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
        x.font = 'bold 11px system-ui, sans-serif';
        const label = String(n), tw = x.measureText(label).width + 6;
        x.fillStyle = '#ffd23c';
        x.fillRect(b.x * s, b.y * s, tw, 14);
        x.fillStyle = '#1a1206';
        x.fillText(label, b.x * s + 3, b.y * s + 11);
      }
    }
    const use = chosenBoxes();
    const fw = Math.max(0, ...use.map((b) => b.w)), fh = Math.max(0, ...use.map((b) => b.h));
    msg = !imp.boxes.length
      ? 'No sprites found. Try Remove background, or a lower Min size.'
      : `${imp.boxes.length} sprites found · ` +
        (imp.sel.length ? `${imp.sel.length} chosen, in the order you clicked` : 'click sprites to choose them in order, or import all') +
        ` → ${use.length} frame${use.length > 1 ? 's' : ''} of ${fw}×${fh}`;
    $('#import-go').disabled = !use.length;
  } else {
    const g = importGrid();
    x.strokeStyle = 'rgba(108,140,255,0.9)';
    for (let r = 0; r < g.rows; r++)
      for (let col = 0; col < g.cols; col++)
        x.strokeRect((g.mg + col * (g.fw + g.sp)) * s + 0.5, (g.mg + r * (g.fh + g.sp)) * s + 0.5, g.fw * s - 1, g.fh * s - 1);
    const fits = g.fw <= g.W && g.fh <= g.H;
    msg = fits ? `${g.cols}×${g.rows} grid → up to ${g.cols * g.rows} frame${g.cols * g.rows > 1 ? 's' : ''} of ${g.fw}×${g.fh}` : 'Frame size is bigger than the image.';
    $('#import-go').disabled = !fits;
  }
  $('#import-count').textContent = msg;
}

// Click a sprite to add it (next frame); click again to remove it.
$('#import-preview').addEventListener('click', (e) => {
  if (!detecting()) return;
  const px = e.offsetX / imp.scale, py = e.offsetY / imp.scale;
  const hit = imp.boxes.filter((b) => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (!hit) return;
  const k = boxKey(hit);
  const i = imp.sel.findIndex((b) => boxKey(b) === k);
  if (i >= 0) imp.sel.splice(i, 1);
  else imp.sel.push(hit);
  if ($('#import-clean').checked && !$('#import-snap').checked) recolorSoon();
  else drawImportPreview();
});
$('#import-clear-sel').onclick = () => { imp.sel = []; recolor(); };
let recolorTimer = null;
const recolorSoon = () => { drawImportPreview(); clearTimeout(recolorTimer); recolorTimer = setTimeout(recolor, 150); };
['#import-clean', '#import-snap', '#import-despeckle'].forEach((q) => $(q).addEventListener('input', recolor));
$('#import-colors').addEventListener('input', recolorSoon);

['#import-bg', '#import-bg-color', '#import-bg-edges', '#import-cut', '#import-gap', '#import-min'].forEach((s) =>
  $(s).addEventListener('input', () => reprocess()));
$('#import-bg-tol').addEventListener('input', (e) => { $('#import-bg-tol-val').textContent = e.target.value; reprocess(60); });
['#import-fw', '#import-fh', '#import-spacing', '#import-margin'].forEach((s) => $(s).addEventListener('input', drawImportPreview));
['#import-mode', '#import-zoom'].forEach((s) => $(s).addEventListener('change', drawImportPreview));
$('#import-whole').onclick = () => {
  $('#import-fw').value = imp.src.width;
  $('#import-fh').value = imp.src.height;
  drawImportPreview();
};

$('#import-dialog').addEventListener('close', async () => {
  if ($('#import-dialog').returnValue !== 'ok' || !imp.src) return;
  const mode = $('#import-mode').value;
  const params = {
    mode,
    duration: num('#import-duration', 100),
    use_palette: $('#import-palette').checked,
    layer_name: imp.file.name.replace(/\.[^.]+$/, '').slice(0, 40),
    ...target(),
  };
  if ($('#import-bg').checked) {
    Object.assign(params, {
      remove_background: true,
      bg_color: $('#import-bg-color').value,
      bg_tolerance: num('#import-bg-tol', 0),
      bg_edges_only: $('#import-bg-edges').checked,
    });
  }
  if ($('#import-clean').checked) {
    params.despeckle = $('#import-despeckle').checked;
    if ($('#import-snap').checked) params.snap_to_palette = true;
    else if (imp.palette?.length) params.reduce_palette = imp.palette.map((c) => toHex([...c, 255]));
  }
  if (detecting()) {
    params.boxes = chosenBoxes().map(({ x, y, w, h }) => ({ x, y, w, h }));
    params.align = $('#import-align').value;
  } else {
    const g = importGrid();
    Object.assign(params, { frame_width: g.fw, frame_height: g.fh, spacing: g.sp, margin: g.mg, skip_empty: $('#import-skip').checked });
  }
  try {
    if (imp.file.type === 'image/png') {
      params.png = await blobToB64(imp.file); // exact pixel values
    } else {
      params.rgba = await blobToB64(new Blob([imp.src.data]));
      params.width = imp.src.width;
      params.height = imp.src.height;
    }
    const before = frameIdx();
    const r = await call('importImage', params);
    if (mode === 'frames' && S.frames[before + 1]) selectFrame(S.frames[before + 1].id);
    if (mode === 'layer') selectLayer(S.layers.find((l) => l.name === params.layer_name)?.id ?? S.layerId);
    toast(`Imported ${r.imported_frames} frame${r.imported_frames > 1 ? 's' : ''}${r.color_cleanup ? ` · ${r.color_cleanup.before} colors → ${r.color_cleanup.after}` : r.palette_set ? ' · palette: ' + r.palette_set : ''}`);
  } catch {}
});

$('#btn-import').onclick = () => $('#file-import').click();
$('#file-import').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openImport(f);
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) f.text().then((t) => call('loadProjectData', { data: JSON.parse(t) })).catch(() => {});
  else openImport(f);
});

// ---------------------------------------------------------------- keyboard

const KEYS = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', u: 'rect', o: 'ellipse', h: 'pan' };
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); call(e.shiftKey ? 'redo' : 'undo'); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); call('redo'); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); $('#btn-save').click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
  if (KEYS[k]) return setTool(KEYS[k]);
  if (k === '[' || k === ']') {
    S.brush = Math.max(1, Math.min(16, S.brush + (k === ']' ? 1 : -1)));
    $('#brush').value = S.brush;
    requestRender();
  }
  if (k === ',' || k === '.' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const n = S.frames.length;
    const d = k === ',' || e.key === 'ArrowLeft' ? -1 : 1;
    selectFrame(S.frames[(frameIdx() + d + n) % n].id);
  }
  if (e.key === 'Enter') togglePlay();
  if (k === '0') { fitZoom(); requestRender(); updateStatus(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; view.style.cursor = S.tool === 'pan' ? 'grab' : ''; }
});

// ---------------------------------------------------------------- presence, activity, toasts

function updatePresence() {
  const pill = $('#presence');
  const text = $('#presence-text');
  pill.className = 'pill ' + (!S.connected ? 'offline' : S.agents.length ? 'agent' : 'online');
  text.textContent = !S.connected
    ? 'Server offline — reconnecting'
    : S.agents.length
      ? `${[...new Set(S.agents.map((a) => a.name))].join(', ')} connected`
      : 'Live · no agent connected';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function addActivity(entry) {
  const box = $('#activity');
  const el = document.createElement('div');
  el.className = 'act' + (entry.agent ? ' agent' : '');
  const t = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<span class="muted">${t}</span> <b>${esc(entry.by)}</b> ${esc(entry.text)}`;
  box.prepend(el);
  while (box.children.length > 60) box.lastChild.remove();
}

function toast(html, kind = '', isHtml = false) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  if (isHtml) el.innerHTML = html; else el.textContent = html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 3500);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

let flashTimer;
function flashStage() {
  $('#stage').classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => $('#stage').classList.remove('flash'), 600);
}

// ---------------------------------------------------------------- go

setTool('pencil');
setColor([0, 0, 0, 255]);
updateStatus();
connect();
