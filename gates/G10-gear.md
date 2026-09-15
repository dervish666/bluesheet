# Gates: G10 — js/gen/gear.js (Involute gears and gear trains)

Scope: Gears that mesh, because the involute is computed rather than
approximated. The most mathematically checkable generator in the set.

- [x] G1: the suite passes
  CHECK: node tests/gen-gear.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen gear: 93/93 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-gear.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (81 builds)  — 81 builds, 0 defects

- [ ] G3: at least 38 checks in the suite, of which at least 18 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-gear.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[8-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the tooth profile is a true involute, asserted numerically. Sample
      points along a tooth flank and verify they satisfy the involute of the base
      circle to within 1e-3 mm; assert pitch diameter = module x teeth, base
      diameter = pitch x cos(pressure angle), addendum = module and dedendum =
      1.25 x module for the standard proportions, and that undercut is either
      avoided by profile shift or reported by validate() when the tooth count is
      below the limit for the pressure angle.
  EVIDENCE: pending

- [ ] G5: **two gears actually mesh.** Build a pair, place them at the theoretical
      centre distance, rotate the driver through a full tooth pitch in small
      steps while rotating the driven gear by the exact gear ratio, and assert
      the two solids never interpenetrate and never lose contact by more than
      the specified backlash. Do this in 2D on the tooth profiles — it is cheap
      and it is the only test that proves the generator works.
  EVIDENCE: pending

- [ ] G6: the family is complete and each member is verified: external spur gear,
      internal ring gear, rack, and a planetary set whose tooth counts satisfy
      the assembly condition (ring = sun + 2 x planet, and (sun + ring) divisible
      by the planet count). Plus: helical option, a hub with a bore, a keyway or
      D-shaft flat, set-screw boss, spokes/lightening holes, and backlash and
      clearance parameters expressed in printed millimetres. validate() must
      reject an impossible planetary combination with a message naming the
      arithmetic.
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
