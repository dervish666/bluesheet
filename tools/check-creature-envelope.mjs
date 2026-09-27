// Where does an articulated creature actually come out watertight AND manifold?
//
// Ruling 27 recorded that the default body is clean at 12 x 14 and that segLen
// 13 or 11 segments give the coil hundreds of non-manifold edges. This sweeps
// the grid that ruling was a single sample of, so a species row can be chosen
// from a map instead of discovered one row at a time.
//
// It measures the BARE creature — segmentsOf(), no head, tail, limbs or dorsal
// — because every part is unioned on afterwards and a body that is already
// broken cannot be rescued by what is added to it.
//
// FALSIFIER, run it first: `--falsify` builds the three cells ruling 27 names.
// The default must come back clean and the other two must come back with
// hundreds of non-manifold edges. An instrument that reports every cell clean
// is the failure mode this whole exercise exists to avoid.
//
//   node tools/check-creature-envelope.mjs --falsify
//   node tools/check-creature-envelope.mjs --segments 3:24 --seglen 6:26:2 \
//        --profiles tapered,flat --poses coil,scurve --tight 0.5,1 --json out.json
import { Mesh } from '../js/kernel/mesh.js';
import { topology } from '../tests/lib/meshcheck.mjs';
import { ctx, defaults } from '../tests/lib/genconform.mjs';
import gen, { segmentsOf } from '../js/gen/creature.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const range = (spec) => {
  const [a, b, s] = spec.split(':').map(Number);
  const step = s || 1, out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
};
const list = (spec) => spec.split(',').map(s => s.trim()).filter(Boolean);

const D = defaults(gen);
const C = ctx(opt('quality', 'normal'));

/** One cell: build the bare body, return what is wrong with it. */
function cell(over) {
  const p = { ...D, ...over };
  try {
    const t = topology(Mesh.merge(segmentsOf(p, C)));
    return { ...over, nm: t.nonManifold, bd: t.boundary, inc: t.inconsistent, deg: t.degenerate,
             tris: t.tris, ok: t.nonManifold === 0 && t.boundary === 0 && t.inconsistent === 0 };
  } catch (e) {
    return { ...over, error: e.message.slice(0, 120), ok: false };
  }
}

if (flag('falsify')) {
  // The self-test has to be independent of whether the kernel is currently
  // broken, or it stops working the moment somebody fixes the kernel — which
  // is exactly what Task 7c did to the first version of this block. It used to
  // require ruling 27's two cells to come back with hundreds of bad edges;
  // they are clean now, and the honest report was "do not trust any sweep from
  // this file", which was the opposite of the truth.
  //
  // So: build a defect this file can construct itself, and require it to be
  // seen. A mesh merged with an exact copy of itself has every edge used four
  // times. If `topology()` calls that clean, nothing below is evidence.
  const base = { pose: 'coil', tight: 0.5, profile: 'flat' };
  const good = Mesh.merge(segmentsOf({ ...D, ...base }, C));
  const gt = topology(good);
  const doubled = Mesh.merge([good, good]);
  const dt = topology(doubled);
  const ok = gt.nonManifold === 0 && gt.boundary === 0 && dt.nonManifold > 0;
  console.log(`a sound body       : ${gt.nonManifold} non-manifold, ${gt.boundary} boundary  (want 0, 0)`);
  console.log(`the same body twice: ${dt.nonManifold} non-manifold  (want more than 0)`);
  console.log(ok ? 'FALSIFIER PASS — this file can tell a solid from a broken one.'
                 : 'FALSIFIER FAIL — do not trust any sweep from this file.');

  // Ruling 27's three cells, for the record rather than as a gate. Before Task
  // 7c the last two read 277 and 271; both are clean now and that is the
  // headline of task-7c-report.md, not a fault.
  console.log('\nruling 27\'s cells, historical (277 and 271 before Task 7c):');
  for (const [label, over] of [
    ['12 x 14, the default the joint numbers were proven at', { ...base }],
    ['12 x 13', { ...base, segLen: 13 }],
    ['11 x 14', { ...base, segments: 11 }],
  ]) {
    const r = cell(over);
    console.log(`  ${r.nm === 0 ? 'clean ' : String(r.nm).padStart(6)}  ${label}`);
  }
  process.exit(ok ? 0 : 1);
}

const grid = {
  segments: range(opt('segments', '3:24')),
  segLen: range(opt('seglen', '6:26:2')),
  profile: list(opt('profiles', 'tapered,flat,barrel,ribbed')),
  pose: list(opt('poses', 'coil,scurve')),
  tight: range(opt('tight', '0.5:1:0.5')),
  joint: list(opt('joint', 'ball')),
  bodyR: range(opt('bodyr', '9:9:1')),
};

const combos = [];
for (const segments of grid.segments)
  for (const segLen of grid.segLen)
    for (const profile of grid.profile)
      for (const pose of grid.pose)
        for (const tight of grid.tight)
          for (const joint of grid.joint)
            for (const bodyR of grid.bodyR)
              combos.push({ segments, segLen, profile, pose, tight, joint, bodyR });

console.error(`${combos.length} cells at ${opt('quality', 'normal')} quality`);
const t0 = Date.now();
const rows = [];
for (let i = 0; i < combos.length; i++) {
  rows.push(cell(combos[i]));
  if ((i + 1) % 25 === 0) {
    const per = (Date.now() - t0) / (i + 1);
    console.error(`  ${i + 1}/${combos.length}  ${(per / 1000).toFixed(2)} s/cell  ` +
      `eta ${Math.round(per * (combos.length - i - 1) / 60000)} min  ` +
      `${rows.filter(r => !r.ok).length} dirty so far`);
  }
}

const dirty = rows.filter(r => !r.ok);
console.log(`\n${rows.length - dirty.length}/${rows.length} clean (${(100 * (rows.length - dirty.length) / rows.length).toFixed(1)}%)`);
for (const key of ['segments', 'segLen', 'profile', 'pose', 'tight']) {
  const by = new Map();
  for (const r of rows) {
    const k = r[key], e = by.get(k) || { n: 0, bad: 0 };
    e.n++; if (!r.ok) e.bad++; by.set(k, e);
  }
  console.log(`  by ${key}: ` + [...by.entries()].map(([k, e]) => `${k}=${e.n - e.bad}/${e.n}`).join(' '));
}
// The number that matters is not the cell rate, it is the PER-JOINT rate. A
// creature with S segments has S-1 joints and is clean only if every one of
// them is, so clean^(1/(S-1)) recovers the per-joint odds. If that number comes
// out roughly constant across segment counts, the defect is a dice roll at each
// joint and no choice of body numbers avoids it.
{
  const by = new Map();
  for (const r of rows) { const e = by.get(r.segments) || { n: 0, ok: 0 }; e.n++; if (r.ok) e.ok++; by.set(r.segments, e); }
  const ps = [];
  console.log('  implied per-joint failure rate:');
  console.log('    ' + [...by.entries()].sort((a, b) => a[0] - b[0]).map(([S, e]) => {
    if (S < 2 || e.ok === 0) return `${S}=n/a`;
    const pj = 1 - Math.pow(e.ok / e.n, 1 / (S - 1)); ps.push(pj);
    return `${S}=${(100 * pj).toFixed(1)}%`;
  }).join(' '));
  if (ps.length) console.log(`    mean ${(100 * ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(1)}% per joint`);
}

const out = opt('json', null);
if (out) { writeFileSync(out, JSON.stringify({ grid, quality: opt('quality', 'normal'), rows }, null, 0)); console.log(`wrote ${out}`); }
