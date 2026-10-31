// The headline wall thickness: p05 per body, not the raw minimum.
//
// The raw minimum is a ray from a face beside a crease landing on the face
// across the corner, so it reads a fraction of the wall. The drawer's 1.6 mm
// walls have a 0.40 mm minimum. p05 is the thickness 5 % of the surface (by
// area) is thinner than, taken per body, and the overall figure is the worst
// body's. These checks hold it to four things: a real thin wall still reads
// thin and still warns, a crease does not drag a thick wall down, a thin body
// beside a thick one is not averaged away, and a small body is still measured
// when a large mesh is only sampled.

import { suite, check, near, done } from './lib/assert.mjs';
import { cube, icosphere } from './lib/fixtures.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import { subtract } from '../js/kernel/csg.js';
import { extrude } from '../js/kernel/builders.js';
import { wallThickness, printability } from '../js/kernel/validate.js';
import { thinnestWall } from '../js/ui/format.js';
import vaseGen from '../js/gen/vase.js';
import drawerGen from '../js/gen/drawer.js';

suite('wall p05');

/** Axis-aligned box from its min corner, written out by hand. */
function box(w, d, h, [x0, y0, z0] = [0, 0, 0]) {
  const m = new Mesh();
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]]
    .map((p) => m.addVertex(p[0] + x0, p[1] + y0, p[2] + z0));
  for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) m.addQuad(...q.map((i) => v[i]));
  return m;
}

// ---- 1. a real 0.6 mm wall still reads 0.6 and still warns -----------------
// An open tray, 0.6 mm walls and floor. It has the same inner creases the
// drawer has, so it is the case where p05 must not hide a thin wall.
{
  const W = 0.6;
  const tray = subtract(box(30, 20, 12), box(30 - 2 * W, 20 - 2 * W, 12, [W, W, W])).dropToPlate();
  const wt = wallThickness(tray);
  near('a 0.6 mm tray reads p05 0.6 mm', wt.p05, W, 1e-3);
  check('it is one body', wt.bodies.length === 1, `${wt.bodies.length} bodies`);
  const p = printability(tray);
  near('printability carries the same p05', p.p05Thickness, W, 1e-3);
  check('and still warns about the thin wall',
    p.warnings.some((x) => x.code === 'THIN_WALL' || x.code === 'THIN_SLAB'),
    p.warnings.map((x) => x.code).join(', '));
  const row = thinnestWall(p.p05Thickness, { probe: p.thicknessProbe, minFeature: p.minFeature });
  check('the analysis row is labelled p05 and toned warn', row[0] === 'Thinnest wall (p05)' && row[2] === 'warn', JSON.stringify(row));

  // A flat plate: the case validate.test.mjs already pins for the raw minimum.
  const plate = box(20, 20, W);
  near('a 0.6 mm plate reads p05 0.6 mm', wallThickness(plate).p05, W, 1e-6);

  // One body, two thicknesses: a 2 mm slab with a 0.6 mm lip along one edge.
  // The lip is about 11 % of the surface, so p05 lands on it and the median
  // does not. Every other fixture here is one thickness all over, where the
  // two agree and a median would pass unnoticed.
  const step = extrude([[0, 0], [40, 0], [40, 2], [10, 2], [10, W], [0, W]], 20);
  const st = wallThickness(step);
  check('the stepped slab is one body', st.bodies.length === 1, `${st.bodies.length}`);
  near('a 2 mm slab with a 0.6 mm lip reads p05 0.6 mm', st.p05, W, 1e-6);
}

// ---- 2. the generators the raw minimum got wrong ---------------------------
{
  const C = ctx('normal');
  const drawer = asMesh(drawerGen.build(defaults(drawerGen), C));
  const d = printability(drawer);
  // The raw minimum is kept on purpose; check it is still the artefact, so the
  // p05 check below is measuring a fix and not a mesh that changed.
  check('drawer: the raw minimum is still the crease artefact', d.minThickness < 0.5, `${d.minThickness}`);
  near('drawer: p05 reads the 1.6 mm wall', d.p05Thickness, 1.6, 0.05);
  check('drawer: the panel does not tone it warn', thinnestWall(d.p05Thickness, { probe: d.thicknessProbe, minFeature: d.minFeature })[2] === null);

  // The vase's default is spiral mode, where the model's wall is one extrusion
  // width (0.42 mm at a 0.4 nozzle) measured horizontally, so a sloped wall is
  // thinner still when measured square to the surface. Its 0.34 mm minimum was
  // never a crease artefact, and p05 must keep saying it is thin.
  const spiral = printability(asMesh(vaseGen.build(defaults(vaseGen), C)));
  check('vase (spiral default): p05 is the real single-extrusion wall',
    spiral.p05Thickness > 0.3 && spiral.p05Thickness <= 0.42 + 1e-6, `${spiral.p05Thickness}`);
  // Walled mode is where the 2 mm wall lives. Its thinnest real surface is the
  // 1.6 mm floor, which covers more than 5 % of it.
  const walled = printability(asMesh(vaseGen.build({ ...defaults(vaseGen), mode: 'walled' }, C)));
  check('vase (walled, 2 mm): p05 is between the 1.6 mm floor and the 2 mm wall',
    walled.p05Thickness >= 1.55 && walled.p05Thickness <= 2.05, `${walled.p05Thickness}`);
}

// ---- 3. a thin body beside a thick one is not averaged away ----------------
// The plate is 2.5 % of the surface. One percentile over the whole mesh lands on
// the cube, which is thicker than the probe reaches, and reports nothing thin.
{
  const thick = cube(20, { at: [0, 0, 10] });
  const thin = box(5, 5, 0.6, [30, 0, 0]);
  const both = Mesh.merge([thick, thin]);
  const wt = wallThickness(both);
  check('two bodies are measured separately', wt.bodies.length === 2, `${wt.bodies.length}`);
  check('the thick body is past the probe', wt.bodies[0].p05 === null, `${wt.bodies[0].p05}`);
  near('the thin body reads 0.6 mm', wt.bodies[1].p05, 0.6, 1e-6);
  near('the overall p05 is the thin body\'s', wt.p05, 0.6, 1e-6);
  check('and names it', wt.p05Body === 1, `${wt.p05Body}`);
  const again = wallThickness(both);
  check('the same mesh gives the same answer twice', JSON.stringify(again.bodies) === JSON.stringify(wt.bodies));
  check('a cube alone reads "over the probe", not a number',
    thinnestWall(wallThickness(cube(20)).p05, { probe: 2.4 })[1] === 'over 2.4 mm');
}

// ---- 4. a sampled mesh still measures its small bodies ---------------------
// Over maxSamples the pass measures every stride-th face. Pick a stride that
// steps clean over the small plate's 12 faces and check the plate is measured
// anyway.
{
  const ball = icosphere(15, 4);
  const plate = box(5, 5, 0.6, [30, 0, 0]);
  const both = Mesh.merge([ball, plate]);
  const T = both.triCount, first = ball.triCount;
  let maxSamples = 0;
  for (let ms = 40; ms < 2000 && !maxSamples; ms++) {
    const stride = Math.ceil(T / ms);
    let hit = false;
    for (let t = first; t < T; t++) if (t % stride === 0) hit = true;
    if (!hit && stride > 12) maxSamples = ms;
  }
  check('found a stride that misses the plate', maxSamples > 0, `T ${T}`);
  const wt = wallThickness(both, { maxSamples });
  check('the mesh was sampled', wt.sampled === true);
  check('the plate was still measured', wt.bodies[1].samples > 0, JSON.stringify(wt.bodies[1]));
  near('and its p05 is the overall figure', wt.p05, 0.6, 1e-6);
}

done();
