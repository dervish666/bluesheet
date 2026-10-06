import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { analyze } from '../js/kernel/validate.js';
import gen from '../js/gen/qrplaque.js';
suite('gen qrplaque');
conformance(gen, 'qrplaque');
// ---- no zero-area triangles at the defaults or any preset -----------------
// analyze() is the analysis panel's own count. healTJunctions() with
// { clean: true } fans each split triangle from a corner whose edges are whole;
// the plain fan from corner 0 laid slivers flat along the split edge (18 at the defaults, 39 on Link coaster).
// The ear clipper's own slivers (a near-collinear run of cap vertices clipped
// as a ~1e-15 mm² triangle) went to 0 with the 2026-10-06 poly2d fix, and the
// counts here were pinned until then; any nonzero count is a regression.
{
  for (const [name, values] of [['defaults', {}], ...gen.presets.map(p => [p.name, p.values])]) {
    const n = analyze(asMesh(gen.build({ ...defaults(gen), ...values }, ctx()))).degenerateTris;
    check(`${name}: no zero-area triangles`, n === 0, `${n} degenerate`);
  }
}

done();
