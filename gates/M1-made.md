# Gates: M1 — the Made log (server/made.py, js/ui/made.js)

Scope: Bluesheet should remember what it actually printed. Every job records the
generator, the parameters, the render, the slice estimate — and, once the print
finishes, a photograph of the real object from the workshop camera. The render
and the photograph side by side is the whole point.

- [x] G1: a job is recorded end to end — created on slice, updated on upload,
      completed when Gladys reports the print finished, with the real elapsed
      time and the estimate stored side by side
  CHECK: python3 tests/test_made.py 2>&1 | tail -3
  EXPECT: /OK|RESULT: PASS/
  EVIDENCE (2026-09-03): 57/57 · RESULT: PASS. `test_happy_path` drives
    slice → upload → RUNNING → FINISH through `Watcher.tick(snapshot)` with a
    fake clock and asserts actual 5900 s beside estimate 5912 s, timing
    "observed", events in order. Live: the Skådis fit gauge (job
    20260903-111931-72cb1a) went uploaded → printing with real telemetry.
    Three wiring defects fixed the same hour, none of which the module's own
    docstring could have caught: `made.start()` was never called from main();
    `record_upload` was never called from /api/print; the watcher matched on
    `<name>.gcode.3mf` while gladys reports the subtask name without an
    extension (`SD_SLICE_ID` + `_stem()` now accept both); and POST/DELETE
    were never routed to the module.

- [x] G2: the photograph is taken automatically. When a job's print completes,
      grab a frame from the workshop camera
      (http://localhost:8131/snapshot.jpg?hd=1) and store it against the job.
      Prove it by driving a fake completion and asserting a real JPEG landed.
  EVIDENCE (2026-09-03): `test_happy_path` — a fake completion produces a file
    under photos/ that starts FFD8, ends FFD9 and is over MIN_PHOTO_BYTES; the
    camera spy was called exactly once. The real photograph of the gauge is
    pending the print finishing (~12:50).

- [x] G3: it survives being wrong. If Gladys is unreachable, the camera is down,
      or the printer state jumps straight from PRINTING to IDLE, the job is
      marked with what is actually known rather than silently lost or stuck
      "printing" forever. Each of those three failures is tested by simulating it.
  EVIDENCE (2026-09-03): `test_gladys_unreachable` (stale at once, closed as
    unknown only after lost_after, a shorter blip clears when telemetry
    returns), `test_camera_down` (timing recorded first, photoError says why,
    two attempts, a retake later succeeds), `test_printer_jumps_to_idle` (one
    odd frame does not end a print, two do, the replacing file is named).
    Also found: the "joined mid-print" heuristic used percent > 2, and the A1
    reports 6% on layer 1 because warm-up counts — the real gauge start would
    have been marked inferred. Now decided by layer.

- [x] G4: the estimate is scored against reality — store predicted vs actual
      minutes and predicted vs actual grams (from Gladys telemetry where it is
      available), and expose the running accuracy, because a slicer estimate that
      is consistently 20% out is worth knowing about
  EVIDENCE (2026-09-03): `test_accuracy` — four prints at ratios 1.10, 1.20,
    1.15, 3.0 give a median 1.175 while the mean is over 1.5, so one abandoned
    print does not move the figure; grams are not scored until a part is
    weighed, and then enter with source "weighed". `test_telemetry_grams`: an
    untagged spool (remain 0, weight 0) yields None, never a number.

- [x] G5: the Made panel in the UI shows each job as a card: the render, the
      photo when there is one, the generator and parameters, the estimate against
      the actual, and a "make another" button that reloads those exact parameters
      into the editor. Driven and asserted in the browser.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/made.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE (2026-09-03): `js/ui/made.js`; `node tests/made.test.mjs` 45/45 against a
    private server on an ephemeral port seeded with all six states; "Make
    another" asserted via `__bluesheet.gen.id` and params; a fetch-count check
    fails if the refresh timer survives close.

- [x] G6: at least 20 checks across the two suites
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/made.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE (2026-09-03): 57 (test_made.py) + 45 (made.test.mjs) = 102.
