// Quick demo: connects as an agent and makes a few edits you can watch live.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'demo', version: '1.0.0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env } }));
const call = (name, args) => c.callTool({ name, arguments: args });
await call('manage_layers', { action: 'add', name: 'Hat' });
await call('draw_grid', { layer: 'Hat', y: 1, x: 4, rows: ['..yyyy..', '.yyyyyy.', 'yyyyyyyy'], legend: { y: '#f7e26b' } });
await call('annotate', { x: 4, y: 1, w: 8, h: 3, message: 'Added a hat on its own layer' });
await new Promise((r) => setTimeout(r, 300));
await c.close();
