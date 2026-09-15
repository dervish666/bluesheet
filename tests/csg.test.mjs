// tests/csg.test.mjs — mesh booleans.
//
// Every volume here is checked against a closed-form value, not against a golden
// number recorded from a previous run. A golden number is only evidence that the
// code still does what it did; it cannot tell you it was ever right. Where the
// operand is a tessellated curve the closed form is the *polygonal* one (an n-gon
// prism, not a cylinder), so the tolerance stays tight enough to catch a single
// misplaced face rather than being loosened until anything passes.
//
// Inputs come from tests/lib/fixtures.mjs only — nothing here depends on
// builders.js, which is another leaf's file.

import { suite, check, near, nearPct, throws, done } from './lib/assert.mjs';
import { isSolid, topology, volumeAgrees, deterministic } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import {
  cube, tetra, icosphere, torus, cylinder, heightfieldSolid,
  openCube, insideOutCube, twoShells, degenerateCube,
} from './lib/fixtures.mjs';
import { union, subtract, intersect, unionAll, subtractAll, intersectAll } from '../js/kernel/csg.js';

suite('csg');

const TAU = Math.PI * 2;
/** Area of the regular n-gon the `cylinder` fixture actually builds, not of a circle. */
const prismArea = (r, n) => n / 2 * r * r * Math.sin(TAU / n);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ---------------------------------------------------------------- G4: volumes
console.log('\n-- analytic volumes --');

// Two 10 mm cubes overlapping over a 5 mm slab.
{
  const r = union(cube(10), cube(10, { at: [5, 0, 0] }));
  near('union of two overlapping cubes: volume', r.volume(), 1500, 1e-9);
  isSolid('union overlapping cubes', r, { euler: 2 });
  volumeAgrees('union overlapping cubes', r);
}

// A through hole: the cutter pokes out of both faces, so the result is a genus-1
// solid and its Euler characteristic has to be 0, not 2.
{
  const segs = 64;
  const r = subtract(cube(20), cylinder(4, 40, segs).translate(0, 0, -20));
  near('cube minus through-cylinder: volume', r.volume(), 8000 - prismArea(4, segs) * 20, 1e-9);
  isSolid('cube minus through-cylinder', r, { euler: 0 });
  volumeAgrees('cube minus through-cylinder', r);
  check('through hole leaves both faces open', r.bbox().size[2] === 20, `height ${r.bbox().size[2]}`);
}

// Sphere ∩ cube, with the cube entirely inside the sphere: the answer is the cube.
{
  const r = intersect(icosphere(20, 3), cube(10));
  near('sphere ∩ enclosed cube: volume', r.volume(), 1000, 1e-9);
  isSolid('sphere ∩ enclosed cube', r, { euler: 2 });
}
// …and with the sphere entirely inside the cube: the answer is the sphere, to the
// last bit, because no face of either operand is cut.
{
  const s = icosphere(5, 2);
  const r = intersect(cube(20), s);
  near('cube ∩ enclosed sphere: volume', r.volume(), s.volume(), 1e-9);
  isSolid('cube ∩ enclosed sphere', r, { euler: 2 });
}
// A genuine mutual clip, where six caps come off the sphere.
{
  const rad = 10, half = 8, s = icosphere(rad, 4);
  const r = intersect(s, cube(half * 2));
  const cap = Math.PI * (rad - half) * (rad - half) * (3 * rad - (rad - half)) / 3;
  nearPct('sphere ∩ cube (six caps removed): volume', r.volume(), 4 / 3 * Math.PI * rad ** 3 - 6 * cap, 1.5);
  isSolid('sphere ∩ cube', r, { euler: 2 });
  volumeAgrees('sphere ∩ cube', r);
}

// Cube minus a fully enclosed sphere — a void, so two shells and Euler 4.
{
  const s = icosphere(8, 3);
  const r = subtract(cube(20), s);
  near('cube minus enclosed sphere: volume', r.volume(), 8000 - s.volume(), 1e-9);
  isSolid('cube minus enclosed sphere', r, { euler: 4 });
  check('cube minus enclosed sphere keeps the outer bbox', r.bbox().size[0] === 20, `${r.bbox().size[0]} mm`);
}

// A subtraction that severs the solid into two disconnected pieces.
{
  const r = subtract(cube(10).scale(3, 1, 1), cube(10).scale(0.4, 2, 2));
  near('subtraction that splits the solid: volume', r.volume(), 3000 - 400, 1e-9);
  isSolid('split solid', r, { euler: 4 });   // two closed shells
  check('split solid really is in two pieces', shells(r) === 2, `${shells(r)} shells`);
}

// Twenty holes in a plate.
{
  const segs = 24, plate = cube(10).scale(10, 10, 0.6);
  const holes = [];
  for (let i = 0; i < 20; i++) {
    holes.push(cylinder(3, 20, segs).translate(-36 + 18 * (i % 5), -27 + 18 * Math.floor(i / 5), -10));
  }
  const r = subtractAll(plate, holes);
  near('subtractAll of 20 holes: volume', r.volume(), 100 * 100 * 6 - 20 * prismArea(3, segs) * 6, 1e-7);
  isSolid('subtractAll 20 holes', r, { euler: 2 - 2 * 20 });
  volumeAgrees('subtractAll 20 holes', r, 6, 3000);
}

// ------------------------------------------------------- G5: coplanar faces
console.log('\n-- coplanar faces --');

// Two cubes meeting on exactly one face. The shared face must survive zero times:
// keep both copies and you get a non-manifold wall through the middle, keep one
// and the solid has an internal membrane.
{
  const r = union(cube(10), cube(10, { at: [10, 0, 0] }));
  near('cubes sharing one face: volume', r.volume(), 2000, 1e-9);
  isSolid('cubes sharing one face', r, { euler: 2 });
  check('shared face is not duplicated into the interior', r.triCount <= 24, `${r.triCount} triangles`);
  const t = topology(r);
  check('shared face leaves no interior wall', t.tris <= 24 && t.euler === 2, `${t.tris} tris, euler ${t.euler}`);
}

// Same-facing coplanar overlap: two slabs side by side whose top faces are the
// same plane AND face the same way, overlapping over a 10 mm span. This is the
// case naive coplanar handling duplicates.
{
  const a = cube(10).scale(2, 1, 1);              // x -10..10
  const b = cube(10).scale(2, 1, 1).translate(10, 0, 0);   // x 0..20
  const r = union(a, b);
  near('same-facing coplanar overlap: volume', r.volume(), 3000, 1e-9);
  isSolid('same-facing coplanar overlap', r, { euler: 2 });
  check('coplanar top face emitted once', r.triCount <= 32, `${r.triCount} triangles`);
}

// A cube minus itself. Every face is coplanar and opposite-facing to its partner.
{
  const r = subtract(cube(10), cube(10));
  check('cube minus itself is empty', r.triCount === 0, `${r.triCount} triangles left`);
  near('cube minus itself has no volume', r.volume(), 0, 1e-9);
}
{
  const r = intersect(cube(10), cube(10));
  near('cube intersect itself: volume', r.volume(), 1000, 1e-9);
  isSolid('cube intersect itself', r, { euler: 2 });
}
{
  const r = union(cube(10), cube(10));
  near('cube union itself: volume', r.volume(), 1000, 1e-9);
  isSolid('cube union itself', r, { euler: 2 });
}

// THE POCKET: a box cut into a plate with its top face exactly flush with the
// plate's top. The single most common real use, and the one that breaks BSP CSG.
{
  const plate = cube(10).scale(4, 4, 1);                       // 40x40x10, z -5..5
  const cutter = cube(10).scale(2, 2, 0.6).translate(0, 0, 2); // 20x20x6, z -1..5 (flush)
  const r = subtract(plate, cutter);
  near('flush pocket: volume', r.volume(), 16000 - 2400, 1e-9);
  isSolid('flush pocket', r, { euler: 2 });   // a pocket is still a topological ball
  volumeAgrees('flush pocket', r);
  check('pocket has a floor at z=-1 under a rim at z=5', pocketZLevels(r), zLevels(r));
}

// A cutting face lying exactly ON the surface, with the cutter otherwise outside:
// nothing should change, and in particular the top face must not be deleted.
{
  const plate = cube(10).scale(4, 4, 1);              // z -5..5
  const r = subtract(plate, cube(10).translate(0, 0, 10));   // z 5..15, flush at z=5
  near('cutter resting flush on the surface: volume unchanged', r.volume(), 16000, 1e-9);
  isSolid('cutter flush on surface', r, { euler: 2 });
  check('flush cutter did not eat the top face', r.bbox().max[2] === 5, `max z = ${r.bbox().max[2]}`);
}
// The same on a side face.
{
  const r = subtract(cube(10), cube(10).translate(10, 0, 0));
  near('cutter flush on a side face: volume unchanged', r.volume(), 1000, 1e-9);
  isSolid('cutter flush on a side face', r, { euler: 2 });
}
// Half-cut, where the cutter's own face lands exactly on the cube's centre plane
// and its other four faces are coplanar with the cube's.
{
  const r = subtract(cube(10), cube(10).translate(5, 0, 0));
  near('half cut with four coplanar faces: volume', r.volume(), 500, 1e-9);
  isSolid('half cut with four coplanar faces', r, { euler: 2 });
}
// A through-slot whose walls are flush with the top and bottom faces at once, and
// which runs right out of both ends — so it also severs the box in two.
{
  const r = subtract(cube(10).scale(2, 2, 1), cube(10).scale(0.3, 3, 1));   // 20x20x10 less a 3x20x10 slab
  near('through slot flush with top and bottom: volume', r.volume(), 4000 - 3 * 20 * 10, 1e-9);
  isSolid('through slot flush top and bottom', r, { euler: 4 });
  check('through slot severs the box', shells(r) === 2, `${shells(r)} shells`);
}

// ------------------------------------------------- coplanar, curved operands
{
  // Two cylinders sharing a cap plane exactly.
  const a = cylinder(5, 10, 32), b = cylinder(5, 10, 32).translate(0, 0, 10);
  const r = union(a, b);
  near('stacked cylinders sharing a cap: volume', r.volume(), prismArea(5, 32) * 20, 1e-9);
  isSolid('stacked cylinders sharing a cap', r, { euler: 2 });
}

// -------------------------------------------------------- correctness at scale
console.log('\n-- epsilon across scales --');

// The same cut at 0.5 mm and at 170 mm. A single global epsilon cannot serve both;
// this is the test that the scale-relative one does.
{
  const segs = 32;
  const tiny = subtract(cube(0.5), cylinder(0.15, 2, segs).translate(0, 0, -1));
  near('0.5 mm cube minus a 0.3 mm hole: volume', tiny.volume(), 0.125 - prismArea(0.15, segs) * 0.5, 1e-12);
  isSolid('0.5 mm part', tiny, { euler: 0 });

  const big = subtract(cube(170), cylinder(50, 400, 48).translate(0, 0, -200));
  near('170 mm cube minus a 100 mm hole: volume', big.volume(), 170 ** 3 - prismArea(50, 48) * 170, 1e-6);
  isSolid('170 mm part', big, { euler: 0 });
}
// Geometry far from the origin: absolute coordinates around 150 mm carry more
// rounding error than the feature size, which is why the epsilon keys off the
// largest coordinate rather than the bounding-box diagonal.
{
  const segs = 48;
  const r = subtract(cube(20).translate(150, 150, 150), cylinder(4, 40, segs).translate(150, 150, 130));
  near('cut 150 mm from the origin: volume', r.volume(), 8000 - prismArea(4, segs) * 20, 1e-6);
  isSolid('cut far from the origin', r, { euler: 0 });
}
// A feature three orders of magnitude smaller than the part.
{
  const segs = 24;
  const r = subtract(cube(10).scale(18, 18, 0.2), cylinder(0.1, 10, segs).translate(50, 50, -5));
  near('0.2 mm hole in a 180 mm plate: volume', r.volume(), 180 * 180 * 2 - prismArea(0.1, segs) * 2, 1e-7);
  isSolid('0.2 mm hole in a 180 mm plate', r, { euler: 0 });
}

// ---------------------------------------------------------------- topology
console.log('\n-- topology and orientation --');

{
  const r = subtract(torus(10, 3, 48, 24), cylinder(5, 30, 32).translate(0, 0, -15));
  isSolid('torus minus an axial cylinder', r, { euler: 0 });   // still genus 1
  check('torus cut keeps positive volume', r.volume() > 0, `${r.volume().toFixed(2)} mm³`);
}
{
  const r = union(torus(10, 3, 48, 24), icosphere(6, 3));
  isSolid('torus union a sphere through its hole', r, { euler: 2 });   // the hole is plugged
}
{
  const r = subtract(heightfieldSolid(20, 40), cylinder(5, 20, 32).translate(0, 0, -5));
  isSolid('heightfield minus a cylinder', r, { euler: 0 });
}
{
  const r = subtract(tetra(10), cube(6));
  isSolid('tetra minus a cube at its corner', r);
  check('tetra cut shrinks the volume', r.volume() < tetra(10).volume(), `${r.volume().toFixed(3)} mm³`);
}
{
  // Nested subtraction: hollow the cube, then punch through the shell.
  const shell = subtract(cube(20), cube(16));
  const r = subtract(shell, cylinder(3, 40, 32).translate(0, 0, -20));
  near('hollow box then drill through: volume', r.volume(),
    8000 - 4096 - prismArea(3, 32) * (20 - 16), 1e-7);
  isSolid('hollow box drilled through', r);
}

// ------------------------------------------------------------ the *All forms
console.log('\n-- unionAll / subtractAll / intersectAll --');

{
  const r = unionAll([cube(10), cube(10).translate(8, 0, 0), cube(10).translate(16, 0, 0), cube(10).translate(24, 0, 0)]);
  near('unionAll of an overlapping chain: volume', r.volume(), 1000 + 3 * 800, 1e-9);
  isSolid('unionAll overlapping chain', r, { euler: 2 });
}
{
  const r = unionAll([cube(10), cube(10).translate(30, 0, 0), cube(10).translate(60, 0, 0)]);
  near('unionAll of disjoint parts: volume', r.volume(), 3000, 1e-9);
  isSolid('unionAll disjoint parts', r, { euler: 6 });   // three separate shells
  check('unionAll of disjoint parts keeps three shells', shells(r) === 3, `${shells(r)} shells`);
}
{
  const r = intersectAll([cube(10), cube(10).translate(3, 0, 0), cube(10).translate(0, 3, 0)]);
  near('intersectAll of three boxes: volume', r.volume(), 7 * 7 * 10, 1e-9);
  isSolid('intersectAll three boxes', r, { euler: 2 });
}
{
  const r = intersectAll([cube(10), cube(10).translate(30, 0, 0)]);
  check('intersectAll of disjoint boxes is empty', r.triCount === 0, `${r.triCount} triangles`);
}
{
  // Cutters that overlap each other must NOT be batched into one merged operand.
  const r = subtractAll(cube(20), [cube(10), cube(10).translate(4, 0, 0)]);
  near('subtractAll with overlapping cutters: volume', r.volume(), 8000 - (1000 + 4 * 100), 1e-9);
  isSolid('subtractAll overlapping cutters', r);
}
{
  const r = subtractAll(cube(20), [cube(6).translate(-7, 0, 0), cube(6).translate(7, 0, 0)]);
  near('subtractAll with disjoint cutters: volume', r.volume(), 8000 - 2 * 216, 1e-9);
  isSolid('subtractAll disjoint cutters', r);
}

// ------------------------------------------------------------- edge cases
console.log('\n-- empty, null and abusive inputs --');

const EMPTY = new Mesh();
near('union with an empty mesh returns the other', union(cube(10), EMPTY).volume(), 1000, 1e-9);
near('union with an empty first operand', union(EMPTY, cube(10)).volume(), 1000, 1e-9);
near('subtract of an empty cutter is a no-op', subtract(cube(10), EMPTY).volume(), 1000, 1e-9);
check('subtract from an empty base is empty', subtract(EMPTY, cube(10)).triCount === 0);
check('intersect with an empty mesh is empty', intersect(cube(10), EMPTY).triCount === 0);
check('union(null, null) is an empty mesh', union(null, null).triCount === 0);
check('unionAll of nothing is an empty mesh', unionAll([]).triCount === 0);
check('unionAll(undefined) is an empty mesh', unionAll(undefined).triCount === 0);
check('unionAll of one mesh returns it', unionAll([cube(10)]).triCount === 12);
check('subtractAll with no cutters returns the base', subtractAll(cube(10), []).triCount === 12);
check('subtractAll from null is empty', subtractAll(null, [cube(10)]).triCount === 0);
check('intersectAll of nothing is an empty mesh', intersectAll([]).triCount === 0);
near('intersectAll of one mesh returns it', intersectAll([cube(10)]).volume(), 1000, 1e-9);
check('nulls inside a mesh list are skipped',
  Math.abs(unionAll([cube(10), null, undefined]).volume() - 1000) < 1e-9);

throws('union rejects a non-mesh', () => union(5, cube(10)), 'must be a Mesh');
throws('subtract names the offending argument', () => subtract(cube(10), 'x'), 'second argument');
throws('intersect rejects a plain object', () => intersect(cube(10), {}), 'plain object');
throws('unionAll rejects a bare mesh', () => unionAll(cube(10)), 'expected an array');
throws('subtractAll rejects a bare mesh', () => subtractAll(cube(10), cube(10)), 'expected an array');
throws('intersectAll names the offending index', () => intersectAll([cube(10), 7]), 'mesh 1');

// Zero-area triangles in the input must be dropped, not fed to the tree, where
// their normal is pure rounding error.
{
  const r = union(degenerateCube(10), cube(10).translate(5, 0, 0));
  near('degenerate input triangle does not corrupt the result', r.volume(), 1500, 1e-9);
  isSolid('union with a degenerate input triangle', r, { euler: 2 });
}
// Broken input cannot be repaired, but it must not hang or throw either.
for (const [name, m] of [['an open cube', openCube(10)], ['an inside-out cube', insideOutCube(10)],
                         ['two shells', twoShells(10)]]) {
  let ok = true;
  try { subtract(m, cube(6).translate(3, 0, 0)); } catch (e) { ok = e.message; }
  check(`${name} is handled without throwing`, ok === true, ok === true ? '' : String(ok));
}

// -------------------------------------------------------- coplanar merge
console.log('\n-- planar regions are triangulated once --');

// A BSP cuts with infinite planes, so a hole leaves the plate's flat faces as a
// fan of wedges reaching the plate edge. Those are correct but the next boolean
// has to split all of them, so the output is merged back per plane and
// retriangulated. These bounds are what "compact" means in triangles.
{
  // Cutting a hole should cost roughly what the hole's own surface costs, not a
  // fan spread across the whole plate. Scaling the bound off the operands rather
  // than off a number recorded from a previous run keeps this a statement about
  // the algorithm instead of a golden value.
  const segs = 24, plate = cube(10).scale(10, 10, 0.6);
  const cutter = cylinder(3, 20, segs).translate(0, 0, -10);
  const r = subtract(plate, cutter);
  const input = plate.triCount + cutter.triCount;
  check('one hole in a plate costs about what the hole itself costs',
    r.triCount < 5 * input, `${r.triCount} triangles out of ${input} input = ${(r.triCount / input).toFixed(1)}x`);
  near('one hole in a plate: volume', r.volume(), 100 * 100 * 6 - prismArea(3, segs) * 6, 1e-9);
  isSolid('one hole in a plate', r, { euler: 0 });
  // The flat faces must not be carrying a wedge per hole segment. Two faces at,
  // say, three triangles per segment would already be 144 on its own.
  const flat = countByNormal(r, [0, 0, 1]) + countByNormal(r, [0, 0, -1]);
  check('the plate faces are one region each, not a fan of wedges',
    flat < 3 * segs * 2, `${flat} triangles across both flat faces`);
}
{
  // Cutting the same thing twice must be a no-op the second time — a merge that
  // shifted the surface would show up here as a volume that keeps drifting.
  const a = subtract(cube(20), cylinder(4, 40, 32).translate(0, 0, -20));
  const b = subtract(a, cylinder(4, 40, 32).translate(0, 0, -20));
  near('re-cutting an existing hole changes nothing', b.volume(), a.volume(), 1e-9);
  check('re-cutting an existing hole does not grow the mesh', b.triCount <= a.triCount,
    `${b.triCount} against ${a.triCount}`);
  isSolid('re-cut hole', b, { euler: 0 });
}
{
  // The merge must never turn a good mesh into a bad one, including on curved
  // surfaces where coincident opposite-facing sheets can occur.
  const r = union(icosphere(10, 3), icosphere(10, 3).translate(11, 0, 0));
  isSolid('union of two overlapping spheres', r, { euler: 2 });
  const t = topology(r);
  check('sphere union has no non-manifold edges after merging', t.nonManifold === 0,
    `${t.nonManifold} of ${t.edges} edges`);
}

// ------------------------------------------------------------ determinism
console.log('\n-- determinism --');

deterministic('union of two spheres', () => union(icosphere(10, 3), icosphere(10, 3).translate(8, 0, 0)));
deterministic('cube minus cylinder', () => subtract(cube(20), cylinder(4, 40, 64).translate(0, 0, -20)));
deterministic('subtractAll of six holes', () => subtractAll(cube(10).scale(6, 6, 1),
  [0, 1, 2, 3, 4, 5].map(i => cylinder(2, 20, 24).translate(-20 + 8 * i, 0, -10))));
{
  // Order independence where the maths says it must hold.
  const a = cube(10), b = cube(10).translate(5, 5, 0);
  near('union is commutative in volume', union(a, b).volume(), union(b, a).volume(), 1e-9);
  near('intersect is commutative in volume', intersect(a, b).volume(), intersect(b, a).volume(), 1e-9);
}

// --------------------------------------------------------------- G6: timing
console.log('\n-- performance --');

{
  const s1 = icosphere(10, 4), s2 = icosphere(10, 4).translate(8, 0, 0);
  check('performance fixture really is ~5k triangles', s1.triCount === 5120, `${s1.triCount} triangles`);
  const t0 = process.hrtime.bigint();
  const r = union(s1, s2);
  const dt = ms(t0);
  check(`union of two ${s1.triCount}-triangle spheres under 2000 ms`, dt < 2000, `${dt.toFixed(0)} ms`);
  isSolid('union of two 5k spheres', r, { euler: 2 });
  const solo = 4 / 3 * Math.PI * 1000;
  nearPct('union of two 5k spheres: volume', r.volume(), 2 * solo - lensVolume(10, 10, 8), 2);
}
{
  const segs = 24, plate = cube(10).scale(10, 10, 0.6);
  const cuts = [];
  for (let i = 0; i < 20; i++) {
    cuts.push(cylinder(3, 20, segs).translate(-36 + 18 * (i % 5), -27 + 18 * Math.floor(i / 5), -10));
  }
  const inputTris = plate.triCount + cuts.reduce((n, c) => n + c.triCount, 0);

  const t0 = process.hrtime.bigint();
  let acc = plate;
  for (const c of cuts) acc = subtract(acc, c);
  const dtSeq = ms(t0);
  check('20 sequential subtractions under 5000 ms', dtSeq < 5000, `${dtSeq.toFixed(0)} ms`);
  near('20 sequential subtractions: volume', acc.volume(), 100 * 100 * 6 - 20 * prismArea(3, segs) * 6, 1e-7);
  isSolid('20 sequential subtractions', acc, { euler: 2 - 2 * 20 });

  const t1 = process.hrtime.bigint();
  const batched = subtractAll(plate, cuts);
  const dtAll = ms(t1);
  check('subtractAll of the same 20 holes under 5000 ms', dtAll < 5000, `${dtAll.toFixed(0)} ms`);
  near('sequential and batched subtraction agree on volume', batched.volume(), acc.volume(), 1e-7);

  // ------------------------------------------------------- G7: no explosion
  console.log('\n-- triangle growth --');
  // Measured against the TOTAL input — base plus all twenty cutters — because a
  // 12-triangle plate is an absurd baseline for twenty holes that need walls.
  check('20 sequential subtractions stay under 5x the total input triangles',
    acc.triCount < 5 * inputTris,
    `${acc.triCount} out of ${inputTris} input = ${(acc.triCount / inputTris).toFixed(1)}x`);
  check('subtractAll of 20 holes stays under 5x the total input triangles',
    batched.triCount < 5 * inputTris,
    `${batched.triCount} out of ${inputTris} input = ${(batched.triCount / inputTris).toFixed(1)}x`);
  check('batching beats the sequential loop on triangle count',
    batched.triCount < acc.triCount, `${batched.triCount} against ${acc.triCount}`);

  // A union chain is the other way geometry runs away: 40 boxes in a row.
  const t2 = process.hrtime.bigint();
  let chain = cube(4);
  for (let i = 1; i < 40; i++) chain = union(chain, cube(4).translate(i * 3, 0, 0));
  const dtChain = ms(t2);
  check('40 chained unions complete quickly', dtChain < 3000, `${dtChain.toFixed(0)} ms`);
  near('40 chained unions: volume', chain.volume(), 64 + 39 * 48, 1e-9);
  isSolid('40 chained unions', chain, { euler: 2 });
  check('40 chained unions do not multiply geometry',
    chain.triCount < 5 * 40 * 12, `${chain.triCount} triangles`);
}

// ---------------------------------------------------------------- helpers
function shells(mesh) {
  const w = mesh.weld(1e-9);
  const parent = new Int32Array(w.vertCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < w.triCount; t++) {
    const a = find(w.tris[t * 3]), b = find(w.tris[t * 3 + 1]), c = find(w.tris[t * 3 + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const roots = new Set();
  for (let t = 0; t < w.triCount; t++) roots.add(find(w.tris[t * 3]));
  return roots.size;
}

/**
 * The pocket must show exactly three z levels: the plate's underside at -5, the
 * pocket floor at -1, and the rim at +5. A rim that vanished, or a floor left at
 * the wrong depth, changes this set even when the volume happens to come out right.
 */
function pocketZLevels(mesh) {
  const zs = zSet(mesh);
  return zs.length === 3 && zs[0] === -5 && zs[1] === -1 && zs[2] === 5;
}
function zSet(mesh) {
  const zs = new Set();
  for (let i = 2; i < mesh.positions.length; i += 3) zs.add(Math.round(mesh.positions[i] * 1e6) / 1e6);
  return [...zs].sort((a, b) => a - b);
}
function zLevels(mesh) { return `z levels ${zSet(mesh).join(', ')}`; }

/** How many triangles face exactly the given direction. */
function countByNormal(mesh, dir) {
  let n = 0;
  for (let t = 0; t < mesh.triCount; t++) {
    const f = mesh.faceNormal(t);
    if (Math.abs(f[0] - dir[0]) < 1e-9 && Math.abs(f[1] - dir[1]) < 1e-9 && Math.abs(f[2] - dir[2]) < 1e-9) n++;
  }
  return n;
}

/** Volume of the lens where two spheres of radius r1, r2 overlap at centre distance d. */
function lensVolume(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  return Math.PI * (r1 + r2 - d) ** 2 *
    (d * d + 2 * d * r2 - 3 * r2 * r2 + 2 * d * r1 + 6 * r2 * r1 - 3 * r1 * r1) / (12 * d);
}

done();
