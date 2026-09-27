// gen lampshade — the shared contract, plus the checks only this object needs.
//
// conformance() proves it is *a* solid. Everything below proves it is *the*
// solid: that the bore is the diameter it claims, that you can see straight
// through it, that the flange is wide enough for a real shade ring to grip, and
// that a scarfed joint really does come out one wall thick.
//
// The measuring instrument is a ray caster written here rather than imported
// from the kernel, because the kernel's rayMeshCount returns a count and these
// checks need distances — and because a test that measures with the same code
// the generator built with is one observer, not two.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, BED } from './lib/genconform.mjs';
import { topology, isSolid } from './lib/meshcheck.mjs';
import gen, {
  settings, geometry, sectionFn, sectionMin, profileF, leanScan, chooseOrient,
  lampClearance, lampRadiusAt, minStaves, splitPlateCount, LAMPS, T_MIN,
} from '../js/gen/lampshade.js';

suite('gen lampshade');

const c = ctx('normal');
const BASE = defaults(gen);
const build = (over = {}) => gen.build({ ...BASE, ...over }, c);
const set = (over = {}) => settings({ ...BASE, ...over }, c);

conformance(gen, 'lampshade');

// ---------------------------------------------------------------------------
// The instrument: Möller–Trumbore, every triangle, sorted hits with the sign of
// the face. Slow and obvious on purpose — a clever one would need its own test.
// ---------------------------------------------------------------------------

function rayHits(mesh, o, d) {
  const p = mesh.positions, T = mesh.tris, hits = [];
  const L = Math.hypot(d[0], d[1], d[2]);
  const dir = [d[0] / L, d[1] / L, d[2] / L];
  for (let t = 0; t < mesh.triCount; t++) {
    const ia = T[t * 3] * 3, ib = T[t * 3 + 1] * 3, ic = T[t * 3 + 2] * 3;
    const e1 = [p[ib] - p[ia], p[ib + 1] - p[ia + 1], p[ib + 2] - p[ia + 2]];
    const e2 = [p[ic] - p[ia], p[ic + 1] - p[ia + 1], p[ic + 2] - p[ia + 2]];
    const pv = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv = [o[0] - p[ia], o[1] - p[ia + 1], o[2] - p[ia + 2]];
    const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
    if (tt > 1e-7) hits.push({ t: tt, enter: det > 0 });
  }
  hits.sort((a, b) => a.t - b.t);
  // Grazed edges land twice at the same distance; keep one.
  const out = [];
  for (const h of hits) if (!out.length || h.t - out[out.length - 1].t > 1e-6) out.push(h);
  return out;
}

/** Total length of solid along the ray: every enter → exit pair, summed. */
function material(mesh, o, d) {
  const hits = rayHits(mesh, o, d);
  let depth = 0, sum = 0, from = 0;
  for (const h of hits) {
    if (h.enter) { if (depth === 0) from = h.t; depth++; }
    else { depth--; if (depth === 0) sum += h.t - from; }
  }
  return sum;
}

function radial(mesh, a, z) { return { o: [0, 0, z], d: [Math.cos(a), Math.sin(a), 0] }; }

function maxRadius(mesh, zLo = -Infinity, zHi = Infinity) {
  const p = mesh.positions;
  let r = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 2] < zLo || p[i + 2] > zHi) continue;
    r = Math.max(r, Math.hypot(p[i], p[i + 1]));
  }
  return r;
}

function minRadius(mesh) {
  const p = mesh.positions;
  let r = Infinity;
  for (let i = 0; i < p.length; i += 3) r = Math.min(r, Math.hypot(p[i], p[i + 1]));
  return r;
}

// ---------------------------------------------------------------------------
// Cross-sections: the maximum has to be exactly 1, because `dia` is defined as
// the crest-to-crest diameter and a section whose peak is 0.997 would make
// every diameter in the drawing a lie by half a millimetre.
// ---------------------------------------------------------------------------

console.log('\n-- cross-sections --');
for (const kind of ['circle', 'lobed', 'fluted', 'polygon', 'star', 'squircle']) {
  const s = set({ section: kind, sides: 12, depth: 30 });
  const u = sectionFn(s);
  let mx = -Infinity, mn = Infinity;
  for (let i = 0; i < 4096; i++) { const v = u(Math.PI * 2 * i / 4096); mx = Math.max(mx, v); mn = Math.min(mn, v); }
  check(`${kind}: the crest is exactly 1`, Math.abs(mx - 1) < 1e-9, `max ${mx.toFixed(12)}`);
  check(`${kind}: never reaches the axis`, mn > 0.05, `min ${mn.toFixed(4)}`);
}
{
  const u = sectionFn(set({ section: 'polygon', sides: 6 }));
  near('hexagon: a vertex is at radius 1', u(0), 1, 1e-12);
  near('hexagon: a face centre is at the inradius cos(30°)', u(Math.PI / 6), Math.cos(Math.PI / 6), 1e-12);
  const u8 = sectionFn(set({ section: 'polygon', sides: 8 }));
  near('octagon: a face centre is at cos(22.5°)', u8(Math.PI / 8), Math.cos(Math.PI / 8), 1e-12);
}
{
  const u = sectionFn(set({ section: 'star', sides: 5, depth: 40 }));
  near('star: a point is at radius 1', u(0), 1, 1e-12);
  near('star: a valley is at 1 − relief', u(Math.PI / 5), 0.6, 1e-9);
  near('star: halfway along the edge is on the straight line', u(Math.PI / 10),
    (0.6 * Math.sin(Math.PI / 5)) / (Math.sin(Math.PI / 10) + 0.6 * Math.sin(Math.PI / 10)), 1e-9);
}
near('sectionMin reports the lobed valley', sectionMin(set({ section: 'lobed', sides: 8, depth: 35 })), 0.65, 1e-6);
near('sectionMin is 1 for a circle', sectionMin(set({ section: 'circle' })), 1, 1e-12);

// ---------------------------------------------------------------------------
// Profiles. The bounded slope is a printing promise, not a curve-fitting
// preference: an unbounded one puts a horizontal ceiling on the lip.
// ---------------------------------------------------------------------------

console.log('\n-- profiles --');
for (const kind of ['straight', 'bell', 'ogee', 'dome', 'tulip']) {
  near(`${kind}: f(0) = 0`, profileF(kind, 0), 0, 1e-12);
  near(`${kind}: f(1) = 1`, profileF(kind, 1), 1, 1e-12);
  let mono = true, maxSlope = 0, prev = 0;
  const N = 4000;
  for (let i = 1; i <= N; i++) {
    const v = profileF(kind, i / N);
    if (v < prev - 1e-12) mono = false;
    maxSlope = Math.max(maxSlope, (v - prev) * N);
    prev = v;
  }
  check(`${kind}: monotone from mouth to top`, mono);
  check(`${kind}: slope stays bounded (an infinite one is a ceiling at the lip)`,
    maxSlope < 2.25, `max df/dt ${maxSlope.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// The shade, measured off the mesh.
// ---------------------------------------------------------------------------

console.log('\n-- the shade itself --');
{
  const m = build().mesh;
  nearPct('a 170 mm shade measures 170 mm across the mouth', 2 * maxRadius(m), 170, 0.2);
  near('and it is exactly as tall as it says', m.bbox().size[2], 150, 1e-6);

  // Open at both ends. A ray straight up the axis from below the bed must miss
  // the whole object: no floor, no web, no spider, nothing across the mouth.
  check('you can see straight down the axis — no floor and no web',
    rayHits(m, [0, 0, -40], [0, 0, 1]).length === 0,
    `${rayHits(m, [0, 0, -40], [0, 0, 1]).length} triangles in the way`);

  // And a horizontal ray through the middle passes through exactly one wall.
  const mid = material(m, [0, 0, 75], [1, 0, 0]);
  nearPct('one wall thick where a ray crosses it', mid, set().wall, 12);

  check('a shade with a fitting prints fitter down', build().meta.orient === 'fitter down');
}
{
  // The top opening, measured without asking the generator where it is: with no
  // fitter the wall runs the whole height, so the far end IS the top opening.
  const m = build({ fitter: 'none', topDia: 70, dia: 150, height: 120 }).mesh;
  const b = m.bbox();
  // orient auto puts the mouth on the bed here, so the narrow end is on top.
  const lo = maxRadius(m, b.min[2], b.min[2] + 0.01);
  const hi = maxRadius(m, b.max[2] - 0.01, b.max[2]);
  const top = Math.min(lo, hi), bot = Math.max(lo, hi);
  nearPct('a bare shell measures its top opening exactly', 2 * top, 70, 0.2);
  nearPct('and its mouth exactly', 2 * bot, 150, 0.2);
  // The innermost material is the inside of the wall at the narrow end: one
  // wall in from the top opening, and nothing closer to the axis than that.
  const rIn = minRadius(m), wall = set().wall;
  check('the closest material to the axis is one wall inside the top opening',
    rIn > 35 - 2 * wall && rIn < 35, `${rIn.toFixed(2)} mm against ${(35 - wall).toFixed(2)} expected`);
}
{
  const m = build({ ribs: 10, ribDepth: 1.6, section: 'circle' }).mesh;
  const g = geometry(set({ ribs: 10, ribDepth: 1.6 }));
  // The trough of ring 3 is at t = 2.5/10, and the mesh is built fitter-down.
  const t = 2.5 / 10, zShade = g.zTop * t;
  const zMesh = 150 - zShade;
  const crestZ = 150 - g.zTop * (2 / 10);
  const rTrough = maxRadius(m, zMesh - 0.2, zMesh + 0.2);
  const rCrest = maxRadius(m, crestZ - 0.2, crestZ + 0.2);
  // A ring cuts inward, and the profile also tapers between the two heights, so
  // compare against the taper rather than against the crest alone.
  const taper = (g.hWall ? 0 : 0) + Math.abs(
    (g.maxR - 45) * (g.zTop * (2.5 / 10) - g.zTop * (2 / 10)) / g.zTop);
  nearPct('a 1.6 mm ring really cuts 1.6 mm in', rCrest - rTrough - taper, 1.6, 12);
}

// The shoulder is steeper than the wall, so it needs a thicker horizontal
// section to carry the same perpendicular wall. Getting that wrong left a
// 0.80 mm band at the top of a 1.2 mm shade.
//
// A note for whoever reads the analysis panel next: its "thinnest wall" figure
// under-reports at every crease in this codebase — vase shows 0.34 mm on a 2 mm
// wall and drawer 0.40 on 1.6 — so it is not the instrument for this question.
{
  const s = set();
  const g = geometry(s);
  const m = build().mesh;
  // Mid-shoulder, in the placed mesh, which is built fitter down and so mirrors z.
  const zShade = (g.zTop + g.zF) / 2;
  const got = material(m, [0, 0, s.height - zShade], [Math.cos(0.4), Math.sin(0.4), 0]);
  nearPct('the shoulder carries a full perpendicular wall, not a thinned one',
    got / g.kSh, s.wall, 12);
  check('and the shoulder really is steeper than the wall it meets',
    g.kSh > 1.2, `its horizontal section is ${g.kSh.toFixed(2)}× the perpendicular wall`);
}

// ---------------------------------------------------------------------------
// The fitting. This is the whole reason the generator exists, so it gets
// measured rather than trusted.
// ---------------------------------------------------------------------------

console.log('\n-- the E27 fitting --');
for (const fitter of ['ring', 'collar', 'thread']) {
  const over = { fitter, bore: 41 };
  const m = build(over).mesh;
  const rMin = minRadius(m);
  nearPct(`${fitter}: the bore really is 41 mm`, 2 * rMin, 41, 0.6);
}
{
  // The flange: cast a ray outward through the middle of its thickness. It has
  // to enter at the bore and leave at the outside of the annulus, and what is
  // between them is what a 54 mm shade ring has to clamp.
  const s = set();
  const m = build().mesh;          // fitter down: the flange sits on the bed
  const hits = rayHits(m, [0, 0, s.fitterT / 2], [1, 0, 0]);
  check('the flange is a clean annulus: in at the bore, out at the rim',
    hits.length === 2, `${hits.length} crossings`);
  if (hits.length === 2) {
    nearPct('and it starts at the bore radius', hits[0].t, 41 / 2, 0.6);
    nearPct('and the flat annulus is the 9 mm asked for', hits[1].t - hits[0].t, 9, 2);
    const shadeRingOverlap = hits[1].t - 54 / 2;
    check('a 54 mm shade ring overlaps it all the way round',
      shadeRingOverlap > 0, `${shadeRingOverlap.toFixed(1)} mm of grip outside the 54 mm ring`);
  }
  near('flange thickness is what was asked for', m.bbox().min[2] + s.fitterT, s.fitterT, 1e-9);
}
{
  // A thread is a helix or it is a groove. Two rays at the same height and
  // different angles must find the bore at different radii; a plain bore would
  // give the same answer everywhere.
  const s = set({ fitter: 'thread', pitch: 2.5 });
  const g = geometry(s);
  const zShade = g.zF + (g.boreTop - g.zF) * 0.5;
  const zMesh = s.height - zShade;
  const r = [];
  for (let k = 0; k < 8; k++) {
    const a = Math.PI * 2 * k / 8;
    const h = rayHits(build({ fitter: 'thread' }).mesh, [0, 0, zMesh], [Math.cos(a), Math.sin(a), 0]);
    if (h.length) r.push(h[0].t);
  }
  const spread = Math.max(...r) - Math.min(...r);
  check('the threaded bore is a helix, not a plain hole',
    spread > 0.35 * 2.5 * 0.5, `bore radius varies by ${spread.toFixed(2)} mm round one turn`);
  check('and the thread never eats more than its own depth',
    spread < 0.35 * 2.5 + 0.05, `${spread.toFixed(2)} mm against a ${(0.35 * 2.5).toFixed(2)} mm profile`);
  nearPct('the thread\'s major diameter is still the bore', 2 * Math.min(...r), 41, 1);
}
{
  const m = build({ fitter: 'none' }).mesh;
  check('with no fitting there is no flange, no collar and no bore',
    minRadius(m) > 41, `closest material ${minRadius(m).toFixed(1)} mm from the axis`);
}

// ---------------------------------------------------------------------------
// Print orientation: measured both ways up, not assumed.
// ---------------------------------------------------------------------------

console.log('\n-- which way up --');
{
  const s = set();
  const scan = leanScan(geometry(s));
  const ch = chooseOrient(s, geometry(s));
  check('auto takes the shallower of the two orientations',
    (ch.flip ? scan.down : scan.up) <= (ch.flip ? scan.up : scan.down),
    `fitter up ${scan.up.toFixed(0)}°, fitter down ${scan.down.toFixed(0)}°`);
  check('the fitted shade comes out fitter down', ch.flip);

  // A bare shell that narrows upward is the other case: nothing overhangs if
  // the mouth is on the bed, so auto must NOT flip it.
  const s2 = set({ fitter: 'none', topDia: 50, dia: 160 });
  const ch2 = chooseOrient(s2, geometry(s2));
  check('a bare shell that narrows upward prints mouth down', !ch2.flip);
  check('the two cases really do choose differently', ch.flip !== ch2.flip);

  check('asking for a fixed orientation overrides the measurement',
    chooseOrient(set({ orient: 'up' }), geometry(set({ orient: 'up' }))).flip === false
    && chooseOrient(set({ orient: 'down' }), geometry(set({ orient: 'down' }))).flip === true);

  // The collar fitter used to have a 90° shelf under the flange, unprintable
  // whichever way up it went. The chamfer is what fixed it.
  for (const fitter of ['ring', 'collar', 'thread']) {
    const sc = leanScan(geometry(set({ fitter })));
    check(`${fitter}: the better orientation is under the 55° limit`,
      Math.min(sc.up, sc.down) <= 55, `up ${sc.up.toFixed(0)}°, down ${sc.down.toFixed(0)}°`);
  }
}

// ---------------------------------------------------------------------------
// Split into staves.
// ---------------------------------------------------------------------------

console.log('\n-- staves --');
{
  const over = { dia: 300, topDia: 96, height: 150, staves: 8, wall: 1.6, lap: 8, gap: 0.15, arrange: 'plate' };
  const r = build(over);
  const s = set(over);
  check('eight staves plus one fitter ring', r.parts.length === 9, `${r.parts.length} parts`);
  let allSolid = true, allFit = true, worst = '';
  for (const part of r.parts) {
    const t = topology(part.mesh);
    if (t.boundary || t.nonManifold || t.inconsistent || !(part.mesh.volume() > 0)) { allSolid = false; worst = part.name; }
    const sz = part.mesh.bbox().size;
    if (sz[0] > BED.x || sz[1] > BED.y || sz[2] > BED.z) { allFit = false; worst = worst || `${part.name} ${sz.map(v => v.toFixed(0)).join('×')}`; }
  }
  check('every stave and the ring is a watertight solid on its own', allSolid, worst);
  check('and every one of them fits the bed on its own', allFit, worst);
  check('the plate layout says how many bed-loads it really is',
    r.meta.plate && r.meta.plate.plates >= 1, JSON.stringify(r.meta.plate && r.meta.plate.plates));
  near('splitPlateCount agrees with the layout', splitPlateCount(s), r.meta.plate.plates, 0);
}
{
  // The scarf, which is the claim worth testing: glued up, a lap has to be the
  // same thickness as the wall either side of it, or the joint reads as a
  // bright line the length of the shade once the lamp is on.
  const over = { dia: 300, topDia: 96, height: 150, staves: 8, wall: 1.6, lap: 10, gap: 0.15, arrange: 'assembled' };
  const m = build(over).mesh;
  const s = set(over);
  const g = geometry(s, { wallOnly: true });
  const step = Math.PI * 2 / 8, lapA = Math.min(s.lap, step * 0.6);
  const z = g.zTop * 0.45;

  const midA = (lapA + step) / 2;                 // well inside stave 1
  const lapMid = step + lapA / 2;                 // the overlap of staves 1 and 2
  const mMid = material(m, ...Object.values(radial(m, midA, z)));
  const mLap = material(m, ...Object.values(radial(m, lapMid, z)));
  check('a ray through the middle of a stave finds one wall',
    rayHits(m, [0, 0, z], [Math.cos(midA), Math.sin(midA), 0]).filter(h => h.enter).length === 1);
  check('a ray through a lap finds two, one from each stave',
    rayHits(m, [0, 0, z], [Math.cos(lapMid), Math.sin(lapMid), 0]).filter(h => h.enter).length === 2);
  nearPct('and the two together are the same thickness as the one', mLap, mMid, 15);
  check('the lap is thinner by exactly the glue gap, not by luck',
    Math.abs((mMid - mLap) - s.gap) < 0.2, `wall ${mMid.toFixed(2)} mm, lap ${mLap.toFixed(2)} mm, gap ${s.gap} mm`);

  // Every angle is covered by some stave: no gap in the shade.
  let covered = true, holeAt = 0;
  for (let k = 0; k < 360; k++) {
    const a = Math.PI * 2 * k / 360;
    if (material(m, [0, 0, z], [Math.cos(a), Math.sin(a), 0]) < T_MIN * 0.8) { covered = false; holeAt = k; break; }
  }
  check('the staves cover a whole turn with no gap in the wall', covered, covered ? '360 angles' : `hole at ${holeAt}°`);

  // Two overlapping closed solids are each perfectly manifold, so isSolid()
  // cannot see an interpenetration and saying it can would be the kind of
  // agreeable test this project has paid for five times. What proves it is the
  // order of the crossings: in a lap the ray must leave one stave BEFORE it
  // enters the next, with the glue gap in between. Remove the scarf and this
  // goes red; isSolid alone does not.
  const lapHits = rayHits(m, [0, 0, z], [Math.cos(lapMid), Math.sin(lapMid), 0]);
  const pattern = lapHits.map(h => (h.enter ? 'in' : 'out')).join(' ');
  check('the two staves in a lap are separate solids, not interpenetrating ones',
    pattern === 'in out in out', pattern || 'no crossings');
  if (pattern === 'in out in out') {
    near('and the space between them is the glue gap asked for',
      lapHits[2].t - lapHits[1].t, s.gap, 0.08);
  }
  isSolid('every part of the assembly is closed and consistently wound', m);
}
{
  const s = set({ dia: 320, staves: 6, lap: 8 });
  const k = minStaves(s);
  check('minStaves finds the fewest that will lie on the bed', k >= 2 && k <= 16, `${k}`);
  const chord = s.dia * Math.sin(Math.PI / k + s.lap / 2);
  check('and that many really does fit across the bed', chord <= BED.x - 8, `${chord.toFixed(0)} mm chord`);
  const oneFewer = s.dia * Math.sin(Math.PI / (k - 1) + s.lap / 2);
  check('while one fewer does not', k <= 2 || oneFewer > BED.x - 8, `${oneFewer.toFixed(0)} mm chord`);
}

// ---------------------------------------------------------------------------
// The lamp, and what it means for the filament.
// ---------------------------------------------------------------------------

console.log('\n-- the lamp --');
{
  const a60 = LAMPS.a60;
  near('the envelope starts at the E27 cap radius', lampRadiusAt(a60, 0), 13.5, 1e-9);
  near('and reaches full diameter in the middle', lampRadiusAt(a60, a60.len * 0.6), 30, 1e-9);
  check('and closes again at the tip', lampRadiusAt(a60, a60.len) < 13.5);
  let mono = true;
  for (let i = 1; i <= 100; i++) {
    if (lampRadiusAt(a60, a60.len * i / 100) > 30 + 1e-9) mono = false;
  }
  check('and never exceeds the stated diameter', mono);

  const g = geometry(set());
  const wide = lampClearance(set({ lamp: 'g45' }), g);
  const fat = lampClearance(set({ lamp: 'g125' }), g);
  check('a golf ball rattles around in the default shade', wide.clear > 20, `${wide.clear.toFixed(0)} mm`);
  check('a 125 mm globe does not go in at all', fat.hit < 1, `${fat.hit.toFixed(0)} mm at the tightest point`);
  check('and the clearance is measured at the glass, not at the cap',
    lampClearance(set(), g).clear > 20, `${lampClearance(set(), g).clear.toFixed(0)} mm for an A60`);
  check('a deeply lobed shade is measured in its valleys',
    lampClearance(set({ section: 'lobed', sides: 8, depth: 40 }), geometry(set({ section: 'lobed', sides: 8, depth: 40 }))).clear
      < lampClearance(set(), g).clear);
}

// ---------------------------------------------------------------------------
// validate: each rule driven, and none of them firing on the defaults.
// ---------------------------------------------------------------------------

console.log('\n-- validate --');
const fires = (over, param, sev) => gen.validate({ ...BASE, ...over }, c)
  .some(v => v.param === param && (!sev || v.severity === sev));
const anyError = (over) => gen.validate({ ...BASE, ...over }, c).some(v => v.severity === 'error');

check('the defaults raise nothing at all', gen.validate(BASE, c).length === 0,
  gen.validate(BASE, c).map(v => `${v.severity}:${v.param}`).join(' '));
check('a flange too narrow for a shade ring is an error', fires({ flange: 4 }, 'flange', 'error'));
check('a bore that will not pass an E27 holder is flagged', fires({ bore: 18 }, 'bore'));
check('a thread pitch that is not the European 2.5 mm is flagged', fires({ fitter: 'thread', pitch: 4 }, 'pitch'));
check('a nearly flat shoulder is an overhang error', fires({ shoulder: 82 }, 'shoulder', 'error'));
check('spiral mode with a fitting is an error, with the reason', fires({ mode: 'spiral' }, 'mode', 'error'));
check('a lamp that does not fit is an error', fires({ lamp: 'g125' }, 'lamp', 'error'));
check('a lamp that is merely close is a warning about PLA', fires({ dia: 130, topDia: 80, lamp: 'g80' }, 'lamp', 'warn'));
check('a shade too wide for the bed says how many staves it needs',
  gen.validate({ ...BASE, dia: 300 }, c).some(v => v.param === 'staves' && /Set Staves to \d+/.test(v.message)));
check('a shade too tall for the bed says splitting will not help',
  gen.validate({ ...BASE, height: 260 }, c).some(v => /splitting the wall does not help/.test(v.message)));
check('a bow that pushes it past the bed is caught, not the number you typed',
  gen.validate({ ...BASE, dia: 175, bulge: 20 }, c).some(v => /bow puts the widest ring/.test(v.message)));
check('a wall too thin to scarf is an error', fires({ dia: 260, staves: 5, wall: 0.7 }, 'wall', 'error'));
check('a wall thinner than two extrusions is a warning', fires({ wall: 0.6 }, 'wall', 'warn'));
check('a wall thick enough to be opaque is worth saying', fires({ wall: 3 }, 'wall', 'info'));
check('staves that still will not fit are an error', fires({ dia: 400, staves: 3 }, 'staves', 'error'));
check('a split that needs several plate-loads says so', fires({ dia: 300, staves: 8, wall: 1.6 }, 'staves', 'info'));
check('a fitter ring wider than the bed is an error', fires({ dia: 300, topDia: 200, staves: 8, wall: 1.6 }, 'topDia', 'error'));
check('a top opening too small for the hub is reported, not silently widened',
  fires({ topDia: 30 }, 'topDia', 'info'));
check('the good presets raise no errors at all',
  gen.presets.every(pr => !anyError(pr.values)),
  gen.presets.filter(pr => anyError(pr.values)).map(pr => pr.name).join(', ') || 'all clean');

// ---------------------------------------------------------------------------
// hints: advice a person can act on.
// ---------------------------------------------------------------------------

console.log('\n-- hints --');
{
  const h = gen.hints(BASE, c);
  const text = h.notes.join(' ');
  check('it says which way up to print it and by how much it wins',
    /fitter down/.test(text) && /° from vertical/.test(text));
  check('it names the filament and argues it from the glass transition',
    h.filament === 'PLA' && /60 °C|glass transition/.test(text), h.filament);
  check('it refuses a halogen in a printed shade', /halogen/.test(text));
  check('it gives the wall-to-glow relationship in millimetres',
    /1\.6 mm .*glow|glow/.test(text) && /opaque/.test(text));
  check('it estimates the plastic', h.estGrams > 10 && h.estGrams < 900, `${h.estGrams} g`);
  check('it explains the E27 fitting and admits the 40 mm is published, not measured',
    /shade ring/.test(text) && /not a measurement of yours/.test(text));
  check('supports are off, because you cannot pick them out of a lampshade', h.supports === false);

  const hot = gen.hints({ ...BASE, dia: 130, topDia: 80, lamp: 'g80' }, c);
  check('a tight shade is told to use PETG', hot.filament === 'PETG', hot.filament);

  const spl = gen.hints({ ...BASE, dia: 300, topDia: 96, staves: 8, wall: 1.6 }, c);
  check('a split shade is told how to glue it up', /scarf|Cyanoacrylate/i.test(spl.notes.join(' ')));
  check('and to print the staves with a brim', /brim/i.test(spl.notes.join(' ')));
  check('and how many plate-loads it is', spl.plates >= 1 && spl.parts === 9, `${spl.parts} parts, ${spl.plates} plates`);

  const sp = gen.hints({ ...BASE, mode: 'spiral', fitter: 'none' }, c);
  check('spiral mode gets the vase-mode settings and the Orca warning',
    /Spiral vase mode ON/.test(sp.notes.join(' ')) && /exits 0/.test(sp.notes.join(' ')));

  const st = gen.hints({ ...BASE, lamp: 'st64', height: 90 }, c);
  check('a lamp that hangs out of the bottom is called a look, not a fault',
    /out of the bottom/.test(st.notes.join(' ')));
}

// ---------------------------------------------------------------------------
// Quality scaling and the segment budget.
// ---------------------------------------------------------------------------

console.log('\n-- quality --');
{
  const d = gen.build(BASE, ctx('draft')).mesh;
  const n = gen.build(BASE, ctx('normal')).mesh;
  const f = gen.build(BASE, ctx('fine')).mesh;
  check('draft is coarser than normal and normal than fine',
    d.triCount < n.triCount && n.triCount < f.triCount,
    `${d.triCount} < ${n.triCount} < ${f.triCount}`);
  nearPct('and the object is the same size at every quality',
    2 * maxRadius(f), 2 * maxRadius(d), 0.5);
  check('the fine build stays inside the cell budget', f.triCount < 300000, `${f.triCount} triangles`);
}

done();
