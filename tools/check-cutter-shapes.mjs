// Every built-in cookie-cutter shape, built and checked.
//
// The conformance sweep visits each enum option once at the default settings.
// That is not enough here: a shape can be watertight at size 60 with a 0.8 mm
// blade and fold through itself at size 15, because the blade offset is a fixed
// distance and the shape is not. So this walks the whole library across the
// extremes of the parameters that interact with it.
//
//   node tools/check-cutter-shapes.mjs
import gen, { SHAPE_IDS } from '../js/gen/cookiecutter.js';
import { topology } from '../tests/lib/meshcheck.mjs';

const ctx = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const defaults = {};
for (const q of gen.params) defaults[q.key] = typeof q.def === 'function' ? q.def() : q.def;

// The combinations that actually stress a shape: smallest and largest, thinnest
// and thickest blade, no flange and a wide one, and both extremes of Points.
const CASES = [
  { label: 'default', v: {} },
  { label: 'small+thick', v: { size: 15, blade: 2.4, flangeW: 0 } },
  { label: 'large+thin', v: { size: 160, blade: 0.4, flangeW: 15 } },
  { label: 'points min', v: { points: 3 } },
  { label: 'points max', v: { points: 12 } },
];

let checked = 0;
const defects = [];
for (const shape of SHAPE_IDS) {
  for (const c of CASES) {
    const p = { ...defaults, source: 'shape', shape, ...c.v };
    checked++;
    try {
      const r = gen.build(p, ctx);
      const m = r.mesh;
      const t = topology(m);
      const bb = m.bbox();
      if (t.boundary || t.nonManifold || t.inconsistent) {
        defects.push(`${shape}/${c.label}: bnd ${t.boundary} nonman ${t.nonManifold} wind ${t.inconsistent}`);
      } else if (!(m.volume() > 0)) {
        defects.push(`${shape}/${c.label}: volume ${m.volume().toFixed(3)}`);
      } else if (Math.abs(bb.min[2]) > 1e-5) {
        defects.push(`${shape}/${c.label}: min z ${bb.min[2].toFixed(4)}`);
      } else if (!isFinite(bb.size[0] + bb.size[1] + bb.size[2])) {
        defects.push(`${shape}/${c.label}: non-finite bbox`);
      } else if (r.meta.fellBack) {
        // A named shape that quietly became the fallback disc is the failure
        // mode this whole script exists to catch: it would pass every
        // topology check while being the wrong object entirely.
        defects.push(`${shape}/${c.label}: fell back to the default disc`);
      }
    } catch (e) {
      defects.push(`${shape}/${c.label}: threw ${e.message}`);
    }
  }
}

console.log(`${SHAPE_IDS.length} shapes x ${CASES.length} cases = ${checked} builds`);
for (const d of defects.slice(0, 12)) console.log('  ' + d);
console.log(`${defects.length} defects`);
process.exit(defects.length ? 1 : 0);
