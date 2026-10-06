// datasculpt — a series of numbers becomes a solid you can hold.
//
// This is the generator that is about meaning rather than utility, and the one
// with the most prior art on this machine: [[projects/Core Sample]] records a
// 145 mm column of this laptop's own git history, printed on the A1 mini two
// metres away, and three findings that took three iterations to reach. All
// three are load-bearing here:
//
//   1. RANK-NORMALISE, never log-normalise. Daily churn spans 18..28,365 lines
//      and is savagely skewed; a log map parks three quarters of the days in
//      the middle of the radius range and every day comes out the same width.
//      Rank is immune to that, and immune to outliers, which is why it is the
//      default. `spreadPct()` below is how that claim is measured rather than
//      asserted.
//   2. EXCLUDE THE OUTLIER THAT DWARFS EVERYTHING. The initial commit was 47%
//      of all churn ever and flattened everything after it into noise. Here
//      that is the `outliers: 'trim'` rule — a far-outlier fence, applied only
//      when a handful of points are doing it.
//   3. NECKS SCALE ON gap**0.75, IN BOTH HEIGHT AND DEPTH. With sqrt, a 54-day
//      silence and a one-night gap look nearly identical, which throws away the
//      only part of the silhouette carrying meaning.
//
// And one thing the original object taught rather than was told: the printer's
// 60° overhang limit means a single active day after a long silence physically
// cannot build back to full width. Here that limit is a hard invariant of the
// output — the radius change between consecutive layers never implies a steeper
// wall than `maxOverhang`, achieved by RAMPING (stretching the transition in z)
// where there is height to spare and by CLIPPING the rise where there is not.
// hints() says which happened and how much of the object it changed.
//
// Pure, deterministic, DOM-free. No CSG: every solid here is built directly,
// including the engraved caption, so the output is a single closed shell.

import { Mesh, TAU } from '../kernel/mesh.js';
import {
  triangulate, boolean, circle, roundRect, rect, reverse, resample,
  ensureCCW, ensureCW, signedArea, bounds,
} from '../kernel/poly2d.js';
import { layoutText, loadFont } from '../kernel/text.js';
import { DEG, RAD, clamp, num } from '../kernel/scalar.js';

const clampInt = (v, lo, hi) => Math.round(clamp(v, lo, hi));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ---------------------------------------------------------------------------
// Series that mean something
// ---------------------------------------------------------------------------

/**
 * This laptop's git history: lines changed per day from the first commit
 * (2026-03-07) to 2026-08-20, `null` on the days nothing was committed. The
 * initial commit — 131,401 insertions importing a pre-existing home directory —
 * is excluded, per finding 2 above. 167 days, 53 of them awake, 18..28,365
 * lines, and one 54-day silence where the house move happened.
 */
export const GIT_CHURN = [
  541, 28365, 3248, 8544, 3456, 9381, 16228, 5502, 3438, 1318, 5666, 935,
  1895, 461, null, null, 421, null, null, 264, 1359, 885, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  7157, 1628, null, null, null, null, 532, 2301, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, 16478, 232, null, null, 477, null, 2719, 508, null, null,
  600, null, null, null, 45, 1175, 2204, 2684, null, null, null, null,
  null, 2566, null, null, null, null, null, null, 3211, 894, 225, 2071,
  1287, 372, 782, null, null, null, null, null, 578, 79, 2892, 4399,
  2731, 4287, 2502, 127, 1944, null, null, null, null, null, null, 3607,
  null, null, null, null, null, null, null, null, 2028, 18, 135,];

/**
 * Daily mean temperature in Bristol, 2025-08-01 to 2026-07-31, °C, from the
 * Open-Meteo ERA5 archive (51.45 N, 2.59 W). 365 days, -0.8 to 29.1 °C. A real
 * year, not a sine wave: the shape of a British winter is lumpy and that is the
 * point of printing it.
 */
export const BRISTOL_YEAR = [
  15.9, 16, 17.9, 18.3, 16.3, 16.6, 16.9, 17.2, 17.4, 19.3, 21.2, 23.8, 20, 19.4,
  21.3, 20.3, 19, 19.5, 19.6, 16.4, 15.9, 16.5, 18.5, 19.1, 20.5, 18.2, 16.7, 15.3,
  15.6, 16.1, 15.3, 15.3, 15.2, 16.4, 14.5, 15.2, 16.9, 18, 13.6, 14.1, 14.3, 12.6,
  12.3, 12.7, 13, 14.1, 13.8, 15.9, 17.9, 17, 15, 10.9, 9.1, 9.6, 10.9, 11.2,
  10.4, 12.2, 13.6, 11, 11.9, 13.6, 13.9, 16, 11.9, 12.2, 13.7, 13.2, 13.5, 11.3,
  12.8, 11.5, 9.2, 12.1, 12.2, 10.6, 11.3, 12.5, 11.8, 13.3, 12.8, 12.1, 10.8, 8.3,
  8.5, 8.6, 8.5, 11.3, 11.9, 10.2, 10.1, 13.3, 10.5, 8.8, 13.1, 14.2, 15, 14.1,
  12.2, 10.8, 11.1, 10.8, 12.2, 13.7, 13.3, 12.1, 11.5, 8.7, 4, 4.1, 3.4, 1.5,
  1, 6.5, 7.5, 6.3, 4.5, 3.4, 11.6, 9.4, 8.3, 5.5, 10.6, 7, 5.7, 6.4,
  6.3, 9.6, 11.1, 11.4, 12.6, 9.7, 9.4, 9.2, 6.5, 9.4, 10.6, 6.9, 6.8, 9.9,
  7.5, 6.7, 8.1, 9.2, 7.1, 4.3, 2.8, 3.3, 4.2, 5.5, 4.5, 4.2, -0.3, 4.2,
  2.7, 0.8, 0.1, -0.8, 1.6, 3.9, 4.7, 3.1, 1.3, 6.7, 9.6, 8.3, 3, 6.1,
  5.4, 6.1, 6.2, 7.5, 7.3, 7.6, 8.2, 6.5, 6.8, 5.9, 5.5, 7.7, 4.9, 5.2,
  7.2, 6.9, 6.2, 6, 5, 6.4, 7.7, 8.5, 8.5, 7.6, 7.8, 8.9, 9.4, 7.8,
  5.7, 2.6, 5.9, 6.5, 4, 3.7, 4.3, 7.9, 10.8, 10.7, 10.2, 11.2, 10.8, 10.7,
  10.7, 7.1, 9.6, 10.7, 9.7, 9.3, 10.5, 7.1, 7.6, 8.8, 9.2, 8.3, 8.9, 9.6,
  6, 5.3, 6.9, 8.4, 10.3, 11.7, 9.5, 8.2, 8.3, 7.9, 8.7, 10.2, 6, 6.4,
  8.8, 6.3, 6.8, 8.8, 10.7, 9.7, 7.7, 10.2, 10.6, 8.1, 8.1, 12.9, 14.1, 9.9,
  7.3, 8.2, 7.9, 7, 9.5, 12.1, 11.5, 11.3, 9.7, 8.7, 8.5, 8.5, 10.3, 11.7,
  11.4, 12.4, 12.9, 14.4, 10.8, 12.1, 15.4, 14, 12.2, 12.6, 12.3, 11, 10.3, 10.2,
  12.8, 13.5, 10.8, 9, 9.4, 10.5, 9, 9.1, 9.7, 10.3, 9.8, 12.8, 12.9, 15.7,
  18.6, 16.3, 19.2, 23.8, 25, 23.2, 20.5, 16.1, 16.2, 15.9, 15.6, 14.8, 14.4, 13.3,
  12.9, 13.1, 14.2, 13.2, 11.8, 11.9, 12.8, 15, 14.5, 16, 17.3, 17, 17.5, 18.4,
  18.2, 18.5, 20.2, 23.5, 25.5, 27.5, 29.1, 24.7, 21.6, 18.1, 16.8, 17, 17.4, 19.1,
  17.5, 18.2, 18.6, 19.2, 19.6, 22.7, 23.5, 26, 24.8, 23, 20.7, 20.5, 21.8, 22.3,
  22.9, 20.8, 19.7, 19.3, 20.9, 20.2, 21.3, 20.5, 18.6, 19.6, 18.5, 21.7, 20.6, 19.8,
  17.3,];

/**
 * Three beats of an ECG at 200 samples/second, built from the standard sum-of-
 * Gaussians PQRST model (McSharry et al. 2003) with textbook amplitudes and
 * widths: P +0.12 mV, Q -0.16, R +1.20, S -0.25, T +0.35. Synthesised rather
 * than recorded, because a recording of a heartbeat is somebody's medical data
 * and this is a bracelet.
 */
function makeEcg(beats = 3, perBeat = 60) {
  //          phase   amplitude  width
  const waves = [
    [-0.30, 0.12, 0.055],   // P
    [-0.06, -0.16, 0.012],  // Q
    [0.00, 1.20, 0.014],    // R
    [0.06, -0.25, 0.017],   // S
    [0.32, 0.35, 0.085],    // T
  ];
  const out = [];
  for (let b = 0; b < beats; b++) {
    for (let i = 0; i < perBeat; i++) {
      const t = i / perBeat - 0.42;          // one RR interval, R at t = 0
      let v = 0;
      for (const [mu, a, w] of waves) {
        const d = t - mu;
        v += a * Math.exp(-(d * d) / (2 * w * w));
      }
      out.push(Math.round(v * 1000) / 1000);
    }
  }
  return out;
}

export const HEARTBEAT = makeEcg();

// ---------------------------------------------------------------------------
// Statistics — the part that matters more than the shape
// ---------------------------------------------------------------------------

/** Anything that is not a finite number is a gap, not a zero. */
export function cleanSeries(input) {
  if (!Array.isArray(input)) return [];
  const out = new Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    out[i] = (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  return out;
}

/**
 * One series or several? A number[][] is taken as one lane per sub-array; a
 * flat series is split into `lanes` contiguous blocks, which is what makes
 * "a year, by season" a single paste rather than four.
 */
export function asLanes(input, lanes) {
  const n = Math.max(1, Math.round(lanes || 1));
  if (Array.isArray(input) && input.length && Array.isArray(input[0])) {
    return input.slice(0, 12).map(cleanSeries).filter(s => s.length);
  }
  const flat = cleanSeries(input);
  if (!flat.length) return [];
  const per = Math.floor(flat.length / n);
  if (per < 2) return [flat];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(flat.slice(i * per, i === n - 1 ? flat.length : (i + 1) * per));
  }
  return out;
}

/** Linear-interpolated percentile of an ASCENDING array. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const x = clamp(p, 0, 100) / 100 * (n - 1);
  const i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[n - 1];
}

/**
 * Reduce a long series to at most `maxN` samples by averaging blocks.
 *
 * A 2,000-point series on a 120 mm column is 0.06 mm per point — a third of a
 * layer, so 19 points in every 20 are geometry nobody can see or feel. Binning
 * is the honest response: the object says "eight days per bead" instead of
 * pretending to a resolution the nozzle does not have. A bin is a gap only when
 * every sample in it is a gap.
 */
export function binSeries(vals, maxN) {
  const n = vals.length;
  if (!(maxN >= 1) || n <= maxN) return vals.slice();
  const k = Math.floor(maxN);
  const out = new Array(k);
  for (let i = 0; i < k; i++) {
    const a = Math.floor(i * n / k);
    const b = Math.max(a + 1, Math.floor((i + 1) * n / k));
    let s = 0, c = 0;
    for (let j = a; j < b; j++) if (vals[j] !== null) { s += vals[j]; c++; }
    out[i] = c ? s / c : null;
  }
  return out;
}

/**
 * Map a series onto 0..1, preserving gaps as null.
 *
 * mode:
 *   rank    — position in the sorted order, ties sharing a midrank. Spends the
 *             radius range evenly on the data no matter how it is distributed,
 *             and cannot be moved by an outlier at all. The default, and the
 *             only one of the four that survived the Core Sample prints.
 *   linear  — value against the min/max. Truthful about magnitude, useless on
 *             anything skewed.
 *   log     — value against the min/max of its logarithm. The obvious answer to
 *             skew and the wrong one: see spreadPct.
 *   clipped — linear between two percentiles, everything beyond flattened onto
 *             the ends. Use when the tails are noise you want gone.
 *
 * outliers 'trim' excludes points beyond a far-outlier fence (q3 + 3·IQR) from
 * the DOMAIN — they still render, clamped to the end of the range — but only
 * when at most 5% of the series is doing it. One commit that is half the
 * history is an outlier; a fat tail is the data.
 */
export function normaliseSeries(vals, opts = {}) {
  const mode = opts.mode || 'rank';
  const clipPct = clamp(num(opts.clipPct, 5), 0, 45);
  const outliers = opts.outliers || 'trim';
  const t = new Array(vals.length).fill(null);
  const fin = [];
  for (const v of vals) if (v !== null) fin.push(v);
  const info = { mode, lo: 0, hi: 1, trimmed: 0, count: fin.length, flat: false };
  if (!fin.length) { info.flat = true; return { t, ...info }; }

  const sorted = fin.slice().sort((a, b) => a - b);
  let lo = sorted[0], hi = sorted[sorted.length - 1];

  if (outliers === 'trim' && mode !== 'rank' && sorted.length >= 8) {
    const q1 = percentile(sorted, 25), q3 = percentile(sorted, 75), iqr = q3 - q1;
    if (iqr > 0) {
      const fLo = q1 - 3 * iqr, fHi = q3 + 3 * iqr;
      let a = 0, b = sorted.length - 1;
      while (a <= b && sorted[a] < fLo) a++;
      while (b >= a && sorted[b] > fHi) b--;
      const dropped = sorted.length - (b - a + 1);
      if (dropped > 0 && dropped <= Math.max(1, Math.floor(sorted.length * 0.05))) {
        lo = sorted[a]; hi = sorted[b]; info.trimmed = dropped;
      }
    }
  }
  if (mode === 'clipped') { lo = percentile(sorted, clipPct); hi = percentile(sorted, 100 - clipPct); }

  info.lo = lo; info.hi = hi;
  if (!(hi > lo)) {
    info.flat = true;
    for (let i = 0; i < vals.length; i++) if (vals[i] !== null) t[i] = 0.5;
    return { t, ...info };
  }

  if (mode === 'rank') {
    // Midranks, so ten identical values get one radius rather than a staircase.
    const rank = new Map();
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++;
      rank.set(sorted[i], (i + j) / 2);
      i = j + 1;
    }
    const d = Math.max(1, sorted.length - 1);
    for (let i = 0; i < vals.length; i++) if (vals[i] !== null) t[i] = clamp(rank.get(vals[i]) / d, 0, 1);
    return { t, ...info };
  }

  if (mode === 'log') {
    // A series with zeros or negatives still has a shape; shift it into the
    // positive half-line rather than refusing, and say so through info.shift.
    const shift = lo > 0 ? 0 : 1 - lo;
    const l0 = Math.log(lo + shift), l1 = Math.log(hi + shift);
    info.shift = shift;
    const d = l1 - l0;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === null) continue;
      const v = Math.max(lo, Math.min(hi, vals[i]));
      t[i] = d > 0 ? clamp((Math.log(v + shift) - l0) / d, 0, 1) : 0.5;
    }
    return { t, ...info };
  }

  const d = hi - lo;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) continue;
    t[i] = clamp((vals[i] - lo) / d, 0, 1);
  }
  return { t, ...info };
}

/**
 * How much of the available range the middle 90% of the data actually occupies,
 * as a percentage.
 *
 * This is the measurement behind finding 1. Every normalisation puts the
 * extremes at 0 and 1, so comparing ranges tells you nothing; what separates
 * them is where everything ELSE lands. Rank spreads the middle 90% over 90% of
 * the range by construction. On a savagely skewed series log parks it in a
 * third of the range, and a third of a radius range is a column of beads you
 * cannot tell apart.
 */
export function spreadPct(t, lowP = 5, highP = 95) {
  const v = t.filter(x => x !== null && isFinite(x)).sort((a, b) => a - b);
  if (v.length < 2) return 0;
  return (percentile(v, highP) - percentile(v, lowP)) * 100;
}

/**
 * Turn a normalised series into beads and necks.
 *
 * Every value is a bead of span 1. Every run of k gaps is ONE neck of span
 * k**0.75 — sub-linear so a 54-day silence does not eat the object, super-
 * sqrt so it does not look like a one-night one. Leading and trailing gaps are
 * dropped: there is no silence before the data starts, only a foot that would
 * be too thin to print.
 */
export function layoutBeads(t, opts = {}) {
  const gapExp = num(opts.gapExp, 0.75);
  let a = 0, b = t.length - 1;
  while (a <= b && t[a] === null) a++;
  while (b >= a && t[b] === null) b--;
  const lead = a, tail = t.length - 1 - b;
  const beads = [];
  let maxGap = 0, points = 0, gaps = 0;
  for (let i = a; i <= b;) {
    if (t[i] !== null) { beads.push({ t: t[i], span: 1, gap: 0 }); points++; i++; continue; }
    let j = i;
    while (j <= b && t[j] === null) j++;
    const k = j - i;
    beads.push({ t: null, span: Math.pow(k, gapExp), gap: k });
    if (k > maxGap) maxGap = k;
    gaps++;
    i = j;
  }
  let total = 0;
  for (const bd of beads) total += bd.span;
  return { beads, maxGap, points, gaps, lead, tail, total };
}

/**
 * Bead radii in mm, including the neck rule.
 *
 * A neck pinches toward rLo in proportion to (gap / gapRef)**0.75, where gapRef
 * is the longest gap in the series but never less than 8 — so a series whose
 * worst silence is one sample gets a dimple, not a waist, and the depth of a
 * neck reads as an absolute duration rather than a relative one.
 */
export function beadRadii(beads, rLo, rHi, { neckDepth = 1, maxGap = 1, gapExp = 0.75 } = {}) {
  const r = new Float64Array(beads.length);
  for (let i = 0; i < beads.length; i++) if (beads[i].t !== null) r[i] = rLo + beads[i].t * (rHi - rLo);
  // Depth uses the SAME exponent as the span, which is the whole of finding 3:
  // a neck that is twice as long has to be twice as visible in both directions
  // or the silhouette stops carrying the duration.
  const gapRef = Math.pow(Math.max(maxGap, 8), gapExp);
  const mid = (rLo + rHi) / 2;
  for (let i = 0; i < beads.length; i++) {
    if (beads[i].t !== null) continue;
    let side = 0, c = 0;
    if (i > 0 && beads[i - 1].t !== null) { side += r[i - 1]; c++; }
    if (i + 1 < beads.length && beads[i + 1].t !== null) { side += r[i + 1]; c++; }
    const from = c ? side / c : mid;
    const f = clamp(Math.pow(beads[i].gap, gapExp) / gapRef, 0, 1) * clamp(neckDepth, 0, 1);
    r[i] = rLo + (from - rLo) * (1 - f);
  }
  return r;
}

/**
 * Sample the bead sequence as a continuous profile over u ∈ [0, 1].
 *
 * `smooth` is the fraction of a bead's span given over to the shoulder at each
 * join, so at 0 every bead is a cylinder with a hard step onto the next (the
 * Core Sample look: one visible ridge per day) and at 1 the profile is a
 * continuous curve through the bead values. The shoulder half-width is taken
 * from the SHORTER of the two beads, which is what stops a one-sample bead
 * between two long ones from being smoothed out of existence.
 */
export function profileSampler(beads, radii, smooth = 0.25) {
  const n = beads.length;
  if (!n) return () => 0;
  if (n === 1) return () => radii[0];
  const edge = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) { edge[i] = acc; acc += beads[i].span; }
  edge[n] = acc;
  const total = acc > 0 ? acc : 1;
  for (let i = 0; i <= n; i++) edge[i] /= total;
  const span = new Float64Array(n);
  for (let i = 0; i < n; i++) span[i] = edge[i + 1] - edge[i];
  const s = clamp(smooth, 0, 1) * 0.5;

  let hint = 0;                       // the callers walk u upward, so remember
  return (u0) => {
    const u = clamp(u0, 0, 1);
    let i = hint;
    if (i >= n) i = n - 1;
    while (i > 0 && u < edge[i]) i--;
    while (i < n - 1 && u >= edge[i + 1]) i++;
    hint = i;
    if (i < n - 1) {
      const w = s * Math.min(span[i], span[i + 1]);
      if (w > 0 && u > edge[i + 1] - w) {
        return lerp(radii[i], radii[i + 1], smoothstep((u - (edge[i + 1] - w)) / (2 * w)));
      }
    }
    if (i > 0) {
      const w = s * Math.min(span[i], span[i - 1]);
      if (w > 0 && u < edge[i] + w) {
        return lerp(radii[i - 1], radii[i], smoothstep((u - (edge[i] - w)) / (2 * w)));
      }
    }
    return radii[i];
  };
}

// ---------------------------------------------------------------------------
// The printer's physics
// ---------------------------------------------------------------------------

/**
 * Force every column of the radius field to obey the overhang limit.
 *
 * The rows ARE the print layers (the default vertical step is exactly
 * ctx.layerH), so this is not an approximation of what the printer will do with
 * the object — it is the same arithmetic. A wall that grows outward by dr over
 * one layer of height dz leans atan(dr/dz) from vertical; past about 60° the
 * new perimeter has more air than plastic under it and it droops.
 *
 * mode 'ramp'  — the flare starts LOWER, so the peak survives at the cost of
 *                filling in some of what was under it. R ≥ target everywhere,
 *                and the maximum radius is unchanged (nothing is invented above
 *                what the data asked for).
 * mode 'clip'  — the peak is cut back to what the layer below can carry. This
 *                is what the original Core Sample did, and the note in the vault
 *                argues it is the more honest of the two: a single busy day
 *                after a long silence genuinely cannot build back to full width.
 *
 * Returns statistics rather than only mutating, because hints() has to be able
 * to say that it happened.
 */
export function limitOverhang(rows, maxSlope, mode = 'ramp') {
  const nz = rows.length;
  const stats = { worstBeforeDeg: 0, worstAfterDeg: 0, corrected: 0, samples: 0, maxShiftMm: 0, mode };
  if (nz < 2) return stats;
  const n = rows[0].r.length;
  const k = Math.max(1e-6, maxSlope);

  for (let j = 0; j + 1 < nz; j++) {
    const dz = rows[j + 1].z - rows[j].z;
    if (!(dz > 0)) continue;
    const a = rows[j].r, b = rows[j + 1].r;
    for (let i = 0; i < n; i++) {
      const slope = (b[i] - a[i]) / dz;
      stats.samples++;
      if (slope > stats.worstBeforeDeg) stats.worstBeforeDeg = slope;
    }
  }
  stats.worstBeforeDeg = Math.atan(stats.worstBeforeDeg) * RAD;

  const before = mode === 'ramp' ? rows.map(row => Float64Array.from(row.r)) : null;
  if (mode === 'ramp') {
    for (let j = nz - 2; j >= 0; j--) {
      const dz = rows[j + 1].z - rows[j].z;
      const a = rows[j].r, b = rows[j + 1].r;
      const lim = k * dz;
      for (let i = 0; i < n; i++) { const need = b[i] - lim; if (need > a[i]) a[i] = need; }
    }
    for (let j = 0; j < nz; j++) {
      const a = rows[j].r, o = before[j];
      for (let i = 0; i < n; i++) {
        const d = a[i] - o[i];
        if (d > 1e-9) { stats.corrected++; if (d > stats.maxShiftMm) stats.maxShiftMm = d; }
      }
    }
  } else {
    for (let j = 1; j < nz; j++) {
      const dz = rows[j].z - rows[j - 1].z;
      const a = rows[j - 1].r, b = rows[j].r;
      const lim = k * dz;
      for (let i = 0; i < n; i++) {
        const cap = a[i] + lim;
        if (b[i] > cap) {
          const d = b[i] - cap;
          stats.corrected++; if (d > stats.maxShiftMm) stats.maxShiftMm = d;
          b[i] = cap;
        }
      }
    }
  }

  let worst = 0;
  for (let j = 0; j + 1 < nz; j++) {
    const dz = rows[j + 1].z - rows[j].z;
    if (!(dz > 0)) continue;
    const a = rows[j].r, b = rows[j + 1].r;
    for (let i = 0; i < n; i++) { const s = (b[i] - a[i]) / dz; if (s > worst) worst = s; }
  }
  stats.worstAfterDeg = Math.atan(worst) * RAD;
  stats.correctedPct = stats.samples ? stats.corrected / stats.samples * 100 : 0;
  return stats;
}

// ---------------------------------------------------------------------------
// Mesh primitives
//
// Everything here is built ring by ring rather than by cutting solids apart,
// so the output is one closed shell with no boolean anywhere near it. The 2D
// booleans that do run are confined to the caption, where they merge letters
// that touch before those letters ever become holes in a face.
// ---------------------------------------------------------------------------

/** Side wall between two equal-length rings of vertex indices. */
function wallStrip(mesh, lower, upper, outward = true) {
  const n = lower.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (outward) mesh.addQuad(lower[i], lower[j], upper[j], upper[i]);
    else mesh.addQuad(lower[j], lower[i], upper[i], upper[j]);
  }
}

/** Add a flat ring of 2D points at height z; returns the vertex indices. */
function addRing(mesh, ring, z) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = mesh.addVertex(ring[i][0], ring[i][1], z);
  return out;
}

/**
 * A closed solid of revolution-with-attitude: rows of per-angle radii stacked up
 * the z axis. Every horizontal section is single-valued in angle by
 * construction, which is what makes the column and the spiral spiral-mode
 * printable and what makes a self-intersection impossible however the data
 * behaves.
 */
function radialSolid(rows, thetas, { capBottom = true, capTop = true } = {}) {
  const m = new Mesh();
  const n = thetas.length;
  const cs = new Float64Array(n), sn = new Float64Array(n);
  for (let k = 0; k < n; k++) { cs[k] = Math.cos(thetas[k]); sn[k] = Math.sin(thetas[k]); }
  const base = new Array(rows.length);
  for (let j = 0; j < rows.length; j++) {
    base[j] = m.vertCount;
    const r = rows[j].r, z = rows[j].z;
    for (let k = 0; k < n; k++) m.addVertex(r[k] * cs[k], r[k] * sn[k], z);
  }
  for (let j = 0; j + 1 < rows.length; j++) {
    const lo = base[j], hi = base[j + 1];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      m.addQuad(lo + k, lo + k1, hi + k1, hi + k);
    }
  }
  if (capBottom) {
    const c = m.addVertex(0, 0, rows[0].z), lo = base[0];
    for (let k = 0; k < n; k++) m.addTri(c, lo + ((k + 1) % n), lo + k);
  }
  if (capTop) {
    const j = rows.length - 1, c = m.addVertex(0, 0, rows[j].z), hi = base[j];
    for (let k = 0; k < n; k++) m.addTri(c, hi + k, hi + ((k + 1) % n));
  }
  const ringXY = (j) => {
    const r = rows[j].r, out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = [r[k] * cs[k], r[k] * sn[k]];
    return out;
  };
  return { mesh: m, ringXY, bottomRing: ringXY(0), topRing: ringXY(rows.length - 1) };
}

/**
 * A flat horizontal face at height z, with holes, and with pockets sunk into it.
 *
 * `pockets` are shapes ([outer, ...counters]) that become engraved recesses:
 * the outer ring is a hole in the face, its wall drops to a floor `depth` below,
 * and each counter comes back UP as an island so that the middle of an O is
 * still there when you look at the print. Every ring is used verbatim in both
 * the face and the pocket, so the two always agree and the shell stays closed.
 */
function flatFaceWithPockets(mesh, outer, holes, pockets, z, depth) {
  const rings = [ensureCCW(outer)];
  for (const h of holes) rings.push(ensureCW(h));
  const cut = [];
  for (const p of pockets) {
    if (!p || !p.length || p[0].length < 3) continue;
    const o = ensureCCW(p[0]);
    const counters = p.slice(1).filter(r => r && r.length >= 3).map(ensureCCW);
    cut.push({ o, counters });
    rings.push(reverse(o));
  }
  const tri = triangulate(rings);
  const base = mesh.vertCount;
  for (const pt of tri.points) mesh.addVertex(pt[0], pt[1], z);
  for (let i = 0; i < tri.tris.length; i += 3) {
    mesh.addTri(base + tri.tris[i], base + tri.tris[i + 1], base + tri.tris[i + 2]);
  }

  for (const { o, counters } of cut) {
    const zf = z - depth;
    // Floor: material below, void above, so it faces up like the face it sits in.
    const ft = triangulate([o, ...counters.map(ensureCW)]);
    const fb = mesh.vertCount;
    for (const pt of ft.points) mesh.addVertex(pt[0], pt[1], zf);
    for (let i = 0; i < ft.tris.length; i += 3) {
      mesh.addTri(fb + ft.tris[i], fb + ft.tris[i + 1], fb + ft.tris[i + 2]);
    }
    // Pocket wall: normals point inward, into the void the letter cut.
    wallStrip(mesh, addRing(mesh, o, zf), addRing(mesh, o, z), false);
    for (const c of counters) {
      // The island inside a counter: its own top at face level and a wall that
      // faces outward, away from the material it is made of.
      const it = triangulate([c]);
      const ib = mesh.vertCount;
      for (const pt of it.points) mesh.addVertex(pt[0], pt[1], z);
      for (let i = 0; i < it.tris.length; i += 3) {
        mesh.addTri(ib + it.tris[i], ib + it.tris[i + 1], ib + it.tris[i + 2]);
      }
      wallStrip(mesh, addRing(mesh, c, zf), addRing(mesh, c, z), true);
    }
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// The caption
//
// build() is synchronous, so the bundled faces are parsed once at module load
// exactly as the nameplate generator does it. A face that will not load is a
// missing option, not a broken generator: the caption is dropped and validate()
// says which face went missing.
// ---------------------------------------------------------------------------

export const CAPTION_FONTS = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf',
    label: 'Sans Narrow', help: 'Condensed. Fits the longest caption into the space a data sculpture can spare.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf',
    label: 'Sans Mono', help: 'Fixed pitch and even stroke weight — the safest face at 3 mm and the right one for a caption that quotes numbers.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf',
    label: 'Rounded Bold', help: 'Heavy geometric. Thick strokes survive an engraving that a 0.4 mm nozzle has to cut.' },
];
export const DEFAULT_CAPTION_FONT = 'LiberationSansNarrow-Regular';

const FONTS = new Map();
const FONT_ERRORS = new Map();

/** Hand this module a .ttf so `captionFont: '<id>'` can use it. */
export function registerFont(id, data) {
  const font = data && typeof data.glyphIndex === 'function' ? data : loadFont(data);
  FONTS.set(id, font);
  FONT_ERRORS.delete(id);
  return font;
}
export function fontFor(id) {
  return FONTS.get(id) || FONTS.get(DEFAULT_CAPTION_FONT) || FONTS.values().next().value || null;
}
export function fontProblems() { return [...FONT_ERRORS.entries()].map(([id, why]) => `${id}: ${why}`); }

async function loadBundledFonts() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/fonts/', import.meta.url);
  for (const f of CAPTION_FONTS) {
    try {
      let bytes;
      if (isNode) {
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([import('node:fs'), import('node:url')]);
        bytes = readFileSync(fileURLToPath(new URL(f.file, dir)));
      } else {
        const res = await fetch(new URL(f.file, dir));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      }
      registerFont(f.id, bytes);
    } catch (e) {
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}

await loadBundledFonts();

/** Merge letters that touch, so two overlapping glyphs cut ONE pocket. */
function unionShapes(list) {
  const live = list.filter(s => s && s.length && s[0] && s[0].length >= 3);
  if (live.length <= 1) return live;
  const mid = live.length >> 1;
  const a = unionShapes(live.slice(0, mid));
  const b = unionShapes(live.slice(mid));
  if (!a.length) return b;
  if (!b.length) return a;
  return boolean(a, b, 'union');
}

/**
 * A caption as pocket-ready shapes, centred on the origin with the baseline
 * wherever the text needs it. Returns null when there is nothing to engrave.
 */
function captionPlan(p, capH, maxWidth) {
  const text = String(p.caption ?? '').trim();
  if (!text) return null;
  const font = fontFor(p.captionFont);
  if (!font) return null;
  const size = Math.max(1.2, capH);
  let laid;
  try {
    laid = layoutText(font, text, {
      size, align: 'center', vAlign: 'baseline', maxWidth: maxWidth > 0 ? maxWidth : 0,
      letterSpacing: size * 0.04, curveTolerance: 0.02, onMissing: 'skip',
    });
  } catch { return null; }
  if (!laid.shapes.length) return null;
  const merged = unionShapes(laid.shapes);
  if (!merged.length) return null;
  const b = bounds(merged.map(s => s[0]).flat().length ? merged.flat() : merged[0]);
  const cx = b.center[0], cy = b.center[1];
  const centred = merged.map(sh => sh.map(ring => ring.map(pt => [pt[0] - cx, pt[1] - cy])));
  return {
    shapes: centred, width: b.size[0], height: b.size[1],
    shrunk: laid.fit < 0.999, scaledTo: laid.fit, missing: laid.missing || [],
    text,
  };
}

/** Bend a flat caption around a circle: +x becomes counter-clockwise, +y outward. */
function arcCaption(plan, rBase, segLen = 0.8) {
  return plan.shapes.map(sh => sh.map(ring => {
    const dense = resample(ring, segLen);
    return dense.map(([px, py]) => {
      const a = px / rBase, R = rBase + py;
      return [R * Math.cos(a), R * Math.sin(a)];
    });
  }));
}

// ---------------------------------------------------------------------------
// Settings — one resolution of the parameters, shared by build, validate, hints,
// so those three can never disagree about what the object is.
// ---------------------------------------------------------------------------

const MIN_R = 0.9;            // mm — thinner than two extrusions is not an object
const MIN_BEAD_MM = 0.55;     // mm — below this a bead is invisible and unfeelable
const CAP_MARGIN = 2.2;       // mm of clear material around an engraved caption

function settings(p, ctx = {}) {
  const sf = num(ctx.segFactor, 1);
  const bed = ctx.bed || { x: 180, y: 180, z: 180 };
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const nozzle = clamp(num(ctx.nozzle, 0.4), 0.15, 1.2);
  const form = ['column', 'spiral', 'ring', 'ridge'].includes(p.form) ? p.form : 'column';
  const caption = String(p.caption ?? '').trim();

  const height = clamp(num(p.height, 120), 10, 300);
  const dia = clamp(num(p.dia, 46), 6, 300);
  const minPct = clamp(num(p.minPct, 34), 2, 98);
  const relief = clamp(num(p.relief, 6), 0.4, 60);

  // A caption on a column or a spiral needs somewhere flat to live, and the only
  // flat surface those forms have is a base. Asking for one therefore promotes
  // the base to a pedestal rather than silently doing nothing.
  const radial = form === 'column' || form === 'spiral';
  let base = ['none', 'disc', 'pedestal'].includes(p.base) ? p.base : 'disc';
  if (radial && caption && base !== 'pedestal') base = 'pedestal';
  let baseH = base === 'none' ? 0 : clamp(num(p.baseHeight, 4), 0.8, 40);
  if (radial) baseH = Math.min(baseH, height * 0.35);

  return {
    sf, bed, layerH, nozzle, form, radial,
    series: p.series,
    normalise: ['rank', 'linear', 'log', 'clipped'].includes(p.normalise) ? p.normalise : 'rank',
    clipPct: clamp(num(p.clipPct, 5), 0, 45),
    outliers: p.outliers === 'keep' ? 'keep' : 'trim',
    gapExp: clamp(num(p.gapPower, 0.75), 0.05, 2),
    neckDepth: clamp(num(p.neckDepth, 100), 0, 100) / 100,
    smooth: clamp(num(p.smooth, 25), 0, 100) / 100,
    lanes: clampInt(num(p.lanes, 3), 1, 8),
    height, dia, minPct, relief,
    sides: clampInt(num(p.sides, 6), 0, 24),
    fluteDepth: clamp(num(p.fluteDepth, 14), 0, 45) / 100,
    twist: num(p.twist, 90) * DEG,
    turns: clamp(num(p.turns, 10), 1, 60),
    innerDia: clamp(num(p.innerDia, 62), 20, 140),
    bandThick: clamp(num(p.bandThick, 3.2), 1.2, 30),
    bandWidth: clamp(num(p.bandWidth, 12), 2, 60),
    length: clamp(num(p.length, 140), 20, 300),
    laneWidth: clamp(num(p.laneWidth, 14), 2, 80),
    maxSlope: Math.tan(clamp(num(p.maxOverhang, 60), 5, 85) * DEG),
    maxOverhangDeg: clamp(num(p.maxOverhang, 60), 5, 85),
    overhangFix: p.overhangFix === 'clip' ? 'clip' : 'ramp',
    base, baseH,
    caption, captionSize: clamp(num(p.captionSize, 4.5), 1.5, 30),
    captionDepth: clamp(num(p.captionDepth, 0.6), 0.15, 4),
    captionFont: p.captionFont,
    captionMaxW: Math.max(20, bed.x - 34),
  };
}

/**
 * Series -> beads, in one place. `lanes` are pooled before normalising so that
 * two ridges side by side are measured against the same ruler; normalising each
 * lane on its own would make a flat lane and a wild one exactly as tall, which
 * is the same mistake as log-normalising, one dimension over.
 */
function prepare(s, maxBeads) {
  const lanes = s.form === 'ridge' ? asLanes(s.series, s.lanes) : [cleanSeries(
    Array.isArray(s.series) && s.series.length && Array.isArray(s.series[0])
      ? s.series.flat() : s.series)];
  const usable = lanes.filter(l => l && l.length);
  if (!usable.length) {
    return { lanes: [{ beads: [{ t: 0.5, span: 1, gap: 0 }], maxGap: 0, points: 0, gaps: 0, total: 1 }],
      norm: { mode: s.normalise, flat: true, trimmed: 0, count: 0 }, empty: true, binned: 1, spread: 0 };
  }
  const binned = usable.map(l => binSeries(l, maxBeads));
  const pooled = [];
  for (const l of binned) for (const v of l) pooled.push(v);
  const norm = normaliseSeries(pooled, { mode: s.normalise, clipPct: s.clipPct, outliers: s.outliers });
  const spread = spreadPct(norm.t);
  const out = [];
  let at = 0;
  for (const l of binned) {
    const t = norm.t.slice(at, at + l.length);
    at += l.length;
    out.push(layoutBeads(t, { gapExp: s.gapExp }));
  }
  const kept = out.filter(l => l.beads.length);
  return {
    lanes: kept.length ? kept : out.slice(0, 1),
    norm, spread, empty: false,
    binned: binned[0] ? binned[0].length : 0,
    inputLen: usable[0].length,
    binFactor: binned[0] && binned[0].length ? usable[0].length / binned[0].length : 1,
  };
}

/** Flat horizontal face; `up` picks which way the normals point. */
function addFlatFace(mesh, rings, z, up) {
  const t = triangulate(rings);
  const b = mesh.vertCount;
  for (const pt of t.points) mesh.addVertex(pt[0], pt[1], z);
  for (let i = 0; i < t.tris.length; i += 3) {
    if (up) mesh.addTri(b + t.tris[i], b + t.tris[i + 1], b + t.tris[i + 2]);
    else mesh.addTri(b + t.tris[i], b + t.tris[i + 2], b + t.tris[i + 1]);
  }
  return t.points.length;
}

/**
 * Segment counts. The vertical step defaults to exactly ctx.layerH, so at normal
 * quality one row of the mesh IS one printed layer and the overhang limiter
 * below is doing the printer's arithmetic rather than an approximation of it.
 */
function resolution(s, stackH) {
  const sf = clamp(s.sf, 0.25, 4);
  const cells = Math.round(80000 * sf);
  const nTheta = s.form === 'spiral'
    ? clampInt(160 * sf, 48, 480)
    : clampInt(Math.max(72, s.sides * 14) * sf, 24, 400);
  const nZ = clampInt(stackH / (s.layerH / sf), 12, Math.max(12, Math.floor(cells / nTheta)));
  return { nTheta, nZ, dz: stackH / nZ, cells };
}

// ---------------------------------------------------------------------------
// column and spiral — one radius field, two ways of walking the series through it
// ---------------------------------------------------------------------------

function radialField(s) {
  const pedH = s.base === 'pedestal' ? s.baseH : 0;
  const discH = s.base === 'disc' ? s.baseH : 0;
  const stackH = Math.max(4, s.height - pedH);
  const bodyH = Math.max(2, s.height - pedH - discH);
  const res = resolution(s, stackH);
  const { nTheta, nZ } = res;

  const isSpiral = s.form === 'spiral';
  const pathSamples = isSpiral ? nTheta * s.turns : nZ + 1;
  const maxBeads = Math.max(2, Math.min(
    Math.floor(pathSamples / (isSpiral ? 4 : 3)),
    Math.floor((isSpiral ? s.turns * Math.PI * s.dia : bodyH) / (isSpiral ? 1.2 : MIN_BEAD_MM))));
  const prep = prepare(s, maxBeads);
  const lane = prep.lanes[0];

  let rLo, rHi, coreR = 0;
  if (isSpiral) {
    coreR = Math.max(2.5, s.dia / 2 - s.relief);
    const reliefEff = Math.max(0.5, s.dia / 2 - coreR);
    rLo = reliefEff * s.minPct / 100;
    rHi = reliefEff;
  } else {
    rHi = Math.max(MIN_R + 0.2, s.dia / 2);
    rLo = Math.max(MIN_R, rHi * s.minPct / 100);
  }
  const radii = beadRadii(lane.beads, rLo, rHi,
    { neckDepth: s.neckDepth, maxGap: lane.maxGap, gapExp: s.gapExp });
  const prof = profileSampler(lane.beads, radii, s.smooth);

  const thetas = new Float64Array(nTheta);
  for (let k = 0; k < nTheta; k++) thetas[k] = TAU * k / nTheta;
  const rows = new Array(nZ + 1);
  const fd = s.sides >= 1 ? s.fluteDepth : 0;
  const pitch = isSpiral ? bodyH / s.turns : 0;

  for (let j = 0; j <= nZ; j++) {
    const z = pedH + stackH * j / nZ;
    const u = clamp((z - pedH - discH) / bodyH, 0, 1);
    const amp = discH > 0 ? smoothstep((z - pedH) / discH) : 1;
    const r = new Float64Array(nTheta);
    if (isSpiral) {
      const zb = (z - pedH - discH) / pitch;
      for (let k = 0; k < nTheta; k++) {
        const frac = thetas[k] / TAU;
        const kf = zb - frac;
        const kk = Math.round(kf);
        const sPos = (kk + frac) / s.turns;
        let d = 0;
        if (sPos >= 0 && sPos <= 1) {
          const band = 0.5 * (1 + Math.cos(TAU * (kf - kk)));
          d = prof(sPos) * band * amp;
        }
        r[k] = coreR + d;
      }
    } else {
      const rb = prof(u), tw = s.twist * u;
      for (let k = 0; k < nTheta; k++) {
        const a = thetas[k] - tw;
        r[k] = rb * (1 - amp * fd * (1 - Math.cos(s.sides * a)) / 2);
      }
    }
    rows[j] = { z, r };
  }

  // The foot flares the first few millimetres outward so a 3 mm neck at the
  // bottom of the series is not also the object's entire contact with the bed.
  // It only ever widens going DOWN, so it can never be the overhang.
  if (discH > 0) {
    let r0 = 0;
    for (let k = 0; k < nTheta; k++) if (rows[0].r[k] > r0) r0 = rows[0].r[k];
    const rFoot = r0 + discH * 0.8;
    for (let j = 0; j <= nZ; j++) {
      const t = (rows[j].z - pedH) / discH;
      if (t >= 1) break;
      const fr = rFoot - (rFoot - r0) * smoothstep(t);
      const r = rows[j].r;
      for (let k = 0; k < nTheta; k++) if (fr > r[k]) r[k] = fr;
    }
  }
  for (let j = 0; j <= nZ; j++) {
    const r = rows[j].r;
    for (let k = 0; k < nTheta; k++) if (!(r[k] >= MIN_R)) r[k] = MIN_R;
  }

  const over = limitOverhang(rows, s.maxSlope, s.overhangFix);
  let maxR = 0, minR = Infinity;
  for (let j = 0; j <= nZ; j++) for (let k = 0; k < nTheta; k++) {
    const v = rows[j].r[k];
    if (v > maxR) maxR = v;
    if (v < minR) minR = v;
  }
  return { rows, thetas, over, prep, lane, res, pedH, discH, bodyH, maxR, minR, rLo, rHi, coreR, radii, prof };
}

function buildRadial(s) {
  const f = radialField(s);
  const plan = f.pedH > 0 ? captionPlan(s, s.captionSize, s.captionMaxW) : null;
  const solid = radialSolid(f.rows, f.thetas, { capBottom: f.pedH === 0, capTop: true });
  if (f.pedH === 0) return { mesh: solid.mesh, field: f, plan: null };

  const capH = plan ? Math.min(s.captionSize, plan.height) : 0;
  const stripH = plan ? capH + 2 * CAP_MARGIN : 0;
  const pad = clamp(f.maxR * 0.28, 4, 14);
  const halfY = f.maxR + pad + stripH / 2;
  const halfX = Math.max(f.maxR + pad, plan ? plan.width / 2 + pad : 0);
  const dy = stripH / 2;

  const ped = new Mesh();
  const outer = roundRect(2 * halfX, 2 * halfY, Math.min(halfX, halfY, 4) * 0.8,
    { segs: Math.max(3, Math.round(5 * s.sf)) });
  const hole = solid.bottomRing.map(([x, y]) => [x, y + dy]);
  const depth = Math.min(s.captionDepth, f.pedH * 0.4);
  const pockets = plan
    ? plan.shapes.map(sh => sh.map(r => r.map(([x, y]) => [x, y - halfY + stripH / 2])))
    : [];
  addFlatFace(ped, [ensureCCW(outer)], 0, false);
  wallStrip(ped, addRing(ped, outer, 0), addRing(ped, outer, f.pedH), true);
  // The column's own bottom ring is the hole in the pedestal's top face, so the
  // two are one shell rather than two solids resting on each other. Nothing
  // closes the hole: the column's first wall row is the other half of it.
  flatFaceWithPockets(ped, outer, [hole], pockets, f.pedH, depth);

  return { mesh: Mesh.merge([ped, solid.mesh.translate(0, dy, 0)]), field: f, plan, pedestal: { halfX, halfY, stripH } };
}

// ---------------------------------------------------------------------------
// ring — the series as the outer edge of something you can wear
// ---------------------------------------------------------------------------

function buildRing(s) {
  const rIn = s.innerDia / 2;
  const cham = Math.min(0.9, s.bandThick * 0.28, s.bandWidth * 0.22);
  // The caption lives on the guaranteed-flat part of the top face — the band
  // between the bore and the thinnest the data ever gets — with 0.7 mm of clear
  // material each side of the letters so the engraving never breaks the edge.
  const flatBand = s.bandThick - 2 * cham;
  const capH = Math.min(s.captionSize, flatBand - 1.4);
  const rTextMid = rIn + s.bandThick / 2;
  const plan = (s.caption && capH >= 1.5)
    ? captionPlan(s, capH, TAU * rTextMid * 0.92) : null;

  const circumference = TAU * (rIn + s.bandThick + s.relief);
  const nPhi0 = clampInt(circumference / 0.5 * clamp(s.sf, 0.25, 4), 120, 1600);
  const maxBeads = Math.max(2, Math.min(Math.floor(nPhi0 / 3), Math.floor(circumference / 0.9)));
  const prep = prepare(s, maxBeads);
  const lane = prep.lanes[0];
  const rLo = rIn + s.bandThick;
  const rHi = rLo + s.relief;
  const radii = beadRadii(lane.beads, rLo + (rHi - rLo) * s.minPct / 100, rHi,
    { neckDepth: s.neckDepth, maxGap: lane.maxGap, gapExp: s.gapExp });
  const prof = profileSampler(lane.beads, radii, s.smooth);
  const nPhi = Math.max(nPhi0, lane.beads.length * 3);

  const outerR = new Float64Array(nPhi), cs = new Float64Array(nPhi), sn = new Float64Array(nPhi);
  for (let k = 0; k < nPhi; k++) {
    const a = TAU * k / nPhi;
    cs[k] = Math.cos(a); sn[k] = Math.sin(a);
    outerR[k] = Math.max(rLo, prof(k / nPhi));
  }
  const ringAt = (rFn) => {
    const out = new Array(nPhi);
    for (let k = 0; k < nPhi; k++) { const r = rFn(k); out[k] = [r * cs[k], r * sn[k]]; }
    return out;
  };
  const W = s.bandWidth;
  const zs = [0, cham, W - cham, W];
  const outs = [ringAt(k => outerR[k] - cham), ringAt(k => outerR[k]), ringAt(k => outerR[k]), ringAt(k => outerR[k] - cham)];
  const ins = [ringAt(() => rIn + cham), ringAt(() => rIn), ringAt(() => rIn), ringAt(() => rIn + cham)];

  const m = new Mesh();
  const oi = outs.map((r, i) => addRing(m, r, zs[i]));
  const ii = ins.map((r, i) => addRing(m, r, zs[i]));
  for (let i = 0; i + 1 < 4; i++) {
    wallStrip(m, oi[i], oi[i + 1], true);
    wallStrip(m, ii[i], ii[i + 1], false);
  }
  // Bottom: a quad strip rather than a triangulation, because two rings with the
  // same angular samples already are one.
  for (let k = 0; k < nPhi; k++) {
    const k1 = (k + 1) % nPhi;
    m.addQuad(oi[0][k], ii[0][k], ii[0][k1], oi[0][k1]);
  }
  const pockets = plan ? arcCaption(plan, rTextMid) : [];
  if (pockets.length) {
    flatFaceWithPockets(m, outs[3], [ins[3]], pockets, W, Math.min(s.captionDepth, s.bandWidth * 0.25));
  } else {
    for (let k = 0; k < nPhi; k++) {
      const k1 = (k + 1) % nPhi;
      m.addQuad(oi[3][k], oi[3][k1], ii[3][k1], ii[3][k]);
    }
  }
  return { mesh: m, ring: { rIn, rLo, rHi, cham, nPhi, flatBand, capH, prep, lane, outerR }, plan };
}

// ---------------------------------------------------------------------------
// ridge — several series laid side by side, which is the only one of the four
// that lets you compare two of them
// ---------------------------------------------------------------------------

function buildRidge(s) {
  const sf = clamp(s.sf, 0.25, 4);
  const nx = clampInt(s.length / 0.4 * sf, 24, 900);
  const maxBeads = Math.max(2, Math.min(Math.floor((nx + 1) / 3), Math.floor(s.length / MIN_BEAD_MM)));
  const prep = prepare(s, maxBeads);
  const lanes = prep.lanes;
  const nLane = lanes.length;
  const LW = s.laneWidth, L = s.length, W = nLane * LW;
  const bt = clamp(s.relief * 0.35, 2, 4);
  const nyPer = clampInt(LW / 0.7 * sf, 4, 40);
  const ny = nLane * nyPer;

  const hLo = s.relief * s.minPct / 100;
  const profs = lanes.map(l => profileSampler(
    l.beads,
    beadRadii(l.beads, hLo, s.relief, { neckDepth: s.neckDepth, maxGap: l.maxGap, gapExp: s.gapExp }),
    s.smooth));

  const plan = s.caption ? captionPlan(s, s.captionSize, L - 8) : null;
  const stripH = plan ? Math.min(s.captionSize, plan.height) + 2 * CAP_MARGIN : 0;
  const yr0 = -W / 2, yr1 = W / 2, yMin = yr0 - stripH;

  const xs = new Float64Array(nx + 1);
  for (let i = 0; i <= nx; i++) xs[i] = -L / 2 + L * i / nx;
  const ys = new Float64Array(ny + 1);
  for (let j = 0; j <= ny; j++) ys[j] = yr0 + W * j / ny;

  const m = new Mesh();
  const top = new Int32Array((nx + 1) * (ny + 1));
  const hCol = new Array(nx + 1);
  for (let i = 0; i <= nx; i++) hCol[i] = profs.map(f => f(i / nx));
  for (let j = 0; j <= ny; j++) {
    const laneF = Math.min(nLane - 1e-9, (ys[j] - yr0) / LW);
    const li = Math.floor(laneF);
    const v = laneF - li;
    const cross = 0.5 * (1 - Math.cos(TAU * v));
    for (let i = 0; i <= nx; i++) {
      top[j * (nx + 1) + i] = m.addVertex(xs[i], ys[j], bt + hCol[i][li] * cross);
    }
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = top[j * (nx + 1) + i], b = top[j * (nx + 1) + i + 1];
    const c = top[(j + 1) * (nx + 1) + i + 1], d = top[(j + 1) * (nx + 1) + i];
    m.addQuad(a, b, c, d);
  }

  // Perimeter, counter-clockwise seen from above, starting at the front-left.
  const per = [];
  if (stripH > 0) {
    const front = [[-L / 2, yMin], [L / 2, yMin]];
    const shared = [];
    for (let i = nx; i >= 0; i--) shared.push([xs[i], yr0]);
    const outer = [...front, ...shared];
    const pockets = plan
      ? plan.shapes.map(sh => sh.map(r => r.map(([x, y]) => [x, y + yMin + stripH / 2])))
      : [];
    flatFaceWithPockets(m, outer, [], pockets, bt, Math.min(s.captionDepth, bt * 0.45));
    per.push(m.addVertex(-L / 2, yMin, bt), m.addVertex(L / 2, yMin, bt));
  }
  for (let j = 0; j <= ny; j++) per.push(top[j * (nx + 1) + nx]);
  for (let i = nx - 1; i >= 0; i--) per.push(top[ny * (nx + 1) + i]);
  for (let j = ny - 1; j >= 0; j--) per.push(top[j * (nx + 1)]);

  const bottom = per.map(v => m.addVertex(m.positions[v * 3], m.positions[v * 3 + 1], 0));
  wallStrip(m, bottom, per, true);
  const c = m.addVertex(0, (yMin + yr1) / 2, 0);
  for (let i = 0; i < bottom.length; i++) m.addTri(c, bottom[(i + 1) % bottom.length], bottom[i]);

  return { mesh: m, ridge: { nx, ny, nLane, bt, L, W, stripH, prep, lanes, profs, hLo }, plan };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dimension callouts for the radial forms — the lengths the bounding box cannot
// show, each on the feature it measures. Points come from the same rows the
// solid was swept from; place() centres on the bounding box, so they are
// shifted by that centre.
// ---------------------------------------------------------------------------

function radialDims(s, r, b0) {
  const f = r.field;
  if (!f) return [];
  const dy = r.pedestal ? r.pedestal.stripH / 2 : 0;       // the column sits this far back on a pedestal
  const pl = (x, y, z) => [x - b0.center[0], y - b0.center[1], z - b0.min[2]];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const { rows, thetas } = f;
  const nT = thetas.length;
  const pt = (j, k) => { const row = rows[j]; return [row.r[k] * Math.cos(thetas[k]), row.r[k] * Math.sin(thetas[k]) + dy, row.z]; };
  const at = (rad, k, z) => [rad * Math.cos(thetas[k]), rad * Math.sin(thetas[k]) + dy, z];
  const opp = (k) => (k + Math.round(nT / 2)) % nT;
  const dims = [];
  const isSpiral = s.form === 'spiral';
  const bodyZ0 = f.pedH + f.discH;                          // the body starts above the foot flare

  // The base. A disc is the foot flare: its height on the widest point of the
  // contact ring. A pedestal is a slab: its height on the front edge.
  if (f.discH > 0) {
    let k0 = 0;
    for (let k = 1; k < nT; k++) if (rows[0].r[k] > rows[0].r[k0]) k0 = k;
    const [x, y] = pt(0, k0);
    dims.push({ param: 'baseHeight', label: 'foot', from: pl(x, y, rows[0].z), to: pl(x, y, rows[0].z + f.discH), offset: 8,
      ...(Math.abs(f.discH - s.baseH) > 1e-6 ? { value: r3(f.discH) } : {}) });
  } else if (f.pedH > 0 && r.pedestal) {
    const yF = -r.pedestal.halfY;
    dims.push({ param: 'baseHeight', label: 'pedestal', from: pl(0, yF, 0), to: pl(0, yF, f.pedH), offset: [0, -1, 0],
      ...(Math.abs(f.pedH - s.baseH) > 1e-6 ? { value: r3(f.pedH) } : {}) });
  }

  // The widest and the narrowest of the body, each read straight across the axis.
  let wj = -1, wk = 0, nj = -1, nk = 0, wide = -Infinity, narrow = Infinity;
  for (let j = 0; j < rows.length; j++) {
    if (rows[j].z < bodyZ0 - 1e-9) continue;
    const rr = rows[j].r;
    for (let k = 0; k < nT; k++) {
      if (rr[k] > wide) { wide = rr[k]; wj = j; wk = k; }
      if (rr[k] < narrow) { narrow = rr[k]; nj = j; nk = k; }
    }
  }
  if (wj >= 0) {
    // The widest diameter is the envelope's: crest radius both sides of the
    // axis, since a twisted flute or a spiral band is at a different phase
    // directly opposite its own crest.
    const a = pt(wj, wk), b = at(wide, opp(wk), rows[wj].z);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    dims.push({ param: 'dia', label: 'Ø', from: pl(...a), to: pl(...b), offset: 10,
      ...(Math.abs(len - s.dia) > s.dia * 0.02 ? { value: r3(len) } : {}) });
    if (isSpiral) {
      // The relief: core to crest, on the radius where the crest is highest.
      const c = at(f.coreR, wk, rows[wj].z);
      dims.push({ param: 'relief', label: 'relief', from: pl(...c), to: pl(...a), offset: 8,
        ...(Math.abs(wide - f.coreR - s.relief) > Math.max(0.05, s.relief * 0.02) ? { value: r3(wide - f.coreR) } : {}) });
    } else if (s.sides >= 1 && s.fluteDepth > 0) {
      // Flute depth: trough to crest radius, on the widest row, at the trough.
      const rr = rows[wj].r;
      let tk = 0;
      for (let k = 1; k < nT; k++) if (rr[k] < rr[tk]) tk = k;
      if (wide - rr[tk] > 1e-6) {
        dims.push({ param: 'fluteDepth', label: 'flute', unit: 'mm', value: r3(wide - rr[tk]),
          from: pl(...at(rr[tk], tk, rows[wj].z)), to: pl(...at(wide, tk, rows[wj].z)), offset: 8 });
      }
    }
  }
  if (nj >= 0 && !isSpiral) {
    const a = pt(nj, nk), b = pt(nj, opp(nk));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    dims.push({ param: 'minPct', label: 'neck', unit: 'mm', value: r3(len), from: pl(...a), to: pl(...b), offset: 10 });
  }

  // The caption, on the pedestal's top face: cap height at the ink's left edge,
  // engraving depth down the pocket wall there.
  if (r.plan && r.pedestal && r.plan.shapes.length) {
    const plan = r.plan, ped = r.pedestal;
    const yc = -ped.halfY + ped.stripH / 2;
    let v = null;
    for (const sh of plan.shapes) for (const ring of sh) for (const q of ring) if (!v || q[0] < v[0]) v = q;
    if (v) {
      const cap = s.captionSize * (plan.scaledTo || 1);
      const x = v[0], y = v[1] + yc, z = f.pedH;
      dims.push({ param: 'captionSize', label: 'cap', from: pl(x, yc - cap / 2, z), to: pl(x, yc + cap / 2, z), offset: 8,
        ...(Math.abs(cap - s.captionSize) > 1e-6 ? { value: r3(cap) } : {}) });
      const depth = Math.min(s.captionDepth, f.pedH * 0.4);
      dims.push({ param: 'captionDepth', label: 'engrave', from: pl(x, y, z - depth), to: pl(x, y, z), offset: [0, -1, 0],
        ...(Math.abs(depth - s.captionDepth) > 1e-6 ? { value: r3(depth) } : {}) });
    }
  }
  return dims;
}

function buildAll(p, ctx = {}) {
  const s = settings(p, ctx);
  const prog = typeof ctx.progress === 'function' ? ctx.progress : null;
  if (prog) prog(0.05);
  const r = s.form === 'ring' ? buildRing(s) : s.form === 'ridge' ? buildRidge(s) : buildRadial(s);
  if (prog) prog(0.95);
  const dims = radialDims(s, r, r.mesh.bbox());
  const mesh = r.mesh.place();
  const bb = mesh.bbox();
  const prep = r.field ? r.field.prep : (r.ring ? r.ring.prep : r.ridge.prep);
  const beads = r.field ? r.field.lane.beads.length
    : r.ring ? r.ring.lane.beads.length
      : r.ridge.lanes.reduce((n, l) => n + l.beads.length, 0);
  const lane0 = r.field ? r.field.lane : (r.ring ? r.ring.lane : r.ridge.lanes[0]);
  const meta = {
    dims,
    form: s.form,
    normalise: s.normalise,
    points: lane0.points,
    gaps: lane0.gaps,
    longestGap: lane0.maxGap,
    beads,
    samplesPerBead: Math.round(prep.binFactor * 100) / 100,
    trimmed: prep.norm ? prep.norm.trimmed : 0,
    spreadPct: Math.round((prep.spread || 0) * 10) / 10,
    size: bb.size.map(v => Math.round(v * 10) / 10),
    volumeCm3: Math.round(mesh.volume() / 100) / 10,
    triangles: mesh.triCount,
    caption: r.plan ? r.plan.text : null,
    captionShrunk: r.plan ? !!r.plan.shrunk : false,
    overhang: r.field
      ? { worstBeforeDeg: Math.round(r.field.over.worstBeforeDeg * 10) / 10,
        worstAfterDeg: Math.round(r.field.over.worstAfterDeg * 10) / 10,
        correctedPct: Math.round(r.field.over.correctedPct * 10) / 10,
        maxShiftMm: Math.round(r.field.over.maxShiftMm * 100) / 100,
        mode: r.field.over.mode }
      : { worstBeforeDeg: 45, worstAfterDeg: 45, correctedPct: 0, maxShiftMm: 0, mode: 'none' },
  };
  if (prog) prog(1);
  return { mesh, meta, s, r };
}

function build(p, ctx = {}) {
  const { mesh, meta } = buildAll(p, ctx);
  // Where several ridge landscapes meet, one side of a shared seam gets an extra
  // point the other does not — both halves right, the seam still open. Healing
  // T-junctions is a seam repair, not a cover-up: it adds no volume and moves no
  // vertex, it only splits a long edge where another already ends.
  return { mesh: mesh.healTJunctions(1e-5, { clean: true }), meta };
}

// ---------------------------------------------------------------------------
// validate — the things that will go wrong on the bed, said before it happens
// ---------------------------------------------------------------------------

function validate(p, ctx = {}) {
  const s = settings(p, ctx);
  const out = [];
  const bed = s.bed;
  const flat = cleanSeries(Array.isArray(s.series) && s.series.length && Array.isArray(s.series[0])
    ? s.series.flat() : s.series);
  const finite = flat.filter(v => v !== null);

  if (!finite.length) {
    out.push({ param: 'series', severity: 'error',
      message: 'the series has no usable numbers in it, so there is nothing to shape. Paste a column of values, or pick a preset.' });
  } else if (finite.length < 3) {
    out.push({ param: 'series', severity: 'warn',
      message: `${finite.length} value${finite.length === 1 ? '' : 's'} is not a series — the object will build, but there is no shape in two numbers.` });
  }

  // The finding this whole generator exists to preserve: on a skewed series,
  // rank spends the radius range on the data and everything else does not.
  if (finite.length >= 8) {
    const chosen = spreadPct(normaliseSeries(flat, { mode: s.normalise, clipPct: s.clipPct, outliers: s.outliers }).t);
    const ranked = spreadPct(normaliseSeries(flat, { mode: 'rank', outliers: s.outliers }).t);
    if (s.normalise !== 'rank' && chosen > 0 && ranked > chosen * 1.4) {
      out.push({ param: 'normalise', severity: 'info',
        message: `this series is skewed: ${s.normalise} normalisation spends ${chosen.toFixed(0)}% of the radius range on the middle 90% of the data, where rank spends ${ranked.toFixed(0)}%. The vault note behind this generator is about exactly that ([[projects/Core Sample]]).` });
    }
    const sorted = finite.slice().sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + Math.abs(b), 0);
    const top = Math.abs(sorted[sorted.length - 1]);
    if (s.outliers === 'keep' && total > 0 && top / total > 0.3 && s.normalise !== 'rank') {
      out.push({ param: 'outliers', severity: 'warn',
        message: `one value is ${(top / total * 100).toFixed(0)}% of the whole series. With outliers kept and ${s.normalise} normalisation it will flatten everything else into noise — trim it, or rank-normalise.` });
    }
  }

  if (s.form === 'ridge') {
    const lanes = asLanes(s.series, s.lanes).length || 1;
    const w = lanes * s.laneWidth;
    if (s.length > bed.x || w > bed.y) {
      out.push({ param: w > bed.y ? 'laneWidth' : 'length', severity: 'error',
        message: `${s.length.toFixed(0)} × ${w.toFixed(0)} mm will not fit a ${bed.x} × ${bed.y} mm bed. ${w > bed.y ? `${lanes} lanes at ${s.laneWidth} mm each is ${w.toFixed(0)} mm across.` : ''}` });
    }
    const perBead = s.length / Math.max(1, Math.min(Math.floor(s.length / MIN_BEAD_MM), (asLanes(s.series, s.lanes)[0] || []).length || 1));
    if (perBead < s.nozzle) {
      out.push({ param: 'length', severity: 'warn',
        message: `each sample gets ${perBead.toFixed(2)} mm along the ridge, under one ${s.nozzle} mm extrusion — the samples are being binned rather than printed one for one.` });
    }
  } else if (s.form === 'ring') {
    const outerDia = s.innerDia + 2 * (s.bandThick + s.relief);
    if (outerDia > Math.min(bed.x, bed.y)) {
      out.push({ param: 'innerDia', severity: 'error',
        message: `${outerDia.toFixed(0)} mm across will not fit a ${bed.x} × ${bed.y} mm bed.` });
    }
    if (s.innerDia < 52) {
      out.push({ param: 'innerDia', severity: 'info',
        message: `${s.innerDia.toFixed(0)} mm inside is a small wrist — a bracelet that has to pass over a hand usually wants 60–70 mm, and PLA does not stretch.` });
    }
    const cham = Math.min(0.9, s.bandThick * 0.28, s.bandWidth * 0.22);
    const avail = s.bandThick - 2 * cham - 1.4;
    if (s.caption && avail < 1.5) {
      out.push({ param: 'bandThick', severity: 'warn',
        message: `the caption has nowhere to go: the flat top of the band is ${Math.max(0, avail + 1.4).toFixed(1)} mm wide and needs about ${(s.captionSize + 1.4).toFixed(1)} mm. Thicken the band or shrink the caption.` });
    } else if (s.caption && s.captionSize > avail) {
      out.push({ param: 'captionSize', severity: 'info',
        message: `the caption is being cut to ${avail.toFixed(1)} mm cap height to fit the ${s.bandThick.toFixed(1)} mm band.` });
    }
    if (s.bandThick < 2) {
      out.push({ param: 'bandThick', severity: 'warn',
        message: `a ${s.bandThick.toFixed(1)} mm band is ${(s.bandThick / s.nozzle).toFixed(1)} extrusions thick where the data is at its thinnest; it will snap the first time it is stretched over a hand.` });
    }
  } else {
    const total = s.height;
    if (total > bed.z) {
      out.push({ param: 'height', severity: 'error',
        message: `${total.toFixed(0)} mm is taller than the ${bed.z} mm the printer can reach.` });
    } else if (total > bed.z * 0.94) {
      out.push({ param: 'height', severity: 'warn',
        message: `${total.toFixed(0)} mm is within a few millimetres of the gantry. The A1's fan shroud clears less than the nominal ${bed.z} mm — check before you start a two-hour print.` });
    }
    if (s.dia > Math.min(bed.x, bed.y)) {
      out.push({ param: 'dia', severity: 'error',
        message: `${s.dia.toFixed(0)} mm across will not fit a ${bed.x} × ${bed.y} mm bed.` });
    }
    const rLo = s.form === 'spiral'
      ? Math.max(2.5, s.dia / 2 - s.relief)
      : Math.max(MIN_R, s.dia / 2 * s.minPct / 100);
    if (2 * rLo < 4 * s.nozzle) {
      out.push({ param: s.form === 'spiral' ? 'relief' : 'minPct', severity: 'warn',
        message: `the thinnest part of the object is ${(2 * rLo).toFixed(1)} mm across — under four ${s.nozzle} mm extrusions. It will print, and it will snap where the data is smallest.` });
    }
    if (s.form === 'spiral' && s.relief > s.dia / 2 - 2.5) {
      out.push({ param: 'relief', severity: 'warn',
        message: `a ${s.relief.toFixed(1)} mm ridge on a ${s.dia.toFixed(0)} mm column leaves no core: it has been held at ${(s.dia / 2 - 2.5).toFixed(1)} mm so there is still something for the helix to wrap around.` });
    }
    if (s.height / Math.max(4, s.dia) > 4.5) {
      out.push({ param: 'height', severity: 'warn',
        message: `${s.height.toFixed(0)} mm tall on a ${s.dia.toFixed(0)} mm base is ${(s.height / s.dia).toFixed(1)}:1 — light enough for the toolhead to knock over near the top. Print with a brim.` });
    }
  }

  if (finite.length) {
    const beadsAcross = s.form === 'ring' ? TAU * (s.innerDia / 2 + s.bandThick) : (s.form === 'ridge' ? s.length : s.height - s.baseH);
    const perBead = beadsAcross / Math.max(1, Math.min(finite.length, Math.floor(beadsAcross / MIN_BEAD_MM)));
    if (perBead < 2 * s.layerH && s.form !== 'ridge') {
      out.push({ param: 'series', severity: 'info',
        message: `${finite.length} values over ${beadsAcross.toFixed(0)} mm is ${perBead.toFixed(2)} mm each — under two layers, so neighbouring values are being averaged into one bead rather than dropped.` });
    }
  }

  if (s.caption) {
    if (!fontFor(s.captionFont)) {
      out.push({ param: 'captionFont', severity: 'error',
        message: `no typeface could be loaded (${fontProblems().join('; ') || 'none registered'}), so the caption cannot be engraved.` });
    } else {
      const plan = captionPlan(s, s.captionSize, s.form === 'ridge' ? s.length - 8 : s.captionMaxW);
      if (!plan) {
        out.push({ param: 'caption', severity: 'warn',
          message: 'none of the characters in the caption have outlines in this typeface, so nothing will be engraved.' });
      } else {
        if (plan.missing && plan.missing.length) {
          out.push({ param: 'caption', severity: 'info',
            message: `this typeface has no glyph for ${plan.missing.slice(0, 6).map(c => `"${c}"`).join(', ')}; those characters are dropped.` });
        }
        if (plan.shrunk) {
          out.push({ param: 'captionSize', severity: 'info',
            message: `the caption is longer than the object is wide, so it has been scaled to ${(plan.scaledTo * 100).toFixed(0)}% — about ${(s.captionSize * plan.scaledTo).toFixed(1)} mm cap height.` });
        }
        if (s.captionSize * (plan.scaledTo || 1) < 3) {
          out.push({ param: 'captionSize', severity: 'warn',
            message: `letters under about 3 mm cap height do not survive a 0.4 mm nozzle: the counters fill in and the engraving reads as a smudge.` });
        }
        if (s.captionDepth < 2 * s.layerH) {
          out.push({ param: 'captionDepth', severity: 'info',
            message: `${s.captionDepth.toFixed(1)} mm is ${(s.captionDepth / s.layerH).toFixed(1)} layers deep. Two layers is the least that reads as engraved rather than as a print artefact.` });
        }
      }
    }
    if (s.radial && p.base && p.base !== 'pedestal') {
      out.push({ param: 'base', severity: 'info',
        message: 'a column has no flat face to engrave, so asking for a caption has turned the base into a pedestal to carry it.' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hints — what to type into the slicer, and what the geometry did behind you
// ---------------------------------------------------------------------------

function hints(p, ctx = {}) {
  const s = settings(p, ctx);
  const layerH = s.layerH;
  const notes = [];
  let over = null, prep = null, extra = '';

  if (s.radial) {
    const f = radialField(s);
    over = f.over; prep = f.prep;
    const walls = Math.max(2, Math.round(2.4 / (s.nozzle * 1.05)));
    notes.push(`${walls} walls, 8–12% gyroid infill, 4 top and 4 bottom layers. The object is nearly all wall — the infill barely appears — so walls are where the weight and the strength go.`);
    if (over.correctedPct > 0.05) {
      notes.push(over.mode === 'ramp'
        ? `The data asked for a wall leaning ${over.worstBeforeDeg.toFixed(0)}° from vertical, past the ${s.maxOverhangDeg.toFixed(0)}° limit. ${over.correctedPct.toFixed(1)}% of the surface has been RAMPED — the flare starts lower so the peak survives — moving the surface out by up to ${over.maxShiftMm.toFixed(2)} mm. Nothing above the data was invented: the widest point is still the widest value. The steepest wall on the object is now ${over.worstAfterDeg.toFixed(0)}°.`
                : `The data asked for a wall leaning ${over.worstBeforeDeg.toFixed(0)}° from vertical, past the ${s.maxOverhangDeg.toFixed(0)}° limit. ${over.correctedPct.toFixed(1)}% of the surface has been CLIPPED back to what the layer below can carry, by up to ${over.maxShiftMm.toFixed(2)} mm. A single large value after a long gap physically cannot build back to full width — that is a true statement about the data as well as about the printer.`);
    } else {
      notes.push(`No overhang correction was needed: the steepest wall is ${over.worstAfterDeg.toFixed(0)}° from vertical against a ${s.maxOverhangDeg.toFixed(0)}° limit. Supports off.`);
    }
    if (s.form === 'column') {
      notes.push('Every horizontal section is single-valued in angle by construction, so this one can be printed in SPIRAL VASE MODE — walls 1, top layers 0, infill 0%. That is how the original Core Sample was made and the single 0.42 mm wall came out translucent, which no render will show you.');
    } else {
      notes.push('The helix and its core are one surface, not a ribbon glued to a rod, so there is no seam to delaminate and nothing to support underneath.');
    }
    if (s.twist !== 0 && s.sides > 0) {
      notes.push(`${(s.twist * RAD).toFixed(0)}° of twist over the body means the flutes climb as they turn. Slow the outer wall to about 80 mm/s — the toolhead changes direction on every segment.`);
    }
    if (s.base === 'pedestal') notes.push('The pedestal is part of the same shell as the column, not a separate object under it, so there is no join to fail. Print it with a brim if the column is over about 4:1.');
  } else if (s.form === 'ring') {
    const r = buildRing(s);
    prep = r.ring.prep;
    notes.push('3 walls, 15% infill, 5 top and 5 bottom layers. A bracelet is loaded in bending every time it goes on, and top layers are what resist that.');
    notes.push('Supports off, and no supports are possible: it lies flat, every wall is vertical and the only sloped surfaces are the 45° comfort chamfers on both edges.');
    notes.push('Print it in PETG rather than PLA if it is going to be worn — PLA is stiff and brittle at wrist temperature and a 3 mm band snaps rather than flexes. This laptop has a documented PETG stringing baseline; expect to wipe the seam.');
    extra = `Inside diameter is ${s.innerDia.toFixed(0)} mm as modelled; PETG shrinks about 0.4%, so it will come off the bed a touch under that.`;
  } else {
    const r = buildRidge(s);
    prep = r.ridge.prep;
    notes.push('2 walls, 10% infill, 4 top layers. The top surface is the object — set ironing on for the top surface if the ridges are shallow.');
    notes.push('Supports off. The surface is single-valued in height by construction: there is no point on this object with anything above it, so nothing can droop.');
    notes.push(`${r.ridge.nLane} lanes are normalised against ONE pooled ruler, not one each, so a flat lane really is flatter than a wild one. That is the whole reason to put them side by side.`);
  }

  if (prep && prep.binFactor > 1.05) {
    notes.push(`${prep.inputLen} values became ${prep.binned} beads — ${prep.binFactor.toFixed(1)} samples averaged into each. Below about ${MIN_BEAD_MM} mm a bead is neither visible nor feelable, so binning says "eight days per ridge" instead of pretending to a resolution the nozzle does not have.`);
  }
  if (prep && prep.norm && prep.norm.trimmed > 0) {
    notes.push(`${prep.norm.trimmed} value${prep.norm.trimmed === 1 ? '' : 's'} beyond the far-outlier fence ${prep.norm.trimmed === 1 ? 'was' : 'were'} excluded from the range and pinned to the widest point, so one enormous number cannot flatten the rest into noise.`);
  }
  notes.push(s.normalise === 'rank'
    ? `Rank normalisation: the middle 90% of the values occupy ${(prep && prep.spread || 90).toFixed(0)}% of the available range. That is the finding the vault note records, and it is why this is the default.`
    : `${s.normalise} normalisation keeps magnitudes honest but spends only ${(prep && prep.spread || 0).toFixed(0)}% of the range on the middle 90% of the data.`);
  if (extra) notes.push(extra);
  notes.push('PLA unless it is going to be worn or left in a car. A data sculpture is a thing you hand to somebody and say what it is; matte PLA holds the engraving better than silk, which fills the letters with reflections.');

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: s.form === 'ring' ? 'PETG' : 'PLA',
    supports: false,
    spiral: s.form === 'column',
    ramped: over ? Math.round(over.correctedPct * 10) / 10 : 0,
    overhangDeg: over ? Math.round(over.worstAfterDeg * 10) / 10 : 45,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const isRadial = (p) => p.form !== 'ring' && p.form !== 'ridge';

export default {
  id: 'datasculpt',
  name: 'Data Sculpture',
  category: 'Data',
  blurb: 'A series of numbers becomes a solid: a column, a spiral, a bracelet or a landscape.',
  description:
    'One list of numbers, four ways of standing it up. A COLUMN reads bottom to top — height is time, radius is value — which is the form this laptop already printed once as a core sample of its own git history. ' +
    'A SPIRAL wraps the same series around a rising helix. A RING closes it into a loop you can wear. A RIDGE LANDSCAPE lays several series side by side against one pooled ruler, which is the only one of the four that lets you compare two of them. ' +
    'The statistics matter more than the shape: rank normalisation is the default because a log map parks three quarters of a skewed series in the middle of the radius range and every point comes out the same width. ' +
    'Gaps in the data become necks scaled on their length, not dropped points, and the radius can never change fast enough between two layers to lean past the overhang limit — where the data demands it, the geometry ramps instead and hints() says by how much.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V3"/><path d="M12 5.5c3 0 3 2.2 0 2.2s-3 2.2 0 2.2 3 2.6 0 2.6-3 2.4 0 2.4 3 2.1 0 2.1"/><path d="M12 5.5c-3 0-3 2.2 0 2.2s3 2.2 0 2.2-3 2.6 0 2.6 3 2.4 0 2.4-3 2.1 0 2.1"/><path d="M6 21h12"/></svg>',
  version: 1,

  params: [
    // ---- Data ----
    { key: 'series', label: 'The numbers', type: 'series', group: 'Data',
      def: () => GIT_CHURN.slice(),
      help: 'One value per point in time. Blanks, nulls and anything that is not a number are GAPS, not zeros — they become necks in the object rather than disappearing.' },
    { key: 'normalise', label: 'Normalisation', type: 'enum', def: 'rank', group: 'Data',
      help: 'How a value becomes a size. This choice changes the object more than any of the shape controls do.',
      options: [
        { v: 'rank', label: 'Rank', help: 'Position in the sorted order. Spends the range evenly on the data whatever its distribution, and an outlier cannot move it. The default, and the only one of the four that survived three Core Sample prints.' },
        { v: 'linear', label: 'Linear', help: 'Value against min and max. Truthful about magnitude, and useless on anything skewed — one big number flattens the rest.' },
        { v: 'log', label: 'Logarithmic', help: 'The obvious answer to skew and the wrong one: it parks most of a skewed series in the middle of the range and every point comes out the same width.' },
        { v: 'clipped', label: 'Clipped', help: 'Linear between two percentiles, with the tails flattened onto the ends. Use when the extremes are noise you want gone rather than data you want shown.' },
      ] },
    { key: 'clipPct', label: 'Clip tails', type: 'number', unit: '%', min: 0, max: 45, step: 1, def: 5, group: 'Data',
      showIf: (p) => p.normalise === 'clipped',
      help: 'How much is flattened onto each end. 5% means the bottom and top twentieth of the values all read as the smallest and largest.' },
    { key: 'outliers', label: 'Outliers', type: 'enum', def: 'trim', group: 'Data',
      help: 'What to do with a value so far out that it sets the range on its own.',
      options: [
        { v: 'trim', label: 'Trim the range', help: 'Values past a far-outlier fence are excluded from the range and pinned to the widest point — but only when at most one in twenty is doing it. One commit that is half the history is an outlier; a fat tail is the data.' },
        { v: 'keep', label: 'Keep everything', help: 'The range covers every value. Honest, and on a savagely skewed series it turns the rest of the object into a smooth stick.' },
      ] },
    { key: 'gapPower', label: 'Gap scaling', type: 'number', min: 0.3, max: 1.2, step: 0.05, def: 0.75, group: 'Data',
      help: 'How a run of missing values scales, in both length and depth. At 0.5 (a square root) a 54-day silence and a one-night gap look nearly identical; 0.75 is what made the difference visible on the printed object without letting one silence eat it.' },
    { key: 'neckDepth', label: 'Neck depth', type: 'number', unit: '%', min: 0, max: 100, step: 5, def: 100, group: 'Data',
      help: 'How far a gap pinches in. At 0 the gaps still take up their length but the silhouette runs straight through them.' },
    { key: 'smooth', label: 'Smoothing', type: 'number', unit: '%', min: 0, max: 100, step: 5, def: 25, group: 'Data',
      help: 'Fraction of each bead given over to the blend into its neighbour. At 0 every value is a hard step — one visible ridge per point, which is what a core sample should look like. At 100 the object is a curve through the values.' },
    { key: 'lanes', label: 'Lanes', type: 'int', min: 1, max: 8, step: 1, def: 3, group: 'Data',
      showIf: (p) => p.form === 'ridge',
      help: 'A flat series is cut into this many equal blocks, one per ridge — a year becomes four seasons with one paste. A list of lists is taken as one lane each instead.' },

    // ---- Form ----
    { key: 'form', label: 'Form', type: 'enum', def: 'column', group: 'Form',
      help: 'The same numbers, four ways of standing them up.',
      options: [
        { v: 'column', label: 'Column', help: 'Height is time, radius is value. The core-sample form: you read it from the foot upward and the silence is a waist.' },
        { v: 'spiral', label: 'Spiral', help: 'The series wraps a rising helix around a solid core. Fits far more points into the same height than a column can, at the cost of having to be told where it starts.' },
        { v: 'ring', label: 'Ring / bracelet', help: 'A closed loop whose outer edge is the series. Wearable, prints flat with no supports, and has no beginning — which suits a year and suits a heartbeat.' },
        { v: 'ridge', label: 'Ridge landscape', help: 'Several series as parallel ridges on one slab, measured against one pooled ruler. The only form here that lets you compare two series.' },
      ] },
    { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 20, max: 180, step: 1, def: 120, group: 'Form',
      showIf: isRadial,
      help: 'Overall height including the base. The original Core Sample was 145 mm; over about 170 the A1 mini fan shroud starts to be the limit rather than the Z axis.' },
    { key: 'dia', label: 'Widest diameter', type: 'number', unit: 'mm', min: 15, max: 120, step: 1, def: 46, group: 'Form',
      showIf: isRadial,
      help: 'The diameter at the largest value in the series. Nothing on the object is ever wider than this, including after overhang correction.' },
    { key: 'minPct', label: 'Smallest size', type: 'number', unit: '%', min: 10, max: 90, step: 5, def: 34, group: 'Form',
      help: 'The smallest value as a percentage of the largest. This is the range the data has to spend: at 90% every point looks the same, at 10% the thin parts are fragile.' },
    { key: 'sides', label: 'Flutes', type: 'int', min: 0, max: 24, step: 1, def: 6, group: 'Form',
      showIf: isRadial,
      help: 'Lobes around the section. 0 is a plain round column. Flutes catch the light along the length and hide layer lines better than any ironing setting.' },
    { key: 'fluteDepth', label: 'Flute depth', type: 'number', unit: '%', min: 0, max: 45, step: 1, def: 14, group: 'Form',
      showIf: (p) => isRadial(p) && p.sides > 0,
      help: 'How deep the valleys cut, as a percentage of the radius. Deep flutes plus a lot of twist is the fastest way to make the overhang limiter do work you did not ask for.' },
    { key: 'twist', label: 'Twist', type: 'number', unit: '°', min: -720, max: 720, step: 15, def: 90, group: 'Form',
      showIf: isRadial,
      help: 'Rotation of the section over the full body. A twist turns the flutes into a helix and makes the object read as one continuous thing rather than a stack of discs.' },
    { key: 'turns', label: 'Turns', type: 'number', min: 2, max: 40, step: 1, def: 10, group: 'Form',
      showIf: (p) => p.form === 'spiral',
      help: 'How many times the series goes around. More turns is more data in the same height and a shallower, more fragile ridge.' },
    { key: 'relief', label: 'Relief', type: 'number', unit: 'mm', min: 1, max: 24, step: 0.5, def: 6, group: 'Form',
      showIf: (p) => p.form !== 'column',
      help: 'How far the largest value stands out: the depth of the helical ridge, the reach of the ring beyond its band, or the height of a ridge above the slab.' },
    { key: 'innerDia', label: 'Inside diameter', type: 'number', unit: 'mm', min: 40, max: 90, step: 1, def: 62, group: 'Form',
      showIf: (p) => p.form === 'ring',
      help: 'The bore — the wrist. 60–70 mm fits most adults, and remember a rigid bracelet has to pass over the hand, not the wrist.' },
    { key: 'bandThick', label: 'Band thickness', type: 'number', unit: 'mm', min: 1.6, max: 14, step: 0.2, def: 3.2, group: 'Form',
      showIf: (p) => p.form === 'ring',
      help: 'The material under the data: what is left where the series is at its smallest. Under 2 mm it snaps; a caption needs about 6 mm to have somewhere to sit.' },
    { key: 'bandWidth', label: 'Band width', type: 'number', unit: 'mm', min: 4, max: 30, step: 1, def: 12, group: 'Form',
      showIf: (p) => p.form === 'ring',
      help: 'How tall the bracelet is on the wrist, which is how tall it stands on the bed.' },
    { key: 'length', label: 'Length', type: 'number', unit: 'mm', min: 40, max: 170, step: 1, def: 140, group: 'Form',
      showIf: (p) => p.form === 'ridge',
      help: 'The slab along the direction of the series. Each value gets this divided by however many survive binning.' },
    { key: 'laneWidth', label: 'Lane width', type: 'number', unit: 'mm', min: 4, max: 40, step: 1, def: 14, group: 'Form',
      showIf: (p) => p.form === 'ridge',
      help: 'Width of one ridge. Lanes times this is the slab depth, and the bed is 180 mm.' },

    // ---- Printing ----
    { key: 'maxOverhang', label: 'Overhang limit', type: 'number', unit: '°', min: 30, max: 80, step: 1, def: 60, group: 'Printing',
      help: 'The steepest lean from vertical the object is allowed to have. This is enforced layer to layer on the actual geometry, not checked afterwards — it is why the printed object matches the render.' },
    { key: 'overhangFix', label: 'Where the data is too steep', type: 'enum', def: 'ramp', group: 'Printing',
      help: 'What to do when a value demands a wall the printer cannot build.',
      options: [
        { v: 'ramp', label: 'Ramp into it', help: 'Start the flare lower so the peak survives, at the cost of filling in part of what was under it. Nothing above the data is invented: the widest point is still the widest value.' },
        { v: 'clip', label: 'Clip the peak', help: 'Cut the value back to what the layer below can carry. This is what the original Core Sample did, and it is arguably the more honest of the two — one busy day after a long silence genuinely cannot build back to full width.' },
      ] },
    { key: 'base', label: 'Base', type: 'enum', def: 'disc', group: 'Printing',
      showIf: isRadial,
      help: 'What the object stands on. A caption needs a pedestal, so asking for one promotes the base automatically.',
      options: [
        { v: 'none', label: 'None', help: 'The series starts at the bed. Honest, and a thin first value is a very small footprint to hold a tall column down.' },
        { v: 'disc', label: 'Flared foot', help: 'The first few millimetres flare outward going down. It only ever widens downward, so it can never be the overhang, and it triples the contact with the bed.' },
        { v: 'pedestal', label: 'Pedestal', help: 'A slab under the object with room for an engraved caption in front of it. One shell with the column, not a separate part.' },
      ] },
    { key: 'baseHeight', label: 'Base height', type: 'number', unit: 'mm', min: 1, max: 16, step: 0.5, def: 4, group: 'Printing',
      showIf: (p) => isRadial(p) && p.base !== 'none',
      help: 'Height of the foot or pedestal, taken out of the overall height rather than added to it, and never more than a third of it.' },

    // ---- Caption ----
    { key: 'caption', label: 'Caption', type: 'text', maxLength: 48, def: '', group: 'Caption',
      help: 'Engraved into the flat face: the pedestal in front of a column, the top of a bracelet band, the front margin of a landscape. A data sculpture nobody can read is an ornament.' },
    { key: 'captionSize', label: 'Cap height', type: 'number', unit: 'mm', min: 2.5, max: 12, step: 0.5, def: 4.5, group: 'Caption',
      help: 'Height of a capital letter. Under about 3 mm the counters fill in and a 0.4 mm nozzle turns the engraving into a smudge.' },
    { key: 'captionDepth', label: 'Engraving depth', type: 'number', unit: 'mm', min: 0.2, max: 1.5, step: 0.1, def: 0.6, group: 'Caption',
      help: 'How deep the letters cut. Two layers is the least that reads as engraved rather than as a print artefact.' },
    { key: 'captionFont', label: 'Typeface', type: 'enum', def: DEFAULT_CAPTION_FONT, group: 'Caption',
      options: CAPTION_FONTS.map(f => ({ v: f.id, label: f.label, help: f.help })),
      help: 'All three are TrueType outline faces bundled with Bluesheet; the licences sit beside them.' },
  ],

  presets: [
    { name: 'Core sample of a project',
      values: { series: GIT_CHURN, form: 'column', normalise: 'rank', height: 145, dia: 52,
        minPct: 30, sides: 6, fluteDepth: 16, twist: 200, smooth: 15, base: 'disc', baseHeight: 4,
        gapPower: 0.75, neckDepth: 100, overhangFix: 'clip', caption: '' } },
    { name: 'A year on your wrist',
      values: { series: BRISTOL_YEAR, form: 'ring', normalise: 'rank', innerDia: 64, bandThick: 9,
        bandWidth: 10, relief: 4.5, minPct: 15, smooth: 65, caption: 'BRISTOL 2025-26',
        captionSize: 4, captionDepth: 0.6, captionFont: 'LiberationSansNarrow-Regular' } },
    { name: 'Heartbeat spiral',
      values: { series: HEARTBEAT, form: 'spiral', normalise: 'linear', height: 100, dia: 44,
        relief: 5.5, turns: 9, minPct: 10, smooth: 45, base: 'disc', baseHeight: 5, twist: 0 } },
    { name: 'Four seasons, side by side',
      values: { series: BRISTOL_YEAR, form: 'ridge', normalise: 'linear', lanes: 4, length: 150,
        laneWidth: 16, relief: 9, minPct: 12, smooth: 40, caption: 'BRISTOL 2025-26', captionSize: 5 } },
    { name: 'Pulse bracelet',
      values: { series: HEARTBEAT, form: 'ring', normalise: 'linear', innerDia: 60, bandThick: 2.8,
        bandWidth: 6, relief: 5, minPct: 6, smooth: 25, caption: '' } },
    { name: 'Weather paperweight',
      values: { series: BRISTOL_YEAR, form: 'column', normalise: 'linear', height: 70, dia: 62,
        minPct: 45, sides: 0, twist: 0, smooth: 70, base: 'disc', baseHeight: 6 } },
  ],

  build,
  validate,
  hints,
};

export { build, buildAll, validate, hints, settings, radialField, buildRing, buildRidge, prepare, resolution, captionPlan, MIN_R, MIN_BEAD_MM };
