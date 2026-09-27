# Gates: G13 — js/gen/coaster.js (Coasters and trivets)

Scope: The easy print that is nice to have. Simple enough that the only way to make it interesting is to make it exact.

- [x] G1: the suite passes
  CHECK: node tests/gen-coaster.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen coaster: 97/97 passed | RESULT: PASS

- [x] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-coaster.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (76 builds)  — 76 builds, 0 defects

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-coaster.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: shapes are real and measured: circle, square with any corner radius,
      hexagon, and a superformula outline; a raised lip of a stated height and
      width; a chamfered underside so it does not scrape a table. Assert the
      outer size, the lip height and the internal catchment volume in millilitres.
  EVIDENCE: pending

- [ ] G5: the surface treatments work and stay manifold: a concentric ring
      pattern, a radial pattern, a hex-grid drainage relief, and engraved text
      via js/kernel/text.js. Assert engraved text is genuinely recessed by the
      requested depth by sampling the surface.
  EVIDENCE: pending

- [ ] G6: the trivet variant is different, not just bigger: an open lattice,
      feet, and a stated free-air fraction. Assert the lattice is one connected
      shell rather than several floating pieces.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
