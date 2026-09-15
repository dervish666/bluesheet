# Gates: G04 — js/gen/thread.js (Threaded containers)

Scope: Screw threads that actually screw together when printed with a 0.4 mm
nozzle. Tolerance is the whole product here.

- [ ] G1: the suite passes
  CHECK: node tests/gen-thread.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-thread.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 40 checks in the suite, of which at least 18 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-thread.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(4[0-9]|[5-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the thread geometry is a real thread form, verified numerically:
      ISO metric 60-degree V (with the standard crest and root truncation),
      trapezoidal, and a printer-friendly rounded form. Assert the measured pitch
      matches the requested pitch, the major and minor diameters match the
      computed values for the form, and the lead is pitch x starts for
      multi-start threads.
  EVIDENCE: pending

- [ ] G5: **the jar and the lid actually fit**, checked by computation rather
      than by hope: sample the external thread's radius and the internal thread's
      radius at the same helical parameter over a full turn and assert the
      radial clearance is within the requested tolerance band everywhere, never
      negative, and never more than 0.6 mm. This is the gate the whole generator
      exists to pass.
  EVIDENCE: pending

- [ ] G6: the practical details are present and tested: configurable tolerance
      (loose / normal / tight, in millimetres, documented as printed-part
      clearance), a chamfered thread start so it does not cross-thread, a lid
      with knurling or flutes that a wet hand can grip, an optional gasket
      groove, an optional captive-lid stop, a flat top the printer can start on,
      and a thread that ends cleanly rather than in a knife edge. Also assert the
      thread's overhang never exceeds the printable limit for its form.
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
