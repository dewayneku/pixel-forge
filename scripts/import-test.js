// Round-trips a sprite sheet: export it, then import it back in each mode.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const c = new Client({ name: 'import-test', version: '1.0.0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content.find((x) => x.type === 'text').text;
};
const J = async (n, a) => JSON.parse(await call(n, a));
const pix = async (frame) => (await J('get_pixels', { frame, composite: true })).rows.join('\n');

// 1. Make a 3-frame 12x12 animation and remember its pixels.
await call('canvas', { action: 'new', width: 12, height: 12 });
await call('draw_shape', { shape: 'ellipse', x0: 2, y0: 2, x1: 9, y1: 9, color: '#d94e4e', filled: true, frame: 1 });
await call('manage_frames', { action: 'duplicate', frame: 1, count: 2 });
await call('edit_cel', { action: 'shift', frame: 2, dx: 1 });
await call('edit_cel', { action: 'shift', frame: 3, dx: 2, dy: -1 });
await call('set_pixels', { frame: 3, pixels: [{ x: 0, y: 11, color: '#5aa9e680' }] });
const orig = [await pix(1), await pix(2), await pix(3)];

// 2. Export as a 2-column sheet (leaves an empty 4th cell), then import as a new sprite.
console.log('export:', await call('file', { action: 'export_sheet', path: 'test/sheet', columns: 2 }));
let r = await J('import_image', { path: 'test/sheet.png', mode: 'new', frame_width: 12, frame_height: 12, use_palette: true });
console.log('new:', r.imported_frames, 'frames,', r.grid, ',', r.palette_set);
const back = [await pix(1), await pix(2), await pix(3)];
console.log('pixels identical after round trip:', JSON.stringify(orig) === JSON.stringify(back));

// 3. frames mode: insert after frame 1 -> 6 frames, inserted frames are 2..4.
r = await J('import_image', { path: 'test/sheet.png', mode: 'frames', frame: 1, frame_width: 12, frame_height: 12 });
console.log('frames:', r.placed, '| total', r.frames.length, '| frame 2 == original 1:', (await pix(2)) === orig[0]);

// 4. layer mode with offset; whole image as one frame, cropped to canvas.
r = await J('import_image', { path: 'test/sheet.png', mode: 'layer', layer_name: 'Overlay', x: -6, y: 0, frame: 1 });
console.log('layer:', r.placed, '| clipped:', r.clipped_to_canvas);
const doc = await J('get_document');
console.log('layers:', doc.layers_bottom_to_top.map((l) => l.name).join(', '));

// 5. errors
for (const a of [{ path: 'nope.png' }, { path: 'test/sheet.png', frame_width: 99 }, { path: 'test/sheet.json' }])
  await call('import_image', a).catch((e) => console.log('expected error ->', e.message.split('\n')[0]));
await c.close();
