// Nested seams: segments that cup one another round the ball. Task 15.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { isSolid } from './lib/meshcheck.mjs';
import { minShellGap, shellCount, jointGateHolds } from './lib/gapcheck.mjs';
import { freeSwing } from './lib/swing.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { segmentsOf, speciesCarries, gaugeSteps } from '../js/gen/creature.js';

suite('gen creature seams');

const D = defaults(gen);
const bare = { ...D, segments: 4, pose: 'straight', head: 'none', tail: 'nub', dorsal: 'none', limbPairs: 0 };

// The seam on the skin, measured off the mesh: on a straight body along x,
// the gap between where segment 0's skin ends and segment 1's begins. Skin is
// every vertex within 2% of the body radius of the outside.
function seamWidth(p, C) {
  const segs = segmentsOf(p, C);
  const skinX = (m, pick) => {
    const v = m.positions, R = p.bodyR, xs = [];
    // The body axis sits at the station height (= its radius) on y = 0.
    for (let i = 0; i < v.length; i += 3) {
      const rho = Math.hypot(v[i + 1], v[i + 2] - R);
      if (rho > 0.98 * R) xs.push(v[i]);
    }
    return pick(...xs);
  };
  const a = skinX(segs[0], Math.max), b = skinX(segs[1], Math.min);
  return b - a;
}

// ---------------------------------------------------------------------------
// The bare body, nested, at every quality: a solid, one shell per segment,
// the aligned-facet gap, and a seam on the skin instead of a gap.
// ---------------------------------------------------------------------------
for (const q of ['draft', 'normal', 'fine']) {
  const C = ctx(q);
  const m = asMesh(gen.build({ ...bare, seams: 'nested' }, C));
  isSolid(`nested, ${q}`, m);
  check(`nested, ${q}: 4 segments are 4 pieces`, shellCount(m) === 4, `${shellCount(m)} shells`);
  check(`nested, ${q}: the gap gate holds`, jointGateHolds(m, 4, D.clearance), `${minShellGap(m).min.toFixed(4)} mm`);
}
{
  const C = ctx('normal');
  const m = asMesh(gen.build({ ...bare, seams: 'nested' }, C));
  near('nested at normal reads the aligned-facet gap, as the open joint does', minShellGap(m).min, 0.3441, 0.004);

  const open = seamWidth({ ...bare, seams: 'open' }, C), nested = seamWidth({ ...bare, seams: 'nested' }, C);
  check('FALSIFIER: the open seam measures as the 4 mm gap it is', open > 3.5, `${open.toFixed(2)} mm`);
  check('the nested seam on the skin is under 1.2 mm', nested > 0 && nested < 1.2, `${nested.toFixed(2)} mm`);

  // Clearance zero welds it: the gate must be able to fail on nested seams.
  const welded = asMesh(gen.build({ ...bare, seams: 'nested', clearance: 0 }, C));
  check('FALSIFIER: nested at zero clearance fails the gap gate', !jointGateHolds(welded, 4, D.clearance),
    `${shellCount(welded)} shells`);

  // Every surface is concentric with the pivot, so it bends as far as open.
  const three = { ...bare, segments: 3 };
  const fo = freeSwing({ ...three, seams: 'open' }, C, 0, { max: 40 });
  const fn = freeSwing({ ...three, seams: 'nested' }, C, 0, { max: 40 });
  check('a nested joint bends as far as an open one', fn.free >= fo.free, `nested ${fn.free}, open ${fo.free} degrees`);
}

// ---------------------------------------------------------------------------
// The species that have room, dressed. And the one that does not.
// ---------------------------------------------------------------------------
{
  const C = ctx('normal');
  for (const id of ['dragon', 'lizard', 'capybara']) {
    const p = { ...D, species: id, ...speciesCarries(id), seams: 'nested' };
    const m = asMesh(gen.build(p, C));
    const n = p.segments + (p.jaw ? 1 : 0);
    isSolid(`${id} nested`, m);
    check(`${id} nested: every segment its own piece, gap gate held`, jointGateHolds(m, n, p.clearance),
      `${shellCount(m)} of ${n} shells, ${minShellGap(m).min.toFixed(4)} mm`);
  }

  // Was a KNOWN LIMIT: at 6 x 20 on a 13 mm body the capybara's legs welded
  // nested. The row is 4 x 28 now (Task 20) and sits in the loop above; the
  // warning still fires for a body that short.
  const short = { ...D, species: 'capybara', ...speciesCarries('capybara'), segments: 6, segLen: 20 };
  check('validate() still warns about 20 mm nested segments on a 13 mm body',
    gen.validate(short).some(v => v.param === 'segLen' && /Nested seams/.test(v.message)));

  // THE NESTED SPECIES BEND. The shells are concentric but faceted, so a
  // turned dome cuts into the gap by the facets' sag; the latitudes have a
  // floor (NESTED_LATITUDES) for that. Every nested row, bare, at normal.
  for (const id of ['dragon', 'lizard', 'capybara']) {
    const p = { ...D, species: id, ...speciesCarries(id), pose: 'straight', head: 'none', tail: 'nub',
                limbPairs: 0, dorsal: 'none', segments: 3 };
    const f = freeSwing(p, C, 0, { max: 40 });
    check(`${id}: a nested joint bends 20 degrees or more`, f.free >= 20, `${f.free} degrees (${f.dir})`);
  }
  {
    const D2 = ctx('draft');
    const bareOf = id => ({ ...D, species: id, ...speciesCarries(id), pose: 'straight', head: 'none', tail: 'nub',
                            limbPairs: 0, dorsal: 'none', segments: 3 });
    // At draft too, for a 9 mm body: 6 latitudes stopped it at 12 degrees.
    const fd = freeSwing(bareOf('dragon'), D2, 0, { max: 40 });
    check('the dragon bends 20 degrees at draft as well (the latitude floor)', fd.free >= 20, `${fd.free} degrees`);
    // KNOWN LIMIT, pinned: draft's 12 points round a ring sag 0.5 mm on the
    // capybara's 16 mm dome, more than the gap. Draft is for scrubbing, not
    // slicing (the quality menu says so). If this goes red, promote it.
    const fc = freeSwing(bareOf('capybara'), D2, 0, { max: 40 });
    check('KNOWN LIMIT: the capybara binds early at draft', fc.free < 20, `${fc.free} degrees`);
  }
}

// ---------------------------------------------------------------------------
// The strip print: the nested gauge. Five clearances on the ball AND on the
// dome and cup, each read on its own pair.
// ---------------------------------------------------------------------------
{
  const C = ctx('normal');
  const pre = gen.presets.find(q => /nested/i.test(q.name));
  check('there is a nested gauge preset', !!pre, gen.presets.map(q => q.name).join(', '));
  const p = { ...D, ...pre.values };
  const segs = segmentsOf(p, C);
  check('the nested gauge is six pieces', shellCount(Mesh.merge(segs)) === 6, `${shellCount(Mesh.merge(segs))}`);
  const steps = gaugeSteps(p);
  segs.slice(0, -1).forEach((s, i) => {
    const g = minShellGap(Mesh.merge([s, segs[i + 1]])).min;
    check(`joint ${i} reads its own step (${steps[i]} mm) to within 3%`, Math.abs(g / steps[i] - 1) < 0.03,
      `${g.toFixed(4)} mm`);
  });
}

done();
