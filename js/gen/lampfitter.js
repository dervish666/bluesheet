// lampfitter — the two small parts a printed shade needs and the shade itself
// cannot be.
//
// WHY A GAUGE COMES FIRST
// `lampshade` defaults its bore to 41 mm, which is the published Ø 40 mm
// European E27 shade-ring thread plus a millimetre of slip. Published is not
// measured, and there are two unknowns stacked on top of each other: what your
// holder actually is, and what your printer does to a vertical hole. A 0.4 mm
// nozzle laying a circle leaves it undersize by two or three tenths, and every
// machine is different. Six hours of filament is a bad way to find that out.
//
// So: a rack of collars half a millimetre apart, twenty minutes on the bed. Push
// it on, find the one that grips, count the ticks, type that number into the
// shade. The gauge measures the holder and the printer at the same time, which
// is the only honest way round — a hole that says 41 in the model and 40.7 on
// the plate is the number that matters, and no amount of caliper work on the
// holder alone will tell you it.
//
// AND A SPIDER, FOR THE SHADES THAT CANNOT CARRY A FLANGE
// A drum shade has a top opening as wide as its mouth, and closing that with a
// solid flange would block every bit of light going up and trap the heat under
// it. The answer a hundred years of lampshades already found is a spider: a hub
// on the holder, a few arms, a rim glued into the shade. It is a flat part, it
// prints in one go with no support, and it is the reason `lampshade` offers a
// fitting of "none" at all.
//
// Both parts are a 2D outline cut with poly2d and extruded once. No booleans in
// three dimensions, no CSG, nothing that can fail on a coplanar face — which is
// this project's doctrine and, for a part this simple, also the short way.

import { Mesh, TAU } from '../kernel/mesh.js';
import { extrude } from '../kernel/builders.js';
import { pack, layout as packLayout, anyOverlap, withinBed } from '../kernel/pack.js';
import { boolean, circle, rect, arcRing, roundRect } from '../kernel/poly2d.js';
import { clamp, num, DEG } from '../kernel/scalar.js';

const BED = { x: 180, y: 180, z: 180 };

// The published European E27 figures, from the manufacturer's own product pages
// (lampholders.eu, thermoplastic and thermoset E27/E26 shade rings, read
// 2026-09-20). Everything here is built around them and nothing here has been
// measured on a holder in this house.
const E27 = Object.freeze({
  thread: 40,       // mm, the diameter the shade ring screws onto
  lead: 2.5,        // mm
  ringHeight: 14,   // mm of thread on a real shade ring
  ringOuter: 54,    // mm external, thermoplastic (58 in thermoset)
});

const KINDS = ['gauge', 'spider'];

function settings(p, ctx = {}) {
  p = p || {};
  const segFactor = clamp(num(ctx.segFactor, 1), 0.25, 4);
  const nozzle = clamp(num(ctx.nozzle, 0.4), 0.15, 1.2);
  const kind = KINDS.includes(p.kind) ? p.kind : 'gauge';

  const dMin = clamp(num(p.dMin, 39), 10, 120);
  const dMax = Math.max(dMin + 0.5, clamp(num(p.dMax, 44), 10.5, 140));
  const dStep = clamp(num(p.dStep, 1), 0.1, 5);
  const steps = clamp(Math.round((dMax - dMin) / dStep) + 1, 2, 14);

  const bore = clamp(num(p.bore, 41), 16, 90);
  const outer = clamp(num(p.outer, 120), 40, 300);

  return {
    kind, segFactor, nozzle,
    dMin, dMax, dStep, steps,
    collarWall: clamp(num(p.collarWall, 2.4), 1, 6),
    depth: clamp(num(p.depth, 10), 3, 30),
    bore,
    hub: clamp(num(p.hub, 8), 3, 30),
    outer,
    arms: clamp(Math.round(num(p.arms, 3)), 2, 8),
    armW: clamp(num(p.armW, 9), 3, 40),
    rim: clamp(num(p.rim, 5), 1.5, 25),
    thick: clamp(num(p.thick, 3), 1.2, 10),
    bed: ctx.bed && Number.isFinite(ctx.bed.x) ? ctx.bed : BED,
  };
}

/** The collar diameters the gauge offers, smallest first. */
function ladder(s) {
  const out = [];
  for (let i = 0; i < s.steps; i++) out.push(s.dMin + i * s.dStep);
  return out;
}

const segs = (s, r) => clamp(Math.round(Math.max(28, r * 3) * s.segFactor), 16, 256);

// ---------------------------------------------------------------------------
// The gauge: one collar per diameter, each notched so you can read it, each
// with a tab and a hole so the set lives on a split ring like a drill gauge.
//
// It was a connected rack first. A rack means circles joined to a bar, the
// circles meet the bar almost tangentially, and the 2D union leaves a cusp at
// every one of those meetings that the ear-clipping triangulator cannot close —
// twenty-eight boundary edges before a single tick mark had been cut. Separate
// collars have no such junction: a circle, a tab overlapping it by four
// millimetres, one bore and one keyring hole. Nothing to fail on.
//
// And the loose set is the better object anyway. You try them one at a time
// against the holder, and the one that fits goes in a drawer with the spare
// bulbs rather than staying attached to eight collars you will never need.
// ---------------------------------------------------------------------------

const TAB_L = 15, TAB_W = 10, TAB_HOLE = 4.2, TAB_BITE = 4;

function collarShape(s, d, ticks) {
  const rO = d / 2 + s.collarWall;
  // The tab reaches back INTO the collar by TAB_BITE, so the union is a proper
  // overlap rather than a kiss and there is no cusp where they meet.
  const tabCx = rO - TAB_BITE + TAB_L / 2;
  let shape = boolean(
    circle(rO, { segs: segs(s, rO) }),
    roundRect(TAB_L, TAB_W, Math.min(3, TAB_W / 2 - 0.5), { segs: 8, cx: tabCx, cy: 0 }),
    'union');
  shape = boolean(shape, circle(d / 2, { segs: segs(s, d / 2) }), 'difference');
  // The keyring hole, at the far end of the tab.
  const holeCx = rO - TAB_BITE + TAB_L - TAB_HOLE / 2 - 2;
  shape = boolean(shape, circle(TAB_HOLE / 2, { segs: 20, cx: holeCx, cy: 0 }), 'difference');
  // Ticks: notches cut into the tab's long edges, so they are concavities in
  // the outline and never interior holes. Half above, half below, which keeps
  // the tab symmetric and readable either way up.
  const tw = 1.8, gap = 1.6, depth = 2.0;
  const firstX = rO - TAB_BITE + 2.5;
  for (let k = 0; k < ticks; k++) {
    const side = k % 2 === 0 ? 1 : -1;
    const n = Math.floor(k / 2);
    const x = firstX + tw / 2 + n * (tw + gap);
    shape = boolean(shape, rect(tw, depth * 2, { cx: x, cy: side * TAB_W / 2 }), 'difference');
  }
  return shape;
}

function gaugeParts(s) {
  const ds = ladder(s);
  return ds.map((d, i) => ({ d, ticks: i + 1, shape: collarShape(s, d, i + 1) }));
}

// ---------------------------------------------------------------------------
// The spider: hub, arms, rim. Cut as the gaps between the arms rather than
// drawn as the arms themselves, so the three pieces are one outline and the
// part cannot come out as four solids that happen to touch.
// ---------------------------------------------------------------------------

function spiderShape(s) {
  const rB = s.bore / 2;
  const rHub = rB + s.hub;
  const rOut = Math.max(rHub + s.rim + 4, s.outer / 2);
  const rRim = rOut - s.rim;
  let shape = boolean(
    circle(rOut, { segs: segs(s, rOut) }),
    circle(rB, { segs: segs(s, rB) }), 'difference');

  // One gap per arm. The arm subtends armW at the hub, which is where it is
  // narrowest and where it would break.
  const halfArm = Math.min(Math.asin(clamp(s.armW / (2 * rHub), 0, 0.98)), Math.PI / s.arms - 0.06);
  for (let k = 0; k < s.arms; k++) {
    const mid = TAU * k / s.arms + Math.PI / s.arms;
    const from = mid - (Math.PI / s.arms - halfArm);
    const to = mid + (Math.PI / s.arms - halfArm);
    if (to - from < 0.02) continue;
    shape = boolean(shape, arcRing(rRim, rHub, from, to, { segs: clamp(Math.round(40 * s.segFactor), 10, 160) }), 'difference');
  }
  return { shape, rB, rHub, rOut, rRim };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const s = settings(p, ctx);
  if (s.kind === 'gauge') {
    const cs = gaugeParts(s);
    const meshes = cs.map(c => extrude(c.shape, s.depth).centerXY().dropToPlate());
    // A collar with its tab is about 60 mm across, so six is a bedful. Widen the
    // range and it becomes two prints, which is worth showing as two beds rather
    // than as one impossible half-metre row.
    const byId = {};
    meshes.forEach((m, i) => { byId[`c${i}`] = m; });
    let queue = meshes.map((m, i) => { const b = m.bbox(); return { id: `c${i}`, w: b.size[0], d: b.size[1] }; });
    const plates = [];
    let guard = 0;
    while (queue.length && guard++ < 20) {
      let pk = null;
      try { pk = pack(queue, s.bed, { gap: 3 }); } catch { pk = null; }
      if (!pk || !pk.placed.length) break;
      plates.push(pk);
      const done = new Set(pk.placed.map(x => x.id));
      queue = queue.filter(it => !done.has(it.id));
    }
    let placed = [];
    if (plates.length && !queue.length) {
      const cols = Math.min(plates.length, 3), stepX = s.bed.x + 20, stepY = s.bed.y + 20;
      plates.forEach((pk, pi) => {
        const ox = (pi % cols) * stepX - (cols - 1) * stepX / 2;
        const oy = -Math.floor(pi / cols) * stepY;
        for (const pp of packLayout(byId, pk).parts) {
          const i = Number(pp.id.slice(1));
          placed.push({ name: `${cs[i].d.toFixed(1)} mm`, mesh: pp.mesh.translate(ox, oy, 0), i });
        }
      });
    } else {
      let x = 0;
      placed = meshes.map((m, i) => {
        const b = m.bbox();
        const q = { name: `${cs[i].d.toFixed(1)} mm`, mesh: m.translate(x + b.size[0] / 2, 0, 0), i };
        x += b.size[0] + 3;
        return q;
      });
    }
    const merged = Mesh.merge(placed.map(q => q.mesh));
    const b = merged.bbox();
    const off = [-b.center[0], -b.center[1], -b.min[2]];
    const parts = placed.map(q => ({ name: q.name, mesh: q.mesh.translate(off[0], off[1], off[2]), i: q.i }));
    return {
      mesh: merged.translate(off[0], off[1], off[2]),
      parts: parts.map(q => ({ name: q.name, mesh: q.mesh })),
      meta: {
        kind: 'gauge', collars: cs.map(c => c.d),
        plate: { packed: plates.length > 0 && queue.length === 0, plates: plates.length,
          overlap: plates.some(pk => !!anyOverlap(pk)),
          fitsBed: plates.length === 1 && withinBed(plates[0], s.bed),
          parts: parts.map(q => { const pb = q.mesh.bbox(); return { name: q.name, x: pb.center[0], y: pb.center[1], w: pb.size[0], d: pb.size[1] }; }) },
        dims: gaugeDims(s, cs, parts),
      },
    };
  }
  const g = spiderShape(s);
  const mesh = extrude(g.shape, s.thick).place();
  return { mesh, parts: [{ name: 'Spider', mesh }], meta: { kind: 'spider', dims: spiderDims(s, g, mesh) } };
}

function gaugeDims(s, cs, parts) {
  const find = (i) => parts.find(q => q.i === i);
  const out = [];
  const first = find(0), last = find(cs.length - 1);
  if (first) {
    const b = first.mesh.bbox();
    // The collar's centre is not the part's bbox centre — the tab hangs off one
    // side — but the bore's LEFT edge is the part's left edge, so the bore reads
    // from there.
    const x0 = b.min[0], y = b.center[1];
    out.push({ param: 'dMin', label: 'Ø', from: [x0, y, s.depth], to: [x0 + cs[0].d, y, s.depth], offset: [0, 6, 0] });
    out.push({ param: 'depth', from: [x0, b.min[1], 0], to: [x0, b.min[1], s.depth], offset: [-5, 0, 0] });
    out.push({ param: 'collarWall', from: [x0 - s.collarWall, y, s.depth], to: [x0, y, s.depth], offset: [0, -5, 0] });
  }
  if (last && last !== first) {
    const b = last.mesh.bbox();
    out.push({ param: 'dMax', label: 'Ø', from: [b.min[0], b.center[1], s.depth],
      to: [b.min[0] + cs[cs.length - 1].d, b.center[1], s.depth], offset: [0, 6, 0] });
  }
  out.push({ param: 'dStep', label: 'step', value: s.dStep, unit: 'mm',
    from: [0, 0, s.depth], to: [Math.max(2, s.dStep * 4), 0, s.depth], offset: [0, 0, 8] });
  return out;
}

function spiderDims(s, g) {
  const P = (x, y, z) => [x, y, z];
  const a = 30 * DEG;
  return [
    { param: 'bore', label: 'Ø', from: P(-g.rB, 0, s.thick), to: P(g.rB, 0, s.thick), offset: [0, 0, 6] },
    { param: 'outer', label: 'Ø', from: P(-g.rOut, 0, 0), to: P(g.rOut, 0, 0), offset: [0, 0, -6] },
    { param: 'hub', from: P(g.rB * Math.cos(a), g.rB * Math.sin(a), s.thick),
      to: P(g.rHub * Math.cos(a), g.rHub * Math.sin(a), s.thick), offset: [0, 0, 5] },
    { param: 'rim', from: P(g.rRim, 0, s.thick), to: P(g.rOut, 0, s.thick), offset: [0, 4, 0] },
    { param: 'thick', from: P(g.rOut, 0, 0), to: P(g.rOut, 0, s.thick), offset: [5, 0, 0] },
    { param: 'arms', label: 'arms', value: s.arms, unit: '',
      from: P(g.rHub, 0, s.thick), to: P(g.rHub * Math.cos(TAU / s.arms), g.rHub * Math.sin(TAU / s.arms), s.thick),
      offset: [0, 0, 7] },
  ];
}


// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function validate(p, ctx = {}) {
  const s = settings(p, ctx);
  const out = [];
  if (s.kind === 'gauge') {
    const ds = ladder(s);
    const cell = ds[ds.length - 1] + 2 * s.collarWall + TAB_L - TAB_BITE;
    const perBed = Math.max(1, Math.floor(s.bed.x / (cell + 3)) * Math.floor(s.bed.y / (ds[ds.length - 1] + 2 * s.collarWall + 3)));
    if (cell > s.bed.x) {
      out.push({ param: 'dMax', severity: 'error',
        message: `a ${s.dMax} mm collar with its tab is ${cell.toFixed(0)} mm across and the bed is ${s.bed.x} mm` });
    } else if (ds.length > perBed) {
      out.push({ param: 'dStep', severity: 'info',
        message: `${ds.length} collars will not go on one ${s.bed.x} × ${s.bed.y} mm bed — about ${perBed} fit at a time. Widen the step, or narrow the range to the millimetre or two you actually doubt` });
    }
    if (s.dMin > E27.thread || s.dMax < E27.thread) {
      out.push({ param: s.dMin > E27.thread ? 'dMin' : 'dMax', severity: 'warn',
        message: `the range ${s.dMin}–${s.dMax} mm does not straddle the published Ø ${E27.thread} mm E27 shade-ring thread, so the answer you are looking for is probably not on this gauge` });
    }
    if (s.dStep > 1) {
      out.push({ param: 'dStep', severity: 'info',
        message: `a ${s.dStep} mm step brackets the answer to ±${(s.dStep / 2).toFixed(2)} mm. A printed hole is usually two or three tenths undersize, so anything coarser than 1 mm cannot see the error you are measuring` });
    }
    if (s.depth < 6) {
      out.push({ param: 'depth', severity: 'warn',
        message: `a ${s.depth} mm collar is too short to tell a grip from a rattle. A real shade ring engages ${E27.ringHeight} mm of thread` });
    }
    if (s.collarWall < 1.6) {
      out.push({ param: 'collarWall', severity: 'warn',
        message: `a ${s.collarWall} mm collar wall will flex over the holder and read looser than it is` });
    }
  } else {
    const g = spiderShape(s);
    if (2 * g.rOut > s.bed.x) {
      out.push({ param: 'outer', severity: 'error',
        message: `${(2 * g.rOut).toFixed(0)} mm across will not fit a ${s.bed.x} mm bed` });
    }
    if (s.outer / 2 < s.bore / 2 + s.hub + s.rim + 4) {
      out.push({ param: 'outer', severity: 'warn',
        message: `a ${s.outer.toFixed(0)} mm spider has no room for arms between a ${s.bore.toFixed(0)} mm bore, a ${s.hub} mm hub and a ${s.rim} mm rim; it has been opened to ${(2 * g.rOut).toFixed(0)} mm` });
    }
    const armAngle = 2 * Math.asin(clamp(s.armW / (2 * (s.bore / 2 + s.hub)), 0, 0.98));
    if (armAngle >= TAU / s.arms - 0.06) {
      out.push({ param: 'armW', severity: 'warn',
        message: `${s.arms} arms ${s.armW} mm wide leave no gap at the hub, so the light has nowhere to go and the part is a solid disc with a hole in it. Narrow the arms or use fewer` });
    }
    if (s.thick < 2.4) {
      out.push({ param: 'thick', severity: 'warn',
        message: `a ${s.thick} mm spider carries the whole shade on ${s.arms} arms. Under 2.4 mm it will bend the first time the shade is knocked` });
    }
    if (s.hub + s.bore / 2 < E27.ringOuter / 2) {
      out.push({ param: 'hub', severity: 'warn',
        message: `the hub reaches ${(s.bore / 2 + s.hub).toFixed(1)} mm from the axis and a ${E27.ringOuter} mm shade ring reaches ${(E27.ringOuter / 2).toFixed(0)} mm. Give it at least ${(E27.ringOuter / 2 - s.bore / 2 + 2).toFixed(0)} mm of hub or the ring has nothing to clamp` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

function hints(p, ctx = {}) {
  const s = settings(p, ctx);
  const layerH = clamp(num(ctx.layerH, 0.2), 0.05, 0.6);
  const notes = [];
  if (s.kind === 'gauge') {
    const ds = ladder(s);
    notes.push(`${ds.length} collars, ${s.dMin} to ${s.dMax} mm in ${s.dStep} mm steps. Ticks read left to right: one for ${s.dMin} mm, ${ds.length} for ${s.dMax} mm.`);
    notes.push('Print it flat, exactly the way you will print the shade: same nozzle, same layer height, same filament, no ironing. The point is to measure your printer as well as your holder, and a gauge printed on different settings measures a different printer.');
    notes.push(`Push each collar onto the lampholder in turn. The one that goes on with a push and stays put is your number — type it into the shade's Bore. If it sits between two, take the larger: a shade that spins is better than one that will not go on.`);
    notes.push(`A vertical hole comes off a 0.4 mm nozzle two or three tenths undersize, which is why the answer is usually not the ${E27.thread} mm the holder measures with calipers.`);
    notes.push(`Three perimeters, 20% infill, no supports — it is a flat plate with holes in it. About ${Math.ceil(s.depth / layerH)} layers at ${layerH} mm.`);
  } else {
    notes.push(`A ${s.arms}-arm spider: the hub takes the lampholder, the rim glues into a shade whose top opening is about ${(s.outer).toFixed(0)} mm.`);
    notes.push('Print it flat, holes vertical, no supports. Solid: this part carries the whole shade, so give it 4 perimeters and at least 40% infill rather than the usual 15%.');
    notes.push(`Glue the rim into the shade with cyanoacrylate or a solvent weld, arms up, and let it set with the shade upside down on a flat surface so the spider sits square. A spider glued in crooked hangs the shade crooked and there is no adjusting it afterwards.`);
    notes.push(`The gaps between the arms are the ventilation. A solid flange there would trap the heat against the lamp and block everything going up, which is what a spider exists to avoid.`);
    notes.push(`Measure your holder with the gauge first. The ${s.bore} mm bore here is the published Ø ${E27.thread} mm E27 thread plus slip, not a measurement of yours.`);
  }
  return {
    profile: layerH <= 0.14 ? '0.12 mm Fine' : (layerH >= 0.24 ? '0.28 mm Draft' : '0.20 mm Standard'),
    filament: s.kind === 'gauge' ? 'PLA' : 'PETG',
    supports: false,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default {
  id: 'lampfitter',
  name: 'E27 fitter parts',
  category: 'Lighting',
  blurb: 'A bore gauge to measure your lampholder, and a spider for shades that cannot carry a flange.',
  description:
    'Two small parts that make a printed shade fit. The gauge is a rack of collars half a millimetre apart: print it flat in twenty minutes on the same settings as the shade, push it onto your lampholder, and the one that grips tells you the Bore to type into the shade. ' +
    'It measures your printer at the same time as your holder, which is the only useful answer — a vertical hole comes off a 0.4 mm nozzle a couple of tenths undersize and no amount of caliper work on the holder will tell you that. ' +
    'The spider is the other half: a hub, some arms and a rim, for a drum shade whose top opening is far too wide to close with a flange. It glues into the shade and the gaps between its arms are what let the heat and the upward light out.',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="9"/><path d="M12 8.8V3M15.6 13.9l5 2.9M8.4 13.9l-5 2.9"/></svg>',
  version: 1,

  params: [
    { key: 'kind', label: 'Part', type: 'enum', def: 'gauge', group: 'Part',
      help: 'Which of the two. Print the gauge first; the spider wants a bore you have actually measured.',
      options: [
        { v: 'gauge', label: 'Bore gauge', help: 'A rack of collars in half-millimetre steps. Twenty minutes, and it saves a six-hour shade that does not fit.' },
        { v: 'spider', label: 'Spider fitter', help: 'Hub, arms and a rim, to glue into a shade set to a fitting of "none" — the way a drum shade has always been hung.' },
      ] },

    { key: 'dMin', label: 'Smallest collar', type: 'number', unit: 'mm', min: 20, max: 80, step: 0.5, def: 39, group: 'Gauge',
      showIf: (p) => p.kind !== 'spider',
      help: 'The published European E27 shade-ring thread is Ø 40 mm, so a range that straddles it is what you want.' },
    { key: 'dMax', label: 'Largest collar', type: 'number', unit: 'mm', min: 22, max: 100, step: 0.5, def: 44, group: 'Gauge',
      showIf: (p) => p.kind !== 'spider',
      help: 'Plastic holders vary more than you would think, and a few have a moulding seam that adds most of a millimetre.' },
    { key: 'dStep', label: 'Step', type: 'number', unit: 'mm', min: 0.25, max: 3, step: 0.25, def: 1, group: 'Gauge',
      showIf: (p) => p.kind !== 'spider',
      help: 'How finely it brackets the answer. Half a millimetre is worth the extra collars: a printed hole is two or three tenths undersize and a coarser step cannot see that.' },
    { key: 'depth', label: 'Collar length', type: 'number', unit: 'mm', min: 4, max: 25, step: 1, def: 10, group: 'Gauge',
      showIf: (p) => p.kind !== 'spider',
      help: 'How far each collar goes over the holder. A real shade ring engages 14 mm of thread; under about 6 mm you cannot feel the difference between a grip and a rattle.' },
    { key: 'collarWall', label: 'Collar wall', type: 'number', unit: 'mm', min: 1, max: 6, step: 0.2, def: 2.4, group: 'Gauge',
      showIf: (p) => p.kind !== 'spider',
      help: 'Thin walls flex over the holder and read looser than they are.' },

    { key: 'bore', label: 'Bore', type: 'number', unit: 'mm', min: 16, max: 90, step: 0.5, def: 41, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'The hole over the lampholder. Use the number the gauge gave you, not this default.' },
    { key: 'hub', label: 'Hub width', type: 'number', unit: 'mm', min: 3, max: 30, step: 0.5, def: 8, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'The flat ring outside the bore that the shade ring clamps. A thermoplastic E27 ring is 54 mm across, so 8 mm on a 41 mm bore gives it 7 mm of grip.' },
    { key: 'outer', label: 'Outside diameter', type: 'number', unit: 'mm', min: 50, max: 220, step: 2, def: 120, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'Across the rim. Make it the shade\'s top opening less about half a millimetre so there is room for glue.' },
    { key: 'arms', label: 'Arms', type: 'int', min: 2, max: 8, step: 1, def: 3, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'Three is the classic and it cannot rock. More arms look tidier and block more of the light going up.' },
    { key: 'armW', label: 'Arm width', type: 'number', unit: 'mm', min: 3, max: 30, step: 0.5, def: 9, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'Measured at the hub, where the arm is narrowest and where it would break.' },
    { key: 'rim', label: 'Rim width', type: 'number', unit: 'mm', min: 1.5, max: 25, step: 0.5, def: 5, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'The band the arms land on and the glue grabs. Wider is stronger and takes more light.' },
    { key: 'thick', label: 'Thickness', type: 'number', unit: 'mm', min: 1.2, max: 10, step: 0.2, def: 3, group: 'Spider',
      showIf: (p) => p.kind === 'spider',
      help: 'This part carries the whole shade on its arms. Under 2.4 mm it bends the first time the shade is knocked.' },
  ],

  presets: [
    { name: 'Bore gauge, 39 to 44 in 1 mm',
      values: { kind: 'gauge', dMin: 39, dMax: 44, dStep: 1, depth: 10, collarWall: 2.4 } },
    { name: 'Fine gauge, half a millimetre either side',
      values: { kind: 'gauge', dMin: 40, dMax: 42, dStep: 0.5, depth: 12, collarWall: 2.4 } },
    { name: 'Spider for a 120 mm opening',
      values: { kind: 'spider', bore: 41, hub: 8, outer: 120, arms: 3, armW: 9, rim: 5, thick: 3 } },
    { name: 'Spider for a 170 mm drum',
      values: { kind: 'spider', bore: 41, hub: 9, outer: 170, arms: 4, armW: 10, rim: 6, thick: 3.6 } },
  ],

  build,
  validate,
  hints,
};

export { build, validate, hints, settings, ladder, collarShape, gaugeParts, spiderShape, E27 };
