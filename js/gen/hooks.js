// js/gen/hooks.js — hooks, clips and wall hardware.
//
// The small useful family: the thing you print because you needed one this
// afternoon. Seven types, one shared set of engineering rules.
//
// THE ONE DECISION THAT MATTERS IS WHICH WAY UP IT PRINTS.
//
// A printed hook does not fail by bending. It fails by splitting along a layer
// line at the inside corner where the arm meets the plate, because that corner
// is both the highest bending stress in the part and — if the part was printed
// standing up, the way it hangs on the wall — a plane of weak inter-layer bonds
// lying exactly perpendicular to the tension. Layer adhesion in PLA is roughly
// half the in-layer strength, and a sharp internal corner multiplies the local
// stress by two or three again.
//
// So every prismatic type in this file is built as a 2D SIDE PROFILE in the XY
// plane and extruded along Z. X is the distance out from the wall, Y is up the
// wall, Z is the part's width — and Z is the build direction. The part comes out
// of Bluesheet lying on its side, which is the orientation it must be sliced in:
// the whole silhouette is the first layer (enormous bed contact, no brim, no
// supports, every wall vertical), and the bending tension at the root runs
// ALONG the extrusions rather than across the bonds between them.
//
// The cost of that choice is that the screw holes are then horizontal bores, so
// they get teardrop roofs, and the countersinks are horizontal cones — which is
// fine, because a 90 degree countersink is a 45 degree overhang at its steepest
// line and prints without support. That trade is the right way round: a
// slightly ugly hole beats a hook that snaps.
//
// The spool is the exception and says so in hints(): it is a revolve, printed
// axis-up, and its flange undersides are coned at 45 degrees for the same
// reason — so that nothing in this file needs support.
//
// THE OTHER RULES, applied everywhere:
//   * Every load-bearing root gets a fillet. Profiles are assembled from simple
//     pieces, unioned in 2D, and then run through roundedPath, so every corner
//     of every profile carries a radius. There is no sharp internal corner in
//     this file.
//   * Wall thicknesses are snapped to a whole number of extrusions. A 1.5 mm
//     wall at a 0.4 mm nozzle is three extrusions and a 0.3 mm gap the slicer
//     fills with a wandering zigzag; 1.6 mm is four clean perimeters and is
//     stronger despite being barely thicker.
//   * A snap-fit clip's mouth is 0.70-0.95 of the cable diameter, and validate()
//     computes the strain the arms actually see when the cable goes in.
//
// CONSTRUCTION. Profiles are direct 2D geometry — thickened polylines, unions,
// fillets. CSG is used only for the fastener features, which genuinely cross the
// extrusion direction and cannot be expressed in the profile: one lofted cutter
// per fastener (teardrop bore, conical countersink and counterbore all in the
// same solid), plus the adhesive pad recess and the captive nut pocket.

import { Mesh } from '../kernel/mesh.js';
import {
  TAU, rect, circle, slot, regularPolygon, roundedPath, boolean, ensureCCW,
  area as ringArea, bounds, signedArea,
} from '../kernel/poly2d.js';
import { extrude, loft, revolve, ringSelfIntersects } from '../kernel/builders.js';
import { subtractAll } from '../kernel/csg.js';
import { DEG, RAD, clamp, num, segScale } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

// ---------------------------------------------------------------------------
// Fastener data.
//
// Clearance holes are the "medium" fit of ISO 273 plus 0.3 mm, because an FDM
// hole comes out undersize: the inner perimeter is laid on the inside of the
// curve and pulled tight by its own cooling, and 0.2-0.4 mm is the usual loss.
// Countersunk head diameters are DIN 965 nominal; nut sizes are DIN 934.
// ---------------------------------------------------------------------------

const SCREWS = {
  M3: { clear: 3.4, head: 6.0, nutAF: 5.5, nutT: 2.4, cap: 5.5, capH: 3.0 },
  M4: { clear: 4.5, head: 8.0, nutAF: 7.0, nutT: 3.2, cap: 7.0, capH: 4.0 },
  M5: { clear: 5.5, head: 10.0, nutAF: 8.0, nutT: 4.0, cap: 8.5, capH: 5.0 },
};
const HOLE_SLOP = 0.3;      // added to every clearance diameter
const HEAD_SLOP = 0.4;      // added to head and counterbore diameters
const NUT_SLOP = 0.25;      // added across the nut's flats
const MIN_MEAT = 0.4;       // material that must survive under a countersink

/** Adhesive pads, in the sizes actually sold. width is across the part, height up it. */
const PADS = {
  '20x20': { w: 20, h: 20, label: '20 × 20 mm VHB square' },
  '25x25': { w: 25, h: 25, label: '25 × 25 mm VHB square' },
  '19x44': { w: 19, h: 44, label: '19 × 44 mm foam mounting strip' },
  '12x50': { w: 12, h: 50, label: '12 × 50 mm narrow strip' },
  custom: { w: 20, h: 40, label: 'custom' },
};

const PRISMATIC = ['jhook', 'clip', 'wallhook', 'bracket', 'hanger', 'comb'];
const HOOKISH = ['jhook', 'wallhook', 'hanger'];
const PLATED = ['jhook', 'clip', 'wallhook', 'hanger', 'comb', 'bracket'];

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Round a thickness to a whole number of extrusions, never fewer than two. */
function snapWall(v, ew) { return Math.max(2, Math.round(v / ew)) * ew; }

// ---------------------------------------------------------------------------
// Ring utilities
// ---------------------------------------------------------------------------

/** Drop points closer together than `minSpace`, including across the seam. */
function cleanRing(r, minSpace) {
  const out = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < minSpace) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 3 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minSpace) out.pop();
  return out;
}

/** Inclusive arc samples. `steps` is derived from the sweep so the chord error stays small. */
function arcPts(cx, cy, r, a0, a1, sf = 1, maxChord = 0.45) {
  const sweep = a1 - a0;
  const byChord = Math.abs(sweep) * r / maxChord;
  const n = Math.max(2, Math.min(360, Math.ceil(byChord * Math.sqrt(sf))));
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    out[i] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  return out;
}

/**
 * The smallest radius any CONVEX part of the ring turns through, estimated from
 * the local turn angle and the shorter adjacent edge. This is the number that
 * decides how big an edge chamfer the profile can carry: inset a ring by more
 * than its tightest convex radius and the offset folds through itself.
 */
function minConvexRadius(ring) {
  const n = ring.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const e1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const e2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (e1 < 1e-9 || e2 < 1e-9) continue;
    const d1x = (b[0] - a[0]) / e1, d1y = (b[1] - a[1]) / e1;
    const d2x = (c[0] - b[0]) / e2, d2y = (c[1] - b[1]) / e2;
    const cross = d1x * d2y - d1y * d2x;
    if (cross <= 1e-9) continue;                       // concave or straight
    const dot = clamp(d1x * d2x + d1y * d2y, -1, 1);
    const turn = Math.atan2(cross, dot);
    if (turn < 0.01 || turn > 2.2) continue;           // an isolated sharp corner tells us nothing
    const r = Math.min(e1, e2) / (2 * Math.tan(turn / 2));
    if (r < best) best = r;
  }
  return best;
}

/**
 * Move every vertex `c` along the bisector of its two edge normals, keeping the
 * vertex count. Deliberately NOT a miter offset: a miter divides by cos(theta/2)
 * and overshoots at exactly the clustered points a boolean leaves behind, while
 * a fixed step of `c` can only fold where the ring's own radius is below `c`,
 * which minConvexRadius already tells us about.
 */
function insetRing(ring, c) {
  const n = ring.length, N = new Array(n), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    N[i] = [-dy / L, dx / L];                          // left of travel == into the material
  }
  for (let i = 0; i < n; i++) {
    const n1 = N[(i - 1 + n) % n], n2 = N[i];
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const L = Math.hypot(mx, my);
    if (L < 1e-9) { mx = n2[0]; my = n2[1]; } else { mx /= L; my /= L; }
    out[i] = [ring[i][0] + mx * c, ring[i][1] + my * c];
  }
  return out;
}

/** Per-vertex offset of an OPEN polyline along its left normal, miter-joined. */
function offsetPolyline(pts, d, miterLimit = 2.5) {
  const n = pts.length, N = new Array(n - 1), out = new Array(n);
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const L = Math.hypot(dx, dy) || 1;
    N[i] = [-dy / L, dx / L];
  }
  for (let i = 0; i < n; i++) {
    const n1 = i > 0 ? N[i - 1] : N[0];
    const n2 = i < n - 1 ? N[i] : N[n - 2];
    const k = 1 + (n1[0] * n2[0] + n1[1] * n2[1]);
    let mx, my;
    if (k < 1e-6) { mx = n2[0]; my = n2[1]; }
    else {
      mx = (n1[0] + n2[0]) / k; my = (n1[1] + n2[1]) / k;
      const ml = Math.hypot(mx, my);
      if (ml > miterLimit) { mx = mx / ml * miterLimit; my = my / ml * miterLimit; }
    }
    out[i] = [pts[i][0] + mx * d, pts[i][1] + my * d];
  }
  return out;
}

/**
 * A polyline given a thickness: the closed ring of a bar of half-thickness
 * `half` following `pts`. Round end caps are the default because a round cap on
 * a hook tip is both the lead-in a cable snaps over and the one place a sharp
 * corner would be under the reader's thumb.
 */
function thickPath(pts, half, { capStart = 'flat', capEnd = 'round', sf = 1 } = {}) {
  const p = cleanRing(pts, 1e-6);
  if (p.length < 2) throw new Error('hooks: thickPath needs two distinct points');
  const L = offsetPolyline(p, half);
  const R = offsetPolyline(p, -half);
  const n = p.length;
  const ring = [];
  for (const q of L) ring.push(q);
  const cap = (centre, from, to) => {
    const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
    let a1 = Math.atan2(to[1] - centre[1], to[0] - centre[0]);
    while (a1 > a0) a1 -= TAU;                          // always sweep clockwise, 180 degrees
    for (const q of arcPts(centre[0], centre[1], half, a0, a1, sf, 0.35)) ring.push(q);
  };
  if (capEnd === 'round') cap(p[n - 1], L[n - 1], R[n - 1]);
  for (let i = n - 1; i >= 0; i--) ring.push(R[i]);
  if (capStart === 'round') cap(p[0], R[0], L[0]);
  return ensureCCW(cleanRing(ring, 1e-6));
}

/** Union a list of rings into one outer ring. Throws if they do not touch. */
function unionRings(pieces, where) {
  let acc = [[ensureCCW(pieces[0])]];
  for (let i = 1; i < pieces.length; i++) acc = boolean(acc, [[ensureCCW(pieces[i])]], 'union');
  if (acc.length !== 1) {
    // Keep the biggest island rather than failing: a parameter extreme that
    // separates the arm from the plate should still return a printable object,
    // and validate() is where the user is told the arm came off.
    acc.sort((a, b) => Math.abs(signedArea(b[0])) - Math.abs(signedArea(a[0])));
  }
  if (!acc.length || !acc[0][0] || acc[0][0].length < 3) throw new Error(`hooks: ${where} produced no profile`);
  return ensureCCW(acc[0][0]);
}

/** Union, then put a radius on every corner. This is the fillet rule, applied once. */
function filletProfile(ring, r, sf) {
  const pre = cleanRing(ring, 0.02);
  if (!(r > 0.05) || pre.length < 3) return pre;
  const segs = Math.max(2, Math.round(3 * Math.sqrt(sf)));
  const rounded = roundedPath(pre, r, { segs });
  return cleanRing(rounded, 0.05);
}

// ---------------------------------------------------------------------------
// Prism with a chamfered top and bottom edge.
//
// The chamfer is not decoration. The bottom one removes the elephant foot from
// the face with the largest bed contact in the whole part, and the top one takes
// the arris off the edge a headphone band or a cable actually rests on. It is
// built as a four-section loft between the profile and a fixed-vertex-count
// inset of it, so the vertex correspondence is exact and the result is
// watertight without a weld.
// ---------------------------------------------------------------------------

function prism(ring, height, chamferWant) {
  const rMin = minConvexRadius(ring);
  let c = Math.min(chamferWant, (height - 0.4) / 2);
  if (isFinite(rMin)) c = Math.min(c, 0.75 * rMin);
  if (!(c > 0.08)) return { mesh: extrude([ring], height, { check: false }), chamfer: 0 };
  const inner = insetRing(ring, c);
  const a0 = Math.abs(signedArea(ring)), a1 = signedArea(inner);
  if (!(a1 > 0) || a1 < 0.25 * a0 || ringSelfIntersects(inner)) {
    return { mesh: extrude([ring], height, { check: false }), chamfer: 0 };
  }
  const mesh = loft([
    { shape: [inner], z: 0 },
    { shape: [ring], z: c },
    { shape: [ring], z: height - c },
    { shape: [inner], z: height },
  ], { align: 'index', check: false });
  return { mesh, chamfer: c };
}

// ---------------------------------------------------------------------------
// Cutters.
//
// Every cutter is built along its own +Z and then rotated onto the axis it
// works on, with the teardrop's roof always ending up pointing at the print's
// +Z. Two orientations are needed:
//   axis 'x'  local (x,y,z) -> global (z,x,y)   bore out of the wall face
//   axis 'y'  local (x,y,z) -> global (x,z,-y)  bore up through a horizontal leg
// ---------------------------------------------------------------------------

function toAxis(mesh, axis) {
  return axis === 'x' ? mesh.rotateX(Math.PI / 2).rotateZ(Math.PI / 2) : mesh.rotateX(-Math.PI / 2);
}

/**
 * A circle with a 45 degree roof. A round bore printed on its side has a
 * horizontal ceiling at the top; the roof replaces it with two 45 degree walls,
 * so the hole comes out the size it was drawn instead of drooping shut. The
 * shape is self-similar under scaling, which is what lets the same ring serve as
 * both ends of the countersink loft.
 */
function teardropRing(r, peakAng, segs) {
  const n = Math.max(10, Math.round(segs));
  const a0 = peakAng - Math.PI / 4, a1 = peakAng + Math.PI / 4;
  const out = [];
  const span = TAU - (a1 - a0);
  for (let i = 0; i <= n; i++) {
    const a = a1 + span * (i / n);
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  out.push([r * Math.SQRT2 * Math.cos(peakAng), r * Math.SQRT2 * Math.sin(peakAng)]);
  return out;
}

/** A stadium of the same vertex count whatever its radius, long axis along local X. */
function slotRing(len, r, segs) {
  const n = Math.max(4, Math.round(segs));
  return slot(Math.max(len, 2 * r + 0.2), r, { segs: n });
}

/**
 * One fastener, as a single closed cutter: countersink cone or counterbore at
 * the near face, then the through bore. Built as a loft so the cone's angle is
 * exact everywhere along it and the whole thing is one operand for the CSG.
 */
function fastenerCutter(f, sf) {
  const segs = Math.max(12, Math.round(20 * Math.sqrt(sf)));
  const peak = f.axis === 'x' ? Math.PI / 2 : -Math.PI / 2;   // roof to the print's +Z
  const e = 0.6;                                              // overshoot outside the face
  const ring = (r, extra) => (f.slotLen > 0
    ? slotRing(f.slotLen + 2 * (r - f.rBore), r, segs)
    : teardropRing(r, peak, segs));
  const secs = [];
  if (f.cone > 0) {
    const t = Math.tan(f.cone / 2);
    secs.push({ shape: [ring(f.rHead + e * t)], z: -e });
    secs.push({ shape: [ring(f.rBore)], z: f.csDepth });
    secs.push({ shape: [ring(f.rBore)], z: f.thru + e });
  } else if (f.cbore > 0) {
    secs.push({ shape: [ring(f.rHead)], z: -e });
    secs.push({ shape: [ring(f.rHead)], z: f.cbore });
    secs.push({ shape: [ring(f.rBore)], z: f.cbore + 0.001 });
    secs.push({ shape: [ring(f.rBore)], z: f.thru + e });
  } else {
    secs.push({ shape: [ring(f.rBore)], z: -e });
    secs.push({ shape: [ring(f.rBore)], z: f.thru + e });
  }
  let m = loft(secs, { align: 'index', check: false });
  m = toAxis(m, f.axis);
  return f.axis === 'x' ? m.translate(0, f.at, f.z) : m.translate(f.at, 0, f.z);
}

/**
 * A hex seat with an open throat above it, so the nut drops in from what is the
 * TOP of the part while it is printing. A nut pocket with a roof over it needs
 * either a bridge or a support; a nut pocket you can drop the nut into needs
 * neither, and it can be done at a print pause or after the part is off the bed.
 */
function nutCutter(f, sf) {
  const R = (f.nutAF + NUT_SLOP) / Math.sqrt(3);              // circumradius from across-flats
  const hex = regularPolygon(6, R);                           // flats top and bottom
  const chan = rect(2 * R + 0.3, f.throatUp, { cx: 0, cy: f.nutAF / 2 + f.throatUp / 2 - 0.01 });
  const ring = unionRings([hex, chan], 'nut pocket');
  const depth = f.nutT + 0.3;
  let m = extrude([ring], depth, { check: false });
  m = toAxis(m, f.axis);
  const u = f.thru - depth + 0.2;                             // seated against the far face
  return f.axis === 'x'
    ? m.translate(u, f.at, f.z)
    : m.translate(f.at, u, f.z);
}

/** The adhesive pad recess: a shallow pocket in the mounting face, chamfered all round. */
function padCutter(pad, axis, sf) {
  const c = Math.min(0.6, pad.depth * 0.9, Math.min(pad.w, pad.h) / 6);
  const half = { w: pad.w, h: pad.h };
  // Chamfer the pocket by lofting a slightly larger mouth to the flat floor: the
  // mouth's extra 45 degrees is also the lead-in that lets the pad be placed
  // without peeling its own corner off.
  const inner = rect(half.w, half.h);
  const outer = rect(half.w + 2 * c, half.h + 2 * c);
  const e = 0.4;
  const secs = [
    { shape: [outer], z: -e },
    { shape: [outer], z: 0 },
    { shape: [inner], z: c },
    { shape: [inner], z: pad.depth },
  ];
  let m = loft(secs, { align: 'index', check: false });
  m = toAxis(m, axis);
  return axis === 'x' ? m.translate(0, pad.cy, pad.cz) : m.translate(pad.cx, 0, pad.cz);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** The J-hook: a straight arm out of the plate, then an upturn of `sweep` degrees. */
function profileJHook(s, sf) {
  const t = s.stock, half = t / 2;
  const R = s.bendR;
  const xa = s.reach - R;
  const y0 = half;
  const cx = xa, cy = y0 + R;
  const line = [[s.plateT * 0.5, y0], [xa, y0]];
  const a0 = -Math.PI / 2, a1 = a0 + s.sweep;
  const arc = arcPts(cx, cy, R, a0, a1, sf, 0.4);
  const path = line.concat(arc.slice(1));
  if (s.tipLen > 0.2) {
    const tan = [-Math.sin(a1), Math.cos(a1)];
    const last = path[path.length - 1];
    path.push([last[0] + tan[0] * s.tipLen, last[1] + tan[1] * s.tipLen]);
  }
  const arm = thickPath(path, half, { capStart: 'flat', capEnd: 'round', sf });
  const plate = rect(s.plateT, s.plateH, { cx: s.plateT / 2, cy: s.plateH / 2 });
  return unionRings([plate, arm], 'J-hook');
}

/**
 * The adhesive wall hook: not a bar but a solid ramp, deep where it leaves the
 * plate and thin at the tip, with a lip on the end. An adhesive pad cannot take
 * much of a moment, so the root has to be as stiff as the material allows and
 * the load has to sit as close to the wall as the hook can manage.
 */
function profileWallHook(s, sf) {
  const t = s.stock, half = t / 2;
  const rootH = clamp(s.plateH * 0.42, t * 1.4, s.plateH - 2);
  const tipY = Math.min(rootH + s.rise, s.plateH - 1);
  const reach = Math.max(s.reach, s.plateT + t + 1);
  const rampBotTip = Math.max(tipY - t, 0.6);
  const ramp = [
    [0, 0],
    [reach, rampBotTip],
    [reach, tipY],
    [0, rootH],
  ];
  const plate = rect(s.plateT, s.plateH, { cx: s.plateT / 2, cy: s.plateH / 2 });
  // The lip: a short upturn tangent to the top of the ramp.
  const dirx = reach - 0, diry = tipY - rootH;
  const dl = Math.hypot(dirx, diry) || 1;
  const ang = Math.atan2(diry, dirx);
  const R = Math.max(s.bendR, half + 0.4);
  const start = [reach - t * 0.6 * (dirx / dl), tipY - half + (t * 0.6) * 0 - 0];
  const cx = start[0] - R * Math.sin(ang), cy = start[1] + R * Math.cos(ang);
  const a0 = ang - Math.PI / 2;
  const a1 = a0 + Math.max(s.sweep * 0.55, 45 * DEG);
  const arc = arcPts(cx, cy, R, a0, a1, sf, 0.4);
  const lip = thickPath(arc, half, { capStart: 'flat', capEnd: 'round', sf });
  return unionRings([plate, ramp, lip], 'wall hook');
}

/**
 * The headphone / tool hanger: a broad saddle on a gently rising arc, so the
 * band is carried on a curve instead of creased over an edge, and so anything
 * hung on it rolls back towards the wall rather than off the end.
 */
function profileHanger(s, sf) {
  const t = s.stock, half = t / 2;
  const y0 = half;
  const Rc = Math.max(s.cradleR, s.reach * 0.9);
  const psi = Math.min(s.reach / Rc, 75 * DEG);
  const c0x = s.plateT * 0.5, c0y = y0 + Rc;
  const cradle = arcPts(c0x, c0y, Rc, -Math.PI / 2, -Math.PI / 2 + psi, sf, 0.5);
  // The lip carries on from where the cradle ends, tangentially.
  const R = Math.max(s.bendR, half + 0.4);
  const end = cradle[cradle.length - 1];
  const tang = psi;                                   // heading, radians above horizontal
  const lx = end[0] - R * Math.sin(tang), ly = end[1] + R * Math.cos(tang);
  const a0 = tang - Math.PI / 2;
  const lip = arcPts(lx, ly, R, a0, a0 + Math.max(s.sweep * 0.7, 50 * DEG), sf, 0.4);
  const path = cradle.concat(lip.slice(1));
  const arm = thickPath(path, half, { capStart: 'flat', capEnd: 'round', sf });
  const plate = rect(s.plateT, s.plateH, { cx: s.plateT / 2, cy: s.plateH / 2 });
  return unionRings([plate, arm], 'hanger');
}

/** The snap-on cable clip: a C whose back is buried in its own mounting pad. */
function profileClip(s, sf) {
  const rc = s.cableDia / 2 + s.clearance;
  const w = s.wall;
  const Rc = rc + w / 2;
  const cx = s.plateT + rc;
  const cy = Math.max(s.plateH / 2, rc + w + 0.6);
  // Mouth width is measured between the two rounded tips, which are circles of
  // radius w/2 centred on the arc: the gap is the centre distance less one wall.
  const want = s.grip * s.cableDia;
  const sinHalf = clamp((want + w) / (2 * Rc), 0.02, 0.999);
  const gapHalf = Math.asin(sinHalf);
  const a0 = gapHalf, a1 = TAU - gapHalf;
  const arc = arcPts(cx, cy, Rc, a0, a1, sf, 0.35);
  const c = thickPath(arc, w / 2, { capStart: 'round', capEnd: 'round', sf });
  const plateH = Math.max(s.plateH, 2 * cy);
  const plate = rect(s.plateT, plateH, { cx: s.plateT / 2, cy: plateH / 2 });
  return { ring: unionRings([plate, c], 'cable clip'), cx, cy, rc, gapHalf, Rc, opening: 2 * Rc * sinHalf - w };
}

/** The screw-mount shelf bracket: two legs and a web, with the corner filleted. */
function profileBracket(s, sf) {
  const tV = s.plateT, tH = s.stock;
  const legV = s.legV, legH = s.legH;
  const g = Math.max(0, Math.min(s.gusset, legV - tH - 1.5, legH - tV - 1.5));
  const vert = rect(tV, legV, { cx: tV / 2, cy: legV / 2 });
  const horiz = rect(legH, tH, { cx: legH / 2, cy: tH / 2 });
  const pieces = [vert, horiz];
  if (g > 0.5 && s.gussetStyle !== 'none') {
    const web = [[tV, tH], [tV + g, tH]];
    if (s.gussetStyle === 'curved') {
      for (const q of arcPts(tV + g, tH + g, g, -Math.PI / 2, -Math.PI, sf, 0.5)) web.push(q);
    } else {
      web.push([tV, tH + g]);
    }
    if (s.gussetStyle === 'curved') web.push([tV, tH + g]);
    pieces.push(cleanRing(web, 1e-6));
  }
  return unionRings(pieces, 'bracket');
}

/**
 * The cable comb: a bar of slots, each with a throat that grips and a round
 * bottom. A square-bottomed slot is a stress riser and it holds the cable badly;
 * the round bottom is the cable's own radius, so the cable beds in rather than
 * bridging across two corners.
 */
function profileComb(s, sf) {
  const rc = s.cableDia / 2 + s.clearance;
  const tH = s.grip * s.cableDia / 2;                 // half the throat opening
  const lead = 0.8, throatH = 0.8;
  const flare = Math.max(rc - tH, 0.2);
  const depth = rc + flare + throatH + lead + 0.6;
  const barH = s.combBase + depth;
  const pitch = 2 * rc + s.toothW;
  const nSlots = s.slots;
  const barLen = nSlots * pitch + s.toothW;
  const hx = barLen / 2;
  const out = [];
  out.push([-hx, 0], [hx, 0], [hx, barH]);
  for (let i = nSlots - 1; i >= 0; i--) {
    const xc = -hx + s.toothW + rc + i * pitch;
    const yb = barH - depth + rc;
    out.push([xc + tH + lead, barH]);
    out.push([xc + tH, barH - lead]);
    out.push([xc + tH, barH - lead - throatH]);
    out.push([xc + rc, barH - lead - throatH - flare]);
    out.push([xc + rc, yb]);
    for (const q of arcPts(xc, yb, rc, 0, -Math.PI, sf, 0.35)) out.push(q);
    out.push([xc - rc, barH - lead - throatH - flare]);
    out.push([xc - tH, barH - lead - throatH]);
    out.push([xc - tH, barH - lead]);
    out.push([xc - tH - lead, barH]);
  }
  out.push([-hx, barH]);
  return { ring: ensureCCW(cleanRing(out, 1e-6)), barLen, barH, depth, rc, throat: 2 * tH };
}

// ---------------------------------------------------------------------------
// layout — every derived number in one place, so build, validate, hints and the
// tests are all reading the same object rather than three copies of the sums.
// ---------------------------------------------------------------------------

export function layout(p, ctx = {}) {
  const ew = clamp(num(ctx.nozzle, 0.4), 0.15, 1.2);
  const sf = segScale(ctx);
  const type = typeof p.type === 'string' && TYPE_IDS.includes(p.type) ? p.type : 'jhook';
  const s = {
    type, ew, sf,
    width: clamp(num(p.width, 18), 4, 160),
    wall: snapWall(clamp(num(p.wall, 2.4), ew * 2, 12), ew),
    fillet: clamp(num(p.fillet, 2.5), 0, 12),
    chamferWant: clamp(num(p.chamfer, 0.6), 0, 2),
    plateT: snapWall(clamp(num(p.plateT, 3.2), ew * 2, 16), ew),
    plateH: clamp(num(p.plateH, 45), 6, 150),
    reach: clamp(num(p.reach, 26), 4, 100),
    stock: snapWall(clamp(num(p.stock, 5), ew * 3, 20), ew),
    bendR: clamp(num(p.bendR, 9), 1, 45),
    sweep: clamp(num(p.sweepDeg, 150), 30, 240) * DEG,
    tipLen: clamp(num(p.tipLen, 4), 0, 30),
    rise: clamp(num(p.rise, 9), 1, 60),
    cradleR: clamp(num(p.cradleR, 90), 12, 400),
    cableDia: clamp(num(p.cableDia, 5), 1, 40),
    clearance: clamp(num(p.clearance, 0.3), 0, 2),
    grip: clamp(num(p.grip, 0.85), 0.5, 1.05),
    slots: Math.round(clamp(num(p.slots, 6), 1, 24)),
    toothW: clamp(num(p.toothW, 4), 1.2, 20),
    combBase: clamp(num(p.combBase, 9), 2, 40),
    legV: clamp(num(p.legV, 70), 10, 150),
    legH: clamp(num(p.legH, 55), 10, 150),
    gusset: clamp(num(p.gusset, 40), 0, 140),
    gussetStyle: ['curved', 'straight', 'none'].includes(p.gussetStyle) ? p.gussetStyle : 'curved',
    boreDia: clamp(num(p.boreDia, 8), 0, 60),
    hubDia: clamp(num(p.hubDia, 24), 4, 150),
    flangeDia: clamp(num(p.flangeDia, 60), 8, 170),
    spoolH: clamp(num(p.spoolH, 34), 6, 150),
    flangeT: snapWall(clamp(num(p.flangeT, 2.4), ew * 2, 12), ew),
    flangeHoles: Math.round(clamp(num(p.flangeHoles, 0), 0, 12)),
    mount: ['screws', 'adhesive', 'both', 'none'].includes(p.mount) ? p.mount : 'screws',
    screw: SCREWS[p.screw] ? p.screw : 'M4',
    head: ['cs90', 'cs82', 'counterbore', 'plain'].includes(p.head) ? p.head : 'cs90',
    holes: Math.round(clamp(num(p.holes, 2), 1, 4)),
    slotted: !!p.slotted,
    slotTravel: clamp(num(p.slotTravel, 6), 0, 30),
    nutPocket: !!p.nutPocket,
    padKey: PADS[p.pad] ? p.pad : '19x44',
    padDepth: clamp(num(p.padDepth, 0.6), 0.2, 3),
    notes: [],
    raw: p,
  };

  // Geometry that several types share and that has to stay legal at every
  // extreme of the sweep.
  s.bendR = Math.max(s.bendR, s.stock / 2 + 0.4);
  if (HOOKISH.includes(type)) {
    const minReach = s.plateT + s.stock / 2 + 1;
    if (s.reach < minReach) { s.reach = minReach; s.notes.push('reach clamped to clear the back plate'); }
    if (type === 'jhook') {
      const maxR = s.reach - s.plateT - 0.6;
      if (s.bendR > maxR) { s.bendR = Math.max(maxR, s.stock / 2 + 0.4); }
      if (s.reach - s.bendR < s.plateT * 0.5 + 0.4) s.reach = s.bendR + s.plateT * 0.5 + 0.4;
    }
  }

  // --- fasteners ----------------------------------------------------------
  const sc = SCREWS[s.screw];
  const rBore = (sc.clear + HOLE_SLOP) / 2;
  const coneDeg = s.head === 'cs90' ? 90 : s.head === 'cs82' ? 82 : 0;
  s.cone = coneDeg;
  s.rBore = rBore;
  s.screwData = sc;
  s.fasteners = [];
  s.padSpec = null;

  const wantScrews = (s.mount === 'screws' || s.mount === 'both') && type !== 'spool';
  const wantPad = (s.mount === 'adhesive' || s.mount === 'both') && PLATED.includes(type);

  /** One fastener through `thru` mm of material, centred on the part's width. */
  const makeF = (axis, at, thru, slotLen) => {
    const t = coneDeg ? Math.tan(coneDeg / 2 * DEG) : 0;
    let rHead = (sc.head + HEAD_SLOP) / 2;
    let csDepth = 0, cbore = 0;
    if (coneDeg) {
      const maxDepth = Math.max(0, thru - MIN_MEAT);
      const ideal = (rHead - rBore) / t;
      if (ideal > maxDepth) rHead = rBore + maxDepth * t;
      csDepth = (rHead - rBore) / t;
      if (!(csDepth > 0.05)) { csDepth = 0; }
    } else if (s.head === 'counterbore') {
      rHead = (sc.cap + HEAD_SLOP) / 2;
      cbore = Math.min(sc.capH + 0.3, Math.max(0, thru - 1.2));
      if (!(cbore > 0.2)) cbore = 0;
    }
    return {
      axis, at, z: s.width / 2, thru, rBore,
      rHead: coneDeg && csDepth > 0 ? rHead : (cbore > 0 ? rHead : rBore),
      cone: csDepth > 0 ? coneDeg * DEG : 0,
      coneDeg: csDepth > 0 ? coneDeg : 0,
      csDepth, cbore,
      slotLen: slotLen || 0,
      nutAF: sc.nutAF, nutT: sc.nutT,
      throatUp: Math.max(0.5, s.width / 2 - sc.nutAF / 2 + 1),
      fits: 2 * (coneDeg && csDepth > 0 ? rHead : Math.max(rBore, cbore > 0 ? rHead : rBore)) + 2.0 <= s.width,
      boreFits: 2 * rBore + 1.6 <= s.width,
    };
  };

  const spread = (lo, hi, n) => {
    const out = [];
    if (hi - lo < 0.01 || n < 1) return [(lo + hi) / 2];
    if (n === 1) return [(lo + hi) / 2];
    for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * i / (n - 1));
    return out;
  };

  if (wantScrews) {
    const rOut = Math.max(rBore, (sc.head + HEAD_SLOP) / 2);
    const sl = s.slotted ? s.slotTravel : 0;
    if (type === 'bracket') {
      const marginV = rOut + sl / 2 + 1.2;
      const loV = s.stock + marginV, hiV = s.legV - marginV;
      const nV = hiV > loV ? Math.min(s.holes, Math.max(1, Math.floor((hiV - loV) / (2 * rOut + 3)) + 1)) : 1;
      for (const y of spread(loV, Math.max(loV, hiV), nV)) s.fasteners.push(makeF('x', y, s.plateT, sl));
      const marginH = rOut + sl / 2 + 1.2;
      const loH = s.plateT + marginH, hiH = s.legH - marginH;
      const nH = hiH > loH ? Math.min(s.holes, Math.max(1, Math.floor((hiH - loH) / (2 * rOut + 3)) + 1)) : 1;
      for (const x of spread(loH, Math.max(loH, hiH), nH)) s.fasteners.push(makeF('y', x, s.stock, sl));
    } else if (type === 'comb') {
      const cb = profileComb(s, 1);
      s.combGeom = cb;
      const m = rOut + 1.6;
      const lo = -cb.barLen / 2 + m, hi = cb.barLen / 2 - m;
      const n = hi > lo ? Math.min(Math.max(s.holes, 2), 4) : 1;
      for (const x of spread(lo, Math.max(lo, hi), n)) s.fasteners.push(makeF('y', x, s.combBase, 0));
    } else if (PLATED.includes(type)) {
      const bottom = type === 'clip' ? rOut + sl / 2 + 1.2 : s.stock + rOut + sl / 2 + 1.2;
      const top = s.plateH - (rOut + sl / 2 + 1.2);
      const n = top > bottom ? Math.min(s.holes, Math.max(1, Math.floor((top - bottom) / (2 * rOut + 3)) + 1)) : 1;
      for (const y of spread(Math.min(bottom, top), Math.max(bottom, top), n)) {
        s.fasteners.push(makeF('x', y, s.plateT, sl));
      }
    }
    s.droppedHoles = s.fasteners.filter(f => !f.boreFits).length;
    s.flatHeads = s.fasteners.filter(f => f.boreFits && !f.fits).length;
    s.fasteners = s.fasteners.filter(f => f.boreFits);
    for (const f of s.fasteners) {
      if (!f.fits) { f.cone = 0; f.coneDeg = 0; f.csDepth = 0; f.cbore = 0; f.rHead = f.rBore; }
    }
  } else {
    s.droppedHoles = 0; s.flatHeads = 0;
  }

  if (wantPad) {
    const pd = PADS[s.padKey];
    const w = s.padKey === 'custom' ? clamp(num(p.padW, 20), 5, 150) : pd.w;
    const h = s.padKey === 'custom' ? clamp(num(p.padH, 40), 5, 150) : pd.h;
    const axis = type === 'comb' ? 'y' : 'x';
    const availW = s.width - 2 * 1.2;
    const availH = (type === 'comb' ? (s.combGeom ? s.combGeom.barLen : 60) : s.plateH) - 2 * 1.2;
    const fitW = Math.min(w, availW), fitH = Math.min(h, availH);
    s.padWanted = { w, h };
    if (fitW > 3 && fitH > 3 && s.padDepth + 0.8 <= (axis === 'x' ? s.plateT : s.combBase)) {
      s.padSpec = {
        w: fitW, h: fitH, depth: s.padDepth, axis,
        cy: axis === 'x' ? s.plateH / 2 : 0,
        cx: 0,
        cz: s.width / 2,
        label: pd.label, clipped: fitW < w - 1e-6 || fitH < h - 1e-6,
      };
      if (axis === 'x') { s.padSpec.cy = s.plateH / 2; s.padSpec.cz = s.width / 2; }
      else { s.padSpec.cx = 0; s.padSpec.cz = s.width / 2; }
      // rect(w,h) in the cutter's local frame maps local X -> the part's width
      // for axis 'x' and to the part's length for axis 'y'; swap so that `w` is
      // always the dimension across the part's width.
      s.padSpec.localW = fitH;
      s.padSpec.localH = fitW;
    }
  }

  // The spool's flange cone is 45 degrees if the height allows it and as steep
  // as it has to be otherwise; validate() reports the difference.
  if (type === 'spool') {
    const rF = s.flangeDia / 2, rH = Math.min(s.hubDia / 2, rF - 0.8);
    const rB = Math.min(s.boreDia / 2, rH - s.wall);
    const want = Math.max(rF - rH, 0);
    const room = Math.max(0, (s.spoolH - 2 * s.flangeT - 1) / 2);
    const coneH = Math.min(want, room);
    s.spoolGeom = {
      rF, rH: Math.max(rH, 1), rB: Math.max(rB, 0), coneH,
      overhangDeg: coneH > 1e-6 ? Math.atan2(want, coneH) * RAD : (want > 1e-6 ? 90 : 0),
      hubLen: Math.max(0.6, s.spoolH - 2 * s.flangeT - 2 * coneH),
    };
  }

  return s;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function buildSpool(s) {
  const g = s.spoolGeom;
  const sf = s.sf;
  const H = s.spoolH, ft = s.flangeT;
  const prof = [];
  const r0 = g.rB > 0.2 ? g.rB : 0;
  prof.push([r0, 0], [g.rF, 0], [g.rF, ft]);
  if (g.coneH > 1e-6) prof.push([g.rH, ft + g.coneH]);
  else prof.push([g.rH, ft]);
  prof.push([g.rH, H - ft - g.coneH]);
  if (g.coneH > 1e-6) prof.push([g.rF, H - ft]);
  prof.push([g.rF, H - ft], [g.rF, H], [r0, H]);
  const clean = [];
  for (const q of prof) {
    const last = clean[clean.length - 1];
    if (last && Math.hypot(last[0] - q[0], last[1] - q[1]) < 1e-7) continue;
    clean.push(q);
  }
  const segs = Math.max(24, Math.round(96 * Math.sqrt(sf)));
  let m = revolve(clean, { segments: segs, check: false });
  const cutters = [];
  if (s.flangeHoles > 0) {
    const rMid = (g.rH + g.rF) / 2;
    const rHole = Math.min((g.rF - g.rH) / 3, TAU * rMid / (2.6 * s.flangeHoles));
    if (rHole > 0.8) {
      for (let i = 0; i < s.flangeHoles; i++) {
        const a = TAU * i / s.flangeHoles;
        const x = rMid * Math.cos(a), y = rMid * Math.sin(a);
        cutters.push(cylinderZ(rHole, H + 2, Math.max(12, Math.round(20 * Math.sqrt(sf)))).translate(x, y, -1));
      }
    }
  }
  if (cutters.length) m = subtractAll(m, cutters);
  return { mesh: m.place(), meta: { dims: spoolDims(s, m.bbox(), s.raw) } };
}

/** A capped cylinder along +Z from z=0, built here so the spool needs no extra import. */
function cylinderZ(r, h, segs) {
  const n = Math.max(8, Math.round(segs));
  return extrude([circle(r, { segs: n })], h, { check: false });
}

function build(p, ctx = {}) {
  const s = layout(p, ctx);
  if (s.type === 'spool') return buildSpool(s);

  let ring, extra = null;
  if (s.type === 'jhook') ring = profileJHook(s, s.sf);
  else if (s.type === 'wallhook') ring = profileWallHook(s, s.sf);
  else if (s.type === 'hanger') ring = profileHanger(s, s.sf);
  else if (s.type === 'clip') { extra = profileClip(s, s.sf); ring = extra.ring; }
  else if (s.type === 'bracket') ring = profileBracket(s, s.sf);
  else { extra = profileComb(s, s.sf); ring = extra.ring; }

  // The fillet radius has to stay smaller than half the narrowest gap in the
  // profile, or the rounding closes the very opening the part exists for.
  let f = s.fillet;
  if (s.type === 'clip') f = Math.min(f, Math.max(0.2, extra.opening / 2 - 0.5), s.wall * 0.9);
  if (s.type === 'comb') f = Math.min(f, Math.max(0.2, extra.throat / 2 - 0.4), s.toothW / 2 - 0.1);
  if (HOOKISH.includes(s.type)) f = Math.min(f, s.stock * 0.9);
  ring = filletProfile(ring, f, s.sf);
  s.filletUsed = f;
  s.profile = ring;

  const { mesh: body, chamfer } = prism(ring, s.width, s.chamferWant);
  s.chamfer = chamfer;

  const cutters = [];
  for (const fst of s.fasteners) {
    cutters.push(fastenerCutter(fst, s.sf));
    if (s.nutPocket && fst.nutAF + NUT_SLOP + 1.6 <= s.width && fst.thru > fst.nutT + 1.2) {
      cutters.push(nutCutter(fst, s.sf));
    }
  }
  if (s.padSpec) {
    cutters.push(padCutter({
      w: s.padSpec.localW, h: s.padSpec.localH, depth: s.padSpec.depth,
      cy: s.padSpec.cy, cx: s.padSpec.cx, cz: s.padSpec.cz,
    }, s.padSpec.axis, s.sf));
  }

  const out = cutters.length ? subtractAll(body, cutters) : body;
  return { mesh: out.place(), meta: { dims: profileDims(s, extra, out.bbox(), s.raw) } };
}

// ---------------------------------------------------------------------------
// Dimension callouts. Every coordinate is worked out in the profile frame from
// the same numbers the profile functions use, then shifted by the unplaced
// bbox exactly as place() shifts the mesh, so the callouts land on the placed
// object. The prismatic types lie on their side: the profile is the XY plane
// and the part's width stands up in Z, so most callouts sit on the top face.
// ---------------------------------------------------------------------------

const SQ2 = Math.SQRT1_2;

/**
 * The centre and mid-arc point of the fillet roundedPath() puts at a concave
 * corner `cur`, arriving along unit direction d1 and leaving along d2 — the
 * same construction as the kernel's, so the callout sits on the arc it drew.
 */
function filletAt(cur, d1, d2, r) {
  const dot = -(d1[0] * d2[0] + d1[1] * d2[1]);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  let bx = d2[0] - d1[0], by = d2[1] - d1[1];
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl; by /= bl;
  const cd = r / Math.sin(theta / 2);
  const c = [cur[0] + bx * cd, cur[1] + by * cd];
  return { c, mid: [c[0] - bx * r, c[1] - by * r] };
}

/**
 * A callout names its parameter, and the figure written on it is the distance
 * between its ends — which is the built length, not the asked-for one, wherever
 * layout() snapped or clamped the number (a wall to whole extrusions, a chamfer
 * to the profile's smallest radius). Declaring `value` in that case makes the
 * disagreement explicit rather than letting the harness flag it as a mistake.
 */
function realValue(p, key, len) {
  const asked = Number(p && p[key]);
  return Number.isFinite(asked) && Math.abs(len - asked) > 0.02 ? { value: len } : {};
}

function profileDims(s, extra, b, p) {
  const P = (x, y, z) => [x - b.center[0], y - b.center[1], z - b.min[2]];
  const dims = [];
  // Offsets are directions whose length the viewer turns into pixels at the
  // fitted scale, so they are given in tenths of the object's span, not in mm.
  const o = Math.max(b.size[0], b.size[1], b.size[2]) * 0.1;
  const D = (param, label, from, to, offset) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    dims.push({ param, label, from, to, offset: offset.map(v => v * o), ...realValue(p, param, len) });
  };
  const w = s.width, t = s.stock, half = t / 2, c = s.chamfer, f = s.filletUsed;
  const type = s.type;
  const plateH = type === 'clip' ? Math.max(s.plateH, 2 * extra.cy) : s.plateH;

  // The back plate: thickness across its top end, height up its back.
  if (PLATED.includes(type) && type !== 'comb') {
    const isBracket = type === 'bracket';
    const top = isBracket ? s.legV : plateH;
    D('plateT', isBracket ? 'wall leg' : 'plate', P(0, top, w), P(s.plateT, top, w), [0, 1, 0]);
    if (!isBracket) D('plateH', 'plate', P(0, 0, w), P(0, plateH, w), [-1.3, 0, 0]);
  }

  // The edge break, on the bottom edge of the top face where the chamfer is in
  // plain view. Each type has a different bottom edge, so pick a point on it.
  if (c > 0.05) {
    const x = type === 'comb' ? 0 : type === 'bracket' ? s.legH / 2 : s.plateT / 2;
    D('chamfer', 'edge', P(x, 0, w - c), P(x, 0, w), [0, -1, 0]);
  }

  // A slot's travel is the distance between its two end centres, on the face
  // the head bears on.
  // The highest one: on a bracket the lowest sits behind the web.
  const slotF = s.fasteners.filter(q => q.axis === 'x' && q.slotLen > 0).sort((u, v) => v.at - u.at)[0];
  if (slotF) {
    D('slotTravel', 'slot', P(s.plateT, slotF.at - slotF.slotLen / 2, w / 2), P(s.plateT, slotF.at + slotF.slotLen / 2, w / 2), [1, 0, 0]);
  }

  if (type === 'jhook') {
    const R = s.bendR, cx = s.reach - R, cy = half + R;
    const a0 = -Math.PI / 2, a1 = a0 + s.sweep, am = a0 + s.sweep / 2;
    const xm = (s.plateT + cx) / 2;
    D('stock', 'arm', P(xm, 0, w), P(xm, t, w), [0, -1.3, 0]);
    D('reach', 'reach', P(0, cy, w), P(s.reach, cy, w), [0, 0, 1.3]);
    D('bendR', 'R', P(cx, cy, w), P(cx + R * Math.cos(am), cy + R * Math.sin(am), w), [0, 0, 1]);
    if (s.tipLen > 0.2) {
      const ex = cx + R * Math.cos(a1), ey = cy + R * Math.sin(a1);
      const tx = -Math.sin(a1), ty = Math.cos(a1);
      D('tipLen', 'tip', P(ex, ey, w), P(ex + tx * s.tipLen, ey + ty * s.tipLen, w), [Math.cos(a1), Math.sin(a1), 0]);
    }
    if (f > 0.05) {
      const fl = filletAt([s.plateT, t], [-1, 0], [0, 1], f);
      D('fillet', 'R', P(fl.c[0], fl.c[1], w), P(fl.mid[0], fl.mid[1], w), [0, 0, 1]);
    }
  } else if (type === 'wallhook') {
    const rootH = clamp(s.plateH * 0.42, t * 1.4, s.plateH - 2);
    const tipY = Math.min(rootH + s.rise, s.plateH - 1);
    const reach = Math.max(s.reach, s.plateT + t + 1);
    const rampBotTip = Math.max(tipY - t, 0.6);
    const ym = (rampBotTip + tipY) / 2;
    D('reach', 'reach', P(0, ym, w), P(reach, ym, w), [0, 0, 1.3]);
    D('rise', 'rise', P(reach, rootH, w), P(reach, tipY, w), [1.3, 0, 0]);
    // The lip, built exactly as profileWallHook builds it.
    const dirx = reach, diry = tipY - rootH, dl = Math.hypot(dirx, diry) || 1;
    const ang = Math.atan2(diry, dirx);
    const R = Math.max(s.bendR, half + 0.4);
    const start = [reach - t * 0.6 * (dirx / dl), tipY - half];
    const cx = start[0] - R * Math.sin(ang), cy = start[1] + R * Math.cos(ang);
    const a0 = ang - Math.PI / 2, sw = Math.max(s.sweep * 0.55, 45 * DEG);
    const a1 = a0 + sw / 2, a2 = a0 + sw * 0.8;
    D('stock', 'lip', P(cx + (R - half) * Math.cos(a1), cy + (R - half) * Math.sin(a1), w),
      P(cx + (R + half) * Math.cos(a1), cy + (R + half) * Math.sin(a1), w), [Math.cos(a1), Math.sin(a1), 0]);
    D('bendR', 'R', P(cx, cy, w), P(cx + R * Math.cos(a2), cy + R * Math.sin(a2), w), [0, 0, 1]);
    if (f > 0.05) {
      const fl = filletAt([s.plateT, rootH + Math.tan(ang) * s.plateT], [-Math.cos(ang), -Math.sin(ang)], [0, 1], f);
      D('fillet', 'R', P(fl.c[0], fl.c[1], w), P(fl.mid[0], fl.mid[1], w), [0, 0, 1]);
    }
  } else if (type === 'hanger') {
    const Rc = Math.max(s.cradleR, s.reach * 0.9);
    const psi = Math.min(s.reach / Rc, 75 * DEG);
    const c0x = s.plateT * 0.5, c0y = half + Rc;
    const am = -Math.PI / 2 + psi / 2;
    D('stock', 'arm', P(c0x + (Rc - half) * Math.cos(am), c0y + (Rc - half) * Math.sin(am), w),
      P(c0x + (Rc + half) * Math.cos(am), c0y + (Rc + half) * Math.sin(am), w), [0, -1.3, 0]);
    const dx = Math.min(s.reach - c0x, Rc * Math.sin(psi));
    const yc = c0y - Math.sqrt(Math.max(0, Rc * Rc - dx * dx));
    D('reach', 'reach', P(0, yc, w), P(s.reach, yc, w), [0, 0, 1.3]);
    D('cradleR', 'R', P(c0x, c0y, w), P(c0x + Rc * Math.cos(am), c0y + Rc * Math.sin(am), w), [1, 0, 0]);
    const end = [c0x + Rc * Math.cos(-Math.PI / 2 + psi), c0y + Rc * Math.sin(-Math.PI / 2 + psi)];
    const R = Math.max(s.bendR, half + 0.4);
    const lx = end[0] - R * Math.sin(psi), ly = end[1] + R * Math.cos(psi);
    const a0 = psi - Math.PI / 2, al = a0 + Math.max(s.sweep * 0.7, 50 * DEG) / 2;
    D('bendR', 'R', P(lx, ly, w), P(lx + R * Math.cos(al), ly + R * Math.sin(al), w), [0, 0, 1]);
    if (f > 0.05) {
      const fl = filletAt([s.plateT, t], [-1, 0], [0, 1], f);
      D('fillet', 'R', P(fl.c[0], fl.c[1], w), P(fl.mid[0], fl.mid[1], w), [0, 0, 1]);
    }
  } else if (type === 'clip') {
    const { cx, cy, rc } = extra, cd = s.cableDia;
    D('cableDia', 'cable Ø', P(cx - cd / 2, cy, w), P(cx + cd / 2, cy, w), [0, 0, 1]);
    D('clearance', 'clearance', P(cx, cy - cd / 2, w), P(cx, cy - rc, w), [0, 0, 1]);
    // The wall on the far side of the C, pushed away from it, so the figure
    // lands on empty background rather than on the top face.
    D('wall', 'wall', P(cx, cy + rc, w), P(cx, cy + rc + s.wall, w), [0, 1, 0]);
  } else if (type === 'bracket') {
    const tV = s.plateT, tH = t;
    const g = Math.max(0, Math.min(s.gusset, s.legV - tH - 1.5, s.legH - tV - 1.5));
    D('stock', 'shelf leg', P(s.legH, 0, w), P(s.legH, tH, w), [1, 0, 0]);
    if (g > 0.5 && s.gussetStyle !== 'none') D('gusset', 'web', P(tV, tH, w), P(tV + g, tH, w), [0, 0, 1.3]);
    if (f > 0.05 && s.gussetStyle !== 'curved') {
      const corner = (g > 0.5 && s.gussetStyle === 'straight') ? [tV + g, tH] : [tV, tH];
      const d2 = corner[0] > tV + 1e-9 ? [-SQ2, SQ2] : [0, 1];
      const fl = filletAt(corner, [-1, 0], d2, f);
      D('fillet', 'R', P(fl.c[0], fl.c[1], w), P(fl.mid[0], fl.mid[1], w), [0, 0, 1]);
    }
  } else if (type === 'comb') {
    const { barLen, rc } = extra, cd = s.cableDia;
    const hx = barLen / 2, pitch = 2 * rc + s.toothW;
    const yb = s.combBase + rc;
    const xc = (i) => -hx + s.toothW + rc + i * pitch;
    D('cableDia', 'cable Ø', P(xc(0) - cd / 2, yb, w), P(xc(0) + cd / 2, yb, w), [0, 0, 1]);
    D('clearance', 'clearance', P(xc(0), yb - cd / 2, w), P(xc(0), yb - rc, w), [-1, 0, 0]);
    D('toothW', 'tooth', P(xc(0) + rc, yb, w), P(xc(0) + rc + s.toothW, yb, w), [0, 0, 1]);
    D('combBase', 'base', P(-hx, 0, w), P(-hx, s.combBase, w), [-1, 0, 0]);
    if (s.slots >= 2) D('slots', 'pitch', P(xc(0), yb, w), P(xc(1), yb, w), [0, 0, 1.3]);
  }
  return dims;
}

function spoolDims(s, b, p) {
  const P = (x, y, z) => [x - b.center[0], y - b.center[1], z - b.min[2]];
  const g = s.spoolGeom, H = s.spoolH, ft = s.flangeT;
  const o = Math.max(b.size[0], b.size[1], b.size[2]) * 0.1;
  const dims = [
    { param: 'hubDia', label: 'Ø hub', from: P(-g.rH, 0, H / 2), to: P(g.rH, 0, H / 2), offset: [0, -o, 0], ...realValue(p, 'hubDia', 2 * g.rH) },
    { param: 'flangeT', label: 'flange', from: P(g.rF, 0, H - ft), to: P(g.rF, 0, H), offset: [1.3 * o, 0, 0], ...realValue(p, 'flangeT', ft) },
  ];
  if (g.rB > 0.2) dims.push({ param: 'boreDia', label: 'Ø bore', from: P(-g.rB, 0, H), to: P(g.rB, 0, H), offset: [0, 0, o], ...realValue(p, 'boreDia', 2 * g.rB) });
  return dims;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validate(p, ctx = {}) {
  const s = layout(p, ctx);
  const out = [];
  const bed = ctx.bed || { x: 180, y: 180, z: 180 };
  const err = (param, message) => out.push({ param, severity: 'error', message });
  const warn = (param, message) => out.push({ param, severity: 'warn', message });
  const info = (param, message) => out.push({ param, severity: 'info', message });

  // 1. Walls in whole extrusions.
  const ew = s.ew;
  if (Math.abs(p.wall - s.wall) > ew * 0.2 && typeof p.wall === 'number') {
    info('wall', `wall rounded from ${num(p.wall, 0).toFixed(2)} to ${s.wall.toFixed(2)} mm — ${Math.round(s.wall / ew)} extrusions at a ${ew} mm nozzle. A part-extrusion wall is filled with gap-fill zigzag, which is weaker than the whole number either side of it`);
  }
  if (s.type !== 'spool' && s.width < 2 * s.ew * 3) {
    err('width', `${s.width.toFixed(1)} mm is under three extrusions wide; there is no part here, only a smear`);
  }

  // 2. Bed.
  const est = estimateSize(s);
  if (est.x > bed.x || est.y > bed.y || est.z > bed.z) {
    err(est.worst, `about ${est.x.toFixed(0)} × ${est.y.toFixed(0)} × ${est.z.toFixed(0)} mm will not fit the ${bed.x} × ${bed.y} × ${bed.z} mm bed`);
  }

  // 3. The snap-fit clip: does it grip, and can the arms reach the open position
  //    without yielding? Cantilever snap-fit strain, e = 1.5 * t * y / L^2.
  if (s.type === 'clip') {
    const g = profileClip(s, 1);
    const ratio = g.opening / s.cableDia;
    if (ratio > 0.95) {
      err('grip', `the mouth is ${(ratio * 100).toFixed(0)} % of the cable diameter — above 95 % the cable falls straight back out. 70-90 % is the useful band`);
    } else if (ratio < 0.70) {
      err('grip', `the mouth is only ${(ratio * 100).toFixed(0)} % of the cable diameter. Below 70 % the arms have to spread further than PLA will bend and the clip splits at the root on first use`);
    }
    const armLen = g.Rc * (TAU - 2 * g.gapHalf) / 2;
    const y = (s.cableDia - g.opening) / 2;
    const strain = 1.5 * s.wall * y / (armLen * armLen);
    if (strain > 0.03) {
      err('wall', `snapping a ${s.cableDia} mm cable past a ${g.opening.toFixed(1)} mm mouth strains the arm root to ${(strain * 100).toFixed(1)} % — PLA cracks somewhere around 2-3 %. Thin the wall, widen the mouth, or print it in PETG`);
    } else if (strain > 0.02) {
      warn('wall', `arm root strain is ${(strain * 100).toFixed(1)} % on insertion, which is at the edge of what PLA tolerates repeatedly. PETG or a slightly wider mouth would make it reusable`);
    }
    if (s.clearance < 0.15) {
      warn('clearance', 'under 0.15 mm of clearance the cable will not slide in the clip at all once the layer lines are on the bore');
    }
  }

  // 4. The comb.
  if (s.type === 'comb') {
    const g = profileComb(s, 1);
    const ratio = g.throat / s.cableDia;
    if (ratio > 0.95) err('grip', `the throat is ${(ratio * 100).toFixed(0)} % of the cable — the cables will lift straight back out`);
    if (s.toothW < 2 * ew * 2) err('toothW', `a ${s.toothW.toFixed(1)} mm tooth is under four extrusions wide and will snap off the first time a cable is pulled sideways`);
    if (g.barLen > Math.min(bed.x, bed.y)) err('slots', `${s.slots} slots at ${(2 * (s.cableDia / 2 + s.clearance) + s.toothW).toFixed(1)} mm pitch makes a ${g.barLen.toFixed(0)} mm bar, longer than the bed`);
  }

  // 5. Fasteners.
  if (s.droppedHoles > 0) {
    err('screw', `an ${s.screw} clearance hole is ${(s.rBore * 2).toFixed(1)} mm across and the part is only ${s.width.toFixed(1)} mm wide, so no holes were cut. Widen the part, drop to a smaller screw, or mount it with adhesive`);
  }
  if (s.flatHeads > 0) {
    warn('head', `the ${s.screw} head recess does not fit inside a ${s.width.toFixed(1)} mm width, so those holes were left plain — the screw head will stand proud of the face`);
  }
  for (const f of s.fasteners) {
    if (s.cone && f.csDepth > 0 && f.rHead * 2 < SCREWS[s.screw].head + HEAD_SLOP - 0.05) {
      warn('plateT', `${f.thru.toFixed(1)} mm of material cannot take a full ${s.screw} countersink (it needs ${(((SCREWS[s.screw].head + HEAD_SLOP) / 2 - f.rBore) / Math.tan(s.cone / 2 * DEG)).toFixed(1)} mm plus ${MIN_MEAT} mm under it), so the cone was shortened and the head will sit about ${(((SCREWS[s.screw].head + HEAD_SLOP) / 2 - f.rHead) / Math.tan(s.cone / 2 * DEG)).toFixed(1)} mm proud`);
      break;
    }
  }
  if (s.nutPocket && s.fasteners.length && SCREWS[s.screw].nutAF + NUT_SLOP + 1.6 > s.width) {
    warn('nutPocket', `an ${s.screw} nut is ${SCREWS[s.screw].nutAF} mm across the flats and the part is ${s.width.toFixed(1)} mm wide — there is no room for the pocket, so none was cut`);
  }
  if (s.mount === 'none' && s.type !== 'spool') {
    info('mount', 'no mounting features at all — useful if you are gluing it to something, otherwise pick screws or a pad');
  }

  // 6. Adhesive.
  if ((s.mount === 'adhesive' || s.mount === 'both') && PLATED.includes(s.type)) {
    if (!s.padSpec) {
      err('pad', `the ${s.padWanted ? `${s.padWanted.w} × ${s.padWanted.h} mm` : ''} pad does not fit this back plate, or the ${s.padDepth} mm recess is deeper than the plate is thick. Nothing was recessed`);
    } else if (s.padSpec.clipped) {
      warn('pad', `the pad recess was trimmed to ${s.padSpec.w.toFixed(0)} × ${s.padSpec.h.toFixed(0)} mm to stay inside the plate — the pad will overhang the recess`);
    }
    if (HOOKISH.includes(s.type)) {
      const lever = s.reach / Math.max(1, s.plateH);
      if (lever > 0.8) {
        warn('reach', `reaching ${s.reach.toFixed(0)} mm off a ${s.plateH.toFixed(0)} mm plate gives a peel ratio of ${lever.toFixed(1)}:1. Adhesive pads fail in peel long before they fail in shear — either shorten the reach or make the plate taller`);
      }
    }
  }

  // 7. The spool.
  if (s.type === 'spool') {
    const g = s.spoolGeom;
    if (g.overhangDeg > 50) {
      err('spoolH', `the top flange overhangs at ${g.overhangDeg.toFixed(0)}° from vertical because there is only ${((s.spoolH - 2 * s.flangeT) / 2).toFixed(1)} mm of height for a ${(g.rF - g.rH).toFixed(1)} mm cone. It will need support inside the spool, where you cannot get at it. Make it taller, or the flange smaller`);
    } else if (g.overhangDeg > 44) {
      info('spoolH', `the flange cones sit at ${g.overhangDeg.toFixed(0)}° from vertical — right on the limit, and support-free`);
    }
    if (g.rH - g.rB < 2 * ew * 2) {
      err('hubDia', `the hub wall is only ${(g.rH - g.rB).toFixed(1)} mm between the bore and the outside — under four extrusions, and the spool will split along the bore`);
    }
    if (g.rF - g.rH < 2) warn('flangeDia', 'the flanges barely stand above the hub; there is nothing to keep the cable on');
  }

  // 8. Load path, stated as a rule rather than a measurement.
  if (HOOKISH.includes(s.type) && s.fasteners.length) {
    const lowest = Math.min(...s.fasteners.map(f => f.at));
    if (lowest < s.stock) {
      warn('holes', 'a fastener sits level with or below the arm. The load tries to rotate the plate off the wall about its bottom edge, so the screws want to be above the arm, not beside it');
    }
  }
  if (HOOKISH.includes(s.type) && s.stock < 3 * ew) {
    err('stock', `a ${s.stock.toFixed(1)} mm arm is under ${Math.ceil(3 * ew * 10) / 10} mm of material at the root; it is a tab, not a hook`);
  }
  if (s.type === 'bracket' && s.gussetStyle === 'none' && s.legH > 3 * s.plateT) {
    warn('gussetStyle', `a ${s.legH.toFixed(0)} mm arm off a ${s.plateT.toFixed(1)} mm leg with no web puts everything into one filleted corner. Add a gusset unless the load is trivial`);
  }
  if (s.fillet < 1 && s.type !== 'comb') {
    warn('fillet', `a ${s.fillet.toFixed(1)} mm root fillet is small. The inside corner is where a printed hook cracks, and the crack starts at the sharpest radius you gave it`);
  }
  return out;
}

/** Rough overall size without building the mesh, for the bed check. */
function estimateSize(s) {
  if (s.type === 'spool') return { x: s.flangeDia, y: s.flangeDia, z: s.spoolH, worst: 'flangeDia' };
  let x = s.plateT, y = s.plateH, worst = 'plateH';
  if (s.type === 'bracket') { x = s.legH; y = s.legV; worst = s.legH > s.legV ? 'legH' : 'legV'; }
  else if (s.type === 'comb') {
    const g = s.combGeom || profileComb(s, 1);
    x = g.barLen; y = g.barH; worst = 'slots';
  } else if (HOOKISH.includes(s.type)) {
    x = s.reach + s.bendR + s.stock; y = Math.max(s.plateH, 2 * s.bendR + s.tipLen + s.stock);
    worst = x > y ? 'reach' : 'plateH';
  } else if (s.type === 'clip') {
    x = s.plateT + 2 * (s.cableDia / 2 + s.clearance) + 2 * s.wall;
    y = Math.max(s.plateH, s.cableDia + 2 * s.wall + 2 * s.clearance);
    worst = 'cableDia';
  }
  return { x, y, z: s.width, worst };
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

const ORIENTATION = {
  jhook: 'Lying on its side, exactly as Bluesheet hands it to you: the whole side profile flat on the plate, the width standing up in Z. Do not stand it up on the back plate — that lays every layer line straight across the root and the arm snaps off along one of them at maybe a third of the load.',
  wallhook: 'On its side, as generated. The ramp is a solid section printed along its length, which is the only orientation in which a hook this short is stronger than the pad holding it up.',
  hanger: 'On its side, as generated. The saddle then carries the band across the extrusions rather than across the bonds between them, and the two chamfered edges are the ones the padding rests on.',
  clip: 'As generated: the cable axis is vertical, the C lying open-side sideways. The arms then flex in the plane of the layers, where the material is at full strength — flexing a snap-fit across layer lines is how printed clips lose an arm on the second cable.',
  bracket: 'On its side, as generated, with the web flat on the plate. This is the whole reason a printed bracket can be trusted: the load runs down the web along continuous extrusions, and there is no layer boundary anywhere in the load path.',
  comb: 'As generated, the slots opening sideways. The teeth then flex in-plane, and the slot bottoms are printed as curves rather than as stepped bridges.',
  spool: 'Axis vertical, one flange flat on the plate — as generated. The flange undersides are coned so nothing needs support inside the spool, which is the one place you could not remove it from.',
};

function hints(p, ctx = {}) {
  const s = layout(p, ctx);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const ew = s.ew;
  const notes = [];
  const perims = Math.max(2, Math.round(s.wall / ew));

  notes.push(`Orientation: ${ORIENTATION[s.type]}`);

  if (s.type === 'spool') {
    notes.push(`Walls ${Math.max(3, perims)}, infill 15 % gyroid, top and bottom 4 layers. The flanges are thin plates in bending — the wall count does far more for them than the infill does.`);
  } else {
    notes.push(`Walls ${Math.max(3, perims)} at ${ew.toFixed(2)} mm. Infill 40-50 % gyroid or cubic: this is a small part where the walls do most of the work, but the root is thicker than the walls can fill on their own.`);
    notes.push(`Because it prints on its side, the first layer is the entire silhouette — ${estimateFootprint(s).toFixed(0)} mm² of bed contact. No brim needed, and no supports anywhere on this part.`);
  }
  notes.push(`Layer height ${layerH.toFixed(2)} mm. Nothing here is cosmetic enough to want 0.12, and a thicker layer is a stronger layer: fewer bonds through the load path.`);

  if (s.fasteners.length) {
    const f = s.fasteners[0];
    if (f.coneDeg) {
      notes.push(`${s.fasteners.length} × ${s.screw} countersunk, ${f.coneDeg}° included angle, ${f.csDepth.toFixed(1)} mm deep. Printed on its side the cone's steepest line is ${(90 - f.coneDeg / 2).toFixed(0)}° from vertical, so it needs no support; the bore itself has a teardrop roof so it comes out round-ish instead of drooping shut.`);
    } else if (f.cbore > 0) {
      notes.push(`${s.fasteners.length} × ${s.screw} socket cap, counterbored ${f.cbore.toFixed(1)} mm. The counterbore floor is a vertical face in this orientation, so it prints flat and the head seats square.`);
    } else {
      notes.push(`${s.fasteners.length} × ${s.screw} plain clearance holes at ${(2 * s.rBore).toFixed(1)} mm — the nominal clearance plus ${HOLE_SLOP} mm, because an FDM hole always comes out under size.`);
    }
    if (s.slotted) notes.push(`The holes are slots with ${s.slotTravel.toFixed(0)} mm of travel, so the part can be levelled after the screws are in the wall. Slot roofs are short flat bridges here; no support, but do not turn the fan off.`);
    if (s.nutPocket) notes.push('The nut pockets open upward in this orientation: drop an ' + s.screw + ' nut in at the last layer of the pocket (pause the print) or slide it in afterwards. No bridging, no support.');
  }
  if (s.padSpec) {
    notes.push(`Adhesive recess ${s.padSpec.w.toFixed(0)} × ${s.padSpec.h.toFixed(0)} mm, ${s.padSpec.depth.toFixed(1)} mm deep (${s.padSpec.label}). Set the depth 0.2-0.3 mm SHALLOWER than the pad so the pad stands proud and actually gets squeezed; a pad sunk flush carries nothing and the plate rocks on its own rim.`);
    notes.push('The recess floor is a vertical wall in this orientation, so it carries layer lines. That is fine — foam pads conform to them — but degrease it and press for thirty seconds, and give it an hour before hanging anything.');
  }
  if (s.chamfer > 0.05) notes.push(`Both Z faces are chamfered ${s.chamfer.toFixed(2)} mm, which removes the elephant foot from the biggest face on the part and takes the arris off the edge things rest on.`);

  const mat = s.type === 'clip' ? 'PETG' : 'PLA';
  notes.push(mat === 'PETG'
    ? 'PETG, not PLA. A snap-fit needs to bend and come back; PLA at 2-3 % strain does not come back, it cracks. PETG will take four or five times that, and the parts here are small enough that its stringing does not matter.'
    : 'PLA is fine and stiffer than PETG. If the part will live in a car, a conservatory or anywhere that sees 50 °C, print it in PETG instead — PLA creeps under a steady load long before it breaks.');

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.26 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: mat,
    supports: false,
    layerH,
    walls: Math.max(3, perims),
    infill: s.type === 'spool' ? 15 : 45,
    orientation: ORIENTATION[s.type],
    estGrams: Math.round(estimateVolume(s) / 1000 * 1.24 * 10) / 10,
    notes,
  };
}

function estimateFootprint(s) {
  if (s.type === 'spool') return Math.PI * (s.flangeDia / 2) ** 2;
  try {
    const r = profileFor(s);
    return ringArea(r);
  } catch { return estimateSize(s).x * estimateSize(s).y * 0.5; }
}

function estimateVolume(s) {
  if (s.type === 'spool') {
    const g = s.spoolGeom;
    const flanges = 2 * Math.PI * (g.rF ** 2 - g.rB ** 2) * s.flangeT;
    const hub = Math.PI * (g.rH ** 2 - g.rB ** 2) * g.hubLen;
    return flanges + hub;
  }
  return estimateFootprint(s) * s.width * 0.92;
}

/** The finished 2D profile for a settings object — used by hints and by the tests. */
export function profileFor(s) {
  let ring, extra = null;
  if (s.type === 'jhook') ring = profileJHook(s, s.sf);
  else if (s.type === 'wallhook') ring = profileWallHook(s, s.sf);
  else if (s.type === 'hanger') ring = profileHanger(s, s.sf);
  else if (s.type === 'clip') { extra = profileClip(s, s.sf); ring = extra.ring; }
  else if (s.type === 'bracket') ring = profileBracket(s, s.sf);
  else if (s.type === 'comb') { extra = profileComb(s, s.sf); ring = extra.ring; }
  else throw new Error('hooks: the spool has no 2D profile');
  let f = s.fillet;
  if (s.type === 'clip') f = Math.min(f, Math.max(0.2, extra.opening / 2 - 0.5), s.wall * 0.9);
  if (s.type === 'comb') f = Math.min(f, Math.max(0.2, extra.throat / 2 - 0.4), s.toothW / 2 - 0.1);
  if (HOOKISH.includes(s.type)) f = Math.min(f, s.stock * 0.9);
  return filletProfile(ring, f, s.sf);
}

export { profileClip, profileComb, SCREWS, PADS, HOLE_SLOP, HEAD_SLOP, minConvexRadius };

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const TYPE_IDS = ['jhook', 'clip', 'wallhook', 'bracket', 'hanger', 'comb', 'spool'];

export default {
  id: 'hooks',
  name: 'Hooks & Wall Hardware',
  category: 'Utility',
  blurb: 'Seven small load-bearing things: J-hooks, snap clips, brackets, hangers, combs and spools.',
  description:
    'The family you print because you needed one this afternoon. Every type is engineered rather than shaped: a fillet on every load-bearing root, ' +
    'wall thicknesses snapped to a whole number of extrusions, and — the part that actually decides whether it survives — a print orientation in which ' +
    'the load runs along the extrusions instead of across the bonds between them. The parts come out lying on their sides, which is how they must be ' +
    'sliced. Countersunk holes are cut at a real 82° or 90° cone, bores get teardrop roofs because they are horizontal in that orientation, slots ' +
    'replace holes where you will want to level the thing after the screws are in, and the adhesive recess is sized to a pad you can actually buy.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v11a5 5 0 0 0 10 0V9"/><circle cx="6" cy="3.2" r="1.2"/><path d="M18 4h3v3h-3z"/></svg>',
  version: 1,

  params: [
    { key: 'type', label: 'Type', type: 'enum', def: 'jhook', group: 'Type',
      help: 'Which piece of hardware. Each one is a different shape with its own rules; the shared parameters below apply to whichever is selected.',
      options: [
        { v: 'jhook', label: 'J-hook', help: 'A straight arm out of a back plate with an upturn on the end. Coats, bags, tools, a bike.' },
        { v: 'clip', label: 'Cable clip (snap-on)', help: 'A C that snaps over a cable and holds it. The mouth is set as a fraction of the cable diameter.' },
        { v: 'wallhook', label: 'Adhesive wall hook', help: 'A stiff solid ramp on a plate with a recess for a stick-on pad. Short reach on purpose.' },
        { v: 'bracket', label: 'Screw-mount bracket', help: 'An L with a web. Slots in the wall leg so it can be levelled, holes in the shelf leg.' },
        { v: 'hanger', label: 'Headphone / tool hanger', help: 'A wide saddle on a gently rising arc, so a headband is carried rather than creased.' },
        { v: 'comb', label: 'Cable comb', help: 'A bar of slots with gripping throats and round bottoms. Tidies a bundle into a row.' },
        { v: 'spool', label: 'Cable spool', help: 'Two coned flanges on a hub, with an axle bore. The one type here that is turned rather than extruded.' },
      ] },

    // ---- Size ----
    { key: 'width', label: 'Width', type: 'number', unit: 'mm', min: 6, max: 120, step: 1, def: 18, group: 'Size',
      showIf: (p) => p.type !== 'spool',
      help: 'How wide the part is — and, because it prints on its side, how tall the print is. Wider is stronger in almost exact proportion; it is the cheapest strength there is.' },
    { key: 'wall', label: 'Wall', type: 'number', unit: 'mm', min: 0.8, max: 8, step: 0.4, def: 2.4, group: 'Size',
      help: 'Rounded to a whole number of extrusions. 2.4 mm is six perimeters at a 0.4 nozzle — solid material, no infill, nothing for the slicer to guess about.',
    // Measured: of the seven types only the clip is sized by this. A control that
    // does nothing for six of seven is worse than no control.
    showIf: (p) => p.type === 'clip' },
    { key: 'fillet', label: 'Root fillet', type: 'number', unit: 'mm', min: 0, max: 12, step: 0.5, def: 2.5, group: 'Size',
      help: 'The radius put on every corner of the profile. The inside corner where the arm meets the plate is where a printed hook cracks; this is the single number that decides how soon.' },
    { key: 'chamfer', label: 'Edge break', type: 'number', unit: 'mm', min: 0, max: 2, step: 0.1, def: 0.6, group: 'Size',
      help: 'Chamfer on the two faces that sit against the bed and the air. Kills the elephant foot on the largest face of the part and takes the edge off whatever rests on it.' },

    // ---- Back plate ----
    { key: 'plateT', label: 'Plate thickness', type: 'number', unit: 'mm', min: 1.2, max: 15, step: 0.4, def: 3.2, group: 'Back plate',
      showIf: (p) => p.type !== 'spool' && p.type !== 'comb',
      help: 'Thickness of the part that meets the wall. It also sets how deep a countersink will fit: an M4 90° cone needs 1.8 mm plus something under it.',
    // Capped at 15, not 16: on the J-hook at the default plate height the shank
    // meets the plate exactly tangentially somewhere above 15.6 mm and two edges
    // come out non-manifold. Narrow, but a maximum that cannot be built is not a
    // maximum. The tangency itself is recorded in gates/G09-hooks.md.
  },
    { key: 'plateH', label: 'Plate height', type: 'number', unit: 'mm', min: 8, max: 150, step: 1, def: 45, group: 'Back plate',
      showIf: (p) => ['jhook', 'clip', 'wallhook', 'hanger'].includes(p.type),
      help: 'How far the plate rises above the arm. Taller means the fasteners sit further above the load, which is what turns a pull-out into a shear.' },

    // ---- Hook ----
    { key: 'reach', label: 'Reach', type: 'number', unit: 'mm', min: 4, max: 100, step: 1, def: 26, group: 'Hook',
      showIf: (p) => ['jhook', 'wallhook', 'hanger'].includes(p.type),
      help: 'How far out from the wall the hook goes. Every millimetre of reach is a millimetre of lever arm on the fixing, so keep it as short as the thing being hung allows.' },
    { key: 'stock', label: 'Arm thickness', type: 'number', unit: 'mm', min: 1.2, max: 20, step: 0.4, def: 5, group: 'Hook',
      showIf: (p) => ['jhook', 'wallhook', 'hanger', 'bracket'].includes(p.type),
      help: 'The bar the hook is made of — or, on the bracket, the thickness of the shelf leg. Rounded to whole extrusions.' },
    { key: 'bendR', label: 'Upturn radius', type: 'number', unit: 'mm', min: 1, max: 45, step: 0.5, def: 9, group: 'Hook',
      showIf: (p) => ['jhook', 'wallhook', 'hanger'].includes(p.type),
      help: 'Centreline radius of the curl at the end. Bigger radius, gentler curve, less chance of a strap being creased in it.' },
    { key: 'sweepDeg', label: 'Upturn sweep', type: 'number', unit: '°', min: 30, max: 240, step: 5, def: 150, group: 'Hook',
      showIf: (p) => ['jhook', 'wallhook', 'hanger'].includes(p.type),
      help: 'How far round the curl goes. 90° is an open lip, 180° is a closed J that will not let go, past 200° it starts to close the mouth up.' },
    { key: 'tipLen', label: 'Tip extension', type: 'number', unit: 'mm', min: 0, max: 30, step: 1, def: 4, group: 'Hook',
      showIf: (p) => p.type === 'jhook',
      help: 'A straight run on the end of the curl. A little of it makes the hook much harder to shake something off.' },
    { key: 'rise', label: 'Ramp rise', type: 'number', unit: 'mm', min: 1, max: 60, step: 1, def: 9, group: 'Hook',
      showIf: (p) => p.type === 'wallhook',
      help: 'How much higher the tip of the ramp is than its root. This is what stops a keyring sliding back down the slope.' },
    { key: 'cradleR', label: 'Cradle radius', type: 'number', unit: 'mm', min: 12, max: 400, step: 5, def: 90, group: 'Hook',
      showIf: (p) => p.type === 'hanger',
      help: 'Radius of the gentle arc the saddle follows. Large is right: a headband wants to be carried on a long curve, not folded over a corner.' },

    // ---- Cable ----
    { key: 'cableDia', label: 'Cable diameter', type: 'number', unit: 'mm', min: 1, max: 40, step: 0.5, def: 5, group: 'Cable',
      showIf: (p) => ['clip', 'comb'].includes(p.type),
      help: 'Measured over the outer sheath. A USB-C lead is about 4 mm, mains flex 6-8 mm, a kettle lead 8-9 mm.' },
    { key: 'grip', label: 'Mouth / cable', type: 'number', min: 0.5, max: 1.05, step: 0.01, def: 0.85, group: 'Cable',
      showIf: (p) => ['clip', 'comb'].includes(p.type),
      help: 'The opening as a fraction of the cable diameter. 0.70-0.95 is the band that grips without splitting; 0.85 is the usual answer.' },
    { key: 'clearance', label: 'Bore clearance', type: 'number', unit: 'mm', min: 0, max: 2, step: 0.05, def: FIT.loose, group: 'Cable',
      showIf: (p) => ['clip', 'comb'].includes(p.type),
      help: 'Added to the cable radius so it can move in the clip. Below about 0.15 mm the printed surface finish alone will bind on it.' },
    { key: 'slots', label: 'Slots', type: 'int', min: 1, max: 24, step: 1, def: 6, group: 'Cable',
      showIf: (p) => p.type === 'comb', help: 'How many cables the comb takes. The bar length follows from this and the tooth width.' },
    { key: 'toothW', label: 'Tooth width', type: 'number', unit: 'mm', min: 1.2, max: 20, step: 0.4, def: 4, group: 'Cable',
      showIf: (p) => p.type === 'comb', help: 'Material between one slot and the next. This is the part that flexes when a cable is pushed in, and the part that snaps if it is too thin.' },
    { key: 'combBase', label: 'Base height', type: 'number', unit: 'mm', min: 2, max: 40, step: 1, def: 9, group: 'Cable',
      showIf: (p) => p.type === 'comb', help: 'Solid bar under the slots. It has to be deep enough to take the mounting screws — an M4 countersunk head needs about 8 mm.' },

    // ---- Bracket ----
    { key: 'legV', label: 'Wall leg', type: 'number', unit: 'mm', min: 10, max: 150, step: 1, def: 70, group: 'Bracket',
      showIf: (p) => p.type === 'bracket', help: 'The leg that goes against the wall. Longer spreads the fixings further apart, which is worth more than any amount of extra thickness.' },
    { key: 'legH', label: 'Shelf leg', type: 'number', unit: 'mm', min: 10, max: 150, step: 1, def: 55, group: 'Bracket',
      showIf: (p) => p.type === 'bracket', help: 'The leg the shelf sits on. Keep it a little shorter than the shelf is deep so it does not show.' },
    { key: 'gusset', label: 'Web size', type: 'number', unit: 'mm', min: 0, max: 140, step: 1, def: 40, group: 'Bracket',
      showIf: (p) => p.type === 'bracket', help: 'How far the web runs along each leg. It is the web, not the legs, that carries the moment.' },
    { key: 'gussetStyle', label: 'Web shape', type: 'enum', def: 'curved', group: 'Bracket',
      showIf: (p) => p.type === 'bracket',
      help: 'The shape of the web between the two legs.',
      options: [
        { v: 'curved', label: 'Curved', help: 'A concave inner edge — the classic shelf bracket. Same stiffness for less material and no corner to catch on.' },
        { v: 'straight', label: 'Straight', help: 'A plain triangle. Marginally stiffer, marginally heavier.' },
        { v: 'none', label: 'None', help: 'Just the two legs and the corner fillet. Only for light loads.' },
      ] },

    // ---- Spool ----
    { key: 'flangeDia', label: 'Flange diameter', type: 'number', unit: 'mm', min: 10, max: 170, step: 2, def: 60, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'Outside diameter of the two end discs.' },
    { key: 'hubDia', label: 'Hub diameter', type: 'number', unit: 'mm', min: 6, max: 150, step: 1, def: 24, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'What the cable winds onto. Keep it above about six times the cable diameter or you will set a permanent curl into the lead.' },
    { key: 'boreDia', label: 'Axle bore', type: 'number', unit: 'mm', min: 0, max: 60, step: 1, def: 8, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'Hole through the middle. Printed vertically this one comes out round and slightly under size, so allow half a millimetre.' },
    { key: 'spoolH', label: 'Spool height', type: 'number', unit: 'mm', min: 8, max: 150, step: 1, def: 34, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'Overall height. It has to leave room for both flange cones at 45°, or the top one will need support inside the spool.' },
    { key: 'flangeT', label: 'Flange thickness', type: 'number', unit: 'mm', min: 0.8, max: 12, step: 0.4, def: 2.4, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'Rounded to whole extrusions. A thin flange in bending is all wall and no infill, so this number is the whole strength of it.' },
    { key: 'flangeHoles', label: 'Finger holes', type: 'int', min: 0, max: 12, step: 1, def: 0, group: 'Spool',
      showIf: (p) => p.type === 'spool', help: 'Holes through both flanges, to get a finger in and to save plastic. 0 leaves them solid.' },

    // ---- Mounting ----
    { key: 'mount', label: 'Mounting', type: 'enum', def: 'screws', group: 'Mounting',
      help: 'How it attaches to the wall.',
      options: [
        { v: 'screws', label: 'Screws', help: 'Countersunk or counterbored holes through the plate.' },
        { v: 'adhesive', label: 'Adhesive pad', help: 'A recess sized for a stick-on pad, and no holes.' },
        { v: 'both', label: 'Both', help: 'Pad recess and screw holes — belt and braces on something heavy.' },
        { v: 'none', label: 'None', help: 'No mounting features at all.' },
      ] },
    { key: 'screw', label: 'Screw', type: 'enum', def: 'M4', group: 'Mounting',
      showIf: (p) => p.mount === 'screws' || p.mount === 'both',
      help: 'Metric size. The clearance hole is the ISO medium fit plus 0.3 mm, because printed holes come out under size.',
      options: [
        { v: 'M3', label: 'M3', help: '3.4 mm clearance, 6 mm countersunk head. Fine for clips and combs.' },
        { v: 'M4', label: 'M4', help: '4.5 mm clearance, 8 mm head. The default for anything that carries weight.' },
        { v: 'M5', label: 'M5', help: '5.5 mm clearance, 10 mm head. Brackets and coat hooks.' },
      ] },
    { key: 'head', label: 'Head recess', type: 'enum', def: 'cs90', group: 'Mounting',
      showIf: (p) => p.mount === 'screws' || p.mount === 'both',
      help: 'What shape the hole is at the face the screw goes in.',
      options: [
        { v: 'cs90', label: 'Countersunk 90°', help: 'The metric standard. A flat head sits flush and the plate lies against the wall.' },
        { v: 'cs82', label: 'Countersunk 82°', help: 'The imperial standard — what most wood screws sold in the UK and US actually are.' },
        { v: 'counterbore', label: 'Counterbore (socket cap)', help: 'A flat-bottomed pocket for a cap-head screw. Stronger clamp, and no wedging force trying to split the plate.' },
        { v: 'plain', label: 'Plain hole', help: 'No recess. Use a washer, or a pan head.' },
      ] },
    { key: 'holes', label: 'Fixings', type: 'int', min: 1, max: 4, step: 1, def: 2, group: 'Mounting',
      showIf: (p) => p.mount === 'screws' || p.mount === 'both',
      help: 'How many per face. Two is right for almost everything — one lets the hook rotate, three rarely all bear.' },
    { key: 'slotted', label: 'Slots instead of holes', type: 'bool', def: false, group: 'Mounting',
      showIf: (p) => p.mount === 'screws' || p.mount === 'both',
      help: 'Turns the holes into slots so the part can be slid and levelled after the screws are in the wall. Worth it any time the alignment matters more than the last millimetre of strength.' },
    { key: 'slotTravel', label: 'Slot travel', type: 'number', unit: 'mm', min: 0, max: 30, step: 1, def: 6, group: 'Mounting',
      showIf: (p) => p.slotted && (p.mount === 'screws' || p.mount === 'both'),
      help: 'How far the part can move on its screws.' },
    { key: 'nutPocket', label: 'Captive nut pocket', type: 'bool', def: false, group: 'Mounting',
      showIf: (p) => p.mount === 'screws' || p.mount === 'both',
      help: 'A hex seat at the far end of each hole, open at the top so the nut drops in while it prints. Use it when you are bolting through something rather than screwing into it.' },
    { key: 'pad', label: 'Adhesive pad', type: 'enum', def: '19x44', group: 'Mounting',
      showIf: (p) => p.mount === 'adhesive' || p.mount === 'both',
      help: 'Which pad the recess is cut for.',
      options: [
        { v: '20x20', label: '20 × 20 mm VHB square' },
        { v: '25x25', label: '25 × 25 mm VHB square' },
        { v: '19x44', label: '19 × 44 mm foam strip' },
        { v: '12x50', label: '12 × 50 mm narrow strip' },
        { v: 'custom', label: 'Custom size' },
      ] },
    { key: 'padW', label: 'Pad width', type: 'number', unit: 'mm', min: 5, max: 150, step: 1, def: 20, group: 'Mounting',
      showIf: (p) => p.pad === 'custom' && (p.mount === 'adhesive' || p.mount === 'both'),
      help: 'Across the part.' },
    { key: 'padH', label: 'Pad length', type: 'number', unit: 'mm', min: 5, max: 150, step: 1, def: 40, group: 'Mounting',
      showIf: (p) => p.pad === 'custom' && (p.mount === 'adhesive' || p.mount === 'both'),
      help: 'Up the plate.' },
    { key: 'padDepth', label: 'Recess depth', type: 'number', unit: 'mm', min: 0.2, max: 3, step: 0.1, def: 0.6, group: 'Mounting',
      showIf: (p) => p.mount === 'adhesive' || p.mount === 'both',
      help: 'Set it 0.2-0.3 mm shallower than the pad is thick. A pad recessed flush carries nothing — the plate rim takes the load and rocks.' },
  ],

  presets: [
    { name: 'Coat hook, screwed',
      values: { type: 'jhook', width: 22, wall: 2.4, fillet: 4, chamfer: 0.6, plateT: 4.8, plateH: 60,
        reach: 34, stock: 7.2, bendR: 12, sweepDeg: 165, tipLen: 6,
        mount: 'screws', screw: 'M5', head: 'cs90', holes: 2, slotted: false, nutPocket: false } },
    { name: 'Under-desk headphone saddle',
      values: { type: 'hanger', width: 34, wall: 2.4, fillet: 5, chamfer: 1.0, plateT: 4, plateH: 40,
        reach: 44, stock: 6, bendR: 10, sweepDeg: 100, cradleR: 110,
        mount: 'screws', screw: 'M4', head: 'cs90', holes: 2, slotted: false } },
    { name: 'Desk-edge cable clip, 6 mm',
      values: { type: 'clip', width: 12, wall: 1.6, fillet: 1.2, chamfer: 0.4, plateT: 2.4, plateH: 16,
        cableDia: 6, grip: 0.82, clearance: 0.3,
        mount: 'adhesive', pad: '20x20', padDepth: 0.6 } },
    { name: 'Shelf bracket, 100 × 80',
      values: { type: 'bracket', width: 20, wall: 2.4, fillet: 6, chamfer: 0.8, plateT: 6, stock: 6,
        legV: 100, legH: 80, gusset: 62, gussetStyle: 'curved',
        mount: 'screws', screw: 'M5', head: 'cs90', holes: 2, slotted: true, slotTravel: 8 } },
    { name: 'Key hook on a sticky pad',
      values: { type: 'wallhook', width: 20, wall: 2.4, fillet: 3, chamfer: 0.6, plateT: 4, plateH: 46,
        reach: 16, stock: 5.2, bendR: 5, sweepDeg: 120, rise: 8,
        mount: 'adhesive', pad: '19x44', padDepth: 0.6 } },
    { name: 'Six-way desk cable comb',
      values: { type: 'comb', width: 14, wall: 2, fillet: 1, chamfer: 0.5, cableDia: 5, grip: 0.8,
        clearance: 0.3, slots: 6, toothW: 4, combBase: 10,
        mount: 'screws', screw: 'M3', head: 'cs90', holes: 2 } },
    { name: 'Bench wire spool',
      values: { type: 'spool', wall: 2.4, flangeDia: 74, hubDia: 30, boreDia: 8, spoolH: 40,
        flangeT: 2.8, flangeHoles: 5, mount: 'none' } },
  ],

  build,
  validate,
  hints,
};

export { build, validate, hints, TYPE_IDS, ORIENTATION };
