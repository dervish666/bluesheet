# Gates: G02 — js/gen/lithophane.js (Photo lithophane)

Scope: A photograph as a translucent relief. The one generator that turns
something personal into an object, and the easiest to get subtly wrong.

- [x] G1: the suite passes
  CHECK: node tests/gen-lithophane.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `gen lithophane: 298/298 passed` / `RESULT: PASS` (20.2 s wall, Node 22)

- [x] G2: the shared contract harness passes in full — tests/lib/genconform.mjs
      conformance() is called and reports zero sweep defects. That harness builds
      every numeric parameter at its min AND its max and asserts the result is
      still a watertight solid resting on the plate. A generator that only works
      at its defaults fails here.
  CHECK: node tests/gen-lithophane.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: `ok   parameter sweep: every extreme still yields a watertight solid (69 builds)  — 69 builds, 0 defects` — plus 465 further combination trials (shape × frame × foot × fit × guard × hanger × mirror × filter × anchor, degenerate images, arc/shade clamp corners) run outside the suite: 0 defects.

- [x] G3: at least 40 checks in the suite, of which at least 18 are
      domain-specific (not from the shared harness)
  CHECK: node tests/gen-lithophane.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(4[0-9]|[5-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `298` total; 62 of those come from conformance(), so **236 are domain-specific** (everything after the `-- the mapping --` banner).

- [x] G4: the image-to-height mapping is correct and testable. With
      tests/lib/genconform.mjs testImage(): the darkest pixel maps to the maximum
      thickness and the brightest to the minimum (dark = thick = blocks light —
      getting this backwards produces a negative and is the classic error), the
      mapping honours gamma and contrast parameters, and the resulting height
      range equals maxThickness - minThickness within 1e-6.
  EVIDENCE: Field: `the darkest pixel maps to the maximum thickness — got 3, want 3 (off by 0)`; `the brightest pixel maps to the minimum thickness — got 0.8, want 0.8 (off by 2.2e-16)`; `the thickness range equals maxThickness - minThickness — got 2.2, want 2.2 (±1e-6, off by 0)`, and still exactly 2.2 under gamma 2.2, contrast 2.5 and contrast 0.4 + gamma 0.5. Curve: `gamma above 1 thins the midtones — 1.573 mm vs 1.900 mm at gamma 1`; `contrast above 1 pushes the quarter tones apart — quarter 2.45->2.73, three-quarter 1.35->1.07 mm`; both leave the black and white points untouched. Read back off the **mesh**, not the field: `black down the left edge prints at the maximum thickness — got 3, want 3`; `dark is thick, not thin — left 3.000 mm vs right 0.800 mm`; `the picture is the right way up: its dark first row is at the top — got 3, want 3` (a vertical-gradient fixture, which is what catches an upside-down build that every topology check passes).

- [x] G5: all four shapes build as watertight solids and are dimensionally right:
      **flat** (a plate, optionally framed), **curved** (a cylindrical arc of a
      given radius and included angle), **inner-curved** for a lamp, and a
      **four-sided lamp shade** whose four faces are four different images or the
      same one repeated. For the curved forms, assert the arc length of the image
      surface equals the requested image width within 1%.
  EVIDENCE: `shape "flat"/"arc-out"/"arc-in"/"shade": watertight (0 boundary edges of 30759 / 80724 / 80724 / 54552)`, all manifold, consistently wound, positive volume, on the plate and centred. Dimensions: `a framed flat panel is picture + two borders wide — got 104, want 104`. Arc length is measured from the built vertices (circle fitted through three points on the smooth face, then the surface ring walked and summed — nothing asks the generator what it thinks): `arc-out R60: the picture surface measures 100 mm along the arc — got 99.999728` (0.0003%), `arc-in R50 — got 89.999595`, `arc-out R55 W150 — got 149.9997`. The chord is reported beside it as the wrong answer: `92.6 degrees of arc; the chord across it is 89.47 mm, 10.5% short of the 100 mm the picture wants`. Shade: `the shade is a tube, not a block (Euler characteristic 0)`, `square on the outside — got 64, want 64`, `four different pictures make four different faces — 48526 mm³ against 47004 mm³ for the same picture repeated`.

- [x] G6: image handling is honest. Aspect ratio is preserved or explicitly
      cropped (never silently stretched), the image is resampled to a target
      resolution with a real filter (box or Lanczos, not nearest-neighbour
      point sampling, which produces visible stair-stepping in the print),
      a 4000x3000 input does not produce a 12-million-triangle mesh, and an
      all-one-colour image produces a flat plate rather than a crash or a NaN.
  EVIDENCE: Aspect: `160x120 / 120x160 / 300x100 photograph keeps its aspect ratio exactly — off by 0` at 1e-9, nothing cropped; `there is no "stretch" option to choose by accident — aspect|crop`. Filtering is measured against the wrong answer computed in the same test — a one-pixel checkerboard at 512² reduced to a 287 grid: `nearest-neighbour would alias this fixture (the control) — point sampling gives 2.200 mm of relief from a texture with none`, then `"lanczos" — 0.123 mm`, `"box" — 0.032 mm`, `"triangle" — 0.138 mm`. (This found a real defect: the box filter was point-evaluated and aliased the full 2.200 mm; it is now integrated over each source pixel.) Size: `a 4000x3000 photograph does not become a 12-million-triangle mesh — 123498 triangles, against 24 million for one vertex per pixel`, `the mesh is sized by the object, not by the file — 123498 from 12 MP, 123498 from 0.12 MP`, `builds quickly — 547 ms`, and `the triangle budget holds at the finest pitch on the widest panel — 294164 triangles`. Single tone: `a single-tone (0/0.5/1) picture is a flat plate, not a NaN — volume 30000.00 / 19000.00 / 8000.00 mm³`, each at exactly the thickness that tone maps to, and watertight.

- [x] G7: it produces something a person would actually want. At least 4 presets,
      each a recognisably different and *useful* object, each named for what it is
      for rather than for its parameters ("Bolt tin", not "Preset 3").
  EVIDENCE: Six: *Framed photo for the wall* (166×4×116, teardrop hanger), *Standing arc for a desk* (35×111×123, on a plinth), *Night-light shade* (70×70×95), *Tea-light arch* (34×91×107), *Keyring pendant* (42×2×52), *Window panel, tall crop* (94×3×164). `the presets are genuinely different objects — 6 distinct shapes from 6 presets`; `they cover at least three of the four shapes — flat, arc-out, shade, arc-in`; `none of them is named after a number`; every one is watertight, sits on the plate, fits the bed and returns zero validate() errors; `no preset blows the triangle budget — worst 295928`.

- [x] G8: printability is thought about, not assumed. hints() returns real slicing
      advice for this object (layer height, walls, infill, supports yes/no, and
      why), and the test asserts that a deliberately unprintable parameter set is
      caught by validate() rather than silently generating an object that will
      fail on the bed.
  EVIDENCE: `hints() recommends a layer height at or below the pixel pitch — 0.12 mm layers against a 0.35 mm pitch`; `100% infill`; `no top solid layers — 0`; `says no supports`; `names a filament — White PLA`; `returns the mapping curve — 21 samples falling monotonically from 3.00 mm at black to 0.80 mm at white` plus an inline sparkline `█▇▇▆▅▄▄▃▂▂▁`. Prose asserted for the four settings that actually ruin one: infill, top layers, **ironing** (the relief is read as top surface and ironed in patches), and **seam** (start-of-layer blobs land in the middle of the picture). Unprintable sets caught: `a panel wider than the bed is an error — This comes out 200 x 4 x 81 mm and the A1 mini bed is 180 x 180 x 180 mm`; a panel taller than the build volume; `a tone range with no range in it is an error — The thickest point (1.6 mm) is not meaningfully thicker than the thinnest (1.6 mm)`; a single-tone photograph; an arc that would close on itself. Each still *builds* — the test asserts that too, so the refusal is validate()'s judgement and not a crash. Also: the overhang guard, `a hard horizontal edge really is an unprintable step without the guard — 3.15 mm of relief per mm of height, past the 2.0 limit — at 0.1 mm layers that is 0.31 mm of unsupported offset per layer against a 0.42 mm extrusion`, and `the overhang guard ramps it to a printable slope — 3.15 mm per mm becomes 2.00`, and corrected only by adding material below.

- [x] G9 (added 2026-09-06): a flat plate can carry a message under the picture,
      in three styles that are three different solids rather than three labels —
      **raised** off the front, **engraved** into it, and **lit**, cut into the
      BACK deep enough to leave only a picture-thin skin so the words appear only
      when the panel is held to the light. The band the text sits in is measured
      from the laid-out text, the message shrinks rather than overrunning the
      panel, the lit one is mirrored so it reads through the panel, and the
      result is ONE watertight solid in every case.
  CHECK: node tests/gen-lithophane.test.mjs 2>&1 | sed -n '/-- the caption --/,$p' | grep -c '^  ok '
  EXPECT: /^(2[0-9]|[3-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `a caption leaves the picture exactly the size it was — 100 x 100 mm`;
      `the panel grows by the band and by nothing else` (off by 3.6e-15 mm);
      `a second line asks for more band, not a smaller face — 26.3 mm vs 11.4 mm`.
      Raised: `the object is exactly the relief deeper than the frame`, `nothing
      above the band stands proud of the frame`, and — the one that a screenshot
      catches and a topology check does not — `the letters are part of the panel,
      not fifteen loose solids on top of it — 1 shells`. The Bluesheet inspector
      counted 15 shells for "Happy Birthday" while reporting the mesh manifold
      and watertight, which is how the first version of this shipped in a preview
      that looked perfect; the letters are now lofted out of the hole they leave
      in the face rather than stood on top of it. Volume is asserted to grow
      linearly with the relief at exactly the area of the ink (113.0 mm²) and the
      engraved style is asserted to take *the same area* back out again (0.0%
      apart), which is what proves the three styles are three treatments of one
      piece of text. Faces: `engraved: the band sits on three planes — back,
      pocket floor, front — 0, 2.9, 3.6` and `lit: 0, 2.8, 3.6`, measured from the
      back of the panel rather than from a centre that moves when the letters do.
      Mirroring is checked by comparing the engraved and lit pocket vertices as
      point sets under x-negation — `mirrored` — and the check was confirmed able
      to fail (dropping the mirror reports `not mirrored at all`). Refusals:
      a caption on a curved panel and a caption with no frame are both warned by
      name and the object still builds identically to one that never asked; an
      empty caption `changes not one triangle`; a 29-character message at 20 mm
      is `shrunk to 23%, 0 vertices past the edge`; a character the face lacks is
      dropped and named. All three styles × all three bundled faces are
      watertight, manifold, consistently wound and positive-volume.
  NOTE: a pocketed caption puts the letters and the picture window into one face
      triangulation, and poly2d.triangulate()'s hole bridging can land a vertex
      partway along an edge the pocket walls also use — 412 boundary edges on
      "With love" in the narrow face while the same words in the rounded one were
      watertight. buildFlat() calls mesh.healTJunctions() whenever a caption is
      present, the same fix the QR plaque uses for the same kernel behaviour.
