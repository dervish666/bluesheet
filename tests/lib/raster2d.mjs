// An independent second opinion on 2D geometry.
//
// poly2d's boolean and offset are sweep-line and polygon-offset algorithms. If
// the only thing checking them is another analytic calculation written by the
// same hand at the same time, agreement means very little — two implementations
// that share an assumption share its bug. So this rasterises shapes to a bitmap
// and answers the same questions by counting pixels: slow, crude, and wrong in a
// completely different way, which is exactly the point.
//
// Accuracy is O(1/n) in the grid size, so compare with a percentage tolerance
// and use a fine grid where the answer matters.

/** Point-in-shape by even-odd crossing count, ignoring ring orientation. */
export function inShape(shape, x, y) {
  let inside = false;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Even-odd over a list of shapes: what a "shape[]" result actually covers. */
export function inShapes(shapes, x, y) {
  let n = 0;
  for (const s of shapes) if (inShape(s, x, y)) n++;
  return n % 2 === 1 || shapes.some(s => inShape(s, x, y) && s.length === 1) ? shapes.some(s => inShape(s, x, y)) : false;
}

/** Covered by ANY shape in the list — the usual meaning of a boolean result. */
export function covered(shapes, x, y) {
  for (const s of shapes) if (inShape(s, x, y)) return true;
  return false;
}

export function boundsOf(shapes, pad = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const r of s) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!isFinite(x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Area of a shape[] by pixel counting. Grid samples at cell centres. */
export function rasterArea(shapes, n = 600, bounds = null) {
  const b = bounds || boundsOf(shapes);
  const dx = (b.x1 - b.x0) / n, dy = (b.y1 - b.y0) / n;
  let hits = 0;
  for (let j = 0; j < n; j++) {
    const y = b.y0 + (j + 0.5) * dy;
    for (let i = 0; i < n; i++) {
      if (covered(shapes, b.x0 + (i + 0.5) * dx, y)) hits++;
    }
  }
  return hits * dx * dy;
}

/**
 * Compare a computed boolean result against the same operation done by pixel
 * counting. Returns the disagreement as a fraction of the union area, so a
 * result that is right except for a sliver reports a small number and a result
 * with an inverted ring reports a large one.
 */
export function compareBoolean(a, b, op, result, n = 400) {
  const bnds = boundsOf([...a, ...b, ...result]);
  const dx = (bnds.x1 - bnds.x0) / n, dy = (bnds.y1 - bnds.y0) / n;
  let disagree = 0, expected = 0, got = 0, union = 0;
  for (let j = 0; j < n; j++) {
    const y = bnds.y0 + (j + 0.5) * dy;
    for (let i = 0; i < n; i++) {
      const x = bnds.x0 + (i + 0.5) * dx;
      const ia = covered(a, x, y), ib = covered(b, x, y);
      const want = op === 'union' ? (ia || ib)
                 : op === 'difference' ? (ia && !ib)
                 : op === 'intersection' ? (ia && ib)
                 : (ia !== ib);            // xor
      const have = covered(result, x, y);
      if (ia || ib) union++;
      if (want) expected++;
      if (have) got++;
      if (want !== have) disagree++;
    }
  }
  const cell = dx * dy;
  return {
    disagreeFrac: union ? disagree / union : 0,
    expectedArea: expected * cell, gotArea: got * cell,
    disagreeArea: disagree * cell, cellSize: Math.sqrt(cell),
  };
}

/** The same idea for offset: every point of the result should be within delta. */
export function checkOffset(shape, delta, result, n = 300) {
  const b = boundsOf([shape, ...result], Math.abs(delta) + 2);
  const dx = (b.x1 - b.x0) / n, dy = (b.y1 - b.y0) / n;
  let wrongIn = 0, wrongOut = 0, total = 0;
  const tol = Math.max(dx, dy) * 1.5;
  for (let j = 0; j < n; j++) {
    const y = b.y0 + (j + 0.5) * dy;
    for (let i = 0; i < n; i++) {
      const x = b.x0 + (i + 0.5) * dx;
      const d = signedDistance(shape, x, y);          // negative inside
      const have = covered(result, x, y);
      total++;
      if (d < -Math.abs(tol) - Math.max(0, -delta) && !have && d < delta - tol) wrongOut++;
      if (have && d > delta + tol) wrongIn++;
    }
  }
  return { wrongIn, wrongOut, total, tol };
}

/** Signed distance to a shape's boundary; negative inside. */
export function signedDistance(shape, x, y) {
  let best = Infinity;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      best = Math.min(best, segDist(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]));
    }
  }
  return inShape(shape, x, y) ? -best : best;
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
