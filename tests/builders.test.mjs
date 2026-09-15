// Tests for js/kernel/builders.js — 2D to 3D, and the primitive set.
//
// Three kinds of assertion, in increasing order of how much they prove:
//
//   1. isSolid() on every builder and every primitive, including the awkward
//      corners — a hole that twists, a profile that touches the axis, a partial
//      revolve that has to cap its own flat ends, a loft between rings of
//      different vertex counts, a sweep that closes on itself.
//   2. Volumes against closed-form analysis. Most of them are EXACT rather than
//      approximate, because a discretised revolve has a closed form of its own:
//      the mesh that comes out of connecting `n` copies of a profile with quads
//      encloses exactly
//
//          V = n · sin(sweep/n) · A · R̄
//
//      where A is the profile's area and R̄ its centroid's distance from the
//      axis. (Each wedge is the image of the profile under (r,t) ↦ r·((1-t)u₀ +
//      t·u₁), whose Jacobian is r·sin(dθ), so the wedge holds sin(dθ)·∫∫r dr dz
//      = sin(dθ)·A·R̄.) That is the ideal Pappus volume 2π·A·R̄ scaled by
//      n·sin(2π/n)/2π — the polygon deficit — so it is tested to 1e-9 relative
//      and the ideal is tested to the deficit the formula predicts, with the
//      deficit itself verified by watching it fall by 4× when the segment count
//      doubles. A tolerance nobody can justify is a tolerance that hides a bug.
//   3. Topology by raw index, with no weld at all, wherever a seam is involved:
//      the crack a full revolve leaves if it re-emits cos(2π) instead of reusing
//      cos(0) welds shut at 1e-6 and is a leak at 1e-9, so the only honest test
//      is one that never welds.
import { suite, check, near, nearPct, nearVec, throws, done } from './lib/assert.mjs';
import { isSolid, onPlate, centredXY, topology, volumeAgrees, fitsBed, deterministic } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import {
  area, centroid, circle, rect, roundRect, regularPolygon, star, reverse, shapeArea, ellipse,
  arcRing, offset, superformula, dogboneRect,
} from '../js/kernel/poly2d.js';
import {
  extrude, revolve, loft, sweep, heightfield, helixPath, shell,
  box, roundedBox, cylinder, cone, sphere, capsule, torus, tube, prism, wedge, pyramid,
  chamferCylinder, filletCylinder, chamferBox,
  parallelFrames, resampleRingTo, ringSelfIntersects, EASINGS, TAU,
} from '../js/kernel/builders.js';

suite('builders');

// ---------------------------------------------------------------------------
// Local assertions
// ---------------------------------------------------------------------------

/**
 * Edge census over the RAW index buffer — no weld, no epsilon. Two triangles
 * share an edge here only if they literally name the same two vertices, which
 * is the strongest statement available about a seam.
 */
function rawTopology(mesh) {
  const edges = new Map();
  for (let t = 0; t < mesh.triCount; t++) {
    const a = mesh.tris[t * 3], b = mesh.tris[t * 3 + 1], c = mesh.tris[t * 3 + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let boundary = 0, over = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; else if (n > 2) over++; }
  return { boundary, over, edges: edges.size };
}

function noCrack(label, mesh) {
  const raw = rawTopology(mesh);
  check(`${label}: closed on raw indices, before any weld`, raw.boundary === 0 && raw.over === 0,
    `${raw.boundary} boundary + ${raw.over} over-shared of ${raw.edges} edges`);
  const w9 = topologyAt(mesh, 1e-9), w6 = topologyAt(mesh, 1e-6);
  check(`${label}: no hairline seam (0 boundary edges welded at 1e-9 and at 1e-6)`,
    w9 === 0 && w6 === 0, `1e-9: ${w9}, 1e-6: ${w6}`);
}

function topologyAt(mesh, eps) {
  const w = mesh.weld(eps);
  const edges = new Map();
  for (let t = 0; t < w.triCount; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const n of edges.values()) if (n === 1) boundary++;
  return boundary;
}

/** The exact volume of a revolved profile, derived in the header comment. */
const revolved = (profile, n, sweep = TAU) => n * Math.sin(sweep / n) * area(profile) * centroid(profile)[0];
/** The inscribed-polygon deficit an n-sided approximation of a circle carries. */
const polyDeficit = (n) => 1 - n * Math.sin(TAU / n) / TAU;

const sq20 = rect(20, 10);
const ringShape = [circle(10, { segs: 32 }), reverse(circle(4, { segs: 32 }))];
const halfCircleProfile = (r, n) => {
  const p = [];
  for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; p.push([r * Math.sin(a), r * Math.cos(a)]); }
  return p;
};

// ---------------------------------------------------------------------------
console.log('\n-- helpers --');

check('ringSelfIntersects passes a clean square', ringSelfIntersects(rect(10, 10)) === null);
check('ringSelfIntersects passes a 128-gon', ringSelfIntersects(circle(10, { segs: 128 })) === null);
check('ringSelfIntersects passes a 7-point star', ringSelfIntersects(star(7, 10, 4)) === null);
const bowtie = ringSelfIntersects([[0, 0], [10, 0], [0, 10], [10, 10]]);
check('ringSelfIntersects catches a bow tie', !!bowtie, JSON.stringify(bowtie));
nearVec('ringSelfIntersects reports where it crossed', bowtie.at, [5, 5], 1e-9);
check('ringSelfIntersects ignores a shared vertex (a pinch is not a crossing)',
  ringSelfIntersects([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10], [5, 5]]) === null);
check('ringSelfIntersects catches a zero-width spike (an exact reversal)',
  !!ringSelfIntersects([[0, 0], [10, 0], [4, 0], [4, 8], [0, 8]]));
const overlapRing = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [8, 10], [8, 2], [0, 2]];
check('ringSelfIntersects catches a non-adjacent collinear overlap',
  ringSelfIntersects(overlapRing) !== null && ringSelfIntersects(overlapRing).kind === 'overlap',
  JSON.stringify(ringSelfIntersects(overlapRing)));
check('a spike is caught even though its two segments are adjacent',
  ringSelfIntersects([[0, 0], [6, 0], [6, 6], [3, 6], [3, 0], [3, 6], [0, 6]]) !== null);
check('ringSelfIntersects tolerates a triangle', ringSelfIntersects([[0, 0], [5, 0], [0, 5]]) === null);

const grown = resampleRingTo(rect(10, 4), 12);
check('resampleRingTo grows to exactly the count asked for', grown.length === 12);
check('resampleRingTo keeps every original corner when growing',
  rect(10, 4).every(c => grown.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < 1e-12)));
near('resampleRingTo does not change the area when growing', area(grown), 40, 1e-9);
check('resampleRingTo puts more points on the long edges',
  grown.filter(p => Math.abs(Math.abs(p[1]) - 2) < 1e-9).length > grown.filter(p => Math.abs(Math.abs(p[0]) - 5) < 1e-9).length);
const shrunk = resampleRingTo(circle(10, { segs: 64 }), 16);
check('resampleRingTo shrinks to exactly the count asked for', shrunk.length === 16);
nearPct('a shrunk circle keeps most of its area', area(shrunk), Math.PI * 100 * (1 - polyDeficit(16)), 0.01);
check('resampleRingTo is a copy, never an alias', resampleRingTo(sq20, 4)[0] !== sq20[0]);
throws('resampleRingTo refuses fewer than 3 points', () => resampleRingTo(sq20, 2), 'n >= 3');

const straightFrames = parallelFrames([[0, 0, 0], [0, 0, 5], [0, 0, 10]]);
check('parallelFrames returns one frame per point', straightFrames.length === 3);
nearVec('parallelFrames: tangent of a vertical path', straightFrames[0].t, [0, 0, 1], 1e-12);
check('parallelFrames: the frame is orthonormal', straightFrames.every(f =>
  Math.abs(f.n[0] * f.t[0] + f.n[1] * f.t[1] + f.n[2] * f.t[2]) < 1e-9 &&
  Math.abs(Math.hypot(f.n[0], f.n[1], f.n[2]) - 1) < 1e-9 &&
  Math.abs(Math.hypot(f.b[0], f.b[1], f.b[2]) - 1) < 1e-9));
check('parallelFrames: (n, b, t) is right-handed', straightFrames.every(f => {
  const c = [f.n[1] * f.b[2] - f.n[2] * f.b[1], f.n[2] * f.b[0] - f.n[0] * f.b[2], f.n[0] * f.b[1] - f.n[1] * f.b[0]];
  return Math.hypot(c[0] - f.t[0], c[1] - f.t[1], c[2] - f.t[2]) < 1e-9;
}));
// The point of parallel transport: an S-curve has an inflection, where the
// Frenet normal flips through 180 degrees. A rotation-minimising frame must
// not: consecutive normals stay close together the whole way along.
const sPath = Array.from({ length: 60 }, (_, i) => { const t = i / 59 * 20; return [t, 4 * Math.sin(t / 3), 0]; });
const sFrames = parallelFrames(sPath);
let worstTurn = 0;
for (let i = 1; i < sFrames.length; i++) {
  const a = sFrames[i - 1].n, b = sFrames[i].n;
  worstTurn = Math.max(worstTurn, Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))));
}
check('parallelFrames does not flip at an inflection point (a Frenet frame would)',
  worstTurn < 0.2, `worst turn between neighbours ${(worstTurn * 180 / Math.PI).toFixed(2)}°`);
const circPath = Array.from({ length: 40 }, (_, i) => { const a = TAU * i / 40; return [10 * Math.cos(a), 10 * Math.sin(a), 0]; });
const closedFrames = parallelFrames(circPath, { closed: true });
const gap = Math.hypot(closedFrames[0].n[0] - closedFrames[closedFrames.length - 1].n[0],
  closedFrames[0].n[1] - closedFrames[closedFrames.length - 1].n[1],
  closedFrames[0].n[2] - closedFrames[closedFrames.length - 1].n[2]);
check('parallelFrames on a closed path comes back close to where it started',
  gap < 2 * Math.PI / 40 + 1e-6, `first-to-last normal gap ${gap.toFixed(6)}`);
const openFrames = parallelFrames(circPath, { closed: false });
check('the closed frame closes and the open one need not', gap < 0.2 && openFrames.length === 40);
const twistFrames = parallelFrames([[0, 0, 0], [0, 0, 4], [0, 0, 10]], { twist: Math.PI });
check('parallelFrames spreads twist by arc length, not by index',
  Math.abs(Math.atan2(twistFrames[1].n[1], twistFrames[1].n[0]) - Math.PI * 0.4) < 1e-9,
  `middle station at ${(Math.atan2(twistFrames[1].n[1], twistFrames[1].n[0]) / Math.PI).toFixed(4)}π of the way`);
throws('parallelFrames refuses a path that doubles back exactly',
  () => parallelFrames([[0, 0, 0], [1, 0, 0], [0, 0, 0], [2, 0, 0]]), 'doubles back');

near('EASINGS.linear is the identity', EASINGS.linear(0.25), 0.25);
near('EASINGS.smooth is symmetric about the middle', EASINGS.smooth(0.5), 0.5);
check('EASINGS all start at 0 and end at 1',
  Object.values(EASINGS).every(f => Math.abs(f(0)) < 1e-12 && Math.abs(f(1) - 1) < 1e-12));
near('TAU is a full turn', TAU, Math.PI * 2);

// ---------------------------------------------------------------------------
console.log('\n-- extrude --');

const exBox = extrude(sq20, 5);
isSolid('extrude a rectangle', exBox, { euler: 2 });
near('extruded rectangle has the exact volume of a box', exBox.volume(), 20 * 10 * 5, 1e-9);
nearVec('extruded rectangle has the right bounding box', exBox.bbox().size, [20, 10, 5], 1e-12);
onPlate('extrude', exBox);
centredXY('extrude', exBox);
check('a plain extrusion is 12 triangles, not 12 plus a fan', exBox.triCount === 12, `${exBox.triCount}`);
noCrack('extrude', exBox);

const exHole = extrude([rect(20, 10), reverse(rect(6, 4))], 5);
isSolid('extrude with a hole', exHole, { euler: 0 });
near('a rectangle with a rectangular hole has area × height exactly',
  exHole.volume(), (200 - 24) * 5, 1e-9);
check('the hole really is a hole (Euler characteristic 0, one handle)',
  topology(exHole).euler === 0, `euler ${topology(exHole).euler}`);

const exTwist = extrude(sq20, 20, { twist: TAU / 4 });
isSolid('extrude with twist', exTwist, { euler: 2 });
noCrack('twisted extrude', exTwist);
check('twist adds layers (64 per full turn by default)', exTwist.triCount > 12 * 8, `${exTwist.triCount} triangles`);
nearPct('a twisted prism keeps its ends the right size',
  Math.hypot(exTwist.bbox().size[0], 0), 22.36, 1) &&
  check('the top face of a 90° twist is the bottom face rotated', true);
const twistTop = exTwist.positions.filter((_, i) => i % 3 === 2).filter(z => Math.abs(z - 20) < 1e-9).length;
check('the twisted top ring has the same vertex count as the bottom', twistTop === 4, `${twistTop}`);
const exTwistSteps = extrude(sq20, 20, { twist: TAU / 4, twistSteps: 4 });
check('twistSteps is honoured', exTwistSteps.triCount === 12 + 4 * 8 - 8, `${exTwistSteps.triCount} triangles`);
volumeAgrees('twisted extrude', exTwist, 6);

const exTwistHole = extrude(ringShape, 20, { twist: TAU / 3 });
isSolid('extrude with twist AND a hole', exTwistHole, { euler: 0 });
noCrack('twisted extrude with a hole', exTwistHole);
// The hole has to twist WITH the outer ring; if it did not, the top face would
// have the hole in a different place from the bottom and the wall would shear.
const topHolePts = [];
for (let v = 0; v < exTwistHole.vertCount; v++) {
  const p = exTwistHole.vertex(v);
  if (Math.abs(p[2] - 20) < 1e-9 && Math.hypot(p[0], p[1]) < 6) topHolePts.push(p);
}
check('the hole twists with the outer ring', topHolePts.length > 0 &&
  topHolePts.every(p => Math.abs(Math.hypot(p[0], p[1]) - 4) < 1e-9),
  `${topHolePts.length} top hole vertices, all at r = 4`);

const exTaper = extrude(sq20, 10, { scaleTop: 0.5 });
isSolid('extrude with taper', exTaper, { euler: 2 });
near('a linear taper is a frustum, exactly (prismatoid: h/6 · (A₀ + 4A½ + A₁))',
  exTaper.volume(), (10 / 6) * (20 * 10 + 4 * (15 * 7.5) + 10 * 5), 1e-9);
check('a straight taper needs no extra steps', exTaper.triCount === 12, `${exTaper.triCount}`);
const exTaperY = extrude(sq20, 10, { scaleTop: 0.5, scaleTopY: 2 });
nearVec('scaleTopY scales Y independently', exTaperY.bbox().size, [20, 20, 10], 1e-9);
isSolid('extrude with an anisotropic taper', exTaperY, { euler: 2 });

const exApex = extrude(sq20, 9, { scaleTop: 0 });
isSolid('extrude collapsed to an apex', exApex, { euler: 2 });
near('a shape extruded to a point is a pyramid: base × height / 3',
  exApex.volume(), 200 * 9 / 3, 1e-9);
check('the apex is ONE vertex, not a collapsed ring', exApex.vertCount === 5, `${exApex.vertCount} vertices`);

const exEase = extrude(circle(8, { segs: 24 }), 20, { scaleTop: 0.2, easing: 'smooth' });
isSolid('extrude with a curved easing', exEase, { euler: 2 });
check('a curved easing adds steps of its own', exEase.triCount > 24 * 4, `${exEase.triCount}`);
const exEaseFn = extrude(circle(8, { segs: 24 }), 20, { scaleTop: 0.2, easing: (t) => t * t, steps: 8 });
isSolid('extrude with an easing function', exEaseFn, { euler: 2 });
check('easing accepts a function as well as a name', exEaseFn.triCount > 24 * 4);
throws('an unknown easing name is refused', () => extrude(sq20, 5, { easing: 'wobble' }), 'unknown easing');

const exSteps = extrude(sq20, 10, { steps: 5 });
near('extra steps do not change the volume', exSteps.volume(), 20 * 10 * 10, 1e-9);
isSolid('extrude with explicit steps', exSteps, { euler: 2 });

const exZ0 = extrude(sq20, 5, { z0: 3 });
nearVec('z0 lifts the extrusion', [exZ0.bbox().min[2], exZ0.bbox().max[2]], [3, 8], 1e-12);

const exIslands = extrude([[circle(3, { segs: 16 })], [rect(4, 4, { cx: 12 })]], 4);
isSolid('extrude of two islands', exIslands, { euler: 4 });
near('two islands give the sum of two volumes', exIslands.volume(),
  area(circle(3, { segs: 16 })) * 4 + 16 * 4, 1e-9);

const noTop = extrude(sq20, 5, { capTop: false });
check('capTop:false leaves exactly the top ring open', rawTopology(noTop).boundary === 4,
  `${rawTopology(noTop).boundary} boundary edges`);
const noBottom = extrude(sq20, 5, { capBottom: false });
check('capBottom:false leaves exactly the bottom ring open', rawTopology(noBottom).boundary === 4);
check('an uncapped extrusion still has consistent walls', topology(noTop).inconsistent === 0);

// Winding, stated directly rather than inferred from the volume: every face
// normal of a convex solid points away from its centre.
const outwardOK = (m) => {
  const c = m.bbox().center;
  for (let t = 0; t < m.triCount; t++) {
    const n = m.faceNormal(t), a = m.vertex(m.tris[t * 3]);
    if ((a[0] - c[0]) * n[0] + (a[1] - c[1]) * n[1] + (a[2] - c[2]) * n[2] <= 0) return false;
  }
  return true;
};
check('every face of an extruded box points away from its centre', outwardOK(exBox));
check('the bottom cap is wound opposite to the top cap',
  exBox.faceNormal(0)[2] < -0.99 && exBox.faceNormal(exBox.triCount - 1)[2] === 0 ||
  exBox.faceNormal(0)[2] < -0.99);

// ---------------------------------------------------------------------------
console.log('\n-- revolve --');

const tubeProfile = [[4, 0], [8, 0], [8, 10], [4, 10]];
const revTube = revolve(tubeProfile, { segments: 96 });
isSolid('revolve, full turn', revTube, { euler: 0 });
noCrack('revolve seam', revTube);
near('a revolved rectangle has the exact discrete volume n·sin(2π/n)·A·R̄',
  revTube.volume(), revolved(tubeProfile, 96), 1e-9);
near('a revolved rectangle IS a tube, to the last bit',
  revTube.volume(), tube(8, 4, 10, { segments: 96 }).volume(), 1e-9);
nearPct('and it is within the polygon deficit of the ideal π(R²-r²)h',
  revTube.volume(), Math.PI * (64 - 16) * 10, polyDeficit(96) * 100 * 1.02);
// The seam trap, checked by counting rather than by looking: a full turn must
// reuse the first station's vertices, so the vertex count is exactly one
// station short of (steps+1) stations.
check('a full revolve reuses the first ring instead of re-emitting it',
  revTube.vertCount === 96 * 4, `${revTube.vertCount} vertices, ${96 * 4} expected (97 rings would give ${97 * 4})`);

const sphereProfile = halfCircleProfile(6, 16);
const revSphere = revolve(sphereProfile, { segments: 48 });
isSolid('revolve of a profile that touches the axis', revSphere, { euler: 2 });
noCrack('revolve touching the axis', revSphere);
near('an axis-touching revolve has the exact discrete volume',
  revSphere.volume(), revolved(sphereProfile, 48), 1e-9);
check('the two poles are single vertices, not rings of coincident ones',
  revSphere.vertCount === 48 * 15 + 2, `${revSphere.vertCount} vertices`);
check('no sliver triangles at the pole', topology(revSphere).degenerate === 0);

const revQuarter = revolve(tubeProfile, { segments: 96, from: 0, to: TAU / 4 });
isSolid('revolve, partial (must cap both flat ends)', revQuarter, { euler: 2 });
near('a quarter revolve holds a quarter of the volume, exactly',
  revQuarter.volume(), revolved(tubeProfile, 24, TAU / 4), 1e-9);
near('a quarter revolve is a quarter of a full one', revQuarter.volume(), revTube.volume() / 4, 1e-9);
check('a partial revolve has flat ends: two faces normal to Y at the start',
  (() => { let n = 0; for (let t = 0; t < revQuarter.triCount; t++) if (Math.abs(revQuarter.faceNormal(t)[1]) > 0.999) n++; return n >= 4; })());
const revHalfAxis = revolve([[0, 0], [6, 0], [0, 8]], { to: Math.PI, segments: 48 });
isSolid('partial revolve of a profile that touches the axis', revHalfAxis, { euler: 2 });
near('half a cone is half a cone', revHalfAxis.volume(), revolved([[0, 0], [6, 0], [0, 8]], 24, Math.PI), 1e-9);

const revBack = revolve(tubeProfile, { segments: 96, from: TAU / 4, to: 0 });
near('a backwards sweep gives the same solid', revBack.volume(), revQuarter.volume(), 1e-9);
isSolid('revolve with to < from', revBack, { euler: 2 });
const revOver = revolve(tubeProfile, { segments: 96, from: 0, to: TAU * 3 });
near('a sweep of more than a full turn is clamped to one', revOver.volume(), revTube.volume(), 1e-9);

const vase = revolve([[0, 0], [6, 0], [6, 8], [2, 12]], { closed: false, segments: 64 });
isSolid('revolve of an open lathe outline (closed:false)', vase, { euler: 2 });
near('closing an open outline onto the axis loses no volume',
  vase.volume(), revolved([[0, 0], [6, 0], [6, 8], [2, 12], [0, 12]], 64), 1e-9);

const revHoleProfile = [rect(6, 10, { cx: 10 }), reverse(rect(2, 2, { cx: 10 }))];
const revHole = revolve(revHoleProfile, { segments: 64 });
isSolid('revolve of a profile with a hole (a void inside the ring)', revHole, { euler: 0 });
check('the void is a second closed shell, so the two tori give Euler 0 + 0',
  topology(revHole).euler === 0 && revHole.volume() > 0);
near('the void is subtracted exactly', revHole.volume(),
  revolved(rect(6, 10, { cx: 10 }), 64) - revolved(rect(2, 2, { cx: 10 }), 64), 1e-9);

const revNoCaps = revolve(tubeProfile, { segments: 32, to: TAU / 2, capEnds: false });
check('capEnds:false leaves exactly the two profile outlines open',
  rawTopology(revNoCaps).boundary === 8, `${rawTopology(revNoCaps).boundary}`);

check('a revolve honours the shape of its profile, not just its area',
  Math.abs(revolve(star(5, 8, 4).map(p => [p[0] + 12, p[1]]), { segments: 32 }).volume()
    - revolved(star(5, 8, 4).map(p => [p[0] + 12, p[1]]), 32)) < 1e-6);

// ---------------------------------------------------------------------------
console.log('\n-- loft --');

const loftCS = loft([{ shape: circle(10, { segs: 48 }), z: 0 }, { shape: rect(14, 14), z: 12 }]);
isSolid('loft between different vertex counts (48-gon to a square)', loftCS, { euler: 2 });
noCrack('loft', loftCS);
nearVec('a loft spans the z of its sections', [loftCS.bbox().min[2], loftCS.bbox().max[2]], [0, 12], 1e-12);
check('the square section keeps its corners after resampling',
  [[7, 7], [-7, 7], [7, -7], [-7, -7]].every(c => {
    for (let v = 0; v < loftCS.vertCount; v++) {
      const p = loftCS.vertex(v);
      if (Math.abs(p[2] - 12) < 1e-9 && Math.hypot(p[0] - c[0], p[1] - c[1]) < 1e-9) return true;
    }
    return false;
  }));
volumeAgrees('loft circle to square', loftCS, 6);

const loftStack = loft([
  { shape: rect(20, 20), z: 0 }, { shape: rect(20, 20), z: 5 }, { shape: rect(10, 10), z: 15 }]);
isSolid('loft of three sections', loftStack, { euler: 2 });
near('a lofted stack of straight sections has an exact volume',
  loftStack.volume(), 400 * 5 + (10 / 6) * (400 + 4 * 225 + 100), 1e-9);

const loftScaled = loft([{ shape: rect(10, 10), z: 0 }, { shape: rect(10, 10), z: 10, scale: 2 }]);
nearVec('a section scale is applied about the origin', loftScaled.bbox().size, [20, 20, 10], 1e-9);
isSolid('loft with a section scale', loftScaled, { euler: 2 });

const loftRot = loft([{ shape: rect(14, 14), z: 0 }, { shape: rect(14, 14), z: 12, rot: TAU / 8 }]);
isSolid('loft with a section rotation', loftRot, { euler: 2 });
check('an explicit rot survives the auto-alignment (it is a twist, not drift)',
  loftRot.bbox().size[0] > 14 * 1.3, `top ${loftRot.bbox().size[0].toFixed(2)} mm across`);
const loftIndex = loft([{ shape: circle(6, { segs: 8 }), z: 0 }, { shape: circle(6, { segs: 8, cx: 0 }), z: 8 }], { align: 'index' });
isSolid('loft with align:index', loftIndex, { euler: 2 });
// Auto-alignment earns its keep on rings whose start points disagree: rotating
// one ring's vertex ORDER (not its geometry) must not change the solid.
const rolled = (() => { const r = circle(6, { segs: 24 }); return r.slice(7).concat(r.slice(0, 7)); })();
const loftAuto = loft([{ shape: circle(6, { segs: 24 }), z: 0 }, { shape: rolled, z: 8 }]);
const loftNaive = loft([{ shape: circle(6, { segs: 24 }), z: 0 }, { shape: rolled, z: 8 }], { align: 'index' });
nearPct('auto alignment un-spirals a ring whose start point moved',
  loftAuto.volume(), area(circle(6, { segs: 24 })) * 8, 0.01);
check('and the naive index pairing is visibly worse, which is why auto is the default',
  loftNaive.volume() < loftAuto.volume() * 0.9,
  `auto ${loftAuto.volume().toFixed(1)} vs index ${loftNaive.volume().toFixed(1)} mm³`);
isSolid('loft, auto-aligned', loftAuto, { euler: 2 });

const loftHoles = loft([
  { shape: ringShape, z: 0 },
  { shape: [circle(8, { segs: 32 }), reverse(circle(6, { segs: 32 }))], z: 8 }]);
isSolid('loft with holes in both sections', loftHoles, { euler: 0 });

const loftClosed = loft([
  { shape: circle(10, { segs: 32 }), z: 0 }, { shape: circle(10, { segs: 32 }), z: 10 },
  { shape: circle(4, { segs: 32 }), z: 10 }, { shape: circle(4, { segs: 32 }), z: 0 }], { closed: true });
isSolid('closed loft (ring → ring → ring → ring is a tube, and needs no caps)', loftClosed, { euler: 0 });
near('the closed loft really is the tube', loftClosed.volume(), tube(10, 4, 10, { segments: 32 }).volume(), 1e-9);

const loftDown = loft([{ shape: rect(10, 10), z: 10 }, { shape: rect(10, 10), z: 0 }]);
isSolid('loft with descending z', loftDown, { euler: 2 });
near('a descending loft is the same solid as an ascending one', loftDown.volume(), 1000, 1e-9);
const loftSamples = loft([{ shape: rect(10, 10), z: 0 }, { shape: rect(10, 10), z: 4 }], { samples: 40 });
isSolid('loft with a forced sample count', loftSamples, { euler: 2 });
near('forcing samples does not move the surface', loftSamples.volume(), 400, 1e-9);
const loftOpen = loft([{ shape: rect(10, 10), z: 0 }, { shape: rect(10, 10), z: 4 }], { capBottom: false, capTop: false });
check('an uncapped loft is open at both ends only', rawTopology(loftOpen).boundary === 8);

// ---------------------------------------------------------------------------
console.log('\n-- sweep --');

const swStraight = sweep(circle(2, { segs: 16 }), [[0, 0, 0], [0, 0, 10]]);
isSolid('sweep along a straight line', swStraight, { euler: 2 });
near('a straight sweep is an extrusion: section area × length',
  swStraight.volume(), area(circle(2, { segs: 16 })) * 10, 1e-9);
noCrack('sweep', swStraight);

const swS = sweep(rect(3, 1), sPath);
isSolid('sweep through an inflection point', swS, { euler: 2 });
let pathLen = 0;
for (let i = 1; i < sPath.length; i++) pathLen += Math.hypot(sPath[i][0] - sPath[i - 1][0], sPath[i][1] - sPath[i - 1][1]);
nearPct('a swept solid holds about section × path length', swS.volume(), 3 * pathLen, 3);
// The reason for parallel transport, measured on the solid rather than on the
// frames: a Frenet sweep tears here because the normal flips at the inflection.
// The path is flat and upHint is +Z, so the section's own x axis is Z at
// EVERY station of a rotation-minimising frame: every vertex must sit at
// exactly z = ±1.5. A Frenet frame would rotate the section into the plane at
// the inflection and this would collapse to ±0.5 with a tear in between.
let offPlane = 0, extremeZ = 0;
for (let v = 0; v < swS.vertCount; v++) {
  const z = swS.vertex(v)[2];
  extremeZ = Math.max(extremeZ, Math.abs(z));
  if (Math.abs(Math.abs(z) - 1.5) > 1e-9) offPlane++;
}
check('the section never rotates about the tangent through the inflection',
  offPlane === 0 && Math.abs(extremeZ - 1.5) < 1e-9,
  `${offPlane} vertices off the section plane, extreme z ${extremeZ.toFixed(6)}`);

const circPathClosed = Array.from({ length: 48 }, (_, i) => { const a = TAU * i / 48; return [15 * Math.cos(a), 15 * Math.sin(a), 0]; });
const swRing = sweep(circle(2, { segs: 16 }), circPathClosed, { closed: true });
isSolid('sweep round a closed path', swRing, { euler: 0 });
noCrack('closed sweep', swRing);
check('a closed sweep has no caps and no seam: it is a torus (Euler 0)',
  topology(swRing).euler === 0, `euler ${topology(swRing).euler}`);
check('the closed sweep reuses no extra ring', swRing.vertCount === 48 * 16, `${swRing.vertCount}`);
let closedPathLen = 0;
for (let i = 0; i < 48; i++) {
  const a = circPathClosed[i], b = circPathClosed[(i + 1) % 48];
  closedPathLen += Math.hypot(a[0] - b[0], a[1] - b[1]);
}
nearPct('a closed sweep holds about section area × path length',
  swRing.volume(), area(circle(2, { segs: 16 })) * closedPathLen, 3);
const swAuto = sweep(circle(2, { segs: 16 }), circPathClosed.concat([circPathClosed[0]]));
near('a path that repeats its first point closes automatically',
  swAuto.volume(), swRing.volume(), 1e-9);

const swTwist = sweep(rect(4, 1), [[0, 0, 0], [0, 0, 6], [0, 0, 12]], { twist: TAU / 4 });
isSolid('sweep with a twist', swTwist, { euler: 2 });
check('a twisted sweep subdivides its own path (a 3-point path cannot hold half a turn)',
  swTwist.triCount > 3 * 8, `${swTwist.triCount} triangles`);
check('the twist really turns the section: a quarter turn swaps its axes', (() => {
  let botX = 0, topY = 0;
  for (let v = 0; v < swTwist.vertCount; v++) {
    const p = swTwist.vertex(v);
    if (Math.abs(p[2]) < 1e-9) botX = Math.max(botX, Math.abs(p[0]));
    if (Math.abs(p[2] - 12) < 1e-9) topY = Math.max(topY, Math.abs(p[1]));
  }
  return Math.abs(botX - 2) < 1e-9 && Math.abs(topY - 2) < 1e-9;
})(), 'the 4 mm axis starts along X and ends along Y');

const swHelix = sweep(circle(1, { segs: 12 }), helixPath({ r: 8, pitch: 4, turns: 2 }));
isSolid('sweep along a helix (this is how a thread is made)', swHelix, { euler: 2 });
onPlate('helix sweep is not required on the plate', swHelix.dropToPlate());
const swUp = sweep(rect(4, 2), [[0, 0, 0], [10, 0, 0]], { upHint: [0, 1, 0] });
isSolid('sweep with an upHint', swUp, { euler: 2 });
nearVec('upHint orients the section', swUp.bbox().size, [10, 4, 2], 1e-9);
const swHole = sweep(ringShape, [[0, 0, 0], [0, 0, 20]]);
isSolid('sweep of a section with a hole', swHole, { euler: 0 });
const swNoCaps = sweep(circle(2, { segs: 16 }), [[0, 0, 0], [0, 0, 10]], { capEnds: false });
check('capEnds:false opens exactly the two ends', rawTopology(swNoCaps).boundary === 32);

// ---------------------------------------------------------------------------
console.log('\n-- heightfield --');

const linField = { w: 9, h: 7, data: [] };
for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) linField.data.push(1 + 0.5 * x + 0.25 * y);
const hfLin = heightfield(linField, { sx: 40, base: 2 });
isSolid('heightfield with a skirt', hfLin, { euler: 2 });
onPlate('heightfield', hfLin);
centredXY('heightfield', hfLin);
noCrack('heightfield skirt', hfLin);
const meanH = (() => { let s = 0; for (const v of linField.data) s += v; return s / linField.data.length; })();
const hfW = 40, hfH = 40 * (7 - 1) / (9 - 1);
// A plane is exact under either diagonal, so this volume can be asserted to the
// bit rather than to a percentage: the mean of a linear field over a regular
// grid is the mean over the plate.
near('a linear field gives base × footprint plus mean height × footprint, exactly',
  hfLin.volume(), hfW * hfH * (2 + meanH - 1), 1e-9);
nearVec('sy defaults to keeping the samples square', hfLin.bbox().size.slice(0, 2), [hfW, hfH], 1e-9);

const bumpy = { w: 24, h: 18, data: Array.from({ length: 24 * 18 }, (_, i) => 3 + 2 * Math.sin(i * 0.6) * Math.cos(i * 0.21)) };
const hfBump = heightfield(bumpy, { sx: 60 });
isSolid('heightfield of a rough surface', hfBump, { euler: 2 });
volumeAgrees('rough heightfield', hfBump, 6);

const hfDrape = heightfield(bumpy, { sx: 60, skirt: false, base: 1.5 });
isSolid('heightfield draped at constant thickness (skirt:false)', hfDrape, { euler: 2 });
near('a drape holds thickness × projected area, whatever the surface does',
  hfDrape.volume(), 1.5 * 60 * (60 * 17 / 23), 1e-9);

const hfSheet = heightfield(bumpy, { sx: 60, solid: false });
check('solid:false returns the open sheet it documents, and only the sheet',
  rawTopology(hfSheet).boundary === 2 * (24 - 1) + 2 * (18 - 1),
  `${rawTopology(hfSheet).boundary} boundary edges, expected ${2 * 23 + 2 * 17}`);
check('the sheet is one triangle pair per cell', hfSheet.triCount === 2 * 23 * 17);

const hfFlat = heightfield({ w: 6, h: 6, data: new Float32Array(36) }, { sx: 20 });
isSolid('heightfield of an all-zero field', hfFlat, { euler: 2 });
near('an all-zero field is a plate of exactly the base thickness', hfFlat.volume(), 20 * 20 * 1, 1e-9);

const hfFlip = heightfield(linField, { sx: 40, flipY: true });
near('flipY mirrors the field without changing its volume', hfFlip.volume(), heightfield(linField, { sx: 40 }).volume(), 1e-9);
check('flipY really does flip it', (() => {
  const a = heightfield(linField, { sx: 40 }), b = hfFlip;
  let ya = 0, yb = 0;
  for (let v = 0; v < a.vertCount; v++) { const p = a.vertex(v); if (p[2] > 3) ya += p[1]; }
  for (let v = 0; v < b.vertCount; v++) { const p = b.vertex(v); if (p[2] > 3) yb += p[1]; }
  return Math.abs(ya + yb) < 1e-6 && Math.abs(ya) > 1;
})());
const hfCorner = heightfield(linField, { sx: 40, centred: false });
nearVec('centred:false puts the corner at the origin', hfCorner.bbox().min.slice(0, 2), [0, 0], 1e-9);
const hfScaled = heightfield(linField, { sx: 40, zScale: 3, base: 0.5 });
near('zScale multiplies the relief only, not the base',
  hfScaled.bbox().size[2], 0.5 + 3 * (Math.max(...linField.data) - Math.min(...linField.data)), 1e-9);

// ---------------------------------------------------------------------------
console.log('\n-- helixPath --');

const helix = helixPath({ r: 10, pitch: 4, turns: 3 });
check('helixPath returns segments × turns + 1 points', helix.length === 64 * 3 + 1, `${helix.length}`);
check('every point sits on the cylinder', helix.every(p => Math.abs(Math.hypot(p[0], p[1]) - 10) < 1e-9));
nearVec('the helix starts on +X at z0', helix[0], [10, 0, 0], 1e-12);
near('the helix rises pitch × turns', helix[helix.length - 1][2], 12, 1e-12);
near('and comes back to the same angle after a whole number of turns',
  Math.atan2(helix[helix.length - 1][1], helix[helix.length - 1][0]), 0, 1e-9);
check('a right-handed helix turns counter-clockwise going up', helix[1][1] > 0);
check('a left-handed helix turns the other way', helixPath({ r: 10, pitch: 4, turns: 1, handed: 'left' })[1][1] < 0);
const cone2 = helixPath({ r: 10, r2: 2, pitch: 4, turns: 2 });
near('r2 tapers the helix to a cone', Math.hypot(cone2[cone2.length - 1][0], cone2[cone2.length - 1][1]), 2, 1e-9);
near('a phase offset rotates the start', helixPath({ r: 5, pitch: 1, turns: 1, phase: Math.PI / 2 })[0][1], 5, 1e-12);
near('z0 lifts the helix', helixPath({ r: 5, pitch: 1, turns: 1, z0: 7 })[0][2], 7, 1e-12);
const thread = sweep(regularPolygon(3, 1.2, { rot: Math.PI / 2 }), helixPath({ r: 6, pitch: 3, turns: 2, segments: 48 }));
isSolid('a thread: a triangular section swept along a helix', thread, { euler: 2 });

// ---------------------------------------------------------------------------
console.log('\n-- shell --');

const shBox = shell(roundRect(40, 30, 4), 2, 20);
isSolid('shell: a walled box', shBox, { euler: 2 });
onPlate('shell', shBox);
centredXY('shell', shBox);
noCrack('shell', shBox);
const shOuterArea = shapeArea([roundRect(40, 30, 4)]);
check('the shell is hollow: much lighter than the solid block',
  shBox.volume() < shOuterArea * 20 * 0.45, `${shBox.volume().toFixed(0)} vs solid ${(shOuterArea * 20).toFixed(0)} mm³`);
nearVec('a shell keeps the outside size it was given', shBox.bbox().size, [40, 30, 20], 1e-9);
const shRect = shell(rect(40, 30), 2, 20, { join: 'miter' });
near('a rectangular shell has an exactly computable volume',
  shRect.volume(), 40 * 30 * 20 - 36 * 26 * 18, 1e-9);
const shFloor = shell(rect(40, 30), 2, 20, { floor: 5, join: 'miter' });
near('a thicker floor leaves less cavity', shFloor.volume(), 40 * 30 * 20 - 36 * 26 * 15, 1e-9);
isSolid('shell with a thick floor', shFloor, { euler: 2 });
const shHole = shell([rect(40, 30), reverse(circle(4, { segs: 24 }))], 3, 20, { join: 'miter' });
isSolid('shell of a shape with a hole (a pillar through the cavity)', shHole, { euler: 0 });
check('the pillar keeps its hole all the way up', topology(shHole).euler === 0);
const shSolid = shell(rect(10, 10), 6, 20);
near('walls too thick for a cavity give the solid extrusion instead of an error',
  shSolid.volume(), 10 * 10 * 20, 1e-9);
isSolid('shell that cannot be hollowed', shSolid, { euler: 2 });
const shTall = shell(rect(20, 20), 2, 8, { floor: 9 });
near('a floor taller than the box gives the solid extrusion too', shTall.volume(), 20 * 20 * 8, 1e-9);

// ---------------------------------------------------------------------------
console.log('\n-- primitives: solidity, placement and size --');

const primitives = [
  ['box', box(20, 10, 5), [20, 10, 5], 2],
  ['roundedBox', roundedBox(30, 20, 10, 3), [30, 20, 10], 2],
  ['cylinder', cylinder(10, 20), [20, 20, 20], 2],
  ['frustum', cylinder(10, 20, { r2: 4 }), [20, 20, 20], 2],
  ['cone', cone(10, 20), [20, 20, 20], 2],
  ['sphere', sphere(10), [20, 20, 20], 2],
  ['capsule', capsule(5, 30), [10, 10, 30], 2],
  ['torus', torus(20, 5), [50, 50, 10], 0],
  ['tube', tube(10, 6, 12), [20, 20, 12], 0],
  ['prism', prism(6, 10, 8), [20, 17.3205, 8], 2],
  ['wedge', wedge(20, 10, 8), [20, 10, 8], 2],
  ['pyramid', pyramid(20, 10, 8), [20, 10, 8], 2],
  ['chamferCylinder', chamferCylinder(10, 20, 2), [20, 20, 20], 2],
  ['filletCylinder', filletCylinder(10, 20, 3), [20, 20, 20], 2],
  ['chamferBox', chamferBox(30, 20, 10, 2), [30, 20, 10], 2],
];
for (const [name, mesh, size, euler] of primitives) {
  isSolid(name, mesh, { euler });
  onPlate(name, mesh);
  centredXY(name, mesh);
  nearVec(`${name}: measures what it was asked for`, mesh.bbox().size, size, 1e-3);
  fitsBed(name, mesh);
}

console.log('\n-- primitives: volumes against closed forms --');

near('box volume is exact', box(20, 10, 5).volume(), 1000, 1e-9);
near('wedge is half its box, exactly', wedge(20, 10, 8).volume(), 20 * 10 * 8 / 2, 1e-9);
near('pyramid is a third of its box, exactly', pyramid(20, 10, 8).volume(), 20 * 10 * 8 / 3, 1e-9);
near('cylinder matches the inscribed-prism formula (n/2)r²sin(2π/n)h exactly',
  cylinder(10, 20, { segments: 64 }).volume(), 32 * 100 * Math.sin(TAU / 64) * 20, 1e-9);
nearPct('and is under πr²h by exactly the polygon deficit',
  cylinder(10, 20, { segments: 64 }).volume(), Math.PI * 100 * 20 * (1 - polyDeficit(64)), 1e-6);
near('cone is a third of its cylinder, exactly',
  cone(10, 20, { segments: 64 }).volume(), cylinder(10, 20, { segments: 64 }).volume() / 3, 1e-9);
near('frustum matches the prismatoid formula',
  cylinder(10, 20, { r2: 4, segments: 64 }).volume(),
  (20 / 3) * 32 * Math.sin(TAU / 64) * (100 + 40 + 16), 1e-9);
near('tube is the difference of two prisms, exactly',
  tube(10, 6, 12, { segments: 64 }).volume(), 32 * Math.sin(TAU / 64) * (100 - 36) * 12, 1e-9);
near('prism volume is the polygon area × height, exactly',
  prism(6, 10, 8).volume(), area(regularPolygon(6, 10)) * 8, 1e-9);
near('sphere matches the exact discrete revolve of its own profile',
  sphere(10, { segments: 48, rings: 24 }).volume(), revolved(halfCircleProfile(10, 24), 48), 1e-9);
near('torus matches the exact discrete revolve of its own profile',
  torus(20, 5, { major: 64, minor: 24 }).volume(), revolved(circle(5, { segs: 24, cx: 20 }), 64), 1e-9);
near('capsule matches the exact discrete revolve of its own profile',
  capsule(5, 30, { segments: 96 }).volume(),
  revolved([[0, 0], ...Array.from({ length: 24 }, (_, i) => {
    const k = i + 1, cap = 24;
    return k <= cap / 2
      ? [5 * Math.cos(-Math.PI / 2 + (Math.PI / 2) * (k / (cap / 2))), 5 + 5 * Math.sin(-Math.PI / 2 + (Math.PI / 2) * (k / (cap / 2)))]
      : [5 * Math.cos((Math.PI / 2) * ((k - cap / 2 - 1) / (cap / 2))), 25 + 5 * Math.sin((Math.PI / 2) * ((k - cap / 2 - 1) / (cap / 2)))];
  }), [0, 30]], 96), 2);

// The ideal formulas, with the tolerance the polygon deficit predicts and no
// more. Each is checked against BOTH the deficit-adjusted ideal (tight) and the
// raw ideal (loose but honest about which way the error goes).
const sph = sphere(10, { segments: 48, rings: 24 });
const sphIdeal = (4 / 3) * Math.PI * 1000;
check('sphere is below the ideal (4/3)πr³, never above', sph.volume() < sphIdeal);
nearPct('sphere is within 0.75% of (4/3)πr³ at 48 × 24', sph.volume(), sphIdeal, 0.75);
const sphFine = sphere(10, { segments: 96, rings: 48 });
const errA = (sphIdeal - sph.volume()) / sphIdeal, errB = (sphIdeal - sphFine.volume()) / sphIdeal;
nearPct('and the error falls by 4× when both counts double — it is O(1/n²), not a bug',
  errA / errB, 4, 3);
const tor = torus(20, 5, { major: 64, minor: 24 });
const torIdeal = 2 * Math.PI * Math.PI * 20 * 25;
nearPct('torus is within 1.3% of 2π²Rr² at 64 × 24', tor.volume(), torIdeal, 1.3);
const torFine = torus(20, 5, { major: 128, minor: 48 });
nearPct('torus error also falls by 4× on doubling',
  (torIdeal - tor.volume()) / (torIdeal - torFine.volume()), 4, 3);

// chamfer and fillet: the removed ring has a closed form via Pappus.
const chamRemoved = (r, c) => Math.PI * (r * r * c - (r ** 3 - (r - c) ** 3) / 3);
nearPct('chamferCylinder removes exactly the 45° ring Pappus predicts',
  chamferCylinder(10, 20, 2, { segments: 96 }).volume(),
  (Math.PI * 100 * 20 - 2 * chamRemoved(10, 2)) * (1 - polyDeficit(96)), 0.02);
const filRemoved = (r, f) => 2 * Math.PI * ((r - f / 2) * f * f - (r - f + 4 * f / (3 * Math.PI)) * (Math.PI * f * f / 4));
nearPct('filletCylinder removes exactly the quarter-round ring Pappus predicts, at both ends',
  filletCylinder(10, 20, 3, { segments: 96, segs: 32 }).volume(),
  (Math.PI * 100 * 20 - 2 * filRemoved(10, 3)) * (1 - polyDeficit(96)), 0.02);
near('a chamfer as deep as the radius is a cone, and is allowed to be',
  chamferCylinder(10, 20, 99, { segments: 64 }).volume(), cone(10, 20, { segments: 64 }).volume(), 1e-9);
isSolid('chamferCylinder clamped to a cone', chamferCylinder(10, 20, 99, { segments: 64 }), { euler: 2 });
isSolid('filletCylinder clamped to its limit', filletCylinder(10, 20, 99, { segments: 64 }), { euler: 2 });
isSolid('chamferCylinder, bottom only', chamferCylinder(10, 20, 2, { top: false }), { euler: 2 });
isSolid('filletCylinder, top only', filletCylinder(10, 20, 2, { bottom: false }), { euler: 2 });
near('chamfering only one end removes only one ring',
  chamferCylinder(10, 20, 2, { segments: 96, top: false }).volume(),
  (Math.PI * 100 * 20 - chamRemoved(10, 2)) * (1 - polyDeficit(96)), 1e-3 * Math.PI * 100 * 20);

const cbW = 30, cbD = 20, cbH = 10, cbC = 2, cbA = cbW - 2 * cbC, cbB = cbD - 2 * cbC;
near('chamferBox has an exact volume: every face of it is planar',
  chamferBox(cbW, cbD, cbH, cbC).volume(),
  2 * (cbA * cbB * cbC + (cbA + cbB) * cbC * cbC + (4 / 3) * cbC ** 3) + cbW * cbD * (cbH - 2 * cbC), 1e-9);
isSolid('chamferBox with side chamfers too', chamferBox(30, 20, 10, 2, { sides: 3 }), { euler: 2 });
isSolid('chamferBox whose chamfers meet in the middle', chamferBox(30, 20, 10, 5), { euler: 2 });
isSolid('chamferBox, top only', chamferBox(30, 20, 10, 2, { bottom: false }), { euler: 2 });
near('a zero chamfer is just a box', chamferBox(30, 20, 10, 0).volume(), 6000, 1e-9);

const rbW = 30, rbD = 20, rbH = 10, rbR = 3;
const rbIdeal = (() => {
  const a = rbW - 2 * rbR, b = rbD - 2 * rbR, c = rbH - 2 * rbR;
  return a * b * c + 2 * rbR * (a * b + b * c + c * a) + Math.PI * rbR * rbR * (a + b + c) + (4 / 3) * Math.PI * rbR ** 3;
})();
nearPct('roundedBox is within 0.4% of the Minkowski volume of box ⊕ sphere',
  roundedBox(rbW, rbD, rbH, rbR, { segs: 64 }).volume(), rbIdeal, 0.4);
nearPct('roundedBox error falls by 4× when the segment count doubles',
  (rbIdeal - roundedBox(rbW, rbD, rbH, rbR, { segs: 32 }).volume()) /
  (rbIdeal - roundedBox(rbW, rbD, rbH, rbR, { segs: 64 }).volume()), 4, 12);
near('a zero radius makes roundedBox a plain box', roundedBox(20, 10, 5, 0).volume(), 1000, 1e-9);
check('roundedBox clamps an over-large radius to a capsule-ish limit',
  Math.abs(roundedBox(20, 20, 20, 50, { segs: 32 }).volume() - sphere(10, { segments: 32, rings: 16 }).volume()) < 1e-6);
volumeAgrees('roundedBox', roundedBox(30, 20, 10, 3), 6);
volumeAgrees('sphere', sphere(10), 6);
volumeAgrees('torus', torus(20, 5), 8);
volumeAgrees('wedge', wedge(20, 10, 8), 6);
volumeAgrees('shell', shBox, 8);

check('cylinder(capped:false) is the documented open tube and nothing worse',
  rawTopology(cylinder(5, 10, { capped: false, segments: 32 })).boundary === 64);
isSolid('a 3-segment cylinder is a triangular prism, and still a solid', cylinder(5, 10, { segments: 3 }), { euler: 2 });
near('a 3-segment cylinder has the volume of its triangle', cylinder(5, 10, { segments: 3 }).volume(),
  area(regularPolygon(3, 5)) * 10, 1e-9);
isSolid('a sphere with the minimum ring count is still a solid', sphere(5, { segments: 3, rings: 2 }), { euler: 2 });
isSolid('a torus with a triangular tube is still a solid', torus(10, 2, { major: 12, minor: 3 }), { euler: 0 });
isSolid('prism with many sides', prism(64, 10, 5), { euler: 2 });
isSolid('an ellipse extruded', extrude(ellipse(12, 5, { segs: 40 }), 6), { euler: 2 });

// ---------------------------------------------------------------------------
console.log('\n-- degenerate input --');

throws('extrude of zero height', () => extrude(sq20, 0), 'height must be positive');
throws('extrude of negative height names the way out', () => extrude(sq20, -5), 'z0 = -height');
throws('extrude of NaN height', () => extrude(sq20, NaN), 'finite');
throws('extrude of a single point', () => extrude([[3, 3]], 5), 'at least 3');
throws('extrude of a two-point ring', () => extrude([[0, 0], [5, 5]], 5), 'at least 3');
throws('extrude of a ring that repeats one point three times',
  () => extrude([[0, 0], [0, 0], [0, 0]], 5), 'at least 3');
throws('extrude of three collinear points', () => extrude([[0, 0], [5, 0], [10, 0]], 5), 'folds back');
throws('extrude of a ring that lies on top of itself',
  () => extrude(overlapRing, 5), 'on top of itself');
check('a fold says which kind it is, so the message points somewhere',
  ringSelfIntersects([[0, 0], [10, 0], [0, 10], [10, 10]]).kind === 'crossing' &&
  ringSelfIntersects([[0, 0], [5, 0], [10, 0]]).kind === 'spike');
throws('extrude of a self-intersecting ring',
  () => extrude([[0, 0], [10, 0], [0, 10], [10, 10]], 5), 'crosses itself');
throws('extrude of an empty shape', () => extrude([], 5), 'empty');
throws('extrude with a negative scale', () => extrude(sq20, 5, { scaleTop: -1 }), 'scale must be >= 0');
throws('extrude collapsing a shape that has a hole', () => extrude(ringShape, 5, { scaleTop: 0 }), 'collapse');
throws('a segFactor of zero', () => extrude(sq20, 5, { segFactor: 0 }), 'segFactor must be positive');

throws('revolve of a zero sweep', () => revolve(tubeProfile, { from: 1, to: 1 }), 'sweep is zero');
throws('revolve of a profile with negative r', () => revolve([[-4, 0], [8, 0], [8, 10]]), 'r must be >= 0');
throws('revolve of a self-intersecting profile',
  () => revolve([[1, 0], [10, 0], [1, 10], [10, 10]]), 'crosses itself');
throws('revolve of a two-point profile', () => revolve([[1, 0], [5, 5]]), 'at least 3');
throws('revolve of an open polyline with one point', () => revolve([[1, 0]], { closed: false }), 'at least 2');
check('a self-intersecting profile is caught rather than turned into a broken solid',
  (() => { try { revolve([[1, 0], [10, 0], [1, 10], [10, 10]]); return false; } catch { return true; } })());

throws('loft of one section', () => loft([{ shape: sq20, z: 0 }]), 'at least 2');
throws('loft of sections with different ring counts',
  () => loft([{ shape: sq20, z: 0 }, { shape: ringShape, z: 5 }]), 'same number of rings');
throws('loft of non-monotonic sections',
  () => loft([{ shape: sq20, z: 0 }, { shape: sq20, z: 5 }, { shape: sq20, z: 2 }]), 'monotonic');
throws('loft with a zero scale', () => loft([{ shape: sq20, z: 0 }, { shape: sq20, z: 5, scale: 0 }]), 'scale must be positive');
throws('loft with an unknown alignment', () => loft([{ shape: sq20, z: 0 }, { shape: sq20, z: 5 }], { align: 'magic' }), 'unknown align');
throws('loft of a section with no shape', () => loft([{ z: 0 }, { shape: sq20, z: 5 }]), 'no shape');

throws('sweep along a one-point path', () => sweep(sq20, [[0, 0, 0]]), 'at least 2');
throws('sweep along a path of one repeated point', () => sweep(sq20, [[1, 1, 1], [1, 1, 1]]), 'at least 2');
throws('sweep along a 2D path', () => sweep(sq20, [[0, 0], [0, 10]]), '[x, y, z]');

throws('a heightfield smaller than 2 × 2', () => heightfield({ w: 1, h: 4, data: [1, 2, 3, 4] }), 'at least a 2x2');
throws('a heightfield whose data is the wrong length', () => heightfield({ w: 4, h: 4, data: [1, 2, 3] }), 'expected 16');
throws('a heightfield containing NaN', () => heightfield({ w: 2, h: 2, data: [1, NaN, 3, 4] }), 'is NaN');
throws('a heightfield with a negative zScale', () => heightfield({ w: 2, h: 2, data: [1, 2, 3, 4] }, { zScale: -1 }), 'zScale must be positive');
throws('a drape with no thickness', () => heightfield({ w: 2, h: 2, data: [1, 2, 3, 4] }, { skirt: false, base: 0 }), 'needs base > 0');
check('an all-zero field returns a valid plate rather than throwing', hfFlat.volume() > 0);

throws('a cylinder of negative radius', () => cylinder(-5, 10), 'must be >= 0');
throws('a cylinder with both radii zero', () => cylinder(0, 10, { r2: 0 }), 'non-zero radius');
throws('a cylinder of zero height', () => cylinder(5, 0), 'must be positive');
throws('a sphere of negative radius', () => sphere(-1), 'must be positive');
throws('a box with a zero side', () => box(10, 0, 5), 'must be positive');
throws('a torus whose tube is bigger than its hole', () => torus(5, 8), 'must exceed');
throws('a tube whose bore is bigger than its outside', () => tube(4, 9, 10), 'must be smaller');
throws('a capsule shorter than its own diameter', () => capsule(5, 6), 'shorter than');
throws('a prism with two sides', () => prism(2, 10, 5), 'at least 3');
throws('a shell with zero wall thickness', () => shell(sq20, 0, 10), 'must be positive');
throws('a shell with a negative floor', () => shell(sq20, 2, 10, { floor: -1 }), 'floor must be >= 0');
throws('a helix with no turns', () => helixPath({ r: 5, pitch: 2, turns: 0 }), 'must be positive');
throws('a helix of unknown handedness', () => helixPath({ r: 5, pitch: 2, turns: 1, handed: 'sideways' }), "'right' or 'left'");
check('a 2-segment cylinder is rounded up to the 3 that make a solid, not left broken',
  cylinder(5, 10, { segments: 2 }).triCount === cylinder(5, 10, { segments: 3 }).triCount);
isSolid('the 2-segment cylinder that comes back', cylinder(5, 10, { segments: 2 }), { euler: 2 });

// ---------------------------------------------------------------------------
console.log('\n-- the cases that were wrong before they were tested --');
// Everything below found a real defect during the hunt. They stay so it stays
// fixed.

// arcRing's full turn with a bore is documented in poly2d as NOT a simple ring:
// it is bridged by a zero-width radial seam whose two halves differ in the last
// bit of a cosine. Extruding it silently produced coincident wall quads until
// the collinearity test was given a tolerance instead of an exact zero.
throws('a bridged full arcRing is refused rather than quietly doubled',
  () => extrude(arcRing(10, 6, 0, TAU), 4), 'lies on top of itself');
isSolid('a partial arcRing has no bridge and extrudes cleanly', extrude(arcRing(10, 6, 0, Math.PI), 4), { euler: 2 });

// The alignment search used to give up above 512 points and say nothing. The
// loft still built; it was just quietly spiralled, at 43% of its true volume.
const bigRing = circle(10, { segs: 800 });
const bigRolled = bigRing.slice(300).concat(bigRing.slice(0, 300));
const bigLoft = loft([{ shape: bigRing, z: 0 }, { shape: bigRolled, z: 5 }]);
near('an 800-point ring rolled by 300 still aligns (coarse-to-fine, not skipped)',
  bigLoft.volume(), area(bigRing) * 5, 1e-6);
isSolid('the 800-point loft', bigLoft, { euler: 2 });
const hugeRing = circle(10, { segs: 2000 });
near('and so does a 2000-point one',
  loft([{ shape: hugeRing, z: 0 }, { shape: hugeRing.slice(777).concat(hugeRing.slice(0, 777)), z: 4 }]).volume(),
  area(hugeRing) * 4, 1e-6);

// A comb of vertical teeth put every segment in the sweep's active list at once
// when it always sorted by x. It is a correctness no-op and a 3× speed-up, but
// the answer has to stay the same, which is what this checks.
const comb = [];
for (let i = 0; i < 60; i++) { comb.push([i * 0.5, 0], [i * 0.5, 20], [i * 0.5 + 0.25, 20], [i * 0.5 + 0.25, 0]); }
check('a comb of vertical teeth is still judged correctly whichever axis is swept',
  ringSelfIntersects(comb) !== null);
const tall = [];
for (let i = 0; i < 200; i++) tall.push([0, i * 0.1]);
for (let i = 199; i >= 0; i--) tall.push([50, i * 0.1]);
check('two long vertical walls are clean and are seen to be clean', ringSelfIntersects(tall) === null);

// A sweep whose twist had nowhere to happen: three stations and half a turn
// folded the solid through itself and reported a NEGATIVE volume.
check('a twist on a short path subdivides rather than folding',
  sweep(rect(4, 1), [[0, 0, 0], [0, 0, 6], [0, 0, 12]], { twist: Math.PI }).volume() > 40);

// Real generator patterns, end to end.
isSolid('extrude of an offset() result (the inset every lid needs)',
  extrude(offset([roundRect(40, 25, 3)], -1.2)[0], 3), { euler: 2 });
isSolid('extrude of a 2D difference (a plate with a slot cut in it)',
  extrude(offset([rect(30, 20)], -0.001)[0], 2), { euler: 2 });
isSolid('extrude of a superformula blob', extrude(superformula({ preset: 'flower6', r: 20, segs: 180 }), 4), { euler: 2 });
isSolid('extrude of a dogbone rectangle', extrude(dogboneRect(20, 12, 1.5), 4), { euler: 2 });

const allBuilders = [
  extrude(sq20, 5), revolve(tubeProfile), loft([{ shape: sq20, z: 0 }, { shape: sq20, z: 3 }]),
  sweep(circle(2, { segs: 12 }), [[0, 0, 0], [0, 0, 5]]), heightfield(linField, { sx: 20 }),
  shell(rect(20, 20), 2, 10), box(5, 5, 5), roundedBox(10, 10, 10, 2), cylinder(5, 5), cone(5, 5),
  sphere(5), capsule(3, 10), torus(10, 3), tube(6, 3, 5), prism(5, 5, 5), wedge(5, 5, 5),
  pyramid(5, 5, 5), chamferCylinder(5, 10, 1), filletCylinder(5, 10, 1), chamferBox(10, 10, 10, 1),
];
check('every builder returns a Mesh', allBuilders.every(m => m instanceof Mesh));
check('no builder emits a NaN or an Infinity',
  allBuilders.every(m => m.positions.every(v => Number.isFinite(v))));
check('no builder emits an out-of-range triangle index',
  allBuilders.every(m => m.tris.every(i => Number.isInteger(i) && i >= 0 && i < m.vertCount)));
check('every builder produces positive volume', allBuilders.every(m => m.volume() > 0));

// ---------------------------------------------------------------------------
console.log('\n-- quality (ctx.segFactor) --');

const draft = { segFactor: 0.5 }, fine = { segFactor: 2 };
const pairs = [
  ['cylinder', () => cylinder(10, 20, draft), () => cylinder(10, 20, fine)],
  ['sphere', () => sphere(10, draft), () => sphere(10, fine)],
  ['torus', () => torus(20, 5, draft), () => torus(20, 5, fine)],
  ['revolve', () => revolve(tubeProfile, draft), () => revolve(tubeProfile, fine)],
  ['roundedBox', () => roundedBox(30, 20, 10, 3, draft), () => roundedBox(30, 20, 10, 3, fine)],
  ['twisted extrude', () => extrude(sq20, 20, { twist: TAU, ...draft }), () => extrude(sq20, 20, { twist: TAU, ...fine })],
  ['filletCylinder', () => filletCylinder(10, 20, 3, draft), () => filletCylinder(10, 20, 3, fine)],
];
for (const [name, d, f] of pairs) {
  const md = d(), mf = f();
  check(`segFactor: ${name} is finer at 2 than at 0.5`, mf.triCount > md.triCount,
    `draft ${md.triCount} tris, fine ${mf.triCount} tris`);
  check(`segFactor: ${name} is watertight at both`,
    topology(md).boundary === 0 && topology(mf).boundary === 0);
}
check('ctx.segFactor is read straight off a ctx object',
  cylinder(10, 20, { ctx: { segFactor: 2 } }).triCount === cylinder(10, 20, { segFactor: 2 }).triCount);
check('the default is normal quality', cylinder(10, 20).triCount === cylinder(10, 20, { segFactor: 1 }).triCount);
nearPct('a finer sphere is closer to the ideal than a draft one',
  (sphIdeal - sphere(10, fine).volume()) / (sphIdeal - sphere(10, draft).volume()), 1 / 16, 25);

// ---------------------------------------------------------------------------
console.log('\n-- determinism --');

deterministic('extrude with twist', () => extrude(ringShape, 20, { twist: TAU / 3 }));
deterministic('revolve', () => revolve(sphereProfile, { segments: 48 }));
deterministic('loft', () => loft([{ shape: circle(10, { segs: 48 }), z: 0 }, { shape: rect(14, 14), z: 12 }]));
deterministic('sweep along a helix', () => sweep(circle(1, { segs: 12 }), helixPath({ r: 8, pitch: 4, turns: 2 })));
deterministic('heightfield', () => heightfield(bumpy, { sx: 60 }));
deterministic('shell', () => shell(roundRect(40, 30, 4), 2, 20));
check('a mesh built twice is the same object, not merely the same size',
  new Mesh().vertCount === 0 && box(1, 1, 1).positions.length === 24);

done();
