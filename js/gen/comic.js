// js/gen/comic.js: a line drawing turned into a two-colour plaque.
//
// Upload a black-on-white drawing (a webcomic panel, a sketch, a signature) and
// the dark lines come out raised above a flat plate. Print the plate in one
// colour and change filament at the plate's top face: everything above that
// height is the drawing.
//
// The pipeline is all 2D until the very last step:
//
//   grey field -> ink mask (threshold, optional invert)
//              -> panel pick (gutters between frames), trim, optional crop
//              -> marching squares (js/kernel/trace.js): closed, sub-pixel rings
//              -> Douglas-Peucker, under a third of a printed pixel
//              -> nest by containment, drop specks and pinholes
//              -> thicken with poly2d.offset (its winding fill is also the union)
//              -> clip to the plate, add the border, clear the hanging holes
//              -> ONE closed surface: plate walls, a top face with the ink as
//                 holes in it, and the ink standing on it as prisms.
//
// There is no CSG. The plate/relief construction is nameplate.js's raised mode,
// copied rather than imported because nameplate keeps those helpers private and
// loads three fonts at import time that this generator does not need. The
// assembly retries at a few angles for the same reason nameplate does: poly2d's
// ear clipper can swap boundary edges when rings share a collinear edge, and a
// traced drawing is full of those.
//
// Millimetres, Z up, CCW seen from outside.

import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { contoursToShapes } from '../kernel/text.js';
import { traceContours } from '../kernel/trace.js';
import { clamp, num } from '../kernel/scalar.js';

const MIN_RING_AREA = 1e-5;      // mm²; below this a ring is a boolean artefact
const EDGE_CLEAR = 1.0;          // mm; raised work never runs closer than this to the plate edge
const NOZZLE = 0.4;
const MIN_LINE = 2 * NOZZLE;     // mm; two extrusions: still the floor for a counter (an enclosed gap), which is unmeasured
/** The thin-line warning, and the print it rests on. Shaped like a MEASURED
 *  entry in js/kernel/fit.js: change the value only when a print says so. */
export const THIN_LINE_MEASURED = Object.freeze({
  kind: 'line', value: 0.5,
  machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA, Bambu Studio 0.20 mm Standard, two colours via the AMS',
  date: '2026-09-27',
  by: 'Sam: xkcd 905 panels printed at 50% X/Y in Bambu Studio, so the raised lines came out about 0.4 to 0.5 mm wide, and they "printed perfectly"',
  note: 'One side of the bracket only: 0.4-0.5 mm printed, nothing narrower was tried. The old 0.8 mm (two extrusions) warned on lines that print fine.',
});
const THIN_LINE = THIN_LINE_MEASURED.value;   // mm; narrower than this is worth a warning
const CURVE_TOL = { draft: 0.06, normal: 0.02, fine: 0.008 };
const SIMPLIFY_PX = { draft: 0.5, normal: 0.3, fine: 0.15 };   // fraction of one printed pixel
const ASSEMBLY_ANGLES = [0, 0.013707, 0.109861, 0.327106, 0.557372, 0.841903, 1.120736, 1.423110];
const MAX_PANEL_DEPTH = 4;
const THIN_REPORT = 1.0;         // mm of thin line before it is worth a warning (a tapering stroke end is less)

function nseg(n, sf, min = 3) { return Math.max(min, Math.round(n * (sf || 1))); }

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

/**
 * Whatever arrived from the file picker, reduced to {w, h, gray} in 0..1, or
 * null. 0..255 byte data is accepted and rescaled, because handing it over
 * unscaled would clamp every pixel to white and trace nothing, silently.
 */
function normImage(src) {
  if (!src || typeof src !== 'object') return null;
  const w = Math.floor(num(src.w, 0)), h = Math.floor(num(src.h, 0));
  const gray = src.gray || src.data;
  if (!(w >= 1 && h >= 1) || !gray || gray.length < w * h) return null;
  let mx = 0;
  for (let i = 0; i < w * h; i++) { const v = gray[i]; if (v > mx) mx = v; }
  const k = mx > 1.5 ? 1 / 255 : 1;
  return { w, h, gray, k };
}

/**
 * The stand-in drawing shown before anything is uploaded: a framed stick figure
 * with a speech line. Built once from distance-to-segment arithmetic, so it is
 * deterministic and needs no file. Anti-aliased over one pixel like a real scan.
 */
let PLACEHOLDER = null;
function placeholder() {
  if (PLACEHOLDER) return PLACEHOLDER;
  const w = 240, h = 180, gray = new Float32Array(w * h);
  const segs = [];
  const line = (x0, y0, x1, y1) => segs.push([x0, y0, x1, y1]);
  const arc = (cx, cy, r, a0, a1, n = 40) => {
    for (let i = 0; i < n; i++) {
      const t0 = a0 + (a1 - a0) * i / n, t1 = a0 + (a1 - a0) * (i + 1) / n;
      line(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1));
    }
  };
  line(6, 6, 234, 6); line(234, 6, 234, 174); line(234, 174, 6, 174); line(6, 174, 6, 6);  // frame
  arc(80, 62, 16, 0, Math.PI * 2);                                                      // head
  line(80, 78, 80, 124);                                                                // body
  line(80, 92, 58, 112); line(80, 92, 104, 104);                                        // arms
  line(80, 124, 64, 160); line(80, 124, 96, 160);                                       // legs
  line(110, 52, 132, 40);                                                               // speech tick
  arc(176, 38, 22, Math.PI * 0.85, Math.PI * 2.15, 30);                                 // speech bubble
  line(162, 30, 190, 30); line(162, 42, 184, 42);                                       // "words"
  const half = 1.1;                                                                     // ~2.2 px lines
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + 0.5, py = y + 0.5;
    let d = Infinity;
    for (const [x0, y0, x1, y1] of segs) {
      const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
      const t = L > 0 ? clamp(((px - x0) * dx + (py - y0) * dy) / L, 0, 1) : 0;
      const e = Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
      if (e < d) d = e;
    }
    gray[y * w + x] = clamp(d - half + 0.5, 0, 1);          // 0 on the line, 1 a pixel clear of it
  }
  PLACEHOLDER = { w, h, gray, k: 1, placeholder: true };
  return PLACEHOLDER;
}

/**
 * Signed ink field: positive where the pixel is ink. Normal: dark is ink,
 * `threshold` is the grey (0 black .. 1 white) below which a pixel counts.
 * Inverted: light is ink.
 */
function inkField(img, threshold, invert) {
  const n = img.w * img.h, s = new Float32Array(n), k = img.k;
  for (let i = 0; i < n; i++) {
    const g = img.gray[i] * k;
    s[i] = invert ? g - threshold : threshold - g;
  }
  return s;
}

/** Ink count per row or column of a sub-rectangle. */
function profile(s, w, rect, axis) {
  const { x0, y0, x1, y1 } = rect;
  const len = axis === 'rows' ? y1 - y0 : x1 - x0;
  const out = new Int32Array(len);
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) if (s[row + x] > 0) out[axis === 'rows' ? y - y0 : x - x0]++;
  }
  return out;
}

/** Tight ink box of a rectangle, or null when it holds no ink. */
function trimRect(s, w, rect) {
  const rows = profile(s, w, rect, 'rows'), cols = profile(s, w, rect, 'cols');
  let a = 0; while (a < rows.length && !rows[a]) a++;
  if (a === rows.length) return null;
  let b = rows.length - 1; while (!rows[b]) b--;
  let c = 0; while (!cols[c]) c++;
  let d = cols.length - 1; while (!cols[d]) d--;
  return { x0: rect.x0 + c, y0: rect.y0 + a, x1: rect.x0 + d + 1, y1: rect.y0 + b + 1 };
}

/**
 * Find the panels of a comic: rectangles separated by gutters, a gutter being a
 * full row or column of the current rectangle with no ink in it at all. Split on
 * rows first (so a grid reads row by row, as a comic does), then columns, and
 * recurse into each piece, so a strip, a grid and a grid whose rows split
 * differently all come apart. A run of ink narrower than 4% of the side (and
 * at least 4 px) is not a panel but a stray mark in the gutter, and is dropped
 * from the list rather than numbered. Pure function of the mask.
 */
export function findPanels(s, w, h) {
  const whole = trimRect(s, w, { x0: 0, y0: 0, x1: w, y1: h });
  if (!whole) return [];
  const out = [];
  const walk = (rect, depth) => {
    if (depth < MAX_PANEL_DEPTH) {
      for (const axis of ['rows', 'cols']) {
        const prof = profile(s, w, rect, axis);
        const minRun = Math.max(4, Math.round(0.04 * prof.length));
        const runs = [];
        for (let i = 0; i < prof.length;) {
          if (!prof[i]) { i++; continue; }
          let j = i; while (j < prof.length && prof[j]) j++;
          if (j - i >= minRun) runs.push([i, j]);
          i = j;
        }
        if (runs.length >= 2) {
          for (const [a, b] of runs) {
            const sub = axis === 'rows'
              ? { x0: rect.x0, x1: rect.x1, y0: rect.y0 + a, y1: rect.y0 + b }
              : { x0: rect.x0 + a, x1: rect.x0 + b, y0: rect.y0, y1: rect.y1 };
            const t = trimRect(s, w, sub);
            if (t) walk(t, depth + 1);
          }
          return;
        }
      }
    }
    out.push(rect);
  };
  walk(whole, 0);
  return out;
}

/** Centre crop of a pixel box to cw × ch pixels (never larger than the box). */
function cropBox(box, cw, ch) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  cw = Math.min(bw, cw); ch = Math.min(bh, ch);
  const x0 = box.x0 + Math.floor((bw - cw) / 2), y0 = box.y0 + Math.floor((bh - ch) / 2);
  return { x0, y0, x1: x0 + cw, y1: y0 + ch };
}

// ---------------------------------------------------------------------------
// 2D helpers
// ---------------------------------------------------------------------------

function ringsOf(shapes) { const out = []; for (const s of shapes) for (const r of s) out.push(r); return out; }

function dropSpecks(shapes, minArea = MIN_RING_AREA) {
  const out = [];
  for (const s of shapes) {
    if (!s.length || s[0].length < 3 || P.area(s[0]) < minArea) continue;
    out.push([s[0], ...s.slice(1).filter(r => r.length >= 3 && P.area(r) >= minArea)]);
  }
  return out;
}

function totalArea(shapes) {
  let a = 0;
  for (const s of shapes) { a += P.area(s[0]); for (let i = 1; i < s.length; i++) a -= P.area(s[i]); }
  return a;
}

/** A point strictly inside a ring: the centroid of its largest ear. */
function insidePoint(ring) {
  const { points, tris } = P.triangulate([ring]);
  let best = -1, bi = -1;
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (ar > best) { best = ar; bi = t; }
  }
  if (bi < 0) return null;
  const a = points[tris[bi]], b = points[tris[bi + 1]], c = points[tris[bi + 2]];
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

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

function nestRings(rings) {
  const kept = rings.filter(r => r && r.length >= 3 && Math.abs(P.signedArea(r)) >= MIN_RING_AREA);
  return contoursToShapes(kept, { minArea: 0 });
}

function rotRing(ring, ca, sa) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = [ring[i][0] * ca - ring[i][1] * sa, ring[i][0] * sa + ring[i][1] * ca];
  return out;
}
function rotShapes(shapes, ca, sa) {
  if (sa === 0 && ca === 1) return shapes;
  return shapes.map(s => s.map(r => rotRing(r, ca, sa)));
}

// ---------------------------------------------------------------------------
// plan: every derived number and every 2D shape, memoised
// ---------------------------------------------------------------------------

// build(), validate() and hints() each ask for the plan; tracing and offsetting
// a 1024 px drawing three times over would triple the redraw. Single-entry memo
// keyed on the scalar parameters, the picture's identity and the quality.
let memoKey = null, memoVal = null;
const imgIds = new WeakMap();
let nextImgId = 1;
function idOf(v) {
  if (!v || typeof v !== 'object') return String(v);
  let id = imgIds.get(v);
  if (id === undefined) { id = nextImgId++; imgIds.set(v, id); }
  return `#${id}`;
}
function keyOf(p, quality) {
  const parts = [quality];
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    parts.push(k, typeof v === 'object' && v !== null ? idOf(v) : String(v));
  }
  return parts.join('\u0001');
}

export function planFor(p, ctx = {}) {
  const quality = CURVE_TOL[ctx.quality] ? ctx.quality
    : (num(ctx.segFactor, 1) < 0.75 ? 'draft' : num(ctx.segFactor, 1) > 1.5 ? 'fine' : 'normal');
  const key = keyOf(p, quality) + '\u0001' + (ctx.bed ? `${ctx.bed.x}x${ctx.bed.y}` : '');
  if (key === memoKey) return memoVal;
  const out = planFresh(p, ctx, quality);
  memoKey = key; memoVal = out;
  return out;
}

function planFresh(p, ctx, quality) {
  const sf = { draft: 0.5, normal: 1, fine: 2 }[quality];
  const tol = CURVE_TOL[quality];
  const bed = ctx.bed || { x: 180, y: 180 };
  const notes = [];

  const W = clamp(num(p.width, 150), 20, bed.x);
  const T = clamp(num(p.plateThickness, 2), 0.4, 20);
  const relief = clamp(num(p.reliefHeight, 0.8), 0.1, 20);
  const threshold = clamp(num(p.threshold, 0.5), 0.01, 0.99);
  const invert = !!p.invert;
  const thicken = clamp(num(p.thicken, 0.4), 0, 5);
  const minSpeck = Math.max(0, num(p.minSpeck, 0.1));
  const crop = p.fit === 'crop';

  // --- the picture and the part of it we use -------------------------------
  const uploaded = normImage(p.image);
  const img = uploaded || placeholder();
  const s = inkField(img, threshold, invert);
  const panels = findPanels(s, img.w, img.h);
  const wantPanel = Math.max(0, Math.round(num(p.panel, 0)));
  let box = null, panelUsed = 0, panelMissing = false;
  let ref = null;                                   // pixel box the scale is set from
  if (wantPanel > 0 && wantPanel <= panels.length) {
    // One panel of several, printed as one of a matching set: every panel of
    // this picture gets the same scale (mm per source pixel) and the same plate,
    // sized from the largest panel. A panel spans its whole row's height rather
    // than its own ink, so frames in a row line up from plaque to plaque even
    // when a caption box pokes a few pixels above one of them.
    const rowOf = (q) => {
      let y0 = q.y0, y1 = q.y1;
      for (const o of panels) if (o.y0 < q.y1 && o.y1 > q.y0) { y0 = Math.min(y0, o.y0); y1 = Math.max(y1, o.y1); }
      return { y0, y1 };
    };
    const q = panels[wantPanel - 1], row = rowOf(q);
    box = { x0: q.x0, x1: q.x1, y0: row.y0, y1: row.y1 };
    let rw = 0, rh = 0;
    for (const o of panels) { const r = rowOf(o); rw = Math.max(rw, o.x1 - o.x0); rh = Math.max(rh, r.y1 - r.y0); }
    ref = { w: rw, h: rh };
    panelUsed = wantPanel;
  } else {
    if (wantPanel > 0) panelMissing = true;
    box = trimRect(s, img.w, { x0: 0, y0: 0, x1: img.w, y1: img.h });
  }
  const blank = !box;
  if (blank) box = { x0: 0, y0: 0, x1: img.w, y1: img.h };
  if (!ref) ref = { w: box.x1 - box.x0, h: box.y1 - box.y0 };

  // --- sizes ---------------------------------------------------------------
  // k is mm per source pixel, set from `ref`; the plate is ref·k plus margins.
  let m = Math.max(0, num(p.margin, 6));
  const mMax = Math.max(EDGE_CLEAR, (W - 10) / 2);
  const marginClamped = m > mMax;
  if (marginClamped) m = mMax;
  let H, k;
  if (crop) {
    H = clamp(num(p.height, 100), 20, bed.y);
    if (m > (H - 10) / 2) { m = Math.max(EDGE_CLEAR, (H - 10) / 2); }
    const picW = W - 2 * m, picH = H - 2 * m;
    k = Math.max(picW / ref.w, picH / ref.h);         // cover the window, crop the rest
    const cw = Math.min(box.x1 - box.x0, Math.max(1, Math.floor(picW / k + 1e-9)));
    const ch = Math.min(box.y1 - box.y0, Math.max(1, Math.floor(picH / k + 1e-9)));
    box = cropBox(box, cw, ch);
  } else {
    k = (W - 2 * m) / ref.w;
    H = ref.h * k + 2 * m;
    if (H > bed.y) {
      // Too tall for the bed at this width: keep the width, shrink the drawing.
      k = (bed.y - 2 * m) / ref.h;
      H = bed.y;
      notes.push(`At ${W} mm wide the drawing would be taller than the ${bed.y} mm bed, so it has been shrunk to ` +
        `${(ref.w * k).toFixed(0)} × ${(ref.h * k).toFixed(0)} mm and centred.`);
    }
  }
  const pxW = box.x1 - box.x0, pxH = box.y1 - box.y0;
  const ox = -(pxW * k) / 2, oy = (pxH * k) / 2;       // picture centred on the origin
  const topMargin = (H - pxH * k) / 2;

  // --- trace ---------------------------------------------------------------
  let traced = [], counters = [], specks = 0, pinholes = 0;
  if (!blank) {
    const sub = new Float32Array(pxW * pxH);
    for (let y = 0; y < pxH; y++) for (let x = 0; x < pxW; x++) sub[y * pxW + x] = s[(box.y0 + y) * img.w + box.x0 + x];
    const eps = SIMPLIFY_PX[quality] * k;
    const rings = [];
    for (const r of traceContours(sub, pxW, pxH)) {
      const mm = r.map(q => [ox + q[0] * k, oy - q[1] * k]);
      const simp = P.simplify(mm, eps);
      if (simp.length >= 3 && P.area(simp) >= MIN_RING_AREA) rings.push(simp);
    }
    for (const sh of contoursToShapes(rings, { minArea: 0 })) {
      if (P.area(sh[0]) < minSpeck) { specks++; continue; }
      const holes = [];
      for (let i = 1; i < sh.length; i++) { if (P.area(sh[i]) < minSpeck) pinholes++; else holes.push(sh[i]); }
      traced.push([P.ensureCCW(sh[0]), ...holes.map(P.ensureCW)]);
      for (const hh of holes) counters.push(hh);
    }
  }

  // --- thicken (the offset's winding fill is also the union) ---------------
  // At zero thickening a hair of offset is still taken, so a ring that the
  // simplifier folded over itself is resolved by the winding fill rather than
  // handed to the ear clipper.
  const delta = Math.max(thicken / 2, 1e-4);
  let ink = traced.length ? dropSpecks(P.offset(traced, delta, { join: 'round', arcTolerance: tol })) : [];

  // Counters: a hole in the traced ink that has no hole of the thickened ink
  // inside it was filled by the thickening.
  const inkHoles = [];
  for (const sh of ink) for (let i = 1; i < sh.length; i++) inkHoles.push(sh[i]);
  const holeProbe = inkHoles.map(r => insidePoint(r)).filter(Boolean);
  let filled = 0;
  for (const c of counters) if (!holeProbe.some(pt => P.pointInRing(pt, c))) filled++;

  // --- plate, border, holes ------------------------------------------------
  const rMax = Math.min(W, H) / 2 - 0.05;
  const r = clamp(num(p.cornerRadius, 3), 0, Math.max(0, rMax));
  const outline = dedupeRing(r > 1e-3 ? P.roundRect(W, H, r, { segs: nseg(12, sf, 4) }) : P.rect(W, H));
  const sign = dropSpecks(P.offset([outline], -EDGE_CLEAR, { join: 'miter' }));

  let clipped = false;
  if (ink.length && sign.length) {
    const outside = ink.some(sh => sh[0].some(pt => !P.pointInShape(pt, sign[0])));
    if (outside) { ink = dropSpecks(P.boolean(ink, sign, 'intersection')); clipped = true; }
  }

  let border = [];
  const bw = num(p.borderWidth, 2.4);
  if (p.border && sign.length) {
    const inner = dropSpecks(P.offset(sign, -bw, { join: 'miter' }));
    if (inner.length) border = dropSpecks(P.boolean(sign, inner, 'difference'));
    else notes.push('The border is wider than the plate and was left off.');
  }

  const holes = [];
  const holeD = clamp(num(p.holeDiameter, 4), 1, 20);
  if (p.holes === 'top' || p.holes === 'corners') {
    const hr = holeD / 2, inset = Math.max(EDGE_CLEAR + 1.2 + hr, m / 2);
    const cy = H / 2 - inset;
    const xs = p.holes === 'top' ? [0] : [-W / 2 + inset, W / 2 - inset];
    const guard = P.offset([outline], -1.2, { join: 'miter' });
    for (const cx of xs) {
      const ring = P.ensureCW(P.circle(hr, { segs: nseg(28, sf, 10), cx, cy }));
      if (guard.length && ring.every(pt => P.pointInRing(pt, guard[0][0]))) holes.push({ ring, c: [cx, cy], r: hr });
    }
    if (holes.length < xs.length) notes.push('A hanging hole does not fit inside the plate edge and was left out.');
  }

  let raised = ink;
  if (border.length) raised = raised.length ? dropSpecks(P.boolean(raised, border, 'union')) : border;
  let holeCut = false;
  if (holes.length && raised.length) {
    const keep = holes.map(hh => [P.ensureCCW(P.circle(hh.r + 1.5, { segs: nseg(28, sf, 10), cx: hh.c[0], cy: hh.c[1] }))]);
    const before = totalArea(raised);
    raised = dropSpecks(P.boolean(raised, keep, 'difference'));
    holeCut = before - totalArea(raised) > 1e-3;
  }

  return {
    W, H, T, relief, margin: m, topMargin, marginClamped, picW: pxW * k, picH: pxH * k, mmPerPx: k, ref,
    thicken, delta, threshold, invert, quality, sf, tol, bed,
    uploaded: !!uploaded, placeholder: !uploaded, blank, imgW: img.w, imgH: img.h,
    panels, panelUsed, panelMissing, box, crop,
    traced, counters, filled, specks, pinholes, ink, raised, border, holes, holeCut, clipped,
    outline, cornerRadius: r, notes,
  };
}

// ---------------------------------------------------------------------------
// Line-width audit (validate only)
// ---------------------------------------------------------------------------

/**
 * How wide the finished lines are, measured with rays through them: from points
 * every `step` mm along every edge, a ray goes straight into the material and
 * the distance to the far wall is the local line width. A hit only counts when
 * the far wall faces back along the ray (within 60°), which is what a strip of
 * line looks like; a ray that grazes out through a neighbouring edge at a corner
 * is a crease, not a line, and is skipped. That skip is the whole difference
 * from the analysis panel's wall thickness, which reads low at every crease.
 *
 * An opening (erode then regrow) was the first design. poly2d's winding fill
 * does not survive regrowing a comic frame eroded to half a millimetre. The
 * frame came back as nothing and 934 mm² of ordinary line was reported thin,
 * so it is measured directly instead.
 *
 * Returns the thinnest width seen (a stroke's chamfered end counts, so this is
 * pessimistic), the median width of the thin samples (what most of the thin
 * line measures), and the length of line (both walls counted once) under
 * `limit`.
 */
export function lineWidths(shapes, limit = THIN_LINE, step = 0.2) {
  const edges = [];
  for (const sh of shapes) {
    for (let r = 0; r < sh.length; r++) {
      const ring = r === 0 ? P.ensureCCW(sh[r]) : P.ensureCW(sh[r]);     // material on the left
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        if (L > 1e-9) edges.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], L, nx: -dy / L, ny: dx / L });
      }
    }
  }
  if (!edges.length) return { thinnest: null, thinLength: 0, samples: 0 };
  // Uniform grid over the edges, cells a little bigger than the longest ray.
  const reach = limit * 1.25, cell = Math.max(0.5, reach);
  let x0 = Infinity, y0 = Infinity;
  for (const e of edges) { x0 = Math.min(x0, e.ax, e.bx); y0 = Math.min(y0, e.ay, e.by); }
  const grid = new Map();
  const key = (i, j) => i * 1000003 + j;
  edges.forEach((e, k) => {
    const i0 = Math.floor((Math.min(e.ax, e.bx) - x0) / cell), i1 = Math.floor((Math.max(e.ax, e.bx) - x0) / cell);
    const j0 = Math.floor((Math.min(e.ay, e.by) - y0) / cell), j1 = Math.floor((Math.max(e.ay, e.by) - y0) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const kk = key(i, j); let c = grid.get(kk); if (!c) grid.set(kk, c = []); c.push(k);
    }
  });
  let thinnest = Infinity, thin = 0, samples = 0;
  const thinW = [];
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    const n = Math.max(1, Math.round(e.L / step)), seg = e.L / n;
    for (let s = 0; s < n; s++) {
      const t = (s + 0.5) / n;
      const px = e.ax + (e.bx - e.ax) * t, py = e.ay + (e.by - e.ay) * t;
      const qx = px + e.nx * reach, qy = py + e.ny * reach;
      const i0 = Math.floor((Math.min(px, qx) - x0) / cell), i1 = Math.floor((Math.max(px, qx) - x0) / cell);
      const j0 = Math.floor((Math.min(py, qy) - y0) / cell), j1 = Math.floor((Math.max(py, qy) - y0) / cell);
      let best = Infinity, facing = false;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = grid.get(key(i, j)); if (!c) continue;
        for (const m of c) {
          if (m === k) continue;
          const f = edges[m];
          // Ray p + u·n against segment a + v·(b - a).
          const ex = f.bx - f.ax, ey = f.by - f.ay;
          const den = e.nx * ey - e.ny * ex;
          if (Math.abs(den) < 1e-12) continue;
          const wx = f.ax - px, wy = f.ay - py;
          const u = (wx * ey - wy * ex) / den;
          const v = (wx * e.ny - wy * e.nx) / den;
          if (u <= 1e-9 || u >= best || v < 0 || v > 1) continue;
          best = u; facing = (f.nx * e.nx + f.ny * e.ny) < -0.5;
        }
      }
      samples++;
      if (best < reach && facing) {
        if (best < thinnest) thinnest = best;
        if (best < limit) { thin += seg; thinW.push(best); }
      }
    }
  }
  thinW.sort((a, b) => a - b);
  return { thinnest: isFinite(thinnest) ? thinnest : null, thinLength: thin / 2, samples,
           typical: thinW.length ? thinW[thinW.length >> 1] : null };
}

function planWidths(plan) {
  if (!plan.widths) plan.widths = lineWidths(plan.raised);
  return plan.widths;
}

/** Counters (enclosed gaps in the raised ink) narrower than two extrusions. */
function narrowCounters(raised, limit = MIN_LINE, tol = 0.02) {
  let n = 0;
  for (const sh of raised) {
    for (let i = 1; i < sh.length; i++) {
      const gap = [[P.ensureCCW(sh[i])]];
      if (!P.offset(gap, -limit / 2, { join: 'round', arcTolerance: tol }).length) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Mesh assembly (nameplate.js's raised mode)
// ---------------------------------------------------------------------------

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
function strip(m, lo, hi) {
  const n = lo.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], lo[j], hi[j], hi[i]); }
}
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
function prismUp(m, shapes, z0, h) {
  for (const shape of shapes) for (const ring of shape) strip(m, addRingAt(m, ring, z0), addRingAt(m, ring, z0 + h));
  capShapes(m, shapes, z0 + h, true);
}

function assemble(plan, ca, sa) {
  const m = new Mesh();
  const { T, relief } = plan;
  const outer = rotRing(plan.outline, ca, sa);
  const through = plan.holes.map(hh => rotRing(hh.ring, ca, sa));
  const raised = rotShapes(plan.raised, ca, sa).map(sh => [P.ensureCCW(sh[0]), ...sh.slice(1).map(P.ensureCW)]);
  strip(m, addRingAt(m, outer, 0), addRingAt(m, outer, T));
  for (const ring of through) strip(m, addRingAt(m, ring, 0), addRingAt(m, ring, T));
  capShapes(m, nestRings([outer, ...through]), 0, false);
  capShapes(m, nestRings([outer, ...through, ...ringsOf(raised)]), T, true);
  if (raised.length) prismUp(m, raised, T, relief);
  return m.weld(1e-6).compact();
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="1.5"/>' +
  '<circle cx="9" cy="9" r="2"/><path d="M9 11v4l-2 3M9 15l2 3M9 12.5l3-1"/><path d="M14 8h5M14 10.5h3.5"/></svg>';

function colourZ(T) { return Math.round(T * 1000) / 1000; }

const gen = {
  id: 'comic',
  name: 'Comic plaque',
  category: 'Decor',
  blurb: 'A black-on-white line drawing as a two-colour plaque, the lines raised above the plate.',
  description:
    'Upload a line drawing (a webcomic panel, a sketch, a signature) and the dark lines are traced ' +
    'into outlines, thickened so they survive a 0.4 mm nozzle, and stood on a flat plate. Print the ' +
    'plate in one colour and swap filament at the plate top: everything above it is the drawing. ' +
    'A strip of panels can be split at its gutters and one panel printed on its own, which is what ' +
    'keeps hand lettering big enough to read.',
  icon: ICON,
  version: 1,

  params: [
    { key: 'image', label: 'Drawing', type: 'image', maxSize: 1024, group: 'Picture',
      help: 'A black-on-white line drawing (PNG is best; a JPEG works with a higher speck filter). Until one is loaded a stand-in stick figure is shown.' },
    { key: 'panel', label: 'Panel', type: 'int', def: 0, min: 0, max: 12, step: 1, group: 'Picture',
      help: '0 prints the whole picture. 1, 2, 3... pick one panel of a strip or grid, found at the white gutters between frames, numbered row by row.' },
    { key: 'threshold', label: 'Ink threshold', type: 'number', def: 0.5, min: 0.05, max: 0.95, step: 0.01, group: 'Picture',
      help: 'Grey level (0 black, 1 white) below which a pixel counts as a line. Raise it to catch faint pencil, lower it to drop grey shading.' },
    { key: 'invert', label: 'White on black', type: 'bool', def: false, group: 'Picture',
      help: 'Raise the light lines of a white-on-black drawing instead of the dark ones.' },
    { key: 'minSpeck', label: 'Speck filter', type: 'number', unit: 'mm²', def: 0.1, min: 0, max: 20, step: 0.05, group: 'Picture',
      help: 'Printed specks smaller than this area are dropped, and pinholes this small inside a line are filled. JPEG noise lives here; a full stop in the lettering is about 0.2 mm².' },
    { key: 'fit', label: 'Fit', type: 'enum', def: 'aspect', group: 'Picture',
      options: [
        { v: 'aspect', label: 'Keep the aspect', help: 'The plate height follows from the width and the drawing.' },
        { v: 'crop', label: 'Crop to size', help: 'Both sizes are yours; the drawing is cropped about its centre.' },
      ],
      help: 'Whether the plate follows the drawing or the drawing is cropped to the plate.' },

    { key: 'width', label: 'Plate width', type: 'number', unit: 'mm', def: 150, min: 40, max: 180, step: 1, group: 'Size',
      help: 'Overall width including the margin. The A1 mini bed is 180 mm; a drawing that would come out taller than that is shrunk to fit.' },
    { key: 'height', label: 'Plate height', type: 'number', unit: 'mm', def: 100, min: 30, max: 180, step: 1, group: 'Size',
      showIf: (p) => p.fit === 'crop',
      help: 'Only used when cropping; otherwise the height follows the drawing.' },
    { key: 'margin', label: 'Margin', type: 'number', unit: 'mm', def: 6, min: 2, max: 30, step: 0.5, group: 'Size',
      help: 'Plain plate between the drawing and the edge, on the narrower sides.' },
    { key: 'cornerRadius', label: 'Corner radius', type: 'number', unit: 'mm', def: 3, min: 0, max: 20, step: 0.5, group: 'Size',
      help: 'Rounds the plate corners. 0 for square.' },

    { key: 'thicken', label: 'Thicken lines', type: 'number', unit: 'mm', def: 0.4, min: 0, max: 2, step: 0.05, group: 'Lines',
      help: 'Added to every line\'s width (half each side). A 2 px line on a 740 px strip printed 150 wide is 0.4 mm; thickening by 0.4 makes it 0.8 mm. Lines of 0.4 to 0.5 mm printed cleanly on an A1 mini with a 0.4 mm nozzle (comic panels at 50%, 2026-09-27), so the warning starts under 0.5 mm. Thickening also fills small counters.' },
    { key: 'plateThickness', label: 'Plate thickness', type: 'number', unit: 'mm', def: 2, min: 0.8, max: 6, step: 0.2, group: 'Lines',
      help: 'Colour 1. The filament change goes at exactly this height, so keep it a multiple of your layer height.' },
    { key: 'reliefHeight', label: 'Line height', type: 'number', unit: 'mm', def: 0.8, min: 0.4, max: 5, step: 0.2, group: 'Lines',
      help: 'How far the lines stand proud, in colour 2. 0.8 mm is four 0.2 mm layers.' },

    { key: 'border', label: 'Raised border', type: 'bool', def: false, group: 'Frame',
      help: 'A rim round the plate in the line colour.' },
    { key: 'borderWidth', label: 'Border width', type: 'number', unit: 'mm', def: 2.4, min: 0.8, max: 10, step: 0.2, group: 'Frame',
      showIf: (p) => !!p.border, help: 'Width of the rim.' },
    { key: 'holes', label: 'Hanging holes', type: 'enum', def: 'none', group: 'Frame',
      options: [
        { v: 'none', label: 'None' },
        { v: 'top', label: 'One, top centre', help: 'For a nail or a picture hook.' },
        { v: 'corners', label: 'Two, top corners', help: 'Hangs level on two pins or a string.' },
      ],
      help: 'Through-holes in the top margin. The lines are cleared back 1.5 mm round each.' },
    { key: 'holeDiameter', label: 'Hole diameter', type: 'number', unit: 'mm', def: 4, min: 2, max: 8, step: 0.5, group: 'Frame',
      showIf: (p) => p.holes && p.holes !== 'none', help: 'A 4 mm hole takes a panel pin or picture-hook nail.' },
  ],

  presets: [
    { name: 'Comic panel', values: { width: 150, fit: 'aspect', margin: 6, thicken: 0.4, border: false, holes: 'none' } },
    { name: 'Framed for the wall', values: { width: 170, margin: 10, border: true, borderWidth: 3, holes: 'top', thicken: 0.5 } },
    { name: 'Coaster square', values: { width: 95, fit: 'crop', height: 95, margin: 4, cornerRadius: 8, border: true, borderWidth: 2, thicken: 0.5 } },
    { name: 'White on black', values: { width: 120, invert: true, plateThickness: 1.6, reliefHeight: 0.6 } },
  ],

  build(p, ctx = {}) {
    const plan = planFor(p, ctx);
    let best = null, audit = null, used = 0, tries = 0;
    for (let i = 0; i < ASSEMBLY_ANGLES.length; i++) {
      const ang = ASSEMBLY_ANGLES[i];
      const mesh = assemble(plan, Math.cos(ang), Math.sin(ang));
      const a = surfaceAudit(mesh);
      tries = i + 1;
      if (a.ok) { best = mesh; audit = a; used = i; break; }
      if (!audit || a.score < audit.score) { best = mesh; audit = a; used = i; }
    }
    const notes = [...plan.notes];
    if (!audit.ok) {
      notes.push(`The surface did not close cleanly at any of ${ASSEMBLY_ANGLES.length} assembly angles ` +
        `(${audit.boundary} open edges, ${audit.nonManifold} non-manifold). Nudge the threshold or the thickening.`);
    }
    const ang = ASSEMBLY_ANGLES[used];
    const body = (ang ? best.rotateZ(-ang) : best).place();

    const { W, H, T, relief } = plan;
    const dims = [
      { param: 'plateThickness', label: 'colour change', from: [W / 2, 0, 0], to: [W / 2, 0, T], offset: [1, 0, 0] },
      { param: 'margin', from: [0, H / 2, T], to: [0, H / 2 - plan.topMargin, T], offset: [0, 1, 0],
        ...(Math.abs(plan.topMargin - num(p.margin, 6)) > 1e-6 ? { value: Math.round(plan.topMargin * 100) / 100 } : {}) },
    ];
    const first = plan.raised.length ? plan.raised[0][0][0] : null;
    if (first) dims.push({ param: 'reliefHeight', from: [first[0], first[1], T], to: [first[0], first[1], T + relief], offset: [0, -1, 0] });
    if (plan.holes.length) {
      const hh = plan.holes[0];
      dims.push({ param: 'holeDiameter', from: [hh.c[0] - hh.r, hh.c[1], T], to: [hh.c[0] + hh.r, hh.c[1], T], offset: [0, 1, 0] });
    }
    if (plan.border.length) {
      const x = W / 2 - EDGE_CLEAR;
      dims.push({ param: 'borderWidth', from: [x, 0, T + relief], to: [x - num(p.borderWidth, 2.4), 0, T + relief], offset: [0, 0, 1] });
    }

    return {
      mesh: body,
      meta: {
        dims,
        colourChangeZ: colourZ(T),
        reliefTopZ: colourZ(T + relief),
        size: [Math.round(W * 100) / 100, Math.round(H * 100) / 100],
        picture: [Math.round(plan.picW * 100) / 100, Math.round(plan.picH * 100) / 100],
        mmPerPixel: Math.round(plan.mmPerPx * 10000) / 10000,
        panels: plan.panels.length,
        panel: plan.panelUsed,
        placeholder: plan.placeholder,
        shapes: plan.raised.length,
        counters: plan.counters.length,
        countersFilled: plan.filled,
        specksDropped: plan.specks,
        pinholesFilled: plan.pinholes,
        clipped: plan.clipped,
        watertight: audit.ok,
        assemblyTries: tries,
        notes,
      },
    };
  },

  validate(p) {
    const issues = [];
    if (p.image && !normImage(p.image)) {
      issues.push({ param: 'image', severity: 'error', message: 'This picture could not be read; the stand-in drawing is shown instead.' });
    }
    let plan;
    try { plan = planFor(p, {}); } catch (e) {
      return [...issues, { severity: 'error', message: `Tracing failed: ${e.message}` }];
    }
    if (plan.placeholder && !p.image) {
      issues.push({ param: 'image', severity: 'warn', message: 'No drawing loaded, so this is a stand-in stick figure. Upload a black-on-white PNG.' });
    }
    for (const n of plan.notes) issues.push({ severity: 'warn', message: n });
    if (plan.blank) {
      issues.push({ param: 'threshold', severity: 'warn',
        message: `Nothing in the picture is ${plan.invert ? 'lighter' : 'darker'} than the ${plan.threshold} threshold, so the plate is blank.` });
      return issues;
    }
    const n = plan.panels.length;
    if (plan.panelMissing) {
      issues.push({ param: 'panel', severity: 'warn',
        message: `Found ${n} panel${n === 1 ? '' : 's'}; there is no panel ${p.panel}, so the whole picture is used.` });
    } else {
      issues.push({ param: 'panel', severity: 'info',
        message: n > 1 ? `Found ${n} panels${plan.panelUsed ? `; printing panel ${plan.panelUsed}` : ' (set Panel to print one on its own)'}.`
                       : 'Found one panel (no white gutters to split at).' });
    }
    if (plan.marginClamped) {
      issues.push({ param: 'margin', severity: 'warn', message: `A ${p.margin} mm margin leaves no drawing on a ${plan.W} mm plate; it was cut to ${plan.margin.toFixed(1)} mm.` });
    }

    const lw = planWidths(plan);
    if (lw.thinLength >= THIN_REPORT) {
      const w = lw.thinnest;
      issues.push({ param: 'thicken', severity: 'warn',
        message: `About ${lw.thinLength.toFixed(0)} mm of line comes out under ${THIN_LINE} mm wide, the thinnest about ${w.toFixed(2)} mm ` +
          `(most of it about ${lw.typical.toFixed(2)} mm). ` +
          `Lines of 0.4 to 0.5 mm have printed cleanly on an A1 mini with a ${NOZZLE} mm nozzle; narrower is untested. Thicken by about ` +
          `${(num(p.thicken, 0.4) + (THIN_LINE - w)).toFixed(2)} mm, or print it bigger.` });
    }
    if (plan.filled) {
      issues.push({ param: 'thicken', severity: 'warn',
        message: `${plan.filled} enclosed gap${plan.filled === 1 ? '' : 's'} (the insides of letters like o, e, a) filled in when the lines were thickened. Thicken less or print it wider.` });
    }
    const narrow = narrowCounters(plan.raised);
    if (narrow) {
      issues.push({ param: 'thicken', severity: 'warn',
        message: `${narrow} enclosed gap${narrow === 1 ? ' is' : 's are'} narrower than ${MIN_LINE} mm; the slicer will close ${narrow === 1 ? 'it' : 'them'} up and the letter reads as a blob.` });
    }
    if (plan.clipped) {
      issues.push({ param: 'margin', severity: 'info', message: 'The thickened lines reached the plate edge and were trimmed 1 mm inside it.' });
    }
    if (plan.holeCut) {
      issues.push({ param: 'holes', severity: 'warn', message: 'A hanging hole sits on the drawing; the lines are cleared back round it. A bigger margin moves it clear.' });
    }
    if (plan.specks || plan.pinholes) {
      issues.push({ param: 'minSpeck', severity: 'info',
        message: `Dropped ${plan.specks} speck${plan.specks === 1 ? '' : 's'} and filled ${plan.pinholes} pinhole${plan.pinholes === 1 ? '' : 's'} under ${p.minSpeck} mm².` });
    }
    const layers = p.plateThickness / 0.2;
    if (Math.abs(layers - Math.round(layers)) > 1e-6) {
      issues.push({ param: 'plateThickness', severity: 'warn',
        message: `${p.plateThickness} mm is not a whole number of 0.2 mm layers, so the colour change lands part-way through a layer.` });
    }
    return issues;
  },

  hints(p) {
    const T = num(p.plateThickness, 2), relief = num(p.reliefHeight, 0.8), layerH = 0.2;
    const layer = Math.round(T / layerH) + 1;
    const notes = [
      `Colour change at Z = ${colourZ(T).toFixed(2)} mm, the top of the plate. Everything below is colour 1 (the ground), ` +
      `everything from ${colourZ(T).toFixed(2)} to ${colourZ(T + relief).toFixed(2)} mm is the drawing. At ${layerH} mm layers ` +
      `the first line layer is layer ${layer}: in Bambu Studio's preview drag the layer slider to it (it reads ` +
      `${(T + layerH).toFixed(2)} mm) and add a filament change there, pointing it at the AMS slot with the line colour. ` +
      'The Bambu project download has that change already set.',
      'Flat on the plate, lines up. Nothing overhangs, so no supports.',
      'Set top surface pattern to monotonic and keep ironing off: ironing drags the line colour sideways off the edges.',
    ];
    if (relief < 2 * layerH) notes.push(`A ${relief} mm relief is under two layers; the colour will read but the lines will look flat.`);
    return {
      profile: '0.20 mm standard',
      layerH,
      walls: 2,
      infill: 15,
      supports: false,
      brim: false,
      filament: 'PLA, two colours',
      colourChangeZ: colourZ(T),
      notes,
    };
  },
};

export default gen;
