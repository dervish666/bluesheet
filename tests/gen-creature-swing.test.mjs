// How far a joint bends before its segments collide. Task 14.
//
// Its own file for run.mjs's 300 s per-file budget: each angle is a gap
// measurement on a rotated pair, and a sweep is dozens of them.
import { suite, check, done } from './lib/assert.mjs';
import { ctx, defaults } from './lib/genconform.mjs';
import { freeSwing } from './lib/swing.mjs';
import gen, { segmentsOf } from '../js/gen/creature.js';

suite('gen creature swing');

const C = ctx('normal');
const D = defaults(gen);
const bare = { ...D, segments: 3, pose: 'straight', head: 'none', tail: 'nub', dorsal: 'none', limbPairs: 0 };

// The mouth is derived to stop the stalk at the design swing (joint.js), so a
// bare ball bends to just short of it; the hinge's face is sized for its own.
const ball = freeSwing(bare, C, 0, { max: 40 });
check(`a bare ball joint bends to within 4 degrees of its ${D.swing} degree design`,
  ball.free >= D.swing - 4, `${ball.free} degrees free (${ball.dir})`);
const hinge = freeSwing({ ...bare, joint: 'hinge' }, C, 0, { max: 40 });
check(`a bare hinge bends at least its ${D.swing} degree design`,
  hinge.free >= D.swing, `${hinge.free} degrees free (${hinge.dir})`);

// FALSIFIER: at zero clearance the pair is welded, and must read 0.
const welded = { ...bare, clearance: 0 };
const w = freeSwing(welded, C, 0, { segs: segmentsOf(welded, C) });
check('FALSIFIER: a welded joint reads 0 degrees free', w.free === 0, `${w.free} degrees`);

done();
