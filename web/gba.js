// GBA sprite export: turn RGBA pixels into palette indices the way GBA games store them.
// Shared by the editor and the server (no DOM, no Node APIs).
//
// The GBA rules this follows:
// - A 4bpp sprite has 16 palette slots. Slot 0 is always transparent; the colour stored there only
//   shows as the background in editors. 8bpp has 256 slots, 1bpp (footprints) has 2 and no transparency.
// - Colours are 15-bit: each channel keeps its top 5 bits. Two colours that differ only in the
//   low 3 bits are the same colour on the hardware.
// - Sprites that share a palette (normal and shiny, icons, NPCs) must keep the same slot numbers,
//   so the slot order is part of the art, not just the colours.

export const GBA_BACKGROUND = [152, 160, 208]; // the light blue Game Freak uses in slot 0

export const gbaColor = (c) => [c[0] & 0xf8, c[1] & 0xf8, c[2] & 0xf8];
const key = (c) => ((c[0] & 0xf8) << 16) | ((c[1] & 0xf8) << 8) | (c[2] & 0xf8);
const hex2 = (n) => n.toString(16).padStart(2, '0');
export const rgbHex = (c) => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);

function parseHex(s) {
  if (Array.isArray(s)) return s.slice(0, 3);
  let h = String(s).trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}/.test(h)) return null; // "transparent" and friends
  if (h.length === 8 && parseInt(h.slice(6, 8), 16) === 0) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// The slot palette a swatch list stands for, or null if it can't be one.
// 16 (or 2 for 1bpp) swatches = the full palette, slot 0 first (what loading a .pal or importing an
// indexed PNG gives you). Fewer = slots 1..n, with `background` in slot 0.
export function slotsFromSwatches(swatches, { slots = 16, background = GBA_BACKGROUND } = {}) {
  const cols = (swatches || []).map(parseHex);
  if (cols.some((c) => !c)) return null;
  if (cols.length === slots) return cols;
  if (slots > 2 && cols.length <= slots - 1) return [background.slice(0, 3), ...cols];
  return null;
}

// Map an image to palette indices.
// palette: an ordered slot palette (array of [r,g,b], slot 0 first) or null to build one.
// lock: colours that aren't in `palette` are an error instead of taking a free slot.
// Returns { indices, palette, used, added, warnings } or throws with a message a person can act on.
export function toIndexed(img, { palette = null, lock = false, bitDepth = 4, background = GBA_BACKGROUND } = {}) {
  const slots = 1 << bitDepth;
  const opaqueSlots = bitDepth === 1 ? 2 : slots - 1; // 1bpp has no transparent slot
  const first = bitDepth === 1 ? 0 : 1;
  const { width: w, height: h, data } = img;
  const indices = new Uint8Array(w * h);
  const warnings = [];

  // The art's colours, in first-seen order.
  const colours = new Map();
  let semi = 0, transparent = 0;
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const a = data[i + 3];
    if (a < 128) { transparent++; continue; }
    if (a < 255) semi++;
    const k = key([data[i], data[i + 1], data[i + 2]]);
    if (!colours.has(k)) colours.set(k, { c: gbaColor([data[i], data[i + 1], data[i + 2]]), at: [p % w, (p / w) | 0] });
  }
  if (semi) warnings.push(`${semi} semi-transparent pixel(s) were made solid; GBA pixels are on or off.`);
  if (bitDepth === 1 && transparent) throw new Error('1bpp images (footprints) have no transparency: fill every pixel with one of the two colours.');

  let pal;
  if (palette) {
    pal = palette.slice(0, slots).map((c) => c.slice(0, 3));
    while (pal.length < slots) pal.push([0, 0, 0]);
  } else {
    pal = bitDepth === 1 ? [] : [background.slice(0, 3)];
  }
  const lookup = new Map();
  for (let s = first; s < pal.length; s++) if (!lookup.has(key(pal[s]))) lookup.set(key(pal[s]), s);

  // Slots that hold a colour the art no longer uses are free for new colours.
  const added = [];
  const newOnes = [...colours].filter(([k]) => !lookup.has(k));
  if (newOnes.length) {
    if (palette && lock) {
      const [, { c, at }] = newOnes[0];
      throw new Error(`${newOnes.length} colour(s) are not in the palette, e.g. ${rgbHex(c)} at (${at[0]},${at[1]}). ` +
        'Use palette colours only, or export without locking the palette.');
    }
    // A slot is free if the art doesn't use its colour (or another slot already holds that colour).
    // Padding slots (a colour another slot already holds, like the trailing blacks of a .pal) go
    // first; a slot with a colour of its own may still be used by another sprite sharing the palette.
    const free = [];
    if (palette) {
      const padding = [], distinct = [];
      for (let s = first; s < slots; s++) {
        if (lookup.get(key(pal[s])) !== s) padding.push(s);
        else if (!colours.has(key(pal[s]))) distinct.push(s);
      }
      free.push(...padding, ...distinct);
    }
    for (const [k, { c }] of newOnes) {
      let s;
      if (palette) {
        if (!free.length) throw new Error(`The art has ${colours.size} colours; a ${bitDepth}bpp palette holds ${opaqueSlots}${bitDepth === 1 ? '' : ' plus transparent'}.`);
        s = free.shift();
        if (lookup.get(key(pal[s])) === s) {
          warnings.push(`Slot ${s} held ${rgbHex(pal[s])}, which this image doesn't use; it now holds ${rgbHex(c)}. ` +
            'If other sprites or frames share this palette, that colour changes there too.');
          lookup.delete(key(pal[s]));
        }
        pal[s] = c;
      } else {
        if (pal.length >= slots) throw new Error(`The art has ${colours.size} colours; a ${bitDepth}bpp palette holds ${opaqueSlots}${bitDepth === 1 ? '' : ' plus transparent'}.`);
        s = pal.length;
        pal.push(c);
      }
      lookup.set(k, s);
      added.push({ slot: s, color: rgbHex(c) });
    }
  }
  while (pal.length < slots) pal.push([0, 0, 0]);

  const used = new Set();
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const s = data[i + 3] < 128 ? 0 : lookup.get(key([data[i], data[i + 1], data[i + 2]]));
    indices[p] = s;
    used.add(s);
  }
  // Two used slots that the GBA shows as one colour are almost always a mistake.
  const seen = new Map();
  for (const s of [...used].sort((a, b) => a - b)) {
    if (s < first) continue;
    const k = key(pal[s]);
    if (seen.has(k)) warnings.push(`Slots ${seen.get(k)} and ${s} are the same colour on the GBA.`);
    else seen.set(k, s);
  }
  return { indices, palette: pal, used: [...used].sort((a, b) => a - b), added, warnings };
}

// JASC-PAL, the text palette format pokeemerald/pokefirered and most GBA tools use.
export function encodeJascPal(palette) {
  const lines = ['JASC-PAL', '0100', String(palette.length), ...palette.map((c) => `${c[0]} ${c[1]} ${c[2]}`)];
  return lines.join('\r\n') + '\r\n';
}

export function parseJascPal(text) {
  const t = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (t[0] !== 'JASC-PAL') throw new Error('Not a JASC-PAL palette (first line must be "JASC-PAL").');
  const n = parseInt(t[2], 10);
  if (!(n > 0 && n <= 256)) throw new Error('JASC-PAL palette has a bad colour count.');
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = (t[3 + i] || '').split(/\s+/).map(Number);
    if (v.length < 3 || v.some((x) => !(x >= 0 && x <= 255))) throw new Error(`JASC-PAL line ${4 + i} is not "R G B".`);
    out.push(v.slice(0, 3));
  }
  return out;
}
