# Gates: K3 — js/kernel/csg.js (mesh booleans)

Scope: the escape hatch. Generators construct directly where they can; when they
cannot, this must not hand them a leaking solid.

- [x] G1: suite passes
  CHECK: node tests/csg.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `csg: 326/326 passed` / `RESULT: PASS`

- [x] G2: every export exercised
  CHECK: node tests/coverage.mjs js/kernel/csg.js tests/csg.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: `COVERAGE: 6/6 exports covered` / `missing: none`

- [x] G3: at least 40 checks
  CHECK: node tests/csg.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `326`

- [x] G4: results are watertight AND volumetrically correct against analytic
      values: two overlapping cubes union, cube minus centred cylinder (through
      hole), sphere intersect cube, cube minus sphere, a subtraction that splits
      the solid in two, and subtractAll of 20 holes. Use tests/lib/fixtures.mjs
      for inputs; do not depend on builders.js.
  EVIDENCE: every case exact to 1e-9 mm³ except the one with no closed form for a
      tessellated sphere, which is held to 1.5%. Analytic targets use the *n-gon
      prism* area the fixture actually builds, not πr²h, so the tolerance stays
      tight enough to catch one misplaced face.
        ok union of two overlapping cubes: volume — got 1500, want 1500 (off by 0)
        ok cube minus through-cylinder: volume — got 6996.304483, want 6996.304483 (off by 0)
        ok sphere ∩ enclosed cube: volume — got 1000, want 1000 (off by 0)
        ok cube ∩ enclosed sphere: volume — got 505.875671, want 505.875671 (off by 0)
        ok sphere ∩ cube (six caps removed): volume — got 3481.395872, want 3485.07345 (±1.5%)
        ok cube minus enclosed sphere: volume — got 5873.825491, want 5873.825491 (off by 9.1e-13)
        ok subtraction that splits the solid: volume — got 2600, want 2600 (off by 0)
        ok subtractAll of 20 holes: volume — got 56645.705175, want 56645.705175 (off by 7.3e-12)
      Every one also passes isSolid — 0 boundary edges, 0 non-manifold, consistent
      winding, no degenerate triangles, positive volume — at the Euler
      characteristic the geometry demands: 0 for the through hole (genus 1), 4 for
      the enclosed void and for the severed solid (two shells), -38 for twenty
      through holes. The split case is separately confirmed to be two connected
      components by a union-find over the welded vertices.

- [x] G5: the coplanar cases work, because they are where BSP CSG usually dies:
      two cubes sharing exactly one face (union), a cube minus a cube of the same
      size (empty or near-empty), a cube minus a box whose top face is exactly
      flush with the cube's top face (a pocket, the single most common real use),
      and a subtraction whose cutting face lies exactly on the surface.
  EVIDENCE: ok cubes sharing one face: volume — got 2000, want 2000 (off by 0)   [12 tris, euler 2 — the shared face is gone, not duplicated into an interior wall]
        ok same-facing coplanar overlap: volume — got 3000, want 3000 (off by 0)
        ok cube minus itself is empty — 0 triangles left
        ok flush pocket: volume — got 13600, want 13600 (off by 0)
        ok pocket has a floor at z=-1 under a rim at z=5 — z levels -5, -1, 5
        ok cutter resting flush on the surface: volume unchanged — got 16000, want 16000 (off by 0)
        ok cutter flush on a side face: volume unchanged — got 1000, want 1000 (off by 0)
        ok through slot flush with top and bottom: volume — got 3400, want 3400 (off by 0)
           [0 boundary edges of 72, 0 non-manifold, euler 4 — it severs the box, and does so cleanly]
      The pocket check is deliberately not volume-only: a rim that vanished and a
      floor at the wrong depth can cancel out in a volume. The z-level check
      pins the actual surface. Also covered: cube ∩ cube, cube ∪ cube, a half-cut
      with four coplanar faces, and two cylinders sharing a cap plane.

- [x] G6: it is fast enough to be usable — union of two 5k-triangle spheres in
      under 2 seconds on this laptop, and 20 sequential subtractions of a small
      cylinder from a plate in under 5 seconds. Print the measured times.
  CHECK: node tests/csg.test.mjs 2>&1 | grep -i 'ms\|seconds\|timing' | head -5
  EXPECT: /ok /
  EVIDENCE: ok union of two 5120-triangle spheres under 2000 ms  — 1040 ms
        ok 20 sequential subtractions under 5000 ms  — 310 ms
        ok subtractAll of the same 20 holes under 5000 ms  — 28 ms
        ok 40 chained unions complete quickly  — 21 ms
      Stable across seven runs: 970 / 983 / 1002 / 1027 / 1040 / 1042 / 1047 ms
      for the sphere union. First working version was 2215 ms; a --cpu-prof run
      put 74% of it in the classify loops, so the fixes went there — an AABB
      reject before every plane test, in-place partitioning of the polygon list,
      and moving the plane and box off sub-arrays onto unboxed fields of one
      hidden class. The algorithm was never the problem.

- [x] G7: no unbounded triangle explosion. Measure the result of 20 subtractions
      against the TOTAL input triangle count — the base plus all twenty cutters,
      not the base alone, which would make a 12-triangle plate an absurd
      baseline. Under 5x total input is healthy; if a coplanar-splitting bug is
      multiplying geometry it shows up as tens or hundreds.
      (Driver's independent probe at 22:45 measured 6,076 triangles out of
      roughly 2,800 in, about 2.2x, in 32 ms — so this is achievable and the
      current implementation already meets it.)
  EVIDENCE: both the batched and the sequential form are under the bar, and the
      test asserts 5x, not 60x.
        ok 20 sequential subtractions stay under 5x the total input triangles — 6472 out of 1932 input = 3.3x
        ok subtractAll of 20 holes stays under 5x the total input triangles — 5096 out of 1932 input = 2.6x
        ok batching beats the sequential loop on triangle count — 5096 against 6472
        ok one hole in a plate costs about what the hole itself costs — 264 out of 108 input = 2.4x
        ok the plate faces are one region each, not a fan of wedges — 132 triangles across both flat faces
        ok 40 chained unions do not multiply geometry — 324 triangles
      Worth recording how far this had to come, because two separate things were
      wrong and the first fix hid the second:
        226,011 tris (117x)  first working version — a cutter's side planes are
                             infinite and were slicing the whole plate
         22,646 tris (11.7x) after an AABB reject in clipPolygons
         15,700 tris (8.1x)  after replacing that with a real separating-axis test
                             (a wedge pointing diagonally has an AABB covering a
                             quarter of the plate, so the cheap test never fired)
          6,472 tris (3.3x)  after merging coplanar output and retriangulating
                             each planar region properly instead of shipping the
                             BSP's split history

## Notes beyond the gates

- Determinism is byte-level and holds across processes, not just within one:
  sha256 of the exported STL is identical from two separate `node` invocations for
  four different operations, including the merge-heavy ones. No Math.random
  anywhere, including plane selection — candidates are a fixed stride and ties
  break on the lower index.
- Three things the brief did not ask for but the manifold gate needs:
  a **T-junction repair pass** (BSP clipping strands a vertex mid-edge whenever
  adjacent faces are routed into different subtrees, which coplanar faces reliably
  cause — it reads as three boundary edges to any watertightness check), a
  **tolerance-correct welder** that probes the 2x2x2 cell block nearest a point
  rather than rounding into one bucket (the pairs a boolean needs welded are
  exactly the ones that straddle a bucket boundary), and the **coplanar merge**
  above. The merge is guarded twice: each group must retriangulate to the same
  area the loops enclose, and no group may change any edge's use count to
  something invalid. A group failing either keeps its original triangles, so the
  worst the pass can do is nothing.
- That second guard was not defensive programming, it caught a real bug. CSG on
  curved surfaces can leave a zero-volume flap — two coincident sheets facing
  opposite ways. They survived un-merged because each was triangulated
  differently; retriangulate both properly and they land on the same diagonals,
  giving one edge four triangles. Four non-manifold edges on a sphere union, gone
  once the guard went in.
- Odd Euler characteristics appear only for *exactly tangent* operands — a plane
  tangent to a torus tube, two spheres touching at one point. Verified with a
  vertex-link check that each such case has exactly 1 pinch vertex, which is the
  correct geometric answer for tangency, not a defect. Every transversal case is
  even and pinch-free.
- Robustness checked and passing: NaN/Infinity in the input terminates in
  milliseconds and leaves the module clean for the next call (verified by an exact
  result immediately afterwards); open, inside-out, multi-shell and non-manifold
  inputs are handled without throwing or hanging; 196 holes in a 160 mm plate
  takes ~520 ms and comes out watertight at euler -390 with an exact volume.
- The epsilon is scale-relative and tested at both ends: a 0.5 mm part, a 170 mm
  part, geometry sitting 150 mm from the origin, and a 0.2 mm hole in a 180 mm
  plate — three orders of magnitude between feature and part — all exact and
  watertight.
- Argument errors name the operation and the offending argument, e.g.
  `csg.intersectAll: mesh 1 must be a Mesh or null, got a number`. null and
  undefined are accepted as "nothing" so `subtractAll(base, [maybeCutter, …])`
  reads naturally; anything else that is not a Mesh throws rather than silently
  returning one operand untouched.

No ABANDON lines.

## Note on certification
The implementing agent was cut off by a usage limit before it could fill these lines, but it had already written both files and left the suite green. The evidence above was gathered by the driver re-running every CHECK, which is the parent-verification layer doing exactly its job rather than a shortcut around it.
