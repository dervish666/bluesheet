# Gates: K4 — js/kernel/validate.js (mesh analysis + printability)

Scope: the module that decides whether a generated solid is printable, and says
why not in words a person can act on.

- [x] G1: suite passes
  CHECK: node tests/validate.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: validate: 240/240 passed / RESULT: PASS

- [x] G2: every export exercised
  CHECK: node tests/coverage.mjs js/kernel/validate.js tests/validate.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: COVERAGE: 18/18 exports covered / missing: none

- [x] G3: at least 40 checks
  CHECK: node tests/validate.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: 240

- [x] G4: it detects real defects, proven by constructing them: a cube with one
      triangle deleted (boundary edges), a cube with one triangle reversed
      (winding), two cubes sharing a face (non-manifold edge), an inside-out cube
      (negative volume), two disjoint cubes (2 shells), a torus (Euler 0)
  EVIDENCE: all six built in tests/validate.test.mjs section 2 and caught —
    ok  open cube: 3 boundary edges  — 3            (holes 1, rim 34.1 mm, BOUNDARY_EDGES error)
    ok  reversed triangle: exactly 1 flipped triangle, not 3 edges worth  — 1   (FLIPPED_TRIS error)
    ok  two cubes fused on a face: 4 non-manifold edges  — 4                    (NON_MANIFOLD_EDGE error)
    ok  inside-out cube: negative volume  — -1000.0 mm³                         (INVERTED error, solid=false)
    ok  two disjoint cubes: 2 shells  — 2
    ok  torus is genus 1 (Euler 0)  — euler 0, genus 1
    plus bowtie vertex (1), degenerate triangle (1), out-of-range index, NaN
    coordinate, zero-volume closed sheet, and 2 interpenetrating cubes (48 pairs).

- [x] G5: it does NOT false-positive on good geometry — a sphere, a torus, a
      revolved profile, a 4000-triangle heightfield and a CSG result all come
      back manifold with zero warnings above 'info'
  EVIDENCE: (CSG sample: csg.subtract(); heightfield 4352 triangles)
    ok  icosphere: nothing above 'info' to say about it  — info:OK
    ok  torus: nothing above 'info' to say about it  — info:GENUS
    ok  vase: nothing above 'info' to say about it  — info:OK        (revolved profile)
    ok  heightfield: nothing above 'info' to say about it  — info:OK
    ok  csg: nothing above 'info' to say about it  — info:GENUS
    each also: manifold=true boundary=0 nonManifold=0 flipped=0 bowties=0, and 0
    self-intersections with selfIntersect:true.

- [x] G6: printability is numerically right — a 200mm cube reports fitsBed false,
      a 45-degree cone reports its worst overhang within 1 degree of 45, a plate
      thinner than minFeature is flagged, grams estimate for a 10mm PLA cube is
      1.24 g +/- 5%
  EVIDENCE: 200mm: fitsBed=false ("20.0 mm too wide, 20.0 mm too deep, 20.0 mm
    too tall … Scale to 90 %")
    ok  a 45° cone reports its worst overhang as 45°  — got 44.99137, want 45 (±1, off by 0.00863)
    0.6mm plate: thinWallArea=800 minThickness=0.6 -> warn THIN_SLAB
    10mm PLA cube: estGrams=1.24  (ok  10 mm PLA cube weighs 1.24 g — got 1.24, want 1.24 (±5%, off by 0))

- [x] G7: it agrees with the independent topology checker in tests/lib/meshcheck.mjs
      on 10 different meshes (two implementations written separately must not
      disagree; if they do, one is wrong and this gate is the alarm)
  EVIDENCE: CROSSCHECK: 16/16 meshes agree with tests/lib/meshcheck.mjs
    (cube, tetra, icosphere, torus, cylinder, heightfield, vase, arch, holedBox,
    bowtie, openCube, flippedFace, insideOut, twoShells, fusedCubes, degenerate —
    comparing boundary / non-manifold / inconsistent edges, Euler, welded V, F, E;
    all seven numbers equal on every mesh.)

## Defect found and fixed after certification (driver, 02:20)

While building a nameplate by hand — the first time text.js, poly2d and mesh had
been used together — `printability()` reported the letters as "starting in
mid-air". They were sitting flush on the plate.

Reproduced in three lines: a cube stacked exactly flush on another, a cube
overlapping the one below by 0.5 mm, and a cube genuinely floating 3 mm above
all reported **1 unsupported island**. The check cast a ray downward from just
under each downward-facing face; support that is *level* with the face sits at or
above that ray's origin and was invisible to it. Every object assembled from
parts — letters on a plate, a lid on a box, dividers in a bin — was affected,
which is how a validator teaches people to ignore it.

Fixed by asking a second question when the downward ray misses: is the point
immediately below the face inside the solid at all? Two new exports,
`rayMeshCount` and `pointInsideMesh`, plus `tests/islands.test.mjs` (25 checks).

Getting the crossing counter right took two attempts and both wrong versions are
worth recording. Counting *triangles* double-counts a ray that runs along the
diagonal where two triangles of one flat face meet, and inverts the parity.
Merging every hit at the same distance then broke the case the fix existed for,
because two solids resting flush have two coincident faces and that is genuinely
two crossings. The sign of the ray-normal dot separates them: hits merge only
when they agree on which way the surface is turned.

- [x] G8: the mid-air check does not fire on parts resting on other parts
  CHECK: node tests/islands.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: islands: 25/25 passed / RESULT: PASS — flush-stacked 0 islands,
    overlapping 0, genuinely floating 3 mm 1, three parts stacked flush 0, a part
    flush on one that is itself floating 1.

- [x] G9: a face resting flush on another part is contact, not overhang
  CHECK: node tests/islands.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(29|[3-9][0-9])$/
  EVIDENCE: 29. Before the fix a BLUESHEET nameplate reported "167.4 mm² of surface
    (4.5 % of the model) leans past 50°, the worst at 90.0°" and advised adding
    supports under letters that were already touching their own plate. After:
    overhang 0 mm², contact 72 mm², and a sphere still reports its real 310 mm²
    at 80° while a T-shape still reports its overhanging arms at 90°.
