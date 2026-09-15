// Geometry fingerprints, for proving a refactor changed nothing.
//
// The test suite answers "is this mesh still valid". After a refactor the
// question is different and stricter: "is this the same mesh". A generator can
// go on passing every conformance check while quietly producing different
// geometry — a rounding change in a shared helper does exactly that — so this
// hashes the built vertices and triangles of every generator at its defaults and
// at every preset, and diffs the whole set against a stored run.
//
// Usage:  node tools/mesh-snapshot.mjs write  [path]   record a baseline
//         node tools/mesh-snapshot.mjs check  [path]   compare against it
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadGenerators, defaultParams } = await import(join(ROOT, 'js/gen/index.js'));

const mode = process.argv[2] || 'check';
const file = process.argv[3] || join(ROOT, 'tests', 'fixtures', 'mesh-snapshot.json');

// Round before hashing: a fingerprint that changes on the last bit of a double
// reports noise as a regression. 1e-9 mm is a thousand times finer than the
// printer can place a line and far coarser than float drift.
const Q = 1e9;
function digest(mesh) {
  const h = createHash('sha256');
  // Mesh stores these as `positions` and `tris`. Getting the names wrong does
  // not throw usefully — it produced a baseline of 99 identical error strings
  // that then compared equal to each other and reported IDENTICAL, which is the
  // one result this tool must never give for the wrong reason. Hence the guard.
  const v = mesh.positions;
  const t = mesh.tris;
  if (!v || !t || !v.length || !t.length) {
    throw new Error(`mesh has no geometry to hash (positions=${v && v.length}, tris=${t && t.length})`);
  }
  for (let i = 0; i < v.length; i++) h.update(String(Math.round(v[i] * Q)), 'utf8');
  h.update('|');
  for (let i = 0; i < t.length; i++) h.update(String(t[i]), 'utf8');
  return h.digest('hex').slice(0, 16);
}

const { generators, failures } = await loadGenerators();
if (failures.length) { console.log('LOAD FAILURES:', JSON.stringify(failures)); process.exit(2); }

const snap = {};
for (const g of generators) {
  const cases = [['<defaults>', defaultParams(g)]];
  for (const pre of (g.presets || [])) cases.push([`preset:${pre.name}`, { ...defaultParams(g), ...pre.values }]);
  for (const [name, params] of cases) {
    const key = `${g.id}/${name}`;
    try {
      const out = await g.build(params, {});
      const mesh = out && out.mesh ? out.mesh : out;
      const b = mesh.bbox();
      snap[key] = {
        hash: digest(mesh),
        tris: mesh.triCount, verts: mesh.vertCount,
        vol: +mesh.volume().toFixed(6),
        bbox: b.size.map(n => +n.toFixed(6)),
      };
    } catch (e) { snap[key] = { error: String(e && e.message || e) }; }
  }
}

const errored = Object.entries(snap).filter(([, v]) => v.error);

if (mode === 'write') {
  // A baseline containing errors is worse than no baseline: every later run
  // reproduces the same error and the diff comes back clean.
  if (errored.length) {
    console.log(`REFUSING to write: ${errored.length}/${Object.keys(snap).length} cases failed to build`);
    errored.slice(0, 5).forEach(([k, v]) => console.log(`  ${k}: ${v.error}`));
    process.exit(2);
  }
  writeFileSync(file, JSON.stringify(snap, null, 1) + '\n');
  console.log(`wrote ${Object.keys(snap).length} fingerprints to ${file}`);
  process.exit(0);
}

if (!existsSync(file)) { console.log(`no baseline at ${file} — run "write" first`); process.exit(2); }
const base = JSON.parse(readFileSync(file, 'utf8'));
const keys = [...new Set([...Object.keys(base), ...Object.keys(snap)])].sort();
let same = 0; const diffs = [];
for (const k of keys) {
  const a = base[k], b = snap[k];
  if (!a) { diffs.push(`+ ${k}  (new case, no baseline)`); continue; }
  if (!b) { diffs.push(`- ${k}  (gone from this run)`); continue; }
  // An error on either side is a difference, even when both sides show the same
  // message. Two identical failures are not agreement about geometry.
  if (a.error || b.error) {
    diffs.push(`! ${k}  ${a.error ? 'baseline errored: ' + a.error : ''}`
      + `${b.error ? (a.error ? ' | ' : '') + 'this run errored: ' + b.error : ''}`);
    continue;
  }
  if (a.hash === b.hash) { same++; continue; }
  diffs.push(`~ ${k}\n    hash ${a.hash} -> ${b.hash}\n    tris ${a.tris} -> ${b.tris}   verts ${a.verts} -> ${b.verts}`
    + `\n    vol  ${a.vol} -> ${b.vol}\n    bbox [${a.bbox}] -> [${b.bbox}]`);
}
console.log(`IDENTICAL: ${same}/${keys.length}`);
if (diffs.length) { console.log(`CHANGED:   ${diffs.length}`); diffs.forEach(d => console.log('  ' + d)); }
console.log(diffs.length ? 'RESULT: DIFFERENT' : 'RESULT: IDENTICAL');
process.exitCode = diffs.length ? 1 : 0;
