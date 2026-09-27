// Fitting the plate, and the rules that refuse. Task 11.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { shellCount } from './lib/gapcheck.mjs';
import { isSolid } from './lib/meshcheck.mjs';
import gen, { fitToBed, reachPoints, BED, REACH_PAST_SPINE, SPECIES, speciesCarries } from '../js/gen/creature.js';

suite('gen creature fit');

const C = ctx('draft');     // fitting is about extents, and draft builds the same extents
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));
const inBed = (b) => b.size[0] <= BED.x && b.size[1] <= BED.y && b.size[2] <= BED.z;
const errs = (over, param) => gen.validate({ ...D, ...over }).filter(i => i.severity === 'error' && (!param || i.param === param));

// ---------------------------------------------------------------------------
// It folds a long animal onto the plate rather than shortening it.
// ---------------------------------------------------------------------------
{
  const long = { segments: 16, segLen: 18, pose: 'straight' };   // 288 mm of spine
  const f = fitToBed({ ...D, ...long }, C);
  check('a 288 mm straight animal is folded, not refused', f.fits && f.pose !== 'straight', JSON.stringify(f));
  const m = build(long);
  check('and the built animal really is inside the bed', inBed(m.bbox()), m.bbox().size.map(v => v.toFixed(0)).join(' x '));
  check('with all 16 segments still there', shellCount(m) === 16, `${shellCount(m)} shells`);
  isSolid('the folded animal', m);

  const h = gen.hints({ ...D, ...long });
  check('hints() says which pose it actually used', h.notes.some(n => /overflows.*prints as a (coil|S-curve)/i.test(n)), h.notes[0]);

  const own = fitToBed({ ...D, segments: 16, segLen: 18, pose: 'coil', tight: 0 }, C);
  check('a coil that overflows is wound tighter, and stays a coil', own.fits && own.pose === 'coil' && own.tightened && own.tight > 0,
    JSON.stringify(own));
  check('and hints() says it was tightened', gen.hints({ ...D, segments: 16, segLen: 18, pose: 'coil', tight: 0 }).notes.some(n => /tightened/i.test(n)));

  const fine = fitToBed(D, C);
  check('something that already fits is left exactly as asked', fine.pose === D.pose && !fine.tightened && fine.tight === D.tight,
    JSON.stringify(fine));
  check('and hints() says nothing about the pose', !gen.hints(D).notes.some(n => /overflow|tighten/i.test(n)));
}

// ---------------------------------------------------------------------------
// It refuses what no pose can fit, and names what would. The plan's own test
// expected a 24 x 26 mm spine — 624 mm — to coil into the bed. It cannot: a
// coil's inner turn is at least 2.5 segment lengths across so the joints can
// follow it, 65 mm at segLen 26, and a coil that starts that wide is past 180
// before 624 mm of it is wound. The spec's answer for that case is an error
// naming the count that would fit, so that is what is asserted.
// ---------------------------------------------------------------------------
{
  const over = { segments: 24, segLen: 26, pose: 'coil' };
  check('a 624 mm spine is refused — no pose fits it', !fitToBed({ ...D, ...over }, C).fits);
  const e = errs(over, 'segments');
  check('and the error names the count that would', e.length === 1 && /\b\d+ would\b/.test(e[0].message), e[0] && e[0].message);
  const n = Number((((e[0] && e[0].message) || '').match(/(\d+) would/) || [])[1]);   // no error -> NaN -> the next check fails cleanly
  check('that count really fits', n > 0 && fitToBed({ ...D, ...over, segments: n }, C).fits, `${n}`);
  check('and one more does not', !fitToBed({ ...D, ...over, segments: n + 1 }, C).fits, `${n + 1}`);
  const m = build(over);
  check('asked anyway, it builds as asked rather than wound to the stop for nothing',
    shellCount(m) === 24, `${shellCount(m)} shells`);
  check('hints() points at the error', gen.hints({ ...D, ...over }).notes.some(n => /too long/i.test(n)));
}

// ---------------------------------------------------------------------------
// The fitter measures the spine, not the mesh; REACH_PAST_SPINE is what makes
// that safe. Hold the real mesh to it: every species, every pose, folded or
// not — wherever the fitter says "fits", the built animal is inside the bed.
// ---------------------------------------------------------------------------
{
  let worst = 0, bad = [];
  const cases = [];
  for (const s of SPECIES) if (s.id !== 'gauge') for (const pose of ['straight', 'diagonal', 'scurve', 'coil'])
    cases.push({ ...D, species: s.id, ...speciesCarries(s.id), pose });
  cases.push({ ...D, segments: 16, segLen: 18, pose: 'straight' }, { ...D, segments: 24, pose: 'diagonal' },
             { ...D, head: 'capybara', tail: 'spike', limbPairs: 2, limbKind: 'stub', dorsal: 'plates', pose: 'straight', segments: 14 });
  for (const p of cases) {
    const f = fitToBed(p, C);
    if (!f.fits) continue;
    const b = asMesh(gen.build(p, C)).bbox();
    // The spine as the fitter sees it: the stations and a lofted head's rings.
    const r = reachPoints({ ...p, pose: f.pose, tight: f.tight }, C), q = [...r.stations.map(st => st.p), ...r.exact];
    const sx = Math.max(...q.map(s => s[0])) - Math.min(...q.map(s => s[0]));
    const sy = Math.max(...q.map(s => s[1])) - Math.min(...q.map(s => s[1]));
    worst = Math.max(worst, (b.size[0] - sx) / 2 / p.bodyR, (b.size[1] - sy) / 2 / p.bodyR);
    if (!inBed(b)) bad.push(`${p.species || '-'}/${p.pose}->${f.pose}`);
  }
  check('wherever the fitter says it fits, the built animal is inside the bed', bad.length === 0, bad.join(', '));
  check(`and the real reach past the spine stays under REACH_PAST_SPINE (${REACH_PAST_SPINE})`,
    worst < REACH_PAST_SPINE, `worst ${worst.toFixed(2)} bodyR over ${cases.length} builds`);
}

// ---------------------------------------------------------------------------
// The rules that refuse — each asserted in both directions, or it is just a
// message that always fires.
// ---------------------------------------------------------------------------
{
  check('the defaults have no errors at all', errs({}).length === 0, JSON.stringify(errs({})));
  for (const s of SPECIES) {
    check(`the ${s.id} row has no errors`, errs(speciesCarries(s.id)).length === 0,
      JSON.stringify(errs({ species: s.id, ...speciesCarries(s.id) })));
  }

  check('a clearance under the 0.15 mm floor is an error', errs({ clearance: 0.05 }, 'clearance').length === 1);
  check('and the floor itself is not', errs({ clearance: 0.15 }, 'clearance').length === 0);

  // Wall round the socket at the thinnest JOINT-BEARING station. The ball has a
  // 1.6 mm floor, so a thin tapered body runs out of wall at its narrow end.
  const thin = errs({ bodyR: 4, profile: 'tapered', clearance: 0.6 }, 'bodyR');
  check('a body too thin to keep wall round its socket is an error', thin.length === 1 && /wall/i.test(thin[0].message),
    JSON.stringify(thin));
  check('and a body with room to spare is not', errs({ bodyR: 18, profile: 'barrel' }, 'bodyR').length === 0);
  check('and the tail tip, which carries no socket, does not veto the default taper',
    errs({ bodyR: 9, profile: 'tapered', segments: 24, segLen: 7 }, 'bodyR').length === 0);

  const loose = errs({ swing: 45, bodyR: 4, clearance: 0.6 }, 'swing');
  check('a swing so wide the ball escapes is an error', loose.length === 1 && /captive|escape/i.test(loose[0].message),
    JSON.stringify(loose));
  check('and the default swing is not', errs({}, 'swing').length === 0);

  const warn = (over, param) => gen.validate({ ...D, ...over }).filter(i => i.severity === 'warning' && i.param === param);
  check('legs on a short fat body are warned about (ruling 48)', warn({ bodyR: 13, segLen: 16, limbPairs: 2 }, 'limbPairs').length === 1);
  check('the same legs on a longer body are not', warn({ bodyR: 13, segLen: 20, limbPairs: 2 }, 'limbPairs').length === 0);
  check('segments too short for their two joints are warned about (ruling 32)', warn({ segLen: 8 }, 'segLen').length === 1);
  check('and the default length is not', warn({}, 'segLen').length === 0);
}

// ---------------------------------------------------------------------------
// Cheap enough to run on every change of a slider.
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) { gen.validate({ ...D, segments: 16, segLen: 18, pose: 'straight' }); gen.hints({ ...D, segments: 16, segLen: 18, pose: 'straight' }); }
  const ms = (Date.now() - t0) / 10;
  check('validate() and hints() together cost well under a build', ms < 250, `${ms.toFixed(0)} ms`);
}

done();
