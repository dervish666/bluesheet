// terrain — a place, as an object.
//
// Real elevation becomes a tile you can hold. The generator is pure: it takes a
// field of metres above sea level and a handful of numbers and returns a solid.
// It never touches the network — the app fetches the data, and three real SRTM
// grids are bundled so that with no network at all this still builds a real
// place rather than a shrug.
//
// THE THREE THINGS A TERRAIN TILE GETS WRONG
//
// 1. THE MAP IS SQUASHED. A degree of longitude at 51°N is 0.631 of a degree of
//    latitude, so a bounding box that is square in degrees is half again as wide
//    on the ground as it is tall. Sample it into a square tile and every British
//    hill comes out stretched east-west. Here the ground extent is computed in
//    METRES from the field's own metadata — a WGS84 series, not a flat 111 km —
//    and the model is sized so that millimetres-per-ground-metre is identical in
//    X and Y. Isotropy is a test, not a hope: see gen-terrain.test.mjs.
//
// 2. THE HEIGHT IS A LIE NOBODY STATES. Every printed terrain tile is
//    vertically exaggerated, because true scale on a 100 mm tile of the Avon
//    Gorge is 3.5 mm of relief. That is fine — it is what makes the object
//    readable. What is not fine is not saying so. `exaggeration` is an explicit
//    parameter, hints() states the true horizontal scale (1:N), the vertical
//    scale, and how many metres of elevation one layer of plastic is worth.
//
// 3. THE SEAM. Split a map across four tiles and scale each one to its own
//    min/max and you get a cliff at every join. Everything vertical here is
//    derived from the WHOLE map's datum and range, and the sampling positions on
//    a shared edge are computed by an expression that is bit-identical in both
//    tiles, so two neighbours' edge heights are equal to the last bit. That is
//    also a test.
//
// VOIDS. Real elevation APIs return a sentinel for no-data — SRTM uses -32768,
// others -9999 or null. Scaled naively that is a hole punched three kilometres
// into your hillside. Voids are found, seeded from their nearest valid
// neighbour, and then relaxed to a harmonic patch, which by the discrete maximum
// principle cannot contain a spike: the filled values are bounded by the valid
// data around the hole and the gradient across it stays of the same order as the
// terrain's own.
//
// CONSTRUCTION. No CSG. The tile is one closed surface built directly:
//   the terrain grid on top, a wall down its border to the plinth, the plinth's
//   own wall down to the plate, and a flat bottom. Interlocks are excursions in
//   the plinth's plan outline — a male dovetail on the +X/+Y edges of a tile,
//   the matching female slot on -X/-Y — so a neighbour drops straight down onto
//   its tab. The label is engraved as real pockets: the face is the plinth wall
//   MINUS the letters, and the letter walls pick up exactly where those holes
//   stop, so it is one shell rather than two that happen to overlap.
//
// Millimetres, Z up, +Y is north, CCW seen from outside.

import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { loadFont, layoutText } from '../kernel/text.js';

const int = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : d);
const lerp = (a, b, t) => a * (1 - t) + b * t;   // exact at t=0 and t=1 — the seam depends on it

/** Anything at or below this many metres is no-data, not bathymetry. The Dead
 *  Sea shore is -430 m and SRTM carries no sea floor, so -500 is safely below
 *  every real land sample and safely above every sentinel (-9999, -32768). */
export const VOID_FLOOR = -500;

const MIN_CAP_MM = 0.9;        // below this an engraved letter is not a letter
const MIN_POCKET_MM = 0.15;    // a pocket shallower than this is not a pocket

// ---------------------------------------------------------------------------
// Bundled fields — so "no network" is a smaller object, not a broken one
// ---------------------------------------------------------------------------

export const BUNDLED_FIELDS = [
  { id: 'avon-gorge', file: 'avon-gorge.json', label: 'Avon Gorge',
    help: '4 km of the Avon at Clifton, 0–141 m. The gorge is unmistakable in the data.' },
  { id: 'snowdon', file: 'snowdon.json', label: 'Snowdon · Yr Wyddfa',
    help: '8 km around the summit, 58–1052 m. The most relief of the three, and the best test of exaggeration.' },
  { id: 'cheddar-gorge', file: 'cheddar-gorge.json', label: 'Cheddar Gorge',
    help: '5 km of the Mendip scarp, 3–276 m. A hard-edged notch in a plateau.' },
];

const FIELDS = new Map();
const FIELD_ERRORS = new Map();

/** Hand this module a field so `source: '<id>'` can use it. */
export function registerField(id, raw) {
  const f = asField(raw);
  if (!f) throw new Error(`registerField("${id}"): not a {w, h, data} field`);
  FIELDS.set(id, f);
  FIELD_ERRORS.delete(id);
  return f;
}

export function fieldProblems() { return [...FIELD_ERRORS.entries()].map(([id, why]) => `${id}: ${why}`); }

async function loadBundledFields() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/terrain/', import.meta.url);
  for (const f of BUNDLED_FIELDS) {
    try {
      let text;
      if (isNode) {
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([import('node:fs'), import('node:url')]);
        text = readFileSync(fileURLToPath(new URL(f.file, dir)), 'utf8');
      } else {
        const res = await fetch(new URL(f.file, dir));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      }
      const raw = JSON.parse(text);
      if (!raw.name) raw.name = f.label;
      registerField(f.id, raw);
    } catch (e) {
      // A field that will not load is a missing option, not a broken generator:
      // the synthetic ridge takes over and meta says which one went missing.
      FIELD_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}

await loadBundledFields();

// ---------------------------------------------------------------------------
// Geodesy
//
// Metres per degree on WGS84, to the usual truncated series. The cheap version
// of this function is `111320 * cos(lat)`, which is 0.3% wrong at 51°N — small
// beside the 37% error of ignoring the correction altogether, but free to fix.
// ---------------------------------------------------------------------------

export function metresPerDegLat(latDeg) {
  const f = latDeg * DEG;
  return 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f) - 0.0023 * Math.cos(6 * f);
}

export function metresPerDegLon(latDeg) {
  const f = latDeg * DEG;
  return Math.abs(111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) + 0.118 * Math.cos(5 * f));
}

/**
 * How much ground the field covers, in metres, east-west and north-south.
 *
 * The metadata is believed in this order, because that is the order of how much
 * it actually knows: an explicit degree box, an explicit metre box, a ground
 * span in km (already latitude-corrected by whoever fetched it), a sample
 * pitch, and finally the SRTM default. `how` is reported so hints() can say
 * which one it used rather than implying a precision the data has not got.
 */
export function groundExtent(field) {
  const m = (field && field.meta) || {};
  const w = field.w, h = field.h;
  const lat = num(m.lat, 0);

  const b = m.bounds;
  if (b && ['west', 'east', 'south', 'north'].every(k => typeof b[k] === 'number')) {
    const latMid = (b.south + b.north) / 2;
    const dLon = Math.abs(b.east - b.west), dLat = Math.abs(b.north - b.south);
    if (dLon > 0 && dLat > 0) {
      return { w: dLon * metresPerDegLon(latMid), h: dLat * metresPerDegLat(latMid), lat: latMid, how: 'bounds' };
    }
  }
  const dx = num(m.spanDegLon, num(m.spanDeg, 0)), dy = num(m.spanDegLat, num(m.spanDeg, 0));
  if (dx > 0 && dy > 0) {
    return { w: dx * metresPerDegLon(lat), h: dy * metresPerDegLat(lat), lat, how: 'degrees' };
  }
  if (num(m.groundW, 0) > 0 && num(m.groundH, 0) > 0) {
    return { w: m.groundW, h: m.groundH, lat, how: 'metres' };
  }
  if (num(m.spanKm, 0) > 0) {
    const gw = m.spanKm * 1000;
    // One span means "square on the ground", so the north-south extent follows
    // the aspect of the sample grid and the cells stay square.
    const gh = num(m.spanKmY, 0) > 0 ? m.spanKmY * 1000 : gw * (h - 1) / (w - 1);
    return { w: gw, h: gh, lat, how: 'spanKm' };
  }
  const mps = num(m.metresPerSample, 0);
  if (mps > 0) return { w: (w - 1) * mps, h: (h - 1) * mps, lat, how: 'pitch' };
  return { w: (w - 1) * 30, h: (h - 1) * 30, lat, how: 'assumed 30 m SRTM' };
}

// ---------------------------------------------------------------------------
// Field intake
// ---------------------------------------------------------------------------

/** Accept {w,h,data,meta}, or a bundled JSON with the metadata at the top level. */
export function asField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = int(raw.w, 0), h = int(raw.h, 0);
  if (!(w >= 2 && h >= 2)) return null;
  const data = raw.data;
  if (!data || typeof data.length !== 'number' || data.length !== w * h) return null;
  const meta = { ...(raw.meta || {}) };
  for (const k of ['name', 'lat', 'lon', 'spanKm', 'spanKmY', 'spanDeg', 'spanDegLat', 'spanDegLon',
    'bounds', 'groundW', 'groundH', 'metresPerSample', 'dataset', 'minM', 'maxM', 'voids', 'synthetic']) {
    if (meta[k] === undefined && raw[k] !== undefined) meta[k] = raw[k];
  }
  return { w, h, data, meta };
}

/**
 * Find the voids and interpolate them away.
 *
 * Two stages, and the second is the one that matters. The first floods each void
 * with its nearest valid neighbour's value, which is bounded but blocky. The
 * second relaxes only the void cells towards the average of their neighbours,
 * which converges to the harmonic (minimal-energy) surface over the hole. A
 * harmonic function has no interior extremum, so the patch cannot contain a peak
 * or a pit that the surrounding data did not already imply — which is exactly
 * the failure mode a raw sentinel produces.
 */
export function fillVoids(data, w, h) {
  const n = w * h;
  const out = new Float64Array(n);
  const bad = [];
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v) || v <= VOID_FLOOR) { out[i] = NaN; bad.push(i); }
    else out[i] = v;
  }
  if (!bad.length) return { data: out, voids: 0, ok: true };
  if (bad.length === n) return { data: null, voids: n, ok: false };

  const from = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0, maxDist = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(out[i])) { from[i] = i; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % w, y = (i / w) | 0;
    if (x > 0 && from[i - 1] < 0) { from[i - 1] = from[i]; dist[i - 1] = dist[i] + 1; queue[qt++] = i - 1; }
    if (x + 1 < w && from[i + 1] < 0) { from[i + 1] = from[i]; dist[i + 1] = dist[i] + 1; queue[qt++] = i + 1; }
    if (y > 0 && from[i - w] < 0) { from[i - w] = from[i]; dist[i - w] = dist[i] + 1; queue[qt++] = i - w; }
    if (y + 1 < h && from[i + w] < 0) { from[i + w] = from[i]; dist[i + w] = dist[i] + 1; queue[qt++] = i + w; }
  }
  for (const i of bad) { out[i] = out[from[i]]; if (dist[i] > maxDist) maxDist = dist[i]; }

  // Relaxation cost grows with the square of the hole radius; the budget stops a
  // pathological field (half of it missing) from stalling the preview.
  const iters = clamp(Math.round(2.5 * maxDist * maxDist), 12, Math.max(12, Math.floor(2e6 / bad.length)));
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < bad.length; k++) {
      const i = bad[k], x = i % w, y = (i / w) | 0;
      let s = 0, c = 0;
      if (x > 0) { s += out[i - 1]; c++; }
      if (x + 1 < w) { s += out[i + 1]; c++; }
      if (y > 0) { s += out[i - w]; c++; }
      if (y + 1 < h) { s += out[i + w]; c++; }
      if (c) out[i] = s / c;
    }
  }
  return { data: out, voids: bad.length, ok: true, maxVoidRadius: maxDist };
}

/** Separable [1 2 1]/4 binomial blur, clamped at the border. SRTM is quantised
 *  to whole metres and one pass takes the staircase off a shallow slope without
 *  touching a real ridge line. */
export function smoothGrid(data, w, h, passes) {
  let cur = data;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = cur[y * w + Math.max(0, x - 1)], b = cur[y * w + x], c = cur[y * w + Math.min(w - 1, x + 1)];
      tmp[y * w + x] = (a + 2 * b + c) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = tmp[Math.max(0, y - 1) * w + x], b = tmp[y * w + x], c = tmp[Math.min(h - 1, y + 1) * w + x];
      out[y * w + x] = (a + 2 * b + c) / 4;
    }
    cur = out;
  }
  return cur;
}

/**
 * Catmull-Rom sample at a continuous grid position, clamped to the 4×4 window's
 * own range. Catmull-Rom interpolates — at an integer position it returns the
 * datum unchanged, which is what keeps a tile seam exact — but it overshoots at
 * a step, and an overshoot on a coastal cliff is a spike of plastic sticking out
 * of the sea. Clamping to the window costs one pass over sixteen numbers and
 * makes a new extremum impossible.
 */
function sampleGrid(g, w, h, gx, gy, cubic) {
  const x = clamp(gx, 0, w - 1), y = clamp(gy, 0, h - 1);
  const ix = Math.min(Math.floor(x), w - 1), iy = Math.min(Math.floor(y), h - 1);
  const fx = x - ix, fy = y - iy;
  const cx = (i) => clamp(i, 0, w - 1), cy = (j) => clamp(j, 0, h - 1);
  if (!cubic) {
    const x0 = cx(ix), x1 = cx(ix + 1), y0 = cy(iy), y1 = cy(iy + 1);
    const a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  let lo = Infinity, hi = -Infinity;
  const row = new Array(4);
  for (let j = 0; j < 4; j++) {
    const yy = cy(iy - 1 + j) * w;
    const p0 = g[yy + cx(ix - 1)], p1 = g[yy + cx(ix)], p2 = g[yy + cx(ix + 1)], p3 = g[yy + cx(ix + 2)];
    if (p1 < lo) lo = p1; if (p1 > hi) hi = p1;
    if (p2 < lo) lo = p2; if (p2 > hi) hi = p2;
    row[j] = catmull(p0, p1, p2, p3, fx);
  }
  return clamp(catmull(row[0], row[1], row[2], row[3], fy), lo, hi);
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// ---------------------------------------------------------------------------
// The synthetic fallback
//
// Not noise for its own sake: a ridge running north-east with two summits, a
// valley cut through it and a plateau to the south, so that every feature of the
// generator — a steep face, a flat, a sea-level plane — has something to bite
// on. Integer-hashed value noise, so it is the same place on every machine for
// ever without a seed parameter to get out of step.
// ---------------------------------------------------------------------------

export function syntheticField(w = 96, h = 96) {
  const data = new Float64Array(w * h);
  const hash = (x, y) => {
    let s = (x * 374761393 + y * 668265263) | 0;
    s = (s ^ (s >>> 13)) * 1274126177 | 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / (w - 1), v = y / (h - 1);
    const ridge = Math.exp(-Math.pow(((v - 0.55) - 0.42 * (u - 0.5)) / 0.17, 2));
    const summits = 260 * Math.exp(-(((u - 0.34) / 0.10) ** 2 + ((v - 0.47) / 0.10) ** 2))
                  + 190 * Math.exp(-(((u - 0.68) / 0.12) ** 2 + ((v - 0.66) / 0.11) ** 2));
    const valley = -150 * Math.exp(-Math.pow((u - 0.50 - 0.18 * Math.sin(v * 4.1)) / 0.055, 2));
    const plateau = 70 * (1 / (1 + Math.exp((v - 0.22) * 22)));
    let f = 0, amp = 46, freq = 3.1;
    for (let o = 0; o < 5; o++) { f += amp * (vnoise(u * freq, v * freq) - 0.5); amp *= 0.52; freq *= 2.07; }
    data[y * w + x] = Math.max(0, 120 + 420 * ridge + summits + valley * ridge + plateau + f);
  }
  let mn = Infinity, mx = -Infinity;
  for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { w, h, data, meta: { name: 'Ridge (synthetic)', lat: 51.45, lon: -2.6, spanKm: 6, minM: mn, maxM: mx, synthetic: true } };
}

// ---------------------------------------------------------------------------
// Resolving the source
//
// Preparing a field (void fill + smoothing) costs a few milliseconds and both
// build() and hints() need the same answer, so the result is cached against the
// field object itself. The cache never changes what is returned for a given
// input, so determinism is untouched.
// ---------------------------------------------------------------------------

const PREP_CACHE = new WeakMap();
const NAMED_CACHE = new Map();

function prepare(field, smoothPasses) {
  const key = `s${smoothPasses}`;
  let per = PREP_CACHE.get(field);
  if (!per) { per = new Map(); PREP_CACHE.set(field, per); }
  const hit = per.get(key);
  if (hit) return hit;

  const filled = fillVoids(field.data, field.w, field.h);
  let g = filled.data, ok = filled.ok;
  if (!ok) {
    // Every sample was no-data. There is nothing to interpolate from, so say so
    // rather than returning a plane and calling it a place.
    const syn = syntheticField(Math.max(16, field.w), Math.max(16, field.h));
    g = syn.data;
  }
  if (smoothPasses > 0) g = smoothGrid(g, field.w, field.h, smoothPasses);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < g.length; i++) { const v = g[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const out = { grid: g, w: field.w, h: field.h, minM: mn, maxM: mx,
                voids: filled.voids, allVoid: !ok, ground: groundExtent(field), meta: field.meta || {} };
  per.set(key, out);
  return out;
}

function namedField(id) {
  if (FIELDS.has(id)) return { field: FIELDS.get(id), fallback: false, why: '' };
  let syn = NAMED_CACHE.get('ridge');
  if (!syn) { syn = syntheticField(); NAMED_CACHE.set('ridge', syn); }
  return { field: syn, fallback: id !== 'ridge',
           why: id === 'ridge' ? '' : (FIELD_ERRORS.get(id) || `bundled field "${id}" is not loaded`) };
}

/** Which grid this parameter set actually means, and whether that is what was asked for. */
export function resolveSource(p) {
  const want = typeof p.source === 'string' ? p.source : 'field';
  if (want === 'field') {
    const f = asField(p.field);
    if (f) return { field: f, source: 'field', fallback: false, why: '' };
    const bundled = namedField('avon-gorge');
    return { field: bundled.field, source: bundled.fallback ? 'ridge' : 'avon-gorge', fallback: true,
             why: 'no elevation data was supplied, so a bundled sample is standing in for it' };
  }
  if (want === 'ridge') {
    const r = namedField('ridge');
    return { field: r.field, source: 'ridge', fallback: false, why: '' };
  }
  const r = namedField(want);
  return { field: r.field, source: r.fallback ? 'ridge' : want, fallback: r.fallback, why: r.why };
}

// ---------------------------------------------------------------------------
// settings — every number the geometry, the validator and the hints agree on.
//
// One function, called by all three, so they cannot drift apart about what
// "size" or "exaggeration" mean.
// ---------------------------------------------------------------------------

const JOINTS = ['none', 'tab', 'dovetail', 'pin'];
const LABEL_FACES = ['none', 'front', 'underside'];

export function settings(p, ctx = {}) {
  const src = resolveSource(p);
  const smooth = clamp(int(p.smooth, 1), 0, 6);
  const prep = prepare(src.field, smooth);

  const cols = clamp(int(p.cols, 1), 1, 4);
  const rows = clamp(int(p.rows, 1), 1, 4);
  const tileX = clamp(int(p.tileX, 0), 0, cols - 1);
  const tileY = clamp(int(p.tileY, 0), 0, rows - 1);

  // Horizontal: one scale for both axes, derived from the ground extent in
  // metres. This is the whole latitude correction, and it lives in one line.
  const size = clamp(num(p.size, 100), 20, 180);
  const gW = Math.max(1e-6, prep.ground.w), gH = Math.max(1e-6, prep.ground.h);
  const mmPerM = size / Math.max(gW, gH);
  const mapW = gW * mmPerM, mapH = gH * mmPerM;
  const tileW = mapW / cols, tileH = mapH / rows;

  // Vertical.
  const sea = !!p.sea;
  const seaM = clamp(num(p.seaLevelM, 0), -100, 4000);
  const datumM = sea ? Math.min(seaM, prep.maxM) : prep.minM;
  const topM = Math.max(prep.maxM, datumM);
  const rangeM = topM - datumM;

  const vMode = p.vMode === 'relief' ? 'relief' : 'exaggeration';
  const exagWanted = clamp(num(p.exaggeration, 2), 0.25, 20);
  const reliefWanted = clamp(num(p.relief, 18), 0.5, 140);
  let vScale;                                    // mm of model per metre of elevation
  if (vMode === 'relief') vScale = rangeM > 1e-9 ? reliefWanted / rangeM : 0;
  else vScale = mmPerM * exagWanted;
  const reliefMm = rangeM * vScale;
  const exaggeration = mmPerM > 0 ? vScale / mmPerM : 0;

  const plinth = clamp(num(p.plinth, 6), 1, 30);

  // Sides. Draught flares the base OUTWARD, so every layer sits inside the one
  // below it and there is no overhang anywhere on the object — and it is applied
  // only to edges that are not shared with another tile, because a tile that
  // leans cannot butt up against its neighbour.
  const draughted = p.sides === 'draught';
  const draughtDeg = clamp(num(p.draughtDeg, 5), 0, 15);
  const flare = draughted ? plinth * Math.tan(draughtDeg * DEG) : 0;

  // Joints.
  const joint = JOINTS.includes(p.joint) ? p.joint : 'dovetail';
  const fit = clamp(num(p.jointFit, 0.15), 0, 0.6);
  const jointWanted = clamp(num(p.jointSize, 14), 4, 40);
  const shared = { left: tileX > 0, right: tileX < cols - 1, front: tileY > 0, back: tileY < rows - 1 };
  const anyShared = shared.left || shared.right || shared.front || shared.back;
  const useJoint = joint !== 'none' && anyShared;
  // A joint may take at most 80% of the edge it sits on, so a narrow strip tile
  // does not end up as a tab with a tile attached.
  const jointYHalf = Math.min(jointWanted, 0.8 * tileH) / 2;   // joints on the ±X edges run along Y
  const jointXHalf = Math.min(jointWanted, 0.8 * tileW) / 2;
  const jointDepth = clamp(jointWanted * 0.35, 1.5, 8);
  const depthY = Math.min(jointDepth, 0.25 * tileW);           // a ±X joint cuts into X
  const depthX = Math.min(jointDepth, 0.25 * tileH);
  const flareAng = 15 * DEG;

  // Detail.
  const segFactor = num(ctx.segFactor, 1);
  const samples = clamp(Math.round(clamp(int(p.samples, 96), 12, 200) * segFactor), 8, 400);

  const label = LABEL_FACES.includes(p.label) ? p.label : 'front';
  const labelDepth = clamp(num(p.labelDepth, 0.6), MIN_POCKET_MM, 2);

  return {
    src, prep, smooth,
    cols, rows, tileX, tileY, shared, anyShared,
    size, gW, gH, mmPerM, mapW, mapH, tileW, tileH,
    sea, seaM, datumM, topM, rangeM, vMode, vScale, reliefMm, exaggeration,
    plinth, draughted, draughtDeg, flare,
    joint, useJoint, fit, jointWanted, jointYHalf, jointXHalf, depthX, depthY, flareAng,
    samples, cubic: smooth >= 0,
    label, labelDepth,
    labelText: typeof p.labelText === 'string' ? p.labelText.slice(0, 40) : '',
    coords: p.coords !== false,
    labelFont: typeof p.labelFont === 'string' ? p.labelFont : DEFAULT_LABEL_FONT,
    height: plinth + reliefMm,
    place: (prep.meta && prep.meta.name) || 'Terrain',
    lat: num(prep.meta && prep.meta.lat, NaN), lon: num(prep.meta && prep.meta.lon, NaN),
  };
}

/** Elevation in metres at a continuous position in the SOURCE grid. */
function elevAt(s, gx, gy) {
  const v = sampleGrid(s.prep.grid, s.prep.w, s.prep.h, gx, gy, true);
  return s.sea ? Math.max(v, s.seaM) : v;
}

/** Model Z for an elevation in metres. Every constant here is whole-map, which
 *  is the only reason two tiles meet without a step. */
function zFor(s, elevM) { return s.plinth + (elevM - s.datumM) * s.vScale; }

// ===========================================================================
// THE MESH HALF
//
// Everything above decided WHAT the object is. Everything below turns it into
// triangles, and there is exactly one idea in it: the tile is a structured grid
// over a NON-UNIFORM lattice, with a per-cell mask.
//
// The lattice is the whole map's, not the tile's. Column i sits at
// X(i) = -mapW/2 + mapW * i / NX for a whole-map index i, so the column two
// tiles share is the same arithmetic expression evaluated twice rather than two
// expressions that ought to agree — which is the difference between "matches to
// 1e-9" and "matches". Every joint boundary is then inserted into that lattice
// as an extra line, so a tab or a socket lands exactly on a cell edge and can be
// cut by switching cells off rather than by a boolean.
//
// That mask is what makes the joints honest. A tab is a run of cells OUTSIDE the
// tile's own window — real map, sampled at the neighbour's own lattice indices,
// carrying its own terrain — and the neighbour's socket is the same run switched
// off and grown by the fit clearance. The two tiles interlock in plan and the
// map surface runs across the joint without a step, because both sides asked the
// same lattice the same question.
//
// heightfield() from the kernel builds the surface and a skirt, and if this were
// a plain rectangular tile it would be the right tool. It has no mask, no
// non-uniform lattice, no draught and no way to put a pocket in the side, and
// bolting four of those on from outside would be four ways to spring a leak. So
// the surface is built here, in the same style: one closed shell, no CSG.
// ===========================================================================

import { contoursToShapes } from '../kernel/text.js';
import { DEG, clamp, num } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

// ---------------------------------------------------------------------------
// Typefaces for the engraved label
//
// build() is synchronous and pure, so the faces are parsed once at module load,
// exactly as nameplate.js does it. A face that will not load is a missing option
// and not a broken generator: the label is left off and meta says which face
// went missing.
// ---------------------------------------------------------------------------

export const LABEL_FONTS = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf',
    label: 'Sans Narrow', help: 'Condensed grotesque. Fits a long place name across a small tile.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf',
    label: 'Sans Mono', help: 'Fixed pitch and even stroke weight — the safest face at a small cap height.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf',
    label: 'Rounded Bold', help: 'Heavy geometric rounded. Thickest strokes, so the most legible when engraved shallow.' },
];

export const DEFAULT_LABEL_FONT = 'LiberationSansNarrow-Regular';

const LABEL_FONT_CACHE = new Map();
const LABEL_FONT_ERRORS = new Map();

/** Hand this module a .ttf so `labelFont: '<id>'` can use it. */
export function registerLabelFont(id, data) {
  const font = data && typeof data.glyphIndex === 'function' ? data : loadFont(data);
  LABEL_FONT_CACHE.set(id, font);
  LABEL_FONT_ERRORS.delete(id);
  return font;
}

/** The parsed face for an id, falling back to whatever did load. Null if nothing did. */
export function labelFontFor(id) {
  return LABEL_FONT_CACHE.get(id) || LABEL_FONT_CACHE.get(DEFAULT_LABEL_FONT)
      || LABEL_FONT_CACHE.values().next().value || null;
}

export function labelFontProblems() {
  return [...LABEL_FONT_ERRORS.entries()].map(([id, why]) => `${id}: ${why}`);
}

async function loadLabelFonts() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/fonts/', import.meta.url);
  for (const f of LABEL_FONTS) {
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
      registerLabelFont(f.id, bytes);
    } catch (e) {
      LABEL_FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}

await loadLabelFonts();

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

const CURVE_TOL = { draft: 0.05, normal: 0.02, fine: 0.008 };
const MIN_LINE_GAP = 2e-3;       // mm — two lattice lines closer than this weld together
const MIN_RING_AREA = 1e-5;      // mm² — below this a ring is an artefact, not a letter
const BAND_CLEAR = 0.2;          // mm — the relief wall is never thinner than this

/** Sorted, deduplicated coordinates. `keep` wins a collision, so a joint edge is
 *  never nudged by a sample line that happened to land a micron away. */
function mergeCoords(entries) {
  const sorted = entries.slice().sort((a, b) => a.v - b.v || (b.keep ? 1 : 0) - (a.keep ? 1 : 0));
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.v - last.v < MIN_LINE_GAP) {
      // A joint edge and a sample line a micron apart would weld into a
      // degenerate triangle. The joint edge is the one that has to be where it
      // says it is, so it wins and the sample line is dropped.
      if (e.keep && !last.keep) { last.v = e.v; last.keep = true; }
      continue;
    }
    out.push({ v: e.v, keep: !!e.keep });
  }
  return out.map(e => e.v);
}

/** Index of the lattice line nearest a value. Used to find a tile edge again
 *  after the merge, so nothing downstream depends on the merge's arithmetic. */
function nearestIndex(arr, v) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; best = i; } }
  return best;
}

function nestRings(rings) {
  const kept = rings.filter(r => r && r.length >= 3 && Math.abs(P.signedArea(r)) >= MIN_RING_AREA);
  return contoursToShapes(kept, { minArea: 0 });
}

function ringsOfShapes(shapes) { const out = []; for (const s of shapes) for (const r of s) out.push(r); return out; }

function shapesBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const r of s) for (const pt of r) {
    if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
    if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
  }
  if (!isFinite(x0)) return null;
  return { min: [x0, y0], max: [x1, y1], size: [x1 - x0, y1 - y0], centre: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

function shiftShapes(shapes, dx, dy) {
  if (!dx && !dy) return shapes;
  return shapes.map(s => s.map(r => r.map(pt => [pt[0] + dx, pt[1] + dy])));
}

/**
 * Two glyph outlines that touch at exactly one point extrude into two wall
 * strips sharing a vertical edge — four triangles on one edge, which is
 * non-manifold and passes every test that only looks at area. Liberation Sans
 * Narrow does not do this at any spacing tried, but a monospace face set solid
 * does, so the contact is looked for and the ink is pulled in by four microns if
 * one is found. Four microns is a hundredth of a nozzle: unprintable,
 * unmeasurable, and the difference between a solid and a mesh that looks like one.
 */
function separateInk(shapes) {
  if (shapes.length < 2) return shapes;
  const seen = new Map();
  let touch = false;
  for (let i = 0; i < shapes.length && !touch; i++) {
    for (const ring of shapes[i]) {
      for (const pt of ring) {
        const key = `${Math.round(pt[0] * 5e3)},${Math.round(pt[1] * 5e3)}`;
        const owner = seen.get(key);
        if (owner !== undefined && owner !== i) { touch = true; break; }
        if (owner === undefined) seen.set(key, i);
      }
      if (touch) break;
    }
  }
  if (!touch) return shapes;
  const pulled = P.offset(shapes, -0.004, { join: 'miter' });
  const kept = pulled.filter(s => s.length && s[0].length >= 3 && P.area(s[0]) >= MIN_RING_AREA);
  return kept.length ? kept : shapes;
}

// ---------------------------------------------------------------------------
// The lattice
//
// nx / ny are per-TILE sample counts derived only from whole-map numbers, so
// every tile of a map divides its own window the same way and X(i) means the
// same thing in all of them.
// ---------------------------------------------------------------------------

// Four triangles a cell (a top pair and a bottom pair) plus the walls, so this
// is about 410k triangles, with headroom under the 500k the contract harness allows. The cap
// is computed from WHOLE-MAP numbers only, so every tile of a map hits it at the
// same place and the shared lattice stays shared.
const MAX_CELLS = 100000;

function lattice(s) {
  const long = Math.max(s.tileW, s.tileH, 1e-9);
  let nx = Math.max(2, Math.round(s.samples * s.tileW / long));
  let ny = Math.max(2, Math.round(s.samples * s.tileH / long));
  const capped = nx * ny > MAX_CELLS;
  if (capped) {
    const k = Math.sqrt(MAX_CELLS / (nx * ny));
    nx = Math.max(2, Math.round(nx * k));
    ny = Math.max(2, Math.round(ny * k));
  }
  const NX = nx * s.cols, NY = ny * s.rows;
  const X = (i) => -s.mapW / 2 + s.mapW * i / NX;
  const Y = (j) => -s.mapH / 2 + s.mapH * j / NY;
  const iL = s.tileX * nx, iR = iL + nx;
  const jF = s.tileY * ny, jB = jF + ny;
  return { nx, ny, NX, NY, capped, X, Y, iL, iR, jF, jB,
           xL: X(iL), xR: X(iR), yF: Y(jF), yB: Y(jB),
           dx: s.mapW / NX, dy: s.mapH / NY };
}

// ---------------------------------------------------------------------------
// Joints
//
// A joint is a set of axis-aligned rectangles in plan, given in a local frame:
// `d` runs outward from the edge line and `t` runs along it. That frame is the
// same for the tab and for the socket that receives it, so the pair cannot drift
// apart: the socket is literally the tab's rectangles grown by the fit
// clearance, computed by one function from one set of numbers.
//
// Every type is axis aligned on purpose. A slanted dovetail would have to be
// approximated by the lattice into a staircase, and a staircase dovetail with a
// 0.15 mm clearance is a joint that works on paper. The 'dovetail' here is a
// T: a neck narrower than its head, so the two tiles cannot be pulled apart in
// the plane, and it is assembled by dropping one tile straight down onto the
// other because the socket is cut right through.
// ---------------------------------------------------------------------------

function jointCells(kind, D, H) {
  switch (kind) {
    case 'tab':
      return [{ d0: 0, d1: D, t0: -H, t1: H }];
    case 'dovetail': {
      const neck = D * 0.45, nh = H * 0.5;
      return [{ d0: 0, d1: neck, t0: -nh, t1: nh }, { d0: neck, d1: D, t0: -H, t1: H }];
    }
    case 'pin': {
      const ph = Math.min(D * 0.45, H * 0.32);
      const c = H * 0.5;
      return [{ d0: 0, d1: 2 * ph, t0: c - ph, t1: c + ph },
              { d0: 0, d1: 2 * ph, t0: -c - ph, t1: -c + ph }];
    }
    default:
      return [];
  }
}

/** The socket is the tab grown by the clearance everywhere except at its mouth,
 *  which stays on the tile edge so the joint is open rather than blind. */
function growSocket(cells, fit) {
  return cells.map(c => ({ d0: c.d0, d1: c.d1 + fit, t0: c.t0 - fit, t1: c.t1 + fit }));
}

function jointPlan(s, lat) {
  const tabs = [], sockets = [], xLines = [], yLines = [];
  let extRight = 0, extBack = 0;

  const yc = (lat.yF + lat.yB) / 2;
  const xc = (lat.xL + lat.xR) / 2;
  const cellsX = jointCells(s.joint, s.depthY, s.jointYHalf);   // ±X edges: depth in X, length in Y
  const cellsY = jointCells(s.joint, s.depthX, s.jointXHalf);   // ±Y edges: depth in Y, length in X

  // What the joint ACTUALLY reaches and spans, which is not always what was
  // asked for: two pins 4.4 mm deep inside a 4.9 mm depth budget are 4.4 mm
  // deep, and reporting the budget instead is how a measurement goes looking
  // for a plane that is not there.
  const reach = (cells, k) => cells.reduce((mx, c) => Math.max(mx, c[k]), 0);
  const spanOf = (cells) => cells.reduce((mx, c) => Math.max(mx, c.t1, -c.t0), 0) * 2;
  const shape = { reachX: reach(cellsX, 'd1'), reachY: reach(cellsY, 'd1'),
                  spanY: spanOf(cellsX), spanX: spanOf(cellsY) };

  if (!s.useJoint) return { tabs, sockets, xLines, yLines, extRight, extBack, ...shape,
                            reachX: 0, reachY: 0, spanY: 0, spanX: 0 };

  if (s.shared.right) {
    for (const c of cellsX) {
      const r = { x0: lat.xR + c.d0, x1: lat.xR + c.d1, y0: yc + c.t0, y1: yc + c.t1 };
      tabs.push(r); xLines.push(r.x0, r.x1); yLines.push(r.y0, r.y1);
      extRight = Math.max(extRight, c.d1);
    }
  }
  if (s.shared.left) {
    for (const c of growSocket(cellsX, s.fit)) {
      const r = { x0: lat.xL + c.d0, x1: lat.xL + c.d1, y0: yc + c.t0, y1: yc + c.t1 };
      sockets.push(r); xLines.push(r.x0, r.x1); yLines.push(r.y0, r.y1);
    }
  }
  if (s.shared.back) {
    for (const c of cellsY) {
      const r = { x0: xc + c.t0, x1: xc + c.t1, y0: lat.yB + c.d0, y1: lat.yB + c.d1 };
      tabs.push(r); xLines.push(r.x0, r.x1); yLines.push(r.y0, r.y1);
      extBack = Math.max(extBack, c.d1);
    }
  }
  if (s.shared.front) {
    for (const c of growSocket(cellsY, s.fit)) {
      const r = { x0: xc + c.t0, x1: xc + c.t1, y0: lat.yF + c.d0, y1: lat.yF + c.d1 };
      sockets.push(r); xLines.push(r.x0, r.x1); yLines.push(r.y0, r.y1);
    }
  }
  return { tabs, sockets, xLines, yLines, extRight, extBack, ...shape };
}

const inRects = (rects, x, y) => {
  for (const r of rects) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
  return false;
};

// ---------------------------------------------------------------------------
// The tile's grid: coordinates, mask, corner heights, and where the plinth ends
// ---------------------------------------------------------------------------

function tileGrid(s) {
  const lat = lattice(s);
  const jp = jointPlan(s, lat);

  const exCols = jp.extRight > 0 ? Math.max(1, Math.ceil(jp.extRight / lat.dx)) : 0;
  const exRows = jp.extBack > 0 ? Math.max(1, Math.ceil(jp.extBack / lat.dy)) : 0;

  const xe = [], ye = [];
  for (let i = lat.iL; i <= lat.iR + exCols; i++) xe.push({ v: lat.X(i), keep: false });
  for (let j = lat.jF; j <= lat.jB + exRows; j++) ye.push({ v: lat.Y(j), keep: false });
  const xLo = lat.xL, xHi = lat.X(lat.iR + exCols);
  const yLo = lat.yF, yHi = lat.Y(lat.jB + exRows);
  for (const v of jp.xLines) if (v > xLo + MIN_LINE_GAP / 2 && v < xHi - MIN_LINE_GAP / 2) xe.push({ v, keep: true });
  for (const v of jp.yLines) if (v > yLo + MIN_LINE_GAP / 2 && v < yHi - MIN_LINE_GAP / 2) ye.push({ v, keep: true });

  const xs = mergeCoords(xe), ys = mergeCoords(ye);
  const nc = xs.length - 1, nr = ys.length - 1;
  const aR = nearestIndex(xs, lat.xR), bB = nearestIndex(ys, lat.yB);

  // The mask. A cell is material if its centre is inside the tile's own window
  // or inside a tab, and outside every socket.
  const mask = new Uint8Array(nc * nr);
  for (let b = 0; b < nr; b++) {
    const cy = (ys[b] + ys[b + 1]) / 2;
    for (let a = 0; a < nc; a++) {
      const cx = (xs[a] + xs[a + 1]) / 2;
      const own = cx > lat.xL && cx < lat.xR && cy > lat.yF && cy < lat.yB;
      const on = (own || inRects(jp.tabs, cx, cy)) && !inRects(jp.sockets, cx, cy);
      mask[b * nc + a] = on ? 1 : 0;
    }
  }

  // Corner heights, from whole-map positions in the SOURCE grid. Two tiles that
  // share a lattice line evaluate the same expression on the same numbers.
  const sw = s.prep.w, sh = s.prep.h;
  const gxOf = new Float64Array(xs.length), gyOf = new Float64Array(ys.length);
  for (let a = 0; a < xs.length; a++) gxOf[a] = (xs[a] + s.mapW / 2) / s.mapW * (sw - 1);
  for (let b = 0; b < ys.length; b++) gyOf[b] = (ys[b] + s.mapH / 2) / s.mapH * (sh - 1);
  const H = new Float64Array(xs.length * ys.length);
  const used = new Uint8Array(xs.length * ys.length);
  for (let b = 0; b < nr; b++) for (let a = 0; a < nc; a++) {
    if (!mask[b * nc + a]) continue;
    used[b * xs.length + a] = 1; used[b * xs.length + a + 1] = 1;
    used[(b + 1) * xs.length + a] = 1; used[(b + 1) * xs.length + a + 1] = 1;
  }
  for (let b = 0; b < ys.length; b++) for (let a = 0; a < xs.length; a++) {
    if (!used[b * xs.length + a]) continue;
    H[b * xs.length + a] = zFor(s, elevAt(s, gxOf[a], gyOf[b]));
  }

  // Boundary edges, in the order that makes the wall face outwards.
  const walls = [];
  const at = (a, b) => (a < 0 || b < 0 || a >= nc || b >= nr) ? 0 : mask[b * nc + a];
  for (let b = 0; b < nr; b++) for (let a = 0; a < nc; a++) {
    if (!mask[b * nc + a]) continue;
    if (!at(a - 1, b)) walls.push({ a1: a, b1: b + 1, a2: a, b2: b, side: 'left' });
    if (!at(a + 1, b)) walls.push({ a1: a + 1, b1: b, a2: a + 1, b2: b + 1, side: 'right' });
    if (!at(a, b - 1)) walls.push({ a1: a, b1: b, a2: a + 1, b2: b, side: 'front' });
    if (!at(a, b + 1)) walls.push({ a1: a + 1, b1: b + 1, a2: a, b2: b + 1, side: 'back' });
  }

  // The plinth's top edge. It is drawn where the plinth ends, unless the terrain
  // comes down to meet it — a sea plane running to the tile edge does exactly
  // that — in which case it is dropped far enough that the relief wall above it
  // is a wall and not a zero-height sliver the weld would collapse.
  let zBoundaryMin = Infinity;
  for (const w of walls) {
    const h1 = H[w.b1 * xs.length + w.a1], h2 = H[w.b2 * xs.length + w.a2];
    if (h1 < zBoundaryMin) zBoundaryMin = h1;
    if (h2 < zBoundaryMin) zBoundaryMin = h2;
  }
  if (!isFinite(zBoundaryMin)) zBoundaryMin = s.plinth;
  const bandTop = Math.max(0.4, Math.min(s.plinth, zBoundaryMin - BAND_CLEAR));

  // Draught, applied only to edges with no neighbour: a tile that leans cannot
  // butt up against the one beside it.
  const fL = s.shared.left ? 0 : s.flare, fR = s.shared.right ? 0 : s.flare;
  const fF = s.shared.front ? 0 : s.flare, fB = s.shared.back ? 0 : s.flare;
  const bx = xs.slice(), by = ys.slice();
  bx[0] -= fL; bx[bx.length - 1] += fR;
  by[0] -= fF; by[by.length - 1] += fB;

  return { lat, jp, xs, ys, bx, by, nc, nr, mask, H, walls, aR, bB, bandTop,
           flare: { left: fL, right: fR, front: fF, back: fB },
           stride: xs.length };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function emitTop(m, g) {
  const { xs, ys, nc, mask, H, stride } = g;
  const idx = new Int32Array(stride * ys.length).fill(-1);
  const vert = (a, b) => {
    const k = b * stride + a;
    if (idx[k] < 0) idx[k] = m.addVertex(xs[a], ys[b], H[k]);
    return idx[k];
  };
  for (let b = 0; b < g.nr; b++) for (let a = 0; a < nc; a++) {
    if (!mask[b * nc + a]) continue;
    const A = vert(a, b), B = vert(a + 1, b), C = vert(a + 1, b + 1), D = vert(a, b + 1);
    const za = H[b * stride + a], zb = H[b * stride + a + 1];
    const zc = H[(b + 1) * stride + a + 1], zd = H[(b + 1) * stride + a];
    // Split each cell along its flatter diagonal, so a ridge running corner to
    // corner is a ridge and not a staircase.
    if (Math.abs(za - zc) <= Math.abs(zb - zd)) { m.addTri(A, B, C); m.addTri(A, C, D); }
    else { m.addTri(A, B, D); m.addTri(B, C, D); }
  }
}

function emitBottom(m, g, skip) {
  const { bx, by, nc, mask } = g;
  const stride = bx.length;
  const idx = new Int32Array(stride * by.length).fill(-1);
  const vert = (a, b) => {
    const k = b * stride + a;
    if (idx[k] < 0) idx[k] = m.addVertex(bx[a], by[b], 0);
    return idx[k];
  };
  for (let b = 0; b < g.nr; b++) for (let a = 0; a < nc; a++) {
    if (!mask[b * nc + a]) continue;
    if (skip && a >= skip.a0 && a < skip.a1 && b >= skip.b0 && b < skip.b1) continue;
    // Clockwise seen from above is counter-clockwise seen from below.
    m.addQuad(vert(a, b), vert(a, b + 1), vert(a + 1, b + 1), vert(a + 1, b));
  }
}

function emitWalls(m, g, skipFrontBand) {
  const { xs, ys, bx, by, H, stride, bandTop } = g;
  for (const w of g.walls) {
    const x1 = xs[w.a1], y1 = ys[w.b1], x2 = xs[w.a2], y2 = ys[w.b2];
    const h1 = H[w.b1 * stride + w.a1], h2 = H[w.b2 * stride + w.a2];
    if (!(skipFrontBand && w.side === 'front' && w.b1 === 0)) {
      const p1 = [bx[w.a1], by[w.b1]], p2 = [bx[w.a2], by[w.b2]];
      m.addQuad(m.addVertex(p1[0], p1[1], 0), m.addVertex(p2[0], p2[1], 0),
                m.addVertex(x2, y2, bandTop), m.addVertex(x1, y1, bandTop));
    }
    m.addQuad(m.addVertex(x1, y1, bandTop), m.addVertex(x2, y2, bandTop),
              m.addVertex(x2, y2, h2), m.addVertex(x1, y1, h1));
  }
}

// ---------------------------------------------------------------------------
// The engraved panel
//
// One flat face, given as a local (u, v) frame plus an outward normal, with a
// rectangular island in the middle that the letters are cut into. The ring
// around that island is triangulated by hand — a fan per side to that side's
// inner corner — rather than by the ear clipper, because the clipper drops the
// collinear points along the panel's edge and those points are exactly where the
// surrounding grid meets it. Everything inside the island is one ear-clipped cap
// whose ring has four corners and no collinear points, so its boundary comes
// back exactly as it went in.
// ---------------------------------------------------------------------------

function capUV(m, shapes, to3, up) {
  for (const shape of shapes) {
    const { points, tris } = P.triangulate(shape);
    if (!tris.length) continue;
    let sum = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = points[tris[i]], b = points[tris[i + 1]], c = points[tris[i + 2]];
      sum += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    const asIs = (sum > 0) === !!up;
    const base = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const q = to3(points[i][0], points[i][1]);
      base[i] = m.addVertex(q[0], q[1], q[2]);
    }
    for (let i = 0; i < tris.length; i += 3) {
      if (asIs) m.addTri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
      else m.addTri(base[tris[i + 2]], base[tris[i + 1]], base[tris[i]]);
    }
  }
}

/**
 * @param sides   four lists of (u,v) points; sides[k] starts at corner k and
 *                stops before corner k+1.
 * @param corners the four corners, in the same order.
 * @param inner   [u0, u1, v0, v1] of the island, strictly inside.
 * @param ink     letter shapes in (u, v), already fitted inside the island.
 * @param depth   pocket depth, measured along the face normal.
 * @param to3     (u, v, t) -> [x, y, z]; t is depth INTO the material.
 */
function emitPanel(m, { sides, corners, inner, ink, depth, to3 }) {
  const face = (u, v) => to3(u, v, 0);
  const I = [[inner[0], inner[2]], [inner[1], inner[2]], [inner[1], inner[3]], [inner[0], inner[3]]];
  const V = (uv) => { const q = face(uv[0], uv[1]); return m.addVertex(q[0], q[1], q[2]); };

  // The frame, one fan per side plus one triangle across each corner.
  for (let k = 0; k < 4; k++) {
    const run = [...sides[k], corners[(k + 1) % 4]];
    const ik = V(I[k]);
    for (let i = 0; i + 1 < run.length; i++) m.addTri(V(run[i]), V(run[i + 1]), ik);
    m.addTri(V(corners[(k + 1) % 4]), V(I[(k + 1) % 4]), ik);
  }

  const innerRing = [[inner[0], inner[2]], [inner[1], inner[2]], [inner[1], inner[3]], [inner[0], inner[3]]];
  const letterRings = ringsOfShapes(ink);
  capUV(m, nestRings([innerRing, ...letterRings]), face, true);

  if (!ink.length) return;
  // Pocket walls: outward for a letter's outline, inward for its counters,
  // which falls straight out of the rings' own winding.
  for (const shape of ink) {
    for (const ring of shape) {
      const n = ring.length;
      const lo = new Array(n), hi = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = to3(ring[i][0], ring[i][1], 0), b = to3(ring[i][0], ring[i][1], depth);
        lo[i] = m.addVertex(a[0], a[1], a[2]);
        hi[i] = m.addVertex(b[0], b[1], b[2]);
      }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.addQuad(lo[i], lo[j], hi[j], hi[i]); }
    }
  }
  capUV(m, ink, (u, v) => to3(u, v, depth), true);
}

// ---------------------------------------------------------------------------
// What the label says, and whether it will fit
// ---------------------------------------------------------------------------

function coordString(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return '';
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}  ${Math.abs(lon).toFixed(4)}°${ew}`;
}

function labelLines(s) {
  const lines = [];
  const head = (s.labelText || s.place || '').trim();
  if (head) lines.push(head);
  if (s.coords) { const c = coordString(s.lat, s.lon); if (c) lines.push(c); }
  if (s.cols * s.rows > 1) lines.push(`tile ${s.tileX + 1},${s.tileY + 1} of ${s.cols}×${s.rows}`);
  return lines;
}

/**
 * The same words set several ways, and the best of them.
 *
 * A place name and its coordinates on separate lines in the 4.6 mm band around a
 * 6 mm plinth come out at a 1.3 mm cap height, which is not lettering. The band
 * is a hundred millimetres wide and five tall, so the answer is to set them on
 * ONE line — and on the underside, where the panel is nearly square, it is not.
 * Rather than guess, every sensible wording is measured and the fullest one that
 * clears a legible cap height wins; if none of them do, the largest does.
 */
const READABLE_CAP_MM = 2.6;

function labelCandidates(s) {
  const items = labelLines(s);
  if (!items.length) return [];
  const out = [{ items: items.length, text: items.join('\n') }];
  if (items.length > 1) out.push({ items: items.length, text: items.join('   ·   ') });
  if (items.length > 2) {
    out.push({ items: 2, text: items.slice(0, 2).join('\n') });
    out.push({ items: 2, text: items.slice(0, 2).join('   ·   ') });
    // On a tiled map, which tile this is beats where it is: you can look the
    // coordinates up, and you cannot look up which of sixteen you are holding.
    out.push({ items: 2, text: `${items[0]}\n${items[2]}` });
    out.push({ items: 2, text: `${items[0]}   ·   ${items[2]}` });
  }
  if (items.length > 1) out.push({ items: 1, text: items[0] });
  return out;
}

function fitInk(s, ctx, candidates, uw, vh) {
  const font = labelFontFor(s.labelFont);
  if (!font) return { ink: [], cap: 0, why: `no typeface loaded (${labelFontProblems().join('; ') || 'none registered'})` };
  const cands = typeof candidates === 'string' ? [{ items: 1, text: candidates }] : candidates;
  if (!cands.length || !cands.some(c => c.text.trim())) return { ink: [], cap: 0, why: 'no text' };
  if (!(uw > 0.5 && vh > 0.5)) return { ink: [], cap: 0, why: 'no room on the face' };
  let best = null;
  for (const c of cands) {
    const got = fitOne(s, ctx, c.text, uw, vh);
    if (!got.cap) continue;
    const better = !best
      || (got.cap >= READABLE_CAP_MM && best.cap < READABLE_CAP_MM)
      || (got.cap >= READABLE_CAP_MM && best.cap >= READABLE_CAP_MM
          && (c.items > best.items || (c.items === best.items && got.cap > best.cap)))
      || (got.cap < READABLE_CAP_MM && best.cap < READABLE_CAP_MM && got.cap > best.cap);
    if (better) best = { ...got, items: c.items, text: c.text };
  }
  if (!best) return { ink: [], cap: 0, why: 'the text has no outlines' };
  best.itemsWanted = Math.max(...cands.map(c => c.items));
  if (!(best.cap >= MIN_CAP_MM)) {
    return { ink: [], cap: best.cap, why: `a ${best.cap.toFixed(2)} mm cap height is below the ${MIN_CAP_MM} mm floor` };
  }
  return { ...best.render(), cap: best.cap, why: '', text: best.text,
           items: best.items, itemsWanted: best.itemsWanted };
}

/** Measure one wording. Laying the outlines out is deferred until it has won. */
function fitOne(s, ctx, text, uw, vh) {
  const font = labelFontFor(s.labelFont);
  if (!text.trim()) return { cap: 0 };
  const tol = CURVE_TOL[(ctx && ctx.quality) || 'normal'] || CURVE_TOL.normal;
  const opts = { lineHeight: 1.42, align: 'center', vAlign: 'baseline', onMissing: 'skip' };
  const probe = layoutText(font, text, { ...opts, size: 10, curveTolerance: 0.06 });
  const bb = probe.bbox;
  if (!(bb.size[0] > 1e-6 && bb.size[1] > 1e-6)) return { cap: 0 };
  // Fit INSIDE the island with a real gap, never exactly to it. Scaling the ink
  // to the last micron puts a letter's extreme point on the island's own edge,
  // which makes a hole that touches its outer ring: the ear clipper then bridges
  // through the contact and hands back a cap whose boundary is not the rings it
  // was given. That was six boundary edges in the default preset and seventy-five
  // in the underside one, and it looked for all the world like a font problem.
  const pad = Math.max(0.25, Math.min(uw, vh) * 0.04);
  const roomU = uw - 2 * pad, roomV = vh - 2 * pad;
  if (!(roomU > 0.4 && roomV > 0.4)) return { cap: 0 };
  const k = Math.min(roomU / bb.size[0], roomV / bb.size[1]);
  const cap = 10 * k;
  const render = () => {
    const laid = layoutText(font, text, { ...opts, size: cap, curveTolerance: tol });
    let ink = separateInk(laid.shapes.filter(sh => sh.length && sh[0].length >= 3 && P.area(sh[0]) >= MIN_RING_AREA));
    const box = shapesBox(ink);
    if (!box) return { ink: [], missing: laid.missing, lines: 0 };
    return { ink: shiftShapes(ink, -box.centre[0], -box.centre[1]), missing: laid.missing, lines: laid.lines.length };
  };
  return { cap, render };
}

/**
 * Where the label goes. 'front' wants the flat band around the plinth on the
 * -Y face; that needs the face to be unbroken and clear of any socket, and when
 * it is not the label goes underneath instead and meta says so.
 */
function planLabel(s, g, ctx) {
  if (s.label === 'none') return { where: 'none' };
  const depth = clamp(s.labelDepth, MIN_POCKET_MM, Math.min(2, s.plinth * 0.5));
  const text = labelCandidates(s);
  const notes = [];

  if (s.label === 'front') {
    const front = frontPanel(s, g, ctx, depth, text, notes);
    if (front) return front;
  }
  const under = underPanel(s, g, ctx, depth, text, notes);
  if (under) return under;
  return { where: 'none', notes, why: notes[notes.length - 1] || 'there was no face big enough to cut it into' };
}

function frontPanel(s, g, ctx, depth, text, notes) {
  if (s.shared.front) { notes.push('the front edge of this tile is a joint, so the name went underneath'); return null; }
  // The whole front row has to be material, or the face is not one face.
  for (let a = 0; a < g.aR; a++) if (!g.mask[0 * g.nc + a]) {
    notes.push('a joint socket breaks the front face, so the name went underneath'); return null;
  }
  // And the pocket must not break into a socket cut in from the side.
  const reach = g.ys[0] + depth + 0.5;
  for (const r of g.jp.sockets) if (r.y0 < reach) {
    notes.push('a joint socket comes within a pocket depth of the front face, so the name went underneath'); return null;
  }

  const fF = g.flare.front, bT = g.bandTop;
  const L = Math.hypot(fF, bT);
  const uBotL = g.bx[0], uBotR = g.bx[g.aR], uTopL = g.xs[0], uTopR = g.xs[g.aR];
  const mu = Math.max(1.4, (uTopR - uTopL) * 0.03);
  // The pocket travels along the face normal, so on a leaning face it drops as
  // it goes in. Keep it clear of z = 0 or it would open a hole in the plate.
  const mv = Math.max(0.7, depth * fF / Math.max(bT, 1e-6) + 0.35, L * 0.1);
  const inner = [uTopL + mu, uTopR - mu, mv, L - mv];
  if (!(inner[1] - inner[0] > 1.2 && inner[3] - inner[2] > 1.2)) {
    notes.push(`the ${(uTopR - uTopL).toFixed(0)}×${L.toFixed(1)} mm front band leaves no room for a pocket, so the name went underneath`);
    return null;
  }
  const fit = fitInk(s, ctx, text, inner[1] - inner[0], inner[3] - inner[2]);
  if (!fit.ink.length) { notes.push(fit.why); return null; }

  const ink = shiftShapes(fit.ink, (inner[0] + inner[1]) / 2, (inner[2] + inner[3]) / 2);
  const yF = g.ys[0];
  const to3 = (u, v, t) => {
    const f = v / L;
    return [u, yF - fF + fF * f + t * bT / L, bT * f - t * fF / L];
  };
  const sides = [[], [[uBotR, 0]], [], [[uTopL, L]]];
  for (let a = 0; a < g.aR; a++) sides[0].push([g.bx[a], 0]);
  for (let a = g.aR; a >= 1; a--) sides[2].push([g.xs[a], L]);
  const corners = [[uBotL, 0], [uBotR, 0], [uTopR, L], [uTopL, L]];
  return { where: 'front', panel: { sides, corners, inner, ink, depth, to3 },
           cap: fit.cap, depth, text: fit.text, missing: fit.missing, notes,
           items: fit.items, itemsWanted: fit.itemsWanted };
}

function underPanel(s, g, ctx, depth, text, notes) {
  // A block of whole cells, two clear of every edge so the draught never
  // reaches it and the pocket is always over solid material.
  const wantU = (g.xs[g.aR] - g.xs[0]) * 0.7, wantV = (g.ys[g.bB] - g.ys[0]) * 0.3;
  const cU = (g.xs[0] + g.xs[g.aR]) / 2, cV = (g.ys[0] + g.ys[g.bB]) / 2;
  let a0 = nearestIndex(g.xs, cU - wantU / 2), a1 = nearestIndex(g.xs, cU + wantU / 2);
  let b0 = nearestIndex(g.ys, cV - wantV / 2), b1 = nearestIndex(g.ys, cV + wantV / 2);
  a0 = Math.max(2, a0); a1 = Math.min(g.aR - 2, a1);
  b0 = Math.max(2, b0); b1 = Math.min(g.bB - 2, b1);
  if (!(a1 - a0 >= 2 && b1 - b0 >= 2)) {
    notes.push('the underside is too small to take a label at this sample count');
    return null;
  }
  for (let b = b0; b < b1; b++) for (let a = a0; a < a1; a++) if (!g.mask[b * g.nc + a]) {
    notes.push('a joint socket runs under the middle of the tile, so there was nowhere flat to engrave');
    return null;
  }
  const u0 = g.xs[a0], u1 = g.xs[a1], v0 = -g.ys[b1], v1 = -g.ys[b0];
  const mu = Math.max(1.2, (u1 - u0) * 0.05), mv = Math.max(1.0, (v1 - v0) * 0.1);
  const inner = [u0 + mu, u1 - mu, v0 + mv, v1 - mv];
  if (!(inner[1] - inner[0] > 1.2 && inner[3] - inner[2] > 1.2)) {
    notes.push('the underside panel leaves no room for a pocket');
    return null;
  }
  const fit = fitInk(s, ctx, text, inner[1] - inner[0], inner[3] - inner[2]);
  if (!fit.ink.length) { notes.push(fit.why); return null; }
  const ink = shiftShapes(fit.ink, (inner[0] + inner[1]) / 2, (inner[2] + inner[3]) / 2);

  // u = x, v = -y: the frame a reader sees after flipping the tile over about
  // its own X axis, which is how anyone reads the bottom of a thing.
  const to3 = (u, v, t) => [u, -v, t];
  const sides = [[], [], [], []];
  for (let a = a0; a < a1; a++) sides[0].push([g.xs[a], -g.ys[b1]]);
  for (let b = b1; b > b0; b--) sides[1].push([g.xs[a1], -g.ys[b]]);
  for (let a = a1; a > a0; a--) sides[2].push([g.xs[a], -g.ys[b0]]);
  for (let b = b0; b < b1; b++) sides[3].push([g.xs[a0], -g.ys[b]]);
  const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  return { where: 'underside', panel: { sides, corners, inner, ink, depth, to3 },
           cap: fit.cap, depth, text: fit.text, missing: fit.missing, notes,
           items: fit.items, itemsWanted: fit.itemsWanted,
           skip: { a0, a1, b0, b1 } };
}

// ---------------------------------------------------------------------------
// Steepness — asked by validate() and hints(), so it lives in one place
//
// The printed gradient is the ground's own gradient times the exaggeration, and
// nothing else: the horizontal scale cancels. That is a nice enough identity
// that it is worth stating rather than measuring twice.
// ---------------------------------------------------------------------------

function steepest(s) {
  const g = s.prep.grid, w = s.prep.w, h = s.prep.h;
  const mx = Math.max(1e-6, s.gW / Math.max(1, w - 1));
  const my = Math.max(1e-6, s.gH / Math.max(1, h - 1));
  let best = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = s.sea ? Math.max(g[y * w + x], s.seaM) : g[y * w + x];
    if (x + 1 < w) {
      const u = s.sea ? Math.max(g[y * w + x + 1], s.seaM) : g[y * w + x + 1];
      const d = Math.abs(u - v) / mx; if (d > best) best = d;
    }
    if (y + 1 < h) {
      const u = s.sea ? Math.max(g[(y + 1) * w + x], s.seaM) : g[(y + 1) * w + x];
      const d = Math.abs(u - v) / my; if (d > best) best = d;
    }
  }
  return { groundGrad: best, modelGrad: best * s.exaggeration,
           deg: Math.atan(best * s.exaggeration) / DEG };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/**
 * Boundary and non-manifold edge counts on an already-welded mesh, with numeric
 * keys so it is cheap enough to run on every build that engraves something.
 *
 * The landscape, the walls and the plinth are built from one indexed lattice and
 * cannot leak. The letters are the one part that goes through the ear clipper,
 * and js/gen/nameplate.js documents a case where it hands back a cap whose
 * boundary is not the rings it was given. So the assembled tile is audited, and
 * if the engraving has holed it the tile is built again without it and the meta
 * says so. A map with no name on it is a smaller object; a map that is not a
 * solid is not an object at all.
 */
function meshLeaks(mesh) {
  const n = mesh.vertCount;
  if (n >= 2097152) return 1;
  const count = new Map(), net = new Map();
  for (let t = 0; t < mesh.triCount; t++) {
    const a = mesh.tris[t * 3], b = mesh.tris[t * 3 + 1], c = mesh.tris[t * 3 + 2];
    if (a === b || b === c || a === c) return 1;
    for (let k = 0; k < 3; k++) {
      const u = k === 0 ? a : k === 1 ? b : c;
      const v = k === 0 ? b : k === 1 ? c : a;
      const key = u < v ? u * 2097152 + v : v * 2097152 + u;
      count.set(key, (count.get(key) || 0) + 1);
      net.set(key, (net.get(key) || 0) + (u < v ? 1 : -1));
    }
  }
  let bad = 0;
  for (const [key, c] of count) { if (c !== 2 || net.get(key) !== 0) bad++; }
  return bad;
}

function assemble(g, lab) {
  const m = new Mesh();
  emitTop(m, g);
  emitWalls(m, g, lab.where === 'front');
  emitBottom(m, g, lab.where === 'underside' ? lab.skip : null);
  if (lab.panel) emitPanel(m, lab.panel);
  // Once, at the end: close any T-junction the ear clipper left behind, then one
  // transform off the assembled bounding box to sit it on the plate and centre it.
  return m.healTJunctions(1e-5);
}

// ---------------------------------------------------------------------------
// Dimension callouts — the lengths the bounding box cannot show, each on the
// feature it measures. The grid is in the whole-map frame; place() centres the
// tile on its own bounding box, so every point is shifted by that centre.
// ---------------------------------------------------------------------------

function terrainDims(p, s, g, lab, b0) {
  const pl = (x, y, z) => [x - b0.center[0], y - b0.center[1], z - b0.min[2]];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const dims = [];
  const xF = g.xs[0], xR = g.xs[g.aR], yF = g.ys[0], yB = g.ys[g.bB];

  // The plinth, on the front-right vertical edge — the corner nearest the eye
  // in the default view. Draught moves the foot of that edge outward.
  const cxR = xR + g.flare.right, cyF = yF - g.flare.front;
  dims.push({ param: 'plinth', label: 'plinth', from: pl(cxR, cyF, 0), to: pl(cxR, cyF, s.plinth), offset: 8 });

  // Draught: how far the foot flares past the band, measured along the front-left foot.
  if (s.draughted && g.flare.left > 1e-6) {
    dims.push({ param: 'draughtDeg', label: 'flare', unit: 'mm', value: r3(g.flare.left),
      from: pl(xF - g.flare.left, cyF, 0), to: pl(xF, cyF, 0), offset: 8 });
  }

  // The relief, plinth top to summit, on the column of the highest lattice vertex.
  let best = -Infinity, bi = -1;
  for (let i = 0; i < g.H.length; i++) if (g.H[i] > best) { best = g.H[i]; bi = i; }
  if (bi >= 0 && best - s.plinth > 1e-6) {
    // A tile that does not hold the map's summit rises less than the whole-map
    // relief, so the figure is this tile's own rise whenever the two differ.
    const sx = g.xs[bi % g.stride], sy = g.ys[Math.floor(bi / g.stride)];
    const rise = best - s.plinth;
    const d = { label: 'relief', from: pl(sx, sy, s.plinth), to: pl(sx, sy, best), offset: 10 };
    if (s.vMode === 'relief') {
      dims.push({ param: 'relief', ...d, ...(Math.abs(rise - s.reliefMm) > Math.max(0.05, s.reliefMm * 0.01) ? { value: r3(rise) } : {}) });
    } else dims.push({ param: 'exaggeration', unit: 'mm', value: r3(rise), ...d });
  }

  // Joints. The width is read across the far face of the tab (or the mouth of
  // the socket when this tile only has sockets); the clearance across the gap
  // between a socket wall and where the tab's edge will sit.
  if (s.useJoint) {
    const jp = g.jp, z = g.bandTop;
    const yc = (g.lat.yF + g.lat.yB) / 2, xc = (g.lat.xL + g.lat.xR) / 2;
    if (s.shared.right && jp.spanY > 0) {
      const x = g.lat.xR + jp.reachX;
      dims.push({ param: 'jointSize', label: 'joint', from: pl(x, yc - jp.spanY / 2, z), to: pl(x, yc + jp.spanY / 2, z), offset: 8,
        ...(Math.abs(jp.spanY - s.jointWanted) > 1e-6 ? { value: r3(jp.spanY) } : {}) });
    } else if (s.shared.back && jp.spanX > 0) {
      const y = g.lat.yB + jp.reachY;
      dims.push({ param: 'jointSize', label: 'joint', from: pl(xc - jp.spanX / 2, y, z), to: pl(xc + jp.spanX / 2, y, z), offset: 8,
        ...(Math.abs(jp.spanX - s.jointWanted) > 1e-6 ? { value: r3(jp.spanX) } : {}) });
    } else if (s.shared.left && jp.spanY > 0) {
      const span = jp.spanY + 2 * s.fit, x = g.lat.xL + jp.reachX + s.fit;
      dims.push({ param: 'jointSize', label: 'socket', value: r3(span), from: pl(x, yc - span / 2, z), to: pl(x, yc + span / 2, z), offset: 8 });
    } else if (s.shared.front && jp.spanX > 0) {
      const span = jp.spanX + 2 * s.fit, y = g.lat.yF + jp.reachY + s.fit;
      dims.push({ param: 'jointSize', label: 'socket', value: r3(span), from: pl(xc - span / 2, y, z), to: pl(xc + span / 2, y, z), offset: 8 });
    }
    if (s.fit > 1e-6 && jp.sockets.length) {
      // The socket furthest along +t on the left edge, else on the front edge:
      // its +t wall is `fit` beyond where the tab's edge lands.
      if (s.shared.left) {
        const sk = jp.sockets.filter(r => r.x0 < g.lat.xL + 1e-9).reduce((a, r) => (!a || r.y1 > a.y1) ? r : a, null);
        if (sk) {
          const x = (sk.x0 + sk.x1) / 2;
          dims.push({ param: 'jointFit', label: 'clearance', from: pl(x, sk.y1 - s.fit, z), to: pl(x, sk.y1, z), offset: 8 });
        }
      } else {
        const sk = jp.sockets.filter(r => r.y0 < g.lat.yF + 1e-9).reduce((a, r) => (!a || r.x1 > a.x1) ? r : a, null);
        if (sk) {
          const y = (sk.y0 + sk.y1) / 2;
          dims.push({ param: 'jointFit', label: 'clearance', from: pl(sk.x1 - s.fit, y, z), to: pl(sk.x1, y, z), offset: 8 });
        }
      }
    }
  }

  // The engraving: pocket depth along the face normal at the leftmost point of the ink.
  if (lab && lab.panel && lab.panel.ink && lab.panel.ink.length) {
    let v = null;
    for (const shape of lab.panel.ink) for (const ring of shape) for (const q of ring) if (!v || q[0] < v[0]) v = q;
    if (v) {
      const a = lab.panel.to3(v[0], v[1], 0), b = lab.panel.to3(v[0], v[1], lab.depth);
      dims.push({ param: 'labelDepth', label: 'engrave', from: pl(a[0], a[1], a[2]), to: pl(b[0], b[1], b[2]),
        offset: lab.where === 'front' ? [0, -1, 0] : [0, 0, -1],
        ...(Math.abs(lab.depth - s.labelDepth) > 1e-6 ? { value: r3(lab.depth) } : {}) });
    }
  }
  return dims;
}

function build(p, ctx = {}) {
  const s = settings(p, ctx);
  const g = tileGrid(s);
  let lab = planLabel(s, g, ctx);

  let healed = assemble(g, lab);
  if (lab.panel && meshLeaks(healed) > 0) {
    const why = 'the engraving could not be cut without holing the shell, so it was left off';
    lab = { where: 'none', notes: [...(lab.notes || []), why], why };
    healed = assemble(g, lab);
  }
  const dims = terrainDims(p, s, g, lab, healed.bbox());
  const mesh = healed.place();

  const b = mesh.bbox();
  const scaleN = s.mmPerM > 0 ? 1000 / s.mmPerM : 0;
  const provenance =
    s.src.source === 'ridge'
      ? { kind: 'synthetic', name: 'Ridge (synthetic)',
          statement: 'THIS IS NOT A PLACE. It is the generator\'s own synthetic ridge — two summits, ' +
                     'a valley and a plateau — and no measurement of anywhere.' }
    : s.src.source === 'field'
      ? { kind: 'supplied', name: s.place,
          statement: `Elevation supplied to the generator${s.prep.meta.dataset ? ` (${s.prep.meta.dataset})` : ''}.` }
      : { kind: 'bundled', name: s.place,
          statement: `Bundled SRTM sample "${s.src.source}"${s.prep.meta.dataset ? ` (${s.prep.meta.dataset})` : ''}, ` +
                     'fetched once from opentopodata.org and shipped with Bluesheet.' };
  // A fallback that reads like a first choice is the one dishonest thing this
  // generator could do, so the reason goes in the sentence, not in a field
  // beside it that a caller has to think to look at.
  if (s.src.fallback && s.src.why) {
    provenance.askedFor = typeof p.source === 'string' ? p.source : 'field';
    provenance.fallbackFrom = s.src.why;
    provenance.statement += ` This is a fallback: ${s.src.why}.`;
  }

  return {
    mesh,
    meta: {
      dims,
      place: s.place,
      coordinates: isFinite(s.lat) && isFinite(s.lon)
        ? { lat: s.lat, lon: s.lon, text: coordString(s.lat, s.lon) } : null,
      data: provenance,
      ground: { widthKm: s.gW / 1000, heightKm: s.gH / 1000, how: s.prep.ground.how,
                sourceGrid: `${s.prep.w}×${s.prep.h}`,
                metresPerSample: s.gW / Math.max(1, s.prep.w - 1),
                voidsFilled: s.prep.voids, allVoid: s.prep.allVoid },
      scale: { mmPerGroundMetre: s.mmPerM, printed: scaleN ? `1:${Math.round(scaleN).toLocaleString('en-GB')}` : 'n/a',
               ratio: scaleN, isotropic: true },
      vertical: { mode: s.vMode, exaggeration: s.exaggeration, mmPerMetre: s.vScale,
                  reliefMm: s.reliefMm, datumM: s.datumM, plinthMm: s.plinth,
                  totalMm: s.plinth + s.reliefMm },
      elevation: { minM: s.prep.minM, maxM: s.prep.maxM, rangeM: s.prep.maxM - s.prep.minM,
                   seaPlane: s.sea ? s.seaM : null },
      tile: { x: s.tileX, y: s.tileY, cols: s.cols, rows: s.rows,
              index: s.tileY * s.cols + s.tileX + 1, of: s.cols * s.rows,
              widthMm: s.tileW, depthMm: s.tileH,
              shared: { ...s.shared } },
      joint: s.useJoint
        ? { kind: s.joint, clearanceMm: s.fit,
            // Named for the axis each number runs along, because "the joint on
            // the X edge" is 14 mm in one direction and 5 mm in the other and
            // one label for both is how a test ends up measuring the wrong plane.
            widthAlongYMm: g.jp.spanY, widthAlongXMm: g.jp.spanX,
            depthIntoXMm: g.jp.reachX, depthIntoYMm: g.jp.reachY,
            budgetWidthMm: 2 * Math.min(s.jointYHalf, s.jointXHalf), budgetDepthMm: Math.min(s.depthX, s.depthY),
            tabs: g.jp.tabs.length, sockets: g.jp.sockets.length,
            note: 'Tabs on +X/+Y, sockets on -X/-Y. Drop the next tile straight down onto them.' }
        : { kind: 'none', note: s.joint === 'none' ? 'No joint asked for.' : 'This tile has no neighbours to join to.' },
      sides: { kind: s.draughted ? 'draught' : 'vertical',
               askedDeg: s.draughtDeg,
               actualDeg: s.draughted ? Math.atan2(s.flare, g.bandTop) / DEG : 0,
               bandMm: g.bandTop,
               note: s.draughted ? 'Only edges without a neighbour lean; shared edges stay vertical.' : '' },
      label: lab.where === 'none'
        ? { face: 'none', why: s.label === 'none' ? 'not asked for' : (lab.why || 'no face could take it') }
        : { face: lab.where, text: lab.text, capMm: lab.cap, depthMm: lab.depth,
            missing: (lab.missing && lab.missing.length) ? lab.missing : undefined,
            movedFrom: (s.label === 'front' && lab.where === 'underside') ? 'front' : undefined,
            notes: lab.notes && lab.notes.length ? lab.notes : undefined },
      grid: { cols: g.nc, rows: g.nr, lattice: `${g.lat.nx}×${g.lat.ny} per tile`,
              samples: s.samples, capped: g.lat.capped, smoothPasses: s.smooth },
      size: { x: b.size[0], y: b.size[1], z: b.size[2] },
      triangles: mesh.triCount,
    },
  };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validate(p) {
  const issues = [];
  let s;
  try { s = settings(p, {}); }
  catch (e) { return [{ param: 'source', severity: 'error', message: `This field could not be prepared: ${e.message}` }]; }

  // --- the data ------------------------------------------------------------
  if (s.src.fallback) {
    issues.push({ param: 'source', severity: 'warn',
      message: `${s.src.why}. What you are looking at is ${s.src.source === 'ridge'
        ? 'the synthetic ridge, which is not a place'
        : `the bundled "${s.src.source}" sample`}. The mesh meta says the same thing.` });
  }
  if (s.prep.allVoid) {
    issues.push({ param: 'field', severity: 'error',
      message: 'Every sample in this field is the no-data sentinel, so there is nothing to interpolate from. The synthetic ridge was built instead.' });
  } else if (s.prep.voids > 0) {
    const pct = 100 * s.prep.voids / (s.prep.w * s.prep.h);
    issues.push({ param: 'field', severity: pct > 20 ? 'warn' : 'info',
      message: `${s.prep.voids} of ${s.prep.w * s.prep.h} samples (${pct.toFixed(1)}%) were no-data and have been filled by harmonic interpolation. The patch cannot contain a peak the surrounding data did not imply, but it is invented ground, not measured ground.` });
  }
  if (fieldProblems().length) {
    issues.push({ param: 'source', severity: 'info', message: `Bundled fields that would not load: ${fieldProblems().join('; ')}.` });
  }

  // --- vertical ------------------------------------------------------------
  if (s.sea && s.seaM >= s.prep.maxM) {
    issues.push({ param: 'seaLevelM', severity: 'error',
      message: `A sea level of ${s.seaM.toFixed(0)} m is at or above the highest ground here (${s.prep.maxM.toFixed(0)} m). Everything drowns and the tile comes out as a flat plate ${s.plinth.toFixed(1)} mm thick.` });
  } else if (s.sea && s.seaM > s.prep.minM + 0.85 * (s.prep.maxM - s.prep.minM)) {
    issues.push({ param: 'seaLevelM', severity: 'warn',
      message: `A sea level of ${s.seaM.toFixed(0)} m floods all but the top ${(s.prep.maxM - s.seaM).toFixed(0)} m of ${(s.prep.maxM - s.prep.minM).toFixed(0)} m of range. Only ${(100 * (s.prep.maxM - s.seaM) / Math.max(1e-9, s.prep.maxM - s.prep.minM)).toFixed(0)}% of the relief survives.` });
  }
  const liveRangeM = s.prep.maxM - s.datumM;
  if (s.reliefMm < 1.5) {
    // With no range left there is nothing to raise: saying "exaggerate it eight
    // billion times" is arithmetically true and useless, and it is what this
    // said before the sea-level case was tried.
    const cure = liveRangeM < 1e-6
      ? 'There is no elevation range left to scale, so no amount of exaggeration will help — lower the sea level or use a place with some relief in it'
      : s.vMode === 'relief' ? 'Ask for at least 4 mm of relief'
      : `Raise the exaggeration to about ${Math.max(1, Math.ceil(4 / Math.max(1e-9, s.reliefMm) * s.exaggeration))}×`;
    issues.push({ param: s.vMode === 'relief' ? 'relief' : 'exaggeration', severity: s.reliefMm < 0.6 ? 'error' : 'warn',
      message: `${s.reliefMm.toFixed(2)} mm of relief over a ${liveRangeM.toFixed(0)} m range. At a 0.2 mm layer that is ${Math.max(0, Math.round(s.reliefMm / 0.2))} layers for the whole landscape, so the map reads as a flat plate. ${cure}.` });
  }
  const st = steepest(s);
  if (st.deg > 72) {
    issues.push({ param: 'exaggeration', severity: st.deg > 82 ? 'error' : 'warn',
      message: `The steepest ground here is ${(Math.atan(st.groundGrad) / DEG).toFixed(0)}°, and ${s.exaggeration.toFixed(1)}× exaggeration prints it at ${st.deg.toFixed(0)}° — past the ~70° an FDM printer holds without support. Drop to about ${(Math.tan(65 * DEG) / Math.max(1e-9, st.groundGrad)).toFixed(1)}× or print it with supports.` });
  }

  // --- the bed -------------------------------------------------------------
  const bed = 180;
  const sideFlare = (s.shared.left ? 0 : s.flare) + (s.shared.right ? 0 : s.flare);
  const endFlare = (s.shared.front ? 0 : s.flare) + (s.shared.back ? 0 : s.flare);
  const wX = s.tileW + sideFlare + (s.useJoint && s.shared.right ? s.depthY : 0);
  const wY = s.tileH + endFlare + (s.useJoint && s.shared.back ? s.depthX : 0);
  const wZ = s.plinth + s.reliefMm;
  if (wX > bed || wY > bed || wZ > bed) {
    issues.push({ param: wZ > bed ? (s.vMode === 'relief' ? 'relief' : 'exaggeration') : 'size', severity: 'error',
      message: `This tile is ${wX.toFixed(0)}×${wY.toFixed(0)}×${wZ.toFixed(0)} mm and the bed is ${bed}×${bed}×${bed}. ${wZ > bed ? `The height is the problem — ${s.reliefMm.toFixed(0)} mm of relief at ${s.exaggeration.toFixed(1)}×.` : `Reduce the map to about ${Math.floor(s.size * bed / Math.max(wX, wY))} mm, or split it across more tiles.`}` });
  }
  if (s.plinth < 2) {
    issues.push({ param: 'plinth', severity: 'warn',
      message: `A ${s.plinth.toFixed(1)} mm plinth is ${Math.round(s.plinth / 0.2)} layers. It will print, but a map this size will curl off the bed at the corners — 4 mm is about the floor for anything over 80 mm across.` });
  }

  // --- joints --------------------------------------------------------------
  if (s.joint !== 'none' && !s.anyShared) {
    issues.push({ param: 'joint', severity: 'info',
      message: `A ${s.joint} joint was asked for, but this is a ${s.cols}×${s.rows} map: the tile has no neighbours, so no joint was cut.` });
  } else if (s.useJoint) {
    if (s.fit < 0.08) {
      issues.push({ param: 'jointFit', severity: 'warn',
        message: `${s.fit.toFixed(2)} mm of clearance is finer than a 0.4 mm nozzle places a wall. The tiles will not go together without sanding; 0.15 mm is the usual figure.` });
    } else if (s.fit > 0.35) {
      issues.push({ param: 'jointFit', severity: 'info',
        message: `${s.fit.toFixed(2)} mm of clearance will rattle. The joint still locates the tiles, but the seam will show a ${(2 * s.fit).toFixed(1)} mm gap.` });
    }
    if (2 * s.jointYHalf < s.jointWanted - 1e-6 || 2 * s.jointXHalf < s.jointWanted - 1e-6) {
      issues.push({ param: 'jointSize', severity: 'info',
        message: `A ${s.jointWanted.toFixed(0)} mm joint will not fit on a ${Math.min(s.tileW, s.tileH).toFixed(0)} mm tile edge; it was cut back to ${(2 * Math.min(s.jointYHalf, s.jointXHalf)).toFixed(1)} mm so it takes at most 80% of the edge.` });
    }
    if (s.joint === 'pin') {
      issues.push({ param: 'joint', severity: 'info',
        message: 'Pins locate the tiles but do not lock them — they can still be pulled apart in the plane. Use the dovetail if the map is going on a wall.' });
    }
  }
  if (s.draughted && s.anyShared) {
    issues.push({ param: 'sides', severity: 'info',
      message: `Draught is applied only to the ${[!s.shared.left && 'left', !s.shared.right && 'right', !s.shared.front && 'front', !s.shared.back && 'back'].filter(Boolean).join(', ') || 'no'} edge(s). A shared edge has to stay vertical or it cannot butt against its neighbour.` });
  }

  // --- detail and the label -------------------------------------------------
  const perSample = s.gW / Math.max(1, s.prep.w - 1);
  const perModelSample = s.tileW / Math.max(2, Math.round(s.samples * s.tileW / Math.max(s.tileW, s.tileH)));
  if (perModelSample * (s.gW / Math.max(1e-9, s.mapW)) < perSample * 0.5) {
    issues.push({ param: 'samples', severity: 'info',
      message: `You are asking for a ${perModelSample.toFixed(2)} mm sample pitch from data that is ${perSample.toFixed(0)} m — about ${(perSample * s.mmPerM).toFixed(2)} mm — apart. The extra samples are interpolation, not detail; they cost triangles and print time and add nothing the data knows.` });
  }
  {
    const lat0 = lattice(s);
    if (lat0.capped) {
      issues.push({ param: 'samples', severity: 'info',
        message: `${s.samples} samples per tile at this quality would be more than ${MAX_CELLS / 1000}k cells, so the grid was capped at ${lat0.nx}×${lat0.ny} — an effective ${(s.tileW / lat0.nx).toFixed(3)} mm pitch. Every tile of the map is capped identically, so the seams are unaffected.` });
    }
  }
  if (s.label !== 'none') {
    let g = null;
    try { g = tileGrid(s); } catch { g = null; }
    if (g) {
      const lab = planLabel(s, g, {});
      if (lab.where === 'none') {
        issues.push({ param: 'label', severity: 'warn',
          message: `The label could not be cut: ${lab.why}. Raise the plinth, make the tile bigger or shorten the text.` });
      } else {
        if (lab.where !== s.label) {
          issues.push({ param: 'label', severity: 'info',
            message: `Asked for the front face, engraved underneath instead — ${lab.notes[lab.notes.length - 1]}.` });
        }
        if (lab.itemsWanted > lab.items) {
          issues.push({ param: 'label', severity: 'info',
            message: `${lab.itemsWanted - lab.items} of the ${lab.itemsWanted} label lines were dropped so the rest could be set at a ${lab.cap.toFixed(1)} mm cap height on a ${lab.where === 'front' ? `${(2 * (s.plinth)).toFixed(0)} mm front band` : 'panel'} this size. ${lab.where === 'front' ? 'Engrave it underneath, or raise the plinth' : 'Make the tile bigger, or turn the coordinates off'}, to keep all of it.` });
        }
        if (lab.cap < 2.2) {
          issues.push({ param: 'labelText', severity: 'info',
            message: `The text came out at a ${lab.cap.toFixed(1)} mm cap height. Under about 2.5 mm an engraved letter on a 0.4 mm nozzle is a groove rather than a letter — shorten the text or turn the coordinates off.` });
        }
        if (lab.missing && lab.missing.length) {
          issues.push({ param: 'labelText', severity: 'warn',
            message: `This typeface has no glyph for ${lab.missing.slice(0, 6).map(c => `"${c}"`).join(', ')}; those characters were dropped.` });
        }
        if (s.labelDepth < 0.3) {
          issues.push({ param: 'labelDepth', severity: 'info',
            message: `${s.labelDepth.toFixed(2)} mm is one or two layers deep. It reads in raking light and disappears in flat light; 0.6 mm is the usual figure for an engraved name.` });
        }
      }
    }
  }
  if (labelFontProblems().length && s.label !== 'none') {
    issues.push({ param: 'labelFont', severity: 'warn',
      message: `Typefaces that would not load: ${labelFontProblems().join('; ')}.` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

function hints(p) {
  let s;
  try { s = settings(p, {}); } catch {
    return { profile: '0.16 mm', layerH: 0.16, infill: 15, supports: false,
             filament: 'PLA', notes: ['This field could not be prepared.'] };
  }
  const st = steepest(s);
  const scaleN = s.mmPerM > 0 ? Math.round(1000 / s.mmPerM) : 0;

  // The layer height is chosen against what the relief actually carries. There
  // is no point at 0.08 mm layers on a tile whose whole landscape is 6 mm tall:
  // the contour interval a layer is worth is what decides it.
  const layerH = s.reliefMm > 60 ? 0.24 : s.reliefMm > 25 ? 0.2 : s.reliefMm > 10 ? 0.16 : 0.12;
  const metresPerLayer = s.vScale > 0 ? layerH / s.vScale : Infinity;
  const layersOfRelief = Math.max(0, Math.round(s.reliefMm / layerH));
  const lat = lattice(s);
  const pitch = s.tileW / lat.nx;

  const notes = [
    `Horizontal scale 1:${scaleN.toLocaleString('en-GB')} — ${s.mmPerM.toFixed(4)} mm of model per metre of ground, the SAME number in X and Y. ` +
    `The tile covers ${(s.gW / s.cols / 1000).toFixed(2)} × ${(s.gH / s.rows / 1000).toFixed(2)} km at ${isFinite(s.lat) ? `${Math.abs(s.lat).toFixed(2)}°${s.lat >= 0 ? 'N' : 'S'}` : 'an unstated latitude'}, ` +
    `where a degree of longitude is only ${(metresPerDegLon(s.lat || 0) / metresPerDegLat(s.lat || 0) * 100).toFixed(0)}% of a degree of latitude. That correction is already in the numbers above.`,

    `Vertical scale ${s.vScale.toFixed(4)} mm per metre — ${s.exaggeration.toFixed(2)}× exaggerated. ` +
    `${(s.prep.maxM - s.datumM).toFixed(0)} m of range becomes ${s.reliefMm.toFixed(1)} mm of relief on a ${s.plinth.toFixed(1)} mm plinth. ` +
    `Say the exaggeration out loud when you show someone the print: at true scale this landscape would be ${(s.reliefMm / Math.max(1e-9, s.exaggeration)).toFixed(1)} mm tall.`,

    `${layerH.toFixed(2)} mm layers. That is the contour interval of the print: one layer is ` +
    `${metresPerLayer < 1000 ? `${metresPerLayer < 1 ? metresPerLayer.toFixed(2) : metresPerLayer.toFixed(0)} m` : 'more than a kilometre'} ` +
    `of elevation here, and the whole landscape is ${layersOfRelief} layers. ` +
    (metresPerLayer > 1.5
      ? `SRTM is quantised to whole metres, which at this vertical scale is ${s.vScale.toFixed(4)} mm, so the LAYER is the coarser of the two by about ${metresPerLayer.toFixed(0)}× — going finer vertically really does buy more contour here, at a cost in time.`
      : `SRTM is quantised to whole metres, which at this vertical scale is ${s.vScale.toFixed(3)} mm, so the DATA is the coarser of the two: a finer layer height would only reproduce the one-metre steps in the source more faithfully.`) +
    ` Across the tile the samples are ${pitch.toFixed(2)} mm apart, about ${(pitch / 0.4).toFixed(1)} nozzle widths.`,

    `3 or 4 perimeters, and this is the setting that matters most. On a terrain tile the outer wall IS the surface — every ridge line is a perimeter following a contour — so drop the outer wall speed to 25–30 mm/s. Ringing after a sharp spur prints as a ghost ridge across the next 10 mm of hillside, and no amount of infill hides it.`,

    `15% infill with 4 top layers. The plinth is a ${(s.tileW * s.tileH / 100).toFixed(0)} cm² flat slab, and under a large flat slab low infill sags between the ribs and telegraphs a grid through the first millimetre of landscape. If the underside is the face you will look at, use 20% gyroid and 5 bottom layers instead.`,
  ];

  const supports = st.deg > 70;
  notes.push(supports
    ? `Supports: yes, and reluctantly. The steepest ground is ${(Math.atan(st.groundGrad) / DEG).toFixed(0)}°, which ${s.exaggeration.toFixed(1)}× exaggeration prints at ${st.deg.toFixed(0)}°. Anything past about 70° droops. Supports on a landscape leave marks exactly where the interesting geology is, so it is nearly always better to drop the exaggeration instead.`
    : `No supports. The steepest printed slope on this tile is ${st.deg.toFixed(0)}° from horizontal — ${(Math.atan(st.groundGrad) / DEG).toFixed(0)}° of real ground at ${s.exaggeration.toFixed(1)}× — and an FDM printer holds ${'~70°'} unsupported. The sides are ${s.draughted ? `draughted ${s.draughtDeg.toFixed(0)}° outward, so every layer sits inside the one below it` : 'vertical'}, and the underside is flat on the plate.`);

  if (s.sea) {
    notes.push(`The sea plane at ${s.seaM.toFixed(0)} m is a true plane, not a dent: everything below it is clamped to exactly that height, so it slices as one flat surface at z = ${s.plinth.toFixed(1)} mm and irons beautifully if you want the water to read differently from the land.`);
  }
  if (s.useJoint) {
    notes.push(`Joint: ${s.joint}, ${(2 * s.jointYHalf).toFixed(1)} mm across and ${s.depthY.toFixed(1)} mm deep, with ${s.fit.toFixed(2)} mm of clearance per side. Tabs are on the +X and +Y edges and sockets on -X and -Y, cut right through, so the next tile drops straight down onto them. Print every tile of a map with the SAME settings — the vertical scale is taken from the whole map's range, so a tile built at different settings will step at the seam. Do not use a brim: it welds into the socket mouths.`);
  } else {
    notes.push('No brim needed if the plinth is 4 mm or more — the footprint is large and flat. On a cold day, or with the draughted sides, put a 3 mm brim on the two long edges only.');
  }
  notes.push(`Filament: a matte PLA or PLA-Silk in a mid tone. Gloss and pale grey both hide relief — the shadows are what you read a terrain model with, and a shiny surface fills them in. Print it flat, exactly as it comes out of Bluesheet; standing it on edge would put the layer lines across the contours.`);
  if (lat.capped) {
    notes.push(`The sample grid was capped at ${lat.nx}×${lat.ny} per tile — a ${pitch.toFixed(3)} mm pitch — to keep the mesh under half a million triangles. Every tile of a map is capped identically, so this does not open a seam.`);
  }
  if (s.src.fallback) {
    notes.push(`Note: ${s.src.why}. ${s.src.source === 'ridge' ? 'This is the synthetic ridge, not a place.' : `This is the bundled "${s.src.source}" sample.`}`);
  }

  return {
    profile: `${layerH.toFixed(2)} mm, 15% infill`,
    layerH, infill: 15, perimeters: 4, topLayers: 4, bottomLayers: 4,
    supports, filament: 'Matte PLA',
    brim: !s.useJoint && s.plinth < 4,
    scale: { horizontal: `1:${scaleN.toLocaleString('en-GB')}`, verticalExaggeration: s.exaggeration,
             metresPerLayer, mmPerGroundMetre: s.mmPerM },
    notes,
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const params = [
  // --- Place ---------------------------------------------------------------
  { key: 'source', label: 'Place', type: 'enum', def: 'avon-gorge', group: 'Place',
    options: [
      ...BUNDLED_FIELDS.map(f => ({ v: f.id, label: f.label, help: f.help })),
      { v: 'field', label: 'Elevation you supply', help: 'Use the field passed in below. Falls back to a bundled sample if none arrives.' },
      { v: 'ridge', label: 'Sample ridge (synthetic)', help: 'Not a place. A built-in ridge with two summits, a valley and a plateau, for trying settings out.' },
    ],
    help: 'Three real SRTM 30 m samples ship with Bluesheet, so this works with no network at all. Whatever it ends up using is stated in the mesh meta.' },
  { key: 'field', label: 'Elevation data', type: 'field', group: 'Place',
    showIf: (p) => p.source === 'field',
    help: 'A {w, h, data} grid of metres above sea level, plus lat/lon and either a degree box or a ground span so the scale can be worked out. No-data sentinels are interpolated away.' },
  { key: 'smooth', label: 'Smoothing passes', type: 'int', def: 1, min: 0, max: 6, step: 1, group: 'Place',
    help: 'SRTM is quantised to whole metres and one pass takes the staircase off a shallow slope without touching a ridge line. Three or more starts eating real geology.' },

  // --- Size ----------------------------------------------------------------
  { key: 'size', label: 'Map size', type: 'number', def: 100, min: 20, max: 180, step: 1, unit: 'mm', group: 'Size',
    help: 'The long edge of the WHOLE map, before it is split into tiles. The short edge follows the ground, so the map is never stretched.' },
  { key: 'plinth', label: 'Plinth thickness', type: 'number', def: 6, min: 1, max: 30, step: 0.5, unit: 'mm', group: 'Size',
    help: 'The flat slab under the landscape. It gives the tile a real bottom face instead of a knife edge, and it is what the name is engraved into.' },

  // --- Vertical ------------------------------------------------------------
  { key: 'vMode', label: 'Height set by', type: 'enum', def: 'exaggeration', group: 'Vertical',
    options: [
      { v: 'exaggeration', label: 'Exaggeration factor', help: 'Vertical scale as a multiple of the horizontal. Honest, and comparable between maps.' },
      { v: 'relief', label: 'Relief height in mm', help: 'Ask for a fixed height of landscape and let the exaggeration fall out of it.' },
    ],
    help: 'Every printed terrain tile is exaggerated — at true scale the Avon Gorge on a 100 mm tile is 3.5 mm tall. The point is to state it, not to avoid it.' },
  { key: 'exaggeration', label: 'Vertical exaggeration', type: 'number', def: 2, min: 0.25, max: 20, step: 0.25, unit: '×', group: 'Vertical',
    showIf: (p) => p.vMode !== 'relief',
    help: '1 is true scale. 2 to 4 is the readable range for British hills; past about 8 the slopes overhang and want supports.' },
  { key: 'relief', label: 'Relief height', type: 'number', def: 18, min: 0.5, max: 140, step: 0.5, unit: 'mm', group: 'Vertical',
    showIf: (p) => p.vMode === 'relief',
    help: 'Height from the lowest ground to the highest, above the plinth. hints() reports what exaggeration that worked out to.' },
  { key: 'sea', label: 'Sea plane', type: 'bool', def: false, group: 'Vertical',
    help: 'Flatten everything below a level to one plane at that level. A plane, not a dent — it slices as a single flat surface.' },
  { key: 'seaLevelM', label: 'Sea level', type: 'number', def: 0, min: -100, max: 4000, step: 1, unit: 'm', group: 'Vertical',
    showIf: (p) => !!p.sea,
    help: 'Metres above datum. 0 is the real coastline; raise it to flood a valley and see what would be left as islands.' },

  // --- Tiling --------------------------------------------------------------
  { key: 'cols', label: 'Tiles across', type: 'int', def: 1, min: 1, max: 4, step: 1, group: 'Tiling',
    help: 'Split the map into a grid and print one tile at a time. The vertical scale is taken from the WHOLE map, so the tiles cannot step at the seams.' },
  { key: 'rows', label: 'Tiles up', type: 'int', def: 1, min: 1, max: 4, step: 1, group: 'Tiling',
    help: 'Rows of tiles, north-south. A 2×2 of a 180 mm map gives four 90 mm tiles that join into one 360 mm wall map.' },
  { key: 'tileX', label: 'This tile: column', type: 'int', def: 0, min: 0, max: 3, step: 1, group: 'Tiling',
    help: 'Which tile to build, counting from the west. Build them one at a time with everything else identical.' },
  { key: 'tileY', label: 'This tile: row', type: 'int', def: 0, min: 0, max: 3, step: 1, group: 'Tiling',
    help: 'Which tile to build, counting from the south.' },
  { key: 'joint', label: 'Edge joint', type: 'enum', def: 'dovetail', group: 'Tiling',
    options: [
      { v: 'none', label: 'None', help: 'Butt the tiles together and glue, or just lay them side by side.' },
      { v: 'tab', label: 'Straight tab', help: 'A plain tongue and slot. Locates the tiles; does not stop them being pulled apart.' },
      { v: 'dovetail', label: 'T dovetail', help: 'A narrow neck with a wider head, cut right through, so the tiles lock in the plane and the next one drops straight down onto it.' },
      { v: 'pin', label: 'Two pins', help: 'A pair of small square pegs. Least material, quickest to print, purely locating.' },
    ],
    help: 'Cut on shared edges only: tabs on the +X and +Y sides of a tile, matching sockets on -X and -Y, so tile (0,0) mates with tile (1,0).' },
  { key: 'jointSize', label: 'Joint width', type: 'number', def: 14, min: 4, max: 40, step: 0.5, unit: 'mm', group: 'Tiling',
    help: 'Measured along the edge. Capped at 80% of the edge so a narrow tile does not become a tab with a map attached.' },
  { key: 'jointFit', label: 'Joint clearance', type: 'number', def: FIT.snug, min: 0, max: 0.6, step: 0.05, unit: 'mm', group: 'Tiling',
    help: 'Printed clearance per side, taken out of the socket rather than the tab. 0.15 mm is a firm push fit on a 0.4 mm nozzle; 0 will not go together.' },

  // --- Finish --------------------------------------------------------------
  { key: 'sides', label: 'Side walls', type: 'enum', def: 'vertical', group: 'Finish',
    options: [
      { v: 'vertical', label: 'Vertical', help: 'Tiles flush against a neighbour and against a wall.' },
      { v: 'draught', label: 'Draughted', help: 'Flared outward towards the plate, so every layer sits inside the one below it and the tile releases cleanly.' },
    ],
    help: 'Draught is applied only to edges with no neighbour — a leaning edge cannot butt up against the tile beside it.' },
  { key: 'draughtDeg', label: 'Draught angle', type: 'number', def: 5, min: 0, max: 15, step: 0.5, unit: '°', group: 'Finish',
    showIf: (p) => p.sides === 'draught',
    help: 'From vertical. 5° is plenty to break the first-layer elephant foot; 15° is a visible bevel.' },
  { key: 'samples', label: 'Samples per tile', type: 'int', def: 96, min: 12, max: 200, step: 1, group: 'Finish',
    help: 'Across the tile’s long edge, before the draft/fine quality multiplier. Past the source grid’s own resolution the extra samples are interpolation, not detail.' },

  // --- Label ---------------------------------------------------------------
  { key: 'label', label: 'Engraved label', type: 'enum', def: 'front', group: 'Label',
    options: [
      { v: 'none', label: 'None', help: 'No lettering at all.' },
      { v: 'front', label: 'Front edge', help: 'Into the plinth band on the south face, where you read it with the map flat on a table.' },
      { v: 'underside', label: 'Underneath', help: 'Into the bottom face. Invisible in use, and the right place on a tiled map where the front edge is a joint.' },
    ],
    help: 'Real TrueType outlines cut as a pocket, not an overlaid solid. If the chosen face cannot take it the label moves underneath and the meta says so.' },
  { key: 'labelText', label: 'Label text', type: 'text', def: '', maxLength: 40, group: 'Label',
    help: 'Leave empty to use the place name from the data. The coordinates and the tile number are added as their own lines.' },
  { key: 'coords', label: 'Add coordinates', type: 'bool', def: true, group: 'Label',
    help: 'Latitude and longitude of the field’s centre, to four decimals — about 11 m, which is finer than the 30 m data.' },
  { key: 'labelFont', label: 'Typeface', type: 'enum', def: DEFAULT_LABEL_FONT, group: 'Label',
    options: LABEL_FONTS.map(f => ({ v: f.id, label: f.label, help: f.help })),
    help: 'All three are TrueType outline faces bundled with Bluesheet; the licences sit beside them.' },
  { key: 'labelDepth', label: 'Engraving depth', type: 'number', def: 0.6, min: MIN_POCKET_MM, max: 2, step: 0.05, unit: 'mm', group: 'Label',
    help: `Below ${MIN_POCKET_MM} mm a pocket is not a pocket. 0.6 mm — three layers — is the usual figure for a name that reads in flat light.` },
];

export default {
  id: 'terrain',
  name: 'Terrain Tile',
  category: 'Decor',
  blurb: 'A real place as a solid you can hold: SRTM elevation, correctly scaled, with a stated exaggeration.',
  description:
    'Real elevation data becomes a tile you can hold. Three SRTM 30 m samples ship with Bluesheet — the ' +
    'Avon Gorge, Snowdon and Cheddar Gorge — so it builds a real place with no network at all, and it ' +
    'says in the mesh meta exactly where the ground came from. The horizontal scale is isotropic after ' +
    'the latitude correction, which matters more than it sounds: a degree of longitude at 51°N is 62% ' +
    'of a degree of latitude, and a map that ignores that is squashed by nearly half without saying so. ' +
    'The vertical exaggeration is an explicit number rather than a secret, and hints() states the ' +
    'printed scale, the exaggeration and how many metres of elevation one layer of plastic is worth. ' +
    'A map can be split across up to sixteen tiles that print separately and interlock: every vertical ' +
    'constant is taken from the whole map and every shared edge is sampled at whole-map indices, so two ' +
    'neighbours meet without a step. Optional sea plane, draughted or vertical sides, and the place ' +
    'name and its coordinates engraved in real font outlines.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 16.5l5-7 3.5 4.5 3-4 7.5 6.5z"/><path d="M2.5 16.5v3h19v-3"/><path d="M7.5 9.5l1.6 2.2"/></svg>',
  version: 1,
  params,
  presets: [
    { name: 'Snowdon on the mantelpiece', values: {
      source: 'snowdon', size: 130, plinth: 7, vMode: 'exaggeration', exaggeration: 1.6,
      sea: false, cols: 1, rows: 1, joint: 'none', sides: 'vertical', samples: 120,
      label: 'front', coords: true, labelDepth: 0.6, smooth: 1 } },

    { name: 'Avon Gorge wall map, first of four', values: {
      source: 'avon-gorge', size: 160, plinth: 5, vMode: 'exaggeration', exaggeration: 3.5,
      cols: 2, rows: 2, tileX: 0, tileY: 0, joint: 'dovetail', jointSize: 18, jointFit: 0.15,
      sides: 'vertical', samples: 110, label: 'underside', coords: true, smooth: 1 } },

    { name: 'Cheddar Gorge paperweight', values: {
      source: 'cheddar-gorge', size: 90, plinth: 11, vMode: 'exaggeration', exaggeration: 2.5,
      sea: false, cols: 1, rows: 1, joint: 'none', sides: 'draught', draughtDeg: 7,
      samples: 130, label: 'underside', coords: true, labelDepth: 0.7, smooth: 1 } },

    { name: 'Snowdon flooded to 400 m', values: {
      source: 'snowdon', size: 120, plinth: 6, vMode: 'relief', relief: 26,
      sea: true, seaLevelM: 400, cols: 1, rows: 1, joint: 'none', sides: 'vertical',
      samples: 110, label: 'front', labelText: 'Yr Wyddfa at 400 m', coords: false, smooth: 2 } },

    { name: 'Pocket tile for a coat pocket', values: {
      source: 'cheddar-gorge', size: 45, plinth: 3, vMode: 'exaggeration', exaggeration: 4,
      cols: 1, rows: 1, joint: 'none', sides: 'draught', draughtDeg: 10, samples: 64,
      label: 'underside', coords: false, labelText: 'Cheddar', labelDepth: 0.4, smooth: 2 } },

    { name: 'Settings tryout on the sample ridge', values: {
      source: 'ridge', size: 110, plinth: 6, vMode: 'exaggeration', exaggeration: 1.5,
      cols: 1, rows: 1, joint: 'none', sides: 'vertical', samples: 90,
      label: 'front', labelText: 'Not a place', coords: false, smooth: 1 } },
  ],
  build,
  validate,
  hints,
};
