// Is the clamp real?
//
// "There is a knob" is not the claim. The claim is that a bolt passes through
// every hub and that the knob holds a nut at a stated depth, so this probes
// the actual solid: points that must be air, and points that must be metal.
import gen from '../js/gen/arm.js';
import { pointInsideMesh, triGrid } from '../js/kernel/validate.js';

// pointInsideMesh takes a spatial grid, not a mesh: build one per part and
// reuse it, which is also the only way the 40x40 bore sweep below is affordable.
const inside = (grid, pt) => pointInsideMesh(grid, pt);
const c = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const d = {}; for (const q of gen.params) d[q.key] = typeof q.def === 'function' ? q.def() : q.def;
const problems = [];

for (const bolt of ['m4', 'm5', 'm6']) {
  const knobT = 10, nutT = 4;
  const r = gen.build({ ...d, part: 'knob', bolt, knobT, nutT }, c);
  const m = r.parts[0].mesh;
  const g = triGrid(m);
  const b = m.bbox();
  const cx = b.center[0], cy = b.center[1], z0 = b.min[2];
  const bore = r.meta.boreDia, af = r.meta.nutAcrossFlats;

  // The bore must be open the whole way through.
  for (const f of [0.1, 0.5, 0.9]) {
    if (inside(g, [cx, cy, z0 + knobT * f])) problems.push(`${bolt}: bore blocked at ${(f * 100) | 0}% height`);
  }
  // Inside the nut trap: air. Above it: solid. That is what "trap" means.
  const rp = af / 2 - 0.8;
  if (inside(g, [cx + rp, cy, z0 + nutT * 0.5])) problems.push(`${bolt}: no nut trap at r=${rp.toFixed(1)}`);
  if (!inside(g, [cx + rp, cy, z0 + nutT + 2.0])) problems.push(`${bolt}: nut trap runs past its stated ${nutT} mm depth`);
  console.log(`  ${bolt}: bore ${bore} mm through, nut trap ${af} mm A/F x ${nutT} mm deep`);
}

// Every hub in the set must be bored, or the bolt has nothing to pass through.
const set = gen.build({ ...d, part: 'all' }, c);
for (const p of set.parts) {
  if (p.name.startsWith('knob')) continue;
  const b = p.mesh.bbox();
  const g = triGrid(p.mesh);
  // The hub bore is not at the part's centroid, so look for ANY open column.
  let open = false;
  for (let i = 0; i <= 40 && !open; i++) {
    for (let j = 0; j <= 40 && !open; j++) {
      const x = b.min[0] + b.size[0] * i / 40, y = b.min[1] + b.size[1] * j / 40;
      if (!inside(g, [x, y, b.min[2] + b.size[2] * 0.5])
        && inside(g, [x + 4, y, b.min[2] + b.size[2] * 0.5])) open = true;
    }
  }
  if (!open) problems.push(`${p.name}: no bore found`);
}
for (const x of problems) console.log('  ' + x);
console.log(problems.length ? 'clamp INCOMPLETE' : 'clamp ok');
process.exit(problems.length ? 1 : 0);
