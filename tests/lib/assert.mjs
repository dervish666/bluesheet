// Zero-dependency test primitives. Every kernel and generator test file imports
// these, prints its own results, and exits non-zero on failure so a gate CHECK
// line can be a bare `node tests/foo.test.mjs`.

let passed = 0, failed = 0;
const failures = [];
let suiteName = 'tests';

export function suite(name) { suiteName = name; }

export function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}${detail ? '  — ' + detail : ''}`); }
  else {
    failed++; failures.push(label);
    console.log(`  FAIL ${label}${detail ? '  — ' + detail : ''}`);
  }
  return !!cond;
}

export function near(label, got, want, tol = 1e-6) {
  const d = Math.abs(got - want);
  return check(label, d <= tol, `got ${fmt(got)}, want ${fmt(want)} (±${tol}, off by ${fmt(d)})`);
}

export function nearPct(label, got, want, pct = 1) {
  const d = Math.abs(got - want), lim = Math.abs(want) * pct / 100;
  return check(label, d <= lim, `got ${fmt(got)}, want ${fmt(want)} (±${pct}%, off by ${fmt(d)})`);
}

export function nearVec(label, got, want, tol = 1e-6) {
  const ok = got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= tol);
  return check(label, ok, `got [${got.map(fmt)}], want [${want.map(fmt)}]`);
}

export function throws(label, fn, match) {
  try { fn(); return check(label, false, 'did not throw'); }
  catch (e) {
    if (match && !String(e.message).includes(match)) return check(label, false, `threw "${e.message}", wanted "${match}"`);
    return check(label, true, `threw "${e.message}"`);
  }
}

function fmt(v) {
  if (typeof v !== 'number') return String(v);
  if (!isFinite(v)) return String(v);
  return Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : String(Math.round(v * 1e6) / 1e6);
}

export function report() {
  const total = passed + failed;
  console.log(`\n${suiteName}: ${passed}/${total} passed`);
  if (failed) {
    console.log(`FAILURES (${failed}):`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
  }
  return { passed, failed, total };
}

// Print a summary automatically if the test file forgets to call report().
let reported = false;
const origReport = report;
process.on('beforeExit', () => { if (!reported && (passed + failed) > 0) origReport(); reported = true; });
export function done() { reported = true; return origReport(); }
