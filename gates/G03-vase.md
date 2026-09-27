# Gates: G03 — js/gen/vase.js (Vases and spiral-mode vessels)

Scope: The generator that has to be beautiful. A vase is judged by eye, so the
parameter space must make ugly hard to reach.

- [x] G1: the suite passes
  CHECK: node tests/gen-vase.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen vase: 103/103 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-vase.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (69 builds)  — 69 builds, 0 defects

- [ ] G3: at least 40 checks in the suite, of which at least 18 are
      domain-specific (not from the shared harness)
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-vase.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(4[0-9]|[5-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: profiles and cross-sections are both parametric and independent —
      a silhouette curve (straight / bell / ogee / waisted / custom control
      points) crossed with a cross-section (circle / superformula / lobed /
      star / squircle / twisted polygon). Assert that at least 5 silhouettes and
      5 cross-sections each build, and that swapping either one changes the mesh.
  EVIDENCE: pending

- [ ] G5: **spiral (vase) mode compatibility is verified, not claimed.** For the
      single-wall variant assert: exactly one shell, no top face, a solid base of
      the requested thickness, no interior geometry at all, and a cross-section
      whose radius is single-valued in angle at every height (a shape that folds
      back on itself cannot be spiralised, and the slicer will not tell you —
      it will silently produce a solid brick, which has happened on this laptop
      before). Provide a param set that would fold back, and assert validate()
      catches it.
  EVIDENCE: pending

- [ ] G6: the surface treatments each work and each remain manifold: vertical
      twist, horizontal ribs/waves, faceting (n-sided), a spiral flute, and
      surface noise with a seeded, deterministic generator. Assert the twist is
      the requested number of degrees by measuring the angular offset between the
      bottom and top cross-sections.
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

## Driver observations, 07:18 (for whoever verifies this)

The generator is built and all 7 variants are watertight (1 shell, Euler 2). Two
things to resolve rather than assume:

1. **The default build is a walled vessel, not the spiral one.** Measured: 59.9 mm²
   of upward-facing surface within 1 mm of the rim — that is a wall annulus, not a
   cap (a capped vase would show roughly 3,800 mm² there), so the mouth is open,
   good. But `hints()` returns `spiral: true` for it. Handing a slicer a hollow
   0.8 mm shell **and** spiral mode is not the same as handing it a solid and
   spiral mode, and Orca will not warn either way. Decide which variant the
   default is and make `hints()` agree with it.

2. **The analysis panel reports the thinnest wall as 0.34 mm** on the default
   parameters. That is below one 0.4 mm extrusion, so if anyone slices this
   *without* spiral mode it will not print. Either raise the floor, or have
   `validate()` say so when spiral mode is off.

Both are "the object is fine, the advice about the object may not be", which is
exactly the class of defect a watertightness test cannot see.
