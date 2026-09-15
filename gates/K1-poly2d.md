# Gates: K1 — js/kernel/poly2d.js (2D rings, booleans, offset, triangulation)

Scope: the complete 2D layer of the Bluesheet kernel. Everything a generator needs to
describe a cross-section before it becomes a solid.

- [x] G1: the whole suite passes
  CHECK: node tests/poly2d.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `poly2d: 211/211 passed` / `RESULT: PASS`

- [x] G2: every export is exercised by the test file
  CHECK: node tests/coverage.mjs js/kernel/poly2d.js tests/poly2d.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: `COVERAGE: 36/36 exports covered` / `missing: none`

- [x] G3: at least 60 individual checks — this module is the foundation, thin
      coverage here poisons every generator
  CHECK: node tests/poly2d.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([6-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `211`

- [x] G4: triangulation is exact — for 8 different shapes including holes and
      concavity, the summed triangle area equals the shape area to 1e-9, and no
      triangle lies outside the shape
  EVIDENCE: 10 shapes (square, concave L, 5-point star, one hole, two holes,
  hole touching the outer ring at a point, collinear runs, CW outer ring, disc
  with an off-centre hole, 2000-vertex superformula). All 10 "area is exact"
  checks pass at ±1e-9; worst deviation across the ten is `off by 2.0464e-12`.
  All 10 "no triangle outside" checks report `0 of N outside` — e.g.
  `ok triangulate 2000-vertex superformula: no triangle outside the shape — 0 of 1998 outside`
  and `ok triangulate hole touching the outer ring at a point: area is exact — got 80, want 80 (±1e-9, off by 0)`.
  Every triangle is also asserted CCW: `0 flipped, 0 bad indices` on all ten.

- [x] G5: booleans verified against analytic areas — overlapping circles,
      rectangle minus rectangle producing two islands, a difference that creates
      a hole, an intersection that is empty, and self-touching input
  EVIDENCE: `ok overlapping circles: intersection is the analytic lens — got 122.834312, want 122.83697 (±0.05%, off by 0.002658)`
  `ok rectangle minus a bar gives two islands — 2 islands` (`...with the right total area — got 240, want 240 (±1e-9, off by 0)`)
  `ok difference that creates a hole: one island, two rings` (area `got 364, want 364 (±1e-9, off by 0)`, hole wound CW)
  `ok intersection of disjoint shapes is empty`
  `ok self-touching (pinched) input keeps its area through a union — got 76, want 76 (±1e-9, off by 0)`
  Also: `ok xor of two crossing rectangles has the right area — got 128, want 128 (±1e-9, off by 0)`
  and `ok ...and comes out as four separate arms — 4 islands` (the degree-4 pinch
  point that a naive contour tracer halves).

- [x] G6: offset verified — a circle offset by d has area pi*(r+d)^2 within 0.5%,
      a rectangle offset outward gains the right perimeter band, an inward offset
      that would collapse the shape returns [] rather than an inverted ring
  EVIDENCE: `ok circle offset +2 has area π(r+d)² — got 452.380353, want 452.389342 (±0.5%, off by 0.008989)` (+0.5, +2, +5 and −1, −3, −7 all pass)
  `ok rectangle +2 with round joins gains perimeter·d + πd² — got 332.562384, want 332.566371 (±0.05%, off by 0.003987)`
  `ok rectangle +2 with miter joins gains the full corner squares — got 336, want 336`
  `ok inward offset that annihilates the shape returns []`, `ok inward offset of a circle past its radius returns []`,
  `ok an over-shrunk circle does not come back as a phantom disc`
  `ok offset never returns an inverted outer ring` (33 deltas from −6 to +6 over a U shape, every outer CCW and every hole CW)
  `ok an offset just short of annihilation still returns a sliver — area 4.000e-6`

- [x] G7: fuzz — 500 pseudorandom polygons (seeded, deterministic) through
      triangulate/offset/boolean with no throw, no NaN, and no ring that
      self-reports a negative area where positive is required
  CHECK: node tests/poly2d.test.mjs 2>&1 | grep -i fuzz | head -3
  EXPECT: /ok /
  EVIDENCE: `ok fuzz oracle rejects a NaN coordinate` / `ok fuzz oracle rejects an inverted outer ring` / `ok fuzz oracle rejects a counter-clockwise hole`
  and the run itself: `ok fuzz: 500 seeded polygons complete without throwing — seed 20260821, 4000 operations, 0 threw, 211 ms`,
  `ok fuzz: no NaN or infinite coordinate in any result — 0 non-finite results`,
  `ok fuzz: every returned ring is wound correctly (outer CCW, holes CW) — 0 misoriented, 3 legitimately empty offsets`,
  `ok fuzz: triangulated area matches the shape area for the simple families — 0 mismatches, worst 2.27e-13 mm²`.
  Seed is **20260821** (LCG 1664525/1013904223), asserted reproducible against a
  second generation from the same seed and distinct from seed+1.

## Notes

- The sweep snaps its input to a power-of-two grid at ~1e-9 relative to the
  largest coordinate, so areas that come back through `boolean`/`offset` carry
  perimeter × half-a-grid of slack (~4e-7 mm² on a 60 mm perimeter). Area
  assertions on those paths are made at 1e-6, not 1e-9. `triangulate` does not
  snap and is exact.
- `offset` uses erosion/dilation semantics (Minkowski with a disc), so an inset
  is trimmed where the remaining feature is thinner than 2·delta, not merely
  where the half-planes cross. That is what makes an over-shrunk shape return []
  instead of a phantom.
- Performance, measured on this laptop (i7-1165G7): triangulate a 200-gon
  0.25 ms, a 200-gon with three holes 0.55 ms, a 2000-vertex ring 10 ms; offset
  a 200-gon 2.1 ms; boolean two 200-gons 0.75 ms. Worst case is an offset within
  0.1% of annihilating the shape, where the raw ring self-intersects O(n²) times
  before the fill discards it: 145 ms at 200 segments, 2.1 s at 512. `offset`
  early-outs on the bounding-box annihilation test before reaching that, so the
  ordinary "user drags the inset slider past collapse" path is instant — the
  slow window is only the sliver between the true inradius and half the bbox.
  Whole suite: 489 ms.
- Nothing was ABANDONed.
