// How close do two separate pieces of one mesh come?
//
// This is the instrument every print-in-place gate reads, so it is written to
// be falsifiable: the suite that uses it proves it reports a collapsed gap as
// collapsed before it is allowed to report a healthy one as healthy.
//
// Method: bucket every triangle into a uniform grid of cell size `cutoff` —
// into every cell its bounding box overlaps, which is what keeps it sound for
// facets larger than a cell — then for each triangle compare it only against
// triangles of a DIFFERENT shell in its own and neighbouring cells. Each
// comparison samples a grid of points on one triangle against the other
// triangle's closest point, in both directions.
//
// SAMPLING DENSITY FOLLOWS THE FACET (`SAMPLE_EDGE`, below). A fixed set of
// sample points can only ever find a distance AT one of those points, so where
// two facets cross obliquely between them the answer comes back too large —
// never too small, and too large is the direction that reports a fused joint as
// clear. A fixed seven points (3 vertices, 3 edge midpoints, centroid) left
// that error scaling with facet size, which meant the gate's honesty depended
// on how finely the caller happened to tessellate.
//
// Measured, since that is what settled it. A near-fused 0.05 mm gap between two
// obliquely crossing facets, worst crossing position, against the 0.9 x 0.35 =
// 0.3150 gate these joints use:
//
//   facet edge      fixed 7 points        density follows the facet
//   1.01 mm         0.1733  rejected      0.1737  rejected
//   2.02 mm         0.3375  FALSE PASS    0.1737  rejected
//   4.04 mm         0.6715  FALSE PASS    0.1737  rejected
//   8.00 mm         1.3289  FALSE PASS    0.2530  rejected
//
// Those middle two rows are not hypothetical: they are this catalogue's own
// normal and draft quality (2.02 mm and 4.04 mm ring chords), and the coil
// generator's adjacent turns approach each other obliquely, which is exactly
// the configuration the left column gets wrong. The gate was already past the
// point where it could fail.
//
// The right column is flat, which is the property worth having — the error is
// set by the sample spacing, not by the facet, so it no longer matters how
// coarsely a caller tessellates. It is not exact: sampling still over-estimates
// between points, and the tests assert a bound rather than the true gap,
// because a bound is what this delivers.
//
// Near-parallel facets, which is what concentric-sphere joints actually are,
// sample accurately and slightly conservatively either way (0.3467 against a
// 0.35 nominal). That is a fair description of the typical case and was NOT a
// reason to leave the oblique case broken — the typical case is a story about
// which geometry turns up, and the coil is the geometry that turns up.
//
// THE ONE WAY THIS RETURNS Infinity. Bodies that touch within weldEps weld
// into ONE shell, so `count` is 1 and there is no cross-shell pair left to
// measure: two coincident spheres report {min: Infinity, shells: 1}. That is
// honest — no pair exists — but it is also the WORST print-in-place failure
// wearing the healthiest number in the range, and it sails through any gate
// written as `min > threshold`. A fused lump is caught by the SHELL COUNT, not
// by the gap. Gate a joint with `jointGateHolds` below rather than assembling
// the two halves by hand at each call site: three falsifiers in the plan were
// each written as `!(min >= 0.9 * C)` and so could not fire on the fused mesh
// they existed to catch.
//
// Every other Infinity throws. With two or more shells and nothing found
// within `cutoff`, the instrument did not measure anything, and returning
// Infinity there would be a silent pass; callers who really do want a far-apart
// pair pass a bigger cutoff and say so.
//
// COST IS U-SHAPED IN `cutoff`, and both arms bite. Going UP, the neighbourhood
// grows: on the 32k-triangle sphere pair, 12.0 s at cutoff 1.0 against 37.4 s
// at 2.0 — a doubling costs about 1.6 to 1.7 in the exponent, not the 3 the
// cell volume would suggest, because the triangles sit on a surface rather than
// filling the box. Going DOWN, insertion grows: a triangle is added to every
// cell its bounding box overlaps, which is O((facet extent / cutoff)^2) per
// triangle and unbounded. That arm bites on meshes small enough that nobody
// would think to check — two 100 x 100 mm plates, 24 triangles in total, take
// 26 ms at cutoff 2.0, 260 ms at 0.5, 3.1 s at 0.2 and 14.1 s at 0.1, the last
// on a 1 GB heap.
//
// The floor is therefore not free, and `cutoff` wants to sit above the largest
// facet extent but below where the neighbourhood scan gets expensive. The 1.0
// default clears every threshold anyone gates on — not merely the gap being
// measured — which today means 0.9 x 0.6 = 0.54 at the widest clearance the
// catalogue offers. Ruling 6 halved that margin from 2.0, so anything that
// raises the clearance parameter past ~1.1 mm must raise `cutoff` with it.
// Full timing tables are in the task-2 report, not in the test file.
import { shellsOf } from '../../js/kernel/validate.js';

// JSON.stringify(NaN) is "null", which would report a caller's NaN as a null
// they never passed. These messages exist to name the mistake exactly.
const show = (v) => (typeof v === 'number' ? String(v) : JSON.stringify(v));

const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];

/** Distance from point p to triangle (a,b,c) — Ericson, Real-Time Collision Detection. */
export function pointTriDistance(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
  }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return Math.hypot(ap[0] - ac[0] * t, ap[1] - ac[1] * t, ap[2] - ac[2] * t);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const bc = sub(c, b);
    return Math.hypot(bp[0] - bc[0] * t, bp[1] - bc[1] * t, bp[2] - bc[2] * t);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return Math.hypot(ap[0] - ab[0] * v - ac[0] * w, ap[1] - ab[1] * v - ac[1] * w, ap[2] - ab[2] * v - ac[2] * w);
}

/**
 * Target spacing between sample points, mm — the number that decides how honest
 * this instrument is, so here is how it was chosen rather than guessed.
 *
 * Sweeping a fused 0.05 mm gap across obliquely crossing facets at the
 * catalogue's three quality levels, worst crossing position, against the
 * 0.9 x 0.35 = 0.3150 gate:
 *
 *   spacing    1.01 mm         2.02 mm         4.04 mm
 *   none       0.1733          0.3375 FALSE    0.6715 FALSE
 *   1.00       0.1733          0.3384 FALSE    0.4051 FALSE
 *   0.50       0.1737          0.2062          0.2280
 *   0.35       0.1737          0.1737          0.1737
 *   0.25       0.1109          0.1210          0.1339
 *
 * 1.00 was the obvious first guess and it fails, though not for the tidy reason
 * it first appears to: ceil(2.02 / 1.00) is 3, not 2, so a 2.02 mm facet does
 * get a denser grid than the old fixed seven points — it is simply not dense
 * enough, reading 0.3384 against a 0.3150 gate. (Only an exactly 2.00 mm facet
 * degenerates to order 2. The giveaway that the degeneracy story was wrong is
 * in the table: if the order really were 2, that cell would equal the "none"
 * cell, and it does not.) 0.50 clears every row but the error still climbs with
 * the facet, so it leaves the same shape of problem for a coarser generator to
 * rediscover.
 *
 * 0.35 is the coarsest spacing at which the reading goes FLAT across the whole
 * range — the same 0.1737 at every quality — which is the property being bought
 * here: an error set by the sampling, not by the caller's tessellation. That
 * flatness, not any argument about which order a facet picks, is what decided
 * it. It leaves a 1.81x margin to the gate at every quality level, and costs 3%
 * on a 32k-triangle mesh (fine facets take the order-2 fast path and pay
 * nothing).
 *
 * Figures are the worst reading over a 400-position sweep of the crossing.
 * A coarser sweep understates them slightly — 200 positions misses 0.1733 at
 * 1.01 mm and reports 0.1729 — so re-measure at 400 before comparing.
 *
 * 0.25 would give 2.35x instead of 1.81x for 12% on the same mesh. Worth
 * revisiting if a generator ever gates a joint at a clearance tighter than
 * 0.35 mm, where the fused-to-acceptable window narrows and the margin with it.
 */
export const SAMPLE_EDGE = 0.35;

/**
 * Recursion bound. A triangle is never sampled at an order higher than this, so
 * a facet longer than SAMPLE_EDGE * MAX_SAMPLE_ORDER — 5.6 mm at the defaults —
 * is sampled coarser than asked, and past that the error starts scaling with
 * the facet again. Measured at 8 mm, which is well past it: a fused 0.05 mm gap
 * still reads 0.2530 against the 0.3150 gate — a 1.25x margin instead of the
 * 1.81x inside the cap — so the bound costs margin rather than correctness at
 * the sizes anything here produces. (At 8 mm the cap is what makes spacings of
 * 0.50, 0.35 and 0.25 all land on 0.2530: each asks for more than order 16 and
 * gets 16. A 1.00 mm spacing asks for order 8, is not capped, and reads 0.4453,
 * so that row is not flat and the cap is not why.)
 *
 * The widest facet this catalogue calls a joint is the 4.04 mm draft coil
 * chord, inside the cap; the larger facets in the tests are flat parallel
 * faces, where a vertex lands on the near point and sampling density is
 * irrelevant.
 *
 * It exists because the cost of an order is quadratic in it: order 16 is 153
 * points per triangle against 7, and without a cap a 100 mm plate at the 0.35
 * default would ask for order 286 — 41,000 points on one facet.
 */
export const MAX_SAMPLE_ORDER = 16;

const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);

/** The sampling order a triangle needs: spacing = longest edge / n <= maxEdge. */
function sampleOrder(a, b, c, maxEdge) {
  return Math.max(2, Math.min(MAX_SAMPLE_ORDER,
    Math.ceil(Math.max(dist(a, b), dist(b, c), dist(c, a)) / maxEdge)));
}

/**
 * Sample points on a triangle, as a barycentric grid of order `n` — so the
 * spacing is the longest edge over n, and `sampleOrder` above is what picks n
 * to clear `SAMPLE_EDGE`.
 *
 * At n = 2 this is exactly the old fixed set — three vertices, three edge
 * midpoints and the centroid — so meshes whose facets are already fine enough
 * sample identically to before and their numbers do not move. Above that the
 * order rises with the facet, which is the whole point: the sampled error stops
 * scaling with facet size.
 *
 * A grid rather than recursive midpoint subdivision because it reaches the same
 * spacing far more cheaply — order n is (n+1)(n+2)/2 points, against 4^d
 * sub-triangles at 7 points each for the equivalent depth. A 4 mm facet at the
 * shipped 0.35 mm spacing is order 12: 91 points this way, 1792 the other.
 */
function samples(a, b, c, n) {
  // Order 2 is every mesh fine enough not to need subdividing, which is every
  // large mesh this is ever handed — so it gets the literal the general path
  // would spend 38% of the total runtime rebuilding one push at a time.
  if (n === 2) {
    return [a, b, c, mid(a, b), mid(b, c), mid(c, a),
            [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]];
  }
  const pts = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; i + j <= n; j++) {
      const k = n - i - j;
      pts.push([(a[0] * i + b[0] * j + c[0] * k) / n,
                (a[1] * i + b[1] * j + c[1] * k) / n,
                (a[2] * i + b[2] * j + c[2] * k) / n]);
    }
  }
  // The centroid is only a grid node when n divides by 3, and it is the single
  // most useful point on a facet that crosses another near its middle.
  if (n % 3 !== 0) {
    pts.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
  }
  return pts;
}

function triTriDistance(t1, t2, n1, n2) {
  let best = Infinity;
  for (const p of samples(t1[0], t1[1], t1[2], n1)) {
    const d = pointTriDistance(p, ...t2); if (d < best) best = d;
  }
  for (const p of samples(t2[0], t2[1], t2[2], n2)) {
    const d = pointTriDistance(p, ...t1); if (d < best) best = d;
  }
  return best;
}

export function shellCount(mesh, { weldEps = 1e-5 } = {}) {
  return shellsOf(mesh, { weldEps }).count;
}

/**
 * The smallest distance between triangles of two DIFFERENT shells in one mesh.
 *
 * Returns `{ min, shells, worst }`. `worst` is null when there is nothing to
 * measure, otherwise `{ a, b, at }` naming the two shell labels and `at`.
 *
 * `at` IS THE NEAR FACET'S CENTROID, NOT THE NEAR POINT. Since ruling 5 a facet
 * may be far larger than a cell, so on a 40 mm face the centroid sits ~19 mm
 * from where the two shells actually approach, and on the crossing plates in
 * the test it is 3.33 mm from a crossing at the origin. It is good enough to
 * say which end of a model to look at and no good at all as a coordinate. A
 * caller that prints "fused at {at}" is pointing at the wrong place.
 */
export function minShellGap(mesh, { cutoff = 1.0, weldEps = 1e-5, sampleEdge = SAMPLE_EDGE } = {}) {
  // A bad cutoff otherwise builds an empty grid and surfaces as the "no pair
  // within cutoff" throw below, which blames the geometry for a caller's typo.
  if (typeof cutoff !== 'number' || !Number.isFinite(cutoff) || cutoff <= 0) {
    throw new Error(`minShellGap(): cutoff must be a positive finite number of millimetres, got ${show(cutoff)}`);
  }
  if (typeof sampleEdge !== 'number' || !Number.isFinite(sampleEdge) || sampleEdge <= 0) {
    throw new Error(`minShellGap(): sampleEdge must be a positive finite number of millimetres, got ${show(sampleEdge)}`);
  }
  const { labels, welded, count } = shellsOf(mesh, { weldEps });
  if (count < 2) return { min: Infinity, shells: count, worst: null };

  const vert = (i) => [welded.positions[i * 3], welded.positions[i * 3 + 1], welded.positions[i * 3 + 2]];
  const tri = (t) => [vert(welded.tris[t * 3]), vert(welded.tris[t * 3 + 1]), vert(welded.tris[t * 3 + 2])];

  // Uniform grid, cell = cutoff. Every triangle goes into EVERY cell its
  // bounding box overlaps, not just the one holding its centroid. Centroid
  // bucketing is what made the first version of this unsound: the creature's
  // body is a tube of quads running the whole length of a segment, so a facet
  // is far longer than a cell, its centroid sits nowhere near the end where it
  // approaches the next shell, and the pair was never compared — two cubes
  // 0.4 mm apart reported Infinity, a silent pass.
  //
  // With AABB insertion the argument is airtight. If triangles t and u come
  // within `cutoff`, there are points p on t and q on u with |p-q| <= cutoff.
  // p lies in a cell t occupies and q in a cell u occupies, and since cutoff is
  // exactly one cell those two cells differ by at most one step per axis. So
  // scanning the 27-cell neighbourhood of every cell t occupies always reaches
  // u. Correctness now depends only on cutoff exceeding the GAP, never on the
  // facet size.
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  const cellIx = (v) => Math.floor(v / cutoff);
  const ranges = [];                       // per triangle: [i0, j0, k0, i1, j1, k1]
  const centroids = [];
  // Sampling order is a property of the triangle, so it is computed once here
  // rather than re-derived on each of the many pair comparisons a triangle
  // takes part in — three hypots per comparison was a fifth of the runtime.
  const orders = new Int32Array(welded.triCount);
  for (let t = 0; t < welded.triCount; t++) {
    const [a, b, c] = tri(t);
    orders[t] = sampleOrder(a, b, c, sampleEdge);
    centroids.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    const r = [
      cellIx(Math.min(a[0], b[0], c[0])), cellIx(Math.min(a[1], b[1], c[1])), cellIx(Math.min(a[2], b[2], c[2])),
      cellIx(Math.max(a[0], b[0], c[0])), cellIx(Math.max(a[1], b[1], c[1])), cellIx(Math.max(a[2], b[2], c[2])),
    ];
    ranges.push(r);
    for (let i = r[0]; i <= r[3]; i++) for (let j = r[1]; j <= r[4]; j++) for (let k = r[2]; k <= r[5]; k++) {
      const kk = key(i, j, k);
      let bucket = cells.get(kk);
      if (!bucket) { bucket = []; cells.set(kk, bucket); }
      bucket.push(t);
    }
  }

  // A triangle now appears in several buckets, so the same pair surfaces more
  // than once; `seen` stamps each candidate with the t that already tried it.
  let min = Infinity, worst = null;
  const seen = new Int32Array(welded.triCount).fill(-1);
  for (let t = 0; t < welded.triCount; t++) {
    const r = ranges[t], ta = tri(t), la = labels[t];
    for (let i = r[0] - 1; i <= r[3] + 1; i++)
      for (let j = r[1] - 1; j <= r[4] + 1; j++)
        for (let k = r[2] - 1; k <= r[5] + 1; k++) {
          const bucket = cells.get(key(i, j, k));
          if (!bucket) continue;
          for (const u of bucket) {
            if (u <= t || labels[u] === la || seen[u] === t) continue;
            seen[u] = t;
            const d = triTriDistance(ta, tri(u), orders[t], orders[u]);
            if (d < min) { min = d; worst = { a: la, b: labels[u], at: centroids[t] }; }
          }
        }
  }

  // Separate shells exist but none came within `cutoff`. That is the instrument
  // failing to measure, and it would leave `min` at Infinity — which passes any
  // gate written as `min > threshold`. Refuse to hand back a healthy-looking
  // number nobody measured.
  if (min === Infinity) {
    throw new Error(
      `minShellGap: ${count} shells, but no pair of them comes within the ${cutoff} mm cutoff, ` +
      `so no gap was measured. Pass a larger cutoff if the shells really are that far apart.`);
  }
  return { min, shells: count, worst };
}

/**
 * Is this print-in-place joint sound? Both halves of the question, in the order
 * that makes the answer safe.
 *
 * A joint holds only if the mesh still has `expectedShells` separate shells AND
 * no two of them come closer than `factor * clearance`. Either half alone is a
 * gate that cannot fail in the case it exists to catch:
 *
 *   - Gap alone is what three falsifiers in the plan did, each as
 *     `!(min >= 0.9 * C)`. A joint printed at zero clearance FUSES, fusing
 *     welds the two bodies into one shell, one shell has no pair to measure,
 *     and `minShellGap` returns Infinity. `Infinity >= 0.315` is true, so the
 *     falsifier passed the gate at exactly the moment it was meant to fire.
 *   - Shell count alone says two bodies exist, not that you can bend them
 *     apart — two segments 0.02 mm apart are two shells and one lump.
 *
 * The shell count is checked FIRST and short-circuits, so a fused mesh returns
 * false here and never reaches `minShellGap`, where the count of 1 would make
 * it return Infinity and a count of 2 with everything out of range would throw.
 * A wrong shell count is an answer, not an error.
 *
 * A mesh with the right shell count whose shells are all further apart than the
 * cutoff still throws, from `minShellGap`. That is deliberate: it is not a
 * joint, it is a model built wrong, and it should not be reported as a pass.
 */
export function jointGateHolds(mesh, expectedShells, clearance, factor = 0.9) {
  if (!Number.isInteger(expectedShells) || expectedShells < 1) {
    throw new Error(`jointGateHolds(): expectedShells must be a positive integer, got ${show(expectedShells)}`);
  }
  if (typeof clearance !== 'number' || !Number.isFinite(clearance) || clearance <= 0) {
    throw new Error(`jointGateHolds(): clearance must be a positive finite number of millimetres, got ${show(clearance)}`);
  }
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`jointGateHolds(): factor must be a positive finite number, got ${show(factor)}`);
  }
  if (shellCount(mesh) !== expectedShells) return false;
  return minShellGap(mesh).min >= factor * clearance;
}
