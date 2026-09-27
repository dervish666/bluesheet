// lampshade — pendant shades that fit a real E27 lampholder.
//
// The thing that makes a lampshade hard to buy is never the shape. It is the
// base: every maker invents a fitting, and the shade that looks right turns out
// to want a gallery, a spider, a 28 mm collar or nothing at all. So this
// generator starts at the fitting and hangs a shade off it.
//
// THE NUMBERS THIS IS BUILT ON
// A European E27 lampholder carries its shade ring on a Ø 40 mm thread with a
// 2.5 mm lead over 14 mm of height, and the ring's external diameter is 54 mm
// in thermoplastic or 58 mm in thermoset (lampholders.eu, the manufacturer's
// own product pages, read 2026-09-20). That is where the 41 mm default bore
// comes from — 40 plus a millimetre of slip — and the 9 mm default flange, which
// leaves a 54 mm ring 7 mm of flat annulus to clamp with margin.
//
// None of it has been measured on the pendant this was written for. The help
// text says so in those words, and every one of those dimensions is a
// parameter, because the only thing worse than a guess is a guess wearing a
// number's clothes.
//
// THE WHOLE SHAPE IS ONE CLOSED MERIDIAN
// Wall, shoulder, flange, bore, collar and thread are a single closed polygon in
// the (r, z) half-plane, swept through the angles with the radius modulated by a
// cross-section function. Three consequences worth stating:
//
//   * it is watertight by construction — no caps to forget, no boolean to fail
//     on a coplanar face. That is this project's doctrine: build it, do not
//     carve it;
//   * a shade with a bore through it is topologically a torus, and that is
//     fine. The validator asks whether the surface is closed, not its genus;
//   * a stave is the same sweep over part of a turn with its two ends capped,
//     so split mode is not a second geometry path that can rot on its own.
//
// Every cross-section here is analytic. There is no ray casting and no outline
// that can fold back through its own axis, which is what lets `dia` mean the
// bottom diameter exactly rather than to within a sampling error.
//
// HEAT, WHICH IS THE PART THAT IS NOT DECORATION
// PLA softens around 60 °C and the base of a hard-working E27 LED reaches it. A
// shade that hugs the lamp in PLA is a shade that droops. validate() measures
// the clearance from the declared lamp envelope to the wall and says which
// filament that leaves you; hints() argues it from the glass transition instead
// of waving at it.
//
// No DOM. Pure and deterministic — there is no noise in here to seed.

import { Mesh, TAU } from '../kernel/mesh.js';
import { triangulate } from '../kernel/poly2d.js';
import { pack, layout as packLayout, anyOverlap, withinBed } from '../kernel/pack.js';
import { clamp, num, DEG, RAD } from '../kernel/scalar.js';

const BED = { x: 180, y: 180, z: 180 };

const R_MIN = 0.6;          // mm — nothing is built closer to the axis than this
const T_MIN = 0.4;          // mm — one extrusion: the thinnest feather a scarf may end on
const MAX_CELLS = 60000;    // angular × meridian quads
const SHOULDER_MIN = 0.5;   // mm — the shoulder never closes to a knife edge
const PLA_TG = 60;          // °C, glass transition; the number the filament advice turns on

const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };

// ---------------------------------------------------------------------------
// Lamp envelopes. A shade has to clear the lamp, and the lamp is the dimension
// nobody remembers. These are the IEC designations: the number after the letter
// is the maximum diameter in millimetres, so a G95 really is 95 mm across.
// Lengths are from the shoulder of the E27 cap — where the fitter sits — which
// is the figure that decides whether the lamp pokes out of the bottom.
// ---------------------------------------------------------------------------

const LAMPS = {
  g45: { label: 'G45 golf ball', dia: 45, len: 78 },
  a60: { label: 'A60 pear (standard)', dia: 60, len: 110 },
  st64: { label: 'ST64 filament tube', dia: 64, len: 143 },
  g80: { label: 'G80 globe', dia: 80, len: 114 },
  g95: { label: 'G95 globe', dia: 95, len: 135 },
  g125: { label: 'G125 globe', dia: 125, len: 173 },
  r80: { label: 'R80 reflector', dia: 80, len: 112 },
};

// ---------------------------------------------------------------------------
// Silhouette. Unlike the vase, nothing here is normalised: `dia` is the bottom
// diameter and `topDia` is the top diameter, both exactly, and the profile only
// chooses the route between them. A shade is described by its two diameters and
// its slope, so those are the numbers that have to be true.
// ---------------------------------------------------------------------------

const PROFILES = ['straight', 'bell', 'ogee', 'dome', 'tulip'];

/**
 * f(0) = 0 at the mouth, f(1) = 1 at the top opening.
 *
 * Every one of these has a BOUNDED first derivative, and that is a printing
 * decision rather than an aesthetic one. A curve like t^0.45 is a perfectly
 * good bell on paper and its slope at the lip is infinite, which on a shade
 * printed fitter-down means a horizontal ceiling on the first millimetre of the
 * flare. The steepest of these is 2.2, so the worst lean a profile can
 * contribute is atan(2.2·Δr/height) and the overhang check has something
 * finite to report.
 */
function profileF(kind, t) {
  switch (kind) {
    case 'straight': return t;
    // Fat skirt at the lip, then quickly up to near the top diameter.
    case 'bell': return 1 - Math.pow(1 - t, 2.2);
    case 'ogee': return t * t * (3 - 2 * t);
    // Holds the bottom diameter low down and turns over near the top.
    case 'dome': return Math.pow(t, 2.2);
    // A reverse ogee: hugs the mouth diameter, then closes in a rush.
    case 'tulip': return t - 0.12 * Math.sin(TAU * t);
    default: return t;
  }
}

// ---------------------------------------------------------------------------
// Cross-section: unit radius by angle, maximum exactly 1, single-valued by
// construction.
// ---------------------------------------------------------------------------

const SECTIONS = ['circle', 'lobed', 'fluted', 'polygon', 'star', 'squircle'];

function sectionFn(s) {
  const n = s.sides, d = s.depth;
  switch (s.section) {
    case 'lobed':
      return (a) => 1 - d * 0.5 * (1 - Math.cos(n * a));
    // cos^0.6 is a shallow dish between sharp arrises — a Doric flute, not a
    // sine wave. It is flat zero over half of every period, which guarantees a
    // sample at full radius and keeps `dia` exact.
    case 'fluted':
      return (a) => { const c = Math.cos(n * a); return 1 - d * (c > 0 ? Math.pow(c, 0.6) : 0); };
    case 'polygon': {
      const h = Math.PI / n, k = Math.cos(h);
      return (a) => k / Math.cos((((a % (2 * h)) + 2 * h) % (2 * h)) - h);
    }
    case 'star': {
      const ri = Math.max(0.12, 1 - d);
      const step = TAU / n, h = step / 2;
      // The straight edge from a point (r = 1 at angle 0) to a valley (r = ri at
      // angle h), solved in polar coordinates — so the points really are at
      // radius 1 and the valleys really are at ri.
      return (a) => {
        let x = (((a % step) + step) % step);
        if (x > h) x = step - x;
        return (ri * Math.sin(h)) / (Math.sin(x) + ri * Math.sin(h - x));
      };
    }
    case 'squircle': {
      // A superellipse |x|^k + |y|^k = 1 is widest on the diagonals, not on the
      // axes: at 45° its radius is 2^(1/2 − 1/k), which for the classic k = 4 is
      // 1.19. Dividing by that is what makes `dia` the diameter across the
      // corners rather than a number 19% under the object.
      const k = s.squareness;
      const norm = Math.pow(2, 0.5 - 1 / k);
      return (a) => Math.pow(Math.pow(Math.abs(Math.cos(a)), k) + Math.pow(Math.abs(Math.sin(a)), k), -1 / k) / norm;
    }
    default: return () => 1;
  }
}

/** The smallest angular sample count that lands on every crest. */
function sectionStep(s) {
  if (s.section === 'circle') return 4;
  if (s.section === 'squircle') return 8;   // the crests are on the diagonals
  return 4 * s.sides;
}

/** The deepest valley of the cross-section, as a fraction of the radius. */
function sectionMin(s) {
  const u = sectionFn(s);
  let mn = 1;
  const n = 720;
  for (let i = 0; i < n; i++) mn = Math.min(mn, u(TAU * i / n));
  return mn;
}

/** Horizontal rings, cut inward, exactly `ribDepth` at the trough and exactly
 *  zero at both ends of the wall — which is what keeps `dia` and `topDia`
 *  honest however many rings you ask for. */
function ribAt(s, t) {
  if (!(s.ribs > 0 && s.ribDepth > 0)) return 0;
  return s.ribDepth * 0.5 * (1 - Math.cos(TAU * s.ribs * t));
}

// ---------------------------------------------------------------------------
// Thread. An internal thread on the collar bore, for the holder whose shade
// ring has gone missing. The surface is r = f(z − pitch·θ/2π): single valued in
// (θ, z) and period-1 in the phase, so it closes at θ = 2π without a seam and
// needs no boolean.
// ---------------------------------------------------------------------------

function threadPhase(z, a, pitch) {
  const u = (z - pitch * a / TAU) / pitch;
  return u - Math.floor(u);
}

function threadAmp(u) { return 0.5 * (1 - Math.cos(TAU * u)); }

// ---------------------------------------------------------------------------
// Settings — the one place every parameter is read, defaulted and clamped, so
// build(), validate() and hints() cannot disagree about what the numbers mean.
// ---------------------------------------------------------------------------

function settings(p, ctx = {}) {
  p = p || {};
  const segFactor = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const nozzle = clamp(num(ctx.nozzle, 0.4), 0.15, 1.2);
  const ew = Math.max(0.28, nozzle * 1.05);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);

  const dia = clamp(num(p.dia, 170), 50, 420);
  const height = clamp(num(p.height, 150), 35, 300);
  const spiral = p.mode === 'spiral';
  const wall = spiral ? ew : clamp(num(p.wall, 1.2), 0.6, 5);

  const fitter = ['ring', 'collar', 'thread', 'none'].includes(p.fitter) ? p.fitter : 'ring';
  const bore = clamp(num(p.bore, 41), 16, 90);
  const flange = clamp(num(p.flange, 9), 3, 40);
  const fitterT = clamp(num(p.fitterT, 2.4), 1, 8);
  const collarH = clamp(num(p.collarH, 12), 4, 40);
  const collarWall = clamp(num(p.collarWall, 2.4), 1, 8);
  const pitch = clamp(num(p.pitch, 2.5), 1, 5);
  const hem = clamp(num(p.hem, 0), 0, 8);

  const rBore = bore / 2;
  // The hub's outer radius — the flange for a ring fitter, the collar plus a
  // small shelf for the others. It is the radius the shoulder has to reach.
  const rHub = fitter === 'ring' ? rBore + flange
    : fitter === 'none' ? 0
      : rBore + collarWall + Math.min(flange, 5);

  // The top opening can never be narrower than the hub it has to meet, or there
  // is no shade left between the hole and the outside.
  const topDiaRaw = clamp(num(p.topDia, 90), 18, 420);
  const topDia = fitter === 'none'
    ? topDiaRaw
    : Math.max(topDiaRaw, 2 * rHub + 2 * (wall + 0.6));

  return {
    dia, topDia, topDiaAsked: topDiaRaw, height, hem,
    profile: PROFILES.includes(p.profile) ? p.profile : 'straight',
    bulge: clamp(num(p.bulge, 0), -30, 30),

    section: SECTIONS.includes(p.section) ? p.section : 'circle',
    sides: clamp(Math.round(num(p.sides, 12)), 3, 32),
    depth: clamp(num(p.depth, 22), 0, 90) / 100,
    squareness: clamp(num(p.squareness, 4), 2, 10),
    twist: clamp(num(p.twist, 0), -720, 720) * DEG,
    ribs: clamp(Math.round(num(p.ribs, 0)), 0, 40),
    ribDepth: clamp(num(p.ribDepth, 1.2), 0, 5),

    fitter, bore, rBore, flange, rHub, fitterT, collarH, collarWall, pitch,
    shoulder: clamp(num(p.shoulder, 50), 15, 82),

    spiral, wall, ew, nozzle, layerH,
    lamp: Object.prototype.hasOwnProperty.call(LAMPS, p.lamp) ? p.lamp : 'a60',

    staves: clamp(Math.round(num(p.staves, 1)), 1, 16),
    lap: clamp(num(p.lap, 8), 1, 20) * DEG,
    gap: clamp(num(p.gap, 0.15), 0.02, 0.6),
    arrange: p.arrange === 'assembled' ? 'assembled' : 'plate',
    orient: ['auto', 'up', 'down'].includes(p.orient) ? p.orient : 'auto',

    segFactor,
    bed: ctx.bed && Number.isFinite(ctx.bed.x) ? ctx.bed : BED,
  };
}

// ---------------------------------------------------------------------------
// Sampling density.
// ---------------------------------------------------------------------------

function pickN(s) {
  let n = Math.round(clamp(Math.max(72, s.dia), 24, 300) * s.segFactor);
  const step = sectionStep(s);
  n = Math.max(step, Math.ceil(n / step) * step);
  if (n > 960) n = Math.max(step, Math.floor(960 / step) * step);
  return n;
}

function pickM(s, zTop) {
  let m = Math.round(clamp(Math.max(16, zTop / 2.4), 8, 220) * s.segFactor);
  if (s.ribs > 0) m = Math.max(m, s.ribs * 8);
  if (s.twist !== 0) m = Math.max(m, Math.round(Math.abs(s.twist) * RAD / 6));
  // Land the rib crests and troughs exactly on levels, or the callout measures a
  // groove the mesh never quite cut.
  const per = 2 * Math.max(1, s.ribs);
  m = Math.max(per, Math.round(m / per) * per);
  return clamp(m, 4, 900);
}

// ---------------------------------------------------------------------------
// The meridian.
//
// A station is { rBase, z, mod, inset, role, thr }. Its radius at angle a is
//
//     R = rBase · (1 + mod · (u(a + twist) − 1))  −  inset
//
// so `mod` fades the cross-section out across the shoulder (the holder is
// round, whatever the shade is doing) and `inset` is the horizontal wall, which
// is subtracted AFTER the modulation so the wall comes out the same thickness in
// a flute valley as on a crest.
// ---------------------------------------------------------------------------

function geometry(s, { wallOnly = false, ringOnly = false } = {}) {
  const rTop = s.topDia / 2;
  const hemH = s.hem > 0 ? Math.max(s.hem, 0.8) : 0;
  const rBotWall = Math.max(R_MIN + s.wall + 0.2, s.dia / 2 - s.hem);

  // Where the wall stops, where the flange sits, and how tall the hub is.
  let rise = 0;
  let zF = s.height - s.fitterT;
  const hubStack = s.fitterT + (s.fitter === 'ring' ? 0 : s.collarH + Math.max(0, s.rHub - (s.rBore + s.collarWall)));
  if (s.fitter !== 'none') {
    const run = Math.abs(rTop - s.rHub);
    rise = run / Math.tan(s.shoulder * DEG);
    // The shoulder and the hub can never eat the whole shade. Keep at least a
    // fifth of the height as wall and let validate() explain the squeeze.
    rise = clamp(rise, 0, Math.max(0, s.height - hubStack - Math.max(6, s.height * 0.2)));
    zF = s.height - hubStack;
  }
  const zTop = s.fitter === 'none' ? s.height : Math.max(1, zF - rise);
  rise = s.fitter === 'none' ? 0 : zF - zTop;

  const rWallAt = (z) => {
    const t = clamp(z / zTop, 0, 1);
    const base = lerp(rBotWall, rTop, profileF(s.profile, t));
    const bow = s.bulge * Math.sin(Math.PI * t);
    const hemAdd = hemH > 0 ? s.hem * Math.max(0, 1 - z / hemH) : 0;
    return Math.max(R_MIN + T_MIN, base + bow + hemAdd - ribAt(s, t));
  };

  // `wall` is measured perpendicular to the surface, so a raked shade gets a
  // thicker horizontal section — the answer a CAD shell gives, and the reason a
  // 50° shoulder is not paper thin.
  const slopeAt = (z) => {
    const h = Math.max(1e-3, zTop * 1e-3);
    const z1 = Math.min(zTop, z + h), z0 = Math.max(0, z - h);
    return (rWallAt(z1) - rWallAt(z0)) / Math.max(1e-9, z1 - z0);
  };
  const hWall = (z) => s.wall * clamp(Math.sqrt(1 + Math.pow(slopeAt(z), 2)), 1, 6);

  // --- the wall's z stations --------------------------------------------
  const M = pickM(s, zTop);
  const zsSet = [];
  for (let j = 0; j <= M; j++) zsSet.push(zTop * j / M);
  if (hemH > 0 && hemH < zTop) zsSet.push(hemH);
  zsSet.sort((a, b) => a - b);
  const zs = [];
  for (const z of zsSet) if (!zs.length || z - zs[zs.length - 1] > 1e-7) zs.push(z);

  const wallOut = zs.map(z => ({ rBase: rWallAt(z), z, mod: 1, inset: 0, role: 'out', wh: hWall(z), shell: true }));
  const wallIn = zs.map(z => ({ rBase: rWallAt(z), z, mod: 1, inset: hWall(z), role: 'in', wh: hWall(z), shell: true }));

  const kSh = rise > 1e-6 ? clamp(Math.sqrt(1 + Math.pow((s.rHub - rTop) / rise, 2)), 1, 8) : 1;
  const whTop = hWall(zTop);
  // The shoulder is steeper than the wall, so it needs a THICKER horizontal
  // section to carry the same perpendicular wall: wall·kSh, not the wall's own
  // wall·kWall. Ramping between the two — which is what this did first — left a
  // 0.80 mm band at the top of a 1.2 mm shade, and the analysis panel in the
  // running app is what caught it. The step in the inner surface at the crease
  // is real and correct; a crease in a shell has one.
  const shInsetAt = (rB) => Math.min(s.wall * kSh, Math.max(SHOULDER_MIN, rB - s.rBore - SHOULDER_MIN));
  const rIn0 = clamp(s.rHub - shInsetAt(s.rHub), s.rBore + SHOULDER_MIN, s.rHub - SHOULDER_MIN);

  // --- the shoulder ------------------------------------------------------
  const nsh = s.fitter === 'none' ? 0
    : (rise > 0.5 ? clamp(Math.round(rise / 2 * s.segFactor), 3, 40) : 1);
  const shOut = [], shIn = [];
  for (let i = 1; i <= nsh; i++) {
    const u = i / nsh, mod = 1 - sstep(u);
    shOut.push({ rBase: lerp(rTop, s.rHub, u), z: lerp(zTop, zF, u), mod, inset: 0, shell: true });
  }
  for (let i = nsh - 1; i >= 1; i--) {
    const u = i / nsh, mod = 1 - sstep(u);
    const rB = lerp(rTop, s.rHub, u);
    shIn.push({ rBase: rB, z: lerp(zTop, zF, u), mod, inset: shInsetAt(rB), shell: true });
  }

  // --- the hub -----------------------------------------------------------
  const rCol = s.fitter === 'ring' ? s.rBore : s.rBore + s.collarWall;
  const boreTop = s.fitter === 'ring' ? zF + s.fitterT : s.height;
  const hub = [];
  if (s.fitter !== 'none') {
    hub.push({ rBase: s.rHub, z: zF + s.fitterT, mod: 0, inset: 0 });
    if (s.fitter === 'ring') {
      hub.push({ rBase: rCol, z: zF + s.fitterT, mod: 0, inset: 0 });
    } else {
      // A square step from the flange up to the collar is a horizontal ceiling
      // the width of the shelf, and a shade prints fitter down, so that ceiling
      // has nothing under it. A 45° chamfer costs `chamf` millimetres of height
      // and turns the worst face on the whole fitter into one the printer can
      // walk up.
      const chamf = Math.max(0, s.rHub - rCol);
      hub.push({ rBase: rCol, z: zF + s.fitterT + chamf, mod: 0, inset: 0 });
      hub.push({ rBase: rCol, z: s.height, mod: 0, inset: 0 });
      hub.push({ rBase: s.rBore, z: s.height, mod: 0, inset: 0 });
    }
    if (s.fitter === 'thread') {
      const steps = clamp(Math.round((boreTop - zF) / (s.pitch / 10) * s.segFactor), 10, 300);
      for (let i = 0; i <= steps; i++) {
        hub.push({ rBase: s.rBore, z: lerp(boreTop, zF, i / steps), mod: 0, inset: 0, thr: true });
      }
    } else {
      hub.push({ rBase: s.rBore, z: boreTop, mod: 0, inset: 0 });
      hub.push({ rBase: s.rBore, z: zF, mod: 0, inset: 0 });
    }
    hub.push({ rBase: rIn0, z: zF, mod: 0, inset: 0 });
  }

  // --- assemble the loop the caller asked for ----------------------------
  let loop;
  if (ringOnly) {
    // The fitter ring for a split shade: the shoulder and hub, plus a spigot
    // hanging below the seam that the staves slide over.
    const hSpig = clamp(Math.min(6, rise * 0.6 + 3), 2, 8);
    const rSpigOut = rTop - whTop - s.gap;
    const tSpig = Math.max(T_MIN + 0.2, Math.min(whTop, rSpigOut - R_MIN - 0.5));
    const rSpigIn = Math.max(R_MIN, rSpigOut - tSpig);
    loop = [
      { rBase: rTop, z: zTop, mod: 1, inset: 0 },
      ...shOut,
      ...hub,
      ...shIn,
      { rBase: rTop, z: zTop, mod: 1, inset: whTop },
      { rBase: rSpigIn, z: zTop - hSpig, mod: 0, inset: 0 },
      { rBase: rSpigOut, z: zTop - hSpig, mod: 0, inset: 0 },
      { rBase: rSpigOut, z: zTop, mod: 0, inset: 0 },
    ];
  } else if (wallOnly) {
    loop = [...wallOut, ...[...wallIn].reverse()];
  } else {
    loop = [...wallOut, ...shOut, ...hub, ...shIn, ...[...wallIn].reverse()];
  }

  loop = dedupe(loop);
  if (signedArea(loop) < 0) loop.reverse();

  // The envelope radius: u never exceeds 1, so the crest radius of a station is
  // its own rBase. A bow of +25 mm puts the widest ring at mid-height, not at
  // the mouth, and a bed check that trusted `dia` would wave it through.
  let maxR = 0;
  for (const st of loop) if (!st.inset) maxR = Math.max(maxR, st.rBase);

  return {
    loop, zTop, zF, rise, rTop, rBotWall, hWall, whTop, kSh, rIn0, nsh, hubStack,
    rCol, boreTop, zs, M, maxR,
  };
}

function statR(st, s, u, a, zTop) {
  if (st.thr) return st.rBase + 0.35 * s.pitch * threadAmp(threadPhase(st.z, a, s.pitch));
  let r = st.rBase;
  if (st.mod > 0) {
    const rot = s.twist * clamp(st.z / Math.max(1e-9, zTop), 0, 1);
    r = st.rBase * (1 + st.mod * (u(a + rot) - 1));
  }
  return Math.max(R_MIN, r - st.inset);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.rBase - p.rBase) < 1e-7 && Math.abs(q.z - p.z) < 1e-7
      && Math.abs((q.inset || 0) - (p.inset || 0)) < 1e-7 && !q.thr === !p.thr) continue;
    out.push(p);
  }
  const a = out[0], b = out[out.length - 1];
  if (out.length > 3 && Math.abs(a.rBase - b.rBase) < 1e-7 && Math.abs(a.z - b.z) < 1e-7
    && Math.abs((a.inset || 0) - (b.inset || 0)) < 1e-7) out.pop();
  return out;
}

function signedArea(loop) {
  let acc = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const ar = a.rBase - (a.inset || 0), br = b.rBase - (b.inset || 0);
    acc += ar * b.z - br * a.z;
  }
  return acc / 2;
}

// ---------------------------------------------------------------------------
// The sweep. One grid of (angle × meridian station), quads both ways. A full
// turn wraps and needs no caps; a stave does not wrap, and its two ends are the
// meridian polygon triangulated in its own plane.
// ---------------------------------------------------------------------------

function sweepMesh(s, g, span = null) {
  const u = sectionFn(s);
  const full = !span;
  const loop = g.loop;
  const N = pickN(s);
  const zTop = g.zTop;

  let angles;
  if (full) {
    let n = N;
    if (n * loop.length > MAX_CELLS) n = Math.max(sectionStep(s), Math.floor(MAX_CELLS / loop.length / sectionStep(s)) * sectionStep(s));
    angles = new Float64Array(n);
    for (let k = 0; k < n; k++) angles[k] = TAU * k / n;
  } else {
    const want = (span.a1 - span.a0) / (TAU / N);
    let nA = Math.max(8, Math.ceil(want));
    if ((nA + 1) * loop.length > MAX_CELLS) nA = Math.max(8, Math.floor(MAX_CELLS / loop.length) - 1);
    angles = new Float64Array(nA + 1);
    for (let k = 0; k <= nA; k++) angles[k] = span.a0 + (span.a1 - span.a0) * k / nA;
  }
  const K = angles.length;

  // The scarf. Over the lap a stave's wall tapers so that its own thickness plus
  // its neighbour's is one wall less the glue gap — which is why the joint does
  // not read as a bright line or a dark one once the lamp is on.
  const lapA = span ? span.lapA : 0;
  const scarfR = (st, a, base) => {
    if (!(lapA > 0) || !st.role) return base;
    const wh = st.wh;
    const tot = wh - s.gap;
    const spanT = tot - 2 * T_MIN;
    if (spanT <= 0.02) return base;
    const rOut = st.role === 'out' ? base : base + wh;
    const lead = (a - span.a0) / lapA;
    const trail = (a - (span.a1 - lapA)) / lapA;
    if (lead < 1) {
      const tOut = T_MIN + spanT * sstep(lead);
      return st.role === 'out' ? rOut : rOut - tOut;
    }
    if (trail > 0) {
      const tIn = T_MIN + spanT * (1 - sstep(trail));
      return st.role === 'out' ? rOut - wh + tIn : rOut - wh;
    }
    return base;
  };

  const m = new Mesh();
  const rows = [];
  for (let k = 0; k < K; k++) {
    const a = angles[k];
    const row = new Int32Array(loop.length);
    for (let j = 0; j < loop.length; j++) {
      const st = loop[j];
      const r = Math.max(R_MIN, scarfR(st, a, statR(st, s, u, a, zTop)));
      row[j] = m.addVertex(r * Math.cos(a), r * Math.sin(a), st.z);
    }
    rows.push(row);
  }

  const last = full ? K : K - 1;
  for (let k = 0; k < last; k++) {
    const A = rows[k], B = rows[(k + 1) % K];
    for (let j = 0; j < loop.length; j++) {
      const j1 = (j + 1) % loop.length;
      // A–B–B′–A′ rather than A–A′–B′–B: (r, z, θ) is a left-handed frame, so
      // the winding that faces outward here is the mirror of the one that does
      // in (x, y, z). Proved by mesh.volume() coming out positive, not assumed.
      m.addQuad(A[j], B[j], B[j1], A[j1]);
    }
  }

  if (!full) {
    // Cap both ends with the meridian polygon triangulated in its own plane. A
    // counter-clockwise triangle in (r, z) faces along r̂ × ẑ, which is −φ̂, so
    // the low-angle end takes them as they come and the high-angle end flips.
    for (const [k, flip] of [[0, false], [K - 1, true]]) {
      const a = angles[k];
      const ring = loop.map(st => [Math.max(R_MIN, scarfR(st, a, statR(st, s, u, a, zTop))), st.z]);
      const { points, tris } = triangulate([ring]);
      if (!points.length) continue;
      const idx = points.map(q => m.addVertex(q[0] * Math.cos(a), q[0] * Math.sin(a), q[1]));
      for (let i = 0; i < tris.length; i += 3) {
        if (flip) m.addTri(idx[tris[i]], idx[tris[i + 2]], idx[tris[i + 1]]);
        else m.addTri(idx[tris[i]], idx[tris[i + 1]], idx[tris[i + 2]]);
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Print orientation. Walk the closed meridian and classify every segment: in a
// counter-clockwise loop with material inside, the outward normal of p0 → p1 is
// (Δz, −Δr), so the face looks downward when Δr > 0. Mirroring in z flips that
// test and nothing else, which is why one walk answers both orientations.
// Faces lying on the bed are not overhangs and are excluded at each end.
// ---------------------------------------------------------------------------

/**
 * A shell face and a solid face are not the same overhang, and lumping them
 * together is why the first version of this could not tell the two orientations
 * of a plain shade apart.
 *
 * A thin shell of constant thickness leans the same amount on both of its
 * surfaces, so one of them is always an overhang whichever way up you print it.
 * It prints anyway, because what actually holds a layer up is the previous
 * layer underneath it: the wall shifts sideways by lean·layerH per layer and
 * keeps printing as long as that shift is less than the wall is thick. At a
 * 1.2 mm wall and 0.2 mm layers that is a shift of six to one — about 80° from
 * vertical — which is why vases and lampshades print at angles that would
 * destroy a solid part.
 *
 * A solid horizontal face has nothing of the sort. The underside of a flange is
 * a ceiling and it droops at 90° whatever the wall thickness is.
 *
 * So the scan reports the two separately and the orientation is chosen on the
 * solid faces first, with the footprint on the bed breaking the tie — a wide
 * first layer is worth more than a degree of lean.
 */
function leanScan(g) {
  const loop = g.loop;
  let zMin = Infinity, zMax = -Infinity;
  for (const st of loop) { zMin = Math.min(zMin, st.z); zMax = Math.max(zMax, st.z); }
  const out = { up: 0, down: 0, upAt: 0, downAt: 0, upSolid: 0, downSolid: 0, upSolidAt: 0, downSolidAt: 0 };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const ar = a.rBase - (a.inset || 0), br = b.rBase - (b.inset || 0);
    const dr = br - ar, dz = b.z - a.z;
    if (Math.abs(dr) < 1e-9 && Math.abs(dz) < 1e-9) continue;
    const lean = Math.atan2(Math.abs(dr), Math.abs(dz)) * RAD;
    const zMid = (a.z + b.z) / 2;
    const shell = !!(a.shell && b.shell);
    // Faces lying on the bed are not overhangs, and which end is the bed
    // depends on which way up it goes.
    if (dr > 0 && zMid > zMin + 1e-6) {
      if (lean > out.up) { out.up = lean; out.upAt = zMid; }
      if (!shell && lean > out.upSolid) { out.upSolid = lean; out.upSolidAt = zMid; }
    }
    if (dr < 0 && zMid < zMax - 1e-6) {
      if (lean > out.down) { out.down = lean; out.downAt = zMid; }
      if (!shell && lean > out.downSolid) { out.downSolid = lean; out.downSolidAt = zMid; }
    }
  }
  return out;
}

/**
 * Two leans, both arithmetic rather than taste. A layer of a leaning shell steps
 * sideways by layerH·tan θ. While that step is under half the wall the new layer
 * still lands mostly on the last one and the surface stays clean; once it
 * exceeds a whole wall the new material lands on nothing at all.
 * At 1.2 mm and 0.2 mm layers that is 72° and 81°.
 */
function shellLimit(s) { return Math.atan2(s.wall, s.layerH) * RAD; }
function shellComfort(s) { return Math.atan2(s.wall, 2 * s.layerH) * RAD; }

/** The radius resting on the bed, which decides how well the first layer sticks. */
function footRadius(s, g, flip) {
  if (!flip) return g.loop.reduce((m, st) => (st.z < 1e-6 ? Math.max(m, st.rBase) : m), 0);
  return s.fitter === 'none' ? g.rTop : s.rHub;
}

/** Which way up to print it, and why. `flip` means the fitter goes on the bed. */
function chooseOrient(s, g) {
  const scan = leanScan(g);
  if (s.orient === 'up') return { flip: false, scan, auto: false };
  if (s.orient === 'down') return { flip: true, scan, auto: false };
  // Solid ceilings first — one of those is fatal and a shell lean rarely is.
  if (Math.abs(scan.downSolid - scan.upSolid) > 0.5) {
    return { flip: scan.downSolid < scan.upSolid, scan, auto: true };
  }
  if (Math.abs(scan.down - scan.up) > 0.5) return { flip: scan.down < scan.up, scan, auto: true };
  // A dead heat on both: take the bigger first layer.
  return { flip: footRadius(s, g, true) > footRadius(s, g, false), scan, auto: true };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function fits(m, bed) {
  const z = m.bbox().size;
  return z[0] <= bed.x + 1e-6 && z[1] <= bed.y + 1e-6 && z[2] <= bed.z + 1e-6;
}

/** The fewest staves whose chord fits across the bed. 0 when even two will not. */
function minStaves(s) {
  for (let k = 2; k <= 16; k++) {
    const halfSpan = Math.PI / k + s.lap / 2;
    if (halfSpan >= Math.PI / 2) continue;
    const chord = s.dia * Math.sin(halfSpan);
    if (chord <= s.bed.x - 8) return k;
  }
  return 0;
}

/** How many bed-loads the split parts actually need. Built by packing, not by
 *  dividing areas, because a long thin stave wastes most of a bed. */
function splitPlateCount(s) {
  if (s.staves <= 1) return 1;
  const g = geometry(s, { wallOnly: true });
  const step = TAU / s.staves;
  const lapA = Math.min(s.lap, step * 0.6);
  // A stave stands upright, so its footprint is the annular sector it sweeps —
  // from the top-opening radius out to the mouth — not the thin arc of its own
  // material. Turned to face +x, that box is (maxR − rTop·cos halfSpan) deep and
  // 2·maxR·sin halfSpan wide. Estimating it as an arc strip said two plate-loads
  // where the packer found nine.
  const half = Math.min(Math.PI / 2, step / 2 + lapA / 2);
  const rt = s.topDia / 2;
  const deep = g.maxR - (half >= Math.PI / 2 ? -g.maxR : rt * Math.cos(half));
  const wide = 2 * g.maxR * Math.sin(half);
  const items = [];
  for (let i = 0; i < s.staves; i++) items.push({ id: `s${i}`, w: wide, d: deep });
  items.push({ id: 'ring', w: s.topDia, d: s.topDia });
  let queue = items, plates = 0, guard = 0;
  while (queue.length && guard++ < 24) {
    let pk = null;
    try { pk = pack(queue, s.bed, { gap: 4 }); } catch { pk = null; }
    if (!pk || !pk.placed.length) return 0;
    plates++;
    const done = new Set(pk.placed.map(x => x.id));
    queue = queue.filter(it => !done.has(it.id));
  }
  return queue.length ? 0 : plates;
}

function buildParts(s) {
  const g = geometry(s);
  if (s.staves <= 1) {
    const { flip, scan } = chooseOrient(s, g);
    let m = sweepMesh(s, g);
    if (flip) m = m.rotateX(Math.PI);
    return { g, flip, scan, single: true, parts: [{ name: 'Shade', mesh: m.place() }] };
  }

  // Split: K staves of wall, plus one whole fitter ring they all glue into.
  const gw = geometry(s, { wallOnly: true });
  const gr = geometry(s, { ringOnly: true });
  const K = s.staves;
  const step = TAU / K;
  // A lap can never be a whole sector, or a stave would overlap the one two
  // along and the scarf would have nothing to taper into.
  const lapA = Math.min(s.lap, step * 0.6);

  const parts = [];
  for (let i = 0; i < K; i++) {
    const a0 = i * step;
    const mesh = sweepMesh(s, gw, { a0, a1: a0 + step + lapA, lapA });
    // Every stave is the same shape, but stave 5 sits at 180° and its bounding
    // box is the mirror of stave 1's. Packing them where they stand gave nine
    // plate-loads for nine parts. `spin` turns each one back to face +x, where
    // its box is as narrow as the shape allows, and the packer can then put four
    // on a bed. The assembled view uses the unspun mesh.
    parts.push({ name: `Stave ${i + 1}`, mesh, spin: -(a0 + (step + lapA) / 2) });
  }
  parts.push({ name: 'Fitter ring', mesh: sweepMesh(s, gr), spin: 0, ring: true });
  return { g, gw, gr, flip: false, scan: leanScan(g), single: false, parts, lapA, step };
}

/** Lay the parts out: `assembled` is how it looks, `plate` is how it prints. */
function arrangeParts(s, built) {
  const parts = built.parts;
  if (built.single) return { mode: 'single', parts, mesh: parts[0].mesh, plate: null };

  if (s.arrange === 'assembled') {
    // The staves already sit at their own angles and the scarf leaves a glue gap
    // between them, so the assembly is a set of solids that do not touch. The
    // ring drops onto the seam.
    const merged = Mesh.merge(parts.map(p => p.mesh));
    const b = merged.bbox();
    const off = [-b.center[0], -b.center[1], -b.min[2]];
    return {
      mode: 'assembled', off,
      mesh: merged.translate(off[0], off[1], off[2]),
      parts: parts.map(p => ({ name: p.name, mesh: p.mesh.translate(off[0], off[1], off[2]) })),
      plate: { packed: false, overlap: false, fitsBed: fits(merged, s.bed),
        parts: parts.map(p => ({ name: p.name, x: 0, y: 0 })) },
    };
  }

  // Plate: every stave stands on its mouth (the wall leans inward going up, so
  // it is self-supporting that way), and the ring lies flange-down.
  const laidOut = parts.map((p) => {
    const mesh = p.ring ? p.mesh.rotateX(Math.PI) : p.mesh.rotateZ(p.spin || 0);
    return { name: p.name, mesh: mesh.centerXY().dropToPlate() };
  });
  const byId = {};
  for (const p of laidOut) byId[p.name] = p.mesh;

  // Nine staves do not go on one A1 mini. Pack what fits, take it off the bed,
  // pack the rest, and keep going — then show the plate-loads side by side in a
  // grid so the preview stays a preview instead of a two-metre row. `plates`
  // says how many times you will be back at the printer; a layout that silently
  // spread nine parts across 1.4 m and called itself a bed would be a lie.
  const remaining = laidOut.map(p => {
    const b = p.mesh.bbox();
    return { id: p.name, w: b.size[0], d: b.size[1] };
  });
  const plates = [];
  let guard = 0;
  let queue = remaining;
  while (queue.length && guard++ < 24) {
    let packing = null;
    try { packing = pack(queue, s.bed, { gap: 4 }); } catch { packing = null; }
    if (!packing || !packing.placed.length) break;
    plates.push(packing);
    const done = new Set(packing.placed.map(pp => pp.id));
    queue = queue.filter(it => !done.has(it.id));
  }

  let placed = [], plate;
  if (!plates.length || queue.length) {
    // Nothing packs: fall back to a plain row and say so rather than pretending.
    let x = 0;
    const rows = laidOut.map(p => {
      const b = p.mesh.bbox();
      const row = { name: p.name, mesh: p.mesh, w: b.size[0], x: x + b.size[0] / 2, d: b.size[1] };
      x += b.size[0] + 4;
      return row;
    });
    const total = x - 4;
    placed = rows.map(r => ({ name: r.name, mesh: r.mesh.translate(r.x - total / 2, 0, 0) }));
    plate = {
      packed: false, plates: 0, overlap: false, fitsBed: false,
      parts: rows.map(r => ({ name: r.name, x: r.x - total / 2, y: 0, w: r.w, d: r.d, rot: false })),
    };
  } else {
    const cols = Math.min(plates.length, 3);
    const stepX = s.bed.x + 20, stepY = s.bed.y + 20;
    const partRows = [];
    plates.forEach((packing, i) => {
      const ox = (i % cols) * stepX - (cols - 1) * stepX / 2;
      const oy = -Math.floor(i / cols) * stepY;
      const laid = packLayout(byId, packing);
      for (const pp of laid.parts) placed.push({ name: pp.id, mesh: pp.mesh.translate(ox, oy, 0) });
      for (const pp of packing.placed) {
        partRows.push({ name: pp.id, plate: i + 1, x: pp.x + ox, y: pp.y + oy, w: pp.w, d: pp.d, rot: pp.rot });
      }
    });
    plate = {
      packed: true, plates: plates.length,
      overlap: plates.some(pk => !!anyOverlap(pk)),
      fitsBed: plates.length === 1 && withinBed(plates[0], s.bed),
      fill: plates[0].fill, used: plates[0].used,
      parts: partRows,
    };
  }
  const merged = Mesh.merge(placed.map(p => p.mesh));
  const b = merged.bbox();
  const off = [-b.center[0], -b.center[1], -b.min[2]];
  return {
    mode: 'plate', off,
    mesh: merged.translate(off[0], off[1], off[2]),
    parts: placed.map(p => ({ name: p.name, mesh: p.mesh.translate(off[0], off[1], off[2]) })),
    plate,
  };
}

function build(p, ctx = {}) {
  const s = settings(p, ctx);
  const prog = typeof ctx.progress === 'function' ? ctx.progress : null;
  const built = buildParts(s);
  if (prog) prog(0.7);
  const arranged = arrangeParts(s, built);
  if (prog) prog(1);

  const meta = {
    fitter: s.fitter, orient: built.flip ? 'fitter down' : 'fitter up',
    staves: s.staves, arrange: arranged.mode,
    openArea: Math.round(Math.PI * Math.pow(s.topDia / 2, 2) - Math.PI * Math.pow(s.rHub, 2)),
    dims: shadeDims(p, s, built, arranged),
  };
  if (arranged.plate) meta.plate = arranged.plate;
  return { mesh: arranged.mesh, parts: arranged.parts, meta };
}

// ---------------------------------------------------------------------------
// Dimension callouts. Computed in shade space, then pushed through exactly the
// transform the part they belong to received — a callout drawn on the assembled
// object when the object on the bed is six staves in a row is a drawing of
// something that does not exist.
// ---------------------------------------------------------------------------

const VIEW_EDGE = 30 * DEG;

function shadeDims(p, s, built, arranged) {
  const g = built.g;
  const u = sectionFn(s);
  const dims = [];

  // Only the one-piece shade is drawn in shade space; the plate layout gets the
  // measurements that live inside a single part, and the assembled split shade
  // gets the whole set because its parts really are where they say they are.
  if (!built.single && arranged.mode === 'plate') return plateDims(p, s, built, arranged);

  const H = s.height;
  const flip = built.flip;
  // place() centres in XY and drops to z = 0; XY is already centred on the axis,
  // so the only transform that moves a point is the flip and the drop.
  const zOf = (z) => (flip ? H - z : z);
  const pt = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), zOf(z)];

  // The crest angle nearest the default view edge, so a radial measurement is
  // seen edge-on rather than foreshortened to a dot — and, more importantly, so
  // the endpoint of a diameter callout is genuinely ON the surface. Solved
  // rather than searched: on a polygon the crests are seven points wide at
  // best, and a 720-sample scan walks straight past them.
  const crestSpacing = (s.section === 'circle' || s.section === 'squircle')
    ? Math.PI / 2 : TAU / s.sides;
  const crestPhase = s.section === 'fluted' ? crestSpacing / 2 : 0;
  const crest = (z) => {
    const rot = s.twist * clamp(z / Math.max(1e-9, g.zTop), 0, 1);
    // World angle a puts section angle a + rot on a crest.
    const want = VIEW_EDGE;
    const k = Math.round((want + rot - crestPhase) / crestSpacing);
    return crestPhase + k * crestSpacing - rot;
  };

  // Bottom diameter, crest to crest through the axis at the mouth.
  {
    const a = crest(0);
    const rb = s.dia / 2;
    dims.push({ param: 'dia', label: 'Ø', from: pt(rb, a, 0), to: pt(rb, a + Math.PI, 0),
      offset: [0, 0, flip ? 8 : -8] });
  }
  // Top opening.
  {
    const a = crest(g.zTop);
    const rt = s.topDia / 2;
    dims.push({ param: 'topDia', label: 'Ø', from: pt(rt, a, g.zTop), to: pt(rt, a + Math.PI, g.zTop),
      offset: [0, 0, flip ? -8 : 8] });
  }
  // Overall height, on the outside at the view edge.
  {
    const a = crest(0);
    const r = s.dia / 2;
    dims.push({ param: 'height', from: pt(r, a, 0), to: pt(r, a, H), offset: [7 * Math.cos(a), 7 * Math.sin(a), 0] });
  }
  // Wall, perpendicular to the surface at mid-height — the same trick the vase
  // uses, because on a raked wall the horizontal section is not the wall. Not
  // drawn in spiral mode: there the wall in the model is one extrusion and the
  // `wall` parameter is not what the object measures.
  if (!s.spiral) {
    const zm = g.zTop * 0.5;
    const a = crest(zm);
    const rOut = rWallOuter(s, g, zm, a, u);
    const sl = (rWallOuter(s, g, Math.min(g.zTop, zm + 0.5), a, u) - rWallOuter(s, g, Math.max(0, zm - 0.5), a, u)) / 1.0;
    const q = Math.sqrt(1 + sl * sl);
    const nr = 1 / q, nz = -sl / q;
    dims.push({ param: 'wall',
      from: pt(rOut, a, zm),
      to: [ (rOut - s.wall * nr) * Math.cos(a), (rOut - s.wall * nr) * Math.sin(a), zOf(zm - s.wall * nz * (flip ? -1 : 1)) ],
      offset: [5 * Math.cos(a), 5 * Math.sin(a), 0] });
  }
  if (s.fitter !== 'none') {
    // Bore, across the hole. A threaded bore is not a circle, so that one
    // declares its value rather than pretending the callout measured it.
    const zb = s.fitter === 'ring' ? g.zF + s.fitterT : H;
    const d = { param: 'bore', label: 'Ø',
      from: pt(s.rBore, VIEW_EDGE, zb), to: pt(s.rBore, VIEW_EDGE + Math.PI, zb), offset: [0, 0, flip ? -6 : 6] };
    if (s.fitter === 'thread') d.value = s.bore;
    dims.push(d);
    if (s.fitter === 'ring') {
      dims.push({ param: 'flange',
        from: pt(s.rBore, VIEW_EDGE, g.zF + s.fitterT), to: pt(s.rHub, VIEW_EDGE, g.zF + s.fitterT),
        offset: [0, 0, flip ? -4 : 4] });
    }
    dims.push({ param: 'fitterT',
      from: pt(s.rHub, VIEW_EDGE, g.zF), to: pt(s.rHub, VIEW_EDGE, g.zF + s.fitterT),
      offset: [5 * Math.cos(VIEW_EDGE), 5 * Math.sin(VIEW_EDGE), 0] });
    if (s.fitter !== 'ring') {
      dims.push({ param: 'collarH',
        from: pt(g.rCol, VIEW_EDGE, H - s.collarH), to: pt(g.rCol, VIEW_EDGE, H),
        offset: [5 * Math.cos(VIEW_EDGE), 5 * Math.sin(VIEW_EDGE), 0] });
    }
  }
  if (s.ribs > 0 && s.ribDepth > 0) {
    // The trough of the ring nearest mid-height: every ring is exactly ribDepth
    // deep at u = ½.
    const k = Math.floor((s.ribs - 1) / 2) + 0.5;
    const z = g.zTop * k / s.ribs;
    const a = crest(z);
    const rOut = rWallOuter(s, g, z, a, u);
    dims.push({ param: 'ribDepth', from: pt(rOut, a, z), to: pt(rOut + s.ribDepth, a, z), offset: [0, 0, 6] });
  }
  if (s.hem > 0) {
    dims.push({ param: 'hem', value: s.hem,
      from: pt(s.dia / 2, VIEW_EDGE, 0), to: pt(s.dia / 2 - s.hem, VIEW_EDGE, Math.max(s.hem, 0.8)),
      offset: [6 * Math.cos(VIEW_EDGE), 6 * Math.sin(VIEW_EDGE), 0] });
  }
  if (s.bulge !== 0) {
    const z = g.zTop * 0.5;
    const a = crest(z);
    const rOut = rWallOuter(s, g, z, a, u);
    dims.push({ param: 'bulge', value: s.bulge,
      from: pt(rOut - s.bulge, a, z), to: pt(rOut, a, z), offset: [0, 0, 6] });
  }
  return dims;
}

/** Outer radius of the wall at (z, a), the same arithmetic the mesh used. */
function rWallOuter(s, g, z, a, u) {
  const st = { rBase: 0, z, mod: 1, inset: 0 };
  const t = clamp(z / g.zTop, 0, 1);
  const rTop = s.topDia / 2;
  const hemH = s.hem > 0 ? Math.max(s.hem, 0.8) : 0;
  const base = lerp(g.rBotWall, rTop, profileF(s.profile, t))
    + s.bulge * Math.sin(Math.PI * t)
    + (hemH > 0 ? s.hem * Math.max(0, 1 - z / hemH) : 0)
    - ribAt(s, t);
  st.rBase = Math.max(R_MIN + T_MIN, base);
  return statR(st, s, u, a, g.zTop);
}

/** On the plate there is no assembled shade to draw on, so each callout is
 *  anchored to the part that actually carries it. */
function plateDims(p, s, built, arranged) {
  const dims = [];
  const g = built.gw;
  const stave = arranged.parts.find(q => /^Stave 1$/.test(q.name));
  const ring = arranged.parts.find(q => q.name === 'Fitter ring');
  if (stave) {
    const b = stave.mesh.bbox();
    dims.push({ param: 'height', label: 'stave', value: Math.round(g.zTop * 10) / 10, unit: 'mm',
      from: [b.min[0], b.center[1], b.min[2]], to: [b.min[0], b.center[1], b.max[2]], offset: [-6, 0, 0] });
    dims.push({ param: 'staves', label: 'staves', value: s.staves, unit: '',
      from: [b.min[0], b.center[1], b.max[2]], to: [b.max[0], b.center[1], b.max[2]], offset: [0, 0, 8] });
  }
  if (ring) {
    const b = ring.mesh.bbox();
    const cz = b.min[2] + Math.min(s.fitterT, b.size[2]) / 2;
    const d = { param: 'bore', label: 'Ø',
      from: [b.center[0] - s.rBore, b.center[1], cz], to: [b.center[0] + s.rBore, b.center[1], cz], offset: [0, 0, 6] };
    if (s.fitter === 'thread') d.value = s.bore;
    dims.push(d);
    if (s.fitter === 'ring') {
      dims.push({ param: 'flange',
        from: [b.center[0] + s.rBore, b.center[1], b.min[2]], to: [b.center[0] + s.rHub, b.center[1], b.min[2]],
        offset: [0, -6, 0] });
    }
  }
  return dims;
}

// ---------------------------------------------------------------------------
// validate — the part that stops a shade you cannot hang, cannot print, or
// should not put a lamp in.
// ---------------------------------------------------------------------------

/** The narrowest the shade gets at height z, over every angle: the deepest
 *  valley of the cross-section, less the wall. Covers the wall and the
 *  shoulder, which is where the shade is tightest and where a cylinder model of
 *  the lamp would cry wolf. */
function innerAt(s, g, z, uMin) {
  if (z <= g.zTop) {
    return rWallOuter(s, g, z, 0, () => 1) * uMin - g.hWall(z);
  }
  if (s.fitter === 'none' || g.rise <= 1e-6) return g.rTop * uMin - g.whTop;
  const u = clamp((z - g.zTop) / g.rise, 0, 1);
  const mod = 1 - sstep(u);
  const rBase = lerp(g.rTop, s.rHub, u);
  const inset = lerp(g.whTop, s.rHub - g.rIn0, u);
  return rBase * (1 + mod * (uMin - 1)) - inset;
}

/**
 * The lamp as an envelope rather than a cylinder. A cylinder the full diameter
 * of the glass, starting at the cap, reports a collision on every shade ever
 * made — the cap is 27 mm across and the glass does not reach full width until
 * it is well clear of the shoulder. So: the E27 cap radius for the first fifth,
 * out to full width by a little under half way, full width to four fifths, then
 * closing to the tip. Crude, but it is the shape of a pear and of a globe, and
 * it puts the tightest point where the hot glass actually is.
 */
function lampRadiusAt(lamp, d) {
  const R = lamp.dia / 2, rCap = 13.5;
  const t = clamp(d / Math.max(1e-6, lamp.len), 0, 1);
  if (t <= 0.18) return rCap;
  if (t < 0.45) return lerp(rCap, R, (t - 0.18) / 0.27);
  if (t <= 0.82) return R;
  return lerp(R, rCap * 0.35, (t - 0.82) / 0.18);
}

/**
 * Two numbers, because they answer two different questions.
 *
 *   hit   the smallest gap anywhere along the lamp, including the neck. Below
 *         zero the lamp does not physically go in.
 *   clear the smallest gap where the lamp is at more than sixty per cent of its
 *         diameter — the hot glass, and the only part whose distance from the
 *         wall decides the filament. Measuring the neck instead reports fifteen
 *         millimetres on every shade ever made, because the cap is always a few
 *         centimetres from a flange it is bolted to, and a warning that fires
 *         every time is a warning nobody reads.
 */
function lampClearance(s, g) {
  const lamp = LAMPS[s.lamp];
  const uMin = sectionMin(s);
  // The cap shoulder sits at the flange underside; the lamp hangs from there.
  const zSeat = s.fitter === 'none' ? s.height : g.zF;
  const R = lamp.dia / 2, rCapOf = 13.5;
  let hit = Infinity, clear = Infinity, at = 0;
  const n = 160;
  for (let i = 0; i <= n; i++) {
    const d = lamp.len * i / n;
    const z = zSeat - d;
    if (z < 0) break;
    const lr = lampRadiusAt(lamp, d);
    const c = innerAt(s, g, z, uMin) - lr;
    if (c < hit) hit = c;
    // "Body" means clearly wider than the cap: on a G45 golf ball 0.6 R IS the
    // cap radius, and measuring there reports the flange-to-cap gap on every
    // shade and warns about a lamp that has fifty millimetres of air round it.
    if (lr >= Math.max(0.75 * R, rCapOf + 2) && c < clear) { clear = c; at = z; }
  }
  if (clear === Infinity) clear = hit === Infinity ? 999 : hit;
  return {
    clear, hit: hit === Infinity ? 999 : hit, at, lamp,
    pokes: lamp.len > zSeat,
  };
}

function validate(p, ctx = {}) {
  const s = settings(p, ctx);
  const g = geometry(s);
  const out = [];

  // 1. The fitting, which is the whole reason this generator exists.
  if (s.fitter !== 'none') {
    if (s.bore < 20) {
      out.push({ param: 'bore', severity: 'warn',
        message: `a ${s.bore.toFixed(1)} mm bore will not pass a European E27 holder — its shade-ring thread is Ø 40 mm, so 41 mm is the working figure` });
    }
    if (s.fitter === 'ring' && s.flange < 7) {
      out.push({ param: 'flange', severity: 'error',
        message: `a ${s.flange.toFixed(1)} mm flange leaves a 54 mm shade ring only ${(s.flange - (54 - s.bore) / 2).toFixed(1)} mm of overlap on a ${s.bore.toFixed(0)} mm bore. Use at least ${((54 - s.bore) / 2 + 2).toFixed(0)} mm, or the ring clamps fresh air` });
    }
    if (s.rHub - s.wall * g.kSh <= s.rBore + SHOULDER_MIN) {
      out.push({ param: 'flange', severity: 'warn',
        message: `the ${s.wall.toFixed(1)} mm wall on a ${s.shoulder.toFixed(0)}° shoulder needs ${(s.wall * g.kSh).toFixed(1)} mm of hub to land on, and there is only ${(s.rHub - s.rBore).toFixed(1)} mm. The underside of the flange has been pinched to fit` });
    }
    if (s.topDiaAsked < s.topDia - 0.01) {
      out.push({ param: 'topDia', severity: 'info',
        message: `a ${s.topDiaAsked.toFixed(0)} mm opening cannot clear a ${(2 * s.rHub).toFixed(0)} mm hub with a wall on it; it has been opened to ${s.topDia.toFixed(0)} mm` });
    }
    if (s.fitter === 'thread' && Math.abs(s.pitch - 2.5) > 0.01) {
      out.push({ param: 'pitch', severity: 'warn',
        message: `a European E27 shade ring runs a 2.5 mm lead; ${s.pitch.toFixed(1)} mm will not engage one. Change it only if you have measured your own holder` });
    }
  }

  // 2. The shoulder, which is where a shade turns into an overhang.
  if (s.fitter !== 'none') {
    const wantRise = Math.abs(s.topDia / 2 - s.rHub) / Math.tan(s.shoulder * DEG);
    if (wantRise > g.rise + 0.5) {
      out.push({ param: 'shoulder', severity: 'warn',
        message: `a ${s.shoulder.toFixed(0)}° shoulder from a ${s.topDia.toFixed(0)} mm opening down to a ${(2 * s.rHub).toFixed(0)} mm hub wants ${wantRise.toFixed(0)} mm of rise and there are only ${g.rise.toFixed(0)} mm left under the ${s.height.toFixed(0)} mm height. The shoulder has been flattened to ${(Math.atan2(Math.abs(s.topDia / 2 - s.rHub), Math.max(0.01, g.rise)) * RAD).toFixed(0)}°, which is a worse overhang than you asked for` });
    }
  }

  // 3. Print orientation and overhang.
  const { flip, scan, auto } = chooseOrient(s, g);
  const solid = flip ? scan.downSolid : scan.upSolid;
  const shell = flip ? scan.down : scan.up;
  const shellMax = shellLimit(s);
  if (solid > 55) {
    out.push({ param: s.fitter === 'ring' ? 'fitterT' : 'collarWall',
      severity: solid > 75 ? 'error' : 'warn',
      message: `printed ${flip ? 'fitter down' : 'fitter up'} there is a solid face leaning ${solid.toFixed(0)}° from vertical at z = ${(flip ? scan.downSolidAt : scan.upSolidAt).toFixed(0)} mm — a ceiling with nothing under it${auto ? ', and that is already the better way up' : '; auto orientation would pick the other way'}. Nothing can be supported inside a shade you intend to look at` });
  }
  const shellOk = shellComfort(s);
  if (shell > shellOk) {
    const at = flip ? scan.downAt : scan.upAt;
    const onShoulder = s.fitter !== 'none' && g.rise > 0.5 && at >= g.zTop - 0.01;
    const step = s.layerH * Math.tan(shell * DEG);
    out.push({ param: onShoulder ? 'shoulder' : 'profile',
      severity: shell > shellMax ? 'error' : 'warn',
      message: `printed ${flip ? 'fitter down' : 'fitter up'} the ${onShoulder ? 'shoulder' : 'wall'} leans ${shell.toFixed(0)}° from vertical at z = ${at.toFixed(0)} mm, so every ${s.layerH} mm layer steps ${step.toFixed(2)} mm sideways on a ${s.wall.toFixed(1)} mm wall. ${shell > shellMax
        ? `That is more than the whole wall — the new material lands on nothing. Stay under ${shellMax.toFixed(0)}°`
        : `Past half a wall the surface starts to droop; ${shellOk.toFixed(0)}° is where it stays clean`}` });
  }

  // 4. Spiral mode cannot carry a fitter.
  if (s.spiral && s.fitter !== 'none') {
    out.push({ param: 'mode', severity: 'error',
      message: 'spiral vase mode prints one continuous single-wall loop per layer, and a flange with a bore through it puts two contours on the same layer. Orca resolves that silently and exits 0. Print the shell with the fitter set to none and add a separate fitter, or switch to a walled shade' });
  }
  if (s.spiral && s.staves > 1) {
    out.push({ param: 'staves', severity: 'error',
      message: `a ${s.ew.toFixed(2)} mm single wall has no thickness to scarf — the lap needs ${(2 * T_MIN + s.gap + 0.05).toFixed(1)} mm of wall. The staves have been butted instead, which glues badly and shows as a line when lit` });
  }

  // 5. The lamp.
  const lc = lampClearance(s, g);
  if (lc.hit < 1) {
    out.push({ param: 'lamp', severity: 'error',
      message: `a ${lc.lamp.label} does not go in: ${lc.hit < 0 ? `${(-lc.hit).toFixed(1)} mm of it is inside the wall` : `${lc.hit.toFixed(1)} mm of air`} at the tightest point. Widen the shade, raise the top opening, or pick a smaller envelope` });
  } else if (lc.clear < 15) {
    out.push({ param: 'lamp', severity: 'warn',
      message: `only ${lc.clear.toFixed(0)} mm between the glass of a ${lc.lamp.label} and the wall at z = ${lc.at.toFixed(0)} mm. PLA goes soft at ${PLA_TG} °C and a working LED gets its base there — print this one in PETG, and never put a halogen or an incandescent inside it whatever the shade is made of` });
  }

  // 6. The bed.
  const across = 2 * g.maxR;
  if (s.staves === 1 && (across > s.bed.x || s.height > s.bed.z)) {
    const k = minStaves(s);
    const bowed = across > s.dia + 0.5 ? ` (the ${s.bulge.toFixed(0)} mm bow puts the widest ring at ${across.toFixed(0)} mm, not the ${s.dia.toFixed(0)} mm you typed)` : '';
    out.push({ param: across > s.bed.x ? 'staves' : 'height', severity: 'error',
      message: `${across.toFixed(0)} mm across and ${s.height.toFixed(0)} mm tall does not fit a ${s.bed.x} × ${s.bed.y} × ${s.bed.z} mm bed in one piece${bowed}. ${across > s.bed.x ? (k ? `Set Staves to ${k} and it prints as ${k} pieces plus the fitter ring` : 'It will not fit even split; reduce the diameter') : ''}${s.height > s.bed.z ? `The height alone is ${(s.height - s.bed.z).toFixed(0)} mm over, and splitting the wall does not help with that` : ''}`.trim() });
  }
  if (s.staves > 1) {
    const loads = splitPlateCount(s);
    if (loads === 0) {
      const k = minStaves(s);
      const half = Math.PI / s.staves + Math.min(s.lap, TAU / s.staves * 0.6) / 2;
      const chord = 2 * g.maxR * Math.sin(Math.min(Math.PI / 2, half));
      out.push({ param: 'staves', severity: 'error',
        message: `${s.staves} staves of a ${(2 * g.maxR).toFixed(0)} mm shade are ${chord.toFixed(0)} mm across the chord and still will not lie on a ${s.bed.x} mm bed. ${k && k > s.staves ? `Use at least ${k}` : 'Reduce the diameter or the scarf'}` });
    } else if (loads > 1) {
      // Worth saying why, because the instinct is to add staves and it does not
      // help: a stave stands upright and its footprint is the whole cone wedge,
      // so the radial run from the mouth to the top opening is what fills the
      // bed, not the chord. More staves make each one narrower and leave the
      // run exactly where it was.
      const run = g.maxR - s.topDia / 2;
      out.push({ param: 'staves', severity: 'info',
        message: `${s.staves + 1} parts is ${loads} plate-loads on a ${s.bed.x} × ${s.bed.y} mm bed. Each stave stands on its mouth and its footprint is the ${run.toFixed(0)} mm of radial run between the two diameters, so adding staves narrows them without saving plates — bringing the two diameters closer together does` });
    }
  }
  if (s.staves > 1 && s.topDia > s.bed.x - 8) {
    out.push({ param: 'topDia', severity: 'error',
      message: `the fitter ring is a whole ${s.topDia.toFixed(0)} mm circle and will not fit a ${s.bed.x} mm bed. Bring the top opening under ${(s.bed.x - 8).toFixed(0)} mm — a narrow top is what a coolie shade looks like anyway` });
  }

  // 7. The wall, and what it does to the light.
  if (!s.spiral) {
    const perims = s.wall / s.ew;
    if (perims < 1.6) {
      out.push({ param: 'wall', severity: 'warn',
        message: `a ${s.wall.toFixed(1)} mm wall is ${perims.toFixed(1)} extrusions at ${s.ew.toFixed(2)} mm; the slicer will fill it with gap-fill zigzag rather than clean perimeters. Use ${(2 * s.ew).toFixed(1)} mm, or go to spiral mode where one wall is the point` });
    }
    if (s.wall > 2.4) {
      out.push({ param: 'wall', severity: 'info',
        message: `${s.wall.toFixed(1)} mm of PLA passes very little light. Under about 1.6 mm a shade glows; over about 2.5 mm it is an opaque cone with a bright rim` });
    }
  }
  if (s.staves > 1 && !s.spiral) {
    const whMid = g.hWall(g.zTop / 2);
    if (whMid - s.gap - 2 * T_MIN <= 0.05) {
      out.push({ param: 'wall', severity: 'error',
        message: `a scarf needs ${(2 * T_MIN + s.gap).toFixed(1)} mm of wall to taper across and there is ${whMid.toFixed(2)} mm. Thicken the wall to at least ${(2 * T_MIN + s.gap + 0.4).toFixed(1)} mm or the staves butt together` });
    }
  }
  if (s.staves > 1 && s.lap * (180 / Math.PI) >= (360 / s.staves) * 0.6) {
    out.push({ param: 'lap', severity: 'info',
      message: `a ${(s.lap * RAD).toFixed(0)}° lap is most of a ${(360 / s.staves).toFixed(0)}° stave; it has been trimmed to ${((360 / s.staves) * 0.6).toFixed(0)}° so a stave cannot reach the one two along` });
  }

  // 8. Footprint, for a shade that has to stand up on the bed while it prints.
  if (s.staves === 1 && !((s.dia / Math.max(1, s.height)) > 0.45)) {
    out.push({ param: 'height', severity: 'info',
      message: `${s.height.toFixed(0)} mm tall on a ${s.dia.toFixed(0)} mm mouth is ${(s.height / s.dia).toFixed(1)}:1. Print it with a brim; a shade is light and the toolhead is not gentle` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// hints — what to type into the slicer, and which filament to reach for.
// ---------------------------------------------------------------------------

function estimate(s, g) {
  // A ring sweep rather than a mesh: volume without paying for the triangles.
  const n = 64, nz = 160;
  const u = sectionFn(s);
  let vol = 0, prev = null, prevZ = 0;
  for (let j = 0; j <= nz; j++) {
    const z = g.zTop * j / nz;
    let a = 0;
    const half = Math.sin(TAU / n) / 2;
    for (let k = 0; k < n; k++) {
      const a0 = TAU * k / n, a1 = TAU * (k + 1) / n;
      const ro0 = rWallOuter(s, g, z, a0, u), ro1 = rWallOuter(s, g, z, a1, u);
      const wh = g.hWall(z);
      a += half * (ro0 * ro1 - Math.max(0, ro0 - wh) * Math.max(0, ro1 - wh));
    }
    if (prev !== null) vol += (a + prev) / 2 * (z - prevZ);
    prev = a; prevZ = z;
  }
  // The hub, as a plain annulus plus a collar.
  if (s.fitter !== 'none') {
    vol += Math.PI * (Math.pow(s.rHub, 2) - Math.pow(s.rBore, 2)) * s.fitterT;
    if (s.fitter !== 'ring') vol += Math.PI * (Math.pow(s.rBore + s.collarWall, 2) - Math.pow(s.rBore, 2)) * s.collarH;
    if (g.rise > 0) vol += TAU * ((s.topDia / 2 + s.rHub) / 2) * Math.hypot(s.topDia / 2 - s.rHub, g.rise) * s.wall;
  }
  return vol;
}

function hints(p, ctx = {}) {
  const s = settings(p, ctx);
  const g = geometry(s);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const { flip, scan, auto } = chooseOrient(s, g);
  const vol = estimate(s, g);
  const grams = vol / 1000 * 1.24;
  const lc = lampClearance(s, g);
  const notes = [];

  const solidHere = flip ? scan.downSolid : scan.upSolid;
  const solidOther = flip ? scan.upSolid : scan.downSolid;
  notes.push(`Print it ${flip ? 'fitter down, flange flat on the bed' : 'fitter up, mouth on the bed'}${auto ? '' : ' (you chose that)'}. ${solidOther > solidHere + 0.5
    ? `The other way up puts a solid ${solidOther.toFixed(0)}° ceiling under the fitting with nothing to hold it.`
    : `Both ways up lean about the same, so this is the one with the bigger first layer.`} The wall leans ${(flip ? scan.down : scan.up).toFixed(0)}° from vertical and a ${s.wall.toFixed(1)} mm shell at ${layerH} mm layers holds ${shellLimit(s).toFixed(0)}°. Nothing inside a lampshade can be supported: you would be picking support out of the surface you made it for.`);

  if (s.spiral) {
    notes.push(`Spiral vase mode ON. Walls 1, top layers 0, infill 0%, bottom layers ${Math.max(3, Math.ceil(1.2 / layerH))}. The model's wall is one extrusion (${s.ew.toFixed(2)} mm) because in vase mode the printer sets the wall, not the model — do not scale in X/Y alone, that scales the wall too.`);
    notes.push('Orca resolves a contradiction between spiral mode and the shell settings silently and exits 0, so open the sliced file and look rather than trusting the exit code.');
  } else {
    const perims = Math.max(1, Math.round(s.wall / s.ew));
    notes.push(`${perims} perimeter${perims === 1 ? '' : 's'} at ${s.ew.toFixed(2)} mm gives the ${s.wall.toFixed(1)} mm wall. Infill 0% — there is nothing inside to fill. ${flip ? `Bottom layers ${Math.max(4, Math.ceil(s.fitterT / layerH))} to build the flange solid` : 'Top layers 0; the mouth is meant to be open'}.`);
    notes.push(`Light: under about 1.6 mm PLA glows and the object reads as a lamp; over about 2.5 mm it is an opaque cone with a bright rim. You are at ${s.wall.toFixed(1)} mm.`);
  }

  notes.push(`Filament: ${lc.clear < 15
    ? `PETG. There is only ${lc.clear.toFixed(0)} mm between the wall and a ${lc.lamp.label}, and PLA's glass transition is ${PLA_TG} °C — the base of a hard-working E27 LED reaches that and the shade sags into the lamp.`
    : `PLA is fine here. PLA's glass transition is ${PLA_TG} °C and there are ${lc.clear.toFixed(0)} mm between the wall and a ${lc.lamp.label}, which is enough air for an LED of 9 W or less. PETG (about 80 °C) if you want the margin.`} Never an incandescent, a halogen or a real carbon-filament lamp in a printed shade, whatever the wattage says.`);

  if (s.fitter === 'ring') {
    notes.push(`Fitting: drop the ${s.bore.toFixed(1)} mm bore over the holder's Ø 40 mm thread and screw the shade ring down on top. The ${s.flange.toFixed(0)} mm flange gives a 54 mm ring ${((54 - s.bore) / 2).toFixed(1)} mm of grip all the way round. Measure your own holder first: the 40 is the published European figure, not a measurement of yours.`);
  } else if (s.fitter === 'thread') {
    notes.push(`Fitting: it screws straight onto the holder's shade-ring thread, ${(s.collarH / s.pitch).toFixed(1)} turns at ${s.pitch} mm. Printed threads always carry a burr on the first crest — a wipe with a file at the lead-in is normal, not a failure.`);
  } else if (s.fitter === 'collar') {
    notes.push(`Fitting: the ${s.collarH.toFixed(0)} mm collar is a push fit on a ${s.bore.toFixed(1)} mm holder body. If it rattles, drop the bore 0.4 mm and reprint the fitter alone; that is a 20 minute print, not a 6 hour one.`);
  } else {
    notes.push('No fitter: this is a bare shell. Glue or screw a spider into the top opening, or print the shell in spiral mode and make the fitter as a separate part.');
  }

  if (s.staves > 1) {
    notes.push(`${s.staves} staves plus one fitter ring. The vertical joints are scarfed: each edge feathers to ${T_MIN} mm and overlaps its neighbour, so glued up the joint is one wall thick and the seam does not read as a bright or a dark line. Cyanoacrylate or a solvent weld, clamped with masking tape, working round in one direction.`);
    notes.push('Print the staves with a brim. Each one stands on a thin arc and the toolhead will knock a bare one off around layer 200.');
    const plateLoads = splitPlateCount(s);
    if (plateLoads > 1) {
      notes.push(`${s.staves + 1} parts will not go on one ${s.bed.x} × ${s.bed.y} mm bed: that is ${plateLoads} plate-loads. The preview shows them as ${plateLoads} separate beds side by side, not as one impossible plate.`);
    }
    notes.push(`Hide the seams in the pattern if you can: ${s.section === 'circle' ? 'a plain circle has nowhere to hide a joint — a fluted or faceted section puts every seam in a valley' : 'set the stave count to a divisor of the section count and every seam lands in a valley'}.`);
  }

  if (lc.pokes) {
    notes.push(`A ${lc.lamp.label} is ${lc.lamp.len} mm from the cap and the shade is ${(s.fitter === 'none' ? s.height : g.zF).toFixed(0)} mm deep, so the lamp hangs ${(lc.lamp.len - (s.fitter === 'none' ? s.height : g.zF)).toFixed(0)} mm out of the bottom. That is a look, not a fault — it is the whole point of a filament lamp — but check what it puts at eye level.`);
  }

  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: lc.clear < 15 ? 'PETG' : 'PLA',
    supports: false,
    spiral: s.spiral,
    orient: flip ? 'fitter down' : 'fitter up',
    estGrams: Math.round(grams * 10) / 10,
    parts: s.staves > 1 ? s.staves + 1 : 1,
    plates: splitPlateCount(s),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default {
  id: 'lampshade',
  name: 'Pendant lampshade',
  category: 'Lighting',
  blurb: 'A shade that fits a real E27 holder. Bore, flange and thread from the published figures.',
  description:
    'Lampshades are easy to draw and hard to buy, because every maker invents a fitting and none of them is the one on your ceiling. ' +
    'This starts at the E27 lampholder — Ø 40 mm shade-ring thread, 2.5 mm lead, a 54 mm ring to clamp against — and hangs a shade off it: ' +
    'a clamped flange, a push-on collar, a screw-on thread, or nothing at all if you would rather glue in a spider. ' +
    'The shade itself is a profile crossed with a cross-section, open at both ends, with the wall thickness chosen for how much light you want through it. ' +
    'Anything wider than the bed splits into scarfed staves that glue up without the joint showing when the lamp is on.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3"/><path d="M9 5h6l4 9H5z"/><path d="M12 14v4"/><circle cx="12" cy="20" r="2"/></svg>',
  version: 1,

  params: [
    // ---- Form ----
    { key: 'dia', label: 'Bottom diameter', type: 'number', unit: 'mm', min: 60, max: 400, step: 5, def: 170, group: 'Form',
      help: 'Across the mouth, the widest part. An A1 mini tops out near 175 mm in one piece; past that set Staves and it prints in sections.' },
    { key: 'topDia', label: 'Top opening', type: 'number', unit: 'mm', min: 30, max: 400, step: 5, def: 90, group: 'Form',
      help: 'The hole the lampholder comes through. It is opened automatically if it cannot clear the fitter with a wall on it.' },
    { key: 'height', label: 'Height', type: 'number', unit: 'mm', min: 40, max: 280, step: 5, def: 150, group: 'Form',
      help: 'Overall, shoulder included. This is the number that decides whether it prints in one piece: the bed is 180 mm tall and splitting does not help with height.' },
    { key: 'profile', label: 'Profile', type: 'enum', def: 'straight', group: 'Form',
      help: 'The route the wall takes between the two diameters.',
      options: [
        { v: 'straight', label: 'Empire (straight)', help: 'A plain cone frustum. Equal top and bottom makes it a drum.' },
        { v: 'bell', label: 'Bell', help: 'Holds the top diameter most of the way down, then sweeps out into a skirt.' },
        { v: 'ogee', label: 'Ogee', help: 'The classic S: convex low, concave high.' },
        { v: 'dome', label: 'Dome', help: 'Stays wide low down and turns over near the top. A bowl, upside down.' },
        { v: 'flare', label: 'Coolie', help: 'Narrows hard off the mouth and then runs almost straight. Wide and shallow.' },
      ] },
    { key: 'bulge', label: 'Bow', type: 'number', unit: 'mm', min: -30, max: 30, step: 1, def: 0, group: 'Form',
      help: 'Bows the wall out (positive) or pinches it in (negative) at mid-height. Zero at both ends, so the two diameters stay exactly what you typed.' },
    { key: 'hem', label: 'Hem', type: 'number', unit: 'mm', min: 0, max: 8, step: 0.5, def: 0, group: 'Form',
      help: 'A 45° outward flare at the mouth. It stiffens a thin rim, finishes the edge, and gives a stave something to stand on while it prints.' },

    // ---- Cross-section ----
    { key: 'section', label: 'Cross-section', type: 'enum', def: 'circle', group: 'Cross-section',
      help: 'The shape of every horizontal slice. All of them are single-valued in angle, so all of them can be spiralised.',
      options: [
        { v: 'circle', label: 'Circle', help: 'Plain and round. The most light, the fewest triangles, and nowhere to hide a stave seam.' },
        { v: 'lobed', label: 'Lobed', help: 'A smooth cosine swell. Gentle, and it hides layer lines better than a circle.' },
        { v: 'fluted', label: 'Fluted', help: 'Shallow vertical dishes between sharp arrises, like a column. Every flute valley will hide a stave seam.' },
        { v: 'polygon', label: 'Polygon', help: 'Flat panels with a hard arris. Add a twist and it becomes a twisted prism.' },
        { v: 'star', label: 'Star', help: 'Straight-sided points. Throws the most dramatic pattern on a ceiling.' },
        { v: 'squircle', label: 'Squircle', help: 'Between a circle and a square. The exponent decides how square.' },
      ] },
    { key: 'sides', label: 'Count', type: 'int', min: 3, max: 32, step: 1, def: 12, group: 'Cross-section',
      showIf: (p) => ['lobed', 'fluted', 'polygon', 'star'].includes(p.section),
      help: 'Lobes, flutes, sides or points. Make it a multiple of the stave count and every seam lands in a valley.' },
    { key: 'depth', label: 'Relief', type: 'number', unit: '%', min: 0, max: 90, step: 1, def: 22, group: 'Cross-section',
      showIf: (p) => ['lobed', 'fluted', 'star'].includes(p.section),
      help: 'How far the valleys cut in, as a percentage of the radius. Deep valleys are also where the shade is thinnest to the lamp.' },
    { key: 'squareness', label: 'Squareness', type: 'number', min: 2, max: 10, step: 0.5, def: 4, group: 'Cross-section',
      showIf: (p) => p.section === 'squircle',
      help: '2 is a circle, 4 is the classic squircle, 10 is nearly a square with soft corners.' },
    { key: 'twist', label: 'Twist', type: 'number', unit: '°', min: -720, max: 720, step: 15, def: 0, group: 'Cross-section',
      help: 'Total rotation from mouth to top opening. Invisible on a circle, and lovely on flutes.' },
    { key: 'ribs', label: 'Rings', type: 'int', min: 0, max: 40, step: 1, def: 0, group: 'Cross-section',
      help: 'Horizontal grooves up the wall. They band the light, and they fade to nothing at both ends so the diameters stay exact.' },
    { key: 'ribDepth', label: 'Ring depth', type: 'number', unit: 'mm', min: 0, max: 5, step: 0.1, def: 1.2, group: 'Cross-section',
      showIf: (p) => p.ribs > 0, help: 'How deep each groove cuts. On a thin glowing wall a deep groove is a bright line.' },

    // ---- Fitter ----
    { key: 'fitter', label: 'Fitting', type: 'enum', def: 'ring', group: 'Fitting',
      help: 'How the shade meets the lampholder. If you do not know which yours is, print the ring version and try it: it is the European standard.',
      options: [
        { v: 'ring', label: 'Shade ring (clamped)', help: 'A flat flange with a hole. Drops over the holder and the holder\'s own shade ring screws down on top. The usual European E27 fitting.' },
        { v: 'collar', label: 'Push-on collar', help: 'A plain bore that grips the holder body. No extra parts, but it needs the bore measured.' },
        { v: 'thread', label: 'Screw-on thread', help: 'An internal thread that screws onto the holder\'s own Ø 40 mm shade-ring thread. For the holder whose ring has gone missing.' },
        { v: 'none', label: 'None (bare shell)', help: 'Just the shade. Glue a spider in, or print the shell in spiral mode and make the fitter separately.' },
      ] },
    { key: 'bore', label: 'Bore', type: 'number', unit: 'mm', min: 16, max: 90, step: 0.5, def: 41, group: 'Fitting',
      showIf: (p) => p.fitter !== 'none',
      help: 'The hole diameter. 41 mm is the published Ø 40 mm European E27 shade-ring thread plus a millimetre of slip — it has not been measured on your holder, so measure yours before you commit six hours of filament.' },
    { key: 'flange', label: 'Flange width', type: 'number', unit: 'mm', min: 3, max: 40, step: 0.5, def: 9, group: 'Fitting',
      showIf: (p) => p.fitter === 'ring',
      help: 'The flat annulus outside the bore. A thermoplastic E27 shade ring is 54 mm across and a thermoset one 58 mm, so 9 mm leaves the 54 mm ring 7 mm of grip.' },
    { key: 'fitterT', label: 'Flange thickness', type: 'number', unit: 'mm', min: 1, max: 8, step: 0.2, def: 2.4, group: 'Fitting',
      showIf: (p) => p.fitter !== 'none',
      help: 'A real shade ring has 14 mm of thread to play with, so anything up to about 6 mm still does up. Thin flanges crack when the ring is tightened.' },
    { key: 'collarH', label: 'Collar length', type: 'number', unit: 'mm', min: 4, max: 40, step: 1, def: 12, group: 'Fitting',
      showIf: (p) => p.fitter === 'collar' || p.fitter === 'thread',
      help: 'How far the collar grips down the holder. 14 mm is the height of a real shade ring thread; more than that and you are past it.' },
    { key: 'collarWall', label: 'Collar wall', type: 'number', unit: 'mm', min: 1, max: 8, step: 0.2, def: 2.4, group: 'Fitting',
      showIf: (p) => p.fitter === 'collar' || p.fitter === 'thread',
      help: 'A threaded collar wants at least 2 mm outside the thread root or it splits on the first turn.' },
    { key: 'pitch', label: 'Thread pitch', type: 'number', unit: 'mm', min: 1, max: 5, step: 0.5, def: 2.5, group: 'Fitting',
      showIf: (p) => p.fitter === 'thread',
      help: 'The published European E27 shade-ring lead is 2.5 mm. Change it only if you have measured your own holder, because a thread with the wrong pitch binds on the first turn and looks like a printing fault.' },
    { key: 'shoulder', label: 'Shoulder angle', type: 'number', unit: '°', min: 15, max: 82, step: 1, def: 50, group: 'Fitting',
      help: 'How steeply the shade closes in from the top opening to the fitter, measured from vertical. Steeper is easier to print and takes more height; flatter blocks more of the light going up.' },

    // ---- Wall and lamp ----
    { key: 'mode', label: 'Wall mode', type: 'enum', def: 'walled', group: 'Wall & lamp',
      help: 'How thick the wall is in the model.',
      options: [
        { v: 'walled', label: 'Walled', help: 'A real wall thickness. Works with every fitting and every split, and you choose how much light gets through.' },
        { v: 'spiral', label: 'Spiral (single wall)', help: 'One extrusion, set by the nozzle: the brightest glow and the fastest print. Needs the fitting set to none, because vase mode cannot carry a flange.' },
      ] },
    { key: 'wall', label: 'Wall thickness', type: 'number', unit: 'mm', min: 0.6, max: 5, step: 0.1, def: 1.2, group: 'Wall & lamp',
      showIf: (p) => p.mode !== 'spiral',
      help: 'Measured perpendicular to the surface. Under about 1.6 mm a PLA shade glows; over about 2.5 mm it is opaque with a bright rim.' },
    { key: 'lamp', label: 'Lamp', type: 'enum', def: 'a60', group: 'Wall & lamp',
      help: 'Which lamp is going inside. It is not decoration: it sets the clearance check and the filament advice.',
      options: Object.keys(LAMPS).map(k => ({ v: k, label: LAMPS[k].label,
        help: `${LAMPS[k].dia} mm across, ${LAMPS[k].len} mm from the cap shoulder.` })) },

    // ---- Assembly ----
    { key: 'staves', label: 'Staves', type: 'int', min: 1, max: 16, step: 1, def: 1, group: 'Assembly',
      help: '1 prints the whole shade in one piece. More splits the wall into that many vertical sections plus one fitter ring, for a shade wider than the bed.' },
    { key: 'lap', label: 'Scarf', type: 'number', unit: '°', min: 1, max: 20, step: 1, def: 8, group: 'Assembly',
      showIf: (p) => p.staves > 1,
      help: 'How far each stave overlaps its neighbour. The two edges taper so the glued joint is one wall thick, which is why it does not show as a line when the lamp is on.' },
    { key: 'gap', label: 'Glue gap', type: 'number', unit: 'mm', min: 0.05, max: 0.6, step: 0.05, def: 0.15, group: 'Assembly',
      showIf: (p) => p.staves > 1,
      help: 'Clearance between the two faces of a scarf. 0.15 mm is a film of cyanoacrylate; more if you are using a thicker glue.' },
    { key: 'arrange', label: 'Show', type: 'enum', def: 'plate', group: 'Assembly',
      showIf: (p) => p.staves > 1,
      help: 'Which arrangement to look at.',
      options: [
        { v: 'plate', label: 'On the plate', help: 'The parts packed as they have to print. This is what goes to the slicer.' },
        { v: 'assembled', label: 'Assembled', help: 'The shade as it will hang, so you can see what you are making. Not printable as shown.' },
      ] },
    { key: 'orient', label: 'Print it', type: 'enum', def: 'auto', group: 'Assembly',
      help: 'Which way up. Auto measures the worst overhang both ways and takes the better one.',
      options: [
        { v: 'auto', label: 'Whichever way is better', help: 'Measured, not guessed: the steepest downward face decides.' },
        { v: 'down', label: 'Fitter down', help: 'Flange flat on the bed. Almost always right when there is a fitting.' },
        { v: 'up', label: 'Mouth down', help: 'The mouth on the bed. Right for a bare shell that narrows upward.' },
      ] },
  ],

  // Every preset prints in one piece on a 180 mm bed, because a preset that
  // needs two plate-loads and a bottle of glue is a project rather than a
  // starting point. Split mode is one number away: raise Staves and the
  // validator tells you the fewest that will fit.
  presets: [
    { name: 'Kitchen pendant, over the island',
      values: { dia: 170, topDia: 90, height: 130, profile: 'straight', bulge: 0, hem: 2,
        section: 'circle', twist: 0, ribs: 0, fitter: 'ring', bore: 41, flange: 9, fitterT: 2.4,
        shoulder: 50, mode: 'walled', wall: 1.2, lamp: 'a60', staves: 1, orient: 'auto' } },
    { name: 'Fluted coolie, wide and low',
      values: { dia: 172, topDia: 88, height: 105, profile: 'tulip', bulge: 0, hem: 1.5,
        section: 'fluted', sides: 24, depth: 16, twist: 0, ribs: 0, fitter: 'ring', bore: 41,
        flange: 9, fitterT: 2.4, shoulder: 55, mode: 'walled', wall: 1.2, lamp: 'a60', staves: 1 } },
    { name: 'Hallway drum, straight sides',
      values: { dia: 175, topDia: 175, height: 110, profile: 'straight', bulge: 0, hem: 0,
        section: 'circle', twist: 0, ribs: 0, fitter: 'ring', bore: 41, flange: 9, fitterT: 2.6,
        shoulder: 50, mode: 'walled', wall: 1.2, lamp: 'a60', staves: 1 } },
    { name: 'Faceted bedside, screws straight on',
      values: { dia: 130, topDia: 72, height: 110, profile: 'straight', bulge: 0, hem: 0,
        section: 'polygon', sides: 8, twist: 0, ribs: 0, fitter: 'thread', bore: 41, pitch: 2.5,
        collarH: 12, collarWall: 2.4, fitterT: 2.4, shoulder: 45, mode: 'walled', wall: 1.4,
        lamp: 'g45', staves: 1 } },
    { name: 'Ribbed dome, for a fat globe lamp',
      values: { dia: 160, topDia: 86, height: 150, profile: 'dome', bulge: 6, hem: 0,
        section: 'circle', twist: 0, ribs: 14, ribDepth: 1.4, fitter: 'ring', bore: 41, flange: 9,
        fitterT: 2.4, shoulder: 55, mode: 'walled', wall: 1.3, lamp: 'g80', staves: 1 } },
    { name: 'Spiral shell, bring your own fitting',
      values: { dia: 160, topDia: 78, height: 165, profile: 'bell', bulge: 0, hem: 0,
        section: 'lobed', sides: 16, depth: 22, twist: 180, ribs: 0, fitter: 'none',
        mode: 'spiral', lamp: 'g45', staves: 1, orient: 'auto' } },
  ],

  build,
  validate,
  hints,
};

export {
  build, validate, hints, settings, geometry, sectionFn, sectionMin, profileF,
  leanScan, shellLimit, shellComfort, footRadius, chooseOrient, lampClearance, minStaves, splitPlateCount, innerAt,
  lampRadiusAt, LAMPS, R_MIN, T_MIN, PLA_TG,
};
