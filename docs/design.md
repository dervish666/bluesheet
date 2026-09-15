# Bluesheet — visual direction

## The idea

**Bluesheet is a drawing sheet.** Not a dashboard, not a dark IDE with an accent colour.
The artefact this tool produces is a manufactured part, and the artefact that has
described manufactured parts for a century and a half is the engineering drawing.
So the interface borrows the drawing's grammar: hairline rules, extension lines,
arrowheads, a title block, and lettering to the drawing standard.

And it borrows it *literally*, not as a texture: a real blueprint is **white lines on
blue**, which is why the dark interface here is a Prussian blue rather than the
near-black every other 3D tool defaults to. The light in the room is cold; the only
warm thing on the page is the heat — the nozzle, the bed, the print button.

## Palette

| token | value | what it is |
|---|---|---|
| `--sheet` | `#0D1621` | the drawing sheet. Deep Prussian, not black. |
| `--sheet-raised` | `#14202E` | panels sitting on the sheet |
| `--sheet-sunk` | `#0A121B` | the model-space viewport, recessed |
| `--line` | `#7FA6C7` | the drawn line. Every rule, every border, every dimension. |
| `--line-faint` | `#33475C` | grid, disabled, hairlines at 0.5 alpha weight |
| `--ink` | `#E9F2FA` | white ink: values, headings, the things you read |
| `--ink-dim` | `#9DB4C9` | secondary text |
| `--heat` | `#FF6A1F` | the one warm thing. Actions on the print path, errors, the nozzle. |
| `--heat-dim` | `#8A3A15` | heat at rest |
| `--caution` | `#F2C94C` | sulphur. Warnings that are not failures — overhangs, tolerances. |

There is no green. "Good" is simply the bright ink and the absence of a warning;
a traffic-light palette would make three colours do the work of one.

Use `--heat` **only** on the slice/print path and on errors. If it appears anywhere
else the page has lost its discipline.

## Type

| role | face | why |
|---|---|---|
| labels, headings, the title block | **Archivo Narrow** 500/600/700, uppercase, tracked +0.08em | The condensed industrial grotesque is what machine plates and drawing title blocks are lettered in. Narrow means a 20-character label fits in a panel column. |
| every number, every control, all data | **IBM Plex Mono** 400/500/600, tabular figures | Every value in this app is a measurement. Mono means the decimal points line up in a column of parameters without a single alignment rule. IBM drew Plex for technical documentation; it is the correct family and it is not the default choice. |
| prose (generator descriptions, help, empty states) | **IBM Plex Sans** 400/500 | The one place a proportional face is right. |

Self-hosted in `assets/webfonts/`, wired up by `css/fonts.css`. No third-party
request at runtime — this thing has to work when the internet does not.

Scale: 11 / 12 / 13 / 15 / 18 / 24 / 34. Labels live at 11 and 12 uppercase.
Values at 13 and 15. Nothing on this page needs to be 48px.

## Layout

Desktop, three columns under a thin header, all of it inside a 1px `--line-faint`
sheet border with a 12px margin, the way a drawing has a frame:

```
┌ BLUESHEET ────────── STORAGE / GRIDFINITY BIN ─────────── CATALOGUE ─┐
│              │                                    │              │
│  PARAMETERS  │                                    │   ANALYSIS   │
│              │                                    │              │
│  ── SIZE     │          M O D E L   S P A C E     │  MANIFOLD  ✓ │
│  Width  42.0 │                                    │  41.5×41.5   │
│  Depth  42.0 │        (3D, dimension callouts)    │  12.4 cm³    │
│  Units    2  │                                    │  15.4 g PETG │
│              │                                    │  ──────────  │
│  ── FEATURES │                                    │  1 h 04 m    │
│  Lip     [x] │                                    │  0.20 mm     │
│  Magnets [ ] │   ┌──────────────────────────────┐ │  212 layers  │
│              │   │ BLUESHEET      GRIDFINITY BIN 2×1│ │              │
│  PRESETS ▾   │   │ PETG  1:1  41.5×83.5×48.0 mm │ │  [ SLICE   ] │
│              │   └──────────────────────────────┘ │  [ PRINT   ] │
└──────────────┴────────────────────────────────────┴──────────────┘
```

Under 900px the columns stack: viewport first at 55vh, parameters below in a
scrolling sheet, analysis as a compact strip that expands on tap. Every control is
at least 44px on its short axis. **It is driven from an iPad** — a control that needs a
scroll wheel or a hover state is broken.

## The signature: the title block, and dimensions drawn on the model

Two halves of one idea.

**The title block** is anchored to the bottom-right of the model space, inside the
viewport, drawn in `--line` at 1px with `--ink` lettering — exactly where it sits on
a real drawing. It always states the current part: the generator's name and the
variant, the material, the scale, the bounding dimensions, the volume and mass, and
a revision number that increments every time the geometry rebuilds. It is not
decoration: it is the only place several of those numbers appear, and it is what
makes a screenshot of the viewport self-describing.

**Dimension callouts** connect the parameter list to the object. Touch or focus a
numeric parameter and that dimension draws itself onto the model in proper ISO 128
style — two extension lines standing off the surface by 2px, a dimension line with
filled 15-degree arrowheads, and the value in a break in the middle, always
horizontal regardless of the line's angle. It draws in over 180ms: extension lines,
then arrows, then the number. When nothing is selected the three bounding-box
dimensions show instead, faintly.

Generators opt in by returning `meta.dims` — an array of
`{param, label, from:[x,y,z], to:[x,y,z], offset}` — and get the treatment for free.
Generators that do not still get the bounding box.

This is the thing to spend the effort on. Everything else stays quiet.

### The scale bar

Along the bottom edge of the model space, a millimetre scale that reflects the
current zoom: a stepped bar with ticks and a figure ("0 ——— 20 mm"), snapping to
1 / 2 / 5 / 10 / 20 / 50 / 100 mm as you zoom. Between it and the title block the
viewport is fully self-describing: a screenshot of it tells you what the object
is, how big it is, and at what scale you are looking at it.

It is not decoration. Judging size on a screen is genuinely hard, and this is a
tool whose whole job is dimensions.

**Considered and cut**: the zone letters and numbers around a drawing frame
(A B C across the top, 1 2 3 down the side). Correct vernacular, but they encode
nothing here — there is no drawing to cross-reference — and that makes them
costume rather than clothing.

## Motion

One orchestrated moment, and nothing else:
- a parameter changes → the mesh rebuilds → the affected dimension animates in (180ms)
- slicing → the gcode preview builds bottom-up once, then holds
- the revision number in the title block ticks over

No page-load reveal, no scroll animation, no hover glow. `prefers-reduced-motion`
removes the dimension animation and the gcode build, leaving the end state.

## Copy

Plain, active, and named for what happens. "Slice" produces "Sliced". The catalogue's
empty state is "Pick something to make", not "No generator selected". A warning says
"Three walls are 0.6 mm — thinner than two 0.4 mm lines will print", not "Thin wall
detected". Errors do not apologise and never say "oops".

Units are always shown, always millimetres, always with the same number of decimals
within a column.

## The quality floor, unannounced

Keyboard focus visible on every control (a 1px `--heat` outline, offset 2px).
Reduced motion respected. Works down to 380px. Contrast: `--ink` on `--sheet` is
about 14:1; `--ink-dim` on `--sheet` about 7:1; `--heat` on `--sheet` about 5.6:1 —
never used for body text, only for controls and short labels at 12px+ semibold.
