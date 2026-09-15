// Plate packing.
//
// Slicing one object at a time is a toy: half of what this printer is for is
// making six of something. So Bluesheet keeps a plate, packs the footprints onto it
// here, and hands the slicer a single pre-arranged model with --arrange 0. Doing
// the packing ourselves rather than letting OrcaSlicer arrange means the preview
// on screen is the layout that actually prints, which matters when you are
// deciding whether a seventh bin will fit.
//
// The algorithm is MaxRects with the best-short-side-fit heuristic and optional
// 90-degree rotation. It is the right trade here: a few hundred lines, no
// dependencies, and within a few percent of optimal on the small item counts a
// 180 mm bed can hold. A shelf packer would be simpler and noticeably worse at
// exactly the mixed-size case this sees — one tall bin beside four small clips.
//
// Coordinates are millimetres in PLATE SPACE: the origin is the centre of the
// bed, x to the right, y away from you, matching the way every generator centres
// its mesh. toBedCoords() converts to the printer's front-left origin at the one
// point where that convention is needed.

import { Mesh } from './mesh.js';

export const A1_MINI_BED = { x: 180, y: 180, z: 180 };

/** Excluded strip along the front edge where the A1 purges; keep parts out of it. */
export const DEFAULT_MARGIN = 5;

/**
 * @param items [{id, w, d, qty?, rotatable?, meta?}]  footprints in mm
 * @param bed   {x, y}
 * @param opts  {gap, margin, allowRotate, sort}
 * @returns {placed, unplaced, used, fill, bed}
 *   placed:   [{id, index, x, y, w, d, rot, meta}]  x/y are the CENTRE, plate space
 *   unplaced: [{id, index, w, d, reason}]
 */
export function pack(items, bed = A1_MINI_BED, opts = {}) {
  const { gap = 3, margin = DEFAULT_MARGIN, allowRotate = true, sort = 'area' } = opts;
  // The gap is carried inside each rectangle, which is what keeps parts apart
  // without a separate spacing pass. The consequence is that the outermost parts
  // would also carry half a gap against the plate edge, wasting a gap's width of
  // bed for nothing — so the usable area is widened by one gap to put those outer
  // half-gaps inside the margin, which is already clearance.
  const W = bed.x - margin * 2 + gap, D = bed.y - margin * 2 + gap;
  if (!(W > 0 && D > 0)) throw new Error(`pack: margin ${margin} mm leaves no room on a ${bed.x}x${bed.y} bed`);

  // Expand quantities into individual instances, remembering where each came from.
  const instances = [];
  items.forEach((it, i) => {
    const qty = Math.max(1, Math.round(it.qty ?? 1));
    for (let k = 0; k < qty; k++) {
      instances.push({
        id: it.id, index: i, copy: k, meta: it.meta,
        w: it.w + gap, d: it.d + gap,       // gap is carried inside the rectangle,
        rawW: it.w, rawD: it.d,             // which is what keeps parts apart
        rotatable: allowRotate && (it.rotatable ?? true),
      });
    }
  });

  const order = instances.slice();
  if (sort === 'area') order.sort((a, b) => (b.w * b.d) - (a.w * a.d) || Math.max(b.w, b.d) - Math.max(a.w, a.d));
  else if (sort === 'longest') order.sort((a, b) => Math.max(b.w, b.d) - Math.max(a.w, a.d));
  else if (sort === 'height') order.sort((a, b) => (b.meta?.h ?? 0) - (a.meta?.h ?? 0));

  // free rectangles, in a local space with origin at the plate's lower-left usable corner
  let free = [{ x: 0, y: 0, w: W, d: D }];
  const placed = [], unplaced = [];

  for (const it of order) {
    const spot = bestSpot(free, it);
    if (!spot) {
      unplaced.push({ id: it.id, index: it.index, w: it.rawW, d: it.rawD,
        reason: it.rawW > W || it.rawD > D
          ? `${it.rawW.toFixed(1)} x ${it.rawD.toFixed(1)} mm does not fit a ${W.toFixed(0)} x ${D.toFixed(0)} mm printable area`
          : 'no room left on the plate' });
      continue;
    }
    const { x, y, w, d, rot } = spot;
    placed.push({
      id: it.id, index: it.index, copy: it.copy, meta: it.meta, rot,
      w: rot ? it.rawD : it.rawW, d: rot ? it.rawW : it.rawD,
      // back to plate space: centre of the rectangle, bed centred on the origin
      x: x + w / 2 - W / 2, y: y + d / 2 - D / 2,
    });
    free = split(free, { x, y, w, d });
    free = prune(free);
  }

  const used = extent(placed);
  return {
    placed, unplaced, bed,
    used,
    fill: placed.reduce((s, p) => s + p.w * p.d, 0) / (W * D),
  };
}

/** Best short side fit: the placement leaving the least slack on its tighter axis. */
function bestSpot(free, it) {
  let best = null, bestShort = Infinity, bestLong = Infinity;
  for (const f of free) {
    for (const rot of it.rotatable ? [false, true] : [false]) {
      const w = rot ? it.d : it.w, d = rot ? it.w : it.d;
      if (w > f.w + 1e-9 || d > f.d + 1e-9) continue;
      const leftover = [f.w - w, f.d - d];
      const shortSide = Math.min(...leftover), longSide = Math.max(...leftover);
      if (shortSide < bestShort - 1e-9 || (Math.abs(shortSide - bestShort) < 1e-9 && longSide < bestLong - 1e-9)) {
        best = { x: f.x, y: f.y, w, d, rot };
        bestShort = shortSide; bestLong = longSide;
      }
    }
  }
  return best;
}

/** Guillotine-free MaxRects split: every free rect overlapping the placement is cut. */
function split(free, used) {
  const out = [];
  for (const f of free) {
    if (!overlaps(f, used)) { out.push(f); continue; }
    if (used.x > f.x) out.push({ x: f.x, y: f.y, w: used.x - f.x, d: f.d });
    if (used.x + used.w < f.x + f.w) out.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - (used.x + used.w), d: f.d });
    if (used.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, d: used.y - f.y });
    if (used.y + used.d < f.y + f.d) out.push({ x: f.x, y: used.y + used.d, w: f.w, d: f.y + f.d - (used.y + used.d) });
  }
  return out.filter(r => r.w > 1e-6 && r.d > 1e-6);
}

/** Drop any free rectangle wholly inside another — without this the list explodes. */
function prune(free) {
  const out = [];
  for (let i = 0; i < free.length; i++) {
    let contained = false;
    for (let j = 0; j < free.length && !contained; j++) {
      if (i !== j && inside(free[i], free[j]) && !(inside(free[j], free[i]) && j > i)) contained = true;
    }
    if (!contained) out.push(free[i]);
  }
  return out;
}

const overlaps = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.d - 1e-9 && b.y < a.y + a.d - 1e-9;
const inside = (a, b) => a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9 && a.x + a.w <= b.x + b.w + 1e-9 && a.y + a.d <= b.y + b.d + 1e-9;

function extent(placed) {
  if (!placed.length) return { w: 0, d: 0, min: [0, 0], max: [0, 0] };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of placed) {
    x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2);
    y0 = Math.min(y0, p.y - p.d / 2); y1 = Math.max(y1, p.y + p.d / 2);
  }
  return { w: x1 - x0, d: y1 - y0, min: [x0, y0], max: [x1, y1] };
}

/**
 * Build a plate from meshes and a packing. Each mesh is centred in X/Y and
 * resting on z=0 by the generator contract, so placing it is a rotate and a
 * translate — no re-centring, and no chance of an object drifting off the bed
 * because someone's bounding box was asymmetric.
 */
export function layout(meshesById, packing) {
  const parts = [];
  for (const p of packing.placed) {
    const src = meshesById[p.id];
    if (!src) throw new Error(`layout: no mesh for "${p.id}"`);
    const m = (p.rot ? src.rotateZ(Math.PI / 2) : src).translate(p.x, p.y, 0);
    parts.push({ ...p, mesh: m });
  }
  return { parts, mesh: Mesh.merge(parts.map(p => p.mesh)) };
}

/**
 * Plate space (origin at the bed centre) to printer space (origin at the bed's
 * front-left corner). Only used when writing the STL the slicer will see with
 * --arrange 0; everything else stays centred.
 */
export function toBedCoords(mesh, bed = A1_MINI_BED) {
  return mesh.translate(bed.x / 2, bed.y / 2, 0);
}

/** Does every placed part sit inside the printable area? Cheap, and worth asserting. */
export function withinBed(packing, bed = A1_MINI_BED, margin = DEFAULT_MARGIN) {
  const hx = bed.x / 2 - margin, hy = bed.y / 2 - margin;
  // Checked against the raw footprint, never the gap-inflated rectangle: the gap
  // is spacing between parts, not a keep-out from the bed edge.
  return packing.placed.every(p =>
    p.x - p.w / 2 >= -hx - 1e-6 && p.x + p.w / 2 <= hx + 1e-6 &&
    p.y - p.d / 2 >= -hy - 1e-6 && p.y + p.d / 2 <= hy + 1e-6);
}

/** Do any two placed parts overlap? Must be false, always. */
export function anyOverlap(packing, clearance = 0) {
  const p = packing.placed;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    const a = p[i], b = p[j];
    const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
    const dy = Math.abs(a.y - b.y) - (a.d + b.d) / 2;
    if (dx < -1e-9 - clearance && dy < -1e-9 - clearance) return { a, b, dx, dy };
  }
  return null;
}
