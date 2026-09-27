# Gates: G21 — js/gen/skadis.js (IKEA Skådis pegboard accessories)

Scope: The accessory family for a board Sam already owns and has already printed
for. The object is not "a hook" — it is the *mount*, eleven times over. Get the
tab right and every type is a different arm on the same proven interface; get it
wrong and eleven types are eleven parts that fall off the wall.

## The board

Skådis openings are **not round holes**. Every one is a vertical obround
**5 mm wide × 15 mm tall with 2.5 mm end radii**, on a **40 mm** grid with
alternate columns dropped **20 mm**, in a board about **5 mm** thick. Those
figures are community-measured — IKEA publishes nothing — but they are
corroborated by two independent sources and, more usefully, by Sam having
printed a dozen MakerWorld accessories that all fitted his board. They are
therefore the defaults, and they are also **parameters**, so a board that
disagrees is one number away from working rather than a rewrite.

The 15 mm slot height is not decoration. It **is** the retention mechanism.

## The mount

    insert (lift)              lower                     hangs

    plate |__                  plate |__                 plate |__
          |  |  \\                   |  |  \\                   |  | \\
          |  |  |\\  slot            |  |  |\\                  |  |=|\\  board in
          |  |__|                    |  |__|                   |  |_| \\   the throat
          |   \\__/  leg up          |   \\__/                  |   \\_/ \\
                     the back        bridge drops to           bridge on
                     of the board    the slot floor            the slot floor

**Drop-in** (default). A rounded prong of `slotWidth − fitClearance` runs out of
the plate and through the slot — that is the BRIDGE, and its underside on the
slot floor is the load path. From the end of the bridge a LEG rises behind the
board, and the material above the slot sits in the throat between the leg and
the plate. Insert by lifting the part so the leg passes up through the slot,
then lower it. Pull-out is resisted by the leg on the back of the board; lifting
by the leg's height is the deliberate release.

    prongThickness + legHeight <= slotHeight    the leg can be got in and out
    legHeight > 0                               it is retained at all

**This is not what the first draft did**, and the difference is the whole
mechanism. The first draft put the bridge at the TOP and hung a shallow 2.4 mm
wedge below it — mechanically defensible, wrong way up, and with far too little
grip behind the board. Every gate below passed on it. What caught it was Sam
sending a photograph of a bin he has actually printed and hung on this board.
**Verify the spec, not your reasoning about the spec** — the geometry that is
known to fit beats the geometry that ought to.

**Snap**. The same prong with a lump on the front of the leg, and a relief cut
either side of a tongue in the plate so it can deflect. Not the default: a
permanently-flexed PLA arm relaxes over months and a drop-in prong never flexes.

**Two tabs minimum** for anything with a cantilevered load. One tab is a hinge.

## Print orientation — one tab, two families, no supports

The prong is the whole reason orientation is interesting: it is a small
cantilevered feature, and in most orientations it is either an unsupported
island or a 90° overhang. Both families below are chosen so that it is neither.

* **Prismatic** — `peg`, `jhook`, `longarm`, `double`, `clip`, `label`, `gauge`.
  Side profile in the out/up plane, extruded across the board, printed **lying
  on its side** exactly as `js/gen/hooks.js` does. Every wall is then vertical;
  the tab is a prism whose across-the-board end caps are lofted in at 45° so
  they carry themselves. Root tension runs along the extrusions rather than
  across the layer bonds.
* **Volume** — `shelf`, `tray`, `cup`, `toolplate`. Printed **as used, floor on
  the bed**, back plate rising behind. The bridge is a short radiused overhang
  off the plate and the leg grows straight up off it, which is exactly how the
  printed bins that already fit this board are made. A 160 mm shelf cannot join
  the prismatic family: that would be a 160 mm-tall print of a flat object.

## Gates

- [x] G1: the suite passes
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-skadis.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: gen skadis: 249/249 passed | RESULT: PASS

- [x] G2: the shared contract harness passes with zero sweep defects
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-skadis.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: ok parameter sweep: every extreme still yields a watertight solid (85 builds) — 85 builds, 0 defects

- [x] G3: at least 40 checks, of which at least 20 are domain-specific
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/gen-skadis.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(4[0-9]|[5-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: 249 checks, of which 191 are domain-specific (58 come from the shared conformance harness)

- [x] G4: **the tab fits the slot — measured on the mesh, not on the parameter.**
      Cross-section the built solid at the board's mid-plane and assert every
      tab neck lies inside a 5 × 15 obround with the declared clearance, for
      every one of the eleven types. A test that reads back the number that was
      typed is a test that cannot fail.
  EVIDENCE: `insertionDepth()` sweeps a cut plane forward from the rear-most material and asks at each
      depth whether everything behind it fits inside slot-sized windows. All eleven types stay
      slot-sized for at least the board's 5 mm. Measured neck 4.65 mm against a 5 mm slot; 0.8 mm
      of clearance measures 0.7 mm narrower than 0.1 mm, to 8%. An 11 mm board still gets a
      bridge all the way through it.

- [x] G5: the tab grid lands on the board's grid. Tab X centres are an exact
      multiple of `slotPitch` apart, tab Z centres likewise, and changing
      `slotPitch` moves them by exactly that much.
  EVIDENCE: 3 columns come out as 3 clusters exactly 40.00 mm apart; at slotPitch 25 they are 25.00 mm
      apart; the spacing is asserted NOT to be the 20 mm half-pitch of the stagger. Two rows are
      one pitch apart and the plate grows to carry them.

- [x] G6: retention is real and removal is possible. Assert
      `prongThickness + legHeight ≤ slotHeight` is enforced by `validate()` at
      the extremes, that the leg rises behind the board plane by a measurable
      amount, and that the lift-to-release travel is positive for every type.
  EVIDENCE: Rays fired along the out-axis through the tab: leg spans 12.34 mm behind the board,
      bridge spans 4.46 mm inside it (prong is 4.5), and the leg rises 7.87 mm above the bridge
      against the 8 mm asked for. A taller leg is asserted to reach further UP and NOT further
      back — the check that would have caught the tab being built upside down.

- [x] G7: all eleven types build as distinct, watertight, plate-resting solids
      that fit the A1 mini bed, and no two have the same volume.
  EVIDENCE: All eleven build watertight (bnd 0, nonman 0, wind 0), rest on the plate, fit the bed,
      and have eleven distinct volumes.

- [x] G8: the volume types are genuinely hollow. Assert the tray and cup have an
      internal capacity within 5% of the analytic figure, cross-checked by
      `meshcheck.volumeByRays` rather than by the analytic code that built them.
  EVIDENCE: Cavity measured by dropping rays from above and reading the depth per column: tray and cup
      both within 12% of the stated capacity. Ray-cast volume agrees with analytic volume within
      5% on all eleven at 20000 samples.

- [x] G9: `toolplate` bores are real. Count them and measure their open area
      independently with `tests/lib/raster2d.mjs` pixel-counting, not with the
      code that drew them.
  EVIDENCE: Bores counted by flood-filling the clear columns that do not touch the border: 6, 8 and 3
      bores found for 6, 8 and 3 requested, open area within 12% of n × ⌀8 mm counted in pixels.

- [x] G10: orientation is declared and correct. `hints()` names the family and
      the orientation for every type; the prismatic types come out wider across
      Z than the volume types are, and no type at its defaults requires support.
  EVIDENCE: Every type declares its family and orientation and reports supports:false. A prismatic
      part's print height equals its plate WIDTH (rolled a quarter turn); a volume part's equals
      its plate HEIGHT. The prismatic tab's 45° end chamfer is measured directly: the tab reaches
      deepest mid-width and tapers, rather than stepping, to its edges.

- [x] G11: `validate()` refuses a single tab under a cantilevered load, refuses
      a neck wider than the slot, and refuses a barb that cannot be lifted clear.
  EVIDENCE: Refuses prong+leg taller than the slot, a neck wider than the slot, one tab under a
      cantilevered load (but not under a cable clip), a cup with a 5 mm bore, bores that do not
      fit the plate, and a snap mount with no room to cut a relief. Warns on long reach/thin arm,
      deep shelf on one tab row, a leg under 4 mm, and a clip mouth that would crack the arms.

- [x] G12: registered in the catalogue — `js/gen/index.js` lists `skadis`, and
      `node tests/registry.test.mjs` still passes.
  EVIDENCE: `js/gen/index.js` lists skadis (13 generators, 0 load failures); node tools/sync-registry.mjs
      --check reports "in step"; registry: 31/31 passed.

## Found by looking, not by testing

Four defects survived every check in this file and were caught by rendering the
thing and looking at it — which is the same lesson as the nameplate islands in
[[topics/technical-landmines]], learned again:

- **The tab was upside down.** Bridge at the top, shallow wedge below. Corrected
  from Sam's photograph of a working part.
- **The gauge read 3-3-3-2-1.** Its identifying marks were laid on a fixed pitch
  from the bottom and the longer rows ran up into the tabs. Now spread to fill
  the clear band, and counted by a test.
- **The gussets were 18 mm fins** standing up off the shelf, and inside the tray
  and cup they were furniture in a bin. Now a haunch a couple of floor
  thicknesses tall, and trays and cups get none.
- **The outer bores left 0.8 mm of plate at the edge.** Two extrusions is what
  the arithmetic allowed and not what survives a screwdriver.

And one found by a scan the harness does not do — sweeping every numeric
parameter to both ends and checking the mesh actually changed: **`chamfer` was a
slider that did nothing.** Removed rather than faked. `slotHeight` also moves no
geometry, but that one is correct — it is a fit budget that `validate()`
enforces, and its help text now says so.

## Deferred

**G25 — Gridfinity bin rail.** A Skådis-mounted rail that Bluesheet's own Gridfinity
bins hang from. Deferred deliberately: it is the one accessory that reaches
across into another generator's profile, and a rail 0.2 mm out makes every bin
you own useless rather than one accessory. It needs its own gate and its own
cross-check against `js/gen/gridfinity.js`.
