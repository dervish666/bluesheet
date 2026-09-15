// The catalogue loader. Its whole job is to survive a broken generator, so most
// of these tests feed it broken generators.
import { suite, check, near, done } from './lib/assert.mjs';
import { loadGenerators, defaultParams, visibleParams, groupParams, coerce,
         validateParams, GENERATOR_IDS, CATEGORY_ORDER } from '../js/gen/index.js';

suite('registry');

check('twelve generators are declared', GENERATOR_IDS.length >= 12, `${GENERATOR_IDS.length} ids`);
check('generator ids are unique', new Set(GENERATOR_IDS).size === GENERATOR_IDS.length);
check('generator ids are slugs', GENERATOR_IDS.every(id => /^[a-z0-9-]+$/.test(id)));
check('category order covers the categories used', CATEGORY_ORDER.length >= 5);

// ---- loading -------------------------------------------------------------
{
  const { generators, failures } = await loadGenerators(['definitely-not-a-generator']);
  check('a missing module becomes a failure, not a throw', generators.length === 0 && failures.length === 1, failures[0]?.reason.slice(0, 60));
}
{
  const { generators, failures } = await loadGenerators(GENERATOR_IDS);
  check('loading the real catalogue never throws', Array.isArray(generators) && Array.isArray(failures));
  check('every loaded generator has the required keys',
    generators.every(g => g.id && g.name && g.category && g.blurb && g.params && typeof g.build === 'function'),
    `${generators.length} loaded, ${failures.length} failed`);
  check('loaded generators are sorted by category then name', (() => {
    for (let i = 1; i < generators.length; i++) {
      const a = generators[i - 1], b = generators[i];
      const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
      if (ca > cb) return false;
      if (ca === cb && a.name.localeCompare(b.name) > 0) return false;
    }
    return true;
  })(), `${generators.map(g => g.category + '/' + g.name).slice(0, 3).join(', ')}...`);
  if (failures.length) console.log(`  note: ${failures.length} generator(s) not yet written: ${failures.map(f => f.id).join(', ')}`);
}

// ---- parameter helpers ---------------------------------------------------
const fake = {
  id: 'fake', name: 'Fake', category: 'Utility', blurb: 'x'.repeat(20),
  params: [
    { key: 'w', label: 'Width', type: 'number', min: 1, max: 100, step: 0.5, def: 40, group: 'Size' },
    { key: 'n', label: 'Count', type: 'int', min: 1, max: 9, step: 1, def: 3, group: 'Size' },
    { key: 'mode', label: 'Mode', type: 'enum', def: 'a', options: [{ v: 'a', label: 'A' }, { v: 'b', label: 'B' }], group: 'Shape' },
    { key: 'lip', label: 'Lip', type: 'bool', def: true, group: 'Shape' },
    { key: 'extra', label: 'Extra', type: 'number', min: 0, max: 5, step: 0.1, def: 1, group: 'Shape', showIf: p => p.mode === 'b' },
    { key: 'name', label: 'Name', type: 'text', def: '', maxLength: 8 },
    { key: 'soft', label: 'Soft', type: 'number', min: 0, max: 10, step: 1, def: 5, soft: true },
  ],
  build: () => null,
  validate: (p) => p.w > 90 ? [{ param: 'w', message: 'too wide' }] : [],
};

{
  const d = defaultParams(fake);
  check('defaultParams reads every default', Object.keys(d).length === 7, JSON.stringify(d));
  check('defaults have the declared values', d.w === 40 && d.n === 3 && d.mode === 'a' && d.lip === true);
  check('a function default is called', defaultParams({ params: [{ key: 'k', def: () => 7 }] }).k === 7);
}
{
  const p = defaultParams(fake);
  check('showIf hides a parameter', !visibleParams(fake, p).some(q => q.key === 'extra'), `${visibleParams(fake, p).length} visible`);
  check('showIf reveals it when the condition holds', visibleParams(fake, { ...p, mode: 'b' }).some(q => q.key === 'extra'));
  check('a throwing showIf fails open rather than hiding the control',
    visibleParams({ params: [{ key: 'x', showIf: () => { throw new Error('boom'); } }] }, {}).length === 1);
  const groups = groupParams(fake, p);
  check('parameters group in declaration order', groups.map(g => g.name).join('|') === 'Size|Shape|Parameters', groups.map(g => g.name).join('|'));
  check('group members are the visible ones', groups[1].params.length === 2, `${groups[1].params.length} in Shape`);
}
{
  const w = fake.params[0], n = fake.params[1], e = fake.params[2], b = fake.params[3], t = fake.params[5], s = fake.params[6];
  near('coerce clamps a number above max', coerce(w, 1e6), 100);
  near('coerce clamps a number below min', coerce(w, -5), 1);
  near('coerce rounds to the step precision', coerce(w, 40.234), 40.2);
  near('coerce parses a string', coerce(w, '42.5'), 42.5);
  near('coerce falls back to the default on nonsense', coerce(w, 'banana'), 40);
  near('coerce rounds an int', coerce(n, 4.7), 5);
  check('coerce rejects an unknown enum value', coerce(e, 'zzz') === 'a');
  check('coerce keeps a known enum value', coerce(e, 'b') === 'b');
  check('coerce makes a bool a bool', coerce(b, 1) === true && coerce(b, 0) === false);
  check('coerce truncates text to maxLength', coerce(t, 'abcdefghijkl').length === 8);
  check('coerce leaves a soft parameter unclamped', coerce(s, 50) === 50, String(coerce(s, 50)));
}
{
  const p = defaultParams(fake);
  check('validateParams is quiet when all is well', validateParams(fake, p).length === 0);
  check("validateParams surfaces the generator's own rule", validateParams(fake, { ...p, w: 95 }).some(i => i.message === 'too wide'));
  check('validateParams warns on a soft parameter out of range', validateParams(fake, { ...p, soft: 40 }).some(i => i.param === 'soft'));
  const thrower = { params: [], validate: () => { throw new Error('kaboom'); } };
  check('a throwing validate() becomes a reported error, not a crash',
    validateParams(thrower, {}).some(i => /kaboom/.test(i.message)));
}

done();
