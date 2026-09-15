# Gates: U1 — index.html, css/bluesheet.css, js/ui/*, js/app.js (the interface)

Scope: the whole front end. The catalogue, the parameter panel, the analysis
column, the title block, the dimension callouts, the slice and print path — and
the visual identity in docs/design.md, executed rather than approximated.

- [ ] G1: the page boots in real Chrome with zero console errors and exposes a
      test handle `window.__bluesheet` with `{ready:true, gen, params, mesh, rebuild(),
      setGen(id), setParam(k,v), analysis}`
  CHECK: node tests/ui.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: at least 35 browser-level checks
  CHECK: node tests/ui.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[5-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G3: the interface is driven end to end in the browser test: switch
      generator, change a numeric parameter and see the triangle count change,
      apply a preset and see the bounding box change, toggle a boolean, switch
      view mode, open the catalogue and filter it, and export an STL whose byte
      length matches 84 + 50 x triangles.
  EVIDENCE: pending

- [ ] G4: the design direction in docs/design.md is followed, not paraphrased.
      Specifically, verifiable in the built page: the palette tokens are the exact
      hex values from that document, Archivo Narrow is used for labels and the
      title block and IBM Plex Mono for every number, `--heat` appears ONLY on the
      slice/print path and on errors, and there is no green anywhere.
  CHECK: grep -oE "#(0D1621|14202E|0A121B|7FA6C7|33475C|E9F2FA|9DB4C9|FF6A1F|8A3A15|F2C94C)" css/bluesheet.css | sort -u | wc -l
  EXPECT: /^(9|10)$/
  EVIDENCE: pending

- [ ] G5: **the title block exists and is live.** Bottom-right inside the viewport,
      stating generator, variant, material, scale, bounding dimensions, volume,
      mass and a revision that increments on every rebuild. The browser test reads
      its text, changes a parameter, and asserts the dimensions and the revision
      both changed.
  EVIDENCE: pending

- [ ] G6: **dimension callouts are drawn on the model in ISO style** — extension
      lines standing off the surface, a dimension line with filled arrowheads, the
      value horizontal in a break in the line. Focusing a numeric parameter draws
      its dimension; with nothing focused the three bounding-box dimensions show
      faintly. Generators supplying `meta.dims` drive it; others fall back to the
      bounding box. The browser test asserts the callout element/geometry appears
      and that it names the focused parameter.
  EVIDENCE: pending

- [ ] G7: it works with a finger. Every control has a hit target at least 44px on
      its short axis, numeric parameters have -/+ steppers as well as a draggable
      field, nothing depends on hover to be discoverable, and the layout stacks
      correctly at 820px (iPad portrait) and 390px (phone). Verified by resizing
      the page in the browser test and asserting the computed layout, not by
      reading the CSS.
  CHECK: node tests/ui.test.mjs 2>&1 | grep -iE 'touch|44px|820|390' | head -5
  EXPECT: /ok /
  EVIDENCE: pending

- [ ] G8: the slice and print path is complete in the UI: a slice button that
      shows real progress, results (time, grams, layers, cost) rendered into the
      analysis column, the gcode preview switched into the viewport when a slice
      finishes, and a print button that is **disabled until a slice exists** and
      that requires an explicit confirmation step naming the object before it will
      send anything to the printer.
  EVIDENCE: pending

- [ ] G9: the catalogue is a real front door: every registered generator shown as
      a card with its name, category and blurb, filterable by category and by
      typed text, keyboard navigable, and each card previews the generator's
      default object rather than showing a placeholder.
  EVIDENCE: pending

- [x] G10: nothing runs when nothing is happening. The rebuild is debounced,
      geometry work happens off the main thread or in an interruptible chunked
      loop so dragging a parameter never freezes the page, and everything stops on
      `document.hidden`.
  CHECK: grep -c "visibilitychange\|document.hidden" js/ui/*.js js/app.js | grep -v ':0' | wc -l
  EXPECT: /[1-9]/
  EVIDENCE: 1 | grep: js/app.js: No such file or directory

- [ ] G11: accessibility floor: visible keyboard focus on every control, labels
      associated with inputs, `prefers-reduced-motion` honoured, contrast of body
      text at least 7:1 against its background. Measured, not assumed.
  EVIDENCE: pending

- [ ] G12: saved designs work — save the current generator and parameters to the
      library with a name, list them, load one back and assert the rebuilt mesh
      matches the saved one, and delete one.
  EVIDENCE: pending
