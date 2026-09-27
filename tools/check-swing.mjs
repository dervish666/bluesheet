// How far every joint of a creature bends before its segments touch, dressed
// against bare. See tests/lib/swing.mjs for what "free" means and why it is
// not "the gap holds at full swing".
//
//   node tools/check-swing.mjs [species] [quality]      default dragon, normal
//   node tools/check-swing.mjs --falsify                prove it can go red
import gen, { segmentsOf, speciesCarries } from '../js/gen/creature.js';
import { defaultParams } from '../js/gen/index.js';
import { freeSwing } from '../tests/lib/swing.mjs';

const falsify = process.argv.includes('--falsify');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const species = args[0] || 'dragon';
const ctx = { segFactor: { draft: 0.5, normal: 1, fine: 2 }[args[1] || 'normal'] ?? 1 };
const D = defaultParams(gen);
const dressed = { ...D, species, ...speciesCarries(species), pose: 'straight' };
const bare = { ...dressed, head: 'none', tail: 'nub', dorsal: 'none', limbPairs: 0, jaw: false };

if (falsify) {
  // A joint built at zero clearance is welded: it must read 0 free, or the
  // sweep is measuring nothing.
  const welded = { ...bare, segments: 3, clearance: 0 };
  const f = freeSwing(welded, ctx, 0, { segs: segmentsOf(welded, ctx) });
  console.log(`welded joint: ${f.free} degrees free (${f.dir})`);
  console.log(f.free === 0 ? 'FALSIFY: PASS, the sweep sees a welded joint' : 'FALSIFY: FAIL, do not trust this tool');
  process.exit(f.free === 0 ? 0 : 1);
}

const joints = dressed.segments - 1;
const sd = segmentsOf(dressed, ctx), sb = segmentsOf(bare, ctx);
let worst = Infinity;
console.log(`${species}: joint  bare  dressed  (degrees free, limiting direction)`);
for (let i = 0; i < joints; i++) {
  const b = freeSwing(bare, ctx, i, { segs: sb }), d = freeSwing(dressed, ctx, i, { segs: sd });
  worst = Math.min(worst, d.free - b.free);
  console.log(`  ${String(i).padStart(2)}    ${String(b.free).padStart(3)}   ${String(d.free).padStart(3)}  ${d.free < b.free ? '<- lost ' + (b.free - d.free) + ' (' + d.dir + ')' : ''}`);
}
console.log(worst < 0 ? `RESULT: decoration costs ${-worst} degrees somewhere` : 'RESULT: every joint bends as far dressed as bare');
