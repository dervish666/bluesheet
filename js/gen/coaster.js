// js/gen/coaster.js — drinks coasters and hot-pan trivets.
//
// The easiest thing in the catalogue to print and therefore the easiest to get
// vaguely right, so this generator is built around being exact instead:
//
//   * the outline is rescaled after it is built so the widest dimension is the
//     number you typed, to the last digit, for all four outline families;
//   * the lip's inner wall is kept vertical, which means the catchment volume
//     is a closed-form number rather than an estimate — a coaster that says it
//     holds 17 mL holds 17 mL, and the test measures the mesh to prove it;
//   * every surface treatment is built STRUCTURALLY. The floor's hole rings are
//     literally the same vertex arrays as the pocket walls' rings, so the pocket
//     and the face it is cut into cannot disagree by a rounding error. There is
//     no mesh CSG in this file at all.
//
// The trivet is not a bigger coaster. It is an open lattice whose material
// region is `outline minus a set of disjoint holes`, which makes "one connected
// shell" a fact about the construction rather than something to hope for; it
// has feet, and it is delivered in the orientation that actually prints those
// feet without support.
//
// Millimetres, Z up, CCW seen from outside.

import { Mesh, TAU } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { ringSelfIntersects } from '../kernel/builders.js';
import { loadFont, layoutText, contoursToShapes } from '../kernel/text.js';
import { clamp, num } from '../kernel/scalar.js';

// ---------------------------------------------------------------------------
// Bundled fonts
//
// build() is synchronous and pure, so the faces are parsed once at module load.
// The ids are the file stems, which is what server/fonts.py reports, so a font
// picker in the UI and this enum agree without a translation table.
// ---------------------------------------------------------------------------

export const BUNDLED_FONTS = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf',
    label: 'Sans Narrow', help: 'Condensed grotesque — fits the longest word across a coaster.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf',
    label: 'Rounded Bold', help: 'Thickest strokes, so the safest face for a shallow engraving.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf',
    label: 'Sans Mono', help: 'Fixed pitch and even stroke weight. Good for dates and numbers.' },
];

export const DEFAULT_FONT = 'Quicksand-Bold';

const FONTS = new Map();
const FONT_ERRORS = new Map();

/** Hand this module a .ttf so `font: '<id>'` can use it. Accepts anything loadFont does. */
export function registerFont(id, data) {
  const font = data && typeof data.glyphIndex === 'function' ? data : loadFont(data);
  FONTS.set(id, font);
  FONT_ERRORS.delete(id);
  return font;
}

/** The parsed face for an id, falling back to whatever did load. Null if nothing did. */
export function fontFor(id) {
  return FONTS.get(id) || FONTS.get(DEFAULT_FONT) || FONTS.values().next().value || null;
}

export function fontProblems() { return [...FONT_ERRORS.entries()].map(([id, why]) => `${id}: ${why}`); }

async function loadBundledFonts() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/fonts/', import.meta.url);
  for (const f of BUNDLED_FONTS) {
    try {
      let bytes;
      if (isNode) {
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([import('node:fs'), import('node:url')]);
        bytes = readFileSync(fileURLToPath(new URL(f.file, dir)));
      } else {
        const res = await fetch(new URL(f.file, dir));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      }
      registerFont(f.id, bytes);
    } catch (e) {
      // A face that will not load is a missing option, not a broken catalogue.
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}

await loadBundledFonts();

// ---------------------------------------------------------------------------
// Limits that exist to stop a slider producing a build nobody wants to wait for
// ---------------------------------------------------------------------------

const MAX_CELLS = 420;        // pads on a coaster / holes in a trivet
const MAX_RINGS = 60;         // concentric grooves
const MIN_POCKET_FLOOR = 0.6; // mm of material that must remain under any pocket
const MIN_RING_AREA = 0.02;   // mm² — below this a 2D region is an artefact, not a feature

function nseg(n, sf, min = 3) { return Math.max(min, Math.round(n * (sf || 1))); }

/**
 * Segments for a circle of radius r at a given chord deviation. Derived rather
 * than hard-coded: a 40 mm coaster and a 178 mm one should not get the same
 * count, and "64" is only ever right for one radius.
 */
function circleSegs(r, tol = 0.04) {
  if (!(r > tol)) return 12;
  const n = Math.ceil(Math.PI / Math.acos(clamp(1 - tol / r, -1, 1)));
  return clamp(n, 16, 360);
}

// ---------------------------------------------------------------------------
// Ring maths
// ---------------------------------------------------------------------------

/**
 * Move every vertex of a ring `d` into the material along the corner bisector.
 *
 * poly2d.offset is the general tool, but it adds and drops points, and a
 * chamfer strip needs the two rings joined vertex for vertex. This keeps the
 * count and refuses (returns null) when the result folds, which is what an
 * inset larger than the feature it is insetting does.
 *
 * The material of a correctly wound shape is always to the LEFT of every
 * directed edge — outer rings counter-clockwise, holes clockwise — so the same
 * formula shrinks an outline and grows a hole, which is exactly what "inset the
 * material" means for both.
 */
export function insetRing(ring, d, miterLimit = 2.5) {
  const n = ring.length;
  if (n < 3) return null;
  if (!(d > 1e-12)) return ring.map(p => [p[0], p[1]]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    let e1x = b[0] - a[0], e1y = b[1] - a[1];
    let e2x = c[0] - b[0], e2y = c[1] - b[1];
    const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
    if (!(l1 > 1e-12) || !(l2 > 1e-12)) return null;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { out[i] = [b[0] + n1x * d, b[1] + n1y * d]; continue; }
    mx /= ml; my /= ml;
    let k = mx * n1x + my * n1y;
    if (k < 1 / miterLimit) k = 1 / miterLimit;
    out[i] = [b[0] + mx * d / k, b[1] + my * d / k];
  }
  const a0 = P.signedArea(ring), a1 = P.signedArea(out);
  if (!(a1 < a0)) return null;                       // must lose material — true for holes too
  if (Math.sign(a1) !== Math.sign(a0)) return null;  // turned itself inside out
  // A local reversal is the cheap half of the fold test and catches the common
  // case (a corner overtaking its neighbour) in O(n).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ox = ring[j][0] - ring[i][0], oy = ring[j][1] - ring[i][1];
    const nx = out[j][0] - out[i][0], ny = out[j][1] - out[i][1];
    if (ox * nx + oy * ny < 0) return null;
  }
  if (ringSelfIntersects(out)) return null;
  return out;
}

/** Inset that is allowed to change the vertex count: miter first, poly2d.offset if it folds. */
function insetOutline(ring, d, tol = 0.05) {
  if (!(d > 1e-9)) return ring.map(p => [p[0], p[1]]);
  const mi = insetRing(ring, d);
  if (mi) return mi;
  let best = null, bestArea = 0;
  for (const s of P.offset([ring], -d, { join: 'round', arcTolerance: tol })) {
    const a = P.area(s[0]);
    if (a > bestArea) { bestArea = a; best = s[0]; }
  }
  return bestArea > MIN_RING_AREA ? P.ensureCCW(best) : null;
}

/** Distance from a point to the nearest point of a ring's boundary — the inscribed radius. */
function inRadius(ring, cx = 0, cy = 0) {
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 1e-18 ? ((cx - a[0]) * vx + (cy - a[1]) * vy) / len2 : 0;
    t = clamp(t, 0, 1);
    const d = Math.hypot(cx - (a[0] + vx * t), cy - (a[1] + vy * t));
    if (d < best) best = d;
  }
  return best;
}

/** Distance from the origin to the ring along a ray at `ang`. Infinity if it never hits. */
function reachAt(ring, ang) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (a[0] * ey - a[1] * ex) / den;          // along the ray, from the origin
    const u = (a[0] * dy - a[1] * dx) / den;          // along the edge
    if (t > 1e-9 && u >= 0 && u < 1 && t < best) best = t;
  }
  return best;
}

/** Every point of `ring` strictly inside `host`, tested at vertices AND edge midpoints. */
function ringInsideRing(ring, host) {
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (!P.pointInRing(a, host)) return false;
    if (!P.pointInRing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], host)) return false;
  }
  return true;
}

/** N points spaced by equal arc length around a closed ring, plus the local tangent length. */
function alongRing(ring, count) {
  const n = ring.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[n];
  const out = [];
  if (!(total > 0) || count < 1) return out;
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = total * k / count;
    while (seg < n - 1 && cum[seg + 1] < s) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = clamp((s - cum[seg]) / span, 0, 1);
    const a = ring[seg], b = ring[(seg + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  out.spacing = total / count;
  return out;
}

function shapesArea(shapes) { let a = 0; for (const s of shapes) a += P.shapeArea(s); return a; }

function dropSpecks(shapes, minArea = MIN_RING_AREA) {
  const out = [];
  for (const s of shapes) {
    if (!s || !s.length || P.area(s[0]) < minArea) continue;
    out.push([s[0], ...s.slice(1).filter(r => P.area(r) >= minArea)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mesh assembly primitives
//
// Everything below builds ONE closed surface out of rings and caps. The
// convention throughout: a ring is wound so the material is on its left, `strip`
// makes the wall that faces out of the material, `stripIn` the wall of a void.
// ---------------------------------------------------------------------------

function addRingAt(m, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

function strip(m, lo, hi) {
  for (let i = 0, n = lo.length; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], lo[j], hi[j], hi[i]); }
}

function stripIn(m, lo, hi) {
  for (let i = 0, n = lo.length; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], hi[i], hi[j], lo[j]); }
}

/**
 * Flat cap over a set of shapes at height z.
 *
 * The winding comes from the SUM of the triangle areas, not from each triangle:
 * a collinear ear has no orientation of its own, and flipping it on its own sign
 * is how a cap ends up with one inconsistently wound edge in a mesh that is
 * otherwise perfect.
 */
function capShapes(m, shapes, z, up) {
  for (const shape of shapes) {
    if (!shape || !shape.length) continue;
    const { points, tris } = P.triangulate(shape);
    if (!tris.length) continue;
    let sum = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = points[tris[i]], b = points[tris[i + 1]], c = points[tris[i + 2]];
      sum += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    const asIs = (sum > 0) === !!up;
    const base = new Array(points.length);
    for (let i = 0; i < points.length; i++) base[i] = m.addVertex(points[i][0], points[i][1], z);
    for (let i = 0; i < tris.length; i += 3) {
      if (asIs) m.addTri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
      else m.addTri(base[tris[i + 2]], base[tris[i + 1]], base[tris[i]]);
    }
  }
}

/**
 * The outside wall of a slab between two heights, with an optional chamfer at
 * each end. Returns the ring sets that bound the two flat faces, so the caller
 * caps them.
 *
 * A chamfer that will not inset without folding is dropped rather than
 * approximated — a folded ring is a self-intersecting cap, and a coaster with a
 * missing 0.6 mm bevel is a far better outcome than one that will not slice.
 */
function slabWalls(m, rings, zLo, zHi, cLo, cHi) {
  const loRings = cLo > 1e-9 ? rings.map(r => insetRing(r, cLo)) : null;
  const hiRings = cHi > 1e-9 ? rings.map(r => insetRing(r, cHi)) : null;
  const loOk = loRings && loRings.every(Boolean);
  const hiOk = hiRings && hiRings.every(Boolean);
  const levels = [];
  if (loOk) { levels.push({ rings: loRings, z: zLo }); levels.push({ rings, z: zLo + cLo }); }
  else levels.push({ rings, z: zLo });
  if (hiOk) { levels.push({ rings, z: zHi - cHi }); levels.push({ rings: hiRings, z: zHi }); }
  else levels.push({ rings, z: zHi });

  let prev = null, prevZ = 0;
  for (const lv of levels) {
    const idx = lv.rings.map(r => addRingAt(m, r, lv.z));
    // Two levels at the same height would be a zero-area strip; the vertices are
    // coincident so the surface still closes once welded.
    if (prev && lv.z - prevZ > 1e-9) for (let k = 0; k < idx.length; k++) strip(m, prev[k], idx[k]);
    prev = idx; prevZ = lv.z;
  }
  return { lo: levels[0].rings, hi: levels[levels.length - 1].rings, chamferedLo: !!loOk, chamferedHi: !!hiOk };
}

/**
 * Recess a set of pocket groups into a face at `surfaceZ` and cap the face.
 * Returns the flat list of pocket rings, which are the SAME arrays that become
 * holes in the face — that identity is what makes the join exact.
 */
function sinkPockets(m, groups, surfaceZ, boundaryRings) {
  const pocketRings = [];
  for (const g of groups) {
    if (!g.shapes.length || !(g.depth > 1e-6)) continue;
    for (const s of g.shapes) {
      for (const r of s) {
        pocketRings.push(r);
        stripIn(m, addRingAt(m, r, surfaceZ - g.depth), addRingAt(m, r, surfaceZ));
      }
    }
    capShapes(m, g.shapes, surfaceZ - g.depth, true);
  }
  const face = contoursToShapes([...boundaryRings, ...pocketRings]);
  capShapes(m, face, surfaceZ, true);
  return pocketRings;
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

const OUTLINES = [
  { v: 'circle', label: 'Circle', help: 'The default for a reason: no corner to catch a sleeve.' },
  { v: 'square', label: 'Square', help: 'With any corner radius, from a sharp square to a full pill.' },
  { v: 'hexagon', label: 'Hexagon', help: 'Tessellates, so a set of six packs onto one plate with no waste.' },
  { v: 'superformula', label: 'Superformula', help: 'Flowers, gems and blobs from the Gielis curve.' },
];

/**
 * The outline ring, rotated, then rescaled so its widest dimension is exactly
 * `size` and its bounding box is centred on the origin. Rescaling last is what
 * makes "95 mm" mean 95 mm for a rotated hexagon and a twelve-petal flower as
 * well as for a circle.
 */
function outlineRing(p, sf) {
  const size = clamp(num(p.size, 95), 10, 400);
  const R = size / 2;
  let ring;
  switch (p.outline) {
    case 'square': {
      const r = clamp(num(p.cornerRadius, 0), 0, R - 1e-6);
      ring = r > 0.05
        ? P.roundRect(size, size, r, { segs: nseg(Math.max(3, circleSegs(r) / 4), sf, 3) })
        : P.rect(size, size);
      break;
    }
    case 'hexagon':
      ring = P.regularPolygon(6, R);
      break;
    case 'superformula': {
      const preset = P.SUPERFORMULA_PRESETS[p.sfPreset] ? p.sfPreset : 'flower6';
      ring = P.superformula({ preset, r: R, segs: nseg(clamp(circleSegs(R) * 2.5, 120, 480), sf, 90) });
      break;
    }
    default:
      ring = P.circle(R, { segs: nseg(circleSegs(R), sf, 16) });
  }
  const rot = num(p.outlineRotation, 0);
  if (Math.abs(rot) > 1e-9) ring = P.transformRing(ring, { rot: rot * Math.PI / 180 });
  const b = P.bounds([ring]);
  const widest = Math.max(b.size[0], b.size[1]);
  const k = widest > 1e-9 ? size / widest : 1;
  ring = ring.map(pt => [(pt[0] - b.center[0]) * k, (pt[1] - b.center[1]) * k]);
  return P.ensureCCW(ring);
}

// ---------------------------------------------------------------------------
// Surface treatments
//
// Each returns shape[] of GROOVE regions that are strictly inside `treat` and
// mutually disjoint. Disjointness is a property of the construction, never of a
// boolean cleaning up afterwards.
// ---------------------------------------------------------------------------

/** Concentric grooves that follow the outline rather than being circles on a hexagon. */
function ringsPattern(treat, gw, pitch, tol) {
  const grooves = [];
  const step = Math.max(pitch, gw + 0.4);
  for (let k = 0; k < MAX_RINGS; k++) {
    const a = k * step;
    const outer = insetOutline(treat, a, tol);
    if (!outer || P.area(outer) < Math.PI * (gw * 2) ** 2) break;
    const inner = insetOutline(treat, a + gw, tol);
    if (!inner || P.area(inner) < MIN_RING_AREA) {
      // The last groove would swallow the middle: leave it as a plain disc so
      // the centre of the coaster is a flat pad rather than a spike.
      break;
    }
    grooves.push([P.ensureCCW(outer), P.ensureCW(inner)]);
  }
  return grooves;
}

/**
 * A sunburst. The spokes stop short of the boundary by a real ray cast against
 * the outline, so on a hexagon they reach the flat sides instead of all stopping
 * at the inscribed circle, and they start at a hub so they do not pile into one
 * blob at the centre.
 */
function radialPattern(treat, gw, spokesWanted, sf) {
  const rMax = inRadius(treat);
  const land = Math.max(1.0, gw);
  // Two spokes must not touch where they are closest, which is at the hub.
  const spacingLimit = clamp((gw + land) / (2 * 0.5 * Math.max(rMax, 1)), 1e-6, 0.999);
  const nMax = Math.max(3, Math.floor(Math.PI / Math.asin(spacingLimit)));
  const n = Math.max(3, Math.min(Math.round(spokesWanted), nMax));
  const hub = Math.max(gw * 1.5, (gw + land) / (2 * Math.sin(Math.PI / n)));
  const margin = Math.max(0.8, gw * 0.5);
  const segs = nseg(8, sf, 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const th = TAU * i / n;
    let end = reachAt(treat, th);
    if (!isFinite(end)) continue;
    // The slot is a rectangle with round ends, so its corners sit off-axis; take
    // the nearer boundary of the two edges as well as of the centreline.
    const spread = Math.atan2(gw / 2, Math.max(end, 1));
    end = Math.min(end, reachAt(treat, th + spread), reachAt(treat, th - spread)) - margin;
    if (!isFinite(end) || end - hub < gw * 1.6) continue;
    const mid = (hub + end) / 2;
    const slot = P.slot(end - hub, gw / 2, { segs });
    out.push([P.ensureCCW(P.transformRing(slot, { rot: th, tx: mid * Math.cos(th), ty: mid * Math.sin(th) }))]);
  }
  return { grooves: out, spokes: n, hub, reduced: n !== Math.round(spokesWanted) };
}

/**
 * Hex drainage relief: hexagonal PADS with a connected groove network between
 * them, not recessed hexagons.
 *
 * The difference matters in use. Recessed cells trap the spill in a hundred
 * isolated puddles directly under the glass, which is the failure mode of most
 * printed coasters; a connected web drains it away from the contact patch into
 * the moat at the edge of the pattern, and the glass ends up standing on the
 * pads, dry.
 */
function hexPattern(treat, gw, cellWanted, tol) {
  const b = P.bounds([treat]);
  const span = Math.max(b.size[0], b.size[1]);
  let s = Math.max(cellWanted, gw + 1.2);
  // Raise the cell size rather than emit thousands of pads: the alternative is a
  // slider position that takes ten seconds to rebuild.
  const estimate = (c) => (b.size[0] / c + 2) * (b.size[1] / (c * Math.sqrt(3) / 2) + 2);
  while (estimate(s) > MAX_CELLS && s < span) s *= 1.15;
  const padR = (s - gw) / Math.sqrt(3);
  if (!(padR > 0.7)) return { grooves: [], cells: 0, cell: s };

  const rows = Math.ceil(b.size[1] / (s * Math.sqrt(3) / 2)) + 2;
  const cols = Math.ceil(b.size[0] / s) + 2;
  const probe = padR + Math.max(0.3, gw * 0.25);   // the pad plus a clear margin
  const pads = [];
  for (let j = -rows; j <= rows; j++) {
    const y = j * s * Math.sqrt(3) / 2;
    if (y < b.min[1] - s || y > b.max[1] + s) continue;
    for (let i = -cols; i <= cols; i++) {
      const x = i * s + (j & 1 ? s / 2 : 0);
      if (x < b.min[0] - s || x > b.max[0] + s) continue;
      const test = P.regularPolygon(6, probe, { cx: x, cy: y, rot: Math.PI / 6 });
      if (!ringInsideRing(test, treat)) continue;
      pads.push(P.ensureCW(P.regularPolygon(6, padR, { cx: x, cy: y, rot: Math.PI / 6 })));
      if (pads.length >= MAX_CELLS) break;
    }
    if (pads.length >= MAX_CELLS) break;
  }
  if (!pads.length) return { grooves: [], cells: 0, cell: s };
  void tol;
  return { grooves: [[P.ensureCCW(treat), ...pads]], cells: pads.length, cell: s };
}

// ---------------------------------------------------------------------------
// Engraving
// ---------------------------------------------------------------------------

/**
 * Lay the text out and shrink it until every corner of its block is inside the
 * inscribed circle of the engraving area.
 *
 * The inscribed circle is deliberately conservative on a hexagon or a star: it
 * is the largest region that is inside the outline whatever the outline is, and
 * a caliper-exact fit against a twelve-petal flower is not worth a containment
 * test that can be wrong.
 */
function planText(p, treat, sf) {
  const raw = String(p.text ?? '');
  if (!raw.trim()) return null;
  const font = fontFor(p.font);
  if (!font) return { ink: [], missing: [], fit: 0, capMm: 0, error: 'no typeface loaded' };

  const rFit = inRadius(treat) - Math.max(0.8, num(p.grooveWidth, 1.6) * 0.5);
  if (!(rFit > 2)) return { ink: [], missing: [], fit: 0, capMm: 0, error: 'no room for text' };

  const yFrac = { upper: 0.42, lower: -0.42 }[p.textPosition] ?? 0;
  const tol = clamp(0.035 / (sf || 1), 0.008, 0.09);
  let cap = clamp(num(p.textSize, 9), 0.5, 200);
  let plan = null, fit = 1;

  for (let iter = 0; iter < 3; iter++) {
    plan = layoutText(font, raw, {
      size: cap, align: 'center', vAlign: 'center', kerning: true,
      lineHeight: 1.25, curveTolerance: tol, onMissing: 'skip',
    });
    if (!plan.shapes.length) break;
    const bb = plan.bbox;
    const yOff = yFrac * rFit;
    let worst = 0;
    for (const cx of [bb.min[0], bb.max[0]]) {
      for (const cy of [bb.min[1] + yOff, bb.max[1] + yOff]) worst = Math.max(worst, Math.hypot(cx, cy));
    }
    if (worst <= rFit || worst < 1e-9) break;
    const k = (rFit / worst) * 0.995;
    fit *= k;
    cap *= k;
  }
  if (!plan || !plan.shapes.length) {
    return { ink: [], missing: plan ? plan.missing : [], fit: 0, capMm: 0, error: 'nothing to engrave' };
  }

  const yOff = yFrac * rFit;
  let ink = plan.shapes.map(s => s.map(r => r.map(pt => [pt[0], pt[1] + yOff])));
  // Two glyphs that overlap (tight spacing, a heavy face) would otherwise be two
  // interpenetrating pockets rather than one.
  ink = dropSpecks(P.boolean(ink, ink, 'union'), (tol * 2) ** 2);

  const bb = plan.bbox;
  const zone = {
    cx: 0, cy: (bb.min[1] + bb.max[1]) / 2 + yOff,
    w: bb.size[0], h: bb.size[1],
  };
  return { ink, missing: plan.missing, fit, capMm: cap, zone, rFit };
}

/** The flat panel the letters sit on: their block, grown, with soft corners. */
function textClearZone(zone, margin, sf) {
  const w = zone.w + margin * 2, h = zone.h + margin * 2;
  const r = Math.min(margin * 1.6 + 0.6, Math.min(w, h) / 2 - 1e-6);
  const ring = r > 0.05
    ? P.roundRect(w, h, r, { segs: nseg(8, sf, 3) })
    : P.rect(w, h);
  return P.ensureCCW(ring.map(pt => [pt[0] + zone.cx, pt[1] + zone.cy]));
}

// ---------------------------------------------------------------------------
// Dimension callouts
//
// A callout is placed against the default iso view, which looks from +x, -y:
// a wall thickness goes on the edge that faces the camera, a well depth on the
// far wall the camera looks down onto. Every point is computed from the same
// rings the geometry was built from, then shifted by the same offset the mesh
// was — never re-derived from the parameters.
// ---------------------------------------------------------------------------

const VIEW = [Math.cos(-Math.PI / 3), Math.sin(-Math.PI / 3)];

/** The edge of a CCW ring whose midpoint lies furthest along `dir`: midpoint and inward unit normal. */
function edgeToward(ring, dir) {
  if (!ring || ring.length < 3) return null;
  let best = null, bestD = -Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const d = mx * dir[0] + my * dir[1];
    if (d > bestD) {
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      bestD = d; best = { mid: [mx, my], inward: [-ey / l, ex / l] };
    }
  }
  return best;
}

/** The vertex of a set of shapes furthest along `dir`. */
function vertexToward(shapes, dir) {
  let best = null, bestD = -Infinity;
  for (const s of shapes) for (const r of s) for (const v of r) {
    const d = v[0] * dir[0] + v[1] * dir[1];
    if (d > bestD) { bestD = d; best = v; }
  }
  return best;
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const v of ring) { x += v[0]; y += v[1]; }
  return [x / ring.length, y / ring.length];
}

/**
 * Two grid-lattice cells exactly `s` apart, preferring the pair nearest `at`.
 * Across a row neighbour the cell wall is a flat for every grid kind, so the
 * material between the two is measured along the centre line.
 */
function cellPair(rings, s, at) {
  const cs = rings.map(centroid);
  let best = null;
  for (let i = 0; i < cs.length; i++) {
    for (let j = 0; j < cs.length; j++) {
      if (i === j) continue;
      if (Math.abs(Math.hypot(cs[j][0] - cs[i][0], cs[j][1] - cs[i][1]) - s) > 1e-6) continue;
      const score = Math.hypot(cs[i][0] - at[0], cs[i][1] - at[1]) + Math.hypot(cs[j][0] - at[0], cs[j][1] - at[1]);
      if (!best || score < best.score) best = { a: cs[i], b: cs[j], score };
    }
  }
  if (!best) return null;
  const dx = best.b[0] - best.a[0], dy = best.b[1] - best.a[1];
  return { a: best.a, b: best.b, u: [dx / s, dy / s] };
}

/** Where the built mesh ends up after centerXY().dropToPlate(), so callouts can follow it. */
function placeOffset(m) {
  const b = m.bbox();
  return [-b.center[0], -b.center[1], -b.min[2]];
}

// ---------------------------------------------------------------------------
// The coaster
// ---------------------------------------------------------------------------

function buildCoaster(p, ctx) {
  const sf = ctx.segFactor || 1;
  const tol = clamp(0.05 / sf, 0.01, 0.12);
  const notes = [];

  const outer = outlineRing(p, sf);
  const ob = P.bounds([outer]);
  const rIn = inRadius(outer);

  const T = clamp(num(p.baseThickness, 3), 0.4, 60);
  let L = clamp(num(p.lipHeight, 2.5), 0, 60);
  let W = clamp(num(p.lipWidth, 4), 0.2, 200);
  if (W > rIn * 0.6) { W = rIn * 0.6; notes.push(`Lip narrowed to ${W.toFixed(1)} mm — 60% of the way to the centre is as wide as a lip can be.`); }

  let well = L > 1e-6 ? insetOutline(outer, W, tol) : null;
  if (well && P.area(well) < Math.PI * 4) { well = null; notes.push('The lip left no well worth having, so it was dropped.'); }
  const hasLip = !!well;
  if (!hasLip) L = 0;
  const H = T + L;

  // A chamfer wider than the lip would cut through the well; wider than half the
  // slab would meet itself in the middle.
  let cB = clamp(num(p.baseChamfer, 0.6), 0, 20);
  let cT = clamp(num(p.topChamfer, 0.4), 0, 20);
  cB = Math.min(cB, T * 0.6, rIn * 0.3);
  cT = Math.min(cT, hasLip ? Math.min(W * 0.4, L * 0.5) : Math.min(T * 0.4, rIn * 0.3));
  if (cB + cT > H - 0.15) { const k = Math.max(0, (H - 0.15)) / (cB + cT); cB *= k; cT *= k; }

  const m = new Mesh();
  const walls = slabWalls(m, [outer], 0, H, cB, cT);
  capShapes(m, [[walls.lo[0]]], 0, false);

  const surfaceZ = hasLip ? T : H;
  const surfaceBoundary = hasLip ? well : walls.hi[0];

  if (hasLip) {
    // The lip's top face, and the well treated as one big pocket in it.
    capShapes(m, [[walls.hi[0], P.ensureCW(well)]], H, true);
    const wellCCW = P.ensureCCW(well);
    stripIn(m, addRingAt(m, wellCCW, T), addRingAt(m, wellCCW, H));
  }

  // ---- what gets cut into the floor -------------------------------------
  const border = Math.max(num(p.borderWidth, 3), 0.8);
  const treat = insetOutline(surfaceBoundary, border, tol);
  const maxDepth = T - MIN_POCKET_FLOOR;
  const gw = clamp(num(p.grooveWidth, 1.6), 0.1, 40);
  let gd = clamp(num(p.grooveDepth, 0.8), 0, 40);
  let ed = clamp(num(p.engraveDepth, 0.8), 0, 40);
  if (gd > maxDepth) { gd = Math.max(0, maxDepth); }
  if (ed > maxDepth) { ed = Math.max(0, maxDepth); }
  if (gd < 0.15) gd = 0;
  if (ed < 0.15) ed = 0;
  if ((num(p.grooveDepth, 0.8) > gd || num(p.engraveDepth, 0.8) > ed) && maxDepth > 0.15) {
    notes.push(`Pocket depth limited to ${maxDepth.toFixed(2)} mm so ${MIN_POCKET_FLOOR} mm of floor is left under it.`);
  }

  let grooves = [];
  const info = { cells: 0, spokes: 0, rings: 0, cell: 0 };
  // Where the pattern's callouts go: a point across a groove (width), the top of
  // a groove wall that faces the camera (depth), and the pattern's own pitch.
  const feat = { gwFrom: null, gwTo: null, gdAt: null, pitchFrom: null, pitchTo: null, pitchIs: 0 };
  if (treat && gd > 0) {
    switch (p.surface) {
      case 'rings': {
        grooves = ringsPattern(treat, gw, num(p.ringPitch, 5), tol);
        info.rings = grooves.length;
        const far = edgeToward(P.ensureCCW(treat), [-VIEW[0], -VIEW[1]]);
        if (far) {
          const [mx, my] = far.mid, [nx, ny] = far.inward;
          feat.gwFrom = [mx, my]; feat.gwTo = [mx + nx * gw, my + ny * gw];
          feat.gdAt = [mx, my];
          const step = Math.max(num(p.ringPitch, 5), gw + 0.4);
          if (grooves.length >= 2) { feat.pitchFrom = [mx, my]; feat.pitchTo = [mx + nx * step, my + ny * step]; feat.pitchIs = step; }
        }
        break;
      }
      case 'radial': {
        const r = radialPattern(treat, gw, num(p.spokeCount, 18), sf);
        grooves = r.grooves; info.spokes = r.grooves.length; info.hub = r.hub;
        if (r.reduced) notes.push(`Spokes reduced to ${r.spokes}: any more and they would touch at the hub.`);
        // The spoke on the far side, whose rounded tip faces the camera.
        let far = null, farD = -Infinity;
        for (const s of r.grooves) {
          const c = centroid(s[0]);
          const d = -(c[0] * VIEW[0] + c[1] * VIEW[1]);
          if (d > farD) { farD = d; far = { c, ring: s[0] }; }
        }
        if (far) {
          const th = Math.atan2(far.c[1], far.c[0]);
          const ux = Math.cos(th), uy = Math.sin(th);
          let reach = 0;
          for (const v of far.ring) reach = Math.max(reach, (v[0] - far.c[0]) * ux + (v[1] - far.c[1]) * uy);
          feat.gwFrom = [far.c[0] + uy * gw / 2, far.c[1] - ux * gw / 2];
          feat.gwTo = [far.c[0] - uy * gw / 2, far.c[1] + ux * gw / 2];
          feat.gdAt = [far.c[0] + ux * reach, far.c[1] + uy * reach];
        }
        break;
      }
      case 'hex': {
        const r = hexPattern(treat, gw, num(p.cellSize, 10), tol);
        grooves = r.grooves; info.cells = r.cells; info.cell = r.cell;
        if (r.cell > num(p.cellSize, 10) + 1e-6) notes.push(`Cell size raised to ${r.cell.toFixed(1)} mm to keep the pattern under ${MAX_CELLS} cells.`);
        // Two pads in one row, towards the far side so the text zone (which sits
        // in the middle) does not cut them. Flats face the row neighbour, so the
        // web between them is the groove width along the centre line.
        const pads = r.grooves.length ? r.grooves[0].slice(1) : [];
        const pair = pads.length >= 2 ? cellPair(pads, r.cell, [-VIEW[0] * 1e4, -VIEW[1] * 1e4]) : null;
        if (pair) {
          const half = (r.cell - gw) / 2;
          feat.gwFrom = [pair.a[0] + pair.u[0] * half, pair.a[1] + pair.u[1] * half];
          feat.gwTo = [pair.b[0] - pair.u[0] * half, pair.b[1] - pair.u[1] * half];
          feat.pitchFrom = pair.a; feat.pitchTo = pair.b; feat.pitchIs = r.cell;
          // The pad flat that faces the camera exactly: flats sit at 0°, ±60°, ...
          // and the camera is at -60°.
          feat.gdAt = [pair.a[0] + VIEW[0] * half, pair.a[1] + VIEW[1] * half];
        }
        break;
      }
      default: break;
    }
  }

  // ---- engraving ---------------------------------------------------------
  const tp = ed > 0 && treat ? planText(p, treat, sf) : null;
  let ink = [];
  if (tp && tp.ink && tp.ink.length) {
    ink = tp.ink;
    if (grooves.length) {
      // A flat panel around the letters. Cutting the pattern away rather than
      // letting the two pockets meet is what keeps them at their own depths.
      const zone = textClearZone(tp.zone, Math.max(1.2, gw * 1.2), sf);
      grooves = dropSpecks(P.boolean(grooves, [[zone]], 'difference'), Math.max(0.08, gw * gw * 0.12));
      if (p.surface === 'hex') info.cells = Math.max(0, (grooves[0] ? grooves[0].length - 1 : 0));
      if (p.surface === 'rings') info.rings = grooves.length;
      if (p.surface === 'radial') info.spokes = grooves.length;
    }
  } else if (tp && tp.error) {
    notes.push(`Engraving skipped: ${tp.error}.`);
  }

  const groups = [];
  if (grooves.length && gd > 0) groups.push({ shapes: grooves, depth: gd });
  if (ink.length && ed > 0) groups.push({ shapes: ink, depth: ed });
  sinkPockets(m, groups, surfaceZ, [P.ensureCCW(surfaceBoundary)]);

  // ---- what the numbers actually are -------------------------------------
  const wellArea = hasLip ? P.area(well) : 0;
  let pocketVol = 0;
  for (const g of groups) pocketVol += shapesArea(g.shapes) * g.depth;
  const catchment = wellArea * L + pocketVol;

  const off = placeOffset(m);
  const mesh = m.centerXY().dropToPlate();

  // ---- dimension callouts -------------------------------------------------
  const pt = (xy, z) => [xy[0] + off[0], xy[1] + off[1], z + off[2]];
  const dims = [];
  const front = edgeToward(outer, VIEW);
  if (front) {
    const out = [-front.inward[0], -front.inward[1], 0];
    dims.push({ param: 'baseThickness', label: 'floor', from: pt(front.mid, 0), to: pt(front.mid, T), offset: out });
    if (walls.chamferedLo) {
      dims.push({ param: 'baseChamfer', label: 'chamfer', from: pt(front.mid, 0), to: pt(front.mid, cB), offset: out,
        ...(Math.abs(cB - num(p.baseChamfer, 0.6)) > 1e-9 ? { value: cB } : {}) });
    }
    if (walls.chamferedHi) {
      dims.push({ param: 'topChamfer', label: 'chamfer', from: pt(front.mid, H - cT), to: pt(front.mid, H), offset: out,
        ...(Math.abs(cT - num(p.topChamfer, 0.4)) > 1e-9 ? { value: cT } : {}) });
    }
    if (hasLip) {
      const [mx, my] = front.mid, [nx, ny] = front.inward;
      dims.push({ param: 'lipWidth', label: 'lip', from: pt(front.mid, H), to: pt([mx + nx * W, my + ny * W], H), offset: 8,
        ...(Math.abs(W - num(p.lipWidth, 4)) > 1e-9 ? { value: W } : {}) });
    }
  }
  if (hasLip) {
    // The far wall of the well is the one the camera looks down onto.
    const farWell = edgeToward(P.ensureCCW(well), [-VIEW[0], -VIEW[1]]);
    if (farWell) {
      dims.push({ param: 'lipHeight', label: 'lip', from: pt(farWell.mid, T), to: pt(farWell.mid, H),
        offset: [-farWell.inward[0], -farWell.inward[1], 0] });
    }
  }
  if (treat) {
    const farFloor = edgeToward(P.ensureCCW(surfaceBoundary), [-VIEW[0], -VIEW[1]]);
    if (farFloor) {
      const [mx, my] = farFloor.mid, [nx, ny] = farFloor.inward;
      dims.push({ param: 'borderWidth', label: 'border', from: pt(farFloor.mid, surfaceZ),
        to: pt([mx + nx * border, my + ny * border], surfaceZ), offset: 8 });
    }
  }
  if (grooves.length && gd > 0) {
    if (feat.gwFrom) dims.push({ param: 'grooveWidth', label: 'groove', from: pt(feat.gwFrom, surfaceZ), to: pt(feat.gwTo, surfaceZ), offset: 8 });
    if (feat.gdAt) {
      dims.push({ param: 'grooveDepth', label: 'groove', from: pt(feat.gdAt, surfaceZ - gd), to: pt(feat.gdAt, surfaceZ), offset: 8,
        ...(Math.abs(gd - num(p.grooveDepth, 0.8)) > 1e-9 ? { value: gd } : {}) });
    }
    if (feat.pitchFrom) {
      const key = p.surface === 'hex' ? 'cellSize' : 'ringPitch';
      const asked = p.surface === 'hex' ? num(p.cellSize, 10) : num(p.ringPitch, 5);
      dims.push({ param: key, label: 'pitch', from: pt(feat.pitchFrom, surfaceZ), to: pt(feat.pitchTo, surfaceZ), offset: 8,
        ...(Math.abs(feat.pitchIs - asked) > 1e-9 ? { value: feat.pitchIs } : {}) });
    }
  }
  if (ink.length && ed > 0) {
    const v = vertexToward(ink, [-VIEW[0], -VIEW[1]]);
    if (v) {
      dims.push({ param: 'engraveDepth', label: 'engrave', from: pt(v, surfaceZ - ed), to: pt(v, surfaceZ), offset: 8,
        ...(Math.abs(ed - num(p.engraveDepth, 0.8)) > 1e-9 ? { value: ed } : {}) });
    }
    if (tp && tp.zone && tp.capMm > 0) {
      const z = tp.zone, x = z.cx + z.w / 2;
      dims.push({ param: 'textSize', label: 'cap', from: pt([x, z.cy - tp.capMm / 2], surfaceZ), to: pt([x, z.cy + tp.capMm / 2], surfaceZ),
        offset: 8, value: tp.capMm });
    }
  }

  return {
    mesh,
    meta: {
      dims,
      variant: 'coaster',
      outline: p.outline,
      width: round3(ob.size[0]), depth: round3(ob.size[1]), height: round3(H),
      baseThickness: round3(T), lipHeight: round3(L), lipWidth: round3(hasLip ? W : 0),
      baseChamfer: round3(cB), topChamfer: round3(cT),
      hasLip,
      wellArea: round3(wellArea),
      wellWidth: hasLip ? round3(P.bounds([well]).size[0]) : 0,
      catchmentMl: Math.round(catchment / 1000 * 100) / 100,
      catchmentMm3: Math.round(catchment),
      surface: gd > 0 ? p.surface : 'none',
      grooveDepth: round3(gd), grooveWidth: round3(gw),
      grooveArea: round3(shapesArea(grooves)),
      rings: info.rings, spokes: info.spokes, cells: info.cells,
      cellSize: info.cell ? round3(info.cell) : 0,
      engraveDepth: ink.length ? round3(ed) : 0,
      textCapMm: tp && tp.capMm ? round3(tp.capMm) : 0,
      textShrunkTo: tp && tp.fit ? Math.round(tp.fit * 1000) / 1000 : 1,
      textMissing: tp && tp.missing ? tp.missing : [],
      volumeCm3: Math.round(mesh.volume() / 1000 * 100) / 100,
      notes,
    },
  };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// The trivet
// ---------------------------------------------------------------------------

const LATTICES = [
  { v: 'hex', label: 'Honeycomb', help: 'Hexagonal holes. The stiffest lattice for a given weight.' },
  { v: 'square', label: 'Square grid', help: 'Softened square holes. Reads as a grille.' },
  { v: 'round', label: 'Drilled', help: 'Round holes on a hex packing. The most open for a given bar width.' },
  { v: 'radial', label: 'Radial', help: 'Concentric bands cut by spokes, with a solid hub in the middle.' },
];

/** Hole rings for a lattice, culled to those that sit fully inside `inner`. */
function latticeHoles(kind, inner, cellWanted, barWidth, sf, blocked) {
  const b = P.bounds([inner]);
  const span = Math.max(b.size[0], b.size[1], 1);
  let s = Math.max(cellWanted, barWidth + 1.0);
  const density = kind === 'radial' ? 1 : (kind === 'hex' || kind === 'round') ? Math.sqrt(3) / 2 : 1;
  const estimate = (c) => (b.size[0] / c + 2) * (b.size[1] / (c * density) + 2);
  while (estimate(s) > MAX_CELLS && s < span) s *= 1.15;

  const holes = [];
  const keep = (ring) => {
    if (holes.length >= MAX_CELLS) return;
    if (blocked && blocked(ring)) return;
    if (!ringInsideRing(ring, inner)) return;
    holes.push(P.ensureCW(ring));
  };

  if (kind === 'radial') {
    const rMax = inRadius(inner);
    const hub = Math.max(s * 0.55, barWidth * 2, 5);
    const band = Math.max(s - barWidth, 1.0);
    const segs = nseg(6, sf, 3);
    for (let r0 = hub; r0 + band < rMax + s; r0 += band + barWidth) {
      const r1 = r0 + band;
      const rMid = (r0 + r1) / 2;
      const count = Math.max(4, Math.round(TAU * rMid / s));
      const gapAng = barWidth / rMid;
      const cellAng = TAU / count - gapAng;
      if (cellAng <= 0.02) continue;
      const arcSegs = clamp(Math.ceil(cellAng * r1 / 1.2), 2, 16) * (sf >= 2 ? 2 : 1);
      for (let i = 0; i < count; i++) {
        const a0 = TAU * i / count + gapAng / 2, a1 = a0 + cellAng;
        const ring = [];
        for (let k = 0; k <= arcSegs; k++) { const a = a0 + (a1 - a0) * k / arcSegs; ring.push([r0 * Math.cos(a), r0 * Math.sin(a)]); }
        for (let k = arcSegs; k >= 0; k--) { const a = a0 + (a1 - a0) * k / arcSegs; ring.push([r1 * Math.cos(a), r1 * Math.sin(a)]); }
        keep(P.ensureCCW(ring));
      }
    }
    return { holes, cell: s };
  }

  const rowStep = s * density;
  const rows = Math.ceil(b.size[1] / rowStep) + 2;
  const cols = Math.ceil(b.size[0] / s) + 2;
  for (let j = -rows; j <= rows; j++) {
    const y = j * rowStep;
    if (y < b.min[1] - s || y > b.max[1] + s) continue;
    for (let i = -cols; i <= cols; i++) {
      const stagger = (kind === 'hex' || kind === 'round') && (j & 1) ? s / 2 : 0;
      const x = i * s + stagger;
      if (x < b.min[0] - s || x > b.max[0] + s) continue;
      let ring;
      if (kind === 'hex') {
        const R = (s - barWidth) / Math.sqrt(3);
        if (!(R > 0.6)) continue;
        ring = P.regularPolygon(6, R, { cx: x, cy: y, rot: Math.PI / 6 });
      } else if (kind === 'round') {
        const R = (s - barWidth) / 2;
        if (!(R > 0.6)) continue;
        ring = P.circle(R, { cx: x, cy: y, segs: nseg(clamp(circleSegs(R, 0.06), 10, 48), sf, 8) });
      } else {
        const side = s - barWidth;
        if (!(side > 1.2)) continue;
        const rr = Math.min(side * 0.22, 2.5);
        ring = P.roundRect(side, side, rr, { segs: nseg(4, sf, 2) }).map(pt => [pt[0] + x, pt[1] + y]);
      }
      keep(P.ensureCCW(ring));
    }
    if (holes.length >= MAX_CELLS) break;
  }
  return { holes, cell: s };
}

function buildTrivet(p, ctx) {
  const sf = ctx.segFactor || 1;
  const tol = clamp(0.05 / sf, 0.01, 0.12);
  const notes = [];

  const outer = outlineRing(p, sf);
  const ob = P.bounds([outer]);
  const rIn = inRadius(outer);
  const T = clamp(num(p.baseThickness, 3), 0.4, 60);

  let rim = clamp(num(p.rimWidth, 10), 1, 200);
  if (rim > rIn * 0.7) { rim = rIn * 0.7; notes.push(`Rim narrowed to ${rim.toFixed(1)} mm — any wider and there is no room for a lattice.`); }
  const bar = clamp(num(p.barWidth, 3), 0.2, 40);

  const inner = insetOutline(outer, rim, tol);
  let holes = [], cell = 0;

  // A medallion: when there is text, the lattice keeps clear of the middle and
  // the letters are engraved into solid material instead of across four bars.
  const tpProbe = String(p.text ?? '').trim() && inner ? planText(p, insetOutline(inner, Math.max(2, bar), tol) || inner, sf) : null;
  let medallion = null;
  if (tpProbe && tpProbe.ink && tpProbe.ink.length) {
    const z = tpProbe.zone;
    const mr = Math.hypot(z.w, z.h) / 2 + Math.max(2.5, bar);
    medallion = { cx: z.cx, cy: z.cy, r: mr };
  }
  const blocked = medallion
    ? (ring) => {
      for (const pt of ring) if (Math.hypot(pt[0] - medallion.cx, pt[1] - medallion.cy) < medallion.r) return true;
      return false;
    }
    : null;

  if (inner) {
    const r = latticeHoles(p.latticePattern, inner, num(p.latticeCell, 18), bar, sf, blocked);
    holes = r.holes; cell = r.cell;
    if (r.cell > num(p.latticeCell, 18) + 1e-6) notes.push(`Lattice cell raised to ${r.cell.toFixed(1)} mm to keep it under ${MAX_CELLS} holes.`);
  }
  if (!holes.length) notes.push('No lattice cell fits inside this rim — the result is a solid plate.');

  // ---- feet --------------------------------------------------------------
  const wantFeet = Math.max(0, Math.round(num(p.footCount, 4)));
  let fh = wantFeet ? clamp(num(p.footHeight, 5), 0.2, 60) : 0;
  let fr = wantFeet ? clamp(num(p.footDiameter, 9), 0.4, 100) / 2 : 0;
  const feet = [];
  if (wantFeet && fh > 0.05) {
    const centreRing = insetOutline(outer, rim / 2, tol);
    if (centreRing) {
      const pts = alongRing(centreRing, wantFeet);
      const limit = Math.min(rim / 2 - 0.8, (pts.spacing || Infinity) / 2 - 0.6);
      if (limit > 0.6) {
        if (fr > limit) { fr = limit; notes.push(`Feet reduced to ${(fr * 2).toFixed(1)} mm across so they stay inside the rim.`); }
        const segs = nseg(clamp(circleSegs(fr, 0.05), 12, 40), sf, 10);
        for (const c of pts) feet.push(P.ensureCCW(P.circle(fr, { cx: c[0], cy: c[1], segs })));
      } else {
        notes.push('The rim is too narrow to carry feet; they were dropped.');
        fh = 0;
      }
    } else { fh = 0; }
  }
  const hasFeet = feet.length > 0 && fh > 0.05;
  if (!hasFeet) fh = 0;

  // ---- chamfers ----------------------------------------------------------
  // Whatever touches the build plate gets the bevel: it is there to swallow the
  // elephant foot, and elephant foot only happens on the first layer.
  const asPrinted = p.printOrientation !== 'as-used';
  let cham = clamp(num(p.baseChamfer, 0.6), 0, 20);
  cham = Math.min(cham, bar * 0.4, rim * 0.4, T * 0.45);
  const footCham = hasFeet ? Math.min(cham, fr * 0.35, fh * 0.45) : 0;
  const slabLo = hasFeet ? 0 : cham;                 // in-use underside
  const slabHi = (asPrinted && hasFeet) ? cham : 0;  // in-use top, on the plate when flipped

  const m = new Mesh();
  const zLo = fh, zHi = fh + T;
  const rings = [outer, ...holes];
  const walls = slabWalls(m, rings, zLo, zHi, slabLo, slabHi);

  // ---- the underside, with the feet hanging off it ------------------------
  const bottomRings = [P.ensureCCW(walls.lo[0]), ...walls.lo.slice(1).map(P.ensureCW), ...feet.map(P.ensureCW)];
  capShapes(m, [bottomRings], zLo, false);
  for (const f of feet) {
    const ccw = P.ensureCCW(f);
    const end = footCham > 1e-9 ? insetRing(ccw, footCham) : null;
    if (end) {
      strip(m, addRingAt(m, end, 0), addRingAt(m, ccw, footCham));
      strip(m, addRingAt(m, ccw, footCham), addRingAt(m, ccw, fh));
      capShapes(m, [[end]], 0, false);
    } else {
      strip(m, addRingAt(m, ccw, 0), addRingAt(m, ccw, fh));
      capShapes(m, [[ccw]], 0, false);
    }
  }

  // ---- the top face, with any engraving ----------------------------------
  const topBoundary = [P.ensureCCW(walls.hi[0]), ...walls.hi.slice(1).map(P.ensureCW)];
  const maxDepth = T - MIN_POCKET_FLOOR;
  let ed = clamp(num(p.engraveDepth, 0.8), 0, 40);
  if (ed > maxDepth) ed = Math.max(0, maxDepth);
  if (ed < 0.15) ed = 0;
  let ink = [], tp = null;
  if (medallion && ed > 0) {
    // Re-plan against the medallion itself so the letters cannot creep past it.
    const disc = P.circle(medallion.r - Math.max(1.5, bar * 0.5), { cx: medallion.cx, cy: medallion.cy, segs: nseg(64, sf, 24) });
    tp = planText(p, disc, sf);
    if (tp && tp.ink && tp.ink.length) ink = tp.ink;
  }
  sinkPockets(m, ink.length ? [{ shapes: ink, depth: ed }] : [], zHi, topBoundary);

  // ---- numbers -----------------------------------------------------------
  const outlineArea = P.area(outer);
  let holeArea = 0;
  for (const h of holes) holeArea += P.area(h);
  const materialArea = outlineArea - holeArea;
  const freeAir = outlineArea > 0 ? holeArea / outlineArea : 0;

  let mesh = m;
  const flipped = asPrinted && hasFeet;
  if (flipped) mesh = mesh.rotateX(Math.PI);   // a rotation, so the winding survives
  const off = placeOffset(mesh);
  mesh = mesh.centerXY().dropToPlate();

  // ---- dimension callouts -------------------------------------------------
  // Declared in the build frame and carried through the same flip and shift the
  // mesh got, so a feet-up trivet's callouts land on the feet-up object.
  const pt = (xy, z) => flipped ? [xy[0] + off[0], -xy[1] + off[1], -z + off[2]] : [xy[0] + off[0], xy[1] + off[1], z + off[2]];
  const dir = (d) => flipped ? [d[0], -d[1], -d[2]] : d;
  const V = flipped ? [VIEW[0], -VIEW[1]] : VIEW;        // towards the camera, in the build frame
  const zFace = flipped ? zLo : zHi;                     // the face that is uppermost as delivered
  const dims = [];
  const front = edgeToward(outer, V);
  if (front) {
    const [mx, my] = front.mid, [nx, ny] = front.inward;
    const out = dir([-nx, -ny, 0]);
    dims.push({ param: 'baseThickness', label: 'slab', from: pt(front.mid, zLo), to: pt(front.mid, zHi), offset: out });
    dims.push({ param: 'rimWidth', label: 'rim', from: pt(front.mid, zFace), to: pt([mx + nx * rim, my + ny * rim], zFace), offset: 8,
      ...(Math.abs(rim - num(p.rimWidth, 10)) > 1e-9 ? { value: rim } : {}) });
    const askedCham = num(p.baseChamfer, 0.6);
    if (walls.chamferedHi && slabHi > 1e-9) {
      dims.push({ param: 'baseChamfer', label: 'chamfer', from: pt(front.mid, zHi - cham), to: pt(front.mid, zHi), offset: out,
        ...(Math.abs(cham - askedCham) > 1e-9 ? { value: cham } : {}) });
    } else if (walls.chamferedLo && slabLo > 1e-9) {
      dims.push({ param: 'baseChamfer', label: 'chamfer', from: pt(front.mid, zLo), to: pt(front.mid, zLo + cham), offset: out,
        ...(Math.abs(cham - askedCham) > 1e-9 ? { value: cham } : {}) });
    }
  }
  if (holes.length) {
    if (p.latticePattern === 'radial') {
      // Bands: measure radially at one cell of the innermost band, out to the
      // band beyond it, where the bar between bands is exactly the bar width.
      const cells = holes.map(h => {
        let rMin = Infinity, rMax = 0, aMin = Infinity, aMax = -Infinity;
        const c = centroid(h), ac = Math.atan2(c[1], c[0]);
        for (const v of h) {
          const r = Math.hypot(v[0], v[1]); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
          let a = Math.atan2(v[1], v[0]) - ac; a = Math.atan2(Math.sin(a), Math.cos(a));
          aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
        }
        return { rMin, rMax, ac, aMin: ac + aMin, aMax: ac + aMax };
      });
      const r0 = Math.min(...cells.map(c => c.rMin));
      const covers = (c, a) => { let d = a - c.ac; d = Math.atan2(Math.sin(d), Math.cos(d)); return d >= c.aMin - c.ac - 1e-9 && d <= c.aMax - c.ac + 1e-9; };
      const vAng = Math.atan2(V[1], V[0]);
      let A = null, best = Infinity;
      for (const c of cells) {
        if (Math.abs(c.rMin - r0) > 1e-6) continue;
        const next = cells.find(o => Math.abs(o.rMin - (c.rMax + bar)) < 1e-6 && covers(o, c.ac));
        if (!next) continue;
        let d = c.ac - vAng; d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
        if (d < best) { best = d; A = c; }
      }
      if (A) {
        const u = [Math.cos(A.ac), Math.sin(A.ac)];
        dims.push({ param: 'barWidth', label: 'bar', from: pt([u[0] * A.rMax, u[1] * A.rMax], zFace), to: pt([u[0] * (A.rMax + bar), u[1] * (A.rMax + bar)], zFace), offset: 8 });
        dims.push({ param: 'latticeCell', label: 'pitch', from: pt([u[0] * A.rMin, u[1] * A.rMin], zFace), to: pt([u[0] * (A.rMin + cell), u[1] * (A.rMin + cell)], zFace), offset: 8,
          ...(Math.abs(cell - num(p.latticeCell, 18)) > 1e-9 ? { value: cell } : {}) });
      }
    } else {
      const pair = holes.length >= 2 ? cellPair(holes, cell, [V[0] * 1e4, V[1] * 1e4]) : null;
      if (pair) {
        const half = (cell - bar) / 2;
        dims.push({ param: 'barWidth', label: 'bar', from: pt([pair.a[0] + pair.u[0] * half, pair.a[1] + pair.u[1] * half], zFace),
          to: pt([pair.b[0] - pair.u[0] * half, pair.b[1] - pair.u[1] * half], zFace), offset: 8 });
        dims.push({ param: 'latticeCell', label: 'pitch', from: pt(pair.a, zFace), to: pt(pair.b, zFace), offset: 8,
          ...(Math.abs(cell - num(p.latticeCell, 18)) > 1e-9 ? { value: cell } : {}) });
      }
    }
  }
  if (hasFeet) {
    // The foot nearest the camera; its wall on the camera side, its width across the view.
    let foot = null, fd = -Infinity;
    for (const f of feet) { const c = centroid(f); const d = c[0] * V[0] + c[1] * V[1]; if (d > fd) { fd = d; foot = c; } }
    const wall = [foot[0] + V[0] * fr, foot[1] + V[1] * fr];
    dims.push({ param: 'footHeight', label: 'foot', from: pt(wall, 0), to: pt(wall, fh), offset: dir([V[0], V[1], 0]),
      ...(Math.abs(fh - num(p.footHeight, 5)) > 1e-9 ? { value: fh } : {}) });
    const across = [-V[1], V[0]];
    dims.push({ param: 'footDiameter', label: 'Ø', from: pt([foot[0] - across[0] * fr, foot[1] - across[1] * fr], footCham),
      to: pt([foot[0] + across[0] * fr, foot[1] + across[1] * fr], footCham), offset: 8,
      ...(Math.abs(fr * 2 - num(p.footDiameter, 9)) > 1e-9 ? { value: fr * 2 } : {}) });
    if (!dims.some(d => d.param === 'baseChamfer') && footCham > 1e-9) {
      // As-used with feet: the slab has no bevel, only the feet touch the plate.
      dims.push({ param: 'baseChamfer', label: 'chamfer', from: pt(wall, 0), to: pt(wall, footCham), offset: dir([V[0], V[1], 0]), value: footCham });
    }
  }
  if (ink.length && ed > 0) {
    const v = vertexToward(ink, [-V[0], -V[1]]);
    if (v) {
      dims.push({ param: 'engraveDepth', label: 'engrave', from: pt(v, zHi - ed), to: pt(v, zHi), offset: 8,
        ...(Math.abs(ed - num(p.engraveDepth, 0.8)) > 1e-9 ? { value: ed } : {}) });
    }
    if (tp && tp.zone && tp.capMm > 0) {
      const z = tp.zone, x = z.cx + z.w / 2;
      dims.push({ param: 'textSize', label: 'cap', from: pt([x, z.cy - tp.capMm / 2], zHi), to: pt([x, z.cy + tp.capMm / 2], zHi),
        offset: 8, value: tp.capMm });
    }
  }

  return {
    mesh,
    meta: {
      dims,
      variant: 'trivet',
      outline: p.outline,
      width: round3(ob.size[0]), depth: round3(ob.size[1]),
      height: round3(T + fh),
      thickness: round3(T), rimWidth: round3(rim), barWidth: round3(bar),
      lattice: holes.length ? p.latticePattern : 'none',
      cellSize: round3(cell), cells: holes.length,
      outlineArea: round3(outlineArea), materialArea: round3(materialArea),
      freeAirFraction: Math.round(freeAir * 10000) / 10000,
      feet: feet.length, footHeight: round3(fh), footDiameter: round3(fr * 2),
      footChamfer: round3(footCham), edgeChamfer: round3(cham),
      printOrientation: asPrinted && hasFeet ? 'as-printed (feet up)' : 'as-used (feet down)',
      flipped: asPrinted && hasFeet,
      engraveDepth: ink.length ? round3(ed) : 0,
      medallion: medallion ? round3(medallion.r * 2) : 0,
      volumeCm3: Math.round(mesh.volume() / 1000 * 100) / 100,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// Slicing arithmetic used by hints() and validate()
// ---------------------------------------------------------------------------

/** How badly a height misses a whole number of layers, and the nearest ones that do not. */
function layerFit(value, layerH) {
  if (!(value > 0) || !(layerH > 0)) return null;
  const n = value / layerH;
  const off = Math.abs(n - Math.round(n));
  if (off < 0.06) return null;
  return { layers: n, down: Math.floor(n) * layerH, up: Math.ceil(n) * layerH };
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/>' +
  '<circle cx="12" cy="12" r="6.4"/><circle cx="12" cy="12" r="3.4"/></svg>';

const gen = {
  id: 'coaster',
  name: 'Coaster & Trivet',
  category: 'Kitchen',
  blurb: 'Drinks coasters with a stated spill capacity, and open-lattice trivets with feet.',
  description:
    'A coaster is the easiest thing here to print, so this generator is about getting it exactly ' +
    'right instead. Pick a circle, a square with any corner radius, a hexagon or a superformula ' +
    'flower; the outline is scaled so its widest dimension is the number you typed. A raised lip ' +
    'with a vertical inner wall turns the top into a tray whose capacity is stated in millilitres, ' +
    'and a chamfer under the edge means it never scrapes the table. The floor can carry concentric ' +
    'grooves that follow the outline, a sunburst, a hex drainage web that keeps the glass out of ' +
    'the puddle, and text engraved from real TrueType outlines. The trivet variant is a different ' +
    'object: an open lattice with a stated free-air fraction, a solid rim, feet, and a print ' +
    'orientation chosen so those feet come out without support.',
  icon: ICON,
  version: 1,

  params: [
    { key: 'variant', label: 'What it is', type: 'enum', def: 'coaster', group: 'Shape',
      options: [
        { v: 'coaster', label: 'Coaster', help: 'A tray for a glass: solid floor, raised lip, stated capacity.' },
        { v: 'trivet', label: 'Trivet', help: 'An open lattice on feet for a hot pan. Not a coaster with holes.' },
      ],
      help: 'The two are different objects, not two sizes of the same one.' },
    { key: 'outline', label: 'Outline', type: 'enum', def: 'circle', group: 'Shape', options: OUTLINES,
      help: 'Every surface treatment follows whichever outline you choose.' },
    { key: 'sfPreset', label: 'Curve', type: 'enum', def: 'flower6', group: 'Shape',
      options: Object.keys(P.SUPERFORMULA_PRESETS).map(k => ({ v: k, label: k })),
      showIf: (p) => p.outline === 'superformula',
      help: 'Gielis superformula families. "gem" and "roundedSquare" are the calmest; "star5" is the most extreme.' },
    { key: 'size', label: 'Across', type: 'number', def: 95, min: 40, max: 178, step: 1, unit: 'mm', group: 'Shape',
      help: 'The widest dimension of the finished object, to the digit. 90–100 mm suits a pint glass; a trivet wants 150+.' },
    { key: 'cornerRadius', label: 'Corner radius', type: 'number', def: 10, min: 0, max: 60, step: 1, unit: 'mm',
      group: 'Shape', showIf: (p) => p.outline === 'square',
      help: 'Clamped to half the width, which turns the square into a circle.' },
    { key: 'outlineRotation', label: 'Rotate outline', type: 'number', def: 0, min: 0, max: 90, step: 5, unit: '°',
      group: 'Shape',
      help: 'Turns a hexagon point-up or a flower onto its side. The size is re-measured afterwards, so it stays exact.' },

    { key: 'baseThickness', label: 'Base thickness', type: 'number', def: 3, min: 1.2, max: 15, step: 0.2, unit: 'mm',
      group: 'Body',
      help: 'Floor under the well, and the whole slab thickness for a trivet. Under 2 mm a wide flat part curls at the corners.' },
    { key: 'lipHeight', label: 'Lip height', type: 'number', def: 2.5, min: 0, max: 12, step: 0.1, unit: 'mm',
      group: 'Body', showIf: (p) => p.variant === 'coaster',
      help: 'How far the rim stands above the floor. This times the well area IS the stated capacity. 0 gives a flat mat.' },
    { key: 'lipWidth', label: 'Lip width', type: 'number', def: 4, min: 1, max: 25, step: 0.5, unit: 'mm',
      group: 'Body', showIf: (p) => p.variant === 'coaster',
      help: 'How far the rim reaches in. The inner wall is kept vertical so the capacity is exact and a glass has a shoulder to sit against.' },
    { key: 'baseChamfer', label: 'Underside chamfer', type: 'number', def: 0.6, min: 0, max: 3, step: 0.1, unit: 'mm',
      group: 'Body',
      help: 'A 45° bevel on whatever touches the plate. It swallows the elephant foot, so leave the slicer’s compensation at 0.' },
    { key: 'topChamfer', label: 'Top edge chamfer', type: 'number', def: 0.4, min: 0, max: 3, step: 0.1, unit: 'mm',
      group: 'Body', showIf: (p) => p.variant === 'coaster',
      help: 'Breaks the sharp outer edge of the lip. Only the outer edge — the inner one stays square so the capacity stays exact.' },

    { key: 'surface', label: 'Surface', type: 'enum', def: 'rings', group: 'Surface',
      showIf: (p) => p.variant === 'coaster',
      options: [
        { v: 'none', label: 'Plain', help: 'A flat floor. The only option you should iron.' },
        { v: 'rings', label: 'Concentric grooves', help: 'Rings that follow the outline, so a hexagon gets hexagons.' },
        { v: 'radial', label: 'Sunburst', help: 'Spokes from a central hub out to the real boundary.' },
        { v: 'hex', label: 'Hex drainage', help: 'Hex pads with a connected web between them; the spill runs off the contact patch.' },
      ],
      help: 'Cut into the floor of the well, never raised — a raised pattern is what the glass would stand on.' },
    { key: 'grooveWidth', label: 'Groove width', type: 'number', def: 1.6, min: 0.4, max: 8, step: 0.1, unit: 'mm',
      group: 'Surface', showIf: (p) => p.variant === 'coaster' && p.surface !== 'none',
      help: 'Under two nozzle widths (0.8 mm) the top surface simply bridges over the groove and it disappears.' },
    { key: 'grooveDepth', label: 'Groove depth', type: 'number', def: 0.8, min: 0.2, max: 4, step: 0.1, unit: 'mm',
      group: 'Surface', showIf: (p) => p.variant === 'coaster' && p.surface !== 'none',
      help: 'Four layers at 0.2 mm. Deeper grooves hold more spill; the capacity figure counts them.' },
    { key: 'ringPitch', label: 'Ring pitch', type: 'number', def: 5, min: 2, max: 25, step: 0.5, unit: 'mm',
      group: 'Surface', showIf: (p) => p.variant === 'coaster' && p.surface === 'rings',
      help: 'Centre to centre. The flat land between grooves is this minus the groove width.' },
    { key: 'spokeCount', label: 'Spokes', type: 'int', def: 18, min: 3, max: 72, step: 1,
      group: 'Surface', showIf: (p) => p.variant === 'coaster' && p.surface === 'radial',
      help: 'Reduced automatically if they would collide at the hub.' },
    { key: 'cellSize', label: 'Hex cell', type: 'number', def: 10, min: 4, max: 40, step: 0.5, unit: 'mm',
      group: 'Surface', showIf: (p) => p.variant === 'coaster' && p.surface === 'hex',
      help: 'Centre to centre of the pads. Raised automatically rather than emitting thousands of cells.' },
    { key: 'borderWidth', label: 'Flat border', type: 'number', def: 3, min: 0.8, max: 20, step: 0.5, unit: 'mm',
      group: 'Surface', showIf: (p) => p.variant === 'coaster',
      help: 'Plain floor between the pattern and the lip. Never zero: the pattern must not run into the lip wall.' },

    { key: 'text', label: 'Engraved text', type: 'text', def: '', maxLength: 40, group: 'Engraving',
      help: 'Leave empty for none. Use \\n for a second line. On a trivet the lattice opens out into a medallion for it.' },
    { key: 'font', label: 'Typeface', type: 'enum', def: DEFAULT_FONT, group: 'Engraving',
      options: BUNDLED_FONTS.map(f => ({ v: f.id, label: f.label, help: f.help })),
      help: 'Real TrueType outlines. A heavy face survives a shallow engraving far better than a light one.' },
    { key: 'textSize', label: 'Cap height', type: 'number', def: 9, min: 3, max: 40, step: 0.5, unit: 'mm',
      group: 'Engraving',
      help: 'Height of a capital, measured with a caliper. Shrunk automatically if it will not fit.' },
    { key: 'textPosition', label: 'Position', type: 'enum', def: 'centre', group: 'Engraving',
      options: [{ v: 'centre', label: 'Centre' }, { v: 'upper', label: 'Upper' }, { v: 'lower', label: 'Lower' }],
      help: 'Off-centre text leaves the middle clear for the glass to stand on.' },
    { key: 'engraveDepth', label: 'Engraving depth', type: 'number', def: 0.8, min: 0.2, max: 4, step: 0.1, unit: 'mm',
      group: 'Engraving',
      help: 'Independent of the groove depth: the pattern is cut away around the letters so the two never meet.' },

    { key: 'rimWidth', label: 'Rim width', type: 'number', def: 10, min: 3, max: 40, step: 0.5, unit: 'mm',
      group: 'Trivet', showIf: (p) => p.variant === 'trivet',
      help: 'The solid frame the lattice hangs in, and what the feet sit under. It carries the whole load.' },
    { key: 'latticePattern', label: 'Lattice', type: 'enum', def: 'hex', group: 'Trivet',
      options: LATTICES, showIf: (p) => p.variant === 'trivet',
      help: 'Holes are only ever placed where they fit whole, so the rim can never be nicked.' },
    { key: 'latticeCell', label: 'Lattice cell', type: 'number', def: 18, min: 6, max: 50, step: 0.5, unit: 'mm',
      group: 'Trivet', showIf: (p) => p.variant === 'trivet',
      help: 'Centre to centre. Bigger cells mean more free air and a lighter, faster print.' },
    { key: 'barWidth', label: 'Bar width', type: 'number', def: 3, min: 0.6, max: 12, step: 0.2, unit: 'mm',
      group: 'Trivet', showIf: (p) => p.variant === 'trivet',
      help: 'Material between two holes. Below 0.8 mm the slicer cannot fit two walls in and the bar prints hollow.' },
    { key: 'footCount', label: 'Feet', type: 'int', def: 4, min: 0, max: 8, step: 1,
      group: 'Trivet', showIf: (p) => p.variant === 'trivet',
      help: 'Spaced by arc length around the rim, so they land right whatever the outline. 0 for a flat trivet.' },
    { key: 'footHeight', label: 'Foot height', type: 'number', def: 5, min: 1, max: 15, step: 0.5, unit: 'mm',
      group: 'Trivet', showIf: (p) => p.variant === 'trivet' && p.footCount > 0,
      help: 'The air gap under the trivet. That gap is most of what keeps the heat off the table.' },
    { key: 'footDiameter', label: 'Foot diameter', type: 'number', def: 9, min: 3, max: 25, step: 0.5, unit: 'mm',
      group: 'Trivet', showIf: (p) => p.variant === 'trivet' && p.footCount > 0,
      help: 'Reduced automatically to stay inside the rim and clear of its neighbours.' },
    { key: 'printOrientation', label: 'Delivered', type: 'enum', def: 'as-printed', group: 'Trivet',
      options: [
        { v: 'as-printed', label: 'Feet up (no support)', help: 'Upside down, which is the only way the feet print unsupported.' },
        { v: 'as-used', label: 'Feet down (needs support)', help: 'The right way up for the render. The slicer will need supports.' },
      ],
      showIf: (p) => p.variant === 'trivet' && p.footCount > 0,
      help: 'A slab standing on feet is a full-area overhang. Printing it inverted removes the problem instead of supporting it.' },
  ],

  presets: [
    { name: 'Pint coaster', values: {
      variant: 'coaster', outline: 'circle', size: 95, baseThickness: 3, lipHeight: 2.4, lipWidth: 4,
      baseChamfer: 0.6, topChamfer: 0.4, surface: 'rings', grooveWidth: 1.6, grooveDepth: 0.8,
      ringPitch: 5, borderWidth: 3, text: '' } },
    { name: 'Hex drinks mat', values: {
      variant: 'coaster', outline: 'hexagon', size: 100, outlineRotation: 30, baseThickness: 3,
      lipHeight: 2, lipWidth: 5, surface: 'hex', cellSize: 11, grooveWidth: 1.8, grooveDepth: 1,
      borderWidth: 3.5, text: '' } },
    { name: 'Deep spill catcher', values: {
      variant: 'coaster', outline: 'circle', size: 110, baseThickness: 3, lipHeight: 7, lipWidth: 5,
      baseChamfer: 0.8, topChamfer: 0.6, surface: 'none', borderWidth: 3, text: '' } },
    { name: 'Engraved gift coaster', values: {
      variant: 'coaster', outline: 'square', cornerRadius: 14, size: 96, baseThickness: 3.4,
      lipHeight: 2.2, lipWidth: 5, surface: 'rings', ringPitch: 4.5, grooveWidth: 1.4, grooveDepth: 0.8,
      borderWidth: 3, text: 'CHEERS', font: 'Quicksand-Bold', textSize: 11, engraveDepth: 1,
      textPosition: 'centre' } },
    { name: 'Plant pot saucer', values: {
      variant: 'coaster', outline: 'circle', size: 140, baseThickness: 2.6, lipHeight: 11, lipWidth: 4,
      baseChamfer: 0.8, topChamfer: 0.6, surface: 'rings', ringPitch: 8, grooveWidth: 2, grooveDepth: 0.8,
      borderWidth: 4, text: '' } },
    { name: 'Hot pan trivet', values: {
      variant: 'trivet', outline: 'hexagon', size: 175, outlineRotation: 30, baseThickness: 4.5,
      rimWidth: 11, latticePattern: 'hex', latticeCell: 20, barWidth: 3.4, footCount: 6, footHeight: 6,
      footDiameter: 9, baseChamfer: 0.8, printOrientation: 'as-printed', text: '' } },
    { name: 'Teapot stand', values: {
      variant: 'trivet', outline: 'circle', size: 130, baseThickness: 4, rimWidth: 9,
      latticePattern: 'radial', latticeCell: 16, barWidth: 3, footCount: 3, footHeight: 4,
      footDiameter: 8, baseChamfer: 0.6, printOrientation: 'as-printed', text: '' } },
    { name: 'Named trivet', values: {
      variant: 'trivet', outline: 'square', cornerRadius: 18, size: 165, baseThickness: 4.5,
      rimWidth: 10, latticePattern: 'round', latticeCell: 17, barWidth: 3.2, footCount: 4, footHeight: 5,
      footDiameter: 9, text: 'KITCHEN', font: 'Quicksand-Bold', textSize: 12, engraveDepth: 1.2 } },
  ],

  build(p, ctx = {}) {
    const out = p.variant === 'trivet' ? buildTrivet(p, ctx) : buildCoaster(p, ctx);
    // The engraving and the surface pattern are sunk as pockets at different
    // depths, and where the text clear-zone cuts a groove, the pocket wall gains
    // a point the surrounding cap does not have. That leaves a T-junction: both
    // sides correct, the seam open. This closes it without moving anything.
    if (out && out.mesh) out.mesh = out.mesh.healTJunctions(1e-5, { clean: true });
    return out;
  },

  validate(p) {
    const out = [];
    const nozzle = 0.4, layerH = 0.2;
    const trivet = p.variant === 'trivet';
    const T = num(p.baseThickness, 3);
    const bed = 180;

    if (num(p.size, 95) > bed - 2) {
      out.push({ param: 'size', severity: 'error',
        message: `${p.size} mm will not fit the A1 mini's ${bed} × ${bed} mm bed with a skirt around it.` });
    }
    if (T < 1.6 && num(p.size, 95) > 90) {
      out.push({ param: 'baseThickness', severity: 'warn',
        message: `A ${T} mm floor over ${p.size} mm curls off the plate at the corners. 2.5–3 mm is the usual answer.` });
    }

    const maxDepth = T - MIN_POCKET_FLOOR;
    if (!trivet && p.surface !== 'none' && num(p.grooveDepth, 0.8) > maxDepth) {
      out.push({ param: 'grooveDepth', severity: 'error',
        message: `A ${p.grooveDepth} mm groove in a ${T} mm floor leaves under ${MIN_POCKET_FLOOR} mm of material — it will show through, and the slicer may open it. Deepen the base to ${(num(p.grooveDepth, 0.8) + MIN_POCKET_FLOOR).toFixed(1)} mm or cut ${maxDepth.toFixed(1)} mm.` });
    }
    if (String(p.text ?? '').trim() && num(p.engraveDepth, 0.8) > maxDepth) {
      out.push({ param: 'engraveDepth', severity: 'error',
        message: `A ${p.engraveDepth} mm engraving in a ${T} mm floor leaves under ${MIN_POCKET_FLOOR} mm under the letters.` });
    }
    if (!trivet && p.surface !== 'none' && num(p.grooveWidth, 1.6) < nozzle * 2) {
      out.push({ param: 'grooveWidth', severity: 'warn',
        message: `A ${p.grooveWidth} mm groove is narrower than two ${nozzle} mm extrusions; the top solid layers will bridge straight over most of it. 0.8 mm is the floor, 1.2 mm reads properly.` });
    }
    if (!trivet && num(p.lipHeight, 2.5) > 0 && num(p.lipHeight, 2.5) < layerH * 3) {
      out.push({ param: 'lipHeight', severity: 'warn',
        message: `A ${p.lipHeight} mm lip is under three layers tall and will look like a printing artefact rather than a rim.` });
    }
    if (!trivet && num(p.lipWidth, 4) < nozzle * 3) {
      out.push({ param: 'lipWidth', severity: 'warn',
        message: `A ${p.lipWidth} mm lip is under three extrusions wide — it will print, but it is fragile and there is no infill inside it.` });
    }

    if (trivet) {
      const bar = num(p.barWidth, 3);
      if (bar < nozzle * 2) {
        out.push({ param: 'barWidth', severity: 'error',
          message: `A ${bar} mm bar is thinner than two ${nozzle} mm walls. The slicer will either drop it or print a single unbonded thread. 1.6 mm is the practical minimum for something that holds a hot pan.` });
      } else if (bar < 1.6) {
        out.push({ param: 'barWidth', severity: 'warn',
          message: `${bar} mm bars are two extrusions wide with no infill between them. Fine for a teapot, not for a cast-iron pan.` });
      }
      if (num(p.latticeCell, 18) <= bar + 1) {
        out.push({ param: 'latticeCell', severity: 'error',
          message: `A ${p.latticeCell} mm cell with ${bar} mm bars leaves no hole at all — you will get a solid plate.` });
      }
      if (num(p.rimWidth, 10) < bar * 2) {
        out.push({ param: 'rimWidth', severity: 'warn',
          message: 'The rim is thinner than two bars. It is the only thing holding the lattice together, so make it the heaviest part.' });
      }
      if (num(p.footCount, 4) > 0) {
        if (num(p.footDiameter, 9) / 2 > num(p.rimWidth, 10) / 2 - 0.8) {
          out.push({ param: 'footDiameter', severity: 'warn',
            message: `A ${p.footDiameter} mm foot does not fit inside a ${p.rimWidth} mm rim; it will be reduced to ${(num(p.rimWidth, 10) - 1.6).toFixed(1)} mm.` });
        }
        if (p.printOrientation === 'as-used') {
          out.push({ param: 'printOrientation', severity: 'warn',
            message: 'Feet down means the whole underside is an unsupported overhang. Slice this with supports, or switch to "feet up" and turn the finished print over.' });
        }
        if (num(p.footCount, 4) === 1 || num(p.footCount, 4) === 2) {
          out.push({ param: 'footCount', severity: 'warn',
            message: `${p.footCount} feet cannot make a stable stand. Three is the minimum that cannot rock.` });
        }
      }
      if (num(p.size, 95) < 110) {
        out.push({ param: 'size', severity: 'info',
          message: `${p.size} mm across is a teapot stand rather than a pan trivet — a 24 cm frying pan wants 170 mm plus.` });
      }
      if (String(p.text ?? '').trim() && num(p.footCount, 4) > 0 && p.printOrientation !== 'as-used') {
        out.push({ severity: 'info',
          message: 'The engraving is on the in-use top face, which prints against the plate. It will come out mirror-smooth — and mirror-crisp — but do not iron it.' });
      }
    }

    if (String(p.text ?? '').trim()) {
      const font = fontFor(p.font);
      if (!font) {
        out.push({ param: 'font', severity: 'error',
          message: `No typeface could be loaded (${fontProblems().join('; ') || 'none registered'}).` });
      } else {
        let built = null;
        try { built = gen.build({ ...p }, { segFactor: 1 }); } catch (e) { built = null; }
        const meta = built && built.meta;
        if (meta && meta.textMissing && meta.textMissing.length) {
          out.push({ param: 'text', severity: 'error',
            message: `This typeface has no glyph for ${meta.textMissing.map(c => JSON.stringify(c)).join(', ')} — those characters were dropped.` });
        }
        if (meta && meta.engraveDepth === 0 && num(p.engraveDepth, 0.8) >= 0.2) {
          out.push({ param: 'text', severity: 'error', message: 'There is nowhere on this object to put the text.' });
        } else if (meta && meta.textShrunkTo < 0.995) {
          out.push({ param: 'textSize', severity: 'info',
            message: `Shrunk to ${(meta.textShrunkTo * 100).toFixed(0)}% to fit: the capitals come out ${meta.textCapMm} mm, not ${p.textSize} mm.` });
        }
        if (meta && meta.textCapMm > 0 && meta.textCapMm < 4 && num(p.engraveDepth, 0.8) > 0.6) {
          out.push({ param: 'engraveDepth', severity: 'warn',
            message: `At ${meta.textCapMm} mm caps the strokes are around ${(meta.textCapMm * 0.16).toFixed(2)} mm wide — cutting ${p.engraveDepth} mm into them makes a slot the nozzle cannot follow. Shallower, or bigger letters.` });
        }
      }
    }

    if (!trivet) {
      let built = null;
      try { built = gen.build({ ...p }, { segFactor: 1 }); } catch (e) { built = null; }
      if (built && built.meta) {
        if (built.meta.hasLip && built.meta.catchmentMl < 3) {
          out.push({ param: 'lipHeight', severity: 'info',
            message: `This holds ${built.meta.catchmentMl} mL — about a teaspoon. Raise the lip if you want it to catch a knocked-over glass.` });
        }
        for (const n of built.meta.notes) out.push({ severity: 'warn', message: n });
      }
    }
    return out;
  },

  hints(p) {
    const trivet = p.variant === 'trivet';
    const notes = [];
    let layerH = 0.2;

    const relief = trivet ? num(p.engraveDepth, 0.8) : Math.min(
      num(p.lipHeight, 2.5) || Infinity,
      p.surface !== 'none' ? num(p.grooveDepth, 0.8) : Infinity,
      String(p.text ?? '').trim() ? num(p.engraveDepth, 0.8) : Infinity);
    if (isFinite(relief) && relief > 0 && relief < 0.7) {
      layerH = 0.12;
      notes.push(`The shallowest feature is ${relief} mm. At 0.2 mm layers that is ${(relief / 0.2).toFixed(1)} layers — drop to 0.12 mm and it becomes ${Math.round(relief / 0.12)}.`);
    }

    for (const [what, v] of [['lip', trivet ? 0 : num(p.lipHeight, 2.5)],
      ['groove', !trivet && p.surface !== 'none' ? num(p.grooveDepth, 0.8) : 0],
      ['engraving', String(p.text ?? '').trim() ? num(p.engraveDepth, 0.8) : 0]]) {
      const f = layerFit(v, layerH);
      if (f) notes.push(`The ${what} is ${v} mm — ${f.layers.toFixed(2)} layers at ${layerH} mm, so the slicer will land it at ${f.down.toFixed(2)} or ${f.up.toFixed(2)} mm. Pick one of those and the top surface is flat.`);
    }

    if (trivet) {
      notes.push('PLA is the wrong material here. Its glass transition is around 60 °C and a pan off the hob is well past 150 °C — it will print beautifully and then sag the first time you use it. PETG is the minimum; ASA, PC or a glass-filled nylon if it will take cast iron.');
      notes.push(`Bars are ${p.barWidth} mm. Set the wall count so the bars are entirely perimeter — at 0.4 mm nozzle that is ${Math.max(2, Math.floor(num(p.barWidth, 3) / 0.4))} walls — and the infill percentage then does not matter.`);
      if (num(p.footCount, 4) > 0 && p.printOrientation !== 'as-used') {
        notes.push('Delivered upside down on purpose: the feet print upwards off the top face, which needs no support at all. Turn it over when it comes off the plate.');
      } else if (num(p.footCount, 4) > 0) {
        notes.push('Feet down: the whole underside is an unsupported span. You need supports, and the underside will be scarred. Switching to "feet up" avoids both.');
      }
      notes.push('The lattice has a lot of separate perimeters per layer. Turn travel avoidance off and combing on, or the print time doubles in retractions.');
      if (num(p.size, 95) > 150) notes.push('A part this wide in PETG wants a brim and a bed at 80 °C; the corners lift otherwise.');
    } else {
      notes.push('PLA is fine for a coaster under a cold glass. A mug of tea straight from the kettle sits at 90 °C, which is past PLA’s glass transition — print those in PETG.');
      notes.push('Flat on the plate, floor upward. Nothing here overhangs past the 45° chamfers, so no supports and no brim.');
      notes.push('Five top layers, four bottom, 15% gyroid. A coaster is nearly all surface; the infill is only there to carry the top solid layers.');
      if (p.surface === 'none' && !String(p.text ?? '').trim()) {
        notes.push('A plain floor is the one case where ironing is worth it — it turns the well into a mirror.');
      } else {
        notes.push('Do not iron. The nozzle drags molten plastic across the grooves and fills them in, and it rounds the edges of the letters.');
      }
      notes.push('Print several at once. They pack four to a 180 mm plate and the layer time goes up, which is exactly what a thin flat part wants.');
    }
    notes.push('Leave elephant-foot compensation at 0 — the underside chamfer is doing that job, and doing both shrinks the first layer twice.');

    return {
      profile: layerH === 0.2 ? '0.20 mm standard' : '0.12 mm fine',
      layerH,
      walls: trivet ? Math.max(2, Math.floor(num(p.barWidth, 3) / 0.4)) : 3,
      infill: trivet ? 25 : 15,
      infillPattern: 'gyroid',
      supports: !!(trivet && num(p.footCount, 4) > 0 && p.printOrientation === 'as-used'),
      brim: !!(trivet && num(p.size, 95) > 150),
      filament: trivet ? 'PETG (ASA or PC for cast iron)' : 'PLA (PETG for hot drinks)',
      notes,
    };
  },
};

export default gen;
