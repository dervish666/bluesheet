// The joint gauge: not a creature, a measuring instrument that happens to be
// the same machine. Six segments, five joints, five clearances centred on the
// current one, each number embossed on the segment just behind its gap.
//
// This strip is the only thing that can settle FIT.free. Everything here is
// about whether it measures what it claims to — that the five gaps really are
// five different gaps, in order, at the sizes printed on them.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { shellCount, minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import { isSolid, onPlate, fitsBed } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { gaugeSteps, speciesCarries, segmentsOf, SPECIES } from '../js/gen/creature.js';

suite('gen creature gauge');

const C = ctx('normal');
const D = defaults(gen);
const G = { ...D, species: 'gauge', ...speciesCarries('gauge') };
const build = (over = {}) => asMesh(gen.build({ ...G, ...over }, C));

// ---------------------------------------------------------------------------
// The steps.
// ---------------------------------------------------------------------------
{
  const at = (c) => gaugeSteps({ clearance: c });
  const s = at(0.35);
  check('five steps at the 0.35 default: 0.25 to 0.45', s.join(',') === '0.25,0.3,0.35,0.4,0.45', s.join(', '));
  for (const c of [0.15, 0.2, 0.55, 0.6]) {
    const t = at(c);
    check(`re-gauging at ${c} stays inside the parameter's 0.15-0.6`, t.every(v => v >= 0.15 - 1e-9 && v <= 0.6 + 1e-9), t.join(', '));
    check(`and still prints five DIFFERENT gaps there — shifted, not clipped`,
      new Set(t).size === 5 && t.every((v, i) => i === 0 || Math.abs(v - t[i - 1] - 0.05) < 1e-9), t.join(', '));
    check(`and the clearance asked for is one of them`, t.some(v => Math.abs(v - c) < 1e-9), t.join(', '));
  }
}

// ---------------------------------------------------------------------------
// The strip.
// ---------------------------------------------------------------------------
{
  const m = build();
  isSolid('the gauge', m);
  onPlate('the gauge', m);
  fitsBed('the gauge', m);
  check('six pieces — five gaps between them', shellCount(m) === 6, `${shellCount(m)} shells`);
  const b = m.bbox();
  // 70.3 mm, not the spec's "roughly 40": bodyR 9 to gauge the joint the
  // creatures actually have, and six 11 mm segments is the shortest strip
  // whose joints clear their floor at that radius. Ruling 54.
  check('a strip, lying straight, a small quick print',
    b.size[0] <= 72 && b.size[1] <= 20 && b.size[0] > 3 * b.size[1], `${b.size.map(v => v.toFixed(1)).join(' x ')} mm`);
  // The numbers stand 0.6 mm proud of the crown. If the font failed to load
  // or the labels stopped being built, the strip is exactly a body tall.
  near('the numbers are there: 0.6 mm proud of an 18 mm body', b.size[2], 2 * G.bodyR + 0.6, 0.05);
}

// ---------------------------------------------------------------------------
// FIVE DIFFERENT GAPS, IN ORDER, AT THE SIZES PRINTED. The whole instrument.
// Measured pair by pair: the global minimum only ever sees the tightest joint
// and would read the same whether the other four were right or all identical.
// ---------------------------------------------------------------------------
{
  const segs = segmentsOf(G, C), steps = gaugeSteps(G);
  const gaps = steps.map((_, i) => minShellGap(Mesh.merge([segs[i], segs[i + 1]])).min);
  for (let i = 0; i < steps.length; i++) {
    // 98.3% of nominal is the faceting every ball joint here reads at normal
    // quality (0.3441 on 0.35); the tolerance is that, not slack.
    near(`joint ${i + 1} is the ${steps[i].toFixed(2)} mm its number says`, gaps[i], 0.983 * steps[i], 0.004);
  }
  check('and they rise joint by joint, so the strip reads in order',
    gaps.every((g, i) => i === 0 || g > gaps[i - 1] + 0.04), gaps.map(g => g.toFixed(4)).join(' < '));

  // The Task 6 gap gate, made explicit rather than silent: the gauge is SUPPOSED
  // to hold gaps tighter than the clearance set. Held against that clearance
  // it must fail, or the tight end of the sweep is not really tight; held
  // against its own tightest step it must pass.
  const m = build();
  check('the gauge goes tighter than the clearance set — the gate against 0.35 fails, as it should',
    !jointGateHolds(m, 6, G.clearance), `${minShellGap(m).min.toFixed(4)} mm`);
  check('and holds against its own tightest step', jointGateHolds(m, 6, steps[0]), `${minShellGap(m).min.toFixed(4)} mm`);
}

// ---------------------------------------------------------------------------
// A gauge is a gauge, whatever else is set.
// ---------------------------------------------------------------------------
{
  const m = build({ pose: 'coil', tight: 1, head: 'dragon', jaw: true, limbPairs: 4, limbKind: 'fin', dorsal: 'plates', segments: 14 });
  check('coiled, headed, legged and fourteen long on paper, it still builds six straight pieces',
    shellCount(m) === 6 && m.bbox().size[0] > 3 * m.bbox().size[1], `${shellCount(m)} shells, ${m.bbox().size.map(v => v.toFixed(0)).join(' x ')}`);
  const hinge = build({ joint: 'hinge' });
  check('a hinge gauge is a gauge too — six pieces', shellCount(hinge) === 6, `${shellCount(hinge)}`);
  isSolid('the hinge gauge', hinge);
}

// ---------------------------------------------------------------------------
// It reaches the UI like a species, and has a preset.
// ---------------------------------------------------------------------------
{
  check('the gauge is a row in the species table', SPECIES.some(s => s.id === 'gauge'));
  const preset = gen.presets.find(pr => pr.values.species === 'gauge');
  check('with a preset of its own', !!preset, preset && preset.name);
  const carried = speciesCarries('gauge');
  check('which agrees with the menu', preset && Object.keys(carried).every(k => preset.values[k] === carried[k]));
  check('and gauges the default creature\'s own joint — bodyR 9, not a toy ball',
    carried.bodyR === D.bodyR, `gauge ${carried.bodyR}, default ${D.bodyR}`);
}

done();
