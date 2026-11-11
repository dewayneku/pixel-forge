// Pixel shape rasterizers, shared by the browser editor and the server.

export function linePoints(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

function box(x0, y0, x1, y1) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function rectPoints(x0, y0, x1, y1, filled) {
  const [l, t, r, b] = box(x0, y0, x1, y1);
  const pts = [];
  for (let y = t; y <= b; y++)
    for (let x = l; x <= r; x++)
      if (filled || x === l || x === r || y === t || y === b) pts.push([x, y]);
  return pts;
}

export function ellipsePoints(x0, y0, x1, y1, filled) {
  const [l, t, r, b] = box(x0, y0, x1, y1);
  const cx = (l + r + 1) / 2, cy = (t + b + 1) / 2;
  const rx = (r - l + 1) / 2, ry = (b - t + 1) / 2;
  const inside = (x, y) => {
    if (x < l || x > r || y < t || y > b) return false;
    const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
    return nx * nx + ny * ny <= 1.0001;
  };
  const pts = [];
  for (let y = t; y <= b; y++)
    for (let x = l; x <= r; x++) {
      if (!inside(x, y)) continue;
      if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) pts.push([x, y]);
    }
  return pts;
}

export function shapePoints(shape, x0, y0, x1, y1, filled = false) {
  if (shape === 'line') return linePoints(x0, y0, x1, y1);
  if (shape === 'rect') return rectPoints(x0, y0, x1, y1, filled);
  if (shape === 'ellipse') return ellipsePoints(x0, y0, x1, y1, filled);
  throw new Error(`Unknown shape "${shape}". Use line, rect or ellipse.`);
}

// Square brush footprint centred on (x, y).
export function brushPoints(x, y, size = 1) {
  const o = Math.floor((size - 1) / 2);
  const pts = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) pts.push([x - o + dx, y - o + dy]);
  return pts;
}
