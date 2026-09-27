// The species table: five animals as rows, and the row is the only source of
// its numbers.
//
// Its own file because every check here builds a whole animal and measures the
// gap on it, and the other two creature suites are already near run.mjs's
// 300 s per-file budget.
//
// EVERY ROW WAS MEASURED BEFORE IT WAS WRITTEN DOWN. There are no inherently
// safe body numbers — a joint is roughly a 1% dice roll (ruling 29) and a limb
// has to fit the segment it sits on (rulings 46, 48) — so this suite is not a
// formality. It caught the capybara at 6 x 16, which fused.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { shellCount, minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import { isSolid, onPlate, fitsBed } from './lib/meshcheck.mjs';
import gen, { SPECIES, speciesCarries, limbPositions } from '../js/gen/creature.js';

suite('gen creature species');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));

// The gauge (Task 10) will live in the same table and is not an animal: it
// sweeps its clearance across the strip, so it fails the single-clearance gap
// check below by design. Filter it out here rather than special-casing it
// later — `SPECIES.length === 5` would simply start failing the moment the
// gauge row lands, which is a confusing way to learn that.
const ANIMALS = SPECIES.filter(s => s.id !== 'gauge');

{
  check('five species ship', ANIMALS.length === 5, ANIMALS.map(s => s.id).join(', '));
  check('and a capybara is one of them', ANIMALS.some(s => s.id === 'capybara'));
  check('no scorpion — it was dropped for the capybara', !SPECIES.some(s => s.id === 'scorpion'));

  // The measured correction. 6 x 16 at bodyR 13 is a bodyR/segLen of 0.81, and
  // above about 0.75 a limb fouls the neighbouring ball sideways (ruling 48).
  // The plan wrote 16; it fused at 0.0003 mm. Pin the number so nobody
  // "restores" it from the plan without rediscovering why.
  // Since Task 20 the capybara is four fat nested slices, 4 x 28: at 6 x 20
  // nested welded its legs into the next slice, so do not go back there.
  const capy = SPECIES.find(s => s.id === 'capybara');
  check('the capybara is 4 x 28 on nested seams — not 6 x 16 (fouls its legs) nor 6 x 20 (welds nested)',
    capy.segments === 4 && capy.segLen === 28 && capy.seams === 'nested',
    `${capy.segments} x ${capy.segLen}, ${capy.seams}, ratio ${(capy.bodyR / capy.segLen).toFixed(2)}`);
  // A cheap guard on the same limit, so a future row fails here in
  // milliseconds rather than in a gap measurement. 0.80, not the 0.75 a
  // validate() warning should use: the measured boundary is BETWEEN the
  // caterpillar's 0.77 on a hinge, which builds clean at 0.3470 mm, and the
  // plan's capybara at 0.81 on a ball, which fused. Setting this at 0.75 makes
  // it disagree with a row the gap gate two blocks down says is fine, and a
  // proxy that argues with the direct measurement is noise.
  for (const s of ANIMALS) {
    check(`${s.id}'s body is a shape a limb can sit on`,
      s.limbs.pairs === 0 || s.bodyR / s.segLen <= 0.80,
      `bodyR/segLen ${(s.bodyR / s.segLen).toFixed(2)} with ${s.limbs.pairs} pairs`);
  }
}

// ---------------------------------------------------------------------------
// Every row builds the animal it claims to.
// ---------------------------------------------------------------------------
{
  const keys = new Set(gen.params.map(q => q.key));
  for (const s of ANIMALS) {
    const carried = speciesCarries(s.id);
    const bad = Object.keys(carried).filter(k => !keys.has(k) || k === 'species');
    check(`${s.id} carries only real parameters, and never itself`, bad.length === 0, bad.join(','));

    const m = build({ species: s.id, ...carried });
    isSolid(`${s.id}`, m);
    onPlate(`${s.id} rests on the plate`, m);
    fitsBed(`${s.id} fits the bed in its own pose`, m);

    // One shell per segment plus one per articulated extra — the spec's gate 4,
    // derived from the row so a new row cannot ship with the wrong count. A
    // count one low means two shells fused; that is the whole point of it.
    const extras = s.articulate.filter(a => a !== 'spine').length;
    const want = carried.segments + extras;
    check(`${s.id} is one shell per segment plus its articulated extras`, shellCount(m) === want,
      `${shellCount(m)} shells for ${carried.segments} segments + ${extras} extras`);
    // Against the row's own clearance: nested rows carry the measured 0.30.
    const c = carried.clearance;
    check(`${s.id} holds the joint gap`, jointGateHolds(m, want, c),
      `${minShellGap(m).min.toFixed(4)} mm against ${(0.9 * c).toFixed(4)} mm`);
    if (carried.seams === 'nested') {
      check(`${s.id} is built at the nested fit, not the open one`, c === 0.30 && minShellGap(m).min < 0.9 * D.clearance,
        `${c} mm, measured ${minShellGap(m).min.toFixed(4)}`);
    }
  }

  // Task 9 replaced the pin that stood here: the dragon's jaw now articulates,
  // so its row is 13 segments and 14 pieces.
  const dragon = build({ species: 'dragon', ...speciesCarries('dragon') });
  check('the dragon opens its jaw: 13 segments, 14 pieces',
    speciesCarries('dragon').jaw === true && shellCount(dragon) === 14, `${shellCount(dragon)} shells`);
}

// ---------------------------------------------------------------------------
// The menu and the presets come from the same function, so they cannot drift.
// ---------------------------------------------------------------------------
{
  for (const s of ANIMALS) {
    const preset = gen.presets.find(pr => pr.name === s.name);
    check(`${s.id} has a preset`, !!preset);
    if (preset) {
      const carried = speciesCarries(s.id);
      const drift = Object.keys(carried).filter(k => preset.values[k] !== carried[k]);
      check(`${s.id}'s preset and its menu entry agree`, drift.length === 0, drift.join(','));
      check(`${s.id}'s preset names the species too`, preset.values.species === s.id);
    }
  }
  check('no preset winds a creature to the stop',
    gen.presets.every(pr => pr.values.tight === undefined || pr.values.tight < 1),
    gen.presets.map(pr => `${pr.name}:${pr.values.tight ?? '-'}`).join(' '));
}

// ---------------------------------------------------------------------------
// The dragon is the species that exercises both joint kinds at once, which is
// the "both, per creature" decision cashed out by something that ships rather
// than by a test fixture.
// ---------------------------------------------------------------------------
{
  const dragon = SPECIES.find(s => s.id === 'dragon');
  check('the dragon curls on balls and opens on a hinge',
    dragon.joint === 'ball' && dragon.articulate.includes('jaw'),
    `${dragon.joint}, articulates ${dragon.articulate.join('+')}`);
  check('and its wings are fused, not articulated', !dragon.articulate.includes('wings'));
  // Ruling 50: the species defaults to the dragon, but the body parameters
  // stay the BARE body the structural suites were measured on. Dressing the
  // defaults put a boolean-heavy creature under every pose and profile check
  // and some of those cells always rolled bad edges. So these two facts are
  // asserted separately, and the second one is the one to revisit if the
  // remaining booleans are ever fixed (Task 7e).
  check('the species menu opens on the dragon', D.species === 'dragon');
  check('but the defaults stay the bare body, not the dressed dragon (ruling 50)',
    D.head === 'blunt' && D.limbPairs === 0 && D.dorsal === 'none' && D.segments === 12 && D.segLen === 14,
    `head ${D.head}, ${D.limbPairs} leg pairs, dorsal ${D.dorsal}, ${D.segments} x ${D.segLen}`);
  check('and the jaw stays false in the defaults (ruling 1)', D.jaw === false);
}

// ---------------------------------------------------------------------------
// Limb positions come from the row, and a caller can still override them.
// ---------------------------------------------------------------------------
{
  const cat = SPECIES.find(s => s.id === 'caterpillar');
  const at = limbPositions({ species: 'caterpillar', limbPairs: cat.limbs.pairs });
  check('a species row places its own legs', at.join(',') === cat.limbs.at.join(','), at.join(','));

  const evenly = limbPositions({ species: 'caterpillar', limbPairs: 3 });
  check('and falls back to evenly spaced when the count does not match the row',
    evenly.join(',') === '0.25,0.5,0.75', evenly.join(','));

  const override = limbPositions({ species: 'caterpillar', limbPairs: 2, limbAt: [0.1, 0.9] });
  check('an explicit limbAt still wins', override.join(',') === '0.1,0.9', override.join(','));

  check('a species with no legs asks for no positions',
    limbPositions({ species: 'snake', limbPairs: 0 }).length === 0);
}

done();
