# Gates: G24 — js/gen/lampfitter.js (E27 bore gauge and spider)

Scope: the two small parts `lampshade` cannot be. A bore gauge, because the
41 mm default in the shade is the published Ø 40 mm European E27 thread plus a
millimetre of slip and not a measurement of anyone's holder — and because a
vertical hole comes off a 0.4 mm nozzle two or three tenths undersize, so the
number that matters is a property of the printer as much as the lampholder. And
a spider, because a drum shade's top opening is far too wide to close with a
flange and a hundred years of lampshades already solved that.

Both are one 2D outline cut with poly2d and extruded once: no CSG, nothing that
can fail on a coplanar face.

- [x] G1: the suite passes.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | tail -2 | tr '\n' ' '
  EXPECT: RESULT: PASS
  EVIDENCE: gen lampfitter: 132/132 passed RESULT: PASS

- [x] G2: the shared contract harness passes with zero sweep defects.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok   parameter sweep: every extreme still yields a watertight solid (26 builds)  — 26 builds, 0 defects

- [x] G3: at least 60 checks, most of them measuring the parts rather than
      restating their parameters.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([6-9][0-9]|[1-9][0-9][0-9]+)$/m
  EVIDENCE: 132

- [x] G4: every collar's bore is measured in the built mesh and is the diameter
      it claims, to better than 1.2%. A gauge that reports the wrong number is
      worse than no gauge, because it will be believed.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep -c 'the bore measures'
  EXPECT: /^[4-9]$|^[1-9][0-9]+$/m
  EVIDENCE: 4

- [x] G5: the gauge can be read. The tick marks are counted off the mesh, on the
      collars the ladder actually builds — not on collars handed the number by
      the test, which is the version that let "every collar gets three ticks"
      pass.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep -c 'reads back as\|every collar the ladder builds'
  EXPECT: /^[5-9]$|^[1-9][0-9]+$/m
  EVIDENCE: 5

- [x] G6: the spider has the arms it says it has, counted by walking a circle
      between the hub and the rim and counting solid runs. This is the check that
      stops a "spider" quietly coming out as a disc with a hole in it.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep -c 'arms between the hub and the rim'
  EXPECT: /^[4-9]$|^[1-9][0-9]+$/m
  EVIDENCE: 5

- [x] G7: the spider's hub reaches past the radius of a 54 mm shade ring, so the
      ring has something to clamp rather than fresh air.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep 'shade ring to clamp it'
  EXPECT: /^  ok /m
  EVIDENCE: ok   the hub reaches far enough for a 54 mm shade ring to clamp it  — hub to 28.5 mm, ring to 27.0 mm

- [x] G8: the default gauge is one plate-load. A gauge that is two prints is not
      the thing you do before the six-hour shade.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | grep 'one plate-load, not two'
  EXPECT: /^  ok /m
  EVIDENCE: ok   the default set is one plate-load, not two  — 1 plates

- [x] G9: validate() and hints() are driven, and nothing fires on the defaults.
  CHECK: node tests/gen-lampfitter.test.mjs 2>&1 | sed -n '/-- validate --/,$p' | grep -c '^  ok '
  EXPECT: /^(1[5-9]|[2-9][0-9])$/m
  EVIDENCE: 22

- [x] G10: the falsification bites. Five mutations, each watched going red.
  EVIDENCE: re-run against the current suite on 2026-09-20, pasted from the
      terminal rather than remembered:
        UNMUTATED                      132 ok,  0 red
        bore 0.3 mm oversize           129 ok,  3 red
        every collar gets 3 ticks      129 ok,  3 red
        spider arm gaps never cut      127 ok,  5 red
        keyring hole removed           130 ok,  1 red
        ladder starts one step high    128 ok,  4 red
      The tick mutation is the one that earned its keep. The first version of
      that check measured collars the TEST handed a number to, so giving all six
      the same mark passed the measurement and failed the user: it broke only the
      two checks that read the generator's own `ticks` field. Counting the
      notches on the collars the LADDER builds is what catches it, and that
      version reads back 3,3,3,3,3,3 from 39..44 mm.

- [ ] G11: the gauge has been printed and used on the actual pendant, and the
      number it gave has been written into `js/kernel/fit.js` MEASURED, where a
      guess becomes a measurement.
  EVIDENCE: pending — needs a printer and the lampholder, neither of which is on
    this machine. Everything shipped tonight says 41 mm is published rather than
    measured; this gate is where that stops being true.

ABANDON: G11 no printer or lampholder on this machine. Handed to Sam: print the
  default gauge, try it on the pendant, and the collar that grips is the Bore to
  type into the shade. Until then every bore figure in Lighting is the published
  European Ø 40 mm plus slip, and the help text says so.
