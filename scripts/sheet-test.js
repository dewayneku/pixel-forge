// Analyze a messy sprite sheet, then import picked sprites as an animation.
// Usage: node scripts/sheet-test.js <image> [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [file, out = os.tmpdir()] = process.argv.slice(2);
const c = new Client({ name: 'sheet-test', version: '1.0.0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const textOf = (r) => r.content.find((x) => x.type === 'text').text;

const a = await call('analyze_image', { path: file, remove_background: true });
fs.writeFileSync(path.join(out, 'analyze.png'), Buffer.from(a.content[0].data, 'base64'));
const info = JSON.parse(textOf(a));
console.log('analyze:', info.size, '| background', info.background_removed, '|', info.sprites.length, 'sprites');

const r = JSON.parse(textOf(await call('import_image', { path: file, remove_background: true, pick: [1, 2, 3, 4], duration: 150, layer_name: 'Walk' })));
console.log('import:', r.cut, '|', r.placed, '|', r.frames.length, 'frames');
const sheet = await call('view_animation', { scale: 8 });
fs.writeFileSync(path.join(out, 'imported.png'), Buffer.from(sheet.content[0].data, 'base64'));

// Grid mode still works with background removal; and a JPEG through the grid path.
const g = JSON.parse(textOf(await call('import_image', { path: file, remove_background: true, frame_width: 106, frame_height: 175, mode: 'new' })));
console.log('grid:', g.cut, '|', g.imported_frames, 'frames');
await call('history', { action: 'undo' });
console.log('after undo:', JSON.parse(textOf(await call('get_document'))).frames.length, 'frames');
for (const bad of [{ path: file, pick: [999] }, { path: 'package.json' }])
  await call('import_image', bad).catch((e) => console.log('expected error ->', e.message));
await c.close();
