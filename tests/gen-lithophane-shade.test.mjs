// gen lithophane, the shade: which face carries the relief, which way round the
// pictures read, and the two lamp fittings (an E27 web, a Bambu LED base).
//
// Kept out of gen-lithophane.test.mjs because two more full conformance sweeps
// would push that file towards run.mjs's per-file budget.
//
// Everything here is measured off the built mesh with rays and cross-sections,
// never read back from meta: meta is the generator's own opinion of itself.

import { suite, check, near, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh, isSolid, onPlate } from './lib/genconform.mjs';
import gen, { thicknessMap } from '../js/gen/lithophane.js';
import { shellsOf, analyze } from '../js/kernel/validate.js';
import { FIT } from '../js/kernel/fit.js';

suite('gen lithophane shade');

// ---------------------------------------------------------------------------
// The contract, at every extreme, with each fitting on
// ---------------------------------------------------------------------------
const POCKET = 59.6 + 2 * FIT.push;      // Bambu's CAD puck plus FIT.push a side
conformance(gen, 'lithophane', { resolve: { shape: 'shade', fitting: 'e27' } });
conformance(gen, 'lithophane', { resolve: { shape: 'shade', fitting: 'e27', fitMount: 'table' } });
conformance(gen, 'lithophane', { resolve: { shape: 'shade', fitting: 'bambu-led', fitBore: POCKET } });

// ---------------------------------------------------------------------------
// Fixtures and instruments
// ---------------------------------------------------------------------------
const C = ctx();
function img(w, h, fn) {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = fn(x, y, w, h);
  return { w, h, gray };
}
const brightLeft = img(64, 64, (x) => (x < 32 ? 1 : 0));        // left half white = thin
const darkTop = img(64, 64, (_x, y) => (y < 32 ? 0 : 1));       // top half black = thick
const ramp = img(64, 64, (x) => x / 63);

const BASE = { ...defaults(gen), shape: 'shade', image: ramp, pixelPitch: 1.0, frameThickness: 3.6,
               minThickness: 0.8, maxThickness: 3.0, edgeFade: 0, overhangGuard: false };
const build = (over) => gen.build({ ...BASE, ...over }, C);
const mesh = (over) => asMesh(build(over));

/** Every distance along a ray at which it crosses the surface, nearest first. */
function rayHits(m, o, d) {
  const out = [], T = m.tris, P = m.positions;
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (t > 1e-9) out.push(t);
  }
  out.sort((x, y) => x - y);
  // A ray through a shared edge is reported by both triangles; one crossing.
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-6);
}

/** The cross-section at height z as 2D segments. */
function section(m, z) {
  const segs = [], T = m.tris;
  for (let i = 0; i < T.length; i += 3) {
    const v = [m.vertex(T[i]), m.vertex(T[i + 1]), m.vertex(T[i + 2])];
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const p = v[k], q = v[(k + 1) % 3];
      if ((p[2] - z) * (q[2] - z) < 0) {
        const t = (z - p[2]) / (q[2] - p[2]);
        pts.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}
/** Distances at which a 2D ray from o along unit d crosses the section. */
function hits2D(segs, o, d) {
  const out = [];
  for (const [p, q] of segs) {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-14) continue;
    const wx = p[0] - o[0], wy = p[1] - o[1];
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * d[1] - wy * d[0]) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) out.push(t);
  }
  out.sort((x, y) => x - y);
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-7);
}
/** Material along a horizontal line y = const at height z: the gaps between solid runs. */
function gapsAlongX(segs, y, x0) {
  const h = hits2D(segs, [x0, y], [1, 0]).map(t => x0 + t);
  const gaps = [];
  for (let i = 1; i + 1 < h.length; i += 2) gaps.push([h[i], h[i + 1]]);
  return { hits: h, gaps };
}

const turnOver = (m) => { const r = m.mapVerts((x, y, z) => [x, -y, -z]); return r.translate(0, 0, -r.bbox().min[2]); };

/**
 * Wall thickness seen by someone standing outside wall N, at a point u mm to
 * their right of the wall's middle, at height z. Their right is up x N, which
 * is worked out here from the normal and not borrowed from the generator.
 */
function thicknessSeen(m, N, u, z, half) {
  const R = [-N[1], N[0]];
  const o = [N[0] * (half + 5) + R[0] * u, N[1] * (half + 5) + R[1] * u, z];
  const h = rayHits(m, o, [-N[0], -N[1], 0]);
  return h.length >= 2 ? h[1] - h[0] : NaN;
}
const WALLS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// ===========================================================================
// Which face carries the relief
// ===========================================================================
console.log('\n-- relief on the outside or the inside --');
for (const face of ['outside', 'inside']) {
  const m = mesh({ reliefFace: face, image: ramp, shadeSide: 70 });
  isSolid(`relief ${face}`, m);
  const a = 35, B = a - 3.6, z = m.bbox().size[2] / 2;
  // Along the -y wall's middle, from outside and from inside.
  const fromOut = rayHits(m, [0, -(a + 5), z], [0, 1, 0]);
  const outerFace = (a + 5) - fromOut[0], innerFace = (a + 5) - fromOut[1];
  if (face === 'outside') {
    check('outside: the inner face is the flat square, frameT in', Math.abs(innerFace - B) < 1e-6, `${innerFace.toFixed(4)} mm from the axis`);
    check('outside: the outer face is cut back by the picture', outerFace < a - 0.3, `${outerFace.toFixed(3)} mm, outer square ${a}`);
  } else {
    check('inside: the outer face is the flat square', Math.abs(outerFace - a) < 1e-6, `${outerFace.toFixed(4)} mm`);
    check('inside: the inner face carries the picture', innerFace > B + 0.3, `${innerFace.toFixed(3)} mm, frame face ${B}`);
  }
}
{
  // The relief may never reach over a corner post: every point of the outer
  // face that is recessed from the outer square must be more than frameT from
  // both corners of its own wall. Closer than that, it is carving the post
  // that holds the two walls together.
  const frameT = 3.6, a = 35;
  const m = mesh({ reliefFace: 'outside', frameWidth: 1, frame: true, image: brightLeft });
  let worst = Infinity, n = 0;
  for (let i = 0; i < m.vertCount; i++) {
    const [x, y] = m.vertex(i);
    const ax = Math.abs(x), ay = Math.abs(y);
    const depth = a - Math.max(ax, ay);
    if (depth < 1e-6 || depth > frameT - 1e-6) continue;          // on the outer square, or the inner face
    const along = ax >= ay ? a - ay : a - ax;                      // distance to the nearer corner of its wall
    n++;
    if (along < worst) worst = along;
  }
  check('outside: no recess reaches over a corner post, even with the narrowest frame asked for',
    n > 0 && worst > frameT, `${n} recessed vertices, nearest ${worst.toFixed(2)} mm from a corner, post ${frameT} mm`);
  isSolid('outside relief with a 1 mm frame asked for', m);
}

// ===========================================================================
// Handedness, from where people stand: outside the shade, light inside
// ===========================================================================
console.log('\n-- the pictures read the right way round from outside --');
{
  // Left half of the photograph white (thin), right half black (thick). From
  // outside, the thin half must be on the viewer's LEFT, on all four walls.
  const cases = [
    ['outside, no fitting', { reliefFace: 'outside' }, (m) => m, (r) => [0, asMesh(r).bbox().size[2]]],
    ['inside, no fitting', { reliefFace: 'inside' }, (m) => m, (r) => [0, asMesh(r).bbox().size[2]]],
    ['outside, E27, hanging', { reliefFace: 'outside', fitting: 'e27' }, turnOver, (r) => [0, r.meta.fitting.depthFromWebMM]],
    ['inside, E27, hanging', { reliefFace: 'inside', fitting: 'e27' }, turnOver, (r) => [0, r.meta.fitting.depthFromWebMM]],
    ['outside, E27, table lamp as it stands', { reliefFace: 'outside', fitting: 'e27', fitMount: 'table' }, (m) => m, (r) => [3, 3 + r.meta.fitting.depthFromWebMM]],
    ['inside, E27, table lamp as it stands', { reliefFace: 'inside', fitting: 'e27', fitMount: 'table' }, (m) => m, (r) => [3, 3 + r.meta.fitting.depthFromWebMM]],
    ['outside, Bambu LED', { reliefFace: 'outside', fitting: 'bambu-led', fitBore: POCKET }, (m) => m, (r) => [r.meta.fitting.baseMM, r.meta.fitting.heightMM]],
  ];
  for (const [label, over, pose, span] of cases) {
    const r = build({ ...over, image: brightLeft, shadeSide: 80, fit: 'crop', imageHeight: 60 });
    const m = pose(asMesh(r));
    const [z0, z1] = span(r), z = (z0 + z1) / 2;
    const quarter = (80 - 2 * 7) / 4;
    const res = WALLS.map(N => [thicknessSeen(m, N, -quarter, z, 40), thicknessSeen(m, N, quarter, z, 40)]);
    const ok = res.every(([l, rr]) => l < 1.0 && rr > 2.8);
    check(`${label}: on all four walls the bright half is on the viewer's left`, ok,
      res.map(([l, rr]) => `${l.toFixed(2)}|${rr.toFixed(2)}`).join('  '));
  }
}

// ===========================================================================
// The E27 web
// ===========================================================================
console.log('\n-- E27: the web, the bore, and which way up --');
const E27P = { fitting: 'e27', fitBore: 41, fitHub: 9, fitWeb: 3, fitArm: 10 };
{
  const m = mesh({ ...E27P, shadeSide: 110 });
  isSolid('E27 shade, 110 mm', m);
  onPlate('E27 shade', m, 1e-6);
  check('the web joins the walls: the whole shade is one solid', shellsOf(m).count === 1, `${shellsOf(m).count} shells`);

  const segs = section(m, 1.5);   // through the middle of the 3 mm web on the bed
  // The bore: every section edge near the axis sits on a 41 mm circle (within
  // its facets), it closes all the way round, and nothing is inside it.
  const near_ = segs.filter(([p, q]) => Math.hypot(...p) < 22 && Math.hypot(...q) < 22);
  const radii = near_.flatMap(([p, q]) => [Math.hypot(...p), Math.hypot(...q)]);
  let turn = 0;
  for (const [p, q] of near_) {
    let d = Math.atan2(q[1], q[0]) - Math.atan2(p[1], p[0]);
    if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    turn += Math.abs(d);
  }
  check('the bore is a 41 mm circle in the web', near_.length >= 24 && Math.min(...radii) > 20.5 - 0.05 && Math.max(...radii) < 20.5 + 1e-6,
    `${near_.length} edges, r ${Math.min(...radii).toFixed(3)} to ${Math.max(...radii).toFixed(3)} mm`);
  check('and it goes all the way round', Math.abs(turn - 2 * Math.PI) < 1e-6, `${(turn / Math.PI * 180).toFixed(2)} degrees`);
  check('the bore is clear: a ray straight down the axis touches nothing',
    rayHits(m, [0, 0, -5], [0, 0, 1]).length === 0);
  // Out along an arm: solid from the bore to the outside of the wall, no gap.
  const arm = hits2D(segs, [0, 0], [1, 0]);
  check('an arm runs unbroken from the bore to the outside wall',
    arm.length === 2 && Math.abs(arm[0] - 20.5) < 1e-6 && Math.abs(arm[1] - 55) < 1e-6, arm.map(t => t.toFixed(2)).join(', '));
  // Out along a diagonal: bore, hub, a vent, then the wall.
  const diag = hits2D(segs, [0, 0], [Math.SQRT1_2, Math.SQRT1_2]);
  check('the diagonal crosses the hub, then a vent, then the wall', diag.length === 4 &&
    Math.abs(diag[1] - 29.5) < 0.1 && diag[3] > 55, diag.map(t => t.toFixed(2)).join(', '));
}
{
  // Which way up. "In use" is defined by the object, not by the generator's
  // say-so: the web end is the end where a vertical ray through an arm meets
  // material. Turned so that end is uppermost, the dark top of the picture
  // must be the end next to the web.
  const r = build({ ...E27P, image: darkTop, shadeSide: 80, fit: 'crop', imageHeight: 60 });
  const m = asMesh(r), H = m.bbox().size[2];
  const armHits = rayHits(m, [25, 0, -5], [0, 0, 1]).map(t => t - 5);
  const webAtBed = armHits.length >= 2 && armHits[0] < 1e-6 && armHits[1] <= 3 + 1e-6;
  check('the web prints on the bed', webAtBed, armHits.map(t => t.toFixed(2)).join(', '));
  const hung = webAtBed ? turnOver(m) : m;   // web uppermost
  const depth = H - 3;
  const nearWeb = thicknessSeen(hung, [0, -1], 0, depth - 7 - 6, 40);
  const nearMouth = thicknessSeen(hung, [0, -1], 0, 7 + 6, 40);
  check('hung from the holder, the top of the picture is the end by the web',
    nearWeb > 2.8 && nearMouth < 1.0, `by the web ${nearWeb.toFixed(2)} mm, by the mouth ${nearMouth.toFixed(2)} mm`);
}
{
  // The step guard has to follow the nozzle. Printed web-down, the nozzle climbs
  // from the top of the picture to its bottom, so no row may be thicker than
  // the one printed under it by more than the limit.
  const p = { ...BASE, ...E27P, image: darkTop, overhangGuard: true, fit: 'crop', imageHeight: 60, shadeSide: 80 };
  const tm = thicknessMap(p, C), dw = tm.nu + 1, dz = tm.H / tm.nv;
  let worstUp = 0, worstDown = 0;
  for (let j = 0; j < tm.nv; j++) for (let i = 0; i <= tm.nu; i++) {
    const lower = tm.t[(j + 1) * dw + i], upper = tm.t[j * dw + i];   // web-down: row j sits above row j+1
    worstUp = Math.max(worstUp, (upper - lower) / dz);
    worstDown = Math.max(worstDown, (lower - upper) / dz);
  }
  check('E27: the guard limits the rise in the direction it is printed', worstUp <= 2.0 + 1e-9,
    `${worstUp.toFixed(3)} mm per mm rising on the bed, ${worstDown.toFixed(3)} the other way`);
}

{
  // The table lamp stands the way it prints: web on the bed, and no turning
  // over, so the top of the picture is the end AWAY from the web.
  const r = build({ ...E27P, fitMount: 'table', image: darkTop, shadeSide: 80, fit: 'crop', imageHeight: 60 });
  const m = asMesh(r), H = m.bbox().size[2];
  const armHits = rayHits(m, [25, 0, -5], [0, 0, 1]).map(t => t - 5);
  check('table lamp: the web prints on the bed', armHits.length >= 2 && armHits[0] < 1e-6 && Math.abs(armHits[1] - 3) < 1e-6,
    armHits.map(t => t.toFixed(2)).join(', '));
  check('table lamp: and the bore is clear straight up the axis', rayHits(m, [0, 0, -5], [0, 0, 1]).length === 0);
  const nearWeb = thicknessSeen(m, [0, -1], 0, 3 + 7 + 6, 40);
  const nearRim = thicknessSeen(m, [0, -1], 0, H - 7 - 6, 40);
  check('table lamp: the top of the picture is the end away from the web',
    nearRim > 2.8 && nearWeb < 1.0, `by the rim ${nearRim.toFixed(2)} mm, by the web ${nearWeb.toFixed(2)} mm`);
  isSolid('E27 table lamp, 80 mm', m);
  check('table lamp: one solid', shellsOf(m).count === 1, `${shellsOf(m).count} shells`);
  // The guard follows the nozzle the ordinary way up here. A bright top
  // against the 3.6 mm frame is a 2.8 mm step outward as the print rises,
  // which is the one this has to catch (a dark top never steps out at all).
  const brightTop = img(64, 64, (_x, y) => (y < 32 ? 1 : 0));
  const tm = thicknessMap({ ...BASE, ...E27P, fitMount: 'table', image: brightTop, overhangGuard: true, fit: 'crop', imageHeight: 60, shadeSide: 80 }, C);
  const dw = tm.nu + 1, dz = tm.H / tm.nv;
  let worst = 0;
  for (let j = 0; j < tm.nv; j++) for (let i = 0; i <= tm.nu; i++) worst = Math.max(worst, (tm.t[(j + 1) * dw + i] - tm.t[j * dw + i]) / dz);
  check('table lamp: the guard limits the rise in the direction it is printed', worst <= 2.0 + 1e-9, `${worst.toFixed(3)} mm per mm`);
}
{
  // The bulb along the axis: A60 110 mm from a holder mouth 15 mm (estimated)
  // past the web is 125 mm, both ways up. 124 mm of shade past the web shows
  // bulb; 126 does not. frameWidth 7, so the picture height is depth - 14.
  for (const mount of ['pendant', 'table']) {
    const iss = (depth) => gen.validate({ ...BASE, ...E27P, fitMount: mount, shadeSide: 120, fit: 'crop', imageHeight: depth - 14 })
      .filter(i => i.param === 'imageHeight');
    const short = iss(124), long = iss(126);
    const word = mount === 'table' ? /above the web/ : /below the web/;
    check(`${mount}: the bulb-length check counts the holder (124 mm deep warns, 126 does not)`,
      short.length === 1 && word.test(short[0].message) && long.length === 0,
      short[0] ? short[0].message.slice(0, 90) : 'no warning at 124 mm');
  }
}

// ===========================================================================
// The Bambu LED base
// ===========================================================================
console.log('\n-- Bambu LED: pocket, slot, open interior --');
const BLP = { fitting: 'bambu-led', fitBore: POCKET, fitSlot: 3.2, fitWeb: 3 };
{
  const r = build({ ...BLP, shadeSide: 70 });
  const m = asMesh(r), a = 35, B = a - 3.6;
  isSolid('Bambu LED shade, 70 mm', m);
  onPlate('Bambu LED shade', m, 1e-6);
  check('the base and the shade are one solid', shellsOf(m).count === 1, `${shellsOf(m).count} shells`);
  const floorT = 3, pocketTop = floorT + 8 + FIT.push;
  const pk = section(m, floorT + 4);
  // The pocket, measured with rays from the axis away from the slot.
  let lo = Infinity, hi = 0;
  for (let k = 0; k < 72; k++) {
    const ang = k * 5 * Math.PI / 180;
    if (Math.abs(ang - 1.5 * Math.PI) < 0.2) continue;              // the slot, along -y
    const h = hits2D(pk, [0, 0], [Math.cos(ang), Math.sin(ang)]);
    lo = Math.min(lo, h[0]); hi = Math.max(hi, h[0]);
  }
  check(`the pocket is a ${POCKET.toFixed(1)} mm circle`, lo > POCKET / 2 - 0.05 && hi < POCKET / 2 + 1e-6,
    `wall at ${lo.toFixed(3)} to ${hi.toFixed(3)} mm from the axis`);
  // The slot: a gap of fitSlot through the floor and through the pocket wall,
  // all the way out to the outside face.
  for (const [name, z] of [['floor', floorT / 2], ['pocket wall', floorT + 4]]) {
    const s = section(m, z);
    for (const y of [-(a - 0.05), -(POCKET / 2 + 1)]) {
      const g = gapsAlongX(s, y, -a - 5).gaps.filter(([x0, x1]) => x0 < 0 && x1 > 0);
      check(`the slot through the ${name} is 3.2 mm wide at y = ${y.toFixed(1)}`,
        g.length === 1 && Math.abs(g[0][1] - g[0][0] - 3.2) < 1e-6, g.map(([x0, x1]) => `${x0.toFixed(2)}..${x1.toFixed(2)}`).join(' '));
    }
  }
  check('straight down the slot from the pocket there is nothing until the open air',
    hits2D(pk, [0, 0], [0, -1]).length === 0);
  // The wall bridges over the slot above the base.
  const above = section(m, pocketTop + 1);
  check('above the base the wall is whole over the slot',
    gapsAlongX(above, -(a - 1), -a - 5).gaps.filter(([x0, x1]) => x0 < 0 && x1 > 0).length === 0);
  // Light reaches all four walls: from the puck's face, out to each wall, the
  // first thing met is that wall's inner face.
  const z = pocketTop + 1;
  const firsts = WALLS.map(N => rayHits(m, [0, 0, z], [N[0], N[1], 0])[0]);
  check('from the puck, every wall is in plain view', firsts.every(t => Math.abs(t - B) < 1e-6),
    firsts.map(t => t.toFixed(3)).join(', '));
  const down = rayHits(m, [5, 5, m.bbox().max[2] + 5], [0, 0, -1]);
  check('nothing between the top of the shade and the pocket floor',
    down.length === 2 && Math.abs((m.bbox().max[2] + 5 - down[0]) - floorT) < 1e-6,
    `first hit at z = ${(m.bbox().max[2] + 5 - down[0]).toFixed(3)}`);
  // Two cooling holes under the puck.
  const vx = 0.45 * POCKET / 2;
  check('two cooling holes through the floor',
    rayHits(m, [vx, 0, -5], [0, 0, 1]).length === 0 && rayHits(m, [-vx, 0, -5], [0, 0, 1]).length === 0);
}

// ===========================================================================
// What validate() says about the lamps
// ===========================================================================
console.log('\n-- validate --');
{
  const v = (over) => gen.validate({ ...BASE, ...over });
  check('E27 at 70 mm warns that the A60 bulb is too close to the walls',
    v({ ...E27P, shadeSide: 70 }).some(i => i.param === 'shadeSide' && i.severity === 'warn' && /A60/.test(i.message)));
  check('E27 at 120 mm does not',
    !v({ ...E27P, shadeSide: 120 }).some(i => i.param === 'shadeSide'));
  check('E27 warns when the bulb hangs out of the mouth',
    v({ ...E27P, fit: 'crop', imageHeight: 60 }).some(i => i.param === 'imageHeight' && /below the web/.test(i.message)));
  const cut = v({ ...E27P, shadeSide: 45 }).find(i => i.param === 'fitBore');
  check('E27 on a shade too small for the bore is an error naming the size that works',
    cut && cut.severity === 'error' && /at least 55 mm/.test(cut.message), cut ? cut.message.slice(0, 120) : 'no issue');
  const small = v({ ...BLP, shadeSide: 66 }).find(i => i.param === 'shadeSide' && i.severity === 'error');
  check('Bambu LED on a 66 mm shade is an error naming 69 mm as the smallest that takes the puck',
    small && /69 mm/.test(small.message), small ? small.message.slice(0, 140) : 'no issue');
  const ok70 = v({ ...BLP, shadeSide: 70 }).filter(i => i.severity !== 'info');
  check('Bambu LED at the default 70 mm just works', ok70.length === 0, ok70.map(i => i.message.slice(0, 60)).join(' | '));
  for (const pr of gen.presets.filter(pr => pr.values.fitting && pr.values.fitting !== 'none')) {
    const iss = gen.validate({ ...defaults(gen), ...pr.values }).filter(i => i.severity !== 'info' && i.param !== 'image');
    check(`preset "${pr.name}" raises no warnings`, iss.length === 0, iss.map(i => i.message.slice(0, 70)).join(' | '));
  }
}

// ===========================================================================
// No zero-area triangles where the fitting meets the walls
//
// Counted by analyze(), the same function the analysis panel reports from.
// The seams are closed with healTJunctions, whose plain fan lays zero-area
// triangles along a split edge; 372 of them on the table lamp preset before
// the fitted shades asked for the clean fan.
// ===========================================================================
console.log('\n-- degenerate triangles --');
for (const pr of gen.presets.filter(pr => pr.values.shape === 'shade')) {
  const a = analyze(asMesh(gen.build({ ...defaults(gen), ...pr.values }, {})));
  check(`preset "${pr.name}": no degenerate triangles, as the analysis panel counts them`,
    a.degenerateTris === 0 && a.watertight, `${a.degenerateTris} degenerate, watertight ${a.watertight}`);
}
for (const face of ['outside', 'inside']) {
  for (const over of [{ fitting: 'e27' }, { fitting: 'e27', fitMount: 'table' }, { fitting: 'bambu-led', fitBore: POCKET }]) {
    const a = analyze(mesh({ ...over, reliefFace: face, shadeSide: 100 }));
    check(`${face}, ${over.fitting}${over.fitMount ? ' ' + over.fitMount : ''}: no degenerate triangles`,
      a.degenerateTris === 0, `${a.degenerateTris} degenerate`);
  }
}

// ===========================================================================
// No fitting is no fitting
// ===========================================================================
{
  const a = asMesh(gen.build({ ...BASE, fitting: 'none', fitBore: 55, fitWeb: 7 }, C)).toSTL('t');
  const { fitting, fitBore, fitHub, fitWeb, fitArm, fitSlot, ...bare } = BASE;
  const b = asMesh(gen.build(bare, C)).toSTL('t');
  let same = a.length === b.length;
  for (let i = 84; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  check('fitting "none" ignores every fitting number and matches a request that never named one',
    same, `${a.length} vs ${b.length} bytes`);
}

done();
