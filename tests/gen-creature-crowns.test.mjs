// Stitched crowns and crests: dorsal spikes as rings of the segment's own
// tube. Task 18.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, done } from './lib/assert.mjs';
import { ctx, defaults } from './lib/genconform.mjs';
import { isSolid } from './lib/meshcheck.mjs';
import { shellCount, jointGateHolds, minShellGap } from './lib/gapcheck.mjs';
import { freeSwing } from './lib/swing.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { CROWNS, crownRings, segmentsOf, spineOf, SPECIES } from '../js/gen/creature.js';

suite('gen creature crowns');

const D = defaults(gen);
const bare = { ...D, segments: 4, pose: 'straight', head: 'none', tail: 'nub', dorsal: 'none', limbPairs: 0 };

// ---------------------------------------------------------------------------
// Every crown on a bare body, at every quality: a solid, one piece per
// segment, the gap gate held, the belly on the plate.
// ---------------------------------------------------------------------------
for (const q of ['draft', 'normal', 'fine']) {
  const C = ctx(q);
  for (const dorsal of Object.keys(CROWNS)) {
    const m = Mesh.merge(segmentsOf({ ...bare, dorsal }, C));
    isSolid(`${dorsal}, ${q}`, m);
    check(`${dorsal}, ${q}: 4 segments, gap gate held`, jointGateHolds(m, 4, D.clearance),
      `${shellCount(m)} shells, ${minShellGap(m).min.toFixed(4)} mm`);
    check(`${dorsal}, ${q}: still on the plate`, Math.abs(m.bbox().min[2]) < 1e-6);
  }
}

{
  const C = ctx('normal');
  const R = D.bodyR;
  const plain = Mesh.merge(segmentsOf(bare, C)).bbox();
  for (const [dorsal, row] of Object.entries(CROWNS)) {
    const b = Mesh.merge(segmentsOf({ ...bare, dorsal }, C)).bbox();
    // The tallest tooth stands its own height over the back (tapered body:
    // measured on the first segment, where the station is a full bodyR).
    const tallest = Math.max(...row.spikes.map(s => s[1]));
    check(`${dorsal}: the crown stands proud of the back`, b.max[2] - plain.max[2] > 0.8 * tallest * R,
      `${(b.max[2] - plain.max[2]).toFixed(2)} mm for a ${(tallest * R).toFixed(1)} mm tooth`);
    check(`${dorsal}: no tooth further round than 60 degrees (its underside would overhang)`,
      row.spikes.every(s => s[0] <= 60));
    // Nested seams too: the crown rides the skin span, which nesting moves.
    const nested = Mesh.merge(segmentsOf({ ...bare, dorsal, seams: 'nested', segLen: 15 }, C));
    isSolid(`${dorsal} with nested seams`, nested);
    check(`${dorsal} with nested seams: gap gate held`, jointGateHolds(nested, 4, D.clearance),
      `${minShellGap(nested).min.toFixed(4)} mm`);
  }

  // THE OVERLAP. The peak ring's tips reach back past the end of the tooth's
  // span, out over the seam; that is what hides the gap. Zero `over` and this
  // must fail (mutation checked).
  const { stations } = spineOf(bare, C);
  const a = stations[1], b = stations[2];
  const span = { from: 2, to: 10 };
  for (const [dorsal, row] of Object.entries(CROWNS)) {
    const rings = crownRings(row, a, b, span, C, 48);
    // Along the level chord from a: the farthest point of any ring.
    const t = [b.p[0] - a.p[0], b.p[1] - a.p[1]], L = Math.hypot(...t);
    const far = Math.max(...rings.flatMap(r => r.pts.map(q => ((q[0] - a.p[0]) * t[0] + (q[1] - a.p[1]) * t[1]) / L)));
    check(`${dorsal}: the tooth tips rake back over the seam`, far - span.to > 0.4 * row.over * a.r,
      `${(far - span.to).toFixed(2)} mm past the span's end`);
  }

  // A crown costs no swing: every surface of it rides its own segment.
  for (const dorsal of Object.keys(CROWNS)) {
    const three = { ...bare, segments: 3 };
    const fb = freeSwing(three, C, 0, { max: 40 });
    const fc = freeSwing({ ...three, dorsal }, C, 0, { max: 40 });
    check(`${dorsal}: joint 0 bends as far crowned as bare`, fc.free >= fb.free, `${fc.free} vs ${fb.free} degrees (${fc.dir})`);
  }

  // The species that wear them, on nested seams: with open seams the socket's
  // booleans on every crowned segment rolled 25 to 150 bad edges a sweep.
  const by = Object.fromEntries(SPECIES.map(s => [s.id, s]));
  check('the dragon wears the crown and the lizard the crest', by.dragon.dorsal === 'crown' && by.lizard.dorsal === 'crest',
    `${by.dragon.dorsal}, ${by.lizard.dorsal}`);
  check('and both on nested seams', by.dragon.seams === 'nested' && by.lizard.seams === 'nested');
  const warns = over => gen.validate({ ...D, ...over }).filter(v => v.param === 'seams');
  check('validate() warns about a crown on open seams', warns({ dorsal: 'crown', seams: 'open' }).length === 1);
  check('FALSIFIER: and not on nested seams, nor without a crown',
    warns({ dorsal: 'crown', seams: 'nested' }).length === 0 && warns({ dorsal: 'plates', seams: 'open' }).length === 0);

  // No crown on a segment that carries legs (a leg is still a boolean). The
  // legged segment is no taller than bare; its neighbour is crowned.
  const legs = { ...bare, segments: 4, dorsal: 'crown', limbPairs: 1, limbKind: 'stub', limbAt: [0.3] };
  const tops = segmentsOf(legs, C).map(m => m.bbox().max[2]);
  const flat = segmentsOf({ ...legs, dorsal: 'none' }, C).map(m => m.bbox().max[2]);
  check('the legged segment wears no crown', Math.abs(tops[1] - flat[1]) < 1e-6, `${tops[1].toFixed(2)} vs ${flat[1].toFixed(2)}`);
  check('FALSIFIER: the segment after it does', tops[2] > flat[2] + 0.3 * R, `${tops[2].toFixed(2)} vs ${flat[2].toFixed(2)}`);
}

done();
