// vase — vases and spiral-mode vessels.
//
// The whole object is one scalar field, r(φ, z): a SILHOUETTE curve gives the
// radius at each height, a CROSS-SECTION gives the unit radius at each angle,
// and the surface treatments (twist, ribs, flutes, faceting, noise) modify one
// or the other. Because the surface is defined as a radius per (angle, height)
// rather than as a set of points, every horizontal section is *star-shaped by
// construction*: a ray from the axis leaves it exactly once. That is not a
// cosmetic property. It is the precondition for spiral (vase) mode, and it is
// the reason this generator can promise something a mesh boolean could not.
//
// WHY THAT MATTERS, IN THE ONLY UNITS THAT COUNT
// A spiral-mode print is one continuous extrusion from the first layer to the
// last: no seam, no travel, no retraction. The slicer achieves it by keeping a
// single perimeter loop per layer and lifting Z continuously along it. Hand it
// a model whose section is *not* single-valued in angle — a cross-section deep
// enough to fold back through its own axis — and Orca does not refuse. It
// silently resolves the contradiction its own way and prints a solid brick with
// a clean exit code. This laptop has produced one. So:
//
//   * the field is clamped at R_MIN so a fold-back cannot be built at all, and
//   * validate() reports the parameter that drove it there, by name, before the
//     slicer ever sees the mesh.
//
// TWO MODES, ONE BODY
//   spiral — the wall in the MODEL is one extrusion width, taken from the
//            nozzle, because in vase mode the wall thickness is the printer's
//            decision and not the designer's. The mesh is still a closed solid:
//            outer skin, solid floor, cavity, and a rim one extrusion wide. It
//            is open at the top, which is what makes it a vessel and what makes
//            the reported weight the weight you will actually spend.
//   walled — a real wall thickness, measured perpendicular to the surface (so a
//            tapered pot gets a horizontally-thicker section, exactly as a
//            shell operation in CAD would), for a pot you want to be stiff.
//
// No DOM. Pure, deterministic, seeded. Imports mesh.js and poly2d.js only.

import { Mesh, TAU } from '../kernel/mesh.js';
import { superformula, star, regularPolygon, SUPERFORMULA_PRESETS } from '../kernel/poly2d.js';
import { DEG, RAD, clamp, num } from '../kernel/scalar.js';

// The thinnest neck we will build. Below ~1.2 mm radius there is no vessel left
// to print — the extrusion width alone is 0.42 — so clamping here turns a
// nonsense parameter set into a buildable (if useless) object that validate()
// can then explain, instead of a self-intersecting mesh nobody can diagnose.
const R_MIN = 1.2;
const CAVITY_MIN = 0.3;      // mm — the cavity never closes completely
const CAVITY_FRAC = 0.15;    // ...nor shrinks below this fraction of the outer radius
const RIM_MIN = 0.15;        // mm — outer and inner never meet at the rim
const SIL_SAMPLES = 2001;    // fixed grid for silhouette normalisation: quality must not change size
const MAX_CELLS = 70000;     // angular × vertical sample budget, ~4 tris per cell

const lerp = (a, b, t) => a + (b - a) * t;
const gauss = (t, mu, s) => Math.exp(-(((t - mu) / s) ** 2));
const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a || 1e-9), 0, 1); return u * u * (3 - 2 * u); };

// ---------------------------------------------------------------------------
// Silhouette — the radius profile up the height, normalised so its widest point
// is exactly 1. Normalising means `dia` always means "the widest point of the
// silhouette", whatever curve you pick, so the object cannot walk off the bed
// when you change its shape.
// ---------------------------------------------------------------------------

const SILHOUETTES = ['straight', 'bell', 'ogee', 'waisted', 'amphora', 'custom'];

function rawSilhouette(kind, t, T, bulge, c) {
  switch (kind) {
    case 'straight': return lerp(1, T, t);
    // The transition is concentrated near the mouth: fat body, quick sweep at
    // the top. bulge decides how late the sweep happens.
    case 'bell': return 1 + (T - 1) * Math.pow(t, 1 + 2.2 * bulge);
    // Convex low, concave high — the classic S.
    case 'ogee': return lerp(1, T, t) + 0.38 * bulge * Math.sin(TAU * t);
    case 'waisted': return lerp(1, T, t) - 0.40 * bulge * Math.sin(Math.PI * t);
    // A belly low down, a neck at 0.8, and whatever flare T asks for above it.
    case 'amphora': return lerp(1, T, t) + bulge * (0.50 * gauss(t, 0.30, 0.24) - 0.30 * gauss(t, 0.80, 0.16));
    case 'custom': {
      // Cubic Bézier, not an interpolating spline: a Bézier stays inside the
      // convex hull of its control values, so four positive controls can never
      // produce a negative radius between them and the curve cannot wobble past
      // what you typed. It does not pass through c1 and c2 — that is the price,
      // and it is why the result is always smooth.
      const u = 1 - t;
      return u * u * u * c[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[2] + t * t * t * c[3];
    }
    default: return lerp(1, T, t);
  }
}

function silhouetteFn(s) {
  const raw = (t) => rawSilhouette(s.silhouette, t, s.topScale, s.bulge, s.custom);
  let mx = 0;
  for (let i = 0; i < SIL_SAMPLES; i++) {
    const v = raw(i / (SIL_SAMPLES - 1));
    if (v > mx) mx = v;
  }
  const k = mx > 1e-9 ? 1 / mx : 1;
  return (t) => raw(t) * k;
}

// ---------------------------------------------------------------------------
// Cross-section — a unit radius per sampled angle, max 1.
//
// The polygonal shapes come from poly2d rather than being re-derived here, and
// are turned into a radius function by casting a ray from the axis at each
// sample angle. That has a second job: the number of times the ray hits the
// outline IS the single-valued-in-angle test. Anything but one hit means the
// outline folds back and cannot be spiralised, and radialize() reports it.
// ---------------------------------------------------------------------------

const SECTION_KINDS = ['circle', 'lobed', 'star', 'polygon', 'squircle', 'superformula'];

function radialize(ring, phi) {
  const n = ring.length, N = phi.length;
  let maxR = 0;
  for (const q of ring) { const d = Math.hypot(q[0], q[1]); if (d > maxR) maxR = d; }
  if (!(maxR > 0)) throw new Error('vase: cross-section outline collapsed to a point');
  const unit = new Float64Array(N);
  let worstHits = 1;
  const hits = [];
  for (let k = 0; k < N; k++) {
    const dx = Math.cos(phi[k]), dy = Math.sin(phi[k]);
    hits.length = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (den === 0 || Math.abs(den) < 1e-15) continue;
      const s = (a[0] * dy - a[1] * dx) / den;
      if (s < -1e-9 || s > 1 + 1e-9) continue;
      const t = (a[0] * ey - a[1] * ex) / den;
      if (!(t > 1e-12)) continue;
      // A ray through a vertex hits both of its edges at the same distance;
      // that is one crossing, not two, so distinct distances are what we count.
      let dup = false;
      for (const h of hits) if (Math.abs(h - t) <= 1e-9 * Math.max(1, t)) { dup = true; break; }
      if (!dup) hits.push(t);
    }
    if (hits.length > worstHits) worstHits = hits.length;
    let best = 0;
    for (const h of hits) if (h > best) best = h;
    if (best <= 0) {
      // Numerically missed (a ray exactly along an edge). Fall back to the
      // nearest outline vertex rather than emitting a zero radius.
      let bestD = Infinity;
      for (const q of ring) {
        const da = Math.abs(Math.atan2(Math.sin(Math.atan2(q[1], q[0]) - phi[k]), Math.cos(Math.atan2(q[1], q[0]) - phi[k])));
        if (da < bestD) { bestD = da; best = Math.hypot(q[0], q[1]); }
      }
    }
    unit[k] = best / maxR;
  }
  return { unit, hits: worstHits };
}

function crossSection(s, phi) {
  const N = phi.length;
  switch (s.section) {
    case 'circle': {
      const u = new Float64Array(N); u.fill(1);
      return { unit: u, hits: 1 };
    }
    case 'lobed': {
      const u = new Float64Array(N);
      for (let k = 0; k < N; k++) u[k] = 1 - s.lobeDepth * 0.5 * (1 - Math.cos(s.lobes * phi[k]));
      return { unit: u, hits: 1 };
    }
    case 'squircle': {
      const n = s.squircleN;
      const f = (a) => Math.pow(Math.pow(Math.abs(Math.cos(a)), n) + Math.pow(Math.abs(Math.sin(a)), n), -1 / n);
      // Normalise against a fixed dense sweep, not against the N samples, so
      // the object is the same size at draft and at fine.
      let mx = 0;
      for (let i = 0; i < 1440; i++) { const v = f(TAU * i / 1440); if (v > mx) mx = v; }
      const u = new Float64Array(N);
      for (let k = 0; k < N; k++) u[k] = f(phi[k]) / mx;
      return { unit: u, hits: 1 };
    }
    case 'star': return radialize(star(s.lobes, 1, Math.max(0.08, 1 - s.lobeDepth)), phi);
    case 'polygon': return radialize(regularPolygon(Math.max(3, s.lobes), 1), phi);
    case 'superformula': return radialize(superformula({ preset: s.sfPreset, r: 1, segs: 720 }), phi);
    default: { const u = new Float64Array(N); u.fill(1); return { unit: u, hits: 1 }; }
  }
}

// ---------------------------------------------------------------------------
// Treatments
// ---------------------------------------------------------------------------

/**
 * Horizontal rings. Every style is zero-amplitude at z = 0 on purpose: a rib
 * that bites into the first layer scallops the footprint, and the footprint is
 * the only thing holding a 150 mm vase upright.
 * All three cut INWARD, so `dia` stays the widest point of the finished object.
 */
function ribAmp(style, u, depth) {
  if (depth <= 0) return 0;
  if (style === 'sharp') {
    const f = u - Math.floor(u);
    return depth * (1 - 2 * Math.abs(f - 0.5));
  }
  if (style === 'groove') {
    const c = Math.cos(TAU * u + Math.PI);
    return c > 0 ? depth * Math.pow(c, 0.6) : 0;
  }
  return depth * 0.5 * (1 - Math.cos(TAU * u));
}

/**
 * Integer hash → [0,1). Math.imul keeps every multiply in 32 bits, which is
 * what makes the noise bit-identical on every machine and every run — a vase
 * you liked last month has to come back the same when you reopen it.
 */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise on a cylinder: wraps exactly in φ so there is no seam. */
function vnoise(gx, gy, na, seed) {
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (i) => ((i % na) + na) % na;
  const xa = w(x0), xb = w(x0 + 1);
  const a = lerp(hash2(xa, y0, seed), hash2(xb, y0, seed), sx);
  const b = lerp(hash2(xa, y0 + 1, seed), hash2(xb, y0 + 1, seed), sx);
  return lerp(a, b, sy);
}

// ---------------------------------------------------------------------------
// Settings: one place where every parameter is read, defaulted and clamped, so
// build(), validate() and hints() cannot disagree about what the numbers mean.
// ---------------------------------------------------------------------------

function settings(p, ctx = {}) {
  p = p || {};
  const segFactor = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const nozzle = clamp(num(ctx.nozzle, 0.4), 0.15, 1.2);
  const height = clamp(num(p.height, 120), 5, 400);
  const dia = clamp(num(p.dia, 80), 4, 400);
  const section = SECTION_KINDS.includes(p.section) ? p.section : 'lobed';
  const silhouette = SILHOUETTES.includes(p.silhouette) ? p.silhouette : 'ogee';
  const facetsRaw = Math.round(num(p.facets, 0));
  return {
    height, dia, segFactor, nozzle,
    silhouette,
    topScale: clamp(num(p.topScale, 72), 2, 400) / 100,
    bulge: clamp(num(p.bulge, 55), 0, 100) / 100,
    custom: [p.c0, p.c1, p.c2, p.c3].map((v, i) => clamp(num(v, [100, 118, 46, 74][i]), 1, 400) / 100),
    section,
    lobes: clamp(Math.round(num(p.lobes, 6)), 2, 64),
    lobeDepth: clamp(num(p.lobeDepth, 18), 0, 95) / 100,
    sfPreset: Object.prototype.hasOwnProperty.call(SUPERFORMULA_PRESETS, p.sfPreset) ? p.sfPreset : 'vase',
    squircleN: clamp(num(p.squircleN, 4), 2, 12),
    twist: clamp(num(p.twist, 0), -3600, 3600) * DEG,
    ribs: clamp(Math.round(num(p.ribs, 0)), 0, 200),
    ribDepth: clamp(num(p.ribDepth, 1.2), 0, 20),
    ribStyle: ['wave', 'sharp', 'groove'].includes(p.ribStyle) ? p.ribStyle : 'wave',
    flutes: clamp(Math.round(num(p.flutes, 0)), 0, 200),
    fluteDepth: clamp(num(p.fluteDepth, 1.6), 0, 20),
    // 1 and 2 are not polygons; treat them as "off" rather than throwing.
    facets: facetsRaw >= 3 ? clamp(facetsRaw, 3, 128) : 0,
    noise: clamp(num(p.noise, 0), 0, 20),
    noiseScale: clamp(num(p.noiseScale, 2.5), 0.2, 24),
    seed: Math.abs(Math.round(num(p.seed, 7))) % 1000000,
    spiral: p.mode !== 'walled',
    wall: clamp(num(p.wall, 2), 0.2, 20),
    base: clamp(num(p.base, 1.6), 0.2, 0.6 * clamp(num(p.height, 120), 5, 400)),
    extrusionWidth: Math.max(0.28, clamp(num(ctx.nozzle, 0.4), 0.15, 1.2) * 1.05),
  };
}

// ---------------------------------------------------------------------------
// Sampling density
// ---------------------------------------------------------------------------

function pickN(s) {
  if (s.facets) return s.facets;
  // Chord error on a circle of radius R with N segments is ~R·π²/(2N²); at
  // dia 80 / N 104 that is 0.02 mm, six times finer than the nozzle can print.
  let n = Math.round(Math.max(72, s.dia * 1.3) * s.segFactor);
  const feat = s.flutes > 0 ? s.flutes : (usesLobes(s) ? s.lobes : 0);
  if (feat >= 2) n = Math.max(n, feat * 12);
  if (s.noise > 0) n = Math.max(n, Math.round(s.noiseScale * 3.5) * 8);
  n = clamp(Math.round(n), 24, 512);
  // Land samples exactly on the feature crests, or a 24-lobe vase beats against
  // the sample grid and grows a slow moiré nobody can name.
  if (feat >= 2 && feat <= n) n = Math.ceil(n / feat) * feat;
  return clamp(n, 12, 720);
}

function usesLobes(s) { return s.section === 'lobed' || s.section === 'star' || s.section === 'polygon'; }

function pickM(s, N) {
  let m = Math.round(Math.max(24, s.height / 1.1) * s.segFactor);
  if (s.ribs > 0) m = Math.max(m, s.ribs * 8);
  if (s.noise > 0) m = Math.max(m, noiseRows(s) * 6);
  if (s.twist !== 0) {
    // Keep the twist per level near the angular sample spacing, or the wall
    // quads shear into slivers that shade badly and slice worse.
    m = Math.max(m, Math.abs(s.twist) * RAD / (1.4 * 360 / N));
  }
  m = clamp(Math.round(m), 8, 4000);
  if (N * m > MAX_CELLS) m = Math.max(8, Math.floor(MAX_CELLS / N));
  if (s.ribs > 0) {
    // Put the rib crests and troughs exactly on levels; four per period is the
    // least that resolves a triangle wave without rounding its tips off.
    const per = Math.max(4, Math.floor(m / s.ribs));
    m = per * s.ribs;
  }
  return clamp(Math.round(m), 4, 4000);
}

function noiseRows(s) { return Math.max(2, Math.round(s.noiseScale * s.height / 26)); }
function noiseCols(s) { return Math.max(3, Math.round(s.noiseScale * 3.5)); }

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

function field(s, N) {
  const phi = new Float64Array(N);
  for (let k = 0; k < N; k++) phi[k] = TAU * k / N;
  const sil = silhouetteFn(s);
  const { unit, hits } = crossSection(s, phi);
  const Rmax = s.dia / 2;

  // Flutes depend only on the angle, so they are computed once. cos^0.6 gives a
  // shallow dish separated by a sharp arris — a Doric flute, not a sine wave.
  const flute = new Float64Array(N);
  if (s.flutes > 0 && s.fluteDepth > 0) {
    for (let k = 0; k < N; k++) {
      const c = Math.cos(s.flutes * phi[k]);
      flute[k] = c > 0 ? s.fluteDepth * Math.pow(c, 0.6) : 0;
    }
  }

  const na = noiseCols(s), nb = noiseRows(s);
  const noisy = s.noise > 0;

  const stats = { minRaw: Infinity, clamped: 0, cells: 0, maxR: 0, sectionHits: hits };

  /** Outer radii, in mm, at height z. Records what it had to clamp. */
  const outerRow = (z) => {
    const t = clamp(z / s.height, 0, 1);
    const Rm = Rmax * sil(t);
    const rib = s.ribs > 0 ? ribAmp(s.ribStyle, t * s.ribs, s.ribDepth) : 0;
    // Fade the texture out over the floor and a few millimetres above it: the
    // first layers want a clean, full-width footprint far more than they want
    // to be interesting.
    const nAmp = noisy ? s.noise * sstep(0, s.base + 3, z) : 0;
    const out = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      let r = Rm * unit[k] - flute[k] - rib;
      if (nAmp > 0) {
        const gx = (k / N) * na, gy = t * nb;
        const o1 = vnoise(gx, gy, na, s.seed);
        const o2 = vnoise(gx * 2, gy * 2, na * 2, s.seed + 1013);
        r += nAmp * ((0.66 * o1 + 0.34 * o2) * 2 - 1);
      }
      stats.cells++;
      if (r < stats.minRaw) stats.minRaw = r;
      if (r < R_MIN) { r = R_MIN; stats.clamped++; }
      if (r > stats.maxR) stats.maxR = r;
      out[k] = r;
    }
    return out;
  };

  /**
   * Horizontal wall thickness at height z.
   * Spiral: exactly one extrusion width, because the slicer reads a horizontal
   * section and must find one perimeter's worth of material there.
   * Walled: `wall` measured perpendicular to the surface, which on a slope is
   * more than `wall` horizontally — the same answer a CAD shell gives.
   */
  const wallAt = (z) => {
    if (s.spiral) return s.extrusionWidth;
    const h = Math.max(1e-4, s.height * 1e-3);
    const t0 = clamp((z - h) / s.height, 0, 1), t1 = clamp((z + h) / s.height, 0, 1);
    const slope = Rmax * (sil(t1) - sil(t0)) / Math.max(1e-9, (t1 - t0) * s.height);
    return s.wall * clamp(Math.sqrt(1 + slope * slope), 1, 2.5);
  };

  const innerRow = (z, outer) => {
    const wh = wallAt(z);
    const out = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const ro = outer[k];
      const lo = Math.max(CAVITY_MIN, ro * CAVITY_FRAC);
      out[k] = clamp(ro - wh, Math.min(lo, ro - RIM_MIN), ro - RIM_MIN);
    }
    return out;
  };

  const rotAt = (z) => s.twist * clamp(z / s.height, 0, 1);

  return { N, phi, unit, sil, outerRow, innerRow, wallAt, rotAt, stats, Rmax };
}

// ---------------------------------------------------------------------------
// Geometry — rings, levels and the axis offset. Exported because the tests and
// the 2D preview both want the rings without paying for the triangles.
// ---------------------------------------------------------------------------

export function vaseGeometry(p, ctx = {}) {
  const s = settings(p, ctx);
  const N = pickN(s), M = pickM(s, N);
  const f = field(s, N);
  const dz = s.height / M;

  const outer = [];
  for (let j = 0; j <= M; j++) {
    const z = j === M ? s.height : j * dz;
    outer.push({ z, rot: f.rotAt(z), r: f.outerRow(z) });
  }

  // The cavity starts at the floor and reuses the outer levels above it, so the
  // ribs on the inside line up with the ribs on the outside.
  const innerZ = [s.base];
  for (let j = 0; j <= M; j++) {
    const z = outer[j].z;
    if (z > s.base + 0.3 * dz) innerZ.push(z);
  }
  if (innerZ[innerZ.length - 1] !== s.height) innerZ.push(s.height);
  const inner = innerZ.map((z) => {
    const ro = f.outerRow(z);
    return { z, rot: f.rotAt(z), ro, r: f.innerRow(z, ro) };
  });

  // The XY bounds of the whole solid are the bounds of the outer skin: for every
  // angle the inner radius is strictly smaller, and the caps sit on the axis.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minWall = Infinity;
  for (const lv of outer) {
    for (let k = 0; k < N; k++) {
      const a = f.phi[k] + lv.rot, r = lv.r[k];
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  for (const lv of inner) for (let k = 0; k < N; k++) minWall = Math.min(minWall, lv.ro[k] - lv.r[k]);

  const axis = [-(minX + maxX) / 2, -(minY + maxY) / 2];
  return { s, N, M, phi: f.phi, unit: f.unit, outer, inner, axis, stats: f.stats, minWall, dz, field: f };
}

// ---------------------------------------------------------------------------
// Dimension callouts — the measurements the bounding box cannot show, placed
// from the same numbers the mesh was built from. Every radial one is drawn at
// the silhouette edge of the default iso view (camera azimuth −60°, so the
// tangent points are at 30° and 210°): there the radial direction lies in the
// picture plane and a wall or a groove depth is seen edge-on, the way a section
// would show it, instead of foreshortened to a dot.
// ---------------------------------------------------------------------------

const VIEW_EDGE = 30 * DEG;

/** Sample index whose placed angle (phi + rot) is nearest `want`, folded into
 *  `period` — π for a diameter, which has no preferred end. */
function nearestK(phi, rot, want, period = TAU) {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < phi.length; k++) {
    let d = (phi[k] + rot - want) % period;
    d = Math.abs(((d + period * 1.5) % period) - period / 2);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function vaseDims(g) {
  const { s, N, phi, outer, inner, axis, field: f } = g;
  const [ax, ay] = axis;
  const pt = (r, a, z) => [ax + r * Math.cos(a), ay + r * Math.sin(a), z];
  const dims = [];
  const top = outer[outer.length - 1];               // z = height
  const H = s.height;

  // Widest diameter: across the widest ring, through the axis. On a lobed or
  // starred section the far end may land in a valley — that is the envelope
  // diameter a drawing writes as Ø, and it is what `dia` means here.
  let wj = 0, wr = -Infinity;
  for (let j = 0; j < outer.length; j++) for (let k = 0; k < N; k++) if (outer[j].r[k] > wr) { wr = outer[j].r[k]; wj = j; }
  {
    const lv = outer[wj];
    let bk = -1, bd = Infinity;
    for (let k = 0; k < N; k++) {
      if (lv.r[k] < wr - 1e-9) continue;
      let d = (phi[k] + lv.rot - VIEW_EDGE) % Math.PI;
      d = Math.abs(((d + Math.PI * 1.5) % Math.PI) - Math.PI / 2);
      if (d < bd) { bd = d; bk = k; }
    }
    const a = phi[bk] + lv.rot;
    // The line itself sits clear of the body — below the foot when the widest
    // point is low, above the mouth when it is high — on extension lines, as a
    // drawing would, rather than cutting through the middle of the vase.
    const lift = lv.z < H / 2 ? -(lv.z + 8) : (H - lv.z) + 8;
    dims.push({ param: 'dia', label: 'Ø', from: pt(wr, a, lv.z), to: pt(wr, a + Math.PI, lv.z), offset: [0, 0, lift] });
  }

  // Floor: from the bed to the cavity floor, on the outer skin at the view edge.
  {
    const lv = outer[0];
    const k = nearestK(phi, lv.rot, VIEW_EDGE);
    const a = phi[k] + lv.rot;
    dims.push({ param: 'base', from: pt(lv.r[k], a, 0), to: pt(lv.r[k], a, s.base),
      offset: [6 * Math.cos(a), 6 * Math.sin(a), 0] });
  }

  // Wall (walled pot only — in spiral mode the printer sets it): measured at the
  // rim, perpendicular to the silhouette as the generator defines it. The
  // horizontal section there is wall·√(1+slope²); the perpendicular is `wall`.
  // On a flaring rim the perpendicular from the inner corner lands on the outer
  // skin below the rim; on a narrowing rim it is the outer corner that works.
  if (!s.spiral) {
    const it = inner[inner.length - 1];
    const k = nearestK(phi, top.rot, VIEW_EDGE);
    const a = phi[k] + top.rot;
    const ro = top.r[k], ri = it.r[k];
    const wh = ro - ri;
    const sil = silhouetteFn(s);
    const h = Math.max(1e-4, H * 1e-3);
    const t0 = clamp((H - h) / H, 0, 1), t1 = clamp((H + h) / H, 0, 1);
    const slope = (s.dia / 2) * (sil(t1) - sil(t0)) / Math.max(1e-9, (t1 - t0) * H);
    const q = Math.sqrt(1 + slope * slope);
    const L = wh / q;
    const nr = 1 / q, nz = -slope / q;                 // outward normal in (r, z)
    const from = slope >= 0 ? pt(ri, a, H) : pt(ro, a, H);
    const to = slope >= 0 ? pt(ri + L * nr, a, H + L * nz) : pt(ro - L * nr, a, H - L * nz);
    dims.push({ param: 'wall', from, to, offset: [6 * Math.cos(a), 6 * Math.sin(a), 4] });
  }

  // Ring depth: at the trough of the ring nearest mid-height, from the trough
  // out to the crest envelope. Every style is exactly `ribDepth` deep at u = ½.
  if (s.ribs > 0 && s.ribDepth > 0) {
    const u = Math.floor((s.ribs - 1) / 2) + 0.5;
    const z = H * u / s.ribs;
    const rot = f.rotAt(z);
    const row = f.outerRow(z);
    const k = nearestK(phi, rot, VIEW_EDGE);
    const a = phi[k] + rot;
    dims.push({ param: 'ribDepth', from: pt(row[k], a, z), to: pt(row[k] + s.ribDepth, a, z),
      offset: [0, 0, 6] });
  }

  // Flute depth: at the rim, from the bottom of the flute nearest the view edge
  // out to the arris envelope.
  if (s.flutes > 0 && s.fluteDepth > 0) {
    const step = TAU / s.flutes;
    const i = Math.round((VIEW_EDGE - top.rot) / step);
    const k = nearestK(phi, top.rot, i * step + top.rot);
    const a = phi[k] + top.rot;
    dims.push({ param: 'fluteDepth', from: pt(top.r[k], a, H), to: pt(top.r[k] + s.fluteDepth, a, H),
      offset: [0, 0, 5] });
  }
  return dims;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const g = vaseGeometry(p, ctx);
  const { s, N, phi, outer, inner, axis } = g;
  const prog = typeof ctx.progress === 'function' ? ctx.progress : null;

  const m = new Mesh();
  const ax = axis[0], ay = axis[1];

  const addRing = (lv, radii) => {
    const b0 = m.vertCount;
    for (let k = 0; k < N; k++) {
      const a = phi[k] + lv.rot, r = radii[k];
      m.addVertex(ax + r * Math.cos(a), ay + r * Math.sin(a), lv.z);
    }
    return b0;
  };

  // --- outer skin, floor down ---
  const cBot = m.addVertex(ax, ay, 0);
  const outIdx = new Array(outer.length);
  for (let j = 0; j < outer.length; j++) outIdx[j] = addRing(outer[j], outer[j].r);
  if (prog) prog(0.35);

  const A0 = outIdx[0];
  for (let k = 0; k < N; k++) m.addTri(cBot, A0 + (k + 1) % N, A0 + k);   // faces −Z
  for (let j = 0; j + 1 < outer.length; j++) {
    const A = outIdx[j], B = outIdx[j + 1];
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      m.addQuad(A + k, A + k1, B + k1, B + k);                            // faces out
    }
  }
  if (prog) prog(0.6);

  // --- cavity ---
  const cFloor = m.addVertex(ax, ay, s.base);
  const inIdx = new Array(inner.length);
  for (let j = 0; j < inner.length; j++) inIdx[j] = addRing(inner[j], inner[j].r);

  const I0 = inIdx[0];
  for (let k = 0; k < N; k++) m.addTri(cFloor, I0 + k, I0 + (k + 1) % N);  // faces +Z
  for (let j = 0; j + 1 < inner.length; j++) {
    const A = inIdx[j], B = inIdx[j + 1];
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      m.addQuad(A + k, B + k, B + k1, A + k1);                            // faces in
    }
  }
  if (prog) prog(0.9);

  // --- rim: the only top-facing geometry, one wall wide. The mouth stays open,
  //     which is what makes this a vessel and not a lump. ---
  const OT = outIdx[outIdx.length - 1], IT = inIdx[inIdx.length - 1];
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    m.addQuad(OT + k, OT + k1, IT + k1, IT + k);
  }
  if (prog) prog(1);
  return { mesh: m, meta: { dims: vaseDims(g) } };
}

// ---------------------------------------------------------------------------
// validate — the part that stops a 2 a.m. brick
// ---------------------------------------------------------------------------

/** Worst outward lean of the OUTER skin, in degrees from vertical, and where. */
function overhangScan(p, ctx) {
  const s = settings(p, ctx);
  const na = clamp(Math.max(48, s.flutes * 4, (usesLobes(s) ? s.lobes : 0) * 4), 12, 160);
  const nz = clamp(Math.max(240, s.ribs * 12), 24, 1400);
  const f = field(s, na);
  let worst = 0, worstZ = 0;
  let prev = null, prevZ = 0;
  for (let j = 0; j <= nz; j++) {
    const z = s.height * j / nz;
    const row = f.outerRow(z);
    const rot = f.rotAt(z);
    if (prev) {
      const dz = z - prevZ;
      for (let k = 0; k < na; k++) {
        const k1 = (k + 1) % na;
        const pa = f.phi[k], pb = f.phi[k1];
        const p00 = [prev.r[k] * Math.cos(pa + prev.rot), prev.r[k] * Math.sin(pa + prev.rot), prevZ];
        const p10 = [prev.r[k1] * Math.cos(pb + prev.rot), prev.r[k1] * Math.sin(pb + prev.rot), prevZ];
        const p01 = [row[k] * Math.cos(pa + rot), row[k] * Math.sin(pa + rot), z];
        const u = [p10[0] - p00[0], p10[1] - p00[1], p10[2] - p00[2]];
        const v = [p01[0] - p00[0], p01[1] - p00[1], p01[2] - p00[2]];
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz2 = u[0] * v[1] - u[1] * v[0];
        const len = Math.hypot(nx, ny, nz2);
        if (len < 1e-12) continue;
        const down = -nz2 / len;                       // >0 means the face looks down
        if (down > 0) {
          const deg = Math.asin(clamp(down, 0, 1)) * RAD;
          if (deg > worst) { worst = deg; worstZ = z; }
        }
      }
      void dz;
    }
    prev = { r: row, rot };
    prevZ = z;
  }
  return { worst, worstZ, stats: f.stats, s };
}

/** Which treatment drove the radius below zero? Answer by switching each off. */
function foldCulprit(p, ctx, baseMin) {
  const trials = [
    ['fluteDepth', { fluteDepth: 0 }, 'flute depth'],
    ['ribDepth', { ribDepth: 0 }, 'rib depth'],
    ['noise', { noise: 0 }, 'surface noise'],
    ['lobeDepth', { lobeDepth: 0 }, 'lobe depth'],
    ['topScale', { topScale: 100 }, 'mouth scale'],
    ['bulge', { bulge: 0 }, 'curve strength'],
  ];
  let best = null;
  for (const [key, patch, label] of trials) {
    const s2 = settings({ ...p, ...patch }, ctx);
    const f2 = field(s2, 48);
    const nz = 160;
    for (let j = 0; j <= nz; j++) f2.outerRow(s2.height * j / nz);
    const gain = f2.stats.minRaw - baseMin;
    if (f2.stats.minRaw > R_MIN && (!best || gain > best.gain)) best = { key, label, gain, after: f2.stats.minRaw };
  }
  return best;
}

function validate(p, ctx = {}) {
  const out = [];
  const scan = overhangScan(p, ctx);
  const s = scan.s;
  const st = scan.stats;

  // 1. Fold-back. The build clamps rather than self-intersecting, so this is the
  //    only place that will ever tell you the shape you asked for is impossible.
  if (st.minRaw < R_MIN) {
    const culprit = foldCulprit(p, ctx, st.minRaw);
    const where = st.minRaw < 0
      ? `the cross-section folds back through its own axis (radius reaches ${st.minRaw.toFixed(2)} mm)`
      : `the wall closes to ${Math.max(0, st.minRaw).toFixed(2)} mm radius, below the ${R_MIN} mm minimum`;
    out.push({
      param: culprit ? culprit.key : 'lobeDepth',
      severity: 'error',
      message: `${where}. ${culprit
        ? `${culprit.label} is what does it — at 0 the thinnest radius is ${culprit.after.toFixed(1)} mm.`
        : 'Reduce the treatment depths or widen the vase.'} A section that folds back cannot be spiralised: the slicer will not warn you, it will print a solid brick.`,
    });
  }

  // 2. Single-valued in angle. radialize() counts ray crossings of the source
  //    outline; anything but one means the outline itself doubles back.
  if (st.sectionHits > 1) {
    out.push({
      param: 'section',
      severity: 'error',
      message: `the ${s.section} cross-section is not single-valued in angle (a ray from the axis crosses it ${st.sectionHits} times), so it cannot be printed in spiral mode`,
    });
  }

  // 3. Overhang. Only the outer skin is measured: on a narrowing vessel the
  //    inner surface faces down too, but every layer overlaps the one below it,
  //    so it is self-supporting and warning about it would be noise.
  const limit = s.spiral ? 45 : 55;
  if (scan.worst > limit) {
    out.push({
      param: scan.worst > 70 && s.ribs > 0 ? 'ribDepth' : 'topScale',
      severity: scan.worst > limit + 15 ? 'error' : 'warn',
      message: `the outside leans ${scan.worst.toFixed(0)}° from vertical at z = ${scan.worstZ.toFixed(0)} mm (limit ${limit}° here). ${s.spiral
        ? 'A spiral-mode print has nothing under it and no support can be added — it will droop.'
        : 'Expect drooping unless you slow the outer wall and add cooling.'}`,
    });
  }

  // 4. Base and footprint.
  const f = field(s, 48);
  const bottom = f.outerRow(0);
  let footprint = 0;
  for (let k = 0; k < 48; k++) footprint += 0.5 * bottom[k] * bottom[(k + 1) % 48] * Math.sin(TAU / 48);
  const baseDia = 2 * Math.sqrt(footprint / Math.PI);
  if (s.base < 0.6) {
    out.push({ param: 'base', severity: 'warn', message: `a ${s.base.toFixed(1)} mm floor is under three layers at 0.2 mm — it will show the bed through it and can split when the vase is picked up` });
  }
  if (footprint < 300) {
    out.push({ param: 'dia', severity: 'warn', message: `the footprint is only ${footprint.toFixed(0)} mm² (${baseDia.toFixed(0)} mm across). Print with a brim, or the part will let go before the top` });
  }
  if (s.height / Math.max(1, baseDia) > 4.5) {
    out.push({ param: 'height', severity: 'warn', message: `${s.height.toFixed(0)} mm tall on a ${baseDia.toFixed(0)} mm base is ${(s.height / baseDia).toFixed(1)}:1 — tall and light enough for the toolhead to knock over. Brim, and slow the top third` });
  }

  // 5. Wall.
  if (!s.spiral) {
    const ew = s.extrusionWidth;
    if (s.wall < 2 * ew) {
      out.push({ param: 'wall', severity: 'warn', message: `a ${s.wall.toFixed(1)} mm wall is under two ${ew.toFixed(2)} mm extrusions; the slicer will fill it with a gap-fill zigzag rather than clean perimeters. Use ${(2 * ew).toFixed(1)} mm, or switch to spiral mode` });
    }
    const g = vaseGeometry(p, ctx);
    if (g.minWall < s.wall * 0.6) {
      out.push({ param: 'wall', severity: 'warn', message: `the wall thins to ${g.minWall.toFixed(2)} mm where the vase is narrowest — the cavity has run out of room for the ${s.wall.toFixed(1)} mm you asked for` });
    }
  }

  // 6. Bed.
  const bed = ctx.bed || { x: 180, y: 180, z: 180 };
  if (2 * st.maxR > Math.min(bed.x, bed.y)) {
    out.push({ param: 'dia', severity: 'error', message: `${(2 * st.maxR).toFixed(0)} mm across will not fit a ${bed.x} × ${bed.y} mm bed` });
  }
  if (s.height > bed.z) {
    out.push({ param: 'height', severity: 'error', message: `${s.height.toFixed(0)} mm is taller than the ${bed.z} mm the printer can reach` });
  }

  // 7. Small print.
  if (Math.round(num(p.facets, 0)) === 1 || Math.round(num(p.facets, 0)) === 2) {
    out.push({ param: 'facets', severity: 'info', message: 'fewer than three facets is not a polygon; faceting is off' });
  }
  if (s.spiral && s.ribs > 0 && s.ribStyle === 'sharp' && s.ribDepth > 1.5) {
    out.push({ param: 'ribStyle', severity: 'info', message: 'sharp ribs in spiral mode print as a continuous zig-zag; expect the tips to round off to about the nozzle diameter' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// hints — what to actually type into the slicer
// ---------------------------------------------------------------------------

/** Volume and skin area without building a mesh: a coarse ring sweep. */
function estimateVolume(p, ctx) {
  const s = settings(p, ctx);
  const na = 48, nz = 200;
  const f = field(s, na);
  const half = Math.sin(TAU / na) / 2;
  let vol = 0, area = 0;
  let prevZ = 0, prevOut = null;
  for (let j = 0; j <= nz; j++) {
    const z = s.height * j / nz;
    const ro = f.outerRow(z);
    let aOut = 0, per = 0;
    for (let k = 0; k < na; k++) {
      const k1 = (k + 1) % na;
      aOut += half * ro[k] * ro[k1];
      per += Math.hypot(ro[k1] * Math.cos(f.phi[k1]) - ro[k] * Math.cos(f.phi[k]),
        ro[k1] * Math.sin(f.phi[k1]) - ro[k] * Math.sin(f.phi[k]));
    }
    let aIn = 0;
    if (z > s.base) {
      const ri = f.innerRow(z, ro);
      for (let k = 0; k < na; k++) aIn += half * ri[k] * ri[(k + 1) % na];
    }
    const slice = aOut - aIn;
    if (prevOut !== null) { vol += (slice + prevOut) / 2 * (z - prevZ); area += per * (z - prevZ); }
    prevOut = slice; prevZ = z;
  }
  return { volume: vol, area, s };
}

function hints(p, ctx = {}) {
  const { volume, s } = estimateVolume(p, ctx);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const ew = s.extrusionWidth;
  const grams = volume / 1000 * 1.24;
  const bottomLayers = Math.max(2, Math.ceil(s.base / layerH));
  const scan = overhangScan(p, ctx);
  const notes = [];

  if (s.spiral) {
    notes.push(`Spiral vase mode ON — that is the whole point of this shape. Walls 1, top layers 0, infill 0%, bottom layers ${bottomLayers} (your ${s.base.toFixed(1)} mm floor at ${layerH} mm).`);
    notes.push(`The model's wall is one extrusion width (${ew.toFixed(2)} mm) because in vase mode the printer sets the wall, not the model. Do not scale the object in X/Y only — that scales the wall too and the single perimeter stops fitting.`);
    notes.push('Orca resolves a contradiction between spiral mode and the shell settings silently and exits 0, so check the sliced file rather than the exit code.');
  } else {
    const perims = Math.max(1, Math.round(s.wall / ew));
    notes.push(`${perims} wall${perims === 1 ? '' : 's'} at ${ew.toFixed(2)} mm gives the ${s.wall.toFixed(1)} mm wall. Infill 0% — there is nothing inside to fill — top layers 0, bottom layers ${bottomLayers}.`);
    notes.push('Spiral mode OFF: this variant has a real wall thickness and is a closed watertight shell, so it takes a normal profile and can be sanded and sealed.');
  }
  notes.push(`Roughly ${volume.toFixed(0)} mm³ of plastic, about ${grams.toFixed(0)} g in PLA — the model is hollow, so that figure is the print, not a solid block.`);
  notes.push(`Steepest outward lean ${scan.worst.toFixed(0)}° from vertical. Supports are never the answer inside a vase: there is no way to remove them. Reduce the flare instead.`);
  if (s.twist !== 0) notes.push(`${(s.twist * RAD).toFixed(0)}° of twist over the full height. Twisted walls print better a little slower — the outer wall changes direction on every segment.`);
  if (s.noise > 0) notes.push(`Surface noise is seeded (${s.seed}); the same seed gives the same vase for ever, and it hides layer lines better than any ironing setting.`);
  notes.push('PLA, and silk PLA if you have it: a single-wall spiral catches the light on one continuous surface and silk exaggerates it. Not food safe, and not watertight — stand a glass jar or a test tube inside for cut flowers.');

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: 'PLA',
    supports: false,
    spiral: s.spiral,
    bottomLayers,
    estGrams: Math.round(grams * 10) / 10,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const SF_LABELS = {
  circle: 'Circle', roundedSquare: 'Rounded square', star5: 'Five-point star',
  flower6: 'Six petals', gem: 'Gem', petal12: 'Twelve petals', vase: 'Classic vase', blob: 'Blob',
};

export default {
  id: 'vase',
  name: 'Vase',
  category: 'Decor',
  blurb: 'Silhouette × cross-section × surface. Single-wall spiral vessels, or a walled pot.',
  description:
    'A vase is a silhouette curve crossed with a cross-section shape, plus whatever you do to the surface: twist it, ring it, flute it, facet it or roughen it. ' +
    'The spiral variant is a true single-wall vessel with a solid floor and an open mouth — one continuous extrusion from first layer to last, no seam, no travel. ' +
    'Every section is single-valued in angle by construction, which is the one thing spiral mode requires and the one thing no slicer will warn you about.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 3h6"/><path d="M9.4 3c0 3.2-3.9 4.6-3.9 10.1C5.5 17.9 8.4 21 12 21s6.5-3.1 6.5-7.9C18.5 7.6 14.6 6.2 14.6 3"/></svg>',
  version: 1,

  params: [
    // ---- Form ----
    { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 20, max: 180, step: 1, def: 120, group: 'Form',
      help: 'Overall height. The A1 mini can reach 180 mm; above about 150 mm expect to slow the top third down.' },
    { key: 'dia', label: 'Widest diameter', type: 'number', unit: 'mm', min: 20, max: 160, step: 1, def: 80, group: 'Form',
      help: 'The widest point of the silhouette, whichever curve you choose — the profile is normalised to it, so changing shape never changes size.' },
    { key: 'silhouette', label: 'Silhouette', type: 'enum', def: 'ogee', group: 'Form',
      help: 'The profile up the height.',
      options: [
        { v: 'straight', label: 'Straight taper', help: 'A cone frustum. The most forgiving thing to print and the easiest to get wrong by making it dull.' },
        { v: 'bell', label: 'Bell', help: 'Full body, then a quick sweep to the mouth. Bulge decides how late the sweep happens.' },
        { v: 'ogee', label: 'Ogee', help: 'The classic S: convex low, concave high.' },
        { v: 'waisted', label: 'Waisted', help: 'Wide top and bottom, pinched in the middle.' },
        { v: 'amphora', label: 'Amphora', help: 'A belly low down, a neck near the top, and whatever flare the mouth asks for.' },
        { v: 'custom', label: 'Custom curve', help: 'Four control radii shaping a cubic Bézier — smooth by construction, and it cannot dip below the smallest of them.' },
      ] },
    { key: 'topScale', label: 'Mouth', type: 'number', unit: '%', min: 15, max: 160, step: 5, def: 72, group: 'Form',
      showIf: (p) => p.silhouette !== 'custom',
      help: 'Mouth diameter as a percentage of the base. Over 100% flares outward — attractive, and the fastest way to make an unprintable overhang.' },
    { key: 'bulge', label: 'Curve strength', type: 'number', unit: '%', min: 0, max: 100, step: 5, def: 55, group: 'Form',
      showIf: (p) => p.silhouette !== 'straight' && p.silhouette !== 'custom',
      help: 'How pronounced the belly, waist or neck is. At 0 every curve degenerates to a straight taper.' },
    { key: 'c0', label: 'Base radius', type: 'number', unit: '%', min: 10, max: 140, step: 2, def: 100, group: 'Form',
      showIf: (p) => p.silhouette === 'custom', help: 'Control 1 of 4 — the foot. Only the ratios between the four matter; the result is scaled to the widest diameter.' },
    { key: 'c1', label: 'Lower control', type: 'number', unit: '%', min: 10, max: 140, step: 2, def: 118, group: 'Form',
      showIf: (p) => p.silhouette === 'custom', help: 'Control 2 of 4 — pulls the lower third out or in. The curve leans towards it without passing through it.' },
    { key: 'c2', label: 'Upper control', type: 'number', unit: '%', min: 10, max: 140, step: 2, def: 46, group: 'Form',
      showIf: (p) => p.silhouette === 'custom', help: 'Control 3 of 4 — the neck.' },
    { key: 'c3', label: 'Mouth radius', type: 'number', unit: '%', min: 10, max: 140, step: 2, def: 74, group: 'Form',
      showIf: (p) => p.silhouette === 'custom', help: 'Control 4 of 4 — the rim, which the curve does reach exactly.' },

    // ---- Cross-section ----
    { key: 'section', label: 'Cross-section', type: 'enum', def: 'lobed', group: 'Cross-section',
      help: 'The shape of every horizontal slice. All of them are single-valued in angle, so all of them can be spiralised.',
      options: [
        { v: 'circle', label: 'Circle', help: 'Plain and round. The fastest to print and the best surface for silk filament.' },
        { v: 'lobed', label: 'Lobed', help: 'A smooth cosine swell. Gentle, and it hides layer lines better than a circle.' },
        { v: 'star', label: 'Star', help: 'Straight-sided points. Sharp, and excellent with a twist.' },
        { v: 'polygon', label: 'Polygon', help: 'A regular n-gon. Add a twist and it becomes a twisted prism.' },
        { v: 'squircle', label: 'Squircle', help: 'Between a circle and a square. The exponent decides how square.' },
        { v: 'superformula', label: 'Superformula', help: 'Gielis curves: flowers, gems, rounded squares. Polar by definition, so always spiralisable.' },
      ] },
    { key: 'lobes', label: 'Lobes / sides', type: 'int', min: 2, max: 24, step: 1, def: 6, group: 'Cross-section',
      showIf: (p) => ['lobed', 'star', 'polygon'].includes(p.section),
      help: 'How many swells, points or sides. Sample density follows this, so a 24-lobe vase costs more triangles than a 6-lobe one.' },
    { key: 'lobeDepth', label: 'Lobe depth', type: 'number', unit: '%', min: 0, max: 90, step: 1, def: 18, group: 'Cross-section',
      showIf: (p) => ['lobed', 'star'].includes(p.section),
      help: 'How far the valleys cut in, as a percentage of the radius. Above about 60% the valleys start to overhang each other on a twisted vase.' },
    { key: 'sfPreset', label: 'Superformula', type: 'enum', def: 'vase', group: 'Cross-section',
      showIf: (p) => p.section === 'superformula',
      help: 'Gielis parameter sets. "Classic vase" is eight soft flutes; "Gem" is six flat facets.',
      options: Object.keys(SUPERFORMULA_PRESETS).map((k) => ({ v: k, label: SF_LABELS[k] || k })) },
    { key: 'squircleN', label: 'Squareness', type: 'number', min: 2, max: 10, step: 0.5, def: 4, group: 'Cross-section',
      showIf: (p) => p.section === 'squircle',
      help: '2 is a circle, 4 is the classic squircle, 10 is nearly a square with soft corners.' },

    // ---- Surface ----
    { key: 'twist', label: 'Twist', type: 'number', unit: '°', min: -720, max: 720, step: 15, def: 0, group: 'Surface',
      help: 'Total rotation from floor to rim. Only visible on a shape that is not round — a twisted circle is still a circle.' },
    { key: 'ribs', label: 'Rings', type: 'int', min: 0, max: 60, step: 1, def: 0, group: 'Surface',
      help: 'Horizontal rings up the height. 0 is off. Every style cuts inward and fades to nothing at the floor, so the footprint stays full width.' },
    { key: 'ribDepth', label: 'Ring depth', type: 'number', unit: 'mm', min: 0, max: 5, step: 0.1, def: 1.2, group: 'Surface',
      showIf: (p) => p.ribs > 0, help: 'How deep each ring cuts. Deep rings close together become overhangs — validate will tell you the angle.' },
    { key: 'ribStyle', label: 'Ring style', type: 'enum', def: 'wave', group: 'Surface', showIf: (p) => p.ribs > 0,
      help: 'The profile of the rings.',
      options: [
        { v: 'wave', label: 'Wave', help: 'A smooth undulation. The most forgiving to print.' },
        { v: 'sharp', label: 'Sharp', help: 'Triangular ribs. The tips round off to about the nozzle diameter.' },
        { v: 'groove', label: 'Groove', help: 'Narrow cuts separated by flat bands — a stacked, turned look.' },
      ] },
    { key: 'flutes', label: 'Flutes', type: 'int', min: 0, max: 48, step: 1, def: 0, group: 'Surface',
      help: 'Vertical grooves with a sharp arris between them, like a column. Combine with twist for a spiral flute.' },
    { key: 'fluteDepth', label: 'Flute depth', type: 'number', unit: 'mm', min: 0, max: 6, step: 0.1, def: 1.6, group: 'Surface',
      showIf: (p) => p.flutes > 0, help: 'How deep each groove cuts into the wall.' },
    { key: 'facets', label: 'Facets', type: 'int', min: 0, max: 24, step: 1, def: 0, group: 'Surface',
      help: '0 is smooth. 3 and up replaces the smooth section with that many flat panels — a low-poly look that also cuts the triangle count hard.' },
    { key: 'noise', label: 'Surface noise', type: 'number', unit: 'mm', min: 0, max: 3, step: 0.05, def: 0, group: 'Surface',
      help: 'Seeded organic roughness, faded out over the floor so the first layers stay clean. Excellent at disguising layer lines.' },
    { key: 'noiseScale', label: 'Noise scale', type: 'number', min: 0.5, max: 8, step: 0.1, def: 2.5, group: 'Surface',
      showIf: (p) => p.noise > 0, help: 'Higher is finer-grained. Sampling density follows it, so very fine noise costs triangles.' },
    { key: 'seed', label: 'Seed', type: 'int', min: 0, max: 9999, step: 1, def: 7, group: 'Surface',
      showIf: (p) => p.noise > 0, help: 'The same seed always gives the same vase, on any machine, for ever.' },

    // ---- Wall ----
    { key: 'mode', label: 'Wall mode', type: 'enum', def: 'spiral', group: 'Wall & floor',
      help: 'How thick the wall is in the model.',
      options: [
        { v: 'spiral', label: 'Spiral (single wall)', help: 'One extrusion width, set by the nozzle. Slice with spiral vase mode: one continuous extrusion, no seam.' },
        { v: 'walled', label: 'Walled pot', help: 'A real wall thickness for a stiff, closed pot you can sand and seal. Normal profile, not spiral mode.' },
      ] },
    { key: 'wall', label: 'Wall thickness', type: 'number', unit: 'mm', min: 0.8, max: 8, step: 0.1, def: 2, group: 'Wall & floor',
      showIf: (p) => p.mode === 'walled',
      help: 'Measured perpendicular to the surface, so a tapered pot gets a thicker horizontal section — the same answer a CAD shell gives. Ignored in spiral mode, where the printer decides.' },
    { key: 'base', label: 'Floor', type: 'number', unit: 'mm', min: 0.6, max: 12, step: 0.2, def: 1.6, group: 'Wall & floor',
      help: 'Solid floor thickness. 1.6 mm is eight layers at 0.2 — enough to lift the vase by without it flexing.' },
  ],

  presets: [
    { name: 'Windowsill bud vase',
      values: { height: 150, dia: 62, silhouette: 'ogee', topScale: 46, bulge: 62, section: 'lobed', lobes: 8, lobeDepth: 26, twist: 210, ribs: 0, flutes: 0, facets: 0, noise: 0, mode: 'spiral', base: 1.6 } },
    { name: 'Desk pen pot',
      values: { height: 95, dia: 74, silhouette: 'straight', topScale: 96, section: 'polygon', lobes: 8, facets: 8, twist: 0, ribs: 0, flutes: 0, noise: 0, mode: 'walled', wall: 2, base: 2.4 } },
    { name: 'Kitchen utensil crock',
      values: { height: 150, dia: 120, silhouette: 'waisted', topScale: 100, bulge: 25, section: 'circle', twist: 0, ribs: 0, flutes: 0, facets: 0, noise: 0, mode: 'walled', wall: 2.4, base: 3 } },
    { name: 'Cut-flower vase',
      values: { height: 175, dia: 96, silhouette: 'amphora', topScale: 52, bulge: 80, section: 'circle', twist: 0, ribs: 0, flutes: 24, fluteDepth: 1.4, facets: 0, noise: 0, mode: 'spiral', base: 2.4 } },
    { name: 'Filament swatch vase',
      values: { height: 42, dia: 34, silhouette: 'straight', topScale: 118, section: 'lobed', lobes: 5, lobeDepth: 30, twist: 120, ribs: 0, flutes: 0, facets: 0, noise: 0, mode: 'spiral', base: 1 } },
    { name: 'Ribbed cachepot',
      values: { height: 110, dia: 130, silhouette: 'bell', topScale: 122, bulge: 40, section: 'circle', twist: 0, ribs: 22, ribDepth: 1.6, ribStyle: 'groove', flutes: 0, facets: 0, noise: 0, mode: 'walled', wall: 2.2, base: 3 } },
  ],

  build,
  validate,
  hints,
};

export { build, validate, hints, settings, field, radialize, silhouetteFn, R_MIN };
