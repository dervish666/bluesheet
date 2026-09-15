# Gates: S1 — server.py + server/ (the Python side: slice, print, library)

Scope: everything the browser cannot do — running OrcaSlicer, talking to the
printer, and keeping saved designs.

- [x] G1: the service starts on 8132 and answers health
  CHECK: (fuser -k 8132/tcp 2>/dev/null; sleep 1; nohup python3 server.py > /tmp/bluesheet-gate.log 2>&1 & sleep 3; curl -s -m 5 http://127.0.0.1:8132/api/health)
  EXPECT: /"ok":\s*true/
  EVIDENCE: {"ok": true, "service": "bluesheet", "version": "1.0.0", "port": 8132, "host":
    "<host>", "uptimeSec": 3.0, "python": "3.13.5", "slicer": {"orca": true,
    "profiles": true, "datadir": true, "machine": "Bambu Lab A1 mini 0.4 nozzle",
    "version": "2.4.2", ...}}

- [x] G2: it is a ThreadingHTTPServer and survives a slow request — two curls
      issued together, one to a deliberately slow endpoint, both return
  CHECK: grep -c ThreadingHTTPServer server.py
  EXPECT: /[1-9]/
  EVIDENCE: 3
    Behaviour measured rather than inferred, in tests/slice_smoke.py: while a
    forced slice held its thread, /api/health was polled continuously —
    "health answered 951 times during the slice", "slowest health response was
    11 ms while slicing", "the concurrent slice also succeeded". A blocked slicer
    also sheds load instead of parking threads: 8 simultaneous forced slices gave
    [503, 503, 503, 503, 503, 200, 200, 200] (MAX_QUEUED = 3).

- [x] G3: python unit tests pass
  CHECK: python3 tests/test_server.py 2>&1 | tail -3
  EXPECT: /OK|RESULT: PASS/
  EVIDENCE: 214/214 checks passed
            RESULT: PASS
    (`-v` prints every assertion; the default is quiet so the summary is greppable.)

- [x] G4: a real slice happens. POST a 20mm cube STL to /api/slice and get back a
      time estimate, a filament weight and a layer count that are all non-zero
      and physically sane (a 20mm cube at 0.2mm is ~100 layers, minutes not
      seconds, grams not kilograms). Verified by re-reading the produced 3mf, not
      by trusting the exit code.
  CHECK: python3 tests/slice_smoke.py 2>&1 | tail -5
  EXPECT: /SLICE OK/
  EVIDENCE: 38/38 checks passed
            20 mm cube · 100 layers · 17m 23s · 3.68 g · 0.20mm Standard @BBL A1M
            · verified in the 3mf
            SLICE OK
    Every number is read back out of Metadata/plate_1.gcode by threemf.summarize,
    and the layer count in the file is asserted equal to the one the API returned.

- [x] G5: the settings actually landed in the 3mf — layer height, infill and
      spiral mode are read back out of the embedded gcode and asserted, because
      OrcaSlicer drops unsupported settings silently (vase mode is the known
      case: a dropped spiral_mode gives a solid brick and a clean exit code)
  EVIDENCE: every slice returns a `verified` array read from the produced file:
    [{layer_height want 0.2 got 0.2 ok}, {sparse_infill_density want 15% got 15% ok},
     {spiral_mode want 0 got 0 ok}, {enable_support want 0 got 0 ok},
     {wall_loops want 2 got 2 ok}, {filament_type want PLA got PLA ok}]
    and a vase slice reads back spiral_mode=1, wall_loops=1, 1.26 g against the
    solid slice's 3.68 g.
    The assertion is proved to FIRE, not just to be present, by an unmocked slice
    in slice_smoke.py: requesting spiral_mode through a raw override while the
    shell settings contradict it returns 422 —
      "the slicer dropped settings it did not report: sparse_infill_density wanted
       15%, file says 0%; wall_loops wanted 2, file says 1"
    which is also a correction to the vault note: 2.4.2 did not drop spiral_mode,
    it silently rewrote the neighbouring settings to suit it, and exited 0.

- [x] G6: no static-file leak. The handler must not serve anything outside the
      project directory and must not serve config/secret files inside it. Proven
      with path-traversal attempts and a request for any *.env / *secret* file.
  CHECK: python3 tests/security_probe.py 2>&1 | tail -4
  EXPECT: /SECURITY OK/
  EVIDENCE: 55/55 probes refused as they should be
            SECURITY OK
    The probe writes real decoy files first (bluesheet-probe-decoy.env at the root, a
    secret-named .txt and a token-named .js in published directories) because a
    404 for a file that does not exist proves nothing; it also asserts that an
    ordinary control file IS served, so the probe cannot pass by being blind.
    Covers traversal (encoded, double-encoded, absolute-form request line, NUL
    byte over a raw socket), dotfiles, .py sources, symlink escape, directory
    listing, OPTIONS/TRACE and cross-origin POST/DELETE.

- [x] G7: printing is gated. /api/print uploads to the SD card but NEVER starts a
      print without an explicit start:true plus a confirmation token, and the
      default is upload-only. A comment is not a guard: prove the default with a
      test that calls it with no start field and asserts nothing was started.
  EVIDENCE: tests/test_server.py drives the real handler with a spy in place of
    the printer (`python3 tests/test_server.py -v`):
      ok  DEFAULT DID NOT START
      ok  response says not started  {... 'uploaded': True, 'started': False}
      ok  truthy-not-true start 'true' does not start      (also 1, ['yes'], {'x':1})
      ok  start without a token is refused  409
      ok  wrong token refused
      ok  valid token starts the print  (200, {... 'started': True})
      ok  the spy saw exactly one start  ['cube20-testjob00000001.gcode.3mf']
      ok  token cannot be replayed
    The last three matter as much as the first: they show the test can detect a
    start, so "did not start" is a measurement and not a test that cannot fail.
    Starting also goes through gladys's held MQTT connection rather than opening
    a second one — the A1 mini allows exactly one client, and a print Bluesheet
    started behind gladys's back would be a print nothing was watching.

- [x] G8: slices are cached by content hash so moving one parameter and
      re-slicing an identical mesh does not re-run the AppImage
  EVIDENCE: id = sha256(canonical settings ‖ each STL's digest ‖ its placement),
    truncated to 16 hex. From slice_smoke.py:
      ok  same content gives the same id
      ok  second slice is served from cache
      ok  cache hit took 1 ms          (against 380–450 ms for a real slice)
      ok  the AppImage did not run again (3mf untouched)
    The last line is the deciding one: it compares job.3mf's mtime across the
    second request, so the claim is "the slicer did not run", not "it was fast".
    Cache hits are checked before the queue guard, so they are never rate-limited;
    the store is pruned to 40 jobs / 2 GB after each slice.

## Notes for the other leaves

- **Toolpaths** come back as `{layers: [{i, z, h, paths: [{type, pts:[x,y,…]}]}]}`
  in *printer* coordinates (0–180, origin front-left); `bed` and `typeNames` are in
  the payload, and `downsample` says exactly what was thinned. Types are short
  tokens (outer, inner, solid, sparse, top, bottom, bridge, support, skirt, brim,
  gap, ironing, prime, travel).
- **Plates**: send `objects: [{stl, x, y, rot}]` in plate coordinates (origin at
  the bed centre) with `arrange: false`, or pre-place in printer coordinates and
  send `frame: "bed"`. Overlaps, off-plate objects and anything larger than the
  bed are refused with the measurement, never silently scaled.
- The A1's purge line (Y = −2.5, X 68→113) is emitted *before* the first
  `; CHANGE_LAYER`, so ignoring everything before that marker excludes it; the
  parse reports `prologueMoves` (6 on a two-object plate) so the exclusion is
  visible. No coordinate filter is applied — that would eat real geometry near the
  front edge.
