#!/usr/bin/env node
// Build a sampler plate from whatever generators exist, slice it, and report.
//
//   node tools/sampler.mjs [--minutes 70] [--gap 4] [--dry]
//
// The point of a sampler is to be a physical contact sheet of the catalogue, so
// it picks small objects from as many DIFFERENT generators as will fit inside a
// time budget rather than the most impressive single thing. Anything that is not
// watertight, does not fit, or would take too long is dropped with a reason
// printed — a sampler that silently leaves something out is a worse sampler.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { loadGenerators, defaultParams } = await import(join(ROOT, 'js/gen/index.js'));
const { analyze, printability } = await import(join(ROOT, 'js/kernel/validate.js'));
const { pack, layout, toBedCoords, withinBed, anyOverlap, A1_MINI_BED } = await import(join(ROOT, 'js/kernel/pack.js'));
const { Mesh } = await import(join(ROOT, 'js/kernel/mesh.js'));
const { provenance } = await import(join(ROOT, 'js/kernel/provenance.js'));

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const GAP = Number(arg('gap', 4));
const BUDGET_G = Number(arg('grams', 22));      // a proxy for time: ~1 g/min at 0.2 mm
const DRY = process.argv.includes('--dry');

// Preferred picks, in the order they make the plate interesting. A preset name
// is tried first; the generator's defaults are the fallback.
const WISHLIST = [
  ['nameplate', 'BLUESHEET'], ['gear', null], ['gridfinity', null], ['hooks', null],
  ['coaster', null], ['knob', null], ['boxlid', null], ['thread', null],
  ['sundial', null], ['vase', null], ['datasculpt', null], ['spool', null],
];

const ctx = { quality: 'normal', segFactor: 1, bed: A1_MINI_BED, nozzle: 0.4, layerH: 0.2, log: () => {}, progress: () => {}, signal: null };
const asMesh = (r) => r instanceof Mesh ? r : (r?.mesh instanceof Mesh ? r.mesh : (Array.isArray(r?.parts) ? Mesh.merge(r.parts.map(x => x.mesh)) : null));

const { generators, failures } = await loadGenerators();
const byId = Object.fromEntries(generators.map(g => [g.id, g]));
console.log(`${generators.length} generators available${failures.length ? `, ${failures.length} not built yet` : ''}\n`);

const meshes = {}, items = [];
let grams = 0;
for (const [id, presetName] of WISHLIST) {
  const g = byId[id];
  if (!g) { console.log(`  skip  ${id.padEnd(12)} not built`); continue; }
  // Prefer the smallest preset: a sampler wants variety, not one big object.
  const candidates = [...(g.presets || []).map(pr => ({ name: pr.name, values: pr.values })), { name: 'defaults', values: {} }];
  if (presetName) candidates.sort((a, b) => (a.name === presetName ? -1 : b.name === presetName ? 1 : 0));
  let chosen = null;
  for (const c of candidates) {
    let m = null;
    try { m = asMesh(g.build({ ...defaultParams(g), ...c.values }, ctx)); } catch (e) { continue; }
    if (!m) continue;
    const a = analyze(m), p = printability(m, {});
    if (!a.manifold || !a.watertight || !p.fitsBed) continue;
    if (!chosen || p.estGrams < chosen.g) chosen = { mesh: m, g: p.estGrams, name: c.name, a, p };
    if (presetName && c.name === presetName) break;
  }
  if (!chosen) { console.log(`  skip  ${id.padEnd(12)} nothing built watertight and on the bed`); continue; }
  if (grams + chosen.g > BUDGET_G) { console.log(`  skip  ${id.padEnd(12)} ${chosen.g.toFixed(1)} g would exceed the ${BUDGET_G} g budget`); continue; }
  grams += chosen.g;
  meshes[id] = chosen.mesh;
  const b = chosen.mesh.bbox();
  items.push({ id, w: b.size[0], d: b.size[1], qty: 1, meta: { h: b.size[2], gen: id } });
  console.log(`  take  ${id.padEnd(12)} "${chosen.name}"  ${b.size.map(v => v.toFixed(1)).join(' × ')} mm  ${chosen.g.toFixed(1)} g  ${chosen.mesh.triCount} tris`);
}

if (!items.length) { console.log('\nnothing to put on the plate yet'); process.exit(1); }

const packing = pack(items, A1_MINI_BED, { gap: GAP });
for (const u of packing.unplaced) console.log(`  DROP  ${u.id}: ${u.reason}`);
const { mesh } = layout(meshes, packing);
const a = analyze(mesh), p = printability(mesh, {});
console.log(`\nplate    ${packing.placed.length} objects · ${packing.used.w.toFixed(0)} × ${packing.used.d.toFixed(0)} mm used · ${(packing.fill * 100).toFixed(0)}% fill`);
console.log(`checks   overlap ${anyOverlap(packing) ? 'YES — BUG' : 'none'} · within bed ${withinBed(packing) ? 'yes' : 'NO — BUG'} · watertight ${a.manifold && a.watertight}`);
console.log(`mesh     ${mesh.triCount.toLocaleString()} triangles · ${a.shells} shells · ${(a.volume / 1000).toFixed(2)} cm³ ≈ ${p.estGrams.toFixed(1)} g`);
for (const w of [...(a.warnings || []), ...(p.warnings || [])].filter(w => w.severity !== 'info').slice(0, 5)) console.log(`  ${w.severity}: ${w.message.slice(0, 150)}`);

const out = arg('out', '/tmp/bluesheet-sampler.stl');
writeFileSync(out, Buffer.from(toBedCoords(mesh).toSTL(provenance({ id: 'sampler', version: 1 }, { n: packing.placed.length }))));
console.log(`written  ${out}  (printer coordinates, for --arrange 0)`);

if (DRY) process.exit(0);

// Slice through the service, which re-reads the 3mf and asserts the settings landed.
const stl = Buffer.from(toBedCoords(mesh).toSTL('sampler'));
const res = await fetch('http://127.0.0.1:8132/api/slice', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8132' },
  body: JSON.stringify({ stl: stl.toString('base64'), name: 'bluesheet-sampler', settings: { profile: 'standard', filament: 'pla', infill: 15, supports: false } }),
}).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
if (!res.ok) { console.log('slice FAILED:', res.error); process.exit(1); }
console.log(`\nsliced   ${res.timeText} print (${res.totalTimeText} total) · ${res.grams} g · ${res.layers} layers · £${res.cost}`);
console.log(`         settings verified in the 3mf: ${res.verified.every(v => v.ok)} (${res.verified.length} checked)`);
console.log(`         id ${res.id} — fetch with /api/slice/${res.id}/3mf`);
