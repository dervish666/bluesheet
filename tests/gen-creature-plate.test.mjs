// Standing on the plate. Task 13.
//
// Every segment of a print-in-place creature is its own loose piece, so a
// segment whose underside is above the bed is started in mid-air: the
// printer lays its first layer on nothing and the piece becomes spaghetti.
// Before this task a tapered tail floated 3.6 mm (dragon) and the legs hung
// 6.5 to 14 mm below the belly, so the whole body printed on supports.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import gen, { segmentsOf, speciesCarries, SPECIES, LIMBS, PART_LIFT } from '../js/gen/creature.js';

suite('gen creature plate');

const D = defaults(gen);
const TOUCH = 0.05;   // a slicer's first layer is sampled at 0.1 mm, so this is on the bed

/** Each piece's lowest point above the plate, once the creature is placed. */
function heights(p, C) {
  const pieces = segmentsOf(p, C);
  const lows = pieces.map(m => m.bbox().min[2]);
  const floor = Math.min(...lows);
  return lows.map(z => z - floor);
}
const fmt = hs => hs.map(h => h.toFixed(2)).join(' ');

// ---------------------------------------------------------------------------
// Every segment of every species touches the plate, in every pose. The
// species rows carry the tapers, barrels and ribs, which is where a segment
// floats if the spine is at one height.
// ---------------------------------------------------------------------------
{
  const C = ctx('draft');   // heights are a property of the spine, not the tessellation
  for (const s of SPECIES) {
    for (const pose of ['straight', 'scurve', 'coil']) {
      const p = { ...D, species: s.id, ...speciesCarries(s.id), pose };
      const hs = heights(p, C);
      // Every piece, the dragon's mandible included: a lofted head's chin is
      // on the plate and the jaw is cut from it (Task 17).
      const body = s.id === 'gauge' ? hs.slice(0, 6) : hs;
      check(`${s.name}, ${pose}: every piece stands on the plate`,
        body.every(h => h <= TOUCH), fmt(body));
    }
  }

  // Was a KNOWN LIMIT: the capsule head's mandible sat 0.5 mm up, set by
  // the jaw's socket. Promoted. This proves the loop above really held a jaw.
  const dragon = { ...D, species: 'dragon', ...speciesCarries('dragon') };
  check('the dragon is measured with its mandible, one piece more than its segments',
    dragon.jaw && heights(dragon, C).length === dragon.segments + 1);
}

// ---------------------------------------------------------------------------
// Legs stand on the plate beside the body, on a flat foot, and nothing hangs
// below the belly. Measured on a straight body so "beside" is simply |y|.
// ---------------------------------------------------------------------------
{
  const C = ctx('normal');
  for (const limbKind of Object.keys(LIMBS)) {
    const body = { ...D, pose: 'straight', segments: 4, head: 'none', tail: 'nub', dorsal: 'none' };
    const bare = asMesh(gen.build(body, C));
    const m = asMesh(gen.build({ ...body, limbPairs: 1, limbKind }, C));
    check(`${limbKind}: the legs do not lift the body off the plate`,
      Math.abs(m.bbox().max[2] - bare.bbox().max[2]) < 1e-6,
      `height ${m.bbox().max[2].toFixed(3)} with legs, ${bare.bbox().max[2].toFixed(3)} without`);

    // Contact is the vertices within reach of the first layer. The belly
    // touches along y = 0; a foot is contact OUTSIDE the body's flank.
    const v = m.positions, feet = { 1: [], '-1': [] };
    for (let i = 0; i < v.length; i += 3) {
      if (v[i + 2] > PART_LIFT + 0.01) continue;
      const y = v[i + 1];
      if (Math.abs(y) > 0.5 * D.bodyR) feet[Math.sign(y)].push([v[i], y]);
    }
    for (const side of [1, -1]) {
      const pts = feet[side];
      const span = pts.length ? Math.max(...pts.map(q => q[0])) - Math.min(...pts.map(q => q[0])) : 0;
      check(`${limbKind}: the ${side > 0 ? 'right' : 'left'} foot sits flat on the plate`,
        pts.length >= 3 && span >= 1.5, `${pts.length} contact vertices over ${span.toFixed(2)} mm`);
    }
  }
}

done();
