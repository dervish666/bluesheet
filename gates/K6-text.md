# Gates: K6 — js/kernel/text.js (TrueType outlines to 2D shapes)

Scope: real font outlines, parsed here, with no library and no canvas — so a
nameplate generator can extrude actual letterforms.

- [x] G1: suite passes
  CHECK: node tests/text.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `text: 191/191 passed` / `RESULT: PASS`

- [x] G2: every export exercised
  CHECK: node tests/coverage.mjs js/kernel/text.js tests/text.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: `COVERAGE: 9/9 exports covered` / `missing: none`
    (loadFont, Font, layoutText, measureText, capScaleFor, flattenQuadratic,
     contoursToShapes, sniffFontFormat, FontError)

- [x] G3: at least 30 checks
  CHECK: node tests/text.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([3-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `191`

- [x] G4: at least two real fonts are bundled under assets/fonts/ (a sturdy sans
      and a mono or a slab), each under 400 kB, each with a licence file, and the
      test parses both
  CHECK: ls assets/fonts/ | tr '\n' ' '
  EXPECT: /\.ttf/
  EVIDENCE: `DejaVuSansMono.LICENSE.txt DejaVuSansMono.ttf LiberationSansNarrow-Regular.LICENSE.txt LiberationSansNarrow-Regular.ttf Quicksand-Bold.LICENSE.txt Quicksand-Bold.ttf README.md`
    Three fonts, not two. Sizes from `ls -l`: Quicksand-Bold 96,204 B (96.2 kB,
    sturdy geometric sans, GPOS kerning), DejaVuSansMono 343,140 B (343.1 kB,
    mono, cmap format 12 + 1,305 composite glyphs), LiberationSansNarrow-Regular
    112,644 B (112.6 kB, carries a legacy `kern` table with 932 pairs). All
    under 400 kB. Licences checked before copying and shipped verbatim as the
    upstream Debian `copyright` files: `Quicksand-Bold.LICENSE.txt:License:
    OFL-1.1`, `LiberationSansNarrow-Regular.LICENSE.txt:License: SIL-OFL-1.1`,
    `DejaVuSansMono.LICENSE.txt:License: bitstream-vera` — the OFL text reads
    "can be bundled, embedded, redistributed and/or sold with any software" and
    Bitstream Vera grants "the rights to use, copy, merge, publish, distribute".
    Neither forbids what we are doing; both conditions (unmodified files, not
    sold on their own) hold. assets/fonts/README.md records the provenance.
    The test parses all three, every glyph of each, not just a sample:
      `Quicksand-Bold: all 731 glyphs parse — 1585 contours total`
      `DejaVuSansMono: all 3377 glyphs parse — 7250 contours total`
      `LiberationSansNarrow-Regular: all 681 glyphs parse — 1450 contours total`

- [x] G5: outlines are geometrically right, not merely present. Prove it: 'O' has
      exactly 2 contours with opposite winding, 'i' has 2 contours both outer,
      'l' has 1, and the bounding box of a rendered 'H' at 10mm cap height is
      within 2% of 10mm tall. Quadratic beziers are flattened with implied
      on-curve midpoints handled (the classic TrueType trap).
  EVIDENCE: every claim checked against all three bundled fonts —
    `Quicksand 'O': one shape holding exactly 2 contours — 1 shape(s), rings 2`
    `Quicksand 'O': outer ring CCW, counter CW — opposite winding — outer 387159, hole -159634`
    `DejaVuMono 'O': outer ring CCW, counter CW — opposite winding — outer 1291709, hole -598042`
    `Narrow 'O': outer ring CCW, counter CW — opposite winding — outer 1354433, hole -770722`
    `Quicksand 'i': 2 contours, both of them outer — 2 shape(s), rings 1+1`  (same for the other two)
    `Quicksand 'l': 1 contour — 1 shape(s)`  (same for the other two)
    `Quicksand 'H' at 10 mm cap height measures 10 mm tall — got 10, want 10 (±2%, off by 0)`
    `DejaVuMono 'H' at 10 mm cap height measures 10 mm tall — got 10, want 10 (±2%, off by 0)`
    `Narrow 'H' at 10 mm cap height measures 10 mm tall — got 10, want 10 (±2%, off by 0)`
    (exact, because cap height is measured from the font's own 'H' outline
    rather than trusted from OS/2 — which DejaVu Sans Mono does not even supply)
    The midpoint trap is proved two ways. On a font built byte by byte in the
    test, a contour with two consecutive off-curve points at (100,200) and
    (300,200) must pass exactly through their midpoint:
    `implied on-curve midpoint: the ring passes exactly through (200, 200) — ring of 21 points`
    and a contour with *no* on-curve point at all must synthesise all four:
    `all-off-curve contour: every implied on-curve point is present — 52 points in the ring`
    On the real fonts, a mishandled midpoint shows up as a corner in a round
    letter, so the direction change is measured:
    `Quicksand 'O': no flat spots — max direction change 11.6° < 25°`
    `DejaVuMono 'O': no flat spots — max direction change 17.9° < 25°`
    `Narrow 'O': no flat spots — max direction change 14.1° < 25°`
    Flattening is adaptive, not a fixed count:
    `flattening scales with the requested size, not a fixed count — 180 points at 5 mm → 648 at 100 mm`
    `flattenQuadratic: real deviation 0.0486 stays inside the 0.05 tolerance`
    (measured against the true curve at 400 sample points, not inferred from
    the segment count)

- [x] G6: layout works — kerning or at least advance widths accumulate, multi-line
      text with alignment, letter spacing, and a string containing a space
      produces no stray contour
  EVIDENCE: `layout: width is advance + kern + advance — got 17.5, want 17.5 (±1e-9, off by 0)`
    Both kerning back-ends are implemented and cross-check each other on the one
    font that ships both:
    `the legacy kern table and GPOS agree on every pair tried — AV=-123 To=-186 AW=-61 Va=-123 Y.=-215`
    `letterSpacing: n-1 gaps, not n — the run stays centred — got 4, want 4 (±1e-9, off by 0)`
    `a space produces no stray contour — "AB" -> 2 shapes, "A B" -> 2`
    `multi-line: the second baseline is one lineHeight down — got -16, want -16 (±1e-12, off by 0)`
    `align right: every line ends at x = 0`
    `align left/right shift the ink the way the names promise — left min x 0.3429, right max x -0.4000`
    `maxWidth: the run is scaled to exactly the limit — got 60, want 60 (±1e-9, off by 0)`

- [x] G7: the shapes returned are directly usable by poly2d: outer rings CCW,
      holes CW, and triangulate() on every glyph of "Bluesheet 3D! @#" succeeds with
      summed area equal to the analytic ring area
  EVIDENCE: `poly2d.triangulate: succeeds on every glyph of "Bluesheet 3D! @#" — 825 triangles`
    `poly2d.triangulate: triangle area matches the ring area (worst gap 1.85e-13 mm2)`
    `"Bluesheet 3D! @#": outer rings CCW, holes CW, in every shape — 0 rings wound wrongly out of 17`
    A second, independent check of the same property that does not depend on
    K1's module — exact scanline integration under the non-zero winding rule,
    which asks what a rasteriser would paint rather than trusting the winding:
    `"Bluesheet 3D! @#": filled area equals the analytic ring area (worst gap 2.13e-13 mm2) — 11 shapes checked by scanline integration`

## Notes

- Nesting (which contour is a hole) is decided by containment depth, never by
  the winding the font stored. TrueType's stated convention is clockwise-outer,
  but a mirrored composite component reverses it and shipped fonts get it wrong.
  Proved on a synthetic glyph whose two contours are wound identically and on a
  component mirrored by a 2×2 transform:
  `same-winding nested contours in a real glyph resolve to solid + hole`
  `mirrored composite: still one solid ring, and still CCW`
- CFF/OTTO, WOFF and WOFF2 are refused by name with the fix in the message,
  rather than producing an empty nameplate:
  `threw "This is an OpenType/CFF font (OTTO). Bluesheet reads TrueType 'glyf' outlines only, so it would produce an empty nameplate rather than letters. Convert it to TTF (fonttools: 'fonttools ttf --flavor ttf font.otf') or pick one of the bundled fonts."`
  `threw "the font file is truncated: the 'cmap' table needs bytes 70712–72756 but the file is only 4000 bytes long"`
- Speed, on the i7-1165G7: `parsing a 335 kB font takes 0 ms`,
  `50 two-line layouts take 18 ms — well inside the 2 s build budget`.

No ABANDONs.
