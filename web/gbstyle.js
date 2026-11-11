// Game Boy-era sprite style: a converter that turns a modern sprite into a 4-shade
// 40/48/56 px sprite, and a scorer that measures how close any sprite is to the style.
// Shared by the browser editor and the server. Images are { width, height, data: RGBA }.
//
// The targets below were measured from 151 Gen 1 (Yellow) and 250 Gen 2 (Crystal) sprites
// against 151 Gen 3 (FireRed) sprites. Only the numbers live here, no sprite data.

import { removeBackground, guessBackground } from './imagetools.js';

export const PRESETS = {
  gen1: {
    label: 'Gen 1 (Red/Blue/Yellow)',
    share: { white: 0.13, light: 0.285, dark: 0.276, black: 0.263 }, // of the body
    edgeBlack: 0.63,       // fraction of the silhouette edge that is black
    innerBlack: 0.172,     // black inside the outline, fraction of the body
    singlePx: 0.151,       // single-pixel regions, fraction of the body
    bottomGap: 0,
    // white/black share vs the source's mean brightness (linear fit over 151 Pokemon, R^2 .37/.24)
    fit: { white: [-0.397, 0.00412], black: [0.58, -0.00227] },
    // 5th-95th percentile of real sprites: ~90% of genuine sprites pass each check
    range: {
      edge_black: [0.435, 0.773], white: [0.011, 0.429], light: [0.121, 0.479], dark: [0.139, 0.397],
      black: [0.151, 0.395], inner_black: [0.074, 0.301], single_px: [0.091, 0.207],
    },
  },
  gen2: {
    label: 'Gen 2 (Gold/Silver/Crystal)',
    share: { white: 0.14, light: 0.31, dark: 0.2, black: 0.29 },
    edgeBlack: 0.88,
    innerBlack: 0.16,
    singlePx: 0.11,
    bottomGap: 1,
    fit: { white: [-0.092, 0.00193], black: [0.657, -0.00257] }, // R^2 .15/.32
    range: {
      edge_black: [0.599, 0.97], white: [0.044, 0.337], light: [0.103, 0.558], dark: [0.054, 0.434],
      black: [0.177, 0.448], inner_black: [0.054, 0.318], single_px: [0.061, 0.191],
    },
  },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Shade proportions for one sprite: white and black follow its brightness (darker
// Pokemon get more black), light and dark split the rest in the preset's usual ratio.
// `tone` is the artistic override for what the numbers can't know (e.g. a ghost should be
// mostly black): lighter, auto, darker or darkest.
const TONE = { lighter: [0.08, -0.06], auto: [0, 0], darker: [-0.05, 0.15], darkest: [-0.08, 0.32] };
export function targetShares(P, meanLum, tone = 'auto') {
  const [dw, db] = TONE[tone] || TONE.auto;
  const white = clamp(P.fit.white[0] + P.fit.white[1] * meanLum + dw, 0.03, 0.35);
  const black = clamp(P.fit.black[0] + P.fit.black[1] * meanLum + db, 0.16, 0.75);
  const rest = Math.max(0.2, 1 - white - black);
  const lightRatio = P.share.light / (P.share.light + P.share.dark);
  return { white, light: rest * lightRatio, dark: rest * (1 - lightRatio), black };
}

// Canvas size from how much of its own frame the creature fills (Gen 3: <= 44/64 -> 40, <= 54/64 -> 48).
export function sizeClass(longestSide, frameSize) {
  const rel = longestSide / frameSize;
  return rel <= 0.69 ? 40 : rel <= 0.85 ? 48 : 56;
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const cdist = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
};

const WHITE = 0, LIGHT = 1, DARK = 2, BLACK = 3, NONE = -1;

/**
 * Convert a sprite to the Game Boy style.
 * opts: preset 'gen1'|'gen2', size 40|48|56 (default: by size class), colors 'gray'|'auto'|
 * [lightHex, darkHex], tone 'lighter'|'auto'|'darker'|'darkest', removeBg (default: auto
 * when the border is opaque).
 * Returns { image, size, preset, palette, shades (Int8Array of 0..3 / -1) }.
 */
export function convertToGB(src, opts = {}) {
  const P = PRESETS[opts.preset || 'gen2'];
  if (!P) throw new Error(`Unknown preset "${opts.preset}". Use gen1 or gen2.`);

  // 1. Transparent background.
  let img = src;
  const hasClearBorder = guessBackground(src) === null;
  if (opts.removeBg !== false && !hasClearBorder) img = removeBackground(src, { tolerance: 40 }).image;
  const { width: SW, height: SH, data: S } = img;

  // 2. Silhouette bounds.
  let bx0 = SW, by0 = SH, bx1 = -1, by1 = -1;
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++)
      if (S[(y * SW + x) * 4 + 3] >= 128) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
  if (bx1 < 0) throw new Error('The image is empty.');
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;

  // 3. Canvas and scale: longest side = canvas - 1, centred, resting on the bottom.
  const C = opts.size || sizeClass(Math.max(bw, bh), Math.max(SW, SH));
  const scale = (C - 1) / Math.max(bw, bh);
  const dw = Math.max(1, Math.min(C, Math.round(bw * scale))), dh = Math.max(1, Math.min(C, Math.round(bh * scale)));
  const ox = Math.floor((C - dw) / 2), oy = Math.max(0, C - dh - P.bottomGap);

  // Which source pixels are "line" pixels: the darkest band of this sprite's own colors.
  const lums = [];
  for (let i = 0; i < S.length; i += 4) if (S[i + 3] >= 128) lums.push(lum(S[i], S[i + 1], S[i + 2]));
  const meanLum = lums.reduce((s, v) => s + v, 0) / lums.length;
  const share = opts.share || targetShares(P, meanLum, opts.tone);
  lums.sort((a, b) => a - b);
  const lo = lums[0], hi = lums[lums.length - 1];
  const lineLum = Math.min(lums[Math.floor(lums.length * 0.12)], lo + (hi - lo) * 0.22);

  // 4. Area-sample every destination pixel.
  const N = C * C;
  const cover = new Float32Array(N), line = new Float32Array(N);
  const col = new Float32Array(N * 3);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      const sx0 = bx0 + x / scale, sx1 = bx0 + (x + 1) / scale, sy0 = by0 + y / scale, sy1 = by0 + (y + 1) / scale;
      let area = 0, op = 0, ln = 0, r = 0, g = 0, b = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++)
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          if (xx < 0 || yy < 0 || xx >= SW || yy >= SH) continue;
          const w = (Math.min(xx + 1, sx1) - Math.max(xx, sx0)) * (Math.min(yy + 1, sy1) - Math.max(yy, sy0));
          if (w <= 0) continue;
          area += w;
          const i = (yy * SW + xx) * 4;
          if (S[i + 3] < 128) continue;
          op += w;
          r += S[i] * w; g += S[i + 1] * w; b += S[i + 2] * w;
          if (lum(S[i], S[i + 1], S[i + 2]) <= lineLum) ln += w;
        }
      const k = (oy + y) * C + ox + x;
      cover[k] = area ? op / area : 0;
      line[k] = op ? ln / op : 0;
      if (op) { col[k * 3] = r / op; col[k * 3 + 1] = g / op; col[k * 3 + 2] = b / op; }
    }

  // 5. Silhouette, outline and source lines.
  const sh = new Int8Array(N).fill(NONE);
  const inBody = (k) => sh[k] !== NONE;
  for (let k = 0; k < N; k++) if (cover[k] >= 0.38) sh[k] = WHITE;   // a bit generous: GB bodies are chunky
  const nb4 = (k) => {
    const x = k % C, y = (k / C) | 0, out = [];
    if (x > 0) out.push(k - 1); if (x < C - 1) out.push(k + 1); if (y > 0) out.push(k - C); if (y < C - 1) out.push(k + C);
    return out;
  };
  const isEdge = (k) => {
    const x = k % C, y = (k / C) | 0;
    if (x === 0 || y === 0 || x === C - 1 || y === C - 1) return true;
    return nb4(k).some((q) => !inBody(q));
  };
  const body = [];
  for (let k = 0; k < N; k++) if (inBody(k)) body.push(k);
  const edge = new Set(body.filter(isEdge));
  for (const k of edge) sh[k] = BLACK;
  for (const k of body) if (line[k] >= 0.4) sh[k] = BLACK;

  // 6. More interior lines where neighbouring colors differ strongly (separates limbs and
  //    overlapping parts), drawn on the darker side, until the preset's inner-black share.
  const innerTarget = Math.round(P.innerBlack * body.length);
  const color = (k) => [col[k * 3], col[k * 3 + 1], col[k * 3 + 2]];
  let inner = body.filter((k) => !edge.has(k) && sh[k] === BLACK).length;
  if (inner < innerTarget) {
    const cand = [];
    for (const k of body) {
      if (edge.has(k) || sh[k] === BLACK) continue;
      const c = color(k), lk = lum(...c);
      let best = 0;
      for (const q of nb4(k)) {
        if (!inBody(q) || edge.has(q)) continue;
        const cq = color(q);
        if (lum(...cq) < lk) continue;                 // put the line on the darker side
        best = Math.max(best, cdist(c, cq));
      }
      if (best > 18) cand.push([best, k]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    for (const [, k] of cand) {
      if (inner >= innerTarget) break;
      const blackNb = nb4(k).filter((q) => sh[q] === BLACK).length;
      if (blackNb >= 3) continue;                      // don't grow blobs
      sh[k] = BLACK; inner++;
    }
  }

  // 7. Shade everything else by brightness, in the preset's proportions.
  let black = body.filter((k) => sh[k] === BLACK).length;
  const rest = body.filter((k) => sh[k] !== BLACK).map((k) => [lum(...color(k)), k]).sort((a, b) => a[0] - b[0]);
  const blackTarget = Math.round(share.black * body.length);
  let i0 = 0;
  while (black < blackTarget && i0 < rest.length * 0.85) { sh[rest[i0][1]] = BLACK; black++; i0++; }
  const remain = rest.slice(i0);
  const t = share.white + share.light + share.dark;
  const nDark = Math.round(remain.length * (share.dark / t));
  const nLight = Math.round(remain.length * (share.light / t));
  remain.forEach(([, k], i) => { sh[k] = i < nDark ? DARK : i < nDark + nLight ? LIGHT : WHITE; });

  // 8. Clean up lone pixels (keep black ones: eyes and line ends live there). One gentle
  //    pass: real sprites keep 10-15% single-pixel texture.
  for (let pass = 0; pass < 1; pass++)
    for (const k of body) {
      if (sh[k] === BLACK) continue;
      const ns = nb4(k).filter(inBody);
      if (ns.length < 3 || ns.some((q) => sh[q] === sh[k])) continue;
      const votes = [0, 0, 0, 0];
      for (const q of ns) votes[sh[q]]++;
      votes[BLACK] = 0;
      const best = votes.indexOf(Math.max(...votes));
      if (votes[best] >= 2) sh[k] = best;
    }

  // 9. Lit edges (facing up/left) get a softer outline, down to the preset's black-edge share.
  const edgeArr = [...edge];
  const keepBlack = Math.round(P.edgeBlack * edgeArr.length);
  const lit = edgeArr.map((k) => {
    const x = k % C, y = (k / C) | 0;
    const inward = nb4(k).filter((q) => inBody(q) && !edge.has(q));
    if (!inward.length) return null;
    const bright = Math.min(...inward.map((q) => sh[q]));
    if (bright > LIGHT) return null;                   // only next to white/light areas
    const up = y > 0 && !inBody(k - C), left = x > 0 && !inBody(k - 1);
    return [(up ? 2 : 0) + (left ? 1 : 0) + (bright === WHITE ? 0.5 : 0), k];
  }).filter(Boolean).sort((a, b) => b[0] - a[0]);
  let blackEdges = edgeArr.length;
  for (const [, k] of lit) {
    if (blackEdges <= keepBlack) break;
    sh[k] = DARK; blackEdges--;
  }

  // 10. Colors.
  let pal;
  if (Array.isArray(opts.colors)) {
    pal = [[255, 255, 255], hex(opts.colors[0]), hex(opts.colors[1]), [0, 0, 0]];
  } else if (opts.colors === 'auto') {
    const avg = (s) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const k of body) if (sh[k] === s) { r += col[k * 3]; g += col[k * 3 + 1]; b += col[k * 3 + 2]; n++; }
      return n ? [r / n, g / n, b / n] : null;
    };
    const L = avg(LIGHT) || [176, 176, 176], D = avg(DARK) || [88, 88, 88];
    pal = [[255, 255, 255], gbc(tint(L, 0.82, 1.25)), gbc(tint(D, 0.42, 1.2)), [0, 0, 0]];
  } else {
    pal = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
  }
  const out = new Uint8ClampedArray(N * 4);
  for (let k = 0; k < N; k++) if (sh[k] !== NONE) out.set([...pal[sh[k]], 255], k * 4);
  return { image: { width: C, height: C, data: out }, size: C, preset: opts.preset || 'gen2', palette: pal.map(toHex), shades: sh };
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).replace(/^#?/, '#').slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
// Push a color to a target brightness (0..1) and boost its saturation a little.
function tint(c, target, sat) {
  const m = (c[0] + c[1] + c[2]) / 3;
  let v = c.map((x) => m + (x - m) * sat);
  const l = lum(...v) / 255 || 0.01;
  v = v.map((x) => x * (target / l));
  return v.map((x) => Math.max(0, Math.min(255, x)));
}
const gbc = (c) => c.map((v) => Math.round(v / 8) * 8).map((v) => Math.min(248, v)); // 15-bit color

/**
 * Measure a sprite with the same metrics used on the real Gen 1/2 sprites.
 * Background = transparent pixels plus white touching the edge. Colors are ranked by
 * brightness into 4 shades (exact for 4-color sprites).
 */
export function styleMetrics(img) {
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  const keyOf = (i) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  const colors = new Map();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) colors.set(keyOf(i), lum(d[i], d[i + 1], d[i + 2]));
  const ranked = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  const shadeOf = new Map();
  if (ranked.length === 4) {
    ranked.forEach(([key], i) => shadeOf.set(key, i));   // exactly 4 colors: rank by brightness
  } else {
    // otherwise use brightness bands, so 3-color or many-color sprites still get sensible shades
    for (const [key, l] of ranked) shadeOf.set(key, l > 200 ? WHITE : l > 120 ? LIGHT : l > 45 ? DARK : BLACK);
  }
  const sh = new Int8Array(N).fill(NONE);
  for (let k = 0; k < N; k++) if (d[k * 4 + 3] >= 128) sh[k] = shadeOf.get(keyOf(k * 4));
  // white touching the edge is background (Game Boy sprites sit on white)
  const stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  const bg = new Uint8Array(N);
  while (stack.length) {
    const k = stack.pop();
    if (bg[k] || (sh[k] !== NONE && sh[k] !== WHITE)) continue;
    bg[k] = 1;
    const x = k % W, y = (k / W) | 0;
    if (x > 0) stack.push(k - 1); if (x < W - 1) stack.push(k + 1); if (y > 0) stack.push(k - W); if (y < H - 1) stack.push(k + W);
  }
  const body = [];
  for (let k = 0; k < N; k++) if (!bg[k] && sh[k] !== NONE) body.push(k);
  if (!body.length) throw new Error('Nothing to measure.');
  const inB = (k) => !bg[k] && sh[k] !== NONE;
  const nb = (k) => { const x = k % W, y = (k / W) | 0, o = []; if (x > 0) o.push(k - 1); if (x < W - 1) o.push(k + 1); if (y > 0) o.push(k - W); if (y < H - 1) o.push(k + W); return o; };
  const isEdge = (k) => { const x = k % W, y = (k / W) | 0; return x === 0 || y === 0 || x === W - 1 || y === H - 1 || nb(k).some((q) => !inB(q)); };
  const edge = body.filter(isEdge);
  const count = [0, 0, 0, 0];
  for (const k of body) count[sh[k]]++;
  // same-shade regions
  const seen = new Uint8Array(N);
  let regions = 0, singles = 0;
  for (const k of body) {
    if (seen[k]) continue;
    regions++;
    let n = 0;
    const st = [k]; seen[k] = 1;
    while (st.length) { const q = st.pop(); n++; for (const r of nb(q)) if (!seen[r] && inB(r) && sh[r] === sh[k]) { seen[r] = 1; st.push(r); } }
    if (n === 1) singles++;
  }
  let checker = 0;
  for (const k of body) {
    const x = k % W; if (x >= W - 1 || k + W + 1 >= N) continue;
    const a = k, b = k + 1, c = k + W, e = k + W + 1;
    if (inB(b) && inB(c) && inB(e) && sh[a] === sh[e] && sh[b] === sh[c] && sh[a] !== sh[b]) checker++;
  }
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (const k of body) { const x = k % W, y = (k / W) | 0; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const nB = body.length;
  return {
    size: `${W}x${H}`,
    colors: colors.size,
    fill: nB / N,
    longest_side: Math.max(maxX - minX + 1, maxY - minY + 1) / Math.max(W, H),
    edge_black: edge.filter((k) => sh[k] === BLACK).length / edge.length,
    share: { white: count[0] / nB, light: count[1] / nB, dark: count[2] / nB, black: count[3] / nB },
    inner_black: body.filter((k) => sh[k] === BLACK && !edge.includes(k)).length / nB,
    single_px: singles / nB,
    mean_region: nB / regions,
    dither: checker / nB,
  };
}

/** Compare metrics to a preset; returns per-metric targets, values and plain-language advice. */
export function styleReport(img, preset = 'gen2') {
  const m = styleMetrics(img);
  const P = PRESETS[preset];
  const notes = [];
  const pct = (v) => Math.round(v * 100) + '%';
  // Pass = inside the range ~90% of real sprites fall in; `typical` is the median.
  const check = (name, v, target, tol, hiMsg, loMsg) => {
    const [lo, hi] = P.range[name] || [target - tol, target + tol];
    const ok = v >= lo && v <= hi;
    if (!ok) notes.push(v > hi ? hiMsg : loMsg);
    return { value: pct(v), typical: pct(target), ok_range: `${pct(lo)}-${pct(hi)}`, ok };
  };
  const report = {
    preset: P.label,
    metrics: {
      colors: { value: m.colors, typical: 4, ok: m.colors <= 4 },
      canvas: { value: m.size, typical: '40x40, 48x48 or 56x56', ok: ['40x40', '48x48', '56x56'].includes(m.size) },
      longest_side: check('longest_side', m.longest_side, 0.98, 0.06, 'Body is cut off or touching every edge.', 'Body is small for its canvas: crop tighter or use a smaller canvas.'),
      edge_black: check('edge_black', m.edge_black, P.edgeBlack, 0.12, 'Outline is more solid than this generation; soften lit edges.', 'Outline is too broken: close it with black.'),
      white: check('white', m.share.white, P.share.white, 0.08, 'Too much white: add light shading.', 'Too little white: add highlights.'),
      light: check('light', m.share.light, P.share.light, 0.1, 'Too much light shade.', 'Too little light shade.'),
      dark: check('dark', m.share.dark, P.share.dark, 0.1, 'Too much dark shade: lighten the shadow side.', 'Too little dark shade: add shadow on the side away from the light.'),
      black: check('black', m.share.black, P.share.black, 0.08, 'Too much black: thin lines or turn dark areas into dark gray.', 'Too little black: thicken outlines and add interior lines.'),
      inner_black: check('inner_black', m.inner_black, P.innerBlack, 0.07, 'Too many interior lines.', 'Add interior lines: separate limbs, folds, eyes and mouth with black.'),
      single_px: check('single_px', m.single_px, P.singlePx, 0.06, 'Noisy: merge lone pixels into their neighbours.', 'Very flat: a little single-pixel texture is normal.'),
    },
    notes,
  };
  return report;
}
