// js/gen/gear.js — involute gears that actually mesh.
//
// The tooth flank is the true involute of the base circle, computed point by
// point, and the root fillet is the trochoid an actual rack cutter would leave —
// the envelope of the cutter's tip corner as it rolls on the pitch line. That
// matters more than it sounds. An approximated flank (a circular arc, a spline
// through three points) makes a gear that turns, but with a velocity ripple you
// can feel, and two such gears only mesh at the exact centre distance they were
// drawn at. An involute pair meshes at any centre distance, which is the whole
// reason the involute won, and it is the only tooth form whose correctness can
// be checked by arithmetic rather than by eye.
//
// PRINTED MILLIMETRES, NOT MODULE FRACTIONS. Backlash and root clearance are
// given in mm because that is the unit a printer's error is in. A 0.25 mm
// backlash is right for this machine at m = 1 and at m = 3; "0.05 m" is not.
// Backlash is taken off the tooth thickness of BOTH gears, half each, so a pair
// built with backlash = 0.25 has 0.25 mm of circumferential play in total.
//
// EVERY GEOMETRIC CONFLICT IS CLAMPED IN build() AND REPORTED BY validate().
// A bore wider than the root circle, a hub that swallows the rim, a boss bigger
// than the web: build() pulls each of them back to the nearest legal value so
// that the solid is always watertight, and validate() says what it had to do.
// A generator that throws at the edge of its parameter space is a generator you
// cannot put a slider on.
//
// CONVENTION. Profiles are built about the axis of rotation with one tooth
// centred on +X; tooth k is centred at k·2π/z. The finished MESH is then
// centred on its bounding box, because that is what the rest of Bluesheet expects —
// for an odd tooth count those two centres differ by a fraction of a
// millimetre, and `meta.axis` records the offset. Work in the exported profile
// functions, not the mesh, if you need the axis.
//
// WHAT IS DELIBERATELY NOT HERE. No tip chamfer: a chamfer on a gear tooth has
// to be cut into a profile that is already at the resolution limit of the
// nozzle, and on FDM the first-layer squish (elephant's foot) is an order of
// magnitude larger than any chamfer worth modelling — the fix for that is a
// slicer setting, and hints() says so. No recessed web either: on FDM a
// recessed web splits the rim and the hub into separate islands for most of the
// height, which costs travel moves and stringing, and saves a couple of grams
// on a part whose failure mode is tooth shear. Spokes through the full face
// width do the same job and print better.

import { Mesh, TAU } from '../kernel/mesh.js';
import { circle, regularPolygon, rect, roundRect, triangulate, boolean, offset, signedArea } from '../kernel/poly2d.js';
import { extrude, cylinder } from '../kernel/builders.js';
import { subtract } from '../kernel/csg.js';
import { clamp, num } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

const D2R = Math.PI / 180;
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];

// ---------------------------------------------------------------------------
// Involute arithmetic
// ---------------------------------------------------------------------------

/** inv(a) = tan a − a — the involute function, the workhorse of gear geometry. */
export function invol(a) { return Math.tan(a) - a; }

/**
 * Invert the involute function. inv() has no closed form inverse; Newton from a
 * cube-root seed (inv a ≈ a³/3 for small a) converges in three or four steps
 * over the whole useful range and lands on double precision.
 */
export function involInv(v) {
  if (!(v > 0)) return 0;
  let a = Math.cbrt(3 * v);
  for (let i = 0; i < 60; i++) {
    const t = Math.tan(a);
    const df = t * t;                      // d/da (tan a − a) = tan² a
    if (!(Math.abs(df) > 1e-15)) break;
    const step = (t - a - v) / df;
    a -= step;
    if (!(a > 0)) a = 1e-7;
    if (a > 1.45) a = 1.45;                // 83°, well past any real gear
    if (Math.abs(step) < 1e-15) break;
  }
  return a;
}

/**
 * The tooth count below which a rack-generated, unshifted gear is undercut: the
 * cutter's tip sweeps inside the base circle and eats the bottom of the flank.
 * 2/sin²α — 17.1 teeth at 20°, 31.9 at 14.5°, 11.2 at 25°.
 */
export function undercutLimit(paDeg) {
  const s = Math.sin(paDeg * D2R);
  return 2 / (s * s);
}

/** The profile shift that just avoids undercut at this tooth count (may be ≤ 0). */
export function minProfileShift(teeth, paDeg) {
  const s = Math.sin(paDeg * D2R);
  return 1 - teeth * s * s / 2;
}

/** What the generator picks when "avoid undercut automatically" is on. */
export function autoProfileShift(teeth, paDeg) {
  return clamp(Math.max(0, minProfileShift(teeth, paDeg)), 0, 1);
}

/**
 * Operating centre distance of an external pair. Unshifted gears run at the
 * reference distance m(z1+z2)/2; a pair whose shifts sum to something positive
 * runs further apart, at the distance where the working pressure angle absorbs
 * the extra tooth thickness. A pair with x1 = −x2 comes back to exactly the
 * reference distance, which is the trick used to fix a pinion's undercut
 * without moving the shafts.
 */
export function centreDistance(module, z1, z2, paDeg, x1 = 0, x2 = 0) {
  const a = paDeg * D2R;
  const ref = module * (z1 + z2) / 2;
  const sum = x1 + x2;
  if (Math.abs(sum) < 1e-12) return ref;
  const invAw = invol(a) + 2 * sum * Math.tan(a) / (z1 + z2);
  if (!(invAw > 0)) return ref;
  return ref * Math.cos(a) / Math.cos(involInv(invAw));
}

/** Centre distance of an internal pair (ring z1 around pinion z2), unshifted. */
export function internalCentreDistance(module, zRing, zPinion) {
  return module * (zRing - zPinion) / 2;
}

// ---------------------------------------------------------------------------
// Gear specification — every radius the profile builder needs, in one object
// ---------------------------------------------------------------------------

/**
 * `internal` flips the sense of the whole tooth: the addendum goes inward, the
 * dedendum outward, and the flank widens with radius instead of narrowing. The
 * involute is the same curve on the same base circle either way, which is why
 * one `psiAt` serves both.
 */
export function gearSpec({ module, teeth, pressureAngle = 20, shift = 0, backlash = 0, clearance = 0, internal = false }) {
  const m = Math.max(1e-4, module);
  const z = Math.max(3, Math.round(teeth));
  const alpha = pressureAngle * D2R;
  const rp = m * z / 2;
  const rb = rp * Math.cos(alpha);
  const tau = TAU / z;
  const x = internal ? 0 : shift;                        // internal shift is not modelled
  const ra = internal ? rp - m : m * (z / 2 + 1 + x);
  const rf = internal ? rp + 1.25 * m + clearance : Math.max(0.2 * rp, m * (z / 2 + x - 1.25) - clearance);
  // Arc tooth thickness at the pitch circle, thinned by half the backlash so a
  // pair of these leaves exactly `backlash` of circumferential gap between them.
  const s = Math.max(0.05 * m, m * (Math.PI / 2 + 2 * x * Math.tan(alpha)) - backlash / 2);
  return {
    module: m, teeth: z, pressureAngle, alpha, shift: x, backlash, clearance, internal,
    rp, rb, ra, rf, tau, s,
    psiP: s / (2 * rp), sense: internal ? -1 : 1,
    pitchDia: 2 * rp, baseDia: 2 * rb, tipDia: 2 * ra, rootDia: 2 * rf,
    addendum: internal ? m : m * (1 + x),
    dedendum: 1.25 * m + clearance,
  };
}

/** Half tooth angle at radius r, measured from the tooth centre. NaN below rb. */
export function psiAt(sp, r) {
  if (r < sp.rb) return NaN;
  const ar = Math.acos(clamp(sp.rb / r, -1, 1));
  return sp.psiP + sp.sense * (invol(sp.alpha) - invol(ar));
}

/** A point on the involute flank as [x, y], at radius r, on the +ψ side. */
export function involutePoint(sp, r) {
  const psi = psiAt(sp, r);
  return [r * Math.cos(psi), r * Math.sin(psi)];
}

// ---------------------------------------------------------------------------
// The trochoidal root fillet
// ---------------------------------------------------------------------------

/**
 * The curve the corner of a rack cutter leaves in the root of an external gear.
 *
 * The cutter's tip corner is a circle of radius ρ rolling with the rack; the
 * fillet is the envelope of that circle in the gear's own frame. Working in the
 * gear frame — rack pitch line at x = rp, rack displacement u, gear rotation
 * u/rp — the corner centre sits at Rot(−u/rp)·(rp − ac, bc + u), and the
 * envelope point is ρ from it along the inward normal to its velocity.
 *
 * The samples come back with radius strictly increasing from the root and angle
 * strictly decreasing, so the caller can treat the fillet as a function of
 * radius and take the tighter of it and the involute — which is exactly what
 * undercut IS, and makes it fall out of the arithmetic instead of needing a
 * special case.
 *
 * The sweep stops at the point where the angle turns back on itself. Past that
 * the cutter corner is carving the NEXT tooth space, and following it produces
 * the classic self-crossing loop that turns a gear outline into a bow tie.
 */
export function trochoid(sp, count = 10) {
  const { rp, rf, alpha, s, module: m } = sp;
  const hfc = rp - rf;                                   // cutter depth below the pitch line
  if (!(hfc > 1e-9)) return { pts: [], ok: false, rho: 0, phiDeep: sp.psiP };
  const rho = Math.min(0.38 * m, 0.95 * hfc);            // ISO basic-rack tip radius
  const ac = hfc - rho;
  const bc = s / 2 + ac * Math.tan(alpha) + rho / Math.cos(alpha);
  const at = (u) => {
    const th = -u / rp, fx = rp - ac, fy = bc + u;
    const c = Math.cos(th), si = Math.sin(th);
    const px = fx * c - fy * si, py = fx * si + fy * c;
    const dth = -1 / rp;
    const vx = -fx * si * dth - (si + fy * c * dth);
    const vy = fx * c * dth + (c - fy * si * dth);
    const vl = Math.hypot(vx, vy);
    if (!(vl > 1e-12)) return null;
    const ex = px - rho * vy / vl, ey = py + rho * vx / vl;
    const r = Math.hypot(ex, ey);
    if (!isFinite(r) || r < 1e-9) return null;
    return { r, phi: Math.atan2(ey, ex) };
  };

  const uDeep = -bc;                                     // corner bottoms out on the root circle
  const deep = at(uDeep);
  if (!deep) return { pts: [], ok: false, rho, phiDeep: sp.psiP };
  // Sampled finely and uniformly in the rack's travel, which naturally crowds
  // points near the root where the angle moves fastest. The caller decimates
  // this list for the mesh; the dense version is what the interpolation and the
  // undercut measurement read.
  const n = Math.max(12, Math.round(count));
  const span = Math.PI * m;                              // half a cutter pitch is more than enough
  const pts = [{ r: rf, phi: deep.phi }];
  let lastR = rf, lastPhi = deep.phi;
  for (let i = 1; i <= n; i++) {
    const p = at(uDeep - span * (i / n));
    if (!p) break;
    if (!(p.r > lastR + 1e-12)) break;                   // radius must keep climbing
    if (!(p.phi < lastPhi - 1e-14)) break;               // angle must keep falling: past the cusp
    pts.push(p);
    lastR = p.r; lastPhi = p.phi;
    if (p.r > sp.ra) break;
  }
  return { pts, ok: pts.length > 1, rho, phiDeep: deep.phi, rTop: lastR };
}

/** Linear interpolation of the trochoid's half angle at radius r. */
function trochoidPsi(tro, r) {
  const p = tro.pts;
  if (!p.length) return Infinity;
  if (r <= p[0].r) return p[0].phi;
  if (r >= p[p.length - 1].r) return Infinity;
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid].r <= r) lo = mid; else hi = mid; }
  const t = (r - p[lo].r) / (p[hi].r - p[lo].r);
  return p[lo].phi + t * (p[hi].phi - p[lo].phi);
}

/**
 * How much of the involute flank the cutter has eaten, in millimetres of arc.
 *
 * Measured as the largest gap between the true involute and the profile the
 * cutter actually leaves, anywhere above the base circle. Zero is a clean
 * flank. It crosses zero exactly at the classical 2/sin²α limit, which is the
 * point: the number this returns and the number undercutLimit() predicts are
 * two independent routes to the same statement, and they agree.
 */
export function undercutOf(sp, q = 1) {
  if (sp.internal) return 0;
  const h = externalHalfTooth(sp, q);
  return h.undercut;
}

// ---------------------------------------------------------------------------
// One half tooth, as {r, φ} from the root to the tip
// ---------------------------------------------------------------------------

/** Segments for a circle of radius r at quality q, from a chord tolerance. */
function circSegs(r, q = 1, min = 12, max = 320) {
  const tol = 0.02 / clamp(q, 0.25, 4);
  const rr = Math.max(r, 1e-3);
  const c = clamp(1 - tol / rr, -1, 1);
  const n = Math.ceil(Math.PI / Math.max(1e-6, Math.acos(c)));
  return clamp(Math.round(n), min, max);
}

/** Keep the first and last of every run of equal angle; drop anything rising. */
function monotoneFalling(pts, eps = 1e-12) {
  const out = [];
  for (const p of pts) {
    if (!isFinite(p.r) || !isFinite(p.phi)) continue;
    const last = out[out.length - 1];
    if (!last) { out.push(p); continue; }
    if (p.phi < last.phi - eps) { out.push(p); continue; }
    // Equal angle: a radial segment. Keep it, but only its two ends.
    if (p.phi > last.phi + eps) continue;
    const prev = out[out.length - 2];
    if (prev && Math.abs(prev.phi - last.phi) <= eps) out[out.length - 1] = { r: p.r, phi: last.phi };
    else out.push({ r: p.r, phi: last.phi });
  }
  return out;
}

/**
 * The external half tooth: root first (r = rf), tip last, angle falling.
 *
 * Built as the tighter of the involute and the trochoid at every radius, with a
 * radial bridge across any gap between the top of the fillet and the base
 * circle. `raEff` is the tip radius after the pointed-tooth clamp: a small gear
 * at a big profile shift runs out of tooth before it reaches the addendum
 * circle, and printing a knife edge is pointless, so the tip is cut back to
 * wherever the land is still a quarter of a module wide.
 */
export function externalHalfTooth(sp, q = 1) {
  const tro = trochoid(sp, 48);
  const landMin = Math.max(0.25 * sp.module, 0.1);
  const phiFloor = Math.max(landMin / (2 * sp.ra), 1e-5);
  const half = sp.tau / 2;
  const phiCeil = Math.max(phiFloor * 1.5, half - Math.max(1e-5, 0.05 / sp.rf));
  const troTop = tro.ok ? tro.pts[tro.pts.length - 1].r : -Infinity;
  const bridge = tro.ok ? tro.pts[tro.pts.length - 1].phi : sp.psiP;

  const psiOf = (r) => {
    const inv = r >= sp.rb ? psiAt(sp, r) : NaN;
    const t = tro.ok && r <= troTop ? trochoidPsi(tro, r) : Infinity;
    let v;
    if (isFinite(inv) && isFinite(t)) v = Math.min(inv, t);
    else if (isFinite(inv)) v = inv;
    else if (isFinite(t)) v = t;
    else v = bridge;                                     // below rb, above the fillet: radial
    return clamp(v, -Math.PI, phiCeil);
  };

  // Pointed-tooth clamp: ψ falls with r, so bisect for the largest radius that
  // still leaves a printable land.
  let raEff = sp.ra;
  if (psiOf(sp.ra) < phiFloor) {
    let lo = sp.rf, hi = sp.ra;
    if (psiOf(lo) < phiFloor) raEff = lo + Math.max(1e-3, 0.02 * sp.module);
    else {
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (psiOf(mid) >= phiFloor) lo = mid; else hi = mid; }
      raEff = lo;
    }
  }
  raEff = Math.max(raEff, sp.rf + Math.max(1e-3, 0.02 * sp.module));

  const radii = new Set([sp.rf, raEff]);
  // Decimate the dense trochoid rather than emitting all of it: the fine
  // version exists for the interpolation, not for the mesh.
  if (tro.ok) {
    const nTro = Math.max(4, Math.round(7 * q));
    const L = tro.pts.length - 1;
    for (let i = 0; i <= nTro; i++) {
      const r = tro.pts[Math.round(i * L / nTro)].r;
      if (r > sp.rf && r < raEff) radii.add(r);
    }
  }
  // Uniform in the involute's roll angle, which spaces points evenly along the
  // curve rather than bunching them at the base circle.
  const rStart = Math.max(sp.rb, Math.min(sp.rf, raEff));
  if (raEff > rStart + 1e-9 && sp.rb > 1e-9) {
    const nInv = Math.max(5, Math.round(9 * q));
    const tEnd = Math.sqrt(Math.max(0, (raEff / sp.rb) ** 2 - 1));
    const tBeg = Math.sqrt(Math.max(0, (rStart / sp.rb) ** 2 - 1));
    for (let i = 0; i <= nInv; i++) {
      const t = tBeg + (tEnd - tBeg) * (i / nInv);
      radii.add(clamp(sp.rb * Math.sqrt(1 + t * t), sp.rf, raEff));
    }
  }
  if (sp.rb > sp.rf && sp.rb < raEff) radii.add(sp.rb);

  const sorted = [...radii].sort((a, b) => a - b).filter(r => r >= sp.rf - 1e-9 && r <= raEff + 1e-9);
  const pts = monotoneFalling(sorted.map(r => ({ r, phi: psiOf(r) })));
  if (pts.length < 2) pts.push({ r: raEff, phi: Math.max(phiFloor, (pts[0]?.phi ?? phiCeil) * 0.5) });
  pts[0] = { r: sp.rf, phi: pts[0].phi };

  // Undercut: the largest angular bite taken out of the true involute anywhere
  // above the base circle, as an arc length.
  let undercut = 0;
  const rLo = Math.max(sp.rb, sp.rf);
  if (raEff > rLo + 1e-9) {
    for (let i = 0; i <= 40; i++) {
      const r = rLo + (raEff - rLo) * (i / 40);
      const d = (psiAt(sp, r) - psiOf(r)) * r;
      if (isFinite(d) && d > undercut) undercut = d;
    }
  }
  return { pts, raEff, phiRoot: pts[0].phi, undercut, rho: tro.rho };
}

/**
 * The internal half tooth: root first (r = rf, the OUTER radius here), tip last
 * at the smaller radius, angle falling all the way.
 *
 * An internal gear is shaper-cut, not hobbed, so its root fillet depends on the
 * cutter rather than on the gear; every CAD model of one uses a plain arc
 * tangent to the flank and to the root circle, and so does this. The fillet
 * centre is the point at radius rf − ρ that is ρ from the flank, found by
 * walking the flank polyline until the offset crosses that circle. Below the
 * base circle the flank goes radial, which is what a shaper leaves and keeps
 * the full addendum on rings with few teeth (at 20° a ring needs 34 teeth
 * before its tip circle clears its own base circle).
 */
export function internalHalfTooth(sp, q = 1) {
  const landMin = Math.max(0.25 * sp.module, 0.1);
  const phiFloor = Math.max(landMin / (2 * Math.max(sp.ra, 1e-3)), 1e-5);
  const half = sp.tau / 2;
  const phiCeil = Math.max(phiFloor * 1.5, half - Math.max(1e-5, 0.05 / sp.rf));
  const rTip = Math.max(sp.ra, 0.25 * sp.rf);
  const psiOf = (r) => {
    const v = r >= sp.rb ? psiAt(sp, r) : psiAt(sp, sp.rb);
    return clamp(isFinite(v) ? v : phiFloor, phiFloor, phiCeil);
  };

  const nInv = Math.max(7, Math.round(14 * q));
  const raw = [];
  for (let i = 0; i <= nInv; i++) {
    const r = sp.rf + (rTip - sp.rf) * (i / nInv);
    raw.push({ r, phi: psiOf(r) });
  }
  if (sp.rb > rTip && sp.rb < sp.rf) raw.push({ r: sp.rb, phi: psiOf(sp.rb) });
  raw.sort((a, b) => b.r - a.r);
  let pts = monotoneFalling(raw);
  if (pts.length < 2) pts = [{ r: sp.rf, phi: phiCeil }, { r: rTip, phi: phiFloor }];

  // The root fillet, spliced in at the outer end.
  const rho = Math.min(0.3 * sp.module, 0.4 * (sp.rf - rTip), 0.35 * (half - pts[0].phi) * sp.rf);
  const fil = rho > 0.02 ? internalFillet(pts, sp.rf, rho, Math.max(3, Math.round(4 * q))) : null;
  if (fil) pts = fil.concat(pts.slice(fil.cut));
  pts = monotoneFalling(pts);
  pts[0] = { r: sp.rf, phi: pts[0].phi };
  return { pts, raEff: pts[pts.length - 1].r, phiRoot: pts[0].phi };
}

/**
 * Round the concave corner where an internal flank meets the root circle.
 * Returns the arc as {r, φ} from the root circle to the flank tangency, plus
 * the index of the first flank point to keep, or null if no arc fits.
 */
function internalFillet(pts, rf, rho, segs) {
  const P = pts.map(p => polar(p.r, p.phi));
  const target = rf - rho;
  const centreAt = (i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], p = P[i];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (!(l > 1e-12)) return null;
    dx /= l; dy /= l;
    // Normal towards increasing angle — away from the tooth body, into the space.
    let nx = -dy, ny = dx;
    const rr = Math.hypot(p[0], p[1]) || 1;
    if ((-p[1] / rr) * nx + (p[0] / rr) * ny < 0) { nx = -nx; ny = -ny; }
    return [p[0] + nx * rho, p[1] + ny * rho];
  };
  let prev = centreAt(0);
  if (!prev) return null;
  let prevD = Math.hypot(prev[0], prev[1]) - target;
  if (!(prevD > 0)) return null;                         // already inside: no room for an arc
  for (let i = 1; i < P.length; i++) {
    const c = centreAt(i);
    if (!c) continue;
    const d = Math.hypot(c[0], c[1]) - target;
    if (d > 0) { prev = c; prevD = d; continue; }
    const t = prevD / (prevD - d);
    const cx = prev[0] + (c[0] - prev[0]) * t, cy = prev[1] + (c[1] - prev[1]) * t;
    const cl = Math.hypot(cx, cy);
    if (!(cl > 1e-9)) return null;
    const onRoot = [cx * rf / cl, cy * rf / cl];
    const touch = P[i];
    const a0 = Math.atan2(onRoot[1] - cy, onRoot[0] - cx);
    const a1 = Math.atan2(touch[1] - cy, touch[0] - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const out = [];
    for (let k = 0; k <= segs; k++) {
      const a = a0 + sweep * (k / segs);
      const x = cx + rho * Math.cos(a), y = cy + rho * Math.sin(a);
      out.push({ r: Math.hypot(x, y), phi: Math.atan2(y, x) });
    }
    out.cut = i + 1;
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/**
 * Assemble a whole toothed ring from one half tooth, counter-clockwise, with
 * tooth 0 centred on +X.
 *
 * Per pitch: root land, rising flank, tip land, falling flank, root land. The
 * polar angle increases monotonically for the entire circuit, which is what
 * guarantees the result is a simple polygon at every parameter extreme —
 * including the ugly ones, where a five-tooth gear at a negative shift is
 * almost entirely fillet and the root lands of neighbouring teeth have met.
 */
function toothedRing(half, sp, q) {
  const { pts, raEff, phiRoot } = half;
  const hp = sp.tau / 2;
  const landSpan = Math.max(0, hp - phiRoot);
  const nRoot = landSpan * sp.rf > 0.15 ? Math.max(2, Math.round(3 * q)) : 1;
  const phiTip = pts[pts.length - 1].phi;
  const nTip = phiTip * raEff > 0.15 ? Math.max(2, Math.round(3 * q)) : 1;
  const ring = [];
  for (let k = 0; k < sp.teeth; k++) {
    const base = k * sp.tau;
    for (let i = 0; i < nRoot; i++) ring.push(polar(sp.rf, base - hp + landSpan * (i / nRoot)));
    for (let i = 0; i < pts.length; i++) ring.push(polar(pts[i].r, base - pts[i].phi));
    for (let i = 1; i < nTip; i++) ring.push(polar(raEff, base - phiTip + 2 * phiTip * (i / nTip)));
    for (let i = pts.length - 1; i >= 0; i--) ring.push(polar(pts[i].r, base + pts[i].phi));
    for (let i = 1; i < nRoot; i++) ring.push(polar(sp.rf, base + phiRoot + landSpan * (i / nRoot)));
  }
  return ring;
}

/** The complete external gear outline, CCW, tooth 0 centred on +X. */
export function gearRing(sp, q = 1) {
  const half = externalHalfTooth(sp, q);
  const ring = toothedRing(half, sp, q);
  ring.tipRadius = half.raEff;
  ring.undercut = half.undercut;
  return ring;
}

/**
 * The toothed inner boundary of an internal ring gear, CCW, enclosing the void.
 * Use it as a hole (wound clockwise) in whatever outer shape the ring body has.
 */
export function internalRing(sp, q = 1) {
  const half = internalHalfTooth(sp, q);
  const ring = toothedRing(half, sp, q);
  ring.tipRadius = half.raEff;
  return ring;
}

/**
 * A straight rack — the gear's own generating rack, given thickness.
 *
 * Returned as a side-view outline in (x along the rack, y above the pitch
 * line), so the caller extrudes it along Z and the teeth point sideways. That
 * is the orientation a rack must be printed in: every tooth surface is a
 * vertical wall, so there is no overhang and no stair-stepping on the flanks,
 * and a tooth loaded along X fractures across the layers rather than between
 * them. Printed teeth-up it would be one delamination away from a stub.
 */
export function rackRing(sp, { teeth = 10, base = 6, xShift = 0, q = 1 } = {}) {
  const m = sp.module, ta = Math.tan(sp.alpha), p = Math.PI * m;
  const T = Math.max(1, Math.round(teeth));
  const s = sp.s;                                        // already thinned by backlash/2
  const hf = 1.25 * m + sp.clearance;
  const wAt = (y) => s / 2 - y * ta;
  const minLand = Math.max(0.25 * m, 0.1);

  // Tip: stop before the flanks meet, so a big backlash cannot make a knife edge.
  let yTip = m;
  if (wAt(yTip) < minLand / 2) yTip = clamp((s / 2 - minLand / 2) / Math.max(ta, 1e-6), 0.1 * m, m);
  // Root: stop before the flanks of neighbouring teeth meet, which a large
  // clearance on a small module will otherwise make them do.
  let yRoot = -hf;
  if (wAt(yRoot) > p / 2 - minLand / 2) yRoot = (s / 2 - p / 2 + minLand / 2) / Math.max(ta, 1e-6);
  yRoot = clamp(yRoot, -hf, -0.05 * m);
  const yBottom = -hf - Math.max(0.4, base);

  const land = p - 2 * wAt(yRoot);
  const rho = Math.max(0, Math.min(0.38 * m, 0.42 * land * Math.cos(sp.alpha), 0.45 * (yRoot - yBottom)));
  const nArc = Math.max(2, Math.round(4 * q));
  const half = T * p / 2;
  const top = [];
  for (let k = 0; k < T; k++) {
    const c = (k - (T - 1) / 2) * p + xShift;
    if (rho > 1e-4) {
      const cx = c - s / 2 + (yRoot + rho) * ta - rho / Math.cos(sp.alpha);
      for (let i = 0; i <= nArc; i++) {
        const a = -Math.PI / 2 + (Math.PI / 2 - sp.alpha) * (i / nArc);
        top.push([cx + rho * Math.cos(a), yRoot + rho + rho * Math.sin(a)]);
      }
    } else top.push([c - wAt(yRoot), yRoot]);
    top.push([c - wAt(yTip), yTip]);
    top.push([c + wAt(yTip), yTip]);
    if (rho > 1e-4) {
      const cx = c + s / 2 - (yRoot + rho) * ta + rho / Math.cos(sp.alpha);
      for (let i = nArc; i >= 0; i--) {
        const a = -Math.PI / 2 + (Math.PI / 2 - sp.alpha) * (i / nArc);
        top.push([cx - rho * Math.cos(a), yRoot + rho + rho * Math.sin(a)]);
      }
    } else top.push([c + wAt(yRoot), yRoot]);
  }
  const x0 = -half + xShift, x1 = half + xShift;
  const ring = [[x0, yBottom], [x0, yRoot], ...top, [x1, yRoot], [x1, yBottom]];
  const out = signedArea(ring) < 0 ? ring.reverse() : ring;
  out.yTip = yTip; out.yRoot = yRoot; out.yBottom = yBottom;
  out.x0 = x0; out.x1 = x1; out.pitch = p;
  return out;
}

// ---------------------------------------------------------------------------
// Planetary arithmetic
// ---------------------------------------------------------------------------

/**
 * Where every part of a planetary set goes, and the tooth phase each one needs.
 *
 * The phase is the part nobody derives and everybody fudges. Writing f for a
 * gear's tooth coordinate along a given direction (integer = a tooth centred
 * there, half-integer = a space), an external mesh needs f_a + f_b ≡ ½ across
 * the line of centres and an internal mesh needs f_ring − f_planet ≡ ½ along
 * it. Requiring the ring's phase to come out the same for every planet is what
 * produces the assembly condition (sun + ring) mod N = 0 — it is not an extra
 * rule, it is the same equation.
 */
export function planetaryLayout({ module, sun, planet, ring, count, pressureAngle = 20 }) {
  const zs = Math.max(3, Math.round(sun)), zp = Math.max(3, Math.round(planet));
  const zr = Math.max(3, Math.round(ring)), N = Math.max(1, Math.round(count));
  const aSP = module * (zs + zp) / 2;
  const planets = [];
  for (let i = 0; i < N; i++) {
    const L = i * TAU / N;
    const fs = L * zs / TAU;
    const rot = L + Math.PI - (TAU / zp) * (0.5 - fs);
    planets.push({ index: i, angle: L, x: aSP * Math.cos(L), y: aSP * Math.sin(L), rot });
  }
  return {
    zs, zp, zr, N,
    sunRot: 0,
    ringRot: (TAU / zr) * (zp / 2 - 1),
    centre: aSP,
    planets,
    ratio: 1 + zr / zs,                                  // carrier out, ring held
    fits: zr === zs + 2 * zp,
    spaced: (zs + zr) % N === 0,
    // Neighbouring planets must clear each other by their tip circles.
    planetGap: N > 1 ? 2 * aSP * Math.sin(Math.PI / N) - module * (zp + 2) : Infinity,
  };
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

const ccw = (r) => (signedArea(r) < 0 ? r.slice().reverse() : r);
const cw = (r) => (signedArea(r) > 0 ? r.slice().reverse() : r);

function ringIdx(mesh, ring, z) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = mesh.addVertex(ring[i][0], ring[i][1], z);
  return out;
}

/** Wall between two index rings of equal length; outer CCW / holes CW face out. */
function strip(mesh, lo, hi) {
  const n = lo.length;
  for (let i = 0; i < n; i++) mesh.addQuad(lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]);
}

/**
 * A flat face from rings that are already wound outer-CCW / holes-CW, reusing
 * the vertices the walls were built from. Sharing the vertices rather than
 * re-adding them is the whole reason this is watertight without a weld.
 */
function cap(mesh, rings, idxs, up) {
  const t = triangulate(rings);
  const flat = [];
  for (const a of idxs) for (const i of a) flat.push(i);
  let added = 0;
  for (let i = 0; i < t.tris.length; i += 3) {
    const a = flat[t.tris[i]], b = flat[t.tris[i + 1]], c = flat[t.tris[i + 2]];
    if (a === undefined || b === undefined || c === undefined || a === b || b === c || a === c) continue;
    if (up) mesh.addTri(a, b, c); else mesh.addTri(a, c, b);
    added++;
  }
  if (!added) throw new Error('gear: a face failed to triangulate');
  return added;
}

/**
 * The whole toothed body in one pass.
 *
 * The tooth ring is the only thing that rotates with height — the bore, the
 * spoke cuts and the boss stay straight, because a helical gear runs on a
 * straight shaft. That is why this is built level by level instead of handed to
 * extrude(): extrude twists every ring of the section together, which would put
 * a corkscrew through the middle of the part.
 */
function toothedSolid({ outer, holes, faceWidth, rotAt, levels, boss, bore, bossH }) {
  const mesh = new Mesh();
  const zTop = faceWidth + (boss ? bossH : 0);
  const outerCCW = ccw(outer);
  const holeRings = holes.map(cw);

  const zs = levels;
  const outerIdx = zs.map((z, i) => {
    const rot = rotAt ? rotAt(z) : 0;
    const ring = rot ? outerCCW.map(p => {
      const c = Math.cos(rot), s = Math.sin(rot);
      return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
    }) : outerCCW;
    return { ring, idx: ringIdx(mesh, ring, z) };
  });
  for (let i = 1; i < outerIdx.length; i++) strip(mesh, outerIdx[i - 1].idx, outerIdx[i].idx);

  const holeBot = holeRings.map(r => ringIdx(mesh, r, 0));
  const holeTop = holeRings.map(r => ringIdx(mesh, r, faceWidth));
  for (let i = 0; i < holeRings.length; i++) strip(mesh, holeBot[i], holeTop[i]);

  const boreCW = bore ? cw(bore) : null;
  const boreBot = boreCW ? ringIdx(mesh, boreCW, 0) : null;
  const boreMid = boreCW && !boss ? null : null;
  const boreTop = boreCW ? ringIdx(mesh, boreCW, zTop) : null;
  if (boreCW) strip(mesh, boreBot, boreTop);
  void boreMid;

  // Bottom face.
  cap(mesh,
    [outerIdx[0].ring, ...(boreCW ? [boreCW] : []), ...holeRings],
    [outerIdx[0].idx, ...(boreBot ? [boreBot] : []), ...holeBot], false);

  const last = outerIdx[outerIdx.length - 1];
  if (boss) {
    const bossCCW = ccw(boss);
    const bossLo = ringIdx(mesh, bossCCW, faceWidth);
    const bossHi = ringIdx(mesh, bossCCW, zTop);
    strip(mesh, bossLo, bossHi);
    // The boss is a HOLE in the gear's top face, so the ring has to be reversed
    // to wind clockwise — and its index array has to be reversed with it. Every
    // other cap() call here passes a ring and the indices built from that same
    // array; this one reversed the ring alone, so triangulate() saw point j and
    // cap() looked up the vertex for point n-1-j. The result was still closed,
    // which is why nothing caught it, but forty edges around the boss came out
    // wound the wrong way.
    cap(mesh, [last.ring, cw(bossCCW), ...holeRings],
        [last.idx, bossLo.slice().reverse(), ...holeTop], true);
    cap(mesh, [bossCCW, ...(boreCW ? [boreCW] : [])], [bossHi, ...(boreTop ? [boreTop] : [])], true);
  } else {
    cap(mesh,
      [last.ring, ...(boreCW ? [boreCW] : []), ...holeRings],
      [last.idx, ...(boreTop ? [boreTop] : []), ...holeTop], true);
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Bores, hubs and webs
// ---------------------------------------------------------------------------

/** The bore cross-section, CCW. `dia` is already clearance-corrected. */
function boreRing(kind, dia, opts, q) {
  const r = Math.max(0.3, dia / 2);
  const segs = circSegs(r, q, 16, 200);
  if (kind === 'hex') return regularPolygon(6, r / Math.cos(Math.PI / 6), { rot: 0 });
  if (kind === 'd-flat') {
    const d = clamp(opts.flatDepth, 0.05, 1.7 * r);
    const cosT = clamp((r - d) / r, -0.999, 0.999);
    const t = Math.acos(cosT);
    const n = Math.max(6, Math.round(segs * (TAU - 2 * t) / TAU));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(polar(r, t + (TAU - 2 * t) * (i / n)));
    return out;
  }
  if (kind === 'keyway') {
    const w = clamp(opts.keyWidth, 0.4, 1.8 * r);
    const d = clamp(opts.keyDepth, 0.2, 1.2 * r);
    const key = rect(w, 2 * d, { cx: 0, cy: r });         // straddles the bore wall
    const res = boolean([circle(r, { segs })], [key], 'union');
    if (res.length === 1 && res[0].length === 1) return ccw(res[0][0]);
    return circle(r, { segs });                           // WORKAROUND-free fallback: plain bore
  }
  return circle(r, { segs });
}

/**
 * Lightening cuts between the hub and the rim.
 *
 * Round holes are the safe default; spokes remove more and look like a gear,
 * but their corners are stress risers, so they are rounded by an opening
 * (erode then dilate) rather than left sharp.
 */
function webCuts(mode, count, rIn, rOut, q) {
  if (mode === 'solid') return [];
  const gap = rOut - rIn;
  if (!(gap > 3) || !(rIn > 1.5)) return [];
  const n = clamp(Math.round(count), 2, 24);
  if (mode === 'holes') {
    const rMid = (rIn + rOut) / 2;
    const rHole = Math.min(gap / 2 - 1.0, rMid * Math.sin(Math.PI / n) - 1.0);
    if (!(rHole >= 1.2)) return [];
    const segs = circSegs(rHole, q, 12, 72);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = i * TAU / n;
      out.push(circle(rHole, { segs, cx: rMid * Math.cos(a), cy: rMid * Math.sin(a) }));
    }
    return out;
  }
  // Spokes: cut the sectors between them.
  const w = clamp(Math.max(2.4, 0.35 * gap), 1.6, Math.min(1.6 * rIn, 0.9 * rOut));
  const tIn = Math.sqrt(Math.max(0, rIn * rIn - w * w / 4));
  const tOut = Math.sqrt(Math.max(0, rOut * rOut - w * w / 4));
  if (!(tIn > 0.2) || !(tOut > tIn)) return [];
  const aIn = Math.asin(clamp(w / (2 * rIn), -1, 1));
  const aOut = Math.asin(clamp(w / (2 * rOut), -1, 1));
  const step = TAU / n;
  if (!(step - 2 * aIn > 0.12) || !(step - 2 * aOut > 0.12)) return [];
  const nOut = Math.max(2, Math.round(circSegs(rOut, q, 24, 200) * (step - 2 * aOut) / TAU));
  const nIn = Math.max(2, Math.round(circSegs(rIn, q, 16, 160) * (step - 2 * aIn) / TAU));
  const sector = [];
  for (let i = 0; i <= nOut; i++) sector.push(polar(rOut, aOut + (step - 2 * aOut) * (i / nOut)));
  for (let i = nIn; i >= 0; i--) sector.push(polar(rIn, aIn + (step - 2 * aIn) * (i / nIn)));
  let shaped = sector;
  const rr = Math.min(1.5, 0.28 * gap, 0.28 * rIn * (step - 2 * aIn));
  if (rr > 0.25) {
    try {
      const eroded = offset([sector], -rr, { join: 'round', arcTolerance: 0.04 });
      if (eroded.length === 1) {
        const back = offset(eroded, rr, { join: 'round', arcTolerance: 0.04 });
        if (back.length === 1 && back[0].length === 1 && back[0][0].length >= 6) shaped = ccw(back[0][0]);
      }
    } catch { /* an opening that fails just leaves the corners sharp */ }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const c = Math.cos(a), s = Math.sin(a);
    out.push(shaped.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parameter resolution — every clamp lives here
// ---------------------------------------------------------------------------

const MIN_WALL = 1.2;              // three 0.4 mm extrusions; less than this splits

function resolve(p) {
  const kind = ['spur', 'ring', 'rack', 'planetary'].includes(p.kind) ? p.kind : 'spur';
  const module = clamp(num(p.module, 2), 0.2, 12);
  const pa = clamp(num(p.pressureAngle, 20), 10, 32);
  const teeth = clamp(Math.round(num(p.teeth, 24)), 3, 400);
  const faceWidth = clamp(num(p.faceWidth, 8), 0.4, 120);
  const backlash = clamp(num(p.backlash, 0.25), 0, 3);
  const clearance = clamp(num(p.clearance, 0.2), 0, 3);
  const autoShift = p.autoShift !== false;
  const shift = autoShift ? autoProfileShift(teeth, pa) : clamp(num(p.shift, 0), -1, 1.2);
  const helix = ['straight', 'helical', 'herringbone'].includes(p.helix) ? p.helix : 'straight';
  const helixAngle = clamp(num(p.helixAngle, 20), 0, 60);
  const hand = p.hand === 'left' ? -1 : 1;
  return {
    kind, module, pa, teeth, faceWidth, backlash, clearance, autoShift, shift,
    helix, helixAngle, hand,
    bore: ['none', 'round', 'd-flat', 'keyway', 'hex'].includes(p.bore) ? p.bore : 'round',
    boreDia: clamp(num(p.boreDia, 5), 0.6, 200),
    boreClear: clamp(num(p.boreClear, 0.15), 0, 2),
    flatDepth: clamp(num(p.flatDepth, 0.5), 0.05, 20),
    keyWidth: clamp(num(p.keyWidth, 2), 0.4, 30),
    keyDepth: clamp(num(p.keyDepth, 1.2), 0.2, 20),
    hubDia: clamp(num(p.hubDia, 14), 1, 300),
    rimWidth: clamp(num(p.rimWidth, 4), 0.4, 60),
    web: ['solid', 'holes', 'spokes'].includes(p.web) ? p.web : 'solid',
    webCount: clamp(Math.round(num(p.webCount, 5)), 2, 24),
    boss: !!p.boss,
    bossDia: clamp(num(p.bossDia, 12), 1, 200),
    bossHeight: clamp(num(p.bossHeight, 6), 0.3, 100),
    setScrew: !!p.setScrew,
    setScrewDia: clamp(num(p.setScrewDia, 3.2), 0.6, 20),
    sunTeeth: clamp(Math.round(num(p.sunTeeth, 12)), 4, 200),
    planetTeeth: clamp(Math.round(num(p.planetTeeth, 18)), 4, 200),
    ringTeeth: clamp(Math.round(num(p.ringTeeth, 48)), 8, 400),
    planetCount: clamp(Math.round(num(p.planetCount, 3)), 1, 12),
    rackTeeth: clamp(Math.round(num(p.rackTeeth, 12)), 1, 200),
    rackBase: clamp(num(p.rackBase, 6), 0.4, 80),
    rackHoles: p.rackHoles !== false,
    rackHoleDia: clamp(num(p.rackHoleDia, 3.4), 0.6, 30),
    ringOuter: ['round', 'hex', 'square'].includes(p.ringOuter) ? p.ringOuter : 'round',
  };
}

/** The z levels and the rotation at each, for a straight / helical / herringbone face. */
function helixLevels(r, rp, q) {
  const fw = r.faceWidth;
  if (r.helix === 'straight' || r.helixAngle <= 0 || rp <= 0) return { zs: [0, fw], rotAt: null, twist: 0 };
  const k = r.hand * Math.tan(r.helixAngle * D2R) / rp;
  const total = Math.abs(k) * fw;
  const want = Math.max(2, Math.ceil(total / (3 * D2R) * clamp(q, 0.5, 2)));
  const n = clamp(want, 2, 160);
  const zs = [];
  if (r.helix === 'herringbone') {
    const h = Math.max(1, Math.round(n / 2));
    for (let i = 0; i <= h; i++) zs.push(fw * 0.5 * (i / h));
    for (let i = 1; i <= h; i++) zs.push(fw * 0.5 * (1 + i / h));
    return { zs, rotAt: (z) => k * (fw / 2 - Math.abs(z - fw / 2)), twist: total / 2 };
  }
  for (let i = 0; i <= n; i++) zs.push(fw * (i / n));
  return { zs, rotAt: (z) => k * z, twist: total };
}

// ---------------------------------------------------------------------------
// The parts
// ---------------------------------------------------------------------------

/** One external gear, resting on the plate, axis on the origin. */
function buildSpur(r, q, over = {}) {
  const teeth = over.teeth ?? r.teeth;
  const shift = over.shift ?? (r.autoShift ? autoProfileShift(teeth, r.pa) : r.shift);
  const sp = gearSpec({
    module: r.module, teeth, pressureAngle: r.pa, shift,
    backlash: r.backlash, clearance: r.clearance,
  });
  const outer = gearRing(sp, q);
  const rf = sp.rf;

  // Bore, then hub, then rim, each clamped to leave a printable wall.
  const wantBore = r.bore === 'none' ? 0 : r.boreDia + r.boreClear;
  const boreD = Math.min(wantBore, 2 * (rf - MIN_WALL));
  const hasBore = r.bore !== 'none' && boreD >= 0.8;
  const bore = hasBore ? boreRing(r.bore, boreD, r, q) : null;
  const boreOuter = hasBore ? boreD / 2 + (r.bore === 'keyway' ? clamp(r.keyDepth, 0.2, 1.2 * boreD / 2) : 0) : 0;

  const rRimIn = Math.max(1, rf - clamp(r.rimWidth, 0.4, rf * 0.9));
  const rHub = clamp(r.hubDia / 2, boreOuter + MIN_WALL, Math.max(boreOuter + MIN_WALL, rRimIn - MIN_WALL));
  const cuts = rHub + MIN_WALL < rRimIn ? webCuts(r.web, r.webCount, rHub, rRimIn, q) : [];

  const bossOn = r.boss && hasBore;
  let bossRing = null, bossH = 0;
  if (bossOn) {
    const rBoss = clamp(r.bossDia / 2, boreOuter + MIN_WALL, Math.max(boreOuter + MIN_WALL, r.web === 'solid' ? rf - 0.6 : rHub));
    bossRing = circle(rBoss, { segs: circSegs(rBoss, q, 24, 160) });
    bossH = r.bossHeight;
    bossRing.radius = rBoss;
  }

  const { zs, rotAt, twist } = helixLevels(r, sp.rp, q);
  let mesh = toothedSolid({
    outer, holes: cuts, faceWidth: r.faceWidth, rotAt, levels: zs,
    boss: bossRing, bore, bossH,
  });

  // The set-screw hole is the one feature that genuinely crosses a wall, so it
  // is the one place CSG earns its keep. Guarded to when it is asked for.
  let screw = null;
  if (bossOn && r.setScrew) {
    const rs = Math.min(r.setScrewDia / 2, 0.42 * bossH, 0.8 * (bossRing.radius - boreOuter));
    if (rs > 0.4) {
      const zc = r.faceWidth + bossH / 2;
      const len = bossRing.radius + 1.5;
      const tool = cylinder(rs, len, { segments: Math.max(12, Math.round(20 * q)), z0: 0 })
        .rotateY(Math.PI / 2).translate(0, 0, zc);
      mesh = subtract(mesh, tool);
      screw = { dia: 2 * rs, z: zc };
    }
  }
  return { mesh, sp, meta: {
    boreOuter, rHub, rRimIn, twist, screw, cuts: cuts.length, tipRadius: outer.tipRadius, undercut: outer.undercut,
    boreD: hasBore ? boreD : 0, rBoss: bossOn ? bossRing.radius : 0, bossH, zTop: r.faceWidth + bossH,
  } };
}

/** An internal ring gear: a rim with the toothed bore cut through it. */
function buildRing(r, q, over = {}) {
  const teeth = over.teeth ?? r.teeth;
  const sp = gearSpec({
    module: r.module, teeth, pressureAngle: r.pa, shift: 0,
    backlash: r.backlash, clearance: r.clearance, internal: true,
  });
  const inner = internalRing(sp, q);
  const rOut = sp.rf + clamp(r.rimWidth, 0.8, 60);
  let outer;
  if (r.ringOuter === 'hex') outer = regularPolygon(6, rOut / Math.cos(Math.PI / 6), { rot: 0 });
  else if (r.ringOuter === 'square') outer = roundRect(2 * rOut, 2 * rOut, Math.min(4, rOut * 0.3), { segs: Math.max(3, Math.round(5 * q)) });
  else outer = circle(rOut, { segs: circSegs(rOut, q, 48, 320) });

  const { zs, rotAt, twist } = helixLevels(r, sp.rp, q);
  // The teeth are the bore here, so the helix has to twist the HOLE, not the
  // outside — the outer rim of a ring gear is a plain prism.
  const mesh = new Mesh();
  const outerCCW = ccw(outer);
  const innerCW = cw(inner);
  const oLo = ringIdx(mesh, outerCCW, 0), oHi = ringIdx(mesh, outerCCW, r.faceWidth);
  strip(mesh, oLo, oHi);
  const levels = zs.map(z => {
    const rot = rotAt ? rotAt(z) : 0;
    const ring = rot ? innerCW.map(p => {
      const c = Math.cos(rot), s = Math.sin(rot);
      return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
    }) : innerCW;
    return { ring, idx: ringIdx(mesh, ring, z) };
  });
  for (let i = 1; i < levels.length; i++) strip(mesh, levels[i - 1].idx, levels[i].idx);
  cap(mesh, [outerCCW, levels[0].ring], [oLo, levels[0].idx], false);
  const top = levels[levels.length - 1];
  cap(mesh, [outerCCW, top.ring], [oHi, top.idx], true);
  return { mesh, sp, meta: { rOut, twist, tipRadius: inner.tipRadius, outer: outerCCW } };
}

/** A straight rack, lying on its side face with the teeth pointing +Y. */
function buildRack(r, q) {
  const sp = gearSpec({
    module: r.module, teeth: Math.max(20, r.rackTeeth), pressureAngle: r.pa,
    shift: 0, backlash: r.backlash, clearance: r.clearance,
  });
  const ring = rackRing(sp, { teeth: r.rackTeeth, base: r.rackBase, q });
  const holes = [];
  const holeList = [];
  if (r.rackHoles) {
    const baseH = ring.yRoot - ring.yBottom;
    const rh = Math.min(r.rackHoleDia / 2, 0.32 * baseH, 0.3 * ring.pitch);
    const len = ring.x1 - ring.x0;
    if (rh > 0.5 && len > 6 * rh) {
      const n = clamp(Math.floor(len / Math.max(18, 3 * ring.pitch)), 2, 24);
      const yc = (ring.yRoot + ring.yBottom) / 2;
      const inset = Math.max(2 * rh, len * 0.06);
      const segs = circSegs(rh, q, 12, 48);
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const cx = ring.x0 + inset + (len - 2 * inset) * t;
        holes.push(circle(rh, { segs, cx, cy: yc }));
        holeList.push({ cx, cy: yc, r: rh });
      }
    }
  }
  const shape = [ccw(ring), ...holes.map(cw)];
  const steps = r.helix === 'herringbone' ? 2 : 1;
  let mesh = extrude(shape, r.faceWidth, { steps, check: false });
  let topShift = 0;                                       // x shift of the top face after the shear
  if (r.helix !== 'straight' && r.helixAngle > 0) {
    const t = r.hand * Math.tan(r.helixAngle * D2R);
    const fw = r.faceWidth;
    const dx = r.helix === 'herringbone' ? (z) => t * (fw / 2 - Math.abs(z - fw / 2)) : (z) => t * z;
    mesh = mesh.mapVerts((x, y, z) => [x + dx(z), y, z]);   // a shear: det 1, winding safe
    topShift = dx(fw);
  }
  return { mesh, sp, meta: { length: ring.x1 - ring.x0, height: ring.yTip - ring.yBottom, holes: holes.length, ring, holeList, topShift } };
}

/** A planetary set, laid out assembled — which is also how it prints. */
function buildPlanetary(r, q) {
  const lay = planetaryLayout({
    module: r.module, sun: r.sunTeeth, planet: r.planetTeeth,
    ring: r.ringTeeth, count: r.planetCount, pressureAngle: r.pa,
  });
  const parts = [];
  const ringPart = buildRing({ ...r, teeth: lay.zr, web: 'solid' }, q);
  parts.push({ name: 'Ring', mesh: rotZ(ringPart.mesh, lay.ringRot) });

  const sunPart = buildSpur({ ...r, teeth: lay.zs, web: 'solid' }, q);
  parts.push({ name: 'Sun', mesh: rotZ(sunPart.mesh, lay.sunRot) });

  const planetProto = buildSpur({
    ...r, teeth: lay.zp, web: r.web, boss: false, setScrew: false,
    bore: r.bore === 'none' ? 'none' : 'round',
  }, q);
  for (const pl of lay.planets) {
    parts.push({ name: `Planet ${pl.index + 1}`, mesh: rotZ(planetProto.mesh, pl.rot).translate(pl.x, pl.y, 0) });
  }
  return { parts, lay, sunSpec: sunPart.sp, planetSpec: planetProto.sp, ringSpec: ringPart.sp, ringPart, sunPart };
}

function rotZ(mesh, a) { return a ? mesh.rotateZ(a) : mesh; }

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dimension callouts
// ---------------------------------------------------------------------------

/** The viewer's home elevation looks in from this XY direction, so the front of
 *  a gear — where an edge can be seen and dimensioned — is the side along it. */
const VIEW = [Math.cos(-Math.PI / 3), Math.sin(-Math.PI / 3)];

/** The vertex of a closed outline nearest the camera's left-front. Dead ahead
 *  would project to the bottom centre of the viewer, which on a large part is
 *  under the drawing-title card; 45° to the left is always in the clear. */
const FRONT_LEFT = [Math.cos(-105 * Math.PI / 180), Math.sin(-105 * Math.PI / 180)];
function frontmost(ring) {
  let best = ring[0], bd = -Infinity;
  for (const v of ring) { const d = v[0] * FRONT_LEFT[0] + v[1] * FRONT_LEFT[1]; if (d > bd) { bd = d; best = v; } }
  return best;
}

/** A declared value only when the built length is not the asked one (a clamp,
 *  a clearance) — the callout must say what is there, not what was typed. */
function realValue(p, key, len) {
  const asked = Number(p && p[key]);
  return Number.isFinite(asked) && Math.abs(len - asked) > 0.02 ? { value: len } : {};
}

/** Callouts for one build, in the coordinates the parts were built in (axis on
 *  the origin, resting on z = 0). The caller shifts them with the parts. Only
 *  lengths that exist as an edge on the object are declared; module, backlash,
 *  clearance, tooth counts and the helix angle are left to the viewer's leader
 *  note, because there is no edge on a gear that is any of those. */
function gearDims(r, p, built, span) {
  const dims = [];
  const o = Math.max(6, span * 0.12);
  const OUT = [VIEW[0] * o, VIEW[1] * o, 0], UP = [0, 0, o], PX = [o, 0, 0];
  const D = (param, label, from, to, offset) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (!(len > 1e-6)) return;
    dims.push({ param, label, from, to, offset, ...realValue(p, param, len) });
  };
  const rad = (rr, z) => [VIEW[0] * rr, VIEW[1] * rr, z];
  const fw = r.faceWidth;

  // One external gear body: the spur itself, or the sun of a planetary set.
  const spurDims = (g, { body = true } = {}) => {
    const sp = g.sp, m = g.meta;
    const rf = sp.rf - 0.05;                          // just inside the root circle: solid all round
    if (body) D('faceWidth', 'face', rad(rf, 0), rad(rf, fw), OUT);
    if (body) D('rimWidth', 'rim', rad(m.rRimIn, fw), rad(sp.rf, fw), UP);
    if (body && m.rHub > 0) D('hubDia', 'hub', [-m.rHub, 0, fw], [m.rHub, 0, fw], UP);
    if (m.boreD > 0) {
      const br = m.boreD / 2, zt = m.zTop;
      // A hex is sized across flats; with rot 0 the flats are normal to Y.
      if (r.bore === 'hex') D('boreDia', 'bore A/F', [0, -br, zt], [0, br, zt], UP);
      else D('boreDia', 'bore', [-br, 0, zt], [br, 0, zt], UP);
      if (r.bore === 'd-flat') {
        const d = clamp(r.flatDepth, 0.05, 1.7 * br);   // the flat is the chord at +X
        D('flatDepth', 'flat', [br - d, 0, zt], [br, 0, zt], UP);
      }
      if (r.bore === 'keyway') {
        const w = clamp(r.keyWidth, 0.4, 1.8 * br), d = clamp(r.keyDepth, 0.2, 1.2 * br);
        D('keyWidth', 'key', [-w / 2, br + d, zt], [w / 2, br + d, zt], UP);
        D('keyDepth', 'key', [0, br, zt], [0, br + d, zt], UP);
      }
    }
    if (m.rBoss > 0) {
      D('bossDia', 'boss', [-m.rBoss, 0, m.zTop], [m.rBoss, 0, m.zTop], UP);
      D('bossHeight', 'boss', rad(m.rBoss, fw), rad(m.rBoss, m.zTop), OUT);
      if (m.screw) {
        const rs = m.screw.dia / 2, zc = m.screw.z;   // the hole runs along +X through the boss wall
        D('setScrewDia', 'screw', [m.rBoss, 0, zc - rs], [m.rBoss, 0, zc + rs], PX);
      }
    }
  };

  // An internal ring: face on the outside wall, rim from the roots outward.
  const ringDims = (g, rot = 0) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const outer = rot ? g.meta.outer.map(([x, y]) => [x * c - y * s, x * s + y * c]) : g.meta.outer;
    const f = frontmost(outer);
    D('faceWidth', 'face', [f[0], f[1], 0], [f[0], f[1], fw], OUT);
    D('rimWidth', 'rim', rad(g.sp.rf, fw), rad(g.meta.rOut, fw), UP);
  };

  if (r.kind === 'spur') spurDims(built);
  else if (r.kind === 'ring') ringDims(built);
  else if (r.kind === 'planetary') {
    ringDims(built.ringPart, built.lay.ringRot);
    spurDims(built.sunPart, { body: false });
  } else if (r.kind === 'rack') {
    const m = built.meta, rg = m.ring, xs = m.topShift;
    // The rack lies on its side: teeth point +Y, length runs along X, the face
    // width is the extrusion. Its end faces are at x0 and x1; the +X end is
    // the one nearest the camera, and it projects under the drawing-title
    // card, so the callouts go on the −X end, which sits in the open.
    const NX = [-o, 0, 0];
    D('rackBase', 'base', [rg.x0 + xs, rg.yBottom, fw], [rg.x0 + xs, rg.yRoot, fw], NX);
    D('faceWidth', 'face', [rg.x0, rg.yBottom, 0], [rg.x0, rg.yBottom, fw], NX);
    if (m.holeList.length) {
      const h = m.holeList[0];                        // nearest the −X end
      D('rackHoleDia', 'hole', [h.cx - h.r + xs, h.cy, fw], [h.cx + h.r + xs, h.cy, fw], UP);
    }
  }
  return dims;
}

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
  '<circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1.6"/>' +
  '<path d="M12 2.2v3M12 18.8v3M2.2 12h3M18.8 12h3M5.1 5.1l2.1 2.1M16.8 16.8l2.1 2.1M18.9 5.1l-2.1 2.1M7.2 16.8l-2.1 2.1"/></svg>';

const gear = {
  id: 'gear',
  name: 'Involute Gear',
  category: 'Mechanism',
  blurb: 'Spur, helical, internal, rack and planetary gears on a true involute — they mesh because the maths says so.',
  description:
    'Gears with the real tooth form: the flank is the involute of the base circle and the root is the trochoid a rack ' +
    'cutter leaves, so a pair built here rolls at constant velocity and meshes at any centre distance instead of only ' +
    'the one it was drawn at. Low tooth counts get a profile shift to keep the cutter out of the base circle, and the ' +
    'validator tells you the number when it cannot. Backlash and root clearance are in printed millimetres, because ' +
    'that is the unit an FDM machine makes its mistakes in. Family: external spur, internal ring, rack and a ' +
    'printed-in-place planetary set, with helical or herringbone teeth, spokes or lightening holes, and a bore that ' +
    'can carry a D-flat, a keyway or a hex, with a set-screw boss on top.',
  icon: ICON,
  version: 1,

  params: [
    { key: 'kind', label: 'Type', type: 'enum', def: 'spur', group: 'Gear',
      help: 'External spur, internal ring, straight rack, or a whole planetary set laid out assembled.',
      options: [
        { v: 'spur', label: 'Spur / helical gear', help: 'The ordinary external gear.' },
        { v: 'ring', label: 'Internal ring gear', help: 'Teeth on the inside of a rim.' },
        { v: 'rack', label: 'Rack', help: 'A straight bar of teeth — rotation into travel.' },
        { v: 'planetary', label: 'Planetary set', help: 'Sun, planets and ring, printed in place.' },
      ] },
    { key: 'module', label: 'Module', type: 'number', def: 2, min: 0.4, max: 8, step: 0.1, unit: 'mm', group: 'Gear',
      help: 'Tooth size: pitch diameter ÷ tooth count. Both gears of a pair must share it. Under 1 mm is fragile on a 0.4 mm nozzle.' },
    { key: 'teeth', label: 'Teeth', type: 'int', def: 24, min: 5, max: 120, step: 1, group: 'Gear',
      help: 'Tooth count of this gear. Fewer than 17 at 20° would undercut, so a profile shift is applied.' },
    { key: 'pressureAngle', label: 'Pressure angle', type: 'enum', def: 20, group: 'Gear',
      help: 'The standard tooth slope. 20° unless you are matching an existing gear.',
      options: [
        { v: 14.5, label: '14.5° (old imperial)', help: 'Quieter, weaker, undercuts below 32 teeth.' },
        { v: 20, label: '20° (standard)', help: 'What almost everything uses.' },
        { v: 25, label: '25° (high load)', help: 'Stronger root, works down to 12 teeth.' },
      ] },
    { key: 'faceWidth', label: 'Face width', type: 'number', def: 8, min: 1, max: 60, step: 0.5, unit: 'mm', group: 'Gear',
      help: 'How thick the gear is. Three to five times the module is a sensible printed range.' },

    { key: 'helix', label: 'Tooth form', type: 'enum', def: 'straight', group: 'Teeth',
      help: 'Helical teeth engage gradually and run quieter; herringbone does the same with no axial thrust.',
      options: [
        { v: 'straight', label: 'Straight', help: 'Simplest, no thrust, prints with no overhang at all.' },
        { v: 'helical', label: 'Helical', help: 'Quieter and stronger, but pushes along the shaft.' },
        { v: 'herringbone', label: 'Herringbone', help: 'Two opposed helices: quiet and self-centring.' },
      ] },
    { key: 'helixAngle', label: 'Helix angle', type: 'number', def: 20, min: 5, max: 45, step: 1, unit: '°', group: 'Teeth',
      help: 'Measured at the pitch circle. Past about 45° the flanks start needing support.',
      showIf: (p) => p.helix !== 'straight' },
    { key: 'hand', label: 'Hand', type: 'enum', def: 'right', group: 'Teeth',
      help: 'A helical pair must be opposite hands. Ignored for herringbone.',
      options: [{ v: 'right', label: 'Right hand' }, { v: 'left', label: 'Left hand' }],
      showIf: (p) => p.helix === 'helical' },
    { key: 'backlash', label: 'Backlash', type: 'number', def: 0.25, min: 0, max: 1.2, step: 0.05, unit: 'mm', group: 'Teeth',
      help: 'Total circumferential play in the pair, taken half off each gear. 0.2–0.3 mm suits this printer; 0 makes gears that bind.' },
    { key: 'clearance', label: 'Root clearance', type: 'number', def: 0.2, min: 0, max: 1.2, step: 0.05, unit: 'mm', group: 'Teeth',
      help: 'Extra depth cut below the mating tip circle, on top of the standard 0.25 × module. Absorbs elephant\'s foot.' },
    { key: 'autoShift', label: 'Avoid undercut automatically', type: 'bool', def: true, group: 'Teeth',
      help: 'Applies the smallest profile shift that keeps the cutter out of the base circle on low tooth counts.' },
    { key: 'shift', label: 'Profile shift', type: 'number', def: 0, min: -0.6, max: 1, step: 0.05, unit: '×m', group: 'Teeth',
      help: 'Manual shift in modules. Positive fattens the tooth root and moves the pair apart; use +x on the pinion and −x on the wheel to keep the centre distance.',
      showIf: (p) => p.autoShift === false },

    { key: 'bore', label: 'Bore', type: 'enum', def: 'round', group: 'Bore',
      help: 'How the gear grips its shaft.',
      options: [
        { v: 'none', label: 'None (solid)' },
        { v: 'round', label: 'Round', help: 'Plain hole; add a set screw to stop it slipping.' },
        { v: 'd-flat', label: 'D-flat', help: 'One flat — matches a motor shaft with a milled flat.' },
        { v: 'keyway', label: 'Keyway', help: 'A square slot for a parallel key.' },
        { v: 'hex', label: 'Hex', help: 'Across-flats size, for a hex shaft or a bolt.' },
      ] },
    { key: 'boreDia', label: 'Bore size', type: 'number', def: 5, min: 1, max: 60, step: 0.1, unit: 'mm', group: 'Bore',
      help: 'Nominal shaft size — across flats for a hex bore.', showIf: (p) => p.bore !== 'none' },
    { key: 'boreClear', label: 'Bore clearance', type: 'number', def: FIT.snug, min: 0, max: 0.8, step: 0.05, unit: 'mm', group: 'Bore',
      help: 'Added to the bore diameter. FDM holes print undersize; 0.1–0.2 mm gives a push fit on this machine.',
      showIf: (p) => p.bore !== 'none' },
    { key: 'flatDepth', label: 'Flat depth', type: 'number', def: 0.5, min: 0.1, max: 8, step: 0.1, unit: 'mm', group: 'Bore',
      help: 'How far the D-flat cuts into the bore.', showIf: (p) => p.bore === 'd-flat' },
    { key: 'keyWidth', label: 'Key width', type: 'number', def: 2, min: 0.5, max: 12, step: 0.1, unit: 'mm', group: 'Bore',
      help: 'Width of the keyway slot.', showIf: (p) => p.bore === 'keyway' },
    { key: 'keyDepth', label: 'Key depth', type: 'number', def: 1.2, min: 0.2, max: 6, step: 0.1, unit: 'mm', group: 'Bore',
      help: 'How far the keyway stands out beyond the bore wall.', showIf: (p) => p.bore === 'keyway' },

    { key: 'hubDia', label: 'Hub diameter', type: 'number', def: 14, min: 3, max: 120, step: 0.5, unit: 'mm', group: 'Body',
      help: 'Solid material around the bore. Spokes and holes start outside it.' },
    { key: 'rimWidth', label: 'Rim width', type: 'number', def: 4, min: 0.8, max: 30, step: 0.5, unit: 'mm', group: 'Body',
      help: 'Solid material under the tooth roots. Below about 3 × module the roots crack.' },
    { key: 'web', label: 'Web', type: 'enum', def: 'solid', group: 'Body',
      help: 'What to remove between the hub and the rim.',
      options: [
        { v: 'solid', label: 'Solid' },
        { v: 'holes', label: 'Lightening holes', help: 'Round holes: safe, no stress risers.' },
        { v: 'spokes', label: 'Spokes', help: 'Removes more; corners are rounded.' },
      ] },
    { key: 'webCount', label: 'Spokes / holes', type: 'int', def: 5, min: 2, max: 14, step: 1, group: 'Body',
      help: 'How many. An odd number stops the whole web flexing as one diameter.',
      showIf: (p) => p.web !== 'solid' },
    { key: 'ringOuter', label: 'Ring outside', type: 'enum', def: 'round', group: 'Body',
      help: 'The outside of an internal ring gear — a hex or square is easy to hold in a printed housing.',
      options: [{ v: 'round', label: 'Round' }, { v: 'hex', label: 'Hex' }, { v: 'square', label: 'Rounded square' }],
      showIf: (p) => p.kind === 'ring' || p.kind === 'planetary' },

    { key: 'boss', label: 'Set-screw boss', type: 'bool', def: false, group: 'Hub',
      help: 'A raised collar around the bore, so the grub screw has something to bite that is not the tooth face.',
      showIf: (p) => p.kind === 'spur' },
    { key: 'bossDia', label: 'Boss diameter', type: 'number', def: 12, min: 3, max: 80, step: 0.5, unit: 'mm', group: 'Hub',
      showIf: (p) => p.boss && p.kind === 'spur', help: 'Outside of the collar. Clamped to fit inside the web.' },
    { key: 'bossHeight', label: 'Boss height', type: 'number', def: 6, min: 0.5, max: 50, step: 0.5, unit: 'mm', group: 'Hub',
      showIf: (p) => p.boss && p.kind === 'spur', help: 'How far the collar stands above the gear face.' },
    { key: 'setScrew', label: 'Set-screw hole', type: 'bool', def: false, group: 'Hub',
      help: 'A radial hole through the boss into the bore. Tap it, or print it 0.2 mm under and force an M3 in.',
      showIf: (p) => p.boss && p.kind === 'spur' },
    { key: 'setScrewDia', label: 'Set-screw hole', type: 'number', def: 3.2, min: 1, max: 10, step: 0.1, unit: 'mm', group: 'Hub',
      help: 'M3 clearance is 3.2; for a self-tapped M3 use 2.6.',
      showIf: (p) => p.boss && p.setScrew && p.kind === 'spur' },

    { key: 'sunTeeth', label: 'Sun teeth', type: 'int', def: 12, min: 6, max: 80, step: 1, group: 'Planetary',
      help: 'The centre gear. Reduction with the ring held is 1 + ring ÷ sun.', showIf: (p) => p.kind === 'planetary' },
    { key: 'planetTeeth', label: 'Planet teeth', type: 'int', def: 18, min: 6, max: 80, step: 1, group: 'Planetary',
      help: 'Each planet. Ring must equal sun + 2 × planet for the set to close.', showIf: (p) => p.kind === 'planetary' },
    { key: 'ringTeeth', label: 'Ring teeth', type: 'int', def: 48, min: 16, max: 200, step: 1, group: 'Planetary',
      help: 'The internal gear. Must be sun + 2 × planet, and (sun + ring) must divide by the planet count.',
      showIf: (p) => p.kind === 'planetary' },
    { key: 'planetCount', label: 'Planets', type: 'int', def: 3, min: 2, max: 10, step: 1, group: 'Planetary',
      help: 'Equally spaced. Three is the usual compromise between load sharing and jamming.',
      showIf: (p) => p.kind === 'planetary' },

    { key: 'rackTeeth', label: 'Rack teeth', type: 'int', def: 12, min: 2, max: 80, step: 1, group: 'Rack',
      help: 'Length is teeth × π × module. Butt several together for a longer run.', showIf: (p) => p.kind === 'rack' },
    { key: 'rackBase', label: 'Rack base', type: 'number', def: 6, min: 1, max: 40, step: 0.5, unit: 'mm', group: 'Rack',
      help: 'Material below the tooth roots, where the mounting holes go.', showIf: (p) => p.kind === 'rack' },
    { key: 'rackHoles', label: 'Mounting holes', type: 'bool', def: true, group: 'Rack',
      help: 'Through-holes along the base, on the print axis so they come out round.', showIf: (p) => p.kind === 'rack' },
    { key: 'rackHoleDia', label: 'Hole diameter', type: 'number', def: 3.4, min: 1, max: 10, step: 0.1, unit: 'mm', group: 'Rack',
      help: 'M3 clearance is 3.4.', showIf: (p) => p.kind === 'rack' && p.rackHoles },
  ],

  presets: [
    { name: 'Printed-in-place planetary', values: {
      kind: 'planetary', module: 1.5, pressureAngle: 20, faceWidth: 8,
      sunTeeth: 12, planetTeeth: 18, ringTeeth: 48, planetCount: 3,
      backlash: 0.35, clearance: 0.25, bore: 'round', boreDia: 5, rimWidth: 4,
      web: 'solid', ringOuter: 'hex', boss: false, helix: 'straight' } },
    { name: 'Motor pinion, 5 mm D-shaft', values: {
      kind: 'spur', module: 1.5, teeth: 12, faceWidth: 8, autoShift: true,
      bore: 'd-flat', boreDia: 5, boreClear: 0.15, flatDepth: 0.5,
      boss: true, bossDia: 11, bossHeight: 7, setScrew: true, setScrewDia: 2.6,
      web: 'solid', rimWidth: 3, backlash: 0.2 } },
    { name: 'Lightweight spoked wheel', values: {
      kind: 'spur', module: 2, teeth: 60, faceWidth: 8, web: 'spokes', webCount: 5,
      hubDia: 20, rimWidth: 5, bore: 'keyway', boreDia: 8, keyWidth: 3, keyDepth: 1.4,
      boss: false, backlash: 0.25 } },
    { name: 'Quiet herringbone drive wheel', values: {
      kind: 'spur', module: 2, teeth: 40, faceWidth: 14, helix: 'herringbone',
      helixAngle: 25, web: 'holes', webCount: 6, hubDia: 18, rimWidth: 5,
      bore: 'round', boreDia: 8, boss: false, backlash: 0.3 } },
    { name: 'Rack for a linear stage', values: {
      kind: 'rack', module: 2, rackTeeth: 16, rackBase: 7, faceWidth: 10,
      rackHoles: true, rackHoleDia: 3.4, backlash: 0.25, helix: 'straight' } },
    { name: 'Ring gear, hex mount', values: {
      kind: 'ring', module: 1.5, teeth: 48, faceWidth: 10, rimWidth: 5,
      ringOuter: 'hex', backlash: 0.3, clearance: 0.25 } },
  ],

  build(p, ctx = {}) {
    const q = clamp(num(ctx.segFactor, 1), 0.25, 4);
    const r = resolve(p || {});
    let parts = [];
    let meta = { kind: r.kind, module: r.module, pressureAngle: r.pa };
    let built = null;

    if (r.kind === 'planetary') {
      const pl = buildPlanetary(r, q);
      built = pl;
      parts = pl.parts;
      meta = {
        ...meta, teeth: { sun: pl.lay.zs, planet: pl.lay.zp, ring: pl.lay.zr },
        planets: pl.lay.N, ratio: pl.lay.ratio, centreDistance: pl.lay.centre,
        assembles: pl.lay.fits && pl.lay.spaced, pitchDia: pl.lay.zr * r.module,
      };
    } else if (r.kind === 'rack') {
      const rk = buildRack(r, q);
      built = rk;
      parts = [{ name: 'Rack', mesh: rk.mesh }];
      meta = { ...meta, teeth: r.rackTeeth, length: rk.meta.length, pitch: Math.PI * r.module, holes: rk.meta.holes };
    } else if (r.kind === 'ring') {
      const rg = buildRing(r, q);
      built = rg;
      parts = [{ name: 'Ring gear', mesh: rg.mesh }];
      meta = { ...meta, teeth: rg.sp.teeth, pitchDia: rg.sp.pitchDia, tipDia: rg.sp.tipDia, rootDia: rg.sp.rootDia, outerDia: 2 * rg.meta.rOut };
    } else {
      const g = buildSpur(r, q);
      built = g;
      parts = [{ name: 'Gear', mesh: g.mesh }];
      meta = {
        ...meta, teeth: g.sp.teeth, shift: g.sp.shift,
        pitchDia: g.sp.pitchDia, baseDia: g.sp.baseDia, tipDia: 2 * g.meta.tipRadius,
        rootDia: g.sp.rootDia, undercutMm: g.meta.undercut, twistDeg: g.meta.twist / D2R,
        setScrew: g.meta.screw,
      };
    }

    // One translation for the whole assembly, applied to every part, so the
    // parts stay where they belong relative to each other.
    const merged = Mesh.merge(parts.map(x => x.mesh));
    const b = merged.bbox();
    const dx = -b.center[0], dy = -b.center[1], dz = -b.min[2];
    const placed = parts.map(x => ({ name: x.name, mesh: x.mesh.translate(dx, dy, dz) }));
    meta.axis = [dx, dy];
    const sh = (v) => [v[0] + dx, v[1] + dy, v[2] + dz];
    meta.dims = gearDims(r, p || {}, built, Math.max(b.size[0], b.size[1], b.size[2]))
      .map(d => ({ ...d, from: sh(d.from), to: sh(d.to) }));
    return { mesh: Mesh.merge(placed.map(x => x.mesh)), parts: placed, meta };
  },

  validate(p) {
    const r = resolve(p || {});
    const out = [];
    const nozzle = 0.4, bed = 180;
    const say = (param, severity, message) => out.push({ param, severity, message });

    // --- tooth form -------------------------------------------------------
    const lim = undercutLimit(r.pa);
    if (r.kind !== 'rack') {
      const z = r.kind === 'planetary' ? Math.min(r.sunTeeth, r.planetTeeth) : r.teeth;
      if (r.kind !== 'ring' && z < lim - 1e-9) {
        const need = minProfileShift(z, r.pa);
        if (r.autoShift) {
          say('teeth', 'info', `${z} teeth is below the ${lim.toFixed(1)}-tooth undercut limit at ${r.pa}°, so a profile shift of +${need.toFixed(3)}×m has been applied. Its mate should carry −${need.toFixed(3)}×m to keep the centre distance.`);
        } else if (r.shift < need - 1e-6) {
          say('shift', 'error', `Undercut: ${z} teeth is below the ${lim.toFixed(1)}-tooth limit at ${r.pa}° and the profile shift is ${r.shift.toFixed(2)}×m, under the ${need.toFixed(3)}×m needed. The cutter will eat the base of the flank and the tooth will be weak and noisy.`);
        }
      }
    }
    const toothTip = Math.max(0, r.module * (Math.PI / 2) - r.backlash / 2 - 2 * r.module * Math.tan(r.pa * D2R));
    if (toothTip < 2 * nozzle) {
      say('module', 'error', `Module ${r.module} mm leaves a ${toothTip.toFixed(2)} mm tooth tip — under two ${nozzle} mm extrusions, so the teeth print as single hollow walls. Use module ≥ ${(2.4 / (Math.PI / 2 - 2 * Math.tan(r.pa * D2R))).toFixed(1)} mm.`);
    } else if (toothTip < 3 * nozzle) {
      say('module', 'warn', `Tooth tips are only ${toothTip.toFixed(2)} mm wide — two extrusions with nothing between them. Expect weak teeth.`);
    }
    if (r.backlash <= 0 && r.kind !== 'planetary') say('backlash', 'warn', 'Zero backlash: an FDM pair at nominal size will bind. 0.2–0.3 mm is the usual figure on this machine.');
    if (r.backlash <= 0 && r.kind === 'planetary') say('backlash', 'error', 'A printed-in-place planetary with zero backlash fuses into one lump. Use at least 0.3 mm.');
    if (r.faceWidth < 1.0) say('faceWidth', 'error', `A ${r.faceWidth} mm face is five layers at 0.2 mm — it will curl off the plate.`);

    // --- planetary arithmetic --------------------------------------------
    if (r.kind === 'planetary') {
      const need = r.sunTeeth + 2 * r.planetTeeth;
      if (r.ringTeeth !== need) {
        say('ringTeeth', 'error', `Planetary will not close: ring must equal sun + 2 × planet, but ${r.ringTeeth} ≠ ${r.sunTeeth} + 2 × ${r.planetTeeth} = ${need}. Set the ring to ${need} teeth, or the planet to ${((r.ringTeeth - r.sunTeeth) / 2).toFixed(1)}.`);
      }
      const sum = r.sunTeeth + r.ringTeeth;
      if (sum % r.planetCount !== 0) {
        say('planetCount', 'error', `Planets cannot be equally spaced: (sun + ring) = ${r.sunTeeth} + ${r.ringTeeth} = ${sum} must divide by ${r.planetCount} planets, and ${sum} ÷ ${r.planetCount} = ${(sum / r.planetCount).toFixed(3)}. Use ${[2, 3, 4, 5, 6].filter(n => sum % n === 0).join(' or ') || 'a divisor of ' + sum} planets.`);
      }
      const lay = planetaryLayout({ module: r.module, sun: r.sunTeeth, planet: r.planetTeeth, ring: r.ringTeeth, count: r.planetCount });
      if (lay.planetGap < 1) {
        say('planetCount', 'error', `Neighbouring planets collide: ${r.planetCount} planets on a ${lay.centre.toFixed(1)} mm circle leaves ${lay.planetGap.toFixed(2)} mm between tip circles. Use fewer planets or a smaller planet.`);
      } else if (lay.planetGap < 2) {
        say('planetCount', 'warn', `Only ${lay.planetGap.toFixed(2)} mm between planet tip circles — they will not touch, but there is no room for error.`);
      }
      const outer = r.module * (r.ringTeeth / 2 + 1.25) + r.rimWidth;
      if (2 * outer > bed) say('module', 'error', `The ring is ${(2 * outer).toFixed(0)} mm across and the bed is ${bed} mm. Drop the module to ${(r.module * bed / (2 * outer) * 0.98).toFixed(1)} mm or below.`);
    }

    // --- ring gear --------------------------------------------------------
    if (r.kind === 'ring') {
      if (r.teeth < 20) say('teeth', 'warn', `An internal gear with ${r.teeth} teeth has its tip circle well inside its base circle; the flank below the base circle is a straight radial and the mesh will be rough.`);
      const outer = r.module * (r.teeth / 2 + 1.25) + r.rimWidth + r.clearance;
      if (2 * outer > bed) say('teeth', 'error', `Ring is ${(2 * outer).toFixed(0)} mm across, over the ${bed} mm bed.`);
      if (r.rimWidth < 2.5 * r.module) say('rimWidth', 'warn', `A ${r.rimWidth} mm rim on a module ${r.module} ring is thin; the roots are the thinnest section of a ring gear. ${(2.5 * r.module).toFixed(1)} mm or more.`);
    }

    // --- external gear body ----------------------------------------------
    if (r.kind === 'spur') {
      const sp = gearSpec({ module: r.module, teeth: r.teeth, pressureAngle: r.pa, shift: r.shift, backlash: r.backlash, clearance: r.clearance });
      if (sp.tipDia > bed) say('teeth', 'error', `Tip diameter is ${sp.tipDia.toFixed(0)} mm and the bed is ${bed} mm. At module ${r.module} the most that fits is ${Math.floor(bed / r.module - 2 - 2 * r.shift)} teeth.`);
      if (r.bore !== 'none') {
        const boreR = (r.boreDia + r.boreClear) / 2 + (r.bore === 'keyway' ? r.keyDepth : 0);
        const wall = sp.rf - boreR;
        if (wall < MIN_WALL) say('boreDia', 'error', `A ${r.boreDia} mm bore leaves ${wall.toFixed(2)} mm of material under the tooth roots — the gear is a ring of teeth with nothing behind them. Largest bore here is ${(2 * (sp.rf - MIN_WALL)).toFixed(1)} mm.`);
        else if (wall < 2.5 * r.module) say('boreDia', 'warn', `Only ${wall.toFixed(1)} mm between the bore and the tooth roots; ${(2.5 * r.module).toFixed(1)} mm is the usual minimum.`);
        if (r.bore === 'hex' && r.boreDia < 3) say('boreDia', 'warn', 'A hex bore under 3 mm across flats will print as a rough circle.');
      }
      if (r.rimWidth < 2 * r.module) say('rimWidth', 'warn', `Rim is ${r.rimWidth} mm under the roots; below 2 × module (${(2 * r.module).toFixed(1)} mm) the roots crack away from the web.`);
      if (r.web !== 'solid') {
        const rRimIn = sp.rf - r.rimWidth, rHub = r.hubDia / 2;
        if (rHub + MIN_WALL >= rRimIn) say('web', 'warn', `No room for ${r.web}: the hub reaches ${rHub.toFixed(1)} mm and the rim starts at ${rRimIn.toFixed(1)} mm. Built solid instead.`);
      }
      if (r.boss) {
        if (r.bore === 'none') say('boss', 'warn', 'A boss with no bore is just a stub — it has been left off.');
        if (r.setScrew) {
          const wall = r.bossDia / 2 - (r.boreDia + r.boreClear) / 2;
          if (wall < r.setScrewDia * 0.6) say('bossDia', 'warn', `Only ${wall.toFixed(1)} mm of boss wall for a ${r.setScrewDia} mm screw hole; the thread will have almost nothing to grip. Boss ≥ ${(r.boreDia + 2.5 * r.setScrewDia).toFixed(0)} mm.`);
          if (r.setScrewDia > 0.85 * r.bossHeight) say('bossHeight', 'warn', `A ${r.setScrewDia} mm hole through a ${r.bossHeight} mm boss breaks out of the top and bottom. Boss ≥ ${(1.6 * r.setScrewDia).toFixed(1)} mm tall.`);
        }
      }
      if (r.helix !== 'straight' && r.helixAngle > 45) say('helixAngle', 'warn', `A ${r.helixAngle}° helix puts the flanks past 45° from vertical; the slicer will want supports between the teeth.`);
      if (r.helix === 'helical' && r.faceWidth < 4 * r.module) say('faceWidth', 'warn', 'A helical gear narrower than about 4 × module never gets a full tooth into contact, so it is just a noisy spur gear with axial thrust.');
    }

    // --- rack -------------------------------------------------------------
    if (r.kind === 'rack') {
      const len = r.rackTeeth * Math.PI * r.module;
      if (len > bed) say('rackTeeth', 'error', `A ${r.rackTeeth}-tooth rack at module ${r.module} is ${len.toFixed(0)} mm long and the bed is ${bed} mm. ${Math.floor(bed / (Math.PI * r.module))} teeth fit.`);
      if (r.rackHoles && r.rackHoleDia > 0.64 * r.rackBase) say('rackHoleDia', 'warn', `A ${r.rackHoleDia} mm hole in a ${r.rackBase} mm base leaves under 1 mm either side; the base will tear along the holes.`);
    }
    return out;
  },

  hints(p) {
    const r = resolve(p || {});
    const nozzle = 0.4;
    const notes = [];
    const helical = r.helix !== 'straight';
    const supports = helical && r.helixAngle > 50;

    notes.push(`Print flat on a gear face — every tooth surface is then a vertical wall, so the flanks come out at full resolution and a tooth loaded in bending breaks across the layers rather than between them.`);
    notes.push(`Turn ELEPHANT'S FOOT COMPENSATION on (about ${(0.15).toFixed(2)} mm). The first layer squashes outward, and on a gear that lands exactly on the tooth flanks: the bottom 0.2 mm of every tooth ends up fat and the pair binds at one point per revolution. This is the single most common reason a printed gear "does not fit".`);
    const walls = Math.max(3, Math.ceil((r.module * 1.4) / (2 * nozzle)));
    notes.push(`Use ${walls} perimeters or more. At module ${r.module} the tooth is about ${(r.module * 1.6).toFixed(1)} mm thick at the pitch line, so ${walls} walls each side makes the tooth solid perimeter with no infill inside it — which is what carries the load.`);
    notes.push(`0.2 mm layers. Finer buys nothing here: the flanks are vertical, so layer height changes the tooth profile not at all, and only costs time.`);
    notes.push(`Infill 40 % gyroid in the web is plenty; the rim and the hub are already solid from the perimeter count.`);
    if (supports) notes.push(`A ${r.helixAngle}° helix leaves flanks past 45° from vertical — switch supports on, or drop to 45°.`);
    else notes.push('No supports. Nothing here overhangs.');
    if (r.kind === 'planetary') {
      notes.push(`Printed in place: the whole set comes off the bed assembled. Do not use a brim — it welds the parts together at the first layer. Break it free with a gentle twist before it cools completely.`);
      notes.push(`Backlash ${r.backlash} mm is the gap between every meshing pair. Under 0.3 mm the parts fuse; the sun will not turn.`);
    }
    if (r.kind === 'rack') notes.push('The rack prints on its side with the teeth pointing along the bed. The mounting holes are on the print axis, so they come out round without a support or a teardrop.');
    if (r.boss && r.setScrew) notes.push(`The set-screw hole is horizontal, so its top will sag by a layer or two. Drill or ream it through before tapping — or print the gear with the boss down and the hole comes out round.`);
    if (r.bore !== 'none') notes.push(`Bore is ${(r.boreDia + r.boreClear).toFixed(2)} mm modelled for a ${r.boreDia} mm shaft. Holes come out undersize on FDM; if it is tight, add clearance rather than reaming, which tears the layers.`);
    notes.push('Cooling to 100 % after the first layer. The layers on a gear are small and each one has little time to set before the nozzle comes round again.');

    return {
      profile: r.module < 1 ? '0.15 mm fine' : '0.20 mm standard',
      layerH: r.module < 1 ? 0.15 : 0.2,
      walls,
      infill: 40,
      supports,
      filament: 'PLA for stiffness and dimensional accuracy; PETG only if it will be near a motor that gets hot, and add 0.05 mm of backlash for it.',
      notes,
    };
  },
};

export default gear;
