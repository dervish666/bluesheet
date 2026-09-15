# The first print — runbook

Written ahead of time so that when the generators land this is five minutes of
execution rather than five minutes of deciding.

## What

A **sampler plate**: several small objects from different generators on one
plate, so the first thing Bluesheet makes in the world is a physical contact sheet
of its own catalogue. In preference order, dropping from the bottom if time is
short:

1. **Gridfinity 1×1×6 bin** — the precision claim, made physical. If it stacks
   with a real baseplate the spec work is proven; if it does not, that is worth
   knowing too. ~45 min.
2. **A BLUESHEET nameplate** — proves the TrueType parser produced real outlines
   rather than a stroke font. ~15 min.
3. **A gear pair** — proves the involute is computed. They should turn. ~20 min.
4. **A cable clip** — the small useful thing. ~8 min.

Target: about an hour of printing, so it finishes with room to spare.

## Material

**PLA, AMS slot 2 (white) or slot 4 (purple).** Not PETG: this laptop has a
documented PETG stringing baseline, and nobody is awake to rescue a print that
strings. Confirmed at 21:09 that TPU is not loaded and the rest are.

## Steps

    cd bluesheet
    node tools/bluesheet.mjs list                      # what actually exists
    node tools/bluesheet.mjs plate docs/first-plate.json -o /tmp/first.stl --gap 4

Check the report it prints: watertight, fits bed, no overlap, sane grams.

    # slice through the service so the settings are verified inside the 3mf
    # (the endpoint re-reads Metadata/plate_1.gcode — never trust the exit code)

Then, before pressing anything:

- [ ] The plate is clear — look at the camera, do not assume.
- [ ] The gcode bounding box is on the bed, **filtering Y < 1** to exclude the
      A1's purge line, which extrudes at Y ≈ −2.5 after the first layer change.
- [ ] The filament in the slice matches the filament in the AMS slot.
- [ ] `print-watch` is armed **before** the print starts, not after.

Upload with the printer service's `sdcard.py`, then start via
`POST :8128/api/sd/print` with `confirm: true`, the file name, and the AMS
mapping. Note the printer hangs the TLS shutdown after a successful `STOR`, so
ftplib raises `TimeoutError` for a transfer that worked — verify by re-listing
and comparing byte counts, and never trust `storbinary`'s return either way.

## Authority

The print was authorised by the machine's owner, overnight and unattended. That
covers the stop authority as well: stop a print only if *visually certain* it
has failed — nothing on a suspicion. Anything short of certain is a message,
not an intervention.
