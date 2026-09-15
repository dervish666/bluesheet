// Stands and docks — the objects where the only thing that judges you is gravity.
//
// A stand is trivial to describe and easy to get wrong in ways that only show up
// when a 500 g tablet is leaning on it. Three things have to be true at once:
//
//   1. The slot is the device's thickness *with its case* plus a stated
//      clearance — measured perpendicular to the device, not horizontally.
//   2. The face the device leans on is at the angle you asked for. Not roughly.
//      Every derived dimension here comes off the same two unit vectors, so the
//      angle cannot drift between the slot, the lip and the rest.
//   3. The whole thing, with the device in it, does not tip over. That is a
//      statement about the centre of mass of a solid, and it is computed here
//      rather than eyeballed — see `tipAnalysis`, and `autoBase`, which grows the
//      base backwards until the margin is met.
//
// HOW THE SOLID IS BUILT
// ----------------------
// The body is a constant cross-section prism: one side profile in the X/Z plane,
// swept along Y. That is what a stand *is*, and building it that way means the
// slot, the lip and the rest are all exact by construction and the mesh is
// watertight without a single boolean. The profile is a simple closed polygon —
// the slot is a NOTCH open to the sky, never a hole — with a per-corner fillet
// list, because a 3 mm radius that is right on the outside corners would eat the
// slot floor if it were applied everywhere.
//
// Only the features that genuinely vary along Y use CSG: the cable shaft, the
// port cutout, the headphone hook and the ballast pocket. Four tools at most,
// every one of them overshooting the surfaces it crosses so no cut ever lands
// coplanar with a face it was not meant to touch.
//
// GEOMETRY CONVENTION (profile plane, before the sweep)
//   x  — depth. +x is toward the BACK of the stand.
//   y  — height. y = 0 is the desk.
//   u  = (cos A, sin A)   up the face of the device
//   n  = (-sin A, cos A)  out of the screen
// The device's back-bottom corner sits at Q = (0, baseT). Everything else is Q
// plus a multiple of u and n, which is why the angle comes out exact.

import { Mesh, TAU } from '../kernel/mesh.js';
import { extrude } from '../kernel/builders.js';
import { area, centroid, boolean, offset, bounds } from '../kernel/poly2d.js';
import { subtractAll, unionAll } from '../kernel/csg.js';
import { FILAMENT_DENSITY } from '../kernel/validate.js';
import { clamp, num } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const BED = { x: 180, y: 180, z: 180 };
// Kept clear of the bed edge: the A1's first layer is happiest away from the
// very edge of the plate, and a stand is not a part you want to re-print.
const BED_MARGIN = 2;
// Nothing thinner than this survives being a wall on a 0.4 mm nozzle.
const MIN_WALL = 1.2;
// Material left either side of a Y-band cut (cable shaft, ballast pocket) so the
// cut never opens onto the outside of the part.
const MIN_SIDE = 1.6;
// Lip height below which the lip is decorative rather than retaining.
const MIN_RETAIN = 3;
// A printed part is not solid plastic. Walls, top and bottom take roughly 30% of
// the envelope on a part this size; the rest is infill. Used for the tipping
// arithmetic, where UNDER-estimating the stand's own mass is the safe direction.
const SHELL_FRACTION = 0.30;

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------

/** Sweep a profile ring in the X/Y plane along Y, centred on `yc`, width `w`. */
function prism(shape, w, yc = 0, opts = {}) {
  return extrude(shape, w, opts).rotateX(Math.PI / 2).translate(0, yc + w / 2, 0);
}

/** An axis-aligned block given as [x0,x1],[y0,y1],[z0,z1] — used only as CSG tooling. */
function block(x0, x1, y0, y1, z0, z1) {
  const m = new Mesh();
  const b = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => m.addVertex(p[0], p[1], z0));
  const t = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => m.addVertex(p[0], p[1], z1));
  m.addQuad(b[3], b[2], b[1], b[0]);
  m.addQuad(t[0], t[1], t[2], t[3]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    m.addQuad(b[i], b[j], t[j], t[i]);
  }
  return m;
}

function dedupeRing(pts, eps = 1e-7) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < eps) out.pop();
  return out;
}

/**
 * Round a polygon's corners with a DIFFERENT radius at each corner.
 *
 * poly2d.roundedPath takes one radius for the whole ring, which is exactly wrong
 * here: the outside corners want 3 mm and the slot's inside corners want 1 mm or
 * the cradle stops being the size the device is. Same clamping rule as the kernel
 * (a corner may never eat more than half of either adjacent edge), so a generous
 * radius on a short edge shortens itself instead of turning the ring inside out.
 *
 * `entries` is [[x, y, r], ...].
 */
function filletPoly(entries, segs = 4) {
  const P = [];
  for (const e of entries) {
    const last = P[P.length - 1];
    if (last && Math.hypot(e[0] - last[0], e[1] - last[1]) < 1e-7) continue;
    P.push([e[0], e[1], Math.max(0, num(e[2], 0))]);
  }
  while (P.length > 2 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-7) P.pop();
  const n = P.length;
  if (n < 3) return P.map(p => [p[0], p[1]]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = P[(i - 1 + n) % n], cur = P[i], next = P[(i + 1) % n];
    let d1x = cur[0] - prev[0], d1y = cur[1] - prev[1];
    let d2x = next[0] - cur[0], d2y = next[1] - cur[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 < 1e-9 || l2 < 1e-9 || !(cur[2] > 0)) { out.push([cur[0], cur[1]]); continue; }
    d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
    const cross = d1x * d2y - d1y * d2x;
    const dot = -(d1x * d2x + d1y * d2y);
    if (Math.abs(cross) < 1e-9) { out.push([cur[0], cur[1]]); continue; }
    const theta = Math.acos(clamp(dot, -1, 1));
    const tanHalf = Math.tan(theta / 2);
    if (!(tanHalf > 1e-9) || !isFinite(tanHalf)) { out.push([cur[0], cur[1]]); continue; }
    const rr = Math.min(cur[2], tanHalf * Math.min(l1, l2) / 2);
    if (!(rr > 1e-5)) { out.push([cur[0], cur[1]]); continue; }
    const t = rr / tanHalf;
    const t1 = [cur[0] - d1x * t, cur[1] - d1y * t];
    const t2 = [cur[0] + d2x * t, cur[1] + d2y * t];
    let bx = d2x - d1x, by = d2y - d1y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) { out.push([cur[0], cur[1]]); continue; }
    bx /= bl; by /= bl;
    const cd = rr / Math.sin(theta / 2);
    const c = [cur[0] + bx * cd, cur[1] + by * cd];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let sweep = a2 - a1;
    if (cross > 0) { while (sweep < 0) sweep += TAU; } else { while (sweep > 0) sweep -= TAU; }
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) * segs));
    for (let k = 0; k <= steps; k++) {
      const a = a1 + sweep * (k / steps);
      out.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]);
    }
  }
  return dedupeRing(out);
}

/** Volume and centre of mass of a closed mesh, by tetrahedra about the origin. */
export function centreOfMass(mesh) {
  const p = mesh.positions, t = mesh.tris;
  let vol = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    mx += v * (ax + bx + cx) / 4;
    my += v * (ay + by + cy) / 4;
    mz += v * (az + bz + cz) / 4;
  }
  if (Math.abs(vol) < 1e-12) return { volume: 0, centre: [0, 0, 0] };
  return { volume: vol, centre: [mx / vol, my / vol, mz / vol] };
}

/** Convex hull of 2D points, counter-clockwise, monotone chain. */
export function hull2(pts) {
  const p = pts.map(q => [q[0], q[1]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const uniq = [];
  for (const q of p) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 1e-9 && Math.abs(last[1] - q[1]) < 1e-9) continue;
    uniq.push(q);
  }
  if (uniq.length < 3) return uniq;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const q = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * Signed distance from a point to a convex CCW polygon: positive inside, and the
 * value is the distance to the nearest edge. That number is the tipping margin —
 * how far the stand can be nudged before the centre of gravity leaves the feet.
 */
export function marginInHull(hull, pt) {
  if (hull.length < 3) return -Infinity;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    // CCW hull: the inside is to the left of every edge.
    const d = ((pt[0] - a[0]) * ey - (pt[1] - a[1]) * ex) / len;
    best = Math.min(best, -d);
  }
  return best === Infinity ? -Infinity : best;
}

/** Every vertex touching the plate, as the raw material for the support polygon. */
export function contactPoints(mesh, tol = 0.02) {
  const p = mesh.positions, out = [];
  const z0 = mesh.bbox().min[2];
  for (let i = 0; i < p.length; i += 3) if (p[i + 2] - z0 <= tol) out.push([p[i], p[i + 1]]);
  return out;
}

// ---------------------------------------------------------------------------
// solve — every derived dimension in one place
// ---------------------------------------------------------------------------

/**
 * Turn the parameter bag into a geometry description. Pure, cheap, and the only
 * place a number is ever clamped, so `validate` and `hints` can report exactly
 * what the mesh will be rather than what was asked for.
 */
export function solve(p = {}, ctx = {}) {
  const g = {};
  g.notes = [];
  g.sf = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const bed = g.bed = ctx.bed || BED;
  const segs = Math.max(2, Math.round(4 * g.sf));
  g.segs = segs;

  // ---- the device ---------------------------------------------------------
  g.deviceT = clamp(num(p.deviceT, 9), 1, 60);
  g.deviceW = clamp(num(p.deviceW, 179), 20, 400);
  g.deviceH = clamp(num(p.deviceH, 248), 30, 500);
  g.deviceMass = clamp(num(p.deviceMass, 500), 5, 8000);
  g.screenInset = clamp(num(p.screenInset, 9), 0, 60);
  g.angleDeg = clamp(num(p.angle, 62), 10, 88);
  const A = g.A = g.angleDeg * D2R;
  const sinA = Math.sin(A), cosA = Math.cos(A), tanA = sinA / cosA;
  g.u = [cosA, sinA];
  g.n = [-sinA, cosA];
  g.slotClear = clamp(num(p.slotClear, 0.6), 0, 5);
  g.S = g.deviceT + g.slotClear;

  g.style = p.style === 'easel' ? 'easel' : 'wedge';
  g.arrange = p.arrange === 'assembled' ? 'assembled' : 'plate';
  g.fit = clamp(num(p.fit, 0.2), 0, 1.2);
  g.infill = clamp(num(p.infill, 15), 1, 100);
  g.cornerR = clamp(num(p.cornerR, 3), 0, 25);

  // ---- width across the desk ---------------------------------------------
  g.hook = ['left', 'right', 'both'].includes(p.hook) ? p.hook : 'none';
  if (g.style !== 'wedge') g.hook = 'none';
  g.hookT = clamp(num(p.hookT, 8), 2, 30);
  g.hookLen = clamp(num(p.hookLen, 34), 6, 120);
  const hookSides = g.hook === 'both' ? 2 : g.hook === 'none' ? 0 : 1;
  g.coverage = clamp(num(p.coverage, 0.5), 0.05, 1);
  const widthRoom = bed.y - 2 * BED_MARGIN - hookSides * g.hookT;
  g.standW = clamp(g.deviceW * g.coverage, 10, Math.max(10, widthRoom));

  // ---- cradle -------------------------------------------------------------
  g.baseT = clamp(num(p.baseT, 6), 1.6, 40);
  g.lipT = clamp(num(p.lipT, 2.8), 1, 12);
  g.lipMargin = clamp(num(p.lipMargin, 2), 0, 25);
  g.minRetain = Math.max(MIN_RETAIN, 0.35 * g.S);
  g.lipAsked = clamp(num(p.lipH, 8), 1, 60);
  const lipRoom = g.screenInset - g.lipMargin;
  // The fillet on the top of the lip is taken out of the retaining face, so the
  // floor has to be applied to the FLAT part and not to the overall height.
  // Applying it to the height delivered 2.10 mm of flat face against a stated
  // 3.36 mm floor on a shallow-bezel phone — a lip that measures right in the
  // parameters and is a third short in the plastic, which is the only place it
  // has to hold anything up.
  g.lipR = Math.min(g.lipT * 0.45, 1.5);
  g.lipH = Math.max(g.minRetain + g.lipR, Math.min(g.lipAsked, lipRoom));
  // What actually retains the device: the flat face below the fillet.
  g.lipFlat = g.lipH - g.lipR;
  g.lipTrimmed = g.lipH < g.lipAsked - 1e-9;
  // The one invariant the lip exists to satisfy: it retains the device and it
  // stops short of the glass. When the bezel is too shallow for both, geometry
  // keeps the retention and `validate` says so out loud.
  g.lipCoversScreen = g.lipH > lipRoom + 1e-9;

  g.restT = clamp(num(p.restT, 5), 1.2, 30);
  const restHMax = Math.max(4, (bed.z - 2 * BED_MARGIN - g.baseT - 2) / Math.max(0.05, sinA));
  g.restH = Math.min(
    Math.max(clamp(num(p.restH, 45), 4, 200), (g.restT * cosA + 1.2) / Math.max(0.05, sinA)),
    restHMax);
  g.restT = Math.min(g.restT, Math.max(0.6, (g.restH * sinA - 0.8) / Math.max(0.05, cosA)));

  // Anchor: the device's back-bottom corner. Everything is Q + a·u + b·n.
  const Q = g.Q = [0, g.baseT];
  const F = g.F = [Q[0] + g.n[0] * g.S, Q[1] + g.n[1] * g.S];
  g.Rtop = [Q[0] + g.u[0] * g.restH, Q[1] + g.u[1] * g.restH];
  g.RtopBack = [g.Rtop[0] - g.n[0] * g.restT, g.Rtop[1] - g.n[1] * g.restT];
  g.LtopIn = [F[0] + g.u[0] * g.lipH, F[1] + g.u[1] * g.lipH];
  g.LtopOut = [g.LtopIn[0] + g.n[0] * g.lipT, g.LtopIn[1] + g.n[1] * g.lipT];
  // Where the lip's outer face meets the top of the base: -(S + lipT)/sin A,
  // which is why a shallow angle pushes the whole cradle forward.
  g.xLipBase = -(g.S + g.lipT) / Math.max(0.05, sinA);

  g.slotR = Math.min(1.0, g.S * 0.25, g.lipH * 0.3);

  // ---- easel prop and sockets --------------------------------------------
  if (g.style === 'easel') {
    g.stopT = g.restT;
    // The stop's back face must clear the top of the base, which is what
    // stopT·cot A buys: below that the wall would poke out of its own footing.
    const stopLo = Math.max(6, g.lipH + 1, g.stopT / Math.max(0.02, tanA) + 1.0);
    g.stopH = Math.max(Math.min(Math.max(g.lipH * 1.8, stopLo), g.restH),
                       g.stopT / Math.max(0.02, tanA) + 0.6);
    g.td = clamp(Math.min(5, g.baseT - 1.2), 1.0, 8);
    g.propW = clamp(g.restT + 2, 5, 18);
    // The prop has to stand clear of the back stop at every height it reaches.
    const xMin = g.stopH * cosA + g.stopT / Math.max(0.05, sinA) + 1.5;
    const hMax = bed.z - 2 * BED_MARGIN - (g.baseT - g.td);
    const xMax = Math.max(xMin + 1, (hMax - 2 - g.td) / Math.max(0.02, tanA));
    g.x0 = clamp(g.restH * cosA, xMin, xMax);
    g.propHFront = g.td + g.x0 * tanA;
    g.propHBack = Math.min(g.propHFront + g.propW * tanA, hMax);
    g.propBevelX = Math.min(g.propW, (g.propHBack - g.propHFront) / Math.max(0.02, tanA));

    // Socket positions come from the angles they are meant to give, not the
    // other way round, so the nominal socket is exactly `angle` by construction.
    const wantN = clamp(Math.round(num(p.angleSteps, 3)), 1, 6);
    const askSpread = clamp(num(p.angleSpread, 10), 1, 30);
    const pitchMin = g.propW + g.fit + 1.6;
    const xFor = (deg) => (g.propHFront - g.td) / Math.tan(clamp(deg, 12, 87) * D2R);
    const trial = (n, spread) => {
      const ks = [0];
      for (let i = 1; ks.length < n; i++) { ks.push(i); if (ks.length < n) ks.push(-i); }
      const list = ks.map(k => ({ k, deg: clamp(g.angleDeg + k * spread, 15, 87) }))
        .map(o => ({ ...o, x: xFor(o.deg) }))
        .filter(o => o.x >= xMin - 1e-9 && o.x <= xMax + 40)
        .sort((a, b) => a.x - b.x);
      for (let i = 1; i < list.length; i++) if (list[i].x - list[i - 1].x < pitchMin) return null;
      return list.length === n ? list : null;
    };
    let sockets = null, spread = askSpread;
    for (let n = wantN; n >= 1 && !sockets; n--) {
      for (let s = askSpread; s <= 30.001 && !sockets; s += 0.5) {
        const t = trial(n, s);
        if (t) { sockets = t; spread = s; }
      }
    }
    if (!sockets) sockets = [{ k: 0, deg: g.angleDeg, x: g.x0 }];
    g.sockets = sockets;
    g.spread = spread;
    g.spreadWidened = spread > askSpread + 1e-9;
    g.stepsDropped = wantN - sockets.length;
    g.angles = sockets.map(s => s.deg).sort((a, b) => a - b);
  }

  // ---- footprint ----------------------------------------------------------
  g.frontLen = clamp(num(p.frontLen, 14), 0, 120);
  g.backLen = clamp(num(p.backLen, 30), 0, 160);
  g.tipMargin = clamp(num(p.tipMargin, 8), 0.5, 50);
  g.autoBase = p.autoBase !== false;
  g.wallT = clamp(num(p.wallT, 4), 1.6, 15);
  g.weighted = p.weighted === true && g.style === 'wedge';
  g.fillDensity = clamp(num(p.fillDensity, 1.6), 0.2, 12);
  g.cable = p.cable !== false;
  g.cableW = clamp(num(p.cableW, 12), 3, 60);
  g.portAsked = clamp(num(p.portOffset, 0), -200, 200);

  const rearOf = (backLen) => (g.style === 'easel'
    ? Math.max(...g.sockets.map(s => s.x + g.propW + g.fit)) + Math.max(4, backLen)
    : g.RtopBack[0] + Math.max(1, backLen));
  const depthRoom = bed.x - 2 * BED_MARGIN;
  g.setFootprint = (frontLen, backLen) => {
    g.frontLen = clamp(frontLen, 0, 200);
    g.backLen = clamp(backLen, 0, 200);
    g.xFront = g.xLipBase - g.frontLen;
    g.xBack = rearOf(g.backLen);
    if (g.xBack - g.xFront > depthRoom) {
      const over = g.xBack - g.xFront - depthRoom;
      const takeBack = Math.min(over, Math.max(0, g.backLen - (g.style === 'easel' ? 4 : 1)));
      g.backLen -= takeBack;
      g.xBack = rearOf(g.backLen);
      g.frontLen = Math.max(0, g.frontLen - (over - takeBack));
      g.xFront = g.xLipBase - g.frontLen;
    }
    g.depth = g.xBack - g.xFront;
  };
  g.setFootprint(g.frontLen, g.backLen);

  // ---- cable band ---------------------------------------------------------
  g.cableW = Math.min(g.cableW, g.standW - 2 * MIN_SIDE);
  if (!(g.cableW >= 3)) { g.cable = false; g.cableW = 0; }
  const portRoom = Math.max(0, g.standW / 2 - g.cableW / 2 - MIN_SIDE);
  g.port = clamp(g.portAsked, -portRoom, portRoom);
  g.portClamped = Math.abs(g.port - g.portAsked) > 1e-6;
  g.grooveH = clamp(Math.min(3.5, g.baseT - 1.2), 0.8, 6);
  // On the easel the groove runs back UNDER the sockets, and the sockets are
  // notches cut DOWN into the same top face — so the two meet in the middle of
  // the base. At the default 6 mm base the socket floor sits at 1.20 mm and the
  // groove roof at 3.50, and the route came out through the floor of every
  // socket: a cableW-wide hole exactly where the prop's foot has to bear. Cap
  // the groove under the floor, and when the base is too thin for even that,
  // stop the route short of the frontmost socket rather than tunnelling through
  // it — the cable leaves at the front, which is where it was going anyway.
  g.grooveShort = false;
  if (g.style === 'easel' && g.cable && g.sockets) {
    const room = (g.baseT - g.td) - MIN_WALL;
    if (room >= 0.8) g.grooveH = Math.min(g.grooveH, room);
    else g.grooveShort = true;
  }
  g.plugRoom = g.F[1];                     // clear depth under the device's port

  // ---- make it not fall over ---------------------------------------------
  // The 2D twin ignores the material the cuts take out, so aim a little long and
  // let the mesh-accurate check in `build` have the last word.
  const need = g.tipMargin * 1.08;
  const back0 = g.backLen, front0 = g.frontLen;
  g.grewBack = 0; g.grewFront = 0;
  if (g.autoBase) {
    for (let i = 1; i <= 80; i++) {
      if (tip2d(g).back >= need) break;
      const want = back0 + i * 2;
      g.setFootprint(g.frontLen, want);
      if (g.backLen < want - 1e-6) break;              // the bed said no
    }
    g.grewBack = g.backLen - back0;
    for (let i = 1; i <= 60; i++) {
      if (tip2d(g).front >= need) break;
      const want = front0 + i * 2;
      g.setFootprint(want, g.backLen);
      if (g.frontLen < want - 1e-6) break;
    }
    g.grewFront = g.frontLen - front0;
  }
  g.tip2d = tip2d(g);
  g.ballast = ballastGeom(g);
  g.hookSpec = hookGeom(g);
  g.hookRefused = g.hook !== 'none' && !g.hookSpec;
  g.weightRefused = p.weighted === true && g.style === 'wedge' && !g.ballast;

  return g;
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

/** The wedge's side profile, counter-clockwise, as [x, y, cornerRadius] entries. */
export function wedgeProfile(g) {
  const r = g.cornerR;
  return [
    [g.xFront, 0, 0],
    [g.xBack, 0, 0],
    [g.RtopBack[0], g.RtopBack[1], r],
    [g.Rtop[0], g.Rtop[1], r],
    [g.Q[0], g.Q[1], g.slotR],
    [g.F[0], g.F[1], g.slotR],
    [g.LtopIn[0], g.LtopIn[1], g.lipR],
    [g.LtopOut[0], g.LtopOut[1], g.lipR],
    [g.xLipBase, g.baseT, Math.min(r, g.baseT * 0.8)],
    [g.xFront, g.baseT, Math.min(r, g.baseT * 0.8)],
  ];
}

/** The easel base's side profile: the same cradle, a low back stop, and the sockets. */
export function easelBaseProfile(g) {
  const r = g.cornerR;
  const sinA = Math.sin(g.A);
  const stopIn = [g.Q[0] + g.u[0] * g.stopH, g.Q[1] + g.u[1] * g.stopH];
  const stopBack = [stopIn[0] - g.n[0] * g.stopT, stopIn[1] - g.n[1] * g.stopT];
  const out = [
    [g.xFront, 0, 0],
    [g.xBack, 0, 0],
    [g.xBack, g.baseT, Math.min(r, g.baseT * 0.6)],
  ];
  // Sockets are traversed back to front, each a notch down into the base's top.
  const back = [...g.sockets].sort((a, b) => b.x - a.x);
  for (const s of back) {
    const x1 = s.x + g.propW + g.fit;
    out.push([x1, g.baseT, 0.5], [x1, g.baseT - g.td, 0.5], [s.x, g.baseT - g.td, 0.5], [s.x, g.baseT, 0.5]);
  }
  out.push(
    [g.stopT / Math.max(0.05, sinA), g.baseT, Math.min(r, g.baseT * 0.6)],
    [stopBack[0], stopBack[1], g.lipR],
    [stopIn[0], stopIn[1], g.lipR],
    [g.Q[0], g.Q[1], g.slotR],
    [g.F[0], g.F[1], g.slotR],
    [g.LtopIn[0], g.LtopIn[1], g.lipR],
    [g.LtopOut[0], g.LtopOut[1], g.lipR],
    [g.xLipBase, g.baseT, Math.min(r, g.baseT * 0.8)],
    [g.xFront, g.baseT, Math.min(r, g.baseT * 0.8)]);
  return out;
}

/** The prop: a block whose top is bevelled to exactly the viewing angle. */
export function propProfile(g) {
  const out = [[0, 0, 0.9], [g.propW, 0, 0.9], [g.propW, g.propHBack, 1]];
  if (g.propBevelX < g.propW - 1e-6) out.push([g.propBevelX, g.propHBack, 1]);
  out.push([0, g.propHFront, 0.8]);
  return out;
}

// ---------------------------------------------------------------------------
// features that vary along Y — the only CSG in the file
// ---------------------------------------------------------------------------

/**
 * The cable route: a shaft straight up through the base into the slot floor, a
 * notch through the lip at the device's port, and a groove along the underside
 * to the back edge. Every one of them opens to the outside, so the plug has a
 * way in and the cable has a way out — no blind pockets.
 */
export function cableTools(g) {
  if (!g.cable) return [];
  const lipFloor = g.baseT - Math.min(1.5, g.baseT * 0.4);
  // All three legs of the route occupy the SAME band in Y — the cable is one
  // cable — so the route is a prism, and the honest way to cut it is to union
  // the three rectangles in the profile plane and sweep the result once.
  //
  // Handing three overlapping boxes to subtractAll instead is what the first
  // version did, and it does not merge cutters whose bounding boxes touch: each
  // box is subtracted in turn, so every pass re-cuts faces the previous pass had
  // just created exactly coplanar with the next box's walls. The result is
  // watertight and manifold — every check the generator ran said so — and
  // riddled with self-intersections: 6 at the defaults, 28 on the headphone
  // preset, 0 with the cable route switched off. Bluesheet's own deep check reports
  // those at severity ERROR, so the object the generator shipped by default was
  // one the app would have refused to slice cleanly.
  const rect = (x0, x1, z0, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const legs = [
    rect(g.F[0] - 0.6, g.Q[0] + 0.6, -2, g.F[1] + 1.0),                       // up through the base into the slot floor
    rect(g.xLipBase - 1.5, g.F[0] + 0.6, lipFloor, g.LtopOut[1] + 3),         // out through the lip at the device's port
  ];
  // The groove's back end: the bed edge normally, but short of the frontmost
  // socket when the easel's base has no room for a groove beneath it. Dropped
  // altogether when even that leaves nothing worth cutting.
  const grooveBack = g.grooveShort && g.sockets
    ? Math.min(...g.sockets.map((sk) => sk.x)) - 1.0
    : g.xBack + 2;
  if (grooveBack > g.Q[0] + 0.5) legs.push(rect(g.Q[0] - 0.3, grooveBack, -2, g.grooveH));
  let shape = [legs[0]];
  for (let i = 1; i < legs.length; i++) shape = boolean(shape, [legs[i]], 'union');
  return [prism(shape, g.cableW, g.port)];
}

/**
 * The ballast pocket: a gabled void in the wedge with a chimney out through the
 * top of the back slope. The gable roof is why it needs no support and the
 * chimney is why the sand goes in at the top and stays there.
 * Returns null when the wedge has not got the meat for it.
 */
export function ballastGeom(g) {
  if (!g.weighted) return null;
  const rbx = g.RtopBack[0], rby = g.RtopBack[1];
  const tanA = Math.tan(g.A);
  const span = g.xBack - rbx;
  if (!(span > 0) || !(rby > 0)) return null;
  const yExit = (x) => rby * (x - g.xBack) / (rbx - g.xBack);
  const cavW = g.standW - 2 * Math.max(g.wallT, MIN_SIDE);
  if (cavW < 8) return null;
  const yFloor = Math.max(g.wallT, g.grooveH + 1.2, 1.6);
  const xp0 = rbx + g.wallT;
  for (let k = 0; k < 8; k++) {
    const xp1 = g.xBack - g.wallT - k * Math.max(2, span * 0.1);
    const len = xp1 - xp0;
    if (len < 8) break;
    const rise = len / 2;
    const ridge = Math.min(yExit(xp1), g.baseT + xp0 * tanA) - g.wallT;
    const yEave = ridge - rise;
    if (yEave < yFloor + 4) continue;
    const xm = (xp0 + xp1) / 2;
    const chW = clamp(len * 0.5, 4, 14);
    const portW = Math.min(cavW, 14);
    const gable = [[xp0, yFloor], [xp1, yFloor], [xp1, yEave], [xm, ridge], [xp0, yEave]];
    return { xp0, xp1, xm, yFloor, yEave, ridge, cavW, len, chW, portW, gable,
             centre: centroid(gable),
             volume: cavW * (len * (yEave - yFloor) + len * rise / 2) };
  }
  return null;
}

function ballastTools(g, bal) {
  const gable = [[bal.xp0, bal.yFloor], [bal.xp1, bal.yFloor], [bal.xp1, bal.yEave],
                 [bal.xm, bal.ridge], [bal.xp0, bal.yEave]];
  return [
    prism(gable, bal.cavW, 0),
    block(bal.xm - bal.chW / 2, bal.xm + bal.chW / 2, -bal.portW / 2, bal.portW / 2,
          bal.ridge - 3, g.RtopBack[1] + 10),
  ];
}

/**
 * The headphone hook: a fin on the side of the wedge carrying a peg that
 * projects behind the stand, where it cannot foul a device wider than the base.
 * The peg's underside is a 45 degree gusset back into the slope and the fin
 * reaches the plate, so nothing in it starts in mid-air.
 */
export function hookGeom(g) {
  if (g.hook === 'none' || g.style !== 'wedge') return null;
  const rbx = g.RtopBack[0], rby = g.RtopBack[1];
  const slope = (y) => g.xBack + (rbx - g.xBack) * clamp(y / Math.max(1e-6, rby), 0, 1);
  const restX = (y) => (y - g.baseT) / Math.max(0.02, Math.tan(g.A));
  const pegH = clamp(g.hookT * 0.9, 4, 14);
  const upH = clamp(pegH * 0.8, 3.5, 12);
  const upT = clamp(g.hookT * 0.45, 1.6, 6);
  const yTop = clamp(rby * 0.72, g.baseT + 8, Math.max(g.baseT + 9, rby - 2));
  const rootX = Math.max(restX(yTop) + 3, slope(yTop) - 4);
  if (rootX > slope(yTop) - 1.5) return null;         // no meat to hang it off
  for (let attempt = 0; attempt < 10; attempt++) {
    const len = g.hookLen * Math.pow(0.85, attempt);
    if (len < 6) break;
    const xTip = g.xBack + len;
    if (xTip - g.xFront > g.bed.x - 2 * BED_MARGIN) continue;
    // Walk the 45 degree gusset down from the peg's tip until it is inside.
    let t = 0, ok = false;
    for (let i = 0; i < 400; i++) {
      t = i * 0.25;
      const x = xTip - t, y = yTop - pegH - t;
      if (y < 1.5) break;
      if (x <= slope(y) - 0.5 && x >= restX(y) + 2) { ok = true; break; }
    }
    if (!ok) continue;
    t += 3;                                            // bite into the slope
    const gx = xTip - t, gy = yTop - pegH - t;
    if (gy < 1.5 || gx <= rootX + 1) continue;
    const ring = [
      [rootX, yTop, 1],
      [xTip - upT, yTop, 1],
      [xTip - upT, yTop + upH, Math.min(1.5, upT * 0.4)],
      [xTip, yTop + upH, Math.min(2, upT * 0.6)],
      [xTip, yTop - pegH, Math.min(2, pegH * 0.4)],
      [gx, gy, 2],
      [gx, 0, 0],
      [rootX, 0, 0],
    ];
    return { ring, xTip, yTop, pegH, upH, upT, len };
  }
  return null;
}

function hookMeshes(g, hk) {
  if (!hk) return [];
  const ring = filletPoly(hk.ring, g.segs);
  // The fin overlaps the body rather than butting against it: a solid that
  // shares a volume with its neighbour is the case a mesh boolean is reliable
  // at, and a solid that only touches it is the case it is not.
  const overlap = clamp(g.standW * 0.3, 1, 4);
  const w = g.hookT + overlap;
  const off = g.standW / 2 + (g.hookT - overlap) / 2;
  const out = [];
  if (g.hook === 'right' || g.hook === 'both') out.push(prism(ring, w, off));
  if (g.hook === 'left' || g.hook === 'both') out.push(prism(ring, w, -off));
  return out;
}

// ---------------------------------------------------------------------------
// the physics that decides whether this is a stand or a domino
// ---------------------------------------------------------------------------

/** Effective density of a printed part, g/mm³. Walls and skins, then infill. */
export function printedDensity(infillPct, filament = 'PLA') {
  const rho = (FILAMENT_DENSITY[String(filament).toUpperCase()] || FILAMENT_DENSITY.PLA) / 1000;
  return rho * (SHELL_FRACTION + (1 - SHELL_FRACTION) * clamp(infillPct, 0, 100) / 100);
}

/** Where the device's own centre of mass sits, in design coordinates. */
export function deviceCentre(g) {
  const a = g.deviceH / 2, b = g.deviceT / 2;
  return [g.Q[0] + g.u[0] * a + g.n[0] * b, 0, g.Q[1] + g.u[1] * a + g.n[1] * b];
}

/**
 * The whole point of the generator. Mass of the printed stand, mass of the
 * device where the device actually sits, mass of any ballast, then ask whether
 * the combined centre of gravity is inside the feet — and by how much.
 */
export function tipAnalysis(g, mesh, opts = {}) {
  const rho = printedDensity(g.infill, opts.filament || 'PLA');
  const com = centreOfMass(mesh);
  const standMass = Math.max(0, com.volume) * rho;
  const bal = opts.ballast || null;
  const ballastMass = bal ? bal.volume * (g.fillDensity / 1000) : 0;
  const dev = deviceCentre(g);
  const total = standMass + ballastMass + g.deviceMass;
  const wsum = (i, a, b, c) => (standMass * a[i] + ballastMass * (b ? b[i] : 0) + g.deviceMass * c[i]) / total;
  const balC = bal ? [bal.centre[0], 0, bal.centre[1]] : null;
  const cog = [wsum(0, com.centre, balC, dev), wsum(1, com.centre, balC, dev), wsum(2, com.centre, balC, dev)];
  const hull = hull2(contactPoints(mesh));
  const margin = marginInHull(hull, [cog[0], cog[1]]);
  let xRear = -Infinity, xFore = Infinity;
  for (const h of hull) { xRear = Math.max(xRear, h[0]); xFore = Math.min(xFore, h[0]); }
  // How hard you can prod the top of the screen before it goes over backwards.
  const pressZ = g.Q[1] + g.u[1] * g.deviceH + g.n[1] * g.deviceT;
  const pressN = pressZ > 1e-6 ? (total / 1000) * 9.81 * (xRear - cog[0]) / pressZ : Infinity;
  return {
    standMass, ballastMass, deviceMass: g.deviceMass, total,
    volume: com.volume, standCentre: com.centre, deviceCentre: dev, cog,
    hull, margin, xRear, xFore, pressN, pressZ,
    stable: margin >= g.tipMargin,
  };
}

/**
 * The cheap 2D twin of `tipAnalysis`, used to size the base. The body is a
 * constant cross-section prism, so its centre of mass in X is the profile's area
 * centroid — exact for the un-featured body and close enough to drive a search
 * that is checked against the real mesh afterwards.
 */
function tip2d(g) {
  const raw = (g.style === 'easel' ? easelBaseProfile(g) : wedgeProfile(g)).map(e => [e[0], e[1]]);
  const rho = printedDensity(g.infill);
  const a = area(raw), c = centroid(raw);
  let mass = a * g.standW * rho, mx = c[0] * mass;
  if (g.style === 'easel') {
    const pr = propProfile(g).map(e => [e[0], e[1]]);
    const pm = area(pr) * g.standW * rho;
    mass += pm; mx += (centroid(pr)[0] + g.x0) * pm;
  }
  const bal = ballastGeom(g);
  if (bal) {
    const hollow = area(bal.gable) * bal.cavW * rho;
    mass -= hollow; mx -= bal.centre[0] * hollow;
    const bm = bal.volume * (g.fillDensity / 1000);
    mass += bm; mx += bal.centre[0] * bm;
  }
  // A peg hanging off the back is the one feature that makes tipping worse, so
  // it has to be in the arithmetic that sizes the base, not just in the report.
  const hk = hookGeom(g);
  if (hk) {
    const hring = hk.ring.map(e => [e[0], e[1]]);
    const sides = g.hook === 'both' ? 2 : 1;
    const hm = area(hring) * g.hookT * sides * rho;
    mass += hm; mx += centroid(hring)[0] * hm;
  }
  const dev = deviceCentre(g);
  const total = mass + g.deviceMass;
  const cogX = (mx + g.deviceMass * dev[0]) / total;
  return { cogX, back: g.xBack - cogX, front: cogX - g.xFront };
}

// ---------------------------------------------------------------------------
// assembly — from profiles to solids
// ---------------------------------------------------------------------------

// One heal pass per part, at a tolerance a hundred times finer than anything the
// profiles draw on purpose. The only thing it is meant to close is a seam a
// boolean left half a micron open; it can never merge two features.
const HEAL_EPS = 1e-5;

const r1 = (v) => (isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * The wedge, as one solid. The prism is the whole part; the fins are unioned on
 * because they genuinely vary along Y, and the cable and ballast tools are taken
 * out of the result rather than out of the bare body, so a fin that crosses the
 * cable band is cut too.
 */
function wedgeSolid(g) {
  let body = prism(filletPoly(wedgeProfile(g), g.segs), g.standW, 0);
  const fins = hookMeshes(g, g.hookSpec);
  if (fins.length) body = unionAll([body, ...fins]);
  const cutters = cableTools(g);
  if (g.ballast) for (const t of ballastTools(g, g.ballast)) cutters.push(t);
  if (cutters.length) body = subtractAll(body, cutters);
  return body.healTJunctions(HEAL_EPS);
}

/**
 * The easel, as two solids in their own coordinates: the base in design
 * coordinates, the prop standing at the origin of its own profile.
 *
 * The prop is swept the full width of the base because the socket is a notch in
 * a constant cross-section — it runs the whole width, so a narrower prop would
 * be located in X and free to wander in Y. `tip2d` makes the same assumption,
 * which is why the base the solver sized is the base that gets built.
 */
function easelSolids(g) {
  let base = prism(filletPoly(easelBaseProfile(g), g.segs), g.standW, 0);
  const cutters = cableTools(g);
  if (cutters.length) base = subtractAll(base, cutters);
  const prop = prism(filletPoly(propStatus(g).ring, g.segs), g.standW, 0);
  return { base: base.healTJunctions(HEAL_EPS), prop: prop.healTJunctions(HEAL_EPS) };
}

/**
 * The prop's outline, and whether it can be the shape it is meant to be.
 *
 * solve() caps the prop's BACK height at the bed but derives its FRONT height
 * from the socket position, and at a steep angle with a thick back stop the two
 * disagree: the socket is pushed out to clear the stop, and a prop rising from
 * there at that angle would have to be taller than the printer. propProfile()
 * draws that as a bevel with a negative run — a ring that crosses itself, which
 * extrude() rightly refuses.
 *
 * There is no repair that keeps the angle: a prop that meets the device's back
 * plane at that socket IS that tall. So the prop is built as the tallest plain
 * blade the bed allows, and validate() says in millimetres how far short of the
 * device it stops rather than shipping a fold.
 */
function propStatus(g) {
  const shortBy = g.propHFront - g.propHBack;
  if (!(shortBy > 1e-9)) {
    return { ok: true, ring: propProfile(g), builtH: g.propHBack, needH: g.propHFront, shortBy: 0 };
  }
  const H = Math.max(4, g.propHBack);
  return {
    ok: false, shortBy, builtH: H, needH: g.propHFront,
    ring: [[0, 0, 0.9], [g.propW, 0, 0.9], [g.propW, H, 1], [0, H, 0.8]],
  };
}

/** The socket that gives exactly the requested angle — where the prop belongs. */
function nominalSocket(g) {
  return g.sockets.find(s => s.k === 0) || g.sockets[0];
}

/**
 * Seat the prop in a socket: its front face against the socket's front wall,
 * its foot on the socket floor. That wall is the datum the angle comes off — the
 * prop's top bevel starts at the same X — so this placement, and no other, is
 * the one that reproduces the number on the dial.
 */
function seatProp(g, prop, socket) {
  return prop.translate(socket.x, 0, g.baseT - g.td);
}

/**
 * Lay the two easel pieces on the plate: both flat, side by side, not touching.
 *
 * The prop is turned onto its widest face (a blade printed on edge is a blade
 * that snaps along a layer line), and then the four ways of standing the pair
 * next to each other are scored against the bed and the best one wins. Scoring
 * rather than choosing means a wide base and a long prop do not have to be
 * anticipated separately.
 */
function plateLayout(g, base, prop) {
  const limX = Math.max(20, g.bed.x - 2 * BED_MARGIN);
  const limY = Math.max(20, g.bed.y - 2 * BED_MARGIN);
  const gap = clamp(g.standW * 0.06, 2, 6);
  const flat = prop.rotateY(Math.PI / 2);            // on its face, bevel upward
  const turned = flat.rotateZ(Math.PI / 2);
  const b0 = base.bbox();
  const options = [
    { m: turned, axis: 'y' }, { m: flat, axis: 'x' },
    { m: flat, axis: 'y' }, { m: turned, axis: 'x' },
  ];
  let best = null;
  for (const o of options) {
    const bp = o.m.bbox();
    const fx = o.axis === 'x' ? b0.size[0] + gap + bp.size[0] : Math.max(b0.size[0], bp.size[0]);
    const fy = o.axis === 'y' ? b0.size[1] + gap + bp.size[1] : Math.max(b0.size[1], bp.size[1]);
    const score = Math.max(fx / limX, fy / limY);
    if (!best || score < best.score - 1e-9) best = { m: o.m, axis: o.axis, bp, score };
  }
  const bp = best.bp;
  const dx = best.axis === 'x' ? b0.max[0] + gap - bp.min[0] : b0.center[0] - (bp.min[0] + bp.max[0]) / 2;
  const dy = best.axis === 'y' ? b0.max[1] + gap - bp.min[1] : b0.center[1] - (bp.min[1] + bp.max[1]) / 2;
  return [
    { name: 'Base', mesh: base },
    { name: 'Prop', mesh: best.m.translate(dx, dy, -bp.min[2]) },
  ];
}

/**
 * Everything the parameters describe, as meshes.
 *
 * `analysis` is always the ASSEMBLED object in design coordinates, whatever the
 * parts are doing on the plate — the question "does it fall over" is about the
 * thing standing on a desk, not about two pieces lying next to each other.
 */
function geometry(g) {
  if (g.style !== 'easel') {
    const body = wedgeSolid(g);
    return { parts: [{ name: 'Stand', mesh: body }], mesh: body, analysis: body };
  }
  const { base, prop } = easelSolids(g);
  const seated = seatProp(g, prop, nominalSocket(g));
  const analysis = Mesh.merge([base, seated]);
  if (g.arrange === 'assembled') {
    // The prop's foot and its front face are exactly coplanar with the socket's,
    // so the two shells have to be resolved into one rather than merged: merged,
    // every edge round the contact patch would be shared by four triangles.
    return {
      parts: [{ name: 'Base', mesh: base }, { name: 'Prop', mesh: seated }],
      mesh: unionAll([base, seated]).healTJunctions(HEAL_EPS),
      analysis,
    };
  }
  const parts = plateLayout(g, base, prop);
  return { parts, mesh: Mesh.merge(parts.map(q => q.mesh)), analysis };
}

/**
 * One 4 mm step of the base, on whichever side the centre of gravity is closest
 * to leaving. Returns false when the bed refuses to give any more, or when the
 * margin is limited by something growing the base cannot fix — a hook on one
 * side pulling the centre of gravity sideways, say.
 */
function growOnce(g, tip) {
  const back = tip.xRear - tip.cog[0], front = tip.cog[0] - tip.xFore;
  const wantBack = back < g.tipMargin && back <= front;
  const wantFront = !wantBack && front < g.tipMargin;
  if (!wantBack && !wantFront) return false;
  const f0 = g.frontLen, b0 = g.backLen;
  g.setFootprint(wantFront ? f0 + 4 : f0, wantBack ? b0 + 4 : b0);
  if (g.frontLen <= f0 + 1e-6 && g.backLen <= b0 + 1e-6) return false;
  g.grewFront += g.frontLen - f0;
  g.grewBack += g.backLen - b0;
  g.ballast = ballastGeom(g);
  g.hookSpec = hookGeom(g);
  g.hookRefused = g.hook !== 'none' && !g.hookSpec;
  g.weightRefused = g.weighted && !g.ballast;
  g.tip2d = tip2d(g);
  return true;
}

/**
 * solve() plus the mesh-accurate answer. The 2D twin sized the foot from an
 * outline; this weighs the actual solid, cuts and all, and gives the base up to
 * three more chances to grow. Both build() and validate() go through here, so
 * the numbers a person is warned about are the numbers that got built.
 */
function realise(p, ctx) {
  const g = solve(p, ctx);
  let geo = geometry(g);
  let tip = tipAnalysis(g, geo.analysis, { ballast: g.ballast });
  if (g.autoBase) {
    for (let i = 0; i < 3 && !tip.stable; i++) {
      if (!growOnce(g, tip)) break;
      geo = geometry(g);
      tip = tipAnalysis(g, geo.analysis, { ballast: g.ballast });
    }
  }
  return { g, geo, tip };
}

/** A printed-mass estimate from the outline alone — for hints(), which has no mesh. */
function estimateGrams(g) {
  const rho = printedDensity(g.infill);
  const ring = (g.style === 'easel' ? easelBaseProfile(g) : wedgeProfile(g)).map(e => [e[0], e[1]]);
  let v = area(ring) * g.standW;
  if (g.style === 'easel') v += area(propStatus(g).ring.map(e => [e[0], e[1]])) * g.standW;
  if (g.ballast) v -= area(g.ballast.gable) * g.ballast.cavW;
  if (g.hookSpec) v += area(g.hookSpec.ring.map(e => [e[0], e[1]])) * g.hookT * (g.hook === 'both' ? 2 : 1);
  return Math.max(0, v) * rho;
}

// ---------------------------------------------------------------------------
// dimension callouts
// ---------------------------------------------------------------------------

/**
 * The measurements the bounding box cannot show, each placed on the feature it
 * measures (see docs/writing-a-generator.md, "Dimension callouts").
 *
 * Every point is a profile point the solid was built from — Q plus multiples of
 * u and n, or a footprint x — moved by the same (dx, dy, dz) the mesh was, and
 * put on the -Y side face, which is the face the default iso view looks at. A
 * figure that solve() changed from what was asked (a trimmed lip, a heel the
 * auto-sizer grew) is written explicitly, so the callout says what was BUILT.
 */
function dimensionCallouts(p, g, [dx, dy, dz]) {
  const W = (x, y, z) => [x + dx, y + dy, z + dz];
  const yS = -g.standW / 2;                                          // the near side face
  const UN = (a, b, y = yS) => W(g.Q[0] + g.u[0] * a + g.n[0] * b, y, g.Q[1] + g.u[1] * a + g.n[1] * b);
  const exact = (built, asked) => (Math.abs(built - asked) < 1e-9 ? {} : { value: r2(built) });
  // A profile-plane direction as a world offset of `mm` millimetres.
  const dir = ([x, y], mm) => { const l = Math.hypot(x, y) || 1; return [x / l * mm, 0, y / l * mm]; };
  const easel = g.style === 'easel';
  const dims = [];

  // ---- the cradle, read across the slot's mouth --------------------------
  dims.push({ param: 'deviceT', label: 'device', from: UN(g.lipH, 0), to: UN(g.lipH, g.deviceT), offset: 6 });
  // A 0.6 mm clearance is too short to draw as a line at any sensible zoom, so
  // the clearance is shown as what it produces: the slot, device plus clearance.
  dims.push({ param: 'slotClear', label: 'slot', from: UN(g.lipH, 0), to: UN(g.lipH, g.S), offset: 12, value: r2(g.S) });
  dims.push({ param: 'lipH', label: 'lip', from: UN(0, g.S), to: UN(g.lipH, g.S), offset: 6,
    ...exact(g.lipH, num(p.lipH, 8)) });
  dims.push({ param: 'lipT', label: 'lip', from: UN(g.lipH, g.S), to: UN(g.lipH, g.S + g.lipT), offset: 6 });

  // ---- the rest: the wedge's back wall, or the easel's low back stop ------
  if (!easel) {
    // Pushed out along n, clear of the lip, so the line sits in the air in front
    // of the device plane rather than across the cradle; the thickness goes up
    // along u, above the ridge.
    dims.push({ param: 'restH', label: 'rest', from: UN(0, 0), to: UN(g.restH, 0), offset: dir(g.n, g.S + g.lipT + 6),
      ...exact(g.restH, num(p.restH, 45)) });
    dims.push({ param: 'restT', label: 'rest', from: UN(g.restH, 0), to: UN(g.restH, -g.restT), offset: dir(g.u, 8),
      ...exact(g.restT, num(p.restT, 5)) });
  } else {
    dims.push({ param: 'restT', label: 'stop', from: UN(g.stopH, 0), to: UN(g.stopH, -g.stopT), offset: dir(g.u, 8),
      ...exact(g.stopT, num(p.restT, 5)) });
    // Where the prop meets the device's back plane — only a place when it is there.
    if (g.arrange === 'assembled') {
      const reach = g.x0 / Math.cos(g.A);
      dims.push({ param: 'restH', label: 'prop reach', from: UN(0, 0), to: UN(reach, 0), offset: dir(g.n, g.S + g.lipT + 6),
        ...exact(reach, num(p.restH, 45)) });
    }
    // A quarter of a millimetre of clearance cannot be drawn as a line; the
    // socket it widens can, so the callout is the socket: prop plus fit.
    const s = nominalSocket(g);
    dims.push({ param: 'fit', label: 'socket', from: W(s.x, yS, g.baseT), to: W(s.x + g.propW + g.fit, yS, g.baseT),
      offset: 8, value: r2(g.propW + g.fit) });
  }

  // ---- the base --------------------------------------------------------------
  dims.push({ param: 'baseT', label: 'base', from: W(g.xFront, yS, 0), to: W(g.xFront, yS, g.baseT), offset: 6 });
  dims.push({ param: 'frontLen', label: 'toe', from: W(g.xFront, yS, g.baseT), to: W(g.xLipBase, yS, g.baseT), offset: 8,
    ...exact(g.frontLen, num(p.frontLen, 14)) });
  if (!easel) {
    // The heel: from the back of the rest to the back edge, along the plate.
    dims.push({ param: 'backLen', label: 'heel', from: W(g.RtopBack[0], yS, 0), to: W(g.xBack, yS, 0), offset: 8,
      ...exact(g.xBack - g.RtopBack[0], num(p.backLen, 30)) });
    // The top corner of the rest is a right angle by construction (n is
    // perpendicular to u), so filletPoly's clamp there is simply half the
    // shorter edge. R is measured from the arc's centre, which is empty space.
    const rr = Math.min(g.cornerR, Math.min(g.restT, g.restH) / 2);
    if (rr > 1e-5) {
      const bx = (g.u[0] + g.n[0]) / Math.SQRT2, by = (g.u[1] + g.n[1]) / Math.SQRT2;
      const cx = g.Rtop[0] - bx * rr * Math.SQRT2, cy = g.Rtop[1] - by * rr * Math.SQRT2;
      // Offset up-and-back (u - n): above the back slope, where nothing is.
      dims.push({ param: 'cornerR', label: 'R', from: W(cx, yS, cy), to: W(cx + bx * rr, yS, cy + by * rr),
        offset: dir([g.u[0] - g.n[0], g.u[1] - g.n[1]], 5), ...exact(rr, g.cornerR) });
    }
  } else {
    const rear = Math.max(...g.sockets.map(s => s.x + g.propW + g.fit));
    dims.push({ param: 'backLen', label: 'heel', from: W(rear, yS, g.baseT), to: W(g.xBack, yS, g.baseT), offset: 8,
      ...exact(g.xBack - rear, num(p.backLen, 30)) });
    // The base's back-top corner: a right angle, radius min(r, 0.6·baseT) before
    // the half-edge clamp, so min(r, baseT / 2) after it.
    const rr = Math.min(g.cornerR, g.baseT * 0.6, g.baseT / 2);
    if (rr > 1e-5) {
      const cx = g.xBack - rr, cy = g.baseT - rr, k = rr / Math.SQRT2;
      dims.push({ param: 'cornerR', label: 'R', from: W(cx, yS, cy), to: W(cx + k, yS, cy + k), offset: 5,
        ...exact(rr, g.cornerR) });
    }
  }
  // The width the coverage fraction bought, across the back edge on the plate.
  dims.push({ param: 'coverage', label: 'stand', from: W(g.xBack, -g.standW / 2, 0), to: W(g.xBack, g.standW / 2, 0),
    offset: 8, value: r2(g.standW), unit: 'mm' });

  // ---- the cable route ------------------------------------------------------
  if (g.cable) {
    // Read where the groove leaves the underside at the back edge, or — when the
    // easel's base had no room for a groove under its sockets — across the notch
    // in the top of the lip.
    const back = !g.grooveShort;
    const x = back ? g.xBack : g.LtopOut[0], z = back ? 0 : g.LtopOut[1];
    dims.push({ param: 'cableW', label: 'channel', from: W(x, g.port - g.cableW / 2, z), to: W(x, g.port + g.cableW / 2, z),
      offset: 8, ...exact(g.cableW, num(p.cableW, 12)) });
    if (Math.abs(g.port) > 1e-6) {
      dims.push({ param: 'portOffset', label: 'port', from: W(x, 0, z), to: W(x, g.port, z), offset: 14, value: r2(g.port) });
    }
  }

  // ---- the hook -------------------------------------------------------------
  const hk = g.hookSpec;
  if (hk) {
    const side = g.hook === 'right' ? 1 : -1;                        // 'both': the near fin
    const yIn = side * g.standW / 2, yOut = side * (g.standW / 2 + g.hookT);
    dims.push({ param: 'hookT', label: 'saddle', from: W(hk.xTip - hk.upT / 2, yIn, hk.yTop + hk.upH),
      to: W(hk.xTip - hk.upT / 2, yOut, hk.yTop + hk.upH), offset: 6 });
    dims.push({ param: 'hookLen', label: 'reach', from: W(g.xBack, yOut, hk.yTop), to: W(hk.xTip, yOut, hk.yTop),
      offset: 8, ...exact(hk.len, g.hookLen) });
  }

  // ---- the ballast void's wall, at the chimney, out to the near side face ----
  const bal = g.ballast;
  if (bal) {
    const wall = g.standW / 2 - bal.cavW / 2;                         // max(wallT, MIN_SIDE) = wallT
    dims.push({ param: 'wallT', label: 'wall', from: W(bal.xm, -bal.cavW / 2, bal.yEave), to: W(bal.xm, -g.standW / 2, bal.yEave),
      offset: 6, ...exact(wall, g.wallT) });
  }
  return dims;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const { g, geo, tip } = realise(p, ctx);

  // ONE transform, from the assembled bounding box, applied to the whole set.
  // Dropping each part onto the plate on its own is how two halves end up
  // disagreeing about where the floor is.
  const b = geo.mesh.bbox();
  const dx = -(b.min[0] + b.max[0]) / 2;
  const dy = -(b.min[1] + b.max[1]) / 2;
  const dz = -b.min[2];
  const mesh = geo.mesh.translate(dx, dy, dz);
  const parts = geo.parts.map(q => ({ name: q.name, mesh: q.mesh.translate(dx, dy, dz) }));
  const bb = mesh.bbox();

  const bal = g.ballast;
  const meta = {
    style: g.style,
    dims: dimensionCallouts(p, g, [dx, dy, dz]),
    // Exact by construction rather than by measurement: every cradle point is
    // Q plus a multiple of u and n, so the built angle IS the asked-for angle.
    angleDeg: r1(g.angleDeg),
    angles: g.style === 'easel' ? g.angles.map(r1) : [r1(g.angleDeg)],
    slot: {
      widthMm: r2(g.S),
      deviceMm: r2(g.deviceT),
      clearanceMm: r2(g.slotClear),
      lipMm: r1(g.lipH),
      bezelLeftMm: g.screenInset > 0 ? r1(g.screenInset - g.lipMargin - g.lipH) : null,
    },
    footprint: {
      depthMm: r1(bb.size[0]),
      widthMm: r1(bb.size[1]),
      heightMm: r1(bb.size[2]),
      standWidthMm: r1(g.standW),
      grewMm: r1(g.grewBack + g.grewFront),
    },
    tip: {
      marginMm: r1(tip.margin),
      askedMm: r1(g.tipMargin),
      stable: !!tip.stable,
      standG: r1(tip.standMass),
      ballastG: r1(tip.ballastMass),
      deviceG: r1(tip.deviceMass),
      totalG: r1(tip.total),
      // The push at the top of the screen that takes it over backwards.
      pressN: r2(tip.pressN),
      pressAtMm: r1(tip.pressZ),
      cogMm: [r1(tip.cog[0]), r1(tip.cog[1]), r1(tip.cog[2])],
    },
    ballast: bal ? { millilitres: r1(bal.volume / 1000), gramsAtFill: r1(bal.volume * g.fillDensity / 1000) } : null,
    hook: g.hookSpec ? { side: g.hook, reachMm: r1(g.hookSpec.len), saddleMm: r1(g.hookT) } : null,
    cable: g.cable ? { widthMm: r1(g.cableW), offsetMm: r1(g.port) } : null,
    parts: parts.length,
    triangles: mesh.triCount,
  };

  if (typeof ctx.progress === 'function') ctx.progress(1);
  return { mesh, parts, meta };
}

// ---------------------------------------------------------------------------
// validate — everything solve() had to do quietly, said out loud
// ---------------------------------------------------------------------------

function validate(p = {}, ctx = {}) {
  const out = [];
  const err = (param, message) => out.push({ param, message, severity: 'error' });
  const warn = (param, message) => out.push({ param, message, severity: 'warn' });

  let g, tip = null;
  try {
    const r = realise(p, ctx);
    g = r.g; tip = r.tip;
  } catch (e) {
    try { g = solve(p, ctx); } catch (e2) { return [{ param: 'angle', message: `the geometry could not be solved: ${e2.message}`, severity: 'error' }]; }
    err('angle', `the solid could not be built from these numbers: ${e.message}`);
  }

  const lipRoom = g.screenInset - g.lipMargin;
  const asked = (k, d) => num(p[k], d);

  // ---- the lip against the bezel ------------------------------------------
  // A bezel of exactly zero is the signal that whatever is being cradled has no
  // screen at all — a pair of headphones, a book — so the screen warnings are
  // noise there and are skipped rather than repeated eight times.
  if (g.screenInset > 0) {
    if (g.lipCoversScreen) {
      warn('lipH', `the lip has to be ${g.lipH.toFixed(1)} mm to retain a ${g.S.toFixed(1)} mm slot ` +
        `(35 % of the slot depth, or 3 mm, whichever is larger) but the ${g.screenInset} mm bezel less the ` +
        `${g.lipMargin} mm you asked to keep clear leaves only ${lipRoom.toFixed(1)} mm — it will stand over the ` +
        `picture by ${(g.lipH - lipRoom).toFixed(1)} mm.` +
        (g.lipMargin > 0 ? ` Dropping "keep clear of the glass" to 0 recovers ${g.lipMargin} mm of that.` : '') +
        (g.screenInset < 4
          ? ' On a modern phone that is exactly where the always-on clock lives; bear it on its back and its toe instead and keep the lip under 2 mm.'
          : ' A slot cut to the widest part of a device that is not a slab is the wrong shape anyway — a Steam Deck is 50 mm at the grips and half that across the screen, and it wants a relieved centre, which is more cradle than this generator can cut.'));
    } else if (g.lipTrimmed) {
      warn('lipH', `the lip was cut from the ${asked('lipH', 8)} mm you asked for to ${g.lipH.toFixed(1)} mm: ` +
        `a ${g.screenInset} mm bezel less ${g.lipMargin} mm of clearance leaves ${lipRoom.toFixed(1)} mm before it ` +
        'reaches the glass.');
    }
    if (!g.lipCoversScreen && lipRoom - g.lipH > 6 && g.lipH < g.S * 0.6) {
      warn('lipH', `there is ${(lipRoom - g.lipH).toFixed(1)} mm of bezel left above the lip. An e-reader or a base ` +
        'iPad has a generous border and is the one case where a tall, positively retaining lip is free — you are ' +
        'leaving most of it unused.');
    }
  }
  if (g.lipT < 1.6) {
    warn('lipT', `a ${g.lipT.toFixed(1)} mm lip is under four extrusions at a 0.4 mm nozzle. It is a fin, not a lip, ` +
      'and it will break the first time the device is dropped into the cradle rather than lowered.');
  }

  // ---- the slot -----------------------------------------------------------
  if (g.slotClear < 0.3) {
    warn('slotClear', `${g.slotClear.toFixed(2)} mm of clearance on a ${g.deviceT} mm device will bind: the printed ` +
      'surface finish alone is worth 0.1-0.2 mm, and a slot that is a press fit cold is a slot that scratches a case.');
  } else if (g.slotClear > 2.5) {
    warn('slotClear', `${g.slotClear.toFixed(1)} mm of clearance leaves the device free to rock ` +
      `${(Math.atan2(g.slotClear, Math.max(1, g.lipH)) * R2D).toFixed(0)}° in the slot before the lip catches it.`);
  }
  if (g.standW < g.deviceW * 0.3) {
    warn('coverage', `the stand is ${g.standW.toFixed(0)} mm across against a ${g.deviceW} mm device — under a third. ` +
      'That is fine for a rigid slab and wrong for a tablet in a soft folio, which will bow over the ends.');
  }

  // ---- features that could not be built -----------------------------------
  if (g.hookRefused) {
    warn('hook', `no hook was built: the back slope only runs ${(g.xBack - g.RtopBack[0]).toFixed(0)} mm from the top ` +
      `of the rest to the back edge and rises ${g.RtopBack[1].toFixed(0)} mm, which is not enough solid wedge to root ` +
      'a fin in without it starting in mid-air. A taller rest or a longer heel gives it something to hang off.');
  } else if (g.hookSpec && g.hookSpec.len < g.hookLen - 0.05) {
    warn('hookLen', `the peg was shortened from ${g.hookLen} mm to ${g.hookSpec.len.toFixed(0)} mm so its 45° gusset ` +
      'could reach solid material before it ran out of wedge to bite into. Raise the rest or lengthen the heel to get ' +
      'the reach back.');
  }
  if (g.hookSpec && tip) {
    const lever = g.hookSpec.xTip - tip.xRear;
    if (lever > 0.5) {
      const hangable = tip.total * (tip.xRear - tip.cog[0]) / lever;
      warn('hook', `the tipping check models the ${g.deviceMass} g in the CRADLE, not on the peg. What actually hangs ` +
        `there acts ${lever.toFixed(0)} mm behind the back edge of the foot, and on these numbers anything over about ` +
        `${Math.max(0, hangable).toFixed(0)} g on the peg takes the stand over backwards.`);
    }
  }
  if (g.weightRefused) {
    const cav = g.standW - 2 * Math.max(g.wallT, MIN_SIDE);
    if (cav < 8) {
      warn('weighted', `no ballast cavity: ${g.wallT} mm walls in a ${g.standW.toFixed(0)} mm wide stand leave ` +
        `${cav.toFixed(1)} mm of void, and under 8 mm there is nothing worth filling. Widen the stand or thin the walls.`);
    } else {
      warn('weighted', `no ballast cavity: the rear of the wedge is ${(g.xBack - g.RtopBack[0]).toFixed(0)} mm long and ` +
        `${g.RtopBack[1].toFixed(0)} mm tall at its highest, and a gabled void with ${g.wallT} mm walls and a 45° roof ` +
        'does not fit inside that triangle. A longer heel is the fix; thinner walls buy very little.');
    }
  }
  if (g.style === 'easel') {
    const ps = propStatus(g);
    if (!ps.ok) {
      err('angle', `the prop cannot reach the device. At ${g.angleDeg}° the socket has to sit ${g.x0.toFixed(0)} mm ` +
        `behind the cradle to clear a ${g.stopT.toFixed(1)} mm back stop, and a prop rising from there to the ` +
        `device's back plane would have to be ${ps.needH.toFixed(0)} mm tall — the bed allows ${ps.builtH.toFixed(0)} mm. ` +
        `It was built as a plain ${ps.builtH.toFixed(0)} mm blade, which stops ${ps.shortBy.toFixed(0)} mm short and ` +
        'holds nothing up. A wedge takes this angle without difficulty; on the easel, a thinner back rest or a ' +
        'shallower angle brings the prop back inside the bed.');
    }
    if (g.stepsDropped > 0) {
      const xMin = g.stopH * Math.cos(g.A) + g.stopT / Math.max(0.05, Math.sin(g.A)) + 1.5;
      warn('angleSteps', `only ${g.sockets.length} of the ${asked('angleSteps', 3)} angle steps could be cut: the prop ` +
        `has to start at least ${xMin.toFixed(0)} mm behind the cradle to clear the back stop, and the steeper settings ` +
        `land inside it. A taller back rest pushes the whole socket row further out (the prop is ${g.propHFront.toFixed(0)} mm ` +
        'tall here, and every extra millimetre of that moves the steep end outward).');
    }
    if (g.spreadWidened) {
      warn('angleSpread', `the steps were opened from ${asked('angleSpread', 10)}° to ${g.spread.toFixed(1)}°: any closer ` +
        `and two sockets would be under ${(g.propW + g.fit + 1.6).toFixed(1)} mm apart, which is less than the prop ` +
        `is thick (${g.propW.toFixed(1)} mm) plus the wall between them.`);
    }
    if (g.fit < 0.15) {
      warn('fit', `${g.fit.toFixed(2)} mm of socket clearance is below what an FDM part holds: the prop will not drop in. ` +
        '0.2 mm is a well-tuned printer, 0.3 mm is everyone else.');
    } else if (g.fit > 0.6) {
      warn('fit', `${g.fit.toFixed(2)} mm of slop lets the prop lean ` +
        `${(Math.atan2(g.fit, g.propHFront) * R2D).toFixed(1)}° in its socket before it bears — the angle you set is ` +
        'the angle it starts from, not the angle it keeps.');
    }
    if (g.arrange === 'assembled') {
      warn('arrange', 'the assembled view is a picture, not a print: the prop is standing in its socket, ' +
        'which means it is a 90° overhang held up by nothing. Switch to "Flat on the plate" before you export.');
    }
  }
  if (p.cable !== false && !g.cable) {
    warn('cableW', `no cable route: a ${asked('cableW', 12)} mm channel needs ${MIN_SIDE} mm of material either side, ` +
      `and the stand is only ${g.standW.toFixed(0)} mm wide. Widen it or narrow the channel.`);
  }
  if (g.portClamped) {
    warn('portOffset', `the port channel was moved from ${g.portAsked} mm to ${g.port.toFixed(1)} mm off centre: a ` +
      `${g.cableW.toFixed(0)} mm channel with ${MIN_SIDE} mm either side cannot get past ` +
      `${(g.standW / 2 - g.cableW / 2 - MIN_SIDE).toFixed(1)} mm on a ${g.standW.toFixed(0)} mm stand. A device lying ` +
      'on its long edge has its socket further out than that — widen the stand until the channel reaches it.');
  }
  if (g.cable && g.plugRoom < 8) {
    warn('baseT', `there is only ${g.plugRoom.toFixed(1)} mm of clear height under the device's socket, measured up the ` +
      'slot floor. A USB-C plug with a case-thickened strain relief wants 8-10 mm before it fouls the base.');
  }

  // ---- print sanity -------------------------------------------------------
  if (g.baseT < 3) {
    warn('baseT', `a ${g.baseT.toFixed(1)} mm base is thin enough to curl off the plate as it cools, and the cable ` +
      `groove already takes ${g.grooveH.toFixed(1)} mm out of the underside of it.`);
  }
  if (g.restT < 2.4) {
    warn('restT', `${g.restT.toFixed(1)} mm of back rest is six extrusions or fewer, and the rest is loaded in bending ` +
      'at its root — that is the one place on this part where thickness beats every other setting you have.');
  }

  // ---- the bed ------------------------------------------------------------
  try {
    const r = build(p, ctx);
    const s = r.mesh.bbox().size;
    const bed = g.bed;
    if (s[0] > bed.x || s[1] > bed.y || s[2] > bed.z) {
      err('backLen', `${s.map(v => v.toFixed(0)).join(' × ')} mm will not fit the ${bed.x} × ${bed.y} × ${bed.z} mm bed. ` +
        'The base is the part that grew; shorten the heel, the toe, or the rest.');
    }
  } catch { /* the build failure is already reported above */ }

  // ---- the one that matters ----------------------------------------------
  if (tip) {
    const back = tip.xRear - tip.cog[0], front = tip.cog[0] - tip.xFore;
    const worst = back <= front ? 'backwards' : 'forwards';
    const room = g.bed.x - 2 * BED_MARGIN - g.depth;
    if (tip.margin <= 0) {
      err('tipMargin', `it falls over: with the ${g.deviceMass} g device in it the combined centre of gravity is ` +
        `${(-tip.margin).toFixed(1)} mm OUTSIDE the feet, ${worst}. Total mass ${tip.total.toFixed(0)} g, centre of ` +
        `gravity at x = ${tip.cog[0].toFixed(1)} mm against a foot running ${tip.xFore.toFixed(1)} to ` +
        `${tip.xRear.toFixed(1)} mm.` + (room > 4 ? ` There are ${room.toFixed(0)} mm of bed left to grow into.` : ' The bed has nothing left to give.'));
    } else if (tip.margin < g.tipMargin - 0.05) {
      const sev = tip.margin < 2 ? err : warn;
      sev('tipMargin', `the base is ${(g.tipMargin - tip.margin).toFixed(1)} mm short of the ${g.tipMargin} mm margin ` +
        `you asked for — it has ${tip.margin.toFixed(1)} mm of it, ${worst}, and a ${tip.pressN.toFixed(1)} N push at ` +
        `the top of the screen (${tip.pressZ.toFixed(0)} mm up) takes it over.` +
        (g.autoBase
          ? (room > 4
            ? ` The auto-sizer added ${(g.grewBack + g.grewFront).toFixed(0)} mm and stopped because growing further ` +
              'stopped helping — a shallower angle or a lighter device is the real answer.'
            : ` The auto-sizer added ${(g.grewBack + g.grewFront).toFixed(0)} mm and ran out of bed at ` +
              `${g.depth.toFixed(0)} mm deep.`)
          : ' Turn the auto-sizer on, or lengthen the heel by hand.') +
        (g.style === 'wedge' && !g.weighted ? ' A filled ballast cavity adds mass low down, which helps a light stand under a heavy device — but measure it before relying on it: on these presets it changed the tipping force by under 5 %, and on one it made the margin worse by moving mass rearward.' : ''));
    } else if (tip.pressN < 1.2) {
      warn('tipMargin', `it stands up on its own with ${tip.margin.toFixed(0)} mm to spare, but it takes only ` +
        `${tip.pressN.toFixed(1)} N — about ${(tip.pressN * 102).toFixed(0)} g of push — at the top of the screen ` +
        `${tip.pressZ.toFixed(0)} mm up to tip it over backwards, and a firm tap on a touchscreen is that much. ` +
        'A longer heel moves the pivot back, which is the change that works. Ballast is a much weaker lever than it sounds: measured across the shipped presets it moved the tipping force by under 5 %.');
    }
    if (g.style === 'wedge' && g.weighted && g.ballast) {
      const bm = g.ballast.volume * g.fillDensity / 1000;
      if (bm < 15) {
        warn('weighted', `the cavity holds ${(g.ballast.volume / 1000).toFixed(1)} ml — about ${bm.toFixed(0)} g at ` +
          `${g.fillDensity} g/cm³. That is under 3 % of the ${tip.total.toFixed(0)} g total and will not be felt. ` +
          'A longer heel makes the cavity, and a denser fill makes it count.');
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// hints — how to actually print it
// ---------------------------------------------------------------------------

function hints(p = {}, ctx = {}) {
  const g = solve(p, ctx);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const ew = clamp(num(ctx.nozzle, 0.4), 0.2, 1.2);
  const walls = g.restT >= 3.2 ? 5 : 4;
  const notes = [];
  const grams = estimateGrams(g);

  if (g.style === 'wedge') {
    notes.push('Orientation: exactly as it comes out of Bluesheet. The wedge sits on its own base, so the first layer is ' +
      `the whole footprint — roughly ${(g.depth * g.standW / 100).toFixed(0)} cm² of bed contact. No brim, no raft, ` +
      'and nothing to hold down.');
  } else {
    notes.push('Orientation: two parts, both already lying on their largest face. Print them together; the prop is the ' +
      'small one. Do NOT stand the prop up to print it — on edge, the layer lines run straight across the load and it ' +
      'snaps at the bevel the first time it takes the device\'s weight.');
    notes.push(`Socket fit: the sockets are cut ${(g.propW + g.fit).toFixed(2)} mm wide for a ${g.propW.toFixed(2)} mm ` +
      `prop — ${g.fit.toFixed(2)} mm of clearance. If it will not drop in, reprint with more clearance rather than ` +
      'sanding the prop: the angle comes off the socket\'s FRONT wall and the prop\'s front face, and those are the two ' +
      'surfaces sanding would move.');
  }

  notes.push('Supports: none, anywhere. The body is a side profile swept sideways, so every wall is either vertical or ' +
    'set back as it rises, and the slot is a notch open to the sky rather than a pocket.' +
    (g.cable
      ? ` The only down-facing surface on the part is the roof of the cable groove — a ${g.cableW.toFixed(0)} mm flat ` +
        `bridge ${g.grooveH.toFixed(1)} mm above the plate. That bridges cleanly on any printer with the part fan on; ` +
        'turn it off for the first layer only.'
      : ''));

  notes.push(`Walls ${walls} at ${ew.toFixed(2)} mm, infill ${Math.max(12, Math.min(25, g.infill))} % gyroid. This is ` +
    'the wall count that matters and the infill that does not: the back rest is a cantilever loaded in bending, and in ' +
    'bending the material furthest from the neutral axis carries almost all of it — which in a printed part is the ' +
    `perimeters. ${walls} walls at 15 % is stiffer, lighter and faster than two walls at 40 %.`);

  notes.push(`Layer height ${layerH.toFixed(2)} mm, and 0.24-0.28 is better here than 0.12: nothing on this part is ` +
    'cosmetic enough to want fine layers, and a thicker layer means fewer inter-layer bonds through the one load path ' +
    'that matters.');

  if (g.ballast) {
    const ml = g.ballast.volume / 1000;
    notes.push(`Ballast: the cavity holds about ${ml.toFixed(1)} ml — ${(ml * g.fillDensity).toFixed(0)} g at the ` +
      `${g.fillDensity} g/cm³ you set. The chimney out of the back slope is the fill port; it is ` +
      `${g.ballast.chW.toFixed(0)} mm across, so a funnel or a folded strip of paper gets the fill in. Plug it with a ` +
      'printed cap, a cork, or a blob of hot glue once it is full.');
    notes.push('Fill it with DRY sand or steel shot, not water. An FDM part is watertight only by accident, PLA softens ' +
      'and creeps once it is damp, and a leak inside a stand appears on the desk under a device. Kiln-dried play sand ' +
      'is about 1.6 g/cm³, steel shot 4.5, lead shot 6.7. Pour it in dry, tap it down, then seal.');
    notes.push('The void is a gable with a 45° roof — that is the whole reason it needs no support, and it is why the ' +
      'ridge is where it is. If you edit the cavity, keep the roof at 45° or you will be picking support out of a ' +
      'sealed pocket you cannot reach.');
  }
  if (g.hookSpec) {
    notes.push(`The hook fin is unioned to the side of the wedge and reaches the plate, so it prints with the rest and ` +
      `nothing in it starts in mid-air. The peg's underside is a 45° gusset back into the slope — support-free, and it ` +
      `is also the part carrying the load. The saddle is ${g.hookT.toFixed(0)} mm wide: broad on purpose, because a ` +
      'narrow hook presses a permanent groove into a headband over a few months.');
  }

  notes.push(`PLA is right for this and stiffer than PETG. The exception is heat and time together: a stand holds a ` +
    'steady load all day, and PLA creeps under a steady load somewhere around 50 °C, so a car dashboard or a sunny ' +
    'windowsill wants PETG (or ASA) even though it is the softer material.');

  if (g.deviceMass > 500) {
    notes.push(`At ${g.deviceMass} g the device weighs ${(g.deviceMass / Math.max(1, grams)).toFixed(1)}× what the ` +
      'stand does. Stick self-adhesive cork or rubber under the toe and the heel: friction against the desk stops the ' +
      'cable dragging the whole thing about, which is the failure people actually get, and it is worth more than any ' +
      'amount of extra plastic.');
  }

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.26 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: 'PLA',
    supports: false,
    layerH,
    walls,
    infill: Math.max(12, Math.min(25, g.infill)),
    orientation: g.style === 'easel' ? 'both parts flat on the plate, as generated' : 'on its base, as generated',
    parts: g.style === 'easel' ? 2 : 1,
    estGrams: Math.round(grams * 10) / 10,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default {
  id: 'stand',
  name: 'Stands & Docks',
  category: 'Utility',
  blurb: 'A wedge or a two-piece easel that holds a device at the angle you ask for, and is weighed to prove it will not tip.',
  description:
    'A stand is trivial to describe and easy to get wrong in ways that only show up when half a kilo of tablet is leaning on it. Three things have to be ' +
    'true at once and all three are computed rather than eyeballed: the slot is the device thickness WITH its case plus a stated clearance, measured ' +
    'perpendicular to the device rather than horizontally; the face it leans on is at the angle you asked for, exactly, because every cradle dimension ' +
    'comes off the same two unit vectors; and the finished solid, plus the device modelled where the device actually sits, has its combined centre of ' +
    'gravity inside the feet by a margin you set — the base grows backwards on its own until that is true, or tells you how far short it fell. The body ' +
    'is one swept side profile, so it is watertight without a boolean; only the cable route, the ballast void and the headphone hook need cutting.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20v-3h13l3 3"/><path d="M7.5 17 16 4.5l3.2 2.2-6.4 9.4"/></svg>',
  version: 1,

  params: [
    // ---- Device -----------------------------------------------------------
    { key: 'deviceT', label: 'Thickness, with its case', type: 'number', unit: 'mm', min: 3, max: 60, step: 0.5, def: 9, group: 'Device',
      help: 'Measured over the case, not the bare device — this is the number people get wrong. A bare iPad Pro is 5.1 mm, the same one in a Smart Folio about 9.5, in a rugged folio 14.7. Measure the thing you will actually drop in.' },
    { key: 'deviceW', label: 'Width across the desk', type: 'number', unit: 'mm', min: 20, max: 400, step: 1, def: 179, group: 'Device',
      help: 'The dimension running left to right when it is in the stand. It sizes the stand itself and nothing else — the stand is deliberately a fraction of it, because a cradle as wide as a tablet is mostly wasted plastic.' },
    { key: 'deviceH', label: 'Height up the face', type: 'number', unit: 'mm', min: 30, max: 500, step: 1, def: 248, group: 'Device',
      help: 'The dimension running up the slope. It decides how high the load sits, which is most of what decides tipping: the same mass twice as high takes half the push to knock over.' },
    { key: 'deviceMass', label: 'Mass, with its case', type: 'number', unit: 'g', min: 5, max: 8000, step: 5, def: 500, group: 'Device',
      help: 'Kitchen scales, with the case on. Every gram is modelled at the centre of the device and the whole base-sizing search is driven by it — a folio adds 200-290 g to a tablet, which is enough to change the answer.' },
    { key: 'screenInset', label: 'Bezel on the bottom edge', type: 'number', unit: 'mm', min: 0, max: 60, step: 0.1, def: 9, group: 'Device',
      help: 'The border between the edge of the device and the start of the picture, on the edge that sits in the cradle. It is the hard ceiling on the lip. Derive it from the active area if it is not published: a 16 Pro Max has 2.3 mm, a base iPad 10.8, a Paperwhite 17. Set it to 0 for anything that is not a screen.' },

    // ---- Angle ------------------------------------------------------------
    { key: 'style', label: 'Style', type: 'enum', def: 'wedge', group: 'Angle',
      help: 'One angle in one piece, or a row of angles in two.',
      options: [
        { v: 'wedge', label: 'Wedge (one piece)', help: 'A single solid at one fixed angle. Stiffer, heavier, prints in one go, and the only style that can carry a headphone hook or a ballast cavity.' },
        { v: 'easel', label: 'Easel (base + prop)', help: 'A base with a row of sockets and a prop that drops into whichever one you want. Each socket is positioned FROM the angle it is meant to give, so they are exact rather than approximately spaced.' },
      ] },
    { key: 'angle', label: 'Viewing angle', type: 'number', unit: '°', min: 10, max: 88, step: 1, def: 62, group: 'Angle',
      help: 'Measured from the desk: 90° is bolt upright. 18° is a drafting slope you can draw on; past about 30° the hand slides and the wrist bends back. 45° suits a screen read standing over a worktop. 65-70° is a face seen from a chair or a pillow.' },
    { key: 'angleSteps', label: 'Angle steps', type: 'int', min: 1, max: 6, step: 1, def: 3, group: 'Angle',
      showIf: (p) => p.style === 'easel',
      help: 'How many sockets to cut. They are laid out symmetrically about the angle above, so an odd number keeps that angle in the middle of the row.' },
    { key: 'angleSpread', label: 'Degrees per step', type: 'number', unit: '°', min: 1, max: 30, step: 0.5, def: 10, group: 'Angle',
      showIf: (p) => p.style === 'easel',
      help: 'How far apart the settings are. Sockets closer together than the prop is thick cannot be cut, so the spread is opened until they fit and validate() says by how much — a steep setting moves the socket INWARD, which is what runs it into the back stop.' },

    // ---- Cradle -----------------------------------------------------------
    { key: 'slotClear', label: 'Slot clearance', type: 'number', unit: 'mm', min: 0, max: 5, step: 0.1, def: 0.6, group: 'Cradle',
      help: 'Added to the thickness, measured PERPENDICULAR to the device — which is the direction that matters and not the one a ruler on the desk gives you. 0.6 mm is a soft drop-in fit; under 0.3 the printed surface finish alone binds.' },
    { key: 'coverage', label: 'Width, as a fraction of the device', type: 'number', min: 0.05, max: 1, step: 0.05, def: 0.5, group: 'Cradle',
      help: 'How wide the stand is compared to the device. Half is plenty for a rigid slab; go wider for a heavy tablet in a soft folio, which will bow over the ends of a narrow cradle, and narrower if you want at the side buttons.' },
    { key: 'restH', label: 'Back rest height', type: 'number', unit: 'mm', min: 4, max: 200, step: 1, def: 45, group: 'Cradle',
      help: 'How far up the back of the device the rest reaches. A third of the device height is usually enough — the rest is there to stop it sliding, not to hold it up. Keep it low if the back has a camera bump, a vent, or a wireless charging coil.' },
    { key: 'restT', label: 'Back rest thickness', type: 'number', unit: 'mm', min: 1.2, max: 30, step: 0.2, def: 5, group: 'Cradle',
      help: 'The wall the device leans against. It is a cantilever loaded in bending at its root, which makes this the one dimension on the part where thickness beats every slicer setting you have.' },
    { key: 'lipH', label: 'Lip height', type: 'number', unit: 'mm', min: 1, max: 60, step: 0.5, def: 8, group: 'Cradle',
      help: 'How far the front lip stands up the face of the device. It is trimmed to whatever the bezel allows, and never below the greater of 3 mm and a third of the slot depth — below that it stops retaining anything and is only decoration.' },
    { key: 'lipT', label: 'Lip thickness', type: 'number', unit: 'mm', min: 1, max: 12, step: 0.2, def: 2.8, group: 'Cradle',
      help: 'How thick the lip is, and therefore how far forward the cradle sits: the lip\'s outer face meets the base at (slot + lip) ÷ sin(angle), so a shallow angle pushes the whole cradle a long way forward.' },
    { key: 'lipMargin', label: 'Keep clear of the glass', type: 'number', unit: 'mm', min: 0, max: 25, step: 0.5, def: 2, group: 'Cradle',
      help: 'Bezel left between the top of the lip and the start of the picture. On a curved-edge phone a lip that merely touches the glass sets off phantom touches, so this is worth more than the millimetre it costs.' },
    { key: 'fit', label: 'Socket clearance', type: 'number', unit: 'mm', min: 0, max: 1.2, step: 0.05, def: FIT.push, group: 'Cradle',
      showIf: (p) => p.style === 'easel',
      help: 'Added to the socket width so the prop drops in. 0.2 mm suits a well-tuned printer, 0.3 mm everyone else. It is also slop: the prop can lean by this much before it bears, so more is not free.' },

    // ---- Base -------------------------------------------------------------
    { key: 'baseT', label: 'Base thickness', type: 'number', unit: 'mm', min: 1.6, max: 40, step: 0.2, def: 6, group: 'Base',
      help: 'The slab under the cradle. It has to be thicker than the cable groove cut into its underside, and it is what stops a long thin toe curling off the plate as the print cools.' },
    { key: 'frontLen', label: 'Toe length', type: 'number', unit: 'mm', min: 0, max: 120, step: 1, def: 14, group: 'Base',
      help: 'How far the base runs forward of the lip. This is what stops the stand nosing over when you prod the top of the screen, and it is the cheapest stability there is: flat, low, and almost no plastic.' },
    { key: 'backLen', label: 'Heel length', type: 'number', unit: 'mm', min: 0, max: 160, step: 1, def: 30, group: 'Base',
      help: 'How far the base runs back past the rest. This is the number the auto-sizer grows when the thing would tip, so setting it by hand only means much with the auto-sizer off.' },
    { key: 'tipMargin', label: 'Tipping margin', type: 'number', unit: 'mm', min: 0.5, max: 50, step: 0.5, def: 8, group: 'Base',
      help: 'How far inside the feet the combined centre of gravity must stay. 8 mm survives a desk being knocked; 2 mm is technically stable and falls over in real life. It is a distance on the desk, not a safety factor.' },
    { key: 'autoBase', label: 'Grow the base to suit', type: 'bool', def: true, group: 'Base',
      help: 'Lengthens the base in small steps until the tipping margin is met, on whichever side is closest to losing it, and stops at the edge of the bed. Off, you get exactly the base you asked for and validate() tells you how far short it is.' },
    { key: 'cornerR', label: 'Corner radius', type: 'number', unit: 'mm', min: 0, max: 25, step: 0.5, def: 3, group: 'Base',
      help: 'Rounding on the outside corners only. The slot and the lip keep their own much smaller radii whatever this says — a 3 mm radius applied everywhere would eat the cradle floor and the device would no longer fit.' },

    // ---- Features ---------------------------------------------------------
    { key: 'cable', label: 'Cable route', type: 'bool', def: true, group: 'Features',
      help: 'A shaft up through the base into the slot floor, a notch through the lip, and a groove out of the underside to the back edge. Every one of them opens to the outside — the plug goes in from beneath and the lead leaves at the back, and there is no blind pocket anywhere in it.' },
    { key: 'cableW', label: 'Channel width', type: 'number', unit: 'mm', min: 3, max: 60, step: 0.5, def: 12, group: 'Features',
      showIf: (p) => p.cable !== false,
      help: 'Sized for the plug, not the cable: a USB-C connector with a case-thickened strain relief on it is 12-14 mm across the moulding. Narrowed automatically if the stand is not wide enough to keep material either side.' },
    { key: 'portOffset', label: 'Port offset from centre', type: 'number', unit: 'mm', min: -120, max: 120, step: 1, def: 0, group: 'Features',
      showIf: (p) => p.cable !== false,
      help: 'Where the device\'s socket is, along the stand. Zero for anything held in portrait. A phone or a console lying on its long edge has its socket off at one end, and if the stand is not wide enough to reach it the channel is clamped and you are told.' },
    { key: 'hook', label: 'Headphone hook', type: 'enum', def: 'none', group: 'Features',
      showIf: (p) => p.style !== 'easel',
      help: 'A fin on the side carrying a peg that projects BEHIND the stand, so what hangs on it hangs behind everything and cannot foul a device wider than the base.',
      options: [
        { v: 'none', label: 'None' },
        { v: 'right', label: 'Right side', help: 'One fin. Its own weight and whatever hangs on it pull the centre of gravity to that side, which the tipping check does account for.' },
        { v: 'left', label: 'Left side' },
        { v: 'both', label: 'Both sides', help: 'Symmetrical, and adds two fin thicknesses to the width the bed has to swallow.' },
      ] },
    { key: 'hookT', label: 'Saddle width', type: 'number', unit: 'mm', min: 2, max: 30, step: 0.5, def: 8, group: 'Features',
      showIf: (p) => p.style !== 'easel' && p.hook && p.hook !== 'none',
      help: 'How wide the peg is where the headband lies across it, capped at 30 mm because past that the fin is wider than the wedge it hangs off. A Sony WH-1000XM5 headband strip is about 38 mm, so at the cap the saddle is narrower than the band — broad enough not to crease the foam, not broad enough to support it end to end.' },
    { key: 'hookLen', label: 'Peg reach', type: 'number', unit: 'mm', min: 6, max: 120, step: 1, def: 34, group: 'Features',
      showIf: (p) => p.style !== 'easel' && p.hook && p.hook !== 'none',
      help: 'How far the peg projects behind the stand. It is shortened automatically until its 45° gusset can reach solid wedge, and it is the worst lever arm on the part — whatever hangs there acts at this distance.' },
    { key: 'weighted', label: 'Ballast cavity', type: 'bool', def: false, group: 'Features',
      showIf: (p) => p.style !== 'easel',
      help: 'Hollows the back of the wedge into a gabled void with a chimney out of the top slope, to be filled after printing. It does not move the centre of gravity forward, and it is a weaker lever than it sounds: measured across the shipped presets, filling it changed the force needed to tip the stand by under 5 %, and on the e-reader it made the margin worse — the sand sits behind the pivot. Reach for a longer heel first; use ballast when the heel has run out of bed.' },
    { key: 'wallT', label: 'Cavity wall', type: 'number', unit: 'mm', min: 1.6, max: 15, step: 0.2, def: 4, group: 'Features',
      showIf: (p) => p.style !== 'easel' && p.weighted === true,
      help: 'Material left around the ballast void. It is also the roof and floor of the void, and the void only fits at all if the wedge\'s rear triangle is big enough to take a 45° gable inside these walls.' },
    { key: 'fillDensity', label: 'Fill density', type: 'number', unit: 'g/cm³', min: 0.2, max: 12, step: 0.1, def: 1.6, group: 'Features',
      showIf: (p) => p.style !== 'easel' && p.weighted === true,
      help: 'What you will actually pour in. Kiln-dried sand 1.6, steel shot 4.5, lead shot 6.7. Water is 1.0 and is the wrong answer — an FDM part is watertight only by accident.' },

    // ---- Print ------------------------------------------------------------
    { key: 'infill', label: 'Infill', type: 'number', unit: '%', min: 1, max: 100, step: 1, def: 15, group: 'Print',
      help: 'Used for the tipping arithmetic as much as for the print. A part this size is roughly 30 % shell by volume whatever you set, and the rest is this — so the number matters far less to the strength than the wall count does, and under-estimating the stand\'s own mass is the safe direction.' },
    { key: 'arrange', label: 'Arrangement', type: 'enum', def: 'plate', group: 'Print',
      showIf: (p) => p.style === 'easel',
      help: 'What the two easel pieces are doing.',
      options: [
        { v: 'plate', label: 'Flat on the plate', help: 'Both pieces lying on their largest face, side by side, not touching. This is what you print.' },
        { v: 'assembled', label: 'Assembled', help: 'The prop standing in its nominal socket, so you can see the object as it will be used. A picture, not a print — the prop is a 90° overhang held up by nothing.' },
      ] },
  ],

  presets: [
    // Numbers are from published manufacturer specs; case thickness and mass are
    // estimates built on vendor case dimensions, and the angles are from what the
    // object is FOR rather than from taste. See gates/G12-stand.md.
    { name: 'Tablet on a desk for drawing',
      values: { style: 'wedge', angle: 18, deviceT: 12, deviceW: 281.6, deviceH: 215.5, deviceMass: 865,
        screenInset: 8.4, slotClear: 0.8, coverage: 0.5, baseT: 8, restH: 70, restT: 6,
        lipH: 6, lipT: 3, lipMargin: 2, cornerR: 4, frontLen: 8, backLen: 40, tipMargin: 8, autoBase: true,
        cable: true, cableW: 14, portOffset: 0, hook: 'none', weighted: false, infill: 20 } },

    { name: 'Recipe tablet in the kitchen',
      values: { style: 'easel', arrange: 'plate', angle: 45, deviceT: 12, deviceW: 248.6, deviceH: 179.5,
        deviceMass: 730, screenInset: 10.8, slotClear: 0.8, coverage: 0.45, baseT: 7, restH: 60, restT: 5,
        lipH: 8, lipT: 3, lipMargin: 2, angleSteps: 3, angleSpread: 10, fit: 0.25, cornerR: 3,
        frontLen: 8, backLen: 12, tipMargin: 8, autoBase: true, cable: true, cableW: 12, portOffset: 0, infill: 15 } },

    { name: 'E-reader on the nightstand',
      values: { style: 'wedge', angle: 70, deviceT: 13, deviceW: 127.6, deviceH: 176.7, deviceMass: 300,
        screenInset: 17, slotClear: 0.8, coverage: 0.55, baseT: 7, restH: 55, restT: 5,
        lipH: 12, lipT: 3, lipMargin: 4, cornerR: 3, frontLen: 10, backLen: 40, tipMargin: 8, autoBase: true,
        cable: true, cableW: 11, portOffset: 0, hook: 'none', weighted: true, wallT: 2.8, fillDensity: 4.5, infill: 15 } },

    { name: 'Bedside phone dock',
      values: { style: 'wedge', angle: 65, deviceT: 11.5, deviceW: 77.6, deviceH: 163, deviceMass: 265,
        screenInset: 2.3, slotClear: 0.7, coverage: 0.75, baseT: 6, restH: 50, restT: 4.4,
        lipH: 4, lipT: 2.4, lipMargin: 0, cornerR: 3, frontLen: 10, backLen: 22, tipMargin: 6, autoBase: true,
        cable: true, cableW: 12, portOffset: 0, hook: 'none', weighted: false, infill: 15 } },

    { name: 'Phone for watching across a desk',
      values: { style: 'wedge', angle: 65, deviceT: 11.5, deviceW: 162.8, deviceH: 77.6, deviceMass: 258,
        screenInset: 2.1, slotClear: 0.7, coverage: 0.7, baseT: 6, restH: 26, restT: 4.4,
        lipH: 3, lipT: 2.4, lipMargin: 0, cornerR: 3, frontLen: 9, backLen: 18, tipMargin: 6, autoBase: true,
        cable: true, cableW: 12, portOffset: 45, hook: 'none', weighted: false, infill: 15 } },

    { name: 'Switch propped for tabletop play',
      values: { style: 'wedge', angle: 60, deviceT: 13.9, deviceW: 272, deviceH: 114.3, deviceMass: 535,
        screenInset: 8, slotClear: 0.8, coverage: 0.6, baseT: 7, restH: 34, restT: 5,
        lipH: 6, lipT: 3, lipMargin: 2, cornerR: 4, frontLen: 10, backLen: 26, tipMargin: 8, autoBase: true,
        cable: false, hook: 'none', weighted: false, infill: 15 } },

    { name: 'Handheld console parked on charge',
      values: { style: 'wedge', angle: 70, deviceT: 50, deviceW: 298, deviceH: 117, deviceMass: 640,
        screenInset: 8.7, slotClear: 1.2, coverage: 0.5, baseT: 8, restH: 55, restT: 6,
        lipH: 8, lipT: 3.5, lipMargin: 1, cornerR: 4, frontLen: 8, backLen: 30, tipMargin: 8, autoBase: true,
        cable: false, hook: 'none', weighted: false, infill: 15 } },

    { name: 'Headphones hung beside the desk',
      values: { style: 'wedge', angle: 80, deviceT: 40, deviceW: 170, deviceH: 190, deviceMass: 300,
        screenInset: 0, slotClear: 1, coverage: 0.3, baseT: 8, restH: 80, restT: 6,
        lipH: 8, lipT: 3, lipMargin: 0, cornerR: 4, frontLen: 12, backLen: 45, tipMargin: 10, autoBase: true,
        cable: true, cableW: 10, portOffset: 0, hook: 'right', hookT: 30, hookLen: 40,
        weighted: true, wallT: 3.2, fillDensity: 4.5, infill: 20 } },
  ],

  build,
  validate,
  hints,
};

export { build, validate, hints, wedgeSolid, easelSolids, geometry, realise, nominalSocket, plateLayout, propStatus };
