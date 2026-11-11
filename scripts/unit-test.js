// Fast checks that need no server: encoders, image tools and the Game Boy converter.
// Usage: node scripts/unit-test.js
import assert from 'node:assert/strict';
import { encodePng, decodePng } from '../server/png.js';
import { encodeGif } from '../server/gif.js';
import { removeBackground, detectSprites, buildPalette, mapToPalette } from '../web/imagetools.js';
import { convertToGB, styleReport, PRESETS } from '../web/gbstyle.js';
import { ellipsePoints, linePoints } from '../web/shapes.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
};

const blank = (w, h, rgba = [0, 0, 0, 0]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(rgba, i);
  return { width: w, height: h, data: d };
};
const put = (img, x, y, c) => img.data.set(c, (y * img.width + x) * 4);

// A 64x64 "creature": shaded ellipse body, darker outline, a bright accent, on white.
function creature() {
  const img = blank(64, 64, [255, 255, 255, 255]);
  for (const [x, y] of ellipsePoints(8, 6, 55, 60, true)) {
    const shade = 120 + Math.round((x + y) * 0.9);
    put(img, x, y, [40, Math.min(255, shade), Math.min(255, shade + 40), 255]);
  }
  for (const [x, y] of ellipsePoints(8, 6, 55, 60, false)) put(img, x, y, [20, 30, 60, 255]);
  for (const [x, y] of linePoints(20, 20, 40, 24)) put(img, x, y, [250, 160, 40, 255]);
  return img;
}

test('PNG round trip is lossless', () => {
  const img = creature();
  const back = decodePng(encodePng(img.data, img.width, img.height));
  assert.equal(back.width, 64);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
});

test('GIF has a valid header, a loop block and a trailer', () => {
  const a = creature(), b = creature();
  const { buffer } = encodeGif([{ data: a.data, delay: 100 }, { data: b.data, delay: 250 }], 64, 64);
  assert.equal(buffer.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(buffer[buffer.length - 1], 0x3b);
  assert.ok(buffer.includes(Buffer.from('NETSCAPE2.0')), 'loops forever');
});

test('background removal keeps white inside the sprite', () => {
  const img = blank(20, 20, [255, 255, 255, 255]);
  for (const [x, y] of ellipsePoints(3, 3, 16, 16, false)) put(img, x, y, [0, 0, 0, 255]);
  const { image } = removeBackground(img);
  assert.equal(image.data[3], 0, 'outside is transparent');
  assert.equal(image.data[(10 * 20 + 10) * 4 + 3], 255, 'inside white stays');
});

test('sprite detection finds separate sprites in reading order', () => {
  const sheet = blank(60, 20);
  for (const x0 of [2, 22, 42]) for (const [x, y] of ellipsePoints(x0, 2, x0 + 14, 16, true)) put(sheet, x, y, [200, 50, 50, 255]);
  const boxes = detectSprites(sheet);
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((b) => b.x), [2, 22, 42]);
});

test('color reduction hits the requested palette size', () => {
  const img = creature();
  const pal = buildPalette([img.data], 6);
  assert.ok(pal.length <= 6);
  const out = mapToPalette(img, pal).image;
  const colors = new Set();
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3]) colors.add(out.data.slice(i, i + 3).join());
  assert.ok(colors.size <= 6);
});

for (const preset of Object.keys(PRESETS)) {
  test(`Game Boy converter (${preset}) gives 4 colors on a 40/48/56 canvas`, () => {
    const r = convertToGB(creature(), { preset, colors: 'auto' });
    assert.ok([40, 48, 56].includes(r.size));
    const colors = new Set();
    for (let i = 0; i < r.image.data.length; i += 4) if (r.image.data[i + 3]) colors.add(r.image.data.slice(i, i + 3).join());
    assert.ok(colors.size <= 4, `got ${colors.size} colors`);
    const rep = styleReport(r.image, preset);
    assert.ok(rep.metrics.colors.ok && rep.metrics.canvas.ok);
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
