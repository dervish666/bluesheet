# Bluesheet

A parametric printable-object foundry. Design in a browser, slice on the machine
it runs on, print on the printer in the cupboard.

There is a read-only public copy of the workshop — everything except the slicer,
the printer and the saved-design library — at https://scratch-it.co.uk/bluesheet

## What it is

A catalogue of *generators*: functions from a handful of numbers to a watertight
solid. Gridfinity bins, lithophanes, threaded jars, drawer dividers, terrain
tiles of real places, nameplates in real font outlines, gears that actually mesh,
data sculptures. Move the numbers, watch the solid rebuild, slice it, print it.

It is deliberately not CAD. There is no sketch plane and no constraint solver,
because the things worth printing at home are mostly not one-off shapes — they
are known shapes at your dimensions, and typing four numbers beats drawing.

## Running it

    python3 server.py            # then http://localhost:8132

Python 3.11+ and (for the tests) Node 18+. No pip install, no npm install — the
server uses only the standard library and the browser loads the ES modules
directly. Slicing and printing additionally want OrcaSlicer's AppImage and a
printer; everything else — the generators, the viewer, the analysis, the STL
export — works without either.

## Layout

    js/kernel/     the geometry: mesh, 2D polygons, builders, CSG, validation, STL, fonts,
                   plus scalar.js — the small helpers every generator shares
    js/gen/        one file per generator; index.js is the catalogue loader
    js/render/     WebGL2 viewer — solid, overhang, cross-section, gcode toolpaths
    js/ui/         the interface
    server/        Python: OrcaSlicer, gcode parsing, the printer, the library
    tests/         node tests/run.mjs runs everything, no dependencies
    gates/         the acceptance gates each part was built against
    docs/design.md the visual direction

## Running the tests

    node tests/run.mjs            # everything
    node tests/run.mjs gridfinity # one suite
    node tests/mesh.test.mjs      # or directly

    node tools/mesh-snapshot.mjs write   # fingerprint every generator's geometry
    node tools/mesh-snapshot.mjs check   # prove a refactor changed nothing

Every generator is held to the same executable contract in
`tests/lib/genconform.mjs`, which builds it at every parameter's minimum *and*
maximum and asserts the result is still a watertight solid resting on the plate.
A generator that only works at its defaults fails there.

## The rules the code follows

Millimetres, Z up, counter-clockwise winding seen from outside, positive volume.
Every generator returns a mesh already centred in X/Y with its base on z=0. No
npm dependencies, no build step, no frameworks — the browser loads the modules
directly and Node imports the same files for the tests.

## The plate

Several objects, one print. "Add to plate" puts the current object on it with
a quantity; "Show plate" packs them onto the bed (MaxRects, `js/kernel/pack.js`)
and shows the layout that will actually print; "Slice plate" sends them as
separate objects at those positions with the slicer's own arranging off. The
plate lives on the server (`/api/plate`) and survives a reload, and every
object put on it has its provenance hash registered.

## Terrain of any place

The terrain generator's "Elevation you supply" option gives a place search
(`/api/geocode`, Nominatim, cached, biased to the British Isles but not limited
to them — a bare "lat, lon" works too), coordinates, a square size in km and a
fetch; the server samples real Terrarium tiles and caches them under
`assets/elev/`.

## Slicing

OrcaSlicer's AppImage, driven headlessly. Four traps are documented in the vault
under "Headless slicing for Bambu printers" and every one of them is load-bearing;
read it before changing anything in `server/slice.py`. The short version: never
flatten a profile, overlays need their own `compatible_printers`, `--outputdir`
is prepended to `--export-3mf`, and vase mode fails *silently*. The 3mf is always
re-opened and its settings asserted, because the exit code lies.


## Publishing the public copy

The kernel, generators, viewer and analysis are pure browser code, so they
publish as static files; the plate, slicer, printer, saved designs, Made log
and geocoder need the Python server and are hidden in the public build.

    node tools/build-static.mjs ../scratch-it/public/bluesheet/app

The contract is `data-needs-server` on every control the server backs (the
build refuses to run if fewer than four are marked) and `css/static.css`,
which hides them when `<body class="is-static">`. The public copy lives at
https://scratch-it.co.uk/bluesheet (landing page) and /bluesheet/app/ (the
workshop). Renders for the landing page come from `tools/contact-sheet.mjs`.

## Fit clearances

Every generator's default clearance comes from one table, `js/kernel/fit.js`
(press 0.10 · snug 0.15 · push 0.20 · slide 0.25 · loose 0.30 · board 0.35 ·
drop 0.50 mm). `MEASURED` there records the one print that has confirmed a
value on a named machine, material and date; until it is set the help text
says the number is a guess. The Skådis fit gauge is the print that measures it.

## What is not in this repository

Runtime state is left out, because it belongs to one machine rather than to the
code: `state/` (the plate, the print log, the Made log and its photos),
`library/` (saved designs, which can embed the photograph a lithophane was made
from), and the elevation and geocoder caches. The server creates all of it on
first run.

## Licence

MIT — see `LICENSE`. The bundled fonts keep their own licences, which sit beside
them in `assets/fonts` and `assets/webfonts`.
