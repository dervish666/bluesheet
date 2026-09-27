// builders — 2D to 3D, and the primitive set.
//
// Everything in Bluesheet that is not a mesh boolean comes through this file: a
// cross-section becomes a solid by extruding it, revolving it, lofting between
// several of them, or sweeping one along a path; and the handful of primitives
// that generators lean on are built from the same machinery.
//
// CONVENTIONS (all of them, in one place, because every function obeys them)
//
//   * Millimetres. Z up.
//   * A RING is [[x,y], ...], implicitly closed, no repeated last point.
//     A SHAPE is [outerRing, ...holeRings]. Every entry point here also accepts
//     a bare ring (treated as a shape with no holes) or a shape[] (several
//     islands, extruded together into one mesh).
//   * Input winding does not matter: rings are normalised on the way in — outer
//     counter-clockwise, holes clockwise — so the material is always on the LEFT
//     of the direction of travel and one wall rule serves every ring.
//   * Output winding is counter-clockwise seen from OUTSIDE, so `mesh.volume()`
//     is positive and normals point out of the material.
//   * Every primitive is centred in X/Y with its base at z = 0 unless its own
//     docstring says otherwise, and every one takes `z0` to move that base.
//   * Segment counts are chosen to look right on a 40 mm object and are all
//     multiplied by `opts.segFactor` (or `opts.ctx.segFactor`), which is 0.5 /
//     1 / 2 for draft / normal / fine. Pass raw counts and let segFactor scale
//     them; do not pre-multiply.
//   * Watertight is not a goal, it is the contract. The only ways to get an
//     open mesh out of this module are the documented opt-outs —
//     `capTop:false`, `capBottom:false`, `capEnds:false`, `capped:false`,
//     `solid:false` — and each says so where it is defined.
//   * Errors are thrown, never swallowed. A degenerate input (zero height, a
//     two-point ring, a self-crossing profile, a negative radius) raises an
//     Error naming the offending value. Nothing here returns a broken mesh.
//
// No DOM, no dependencies beyond mesh.js and poly2d.js.

import { Mesh, TAU } from './mesh.js';
import {
  triangulate, ensureCCW, ensureCW, signedArea, reverse, transformRing, offset,
  pointInRing, circle, rect, regularPolygon, chamferRect,
} from './poly2d.js';

export { TAU };

// "Two coordinates are the same point" at printer scale: a nanometre. Six
// orders of magnitude below anything an FDM machine can express, and far above
// double-precision noise on a 200 mm part.
const EPS = 1e-9;
const AREA_EPS = 1e-14;

function req(cond, msg) { if (!cond) throw new Error(`builders: ${msg}`); }

/** Guard the numbers before they turn into NaN coordinates nobody can trace. */
function num(v, name) {
  req(typeof v === 'number' && isFinite(v), `${name} must be a finite number (got ${v})`);
  return v;
}
function pos(v, name) {
  num(v, name);
  req(v > 0, `${name} must be positive (got ${v})`);
  return v;
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

/** opts.segFactor, or opts.ctx.segFactor, or 1. Clamped to something sane. */
export function segFactorOf(opts = {}) {
  const raw = opts.segFactor !== undefined ? opts.segFactor
    : (opts.ctx && opts.ctx.segFactor !== undefined ? opts.ctx.segFactor : 1);
  num(raw, 'segFactor');
  req(raw > 0, `segFactor must be positive (got ${raw})`);
  return Math.min(8, raw);
}

/** A segment count scaled by segFactor and floored at `min`.
 *
 *  Exported because joint.js has to reproduce `sphere()`'s latitudes exactly to
 *  put a stalk on a ball without a boolean, and a second copy of this formula
 *  is a copy that drifts. Generators keep their own `nseg` on purpose — the
 *  variants are not equivalent (see scalar.js) — but a caller reproducing a
 *  builder's own tessellation must use the builder's own arithmetic. */
export function nseg(count, sf, min = 3) {
  num(count, 'segment count');
  return Math.max(min, Math.round(count * sf));
}

// ---------------------------------------------------------------------------
// Easing — applied to twist and taper along an extrusion, never to z itself.
// ---------------------------------------------------------------------------

export const EASINGS = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
};

function easingFn(e) {
  if (e === undefined || e === null) return EASINGS.linear;
  if (typeof e === 'function') return e;
  const f = EASINGS[e];
  req(!!f, `unknown easing "${e}" (${Object.keys(EASINGS).join(', ')} or a function)`);
  return f;
}
const isCurvedEasing = (e) => e !== undefined && e !== null && e !== 'linear' && e !== EASINGS.linear;

// ---------------------------------------------------------------------------
// Ring hygiene
// ---------------------------------------------------------------------------

function depthOf(x) { let d = 0, c = x; while (Array.isArray(c)) { d++; c = c[0]; } return d; }

/** Drop consecutive duplicate points, and a last point that repeats the first. */
function dedupeRing(ring, eps = EPS) {
  const out = [];
  for (const p of ring) {
    req(Array.isArray(p) && p.length >= 2, 'a ring point must be [x, y]');
    num(p[0], 'ring x'); num(p[1], 'ring y');
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) <= eps && Math.abs(q[1] - p[1]) <= eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
    else break;
  }
  return out;
}

/**
 * ring | shape | shape[] -> shape[], every ring deduped, non-degenerate, and
 * wound outer-CCW / holes-CW. Throws on anything that cannot become a solid:
 * fewer than three distinct points, or a ring with no area.
 */
function normShapes(input, label = 'shape', { check = true } = {}) {
  req(Array.isArray(input) && input.length, `${label} is empty`);
  const d = depthOf(input);
  req(d >= 2, `${label} must be a ring [[x,y],...], a shape, or a shape[]`);
  const raw = d <= 2 ? [[input]] : d === 3 ? [input] : input;
  const out = [];
  for (const shape of raw) {
    const rings = [];
    for (let i = 0; i < shape.length; i++) {
      const r = dedupeRing(shape[i]);
      req(r.length >= 3, `${label} ring ${i} has ${r.length} distinct point(s); a ring needs at least 3`);
      // Crossing first, area second: a bow tie's two lobes cancel exactly, so
      // the area test would report it as "collinear" and send the caller
      // looking in the wrong place.
      if (check) {
        const hit = ringSelfIntersects(r);
        req(!hit, hit && `${label} ring ${i} ${hit.kind === 'spike' ? 'folds back on itself'
          : hit.kind === 'overlap' ? 'lies on top of itself' : 'crosses itself'} ` +
          `(segment ${hit.i} against segment ${hit.j}, near ${hit.at.map(v => v.toFixed(3)).join(', ')})`);
      }
      const a = signedArea(r);
      req(Math.abs(a) > AREA_EPS, `${label} ring ${i} has zero area (${r.length} collinear points)`);
      rings.push(i === 0 ? (a < 0 ? reverse(r) : r) : (a > 0 ? reverse(r) : r));
    }
    out.push(rings);
  }
  req(out.length, `${label} contains no usable rings`);
  return out;
}

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/**
 * Does a closed ring fold onto itself?
 *
 * Three things count, and nothing else: two segment interiors crossing, two
 * non-adjacent collinear segments overlapping, and a vertex where the ring
 * reverses exactly back along the segment it arrived on (a zero-width spike,
 * which extrudes into two coincident wall quads and is non-manifold the moment
 * it is welded).
 *
 * Segments that merely TOUCH at a shared vertex are left alone deliberately: an
 * offset or a rounded path can legitimately produce a pinch point, and
 * rejecting those would refuse generators that are in fact fine, while a proper
 * crossing is never anything but a mistake.
 *
 * Sorted by minimum x with an active list, so the usual case is O(n log n)
 * rather than the O(n²) of all-pairs; it exits on the first fold found.
 *
 * @returns {null|{kind:'crossing'|'overlap'|'spike', i:number, j:number,
 *           at:[number,number]}} — null when the ring is clean.
 */
export function ringSelfIntersects(ring, { eps = 0 } = {}) {
  const n = ring.length;
  if (n < 3) return null;
  const seg = (i) => [ring[i], ring[(i + 1) % n]];
  // Spikes: an O(n) pass, and cheaper than the sweep it precedes.
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    if (Math.abs(ux * vy - uy * vx) <= eps && ux * vx + uy * vy < 0) {
      return { kind: 'spike', i: (i - 1 + n) % n, j: i, at: [b[0], b[1]] };
    }
  }
  if (n < 4) return null;

  // Sweep along whichever axis leaves the shorter intervals relative to the
  // ring's own extent: sorting a comb of vertical teeth by x puts every tooth
  // in the active list at once, and sorting the same comb by y does not.
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  let spanX = 0, spanY = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = seg(i);
    spanX += Math.abs(b[0] - a[0]); spanY += Math.abs(b[1] - a[1]);
    if (a[0] < bb[0]) bb[0] = a[0];
    if (a[1] < bb[1]) bb[1] = a[1];
    if (a[0] > bb[2]) bb[2] = a[0];
    if (a[1] > bb[3]) bb[3] = a[1];
  }
  const rx = bb[2] - bb[0] || 1, ry = bb[3] - bb[1] || 1;
  const AX = (spanX / rx) <= (spanY / ry) ? 0 : 1, CX = 1 - AX;

  const lo = new Float64Array(n), hi = new Float64Array(n);
  const clo = new Float64Array(n), chi = new Float64Array(n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = seg(i);
    lo[i] = Math.min(a[AX], b[AX]) - eps; hi[i] = Math.max(a[AX], b[AX]) + eps;
    clo[i] = Math.min(a[CX], b[CX]) - eps; chi[i] = Math.max(a[CX], b[CX]) + eps;
    order[i] = i;
  }
  order.sort((p, q) => lo[p] - lo[q]);

  // Two segments are "on the same line" when every endpoint is within EPS of
  // the other segment's line — a nanometre, not exactly zero. arcRing's bridged
  // full turn folds back on itself along a seam whose two halves differ in the
  // last bit of a cosine, and an exact test walks straight past it.
  const collinear = (a, b, c, d) => Math.abs(d) <= EPS * Math.max(1e-12, Math.hypot(b[0] - a[0], b[1] - a[1]));

  const active = [];
  let live = 0;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    live = 0;
    for (let k = 0; k < active.length; k++) {
      const j = active[k];
      if (hi[j] < lo[i]) continue;                       // expired: drop it
      active[live++] = j;
      if (chi[j] < clo[i] || chi[i] < clo[j]) continue;  // no overlap on the other axis
      if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;   // adjacent
      const [p1, p2] = seg(i), [q1, q2] = seg(j);
      const e1 = orient(q1, q2, p1), e2 = orient(q1, q2, p2);
      const e3 = orient(p1, p2, q1), e4 = orient(p1, p2, q2);
      const c1 = collinear(q1, q2, p1, e1), c2 = collinear(q1, q2, p2, e2);
      const c3 = collinear(p1, p2, q1, e3), c4 = collinear(p1, p2, q2, e4);
      if (!c1 && !c2 && !c3 && !c4 && ((e1 > 0) !== (e2 > 0)) && ((e3 > 0) !== (e4 > 0))) {
        const t = e1 / (e1 - e2);
        return { kind: 'crossing', i: Math.min(i, j), j: Math.max(i, j),
                 at: [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t] };
      }
      // Collinear overlap: not a crossing by the sign test, still a fold.
      // Measured along the segments' own dominant axis — two horizontal
      // segments share no y interval at all, and testing both axes would miss
      // every axis-aligned doubling back.
      if (c1 && c2 && c3 && c4) {
        const ax = Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? 0 : 1;
        const s0 = Math.max(Math.min(p1[ax], p2[ax]), Math.min(q1[ax], q2[ax]));
        const s1 = Math.min(Math.max(p1[ax], p2[ax]), Math.max(q1[ax], q2[ax]));
        if (s1 - s0 > EPS) {
          const t2 = Math.abs(p2[ax] - p1[ax]) > EPS ? (s0 - p1[ax]) / (p2[ax] - p1[ax]) : 0;
          return { kind: 'overlap', i: Math.min(i, j), j: Math.max(i, j),
                   at: [p1[0] + (p2[0] - p1[0]) * t2, p1[1] + (p2[1] - p1[1]) * t2] };
        }
      }
    }
    active.length = live;
    active.push(i);
  }
  return null;
}

/**
 * Resample a closed ring to exactly `n` points.
 *
 * Growing a ring KEEPS every original vertex and distributes the new points
 * over the edges in proportion to their length (largest remainder), so a
 * 4-point rectangle grown to 64 still has square corners — a plain arc-length
 * resample would slide the corners off and round the box. Shrinking cannot keep
 * them and falls back to equal arc-length spacing from ring[0].
 */
export function resampleRingTo(ring, n) {
  const src = dedupeRing(ring);
  req(src.length >= 3, `resampleRingTo needs a ring of 3+ points (got ${src.length})`);
  req(Number.isFinite(n) && n >= 3, `resampleRingTo needs n >= 3 (got ${n})`);
  const target = Math.round(n);
  const m = src.length;
  if (target === m) return src.map(p => [p[0], p[1]]);

  const lens = [], total = [0];
  let per = 0;
  for (let i = 0; i < m; i++) {
    const a = src[i], b = src[(i + 1) % m];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(l); per += l; total.push(per);
  }
  req(per > 0, 'resampleRingTo: ring has zero perimeter');

  if (target > m) {
    const extra = target - m;
    const quota = lens.map(l => extra * l / per);
    const counts = quota.map(q => Math.floor(q));
    let left = extra - counts.reduce((a, b) => a + b, 0);
    const rema = quota.map((q, i) => ({ i, f: q - Math.floor(q) })).sort((a, b) => b.f - a.f || a.i - b.i);
    for (let k = 0; k < left; k++) counts[rema[k % rema.length].i]++;
    const out = [];
    for (let i = 0; i < m; i++) {
      const a = src[i], b = src[(i + 1) % m];
      out.push([a[0], a[1]]);
      const c = counts[i];
      for (let k = 1; k <= c; k++) {
        const t = k / (c + 1);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }
  // Shrinking: equal arc length from ring[0].
  const out = [];
  let e = 0;
  for (let k = 0; k < target; k++) {
    const d = per * k / target;
    while (e < m - 1 && total[e + 1] < d) e++;
    const t = lens[e] > 0 ? (d - total[e]) / lens[e] : 0;
    const a = src[e], b = src[(e + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mesh assembly helpers
// ---------------------------------------------------------------------------

/**
 * One quad of a side wall, collapsing safely.
 *
 * Sweeps and revolves routinely produce a quad with one edge of zero length —
 * the pole of a sphere, the apex of a cone, a profile point sitting on the axis
 * of revolution. Emitting the quad anyway leaves two zero-area triangles that
 * weld into non-manifold junk; skipping the whole quad leaves a hole. The right
 * answer is a triangle, and it falls out of removing repeated indices from the
 * four-vertex ring.
 */
function addQuadSafe(m, a, b, c, d) {
  const dupes = (a === b ? 1 : 0) + (b === c ? 1 : 0) + (c === d ? 1 : 0) + (d === a ? 1 : 0);
  if (dupes === 0) { m.addQuad(a, b, c, d); return; }
  if (dupes > 1) return;               // two collapsed edges leave no triangle
  if (a === b) m.addTri(a, c, d);
  else if (b === c) m.addTri(a, b, d);
  else m.addTri(a, b, c);              // c === d, or d === a
}

/**
 * The wall between two copies of the same ring, `lower` swept to `upper`.
 * With the ring wound so the material is on its left and `upper` on the far
 * side of the direction of travel, this winds counter-clockwise seen from
 * outside — the one rule that serves extrude, revolve, loft and sweep alike.
 */
function wallStrip(m, lower, upper) {
  const n = lower.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    addQuadSafe(m, lower[k], lower[k2], upper[k2], upper[k]);
  }
}

/** Add a ring of 2D points at height z; returns the new vertex indices. */
function addRing(m, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

/**
 * Triangulate a shape once and return an index buffer expressed in "flat
 * position within the concatenated rings" — exactly the order addRing produces
 * — so the same triangulation can cap the bottom and the top of an extrusion
 * without triangulating twice or matching coordinates.
 */
function capIndices(shape) {
  const t = triangulate(shape);
  req(t.tris.length > 0, 'cap triangulation produced no triangles (degenerate cross-section)');
  return t.tris;
}

/** Emit a cap from a flat index buffer. `up` false reverses the winding. */
function addCap(m, verts, tris, up) {
  for (let i = 0; i < tris.length; i += 3) {
    if (up) m.addTri(verts[tris[i]], verts[tris[i + 1]], verts[tris[i + 2]]);
    else m.addTri(verts[tris[i + 2]], verts[tris[i + 1]], verts[tris[i]]);
  }
}

// ---------------------------------------------------------------------------
// extrude
// ---------------------------------------------------------------------------

/**
 * Sweep a 2D shape straight up.
 *
 * @param shape   ring | shape | shape[] — holes and several islands both fine.
 * @param height  mm, must be > 0. To extrude downwards pass z0 = -height.
 * @param opts
 *   z0          base height, default 0.
 *   twist       total rotation in RADIANS from bottom to top. Holes twist with
 *               the outer ring, because every ring of the shape is rotated by
 *               the same amount at the same height.
 *   twistSteps  layers used for the twist; defaults to 64 per full turn, scaled
 *               by segFactor.
 *   scaleTop    scale factor at the top, about the origin (not the shape's
 *               centroid — a shape placed off-centre leans, which is what a
 *               tapered array of pockets wants).
 *   scaleTopY   Y scale at the top if it differs from scaleTop.
 *   steps       minimum number of layers; more are used when a twist or a
 *               curved easing needs them. A straight taper is exact at 1.
 *   easing      't -> t' for twist and taper against height. Name from EASINGS
 *               or a function. z itself is always linear.
 *   capBottom / capTop  default true. Setting either false returns an
 *               intentionally open mesh — the caller is building a lid or a
 *               vase and knows it.
 *   segFactor / ctx     quality multiplier.
 *   check       set false to skip the self-intersection test on the input rings
 *               (they are checked by default).
 *
 * A scaleTop of 0 collapses the top to a single apex vertex (a pyramid); with
 * holes that would weld the hole to the outline, so it is refused.
 */
export function extrude(shape, height, opts = {}) {
  const {
    z0 = 0, twist = 0, twistSteps, scaleTop = 1, scaleTopY,
    capBottom = true, capTop = true, steps = 1, easing, check = true,
  } = opts;
  num(height, 'extrude height');
  req(height > 0, `extrude height must be positive (got ${height}); to extrude downwards pass z0 = -height`);
  num(z0, 'z0'); num(twist, 'twist');
  const sx = num(scaleTop, 'scaleTop');
  const sy = num(scaleTopY === undefined ? scaleTop : scaleTopY, 'scaleTopY');
  req(sx >= 0 && sy >= 0, `extrude scale must be >= 0 (got ${sx}, ${sy})`);
  const sf = segFactorOf(opts);
  const ease = easingFn(easing);

  const islands = normShapes(shape, 'extrude shape', { check });
  const collapses = (sx <= EPS || sy <= EPS);
  if (collapses) {
    for (const rings of islands) {
      req(rings.length === 1, 'extrude cannot collapse a shape with holes to a point (scaleTop 0 with a hole)');
    }
    req(islands.length === 1, 'extrude cannot collapse several islands to one point (scaleTop 0)');
  }

  let n = Math.max(1, Math.round(num(steps, 'steps')));
  if (twist !== 0) {
    n = Math.max(n, twistSteps !== undefined
      ? Math.max(1, Math.round(num(twistSteps, 'twistSteps')))
      : nseg(Math.abs(twist) / TAU * 64, sf, 2));
  }
  if (isCurvedEasing(easing) && (twist !== 0 || sx !== 1 || sy !== 1)) n = Math.max(n, nseg(16, sf, 2));

  const m = new Mesh();
  for (const rings of islands) {
    const tris = capIndices(rings);
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n, e = ease(t);
      const z = z0 + height * t;
      const rot = twist * e;
      const kx = 1 + (sx - 1) * e, ky = 1 + (sy - 1) * e;
      let level;
      if (i === n && collapses) {
        const apex = m.addVertex(0, 0, z);
        level = rings.map(r => new Array(r.length).fill(apex));
      } else {
        level = rings.map(r => addRing(m, transformRing(r, { rot, sx: kx, sy: ky }), z));
      }
      if (i === 0) {
        if (capBottom) addCap(m, level.flat(), tris, false);
      } else {
        for (let k = 0; k < rings.length; k++) wallStrip(m, prev[k], level[k]);
      }
      prev = level;
    }
    if (capTop && !collapses) addCap(m, prev.flat(), tris, true);
  }
  return m;
}

// ---------------------------------------------------------------------------
// revolve
// ---------------------------------------------------------------------------

/**
 * Turn a profile on the lathe about the Z axis.
 *
 * @param profile ring in [r, z] — r is the distance from the axis and must be
 *                >= 0, z is height. May also be a shape whose holes become
 *                voids inside the solid (a revolved washer inside a ring).
 * @param opts
 *   segments  divisions of a FULL turn, default 96, scaled by segFactor. A
 *             partial revolve gets proportionally fewer, never below 2.
 *   from, to  sweep in radians, default a full turn. to < from is normalised;
 *             |to-from| > TAU is clamped to a full turn.
 *   capEnds   cap the two flat faces of a partial revolve, default true. A full
 *             revolve has no flat ends and ignores this.
 *   closed    default true: the profile is a closed ring. Pass false for an
 *             open lathe outline and the two ends are dropped onto the axis
 *             for you, which is how a vase profile is usually written.
 *   check     skip the self-intersection test on the profile if false.
 *
 * Two things this gets right that a naive lathe does not. A profile point at
 * r = 0 becomes ONE vertex shared by every angular station, so an axis-touching
 * profile makes a proper pole instead of a ring of coincident vertices and a
 * fan of slivers. And a full turn REUSES the first station's vertices for the
 * last one rather than emitting cos(TAU), sin(TAU) again — those differ from
 * cos(0), sin(0) in the last bits, which is a crack that welds shut at 1e-6 and
 * is a leak at 1e-9.
 */
export function revolve(profile, opts = {}) {
  const { segments = 96, from = 0, to = TAU, capEnds = true, closed = true, check = true } = opts;
  num(from, 'from'); num(to, 'to');
  const sf = segFactorOf(opts);

  let input = profile;
  if (closed === false) {
    const d = depthOf(profile);
    req(d === 2, 'revolve: closed:false expects a single open polyline [[r,z],...]');
    const p = dedupeRing(profile, 0);
    req(p.length >= 2, `revolve needs at least 2 profile points (got ${p.length})`);
    const open = p.map(q => [q[0], q[1]]);
    if (open[open.length - 1][0] > EPS) open.push([0, open[open.length - 1][1]]);
    if (open[0][0] > EPS) open.push([0, open[0][1]]);
    input = open;
  }

  const islands = normShapes(input, 'revolve profile', { check });
  for (const rings of islands) {
    for (const r of rings) for (const p of r) {
      req(p[0] >= -EPS, `revolve profile r must be >= 0 (got ${p[0]}); the profile lives in the half-plane`);
    }
  }

  let sweep = to - from;
  req(Math.abs(sweep) > 1e-12, `revolve sweep is zero (from ${from}, to ${to})`);
  let start = from;
  if (Math.abs(sweep) > TAU) sweep = Math.sign(sweep) * TAU;
  if (sweep < 0) { start += sweep; sweep = -sweep; }
  const full = sweep >= TAU - 1e-12;
  const steps = full ? nseg(segments, sf, 3)
    : Math.max(2, Math.round(nseg(segments, sf, 3) * sweep / TAU));

  const m = new Mesh();
  for (const rings of islands) {
    // Walls want the profile wound clockwise in the (r,z) plane: (r, z, theta)
    // is a left-handed ordering, so the winding that means "material on the
    // left" here is the mirror of the one that means it in (x, y, z).
    const wallRings = rings.map((r, i) => (i === 0 ? ensureCW(r) : ensureCCW(r)));
    // Caps are triangulated from the same point list, and triangulate always
    // returns counter-clockwise triangles in the plane it is given, which in
    // (r,z) points along -theta — outward at the start of the sweep.
    const tris = capIndices(wallRings);

    const axisVert = new Map();          // "ring:point" -> the one vertex on the axis
    const stations = [];
    for (let j = 0; j <= steps; j++) {
      if (full && j === steps) { stations.push(stations[0]); break; }   // reuse, never re-emit
      const a = start + sweep * (j / steps);
      const ca = Math.cos(a), sa = Math.sin(a);
      stations.push(wallRings.map((ring, ri) => {
        const idx = new Array(ring.length);
        for (let k = 0; k < ring.length; k++) {
          const r = ring[k][0], z = ring[k][1];
          if (r <= EPS) {
            // On the axis: one vertex for every station. Made once per
            // (ring, point) and reused — this is what kills the sliver fan.
            const key = `${ri}:${k}`;
            let v = axisVert.get(key);
            if (v === undefined) { v = m.addVertex(0, 0, z); axisVert.set(key, v); }
            idx[k] = v;
          } else {
            idx[k] = m.addVertex(r * ca, r * sa, z);
          }
        }
        return idx;
      }));
    }

    for (let j = 0; j + 1 < stations.length; j++) {
      for (let ri = 0; ri < wallRings.length; ri++) wallStrip(m, stations[j][ri], stations[j + 1][ri]);
    }
    if (!full && capEnds) {
      addCap(m, stations[0].flat(), tris, true);
      addCap(m, stations[stations.length - 1].flat(), tris, false);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// loft
// ---------------------------------------------------------------------------

/**
 * Skin a stack of cross-sections.
 *
 * @param sections [{shape, z, rot, scale}] — two or more. `shape` is a ring, a
 *                 shape, or anything normShapes accepts; `rot` is radians about
 *                 the origin at that height; `scale` is a number or [sx, sy].
 *                 Sections may have different vertex counts: every ring is
 *                 resampled to the largest count in its own position.
 * @param opts
 *   capBottom / capTop  default true (ignored when closed).
 *   closed    default false. True wraps the last section back to the first and
 *             caps nothing — a tube built from ring→ring→ring→ring rather than
 *             a stack.
 *   samples   force a specific resample count for every ring.
 *   align     'auto' (default) rotates each section's vertex correspondence to
 *             the shift that minimises travel from the section below, which is
 *             what stops a circle-to-square loft from spiralling. 'index' pairs
 *             vertex 0 to vertex 0 and does what you asked for.
 *             An explicit `rot` is never eaten by the alignment: sections are
 *             aligned before their rotation is applied, so a 90° `rot` on a
 *             square still gives you a 90° twist.
 *
 * Section z values must be monotonic (either direction) for an open loft; a
 * closed one may do as it likes. Every section must have the same number of
 * rings — you cannot loft a plate into a plate-with-a-hole, because there is no
 * honest answer for where the hole comes from.
 */
export function loft(sections, opts = {}) {
  const { capBottom = true, capTop = true, closed = false, samples, align = 'auto', check = true } = opts;
  req(Array.isArray(sections) && sections.length >= 2, `loft needs at least 2 sections (got ${sections && sections.length})`);
  req(align === 'auto' || align === 'index', `loft: unknown align "${align}" (auto|index)`);

  let list = sections.map((s, i) => {
    req(s && s.shape, `loft section ${i} has no shape`);
    const rings = normShapes(s.shape, `loft section ${i}`, { check });
    req(rings.length === 1, `loft section ${i} has ${rings.length} islands; loft takes one island per section`);
    return { rings: rings[0], z: num(s.z === undefined ? i : s.z, `loft section ${i} z`),
             rot: num(s.rot || 0, `loft section ${i} rot`), scale: s.scale === undefined ? 1 : s.scale };
  });

  if (!closed) {
    let up = true, down = true;
    for (let i = 1; i < list.length; i++) {
      if (!(list[i].z > list[i - 1].z)) up = false;
      if (!(list[i].z < list[i - 1].z)) down = false;
    }
    req(up || down, 'loft section z values must be monotonic — strictly increasing or strictly decreasing (or pass closed:true)');
    if (down) list = list.slice().reverse();
  }

  const ringCount = list[0].rings.length;
  for (const s of list) req(s.rings.length === ringCount, `loft: every section needs the same number of rings (${ringCount})`);

  // One resample count per ring position, then a per-section cyclic shift.
  const counts = [];
  for (let k = 0; k < ringCount; k++) {
    let c = samples !== undefined ? Math.round(num(samples, 'samples')) : 0;
    if (!c) for (const s of list) c = Math.max(c, s.rings[k].length);
    req(c >= 3, `loft ring ${k} resamples to ${c} points`);
    counts.push(c);
  }

  const levels = list.map((s) => {
    const sxy = Array.isArray(s.scale) ? s.scale : [s.scale, s.scale];
    num(sxy[0], 'loft scale x'); num(sxy[1], 'loft scale y');
    req(sxy[0] > 0 && sxy[1] > 0, `loft scale must be positive (got ${sxy})`);
    return s.rings.map((r, k) => transformRing(resampleRingTo(r, counts[k]), { sx: sxy[0], sy: sxy[1] }));
  });

  if (align === 'auto') {
    // Each section is aligned to the one below it, on the shape BEFORE its own
    // rot is applied, so the chain removes accidental start-point drift without
    // ever eating a rotation the caller asked for.
    for (let i = 1; i < levels.length; i++) {
      for (let k = 0; k < ringCount; k++) levels[i][k] = alignRing(levels[i - 1][k], levels[i][k]);
    }
  }

  const m = new Mesh();
  const placed = levels.map((rings, i) => rings.map(r => transformRing(r, { rot: list[i].rot })));
  const idx = placed.map((rings, i) => rings.map(r => addRing(m, r, list[i].z)));

  const last = idx.length - (closed ? 0 : 1);
  for (let i = 0; i < last; i++) {
    const a = idx[i], b = idx[(i + 1) % idx.length];
    for (let k = 0; k < ringCount; k++) wallStrip(m, a[k], b[k]);
  }
  if (!closed) {
    if (capBottom) addCap(m, idx[0].flat(), capIndices(placed[0]), false);
    if (capTop) addCap(m, idx[idx.length - 1].flat(), capIndices(placed[placed.length - 1]), true);
  }
  return m;
}

/**
 * Rotate `ring`'s starting index to the cyclic shift closest to `ref`.
 * Both are normalised (centroid removed, RMS radius 1) before comparing, so a
 * 5 mm section aligns to a 50 mm one on shape rather than on size.
 *
 * The exhaustive search is O(n²), which is instant to a few hundred points and
 * a stall at a few thousand. Above that it goes coarse-to-fine — the best shift
 * on a 128-point decimation, then an exact search of the stride either side of
 * it — rather than giving up on alignment, because giving up is invisible: the
 * loft still builds, it is just quietly spiralled. (A 800-point ring rolled by
 * 300 lofts to 43% of its true volume when alignment is skipped.)
 */
function alignRing(ref, ring) {
  const n = ring.length;
  if (ref.length !== n || n < 3) return ring;
  const norm = (r) => {
    let cx = 0, cy = 0;
    for (const p of r) { cx += p[0]; cy += p[1]; }
    cx /= r.length; cy /= r.length;
    let s = 0;
    for (const p of r) s += (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    const k = s > 0 ? Math.sqrt(r.length / s) : 1;
    return r.map(p => [(p[0] - cx) * k, (p[1] - cy) * k]);
  };
  const A = norm(ref), B = norm(ring);
  const dist = (shift, stride) => {
    let d = 0;
    for (let i = 0; i < n; i += stride) {
      const b = B[(i + shift) % n];
      d += (A[i][0] - b[0]) ** 2 + (A[i][1] - b[1]) ** 2;
    }
    return d;
  };
  const stride = n > 256 ? Math.ceil(n / 128) : 1;
  let best = 0, bestD = Infinity;
  for (let s = 0; s < n; s += stride) {
    const d = dist(s, stride);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (stride > 1) {
    let fine = best, fineD = Infinity;
    for (let s = best - stride; s <= best + stride; s++) {
      const d = dist((s + n) % n, 1);
      if (d < fineD) { fineD = d; fine = (s + n) % n; }
    }
    best = fine;
  }
  if (!best) return ring;
  return ring.slice(best).concat(ring.slice(0, best));
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

/**
 * Rotation-minimising frames along a path.
 *
 * Frenet frames are not used here and never should be: the Frenet normal points
 * at the centre of curvature, so it FLIPS through 180° at every inflection
 * point and spins wildly where the path is briefly straight. A swept solid
 * built on them tears itself inside out at exactly the places a handle or a
 * hook needs to be smooth. This is the double-reflection method (Wang, Jüttler,
 * Zheng, Liu 2008): the frame is carried along by two reflections per segment,
 * which is exact for a circular arc and second-order accurate elsewhere, and
 * costs a dozen multiplies per station.
 *
 * @param path  [[x,y,z], ...]
 * @param opts  closed (wrap and close the frame up on itself), upHint (the
 *              direction the section's +Y should lean towards at the start,
 *              default +Z), twist (total extra rotation in radians along the
 *              whole path).
 * @returns [{p, t, n, b}] — p position, t unit tangent, n and b the section
 *          axes, with (n, b, t) right-handed.
 */
export function parallelFrames(path, opts = {}) {
  const { closed = false, upHint, twist = 0 } = opts;
  const pts = dedupePath(path);
  req(pts.length >= 2, `parallelFrames needs at least 2 distinct points (got ${pts.length})`);
  num(twist, 'twist');
  const n = pts.length;

  const tangents = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (closed) t = sub(pts[(i + 1) % n], pts[(i - 1 + n) % n]);
    else if (i === 0) t = sub(pts[1], pts[0]);
    else if (i === n - 1) t = sub(pts[n - 1], pts[n - 2]);
    else t = sub(pts[i + 1], pts[i - 1]);
    const l = len(t);
    req(l > EPS, `parallelFrames: path doubles back exactly at point ${i}`);
    tangents.push(scl(t, 1 / l));
  }

  const up = upHint || [0, 0, 1];
  let n0 = sub(up, scl(tangents[0], dot(up, tangents[0])));
  if (len(n0) < 1e-6) {
    const alt = Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    n0 = sub(alt, scl(tangents[0], dot(alt, tangents[0])));
  }
  n0 = unit(n0);

  const normals = [n0];
  const steps = closed ? n : n - 1;
  for (let i = 0; i < steps; i++) {
    const i2 = (i + 1) % n;
    const v1 = sub(pts[i2], pts[i]);
    const c1 = dot(v1, v1);
    let nL = normals[i], tL = tangents[i];
    if (c1 > 0) {
      nL = sub(normals[i], scl(v1, 2 * dot(v1, normals[i]) / c1));
      tL = sub(tangents[i], scl(v1, 2 * dot(v1, tangents[i]) / c1));
    }
    const v2 = sub(tangents[i2], tL);
    const c2 = dot(v2, v2);
    const nx = c2 > 1e-20 ? sub(nL, scl(v2, 2 * dot(v2, nL) / c2)) : nL;
    if (closed && i === steps - 1) {
      // Closing the loop: the transported normal comes back rotated by some
      // residual angle about the tangent. Spread its negative over the path so
      // the frame meets itself; the residual is taken in (-pi, pi] so we undo
      // the mismatch rather than adding a spurious whole turn.
      const t0 = tangents[0], f = unit(sub(nx, scl(t0, dot(nx, t0))));
      const b0 = cross(t0, normals[0]);
      const ang = Math.atan2(dot(f, b0), dot(f, normals[0]));
      for (let k = 0; k < n; k++) normals[k] = rotAbout(normals[k], tangents[k], -ang * k / n);
    } else {
      normals.push(unit(nx));
    }
  }

  // Extra twist is spread along the path by ARC LENGTH, not by station index:
  // a path whose points bunch up round a corner would otherwise do most of its
  // twisting in the corner.
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = cum[n - 1] + (closed ? len(sub(pts[0], pts[n - 1])) : 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const extra = total > 0 ? twist * cum[i] / total : 0;
    const nn = extra ? rotAbout(normals[i], tangents[i], extra) : normals[i];
    out.push({ p: pts[i], t: tangents[i], n: nn, b: cross(tangents[i], nn) });
  }
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function rotAbout(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * dot(axis, v) * (1 - c),
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * dot(axis, v) * (1 - c),
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * dot(axis, v) * (1 - c),
  ];
}

function dedupePath(path) {
  req(Array.isArray(path) && path.length >= 2, `path needs at least 2 points (got ${path && path.length})`);
  const out = [];
  for (const p of path) {
    req(Array.isArray(p) && p.length >= 3, 'a path point must be [x, y, z]');
    num(p[0], 'path x'); num(p[1], 'path y'); num(p[2], 'path z');
    const q = out[out.length - 1];
    if (q && Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= EPS) continue;
    out.push([p[0], p[1], p[2]]);
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= EPS) out.pop();
  }
  return out;
}

/**
 * Sweep a 2D shape along a 3D path.
 *
 * The section sits in the frame's (n, b) plane — shape x along n, shape y along
 * b — and the frames are rotation-minimising (see parallelFrames), so the solid
 * does not twist through inflection points the way a Frenet sweep does.
 *
 * @param opts
 *   twist    total extra rotation in radians, spread along the path by arc
 *            length. The path is subdivided (which does not move it — the
 *            extra points are collinear) so no single step turns more than
 *            about 6°. On a closed path only a multiple of a full turn meets
 *            itself without shearing the seam.
 *   capEnds  default true; ignored on a closed path, which has no ends.
 *   upHint   which way the section's +Y leans at the start, default +Z.
 *   closed   default: auto — a path whose last point repeats its first is
 *            treated as closed, and the frame is made to close up on itself so
 *            the seam matches instead of leaving a hairline step.
 *   check    skip the self-intersection test on the section if false.
 *
 * The path is not checked for whether the swept solid intersects itself: a
 * radius of curvature tighter than the section is the caller's business, and
 * validate.js is where that gets caught.
 */
export function sweep(shape, path, opts = {}) {
  const { twist = 0, capEnds = true, upHint, closed, check = true } = opts;
  let pts = dedupePath(path);
  let isClosed;
  if (closed === undefined) {
    const a = path[0], b = path[path.length - 1];
    isClosed = path.length > 2 && Array.isArray(a) && Array.isArray(b) &&
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-6;
  } else isClosed = !!closed;
  req(pts.length >= (isClosed ? 3 : 2), `sweep needs at least ${isClosed ? 3 : 2} distinct path points (got ${pts.length})`);

  // A twist needs stations to happen at. Extruding solves this with twistSteps;
  // here the path supplies the stations, and a caller who asks for half a turn
  // along a three-point path would otherwise get a section rotated 90° between
  // neighbours — a solid folded through itself, watertight and meaningless.
  // Subdividing a polyline segment adds collinear points, so the path itself is
  // untouched.
  if (twist !== 0) {
    const perStep = TAU / nseg(64, segFactorOf(opts), 8);
    const want = Math.ceil(Math.abs(twist) / perStep);
    const spans = pts.length - (isClosed ? 0 : 1);
    const div = Math.ceil(want / spans);
    if (div > 1) {
      const fine = [];
      for (let i = 0; i < spans; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        for (let k = 0; k < div; k++) {
          const t = k / div;
          fine.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        }
      }
      if (!isClosed) fine.push(pts[pts.length - 1]);
      pts = fine;
    }
  }

  const frames = parallelFrames(pts, { closed: isClosed, upHint, twist });
  const islands = normShapes(shape, 'sweep shape', { check });

  const m = new Mesh();
  for (const rings of islands) {
    const tris = capIndices(rings);
    const levels = frames.map(f => rings.map((r) => {
      const idx = new Array(r.length);
      for (let i = 0; i < r.length; i++) {
        const x = r[i][0], y = r[i][1];
        idx[i] = m.addVertex(
          f.p[0] + f.n[0] * x + f.b[0] * y,
          f.p[1] + f.n[1] * x + f.b[1] * y,
          f.p[2] + f.n[2] * x + f.b[2] * y);
      }
      return idx;
    }));
    const last = levels.length - (isClosed ? 0 : 1);
    for (let i = 0; i < last; i++) {
      const a = levels[i], b = levels[(i + 1) % levels.length];
      for (let k = 0; k < rings.length; k++) wallStrip(m, a[k], b[k]);
    }
    if (!isClosed && capEnds) {
      addCap(m, levels[0].flat(), tris, false);
      addCap(m, levels[levels.length - 1].flat(), tris, true);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// heightfield
// ---------------------------------------------------------------------------

/**
 * A grid of samples becomes a solid: terrain tiles, lithophanes, data surfaces.
 *
 * @param field {w, h, data} — data is row-major, data[y*w + x], length w*h,
 *              a number[] or a Float32Array. Row 0 is at -Y; pass flipY for
 *              image data, which counts rows the other way.
 * @param opts
 *   sx, sy   footprint in mm. Default: sx = w mm (one sample per mm) and sy
 *            chosen to keep the samples square.
 *   zScale   mm per unit of data, must be > 0. To invert a field (a lithophane
 *            wants dark = thick) invert the data, not the scale.
 *   base     material below the LOWEST sample, default 1 mm. This is why an
 *            all-flat field still produces a printable plate instead of a
 *            zero-height nothing.
 *   baseZ    z of the underside, default 0.
 *   skirt    default true: vertical side walls down to a flat bottom — the
 *            terrain-tile look. False drapes the surface at constant thickness
 *            `base` instead, which uses a fraction of the filament and is still
 *            watertight.
 *   solid    default true. False returns the top surface ALONE — an open sheet,
 *            not a solid, for preview and for callers who will close it
 *            themselves. It is the one documented way this function returns
 *            something with boundary edges.
 *   flipY    treat row 0 as +Y (image order).
 *   centred  default true: centred on the origin. False puts the corner at
 *            (0, 0).
 */
export function heightfield(field, opts = {}) {
  req(field && typeof field === 'object', 'heightfield needs a {w, h, data} field');
  const w = Math.round(num(field.w, 'field.w')), h = Math.round(num(field.h, 'field.h'));
  req(w >= 2 && h >= 2, `heightfield needs at least a 2x2 grid (got ${w}x${h})`);
  const data = field.data;
  req(data && data.length === w * h, `heightfield data has ${data && data.length} samples, expected ${w * h}`);

  const {
    zScale = 1, base = 1, baseZ = 0, skirt = true, solid = true,
    flipY = false, centred = true,
  } = opts;
  pos(zScale, 'zScale');
  num(base, 'base'); num(baseZ, 'baseZ');
  req(base >= 0, `heightfield base must be >= 0 (got ${base})`);
  const sx = opts.sx !== undefined ? pos(opts.sx, 'sx') : w;
  const sy = opts.sy !== undefined ? pos(opts.sy, 'sy') : sx * (h - 1) / (w - 1);

  let vmin = Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    req(isFinite(v), `heightfield data[${i}] is ${v}`);
    if (v < vmin) vmin = v;
  }
  const dx = sx / (w - 1), dy = sy / (h - 1);
  const x0 = centred ? -sx / 2 : 0, y0 = centred ? -sy / 2 : 0;
  const at = (x, y) => data[(flipY ? (h - 1 - y) : y) * w + x];
  const zAt = (x, y) => baseZ + base + (at(x, y) - vmin) * zScale;

  const m = new Mesh();
  const top = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    top[y * w + x] = m.addVertex(x0 + x * dx, y0 + y * dy, zAt(x, y));
  }
  // Split each cell along its shorter diagonal so a ridge running corner to
  // corner is not stepped by the triangulation.
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const a = top[y * w + x], b = top[y * w + x + 1], c = top[(y + 1) * w + x + 1], d = top[(y + 1) * w + x];
    const za = zAt(x, y), zb = zAt(x + 1, y), zc = zAt(x + 1, y + 1), zd = zAt(x, y + 1);
    if (Math.abs(za - zc) <= Math.abs(zb - zd)) { m.addTri(a, b, c); m.addTri(a, c, d); }
    else { m.addTri(a, b, d); m.addTri(b, c, d); }
  }
  if (!solid) return m;

  // Border, counter-clockwise seen from above.
  const border = [];
  for (let x = 0; x < w; x++) border.push([x, 0]);
  for (let y = 1; y < h; y++) border.push([w - 1, y]);
  for (let x = w - 2; x >= 0; x--) border.push([x, h - 1]);
  for (let y = h - 2; y >= 1; y--) border.push([0, y]);
  const topRing = border.map(([x, y]) => top[y * w + x]);

  if (skirt) {
    const bottomRing = border.map(([x, y]) => m.addVertex(x0 + x * dx, y0 + y * dy, baseZ));
    wallStrip(m, bottomRing, topRing);
    // Fan the flat bottom from its own centre vertex. A fan from a corner would
    // put three collinear border points in one triangle and weld into a
    // degenerate; a centre vertex cannot, and every border vertex is used, which
    // is what keeps the skirt's lower edge matched.
    const c = m.addVertex(x0 + sx / 2, y0 + sy / 2, baseZ);
    for (let i = 0; i < bottomRing.length; i++) {
      m.addTri(c, bottomRing[(i + 1) % bottomRing.length], bottomRing[i]);
    }
  } else {
    req(base > 0, 'heightfield: a draped solid (skirt:false) needs base > 0 for its thickness');
    const under = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      under[y * w + x] = m.addVertex(x0 + x * dx, y0 + y * dy, zAt(x, y) - base);
    }
    for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
      const a = under[y * w + x], b = under[y * w + x + 1], c = under[(y + 1) * w + x + 1], d = under[(y + 1) * w + x];
      const za = zAt(x, y), zb = zAt(x + 1, y), zc = zAt(x + 1, y + 1), zd = zAt(x, y + 1);
      if (Math.abs(za - zc) <= Math.abs(zb - zd)) { m.addTri(a, c, b); m.addTri(a, d, c); }
      else { m.addTri(a, d, b); m.addTri(b, d, c); }
    }
    wallStrip(m, border.map(([x, y]) => under[y * w + x]), topRing);
  }
  return m;
}

// ---------------------------------------------------------------------------
// helixPath
// ---------------------------------------------------------------------------

/**
 * A helix, for threads and springs. Feed it to sweep().
 *
 * @param opts
 *   r        radius, mm.
 *   r2       radius at the top if it tapers (a conical thread), default r.
 *   pitch    rise per turn, mm.
 *   turns    number of turns; may be fractional.
 *   segments points per full turn, default 64, scaled by segFactor.
 *   z0       starting height, default 0.
 *   phase    starting angle in radians.
 *   handed   'right' (default, counter-clockwise going up — the direction of
 *            every standard screw thread) or 'left'.
 * @returns [[x,y,z], ...] with round(segments*turns)+1 points, so both ends
 *          land exactly on their intended angle.
 */
export function helixPath(opts = {}) {
  const { r, pitch, turns, segments = 64, r2, z0 = 0, phase = 0, handed = 'right' } = opts;
  pos(r, 'helix r'); num(pitch, 'helix pitch'); pos(turns, 'helix turns'); num(z0, 'z0'); num(phase, 'phase');
  req(handed === 'right' || handed === 'left', `helixPath: handed must be 'right' or 'left' (got ${handed})`);
  const rTop = r2 === undefined ? r : pos(r2, 'helix r2');
  const sf = segFactorOf(opts);
  const n = Math.max(3, Math.round(nseg(segments, sf, 3) * turns));
  const dir = handed === 'left' ? -1 : 1;
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = phase + dir * TAU * turns * t;
    const rad = r + (rTop - r) * t;
    out[i] = [rad * Math.cos(a), rad * Math.sin(a), z0 + pitch * turns * t];
  }
  return out;
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

/**
 * A walled box: extrude a shape, then hollow it from the top.
 *
 * @param shape      the outside cross-section (ring | shape).
 * @param thickness  wall thickness, mm.
 * @param height     overall height, mm.
 * @param opts
 *   floor   floor thickness, default = thickness.
 *   z0      base height, default 0.
 *   join    corner treatment for the inside face: 'round' (default), 'miter',
 *           'square', 'bevel'. A rectangular box wants 'miter' if you need the
 *           inside corners square.
 *
 * The cavity is the cross-section inset by `thickness`; if the walls are too
 * thick to leave one, or the floor is as tall as the box, you get the solid
 * extrusion instead of an error — that is a legitimate answer to "wall it in".
 *
 * The rim, the cavity and the outside all reuse the same vertices, so the
 * result is watertight without a weld. Holes in the cross-section become
 * pillars rising through the cavity to full height, and each keeps its own hole
 * through the middle.
 */
export function shell(shape, thickness, height, opts = {}) {
  const { z0 = 0, join = 'round', check = true } = opts;
  pos(thickness, 'shell thickness'); pos(height, 'shell height'); num(z0, 'z0');
  const floor = opts.floor === undefined ? thickness : num(opts.floor, 'floor');
  req(floor >= 0, `shell floor must be >= 0 (got ${floor})`);

  const islands = normShapes(shape, 'shell shape', { check });
  req(islands.length === 1, 'shell takes a single island (one outer ring and its holes)');
  const outer = islands[0];

  const cavities = floor >= height ? [] : offset(outer, -thickness, { join })
    .map(s => s.map((r, i) => (i === 0 ? ensureCCW(dedupeRing(r)) : ensureCW(dedupeRing(r)))))
    .filter(s => s[0] && s[0].length >= 3);
  if (!cavities.length) return extrude(outer, height, { z0, check: false });

  const m = new Mesh();
  const zTop = z0 + height, zFloor = z0 + floor;

  // Outside: bottom cap and walls, straight from the input rings.
  const outerTris = capIndices(outer);
  const outBot = outer.map(r => addRing(m, r, z0));
  const outTop = outer.map(r => addRing(m, r, zTop));
  addCap(m, outBot.flat(), outerTris, false);
  for (let k = 0; k < outer.length; k++) wallStrip(m, outBot[k], outTop[k]);

  // Cavity walls and floor.
  const cavTop = [], cavBot = [];
  for (const cav of cavities) {
    const wallRings = cav.map((r, i) => (i === 0 ? ensureCW(r) : ensureCCW(r)));
    const top = wallRings.map(r => addRing(m, r, zTop));
    const bot = wallRings.map(r => addRing(m, r, zFloor));
    for (let k = 0; k < wallRings.length; k++) wallStrip(m, bot[k], top[k]);
    // The cavity floor is triangulated from the SAME rings the walls used —
    // triangulate always returns counter-clockwise triangles whichever way the
    // rings were wound, so the floor faces up and its indices still line up.
    addCap(m, bot.flat(), capIndices(wallRings), true);
    cavTop.push({ rings: wallRings, idx: top });
    cavBot.push(bot);
  }

  // The rim at the top: the outside minus the cavities, assembled from the
  // rings that already exist rather than cut with a 2D boolean — a boolean
  // would snap coordinates to its own grid and leave the rim a nanometre off
  // the wall it has to meet.
  const rimRings = [outer[0]], rimIdx = [outTop[0]];
  const pillarPairs = [];
  for (let hi = 1; hi < outer.length; hi++) {
    // Which cavity hole (pillar) contains this hole of the outside?
    let found = null;
    for (let ci = 0; ci < cavities.length && !found; ci++) {
      for (let ri = 1; ri < cavities[ci].length; ri++) {
        if (pointInRing(outer[hi][0], cavities[ci][ri])) { found = { ci, ri }; break; }
      }
    }
    if (found) pillarPairs.push({ hole: hi, ...found });
    else { rimRings.push(outer[hi]); rimIdx.push(outTop[hi]); }
  }
  for (let ci = 0; ci < cavities.length; ci++) { rimRings.push(cavTop[ci].rings[0]); rimIdx.push(cavTop[ci].idx[0]); }
  addCap(m, rimIdx.flat(), capIndices(rimRings), true);

  for (const p of pillarPairs) {
    const ring = cavTop[p.ci].rings[p.ri];              // pillar outline, CCW
    const faces = [ring, outer[p.hole]];
    const idx = [cavTop[p.ci].idx[p.ri], outTop[p.hole]];
    addCap(m, idx.flat(), capIndices(faces), true);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Primitives.
//
// Every one is centred in X/Y with its base at z = 0 unless said otherwise, and
// every one takes z0 to move that base.
// ---------------------------------------------------------------------------

/**
 * A rectangular box, w × d × h, centred in X/Y, base at z0.
 * `center:false` puts its minimum corner at (0, 0) instead.
 */
export function box(w, d, h, opts = {}) {
  const { center = true, z0 = 0 } = opts;
  pos(w, 'box w'); pos(d, 'box d'); pos(h, 'box h'); num(z0, 'z0');
  const x0 = center ? -w / 2 : 0, y0 = center ? -d / 2 : 0;
  const m = new Mesh();
  const b = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]].map(p => m.addVertex(p[0], p[1], z0));
  const t = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]].map(p => m.addVertex(p[0], p[1], z0 + h));
  m.addQuad(b[3], b[2], b[1], b[0]);                 // bottom, facing -Z
  m.addQuad(t[0], t[1], t[2], t[3]);                 // top, facing +Z
  wallStrip(m, b, t);
  return m;
}

/**
 * A cylinder (or a frustum, or a cone) of radius r and height h, centred on the
 * Z axis with its base at z0.
 * `r2` is the top radius — 0 makes a proper single-vertex apex.
 * `capped:false` returns an open tube, which is deliberately not a solid.
 */
export function cylinder(r, h, opts = {}) {
  const { segments = 64, z0 = 0, capped = true } = opts;
  num(r, 'cylinder r'); pos(h, 'cylinder h'); num(z0, 'z0');
  const r2 = opts.r2 === undefined ? r : num(opts.r2, 'cylinder r2');
  req(r >= 0 && r2 >= 0, `cylinder radii must be >= 0 (got ${r}, ${r2})`);
  req(r > 0 || r2 > 0, 'cylinder needs at least one non-zero radius');
  const n = nseg(segments, segFactorOf(opts), 3);
  const m = new Mesh();
  const ring = (rad, z) => {
    if (rad <= EPS) { const v = m.addVertex(0, 0, z); return new Array(n).fill(v); }
    const idx = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = TAU * i / n;
      idx[i] = m.addVertex(rad * Math.cos(a), rad * Math.sin(a), z);
    }
    return idx;
  };
  const b = ring(r, z0), t = ring(r2, z0 + h);
  wallStrip(m, b, t);
  if (capped) {
    if (r > EPS) { const c = m.addVertex(0, 0, z0); for (let i = 0; i < n; i++) m.addTri(c, b[(i + 1) % n], b[i]); }
    if (r2 > EPS) { const c = m.addVertex(0, 0, z0 + h); for (let i = 0; i < n; i++) m.addTri(c, t[i], t[(i + 1) % n]); }
  }
  return m;
}

/** A cone: base radius r, height h, apex on the axis. */
export function cone(r, h, opts = {}) {
  pos(r, 'cone r');
  return cylinder(r, h, { ...opts, r2: 0 });
}

/**
 * A sphere of radius r, resting on the plate (centre at z = r) so it obeys the
 * same base-at-zero rule as everything else. `segments` divides the equator,
 * `rings` divides pole to pole.
 */
export function sphere(r, opts = {}) {
  const { segments = 48, rings = 24, z0 = 0 } = opts;
  pos(r, 'sphere r'); num(z0, 'z0');
  const sf = segFactorOf(opts);
  return uvBall(r, nseg(segments, sf, 3), nseg(rings, sf, 2), 0, 0, 0).translate(0, 0, z0 + r);
}

/**
 * A box with every edge and corner rounded by radius r — the box Minkowski-
 * summed with a sphere, which is what "rounded box" means to anyone who has
 * held one. r is clamped to half the smallest side. Centred in X/Y, base at z0.
 *
 * Built by displacing a sphere's vertices outward by the inner box's half
 * extents: every quad of the sphere lands on a corner, an edge or a face, and
 * the mesh is watertight by construction because it is topologically still the
 * sphere. Segment counts are rounded up to a multiple of 4 (and rings to an
 * even number) so that vertices land exactly on the seams between those
 * regions — otherwise a quad straddles two of them and the flats are skew.
 */
export function roundedBox(w, d, h, r, opts = {}) {
  const { segs = 16, z0 = 0 } = opts;
  pos(w, 'roundedBox w'); pos(d, 'roundedBox d'); pos(h, 'roundedBox h'); num(z0, 'z0');
  num(r, 'roundedBox r');
  const rr = Math.min(Math.max(r, 0), Math.min(w, d, h) / 2);
  if (rr <= EPS) return box(w, d, h, { z0 });
  const sf = segFactorOf(opts);
  const seg = Math.max(4, Math.ceil(nseg(segs, sf, 4) / 4) * 4);
  const ring = Math.max(2, Math.ceil(nseg(Math.max(2, segs / 2), sf, 2) / 2) * 2);
  return uvBall(rr, seg, ring, w / 2 - rr, d / 2 - rr, h / 2 - rr).translate(0, 0, z0 + h / 2);
}

/**
 * The shared body of sphere and roundedBox: a lat/long ball of radius `radius`
 * whose vertices are pushed out to the corners of a box with half extents
 * (ax, ay, az). All-zero extents give a plain sphere, centred on the origin.
 */
function uvBall(radius, segments, ringsN, ax, ay, az) {
  req(segments >= 3 && ringsN >= 2, `uvBall needs 3+ segments and 2+ rings (got ${segments}, ${ringsN})`);
  const m = new Mesh();
  const sgn = (v) => (v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0);
  const put = (x, y, z) => m.addVertex(x + sgn(x) * ax, y + sgn(y) * ay, z + sgn(z) * az);
  const north = put(0, 0, radius);
  const bands = [];
  for (let j = 1; j < ringsN; j++) {
    const phi = Math.PI * j / ringsN;
    const z = radius * Math.cos(phi), rr = radius * Math.sin(phi);
    const idx = new Array(segments);
    for (let i = 0; i < segments; i++) {
      const a = TAU * i / segments;
      idx[i] = put(rr * Math.cos(a), rr * Math.sin(a), z);
    }
    bands.push(idx);
  }
  const south = put(0, 0, -radius);
  for (let i = 0; i < segments; i++) m.addTri(north, bands[0][i], bands[0][(i + 1) % segments]);
  for (let j = 0; j + 1 < bands.length; j++) wallStrip(m, bands[j + 1], bands[j]);
  const lastB = bands[bands.length - 1];
  for (let i = 0; i < segments; i++) m.addTri(south, lastB[(i + 1) % segments], lastB[i]);
  return m;
}

/**
 * A capsule: a cylinder of radius r with hemispherical ends. `h` is the OVERALL
 * height including both caps, so it is the number you would measure, and it
 * must be at least 2r. Rests on the plate.
 */
export function capsule(r, h, opts = {}) {
  const { segments = 64, z0 = 0 } = opts;
  pos(r, 'capsule r'); pos(h, 'capsule h'); num(z0, 'z0');
  req(h >= 2 * r - EPS, `capsule height ${h} is shorter than its own diameter ${2 * r}`);
  const sf = segFactorOf(opts);
  const cap = Math.max(2, Math.round(nseg(segments, sf, 3) / 4));
  const straight = h - 2 * r;
  const profile = [];
  for (let i = 0; i <= cap; i++) {                       // bottom hemisphere, -90 to 0
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / cap);
    profile.push([r * Math.cos(a), r + r * Math.sin(a)]);
  }
  for (let i = 0; i <= cap; i++) {                       // top hemisphere, 0 to +90
    const a = (Math.PI / 2) * (i / cap);
    profile.push([r * Math.cos(a), r + straight + r * Math.sin(a)]);
  }
  return revolve(dedupeRing(profile), { segments, segFactor: sf, closed: false }).translate(0, 0, z0);
}

/**
 * A torus lying flat, resting on the plate: major radius R (axis to tube
 * centre), tube radius r. R must exceed r — a self-intersecting spindle torus
 * is not a solid anyone can print.
 */
export function torus(R, r, opts = {}) {
  const { major = 64, minor = 24, z0 = 0 } = opts;
  pos(R, 'torus R'); pos(r, 'torus r'); num(z0, 'z0');
  req(R > r + EPS, `torus major radius ${R} must exceed the tube radius ${r}`);
  const sf = segFactorOf(opts);
  const profile = circle(r, { segs: nseg(minor, sf, 3), cx: R });
  return revolve(profile, { segments: major, segFactor: sf }).translate(0, 0, z0 + r);
}

/** A hollow cylinder: outer radius, inner radius, height. Base at z0. */
export function tube(rOuter, rInner, h, opts = {}) {
  const { segments = 64, z0 = 0 } = opts;
  pos(rOuter, 'tube rOuter'); pos(rInner, 'tube rInner'); pos(h, 'tube h');
  req(rInner < rOuter, `tube inner radius ${rInner} must be smaller than the outer ${rOuter}`);
  const n = nseg(segments, segFactorOf(opts), 3);
  return extrude([circle(rOuter, { segs: n }), reverse(circle(rInner, { segs: n }))], h, { z0, check: false });
}

/** A regular n-sided prism through the circumradius r. Base at z0. */
export function prism(n, r, h, opts = {}) {
  const { rot = 0, z0 = 0 } = opts;
  req(Number.isFinite(n) && n >= 3, `prism needs at least 3 sides (got ${n})`);
  pos(r, 'prism r'); pos(h, 'prism h'); num(rot, 'rot');
  return extrude(regularPolygon(Math.round(n), r, { rot }), h, { z0, check: false });
}

/**
 * A wedge: a w × d footprint whose height falls linearly from h at x = -w/2 to
 * zero at x = +w/2. The vertical face is the -X one. Centred in X/Y, base at z0.
 * Five faces, six vertices — the triangular prism a ramp or a support gusset is
 * made of.
 */
export function wedge(w, d, h, opts = {}) {
  const { z0 = 0 } = opts;
  pos(w, 'wedge w'); pos(d, 'wedge d'); pos(h, 'wedge h'); num(z0, 'z0');
  const m = new Mesh();
  const x = w / 2, y = d / 2, z1 = z0 + h;
  const a = m.addVertex(-x, -y, z0);          // low front, tall side
  const b = m.addVertex(x, -y, z0);           // low front, thin side
  const c = m.addVertex(x, y, z0);            // low back, thin side
  const e = m.addVertex(-x, y, z0);           // low back, tall side
  const f = m.addVertex(-x, -y, z1);          // top front
  const g = m.addVertex(-x, y, z1);           // top back
  m.addQuad(a, e, c, b);                      // base, facing -Z
  m.addQuad(a, f, g, e);                      // vertical face at -X
  m.addQuad(b, c, g, f);                      // the slope, facing +X/+Z
  m.addTri(a, b, f);                          // front face, y = -d/2
  m.addTri(c, e, g);                          // back face, y = +d/2
  return m;
}

/** A rectangular pyramid: w × d base, apex on the axis at height h. Base at z0. */
export function pyramid(w, d, h, opts = {}) {
  const { z0 = 0 } = opts;
  pos(w, 'pyramid w'); pos(d, 'pyramid d'); pos(h, 'pyramid h'); num(z0, 'z0');
  const m = new Mesh();
  const x = w / 2, y = d / 2;
  const a = m.addVertex(-x, -y, z0), b = m.addVertex(x, -y, z0);
  const c = m.addVertex(x, y, z0), e = m.addVertex(-x, y, z0);
  const apex = m.addVertex(0, 0, z0 + h);
  m.addQuad(e, c, b, a);
  m.addTri(a, b, apex); m.addTri(b, c, apex); m.addTri(c, e, apex); m.addTri(e, a, apex);
  return m;
}

/**
 * A cylinder with 45° chamfers of leg `c` on its top and bottom edges — the
 * printable way to take the sharpness off a boss, and the way to give a part a
 * lead-in that does not need support. `top` and `bottom` select which ends get
 * one. Base at z0.
 *
 * `c` is clamped to what fits (the radius, and the height it has to share),
 * the same way poly2d clamps a corner radius: a chamfer as deep as the radius
 * is a cone, which is a real answer, not an error.
 */
export function chamferCylinder(r, h, c, opts = {}) {
  const { segments = 64, z0 = 0, top = true, bottom = true } = opts;
  pos(r, 'chamferCylinder r'); pos(h, 'chamferCylinder h'); num(c, 'chamfer c');
  req(c >= 0, `chamfer must be >= 0 (got ${c})`);
  const cc = Math.min(c, r, (top && bottom) ? h / 2 : h);
  const sf = segFactorOf(opts);
  if (cc <= EPS) return cylinder(r, h, { segments, segFactor: sf, z0 });
  const profile = [[0, 0]];
  if (bottom) { profile.push([r - cc, 0], [r, cc]); } else profile.push([r, 0]);
  if (top) { profile.push([r, h - cc], [r - cc, h]); } else profile.push([r, h]);
  profile.push([0, h]);
  return revolve(dedupeRing(profile), { segments, segFactor: sf }).translate(0, 0, z0);
}

/**
 * A cylinder with its top and bottom edges rounded over by radius f — a fillet
 * you can hold. `top` and `bottom` select which ends get one. `segs` is the
 * number of segments in each quarter-round. Base at z0.
 * Like chamferCylinder, f is clamped to what fits rather than refused.
 */
export function filletCylinder(r, h, f, opts = {}) {
  const { segments = 64, z0 = 0, top = true, bottom = true, segs = 8 } = opts;
  pos(r, 'filletCylinder r'); pos(h, 'filletCylinder h'); num(f, 'fillet f');
  req(f >= 0, `fillet must be >= 0 (got ${f})`);
  const ff = Math.min(f, r, (top && bottom) ? h / 2 : h);
  const sf = segFactorOf(opts);
  if (ff <= EPS) return cylinder(r, h, { segments, segFactor: sf, z0 });
  const q = nseg(segs, sf, 2);
  const profile = [[0, 0]];
  if (bottom) {
    for (let i = 0; i <= q; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / q);
      profile.push([r - ff + ff * Math.cos(a), ff + ff * Math.sin(a)]);
    }
  } else profile.push([r, 0]);
  if (top) {
    for (let i = 0; i <= q; i++) {
      const a = (Math.PI / 2) * (i / q);
      profile.push([r - ff + ff * Math.cos(a), h - ff + ff * Math.sin(a)]);
    }
  } else profile.push([r, h]);
  profile.push([0, h]);
  return revolve(dedupeRing(profile), { segments, segFactor: sf }).translate(0, 0, z0);
}

/**
 * A box with 45° chamfers of leg `c` around its top and bottom faces, and
 * optionally down its four vertical edges (`sides`, a leg length of its own).
 * Centred in X/Y, base at z0. Every face is planar, so the volume is exact.
 *
 * `c` is clamped to the height it has to share; a chamfer wider than half the
 * shorter side has nothing left to stand on, and that is refused by name rather
 * than clamped, because the alternative is a part with no top face at all.
 */
export function chamferBox(w, d, h, c, opts = {}) {
  const { z0 = 0, top = true, bottom = true, sides = 0 } = opts;
  pos(w, 'chamferBox w'); pos(d, 'chamferBox d'); pos(h, 'chamferBox h');
  num(c, 'chamfer c'); num(sides, 'sides');
  req(c >= 0 && sides >= 0, 'chamferBox legs must be >= 0');
  const half = Math.min(w, d) / 2;
  const ss = Math.min(sides, half);
  const cc = Math.min(c, (top && bottom) ? h / 2 : h, half);
  const base = ss > 0 ? chamferRect(w, d, ss) : rect(w, d);
  // The inset section is the real 2D inset of the base profile, not a smaller
  // rectangle: a 45° side chamfer loses (2 - sqrt2) per mm of inset, not 1, and
  // guessing that wrong leaves the two chamfers meeting on a curve.
  const insetAt = (u) => {
    if (u <= 0) return base;
    const o = offset(base, -u, { join: 'miter' });
    req(o.length === 1 && o[0].length === 1,
      `chamferBox chamfer ${c} eats the whole ${w} x ${d} footprint`);
    return o[0][0];
  };
  if (!(cc > 0)) return extrude(base, h, { z0, check: false });
  const inset = insetAt(cc);
  const secs = [];
  // When the two chamfers meet in the middle (h === 2c) the straight section
  // has no height, and pushing both copies of it would ask loft for two
  // sections at the same z. One is the right answer, not an error.
  const push = (shape, z) => {
    const last = secs[secs.length - 1];
    if (last && Math.abs(last.z - z) <= EPS && last.shape === shape) return;
    secs.push({ shape, z });
  };
  if (bottom) push(inset, z0);
  push(base, z0 + (bottom ? cc : 0));
  push(base, z0 + h - (top ? cc : 0));
  if (top) push(inset, z0 + h);
  return loft(secs, { align: 'index', check: false });
}

export default {
  extrude, revolve, loft, sweep, heightfield, helixPath, shell,
  box, roundedBox, cylinder, cone, sphere, capsule, torus, tube, prism, wedge,
  pyramid, chamferCylinder, filletCylinder, chamferBox,
  parallelFrames, resampleRingTo, ringSelfIntersects, EASINGS, TAU,
};
