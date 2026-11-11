// Image helpers shared by the browser editor and the server, so the import preview
// matches exactly what gets imported. Images are { width, height, data: RGBA bytes }.

const dist = (d, i, c) => Math.max(Math.abs(d[i] - c[0]), Math.abs(d[i + 1] - c[1]), Math.abs(d[i + 2] - c[2]));

// The background is usually the most common color around the image's border.
// Colors are grouped coarsely so JPEG noise still counts as one color.
// Returns null when the border is already mostly transparent.
export function guessBackground(img) {
  const { width: W, height: H, data: d } = img;
  const buckets = new Map();
  let clear = 0, total = 0;
  const add = (x, y) => {
    const i = (y * W + x) * 4;
    total++;
    if (d[i + 3] < 128) { clear++; return; }
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = [0, 0, 0, 0]));
    b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
  };
  for (let x = 0; x < W; x++) { add(x, 0); add(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { add(0, y); add(W - 1, y); }
  let best = null;
  for (const b of buckets.values()) if (!best || b[3] > best[3]) best = b;
  if (!best || clear >= best[3]) return null;
  return [0, 1, 2].map((c) => Math.round(best[c] / best[3]));
}

// Make the background transparent. With edgesOnly (default), only background that
// connects to the image border is removed, so white eyes or highlights inside a sprite survive.
export function removeBackground(img, { color = null, tolerance = 40, edgesOnly = true } = {}) {
  const c = color || guessBackground(img);
  const { width: W, height: H } = img;
  const d = new Uint8ClampedArray(img.data);
  if (!c) return { image: { width: W, height: H, data: d }, color: null, removed: 0 };
  let removed = 0;
  const clearPx = (i) => { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; removed++; };
  if (!edgesOnly) {
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] && dist(d, i, c) <= tolerance) clearPx(i);
  } else {
    const seen = new Uint8Array(W * H);
    const queue = new Int32Array(W * H);
    let head = 0, tail = 0;
    const push = (x, y) => {
      const j = y * W + x;
      if (seen[j]) return;
      const i = j * 4;
      if (d[i + 3] && dist(d, i, c) > tolerance) return;
      seen[j] = 1;
      queue[tail++] = j;
    };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (head < tail) {
      const j = queue[head++];
      if (d[j * 4 + 3]) clearPx(j * 4);
      const x = j % W, y = (j / W) | 0;
      if (x > 0) push(x - 1, y);
      if (x < W - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < H - 1) push(x, y + 1);
    }
  }
  return { image: { width: W, height: H, data: d }, color: c, removed };
}

// Find separate sprites: groups of touching non-transparent pixels (8-way). Parts whose
// boxes overlap, or come within `gap` pixels of each other, are joined into one sprite.
// Groups smaller than minPixels (stray specks) are dropped. Sorted in reading order.
// Sprites that touch each other come out as one wide box. If a box is about twice
// (or more) as wide as the other sprites of its height, cut it at its thinnest columns.
function splitIfWide(img, b, all) {
  const h = b.y1 - b.y0 + 1, w = b.x1 - b.x0 + 1;
  const peers = all.filter((o) => o !== b && Math.abs(o.y1 - o.y0 + 1 - h) <= h * 0.25).map((o) => o.x1 - o.x0 + 1).sort((p, q) => p - q);
  if (peers.length < 3) return [b];
  const typical = peers[peers.length >> 1];
  const parts = Math.round(w / typical);
  if (w < typical * 1.7 || parts < 2) return [b];
  const { width: W, data: d } = img;
  const colCount = (x) => {
    let n = 0;
    for (let y = b.y0; y <= b.y1; y++) if (d[(y * W + x) * 4 + 3]) n++;
    return n;
  };
  const cuts = [];
  for (let k = 1; k < parts; k++) {
    const aim = b.x0 + Math.round((w * k) / parts);
    const r = Math.max(1, Math.round(typical * 0.25));
    let best = aim, bestN = Infinity;
    for (let x = aim - r; x <= aim + r; x++) {
      if (x <= b.x0 || x >= b.x1) continue;
      const n = colCount(x);
      if (n < bestN) { bestN = n; best = x; }
    }
    cuts.push(best);
  }
  const edges = [b.x0, ...cuts, b.x1 + 1];
  const out = [];
  for (let k = 0; k < edges.length - 1; k++) {
    // Shrink each part to the pixels it actually contains.
    let x0 = edges[k], x1 = edges[k + 1] - 1, y0 = b.y1, y1 = b.y0, n = 0;
    for (let y = b.y0; y <= b.y1; y++)
      for (let x = x0; x <= x1; x++)
        if (d[(y * W + x) * 4 + 3]) { n++; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (n) out.push({ x0, y0, x1, y1, n });
  }
  // Sprites that merely touch split into similar-sized pieces. A wide pose (a sword
  // swing, a cape) would split into a body and a thin sliver, so keep that whole.
  const avg = b.n / parts;
  if (out.length !== parts || out.some((o) => o.n < avg * 0.6)) return [b];
  return out;
}

export function detectSprites(img, { gap = 0, minPixels = 12, region = null, splitWide = true } = {}) {
  const { width: W, height: H, data: d } = img;
  const rx0 = Math.max(0, region?.x ?? 0), ry0 = Math.max(0, region?.y ?? 0);
  const rx1 = Math.min(W, region ? rx0 + region.w : W), ry1 = Math.min(H, region ? ry0 + region.h : H);
  const seen = new Uint8Array(W * H);
  const stack = [];
  let boxes = [];
  for (let y = ry0; y < ry1; y++)
    for (let x = rx0; x < rx1; x++) {
      const j = y * W + x;
      if (seen[j] || !d[j * 4 + 3]) continue;
      const b = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      seen[j] = 1;
      stack.push(j);
      while (stack.length) {
        const k = stack.pop();
        const kx = k % W, ky = (k / W) | 0;
        b.n++;
        if (kx < b.x0) b.x0 = kx; if (kx > b.x1) b.x1 = kx;
        if (ky < b.y0) b.y0 = ky; if (ky > b.y1) b.y1 = ky;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = kx + dx, ny = ky + dy;
            if (nx < rx0 || ny < ry0 || nx >= rx1 || ny >= ry1) continue;
            const m = ny * W + nx;
            if (!seen[m] && d[m * 4 + 3]) { seen[m] = 1; stack.push(m); }
          }
      }
      boxes.push(b);
    }

  // Join parts that overlap or sit within `gap` px; repeat until nothing changes.
  const near = (a, b) => a.x0 <= b.x1 + gap + 1 && b.x0 <= a.x1 + gap + 1 && a.y0 <= b.y1 + gap + 1 && b.y0 <= a.y1 + gap + 1;
  const touching = gap > 0 ? near : (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (!touching(a, b)) continue;
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
        a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
        a.n += b.n;
        boxes.splice(j--, 1);
        changed = true;
      }
  }
  boxes = boxes.filter((b) => b.n >= minPixels);
  if (splitWide) boxes = boxes.flatMap((b) => splitIfWide(img, b, boxes));

  // Reading order: rows top to bottom (a sprite joins a row if its middle falls inside it), then left to right.
  boxes.sort((a, b) => a.y0 - b.y0);
  const rows = [];
  for (const b of boxes) {
    const mid = (b.y0 + b.y1) / 2;
    const row = rows.find((r) => mid >= r.y0 && mid <= r.y1);
    if (row) row.items.push(b);
    else rows.push({ y0: b.y0, y1: b.y1, items: [b] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x0 - b.x0))
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, pixels: b.n }));
}

// Cut boxes out into equal-size frames (the size of the largest box). Each sprite is
// placed with its feet on the bottom edge and centred, so animations don't jitter.
export function packBoxes(img, boxes, align = 'bottom') {
  const { width: W, height: H, data: d } = img;
  for (const b of boxes)
    if (b.x < 0 || b.y < 0 || b.w < 1 || b.h < 1 || b.x + b.w > W || b.y + b.h > H)
      throw new Error(`Box ${JSON.stringify(b)} is outside the ${W}x${H} image.`);
  const fw = Math.max(...boxes.map((b) => b.w)), fh = Math.max(...boxes.map((b) => b.h));
  const slices = boxes.map((b) => {
    const out = new Uint8ClampedArray(fw * fh * 4);
    const ox = align === 'top-left' ? 0 : Math.floor((fw - b.w) / 2);
    const oy = align === 'top-left' ? 0 : align === 'center' ? Math.floor((fh - b.h) / 2) : fh - b.h;
    for (let y = 0; y < b.h; y++)
      out.set(d.subarray(((b.y + y) * W + b.x) * 4, ((b.y + y) * W + b.x + b.w) * 4), ((oy + y) * fw + ox) * 4);
    return out;
  });
  return { fw, fh, slices };
}

// ---------------------------------------------------------------- color cleanup
// JPEG compression and resizing smear pixel art into thousands of near-identical shades.
// These functions pull the colors back to a small, clean palette.

// Weighted RGB distance: the eye is most sensitive to green, least to blue.
const cdist = (r, g, b, c) => {
  const dr = r - c[0], dg = g - c[1], db = b - c[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
};

// Find `n` colors that best represent the opaque pixels in one or more RGBA arrays:
// median cut to start, then a few rounds of k-means to settle the colors.
export function buildPalette(datas, n = 16) {
  const hist = new Map();
  for (const d of [].concat(datas))
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  const colors = [...hist].map(([k, c]) => [k >> 16, (k >> 8) & 255, k & 255, c]);
  if (!colors.length) return [];
  if (colors.length <= n) return colors.map((c) => c.slice(0, 3));

  let boxes = [colors];
  while (boxes.length < n) {
    let best = -1, bestScore = -1, bestCh = 0;
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0, count = 0;
        for (const c of bx) { if (c[ch] < lo) lo = c[ch]; if (c[ch] > hi) hi = c[ch]; count += c[3]; }
        const score = (hi - lo) * Math.sqrt(count);
        if (score > bestScore) { bestScore = score; best = i; bestCh = ch; }
      }
    });
    if (best < 0 || bestScore <= 0) break;
    const bx = boxes[best].sort((a, b) => a[bestCh] - b[bestCh]);
    const half = bx.reduce((s, c) => s + c[3], 0) / 2;
    let acc = 0, cut = 1;
    for (let i = 0; i < bx.length - 1; i++) { acc += bx[i][3]; if (acc >= half) { cut = i + 1; break; } }
    boxes.splice(best, 1, bx.slice(0, cut), bx.slice(cut));
  }
  let centers = boxes.map((bx) => {
    let r = 0, g = 0, b = 0, c = 0;
    for (const x of bx) { r += x[0] * x[3]; g += x[1] * x[3]; b += x[2] * x[3]; c += x[3]; }
    return [r / c, g / c, b / c];
  });
  for (let it = 0; it < 8; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const x of colors) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < centers.length; j++) { const dd = cdist(x[0], x[1], x[2], centers[j]); if (dd < bd) { bd = dd; bi = j; } }
      const s = sums[bi];
      s[0] += x[0] * x[3]; s[1] += x[1] * x[3]; s[2] += x[2] * x[3]; s[3] += x[3];
    }
    centers = centers.map((c, j) => (sums[j][3] ? [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]] : c));
  }
  // Round and drop duplicates.
  const seen = new Set();
  return centers.map((c) => c.map(Math.round)).filter((c) => {
    const k = c.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Snap every pixel to the nearest palette color, make alpha fully on or off, and
// optionally remove stray single pixels that touch nothing else.
export function mapToPalette(img, palette, { despeckle = true, alphaThreshold = 128 } = {}) {
  const { width: W, height: H, data: src } = img;
  const d = new Uint8ClampedArray(src.length);
  const cache = new Map();
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < alphaThreshold || !palette.length) continue;
    const k = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    let c = cache.get(k);
    if (!c) {
      let bd = Infinity;
      for (const p of palette) { const dd = cdist(src[i], src[i + 1], src[i + 2], p); if (dd < bd) { bd = dd; c = p; } }
      cache.set(k, c);
    }
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  let specks = 0;
  if (despeckle) {
    const lonely = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!d[(y * W + x) * 4 + 3]) continue;
        let alone = true;
        for (let dy = -1; dy <= 1 && alone; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && d[(ny * W + nx) * 4 + 3]) { alone = false; break; }
          }
        if (alone) lonely.push((y * W + x) * 4);
      }
    for (const i of lonely) d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    specks = lonely.length;
  }
  return { image: { width: W, height: H, data: d }, specks };
}

export function countColors(data) {
  const s = new Set();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) s.add((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);
  return s.size;
}
