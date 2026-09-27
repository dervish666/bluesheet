// Fit clearances — the one table every generator's "how loose" default comes from.
//
// Nine generators used to declare a fit under five different names, each with
// its own number and no record of where the number came from. They still have
// their own parameter (a drawer's drop-in gap and a letter's press fit are not
// the same question), but the DEFAULTS now come from here, so there is one
// place to read what Bluesheet believes about this printer's clearances and
// one place to correct it when a print says otherwise.
//
// Every value is in printed millimetres. `kind` names the fit you want; the
// number is what this machine needs to get it. The table is ordered tightest
// first.
//
// PROVENANCE. `MEASURED` lists the kinds a physical print has confirmed, each
// on a named machine, material and date; every other number here is an
// informed guess and the UI says so. The Skådis fit gauge (five tabs at
// −0.30 … +0.30 around `board`) is the print that measures that one: the tab
// that slides home without force names the board's number. The friction lid
// of a PCB case measured `press` the expensive way — a lid that rattled at
// the slide fit, reprinted at 0.10 and "fits it perfectly".

export const FIT = Object.freeze({
  press: 0.10,   // goes in by hand and stays: a friction lid's lip in its box (measured), an inlaid letter
  snug:  0.15,   // a firm push fit: a bore on a shaft, a dovetail key in its socket
  push:  0.20,   // drops in with a push and does not rattle: a prop in its socket
  slide: 0.25,   // slides freely with play you can feel: a tongue in a slot, a nut in its pocket — NOT a lid that must stay on
  loose: 0.30,   // clears a surface finish: a cable in its clip
  nested: 0.30,  // a print-in-place joint whose segments cup one another round
                 // the ball (creature nested seams, measured). Tighter than
                 // `free`: the big concentric cup and dome print cleanly closer.
  board: 0.35,   // a tab through a 5 mm pegboard slot (the gauge measures this one)
  free:  0.35,   // two faces printed against each other that must never fuse:
                 // a print-in-place joint (measured). Equal to `board` by
                 // coincidence, not derivation: the gauge happened to agree.
  drop:  0.50,   // drops in, per side: a tray in the drawer it was measured for
});

/** What has actually been printed and measured, one entry per kind. Add to
 *  this — and change nothing else — when a print settles a number. */
export const MEASURED = Object.freeze([
  Object.freeze({
    kind: 'board', value: 0.35,
    machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA (grey, AMS slot 4)',
    date: '2026-09-03',
    by: 'Sam: a Skådis "Deep parts bin" (tray, 2×2 tabs) sliced in Bambu Studio hung on the workshop board — "it fits"',
    note: 'Reported as fits, not graded snug/right/loose; the two gauges printed today measured nothing (the first was not shaped like the board, the second was never hung).',
  }),
  Object.freeze({
    kind: 'press', value: 0.10,
    machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA',
    date: '2026-09-15',
    by: 'Sam: the Pi 3 B+ PCB case lid (pcbcase, friction lid, 1.68 mm lip 3 mm deep in an 88 × 59 mm cavity), reprinted alone at 0.10 — "fits it perfectly"',
    note: 'The first lid, at the 0.25 slide default, "slightly rattles" — so a friction lid is a press fit on this machine, not a slide fit. Bracketed by one print each side: 0.25 loose, 0.10 right; 0.15 and 0.20 untried.',
  }),
  Object.freeze({
    kind: 'free', value: 0.35,
    machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA, Bambu Studio 0.20 mm Standard',
    date: '2026-09-23',
    by: 'Sam: the creature Joint gauge (six bodyR-9 segments, 2.7 mm balls, gaps 0.25 / 0.30 / 0.35 / 0.40 / 0.45) — "they all articulate apart from the smallest, the largest size is a bit rattly but still holds, about the middle works the best it seems"',
    note: 'Bracketed both sides: 0.25 fused, 0.30 moves, 0.35 best, 0.45 rattles but stays captive. Four earlier attempts failed off the bed (one detached, one spaghetti); a different reel of filament printed first time, so those were adhesion, not the gaps.',
  }),
  Object.freeze({
    kind: 'nested', value: 0.30,
    machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA, Bambu Studio 0.20 mm Standard',
    date: '2026-09-24',
    by: 'Sam: the creature "Joint gauge, nested seams" (six bodyR-9, 15 mm segments, gaps 0.25 / 0.30 / 0.35 / 0.40 / 0.45 on the ball, cup and dome) — "all the joints move, the very last one is a touch tight but still works, the next one up is perfect", and confirmed the last was 0.25 and the next 0.30',
    note: 'Bracketed on the tight side only: 0.25 tight but moving, 0.30 perfect; 0.35 to 0.45 all move, not graded. No step fused, against the open gauge where 0.25 fused.',
  }),
]);

/** The measurement for a kind, or null. */
export function measured(kind) {
  return MEASURED.find(m => m.kind === kind) || null;
}

/** The clearance for a named fit. Throws on a name that is not in the table,
 *  because a typo here would silently become a 0 mm press fit. */
export function fit(kind) {
  if (!(kind in FIT)) throw new Error(`fit(): unknown fit kind ${JSON.stringify(kind)}`);
  return FIT[kind];
}

/** One sentence for a help string: what the default is and whether anyone has
 *  ever measured it. */
export function fitNote(kind) {
  const v = fit(kind);
  const m = measured(kind);
  if (m) {
    return `${v.toFixed(2)} mm was measured on ${m.machine} in ${m.material} on ${m.date}.`;
  }
  return `${v.toFixed(2)} mm is Bluesheet's default for a ${kind} fit on a 0.4 mm nozzle — a guess until the fit gauge has been printed.`;
}

export default { FIT, MEASURED, fit, fitNote, measured };
