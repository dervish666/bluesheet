// js/gen/arm.js — an articulated arm that locks where you put it.
//
// The joint is the whole design. A friction joint made of PLA is a joint that
// slowly gives up: the plastic creeps, the screw backs off, and a week later
// the screen is looking at the floor. So every joint here is a SERRATED face
// clamped by a bolt — the load goes into the flanks of the teeth, not into
// friction, and the only thing the bolt has to do is stop the two faces
// parting.
//
// WHY IDENTICAL FACES MATE. Both faces of every hub carry the same triangular
// wave, which looks wrong: put two identical serrated faces together and the
// ridges land on ridges. Rotate one by HALF a tooth and they mesh perfectly,
// because a symmetric triangle wave shifted half a period is its own negative,
// so the sum of the two surfaces is constant and they touch everywhere at
// once. Half a pitch is just another detent, so nothing is lost: the joint
// still indexes every 360/teeth degrees, and any hub mates with any other.
//
// PLANAR BY DEFAULT, NOT BY NECESSITY. Both hubs on a plain arm share an axis,
// so the chain folds in one plane — which is exactly what "point it up or down"
// needs, and it keeps every part printable flat. When one plane is not enough a
// QUARTER-TURN hub leaves it: the same toothed disc, stood on edge so its bore
// runs along Y instead of Z, carried on a web that reaches down to the plate.
// One of those anywhere in the chain buys the second axis, and the parts either
// side of it are untouched — a quarter-turn hub is still the same face, so it
// still mates with everything else. It comes two ways: as the far hub of an arm
// (armTwist), or as a short wrist adapter that spends no reach (wrist). Both are
// off unless asked for, because a plate of flat parts is the cheaper print and
// most arms only ever need to nod.
//
// Turning the display between portrait and landscape is still not a mechanism:
// the head's bolt pattern is SQUARE, so you unbolt, rotate ninety degrees and
// bolt it back. A joint that exists to be moved twice a year is a joint that
// will be loose all year.
//
// Everything prints flat, teeth upward, with no supports. The underside teeth
// are the exception and they are printed against the bed, so they come out a
// little flattened; the clamp takes that up on the first tighten. Said out
// loud in hints() rather than discovered.
import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { extrude, box, cylinder } from '../kernel/builders.js';
import { union, subtract } from '../kernel/csg.js';
import { pack, layout as packLayout } from '../kernel/pack.js';
import { clamp, num, segScale } from '../kernel/scalar.js';
import { FIT, fitNote } from '../kernel/fit.js';

// Bolt sizes: clearance bore, and the across-flats of the nut the knob traps.
const BOLTS = {
  m4: { label: 'M4', bore: 4.4, af: 7.0, head: 8.0 },
  m5: { label: 'M5', bore: 5.5, af: 8.0, head: 9.5 },
  m6: { label: 'M6', bore: 6.6, af: 10.0, head: 11.5 },
};
const boltOf = (k) => BOLTS[k] || BOLTS.m5;

const PATTERNS = { vesa75: 75, vesa100: 100 };

// ---------------------------------------------------------------------------
// The toothed hub
// ---------------------------------------------------------------------------

/**
 * A disc with radial teeth on both faces, built directly as a closed mesh.
 *
 * Rings, from the middle out: a flat top cap to `rFlat`, a vertical step up to
 * the tooth crest, the toothed annulus out to `r`, then the outer wall down to
 * the mirrored underside. Two angular samples per tooth put vertices exactly
 * on the crests and roots, so the flanks come out as true flat facets rather
 * than as a polygonal approximation of a triangle.
 *
 * No bore: the bolt hole is subtracted once at the end, after the hub has been
 * unioned onto whatever body carries it. Boring first would leave two
 * coincident cylinders for the CSG to reconcile, which is work it does not
 * need to be given.
 */
export function toothedDisc(r, rFlat, coreT, teeth, toothH) {
  const N = Math.max(6, Math.round(teeth));
  const M = N * 2;                       // crest, root, crest, root, ...
  const m = new Mesh();
  const half = coreT / 2;

  const topC = m.addVertex(0, 0, half);
  const botC = m.addVertex(0, 0, -half);
  const A = [], B = [], C = [], A2 = [], B2 = [], C2 = [];
  for (let j = 0; j < M; j++) {
    const t = Math.PI * 2 * j / M;
    const ct = Math.cos(t), st = Math.sin(t);
    const u = (j % 2 === 0) ? 1 : 0;     // crest on even samples
    const z = half + toothH * u;
    A.push(m.addVertex(rFlat * ct, rFlat * st, half));
    B.push(m.addVertex(rFlat * ct, rFlat * st, z));
    C.push(m.addVertex(r * ct, r * st, z));
    A2.push(m.addVertex(rFlat * ct, rFlat * st, -half));
    B2.push(m.addVertex(rFlat * ct, rFlat * st, -z));
    C2.push(m.addVertex(r * ct, r * st, -z));
  }
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    m.addTri(topC, A[j], A[k]);                 // flat cap, top
    m.addQuad(A[j], B[j], B[k], A[k]);          // step up to the crest
    m.addQuad(B[j], C[j], C[k], B[k]);          // the toothed annulus
    m.addQuad(C[j], C2[j], C2[k], C[k]);        // outer wall
    m.addTri(botC, A2[k], A2[j]);               // flat cap, bottom
    m.addQuad(A2[k], B2[k], B2[j], A2[j]);
    m.addQuad(B2[k], C2[k], C2[j], B2[j]);
  }
  return m;
}

/** The angle, in degrees, between one detent and the next. */
export const detentDeg = (teeth) => 360 / Math.max(6, Math.round(teeth));

// ---------------------------------------------------------------------------
// The quarter-turn hub
// ---------------------------------------------------------------------------
//
// The same disc, stood on edge: bore along Y, face normals along Y, teeth
// unchanged. Everything that makes a hub mate is a property of the face, and
// the face is untouched by turning it, so a quarter-turn hub mates with a flat
// one exactly as a flat one does. What is new is that it needs CARRYING — a
// flat hub is held by the bar it grew out of, a standing one is held by a web.
//
// The web is a tombstone in the XZ plane: square-shouldered where it lands on
// the plate, rounded over the top on the hub's own centre. Three numbers in it
// are chosen to keep two surfaces from ever becoming one, which is the failure
// this file has met most often:
//
//   * it is THINNER than the hub core, so its flanks never lie in the plane of
//     a hub face. That also puts it entirely inside the core's shadow, so the
//     web itself is never what the clamped part runs into — what limits the
//     swing is the bar further down, which hints() says out loud.
//   * its rounded top is a smaller circle than the disc, CONCENTRIC with it, so
//     the whole top of the web is buried inside the disc and contributes no
//     surface at all to the union. The price is a narrow ring of disc below the
//     centre with nothing under it — a real overhang, said out loud in hints().
//   * the whole disc is lifted clear of the bar or fin it stands on. This one is
//     not cosmetic. Whatever clamps onto a hub is ITSELF a full disc of the same
//     radius, and it arrives along the bolt — so if the standing hub's rim dips
//     below the top face of the body carrying it, the mating disc has to pass
//     through that body to get there and the joint cannot be assembled at all.
//     Sitting the disc on the plate put 5.7 mm of it below the bar, over a
//     23.5 mm chord: a part that measured perfectly and could not be bolted to
//     anything. Everything else here was already true of that version.
//
// Which is the whole reason the hub sits a clear diameter up in the air.

// The gap between the standing disc's rim and the top face of the body it grows
// out of. It is what the mating hub swings in, so it is a real clearance and not
// a nudge — and it also keeps the rim from landing exactly tangent to that face,
// which is the degenerate case the CSG here has never liked.
const HUB_CLEAR = 0.8;

/** How far below the disc's rim the web stops. */
const webInset = (L) => Math.min(1.5, Math.max(0.5, L.hubR * 0.1));

/**
 * The web's thickness, on a body `hostW` wide in Y.
 *
 * Strictly under the hub core AND strictly under the body it stands on, so it
 * is coplanar with neither. The floor of 2 mm keeps it printable when a thin
 * core would otherwise ask for a wall under a nozzle width.
 */
const webThick = (L, hostW) => Math.max(2, Math.min(L.coreT - 1, hostW - 1));

/**
 * Where a quarter-turn hub's centre sits: a full radius above the top face of
 * the body it stands on, plus the clearance the mating hub needs to turn in.
 */
const hubRise = (L) => L.coreT / 2 + HUB_CLEAR + L.hubR;

/**
 * A toothed hub turned a quarter, at x = `xc`, standing on a body `hostW` wide.
 *
 * Returns the solid to union on and the bore to take out of it afterwards —
 * the bore is deferred for the same reason every other bore here is, so the
 * CSG is never handed two coincident cylinders to reconcile.
 */
function verticalHub(L, xc, hostW) {
  const zc = hubRise(L);
  const wT = webThick(L, hostW);
  const rW = Math.max(2.5, L.hubR - webInset(L));
  const segs = Math.max(24, L.segs);

  // Tombstone: a disc of radius rW on the hub centre, plus a rectangle of the
  // same width running from there down to the underside of the part.
  const h = zc + L.coreT / 2;
  const prof = P.union(
    [[P.circle(rW, { segs, cx: xc, cy: zc })]],
    [[P.rect(2 * rW, h, { cx: xc, cy: zc - h / 2 })]],
  );
  // Extruded along its own normal, then laid over: profile Y becomes model Z,
  // and the extrusion thickness becomes model Y.
  const web = extrude(prof, wT, { z0: -wT / 2, check: false }).rotateX(Math.PI / 2);
  const disc = toothedDisc(L.hubR, L.rFlat, L.coreT, L.teeth, L.toothH)
    .rotateX(Math.PI / 2).translate(xc, 0, zc);

  const len = L.coreT + 4 * L.toothH + 4;
  const cutter = cylinder(L.bolt.bore / 2, len, { segments: L.segs, z0: -len / 2 })
    .rotateX(Math.PI / 2).translate(xc, 0, zc);

  return { solid: union(web, disc), cutter, xc, zc, rW, wT };
}

// ---------------------------------------------------------------------------

function plan(p, ctx = {}) {
  const sf = segScale(ctx);
  const segs = Math.max(16, Math.round(48 * sf));

  const bolt = boltOf(p.bolt);
  const teeth = Math.round(clamp(num(p.teeth, 24), 8, 60));
  const hubD = clamp(num(p.hubD, 30), 14, 70);
  const hubR = hubD / 2;
  const coreT = clamp(num(p.coreT, 6), 2.5, 14);
  // A tooth taller than a quarter of the core turns the hub into a gear with
  // nothing behind it; a tooth under two layers is a texture, not a detent.
  const toothH = clamp(num(p.toothH, 1.2), 0.3, Math.max(0.3, coreT * 0.35));
  // The teeth need room outside the bolt head, or tightening bears on flanks.
  const rFlat = clamp(bolt.head / 2 + 1.2, 2, Math.max(2.4, hubR - 2));

  // Two hubs of diameter hubD centred armLength apart are TANGENT when
  // armLength == hubD, and a tangent union is a degenerate one (it produced
  // four non-manifold edges at the short end of the sweep). Every hub must
  // stay identical or nothing mates, so it is the length that gives.
  const armLength = Math.max(clamp(num(p.armLength, 90), 30, 200), hubD + 6);
  const armW = clamp(num(p.armW, 16), 6, 60);
  const armCount = Math.round(clamp(num(p.armCount, 2), 1, 3));
  // A twist is a property of an arm, so there cannot be more twisted arms than
  // there are arms. Asking for more is not worth refusing over — it clamps, and
  // validate() says that it did.
  const armTwist = Math.round(clamp(num(p.armTwist, 0), 0, armCount));
  const wrist = Math.round(clamp(num(p.wrist, 0), 0, 2));

  const patternKey = PATTERNS[p.pattern] ? p.pattern : (p.pattern === 'custom' ? 'custom' : 'vesa75');
  const pitch = patternKey === 'custom'
    ? clamp(num(p.patternPitch, 50), 15, 140)
    : PATTERNS[patternKey];
  const headHole = clamp(num(p.headHole, 4.5), 2.5, 8);
  // The plate must clear the bolt circle, and the fin it stands on.
  const plateT = clamp(num(p.plateT, 4), 2, 10);

  const baseW = clamp(num(p.baseW, 70), 30, 200);
  const baseD = clamp(num(p.baseD, 60), 30, 200);
  const baseT = clamp(num(p.baseT, 5), 2, 12);
  const baseHole = clamp(num(p.baseHole, 4.5), 2.5, 8);

  const knobD = clamp(num(p.knobD, 26), 12, 60);
  const knobT = clamp(num(p.knobT, 9), 5, 25);
  const flutes = Math.round(clamp(num(p.flutes, 9), 4, 20));
  const nutT = clamp(num(p.nutT, 4), 1.6, Math.max(1.6, knobT - 2.5));

  // The plate is sized to the bolt pattern it has to carry. Anything smaller
  // cannot hold the pattern at its true pitch, and a pattern at the wrong
  // pitch is not the pattern.
  const need = minPlateFor({ coreT }, pitch, headHole);
  const plateW = clamp(num(p.plateW, 90), need.w, 240);
  const plateH = clamp(num(p.plateH, 90), need.h, 240);

  const part = ['all', 'base', 'arm', 'head', 'knob', 'wrist'].includes(p.part) ? p.part : 'all';
  const fit = clamp(num(p.fit, FIT.slide), 0.05, 0.8);

  return {
    sf, segs, bolt, teeth, hubD, hubR, coreT, toothH, rFlat,
    armLength, armW, armCount, armTwist, wrist,
    patternKey, pitch, headHole, plateW, plateH, plateT,
    baseW, baseD, baseT, baseHole, knobD, knobT, flutes, nutT, part, fit,
    detent: detentDeg(teeth),
    reach: armLength * armCount,
    // Base, head and every arm and wrist between them: one clamp per junction,
    // and one knob per clamp.
    joints: armCount + wrist + 1,
    verticalHubs: armTwist + wrist,
  };
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Remove cutters ONE AT A TIME.
 *
 * Merging them into a single subtrahend is faster and is what the other
 * generators here do, but it is only sound when the cutters are DISJOINT. The
 * knob's bolt bore runs straight through its hexagonal nut trap, and handing
 * BSP two overlapping solids as one operand opened the mesh up with 103
 * boundary edges while reporting nothing. Sequential subtraction costs a few
 * milliseconds and cannot express the invalid case at all.
 */
function subtractEach(mesh, cutters) {
  let m = mesh;
  for (const c of cutters) m = subtract(m, c);
  return m;
}

const bore = (L, cx, cy, h, z0) =>
  cylinder(L.bolt.bore / 2, h, { segments: L.segs, z0 }).translate(cx, cy, 0);

/**
 * A bar with a toothed hub at each end.
 *
 * Flat, both hubs share the bar's own axis and the chain stays in one plane.
 * Twisted, the FAR hub is stood on edge, so whatever hangs off it swings in the
 * perpendicular plane. The near hub is identical either way — which is the
 * whole point, and what check-arm-twist measures: a twisted arm has to remain
 * bolt-compatible with a flat one, or the set stops being a set.
 *
 * `armLength` still means hub centre to hub centre along the bar. The twisted
 * hub's centre also rises to a radius above the plate, so the two axes are not
 * coplanar — that is the geometry doing what was asked, not drift.
 */
function buildArm(L, twisted = false) {
  const half = L.armLength / 2;
  const w = Math.min(L.armW, L.hubD * 0.95);
  const bar = extrude([[P.roundRect(L.armLength, w, w / 2, { segs: Math.max(8, Math.round(L.segs / 3)) })]],
    L.coreT, { z0: -L.coreT / 2, check: false });

  let m = union(bar, toothedDisc(L.hubR, L.rFlat, L.coreT, L.teeth, L.toothH).translate(-half, 0, 0));
  const cutters = [bore(L, -half, 0, L.coreT + 4 * L.toothH + 4, -(L.coreT / 2 + 2 * L.toothH + 2))];

  if (twisted) {
    const v = verticalHub(L, half, w);
    m = union(m, v.solid);
    cutters.push(v.cutter);
  } else {
    m = union(m, toothedDisc(L.hubR, L.rFlat, L.coreT, L.teeth, L.toothH).translate(half, 0, 0));
    cutters.push(bore(L, half, 0, L.coreT + 4 * L.toothH + 4, -(L.coreT / 2 + 2 * L.toothH + 2)));
  }
  return subtractEach(m, cutters).healTJunctions();
}

/**
 * The wrist: one flat hub, one standing hub, ninety degrees apart and as little
 * between them as the geometry allows.
 *
 * The same turn an armTwist gives, without spending an arm's length or an arm's
 * filament on it. Drop one in anywhere — base to arm to pan, arm to head to
 * roll — and the arms on either side stay ordinary arms.
 *
 * The two hubs cannot simply be pushed together: the web reaches out to nearly
 * the disc's own radius, and if it overlapped the flat hub it would bury the
 * face that hub exists to present. So they are set apart by both radii plus
 * clearance for the teeth of whatever clamps on, and that spacing IS the part's
 * length. Making it shorter would make it not work.
 */
function buildWrist(L) {
  const rW = Math.max(2.5, L.hubR - webInset(L));
  const xc = L.hubR + rW + Math.max(2, 2 * L.toothH);
  // From the flat hub's rim to the far edge of the web, exactly: the fin ends
  // where the tombstone does.
  const x0 = -L.hubR, x1 = xc + rW;
  const fin = extrude([[P.roundRect(x1 - x0, L.hubD, L.hubD / 2,
    { segs: Math.max(8, Math.round(L.segs / 3)), cx: (x0 + x1) / 2 })]],
    L.coreT, { z0: -L.coreT / 2, check: false });

  let m = union(fin, toothedDisc(L.hubR, L.rFlat, L.coreT, L.teeth, L.toothH));
  const cutters = [bore(L, 0, 0, L.coreT + 4 * L.toothH + 4, -(L.coreT / 2 + 2 * L.toothH + 2))];
  const v = verticalHub(L, xc, L.hubD);
  m = union(m, v.solid);
  cutters.push(v.cutter);
  return subtractEach(m, cutters).healTJunctions();
}

/** Centre-to-centre length of a wrist, for the reach arithmetic. */
function wristSpan(L) {
  return L.hubR + Math.max(2.5, L.hubR - webInset(L)) + Math.max(2, 2 * L.toothH);
}

/**
 * A fin carrying one hub, with a plate standing perpendicular to it.
 *
 * This is the shape both ends of the system need, and the reason it is an L
 * is printing: laid down with the fin flat, the teeth face up and the plate is
 * a vertical wall, so nothing overhangs. In use it is turned ninety degrees,
 * and the plate is the part that meets the desk or the display.
 */
function buildFinPlate(L, { plateW, plateH, plateT, holes, holeD, finReach }) {
  const fin = extrude([[P.roundRect(finReach + L.hubD, L.hubD, L.hubD / 2,
    { segs: Math.max(8, Math.round(L.segs / 3)), cx: (finReach) / 2 })]],
    L.coreT, { z0: -L.coreT / 2, check: false });
  let m = union(fin, toothedDisc(L.hubR, L.rFlat, L.coreT, L.teeth, L.toothH));

  // The plate stands on the far end of the fin, rising in +Z: a wall, which
  // prints without support, rather than a shelf, which does not.
  const rings = [P.roundRect(plateW, plateT, Math.min(plateT, 2) * 0.4,
    { segs: 8, cx: 0, cy: 0 })];
  const wall = extrude([rings], plateH, { z0: -L.coreT / 2, check: false })
    .mapVerts((x, y, z) => [x, y, z])
    .rotateZ(Math.PI / 2)
    .translate(finReach + L.hubD / 2 - plateT / 2, 0, 0);
  m = union(m, wall);

  // Fixing holes through the plate, drilled along its own normal (X).
  const cut = [bore(L, 0, 0, L.coreT + 4 * L.toothH + 4, -(L.coreT / 2 + 2 * L.toothH + 2))];
  for (const [hy, hz] of holes) {
    cut.push(cylinder(holeD / 2, plateT + 4, { segments: L.segs, z0: -plateT / 2 - 2 })
      .rotateY(Math.PI / 2)
      .translate(finReach + L.hubD / 2 - plateT / 2, hy, hz));
  }
  return subtractEach(m, cut).healTJunctions();
}

/**
 * Where the fixing holes can go on a plate that stands on a fin.
 *
 * The plate rises from z = -coreT/2, but the FIN occupies z up to +coreT/2 at
 * that end, so a hole placed by symmetry about the plate's centre can land
 * straddling the fin's top face. Cutting a cylinder exactly through the seam
 * of a union is a degenerate case, and it opened the base up with twelve
 * boundary edges that sequential subtraction did not touch — because it was
 * never a CSG-ordering problem, it was a hole in the wrong place.
 *
 * So the usable band starts ABOVE the fin, and the holes are placed inside it.
 */
function plateHoles(L, plateW, plateH, holeD, pitch) {
  const m = Math.max(holeD * 0.9, 5);
  const zLo = L.coreT / 2 + holeD;            // clear of the fin, with room
  const zHi = -L.coreT / 2 + plateH - m;
  const yLim = plateW / 2 - m;
  if (!(zHi > zLo + 1) || !(yLim > 1)) return [];
  const zc = (zLo + zHi) / 2;
  if (pitch !== undefined) {
    // A bolt pattern is EXACT or it is not that pattern. Squeezing 75 mm into
    // the space left over gave 74.5 mm — which looks fine, passes every
    // topology check, and does not bolt to a VESA 75 mount. If the plate
    // cannot hold the true pitch, drill nothing and let validate() say why.
    const half = pitch / 2;
    if (half > yLim || zc - half < zLo - 1e-9 || zc + half > zHi + 1e-9) return [];
    const out = [];
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([sy * half, zc + sz * half]);
    return out;
  }
  const want = Math.min(zHi - zLo, 2 * yLim);
  const hz = Math.min(want / 2, (zHi - zLo) / 2);
  const hy = Math.min(want / 2, yLim);
  const out = [];
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([sy * hy, zc + sz * hz]);
  return out;
}

/** The smallest plate that can carry `pitch` exactly, given the fin below it. */
function minPlateFor(L, pitch, holeD) {
  const m = Math.max(holeD * 0.9, 5);
  return { w: pitch + 2 * m, h: pitch + L.coreT + holeD + m + 0.001 };
}

function buildHead(L) {
  L.headHoles = plateHoles(L, L.plateW, L.plateH, L.headHole, L.pitch);
  return buildFinPlate(L, {
    plateW: L.plateW, plateH: L.plateH, plateT: L.plateT,
    holes: L.headHoles,
    holeD: L.headHole, finReach: L.hubD * 0.9,
  });
}

function buildBase(L) {
  return buildFinPlate(L, {
    plateW: L.baseW, plateH: L.baseD, plateT: L.baseT,
    holes: plateHoles(L, L.baseW, L.baseD, L.baseHole),
    holeD: L.baseHole, finReach: L.hubD * 0.7,
  });
}

/** The clamp knob: fluted rim, through bore, hexagonal nut trap. */
function buildKnob(L) {
  const r = L.knobD / 2;
  const fr = r * 0.16;
  // Scallops around the rim, cut in 2D so the knob is one clean extrusion.
  const outer = P.circle(r, { segs: Math.max(48, L.segs) });
  let shape = [[outer]];
  for (let k = 0; k < L.flutes; k++) {
    const a = Math.PI * 2 * k / L.flutes;
    const cut = [[P.circle(fr, { segs: Math.max(12, Math.round(L.segs / 3)), cx: Math.cos(a) * r, cy: Math.sin(a) * r })]];
    try { const d = P.boolean(shape, cut, 'difference'); if (d.length) shape = d; } catch { /* keep */ }
  }
  const body = extrude(shape, L.knobT, { check: false });
  const cutters = [cylinder(L.bolt.bore / 2, L.knobT + 4, { segments: L.segs, z0: -2 })];
  // Nut trap, open at the bottom face so the nut drops in.
  const af = L.bolt.af + 0.3;
  cutters.push(extrude([[P.ensureCCW(P.regularPolygon(6, af / Math.cos(Math.PI / 6) / 2))]],
    L.nutT + 1, { z0: -1, check: false }));
  // Sequential: the bore runs straight through the nut trap, so these two
  // cutters overlap and must never be handed to BSP as one operand.
  return subtractEach(body, cutters).healTJunctions();
}

// ---------------------------------------------------------------------------

/**
 * Lay the set out flat. The kernel's packer already solves this properly,
 * rotation included; a hand-rolled row packer put a 100 mm head plate and an
 * 80 mm base in separate rows and ran the plate to 245 mm.
 */
function arrange(list) {
  const centred = list.map(q => ({ name: q.name, mesh: q.mesh.centerXY().dropToPlate() }));
  if (centred.length === 1) {
    const m = centred[0].mesh.place();
    return { mesh: m, parts: [{ name: centred[0].name, mesh: m }] };
  }
  const byId = {};
  const items = centred.map((c) => {
    byId[c.name] = c.mesh;
    const b = c.mesh.bbox();
    return { id: c.name, w: b.size[0], d: b.size[1] };
  });
  let parts = null;
  try {
    const packing = pack(items, { x: 180, y: 180 }, { gap: 4 });
    if (!packing.unplaced.length) parts = packLayout(byId, packing).parts.map(q => ({ name: q.id, mesh: q.mesh, rot: !!q.rot }));
  } catch { parts = null; }
  if (!parts) {
    // Too big for one plate: a plain row is an honest overflow rather than an
    // overlapping preview that pretends everything fits.
    let x = 0;
    parts = centred.map((c) => {
      const w = c.mesh.bbox().size[0];
      const m = c.mesh.translate(x + w / 2, 0, 0);
      x += w + 4;
      return { name: c.name, mesh: m, rot: false };
    });
  }
  const merged = Mesh.merge(parts.map(q => q.mesh));
  const bb = merged.bbox();
  const off = [-bb.center[0], -bb.center[1], -bb.min[2]];
  return {
    mesh: merged.translate(off[0], off[1], off[2]),
    parts: parts.map(q => ({ name: q.name, mesh: q.mesh.translate(off[0], off[1], off[2]), rot: q.rot })),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

function build(p, ctx = {}) {
  const L = plan(p, ctx);
  const wanted = [];
  if (L.part === 'all' || L.part === 'base') wanted.push({ name: 'base', mesh: buildBase(L) });
  if (L.part === 'all' || L.part === 'arm') {
    // Two shapes at most, however many arms there are. The twisted ones go at
    // the FAR end of the chain, where a second axis is worth having.
    const flat = L.armTwist < L.armCount ? buildArm(L, false) : null;
    const tw = L.armTwist > 0 ? buildArm(L, true) : null;
    let usedFlat = 0, usedTw = 0;
    for (let i = 0; i < L.armCount; i++) {
      const twisted = i >= L.armCount - L.armTwist;
      const src = twisted ? tw : flat;
      const first = (twisted ? usedTw++ : usedFlat++) === 0;
      wanted.push({ name: L.armCount > 1 ? `arm ${i + 1}` : 'arm', mesh: first ? src : src.clone() });
    }
  }
  if (L.part === 'wrist' || (L.part === 'all' && L.wrist > 0)) {
    const n = L.part === 'wrist' ? Math.max(1, L.wrist) : L.wrist;
    const w = buildWrist(L);
    for (let i = 0; i < n; i++) wanted.push({ name: n > 1 ? `wrist ${i + 1}` : 'wrist', mesh: i === 0 ? w : w.clone() });
  }
  if (L.part === 'all' || L.part === 'head') wanted.push({ name: 'head', mesh: buildHead(L) });
  if (L.part === 'all' || L.part === 'knob') {
    const k = buildKnob(L);
    const n = L.part === 'knob' ? 1 : L.joints;
    for (let i = 0; i < n; i++) wanted.push({ name: n > 1 ? `knob ${i + 1}` : 'knob', mesh: i === 0 ? k : k.clone() });
  }
  const laid = arrange(wanted);

  const host = laid.parts.find(q => q.name.startsWith('arm')) || laid.parts[0];
  const src = wanted.find(q => q.name === host.name);
  // The packer is free to turn a part ninety degrees to make it fit, and a
  // callout computed in the part's own frame then points into empty bed. Map
  // through the same rotation it applied.
  const pb = host.mesh.bbox();
  const at = host.rot
    ? (x, y, z) => [-y + pb.center[0], x + pb.center[1], z + pb.min[2] + L.coreT / 2 + L.toothH]
    : (x, y, z) => [x + pb.center[0], y + pb.center[1], z + pb.min[2] + L.coreT / 2 + L.toothH];

  const dims = [];
  if (host.name.startsWith('arm')) {
    const half = L.armLength / 2;
    const zt = L.coreT / 2 + L.toothH;
    // The first arm is the one on show, and it is only twisted if they all are.
    // On a twisted arm the far end is a standing disc rather than a section of
    // bar, so the callouts that measure a section move to the hub still flat.
    const flatEnd = L.armTwist >= L.armCount ? -1 : 1;
    dims.push({ param: 'armLength', from: at(-half, 0, zt), to: at(half, 0, zt), offset: [0, 1, 0] });
    dims.push({ param: 'hubD', label: 'Ø', from: at(-half - L.hubR, 0, 0), to: at(-half + L.hubR, 0, 0), offset: [0, -1, 0] });
    const cx = flatEnd * (half + L.hubR);
    dims.push({ param: 'coreT', from: at(cx, 0, -L.coreT / 2), to: at(cx, 0, L.coreT / 2), offset: [flatEnd, 0, 0] });
    const dx = flatEnd * half;
    dims.push({ label: 'detent', value: `${r2(L.detent)}°`, from: at(dx, 0, L.coreT / 2), to: at(dx, 0, zt), offset: [0, 0, 1] });
  }

  const analysis = [];
  analysis.push(`Joint indexes every ${r2(L.detent)}° — ${L.teeth} teeth ${L.toothH} mm deep on a ${L.hubD} mm hub, clamped by one ${L.bolt.label} bolt.`);
  analysis.push(`Reach ${r2(L.reach)} mm with ${L.armCount} arm${L.armCount > 1 ? 's' : ''} of ${r2(L.armLength)} mm, plus the base and head.`);
  analysis.push(L.patternKey === 'custom'
    ? `Head takes a ${r2(L.pitch)} × ${r2(L.pitch)} mm square bolt pattern, ${L.headHole} mm holes — square, so the display turns 90° between portrait and landscape.`
    : `Head is ${L.patternKey === 'vesa100' ? 'VESA 100' : 'VESA 75'}, which is what the CYD mount's VESA plate produces. The pattern is square, so the display turns 90° between portrait and landscape.`);
  if (L.verticalHubs > 0) {
    const where = [];
    if (L.armTwist) where.push(`${L.armTwist} arm${L.armTwist > 1 ? 's are' : ' is'} twisted`);
    if (L.wrist) where.push(`${L.wrist} wrist adapter${L.wrist > 1 ? 's add' : ' adds'} ${r2(wristSpan(L))} mm`);
    analysis.push(`Two axes: ${where.join(', ')}, standing ${L.verticalHubs} hub${L.verticalHubs > 1 ? 's' : ''} on edge so the chain leaves its plane. Every hub is still the same face, so every part still mates with every other.`);
  } else {
    analysis.push('Every hub lies flat, so the chain folds in one plane — a nod, not a pan. Twist an arm or add a wrist adapter for the second axis.');
  }
  const stack = L.coreT + 2 * L.toothH;
  analysis.push(`Bolt length: about ${Math.ceil(2 * stack + L.nutT + 4)} mm through two hubs and the knob's nut. ${L.joints} joints, so ${L.joints} bolts, nuts and knobs.`);

  return {
    mesh: laid.mesh,
    parts: laid.parts,
    meta: {
      dims, analysis,
      detentDeg: r2(L.detent),
      teeth: L.teeth,
      reach: r2(L.reach),
      armTwist: L.armTwist,
      wrist: L.wrist,
      joints: L.joints,
      // Hubs whose bore runs along Y rather than Z. Zero means the chain is
      // planar, which is the default and not a fault.
      verticalHubs: L.verticalHubs,
      // The standing hub's centre above the mid-plane, and the gap its rim
      // leaves over the body it stands on — which is what the mating hub turns
      // in, and has to be positive for the joint to go together at all.
      hubRise: r2(hubRise(L)),
      hubClear: r2(hubRise(L) - L.hubR - L.coreT / 2),
      wristSpan: r2(wristSpan(L)),
      bolt: L.bolt.label,
      boreDia: L.bolt.bore,
      nutAcrossFlats: L.bolt.af,
      pattern: L.patternKey === 'custom' ? `${r2(L.pitch)} square` : L.patternKey,
      patternPitch: r2(L.pitch),
      // The holes as actually drilled, in plate coordinates. Reported so the
      // pattern can be checked against the geometry rather than the intent.
      headHoles: (L.headHoles || []).map(([y, z]) => [r2(y), r2(z)]),
      partCount: laid.parts.length,
      partNames: laid.parts.map(q => q.name),
      boltLength: Math.ceil(2 * stack + L.nutT + 4),
    },
  };
}

function validate(p) {
  const issues = [];
  const L = plan(p, {});
  if (L.toothH < 0.4) {
    issues.push({ param: 'toothH', severity: 'warn', message: `A ${L.toothH} mm tooth is two layers at 0.2 mm. It will index, but it will also shear the first time the arm is leaned on.` });
  }
  if (L.detent > 30) {
    issues.push({ param: 'teeth', severity: 'warn', message: `${L.teeth} teeth means the arm only stops every ${r2(L.detent)}°, which is a coarse thing to aim a screen with. 24 teeth gives 15°.` });
  }
  if (L.hubR - L.rFlat < 4) {
    issues.push({ param: 'hubD', severity: 'error', message: `A ${L.hubD} mm hub leaves only ${r2(L.hubR - L.rFlat)} mm of toothed ring outside the ${L.bolt.label} bolt head. Use a bigger hub or a smaller bolt.` });
  }
  if (L.armW > L.hubD) {
    issues.push({ param: 'armW', severity: 'warn', message: 'The arm is wider than its own hubs, so the hubs are swallowed by the bar and the teeth lose their outer edge. Keep it under the hub diameter.' });
  }
  if (L.reach > 260) {
    issues.push({ param: 'armLength', severity: 'warn', message: `${r2(L.reach)} mm of reach on a printed serrated joint is a lot of leverage. Expect it to sag under a display unless the bolts are properly tight.` });
  }
  const hh = plateHoles(L, L.plateW, L.plateH, L.headHole, L.pitch);
  if (!hh.length) {
    issues.push({ param: 'plateW', severity: 'error', message: `A ${r2(L.plateW)} x ${r2(L.plateH)} mm plate cannot carry a ${r2(L.pitch)} mm pattern at its true pitch with the fin underneath it, so no holes were drilled. It needs at least ${r2(minPlateFor(L, L.pitch, L.headHole).w)} x ${r2(minPlateFor(L, L.pitch, L.headHole).h)} mm.` });
  }
  if (num(p.armTwist, 0) > L.armCount) {
    issues.push({ param: 'armTwist', severity: 'warn', message: `There are only ${L.armCount} arm${L.armCount > 1 ? 's' : ''}, so only ${L.armCount} can be twisted — the rest of the request was dropped. Raise the arm count, or add a wrist adapter instead, which turns the plane without spending an arm.` });
  }
  if (L.verticalHubs > 0 && webThick(L, L.armW) < 3) {
    issues.push({ param: 'coreT', severity: 'warn', message: `A ${r2(L.coreT)} mm core leaves a ${r2(webThick(L, L.armW))} mm web under the standing hub, and that web is the only thing holding it up. It is the thinnest part of the chain — take the core to 5 mm or more before twisting anything.` });
  }
  if (L.verticalHubs > 0 && L.reach > 180) {
    issues.push({ param: 'armTwist', severity: 'warn', message: `${r2(L.reach)} mm of reach through a standing hub loads its web in TWIST, which is the one direction the teeth do not help with. It will hold a screen; it will wobble under a hand.` });
  }
  if (L.nutT + 2.5 > L.knobT) {
    issues.push({ param: 'nutT', severity: 'warn', message: 'The nut trap leaves under 2.5 mm of knob above it; there is not much left to grip the nut.' });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const L = plan(p, ctx);
  const notes = [];
  notes.push('Every part prints flat as arranged, teeth upward, with no supports.');
  notes.push(`The DOWNWARD teeth print against the bed and come out slightly flattened — that is unavoidable printing them this way up, and the clamp takes it up on the first tighten. If a joint feels notchy rather than positive, run a knife round the first layer of the underside teeth.`);
  notes.push(`Hardware per joint: one ${L.bolt.label} bolt about ${Math.ceil(2 * (L.coreT + 2 * L.toothH) + L.nutT + 4)} mm long, and one ${L.bolt.label} nut, which drops into the knob's trap from underneath. ${fitNote('slide')}`);
  notes.push(`Assemble a joint half a tooth out of alignment: two identical serrated faces mesh when one is turned by half a pitch (${r2(L.detent / 2)}°), not when their ridges line up.`);
  if (L.verticalHubs > 0) {
    notes.push(`The standing hub prints on edge, which means BOTH its faces come out the same — and better than the flat hubs, whose underside teeth are squashed against the bed. If one joint in the chain feels crisper than the others, that is the reason, not a fault.`);
    notes.push(`Under that hub is a ring about ${r2(webInset(L))} mm wide with nothing beneath it, where the disc oversails its web. It is narrow enough to bridge and it is not a load path, so leave supports off — turning them on to fix it costs more than it buys.`);
    notes.push('The standing hub cannot swing all the way round: below about horizontal the arm on it runs into the web and the plate. Plan the fold with the elbow going up.');
  }
  notes.push('Four walls and 40% infill. The teeth are the part under load and they are all perimeter, so walls matter far more than infill here.');
  notes.push('Portrait or landscape is a re-bolt, not a mechanism: the head pattern is square, so take the four screws out, turn the display a quarter turn and put them back.');
  return { profile: { layerH, infill: 40, walls: 4 }, supports: false, filament: 'PETG', notes };
}

// ---------------------------------------------------------------------------

export default {
  id: 'arm',
  name: 'Articulated Arm',
  category: 'Utility',
  blurb: 'A serrated-joint arm that locks where you put it, for a display, a camera or a lamp.',
  description:
    'An arm made of toothed joints rather than friction ones, so it holds its pose instead of slowly drooping. Every hub carries ' +
    'the same serrated face on both sides, which means any part mates with any other, and the joint indexes in fixed steps you ' +
    'choose. One bolt and a knurled knob with a captive nut clamp each joint. Left alone the chain folds in a single plane, which ' +
    'is what aiming something up or down actually needs; for a second axis, stand a hub on edge — either as the far hub of an arm, ' +
    'or as a short wrist adapter that drops in anywhere. The head takes a square VESA or custom bolt pattern, so a display turns ' +
    'between portrait and landscape by unbolting it and putting it back a quarter turn round. Pairs with the CYD Display Mount\'s ' +
    'VESA plate. Everything prints flat with no supports.',
  version: 1,
  params: [
    { key: 'teeth', label: 'Teeth', type: 'int', def: 24, min: 8, max: 60, step: 1, group: 'Joint',
      help: 'How many detents in a full turn. 24 gives a 15° step, which is fine enough to aim a screen and coarse enough to hold.' },
    { key: 'toothH', label: 'Tooth depth', type: 'number', def: 1.2, min: 0.3, max: 4, step: 0.1, unit: 'mm', group: 'Joint',
      help: 'How far the teeth stand proud. Deeper holds more and needs the bolt slackened further to move.' },
    { key: 'hubD', label: 'Hub diameter', type: 'number', def: 30, min: 14, max: 70, step: 1, unit: 'mm', group: 'Joint',
      help: 'Across the toothed disc. A bigger hub has more teeth in contact and takes more torque.' },
    { key: 'coreT', label: 'Hub thickness', type: 'number', def: 6, min: 2.5, max: 14, step: 0.5, unit: 'mm', group: 'Joint',
      help: 'The solid core under the teeth. This is what stops the hub folding when the bolt is tightened.' },
    { key: 'bolt', label: 'Bolt', type: 'enum', def: 'm5', group: 'Joint',
      options: [
        { v: 'm4', label: 'M4', help: 'Light duty.' },
        { v: 'm5', label: 'M5', help: 'The sensible default for a display.' },
        { v: 'm6', label: 'M6', help: 'Heavy, for a long arm.' },
      ],
      help: 'Sets the bore through every hub and the nut trapped in the knob.' },

    { key: 'armLength', label: 'Arm length', type: 'number', def: 90, min: 30, max: 200, step: 1, unit: 'mm', group: 'Arm',
      help: 'Hub centre to hub centre. This is the number that decides reach — and how much leverage the joints have to hold.' },
    { key: 'armW', label: 'Arm width', type: 'number', def: 16, min: 6, max: 60, step: 1, unit: 'mm', group: 'Arm',
      help: 'Across the bar between the hubs. Keep it under the hub diameter.' },
    { key: 'armCount', label: 'Arm segments', type: 'int', def: 2, min: 1, max: 3, step: 1, group: 'Arm',
      help: 'How many identical arms to lay out. Two gives an elbow; three is a long reach that will want a heavier bolt.' },

    { key: 'armTwist', label: 'Twisted arms', type: 'int', def: 0, min: 0, max: 3, step: 1, group: 'Twist',
      help: 'How many arms get their far hub stood on edge, so the chain leaves its plane. One is enough — one twist anywhere buys you both axes. Counted from the head end.' },
    { key: 'wrist', label: 'Wrist adapters', type: 'int', def: 0, min: 0, max: 2, step: 1, group: 'Twist',
      help: 'The same quarter turn as a short standalone part: one flat hub, one standing hub. Costs a joint and a knob instead of an arm\'s length, and drops in anywhere in the chain.' },

    { key: 'pattern', label: 'Display pattern', type: 'enum', def: 'vesa75', group: 'Head',
      options: [
        { v: 'vesa75', label: 'VESA 75 × 75', help: 'Matches the CYD mount\'s VESA plate.' },
        { v: 'vesa100', label: 'VESA 100 × 100' },
        { v: 'custom', label: 'Custom square' },
      ],
      help: 'The bolt pattern on the head. All three are square, which is what lets the display turn 90°.' },
    { key: 'patternPitch', label: 'Custom pitch', type: 'number', def: 50, min: 15, max: 140, step: 1, unit: 'mm', group: 'Head',
      showIf: (p) => p.pattern === 'custom', help: 'Centre to centre, both ways.' },
    { key: 'headHole', label: 'Head hole', type: 'number', def: 4.5, min: 2.5, max: 8, step: 0.5, unit: 'mm', group: 'Head',
      help: '4.5 mm clears an M4, which is what VESA uses.' },
    { key: 'plateW', label: 'Head plate width', type: 'number', def: 90, min: 30, max: 220, step: 1, unit: 'mm', group: 'Head' },
    { key: 'plateH', label: 'Head plate height', type: 'number', def: 90, min: 30, max: 220, step: 1, unit: 'mm', group: 'Head' },
    { key: 'plateT', label: 'Head plate thickness', type: 'number', def: 4, min: 2, max: 10, step: 0.5, unit: 'mm', group: 'Head' },

    { key: 'baseW', label: 'Base width', type: 'number', def: 70, min: 30, max: 200, step: 1, unit: 'mm', group: 'Base',
      help: 'The foot that meets the desk or the wall.' },
    { key: 'baseD', label: 'Base depth', type: 'number', def: 60, min: 30, max: 200, step: 1, unit: 'mm', group: 'Base',
      help: 'Front to back. This is what stops it tipping.' },
    { key: 'baseT', label: 'Base thickness', type: 'number', def: 5, min: 2, max: 12, step: 0.5, unit: 'mm', group: 'Base' },
    { key: 'baseHole', label: 'Base fixing hole', type: 'number', def: 4.5, min: 2.5, max: 8, step: 0.5, unit: 'mm', group: 'Base',
      help: 'Four of them, for screwing the base down.' },

    { key: 'knobD', label: 'Knob diameter', type: 'number', def: 26, min: 12, max: 60, step: 1, unit: 'mm', group: 'Knob',
      help: 'Bigger turns easier and clamps harder.' },
    { key: 'knobT', label: 'Knob thickness', type: 'number', def: 9, min: 5, max: 25, step: 0.5, unit: 'mm', group: 'Knob' },
    { key: 'flutes', label: 'Flutes', type: 'int', def: 9, min: 4, max: 20, step: 1, group: 'Knob',
      help: 'Scallops round the rim for grip.' },
    { key: 'nutT', label: 'Nut trap depth', type: 'number', def: 4, min: 1.6, max: 12, step: 0.2, unit: 'mm', group: 'Knob',
      help: 'How deep the hexagonal pocket is. A standard nut is about 0.8 × its thread diameter thick.' },
    { key: 'fit', label: 'Clearance', type: 'number', def: FIT.slide, min: 0.05, max: 0.8, step: 0.05, unit: 'mm', group: 'Knob',
      help: `Slack on the nut pocket. ${fitNote('slide')}` },

    { key: 'part', label: 'Show', type: 'enum', def: 'all', group: 'Output',
      options: [
        { v: 'all', label: 'The whole set' },
        { v: 'base', label: 'Base only' },
        { v: 'arm', label: 'Arms only' },
        { v: 'wrist', label: 'Wrist only', help: 'One wrist adapter even if the count is zero — the cheap thing to test-print before committing to a set.' },
        { v: 'head', label: 'Head only' },
        { v: 'knob', label: 'Knobs only' },
      ],
      help: 'Everything is laid out flat, ready to slice as one plate.' },
  ],
  presets: [
    { name: 'CYD desk arm', values: {
      teeth: 24, toothH: 1.2, hubD: 30, coreT: 6, bolt: 'm5',
      armLength: 90, armW: 16, armCount: 2,
      pattern: 'vesa75', headHole: 4.5, plateW: 90, plateH: 90, plateT: 4,
      baseW: 70, baseD: 60, baseT: 5, knobD: 26, knobT: 9, flutes: 9, nutT: 4, part: 'all' } },
    // The CYD arm with a wrist in it, and everything trimmed until the whole set
    // still lands on one 180 mm plate: the plates are at the smallest that can
    // carry VESA 75 at its true pitch, and the arms give up 10 mm each. A wrist
    // is a ninth part and a fourth knob, and they have to come from somewhere.
    { name: 'Pan and tilt', values: {
      teeth: 24, toothH: 1.2, hubD: 30, coreT: 6, bolt: 'm5',
      armLength: 80, armW: 16, armCount: 2, wrist: 1,
      pattern: 'vesa75', headHole: 4.5, plateW: 85, plateH: 91, plateT: 4,
      baseW: 65, baseD: 60, baseT: 5, knobD: 24, knobT: 9, flutes: 9, nutT: 4, part: 'all' } },
    { name: 'Short and stiff', values: {
      teeth: 36, toothH: 1.0, hubD: 36, coreT: 8, bolt: 'm6',
      armLength: 55, armW: 20, armCount: 1,
      pattern: 'vesa75', headHole: 4.5, plateW: 95, plateH: 95, plateT: 5,
      baseW: 90, baseD: 90, baseT: 6, knobD: 32, knobT: 11, flutes: 12, nutT: 5.5, part: 'all' } },
    { name: 'Long reach, VESA 100', values: {
      teeth: 24, toothH: 1.6, hubD: 38, coreT: 9, bolt: 'm6',
      armLength: 120, armW: 22, armCount: 1,
      pattern: 'vesa100', headHole: 4.5, plateW: 112, plateH: 112, plateT: 5,
      baseW: 90, baseD: 80, baseT: 7, knobD: 32, knobT: 12, flutes: 14, nutT: 5.5, part: 'all' } },
    { name: 'Single arm, small pattern', values: {
      teeth: 18, toothH: 1.0, hubD: 24, coreT: 5, bolt: 'm4',
      armLength: 70, armW: 12, armCount: 1,
      pattern: 'custom', patternPitch: 40, headHole: 3.4, plateW: 60, plateH: 60, plateT: 3,
      baseW: 55, baseD: 50, baseT: 4, knobD: 20, knobT: 7, flutes: 7, nutT: 3.2, part: 'all' } },
  ],
  build,
  validate,
  hints,
};
