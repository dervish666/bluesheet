// Tests for js/kernel/validate.js.
//
// Three jobs: prove the validator finds real defects (built here on purpose),
// prove it stays quiet on good geometry, and prove its numbers agree with the
// independently written topology checker in tests/lib/meshcheck.mjs. Where the
// two disagree one of them is wrong, and that is exactly what the last section
// is for.

import { suite, check, near, nearPct, nearVec, throws, done } from './lib/assert.mjs';
import { topology, isSolid, onPlate, centredXY, volumeAgrees } from './lib/meshcheck.mjs';
import * as fx from './lib/fixtures.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import {
  WELD_EPS, FILAMENT_DENSITY, analyze, printability, buildEdgeMap, shellsOf,
  boundaryLoops, orientationCheck, overhangAngleDeg, faceOverhangs, triGrid,
  rayMeshHit, triTriIntersect, selfIntersect, wallThickness, estimateFilament,
  worstSeverity, formatReport,
} from '../js/kernel/validate.js';

suite('validate');
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// meshes built by hand here, so a test never leans on the module it is testing
// ---------------------------------------------------------------------------

/** Axis-aligned box, centred in X/Y, sitting on z = 0. */
function box(w, d, h, { z0 = 0, cx = 0, cy = 0 } = {}) {
  const m = new Mesh();
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]]
    .map((p) => m.addVertex(p[0] - w / 2 + cx, p[1] - d / 2 + cy, p[2] + z0));
  for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) m.addQuad(...q.map((i) => v[i]));
  return m;
}

/** Cone standing on its apex: every lateral face overhangs by atan(h/r) from vertical. */
function invertedCone(r = 10, h = 10, seg = 128) {
  const m = new Mesh();
  const apex = m.addVertex(0, 0, 0);
  const ring = [];
  for (let i = 0; i < seg; i++) { const a = i / seg * TAU; ring.push(m.addVertex(Math.cos(a) * r, Math.sin(a) * r, h)); }
  const cap = m.addVertex(0, 0, h);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    m.addTri(apex, ring[j], ring[i]);
    m.addTri(cap, ring[i], ring[j]);
  }
  return m;
}

/** Solid of revolution from a [r, z] profile; r === 0 makes a pole. */
function revolve(profile, seg = 64) {
  const m = new Mesh();
  const rings = profile.map(([r, z]) => {
    if (r <= 1e-9) return [m.addVertex(0, 0, z)];
    const ring = [];
    for (let i = 0; i < seg; i++) { const a = i / seg * TAU; ring.push(m.addVertex(Math.cos(a) * r, Math.sin(a) * r, z)); }
    return ring;
  });
  for (let k = 0; k + 1 < rings.length; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      if (A.length === 1) m.addTri(A[0], B[j], B[i]);
      else if (B.length === 1) m.addTri(B[0], A[i], A[j]);
      else m.addQuad(A[i], A[j], B[j], B[i]);
    }
  }
  return m;
}

/** Prism from an explicit polygon in (x, z) plus its triangulation, extruded along y. */
function prism(pts, tris, depth) {
  const m = new Mesh();
  const n = pts.length;
  const front = pts.map((p) => m.addVertex(p[0], 0, p[1]));
  const back = pts.map((p) => m.addVertex(p[0], depth, p[1]));
  for (let i = 0; i < tris.length; i += 3) m.addTri(front[tris[i]], front[tris[i + 1]], front[tris[i + 2]]);
  for (let i = 0; i < tris.length; i += 3) m.addTri(back[tris[i]], back[tris[i + 2]], back[tris[i + 1]]);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.addQuad(front[i], back[i], back[j], front[j]); }
  return m;
}

/** A square box with a square hole straight through it — the shape a CSG difference makes. */
function holedBox(W = 30, w = 10, h = 12) {
  const m = new Mesh();
  const ring = (r, z) => [[-r, -r], [r, -r], [r, r], [-r, r]].map((p) => m.addVertex(p[0], p[1], z));
  const ob = ring(W / 2, 0), ot = ring(W / 2, h), ib = ring(w / 2, 0), it = ring(w / 2, h);
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    m.addQuad(ob[k], ob[j], ot[j], ot[k]);        // outside wall
    m.addQuad(ib[k], it[k], it[j], ib[j]);        // bore wall (faces into the hole)
    m.addQuad(ob[k], ib[k], ib[j], ob[j]);        // bottom annulus, normal -Z
    m.addQuad(ot[k], ot[j], it[j], it[k]);        // top annulus, normal +Z
  }
  return m;
}

/** Two tetrahedra joined at exactly one vertex: edge-manifold, but pinched. */
function bowtie() { return Mesh.merge([fx.tetra(10), fx.tetra(10).scale(-1, -1, -1)]).weld(1e-6); }

const arch = prism([[0, 0], [10, 0], [10, 10], [30, 10], [30, 0], [40, 0], [40, 20], [0, 20]],
                   [0, 1, 2, 0, 2, 7, 7, 2, 3, 7, 3, 6, 6, 3, 4, 6, 4, 5], 10).centerXY();
const vase = revolve([[0, 0], [12, 0], [11, 4], [7, 18], [10, 34], [9, 36], [0, 36]]);
const cone45 = invertedCone(10, 10, 128);
const plate06 = box(20, 20, 0.6);
const wall06 = box(20, 0.6, 15);
const floater = Mesh.merge([box(20, 20, 10), box(10, 10, 10, { z0: 15, cx: 4 })]);

// The real CSG module is another leaf's file and may not exist yet; when it does
// and it works, test against its output, otherwise against the same topology
// built by hand. Either way this section is about validate.js not crying wolf on
// boolean-shaped geometry.
let csgMesh = holedBox(), csgSource = 'hand-built through-holed box';
try {
  const csg = await import('../js/kernel/csg.js');
  if (csg && typeof csg.subtract === 'function') {
    const cut = csg.subtract(box(30, 30, 12), box(10, 10, 40, { z0: -14 }));
    if (cut && cut.triCount > 0 && cut.volume() > 0 && analyze(cut).manifold) {
      csgMesh = cut; csgSource = 'csg.subtract()';
    } else csgSource = 'hand-built (csg.subtract() output was not yet manifold)';
  }
} catch { csgSource = 'hand-built (js/kernel/csg.js not present yet)'; }

const heightfield = fx.heightfieldSolid(32, 40);

// ---------------------------------------------------------------------------
// 1. good geometry comes back clean
// ---------------------------------------------------------------------------
console.log('\n-- good geometry --');
const good = {
  cube: fx.cube(10),
  tetra: fx.tetra(10),
  icosphere: fx.icosphere(10, 3),
  torus: fx.torus(10, 3),
  cylinder: fx.cylinder(5, 10),
  heightfield,
  vase,
  arch,
  csg: csgMesh,
};
console.log(`   (CSG sample: ${csgSource}; heightfield ${heightfield.triCount} triangles)`);
for (const [name, m] of Object.entries(good)) {
  const a = analyze(m, { selfIntersect: true });
  check(`${name}: manifold and watertight`, a.manifold && a.watertight && a.boundaryEdges === 0,
    `manifold=${a.manifold} boundary=${a.boundaryEdges} nonManifold=${a.nonManifoldEdges} flipped=${a.flippedTris} bowties=${a.nonManifoldVertices}`);
  check(`${name}: nothing above 'info' to say about it`, worstSeverity(a.warnings) === 'info',
    `${a.warnings.map((w) => `${w.severity}:${w.code}`).join(' ') || 'no warnings'}`);
  check(`${name}: no self-intersections`, a.selfIntersections === 0, `${a.selfIntersections} pairs`);
  check(`${name}: solid (positive volume, outward normals)`, a.solid === true && a.volume > 0, `volume ${a.volume.toFixed(2)} mm³`);
}
near('cube volume', analyze(good.cube).volume, 1000, 1e-9);
near('cube area', analyze(good.cube).area, 600, 1e-9);
nearVec('cube bbox size', analyze(good.cube).bbox.size, [10, 10, 10], 1e-9);
check('cube vert/tri counts pass through untouched', analyze(good.cube).vertCount === 8 && analyze(good.cube).triCount === 12,
  `${analyze(good.cube).vertCount}v ${analyze(good.cube).triCount}t`);
nearPct('icosphere volume ~ 4/3 pi r³', analyze(good.icosphere).volume, 4 / 3 * Math.PI * 1000, 1);
// A 48 x 24 faceted torus is 1.4 % under the smooth formula, which is the
// inscribed-polygon area ratio and not a defect: (n/2)sin(2pi/n)/pi per axis.
nearPct('torus volume ~ 2 pi² R r² (allowing for faceting)', analyze(good.torus).volume, 2 * Math.PI ** 2 * 10 * 9, 2);
check('torus is genus 1 (Euler 0)', analyze(good.torus).eulerChar === 0 && analyze(good.torus).genus === 1,
  `euler ${analyze(good.torus).eulerChar}, genus ${analyze(good.torus).genus}`);
check('sphere is genus 0 (Euler 2)', analyze(good.icosphere).eulerChar === 2 && analyze(good.icosphere).genus === 0);
check('CSG-shaped solid is genus 1 (Euler 0)', analyze(good.csg).eulerChar === 0 && analyze(good.csg).genus === 1,
  `${csgSource}: euler ${analyze(good.csg).eulerChar}`);
check('selfIntersections is null when not asked for', analyze(good.cube).selfIntersections === null,
  `${analyze(good.cube).selfIntersections}`);
isSolid('hand-built vase', vase, { euler: 2 });
isSolid('hand-built arch', arch, { euler: 2 });
isSolid('hand-built holed box', holedBox(), { euler: 0 });
volumeAgrees('vase', vase, 6, 3000);
onPlate('arch', arch);
centredXY('arch', arch);

// ---------------------------------------------------------------------------
// 2. defects, each one constructed on purpose
// ---------------------------------------------------------------------------
console.log('\n-- constructed defects --');
const openA = analyze(fx.openCube(10));
check('open cube: not watertight', openA.watertight === false && openA.manifold === false);
check('open cube: 3 boundary edges', openA.boundaryEdges === 3, `${openA.boundaryEdges}`);
check('open cube: one hole', openA.holes === 1, `${openA.holes}`);
near('open cube: rim length', openA.boundaryLength, 20 + Math.hypot(10, 10), 1e-9);
check('open cube: BOUNDARY_EDGES raised as an error', openA.warnings.some((w) => w.code === 'BOUNDARY_EDGES' && w.severity === 'error'));
check('open cube: the message says how many holes and how long the rim is',
  /1 hole with 34\.1 mm of rim/.test(openA.warnings.find((w) => w.code === 'BOUNDARY_EDGES').message),
  openA.warnings.find((w) => w.code === 'BOUNDARY_EDGES').message.slice(0, 96) + '…');

const flipA = analyze(fx.flippedFaceCube(10));
check('reversed triangle: exactly 1 flipped triangle, not 3 edges worth', flipA.flippedTris === 1, `${flipA.flippedTris}`);
check('reversed triangle: 3 inconsistent edges', flipA.inconsistentEdges === 3, `${flipA.inconsistentEdges}`);
check('reversed triangle: not manifold, still watertight', flipA.manifold === false && flipA.watertight === true);
check('reversed triangle: FLIPPED_TRIS raised as an error', flipA.warnings.some((w) => w.code === 'FLIPPED_TRIS' && w.severity === 'error'));

const nmA = analyze(fx.nonManifoldPair(10));
check('two cubes fused on a face: 4 non-manifold edges', nmA.nonManifoldEdges === 4, `${nmA.nonManifoldEdges}`);
check('two cubes fused on a face: not manifold', nmA.manifold === false);
check('two cubes fused on a face: NON_MANIFOLD_EDGE error names the fan-out',
  /shared by 3 or more triangles \(one is used by 4\)/.test(nmA.warnings.find((w) => w.code === 'NON_MANIFOLD_EDGE').message));
check('two cubes fused on a face: still one shell', nmA.shells === 1, `${nmA.shells}`);

const invA = analyze(fx.insideOutCube(10));
check('inside-out cube: negative volume', invA.volume < 0, `${invA.volume.toFixed(1)} mm³`);
check('inside-out cube: reported as inverted, not as 12 flipped triangles',
  invA.inverted === true && invA.flippedTris === 0, `inverted=${invA.inverted} flipped=${invA.flippedTris}`);
check('inside-out cube: INVERTED raised as an error', invA.warnings.some((w) => w.code === 'INVERTED' && w.severity === 'error'));
check('inside-out cube: solid=false even though the surface is manifold',
  invA.solid === false && invA.manifold === true, `solid=${invA.solid} manifold=${invA.manifold}`);

const twoA = analyze(fx.twoShells(10, 30));
check('two disjoint cubes: 2 shells', twoA.shells === 2, `${twoA.shells}`);
check('two disjoint cubes: Euler 4 (2 per shell)', twoA.eulerChar === 4, `${twoA.eulerChar}`);
check('two disjoint cubes: SHELLS mentioned, at info level', twoA.warnings.some((w) => w.code === 'SHELLS' && w.severity === 'info'));
check('two disjoint cubes: each shell listed with its own volume',
  twoA.shellInfo.length === 2 && twoA.shellInfo.every((s) => Math.abs(s.volume - 1000) < 1e-6),
  twoA.shellInfo.map((s) => s.volume.toFixed(1)).join(', '));

const degA = analyze(fx.degenerateCube(10));
check('degenerate triangle counted', degA.degenerateTris === 1, `${degA.degenerateTris}`);
check('degenerate triangle: DEGENERATE_TRIS warned', degA.warnings.some((w) => w.code === 'DEGENERATE_TRIS' && w.severity === 'warn'));
check('the vertex it left behind is reported as unused', degA.unreferencedVerts === 1, `${degA.unreferencedVerts}`);

const bowA = analyze(bowtie());
check('bowtie: 1 pinched vertex found by the link test', bowA.nonManifoldVertices === 1, `${bowA.nonManifoldVertices}`);
check('bowtie: not manifold, though every edge has exactly 2 faces',
  bowA.manifold === false && bowA.boundaryEdges === 0 && bowA.nonManifoldEdges === 0);
check('bowtie: NON_MANIFOLD_VERTEX warned', bowA.warnings.some((w) => w.code === 'NON_MANIFOLD_VERTEX'));

const emptyA = analyze(new Mesh());
check('empty mesh: EMPTY error, no crash', emptyA.triCount === 0 && emptyA.warnings[0].code === 'EMPTY' && emptyA.warnings[0].severity === 'error');
const badIdx = new Mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 9]);
const badA = analyze(badIdx);
check('index out of range: BAD_INDEX error instead of nonsense numbers',
  badA.warnings[0].code === 'BAD_INDEX', badA.warnings[0].message.slice(0, 80));
const nanMesh = fx.cube(10); nanMesh.positions[0] = NaN;
check('NaN coordinate: NON_FINITE error', analyze(nanMesh).warnings.some((w) => w.code === 'NON_FINITE' && w.severity === 'error'));
throws('analyze rejects a non-mesh', () => analyze(42), 'expected a Mesh');
throws('analyze rejects null', () => analyze(null), 'null');

const crossed = Mesh.merge([fx.cube(10), fx.cube(10).rotateZ(0.6)]);
const crossA = analyze(crossed, { selfIntersect: true });
check('two interpenetrating cubes: self-intersections found', crossA.selfIntersections > 0, `${crossA.selfIntersections} pairs`);
check('two interpenetrating cubes: SELF_INTERSECTION error', crossA.warnings.some((w) => w.code === 'SELF_INTERSECTION' && w.severity === 'error'));

// ---------------------------------------------------------------------------
// 3. the helpers each entry point is built from
// ---------------------------------------------------------------------------
console.log('\n-- helpers --');
check('WELD_EPS matches the tolerance meshcheck welds at', WELD_EPS === 1e-5, `${WELD_EPS}`);
check('FILAMENT_DENSITY carries the four the plan names',
  FILAMENT_DENSITY.PLA === 1.24 && FILAMENT_DENSITY.PETG === 1.27 && FILAMENT_DENSITY.TPU === 1.21 && FILAMENT_DENSITY.ABS === 1.04,
  Object.entries(FILAMENT_DENSITY).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', '));

const em = buildEdgeMap(fx.cube(10));
check('buildEdgeMap: a cube has 18 edges, every one shared by 2 triangles',
  em.edgeCount === 18 && [...em.edges.values()].every((e) => e.count === 2),
  `${em.edgeCount} edges`);
check('buildEdgeMap: cube has no boundary, no fan-out, no inconsistency',
  em.boundaryEdges === 0 && em.nonManifoldEdges === 0 && em.inconsistentEdges === 0);
check('buildEdgeMap: open cube reports 3 single-use edges', buildEdgeMap(fx.openCube(10)).boundaryEdges === 3);
check('buildEdgeMap: fused cubes report the 4-triangle fan-out',
  buildEdgeMap(fx.nonManifoldPair(10)).maxFanning === 4, `${buildEdgeMap(fx.nonManifoldPair(10)).maxFanning}`);

const sh = shellsOf(fx.twoShells(10, 30));
check('shellsOf: 2 components', sh.count === 2, `${sh.count}`);
check('shellsOf: 12 triangles labelled into each', sh.shells.every((x) => x.tris === 12) && sh.labels.length === 24);
check('shellsOf: biggest shell first and labels follow the sort',
  shellsOf(Mesh.merge([fx.tetra(5), fx.cube(10).translate(40, 0, 0)])).shells[0].tris === 12,
  `${shellsOf(Mesh.merge([fx.tetra(5), fx.cube(10).translate(40, 0, 0)])).shells.map((x) => x.tris).join('/')}`);
check('shellsOf: one cube is one shell', shellsOf(fx.cube(10)).count === 1);

const or = orientationCheck(fx.flippedFaceCube(10));
check('orientationCheck: minimal edit distance is 1 triangle', or.flippedTris === 1, `${or.flippedTris}`);
check('orientationCheck: oriented volume comes out positive once that one is re-wound',
  or.orientedVolume > 0 && Math.abs(or.orientedVolume - 1000) < 1e-9, `${or.orientedVolume.toFixed(3)}`);
check('orientationCheck: an inside-out cube is inverted, not flipped',
  orientationCheck(fx.insideOutCube(10)).inverted === true && orientationCheck(fx.insideOutCube(10)).flippedTris === 0);
check('orientationCheck: a good cube is neither', orientationCheck(fx.cube(10)).flippedTris === 0 && orientationCheck(fx.cube(10)).inverted === false);
check('orientationCheck: nothing non-orientable in any fixture',
  [fx.cube(10), fx.torus(10, 3), fx.icosphere(8, 2), vase].every((m) => orientationCheck(m).nonOrientable === 0));

const loops = boundaryLoops(fx.openCube(10));
check('boundaryLoops: one closed loop of 3 vertices', loops.length === 1 && loops[0].closed && loops[0].verts.length === 3);
near('boundaryLoops: loop length', loops[0].length, 20 + Math.hypot(10, 10), 1e-9);
check('boundaryLoops: a closed mesh has none', boundaryLoops(fx.cube(10)).length === 0);
const cubeTris = fx.cube(10).tris;
const twoHoles = new Mesh(fx.cube(10).positions.slice(),
  cubeTris.filter((_, i) => Math.floor(i / 3) !== 0 && Math.floor(i / 3) !== 11));   // one triangle gone from each of two opposite faces
check('boundaryLoops: two separate holes are counted separately', boundaryLoops(twoHoles).length === 2,
  `${boundaryLoops(twoHoles).length} loops, ${buildEdgeMap(twoHoles).boundaryEdges} open edges`);

near('overhangAngleDeg: a flat ceiling is 90°', overhangAngleDeg([0, 0, -1]), 90, 1e-9);
near('overhangAngleDeg: a vertical wall is 0°', overhangAngleDeg([1, 0, 0]), 0, 1e-9);
near('overhangAngleDeg: 45° normal is 45°', overhangAngleDeg([Math.SQRT1_2, 0, -Math.SQRT1_2]), 45, 1e-9);
check('overhangAngleDeg: upward faces are not overhangs', overhangAngleDeg([0, 0, 1]) === 0 && overhangAngleDeg([0.3, 0.3, 0.9]) === 0);

const foCube = faceOverhangs(fx.cube(10).dropToPlate());
near('faceOverhangs: a cube on the plate has 100 mm² of first-layer area', foCube.plateArea, 100, 1e-9);
check('faceOverhangs: and no overhang at all', foCube.worst === 0 && foCube.overhangArea === 0, `worst ${foCube.worst}`);
near('faceOverhangs: total area is the whole surface', foCube.totalArea, 600, 1e-9);
const foCone = faceOverhangs(cone45);
check('faceOverhangs: the 45° cone knows which triangle is worst', foCone.worstTri >= 0 && foCone.angles[foCone.worstTri] === foCone.worst);

const grid = triGrid(fx.cube(10));
check('triGrid: indexes every triangle into at least one cell', grid.cells > 0 && grid.triCount === 12, `${grid.cells} cells`);
let found = 0;
grid.query([-6, -6, 4], [6, 6, 6], () => found++);
check('triGrid: a box query over the top face returns candidates, each once', found >= 2 && found <= 12, `${found} candidates`);
const hit = rayMeshHit(grid, [0, 0, 20], [0, 0, -1], { maxT: 100 });
near('rayMeshHit: hits the top face of a 10 mm cube from 20 mm up', hit.t, 15, 1e-9);
nearVec('rayMeshHit: and reports where', hit.point, [0, 0, 5], 1e-9);
check('rayMeshHit: misses when the ray goes past the mesh', rayMeshHit(grid, [20, 20, 20], [0, 0, -1], { maxT: 100 }) === null);
// Off the diagonal on purpose: (0,0) sits exactly on the shared edge of the two
// triangles making up the top face, so skipping one there still hits the other.
const hitOff = rayMeshHit(grid, [1, 2, 20], [0, 0, -1], { maxT: 100 });
check('rayMeshHit: skip excludes the source triangle, so the ray reaches the far side',
  Math.abs(rayMeshHit(grid, [1, 2, 20], [0, 0, -1], { maxT: 100, skip: hitOff.tri }).t - 25) < 1e-9,
  `${rayMeshHit(grid, [1, 2, 20], [0, 0, -1], { maxT: 100, skip: hitOff.tri }).t}`);
check('rayMeshHit: a sideways ray from inside leaves through the wall',
  Math.abs(rayMeshHit(grid, [0, 0, 0], [1, 0, 0], { maxT: 50 }).t - 5) < 1e-9);

check('triTriIntersect: two crossing triangles',
  triTriIntersect([-5, 0, 0], [5, 0, 0], [0, 0, 5], [0, -5, 1], [0, 5, 1], [0, 0, 4]) === true);
check('triTriIntersect: two that miss',
  triTriIntersect([-5, 0, 0], [5, 0, 0], [0, 0, 5], [0, -5, 40], [0, 5, 40], [0, 0, 44]) === false);
check('triTriIntersect: coplanar overlap is contact, not a crossing (off by default)',
  triTriIntersect([0, 0, 0], [10, 0, 0], [0, 10, 0], [1, 1, 0], [9, 1, 0], [1, 9, 0]) === false);
check('triTriIntersect: …and is reported when asked for',
  triTriIntersect([0, 0, 0], [10, 0, 0], [0, 10, 0], [1, 1, 0], [9, 1, 0], [1, 9, 0], { includeCoplanar: true }) === true);
check('triTriIntersect: a degenerate triangle cannot cross anything',
  triTriIntersect([-5, 0, 0], [5, 0, 0], [0, 0, 5], [0, 0, 0], [0, 0, 0], [0, 0, 0]) === false);
check('triTriIntersect: sharing an edge is not a crossing',
  triTriIntersect([0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 0], [10, 0, 0], [0, -10, 0]) === false);

const si = selfIntersect(crossed);
check('selfIntersect: finds the crossing cubes', si.count > 0 && si.pairs.length > 0, `${si.count} pairs, first ${si.pairs[0]}`);
check('selfIntersect: clean solids report zero',
  [fx.cube(10), fx.icosphere(10, 2), fx.torus(10, 3), heightfield, vase].every((m) => selfIntersect(m).count === 0));
check('selfIntersect: neighbours sharing a vertex are never counted',
  selfIntersect(fx.nonManifoldPair(10)).count === 0, `${selfIntersect(fx.nonManifoldPair(10)).count}`);
check('selfIntersect: says how much of the mesh it looked at',
  si.checkedTris === 24 && si.sampled === false, `checked ${si.checkedTris}/${si.totalTris}`);
check('selfIntersect: samples rather than going quadratic on a big mesh',
  selfIntersect(heightfield, { maxTris: 500 }).sampled === true);

const wt = wallThickness(plate06);
near('wallThickness: measures a 0.6 mm plate as 0.6 mm', wt.minThickness, 0.6, 2e-6);
check('wallThickness: both faces of the plate are one wall, not two findings',
  wt.clusters.length === 1 && wt.clusters[0].vertical === true, `${wt.clusters.length} clusters`);
near('wallThickness: thin surface area is both faces of a 20 × 20 plate', wt.thinArea, 800, 1e-6);
check('wallThickness: a 10 mm cube has nothing thin about it',
  wallThickness(fx.cube(10)).clusters.length === 0 && wallThickness(fx.cube(10)).thinArea === 0);
check('wallThickness: a 0.6 mm upright wall reads as a wall, not a slab',
  wallThickness(wall06).clusters[0].vertical === false);
check('wallThickness: measured every face of a small mesh', wallThickness(fx.cube(10)).measured === 12 && wallThickness(fx.cube(10)).sampled === false);

near('estimateFilament: 1 cm³ of PLA is 1.24 g', estimateFilament(1000).grams, 1.24, 1e-12);
near('estimateFilament: PETG is denser', estimateFilament(1000, { material: 'PETG' }).grams, 1.27, 1e-12);
near('estimateFilament: TPU', estimateFilament(1000, { material: 'tpu' }).grams, 1.21, 1e-12);
near('estimateFilament: ABS is the lightest of the four', estimateFilament(1000, { material: 'ABS' }).grams, 1.04, 1e-12);
near('estimateFilament: 1 cm³ is 41.6 cm of 1.75 mm filament', estimateFilament(1000).metres, 1000 / (Math.PI * 0.875 ** 2) / 1000, 1e-12);
check('estimateFilament: an unknown filament falls back to PLA and says so',
  estimateFilament(1000, { material: 'unobtainium' }).known === false && estimateFilament(1000, { material: 'unobtainium' }).density === 1.24);
check('estimateFilament: infill takes the walls off the top before scaling the core',
  estimateFilament(1000, { infill: 0.15, surfaceArea: 600, wallThickness: 0.8 }).grams < 1.24 &&
  estimateFilament(1000, { infill: 0.15, surfaceArea: 600, wallThickness: 0.8 }).grams > 0.15 * 1.24,
  `${estimateFilament(1000, { infill: 0.15, surfaceArea: 600, wallThickness: 0.8 }).grams.toFixed(3)} g`);
check('estimateFilament: negative volume cannot produce negative grams', estimateFilament(-500).grams === 0);

check('worstSeverity: picks the worst of a list',
  worstSeverity([{ severity: 'info' }, { severity: 'error' }, { severity: 'warn' }]) === 'error');
check('worstSeverity: none for an empty list, and it accepts a whole result',
  worstSeverity([]) === 'none' && worstSeverity(analyze(fx.cube(10))) === 'info');
const rep = formatReport(analyze(fx.openCube(10)), { title: 'openCube' });
check('formatReport: names the mesh, the counts and the codes',
  rep.includes('openCube') && rep.includes('BOUNDARY_EDGES') && rep.includes('NOT manifold'), rep.split('\n')[0]);
check('formatReport: handles a printability result too',
  formatReport(printability(fx.cube(10).dropToPlate())).includes('fits the bed'));
throws('formatReport rejects something that is not a result', () => formatReport({ nope: 1 }), 'expected an analyze');

// ---------------------------------------------------------------------------
// 4. printability, in the numbers the A1 mini works in
// ---------------------------------------------------------------------------
console.log('\n-- printability --');
const pCube = printability(fx.cube(10).dropToPlate());
check('printability returns every field the contract names',
  ['fitsBed', 'footprint', 'height', 'overhangArea', 'overhangPct', 'worstOverhangDeg', 'thinWallArea',
   'unsupportedIslands', 'estVolumeCm3', 'estGrams', 'warnings'].every((k) => k in pCube),
  Object.keys(pCube).length + ' fields');
check('10 mm cube fits the A1 mini', pCube.fitsBed === true);
nearPct('10 mm PLA cube weighs 1.24 g', pCube.estGrams, 1.24, 5);
near('10 mm cube is 1 cm³', pCube.estVolumeCm3, 1, 1e-9);
near('10 mm cube footprint is 10 × 10', pCube.footprint.x * pCube.footprint.y, 100, 1e-9);
near('10 mm cube puts 100 mm² on the plate', pCube.footprint.bedContact, 100, 1e-9);
near('10 mm cube is 10 mm tall', pCube.height, 10, 1e-9);
check('10 mm cube is 50 layers at 0.2 mm', pCube.layers === 50, `${pCube.layers}`);
check('a flat bottom is not an overhang', pCube.worstOverhangDeg === 0 && pCube.overhangArea === 0 && pCube.overhangPct === 0);
check('10 mm cube has nothing to warn about above info', worstSeverity(pCube.warnings) === 'info',
  pCube.warnings.map((w) => w.severity + ':' + w.code).join(' '));

const pBig = printability(fx.cube(200).dropToPlate());
check('200 mm cube does not fit', pBig.fitsBed === false);
check('…and the message says by how much, and what to do',
  /20\.0 mm too wide.*180 × 180 × 180 mm build volume\. Scale to 90 %/.test(pBig.warnings.find((w) => w.code === 'TOO_LARGE').message),
  pBig.warnings.find((w) => w.code === 'TOO_LARGE').message.slice(0, 110) + '…');
check('a 175 mm cube fits but is flagged as close to the limit',
  printability(fx.cube(175).dropToPlate()).fitsBed === true &&
  printability(fx.cube(175).dropToPlate()).warnings.some((w) => w.code === 'NEAR_BED_LIMIT'));
check('a custom bed is respected', printability(fx.cube(200).dropToPlate(), { bed: { x: 256, y: 256, z: 256 } }).fitsBed === true);

const pCone = printability(cone45);
near('a 45° cone reports its worst overhang as 45°', pCone.worstOverhangDeg, 45, 1);
check('…and 45° is inside the 50° default, so no support warning',
  pCone.overhangArea === 0 && pCone.warnings.some((w) => w.code === 'OVERHANG_OK'),
  `overhangArea ${pCone.overhangArea}`);
check('…but it is flagged for balancing on its point',
  pCone.warnings.some((w) => w.code === 'NO_BED_CONTACT' && w.severity === 'error'), `bed contact ${pCone.footprint.bedContact}`);
const steep = printability(invertedCone(10, 2, 128));
near('a shallow cone overhangs at atan(r/h)', steep.worstOverhangDeg, Math.atan(5) * 180 / Math.PI, 0.2);
check('…and that area is reported as at risk',
  steep.overhangArea > 300 && steep.overhangPct > 30 && steep.warnings.some((w) => w.code === 'OVERHANG' && w.severity === 'warn'),
  `${steep.overhangArea.toFixed(0)} mm², ${steep.overhangPct.toFixed(1)} %`);
check('the overhang threshold is an option',
  printability(cone45, { maxOverhang: 40 }).overhangArea > 0, `${printability(cone45, { maxOverhang: 40 }).overhangArea.toFixed(0)} mm²`);

const pPlate = printability(plate06);
near('a 0.6 mm plate reports 800 mm² of thin surface', pPlate.thinWallArea, 800, 1e-6);
near('…measured at 0.6 mm', pPlate.minThickness, 0.6, 2e-6);
check('…as one THIN_SLAB warning, with the layer count in it',
  pPlate.warnings.filter((w) => w.code === 'THIN_SLAB').length === 1 &&
  /0\.60 mm thick in Z — 3 layers at 0\.20 mm/.test(pPlate.warnings.find((w) => w.code === 'THIN_SLAB').message),
  pPlate.warnings.find((w) => w.code === 'THIN_SLAB').message.slice(0, 100) + '…');
const pWall = printability(wall06);
check('a 0.6 mm upright wall is the fragile case, and the message says why',
  /0\.60 mm thick — thinner than two 0\.4 mm extrusions \(0\.8 mm\)/.test(pWall.warnings.find((w) => w.code === 'THIN_WALL').message),
  pWall.warnings.find((w) => w.code === 'THIN_WALL').message.slice(0, 110) + '…');
check('minFeature is an option: at 0.5 mm the same wall passes',
  printability(wall06, { minFeature: 0.5 }).thinWallArea === 0);
check('a 10 mm cube has no thin walls', pCube.thinWallArea === 0 && pCube.minThickness === null);

const pFloat = printability(floater);
check('a block starting 5 mm above another is an unsupported island', pFloat.unsupportedIslands === 1, `${pFloat.unsupportedIslands}`);
near('…found at the right height', pFloat.islands[0].lowZ, 15, 1e-9);
near('…with its area measured', pFloat.islands[0].area, 100, 1e-9);
check('…and reported as an error that says how far the drop is',
  /starts in mid-air at z = 15\.0 mm — the nearest thing below it is 5\.0 mm down/.test(
    pFloat.warnings.find((w) => w.code === 'UNSUPPORTED_ISLAND').message),
  pFloat.warnings.find((w) => w.code === 'UNSUPPORTED_ISLAND').message.slice(0, 120) + '…');
const pArch = printability(arch);
check('an arch is a bridge, not an island', pArch.unsupportedIslands === 0 && pArch.bridges.length === 1,
  `${pArch.unsupportedIslands} islands, ${pArch.bridges.length} bridges`);
near('…spanning about 20 mm', pArch.maxBridgeSpan, 20, 3);
near('…measured at the right height', pArch.bridges[0].lowZ, 10, 1e-9);
check('a solid cube has neither islands nor bridges', pCube.unsupportedIslands === 0 && pCube.bridges.length === 0);
check('a long bridge is warned about, a short one is not',
  printability(arch, { bridgeLimit: 10 }).warnings.some((w) => w.code === 'LONG_BRIDGE' && w.severity === 'warn') &&
  pArch.warnings.some((w) => w.code === 'BRIDGE' && w.severity === 'info'));

check('filament choice changes the estimate',
  Math.abs(printability(fx.cube(10).dropToPlate(), { material: 'PETG' }).estGrams - 1.27) < 1e-9 &&
  printability(fx.cube(10).dropToPlate(), { material: 'TPU' }).material === 'TPU',
  `PETG ${printability(fx.cube(10).dropToPlate(), { material: 'PETG' }).estGrams.toFixed(3)} g`);
check('an unknown filament is called out rather than silently guessed',
  printability(fx.cube(10).dropToPlate(), { material: 'mystery' }).warnings.some((w) => w.code === 'UNKNOWN_FILAMENT'));
check('infill below 100 % lowers the estimate',
  printability(box(20, 20, 20), { infill: 0.15 }).estGrams < printability(box(20, 20, 20)).estGrams,
  `${printability(box(20, 20, 20), { infill: 0.15 }).estGrams.toFixed(2)} g vs ${printability(box(20, 20, 20)).estGrams.toFixed(2)} g`);
check('a model left floating above the plate is flagged',
  /floats 5\.00 mm above the plate/.test(printability(fx.cube(10).dropToPlate().translate(0, 0, 5)).warnings.find((w) => w.code === 'OFF_PLATE').message));
check('a model sunk into the plate is an error, not a warning',
  printability(fx.cube(10)).warnings.find((w) => w.code === 'OFF_PLATE').severity === 'error');
check('a tall thin tower is flagged for toppling',
  printability(box(5, 5, 60)).warnings.some((w) => w.code === 'TALL_AND_THIN'));
check('a wide flat part on a small foot is flagged for adhesion',
  printability(Mesh.merge([box(4, 4, 30), box(40, 40, 3, { z0: 30 })])).warnings.some((w) => w.code === 'BED_CONTACT'));
check('an empty mesh gives an error, not a crash', printability(new Mesh()).warnings[0].code === 'EMPTY');
check('an inside-out mesh is called out before its weight is believed',
  printability(fx.insideOutCube(10).dropToPlate()).warnings.some((w) => w.code === 'NOT_SOLID' && w.severity === 'error'));
check('printability is deterministic',
  JSON.stringify(printability(vase.dropToPlate())) === JSON.stringify(printability(vase.dropToPlate())));
check('analyze is deterministic',
  JSON.stringify(analyze(vase, { selfIntersect: true })) === JSON.stringify(analyze(vase, { selfIntersect: true })));

console.log('\n-- degenerate input --');
const oneTri = new Mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);
check('a single triangle: 3 open edges, one hole, not manifold',
  analyze(oneTri).boundaryEdges === 3 && analyze(oneTri).holes === 1 && analyze(oneTri).manifold === false);
check('a single triangle through printability: NOT_SOLID, no crash',
  printability(oneTri).warnings.some((w) => w.code === 'NOT_SOLID'));
check('printability says so when it is measuring an open surface',
  printability(fx.openCube(10).dropToPlate()).warnings.some((w) => w.code === 'NOT_WATERTIGHT' && w.severity === 'error'),
  printability(fx.openCube(10).dropToPlate()).warnings.find((w) => w.code === 'NOT_WATERTIGHT').message.slice(0, 90) + '…');
const sheet = new Mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2, 0, 2, 1]);
const sheetA = analyze(sheet);
check('two triangles back to back: closed, but ZERO_VOLUME says there is nothing inside',
  sheetA.watertight === true && sheetA.solid === false && sheetA.warnings.some((w) => w.code === 'ZERO_VOLUME' && w.severity === 'error'),
  sheetA.warnings.map((w) => w.code).join(' '));
const collapsed = fx.cube(1e-6);
check('a cube smaller than the weld tolerance welds to nothing and is not called manifold',
  analyze(collapsed).manifold === false && analyze(collapsed).degenerateTris === 12,
  analyze(collapsed).warnings.map((w) => w.code).join(' '));
check('coordinates 1e6 mm apart still index and weld correctly', analyze(fx.cube(1e6)).manifold === true);
check('a mesh made of one point does not divide by zero',
  analyze(new Mesh([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2])).degenerateTris === 1 &&
  printability(new Mesh([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2])).warnings.length > 0);
check('every helper survives an empty mesh',
  triGrid(new Mesh()).cells === 0 && boundaryLoops(new Mesh()).length === 0 && shellsOf(new Mesh()).count === 0 &&
  orientationCheck(new Mesh()).flippedTris === 0 && wallThickness(new Mesh()).measured === 0 &&
  selfIntersect(new Mesh()).count === 0 && faceOverhangs(new Mesh()).worst === 0);
check('layerH 0 does not produce Infinity layers', printability(fx.cube(10).dropToPlate(), { layerH: 0 }).layers === 0);
check('a plain {positions, tris} object is accepted', analyze({ positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], tris: [0, 1, 2] }).triCount === 1);
check('typed arrays are accepted',
  analyze(new Mesh(new Float32Array(fx.cube(10).positions), new Uint32Array(fx.cube(10).tris))).manifold === true);

// ---------------------------------------------------------------------------
// 5. cross-check: validate.js vs tests/lib/meshcheck.mjs
//    Two implementations written separately. Every number below is computed
//    twice by different code; a disagreement means one of them is wrong.
// ---------------------------------------------------------------------------
console.log('\n-- cross-check against meshcheck.topology() --');
const crossCheck = {
  cube: fx.cube(10), tetra: fx.tetra(10), icosphere: fx.icosphere(10, 2), torus: fx.torus(10, 3),
  cylinder: fx.cylinder(5, 10), heightfield, vase, arch, holedBox: holedBox(), bowtie: bowtie(),
  openCube: fx.openCube(10), flippedFace: fx.flippedFaceCube(10), insideOut: fx.insideOutCube(10),
  twoShells: fx.twoShells(10, 30), fusedCubes: fx.nonManifoldPair(10), degenerate: fx.degenerateCube(10),
};
let agree = 0, total = 0;
for (const [name, m] of Object.entries(crossCheck)) {
  const a = analyze(m), t = topology(m);
  const mine = [a.boundaryEdges, a.nonManifoldEdges, a.inconsistentEdges, a.eulerRaw, a.weldedVertCount, a.weldedTriCount, a.edgeCount];
  const theirs = [t.boundary, t.nonManifold, t.inconsistent, t.euler, t.verts, t.tris, t.edges];
  total++;
  const same = mine.every((v, i) => v === theirs[i]);
  if (same) agree++;
  check(`${name}: boundary/non-manifold/inconsistent/Euler/V/F/E agree`, same,
    `mine [${mine}] vs meshcheck [${theirs}]`);
}
check(`all ${total} meshes agree with the independent checker`, agree === total, `${agree}/${total}`);
console.log(`CROSSCHECK: ${agree}/${total} meshes agree with tests/lib/meshcheck.mjs`);

// A knot of zero-area triangles must not be reported as a 0.00 mm wall. The
// reproduction is the real one: the Skådis "Deep parts bin" preset told Sam
// "0 mm² of surface forms a wall 0.00 mm thick" on 2026-09-03. A synthetic
// lone degenerate triangle does NOT reproduce it (it measures no thickness at
// all and never becomes a cluster), which is why this uses the generator.
{
  const skadis = (await import('../js/gen/skadis.js')).default;
  const preset = skadis.presets.find(p => p.name === 'Deep parts bin');
  const params = { ...Object.fromEntries(skadis.params.map(q => [q.key, q.def])), ...preset.values };
  const built = skadis.build(params, { quality: 'draft' });
  const pr = printability(built.mesh || built, { nozzle: 0.4, layerH: 0.2 });
  const zeroWall = (pr.warnings || []).find(w => w.code === 'THIN_WALL' && w.area < 0.25);
  check('the Skådis bin no longer reports a 0 mm² wall 0.00 mm thick', !zeroWall,
    zeroWall ? zeroWall.message.slice(0, 80) : 'no such warning');
  const m = built.mesh || built;
  let degenerate = 0;
  for (let i = 0; i < m.tris.length / 3; i++) if (m.triArea(i) < 1e-12) degenerate++;
  check('(the case is live: the bin does carry degenerate triangles, so the guard is exercised)',
    degenerate > 0, `${degenerate} zero-area triangles`);
}

done();
