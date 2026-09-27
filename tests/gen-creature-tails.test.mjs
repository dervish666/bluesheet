// Lofted tails: the whip and the spade, stitched onto the last segment.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { isSolid } from './lib/meshcheck.mjs';
import { shellCount, jointGateHolds } from './lib/gapcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { TAIL_LOFTS, segmentsOf, spineOf, partsOf, reachPoints, fitToBed, speciesCarries, SPECIES } from '../js/gen/creature.js';

suite('gen creature tails');

const D = defaults(gen);
const body = (tail, over = {}) => ({ ...D, segments: 3, pose: 'straight', head: 'none', tail, dorsal: 'none', limbPairs: 0, ...over });

for (const q of ['draft', 'normal', 'fine']) {
  const C = ctx(q);
  for (const tail of Object.keys(TAIL_LOFTS)) for (const seams of ['open', 'nested']) {
    const segs = segmentsOf(body(tail, { seams }), C);
    isSolid(`${tail}, ${seams}, ${q}: the last segment`, segs.at(-1), { euler: 2 });
    check(`${tail}, ${seams}, ${q}: 3 pieces, gap gate held`, jointGateHolds(Mesh.merge(segs), 3, D.clearance));
  }
}

{
  const C = ctx('normal');
  for (const [tail, rows] of Object.entries(TAIL_LOFTS)) {
    const p = body(tail), segs = segmentsOf(p, C), last = segs.at(-1), b = last.bbox();
    const st = spineOf(p, C).stations.at(-1);
    check(`${tail}: rests on the plate`, Math.abs(b.min[2]) < 1e-6, `${b.min[2]}`);
    // The tip is a point on the plate, as far out as the loft says.
    const far = rows.at(-1)[0] * st.r;
    check(`${tail}: reaches its loft's length past the last station`, Math.abs(b.max[0] - st.p[0] - far) < 0.02 * st.r,
      `${(b.max[0] - st.p[0]).toFixed(2)} vs ${far.toFixed(2)} mm`);
    // Stitched: the last segment carries no tail part (a spike's barbs were one).
    const spans = spineOf(p, C).stations.slice(0, -1).map(() => ({ from: 0.5, to: 12 }));
    check(`${tail}: no part is unioned onto the last segment`, partsOf(p, C, spineOf(p, C).stations, spans).at(-1).length === 0);
    // The fitter measures it from its rings.
    check(`${tail}: the fitter sees the tail's own points`, reachPoints(p, C).tailLofted === true);
  }
  // The spade is a spade: past the shaft it is wider than the shaft is.
  {
    const p = body('spade'), last = segmentsOf(p, C).at(-1), st = spineOf(p, C).stations.at(-1), P = last.positions;
    let shaft = 0, blade = 0;
    for (let i = 0; i < last.vertCount; i++) {
      const z = (P[3 * i] - st.p[0]) / st.r, y = Math.abs(P[3 * i + 1] - st.p[1]) / st.r;
      if (z > 1.2 && z < 1.7) shaft = Math.max(shaft, y);
      if (z > 2.0 && z < 2.6) blade = Math.max(blade, y);
    }
    check('the spade widens to a blade past its shaft', blade > 2.5 * shaft, `blade ${blade.toFixed(2)}, shaft ${shaft.toFixed(2)} r`);
  }
  // The species that wear them keep their diagonal and fit the bed.
  const by = Object.fromEntries(SPECIES.map(s => [s.id, s]));
  check('the dragon has the spade and the lizard the whip', by.dragon.tail === 'spade' && by.lizard.tail === 'whip');
  for (const id of ['dragon', 'lizard']) {
    const p = { ...D, species: id, ...speciesCarries(id) }, Cd = ctx('draft');
    const f = fitToBed(p, Cd), bb = asMesh(gen.build(p, Cd)).bbox();
    check(`the ${id} stays diagonal and inside the bed`, f.pose === 'diagonal' && bb.size[0] <= 180 && bb.size[1] <= 180,
      `${f.pose}, ${bb.size.map(v => v.toFixed(0)).join(' x ')}`);
    check(`and the ${id} is one piece per segment`, shellCount(asMesh(gen.build(p, Cd))) === p.segments + (p.jaw ? 1 : 0));
  }
}

done();
