# Gates: G15 — js/gen/hexpanel.js (Honeycomb wall panels and mounts)

Scope: A wall system: panels that tile, and accessories that clip into them. Everything must interlock with everything.

- [ ] G1: the suite passes
  CHECK: node tests/gen-hexpanel.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-hexpanel.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: node tests/gen-hexpanel.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the panels tile. Build a 2x2 arrangement and assert the hex grid is
      continuous across every seam, that adjacent panels' joining features are
      complementary to the stated clearance, and that a panel fits the bed.
  EVIDENCE: pending

- [ ] G5: the accessories fit the panel, checked by computation: at least five
      mount types (hook, shelf, cup, tool clip, bin holder), each with the
      panel-side clip geometry sampled against the panel's socket geometry over
      the full engagement, asserting a clearance between 0.15 and 0.5 mm.
  EVIDENCE: pending

- [ ] G6: mounting and strength: countersunk screw positions that land in the
      panel's solid regions rather than in a hole, a fillet at every clip root,
      and hints() stating the print orientation that puts the layer lines across
      the load rather than along it.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
