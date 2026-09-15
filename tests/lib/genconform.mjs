// The contract, executable.
//
// Every generator is held to this same harness, so "it works" means the same
// thing for all twelve of them. The gate that earns its keep is the parameter
// sweep: a generator that only produces a watertight solid at its default
// values is the commonest way this kind of catalogue rots, and no amount of
// looking at the default preview finds it.
import { check } from './assert.mjs';
import { isSolid, onPlate, centredXY, fitsBed, topology } from './meshcheck.mjs';
import { Mesh } from '../../js/kernel/mesh.js';

const CATEGORIES = ['Storage', 'Decor', 'Utility', 'Data', 'Kitchen', 'Toys', 'Mechanism'];
const TYPES = ['number', 'int', 'enum', 'bool', 'text', 'image', 'field', 'series', 'vec2', 'color'];

export const BED = { x: 180, y: 180, z: 180 };

export function ctx(quality = 'normal', extra = {}) {
  const segFactor = { draft: 0.5, normal: 1, fine: 2 }[quality] ?? 1;
  return {
    quality, segFactor, bed: BED, nozzle: 0.4, layerH: 0.2,
    log: () => {}, progress: () => {}, signal: null, ...extra,
  };
}

export function defaults(gen) {
  const p = {};
  for (const q of gen.params) p[q.key] = typeof q.def === 'function' ? q.def() : q.def;
  return p;
}

function asMesh(r) {
  if (r instanceof Mesh) return r;
  if (r && r.mesh instanceof Mesh) return r.mesh;
  if (r && Array.isArray(r.parts) && r.parts.length) return Mesh.merge(r.parts.map(p => p.mesh));
  return null;
}

/** A deterministic stand-in for an uploaded photo, so image generators are testable. */
export function testImage(w = 96, h = 96) {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / (w - 1), v = y / (h - 1);
    // A gradient plus a disc plus a hard edge: covers smooth, curved and step.
    let g = 0.25 + 0.5 * u;
    if (Math.hypot(u - 0.35, v - 0.6) < 0.18) g = 0.95;
    if (v > 0.85) g = 0.05;
    gray[y * w + x] = g;
  }
  return { w, h, gray, name: 'test-pattern' };
}

/** A deterministic stand-in for fetched elevation data. */
export function testField(w = 64, h = 64) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w * 6, v = y / h * 6;
    data[y * w + x] = 120 + 90 * Math.sin(u) * Math.cos(v) + 30 * Math.sin(u * 2.7 + 1.3);
  }
  return { w, h, data, meta: { name: 'Test Ridge', minM: 30, maxM: 240, spanKm: 8, lat: 51.45, lon: -2.59 } };
}

export function testSeries(n = 60) {
  const out = [];
  let s = 12345;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out.push((s / 0x7fffffff) * 100); }
  return out;
}

function sampleValue(q, which) {
  switch (q.type) {
    case 'number': case 'int': return which === 'min' ? q.min : q.max;
    case 'enum': return null;   // handled separately
    case 'bool': return which === 'min' ? false : true;
    case 'text': return which === 'min' ? 'A' : (q.maxLength ? 'W'.repeat(Math.min(q.maxLength, 24)) : 'Wide Text');
    case 'image': return testImage(which === 'min' ? 24 : 160, which === 'min' ? 24 : 120);
    case 'field': return testField(which === 'min' ? 16 : 128, which === 'min' ? 16 : 128);
    case 'series': return testSeries(which === 'min' ? 3 : 240);
    case 'vec2': return which === 'min' ? q.min : q.max;
    default: return undefined;
  }
}

/**
 * Run the whole contract against a generator module.
 * `filename` is the basename without extension, to prove id and file agree.
 */
export function conformance(gen, filename, opts = {}) {
  const { sweep = true, timeLimitMs = 3000, maxTris = 500000, resolve = {} } = opts;
  const c = ctx('normal');

  // ---- module shape -------------------------------------------------------
  check('id is a slug', typeof gen.id === 'string' && /^[a-z0-9-]+$/.test(gen.id), `"${gen.id}"`);
  check('id matches the filename', gen.id === filename, `id "${gen.id}" vs file "${filename}"`);
  check('has a human name', typeof gen.name === 'string' && gen.name.length > 2 && gen.name.length < 40, `"${gen.name}"`);
  check('category is one of the known set', CATEGORIES.includes(gen.category), `"${gen.category}" not in ${CATEGORIES.join('|')}`);
  check('blurb is one short sentence', typeof gen.blurb === 'string' && gen.blurb.length > 10 && gen.blurb.length <= 140, `${gen.blurb?.length} chars`);
  check('has a description', typeof gen.description === 'string' && gen.description.length > 60, `${gen.description?.length} chars`);
  check('has a version number', typeof gen.version === 'number');
  check('build is a function', typeof gen.build === 'function');

  // ---- parameter schema ---------------------------------------------------
  check('has parameters', Array.isArray(gen.params) && gen.params.length >= 3, `${gen.params?.length} params`);
  const seen = new Set();
  let schemaOk = true;
  for (const q of gen.params || []) {
    const where = `param "${q.key}"`;
    if (!q.key || seen.has(q.key)) { check(`${where}: key is present and unique`, false); schemaOk = false; continue; }
    seen.add(q.key);
    if (!q.label) { check(`${where}: has a label`, false); schemaOk = false; }
    if (!TYPES.includes(q.type)) { check(`${where}: type "${q.type}" is known`, false); schemaOk = false; }
    if (q.def === undefined && !['image', 'field', 'series'].includes(q.type)) { check(`${where}: has a default`, false); schemaOk = false; }
    if (q.type === 'number' || q.type === 'int') {
      if (!(typeof q.min === 'number' && typeof q.max === 'number' && q.min < q.max)) { check(`${where}: has a sane min/max`, false, `${q.min}..${q.max}`); schemaOk = false; }
      else if (!(q.def >= q.min && q.def <= q.max)) { check(`${where}: default is inside min/max`, false, `${q.def} not in ${q.min}..${q.max}`); schemaOk = false; }
      if (!(typeof q.step === 'number' && q.step > 0)) { check(`${where}: has a step`, false, String(q.step)); schemaOk = false; }
    }
    if (q.type === 'enum') {
      const ok = Array.isArray(q.options) && q.options.length >= 2 && q.options.every(o => o && o.v !== undefined && o.label);
      if (!ok) { check(`${where}: options are well formed`, false); schemaOk = false; }
      else if (!q.options.some(o => o.v === q.def)) { check(`${where}: default is one of the options`, false, String(q.def)); schemaOk = false; }
    }
    if (q.showIf !== undefined && typeof q.showIf !== 'function') { check(`${where}: showIf is a function`, false); schemaOk = false; }
  }
  check('every parameter is well formed', schemaOk, `${seen.size} parameters`);
  check('parameters are grouped for the panel', (gen.params || []).every(q => !q.group || typeof q.group === 'string'));
  const helped = (gen.params || []).filter(q => q.help).length;
  check('most parameters explain themselves', helped >= Math.ceil((gen.params?.length || 0) * 0.5), `${helped}/${gen.params?.length} have help text`);

  // ---- the default build --------------------------------------------------
  const p0 = { ...defaults(gen), ...resolve };
  for (const q of gen.params || []) {
    if (p0[q.key] === undefined || p0[q.key] === null) {
      if (q.type === 'image') p0[q.key] = testImage();
      else if (q.type === 'field') p0[q.key] = testField();
      else if (q.type === 'series') p0[q.key] = testSeries();
    }
  }
  const frozen = JSON.stringify(Object.fromEntries(Object.entries(p0).filter(([, v]) => typeof v !== 'object')));
  const t0 = process.hrtime.bigint();
  let m0 = null, err = null;
  try { m0 = asMesh(gen.build(p0, c)); } catch (e) { err = e; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!check('builds at its defaults', !!m0, err ? `threw: ${err.message}` : 'returned no Mesh')) return { ok: false };
  check('build does not mutate its parameters', JSON.stringify(Object.fromEntries(Object.entries(p0).filter(([, v]) => typeof v !== 'object'))) === frozen);
  check(`default build is fast enough (${ms.toFixed(0)} ms)`, ms < timeLimitMs, `${ms.toFixed(0)} ms, limit ${timeLimitMs}`);
  check('triangle count is sane', m0.triCount > 8 && m0.triCount < maxTris, `${m0.triCount} triangles`);

  isSolid('default build', m0);
  onPlate('default build', m0, 1e-6);
  centredXY('default build', m0, 1e-3);
  fitsBed('default build', m0, BED);
  const b = m0.bbox();
  check('default build is a real object, not a speck', Math.min(b.size[0], b.size[1], b.size[2]) > 0.4 && Math.max(...b.size) > 8,
    `${b.size.map(v => v.toFixed(1)).join(' × ')} mm`);

  // determinism
  const s1 = m0.toSTL('t'), s2 = asMesh(gen.build({ ...p0 }, ctx('normal'))).toSTL('t');
  let same = s1.length === s2.length;
  for (let i = 84; i < s1.length && same; i++) if (s1[i] !== s2[i]) same = false;
  check('two builds of the same parameters are byte-identical', same, `${s1.length} vs ${s2.length} bytes`);

  // quality scaling
  const draft = asMesh(gen.build({ ...p0 }, ctx('draft')));
  const fine = asMesh(gen.build({ ...p0 }, ctx('fine')));
  check('draft and fine both build', !!draft && !!fine);
  if (draft && fine) {
    check('quality changes the mesh density (or is documented as fixed)',
      fine.triCount >= draft.triCount, `draft ${draft.triCount} -> fine ${fine.triCount} triangles`);
    isSolid('fine build', fine);
  }

  // optional hooks
  if (gen.validate) {
    const v = gen.validate(p0);
    check('validate() returns an array', Array.isArray(v), typeof v);
  }
  if (gen.hints) {
    const h = gen.hints(p0);
    check('hints() returns an object with notes', h && typeof h === 'object' && Array.isArray(h.notes), JSON.stringify(h).slice(0, 90));
  }

  // ---- presets ------------------------------------------------------------
  check('has at least 3 presets', Array.isArray(gen.presets) && gen.presets.length >= 3, `${gen.presets?.length} presets`);
  const sigs = new Set();
  for (const pr of gen.presets || []) {
    const pp = { ...p0, ...pr.values };
    let mm = null, e2 = null;
    try { mm = asMesh(gen.build(pp, c)); } catch (e) { e2 = e; }
    if (!check(`preset "${pr.name}" builds`, !!mm, e2 ? e2.message : 'no mesh')) continue;
    const t = topology(mm);
    check(`preset "${pr.name}" is a watertight solid`, t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && mm.volume() > 0,
      `bnd ${t.boundary}, nonman ${t.nonManifold}, wind ${t.inconsistent}, vol ${mm.volume().toFixed(0)}`);
    check(`preset "${pr.name}" rests on the plate`, Math.abs(mm.bbox().min[2]) < 1e-5, `min z ${mm.bbox().min[2]}`);
    const s = mm.bbox().size;
    check(`preset "${pr.name}" fits the bed`, s[0] <= BED.x && s[1] <= BED.y && s[2] <= BED.z, s.map(v => v.toFixed(0)).join('×'));
    sigs.add(`${Math.round(mm.volume())}|${s.map(v => Math.round(v)).join(',')}`);
  }
  check('the presets are genuinely different objects', sigs.size >= Math.min(3, (gen.presets || []).length),
    `${sigs.size} distinct shapes from ${gen.presets?.length} presets`);

  // ---- dimension callouts -------------------------------------------------
  dimsCheck(gen, p0, c);

  // ---- the parameter sweep ------------------------------------------------
  if (!sweep) { check('parameter sweep skipped (declared)', true, 'sweep:false'); return { ok: true, mesh: m0 }; }
  let swept = 0, broke = [];
  const trial = (label, params) => {
    swept++;
    try {
      const mm = asMesh(gen.build(params, c));
      if (!mm) { broke.push(`${label}: no mesh`); return; }
      const t = topology(mm);
      const bb = mm.bbox();
      if (t.boundary || t.nonManifold || t.inconsistent) broke.push(`${label}: bnd ${t.boundary} nonman ${t.nonManifold} wind ${t.inconsistent}`);
      else if (!(mm.volume() > 0)) broke.push(`${label}: volume ${mm.volume().toFixed(3)}`);
      else if (Math.abs(bb.min[2]) > 1e-5) broke.push(`${label}: min z ${bb.min[2].toFixed(4)}`);
      else if (!isFinite(bb.size[0] + bb.size[1] + bb.size[2])) broke.push(`${label}: non-finite bbox`);
    } catch (e) { broke.push(`${label}: threw ${e.message}`); }
  };
  for (const q of gen.params || []) {
    if (q.type === 'color') continue;
    if (q.type === 'enum') { for (const o of q.options) trial(`${q.key}=${o.v}`, { ...p0, [q.key]: o.v }); continue; }
    for (const which of ['min', 'max']) {
      const v = sampleValue(q, which);
      if (v === undefined || v === null) continue;
      trial(`${q.key}=${which}(${typeof v === 'object' ? 'data' : v})`, { ...p0, [q.key]: v });
    }
  }
  check(`parameter sweep: every extreme still yields a watertight solid (${swept} builds)`,
    broke.length === 0, broke.length ? broke.slice(0, 6).join(' | ') + (broke.length > 6 ? ` | +${broke.length - 6} more` : '') : `${swept} builds, 0 defects`);

  return { ok: broke.length === 0, mesh: m0, swept };
}

/**
 * Dimension callouts are part of the contract, not decoration: focusing a
 * parameter draws its measurement on the object, and a drawing whose figures
 * do not match the part is worse than no drawing. Every generator declares
 * some; every endpoint lies on the object; and a callout that names a
 * millimetre parameter (and declares no `value` of its own) is exactly that
 * parameter long. Checked at the defaults and at every preset, because a
 * callout placed from the default geometry has a way of pointing at nothing
 * once the shape changes.
 */
function dimsCheck(gen, p0, c) {
  const cases = [['defaults', p0], ...(gen.presets || []).map(pr => [`preset "${pr.name}"`, { ...p0, ...pr.values }])];
  const byKey = new Map((gen.params || []).map(q => [q.key, q]));
  const ok3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const problems = [];
  let total = 0, measured = 0;
  for (const [label, params] of cases) {
    let r;
    try { r = gen.build(params, c); } catch { continue; }
    const mesh = asMesh(r);
    if (!mesh) continue;
    const dims = r && r.meta && Array.isArray(r.meta.dims) ? r.meta.dims : [];
    // Every generator declares its callouts (the last, gear, landed
    // 2026-09-02), so a build with none is a regression, not a work in progress.
    if (label === 'defaults' && dims.length === 0) problems.push('defaults: no dimension callouts declared');
    const b = mesh.bbox();
    for (const d of dims) {
      total++;
      const name = d && d.param ? d.param : (d && d.label) || '?';
      if (!d || !ok3(d.from) || !ok3(d.to)) { problems.push(`${label}: dim "${name}" has a bad from/to`); continue; }
      const len = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
      if (!(len > 1e-6)) { problems.push(`${label}: dim "${name}" has zero length`); continue; }
      // At least one end on the object (a radius is measured from a centre of
      // curvature that is usually empty space), and the other end not absurdly
      // far from it.
      const span = Math.max(b.size[0], b.size[1], b.size[2], 1);
      const near = (pt, tol) => [0, 1, 2].every(ax => pt[ax] >= b.min[ax] - tol && pt[ax] <= b.max[ax] + tol);
      if (!near(d.from, 1) && !near(d.to, 1)) problems.push(`${label}: dim "${name}" touches nothing on the object`);
      else if (!near(d.from, 2 * span) || !near(d.to, 2 * span)) problems.push(`${label}: dim "${name}" reaches far off the object`);
      const q = d.param ? byKey.get(d.param) : null;
      if (d.param && !q) { problems.push(`${label}: dim names an unknown parameter "${d.param}"`); continue; }
      if (q && (q.type === 'number' || q.type === 'int') && q.unit === 'mm' && d.value === undefined) {
        const want = Number(params[q.key]);
        if (Number.isFinite(want)) {
          measured++;
          if (Math.abs(len - want) > Math.max(0.05, want * 0.02)) problems.push(`${label}: dim "${name}" measures ${len.toFixed(2)} mm but the parameter is ${want}`);
        }
      }
    }
  }
  check(`dimension callouts are declared and measure what they name (${total} dims, ${measured} checked against a parameter)`,
    problems.length === 0, problems.length ? problems.slice(0, 5).join(' | ') + (problems.length > 5 ? ` | +${problems.length - 5} more` : '') : `${total} dims`);
}

export { asMesh, isSolid, onPlate, centredXY, fitsBed, topology };
