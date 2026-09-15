# Gates: G06 — js/gen/nameplate.js (Text plates, signs and keychains)

Scope: Real letterforms as solid geometry. The generator that proves the font
parser earned its place.

- [x] G1: the suite passes
  CHECK: node tests/gen-nameplate.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen nameplate: 93/93 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-nameplate.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (63 builds)  — 63 builds, 0 defects

- [ ] G3: at least 38 checks in the suite, of which at least 16 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-nameplate.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[8-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the text is genuine outline geometry from js/kernel/text.js, not a
      bitmap and not a stroke font. Assert: a rendered "O" produces a plate with
      a hole through it in the engraved mode and a solid ring in the raised mode,
      the cap height of a 10 mm request measures 10 mm, and a string with a
      descender ("gjpqy") extends below the baseline.
      **Measure the cap height on flat-topped letters only.** The driver checked
      this at 23:04: "EFHI" at a 10 mm request measures exactly 10.000 mm, while
      "O" measures 10.291 — round letters optically overshoot the cap line, which
      is correct typography and not a bug in js/kernel/text.js. Asserting 10 mm
      on a string containing O, G, S or C would fail a correct implementation and
      tempt you into "fixing" it.
  EVIDENCE: pending

- [ ] G5: all the modes build as watertight solids: raised text on a plate,
      engraved text cut into a plate, cut-through (a stencil), and text with no
      plate at all (letters joined by a connecting rail so they print as one
      piece). For the stencil mode assert the counters of "A", "O" and "e" are
      still attached — an unbridged stencil falls apart, and this is the defect
      every naive stencil generator ships with.
  EVIDENCE: pending

- [ ] G6: the practical features work: multiple lines with alignment, letter
      spacing, auto-shrink to a maximum width, plate shapes (rectangle, rounded,
      pill, tag, circle), a border, a keyring hole positioned so it does not
      break the border, a chamfer on the plate edge, and a two-part variant
      (plate plus separate letters) for multi-colour printing where the letters
      are a press fit into the recesses. Assert the press-fit clearance.
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
