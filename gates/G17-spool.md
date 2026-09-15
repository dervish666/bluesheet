# Gates: G17 — js/gen/spool.js (Filament spool hardware)

Scope: The things a printer needs to keep printing: adapters, hubs, guides, dry-box parts. Printed by the machine, for the machine.

- [ ] G1: the suite passes
  CHECK: node tests/gen-spool.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: pending

- [ ] G2: the shared contract harness passes with zero sweep defects
  CHECK: node tests/gen-spool.test.mjs 2>&1 | grep 'parameter sweep'
  EXPECT: /builds, 0 defects/
  EVIDENCE: pending

- [ ] G3: at least 32 checks, of which at least 14 are domain-specific
  CHECK: node tests/gen-spool.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^(3[2-9]|[4-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: pending

- [ ] G4: a spool adapter that fits real spools, sized from measured numbers:
      bore diameter, hub width, and flange diameter, with presets for the common
      ones (Bambu 54 mm bore refill, Prusa, Polymaker, cardboard 52 mm). Assert
      the bore is the stated diameter plus the running clearance, not a press fit.
  EVIDENCE: pending

- [ ] G5: the family builds and each member does its job: roller hubs with a
      seat for a 608 bearing (assert 22 x 7 mm plus clearance), a PTFE filament
      guide sized to 4 mm OD tube, a desiccant basket with a stated open area
      percentage, a spool-end filament clip, and a wall or shelf spool holder
      with the load path stated.
  EVIDENCE: pending

- [ ] G6: tolerances are explicit and printable — every fit in the generator is
      declared as clearance / transition / interference in millimetres with a
      note on what it is for, and validate() rejects a combination that would
      produce a negative clearance.
  EVIDENCE: pending
- [ ] G7: at least 4 presets, each a recognisably different and useful object,
      named for what it is for rather than for its parameters.
  EVIDENCE: pending

- [ ] G8: hints() gives real slicing advice for this object and validate()
      catches a deliberately unprintable parameter set, both asserted in the test.
  EVIDENCE: pending
