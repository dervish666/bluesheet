# Gates: G23 — js/gen/lampshade.js (Pendant lampshades) + the Lighting category

Scope: a printable pendant shade that fits a standard European E27 lampholder
without reverse-engineering somebody else's base. A new `Lighting` category, one
generator, both a one-piece shade that fits a 180 mm bed and a split-into-staves
shade that does not. Held to the same contract as every other generator here:
the parameter sweep, the callouts, and a hand-written suite that proves it is
*the* solid rather than *a* solid.

The E27 numbers this is built on come from the manufacturer's own product page
(lampholders.eu, thermoplastic E27/E26 shade ring, fetched 2026-09-20):
**threaded Ø 40 mm, thread lead 2.5 mm, height 14 mm, external Ø 54 mm** (the
thermoset version is the same thread with a 58 mm external). Nothing here has
been measured on a real holder, and the generator says so in the same words
rather than implying a fit it has not earned.

## The category

- [x] G1: `Lighting` is a first-class category in all three places that hold the
      list — the catalogue order, the conformance whitelist and the generator
      doc — and the catalogue orders it deliberately rather than dropping it at
      the end by accident.
  CHECK: grep -c "Lighting" js/gen/index.js tests/lib/genconform.mjs docs/writing-a-generator.md | tr '\n' ' '
  EXPECT: /index.js:1 tests\/lib\/genconform.mjs:1 docs\/writing-a-generator.md:1/
  EVIDENCE: js/gen/index.js:1 tests/lib/genconform.mjs:1 docs/writing-a-generator.md:1

- [x] G2: the registry is in step with the disk and the catalogue loads the new
      generators without a failure row.
  CHECK: node tools/sync-registry.mjs --check 2>&1 | tail -2 | tr '\n' ' '
  EXPECT: /in step/
  EVIDENCE: current 22 · on disk 22   in step

## The generator

- [x] G3: the suite passes.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | tail -2 | tr '\n' ' '
  EXPECT: RESULT: PASS
  EVIDENCE: gen lampshade: 197/197 passed RESULT: PASS

- [x] G4: the shared contract harness passes with zero sweep defects — every
      numeric parameter at its minimum AND its maximum, and every enum option,
      still a watertight solid resting on the plate.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (73 builds)  — 73 builds, 0 defects

- [x] G5: the suite is not just `conformance()`. At least 40 checks, with the
      domain half measuring the object rather than restating the parameters.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([4-9][0-9]|[1-9][0-9][0-9]+)$/m
  EVIDENCE: 197

- [x] G6: the E27 fitter is real and measured, not a hole with a hopeful name.
      For `ring`, `collar` and `thread` the suite measures the bore in the built
      mesh and asserts the declared diameter; the ring flange is wide enough for
      a 54 mm shade ring to clamp it, measured off the mesh, not assumed; and the
      threaded bore is proved to be a helix rather than a groove.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -cE "the bore really is 41 mm|flat annulus is the 9 mm|shade ring overlaps it|is a helix, not a plain hole"
  EXPECT: /^[6-9]$|^[1-9][0-9]+$/m
  EVIDENCE: 6

- [x] G7: the shade is open at both ends — a tube, not a vase. A ray straight up
      the axis misses the whole object, and with no fitter the closest material
      to the axis is one wall inside the top opening.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -c "see straight down the axis\|one wall inside the top opening"
  EXPECT: /^2$/m
  EVIDENCE: 2

- [x] G8: print orientation is decided, not assumed. Both ways up are measured,
      the better one is built, and the choice flips between a fitted shade and a
      bare shell. Shell faces and solid faces are judged separately, because a
      thin shell holds a lean a flange cannot.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -c "auto takes the shallower\|two cases really do choose differently\|bare shell that narrows upward"
  EXPECT: /^3$/m
  EVIDENCE: 3

- [x] G9: split mode produces staves that assemble. Every part watertight and
      within the bed on its own; the staves cover a full turn with no gap; a lap
      is the same thickness as the wall either side of it to within 15%; and the
      two staves in a lap are separate solids with the glue gap between them,
      which `isSolid` cannot see and the crossing order can.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -c "every stave and the ring is a watertight\|every one of them fits the bed\|cover a whole turn with no gap\|same thickness as the one\|separate solids, not interpenetrating"
  EXPECT: /^5$/m
  EVIDENCE: 5

- [x] G10: validate() catches what actually ruins a printed shade, each naming
      the parameter at fault and its arithmetic, and none of them fires on the
      defaults.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | sed -n '/-- validate --/,/-- hints --/p' | grep -c '^  ok '
  EXPECT: /^(1[5-9]|[2-9][0-9])$/m
  EVIDENCE: 19

- [x] G11: hints() gives advice specific to a lampshade: the orientation and why,
      spiral-mode settings, the wall-to-glow relationship in millimetres, the
      filament argued from the glass transition against the lamp, and the grams.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | sed -n '/-- hints --/,/-- quality --/p' | grep -c '^  ok '
  EXPECT: /^(1[2-9]|[2-9][0-9])$/m
  EVIDENCE: 13

- [x] G12: at least 5 presets, each a shade a person would hang, named for the
      room and the lamp rather than for its parameters. Every one builds
      watertight, rests on the plate and fits the bed.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep -c 'preset ".*" is a watertight solid'
  EXPECT: /^([5-9]|[1-9][0-9]+)$/m
  EVIDENCE: 6

- [x] G13: dimension callouts are declared and measure what they name, at the
      defaults and at every preset.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | grep 'dimension callouts'
  EXPECT: /^  ok /m
  EVIDENCE: ok   dimension callouts are declared and measure what they name (49 dims, 45 checked against a parameter)  — 49 dims

## Integration

- [x] G14: nothing else moved. The fingerprint baseline in this bundle is stale
      on arrival — it predates arm, cookiecutter, creature and cydmount, and ten
      existing cases already differed before any of this work. So the gate is
      that the CHANGED set is still exactly those ten: measured at 10 in a tree
      with lampshade reverted and 10 with it present, byte-identical lists.
  CHECK: node tools/mesh-snapshot.mjs check 2>&1 | grep -c '^  ~ '
  EXPECT: /^10$/m
  EVIDENCE: 10

- [ ] G15: the whole node suite passes. **Not met as written**, and honestly so:
      three suites fail on this machine and all three failed before this work.
      Superseded by G15b.
  EVIDENCE: pending — see G15b.

ABANDON: G15 cannot pass on this Mac and does not depend on this work. Two
  creature suites carry pre-existing failures from the articulated-creatures
  task, and ui.test cannot land CDP key events here. Proved rather than assumed:
  see G15b.

- [x] G15b: every suite that passed before this work still passes, the two new
      suites pass, and the suites that fail fail identically without the new code.
  CHECK: node tests/gen-lampshade.test.mjs 2>&1 | tail -2 | tr '\n' ' '; node tests/gen-lampfitter.test.mjs 2>&1 | tail -2 | tr '\n' ' '; node tools/sync-registry.mjs --check 2>&1 | tail -1
  EXPECT: /RESULT: PASS[\s\S]*RESULT: PASS[\s\S]*in step/
  EVIDENCE: gen lampshade: 197/197 passed RESULT: PASS gen lampfitter: 132/132 passed RESULT: PASS   in step
      The full-suite figure is recorded by hand because `node tests/run.mjs`
      takes longer than gate-check's own command timeout, which returned
      `spawnSync /bin/sh ETIMEDOUT` when this gate tried to run it. Pasted from
      the terminal on 2026-09-20, not remembered:
        SUITES: 42/45 passed
        CHECKS: 6773/6778 passed
        RESULT: FAIL (gen-creature-parts.test.mjs, gen-creature.test.mjs, ui.test.mjs)
      All three fail without this work too. gen-creature-parts 278/280 and
      gen-creature 227/230 measured in a scratch tree with lampshade and
      lampfitter reverted, same two and same three failures. ui.test 107/109
      with lampshade unregistered, failing on the same "typing in the catalogue
      filters it" — its keystrokes never reach the search box on this Mac, which
      is a CDP problem and not a catalogue one: the same filter run offline
      narrows 22 generators to 2 on the term "box". The other ui failure needs
      OrcaSlicer, which `api/health` reports as absent here. plate.test.mjs
      passes once `python3 server.py` is up on 8132.

- [x] G16: the falsification bites. Seven mutations of lampshade, each watched
      going red on the checks aimed at it.
  EVIDENCE: re-run against the current suite on 2026-09-20, pasted from the
      terminal rather than remembered:
        UNMUTATED                      197 ok,  0 red
        bore 1 mm oversize             191 ok,  6 red
        scarf removed                  194 ok,  2 red
        squircle un-normalised         196 ok,  1 red
        orientation forced down        194 ok,  3 red
        shoulder wall ramped again     196 ok,  1 red
        bell profile back to t^0.45    196 ok,  1 red
        shell/solid lean merged        195 ok,  2 red
      Two of these were worth more than the tick they earned.
      The scarf mutation broke only ONE check at first, because "the staves do
      not interpenetrate" was leaning on isSolid() — and two overlapping closed
      solids are each perfectly manifold, so isSolid cannot see an
      interpenetration at all. Replaced with the order of ray crossings through
      a lap (in, out, in, out, with the glue gap between), which does see it.
      "Shell/solid lean merged" is the one that proves the orientation model is
      load-bearing rather than decorative: stop separating a thin shell's lean
      from a solid ceiling's and the generator can no longer tell the two ways
      up of a plain shade apart.


- [x] G17: a `lampfitter` generator in the same category, making the hardware the
      shade needs. Own gates file, G24.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | tail -2 | tr '\n' ' '
  EXPECT: RESULT: PASS
  EVIDENCE: gen lampfitter: 132/132 passed RESULT: PASS

- [ ] G18: glow relief — a pattern on the inner surface only, so the shade draws
      in light rather than in shadow.
  EVIDENCE: pending — not built.

ABANDON: G18 not built, and not started. Time went into the two things that were
  asked for (the fitter options and split mode) and into the one that was not but
  turned out to matter more, the bore gauge. The groundwork is there whenever it
  is wanted: the inner surface is already an independent field (`inset` on each
  meridian station), so a relief is a function added to that inset and a clamp
  against R_MIN. Walled mode only — spiral has one extrusion and nothing to vary.
