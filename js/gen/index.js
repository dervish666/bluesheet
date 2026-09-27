// The catalogue.
//
// Generators load dynamically rather than through static imports so that one
// broken module cannot take the whole application down with it — the catalogue
// simply shows the rest and reports what failed. On a tool that gains a new
// generator every time someone has an idea, that is the difference between a
// bad afternoon and a blank page.

export const GENERATOR_IDS = [
  'arm',
  'boxlid',
  'coaster',
  'comic',
  'cookiecutter',
  'creature',
  'cydmount',
  'datasculpt',
  'drawer',
  'gear',
  'gridfinity',
  'hooks',
  'lampfitter',
  'lampshade',
  'lithophane',
  'nameplate',
  'pcbcase',
  'qrplaque',
  'shelfclip',
  'skadis',
  'stand',
  'terrain',
  'vase',
];

// Designed but not built: planter, hexpanel, bracket, spool, knob, cammount and
// sundial each have a gate in gates/ and no file in this directory. `thread` has
// one too and was dropped on purpose — boxlid already carries a working threaded
// closure, so a standalone thread generator was the least valuable thing left on
// the list, and padding the count with it would have been a dishonesty.
//
// Add an id above only once its file exists. Listing a generator before it is
// written makes the loader report failures and turns a "not built yet" into a
// red integration gate for the wrong reason.

export const CATEGORY_ORDER = ['Storage', 'Utility', 'Mechanism', 'Lighting', 'Decor', 'Data', 'Kitchen', 'Toys'];

const REQUIRED = ['id', 'name', 'category', 'blurb', 'params', 'build'];

/**
 * Load every generator. Returns {generators, failures} — never throws, because a
 * catalogue that refuses to open is worse than a catalogue with a gap in it.
 */
export async function loadGenerators(ids = GENERATOR_IDS, { base = './' } = {}) {
  const settled = await Promise.allSettled(ids.map(id => import(`${base}${id}.js`)));
  const generators = [], failures = [];
  settled.forEach((r, i) => {
    const id = ids[i];
    if (r.status === 'rejected') { failures.push({ id, reason: String(r.reason && r.reason.message || r.reason) }); return; }
    const gen = r.value.default;
    if (!gen) { failures.push({ id, reason: 'module has no default export' }); return; }
    const missing = REQUIRED.filter(k => gen[k] === undefined);
    if (missing.length) { failures.push({ id, reason: `missing ${missing.join(', ')}` }); return; }
    if (gen.id !== id) { failures.push({ id, reason: `declares id "${gen.id}" but lives in ${id}.js` }); return; }
    generators.push(gen);
  });
  generators.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
    return ca !== cb ? ca - cb : a.name.localeCompare(b.name);
  });
  return { generators, failures };
}

/** Resolve a generator's declared defaults into a plain parameter object. */
export function defaultParams(gen) {
  const p = {};
  for (const q of gen.params) p[q.key] = typeof q.def === 'function' ? q.def() : q.def;
  return p;
}

/** Which parameters are currently visible, honouring showIf. */
export function visibleParams(gen, values) {
  return gen.params.filter(q => {
    if (typeof q.showIf !== 'function') return true;
    try { return !!q.showIf(values); } catch { return true; }
  });
}

/** Group visible parameters for the panel, preserving declaration order. */
export function groupParams(gen, values) {
  const groups = new Map();
  for (const q of visibleParams(gen, values)) {
    const g = q.group || 'Parameters';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(q);
  }
  return [...groups.entries()].map(([name, params]) => ({ name, params }));
}

/** Clamp and coerce a value to its parameter's declared domain. */
export function coerce(q, v) {
  switch (q.type) {
    case 'number': {
      let n = typeof v === 'number' ? v : parseFloat(v);
      if (!isFinite(n)) n = q.def;
      if (q.soft !== true) n = Math.min(q.max, Math.max(q.min, n));
      const dp = q.precision ?? decimalsOf(q.step);
      return Math.round(n * 10 ** dp) / 10 ** dp;
    }
    case 'int': {
      let n = Math.round(typeof v === 'number' ? v : parseFloat(v));
      if (!isFinite(n)) n = q.def;
      return Math.min(q.max, Math.max(q.min, n));
    }
    case 'bool': return !!v;
    case 'enum': return q.options.some(o => o.v === v) ? v : q.def;
    case 'text': return String(v ?? '').slice(0, q.maxLength ?? 128);
    default: return v;
  }
}

function decimalsOf(step) {
  if (!isFinite(step)) return 2;
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
}

/** Cross-parameter validation, merging the generator's own rules. */
export function validateParams(gen, values) {
  const issues = [];
  for (const q of gen.params) {
    if ((q.type === 'number' || q.type === 'int') && q.soft) {
      const v = values[q.key];
      if (v < q.min || v > q.max) issues.push({ param: q.key, severity: 'warn', message: `${q.label} is outside the tested range ${q.min}–${q.max}${q.unit ? ' ' + q.unit : ''}` });
    }
  }
  if (typeof gen.validate === 'function') {
    try { for (const i of gen.validate(values) || []) issues.push({ severity: 'error', ...i }); }
    catch (e) { issues.push({ severity: 'error', message: `validate() threw: ${e.message}` }); }
  }
  return issues;
}
