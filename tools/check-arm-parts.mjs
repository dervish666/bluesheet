// Does the set contain everything needed to build the thing?
// A generator that emits arms and no knob is a generator that emits a puzzle.
// Every joint in the chain needs a knob, and a wrist adapter IS a joint.
import gen from '../js/gen/arm.js';
import { topology } from '../tests/lib/meshcheck.mjs';
const c = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const d = {}; for (const q of gen.params) d[q.key] = typeof q.def === 'function' ? q.def() : q.def;
const problems = [];
// Every combination of arms and wrists, because a wrist is a JOINT: it goes
// into the chain between two things, so it needs a bolt and a knob of its own.
// The invariant used to be knobs === arms + 1, which was right until the wrist
// existed and would have gone on passing while shipping a set one knob short.
for (const [armCount, wrist] of [[2, 0], [1, 0], [2, 1], [3, 2], [1, 2]]) {
  const r = gen.build({ ...d, part: 'all', armCount, wrist }, c);
  const names = r.parts.map(p => p.name);
  const where = `arms ${armCount} wrists ${wrist}`;
  if (armCount === 2 && wrist === 0) console.log('  parts:', names.join(', '));
  const need = ['base', 'arm', 'head', 'knob', ...(wrist ? ['wrist'] : [])];
  const missing = need.filter(n => !names.some(x => x === n || x.startsWith(n + ' ')));
  const knobs = names.filter(x => x.startsWith('knob')).length;
  const arms = names.filter(x => x.startsWith('arm')).length;
  const wrists = names.filter(x => x.startsWith('wrist')).length;
  if (missing.length) problems.push(`${where}: missing ${missing.join(', ')}`);
  if (arms !== armCount) problems.push(`${where}: ${arms} arms built`);
  if (wrists !== wrist) problems.push(`${where}: ${wrists} wrists built`);
  if (knobs !== arms + wrists + 1) {
    problems.push(`${where}: ${knobs} knobs for ${arms} arms and ${wrists} wrists — that chain has ${arms + wrists + 1} joints`);
  }
  for (const p of r.parts) {
    const t = topology(p.mesh);
    if (t.boundary || t.nonManifold || t.inconsistent) problems.push(`${where} ${p.name}: bnd ${t.boundary} nonman ${t.nonManifold}`);
  }
}
// Asking for the wrist on its own gives one even when the count is zero — it is
// the cheap part to test-print before committing to a whole set.
{
  const names = gen.build({ ...d, part: 'wrist', wrist: 0 }, c).parts.map(p => p.name);
  if (names.length !== 1 || names[0] !== 'wrist') problems.push(`part:wrist gave ${names.join(', ') || 'nothing'}`);
}
for (const x of problems) console.log('  ' + x);
console.log(problems.length ? 'parts INCOMPLETE' : 'parts ok');
process.exit(problems.length ? 1 : 0);
