// js/gen/nameplate.js — text plates, signs, tags and keychains.
//
// Real letterforms as solid geometry: js/kernel/text.js hands back TrueType
// outlines as poly2d shapes, and everything here is 2D boolean work followed by
// one hand-built extrusion. There is no CSG in this generator at all — the plate
// and the letters are built as ONE closed surface, with the letters appearing as
// holes in the plate's top face and their walls picking up exactly where those
// holes stop. Merging a plate solid and a letter solid that merely overlap would
// pass a watertightness test and still be two interpenetrating shells; a slicer
// would cope, and the mesh would be a lie.
//
// The four modes are the same construction with the letters pointed differently:
//   raised     letters extruded UP from the plate's top face
//   engraved   letters extruded DOWN from it, wound inside out (a pocket)
//   stencil    letters running through the whole slab, with bridges so the
//              counters of A O e 8 do not fall out
//   inlay      pockets plus a separate set of letters that press into them
//   standalone no plate: the letters themselves, joined by a rail so the word
//              prints as one piece
//
// Millimetres, Z up, CCW seen from outside.

import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { loadFont, layoutText, contoursToShapes } from '../kernel/text.js';
import { FIT } from '../kernel/fit.js';

// ---------------------------------------------------------------------------
// Bundled fonts
//
// build() has to be synchronous and pure, so the fonts are parsed once at module
// load. The ids match what server/fonts.py reports for /api/fonts (the file stem)
// so a font picker in the UI and this enum agree without a translation table.
// ---------------------------------------------------------------------------

export const BUNDLED_FONTS = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf',
    label: 'Sans Narrow', help: 'Condensed grotesque. Fits the most characters on a plate.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf',
    label: 'Sans Mono', help: 'Fixed pitch, even stroke weight — the safest face for small text.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf',
    label: 'Rounded Bold', help: 'Heavy geometric rounded. Thickest strokes, so the best stencil face.' },
];

export const DEFAULT_FONT = 'LiberationSansNarrow-Regular';

const FONTS = new Map();
const FONT_ERRORS = new Map();

/** Hand this module a .ttf so `font: '<id>'` can use it. Accepts anything loadFont does. */
export function registerFont(id, data) {
  const font = data && typeof data.glyphIndex === 'function' ? data : loadFont(data);
  FONTS.set(id, font);
  FONT_ERRORS.delete(id);
  return font;
}

/** The parsed font for an id, falling back to whatever did load. Null if nothing did. */
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
      // A font that will not load is a missing option, not a broken catalogue:
      // the generator still builds plates and says which face went missing.
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}

await loadBundledFonts();

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

const MIN_RING_AREA = 1e-5;      // mm² — below this a ring is a boolean artefact

function nseg(n, sf, min = 3) { return Math.max(min, Math.round(n * (sf || 1))); }

function ringsOf(shapes) { const out = []; for (const s of shapes) for (const r of s) out.push(r); return out; }

function shapesBBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const p of s[0]) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!isFinite(x0)) return null;
  return { min: [x0, y0], max: [x1, y1], size: [x1 - x0, y1 - y0], center: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

function shiftShapes(shapes, dx, dy) {
  if (!dx && !dy) return shapes;
  return shapes.map(s => s.map(r => r.map(pt => [pt[0] + dx, pt[1] + dy])));
}

function dropSpecks(shapes, minArea = MIN_RING_AREA) {
  const out = [];
  for (const s of shapes) {
    // A ring of fewer than three points has no area but does have edges, and an
    // edge with no triangle behind it is a boundary edge in the finished mesh.
    if (!s.length || s[0].length < 3 || P.area(s[0]) < minArea) continue;
    out.push([s[0], ...s.slice(1).filter(r => r.length >= 3 && P.area(r) >= minArea)]);
  }
  return out;
}

function ringBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Union a pile of shapes into disjoint, correctly nested ones.
 *
 * WORKAROUND: poly2d.boolean(X, X, op) is only trustworthy while X holds a
 * single shape. Hand it a set of several and it collapses: the thirteen glyph
 * outlines of "SPARE / BACK DOOR" — 91.636 mm² of ink — came back as nine
 * shapes totalling 24.032 mm², three of them with negative area, and that alone
 * put 172 boundary edges and 121 inconsistently wound edges into that preset.
 * Two DISTINCT operands are always correct, so the pile is folded in one shape
 * at a time. Only shapes whose bounding boxes actually touch are folded
 * together: letters that cannot overlap never reach the sweep line, which is
 * both faster and one less degenerate case to survive. Repro:
 * /tmp/bluesheet-kernel-bug-nameplate.mjs.
 *
 * The single-shape self-union is kept for the case it was written for — a font
 * is free to ship a glyph whose own contours cross, and earcut on a
 * self-crossing ring produces a cap full of holes rather than an error anybody
 * would notice. That call is sound: it was checked against all 244 outline
 * shapes of the three bundled faces and reproduced every area exactly.
 */
const CONTACT_EPS = 2e-5;        // mm — closer than this and the mesh weld fuses them anyway
const CONTACT_BRIDGE = 4e-3;     // mm — half-width of the square that fuses them for real

/**
 * Squares eight microns across, dropped wherever two different shapes meet at
 * exactly one point.
 *
 * Set a line of monospace W's and the outlines touch: DejaVu Sans Mono's W fills
 * its advance width to the last unit, so the right tip of one glyph is bit-for-
 * bit the left tip of the next. A union leaves those as two shapes — correct,
 * they share a single point and no area — and extruding two shapes that share a
 * point gives two wall strips that share a vertical EDGE. Four triangles on one
 * edge: non-manifold, and 24 W's produced exactly 23 of them.
 *
 * A square at the contact point turns the pinch into a real, if microscopic,
 * neck. Eight microns is a fiftieth of a nozzle width and a fortieth of a layer:
 * it cannot be printed, sliced or measured, and it is the difference between a
 * mesh that is a solid and a mesh that only looks like one.
 */
function contactBridges(shapes) {
  if (shapes.length < 2) return [];
  const cells = new Map();
  const claimed = new Set();
  const found = [];
  for (let i = 0; i < shapes.length; i++) {
    for (const ring of shapes[i]) {
      for (const pt of ring) {
        const cx = Math.floor(pt[0] / CONTACT_EPS), cy = Math.floor(pt[1] / CONTACT_EPS);
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            const bucket = cells.get(`${cx + dx},${cy + dy}`);
            if (!bucket) continue;
            for (const e of bucket) {
              if (e.i === i) continue;
              if (Math.abs(e.x - pt[0]) <= CONTACT_EPS && Math.abs(e.y - pt[1]) <= CONTACT_EPS) { hit = true; break; }
            }
          }
        }
        if (hit) {
          const k = `${Math.round(pt[0] / CONTACT_EPS)},${Math.round(pt[1] / CONTACT_EPS)}`;
          if (!claimed.has(k)) { claimed.add(k); found.push(pt); }
        }
        const key = `${cx},${cy}`;
        let b = cells.get(key);
        if (!b) { b = []; cells.set(key, b); }
        b.push({ i, x: pt[0], y: pt[1] });
      }
    }
  }
  return found.map(pt => [P.ensureCCW(P.rect(CONTACT_BRIDGE * 2, CONTACT_BRIDGE * 2, { cx: pt[0], cy: pt[1] }))]);
}

function unionShapes(shapes) {
  const kept = dropSpecks(shapes);
  if (!kept.length) return [];
  if (kept.length === 1) return dropSpecks(P.boolean(kept, kept, 'union'));

  const boxes = kept.map(s => ringBox(s[0]));
  const parent = kept.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      // Tolerance, not a strict test: two letters set solid come out a hundredth
      // of a micron apart rather than exactly touching, and a strict comparison
      // put half of a line of monospace W's in one cluster and half in another,
      // so the contact between them was never looked for.
      const a = boxes[i], b = boxes[j];
      if (a[2] < b[0] - CONTACT_EPS || b[2] < a[0] - CONTACT_EPS ||
          a[3] < b[1] - CONTACT_EPS || b[3] < a[1] - CONTACT_EPS) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const groups = new Map();
  for (let i = 0; i < kept.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(kept[i]);
  }
  const out = [];
  for (const g of groups.values()) {
    let acc = P.boolean([g[0]], [g[0]], 'union');
    for (let i = 1; i < g.length; i++) acc = P.boolean(acc, [g[i]], 'union');
    acc = dropSpecks(acc);
    for (const bridge of contactBridges(acc)) acc = dropSpecks(P.boolean(acc, [bridge], 'union'));
    for (const s of acc) out.push(s);
  }
  return out;
}

/** Normalise a pile of ink into disjoint, correctly nested, non-crossing shapes. */
function normaliseInk(shapes) { return unionShapes(shapes); }

function rotRing(ring, ca, sa) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = [ring[i][0] * ca - ring[i][1] * sa, ring[i][0] * sa + ring[i][1] * ca];
  return out;
}
function rotShapes(shapes, ca, sa) {
  if (sa === 0 && ca === 1) return shapes;
  return shapes.map(s => s.map(r => rotRing(r, ca, sa)));
}

/** Largest shape of a set, by outer-ring area. */
function largest(shapes) {
  let best = null, a = -Infinity;
  for (const s of shapes) { const v = P.area(s[0]); if (v > a) { a = v; best = s; } }
  return best;
}

/**
 * Inset a ring by `d`, keeping the vertex count.
 *
 * poly2d.offset is the right tool for a general offset, but it is free to add
 * and drop points, and a chamfer needs the two rings joined strip-for-strip. So
 * the chamfer walks the vertices itself along the angle bisector, and refuses
 * (the caller then drops the chamfer) if the result folds over — which is what a
 * chamfer wider than the feature it is chamfering does.
 */
function insetMiter(ring, d, miterLimit = 3) {
  const n = ring.length;
  if (n < 3 || !(d > 0)) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    let e1x = b[0] - a[0], e1y = b[1] - a[1];
    let e2x = c[0] - b[0], e2y = c[1] - b[1];
    const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
    if (!(l1 > 0) || !(l2 > 0)) return null;
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // Interior of a CCW ring is to the left of the edge direction.
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
  if (!(a1 > 0) || a1 >= a0) return null;
  if (ringCrossesItself(out)) return null;
  return out;
}

/** Segment-crossing test for the miter inset. n is a plate outline, never large. */
function ringCrossesItself(ring) {
  const n = ring.length;
  if (n > 400) return false;                 // a fine circle cannot fold; skip the O(n²)
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;   // adjacent through the wrap
      if (segmentsCross(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(p, p2, q, q2) {
  const d1 = cross3(q, q2, p), d2 = cross3(q, q2, p2);
  const d3 = cross3(p, p2, q), d4 = cross3(p, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function cross3(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

/** 2·area / perimeter — the width of a long uniform stroke, within ~15% on real faces. */
export function strokeEstimate(shapes) {
  let a = 0, per = 0;
  for (const s of shapes) { a += P.shapeArea(s); for (const r of s) per += P.perimeter(r); }
  return per > 1e-9 ? 2 * a / per : 0;
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

/**
 * The same question the test harness asks — closed, manifold, consistently
 * wound, positive volume — asked by the generator of its own output before it
 * hands the mesh over.
 *
 * It is here because the answer is actionable: poly2d's ear clipper can produce
 * a cap whose boundary is NOT the rings it was given (see the note on
 * `capShapes`), and that failure is sensitive to the orientation of the
 * geometry on the page. So build() assembles, audits, and if the audit fails
 * assembles again with everything turned a few degrees. Welded at 1e-5 rather
 * than 1e-6 so this agrees exactly with tests/lib/meshcheck.mjs: an audit that
 * asks a slightly easier question than the gate is worse than no audit at all.
 */
function surfaceAudit(mesh) {
  const w = mesh.weld(1e-5);
  const n = w.vertCount;
  const count = new Map(), net = new Map();
  let degenerate = 0;
  for (let t = 0; t < w.triCount; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (let e = 0; e < 3; e++) {
      const u = e === 0 ? a : e === 1 ? b : c;
      const v = e === 0 ? b : e === 1 ? c : a;
      const key = u < v ? u * n + v : v * n + u;
      count.set(key, (count.get(key) || 0) + 1);
      net.set(key, (net.get(key) || 0) + (u < v ? 1 : -1));
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const [key, c] of count) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
    else if (net.get(key) !== 0) inconsistent++;
  }
  const volume = mesh.volume();
  return { boundary, nonManifold, inconsistent, degenerate, volume,
           ok: boundary === 0 && nonManifold === 0 && inconsistent === 0 && degenerate === 0 && volume > 0,
           score: boundary + nonManifold + inconsistent + degenerate + (volume > 0 ? 0 : 1) };
}

function addRingAt(m, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

/** Wall facing the way the ring's own orientation says is "out of the material". */
function strip(m, lo, hi) {
  const n = lo.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], lo[j], hi[j], hi[i]); }
}
/** The same wall inside out — the inside of a pocket. */
function stripIn(m, lo, hi) {
  const n = lo.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], hi[i], hi[j], lo[j]); }
}

/**
 * Flat cap over a set of shapes at height z.
 *
 * The winding is decided from the SUM of the triangle areas rather than per
 * triangle: a single collinear triangle from the ear clipper has no orientation
 * of its own, and flipping it on its own sign is how a cap ends up with one
 * inconsistently wound edge in a mesh that is otherwise perfect.
 *
 * WORKAROUND: poly2d.triangulate() does not always return a triangulation whose
 * boundary is the rings it was given. Two rings with collinear edges on one line
 * — two letters sitting on the same baseline, which is every nameplate ever
 * made — make its hole bridging swap a pair of boundary edges for a pair that
 * were never in the input. The covered area stays exact, so nothing downstream
 * of the area notices, but the cap no longer meets the walls and the mesh
 * springs a leak. Two of the four boundary edges in the "Drawer label" preset
 * were exactly this. Nothing can be done about it here — but the failure is
 * sensitive to the orientation of the geometry, so build() audits the assembled
 * mesh and, if it leaks, turns the whole plan a few degrees and assembles it
 * again. Repro: /tmp/bluesheet-kernel-bug-nameplate.mjs.
 */
function capShapes(m, shapes, z, up) {
  for (const shape of shapes) {
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

/** Letters standing on a face: walls up plus a top, no bottom (the face is the bottom). */
function prismUp(m, shapes, z0, h) {
  for (const shape of shapes) {
    for (const ring of shape) strip(m, addRingAt(m, ring, z0), addRingAt(m, ring, z0 + h));
  }
  capShapes(m, shapes, z0 + h, true);
}

/** Letters cut into a face: walls down plus a floor, no top. */
function prismDown(m, shapes, zTop, d) {
  for (const shape of shapes) {
    for (const ring of shape) stripIn(m, addRingAt(m, ring, zTop - d), addRingAt(m, ring, zTop));
  }
  capShapes(m, shapes, zTop - d, true);
}

/** A free-standing prism: walls, floor and lid. Used for the inlay letters. */
function prismSolid(shapes, z0, h) {
  const m = new Mesh();
  for (const shape of shapes) {
    for (const ring of shape) strip(m, addRingAt(m, ring, z0), addRingAt(m, ring, z0 + h));
  }
  capShapes(m, shapes, z0, false);
  capShapes(m, shapes, z0 + h, true);
  return m;
}

/**
 * Re-orient a set of shapes for life one level deeper — as holes in something
 * else. Adding an enclosing parent flips every ring's parity, so the whole set
 * simply reverses.
 */
function asHoleRings(shapes) {
  const rings = [];
  for (const s of shapes) for (const r of s) rings.push(r.slice().reverse());
  return rings;
}

// ---------------------------------------------------------------------------
// Plate outlines
// ---------------------------------------------------------------------------

/**
 * Drop consecutive points that are the same point.
 *
 * A ring carrying a 2 µm edge is a ring that will betray you later: the chamfer
 * inset pushes both of its ends half a millimetre inwards along nearly the same
 * bisector, they swap places, and the outline folds over itself. That is exactly
 * what a pill plate used to do — its radius was clamped to half the short side
 * MINUS a micron, which left a two-micron straight segment at each end — and the
 * only symptom was the chamfer silently disappearing from the Drawer label.
 */
function dedupeRing(ring, eps = 1e-7) {
  const out = [];
  for (const pt of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - pt[0]) <= eps && Math.abs(last[1] - pt[1]) <= eps) continue;
    out.push(pt);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop(); else break;
  }
  return out;
}

function plateOutline(p, sf) {
  const w = Math.max(2, p.plateWidth), h = Math.max(2, p.plateHeight);
  const lim = Math.min(w, h) / 2;
  const r = Math.max(0, Math.min(p.cornerRadius, lim));
  const clean = (ring) => P.ensureCCW(dedupeRing(ring));
  switch (p.plateShape) {
    case 'rect':
      return clean(P.rect(w, h));
    case 'pill':
      return clean(P.roundRect(w, h, lim, { segs: nseg(20, sf, 6) }));
    case 'circle':
      return clean(P.ellipse(w / 2, h / 2, { segs: nseg(80, sf, 20) }));
    case 'tag':
      return clean(tagOutline(w, h, r, sf));
    case 'rounded':
    default:
      return r > 1e-4 ? clean(P.roundRect(w, h, r, { segs: nseg(14, sf, 4) }))
                      : clean(P.rect(w, h));
  }
}

/**
 * A luggage tag: a body with a tapered nose at the left end, which is where the
 * split ring goes. The taper is what stops the ring hole from being a stress
 * riser on a straight corner — a printed tag with a hole in a square end snaps
 * along the layer line through the hole, every time.
 */
function tagOutline(w, h, r, sf) {
  const noseLen = Math.min(w * 0.3, h * 1.1);
  const noseH = Math.max(h * 0.42, Math.min(h * 0.6, h - 2));
  const pts = [
    [w / 2, -h / 2],
    [-w / 2 + noseLen, -h / 2],
    [-w / 2, -noseH / 2],
    [-w / 2, noseH / 2],
    [-w / 2 + noseLen, h / 2],
    [w / 2, h / 2],
  ];
  const rr = Math.max(0.4, Math.min(r || h * 0.12, h * 0.3, noseLen * 0.45));
  return P.roundedPath(pts, rr, { segs: nseg(8, sf, 3) });
}

// ---------------------------------------------------------------------------
// Stencil bridges
// ---------------------------------------------------------------------------

/** A point strictly inside a ring: the centroid when it lands inside, else a scanline midpoint. */
function insidePoint(ring) {
  const c = P.centroid(ring);
  if (c && P.pointInRing(c, ring)) return c;
  const ys = [...new Set(ring.map(pt => pt[1]))].sort((a, b) => a - b);
  if (ys.length < 2) return null;
  const y = (ys[ys.length >> 1] + ys[(ys.length >> 1) - 1]) / 2;
  const xs = [];
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  return [(xs[0] + xs[1]) / 2, y];
}

/** Every t > 0 where the ray p + t·d crosses any ring of `shape`. */
function rayCrossings(shape, p, d) {
  const ts = [];
  for (const ring of shape) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const a = ring[j], b = ring[i];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = d[0] * ey - d[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const u = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;    // along the ray
      const v = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den; // along the edge
      if (u > 1e-9 && v >= 0 && v < 1) ts.push(u);
    }
  }
  ts.sort((x, y) => x - y);
  return ts;
}

const BRIDGE_DIRS = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

/**
 * Rectangles that, subtracted from the ink, tie every enclosed counter back to
 * the material around the letter.
 *
 * The direction is chosen by how much MATERIAL the bridge has to cross, not by
 * how far it has to travel. That one choice is what makes a 'B' come out right:
 * the upper counter escapes upwards through one stroke, the lower counter
 * downwards through one stroke, instead of both cutting a slot up the middle of
 * the letter because "up" was hard-coded.
 */
function bridgeRects(shapes, width, sf) {
  const rects = [];
  const spots = [];                                       // where each bridge crosses the stroke
  const half = Math.max(0.05, width / 2);
  for (const shape of shapes) {
    for (let hi = 1; hi < shape.length; hi++) {
      const counter = shape[hi];
      const p = insidePoint(counter);
      if (!p) continue;
      let best = null;
      for (const d of BRIDGE_DIRS) {
        const ts = rayCrossings(shape, p, d);
        if (ts.length < 2) continue;
        let solid = 0;
        for (let i = 0; i + 1 < ts.length; i += 2) solid += ts[i + 1] - ts[i];
        const escape = ts[ts.length - 1];
        if (!best || solid < best.solid - 1e-9) best = { d, solid, escape, ts };
      }
      // The bridge is the rectangle's overlap with the stroke: its width is the
      // rectangle's, measured halfway across the first run of ink the ray meets.
      if (best && best.ts) {
        const t = (best.ts[0] + best.ts[1]) / 2;
        spots.push({ mid: [p[0] + best.d[0] * t, p[1] + best.d[1] * t], d: best.d, half });
      }
      if (!best) {
        const b = P.bounds([counter]);
        best = { d: [0, 1], solid: 0, escape: Math.max(b.size[0], b.size[1]) * 4 + width };
      }
      const len = best.escape + Math.max(half, 0.3);
      const dx = best.d[0], dy = best.d[1];
      const px = -dy * half, py = dx * half;              // perpendicular, half a bridge wide
      rects.push([[
        [p[0] + px, p[1] + py],
        [p[0] - px, p[1] - py],
        [p[0] - px + dx * len, p[1] - py + dy * len],
        [p[0] + px + dx * len, p[1] + py + dy * len],
      ]]);
    }
  }
  void sf;
  return { rects: rects.map(s => [P.ensureCCW(s[0])]), spots };
}

/** Ink with its counters bridged back to the surrounding plate. */
function bridgeInk(shapes, width, sf) {
  const { rects, spots } = bridgeRects(shapes, width, sf);
  if (!rects.length) return { ink: shapes, bridges: 0, spots: [] };
  // Two bridges can overlap — the lower counter of a 'B' escaping downwards into
  // the tail of a 'g' below it — and poly2d treats the shapes of one operand as
  // already disjoint, so overlapping clip rectangles have to be merged first or
  // the difference cuts the overlap twice and puts it back.
  const clip = unionShapes(rects);
  const cut = dropSpecks(P.boolean(shapes, clip.length ? clip : rects, 'difference'));
  return { ink: cut.length ? cut : shapes, bridges: rects.length, spots };
}

// ---------------------------------------------------------------------------
// The 2D plan — everything that decides where things go, before any triangle
// ---------------------------------------------------------------------------

const CURVE_TOL = { draft: 0.06, normal: 0.02, fine: 0.008 };

/**
 * Work out the whole layout in 2D: plate outline, keyring hole, border ring,
 * text region, and the ink already scaled and positioned. Exported because the
 * tests and the UI both want to ask questions of it without building a mesh.
 */
export function layoutFor(p, ctx = {}) {
  const sf = ctx.segFactor || 1;
  const quality = ctx.quality || 'normal';
  const tol = CURVE_TOL[quality] || CURVE_TOL.normal;
  const notes = [];

  const standalone = p.plateShape === 'none' || p.mode === 'standalone';
  const T = Math.max(0.4, p.plateThickness);
  const bed = ctx.bed || { x: 180, y: 180, z: 180 };

  const font = fontFor(p.font);
  const outline = standalone ? null : plateOutline(p, sf);

  // --- chamfer, clamped to what the plate can actually give up ---------------
  let chamfer = 0;
  let inset = null;
  if (!standalone && p.edgeChamfer > 0.02) {
    chamfer = Math.min(p.edgeChamfer, (T - 0.4) / 2, Math.min(p.plateWidth, p.plateHeight) / 6);
    if (chamfer > 0.02) {
      inset = insetMiter(outline, chamfer);
      if (!inset) { notes.push('The edge chamfer folded the outline over and was dropped.'); chamfer = 0; }
    } else chamfer = 0;
  }

  // --- keyring hole ---------------------------------------------------------
  const wantHole = !standalone && p.holePosition !== 'none' && p.holeDiameter > 0;
  const holeR = Math.max(0.5, p.holeDiameter / 2);
  const holeMargin = Math.max(1.2, chamfer + 0.8, holeR * 0.7);
  let hole = null;
  if (wantHole) {
    const w = p.plateWidth, h = p.plateHeight;
    const c = p.holePosition === 'left' ? [-w / 2 + holeR + holeMargin, 0]
            : p.holePosition === 'right' ? [w / 2 - holeR - holeMargin, 0]
            : [0, h / 2 - holeR - holeMargin];
    const ring = P.ensureCCW(P.circle(holeR, { segs: nseg(28, sf, 10), cx: c[0], cy: c[1] }));
    // Only cut it if the whole ring clears the chamfered footprint — a hole that
    // breaks the edge is a tag that tears off the first time it is pulled.
    const guard = inset || outline;
    const clear = insetMiter(guard, 0.8) || guard;
    if (ring.every(pt => P.pointInRing(pt, clear))) hole = { ring, c, r: holeR };
    else notes.push('The keyring hole does not fit inside the plate edge and was left out.');
  }

  // --- the region the sign lives in ----------------------------------------
  const edgeMargin = Math.max(chamfer + 0.4, 1.0);
  let sign = standalone ? [] : P.offset([outline], -edgeMargin, { join: 'miter' });
  if (!standalone && !sign.length) notes.push('The plate is too small for any margin; the text was left off.');

  // The hole gets the end of the plate to itself: the border and the text stop
  // clear of it rather than the border running through it.
  if (hole && sign.length) {
    const big = Math.max(p.plateWidth, p.plateHeight) * 3;
    const keep = p.holePosition === 'left' ? P.rect(big, big, { cx: hole.c[0] + holeR + holeMargin + big / 2 })
               : p.holePosition === 'right' ? P.rect(big, big, { cx: hole.c[0] - holeR - holeMargin - big / 2 })
               : P.rect(big, big, { cy: hole.c[1] - holeR - holeMargin - big / 2 });
    const clipped = dropSpecks(P.boolean(sign, [[P.ensureCCW(keep)]], 'intersection'));
    sign = clipped.length ? [largest(clipped)] : [];
  }

  // --- border ---------------------------------------------------------------
  let border = [];
  let field = sign;
  if (!standalone && p.borderWidth > 0.05 && sign.length) {
    const innerShapes = dropSpecks(P.offset(sign, -p.borderWidth, { join: 'miter' }));
    if (innerShapes.length) {
      border = dropSpecks(P.boolean(sign, innerShapes, 'difference'));
      field = innerShapes;
    } else {
      notes.push('The border is wider than the plate and was left off.');
    }
  }

  // --- where the text may go -----------------------------------------------
  const textGap = Math.max(0.8, Math.min(p.plateWidth, p.plateHeight) * 0.05);
  let region = standalone ? [] : dropSpecks(P.offset(field, -textGap, { join: 'miter' }));
  if (!standalone && sign.length && !region.length) {
    notes.push('Once the edge margin, the border and the text gap are taken off there is no room ' +
      'left for any text on this plate; it was left off.');
  }
  const regionBox = region.length ? shapesBBox(region) : null;

  // Free letters have no plate to be bounded by, so the bed IS the plate. Without
  // this the object simply grows: "WWWWWWWWWWWWWWWWWWWWWWWW" at a 48 mm cap came
  // out 971 mm wide, which every check in the harness except the bed one passes.
  // The finished piece is wider than the ink by the rail's overhang and the
  // keyring lug and taller by the rail, so all of that is predicted here — the
  // same arithmetic buildStandalone does, which is why it has to agree with it.
  const railW = Math.max(0.6, p.railWidth);
  const lugR = (p.holePosition !== 'none' && p.holeDiameter > 0)
    ? p.holeDiameter / 2 + Math.max(1.2, p.holeDiameter * 0.4) : 0;
  const bedRoom = [
    Math.max(4, bed.x - 3 - (0.8 * railW + 2 * lugR)),
    Math.max(4, bed.y - 3 - Math.max(railW, railW / 2 + lugR)),
  ];

  // --- the ink --------------------------------------------------------------
  const text = String(p.text ?? '');
  let ink = [], fit = 1, capMm = Math.max(0.4, p.capHeight), lines = 0, missing = [], clipped = false;
  let overBed = false;
  if (font && text.trim().length) {
    const base = layoutText(font, text, {
      size: capMm, letterSpacing: p.letterSpacing, lineHeight: p.lineSpacing,
      align: p.align, vAlign: 'baseline', curveTolerance: tol, onMissing: 'skip',
    });
    missing = base.missing;
    lines = base.lines.length;
    const box = base.bbox;
    if (box.size[0] > 1e-6 && box.size[1] > 1e-6) {
      let k = 1;
      if (p.maxWidth > 0) k = Math.min(k, p.maxWidth / box.size[0]);
      if (p.autoShrink && regionBox) k = Math.min(k, fitScale(region, regionBox, box.size));
      if (p.autoShrink && standalone === false && !regionBox) k = 0;   // nowhere to put it
      if (standalone) {
        const bedK = Math.min(bedRoom[0] / box.size[0], bedRoom[1] / box.size[1]);
        if (bedK < k) {
          if (p.autoShrink) k = bedK;
          else overBed = true;    // built as asked, and validate() says it will not fit
        }
      }
      if (k > 0 && k < 0.999) {
        const re = layoutText(font, text, {
          size: capMm * k, letterSpacing: p.letterSpacing * k, lineHeight: p.lineSpacing,
          align: p.align, vAlign: 'baseline', curveTolerance: tol, onMissing: 'skip',
        });
        ink = re.shapes; fit = k; capMm = capMm * k;
        lines = re.lines.length;
      } else if (k > 0) {
        ink = base.shapes;
      }
    }
  }
  ink = normaliseInk(ink);

  // Centre the block on the plate. `align` lines the LINES up with each other;
  // the block itself is centred, which is the only anchor that is safe on a
  // round or tapered plate.
  // Free letters keep their baseline on y = 0 so the rail knows where the feet
  // are; build() centres the finished solid anyway.
  const inkBox = shapesBBox(ink);
  // layoutText puts the first baseline on y = 0, so the shift IS the baseline —
  // recorded for the cap-height callout, which is measured from it.
  let baselineY = 0;
  if (ink.length && inkBox) {
    if (regionBox) {
      baselineY = regionBox.center[1] - inkBox.center[1];
      ink = shiftShapes(ink, regionBox.center[0] - inkBox.center[0], baselineY);
    } else ink = shiftShapes(ink, -inkBox.center[0], 0);
  }

  // Auto-shrink off and the text overruns: cut it at the text area rather than
  // let a letter cross the plate edge and turn the mesh into confetti. The user
  // sees a truncated sign and validate() says exactly why.
  //
  // With no text area at all the answer is the same answer taken to its limit —
  // nothing is kept. Letting the letters stand where they fell was the older
  // behaviour and it is how a 175 × 12 mm tag with a 2 mm border ended up with
  // its 'A' welded through the raised rim: two prisms sharing a wall, and a
  // surface with 480 inconsistently wound edges.
  if (ink.length && !standalone) {
    if (!region.length) { ink = []; clipped = true; }
    else if (!boxInside(region, shapesBBox(ink))) {
      ink = dropSpecks(P.boolean(ink, region, 'intersection'));
      clipped = true;
    }
  }

  return {
    standalone, font, outline, inset, chamfer, thickness: T,
    hole, sign, border, field, region, regionBox,
    ink, inkBox: shapesBBox(ink), baselineY, fit, capMm, lines, missing, clipped, overBed, bed,
    stroke: strokeEstimate(ink), textGap, edgeMargin, notes, sf, tol,
  };
}

function boxInside(region, box) {
  if (!box) return true;
  const pts = [
    [box.min[0], box.min[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]], [box.min[0], box.max[1]],
    [box.center[0], box.min[1]], [box.center[0], box.max[1]], [box.min[0], box.center[1]], [box.max[0], box.center[1]],
  ];
  return pts.every(pt => region.some(s => P.pointInShape(pt, s)));
}

/** Largest uniform scale whose ink box still sits inside the text region. */
function fitScale(region, regionBox, size) {
  if (!(size[0] > 0) || !(size[1] > 0)) return 1;
  const fits = (k) => boxInside(region, {
    min: [regionBox.center[0] - size[0] * k / 2, regionBox.center[1] - size[1] * k / 2],
    max: [regionBox.center[0] + size[0] * k / 2, regionBox.center[1] + size[1] * k / 2],
    center: regionBox.center,
  });
  if (fits(1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
  return lo;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/**
 * Nest a flat pile of rings into shapes, dropping exactly what the wall builders
 * drop and nothing else. `contoursToShapes` has its own minimum-area filter, and
 * a ring that one side keeps and the other discards is a wall with no cap behind
 * it — so the filtering happens here, once, and the nester is given a threshold
 * it can never act on.
 */
function nestRings(rings) {
  const kept = rings.filter(r => r && r.length >= 3 && Math.abs(P.signedArea(r)) >= MIN_RING_AREA);
  return contoursToShapes(kept, { minArea: 0 });
}

function buildPlated(p, plan, ca = 1, sa = 0) {
  const m = new Mesh();
  const T = plan.thickness;
  const spun = !(ca === 1 && sa === 0);
  const outer = spun ? rotRing(plan.outline, ca, sa) : plan.outline;
  const inset = plan.inset ? (spun ? rotRing(plan.inset, ca, sa) : plan.inset) : null;
  const planInk = rotShapes(plan.ink, ca, sa);
  const planBorder = rotShapes(plan.border, ca, sa);
  const holeRing = plan.hole ? (spun ? rotRing(plan.hole.ring, ca, sa) : plan.hole.ring) : null;
  const c = plan.chamfer;

  const levels = c > 0 && inset
    ? [{ z: 0, ring: inset }, { z: c, ring: outer }, { z: T - c, ring: outer }, { z: T, ring: inset }]
    : [{ z: 0, ring: outer }, { z: T, ring: outer }];

  const stencil = p.mode === 'stencil';
  const inlay = p.mode === 'inlay';
  const engraved = p.mode === 'engraved';

  // Ink, in the form each mode needs it.
  let through = [];                 // rings running the full thickness
  let raised = [];                  // shapes standing on the top face
  let sunken = [];                  // shapes pocketed into the top face
  let bridges = 0;
  let bridgeSpots = [];             // in this attempt's (possibly spun) frame
  let pockets = [];

  if (planInk.length) {
    if (stencil) {
      const b = bridgeInk(planInk, p.bridgeWidth, plan.sf);
      bridges = b.bridges;
      bridgeSpots = b.spots;
      through = asHoleRings(b.ink);
    } else if (engraved) {
      sunken = planInk;
    } else if (inlay) {
      // A press fit needs the recess bigger than the letter on every side, so
      // the pocket is the letter grown by the clearance — never the letter
      // itself with the clearance taken off the insert, which would leave the
      // sign reading a hair thinner than the type designer drew it.
      pockets = p.fitClearance > 1e-6
        ? unionShapes(P.offset(planInk, p.fitClearance, { join: 'round', arcTolerance: 0.02 }))
        : [];
      if (!pockets.length) pockets = planInk;
      sunken = pockets;
    } else {
      raised = planInk;
    }
  }
  if (holeRing) through = [...through, P.ensureCW(holeRing)];
  if (planBorder.length) raised = [...planBorder, ...raised];

  const depth = Math.min(p.engraveDepth, T - 0.4);
  const relief = p.reliefHeight;

  // Walls of the outline, level to level.
  const cache = levels.map(l => addRingAt(m, l.ring, l.z));
  for (let i = 0; i + 1 < levels.length; i++) strip(m, cache[i], cache[i + 1]);
  // Walls of everything that runs right through.
  for (const ring of through) strip(m, addRingAt(m, ring, 0), addRingAt(m, ring, T));

  capShapes(m, nestRings([levels[0].ring, ...through]), 0, false);
  capShapes(m, nestRings(
    [levels[levels.length - 1].ring, ...through, ...ringsOf(raised), ...ringsOf(sunken)]), T, true);

  if (raised.length) {
    // The border rim and the letters can stand at different heights.
    const borderCount = planBorder.length;
    if (borderCount) prismUp(m, raised.slice(0, borderCount), T, p.borderHeight);
    if (raised.length > borderCount) prismUp(m, raised.slice(borderCount), T, relief);
  }
  if (sunken.length) prismDown(m, sunken, T, depth);

  const plate = m.weld(1e-6).compact();

  if (!inlay || !planInk.length) {
    return { mesh: plate, meta: { bridges, bridgeSpots, pockets: 0, depth } };
  }

  // Two-part: the letters are their own solid, a press fit into the pockets.
  const insertH = depth + Math.max(0, p.inlayProud);
  const letters = prismSolid(planInk, T - depth, insertH).weld(1e-6).compact();
  return {
    mesh: Mesh.merge([plate, letters]),
    parts: [
      { name: 'Plate', mesh: plate },
      { name: 'Letters', mesh: letters.dropToPlate() },
    ],
    meta: { bridges, bridgeSpots, pockets: pockets.length, depth },
  };
}

function buildStandalone(p, plan, ca = 1, sa = 0) {
  const T = plan.thickness;
  const railW = Math.max(0.6, p.railWidth);
  const ink = plan.ink;
  const box = shapesBBox(ink);

  const bite = Math.max(0.25, Math.min(0.8, plan.capMm * 0.12));
  const halfLen = box ? Math.max(box.size[0] / 2 + railW * 0.6, railW) : railW * 3;
  const railTopY = p.railStyle === 'under'
    ? (box ? box.min[1] + bite : bite)
    : bite;                                     // 'baseline' — the rail bites into the feet
  const railCy = railTopY - railW / 2;
  const railCx = box ? box.center[0] : 0;

  const railRing = P.ensureCCW(P.roundRect(halfLen * 2, railW, Math.min(railW / 2 - 1e-6, railW * 0.5),
    { segs: nseg(8, plan.sf, 3), cx: railCx, cy: railCy }));
  let joined = unionShapes([...ink, [railRing]]);

  // Anything the rail missed — the dot of an i, a hyphen, an accent, the bar of
  // a percent sign — gets a stem to it. Without this the "one piece" claim is
  // false for half the strings anybody actually types, and the print comes off
  // the plate as a handful of loose crumbs.
  const railProbe = [railCx, railCy];
  const stems = [];
  for (const s of joined) {
    if (P.pointInShape(railProbe, s)) continue;
    const b = shapesBBox([s]);
    if (!b) continue;
    const w = Math.min(railW, Math.max(0.6, b.size[0] * 0.6));
    // A point a little way inside the orphan, and the rail's own spine: the stem
    // spans between them whichever way round they are, so a mark that floats
    // BELOW the rail is tied on as readily as the dot of an i above it.
    const anchor = b.min[1] + Math.min(b.size[1] * 0.5, 0.6);
    const lo = Math.min(anchor, railCy), hi = Math.max(anchor, railCy);
    if (hi - lo < 1e-4) continue;
    stems.push([P.ensureCCW(P.rect(w, hi - lo, { cx: b.center[0], cy: (lo + hi) / 2 }))]);
  }
  if (stems.length) joined = unionShapes([...joined, ...stems]);

  // A keyring lug on the end, if one was asked for.
  let lug = null;
  if (p.holePosition !== 'none' && p.holeDiameter > 0) {
    const r = Math.max(0.5, p.holeDiameter / 2);
    const wall = Math.max(1.2, r * 0.8);
    const side = p.holePosition === 'right' ? 1 : -1;
    const cx = railCx + side * (halfLen + r + wall - railW * 0.4);
    lug = { cx, cy: railCy, r };
    const lug = [P.ensureCCW(P.circle(r + wall, { segs: nseg(32, plan.sf, 12), cx, cy: railCy }))];
    joined = unionShapes([...joined, lug]);
    const bore = [[P.ensureCCW(P.circle(r, { segs: nseg(28, plan.sf, 10), cx, cy: railCy }))]];
    joined = dropSpecks(P.boolean(joined, bore, 'difference'));
  }

  if (!joined.length) joined = [[P.ensureCCW(P.roundRect(20, railW, railW / 2 - 1e-6, { segs: 6 }))]];
  joined = rotShapes(joined, ca, sa);

  const m = new Mesh();
  for (const shape of joined) {
    for (const ring of shape) strip(m, addRingAt(m, ring, 0), addRingAt(m, ring, T));
  }
  capShapes(m, joined, 0, false);
  capShapes(m, joined, T, true);
  return {
    mesh: m.weld(1e-6).compact(),
    meta: {
      bridges: 0, pockets: 0, pieces: joined.length,
      rail: { cx: railCx, cy: railCy, w: railW, halfLen },   // unspun plan frame
      lug,
    },
  };
}

// ---------------------------------------------------------------------------
// Dimension callouts — the lengths the bounding box cannot show, each on the
// feature it measures. Coordinates are the plan frame, shifted to the placed
// frame by `pl`; `built` is the builder's meta for the attempt that was kept.
// ---------------------------------------------------------------------------

const round3 = (v) => Math.round(v * 1000) / 1000;

/** The ink vertex furthest forward (lowest y), then leftmost — on a letter's front wall. */
function inkVertex(shapes, pick) {
  let best = null;
  for (const s of shapes) for (const ring of s) for (const v of ring) if (!best || pick(v, best)) best = v;
  return best;
}

/** The left edge of the FIRST line of ink: the leftmost vertex within its cap band,
 *  so a two-line sign gets the callout on the top line rather than on the wider one. */
function lineLeft(shapes, base, cap) {
  const inBand = (v) => v[1] >= base - cap * 0.05 && v[1] <= base + cap * 1.05;
  const v = inkVertex(shapes, (a, b) => inBand(a) && (!inBand(b) || a[0] < b[0]));
  return v && inBand(v) ? v[0] : shapesBBox(shapes).min[0];
}

/** Where a shape's outline is first met walking up the line x = x0 from far below. */
function bottomAt(shape, x0, far) {
  const ts = rayCrossings(shape, [x0, -far], [0, 1]);
  return ts.length ? -far + ts[0] : null;
}

function nameplateDims(p, plan, built, b0) {
  const pl = (x, y, z) => [x - b0.center[0], y - b0.center[1], z - b0.min[2]];
  const T = plan.thickness;
  const dims = [];
  const ink = plan.ink;
  const far = Math.max(p.plateWidth, p.plateHeight, plan.inkBox ? plan.inkBox.size[0] : 0) * 2 + 10;

  if (plan.standalone) {
    const rail = built.rail;
    if (!rail) return dims;
    const xEnd = rail.cx + rail.halfLen;
    dims.push({ param: 'plateThickness', label: 'thick', from: pl(xEnd, rail.cy, 0), to: pl(xEnd, rail.cy, T), offset: 6 });
    if (plan.inkBox) {
      // The rail's straight run reaches railW * 0.1 past the last letter before
      // the rounded end starts, so just past the ink it is full width.
      const xr = plan.inkBox.max[0] + rail.w * 0.05;
      dims.push({ param: 'railWidth', label: 'rail', from: pl(xr, rail.cy - rail.w / 2, T), to: pl(xr, rail.cy + rail.w / 2, T), offset: 6 });
      const x = lineLeft(ink, 0, plan.capMm);
      dims.push({ param: 'capHeight', label: 'cap', from: pl(x, 0, T), to: pl(x, plan.capMm, T), offset: 6,
        ...(Math.abs(plan.capMm - p.capHeight) > 1e-6 ? { value: round3(plan.capMm) } : {}) });
    }
    if (built.lug) {
      const { cx, cy, r } = built.lug;
      dims.push({ param: 'holeDiameter', label: 'Ø', from: pl(cx - r, cy, T), to: pl(cx + r, cy, T), offset: 6,
        ...(Math.abs(2 * r - p.holeDiameter) > 1e-6 ? { value: round3(2 * r) } : {}) });
    }
    return dims;
  }

  // The plate: thickness and chamfer on its front edge, at x = 0.
  const yFront = bottomAt([plan.outline], 0, far);
  if (yFront !== null) {
    dims.push({ param: 'plateThickness', label: 'plate', from: pl(0, yFront, 0), to: pl(0, yFront, T), offset: [0, -1, 0] });
    if (plan.chamfer > 1e-6) {
      dims.push({ param: 'edgeChamfer', label: 'chamfer', from: pl(0, yFront, T - plan.chamfer), to: pl(0, yFront, T), offset: [0, -1, 0],
        ...(Math.abs(plan.chamfer - p.edgeChamfer) > 1e-6 ? { value: round3(plan.chamfer) } : {}) });
    }
  }

  // The corner radius, from its centre of curvature to the front-right arc.
  const w = Math.max(2, p.plateWidth), h = Math.max(2, p.plateHeight);
  let rc = 0;
  if (p.plateShape === 'rounded') rc = Math.max(0, Math.min(p.cornerRadius, Math.min(w, h) / 2));
  else if (p.plateShape === 'tag') {
    const r = Math.max(0, Math.min(p.cornerRadius, Math.min(w, h) / 2));
    const noseLen = Math.min(w * 0.3, h * 1.1);
    rc = Math.max(0.4, Math.min(r || h * 0.12, h * 0.3, noseLen * 0.45));
  }
  if (rc > 1e-4) {
    const cx = w / 2 - rc, cy = -h / 2 + rc, k = Math.SQRT1_2, z = T - plan.chamfer;
    dims.push({ param: 'cornerRadius', label: 'R', from: pl(cx, cy, z), to: pl(cx + rc * k, cy - rc * k, z), offset: 6,
      ...(Math.abs(rc - p.cornerRadius) > 1e-6 ? { value: round3(rc) } : {}) });
  }

  // The border rim: its width and height on the front run of the rim.
  if (plan.border.length && plan.sign.length && plan.field.length) {
    const sb = shapesBBox(plan.sign);
    const xc = sb.center[0];
    const ySign = bottomAt(plan.sign[0], xc, far);
    const inner = plan.field.reduce((a, s) => (!a || shapesBBox([s]).size[0] > shapesBBox([a]).size[0]) ? s : a, null);
    const yField = inner ? bottomAt(inner, xc, far) : null;
    if (ySign !== null && yField !== null && yField > ySign) {
      const bw = yField - ySign, zTop = T + p.borderHeight;
      dims.push({ param: 'borderWidth', label: 'border', from: pl(xc, ySign, zTop), to: pl(xc, yField, zTop), offset: 6,
        ...(Math.abs(bw - p.borderWidth) > 0.02 ? { value: round3(bw) } : {}) });
      dims.push({ param: 'borderHeight', label: 'border', from: pl(xc, ySign, T), to: pl(xc, ySign, zTop), offset: [0, -1, 0] });
    }
  }

  // The keyring hole, across its centre.
  if (plan.hole) {
    const { c, r } = plan.hole;
    dims.push({ param: 'holeDiameter', label: 'Ø', from: pl(c[0] - r, c[1], T), to: pl(c[0] + r, c[1], T), offset: 6,
      ...(Math.abs(2 * r - p.holeDiameter) > 1e-6 ? { value: round3(2 * r) } : {}) });
  }

  // The letters.
  if (ink.length && plan.inkBox) {
    const raised = p.mode === 'raised', engraved = p.mode === 'engraved', inlay = p.mode === 'inlay', stencil = p.mode === 'stencil';
    const depth = built.depth ?? Math.min(p.engraveDepth, T - 0.4);
    const zLetters = raised ? T + p.reliefHeight : inlay ? T + Math.max(0, p.inlayProud) : T;
    const base = plan.baselineY, x = lineLeft(ink, base, plan.capMm);
    dims.push({ param: 'capHeight', label: 'cap', from: pl(x, base, zLetters), to: pl(x, base + plan.capMm, zLetters), offset: 6,
      ...(Math.abs(plan.capMm - p.capHeight) > 1e-6 ? { value: round3(plan.capMm) } : {}) });

    const v = inkVertex(ink, (a, b) => a[1] < b[1] - 1e-9 || (Math.abs(a[1] - b[1]) <= 1e-9 && a[0] < b[0]));
    if (raised) {
      dims.push({ param: 'reliefHeight', label: 'relief', from: pl(v[0], v[1], T), to: pl(v[0], v[1], T + p.reliefHeight), offset: [0, -1, 0] });
    }
    if (engraved || inlay) {
      dims.push({ param: 'engraveDepth', label: 'cut', from: pl(v[0], v[1], T - depth), to: pl(v[0], v[1], T), offset: [0, -1, 0],
        ...(Math.abs(depth - p.engraveDepth) > 1e-6 ? { value: round3(depth) } : {}) });
    }
    if (inlay && p.inlayProud > 1e-6) {
      dims.push({ param: 'inlayProud', label: 'proud', from: pl(v[0], v[1], T), to: pl(v[0], v[1], T + p.inlayProud), offset: [0, -1, 0] });
    }
    if (inlay && p.fitClearance > 1e-6) {
      // The pocket is the letter grown by the clearance on every side, so at the
      // leftmost point of the ink the gap to the pocket wall is exactly that.
      const l = inkVertex(ink, (a, b) => a[0] < b[0]);
      dims.push({ param: 'fitClearance', label: 'gap', from: pl(l[0] - p.fitClearance, l[1], T), to: pl(l[0], l[1], T), offset: 6 });
    }
    if (stencil && built.bridgeSpots && built.bridgeSpots.length) {
      const s = built.bridgeSpots[0];
      const px = -s.d[1] * s.half, py = s.d[0] * s.half;
      dims.push({ param: 'bridgeWidth', label: 'bridge', from: pl(s.mid[0] - px, s.mid[1] - py, T), to: pl(s.mid[0] + px, s.mid[1] + py, T), offset: 6 });
    }
  }
  return dims;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Angles the assembly is retried at, in radians. Zero first — the overwhelming
 * majority of plates close on the first attempt and pay only the audit. The rest
 * are deliberately unrelated to each other and to any right angle, because the
 * defect they exist to dodge is exact collinearity along the sweep direction.
 */
const ASSEMBLY_ANGLES = [0, 0.013707, 0.109861, 0.327106, 0.557372, 0.841903, 1.120736, 1.423110];

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2.5"/>' +
  '<path d="M7 15V9h1.8a1.7 1.7 0 0 1 0 3.4H7"/><path d="M12.5 15V9h3.2"/><path d="M12.5 12.2h2.4"/>' +
  '<circle cx="19" cy="12" r="0.9"/></svg>';

const gen = {
  id: 'nameplate',
  name: 'Nameplate',
  category: 'Decor',
  blurb: 'Signs, labels, keyring tags and stencils built from real font outlines.',
  description:
    'Type a word and get a solid. The letters are genuine TrueType outlines — every curve, ' +
    'counter and overshoot the type designer drew — turned into geometry rather than traced ' +
    'from a picture, so a 10 mm cap height measures 10 mm with a caliper. Choose raised text, ' +
    'engraved text, a cut-through stencil with bridged counters, a two-colour inlay whose ' +
    'letters press into their own recesses, or no plate at all: free letters joined by a rail ' +
    'so the whole word prints in one piece.',
  icon: ICON,
  version: 1,

  params: [
    { key: 'text', label: 'Text', type: 'text', def: 'BLUESHEET', maxLength: 64, group: 'Text',
      help: 'Use \\n for a second line. Characters the font does not have are dropped and reported.' },
    { key: 'font', label: 'Typeface', type: 'enum', def: DEFAULT_FONT, group: 'Text',
      options: BUNDLED_FONTS.map(f => ({ v: f.id, label: f.label, help: f.help })),
      help: 'All three are TrueType outline fonts bundled with Bluesheet; licences sit beside them.' },
    { key: 'capHeight', label: 'Cap height', type: 'number', def: 10, min: 2, max: 60, step: 0.5,
      unit: 'mm', group: 'Text',
      help: 'The height of a capital letter, measured with a caliper — not the em size.' },
    { key: 'letterSpacing', label: 'Letter spacing', type: 'number', def: 0, min: -2, max: 6, step: 0.1,
      unit: 'mm', group: 'Text',
      help: 'Extra gap between letters. Negative tightens; overlapping letters merge cleanly.' },
    { key: 'lineSpacing', label: 'Line spacing', type: 'number', def: 1.3, min: 0.8, max: 2.5, step: 0.05,
      group: 'Text', help: 'Baseline to baseline, as a multiple of the em. Only matters with two lines.' },
    { key: 'align', label: 'Line alignment', type: 'enum', def: 'center', group: 'Text',
      options: [{ v: 'left', label: 'Left' }, { v: 'center', label: 'Centre' }, { v: 'right', label: 'Right' }],
      help: 'How the lines line up with each other. The block itself is always centred on the plate.' },
    { key: 'autoShrink', label: 'Shrink to fit', type: 'bool', def: true, group: 'Text',
      help: 'Scale the whole word down until it sits inside the plate. Off, it is cut at the text area.' },
    { key: 'maxWidth', label: 'Max text width', type: 'number', def: 0, min: 0, max: 170, step: 1,
      unit: 'mm', group: 'Text', help: '0 lets the plate decide. Set it to match a row of other signs.' },

    { key: 'mode', label: 'Mode', type: 'enum', def: 'raised', group: 'Letters',
      options: [
        { v: 'raised', label: 'Raised', help: 'Letters stand proud of the plate.' },
        { v: 'engraved', label: 'Engraved', help: 'Letters cut into the plate as pockets.' },
        { v: 'stencil', label: 'Stencil', help: 'Letters cut right through, counters bridged.' },
        { v: 'inlay', label: 'Two-part inlay', help: 'Recesses plus separate letters for two colours.' },
        { v: 'standalone', label: 'Free letters', help: 'No plate — letters joined by a rail.' },
      ],
      help: 'What the letters are made of: material, a hole, or a separate part.' },
    { key: 'reliefHeight', label: 'Relief height', type: 'number', def: 1.6, min: 0.4, max: 8, step: 0.2,
      unit: 'mm', group: 'Letters', showIf: (p) => p.mode === 'raised',
      help: 'How far the letters stand out. Under 0.6 mm the top layer smears them.' },
    { key: 'engraveDepth', label: 'Cut depth', type: 'number', def: 0.8, min: 0.2, max: 6, step: 0.1,
      unit: 'mm', group: 'Letters', showIf: (p) => p.mode === 'engraved' || p.mode === 'inlay',
      help: 'Depth of the pocket. Four layers (0.8 mm) is the shallowest that reads at arm’s length.' },
    { key: 'fitClearance', label: 'Press-fit gap', type: 'number', def: FIT.press, min: 0, max: 0.4, step: 0.01,
      unit: 'mm', group: 'Letters', showIf: (p) => p.mode === 'inlay',
      help: 'Gap on EVERY side between letter and recess. 0.10 presses in by hand; 0.05 needs a clamp; 0 will not go.' },
    { key: 'inlayProud', label: 'Letters stand proud', type: 'number', def: 0, min: 0, max: 4, step: 0.1,
      unit: 'mm', group: 'Letters', showIf: (p) => p.mode === 'inlay',
      help: '0 is flush with the plate, which is what a two-colour sign usually wants.' },
    { key: 'bridgeWidth', label: 'Bridge width', type: 'number', def: 1.2, min: 0.4, max: 4, step: 0.1,
      unit: 'mm', group: 'Letters', showIf: (p) => p.mode === 'stencil',
      help: 'Tie holding the middle of an A, O or 8 in place. Below 0.8 mm it snaps when you peel the tape.' },

    { key: 'plateShape', label: 'Plate shape', type: 'enum', def: 'rounded', group: 'Plate',
      options: [
        { v: 'rect', label: 'Rectangle' },
        { v: 'rounded', label: 'Rounded' },
        { v: 'pill', label: 'Pill' },
        { v: 'tag', label: 'Luggage tag', help: 'Tapered nose for the split ring.' },
        { v: 'circle', label: 'Circle / oval' },
        { v: 'none', label: 'No plate', help: 'Free letters on a rail.' },
      ],
      help: '"No plate" gives you the letters alone, joined by a rail so they print as one piece.' },
    { key: 'plateWidth', label: 'Plate width', type: 'number', def: 70, min: 10, max: 175, step: 1,
      unit: 'mm', group: 'Plate', help: 'Across the text. For a circle this is the diameter.' },
    { key: 'plateHeight', label: 'Plate height', type: 'number', def: 24, min: 8, max: 175, step: 1,
      unit: 'mm', group: 'Plate', help: 'Roughly 2.4 × the cap height leaves a comfortable margin.' },
    { key: 'plateThickness', label: 'Thickness', type: 'number', def: 3, min: 1, max: 20, step: 0.2,
      unit: 'mm', group: 'Plate',
      help: 'Also the thickness of free letters. Under 2 mm a sign with a keyring hole flexes and cracks.' },
    { key: 'cornerRadius', label: 'Corner radius', type: 'number', def: 4, min: 0, max: 40, step: 0.5,
      unit: 'mm', group: 'Plate', showIf: (p) => p.plateShape === 'rounded' || p.plateShape === 'tag',
      help: 'Clamped to half the shorter side, so it can never turn the outline inside out.' },
    { key: 'edgeChamfer', label: 'Edge chamfer', type: 'number', def: 0.6, min: 0, max: 4, step: 0.1,
      unit: 'mm', group: 'Plate',
      help: 'Bevel top and bottom. The bottom one hides elephant foot; the top one catches the light.' },
    { key: 'borderWidth', label: 'Border width', type: 'number', def: 0, min: 0, max: 8, step: 0.2,
      unit: 'mm', group: 'Plate', help: 'A raised rim around the text. 0 for none.' },
    { key: 'borderHeight', label: 'Border height', type: 'number', def: 1.2, min: 0.2, max: 6, step: 0.1,
      unit: 'mm', group: 'Plate', showIf: (p) => p.borderWidth > 0,
      help: 'Matching it to the relief height makes the rim and the letters read as one surface.' },

    { key: 'holePosition', label: 'Keyring hole', type: 'enum', def: 'none', group: 'Keyring',
      options: [
        { v: 'none', label: 'None' }, { v: 'left', label: 'Left end' },
        { v: 'right', label: 'Right end' }, { v: 'top', label: 'Top edge' },
      ],
      help: 'The border and the text stop clear of the hole, so the rim is never cut through.' },
    { key: 'holeDiameter', label: 'Hole diameter', type: 'number', def: 4, min: 1.5, max: 12, step: 0.5,
      unit: 'mm', group: 'Keyring', showIf: (p) => p.holePosition !== 'none',
      help: '4 mm clears a normal split ring. Printed holes come out ~0.2 mm small; this is the drawn size.' },

    { key: 'railWidth', label: 'Rail width', type: 'number', def: 3, min: 1, max: 12, step: 0.5,
      unit: 'mm', group: 'Free letters', showIf: (p) => p.mode === 'standalone' || p.plateShape === 'none',
      help: 'The bar that ties the letters together. Anything the bar misses gets a stem down to it.' },
    { key: 'railStyle', label: 'Rail position', type: 'enum', def: 'baseline', group: 'Free letters',
      showIf: (p) => p.mode === 'standalone' || p.plateShape === 'none',
      options: [
        { v: 'baseline', label: 'Through the baseline', help: 'Hidden inside the feet of the letters.' },
        { v: 'under', label: 'Below the descenders', help: 'A visible plinth. Safer for script faces.' },
      ],
      help: 'Baseline is nearly invisible; below-the-descenders is stronger.' },
  ],

  presets: [
    { name: 'Front door number', values: {
      text: '42', font: 'Quicksand-Bold', capHeight: 46, mode: 'raised', reliefHeight: 2.4,
      plateShape: 'rounded', plateWidth: 90, plateHeight: 70, plateThickness: 4, cornerRadius: 8,
      edgeChamfer: 1, borderWidth: 3, borderHeight: 2.4, holePosition: 'none' } },
    { name: 'Keyring tag', values: {
      text: 'SPARE\nBACK DOOR', font: 'LiberationSansNarrow-Regular', capHeight: 5.5, lineSpacing: 1.2,
      mode: 'raised', reliefHeight: 0.8, plateShape: 'tag', plateWidth: 46, plateHeight: 22,
      plateThickness: 2.6, cornerRadius: 3, edgeChamfer: 0.5, holePosition: 'left', holeDiameter: 4 } },
    { name: 'Drawer label', values: {
      text: 'M3 × 12', font: 'DejaVuSansMono', capHeight: 7, mode: 'engraved', engraveDepth: 0.8,
      plateShape: 'pill', plateWidth: 52, plateHeight: 16, plateThickness: 2.4, edgeChamfer: 0.5,
      borderWidth: 0, holePosition: 'none' } },
    { name: 'Spray stencil', values: {
      text: 'FRAGILE', font: 'Quicksand-Bold', capHeight: 22, mode: 'stencil', bridgeWidth: 1.6,
      plateShape: 'rect', plateWidth: 130, plateHeight: 44, plateThickness: 1.4, edgeChamfer: 0,
      borderWidth: 0, holePosition: 'none' } },
    { name: 'Two-colour desk sign', values: {
      text: 'WORKSHOP', font: 'LiberationSansNarrow-Regular', capHeight: 16, mode: 'inlay',
      engraveDepth: 1.2, fitClearance: 0.1, inlayProud: 0, plateShape: 'rounded', plateWidth: 150,
      plateHeight: 40, plateThickness: 4, cornerRadius: 5, edgeChamfer: 0.8, borderWidth: 0 } },
    { name: 'Shelf letters', values: {
      text: 'BITS', font: 'Quicksand-Bold', capHeight: 34, mode: 'standalone', plateShape: 'none',
      plateThickness: 5, railWidth: 4, railStyle: 'baseline', letterSpacing: 1 } },
  ],

  build(p, ctx = {}) {
    const plan = layoutFor(p, ctx);
    const notes = [...plan.notes];

    // Assemble, audit, and if the surface leaks, assemble it again with the
    // whole plan turned. Rotation cannot change what the object IS — every
    // triangle is turned with it and turned back at the end — but it does change
    // which vertices the ear clipper sees as collinear, and that is the one
    // thing standing between a correct plan and a watertight mesh (see the
    // WORKAROUND note on capShapes). The first angle is zero, so the common case
    // pays one audit and nothing else.
    let r = null, audit = null, used = 0, tries = 0;
    for (let i = 0; i < ASSEMBLY_ANGLES.length; i++) {
      const ang = ASSEMBLY_ANGLES[i];
      const attempt = plan.standalone
        ? buildStandalone(p, plan, Math.cos(ang), Math.sin(ang))
        : buildPlated(p, plan, Math.cos(ang), Math.sin(ang));
      const a = surfaceAudit(attempt.mesh);
      tries = i + 1;
      if (a.ok) { r = attempt; audit = a; used = i; break; }
      if (!audit || a.score < audit.score) { r = attempt; audit = a; used = i; }
    }
    if (!audit.ok) {
      notes.push(`The surface did not close cleanly at any of ${ASSEMBLY_ANGLES.length} assembly ` +
        `angles (${audit.boundary} open edges, ${audit.nonManifold} non-manifold). ` +
        'Repair the STL before slicing, or change the text slightly.');
    }

    const ang = ASSEMBLY_ANGLES[used];
    const unspin = ang ? (m) => m.rotateZ(-ang) : (m) => m;
    const body = unspin(r.mesh);
    // The bridge spots were found in the spun frame; turn them back with the mesh.
    if (ang && r.meta.bridgeSpots) {
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      const rot = (v) => [ca * v[0] - sa * v[1], sa * v[0] + ca * v[1]];
      r.meta.bridgeSpots = r.meta.bridgeSpots.map(s => ({ ...s, mid: rot(s.mid), d: rot(s.d) }));
    }
    const dims = nameplateDims(p, plan, r.meta, body.bbox());
    const out = {
      mesh: body.centerXY().dropToPlate(),
      meta: {
        dims,
        mode: plan.standalone ? 'standalone' : p.mode,
        font: plan.font ? plan.font.name : null,
        capHeight: Math.round(plan.capMm * 1000) / 1000,
        shrunkTo: Math.round(plan.fit * 1000) / 1000,
        lines: plan.lines,
        inkSize: plan.inkBox ? plan.inkBox.size.map(v => Math.round(v * 100) / 100) : [0, 0],
        strokeWidth: Math.round(plan.stroke * 1000) / 1000,
        chamfer: Math.round(plan.chamfer * 1000) / 1000,
        clearance: p.mode === 'inlay' ? p.fitClearance : null,
        bridges: r.meta.bridges,
        keyringHole: plan.hole ? { x: plan.hole.c[0], y: plan.hole.c[1], d: plan.hole.r * 2 } : null,
        missing: plan.missing,
        clipped: plan.clipped,
        watertight: audit.ok,
        assemblyTries: tries,
        notes,
      },
    };
    if (r.parts) {
      // The two parts are placed as they print, not as they assemble.
      const b = body.bbox();
      out.parts = r.parts.map(part => ({
        name: part.name,
        mesh: unspin(part.mesh).translate(-b.center[0], -b.center[1], 0).dropToPlate(),
      }));
    }
    return out;
  },

  validate(p) {
    const issues = [];
    const standalone = p.plateShape === 'none' || p.mode === 'standalone';
    const nozzle = 0.4;

    if (!fontFor(p.font)) {
      issues.push({ param: 'font', severity: 'error',
        message: `No typeface could be loaded (${fontProblems().join('; ') || 'none registered'}).` });
      return issues;
    }
    if (!String(p.text ?? '').trim()) {
      issues.push({ param: 'text', severity: 'warn', message: 'No text — you will get a blank plate.' });
    }
    if ((p.mode === 'engraved' || p.mode === 'inlay') && !standalone && p.engraveDepth > p.plateThickness - 0.6) {
      issues.push({ param: 'engraveDepth', severity: 'error',
        message: `A ${p.engraveDepth} mm cut in a ${p.plateThickness} mm plate leaves under 0.6 mm of floor — it will break through. Deepen the plate or shallow the cut.` });
    }
    if (!standalone && (p.plateWidth > 180 || p.plateHeight > 180)) {
      issues.push({ param: 'plateWidth', severity: 'error',
        message: `${p.plateWidth} × ${p.plateHeight} mm will not fit the A1 mini's 180 × 180 mm bed.` });
    }

    let plan = null;
    try { plan = layoutFor(p, {}); } catch (e) {
      issues.push({ severity: 'error', message: `Layout failed: ${e.message}` });
      return issues;
    }
    for (const n of plan.notes) issues.push({ severity: 'warn', message: n });
    if (plan.missing.length) {
      issues.push({ param: 'text', severity: 'error',
        message: `This typeface has no glyph for ${plan.missing.map(c => JSON.stringify(c)).join(', ')} — those characters were dropped.` });
    }
    if (plan.clipped) {
      issues.push({ param: 'autoShrink', severity: 'error',
        message: 'The text is bigger than the plate and has been cut off at the text area. Turn "Shrink to fit" on, lower the cap height, or grow the plate.' });
    }
    if (String(p.text ?? '').trim() && !plan.ink.length) {
      issues.push({ param: 'capHeight', severity: 'error', message: 'Nothing is left of the text at this size on this plate.' });
    }
    if (plan.overBed && plan.inkBox) {
      issues.push({ param: 'capHeight', severity: 'error',
        message: `Free letters at a ${p.capHeight} mm cap height come out ${plan.inkBox.size[0].toFixed(0)} × ` +
          `${plan.inkBox.size[1].toFixed(0)} mm and will not fit the ${plan.bed.x} × ${plan.bed.y} mm bed. ` +
          'Turn "Shrink to fit" on, split the word over two lines, or lower the cap height.' });
    }
    if (plan.ink.length) {
      const s = plan.stroke;
      if (s > 0 && s < nozzle) {
        issues.push({ param: 'capHeight', severity: 'error',
          message: `The letter strokes come out about ${s.toFixed(2)} mm wide, thinner than the ${nozzle} mm nozzle — the slicer will drop them. Raise the cap height to about ${(p.capHeight * (nozzle * 1.6) / s).toFixed(0)} mm or pick the Rounded Bold face.` });
      } else if (s > 0 && s < nozzle * 1.5) {
        issues.push({ param: 'capHeight', severity: 'warn',
          message: `Letter strokes are about ${s.toFixed(2)} mm — a single extrusion wide. They will print, but faintly.` });
      }
      if (p.mode === 'engraved' && s > 0 && s < nozzle * 2) {
        issues.push({ param: 'engraveDepth', severity: 'warn',
          message: `An engraved groove ${s.toFixed(2)} mm wide is narrower than two extrusions; the top surface will bridge over most of it.` });
      }
    }
    if (p.mode === 'stencil' && p.bridgeWidth < nozzle * 2) {
      issues.push({ param: 'bridgeWidth', severity: 'warn',
        message: `A ${p.bridgeWidth} mm bridge is under two extrusions wide and will snap. 0.8 mm is the practical floor.` });
    }
    if (p.mode === 'inlay') {
      if (p.fitClearance <= 0.001) {
        issues.push({ param: 'fitClearance', severity: 'error',
          message: 'With no clearance the letters are exactly the size of their recesses and will not go in. 0.05 mm for a hard press fit, 0.10 mm to push in by hand.' });
      } else if (p.fitClearance > 0.25) {
        issues.push({ param: 'fitClearance', severity: 'warn',
          message: `${p.fitClearance} mm a side is a loose fit — the letters will rattle and need glue.` });
      }
    }
    if (plan.hole && p.plateThickness < 1.8) {
      issues.push({ param: 'plateThickness', severity: 'warn',
        message: 'A keyring hole in a plate under 1.8 mm tears out along the layer lines.' });
    }
    if (!standalone && p.borderWidth > 0 && !plan.border.length) {
      issues.push({ param: 'borderWidth', severity: 'error', message: 'The border does not fit on this plate.' });
    }
    if (plan.fit < 0.999 && p.autoShrink) {
      issues.push({ param: 'capHeight', severity: 'info',
        message: `Shrunk to ${(plan.fit * 100).toFixed(0)}% to fit: capitals come out ${plan.capMm.toFixed(1)} mm, not ${p.capHeight} mm.` });
    }
    return issues;
  },

  hints(p) {
    const standalone = p.plateShape === 'none' || p.mode === 'standalone';
    const notes = [];
    let layerH = 0.2;
    const relief = p.mode === 'raised' ? p.reliefHeight : p.mode === 'engraved' || p.mode === 'inlay' ? p.engraveDepth : p.plateThickness;
    if (relief < 1.0) { layerH = 0.12; notes.push(`Only ${relief} mm of relief: drop to a 0.12 mm layer so the letters get ${Math.round(relief / 0.12)} layers instead of ${Math.round(relief / 0.2)}.`); }

    notes.push('Flat on the plate, letters up. Nothing here overhangs past the 45° chamfer, so no supports and no brim.');
    notes.push('Three walls, not two. On a sign the walls ARE the letters — a letter two extrusions wide is entirely perimeter, and infill never touches it.');
    if (p.mode === 'raised') {
      notes.push('Turn ironing on for the top surface only if the plate is bare; ironing across raised letters drags plastic off their edges.');
    }
    if (p.mode === 'engraved') {
      notes.push('Engraved text reads best with a contrasting filament wiped into it, or a colour change one layer below the plate top.');
    }
    if (p.mode === 'stencil') {
      notes.push(`Bridges are ${p.bridgeWidth} mm. Print the stencil at 100% top and bottom so the bridge is solid, and peel it off the plate cold.`);
      notes.push('Keep the plate thin (1.2–1.6 mm): a thick stencil holds spray under its edges and blurs the line.');
    }
    if (p.mode === 'inlay') {
      notes.push(`Print the plate first, then the letters in the second colour. The recesses are ${p.fitClearance} mm larger than the letters on every side.`);
      notes.push('Loose letters need a brim — a 2 mm-tall letter has almost no footprint and will be flicked off by the nozzle otherwise.');
      notes.push('Chamfer the back edge of nothing here: the letters are pressed in from the front, so a sharp edge is what keeps them from lifting.');
    }
    if (standalone) {
      notes.push('Free letters: the rail is the only thing holding the word together, so do not cut it off until after the print is off the plate.');
    }
    if (p.edgeChamfer > 0) notes.push('The bottom chamfer replaces an elephant-foot compensation setting — leave that at 0.');

    return {
      profile: layerH === 0.2 ? '0.20 mm standard' : '0.12 mm fine',
      layerH,
      walls: 3,
      infill: 15,
      infillPattern: 'gyroid',
      supports: false,
      brim: p.mode === 'inlay' || standalone,
      filament: 'PLA',
      notes,
    };
  },
};

export default gen;
