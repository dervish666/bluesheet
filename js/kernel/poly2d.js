// poly2d — the 2D layer of the Bluesheet kernel.
//
// A RING is [[x,y], ...], implicitly closed, with no repeated last point.
// A SHAPE is [outerRing, ...holeRings]: index 0 is the outer boundary wound
// counter-clockwise, the rest are holes wound clockwise. With that convention
// the material is always on the LEFT of the direction of travel, for every ring
// of every shape, which is what makes offsetting uniform (see `offset`).
// Anything that can split geometry (offset, boolean) returns SHAPE[] — an array
// of shapes — because one island can become three.
//
// Millimetres. No DOM, no imports, no dependencies.

export const TAU = Math.PI * 2;

// Tolerances. ABS_EPS is "two coordinates are the same point" at printer scale:
// a nanometre, which is six orders of magnitude below anything an FDM machine
// can express and still far above double-precision noise for 1e3 mm parts.
const ABS_EPS = 1e-9;
const AREA_EPS = 1e-14;

// ---------------------------------------------------------------------------
// Ring fundamentals
// ---------------------------------------------------------------------------

/**
 * Twice-the-signed-area / 2, positive counter-clockwise.
 * Summed as a triangle fan about the first vertex rather than as the textbook
 * shoelace: the coordinates going into each cross product are then differences,
 * so a ring sitting at x = 900 mm does not lose eight bits of the result to
 * cancellation before the sum even starts.
 */
export function signedArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const x0 = ring[0][0], y0 = ring[0][1];
  let s = 0, c = 0;                       // Kahan: rings can run to 10k vertices
  for (let i = 1; i + 1 < n; i++) {
    const ax = ring[i][0] - x0, ay = ring[i][1] - y0;
    const bx = ring[i + 1][0] - x0, by = ring[i + 1][1] - y0;
    const t = ax * by - ay * bx - c;
    const sum = s + t;
    c = (sum - s) - t;
    s = sum;
  }
  return s / 2;
}

export function area(ring) { return Math.abs(signedArea(ring)); }

export function isCCW(ring) { return signedArea(ring) > 0; }

/** Reversed copy. Points are copied, never aliased — callers mutate rings. */
export function reverse(ring) {
  const out = new Array(ring.length);
  for (let i = 0, j = ring.length - 1; j >= 0; i++, j--) out[i] = [ring[j][0], ring[j][1]];
  return out;
}

export function ensureCCW(ring) { return signedArea(ring) < 0 ? reverse(ring) : copyRing(ring); }
export function ensureCW(ring) { return signedArea(ring) > 0 ? reverse(ring) : copyRing(ring); }

function copyRing(ring) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = [ring[i][0], ring[i][1]];
  return out;
}

/**
 * Axis-aligned bounds of a ring, a shape or a shape[] — all three turn up in
 * calling code and telling them apart by hand at every call site was noise.
 */
export function bounds(input) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  const eat = (ring) => {
    for (const p of ring) {
      if (p[0] < mnx) mnx = p[0];
      if (p[0] > mxx) mxx = p[0];
      if (p[1] < mny) mny = p[1];
      if (p[1] > mxy) mxy = p[1];
    }
  };
  for (const shape of asShapes(input)) for (const ring of shape) eat(ring);
  if (mnx > mxx) { mnx = mny = mxx = mxy = 0; }
  return { min: [mnx, mny], max: [mxx, mxy], size: [mxx - mnx, mxy - mny],
           center: [(mnx + mxx) / 2, (mny + mxy) / 2] };
}

/**
 * Area centroid. Degenerate rings (zero area — a line, a point, a duplicate
 * run) have no area centroid, so fall back to the vertex average rather than
 * returning NaN and poisoning whatever placed the part.
 */
export function centroid(ring) {
  const n = ring.length;
  if (!n) return [0, 0];
  if (n < 3) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / n, sy / n];
  }
  const x0 = ring[0][0], y0 = ring[0][1];
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 1; i + 1 < n; i++) {
    const ax = ring[i][0] - x0, ay = ring[i][1] - y0;
    const bx = ring[i + 1][0] - x0, by = ring[i + 1][1] - y0;
    const cross = ax * by - ay * bx;
    a2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(a2) < AREA_EPS) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / n, sy / n];
  }
  return [x0 + cx / (3 * a2), y0 + cy / (3 * a2)];
}

export function perimeter(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return s;
}

/** Squared distance from p to segment ab — used by the on-edge tests. */
function distSqToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * Crossing-number containment. A point exactly on the boundary counts as IN —
 * for a solid modeller that is the useful answer (a vertex shared with a hole
 * wall is material, not void) and it makes pointInShape symmetric at a hole
 * that touches its outer ring.
 */
export function pointInRing(pt, ring, { eps = ABS_EPS } = {}) {
  const n = ring.length;
  if (n < 3) return false;
  const px = pt[0], py = pt[1];
  const e2 = eps * eps;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (distSqToSeg(px, py, xi, yi, xj, yj) <= e2) return true;
    if ((yi > py) !== (yj > py)) {
      const x = (xj - xi) * (py - yi) / (yj - yi) + xi;
      if (px < x) inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and not strictly inside any hole. */
export function pointInShape(pt, shape, opts) {
  const rings = asShape(shape);
  if (!rings.length || !pointInRing(pt, rings[0], opts)) return false;
  for (let i = 1; i < rings.length; i++) {
    // On a hole's own boundary is material, so only a strict interior hit excludes.
    if (pointInRing(pt, rings[i], opts) && !onRingBoundary(pt, rings[i])) return false;
  }
  return true;
}

function onRingBoundary(pt, ring, eps = ABS_EPS) {
  const e2 = eps * eps;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (distSqToSeg(pt[0], pt[1], ring[i][0], ring[i][1], ring[j][0], ring[j][1]) <= e2) return true;
  }
  return false;
}

/** Outer area minus hole areas. Never negative: orientation of the input is ignored. */
export function shapeArea(shape) {
  const rings = asShape(shape);
  if (!rings.length) return 0;
  let a = area(rings[0]);
  for (let i = 1; i < rings.length; i++) a -= area(rings[i]);
  return a;
}

// ---------------------------------------------------------------------------
// Shape normalisation. Rings, shapes and shape arrays are all three-deep
// nestings of numbers that differ only in depth, so detect the depth once here
// and let every public entry point take whichever the caller happens to hold.
// ---------------------------------------------------------------------------

function depthOf(x) {
  let d = 0, cur = x;
  while (Array.isArray(cur)) { d++; cur = cur[0]; }
  return d;                          // 2 = ring, 3 = shape, 4 = shape[]
}

/** ring | shape | shape[] -> shape */
export function asShape(input) {
  if (!Array.isArray(input) || !input.length) return [];
  const d = depthOf(input);
  if (d <= 2) return [input];
  if (d === 3) return input;
  return input[0] || [];
}

/** ring | shape | shape[] -> shape[] */
function asShapes(input) {
  if (!Array.isArray(input) || !input.length) return [];
  const d = depthOf(input);
  if (d <= 2) return [[input]];
  if (d === 3) return [input];
  return input;
}

// ---------------------------------------------------------------------------
// Ring editing
// ---------------------------------------------------------------------------

/**
 * Subdivide every edge longer than maxSegLen. Original vertices are kept, so a
 * resampled ring is still a superset of the input — this exists to give twist
 * and heightfield deformation something to bend, not to redistribute points.
 */
export function resample(ring, maxSegLen) {
  const n = ring.length;
  if (n < 2 || !(maxSegLen > 0)) return copyRing(ring);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out.push([a[0], a[1]]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= maxSegLen) continue;
    const steps = Math.ceil(len / maxSegLen);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Douglas–Peucker on a closed ring, anchored at the two mutually farthest-ish
 * points so the result does not depend on where the caller happened to start
 * the ring. Returns [] when the ring is thinner than eps in every direction —
 * an honest "this collapsed" rather than a two-point ring that later divides
 * by zero.
 */
export function simplify(ring, eps) {
  const n = ring.length;
  if (n < 4 || !(eps > 0)) return copyRing(ring);
  // Anchor 1: the lexicographically lowest point (stable). Anchor 2: the point
  // farthest from it.
  let a = 0;
  for (let i = 1; i < n; i++) {
    if (ring[i][1] < ring[a][1] || (ring[i][1] === ring[a][1] && ring[i][0] < ring[a][0])) a = i;
  }
  let b = a, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (ring[i][0] - ring[a][0]) ** 2 + (ring[i][1] - ring[a][1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  if (a === b) return [];
  const chain = (from, to) => {           // inclusive indices, walking forward
    const pts = [];
    for (let i = from; ; i = (i + 1) % n) { pts.push(ring[i]); if (i === to) break; }
    return pts;
  };
  const c1 = dp(chain(a, b), eps);
  const c2 = dp(chain(b, a), eps);
  const out = c1.slice(0, -1).concat(c2.slice(0, -1)).map(p => [p[0], p[1]]);
  return out.length >= 3 ? out : [];
}

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    let far = -1, fd = -1;
    const ax = pts[i][0], ay = pts[i][1], bx = pts[j][0], by = pts[j][1];
    for (let k = i + 1; k < j; k++) {
      const d = distSqToSeg(pts[k][0], pts[k][1], ax, ay, bx, by);
      if (d > fd) { fd = d; far = k; }
    }
    if (fd > e2) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Scale, then rotate, then translate. A mirroring transform (sx*sy < 0) flips
 * the ring's winding, which would silently turn an outer ring into a hole, so
 * the orientation of the input is restored afterwards.
 */
export function transformRing(ring, xf = {}) {
  const { tx = 0, ty = 0, rot = 0, sx = 1, sy = sx, cx = 0, cy = 0 } = xf;
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    const x = (ring[i][0] - cx) * sx, y = (ring[i][1] - cy) * sy;
    out[i] = [cx + c * x - s * y + tx, cy + s * x + c * y + ty];
  }
  return (sx * sy < 0) ? reverse(out) : out;
}

// ---------------------------------------------------------------------------
// Triangulation — ear clipping with hole bridging.
//
// This is the ear-clipping algorithm as refined by Mapbox's earcut (ISC): a
// doubly linked vertex list, holes eliminated by bridging each hole's leftmost
// vertex to a visible vertex of the outer ring, and three escalating passes
// when a polygon runs out of ears (filter collinear points, cut local
// self-intersections, split on a valid diagonal). Rewritten here in the
// counter-clockwise-positive convention this kernel uses everywhere else —
// earcut works in screen space where the sign of every orientation test is
// inverted, and mixing the two conventions is how you get a cap that is
// triangulated inside out.
//
// Cost is O(n) for the common convex-ish case and O(n²) worst case with no
// z-order hashing; a 2000-vertex ring triangulates in a few milliseconds, which
// is far below the 2 s budget a generator gets, so the hash index is not worth
// the extra sign-sensitive code.
// ---------------------------------------------------------------------------

class ENode {
  constructor(i, x, y) {
    this.i = i;                 // index into the flat coordinate array
    this.x = x; this.y = y;
    this.prev = null; this.next = null;
    this.steiner = false;
  }
}

/** Twice the signed area of triangle a,b,c. Positive = left turn = CCW. */
function tri2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function nodesEqual(a, b) { return a.x === b.x && a.y === b.y; }

/** Inclusive point-in-triangle for a CCW triangle. */
function pointInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0 &&
         (cx - bx) * (py - by) - (cy - by) * (px - bx) >= 0 &&
         (ax - cx) * (py - cy) - (ay - cy) * (px - cx) >= 0;
}

function insertENode(i, x, y, last) {
  const p = new ENode(i, x, y);
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}

function removeENode(p) { p.next.prev = p.prev; p.prev.next = p.next; }

/**
 * Link one ring into a circular list. `wantCCW` says which orientation the
 * linked order must have; the coordinate array itself is never touched, so the
 * indices handed back to the caller still address the points they passed in.
 */
function linkRing(data, start, end, wantCCW) {
  let last = null;
  const ccw = ringSignedArea2(data, start, end) > 0;
  if (ccw === wantCCW) {
    for (let i = start; i < end; i += 2) last = insertENode(i, data[i], data[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertENode(i, data[i], data[i + 1], last);
  }
  if (last && nodesEqual(last, last.next)) { removeENode(last); last = last.next; }
  return last;
}

function ringSignedArea2(data, start, end) {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    sum += (data[j] - data[i]) * (data[j + 1] + data[i + 1]);
  }
  return sum;                       // twice the signed area, positive for CCW
}

/** Drop duplicate and collinear vertices; they can never be ears. */
function filterENodes(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    again = false;
    if (!p.steiner && (nodesEqual(p, p.next) || tri2(p.prev, p, p.next) === 0)) {
      removeENode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

function earcutLinked(ear, triangles, pass, budget) {
  if (!ear) return;
  let stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    if (--budget.n < 0) { fanFallback(ear, triangles, budget); return; }
    prev = ear.prev;
    next = ear.next;
    if (isEar(ear)) {
      triangles.push(prev.i / 2, ear.i / 2, next.i / 2);
      removeENode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      // No ear anywhere in the loop: escalate.
      if (!pass) earcutLinked(filterENodes(ear), triangles, 1, budget);
      else if (pass === 1) earcutLinked(cureLocalIntersections(filterENodes(ear), triangles), triangles, 2, budget);
      else if (pass === 2) splitEarcut(ear, triangles, budget);
      break;
    }
  }
}

/**
 * Last resort when the iteration budget is spent — only reachable on input that
 * is self-intersecting enough to defeat all three passes. A fan from the
 * current vertex terminates, covers the remaining loop, and keeps the caller's
 * index buffer well formed; it can emit slivers outside a self-overlap, which
 * is strictly better than looping forever inside a live UI rebuild.
 */
function fanFallback(node, triangles, budget) {
  const first = node;
  let p = node.next;
  let guard = 0;
  while (p.next !== first && guard++ < 1e6) {
    triangles.push(first.i / 2, p.i / 2, p.next.i / 2);
    p = p.next;
  }
  budget.fallback = true;
}

function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (tri2(a, b, c) <= 0) return false;           // reflex or flat: not an ear
  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
  let p = c.next;
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
        pointInTri(ax, ay, bx, by, cx, cy, p.x, p.y) &&
        tri2(p.prev, p, p.next) <= 0) return false;
    p = p.next;
  }
  return true;
}

function cureLocalIntersections(start, triangles) {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!nodesEqual(a, b) && segsIntersect(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i / 2, p.i / 2, b.i / 2);
      removeENode(p);
      removeENode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterENodes(p);
}

function splitEarcut(start, triangles, budget) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygonNodes(a, b);
        a = filterENodes(a, a.next);
        c = filterENodes(c, c.next);
        earcutLinked(a, triangles, 0, budget);
        earcutLinked(c, triangles, 0, budget);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

/** Bridge a hole into the outer ring: both nodes are duplicated and cross-linked. */
function splitPolygonNodes(a, b) {
  const a2 = new ENode(a.i, a.x, a.y), b2 = new ENode(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

function segsIntersect(p1, q1, p2, q2) {
  const o1 = sgn(tri2(p1, q1, p2)), o2 = sgn(tri2(p1, q1, q2));
  const o3 = sgn(tri2(p2, q2, p1)), o4 = sgn(tri2(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, q1)) return true;
  if (o2 === 0 && onSeg(p1, q2, q1)) return true;
  if (o3 === 0 && onSeg(p2, p1, q2)) return true;
  if (o4 === 0 && onSeg(p2, q1, q2)) return true;
  return false;
}

function onSeg(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
         q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
        segsIntersect(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

/** Is b inside the interior cone at vertex a? */
function locallyInside(a, b) {
  return tri2(a.prev, a, a.next) > 0
    ? tri2(a, b, a.next) <= 0 && tri2(a, a.prev, b) <= 0
    : tri2(a, b, a.prev) > 0 || tri2(a, a.next, b) > 0;
}

function middleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
        (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (tri2(a.prev, a, b.prev) !== 0 || tri2(a, b.prev, b) !== 0)) ||
     (nodesEqual(a, b) && tri2(a.prev, a, a.next) > 0 && tri2(b.prev, b, b.next) > 0));
}

function getLeftmost(start) {
  let p = start, leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

function eliminateHoles(data, holeIndices, outerNode) {
  const queue = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i];
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] : data.length;
    const list = linkRing(data, start, end, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}

function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygonNodes(bridge, hole);
  filterENodes(bridgeReverse, bridgeReverse.next);
  return filterENodes(bridge, bridge.next);
}

/**
 * Cast a ray left from the hole's leftmost vertex, take the outer edge it hits,
 * then walk the outer ring for a vertex inside the (hole, hit, edge endpoint)
 * triangle with a smaller angle — the standard visibility fix without which a
 * hole tucked behind a spike bridges through solid material.
 */
function findHoleBridge(hole, outerNode) {
  let p = outerNode, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;      // hole touches the outer ring exactly here
      }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;

  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) &&
          (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p; tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m, p) {
  return tri2(m.prev, m, p.prev) > 0 && tri2(p.next, m, m.next) > 0;
}

/**
 * triangulate(shape) -> {points, tris}
 * `points` is every input vertex, outer ring first then each hole, in the order
 * given — the index buffer refers to those, so a caller can extrude the same
 * point list into walls and caps without re-matching coordinates. Collinear and
 * duplicate vertices survive in `points` but no triangle references them.
 */
export function triangulate(shapeIn) {
  const shape = asShape(shapeIn).filter(r => r && r.length >= 3);
  if (!shape.length) return { points: [], tris: [] };
  const data = [];
  const points = [];
  const holeIndices = [];
  for (let r = 0; r < shape.length; r++) {
    if (r > 0) holeIndices.push(data.length);
    for (const p of shape[r]) { data.push(p[0], p[1]); points.push([p[0], p[1]]); }
  }
  const outerEnd = holeIndices.length ? holeIndices[0] : data.length;
  let outerNode = linkRing(data, 0, outerEnd, true);
  const tris = [];
  if (!outerNode || outerNode.next === outerNode.prev) return { points, tris };
  if (holeIndices.length) outerNode = eliminateHoles(data, holeIndices, outerNode);
  // Budget: ear clipping visits at most O(n) nodes per removed ear, so 64n²
  // capped at 20M is orders of magnitude of headroom for valid input and still
  // bounded for garbage.
  const n = data.length / 2;
  const budget = { n: Math.min(20e6, 64 * n * n + 1000), fallback: false };
  earcutLinked(outerNode, tris, 0, budget);
  return { points, tris };
}

// ---------------------------------------------------------------------------
// Boolean operations — Martinez–Rueda–Feito sweep line.
//
// "A new algorithm for computing Boolean operations on polygons" (Martinez,
// Rueda, Feito 2009), in the shape the martinez JS library settled on after
// years of degenerate-input bug reports. Chosen over Greiner–Hormann or Vatti
// because it is the only one of the three that survives all four of the things
// real cross-sections do: holes, results that split into several islands,
// edges that lie exactly on top of each other, and a vertex of one polygon
// sitting exactly on an edge of the other.
//
// Every coordinate is snapped to a power-of-two grid (~1e-9 relative to the
// largest coordinate in either operand) before the sweep. The algorithm decides
// "same point" with ===, so two vertices that a caller believes are the same
// but that differ in the last two bits — after a rotate, say — would otherwise
// open a crack the sweep would happily walk through. A power-of-two grid is
// used so that Math.round(v/g)*g is exact in binary and idempotent.
// ---------------------------------------------------------------------------

const OPS = { intersection: 0, union: 1, difference: 2, xor: 3 };
const NORMAL = 0, NON_CONTRIBUTING = 1, SAME_TRANSITION = 2, DIFFERENT_TRANSITION = 3;

function snapGrid(shapes) {
  let m = 0;
  for (const shape of shapes) for (const ring of shape) for (const p of ring) {
    const ax = Math.abs(p[0]), ay = Math.abs(p[1]);
    if (ax > m) m = ax;
    if (ay > m) m = ay;
  }
  return Math.pow(2, Math.ceil(Math.log2(Math.max(m, 1) * 1e-9)));
}

function snapShapes(shapes, g) {
  const out = [];
  for (const shape of shapes) {
    const rings = [];
    for (const ring of shape) {
      if (!ring || ring.length < 3) continue;
      const r = new Array(ring.length);
      for (let i = 0; i < ring.length; i++) r[i] = [Math.round(ring[i][0] / g) * g, Math.round(ring[i][1] / g) * g];
      rings.push(r);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

class SweepEvent {
  constructor(point, left, otherEvent, isSubject, type = NORMAL) {
    this.left = left;
    this.point = point;
    this.otherEvent = otherEvent;
    this.isSubject = isSubject;
    this.type = type;
    this.inOut = false;              // does this edge go inside->outside of its own polygon
    this.otherInOut = false;         // ...of the other polygon, at this sweep position
    this.prevInResult = null;        // closest edge below that made it into the result
    this.resultTransition = 0;       // 0 = not in result, +1 entering, -1 leaving
    this.otherPos = -1;
    this.outputContourId = -1;
    this.contourId = 0;
    this.isExteriorRing = true;
    this.dir = 1;                    // winding fill: +1 left-to-right, -1 right-to-left
    this.windBelow = 0;
    this.windAbove = 0;
  }
  get inResult() { return this.resultTransition !== 0; }
  isBelow(p) {
    const p0 = this.point, p1 = this.otherEvent.point;
    return this.left
      ? (p0[0] - p[0]) * (p1[1] - p[1]) - (p1[0] - p[0]) * (p0[1] - p[1]) > 0
      : (p1[0] - p[0]) * (p0[1] - p[1]) - (p0[0] - p[0]) * (p1[1] - p[1]) > 0;
  }
  isAbove(p) { return !this.isBelow(p); }
  isVertical() { return this.point[0] === this.otherEvent.point[0]; }
}

function sArea(p0, p1, p2) {
  return (p0[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p0[1] - p2[1]);
}

/** Sweep order: left to right, then bottom to top, then right-events first. */
function compareEvents(e1, e2) {
  const p1 = e1.point, p2 = e2.point;
  if (p1[0] > p2[0]) return 1;
  if (p1[0] < p2[0]) return -1;
  if (p1[1] !== p2[1]) return p1[1] > p2[1] ? 1 : -1;
  if (e1.left !== e2.left) return e1.left ? 1 : -1;
  if (sArea(p1, e1.otherEvent.point, e2.otherEvent.point) !== 0) {
    return !e1.isBelow(e2.otherEvent.point) ? 1 : -1;
  }
  return (!e1.isSubject && e2.isSubject) ? 1 : -1;
}

/** Status-line order: which of two segments is lower at the current sweep x. */
function compareSegments(le1, le2) {
  if (le1 === le2) return 0;
  if (sArea(le1.point, le1.otherEvent.point, le2.point) !== 0 ||
      sArea(le1.point, le1.otherEvent.point, le2.otherEvent.point) !== 0) {
    // Not collinear.
    if (le1.point[0] === le2.point[0] && le1.point[1] === le2.point[1]) {
      return le1.isBelow(le2.otherEvent.point) ? -1 : 1;
    }
    if (le1.point[0] === le2.point[0]) return le1.point[1] < le2.point[1] ? -1 : 1;
    if (compareEvents(le1, le2) === 1) return le2.isAbove(le1.point) ? -1 : 1;
    return le1.isBelow(le2.point) ? -1 : 1;
  }
  // Collinear. Same polygon: order by contour then by sweep order. Different
  // polygons: subject first, so the overlap classification below is stable.
  if (le1.isSubject === le2.isSubject) {
    const p1 = le1.point, p2 = le2.point;
    if (p1[0] === p2[0] && p1[1] === p2[1]) {
      const q1 = le1.otherEvent.point, q2 = le2.otherEvent.point;
      if (q1[0] === q2[0] && q1[1] === q2[1]) return 0;
      return le1.contourId > le2.contourId ? 1 : -1;
    }
  } else {
    return le1.isSubject ? -1 : 1;
  }
  return compareEvents(le1, le2) === 1 ? 1 : -1;
}

/** Min-heap keyed by compareEvents. */
class EventQueue {
  constructor() { this.d = []; }
  get length() { return this.d.length; }
  push(v) {
    const d = this.d;
    d.push(v);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compareEvents(d[i], d[p]) < 0) { const t = d[i]; d[i] = d[p]; d[p] = t; i = p; }
      else break;
    }
  }
  pop() {
    const d = this.d, top = d[0], last = d.pop();
    if (d.length) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < d.length && compareEvents(d[l], d[m]) < 0) m = l;
        if (r < d.length && compareEvents(d[r], d[m]) < 0) m = r;
        if (m === i) break;
        const t = d[i]; d[i] = d[m]; d[m] = t; i = m;
      }
    }
    return top;
  }
}

/**
 * The sweep-line status as a sorted array. martinez uses a splay tree; an array
 * with binary-search insert is O(k) per splice against the number of segments
 * currently crossing the sweep line, which for printable cross-sections is
 * tens, not thousands — and it removes a whole tree implementation's worth of
 * places to be subtly wrong.
 */
class StatusLine {
  constructor() { this.a = []; }
  lowerBound(e) {
    let lo = 0, hi = this.a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (compareSegments(this.a[m], e) < 0) lo = m + 1; else hi = m;
    }
    return lo;
  }
  insert(e) { const i = this.lowerBound(e); this.a.splice(i, 0, e); return i; }
  indexOf(e) {
    const i = this.lowerBound(e);
    for (let k = i; k < this.a.length; k++) {
      if (this.a[k] === e) return k;
      if (compareSegments(this.a[k], e) > 0) break;
    }
    for (let k = i - 1; k >= 0; k--) {
      if (this.a[k] === e) return k;
      if (compareSegments(this.a[k], e) < 0) break;
    }
    // The comparator can disagree with the order an event was inserted under if
    // a later subdivision moved a neighbour; identity scan is the safety net.
    return this.a.indexOf(e);
  }
  at(i) { return (i >= 0 && i < this.a.length) ? this.a[i] : null; }
  removeAt(i) { if (i >= 0) this.a.splice(i, 1); }
}

/**
 * Segment intersection returning 0, 1 or 2 points (2 = collinear overlap).
 * Parameterised as P + s*d with s clamped to [0,1] so an endpoint touch comes
 * back as exactly that endpoint rather than a point a femtometre beside it.
 */
function segIntersection(a1, a2, b1, b2) {
  const vax = a2[0] - a1[0], vay = a2[1] - a1[1];
  const vbx = b2[0] - b1[0], vby = b2[1] - b1[1];
  const ex = b1[0] - a1[0], ey = b1[1] - a1[1];
  let kross = vax * vby - vay * vbx;
  const sqrLenA = vax * vax + vay * vay;

  if (kross * kross > 0) {
    const s = (ex * vby - ey * vbx) / kross;
    if (s < 0 || s > 1) return null;
    const t = (ex * vay - ey * vax) / kross;
    if (t < 0 || t > 1) return null;
    if (s === 0 || s === 1) return [[a1[0] + s * vax, a1[1] + s * vay]];
    if (t === 0 || t === 1) return [[b1[0] + t * vbx, b1[1] + t * vby]];
    return [[a1[0] + s * vax, a1[1] + s * vay]];
  }

  kross = ex * vay - ey * vax;
  if (kross * kross > 0) return null;          // parallel, not collinear

  const sa = (ex * vax + ey * vay) / sqrLenA;
  const sb = sa + (vbx * vax + vby * vay) / sqrLenA;
  const smin = Math.min(sa, sb), smax = Math.max(sa, sb);
  if (smin <= 1 && smax >= 0) {
    if (smin === 1) return [[a1[0] + smin * vax, a1[1] + smin * vay]];
    if (smax === 0) return [[a1[0] + smax * vax, a1[1] + smax * vay]];
    const lo = smin > 0 ? smin : 0, hi = smax < 1 ? smax : 1;
    return [[a1[0] + lo * vax, a1[1] + lo * vay], [a1[0] + hi * vax, a1[1] + hi * vay]];
  }
  return null;
}

function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function divideSegment(se, p, queue) {
  const r = new SweepEvent(p, false, se, se.isSubject);
  const l = new SweepEvent(p, true, se.otherEvent, se.isSubject);
  r.contourId = l.contourId = se.contourId;
  r.isExteriorRing = l.isExteriorRing = se.isExteriorRing;
  r.dir = l.dir = se.dir;                 // winding fill: both halves run the same way
  // Rounding can put the new left event *after* the right event it was split
  // from. Swapping the roles keeps the queue's left-before-right invariant,
  // which everything downstream assumes.
  if (compareEvents(l, se.otherEvent) > 0) {
    se.otherEvent.left = true;
    // Relabelling which end is "left" reverses the sense of the traversal, so
    // the winding contribution has to flip with it.
    se.otherEvent.dir = -se.dir;
    l.left = false;
  }
  se.otherEvent.otherEvent = l;
  se.otherEvent = r;
  queue.push(l);
  queue.push(r);
}

/**
 * Returns 0 (nothing to do), 1 (split at a crossing), 2 (the two segments
 * overlap and their flags were reclassified) or 3 (partial overlap, split).
 */
function possibleIntersection(se1, se2, queue) {
  const inter = segIntersection(se1.point, se1.otherEvent.point, se2.point, se2.otherEvent.point);
  const n = inter ? inter.length : 0;
  if (n === 0) return 0;
  if (n === 1 && (samePoint(se1.point, se2.point) ||
                  samePoint(se1.otherEvent.point, se2.otherEvent.point))) return 0;
  // Two edges of the same polygon overlapping is self-intersecting input. The
  // sweep cannot classify it, but it must not throw either: a generator feeding
  // a slightly degenerate profile deserves a best-effort result, not a crash.
  if (n === 2 && se1.isSubject === se2.isSubject) return 0;

  if (n === 1) {
    if (!samePoint(se1.point, inter[0]) && !samePoint(se1.otherEvent.point, inter[0])) {
      divideSegment(se1, inter[0], queue);
    }
    if (!samePoint(se2.point, inter[0]) && !samePoint(se2.otherEvent.point, inter[0])) {
      divideSegment(se2, inter[0], queue);
    }
    return 1;
  }

  // Collinear overlap.
  const events = [];
  let leftCoincide = false, rightCoincide = false;
  if (samePoint(se1.point, se2.point)) leftCoincide = true;
  else if (compareEvents(se1, se2) === 1) events.push(se2, se1);
  else events.push(se1, se2);

  if (samePoint(se1.otherEvent.point, se2.otherEvent.point)) rightCoincide = true;
  else if (compareEvents(se1.otherEvent, se2.otherEvent) === 1) events.push(se2.otherEvent, se1.otherEvent);
  else events.push(se1.otherEvent, se2.otherEvent);

  if ((leftCoincide && rightCoincide) || leftCoincide) {
    se2.type = NON_CONTRIBUTING;
    // Same direction through the overlap or opposite: that distinction is what
    // makes union(a,a) = a but difference(a,a) = nothing.
    se1.type = (se2.inOut === se1.inOut) ? SAME_TRANSITION : DIFFERENT_TRANSITION;
    if (leftCoincide && !rightCoincide) divideSegment(events[1].otherEvent, events[0].point, queue);
    return 2;
  }
  if (rightCoincide) {
    divideSegment(events[0], events[1].point, queue);
    return 3;
  }
  if (events[0] !== events[3].otherEvent) {
    divideSegment(events[0], events[1].point, queue);
    divideSegment(events[1], events[2].point, queue);
    return 3;
  }
  divideSegment(events[0], events[1].point, queue);
  divideSegment(events[3].otherEvent, events[2].point, queue);
  return 3;
}

function inResult(event, op) {
  switch (event.type) {
    case NORMAL:
      switch (op) {
        case OPS.intersection: return !event.otherInOut;
        case OPS.union: return event.otherInOut;
        case OPS.difference:
          return (event.isSubject && event.otherInOut) || (!event.isSubject && !event.otherInOut);
        case OPS.xor: return true;
      }
      return false;
    case SAME_TRANSITION: return op === OPS.intersection || op === OPS.union;
    case DIFFERENT_TRANSITION: return op === OPS.difference;
    default: return false;          // NON_CONTRIBUTING
  }
}

function determineResultTransition(event, op) {
  const thisIn = !event.inOut, thatIn = !event.otherInOut;
  let isIn;
  switch (op) {
    case OPS.intersection: isIn = thisIn && thatIn; break;
    case OPS.union: isIn = thisIn || thatIn; break;
    case OPS.xor: isIn = thisIn !== thatIn; break;
    default: isIn = event.isSubject ? (thisIn && !thatIn) : (thatIn && !thisIn);
  }
  return isIn ? 1 : -1;
}

function computeFields(event, prev, op) {
  if (prev === null) {
    event.inOut = false;
    event.otherInOut = true;
  } else {
    if (event.isSubject === prev.isSubject) {
      event.inOut = !prev.inOut;
      event.otherInOut = prev.otherInOut;
    } else {
      event.inOut = !prev.otherInOut;
      event.otherInOut = prev.isVertical() ? !prev.inOut : prev.inOut;
    }
    event.prevInResult = (!inResult(prev, op) || prev.isVertical()) ? prev.prevInResult : prev;
  }
  event.resultTransition = inResult(event, op) ? determineResultTransition(event, op) : 0;
}

function processRing(ring, isSubject, contourId, queue, bbox, isExteriorRing) {
  for (let i = 0; i < ring.length; i++) {
    const s1 = ring[i], s2 = ring[(i + 1) % ring.length];
    if (s1[0] === s2[0] && s1[1] === s2[1]) continue;      // collapsed edge
    const e1 = new SweepEvent(s1, false, undefined, isSubject);
    const e2 = new SweepEvent(s2, false, e1, isSubject);
    e1.otherEvent = e2;
    e1.contourId = e2.contourId = contourId;
    e1.isExteriorRing = e2.isExteriorRing = isExteriorRing;
    if (compareEvents(e1, e2) > 0) e2.left = true; else e1.left = true;
    if (s1[0] < bbox[0]) bbox[0] = s1[0];
    if (s1[1] < bbox[1]) bbox[1] = s1[1];
    if (s1[0] > bbox[2]) bbox[2] = s1[0];
    if (s1[1] > bbox[3]) bbox[3] = s1[1];
    queue.push(e1);
    queue.push(e2);
  }
}

function fillQueue(subject, clipping, sbbox, cbbox) {
  const queue = new EventQueue();
  let contourId = 0;
  for (const shape of subject) {
    for (let j = 0; j < shape.length; j++) {
      if (j === 0) contourId++;
      processRing(shape[j], true, contourId, queue, sbbox, j === 0);
    }
  }
  for (const shape of clipping) {
    for (let j = 0; j < shape.length; j++) {
      if (j === 0) contourId++;
      processRing(shape[j], false, contourId, queue, cbbox, j === 0);
    }
  }
  return queue;
}

function subdivideSegments(queue, sbbox, cbbox, op) {
  const status = new StatusLine();
  const sorted = [];
  const rightbound = Math.min(sbbox[2], cbbox[2]);
  while (queue.length) {
    let event = queue.pop();
    sorted.push(event);
    // Past the point where the result can still change, stop sweeping. The
    // events already collected are enough to reconstruct the result.
    if ((op === OPS.intersection && event.point[0] > rightbound) ||
        (op === OPS.difference && event.point[0] > sbbox[2])) break;

    if (event.left) {
      const i = status.insert(event);
      const prev = status.at(i - 1), next = status.at(i + 1);
      computeFields(event, prev, op);
      if (next && possibleIntersection(event, next, queue) === 2) {
        computeFields(event, prev, op);
        computeFields(next, event, op);
      }
      if (prev && possibleIntersection(prev, event, queue) === 2) {
        const pi = status.indexOf(prev);
        const prevprev = status.at(pi - 1);
        computeFields(prev, prevprev, op);
        computeFields(event, prev, op);
      }
    } else {
      event = event.otherEvent;                 // work with the left twin
      const i = status.indexOf(event);
      if (i >= 0) {
        const prev = status.at(i - 1), next = status.at(i + 1);
        status.removeAt(i);
        if (prev && next) possibleIntersection(prev, next, queue);
      }
    }
  }
  return sorted;
}

function orderEvents(sortedEvents) {
  const resultEvents = [];
  for (const e of sortedEvents) {
    if ((e.left && e.inResult) || (!e.left && e.otherEvent.inResult)) resultEvents.push(e);
  }
  // Overlapping edges can leave the collected order slightly out; it is nearly
  // sorted already, so a real sort is cheap and total.
  resultEvents.sort(compareEvents);
  for (let i = 0; i < resultEvents.length; i++) resultEvents[i].otherPos = i;
  for (const e of resultEvents) {
    if (!e.left) {
      const t = e.otherPos;
      e.otherPos = e.otherEvent.otherPos;
      e.otherEvent.otherPos = t;
    }
  }
  return resultEvents;
}

/**
 * Pick the edge to leave a result vertex by. Where four result edges meet at
 * one point — two shapes crossing exactly, an xor pinching at a corner — any
 * arbitrary choice traces a contour that crosses itself and comes out with half
 * the area it should have. The face-tracing rule fixes it: from the reverse of
 * the edge we arrived on, sweep clockwise and take the first candidate. That
 * keeps the interior on the left at every vertex, whatever its degree.
 *
 * Events sharing a point are contiguous, since the result is sorted by point
 * first, so the candidate set is one scan outward from here.
 */
function nextPos(pos, resultEvents, processed, origIndex, prevPoint) {
  const p = resultEvents[pos].point;
  let lo = pos, hi = pos;
  while (lo > 0 && samePoint(resultEvents[lo - 1].point, p)) lo--;
  while (hi + 1 < resultEvents.length && samePoint(resultEvents[hi + 1].point, p)) hi++;
  const base = prevPoint ? Math.atan2(p[1] - prevPoint[1], p[0] - prevPoint[0]) + Math.PI : 0;
  let best = -1, bestAng = Infinity;
  for (let j = lo; j <= hi; j++) {
    if (j === pos || processed[j]) continue;
    if (!prevPoint) return j;
    const partner = resultEvents[j].otherPos;
    if (partner < 0 || partner >= resultEvents.length) continue;
    const q = resultEvents[partner].point;
    let ang = base - Math.atan2(q[1] - p[1], q[0] - p[0]);
    // (0, TAU]: doubling straight back down the edge we came in on is a legal
    // move, but only when nothing else is on offer.
    while (ang <= 1e-12) ang += TAU;
    while (ang > TAU) ang -= TAU;
    if (ang < bestAng) { bestAng = ang; best = j; }
  }
  return best >= 0 ? best : origIndex;
}

class Contour {
  constructor() { this.points = []; this.holeIds = []; this.holeOf = null; this.depth = 0; }
  isExterior() { return this.holeOf === null; }
}

/**
 * Decide whether a freshly started contour is an island or a hole by looking at
 * the nearest result edge below it: outside anything -> island; inside an
 * island -> hole of it; inside a hole -> island again, one level deeper.
 */
function initContourFromContext(event, contours, contourId) {
  const c = contours[contourId];
  if (event.prevInResult == null) { c.holeOf = null; c.depth = 0; return; }
  const lower = event.prevInResult;
  const lowerContour = contours[lower.outputContourId];
  if (lower.resultTransition > 0 && lowerContour) {
    if (lowerContour.holeOf != null) {
      contours[lowerContour.holeOf].holeIds.push(contourId);
      c.holeOf = lowerContour.holeOf;
      c.depth = lowerContour.depth;
    } else {
      lowerContour.holeIds.push(contourId);
      c.holeOf = lower.outputContourId;
      c.depth = lowerContour.depth + 1;
    }
  } else {
    c.holeOf = null;
    c.depth = lowerContour ? lowerContour.depth : 0;
  }
}

function connectEdges(sortedEvents) {
  const resultEvents = orderEvents(sortedEvents);
  const processed = new Uint8Array(resultEvents.length);
  const contours = [];

  for (let i = 0; i < resultEvents.length; i++) {
    if (processed[i]) continue;
    const contourId = contours.length;
    const contour = new Contour();
    contours.push(contour);
    initContourFromContext(resultEvents[i], contours, contourId);

    const origPos = i;
    let pos = i;
    contour.points.push(resultEvents[i].point);
    let guard = resultEvents.length + 2;
    while (guard-- > 0) {
      processed[pos] = 1; resultEvents[pos].outputContourId = contourId;
      pos = resultEvents[pos].otherPos;
      if (pos < 0 || pos >= resultEvents.length) break;
      processed[pos] = 1; resultEvents[pos].outputContourId = contourId;
      contour.points.push(resultEvents[pos].point);
      const prevPoint = contour.points.length >= 2 ? contour.points[contour.points.length - 2] : null;
      pos = nextPos(pos, resultEvents, processed, origPos, prevPoint);
      if (pos === origPos || pos < 0 || pos >= resultEvents.length) break;
    }
    // The walk ends back on the start point; a ring in this kernel is implicitly
    // closed, so drop the repeat.
    const pts = contour.points;
    while (pts.length > 1 && samePoint(pts[0], pts[pts.length - 1])) pts.pop();
  }
  return contours;
}

/** Drop rings that carry no area, then force outer CCW / holes CW. */
function normaliseResult(shapes) {
  const out = [];
  for (const shape of shapes) {
    const rings = shape.filter(r => r.length >= 3 && Math.abs(signedArea(r)) > AREA_EPS);
    if (!rings.length) continue;
    const norm = [ensureCCW(rings[0])];
    for (let i = 1; i < rings.length; i++) norm.push(ensureCW(rings[i]));
    out.push(norm);
  }
  return out;
}

/**
 * boolean(a, b, op) -> shape[]
 * `a` and `b` may each be a ring, a shape or a shape[]; op is
 * 'union' | 'difference' | 'intersection' | 'xor'.
 */
export function boolean(a, b, op = 'union') {
  const code = OPS[op];
  if (code === undefined) throw new Error(`boolean: unknown op "${op}" (union|difference|intersection|xor)`);
  const rawA = asShapes(a).filter(s => s.length && s[0] && s[0].length >= 3);
  const rawB = asShapes(b).filter(s => s.length && s[0] && s[0].length >= 3);
  const g = snapGrid(rawA.concat(rawB));
  const subject = snapShapes(rawA, g);
  const clipping = snapShapes(rawB, g);

  if (subject.length === 0 || clipping.length === 0) {
    if (code === OPS.intersection) return [];
    if (code === OPS.difference) return normaliseResult(subject);
    return normaliseResult(subject.length ? subject : clipping);
  }

  const sbbox = [Infinity, Infinity, -Infinity, -Infinity];
  const cbbox = [Infinity, Infinity, -Infinity, -Infinity];
  const queue = fillQueue(subject, clipping, sbbox, cbbox);

  if (sbbox[0] > cbbox[2] || cbbox[0] > sbbox[2] || sbbox[1] > cbbox[3] || cbbox[1] > sbbox[3]) {
    // Disjoint bounding boxes: no sweep can change the answer.
    if (code === OPS.intersection) return [];
    if (code === OPS.difference) return normaliseResult(subject);
    return normaliseResult(subject.concat(clipping));
  }

  const contours = connectEdges(subdivideSegments(queue, sbbox, cbbox, code));
  const shapes = [];
  for (const c of contours) {
    if (!c.isExterior()) continue;
    const poly = [c.points];
    for (const h of c.holeIds) poly.push(contours[h].points);
    shapes.push(poly);
  }
  return normaliseResult(shapes);
}

export function union(a, b) { return boolean(a, b, 'union'); }
export function difference(a, b) { return boolean(a, b, 'difference'); }
export function intersection(a, b) { return boolean(a, b, 'intersection'); }

// ---------------------------------------------------------------------------
// Offset (inset / outset).
//
// The raw offset of a ring — every edge pushed sideways by delta, corners
// joined — is generally self-intersecting: shrink a rectangle far enough and it
// turns inside out, grow a U far enough and the arms merge through each other.
// The material is exactly the region the raw ring winds around at least once,
// so the raw ring is cut into simple loops at its own crossings and each loop is
// kept or dropped on the winding number of the raw ring at a point strictly
// inside it. That rule is what makes an over-large inset return [] instead of an
// inverted ring, which is the failure mode that silently produces a solid where
// a hole should be.
//
// Rings of the same shape are offset independently and recombined with the
// boolean engine, so a hole growing into its outer wall is handled by the sweep
// rather than by a second, shakier arrangement algorithm here.
// ---------------------------------------------------------------------------

/** Drop consecutive duplicate vertices; everything downstream divides by edge length. */
function dedupeRing(ring, eps = ABS_EPS) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps) out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
    else break;
  }
  return out;
}

/** Number of segments for an arc of `sweep` radians at radius r, to sagitta tol. */
function arcSteps(sweep, r, tol) {
  const a = Math.abs(sweep);
  if (!(r > 0) || !(a > 0)) return 1;
  const t = Math.min(Math.max(tol, 1e-6), r);          // tol >= r means one segment
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - t / r)));
  return Math.max(1, Math.min(1024, Math.ceil(a / Math.max(maxStep, 1e-4))));
}

function rawOffsetRing(ring, delta, join, arcTolerance, miterLimit) {
  const pts = dedupeRing(ring);
  const n = pts.length;
  if (n < 3) return [];
  const out = [];
  const r = Math.abs(delta);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    let d1x = cur[0] - prev[0], d1y = cur[1] - prev[1];
    let d2x = next[0] - cur[0], d2y = next[1] - cur[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 === 0 || l2 === 0) continue;
    d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
    // Right-hand normal: with outer rings CCW and holes CW the material is
    // always on the left, so +delta along the right normal grows the solid for
    // every ring of every shape without a special case for holes.
    const n1x = d1y, n1y = -d1x, n2x = d2y, n2y = -d2x;
    const ax = cur[0] + delta * n1x, ay = cur[1] + delta * n1y;
    const bx = cur[0] + delta * n2x, by = cur[1] + delta * n2y;
    const cross = d1x * d2y - d1y * d2x;
    const dot = d1x * d2x + d1y * d2y;

    if (Math.abs(cross) < 1e-14 && dot > 0) { out.push([ax, ay]); continue; }  // straight

    // Corner where the two offset points cross over each other: go out to the
    // ORIGINAL vertex between them rather than chording straight across. The
    // chord would cut through half the shape once |delta| exceeds the local
    // feature size; the detour keeps the self-intersection local to the corner,
    // where the winding fill can resolve it. (Clipper does the same thing.)
    const needsJoin = (Math.abs(cross) < 1e-14) ? true : (cross * delta > 0);
    if (!needsJoin) { out.push([ax, ay], [cur[0], cur[1]], [bx, by]); continue; }

    let a1 = Math.atan2(n1y, n1x), a2 = Math.atan2(n2y, n2x);
    let sweep = a2 - a1;
    if (delta > 0) { while (sweep <= -1e-12) sweep += TAU; if (Math.abs(cross) < 1e-14) sweep = Math.PI; }
    else { while (sweep >= 1e-12) sweep -= TAU; if (Math.abs(cross) < 1e-14) sweep = -Math.PI; }

    if (join === 'round') {
      const steps = arcSteps(sweep, r, arcTolerance);
      for (let k = 0; k <= steps; k++) {
        const t = a1 + sweep * (k / steps);
        out.push([cur[0] + delta * Math.cos(t), cur[1] + delta * Math.sin(t)]);
      }
    } else if (join === 'miter') {
      const denom = 1 + (n1x * n2x + n1y * n2y);
      const ux = (n1x + n2x) / denom, uy = (n1y + n2y) / denom;
      const ratio = Math.hypot(ux, uy);
      if (denom > 1e-12 && ratio <= miterLimit) out.push([cur[0] + delta * ux, cur[1] + delta * uy]);
      else out.push([ax, ay], [bx, by]);          // over the limit: bevel it
    } else if (join === 'square') {
      const L = r * Math.tan(Math.abs(sweep) / 4);
      out.push([ax, ay], [ax + d1x * L, ay + d1y * L], [bx - d2x * L, by - d2y * L], [bx, by]);
    } else if (join === 'bevel') {
      out.push([ax, ay], [bx, by]);
    } else {
      throw new Error(`offset: unknown join "${join}" (round|miter|square|bevel)`);
    }
  }
  return dedupeRing(out);
}

/**
 * Positive-winding fill of a set of directed rings, by sweep line.
 *
 * The raw offset of a ring self-intersects, and the material is the region the
 * raw ring winds around at least once. That is not a boolean of two operands,
 * so it reuses the Martinez event machinery with the parity flags replaced by a
 * running winding number: the status line is walked bottom to top, each segment
 * adds +1 or -1 depending on whether it runs left-to-right, and a segment is a
 * boundary of the result exactly when the winding is positive on one side and
 * not on the other.
 *
 * Doing it this way rather than by cutting the raw ring into simple loops and
 * keeping the ones that look right matters as soon as |delta| approaches the
 * feature size: at that point the raw ring crosses itself hundreds of times and
 * loop-level heuristics produce confetti.
 */
function windingFill(rings) {
  const clean = rings.filter(r => r && r.length >= 3);
  if (!clean.length) return [];
  const g = snapGrid([clean]);
  const snapped = [];
  for (const r of clean) {
    const out = [];
    for (const p of r) out.push([Math.round(p[0] / g) * g, Math.round(p[1] / g) * g]);
    snapped.push(dedupeRing(out, 0));
  }
  const queue = new EventQueue();
  let edges = 0;
  for (let c = 0; c < snapped.length; c++) {
    const ring = snapped[c];
    for (let i = 0; i < ring.length; i++) {
      const s1 = ring[i], s2 = ring[(i + 1) % ring.length];
      if (s1[0] === s2[0] && s1[1] === s2[1]) continue;
      const e1 = new SweepEvent(s1, false, undefined, true);
      const e2 = new SweepEvent(s2, false, e1, true);
      e1.otherEvent = e2;
      e1.contourId = e2.contourId = c + 1;
      if (compareEvents(e1, e2) > 0) { e2.left = true; e2.dir = -1; }
      else { e1.left = true; e1.dir = 1; }
      queue.push(e1); queue.push(e2);
      edges++;
    }
  }
  if (!edges) return [];

  const status = new StatusLine();
  const sorted = [];
  // A split can only shorten segments, so the event count is bounded in
  // practice; the cap is a hang guard for input pathological enough to make the
  // splitting cascade, and it degrades to a partial fill rather than a freeze.
  let budget = 64 * edges * Math.log2(edges + 2) + 4096;
  while (queue.length) {
    if (--budget < 0) break;
    let event = queue.pop();
    sorted.push(event);
    if (event.left) {
      const i = status.insert(event);
      const prev = status.at(i - 1), next = status.at(i + 1);
      computeWinding(event, prev);
      if (next) possibleIntersectionW(event, next, queue);
      if (prev) possibleIntersectionW(prev, event, queue);
    } else {
      event = event.otherEvent;
      const i = status.indexOf(event);
      if (i >= 0) {
        const prev = status.at(i - 1), next = status.at(i + 1);
        status.removeAt(i);
        if (prev && next) possibleIntersectionW(prev, next, queue);
      }
    }
  }
  const contours = connectEdges(sorted);
  const shapes = [];
  for (const c of contours) {
    if (!c.isExterior()) continue;
    const poly = [c.points];
    for (const h of c.holeIds) poly.push(contours[h].points);
    shapes.push(poly);
  }
  return normaliseResult(shapes);
}

function computeWinding(event, prev) {
  const below = prev ? prev.windAbove : 0;
  event.windBelow = below;
  event.windAbove = below + event.dir;
  const insideBelow = below > 0, insideAbove = event.windAbove > 0;
  event.resultTransition = (insideBelow !== insideAbove) ? (insideAbove ? 1 : -1) : 0;
  event.prevInResult = prev ? ((!prev.inResult || prev.isVertical()) ? prev.prevInResult : prev) : null;
}

/**
 * Split-only intersection handling for the winding sweep. Unlike the boolean
 * version this never reclassifies an edge as non-contributing: two coincident
 * edges both stay, and their winding contributions cancel (opposite directions)
 * or stack (same direction), which is the right answer in both cases.
 */
function possibleIntersectionW(se1, se2, queue) {
  const inter = segIntersection(se1.point, se1.otherEvent.point, se2.point, se2.otherEvent.point);
  if (!inter) return 0;
  if (inter.length === 2 &&
      samePoint(se1.point, se2.point) && samePoint(se1.otherEvent.point, se2.otherEvent.point)) return 0;
  if (inter.length === 1 && (samePoint(se1.point, se2.point) ||
      samePoint(se1.otherEvent.point, se2.otherEvent.point))) return 0;
  // Right to left: splitting at the far point first keeps the near point inside
  // the surviving left half.
  for (let k = inter.length - 1; k >= 0; k--) {
    const p = inter[k];
    if (!samePoint(se1.point, p) && !samePoint(se1.otherEvent.point, p)) divideSegment(se1, p, queue);
    if (!samePoint(se2.point, p) && !samePoint(se2.otherEvent.point, p)) divideSegment(se2, p, queue);
  }
  return 1;
}

/**
 * A point strictly inside a ring or shape: the centroid of the largest triangle
 * of its own triangulation. Cheaper tricks (the centroid, an edge midpoint
 * nudged inward) fail on crescents and slivers, which is exactly what an offset
 * of a nearly-collapsed shape produces.
 */
function interiorPoint(input) {
  const { points, tris } = triangulate(input);
  let best = -1, bi = -1;
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (ar > best) { best = ar; bi = t; }
  }
  if (bi < 0 || best <= 0) return null;
  const a = points[tris[bi]], b = points[tris[bi + 1]], c = points[tris[bi + 2]];
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

function minDistToRings(p, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distSqToSeg(p[0], p[1], ring[i][0], ring[i][1], ring[j][0], ring[j][1]);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/**
 * Sanity filter on a region the winding fill produced, straight from the
 * definition of an offset: dilation adds only points within delta of the
 * source, erosion keeps only points of the source at least |delta| clear of its
 * boundary. Tested at the region's deepest interior point, which is the point
 * most likely to survive a legitimate erosion — so a region that fails here is
 * a phantom, not a thin-but-real result. This is what stops an over-shrunk
 * circle coming back as a small disc: the raw ring turns itself inside out,
 * re-closes counter-clockwise, and looks perfectly plausible to winding alone.
 */
function isOffsetMaterial(p, shapes, allRings, delta) {
  let inside = false;
  for (const s of shapes) if (pointInShape(p, s)) { inside = true; break; }
  const d = minDistToRings(p, allRings);
  if (delta > 0) return inside || d <= delta * (1 + 1e-6) + ABS_EPS;
  return inside && d >= -delta * (1 - 1e-6) - ABS_EPS;
}

/**
 * offset(shape, delta, opts) -> shape[]
 * delta > 0 grows the solid, delta < 0 shrinks it. Accepts a ring, a shape or a
 * shape[]; every ring of every input shape goes into one winding field, so two
 * islands that grow into each other come back as one shape, and a hole that
 * grows through its outer wall opens it. An inset that annihilates the geometry
 * returns [].
 */
export function offset(input, delta, { join = 'round', arcTolerance = 0.05, miterLimit = 2 } = {}) {
  if (!isFinite(delta)) throw new Error(`offset: delta must be finite, got ${delta}`);
  // Validated here rather than at the first corner that needs it: a shape whose
  // corners all happen to be reflex would otherwise accept a typo silently.
  if (!['round', 'miter', 'square', 'bevel'].includes(join)) {
    throw new Error(`offset: unknown join "${join}" (round|miter|square|bevel)`);
  }
  if (!(arcTolerance > 0)) throw new Error(`offset: arcTolerance must be positive, got ${arcTolerance}`);
  if (!(miterLimit >= 1)) throw new Error(`offset: miterLimit must be at least 1, got ${miterLimit}`);
  const shapes = asShapes(input)
    .map(s => s.filter(r => r && r.length >= 3 && Math.abs(signedArea(r)) > AREA_EPS))
    .filter(s => s.length);
  if (!shapes.length) return [];
  // Material on the left for every ring, so one sign of delta grows everything.
  const norm = shapes.map(s => [ensureCCW(s[0]), ...s.slice(1).map(ensureCW)]);
  if (Math.abs(delta) < 1e-12) return normaliseResult(norm);

  // Cheap annihilation test before the expensive part. An inscribed disc can
  // never be wider than the ring's own bounding box, so |delta| >= half the
  // shorter side means the erosion is empty — and the raw offset of a ring that
  // is being erased crosses itself O(n²) times, which costs seconds of sweep to
  // resolve into the nothing we already know it is. Erosion applies to the
  // outer ring when delta < 0 and to a hole (the void shrinking) when delta > 0.
  const erodedAway = (ring, d) => d >= Math.min(...bounds([ring]).size) / 2;
  const raw = [];
  for (const s of norm) {
    if (delta < 0 && erodedAway(s[0], -delta)) continue;          // the island is gone
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && delta > 0 && erodedAway(s[i], delta)) continue; // the hole has closed
      const o = rawOffsetRing(s[i], delta, join, arcTolerance, miterLimit);
      if (o.length >= 3) raw.push(o);
    }
  }
  if (!raw.length) return [];

  const allRings = [];
  for (const s of norm) for (const r of s) allRings.push(r);
  const out = [];
  for (const sh of windingFill(raw)) {
    const probe = interiorPoint(sh);
    if (!probe || !isOffsetMaterial(probe, norm, allRings, delta)) continue;
    const kept = [sh[0]];
    for (let i = 1; i < sh.length; i++) {
      const hp = interiorPoint([sh[i]]);
      if (!hp || !isOffsetMaterial(hp, norm, allRings, delta)) kept.push(sh[i]);
    }
    out.push(kept);
  }
  return normaliseResult(out);
}

// ---------------------------------------------------------------------------
// Ring constructors.
//
// Every one returns a single counter-clockwise ring, centred on the origin
// unless a centre is given, with no repeated last point. Sizes are the finished
// outside size — roundRect(20, 10, 3) is 20 × 10 mm with 3 mm corners, not 26 ×
// 16. Arc segment counts are explicit rather than derived from a tolerance so
// that a generator can hand ctx.segFactor straight through and get a mesh whose
// vertex count it can predict.
// ---------------------------------------------------------------------------

function req(cond, msg) { if (!cond) throw new Error(`poly2d: ${msg}`); }
function nseg(segs, min = 3) { return Math.max(min, Math.round(segs)); }

export function rect(w, h, { cx = 0, cy = 0 } = {}) {
  req(w > 0 && h > 0, `rect needs positive w,h (got ${w},${h})`);
  const x = w / 2, y = h / 2;
  return [[cx - x, cy - y], [cx + x, cy - y], [cx + x, cy + y], [cx - x, cy + y]];
}

export function roundRect(w, h, r, { segs = 8, cx = 0, cy = 0 } = {}) {
  req(w > 0 && h > 0, `roundRect needs positive w,h (got ${w},${h})`);
  const rr = Math.min(Math.max(r || 0, 0), Math.min(w, h) / 2);
  if (rr <= 0) return rect(w, h, { cx, cy });
  const n = nseg(segs, 1);
  const ax = w / 2 - rr, ay = h / 2 - rr;
  const corners = [[ax, -ay, -Math.PI / 2], [ax, ay, 0], [-ax, ay, Math.PI / 2], [-ax, -ay, Math.PI]];
  const out = [];
  for (const [px, py, a0] of corners) {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (Math.PI / 2) * (k / n);
      out.push([cx + px + rr * Math.cos(a), cy + py + rr * Math.sin(a)]);
    }
  }
  return dedupeRing(out);
}

export function circle(r, { segs = 64, cx = 0, cy = 0 } = {}) {
  req(r > 0, `circle needs a positive radius (got ${r})`);
  const n = nseg(segs);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    out[i] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  return out;
}

export function ellipse(rx, ry, { segs = 64, cx = 0, cy = 0, rot = 0 } = {}) {
  req(rx > 0 && ry > 0, `ellipse needs positive rx,ry (got ${rx},${ry})`);
  const n = nseg(segs);
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    out[i] = [cx + c * x - s * y, cy + s * x + c * y];
  }
  return out;
}

/** n-gon through the circumradius r — a hex nut is regularPolygon(6, acrossCorners/2). */
export function regularPolygon(n, r, { rot = 0, cx = 0, cy = 0 } = {}) {
  req(n >= 3, `regularPolygon needs at least 3 sides (got ${n})`);
  req(r > 0, `regularPolygon needs a positive radius (got ${r})`);
  const k = Math.round(n);
  const out = new Array(k);
  for (let i = 0; i < k; i++) {
    const a = rot + TAU * i / k;
    out[i] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  return out;
}

export function star(n, rOuter, rInner, { rot = 0, cx = 0, cy = 0 } = {}) {
  req(n >= 2, `star needs at least 2 points (got ${n})`);
  req(rOuter > 0 && rInner > 0, `star needs positive radii (got ${rOuter},${rInner})`);
  const k = Math.round(n);
  const out = new Array(k * 2);
  for (let i = 0; i < k * 2; i++) {
    const a = rot + Math.PI * i / k;
    const r = (i % 2 === 0) ? rOuter : rInner;
    out[i] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  return out;
}

/**
 * Stadium along X. `len` is the OVERALL length including both end caps, so
 * slot(20, 2) is 20 mm long and 4 mm wide — the numbers you would read off a
 * drawing of the finished part, not the centre distance.
 */
export function slot(len, r, { segs = 16, cx = 0, cy = 0, rot = 0 } = {}) {
  req(r > 0, `slot needs a positive radius (got ${r})`);
  req(len >= 2 * r, `slot length ${len} is shorter than its own width ${2 * r}`);
  const half = Math.max(0, len / 2 - r);
  const n = nseg(segs, 2);
  const out = [];
  for (let k = 0; k <= n; k++) {                       // right cap, -90° -> +90°
    const a = -Math.PI / 2 + Math.PI * (k / n);
    out.push([half + r * Math.cos(a), r * Math.sin(a)]);
  }
  for (let k = 0; k <= n; k++) {                       // left cap, +90° -> +270°
    const a = Math.PI / 2 + Math.PI * (k / n);
    out.push([-half + r * Math.cos(a), r * Math.sin(a)]);
  }
  return transformRing(dedupeRing(out), { rot, tx: cx, ty: cy });
}

/**
 * Closed polygon through `points` with every corner rounded. The radius is
 * clamped per corner to what the two adjacent edges can actually give up, so a
 * generous radius on a short edge shortens itself instead of turning the ring
 * inside out.
 */
export function roundedPath(points, r, { segs = 8 } = {}) {
  const pts = dedupeRing(points.map(p => [p[0], p[1]]));
  req(pts.length >= 3, `roundedPath needs at least 3 distinct points (got ${pts.length})`);
  if (!(r > 0)) return pts;
  const n = pts.length, out = [];
  const segsPerQuarter = nseg(segs, 1);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    let d1x = cur[0] - prev[0], d1y = cur[1] - prev[1];
    let d2x = next[0] - cur[0], d2y = next[1] - cur[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
    const cross = d1x * d2y - d1y * d2x;
    const dot = -(d1x * d2x + d1y * d2y);              // cos of the interior angle
    if (Math.abs(cross) < 1e-12) { out.push([cur[0], cur[1]]); continue; }   // straight or a spike
    const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
    const tanHalf = Math.tan(theta / 2);
    const maxByEdges = tanHalf * Math.min(l1, l2) / 2;
    const rr = Math.min(r, maxByEdges);
    if (!(rr > 0)) { out.push([cur[0], cur[1]]); continue; }
    const t = rr / tanHalf;
    const t1 = [cur[0] - d1x * t, cur[1] - d1y * t];
    const t2 = [cur[0] + d2x * t, cur[1] + d2y * t];
    let bx = d2x - d1x, by = d2y - d1y;
    const bl = Math.hypot(bx, by);
    bx /= bl; by /= bl;
    const cd = rr / Math.sin(theta / 2);
    const c = [cur[0] + bx * cd, cur[1] + by * cd];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let sweep = a2 - a1;
    if (cross > 0) { while (sweep < 0) sweep += TAU; } else { while (sweep > 0) sweep -= TAU; }
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) * segsPerQuarter));
    for (let k = 0; k <= steps; k++) {
      const a = a1 + sweep * (k / steps);
      out.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]);
    }
  }
  return dedupeRing(out);
}

/**
 * Gielis superformula. `r` is the radius of the widest point in mm — the raw
 * formula's scale is meaningless on its own, and a generator wants "40 mm
 * across", so the ring is normalised to that after evaluation.
 */
export const SUPERFORMULA_PRESETS = {
  circle:        { m: 0,  n1: 1,    n2: 1,   n3: 1 },
  roundedSquare: { m: 4,  n1: 8,    n2: 8,   n3: 8 },
  star5:         { m: 5,  n1: 0.3,  n2: 0.3, n3: 0.3 },
  flower6:       { m: 6,  n1: 1,    n2: 7,   n3: 8 },
  gem:           { m: 6,  n1: 60,   n2: 60,  n3: 60 },
  petal12:       { m: 12, n1: 15,   n2: 6,   n3: 6 },
  vase:          { m: 8,  n1: 4,    n2: 10,  n3: 10 },
  blob:          { m: 3,  n1: 4.5,  n2: 10,  n3: 10 },
};

export function superformula(opts = {}) {
  const preset = opts.preset ? SUPERFORMULA_PRESETS[opts.preset] : null;
  if (opts.preset) req(preset, `unknown superformula preset "${opts.preset}" (${Object.keys(SUPERFORMULA_PRESETS).join(', ')})`);
  const { a = 1, b = 1, m = 5, n1 = 1, n2 = 1, n3 = 1, r = 10, segs = 180, cx = 0, cy = 0, rot = 0 } =
    { ...(preset || {}), ...opts };
  const m2 = opts.m2 !== undefined ? opts.m2 : m;
  req(a !== 0 && b !== 0, 'superformula needs non-zero a,b');
  req(n1 !== 0, 'superformula needs non-zero n1');
  req(r > 0, `superformula needs a positive radius (got ${r})`);
  const n = nseg(segs);
  const raw = new Array(n);
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const phi = TAU * i / n;
    const t1 = Math.pow(Math.abs(Math.cos(m * phi / 4) / a), n2);
    const t2 = Math.pow(Math.abs(Math.sin(m2 * phi / 4) / b), n3);
    // The sum hits zero for some parameter families (m=0 with odd exponents,
    // spiky presets at the cusp); clamping keeps the radius finite instead of
    // emitting Infinity and poisoning every downstream bbox.
    const sum = Math.max(t1 + t2, 1e-12);
    let rad = Math.pow(sum, -1 / n1);
    if (!isFinite(rad)) rad = 0;
    raw[i] = [phi, rad];
    if (rad > maxR) maxR = rad;
  }
  req(maxR > 0, 'superformula parameters collapse the whole curve to a point');
  const k = r / maxR;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const [phi, rad] = raw[i];
    out[i] = [cx + k * rad * Math.cos(phi + rot), cy + k * rad * Math.sin(phi + rot)];
  }
  return out;
}

/** Rectangle with 45° corner chamfers of leg length c. */
export function chamferRect(w, h, c, { cx = 0, cy = 0 } = {}) {
  req(w > 0 && h > 0, `chamferRect needs positive w,h (got ${w},${h})`);
  const cc = Math.min(Math.max(c || 0, 0), Math.min(w, h) / 2);
  if (cc <= 0) return rect(w, h, { cx, cy });
  const x = w / 2, y = h / 2;
  return dedupeRing([
    [cx - x + cc, cy - y], [cx + x - cc, cy - y],
    [cx + x, cy - y + cc], [cx + x, cy + y - cc],
    [cx + x - cc, cy + y], [cx - x + cc, cy + y],
    [cx - x, cy + y - cc], [cx - x, cy - y + cc],
  ]);
}

/**
 * Rectangle with dog-bone corner relief — the profile you subtract when a
 * square tab has to seat in a printed pocket. An FDM inner corner is never
 * sharp: it carries the nozzle's radius, so a square tab bottoms out on the
 * fillet and stands proud. Each corner gets a circle of radius `r` whose centre
 * sits `r` along the diagonal, so the circle passes exactly through the nominal
 * corner and bites r(√2−1)/√2 past each wall — enough for a mating corner of
 * radius `toolR` to clear. The relief is never smaller than the tool that will
 * cut it, hence r = max(r, toolR).
 */
export function dogboneRect(w, h, r, toolR = r, { cx = 0, cy = 0, segs = 8 } = {}) {
  req(w > 0 && h > 0, `dogboneRect needs positive w,h (got ${w},${h})`);
  const rr = Math.min(Math.max(r || 0, toolR || 0, 0), Math.min(w, h) / (2 * Math.SQRT2));
  if (rr <= 0) return rect(w, h, { cx, cy });
  const n = nseg(segs, 2);
  const x = w / 2, y = h / 2;
  const k = rr / Math.SQRT2;                     // centre offset per axis
  const d = rr * Math.SQRT2;                     // where the arc meets each edge
  const out = [];
  // Corners counter-clockwise from bottom-left. Each arc is the 180° that
  // bulges past the corner: it starts on the wall the ring arrives along, at
  // r√2 from the corner, and ends on the wall it leaves by. Sweeping +180°
  // from 135° (and a quarter turn later for each following corner) is exactly
  // that half — the other half would eat into the rectangle instead.
  const corners = [[-x + k, -y + k], [x - k, -y + k], [x - k, y - k], [-x + k, y - k]];
  for (let ci = 0; ci < 4; ci++) {
    const [ccx, ccy] = corners[ci];
    const aStart = 3 * Math.PI / 4 + ci * Math.PI / 2;
    for (let i = 0; i <= n; i++) {
      const a = aStart + Math.PI * (i / n);
      out.push([cx + ccx + rr * Math.cos(a), cy + ccy + rr * Math.sin(a)]);
    }
  }
  return dedupeRing(out);
}

/**
 * Annular sector: outer radius, inner radius, start and end angle. rInner = 0
 * gives a pie slice. A full turn with rInner > 0 cannot be one simple ring, so
 * it comes back bridged — outer counter-clockwise, inner clockwise, joined by a
 * zero-width seam at `from`. That triangulates and measures correctly (the seam
 * contributes no area); for boolean input, build a proper two-ring shape
 * instead, since the doubled seam edge is exactly the degeneracy a clipper has
 * to guess about.
 */
export function arcRing(rOuter, rInner = 0, from = 0, to = TAU, { segs = 64, cx = 0, cy = 0 } = {}) {
  req(rOuter > 0, `arcRing needs a positive outer radius (got ${rOuter})`);
  req(rInner >= 0 && rInner < rOuter, `arcRing needs 0 <= rInner < rOuter (got ${rInner}, ${rOuter})`);
  let sweep = to - from;
  req(Math.abs(sweep) > 1e-12, 'arcRing sweep is zero');
  if (Math.abs(sweep) > TAU) sweep = Math.sign(sweep) * TAU;
  if (sweep < 0) { from += sweep; sweep = -sweep; }        // always build CCW
  const full = sweep >= TAU - 1e-12;
  const steps = full ? nseg(segs) : Math.max(2, Math.round(nseg(segs) * sweep / TAU));
  const out = [];
  const outerPt = (i, count) => {
    const a = from + sweep * (i / count);
    return [cx + rOuter * Math.cos(a), cy + rOuter * Math.sin(a)];
  };
  const innerPt = (i, count) => {
    const a = from + sweep * (i / count);
    return [cx + rInner * Math.cos(a), cy + rInner * Math.sin(a)];
  };
  if (full) {
    for (let i = 0; i < steps; i++) out.push(outerPt(i, steps));
    if (rInner > 0) {
      out.push(outerPt(0, steps));                          // close the outer loop
      for (let i = steps; i >= 0; i--) out.push(innerPt(i, steps));
    }
    return out;
  }
  for (let i = 0; i <= steps; i++) out.push(outerPt(i, steps));
  if (rInner > 0) { for (let i = steps; i >= 0; i--) out.push(innerPt(i, steps)); }
  else out.push([cx, cy]);
  return dedupeRing(out);
}
