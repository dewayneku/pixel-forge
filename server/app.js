// Pixel Forge app server: serves the editor, holds the one shared document, and
// syncs every change to all connected editors (browsers) and agents (Claude via MCP).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SpriteDoc, toB64 } from './doc.js';
import { methods, MUTATING, Changes } from './methods.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(ROOT, 'projects');
const PORT = Number(process.env.PIXEL_FORGE_PORT || 7777);
// Each port keeps its own autosave, so a test server never overwrites your work.
const AUTOSAVE = path.join(DATA, PORT === 7777 ? 'autosave.forge.json' : `autosave-${PORT}.forge.json`);
const EDITOR_URL = `http://localhost:${PORT}`;

const log = (...a) => console.error('[pixel-forge]', ...a);

// ---------------------------------------------------------------- state

const doc = new SpriteDoc(32, 32);
try {
  doc.load(JSON.parse(fs.readFileSync(AUTOSAVE, 'utf8')));
  log('restored autosave');
} catch {}

const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const history = {
  undo: [],
  redo: [],
  checkpoint() {
    this.undo.push(doc.snapshot());
    this.redo = [];
    let bytes = this.undo.reduce((s, x) => s + x.cels.size * doc.celSize, 0);
    while ((this.undo.length > 200 || bytes > MAX_HISTORY_BYTES) && this.undo.length > 1) {
      bytes -= this.undo.shift().cels.size * doc.celSize;
    }
  },
};

const clients = new Map(); // ws -> client
let nextClientId = 1;
let lastBrowser = null;
const activity = [];
let activitySeq = 0;
const lastTxn = new Map(); // client id -> txn

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients.values()) if (c.role === 'browser' && c.ws.readyState === 1) c.ws.send(s);
}
function clientList() {
  return [...clients.values()].filter((c) => c.role).map((c) => ({ id: c.id, role: c.role, name: c.name }));
}
function snapshotMsg(by) {
  return { type: 'snapshot', doc: doc.serialize(), by };
}

function addActivity(client, text) {
  const entry = { seq: ++activitySeq, time: new Date().toISOString(), by: client.name, agent: client.role === 'agent', text };
  activity.push(entry);
  if (activity.length > 500) activity.shift();
  broadcast({ type: 'activity', entry });
}

let saveTimer = null;
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(AUTOSAVE, JSON.stringify(doc.serialize()));
    } catch (e) {
      log('autosave failed:', e.message);
    }
  }, 1500);
}

function flush(changes, by) {
  if (changes.struct) {
    broadcast(snapshotMsg(by));
  } else {
    for (const k of changes.full) {
      const c = doc.cels.get(k);
      broadcast({ type: 'cel', key: k, data: c ? toB64(c) : null, by });
    }
    for (const [k, px] of changes.px) broadcast({ type: 'px', key: k, px, by });
  }
  scheduleAutosave();
}

// ---------------------------------------------------------------- rpc

function defaultsFor(client) {
  const ui = client.role === 'browser' ? client.ui : lastBrowser?.ui;
  return ui || {};
}

function handleRpc(client, { id, method, params = {} }) {
  const reply = (body) => send(client.ws, { type: 'rpcResult', id, ...body });
  try {
    // Methods that need server-level state.
    if (method === 'setUiState') {
      client.ui = { ...client.ui, ...params };
      lastBrowser = client;
      return reply({ result: { ok: true } });
    }
    if (method === 'undo' || method === 'redo') {
      const from = history[method], to = history[method === 'undo' ? 'redo' : 'undo'];
      if (!from.length) return reply({ result: { ok: false, message: `Nothing to ${method}.` } });
      to.push(doc.snapshot());
      doc.restore(from.pop());
      lastTxn.clear();
      broadcast(snapshotMsg(client.name));
      addActivity(client, method === 'undo' ? 'undid the last change' : 'redid a change');
      scheduleAutosave();
      return reply({ result: { ok: true, undo_steps: history.undo.length, redo_steps: history.redo.length } });
    }
    if (method === 'annotate') {
      const f = doc.resolveFrame(params.frame, defaultsFor(client).frameId);
      const annotation = {
        x: Number(params.x) || 0, y: Number(params.y) || 0, w: Number(params.w) || 1, h: Number(params.h) || 1,
        message: String(params.message || ''), frameId: f.id, by: client.name,
      };
      broadcast({ type: 'annotate', annotation });
      addActivity(client, `pointed at ${annotation.w}x${annotation.h} at (${annotation.x},${annotation.y}): ${annotation.message}`);
      return reply({ result: { shown_to: clientList().filter((c) => c.role === 'browser').length } });
    }

    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method "${method}".`);
    const mutating = MUTATING.has(method);
    let fresh = false;
    if (mutating) {
      const txn = params.txn ?? null;
      if (txn === null || lastTxn.get(client.id) !== txn) {
        history.checkpoint();
        fresh = true;
      }
      lastTxn.set(client.id, txn);
    }
    const ctx = {
      doc, history, activity,
      changes: new Changes(doc),
      defaults: defaultsFor(client),
      clients: clientList(),
      editorUrl: EDITOR_URL,
      projectsDir: PROJECTS,
      summary: null,
    };
    let result;
    try {
      result = fn(params, ctx);
    } catch (e) {
      if (fresh) history.undo.pop();
      throw e;
    }
    if (mutating) {
      flush(ctx.changes, client.name);
      if (fresh && ctx.summary) addActivity(client, ctx.summary);
    }
    reply({ result });
  } catch (e) {
    reply({ error: e.message });
  }
}

// ---------------------------------------------------------------- http + ws

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, EDITOR_URL);
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ app: 'pixel-forge', ok: true }));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  // Only accept local pages and local tools.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return ws.close(1008, 'origin not allowed');

  const client = { id: nextClientId++, ws, role: null, name: 'you', ui: null };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      client.role = msg.role === 'agent' ? 'agent' : 'browser';
      client.name = client.role === 'agent' ? String(msg.name || 'Claude') : 'you';
      if (client.role === 'browser') send(ws, snapshotMsg(null));
      for (const e of activity.slice(-40)) if (client.role === 'browser') send(ws, { type: 'activity', entry: e, replay: true });
      broadcast({ type: 'presence', clients: clientList() });
      log(`${client.role} connected (${client.name})`);
    } else if (msg.type === 'rpc') {
      handleRpc(client, msg);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (lastBrowser === client) lastBrowser = [...clients.values()].reverse().find((c) => c.role === 'browser' && c.ui) || null;
    broadcast({ type: 'presence', clients: clientList() });
  });
});

function onListenError(e) {
  if (e.code === 'EADDRINUSE') log(`port ${PORT} is already in use; Pixel Forge is probably already running at ${EDITOR_URL}`);
  else log(e.message);
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', onListenError); // the WebSocket server re-raises listen errors too

server.listen(PORT, '127.0.0.1', () => {
  log(`editor running at ${EDITOR_URL}`);
});
