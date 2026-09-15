// js/kernel/csg.js — mesh booleans (union / subtract / intersect) over a BSP tree.
//
// The lineage is the classic csg.js BSP formulation, but this is a rewrite, not a
// port, because the places that algorithm falls over are exactly the places Bluesheet
// leans on it:
//
//  1. COPLANAR FACES. A pocket cut into a plate has its rim exactly flush with the
//     plate's top face. The naive handling either loses that face or keeps both
//     copies (an instant non-manifold). Coplanarity is decided here by the sign of
//     the dot product between the polygon's own normal and the splitting plane's
//     normal — same-facing goes front, opposite-facing goes back — and each
//     operation below includes the extra invert/clip pass that deletes the
//     *duplicate* of a shared face rather than both copies or neither.
//
//  2. EPSILON. A single hard-coded 1e-5 is simultaneously too coarse for a 2 mm
//     thread and too fine for a 180 mm plate. Everything here is relative to the
//     largest absolute coordinate present in the operands (see `epsFor`).
//
//  3. TRIANGLE EXPLOSION. Splitting triangles multiplies them; splitting n-gons
//     does not. Polygons stay n-gons all the way through the tree and are
//     fan-triangulated exactly once, at the end. The tree is built with a
//     splitting-plane heuristic instead of "whatever polygon came first", which is
//     what turns a BSP into a linked list on axis-aligned input. And every clip
//     starts with an AABB reject, without which a 6 mm cutter shreds a 180 mm
//     plate with its own infinite side planes — measured at 226k triangles for
//     twenty holes before that reject went in, 22k after.
//
//  4. T-JUNCTIONS, which csg.js does not attempt at all. Clipping can leave a
//     vertex sitting in the middle of a neighbour's edge — it happens whenever two
//     adjacent faces get routed into different subtrees, which coplanar faces
//     reliably cause. That reads as three boundary edges to any watertightness
//     check even though the surface has no hole in it. `repairTJunctions` finds
//     them and splits the offending triangle so the seam closes.
//
// Determinism: no Math.random, anywhere, including plane selection. Candidates are
// picked by a fixed stride and ties break on the lower index, so the same two
// meshes always produce a byte-identical STL.
//
// Node-safe: imports only mesh.js, touches no DOM.

import { Mesh } from './mesh.js';

// Polygon classification against a plane. FRONT|BACK === SPANNING is load-bearing.
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
const UNKNOWN = -1;

// ---- epsilon policy --------------------------------------------------------
//
// `scale` is the largest absolute coordinate in either operand — not the bbox
// diagonal, because a 2 mm feature sitting at x = 150 carries the rounding error
// of 150, not of 2. Double precision gives ~1e-16 relative, split points are
// re-projected onto their plane so error does not compound across levels, and
// measured drift over a 30-deep tree stays well under 1e-13 * scale.
//
//   PLANE_REL 1e-9  — "on the plane", for classification. 1e-7 mm at plate scale:
//                     ~1e7x above float noise, ~1e5x below anything a 0.4 mm
//                     nozzle can express. Faces a generator *meant* to be flush
//                     come out bit-identical anyway; this only has to absorb the
//                     arithmetic of the split itself.
//   WELD_REL  1e-7  — 100x PLANE_REL, and that ordering is required, not
//                     cosmetic: a vertex within PLANE_REL of a plane is treated
//                     as lying *on* it, so the weld tolerance has to be at least
//                     that wide, or two points the splitter already considered
//                     identical survive into the result as a crack.
//   area            — WELD_REL^2: a triangle thinner than the weld tolerance in
//                     both directions is noise by construction.
//
// The 1 mm floor keeps sub-millimetre models from getting an absolute epsilon so
// small it stops absorbing anything. Bluesheet is a millimetre tool; even at 0.1 mm
// overall size the relative tolerance is still 1e-8 of the model, which is plenty.
const PLANE_REL = 1e-9;
const WELD_REL = 1e-7;

function operandScale(...meshes) {
  let s = 0;
  for (const m of meshes) {
    if (!m || !m.positions) continue;
    const p = m.positions;
    for (let i = 0; i < p.length; i++) { const a = p[i] < 0 ? -p[i] : p[i]; if (a > s) s = a; }
  }
  return s > 1 ? s : 1;
}

function epsFor(scale) {
  const plane = scale * PLANE_REL, weld = scale * WELD_REL;
  return { scale, plane, weld, area: weld * weld };
}

// ---- polygons --------------------------------------------------------------
//
// Convexity is an invariant: input triangles are convex and a halfspace cut of a
// convex polygon is convex, so the final fan-triangulation is always valid.
//
// Fragments INHERIT their parent's plane rather than recomputing one. Recomputing
// from three nearly-collinear fragment corners is how a BSP acquires a garbage
// normal and starts clipping against a plane nowhere near the surface.
//
// Plane and AABB live as bare number fields on a single hidden class rather than
// in sub-arrays. That is not style: classification is the hot loop — 74% of a
// sphere union by profile — and it runs tens of millions of times, so removing two
// pointer hops and ten bounds checks per test is worth more than every other
// micro-optimisation in this file put together. cx..hz is the box as centre plus
// half extent, which is the form the plane-vs-box test wants.

function Poly(v, nx, ny, nz, nw) {
  this.v = v;
  this.nx = nx; this.ny = ny; this.nz = nz; this.nw = nw;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  this.cx = (x0 + x1) * 0.5; this.cy = (y0 + y1) * 0.5; this.cz = (z0 + z1) * 0.5;
  this.hx = (x1 - x0) * 0.5; this.hy = (y1 - y0) * 0.5; this.hz = (z1 - z0) * 0.5;
}

function flipPoly(p) {
  const v = p.v, n = v.length, out = new Array(n);
  for (let i = 0, j = n - 3; i < n; i += 3, j -= 3) { out[i] = v[j]; out[i + 1] = v[j + 1]; out[i + 2] = v[j + 2]; }
  const q = new Poly(out, -p.nx, -p.ny, -p.nz, -p.nw);
  q.cx = p.cx; q.cy = p.cy; q.cz = p.cz; q.hx = p.hx; q.hy = p.hy; q.hz = p.hz;
  return q;
}

/** Conservative plane-vs-AABB test. FRONT / BACK are certain; UNKNOWN means look properly. */
function classifyFast(p, nx, ny, nz, nw, eps) {
  const d = nx * p.cx + ny * p.cy + nz * p.cz - nw;
  const r = (nx < 0 ? -nx : nx) * p.hx + (ny < 0 ? -ny : ny) * p.hy + (nz < 0 ? -nz : nz) * p.hz;
  if (d > r + eps) return FRONT;
  if (d < -r - eps) return BACK;
  return UNKNOWN;
}

/** Exact classification. Only reached when the box test is inconclusive. */
function classifyExact(p, nx, ny, nz, nw, eps) {
  const v = p.v, n = v.length;
  let type = 0;
  for (let i = 0; i < n; i += 3) {
    const d = nx * v[i] + ny * v[i + 1] + nz * v[i + 2] - nw;
    type |= d < -eps ? BACK : (d > eps ? FRONT : COPLANAR);
    if (type === SPANNING) return SPANNING;
  }
  return type;
}

function classify(p, nx, ny, nz, nw, eps) {
  const q = classifyFast(p, nx, ny, nz, nw, eps);
  return q === UNKNOWN ? classifyExact(p, nx, ny, nz, nw, eps) : q;
}

// Scratch buffers for splitPoly, plus single-element landing pads for the in-place
// partitions. Single-threaded and non-reentrant by design.
let _types = new Int32Array(64);
let _dists = new Float64Array(64);
const _sf = [], _sb = [];
function scratch(n) {
  if (_types.length < n) { _types = new Int32Array(n * 2); _dists = new Float64Array(n * 2); }
}

/**
 * Split `poly` by a plane, appending pieces to the four output lists. Coplanar
 * polygons are routed by facing: same-facing to `cf`, opposite-facing to `cb`.
 * Pushes at most one polygon to `front` and one to `back`, which the in-place
 * partitions rely on.
 */
function splitPoly(poly, nx, ny, nz, nw, eps, cf, cb, front, back) {
  const quick = classifyFast(poly, nx, ny, nz, nw, eps);
  if (quick === FRONT) { front.push(poly); return; }
  if (quick === BACK) { back.push(poly); return; }

  const v = poly.v, nv = v.length / 3;
  scratch(nv);
  let type = 0;
  for (let i = 0; i < nv; i++) {
    const d = nx * v[i * 3] + ny * v[i * 3 + 1] + nz * v[i * 3 + 2] - nw;
    const t = d < -eps ? BACK : (d > eps ? FRONT : COPLANAR);
    _dists[i] = d; _types[i] = t; type |= t;
  }

  if (type === COPLANAR) {
    // Parallel by definition, so the dot is ±1 and the sign is unambiguous. There
    // is no "nearly coplanar" case to fumble here.
    (nx * poly.nx + ny * poly.ny + nz * poly.nz > 0 ? cf : cb).push(poly);
    return;
  }
  if (type === FRONT) { front.push(poly); return; }
  if (type === BACK) { back.push(poly); return; }

  const f = [], b = [];
  for (let i = 0; i < nv; i++) {
    const j = (i + 1) % nv;
    const ti = _types[i], tj = _types[j];
    const ix = v[i * 3], iy = v[i * 3 + 1], iz = v[i * 3 + 2];
    if (ti !== BACK) f.push(ix, iy, iz);
    if (ti !== FRONT) b.push(ix, iy, iz);
    if ((ti | tj) === SPANNING) {
      const jx = v[j * 3], jy = v[j * 3 + 1], jz = v[j * 3 + 2];
      const t = _dists[i] / (_dists[i] - _dists[j]);
      let px = ix + t * (jx - ix), py = iy + t * (jy - iy), pz = iz + t * (jz - iz);
      // Re-project onto the plane: the lerp lands within an ulp or two of it, and
      // pushing it exactly on stops the residual compounding down the tree. This
      // is the cheapest robustness win in the file.
      const r = nx * px + ny * py + nz * pz - nw;
      px -= r * nx; py -= r * ny; pz -= r * nz;
      f.push(px, py, pz); b.push(px, py, pz);
    }
  }
  if (f.length >= 9) front.push(new Poly(f, poly.nx, poly.ny, poly.nz, poly.nw));
  if (b.length >= 9) back.push(new Poly(b, poly.nx, poly.ny, poly.nz, poly.nw));
}

// ---- BSP tree --------------------------------------------------------------
//
// Every node carries the root-only fields as well (box / margin / inverted) so
// that all nodes share one hidden class.

function Node() {
  this.nx = 0; this.ny = 0; this.nz = 0; this.nw = 0;
  this.has = false;
  this.polys = [];
  this.front = null; this.back = null;
  this.box = null; this.margin = 0; this.inverted = false;
}

/**
 * A root node also carries the solid's AABB and an inverted flag, both for
 * `clipPolygons`: a polygon whose box cannot reach the solid needs no plane test
 * at all. `inverted` flips what "cannot reach" implies — outside the solid, or
 * inside its complement.
 */
function makeTree(polys, eps) {
  const t = new Node();
  t.box = polysBox(polys);
  t.margin = eps * 100;   // == the weld tolerance; see epsFor
  return buildTree(t, polys, eps);
}

function polysBox(polys) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    if (p.cx - p.hx < box[0]) box[0] = p.cx - p.hx;
    if (p.cy - p.hy < box[1]) box[1] = p.cy - p.hy;
    if (p.cz - p.hz < box[2]) box[2] = p.cz - p.hz;
    if (p.cx + p.hx > box[3]) box[3] = p.cx + p.hx;
    if (p.cy + p.hy > box[4]) box[4] = p.cy + p.hy;
    if (p.cz + p.hz > box[5]) box[5] = p.cz + p.hz;
  }
  return box;
}

function boxesOverlap(p, box, m) {
  return !(p.cx - p.hx > box[3] + m || p.cx + p.hx < box[0] - m ||
           p.cy - p.hy > box[4] + m || p.cy + p.hy < box[1] - m ||
           p.cz - p.hz > box[5] + m || p.cz + p.hz < box[2] - m);
}

/** Is the polygon separated from the box along `a`? A no is not a yes to overlap. */
function separatedAlong(ax, ay, az, v, bcx, bcy, bcz, bhx, bhy, bhz, m) {
  const len2 = ax * ax + ay * ay + az * az;
  if (len2 <= m * m) return false;   // axis shorter than the tolerance carries no information
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const d = ax * v[i] + ay * v[i + 1] + az * v[i + 2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const c = ax * bcx + ay * bcy + az * bcz;
  const r = (ax < 0 ? -ax : ax) * bhx + (ay < 0 ? -ay : ay) * bhy + (az < 0 ? -az : az) * bhz;
  const pad = m * Math.sqrt(len2);   // the margin is in mm; this axis is not unit length
  return lo > c + r + pad || hi < c - r - pad;
}

/**
 * Full separating-axis test between a convex polygon and the solid's box.
 *
 * The AABB-vs-AABB test alone is far too generous for the shapes a boolean
 * actually produces. Cutting a round hole in a plate leaves long thin wedges
 * radiating out to the plate edge, and a wedge pointing diagonally has an AABB
 * covering a quarter of the plate — so every later cutter looks like it might
 * touch it, and shreds it. Adding the polygon's plane and the edge x box-axis
 * cross products rejects those properly. It costs ~20 axis tests on the polygons
 * that survive the cheap test, and saves a whole tree descent plus its splits.
 */
function polySeparatedFrom(p, box, m) {
  if (!boxesOverlap(p, box, m)) return true;   // box axes, cheap form
  const bcx = (box[0] + box[3]) * 0.5, bcy = (box[1] + box[4]) * 0.5, bcz = (box[2] + box[5]) * 0.5;
  const bhx = (box[3] - box[0]) * 0.5, bhy = (box[4] - box[1]) * 0.5, bhz = (box[5] - box[2]) * 0.5;
  const v = p.v;
  // The polygon's own plane.
  {
    const d = p.nx * bcx + p.ny * bcy + p.nz * bcz - p.nw;
    const r = (p.nx < 0 ? -p.nx : p.nx) * bhx + (p.ny < 0 ? -p.ny : p.ny) * bhy + (p.nz < 0 ? -p.nz : p.nz) * bhz;
    if (d > r + m || d < -r - m) return true;
  }
  for (let i = 0; i < v.length; i += 3) {
    const j = (i + 3) % v.length;
    const ex = v[j] - v[i], ey = v[j + 1] - v[i + 1], ez = v[j + 2] - v[i + 2];
    // e x X, e x Y, e x Z
    if (separatedAlong(0, ez, -ey, v, bcx, bcy, bcz, bhx, bhy, bhz, m)) return true;
    if (separatedAlong(-ez, 0, ex, v, bcx, bcy, bcz, bhx, bhy, bhz, m)) return true;
    if (separatedAlong(ey, -ex, 0, v, bcx, bcy, bcz, bhx, bhy, bhz, m)) return true;
  }
  return false;
}

const HEURISTIC_CANDIDATES = 8;   // planes tried per node
const HEURISTIC_SAMPLE = 48;      // polygons scored against each
const SPLIT_COST = 8;             // a split costs this much versus one unit of imbalance

/**
 * Pick a splitting plane: fixed stride over the range for both candidates and
 * sample (no RNG, no shuffling), score = splits*8 + imbalance - coplanar*3.
 *
 * Absorbing coplanar polygons is worth real money. A box has six faces but dozens
 * of fragments per face after the first operation, and pulling them all into one
 * node is what keeps the tree from degenerating into a chain on axis-aligned
 * geometry — which is nearly all of Bluesheet's geometry.
 */
function choosePlane(polys, lo, hi, eps) {
  const n = hi - lo;
  if (n <= 2) return lo;
  const k = HEURISTIC_CANDIDATES < n ? HEURISTIC_CANDIDATES : n;
  const s = HEURISTIC_SAMPLE < n ? HEURISTIC_SAMPLE : n;
  let best = lo, bestScore = Infinity;
  for (let c = 0; c < k; c++) {
    const ci = lo + Math.floor(c * n / k);
    const q = polys[ci], nx = q.nx, ny = q.ny, nz = q.nz, nw = q.nw;
    let front = 0, back = 0, span = 0, copl = 0;
    for (let i = 0; i < s; i++) {
      const t = classify(polys[lo + Math.floor(i * n / s)], nx, ny, nz, nw, eps);
      if (t === SPANNING) span++;
      else if (t === FRONT) front++;
      else if (t === BACK) back++;
      else copl++;
    }
    const score = span * SPLIT_COST + Math.abs(front - back) - copl * 3;
    if (score < bestScore) { bestScore = score; best = ci; }
  }
  return best;
}

// Four parallel stacks rather than one interleaved array: V8 keeps each of these
// monomorphic (objects / arrays / smis) where a mixed array degrades to boxed.
// buildTree and clipPolygons never nest, so sharing them is safe — but they are
// drained on entry anyway so a throw part-way through one call cannot poison the
// next one with stale work.
const _sn = [], _sa = [], _slo = [], _shi = [];
function resetStacks() { _sn.length = 0; _sa.length = 0; _slo.length = 0; _shi.length = 0; }

/**
 * Insert polygons into the tree, extending it where children are missing.
 *
 * Iterative, and it partitions `polys` IN PLACE — the caller's array becomes
 * scratch. The back half is compacted to the front of the range and the range
 * shrinks, so on a convex operand (where nothing ever lands in front) the whole
 * 5120-deep chain runs without allocating a single array. Recursion would also
 * blow the stack here: a convex mesh's BSP is necessarily one node per face.
 */
function buildTree(root, polys, eps) {
  if (!polys.length) return root;
  if (root.box) {
    const nb = polysBox(polys);
    for (let k = 0; k < 3; k++) {
      if (nb[k] < root.box[k]) root.box[k] = nb[k];
      if (nb[k + 3] > root.box[k + 3]) root.box[k + 3] = nb[k + 3];
    }
  }
  resetStacks();
  _sn.push(root); _sa.push(polys); _slo.push(0); _shi.push(polys.length);
  while (_sn.length) {
    const n = _sn.pop(), arr = _sa.pop(), lo = _slo.pop(), hi = _shi.pop();
    if (hi <= lo) continue;
    if (!n.has) {
      const q = arr[choosePlane(arr, lo, hi, eps)];
      n.nx = q.nx; n.ny = q.ny; n.nz = q.nz; n.nw = q.nw; n.has = true;
    }
    const nx = n.nx, ny = n.ny, nz = n.nz, nw = n.nw, cop = n.polys;
    let w = lo, front = null;
    for (let i = lo; i < hi; i++) {
      const p = arr[i];
      const d = nx * p.cx + ny * p.cy + nz * p.cz - nw;
      const r = (nx < 0 ? -nx : nx) * p.hx + (ny < 0 ? -ny : ny) * p.hy + (nz < 0 ? -nz : nz) * p.hz;
      if (d < -r - eps) { arr[w++] = p; continue; }
      if (d > r + eps) { (front || (front = [])).push(p); continue; }
      // Both coplanar orientations go into the node's own list. The front/back
      // distinction only matters when *clipping*, not when partitioning space.
      _sf.length = 0; _sb.length = 0;
      splitPoly(p, nx, ny, nz, nw, eps, cop, cop, _sf, _sb);
      if (_sb.length) arr[w++] = _sb[0];
      if (_sf.length) (front || (front = [])).push(_sf[0]);
    }
    if (front) {
      if (!n.front) n.front = new Node();
      _sn.push(n.front); _sa.push(front); _slo.push(0); _shi.push(front.length);
    }
    if (w > lo) {
      if (!n.back) n.back = new Node();
      _sn.push(n.back); _sa.push(arr); _slo.push(lo); _shi.push(w);
    }
  }
  return root;
}

/** Remove the parts of `polys` that fall inside the solid `root` describes. */
function clipPolygons(root, polys, eps) {
  if (!root.has) return polys.slice();
  const out = [];
  let live;
  if (root.box) {
    live = [];
    const box = root.box, m = root.margin, inv = root.inverted;
    for (let i = 0; i < polys.length; i++) {
      const p = polys[i];
      if (polySeparatedFrom(p, box, m)) {
        // Cannot touch the solid: outside it if the tree is upright, inside it
        // (so deleted) if the tree has been inverted to mean the complement.
        if (!inv) out.push(p);
      } else live.push(p);
    }
    if (!live.length) return out;
  } else {
    live = polys.slice();   // partitioned in place below; never the caller's array
  }

  // Same in-place partition as buildTree, with one extra shortcut: a node with no
  // front child has already finished with its front pieces, so they go straight to
  // the output rather than through another array.
  resetStacks();
  _sn.push(root); _sa.push(live); _slo.push(0); _shi.push(live.length);
  while (_sn.length) {
    const n = _sn.pop(), arr = _sa.pop(), lo = _slo.pop(), hi = _shi.pop();
    if (hi <= lo) continue;
    const nx = n.nx, ny = n.ny, nz = n.nz, nw = n.nw;
    const keepBack = n.back !== null;
    const front = n.front !== null ? [] : out;
    let w = lo;
    for (let i = lo; i < hi; i++) {
      const p = arr[i];
      const d = nx * p.cx + ny * p.cy + nz * p.cz - nw;
      const r = (nx < 0 ? -nx : nx) * p.hx + (ny < 0 ? -ny : ny) * p.hy + (nz < 0 ? -nz : nz) * p.hz;
      if (d > r + eps) { front.push(p); continue; }
      // No back child means this cell is solid: whatever reached here is interior.
      if (d < -r - eps) { if (keepBack) arr[w++] = p; continue; }
      // Coplanar-same-facing counts as outside (front), coplanar-opposite as
      // inside (back). That asymmetry is what deletes exactly one copy of a shared
      // face instead of zero or two.
      _sf.length = 0; _sb.length = 0;
      splitPoly(p, nx, ny, nz, nw, eps, _sf, _sb, _sf, _sb);
      if (_sf.length) front.push(_sf[0]);
      if (_sb.length && keepBack) arr[w++] = _sb[0];
    }
    if (n.front !== null && front.length) {
      _sn.push(n.front); _sa.push(front); _slo.push(0); _shi.push(front.length);
    }
    if (keepBack && w > lo) {
      _sn.push(n.back); _sa.push(arr); _slo.push(lo); _shi.push(w);
    }
  }
  return out;
}

function clipTree(root, other, eps) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.polys.length) n.polys = clipPolygons(other, n.polys, eps);
    if (n.front) stack.push(n.front);
    if (n.back) stack.push(n.back);
  }
}

function invertTree(root) {
  root.inverted = !root.inverted;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    n.nx = -n.nx; n.ny = -n.ny; n.nz = -n.nz; n.nw = -n.nw;
    const ps = n.polys;
    for (let i = 0; i < ps.length; i++) ps[i] = flipPoly(ps[i]);
    const t = n.front; n.front = n.back; n.back = t;
    if (n.front) stack.push(n.front);
    if (n.back) stack.push(n.back);
  }
}

function allPolys(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    const ps = n.polys;
    for (let i = 0; i < ps.length; i++) out.push(ps[i]);
    if (n.front) stack.push(n.front);
    if (n.back) stack.push(n.back);
  }
  return out;
}

// ---- mesh <-> polygon conversion -------------------------------------------

function meshToPolys(mesh, areaEps) {
  const out = [], p = mesh.positions, t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // A zero-area triangle has no plane worth trusting and no surface to carry.
    // Feeding one to the tree gives it a normal made of pure rounding error.
    if (!(len > 2 * areaEps)) continue;
    nx /= len; ny /= len; nz /= len;
    out.push(new Poly([ax, ay, az, bx, by, bz, cx, cy, cz], nx, ny, nz, nx * ax + ny * ay + nz * az));
  }
  return out;
}

/**
 * Tolerance-correct vertex welder. Cells are 4*eps wide and each lookup probes the
 * 2x2x2 block nearest the point, which is guaranteed to contain everything within
 * eps. The ordinary "round the coordinate into a bucket" weld misses any pair that
 * straddles a cell boundary, and those pairs are precisely the coincident split
 * points a boolean produces.
 */
function makeWelder(eps) {
  const mesh = new Mesh();
  const cell = eps * 4, inv = 1 / cell, eps2 = eps * eps;
  const grid = new Map();
  const hash = (i, j, k) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
  const pos = mesh.positions;
  return {
    mesh,
    add(x, y, z) {
      const ci = Math.floor(x * inv), cj = Math.floor(y * inv), ck = Math.floor(z * inv);
      const si = x - (ci + 0.5) * cell >= 0 ? 1 : -1;
      const sj = y - (cj + 0.5) * cell >= 0 ? 1 : -1;
      const sk = z - (ck + 0.5) * cell >= 0 ? 1 : -1;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
        const bucket = grid.get(hash(ci + (a ? si : 0), cj + (b ? sj : 0), ck + (c ? sk : 0)));
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const o = bucket[n] * 3;
          const dx = pos[o] - x, dy = pos[o + 1] - y, dz = pos[o + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= eps2) return bucket[n];
        }
      }
      const idx = mesh.addVertex(x, y, z);
      const key = hash(ci, cj, ck);
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(idx);
      return idx;
    },
  };
}

/** n-gons -> indexed triangle mesh. The one and only triangulation step. */
function polysToMesh(polys, weldEps) {
  const w = makeWelder(weldEps);
  const mesh = w.mesh;
  const idx = [];
  for (let n = 0; n < polys.length; n++) {
    const v = polys[n].v, nv = v.length / 3;
    if (nv < 3) continue;
    idx.length = 0;
    for (let i = 0; i < nv; i++) idx.push(w.add(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]));
    // Convex by invariant, so a fan is correct. Pairs that welded together drop out.
    for (let i = 1; i + 1 < nv; i++) {
      const a = idx[0], b = idx[i], c = idx[i + 1];
      if (a === b || b === c || a === c) continue;
      mesh.addTri(a, b, c);
    }
  }
  return mesh;
}

function weldMesh(mesh, weldEps) {
  const w = makeWelder(weldEps);
  const out = w.mesh, p = mesh.positions, t = mesh.tris;
  const remap = new Int32Array(mesh.vertCount);
  for (let v = 0; v < mesh.vertCount; v++) remap[v] = w.add(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
  for (let i = 0; i < t.length; i += 3) {
    const a = remap[t[i]], b = remap[t[i + 1]], c = remap[t[i + 2]];
    if (a === b || b === c || a === c) continue;
    out.addTri(a, b, c);
  }
  return out;
}

// ---- T-junction repair -----------------------------------------------------

/**
 * Single-use (boundary) edges, each with the triangle and corner that owns it.
 * The pair key is derived from the actual vertex count rather than a fixed shift:
 * a hard-coded stride silently collides once a mesh outgrows it, and a boolean's
 * output size is not something this function gets to assume.
 */
function boundaryEdges(mesh) {
  const t = mesh.tris, counts = new Map(), owner = new Map();
  const stride = mesh.vertCount + 1;   // exact in a double up to ~94M vertices
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = t[i + k], v = t[i + (k + 1) % 3];
      const key = u < v ? u * stride + v : v * stride + u;
      const c = counts.get(key);
      if (c === undefined) { counts.set(key, 1); owner.set(key, i + k); }
      else counts.set(key, c + 1);
    }
  }
  const out = [];
  for (const [key, c] of counts) {
    if (c !== 1) continue;
    const o = owner.get(key), corner = o % 3, tri = (o - corner) / 3;
    out.push({ a: t[o], b: t[tri * 3 + (corner + 1) % 3], tri, corner });
  }
  return out;
}

/**
 * One repair pass. Returns a new Mesh, or null when nothing needed fixing.
 *
 * Candidates are restricted to vertices already sitting on a boundary edge — a
 * T-junction always puts its stray vertex on one — and those are sorted by x so
 * each edge only scans the slab it could possibly reach into.
 */
function repairPass(mesh, bd, eps) {
  const p = mesh.positions;
  const candSet = new Set();
  for (const e of bd) { candSet.add(e.a); candSet.add(e.b); }
  const cand = [...candSet].sort((i, j) => (p[i * 3] - p[j * 3]) || (i - j));
  const cx = new Float64Array(cand.length);
  for (let i = 0; i < cand.length; i++) cx[i] = p[cand[i] * 3];

  const lowerBound = (x) => {
    let lo = 0, hi = cand.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cx[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const eps2 = eps * eps;
  const inserts = new Map();   // triangle index -> extra vertices, per corner
  let found = 0;

  for (const e of bd) {
    const a = e.a * 3, b = e.b * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b];
    const dx = bx - ax, dy = p[b + 1] - ay, dz = p[b + 2] - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 <= eps2) continue;
    const uPad = eps / Math.sqrt(len2);   // a hit this close to an end IS the end
    const hits = [];
    const xhi = (ax > bx ? ax : bx) + eps;
    for (let i = lowerBound((ax < bx ? ax : bx) - eps); i < cand.length && cx[i] <= xhi; i++) {
      const vi = cand[i];
      if (vi === e.a || vi === e.b) continue;
      const q = vi * 3, qx = p[q] - ax, qy = p[q + 1] - ay, qz = p[q + 2] - az;
      const u = (qx * dx + qy * dy + qz * dz) / len2;
      if (u <= uPad || u >= 1 - uPad) continue;
      const rx = qx - u * dx, ry = qy - u * dy, rz = qz - u * dz;
      if (rx * rx + ry * ry + rz * rz > eps2) continue;
      hits.push({ u, v: vi });
    }
    if (!hits.length) continue;
    hits.sort((m, n) => (m.u - n.u) || (m.v - n.v));
    // Two hits at the same spot would make a zero-length sub-edge.
    const kept = [];
    for (const h of hits) if (!kept.length || h.u - kept[kept.length - 1].u > uPad) kept.push(h);
    let slot = inserts.get(e.tri);
    if (!slot) { slot = [null, null, null]; inserts.set(e.tri, slot); }
    slot[e.corner] = kept;
    found += kept.length;
  }

  if (!found) return null;

  const out = new Mesh(mesh.positions.slice(), []);
  const tris = out.tris, EMPTY = [];
  for (let t = 0; t < mesh.triCount; t++) {
    const a = mesh.tris[t * 3], b = mesh.tris[t * 3 + 1], c = mesh.tris[t * 3 + 2];
    const slot = inserts.get(t);
    if (!slot) { tris.push(a, b, c); continue; }
    emitSubdivided(tris, a, b, c, slot[0] || EMPTY, slot[1] || EMPTY, slot[2] || EMPTY);
  }
  return out;
}

/**
 * Retriangulate a triangle that has extra vertices sitting on its edges.
 * Bisecting the busiest edge and recursing keeps every emitted triangle a real
 * triangle — the apex is always the opposite corner, never a collinear neighbour,
 * which a naive fan from vertex 0 cannot promise.
 */
function emitSubdivided(out, a, b, c, ab, bc, ca) {
  if (!ab.length && !bc.length && !ca.length) { out.push(a, b, c); return; }
  if (ab.length >= bc.length && ab.length >= ca.length) {
    const k = ab.length >> 1, m = ab[k].v;
    emitSubdivided(out, a, m, c, ab.slice(0, k), [], ca);
    emitSubdivided(out, m, b, c, ab.slice(k + 1), bc, []);
  } else if (bc.length >= ca.length) {
    emitSubdivided(out, b, c, a, bc, ca, ab);   // rotate so the busiest edge is first
  } else {
    emitSubdivided(out, c, a, b, ca, ab, bc);
  }
}

const REPAIR_PASSES = 3;

function repairTJunctions(mesh, eps) {
  for (let pass = 0; pass < REPAIR_PASSES; pass++) {
    const bd = boundaryEdges(mesh);
    if (!bd.length) break;
    const next = repairPass(mesh, bd, eps);
    if (!next) break;
    mesh = next;
  }
  return mesh;
}

// ---- coplanar merge --------------------------------------------------------
//
// A BSP cuts with infinite planes, so a round hole in a plate leaves the plate's
// top face as two dozen wedges reaching all the way to the edge — about 128
// triangles where 26 would do. That is not wrong, but the next boolean then has
// to split all 128, and the cost compounds hole after hole.
//
// So: group the output triangles by the plane they lie in, cancel the interior
// edges of each group (an interior edge is used once in each direction, a
// boundary edge only once), trace what survives into loops, and retriangulate the
// region properly — holes bridged into the outer loop and ear-clipped.
//
// Every group is validated before it is accepted: the triangles must cover the
// same area as the loops enclose, none may be degenerate, and there must be
// exactly n-2 of them. Any group that fails keeps its original triangles, so the
// worst this pass can do is nothing. That matters more than the triangle count —
// a merge that silently drops a face would hand a generator a leaking solid.

const MERGE_MIN_TRIS = 8;      // below this there is nothing to win
const MERGE_MAX_LOOP = 4000;   // ear clipping is O(n^2); refuse absurd loops

function planeBasis(nx, ny, nz) {
  const ax = nx < 0 ? -nx : nx, ay = ny < 0 ? -ny : ny, az = nz < 0 ? -nz : nz;
  let ux, uy, uz;
  if (ax <= ay && ax <= az) { ux = 0; uy = -nz; uz = ny; }
  else if (ay <= az) { ux = nz; uy = 0; uz = -nx; }
  else { ux = -ny; uy = nx; uz = 0; }
  const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= l; uy /= l; uz /= l;
  // v = n x u, so that u x v = n and a CCW loop seen from +n has positive area.
  return [ux, uy, uz, ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux];
}

function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

function loopArea(u, v) {
  let a = 0;
  for (let i = 0, j = u.length - 1; i < u.length; j = i++) a += u[j] * v[i] - u[i] * v[j];
  return a / 2;
}

function pointInLoop(pu, pv, u, v) {
  let inside = false;
  for (let i = 0, j = u.length - 1; i < u.length; j = i++) {
    if ((v[i] > pv) !== (v[j] > pv) &&
        pu < (u[j] - u[i]) * (pv - v[i]) / (v[j] - v[i]) + u[i]) inside = !inside;
  }
  return inside;
}

/** Splice a hole loop into its outer loop with a bridge, earcut-style. */
function bridgeHole(outer, hole) {
  // The hole's rightmost vertex sees the outer loop along +u.
  let mi = 0;
  for (let i = 1; i < hole.u.length; i++) if (hole.u[i] > hole.u[mi]) mi = i;
  const mu = hole.u[mi], mv = hole.v[mi];

  // Nearest outer edge hit by the +u ray from that vertex; take its far endpoint.
  let bestQ = Infinity, p = -1;
  for (let i = 0, j = outer.u.length - 1; i < outer.u.length; j = i++) {
    const vi = outer.v[i], vj = outer.v[j];
    if (mv <= Math.max(vi, vj) && mv >= Math.min(vi, vj) && vj !== vi) {
      const x = outer.u[i] + (mv - vi) / (vj - vi) * (outer.u[j] - outer.u[i]);
      if (x >= mu && x < bestQ) { bestQ = x; p = outer.u[j] > outer.u[i] ? j : i; }
    }
  }
  if (p < 0) return null;

  // Any reflex vertex inside the triangle (M, hit point, P) blocks that bridge;
  // among those, the one at the shallowest angle to the ray is visible from M.
  const px = outer.u[p], py = outer.v[p];
  let bestTan = Infinity, best = p;
  for (let i = 0; i < outer.u.length; i++) {
    const qu = outer.u[i], qv = outer.v[i];
    if (qu < mu || qu > bestQ) continue;
    if (!inTri(mu, mv, bestQ, mv, px, py, qu, qv) && !inTri(mu, mv, px, py, bestQ, mv, qu, qv)) continue;
    const tan = Math.abs(qv - mv) / (qu - mu || 1e-300);
    if (tan < bestTan) { bestTan = tan; best = i; }
  }

  const u = [], v = [], id = [];
  const push = (src, i) => { u.push(src.u[i]); v.push(src.v[i]); id.push(src.id[i]); };
  for (let i = 0; i <= best; i++) push(outer, i);
  for (let i = mi; i < hole.u.length; i++) push(hole, i);
  for (let i = 0; i <= mi; i++) push(hole, i);
  for (let i = best; i < outer.u.length; i++) push(outer, i);
  return { u, v, id };
}

function inTri(ax, ay, bx, by, cx, cy, px, py) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
}

/** O(n^2) ear clipping. Returns index triples, or null if it cannot finish. */
function earClip(loop) {
  const n = loop.id.length;
  if (n < 3) return null;
  const { u, v, id } = loop;
  const prev = new Int32Array(n), next = new Int32Array(n), alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) { prev[i] = (i + n - 1) % n; next[i] = (i + 1) % n; }
  const out = [];
  let remaining = n, i = 0, stall = 0;
  while (remaining > 3) {
    const a = prev[i], b = i, c = next[i];
    if (isEar(u, v, id, alive, next, a, b, c)) {
      out.push(id[a], id[b], id[c]);
      alive[b] = 0; next[a] = c; prev[c] = a; remaining--; stall = 0;
      i = a;
    } else {
      i = next[i];
      if (++stall > remaining) return null;   // no ear anywhere: give up, keep the originals
    }
  }
  out.push(id[prev[i]], id[i], id[next[i]]);
  return out;
}

function isEar(u, v, id, alive, next, a, b, c) {
  const ax = u[a], ay = v[a], bx = u[b], by = v[b], cx = u[c], cy = v[c];
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 0) return false;   // reflex or flat
  for (let k = next[c]; k !== a; k = next[k]) {
    if (!alive[k]) continue;
    // Compare vertex ids, not loop positions: bridging duplicates a vertex, and a
    // vertex is not allowed to block an ear it is a corner of.
    if (id[k] === id[a] || id[k] === id[b] || id[k] === id[c]) continue;
    if (inTri(ax, ay, bx, by, cx, cy, u[k], v[k])) return false;
  }
  return true;
}

/**
 * Regroup a welded, watertight mesh so each planar region is triangulated once,
 * properly, instead of carrying the BSP's split history.
 */
function mergeCoplanar(mesh, E) {
  const p = mesh.positions, t = mesh.tris, nt = mesh.triCount;
  if (nt < MERGE_MIN_TRIS) return mesh;

  // Group by plane. The offset bucket is the weld tolerance and the normal bucket
  // 1e-6 of a unit vector; anything that lands in one bucket is the same plane to
  // far better precision than a nozzle can resolve. A fragment that falls the
  // wrong side of a bucket edge only loses the chance to merge, never correctness.
  const qw = E.weld * 10 || 1e-6;
  const groups = new Map();
  const normals = [];
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) { normals.push(null); continue; }
    nx /= len; ny /= len; nz /= len;
    const w = nx * p[a] + ny * p[a + 1] + nz * p[a + 2];
    normals.push([nx, ny, nz]);
    const key = `${Math.round(nx * 1e6)},${Math.round(ny * 1e6)},${Math.round(nz * 1e6)},${Math.round(w / qw)}`;
    let g = groups.get(key);
    if (!g) { groups.set(key, g = []); }
    g.push(i);
  }

  // Undirected edge use over the whole mesh, so a group can be checked against
  // what its neighbours are already doing before it is accepted.
  const stride = mesh.vertCount + 1;
  const use = new Map();
  const ekey = (a, b) => (a < b ? a * stride + b : b * stride + a);
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
    use.set(ekey(a, b), (use.get(ekey(a, b)) || 0) + 1);
    use.set(ekey(b, c), (use.get(ekey(b, c)) || 0) + 1);
    use.set(ekey(c, a), (use.get(ekey(c, a)) || 0) + 1);
  }

  const keep = new Uint8Array(nt).fill(1);
  const added = [];
  for (const tris of groups.values()) {
    if (tris.length < MERGE_MIN_TRIS) continue;
    const merged = mergeGroup(mesh, tris, normals[tris[0]], E);
    if (!merged) continue;
    const delta = edgeDelta(mesh, tris, merged, ekey);
    if (!deltaAllowed(use, delta)) continue;
    for (const [k, d] of delta) use.set(k, (use.get(k) || 0) + d);
    for (const i of tris) keep[i] = 0;
    for (const v of merged) added.push(v);
  }
  if (!added.length) return mesh;

  const out = new Mesh(p.slice(), []);
  for (let i = 0; i < nt; i++) if (keep[i]) out.tris.push(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
  for (const v of added) out.tris.push(v);
  return out;
}

/**
 * The edge-use change a replacement would cause, or null if it is not allowed.
 *
 * A retriangulation covers the same region, so every edge must end up used either
 * twice (interior or shared with a neighbour) or not at all. This is the check
 * that caught the real failure here: two coincident sheets facing opposite ways —
 * a zero-volume flap that CSG on curved surfaces leaves behind — used to survive
 * because each sheet was triangulated differently. Retriangulate both properly and
 * they land on the same diagonals, giving four triangles to one edge. Rejecting
 * the second group keeps the flap ugly but manifold, which is the right trade.
 */
function edgeDelta(mesh, tris, merged, ekey) {
  const t = mesh.tris, delta = new Map();
  const bump = (a, b, d) => { const k = ekey(a, b); delta.set(k, (delta.get(k) || 0) + d); };
  for (const i of tris) {
    const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
    bump(a, b, -1); bump(b, c, -1); bump(c, a, -1);
  }
  for (let i = 0; i < merged.length; i += 3) {
    bump(merged[i], merged[i + 1], 1); bump(merged[i + 1], merged[i + 2], 1); bump(merged[i + 2], merged[i], 1);
  }
  return delta;
}

function deltaAllowed(use, delta) {
  for (const [k, d] of delta) {
    const before = use.get(k) || 0, after = before + d;
    if (after !== 0 && after !== 2 && after !== before) return false;
  }
  return true;
}

function mergeGroup(mesh, tris, n, E) {
  const t = mesh.tris;
  // Interior edges appear once in each direction and cancel; what survives is the
  // region's boundary. A direction appearing twice means overlapping triangles,
  // which this pass has no business trying to interpret.
  const stride = mesh.vertCount + 1;
  const dirs = new Map();
  for (const i of tris) {
    const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const k = x * stride + y;
      if (dirs.get(k)) return null;
      dirs.set(k, 1);
    }
  }
  const succ = new Map();
  for (const k of dirs.keys()) {
    const x = Math.floor(k / stride), y = k - x * stride;
    if (dirs.has(y * stride + x)) continue;          // cancels with its twin
    if (succ.has(x)) return null;                    // pinch: two ways out of one vertex
    succ.set(x, y);
  }
  if (succ.size < 3) return null;

  const [ux, uy, uz, vx, vy, vz] = planeBasis(n[0], n[1], n[2]);
  const p = mesh.positions;
  const proj = (id) => [ux * p[id * 3] + uy * p[id * 3 + 1] + uz * p[id * 3 + 2],
                        vx * p[id * 3] + vy * p[id * 3 + 1] + vz * p[id * 3 + 2]];

  const seen = new Set();
  const loops = [];
  for (const start of succ.keys()) {
    if (seen.has(start)) continue;
    const id = [], u = [], v = [];
    let cur = start;
    do {
      if (seen.has(cur)) return null;                // two loops sharing a vertex
      seen.add(cur);
      const q = proj(cur);
      id.push(cur); u.push(q[0]); v.push(q[1]);
      cur = succ.get(cur);
      if (cur === undefined || id.length > MERGE_MAX_LOOP) return null;
    } while (cur !== start);
    if (id.length < 3) return null;
    loops.push({ id, u, v, area: loopArea(u, v) });
  }

  const outers = loops.filter(l => l.area > 0);
  const holes = loops.filter(l => l.area <= 0);
  if (!outers.length) return null;

  // Give every hole to the smallest outer loop that contains it.
  const assigned = outers.map(o => ({ o, h: [] }));
  for (const h of holes) {
    let best = -1, bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      const o = outers[i];
      if (o.area < bestArea && pointInLoop(h.u[0], h.v[0], o.u, o.v)) { best = i; bestArea = o.area; }
    }
    if (best < 0) return null;
    assigned[best].h.push(h);
  }

  const out = [];
  let area = 0, want = 0;
  for (const { o, h } of assigned) {
    want += o.area;
    let loop = o;
    // Rightmost hole first. earcut goes the other way (leftmost first), but its
    // ordering is tied to its linked-list rewrite; measured here, bridging from
    // the right lets far more groups succeed — 6,472 triangles for twenty
    // sequential holes against 15,612 the other way round, same topology either
    // way, the difference being groups whose bridge search failed and fell back.
    for (const hole of h.slice().sort((a, b) => maxOf(b.u) - maxOf(a.u))) {
      want += hole.area;
      loop = bridgeHole(loop, hole);
      if (!loop) return null;
    }
    const tri = earClip(loop);
    if (!tri || tri.length !== (loop.id.length - 2) * 3) return null;
    for (let i = 0; i < tri.length; i += 3) {
      const a = proj(tri[i]), b = proj(tri[i + 1]), c = proj(tri[i + 2]);
      const s = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      if (!(s > 0)) return null;                     // degenerate or inverted
      area += s;
    }
    for (const v2 of tri) out.push(v2);
  }
  // The retriangulation must cover exactly the region the loops enclose. Both the
  // relative and the absolute limb of this tolerance are scale-relative, because
  // "1e-9 mm²" means something very different on a 0.5 mm part and a 180 mm plate.
  if (Math.abs(area - want) > Math.max(E.area, Math.abs(want) * 1e-9)) return null;
  return out.length >= 3 ? out : null;
}

// ---- result cleanup --------------------------------------------------------

function finishPolys(polys, E) {
  return finishMesh(polysToMesh(polys, E.weld), E, true);
}

/**
 * Weld, drop the slivers, close the seams. The order matters: dropping a zero-area
 * triangle punches a hole, and the repair pass is exactly what stitches that hole
 * shut again by splitting the neighbour at the collapsed vertex.
 */
function finishMesh(mesh, E, alreadyWelded = false) {
  let m = alreadyWelded ? mesh : weldMesh(mesh, E.weld);
  m = m.dropDegenerate(E.area);
  m = repairTJunctions(m, E.weld);
  // After the seams are closed, not before: the merge reads each planar region's
  // boundary off its edge use, and a T-junction leaves edges that do not cancel.
  m = mergeCoplanar(m, E);
  return m.compact();
}

function cleanCopy(mesh) {
  if (!mesh || !mesh.triCount) return new Mesh();
  return finishMesh(mesh, epsFor(operandScale(mesh)));
}

// ---- argument checking -----------------------------------------------------
//
// null/undefined is accepted and means "nothing" — it makes
// `subtractAll(base, [maybeCutter, ...])` read naturally. Anything else that is
// not a Mesh is a mistake worth naming, because the silent alternative is a
// boolean that quietly returns one operand untouched and a generator that ships
// a part with no hole in it.

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === 'object') {
    const n = v.constructor && v.constructor.name;
    return !n || n === 'Object' ? 'a plain object' : `a ${n}`;
  }
  return `a ${typeof v}`;
}

function operand(m, fn, which) {
  if (m === null || m === undefined) return null;
  if (typeof m.triCount === 'number' && Array.isArray(m.positions) && Array.isArray(m.tris)) {
    return m.triCount > 0 ? m : null;
  }
  throw new TypeError(`csg.${fn}: ${which} must be a Mesh or null, got ${describe(m)}`);
}

function operandList(meshes, fn) {
  if (meshes === null || meshes === undefined) return [];
  if (!Array.isArray(meshes)) {
    throw new TypeError(`csg.${fn}: expected an array of meshes, got ${describe(meshes)}`);
  }
  const out = [];
  for (let i = 0; i < meshes.length; i++) {
    const m = operand(meshes[i], fn, `mesh ${i}`);
    if (m) out.push(m);
  }
  return out;
}

// ---- bounding-box shortcuts ------------------------------------------------

function boxesApart(a, b, margin) {
  for (let k = 0; k < 3; k++) if (a.max[k] + margin < b.min[k] || b.max[k] + margin < a.min[k]) return true;
  return false;
}

function meshesApart(a, b, margin) { return boxesApart(a.bbox(), b.bbox(), margin); }

// ---- the operations --------------------------------------------------------

/**
 * A ∪ B. The invert / clip / invert pass on B is not decoration: it is what
 * deletes B's copy of any face it shares with A's surface, so a shared face lands
 * in the result exactly once.
 */
export function union(ma, mb) {
  const a = operand(ma, 'union', 'first argument'), b = operand(mb, 'union', 'second argument');
  if (!a) return cleanCopy(b);
  if (!b) return cleanCopy(a);
  const E = epsFor(operandScale(a, b));
  // Nothing to resolve if they cannot touch — and a merge is exact where a boolean
  // is only approximately exact.
  if (meshesApart(a, b, E.weld * 10)) return finishMesh(Mesh.merge([a, b]), E);

  const A = makeTree(meshToPolys(a, E.area), E.plane);
  const B = makeTree(meshToPolys(b, E.area), E.plane);
  clipTree(A, B, E.plane);
  clipTree(B, A, E.plane);
  invertTree(B);
  clipTree(B, A, E.plane);
  invertTree(B);
  buildTree(A, allPolys(B), E.plane);
  return finishPolys(allPolys(A), E);
}

/** A \ B. B's surface is inverted into the result as the walls of the cut. */
export function subtract(ma, mb) {
  const a = operand(ma, 'subtract', 'first argument'), b = operand(mb, 'subtract', 'second argument');
  if (!a) return new Mesh();
  if (!b) return cleanCopy(a);
  const E = epsFor(operandScale(a, b));
  if (meshesApart(a, b, E.weld * 10)) return cleanCopy(a);

  const A = makeTree(meshToPolys(a, E.area), E.plane);
  const B = makeTree(meshToPolys(b, E.area), E.plane);
  invertTree(A);
  clipTree(A, B, E.plane);
  clipTree(B, A, E.plane);
  invertTree(B);
  clipTree(B, A, E.plane);
  invertTree(B);
  buildTree(A, allPolys(B), E.plane);
  invertTree(A);
  return finishPolys(allPolys(A), E);
}

/** A ∩ B. */
export function intersect(ma, mb) {
  const a = operand(ma, 'intersect', 'first argument'), b = operand(mb, 'intersect', 'second argument');
  if (!a || !b) return new Mesh();
  const E = epsFor(operandScale(a, b));
  if (meshesApart(a, b, 0)) return new Mesh();

  const A = makeTree(meshToPolys(a, E.area), E.plane);
  const B = makeTree(meshToPolys(b, E.area), E.plane);
  invertTree(A);
  clipTree(B, A, E.plane);
  invertTree(B);
  clipTree(A, B, E.plane);
  clipTree(B, A, E.plane);
  buildTree(A, allPolys(B), E.plane);
  invertTree(A);
  return finishPolys(allPolys(A), E);
}

/**
 * Union of many. Reduced pairwise as a balanced tree rather than folded left: a
 * left fold re-BSPs the whole accumulated solid on every step, so 16 parts cost
 * O(n²) polygon work instead of O(n log n).
 */
export function unionAll(meshes) {
  const list = operandList(meshes, 'unionAll');
  if (!list.length) return new Mesh();
  if (list.length === 1) return cleanCopy(list[0]);
  let level = list;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? union(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/**
 * base \ (m1 ∪ m2 ∪ …). Cutters whose bounding boxes cannot touch each other are
 * merged into one operand first — a merged set of disjoint shells is still a valid
 * solid, so twenty screw holes in a plate cost ONE BSP build of the plate instead
 * of twenty. Grouping is greedy first-fit, so it is deterministic.
 */
export function subtractAll(mbase, meshes) {
  const base = operand(mbase, 'subtractAll', 'base');
  const cutters = operandList(meshes, 'subtractAll');
  if (!base) return new Mesh();
  if (!cutters.length) return cleanCopy(base);

  // Spreading the cutter list into operandScale would cap out on the argument
  // limit for a few tens of thousands of cutters, so fold it instead.
  let scale = operandScale(base);
  for (const c of cutters) { const s = operandScale(c); if (s > scale) scale = s; }
  const margin = epsFor(scale).weld * 10;
  const boxes = cutters.map(m => m.bbox());
  const taken = new Array(cutters.length).fill(false);
  const groups = [];
  for (let i = 0; i < cutters.length; i++) {
    if (taken[i]) continue;
    const g = [i]; taken[i] = true;
    for (let j = i + 1; j < cutters.length; j++) {
      if (taken[j]) continue;
      let ok = true;
      for (const k of g) if (!boxesApart(boxes[k], boxes[j], margin)) { ok = false; break; }
      if (ok) { g.push(j); taken[j] = true; }
    }
    groups.push(g);
  }

  let acc = base;
  for (const g of groups) {
    if (!acc.triCount) return new Mesh();
    acc = subtract(acc, g.length === 1 ? cutters[g[0]] : Mesh.merge(g.map(k => cutters[k])));
  }
  return acc;
}

/** m1 ∩ m2 ∩ … — folded left, since every step can only shrink the accumulator. */
export function intersectAll(meshes) {
  const list = operandList(meshes, 'intersectAll');
  if (!list.length) return new Mesh();
  if (list.length === 1) return cleanCopy(list[0]);
  let acc = list[0];
  for (let i = 1; i < list.length; i++) {
    acc = intersect(acc, list[i]);
    if (!acc.triCount) return new Mesh();
  }
  return acc;
}

export default { union, subtract, intersect, unionAll, subtractAll, intersectAll };
