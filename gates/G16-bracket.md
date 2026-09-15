# Gates: G16 — js/gen/bracket.js (Shelf and angle brackets)

Scope: The generator where a wrong answer falls off a wall. Engineering, not shape-making.

- [ ] G1: the suite passes
  CHECK: node tests/gen-bracket.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-bracket.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: node tests/gen-bracket.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: geometry driven by the load, not by taste: arm lengths, thickness, a
      gusset or a curved web, and a fillet at the root whose radius is a stated
      fraction of the thickness. Assert the fillet exists by measuring the local
      radius of the mesh at the inside corner.
  EVIDENCE: pending

- [ ] G5: it states what it can hold and shows the arithmetic. Compute the
      section modulus at the root, apply a printed-PLA/PETG allowable stress with
      a stated knock-down factor for layer adhesion, and report a safe working
      load in kilograms in hints(), together with the assumptions. A bracket
      generator that does not say what its bracket holds is a decoration
      generator. Assert the number changes correctly with thickness cubed.
  EVIDENCE: pending

- [ ] G6: the mounting is real: countersunk or counterbored holes at real screw
      sizes (M3 to M6 and #6/#8 wood screws), slots for adjustment, a wall-side
      relief so a proud plaster edge does not rock it, and an optional captive
      nut pocket. Assert hole diameters against the nominal screw table.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
