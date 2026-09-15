// Export coverage: every named export of a module must be exercised by its test
// file. Cheap, mechanical, and it kills the commonest quiet incompleteness —
// shipping eight functions and testing three.
// Usage: node tests/coverage.mjs js/kernel/poly2d.js tests/poly2d.test.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [modPath, testPath] = process.argv.slice(2);
if (!modPath || !testPath) { console.log('usage: coverage.mjs <module> <testfile>'); process.exit(2); }

const mod = await import(pathToFileURL(resolve(modPath)).href);
const src = readFileSync(testPath, 'utf8');

const names = Object.keys(mod).filter(k => k !== 'default');

// A mention is not a test. An exported function has to appear as a CALL —
// `name(` or `.name(` or `new Name(` — while a constant or a class used only as
// a type just has to appear at all. This is still a heuristic, but it is the
// difference between "the word is in the file" and "the code runs".
const esc = (n) => n.replace(/[$]/g, '\\$');
const missing = [], mentionedOnly = [];
for (const n of names) {
  const mentioned = new RegExp(`\\b${esc(n)}\\b`).test(src);
  if (!mentioned) { missing.push(n); continue; }
  if (typeof mod[n] === 'function') {
    // A class that only ever arrives from a factory (loadFont() -> Font) is
    // legitimately exercised through `instanceof`, and an error class through
    // catching it — so those count as calls.
    const called = new RegExp(`(?:\\bnew\\s+|\\.|\\b)${esc(n)}\\s*\\(`).test(src)
      || new RegExp(`instanceof\\s+${esc(n)}\\b`).test(src);
    if (!called) mentionedOnly.push(n);
  }
}
const covered = names.length - missing.length - mentionedOnly.length;
console.log(`COVERAGE: ${covered}/${names.length} exports covered`);
console.log(`missing: ${missing.length ? missing.join(', ') : 'none'}`);
if (mentionedOnly.length) console.log(`mentioned but never called: ${mentionedOnly.join(', ')}`);
process.exitCode = (missing.length + mentionedOnly.length) ? 1 : 0;
