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
// PROVENANCE. `MEASURED` is null until a physical print has confirmed a value
// on a named machine, material and date; until then every number here is an
// informed guess and the UI says so. The Skådis fit gauge (five tabs at
// −0.30 … +0.30 around `board`) is the print that measures it: the tab that
// slides home without force names the board's number, and the difference from
// nominal is this printer's dimensional bias, which shifts the other kinds too.

export const FIT = Object.freeze({
  press: 0.10,   // goes in by hand and stays: an inlaid letter in its recess
  snug:  0.15,   // a firm push fit: a bore on a shaft, a dovetail key in its socket
  push:  0.20,   // drops in with a push and does not rattle: a prop in its socket
  slide: 0.25,   // slides freely with no play you can feel: a lid on its box
  loose: 0.30,   // clears a surface finish: a cable in its clip
  board: 0.35,   // a tab through a 5 mm pegboard slot (the gauge measures this one)
  drop:  0.50,   // drops in, per side: a tray in the drawer it was measured for
});

/** What has actually been printed and measured, or null. Update this — and
 *  nothing else — when a gauge comes off the plate. */
export const MEASURED = Object.freeze({
  kind: 'board', value: 0.35,
  machine: 'Bambu A1 mini, 0.4 mm nozzle', material: 'PLA (grey, AMS slot 4)',
  date: '2026-09-03',
  by: 'owner: a Skådis "Deep parts bin" (tray, 2×2 tabs) sliced in Bambu Studio hung on the workshop board — "it fits"',
  note: 'Reported as fits, not graded snug/right/loose; the two gauges printed today measured nothing (the first was not shaped like the board, the second was never hung).',
});

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
  if (MEASURED && MEASURED.kind === kind) {
    return `${v.toFixed(2)} mm was measured on ${MEASURED.machine} in ${MEASURED.material} on ${MEASURED.date}.`;
  }
  return `${v.toFixed(2)} mm is Bluesheet's default for a ${kind} fit on a 0.4 mm nozzle — a guess until the fit gauge has been printed.`;
}

export default { FIT, MEASURED, fit, fitNote };
