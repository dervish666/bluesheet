// Will a CYD actually bolt to this arm, in both orientations?
//
// Checked against the OTHER generator rather than against a number written
// down twice: cydmount reports the pitch its VESA plate is drilled to, and the
// arm reports the pitch its head is drilled to. If those two ever drift apart,
// this fails — which is the whole point of asking the question this way.
import arm from '../js/gen/arm.js';
import cyd from '../js/gen/cydmount.js';
const c = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const defs = (g) => { const d = {}; for (const q of g.params) d[q.key] = typeof q.def === 'function' ? q.def() : q.def; return d; };

const problems = [];
for (const [vesa, pattern, size] of [['v75', 'vesa75', 75], ['v100', 'vesa100', 100]]) {
  const cm = cyd.build({ ...defs(cyd), mount: 'vesa', vesa }, c);
  const am = arm.build({ ...defs(arm), part: 'head', pattern }, c);
  const cp = cm.meta.vesaPitch;
  // Measure the holes the arm ACTUALLY drilled, not the pitch it meant to.
  // Comparing meta.patternPitch to itself passed a head whose holes were
  // 74.5 mm apart, because the placement clamped them to fit the plate and
  // nothing downstream ever looked.
  const h = am.meta.headHoles || [];
  if (h.length !== 4) { problems.push(`${pattern}: head drilled ${h.length} holes, expected 4`); continue; }
  const ys = [...new Set(h.map(q => q[0]))].sort((a, b) => a - b);
  const zs = [...new Set(h.map(q => q[1]))].sort((a, b) => a - b);
  const dy = ys[ys.length - 1] - ys[0], dz = zs[zs.length - 1] - zs[0];
  if (Math.abs(dy - cp) > 0.05 || Math.abs(dz - cp) > 0.05) {
    problems.push(`${pattern}: cydmount drills ${cp} mm, arm head measures ${dy.toFixed(2)} x ${dz.toFixed(2)} mm`);
  } else if (Math.abs(dy - dz) > 0.05) {
    problems.push(`${pattern}: head pattern is ${dy.toFixed(2)} x ${dz.toFixed(2)} mm, not square — it will not turn 90 degrees`);
  } else {
    console.log(`  ${pattern}: cydmount ${cp} mm, arm head measures ${dy.toFixed(3)} x ${dz.toFixed(3)} mm — square and exact`);
  }
}
// Square, so the display turns a quarter turn between portrait and landscape.
const am = arm.build({ ...defs(arm), part: 'head' }, c);
if (!/vesa|square/.test(String(am.meta.pattern))) problems.push('head pattern is not reported as square');
console.log('  pattern is square, so a quarter turn re-bolts portrait <-> landscape');
for (const x of problems) console.log('  ' + x);
console.log(problems.length ? 'mates: false' : 'mates: true');
process.exit(problems.length ? 1 : 0);
