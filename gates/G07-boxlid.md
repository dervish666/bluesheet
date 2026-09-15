# Gates: G07 — js/gen/boxlid.js (Boxes with lids)

Scope: A box is the most useful thing a printer makes. This one has to close
properly.

- [x] G1: the suite passes
  CHECK: node tests/gen-boxlid.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen-boxlid: 171/171 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-boxlid.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (87 builds)  — 87 builds, 0 defects

- [ ] G3: at least 38 checks in the suite, of which at least 16 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-boxlid.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[8-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: three closure types, each verified dimensionally: **friction fit**
      (an inner lip with a specified clearance, chamfered to guide it in),
      **threaded** (reusing js/gen/thread.js's thread geometry if it exports
      usable helpers, otherwise its own), and a **print-in-place hinge** with a
      snap catch. For the hinge, assert the pin-to-socket clearance is at least
      0.35 mm everywhere (below that it fuses on a 0.4 mm nozzle) and that the
      hinge geometry does not self-intersect through its full range of motion at
      0, 45, 90 and 180 degrees.
  EVIDENCE: pending

- [ ] G5: the body is right: outer dimensions or inner dimensions selectable
      (a person measuring the thing that must fit inside should not have to do
      the arithmetic), wall thickness a whole number of 0.4 mm extrusions by
      default, floor thickness separately settable, rounded or chamfered corners,
      an optional radius on the inside floor for strength, stackable feet, and
      an optional divider grid with per-cell spans. Assert the internal volume
      matches the requested internal dimensions within 0.05 mm.
  EVIDENCE: pending

- [ ] G6: the details a real box needs: a finger notch or thumb relief so the lid
      can be opened, ventilation slots as an option, a label recess, screw or
      magnet mounting points, and a variant that prints the lid flat next to the
      box on the same plate. Assert the two-part plate layout does not overlap
      and still fits the bed.
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
