// terrain — a place, as an object.
//
//   node tests/gen-terrain.test.mjs
//
// The shared harness proves it is a solid. What it cannot prove is that the
// solid is the right PLACE, and that is nearly all of what can go wrong here.
// Two things carry this suite:
//
//   THE SEAM. Tiles of one map must meet with no step. Not "within a tolerance"
//   — any tolerance at all is a visible cliff across a printed landscape, and it
//   is the easiest thing in this generator to break, because it only holds while
//   every constant in the vertical mapping is whole-map rather than per-tile.
//
//   THE SQUASH. A degree of longitude at 51°N is 0.63 of a degree of latitude.
//   Sample a degree box without correcting for that and every British map comes
//   out 37% too wide, looking entirely plausible while being wrong. The three
//   bundled fields are square ON THE GROUND, which means they cannot detect the
//   fault — so the test builds a degree box on purpose.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance } from './lib/genconform.mjs';
import gen, {
  groundExtent, asField, syntheticField, metresPerDegLat, metresPerDegLon, fillVoids, VOID_FLOOR,
} from '../js/gen/terrain.js';
import { triGrid, pointInsideMesh, analyze } from '../js/kernel/validate.js';
import { readFileSync } from 'node:fs';

suite('gen-terrain');

const ctx = (q = 'normal') => ({
  quality: q, segFactor: q === 'draft' ? 0.5 : q === 'fine' ? 2 : 1,
  bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {},
});
const P0 = Object.fromEntries(gen.params.map(q => [q.key, q.def]));
const asMesh = r => (r && r.mesh) ? r.mesh : r;
const ASSETS = new URL('../assets/terrain/', import.meta.url).pathname;

// ---- the shared contract ---------------------------------------------------
conformance(gen, 'terrain');

// ---- the seam --------------------------------------------------------------
{
  // Every vertex on tile 0's east face, and on tile 1's west face, keyed by Y.
  // Where the two tiles share a Y they must share a height EXACTLY — the same
  // sample of the same map, not two samples of the same place.
  const edgeHeights = (m, takeMax) => {
    const p = m.positions, b = m.bbox();
    const x = takeMax ? b.max[0] : b.min[0];
    const out = new Map();
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i] - x) > 1e-6) continue;
      const k = p[i + 1].toFixed(4);
      out.set(k, Math.max(out.get(k) ?? -Infinity, p[i + 2]));
    }
    return out;
  };

  for (const [label, cols, rows, a, b] of [
    ['side by side', 2, 1, { tileX: 0, tileY: 0 }, { tileX: 1, tileY: 0 }],
    ['four up, top row', 2, 2, { tileX: 0, tileY: 1 }, { tileX: 1, tileY: 1 }],
  ]) {
    const base = { ...P0, cols, rows, joint: 'none' };
    const mA = asMesh(gen.build({ ...base, ...a }, ctx()));
    const mB = asMesh(gen.build({ ...base, ...b }, ctx()));
    const eA = edgeHeights(mA, true), eB = edgeHeights(mB, false);
    const shared = [...eA.keys()].filter(k => eB.has(k));
    let worst = 0;
    for (const k of shared) worst = Math.max(worst, Math.abs(eA.get(k) - eB.get(k)));
    check(`${label}: the tiles actually share an edge to compare`, shared.length > 20,
      `${shared.length} samples common to both faces`);
    check(`${label}: no cliff at the seam — shared heights are identical, not merely close`,
      shared.length > 20 && worst === 0,
      `worst difference ${worst.toExponential(3)} mm over ${shared.length} samples`);
  }

  // The tiles have to cover the map, not just meet along one line. Measured with
  // the joints OFF: the default dovetail projects 2.45 mm beyond the tile body on
  // each jointed edge, so a quarter tile's bounding box is legitimately 4.9 mm
  // wider than a quarter of the map. Reading that as a coverage error is reading
  // the tab as the tile.
  const one = asMesh(gen.build({ ...P0, cols: 1, rows: 1, joint: 'none' }, ctx())).bbox();
  const quarter = asMesh(gen.build({ ...P0, cols: 2, rows: 2, tileX: 0, tileY: 0, joint: 'none' }, ctx())).bbox();
  near('a quarter tile is half the width of the whole map', quarter.size[0] * 2, one.size[0], 0.01);
  near('...and half the depth', quarter.size[1] * 2, one.size[1], 0.01);
}

// ---- the squash ------------------------------------------------------------
{
  // The bundled fields are square on the ground by construction, so they cannot
  // catch a missing correction: a squashed map of a square box is still square.
  for (const f of ['avon-gorge', 'snowdon', 'cheddar-gorge']) {
    const raw = JSON.parse(readFileSync(`${ASSETS}${f}.json`, 'utf8'));
    const ge = groundExtent(asField(raw));
    near(`${f}: the bundled field is square on the ground`, ge.w / ge.h, 1, 1e-6);
  }

  // So build a degree box on purpose. 0.1° × 0.1° at 51°N is 11.1 km north to
  // south and 7.0 km east to west; an uncorrected reading calls it square.
  const w = 60, h = 60, data = new Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 100 + 50 * Math.sin(x / 8) * Math.cos(y / 8);
  const ge = groundExtent(asField({
    name: 'Degree box at 51N', lat: 51, lon: -2.6, w, h, data,
    spanDegLat: 0.1, spanDegLon: 0.1,
  }));
  const trueAspect = metresPerDegLon(51) / metresPerDegLat(51);
  near('a degree box at 51°N is measured on the ground, not in degrees',
    ge.w / ge.h, trueAspect, 0.005);
  check('...which is the difference between a true map and one 37% too wide',
    Math.abs(ge.w / ge.h - 1) > 0.3, `aspect ${(ge.w / ge.h).toFixed(4)} against 1.0000 uncorrected`);

  // One scale for both axes: a metre east must be the same number of millimetres
  // as a metre north, or the relief leans.
  const m = asMesh(gen.build({ ...P0, size: 120 }, ctx()));
  const b = m.bbox();
  const src = groundExtent(asField(JSON.parse(readFileSync(`${ASSETS}avon-gorge.json`, 'utf8'))));
  near('the horizontal scale is isotropic: mm per metre is the same along X and Y',
    (b.size[0] / src.w) / (b.size[1] / src.h), 1, 1e-6);
  near('and the long side is the size asked for', Math.max(b.size[0], b.size[1]), 120, 0.01);
}

// ---- voids -----------------------------------------------------------------
{
  // The sentinel a real elevation API returns for "no data". Left alone it is a
  // 500 m hole; the point of filling it is that the surface stays a surface.
  const w = 40, h = 40;
  const clean = new Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) clean[y * w + x] = 200 + 3 * x + 2 * y;
  const holed = clean.slice();
  for (let y = 18; y < 23; y++) for (let x = 18; x < 23; x++) holed[y * w + x] = VOID_FLOOR;
  // fillVoids returns {data, voids, ok, maxVoidRadius} — it reports on the repair
  // as well as making it, which is what lets meta say how many voids a field had.
  const repair = fillVoids(holed.slice(), w, h);
  const filled = repair.data;
  check('fillVoids reports what it repaired as well as repairing it',
    repair.voids === 25 && repair.ok === true, `${repair.voids} voids, ok=${repair.ok}, radius ${repair.maxVoidRadius}`);
  let worstStep = 0, anyVoid = false;
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
    const a = filled[y * w + x - 1], b2 = filled[y * w + x];
    if (b2 <= VOID_FLOOR) anyVoid = true;
    worstStep = Math.max(worstStep, Math.abs(b2 - a));
  }
  check('a void is interpolated away rather than left as a hole', !anyVoid);
  check('and the filled surface has a bounded gradient, not a spike',
    worstStep < 20, `worst neighbour step ${worstStep.toFixed(1)} m across a 5×5 void in a 3 m/sample ramp`);
}

// ---- it says where the data came from --------------------------------------
{
  const bundled = gen.build({ ...P0 }, ctx()).meta;
  check('meta names the bundled field it used', bundled.data && bundled.data.kind === 'bundled',
    JSON.stringify(bundled.data).slice(0, 90));
  check('...and says so in a sentence a person can read',
    typeof bundled.data.statement === 'string' && /bundled|sample/i.test(bundled.data.statement),
    bundled.data.statement);
  check('meta carries the place and its coordinates',
    !!bundled.place && !!bundled.coordinates && Number.isFinite(bundled.coordinates.lat),
    `${bundled.place} ${bundled.coordinates && bundled.coordinates.text}`);

  const synth = syntheticField(48, 48);
  check('the synthetic ridge is a real surface, not a flat plate',
    Math.max(...synth.data) - Math.min(...synth.data) > 10,
    `${(Math.max(...synth.data) - Math.min(...synth.data)).toFixed(0)} m of range`);
}

// ---- it is the object it claims to be --------------------------------------
{
  const seen = new Map();
  for (const pr of gen.presets) {
    const m = asMesh(gen.build({ ...P0, ...pr.values }, ctx()));
    const b = m.bbox();
    seen.set(pr.name, `${m.triCount}|${b.size.map(v => v.toFixed(1)).join()}`);
  }
  check('every preset is a recognisably different object',
    new Set(seen.values()).size === gen.presets.length,
    `${new Set(seen.values()).size} distinct of ${gen.presets.length}`);

  // A flat bottom to print on, not a skirt meeting the plate at a knife edge.
  const m = asMesh(gen.build({ ...P0 }, ctx()));
  const p = m.positions;
  let onPlate = 0;
  for (let i = 2; i < p.length; i += 3) if (Math.abs(p[i]) < 1e-6) onPlate++;
  check('the plinth gives it a real bottom face', onPlate >= 4, `${onPlate} vertices on the plate`);

  const v = gen.validate({ ...P0, size: 20, relief: 0.5, vMode: 'relief' }, ctx());
  check('validate() returns an array and is willing to speak', Array.isArray(v), typeof v);

  const h = gen.hints({ ...P0 });
  check('hints() is about a terrain tile, not about generators in general',
    h && Array.isArray(h.notes) && h.notes.some(n => /relief|elevation|terrain|surface|landscape/i.test(n)),
    h && h.notes ? h.notes.length + ' notes' : 'none');
}

// ---- do two tiles actually MATE? -----------------------------------------
//
// Everything above proves a tile BUILDS. That is a different question from
// whether the tile fits the one next to it, and until now nothing asked the
// second one: the joint gate was closed on "the tabs and sockets come out of one
// function from one set of numbers, so they cannot drift apart", which is a good
// argument and not a measurement.
//
// So this assembles the pair. Interference is counted by casting rays at sample
// points and asking each tile independently whether the point is inside it —
// `pointInsideMesh`, not the joint arithmetic — so the answer does not come from
// the code under test.
//
// The sampling is fine in X (0.1 mm) and coarse in Y and Z on purpose: the thing
// being detected is a sliver whose thickness IS the quantity under test, and a
// first attempt at this sampled X at 0.45 mm, stepped clean over a 0.40 mm
// overlap and reported a perfect fit. An interference band, by contrast, runs the
// whole height of the plinth and most of the edge, so Y and Z can be cheap.
{
  const TP = { ...P0, samples: 40, cols: 2, rows: 1 };
  const pair = async (over = {}) => {
    const A = await gen.build({ ...TP, ...over, tileX: 0, tileY: 0 }, ctx());
    const B = await gen.build({ ...TP, ...over, tileX: 1, tileY: 0 }, ctx());
    const bA = asMesh(A.mesh ?? A).bbox();
    const bB = asMesh(B.mesh ?? B).bbox();
    // Align on the LATTICE edge, not the bounding box: tile A's bbox includes its
    // tab, while tile B's socket is a void and does not extend its bbox at all.
    const offX = (bA.min[0] + A.meta.tile.widthMm) - bB.min[0];
    return { A, B, mA: asMesh(A.mesh ?? A), mB: asMesh(B.mesh ?? B), offX, bA };
  };

  const overlapOf = (p, dx, dz = 0) => {
    const gA = triGrid(p.mA, { target: 3 }), gB = triGrid(p.mB, { target: 3 });
    const seamX = p.bA.min[0] + p.A.meta.tile.widthMm;
    const reach = p.A.meta.joint.depthIntoXMm || 5;
    const plinth = p.A.meta.vertical.plinthMm;
    let both = 0;
    for (let x = seamX - reach - 1; x <= seamX + reach + 1; x += 0.1)
      for (let y = -18; y <= 18; y += 2)
        for (let z = 0.4; z <= plinth - 0.4; z += 1.0)
          if (pointInsideMesh(gA, [x, y, z]) && pointInsideMesh(gB, [x - (p.offX + dx), y, z - dz])) both++;
    return both;
  };

  const dove = await pair({ joint: 'dovetail' });

  check('two tiles seated together do not interfere anywhere',
    overlapOf(dove, 0) === 0, `${overlapOf(dove, 0)} sample points inside both solids`);

  // The check above is only worth having if it CAN come back non-zero. Pushing
  // the tiles into each other must be seen, or "no interference" means nothing.
  const pushed = overlapOf(dove, -0.5);
  check('pushing the tiles 0.5 mm into each other IS detected',
    pushed > 0, `${pushed} sample points inside both solids`);

  // The dovetail's whole claim is that the pair cannot be pulled apart in the
  // plane — a neck narrower than its head. Pulling must therefore collide.
  const dovePulled = overlapOf(dove, +1.0);
  check('a dovetail resists being pulled apart in the plane',
    dovePulled > 0, `${dovePulled} sample points inside both solids`);

  // ...and that claim is specific to the dovetail. A plain tab is a rectangle and
  // slides straight out, so the same measurement must come back clean — otherwise
  // the check above is passing on something other than the dovetail's shape.
  const tab = await pair({ joint: 'tab' });
  const tabPulled = overlapOf(tab, +1.0);
  check('a plain tab, by contrast, slides straight out',
    tabPulled === 0, `${tabPulled} sample points inside both solids`);

  // The socket is cut right through, so the pair goes together vertically.
  check('the pair separates freely in Z, which is how it is assembled',
    overlapOf(dove, 0, 20) === 0, `${overlapOf(dove, 0, 20)} sample points inside both solids`);

  // A tile with no neighbour on an edge gets no joint on it, so a 1x1 tile is
  // exactly its nominal width — no tab hanging off a tile that borders nothing.
  const solo = await gen.build({ ...P0, cols: 1, rows: 1, tileX: 0, tileY: 0 }, ctx());
  nearPct('a single tile with no neighbours grows no tab',
    asMesh(solo.mesh ?? solo).bbox().size[0], solo.meta.tile.widthMm, 0.5);
}

// ---- dimension callouts: pinned to the features they measure ---------------
{
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const r = gen.build(P0, ctx());
  const b = r.mesh.bbox();
  const plinth = (r.meta.dims || []).find(d => d.param === 'plinth');
  check('plinth callout stands on the front-right foot, floor to plinth top',
    !!plinth && Math.abs(len(plinth) - P0.plinth) < 1e-6 && Math.abs(plinth.from[2]) < 1e-6
      && Math.abs(plinth.from[0] - b.max[0]) < 1e-6 && Math.abs(plinth.from[1] - b.min[1]) < 1e-6,
    plinth ? `${len(plinth).toFixed(3)} mm at (${plinth.from[0].toFixed(1)}, ${plinth.from[1].toFixed(1)})` : 'missing');
  const eng = (r.meta.dims || []).find(d => d.param === 'labelDepth');
  check('labelDepth callout goes into the front face by the engraving depth',
    !!eng && r.meta.label.face === 'front' && Math.abs(len(eng) - P0.labelDepth) < 1e-6
      && Math.abs(eng.from[1] - b.min[1]) < 1e-6 && eng.to[1] > eng.from[1] && eng.from[2] > 0 && eng.from[2] < P0.plinth,
    eng ? `${len(eng).toFixed(2)} mm from y=${eng.from[1].toFixed(2)} to ${eng.to[1].toFixed(2)} at z=${eng.from[2].toFixed(2)}` : 'missing');
  // The 2×2 wall map: the joint width is read across the far face of the +X tab.
  const pr = gen.presets.find(q => q.name.startsWith('Avon Gorge wall map'));
  const pj = { ...P0, ...pr.values };
  const rj = gen.build(pj, ctx());
  const bj = rj.mesh.bbox();
  const joint = (rj.meta.dims || []).find(d => d.param === 'jointSize');
  check('jointSize callout spans the tab across its far face on the +X edge',
    !!joint && Math.abs(len(joint) - pj.jointSize) < 1e-6 && Math.abs(joint.from[0] - bj.max[0]) < 1e-6
      && Math.abs(joint.to[0] - bj.max[0]) < 1e-6 && Math.abs(len(joint) - rj.meta.joint.widthAlongYMm) < 1e-6,
    joint ? `${len(joint).toFixed(2)} mm at x=${joint.from[0].toFixed(2)} (tab face at ${bj.max[0].toFixed(2)})` : 'missing');
}

// ---- no zero-area triangles at the defaults or any preset -----------------
// analyze() is the analysis panel's own count. healTJunctions() with
// { clean: true } fans each split triangle from a corner whose edges are whole;
// the plain fan from corner 0 laid slivers flat along the split edge (12 at the defaults).
// The ear clipper's own slivers (a near-collinear run of cap vertices clipped
// as a ~1e-15 mm² triangle) went to 0 with the 2026-10-06 poly2d fix, and the
// counts here were pinned until then; any nonzero count is a regression.
{
  for (const [name, values] of [['defaults', {}], ...gen.presets.map(p => [p.name, p.values])]) {
    const n = analyze(asMesh(gen.build({ ...P0, ...values }, ctx()))).degenerateTris;
    check(`${name}: no zero-area triangles`, n === 0, `${n} degenerate`);
  }
}

done();
