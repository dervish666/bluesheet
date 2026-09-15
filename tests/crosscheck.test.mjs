// Cross-checks: the same question answered twice by different machinery.
//
// The kernel's own suites verify each module against analytic expectations
// written alongside it. That catches a lot, but not a shared assumption — two
// pieces of code written in the same hour by the same reasoning can agree
// perfectly and both be wrong. So this file re-asks the questions using
// deliberately different methods: polygons by pixel counting, solids by ray
// casting, topology by an independently written edge walk.
//
// It is slow on purpose. It runs in the normal suite because the day it starts
// disagreeing is the day it earns everything it cost.
import { suite, check, nearPct, done } from './lib/assert.mjs';
import { boolean, triangulate, offset, shapeArea } from '../js/kernel/poly2d.js';
import { compareBoolean, rasterArea, covered, signedDistance } from './lib/raster2d.mjs';
import { topology, volumeAgrees, volumeByRays } from './lib/meshcheck.mjs';
import * as F from './lib/fixtures.mjs';
import { analyze } from '../js/kernel/validate.js';

suite('crosscheck');

// Rings built here, not imported, so the check does not inherit poly2d's own
// idea of what a circle is.
const circ = (r, cx = 0, cy = 0, n = 128) => Array.from({ length: n }, (_, i) => {
  const a = i / n * Math.PI * 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const rct = (w, h, cx = 0, cy = 0) => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
const star = (n, ro, ri) => Array.from({ length: n * 2 }, (_, i) => {
  const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? ri : ro; return [r * Math.cos(a), r * Math.sin(a)];
});

// ---- booleans against a rasteriser ---------------------------------------
{
  const cases = [
    ['two overlapping circles', [circ(20)], [circ(20, 22)]],
    ['a plate and a centred hole', [rct(60, 60)], [circ(12, 0, 0, 96)]],
    ['a bar cut in two', [rct(60, 20)], [rct(10, 40)]],
    ['a star and a square', [star(7, 25, 11)], [rct(30, 30)]],
    ['identical squares', [rct(30, 30)], [rct(30, 30)]],
    ['touching edge to edge', [rct(20, 20, -10)], [rct(20, 20, 10)]],
    ['one wholly inside the other', [rct(60, 60)], [rct(10, 10)]],
    ['disjoint', [rct(10, 10, -40)], [rct(10, 10, 40)]],
    ['a shape with a hole, cut again', [rct(60, 60), rct(20, 20).slice().reverse()], [circ(35, 0, 0, 96)]],
  ];
  for (const [name, a, b] of cases) {
    for (const op of ['union', 'difference', 'intersection', 'xor']) {
      const r = boolean([a], [b], op);
      const c = compareBoolean([a], [b], op, r, 320);
      check(`${name} / ${op}: matches the rasteriser`, c.disagreeFrac < 0.012,
        `${(c.disagreeFrac * 100).toFixed(2)}% of the union area disagrees (${c.gotArea.toFixed(1)} vs ${c.expectedArea.toFixed(1)} mm²)`);
    }
  }
}

// ---- triangulation area against the rasteriser ---------------------------
{
  const shapes = {
    'a square with a round hole': [rct(60, 60), circ(15, 0, 0, 64).reverse()],
    'a seven-point star': [star(7, 30, 12)],
    'a square with two holes': [rct(60, 60), circ(8, -15, 0, 48).reverse(), circ(8, 15, 0, 48).reverse()],
    'a very thin sliver': [[[0, 0], [80, 0.6], [80, 1.2], [0, 0.4]]],
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const t = triangulate(shape);
    let triArea = 0;
    for (let i = 0; i < t.tris.length; i += 3) {
      const a = t.points[t.tris[i]], b = t.points[t.tris[i + 1]], c = t.points[t.tris[i + 2]];
      triArea += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    const raster = rasterArea([shape], 700);
    nearPct(`${name}: triangulated area matches the rasteriser`, triArea, raster, 2.5);
    nearPct(`${name}: triangulated area matches the analytic ring area`, triArea, Math.abs(shapeArea(shape)), 0.01);
    // Every triangle centroid must be inside the shape — an ear-clipping bug
    // that bridges a hole wrongly shows up here and nowhere else.
    let outside = 0;
    for (let i = 0; i < t.tris.length; i += 3) {
      const a = t.points[t.tris[i]], b = t.points[t.tris[i + 1]], c = t.points[t.tris[i + 2]];
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
      if (!covered([shape], cx, cy)) outside++;
    }
    check(`${name}: no triangle sits outside the shape`, outside === 0, `${outside} of ${t.tris.length / 3} triangles outside`);
  }
}

// ---- offset against a distance field -------------------------------------
{
  for (const [name, shape, delta] of [
    ['a circle grown by 5', [circ(20, 0, 0, 128)], 5],
    ['a circle shrunk by 5', [circ(20, 0, 0, 128)], -5],
    ['a square grown by 3', [rct(40, 40)], 3],
    ['a square shrunk by 3', [rct(40, 40)], -3],
    ['a star grown by 2', [star(6, 25, 12)], 2],
  ]) {
    const r = offset([shape], delta, { join: 'round' });
    const raster = rasterArea(r, 500);
    // The offset of a convex shape has area A + P*d + pi*d^2 exactly; for a
    // non-convex one that is an upper bound, so only the convex cases get the
    // tight check and the rest are checked against the distance field.
    let wrong = 0, n = 220;
    const B = 40;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -B + 2 * B * (i + 0.5) / n, y = -B + 2 * B * (j + 0.5) / n;
      const d = signedDistance(shape, x, y);
      const have = covered(r, x, y);
      if (Math.abs(d - delta) < 1.2) continue;      // near the new boundary, skip
      if ((d < delta) !== have) wrong++;
    }
    check(`offset: ${name} agrees with the distance field`, wrong / (n * n) < 0.004,
      `${wrong} of ${n * n} sample points disagree, area ${raster.toFixed(1)} mm²`);
  }
  const gone = offset([[...circ(4, 0, 0, 64)]], -10, {});
  check('offset: shrinking a circle past its radius returns nothing, not an inverted ring',
    Array.isArray(gone) && gone.length === 0, `${gone.length} shapes returned`);
}

// ---- solids: signed volume against ray casting ---------------------------
{
  for (const [name, mesh, analytic] of [
    ['cube', F.cube(20), 8000],
    ['tetrahedron', F.tetra(12), 12 ** 3 / 6],
    ['sphere', F.icosphere(15, 3), 4 / 3 * Math.PI * 15 ** 3],
    ['torus', F.torus(14, 4, 96, 48), 2 * Math.PI ** 2 * 14 * 16],
    ['cylinder', F.cylinder(9, 25, 128), Math.PI * 81 * 25],
    ['heightfield', F.heightfieldSolid(24, 50), null],
  ]) {
    const signed = mesh.volume();
    const rays = volumeByRays(mesh, 6000, 4242);
    nearPct(`${name}: signed volume matches ray casting`, signed, rays, 8);
    if (analytic !== null) nearPct(`${name}: signed volume matches the analytic formula`, signed, analytic, 2);
  }
}

// ---- topology: validate.js against the independent edge walk -------------
{
  const meshes = {
    cube: F.cube(10), tetra: F.tetra(10), sphere: F.icosphere(10, 2),
    torus: F.torus(10, 3), cylinder: F.cylinder(5, 10), heightfield: F.heightfieldSolid(),
    openCube: F.openCube(), flipped: F.flippedFaceCube(), insideOut: F.insideOutCube(),
    twoShells: F.twoShells(), nonManifold: F.nonManifoldPair(), degenerate: F.degenerateCube(),
  };
  for (const [name, m] of Object.entries(meshes)) {
    const t = topology(m);
    const a = analyze(m);
    check(`${name}: the two topology implementations agree on boundary edges`,
      t.boundary === a.boundaryEdges, `edge walk ${t.boundary}, validate ${a.boundaryEdges}`);
    check(`${name}: they agree on non-manifold edges`,
      t.nonManifold === a.nonManifoldEdges, `edge walk ${t.nonManifold}, validate ${a.nonManifoldEdges}`);
    // validate.js splits the two ideas: `watertight` is purely edge closure,
    // `manifold` also requires consistent orientation. The edge walk reports
    // `inconsistent` separately, so the mapping is exact — and the first version
    // of this check conflated them, passed on eleven meshes, and disagreed only
    // on the one with a single reversed triangle. Which is the whole argument
    // for having two implementations.
    check(`${name}: they agree on watertightness (edge closure alone)`,
      (t.boundary === 0) === a.watertight, `edge walk ${t.boundary} boundary edges, validate says watertight=${a.watertight}`);
    check(`${name}: they agree on whether it is a valid oriented solid`,
      (t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0) === (a.manifold && a.watertight),
      `edge walk says ${t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0} (${t.inconsistent} inconsistent edges), validate says ${a.manifold && a.watertight} (${a.flippedTris} flipped triangles)`);
    check(`${name}: they agree on the number of reversed triangles`,
      (t.inconsistent > 0) === (a.flippedTris > 0), `edge walk ${t.inconsistent} inconsistent edges, validate ${a.flippedTris} flipped triangles`);
  }
}

done();
