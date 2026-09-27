# Gates: G14 — js/gen/planter.js (Self-watering planters)

Scope: A pot that keeps a plant alive for a fortnight. The only generator here whose failure mode is a dead plant.

- [ ] G1: the suite passes
  CHECK: node tests/gen-planter.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-planter.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-planter.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the reservoir actually works as a system, and the test proves the
      hydraulics arithmetically: an inner pot with a wick well that reaches into
      a lower reservoir, a stated reservoir volume in millilitres computed from
      the geometry, an overflow port at the correct height so it cannot flood,
      and a fill port reachable without lifting the inner pot out.
  EVIDENCE: pending

- [ ] G5: it is watertight in the real sense as well as the topological one.
      hints() must specify enough walls and bottom layers to actually hold water
      (at least 4 walls / 6 bottom layers, or vase mode with a solid base) and
      say so. Assert the wall thickness is a whole number of 0.4 mm extrusions.
  EVIDENCE: pending

- [ ] G6: variants build and are useful: round, square and hexagonal; a matching
      saucer sized to the pot's footprint plus a clearance; drainage-only mode
      with no reservoir; and a hanging variant with cord holes. Assert the saucer
      and the pot fit with the stated clearance.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
