// Builds docs/banner.gif: the animated README banner (original pixel art).
// Usage: node scripts/make-banner.js
import fs from 'node:fs';
import { ellipsePoints } from '../web/shapes.js';
import { present } from '../server/png.js';
import { encodeGif } from '../server/gif.js';

const W = 200, H = 48, SCALE = 5, FRAMES = 12;

// 5x7 pixel font, just the letters the title needs.
const FONT = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
};
// Rainbow, one color pair (light top, dark bottom) per letter.
const RAINBOW = [
  [[255, 120, 170], [214, 64, 128]], [[255, 160, 90], [222, 104, 48]], [[255, 214, 92], [222, 160, 40]],
  [[150, 230, 110], [72, 176, 72]], [[96, 220, 200], [40, 160, 160]], [[100, 170, 255], [56, 110, 220]],
  [[170, 130, 255], [118, 80, 220]], [[230, 120, 255], [170, 70, 210]],
];
const PALETTE_BAR = ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
  '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57']
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

function render(t) {
  const img = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, c) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < W && y < H) img.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  };
  // Night-sky gradient in bands, with a dither row between bands.
  const top = [24, 20, 48], bot = [70, 36, 92];
  for (let y = 0; y < H; y++) {
    const band = Math.floor((y / H) * 6) / 5;
    for (let x = 0; x < W; x++) {
      const dither = y % 8 === 7 && (x + y) % 2 === 0 ? 0.08 : 0;
      const k = Math.min(1, band + dither);
      put(x, y, top.map((v, i) => v + (bot[i] - v) * k));
    }
  }
  // Twinkling stars.
  const stars = [[12, 6], [40, 4], [70, 9], [104, 3], [138, 7], [170, 5], [192, 12], [186, 30], [6, 22], [150, 36], [58, 38]];
  stars.forEach(([x, y], i) => {
    const phase = (t + i * 5) % FRAMES;
    const c = phase < 2 ? [255, 255, 255] : phase < 5 ? [190, 180, 255] : [110, 100, 170];
    put(x, y, c);
    if (phase < 2) { put(x - 1, y, [150, 140, 220]); put(x + 1, y, [150, 140, 220]); put(x, y - 1, [150, 140, 220]); put(x, y + 1, [150, 140, 220]); }
  });
  // Ground line.
  for (let x = 0; x < W; x++) put(x, 41, [40, 22, 58]);

  // Title with a wave: outline, shadow, then two-tone letters.
  const text = 'PIXEL FORGE';
  const S = 2, startX = 46, baseY = 9;
  let colorIdx = 0;
  [...text].forEach((ch, i) => {
    if (ch === ' ') return;
    const g = FONT[ch];
    const bob = Math.round(Math.sin(((t / FRAMES) * 2 - i / 5.5) * Math.PI) * 1.5);
    const ox = startX + i * 12, oy = baseY + bob;
    const [light, dark] = RAINBOW[colorIdx++ % RAINBOW.length];
    const cells = [];
    g.forEach((row, r) => [...row].forEach((b, c) => { if (b === '1') cells.push([c, r]); }));
    for (const [c, r] of cells)
      for (let dy = -1; dy <= S; dy++) for (let dx = -1; dx <= S; dx++) put(ox + c * S + dx, oy + r * S + dy, [18, 12, 30]);
    for (const [c, r] of cells) for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) put(ox + c * S + dx + 1, oy + r * S + dy + 2, [18, 12, 30]);
    for (const [c, r] of cells) for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) put(ox + c * S + dx, oy + r * S + dy, r < 3 ? light : dark);
  });

  // Palette swatches under the title.
  PALETTE_BAR.forEach((c, i) => {
    const x = 60 + i * 7;
    for (let y = 31; y < 36; y++) for (let dx = 0; dx < 6; dx++) put(x + dx, y, c);
    for (let dx = -1; dx < 7; dx++) { put(x + dx, 30, [18, 12, 30]); put(x + dx, 36, [18, 12, 30]); }
  });

  // Bouncing slime on the left.
  const poses = [[18, 13, 0], [20, 11, 0], [22, 9, 0], [16, 15, 2], [14, 17, 6], [14, 16, 9], [15, 15, 6], [16, 14, 2], [22, 9, 0], [20, 11, 0], [18, 13, 0], [18, 13, 0]];
  const [sw, sh, lift] = poses[t % poses.length];
  const cx = 22, bottom = 40 - lift, x0 = cx - Math.floor(sw / 2), x1 = x0 + sw - 1, y0 = bottom - sh + 1;
  const shadowW = Math.max(6, 18 - lift * 2);
  for (let x = cx - shadowW / 2; x < cx + shadowW / 2; x++) put(x, 41, [24, 12, 34]);
  for (const [x, y] of ellipsePoints(x0, y0, x1, bottom, true)) put(x, y, [92, 196, 120]);
  for (const [x, y] of ellipsePoints(x0 + 2, y0 + Math.ceil(sh / 2), x1 - 1, bottom, true)) put(x, y, [52, 150, 96]);
  for (const [x, y] of ellipsePoints(x0, y0, x1, bottom, false)) put(x, y, [20, 40, 34]);
  put(x0 + 3, y0 + 2, [210, 255, 214]); put(x0 + 4, y0 + 2, [210, 255, 214]); put(x0 + 3, y0 + 3, [210, 255, 214]);
  const ey = y0 + Math.floor(sh / 2) - 1;
  for (const ex of [cx - 3, cx + 2]) { put(ex, ey, [20, 40, 34]); put(ex + 1, ey, [20, 40, 34]); put(ex, ey + 1, [20, 40, 34]); put(ex + 1, ey + 1, [20, 40, 34]); }

  // A pencil on the right, drawing a sparkle.
  const px = 182, py = 20;
  for (let k = 0; k < 9; k++) {
    put(px + k, py + 8 - k, [255, 205, 117]); put(px + k + 1, py + 8 - k, [239, 125, 87]); put(px + k, py + 9 - k, [177, 62, 83]);
  }
  put(px - 1, py + 9, [244, 244, 244]); put(px - 2, py + 10, [26, 28, 44]);
  const spark = t % 4 < 2 ? [255, 255, 255] : [115, 239, 247];
  put(px - 5, py + 12, spark); put(px - 6, py + 12, spark); put(px - 4, py + 12, spark); put(px - 5, py + 11, spark); put(px - 5, py + 13, spark);
  return img;
}

const frames = Array.from({ length: FRAMES }, (_, t) => ({
  data: present(render(t), W, H, { scale: SCALE }).data,
  delay: 110,
}));
const g = encodeGif(frames, W * SCALE, H * SCALE);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/banner.gif', g.buffer);
console.log(`docs/banner.gif: ${FRAMES} frames, ${W * SCALE}x${H * SCALE}, ${g.colors} colors, ${(g.buffer.length / 1024).toFixed(1)} KB`);
