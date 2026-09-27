// Limb reach: does a limb stay on its own segment?
//
// Its own file because the parts suite is at 296 s of run.mjs's 300 s budget
// once these are in it, and because this is one question: a limb is FUSED to
// its segment and must not come nearer to a neighbour than the joint does.
//
// The bug that made this necessary: `fin` limbs sweep 1.16 r towards the tail
// and put the SHIPPED DEFAULT creature 0.0006 mm from its next segment. It was
// invisible to everything the parts suite ran, because two shells a
// thousandth apart are still two shells and the result is still watertight,
// manifold, correctly wound and positive in volume. `isSolid` and `shellCount`
// are blind to it by construction; only `jointGateHolds` can see it, and it
// was being run on `clawed` alone — the one limb kind that passed.
// Rulings 43 to 46.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import gen, { LIMBS, DORSAL, LIMB_SPINE_REACH } from '../js/gen/creature.js';

suite('gen creature limbs');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));

{
  // `limbR` sizes a limb from LIMB_SPINE_REACH, so those numbers have to be
// what the limbs actually measure. Reshape a limb without touching the table
// and the cap goes on protecting the old shape — which is how the fin got to
// 0.0006 mm of the next segment in the first place. Measured at three radii
// because the ratio is the claim, not any single figure.
for (const [k, reach] of Object.entries(LIMB_SPINE_REACH)) {
  for (const rr of [6, 9, 13]) {
    const st2 = { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: rr, len: rr, reach: rr - 1 };
    const bb = LIMBS[k](st2, 1, D, C).bbox();
    near(`${k} reaches ${reach.fwd} r towards the tail at bodyR ${rr}`, bb.max[2] / rr, reach.fwd, 0.02);
    near(`${k} reaches ${reach.back} r towards the head at bodyR ${rr}`, -bb.min[2] / rr, reach.back, 0.02);
  }
}

}

// ---------------------------------------------------------------------------
// EVERY kind, on every shape of body — because the check above was the only
// gap check on a dressed creature and it used `clawed`, which is the one limb
// kind that passed. `fin` limbs fused the SHIPPED DEFAULT creature at 0.0006 mm
// and nothing here could see it: two shells a thousandth apart are still two
// shells, and the result is still watertight, manifold, correctly wound and
// positive in volume. `isSolid` and `shellCount` are both blind to it by
// construction. `jointGateHolds` is the only instrument that can tell, so run
// it across the whole menu rather than one entry of it. Rulings 43 to 45.
// ---------------------------------------------------------------------------
{
  const BODIES = [
    ['the default proportions', { segments: 4, bodyR: 9, segLen: 14 }],
    ['a short fat body', { segments: 4, bodyR: 13, segLen: 16 }],
    ['a thin long-segmented body', { segments: 4, bodyR: 6, segLen: 20 }],
    ['a hinge spine', { segments: 4, bodyR: 10, segLen: 13, joint: 'hinge' }],
  ];
  // There used to be two KNOWN LIMIT pins here: clawed and stub limbs on a
  // short fat body fouled the neighbour's socket sideways, which no
  // along-spine cap can see. Task 13 rooted both low on the flank, 0.56 to
  // 0.61 R off the axis, and both now measure 0.3441 mm, so the pins went red
  // as designed and were promoted into the loop.

  for (const [shape, body] of BODIES) {
    for (const limbKind of Object.keys(LIMBS)) {
      const m = build({ ...body, head: 'none', tail: 'nub', dorsal: 'none', limbPairs: 2, limbKind });
      const gap = minShellGap(m).min;
      const held = jointGateHolds(m, body.segments, D.clearance);
      const detail = `${gap === Infinity ? 'fused into one shell' : gap.toFixed(4) + ' mm'} against ` +
        `${(0.9 * D.clearance).toFixed(4)} mm needed`;
      check(`${limbKind} limbs on ${shape} leave the joint free`, held, detail);
    }
    for (const dorsal of Object.keys(DORSAL)) {
      if (dorsal === 'none') continue;
      const m = build({ ...body, head: 'none', tail: 'nub', dorsal, limbPairs: 0 });
      const gap = minShellGap(m).min;
      check(`a ${dorsal} back on ${shape} leaves the joint free`,
        jointGateHolds(m, body.segments, D.clearance),
        `${gap === Infinity ? 'fused into one shell' : gap.toFixed(4) + ' mm'}`);
    }
  }
}


done();
