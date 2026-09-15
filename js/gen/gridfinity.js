// Gridfinity — bins and baseplates to the published specification.
//
// The numbers in here are not mine to choose. A bin printed on this machine has
// to drop into a baseplate someone else printed in another country two years
// ago, and the only way to discover that it does not is to print it. So every
// dimension below is traceable to the specification at gridfinity.xyz and to
// the reference OpenSCAD implementation (kennetek/gridfinity-rebuilt-openscad,
// src/core/standard.scad and src/core/gridfinity-baseplate.scad), and the test
// suite measures them back off the built mesh rather than off these constants.
//
// The three profiles that matter are ONE profile:
//
//   bin base      x = 0.80 → 1.60 → 1.60 → 3.75   over z = 0 → 0.8 → 2.6 → 4.75
//   socket        the same profile grown 0.25 mm sideways, cut off at 4.65 deep
//   stacking lip  the same socket, cut off where it reaches the bin's own wall
//
// where x is the outward offset from a sharp-cornered "path" rectangle, so x is
// simultaneously the corner radius and half the width increase. That single
// framing is why the published corner radii (3.75 / 1.6 / 0.8 on the bin, 4.0 /
// 1.85 / 1.15 on the socket) fall out of the widths for free, and why the lip
// height 4.4 is not an independent magic number: the socket is 4.65 deep and
// the last 0.25 mm of it is the clearance, so 4.65 − 0.25 = 4.40.
//
// Everything is built by sweeping a rounded rectangle rather than by CSG. A
// gridfinity bin is a solid of revolution about a rectangle instead of a point,
// and once you say it that way the base, the lip, the scoop, the label tab and
// the dividers are all the same operation with a different profile.

import { Mesh, TAU } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { clamp, num } from '../kernel/scalar.js';

// ---------------------------------------------------------------------------
// The specification
// ---------------------------------------------------------------------------

/** Grid pitch. The whole system is built on this. */
export const PITCH = 42.0;
/** One height unit. Bin bodies are whole multiples of it. */
export const UNIT_H = 7.0;
/** Clearance per side between a bin base and the socket it drops into. */
export const CLEAR = 0.25;
/** A single bin's footprint: 42 − 2 × 0.25. */
export const BIN_SPAN = PITCH - 2 * CLEAR;            // 41.5
/** Corner radius at the top of a bin's base (spec: 7.5 mm diameter). */
export const R_BIN = 3.75;
/** Corner radius at the top of a baseplate socket (spec: 8 mm diameter). */
export const R_SOCKET = R_BIN + CLEAR;                // 4.0
/** Height of the three-stage base profile. */
export const BASE_H = 4.75;                           // 0.8 + 1.8 + 2.15
/** Depth of a baseplate socket, measured from the plate's top face. */
export const SOCKET_H = 4.65;                         // 0.7 + 1.8 + 2.15
/** Height of a stacking lip above the bin body. */
export const LIP_H = SOCKET_H - CLEAR;                // 4.4
/** Magnet/screw hole centres: ±13 mm from a unit centre, so 26 mm apart. */
export const HOLE_OFFSET = 13.0;
/** Vertical part of the lip's inner face, so the tip is not a knife in section. */
const LIP_SUPPORT_H = 1.2;
/** Clearance under a socket so the base always seats on the socket, not the floor. */
const SOCKET_CLEAR_Z = 0.35;

/**
 * The bin base profile as a function of depth below its top face.
 * Returns the outward offset from the path rectangle, which is also the corner
 * radius at that depth. Bottom-up the stages are 0.8 mm at 45°, 1.8 mm vertical
 * and 2.15 mm at 45°; read top-down as here they come out in the other order.
 */
export function baseX(depth) {
  const d = Math.min(Math.max(depth, 0), BASE_H);
  if (d <= 2.15) return R_BIN - d;                    // 3.75 → 1.60
  if (d <= 3.95) return 1.6;                          // the vertical stage
  return 1.6 - (d - 3.95);                            // 1.60 → 0.80
}

/** The baseplate socket: the bin base grown by the clearance, cut off at 4.65. */
export function socketX(depth) {
  return baseX(Math.min(Math.max(depth, 0), SOCKET_H)) + CLEAR;
}

/**
 * The stacking lip's inner face, as a function of height above the bin body.
 * It is the socket profile with its top 0.25 mm removed — the point at which
 * the socket has opened out to the bin's own 3.75 mm wall and there is nothing
 * left to give.
 */
export function lipX(h) {
  return socketX(SOCKET_H - Math.min(Math.max(h, 0), LIP_H));
}

const int = (v, d, lo, hi) => clamp(Math.round(num(v, d)), lo, hi);

// ---------------------------------------------------------------------------
// Ring and mesh plumbing
//
// Every cross-section in this file is a rounded rectangle described by its
// bounding box and corner radius. Two rings built this way with the same
// segment count and the same split list always have the same number of points
// in the same order, which is what lets a wall between them be a plain quad
// strip and never a resampling problem.
// ---------------------------------------------------------------------------

const MIN_R = 0.05;

function arcPts(cx, cy, r, a0, a1, segs, out) {
  for (let k = 0; k <= segs; k++) {
    const a = a0 + (a1 - a0) * (k / segs);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

/**
 * A rounded rectangle from its bounds. `splitX` / `splitY` are extra vertices
 * forced onto the straight edges — needed wherever this ring has to share edges
 * with another ring that is subdivided differently, which is the whole reason
 * a multi-unit bin's body closes against its separate feet.
 */
function rrRing(x0, x1, y0, y1, r, segs, splitX = [], splitY = []) {
  const w = Math.max(x1 - x0, 0.02), h = Math.max(y1 - y0, 0.02);
  x1 = x0 + w; y1 = y0 + h;
  // The upper bound wins over the lower one: a rectangle narrower than 2 × MIN_R
  // still has to come back as a ring, and a stadium is the honest answer for it.
  const lim = Math.max(1e-3, Math.min(w, h) / 2 - 0.005);
  const rr = Math.min(Math.max(r, MIN_R), lim);
  const out = [];
  const HP = Math.PI / 2;
  arcPts(x1 - rr, y0 + rr, rr, -HP, 0, segs, out);
  for (const y of splitY) if (y > y0 + rr && y < y1 - rr) out.push([x1, y]);
  arcPts(x1 - rr, y1 - rr, rr, 0, HP, segs, out);
  for (let i = splitX.length - 1; i >= 0; i--) {
    const x = splitX[i];
    if (x > x0 + rr && x < x1 - rr) out.push([x, y1]);
  }
  arcPts(x0 + rr, y1 - rr, rr, HP, Math.PI, segs, out);
  for (let i = splitY.length - 1; i >= 0; i--) {
    const y = splitY[i];
    if (y > y0 + rr && y < y1 - rr) out.push([x0, y]);
  }
  arcPts(x0 + rr, y0 + rr, rr, Math.PI, 3 * HP, segs, out);
  for (const x of splitX) if (x > x0 + rr && x < x1 - rr) out.push([x, y0]);
  return out;
}

function circleRing(cx, cy, r, segs) {
  const out = new Array(segs);
  for (let i = 0; i < segs; i++) {
    const a = TAU * i / segs;
    out[i] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  return out;
}

function addRing(m, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

/**
 * Quad strip between two rings of equal length. `outward` is which side the
 * material is on: true for an outer surface, false for the wall of a cavity or
 * a bore, where the normal has to point back at the axis.
 */
function strip(m, lower, upper, outward) {
  const n = lower.length;
  if (n !== upper.length) throw new Error(`gridfinity: ring mismatch ${n} vs ${upper.length}`);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (outward) m.addQuad(lower[i], lower[j], upper[j], upper[i]);
    else m.addQuad(lower[i], upper[i], upper[j], lower[j]);
  }
}

/**
 * A flat annulus between two concentric rings at the same height, as a quad
 * strip rather than a triangulation — exact, cheap, and it cannot invent a
 * vertex that the walls either side of it do not have.
 */
function annulus(m, inner, outer, faceUp) {
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (faceUp) m.addQuad(inner[i], outer[i], outer[j], inner[j]);
    else m.addQuad(inner[i], inner[j], outer[j], outer[i]);
  }
}

/** Triangulate a 2D shape at height z. `faceUp` picks the normal direction. */
function flatFace(m, shape, z, faceUp) {
  const { points, tris } = P.triangulate(shape);
  if (!tris.length) return;
  const base = m.vertCount;
  for (const pt of points) m.addVertex(pt[0], pt[1], z);
  for (let t = 0; t < tris.length; t += 3) {
    if (faceUp) m.addTri(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
    else m.addTri(base + tris[t], base + tris[t + 2], base + tris[t + 1]);
  }
}

/**
 * Snap boolean output back onto the vertices that went in.
 *
 * poly2d's sweep quantises coordinates to a power-of-two grid before it runs,
 * so a point that came straight through the operation unchanged still comes
 * back a few times 1e-8 away from where it started. Left alone that is a
 * different vertex from the one the wall used, and the seam only closes because
 * some later weld happened to round them into the same bucket — which is a
 * coin toss at a bucket boundary, not a guarantee. Putting the exact input
 * coordinate back makes the shared edge identical by construction.
 */
function makeSnapper(rings, tol = 1e-5) {
  const cell = tol * 2;
  const grid = new Map();
  for (const ring of rings) {
    for (const p of ring) {
      const kx = Math.floor(p[0] / cell), ky = Math.floor(p[1] / cell);
      const key = `${kx},${ky}`;
      let list = grid.get(key);
      if (!list) grid.set(key, list = []);
      list.push(p);
    }
  }
  return (p) => {
    const kx = Math.floor(p[0] / cell), ky = Math.floor(p[1] / cell);
    let best = null, bestD = tol;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${kx + dx},${ky + dy}`);
        if (!list) continue;
        for (const q of list) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < bestD) { bestD = d; best = q; }
        }
      }
    }
    return best ? [best[0], best[1]] : p;
  };
}

function snapShapes(shapes, snap) {
  return shapes.map(sh => sh.map(ring => ring.map(snap)));
}

/**
 * A blind bore: a stepped hole opening downwards out of the bottom face.
 * `prof` is [[r, z], ...] from the mouth upwards; equal consecutive z values
 * become a flat step, unequal ones a wall. The mouth is left open for the
 * bottom face to close, and the top is capped facing down.
 * Returns the mouth ring so the caller can use it as a hole.
 */
function addBore(m, cx, cy, prof, segs) {
  const rings = prof.map(([r, z]) => ({ ring: circleRing(cx, cy, r, segs), z, r }));
  const idx = rings.map(s => addRing(m, s.ring, s.z));
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i], b = rings[i + 1];
    if (Math.abs(b.z - a.z) < 1e-9) {
      // A step: material is above, so the exposed face looks down.
      if (b.r < a.r) annulus(m, idx[i + 1], idx[i], false);
      else annulus(m, idx[i], idx[i + 1], false);
    } else {
      strip(m, idx[i], idx[i + 1], false);
    }
  }
  const top = rings[rings.length - 1];
  flatFace(m, [P.ensureCCW(top.ring)], top.z, false);
  return rings[0].ring;
}

// ---------------------------------------------------------------------------
// resolve — every derived number in one place
//
// build() and validate() both run this, so a warning can never disagree with
// the geometry it is warning about. Anything clamped records why.
// ---------------------------------------------------------------------------

function resolve(p, ctx = {}) {
  const sf = num(ctx.segFactor, 1);
  const segs = Math.max(2, 2 * Math.round(clamp(4 * sf, 1, 24)));
  const hseg = Math.max(8, 4 * Math.round(clamp(6 * sf, 2, 24)));
  const bed = ctx.bed || { x: 180, y: 180, z: 180 };
  const notes = [];

  const kind = p.kind === 'baseplate' ? 'baseplate' : 'bin';
  const nx = int(p.nx, 1, 1, 8);
  const ny = int(p.ny, 1, 1, 8);

  // ---- shared grid geometry -------------------------------------------
  const R = {
    kind, nx, ny, segs, hseg, bed, notes,
    cellX: (i) => -(nx * PITCH) / 2 + PITCH / 2 + i * PITCH,
    cellY: (j) => -(ny * PITCH) / 2 + PITCH / 2 + j * PITCH,
  };

  // Magnet / screw hardware is shared between bins and baseplates.
  const magnets = !!p.magnets;
  const screws = !!p.screws;
  const magnetR = clamp(num(p.magnetDia, 6), 3, 9) / 2;
  const magnetD = clamp(num(p.magnetDepth, 2), 0.4, 5);
  const screwR = clamp(num(p.screwDia, 3), 1, 6) / 2;
  const screwD = clamp(num(p.screwDepth, 6), 1, 20);
  Object.assign(R, { magnets, screws, magnetR, magnetD, screwR, screwD });

  if (kind === 'baseplate') return resolvePlate(p, R);
  return resolveBin(p, R);
}

function resolveBin(p, R) {
  const { nx, ny, notes } = R;
  const W = nx * PITCH - 2 * CLEAR;
  const D = ny * PITCH - 2 * CLEAR;
  const ax = W / 2 - R_BIN;                 // path rectangle half-extents
  const ay = D / 2 - R_BIN;

  // Body height. Units are the native way to say it; millimetres are snapped up
  // to a whole unit unless the user asks not to, because a bin that is 23 mm
  // tall is a bin that does not stack.
  // The cap is deliberately far above anything that fits the bed: clamping to
  // the build volume here would silently shrink a bin the user asked for, and
  // then validate() would have nothing left to object to.
  const useMm = p.heightMode === 'mm';
  const units = int(p.units, 3, 1, 60);
  let binH;
  if (useMm) {
    const mm = clamp(num(p.heightMm, 42), UNIT_H, 60 * UNIT_H);
    binH = p.snapUnits === false ? mm : Math.ceil(mm / UNIT_H - 1e-9) * UNIT_H;
    if (p.snapUnits !== false && Math.abs(binH - mm) > 1e-6) {
      notes.push(`${mm.toFixed(1)} mm rounded up to ${binH} mm so the bin is a whole number of 7 mm units`);
    }
  } else {
    binH = units * UNIT_H;
  }

  const lip = p.lip !== false;
  const topZ = binH + (lip ? LIP_H : 0);

  const wallReq = num(p.wall, 1.2);
  // A wall thicker than the cavity is a solid block; clamp so the mesh is still
  // a mesh, and let validate() say what happened.
  const wall = clamp(wallReq, 0.2, Math.min(ax, ay) + R_BIN - 0.6);
  // Negative is meaningful: a wall thicker than the corner radius gives a cavity
  // narrower than the path rectangle, with square corners rather than round.
  const cavityX = R_BIN - wall;

  const floorReq = num(p.floor, 0.8);
  const floorT = clamp(floorReq, 0.2, 40);
  // The floor is measured ABOVE the base profile, not above the build plate.
  // It has to be, on a multi-unit bin: the feet are separate below 4.75 mm with
  // the specification's 0.5 mm gap between them, so a cavity floor sitting at
  // 4.75 would be a slot straight through the bottom of the bin at every joint.
  // (The reference OpenSCAD implementation dodges this by making the whole first
  // 7 mm unit solid. Either is interoperable — the fit is decided entirely by
  // the outside of the base — and this way the floor parameter means something.)
  let floorZ = BASE_H + floorT;
  if (R.magnets) floorZ = Math.max(floorZ, R.magnetD + floorT);
  if (R.screws) floorZ = Math.max(floorZ, R.screwD + floorT);
  const floorCap = binH - 0.6;
  const floorClamped = floorZ > floorCap;
  floorZ = clamp(floorZ, 0.4, Math.max(0.4, floorCap));

  // Hole depths have to stay blind: a magnet pocket that opens into the bin is
  // a magnet that falls into the bin.
  const holeRoom = floorZ - 0.4;
  const magnetD = Math.min(R.magnetD, holeRoom);
  const screwD = Math.min(R.screwD, holeRoom);
  const magnets = R.magnets && magnetD > 0.3;
  const screws = R.screws && screwD > 0.3;
  // Keep every hole a clear 0.6 mm inside the foot's bottom face. That face is
  // 35.6 mm across, the holes sit 13 mm out from the unit centre, so the widest
  // magnet that fits is 2 × (17.8 − 13 − 0.6) = 8.4 mm.
  const bottomHalf = 17 + baseX(BASE_H);                 // 17.8 mm
  const holeEdgeRoom = bottomHalf - HOLE_OFFSET - 0.6;
  const magnetR = Math.min(R.magnetR, holeEdgeRoom);
  const screwR = Math.min(R.screwR, magnets ? Math.max(0.3, magnetR - 0.4) : holeEdgeRoom);

  // ---- the interior perimeter, from the rim downwards -------------------
  const supportH = lip ? Math.min(LIP_SUPPORT_H, Math.max(0, binH - floorZ - 0.4)) : 0;
  const ramp = lip ? Math.max(0, cavityX - lipX(0)) : 0;
  // The profile always starts on the outer wall: with a lip that is the knife
  // edge at the very top, without one it is the rim, and in both cases it is
  // literally the same ring of vertices the outer wall ends on.
  const perim = [[R_BIN, topZ]];
  if (lip) {
    perim.push([lipX(LIP_H - 1.9), binH + 2.5]);
    perim.push([lipX(0.7), binH + 0.7]);
    perim.push([lipX(0), binH]);
    if (supportH > 1e-9) perim.push([lipX(0), binH - supportH]);
    if (ramp > 1e-9) perim.push([cavityX, binH - supportH - ramp]);
  }
  // Cut the profile off at the floor. Every segment is straight in (x, z), so a
  // linear interpolation is exact rather than approximate.
  const prof = [];
  for (let i = 0; i < perim.length; i++) {
    const cur = perim[i];
    if (cur[1] >= floorZ - 1e-9) { prof.push(cur); continue; }
    const prev = perim[i - 1];
    if (prev && prev[1] > floorZ) {
      const t = (prev[1] - floorZ) / (prev[1] - cur[1]);
      prof.push([prev[0] + (cur[0] - prev[0]) * t, floorZ]);
    }
    break;
  }
  if (!prof.length) prof.push([cavityX, Math.max(floorZ, binH)]);
  const zr = prof[prof.length - 1][1];
  const xr = prof[prof.length - 1][0];

  // Splits: the extra vertices every body-path ring needs so that it closes
  // against the separate feet underneath it. Because a ring at offset x always
  // has its straight edges spanning exactly the path rectangle, one list of
  // absolute coordinates is valid at every offset.
  const splitX = [], splitY = [];
  for (let i = 0; i < nx; i++) {
    for (const v of [R.cellX(i) - 17, R.cellX(i) + 17]) {
      if (v > -ax + 1e-9 && v < ax - 1e-9) splitX.push(v);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (const v of [R.cellY(j) - 17, R.cellY(j) + 17]) {
      if (v > -ay + 1e-9 && v < ay - 1e-9) splitY.push(v);
    }
  }
  splitX.sort((a, b) => a - b);
  splitY.sort((a, b) => a - b);

  // ---- compartments -----------------------------------------------------
  // xr is where the perimeter surface has actually got to at the rim; xn is the
  // nominal cavity wall. They differ without a lip (the rim is the outer wall)
  // and when a tall floor has cut the lip's ramp off part-way down.
  const xn = Math.min(cavityX, xr);
  const cavH = zr - floorZ;
  const roomForCompartments = cavH > 0.5;
  const c0 = { x0: -(ax + xn), x1: ax + xn, y0: -(ay + xn), y1: ay + xn };
  const cavW = c0.x1 - c0.x0, cavD = c0.y1 - c0.y0;

  const divT = clamp(wall, 0.4, 8);
  let divX = int(p.divX, 1, 1, 8);
  let divY = int(p.divY, 1, 1, 8);
  if (!roomForCompartments) { divX = 1; divY = 1; }
  // Every compartment carries the cavity's own corner radius, because the outer
  // ones share their corners with it — a smaller radius there would push the
  // compartment out through the bin's rounded corner. That sets the floor on how
  // small a compartment is allowed to be.
  const minCell = Math.max(3.0, 2 * xn + 0.4);
  while (divX > 1 && (cavW - (divX - 1) * divT) / divX < minCell) divX--;
  while (divY > 1 && (cavD - (divY - 1) * divT) / divY < minCell) divY--;
  if (divX !== int(p.divX, 1, 1, 8) || divY !== int(p.divY, 1, 1, 8)) {
    notes.push(`dividers reduced to ${divX} × ${divY} — the compartments were coming out under ${minCell.toFixed(1)} mm`);
  }
  const cw = (cavW - (divX - 1) * divT) / divX;
  const ch = (cavD - (divY - 1) * divT) / divY;

  // ---- scoop and label tab ---------------------------------------------
  // Both are the same trick: the compartment's front or back edge is a function
  // of height instead of a constant.
  const labelMode = ['none', 'back', 'front', 'both'].includes(p.label) ? p.label : 'none';
  const labelBack = labelMode === 'back' || labelMode === 'both';
  const labelFront = labelMode === 'front' || labelMode === 'both';
  const labelAngle = clamp(num(p.labelAngle, 45), 15, 70);
  const tan = Math.tan(labelAngle * Math.PI / 180);

  // The scoop cannot be deeper than the compartment, taller than the cavity, or
  // — this is the one that matters for the shared-ring case below — deep enough
  // to lift the front edge past a split vertex sitting on the side wall.
  let scoopR = Math.min(Math.max(0, num(p.scoop, 0)), 15);
  scoopR = Math.min(scoopR, ch - minCell, cavH - 0.4);
  if (scoopR < 0.3) scoopR = 0;

  const labelSides = (labelBack ? 1 : 0) + (labelFront ? 1 : 0);
  let labelD = labelSides ? Math.max(0, num(p.labelDepth, 12)) : 0;
  if (labelSides) {
    labelD = Math.min(labelD, (ch - minCell) / labelSides);
    // The tab hangs from the rim; it must not reach down into the scoop.
    labelD = Math.min(labelD, Math.max(0, cavH - scoopR - 0.4) / tan);
    if (labelD < 0.5) labelD = 0;
  }
  const labelH = labelD * tan;

  const single = divX === 1 && divY === 1;

  // The rim face is a plain triangulation of the rim ring with the compartment
  // mouths as holes, which only works while the mouths are strictly inside the
  // ring. Where they would otherwise be tangent to it — a divided bin with a
  // stacking lip — each mouth is drawn back by `ins` and flares out again at 45°
  // over the same distance. That buys an exact, boolean-free face and gives the
  // divider tops and the rim a small chamfer, which is what a good bin has
  // anyway. The alternative, differencing tangent polygons, is exactly the case
  // a sweep-line boolean gets wrong.
  let share = single && labelD === 0 && Math.abs(xn - xr) < 1e-9 && xn >= MIN_R;
  // Sharing means the compartment's rings carry the body path's split vertices,
  // which only works while every split still lands on the edge it belongs to.
  // The scoop shortens the side edges, so check rather than assume.
  if (share && splitY.length) {
    if (-ay + scoopR >= Math.min(...splitY) - 1e-9 || ay <= Math.max(...splitY) + 1e-9) share = false;
  }
  let ins = share ? 0 : Math.max(0, xn - (xr - 0.4));
  ins = Math.min(ins, cw / 2 - 0.5, ch / 2 - 0.5, Math.max(0, cavH - 0.3));
  if (ins < 0.02) ins = 0;

  const comps = [];
  for (let j = 0; j < divY; j++) {
    for (let i = 0; i < divX; i++) {
      comps.push({
        i, j,
        x0: c0.x0 + i * (cw + divT), x1: c0.x0 + i * (cw + divT) + cw,
        y0: c0.y0 + j * (ch + divT), y1: c0.y0 + j * (ch + divT) + ch,
        r: xn,
        scoop: scoopR,
        back: labelBack && j === divY - 1 ? labelD : 0,
        front: labelFront && j === 0 ? labelD : 0,
      });
    }
  }

  return Object.assign(R, {
    W, D, ax, ay, binH, topZ, lip, units, useMm,
    wall, wallReq, cavityX, floorT, floorReq, floorZ, floorClamped,
    magnets, screws, magnetR, magnetD, screwR, screwD,
    prof, zr, xr, xn, ins, share, cavH, roomForCompartments,
    divX, divY, divT, cw, ch, comps, single,
    scoopR, labelMode, labelD, labelH, labelAngle, labelBack, labelFront,
    splitX, splitY, minCell,
    bodyRing: (x) => rrRing(-(ax + x), ax + x, -(ay + x), ay + x, x, R.segs, splitX, splitY),
    footRing: (i, j, x) => rrRing(R.cellX(i) - 17 - x, R.cellX(i) + 17 + x,
      R.cellY(j) - 17 - x, R.cellY(j) + 17 + x, x, R.segs),
  });
}

function resolvePlate(p, R) {
  const { nx, ny, notes } = R;
  const W = nx * PITCH, D = ny * PITCH;
  const ax = W / 2 - R_SOCKET, ay = D / 2 - R_SOCKET;
  const style = p.plateStyle === 'solid' ? 'solid' : 'light';
  const plateFloor = clamp(num(p.plateFloor, 2.4), 0.6, 12);
  const thickReq = clamp(num(p.plateThickness, 5), SOCKET_H + 0.1, 20);

  let plateH, floorTop;
  if (style === 'solid') {
    plateH = plateFloor + SOCKET_H + SOCKET_CLEAR_Z;
    floorTop = plateFloor;                    // sockets bottom out here
  } else {
    plateH = Math.max(thickReq, SOCKET_H + SOCKET_CLEAR_Z);
    floorTop = 0;                             // sockets go straight through
  }
  const shaftTop = plateH - SOCKET_H;         // where the socket profile starts

  const plateMagnets = !!p.plateMagnets && style === 'solid';
  const magnetD = Math.min(R.magnetD, Math.max(0, plateFloor - 0.6));
  const useMagnets = plateMagnets && magnetD > 0.3;
  if (p.plateMagnets && style !== 'solid') {
    notes.push('a light baseplate is open underneath every socket, so there is nowhere to put a magnet — magnets need the solid style');
  } else if (p.plateMagnets && !useMagnets) {
    notes.push(`the ${plateFloor.toFixed(1)} mm floor is too thin for a ${R.magnetD.toFixed(1)} mm magnet pocket`);
  }

  const splitX = [], splitY = [];
  for (let i = 0; i < nx; i++) {
    for (const v of [R.cellX(i) - 17, R.cellX(i) + 17]) {
      if (v > -ax + 1e-9 && v < ax - 1e-9) splitX.push(v);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (const v of [R.cellY(j) - 17, R.cellY(j) + 17]) {
      if (v > -ay + 1e-9 && v < ay - 1e-9) splitY.push(v);
    }
  }
  splitX.sort((a, b) => a - b);
  splitY.sort((a, b) => a - b);

  return Object.assign(R, {
    W, D, ax, ay, style, plateH, plateFloor, floorTop, shaftTop, thickReq,
    plateMagnets: useMagnets, magnetD, splitX, splitY,
    outerRing: () => rrRing(-W / 2, W / 2, -D / 2, D / 2, R_SOCKET, R.segs, splitX, splitY),
    socketRing: (i, j, x) => rrRing(R.cellX(i) - 17 - x, R.cellX(i) + 17 + x,
      R.cellY(j) - 17 - x, R.cellY(j) + 17 + x, x, R.segs),
  });
}

// ---------------------------------------------------------------------------
// The bin
// ---------------------------------------------------------------------------

function compartmentLevels(R, c) {
  // Heights at which the cross-section changes, top down.
  const zs = [R.zr];
  if (R.ins > 0) zs.push(R.zr - R.ins);
  if (Math.max(c.back, c.front) > 0 && R.labelH > 0) zs.push(R.zr - R.labelH);
  if (c.scoop > 0) {
    const n = Math.max(4, Math.round(3 * R.segs / 4) + 2);
    zs.push(R.floorZ + c.scoop);
    for (let k = n - 1; k >= 1; k--) zs.push(R.floorZ + c.scoop * (k / n));
  }
  zs.push(R.floorZ);
  zs.sort((a, b) => b - a);
  // Strictly decreasing, no repeats — a repeated height is a zero-height strip
  // and a zero-height strip is a ring of degenerate triangles.
  const out = [];
  for (const z of zs) if (!out.length || out[out.length - 1] - z > 1e-4) out.push(z);
  if (out.length < 2) out.push(out[0] - 0.05);
  return out;
}

function compartmentRing(R, c, z) {
  const insA = R.ins > 0 ? R.ins * clamp((z - (R.zr - R.ins)) / R.ins, 0, 1) : 0;
  const x0 = c.x0 + insA, x1 = c.x1 - insA;
  let y0 = c.y0 + insA, y1 = c.y1 - insA;

  // The scoop: a concave quarter-round at the bottom of the front wall, so the
  // solid grows downwards and there is nothing anywhere that overhangs.
  const hFromFloor = z - R.floorZ;
  if (c.scoop > 0 && hFromFloor <= c.scoop + 1e-9) {
    const t = clamp(c.scoop - hFromFloor, 0, c.scoop);
    y0 = Math.max(y0, c.y0 + c.scoop - Math.sqrt(Math.max(0, c.scoop * c.scoop - t * t)));
  }
  // The label tab: the same trick at the other end and the other way up.
  if (R.labelH > 0) {
    const hFromTop = R.zr - z;
    if (hFromTop <= R.labelH + 1e-9) {
      // Deliberately the larger of the two setbacks rather than their sum: the
      // rim chamfer and the tab both pull this edge in, and adding them makes a
      // 2:1 slope where both apply — a 63° overhang instead of the 45° the tab
      // is specified at. Measured before it was written this way.
      const inset = (1 - hFromTop / R.labelH) * R.labelD;
      if (c.back > 0) y1 = Math.min(y1, c.y1 - inset);
      if (c.front > 0) y0 = Math.max(y0, c.y0 + inset);
    }
  }
  // When the mouth is the perimeter's own ring, it has to carry the perimeter's
  // split vertices too, or the wall below it strips against a ring of a
  // different length. resolve() only allows sharing when every split still fits.
  return R.share
    ? rrRing(x0, x1, y0, y1, c.r - insA, R.segs, R.splitX, R.splitY)
    : rrRing(x0, x1, y0, y1, c.r - insA, R.segs);
}

function buildBin(R) {
  const m = new Mesh();
  const { nx, ny, segs, hseg } = R;

  // ---- feet -------------------------------------------------------------
  const baseSteps = [[baseX(BASE_H), 0], [baseX(2.15 + 1.8), 0.8], [baseX(2.15), 2.6], [R_BIN, BASE_H]];
  const footTops = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const rings = baseSteps.map(([x, z]) => ({ ring: R.footRing(i, j, x), z }));
      const idx = rings.map(s => addRing(m, s.ring, s.z));
      for (let k = 0; k + 1 < rings.length; k++) strip(m, idx[k], idx[k + 1], true);
      footTops.push({ ring: rings[3].ring, idx: idx[3] });

      // Bottom face, with the magnet / screw bores punched out of it.
      const holes = [];
      if (R.magnets || R.screws) {
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const cx = R.cellX(i) + sx * HOLE_OFFSET, cy = R.cellY(j) + sy * HOLE_OFFSET;
            const prof = [];
            if (R.magnets && R.screws) {
              prof.push([R.magnetR, 0], [R.magnetR, R.magnetD], [R.screwR, R.magnetD], [R.screwR, Math.max(R.screwD, R.magnetD + 0.2)]);
            } else if (R.magnets) {
              prof.push([R.magnetR, 0], [R.magnetR, R.magnetD]);
            } else {
              prof.push([R.screwR, 0], [R.screwR, R.screwD]);
            }
            holes.push(addBore(m, cx, cy, prof, hseg));
          }
        }
      }
      flatFace(m, [P.ensureCCW(rings[0].ring), ...holes.map(P.ensureCW)], 0, false);
    }
  }

  // ---- body -------------------------------------------------------------
  const bodyTopRing = R.bodyRing(R_BIN);
  let bodyBottomIdx;
  if (nx === 1 && ny === 1) {
    // One unit: the foot's top face IS the body's footprint, so the two walls
    // are one continuous surface and there is no face between them at all.
    bodyBottomIdx = footTops[0].idx;
  } else {
    bodyBottomIdx = addRing(m, bodyTopRing, BASE_H);
    // The 0.5 mm gaps the specification leaves between adjacent feet. The body
    // bridges them, so this face is the underside of that bridge and looks down.
    const snap = makeSnapper([bodyTopRing, ...footTops.map(f => f.ring)]);
    const gap = P.boolean([bodyTopRing], footTops.map(f => [f.ring]), 'difference');
    for (const sh of snapShapes(gap, snap)) flatFace(m, sh, BASE_H, false);
  }
  const bodyTopIdx = addRing(m, bodyTopRing, R.topZ);
  strip(m, bodyBottomIdx, bodyTopIdx, true);

  // ---- interior perimeter ----------------------------------------------
  let prevIdx = null;
  for (let k = 0; k < R.prof.length; k++) {
    const [x, z] = R.prof[k];
    // The first ring is the outer wall's own top ring — with a stacking lip the
    // inner and outer faces meet there in a knife edge, which is the spec, and
    // sharing the vertices is how that closes without a zero-area face.
    const idx = k === 0 ? bodyTopIdx : addRing(m, R.bodyRing(x), z);
    if (prevIdx) {
      const px = R.prof[k - 1][0];
      if (R.prof[k - 1][1] - z < 1e-9) {
        // A step at constant height. Narrowing on the way down means material
        // below and not above, so the exposed face looks up, and vice versa.
        if (x < px) annulus(m, idx, prevIdx, true);
        else annulus(m, prevIdx, idx, false);
      } else {
        strip(m, idx, prevIdx, false);
      }
    }
    prevIdx = idx;
  }

  // ---- compartments -----------------------------------------------------
  if (!R.roomForCompartments) {
    // A tall floor has met the lip's ramp on the way down: what is left is a
    // shallow tapered pocket, which is a real 1-unit bin, not a failure. The
    // perimeter still has to be walked the rest of the way to the floor —
    // skipping that leaves the pocket with no side wall at all.
    if (R.zr - R.floorZ > 1e-6) {
      const idx = addRing(m, R.bodyRing(R.xr), R.floorZ);
      strip(m, idx, prevIdx, false);
    }
    flatFace(m, [P.ensureCCW(R.bodyRing(R.xr))], R.floorZ, true);
    return m;
  }

  const compTop = R.comps.map(c => compartmentRing(R, c, R.zr));
  const compIdxTop = [];
  if (R.share) {
    compIdxTop.push(prevIdx);            // the mouth IS the perimeter's last ring
  } else {
    for (const ring of compTop) compIdxTop.push(addRing(m, ring, R.zr));
    flatFace(m, [P.ensureCCW(R.bodyRing(R.xr)), ...compTop.map(P.ensureCW)], R.zr, true);
  }

  for (let ci = 0; ci < R.comps.length; ci++) {
    const c = R.comps[ci];
    const zs = compartmentLevels(R, c);
    let prev = compIdxTop[ci];
    let lastRing = compTop[ci];
    for (let k = 1; k < zs.length; k++) {
      const ring = compartmentRing(R, c, zs[k]);
      const idx = addRing(m, ring, zs[k]);
      strip(m, idx, prev, false);
      prev = idx; lastRing = ring;
    }
    flatFace(m, [P.ensureCCW(lastRing)], R.floorZ, true);
  }

  return m;
}

// ---------------------------------------------------------------------------
// The baseplate
// ---------------------------------------------------------------------------

/**
 * The scrap of flat top surface where four socket funnels meet.
 *
 * Sockets are 42 mm across at the rim and sit on a 42 mm pitch, so they touch
 * exactly. That makes the plate's top face nothing but a lattice of little
 * concave-sided squares at the junctions, and half of one along each edge. A 2D
 * boolean cannot be trusted with geometry that is exactly tangent everywhere —
 * measured: it returns a 2×2 plate's top face nearly forty times too large — so
 * these are constructed from the very same corner arcs the socket rings use,
 * which also makes the shared vertices identical rather than merely close.
 */
function junctionSliver(jx, jy, r, segs, has) {
  const HP = Math.PI / 2;
  const out = [];
  const arcRev = (cx, cy, a0, a1) => {
    const tmp = [];
    arcPts(cx, cy, r, a0, a1, segs, tmp);
    tmp.reverse();
    for (const q of tmp) out.push(q);
  };
  // E → N (the north-east cell's inner corner), N → W, W → S, S → E.
  if (has.ne && has.nw && has.sw && has.se) {
    arcRev(jx + r, jy + r, Math.PI, 3 * HP);     // NE cell: 180°..270°, walked back
    arcRev(jx - r, jy + r, 3 * HP, TAU);         // NW cell
    arcRev(jx - r, jy - r, 0, HP);               // SW cell
    arcRev(jx + r, jy - r, HP, Math.PI);         // SE cell
    return out;
  }
  if (has.ne && has.nw) {                        // junction on the bottom edge
    out.push([jx - r, jy]);
    out.push([jx + r, jy]);
    arcRev(jx + r, jy + r, Math.PI, 3 * HP);
    arcRev(jx - r, jy + r, 3 * HP, TAU);
    out.pop();                                   // the last arc ends where we began
    return out;
  }
  if (has.se && has.sw) {                        // top edge
    arcRev(jx - r, jy - r, 0, HP);
    arcRev(jx + r, jy - r, HP, Math.PI);
    out.push([jx + r, jy]);
    out.unshift([jx - r, jy]);
    // walked W → S → E then straight back; drop the duplicated W
    return dedupe(out);
  }
  if (has.ne && has.se) {                        // left edge
    arcRev(jx + r, jy - r, HP, Math.PI);
    arcRev(jx + r, jy + r, Math.PI, 3 * HP);
    return dedupe([[jx, jy - r], ...out, [jx, jy + r]]);
  }
  if (has.nw && has.sw) {                        // right edge
    arcRev(jx - r, jy + r, 3 * HP, TAU);
    arcRev(jx - r, jy - r, 0, HP);
    return dedupe([[jx, jy + r], ...out, [jx, jy - r]]);
  }
  return [];
}

function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

function buildPlate(R) {
  const m = new Mesh();
  const { nx, ny, segs, hseg } = R;
  const outer = R.outerRing();
  const outerBottom = addRing(m, outer, 0);
  const outerTop = addRing(m, outer, R.plateH);
  strip(m, outerBottom, outerTop, true);

  // Socket walls: a vertical shaft, then the three-stage funnel.
  const shaftRings = [];
  const socketProfile = [
    [socketX(SOCKET_H), R.floorTop],
    [socketX(SOCKET_H), R.shaftTop],
    [socketX(3.95), R.shaftTop + 0.7],
    [socketX(2.15), R.shaftTop + 2.5],
    [R_SOCKET, R.plateH],
  ];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const rings = socketProfile.map(([x, z]) => ({ ring: R.socketRing(i, j, x), z }));
      const idx = rings.map(s => addRing(m, s.ring, s.z));
      for (let k = 0; k + 1 < rings.length; k++) {
        if (Math.abs(rings[k + 1].z - rings[k].z) < 1e-9) continue;
        strip(m, idx[k], idx[k + 1], false);
      }
      shaftRings.push(rings[0].ring);

      if (R.style === 'solid') {
        // The pocket floor. Magnet bores open out of the plate's UNDERSIDE and
        // stop short of this face, so they are holes in the bottom, never here.
        if (R.plateMagnets) {
          for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
              addBore(m, R.cellX(i) + sx * HOLE_OFFSET, R.cellY(j) + sy * HOLE_OFFSET,
                [[R.magnetR, 0], [R.magnetR, R.magnetD]], hseg);
            }
          }
        }
        flatFace(m, [P.ensureCCW(rings[0].ring)], R.floorTop, true);
      }
    }
  }

  // Bottom face.
  const bottomHoles = [];
  if (R.style === 'light') {
    for (const ring of shaftRings) bottomHoles.push(P.ensureCW(ring));
  } else if (R.plateMagnets) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            bottomHoles.push(P.ensureCW(circleRing(R.cellX(i) + sx * HOLE_OFFSET, R.cellY(j) + sy * HOLE_OFFSET, R.magnetR, hseg)));
          }
        }
      }
    }
  }
  flatFace(m, [P.ensureCCW(outer), ...bottomHoles], 0, false);

  // Top face: the junction slivers, and nothing else.
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const jx = -R.W / 2 + i * PITCH, jy = -R.D / 2 + j * PITCH;
      const has = {
        ne: i < nx && j < ny, nw: i > 0 && j < ny,
        se: i < nx && j > 0, sw: i > 0 && j > 0,
      };
      const n = (has.ne ? 1 : 0) + (has.nw ? 1 : 0) + (has.se ? 1 : 0) + (has.sw ? 1 : 0);
      if (n < 2) continue;                       // plate corners have no top face
      const ring = junctionSliver(jx, jy, R_SOCKET, segs, has);
      if (ring.length >= 3) flatFace(m, [P.ensureCCW(ring)], R.plateH, true);
    }
  }

  return m;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const R = resolve(p, ctx);
  const m = R.kind === 'baseplate' ? buildPlate(R) : buildBin(R);
  // Welding is not a repair here: the boolean-derived faces are snapped onto
  // the exact coordinates their neighbours already use, so this merges vertices
  // that are bit-identical and nothing else.
  return { mesh: m.weld(1e-6), meta: { dims: R.kind === 'baseplate' ? plateDims(p, R) : binDims(p, R) } };
}

// ---------------------------------------------------------------------------
// Dimension callouts
//
// The mesh is built centred on the origin with its underside on z = 0 and is
// never moved after, so these are in the placed frame already. Each one sits on
// the feature it measures, on the side the default view looks at (from +x, -y):
// the front face, the front-right unit's hardware, the left wall's inner face.
// Where resolve() clamped something, the callout carries the built figure as
// `value` so the drawing can never disagree with the part.
// ---------------------------------------------------------------------------

function dimPush(dims, param, label, from, to, actual, asked, offset) {
  const d = { param, label, from, to, offset };
  if (Math.abs(actual - asked) > 1e-9) d.value = actual;
  dims.push(d);
}

function binDims(p, R) {
  const dims = [];
  const W2 = R.W / 2, D2 = R.D / 2;
  const out = [0, -6, 0];                        // off the front face, towards the viewer

  // Floor: the solid between whatever is under it (the base profile, or the
  // deepest hardware hole) and the cavity floor, on the front face.
  const under = Math.max(BASE_H, R.magnets ? R.magnetD : 0, R.screws ? R.screwD : 0);
  const floorAbove = R.floorZ - under;
  dimPush(dims, 'floor', 'floor', [0, -D2, under], [0, -D2, R.floorZ], floorAbove, R.floorReq, out);

  // Body height without the lip, on the right face — the bounding box only
  // knows the height with the lip on.
  if (R.useMm) {
    dimPush(dims, 'heightMm', 'body', [W2, -R.ay, 0], [W2, -R.ay, R.binH], R.binH, num(p.heightMm, 42), [6, 0, 0]);
  } else {
    dims.push({ param: 'units', label: 'body', from: [W2, -R.ay, 0], to: [W2, -R.ay, R.binH], value: R.binH / UNIT_H, unit: 'u', offset: [6, 0, 0] });
  }
  if (R.lip) dims.push({ param: 'lip', label: 'lip', from: [W2, -R.ay, R.binH], to: [W2, -R.ay, R.topZ], offset: [6, 0, 0] });

  if (R.roomForCompartments) {
    // Wall: across the left wall at the top of its straight section, where the
    // cavity is the nominal wall in from the outside (below the lip's ramp and
    // the rim chamfer). The inner face of the left wall is what the view sees.
    const c0 = R.comps[0];
    const yc = (c0.y0 + c0.y1) / 2;
    const zw = R.zr - R.ins;
    dimPush(dims, 'wall', 'wall', [-W2, yc, zw], [c0.x0, yc, zw], R_BIN - R.xn, R.wallReq, 8);
    if (R.divX > 1) {
      const c1 = R.comps[1];
      dimPush(dims, 'wall', 'divider', [c0.x1, yc, zw], [c1.x0, yc, zw], R.divT, R.wallReq, 8);
    }
    // Scoop: a radius, from the centre of curvature to the fillet at 45°, in
    // the front-right compartment.
    if (R.scoopR > 0) {
      const cf = R.comps[R.divX - 1];
      const xc = (cf.x0 + cf.x1) / 2, s = R.scoopR, k = Math.SQRT1_2;
      dimPush(dims, 'scoop', 'R', [xc, cf.y0 + s, R.floorZ + s], [xc, cf.y0 + s - s * k, R.floorZ + s - s * k], s, num(p.scoop, 0), 8);
    }
    // Label tab: how far it reaches into the bin from the wall, along its top.
    if (R.labelD > 0) {
      const j = R.labelBack ? R.divY - 1 : 0;
      const c = R.comps[j * R.divX];
      const xc = (c.x0 + c.x1) / 2;
      const yEdge = R.labelBack ? c.y1 : c.y0, dir = R.labelBack ? -1 : 1;
      dimPush(dims, 'labelDepth', 'tab', [xc, yEdge, R.zr], [xc, yEdge + dir * R.labelD, R.zr], R.labelD, num(p.labelDepth, 12), 8);
    }
  }

  // Hardware: the front-right hole of the front-right unit, opening downwards.
  if (R.magnets || R.screws) {
    const cx = R.cellX(R.nx - 1) + HOLE_OFFSET, cy = R.cellY(0) - HOLE_OFFSET;
    if (R.magnets) {
      dimPush(dims, 'magnetDia', 'Ø', [cx - R.magnetR, cy, 0], [cx + R.magnetR, cy, 0], 2 * R.magnetR, num(p.magnetDia, 6), out);
      dimPush(dims, 'magnetDepth', 'magnet', [cx, cy - R.magnetR, 0], [cx, cy - R.magnetR, R.magnetD], R.magnetD, num(p.magnetDepth, 2), out);
    }
    if (R.screws) {
      const z0 = R.magnets ? R.magnetD : 0;
      const zEnd = R.magnets ? Math.max(R.screwD, R.magnetD + 0.2) : R.screwD;
      dimPush(dims, 'screwDia', 'Ø', [cx - R.screwR, cy, z0], [cx + R.screwR, cy, z0], 2 * R.screwR, num(p.screwDia, 3), out);
      dimPush(dims, 'screwDepth', 'screw', [cx, cy - R.screwR, 0], [cx, cy - R.screwR, zEnd], zEnd, num(p.screwDepth, 6), out);
    }
  }
  return dims;
}

function plateDims(p, R) {
  const dims = [];
  const W2 = R.W / 2;
  const out = [0, -6, 0];
  const cx = R.cellX(R.nx - 1), cy = R.cellY(0);       // the front-right socket
  const yFront = cy - 17 - socketX(SOCKET_H);          // its shaft's front wall
  if (R.style === 'light') {
    dimPush(dims, 'plateThickness', 'plate', [W2, 0, 0], [W2, 0, R.plateH], R.plateH, num(p.plateThickness, 5), [6, 0, 0]);
  } else {
    dimPush(dims, 'plateFloor', 'floor', [cx, yFront, 0], [cx, yFront, R.plateFloor], R.plateFloor, num(p.plateFloor, 2.4), out);
    if (R.plateMagnets) {
      const hx = cx + HOLE_OFFSET, hy = cy - HOLE_OFFSET;
      dimPush(dims, 'magnetDia', 'Ø', [hx - R.magnetR, hy, 0], [hx + R.magnetR, hy, 0], 2 * R.magnetR, num(p.magnetDia, 6), out);
      dimPush(dims, 'magnetDepth', 'magnet', [hx, hy - R.magnetR, 0], [hx, hy - R.magnetR, R.magnetD], R.magnetD, num(p.magnetDepth, 2), out);
    }
  }
  return dims;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validate(p, ctx = {}) {
  const out = [];
  const R = resolve(p, ctx);
  const bed = R.bed;
  const size = R.kind === 'baseplate'
    ? { x: R.W, y: R.D, z: R.plateH }
    : { x: R.W, y: R.D, z: R.topZ };

  if (size.x > bed.x || size.y > bed.y) {
    out.push({
      param: size.x > bed.x ? 'nx' : 'ny', severity: 'error',
      message: `${size.x.toFixed(1)} × ${size.y.toFixed(1)} mm will not fit the ${bed.x} × ${bed.y} mm bed. ${Math.floor((bed.x + 2 * CLEAR) / PITCH)} units across is the most this printer can do in one piece.`,
    });
  }
  if (size.z > bed.z) {
    out.push({ param: 'units', severity: 'error', message: `${size.z.toFixed(1)} mm is taller than the ${bed.z} mm build volume.` });
  }
  for (const n of R.notes) out.push({ param: 'nx', severity: 'info', message: n });

  const nozzle = num(ctx.nozzle, 0.4);
  const layerH = num(ctx.layerH, 0.2);

  if (R.kind === 'baseplate') {
    if (R.style === 'light' && R.thickReq < SOCKET_H + SOCKET_CLEAR_Z - 1e-9) {
      out.push({
        param: 'plateThickness', severity: 'warn',
        message: `a socket is ${SOCKET_H} mm deep and a bin base is ${BASE_H} mm tall, so anything under ${(SOCKET_H + SOCKET_CLEAR_Z).toFixed(1)} mm would let the base touch the desk before it touches the socket. Raised to ${R.plateH.toFixed(2)} mm.`,
      });
    }
    if (R.style === 'solid' && R.plateFloor < 3 * layerH) {
      out.push({ param: 'plateFloor', severity: 'error', message: `a ${R.plateFloor.toFixed(1)} mm floor is under three layers at ${layerH} mm — it will not survive a bin being pulled out of it.` });
    }
    if (R.style === 'solid' && R.plateFloor > 6) {
      out.push({ param: 'plateFloor', severity: 'info', message: `a ${R.plateFloor.toFixed(1)} mm floor is a lot of plastic; the point of a solid plate is rigidity and weight, but 2–3 mm gets you most of it.` });
    }
    if (R.style === 'light' && R.nx * R.ny > 12) {
      out.push({ param: 'plateStyle', severity: 'info', message: 'a light plate this size is a floppy frame until it is screwed down. Print it in two halves if it bows.' });
    }
    return out;
  }

  // ---- bin ----
  if (R.wallReq > R.wall + 1e-6) {
    out.push({
      param: 'wall', severity: 'error',
      message: `a ${R.wallReq.toFixed(1)} mm wall leaves no interior in a ${R.W.toFixed(1)} × ${R.D.toFixed(1)} mm bin — that is a solid block, not a bin. Clamped to ${R.wall.toFixed(2)} mm.`,
    });
  }
  const ew = nozzle * 1.125;
  if (R.wall < 2 * nozzle) {
    out.push({ param: 'wall', severity: 'warn', message: `a ${R.wall.toFixed(2)} mm wall is under two ${nozzle} mm extrusions; the slicer will fill it with gap-fill rather than clean perimeters. ${(3 * ew).toFixed(2)} mm gives three.` });
  }
  if (R.floorClamped) {
    out.push({
      param: 'floor', severity: 'warn',
      message: `the floor plus the hole depths wanted more height than a ${R.binH} mm bin has. The floor was cut to ${R.floorZ.toFixed(2)} mm and the holes shortened to suit — use a taller bin, or shallower holes.`,
    });
  }
  if (R.floorT < 3 * layerH) {
    out.push({
      param: 'floor', severity: 'warn',
      message: `${R.floorT.toFixed(2)} mm is under three layers at ${layerH} mm, and on a multi-unit bin it is also what bridges the 0.5 mm gaps between the feet. Two layers is the sensible floor.`,
    });
  }
  if (!R.roomForCompartments) {
    const asked = R.divX * R.divY > 1 || num(p.scoop, 0) > 0 || (p.label && p.label !== 'none');
    out.push({
      param: 'units', severity: asked ? 'warn' : 'info',
      message: `a ${R.binH} mm bin with a ${R.floorZ.toFixed(2)} mm floor leaves only a shallow tapered pocket under the rim${R.lip ? ' — the stacking lip\'s ramp uses the rest' : ''}.${asked ? ' Dividers, scoop and label tab need about 10 mm of cavity and have been left off.' : ''}`,
    });
  }
  if (R.magnets && R.magnetD < num(p.magnetDepth, 2) - 1e-6) {
    out.push({ param: 'magnetDepth', severity: 'warn', message: `magnet pockets shortened to ${R.magnetD.toFixed(2)} mm so they stay blind under a ${R.floorZ.toFixed(2)} mm floor.` });
  }
  if (R.screws && R.magnets && R.screwR >= R.magnetR - 0.2) {
    out.push({ param: 'screwDia', severity: 'warn', message: 'the screw hole is as wide as the magnet pocket above it, so there is no shoulder for the magnet to sit on.' });
  }
  if (R.wall > 2.6 && R.lip) {
    out.push({ param: 'wall', severity: 'info', message: `the wall is thicker than the ${(R_BIN - lipX(0)).toFixed(2)} mm the stacking lip reaches inwards, so there is a small step inside the rim. It prints fine — material only disappears going up.` });
  }
  if (R.scoopR > 0 && R.scoopR < num(p.scoop, 0) - 1e-6) {
    out.push({ param: 'scoop', severity: 'warn', message: `the scoop was cut to ${R.scoopR.toFixed(1)} mm — a ${num(p.scoop, 0).toFixed(1)} mm radius does not fit a ${R.ch.toFixed(1)} mm deep compartment ${R.cavH.toFixed(1)} mm tall.` });
  }
  if (R.labelD > 0 && R.labelD < num(p.labelDepth, 12) - 1e-6) {
    out.push({ param: 'labelDepth', severity: 'warn', message: `the label tab was cut to ${R.labelD.toFixed(1)} mm; at ${R.labelAngle.toFixed(0)}° a deeper one would reach below the scoop.` });
  }
  if (R.labelD > 0 && R.labelAngle > 55) {
    out.push({ param: 'labelAngle', severity: 'warn', message: `${R.labelAngle.toFixed(0)}° makes the tab's underside a ${(90 - R.labelAngle).toFixed(0)}° overhang. Under 50° prints clean without support.` });
  }
  if (R.divX * R.divY > 1 && R.divT < 2 * nozzle) {
    out.push({ param: 'wall', severity: 'warn', message: `dividers are ${R.divT.toFixed(2)} mm — under two extrusions they go up as a single wobbly bead.` });
  }
  if (R.binH <= 2 * UNIT_H) {
    out.push({ param: 'units', severity: 'info', message: `the base profile eats the bottom ${BASE_H} mm of any bin, so this one has about ${Math.max(0, R.zr - R.floorZ).toFixed(1)} mm of usable depth. That is the specification, not a bug.` });
  }
  if (!R.lip) {
    out.push({ param: 'lip', severity: 'info', message: 'without the stacking lip nothing will nest on top of this bin. It still drops into a baseplate.' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

function hints(p, ctx = {}) {
  const R = resolve(p, ctx);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const nozzle = num(ctx.nozzle, 0.4);
  const ew = nozzle * 1.125;
  const notes = [];

  if (R.kind === 'baseplate') {
    notes.push(`${R.nx} × ${R.ny} cells, ${R.W} × ${R.D} mm, ${R.plateH.toFixed(2)} mm thick. Print it flat, socket side up — that is the way it comes out of this generator.`);
    notes.push(`Every socket wall is a 45° funnel and the outer rim is the same 45° the other way, so there is nothing here that needs support. Say no to supports; the slicer will offer.`);
    notes.push(`Walls ${Math.max(2, Math.round(1.2 / ew))}, top layers ${Math.max(3, Math.ceil(0.8 / layerH))}, bottom layers ${Math.max(3, Math.ceil(0.8 / layerH))}, infill 20–30%. A baseplate is mostly perimeter; infill barely moves the time.`);
    if (R.style === 'light') notes.push('The light plate is open under every socket, so the first layer is a thin frame. Brim it if a corner lifts.');
    else notes.push(`The solid plate has a ${R.plateFloor.toFixed(1)} mm floor, so bins bottom out ${(R.plateH - SOCKET_H - BASE_H + SOCKET_CLEAR_Z).toFixed(2)} mm below flush and nothing falls through onto the desk.`);
    notes.push('Elephant\'s foot matters more here than anywhere: a squashed first layer narrows the gap between sockets and bins start to bind. −0.10 to −0.15 mm compensation, or a 0.15 mm first layer.');
    return {
      profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
      filament: 'PLA or PETG — PETG if it lives in a drawer that gets warm',
      supports: false, notes,
    };
  }

  const perims = Math.max(1, Math.round(R.wall / ew));
  notes.push(`${R.nx}×${R.ny}×${(R.binH / UNIT_H).toFixed(R.binH % UNIT_H ? 1 : 0)} — ${R.W.toFixed(1)} × ${R.D.toFixed(1)} × ${R.topZ.toFixed(1)} mm with the lip. Base down, no rotation; every overhang in a gridfinity bin is 45° by design.`);
  notes.push(`Supports OFF. The base chamfers are 45°, the stacking lip's underside is 45°, the scoop is a fillet and the label tab is set at ${R.labelD > 0 ? R.labelAngle.toFixed(0) + '°' : '45° when enabled'}. Support inside a bin is unremovable, so if you ever need it here the parameters are wrong, not the slicer.`);
  notes.push(`${perims} wall${perims === 1 ? '' : 's'} at ${ew.toFixed(2)} mm gives the ${R.wall.toFixed(2)} mm wall exactly. Top layers 0 (the bin is open), bottom layers ${Math.max(4, Math.ceil(1.0 / layerH))}, infill 10–15% gyroid — the floor is ${R.floorZ.toFixed(2)} mm of solid and the walls carry the load.`);
  notes.push(`Elephant's foot compensation −0.10 to −0.15 mm, or a 0.15 mm first layer. The base's bottom face is ${(BIN_SPAN - 2 * (BASE_H - 1.8 - 0.8) - 2 * 0.8).toFixed(1)} mm across and the whole fit depends on it; a squashed first layer is the single commonest reason a bin will not drop into a baseplate.`);
  if (R.magnets) notes.push(`Magnet pockets are ${(R.magnetR * 2).toFixed(1)} × ${R.magnetD.toFixed(1)} mm and open downwards, so they print as clean holes with no bridging. Press the magnets in after, north up on every one or the bins will fight each other.`);
  if (R.screws) notes.push(`Screw holes are ${(R.screwR * 2).toFixed(1)} mm and ${R.screwD.toFixed(1)} mm deep — tap them with the screw itself while the part is still warm.`);
  if (R.scoopR > 0) notes.push(`The ${R.scoopR.toFixed(1)} mm scoop is a concave fillet, which means the material grows downwards and there is nothing to bridge. Ironing on the top surfaces makes the tab legible if you write on it.`);
  if (R.divX * R.divY > 1) notes.push(`${R.divX * R.divY} compartments with ${R.divT.toFixed(2)} mm dividers. Dividers stop ${(R.binH - R.zr).toFixed(2)} mm below the rim so the stacking lip's ramp has somewhere to land.`);
  if (R.labelD > 0) notes.push(`The tab's top face is at ${R.zr.toFixed(2)} mm, ${(R.binH - R.zr).toFixed(2)} mm under the rim, which is what keeps it clear of the base of whatever bin stacks on top.`);
  if (R.nx > 1 || R.ny > 1) {
    notes.push(`The specification wants a 0.5 mm gap between adjacent feet, so the underside of this bin has ${(R.nx - 1) * R.ny + (R.ny - 1) * R.nx} narrow slots that the floor bridges at z = ${BASE_H} mm. They are 0.5 mm wide and the nozzle walks straight over them; a slicer that reports a long bridge there is measuring the length, not the span. Do not add support.`);
  }
  notes.push('The lip comes to a fine edge at the very top — that is the specification, and the slicer simply drops the last layer or two of it. It is not a hole.');

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: 'PLA for the desk, PETG for the workshop',
    supports: false,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const params = [
  {
    key: 'kind', label: 'Make', type: 'enum', def: 'bin', group: 'Grid',
    help: 'A bin drops into a baseplate; a baseplate is the tray the bins sit in.',
    options: [
      { v: 'bin', label: 'Bin', help: 'A container on the 42 mm grid.' },
      { v: 'baseplate', label: 'Baseplate', help: 'The grid of sockets the bins drop into.' },
    ],
  },
  { key: 'nx', label: 'Units across', type: 'int', def: 1, min: 1, max: 5, step: 1, group: 'Grid', help: 'Each unit is 42 mm.' },
  { key: 'ny', label: 'Units deep', type: 'int', def: 1, min: 1, max: 5, step: 1, group: 'Grid', help: 'Each unit is 42 mm. Non-square is fine — 3 × 1 is a tool bay.' },

  {
    key: 'heightMode', label: 'Height given in', type: 'enum', def: 'units', group: 'Size',
    help: 'Units are the native way to say it. Millimetres get rounded up to a whole unit so the bin still stacks.',
    showIf: (p) => p.kind !== 'baseplate',
    options: [
      { v: 'units', label: 'Units of 7 mm' },
      { v: 'mm', label: 'Millimetres' },
    ],
  },
  { key: 'units', label: 'Height', type: 'int', def: 3, min: 1, max: 18, step: 1, unit: 'u', group: 'Size', help: '7 mm each. A 1-unit bin has 2.25 mm of usable depth — the base takes the rest.', showIf: (p) => p.kind !== 'baseplate' && p.heightMode !== 'mm' },
  { key: 'heightMm', label: 'Height', type: 'number', def: 42, min: 7, max: 168, step: 1, precision: 1, unit: 'mm', group: 'Size', help: 'Rounded up to a whole 7 mm unit unless you turn snapping off.', showIf: (p) => p.kind !== 'baseplate' && p.heightMode === 'mm' },
  { key: 'snapUnits', label: 'Snap to whole units', type: 'bool', def: true, group: 'Size', help: 'Off gives you the exact millimetres and a bin that will not stack cleanly.', showIf: (p) => p.kind !== 'baseplate' && p.heightMode === 'mm' },
  { key: 'lip', label: 'Stacking lip', type: 'bool', def: true, group: 'Size', help: 'The 4.4 mm rim that another bin\'s base nests into. Off saves height and loses stacking.', showIf: (p) => p.kind !== 'baseplate' },
  { key: 'wall', label: 'Wall', type: 'number', def: 1.2, min: 0.8, max: 4, step: 0.1, precision: 2, unit: 'mm', soft: true, group: 'Size', help: '1.2 mm is three perimeters at a 0.4 nozzle. Also the divider thickness.', showIf: (p) => p.kind !== 'baseplate' },
  { key: 'floor', label: 'Floor', type: 'number', def: 0.8, min: 0.4, max: 10, step: 0.2, precision: 2, unit: 'mm', group: 'Size', help: 'Solid material above the 4.75 mm base profile, so the cavity floor sits at 4.75 + this. It is also what bridges the 0.5 mm gaps between the feet of a multi-unit bin.', showIf: (p) => p.kind !== 'baseplate' },

  { key: 'divX', label: 'Compartments across', type: 'int', def: 1, min: 1, max: 6, step: 1, group: 'Inside', help: 'Dividers run front to back.', showIf: (p) => p.kind !== 'baseplate' },
  { key: 'divY', label: 'Compartments deep', type: 'int', def: 1, min: 1, max: 6, step: 1, group: 'Inside', help: 'Dividers run left to right.', showIf: (p) => p.kind !== 'baseplate' },
  { key: 'scoop', label: 'Front scoop', type: 'number', def: 0, min: 0, max: 15, step: 0.5, precision: 1, unit: 'mm', group: 'Inside', help: 'A concave fillet at the front of each compartment so you can sweep small parts out with a finger.', showIf: (p) => p.kind !== 'baseplate' },
  {
    key: 'label', label: 'Label tab', type: 'enum', def: 'none', group: 'Inside',
    help: 'A sloped shelf under the rim to write on, and a decent grip for lifting the bin out.',
    showIf: (p) => p.kind !== 'baseplate',
    options: [
      { v: 'none', label: 'None' },
      { v: 'back', label: 'At the back' },
      { v: 'front', label: 'At the front' },
      { v: 'both', label: 'Both ends' },
    ],
  },
  { key: 'labelDepth', label: 'Tab depth', type: 'number', def: 12, min: 4, max: 20, step: 0.5, precision: 1, unit: 'mm', group: 'Inside', help: 'How far the tab reaches into the bin. 12 mm takes a 12 mm label tape.', showIf: (p) => p.kind !== 'baseplate' && p.label !== 'none' },
  { key: 'labelAngle', label: 'Tab underside', type: 'number', def: 45, min: 20, max: 60, step: 5, precision: 0, unit: '°', group: 'Inside', help: '45° prints without support. Steeper gives more label area and starts to need it.', showIf: (p) => p.kind !== 'baseplate' && p.label !== 'none' },

  { key: 'magnets', label: 'Magnet holes', type: 'bool', def: false, group: 'Hardware', help: '6 × 2 mm magnets in all four corners of every unit, so the bin holds in any rotation.' },
  { key: 'magnetDia', label: 'Magnet diameter', type: 'number', def: 6, min: 5, max: 8, step: 0.1, precision: 2, unit: 'mm', group: 'Hardware', help: 'The specification is 6.0. Many people print 6.2 for a slip fit instead of a press fit.', showIf: (p) => p.magnets || p.plateMagnets },
  { key: 'magnetDepth', label: 'Magnet depth', type: 'number', def: 2, min: 1, max: 4, step: 0.1, precision: 2, unit: 'mm', group: 'Hardware', help: 'The specification is 2.0.', showIf: (p) => p.magnets || p.plateMagnets },
  { key: 'screws', label: 'Screw holes', type: 'bool', def: false, group: 'Hardware', help: 'M3 holes at the same four positions, for screwing a bin down instead of magnetising it.', showIf: (p) => p.kind !== 'baseplate' },
  { key: 'screwDia', label: 'Screw diameter', type: 'number', def: 3, min: 2, max: 5, step: 0.1, precision: 2, unit: 'mm', group: 'Hardware', help: 'M3 is the standard. Self-tapping, so nominal rather than clearance.', showIf: (p) => p.kind !== 'baseplate' && p.screws },
  { key: 'screwDepth', label: 'Screw depth', type: 'number', def: 6, min: 3, max: 12, step: 0.5, precision: 1, unit: 'mm', group: 'Hardware', help: 'Deep enough for the thread to bite; the floor rises to stay above it.', showIf: (p) => p.kind !== 'baseplate' && p.screws },

  {
    key: 'plateStyle', label: 'Baseplate style', type: 'enum', def: 'light', group: 'Baseplate',
    help: 'Light is the standard thin frame. Solid puts a floor under the sockets: heavier, rigid, and nothing falls through.',
    showIf: (p) => p.kind === 'baseplate',
    options: [
      { v: 'light', label: 'Light (open)', help: 'Sockets go straight through. Least plastic.' },
      { v: 'solid', label: 'Solid (floored)', help: 'A closed floor under every socket.' },
    ],
  },
  { key: 'plateThickness', label: 'Plate thickness', type: 'number', def: 5, min: 4.75, max: 12, step: 0.25, precision: 2, unit: 'mm', group: 'Baseplate', help: 'Must clear the 4.65 mm socket. 5 mm is the standard.', showIf: (p) => p.kind === 'baseplate' && p.plateStyle !== 'solid' },
  { key: 'plateFloor', label: 'Plate floor', type: 'number', def: 2.4, min: 0.8, max: 8, step: 0.2, precision: 2, unit: 'mm', group: 'Baseplate', help: 'Solid material under each socket. 2.4 mm is enough to hide a 2 mm magnet.', showIf: (p) => p.kind === 'baseplate' && p.plateStyle === 'solid' },
  { key: 'plateMagnets', label: 'Magnets in the plate', type: 'bool', def: false, group: 'Baseplate', help: 'Pockets in the floor under each socket corner, to pull the bins down. Needs the solid style.', showIf: (p) => p.kind === 'baseplate' && p.plateStyle === 'solid' },
];

const presets = [
  {
    name: 'Bolt tin 1×1×6',
    values: { kind: 'bin', nx: 1, ny: 1, heightMode: 'units', units: 6, lip: true, wall: 1.2, floor: 0.8, divX: 1, divY: 1, scoop: 0, label: 'back', labelDepth: 12, magnets: true, screws: false },
  },
  {
    name: 'Long tool bay 3×1×4',
    values: { kind: 'bin', nx: 3, ny: 1, heightMode: 'units', units: 4, lip: true, wall: 1.2, floor: 0.8, divX: 1, divY: 1, scoop: 6, label: 'back', labelDepth: 14, magnets: false, screws: false },
  },
  {
    name: 'Screwdriver bay with scoop',
    values: { kind: 'bin', nx: 4, ny: 1, heightMode: 'units', units: 2, lip: true, wall: 1.2, floor: 0.8, divX: 1, divY: 1, scoop: 12, label: 'none', magnets: false, screws: false },
  },
  {
    name: '2×2 baseplate',
    values: { kind: 'baseplate', nx: 2, ny: 2, plateStyle: 'light', plateThickness: 5, plateMagnets: false },
  },
  {
    name: 'Six-way parts sorter 2×2×3',
    values: { kind: 'bin', nx: 2, ny: 2, heightMode: 'units', units: 3, lip: true, wall: 1.2, floor: 0.8, divX: 3, divY: 2, scoop: 3, label: 'none', magnets: false, screws: false },
  },
  {
    name: 'Magnet-mount SMD bin 1×2×3',
    values: { kind: 'bin', nx: 1, ny: 2, heightMode: 'units', units: 3, lip: true, wall: 1.2, floor: 1.2, divX: 1, divY: 3, scoop: 0, label: 'back', labelDepth: 10, magnets: true, magnetDia: 6, magnetDepth: 2, screws: true, screwDia: 3, screwDepth: 6 },
  },
  {
    name: 'Weighted 3×2 baseplate',
    values: { kind: 'baseplate', nx: 3, ny: 2, plateStyle: 'solid', plateFloor: 2.4, plateMagnets: true, magnetDia: 6, magnetDepth: 2 },
  },
  {
    name: 'Lidless tray 2×3×2, no lip',
    values: { kind: 'bin', nx: 2, ny: 3, heightMode: 'mm', heightMm: 14, snapUnits: true, lip: false, wall: 1.6, floor: 1.2, divX: 1, divY: 1, scoop: 8, label: 'none', magnets: false, screws: false },
  },
];

export default {
  id: 'gridfinity',
  name: 'Gridfinity',
  category: 'Storage',
  blurb: 'Bins and baseplates on the 42 mm grid, to the published specification.',
  description:
    'The most-printed object in the hobby, done to the numbers rather than to a memory of them. '
    + 'Bins from 1×1 to 5×5 in whole units, height in units or millimetres, an optional stacking lip that is '
    + 'the exact mirror of the socket it nests into, magnet and screw holes at the standard 26 mm spacing, a '
    + 'label tab, a front scoop, dividers on both axes, and light or solid baseplates. The base profile is '
    + 'swept as a rounded-rectangle cross-section rather than cut with booleans, so it comes out clean and at '
    + 'a fraction of the triangle count — and every dimension is measured back off the finished mesh by the '
    + 'test suite, because a bin that misses the specification by two tenths of a millimetre looks perfect on '
    + 'screen and only fails when you try to stack it.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
    + '<rect x="2.5" y="2.5" width="8.4" height="8.4" rx="1.6"/><rect x="13.1" y="2.5" width="8.4" height="8.4" rx="1.6"/>'
    + '<rect x="2.5" y="13.1" width="8.4" height="8.4" rx="1.6"/><rect x="13.1" y="13.1" width="8.4" height="8.4" rx="1.6"/>'
    + '<rect x="5.1" y="5.1" width="3.2" height="3.2" rx="0.6" opacity="0.55"/>'
    + '<rect x="15.7" y="15.7" width="3.2" height="3.2" rx="0.6" opacity="0.55"/></svg>',
  version: 1,
  params,
  presets,
  build,
  validate,
  hints,
};
