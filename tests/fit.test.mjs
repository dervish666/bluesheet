// The fit table: one place for every clearance default, with provenance.
import { check, near, throws, report } from './lib/assert.mjs';
import { FIT, MEASURED, fit, fitNote, measured } from '../js/kernel/fit.js';
import { loadGenerators } from '../js/gen/index.js';

const kinds = Object.keys(FIT);
// Non-decreasing, not strictly increasing: two kinds may share a value when
// they are different questions that happen to start from the same guess —
// `board` (a tab through a pegboard slot) and `free` (a print-in-place gap)
// both measured 0.35 on the same printer, by different gauges.
check('the table is ordered tightest first', kinds.every((k, i) => i === 0 || FIT[k] >= FIT[kinds[i - 1]]), kinds.map(k => FIT[k]).join(' '));
check('every value is a plausible FDM clearance (0.05–1 mm)', kinds.every(k => FIT[k] >= 0.05 && FIT[k] <= 1));
check('the table is frozen', Object.isFrozen(FIT));
check('fit() returns the table value', fit('board') === FIT.board);
let threw = false; try { fit('snugg'); } catch { threw = true; }
check('fit() throws on a misspelt kind rather than returning undefined', threw);
// Measurements are a list: one per fit kind a print has confirmed.
check('MEASURED is a frozen list', Array.isArray(MEASURED) && Object.isFrozen(MEASURED));
for (const m of MEASURED) {
  check(`${m.kind}: a measurement names its machine, material and date`,
    m.machine && m.material && /^\d{4}-\d{2}-\d{2}$/.test(m.date), JSON.stringify(m));
  check(`${m.kind}: the measured kind is in the table`, m.kind in FIT);
  check(`${m.kind}: the table carries the measured value`, FIT[m.kind] === m.value);
  check(`${m.kind}: fitNote says it was measured`, /measured on/.test(fitNote(m.kind)), fitNote(m.kind));
}
check('at most one measurement per kind', new Set(MEASURED.map(m => m.kind)).size === MEASURED.length);
const measuredKinds = new Set(MEASURED.map(m => m.kind));
for (const k of kinds) if (!measuredKinds.has(k)) check(`${k}: fitNote says "guess" until measured`, /guess/.test(fitNote(k)), fitNote(k));
// The two prints that have measured something on this machine.
check('the pegboard fit is measured (Skådis, 2026-09-03)', measuredKinds.has('board'));
check('the nested-seam joint is measured (nested creature gauge, 2026-09-24)', measuredKinds.has('nested') && FIT.nested === 0.30);
check('the friction-lid fit is measured (Pi 3 B+ case lid, 2026-09-15)', measuredKinds.has('press') && MEASURED.find(m => m.kind === 'press').value === 0.10);

// Every generator's fit-like parameter must default to a table value — no more
// private numbers. The list is the set of parameters R12 named, minus the three
// that only look like fits (gear root clearance is tooth geometry, datasculpt's
// gapPower is a scale, lithophane's fit is an image mode).
const { generators: gens } = await loadGenerators();
const FIT_PARAMS = {
  skadis: ['fitClearance'], nameplate: ['fitClearance'], stand: ['fit'],
  boxlid: ['clearance'], hooks: ['clearance'], terrain: ['jointFit'], pcbcase: ['lidFit'],
  gear: ['boreClear'], drawer: ['clearance', 'jointFit'],
};
const values = new Set(Object.values(FIT));
for (const [id, keys] of Object.entries(FIT_PARAMS)) {
  const g = gens.find(x => x.id === id);
  check(`${id} is in the catalogue`, !!g);
  if (!g) continue;
  for (const key of keys) {
    const p = g.params.find(q => q.key === key);
    check(`${id}.${key} exists`, !!p);
    if (p) check(`${id}.${key} defaults to a value from the fit table (${p.def})`, values.has(p.def), String(p.def));
  }
}
// The print-in-place gap. Every other kind in the table is a gap between a
// printed face and something inserted into it by hand; this is the only one
// where both faces are extruded in the same job, against each other, and the
// failure mode is fusion rather than looseness.
{
  check('there is a fit kind for a print-in-place joint', 'free' in FIT);
  near('and it starts at the community figure for a 0.4 mm nozzle', FIT.free, 0.35, 1e-9);
  // Measured 2026-09-23 on the creature Joint gauge. The value did not move,
  // so what these pin is the provenance: a MEASURED entry whose value is the
  // table's, and a help string that stops calling it a guess.
  check('it is measured, by the creature joint gauge', measured('free') !== null
    && measured('free').value === FIT.free, JSON.stringify(measured('free')));
  check('and fitNote says so rather than calling it a guess',
    !/guess/.test(fitNote('free')) && /measured/.test(fitNote('free')), fitNote('free'));
  throws('an unknown kind still throws rather than becoming a press fit',
    () => fit('freee'), 'unknown fit kind');
}

report('fit');
