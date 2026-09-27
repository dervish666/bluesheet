# Gates: G22 — js/gen/creature.js + js/kernel/joint.js (articulated creatures)

Scope: a print-in-place segmented creature that comes off the plate already
jointed. Every segment is its own shell, joined to the next by a ball in a
socket (or a hinge), with a clearance gap that has to survive the printer. The
generator is the easy half. The joint is the half that can be wrong in a way you
only discover four hours into a print, which is why it lives in the kernel and
is tested there with no creature around it.

**The joint clearance is MEASURED** (2026-09-23): the Joint gauge printed on
the A1 mini in PLA at 0.20 mm Standard. 0.25 fused, 0.30 moves, 0.35 is best,
0.45 rattles but stays captive. `FIT.free` stays 0.35 and now has a `MEASURED`
entry in `js/kernel/fit.js`, so the geometry did not move and neither did the
fingerprints. The gate stays open on G7 (the overhang look) only.

## The joint

    segment A                       gap c              segment B
    .........|                                  |.......................
             |  shoulder  stalk                 |   socket (B's body)
             |=========\______      ________    |       ______
             |          ______|====(  ball  )   |      /      \  wall
             |=========/            ‾‾‾‾‾‾‾‾    |      \______/
    .........|                   ^ mouth cone   |.......................
                                   half-angle = swing + stalk half-angle

A side is **stitched**: shoulder, stalk and ball are radii up the joint's axis,
fed to `tubeThrough` as one ring list with the body's own rings. No boolean.
B side is **carved**: the socket cavity is `cutB`, the mouth cone opens it.
Clearance is applied by growing the cut, never by shrinking the ball, so it is
applied exactly once.

At the defaults (bodyR 9, clearance 0.35, swing 25): ball 2.70 mm, stalk
1.13 mm, socket wall 1.00 mm, mouth 46.8 degrees, aperture 2.22 mm.

## Facet alignment: the rule that keeps the gap

The ball and the socket must be cut into the **same number of facets**. Equal
counts put every socket facet parallel to the ball facet facing it and the
faceting error cancels out of the gap. Scale the socket's resolution to its own
radius, the obvious move, and the errors add instead.

    concentric spheres, 0.35 nominal     aligned    misaligned
      draft quality                      0.3369     0.1790
      normal quality                     0.3467
    the assembled creature, normal       0.3441     (gate: >= 0.315)

Measured by `tests/joint.test.mjs` on bare spheres and by
`tests/gen-creature.test.mjs` on the built creature. The creature's tube is
`tubeFacets(ctx)` = 24 and the stitched ball takes its longitude count from the
tube, so the match rests on `nseg(24, …)` agreeing with the socket's builder at
every quality. It holds by one step of margin at draft (24 x 0.5 = 12, and
builders' floor is 3, creature's 8). Mutating the tube to 16 facets drops the
gap to 0.3218 at normal and 0.2745 on the smallest draft body, under the gate.

## The mouth angle and captivity

The mouth cone must clear the swing **and** the stalk's own half-angle seen
from the ball centre. Choosing the angle instead of deriving it is how a joint
asked for 25 degrees ends up shut at 15 (a fixed 28-degree mouth, measured).

    stalkHalf  = asin(stalkR / (ballR + c))           21.8 deg at the defaults
    mouthDeg   = swing + stalkHalf                    46.8 deg
    apertureR  = (ballR + c) * sin(mouthDeg)          2.22 mm   (mouthDeg < 90)
               = (ballR + c)                          open      (mouthDeg >= 90)

    captive  <=>  apertureR < ballR                   2.22 < 2.70, margin 0.48 mm

The ball leaves through the circle where the mouth cone crosses the socket
sphere. At the defaults captivity is lost at a swing of **41 degrees**; the
swing parameter stops at 35 (margin 0.15 mm), so every legal swing is captive.
Past 90 degrees `sin` comes back down, which would report a wide-open socket as
captive. `ballGeometry` switches to the equator there for that reason.

## The four gates, and what makes each one fail

| Gate | Asserts | The input that must make it fail |
|---|---|---|
| 1. Gap | min shell gap >= 0.9 x clearance, measured off the triangles; pinned to 0.3441 so a clearance applied twice (0.69) cannot pass either | Tube facets 16 instead of 24: 0.3218. A socket at its own resolution: 0.1790 at draft |
| 2. Falsifier | Gate 1 run at clearance 0 must fail | Clearance 0 itself. Segments weld and the gate goes red; `minShellGap` alone would read Infinity and pass, hence `jointGateHolds` |
| 3. Captivity | apertureR < ballR at min, default and max swing | Swing 41 degrees or more at the default body |
| 4. Shell count | N segments are N shells, at 4, 12 and 20 | Clearance 0: the count collapses below 12 |

## Gates

- [x] G1: the creature and joint suites pass.
  CHECK: node tests/run.mjs creature 2>&1 | tail -2; node tests/joint.test.mjs 2>&1 | tail -1
  EXPECT: RESULT: PASS (twice)
  EVIDENCE: 2026-09-23 full run, seven creature suites 814/814, joint 215/215.
      Whole suite 49/50, 7189/7191: ui.test.mjs's two known environment
      failures (catalogue keystrokes over CDP; OrcaSlicer not installed).

- [x] G2: the shared contract harness passes with zero sweep defects.
  CHECK: node tests/gen-creature.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /^  ok /m
  EVIDENCE: 51 builds, 0 defects

- [x] G3: the facet-alignment numbers hold, and the misaligned one still reads half.
  CHECK: node tests/joint.test.mjs 2>&1 | grep -E 'aligned facets hold|and still hold it at draft|loses half the gap'
  EXPECT: three `ok` lines
  EVIDENCE: 0.346653, 0.336923, 0.179011

- [x] G4: the tube and the ball share a facet count at draft, normal and fine.
  CHECK: node tests/gen-creature.test.mjs 2>&1 | grep -c 'same number of facets'
  EXPECT: 3, all `ok`
  EVIDENCE: 12/12-gon draft, 24/24 normal, 48/48 fine

- [x] G5: the four gates above pass and their falsifiers fail.
  CHECK: node tests/gen-creature.test.mjs 2>&1 | grep -E '0.9 x the clearance|zero clearance|narrower than the ball|every legal swing|separate pieces'
  EXPECT: every line `ok`
  EVIDENCE: 8/8 ok. Gap 0.3441; zero clearance welds to 1 shell; aperture
      2.22 vs ball 2.70; 4, 12, 20 segments are 4, 12, 20 shells

- [x] G6: fingerprints recorded, and the tool proven able to see a change.
  CHECK: node tools/mesh-snapshot.mjs check | tail -1
  EXPECT: RESULT: IDENTICAL
  EVIDENCE: 151/151. Perturbed first: tapered 0.45 -> 0.46 flagged exactly
      default, Dragon, Lizard, Snake; reverted, IDENTICAL

- [ ] G7: looked at in the browser. Toys → Articulated Creature, all six
      presets, overhang view on a ball joint: the socket roof is the only
      thing flagged.

- [x] G8: **the clearance is measured.** The Joint gauge has been printed,
      all five joints flexed, and `MEASURED` in `js/kernel/fit.js` carries a
      `free` entry: value, machine, material, slicer quality, date, Sam's words.
      `FIT.free` set to that number, then `mesh-snapshot write` re-run, because
      every creature's geometry moves with it and that is correct.
  CHECK: node -e "import('./js/kernel/fit.js').then(f => console.log(f.measured('free') ? 'MEASURED' : 'GUESS'))"
  EXPECT: MEASURED
  EVIDENCE: MEASURED | 0.35 mm was measured on Bambu A1 mini, 0.4 mm nozzle in
      PLA, Bambu Studio 0.20 mm Standard on 2026-09-23.

## Known limits, with numbers

- **B-side booleans.** `cutB`/`addB` still carve. 1.0% of joints roll 2 to 4
  non-manifold edges, scurve-weighted (ruling 41). A dice roll per joint, not a
  map of safe numbers (ruling 29). Measure a species row with
  `node tools/check-creature-envelope.mjs`, `--falsify` first.
- **A limb on a short fat body** fouls the neighbour's ball sideways. Fails at
  bodyR/segLen 0.81, passes at 0.77 and below. `validate()` warns; two checks
  pin it as still broken.
- **The gauge failed four times, then printed first time on a different
  reel** (2026-09-23). One had detached, one spaghettified: adhesion, not the
  geometry. The round belly was kept; a shaved flat was tried in Task 13 and
  broke the socket boolean on part-free segments.
- **The dragon's mandible floats 0.5 mm above the plate.** It is captive in
  the head's socket and its underside is set by the jaw, not the spine. It
  predates Task 13 and is pinned in `gen-creature-plate.test.mjs`.
