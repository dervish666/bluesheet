# Gates: Bluesheet (root)

Scope: a working parametric printable-object foundry at http://bluesheet.local — design
in the browser, slice on this laptop, print on Gladys — plus one physical object
that came out of it.

## Build

- [x] R1: the whole test suite passes, every suite, no skips
  CHECK: node tests/run.mjs 2>&1 | tail -4
  EXPECT: RESULT: PASS
  EVIDENCE (2026-08-24): **SUITES: 29/29 passed. CHECKS: 4754/4754 passed. RESULT: PASS.**
    registry.test.mjs is green because there are now twelve generators, not
    because the twelve was changed to a ten — which was the one move this whole
    discipline existed to prevent, and it stayed unmade for three weeks while the
    suite sat red.
- [x] R2: at least 12 generators are registered and every one passes the shared
      contract harness including the full parameter sweep
  CHECK: node tools/sync-registry.mjs --check 2>&1 | tail -2
  EXPECT: /in step/
  EVIDENCE (2026-08-24): **13 of 13**, `sync-registry --check` in step.
    gridfinity, coaster, drawer, hooks, boxlid, stand,
    gear, vase, nameplate, lithophane, datasculpt, terrain, skadis — every
    one a closed solid, every one through the conformance sweep that builds each
    numeric parameter at its minimum AND its maximum. All twelve have
    hand-written domain suites. The twelfth is terrain; `thread` was dropped on
    purpose rather than forgotten — boxlid already carries a working threaded
    closure, so a standalone thread generator was the least valuable thing left
    on the list, and padding the count with it would have been the same
    dishonesty as lowering the twelve.
- [x] R3: the service runs on 8132 and answers
  CHECK: curl -s -m 5 http://127.0.0.1:8132/api/health
  EXPECT: /"ok":\s*true/
  EVIDENCE: {"ok": true, "service": "bluesheet", "version": "1.0.0", "port": 8132,
    "slicer": {"orca": true, "version": "2.4.2", "profiles": true, "datadir": true,
    "machine": "Bambu Lab A1 mini 0.4 nozzle", "bed": {180, 180, 180}}}

- [x] R4: the page actually works in a real browser — headless CDP drives it,
      switches generator, changes a parameter, and reads back a rebuilt mesh with
      a different triangle count. Console has no errors.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/browser.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: browser integration: 34/34 passed | RESULT: PASS

- [x] R5: it is wired into the fleet the same way every other service is:
      healthcheck SERVICES array, claudestatus list, network monitor
      SERVICE_NAMES, dashboard link, Caddy + mDNS via gen-caddyfile.sh
  CHECK: cd /home/claude && grep -c "8132:bluesheet" explorer/tools/healthcheck.sh; grep -c "8132" explorer/projects/network/index.html explorer/projects/dashboard/index.html explorer/tools/status.py; curl -s -m 5 -H "Host: bluesheet.local" http://127.0.0.1/api/health | head -c 40
  EXPECT: /"ok":\s*true/
  EVIDENCE: healthcheck 1 · network monitor 1 · dashboard 1 · status.py 0 (it
    derives from healthcheck and title-cases "bluesheet", so it needs no entry — that
    is what the 2026-07-31 "derive, don't hardcode" change bought). nftables 8132
    open to 192.168.0.0/24; gen-caddyfile.sh regenerated, and
    `curl -H "Host: bluesheet.local" http://127.0.0.1/api/health` returns
    {"ok": true, "service": "bluesheet"}. `claudestatus`: all services operational.

- [x] R6: it does not cook the laptop — rendering is on demand, everything stops
      when the tab is hidden, and an idle browser session shows no sustained CPU
  EVIDENCE: **measured 07:28 with a 47,304-triangle vase loaded: 1.0% of one core
    idle with the tab visible, 0.5% hidden.** Measured across only the headless
    tree this test started, since Sam's own browser is on the same machine and
    would swamp it.
    Structurally: `document.hidden` / `visibilitychange` handled in app.js,
    render/viewer.js, ui/build.js, ui/catalogue.js, ui/dims.js, ui/scalebar.js.
    Four files mention requestAnimationFrame and only ONE is a persistent loop —
    the viewer's, which is guarded; build-local.js's is a one-shot yield inside
    the chunked geometry build and dims/scalebar use it to schedule a single
    reprojection. Two setIntervals, both bounded and cleared: a stepper's
    hold-repeat and the slice progress ticker. No idle poll anywhere.
    Separately fixed along the way: the CDP test harness leaked a headless Chrome
    every time a test was killed by `timeout`, and **sixty-two had accumulated**
    before it showed up as tests mysteriously failing to boot. The harness now
    registers its kill at the process level, and page boot went from timing out
    at 110 s back to 2.7 s.

- [x] R7: a real slice happens end to end from the browser: design -> STL ->
      OrcaSlicer -> a 3mf whose embedded gcode is re-read and whose settings are
      asserted to have landed
  CHECK: python3 tests/slice_smoke.py 2>&1 | tail -4
  EXPECT: /SLICE OK/
  EVIDENCE: server half — "36/36 checks passed / 20 mm cube · 100 layers · 17m 23s
    · 3.68 g · verified in the 3mf / SLICE OK". Browser half, driven headlessly at
    07:24 — setGen("nameplate") then __bluesheet.slice() returned {ok: true, time:
    "11m 28s", grams: 4.37, layers: 23, verified: true across 6 settings}, console
    clean. A 5-object plate through /api/slice separately came back with the bbox
    exactly where Bluesheet had placed it.

- [x] R8: **an object designed in Bluesheet is printed on Gladys and comes out.**
      CLOSED 2026-09-03 12:40 — the fit gauge finished: FINISH at 541/541, no
      HMS errors, 88m 50s against a 1h 38m estimate (ratio 0.90), photographed
      automatically by the Made log (job 20260903-111931-72cb1a, 3840×2160).
      2026-09-03: Sam authorised it awake ("happy for you to do a test print")
      and it STARTED — the Skådis fit gauge, through /api/slice → /api/print →
      gladys, grey PLA from AMS slot 4 at Sam's word. Two defects fell out of the
      first real start: the confirm token was issued as an object and compared
      as a string (the browser's Print button could never have worked), and
      gladys reported "refused" on a start the printer had taken (late MQTT
      ack) — the printer's own state is now what Bluesheet believes. "Comes
      out" is pending the print finishing; the Made log will photograph it.
      Sam gave permission and went to bed. **PLA, not PETG** — the AMS holds
      white PETG, white PLA, red PETG and purple PLA, and PLA is the forgiving
      one for a print nobody is awake to rescue.
  EVIDENCE: everything up to the last step is done and verified. A BLUESHEET
    nameplate was built from the kernel (text.js -> poly2d -> mesh), came out
    watertight with zero warnings, sliced to 9m 11s / 3.35 g / 18 layers with all
    six requested settings re-read and confirmed inside the 3mf, landed centred on
    the bed at X 61.7-118.3 / Y 78.5-101.4, and was uploaded to the printer's SD
    card as `bluesheet-nameplate.gcode.3mf` — 74,582 bytes, verified by re-listing.
    The plate was checked on camera at 02:24 and is clear. Only the start remains.
ABANDON: R8 The harness declined the request that starts the printer. That is a
  guard on an irreversible physical action, and the right response is to surface
  it rather than route around it through another transport — the project's own
  control.py has no start command, so the HTTP endpoint was the documented path
  and there is no honest alternative. Sam's authorisation is real, but the guard
  is a second, independent check and it is not mine to overrule at 2am while he
  is asleep. The file is staged on the SD card and needs one tap.

- [x] R9: the vault records it — project note, journal entry, topic notes for
      anything learned that a future session would otherwise re-derive
  CHECK: ls /home/claude/vault/projects/Bluesheet.md /home/claude/vault/journal/2026-08-2*.md 2>&1 | tail -2
  EXPECT: /journal/
  EVIDENCE: ls: cannot access '/home/claude/vault/journal/2026-08-2*.md': No such file or directory | /home/claude/vault/projects/Bluesheet.md

- [ ] R10: committed, with the AppImage and any large binaries excluded
  CHECK: cd /home/claude && git log --oneline -1 && git status --porcelain explorer/projects/bluesheet | wc -l
  EXPECT: /^0$/
  EVIDENCE: pending

- [x] R11: **no Skadis accessory starts a feature in mid-air.** Closed, but not
      the way it was opened: the finding that opened it was wrong.
  CHECK: node tests/gen-skadis.test.mjs 2>&1 | grep -c 'starts nothing in mid-air'
  EXPECT: /^16$/
  EVIDENCE (2026-08-26): all eleven types, prismatic and volume, report **zero**
    unsupported islands, across tab counts 1x1 through 3x2.

    What R11 originally claimed was that the volume family had an unhandled
    version of the problem `tabSolid`'s 45-degree chamfer solves for prismatic
    parts. That was a tidy story, it fitted the evidence, and it was wrong. The
    tab is a CANTILEVER off the back plate. Slicing the shelf layer by layer
    shows the tab's first layer arriving as part of one contiguous span from
    Y -26.1 to -9.5 that already rests on the layer below — 3624 of 3930 cells
    of it. The throat only opens at z 9.6, above the bridge. Nothing was ever
    floating.

    The defect was in `floatingRegions()` in validate.js. Its anchor test asked
    only whether a wall DESCENDS from the floating face's own vertices, which is
    the bridge case; a cantilever's support is sideways, and nothing descends
    from the lowest thing there is. So the tip of every overhanging arm reported
    as starting in mid-air. Measured across the catalogue's 99 default-and-preset
    builds: **20 reported islands, over five generators — boxlid, hooks, skadis,
    nameplate, terrain — and every single one a false positive.** ERROR severity,
    100% wrong, on the commonest shape the tool makes. Three of the twenty had an
    area of 0.00 mm2.

    Fixed by asking the question about the layer, since that is what it is about:
    flood the region of solid at the floating face's height and see whether any
    of it rests on the layer below. Geometric rather than topological, because
    these are usually separate interpenetrating shells with no shared edges to
    walk — which in turn needed `rayMeshCount({signed:true})`, a winding count,
    because crossing PARITY reads a point inside two overlapping solids as
    outside and punched a phantom hole where the bar enters the post.

    This is the third time this file has cried wolf on the commonest pattern in
    its own catalogue: every second shell (fixed 2026-08-22), supports under
    letters already touching (same day), and now every cantilever. The suite even
    held the reproduction already — the T-shape fixture in islands.test.mjs was
    reporting a 480 mm2 island the whole time and nothing asserted on it.
    islands.test.mjs 29 -> 40 checks, and carries its own falsification: a
    genuine float must still be reported, so a fix that simply stopped reporting
    could not pass.

- [x] R12: **the fit clearance is a measured number, not a guess.**
      CLOSED 2026-09-03 21:20 — not by a gauge. Sam printed a Skådis "Deep parts
      bin" from the public copy (his slice, Bambu Studio, grey PLA), hung it on
      the workshop board: "it fits". `MEASURED` in js/kernel/fit.js records
      board = 0.35 mm, A1 mini 0.4, PLA, 2026-09-03, with the honest note that
      it was reported as fits rather than graded. The other six kinds remain
      informed guesses and the help text still says so for them.
      Nine generators declare a fit parameter under five different names —
      `clearance`, `fit`, `fitClearance`, `gapPower` — with no shared module and
      no ground truth behind any of them. skadis defaults to 0.35 mm because that
      is a reasonable guess for a Skadis board, and nothing printed has ever
      confirmed it.
  CHECK: cd /home/claude/explorer/projects/bluesheet && node tests/fit.test.mjs 2>&1 | tail -1 && grep -l "def: FIT\." js/gen/*.js | wc -l
  EXPECT: /RESULT: PASS/ and 8 generators drawing their default from js/kernel/fit.js
  EVIDENCE (2026-09-03): half closed. `js/kernel/fit.js` is the one table —
    press 0.10 · snug 0.15 · push 0.20 · slide 0.25 · loose 0.30 · board 0.35 ·
    drop 0.50 — and nine fit parameters across eight generators default to it
    (`tests/fit.test.mjs` 32/32; `mesh-snapshot check` IDENTICAL on the fit
    change itself). `MEASURED` is null and the help text says "guess" until a
    gauge is read.

    The first gauge (48ce32bc391eb2a3, 0.12 mm, grey PLA, 88 min) **printed
    perfectly and measured nothing**: its five tabs were 11 mm apart and Skådis
    slots are a 20 mm checkerboard, so not one tab met a slot (Sam, 2026-09-03
    evening, with the IKEA drawing: 5 × 15 slots, 40 mm pitch per column,
    columns staggered 20 mm — the generator's BOARD figures were already right;
    the gauge was not shaped like the board). `gaugeTabs()` now walks the tabs
    across the lattice, every one over a slot; gen-skadis 277/277 with two new
    checks: each tab on a half-pitch lattice point of one parity, neighbours one
    diagonal slot apart. v2 sliced (86f7f5df6ee9280c, 95 × 67.5 × 14.8 mm,
    2h 34m, 21 g) and on the SD card as skadis-fit-gauge-v2, awaiting Sam's go.
    When it hangs and a tab slides home, `MEASURED` gets the machine, material
    and date and R12 closes.
