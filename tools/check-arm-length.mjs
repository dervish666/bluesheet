// Does the arm actually come out the length you asked for?
//
// Measured off the mesh, not off the parameter: the arm is a bar with a hub of
// diameter hubD centred at each end, so the bounding box along the bar is
// armLength + hubD, and the hub-centre spacing is what "length" means.
import gen from '../js/gen/arm.js';
const c = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const d = {}; for (const q of gen.params) d[q.key] = typeof q.def === 'function' ? q.def() : q.def;

const cases = [[40, 30], [90, 30], [150, 30], [120, 60], [36, 30]];
let ok = 0;
for (const [want, hubD] of cases) {
  const r = gen.build({ ...d, part: 'arm', armCount: 1, armLength: want, hubD }, c);
  const s = r.mesh.bbox().size;
  const along = Math.max(s[0], s[1]);
  const got = along - hubD;
  // The generator refuses to make an arm shorter than its own hubs, because
  // tangent hubs are a degenerate union; that floor is part of the contract.
  const expect = Math.max(want, hubD + 6);
  const good = Math.abs(got - expect) < 0.6;
  if (good) ok++;
  console.log(`  asked ${String(want).padStart(3)} hubD ${hubD} -> centres ${got.toFixed(2)} mm (expect ${expect})${good ? '' : '  MISMATCH'}`);
}
console.log(`length ok: ${ok}/${cases.length}`);
process.exit(ok === cases.length ? 0 : 1);
