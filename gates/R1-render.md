# Gates: R1 — js/render/ (WebGL2 solid viewer)

Scope: the 3D view. Orbit/pan/zoom on desktop and touch, a real build plate, and
shading that makes a printed object legible before it is printed.

Files: `js/render/camera.js` (pure math), `geometry.js` (buffer prep),
`shaders.js` (GLSL), `glutil.js` (program/buffer helpers), `plate.js`,
`gcode.js` (toolpaths), `viewer.js` (canvas, GL, input, API).
Tests: `tests/render-math.test.mjs`.

Browser evidence below comes from a headless-Chrome harness kept outside the
project tree (leaf owns only `js/render/*` + its test file):
`<scratchpad>/serve.py` + `<scratchpad>/rendertest.html`, run with
`google-chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader
--virtual-time-budget=90000 --dump-dom --screenshot`. It builds nine live
viewers on a real WebGL2 context, synthesises pointer/touch gestures, and reads
pixels back. 32 checks, 0 failures.

- [x] G1: pure math is separated and tested — camera, matrices, ray picking and
      the arcball live in js/render/camera.js with no DOM, tested headlessly
  CHECK: node tests/render-math.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `render math: 226/226 passed` / `RESULT: PASS`
      camera.js imports nothing and touches no DOM; the orbit is a turntable
      with an explicit roll term (two-finger twist) rather than a free
      quaternion arcball — deliberate, and the reason is in the file header: a
      build plate that can end up upside down is unnavigable, and roll kept
      separate means setRoll(0) is exactly level again after any number of drags.

- [x] G2: at least 25 checks in the math suite
  CHECK: node tests/render-math.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `226`
      Where a round trip could hide a sign error the suite asserts the absolute
      pixel too, computed by hand from the frustum — e.g. "a point 10mm to the
      right lands at the pixel the frustum says" (482.4 px, exact), "pan moves
      the model with the finger" (centre + dx, exact), "zoom-to-cursor pins the
      point under the cursor" (620,180 held to 1e-6 px). project/unproject is
      also round-tripped, but never alone.

- [x] G3: every render module imports cleanly in Node (no DOM at module scope) —
      this is what lets the rest of the kernel stay testable
  CHECK: for f in js/render/*.js; do node -e "import('./$f').then(()=>console.log('ok $f')).catch(e=>{console.log('FAIL '+'$f'+': '+e.message);process.exit(1)})" || exit 1; done
  EXPECT: /ok js\/render\/viewer.js/
  EVIDENCE: `ok js/render/camera.js` `ok js/render/gcode.js` `ok js/render/geometry.js`
      `ok js/render/glutil.js` `ok js/render/plate.js` `ok js/render/shaders.js`
      `ok js/render/viewer.js` — all seven.

- [x] G4: the viewer implements, and the code demonstrably contains, all of:
      orbit + pan + zoom (mouse AND touch, one finger orbit, two finger
      pan/pinch), a build plate with a 10mm grid and the A1 mini 180x180 outline,
      shaded solid with crease-aware normals, an overhang view colouring faces
      steeper than a configurable angle, a cross-section clip plane on Z, a
      wireframe/edges toggle, view presets (front/top/iso), fit-to-object, and
      a G-code toolpath mode that draws a sliced layer stack with a layer slider.
  EVIDENCE: driven for real in headless Chrome, synthetic PointerEvents with
      `pointerType:'touch'`, and read back off the framebuffer:
      - `ok one finger orbits — azimuth -60.0 -> -85.8 deg, elevation 28.0 -> 40.9 deg`
      - `ok two fingers pan — target moved 3.80 mm`
      - `ok pinch zooms — distance 191.4 -> 105.2 mm`
      - `ok two-finger twist rolls the view — roll 0.0 -> -15.9 deg`
      - `ok the wheel zooms toward the pointer — distance 191.4 -> 100.9 mm`
      - `ok solid viewer builds and draws — 7052 tris in 31 ms, 0.7 ms/frame`
      - `ok overhang view measures the model — 28.9% of area over 45 deg, worst 90.0 deg`
      - `ok wireframe builds an edge buffer — 10782 edges`
      - `ok cross-section clip is armed — clip z = 31.00 mm of 50.0`
      - `ok a concave cross-section caps without a hollow shell — stencil buffer present, clip at 12 mm`
      - `ok orthographic top view with an edge overlay — 10782 edges over the solid`
      - `ok g-code mode packs and draws toolpaths — 7922 segments over 60 layers, 0.4 ms/frame`
      - `ok the layer slider reports inclusive indices — range [0,41], progress 42`
      - `ok the build animation advances bottom-up — 0.00 -> 10.00 of 60 layers`
      - `ok a type can be hidden without repacking the buffers — mask 111110111110`
      - `ok thumbnail() returns a square PNG data URL — 31130 chars`
      - `ok plateHit turns a pointer position into millimetres on the plate — [-23.5, 40.7, 0.0] mm`
      - `ok every viewport actually renders geometry, not an empty frame —
         12.0% / 29.0% / 10.4% / 10.8% / 12.3% / 15.6% / 10.9% / 42.2% / 9.1%`
         (readPixels, fraction of the framebuffer brighter than the background)
      - `ok no GL errors anywhere in the nine viewers — clean`
      Screenshot inspected at each stage (`shot3.png`, 9 panels): the solid reads
      as an object with a key/fill/rim rig, a hemisphere ambient and a
      stencil-masked ground shadow; the sphere is smooth and the box crisp from
      one `toRenderBuffers({crease:35})` call; the overhang view colours the
      bottom 14.6% of the sphere's projected height, which is exactly where
      asin(-n.z) crosses 45 degrees; the torus section shows a filled amber
      ANNULUS — a concave cut face capped correctly, which is what the
      front/back-face stencil count buys over a convex cap.
      Where each requirement lives:
      - orbit/pan/pinch/twist  `viewer.js` `_onDown/_onMove/_onUp` (Pointer
        Events, so mouse, pen and touch are one path), `camera.js`
        `orbit/pan/zoomAt/rollBy`; `canvas.style.touchAction='none'`
      - build plate  `plate.js buildPlateGeometry({size:180, grid:10, major:50})`
        — 10 mm grid, 50 mm majors, 180x180 outline as a 0.63 mm triangle ribbon
        (GL clamps lineWidth to 1), coloured origin marker, edge ticks, radial
        fade. Everything sits on its own shelf between -0.18 and -0.01 mm so it
        cannot z-fight a model whose bbox.min.z is exactly 0.
      - crease shading  `geometry.js meshToBuffers` -> `mesh.toRenderBuffers({crease})`
      - overhang  `shaders.js overhangDeg()` + `viewer.setOverhangThreshold(deg)`,
        legend drawn by the viewer, measured by `geometry.overhangStats`
      - cross-section  `viewer._drawCutCap` (stencil INCR_WRAP/DECR_WRAP count,
        then one capped quad) with `_drawBackfaceCap` as the no-stencil fallback
      - wireframe  `geometry.buildEdgeIndices` + `viewer.setEdges/setMode('wire')`
        (hidden-line: dark depth pass, then edges with a clip-space depth bias)
      - presets + fit  `camera.PRESETS` (front/back/left/right/top/bottom/iso/
        isoLeft) and `camera.fitBox`, which measures the box along the camera's
        own axes so a flat part fills the frame instead of floating in a third of it
      - g-code  `gcode.js` — instanced screen-facing ribbons, per-type colours,
        contiguous per-layer instance ranges, `drawArraysInstanced` with the
        attribute offset standing in for the baseInstance WebGL2 lacks

- [x] G5: it does not burn the laptop — rendering is on-demand (draw only when
      something changed or an interaction is live), and it stops entirely when
      the tab is hidden via the Page Visibility API
  CHECK: grep -c "visibilitychange" js/render/*.js
  EXPECT: /[1-9]/
  EVIDENCE: `js/render/viewer.js:2` (the other six modules are 0 — they own no
      events). Proven behaviourally rather than by grep:
      - `ok the viewer settles instead of feeding itself frames — dirty false, pending frame handle 0`
      - `ok three requestDraw calls schedule exactly one frame — 1 rAF call(s)`
      - `ok ...and that one frame draws exactly once — 1 draw(s)`
      - `ok ...leaving nothing scheduled afterwards — dirty false, handle 0`
      - `ok a hidden tab schedules no frames at all — handle 0 before the event, 0 after`
      - `ok becoming visible again wakes it up — handle 11`
      There is no idle loop at all: `requestDraw()` marks the frame stale and the
      rAF handle is the coalescing point, `document.hidden` refuses to schedule,
      and the only continuous animation (the G-code build) stops itself at the
      last layer and rebases its clock across a hidden tab so it does not jump.
      Wall-clock frame counting was tried first and abandoned as dishonest:
      headless Chrome stops pumping animation frames once the page is quiescent,
      so an idle count of 0 would have passed even for a viewer with a busy loop.

- [x] G6: it handles a 500k-triangle mesh without falling over (index buffer
      widening to Uint32 handled, buffers reused not reallocated per frame)
  EVIDENCE: 500,000 triangles / 251,001 vertices, in the browser and in Node.
      Browser (`shot3.png` panel 6, live WebGL2):
      - `ok 500k triangles upload and draw — 500000 tris, 251001 verts, upload+first frame 18 ms, steady frame 0.1 ms`
      - `ok ...with a 32-bit index buffer — Uint32Array`
      - `ok ...and buffers are reused, not reallocated per frame — 3.0 MB positions + 6.0 MB indices, held`
        (the assertion reads `GLBuffer.byteLength`, which only grows on a real
        reallocation; `GLBuffer.set` uses bufferSubData into the existing
        allocation whenever the new data fits, and nothing uploads per frame)
      Node (`tests/render-math.test.mjs`):
      - `ok 500k triangles prepare without falling over — 500000 tris, 251001 verts in 4 ms`
      - `ok indices are Uint32 once past 65535 vertices — Uint32Array, 251001 verts`
      - `ok wireframe edges for 500k triangles build in one pass — 751000 unique edges in 186 ms`
      - `ok overhang analysis of 500k triangles is a single sweep — 24849 mm2, 0% overhang, 33 ms`
      - `ok widenIndices does not copy an array that is already Uint32`
      Widening happens in `geometry.meshToBuffers` (a >65535-vertex mesh arriving
      with 16-bit indices is promoted rather than drawn as garbage) and the draw
      type comes from `glutil.indexType`. Two budgets keep the pathological
      cases from locking the tab: the ground shadow is skipped past 260k
      triangles, and `buildEdgeIndices` returns null past 2M and warns rather
      than spending seconds and 50 MB on a wireframe nobody can read.
