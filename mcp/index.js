#!/usr/bin/env node
// Pixel Forge MCP server: lets Claude (or any MCP client) see and edit the sprite
// that is open in the Pixel Forge editor, live, alongside you.
// It connects to the app server over WebSocket and starts it if it isn't running.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PIXEL_FORGE_PORT || 7777);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const EDITOR_URL = `http://localhost:${PORT}`;
const AGENT_NAME = process.env.PIXEL_FORGE_AGENT_NAME || 'Claude';
const log = (...a) => console.error('[pixel-forge-mcp]', ...a);

// ---------------------------------------------------------------- bridge to the app

let ws = null, connecting = null, seq = 0, startedApp = false;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL);
    sock.once('open', () => {
      sock.send(JSON.stringify({ type: 'hello', role: 'agent', name: AGENT_NAME }));
      ws = sock;
      resolve();
    });
    sock.once('error', reject);
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'rpcResult') return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
    sock.on('close', () => {
      if (ws === sock) ws = null;
      for (const p of pending.values()) p.reject(new Error('Lost connection to the Pixel Forge app.'));
      pending.clear();
    });
  });
}

function startApp() {
  log('app not running; starting it');
  startedApp = true;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

async function ensure() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (!connecting) {
    connecting = (async () => {
      try {
        await open();
      } catch {
        startApp();
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          try { await open(); return; } catch {}
        }
        throw new Error(`Could not reach or start the Pixel Forge app on port ${PORT}. Run "npm start" in ${ROOT}.`);
      }
    })().finally(() => (connecting = null));
  }
  await connecting;
}

async function rpc(method, params = {}) {
  await ensure();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for ${method}.`)); }, 20000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
  });
}

// ---------------------------------------------------------------- MCP server

const server = new McpServer(
  { name: 'pixel-forge', version: '0.1.0' },
  {
    instructions: `Pixel Forge is a pixel-art sprite animator the user has open in their browser at ${EDITOR_URL}. You share one live document with them: every edit you make appears on their screen immediately, and theirs are visible to you.

- Start with get_document to see the canvas size, frames, layers and what the user is currently looking at. Frames are numbered from 1 like the timeline; layers are named (or numbered from 1 = bottom).
- When you leave out "frame" or "layer", tools act on the frame and layer the user has selected, so "fix this" means what they're looking at.
- Look before and after you draw: view_frame returns an image. get_pixels gives exact colors as a character grid.
- draw_grid is the best way to draw sprite art: one string per row, one character per pixel, with a legend mapping characters to colors. Characters not in the legend leave pixels untouched.
- Coordinates are pixels from the top-left (0,0).
- Each tool call is one undo step for both of you. Prefer working on your own layer for big changes so the user can compare or hide it.
- Use annotate to point at a region on the user's screen when explaining something.
- If the user hasn't opened the editor, give them the link ${EDITOR_URL} or call open_editor.`,
  },
);

const frameRef = z.union([z.number().int(), z.string()]).optional()
  .describe('Frame number (1 = first, as in the timeline). Defaults to the frame the user has selected.');
const layerRef = z.union([z.number().int(), z.string()]).optional()
  .describe('Layer name, or number (1 = bottom). Defaults to the layer the user has selected.');
const color = z.string().describe('Hex color "#rgb", "#rrggbb" or "#rrggbbaa", or "transparent" to erase.');

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function tool(name, description, inputSchema, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
}

// ----- seeing

tool('get_document', 'Overview of the sprite: size, frames, layers (bottom to top), palette, and the frame/layer/color/tool the user currently has selected.',
  {}, async () => {
    const d = await rpc('getDocument');
    if (startedApp && !d.editors_open) d.note = `The app was just started and the user has no editor open. Share ${EDITOR_URL} or call open_editor.`;
    return text(d);
  }, { readOnlyHint: true });

tool('view_frame', 'See a frame as an image (all visible layers composited, or one layer). Transparent areas show as a light checkerboard by default.',
  {
    frame: frameRef,
    layer: z.union([z.number().int(), z.string()]).optional().describe('Show only this layer (even if hidden). Omit to see all visible layers.'),
    scale: z.number().int().min(1).max(64).optional().describe('Pixel scale. Default fits about 384px.'),
    grid: z.boolean().optional().describe('Draw pixel grid lines (helps counting).'),
    background: z.string().optional().describe('"checker" (default), "transparent", or a hex color.'),
  }, async (a) => {
    const r = await rpc('renderFrame', a);
    return {
      content: [
        { type: 'image', data: r.png, mimeType: 'image/png' },
        { type: 'text', text: `Frame ${r.frame} at ${r.scale}x (${r.width}x${r.height}px image).` },
      ],
    };
  }, { readOnlyHint: true });

tool('view_animation', 'See every frame side by side as one sprite-sheet image, to check how the animation flows.',
  {
    scale: z.number().int().min(1).max(32).optional().describe('Pixel scale. Default picks one that keeps the image readable.'),
    columns: z.number().int().min(1).optional().describe('Frames per row. Default: all in one row (up to 8).'),
  }, async (a) => {
    const d = await rpc('getDocument');
    const cols = a.columns || Math.min(8, d.frames.length);
    const scale = a.scale || Math.max(1, Math.min(16, Math.floor(1024 / (cols * d.width))));
    const r = await rpc('renderSheet', { scale, columns: cols, background: 'checker', padding: 1 });
    return {
      content: [
        { type: 'image', data: r.png, mimeType: 'image/png' },
        { type: 'text', text: `${d.frames.length} frames, ${r.columns} per row, left to right. Durations (ms): ${d.frames.map((f) => f.duration_ms).join(', ')}` },
      ],
    };
  }, { readOnlyHint: true });

tool('get_pixels', 'Read exact pixel colors as a character grid with a legend ("." = transparent). Same format draw_grid takes, so you can read, edit and write back.',
  {
    frame: frameRef, layer: layerRef,
    x: z.number().int().optional(), y: z.number().int().optional(),
    w: z.number().int().optional(), h: z.number().int().optional(),
    composite: z.boolean().optional().describe('Read all visible layers blended instead of one layer.'),
  }, async (a) => text(await rpc('getPixels', a)), { readOnlyHint: true });

tool('get_activity', "Recent edits by the user and by you, newest last. Use 'since' with the last seq you saw to catch up on what the user did.",
  { since: z.number().int().optional(), limit: z.number().int().optional() },
  async (a) => text(await rpc('getActivity', a)), { readOnlyHint: true });

// ----- drawing

tool('draw_grid', 'Draw pixel art from rows of characters. Each character is one pixel; the legend maps characters to colors. Characters not in the legend (e.g. "." or " ") leave pixels unchanged; map a character to "transparent" to erase.',
  {
    rows: z.array(z.string()).describe('One string per row, top to bottom.'),
    legend: z.record(z.string(), z.string()).describe('Character -> color, e.g. {"k":"#000000","s":"#f2c6a0","_":"transparent"}'),
    x: z.number().int().optional().describe('Left edge (default 0).'),
    y: z.number().int().optional().describe('Top edge (default 0).'),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('drawGrid', a)));

tool('set_pixels', 'Set individual pixels.',
  {
    pixels: z.array(z.object({ x: z.number().int(), y: z.number().int(), color })),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('setPixels', a)));

tool('draw_shape', 'Draw a pixel-perfect line, rectangle or ellipse between two corners (inclusive).',
  {
    shape: z.enum(['line', 'rect', 'ellipse']),
    x0: z.number().int(), y0: z.number().int(), x1: z.number().int(), y1: z.number().int(),
    color, filled: z.boolean().optional(),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('drawShape', a)));

tool('fill', 'Paint-bucket fill from a point (4-way contiguous), or replace that color everywhere on the layer with contiguous=false.',
  {
    x: z.number().int(), y: z.number().int(), color,
    contiguous: z.boolean().optional(),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('fill', a)));

tool('edit_cel', 'Whole-layer edits on one frame: clear, shift (move pixels by dx,dy; wrap optional — great for walk cycles and bobbing), flip_h, flip_v, copy_from (copy another frame/layer here), replace_color.',
  {
    action: z.enum(['clear', 'shift', 'flip_h', 'flip_v', 'copy_from', 'replace_color']),
    dx: z.number().int().optional(), dy: z.number().int().optional(), wrap: z.boolean().optional(),
    from_frame: z.union([z.number().int(), z.string()]).optional(),
    from_layer: z.union([z.number().int(), z.string()]).optional(),
    from_color: z.string().optional(), to_color: z.string().optional(),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('editCel', a)));

// ----- structure

tool('manage_frames', 'Add, duplicate, delete, reorder frames or set their duration. New frames go after "frame" unless "to" (position, 1-based) is given. set_duration accepts frame "all".',
  {
    action: z.enum(['add', 'duplicate', 'delete', 'move', 'set_duration']),
    frame: z.union([z.number().int(), z.string()]).optional().describe('Frame to act on (1-based). Defaults to the user\'s selected frame.'),
    to: z.number().int().optional().describe('Target position (1-based) for move, or insert position for add/duplicate.'),
    count: z.number().int().min(1).max(64).optional().describe('How many frames to add/duplicate.'),
    duration: z.number().int().optional().describe('Milliseconds per frame.'),
  }, async (a) => text(await rpc('frames', a)));

tool('manage_layers', 'Add, duplicate, delete, reorder (to = position from bottom, 1-based) or update (name, visible, opacity 0-1) layers.',
  {
    action: z.enum(['add', 'duplicate', 'delete', 'move', 'update']),
    layer: layerRef,
    name: z.string().optional(),
    to: z.number().int().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
  }, async (a) => text(await rpc('layers', a)));

tool('set_palette', 'Change the palette shown in the editor.',
  {
    colors: z.array(z.string()).optional(),
    mode: z.enum(['replace', 'append', 'remove', 'reset']).optional().describe('Default replace.'),
  }, async (a) => text(await rpc('setPalette', a)));

tool('canvas', 'Start a new blank sprite (replaces the current one; undo can restore it) or resize the canvas, keeping pixels anchored.',
  {
    action: z.enum(['new', 'resize']),
    width: z.number().int().min(1).max(1024),
    height: z.number().int().min(1).max(1024),
    anchor: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']).optional(),
  }, async (a) => text(await rpc(a.action === 'new' ? 'newDocument' : 'resize', a)), { destructiveHint: true });

tool('history', 'Undo or redo the last change (shared with the user).',
  { action: z.enum(['undo', 'redo']) }, async (a) => text(await rpc(a.action)));

// ----- collaboration & files

tool('annotate', "Highlight a rectangle on the user's canvas with a short message, to point at something.",
  {
    x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1),
    message: z.string(), frame: frameRef,
  }, async (a) => text(await rpc('annotate', a)), { readOnlyHint: true });

tool('file', 'Save or open a project (.forge.json), or export. export_frame: one PNG. export_sheet: all frames in a grid plus a .json with frame rects and durations. export_gif: an animated GIF that loops, using each frame\'s duration. Relative paths go in the projects/ folder.',
  {
    action: z.enum(['save', 'open', 'export_frame', 'export_sheet', 'export_gif']),
    path: z.string(),
    frame: frameRef,
    scale: z.number().int().min(1).max(32).optional().describe('Pixel scale for exports (default 1). GIFs are often easier to view at 4.'),
    columns: z.number().int().min(1).optional(),
    background: z.string().optional().describe('export_gif: "transparent" (default) or a hex color.'),
  }, async (a) => {
    if (a.action === 'save') return text(await rpc('saveProject', a));
    if (a.action === 'open') return text(await rpc('loadProject', a));
    return text(await rpc('exportPng', { ...a, sheet: a.action === 'export_sheet', gif: a.action === 'export_gif' }));
  });

// Options shared by analyze_image and import_image for cleaning up and cutting sheets.
const sheetOptions = {
  remove_background: z.boolean().optional().describe('Make the background transparent. The color is detected from the image border unless bg_color is given. Needed for JPEGs and sheets on a solid background.'),
  bg_color: z.string().optional().describe('Background color to remove, e.g. "#ffffff".'),
  bg_tolerance: z.number().int().min(0).max(255).optional().describe('How far a color may differ from the background and still count (default 40; raise for noisy JPEGs).'),
  bg_edges_only: z.boolean().optional().describe('Only remove background connected to the image edge (default true), so white eyes and highlights inside sprites stay.'),
  gap: z.number().int().min(0).optional().describe('Join sprite parts within this many pixels of each other (default 0: only touching or overlapping parts).'),
  min_pixels: z.number().int().min(1).optional().describe('Ignore specks smaller than this (default 12).'),
  region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).optional()
    .describe('Only look for sprites inside this rectangle of the image.'),
};

tool('analyze_image', 'Look at an image file before importing it: returns the image with every detected sprite boxed and numbered, plus the list of boxes. Use those numbers with import_image "pick". Works on PNG and JPEG.',
  {
    path: z.string().describe('Path to a .png or .jpg file.'),
    ...sheetOptions,
    scale: z.number().int().min(1).max(8).optional().describe('Zoom for the returned picture (default fits about 1200px).'),
  }, async (a) => {
    const r = await rpc('analyzeImage', a);
    const { png, ...info } = r;
    return { content: [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(info) }] };
  }, { readOnlyHint: true });

tool('import_image', 'Import a PNG or JPEG: as a new sprite, as new frames after the current one, or onto a new layer. To cut a sheet: give frame_width/frame_height for an even grid, or detect=true to find each sprite automatically (use pick to choose sprites by the numbers analyze_image shows, in the order you want them as frames). Detected sprites are packed into equal frames aligned at the feet. Relative paths are read from the projects/ folder.',
  {
    path: z.string().describe('Path to a .png or .jpg file.'),
    mode: z.enum(['new', 'frames', 'layer']).optional().describe('new (default): replace the sprite, canvas = frame size. frames: insert as new frames on a layer. layer: new layer across frames starting at "frame".'),
    ...sheetOptions,
    detect: z.boolean().optional().describe('Find sprites automatically instead of using a grid.'),
    pick: z.array(z.number().int().min(1)).optional().describe('Sprite numbers from analyze_image, in frame order. Implies detect.'),
    boxes: z.array(z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })).optional()
      .describe('Exact rectangles to import as frames, in order.'),
    align: z.enum(['bottom', 'center', 'top-left']).optional().describe('How detected sprites sit in their frame (default bottom: feet on the bottom edge, centred).'),
    frame_width: z.number().int().min(1).optional().describe('Grid mode: width of one frame in the sheet. Default: whole image.'),
    frame_height: z.number().int().min(1).optional(),
    spacing: z.number().int().min(0).optional().describe('Grid mode: gap in pixels between frames.'),
    margin: z.number().int().min(0).optional().describe('Grid mode: border in pixels around the sheet.'),
    count: z.number().int().min(1).optional().describe('Import at most this many frames.'),
    skip_empty: z.boolean().optional().describe('Grid mode: skip fully transparent cells (default true).'),
    duration: z.number().int().optional().describe('Milliseconds per imported frame (default 100).'),
    use_palette: z.boolean().optional().describe("Replace the palette with the image's colors (if 64 or fewer)."),
    reduce_colors: z.number().int().min(2).max(256).optional().describe('Clean up colors: reduce the imported frames to this many colors (24 is a good start for JPEG or resized art) and use them as the palette.'),
    snap_to_palette: z.boolean().optional().describe("Clean up colors by snapping to the sprite's current palette instead."),
    despeckle: z.boolean().optional().describe('With color cleanup, remove stray single pixels that touch nothing (default true).'),
    layer_name: z.string().optional(),
    x: z.number().int().optional().describe('Where to place the image on the canvas (frames/layer modes).'),
    y: z.number().int().optional(),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('importImage', a)), { destructiveHint: true });

tool('reduce_colors', 'Clean up colors already in the sprite: reduce them to a small palette (fixes JPEG noise and blurry, resized art) or snap them to the current palette. Also makes alpha fully on/off and can remove stray single pixels. One undo step.',
  {
    colors: z.number().int().min(2).max(256).optional().describe('How many colors to keep (default 24). Ignored with snap_to_palette.'),
    snap_to_palette: z.boolean().optional().describe('Snap every pixel to the nearest color in the current palette.'),
    scope: z.enum(['all', 'frame', 'layer', 'cel']).optional().describe('What to clean: the whole sprite (default), one frame (all layers), one layer (all frames), or one layer on one frame.'),
    despeckle: z.boolean().optional().describe('Remove stray single pixels that touch nothing (default true).'),
    set_palette: z.boolean().optional().describe('Replace the palette with the reduced colors (default true).'),
    frame: frameRef, layer: layerRef,
  }, async (a) => text(await rpc('reduceColors', a)), { destructiveHint: true });

tool('gameboy_style', 'Convert a sprite to the Game Boy (Gen 1 / Gen 2) style: 4 shades, 40/48/56 px canvas by size class, black outline, interior lines and shade balance measured from real sprites. Source: an image file (path) or a frame of the open sprite. Result goes in as a new sprite by default (undo restores the old one). Returns a style report; follow it with a manual cleanup pass (see the gameboy-sprite-style skill).',
  {
    preset: z.enum(['gen1', 'gen2']).optional().describe('gen1: rougher, broken outlines, more dark. gen2 (default): solid outline, lighter, cleaner.'),
    path: z.string().optional().describe('Image file to convert (PNG or JPEG). Omit to convert a frame of the open sprite.'),
    frame: frameRef,
    size: z.union([z.literal(40), z.literal(48), z.literal(56)]).optional().describe('Canvas size. Default picks by how big the creature is.'),
    tone: z.enum(['lighter', 'auto', 'darker', 'darkest']).optional().describe('Overall darkness. darkest suits ghosts and dark-bodied creatures; lighter suits pale ones.'),
    colors: z.union([z.literal('gray'), z.literal('auto'), z.tuple([z.string(), z.string()])]).optional()
      .describe('"gray" (default, original Game Boy), "auto" (two Game Boy Color tints from the source), or [lightHex, darkHex].'),
    mode: z.enum(['new', 'frames', 'layer']).optional().describe('new (default) replaces the sprite; frames inserts after into_frame; layer adds a layer.'),
    into_frame: z.union([z.number().int(), z.string()]).optional(),
    layer_name: z.string().optional(),
  }, async (a) => text(await rpc('gbConvert', a)), { destructiveHint: true });

tool('style_check', 'Score a sprite against the measured Gen 1 or Gen 2 style: colors, canvas, outline, shade balance, interior lines and noise, each with a target and plain advice. Use it after converting and after each manual fix.',
  {
    preset: z.enum(['gen1', 'gen2']).optional(),
    path: z.string().optional().describe('Image file to check. Omit to check a frame of the open sprite.'),
    frame: frameRef,
  }, async (a) => text(await rpc('styleCheck', a)), { readOnlyHint: true });

tool('open_editor', "Open the Pixel Forge editor in the user's default browser.", {}, async () => {
  await ensure();
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', EDITOR_URL]]
    : process.platform === 'darwin' ? ['open', [EDITOR_URL]] : ['xdg-open', [EDITOR_URL]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return text(`Opened ${EDITOR_URL}`);
});

await server.connect(new StdioServerTransport());
log('ready');
