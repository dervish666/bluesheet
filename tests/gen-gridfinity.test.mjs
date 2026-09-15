// Gridfinity — the specification, measured back off the built solid.
//
// Nothing here compares the mesh to a constant that lives in the generator. A
// cross-section is cut out of the finished triangles at a given height, chained
// into oriented loops, and the widths, corner radii, hole positions and
// clearances are read off those loops. That is the only kind of test that can
// fail when the generator and its own constants agree with each other and both
// are wrong — which, for an object whose entire point is fitting somebody
// else's, is the failure that matters.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { isSolid, onPlate, centredXY, topology, volumeAgrees } from './lib/meshcheck.mjs';
import { analyze, printability, faceOverhangs, selfIntersect } from '../js/kernel/validate.js';
import gen, {
  PITCH, UNIT_H, CLEAR, BIN_SPAN, R_BIN, R_SOCKET, BASE_H, SOCKET_H, LIP_H, HOLE_OFFSET,
} from '../js/gen/gridfinity.js';

suite('gen-gridfinity');

const C = ctx('normal');
const P0 = defaults(gen);
const build = (over = {}, q = 'normal') => asMesh(gen.build({ ...P0, ...over }, ctx(q)));

// ---------------------------------------------------------------------------
// Cross-section measurement — independent of everything the generator knows.
// ---------------------------------------------------------------------------

/**
 * Cut `mesh` with the plane z = `z` and chain the pieces into oriented loops.
 * Each crossing triangle contributes one segment, directed so the solid is on
 * its left; a loop therefore comes back with a positive area if it bounds
 * material and a negative one if it bounds a void.
 */
function section(mesh, z) {
  const Pos = mesh.positions, Tri = mesh.tris;
  const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  const segs = [];
  for (let t = 0; t < Tri.length; t += 3) {
    const v = [Tri[t], Tri[t + 1], Tri[t + 2]].map(i => [Pos[i * 3], Pos[i * 3 + 1], Pos[i * 3 + 2]]);
    const d = v.map(q => q[2] - z);
    const hits = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
      if ((da > 0 && db <= 0) || (da <= 0 && db > 0)) {
        const s = da / (da - db);
        hits.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
    }
    if (hits.length !== 2) continue;
    const n = [
      (v[1][1] - v[0][1]) * (v[2][2] - v[0][2]) - (v[1][2] - v[0][2]) * (v[2][1] - v[0][1]),
      (v[1][2] - v[0][2]) * (v[2][0] - v[0][0]) - (v[1][0] - v[0][0]) * (v[2][2] - v[0][2]),
    ];
    const dir = [-n[1], n[0]];                       // outward normal rotated +90°
    const e = [hits[1][0] - hits[0][0], hits[1][1] - hits[0][1]];
    segs.push(e[0] * dir[0] + e[1] * dir[1] >= 0 ? [hits[0], hits[1]] : [hits[1], hits[0]]);
  }
  const from = new Map();
  for (const s of segs) {
    const k = key(s[0]);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(s);
  }
  const used = new Set(), loops = [];
  for (const s of segs) {
    if (used.has(s)) continue;
    const loop = [s[0]];
    let cur = s;
    for (let guard = 0; guard <= segs.length; guard++) {
      used.add(cur);
      loop.push(cur[1]);
      const next = (from.get(key(cur[1])) || []).filter(q => !used.has(q));
      if (!next.length) break;
      cur = next[0];
    }
    loop.pop();
    const ring = dedupe(loop);
    if (ring.length >= 3) loops.push(measure(ring));
  }
  return loops.filter(l => Math.abs(l.area) > 1e-6);
}

function dedupe(r) {
  const out = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

function measure(ring) {
  let area = 0, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  let diag = -Infinity, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    area += p[0] * q[1] - q[0] * p[1];
    minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
    miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
    diag = Math.max(diag, (p[0] + p[1]) / Math.SQRT2);
    cx += p[0]; cy += p[1];
  }
  return {
    ring, area: area / 2, w: maxx - minx, h: maxy - miny,
    minx, maxx, miny, maxy, diag, cx: cx / ring.length, cy: cy / ring.length,
  };
}

/**
 * Corner radius of a rounded rectangle, from its half-width and how far it
 * reaches along the 45° diagonal. The generator samples each 90° arc with an
 * even number of segments, so the diagonal is a real vertex and this is exact
 * rather than an approximation of the arc.
 */
function cornerR(halfW, diag) { return (Math.SQRT2 * halfW - diag) / (Math.SQRT2 - 1); }

const outerOf = (loops) => loops.filter(l => l.area > 0).sort((a, b) => b.area - a.area)[0];
const holesOf = (loops) => loops.filter(l => l.area < 0);
/** The void immediately inside the outer boundary — the socket, cavity or lip. */
const innerOf = (loops) => holesOf(loops).sort((a, b) => a.area - b.area)[0];

/** Half-width and corner radius of the bin's outer surface at height z. */
function outerAt(mesh, z) {
  const o = outerOf(section(mesh, z));
  return { half: o.w / 2, r: cornerR(o.w / 2, o.diag), loop: o };
}

// ---------------------------------------------------------------------------
// 1. The shared contract (gate G2).
// ---------------------------------------------------------------------------

conformance(gen, 'gridfinity');

// ---------------------------------------------------------------------------
// 2. The grid itself.
// ---------------------------------------------------------------------------

const bin = build();
const bin2x1 = build({ nx: 2 });
const bin3x2 = build({ nx: 3, ny: 2 });

check('the section tool finds the bin at all', section(bin, 1).length === 1, `${section(bin, 1).length} loops at z = 1`);

near('one unit measures 41.5 mm across', bin.bbox().size[0], BIN_SPAN, 1e-9);
near('the pitch between two units is 42.0 mm',
  bin2x1.bbox().size[0] - bin.bbox().size[0], PITCH, 1e-9);
near('three units across measure 3 × 42 − 0.5',
  bin3x2.bbox().size[0], 3 * PITCH - 2 * CLEAR, 1e-9);
near('two units deep measure 2 × 42 − 0.5',
  bin3x2.bbox().size[1], 2 * PITCH - 2 * CLEAR, 1e-9);
check('a non-square bin is not square',
  Math.abs(bin3x2.bbox().size[0] - bin3x2.bbox().size[1]) > 40,
  `${bin3x2.bbox().size[0]} × ${bin3x2.bbox().size[1]} mm`);

const h3 = build({ units: 3, lip: false }).bbox().size[2];
const h4 = build({ units: 4, lip: false }).bbox().size[2];
near('one height unit is 7.0 mm', h4 - h3, UNIT_H, 1e-9);
near('a 3-unit bin without a lip is 21 mm tall', h3, 3 * UNIT_H, 1e-9);

// ---------------------------------------------------------------------------
// 3. The base profile (gate G4) — measured, stage by stage.
// ---------------------------------------------------------------------------

const eps = 1e-3;
const baseStages = [
  ['bottom face', eps, 35.6 + 2 * eps, 0.8 + eps],
  ['top of the 0.8 mm chamfer', 0.8 - eps, 37.2 - 2 * eps, 1.6 - eps],
  ['top of the 1.8 mm vertical', 2.6 - eps, 37.2, 1.6],
  ['top of the base', BASE_H - eps, 41.5 - 2 * eps, 3.75 - eps],
];
for (const [label, z, wantW, wantR] of baseStages) {
  const s = outerAt(bin, z);
  near(`base profile at ${label}: width`, 2 * s.half, wantW, 2e-3);
  near(`base profile at ${label}: corner radius`, s.r, wantR, 2e-3);
}
near('the base profile is exactly 4.75 mm tall — the first chamfer starts at 0',
  outerAt(bin, BASE_H + eps).half * 2, 41.5, 2e-3);
// The 45° stages have to actually be 45°, which only a mid-stage sample proves.
near('the lower chamfer is 45° (sampled halfway up it)', outerAt(bin, 0.4).half * 2, 36.4, 2e-3);
near('the middle stage is vertical (sampled halfway up it)', outerAt(bin, 1.7).half * 2, 37.2, 2e-3);
near('the upper chamfer is 45° (sampled halfway up it)', outerAt(bin, 3.675).half * 2, 39.35, 2e-3);
near('the corner radius loses exactly its own chamfer height',
  outerAt(bin, 1.7).r - outerAt(bin, eps).r, 0.8, 2e-3);
near('and again on the upper chamfer',
  outerAt(bin, BASE_H - eps).r - outerAt(bin, 2.6 + eps).r, 2.15, 3e-3);

check('the bin body above the base is a constant 41.5 mm',
  [5, 10, 15, 20].every(z => Math.abs(outerAt(bin, z).half * 2 - 41.5) < 1e-6),
  [5, 10, 15, 20].map(z => (outerAt(bin, z).half * 2).toFixed(4)).join(', '));

// Every unit of a multi-unit bin has its own foot, with the specified gap.
// The gap is 0.5 mm only at the very top of the base, where the feet are at
// their widest; sampling lower down measures the chamfer, not the gap.
const feet = section(bin2x1, BASE_H - eps);
check('a 2×1 bin stands on two separate feet, not one big one', feet.length === 2, `${feet.length} loops`);
if (feet.length === 2) {
  const [a, b] = feet.sort((x, y) => x.cx - y.cx);
  near('the two feet are 42 mm apart', b.cx - a.cx, PITCH, 1e-6);
  near('the gap between adjacent feet is the specified 0.5 mm',
    b.minx - a.maxx, 2 * CLEAR, 3e-3);
  near('each foot is a full 41.5 mm unit in its own right', a.w, BIN_SPAN, 3e-3);
}

// ---------------------------------------------------------------------------
// 4. The stacking lip (gate G4).
// ---------------------------------------------------------------------------

const binH = 3 * UNIT_H;
near('the stacking lip adds exactly 4.4 mm',
  build({ units: 3 }).bbox().size[2] - build({ units: 3, lip: false }).bbox().size[2], LIP_H, 1e-9);
near('4.4 is not a magic number: it is the 4.65 socket less the 0.25 clearance',
  LIP_H, SOCKET_H - CLEAR, 1e-12);

const lipStages = [
  ['the lip base', eps, 36.3, 1.15],
  ['the top of its 0.7 mm chamfer', 0.7 + eps, 37.7, 1.85],
  ['the top of its 1.8 mm vertical', 2.5 - eps, 37.7, 1.85],
];
for (const [label, h, wantW, wantR] of lipStages) {
  const inner = innerOf(section(bin, binH + h));
  near(`lip inner face at ${label}: width`, inner.w, wantW, 4e-3);
  near(`lip inner face at ${label}: corner radius`, cornerR(inner.w / 2, inner.diag), wantR, 4e-3);
}
near('the lip is 45° over its lower chamfer (sampled halfway)',
  innerOf(section(bin, binH + 0.35)).w, 37.0, 4e-3);
near('the lip is 45° over its upper chamfer (sampled halfway)',
  innerOf(section(bin, binH + 3.45)).w, 39.6, 4e-3);
check('the lip closes on the outer wall at the very top',
  Math.abs(innerOf(section(bin, binH + LIP_H - eps)).w - 41.5) < 5e-3,
  `${innerOf(section(bin, binH + LIP_H - eps)).w.toFixed(4)} mm`);
check('the outer wall does not bulge for the lip',
  [0.5, 2, 4].every(h => Math.abs(outerAt(bin, binH + h).half * 2 - 41.5) < 1e-6));

const noLip = build({ lip: false });
check('with no lip there is no rim above the body',
  Math.abs(noLip.bbox().max[2] - binH) < 1e-9 && section(noLip, binH - eps).length >= 2,
  `top at ${noLip.bbox().max[2]}`);

// ---------------------------------------------------------------------------
// 5. The baseplate socket (gate G4).
// ---------------------------------------------------------------------------

const plate = build({ kind: 'baseplate' });
const plateH = plate.bbox().max[2];
near('a 1-cell baseplate is exactly 42 mm across', plate.bbox().size[0], PITCH, 1e-9);
near('and the standard 5 mm thick', plateH, 5, 1e-9);

const socketStages = [
  ['the plate surface', eps, 42.0, 4.0],
  ['2.15 mm down', 2.15 + eps, 37.7, 1.85],
  ['3.95 mm down', 3.95 - eps, 37.7, 1.85],
  ['the bottom of the socket', SOCKET_H - eps, 36.3, 1.15],
];
for (const [label, d, wantW, wantR] of socketStages) {
  const loops = section(plate, plateH - d);
  const sock = innerOf(loops) || outerOf(loops);
  near(`socket at ${label}: width`, sock.w, wantW, 5e-3);
  near(`socket at ${label}: corner radius`, cornerR(sock.w / 2, sock.diag), wantR, 5e-3);
}
const socketW = (d) => {
  const l = section(plate, plateH - d);
  return (innerOf(l) || outerOf(l)).w;
};
near('below 4.65 mm the socket is a plain vertical shaft', socketW(SOCKET_H + 0.05), socketW(plateH - 0.05), 1e-6);
check('and it starts opening out again at exactly 4.65 mm deep',
  socketW(SOCKET_H - 0.05) - socketW(SOCKET_H + 0.05) > 0.09,
  `${socketW(SOCKET_H - 0.05).toFixed(4)} mm at 4.60 vs ${socketW(SOCKET_H + 0.05).toFixed(4)} mm at 4.70`);
near('halfway down the socket lead-in it is still 45°', socketW(1), 40.0, 5e-3);

const plate2 = build({ kind: 'baseplate', nx: 2, ny: 2 });
near('a 2×2 baseplate is 84 mm square', plate2.bbox().size[0], 2 * PITCH, 1e-9);
check('its four sockets are separate voids',
  holesOf(section(plate2, plateH - 3)).length === 4,
  `${holesOf(section(plate2, plateH - 3)).length} sockets`);
const socketCentres = holesOf(section(plate2, plateH - 3)).map(l => [l.cx, l.cy]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
near('adjacent sockets are one pitch apart in X', socketCentres[2][0] - socketCentres[0][0], PITCH, 1e-6);
near('adjacent sockets are one pitch apart in Y', socketCentres[1][1] - socketCentres[0][1], PITCH, 1e-6);

// ---------------------------------------------------------------------------
// 6. They actually fit each other (gate G5).
//
// The bin's base top sits flush with the plate's top face, so the same depth
// below each is the same place in the joint. Anything outside 0.1–0.5 mm either
// binds or rattles.
// ---------------------------------------------------------------------------

let minClear = Infinity, maxClear = -Infinity, minRClear = Infinity, maxRClear = -Infinity;
let depths = 0;
for (let d = 0.05; d <= SOCKET_H - 0.05; d += 0.2) {
  const b = outerAt(bin, BASE_H - d);
  const loops = section(plate, plateH - d);
  const s = innerOf(loops) || outerOf(loops);
  const cl = s.w / 2 - b.half;
  const rc = cornerR(s.w / 2, s.diag) - b.r;
  minClear = Math.min(minClear, cl); maxClear = Math.max(maxClear, cl);
  minRClear = Math.min(minRClear, rc); maxRClear = Math.max(maxRClear, rc);
  depths++;
}
check(`bin into baseplate: clearance is 0.1–0.5 mm at all ${depths} depths sampled`,
  minClear >= 0.1 && maxClear <= 0.5, `measured ${minClear.toFixed(4)} … ${maxClear.toFixed(4)} mm per side`);
check('bin into baseplate: the corner radii keep the same clearance',
  minRClear >= 0.1 && maxRClear <= 0.5, `measured ${minRClear.toFixed(4)} … ${maxRClear.toFixed(4)} mm`);
near('and it is the specified 0.25 mm per side, uniformly', minClear, CLEAR, 2e-3);
near('at every depth, not just at the rim', maxClear, CLEAR, 2e-3);

// A bin stacked on a bin: its base drops into the lip below, whose base plane
// is the body top. Same test, different mating surface.
let lipMin = Infinity, lipMax = -Infinity, lipDepths = 0;
for (let h = 0.05; h <= LIP_H - 0.05; h += 0.2) {
  const b = outerAt(bin, h);
  const inner = innerOf(section(bin, binH + h));
  const cl = inner.w / 2 - b.half;
  lipMin = Math.min(lipMin, cl); lipMax = Math.max(lipMax, cl);
  lipDepths++;
}
check(`bin into stacking lip: clearance is 0.1–0.5 mm at all ${lipDepths} heights sampled`,
  lipMin >= 0.1 && lipMax <= 0.5, `measured ${lipMin.toFixed(4)} … ${lipMax.toFixed(4)} mm per side`);
near('the lip grips on its vertical stage at the full 0.25 mm', lipMin, CLEAR, 2e-3);

// Multi-unit parts have to line up too, not just single ones.
const plate3x2 = build({ kind: 'baseplate', nx: 3, ny: 2 });
const footC = section(bin3x2, BASE_H - 0.5).map(l => [+l.cx.toFixed(6), +l.cy.toFixed(6)]).sort();
const sockC = holesOf(section(plate3x2, plateH - 3)).map(l => [+l.cx.toFixed(6), +l.cy.toFixed(6)]).sort();
check('a 3×2 bin has one foot per socket of a 3×2 baseplate', footC.length === 6 && sockC.length === 6,
  `${footC.length} feet, ${sockC.length} sockets`);
check('and every foot is centred on its socket',
  footC.length === sockC.length && footC.every((f, i) => Math.hypot(f[0] - sockC[i][0], f[1] - sockC[i][1]) < 1e-6),
  footC.map((f, i) => sockC[i] ? Math.hypot(f[0] - sockC[i][0], f[1] - sockC[i][1]).toExponential(1) : '-').join(' '));

// ---------------------------------------------------------------------------
// 7. The options (gate G6), each verified by measurement.
// ---------------------------------------------------------------------------

// -- height in units and in millimetres
near('height given in mm gives the same bin as the equivalent units',
  build({ heightMode: 'mm', heightMm: 28 }).bbox().size[2], build({ units: 4 }).bbox().size[2], 1e-9);
near('a height between units is rounded up to a whole one',
  build({ heightMode: 'mm', heightMm: 22 }).bbox().size[2], 4 * UNIT_H + LIP_H, 1e-9);
near('unless snapping is turned off',
  build({ heightMode: 'mm', heightMm: 22, snapUnits: false }).bbox().size[2], 22 + LIP_H, 1e-9);

// -- magnet holes
const mag = build({ magnets: true });
const magLoops = holesOf(section(mag, 1.0));
check('magnet holes: four in a 1×1 bin, one per corner', magLoops.length === 4, `${magLoops.length} holes`);
const magRs = magLoops.map(l => Math.sqrt(Math.abs(l.area) / Math.PI));
nearPct('magnet holes are 6.0 mm across', 2 * Math.max(...magRs), 6.0, 1.5);
const magXs = [...new Set(magLoops.map(l => +l.cx.toFixed(4)))].sort((a, b) => a - b);
const magYs = [...new Set(magLoops.map(l => +l.cy.toFixed(4)))].sort((a, b) => a - b);
near('magnet holes sit ±13 mm from the unit centre', magXs[1], HOLE_OFFSET, 1e-3);
near('which is the standard 26 mm spacing in X', magXs[1] - magXs[0], 2 * HOLE_OFFSET, 1e-3);
near('and 26 mm in Y', magYs[1] - magYs[0], 2 * HOLE_OFFSET, 1e-3);
check('magnet pockets are 2.0 mm deep — open at 1.9, closed at 2.1',
  holesOf(section(mag, 1.9)).length === 4 && holesOf(section(mag, 2.1)).length === 0,
  `${holesOf(section(mag, 1.9)).length} at 1.9 mm, ${holesOf(section(mag, 2.1)).length} at 2.1 mm`);
check('every unit of a multi-unit bin gets its own four holes',
  holesOf(section(build({ nx: 2, ny: 2, magnets: true }), 1.0)).length === 16,
  `${holesOf(section(build({ nx: 2, ny: 2, magnets: true }), 1.0)).length} holes on a 2×2`);
check('holes stay clear of the edge of the foot they are in',
  magLoops.every(l => l.maxx <= BIN_SPAN / 2 - 2 * (BASE_H - 0.8 - 1.8) + 0.001 || l.maxx < 17.2),
  magLoops.map(l => l.maxx.toFixed(2)).join(' '));

// -- screw holes
const scr = build({ magnets: true, screws: true });
const scrLoops = holesOf(section(scr, 3.0));
check('screw holes continue above the magnet pocket', scrLoops.length === 4, `${scrLoops.length} at z = 3`);
nearPct('screw holes are M3 — 3.0 mm across', 2 * Math.sqrt(Math.abs(scrLoops[0].area) / Math.PI), 3.0, 2);
check('the magnet pocket is a shoulder above the screw hole',
  Math.abs(holesOf(section(scr, 1.0))[0].area) > Math.abs(scrLoops[0].area) * 3,
  `magnet ${Math.abs(holesOf(section(scr, 1.0))[0].area).toFixed(1)} mm² vs screw ${Math.abs(scrLoops[0].area).toFixed(1)} mm²`);
check('screw holes stay blind — nothing opens into the cavity',
  analyze(scr).shells === 1 && holesOf(section(scr, 6.2)).length === 0,
  `${holesOf(section(scr, 6.2)).length} loops just under the floor`);
check('screws without magnets bore straight through at M3',
  holesOf(section(build({ screws: true }), 1.0)).length === 4
  && Math.abs(2 * Math.sqrt(Math.abs(holesOf(section(build({ screws: true }), 1.0))[0].area) / Math.PI) - 3) < 0.06);

// -- the cavity floor
const floorLoops = (m, z) => holesOf(section(m, z)).length;
check('the cavity floor sits above the base profile by the floor thickness',
  floorLoops(bin, BASE_H + 0.7) === 0 && floorLoops(bin, BASE_H + 0.9) === 1,
  `voids at 5.45 mm: ${floorLoops(bin, BASE_H + 0.7)}, at 5.65 mm: ${floorLoops(bin, BASE_H + 0.9)}`);
check('a thicker floor moves it up and nothing else',
  floorLoops(build({ floor: 4 }), BASE_H + 3.9) === 0 && floorLoops(build({ floor: 4 }), BASE_H + 4.1) === 1);
check('the floor bridges the 0.5 mm gaps between the feet of a multi-unit bin',
  section(bin2x1, BASE_H + 0.4).length === 1,
  `${section(bin2x1, BASE_H + 0.4).length} islands just above the feet`);

// -- wall thickness
const midZ = binH - 4;
for (const w of [0.8, 1.2, 2.5]) {
  const m = build({ wall: w });
  const o = outerOf(section(m, midZ)), i = innerOf(section(m, midZ));
  near(`a ${w} mm wall measures ${w} mm at mid-height`, o.w / 2 - i.w / 2, w, 2e-3);
}

// -- dividers
const div = build({ divX: 3, divY: 2 });
const divVoids = holesOf(section(div, binH - 4));
check('3 × 2 dividers give six compartments', divVoids.length === 6, `${divVoids.length} voids`);
const divCx = [...new Set(divVoids.map(l => +l.cx.toFixed(3)))].sort((a, b) => a - b);
const divCy = [...new Set(divVoids.map(l => +l.cy.toFixed(3)))].sort((a, b) => a - b);
check('they are laid out three across and two deep', divCx.length === 3 && divCy.length === 2,
  `${divCx.length} × ${divCy.length}`);
near('the compartments are evenly spaced across', divCx[1] - divCx[0], divCx[2] - divCx[1], 1e-6);
near('the dividers are one wall thickness thick',
  divVoids.sort((a, b) => a.cx - b.cx)[2].minx - divVoids.sort((a, b) => a.cx - b.cx)[0].maxx, 1.2, 2e-3);
check('dividers on one axis only work too',
  holesOf(section(build({ divX: 4 }), binH - 4)).length === 4
  && holesOf(section(build({ divY: 4 }), binH - 4)).length === 4);
check('dividers stop below the rim so the lip has somewhere to land',
  holesOf(section(div, binH - 1)).length === 1,
  `${holesOf(section(div, binH - 1)).length} voids 1 mm under the rim`);

// -- front scoop
const scoop = build({ scoop: 8 });
const nearFloor = innerOf(section(scoop, BASE_H + 0.9));
const wellAbove = innerOf(section(scoop, BASE_H + 0.8 + 8.5));
check('the scoop pulls the cavity back from the front wall at the floor',
  nearFloor.miny - wellAbove.miny > 7.5,
  `front edge ${nearFloor.miny.toFixed(2)} mm at the floor vs ${wellAbove.miny.toFixed(2)} mm above the scoop`);
near('the scoop reaches the wall exactly one radius up',
  innerOf(section(scoop, BASE_H + 0.8 + 8 - eps)).miny, wellAbove.miny, 5e-3);
check('the scoop is a fillet, so it grows downwards and never overhangs',
  faceOverhangs(scoop).worst <= 45.001, `worst face ${faceOverhangs(scoop).worst.toFixed(2)}° from vertical`);
check('the scoop leaves the back of the bin alone',
  Math.abs(nearFloor.maxy - wellAbove.maxy) < 1e-6);

// -- label tab
const lab = build({ label: 'back', labelDepth: 12 });
const plain = build();
const labTop = innerOf(section(lab, binH - 3.0));
const plainTop = innerOf(section(plain, binH - 3.0));
check('the label tab eats into the back of the cavity at the top',
  plainTop.maxy - labTop.maxy > 11, `${(plainTop.maxy - labTop.maxy).toFixed(2)} mm of tab`);
check('and leaves the front alone', Math.abs(plainTop.miny - labTop.miny) < 1e-6);
check('the tab has cleared out again lower down',
  Math.abs(innerOf(section(lab, binH - 3.0 - 12.2)).maxy - plainTop.maxy) < 0.02,
  `${innerOf(section(lab, binH - 3.0 - 12.2)).maxy.toFixed(3)} vs ${plainTop.maxy.toFixed(3)}`);
// G6: it must not foul the bin above. The lip's socket has to be untouched.
const lipWith = innerOf(section(lab, binH + 1.5));
const lipWithout = innerOf(section(plain, binH + 1.5));
check('the label tab does not intrude into the stacking socket above it',
  Math.abs(lipWith.area - lipWithout.area) < 1e-6 && Math.abs(lipWith.maxy - lipWithout.maxy) < 1e-9,
  `socket area ${lipWith.area.toFixed(3)} with tab vs ${lipWithout.area.toFixed(3)} without`);
check('nothing of the tab reaches above the bin body at all',
  [0.2, 1.0, 2.0, 3.0, 4.0].every(h =>
    Math.abs(innerOf(section(lab, binH + h)).area - innerOf(section(plain, binH + h)).area) < 1e-6),
  'sampled at 5 heights through the lip');
check('a front tab goes on the other end',
  innerOf(section(build({ label: 'front', labelDepth: 12 }), binH - 3.0)).miny - plainTop.miny > 11);
check('and "both" gives one at each end',
  (() => {
    const b = innerOf(section(build({ label: 'both', labelDepth: 10 }), binH - 3.0));
    return b.maxy < plainTop.maxy - 9 && b.miny > plainTop.miny + 9;
  })());
check('the tab underside is printable at the angle asked for',
  faceOverhangs(build({ label: 'back', labelAngle: 45 })).worst <= 45.001,
  `${faceOverhangs(build({ label: 'back', labelAngle: 45 })).worst.toFixed(2)}°`);

// -- baseplate styles
const plateLight = build({ kind: 'baseplate', nx: 2, ny: 2, plateStyle: 'light' });
const plateSolid = build({ kind: 'baseplate', nx: 2, ny: 2, plateStyle: 'solid', plateFloor: 2.4 });
check('a light baseplate is open right through every socket',
  holesOf(section(plateLight, 0.2)).length === 4, `${holesOf(section(plateLight, 0.2)).length} holes near the bed`);
check('a solid baseplate has a floor under them',
  holesOf(section(plateSolid, 0.2)).length === 0 && holesOf(section(plateSolid, 3.5)).length === 4,
  `${holesOf(section(plateSolid, 0.2)).length} holes at the bed, ${holesOf(section(plateSolid, 3.5)).length} sockets above the floor`);
near('the solid plate is exactly its floor plus a socket',
  plateSolid.bbox().size[2], 2.4 + SOCKET_H + 0.35, 1e-9);
check('the solid plate is the heavier of the two',
  plateSolid.volume() > plateLight.volume() * 2.5,
  `${plateSolid.volume().toFixed(0)} vs ${plateLight.volume().toFixed(0)} mm³`);
check('a solid plate still presents the same socket to a bin',
  Math.abs((innerOf(section(plateSolid, plateSolid.bbox().max[2] - 2.15)) || {}).w - 37.7) < 5e-3,
  `${(innerOf(section(plateSolid, plateSolid.bbox().max[2] - 2.15)) || {}).w.toFixed(4)} mm`);
const plateMag = build({ kind: 'baseplate', nx: 1, ny: 1, plateStyle: 'solid', plateMagnets: true });
check('a solid plate can take magnets under each socket corner',
  holesOf(section(plateMag, 1.0)).length === 4, `${holesOf(section(plateMag, 1.0)).length} pockets`);
check('placed where a bin\'s own magnets are',
  holesOf(section(plateMag, 1.0)).every(l => Math.abs(Math.abs(l.cx) - HOLE_OFFSET) < 1e-3 && Math.abs(Math.abs(l.cy) - HOLE_OFFSET) < 1e-3));

// ---------------------------------------------------------------------------
// 8. Solidity beyond the shared harness — the combinations, and the extremes
//    of the parameters the shared sweep cannot reach because they only apply
//    to the baseplate.
// ---------------------------------------------------------------------------

const combos = [
  ['everything at once', { nx: 3, ny: 2, units: 6, wall: 1.6, floor: 1.6, divX: 3, divY: 2, scoop: 6, label: 'both', labelDepth: 10, magnets: true, screws: true }],
  ['1×1×1 with a lip', { units: 1 }],
  ['1×1×1 with a thick wall', { units: 1, wall: 3 }],
  ['5×5, bigger than the bed', { nx: 5, ny: 5 }],
  ['a wall thicker than the corner radius', { wall: 3.6, divX: 2 }],
  ['a wall thicker than half the bin', { wall: 25 }],
  ['the deepest scoop in the shallowest bin', { units: 2, scoop: 15 }],
  ['maximum dividers', { divX: 6, divY: 6 }],
  ['no lip, dividers and a tab', { lip: false, divX: 2, divY: 2, label: 'back' }],
];
for (const [label, over] of combos) {
  const m = build(over);
  const t = topology(m);
  check(`${label}: watertight, manifold, correctly wound, positive`,
    t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && t.degenerate === 0 && m.volume() > 0,
    `bnd ${t.boundary}, nonman ${t.nonManifold}, wind ${t.inconsistent}, deg ${t.degenerate}, vol ${m.volume().toFixed(0)}`);
}
const plateCombos = [
  ['light, minimum thickness', { kind: 'baseplate', plateThickness: 4.75 }],
  ['light, maximum thickness', { kind: 'baseplate', plateThickness: 12 }],
  ['solid, thinnest floor', { kind: 'baseplate', plateStyle: 'solid', plateFloor: 0.8 }],
  ['solid, thickest floor with magnets', { kind: 'baseplate', plateStyle: 'solid', plateFloor: 8, plateMagnets: true }],
  ['solid 4×3 with magnets', { kind: 'baseplate', nx: 4, ny: 3, plateStyle: 'solid', plateMagnets: true }],
  ['light 5×5', { kind: 'baseplate', nx: 5, ny: 5 }],
  ['light 1×5', { kind: 'baseplate', nx: 1, ny: 5 }],
  ['magnets asked for on a light plate', { kind: 'baseplate', plateMagnets: true }],
];
for (const [label, over] of plateCombos) {
  const m = build(over);
  const t = topology(m);
  check(`baseplate ${label}: watertight and on the plate`,
    t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && t.degenerate === 0
    && m.volume() > 0 && Math.abs(m.bbox().min[2]) < 1e-9,
    `bnd ${t.boundary}, wind ${t.inconsistent}, vol ${m.volume().toFixed(0)}, min z ${m.bbox().min[2]}`);
}
isSolid('the kitchen-sink bin', build(combos[0][1]));
onPlate('the kitchen-sink bin', build(combos[0][1]));
centredXY('the kitchen-sink bin', build(combos[0][1]));
volumeAgrees('the default bin', bin, 6, 6000);
volumeAgrees('a divided bin with a scoop and a tab', build({ divX: 2, divY: 2, scoop: 5, label: 'back' }), 6, 6000);
volumeAgrees('a 2×1 bin, whose feet are bridged', bin2x1, 6, 6000);
volumeAgrees('the light baseplate', plateLight, 8, 6000);
check('nothing in the catalogue self-intersects',
  [bin, bin2x1, build({ divX: 2, divY: 2, scoop: 5, label: 'back', magnets: true }), plateLight, plateSolid]
    .every(m => selfIntersect(m).count === 0),
  [bin, bin2x1, plateLight, plateSolid].map(m => selfIntersect(m).count).join(' '));
check('a multi-unit bin is still one shell', analyze(bin3x2).shells === 1, `${analyze(bin3x2).shells} shells`);
check('a boolean-derived face is still deterministic on a multi-unit bin',
  (() => {
    const a = build({ nx: 3, ny: 2 }).toSTL('t'), b = build({ nx: 3, ny: 2 }).toSTL('t');
    if (a.length !== b.length) return false;
    for (let i = 84; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  })(), 'two builds byte-identical past the header');

// ---------------------------------------------------------------------------
// 9. Printability and the guard rails (gate G8).
// ---------------------------------------------------------------------------

const pr = printability(bin);
check('the default bin has no overhang worse than 45°',
  faceOverhangs(bin).worst <= 45.001, `${faceOverhangs(bin).worst.toFixed(2)}° from vertical`);
const shapeOnly = [{ scoop: 10 }, { label: 'both' }, { divX: 3, divY: 3 }, { lip: false },
  { wall: 3 }, { wall: 0.8 }, { units: 1 }, { units: 12, scoop: 6, label: 'back', divX: 2 }];
check('nor does any single-unit variant of its shape',
  shapeOnly.every(o => faceOverhangs(build(o)).worst <= 45.001),
  shapeOnly.map(o => faceOverhangs(build(o)).worst.toFixed(1)).join('° ') + '°');
check('a baseplate has no overhang at all — every surface is 45° or steeper',
  faceOverhangs(plate2).worst <= 0.001, `${faceOverhangs(plate2).worst.toFixed(2)}°`);
// Hardware makes one deliberate flat ceiling: the roof of the magnet pocket.
// That is a 6 mm bridge over a hole and it is what lets the magnet seat.
{
  const m = build({ magnets: true, screws: true });
  const f = faceOverhangs(m);
  let steepZ = [];
  for (let t = 0; t < m.triCount; t++) {
    if (f.angles[t] > 45.001 && f.areas[t] > 1e-9) {
      steepZ.push(m.positions[m.tris[t * 3] * 3 + 2]);
    }
  }
  check('the only thing above 45° in a magnetised bin is the roof of a pocket',
    steepZ.length > 0 && steepZ.every(z => Math.abs(z - 2.0) < 1e-6 || Math.abs(z - 6.0) < 1e-6),
    `${steepZ.length} faces, all at z = ${[...new Set(steepZ.map(z => z.toFixed(3)))].join('/')} (magnet roof 2.0, screw roof 6.0)`);
  check('and it is four 6 mm bridges, not a slab',
    f.overhangArea > 4 * Math.PI * 2.9 * 2.9 * 0.9 && f.overhangArea < 4 * Math.PI * 3.1 * 3.1,
    `${f.overhangArea.toFixed(1)} mm² across four pockets`);
}
// The multi-unit foot gap is the other one, and the specification requires it.
{
  const f = faceOverhangs(bin2x1);
  let gapZ = [];
  for (let t = 0; t < bin2x1.triCount; t++) {
    if (f.angles[t] > 45.001 && f.areas[t] > 1e-9) gapZ.push(bin2x1.positions[bin2x1.tris[t * 3] * 3 + 2]);
  }
  check('the only flat overhang on a multi-unit bin is the specified foot gap',
    gapZ.length > 0 && gapZ.every(z => Math.abs(z - BASE_H) < 1e-6),
    `${gapZ.length} faces, all at z = ${[...new Set(gapZ.map(z => z.toFixed(3)))].join('/')}`);
  check('and it is a 0.5 mm span, not a slab: under a third of a percent of the surface',
    f.overhangArea < 40 && (f.overhangArea / bin2x1.surfaceArea()) * 100 < 0.3,
    `${f.overhangArea.toFixed(1)} mm² on a ${bin2x1.surfaceArea().toFixed(0)} mm² part`);
}
check('the default bin fits the bed with room to spare', pr.fitsBed);
check('and weighs what a gridfinity bin weighs', pr.estGrams > 5 && pr.estGrams < 40, `${pr.estGrams.toFixed(1)} g`);

const H = gen.hints(P0, C);
check('hints() names a print profile', typeof H.profile === 'string' && H.profile.length > 4, H.profile);
check('hints() says supports are not needed', H.supports === false);
check('hints() names a filament', typeof H.filament === 'string' && H.filament.length > 2, H.filament);
check('hints() gives real advice, not one line', H.notes.length >= 5, `${H.notes.length} notes`);
check('hints() mentions elephant\'s foot — the commonest reason a bin will not seat',
  H.notes.some(n => /elephant/i.test(n)));
check('hints() states the wall count that produces the wall thickness',
  H.notes.some(n => /wall/i.test(n) && /\d/.test(n)));
check('hints() for a baseplate is different advice, not the same advice',
  gen.hints({ ...P0, kind: 'baseplate' }, C).notes.join(' ') !== H.notes.join(' '));
check('hints() warns about the foot-gap bridges only when there are any',
  gen.hints({ ...P0, nx: 2 }, C).notes.some(n => /0\.5 mm/.test(n) && /bridge/i.test(n))
  && !H.notes.some(n => /slot/i.test(n)));

const sev = (p) => gen.validate(p, C).map(v => v.severity);
check('validate() refuses a bin bigger than the bed',
  sev({ ...P0, nx: 5, ny: 5 }).includes('error'),
  JSON.stringify(gen.validate({ ...P0, nx: 5, ny: 5 }, C).filter(v => v.severity === 'error').map(v => v.message)).slice(0, 120));
check('validate() refuses a bin taller than the printer',
  sev({ ...P0, heightMode: 'mm', heightMm: 200 }).includes('error'));
check('validate() catches walls thicker than half the bin',
  gen.validate({ ...P0, wall: 25 }, C).some(v => v.severity === 'error' && v.param === 'wall'),
  JSON.stringify(gen.validate({ ...P0, wall: 25 }, C).filter(v => v.param === 'wall').map(v => v.message)).slice(0, 150));
check('and builds it anyway rather than throwing, clamped',
  build({ wall: 25 }).volume() > 0 && topology(build({ wall: 25 })).boundary === 0);
check('validate() catches a baseplate floor under three layers',
  gen.validate({ ...P0, kind: 'baseplate', plateStyle: 'solid', plateFloor: 0.5 }, C)
    .some(v => v.severity === 'error' && v.param === 'plateFloor'));
check('validate() explains that a light baseplate cannot hold magnets',
  gen.validate({ ...P0, kind: 'baseplate', plateStyle: 'light', plateMagnets: true }, C)
    .some(v => /magnet/i.test(v.message)));
check('validate() warns when a single-extrusion wall is asked for',
  gen.validate({ ...P0, wall: 0.5 }, C).some(v => v.param === 'wall' && v.severity === 'warn'));
check('validate() says nothing alarming about a sensible bin',
  gen.validate(P0, C).every(v => v.severity !== 'error'),
  JSON.stringify(gen.validate(P0, C).map(v => `${v.severity}:${v.param}`)));
check('validate() flags the deep-screw-in-a-short-bin case rather than making a hole through the floor',
  gen.validate({ ...P0, units: 1, screws: true, screwDepth: 12 }, C).some(v => v.severity !== 'info'),
  JSON.stringify(gen.validate({ ...P0, units: 1, screws: true, screwDepth: 12 }, C).map(v => v.severity)));

// ---------------------------------------------------------------------------
// 10. Presets (gate G7).
// ---------------------------------------------------------------------------

check('there are at least four presets', gen.presets.length >= 4, `${gen.presets.length}`);
check('every preset is named for what it is for, not for its parameters',
  gen.presets.every(p => /[a-z]/.test(p.name) && !/^Preset/i.test(p.name) && p.name.length > 6),
  gen.presets.map(p => p.name).join(' / '));
check('the presets include a baseplate and a divided bin, not just plain boxes',
  gen.presets.some(p => p.values.kind === 'baseplate')
  && gen.presets.some(p => (p.values.divX || 1) * (p.values.divY || 1) > 1)
  && gen.presets.some(p => p.values.scoop > 0)
  && gen.presets.some(p => p.values.magnets));
for (const pre of gen.presets) {
  const m = build(pre.values);
  const s = m.bbox().size;
  check(`preset "${pre.name}" fits the A1 mini bed`,
    s[0] <= 180 && s[1] <= 180 && s[2] <= 180, s.map(v => v.toFixed(1)).join(' × ') + ' mm');
  check(`preset "${pre.name}" is watertight and would print without supports`,
    topology(m).boundary === 0 && m.volume() > 0 && gen.hints(pre.values, C).supports === false);
}
check('every preset lands on the grid',
  gen.presets.every(pre => {
    const s = build(pre.values).bbox().size;
    const isPlate = pre.values.kind === 'baseplate';
    const step = isPlate ? 0 : 2 * CLEAR;
    return Math.abs((s[0] + step) % PITCH) < 1e-6 && Math.abs((s[1] + step) % PITCH) < 1e-6;
  }),
  gen.presets.map(pre => build(pre.values).bbox().size.slice(0, 2).map(v => v.toFixed(1)).join('×')).join(' '));

// ---------------------------------------------------------------------------
// 11. Speed and size — this rebuilds live while a finger drags a stepper.
// ---------------------------------------------------------------------------

for (const [label, over, limit] of [
  ['the default bin', {}, 60],
  ['a 5×5 bin', { nx: 5, ny: 5 }, 250],
  ['a 5×5 solid baseplate', { kind: 'baseplate', nx: 5, ny: 5, plateStyle: 'solid', plateMagnets: true }, 400],
  ['six compartments with scoops and a tab', { divX: 3, divY: 2, scoop: 5, label: 'back' }, 120],
]) {
  const t0 = process.hrtime.bigint();
  const m = build(over, 'fine');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`${label} rebuilds in under ${limit} ms at fine quality`, ms < limit, `${ms.toFixed(0)} ms, ${m.triCount} triangles`);
}
check('the default bin is a lean mesh — swept, not carved out with booleans',
  bin.triCount < 2000, `${bin.triCount} triangles`);
check('quality genuinely changes the density',
  build({}, 'draft').triCount < bin.triCount && bin.triCount < build({}, 'fine').triCount,
  `${build({}, 'draft').triCount} → ${bin.triCount} → ${build({}, 'fine').triCount}`);
check('and the specification survives draft quality, where the arcs are coarsest',
  Math.abs(outerAt(build({}, 'draft'), BASE_H - eps).half * 2 - 41.5) < 3e-3
  && Math.abs(outerAt(build({}, 'draft'), eps).half * 2 - 35.6) < 3e-3,
  `${(outerAt(build({}, 'draft'), BASE_H - eps).half * 2).toFixed(4)} mm at the top of the base`);

// ---------------------------------------------------------------------------
// Dimension callouts — pinned to the features they claim to measure.
// ---------------------------------------------------------------------------
{
  const dimsOf = (over = {}) => gen.build({ ...P0, ...over }, C).meta.dims;
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const d0 = dimsOf();
  const wall = d0.find(d => d.param === 'wall');
  check('the wall callout spans the left wall, outer face to cavity, 1.2 mm',
    !!wall && eq(wall.from[0], -BIN_SPAN / 2) && eq(wall.to[0], -BIN_SPAN / 2 + 1.2)
    && wall.from[2] < 21 && wall.from[2] > BASE_H,
    wall ? `${wall.from} → ${wall.to}` : 'missing');
  const floor = d0.find(d => d.param === 'floor');
  check('the floor callout rises 0.8 mm from the top of the base profile on the front face',
    !!floor && eq(floor.from[2], BASE_H) && eq(floor.to[2], BASE_H + 0.8)
    && eq(floor.from[1], -BIN_SPAN / 2) && eq(floor.to[1], -BIN_SPAN / 2),
    floor ? `${floor.from} → ${floor.to}` : 'missing');
  const smd = gen.presets.find(pr => pr.name.startsWith('Magnet-mount')).values;
  const mag = dimsOf(smd).find(d => d.param === 'magnetDia');
  check('the magnet callout is a 6 mm diameter across the front-right hole, on the underside',
    !!mag && eq(Math.hypot(mag.to[0] - mag.from[0], mag.to[1] - mag.from[1]), 6)
    && eq((mag.from[0] + mag.to[0]) / 2, HOLE_OFFSET) && eq(mag.from[1], -PITCH + PITCH / 2 - HOLE_OFFSET)
    && mag.from[2] === 0 && mag.to[2] === 0,
    mag ? `${mag.from} → ${mag.to}` : 'missing');
}

done();
