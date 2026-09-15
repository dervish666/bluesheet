"""Bluesheet's Python side: OrcaSlicer, the printer, and everything the browser cannot do.

The browser owns geometry (js/kernel, js/gen); this package owns the three things
that need a filesystem, a subprocess or a socket:

    slicer.py    drives the OrcaSlicer AppImage and *verifies* what it produced
    threemf.py   re-reads a sliced 3mf — the only source of truth about a slice
    gcode.py     turns the embedded toolpaths into something a viewer can draw
    printer.py   uploads to the A1 mini's SD card, and refuses to start a print
    library.py   saved designs
    elevation.py real-world terrain for the terrain generator
    fonts.py     the bundled TTFs

server.py at the project root is the HTTP surface over these. It is a *package*
sharing a name with that module: Python's finder prefers the package, so
`import server.slicer` from inside server.py resolves here and never re-imports
the entry point.
"""

VERSION = "1.0.0"
