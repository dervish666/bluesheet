// The fit table: one place for every clearance default, with provenance.
import { check, report } from './lib/assert.mjs';
import { FIT, MEASURED, fit, fitNote } from '../js/kernel/fit.js';
import { loadGenerators } from '../js/gen/index.js';

const kinds = Object.keys(FIT);
check('the table is ordered tightest first', kinds.every((k, i) => i === 0 || FIT[k] > FIT[kinds[i - 1]]), kinds.map(k => FIT[k]).join(' '));
check('every value is a plausible FDM clearance (0.05–1 mm)', kinds.every(k => FIT[k] >= 0.05 && FIT[k] <= 1));
check('the table is frozen', Object.isFrozen(FIT));
check('fit() returns the table value', fit('board') === FIT.board);
let threw = false; try { fit('snugg'); } catch { threw = true; }
check('fit() throws on a misspelt kind rather than returning undefined', threw);
check('fitNote says "guess" until something has been measured',
  MEASURED ? true : /guess/.test(fitNote('board')), fitNote('board'));
if (MEASURED) {
  check('a measurement names its machine, material and date',
    MEASURED.machine && MEASURED.material && /^\d{4}-\d{2}-\d{2}$/.test(MEASURED.date), JSON.stringify(MEASURED));
  check('the measured kind is in the table', MEASURED.kind in FIT);
  check('the table carries the measured value', FIT[MEASURED.kind] === MEASURED.value);
}

// Every generator's fit-like parameter must default to a table value — no more
// private numbers. The list is the set of parameters R12 named, minus the three
// that only look like fits (gear root clearance is tooth geometry, datasculpt's
// gapPower is a scale, lithophane's fit is an image mode).
const { generators: gens } = await loadGenerators();
const FIT_PARAMS = {
  skadis: ['fitClearance'], nameplate: ['fitClearance'], stand: ['fit'],
  boxlid: ['clearance'], hooks: ['clearance'], terrain: ['jointFit'],
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
report('fit');
