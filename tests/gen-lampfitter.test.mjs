// gen lampfitter — the two parts that make a printed shade fit.
//
// The gauge's whole job is to report a diameter honestly, so every bore here is
// measured off the mesh rather than read back out of the parameters. The tick
// marks are measured too: a gauge you cannot read is a bag of identical rings.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, BED } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { extrude } from '../js/kernel/builders.js';
import gen, { settings, ladder, collarShape, gaugeParts, spiderShape, E27 } from '../js/gen/lampfitter.js';

suite('gen lampfitter');

const c = ctx('normal');
const NUDGE = 0.137;   // off every symmetry axis in every part here
const BASE = defaults(gen);
const build = (over = {}) => gen.build({ ...BASE, ...over }, c);
const set = (over = {}) => settings({ ...BASE, ...over }, c);

conformance(gen, 'lampfitter');

// ---------------------------------------------------------------------------
// Sampling, with no help from the generator's own arithmetic.
// ---------------------------------------------------------------------------

/** Solid spans along a line, as [from, to] pairs, by even–odd crossing count. */
function spans(mesh, o, d, from, to, n = 4000) {
  const inside = sampler(mesh);
  const out = [];
  let open = null;
  for (let i = 0; i <= n; i++) {
    const t = from + (to - from) * i / n;
    const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    if (inside(p)) { if (open === null) open = t; }
    else if (open !== null) { out.push([open, t]); open = null; }
  }
  if (open !== null) out.push([open, to]);
  return out;
}

/** Point-in-solid by counting crossings of a vertical ray. Slow, obvious, and
 *  not the code that built the mesh.
 *
 *  Sample OFF the symmetry axes. A circle with an even segment count puts
 *  vertices exactly on y = 0, the barycentric test counts a shared edge for both
 *  of its triangles, and the parity flips where it should not — a line down the
 *  middle of one collar came back as eighty-one solid spans. NUDGE is a number
 *  with no relationship to any feature in these parts. */
function sampler(mesh) {
  const p = mesh.positions, T = mesh.tris;
  const zTop = mesh.bbox().max[2] + 10;
  return (pt) => {
    let n = 0;
    for (let t = 0; t < mesh.triCount; t++) {
      const ia = T[t * 3] * 3, ib = T[t * 3 + 1] * 3, ic = T[t * 3 + 2] * 3;
      const ax = p[ia], ay = p[ia + 1], bx = p[ib], by = p[ib + 1], cx = p[ic], cy = p[ic + 1];
      // Barycentric in XY, then check the triangle is above the point.
      const d0 = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d0) < 1e-12) continue;
      const l1 = ((by - cy) * (pt[0] - cx) + (cx - bx) * (pt[1] - cy)) / d0;
      const l2 = ((cy - ay) * (pt[0] - cx) + (ax - cx) * (pt[1] - cy)) / d0;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const z = l1 * p[ia + 2] + l2 * p[ib + 2] + l3 * p[ic + 2];
      if (z > pt[2] && z < zTop) n++;
    }
    return (n & 1) === 1;
  };
}

function oneCollar(s, d, ticks) {
  return extrude(collarShape(s, d, ticks), s.depth).place();
}

// ---------------------------------------------------------------------------
// The published E27 figures this is all built on.
// ---------------------------------------------------------------------------

console.log('\n-- the numbers --');
near('the shade-ring thread is the published Ø 40 mm', E27.thread, 40, 0);
near('with the published 2.5 mm lead', E27.lead, 2.5, 0);
near('a thermoplastic shade ring is 54 mm across', E27.ringOuter, 54, 0);
check('the gauge default range straddles that 40 mm',
  set().dMin < E27.thread && set().dMax > E27.thread, `${set().dMin}–${set().dMax} mm`);
check('the spider default bore is the thread plus slip, not the thread',
  set({ kind: 'spider' }).bore > E27.thread, `${set({ kind: 'spider' }).bore} mm`);

// ---------------------------------------------------------------------------
// The ladder.
// ---------------------------------------------------------------------------

console.log('\n-- the ladder --');
{
  const s = set({ dMin: 39, dMax: 44, dStep: 1 });
  const ds = ladder(s);
  check('a 39 to 44 range in 1 mm steps is six collars', ds.length === 6, ds.join(' '));
  near('starting exactly at the smallest', ds[0], 39, 1e-9);
  near('and ending exactly at the largest', ds[ds.length - 1], 44, 1e-9);
  const half = ladder(set({ dMin: 40, dMax: 42, dStep: 0.5 }));
  check('half-millimetre steps give five', half.length === 5, half.join(' '));
  const odd = ladder(set({ dMin: 39, dMax: 44, dStep: 0.7 }));
  check('a step that does not divide the range still lands on the bottom',
    Math.abs(odd[0] - 39) < 1e-9, odd.join(' '));
}

// ---------------------------------------------------------------------------
// A collar, measured.
// ---------------------------------------------------------------------------

console.log('\n-- one collar --');
{
  const s = set();
  for (const d of [39, 41.5, 44]) {
    const m = oneCollar(s, d, 3);
    const t = topology(m);
    check(`a ${d} mm collar is a watertight solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary} nonman ${t.nonManifold} vol ${m.volume().toFixed(0)}`);
    // The bore: a horizontal line through the collar's centre crosses wall,
    // bore, wall. The middle gap is the hole, and it is the number the whole
    // part exists to report.
    const b = m.bbox();
    // The collar's centre sits one outer radius in from the left edge.
    const rO = d / 2 + s.collarWall;
    const cx = b.min[0] + rO, cy = b.center[1] + NUDGE;
    const sp = spans(m, [b.min[0] - 1, cy, s.depth / 2 + NUDGE], [1, 0, 0], 0, b.size[0] + 2, 3000);
    check(`a ${d} mm collar reads as wall, bore, wall along its middle`, sp.length >= 2, `${sp.length} solid spans`);
    if (sp.length >= 2) {
      const bore = sp[1][0] - sp[0][1];
      nearPct(`and the bore measures ${d} mm`, bore, d, 1.2);
      nearPct('with the wall it was given', sp[0][1] - sp[0][0], s.collarWall, 15);
    }
    void cx;
  }
  // The keyring hole is there and it is round.
  const m = oneCollar(s, 41, 1);
  const b = m.bbox();
  const sp = spans(m, [b.min[0] - 1, b.center[1] + NUDGE, s.depth / 2 + NUDGE], [1, 0, 0], 0, b.size[0] + 2, 4000);
  check('and there is a keyring hole out at the end of the tab', sp.length === 3, `${sp.length} spans`);
  if (sp.length === 3) nearPct('about 4 mm across', sp[2][0] - sp[1][1], 4.2, 20);
}

// ---------------------------------------------------------------------------
// The ticks, which are the difference between a gauge and a bag of rings.
// ---------------------------------------------------------------------------

console.log('\n-- reading the gauge --');
{
  const s = set();
  for (const n of [1, 2, 5, 6]) {
    const m = oneCollar(s, 42, n);
    const b = m.bbox();
    // Run along just inside each long edge of the tab and count the gaps the
    // notches leave. Ticks alternate sides, so the counts split evenly.
    let found = 0;
    for (const side of [1, -1]) {
      const y = b.center[1] + side * (10 / 2 - 0.6) + side * 0.011;
      const sp = spans(m, [b.min[0] - 1, y, s.depth / 2 + NUDGE], [1, 0, 0], 0, b.size[0] + 2, 6000);
      // The line crosses the collar's far wall, then the tab broken into
      // (notches + 1) pieces — and the first of those is fused to the near wall,
      // so the notch count on this side is (spans − 2).
      found += Math.max(0, sp.length - 2);
    }
    check(`a collar marked with ${n} tick${n === 1 ? '' : 's'} reads back as ${n}`,
      found === n, `counted ${found}`);
  }
  // Counting ticks on a collar I handed the number to only proves the notches
  // get cut. What matters is that the collar the LADDER builds carries the
  // number that collar deserves, so count them on those instead — otherwise
  // giving every collar three ticks passes the measurement and fails the user.
  const parts = gaugeParts(set());
  const countTicks = (mesh) => {
    const b = mesh.bbox();
    let n = 0;
    for (const side of [1, -1]) {
      const y = b.center[1] + side * (10 / 2 - 0.6) + side * 0.011;
      n += Math.max(0, spans(mesh, [b.min[0] - 1, y, s.depth / 2 + NUDGE], [1, 0, 0], 0, b.size[0] + 2, 6000).length - 2);
    }
    return n;
  };
  const read = parts.map(p => countTicks(extrude(p.shape, s.depth).place()));
  check('every collar the ladder builds is marked with its own position',
    read.every((n, i) => n === i + 1), `read back ${read.join(',')} from ${parts.map(p => p.d).join(',')} mm`);
  check('the ticks count up with the diameter, one for the smallest',
    parts.every((p, i) => p.ticks === i + 1), parts.map(p => p.ticks).join(','));
  check('so the widest collar carries as many ticks as there are collars',
    parts[parts.length - 1].ticks === parts.length, `${parts.length}`);
}

// ---------------------------------------------------------------------------
// The whole gauge on the plate.
// ---------------------------------------------------------------------------

console.log('\n-- the gauge on the plate --');
{
  const r = build();
  const s = set();
  check('one part per collar', r.parts.length === ladder(s).length, `${r.parts.length} parts`);
  check('every part is named for its diameter',
    r.parts.every(p => /^\d+(\.\d)? mm$/.test(p.name)), r.parts.map(p => p.name).join(' '));
  let solid = true, fit = true;
  for (const p of r.parts) {
    const t = topology(p.mesh);
    if (t.boundary || t.nonManifold || t.inconsistent || !(p.mesh.volume() > 0)) solid = false;
    const sz = p.mesh.bbox().size;
    if (sz[0] > BED.x || sz[1] > BED.y || sz[2] > BED.z) fit = false;
  }
  check('every collar is watertight on its own', solid);
  check('and every one fits the bed', fit);
  check('the default set is one plate-load, not two', r.meta.plate.plates === 1, `${r.meta.plate.plates} plates`);
  check('and it says the parts are packed rather than guessed', r.meta.plate.packed === true);
  const b = r.mesh.bbox();
  check('the default plate fits the bed', b.size[0] <= BED.x && b.size[1] <= BED.y,
    b.size.map(v => v.toFixed(0)).join('×'));

  const wide = build({ dMin: 20, dMax: 46, dStep: 2 });
  check('a range too wide for one bed becomes several plates',
    wide.meta.plate.plates > 1, `${wide.meta.plate.plates} plates for ${wide.parts.length} collars`);
}

// ---------------------------------------------------------------------------
// The spider.
// ---------------------------------------------------------------------------

console.log('\n-- the spider --');
{
  for (const arms of [2, 3, 4, 6, 8]) {
    const over = { kind: 'spider', arms, armW: 8, outer: 140, bore: 41, hub: 9, rim: 6, thick: 3 };
    const m = build(over).mesh;
    const s = set(over);
    const g = spiderShape(s);
    const t = topology(m);
    check(`a ${arms}-arm spider is a watertight solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary} nonman ${t.nonManifold}`);
    // Walk a circle between the hub and the rim, counting solid runs. That is
    // the arm count, measured, and it is what stops a "spider" quietly coming
    // out as a solid disc.
    const rMid = (g.rHub + g.rRim) / 2;
    const inside = sampler(m);
    const N = 720;
    let runs = 0, was = false;
    const seq = [];
    for (let i = 0; i <= N; i++) {
      const a = Math.PI * 2 * i / N;
      const hit = inside([rMid * Math.cos(a), rMid * Math.sin(a), s.thick / 2 + NUDGE]);
      seq.push(hit);
      if (hit && !was) runs++;
      was = hit;
    }
    if (seq[0] && seq[N - 1]) runs = Math.max(1, runs - 1);   // the run that wraps
    check(`and it really has ${arms} arms between the hub and the rim`, runs === arms, `counted ${runs}`);
  }
  const s = set({ kind: 'spider' });
  const m = build({ kind: 'spider' }).mesh;
  const b = m.bbox();
  nearPct('the spider is the outside diameter it says', b.size[0], s.outer, 1);
  near('and as thick as it says', b.size[2], s.thick, 1e-6);
  const sp = spans(m, [-b.size[0] / 2 - 1, NUDGE, s.thick / 2 + NUDGE], [1, 0, 0], 0, b.size[0] + 2, 4000);
  check('a line through the middle crosses rim, arm, hub, bore, hub, arm, rim',
    sp.length >= 2, `${sp.length} spans`);
  // The bore is the gap that straddles the axis, not the whole middle of the
  // part: between the hub and the rim the same line also crosses arms and the
  // spaces between them, and taking first-to-last measured 75 mm of spider
  // rather than 41 mm of hole.
  const tAxis = b.size[0] / 2 + 1;
  let bore = null;
  for (let i = 0; i + 1 < sp.length; i++) {
    if (sp[i][1] <= tAxis && sp[i + 1][0] >= tAxis) { bore = sp[i + 1][0] - sp[i][1]; break; }
  }
  check('the axis really does fall in a hole', bore !== null);
  if (bore !== null) nearPct('and the bore measures what was asked for', bore, s.bore, 1.5);
  const g = spiderShape(s);
  check('the hub reaches far enough for a 54 mm shade ring to clamp it',
    g.rHub >= E27.ringOuter / 2, `hub to ${g.rHub.toFixed(1)} mm, ring to ${(E27.ringOuter / 2).toFixed(1)} mm`);
}

// ---------------------------------------------------------------------------
// validate and hints.
// ---------------------------------------------------------------------------

console.log('\n-- validate --');
const fires = (over, param, sev) => gen.validate({ ...BASE, ...over }, c)
  .some(v => v.param === param && (!sev || v.severity === sev));
check('the defaults raise nothing', gen.validate(BASE, c).length === 0,
  gen.validate(BASE, c).map(v => `${v.severity}:${v.param}`).join(' '));
check('a range that misses the E27 thread is flagged', fires({ dMin: 50, dMax: 60 }, 'dMin', 'warn'));
check('a step too coarse to see the printer error is flagged', fires({ dStep: 2 }, 'dStep', 'info'));
check('a collar too short to tell grip from rattle is flagged', fires({ depth: 4 }, 'depth', 'warn'));
check('a collar wall thin enough to flex is flagged', fires({ collarWall: 1.2 }, 'collarWall', 'warn'));
check('a collar wider than the bed is an error, on a bed it can overflow',
  gen.validate({ ...BASE, dMin: 99, dMax: 100 }, ctx('normal', { bed: { x: 100, y: 100, z: 100 } }))
    .some(v => v.param === 'dMax' && v.severity === 'error'));
check('and the same collar is fine on the 180 mm bed',
  !fires({ dMin: 99, dMax: 100 }, 'dMax', 'error'));
check('a spider wider than the bed is an error', fires({ kind: 'spider', outer: 220 }, 'outer', 'error'));
check('arms so wide they close the gaps are flagged',
  fires({ kind: 'spider', arms: 8, armW: 30 }, 'armW', 'warn'));
check('a spider too thin to carry a shade is flagged', fires({ kind: 'spider', thick: 1.4 }, 'thick', 'warn'));
check('a hub too small for a shade ring to clamp is flagged',
  fires({ kind: 'spider', hub: 4 }, 'hub', 'warn'));
check('no preset raises an error',
  gen.presets.every(pr => !gen.validate({ ...BASE, ...pr.values }, c).some(v => v.severity === 'error')),
  gen.presets.filter(pr => gen.validate({ ...BASE, ...pr.values }, c).some(v => v.severity === 'error')).map(p => p.name).join(', ') || 'all clean');

console.log('\n-- hints --');
{
  const h = gen.hints(BASE, c);
  const text = h.notes.join(' ');
  check('it says to print the gauge on the same settings as the shade',
    /same nozzle, same layer height/.test(text));
  check('it explains that a printed hole comes out undersize', /undersize/.test(text));
  check('it says how to read the ticks', /[Tt]icks read/.test(text));
  check('it tells you what to do with the answer', /Bore/.test(text));
  check('no supports on a flat plate with holes in it', h.supports === false);

  const sp = gen.hints({ ...BASE, kind: 'spider' }, c);
  const spText = sp.notes.join(' ');
  check('the spider is told to be printed solid, because it carries the shade',
    /perimeters/.test(spText) && /infill/.test(spText));
  check('and glued in square, because there is no adjusting it after',
    /square/.test(spText) && /crooked/.test(spText));
  check('and it admits the 40 mm is published, not measured',
    /not a measurement of yours/.test(spText));
  check('and it says the gaps are the ventilation', /ventilation/.test(spText));
  check('PETG for the part that holds the lamp up', sp.filament === 'PETG', sp.filament);
}

done();
