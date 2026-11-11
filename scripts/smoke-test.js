// Drives the MCP server like an agent would: lists tools, draws, reads back, renders.
// Usage: node scripts/smoke-test.js [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const out = process.argv[2] || os.tmpdir();
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env }, stderr: 'inherit' }));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

await call('canvas', { action: 'new', width: 16, height: 16 });
await call('manage_layers', { action: 'update', layer: 1, name: 'Body' });
const art = [
  '....kkkkkk......',
  '...kggggggk.....',
  '..kggggggggk....',
  '..kgwkggwkgk....',
  '..kgkkggkkgk....',
  '..kggggggggk....',
  '..kggrrrrggk....',
  '...kggggggk.....',
  '....kkkkkk......',
];
console.log('draw_grid:', json(await call('draw_grid', { rows: art, legend: { k: '#1a1a24', g: '#4e9a4e', w: '#ffffff', r: '#d94e4e' }, y: 4 })));
await call('manage_frames', { action: 'duplicate', frame: 1 });
await call('edit_cel', { action: 'shift', frame: 2, dy: -1 });
await call('manage_frames', { action: 'set_duration', frame: 'all', duration: 180 });
await call('draw_shape', { shape: 'line', x0: 0, y0: 15, x1: 15, y1: 15, color: '#8b5a3c', frame: 1 });
console.log('get_pixels:', json(await call('get_pixels', { frame: 2, y: 2, h: 6 })).rows.join('\n           '));
console.log('document:', JSON.stringify(json(await call('get_document'))).slice(0, 300), '...');

const img = await call('view_frame', { frame: 1, scale: 16, grid: true });
fs.writeFileSync(path.join(out, 'smoke-frame1.png'), Buffer.from(img.content[0].data, 'base64'));
const sheet = await call('view_animation');
fs.writeFileSync(path.join(out, 'smoke-sheet.png'), Buffer.from(sheet.content[0].data, 'base64'));
console.log(sheet.content[1].text);

await call('history', { action: 'undo' });
await call('history', { action: 'redo' });
console.log('activity:', json(await call('get_activity', { limit: 5 })).map((e) => `${e.by}: ${e.text}`).join(' | '));

try { await call('fill', { x: 99, y: 0, color: '#fff' }); } catch (e) { console.log('expected error ->', e.message); }
await client.close();
console.log('OK');
