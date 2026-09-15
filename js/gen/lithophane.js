// lithophane — a photograph as a translucent relief.
//
// Dark pixel = thick = blocks light. That sentence is the whole object, and
// getting it backwards produces a negative that looks plausible on screen and
// wrong in the hand. Everything else here exists to serve it honestly.
//
// THE THREE DECISIONS THAT MATTER, AND WHY THEY WERE MADE THIS WAY
//
// 1. IT PRINTS STANDING UP. The relief lies in X and Z; thickness runs along Y.
//    Printed flat on its back, the picture's tonal range would be quantised to
//    the layer height — a 0.8-3.0 mm range at 0.2 mm layers is eleven grey
//    levels, and you can count them in the print. Standing up, thickness is a
//    horizontal dimension resolved by the extruder's positioning (hundredths of
//    a millimetre) and the *rows* of the picture become the layers. Every
//    generator in Bluesheet returns its object in the orientation it should be
//    printed in; for this one that choice is the difference between a photograph
//    and a topographic map of a photograph.
//
// 2. THE ARC LENGTH IS THE PICTURE WIDTH. A curved lithophane is a bent plate.
//    Ask for 100 mm of picture on a 60 mm radius and the included angle is
//    100/61.9 = 1.62 rad; the *chord* across that is 88.9 mm. Using the chord —
//    the easy mistake, because a chord is what a bounding box reports — squashes
//    the picture by 11% and nothing in the mesh looks wrong. The angle here is
//    always derived from arc length at the mid-thickness surface, and the test
//    suite measures the built polyline rather than trusting the arithmetic.
//
// 3. RESAMPLING IS A FILTER, NOT A LOOKUP. Point-sampling a 4000 px photo down
//    to a 250-column grid throws away 15 of every 16 pixels and aliases the rest;
//    on a print that reads as stair-stepping along every diagonal edge and as
//    glitter in fine texture. This module box-reduces by an integer factor first
//    (cheap, exact, and the correct anti-alias for a large reduction) and then
//    does a windowed Lanczos-3 resample for the remainder. It also caps the
//    output grid, so a 4000x3000 photograph produces the same size of mesh as a
//    400x300 one.
//
// Pure, deterministic, DOM-free. The caption pulls in text.js and builders.js;
// nothing here touches the DOM or the network at build time.

import { Mesh, TAU } from '../kernel/mesh.js';
import { rect, circle, slot, triangulate, reverse, ensureCCW, area as ringArea, boolean } from '../kernel/poly2d.js';
import { loadFont, layoutText, contoursToShapes } from '../kernel/text.js';
import { DEG, clamp, num } from '../kernel/scalar.js';

const SHAPES = ['flat', 'arc-out', 'arc-in', 'shade'];

// An arc wider than this closes on itself and the two end faces intersect. It is
// reached by asking for a wide picture on a small radius, and the fix is to open
// the radius rather than to compress the picture: the picture is what was asked
// for, the curvature is a preference. validate() reports it by name.
const MAX_ARC = 350 * DEG;

// Triangle budget. A lithophane is inherently a dense mesh — it is a height
// field — but "dense" and "unopenable" are different numbers. 220k triangles is
// an 11 MB STL that OrcaSlicer handles without complaint; a 4000x3000 photo
// point-sampled one-pixel-per-vertex would be 24 million.
const MAX_TRIS = 300000;

const SPAN_EPS = 1e-9;      // below this an image is one colour and cannot be stretched
const HANGER_CLEAR = 1.0;   // mm of material that must remain around a hanger hole
const SHADE_CORNER = 1.2;   // mm — a lamp shade never gets a knife-edge corner

// Millimetres of thickness the relief may gain per millimetre of height.
//
// This is the constraint nobody thinks about until the print is on the bed. The
// relief is a horizontal displacement, so a horizontal edge in the photograph —
// a dark sky over a bright horizon — is a step *outward* as the print rises. At
// 0.1 mm layers a full-range 2.2 mm step over one 0.35 mm sample is 0.63 mm of
// unsupported offset per layer against a 0.42 mm extrusion: the perimeter is
// laid in mid-air and droops, and the edge that mattered most in the picture is
// the one that comes out blurred. 2.0 is a 63 degree overhang, which at these
// layer heights is still more than half supported.
const MAX_RISE = 2.0;

const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// The caption
//
// A lithophane given away as a present wants a line under the picture, and this
// is the one object where a line of text has three genuinely different answers
// rather than one:
//
//   raised    letters standing off the front of the frame. Legible in any
//             light, and the only style that costs nothing in material.
//   engraved  a shallow pocket in the front. Reads as a shadow.
//   lit       a deep pocket in the BACK, leaving no more material than the
//             brightest part of the picture has. In reflected light the frame
//             looks blank; hold it up and the message comes on with the
//             photograph. Its ink is MIRRORED, because it is read through the
//             panel — the same reason the arc-in shape mirrors its picture, and
//             the same mistake if it is forgotten: a mesh that looks perfect
//             from the front and prints back to front.
//
// The band the text sits in is measured from the laid-out text rather than
// predicted from the cap height, so a second line and a descender both get the
// room they actually need, and the bottom border only grows when the frame it
// already has is too shallow to hold the words.
// ---------------------------------------------------------------------------

// Same files and ids as nameplate and the QR plaque, parsed here independently:
// build() has to be synchronous, and a fault in one generator's font table must
// not take the others down with it.
const FONT_FILES = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf', label: 'Sans Narrow',
    help: 'Condensed; fits the most words under a picture.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf', label: 'Sans Mono',
    help: 'Fixed pitch, even stroke — the safest face at small sizes.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf', label: 'Rounded Bold',
    help: 'Heavy and rounded. The one to pick for a lit message: a thin stroke lets through too little light to read.' },
];
const DEFAULT_FONT = 'Quicksand-Bold';
const FONTS = new Map();
const FONT_ERRORS = new Map();
const CAP_STYLES = ['raised', 'engraved', 'lit'];
const CAP_PAD = 1.6;          // mm of air between the words and everything else
const MIN_RING_AREA = 1e-5;   // below this a glyph ring is a rounding artefact

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
      // A missing face is a missing caption, not a broken generator.
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}
await loadBundledFonts();

function shiftShapes(shapes, dx, dy) {
  return shapes.map(s => s.map(r => r.map(q => [q[0] + dx, q[1] + dy])));
}

/** Mirror about x = 0. Negating one axis reverses every ring, so every ring turns back. */
function mirrorShapes(shapes) {
  return shapes.map(s => s.map(r => reverse(r.map(q => [-q[0], q[1]]))));
}

function dropSpecks(shapes) {
  const out = [];
  for (const s of shapes) {
    if (!s.length || s[0].length < 3 || ringArea(s[0]) < MIN_RING_AREA) continue;
    out.push([s[0], ...s.slice(1).filter(r => r.length >= 3 && ringArea(r) >= MIN_RING_AREA)]);
  }
  return out;
}

function ringBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of ring) {
    if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Fold overlapping glyph outlines into disjoint shapes.
 *
 * Not cosmetic: an engraved caption hands these rings to the face triangulation
 * as holes, and two overlapping holes are not a polygon with holes — they are a
 * leak. Pairs are unioned only where their boxes touch, and glyphs that meet at
 * exactly one point (a run of monospace W's does) get a microscopic square
 * dropped on the contact so the result has a neck there rather than a pinch.
 */
function unionInk(shapes) {
  const kept = dropSpecks(shapes);
  if (kept.length < 2) return kept;
  const boxes = kept.map(s => ringBox(s[0]));
  const parent = kept.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const EPS = 2e-5;
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[2] < b[0] - EPS || b[2] < a[0] - EPS || a[3] < b[1] - EPS || b[3] < a[1] - EPS) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const groups = new Map();
  for (let i = 0; i < kept.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(kept[i]);
  }
  const out = [];
  for (const grp of groups.values()) {
    if (grp.length === 1) { out.push(grp[0]); continue; }
    let acc = [grp[0]];
    for (let i = 1; i < grp.length; i++) acc = dropSpecks(boolean(acc, [grp[i]], 'union'));
    for (const bridge of contactBridges(acc)) acc = dropSpecks(boolean(acc, [bridge], 'union'));
    for (const sh of acc) out.push(sh);
  }
  return out;
}

function contactBridges(shapes) {
  if (shapes.length < 2) return [];
  const EPS = 2e-5, HALF = 4e-3;
  const seen = new Map();
  const found = [];
  const claimed = new Set();
  for (let i = 0; i < shapes.length; i++) {
    for (const ring of shapes[i]) {
      for (const q of ring) {
        const k = `${Math.round(q[0] / EPS)},${Math.round(q[1] / EPS)}`;
        const owner = seen.get(k);
        if (owner === undefined) seen.set(k, i);
        else if (owner !== i && !claimed.has(k)) { claimed.add(k); found.push(q); }
      }
    }
  }
  return found.map(q => [ensureCCW(rect(HALF * 2, HALF * 2, { cx: q[0], cy: q[1] }))]);
}

/** Every ring of every shape, turned inside out — the form a face wants its holes in. */
function asHoleRings(shapes) {
  const rings = [];
  for (const s of shapes) for (const r of s) rings.push(reverse(r));
  return rings;
}

/**
 * Lay the caption out and decide how deep it goes.
 *
 * Returns `{ caption, blocked, band }`: `band` is the extra height the bottom
 * border needs and is what the panel grows by, `blocked` names the reason a
 * caption that was asked for could not be placed, and both are meaningful with
 * a null caption.
 */
function captionFor(p, o) {
  const none = (blocked) => ({ caption: null, blocked, band: 0 });
  const text = String(p.caption ?? '').trim();
  if (!text) return none(null);
  if (o.shape !== 'flat') return none('shape');
  if (!o.framed) return none('frame');
  const font = fontFor(p.captionFont);
  if (!font) return none('font');

  const style = CAP_STYLES.includes(p.captionStyle) ? p.captionStyle : 'raised';
  const capH = clamp(num(p.captionHeight, 8), 1.5, 40);
  const tol = clamp(0.03 / o.sf, 0.01, 0.08);
  let lay;
  try {
    lay = layoutText(font, text, {
      size: capH, align: 'center', vAlign: 'baseline', lineHeight: 1.3,
      maxWidth: Math.max(2, o.panelW - 2 * CAP_PAD), curveTolerance: tol, onMissing: 'skip',
    });
  } catch { return none('font'); }
  const box = lay.bbox;
  if (!(box.size[0] > 1e-6 && box.size[1] > 1e-6)) return none('ink');

  const band = Math.max(0, box.size[1] + 2 * CAP_PAD - o.frameW);
  const mid = o.z0 + (o.frameW + band) / 2;
  const dx = -box.center[0], dz = mid - box.center[1];
  let ink = unionInk(shiftShapes(lay.shapes, dx, dz));
  if (!ink.length) return none('ink');
  if (style === 'lit') ink = mirrorShapes(ink);

  // How far in, or out. Each style keeps its own number so that switching
  // between them does not silently reinterpret a depth as a height.
  const T = o.frameT;
  let out = 0, depth = 0, glow = 0, thinned = false;
  if (style === 'raised') {
    out = clamp(num(p.captionRelief, 0.8), 0.15, 6);
  } else if (style === 'engraved') {
    depth = Math.min(clamp(num(p.captionDepth, 0.6), 0.15, 8), Math.max(0.15, T - 0.4));
  } else {
    const want = clamp(num(p.captionGlow, 0.8), 0.2, 8);
    glow = Math.min(want, Math.max(0.15, T - 0.15));
    thinned = glow < want - 1e-9;
    depth = T - glow;
  }

  return {
    caption: {
      text, style, ink, band, mid, out, depth, glow, thinned,
      back: style === 'lit',
      capMm: lay.capHeight,
      baselineZ: lay.lines[0].y + dz,
      x0: box.min[0] + dx,
      fit: lay.fit,
      missing: lay.missing || [],
      lines: lay.lines.length,
    },
    blocked: null,
    band,
  };
}

// ---------------------------------------------------------------------------
// Tone mapping
//
// luma -> "light value" in 0..1 -> thickness. Three curves compose, and all
// three are chosen to fix the endpoints (0 stays 0, 1 stays 1) so that the
// auto-levels stretch that follows cannot undo them.
//
// That constraint is the reason `contrast` is an S-curve rather than the obvious
// gain-about-mid-grey. A linear gain followed by a stretch back to full range is
// the identity map for any gain below 1 — the control would appear to work,
// change the preview not at all, and quietly do nothing to the print. The S-curve
// is nonlinear in both directions, so raising and lowering contrast both survive
// the stretch.
// ---------------------------------------------------------------------------

/** Symmetric contrast curve. c=1 identity, c>1 an S, c<1 an inverse S. */
function sCurve(x, c) {
  if (!(c > 0) || !isFinite(c) || Math.abs(c - 1) < 1e-9) return x;
  return x < 0.5 ? 0.5 * Math.pow(2 * x, c) : 1 - 0.5 * Math.pow(2 - 2 * x, c);
}

/**
 * The tone curve, exported because it is the one piece of this generator worth
 * testing on its own and the one the UI wants to draw.
 * @param g luma 0..1  @returns light value 0..1 (0 = darkest = thickest)
 */
export function toneCurve(g, { invert = false, contrast = 1, gamma = 1 } = {}) {
  let x = num(g, 0.5);
  x = clamp(x, 0, 1);
  if (invert) x = 1 - x;
  x = clamp(sCurve(x, num(contrast, 1)), 0, 1);
  const gm = num(gamma, 1);
  if (gm > 0 && Math.abs(gm - 1) > 1e-9) x = Math.pow(x, 1 / gm);
  return clamp(x, 0, 1);
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

const FILTERS = {
  // The box is integrated over each source pixel rather than sampled at its
  // centre. Point-sampling a box kernel is the trap: at a scale of 1.78 source
  // pixels per output pixel it takes one whole pixel here and two there, which
  // is nearest-neighbour with extra steps and aliases a fine texture exactly the
  // way it aliases without a filter at all.
  box: { r: 0.5, area: true, f: (x) => (Math.abs(x) <= 0.5 ? 1 : 0) },
  triangle: { r: 1, f: (x) => { const a = Math.abs(x); return a < 1 ? 1 - a : 0; } },
  lanczos: {
    r: 3,
    f: (x) => {
      const a = Math.abs(x);
      if (a < 1e-8) return 1;
      if (a >= 3) return 0;
      const px = Math.PI * a;
      return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
    },
  },
};

/**
 * Per-output-sample source indices and weights for one axis.
 * The kernel widens by 1/scale when reducing — that is what makes this a real
 * resample rather than a point lookup, and it is the difference between a smooth
 * gradient and a staircase in the print.
 */
function weights1D(srcN, off, len, dstN, kind) {
  const F = FILTERS[kind] || FILTERS.lanczos;
  const scale = dstN / Math.max(len, 1e-9);
  const wide = scale < 1 ? 1 / scale : 1;
  const radius = F.r * wide;
  const rows = new Array(dstN);
  for (let i = 0; i < dstN; i++) {
    const centre = off + (i + 0.5) / scale - 0.5;
    // An integrated kernel reaches half a pixel further than a sampled one:
    // the pixel whose centre is outside the window can still overlap it.
    const edge = F.area ? 0.5 : 0;
    const lo = Math.ceil(centre - radius - edge), hi = Math.floor(centre + radius + edge);
    const idx = [], w = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const wt = F.area
        ? Math.max(0, Math.min(j + 0.5, centre + radius) - Math.max(j - 0.5, centre - radius))
        : F.f((j - centre) / wide);
      if (wt === 0) continue;
      idx.push(j < 0 ? 0 : (j >= srcN ? srcN - 1 : j));   // clamp to edge
      w.push(wt);
      sum += wt;
    }
    // Lanczos weights are signed, so a vanishing sum is possible in principle.
    // Falling back to the nearest sample is worse than filtering but infinitely
    // better than dividing by zero and extruding NaN.
    if (!idx.length || Math.abs(sum) < 1e-12) {
      const j = clamp(Math.round(centre), 0, srcN - 1);
      rows[i] = { idx: [j], w: [1] };
      continue;
    }
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    rows[i] = { idx, w };
  }
  return rows;
}

/** Integer box reduction of a cropped region — the cheap, exact pre-filter. */
function boxReduce(gray, w, h, x0, y0, cw, ch, k) {
  const nw = Math.max(1, Math.floor(cw / k)), nh = Math.max(1, Math.floor(ch / k));
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = y0 + y * k;
    for (let x = 0; x < nw; x++) {
      const sx0 = x0 + x * k;
      let s = 0, n = 0;
      for (let dy = 0; dy < k; dy++) {
        const sy = sy0 + dy;
        if (sy >= h) break;
        const row = sy * w;
        for (let dx = 0; dx < k; dx++) {
          const sx = sx0 + dx;
          if (sx >= w) break;
          s += gray[row + sx]; n++;
        }
      }
      out[y * nw + x] = n ? s / n : 0;
    }
  }
  return { w: nw, h: nh, gray: out };
}

/**
 * Crop then resample to exactly dstW x dstH. Row 0 of the result is the top of
 * the picture, as it is in every image format.
 */
function resampleGray(img, crop, dstW, dstH, kind) {
  let src = img;
  let ox = crop.x0, oy = crop.y0, cw = crop.w, ch = crop.h;
  const k = Math.max(1, Math.min(Math.floor(cw / dstW), Math.floor(ch / dstH)));
  if (k >= 2) {
    const ix0 = clamp(Math.round(ox), 0, img.w - 1);
    const iy0 = clamp(Math.round(oy), 0, img.h - 1);
    const icw = Math.min(img.w - ix0, Math.max(1, Math.round(cw)));
    const ich = Math.min(img.h - iy0, Math.max(1, Math.round(ch)));
    src = boxReduce(img.gray, img.w, img.h, ix0, iy0, icw, ich, k);
    ox = 0; oy = 0; cw = src.w; ch = src.h;
  }
  const wx = weights1D(src.w, ox, cw, dstW, kind);
  const wy = weights1D(src.h, oy, ch, dstH, kind);

  const tmp = new Float64Array(dstW * src.h);
  for (let y = 0; y < src.h; y++) {
    const row = y * src.w, orow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const { idx, w } = wx[x];
      let s = 0;
      for (let t = 0; t < idx.length; t++) s += src.gray[row + idx[t]] * w[t];
      tmp[orow + x] = s;
    }
  }
  const out = new Float64Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const { idx, w } = wy[y];
    const orow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      let s = 0;
      for (let t = 0; t < idx.length; t++) s += tmp[idx[t] * dstW + x] * w[t];
      out[orow + x] = s;
    }
  }
  return out;
}

/**
 * Whatever arrived from the file picker, reduced to {w, h, gray} in 0..1.
 * A missing or unreadable picture becomes null and the generator builds a plain
 * mid-grey plate rather than throwing — an empty panel is a useful thing to see
 * before you have chosen a photograph.
 */
function normImage(src) {
  if (!src || typeof src !== 'object') return null;
  const w = Math.floor(num(src.w, 0)), h = Math.floor(num(src.h, 0));
  const gray = src.gray || src.data;
  if (!(w >= 1 && h >= 1) || !gray || gray.length < w * h) return null;
  // 0..255 byte data is the commonest thing to be handed by mistake, and it maps
  // every pixel to full white after clamping — a blank plate with no error.
  let mx = 0;
  for (let i = 0; i < w * h; i++) { const v = gray[i]; if (v > mx) mx = v; }
  const k = mx > 1.5 ? 1 / 255 : 1;
  return { w, h, gray, scale: k };
}

function cropFor(img, aspect, anchor) {
  const srcAspect = img.w / img.h;
  let cw = img.w, ch = img.h;
  if (aspect > srcAspect) ch = img.w / aspect; else cw = img.h * aspect;
  cw = clamp(cw, 1, img.w);
  ch = clamp(ch, 1, img.h);
  let x0 = (img.w - cw) / 2, y0 = (img.h - ch) / 2;
  if (anchor === 'top') y0 = 0;
  else if (anchor === 'bottom') y0 = img.h - ch;
  else if (anchor === 'left') x0 = 0;
  else if (anchor === 'right') x0 = img.w - cw;
  return { x0, y0, w: cw, h: ch };
}

// ---------------------------------------------------------------------------
// solve — every derived number in one place
// ---------------------------------------------------------------------------

// One redrawn panel asks solve() three times — once to build, once to validate
// and once for the hints — and each of those resamples the photograph from
// scratch. A single-entry memo keyed on the scalar parameters plus the identity
// of the picture objects removes two of the three without changing what any of
// them return: solve is a pure function of exactly that key.
let memoKey = null, memoVal = null;
const imgIds = new WeakMap();
let nextImgId = 1;
function idOf(v) {
  if (!v || typeof v !== 'object') return String(v);
  let id = imgIds.get(v);
  if (id === undefined) { id = nextImgId++; imgIds.set(v, id); }
  return `#${id}`;
}
function keyOf(p, sf) {
  const parts = [sf];
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    parts.push(k, typeof v === 'object' && v !== null ? idOf(v) : String(v));
  }
  return parts.join('');
}

function solve(p, ctx = {}) {
  const sf = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const key = keyOf(p, sf);
  if (key === memoKey) return memoVal;
  const out = solveFresh(p, ctx, sf);
  memoKey = key; memoVal = out;
  return out;
}

function solveFresh(p, ctx, sf) {
  const shape = SHAPES.includes(p.shape) ? p.shape : 'flat';
  const curved = shape === 'arc-out' || shape === 'arc-in';
  const notes = [];

  // ---- tone range -----
  let minT = clamp(num(p.minThickness, 0.8), 0.2, 12);
  let maxT = clamp(num(p.maxThickness, 3.0), 0.3, 20);
  if (maxT < minT + 0.05) { maxT = minT + 0.05; notes.push('range'); }
  const tMid = (minT + maxT) / 2;

  // ---- frame -----
  const framed = p.frame !== false;
  let frameW = framed ? clamp(num(p.frameWidth, 7), 0.6, 60) : 0;
  let frameT = framed
    ? Math.max(clamp(num(p.frameThickness, 3.6), 0.5, 25), maxT)
    : maxT;
  const baseT = framed ? frameT : maxT;

  // ---- picture size -----
  const img = normImage(p.image);
  const fit = p.fit === 'crop' ? 'crop' : 'aspect';
  const anchor = ['centre', 'top', 'bottom', 'left', 'right'].includes(p.cropAnchor) ? p.cropAnchor : 'centre';

  let side = clamp(num(p.shadeSide, 70), 10, 200);
  if (shape === 'shade') {
    // The corner post is the inner square's corner, inset by frameT on both
    // axes — so it eats frameT of every side before the picture can start. A
    // border narrower than that would put the first picture sample *behind* the
    // corner and fold the inner wall through itself.
    frameT = Math.max(frameT, maxT);
    if (frameT > side / 2 - 2.4) { side = 2 * (frameT + 2.4); notes.push('shadeSide'); }
    frameW = clamp(Math.max(frameW, frameT + 0.6, SHADE_CORNER), frameT + 0.6, side / 2 - 1.5);
  }

  let W = shape === 'shade' ? Math.max(3, side - 2 * frameW) : clamp(num(p.imageWidth, 100), 5, 400);
  const srcAspect = img ? img.w / img.h : 1;
  let H;
  if (fit === 'crop') H = clamp(num(p.imageHeight, 75), 5, 400);
  else H = clamp(W / srcAspect, 3, 400);
  const crop = img ? cropFor(img, W / H, anchor) : null;
  const cropped = !!(crop && (crop.w < img.w - 0.5 || crop.h < img.h - 0.5));

  const panelW = W + 2 * frameW;
  let panelH = H + 2 * frameW;

  // ---- grid -----
  const pitchAsked = clamp(num(p.pixelPitch, 0.35), 0.08, 4);
  const pitch = pitchAsked / sf;
  let nu = clamp(Math.round(W / pitch), 2, 2400);
  let nv = clamp(Math.round(H / pitch), 2, 2400);

  // The budget is counted in triangles rather than in picture samples, because
  // the four shapes spend very different numbers of triangles on the same
  // picture — a ring loft tessellates its smooth back face at picture
  // resolution, a flat plate does not — and a cap expressed in samples would
  // silently mean four different things.
  const borders = (a, b) => {
    const nbu = frameW > 1e-6 ? Math.max(1, Math.round(frameW / (W / a))) : 0;
    const nbv = frameW > 1e-6 ? Math.max(1, Math.round(frameW / (H / b))) : 0;
    return { M: 2 * nbu + a + 1, L: 2 * nbv + b + 1 };
  };
  const estimate = (a, b) => {
    if (shape === 'flat') return 2 * a * b + 6 * (a + b) + 200;
    const { M, L } = borders(a, b);
    return (shape === 'shade' ? 8 : 4) * M * (L + 2) + 8 * M;
  };
  let capped = false;
  for (let pass = 0; pass < 4 && estimate(nu, nv) > MAX_TRIS; pass++) {
    const k = Math.sqrt(MAX_TRIS / estimate(nu, nv));
    nu = Math.max(2, Math.floor(nu * k));
    nv = Math.max(2, Math.floor(nv * k));
    capped = true;
  }
  const cellX = W / nu, cellY = H / nv;

  // ---- mirroring -----
  // A relief on the far side of the material reads mirror-reversed when you look
  // through it. The two shapes that put the picture inside are the two that need
  // flipping, and "auto" is the only default that is right more often than not.
  const mirrorMode = ['auto', 'on', 'off'].includes(p.mirror) ? p.mirror : 'auto';
  const mirror = mirrorMode === 'on' || (mirrorMode === 'auto' && (shape === 'arc-in' || shape === 'shade'));

  const filter = FILTERS[p.filter] ? p.filter : 'lanczos';

  // ---- the thickness grids (one per face) -----
  const opts = {
    nu, nv, W, H, minT, maxT, baseT, framed, filter, mirror, anchor,
    edgeFade: clamp(num(p.edgeFade, 1), 0, 40),
    invert: !!p.invert, contrast: num(p.contrast, 1), gamma: num(p.gamma, 1),
    stretch: p.levels !== 'as-is',
    guard: p.overhangGuard !== false,
  };
  const images = [p.image];
  if (shape === 'shade') images.push(p.image2 || p.image, p.image3 || p.image, p.image4 || p.image);
  // A shade with one photograph on all four faces is the common case, and
  // resampling a 12-megapixel file four times to reach the same grid is four
  // times the work for one answer.
  const seen = new Map();
  const grids = images.map((src) => {
    if (seen.has(src)) return seen.get(src);
    const g = gridFor(normImage(src), opts);
    seen.set(src, g);
    return g;
  });

  // ---- curvature -----
  const dir = shape === 'arc-in' ? -1 : 1;
  let radius = clamp(num(p.radius, 70), 5, 900);
  let radiusRaised = false;
  if (curved) {
    // The reference surface is the picture at its mean thickness: that is the
    // surface whose arc length the user asked for.
    const need = panelW / MAX_ARC;                 // smallest legal reference radius
    let refMin = need;
    if (dir < 0) refMin = Math.max(need, frameT + 1.5);  // and an inward relief must not reach the axis
    let ref = radius + dir * tMid;
    if (ref < refMin) { ref = refMin; radiusRaised = true; }
    radius = ref - dir * tMid;
    if (dir < 0) radius = Math.max(radius, frameT + tMid + 1.0);
  }
  const refR = radius + dir * tMid;
  const theta = curved ? panelW / refR : 0;

  // ---- foot -----
  let foot = !!p.foot && shape !== 'shade';
  let footH = clamp(num(p.footHeight, 5), 0.4, 40);
  let footD = clamp(num(p.footDepth, 6), 0.4, 40);
  if (curved) {
    // Radially the foot may not eat through to the axis on an inward relief, nor
    // past the axis on an outward one.
    const innerNow = dir > 0 ? radius : radius - frameT;
    footD = Math.min(footD, Math.max(0, innerNow - 1.0));
  }
  if (footD < 0.3 || footH < 0.3) foot = false;
  const footTaper = foot ? Math.min(footD, footH * 2) : 0;
  const z0 = foot ? footH + footTaper : 0;

  // ---- caption -----
  // After the foot, because the band is placed in absolute Z and the foot is
  // what Z = 0 means; before the hanger, which hangs off the top of a panel
  // whose height the band has just changed.
  const { caption, blocked: captionBlocked, band: capBand } = captionFor(p, {
    shape, framed, frameW, frameT, panelW, z0, sf,
  });
  panelH += capBand;

  // ---- hanger -----
  const hangerKind = ['none', 'teardrop', 'round', 'slot'].includes(p.hanger) ? p.hanger : 'teardrop';
  const hangerDia = clamp(num(p.hangerDia, 4), 1, 20);
  let hanger = null;
  let hangerBlocked = null;
  if (shape === 'flat' && hangerKind !== 'none') {
    if (!framed) hangerBlocked = 'frame';
    else {
      const ring = hangerRing(hangerKind, hangerDia / 2, Math.max(8, Math.round(16 * sf)));
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (const q of ring) {
        if (q[0] < mnx) mnx = q[0]; if (q[0] > mxx) mxx = q[0];
        if (q[1] < mny) mny = q[1]; if (q[1] > mxy) mxy = q[1];
      }
      const needW = (mxx - mnx) + 2 * HANGER_CLEAR;
      const needH = (mxy - mny) + 2 * HANGER_CLEAR;
      if (needW > panelW || needH > frameW) hangerBlocked = 'frameWidth';
      else {
        // Sit the hole's bounding box one clearance below the top of the frame;
        // the check above has already proved the other clearance fits underneath.
        const dz = (z0 + panelH) - HANGER_CLEAR - mxy;
        hanger = ring.map(q => [q[0], q[1] + dz]);
      }
    }
  }

  return {
    shape, curved, sf, notes,
    curveOpts: { invert: !!p.invert, contrast: num(p.contrast, 1), gamma: num(p.gamma, 1) },
    minT, maxT, tMid, framed, frameW, frameT, baseT,
    caption, captionBlocked, capBand,
    W, H, panelW, panelH, nu, nv, cellX, cellY, pitch: pitchAsked, capped, estTris: estimate(nu, nv),
    img, crop, cropped, srcAspect, fit, anchor, mirror, mirrorMode, filter,
    grids, grid: grids[0],
    dir, radius, refR, theta, side, radiusRaised,
    foot, footH, footD, footTaper, z0,
    hangerKind, hangerDia, hanger, hangerBlocked,
    guardOn: opts.guard,
  };
}

/**
 * One face's thickness grid, (nu+1) x (nv+1), row 0 at the BOTTOM of the object.
 *
 * The vertical flip is not cosmetic bookkeeping: image row 0 is the top of the
 * picture and object row 0 is its bottom, and a generator that forgets prints
 * every photograph upside down while every mesh check still passes.
 */
function gridFor(img, o) {
  const { nu, nv, W, H, minT, maxT, baseT, framed, filter, mirror } = o;
  const dw = nu + 1, dh = nv + 1;

  let lum;
  if (!img) {
    lum = new Float64Array(dw * dh).fill(0.5);
  } else {
    const crop = cropFor(img, W / H, o.anchor);
    lum = resampleGray(img, crop, dw, dh, filter);
    if (img.scale !== 1) for (let i = 0; i < lum.length; i++) lum[i] *= img.scale;
  }

  const tone = new Float64Array(dw * dh);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < lum.length; i++) {
    const v = toneCurve(lum[i], o);
    tone[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  // A single-colour photograph has no span to stretch. Dividing by it is exactly
  // how a lithophane generator produces a mesh full of NaN; the guard is why this
  // one produces a flat plate instead.
  const uniform = !(span > SPAN_EPS);
  const stretch = o.stretch && !uniform;

  const t = new Float64Array(dw * dh);
  const range = maxT - minT;
  for (let j = 0; j <= nv; j++) {
    const srcRow = (nv - j) * dw;
    const dstRow = j * dw;
    for (let i = 0; i <= nu; i++) {
      let v = tone[srcRow + (mirror ? nu - i : i)];
      if (stretch) v = (v - lo) / span;
      v = clamp(v, 0, 1);
      t[dstRow + i] = maxT - v * range;       // dark (v=0) -> maxT, light (v=1) -> minT
    }
  }

  const fade = o.edgeFade;
  if (fade > 1e-6) {
    const dx = W / nu, dy = H / nv;
    for (let j = 0; j <= nv; j++) {
      const dj = Math.min(j * dy, (nv - j) * dy);
      const row = j * dw;
      for (let i = 0; i <= nu; i++) {
        const d = Math.min(dj, i * dx, (nu - i) * dx);
        if (d >= fade) continue;
        const f = smooth(d / fade);
        t[row + i] = baseT + (t[row + i] - baseT) * f;
      }
    }
  }
  if (framed) {
    // The outermost grid line must sit exactly on the frame's inner face or the
    // two surfaces do not meet and the solid has a slot in it. Pinning is not a
    // substitute for the fade — it is what makes edgeFade = 0 still watertight.
    for (let i = 0; i <= nu; i++) { t[i] = baseT; t[nv * dw + i] = baseT; }
    for (let j = 0; j <= nv; j++) { t[j * dw] = baseT; t[j * dw + nu] = baseT; }
  }

  // Worst upward rise, measured before the guard so the report is about the
  // picture rather than about the correction. Measured after the pin, because
  // the step from the last picture row into the frame is a real overhang too.
  const dz = H / nv;
  let worstRise = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const r = (t[(j + 1) * dw + i] - t[j * dw + i]) / dz;
      if (r > worstRise) worstRise = r;
    }
  }
  // Relax downward: material is ADDED to the row below a step, never taken from
  // the row above it, so the correction darkens a highlight slightly instead of
  // eating the detail that made the step interesting.
  let guarded = 0;
  if (o.guard) {
    const maxStep = MAX_RISE * dz;
    for (let j = nv - 1; j >= 0; j--) {
      const row = j * dw, above = (j + 1) * dw;
      for (let i = 0; i <= nu; i++) {
        const floorT = t[above + i] - maxStep;
        if (t[row + i] < floorT) { t[row + i] = floorT; guarded++; }
      }
    }
  }
  return { t, nu, nv, uniform, lo, hi, worstRise, guarded,
           srcW: img ? img.w : 0, srcH: img ? img.h : 0 };
}

/**
 * The thickness field on its own — the mapping without the geometry. Exported so
 * the mapping can be tested and previewed without building a mesh.
 */
export function thicknessMap(p, ctx = {}) {
  const g = solve(p, ctx);
  return {
    nu: g.nu, nv: g.nv, t: g.grid.t, minT: g.minT, maxT: g.maxT,
    uniform: g.grid.uniform, srcW: g.grid.srcW, srcH: g.grid.srcH,
    W: g.W, H: g.H, mirror: g.mirror,
  };
}

// ---------------------------------------------------------------------------
// Hanger outlines
// ---------------------------------------------------------------------------

/**
 * A hole through a plate that is printed standing up is a horizontal hole, and
 * its ceiling is an overhang. The teardrop replaces that ceiling with a pair of
 * 45 degree faces, which is why it is the default: a 4 mm round hole will bridge,
 * an 8 mm one droops, and the teardrop never cares.
 */
function hangerRing(kind, r, segs) {
  const n = Math.max(8, segs);
  if (kind === 'round') return circle(r, { segs: n * 2 });
  if (kind === 'slot') {
    const len = Math.max(2 * r + 0.2, r * 4);
    return slot(len, r, { segs: n });
  }
  const out = [];
  const a0 = Math.PI / 4, sweep = TAU * 0.75;
  for (let k = 0; k <= n; k++) {
    const a = a0 + sweep * (k / n);
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  out.push([0, r * Math.SQRT2]);
  return out;
}

// ---------------------------------------------------------------------------
// Mesh helpers
// ---------------------------------------------------------------------------

/** Triangulate a planar shape and place it with `map`, flipping if asked. */
function planarFace(m, shape, map, flip) {
  const { points, tris } = triangulate(shape);
  const base = m.vertCount;
  for (const q of points) { const v = map(q[0], q[1]); m.addVertex(v[0], v[1], v[2]); }
  for (let i = 0; i < tris.length; i += 3) {
    if (flip) m.addTri(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    else m.addTri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
  }
}

/** Quad strip between two index rings of equal length, closed. */
function loftRing(m, lower, upper) {
  const n = lower.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    m.addQuad(lower[i], lower[j], upper[j], upper[i]);
  }
}

function addRing2D(m, ring, z) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return out;
}

/** The picture window's boundary, counter-clockwise in the (x, z) plane. */
function windowRing(g, zi0) {
  const { nu, nv, W, H } = g;
  const xAt = (i) => -W / 2 + W * i / nu;
  const zAt = (j) => zi0 + H * j / nv;
  const out = [];
  for (let i = 0; i < nu; i++) out.push([xAt(i), zi0]);
  for (let j = 0; j < nv; j++) out.push([xAt(nu), zAt(j)]);
  for (let i = nu; i > 0; i--) out.push([xAt(i), zAt(nv)]);
  for (let j = nv; j > 0; j--) out.push([xAt(0), zAt(j)]);
  return out;
}

// ---------------------------------------------------------------------------
// flat — a plate that stands on its bottom edge
// ---------------------------------------------------------------------------

function buildFlat(g) {
  let m = new Mesh();
  const { nu, nv, W, H, panelW, panelH, framed, frameW, frameT, baseT, z0, capBand } = g;
  const t = g.grid.t, dw = nu + 1;
  const zi0 = z0 + frameW + capBand, zi1 = zi0 + H;
  const zp1 = z0 + panelH;
  const xAt = (i) => -W / 2 + W * i / nu;
  const zAt = (j) => zi0 + H * j / nv;

  // ---- the relief itself -------------------------------------------------
  const G = new Int32Array(dw * (nv + 1));
  for (let j = 0; j <= nv; j++) {
    const z = zAt(j), row = j * dw;
    for (let i = 0; i <= nu; i++) G[row + i] = m.addVertex(xAt(i), t[row + i], z);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = G[j * dw + i], b = G[j * dw + i + 1];
      const c = G[(j + 1) * dw + i + 1], d = G[(j + 1) * dw + i];
      const ta = t[j * dw + i], tb = t[j * dw + i + 1];
      const tc = t[(j + 1) * dw + i + 1], td = t[(j + 1) * dw + i];
      // Split each cell along its flatter diagonal, so a ridge running corner to
      // corner is not stepped by the triangulation.
      if (Math.abs(ta - tc) <= Math.abs(tb - td)) { m.addTri(a, d, c); m.addTri(a, c, b); }
      else { m.addTri(a, d, b); m.addTri(d, c, b); }
    }
  }

  const win = windowRing(g, zi0);
  const bottomRing = [];      // (x, y) at z = z0, counter-clockwise, for the foot

  if (framed) {
    const outer = rect(panelW, panelH, { cx: 0, cy: z0 + panelH / 2 });
    const holes = [reverse(win)];
    if (g.hanger) holes.push(reverse(g.hanger));

    // A pocketed caption is a hole in one of the two faces, and a letter's
    // counter is an island inside that hole. Two levels of nesting is one more
    // than triangulate() takes, so the whole pile of rings goes through
    // contoursToShapes() — which sorts parents from children and hands back
    // shapes that are each a legal [outer, ...holes] — and every shape is
    // capped on its own.
    const cap = g.caption;
    const onFront = !!(cap && !cap.back);   // raised, or engraved
    const onBack = !!(cap && cap.back);     // lit
    const backShapes = contoursToShapes(
      [outer, ...holes.slice(1), ...(onBack ? asHoleRings(cap.ink) : [])], { minArea: 0 });
    const frontShapes = contoursToShapes(
      [outer, ...holes, ...(onFront ? asHoleRings(cap.ink) : [])], { minArea: 0 });
    // back, normal -Y
    for (const sh of backShapes) planarFace(m, sh, (a, b) => [a, 0, b], false);
    // front frame, normal +Y
    for (const sh of frontShapes) planarFace(m, sh, (a, b) => [a, frameT, b], true);
    if (cap) {
      // Raised letters are cut out of the face and lofted up from the hole they
      // leave, rather than stood on top of it as their own solids. Two solids
      // meeting on a plane slice perfectly well, but they are two solids: the
      // inspector counts fifteen loose pieces for "Happy Birthday" and is right
      // to. Lofting from the face costs nothing and gives one object.
      //
      // The only difference between a letter and a pocket is which side of the
      // ring the material is on, which is the ring's direction: as it comes for
      // a letter, turned inside out for a pocket — the same way the hanger hole
      // is built two dozen lines above.
      const up = cap.out > 0;
      // The face the letters start from, and the plane they end on. Written as
      // a pair rather than as a low and a high, because "which end is the far
      // one" is the question the lit style answers differently from the other
      // two — its pocket runs forward from the back face, not back from the
      // front — and a min/max pair silently gets that wrong.
      const yFace = cap.back ? 0 : frameT;
      const yFar = cap.back ? cap.depth : (up ? frameT + cap.out : frameT - cap.depth);
      const yLo = Math.min(yFace, yFar), yHi = Math.max(yFace, yFar);
      const rings = up ? cap.ink.flatMap(sh => sh) : asHoleRings(cap.ink);
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const j = (i + 1) % r.length;
          const a0 = m.addVertex(r[i][0], yLo, r[i][1]), a1 = m.addVertex(r[i][0], yHi, r[i][1]);
          const b1 = m.addVertex(r[j][0], yHi, r[j][1]), b0 = m.addVertex(r[j][0], yLo, r[j][1]);
          m.addQuad(a0, a1, b1, b0);
        }
      }
      // The far end of the letters — a top or a floor — looks out the same way
      // as the face they were cut into.
      for (const sh of cap.ink) planarFace(m, sh, (a, b) => [a, yFar, b], onFront);
    }
    // outer wall — the bottom segment is left open when a foot follows
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const qa = outer[i], qb = outer[j];
      if (g.foot && Math.abs(qa[1] - z0) < 1e-9 && Math.abs(qb[1] - z0) < 1e-9) continue;
      const a0 = m.addVertex(qa[0], 0, qa[1]), a1 = m.addVertex(qa[0], frameT, qa[1]);
      const b1 = m.addVertex(qb[0], frameT, qb[1]), b0 = m.addVertex(qb[0], 0, qb[1]);
      m.addQuad(a0, a1, b1, b0);
    }
    if (g.hanger) {
      const hc = reverse(g.hanger);
      for (let i = 0; i < hc.length; i++) {
        const j = (i + 1) % hc.length;
        const a0 = m.addVertex(hc[i][0], 0, hc[i][1]), a1 = m.addVertex(hc[i][0], frameT, hc[i][1]);
        const b1 = m.addVertex(hc[j][0], frameT, hc[j][1]), b0 = m.addVertex(hc[j][0], 0, hc[j][1]);
        m.addQuad(a0, a1, b1, b0);
      }
    }
    if (g.foot) {
      bottomRing.push([-panelW / 2, 0], [panelW / 2, 0], [panelW / 2, frameT], [-panelW / 2, frameT]);
    }
  } else {
    // No frame: the picture's own edge is the object's edge.
    const centre = m.addVertex(0, 0, (zi0 + zi1) / 2);
    const backIdx = win.map(q => m.addVertex(q[0], 0, q[1]));
    // The whole back face stays, foot or no foot. Only the *bottom edge strip*
    // below is the panel's bottom face and the only thing a plinth replaces —
    // taking the fan's bottom wedge out as well removes a triangle of the back
    // of the picture and opens a hole the size of the plate.
    for (let i = 0; i < win.length; i++) m.addTri(centre, backIdx[i], backIdx[(i + 1) % win.length]);
    // The relief border, in the same order as `win`.
    const front = [];
    for (let i = 0; i < nu; i++) front.push(G[i]);
    for (let j = 0; j < nv; j++) front.push(G[j * dw + nu]);
    for (let i = nu; i > 0; i--) front.push(G[nv * dw + i]);
    for (let j = nv; j > 0; j--) front.push(G[j * dw]);
    for (let i = 0; i < win.length; i++) {
      const j = (i + 1) % win.length;
      if (g.foot && Math.abs(win[i][1] - zi0) < 1e-9 && Math.abs(win[j][1] - zi0) < 1e-9) continue;
      m.addQuad(backIdx[i], front[i], front[j], backIdx[j]);
    }
    if (g.foot) {
      for (let i = 0; i <= nu; i++) bottomRing.push([xAt(i), 0]);
      for (let i = nu; i >= 0; i--) bottomRing.push([xAt(i), t[i]]);
    }
  }

  if (g.foot) addFoot(m, bottomRing, bottomRing.map(q => [0, q[1] > 1e-9 ? 1 : -1]), g);

  if (g.caption) {
    // A pocketed caption puts the letters and the picture window into the same
    // face triangulation, and poly2d.triangulate() bridges its holes by running
    // a seam between them — a seam that can land a vertex partway along an edge
    // the pocket walls also use. That is a T-junction, and a T-junction is a
    // leak: 412 boundary edges on "With love" in the narrow face while the same
    // words in the rounded one were watertight, which is exactly the kind of
    // defect that ships because the preset you looked at happened to be fine.
    // The kernel has the fix; the QR plaque calls it for the same reason.
    m = m.weld(1e-7).healTJunctions();
  }

  return m;
}

/**
 * The plinth. A ring is lofted downward from the object's bottom section, first
 * out to the full foot depth over a 45 degree taper and then straight down. The
 * taper is the point: every layer of it is strictly inside the one below, so the
 * whole plinth is self-supporting and the shelf that a square foot would leave
 * does not exist.
 */
function addFoot(m, ring, outward, g) {
  const wide = ring.map((q, i) => [q[0] + outward[i][0] * g.footD, q[1] + outward[i][1] * g.footD]);
  const top = addRing2D(m, ring, g.z0);
  const mid = addRing2D(m, wide, g.footH);
  const bot = addRing2D(m, wide, 0);
  loftRing(m, mid, top);
  loftRing(m, bot, mid);
  planarFace(m, [wide], (a, b) => [a, b, 0], true);
}

// ---------------------------------------------------------------------------
// arc — a cylindrical section
// ---------------------------------------------------------------------------

/** Sample positions along the panel surface, and which picture column each is. */
function panelSamples(g) {
  const { nu, W, frameW } = g;
  const pos = [], col = [];
  const pitch = Math.max(g.cellX, 1e-6);
  const nb = frameW > 1e-6 ? Math.max(1, Math.round(frameW / pitch)) : 0;
  for (let k = 0; k < nb; k++) { pos.push(frameW * k / nb); col.push(-1); }
  for (let i = 0; i <= nu; i++) { pos.push(frameW + W * i / nu); col.push(i); }
  for (let k = 1; k <= nb; k++) { pos.push(frameW + W + frameW * k / nb); col.push(-1); }
  return { pos, col, nb };
}

/** Level heights, and which picture row each is. */
function panelLevels(g) {
  const { nv, H, frameW, z0 } = g;
  const out = [];
  const pitch = Math.max(g.cellY, 1e-6);
  const nb = frameW > 1e-6 ? Math.max(1, Math.round(frameW / pitch)) : 0;
  for (let k = 0; k < nb; k++) out.push({ z: z0 + frameW * k / nb, row: -1 });
  for (let j = 0; j <= nv; j++) out.push({ z: z0 + frameW + H * j / nv, row: j });
  for (let k = 1; k <= nb; k++) out.push({ z: z0 + frameW + H + frameW * k / nb, row: -1 });
  return out;
}

function buildArc(g) {
  const m = new Mesh();
  const { nu, dir, radius, theta, baseT } = g;
  const t = g.grid.t, dw = nu + 1;
  const { pos, col } = panelSamples(g);
  const M = pos.length;
  const a0 = -theta / 2;
  const arcLen = g.panelW;

  const tAt = (k, row) => (row < 0 || col[k] < 0 ? baseT : t[row * dw + col[k]]);

  const ringAt = (row, expand) => {
    const ring = new Array(2 * M);
    for (let k = 0; k < M; k++) {
      const a = a0 + theta * (pos[k] / arcLen);
      const th = tAt(k, row);
      let rOut = dir > 0 ? radius + th : radius;
      let rIn = dir > 0 ? radius : radius - th;
      rOut += expand; rIn -= expand;
      const ca = Math.cos(a), sa = Math.sin(a);
      ring[k] = [rOut * ca, rOut * sa];
      ring[2 * M - 1 - k] = [rIn * ca, rIn * sa];
    }
    return ring;
  };

  const levels = panelLevels(g);
  const stack = [];
  if (g.foot) {
    stack.push({ z: 0, ring: ringAt(-1, g.footD) });
    stack.push({ z: g.footH, ring: ringAt(-1, g.footD) });
    // The taper lands exactly on the panel's own first section, so the two rings
    // are the same ring and no seam exists between plinth and panel.
    stack.push({ z: g.z0, ring: ringAt(levels[0].row, 0) });
    for (let i = 1; i < levels.length; i++) stack.push({ z: levels[i].z, ring: ringAt(levels[i].row, 0) });
  } else {
    for (const lv of levels) stack.push({ z: lv.z, ring: ringAt(lv.row, 0) });
  }

  let prev = null;
  for (let s = 0; s < stack.length; s++) {
    const idx = addRing2D(m, stack[s].ring, stack[s].z);
    if (prev) loftRing(m, prev, idx);
    else planarFace(m, [stack[s].ring], (a, b) => [a, b, stack[s].z], true);
    prev = idx;
  }
  const last = stack[stack.length - 1];
  planarFace(m, [last.ring], (a, b) => [a, b, last.z], false);
  return m;
}

// ---------------------------------------------------------------------------
// shade — a four-sided lamp, pictures on the inside
// ---------------------------------------------------------------------------

const SIDES = [
  { o: [-1, -1], d: [1, 0], n: [0, 1] },
  { o: [1, -1], d: [0, 1], n: [-1, 0] },
  { o: [1, 1], d: [-1, 0], n: [0, -1] },
  { o: [-1, 1], d: [0, -1], n: [1, 0] },
];

function buildShade(g) {
  const m = new Mesh();
  const { nu, side, frameT, baseT } = g;
  const a = side / 2;
  const dw = nu + 1;
  const { pos, col } = panelSamples(g);
  const M = pos.length;                 // pos[M-1] === side, which is the next corner
  const levels = panelLevels(g);

  // Which side samples clear the corner posts. The post is the inner square's
  // own corner — inset frameT along both axes — so a sample nearer the corner
  // than frameT lies *behind* it and folds the inner wall through itself.
  const keep = [];
  for (let k = 0; k < M - 1; k++) if (pos[k] > frameT + 1e-9 && pos[k] < side - frameT - 1e-9) keep.push(k);

  const innerRing = (row) => {
    const ring = [];
    for (let s = 0; s < 4; s++) {
      const S = SIDES[s], t = g.grids[s].t;
      const ox = S.o[0] * a, oy = S.o[1] * a;
      ring.push([ox + frameT * (S.d[0] + S.n[0]), oy + frameT * (S.d[1] + S.n[1])]);
      for (const k of keep) {
        const th = (row < 0 || col[k] < 0) ? baseT : t[row * dw + col[k]];
        ring.push([ox + S.d[0] * pos[k] + S.n[0] * th, oy + S.d[1] * pos[k] + S.n[1] * th]);
      }
    }
    return ring;
  };

  const zBot = levels[0].z, zTop = levels[levels.length - 1].z;
  const outer = rect(side, side);

  // The outside of a lamp shade is four flat panels. Tessellating it at picture
  // resolution would double the mesh to describe a plane, so it gets four quads
  // and the rims are triangulated against the inner ring instead.
  const oBot = addRing2D(m, outer, zBot);
  const oTop = addRing2D(m, outer, zTop);
  loftRing(m, oBot, oTop);

  let prev = null, firstRing = null, lastRing = null;
  for (const lv of levels) {
    const ring = innerRing(lv.row);
    const idx = addRing2D(m, ring, lv.z);
    if (prev) {
      const n = idx.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        m.addQuad(idx[i], idx[j], prev[j], prev[i]);   // reversed: faces the cavity
      }
    } else firstRing = ring;
    prev = idx;
    lastRing = ring;
  }
  planarFace(m, [outer, reverse(firstRing)], (x, y) => [x, y, zBot], true);
  planarFace(m, [outer, reverse(lastRing)], (x, y) => [x, y, zTop], false);
  return m;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const g = solve(p, ctx);
  let m;
  if (g.shape === 'shade') m = buildShade(g);
  else if (g.curved) m = buildArc(g);
  else m = buildFlat(g);

  m = m.weld(1e-7);
  const b = m.bbox();
  const off = [-b.center[0], -b.center[1], -b.min[2]];
  const mesh = m.translate(off[0], off[1], off[2]);

  const dims = [];
  if (g.shape === 'flat') {
    const zi0 = g.z0 + g.frameW + g.capBand;
    dims.push({ param: 'imageWidth', label: 'picture',
      from: [-g.W / 2 + off[0], g.baseT + off[1], zi0 + off[2]],
      to: [g.W / 2 + off[0], g.baseT + off[1], zi0 + off[2]], offset: 8 });
    dims.push({ param: 'maxThickness', label: 'max',
      from: [off[0], off[1], g.z0 + off[2]],
      to: [off[0], g.maxT + off[1], g.z0 + off[2]], offset: 6 });
    if (g.caption) {
      // The cap height as built, not as asked for: a message too wide for the
      // panel is shrunk to fit, and a callout that reported the request would
      // be the one number on the drawing that is not what the object measures.
      const c = g.caption;
      const y = (c.back ? 0 : g.frameT + c.out) + off[1];
      dims.push({ param: 'captionHeight', label: 'text',
        value: Math.round(c.capMm * 100) / 100, unit: 'mm',
        from: [c.x0 + off[0], y, c.baselineZ + off[2]],
        to: [c.x0 + off[0], y, c.baselineZ + c.capMm + off[2]], offset: 6 });
    }
  } else if (g.curved) {
    dims.push({ param: 'radius', label: 'R',
      from: [off[0], off[1], g.z0 + g.panelH / 2 + off[2]],
      to: [g.radius * Math.cos(-g.theta / 2) + off[0], g.radius * Math.sin(-g.theta / 2) + off[1], g.z0 + g.panelH / 2 + off[2]],
      offset: 4 });
  } else {
    const a = g.side / 2, zt = g.panelH;
    dims.push({ param: 'shadeSide', label: '',
      from: [-a + off[0], -a + off[1], zt + off[2]], to: [a + off[0], -a + off[1], zt + off[2]], offset: 8 });
  }

  return {
    mesh,
    meta: {
      dims,
      grid: { nu: g.nu, nv: g.nv, cells: g.nu * g.nv, capped: g.capped },
      picture: { widthMM: g.W, heightMM: g.H, pitchMM: Math.max(g.cellX, g.cellY),
                 srcW: g.grid.srcW, srcH: g.grid.srcH, cropped: g.cropped,
                 mirrored: g.mirror, flat: g.grid.uniform },
      mapping: mappingCurve(g),
      // Arc length, measured on the surface the picture lives on. The panel is
      // the picture plus its two frame borders, so the two differ by 2*frameW
      // and reporting only one of them is how a 7 mm border goes missing.
      arc: {
        pictureMM: g.curved ? g.theta * g.refR * (g.W / g.panelW) : g.W,
        panelMM: g.curved ? g.theta * g.refR : g.panelW,
        includedAngleDeg: g.curved ? g.theta / DEG : 0,
        referenceRadiusMM: g.curved ? g.refR : 0,
      },
      relief: { worstRisePerMM: g.grid.worstRise, guardOn: g.guardOn,
                samplesRamped: g.guardOn ? g.grid.guarded : 0, maxRisePerMM: MAX_RISE },
      caption: g.caption ? {
        text: g.caption.text, style: g.caption.style, lines: g.caption.lines,
        capHeightMM: g.caption.capMm, shrunkTo: g.caption.fit,
        bandMM: g.frameW + g.caption.band,
        reliefMM: g.caption.out, depthMM: g.caption.depth, remainingMM: g.caption.glow,
        missing: g.caption.missing,
      } : null,
    },
  };
}

/** 21 samples of luma -> thickness, for the panel's curve preview. */
function mappingCurve(g) {
  const out = [];
  for (let k = 0; k <= 20; k++) {
    const lum = k / 20;
    const v = toneCurve(lum, g.curveOpts || {});
    out.push([lum, g.maxT - v * (g.maxT - g.minT)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

const params = [
  { key: 'image', label: 'Photograph', type: 'image', group: 'Picture',
    help: 'Any picture. It is converted to brightness; dark areas become thick and block the light.' },
  { key: 'fit', label: 'Fit', type: 'enum', def: 'aspect', group: 'Picture',
    options: [
      { v: 'aspect', label: 'Keep the aspect', help: 'Height follows from the width and the picture. Nothing is cropped.' },
      { v: 'crop', label: 'Crop to size', help: 'Both width and height are yours; the picture is cropped to fit them.' },
    ],
    help: 'There is deliberately no "stretch". A stretched face is worse than a cropped one and you cannot un-print it.' },
  { key: 'cropAnchor', label: 'Crop from', type: 'enum', def: 'centre', group: 'Picture',
    options: [
      { v: 'centre', label: 'Centre' }, { v: 'top', label: 'Top' }, { v: 'bottom', label: 'Bottom' },
      { v: 'left', label: 'Left' }, { v: 'right', label: 'Right' },
    ],
    showIf: (p) => p.fit === 'crop',
    help: 'Which part of the picture survives the crop. Faces are usually near the top.' },
  { key: 'filter', label: 'Resample', type: 'enum', def: 'lanczos', group: 'Picture',
    options: [
      { v: 'lanczos', label: 'Lanczos (sharp)', help: 'Best for photographs. Slight edge sharpening, which suits a soft relief.' },
      { v: 'box', label: 'Box (soft)', help: 'A true area average — the correct filter for reducing a photograph, and no ringing. Deliberately blocky if you enlarge a small one.' },
      { v: 'triangle', label: 'Bilinear', help: 'Between the two.' },
    ],
    help: 'How the photograph is reduced to the print grid. All three are real filters; none of them point-sample.' },
  { key: 'mirror', label: 'Mirror', type: 'enum', def: 'auto', group: 'Picture',
    options: [
      { v: 'auto', label: 'Automatic', help: 'Flipped for the shapes whose relief faces away from you.' },
      { v: 'off', label: 'Never' }, { v: 'on', label: 'Always' },
    ],
    help: 'A relief seen through the material reads back to front. Lamps and shades need the flip; a plate you look straight at does not.' },

  { key: 'minThickness', label: 'Thinnest', type: 'number', unit: 'mm', group: 'Tone',
    min: 0.4, max: 1.6, step: 0.05, def: 0.8,
    help: 'The white point. Under about 0.6 mm there are not two extrusions left to hold it together.' },
  { key: 'maxThickness', label: 'Thickest', type: 'number', unit: 'mm', group: 'Tone',
    min: 1.6, max: 6, step: 0.1, def: 3,
    help: 'The black point. Past about 3.5 mm the darks are already opaque and you are only buying print time.' },
  { key: 'gamma', label: 'Gamma', type: 'number', group: 'Tone',
    min: 0.3, max: 3, step: 0.05, def: 1,
    help: 'Above 1 lifts the midtones (a brighter, thinner picture); below 1 deepens them. The black and white points do not move.' },
  { key: 'contrast', label: 'Contrast', type: 'number', group: 'Tone',
    min: 0.3, max: 3, step: 0.05, def: 1,
    help: 'An S-curve about mid grey. Above 1 separates the midtones, below 1 flattens them.' },
  { key: 'levels', label: 'Levels', type: 'enum', def: 'stretch', group: 'Tone',
    options: [
      { v: 'stretch', label: 'Use the full range', help: 'The darkest pixel becomes the thickest point and the brightest the thinnest.' },
      { v: 'as-is', label: 'As shot', help: 'Brightness maps straight to thickness. A flat photograph stays flat.' },
    ],
    help: 'Auto-levels. Stretching is almost always right: unused thickness is unused contrast.' },
  { key: 'invert', label: 'Negative', type: 'bool', def: false, group: 'Tone',
    help: 'Light becomes thick. Only for printing from a scanned film negative.' },
  { key: 'overhangGuard', label: 'Limit steep steps', type: 'bool', def: true, group: 'Tone',
    help: 'A hard horizontal edge — a dark sky over a bright horizon — is a step outward as the print rises, and the perimeter above it is laid over nothing. This ramps such a step over about half a millimetre by adding material below it, which darkens the highlight a little and stops the edge drooping.' },

  { key: 'shape', label: 'Shape', type: 'enum', def: 'flat', group: 'Shape',
    options: [
      { v: 'flat', label: 'Flat plate', help: 'Hangs in a window or slots into a stand. Prints standing on its bottom edge.' },
      { v: 'arc-out', label: 'Curved outward', help: 'A cylindrical section with the picture on the outside. Stands up on its own and does not warp.' },
      { v: 'arc-in', label: 'Curved inward (lamp)', help: 'The picture is on the concave face, protected, with the lamp behind it.' },
      { v: 'shade', label: 'Four-sided shade', help: 'A square lamp shade with a picture on each face.' },
    ],
    help: 'A curved lithophane is stiffer, self-supporting and much harder to warp off the bed than a flat one.' },
  { key: 'imageWidth', label: 'Picture width', type: 'number', unit: 'mm', group: 'Shape',
    min: 20, max: 170, step: 1, def: 100,
    showIf: (p) => p.shape !== 'shade',
    help: 'Measured along the surface, so a curved picture is this wide when you unroll it — not across the chord.' },
  { key: 'imageHeight', label: 'Picture height', type: 'number', unit: 'mm', group: 'Shape',
    min: 20, max: 170, step: 1, def: 75,
    showIf: (p) => p.fit === 'crop',
    help: 'Only used when cropping. Otherwise the height follows the photograph.' },
  { key: 'radius', label: 'Radius', type: 'number', unit: 'mm', group: 'Shape',
    min: 20, max: 300, step: 1, def: 70,
    showIf: (p) => p.shape === 'arc-out' || p.shape === 'arc-in',
    help: 'Of the smooth face. Small radius, tight curl: 60-80 mm suits a 100 mm picture.' },
  { key: 'shadeSide', label: 'Shade side', type: 'number', unit: 'mm', group: 'Shape',
    min: 40, max: 130, step: 1, def: 70,
    showIf: (p) => p.shape === 'shade',
    help: 'Outside width of the square. It has to clear whatever light goes inside it.' },
  { key: 'pixelPitch', label: 'Pixel pitch', type: 'number', unit: 'mm', group: 'Shape',
    min: 0.15, max: 1.2, step: 0.05, def: 0.35,
    help: 'One relief sample per this many millimetres. Below about 0.3 mm the nozzle cannot resolve it and you are only paying in triangles.' },

  { key: 'frame', label: 'Frame', type: 'bool', def: true, group: 'Frame & mounting',
    help: 'A solid border around the picture. It stiffens the panel, hides the edge and gives the hanger somewhere to live.' },
  { key: 'frameWidth', label: 'Frame width', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 1, max: 15, step: 0.5, def: 7, showIf: (p) => p.frame !== false,
    help: 'A hanger hole needs its own height plus 2 mm of frame to sit in — a 4 mm teardrop wants about 7 mm.' },
  { key: 'frameThickness', label: 'Frame thickness', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 1.6, max: 8, step: 0.2, def: 3.6, showIf: (p) => p.frame !== false,
    help: 'Never less than the thickest part of the picture — it is raised to match if you ask for less.' },
  { key: 'edgeFade', label: 'Edge fade', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 0, max: 6, step: 0.2, def: 1,
    help: 'The picture ramps to full thickness this far in from its border, so it meets the frame in shadow instead of at a step.' },
  { key: 'hanger', label: 'Hanger hole', type: 'enum', def: 'teardrop', group: 'Frame & mounting',
    options: [
      { v: 'none', label: 'None' },
      { v: 'teardrop', label: 'Teardrop', help: 'A round hole with a 45 degree roof. Prints without support at any size.' },
      { v: 'round', label: 'Round', help: 'Fine up to about 5 mm; bigger than that the ceiling droops.' },
      { v: 'slot', label: 'Slot', help: 'Horizontal, so you can slide it level on the nail.' },
    ],
    showIf: (p) => (p.shape || 'flat') === 'flat' && p.frame !== false,
    help: 'Through the top of the frame. Skipped, with a warning, if the frame is too narrow to carry it.' },
  { key: 'hangerDia', label: 'Hanger size', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 2, max: 8, step: 0.5, def: 4,
    showIf: (p) => (p.shape || 'flat') === 'flat' && p.hanger && p.hanger !== 'none',
    help: 'Across the hole. 4 mm clears a panel pin and most picture hooks.' },
  { key: 'foot', label: 'Base foot', type: 'bool', def: false, group: 'Frame & mounting',
    showIf: (p) => p.shape !== 'shade',
    help: 'A plinth so it stands on a shelf. Tapers at 45 degrees into the panel, so it needs no support.' },
  { key: 'footHeight', label: 'Foot height', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 1, max: 20, step: 0.5, def: 5, showIf: (p) => !!p.foot && p.shape !== 'shade',
    help: 'The straight part, below the taper.' },
  { key: 'footDepth', label: 'Foot depth', type: 'number', unit: 'mm', group: 'Frame & mounting',
    min: 1, max: 15, step: 0.5, def: 6,
    showIf: (p) => !!p.foot && p.shape !== 'shade',
    help: 'How far it spreads on each side. A tall flat panel wants 8 mm or more before it stops wanting to fall over.' },

  { key: 'caption', label: 'Message', type: 'text', def: '', maxLength: 60, group: 'Caption',
    showIf: (p) => (p.shape ?? 'flat') === 'flat',
    help: 'A line under the picture — a name, a date, "Happy Birthday". Use \\n for a second line. Leave it empty for no caption. Flat plates only: a curved panel would need the letters bent round the curve with it.' },
  { key: 'captionStyle', label: 'Style', type: 'enum', def: 'raised', group: 'Caption',
    options: [
      { v: 'raised', label: 'Raised', help: 'Letters standing off the front of the frame. Legible in any light.' },
      { v: 'engraved', label: 'Engraved', help: 'A shallow pocket in the front. Reads as a shadow, and takes ink or paint well.' },
      { v: 'lit', label: 'Lit from behind', help: 'Cut deep into the BACK, leaving a picture-thin skin. The frame looks blank until you hold it to the light, then the message comes on with the photograph. Mirrored automatically, because you read it through the panel.' },
    ],
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim() },
  { key: 'captionFont', label: 'Typeface', type: 'enum', def: DEFAULT_FONT, group: 'Caption',
    options: FONT_FILES.map(f => ({ v: f.id, label: f.label, help: f.help })),
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim(),
    help: 'The three faces bundled with Bluesheet; licences sit beside them.' },
  { key: 'captionHeight', label: 'Letter height', type: 'number', unit: 'mm', group: 'Caption',
    def: 8, min: 2, max: 30, step: 0.5,
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim(),
    help: 'Cap height. The bottom border grows to hold it, and the line shrinks on its own if it would overrun the panel.' },
  { key: 'captionRelief', label: 'Letter height above the frame', type: 'number', unit: 'mm', group: 'Caption',
    def: 0.8, min: 0.2, max: 3, step: 0.1,
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim() && (p.captionStyle ?? 'raised') === 'raised',
    help: 'How far the letters stand proud. Two or three layers is enough to catch the light; more only adds a longer bridge under each letter.' },
  { key: 'captionDepth', label: 'Engraving depth', type: 'number', unit: 'mm', group: 'Caption',
    def: 0.6, min: 0.2, max: 3, step: 0.1,
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim() && p.captionStyle === 'engraved',
    help: 'How deep the pocket goes. Kept clear of the back of the frame whatever you ask for.' },
  { key: 'captionGlow', label: 'Skin left in front', type: 'number', unit: 'mm', group: 'Caption',
    def: 0.8, min: 0.3, max: 3, step: 0.1,
    showIf: (p) => (p.shape ?? 'flat') === 'flat' && !!String(p.caption ?? '').trim() && p.captionStyle === 'lit',
    help: 'What is left in front of the letters for the light to come through — the same number as the thinnest part of the picture is the safe answer. Thinner glows brighter and starts to show the layers.' },

  { key: 'image2', label: 'Photograph 2', type: 'image', group: 'Shade faces',
    showIf: (p) => p.shape === 'shade', help: 'The second face. Left empty it repeats the first.' },
  { key: 'image3', label: 'Photograph 3', type: 'image', group: 'Shade faces',
    showIf: (p) => p.shape === 'shade', help: 'The third face.' },
  { key: 'image4', label: 'Photograph 4', type: 'image', group: 'Shade faces',
    showIf: (p) => p.shape === 'shade', help: 'The fourth face.' },
];

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validate(p) {
  const issues = [];
  let g;
  try { g = solve(p, {}); } catch (e) {
    return [{ param: 'image', severity: 'error', message: `This picture could not be prepared: ${e.message}` }];
  }
  const bed = { x: 180, y: 180, z: 180 };

  // Asked, not solved: solve() has already forced the two apart so the mesh is
  // buildable, and testing the settled numbers here would be a check on the
  // repair rather than on the mistake.
  if (g.notes.includes('range')) {
    issues.push({ param: 'maxThickness', severity: 'error',
      message: `The thickest point (${num(p.maxThickness, 3).toFixed(1)} mm) is not meaningfully thicker than the thinnest (${num(p.minThickness, 0.8).toFixed(1)} mm), so every pixel maps to the same height and the picture disappears. Leave at least 1.5 mm between them.` });
  } else if (g.maxT - g.minT < 1.2) {
    issues.push({ param: 'maxThickness', severity: 'warn',
      message: `Only ${(g.maxT - g.minT).toFixed(1)} mm of range between white and black. Under about 1.5 mm the print is legible but washed out; 0.8 to 3.0 mm is the usual pair.` });
  }
  if (g.minT < 0.6) {
    issues.push({ param: 'minThickness', severity: 'warn',
      message: `${g.minT.toFixed(2)} mm is under two 0.42 mm extrusions. The brightest areas will be a single wall with gaps in it — 0.7 mm is about the floor on a 0.4 mm nozzle.` });
  }
  if (g.maxT > 3.6) {
    issues.push({ param: 'maxThickness', severity: 'info',
      message: `${g.maxT.toFixed(1)} mm is past the point where PLA stops transmitting light, so the darks all read the same. It prints, it just takes longer to say less.` });
  }
  if (num(p.frameThickness, 3.6) < g.maxT - 1e-6 && g.framed) {
    issues.push({ param: 'frameThickness', severity: 'warn',
      message: `A ${num(p.frameThickness, 3.6).toFixed(1)} mm frame is thinner than the ${g.maxT.toFixed(1)} mm darkest part of the picture, which would leave the picture standing proud of its own frame. Built at ${g.frameT.toFixed(1)} mm instead.` });
  }
  if (g.hangerBlocked === 'frameWidth') {
    issues.push({ param: 'frameWidth', severity: 'warn',
      message: `No room for a ${g.hangerDia.toFixed(1)} mm ${g.hangerKind} hanger in a ${g.frameW.toFixed(1)} mm frame — it needs about ${(g.hangerDia * (g.hangerKind === 'teardrop' ? 1.207 : 1) + 2 * HANGER_CLEAR).toFixed(1)} mm of border. The hole has been left out.` });
  } else if (g.hangerBlocked === 'frame') {
    issues.push({ param: 'hanger', severity: 'warn',
      message: 'A hanger hole needs a frame to go through — without one it would be a hole in the photograph. Turn the frame on or the hanger off.' });
  }
  if (g.grid.uniform) {
    issues.push({ param: 'image', severity: 'warn',
      message: 'This picture is a single tone, so there is nothing to carve: the result is a plain plate. Check the right file arrived.' });
  }
  if (g.captionBlocked === 'shape') {
    issues.push({ param: 'caption', severity: 'warn',
      message: 'A caption only goes on the flat plate. On a curved panel or a shade the letters would have to bend round the curve with the picture, which this generator does not do — so the message has been left off.' });
  } else if (g.captionBlocked === 'frame') {
    issues.push({ param: 'caption', severity: 'warn',
      message: 'A caption needs a frame to sit in — without one the only surface below the picture is the picture. Turn the frame on, or clear the message.' });
  } else if (g.captionBlocked === 'font') {
    issues.push({ param: 'caption', severity: 'warn',
      message: `No typeface could be loaded (${[...FONT_ERRORS.values()].join('; ') || 'none registered'}), so the message has been left off.` });
  } else if (g.captionBlocked === 'ink') {
    issues.push({ param: 'caption', severity: 'warn',
      message: 'Nothing in this message has an outline in the chosen typeface, so there is nothing to build. Try another face.' });
  }
  if (g.caption) {
    const c = g.caption;
    if (c.missing.length) {
      issues.push({ param: 'caption', severity: 'warn',
        message: `${c.missing.length} character${c.missing.length > 1 ? 's are' : ' is'} not in this typeface and ${c.missing.length > 1 ? 'have' : 'has'} been dropped: ${c.missing.join(' ')}. The rest of the line has closed up around the gap.` });
    }
    if (c.fit < 0.999) {
      issues.push({ param: 'captionHeight', severity: 'info',
        message: `The message is wider than the panel at ${num(p.captionHeight, 8).toFixed(1)} mm, so it has been shrunk to ${c.capMm.toFixed(1)} mm to fit. A wider picture or a narrower face would let it keep its size.` });
    }
    if (c.thinned) {
      issues.push({ param: 'captionGlow', severity: 'warn',
        message: `A ${g.frameT.toFixed(1)} mm frame cannot leave ${num(p.captionGlow, 0.8).toFixed(1)} mm in front of the letters and still have a pocket behind them. Built with ${c.glow.toFixed(2)} mm — thicken the frame if you want the message dimmer.` });
    } else if (c.style === 'lit' && c.glow < g.minT - 1e-6) {
      issues.push({ param: 'captionGlow', severity: 'info',
        message: `The letters are being left thinner (${c.glow.toFixed(1)} mm) than the brightest part of the picture (${g.minT.toFixed(1)} mm), so they will read brighter than anything in the photograph. That is a choice, not a fault — match the two if you want the message to sit inside the picture rather than in front of it.` });
    }
    if (c.depth > 2 + 1e-6) {
      issues.push({ param: c.style === 'lit' ? 'captionGlow' : 'captionDepth', severity: 'info',
        message: `The pocket is ${c.depth.toFixed(1)} mm deep, so the ceiling over every letter is a ${c.depth.toFixed(1)} mm cantilever printed into thin air. It bridges, but the top edge of the letters will be rougher than the bottom. Under about 2 mm it does not show.` });
    }
    if (c.capMm < 4) {
      issues.push({ param: 'captionHeight', severity: 'info',
        message: `${c.capMm.toFixed(1)} mm capitals on a 0.4 mm nozzle is about ten extrusions tall. It prints, but the counters of a, e and o start to close up — a mono or narrow face holds together better at this size than a rounded one.` });
    }
  }
  if (g.grid.srcW && (g.grid.srcW < g.nu || g.grid.srcH < g.nv)) {
    issues.push({ param: 'image', severity: 'info',
      message: `The photograph is ${g.grid.srcW}x${g.grid.srcH} and the print grid is ${g.nu + 1}x${g.nv + 1}. It is being enlarged; the print cannot show detail the file does not have.` });
  }
  // Reported only when the cap actually cost something. Trimming 0.35 mm to
  // 0.40 to stay inside the budget is not news; trimming it to 0.9 is.
  const effPitch = Math.max(g.W / g.nu, g.H / g.nv);
  if (g.capped && effPitch > g.pitch * 1.25) {
    issues.push({ param: 'pixelPitch', severity: 'info',
      message: `A ${g.pitch.toFixed(2)} mm pitch over ${g.W.toFixed(0)}x${g.H.toFixed(0)} mm would be more than ${MAX_TRIS / 1000}k triangles, so the grid was capped at ${g.nu}x${g.nv} — an effective ${effPitch.toFixed(2)} mm.` });
  } else if (g.pitch < 0.25) {
    issues.push({ param: 'pixelPitch', severity: 'info',
      message: `${g.pitch.toFixed(2)} mm is finer than a 0.4 mm nozzle resolves across the picture, though the layers still resolve it vertically. Worth it on something you hold; on a large panel it is mostly triangles.` });
  }
  if (g.notes.includes('shadeSide')) {
    issues.push({ param: 'shadeSide', severity: 'warn',
      message: `A ${num(p.shadeSide, 70).toFixed(0)} mm shade has no corner left once the walls are ${g.frameT.toFixed(1)} mm thick. Built at ${g.side.toFixed(0)} mm.` });
  }
  if (g.curved && g.radiusRaised) {
    issues.push({ param: 'radius', severity: 'warn',
      message: `At ${num(p.radius, 70).toFixed(0)} mm radius a ${g.panelW.toFixed(0)} mm panel wraps ${(g.panelW / (num(p.radius, 70) + g.dir * g.tMid) / DEG).toFixed(0)} degrees and closes on itself. Opened out to ${g.radius.toFixed(0)} mm so the picture keeps its width.` });
  }

  // Bed. Measured from the solved geometry rather than the mesh, so the warning
  // arrives while the number is still being typed.
  const foot = g.foot ? g.footD : 0;
  let sx, sy;
  if (g.shape === 'shade') { sx = g.side; sy = g.side; }
  else if (g.curved) {
    const rOut = (g.dir > 0 ? g.radius + g.frameT : g.radius) + foot;
    const rIn = (g.dir > 0 ? g.radius : g.radius - g.frameT) - foot;
    if (g.theta >= Math.PI) { sx = 2 * rOut; sy = rOut + Math.max(rIn * Math.cos(g.theta / 2), -rOut); }
    else { sx = 2 * rOut * Math.sin(g.theta / 2); sy = rOut - rIn * Math.cos(g.theta / 2); }
  } else { sx = g.panelW; sy = g.frameT + (g.caption ? g.caption.out : 0) + 2 * foot; }
  const sz = g.z0 + g.panelH;
  if (sx > bed.x + 1e-6 || sy > bed.y + 1e-6 || sz > bed.z + 1e-6) {
    issues.push({ param: sz > bed.z ? 'imageHeight' : 'imageWidth', severity: 'error',
      message: `This comes out ${sx.toFixed(0)} x ${sy.toFixed(0)} x ${sz.toFixed(0)} mm and the A1 mini bed is ${bed.x} x ${bed.y} x ${bed.z} mm. It will not print — reduce the picture${g.framed ? ' or the frame' : ''}.` });
  }
  if (g.shape === 'flat' && !g.foot && g.hangerKind === 'none') {
    issues.push({ param: 'foot', severity: 'info',
      message: `A ${g.frameT.toFixed(1)} mm plate ${sz.toFixed(0)} mm tall has nothing to stand on and no way to hang. Add a foot, or a hanger hole, or plan to slot it into something.` });
  }
  if (g.foot && g.shape === 'flat' && g.footD < sz / 20) {
    issues.push({ param: 'footDepth', severity: 'info',
      message: `A ${g.footD.toFixed(0)} mm foot under a ${sz.toFixed(0)} mm panel is a narrow base. About ${(sz / 15).toFixed(0)} mm each side is where it stops being easy to knock over.` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

const BLOCKS = '▁▂▃▄▅▆▇█';

function hints(p) {
  let g;
  try { g = solve(p, {}); } catch { g = null; }
  if (!g) return { profile: '0.10 mm', layerH: 0.1, infill: 100, supports: false, filament: 'White PLA', notes: ['The picture could not be read.'] };

  const opts = { invert: !!p.invert, contrast: num(p.contrast, 1), gamma: num(p.gamma, 1) };
  const mapping = [];
  let spark = '';
  for (let k = 0; k <= 20; k++) {
    const lum = k / 20;
    const t = g.maxT - toneCurve(lum, opts) * (g.maxT - g.minT);
    mapping.push([lum, t]);
    if (k % 2 === 0) {
      const f = (t - g.minT) / Math.max(1e-9, g.maxT - g.minT);
      spark += BLOCKS[clamp(Math.round(f * 7), 0, 7)];
    }
  }

  const pitch = Math.max(g.W / g.nu, g.H / g.nv);
  const layerH = clamp(Math.round(Math.min(0.12, pitch) * 100) / 100, 0.06, 0.2);
  const rows = Math.round(g.panelH / layerH);
  const walls = Math.max(2, Math.floor(g.minT / 0.42));

  const notes = [
    `Black to white, left to right: ${spark}  (${g.maxT.toFixed(1)} mm down to ${g.minT.toFixed(1)} mm). Dark is thick and blocks the light — if the print comes out as a negative, the picture went in inverted, not the mapping.`,
    `${layerH.toFixed(2)} mm layers. Printed standing, the rows of the picture ARE the layers: ${rows} of them here, against a ${pitch.toFixed(2)} mm sample pitch across. Going coarser than the pitch throws away picture; going much finer only adds time.`,
    '100% infill. This is the one setting that ruins a lithophane if you forget it — at 15% the inside is a lattice and you can read the gyroid straight through the bright areas.',
    'Top and bottom solid layers: 0. With the inside already solid there is nothing to skin, and the skin detection lays a different pattern over the picture that reads as a haze across the highlights.',
    `${walls} perimeters. The thinnest part of the picture is ${g.minT.toFixed(1)} mm, which is ${(g.minT / 0.42).toFixed(1)} extrusions — ask for more walls than fit and the slicer starts dropping them, which shows up as blotches in the whites.`,
    'Ironing OFF. The relief slopes, so the slicer classifies patches of the picture as top surface and irons them; every ironed patch comes out a different translucency from its neighbours and you get a map of the slicer\'s opinions across the photograph.',
    'Seam: aligned, and rotated to a back corner if the slicer will let you. A random or nearest seam scatters start-of-layer blobs through the middle of the picture, and each one is a bright dot in the finished print.',
    'No supports. Every surface here is either vertical, a gentle relief or a 45 degree taper.',
    'White or natural PLA. Not clear — clear passes too much light in the thick areas and the picture loses its blacks — and not silk, which reflects instead of transmitting. Bring the outer wall speed down to about 30 mm/s: ringing after a sharp corner prints as a ghost of the corner across the next 10 mm of picture.',
  ];
  if (g.grid.worstRise > MAX_RISE + 1e-6) {
    notes.push(g.guardOn
      ? `The picture has a horizontal edge steep enough to overhang (${g.grid.worstRise.toFixed(1)} mm of relief per mm of height, against a ${MAX_RISE} limit) and the step guard has ramped it. If a hard horizon looks softer than you wanted, that is where it went.`
      : `The step guard is off and this picture has an edge rising ${g.grid.worstRise.toFixed(1)} mm per mm of height — about ${(g.grid.worstRise * layerH).toFixed(2)} mm of unsupported offset per layer against a 0.42 mm extrusion. Expect that edge to droop.`);
  }
  notes.push('If the first one comes out muddy — right shapes, no life in the midtones — raise the gamma to about 1.3 rather than reaching for the thickness. PLA does not transmit light linearly with thickness, and a linear map lands the midtones darker than the eye expects.');

  if (g.shape === 'flat') {
    notes.push(g.foot
      ? 'It stands on its own plinth, so no brim. Check the first layer of the plinth is clean before you leave it — the whole print is balanced on it.'
      : 'A brim of 5 mm. The footprint is a line a few millimetres wide and a hundred long, and this is the print that walks off the bed at layer 200 if it is not held down.');
  } else if (g.curved) {
    notes.push(`Curved ${g.theta / DEG < 1 ? 'barely' : (g.theta / DEG).toFixed(0) + ' degrees'}: the arc is its own stiffener, so this one does not need a brim and will not warp the way a flat panel does.`);
  } else {
    notes.push(`The shade prints as one square tube — all four walls vertical, nothing overhanging, no supports and no seam to glue. Print it the way it comes out of Bluesheet, standing. It has no lamp fitting: the walls are ${g.frameT.toFixed(1)} mm of solid PLA and it is meant to stand over an LED tea light or a small base, not to hang off a bulb holder that will cook it.`);
  }
  if (g.caption) {
    const c = g.caption;
    if (c.style === 'raised') {
      notes.push(`The message stands ${c.out.toFixed(1)} mm off the front of the frame. Printed standing, each layer of a letter lands on the layer below it — only the very first layer of each glyph hangs off the frame, and that is a ${c.out.toFixed(1)} mm bridge. No supports, and no reason to slow down for it.`);
    } else if (c.style === 'engraved') {
      notes.push(`The message is a ${c.depth.toFixed(1)} mm pocket in the front. The ceiling over each letter is unsupported for that depth; at this size it bridges cleanly. If you want it to read from across the room, a wipe of acrylic paint over the frame and a wipe off the high surface fills the letters and nothing else.`);
    } else {
      notes.push(`The message is cut into the BACK, leaving ${c.glow.toFixed(2)} mm of skin in front of it — about ${(c.glow / 0.42).toFixed(1)} extrusions, the same order as the brightest part of the picture. Do not let the slicer add top or bottom solid layers here either: the whole effect is that skin, and a solid layer laid across it is what makes a lit caption come out grey instead of bright. The letters are mirrored in the mesh so they read the right way round from the front.`);
    }
    if (c.lines > 1) notes.push(`${c.lines} lines of caption. The bottom border grew to ${(g.frameW + c.band).toFixed(1)} mm to hold them, which is also ${((g.frameW + c.band) / layerH).toFixed(0)} layers of plain frame before the picture starts.`);
  }
  if (g.mirror) notes.push('The picture is mirrored, because on this shape you look at it through the smooth face. That is deliberate; it will read the right way round in the light.');
  if (g.grid.uniform) notes.push('This picture is one flat tone, so what you are about to print is a blank plate.');

  return {
    profile: `${layerH.toFixed(2)} mm, 100% infill`,
    layerH, infill: 100, topLayers: 0, bottomLayers: 0, perimeters: walls,
    supports: false, filament: 'White PLA', brim: g.shape === 'flat' && !g.foot,
    mapping,
    notes,
  };
}

// ---------------------------------------------------------------------------

export default {
  id: 'lithophane',
  name: 'Photo Lithophane',
  category: 'Decor',
  blurb: 'A photograph as a relief that only becomes a picture when you hold it to the light.',
  description:
    'A lithophane is a photograph printed as thickness: dark parts of the picture become thick ' +
    'and block the light, bright parts become thin and glow. It comes out of Bluesheet already ' +
    'standing on its bottom edge, which is the only orientation worth printing one in — laid ' +
    'flat, the whole tonal range would be quantised to the layer height. Four shapes: a flat ' +
    'plate with a frame and a hanger hole, an outward curve that stands up by itself and cannot ' +
    'warp, an inward curve to sit in front of a lamp, and a four-sided shade with a different ' +
    'photograph on each face. The picture is never stretched — it keeps its aspect ratio or it ' +
    'is cropped, and you choose which — and it is resampled with a real filter rather than ' +
    'point-sampled, because a point-sampled photograph prints with a visible staircase down ' +
    'every diagonal. A flat plate can carry a message under the picture in one of three ways: ' +
    'raised off the frame, engraved into it, or cut into the back so deep that only a ' +
    'picture-thin skin is left and the words appear only when the panel is held to the light.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="3" width="17" height="18" rx="1.5"/><path d="M6 17l4-5.5 3 3.5 2.5-3L18 17z"/><circle cx="15" cy="8" r="1.6"/></svg>',
  version: 1,
  params,
  presets: [
    { name: 'Framed photo for the wall', values: {
      shape: 'flat', fit: 'crop', imageWidth: 152, imageHeight: 102, frame: true,
      frameWidth: 7, frameThickness: 3.8, hanger: 'teardrop', hangerDia: 4,
      minThickness: 0.8, maxThickness: 3, edgeFade: 1.2, foot: false, pixelPitch: 0.35 } },
    { name: 'Standing arc for a desk', values: {
      shape: 'arc-out', imageWidth: 100, radius: 65, frame: true, frameWidth: 6,
      frameThickness: 3.6, foot: true, footHeight: 5, footDepth: 6,
      minThickness: 0.8, maxThickness: 3, hanger: 'none', pixelPitch: 0.35 } },
    { name: 'Night-light shade', values: {
      shape: 'shade', shadeSide: 70, fit: 'crop', imageHeight: 85, frame: true,
      frameWidth: 5, frameThickness: 3.2, minThickness: 0.7, maxThickness: 2.8,
      gamma: 1.15, edgeFade: 1.5, pixelPitch: 0.4 } },
    { name: 'Tea-light arch', values: {
      shape: 'arc-in', imageWidth: 90, radius: 46, frame: true, frameWidth: 4,
      frameThickness: 3, foot: true, footHeight: 4, footDepth: 5,
      minThickness: 0.7, maxThickness: 2.6, gamma: 1.2, pixelPitch: 0.35 } },
    { name: 'Birthday card', values: {
      shape: 'flat', fit: 'crop', imageWidth: 90, imageHeight: 120, frame: true,
      frameWidth: 7, frameThickness: 3.6, hanger: 'none', foot: true, footHeight: 5, footDepth: 7,
      minThickness: 0.8, maxThickness: 3, edgeFade: 1.2, pixelPitch: 0.35,
      caption: 'Happy Birthday', captionStyle: 'lit', captionFont: 'Quicksand-Bold',
      captionHeight: 9, captionGlow: 0.8 } },
    { name: 'Engraved keepsake', values: {
      shape: 'flat', fit: 'crop', imageWidth: 100, imageHeight: 100, frame: true,
      frameWidth: 8, frameThickness: 3.8, hanger: 'teardrop', hangerDia: 4, foot: false,
      minThickness: 0.8, maxThickness: 3, pixelPitch: 0.35,
      caption: 'With love\nfrom us both', captionStyle: 'engraved', captionFont: 'LiberationSansNarrow-Regular',
      captionHeight: 6, captionDepth: 0.6 } },
    { name: 'Keyring pendant', values: {
      shape: 'flat', fit: 'crop', imageWidth: 32, imageHeight: 42, frame: true,
      frameWidth: 5, frameThickness: 2.4, hanger: 'round', hangerDia: 2.5,
      minThickness: 0.6, maxThickness: 2.2, contrast: 1.35, edgeFade: 0.6,
      foot: false, pixelPitch: 0.2 } },
    { name: 'Window panel, tall crop', values: {
      shape: 'flat', fit: 'crop', cropAnchor: 'top', imageWidth: 80, imageHeight: 150,
      frame: true, frameWidth: 7, frameThickness: 3.4, hanger: 'slot', hangerDia: 4,
      minThickness: 0.8, maxThickness: 3.2, gamma: 1.1, foot: false, pixelPitch: 0.35 } },
  ],
  build,
  validate,
  hints,
};
