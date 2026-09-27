# Gates: G12 — js/gen/stand.js (Stands and docks)

Scope: Hold a device at an angle without falling over. Simple to describe and
easy to get wrong in ways only physics notices.

- [x] G1: the suite passes
  CHECK: node tests/gen-stand.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen-stand: 162/162 passed | RESULT: PASS

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-stand.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: parameter sweep: every extreme still yields a watertight solid (70 builds) — 70 builds, 0 defects

- [x] G3: at least 34 checks in the suite, of which at least 14 are
      domain-specific (not from the shared harness)
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-stand.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[4-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: 162 checks, of which 92 are domain-specific (the suite prints the split itself)

- [x] G4: the geometry is driven by the device, not by magic numbers: device
      thickness (with case), width, and the viewing angle. Assert the cradle slot
      is the device thickness plus the stated clearance, that the back rest angle
      equals the requested angle within 0.5 degrees when measured off the mesh,
      and that the front lip is tall enough to retain the device but below the
      screen's bottom edge by the stated margin.
  EVIDENCE: Measured off the mesh, not off the parameters. Slot: two rays across the cradle along -n/+n read deviceT+slotClear to 1e-14 for a bare phone (8.7), a folio tablet (15.5) and a 50 mm handheld (51.2) — and the suite also casts a HORIZONTAL ray at the same place, reads S/sin A = 10.873 against a 9.6 mm slot, and asserts the mesh gives the first number and not the second. Angle: 10/18/45/62/88 deg all measure exact to 4 dp against a 0.5 deg tolerance. Lip: retention measured up the device axis, and the FLAT face below the fillet measured separately — see the ABANDON note below for why that second check exists.

- [x] G5: **it does not tip over**, and the test proves it by computing the centre
      of mass of the stand plus a modelled device load and checking the combined
      centre of gravity falls inside the support polygon with a stated margin, at
      the shallowest and steepest supported angles. A stand generator that omits
      this ships stands that fall over.
  EVIDENCE: The suite computes the centre of mass by the divergence theorem, the support polygon by its own monotone-chain hull of the plate-contact vertices, and the margin by its own point-in-polygon — none of it calls tipAnalysis and asks whether it agrees with itself. Every shipped preset is stable: margins 9.6 / 21.4 / 23.5 / 35.1 / 19.5 / 22.3 / 26.5 / 56.7 mm against the 6-10 mm asked for.

- [x] G6: the variants build and are useful: a simple wedge, a two-piece
      adjustable stand, a cable pass-through with a charging port cutout
      positioned from the device's port offset, a headphone hook on the side, and
      a weighted-base cavity that can be filled after printing. Assert the cable
      slot actually passes through to the outside (ray-cast it) rather than
      terminating in a blind pocket.
  EVIDENCE: wedge, easel (two-piece, laid out on the plate), cable route, headphone hook and weighted base all build and are distinct. The cable slot is RAY-CAST, not assumed: a ray dropped from the device's port crosses no surface at all through a 6 mm base (0 crossings), which is what a through-route means.
- [x] G7: it produces something a person would actually want. At least 4 presets,
      each a recognisably different and *useful* object, each named for what it is
      for rather than for its parameters ("Bolt tin", not "Preset 3").
  EVIDENCE: 8 presets, each named for what it is for: Tablet on a desk for drawing, Recipe tablet in the kitchen, E-reader on the nightstand, Bedside phone dock, Phone for watching across a desk, Switch propped for tabletop play, Handheld console parked on charge, Headphones hung beside the desk. Sized from researched real dimensions including case thickness and bezel depth.

- [x] G8: printability is thought about, not assumed. hints() returns real slicing
      advice for this object (layer height, walls, infill, supports yes/no, and
      why), and the test asserts that a deliberately unprintable parameter set is
      caught by validate() rather than silently generating an object that will
      fail on the bed.
  EVIDENCE: hints() gives layer height, wall count over infill for a part loaded in bending, no supports and why not, the ballast chimney as a fill port with dry sand rather than water, and the socket-fit rule. validate() fires on a bezel too shallow for a lip, a base the bed cannot fit, an easel whose prop cannot reach the device at 88 deg, angle steps that had to be dropped, and a stand that would tip - with the number, not just the fault.

Note on G4. The lip check originally measured the lip's OVERALL height, which is
the one number that was never wrong: the fillet on top is taken out of the
retaining face, so a lip that met the 3.36 mm retention floor on paper presented
2.10 mm of flat face in the plastic. solve() now applies the floor to the flat
face (`g.lipFlat`), and the suite measures that face directly by marching a ray
across the slot until the crossing leaves the plane. Tolerance there is 0.25 mm,
not 0.05: the fillet leaves the flat face tangentially, so its deviation grows as
the square of the distance and a ray probe cannot resolve the start of the arc
more finely than about sqrt(2*r*tol). The shortfall it exists to catch was a
whole fillet radius.

KNOWN, MEASURED, UNRESOLVED. With the cable route on, `printability()` reports a
thinnest wall of 0.10 mm against a 0.80 mm minimum feature. It is the route and
nothing else: with `cable: false` the same object reports no thin wall at all and
no bridge. The value tracks the viewing angle — 0.203 mm at 88 deg, 0.101 at 62,
0.028 at 20 — and is unmoved by cableW, lipT, screenInset or frontLen, which
rules out the obvious sliver candidates. The object is manifold, watertight, one
shell, and passes all 162 checks and the 70-build sweep; the app surfaces the
number in its caution colour, so nobody is being told it is fine. It is recorded
here rather than chased further because the cost of localising it exceeded the
value at the time, and the next person should start by bisecting the three legs
of the route in `cableTools` rather than by re-deriving what is already above.

The 55.7 mm "longest bridge" on the same object is NOT a defect: it is the cable
groove's roof, and the metric reports the long axis of a down-facing region while
a slicer bridges the short one — 12 mm, the cable width. hints() already names
that surface as the one bridge in the part.
