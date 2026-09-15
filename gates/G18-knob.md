# Gates: G18 — js/gen/knob.js (Control knobs and thumbwheels)

Scope: Small, tactile, and entirely about the fit onto the shaft.

- [ ] G1: the suite passes
  CHECK: node tests/gen-knob.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-knob.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: node tests/gen-knob.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the shaft fittings are correct and measured off the mesh: round bore,
      D-shaft with the flat at the standard depth, knurled potentiometer shaft
      (assert the internal splines), hex, and square. Each with a stated
      clearance and an optional set-screw boss sized for an M3 grub screw and a
      captive nut.
  EVIDENCE: pending

- [ ] G5: the grip is real geometry rather than a texture: straight flutes,
      diamond knurl, scalloped, and a plain skirt. Assert the flute count and
      that the knurl does not self-intersect at its extremes of depth and pitch.
  EVIDENCE: pending

- [ ] G6: it can be read as well as turned: an optional pointer or line marker,
      an indexed skirt with a stated number of engraved graduations, and numerals
      via js/kernel/text.js. Assert the graduations are evenly spaced round the
      circle to within 0.1 degree.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
