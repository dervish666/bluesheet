// The "starts in mid-air" check, and the two new primitives behind it.
//
// This suite exists because the first implementation reported EVERY second shell
// as floating — flush-stacked, overlapping, or genuinely in the air, all the
// same. A validator that cries wolf on the commonest pattern in the catalogue
// (letters on a plate, a lid on a box, dividers in a bin) is worse than none,
// because people learn to scroll past it.
import { suite, check, near, done } from './lib/assert.mjs';
import { printability, analyze, triGrid, rayMeshCount, pointInsideMesh } from '../js/kernel/validate.js';
import { cube, icosphere, cylinder, torus } from './lib/fixtures.mjs';
import { Mesh } from '../js/kernel/mesh.js';

suite('islands');

// ---- the primitives ------------------------------------------------------
{
  const c = cube(20);                       // centred on the origin, -10..10
  const g = triGrid(c);
  check('a ray from the centre crosses the surface once going out', rayMeshCount(g, [0, 0, 0], [0, 0, 1]) === 1, String(rayMeshCount(g, [0, 0, 0], [0, 0, 1])));
  check('a ray from outside crosses twice going through', rayMeshCount(g, [0, 0, -50], [0, 0, 1]) === 2, String(rayMeshCount(g, [0, 0, -50], [0, 0, 1])));
  check('a ray from outside pointing away crosses nothing', rayMeshCount(g, [0, 0, -50], [0, 0, -1]) === 0);
  check('the centre of a cube is inside it', pointInsideMesh(g, [0, 0, 0]));
  check('a point beyond the face is outside', !pointInsideMesh(g, [0, 0, 11]));
  check('a point just inside the face is inside', pointInsideMesh(g, [0, 0, 9.99]));
  check('a point just outside the face is outside', !pointInsideMesh(g, [0, 0, 10.01]));
  check('a corner region outside the cube is outside', !pointInsideMesh(g, [9.9, 9.9, 10.1]));

  const t = torus(20, 5, 96, 48);           // the hole is genuinely outside
  const gt = triGrid(t);
  check('the middle of a torus hole is outside it', !pointInsideMesh(gt, [0, 0, 0]));
  check('the tube of a torus is inside it', pointInsideMesh(gt, [20, 0, 0]));

  const two = Mesh.merge([cube(10, { at: [-20, 0, 0] }), cube(10, { at: [20, 0, 0] })]);
  const g2 = triGrid(two);
  check('a point between two disjoint solids is outside both', !pointInsideMesh(g2, [0, 0, 0]));
  check('a point in the left solid is inside', pointInsideMesh(g2, [-20, 0, 0]));
  check('a point in the right solid is inside', pointInsideMesh(g2, [20, 0, 0]));

  const sph = icosphere(15, 3);
  const gs = triGrid(sph);
  let wrong = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    // Deterministic pseudo-random points; compare parity against the radius.
    const a = i * 2.399963, r = 20 * ((i * 37 % 101) / 101);
    const p = [r * Math.cos(a), r * Math.sin(a), 15 * (((i * 53) % 97) / 97 - 0.5) * 2];
    const want = Math.hypot(...p) < 14.6;         // safely inside the faceted sphere
    const outside = Math.hypot(...p) > 15.2;      // safely outside
    if (!want && !outside) continue;
    n++;
    if (pointInsideMesh(gs, p) !== want) wrong++;
  }
  check(`parity agrees with the radius on ${n} sample points around a sphere`, wrong === 0, `${wrong} disagreements`);
}

// ---- the behaviour that motivated all of it ------------------------------
{
  const base = cube(20).translate(0, 0, 10);          // z 0..20, resting on the plate
  const cases = [
    ['a part stacked exactly flush on another', Mesh.merge([base, cube(8).translate(0, 0, 24)]), 0],
    ['a part overlapping the one below it', Mesh.merge([base, cube(8).translate(0, 0, 23.5)]), 0],
    ['a part genuinely floating 3 mm up', Mesh.merge([base, cube(8).translate(0, 0, 27)]), 1],
    ['a lone plate', base, 0],
    ['a sphere resting on the plate', icosphere(12, 3).translate(0, 0, 12), 0],
    ['a cylinder on the plate', cylinder(8, 20), 0],
    ['three parts stacked flush', Mesh.merge([base, cube(12).translate(0, 0, 26), cube(6).translate(0, 0, 35)]), 0],
    ['a part flush on one that is itself floating', Mesh.merge([base, cube(8).translate(0, 0, 28), cube(4).translate(0, 0, 34)]), 1],
  ];
  for (const [name, mesh, want] of cases) {
    const p = printability(mesh, {});
    check(`${name}: ${want} unsupported island${want === 1 ? '' : 's'}`, p.unsupportedIslands === want,
      `got ${p.unsupportedIslands}, shells ${analyze(mesh).shells}`);
  }
}

// ---- and the message still names real numbers ---------------------------
{
  const m = Mesh.merge([cube(20).translate(0, 0, 10), cube(8).translate(0, 0, 27)]);
  const w = (printability(m, {}).warnings || []).find(x => /mid-air/.test(x.message));
  check('the warning exists for a real float', !!w, w ? w.message.slice(0, 80) : 'none');
  check('the warning states the height it starts at', w && /z = 23\.0 mm/.test(w.message), w && w.message.match(/z = [\d.]+ mm/)?.[0]);
  check('the warning states the gap below it', w && /3\.0 mm down/.test(w.message), w && w.message.match(/[\d.]+ mm down/)?.[0]);
}

// ---- contact faces are not overhangs -------------------------------------
// The same argument one layer up: a face resting flush on another part points
// straight down but is held up by the thing underneath it. Telling someone to
// add supports under a letter that is touching its own plate is how a tool
// teaches people to ignore its warnings.
{
  const cases = [
    ['a sphere on the plate keeps its real overhang', icosphere(15, 3).translate(0, 0, 15), (p) => p.overhangArea > 100 && p.contactArea === 0],
    ['a T shape keeps its overhanging arms', Mesh.merge([cube(8).translate(0, 0, 4), cube(40).scale(1, 0.3, 0.15).translate(0, 0, 10)]), (p) => p.overhangArea > 100 && p.worstOverhangDeg > 80],
    ['letters flush on a plate are contact, not overhang', Mesh.merge([cube(40).scale(1, 0.6, 0.06).translate(0, 0, 1.2), cube(6).translate(-8, 0, 3.9), cube(6).translate(8, 0, 3.9)]), (p) => p.overhangArea === 0 && p.contactArea > 50],
    ['a plain cube has neither', cube(20).translate(0, 0, 10), (p) => p.overhangArea === 0 && p.contactArea === 0],
  ];
  for (const [name, mesh, ok] of cases) {
    const p = printability(mesh, {});
    check(name, ok(p), `overhang ${p.overhangArea.toFixed(0)} mm² (${p.overhangPct.toFixed(1)}%), contact ${(p.contactArea || 0).toFixed(0)} mm², worst ${p.worstOverhangDeg.toFixed(0)}°`);
  }
}

// ---- a cantilever is not an island ---------------------------------------
//
// The second time this validator cried wolf on the commonest pattern in the
// catalogue. The first was every stacked shell (above). This one was every
// CANTILEVER: an arm sticking out of a post is held up, but sideways, and the
// old anchor test only asked whether a wall descended from the floating face's
// own vertices. Nothing descends from the lowest thing there is, so the tip of
// any overhanging arm reported as starting in mid-air.
//
// It was not a corner case. Across the catalogue's 99 default-and-preset builds
// it accounted for EVERY island ever reported — 20 of 20, over five generators,
// at ERROR severity. The suite even contained the reproduction already: the
// T-shape fixture used below for overhang was reporting a 480 mm2 island the
// whole time, and nothing asserted on it.
{
  const post = cube(8).translate(0, 0, 4);                              // z 0..8
  const bar = cube(40).scale(1, 0.3, 0.15).translate(0, 0, 10);         // z 7..13
  const cases = [
    ['an arm cantilevered out of a post', Mesh.merge([post, bar]), 0],
    ['an arm off a post, with a part genuinely floating above it',
      Mesh.merge([post, bar, cube(6).translate(0, 0, 20)]), 1],
    ['an arm off a WALL rather than a post',
      Mesh.merge([cube(30).scale(0.2, 1, 1).translate(-12, 0, 15), cube(30).scale(1, 0.3, 0.1).translate(5, 0, 20)]), 0],
    ['two arms off the same post', Mesh.merge([post, bar, cube(30).scale(0.25, 1, 0.15).translate(0, 0, 11)]), 0],
  ];
  for (const [name, mesh, want] of cases) {
    const p = printability(mesh, {});
    check(`${name}: ${want} island${want === 1 ? '' : 's'}`, p.unsupportedIslands === want,
      `got ${p.unsupportedIslands}${p.islands.length ? ' — ' + p.islands.map(i => i.area.toFixed(0) + 'mm² @ z' + i.lowZ.toFixed(1)).join(', ') : ''}`);
  }

  // The falsification, shipped next to the assertions it protects. A fix that
  // simply stopped reporting islands would satisfy every check above, and this
  // is the one it could not satisfy.
  const stillSeen = printability(Mesh.merge([cube(20).translate(0, 0, 10), cube(8).translate(0, 0, 27)]), {});
  check('a genuine float is STILL reported after all of that', stillSeen.unsupportedIslands === 1,
    `got ${stillSeen.unsupportedIslands}`);
}

// ---- interpenetrating shells, where crossing parity lies -----------------
//
// The cantilever test above is geometric, not topological, because the shapes it
// fires on are usually separate shells merged into one mesh with no shared edges
// to walk. That makes the inside test load-bearing — and plain parity is wrong
// exactly where two shells overlap: a point inside BOTH crosses an even number
// of surfaces and reads as outside, punching a phantom hole through the region
// where the bar enters the post. `signed` counts winding instead.
{
  const two = Mesh.merge([cube(20).translate(0, 0, 10), cube(20).translate(10, 0, 10)]);
  const g = triGrid(two);
  const overlap = [5, 0, 10];        // inside both cubes
  const onlyOne = [-5, 0, 10];       // inside the left cube only
  const outside = [40, 0, 10];

  check('parity calls a point inside two overlapping solids OUTSIDE (the bug)',
    pointInsideMesh(g, overlap) === false, 'parity says outside');
  check('winding calls the same point inside', rayMeshCount(g, overlap, [0.4467, 0.5723, 0.6875], { signed: true }) !== 0,
    `winding ${rayMeshCount(g, overlap, [0.4467, 0.5723, 0.6875], { signed: true })}`);
  check('winding and parity agree where only one solid is present',
    (rayMeshCount(g, onlyOne, [0.4467, 0.5723, 0.6875], { signed: true }) !== 0) === pointInsideMesh(g, onlyOne));
  check('winding says outside where there is nothing',
    rayMeshCount(g, outside, [0.4467, 0.5723, 0.6875], { signed: true }) === 0);
  check('the unsigned count is unchanged by the option existing',
    rayMeshCount(g, onlyOne, [0.4467, 0.5723, 0.6875]) === rayMeshCount(g, onlyOne, [0.4467, 0.5723, 0.6875], { signed: false }));
}

// ---- a region with no area cannot start in mid-air -----------------------
// Three of the catalogue's twenty reported islands had an area of 0.00 mm2 —
// degenerate slivers, reported at ERROR severity alongside real geometry.
{
  const p = printability(Mesh.merge([cube(20).translate(0, 0, 10), cube(8).translate(0, 0, 27)]), {});
  check('every island reported has a real area', p.islands.every(i => i.area > 0.05),
    p.islands.map(i => i.area.toFixed(3) + 'mm²').join(', ') || 'none');
}

done();
