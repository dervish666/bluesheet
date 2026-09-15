// Is the serrated joint actually self-mating?
//
// The design rests on one claim: two IDENTICAL toothed faces mesh when one is
// turned by half a tooth. That is true only if the tooth profile is periodic
// in one pitch AND antisymmetric about half a pitch, so that z(t) + z(t + p/2)
// is constant — the two surfaces then touch everywhere at once instead of
// riding on their crests. This measures both properties off the real mesh
// rather than off the formula that generated it.
import { toothedDisc } from '../js/gen/arm.js';

let bad = [];
for (const [teeth, toothH, r] of [[24, 1.2, 15], [8, 0.3, 10], [60, 4, 35], [17, 1.0, 12]]) {
  const m = toothedDisc(r, r * 0.4, 6, teeth, toothH);
  // Crest/root vertices on the outer edge of the top face.
  const pts = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    if (z <= 0) continue;
    if (Math.abs(Math.hypot(x, y) - r) > 1e-6) continue;
    pts.push([Math.atan2(y, x), z]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const N = Math.max(6, Math.round(teeth));
  if (pts.length !== N * 2) { bad.push(`teeth=${teeth}: expected ${N * 2} rim samples, saw ${pts.length}`); continue; }

  const pitch = Math.PI * 2 / N;
  const zAt = (t) => {
    // Nearest sample, wrapped: the surface is piecewise linear between them.
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      let d = Math.abs(((pts[i][0] - t + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
      if (d < bd) { bd = d; best = i; }
    }
    return pts[best][1];
  };
  // Periodic in one pitch.
  for (let k = 0; k < 12; k++) {
    const t = Math.PI * 2 * k / 12;
    if (Math.abs(zAt(t) - zAt(t + pitch)) > 1e-6) { bad.push(`teeth=${teeth}: not periodic in one pitch at ${t.toFixed(3)}`); break; }
  }
  // Antisymmetric about half a pitch: crest against root, everywhere.
  const sums = pts.map(([t]) => zAt(t) + zAt(t + pitch / 2));
  const lo = Math.min(...sums), hi = Math.max(...sums);
  if (hi - lo > 1e-6) bad.push(`teeth=${teeth}: z(t)+z(t+p/2) varies by ${(hi - lo).toFixed(6)} mm — faces would ride on their crests`);
  else console.log(`  teeth=${String(teeth).padStart(2)} toothH=${toothH}: pitch ${(360 / N).toFixed(2)}deg, crest+root constant at ${lo.toFixed(3)} mm`);
}
for (const b of bad) console.log('  ' + b);
console.log(bad.length ? 'self-mating: false' : 'self-mating: true');
process.exit(bad.length ? 1 : 0);
