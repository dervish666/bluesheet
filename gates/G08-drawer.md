# Gates: G08 — js/gen/drawer.js (Drawer and desk organisers)

Scope: Fill an awkward measured space with compartments. The generator that
turns a tape measure into an object.

- [x] G1: the suite passes
  CHECK: node tests/gen-drawer.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen drawer: 98/98 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-drawer.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (64 builds)  — 64 builds, 0 defects

- [ ] G3: at least 34 checks in the suite, of which at least 14 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-drawer.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[4-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: an arbitrary cell layout works, not just a uniform grid. Support a
      rows x columns grid with per-cell row and column spans (so one long
      compartment can sit beside two short ones), per-cell depth, and cells that
      are deliberately left open. Assert: total internal area plus wall area
      equals the outer area within 0.1%, no two cells overlap, and every declared
      cell exists in the mesh (measured by ray-casting down the centre of each
      cell and finding the floor at the expected height).
  EVIDENCE: pending

- [ ] G5: it fits the space it was measured for. Outer dimensions are exact; an
      optional clearance shrinks the part uniformly; a "fill the drawer" mode
      divides a given space into as many equal cells as fit at a minimum cell
      size and reports the leftover. Assert the leftover arithmetic is right and
      that the object never exceeds the stated drawer dimensions.
  EVIDENCE: pending

- [ ] G6: the practical features: chamfered top edges (so things do not catch),
      a radius in the bottom of each cell, optional finger scoops on the front
      cells, a solid or open bottom, and a **split mode** that divides an
      organiser larger than the 180 mm bed into interlocking pieces with dovetail
      or dogbone joints. Assert the split pieces each fit the bed and that their
      joints are complementary within the stated fit clearance.
  EVIDENCE: pending
- [ ] G7: it produces something a person would actually want. At least 4 presets,
      each a recognisably different and *useful* object, each named for what it is
      for rather than for its parameters ("Bolt tin", not "Preset 3").
  EVIDENCE: pending

- [ ] G8: printability is thought about, not assumed. hints() returns real slicing
      advice for this object (layer height, walls, infill, supports yes/no, and
      why), and the test asserts that a deliberately unprintable parameter set is
      caught by validate() rather than silently generating an object that will
      fail on the bed.
  EVIDENCE: pending
