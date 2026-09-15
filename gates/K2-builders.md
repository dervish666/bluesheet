# Gates: K2 — js/kernel/builders.js (2D to 3D, and the primitive set)

Scope: every way a cross-section becomes a solid, plus the primitives generators
lean on. This module decides how good Bluesheet's objects can look.

- [x] G1: suite passes
  CHECK: node tests/builders.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: builders: 800/800 passed | RESULT: PASS

- [x] G2: every export exercised
  CHECK: node tests/coverage.mjs js/kernel/builders.js tests/builders.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: COVERAGE: 26/26 exports covered | missing: none

- [ ] G3: at least 80 checks — this is the widest module in the kernel
  CHECK: node tests/builders.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(8[0-9]|9[0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: EVERY builder and primitive produces a watertight, correctly wound,
      positive-volume solid — asserted with tests/lib/meshcheck.mjs isSolid() on
      each one, including the awkward cases: extrude with a hole, extrude with
      twist, extrude with taper, revolve of a profile that touches the axis,
      revolve of a partial angle (which must cap the ends), loft between
      different vertex counts, sweep round a closed path, and a heightfield with
      a skirt.
  EVIDENCE: pending

- [ ] G5: volumes are right against analytic formulas, within the discretisation
      error you would expect and no more: cylinder, sphere, torus, cone, tube,
      box, extruded rectangle-with-hole, revolved rectangle (= tube). State the
      tolerance used and why.
  EVIDENCE: pending

- [ ] G6: the degenerate inputs do not produce broken solids — zero height, a
      single-point ring, a self-intersecting profile, 2 segments requested on a
      cylinder, negative radius, a heightfield of all zeros. Each must either
      throw a clear error or return a valid mesh. Silently returning a broken
      mesh fails this gate.
  EVIDENCE: pending

- [ ] G7: revolve and extrude place a seam that does not leave a crack — proven
      by welding at 1e-6 and asserting zero boundary edges, not by eye.
  EVIDENCE: pending

- [ ] G8: ctx.segFactor is honoured — a 'fine' build has more triangles than a
      'draft' build of the same primitive, and both are watertight.
  EVIDENCE: pending
