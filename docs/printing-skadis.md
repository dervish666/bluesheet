# Printing the Skadis accessories

Measured against the A1 mini profile (0.4 nozzle, 0.2 mm layers, PLA) at every
type's defaults. Numbers come from `printability()` in `js/kernel/validate.js`,
which is the same analysis the interface shows.

Written 2026-08-24; the mid-air-starts figures corrected 2026-08-26, when the
"defect" they described turned out to be a bug in the validator rather than in
the parts. See "The defect that was not there" below.

## The short answer

**Supports are not the problem, and rotating the parts does not help.** That was
the working assumption and the measurement disagrees with it.

Every accessory is already built in a print-aware orientation — `meta.orientation`
says so, and `tabSolid` chamfers the tab end cap at 45 degrees specifically so
the prismatic family can be printed without support under the tab. An
orientation sweep over nine rotations confirms the built-in choice is the best
one available:

- `peg`, `double`, `clip` — **no** rotation clears a 100 mm2 plate-contact bar.
- `jhook` — the only rotations that clear it take support from 505 to 1352 mm2.
- `longarm` — same shape of answer: 593 to 1197 mm2.
- `label`, `gauge` — as-built is already within a whisker of optimal.

What the arm family actually needs is **a brim**. A J-hook stands 55 mm tall on
71 mm2 of plate: `printability()` calls that "a 43:1 leverage on the first layer"
and it is the realistic failure mode, not overhang.

## What to do

| If you are printing | Do this |
|---|---|
| `gauge` | **Print this first.** Brim on. It exists to tell you your board's real clearance. |
| `peg` `jhook` `longarm` `double` `clip` | Brim on. Supports optional — 3-9.5% of surface, all of it short arm undersides. |
| `label` | Brim on. Effectively no support needed (0.6%). |
| `shelf` `tray` `cup` `toolplate` | Nothing special. Adhesion is excellent (1391-5623 mm2) and no supports are needed. |

## Print the fit gauge first

`fitClearance` defaults to **0.35 mm** and nothing printed has ever confirmed it.
IKEA publishes no dimensions for a Skadis board, which is why the board figures
are parameters rather than constants in the first place.

The gauge prints five tabs at five clearances (-0.30, -0.15, 0, +0.15, +0.30
against the nominal), marked 1 to 5. Hang it on the board, see which number is
snug, and that names the value for every other accessory. 16.6 g, 65 mm tall,
190 mm2 of plate contact, no mid-air starts. This closes gate R12.

## The defect that was not there

An earlier version of this document said the four volume types each started a
feature in mid-air, rated ERROR, and told you to switch on "support on build
plate only". **That was wrong, and the advice was wrong with it.** No supports
are needed. Corrected 2026-08-26.

The tabs are a cantilever off the back plate, not a floating feature. Slicing a
shelf layer by layer shows the tab's first layer arriving as part of one
contiguous span of solid that already rests on the layer below — 3624 of 3930
sampled cells of it. The throat that the board sits in only opens at z 9.6, well
above the bridge. Nothing was ever hanging.

What produced the false reading was `floatingRegions()` in `js/kernel/validate.js`.
Its anchor test asked only whether a wall descends from the floating face's own
vertices — true for a bridge, never true for a cantilever, whose support is
sideways and whose lowest face has nothing at all beneath it. Measured across the
catalogue's 99 default-and-preset builds, that misfire accounted for **every
island the tool had ever reported: 20 of 20, across five generators**, all at
ERROR severity. It is fixed (gate R11), and `islands.test.mjs` now carries the
cantilever cases plus a check that a genuine float is still caught, so a repair
that merely went quiet could not pass.

Worth stating plainly because it cuts both ways: the geometry was right the whole
time, and a confidently-wrong ERROR on the commonest shape a tool makes is how
people learn to scroll past its warnings.

## Every type, measured

| Type | Family | Plate contact | Height | Support area | Mid-air starts | Weight |
|---|---|---|---|---|---|---|
| `peg` | prismatic | 71 mm² | 55.0 mm | 354 mm² (7.1%) | 0 | 11.0 g |
| `jhook` | prismatic | 71 mm² | 55.0 mm | 505 mm² (8.7%) | 0 | 13.2 g |
| `longarm` | prismatic | 71 mm² | 55.0 mm | 593 mm² (9.5%) | 0 | 14.5 g |
| `double` | prismatic | 71 mm² | 55.0 mm | 588 mm² (9.5%) | 0 | 14.5 g |
| `clip` | prismatic | 71 mm² | 55.0 mm | 126 mm² (3.1%) | 0 | 7.6 g |
| `label` | prismatic | 184 mm² | 74.0 mm | 56 mm² (0.6%) | 0 | 17.5 g |
| `gauge` | prismatic | 190 mm² | 65.0 mm | 215 mm² (2.5%) | 0 | 16.6 g |
| `shelf` | volume | 5623 mm² | 22.5 mm | 99 mm² (0.5%) | 0 | 42.9 g |
| `tray` | volume | 5623 mm² | 50.0 mm | 98 mm² (0.2%) | 0 | 61.2 g |
| `cup` | volume | 1391 mm² | 70.0 mm | 107 mm² (0.5%) | 0 | 32.0 g |
| `toolplate` | volume | 5335 mm² | 22.5 mm | 99 mm² (0.6%) | 0 | 38.5 g |

"Support area" is surface leaning past 50 degrees. "Mid-air starts" is
`unsupportedIslands` — features with open air all the way to the plate.

Regenerate with `node tests/gen-skadis.test.mjs` (the printability section) or
the orientation sweep in the R11 gate notes.
