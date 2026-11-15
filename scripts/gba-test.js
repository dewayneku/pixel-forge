// GBA round trip through the MCP tools, like an agent working on a pokeemerald sprite:
// import an indexed 2-frame sprite (gba), recolour one slot in place, export_gba, and check the
// slots, the palette file and the errors. Uses a generated sprite, no game art.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeIndexedPng, decodePng } from '../server/png.js';
import { parseJascPal } from '../web/gba.js';

const dir = path.resolve('projects/test');
fs.mkdirSync(dir, { recursive: true });

// A 16x32 two-frame "sprite" (16x16 each) on an opaque slot-0 background, palette with an unused slot.
const W = 16, H = 32;
const pal = [[152, 160, 208], [248, 248, 248], [200, 48, 48], [48, 48, 200], [0, 0, 0], [96, 200, 96]];
while (pal.length < 16) pal.push([0, 0, 0]);
const idx = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const fy = y % 16;
    if (x < 3 || x > 12 || fy < 3 || fy > 12) continue; // slot 0 border
    idx[y * W + x] = x === 3 || x === 12 || fy === 3 || fy === 12 ? 4 : y < 16 ? 2 : 3;
  }
idx[5 * W + 5] = 1;
fs.writeFileSync(path.join(dir, 'gba-src.png'), encodeIndexedPng(idx, W, H, pal, 4));

const c = new Client({ name: 'gba-test', version: '1.0.0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content.find((x) => x.type === 'text').text);
};
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}\n     ${e.message}`); }
};

await step('gba import: slot 0 transparent, palette in slot order', async () => {
  const r = await call('import_image', { path: 'test/gba-src.png', gba: true, frame_width: 16, frame_height: 16 });
  assert.equal(r.imported_frames, 2);
  assert.match(r.palette_set, /16 slots/);
  const doc = await call('get_document');
  assert.equal(doc.palette.length, 16);
  assert.equal(doc.palette[2], '#c83030');
  const px = await call('get_pixels', { frame: 1, composite: true });
  assert.equal(px.rows[0][0], '.', 'slot 0 pixel should be transparent');
});

await step('unchanged export gives the same indices and palette', async () => {
  const r = await call('file', { action: 'export_gba', path: 'test/gba-same.png' });
  assert.equal(r.layout, 'column');
  assert.equal(r.size, '16x32');
  const back = decodePng(fs.readFileSync(r.image));
  assert.deepEqual([...back.indices], [...idx]);
  assert.deepEqual(back.palette, pal);
  assert.deepEqual(parseJascPal(fs.readFileSync(r.palette_file, 'latin1')), pal);
});

await step('recolour with update_palette keeps every pixel in its slot', async () => {
  for (const frame of [1, 2])
    await call('edit_cel', { action: 'replace_color', from_color: '#3030c8', to_color: '#e8a040', update_palette: true, frame });
  const r = await call('file', { action: 'export_gba', path: 'test/gba-recolour.png', lock: true });
  const back = decodePng(fs.readFileSync(r.image));
  assert.deepEqual([...back.indices], [...idx]);
  assert.deepEqual(back.palette[3], [232, 160, 64]);
  assert.equal(r.new_colors, undefined);
});

await step('a new colour takes a free slot; lock refuses it', async () => {
  await call('set_pixels', { frame: 1, pixels: [{ x: 8, y: 8, color: '#10f0f0' }] });
  const r = await call('file', { action: 'export_gba', path: 'test/gba-new.png', layout: 'frame', frame: 1 });
  assert.equal(r.size, '16x16');
  assert.equal(r.new_colors.length, 1);
  // frame 1 alone doesn't use slot 3 or 5, but those hold real colours: padding slot 6 comes first
  assert.equal(r.new_colors[0].slot, 6);
  assert.equal(r.warnings, undefined);
  await assert.rejects(call('file', { action: 'export_gba', path: 'test/gba-x.png', lock: true }), /not in the palette/);
});

await step('palette from a .pal file, and size errors', async () => {
  const r = await call('file', { action: 'export_gba', path: 'test/gba-pal.png', palette: 'test/gba-same.pal', layout: 'row' });
  assert.equal(r.size, '32x16');
  assert.equal(r.palette_from, 'gba-same.pal');
  const loaded = await call('set_palette', { file: 'test/gba-same.pal' });
  assert.equal(loaded.palette.length, 16);
  await call('canvas', { action: 'new', width: 12, height: 12 });
  await assert.rejects(call('file', { action: 'export_gba', path: 'test/gba-bad.png' }), /multiples of 8/);
});

await c.close();
console.log(failed ? `\n${failed} GBA check(s) failed` : '\nGBA checks passed');
process.exit(failed ? 1 : 0);
