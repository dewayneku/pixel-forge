// Builds docs/demo.gif: an original bouncing slime, drawn with Pixel Forge's own shape
// and GIF code. Usage: node scripts/make-demo.js
import fs from 'node:fs';
import { ellipsePoints } from '../web/shapes.js';
import { present } from '../server/png.js';
import { encodeGif } from '../server/gif.js';

const W = 32, H = 32, SCALE = 6;
const OUT = [20, 40, 34], BODY = [92, 196, 120], SHADE = [52, 150, 96], SHINE = [210, 255, 214], EYE = [20, 40, 34];

function frame(w, h, lift, eyesClosed = false) {
  const img = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) img.set([...c, 255], (y * W + x) * 4); };
  const cx = 16, bottom = 27 - lift;
  const x0 = cx - Math.floor(w / 2), x1 = x0 + w - 1, y1 = bottom, y0 = bottom - h + 1;
  // shadow on the ground shrinks as the slime rises
  const sw = Math.max(6, 20 - lift * 2);
  for (const [x, y] of ellipsePoints(cx - sw / 2, 28, cx + sw / 2 - 1, 29, true)) put(x, y, [0, 0, 0].map(() => 0)), img[(y * W + x) * 4 + 3] = 70;
  for (const [x, y] of ellipsePoints(x0, y0, x1, y1, true)) put(x, y, BODY);
  for (const [x, y] of ellipsePoints(x0 + 2, y0 + Math.ceil(h / 2), x1 - 1, y1, true)) put(x, y, SHADE);
  for (const [x, y] of ellipsePoints(x0, y0, x1, y1, false)) put(x, y, OUT);
  put(x0 + 3, y0 + 2, SHINE); put(x0 + 4, y0 + 2, SHINE); put(x0 + 3, y0 + 3, SHINE);
  const ey = y0 + Math.floor(h / 2) - 1;
  for (const ex of [cx - 3, cx + 2]) {
    if (eyesClosed) { put(ex, ey + 1, EYE); put(ex + 1, ey + 1, EYE); }
    else { put(ex, ey, EYE); put(ex, ey + 1, EYE); put(ex + 1, ey, EYE); put(ex + 1, ey + 1, EYE); put(ex, ey, SHINE); }
  }
  return img;
}

const poses = [
  [18, 13, 0, 220], [20, 11, 0, 90], [22, 9, 0, 120],   // settle, squash down
  [16, 15, 2, 70], [14, 17, 6, 70], [14, 16, 9, 140],   // stretch and jump
  [15, 15, 6, 70], [16, 14, 2, 70], [22, 9, 0, 110],    // fall and land
  [20, 11, 0, 90], [18, 13, 0, 900, true], [18, 13, 0, 120],   // settle, blink
];
const frames = poses.map(([w, h, lift, delay, blink]) => ({
  data: present(frame(w, h, lift, blink), W, H, { scale: SCALE, background: [38, 38, 50, 255] }).data,
  delay,
}));
const g = encodeGif(frames, W * SCALE, H * SCALE);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/demo.gif', g.buffer);
console.log(`docs/demo.gif: ${frames.length} frames, ${W * SCALE}x${H * SCALE}, ${(g.buffer.length / 1024).toFixed(1)} KB`);
