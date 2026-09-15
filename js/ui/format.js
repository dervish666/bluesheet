// Every number on this page is a measurement, so formatting is a shared
// decision rather than a per-call one: within a column the decimals line up,
// units are always stated, and lengths are always millimetres.

/** Decimals a value deserves: enough to be truthful, never more than two. */
export function dpFor(v) {
  const a = Math.abs(v);
  if (!isFinite(a)) return 1;
  if (Math.abs(a * 10 - Math.round(a * 10)) < 5e-4) return 1;
  return 2;
}

/** A single length. `dp` forces a column to agree. */
export function mm(v, dp = null) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return v.toFixed(dp === null ? dpFor(v) : dp);
}

/** "41.50 × 83.50 × 48.00 mm" — one decimal count for the whole triple. */
export function size3(size, { unit = true } = {}) {
  if (!size || size.some(v => !isFinite(v))) return '—';
  const dp = Math.max(...size.map(dpFor));
  return size.map(v => v.toFixed(dp)).join(' × ') + (unit ? ' mm' : '');
}

export function cm3(mm3) {
  if (!isFinite(mm3)) return '—';
  const v = mm3 / 1000;
  return `${v.toFixed(v < 10 ? 2 : 1)} cm³`;
}

export function grams(g) {
  if (!isFinite(g)) return '—';
  return `${g.toFixed(g < 10 ? 2 : 1)} g`;
}

export function count(n) {
  if (!isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-GB');
}

export function pct(v, dp = 1) {
  if (!isFinite(v)) return '—';
  return `${v.toFixed(dp)} %`;
}

export function deg(v) {
  if (!isFinite(v)) return '—';
  return `${v.toFixed(0)}°`;
}

/** Seconds to "1 h 04 m" / "12 m 30 s" — the way a slicer states it. */
export function duration(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} m`;
  if (m) return `${m} m ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}

/* Bambu PLA Basic is about £18/kg at the time of writing; this is a running
   cost estimate on the analysis column, not an invoice. */
export const FILAMENT_PRICE_PER_KG = 18;

export function cost(g) {
  if (!isFinite(g)) return '—';
  const p = (g / 1000) * FILAMENT_PRICE_PER_KG;
  return p < 1 ? `${(p * 100).toFixed(0)} p` : `£${p.toFixed(2)}`;
}

export function bytes(n) {
  if (!isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

/** The drawing's scale figure: how big the object looks against life size.
 *  96 CSS px to the inch is the web's fixed definition, so this is honest on a
 *  desktop monitor and approximate on anything with a different pixel pitch. */
export function scaleRatio(pxPerMm) {
  const lifeSize = 96 / 25.4;
  if (!isFinite(pxPerMm) || pxPerMm <= 0) return '—';
  const r = pxPerMm / lifeSize;
  if (Math.abs(r - 1) < 0.03) return '1:1';
  return r > 1 ? `${trim(r)}:1` : `1:${trim(1 / r)}`;
}

function trim(v) {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/** Uppercase display form of a filament id: "pla-matte" -> "PLA MATTE". */
export function materialName(id) {
  return String(id || 'pla').replace(/-/g, ' ').toUpperCase();
}

/** Map a slicer filament id onto a key in the kernel's density table.
 *  Longest first, or "pla-cf" resolves as plain PLA and the mass comes out
 *  0.02 g/cm³ light. "nylon" is PA there, which no filament spool says. */
const DENSITY_KEYS = [
  ['petg-cf', 'PETG-CF'], ['pla-cf', 'PLA-CF'], ['pa-cf', 'PA-CF'],
  ['petg', 'PETG'], ['tpu', 'TPU'], ['abs', 'ABS'], ['asa', 'ASA'],
  ['hips', 'HIPS'], ['pva', 'PVA'], ['nylon', 'PA'], ['pla', 'PLA'],
  ['pc', 'PC'], ['pa', 'PA'],
];

export function materialFamily(id) {
  const s = String(id || 'pla').toLowerCase();
  for (const [needle, key] of DENSITY_KEYS) if (s.includes(needle)) return key;
  return 'PLA';
}
