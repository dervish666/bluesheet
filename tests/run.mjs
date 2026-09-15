// Run every *.test.mjs in tests/, in a child process each, and summarise.
// One command that says whether Bluesheet is whole: `node tests/run.mjs`
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const verbose = process.argv.includes('-v');
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs'))
  .filter(f => !only.length || only.some(o => f.includes(o))).sort();

let totalPass = 0, totalFail = 0, suitesFailed = [];
const rows = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\/(\d+) passed/);
  const pass = m ? +m[1] : 0, total = m ? +m[2] : 0;
  const ok = r.status === 0 && total > 0 && pass === total;
  totalPass += pass; totalFail += (total - pass);
  if (!ok) { suitesFailed.push(f); }
  rows.push([ok ? 'PASS' : 'FAIL', f, `${pass}/${total}`]);
  if (verbose || !ok) console.log(out.split('\n').filter(l => /FAIL|Error|error:/.test(l)).slice(0, 20).join('\n'));
}
const w = Math.max(...rows.map(r => r[1].length), 10);
for (const [s, f, c] of rows) console.log(`${s}  ${f.padEnd(w)}  ${c}`);
console.log(`\nSUITES: ${rows.length - suitesFailed.length}/${rows.length} passed`);
console.log(`CHECKS: ${totalPass}/${totalPass + totalFail} passed`);
// An empty run is a failure, not a pass: a suite list that silently went to zero
// would otherwise report green forever.
if (!rows.length) { console.log('RESULT: FAIL (no test files matched)'); process.exitCode = 2; }
else { console.log(suitesFailed.length ? `RESULT: FAIL (${suitesFailed.join(', ')})` : 'RESULT: PASS');
       process.exitCode = suitesFailed.length ? 1 : 0; }
