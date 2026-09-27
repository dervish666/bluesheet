// js/gen/boxlid.js — boxes with lids that actually close.
//
// A box is the thing a printer is asked for most often, and the lid is the part
// most often shipped broken. Everything here is built around the two numbers
// that decide whether it works: the CLEARANCE between the lid and the box, and
// the WALL as a whole number of extrusions. Get those wrong and no amount of
// pretty geometry saves the print.
//
// CONSTRUCTION. The body is built directly, not with CSG: every horizontal
// section is a ring produced by one analytic generator (`cornerRing`) with a
// FIXED vertex count, so a section and the section above it always have
// matching vertices and a wall strip between them is watertight by
// construction. That is what lets the internal floor fillet, the divider grid
// and the stacking foot all coexist without a single boolean. CSG is used only
// for the features that genuinely cross a wall — the finger notch, the side
// vents, the label recess, the mounting points and the hinge — where a
// section-based construction would leave T-junctions.
//
// ORIENTATION. Everything comes back in PRINT orientation, not assembled
// orientation: the friction lid is upside down (flat top face on the plate, lip
// pointing up), the screw cap likewise, and the hinged clamshell is flat open.
// That is the orientation these parts have to be sliced in, and quietly
// returning an assembled preview that has to be re-oriented before printing is
// how a box ends up with supports inside it. `arrange: 'assembled'` shows the
// closed object instead, for looking at rather than for slicing.
//
// THE HINGE. The one piece of geometry here that has to be *proved* rather than
// eyeballed, because it moves. The design is a clamshell of two equal halves
// with the axis on the box's back-top-outer corner, offset half a clearance
// into the gap between the two parts. Written in coordinates centred on that
// axis (u = y - axisY, v = z - axisZ):
//
//   box  body  lies in { u <= -g, v <= 0 }      g = hinge clearance / 2
//   lid  body  lies in { u <= -g, v >= 0 }      (closed)
//
// Rotating the lid by -phi maps its two half-plane constraints to
// { u cos phi - v sin phi <= -g } and { u sin phi + v cos phi >= 0 }, and for
// every phi in (0, 180] at least one of those contradicts the box's two. The
// halves therefore cannot touch anywhere in the range of motion except at
// phi = 0, which is the closed position where the rims are supposed to meet.
// Near the axis the argument is different: within the knuckle radius each part
// exists only in its own interleaved X slots, and each part is relieved to
// radius (knuckle + clearance) at the other's slots, so the two never share a
// point there either. Both halves of that argument are asserted in the test
// suite, and then checked again the brute-force way with a triangle/triangle
// intersection sweep at 0, 45, 90 and 180 degrees.

import { Mesh } from '../kernel/mesh.js';
import {
  circle, triangulate, signedArea, TAU,
} from '../kernel/poly2d.js';
import { extrude, cylinder } from '../kernel/builders.js';
import { union, subtractAll, unionAll } from '../kernel/csg.js';
import { pack, layout as packLayout, anyOverlap, withinBed, A1_MINI_BED } from '../kernel/pack.js';
import { clamp, num } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

const EXTRUSION = 0.4;          // the nozzle this machine has
const MIN_CLEAR = 0.35;         // below this, two printed faces fuse
const BED = A1_MINI_BED;

// ---------------------------------------------------------------------------
// Rings.
//
// One generator for every horizontal section in the whole module. The vertex
// count is 4*(segs+1) whatever the corner radii are — a zero radius emits
// coincident points rather than fewer points — because the strips between
// sections pair vertex i to vertex i, and a section that quietly returned a
// different number of points would tear the wall open. The coincident points
// collapse in `weld`, which drops the zero-area triangles they produce, so the
// cost is a handful of wasted vertices and never a hole.
// ---------------------------------------------------------------------------

/** Segments per corner arc for a radius `r`, scaled by the quality factor. */
function cornerSegs(r, sf = 1) {
  if (r < 0.05) return 1;
  return Math.max(2, Math.min(32, Math.ceil(3 * Math.sqrt(r) * sf)));
}

/**
 * Rounded / chamfered / square rectangle, CCW, centred on (cx, cy).
 * `radii` is one number or [BR, TR, TL, BL]. Radii are scaled down together if
 * two adjacent corners would eat more than the edge between them.
 */
function cornerRing(w, d, radii, style, segs, cx = 0, cy = 0) {
  const rs = (Array.isArray(radii) ? radii.slice(0, 4) : [radii, radii, radii, radii])
    .map(r => Math.max(0, Math.min(r || 0, w / 2, d / 2)));
  // adjacent pairs: [BR,TR] share the right edge (d), [TR,TL] the top (w),
  // [TL,BL] the left (d), [BL,BR] the bottom (w).
  let k = 1;
  for (const [a, b, span] of [[0, 1, d], [1, 2, w], [2, 3, d], [3, 0, w]]) {
    const sum = rs[a] + rs[b];
    if (sum > span) k = Math.min(k, span / sum);
  }
  if (k < 1) for (let i = 0; i < 4; i++) rs[i] *= k;

  const hw = w / 2, hd = d / 2;
  const centres = [
    [hw - rs[0], -hd + rs[0], -Math.PI / 2],
    [hw - rs[1], hd - rs[1], 0],
    [-hw + rs[2], hd - rs[2], Math.PI / 2],
    [-hw + rs[3], -hd + rs[3], Math.PI],
  ];
  const out = [];
  for (let c = 0; c < 4; c++) {
    const [px, py, a0] = centres[c], r = rs[c];
    if (style === 'chamfer' && r > 0) {
      // The chamfer is the chord of the same arc: a 45° cut with leg r.
      const x0 = px + r * Math.cos(a0), y0 = py + r * Math.sin(a0);
      const x1 = px + r * Math.cos(a0 + Math.PI / 2), y1 = py + r * Math.sin(a0 + Math.PI / 2);
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        out.push([cx + x0 + (x1 - x0) * t, cy + y0 + (y1 - y0) * t]);
      }
    } else {
      for (let i = 0; i <= segs; i++) {
        const a = a0 + (Math.PI / 2) * (i / segs);
        out.push([cx + px + r * Math.cos(a), cy + py + r * Math.sin(a)]);
      }
    }
  }
  return out;
}

/** A circle as a ring, CCW. */
function circleRing(r, segs, cx = 0, cy = 0) {
  return circle(Math.max(r, 1e-3), { segs: Math.max(8, Math.round(segs)), cx, cy });
}

/**
 * Teardrop bore: a circle with a 45° roof, for a hole whose axis is horizontal.
 * A round hole printed on its side sags at the top and closes onto whatever is
 * inside it; the roof gives the slicer two 45° walls instead of a ceiling. Used
 * for the hinge socket, where a sagging bore is the difference between a hinge
 * that turns and a hinge that is one solid lump.
 */
function teardropRing(r, segs) {
  const n = Math.max(12, Math.round(segs));
  const out = [];
  const a0 = Math.PI / 4, a1 = 3 * Math.PI / 4;
  // the circle from 135° round through the bottom to 45°
  const span = TAU - (a1 - a0);
  for (let i = 0; i <= n; i++) {
    const a = a1 + span * (i / n);
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  out.push([0, r * Math.SQRT2]);
  return out;
}

// ---------------------------------------------------------------------------
// Mesh assembly. Five primitives, and everything in the module is made of them.
// ---------------------------------------------------------------------------

function addRing(mesh, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = mesh.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

/**
 * Wall between two index rings of equal length. `outward` false makes the
 * normals face the ring's interior, which is what a cavity or a bore wants.
 */
function strip(mesh, lo, hi, outward = true) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (outward) mesh.addQuad(lo[i], lo[j], hi[j], hi[i]);
    else mesh.addQuad(lo[j], lo[i], hi[i], hi[j]);
  }
}

/**
 * The same wall, but with the quad diagonal forced to run the other way.
 *
 * It matters exactly once, and it matters a lot: the male thread and the female
 * thread are the same helical surface a clearance apart, but a helical quad is
 * not planar, so the two triangulations only stay parallel if their diagonals
 * agree. `strip`'s inward form runs its diagonal the opposite way to its
 * outward form, and turning the cap over to screw it on reverses it again — so
 * the bore and the neck ended up triangulated across each other and the meshes
 * grazed inside a clearance that was analytically exact.
 */
function stripSameDiag(mesh, lo, hi, outward = true) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (outward) { mesh.addTri(lo[i], lo[j], hi[j]); mesh.addTri(lo[i], hi[j], hi[i]); }
    else { mesh.addTri(lo[i], hi[j], lo[j]); mesh.addTri(lo[i], hi[i], hi[j]); }
  }
}

/**
 * Flat annulus between two index rings at the same z that share a vertex count
 * and an angular parameterisation. Cheaper and more robust than triangulating
 * a ring with a hole in it, and used wherever both rings come from the same
 * generator — the shoulder under a thread, the top of a cap.
 */
function annulus(mesh, outer, inner, up = true) {
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (up) mesh.addQuad(outer[i], outer[j], inner[j], inner[i]);
    else mesh.addQuad(outer[i], inner[i], inner[j], outer[j]);
  }
}

/** Drop consecutive duplicate points, carrying the index array with them. */
function dedupe(ring, idx) {
  const r = [], k = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = r.length ? r[r.length - 1] : null;
    if (q && Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9) continue;
    r.push(p); k.push(idx[i]);
  }
  while (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) { r.pop(); k.pop(); }
    else break;
  }
  return { ring: r, idx: k };
}

/**
 * Flat face from a set of rings (outer first, then holes) and the matching
 * index rings. `up` false flips it to face -Z. Coincident points are removed
 * first: the ear-clipper is entitled to give up on a ring that visits the same
 * coordinate twice, and a square-cornered section does exactly that.
 */
function cap(mesh, rings, idxs, up = true) {
  const R = [], I = [];
  for (let k = 0; k < rings.length; k++) {
    const d = dedupe(rings[k], idxs[k]);
    if (d.ring.length < 3) continue;
    R.push(d.ring); I.push(d.idx);
  }
  if (!R.length) return;
  const shape = [], flat = [];
  for (let k = 0; k < R.length; k++) {
    const wantCCW = k === 0;
    const isCCW = signedArea(R[k]) > 0;
    if (isCCW === wantCCW) { shape.push(R[k]); flat.push(...I[k]); }
    else { shape.push(R[k].slice().reverse()); flat.push(...I[k].slice().reverse()); }
  }
  const t = triangulate(shape);
  for (let i = 0; i < t.tris.length; i += 3) {
    const a = flat[t.tris[i]], b = flat[t.tris[i + 1]], c = flat[t.tris[i + 2]];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (a === b || b === c || a === c) continue;
    if (up) mesh.addTri(a, b, c); else mesh.addTri(a, c, b);
  }
}

/** Add a stack of rings (same vertex count) as a tube; returns the index rings. */
function stackRings(mesh, levels, outward) {
  const idx = levels.map(l => addRing(mesh, l.ring, l.z));
  for (let i = 1; i < idx.length; i++) strip(mesh, idx[i - 1], idx[i], outward);
  return idx;
}

/** Collapse levels that land on the same z, so a zero-height step never appears. */
function tidyLevels(levels) {
  const out = [];
  for (const l of levels) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.z - l.z) < 1e-6) { out[out.length - 1] = l; continue; }
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The thread.
//
// A screw thread is a surface r = f(z - pitch * theta / 2pi), single valued in
// r as long as the profile has no undercut — so it can be built as a plain ring
// stack rather than as a swept solid unioned onto a cylinder, and comes out
// watertight by construction with no boolean anywhere near it.
//
// The profile is trapezoidal with 45° flanks, which is the shape to use on a
// printer: every surface of it is either vertical or at 45°, so the female
// thread — printed with its bore opening upward — has no overhang steeper than
// the machine can bridge, and the crest is blunt enough to survive being
// screwed in and out by hand.
// ---------------------------------------------------------------------------

function threadProfile(s, a, c) {
  const t = s - Math.floor(s);
  if (t < a) return t / a;
  if (t < a + c) return 1;
  if (t < 2 * a + c) return 1 - (t - a - c) / a;
  return 0;
}

/** One horizontal section of a thread of `n` points, CCW. */
/**
 * Section heights for a threaded surface: an exact multiple of the step, so the
 * male and female surfaces put their rings at the SAME world heights once the
 * cap is screwed home. The two triangulated surfaces are then a constant radial
 * clearance apart everywhere instead of interfering wherever one mesh happened
 * to truncate a crest corner and the other did not.
 */
function threadLevels(len, pitch, sf) {
  let per = Math.max(8, Math.round(16 * Math.max(0.5, sf)));
  while (len / pitch * per > 400) per = Math.max(4, Math.floor(per / 2));
  const dz = pitch / per;
  const out = [];
  for (let k = 0; k * dz < len - 1e-9; k++) out.push(k * dz);
  out.push(len);
  return { levels: out, dz, per };
}

function threadRing(z, { rBase, depth, pitch, a, c, sign = 1, clip = null }) {
  const n = threadRing.n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const th = TAU * i / n;
    const s = (z - pitch * th / TAU) / pitch;
    let r = rBase + sign * depth * threadProfile(s, a, c);
    if (clip) r = clip(r, th, z);
    out[i] = [r * Math.cos(th), r * Math.sin(th)];
  }
  return out;
}
threadRing.n = 64;

// ---------------------------------------------------------------------------
// Parameter solving. Everything the builders need, derived once, clamped once,
// and reported in meta so the test suite and the panel read the same numbers.
// ---------------------------------------------------------------------------

function parseWeights(text, n) {
  const out = [];
  if (typeof text === 'string' && text.trim()) {
    for (const piece of text.split(/[,;\s]+/)) {
      const v = parseFloat(piece);
      if (isFinite(v) && v > 0.01) out.push(v);
    }
  }
  while (out.length < n) out.push(out.length ? out[out.length % Math.max(1, out.length)] : 1);
  return out.slice(0, n);
}

function solve(p, ctx = {}) {
  const sf = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const closure = ['friction', 'threaded', 'hinged'].includes(p.closure) ? p.closure : 'friction';
  const notes = [];

  // A screw thread has to be round and a 180° clamshell hinge has to have a
  // straight back to hang the knuckles from, so the plan is forced rather than
  // offered — and said out loud in validate() rather than done silently.
  let kind = p.plan === 'round' ? 'round' : 'rect';
  if (closure === 'threaded' && kind !== 'round') { kind = 'round'; notes.push('plan-forced-round'); }
  if (closure === 'hinged' && kind !== 'rect') { kind = 'rect'; notes.push('plan-forced-rect'); }

  let wallT = clamp(num(p.wallT, 1.6), 0.4, 12);
  let floorT = clamp(num(p.floorT, 1.6), 0.4, 12);
  const lidT = clamp(num(p.lidT, 1.6), 0.4, 12);
  const clearance = clamp(num(p.clearance, 0.25), 0.02, 2);

  const wIn = clamp(num(p.width, 90), 5, 400);
  const dIn = clamp(num(p.depth, 60), 5, 400);
  const hIn = clamp(num(p.height, 40), 3, 400);
  const inner = p.sizeMode !== 'outer';

  // The stacking spigot has to be settled BEFORE the floor, because it decides
  // how thick the floor has to be. A spigot is stepped in by wall + clearance
  // so it plugs into the mouth of the box below — which is more than the wall
  // thickness, so anywhere the spigot exists the cavity would otherwise poke
  // straight through the outside of it. The floor is therefore raised to cover
  // the spigot and the 45° flare above it up to the point where the outer
  // surface has come back out past the cavity wall.
  const baseStyle0 = ['flat', 'chamfer', 'stack'].includes(p.baseStyle) ? p.baseStyle : 'chamfer';
  const stackFit = clamp(clearance, 0.1, 0.6);
  let stackH = clamp(hIn * 0.08, 1.5, 4);
  if (baseStyle0 === 'stack') {
    const need = stackH + stackFit + 0.4;
    if (need > hIn * 0.35) stackH = Math.max(0.8, hIn * 0.35 - stackFit - 0.4);
    const need2 = stackH + stackFit + 0.4;
    if (floorT < need2) { floorT = need2; notes.push('floor-raised-for-spigot'); }
  }

  let W, D, H, iw, id, ih;
  if (inner) {
    iw = wIn; id = kind === 'round' ? wIn : dIn;
    W = iw + 2 * wallT; D = id + 2 * wallT;
    ih = hIn; H = ih + floorT;
  } else {
    W = wIn; D = kind === 'round' ? wIn : dIn;
    // A wall thicker than half the box leaves no box; pull it back rather than
    // emitting an inside-out cavity, and say so.
    const maxWall = Math.min(W, D) / 2 - 1;
    if (wallT > maxWall) { wallT = Math.max(0.4, maxWall); notes.push('wall-clamped'); }
    const maxFloor = H_guard(hIn);
    if (floorT > maxFloor) { floorT = maxFloor; notes.push('floor-clamped'); }
    iw = W - 2 * wallT; id = D - 2 * wallT;
    H = hIn; ih = H - floorT;
  }
  function H_guard(h) { return Math.max(0.4, h - 1.5); }
  if (kind === 'round') { D = W; id = iw; }

  const style = kind === 'round' ? 'round'
    : (['round', 'chamfer', 'square'].includes(p.cornerStyle) ? p.cornerStyle : 'round');
  let cornerR = style === 'square' ? 0 : clamp(num(p.cornerR, 3), 0, 60);
  cornerR = Math.min(cornerR, Math.min(W, D) / 2);
  const segs = kind === 'round' ? 1 : (style === 'chamfer' ? 1 : cornerSegs(cornerR, sf));
  const nCirc = Math.max(16, Math.min(256, Math.round(64 * sf)));
  const R = W / 2;                                  // round-plan outer radius

  // One ring generator for the whole object. `ins` is the inset from the outer
  // surface, so ins = 0 is the outside and ins = wallT is the cavity wall.
  const ring = kind === 'round'
    ? (ins) => circleRing(R - ins, nCirc)
    : (ins) => cornerRing(Math.max(W - 2 * ins, 0.02), Math.max(D - 2 * ins, 0.02),
      cornerR - ins, style, segs);

  // ---- base ---------------------------------------------------------------
  const baseStyle = baseStyle0;
  const baseChamfer = clamp(Math.min(0.8, wallT * 0.6, H * 0.12), 0.1, 3);
  let stackInset = wallT + stackFit;
  if (stackInset > Math.min(W, D) / 2 - 1) {
    stackInset = Math.max(0.2, Math.min(W, D) / 2 - 1);
    if (baseStyle === 'stack') notes.push('spigot-clamped');
  }
  if (stackH + stackInset > H * 0.5) stackH = Math.max(0.4, H * 0.5 - stackInset);
  // The floor must still cover the spigot after any of those clamps.
  if (baseStyle === 'stack' && floorT < stackH + stackFit + 0.4) {
    stackH = Math.max(0.4, floorT - stackFit - 0.4);
  }

  // ---- floor fillet -------------------------------------------------------
  let fillet = clamp(num(p.floorFillet, 1.5), 0, 30);
  fillet = Math.min(fillet, Math.max(0, ih - 0.6));

  // ---- divider grid -------------------------------------------------------
  const divT = clamp(num(p.divT, 1.2), 0.4, 8);
  let divX = Math.round(clamp(num(p.divX, 1), 1, 12));
  let divY = Math.round(clamp(num(p.divY, 1), 1, 12));
  if (kind === 'round' && (divX > 1 || divY > 1)) { divX = 1; divY = 1; notes.push('dividers-need-rect'); }
  // A cell narrower than this is a slot the nozzle cannot reach into; drop
  // divisions until every cell is real rather than shipping a solid block.
  const MIN_CELL = 4;
  while (divX > 1 && (iw - (divX - 1) * divT) / divX < MIN_CELL) divX--;
  while (divY > 1 && (id - (divY - 1) * divT) / divY < MIN_CELL) divY--;
  if (divX !== Math.round(clamp(num(p.divX, 1), 1, 12)) ||
    divY !== Math.round(clamp(num(p.divY, 1), 1, 12))) notes.push('cells-reduced');

  const cells = makeCells({ kind, W, D, iw, id, wallT, cornerR, style, segs, nCirc, R, ring,
    divX, divY, divT, fillet, sf,
    colW: parseWeights(p.divColW, divX), rowW: parseWeights(p.divRowW, divY) });

  // ---- closure ------------------------------------------------------------
  // friction
  let lipT = clamp(wallT, 0.8, 4);
  const halfMin = Math.min(iw, id) / 2;
  if (wallT + clearance + lipT > halfMin - 0.6) lipT = Math.max(0.6, halfMin - 0.6 - wallT - clearance);
  let lipH = clamp(num(p.lipH, 5), 0.5, 60);
  lipH = Math.min(lipH, Math.max(0.8, ih - fillet - 0.5));
  const lipChamfer = clamp(Math.min(0.8, lipT * 0.6, lipH * 0.35), 0.05, 2);
  const lidChamfer = clamp(Math.min(0.6, lidT * 0.45), 0.05, 1.5);

  // A friction lid's skirt drops INSIDE the walls, and a divider that runs to
  // the rim is exactly where the skirt wants to be. So with a friction closure
  // the divider grid stops a lip's height plus three layers below the rim; the
  // cells are that much shallower and the lid seats. (Sam, 2026-09-03, on a
  // 176 mm screw organiser: "the lid won't fit as the dividers will stop the
  // friction fit". They would have.) A clamshell's halves meet rim to rim and a
  // screw top has no grid, so neither needs it.
  const DIV_GAP = 0.6;
  const divDrop = closure === 'friction' && (divX > 1 || divY > 1) ? Math.min(lipH + DIV_GAP, Math.max(0, ih - 2)) : 0;
  if (divDrop > 0) notes.push('dividers-lowered');

  // threaded
  const pitch = clamp(num(p.threadPitch, 3), 1, 12);
  let tDepth = clamp(pitch * 0.25, 0.4, 1.8);
  tDepth = Math.min(tDepth, pitch * 0.35);
  const capWall = clamp(wallT, 0.8, 5);
  let rMaj = R - capWall - clearance;
  let threadLen = clamp(num(p.threadLen, 8), 2, 60);
  const th = {};
  if (closure === 'threaded') {
    if (rMaj < tDepth + wallT + 1.5) {
      // Too small a tin for the requested wall: give the thread the room it
      // needs by taking it out of the cap wall, not out of the engagement.
      rMaj = Math.max(tDepth + wallT + 1.5, R * 0.6);
      notes.push('thread-tight');
    }
    threadLen = Math.min(threadLen, Math.max(2, H - floorT - 3));
    const a = tDepth / pitch, c = Math.max(0.05, (1 - 2 * a) / 2);
    th.pitch = pitch; th.depth = tDepth; th.a = a; th.c = c;
    th.rMaj = rMaj; th.rMin = rMaj - tDepth;
    th.len = threadLen;
    th.rMouth = Math.max(1.5, th.rMin - wallT);
    th.rCap = R;
    th.capT = lidT;
    th.lead = Math.min(0.8, tDepth);
    th.z0 = H - threadLen; th.z1 = H;
    th.clearance = clearance;
    th.turns = threadLen / pitch;
    // Where the cap sits when it is screwed home. The cap's internal thread is
    // the same function as the neck's, and turning the cap over to put it on
    // reverses its phase — so the two mate only at the phase that makes the
    // profile line up with its own mirror, which for a symmetric trapezoid is
    // exactly one crest-centre. That is the whole reason the flanks are equal:
    // a buttress thread built this way would not go on at all.
    th.seatFrac = 2 * a + c;
    const skirt = threadLen + 1;
    th.skirt = skirt;
    th.seat = th.z0 + th.capT + pitch * (th.seatFrac + Math.ceil((skirt - pitch * th.seatFrac) / pitch));
    // A polygon inscribed in the bore is SMALLER than the bore it stands for, and
    // so is the polygon on the shaft — but they are triangulated with opposite
    // diagonals, so the two errors do not cancel and the meshes interfere inside
    // a clearance that is analytically correct. The bore carries the sagitta of
    // one facet as an allowance, which is the printed-hole trick applied to the
    // mesh rather than to the slicer.
    th.facet = th.rMaj * (1 - Math.cos(Math.PI / nCirc)) * 2;
    // Even, always: an odd number of flutes is not centrally symmetric, so the
    // cap's bounding box stops being centred on its own axis and centreing the
    // part for the plate quietly walks it off the thread axis by half a flute.
    th.flutes = 2 * Math.max(3, Math.min(20, Math.round(nCirc / 12)));
    th.fluteDepth = clamp(R * 0.03, 0.3, 1.2);
    th.n = nCirc;
  }

  // hinged
  const hg = {};
  if (closure === 'hinged') {
    // The clearance is raised to the machine's floor rather than obeyed: a hinge
    // built at 0.25 mm is not a tight hinge, it is a solid lump, and the person
    // who typed 0.25 wanted a hinge.
    let fit = clamp(num(p.hingeFit, 0.4), 0.05, 2);
    if (fit < MIN_CLEAR) { fit = MIN_CLEAR; notes.push('hinge-fit-raised'); }
    let Rc = clamp(num(p.hingeR, 3), 1, 20);
    Rc = Math.min(Rc, H * 0.4, D * 0.2);
    Rc = Math.max(Rc, fit + 0.8);
    let n = Math.round(clamp(num(p.hingeCount, 5), 3, 25));
    if (n % 2 === 0) n += 1;
    const span = Math.max(W * 0.35, W - 2 * cornerR - 2);
    let slotW = span / n;
    // Each knuckle loses `fit` at each end to the neighbour's relief, so a slot
    // narrower than that is a knuckle that does not exist.
    while (n > 3 && slotW < 2 * fit + 1.2) { n -= 2; slotW = span / n; }
    const pinR = clamp(Rc * 0.42, 0.6, Math.max(0.6, Rc - 0.8));
    hg.fit = fit; hg.Rc = Rc; hg.n = n; hg.span = span; hg.slotW = slotW; hg.pinR = pinR;
    hg.socketR = pinR + fit;
    hg.reliefR = Rc + fit;
    hg.axisY = D / 2 + fit / 2; hg.axisZ = H;
    hg.g = fit / 2;
    hg.lidCY = D + fit;             // centre of the flat-open lid in Y
    hg.catch = !!p.catchOn;
    const beadProj = clamp(wallT * 0.45, 0.25, 0.8);
    const catchH = clamp(Math.min(H * 0.35, 8), 2.2, 12);
    hg.bead = {
      proj: beadProj, h: beadProj + clearance, clr: clearance,
      z: H + catchH * 0.55, gap: fit * Math.SQRT2,
      width: clamp(Math.min(W * 0.3, 26), 6, Math.max(6, span - 2)),
      tabT: clamp(wallT, 0.8, 3), catchH,
    };
  }

  // ---- details ------------------------------------------------------------
  const notch = !!p.notch && closure !== 'threaded';
  let notchW = clamp(num(p.notchW, 24), 4, 200);
  notchW = Math.min(notchW, Math.max(4, (kind === 'round' ? W : W) - 2 * cornerR - 2, 4));
  let notchD = clamp(num(p.notchD, 4), 0.5, 40);
  notchD = Math.min(notchD, Math.max(0.5, ih * 0.6));

  const vents = ['none', 'sides', 'all'].includes(p.vents) ? p.vents : 'none';
  const ventCount = Math.round(clamp(num(p.ventCount, 4), 1, 20));
  const label = ['none', 'front', 'lid'].includes(p.label) ? p.label : 'none';
  const labelW = clamp(num(p.labelW, 40), 4, 200);
  const labelH = clamp(num(p.labelH, 12), 3, 120);
  const labelDepth = clamp(num(p.labelDepth, 0.8), 0.2, 4);
  const mounts = ['none', 'screws', 'magnets'].includes(p.mounts) ? p.mounts : 'none';
  const mountDia = clamp(num(p.mountDia, 6), 1.5, 30);
  const magnetT = clamp(num(p.magnetT, 2), 0.6, 12);

  const arrange = p.arrange === 'assembled' ? 'assembled' : 'plate';
  const part = ['both', 'box', 'lid'].includes(p.part) ? p.part : 'both';

  return {
    sf, segFactor: sf, closure, kind, notes,
    W, D, H, iw, id, ih, R,
    wallT, floorT, lidT, clearance, style, cornerR, segs, nCirc, ring,
    baseStyle, baseChamfer, stackH, stackInset, stackFit,
    fillet, cells, divX, divY, divT,
    lipT, lipH, lipChamfer, lidChamfer, divDrop, divTop: H - divDrop,
    th, hg,
    notch, notchW, notchD, vents, ventCount,
    label, labelW, labelH, labelDepth,
    mounts, mountDia, magnetT,
    arrange, part,
  };
}

/**
 * The cavity, as one pocket or as a grid of them. Every pocket is generated by
 * the same `cornerRing` at the same segment count as the shell, so a cell wall
 * and the shell wall meet vertex to vertex and the rim face triangulates as a
 * single polygon with holes.
 */
function makeCells(g) {
  const filletSegs = Math.max(2, Math.round(3 * Math.sqrt(Math.max(g.fillet, 0.01)) * g.sf));
  const mk = (cw, cd, cx, cy, cr) => {
    const f = Math.min(g.fillet, Math.max(0, Math.min(cw, cd) / 2 - 0.4));
    return {
      w: cw, d: cd, cx, cy, r: cr, fillet: f, filletSegs,
      ring: g.kind === 'round'
        ? (ins) => circleRing(cw / 2 - ins, g.nCirc, cx, cy)
        : (ins) => cornerRing(Math.max(cw - 2 * ins, 0.02), Math.max(cd - 2 * ins, 0.02),
          cr - ins, g.style, g.segs, cx, cy),
    };
  };
  if (g.divX <= 1 && g.divY <= 1) {
    if (g.kind === 'round') return [mk(g.iw, g.iw, 0, 0, g.iw / 2)];
    return [mk(g.iw, g.id, 0, 0, Math.max(0, g.cornerR - g.wallT))];
  }
  const availX = g.iw - (g.divX - 1) * g.divT;
  const availY = g.id - (g.divY - 1) * g.divT;
  const sx = g.colW.reduce((a, b) => a + b, 0) || 1;
  const sy = g.rowW.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  let y = -g.id / 2;
  for (let j = 0; j < g.divY; j++) {
    const cd = availY * g.rowW[j] / sy;
    let x = -g.iw / 2;
    for (let i = 0; i < g.divX; i++) {
      const cw = availX * g.colW[i] / sx;
      const cr = clamp(Math.min(g.cornerR - g.wallT, 1.6), 0, Math.min(cw, cd) / 2 - 1e-3);
      out.push(mk(cw, cd, x + cw / 2, y + cd / 2, Math.max(0, cr)));
      x += cw + g.divT;
    }
    y += cd + g.divT;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tray — the box body, and also the lid of a clamshell.
// ---------------------------------------------------------------------------

function outerLevels(g, H, base) {
  const lv = [];
  if (base === 'stack') {
    lv.push({ z: 0, ins: g.stackInset }, { z: g.stackH, ins: g.stackInset },
      { z: g.stackH + g.stackInset, ins: 0 }, { z: H, ins: 0 });
  } else if (base === 'chamfer') {
    lv.push({ z: 0, ins: g.baseChamfer }, { z: g.baseChamfer, ins: 0 }, { z: H, ins: 0 });
  } else {
    lv.push({ z: 0, ins: 0 }, { z: H, ins: 0 });
  }
  return tidyLevels(lv.filter(l => l.z <= H + 1e-9));
}

function buildTray(g, { H, floorT, cells, base = g.baseStyle, ring = g.ring }) {
  const m = new Mesh();
  const lv = outerLevels(g, H, base);
  const outRings = lv.map(l => ring(l.ins));
  const outIdx = outRings.map((r, i) => addRing(m, r, lv[i].z));
  for (let i = 1; i < outIdx.length; i++) strip(m, outIdx[i - 1], outIdx[i], true);
  cap(m, [outRings[0]], [outIdx[0]], false);

  const topRings = [], topIdx = [];
  for (const c of cells) {
    const f = c.fillet;
    const levels = [];
    if (f > 0.05) {
      const nf = c.filletSegs;
      for (let k = 0; k <= nf; k++) {
        const a = (k / nf) * (Math.PI / 2);
        levels.push({ ring: c.ring(f - f * Math.sin(a)), z: floorT + f - f * Math.cos(a) });
      }
    } else {
      levels.push({ ring: c.ring(0), z: floorT });
    }
    levels.push({ ring: c.ring(0), z: H });
    const idx = stackRings(m, tidyLevels(levels), false);
    cap(m, [levels[0].ring], [idx[0]], true);
    topRings.push(levels[levels.length - 1].ring);
    topIdx.push(idx[idx.length - 1]);
  }
  cap(m, [outRings[outRings.length - 1], ...topRings], [outIdx[outIdx.length - 1], ...topIdx], true);
  return m;
}

/**
 * The band above the divider grid that a friction lid's skirt drops into: a
 * closed frame between the outer wall and the cavity, from just below the
 * divider tops to the rim, unioned onto a tray built only as high as the
 * dividers. It is embedded 0.6 mm into the wall and its inner face sits
 * 0.02 mm inside the wall material, so no face of it is coplanar with the
 * tray's — which is what lets the CSG union close cleanly. 0.1 mm is a quarter
 * of a nozzle width, invisible in the print; a sweep over 0.02–0.3 showed the
 * thin-wall reading is cleanest here. (An annulus cap with
 * the cells as holes was tried first: the cells touch the cavity outline, so
 * the holes touch the boundary and the triangulation leaves open edges
 * wherever the corner radii differ.)
 */
function skirtBand(g) {
  const m = new Mesh();
  const eps = 0.1, embed = 1.5;
  const z0 = g.divTop - embed, z1 = g.H;
  const outer = g.ring(0), inner = g.ring(g.wallT - eps);
  const oLo = addRing(m, outer, z0), oHi = addRing(m, outer, z1);
  const iLo = addRing(m, inner, z0), iHi = addRing(m, inner, z1);
  strip(m, oLo, oHi, true);
  strip(m, iLo, iHi, false);
  cap(m, [outer, inner], [oLo, iLo], false);
  cap(m, [outer, inner], [oHi, iHi], true);
  return m;
}

// ---------------------------------------------------------------------------
// The friction lid — a plate with a lip, upside down, ready to slice.
// ---------------------------------------------------------------------------

function buildFrictionLid(g) {
  const m = new Mesh();
  const { lidT, lipH, lipT, lipChamfer, lidChamfer, wallT, clearance, ring } = g;
  const lipOut = wallT + clearance;
  const lipIn = lipOut + lipT;

  const plate = tidyLevels([
    { z: 0, ins: lidChamfer }, { z: lidChamfer, ins: 0 }, { z: lidT, ins: 0 },
  ]);
  const pRings = plate.map(l => ring(l.ins));
  const pIdx = pRings.map((r, i) => addRing(m, r, plate[i].z));
  for (let i = 1; i < pIdx.length; i++) strip(m, pIdx[i - 1], pIdx[i], true);
  cap(m, [pRings[0]], [pIdx[0]], false);

  // outside of the lip: straight, then a 45° lead-in at the free end
  const oLv = tidyLevels([
    { z: lidT, ins: lipOut },
    { z: lidT + lipH - lipChamfer, ins: lipOut },
    { z: lidT + lipH, ins: lipOut + lipChamfer },
  ]);
  const oRings = oLv.map(l => ring(l.ins));
  const oIdx = oRings.map((r, i) => addRing(m, r, oLv[i].z));
  for (let i = 1; i < oIdx.length; i++) strip(m, oIdx[i - 1], oIdx[i], true);

  const iRingBot = ring(lipIn), iRingTop = ring(lipIn);
  const iIdxBot = addRing(m, iRingBot, lidT);
  const iIdxTop = addRing(m, iRingTop, lidT + lipH);
  strip(m, iIdxBot, iIdxTop, false);

  // the plate's exposed top face, outside the lip and inside it
  cap(m, [pRings[pRings.length - 1], oRings[0]], [pIdx[pIdx.length - 1], oIdx[0]], true);
  cap(m, [iRingBot], [iIdxBot], true);
  // the lip's free end
  cap(m, [oRings[oRings.length - 1], iRingTop], [oIdx[oIdx.length - 1], iIdxTop], true);
  return m;
}

// ---------------------------------------------------------------------------
// The screw cap.
// ---------------------------------------------------------------------------

function gripRing(rc, depth, flutes, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const th = TAU * i / n;
    const r = rc - depth * (1 - Math.cos(flutes * th)) / 2;
    out[i] = [r * Math.cos(th), r * Math.sin(th)];
  }
  return out;
}

function buildThreadCap(g) {
  const t = g.th;
  threadRing.n = t.n;
  const m = new Mesh();
  const capT = t.capT;
  const skirt = t.len + 1;
  const zTop = capT + skirt;
  const grip = gripRing(t.rCap, t.fluteDepth, t.flutes, t.n);

  // outside
  const gBot = addRing(m, grip, 0);
  const gTop = addRing(m, grip, zTop);
  strip(m, gBot, gTop, true);
  cap(m, [grip], [gBot], false);

  // The bore: female thread, phase-locked to the male one and offset outward by
  // the clearance, so the two surfaces are the same function a fixed distance
  // apart and the fit cannot drift with the pitch. The last `lead` mm at the
  // open end flare out at 45°, which turns finding the neck from a fiddle into
  // a drop, and takes the burr on the first crest out of the engagement.
  const { levels } = threadLevels(skirt, t.pitch, g.sf);
  const bore = [];
  for (const zeta of levels) {
    const z = capT + zeta;
    const over = Math.max(0, t.lead - (zTop - z));
    const floorR = over > 0 ? t.rMaj + t.clearance + over : 0;
    bore.push({
      z,
      ring: threadRing(z - capT, {
        rBase: t.rMin + t.clearance + t.facet, depth: t.depth, pitch: t.pitch, a: t.a, c: t.c,
        clip: (r) => Math.max(r, floorR),
      }),
    });
  }
  const bIdx = bore.map(b => addRing(m, b.ring, b.z));
  for (let i = 1; i < bIdx.length; i++) stripSameDiag(m, bIdx[i - 1], bIdx[i], false);
  cap(m, [bore[0].ring], [bIdx[0]], true);
  annulus(m, gTop, bIdx[bIdx.length - 1], true);
  return m;
}

// ---------------------------------------------------------------------------
// Feature cutters — the four things that genuinely cross a wall.
// ---------------------------------------------------------------------------

/** A finger scallop cut down into the front rim, so a nail gets under the lid. */
function notchCutter(g) {
  const { notchW: w, notchD: d, H, D, wallT } = g;
  const r = (w * w / 4 + d * d) / (2 * d);
  const seg = Math.max(16, Math.round(48 * g.sf));
  const len = wallT * 2 + 4;
  return cylinder(r, len, { segments: seg, z0: -len / 2 })
    .rotateX(Math.PI / 2)
    .translate(0, -D / 2 + wallT / 2, H + r - d);
}

/** Vertical arched slots through the walls: an arch has no ceiling to bridge. */
function ventCutters(g) {
  if (g.vents === 'none') return [];
  const out = [];
  const zTop = g.H - Math.max(1.6, g.wallT + 0.8);
  const zBot = g.floorT + Math.max(1.6, g.fillet + 0.8);
  const hSlot = zTop - zBot;
  if (hSlot < 3) return [];
  const rSlot = clamp(Math.min(1.6, hSlot / 4), 0.6, 3);
  const depth = g.wallT * 2 + 4;
  const seg = Math.max(8, Math.round(12 * g.sf));
  const mkOne = () => extrude(slotV(hSlot, rSlot, seg), depth, { z0: -depth / 2, check: false })
    .rotateX(-Math.PI / 2);

  const place = (walls) => {
    for (const wdef of walls) {
      const usable = wdef.len - 2 * g.cornerR - 2 * rSlot - 2;
      if (usable <= 0) continue;
      const n = Math.min(g.ventCount, Math.max(1, Math.floor(usable / (2 * rSlot + 2.2))));
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1) - 0.5);
        const off = t * usable;
        let c = mkOne().translate(off, 0, zBot + hSlot / 2);
        if (wdef.axis === 'y') c = c.rotateZ(Math.PI / 2);
        out.push(c.translate(wdef.x, wdef.y, 0));
      }
    }
  };
  const walls = [
    { axis: 'x', len: g.W, x: 0, y: -g.D / 2 },
    { axis: 'x', len: g.W, x: 0, y: g.D / 2 },
  ];
  if (g.vents === 'all') walls.push(
    { axis: 'y', len: g.D, x: -g.W / 2, y: 0 },
    { axis: 'y', len: g.D, x: g.W / 2, y: 0 });
  if (g.kind === 'round') {
    // Around a round tin the slots march round the circumference instead.
    const n = Math.max(1, g.ventCount * (g.vents === 'all' ? 2 : 1));
    for (let i = 0; i < n; i++) {
      const a = TAU * i / n;
      out.push(mkOne().translate(0, 0, zBot + hSlot / 2)
        .translate(0, -g.R, 0).rotateZ(a));
    }
    return out;
  }
  place(walls);
  return out;
}

/** A vertical stadium: `len` tall, `r` wide at the shoulders. */
function slotV(len, r, segs) {
  const half = Math.max(1e-3, len / 2 - r);
  const out = [];
  for (let k = 0; k <= segs; k++) {
    const a = -Math.PI / 2 + Math.PI * (k / segs);
    out.push([r * Math.sin(a), -half - r * Math.cos(a)]);
  }
  for (let k = 0; k <= segs; k++) {
    const a = Math.PI / 2 + Math.PI * (k / segs);
    out.push([r * Math.sin(a), half - r * Math.cos(a)]);
  }
  // drop the duplicated shoulder points the two arcs share
  const clean = [];
  for (const p of out) {
    const q = clean[clean.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9) continue;
    clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0], b = clean[clean.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) clean.pop();
  }
  return signedArea(clean) < 0 ? clean.reverse() : clean;
}

/**
 * A recessed panel with 45° drafted walls. Drafting it costs nothing and buys
 * two things: the roof of a recess in a vertical wall stops being a ceiling,
 * and on the lid — whose outer face is on the plate — the bridged floor of the
 * recess gets a shorter span and a chamfered edge to start from.
 */
function labelCutter(g, where) {
  const d = g.labelDepth;
  const big = cornerRing(g.labelW, g.labelH, Math.min(1.5, g.labelH / 3), 'round', 4);
  const cut = extrudeDraft(big, d, g.labelW, g.labelH);
  // The cutter's local +Z is "into the surface", and its z = 0 plane is the
  // surface itself, so placing it is one rotation and one translation whichever
  // face it lands on.
  if (where === 'front') return cut.rotateX(-Math.PI / 2).translate(0, -g.D / 2, labelZ(g));
  // The lid's outer face is the one on the plate at z = 0, and the cutter
  // already opens downward there — no rotation at all.
  return cut;
}

function labelZ(g) {
  const top = g.H - Math.max(1.5, g.wallT + 0.5);
  const bot = g.floorT + 1.5;
  const mid = (top + bot) / 2;
  return clamp(mid, bot + g.labelH / 2, Math.max(bot + g.labelH / 2, top - g.labelH / 2));
}

/** Counter-clockwise, whichever way the polygon was written down. */
function ccw(ring) { return signedArea(ring) < 0 ? ring.slice().reverse() : ring; }

/** Ring-stack frustum: outer face at z = -1.2 (outside the wall), floor at z = d. */
function extrudeDraft(ring0, d, w, h) {
  const m = new Mesh();
  const shrink = (t) => ring0.map(p => [p[0] * (1 - 2 * t / w), p[1] * (1 - 2 * t / h)]);
  const lv = [
    { z: -1.2, ring: ring0 },
    { z: 0, ring: ring0 },
    { z: d, ring: shrink(Math.min(d, Math.min(w, h) / 2 - 0.2)) },
  ];
  const idx = lv.map(l => addRing(m, l.ring, l.z));
  for (let i = 1; i < idx.length; i++) strip(m, idx[i - 1], idx[i], true);
  cap(m, [lv[0].ring], [idx[0]], false);
  cap(m, [lv[lv.length - 1].ring], [idx[idx.length - 1]], true);
  return m;
}

/** Screw holes or magnet pockets in the floor. */
function mountCutters(g) {
  if (g.mounts === 'none') return [];
  const pts = mountPoints(g);
  const seg = Math.max(16, Math.round(32 * g.sf));
  const out = [];
  const rs = g.mountDia / 2;
  if (g.mounts === 'screws') {
    // Countersunk, because a counterbore's shoulder is a 90° ceiling and a
    // cone is not: this hole needs no support and takes a flat head flush.
    const cs = clamp(Math.min(g.floorT * 0.6, rs), 0.2, 6);
    for (const [x, y] of pts) {
      out.push(cylinder(rs, g.floorT - cs + 1, { segments: seg, z0: -1 }).translate(x, y, 0));
      out.push(cylinder(rs, cs, { segments: seg, r2: rs + cs, z0: g.floorT - cs }).translate(x, y, 0));
      out.push(cylinder(rs + cs, 1, { segments: seg, z0: g.floorT }).translate(x, y, 0));
    }
  } else {
    const depth = Math.min(g.magnetT, Math.max(0, g.floorT - 0.6));
    if (depth < 0.3) return [];
    for (const [x, y] of pts) {
      out.push(cylinder(rs, depth + 0.5, { segments: seg, z0: g.floorT - depth }).translate(x, y, 0));
    }
  }
  return out;
}

function mountPoints(g) {
  const m = g.mountDia / 2 + 1.5;
  const out = [];
  if (g.cells.length >= 4) {
    const xs = [...new Set(g.cells.map(c => c.cx))].sort((a, b) => a - b);
    const ys = [...new Set(g.cells.map(c => c.cy))].sort((a, b) => a - b);
    for (const x of [xs[0], xs[xs.length - 1]]) for (const y of [ys[0], ys[ys.length - 1]]) out.push([x, y]);
  } else if (g.cells.length > 1) {
    for (const c of g.cells) out.push([c.cx, c.cy]);
  } else {
    const c = g.cells[0];
    const hx = Math.max(0, c.w / 2 - m), hy = Math.max(0, c.d / 2 - m);
    for (const x of hx > 0.5 ? [-hx, hx] : [0]) for (const y of hy > 0.5 ? [-hy, hy] : [0]) out.push([x, y]);
  }
  const seen = new Set(), uniq = [];
  for (const p of out) {
    const k = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(p);
  }
  return uniq.slice(0, 4);
}

// ---------------------------------------------------------------------------
// The print-in-place hinge.
// ---------------------------------------------------------------------------

/** A cylinder lying along X, centred on the hinge axis. */
function alongX(r, x0, len, seg, g) {
  return cylinder(r, len, { segments: seg, z0: x0 }).rotateY(Math.PI / 2)
    .translate(0, g.hg.axisY, g.hg.axisZ);
}

/** The teardrop bore for the pin, lying along X with its roof pointing up. */
function pinBore(g, x0, len) {
  const seg = Math.max(16, Math.round(32 * g.sf));
  return extrude(teardropRing(g.hg.socketR, seg), len, { z0: x0, check: false })
    .rotateY(Math.PI / 2).rotateX(Math.PI / 2)
    .translate(0, g.hg.axisY, g.hg.axisZ);
}

function hingeSlots(g) {
  const { n, span, slotW } = g.hg;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ i, owner: i % 2 === 0 ? 'box' : 'lid', x0: -span / 2 + i * slotW, w: slotW });
  }
  return out;
}

/** The snap tab on the lid's front, as a profile in (Y, Z) extruded along X. */
function catchTab(g) {
  const b = g.hg.bead;
  const yHi = g.hg.lidCY + g.D / 2;
  const yw0 = yHi - g.wallT;
  const y1 = yHi + b.clr;
  const y2 = y1 + b.tabT;
  const boss = (y2 - yHi) + 1;
  const zb = b.z;
  const beadH = Math.min(b.h, g.wallT - 0.15 + b.clr);
  const prof = [
    [yw0, g.H - boss],
    [yHi, g.H - boss],
    [y2, g.H - boss + (y2 - yHi)],
    [y2, g.H + b.catchH],
    [y1, g.H + b.catchH],
    [y1, zb + beadH],
    [y1 - beadH, zb],
    [y1, zb - beadH],
    [y1, g.H],
    [yw0, g.H],
  ];
  return extrude(ccw(prof), b.width, { z0: -b.width / 2, check: false })
    .rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
}

/** The V-groove the tab's bead snaps into, cut from the box's front wall. */
function catchGroove(g) {
  const b = g.hg.bead;
  const y0 = -g.D / 2;
  const apex = y0 + b.proj + b.gap;
  const back = y0 - 2;
  const hHalf = (apex - back);
  const zc = 2 * g.H - b.z;
  const prof = [[back, zc - hHalf], [apex, zc], [back, zc + hHalf]];
  const w = b.width + 2 * g.hg.fit;
  return extrude(ccw(prof), w, { z0: -w / 2, check: false })
    .rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
}

function buildHinged(g) {
  const hg = g.hg;
  const seg = Math.max(16, Math.round(32 * g.sf));
  const slots = hingeSlots(g);
  const boxSlots = slots.filter(s => s.owner === 'box');
  const lidSlots = slots.filter(s => s.owner === 'lid');

  let box = buildTray(g, { H: g.H, floorT: g.floorT, cells: g.cells });
  let lid = buildTray(g, {
    H: g.H, floorT: g.lidT,
    cells: [oneCell(g)], base: g.baseStyle === 'stack' ? 'chamfer' : g.baseStyle,
  }).translate(0, hg.lidCY, 0);

  const knuckle = (s) => alongX(hg.Rc, s.x0, s.w, seg, g);
  const relief = (s) => alongX(hg.reliefR, s.x0 - hg.fit, s.w + 2 * hg.fit, seg, g);

  box = unionAll([box, ...boxSlots.map(knuckle)]);
  box = subtractAll(box, lidSlots.map(relief));
  box = union(box, alongX(hg.pinR, -hg.span / 2, hg.span, seg, g));

  lid = unionAll([lid, ...lidSlots.map(knuckle)]);
  lid = subtractAll(lid, boxSlots.map(relief));
  lid = subtractAll(lid, [pinBore(g, -hg.span / 2 - 1, hg.span + 2)]);

  if (hg.catch) {
    lid = union(lid, catchTab(g));
    box = subtractAll(box, [catchGroove(g)]);
  }
  return { box, lid };
}

function oneCell(g) {
  const cw = g.iw, cd = g.id;
  const cr = g.kind === 'round' ? cw / 2 : Math.max(0, g.cornerR - g.wallT);
  const f = Math.min(g.fillet, Math.max(0, Math.min(cw, cd) / 2 - 0.4));
  return {
    w: cw, d: cd, cx: 0, cy: 0, r: cr, fillet: f,
    filletSegs: Math.max(2, Math.round(3 * Math.sqrt(Math.max(f, 0.01)) * g.sf)),
    ring: g.kind === 'round'
      ? (ins) => circleRing(cw / 2 - ins, g.nCirc)
      : (ins) => cornerRing(Math.max(cw - 2 * ins, 0.02), Math.max(cd - 2 * ins, 0.02),
        cr - ins, g.style, g.segs),
  };
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

function buildBox(g) {
  let m;
  if (g.closure === 'threaded') m = buildThreadedBox(g);
  else if (g.divDrop > 0 && g.kind !== 'round') {
    m = union(buildTray(g, { H: g.divTop, floorT: g.floorT, cells: g.cells }), skirtBand(g));
  } else m = buildTray(g, { H: g.H, floorT: g.floorT, cells: g.cells });

  const cutters = [];
  // The notch and the catch both want the middle of the front wall, and the
  // notch wins the boolean — it was quietly cutting the catch groove away. On a
  // clamshell the catch tab IS the thing you lift, so the notch stands down.
  if (g.notch && !(g.closure === 'hinged' && g.hg.catch)) cutters.push(notchCutter(g));
  cutters.push(...ventCutters(g));
  if (g.label === 'front') cutters.push(labelCutter(g, 'front'));
  cutters.push(...mountCutters(g));
  if (cutters.length) m = subtractAll(m, cutters);
  return m;
}

/** The screw-top body: a tin with a threaded neck, built as one ring stack. */
function buildThreadedBox(g) {
  const t = g.th;
  threadRing.n = t.n;
  const m = new Mesh();
  const lv = outerLevels(g, t.z0, g.baseStyle);
  const outRings = lv.map(l => g.ring(l.ins));
  const outIdx = outRings.map((r, i) => addRing(m, r, lv[i].z));
  for (let i = 1; i < outIdx.length; i++) strip(m, outIdx[i - 1], outIdx[i], true);
  cap(m, [outRings[0]], [outIdx[0]], false);

  const { levels } = threadLevels(t.len, t.pitch, g.sf);
  const neck = [];
  for (const zeta of levels) {
    const z = t.z0 + zeta;
    const cut = Math.max(0, t.lead - (t.z1 - z));      // 45° chamfer at the free end
    neck.push({
      z,
      ring: threadRing(z - t.z0, {
        rBase: t.rMin, depth: t.depth, pitch: t.pitch, a: t.a, c: t.c,
        clip: (r) => Math.min(r, t.rMaj - cut),
      }),
    });
  }
  const nIdx = neck.map(l => addRing(m, l.ring, l.z));
  for (let i = 1; i < nIdx.length; i++) stripSameDiag(m, nIdx[i - 1], nIdx[i], true);
  annulus(m, outIdx[outIdx.length - 1], nIdx[0], true);      // the shoulder

  // the bore: mouth, a 45° cone out to the cavity, then the cavity itself
  const rCav = t.rCap - g.wallT;
  const coneH = Math.max(0.2, rCav - t.rMouth);
  const zCone = Math.max(g.floorT + g.fillet + 0.4, t.z0 - coneH);
  const f = Math.min(g.fillet, Math.max(0, rCav - 0.4));
  const inLv = [];
  const nf = Math.max(2, Math.round(3 * Math.sqrt(Math.max(f, 0.01)) * g.sf));
  if (f > 0.05) {
    for (let k = 0; k <= nf; k++) {
      const a = (k / nf) * (Math.PI / 2);
      inLv.push({ ring: circleRing(rCav - f + f * Math.sin(a), t.n), z: g.floorT + f - f * Math.cos(a) });
    }
  } else {
    inLv.push({ ring: circleRing(rCav, t.n), z: g.floorT });
  }
  inLv.push({ ring: circleRing(rCav, t.n), z: zCone });
  inLv.push({ ring: circleRing(t.rMouth, t.n), z: Math.min(t.z1 - 0.2, zCone + coneH) });
  inLv.push({ ring: circleRing(t.rMouth, t.n), z: t.z1 });
  const iLv = tidyLevels(inLv);
  const iIdx = stackRings(m, iLv, false);
  cap(m, [iLv[0].ring], [iIdx[0]], true);
  annulus(m, nIdx[nIdx.length - 1], iIdx[iIdx.length - 1], true);
  return m;
}

function buildLid(g) {
  let m;
  if (g.closure === 'threaded') m = buildThreadCap(g);
  else m = buildFrictionLid(g);
  if (g.label === 'lid') m = subtractAll(m, [labelCutter(g, 'lid')]);
  return m;
}

function lidStackHeight(g) {
  if (g.closure === 'threaded') return g.th.capT + g.th.len + 1;
  return g.lidT + g.lipH;
}

function build(p, ctx = {}) {
  const g = solve(p, ctx);
  const parts = [];

  if (g.closure === 'hinged') {
    const h = buildHinged(g);
    // The clamshell's lid lies top-face-down on the plate exactly as the friction
    // lid does, so a label recess lands the same way.
    const lid = g.label === 'lid' ? subtractAll(h.lid, [labelCutter(g, 'lid').translate(0, g.hg.lidCY, 0)]) : h.lid;
    parts.push({ name: 'box', mesh: h.box }, { name: 'lid', mesh: lid });
  } else {
    if (g.part !== 'lid') parts.push({ name: 'box', mesh: buildBox(g) });
    if (g.part !== 'box') parts.push({ name: 'lid', mesh: buildLid(g) });
  }

  const arranged = arrange(g, parts);
  const off = arranged.offset;
  const axisY = g.closure === 'hinged' && arranged.mode !== 'assembled' ? g.hg.axisY + off[1] : null;
  const axisZ = g.closure === 'hinged' && arranged.mode !== 'assembled' ? g.hg.axisZ + off[2] : null;

  const meta = {
    closure: g.closure, plan: g.kind, arrange: arranged.mode, part: g.part,
    outer: { w: g.W, d: g.D, h: g.H },
    inner: { w: g.iw, d: g.id, h: g.ih },
    wallT: g.wallT, floorT: g.floorT, lidT: g.lidT, clearance: g.clearance,
    extrusions: g.wallT / EXTRUSION,
    cornerR: g.cornerR, cornerStyle: g.style, floorFillet: g.fillet,
    base: { style: g.baseStyle, chamfer: g.baseChamfer, stackH: g.stackH, stackInset: g.stackInset },
    cells: g.cells.map(c => ({ x: c.cx, y: c.cy, w: c.w, d: c.d, r: c.r, fillet: c.fillet })),
    grid: { cols: g.divX, rows: g.divY, wall: g.divT, top: g.divTop, belowRim: g.divDrop },
    lip: g.closure === 'friction'
      ? { height: g.lipH, thickness: g.lipT, chamfer: g.lipChamfer,
          outerInset: g.wallT + g.clearance, gapPerSide: g.clearance }
      : null,
    thread: g.closure === 'threaded'
      ? { pitch: g.th.pitch, depth: g.th.depth, majorD: g.th.rMaj * 2, minorD: g.th.rMin * 2,
          mouthD: g.th.rMouth * 2, capOD: g.th.rCap * 2, length: g.th.len, turns: g.th.turns,
          clearance: g.th.clearance, flankDeg: 45, flutes: g.th.flutes,
          skirt: g.th.skirt, capT: g.th.capT, neckZ0: g.th.z0, seat: g.th.seat,
          seatFrac: g.th.seatFrac, lead: g.th.lead, facetAllowance: g.th.facet }
      : null,
    hinge: g.closure === 'hinged'
      ? { axisY, axisZ, knuckleR: g.hg.Rc, pinR: g.hg.pinR, socketR: g.hg.socketR,
          clearance: g.hg.fit, reliefR: g.hg.reliefR, count: g.hg.n, slotW: g.hg.slotW,
          span: g.hg.span, standoff: g.hg.g, openAngleDeg: 180,
          closedHeight: 2 * g.H, lidCentreY: g.hg.lidCY + off[1],
          catch: g.hg.catch ? { ...g.hg.bead, grooveDepth: g.hg.bead.proj + g.hg.bead.gap } : null }
      : null,
    notch: g.notch ? { width: g.notchW, depth: g.notchD } : null,
    vents: g.vents === 'none' ? null : { mode: g.vents, count: g.ventCount },
    label: g.label === 'none' ? null : { on: g.label, w: g.labelW, h: g.labelH, depth: g.labelDepth },
    mounts: g.mounts === 'none' ? null : { kind: g.mounts, dia: g.mountDia, count: mountPoints(g).length,
      pocketDepth: g.mounts === 'magnets' ? Math.min(g.magnetT, Math.max(0, g.floorT - 0.6)) : null },
    plate: arranged.plate,
    parts: arranged.parts.map(pt => {
      const b = pt.mesh.bbox();
      return { name: pt.name, w: b.size[0], d: b.size[1], h: b.size[2],
        x: b.center[0], y: b.center[1] };
    }),
    lidStack: lidStackHeight(g),
    notes: g.notes,
  };

  meta.dims = boxlidDims(p, g, partTransforms(parts, arranged));

  return { mesh: arranged.mesh, parts: arranged.parts, meta };
}

// ---------------------------------------------------------------------------
// Dimension callouts
//
// Each callout is written in the frame the part was BUILT in — the box centred
// on the origin with its floor on z = 0, the lid lying face-down the same way —
// and then carried through whatever arrange() did to that part. The rotation
// is known from the mode (a packed part may be turned a quarter, an assembled
// lid is flipped over) and the translation is read back off the part's own
// first vertex, so the callout lands exactly where the mesh did without the
// arrangement code having to know it exists.
// ---------------------------------------------------------------------------

function partTransforms(parts, arranged) {
  const out = {};
  for (const src of parts) {
    const dst = arranged.parts.find(pt => pt.name === src.name);
    if (!dst) continue;
    let rot = (q) => q;
    if (arranged.mode === 'assembled' && src.name === 'lid') rot = (q) => [q[0], -q[1], -q[2]];
    else if (arranged.plate && arranged.plate.packed) {
      const pl = arranged.plate.parts.find(pt => pt.name === src.name);
      if (pl && pl.rot) rot = (q) => [-q[1], q[0], q[2]];
    }
    const a = rot(src.mesh.vertex(0)), b = dst.mesh.vertex(0);
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    out[src.name] = {
      pt: (q) => { const r = rot(q); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]]; },
      dir: (v) => rot(v),
    };
  }
  return out;
}

function boxlidDims(p, g, xf) {
  const dims = [];
  const K = Math.SQRT1_2;
  const { W, D, H } = g;
  const push = (part, param, label, from, to, actual, asked, offset) => {
    const T = xf[part];
    if (!T) return;
    const d = { param, label, from: T.pt(from), to: T.pt(to), offset: Array.isArray(offset) ? T.dir(offset) : offset };
    if (Math.abs(actual - asked) > 1e-9) d.value = actual;
    dims.push(d);
  };
  const out = [0, -6, 0];                      // off the front face, towards the viewer
  const right = [6, 0, 0];

  // ---- the box --------------------------------------------------------------
  if (xf.box) {
    const c0 = g.cells[0];
    const threaded = g.closure === 'threaded';
    // The wall, across the left wall where the view sees the inner face: on the
    // rim for a tray, and just above the floor fillet on a threaded tin whose
    // rim is the neck.
    let zWall = H;
    if (threaded) zWall = Math.max(g.floorT + c0.fillet + 0.3, g.floorT + 0.3);
    push('box', 'wallT', 'wall', [-W / 2, 0, zWall], [-W / 2 + g.wallT, 0, zWall], g.wallT, num(p.wallT, 1.6), 8);
    push('box', 'floorT', 'floor', [0, -D / 2, 0], [0, -D / 2, g.floorT], g.floorT, num(p.floorT, 1.6), out);

    if (g.kind !== 'round' && g.cornerR > 0.05) {
      const r = g.cornerR;
      if (g.style === 'chamfer') {
        push('box', 'cornerR', 'chamfer', [W / 2 - r, -D / 2, H], [W / 2, -D / 2, H], r, num(p.cornerR, 3), out);
      } else {
        const cx = W / 2 - r, cy = -D / 2 + r;
        push('box', 'cornerR', 'R', [cx, cy, H], [cx + r * K, cy - r * K, H], r, num(p.cornerR, 3), 8);
      }
    }
    if (c0 && c0.fillet > 0.05) {
      const f = c0.fillet;
      const xl = threaded ? -(g.R - g.wallT) : c0.cx - c0.w / 2;
      push('box', 'floorFillet', 'R', [xl + f, c0.cy, g.floorT + f], [xl + f - f * K, c0.cy, g.floorT + f - f * K], f, num(p.floorFillet, 1.5), 8);
    }
    if (g.divX > 1 || g.divY > 1) {
      const c1 = g.divX > 1 ? g.cells[1] : g.cells[g.divX];
      const a = g.divX > 1 ? [c0.cx + c0.w / 2, c0.cy, H] : [c0.cx, c0.cy + c0.d / 2, H];
      const b = g.divX > 1 ? [c1.cx - c1.w / 2, c0.cy, H] : [c0.cx, c1.cy - c1.d / 2, H];
      push('box', 'divT', 'divider', a, b, g.divT, num(p.divT, 1.2), 8);
    }
    if (g.notch && !(g.closure === 'hinged' && g.hg.catch)) {
      push('box', 'notchD', 'notch', [0, -D / 2, H - g.notchD], [0, -D / 2, H], g.notchD, num(p.notchD, 4), out);
      push('box', 'notchW', 'notch', [-g.notchW / 2, -D / 2, H], [g.notchW / 2, -D / 2, H], g.notchW, num(p.notchW, 24), out);
    }
    if (g.label === 'front') {
      const zL = labelZ(g), hw = g.labelW / 2, hh = g.labelH / 2;
      push('box', 'labelW', 'label', [-hw, -D / 2, zL - hh], [hw, -D / 2, zL - hh], g.labelW, num(p.labelW, 40), out);
      push('box', 'labelH', 'label', [hw, -D / 2, zL - hh], [hw, -D / 2, zL + hh], g.labelH, num(p.labelH, 12), out);
      push('box', 'labelDepth', 'recess', [0, -D / 2 + g.labelDepth, zL], [0, -D / 2, zL], g.labelDepth, num(p.labelDepth, 0.8), out);
    }
    if (g.mounts !== 'none') {
      const pts = mountPoints(g);
      const [mx, my] = pts.reduce((a, b) => (b[0] - b[1] > a[0] - a[1] ? b : a));   // the front-right one
      const rs = g.mountDia / 2;
      if (g.mounts === 'screws') {
        const cs = clamp(Math.min(g.floorT * 0.6, rs), 0.2, 6);
        push('box', 'mountDia', 'Ø', [mx - rs, my, g.floorT - cs], [mx + rs, my, g.floorT - cs], 2 * rs, num(p.mountDia, 6), out);
      } else {
        const depth = Math.min(g.magnetT, Math.max(0, g.floorT - 0.6));
        if (depth >= 0.3) {
          push('box', 'mountDia', 'Ø', [mx - rs, my, g.floorT], [mx + rs, my, g.floorT], 2 * rs, num(p.mountDia, 6), out);
          push('box', 'magnetT', 'pocket', [mx, my - rs, g.floorT - depth], [mx, my - rs, g.floorT], depth, num(p.magnetT, 2), out);
        }
      }
    }
    if (threaded) {
      const t = g.th;
      push('box', 'threadLen', 'thread', [t.rMaj, 0, t.z0], [t.rMaj, 0, t.z1], t.len, num(p.threadLen, 8), right);
      push('box', 'threadPitch', 'pitch', [t.rMaj, 0, t.z0 + 0.5], [t.rMaj, 0, t.z0 + 0.5 + t.pitch], t.pitch, num(p.threadPitch, 3), right);
    }
    if (g.closure === 'hinged') {
      const hg = g.hg;
      const slots = hingeSlots(g);
      const bs = slots.filter(sl => sl.owner === 'box').pop();
      const xk = bs.x0 + bs.w / 2;
      push('box', 'hingeR', 'R', [xk, hg.axisY, hg.axisZ], [xk, hg.axisY, hg.axisZ + hg.Rc], hg.Rc, num(p.hingeR, 3), 8);
      const ls = slots.find(sl => sl.owner === 'lid');
      push('box', 'hingeFit', 'gap', [ls.x0 - hg.fit, hg.axisY, hg.axisZ + hg.Rc], [ls.x0, hg.axisY, hg.axisZ + hg.Rc], hg.fit, num(p.hingeFit, 0.4), [0, 0, 6]);
    }
  }

  // ---- the lid --------------------------------------------------------------
  if (xf.lid) {
    if (g.closure === 'friction') {
      const lipOut = g.wallT + g.clearance;
      push('lid', 'lidT', 'lid', [W / 2, 0, 0], [W / 2, 0, g.lidT], g.lidT, num(p.lidT, 1.6), right);
      push('lid', 'lipH', 'lip', [W / 2 - lipOut, 0, g.lidT], [W / 2 - lipOut, 0, g.lidT + g.lipH], g.lipH, num(p.lipH, 5), right);
      push('lid', 'clearance', 'clearance', [W / 2 - lipOut, 0, g.lidT], [W / 2 - g.wallT, 0, g.lidT], g.clearance, num(p.clearance, 0.25), [0, 0, 6]);
    } else if (g.closure === 'threaded') {
      push('lid', 'lidT', 'cap', [g.th.rCap, 0, 0], [g.th.rCap, 0, g.th.capT], g.th.capT, num(p.lidT, 1.6), right);
    } else {
      const cy = g.hg.lidCY;
      push('lid', 'lidT', 'lid', [W / 2, cy, 0], [W / 2, cy, g.lidT], g.lidT, num(p.lidT, 1.6), right);
    }
    if (g.label === 'lid') {
      const cy = g.closure === 'hinged' ? g.hg.lidCY : 0;
      const hw = g.labelW / 2, hh = g.labelH / 2;
      push('lid', 'labelW', 'label', [-hw, cy - hh, 0], [hw, cy - hh, 0], g.labelW, num(p.labelW, 40), [0, -6, 0]);
      push('lid', 'labelH', 'label', [hw, cy - hh, 0], [hw, cy + hh, 0], g.labelH, num(p.labelH, 12), right);
      push('lid', 'labelDepth', 'recess', [0, cy, 0], [0, cy, g.labelDepth], g.labelDepth, num(p.labelDepth, 0.8), right);
    }
  }
  return dims;
}

/**
 * Lay the parts out. `plate` puts them side by side flat on the bed, which is
 * how they have to print; `assembled` closes the object, which is how it has to
 * look. The plate layout is packed rather than guessed so the preview is the
 * arrangement that actually goes to the slicer.
 */
function arrange(g, parts) {
  if (parts.length === 1) {
    const m = parts[0].mesh.centerXY().dropToPlate();
    const b = parts[0].mesh.bbox();
    return {
      mode: g.arrange, mesh: m, offset: [-b.center[0], -b.center[1], -b.min[2]],
      parts: [{ name: parts[0].name, mesh: m }],
      plate: { packed: false, overlap: false, fitsBed: fits(m), parts: [{ name: parts[0].name, x: 0, y: 0 }] },
    };
  }

  if (g.arrange === 'assembled') {
    const box = parts[0].mesh, lid = parts[1].mesh;
    // Seated exactly, the lid's underside and the box's rim are the same plane
    // and the preview welds into one non-manifold lump. Lift the lid by the
    // clearance it was designed with: it is the gap that is actually there, and
    // it keeps the preview a pair of honest solids.
    const seat = Math.max(g.clearance, 0.15);
    let placed;
    if (g.closure === 'hinged') {
      placed = lid.translate(0, -g.hg.axisY, -g.hg.axisZ).rotateX(Math.PI)
        .translate(0, g.hg.axisY, g.hg.axisZ + Math.max(g.hg.fit, 0.15));
    } else if (g.closure === 'threaded') {
      placed = lid.rotateX(Math.PI).translate(0, 0, g.th.seat);
    } else {
      placed = lid.rotateX(Math.PI).translate(0, 0, g.H + g.lidT + seat);
    }
    const merged = Mesh.merge([box, placed]);
    const b = merged.bbox();
    const off = [-b.center[0], -b.center[1], -b.min[2]];
    const out = merged.translate(off[0], off[1], off[2]);
    return {
      mode: 'assembled', mesh: out, offset: off,
      parts: [{ name: 'box', mesh: box.translate(off[0], off[1], off[2]) },
        { name: 'lid', mesh: placed.translate(off[0], off[1], off[2]) }],
      plate: { packed: false, overlap: false, fitsBed: fits(out),
        parts: [{ name: 'box', x: 0, y: 0 }, { name: 'lid', x: 0, y: 0 }] },
    };
  }

  // The clamshell is ALREADY its plate layout — flat open is both the shape it
  // has to print in and the shape the hinge was designed around. Packing it
  // would separate two halves that are joined by a pin.
  if (g.closure === 'hinged') {
    const merged = Mesh.merge(parts.map(pt => pt.mesh));
    const b = merged.bbox();
    const off = [-b.center[0], -b.center[1], -b.min[2]];
    const out = merged.translate(off[0], off[1], off[2]);
    return {
      mode: 'plate', mesh: out, offset: off,
      parts: parts.map(pt => ({ name: pt.name, mesh: pt.mesh.translate(off[0], off[1], off[2]) })),
      plate: {
        packed: false, interlocked: true, overlap: false, fitsBed: fits(out),
        parts: parts.map(pt => {
          const pb = pt.mesh.translate(off[0], off[1], off[2]).bbox();
          return { name: pt.name, x: pb.center[0], y: pb.center[1], w: pb.size[0], d: pb.size[1], rot: false };
        }),
      },
    };
  }

  // plate: pack the two footprints, and fall back to a plain side-by-side row
  // when they cannot both fit — an overlapping preview would be a lie, an
  // oversized one is merely a warning.
  const items = parts.map(pt => {
    const b = pt.mesh.bbox();
    return { id: pt.name, w: b.size[0], d: b.size[1], meta: { h: b.size[2] } };
  });
  const centred = parts.map(pt => ({ name: pt.name, mesh: pt.mesh.centerXY().dropToPlate() }));
  let placedParts, plate;
  let packing = null;
  try { packing = pack(items, BED, { gap: 4 }); } catch { packing = null; }
  if (packing && !packing.unplaced.length) {
    const byId = {};
    centred.forEach((c, i) => { byId[c.name] = c.mesh; void i; });
    const laid = packLayout(byId, packing);
    placedParts = laid.parts.map(pp => ({ name: pp.id, mesh: pp.mesh }));
    plate = {
      packed: true, overlap: !!anyOverlap(packing), fitsBed: withinBed(packing, BED),
      fill: packing.fill, used: packing.used,
      parts: packing.placed.map(pp => ({ name: pp.id, x: pp.x, y: pp.y, w: pp.w, d: pp.d, rot: pp.rot })),
    };
  } else {
    const gap = 4;
    let x = 0;
    const rows = [];
    for (const c of centred) {
      const b = c.mesh.bbox();
      rows.push({ name: c.name, mesh: c.mesh, w: b.size[0], d: b.size[1], x: x + b.size[0] / 2 });
      x += b.size[0] + gap;
    }
    const total = x - gap;
    placedParts = rows.map(r => ({ name: r.name, mesh: r.mesh.translate(r.x - total / 2, 0, 0) }));
    plate = {
      packed: false, overlap: false, fitsBed: total <= BED.x && rows.every(r => r.d <= BED.y),
      parts: rows.map(r => ({ name: r.name, x: r.x - total / 2, y: 0, w: r.w, d: r.d, rot: false })),
    };
  }
  const merged = Mesh.merge(placedParts.map(pp => pp.mesh));
  const b = merged.bbox();
  const off = [-b.center[0], -b.center[1], -b.min[2]];
  return {
    mode: 'plate', mesh: merged.translate(off[0], off[1], off[2]), offset: off,
    parts: placedParts.map(pp => ({ name: pp.name, mesh: pp.mesh.translate(off[0], off[1], off[2]) })),
    plate,
  };
}

function fits(m) {
  const s = m.bbox().size;
  return s[0] <= BED.x + 1e-6 && s[1] <= BED.y + 1e-6 && s[2] <= BED.z + 1e-6;
}

// ---------------------------------------------------------------------------
// Validation and slicing advice.
// ---------------------------------------------------------------------------

function validate(p) {
  const g = solve(p, {});
  const out = [];
  const say = (param, severity, message) => out.push({ param, severity, message });

  if (g.closure !== 'hinged' && g.clearance < 0.15) {
    say('clearance', 'error',
      `${g.clearance} mm per side will fuse: two printed faces that close within about ${MIN_CLEAR} mm ` +
      'weld together on a 0.4 mm nozzle and the lid becomes part of the box. Use 0.2–0.3 mm.');
  } else if (g.closure !== 'hinged' && g.clearance > 0.6) {
    say('clearance', 'warn', `${g.clearance} mm per side is a loose lid — it will not stay on. 0.2–0.3 mm is the usable range.`);
  }
  if (g.wallT < 2 * EXTRUSION - 1e-9) {
    say('wallT', 'error', `A ${g.wallT} mm wall is ${(g.wallT / EXTRUSION).toFixed(1)} extrusions. ` +
      'Under two it prints as a single unsupported bead and splits along the layer lines.');
  } else if (Math.abs(g.wallT / EXTRUSION - Math.round(g.wallT / EXTRUSION)) > 0.06) {
    say('wallT', 'warn', `${g.wallT} mm is ${(g.wallT / EXTRUSION).toFixed(2)} extrusions — ` +
      `the slicer will leave a gap-fill seam down the wall. ${(Math.round(g.wallT / EXTRUSION) * EXTRUSION).toFixed(1)} mm is the nearest whole number of beads.`);
  }
  if (g.floorT < 3 * 0.2) say('floorT', 'warn', `A ${g.floorT} mm floor is under three layers and will show pinholes.`);
  if (g.iw < 4 || g.id < 4 || g.ih < 3) {
    say('width', 'error', `The cavity works out at ${g.iw.toFixed(1)} × ${g.id.toFixed(1)} × ${g.ih.toFixed(1)} mm — ` +
      'the wall and floor have eaten the box. Switch the dimensions to inner, or thin the wall.');
  }
  const plateW = g.part === 'both' && g.arrange === 'plate' ? g.W + g.W + 4 : g.W;
  if (g.W > BED.x || g.D > BED.y || g.H > BED.z) {
    say('width', 'error', `${g.W.toFixed(0)} × ${g.D.toFixed(0)} × ${g.H.toFixed(0)} mm does not fit the ${BED.x} mm bed.`);
  } else if (g.part === 'both' && g.arrange === 'plate' && plateW > BED.x && g.W + g.D + 4 > BED.x && g.D * 2 + 4 > BED.y) {
    say('arrange', 'error', 'The box and the lid will not both fit on one plate at this size — print them one at a time with the Part selector.');
  }
  for (const n of g.notes) {
    if (n === 'plan-forced-round') say('plan', 'warn', 'A screw thread has to be circular, so the plan has been made round and the depth follows the width.');
    if (n === 'plan-forced-rect') say('plan', 'warn', 'The clamshell hinge needs a straight back to hang its knuckles from, so the plan has been made rectangular.');
    if (n === 'dividers-need-rect') say('divX', 'warn', 'The divider grid only applies to a rectangular plan; it has been ignored.');
    if (n === 'dividers-lowered') say('divX', 'info', `The dividers stop ${g.divDrop.toFixed(1)} mm below the rim so the lid's skirt can drop inside the walls; the cells are ${(g.divTop - g.floorT).toFixed(1)} mm deep. A grid that ran to the rim would hold the lid off.`);
    if (n === 'cells-reduced') say('divX', 'warn', `Some divisions were dropped: a cell under 4 mm across is a slot the nozzle cannot get into. The grid is now ${g.divX} × ${g.divY}.`);
    if (n === 'wall-clamped') say('wallT', 'warn', `The wall was thicker than half the box; it has been pulled back to ${g.wallT.toFixed(2)} mm.`);
    if (n === 'floor-clamped') say('floorT', 'warn', `The floor was deeper than the box; it has been pulled back to ${g.floorT.toFixed(2)} mm.`);
    if (n === 'hinge-fit-raised') say('hingeFit', 'error', `A hinge clearance under ${MIN_CLEAR} mm fuses on a 0.4 mm nozzle. It has been raised to ${MIN_CLEAR} mm so the hinge still turns.`);
    if (n === 'thread-tight') say('threadPitch', 'warn', 'The thread needed more room than the cap wall left it; the neck has been made larger.');
    if (n === 'floor-raised-for-spigot') say('floorT', 'warn', `The stacking spigot is stepped in by more than the wall thickness, so the floor has been raised to ${g.floorT.toFixed(2)} mm to keep solid material behind it. Choose a flat or chamfered base to get the thin floor back.`);
    if (n === 'spigot-clamped') say('baseStyle', 'warn', 'The box is too small for a full-depth stacking spigot; the step has been reduced and these boxes may not stack reliably.');
  }
  if (g.mounts === 'magnets' && g.floorT < g.magnetT + 0.6) {
    say('floorT', 'error', `A ${g.magnetT} mm magnet needs a floor of at least ${(g.magnetT + 0.6).toFixed(1)} mm; ` +
      `at ${g.floorT} mm the pocket has been cut to ${Math.max(0, g.floorT - 0.6).toFixed(1)} mm and the magnet will stand proud.`);
  }
  if (g.mounts === 'screws' && g.mountDia > Math.min(g.iw, g.id) / 3) {
    say('mountDia', 'warn', 'The screw holes are large relative to the floor; they will run into the walls.');
  }
  if (g.label !== 'none' && g.labelDepth > g.wallT * 0.6) {
    say('labelDepth', 'warn', `A ${g.labelDepth} mm recess in a ${g.wallT} mm wall leaves under half the wall behind it.`);
  }
  if (g.label === 'front' && g.labelW > g.W - 2 * g.cornerR - 2) {
    say('labelW', 'warn', 'The label panel is wider than the flat part of the front wall and will wrap onto the corners.');
  }
  if (g.label === 'front' && g.kind === 'round') {
    say('label', 'warn', 'A flat recess in a round wall is deeper in the middle than at the ends; keep it narrow or move it to the lid.');
  }
  if (g.vents !== 'none' && g.ih < 8) say('vents', 'warn', 'The box is too shallow for useful vents; the slots have been shortened or dropped.');
  if (g.notch && g.notchD > g.ih * 0.5) say('notchD', 'warn', 'The finger notch is more than half the depth of the box — it will let small things fall out.');
  if (g.notch && g.closure === 'hinged' && g.hg.catch) {
    say('notch', 'warn', 'The finger notch and the snap catch want the same piece of the front wall, and the notch would cut the catch groove away — so the notch has been left off. The catch tab is what you lift a clamshell by.');
  }
  if (g.notch && g.closure === 'threaded') say('notch', 'warn', 'A screw top has no rim to notch; the cap\'s grip flutes do that job.');
  if (g.closure === 'friction' && g.lipH < 2) say('lipH', 'warn', 'A lip under 2 mm barely engages; the lid will rock.');
  return out;
}

function hints(p) {
  const g = solve(p, {});
  const perim = Math.max(2, Math.round(g.wallT / EXTRUSION));
  const layerH = g.closure === 'hinged' ? 0.16 : (g.H > 70 ? 0.24 : 0.2);
  const notes = [];

  notes.push(`${layerH} mm layers, ${perim} perimeters. A ${g.wallT} mm wall is ` +
    `${(g.wallT / EXTRUSION).toFixed(1)} extrusions, so at ${perim} perimeters it comes out solid with no gap-fill seam down the middle.`);
  notes.push(`${Math.max(4, Math.ceil(g.floorT / layerH))} bottom solid layers — the floor is ${g.floorT} mm and anything less shows pinholes when you hold it up to the light.`);
  notes.push('10–15% gyroid infill. Everything load-bearing here is perimeter; infill only fills the floor and the divider roots, and pushing it higher buys time, not strength.');

  if (g.closure === 'friction') {
    notes.push(`No supports. Print the lid the way it comes out of here — flat face down, lip pointing up. ` +
      `The 45° lead-in on the lip and the ${g.baseStyle === 'chamfer' ? 'chamfer' : 'edge'} on the box base are the only sloped surfaces and both are self-supporting.`);
    notes.push(`Fit: ${g.clearance} mm per side, so ${(2 * g.clearance).toFixed(2)} mm across. If the first one is tight do not sand it — ` +
      'raise the clearance by 0.05 and reprint the lid only (Part → Lid). If it falls off, drop it by 0.05.');
  } else if (g.closure === 'threaded') {
    notes.push('No supports. The thread is trapezoidal with 45° flanks, so the underside of every crest is exactly at the angle the machine can bridge; a 60° V-thread printed here would sag at the root.');
    notes.push(`${g.th.turns.toFixed(1)} turns of ${g.th.pitch} mm pitch. Print the cap closed-face down. Give the first one a wipe with a file at the lead-in if it binds — a printed thread always has a burr on the first crest.`);
    notes.push('Slow the outer wall to about 30 mm/s. The thread is a small feature repeating every layer and the extruder needs time to hit the corners of it.');
  } else {
    notes.push(`Print it flat open, exactly as it comes out of here. No supports and no manual orientation — ` +
      'the whole point of the layout is that the hinge prints in place.');
    notes.push(`Hinge clearance is ${g.hg.fit} mm on the pin and ${g.hg.fit} mm between the knuckles. Work the hinge before the part is fully cool ` +
      'and it frees off with a thumb; leave it a day and the first movement takes a firm push.');
    notes.push(`${layerH} mm layers here rather than 0.2 — the pin is ${(g.hg.pinR * 2).toFixed(1)} mm across and prints on its side, so it wants a few more layers to come out round.`);
    if (g.hg.catch) notes.push('The catch is meant to be an interference fit — that is what makes it snap. It will feel stiff for the first half dozen openings.');
  }
  if (g.baseStyle === 'stack') notes.push(`Stacking spigot: the bottom ${g.stackH.toFixed(1)} mm is stepped in by ${g.stackInset.toFixed(2)} mm so the box drops into the mouth of another one. With lids on, the boxes sit flat and the spigot is just a foot.`);
  if (g.vents !== 'none') notes.push('The vents are arches, not round holes — an arch has no ceiling to bridge, so they come out clean without support.');
  if (g.label === 'lid') notes.push(`The label recess is on the face that lies on the plate, so its floor is bridged over ${g.labelH.toFixed(0)} mm. Its walls are drafted at 45° to shorten that span; expect the recess floor to look like a bridge, because it is one.`);
  if (g.mounts === 'magnets') notes.push('Magnet pockets open upward into the box, so there is nothing to bridge. Push the magnets in after the print and check the polarity before you glue.');
  if (g.mounts === 'screws') notes.push('The screw holes are countersunk from the inside with a 45° cone, so they need no support and take a flat head flush with the floor.');
  if (g.arrange === 'assembled') notes.push('This is the assembled view. Switch Show to Plate layout before slicing — assembled, the lid is upside down and hanging in mid-air.');
  if (g.part !== 'both' && g.closure !== 'hinged') notes.push(`Only the ${g.part} is being made. Switch Part back to "Box and lid" for the full plate.`);
  notes.push('PLA. PETG is tougher but this object is all thin vertical walls and a lid that has to fit, and PETG grows more than PLA does when it cools.');

  return {
    profile: `${layerH.toFixed(2)} mm standard`,
    layerH, perimeters: perim, infill: 12,
    supports: false, filament: 'PLA',
    notes,
  };
}

// ---------------------------------------------------------------------------

const params = [
  { key: 'sizeMode', label: 'Dimensions are', type: 'enum', def: 'inner', group: 'Size',
    help: 'Inner means the space you measured for whatever goes inside; the wall is added outside it. Outer means the footprint on the shelf.',
    options: [{ v: 'inner', label: 'Inner (usable space)' }, { v: 'outer', label: 'Outer (overall size)' }] },
  { key: 'width', label: 'Width', type: 'number', def: 90, min: 15, max: 176, step: 1, unit: 'mm', group: 'Size',
    help: 'Across the front. On a round tin this is the diameter and the depth is ignored.' },
  { key: 'depth', label: 'Depth', type: 'number', def: 60, min: 15, max: 176, step: 1, unit: 'mm', group: 'Size',
    help: 'Front to back.', showIf: (p) => p.plan !== 'round' && p.closure !== 'threaded' },
  { key: 'height', label: 'Height', type: 'number', def: 40, min: 8, max: 170, step: 1, unit: 'mm', group: 'Size',
    help: 'The box on its own, without the lid. On a clamshell it is one half, so the closed object is twice this.' },
  { key: 'plan', label: 'Plan', type: 'enum', def: 'rect', group: 'Size',
    help: 'A screw top forces round; a clamshell hinge forces rectangular.',
    options: [{ v: 'rect', label: 'Rectangular' }, { v: 'round', label: 'Round tin' }] },

  { key: 'wallT', label: 'Wall', type: 'number', def: 1.6, min: 0.4, max: 5, step: 0.4, unit: 'mm', group: 'Walls',
    help: 'Whole multiples of 0.4 mm print as solid beads with no gap-fill seam. 1.6 mm is four.' },
  { key: 'floorT', label: 'Floor', type: 'number', def: 1.6, min: 0.4, max: 6, step: 0.2, unit: 'mm', group: 'Walls',
    help: 'Set separately from the wall because the floor is what you drop things onto.' },
  { key: 'cornerStyle', label: 'Corners', type: 'enum', def: 'round', group: 'Walls',
    help: 'Chamfered corners print marginally faster and look sharper; rounded ones are kinder to hands.',
    options: [{ v: 'round', label: 'Rounded' }, { v: 'chamfer', label: 'Chamfered' }, { v: 'square', label: 'Square' }],
    showIf: (p) => p.plan !== 'round' && p.closure !== 'threaded' },
  { key: 'cornerR', label: 'Corner radius', type: 'number', def: 3, min: 0, max: 30, step: 0.5, unit: 'mm', group: 'Walls',
    help: 'Also the chamfer leg when corners are chamfered.',
    showIf: (p) => p.cornerStyle !== 'square' && p.plan !== 'round' && p.closure !== 'threaded' },
  { key: 'floorFillet', label: 'Inside floor radius', type: 'number', def: 1.5, min: 0, max: 15, step: 0.5, unit: 'mm', group: 'Walls',
    help: 'A radius where the floor meets the wall. Much stronger than a sharp corner, and small things stop wedging in it.' },

  { key: 'closure', label: 'Closure', type: 'enum', def: 'friction', group: 'Closure',
    help: 'How the lid stays on.',
    options: [
      { v: 'friction', label: 'Friction fit', help: 'An inner lip with a chamfered lead-in. The common one.' },
      { v: 'threaded', label: 'Screw top', help: 'A coarse trapezoidal thread. Round only.' },
      { v: 'hinged', label: 'Clamshell hinge', help: 'Prints in place, flat open, with a snap catch.' }] },
  { key: 'clearance', label: 'Clearance', type: 'number', def: FIT.slide, min: 0.05, max: 1, step: 0.05, unit: 'mm', group: 'Closure',
    help: 'Gap per side between lid and box. 0.2–0.3 is the usable range; under 0.15 the two fuse together on the plate.' },
  { key: 'lidT', label: 'Lid thickness', type: 'number', def: 1.6, min: 0.4, max: 6, step: 0.2, unit: 'mm', group: 'Closure',
    help: 'The flat part of the lid, or the top of the screw cap.' },
  { key: 'lipH', label: 'Lip length', type: 'number', def: 5, min: 1, max: 30, step: 0.5, unit: 'mm', group: 'Closure',
    help: 'How far the lid reaches into the box. Longer holds better and wastes more filament.',
    showIf: (p) => p.closure === 'friction' },
  { key: 'threadPitch', label: 'Thread pitch', type: 'number', def: 3, min: 1.5, max: 8, step: 0.5, unit: 'mm', group: 'Closure',
    help: 'Coarse threads print better and open faster. 3 mm is about a third of a turn per centimetre of travel.',
    showIf: (p) => p.closure === 'threaded' },
  { key: 'threadLen', label: 'Thread length', type: 'number', def: 8, min: 2, max: 40, step: 1, unit: 'mm', group: 'Closure',
    help: 'How much neck is threaded. Two or three turns is plenty.',
    showIf: (p) => p.closure === 'threaded' },
  { key: 'hingeR', label: 'Knuckle radius', type: 'number', def: 3, min: 1.2, max: 10, step: 0.2, unit: 'mm', group: 'Closure',
    help: 'The barrel of the hinge. Bigger is stronger and sticks out further behind the box.',
    showIf: (p) => p.closure === 'hinged' },
  { key: 'hingeCount', label: 'Knuckles', type: 'int', def: 5, min: 3, max: 15, step: 2, group: 'Closure',
    help: 'Always odd, so the two end knuckles belong to the box and the pin is supported at both ends.',
    showIf: (p) => p.closure === 'hinged' },
  { key: 'hingeFit', label: 'Hinge clearance', type: 'number', def: 0.4, min: 0.2, max: 0.8, step: 0.05, unit: 'mm', group: 'Closure',
    help: 'Pin to socket, and knuckle to knuckle. Never built below 0.35 mm whatever you type — under that it fuses solid on a 0.4 mm nozzle.',
    showIf: (p) => p.closure === 'hinged' },
  { key: 'catchOn', label: 'Snap catch', type: 'bool', def: true, group: 'Closure',
    help: 'A bead on the lid and a groove in the box front, so the clamshell stays shut.',
    showIf: (p) => p.closure === 'hinged' },

  { key: 'divX', label: 'Columns', type: 'int', def: 1, min: 1, max: 8, step: 1, group: 'Inside',
    help: 'Divider grid across the width. Rectangular plans only.' },
  { key: 'divY', label: 'Rows', type: 'int', def: 1, min: 1, max: 8, step: 1, group: 'Inside',
    help: 'Divider grid front to back.' },
  { key: 'divT', label: 'Divider wall', type: 'number', def: 1.2, min: 0.4, max: 4, step: 0.4, unit: 'mm', group: 'Inside',
    help: 'Dividers can be thinner than the outer wall — nothing pushes on them sideways.',
    showIf: (p) => p.divX > 1 || p.divY > 1 },
  { key: 'divColW', label: 'Column spans', type: 'text', def: '', maxLength: 64, group: 'Inside',
    help: 'Relative widths, e.g. "2,1,1" for one wide cell and two narrow. Blank means equal.',
    showIf: (p) => p.divX > 1 },
  { key: 'divRowW', label: 'Row spans', type: 'text', def: '', maxLength: 64, group: 'Inside',
    help: 'Relative depths, front to back. Blank means equal.',
    showIf: (p) => p.divY > 1 },

  { key: 'baseStyle', label: 'Base', type: 'enum', def: 'chamfer', group: 'Details',
    help: 'The chamfer hides the elephant\'s foot every first layer has. The spigot lets boxes stack into each other.',
    options: [{ v: 'flat', label: 'Flat' }, { v: 'chamfer', label: 'Chamfered edge' }, { v: 'stack', label: 'Stacking spigot' }] },
  { key: 'notch', label: 'Finger notch', type: 'bool', def: true, group: 'Details',
    help: 'A scallop in the front rim so a fingernail gets under the lid. Without it a well-fitted lid is genuinely hard to remove.' },
  { key: 'notchW', label: 'Notch width', type: 'number', def: 24, min: 6, max: 120, step: 1, unit: 'mm', group: 'Details',
    showIf: (p) => !!p.notch, help: 'Across the front rim.' },
  { key: 'notchD', label: 'Notch depth', type: 'number', def: 4, min: 1, max: 25, step: 0.5, unit: 'mm', group: 'Details',
    showIf: (p) => !!p.notch, help: 'How far below the rim the scallop reaches.' },
  { key: 'vents', label: 'Ventilation', type: 'enum', def: 'none', group: 'Details',
    help: 'Vertical arched slots. An arch has no ceiling, so they print without support.',
    options: [{ v: 'none', label: 'None' }, { v: 'sides', label: 'Front and back' }, { v: 'all', label: 'All four walls' }] },
  { key: 'ventCount', label: 'Slots per wall', type: 'int', def: 4, min: 1, max: 12, step: 1, group: 'Details',
    showIf: (p) => p.vents !== 'none', help: 'Reduced automatically if they will not fit between the corners.' },
  { key: 'label', label: 'Label recess', type: 'enum', def: 'none', group: 'Details',
    help: 'A drafted panel for a written or printed label.',
    options: [{ v: 'none', label: 'None' }, { v: 'front', label: 'Front wall' }, { v: 'lid', label: 'Lid top' }] },
  { key: 'labelW', label: 'Label width', type: 'number', def: 40, min: 6, max: 150, step: 1, unit: 'mm', group: 'Details',
    showIf: (p) => p.label !== 'none' },
  { key: 'labelH', label: 'Label height', type: 'number', def: 12, min: 4, max: 80, step: 1, unit: 'mm', group: 'Details',
    showIf: (p) => p.label !== 'none' },
  { key: 'labelDepth', label: 'Label depth', type: 'number', def: 0.8, min: 0.2, max: 3, step: 0.2, unit: 'mm', group: 'Details',
    showIf: (p) => p.label !== 'none', help: 'Four layers at 0.2 mm. Deep enough to feel, shallow enough not to weaken the wall.' },
  { key: 'mounts', label: 'Mounting', type: 'enum', def: 'none', group: 'Details',
    help: 'Screw the box down, or drop magnets into the floor.',
    options: [{ v: 'none', label: 'None' }, { v: 'screws', label: 'Countersunk screw holes' }, { v: 'magnets', label: 'Magnet pockets' }] },
  { key: 'mountDia', label: 'Hole / magnet diameter', type: 'number', def: 6, min: 2, max: 20, step: 0.5, unit: 'mm', group: 'Details',
    showIf: (p) => p.mounts !== 'none', help: 'Clearance diameter. 3.4 for an M3 screw; 6 for the usual little disc magnets.' },
  { key: 'magnetT', label: 'Magnet thickness', type: 'number', def: 2, min: 0.6, max: 8, step: 0.5, unit: 'mm', group: 'Details',
    showIf: (p) => p.mounts === 'magnets', help: 'The pocket is cut this deep, or as deep as the floor allows with 0.6 mm left underneath.' },

  { key: 'arrange', label: 'Show', type: 'enum', def: 'plate', group: 'Output',
    help: 'The plate layout is what prints. Assembled is for looking at.',
    options: [{ v: 'plate', label: 'Plate layout' }, { v: 'assembled', label: 'Assembled' }] },
  { key: 'part', label: 'Part', type: 'enum', def: 'both', group: 'Output',
    help: 'Reprint just the lid when the first one comes out tight. Ignored for the clamshell, which is one print.',
    options: [{ v: 'both', label: 'Box and lid' }, { v: 'box', label: 'Box only' }, { v: 'lid', label: 'Lid only' }] },
];

export default {
  id: 'boxlid',
  name: 'Box With A Lid',
  category: 'Storage',
  blurb: 'A box whose lid actually fits — friction, screw top or a hinge that prints in place.',
  description:
    'Give it the inner dimensions of whatever has to go inside and it does the arithmetic outwards. ' +
    'Three closures: a friction lip with a chamfered lead-in and an explicit clearance you can nudge by ' +
    '0.05 mm and reprint the lid alone; a coarse trapezoidal screw thread whose flanks are all at 45° so ' +
    'nothing in it needs support; and a clamshell hinge that prints flat open in one piece, with alternating ' +
    'knuckles, a continuous pin and a snap catch. The body carries the things a real box needs — a whole ' +
    'number of 0.4 mm extrusions in the wall, a separate floor, rounded or chamfered corners, a radius on ' +
    'the inside floor, a stacking spigot, a divider grid with per-cell spans, a finger notch, arched vents, ' +
    'a label recess and countersunk screw or magnet mountings — and it lays the box and the lid out side by ' +
    'side on one plate so both print in a single go.',
  icon: null,
  version: 1,
  params,
  presets: [
    { name: 'Bolt tin', values: {
      sizeMode: 'inner', width: 80, depth: 80, height: 30, plan: 'rect', closure: 'friction',
      wallT: 1.6, floorT: 1.6, cornerR: 2, floorFillet: 1.5, clearance: 0.25, lipH: 4,
      divX: 3, divY: 3, divT: 1.2, baseStyle: 'stack', notch: true, notchW: 20, notchD: 3,
      label: 'front', labelW: 44, labelH: 12, arrange: 'plate' } },
    { name: 'Screw-top pill jar', values: {
      sizeMode: 'inner', width: 34, height: 46, plan: 'round', closure: 'threaded',
      wallT: 1.6, floorT: 1.6, lidT: 2, threadPitch: 3, threadLen: 9, clearance: 0.3,
      floorFillet: 2, baseStyle: 'chamfer', notch: false, arrange: 'plate' } },
    { name: 'Pocket clamshell for earbuds', values: {
      sizeMode: 'inner', width: 62, depth: 46, height: 14, plan: 'rect', closure: 'hinged',
      wallT: 1.6, floorT: 1.2, lidT: 1.2, cornerR: 6, floorFillet: 2,
      hingeR: 2.6, hingeCount: 5, hingeFit: 0.4, catchOn: true,
      baseStyle: 'chamfer', notch: true, notchW: 18, notchD: 3, arrange: 'plate' } },
    { name: 'SD card case', values: {
      sizeMode: 'inner', width: 68, depth: 34, height: 10, plan: 'rect', closure: 'hinged',
      wallT: 1.2, floorT: 1.2, lidT: 1.2, cornerR: 3, floorFillet: 0.8,
      divX: 4, divY: 1, divT: 1.2, hingeR: 2, hingeCount: 5, hingeFit: 0.4, catchOn: true,
      baseStyle: 'flat', notch: false, arrange: 'plate' } },
    { name: 'Vented seed tin', values: {
      sizeMode: 'outer', width: 96, depth: 64, height: 46, plan: 'rect', closure: 'friction',
      wallT: 1.6, floorT: 2, cornerStyle: 'chamfer', cornerR: 4, floorFillet: 2,
      clearance: 0.25, lipH: 6, vents: 'all', ventCount: 5, notch: true,
      baseStyle: 'chamfer', label: 'front', labelW: 46, labelH: 14, arrange: 'plate' } },
    { name: 'Screwed-down desk tray', values: {
      sizeMode: 'inner', width: 120, depth: 70, height: 24, plan: 'rect', closure: 'friction',
      wallT: 2, floorT: 2.4, cornerR: 4, floorFillet: 2.5, clearance: 0.3, lipH: 5,
      divX: 2, divY: 2, divColW: '2,1', divT: 1.6, mounts: 'screws', mountDia: 3.4,
      baseStyle: 'flat', notch: true, notchW: 30, notchD: 5, arrange: 'plate' } },
    { name: 'Magnet-backed fixings box', values: {
      sizeMode: 'inner', width: 70, depth: 50, height: 26, plan: 'rect', closure: 'friction',
      wallT: 1.6, floorT: 3.2, cornerR: 3, floorFillet: 1.5, clearance: 0.25, lipH: 5,
      mounts: 'magnets', mountDia: 8, magnetT: 2, divX: 2, divY: 1,
      baseStyle: 'flat', notch: true, label: 'lid', labelW: 34, labelH: 12, arrange: 'plate' } },
  ],
  build,
  validate,
  hints,
};

export { solve, cornerRing, threadProfile, hingeSlots, teardropRing };
