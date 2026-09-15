# Gates: G11 — js/gen/datasculpt.js (Data as a printed object)

Scope: A series of numbers becomes a solid. The generator that is about meaning
rather than utility, and the reason Bluesheet is worth building rather than buying.

- [x] G1: the suite passes
  CHECK: node tests/gen-datasculpt.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen datasculpt: 93/93 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-datasculpt.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (66 builds)  — 66 builds, 0 defects

- [ ] G3: at least 34 checks in the suite, of which at least 14 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-datasculpt.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[4-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: at least four mappings, each building a watertight solid from the same
      input series: a **column** where height is time and radius is value (the
      Core Sample form), a **spiral** where the series wraps around a rising
      helix, a **ring/bracelet** where the series is the outer profile of a
      closed loop, and a **ridge landscape** where several series become parallel
      ridges. Each must handle 3 points and 2000 points.
  EVIDENCE: pending

- [ ] G5: the statistical treatment is right, and it matters more than the shape.
      The Core Sample project note is the source for this: it
      documents that **rank-normalising** the series, not log-normalising it, is
      what keeps a savagely skewed series legible, and that a single outlier
      flattens everything else into noise. Offer linear / rank / log / clipped
      normalisation, default to rank, and assert on a deliberately skewed series
      (values 45 to 28000, most of them small) that rank normalisation uses at
      least 80% of the available radius range while log uses less than 50%.
  EVIDENCE: pending

- [ ] G6: it respects the printer's physics, which is what made the original
      object honest. Assert that the radius change between consecutive layers
      never implies an overhang steeper than the configured limit (default 60
      degrees from vertical) — where the data demands a sharper change, the
      geometry must ramp instead, and hints() must say that it did. Also: gaps in
      the series (nulls) render as necks rather than being dropped, and the object
      carries an optional engraved caption via js/kernel/text.js.
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
