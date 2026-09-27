# Gates: G20 — js/gen/sundial.js (Sundials)

Scope: The one object here whose correctness is checkable against the sky. Astronomy, printed.

- [ ] G1: the suite passes
  CHECK: node tests/gen-sundial.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-sundial.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-sundial.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: **the hour lines are computed, not drawn.** For a horizontal dial the
      hour-line angle from noon satisfies tan(theta) = sin(latitude) x tan(H)
      where H is the hour angle (15 degrees per hour). Assert this for every hour
      line at three different latitudes, to 0.05 degrees. The gnomon's angle above
      the base equals the latitude — assert that off the mesh.
  EVIDENCE: pending

- [ ] G5: it is honest about what a sundial tells you. hints() must state that it
      reads solar time, give the longitude correction for the site in minutes
      (4 minutes per degree from the standard meridian), and mention the equation
      of time. Offer an optional analemma or an engraved correction table.
      A dial that claims to tell clock time is wrong by up to 45 minutes.
  EVIDENCE: pending

- [ ] G6: the forms build and are dimensionally right: horizontal, vertical
      (south-facing, with its own hour-line formula), and equatorial. Engraved
      Roman or Arabic numerals via js/kernel/text.js placed on the hour lines,
      a compass rose or a north marker, and a base with a spirit-level recess.
      Assert the numerals land on their own hour lines.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
