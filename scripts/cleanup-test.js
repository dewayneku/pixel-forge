// Color cleanup: on import, and on a sprite already in the editor.
// Usage: node scripts/cleanup-test.js <image> [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [file, out = os.tmpdir()] = process.argv.slice(2);
const c = new Client({ name: 'cleanup-test', version: '1.0.0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const J = async (n, a) => JSON.parse((await call(n, a)).content.find((x) => x.type === 'text').text);
const colorsIn = async () => {
  const d = await J('get_document');
  const seen = new Set();
  for (let f = 1; f <= d.frames.length; f++) {
    const p = await J('get_pixels', { frame: f, composite: true });
    for (const row of p.rows) for (const ch of row) if (ch !== '.') seen.add(p.legend[ch]);
  }
  return seen.size;
};

// 1. Import the walk cycle with cleanup.
const r = await J('import_image', { path: file, remove_background: true, pick: [1, 2, 3, 4], reduce_colors: 24, duration: 150 });
console.log('import with cleanup:', JSON.stringify(r.color_cleanup), '| palette', r.palette_set, '| colors now', await colorsIn());
const img = await call('view_animation', { scale: 8 });
fs.writeFileSync(path.join(out, 'cleanup-import.png'), Buffer.from(img.content[0].data, 'base64'));

// 2. Import raw, then clean up afterwards with the reduce_colors tool, then undo it.
await J('import_image', { path: file, remove_background: true, pick: [1, 2, 3, 4] });
const raw = await colorsIn();
const red = await J('reduce_colors', { colors: 12 });
console.log('reduce_colors:', raw, '->', red.colors_after, '| stray removed', red.stray_pixels_removed, '| colors now', await colorsIn(), '| palette size', (await J('get_document')).palette.length);
await call('history', { action: 'undo' });
console.log('after undo:', await colorsIn(), 'colors');

// 3. Snap to the current (default 16-color) palette, scoped to one frame.
await call('set_palette', { mode: 'reset' });
const snap = await J('reduce_colors', { snap_to_palette: true, scope: 'frame', frame: 1 });
console.log('snap frame 1 to palette:', snap.colors_before, '->', snap.colors_after);
await c.close();
