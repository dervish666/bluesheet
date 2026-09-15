# Gates: A1 — the inspector (js/ui/inspect.js, server/inspect.py)

Scope: drop any STL onto Bluesheet and it tells you the truth about it — watertight
or not, where the overhangs are, whether it fits the bed, what it will weigh,
and what it will cost. The kernel already knows how; this is the front door.

- [x] G1: dropping a file works, including a 30 MB STL, and the analysis appears
      without freezing the page (parsing happens off the main thread or chunked)
  CHECK: node tests/inspect.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE (2026-09-03): `node tests/inspect.test.mjs` 55/55, RESULT: PASS. A 30.8 MB
    heightfield STL parsed in `inspect-worker.js` in 2.3 s with 134 rAF frames
    ticking on the main thread during the parse.

- [x] G2: at least 25 checks
  CHECK: node tests/inspect.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE (2026-09-03): 55 `  ok ` lines.

- [x] G3: the report is honest and specific on deliberately broken input. Build
      fixtures for: a mesh with holes, an inside-out mesh, one with a stray
      floating shell, one 300 mm across, one with 0.3 mm walls, and one with a
      70-degree overhang. Each must be named correctly with the actual numbers
      (how many holes, how big the shell, which walls) rather than a generic
      "problems detected".
  EVIDENCE (2026-09-03): fixtures in `tests/fixtures/inspect/` (built by
    `tests/lib/inspect-fixtures.mjs`): holes (open edges and boundary loops
    counted), inside-out (negative volume, all faces reversed), stray shell
    (2 shells, the small one's triangle count), 300 mm (does not fit, by how
    much), 0.3 mm walls (finding under 0.8 mm), 70° wedge (worst angle ≈ 70°).
    Each report carries the number; the suite asserts the numbers.

- [x] G4: it can repair what is repairable and says what it did — weld,
      drop degenerate triangles, remove tiny disconnected shells, flip an
      inside-out solid — then re-analyses and reports the before and after
      counts. Anything it cannot fix is stated plainly as unfixable.
  EVIDENCE (2026-09-03): Repair = weld → dropDegenerate → drop small shells →
    flip a whole inside-out solid → healTJunctions, re-analysed, before/after
    counts shown; remaining open edges and individually reversed triangles are
    reported as unfixable rather than re-wound.

- [x] G5: a Bluesheet-made STL is recognised by its header and offers to reopen it in
      its generator with the original parameters, which is what the provenance
      header exists for
  EVIDENCE (2026-09-03): a generator export is recognised by its header
    (`parseProvenance`, both `Bluesheet` and legacy `Forge` prefixes), shows
    "Made by Bluesheet: <gen> v<n>", offers Open in generator, and matches a
    saved library entry by provenance when one exists (checked read-only
    against the live library).

- [x] G6: an inspected file can go straight to the slicer and the printer through
      the same path as a generated object, so the inspector is a real front door
      and not a dead end
  EVIDENCE (2026-09-03): "Use this object" puts the imported mesh in as
    `S.imported`; `__bluesheet.mesh` is the imported mesh and the slice path's
    `stl()` returns it, so Export/Slice/Print are unchanged.
