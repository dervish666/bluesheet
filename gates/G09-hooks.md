# Gates: G09 — js/gen/hooks.js (Hooks, clips and wall hardware)

Scope: The small useful family — the things you print because you needed one
this afternoon.

- [x] G1: the suite passes
  CHECK: node tests/gen-hooks.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen hooks: 116/116 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-hooks.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (96 builds)  — 96 builds, 0 defects

- [ ] G3: at least 34 checks in the suite, of which at least 14 are
      domain-specific (not from the shared harness)
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-hooks.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[4-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: at least six distinct types, each parametric and each a watertight
      solid: a J-hook, a cable clip (the C-shaped kind that snaps over a cable),
      an adhesive-mount wall hook, a screw-mount bracket, a headphone/tool hanger,
      and a cable comb or spool. Each must build across its full parameter range.
  EVIDENCE: pending

- [ ] G5: they are engineered rather than merely shaped. Assert: a fillet at
      every load-bearing root (a sharp internal corner is where a printed hook
      snaps, along the layer line), the load path is oriented so the print's weak
      axis is not the loaded axis and hints() says which way up to print it, the
      snap-fit clip's opening is between 0.7 and 0.95 of the cable diameter so it
      grips, and the wall thickness is a whole number of extrusions.
  EVIDENCE: pending

- [ ] G6: the mounting details work: countersunk screw holes with the correct
      82 or 90 degree cone, a slot rather than a hole where alignment matters,
      an adhesive pad recess of a stated size, and an optional captive nut pocket.
      Assert the countersink angle by measuring the cone in the mesh.
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

## Known defect, recorded rather than hidden (driver, 12:26)

`plateT`'s declared maximum was 16 mm. On the **J-hook only**, at the default
plate height, somewhere above **15.6 mm** the shank meets the back plate exactly
tangentially and two edges come out non-manifold — the conformance sweep caught
it. It disappears at any other plate height and on every other type.

The declared maximum is now 15, because a maximum that cannot be built is not a
maximum. That is a cap, not a cure: the underlying tangency is still there and
would reappear if the shank geometry changed. Fixing it properly means nudging
the J-hook's shank off exact tangency where it meets the plate.

Reproduce:
    node --input-type=module -e "import gen from './js/gen/hooks.js';
      import { defaults, ctx, asMesh } from './tests/lib/genconform.mjs';
      import { topology } from './tests/lib/meshcheck.mjs';
      console.log(topology(asMesh(gen.build({...defaults(gen), type:'jhook', plateT:15.9}, ctx('normal')))))"
