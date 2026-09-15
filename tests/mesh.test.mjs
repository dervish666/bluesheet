// mesh.js — the type everything else speaks. If this is wrong, everything is.
import { suite, check, near, nearPct, nearVec, throws, done } from './lib/assert.mjs';
import { topology, isSolid, volumeAgrees } from './lib/meshcheck.mjs';
import * as F from './lib/fixtures.mjs';
import { Mesh, mat4, TAU, EPS } from '../js/kernel/mesh.js';

suite('mesh');

// ---- construction --------------------------------------------------------
{
  const m = new Mesh();
  check('empty mesh has no verts', m.vertCount === 0);
  check('empty mesh has no tris', m.triCount === 0);
  check('empty mesh reports empty', m.isEmpty());
  nearVec('empty bbox is all zeros', m.bbox().min, [0, 0, 0]);
  near('empty volume is 0', m.volume(), 0);
  check('empty STL is a valid 84-byte file', m.toSTL('e').length === 84, `${m.toSTL('e').length} bytes`);
}
{
  const m = new Mesh();
  check('addVertex returns sequential indices', m.addVertex(1, 2, 3) === 0 && m.addVertex(4, 5, 6) === 1);
  nearVec('vertex() reads back what went in', m.vertex(1), [4, 5, 6]);
  m.addVertex(7, 8, 9);
  m.addTri(0, 1, 2);
  nearVec('tri() reads back indices', m.tri(0), [0, 1, 2]);
  check('addVertices returns the index list', JSON.stringify(m.addVertices([[0,0,0],[1,1,1]])) === '[3,4]');
}
{
  const m = new Mesh();
  for (let i = 0; i < 5; i++) m.addVertex(Math.cos(i), Math.sin(i), 0);
  m.addFace([0, 1, 2, 3, 4]);
  check('addFace fan-triangulates n-3 triangles', m.triCount === 3, `${m.triCount} tris for a pentagon`);
  const m2 = new Mesh();
  m2.addVertices([[0,0,0],[1,0,0],[1,1,0],[0,1,0]]);
  m2.addQuad(0, 1, 2, 3);
  check('addQuad makes 2 triangles', m2.triCount === 2);
}
{
  const m = Mesh.polygon([[0,0,0],[10,0,0],[10,10,0],[0,10,0]]);
  check('Mesh.polygon builds a fan', m.triCount === 2 && m.vertCount === 4);
}

// ---- merge / append ------------------------------------------------------
{
  const a = F.cube(10), b = F.cube(10, { at: [20, 0, 0] });
  const m = Mesh.merge([a, b]);
  check('merge sums vertices', m.vertCount === a.vertCount + b.vertCount, `${m.vertCount}`);
  check('merge sums triangles', m.triCount === 24, `${m.triCount}`);
  near('merge sums volume', m.volume(), 2000, 1e-9);
  check('merge offsets indices correctly', Math.max(...m.tris) === m.vertCount - 1);
  check('merge skips null and empty entries', Mesh.merge([a, null, new Mesh(), b]).triCount === 24);
  const c = F.cube(10);
  c.append(F.cube(10, { at: [50, 0, 0] }));
  near('append mutates in place and keeps volume additive', c.volume(), 2000, 1e-9);
}

// ---- transforms ----------------------------------------------------------
{
  const c = F.cube(10);
  const t = c.translate(5, -3, 2);
  nearVec('translate moves the bbox centre', t.bbox().center, [5, -3, 2], 1e-12);
  near('translate preserves volume', t.volume(), 1000, 1e-9);
  check('translate does not mutate the source', c.bbox().center[0] === 0);
  nearVec('translate accepts an array', c.translate([1, 2, 3]).bbox().center, [1, 2, 3], 1e-12);

  near('uniform scale cubes the volume', c.scale(2).volume(), 8000, 1e-9);
  near('anisotropic scale multiplies the volume', c.scale(2, 3, 4).volume(), 24000, 1e-9);
  // A negative scale mirrors, which inverts winding — the mesh must flip to stay solid.
  const neg = c.scale(-1, 1, 1);
  check('negative scale re-flips winding so volume stays positive', neg.volume() > 0, `${neg.volume()}`);
  isSolid('mirrored cube', c.mirror('y'));
  throws('mirror rejects a bad axis', () => c.mirror('w'), 'bad axis');

  const r = c.rotateZ(Math.PI / 4);
  near('rotation preserves volume', r.volume(), 1000, 1e-9);
  nearPct('rotating a cube 45 degrees widens its bbox by sqrt(2)', r.bbox().size[0], 10 * Math.SQRT2, 0.001);
  near('rotateX by TAU is identity', c.rotateX(TAU).bbox().max[2], 5, 1e-9);
  const rx = F.cylinder(5, 20).rotateX(Math.PI / 2);
  nearPct('rotateX turns a Z cylinder into a Y cylinder', rx.bbox().size[1], 20, 0.001);
  const ry = F.cylinder(5, 20).rotateY(Math.PI / 2);
  nearPct('rotateY turns a Z cylinder into an X cylinder', ry.bbox().size[0], 20, 0.001);
}
{
  // transform() with an explicit matrix must agree with the named helpers.
  const c = F.cube(10);
  const m = mat4.mul(mat4.translate(3, 4, 5), mat4.rotZ(0.7));
  const viaMatrix = c.transform(m);
  const viaHelpers = c.rotateZ(0.7).translate(3, 4, 5);
  let maxDiff = 0;
  for (let i = 0; i < viaMatrix.positions.length; i++) maxDiff = Math.max(maxDiff, Math.abs(viaMatrix.positions[i] - viaHelpers.positions[i]));
  check('transform(mat4) agrees with rotateZ+translate', maxDiff < 1e-9, `max difference ${maxDiff.toExponential(2)}`);
  near('mat4 path preserves volume', viaMatrix.volume(), 1000, 1e-9);
  // A determinant-negative matrix must flip winding.
  const flipM = c.transform(mat4.scale(-1, 1, 1));
  check('transform flips winding when det < 0', flipM.volume() > 0, `${flipM.volume()}`);
  nearVec('mat4.identity leaves a point alone', F.tetra(3).transform(mat4.identity()).vertex(1), [3, 0, 0], 1e-12);
  // mat4.mul must be associative-consistent with applying twice.
  const p = [2, 3, 4];
  const a1 = mat4.rotX(0.3), a2 = mat4.rotY(-0.8), a3 = mat4.translate(1, 2, 3);
  const combined = mat4.mul(mat4.mul(a3, a2), a1);
  const stepwise = F.tetra(1).transform(a1).transform(a2).transform(a3).vertex(1);
  const oneshot = F.tetra(1).transform(combined).vertex(1);
  nearVec('mat4.mul composes in the same order as chained transforms', oneshot, stepwise, 1e-12);
  void p;
}
{
  const c = F.cube(10).translate(30, 40, 50);
  nearVec('centerXY zeroes x/y but leaves z', c.centerXY().bbox().center, [0, 0, 50], 1e-12);
  nearVec('center zeroes all three', c.center().bbox().center, [0, 0, 0], 1e-12);
  near('dropToPlate puts min z at 0', c.dropToPlate().bbox().min[2], 0, 1e-12);
  const p = c.place();
  check('place() satisfies the generator contract', Math.abs(p.bbox().center[0]) < 1e-9 && Math.abs(p.bbox().center[1]) < 1e-9 && Math.abs(p.bbox().min[2]) < 1e-9,
    `centre (${p.bbox().center[0]}, ${p.bbox().center[1]}), min z ${p.bbox().min[2]}`);
  near('flipped() negates volume', F.cube(10).flipped().volume(), -1000, 1e-9);
  const mv = F.cube(10).mapVerts((x, y, z) => [x, y, z * 2]);
  near('mapVerts reshapes', mv.bbox().size[2], 20, 1e-12);
}

// ---- topology ------------------------------------------------------------
{
  const c = F.cube(10);
  check('a hand-built cube is already welded', c.weld(1e-6).vertCount === 8, `${c.weld(1e-6).vertCount} verts`);
  // Build the same cube unwelded (24 verts) and check weld collapses it.
  const un = new Mesh();
  for (let t = 0; t < c.triCount; t++) {
    const idx = c.tri(t).map(i => un.addVertex(...c.vertex(i)));
    un.addTri(...idx);
  }
  check('weld collapses 36 duplicate verts to 8', un.weld(1e-6).vertCount === 8, `${un.vertCount} -> ${un.weld(1e-6).vertCount}`);
  near('weld preserves volume', un.weld(1e-6).volume(), 1000, 1e-9);
  check('weld drops triangles that collapse', F.degenerateCube().weld(1e-6).triCount === 12, `${F.degenerateCube().weld(1e-6).triCount}`);
  check('dropDegenerate removes the zero-area triangle', F.degenerateCube().dropDegenerate().triCount === 12);
  const withOrphan = F.cube(10);
  withOrphan.addVertex(99, 99, 99);
  check('compact removes unreferenced vertices', withOrphan.compact().vertCount === 8, `${withOrphan.vertCount} -> ${withOrphan.compact().vertCount}`);
  near('compact preserves volume', withOrphan.compact().volume(), 1000, 1e-9);
  // A weld epsilon larger than the feature must not silently destroy the solid without saying so.
  const coarse = F.cube(0.5).weld(1);
  check('an over-coarse weld collapses rather than lying', coarse.triCount === 0, `${coarse.triCount} tris left`);
}

// ---- measurement ---------------------------------------------------------
{
  near('cube volume', F.cube(10).volume(), 1000, 1e-9);
  near('cube area', F.cube(10).surfaceArea(), 600, 1e-9);
  near('tetra volume', F.tetra(6).volume(), 36, 1e-9);
  nearPct('icosphere volume approaches 4/3 pi r^3', F.icosphere(10, 4).volume(), 4 / 3 * Math.PI * 1000, 0.4);
  nearPct('torus volume approaches 2 pi^2 R r^2', F.torus(10, 3, 128, 64).volume(), 2 * Math.PI ** 2 * 10 * 9, 0.3);
  nearPct('cylinder volume approaches pi r^2 h', F.cylinder(5, 10, 256).volume(), Math.PI * 25 * 10, 0.05);
  nearPct('icosphere area approaches 4 pi r^2', F.icosphere(10, 4).surfaceArea(), 4 * Math.PI * 100, 0.3);
  // Volume must be translation-invariant: the tetrahedron sum is taken about the origin,
  // so a far-away solid is the test that catches catastrophic cancellation.
  nearPct('volume is translation invariant at 10 metres', F.cube(10).translate(10000, 10000, 10000).volume(), 1000, 0.001);
  volumeAgrees('cube', F.cube(10), 6);
  volumeAgrees('icosphere', F.icosphere(10, 3), 6);
  near('triArea of a 3-4-5 right triangle', (() => { const m = new Mesh(); m.addVertices([[0,0,0],[3,0,0],[0,4,0]]); m.addTri(0,1,2); return m.triArea(0); })(), 6, 1e-12);
  nearVec('faceNormal points +Z for a CCW triangle in the XY plane', (() => { const m = new Mesh(); m.addVertices([[0,0,0],[1,0,0],[0,1,0]]); m.addTri(0,1,2); return m.faceNormal(0); })(), [0, 0, 1], 1e-12);
}
{
  const b = F.cube(10).translate(2, 3, 4).bbox();
  nearVec('bbox min', b.min, [-3, -2, -1], 1e-12);
  nearVec('bbox max', b.max, [7, 8, 9], 1e-12);
  nearVec('bbox size', b.size, [10, 10, 10], 1e-12);
  nearVec('bbox centre', b.center, [2, 3, 4], 1e-12);
}

// ---- normals -------------------------------------------------------------
{
  const c = F.cube(10);
  const n = c.vertexNormals();
  check('vertexNormals has one per vertex', n.length === c.vertCount * 3, `${n.length / 3} normals for ${c.vertCount} verts`);
  let allUnit = true;
  for (let i = 0; i < n.length; i += 3) if (Math.abs(Math.hypot(n[i], n[i+1], n[i+2]) - 1) > 1e-5) allUnit = false;
  check('vertexNormals are unit length', allUnit);
  const sph = F.icosphere(10, 3);
  const sn = sph.vertexNormals();
  // On a sphere the smooth normal at a vertex should point away from the centre.
  let worst = 0;
  for (let v = 0; v < sph.vertCount; v++) {
    const p = sph.vertex(v), l = Math.hypot(...p);
    const dot = (p[0] / l) * sn[v*3] + (p[1] / l) * sn[v*3+1] + (p[2] / l) * sn[v*3+2];
    worst = Math.max(worst, 1 - dot);
  }
  check('sphere normals point radially outward', worst < 0.002, `worst deviation ${worst.toExponential(2)}`);
}
{
  const rb = F.cube(10).toRenderBuffers();
  check('a cube splits into 24 render vertices (crisp edges)', rb.positions.length / 3 === 24, `${rb.positions.length / 3}`);
  check('render index count matches triangles', rb.indexCount === 36, `${rb.indexCount}`);
  check('narrow meshes use Uint16 indices', rb.indices instanceof Uint16Array && rb.wide === false);
  const sph = F.icosphere(10, 3).toRenderBuffers({ crease: 89 });
  check('a smooth sphere shares its render vertices', sph.positions.length / 3 === F.icosphere(10, 3).weld(1e-5).vertCount,
    `${sph.positions.length / 3} render verts for ${F.icosphere(10, 3).weld(1e-5).vertCount} mesh verts`);
  // 81920 triangles with crease 0 means every face keeps its own vertices:
  // 245760 render verts, past the Uint16 ceiling. (The same mesh smoothed is only
  // 40962 verts, which is why the crease angle and not the triangle count decides.)
  const big = F.icosphere(10, 6);
  const bigRb = big.toRenderBuffers({ crease: 0 });
  check('wide meshes switch to Uint32 indices', bigRb.indices instanceof Uint32Array && bigRb.wide === true,
    `${bigRb.positions.length / 3} verts, ${bigRb.indices.constructor.name}`);
  let unit = true;
  for (let i = 0; i < sph.normals.length; i += 3) if (Math.abs(Math.hypot(sph.normals[i], sph.normals[i+1], sph.normals[i+2]) - 1) > 1e-4) unit = false;
  check('render normals are unit length', unit);
}

// ---- STL -----------------------------------------------------------------
{
  const c = F.cube(10);
  const stl = c.toSTL('cube');
  check('binary STL length is 84 + 50n', stl.length === 84 + 50 * 12, `${stl.length}`);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  check('triangle count sits at offset 80, little-endian', dv.getUint32(80, true) === 12, `${dv.getUint32(80, true)}`);
  const header = new TextDecoder().decode(stl.slice(0, 80));
  check('header names the object', header.startsWith('Bluesheet cube'), JSON.stringify(header.slice(0, 20)));
  check('header contains no digits that could be a clock', !/\d{4}/.test(header), JSON.stringify(header.trim()));
  // First triangle: verify the actual floats at the actual offsets.
  const n0 = [dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true)];
  const v0 = [dv.getFloat32(96, true), dv.getFloat32(100, true), dv.getFloat32(104, true)];
  nearVec('first triangle normal is the -Z face', n0, [0, 0, -1], 1e-6);
  nearVec('first triangle first vertex', v0, [-5, -5, -5], 1e-6);
  check('attribute byte count is zero', dv.getUint16(134, true) === 0);
  const a = c.toSTL('x'), b = c.toSTL('x');
  let same = a.length === b.length;
  for (let i = 0; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  check('STL export is byte-identical across two calls', same);
  const longName = c.toSTL('x'.repeat(200));
  check('an over-long name cannot overflow the header', longName.length === 84 + 50 * 12);
}

// ---- fixtures are themselves sound (they are used by every other suite) ---
{
  isSolid('fixture cube', F.cube(10), { euler: 2 });
  isSolid('fixture tetra', F.tetra(10), { euler: 2 });
  isSolid('fixture icosphere', F.icosphere(10, 3), { euler: 2 });
  isSolid('fixture torus', F.torus(10, 3), { euler: 0 });
  isSolid('fixture cylinder', F.cylinder(5, 10), { euler: 2 });
  isSolid('fixture heightfield', F.heightfieldSolid(), { euler: 2 });
  const t = topology(F.openCube());
  check('fixture openCube really has boundary edges', t.boundary === 3, `${t.boundary}`);
  check('fixture flippedFaceCube really has inconsistent winding', topology(F.flippedFaceCube()).inconsistent === 3);
  check('fixture nonManifoldPair really has non-manifold edges', topology(F.nonManifoldPair()).nonManifold === 4);
  check('fixture insideOutCube has negative volume', F.insideOutCube().volume() < 0);
  check('fixture twoShells has two shells worth of volume', Math.abs(F.twoShells().volume() - 2000) < 1e-9);
  check('all fixture builders are exported', Object.keys(F.all).length === 6, `${Object.keys(F.all).length}`);
}

// ---- constants -----------------------------------------------------------
check('TAU is 2 pi', Math.abs(TAU - 2 * Math.PI) < 1e-15);
check('EPS is small but not zero', EPS > 0 && EPS < 1e-6);
check('toString summarises the mesh', /Mesh\(8v 12t/.test(String(F.cube(10))), String(F.cube(10)));

// ---- T-junction healing --------------------------------------------------
// Built by hand rather than taken from a generator, so the test proves the
// mechanism rather than "the coaster happens to work now".
{
  // A unit square split into two triangles on one side, and on the other a
  // three-triangle fan whose shared edge carries two extra points. Geometrically
  // identical, topologically a leak: the long edge has no partner.
  const m = new Mesh();
  const a = m.addVertex(0, 0, 0), b = m.addVertex(10, 0, 0);
  const c = m.addVertex(10, 10, 0), d = m.addVertex(0, 10, 0);
  const m1 = m.addVertex(3, 0, 0), m2 = m.addVertex(7, 0, 0);   // sit ON edge a-b
  const e = m.addVertex(5, -6, 0);
  m.addTri(a, b, c); m.addTri(a, c, d);          // the un-split side
  m.addTri(a, e, m1); m.addTri(m1, e, m2); m.addTri(m2, e, b);  // the split side
  const before = topology(m);
  check('the hand-built T-junction really is open', before.boundary > 0, `${before.boundary} boundary edges`);
  const healed = m.healTJunctions();
  const after = topology(healed);
  check('healTJunctions splits the long edge at the points sitting on it',
    after.boundary < before.boundary, `${before.boundary} -> ${after.boundary} boundary edges`);
  check('healing adds triangles rather than vertices',
    healed.triCount > m.triCount && healed.vertCount <= m.weld(1e-5).vertCount,
    `${m.triCount} -> ${healed.triCount} triangles, ${m.weld(1e-5).vertCount} -> ${healed.vertCount} vertices`);
  near('healing does not change the enclosed area', healed.surfaceArea(), m.surfaceArea(), 1e-9);

  // A closed solid must come back untouched — this is safe to call unconditionally.
  for (const [name, src] of [['cube', F.cube(10)], ['sphere', F.icosphere(10, 2)], ['torus', F.torus(10, 3)]]) {
    const h = src.healTJunctions();
    check(`healTJunctions leaves a closed ${name} alone`,
      h.triCount === src.weld(1e-5).triCount && topology(h).boundary === 0,
      `${src.triCount} -> ${h.triCount} triangles`);
    near(`healing preserves the ${name}'s volume`, h.volume(), src.volume(), 1e-6);
  }
  // A genuine hole is NOT closed — healing is a seam repair, not a hole filler,
  // and quietly patching a real gap would be the worst possible behaviour.
  const holed = F.openCube(10);
  check('healTJunctions does not paper over a genuinely missing face',
    topology(holed.healTJunctions()).boundary === topology(holed).boundary,
    `${topology(holed).boundary} boundary edges before and after`);
}

done();
