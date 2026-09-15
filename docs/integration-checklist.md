# Integration checklist (driver)

Things that only bite once every part exists, in the order they bite.

## Static serving
- [x] `.woff2` served — `css/fonts.css` points at `assets/webfonts/*.woff2` and a
      404 there silently falls back to a system font, which looks *almost* right
      and is the kind of bug that survives a screenshot.
- [x] `.ttf` served — `js/kernel/text.js` fetches `assets/fonts/*.ttf` at runtime
      for the nameplate and terrain generators. Blocked, they fail at build time
      with a confusing error rather than at load.
- [x] `.json` served — bundled terrain fields live in `assets/terrain/*.json`.
      **Fixed 02:31**: `.json` stays out of `ALLOWED_EXT` (configuration and state
      files are overwhelmingly `.json`, and a blanket allow is how a service ends
      up serving its own settings); instead it gets a narrow exception under
      `assets/` only. `assets/terrain/snowdon.json` now returns 200 with
      `application/json`; `/library/x.json` and `/package.json` still 404; the
      security probe still passes 55/55 and `test_server.py` 214/214.
      Originally measured 22:51: `.woff2`, `.ttf`, `.js` and `.css`
      all serve; `assets/terrain/snowdon.json` does not. The allowlist was
      written before the terrain fields existed. Traversal and source-file
      probes all correctly 404 (`../../../etc/passwd`, `%2e%2e`, `/server.py`,
      `/PLAN.md`, `/gates/*`, `/.gitignore`, `/server/util.py`), so the
      allowlist itself is sound — it is just missing an extension.
- [x] `.mjs`/`.js` served with `text/javascript`, or module loading fails outright.
- [x] Still no traversal, no dotfiles, no `*.py`, no `*secret*`. The allowlist
      grew; re-run `tests/security_probe.py` after touching it.

## Slicing the plate
- [ ] **`--arrange 0`, always, for a plate.** With `--arrange 1` OrcaSlicer
      re-arranges the objects and the preview on screen is a lie. Verified
      2026-08-21 on a 5-object plate: with `--arrange 1` the model spread to
      Y 137; with `--arrange 0` it printed at X 2.8..97.2, Y 2.8..27.2 against a
      requested X 5..95, Y 5..25 — the 2.2 mm is brim and extrusion width.
- [ ] The STL handed to the slicer is in printer coordinates (0..180 from the
      front-left corner), not Bluesheet's plate coordinates (centred on the origin).
      `pack.toBedCoords()` is the one place that conversion happens.

## Cross-module
- [ ] `js/gen/index.js` id list matches the files actually in `js/gen/`.
- [ ] Every generator's `hints()` profile keys match what `server/slice.py`
      actually accepts, or the advice silently does nothing.
- [ ] The viewer's `setGcode` shape matches what `/api/slice/<id>/gcode` returns.
- [ ] `mesh.toSTL(provenance)` is what the app calls, so the header carries
      `Bluesheet <gen> v<n> #<hash>` rather than a bare name.

## Before the print
- [ ] Plate is clear (workshop camera, not assumption)
- [ ] Filament matches the sliced profile — PLA profile with PLA loaded
- [ ] AMS mapping in the print request points at the slot the profile expects
- [ ] The gcode's bounding box is on the bed. **Skipping the start block is not
      enough**: measured 2026-08-21, the A1's purge extrudes along Y ~= -2.5
      across X -13.5 to 113, and it happens *after* the first `;LAYER_CHANGE`.
      Filter on `Y < 1` to exclude it, or the bounding box of any plate looks
      like it runs off the front of the bed.
- [ ] `print-watch` armed before pressing go, not after
