# Gates: G19 — js/gen/cammount.js (Camera mounts and clamps)

Scope: Mounts for cameras that are already in use. There is a hand-written cammount.scad in a sibling project — read it, then make it parametric.

- [ ] G1: the suite passes
  CHECK: node tests/gen-cammount.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-cammount.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: node tests/gen-cammount.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: the standard interfaces are dimensionally correct, asserted against
      the real specifications: 1/4-20 UNC tripod thread (use the thread helpers
      from js/gen/thread.js), 3/8-16 UNC, the GoPro two- and three-tab fork with
      its 15 mm tab spacing and 5 mm pin bore, and a cold shoe. Getting these
      wrong makes an object that will not attach to anything.
  EVIDENCE: pending

- [ ] G5: the mounting bases build and hold: flat screw plate, adhesive pad
      recess, pole/pipe clamp parametric to diameter with a bolt boss, corner
      bracket, and a magnet-pocket base. Assert the clamp closes onto the stated
      diameter with the stated grip band.
  EVIDENCE: pending

- [ ] G6: articulation works: a ball head with a stated range of motion and a
      pinch collar, and a friction arm. Assert the ball and socket clearance and
      that the socket's opening is smaller than the ball diameter so it captures.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
