#!/usr/bin/env node
// Keep GENERATOR_IDS in step with what is actually in js/gen/.
//
// Listing a generator that does not exist makes the loader report failures and
// turns "not built yet" into a red integration gate for the wrong reason; not
// listing one that does exist hides it from the catalogue with no error at all,
// which is worse. So the list is derived, and this prints what changed.
//
//   node tools/sync-registry.mjs [--check]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = join(ROOT, 'js/gen');
const CHECK = process.argv.includes('--check');

// Files that are not generators: the loader itself, and any harness a UI test
// dropped here. A generator is a default export with the required keys.
const SKIP = new Set(['index.js']);
// Test doubles live here so the UI's browser test can load them by id, but they
// must never reach the catalogue — a fake generator in the front door is worse
// than a missing real one.
const SKIP_RE = /^(uiharness|fixture|_)/;
const found = [];
for (const f of readdirSync(GEN).filter(f => f.endsWith('.js')).sort()) {
  if (SKIP.has(f)) continue;
  const id = f.replace(/\.js$/, '');
  if (SKIP_RE.test(id)) { console.log(`  skip  ${id.padEnd(14)} test double, not a catalogue entry`); continue; }
  let mod;
  try { mod = await import(pathToFileURL(join(GEN, f)).href); }
  catch (e) { console.log(`  skip  ${id.padEnd(14)} does not import: ${String(e.message).slice(0, 70)}`); continue; }
  const g = mod.default;
  const missing = ['id', 'name', 'category', 'blurb', 'params', 'build'].filter(k => g?.[k] === undefined);
  if (missing.length) { console.log(`  skip  ${id.padEnd(14)} not a generator (missing ${missing.join(', ')})`); continue; }
  if (g.id !== id) { console.log(`  skip  ${id.padEnd(14)} declares id "${g.id}"`); continue; }
  found.push(id);
}

const src = readFileSync(join(GEN, 'index.js'), 'utf8');
const m = src.match(/export const GENERATOR_IDS = \[([\s\S]*?)\];/);
if (!m) { console.error('could not find GENERATOR_IDS'); process.exit(2); }
const current = [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map(x => x[1]);

const added = found.filter(id => !current.includes(id));
const removed = current.filter(id => !found.includes(id));
console.log(`\ncurrent ${current.length} · on disk ${found.length}`);
if (added.length) console.log(`  + ${added.join(', ')}`);
if (removed.length) console.log(`  - ${removed.join(', ')} (listed but not present)`);
if (!added.length && !removed.length) { console.log('  in step'); process.exit(0); }
if (CHECK) { console.log('\nRESULT: OUT OF STEP'); process.exit(1); }

const body = found.map(id => `  '${id}',`).join('\n');
writeFileSync(join(GEN, 'index.js'), src.replace(m[0], `export const GENERATOR_IDS = [\n${body}\n];`));
console.log(`\nGENERATOR_IDS updated to ${found.length} generators`);
