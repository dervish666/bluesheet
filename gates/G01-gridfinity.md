# Gates: G01 — js/gen/gridfinity.js (Gridfinity bins and baseplates)

Scope: The most-printed object in the hobby, done properly. Bins that actually
stack with everyone else's, and baseplates that actually hold them.

- [x] G1: the suite passes
  CHECK: node tests/gen-gridfinity.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `gen-gridfinity: 266/266 passed` / `RESULT: PASS`

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-gridfinity.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: `ok   parameter sweep: every extreme still yields a watertight solid (54 builds)  — 54 builds, 0 defects` (conformance contributes 70 of the 266 checks; all 70 green)

- [x] G3: at least 45 checks in the suite, of which at least 20 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-gridfinity.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(4[5-9]|[5-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `266`. Conformance alone prints 70, so **196 are domain-specific** (`266 − 70`, both counted with the same grep).

- [x] G4: the Gridfinity specification is honoured to the tenth of a millimetre,
      and the test asserts the real numbers, measured off the built mesh.
      **Verify the specification yourself before you trust this list** — I got the
      corner radii wrong on the first pass and corrected them, so treat these as a
      strong starting point rather than as gospel, and report any number you find
      to be different (with your source) rather than quietly coding to it.
  EVIDENCE: Every number in the brief was independently verified against
    `kennetek/gridfinity-rebuilt-openscad` `src/core/standard.scad` and
    `src/core/gridfinity-baseplate.scad` (the reference implementation, itself
    annotated "Based on https://gridfinity.xyz/specification/"), then asserted
    against cross-sections cut out of the finished triangles by the test file's
    own `section()` — never against a constant the generator also owns.
    Measured, at 0.001 mm off each breakpoint so the sampling itself is checked:
      base 35.602 / 37.198 / 37.200 / 41.498 mm, radii 0.801 / 1.599 / 1.600 / 3.749
        (`base profile at bottom face: width — got 35.602, want 35.602, off by 0`;
         `top of the base: corner radius — got 3.749, want 3.749, off by 1.3e-15`)
      45° stages proved by mid-stage samples: 36.400 at z 0.4, 37.200 at z 1.7, 39.350 at z 3.675
      each chamfer takes exactly its own height off the radius: 0.8 and 2.15, off by 2e-3 and 3e-3
      lip inner 36.302 (r 1.151) → 37.700 (r 1.850) → 37.700 → 41.498; lip height 4.4 exactly
      socket 41.998 (r 3.999) / 37.700 (r 1.850) / 37.700 / 36.302 (r 1.151), 4.65 deep
      pitch 42.000 (measured as the difference between a 1-wide and a 2-wide bin)
      height unit 7.000 (measured as the difference between a 3u and a 4u bin)
      magnets 5.966 mm across a 24-gon (6.0 nominal, 0.6% polygon deficit) × 2.0 deep, at ±13.000 → 26.0 spacing
      wall 1.200 and floor measured off the mesh; M3 screw 3.0
    NOTHING contradicted the brief. Three things the brief did not say, found in
    the reference and now built and asserted:
      * the 42 mm cell contains **separate feet 0.5 mm apart** — a 2×1 bin stands
        on two 41.5 mm feet, not one 83.5 mm one, or it will not sit in a
        baseplate's ridges (`the gap between adjacent feet is the specified 0.5 mm`).
      * `LIP_H` is not independent: 4.65 socket − 0.25 clearance = 4.40, asserted.
      * the cavity floor cannot sit at 4.75 on a multi-unit bin — the foot gaps
        would be slots straight through the bottom. It is 4.75 + the floor
        parameter here; the reference dodges the same problem by making the whole
        first 7 mm unit solid. Either is interoperable; the fit is decided
        entirely by the outside of the base.

- [x] G5: a bin and a baseplate actually fit each other — computed, not assumed.
  EVIDENCE: `bin into baseplate: clearance is 0.1–0.5 mm at all 23 depths sampled
    — measured 0.2500 … 0.2500 mm per side`, and the corner radii separately:
    `the corner radii keep the same clearance — measured 0.2500 … 0.2500 mm`.
    Uniform 0.25 mm, which is the specification exactly.
    The other mating surface too — a bin stacked on a bin:
    `bin into stacking lip: clearance is 0.1–0.5 mm at all 22 heights sampled
    — measured 0.2500 … 0.3500 mm per side` (0.25 on the vertical stage that does
    the gripping, 0.35 on the two 45° stages, as the profiles require).
    Multi-unit alignment as well: `a 3×2 bin has one foot per socket of a 3×2
    baseplate — 6 feet, 6 sockets` and `every foot is centred on its socket —
    0.0e+0` × 6.

- [x] G6: the options are real, each verified by measurement.
  EVIDENCE:
    multi-unit: pitch 42.000 measured; `three units across measure 3 × 42 − 0.5`;
      `a non-square bin is not square — 125.5 × 83.5 mm`; 1×1 … 5×5 all built and
      watertight (5×5 is 209.5 mm and validate() calls it out, see G8).
    height both ways: `height given in mm gives the same bin as the equivalent
      units — got 32.4, want 32.4`; `a height between units is rounded up`;
      `unless snapping is turned off`.
    stacking lip on/off: `the stacking lip adds exactly 4.4 mm`; with it off,
      `there is no rim above the body`.
    magnets: `four in a 1×1 bin, one per corner`; `6.0 mm across` (5.966 on a
      24-gon); `±13 mm from the unit centre` → `26 mm spacing in X` and `in Y`;
      `2.0 mm deep — open at 1.9, closed at 2.1`; `every unit of a multi-unit bin
      gets its own four holes — 16 holes on a 2×2`.
    screws: M3 measured at 3.0 mm, `the magnet pocket is a shoulder above the
      screw hole`, and `screw holes stay blind — nothing opens into the cavity`.
    label tab: `eats into the back of the cavity at the top — 11.60 mm of tab`,
      `leaves the front alone`, `has cleared out again lower down`, and the
      fouling gate: `the label tab does not intrude into the stacking socket
      above it — socket area -1418.283 with tab vs -1418.283 without`, plus
      `nothing of the tab reaches above the bin body at all — sampled at 5
      heights through the lip`. Front and both-ends variants asserted too.
    scoop: `pulls the cavity back from the front wall at the floor — front edge
      -11.94 mm at the floor vs -19.55 mm above the scoop`; `reaches the wall
      exactly one radius up`; `leaves the back of the bin alone`.
    dividers both axes: `3 × 2 dividers give six compartments — 6 voids`, laid
      out `3 × 2`, evenly spaced, `the dividers are one wall thickness thick —
      got 1.2, want 1.2`; single-axis variants asserted separately.
    wall thickness: measured at mid-height for 0.8 / 1.2 / 2.5 mm, each `off by
      6.7e-16`.
    baseplates: `a light baseplate is open right through every socket — 4 holes
      near the bed`; `a solid baseplate has a floor under them — 0 holes at the
      bed, 4 sockets above the floor`; `the solid plate is the heavier of the two
      — 22625 vs 5724 mm³`; `a solid plate still presents the same socket to a
      bin — 37.7000 mm`; magnets in the plate floor at the same ±13 positions.
    vanishing interior: `validate() catches walls thicker than half the bin` →
      `error` on `wall`, and `builds it anyway rather than throwing, clamped`.

- [x] G7: it produces something a person would actually want. At least 4 presets,
      each a recognisably different and *useful* object, each named for what it is
      for rather than for its parameters.
  EVIDENCE: **8 presets**, all watertight, all on the plate, all inside the bed,
    and every one lands on the 42 mm grid:
      Bolt tin 1×1×6 (41.5×41.5×46.4, magnets + label)
      Long tool bay 3×1×4 (125.5×41.5×32.4, scoop + label)
      Screwdriver bay with scoop (167.5×41.5×18.4, a 12 mm sweep-out)
      2×2 baseplate (84×84×5, light)
      Six-way parts sorter 2×2×3 (83.5×83.5×25.4, 3×2 dividers)
      Magnet-mount SMD bin 1×2×3 (41.5×83.5×25.4, magnets + screws + 3 rows)
      Weighted 3×2 baseplate (126×84×7.4, solid floor + magnets)
      Lidless tray 2×3×2, no lip (83.5×125.5×14, deep scoop)
    `the presets are genuinely different objects — 8 distinct shapes from 8
    presets`; `every preset is named for what it is for, not for its parameters`;
    `the presets include a baseplate and a divided bin, not just plain boxes`.

- [x] G8: printability is thought about, not assumed.
  EVIDENCE: hints() returns `{profile: "0.20 mm Standard", filament: "PLA for the
    desk, PETG for the workshop", supports: false, notes: [...]}` with 5–10 notes
    depending on the object, and the test asserts the content, not just the shape:
    `hints() mentions elephant's foot — the commonest reason a bin will not seat`,
    `hints() states the wall count that produces the wall thickness`,
    `hints() for a baseplate is different advice, not the same advice`,
    `hints() warns about the foot-gap bridges only when there are any`.
    The geometry backs the "no supports" claim rather than asserting it:
    `the default bin has no overhang worse than 45° — 45.00° from vertical`,
    `nor does any single-unit variant of its shape` (8 variants, all 45.0°),
    `a baseplate has no overhang at all — 0.00°`. The two deliberate exceptions
    are pinned down rather than waved through:
    `the only thing above 45° in a magnetised bin is the roof of a pocket — 280
    faces, all at z = 2.000/6.000`, and
    `the only flat overhang on a multi-unit bin is the specified foot gap — 34
    faces, all at z = 4.750` / `a 0.5 mm span, not a slab: 33.1 mm² on a 17586
    mm² part`.
    Unprintable parameter sets are caught by validate() rather than silently
    built: `209.5 × 209.5 mm will not fit the 180 × 180 mm bed. 4 units across is
    the most this printer can do in one piece.`; a bin taller than the build
    volume; `a 25.0 mm wall leaves no interior in a 41.5 × 41.5 mm bin`;
    a baseplate floor under three layers; magnets asked for on a light plate;
    a single-extrusion wall; a 12 mm screw in a 1-unit bin. And
    `validate() says nothing alarming about a sensible bin — []`.

## Notes

Beyond the gates, measured on this machine:

- **546-build stress sweep, 0 defects.** Every dimension 1×1…5×5, three quality
  levels, height 1–18 units, walls 0.2–25 mm, floors 0.2–40 mm, all 25 divider
  combinations crossed with three scoops, all label modes × depths × angles ×
  heights, 81 magnet/screw combinations, mm-mode boundaries, all baseplate
  styles, and nonsense input (NaN, Infinity, negative, unknown enum strings).
  Slowest single build 66 ms (5×5 solid baseplate at fine quality).
- **Built by sweeping, not by CSG**, as the brief asked: the default bin is 788
  triangles. There is exactly one `P.boolean` call in the file — the 0.5 mm
  foot-gap face on a multi-unit bin — and its output is snapped back onto the
  exact input vertices, so the seam closes by construction rather than by a
  lucky weld. Every other face is a quad strip or a plain earcut.
- **The baseplate top face is built analytically**, because poly2d's boolean is
  not safe on the exactly-tangent geometry a 42 mm socket in a 42 mm cell
  produces: measured, `difference` returns a 2×2 plate's top face as 2506 mm²
  when it is 42 (measured off the finished plate: 42.171 mm² of top face). Not a kernel bug worth filing — exact tangency everywhere is a
  degenerate input — but worth recording, and worth not building on.
- Three defects found by measurement after the code "worked": the multi-unit
  floor slot (G4 note above), 42 self-intersections where the cavity floor met
  the feet at the same plane, and a 63.4° overhang where the rim chamfer and the
  label tab both pulled the same edge in and the two setbacks were being added
  instead of maxed. All three passed a watertightness check before they were
  found.
