# Gates: P1 — the plate (js/ui/plate-panel.js, js/kernel/pack.js, server/plate.py)

Scope: slicing one object at a time is a toy. Bluesheet keeps a plate of objects and
slices them together, so four bins are one print.

- [x] G1: packing is real and tested headlessly — js/kernel/pack.js exports
      pack(items, bed, opts) placing objects on a 180x180 plate with a stated
      gap, and tests/pack.test.mjs proves no two footprints overlap, nothing
      crosses the bed edge, and gridfinity bins pack sensibly
  CHECK: node tests/pack.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: "pack: 52/52 passed / RESULT: PASS" — written by the driver, not a
    leaf: MaxRects best-short-side-fit with rotation, 7/7 exports covered.
    Nine 41.5 mm bins fit with a 3 mm gap, sixteen when allowed to touch.

- [x] G2: at least 25 checks including rotation, mixed sizes, an item too big to
      fit (rejected with a message, not silently dropped), and 40 small items
  CHECK: node tests/pack.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: 52

- [ ] G3: the plate panel works in the browser: add the current object to the
      plate, see it appear in the viewport at its packed position, add a second
      object of a different generator, remove one, change a quantity, and clear
      the plate. Driven through real clicks in tests/plate.test.mjs.
  CHECK: node tests/plate.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G4: a multi-object plate slices for real — POST several STLs, get one 3mf
      back, and assert from the embedded gcode that the object count and the
      combined bounding box are what the plate said they were, and that
      everything sits inside the bed.
      **Two facts the driver measured on 2026-08-21, so you do not have to:**
      (a) the slicer must be called with `--arrange 0` or it re-arranges the
      plate and the screen becomes a lie — with `--arrange 1` a plate placed at
      Y 5..25 came out spread to Y 137; (b) when you bounding-box the gcode, the
      A1's purge extrudes along Y ~= -2.5 across X -13.5..113 and it happens
      AFTER the first `;LAYER_CHANGE`, so filter `Y < 1` or every plate looks
      like it runs off the front of the bed. With both handled, a plate placed at
      X 5..95 / Y 5..25 measured X 2.8..97.2 / Y 2.8..27.2 — the 2.2 mm is brim
      and extrusion width, and that is the tolerance to assert against.
  EVIDENCE: pending

- [ ] G5: provenance round-trips. Every exported STL's 80-byte header carries
      `Bluesheet <gen> v<n> #<hash>`; the server can read it back and return the
      generator id and hash; the library stores the full parameters against that
      hash so an object can be regenerated exactly. Prove it by exporting,
      re-reading the header, and rebuilding a byte-identical mesh.
  EVIDENCE: pending

- [ ] G6: the plate survives a reload — it is persisted server-side, and the
      viewport redraws it correctly after a page refresh
  EVIDENCE: pending

## Note on ownership
G1 and G2 (js/kernel/pack.js, tests/pack.test.mjs) were written by the driver
while builders.js was blocked behind another leaf, so this leaf owns only the UI
and server halves: js/ui/plate-panel.js, server/plate.py, tests/plate.test.mjs.
Do not edit js/kernel/pack.js — read its exports and use them.

A finding from writing it, worth carrying into the UI: **the default 3 mm gap
costs real capacity on parts designed to touch.** Nine gridfinity bins fit with
it, sixteen without. The plate panel must expose the gap, default it to 3 mm for
safety, and say what it costs when parts are gridfinity-like.
