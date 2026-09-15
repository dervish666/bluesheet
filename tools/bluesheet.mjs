#!/usr/bin/env node
// Bluesheet from the command line.
//
// The generators are pure functions with no DOM, which means the browser is a
// convenience rather than a requirement. This is the same catalogue, scriptable:
// useful for building a plate to print, for regenerating an object from the
// provenance in an STL header, and for checking a file someone sent you.
//
//   bluesheet list [category]
//   bluesheet info <gen>
//   bluesheet build <gen> [--key value ...] [--preset NAME] [--quality draft|normal|fine] [-o out.stl]
//   bluesheet plate <plate.json> [-o plate.stl] [--gap 3] [--bed 180x180]
//   bluesheet analyse <file.stl>
//   bluesheet trace <file.stl>
//
// A plate.json is [{ "gen": "gridfinity", "qty": 4, "params": {...} }, ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { loadGenerators, defaultParams, coerce, validateParams } = await import(join(ROOT, 'js/gen/index.js'));
const { analyze, printability } = await import(join(ROOT, 'js/kernel/validate.js'));
const { provenance, parseProvenance } = await import(join(ROOT, 'js/kernel/provenance.js'));
const { pack, layout, toBedCoords, withinBed, anyOverlap, A1_MINI_BED } = await import(join(ROOT, 'js/kernel/pack.js'));
const { importSTL } = await import(join(ROOT, 'js/kernel/stl.js'));
const { Mesh } = await import(join(ROOT, 'js/kernel/mesh.js'));

const QUALITY = { draft: 0.5, normal: 1, fine: 2 };
const ctx = (quality = 'normal') => ({
  quality, segFactor: QUALITY[quality] ?? 1, bed: A1_MINI_BED,
  nozzle: 0.4, layerH: 0.2, log: () => {}, progress: () => {}, signal: null,
});

const argv = process.argv.slice(2);
const cmd = argv.shift();

const { generators, failures } = await loadGenerators();
const byId = Object.fromEntries(generators.map(g => [g.id, g]));

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') out.out = args[++i];
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const v = inline !== undefined ? inline : (args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : 'true');
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function need(id) {
  const g = byId[id];
  if (!g) {
    console.error(`no generator "${id}". Known: ${generators.map(x => x.id).join(', ')}`);
    if (failures.length) console.error(`(${failures.length} failed to load: ${failures.map(f => `${f.id} — ${f.reason}`).join('; ')})`);
    process.exit(2);
  }
  return g;
}

function resolveParams(gen, f) {
  let p = defaultParams(gen);
  if (f.preset) {
    const pr = (gen.presets || []).find(x => x.name.toLowerCase() === String(f.preset).toLowerCase());
    if (!pr) { console.error(`no preset "${f.preset}". Known: ${(gen.presets || []).map(x => x.name).join(', ')}`); process.exit(2); }
    p = { ...p, ...pr.values };
  }
  for (const q of gen.params) {
    if (f[q.key] === undefined) continue;
    const raw = f[q.key];
    p[q.key] = coerce(q, q.type === 'bool' ? !/^(false|0|no)$/i.test(raw) : raw);
  }
  return p;
}

const asMesh = (r) => r instanceof Mesh ? r : (r?.mesh instanceof Mesh ? r.mesh : (Array.isArray(r?.parts) ? Mesh.merge(r.parts.map(x => x.mesh)) : null));
const mm = (v) => v.toFixed(1);

switch (cmd) {
  case 'list': {
    const cat = argv[0];
    let last = null;
    for (const g of generators) {
      if (cat && g.category.toLowerCase() !== cat.toLowerCase()) continue;
      if (g.category !== last) { console.log(`\n${g.category.toUpperCase()}`); last = g.category; }
      console.log(`  ${g.id.padEnd(13)} ${g.name.padEnd(26)} ${g.blurb}`);
    }
    if (failures.length) console.log(`\n${failures.length} did not load: ${failures.map(f => f.id).join(', ')}`);
    console.log(`\n${generators.length} generators`);
    break;
  }

  case 'info': {
    const g = need(argv[0]);
    console.log(`${g.name}  (${g.id} v${g.version}, ${g.category})\n${g.description}\n`);
    let group = null;
    for (const q of g.params) {
      if (q.group !== group) { console.log(`  ${(q.group || 'Parameters').toUpperCase()}`); group = q.group; }
      const dom = q.type === 'enum' ? q.options.map(o => o.v).join('|')
        : (q.type === 'number' || q.type === 'int') ? `${q.min}..${q.max}${q.unit ? ' ' + q.unit : ''}`
        : q.type;
      console.log(`    --${q.key.padEnd(16)} ${String(q.def).padEnd(10)} ${dom.padEnd(22)} ${q.help || ''}`);
    }
    if (g.presets?.length) console.log(`\n  PRESETS  ${g.presets.map(p => p.name).join(' · ')}`);
    break;
  }

  case 'build': {
    const f = flags(argv);
    const g = need(f._[0]);
    const p = resolveParams(g, f);
    const issues = validateParams(g, p);
    for (const i of issues) console.error(`  ${i.severity}: ${i.message}`);
    if (issues.some(i => i.severity === 'error') && !f.force) { console.error('refusing to build (pass --force to override)'); process.exit(1); }
    const t = process.hrtime.bigint();
    const mesh = asMesh(g.build(p, ctx(f.quality)));
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (!mesh) { console.error('generator returned no mesh'); process.exit(1); }
    report(mesh, g, p, ms);
    const out = f.out || `/tmp/${g.id}.stl`;
    writeFileSync(out, Buffer.from(mesh.toSTL(provenance(g, p))));
    console.log(`  written  ${out}`);
    break;
  }

  case 'plate': {
    const f = flags(argv);
    const spec = JSON.parse(readFileSync(f._[0], 'utf8'));
    const bed = f.bed ? { x: +f.bed.split('x')[0], y: +f.bed.split('x')[1], z: 180 } : A1_MINI_BED;
    const meshes = {}, items = [];
    spec.forEach((entry, i) => {
      const g = need(entry.gen);
      const p = { ...defaultParams(g), ...(entry.preset ? (g.presets.find(x => x.name === entry.preset)?.values || {}) : {}), ...(entry.params || {}) };
      const mesh = asMesh(g.build(p, ctx(entry.quality || f.quality)));
      if (!mesh) { console.error(`${entry.gen} returned no mesh`); process.exit(1); }
      const key = entry.name || `${entry.gen}-${i}`;
      meshes[key] = mesh;
      const b = mesh.bbox();
      items.push({ id: key, w: b.size[0], d: b.size[1], qty: entry.qty || 1, meta: { h: b.size[2], gen: g.id, params: p } });
      console.log(`  ${key.padEnd(20)} ${mm(b.size[0])} × ${mm(b.size[1])} × ${mm(b.size[2])} mm   ×${entry.qty || 1}   ${mesh.triCount} tris`);
    });
    const packing = pack(items, bed, { gap: f.gap !== undefined ? +f.gap : 3 });
    for (const u of packing.unplaced) console.error(`  DROPPED ${u.id}: ${u.reason}`);
    const { mesh } = layout(meshes, packing);
    console.log(`\n  plate    ${packing.placed.length} objects, ${mm(packing.used.w)} × ${mm(packing.used.d)} mm used, ${(packing.fill * 100).toFixed(0)}% fill`);
    console.log(`  checks   overlap:${anyOverlap(packing) ? 'YES — BUG' : 'none'}  within bed:${withinBed(packing, bed) ? 'yes' : 'NO — BUG'}`);
    report(mesh, { id: 'plate', version: 1 }, { n: packing.placed.length });
    const out = f.out || '/tmp/bluesheet-plate.stl';
    writeFileSync(out, Buffer.from(toBedCoords(mesh, bed).toSTL(`plate v1 #${packing.placed.length}objs`)));
    console.log(`  written  ${out}  (translated to printer coordinates, ready for --arrange 0)`);
    break;
  }

  case 'analyse': case 'analyze': {
    const buf = readFileSync(argv[0]);
    const mesh = importSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    report(mesh instanceof Mesh ? mesh : mesh.mesh, null, null);
    break;
  }

  case 'trace': {
    const buf = readFileSync(argv[0]);
    const p = parseProvenance(new Uint8Array(buf));
    if (!p) { console.log(`${basename(argv[0])}: not made by Bluesheet`); break; }
    console.log(`${basename(argv[0])}: ${p.gen} v${p.version}, parameter hash ${p.hash}`);
    if (byId[p.gen]) console.log(`  regenerate with: bluesheet build ${p.gen} ...  (the library holds the parameters for #${p.hash})`);
    break;
  }

  default:
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

function report(mesh, gen, params, ms) {
  const a = analyze(mesh);
  const pr = printability(mesh, { bed: A1_MINI_BED });
  const b = mesh.bbox();
  if (ms !== undefined) console.log(`  built    ${ms.toFixed(0)} ms`);
  console.log(`  size     ${mm(b.size[0])} × ${mm(b.size[1])} × ${mm(b.size[2])} mm`);
  console.log(`  mesh     ${mesh.triCount.toLocaleString()} triangles, ${a.shells} shell${a.shells === 1 ? '' : 's'}`);
  console.log(`  solid    ${a.manifold ? 'watertight' : `NOT WATERTIGHT — ${a.boundaryEdges} boundary edges, ${a.nonManifoldEdges} non-manifold`}`);
  console.log(`  volume   ${(a.volume / 1000).toFixed(2)} cm³  ≈ ${pr.estGrams.toFixed(1)} g`);
  console.log(`  fits bed ${pr.fitsBed ? 'yes' : 'NO'}`);
  if (pr.worstOverhangDeg > 0) console.log(`  overhang worst ${pr.worstOverhangDeg.toFixed(0)}°, ${(pr.overhangPct * 100).toFixed(1)}% of the surface`);
  for (const w of (a.warnings || []).concat(pr.warnings || [])) {
    if (w.severity !== 'info') console.log(`  ${w.severity.padEnd(8)} ${w.message}`);
  }
  if (gen && params) console.log(`  trace    ${provenance(gen, params)}`);
}
