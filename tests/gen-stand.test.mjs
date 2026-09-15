// tests/gen-stand.test.mjs — the stand, weighed rather than eyeballed.
//
// A stand makes three promises and only gravity checks them, so this suite
// checks them the way you would check a stand you had just taken off the plate:
// put a feeler gauge in the slot PERPENDICULAR to the device, put a protractor
// on the face it leans against, and then put the whole thing on a scale and work
// out whether it falls over with the tablet in it.
//
// Nothing here trusts `meta` on its own. Every number that matters — the slot,
// the angle, the lip, the cable channel, the socket — is measured off the
// triangles with rays, and `meta` is then checked to agree, which makes it a
// cross-check between the declaration and the geometry rather than a
// restatement of it. The tipping arithmetic is deliberately a SECOND
// implementation: its own centre of mass, its own convex hull, its own
// point-in-polygon margin, so a sign error shared with the generator cannot
// pass both.
//
// Coordinates. build() drops the whole set onto the plate with one translation,
// so a design coordinate (where g.Q, g.u and g.n live) maps into the delivered
// mesh by that same offset — `rig()` recovers it, which is how these probes can
// aim at a face the solver described and read back what actually got built.

import { suite, check as baseCheck, near as baseNear, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import {
  triGrid, rayMeshHit, rayMeshCount, pointInsideMesh, printability, analyze, FILAMENT_DENSITY,
} from '../js/kernel/validate.js';
import gen, { realise, nominalSocket } from '../js/gen/stand.js';

suite('gen-stand');

// Everything below the conformance call is domain-specific — about stands, not
// about the shared harness. These wrappers count them, so the gate's "at least
// 14 domain checks" is a number the run prints rather than one you have to take
// on trust. They are otherwise `check` and `near` exactly.
let domain = 0;
const check = (...a) => { domain++; return baseCheck(...a); };
const near = (...a) => { domain++; return baseNear(...a); };

const R2D = 180 / Math.PI;
const C = ctx('normal');
const P0 = defaults(gen);

// ---------------------------------------------------------------------------
// Measuring instruments
// ---------------------------------------------------------------------------

/**
 * Build a parameter set and hand back everything needed to probe it:
 *   .mesh/.grid  the delivered solid and a ray grid over it
 *   .at(p)       a design-coordinate point, moved into the delivered mesh
 *   .un(u, n, y) a point given in the DEVICE's own axes — u up its face, n out
 *                of its screen — which is the frame every cradle claim is made in
 *   .U/.N        those two axes as world directions, for aiming rays
 *   .clearY      a Y that is inside the stand but clear of the cable channel
 */
function rig(over = {}, q = C) {
  const p = { ...P0, ...over };
  const { g, geo, tip } = realise(p, q);
  const r = gen.build(p, q);
  const a = geo.mesh.bbox().min, b = r.mesh.bbox().min;
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const at = (pt) => [pt[0] + d[0], pt[1] + d[1], pt[2] + d[2]];
  const un = (uu, nn, y = 0) => at([
    g.Q[0] + g.u[0] * uu + g.n[0] * nn, y, g.Q[1] + g.u[1] * uu + g.n[1] * nn]);
  return {
    p, g, geo, tip, r, meta: r.meta, mesh: r.mesh, grid: triGrid(r.mesh), at, un,
    U: [g.u[0], 0, g.u[1]], N: [g.n[0], 0, g.n[1]],
    clearY: Math.min(g.standW / 2 - 1, g.port + g.cableW / 2 + 6),
  };
}

/** The band of u the cradle's two faces are both flat in — clear of every fillet. */
function slotWindow(g) {
  const lo = Math.max(g.slotR, 0.5) + 0.6;
  const hi = g.lipH - g.lipR - 0.3;
  return { lo, hi, mid: (lo + hi) / 2 };
}

/**
 * The slot, measured PERPENDICULAR to the device: one ray from the middle of the
 * slot along -n into the back rest, one along +n into the lip. Their sum is the
 * gap the device has to fit through, and it is the only measurement of it that
 * means anything — a ruler laid flat on the desk reads S/sin(angle) instead.
 */
function slotWidth(R, y, uu = slotWindow(R.g).mid) {
  const o = R.un(uu, R.g.S / 2, y);
  const back = rayMeshHit(R.grid, o, [-R.N[0], 0, -R.N[2]]);
  const front = rayMeshHit(R.grid, o, R.N);
  return back && front ? back.t + front.t : null;
}

/**
 * The angle of the face the device leans on, off the mesh. Two rays fired
 * perpendicular at the rest, at two heights well clear of the fillets at either
 * end of it; the line between where they land IS the face, and its slope is the
 * viewing angle. No number from solve() is involved beyond where to aim.
 */
function restAngle(R, y) {
  const g = R.g;
  const lo = Math.max(g.slotR, 0.5) + 1.0;
  const hi = g.restH - Math.min(g.cornerR, g.restH * 0.4) - 1.0;
  if (hi - lo < 3) return null;
  const pts = [];
  for (const uu of [lo, hi]) {
    const h = rayMeshHit(R.grid, R.un(uu, g.S / 2, y), [-R.N[0], 0, -R.N[2]]);
    if (!h) return null;
    pts.push(h.point);
  }
  return Math.atan2(pts[1][2] - pts[0][2], pts[1][0] - pts[0][0]) * R2D;
}

/**
 * How far the lip stands up the face of the device: a ray started inside the lip
 * and fired up the device's own axis, so what comes back is a retention height
 * and not a height above the desk.
 */
/**
 * How far up the device's face the lip presents a FLAT surface — that is, where
 * the fillet on top of it starts. Marched by ray-casting straight across the
 * slot: while the lip's inner face is flat the crossing sits exactly S/2 away,
 * and once the fillet curves the surface back the crossing moves.
 *
 * This exists because measuring the lip's OVERALL height measures the one number
 * that was never wrong. The fillet is taken out of the retaining face, so a lip
 * that met the retention floor on paper presented 2.10 mm of flat against a
 * stated 3.36 mm — a third short, in the only place it has to hold anything up.
 */
function flatLipFace(R, y) {
  const g = R.g;
  const half = g.S / 2;
  let best = null;
  for (let u = 0.2; u <= g.lipH + 2; u += 0.02) {
    const o = R.un(u, half, y);
    if (pointInsideMesh(R.grid, o)) continue;
    const h = rayMeshHit(R.grid, o, R.N);
    if (h && Math.abs(h.t - half) < 0.02) best = u;
    else if (best !== null) break;
  }
  return best;
}

function lipHeight(R, y) {
  const g = R.g;
  const u0 = Math.min(1.0, g.lipH * 0.3);
  const o = R.un(u0, g.S + g.lipT / 2, y);
  if (!pointInsideMesh(R.grid, o)) return null;
  const h = rayMeshHit(R.grid, o, R.U);
  return h ? u0 + h.t : null;
}

// --- the easel's sockets sit over the cable route ---------------------------
{
  // The groove runs back UNDER the sockets and the sockets are notches cut DOWN
  // into the same top face, so the two meet inside the base. At the default
  // 6 mm base the socket floor is at 1.20 mm and the groove roof at 3.50: the
  // route came out through the floor of every socket, a cableW-wide hole exactly
  // where the prop's foot has to bear. Probed in the SOLID, because the fix has
  // two branches — lower the groove, or stop it short — and only the material
  // under the socket tells you whether either worked.
  for (const baseT of [1.6, 4, 6, 8.5, 12, 20]) {
    const R = rig({ style: 'easel', arrange: 'assembled', baseT, cable: true });
    const g = R.g;
    if (!g.sockets || !g.cable) continue;
    const floorZ = g.baseT - g.td;
    let solid = 0;
    for (const sk of g.sockets) {
      const x = sk.x + g.propW / 2;
      // Just under the socket floor, in the middle of the cable band — the exact
      // material the groove used to take away.
      const probe = R.at([x, g.port, Math.max(0.2, floorZ - Math.min(0.4, floorZ / 2))]);
      if (pointInsideMesh(R.grid, probe)) solid++;
    }
    check(`easel base ${baseT} mm: the cable route leaves a floor under every socket`,
      solid === g.sockets.length,
      `${solid}/${g.sockets.length} sockets have material beneath them (floor ${floorZ.toFixed(2)} mm, groove roof ${g.grooveH.toFixed(2)} mm${g.grooveShort ? ', route stopped short' : ''})`);
  }
}

// --- the tipping arithmetic, written a second time --------------------------

/** Volume and centre of mass of a closed mesh: divergence theorem, tetra by tetra. */
function centroid3(mesh) {
  const p = mesh.positions, t = mesh.tris;
  let V = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    V += v; mx += v * (ax + bx + cx) / 4; my += v * (ay + by + cy) / 4; mz += v * (az + bz + cz) / 4;
  }
  return { volume: V, centre: [mx / V, my / V, mz / V] };
}

/** Convex hull, CCW, gift-wrapped by monotone chain. */
function hull(pts) {
  const p = pts.map(q => [q[0], q[1]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** Distance from a point to the nearest edge of a convex CCW polygon; negative outside. */
function insideBy(h, pt) {
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
    if (L < 1e-12) continue;
    best = Math.min(best, -(((pt[0] - a[0]) * ey - (pt[1] - a[1]) * ex) / L));
  }
  return best;
}

/**
 * Does it fall over? The stand as printed plus the device modelled where the
 * device actually sits, and the question is whether their combined centre of
 * gravity is inside the polygon the feet actually touch the desk on.
 *
 * The shell/infill mass model is restated here rather than imported (30 % shell,
 * the rest infill, PLA) — the geometry below it is all this file's own, and one
 * check asserts the two implementations land on the same stand mass.
 */
function tipOwn(R) {
  const g = R.g, M = R.geo.analysis;              // the ASSEMBLED object, on a desk
  const rho = (FILAMENT_DENSITY.PLA / 1000) * (0.30 + 0.70 * g.infill / 100);
  const { volume, centre } = centroid3(M);
  const standMass = volume * rho;
  const A = g.angleDeg / R2D;
  const u = [Math.cos(A), Math.sin(A)], n = [-Math.sin(A), Math.cos(A)];
  const dev = [                                    // the device's own centre
    g.Q[0] + u[0] * g.deviceH / 2 + n[0] * g.deviceT / 2, 0,
    g.Q[1] + u[1] * g.deviceH / 2 + n[1] * g.deviceT / 2];
  const bal = g.ballast;
  const ballastMass = bal ? bal.volume * (g.fillDensity / 1000) : 0;
  const balC = bal ? [bal.centre[0], 0, bal.centre[1]] : [0, 0, 0];
  const total = standMass + ballastMass + g.deviceMass;
  const cog = [0, 1, 2].map(i =>
    (standMass * centre[i] + ballastMass * balC[i] + g.deviceMass * dev[i]) / total);
  const z0 = M.bbox().min[2], feet = [];
  for (let i = 0; i < M.positions.length; i += 3) {
    if (M.positions[i + 2] - z0 <= 0.02) feet.push([M.positions[i], M.positions[i + 1]]);
  }
  const H = hull(feet);
  return { standMass, ballastMass, total, cog, dev, hull: H, margin: insideBy(H, [cog[0], cog[1]]) };
}

// ---------------------------------------------------------------------------
// G2 — the shared contract, in full. Everything after this is domain-specific.
// ---------------------------------------------------------------------------
conformance(gen, 'stand');

// ---------------------------------------------------------------------------
// The cradle: the slot is the device plus the clearance, measured the right way
// ---------------------------------------------------------------------------
{
  const R = rig();
  const g = R.g;
  const w = slotWidth(R, R.clearY);
  near(`the slot is the device thickness plus the clearance (${g.deviceT} + ${g.slotClear} mm), measured off the mesh`,
    w, g.deviceT + g.slotClear, 0.02);
  near('and meta declares the same slot the mesh was cut to', R.meta.slot.widthMm, w, 0.02);

  // The same gap read the way a ruler on the desk would read it. At 62° that is
  // 1.3 mm wider than the slot; at 20° it is nearly three times the slot. This
  // is the mistake the perpendicular measurement exists to avoid, so the test
  // asserts the mesh gives the first number and NOT the second.
  const flat = g.S / Math.sin(g.A);
  check('and it is the perpendicular gap, not the horizontal one a ruler on the desk gives',
    Math.abs(w - g.S) < 0.02 && Math.abs(w - flat) > 1.0,
    `perpendicular ${w.toFixed(3)} mm vs horizontal ${flat.toFixed(3)} mm at ${g.angleDeg}°`);

  // The horizontal span, actually ray-cast, to prove that second number is real
  // and not arithmetic. A level ray leaves the middle of the slot and meets the
  // two faces at DIFFERENT heights up the device — (S/2)·cot A above on the rest
  // side, the same below on the lip side — so it is aimed to put both landings
  // inside the flat part of their face.
  const rise = (g.S / 2) / Math.tan(g.A);
  const o = R.un(slotWindow(g).mid + rise, g.S / 2, R.clearY);
  const hp = rayMeshHit(R.grid, o, [1, 0, 0]), hm = rayMeshHit(R.grid, o, [-1, 0, 0]);
  near('a horizontal ruler across the same slot reads slot ÷ sin(angle), which is why it is not used',
    hp && hm ? hp.t + hm.t : NaN, flat, 0.05);
}

// A cased tablet, a bare phone and the fattest thing the slot takes: the slot
// follows the device, and the clearance is on top of it every time.
for (const [what, over] of [
  ['a bare phone', { deviceT: 8.3, slotClear: 0.4 }],
  ['a tablet in a folio', { deviceT: 14.7, slotClear: 0.8 }],
  ['a 50 mm handheld console', { deviceT: 50, slotClear: 1.2, coverage: 0.6, angle: 70 }],
]) {
  const R = rig(over);
  const w = slotWidth(R, R.clearY);
  near(`${what}: the slot measures ${over.deviceT} + ${over.slotClear} mm`,
    w, over.deviceT + over.slotClear, 0.02);
}

// ---------------------------------------------------------------------------
// The angle, off the mesh, at every angle the generator claims to support
// ---------------------------------------------------------------------------
for (const angle of [10, 18, 45, 62, 88]) {
  const R = rig({ angle });
  const got = restAngle(R, R.clearY);
  check(`the back rest measures ${angle}° off the mesh`,
    got !== null && Math.abs(got - angle) <= 0.5,
    got === null ? 'no face found' : `got ${got.toFixed(3)}°, want ${angle} (±0.5, off by ${Math.abs(got - angle).toFixed(4)})`);
}
{
  // The angle must not drift when the things around it move: a thick rest, a
  // tall rest and a big corner radius all reshape the profile around the face.
  const R = rig({ restT: 12, restH: 90, cornerR: 12, lipT: 5 });
  const got = restAngle(R, R.clearY);
  check('and it is still 62° with a 12 mm rest, a 90 mm rest height and a 12 mm corner radius',
    got !== null && Math.abs(got - 62) <= 0.5,
    got === null ? 'no face found' : `got ${got.toFixed(3)}°, want 62 (±0.5)`);
  check('meta reports the angle the mesh was built at', R.meta.angleDeg === 62, `meta says ${R.meta.angleDeg}°`);
}

// ---------------------------------------------------------------------------
// The lip: it retains the device, and it stops short of the glass
// ---------------------------------------------------------------------------
{
  // A Paperwhite's 17 mm border is the case where there is room for both.
  const R = rig({ screenInset: 17, lipMargin: 4, lipH: 12, deviceT: 13, slotClear: 0.8 });
  const g = R.g;
  const h = lipHeight(R, R.clearY);
  near('the lip stands 12 mm up the face of the device, measured off the mesh', h, 12, 0.02);
  const retain = Math.max(3, 0.35 * g.S);
  check('it is tall enough to retain the device (3 mm, or 35 % of the slot depth)',
    h >= retain - 1e-6, `lip ${h.toFixed(2)} mm against a ${retain.toFixed(2)} mm retention minimum for a ${g.S.toFixed(1)} mm slot`);
  check('and it stops short of the screen by at least the margin asked for',
    g.screenInset - h >= g.lipMargin - 1e-6,
    `lip ${h.toFixed(2)} mm into a ${g.screenInset} mm bezel leaves ${(g.screenInset - h).toFixed(2)} mm, want ≥ ${g.lipMargin}`);
  near('meta agrees on the bezel left above the lip', R.meta.slot.bezelLeftMm, g.screenInset - g.lipMargin - h, 0.05);
  check('validate() says nothing about the lip when the bezel affords both',
    gen.validate(R.p, C).every(v => v.param !== 'lipH'),
    gen.validate(R.p, C).filter(v => v.param === 'lipH').map(v => v.message.slice(0, 60)).join(' | ') || 'silent');
}
{
  // A modern phone's 2.3 mm border is the case where there is not. Retention is
  // the one the geometry keeps, and validate() has to say so out loud.
  const R = rig({ screenInset: 2.3, lipMargin: 2, lipH: 8, deviceT: 11.5, slotClear: 0.7 });
  const g = R.g;
  const h = lipHeight(R, R.clearY);
  const retain = Math.max(3, 0.35 * g.S);
  const room = g.screenInset - g.lipMargin;
  check('when the bezel cannot give both, retention wins: the lip is built to the retaining height',
    h >= retain - 1e-6 && h > room,
    `lip ${h.toFixed(2)} mm, retention needs ${retain.toFixed(2)}, the bezel offers ${room.toFixed(2)}`);
  const v = gen.validate(R.p, C);
  const said = v.find(i => i.param === 'lipH');
  check('and validate() says so, in millimetres of screen it will stand over',
    !!said && /over the picture/i.test(said.message) && said.message.includes((h - room).toFixed(1)),
    said ? said.message.slice(0, 120) : 'nothing said');
  check('it is a warning, not an error — the object is still the right one to print',
    !!said && said.severity === 'warn', said ? said.severity : 'absent');

  // The floor has to hold on the FLAT face, not on the overall height.
  const retainFloor = Math.max(3, 0.35 * g.S);
  const flat = flatLipFace(R, R.clearY);
  check('the flat retaining face — not the lip\'s overall height — meets the retention floor',
    flat !== null && flat >= retainFloor - 0.05,
    `${flat === null ? 'no flat face found' : flat.toFixed(2) + ' mm'} of flat face against a ${retainFloor.toFixed(2)} mm floor`);
  // 0.25 mm, not 0.05: the fillet leaves the flat face TANGENTIALLY, so its
  // deviation grows as the square of the distance travelled and a ray probe
  // cannot resolve where the arc begins more finely than about sqrt(2·r·tol).
  // The shortfall this pair of checks exists to catch was 1.26 mm — a whole
  // fillet radius — so a tenth of that is a tolerance, not a loophole.
  check('and solve() reports the flat face rather than the height above it',
    flat !== null && Math.abs(g.lipFlat - flat) < 0.25,
    `solve says ${g.lipFlat.toFixed(2)}, the mesh gives ${flat === null ? 'nothing' : flat.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// It does not tip over. The whole reason this generator exists.
// ---------------------------------------------------------------------------

// A device that is plausible at BOTH ends of the angle range: a 150 mm phone.
// (A 248 mm tablet at 10° is 244 mm of overhang and no bed can foot it — that
// case is the failure test further down, and it is a real physical limit.)
const PHONE = { deviceT: 9, deviceW: 76, deviceH: 150, deviceMass: 200, screenInset: 4, coverage: 0.7 };

for (const angle of [10, 62, 88]) {
  const R = rig({ ...PHONE, angle });
  const t = tipOwn(R);
  const what = angle === 10 ? 'at the shallowest angle it supports' :
    angle === 88 ? 'at the steepest angle it supports' : 'at its default angle';
  check(`${what} (${angle}°) the loaded centre of gravity is inside the feet by the ${R.g.tipMargin} mm asked for`,
    t.margin >= R.g.tipMargin - 1e-6,
    `margin ${t.margin.toFixed(2)} mm, want ≥ ${R.g.tipMargin}; ${t.total.toFixed(0)} g total ` +
    `(stand ${t.standMass.toFixed(0)} g + device ${R.g.deviceMass} g), cog x = ${t.cog[0].toFixed(1)} mm, ` +
    `feet ${Math.min(...t.hull.map(h => h[0])).toFixed(1)} to ${Math.max(...t.hull.map(h => h[0])).toFixed(1)} mm`);
}
{
  const R = rig({ ...PHONE, angle: 88 });
  const t = tipOwn(R);
  near('this suite\'s own centre-of-mass arithmetic agrees with the generator\'s to a hundredth of a millimetre',
    t.margin, R.tip.margin, 0.01);
  near('...and on the printed mass of the stand', t.standMass, R.tip.standMass, 0.05);
  near('...and on where the device\'s own centre of mass sits', t.dev[0], R.tip.deviceCentre[0], 1e-6);
  // The feet are the whole underside, not a strip of it: the support polygon has
  // to be as long as the base is deep and as wide as the stand is wide, or the
  // margin above was measured against something smaller than the part.
  const spanX = Math.max(...t.hull.map(h => h[0])) - Math.min(...t.hull.map(h => h[0]));
  const spanY = Math.max(...t.hull.map(h => h[1])) - Math.min(...t.hull.map(h => h[1]));
  const bb = R.mesh.bbox().size;
  check('the support polygon is the footprint the mesh actually rests on',
    t.hull.length >= 4 && Math.abs(spanX - bb[0]) < 0.5 && Math.abs(spanY - bb[1]) < 0.5,
    `${t.hull.length}-gon of ${spanX.toFixed(1)} × ${spanY.toFixed(1)} mm under a ` +
    `${bb[0].toFixed(1)} × ${bb[1].toFixed(1)} mm part`);
}
{
  // The check has to be able to FAIL, or it is decoration. A 248 mm tablet laid
  // back to 10° is 244 mm of overhang: no base inside a 180 mm bed reaches under
  // it, and both this suite's arithmetic and validate() have to say so.
  const R = rig({ angle: 10 });
  const t = tipOwn(R);
  check('a 248 mm tablet at 10° genuinely falls over — the tipping check is not vacuous',
    t.margin < 0,
    `cog x = ${t.cog[0].toFixed(1)} mm against feet ending at ${Math.max(...t.hull.map(h => h[0])).toFixed(1)} mm ` +
    `— ${(-t.margin).toFixed(1)} mm outside, after the auto-sizer grew the base to ${R.g.depth.toFixed(0)} mm deep`);
  const v = gen.validate(R.p, C).find(i => i.param === 'tipMargin' && i.severity === 'error');
  check('and validate() calls it an error rather than shipping it',
    !!v && /falls over/i.test(v.message), v ? v.message.slice(0, 110) : 'nothing said');
}
{
  // The auto-sizer is the mechanism that keeps the margin: turn it off and the
  // same numbers become an object that will not stand up.
  const heavy = { ...PHONE, deviceH: 260, deviceMass: 700, angle: 75, frontLen: 0, backLen: 0 };
  const on = rig({ ...heavy, autoBase: true });
  const off = rig({ ...heavy, autoBase: false });
  check('the auto-sizer grows the base backwards until the margin is met',
    tipOwn(on).margin >= on.g.tipMargin - 1e-6 && on.g.grewBack > 0,
    `grew ${on.g.grewBack.toFixed(0)} mm of heel to a margin of ${tipOwn(on).margin.toFixed(1)} mm, ` +
    `depth ${on.g.depth.toFixed(0)} mm`);
  check('...and with it off, the same device on the base you asked for is reported as unstable',
    tipOwn(off).margin < off.g.tipMargin &&
    gen.validate(off.p, C).some(i => i.param === 'tipMargin' && i.severity === 'error'),
    `margin ${tipOwn(off).margin.toFixed(1)} mm against the ${off.g.tipMargin} mm asked for`);
}

// ---------------------------------------------------------------------------
// The cable route: every part of it opens to the outside. Ray-cast, not assumed.
// ---------------------------------------------------------------------------
{
  const R = rig();
  const g = R.g;
  const asideY = g.port + g.cableW / 2 + 6;

  // Straight down from just above the slot floor, where the device's socket is:
  // a plug has to have a way in from underneath.
  const floor = R.un(0.4, g.S / 2, g.port);
  const down = rayMeshCount(R.grid, floor, [0, 0, -1]);
  check('the cable shaft goes clean through: a ray down from the device\'s socket crosses no surface at all',
    down === 0, `${down} crossings from (${floor.map(v => v.toFixed(1)).join(', ')}) straight down through a ${g.baseT} mm base`);
  const aside = rayMeshCount(R.grid, R.un(0.4, g.S / 2, asideY), [0, 0, -1]);
  check('...and the identical ray 12 mm to one side crosses the solid base twice, so that zero was a hole and not a miss',
    aside === 2, `${aside} crossings at y = ${asideY.toFixed(1)} mm`);

  // And out the back, along the groove in the underside.
  const inShaft = R.at([(g.F[0] + g.Q[0]) / 2, g.port, g.grooveH / 2]);
  check('the point inside the shaft really is air',
    !pointInsideMesh(R.grid, inShaft), `(${inShaft.map(v => v.toFixed(1)).join(', ')})`);
  const outBack = rayMeshCount(R.grid, inShaft, [1, 0, 0]);
  check('the underside groove reaches the back edge: a ray from inside the shaft leaves the part without crossing a surface',
    outBack === 0, `${outBack} crossings running ${(g.xBack - g.Q[0]).toFixed(0)} mm back at ${(g.grooveH / 2).toFixed(1)} mm above the plate`);
  const solidAside = pointInsideMesh(R.grid, R.at([(g.F[0] + g.Q[0]) / 2, asideY, g.grooveH / 2]));
  check('...and the same height 12 mm to one side is solid plastic, so the groove is a groove and not a missing base',
    solidAside, `inside = ${solidAside} at y = ${asideY.toFixed(1)} mm`);

  // The channel is where the device's socket is, and as wide as the plug.
  const hp = rayMeshHit(R.grid, inShaft, [0, 1, 0]), hm = rayMeshHit(R.grid, inShaft, [0, -1, 0]);
  near(`the channel measures ${g.cableW} mm across, off the mesh`, hp && hm ? hp.t + hm.t : NaN, g.cableW, 0.02);
  near('and it is centred on the port offset', hp && hm ? g.port + (hp.t - hm.t) / 2 : NaN, g.port, 0.02);
}
{
  // A phone lying on its long edge has its socket 45 mm off centre.
  const R = rig({ portOffset: 45, deviceW: 162.8, deviceH: 77.6, coverage: 0.7, angle: 65, restH: 26 });
  const g = R.g;
  const inShaft = R.at([(g.F[0] + g.Q[0]) / 2, g.port, g.grooveH / 2]);
  const hp = rayMeshHit(R.grid, inShaft, [0, 1, 0]), hm = rayMeshHit(R.grid, inShaft, [0, -1, 0]);
  near('an off-centre port moves the channel: it is cut at 45 mm off the middle, measured off the mesh',
    hp && hm ? g.port + (hp.t - hm.t) / 2 : NaN, 45, 0.02);
  const down = rayMeshCount(R.grid, R.un(0.4, g.S / 2, g.port), [0, 0, -1]);
  check('...and it still goes clean through the base there', down === 0, `${down} crossings at y = ${g.port} mm`);
  near('meta reports the offset the mesh was cut at', R.meta.cable.offsetMm, 45, 0.05);
}
{
  // Asked for further out than the stand can reach: clamped, and said out loud.
  const R = rig({ portOffset: 120 });
  const v = gen.validate(R.p, C).find(i => i.param === 'portOffset');
  check('a port offset the stand is not wide enough to reach is clamped and reported',
    R.g.portClamped && !!v && v.message.includes('120'),
    v ? v.message.slice(0, 110) : `clamped to ${R.g.port.toFixed(1)} mm but nothing said`);
}
{
  const R = rig({ cable: false });
  const down = rayMeshCount(R.grid, R.un(0.4, R.g.S / 2, 0), [0, 0, -1]);
  check('with the cable route off there is no hole: the same ray crosses the base twice',
    down === 2, `${down} crossings`);
  check('and meta stops claiming a channel', R.meta.cable === null, JSON.stringify(R.meta.cable));
}

// ---------------------------------------------------------------------------
// The variants: five recognisably different objects, all of them solid
// ---------------------------------------------------------------------------
{
  const variants = {
    'wedge': {},
    'easel': { style: 'easel' },
    'no cable route': { cable: false },
    'headphone hook': { hook: 'right' },
    'weighted base': { weighted: true },
  };
  const sigs = new Map();
  for (const [name, over] of Object.entries(variants)) {
    const r = gen.build({ ...P0, ...over }, C);
    const t = topology(r.mesh);
    check(`the "${name}" variant is a watertight solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && r.mesh.volume() > 0,
      `bnd ${t.boundary}, nonman ${t.nonManifold}, wind ${t.inconsistent}, ${r.mesh.volume().toFixed(0)} mm³, ${r.mesh.triCount} tris`);
    sigs.set(name, Math.round(r.mesh.volume()));
  }
  check('and the five are five different objects, not one object five times',
    new Set(sigs.values()).size === 5,
    [...sigs].map(([k, v]) => `${k} ${v}`).join(', ') + ' mm³');
}

// --- the easel ------------------------------------------------------------
{
  const R = rig({ style: 'easel', angle: 45 });
  const g = R.g;
  check('the easel is two pieces, both lying flat on the plate and not touching',
    R.r.parts.length === 2 &&
    R.r.parts.every(q => Math.abs(q.mesh.bbox().min[2]) < 1e-9) &&
    (R.r.parts[0].mesh.bbox().min[0] - R.r.parts[1].mesh.bbox().max[0] > 0 ||
     R.r.parts[1].mesh.bbox().min[0] - R.r.parts[0].mesh.bbox().max[0] > 0 ||
     R.r.parts[0].mesh.bbox().min[1] - R.r.parts[1].mesh.bbox().max[1] > 0 ||
     R.r.parts[1].mesh.bbox().min[1] - R.r.parts[0].mesh.bbox().max[1] > 0),
    R.r.parts.map(q => `${q.name} ${q.mesh.bbox().size.map(v => v.toFixed(0)).join('×')}`).join(' + '));
  check('it cuts a row of angle steps, laid out about the angle you asked for',
    g.sockets.length >= 3 && g.angles.includes(45),
    `${g.sockets.length} sockets at ${g.angles.map(a => a.toFixed(1)).join('° / ')}°, ${g.spread}° apart`);

  // The socket is the datum the angle comes off, so it is measured, not assumed.
  const base = R.r.parts.find(q => q.name === 'Base').mesh;
  const bg = triGrid(base);
  const s = nominalSocket(g);
  const o = R.at([s.x + (g.propW + g.fit) / 2, 0, g.baseT - g.td / 2]);
  const hp = rayMeshHit(bg, o, [1, 0, 0]), hm = rayMeshHit(bg, o, [-1, 0, 0]);
  near(`the socket is cut ${(g.propW + g.fit).toFixed(2)} mm wide for a ${g.propW.toFixed(2)} mm prop`,
    hp && hm ? hp.t + hm.t : NaN, g.propW + g.fit, 0.02);
}
for (const angle of [20, 45, 70]) {
  // Assembled, the prop's bevelled top IS the plane the device lies on, so its
  // slope off the mesh is the angle the socket actually delivers.
  const R = rig({ style: 'easel', arrange: 'assembled', angle });
  const g = R.g, s = nominalSocket(g);
  const z0 = g.baseT - g.td;
  const pts = [];
  for (const f of [0.4, 0.6]) {
    const x = s.x + g.propBevelX * f;
    const o = R.at([x, 0, z0 + g.propHBack + 30]);
    const h = rayMeshHit(R.grid, o, [0, 0, -1]);
    pts.push(h ? [x, o[2] - h.t] : null);
  }
  const got = pts[0] && pts[1] ? Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * R2D : null;
  check(`the easel prop seated in its nominal socket bevels to ${angle}°, measured off the assembled mesh`,
    got !== null && Math.abs(got - angle) <= 0.5,
    got === null ? 'no bevel found' : `got ${got.toFixed(3)}°, want ${angle} (±0.5, off by ${Math.abs(got - angle).toFixed(4)})`);
}

// --- the headphone hook ---------------------------------------------------
{
  const plain = rig({ hook: 'none' });
  const one = rig({ hook: 'right' });
  const two = rig({ hook: 'both' });
  near('one hook fin adds exactly its saddle width to the stand',
    one.mesh.bbox().size[1] - plain.mesh.bbox().size[1], one.g.hookT, 0.02);
  near('two fins add two of them', two.mesh.bbox().size[1] - plain.mesh.bbox().size[1], 2 * two.g.hookT, 0.02);
  check('the peg projects BEHIND the back edge, where what hangs on it cannot foul the device',
    one.g.hookSpec.xTip > one.g.xBack &&
    one.mesh.bbox().size[0] - plain.mesh.bbox().size[0] > 5,
    `peg tip ${one.g.hookSpec.xTip.toFixed(1)} mm against a foot ending at ${one.g.xBack.toFixed(1)} mm, ` +
    `${(one.mesh.bbox().size[0] - plain.mesh.bbox().size[0]).toFixed(1)} mm of extra depth`);
  const a = analyze(one.mesh);
  check('the fin is unioned into the wedge, not left standing beside it — one shell, watertight',
    a.shells === 1 && a.watertight && a.manifold, `${a.shells} shells, watertight ${a.watertight}`);
  // At the defaults the wedge has nowhere near enough heel to root a 34 mm peg,
  // so it is cut back until its 45° gusset lands in solid material — and the
  // number it was cut to is the number reported.
  const short = gen.validate(one.p, C).find(i => i.param === 'hookLen');
  check('a peg that cannot reach solid wedge is shortened, and the millimetres are reported',
    one.g.hookSpec.len < one.p.hookLen - 0.05 && !!short &&
    short.message.includes(one.g.hookSpec.len.toFixed(0)),
    short ? short.message.slice(0, 110)
      : `${one.p.hookLen} mm asked, ${one.g.hookSpec.len.toFixed(1)} mm built, nothing said`);
  // Given the wedge the preset builds for it — 80°, an 80 mm rest and a 45 mm
  // heel — the same gusset lands in solid material and the reach is kept whole.
  const roomy = rig(gen.presets.find(q => q.name === 'Headphones hung beside the desk').values);
  near('and given a tall enough wedge to bite into, the peg keeps the 40 mm reach it was asked for',
    roomy.g.hookSpec.len, 40, 0.05);
}

// --- the ballast cavity ---------------------------------------------------
{
  const plain = rig({ weighted: false });
  const R = rig({ weighted: true });
  const bal = R.g.ballast;
  const centre = R.at([bal.centre[0], 0, bal.centre[1]]);
  check('the ballast cavity is a real void inside the wedge',
    !pointInsideMesh(R.grid, centre) && R.mesh.volume() < plain.mesh.volume(),
    `${(plain.mesh.volume() - R.mesh.volume()).toFixed(0)} mm³ of plastic removed, cavity centre at ` +
    `(${centre.map(v => v.toFixed(1)).join(', ')})`);
  const up = rayMeshCount(R.grid, centre, [0, 0, 1]);
  check('and the chimney opens it to the sky, so it can be filled after printing: a ray straight up crosses nothing',
    up === 0, `${up} crossings from the cavity centre to open air`);
  const down = rayMeshCount(R.grid, centre, [0, 0, -1]);
  check('...while a ray straight DOWN crosses the cavity floor and the base, so it is a cup and not a hole',
    down === 2, `${down} crossings`);
  near('meta reports the volume that will actually be poured in',
    R.meta.ballast.millilitres, bal.volume / 1000, 0.05);
  const heavy = rig({ weighted: true, fillDensity: 6.7 });
  check('a denser fill is modelled as more mass in the tipping arithmetic',
    heavy.meta.tip.ballastG > R.meta.tip.ballastG * 3,
    `sand ${R.meta.tip.ballastG} g vs lead shot ${heavy.meta.tip.ballastG} g in the same ${R.meta.ballast.millilitres} ml`);
  check('the envelope does not change — the ballast is hollowed out of the wedge, not bolted onto it',
    Math.abs(R.mesh.bbox().size[0] - plain.mesh.bbox().size[0]) < 1e-6 &&
    Math.abs(R.mesh.bbox().size[2] - plain.mesh.bbox().size[2]) < 1e-6,
    `${R.mesh.bbox().size.map(v => v.toFixed(1)).join(' × ')} vs ${plain.mesh.bbox().size.map(v => v.toFixed(1)).join(' × ')} mm`);
}

// ---------------------------------------------------------------------------
// Printability: what it says about slicing it, and what it refuses to ship
// ---------------------------------------------------------------------------
{
  const h = gen.hints(P0, C);
  check('hints() gives real slicing settings, not a shrug',
    h.supports === false && h.walls >= 4 && h.layerH > 0 && h.infill >= 12 && h.parts === 1 && h.notes.length >= 4,
    `${h.walls} walls, ${h.layerH} mm layers, ${h.infill}% infill, supports ${h.supports}, ${h.notes.length} notes, ~${h.estGrams} g`);
  check('...and says which way up it goes and why it needs no support',
    h.notes.some(n => /orientation/i.test(n)) && h.notes.some(n => /supports?:/i.test(n) && /notch|vertical|set back/i.test(n)),
    h.notes.find(n => /supports?:/i.test(n))?.slice(0, 110) || 'nothing about supports');
  check('the one bridge on the part is called out by name',
    h.notes.some(n => /bridge/i.test(n)),
    h.notes.find(n => /bridge/i.test(n))?.slice(0, 110) || 'no mention of the cable groove roof');
  const easel = gen.hints({ ...P0, style: 'easel' }, C);
  check('the easel is told not to be printed with the prop standing up',
    easel.parts === 2 && easel.notes.some(n => /do not stand the prop up/i.test(n)),
    easel.notes.find(n => /prop/i.test(n))?.slice(0, 110) || 'nothing about the prop');
}
{
  // The claim in hints() is checkable against the geometry: with the cable route
  // off there is no down-facing surface anywhere on the part.
  const dry = printability(rig({ cable: false }).mesh, { bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2 });
  check('with no cable route the wedge has no overhang at all — a swept profile cannot make one',
    dry.overhangPct === 0 && dry.worstOverhangDeg < 50,
    `${dry.overhangPct.toFixed(3)}% overhanging, worst ${dry.worstOverhangDeg.toFixed(1)}°`);
  const wet = printability(rig().mesh, { bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2 });
  check('with it on, the only overhang is that flat groove roof, and it is a few percent of the surface',
    wet.overhangPct > 0 && wet.overhangPct < 4 && wet.fitsBed,
    `${wet.overhangPct.toFixed(2)}% overhanging, worst ${wet.worstOverhangDeg.toFixed(1)}°, ${wet.estGrams.toFixed(0)} g`);
}
{
  check('validate() reports no errors at the defaults',
    gen.validate(P0, C).filter(i => i.severity === 'error').length === 0,
    JSON.stringify(gen.validate(P0, C).map(i => `${i.severity}:${i.param}`)));

  // Deliberately unprintable: an easel at 88°. The socket has to sit far enough
  // back to clear the stop, and a prop rising from there would be taller than
  // the printer — so it is built as a plain blade and validate() says how far
  // short it stops rather than shipping a folded ring.
  const v = gen.validate({ ...P0, style: 'easel', angle: 88 }, C);
  const e = v.find(i => i.severity === 'error');
  check('an easel at 88° is caught: the prop cannot reach the device inside the bed',
    !!e && /prop cannot reach/i.test(e.message) && /mm tall/.test(e.message),
    e ? e.message.slice(0, 130) : 'nothing said');
  check('...and it still builds a watertight solid rather than throwing',
    topology(gen.build({ ...P0, style: 'easel', angle: 88 }, C).mesh).boundary === 0,
    `${gen.build({ ...P0, style: 'easel', angle: 88 }, C).mesh.triCount} triangles, no boundary edges`);

  // Everything at the thin end at once: nothing here is an error, but every one
  // of them is a wall the printer will not hold, and each is named.
  const thin = gen.validate({ ...P0, baseT: 1.6, restT: 1.2, lipT: 1, slotClear: 0 }, C);
  for (const [key, what, pattern] of [
    ['baseT', 'a 1.6 mm base will curl off the plate as it cools', /curl off the plate/i],
    ['restT', 'a 1.2 mm back rest is a cantilever six extrusions thick', /bending/i],
    ['lipT', 'a 1 mm lip is under four extrusions and will snap off', /extrusions/i],
    ['slotClear', 'a zero-clearance slot will bind on the printed surface finish', /bind/i],
  ]) {
    const said = thin.filter(i => i.param === key && i.severity === 'warn').find(i => pattern.test(i.message));
    check(`validate() warns that ${what}`, !!said,
      said ? said.message.slice(0, 95) : `nothing matching ${pattern} among ${thin.filter(i => i.param === key).length} "${key}" notes`);
  }
  const a = analyze(rig().mesh);
  check('and the object validate() approves of is manifold and watertight by the kernel\'s own reckoning',
    a.manifold && a.watertight && a.boundaryEdges === 0 && a.shells === 1,
    `manifold ${a.manifold}, boundary ${a.boundaryEdges}, ${a.shells} shell`);
}

// ---------------------------------------------------------------------------
// Dimension callouts: each one sits on the feature it names, in the placed frame
// ---------------------------------------------------------------------------
{
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const same = (a, b, tol = 1e-6) => dist(a, b) <= tol;
  const dimOf = (R, key) => (R.meta.dims || []).find(d => d.param === key);

  const D = rig();
  const { g, mesh, at, un } = D;
  const yS = -g.standW / 2;
  const bb = mesh.bbox();

  // The lip: from the slot floor at the lip's inner face, up the face by the
  // BUILT lip (7 mm here — trimmed from the 8 asked for), and it says so.
  const lip = dimOf(D, 'lipH');
  check('a lipH callout is declared', !!lip, lip ? `${lip.from} -> ${lip.to}` : 'missing');
  near('the lipH callout is exactly the built lip long', lip ? dist(lip.from, lip.to) : NaN, g.lipH, 1e-6);
  check('...starting on the slot floor at the lip\'s inner face and ending at the lip\'s top inner corner',
    lip && same(lip.from, un(0, g.S, yS)) && same(lip.to, un(g.lipH, g.S, yS)),
    lip ? `from ${lip.from.map(v => v.toFixed(2))} to ${lip.to.map(v => v.toFixed(2))}` : 'missing');
  check('...and, being trimmed from what was asked, writes the built figure rather than the parameter',
    lip && g.lipH !== P0.lipH && Math.abs(lip.value - g.lipH) < 0.01, lip ? `value ${lip.value}, built ${g.lipH}, asked ${P0.lipH}` : 'missing');

  // The base: a vertical on the toe's front face, plate to top.
  const base = dimOf(D, 'baseT');
  check('the baseT callout is a vertical on the toe\'s front face, from the plate to the top of the base',
    base && Math.abs(base.from[0] - bb.min[0]) < 1e-6 && Math.abs(base.to[0] - bb.min[0]) < 1e-6 &&
    Math.abs(base.from[2]) < 1e-9 && Math.abs(base.to[2] - g.baseT) < 1e-9 && base.value === undefined,
    base ? `x ${base.from[0].toFixed(2)} (bbox min ${bb.min[0].toFixed(2)}), z ${base.from[2]} -> ${base.to[2]}` : 'missing');

  // The rest's thickness runs from the top of the rest's front face to the top
  // of its back face — the two profile points the solid was swept from.
  const rt = dimOf(D, 'restT');
  check('the restT callout joins the rest\'s top-front and top-back profile points',
    rt && same(rt.from, at([g.Rtop[0], yS, g.Rtop[1]])) && same(rt.to, at([g.RtopBack[0], yS, g.RtopBack[1]])),
    rt ? `${rt.from.map(v => v.toFixed(2))} -> ${rt.to.map(v => v.toFixed(2))}` : 'missing');
  near('...and is the rest thickness long', rt ? dist(rt.from, rt.to) : NaN, g.restT, 1e-6);

  // The rest height is pushed out along n — in front of the device plane, clear
  // of the lip — not across the cradle.
  const rh = dimOf(D, 'restH');
  check('the restH callout runs up the device plane from the slot floor to the top of the rest',
    rh && same(rh.from, un(0, 0, yS)) && same(rh.to, un(g.restH, 0, yS)),
    rh ? `${rh.from.map(v => v.toFixed(2))} -> ${rh.to.map(v => v.toFixed(2))}` : 'missing');
  check('...offset along the device normal by more than the slot plus the lip, so it clears the lip',
    rh && Array.isArray(rh.offset) && Math.hypot(...rh.offset) > g.S + g.lipT &&
    Math.abs(rh.offset[0] * g.n[1] - rh.offset[2] * g.n[0]) < 1e-9 && rh.offset[0] * g.n[0] + rh.offset[2] * g.n[1] > 0,
    rh ? `offset ${rh.offset}` : 'missing');

  // The channel: across the groove where it leaves the underside at the back edge.
  const ch = dimOf(D, 'cableW');
  check('the cableW callout spans the groove at the back edge on the plate, centred on the port',
    ch && Math.abs(ch.from[0] - bb.max[0]) < 1e-6 && Math.abs(ch.to[0] - bb.max[0]) < 1e-6 &&
    Math.abs(ch.from[2]) < 1e-9 && Math.abs(ch.to[2]) < 1e-9 &&
    Math.abs(ch.from[1] - (g.port - g.cableW / 2)) < 1e-9 && Math.abs(ch.to[1] - (g.port + g.cableW / 2)) < 1e-9,
    ch ? `x ${ch.from[0].toFixed(2)} (bbox max ${bb.max[0].toFixed(2)}), y ${ch.from[1]} -> ${ch.to[1]}` : 'missing');

  // The heel says what the auto-sizer built, not what was typed.
  const heel = dimOf(D, 'backLen');
  near('the backLen callout runs from under the back of the rest to the back edge, on the plate',
    heel ? dist(heel.from, heel.to) : NaN, g.xBack - g.RtopBack[0], 1e-6);
  check('...and carries the grown heel as its written value when the auto-sizer changed it',
    heel && (g.xBack - g.RtopBack[0] === P0.backLen ? heel.value === undefined : Math.abs(heel.value - (g.xBack - g.RtopBack[0])) < 0.01),
    heel ? `value ${heel.value}, built ${(g.xBack - g.RtopBack[0]).toFixed(2)}, asked ${P0.backLen}` : 'missing');

  // The easel: the socket callout is the socket the prop drops into.
  const E = rig({ style: 'easel', arrange: 'plate', fit: 0.25 });
  const sock = dimOf(E, 'fit');
  const ns = nominalSocket(E.g);
  check('on the easel the fit callout spans the nominal socket at the top of the base and writes prop + fit',
    sock && same(sock.from, E.at([ns.x, -E.g.standW / 2, E.g.baseT])) &&
    same(sock.to, E.at([ns.x + E.g.propW + E.g.fit, -E.g.standW / 2, E.g.baseT])) &&
    Math.abs(sock.value - (E.g.propW + E.g.fit)) < 0.01,
    sock ? `${sock.from.map(v => v.toFixed(2))} -> ${sock.to.map(v => v.toFixed(2))}, value ${sock.value}` : 'missing');
  const stop = dimOf(E, 'restT');
  check('...and restT measures the back stop, from its inner face to its outer face at the stop\'s top',
    stop && same(stop.from, E.un(E.g.stopH, 0, -E.g.standW / 2)) && same(stop.to, E.un(E.g.stopH, -E.g.stopT, -E.g.standW / 2)),
    stop ? `${stop.from.map(v => v.toFixed(2))} -> ${stop.to.map(v => v.toFixed(2))}` : 'missing');

  // The hook: reach from the back edge to the peg's tip, saddle across the peg's top.
  const H = rig({ hook: 'right', hookT: 30, hookLen: 40, restH: 80, backLen: 45, deviceT: 40, screenInset: 0, coverage: 0.3, baseT: 8 });
  const hk = H.g.hookSpec;
  const reach = dimOf(H, 'hookLen'), saddle = dimOf(H, 'hookT');
  check('a right-hand hook gets a reach callout along the peg\'s top, from the back edge to the tip, on the fin\'s outer face',
    hk && reach && same(reach.from, H.at([H.g.xBack, H.g.standW / 2 + H.g.hookT, hk.yTop])) &&
    same(reach.to, H.at([hk.xTip, H.g.standW / 2 + H.g.hookT, hk.yTop])),
    reach ? `${reach.from.map(v => v.toFixed(2))} -> ${reach.to.map(v => v.toFixed(2))}` : 'no hook built');
  near('...and a saddle callout across the peg that is exactly the saddle wide',
    saddle ? dist(saddle.from, saddle.to) : NaN, H.g.hookT, 1e-6);
  check('...whose ends sit at the wedge\'s side face and the fin\'s outer face',
    saddle && Math.abs(saddle.from[1] - H.at([0, H.g.standW / 2, 0])[1]) < 1e-9 &&
    Math.abs(saddle.to[1] - H.at([0, H.g.standW / 2 + H.g.hookT, 0])[1]) < 1e-9,
    saddle ? `y ${saddle.from[1].toFixed(2)} -> ${saddle.to[1].toFixed(2)}` : 'missing');

  // Every callout, at every preset: exactly one per parameter (the viewer draws
  // the first it finds), and every point inside the placed bounding box, which
  // is how a callout placed from the un-translated profile would be caught.
  let dup = 0, outside = 0, total = 0;
  for (const pr of [{ name: 'defaults', values: {} }, ...gen.presets]) {
    const R = gen.build({ ...P0, ...pr.values }, C);
    const b = R.mesh.bbox();
    const seen = new Set();
    for (const d of R.meta.dims) {
      total++;
      if (seen.has(d.param)) dup++;
      seen.add(d.param);
      for (const pt of [d.from, d.to]) {
        for (let ax = 0; ax < 3; ax++) if (pt[ax] < b.min[ax] - 2 || pt[ax] > b.max[ax] + 2) outside++;
      }
    }
  }
  check(`across the defaults and ${gen.presets.length} presets every parameter has at most one callout and every endpoint is within 2 mm of the placed box (${total} callouts)`,
    dup === 0 && outside === 0, `${dup} duplicates, ${outside} stray coordinates`);
}

console.log(`\ndomain-specific checks (stand geometry, physics, features): ${domain}`);
done();
