// js/gen/cookiecutter.js — cutters and stamps for biscuit dough.
//
// A cookie cutter is a wall following a line, and the whole difficulty is that
// the line is usually LETTERS. A blade centred on a glyph's outline has to
// offset inward as well as outward, and the inward half collapses the moment a
// stroke is thinner than the blade — which, at a 0.8 mm blade and a 30 mm cap
// height, is most of a lower-case 'e'. The result is not an error; it is a ring
// that quietly folds through itself and extrudes into confetti.
//
// So the blade here is offset OUTWARD ONLY. The cutting edge is the outline
// itself, the wall stands outside it, and an outward offset can never collapse
// a shape — it can only merge neighbouring ones, which for two letters that
// nearly touch is exactly what you want anyway. It also means the biscuit comes
// out the size you asked for rather than the size minus half a blade.
//
// Printed flange-down, blade up: no overhang anywhere, and the flange is the
// first layer, which is the part that wants to be flat.
//
// The stamp is a separate object rather than an attempt to carve detail into
// the cutter. Pressing a word into dough and cutting a shape out of it are two
// operations, and a part that tries to be both is worse at each.
import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { extrude } from '../kernel/builders.js';
import { loadFont, layoutText } from '../kernel/text.js';
import { clamp, num, segScale } from '../kernel/scalar.js';

// ---------------------------------------------------------------------------
// Fonts — parsed once at module load, so build() stays synchronous.
// ---------------------------------------------------------------------------

const FONT_FILES = [
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf', label: 'Rounded Bold',
    help: 'Heavy and rounded — by far the best face for a cutter, because thin strokes are what break them.' },
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf', label: 'Sans Narrow',
    help: 'Condensed. Fits more letters, at the cost of thinner strokes.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf', label: 'Sans Mono',
    help: 'Even stroke weight throughout, which cuts predictably.' },
];
const DEFAULT_FONT = 'Quicksand-Bold';
const FONTS = new Map();
const FONT_ERRORS = new Map();

function fontFor(id) {
  return FONTS.get(id) || FONTS.get(DEFAULT_FONT) || FONTS.values().next().value || null;
}

async function loadBundledFonts() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/fonts/', import.meta.url);
  for (const f of FONT_FILES) {
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
      FONTS.set(f.id, loadFont(bytes));
    } catch (e) {
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}
await loadBundledFonts();

// ---------------------------------------------------------------------------
// SVG path data
//
// Enough of the `d` grammar to take a real path off a drawing: M L H V C S Q T
// A Z in both cases. Arcs go through the endpoint-to-centre conversion from the
// SVG specification rather than being approximated, because a cutter traced
// from a logo is mostly arcs and getting them subtly wrong shows.
//
// It is total: anything it cannot read becomes no ring, never an exception. The
// conformance sweep feeds this parameter the string "A" and a run of W's.
// ---------------------------------------------------------------------------

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol) {
  const chord = Math.hypot(x3 - x0, y3 - y0)
    + Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = clamp(Math.ceil(chord / Math.max(0.02, tol)), 2, 64);
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
}

/** SVG elliptical arc -> polyline, via the spec's endpoint parameterisation. */
function flattenArc(out, x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, tol) {
  if (!(rx > 0) || !(ry > 0) || (x1 === x2 && y1 === y2)) { out.push([x2, y2]); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const num0 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num0 / (den || 1)));
  const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let c = d ? (ux * vx + uy * vy) / d : 1;
    c = clamp(c, -1, 1);
    return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c);
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const t1 = ang(1, 0, ux, uy);
  let dt = ang(ux, uy, vx, vy) % (Math.PI * 2);
  if (!fs && dt > 0) dt -= Math.PI * 2;
  if (fs && dt < 0) dt += Math.PI * 2;
  const n = clamp(Math.ceil(Math.abs(dt) * Math.max(rx, ry) / Math.max(0.02, tol)), 3, 96);
  for (let i = 1; i <= n; i++) {
    const t = t1 + dt * (i / n);
    const ct = Math.cos(t), st = Math.sin(t);
    out.push([cx + cp * rx * ct - sp * ry * st, cy + sp * rx * ct + cp * ry * st]);
  }
}

/**
 * Parse SVG path data.
 * @returns {{rings: Array, unclosed: number, bad: boolean}}
 *   `rings` are polylines in SVG user units, Y still pointing DOWN.
 */
export function parsePath(d, tol = 0.25) {
  const res = { rings: [], unclosed: 0, bad: false };
  const src = String(d ?? '');
  const toks = src.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!toks) return res;

  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC = null, lastQ = null, ring = null;
  const closeRing = (closed) => {
    if (ring && ring.length >= 3) { res.rings.push(ring); if (!closed) res.unclosed++; }
    ring = null;
  };
  const nextNum = () => { const v = parseFloat(toks[i++]); return Number.isFinite(v) ? v : (res.bad = true, 0); };

  let guard = 0;
  while (i < toks.length && guard++ < 100000) {
    if (/[A-Za-z]/.test(toks[i])) { cmd = toks[i++]; }
    else if (cmd === null) { res.bad = true; break; }
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';

    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (!(up in ARGS)) { res.bad = true; break; }
    if (up !== 'Z' && toks.length - i < ARGS[up]) { res.bad = true; break; }

    if (up === 'Z') { if (ring) { closeRing(true); } cx = sx; cy = sy; lastC = lastQ = null; continue; }

    let nx = cx, ny = cy;
    if (up === 'M') {
      nx = nextNum(); ny = nextNum();
      if (rel) { nx += cx; ny += cy; }
      closeRing(false);
      ring = [[nx, ny]];
      sx = nx; sy = ny; lastC = lastQ = null;
    } else {
      if (!ring) ring = [[cx, cy]];
      if (up === 'L') { nx = nextNum(); ny = nextNum(); if (rel) { nx += cx; ny += cy; } ring.push([nx, ny]); lastC = lastQ = null; }
      else if (up === 'H') { nx = nextNum(); if (rel) nx += cx; ny = cy; ring.push([nx, ny]); lastC = lastQ = null; }
      else if (up === 'V') { ny = nextNum(); if (rel) ny += cy; nx = cx; ring.push([nx, ny]); lastC = lastQ = null; }
      else if (up === 'C' || up === 'S') {
        let x1, y1;
        if (up === 'C') { x1 = nextNum(); y1 = nextNum(); if (rel) { x1 += cx; y1 += cy; } }
        else { x1 = lastC ? 2 * cx - lastC[0] : cx; y1 = lastC ? 2 * cy - lastC[1] : cy; }
        let x2 = nextNum(), y2 = nextNum(); if (rel) { x2 += cx; y2 += cy; }
        nx = nextNum(); ny = nextNum(); if (rel) { nx += cx; ny += cy; }
        flattenCubic(ring, cx, cy, x1, y1, x2, y2, nx, ny, tol);
        lastC = [x2, y2]; lastQ = null;
      } else if (up === 'Q' || up === 'T') {
        let x1, y1;
        if (up === 'Q') { x1 = nextNum(); y1 = nextNum(); if (rel) { x1 += cx; y1 += cy; } }
        else { x1 = lastQ ? 2 * cx - lastQ[0] : cx; y1 = lastQ ? 2 * cy - lastQ[1] : cy; }
        nx = nextNum(); ny = nextNum(); if (rel) { nx += cx; ny += cy; }
        // Quadratic as a cubic, so one flattener serves both.
        flattenCubic(ring, cx, cy, cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy),
          nx + 2 / 3 * (x1 - nx), ny + 2 / 3 * (y1 - ny), nx, ny, tol);
        lastQ = [x1, y1]; lastC = null;
      } else if (up === 'A') {
        const rx = nextNum(), ry = nextNum(), rot = nextNum();
        const fa = nextNum() !== 0, fs = nextNum() !== 0;
        nx = nextNum(); ny = nextNum(); if (rel) { nx += cx; ny += cy; }
        flattenArc(ring, cx, cy, rx, ry, rot, fa, fs, nx, ny, tol);
        lastC = lastQ = null;
      }
    }
    cx = nx; cy = ny;
  }
  closeRing(false);
  return res;
}

/** Nest a flat list of rings into shapes, smallest-enclosing-parent wins. */
function ringsToShapes(rings) {
  const kept = rings.filter(r => r.length >= 3 && Math.abs(P.signedArea(r)) > 1e-6);
  kept.sort((a, b) => Math.abs(P.signedArea(b)) - Math.abs(P.signedArea(a)));
  const shapes = [];
  for (const r of kept) {
    const pt = r[0];
    let host = null;
    for (const s of shapes) if (P.pointInRing(pt, s[0])) host = s;   // later = smaller
    if (host) host.push(P.ensureCW(r)); else shapes.push([P.ensureCCW(r)]);
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// The outline
// ---------------------------------------------------------------------------

function bboxOf(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const r of s) for (const p of r) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return isFinite(x0) ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 } : null;
}

function mapShapes(shapes, fn) {
  return shapes.map(s => s.map(r => r.map(fn)));
}

/** Merge glyph outlines that overlap, so the offset never sees a self-overlap. */
function unionOverlapping(shapes) {
  if (shapes.length < 2) return shapes;
  const box = shapes.map(s => bboxOf([s]));
  let acc = [shapes[0]];
  for (let i = 1; i < shapes.length; i++) {
    const b = box[i];
    const hits = acc.some(s => { const a = bboxOf([s]); return a && b && !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0); });
    if (!hits) { acc.push(shapes[i]); continue; }
    try { acc = P.boolean(acc, [shapes[i]], 'union'); } catch { acc.push(shapes[i]); }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// The built-in shapes
//
// Every one is composed from kernel primitives and 2D booleans rather than
// from hand-authored path data. That is not purity: a path typed from memory
// is a shape nobody has ever looked at, and it will pass every topology check
// while looking nothing like the thing it is named after. Primitives can be
// reasoned about — a bone is four discs and a bar, and it is a bone.
//
// Components are made to OVERLAP rather than touch. Two circles tangent at a
// point union into a ring with a pinch in it, which is the same degeneracy the
// keyhole in cydmount died on; a millimetre of overlap costs nothing and
// removes the case entirely.
// ---------------------------------------------------------------------------

const R0 = 50;   // nominal half-size; everything is renormalised to `size` later

function unionAll(list) {
  let acc = list[0];
  for (let i = 1; i < list.length; i++) {
    try { acc = P.boolean(acc, list[i], 'union'); }
    catch { /* keep what we have; the caller still gets a valid shape */ }
  }
  return acc;
}

const seg = (sf, n) => Math.max(8, Math.round(n * (sf || 1)));

function heartRing(sf) {
  const n = seg(sf, 140), out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.PI * 2 * i / n;
    out.push([
      16 * Math.sin(t) ** 3,
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    ]);
  }
  return P.ensureCCW(out);
}

function eggRing(sf) {
  const n = seg(sf, 72), right = [], left = [];
  // Half-width of an ellipse, tapered toward the top: the fat end goes down,
  // which is which way up an egg sits.
  const w = (y) => Math.sqrt(Math.max(0, 1 - y * y)) * (1 - 0.28 * y);
  for (let i = 0; i <= n; i++) {
    const y = -1 + 2 * i / n;
    right.push([w(y) * R0 * 0.78, y * R0]);
    left.push([-w(y) * R0 * 0.78, y * R0]);
  }
  return P.ensureCCW([...right, ...left.reverse()]);
}


// Every helper below returns a SHAPE ARRAY (an array of shapes, each an array
// of rings), not a bare shape. poly2d.boolean happens to normalise a bare
// shape, which is exactly why the first draft mixed the two conventions
// without anything visibly breaking — and why the hexagon at the centre of the
// snowflake was silently malformed while still drawing something.

function capsule(x0, y0, x1, y1, r, sf) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ring = P.slot(len + 2 * r, r, { segs: seg(sf, 16) });
  const a = Math.atan2(y1 - y0, x1 - x0);
  const c = Math.cos(a), s = Math.sin(a);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return [[ring.map(q => [mx + c * q[0] - s * q[1], my + s * q[0] + c * q[1]])]];
}

const tri = (pts) => [[P.ensureCCW(pts)]];
const disc = (r, cx, cy, sf, n) => [[P.circle(r, { segs: seg(sf, n || 40), cx: cx || 0, cy: cy || 0 })]];

const SHAPES = {
  circle: { label: 'Circle', help: 'The one every set needs.',
    build: (o) => disc(R0, 0, 0, o.sf, 64) },

  polygon: { label: 'Polygon', help: 'Sides set by the Points parameter.', usesPoints: true,
    build: (o) => [[P.ensureCCW(P.regularPolygon(Math.max(3, o.points), R0, { rot: Math.PI / 2 }))]] },

  star: { label: 'Star', help: 'Points set by the Points parameter.', usesPoints: true,
    build: (o) => [[P.ensureCCW(P.star(Math.max(3, o.points), R0, R0 * 0.45, { rot: Math.PI / 2 }))]] },

  heart: { label: 'Heart', build: (o) => [[heartRing(o.sf)]] },

  egg: { label: 'Egg', build: (o) => [[eggRing(o.sf)]] },

  flower: { label: 'Flower', help: 'Petals set by the Points parameter.', usesPoints: true,
    build: (o) => {
      // Overlapping discs on a ring, NOT a superformula. The superformula's
      // petals come to a point and the result reads as a starfish; a flower's
      // petals are round, and a disc is round by construction.
      const n = Math.max(3, o.points);
      const pr = R0 * (n <= 5 ? 0.44 : n <= 8 ? 0.36 : 0.27);
      const ring = R0 - pr;
      const parts = [disc(ring * 0.66, 0, 0, o.sf, 44)];
      for (let k = 0; k < n; k++) {
        const a = Math.PI / 2 + Math.PI * 2 * k / n;
        parts.push(disc(pr, Math.cos(a) * ring, Math.sin(a) * ring, o.sf, 40));
      }
      return unionAll(parts);
    } },

  moon: { label: 'Crescent moon',
    build: (o) => {
      const s = seg(o.sf, 72);
      const cut = P.boolean([[P.circle(R0, { segs: s })]],
        [[P.circle(R0 * 0.88, { segs: s, cx: R0 * 0.42 })]], 'difference');
      return cut.length ? cut : disc(R0, 0, 0, o.sf, 72);
    } },

  snowflake: { label: 'Snowflake',
    build: (o) => {
      const bar = (ang, len, w) => {
        const r = P.roundRect(len, w, w / 2, { segs: seg(o.sf, 10) });
        const c = Math.cos(ang), s2 = Math.sin(ang);
        return [[r.map(q => [c * q[0] - s2 * q[1], s2 * q[0] + c * q[1]])]];
      };
      const parts = [];
      for (let k = 0; k < 3; k++) parts.push(bar(k * Math.PI / 3, 2 * R0, R0 * 0.15));
      // A small hub, not a fat hexagon: the first version put a 0.26 R disc in
      // the middle and the flake read as a blob with legs.
      parts.push([[P.ensureCCW(P.regularPolygon(6, R0 * 0.17))]]);
      // Two pairs of branches per arm, swept back toward the centre like frost.
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3;
        for (const [rr, L] of [[R0 * 0.50, R0 * 0.30], [R0 * 0.76, R0 * 0.20]]) {
          const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
          for (const d of [+1, -1]) {
            const b = a + d * Math.PI / 4;
            parts.push(capsule(px, py, px + Math.cos(b) * L, py + Math.sin(b) * L, R0 * 0.055, o.sf));
          }
        }
      }
      return unionAll(parts);
    } },

  bone: { label: 'Bone',
    build: (o) => {
      const r = R0 * 0.34, L = R0 * 1.5;
      const parts = [[[P.roundRect(L, r * 1.15, r * 0.3, { segs: seg(o.sf, 8) })]]];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(disc(r, sx * L / 2, sy * r * 0.72, o.sf, 28));
      return unionAll(parts);
    } },

  gingerbread: { label: 'Gingerbread man',
    build: (o) => {
      const head = R0 * 0.30, body = R0 * 0.26;
      const parts = [
        disc(head, 0, R0 * 0.66, o.sf, 40),
        [[P.roundRect(body * 2, R0 * 0.90, body * 0.7, { segs: seg(o.sf, 12), cy: R0 * 0.06 })]],
      ];
      parts.push(capsule(0, R0 * 0.34, -R0 * 0.72, R0 * 0.56, R0 * 0.14, o.sf));
      parts.push(capsule(0, R0 * 0.34, R0 * 0.72, R0 * 0.56, R0 * 0.14, o.sf));
      parts.push(capsule(0, -R0 * 0.28, -R0 * 0.42, -R0 * 0.92, R0 * 0.145, o.sf));
      parts.push(capsule(0, -R0 * 0.28, R0 * 0.42, -R0 * 0.92, R0 * 0.145, o.sf));
      return unionAll(parts);
    } },

  tree: { label: 'Christmas tree',
    build: (o) => {
      const parts = [];
      // Each tier's BASE sits above the one below while being narrower, so the
      // silhouette steps. Overlap them any harder and the three tiers fuse
      // into one plain triangle — which is a tree, but not a Christmas tree,
      // and that is what the first version drew.
      const tiers = [[1.00, -0.42, 0.80], [0.74, -0.04, 0.78], [0.46, 0.34, 0.76]];
      for (const [w, y, h] of tiers) parts.push(tri([[-R0 * w, R0 * y], [R0 * w, R0 * y], [0, R0 * (y + h)]]));
      parts.push([[P.roundRect(R0 * 0.24, R0 * 0.34, R0 * 0.04, { segs: 6, cy: -R0 * 0.54 })]]);
      return unionAll(parts);
    } },

  bell: { label: 'Bell',
    build: (o) => {
      const parts = [
        disc(R0 * 0.46, 0, R0 * 0.28, o.sf, 48),
        tri([[-R0 * 0.80, -R0 * 0.46], [R0 * 0.80, -R0 * 0.46], [R0 * 0.44, R0 * 0.40], [-R0 * 0.44, R0 * 0.40]]),
        [[P.roundRect(R0 * 1.72, R0 * 0.30, R0 * 0.12, { segs: seg(o.sf, 10), cy: -R0 * 0.52 })]],
        disc(R0 * 0.20, 0, -R0 * 0.74, o.sf, 40),
      ];
      return unionAll(parts);
    } },

  cat: { label: 'Cat head',
    build: (o) => {
      const r = R0 * 0.78;
      const parts = [disc(r, 0, -R0 * 0.08, o.sf, 56)];
      for (const sx of [-1, 1]) {
        parts.push(tri([[sx * r * 0.30, r * 0.72], [sx * r * 0.92, r * 0.52], [sx * r * 0.74, R0 * 1.02]]));
      }
      return unionAll(parts);
    } },

  rabbit: { label: 'Rabbit',
    build: (o) => {
      const s = seg(o.sf, 56), r = R0 * 0.56;
      const parts = [disc(r, 0, -R0 * 0.40, o.sf, 56)];
      // Long and narrow, splayed outward. Short fat ellipses blob into the
      // head and it stops reading as a rabbit at all.
      for (const sx of [-1, 1]) {
        parts.push([[P.ensureCCW(P.ellipse(R0 * 0.145, R0 * 0.56, { segs: s, cx: sx * R0 * 0.235, cy: R0 * 0.34, rot: sx * 0.20 }))]]);
      }
      return unionAll(parts);
    } },
};

export const SHAPE_IDS = Object.keys(SHAPES);

const FALLBACK = () => [[P.circle(20, { segs: 48 })]];

/**
 * Resolve the parameters to a normalised outline, centred and scaled so its
 * larger dimension is `size`. ALWAYS returns something buildable: a shape that
 * cannot be read falls back to a disc, and validate() explains why.
 */
function outlineFor(p, size, tol, sf = 1) {
  const src = ['svg', 'shape', 'text'].includes(p.source) ? p.source : 'text';
  const notes = { source: src, fellBack: false, unclosed: 0, bad: false, missing: [], shape: null };
  let shapes = null;

  if (src === 'shape') {
    const key = SHAPES[p.shape] ? p.shape : 'circle';
    notes.shape = key;
    try {
      const got = SHAPES[key].build({ sf, points: Math.round(clamp(num(p.points, 5), 3, 12)) });
      if (got && got.length) shapes = got;
    } catch { shapes = null; }
  } else if (src === 'svg') {
    const parsed = parsePath(p.svg, tol);
    notes.unclosed = parsed.unclosed;
    notes.bad = parsed.bad;
    if (parsed.rings.length) {
      // SVG's Y axis points down; the world's does not.
      shapes = ringsToShapes(parsed.rings.map(r => r.map(q => [q[0], -q[1]])));
    }
  } else {
    const font = fontFor(p.font);
    const text = String(p.text ?? '').trim();
    if (font && text) {
      try {
        const lay = layoutText(font, text, { size: 40, align: 'center', vAlign: 'baseline', curveTolerance: Math.max(0.05, tol / 2), onMissing: 'skip' });
        notes.missing = lay.missing || [];
        if (lay.shapes && lay.shapes.length) shapes = unionOverlapping(lay.shapes);
      } catch { shapes = null; }
    }
  }

  if (!shapes || !shapes.length) { shapes = FALLBACK(); notes.fellBack = true; }
  const b = bboxOf(shapes);
  if (!b || !(b.w > 1e-6) || !(b.h > 1e-6)) { shapes = FALLBACK(); notes.fellBack = true; }
  const bb = bboxOf(shapes);
  const k = size / Math.max(bb.w, bb.h);
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  return { shapes: mapShapes(shapes, (q) => [(q[0] - cx) * k, (q[1] - cy) * k]), notes };
}

// ---------------------------------------------------------------------------

function plan(p, ctx = {}) {
  const sf = segScale(ctx);
  const tol = clamp(0.3 / sf, 0.08, 0.6);
  const nozzle = clamp(num(ctx.nozzle, 0.4), 0.1, 1.2);

  const size = clamp(num(p.size, 60), 15, 160);
  const height = clamp(num(p.height, 15), 4, 40);
  const blade = clamp(num(p.blade, 0.8), 0.4, 2.4);
  const flangeW = clamp(num(p.flangeW, 4), 0, 15);
  const flangeT = clamp(num(p.flangeT, 1.6), 0.4, 5);

  const { shapes, notes } = outlineFor(p, size, tol, sf);

  const stamp = !!p.stamp;
  const detail = String(p.detail ?? '').trim();
  const detailSize = clamp(num(p.detailSize, 12), 3, 60);
  const mirror = !!p.mirror;
  const stampT = clamp(num(p.stampT, 3), 1, 10);
  const relief = clamp(num(p.relief, 1.2), 0.3, Math.max(0.3, stampT * 0.8));
  const stampPad = clamp(num(p.stampPad, 6), 1, 30);

  const part = ['both', 'cutter', 'stamp'].includes(p.part) ? p.part : 'both';

  return {
    sf, tol, nozzle, size, height, blade, flangeW, flangeT, shapes, notes,
    stamp, detail, detailSize, mirror, stampT, relief, stampPad, part,
    perims: blade / nozzle,
  };
}

// ---------------------------------------------------------------------------

const EPS_LEDGE = 0.05;

function buildCutter(L) {
  const outer = P.offset(L.shapes, L.blade, { join: 'round' });
  const bladeRing = P.boolean(outer, L.shapes, 'difference');
  if (!bladeRing.length) throw new Error('the blade offset produced nothing');

  const parts = [];
  // Flange first, flat on the plate: printed this way up there is no overhang
  // anywhere on the object, and the widest face is the one on the bed.
  if (L.flangeW > 0.01 && L.flangeT > 0.01) {
    const fOuter = P.offset(L.shapes, L.blade + L.flangeW, { join: 'round' });
    // A hair OUTWARD of the cut line, never inward: sharing the blade's inner
    // ring would weld four faces onto one edge, and offsetting inward is the
    // collapse this generator exists to avoid.
    const fInner = P.offset(L.shapes, EPS_LEDGE, { join: 'round' });
    const flange = P.boolean(fOuter, fInner, 'difference');
    if (flange.length) parts.push(extrude(flange, L.flangeT, { check: false }));
  }
  const z0 = parts.length ? L.flangeT : 0;
  parts.push(extrude(bladeRing, L.height, { z0, check: false }));
  return Mesh.merge(parts).healTJunctions();
}

function buildStamp(L) {
  const font = fontFor(L.detailFont || DEFAULT_FONT);
  let ink = [];
  if (L.detail && font) {
    try {
      const lay = layoutText(font, L.detail, { size: L.detailSize, align: 'center', vAlign: 'baseline', curveTolerance: Math.max(0.05, L.tol / 2), onMissing: 'skip' });
      if (lay.shapes && lay.shapes.length) ink = unionOverlapping(lay.shapes);
    } catch { ink = []; }
  }
  const ib = ink.length ? bboxOf(ink) : null;
  // Centre the ink, and mirror it about X so the impression reads the right
  // way round in the dough — the same reason a rubber stamp is cut backwards.
  if (ib) {
    const cx = (ib.x0 + ib.x1) / 2, cy = (ib.y0 + ib.y1) / 2;
    ink = mapShapes(ink, (q) => [(L.mirror ? -(q[0] - cx) : (q[0] - cx)), q[1] - cy]);
  }
  const nb = ink.length ? bboxOf(ink) : null;
  const w = Math.max(8, (nb ? nb.w : L.detailSize * 2) + 2 * L.stampPad);
  const h = Math.max(8, (nb ? nb.h : L.detailSize) + 2 * L.stampPad);
  const plate = P.roundRect(w, h, Math.min(w, h) * 0.18, { segs: Math.max(6, Math.round(12 * L.sf)) });
  const parts = [extrude([[plate]], L.stampT, { check: false })];
  if (ink.length) parts.push(extrude(ink, L.relief, { z0: L.stampT, check: false }));
  return { mesh: Mesh.merge(parts).healTJunctions(), w, h };
}

function arrange(meshes) {
  const centred = meshes.map(m => ({ name: m.name, mesh: m.mesh.centerXY().dropToPlate() }));
  if (centred.length === 1) {
    const m = centred[0].mesh.place();
    return { mesh: m, parts: [{ name: centred[0].name, mesh: m }] };
  }
  const b = centred[0].mesh.bbox();
  const alongX = b.size[0] <= b.size[1];
  const gap = 5;
  let run = 0;
  const placed = [];
  for (const c of centred) {
    const s = c.mesh.bbox().size;
    placed.push({ name: c.name, mesh: c.mesh, at: run + (alongX ? s[0] : s[1]) / 2 });
    run += (alongX ? s[0] : s[1]) + gap;
  }
  const total = run - gap;
  const parts = placed.map(q => ({
    name: q.name,
    mesh: alongX ? q.mesh.translate(q.at - total / 2, 0, 0) : q.mesh.translate(0, q.at - total / 2, 0),
  }));
  const merged = Mesh.merge(parts.map(q => q.mesh));
  const bb = merged.bbox();
  const off = [-bb.center[0], -bb.center[1], -bb.min[2]];
  return {
    mesh: merged.translate(off[0], off[1], off[2]),
    parts: parts.map(q => ({ name: q.name, mesh: q.mesh.translate(off[0], off[1], off[2]) })),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

function build(p, ctx = {}) {
  const L = plan(p, ctx);
  L.detailFont = p.font;

  const wanted = [];
  if (L.part !== 'stamp') wanted.push({ name: 'cutter', mesh: buildCutter(L) });
  let stampInfo = null;
  if (L.stamp && L.part !== 'cutter') { stampInfo = buildStamp(L); wanted.push({ name: 'stamp', mesh: stampInfo.mesh }); }
  if (!wanted.length) wanted.push({ name: 'cutter', mesh: buildCutter(L) });
  const laid = arrange(wanted);

  const host = laid.parts.find(q => q.name === 'cutter') || laid.parts[0];
  const src = wanted.find(q => q.name === host.name);
  const hb = src.mesh.bbox(), pb = host.mesh.bbox();
  const T = [pb.center[0] - hb.center[0], pb.center[1] - hb.center[1], pb.min[2] - hb.min[2]];

  const dims = [];
  if (host.name === 'cutter') {
    const b = src.mesh.bbox();
    const x = b.max[0] + T[0], y = b.center[1] + T[1];
    dims.push({ param: 'height', from: [x, y, L.flangeT + T[2]], to: [x, y, L.flangeT + L.height + T[2]], offset: [1, 0, 0] });
    dims.push({ param: 'flangeT', from: [x, b.min[1] + T[1], T[2]], to: [x, b.min[1] + T[1], L.flangeT + T[2]], offset: [1, -1, 0] });
    dims.push({ param: 'size', value: r2(L.size),
      from: [b.min[0] + T[0], b.max[1] + T[1], T[2]], to: [b.max[0] + T[0], b.max[1] + T[1], T[2]], offset: [0, 1, 0] });
    dims.push({ label: 'blade', value: `${L.blade} mm · ${L.perims.toFixed(1)}× nozzle`,
      from: [b.max[0] + T[0], y, L.flangeT + L.height + T[2]],
      to: [b.max[0] - L.blade + T[0], y, L.flangeT + L.height + T[2]], offset: [0, 0, 1] });
  }
  const stampPart = laid.parts.find(q => q.name === 'stamp');
  if (stampPart && stampInfo) {
    const sb = stampPart.mesh.bbox();
    dims.push({ param: 'stampT', from: [sb.max[0], sb.center[1], sb.min[2]], to: [sb.max[0], sb.center[1], sb.min[2] + L.stampT], offset: [1, 0, 0] });
  }

  const analysis = [];
  analysis.push(
    L.perims >= 2
      ? `Blade ${L.blade} mm — ${L.perims.toFixed(1)} passes of a ${L.nozzle} mm nozzle, so it prints as ${Math.floor(L.perims)} solid walls.`
      : `Blade ${L.blade} mm is only ${L.perims.toFixed(1)} passes of a ${L.nozzle} mm nozzle. Under two the slicer cannot lay a wall on each face and will fill it with a single wandering bead — thicken it to at least ${r2(L.nozzle * 2)} mm.`);
  if (L.notes.source === 'svg') {
    if (L.notes.fellBack) analysis.push('No usable path was read, so this is the fallback disc. Paste the `d` attribute of an SVG <path>.');
    else if (L.notes.unclosed) analysis.push(`${L.notes.unclosed} subpath${L.notes.unclosed > 1 ? 's are' : ' is'} not closed — no Z at the end. They have been closed for you with a straight line back to the start, which is rarely where the shape wanted to go.`);
    else analysis.push('Path read and every subpath closed.');
  } else if (L.notes.fellBack) {
    analysis.push('No letters could be laid out, so this is the fallback disc.');
  } else if (L.notes.missing.length) {
    analysis.push(`Skipped ${L.notes.missing.length} character${L.notes.missing.length > 1 ? 's' : ''} the typeface has no glyph for: ${L.notes.missing.slice(0, 6).join(' ')}`);
  }
  analysis.push(`Cut line is the outline itself; the blade stands outside it, so the biscuit comes out ${r2(L.size)} mm across, not ${r2(L.size)} minus a blade.`);

  return {
    mesh: laid.mesh,
    parts: laid.parts,
    meta: {
      dims, analysis,
      source: L.notes.source,
      fellBack: L.notes.fellBack,
      unclosedPaths: L.notes.unclosed,
      bladePasses: r2(L.perims),
      cutSize: r2(L.size),
      overall: laid.mesh.bbox().size.map(r2),
      stamp: stampInfo ? { plate: [r2(stampInfo.w), r2(stampInfo.h)], relief: L.relief, mirrored: L.mirror } : null,
    },
  };
}

function validate(p) {
  const issues = [];
  const nozzle = 0.4;
  const blade = clamp(num(p.blade, 0.8), 0.4, 2.4);
  if (blade < nozzle * 2) {
    issues.push({ param: 'blade', severity: blade < nozzle * 1.5 ? 'error' : 'warn',
      message: `A ${blade} mm blade is ${(blade / nozzle).toFixed(1)} passes of a 0.4 mm nozzle. Under two there is no wall on each face — use ${nozzle * 2} mm or more.` });
  }
  if (p.source === 'svg') {
    const parsed = parsePath(p.svg, 0.25);
    if (!parsed.rings.length) {
      issues.push({ param: 'svg', severity: 'error',
        message: 'No path could be read. Paste the value of a <path>\'s d attribute — it starts with M and is a run of commands and numbers.' });
    } else {
      if (parsed.bad) issues.push({ param: 'svg', severity: 'warn', message: 'The path contains something this parser could not read; the rest was used. Supported: M L H V C S Q T A Z.' });
      if (parsed.unclosed) {
        issues.push({ param: 'svg', severity: 'warn',
          message: `${parsed.unclosed} subpath${parsed.unclosed > 1 ? 's do' : ' does'} not end with Z. A cutter has to be a closed loop, so each has been closed with a straight line — check the shape is what you expect.` });
      }
    }
  } else if (!String(p.text ?? '').trim()) {
    issues.push({ param: 'text', severity: 'error', message: 'Nothing to cut. Type a word, a letter or a number.' });
  }
  if (p.stamp && !String(p.detail ?? '').trim()) {
    issues.push({ param: 'detail', severity: 'warn', message: 'The stamp has no text on it, so it is a blank plate.' });
  }
  if (num(p.flangeW, 4) === 0) {
    issues.push({ param: 'flangeW', severity: 'warn', message: 'With no flange there is nothing to press on and nothing holding the blade square. It will still cut, but it will flex.' });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const L = plan(p, ctx);
  const notes = [];
  notes.push('Printed as arranged — flange flat on the plate, blade pointing up — there is no overhang on the object and no supports are needed.');
  notes.push(`Slice it with the blade as ${Math.max(1, Math.floor(L.perims))} perimeter${L.perims >= 2 ? 's' : ''} and NO infill or top layers: a cutter wants to be walls all the way up, and any gap-fill in a ${L.blade} mm wall is a weak point.`);
  notes.push('PLA and PETG are both food-contact awkward: the ridges between layers hold dough and are hard to clean. Wash by hand, do not put it in the dishwasher — the heat will take the temper out of PLA at about 55 °C.');
  if (L.stamp) notes.push(`The stamp\'s letters stand ${L.relief} mm proud${L.mirror ? ' and are mirrored, so they read correctly once pressed' : ' and are NOT mirrored, so the impression will read backwards — turn on Mirror if that matters'}.`);
  notes.push('Flour the cutter before each press if the dough is sticky. A 0.2 mm layer height is plenty; the blade edge is what matters and it is vertical.');
  return { profile: { layerH, infill: 0, walls: Math.max(1, Math.floor(L.perims)) }, supports: false, filament: 'PLA', notes };
}

// ---------------------------------------------------------------------------

export default {
  id: 'cookiecutter',
  name: 'Cookie Cutter',
  category: 'Kitchen',
  blurb: 'A cutter from a word or an SVG outline, with a flange to press on and an optional stamp.',
  description:
    'Type a word, or paste the d attribute of an SVG path, and get a cutter: a blade following the outline, a flange around ' +
    'the top to press on, and optionally a separate stamp that presses a word into the dough. The blade is offset OUTWARD ' +
    'from the line, which is what makes a lettered cutter possible at all — a blade centred on a glyph collapses wherever a ' +
    'stroke is thinner than the blade, and it also means the biscuit comes out the size you asked for. It prints flange-down ' +
    'with the blade pointing up, so nothing overhangs. The analysis says how many passes of your nozzle the blade actually ' +
    'is, because a wall thinner than two of them is not a wall.',
  version: 1,
  params: [
    { key: 'source', label: 'Outline from', type: 'enum', def: 'text', group: 'Shape',
      options: [
        { v: 'shape', label: 'Built-in shape', help: 'A library of the usual suspects, all parametric.' },
        { v: 'text', label: 'Text', help: 'Letters, in a real font outline.' },
        { v: 'svg', label: 'SVG path', help: 'The d attribute of a <path> element.' },
      ],
      help: 'Where the cut line comes from.' },
    { key: 'shape', label: 'Shape', type: 'enum', def: 'gingerbread', group: 'Shape',
      options: SHAPE_IDS.map(k => ({ v: k, label: SHAPES[k].label, help: SHAPES[k].help })),
      showIf: (p) => p.source === 'shape',
      help: 'Each is built from primitives rather than traced, so it stays clean at any size.' },
    { key: 'points', label: 'Points', type: 'int', def: 5, min: 3, max: 12, step: 1, group: 'Shape',
      showIf: (p) => p.source === 'shape' && !!SHAPES[p.shape] && !!SHAPES[p.shape].usesPoints,
      help: 'Points on the star, sides of the polygon, petals on the flower.' },
    { key: 'text', label: 'Text', type: 'text', def: 'NOEL', maxLength: 16, group: 'Shape',
      showIf: (p) => p.source === 'text',
      help: 'Short and bold cuts best. Long words make a long thin cutter that flexes.' },
    { key: 'font', label: 'Typeface', type: 'enum', def: DEFAULT_FONT, group: 'Shape',
      options: FONT_FILES.map(f => ({ v: f.id, label: f.label, help: f.help })),
      showIf: (p) => p.source !== 'svg', help: 'Also used for the stamp. Heavier faces cut better — thin strokes are what break a cutter.' },
    { key: 'svg', label: 'SVG path data', type: 'text',
      def: 'M 50 5 L 61 38 L 95 38 L 68 59 L 79 92 L 50 71 L 21 92 L 32 59 L 5 38 L 39 38 Z',
      maxLength: 2000, group: 'Shape', showIf: (p) => p.source === 'svg',
      help: 'The d attribute only, not the whole file. M L H V C S Q T A Z are all understood, in either case.' },
    { key: 'size', label: 'Size', type: 'number', def: 60, min: 15, max: 160, step: 1, unit: 'mm', group: 'Shape',
      help: 'Across the longer axis of the shape. This is the size of the biscuit, because the blade sits outside the line.' },

    { key: 'height', label: 'Cutting depth', type: 'number', def: 15, min: 4, max: 40, step: 0.5, unit: 'mm', group: 'Cutter',
      help: 'How tall the blade is. 15 mm cuts any rolled dough and still stacks in a drawer.' },
    { key: 'blade', label: 'Blade thickness', type: 'number', def: 0.8, min: 0.4, max: 2.4, step: 0.1, unit: 'mm', group: 'Cutter',
      help: '0.8 mm is two passes of a 0.4 mm nozzle — the thinnest that is genuinely two walls. Thinner cuts more cleanly and snaps.' },
    { key: 'flangeW', label: 'Flange width', type: 'number', def: 4, min: 0, max: 15, step: 0.5, unit: 'mm', group: 'Cutter',
      help: 'The lip around the base to press on with your thumbs. It is also what keeps the blade square.' },
    { key: 'flangeT', label: 'Flange thickness', type: 'number', def: 1.6, min: 0.4, max: 5, step: 0.2, unit: 'mm', group: 'Cutter',
      help: 'How thick that lip is. This is the first layer, so it wants to be a few of them.' },

    { key: 'stamp', label: 'Stamp', type: 'bool', def: false, group: 'Stamp',
      help: 'A second, separate part: a plate with raised letters for pressing a word into the cut biscuit.' },
    { key: 'detail', label: 'Stamp text', type: 'text', def: 'MERRY', maxLength: 16, group: 'Stamp',
      showIf: (p) => !!p.stamp, help: 'What gets pressed into the dough.' },
    { key: 'detailSize', label: 'Stamp letter height', type: 'number', def: 12, min: 3, max: 60, step: 0.5, unit: 'mm', group: 'Stamp',
      showIf: (p) => !!p.stamp },
    { key: 'mirror', label: 'Mirror the stamp', type: 'bool', def: true, group: 'Stamp',
      showIf: (p) => !!p.stamp, help: 'On, so the impression reads the right way round. A stamp is cut backwards for the same reason a rubber one is.' },
    { key: 'relief', label: 'Stamp relief', type: 'number', def: 1.2, min: 0.3, max: 6, step: 0.1, unit: 'mm', group: 'Stamp',
      showIf: (p) => !!p.stamp, help: 'How far the letters stand proud. Deeper marks more, and traps more dough.' },
    { key: 'stampT', label: 'Stamp plate', type: 'number', def: 3, min: 1, max: 10, step: 0.5, unit: 'mm', group: 'Stamp',
      showIf: (p) => !!p.stamp, help: 'Thickness of the plate behind the letters.' },
    { key: 'stampPad', label: 'Stamp margin', type: 'number', def: 6, min: 1, max: 30, step: 0.5, unit: 'mm', group: 'Stamp',
      showIf: (p) => !!p.stamp, help: 'Plate showing around the letters — this is what you push on.' },

    { key: 'part', label: 'Show', type: 'enum', def: 'both', group: 'Output',
      options: [{ v: 'both', label: 'Cutter and stamp' }, { v: 'cutter', label: 'Cutter only' }, { v: 'stamp', label: 'Stamp only' }],
      help: 'Both are laid out flat, ready to slice as one plate.' },
  ],
  presets: [
    { name: 'NOEL, lettered', values: {
      source: 'text', text: 'NOEL', font: DEFAULT_FONT, size: 70, height: 15, blade: 0.8,
      flangeW: 4, flangeT: 1.6, stamp: false, part: 'both' } },
    { name: 'Star, from a path', values: {
      source: 'svg', svg: 'M 50 5 L 61 38 L 95 38 L 68 59 L 79 92 L 50 71 L 21 92 L 32 59 L 5 38 L 39 38 Z',
      size: 80, height: 18, blade: 1, flangeW: 5, flangeT: 2, stamp: false, part: 'both' } },
    { name: 'Round, with a stamp', values: {
      source: 'svg', svg: 'M 50 5 A 45 45 0 1 1 49.9 5 Z',
      size: 65, height: 14, blade: 0.8, flangeW: 4, flangeT: 1.6,
      stamp: true, detail: 'MERRY', detailSize: 12, mirror: true, relief: 1.2, stampT: 3, stampPad: 6, part: 'both' } },
    { name: 'Single initial, deep', values: {
      source: 'text', text: 'B', font: DEFAULT_FONT, size: 55, height: 25, blade: 1.2,
      flangeW: 6, flangeT: 2.4, stamp: false, part: 'both' } },
  ],
  build,
  validate,
  hints,
};
