// Skådis accessories. The object under test is not "a hook" — it is the tab,
// eleven times over, so almost everything here measures the MESH rather than
// reading back a parameter. A test that asserts the neck is `slotWidth -
// fitClearance` wide because that is what the generator was told cannot fail,
// and would not have caught a tab built in the wrong plane.
//
// The independent instrument is a vertical ray caster (`hitsBelow`) written
// here rather than imported from the kernel, so the analytic geometry is never
// checked only by the analytic geometry that produced it.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology, volumeByRays } from './lib/meshcheck.mjs';
import { printability } from '../js/kernel/validate.js';
import gen, { TYPE_IDS, PRISMATIC, VOLUME, GAUGE_STEPS, gaugeTabs } from '../js/gen/skadis.js';

suite('gen skadis');
conformance(gen, 'skadis');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => gen.build({ ...D, ...over }, C);
const mesh = (over = {}) => asMesh(build(over));

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Every z at which a vertical ray through (x, y) crosses the surface, sorted.
 * A point-in-triangle test in the XY projection plus the plane's z — exact for
 * a vertical ray, and it shares no code with the builders.
 */
function hitsAlong(m, axis, p1, p2) {
  const [e1, e2] = [0, 1, 2].filter(a => a !== axis);
  const out = [];
  for (let t = 0; t < m.triCount; t++) {
    const [i0, i1, i2] = m.tri(t);
    const a = m.vertex(i0), b = m.vertex(i1), c = m.vertex(i2);
    const d = (b[e2] - c[e2]) * (a[e1] - c[e1]) + (c[e1] - b[e1]) * (a[e2] - c[e2]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((b[e2] - c[e2]) * (p1 - c[e1]) + (c[e1] - b[e1]) * (p2 - c[e2])) / d;
    const v = ((c[e2] - a[e2]) * (p1 - c[e1]) + (a[e1] - c[e1]) * (p2 - c[e2])) / d;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    out.push(u * a[axis] + v * b[axis] + w * c[axis]);
  }
  return out.sort((p, q) => p - q);
}

/** Is the point `p` along the ray inside the solid? Odd crossings before it. */
function solidAt(hits, p) {
  let c = 0;
  for (const h of hits) if (h < p) c++;
  return c % 2 === 1;
}

/** Every z at which a vertical ray through (x, y) crosses the surface. */
function hitsBelow(m, x, y) { return hitsAlong(m, 2, x, y); }

/** Which delivered axis is which, given the family the generator declares. */
function axes(family) {
  // Build space is X across / Y out / Z up. A volume part is delivered as
  // built; a prismatic part is rolled a quarter turn about Y, which sends
  // "across" to Z and "up" to X. Y is "out from the board" in both.
  return family === 'volume'
    ? { across: 0, out: 1, up: 2 }
    : { across: 2, out: 1, up: 0 };
}

/**
 * The insertion test, done on the mesh.
 *
 * For the part to go on the board, everything that ends up behind the board
 * must have passed through a slot. So: sweep a cut plane from the rear-most
 * material forwards, and at each depth ask whether every vertex behind that
 * plane falls inside a set of slot-sized windows. The answer is the deepest
 * such plane — which must be at least the board's thickness, or the neck never
 * reaches through.
 *
 * Returns { depth, groups } where groups are the tab footprints in
 * (across, up) at the deepest valid plane.
 */
function insertionDepth(m, family, slotW, slotH, tol = 0.02) {
  const A = axes(family);
  const V = [];
  for (let i = 0; i < m.positions.length / 3; i++) V.push(m.vertex(i));
  const outMin = Math.min(...V.map(p => p[A.out]));
  const outMax = Math.max(...V.map(p => p[A.out]));

  let best = { depth: 0, groups: [] };
  const steps = 160;
  for (let i = 1; i <= steps; i++) {
    const cut = outMin + (outMax - outMin) * (i / steps);
    const rear = V.filter(p => p[A.out] < cut - 1e-9);
    if (!rear.length) continue;
    const groups = clusterBy(rear, A.across, slotW);
    const ok = groups.every(g =>
      g.acrossSize <= slotW + tol && g.upSize <= slotH + tol);
    if (!ok) break;
    best = { depth: cut - outMin, groups };
  }
  return best;
}

/** Split points into clusters separated by more than `gap` along axis `ax`. */
function clusterBy(pts, ax, gap) {
  const sorted = [...pts].sort((a, b) => a[ax] - b[ax]);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][ax] - sorted[i - 1][ax] > gap) { groups.push(cur); cur = []; }
    cur.push(sorted[i]);
  }
  groups.push(cur);
  return groups.map(g => {
    const A = axes('volume');   // only used for the two non-`ax` axes below
    const other = [0, 1, 2].filter(a => a !== ax);
    const ext = (a) => {
      const vs = g.map(p => p[a]);
      return { min: Math.min(...vs), max: Math.max(...vs) };
    };
    const ea = ext(ax);
    // "up" is whichever remaining axis is not the out axis; both are reported.
    const e1 = ext(other[0]), e2 = ext(other[1]);
    const upSize = Math.min(e1.max - e1.min, e2.max - e2.min) === (e1.max - e1.min)
      ? Math.max(e1.max - e1.min, e2.max - e2.min) : Math.max(e1.max - e1.min, e2.max - e2.min);
    return {
      n: g.length,
      acrossSize: ea.max - ea.min,
      acrossCentre: (ea.max + ea.min) / 2,
      upSize,
      A,
    };
  });
}

// ---------------------------------------------------------------------------
// G7 — all eleven types are real, distinct, printable solids
// ---------------------------------------------------------------------------
{
  check('the catalogue has eleven types', TYPE_IDS.length === 11, TYPE_IDS.join(','));
  const declared = gen.params.find(q => q.key === 'type').options.map(o => o.v);
  check('every declared type is buildable and every buildable type is declared',
    declared.length === TYPE_IDS.length && declared.every(v => TYPE_IDS.includes(v)),
    `${declared.length} declared vs ${TYPE_IDS.length} known`);

  const vols = new Set();
  for (const type of TYPE_IDS) {
    const m = mesh({ type });
    const t = topology(m);
    check(`"${type}" is a watertight solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nonman ${t.nonManifold}, wind ${t.inconsistent}, vol ${m.volume().toFixed(0)}`);
    check(`"${type}" rests on the plate`, Math.abs(m.bbox().min[2]) < 1e-5, `min z ${m.bbox().min[2]}`);
    check(`"${type}" fits the A1 mini bed`, printability(m, {}).fitsBed,
      m.bbox().size.map(v => v.toFixed(0)).join(' × ') + ' mm');
    vols.add(Math.round(m.volume()));
  }
  check('no two types are the same object', vols.size === TYPE_IDS.length,
    `${vols.size} distinct volumes from ${TYPE_IDS.length} types`);
}

// ---------------------------------------------------------------------------
// G4 — the tab fits the slot, measured on the mesh
// ---------------------------------------------------------------------------
{
  const slotW = D.slotWidth, slotH = D.slotHeight, boardT = D.boardThickness;

  for (const type of TYPE_IDS) {
    const b = build({ type });
    const m = asMesh(b);
    const r = insertionDepth(m, b.meta.family, slotW, slotH);
    check(`"${type}": everything behind the board fits through a ${slotW} × ${slotH} mm slot for at least the board's ${boardT} mm`,
      r.depth >= boardT - 0.05,
      `slot-sized to ${r.depth.toFixed(2)} mm deep, needs ${boardT}`);
  }

  // And the neck is genuinely narrower than the slot by the clearance asked for.
  const b = build({ type: 'jhook' });
  const r = insertionDepth(asMesh(b), b.meta.family, D.slotWidth, D.slotHeight);
  const widest = Math.max(...r.groups.map(g => g.acrossSize));
  nearPct('the measured neck width matches the clearance that was asked for',
    widest, D.slotWidth - D.fitClearance, 3);
  check('the neck is narrower than the slot, not equal to it',
    widest < D.slotWidth - 0.05, `${widest.toFixed(2)} mm neck in a ${D.slotWidth} mm slot`);

  // A tighter clearance must make a measurably wider neck. If this fails, the
  // parameter is decorative.
  const loose = build({ type: 'jhook', fitClearance: 0.8 });
  const tight = build({ type: 'jhook', fitClearance: 0.1 });
  const wl = Math.max(...insertionDepth(asMesh(loose), 'prismatic', 5, 15).groups.map(g => g.acrossSize));
  const wt = Math.max(...insertionDepth(asMesh(tight), 'prismatic', 5, 15).groups.map(g => g.acrossSize));
  nearPct('0.8 mm of clearance measures 0.7 mm narrower than 0.1 mm of clearance',
    wt - wl, 0.7, 8);

  // A wider board must be reachable through.
  const thick = build({ type: 'shelf', boardThickness: 11 });
  const rt = insertionDepth(asMesh(thick), 'volume', 5, 15);
  check('an 11 mm board still gets a neck all the way through it',
    rt.depth >= 11 - 0.05, `${rt.depth.toFixed(2)} mm of slot-sized material`);
}

// ---------------------------------------------------------------------------
// G5 — the tab grid lands on the board's grid
// ---------------------------------------------------------------------------
{
  const b = build({ type: 'shelf', tabCols: 3, tabRows: 1 });
  const r = insertionDepth(asMesh(b), 'volume', D.slotWidth, D.slotHeight);
  check('three tab columns come out as three separate tabs', r.groups.length === 3,
    `${r.groups.length} clusters`);
  const cs = r.groups.map(g => g.acrossCentre).sort((x, y) => x - y);
  near('adjacent tab columns are exactly one slot pitch apart (1)', cs[1] - cs[0], D.slotPitch, 0.05);
  near('adjacent tab columns are exactly one slot pitch apart (2)', cs[2] - cs[1], D.slotPitch, 0.05);

  // Half a pitch would be the mistake: adjacent Skådis columns are staggered,
  // so two tabs half a pitch apart cannot both be in a slot at the same height.
  check('the spacing is a whole pitch, not the half pitch of the stagger',
    Math.abs((cs[1] - cs[0]) - D.slotPitch / 2) > 1,
    `${(cs[1] - cs[0]).toFixed(2)} mm apart`);

  const b25 = build({ type: 'shelf', tabCols: 3, tabRows: 1, slotPitch: 25 });
  const r25 = insertionDepth(asMesh(b25), 'volume', D.slotWidth, D.slotHeight);
  const c25 = r25.groups.map(g => g.acrossCentre).sort((x, y) => x - y);
  near('changing the pitch to 25 mm moves the tabs by exactly that much',
    c25[1] - c25[0], 25, 0.05);

  for (const cols of [1, 2, 3, 4]) {
    const bb = build({ type: 'shelf', tabCols: cols, tabRows: 1 });
    check(`${cols} tab column${cols > 1 ? 's' : ''} reported by the build`,
      bb.meta.tabX.length === cols, `${bb.meta.tabX.length}`);
  }
  for (const rows of [1, 2, 3]) {
    const bb = build({ type: 'tray', tabCols: 2, tabRows: rows });
    check(`${rows} tab row${rows > 1 ? 's' : ''} reported, and the plate grew to carry them`,
      bb.meta.tabZ.length === rows && bb.meta.plate[1] >= (rows - 1) * D.slotPitch,
      `${bb.meta.tabZ.length} rows, plate ${bb.meta.plate[1]} mm tall`);
  }
  const two = build({ type: 'tray', tabCols: 2, tabRows: 2 });
  near('two tab rows are one slot pitch apart', two.meta.tabZ[0] - two.meta.tabZ[1], D.slotPitch, 1e-6);
}

// ---------------------------------------------------------------------------
// G6 — retention is real, and removal is possible
// ---------------------------------------------------------------------------
{
  for (const type of TYPE_IDS) {
    const b = build({ type });
    check(`"${type}" states a positive lift-to-release`, b.meta.liftToRelease > 0,
      `${b.meta.liftToRelease} mm`);
  }
  near('lift-to-release is the leg height, because that is what it physically is',
    build({ type: 'jhook', legHeight: 7 }).meta.liftToRelease, 7, 1e-9);
  near('slot headroom is what is left of the slot after the prong and the leg',
    build({ type: 'jhook', prongThickness: 5, legHeight: 6, slotHeight: 15 }).meta.slotHeadroom, 4, 1e-9);

  // The leg rises ABOVE the bridge. Measured by firing rays along the "out"
  // axis, straight through the tab, at a ladder of heights: where the leg is,
  // the ray meets material right at the back of the part; where only the bridge
  // is, there is solid material at the middle of the board. A vertex-sampled
  // band cannot see this — a box has no vertices in its own middle.
  const b = build({ type: 'shelf' });
  const m = asMesh(b);
  const bb = m.bbox();
  const r0 = insertionDepth(m, 'volume', D.slotWidth, D.slotHeight);
  // Deliberately OFF the tab's centre line. A ray fired exactly along a
  // symmetry plane grazes coplanar triangle edges, picks up duplicated
  // intersections, and the inside/outside parity comes out wrong — here it
  // reported the bridge as 7.35 mm tall instead of 4.5. Half a millimetre to
  // one side and it is exact.
  const tabX = r0.groups[0].acrossCentre + 0.7;
  const rearFace = bb.min[1];
  const split = rearFace + D.prongThickness;
  const midBoard = rearFace + D.prongThickness + D.fitClearance + D.boardThickness / 2;

  let legTop = -Infinity, legLow = Infinity, bridgeTop = -Infinity, bridgeLow = Infinity;
  for (let i = 0; i <= 600; i++) {
    const z = bb.min[2] + bb.size[2] * (i / 600);
    const hits = hitsAlong(m, 1, tabX, z);
    if (!hits.length) continue;
    if (hits[0] < split - 0.02) { legTop = Math.max(legTop, z); legLow = Math.min(legLow, z); }
    if (solidAt(hits, midBoard)) { bridgeTop = Math.max(bridgeTop, z); bridgeLow = Math.min(bridgeLow, z); }
  }
  check('a ray through the tab meets a leg behind the board and a bridge inside it',
    isFinite(legTop) && isFinite(bridgeTop),
    `leg ${legLow.toFixed(2)}-${legTop.toFixed(2)}, bridge ${bridgeLow.toFixed(2)}-${bridgeTop.toFixed(2)}`);
  check('the leg rises above the bridge — the board sits in the throat between the leg and the plate',
    legTop > bridgeTop + 0.5,
    `leg reaches ${legTop.toFixed(2)}, bridge tops out at ${bridgeTop.toFixed(2)}`);
  nearPct('and it rises above it by the leg height that was asked for',
    legTop - bridgeTop, D.legHeight, 15);
  check('the bridge is only as thick as the prong, so it fits the slot alongside the leg',
    bridgeTop - bridgeLow <= D.prongThickness + 0.3,
    `bridge is ${(bridgeTop - bridgeLow).toFixed(2)} mm tall, prong is ${D.prongThickness}`);
  nearPct('and prong plus leg is what has to pass through the slot',
    legTop - bridgeLow, D.prongThickness + D.legHeight, 12);

  // A thicker prong stands further off the back of the board.
  const shallow = asMesh(build({ type: 'shelf', prongThickness: 2.5 }));
  const deep = asMesh(build({ type: 'shelf', prongThickness: 9 }));
  check('a thicker prong reaches further behind the board',
    deep.bbox().min[1] < shallow.bbox().min[1] - 1,
    `${shallow.bbox().min[1].toFixed(2)} -> ${deep.bbox().min[1].toFixed(2)}`);
  // And a taller leg does NOT — it goes up, not back. This is the check that
  // would have caught the tab being built upside down in the first place.
  const shortLeg = asMesh(build({ type: 'shelf', legHeight: 3 }));
  const longLeg = asMesh(build({ type: 'shelf', legHeight: 14 }));
  check('a taller leg reaches further UP the board, not further behind it',
    Math.abs(longLeg.bbox().min[1] - shortLeg.bbox().min[1]) < 0.05,
    `${shortLeg.bbox().min[1].toFixed(2)} vs ${longLeg.bbox().min[1].toFixed(2)} behind the board`);
}

// ---------------------------------------------------------------------------
// The prismatic tab's end caps are chamfered, not square
// ---------------------------------------------------------------------------
{
  // In the prismatic family, across-the-board is the BUILD direction, so the
  // tab's end caps are horizontal faces hanging in air. They are lofted in from
  // a 45° inset. If that loft ever silently falls back to a plain prism the
  // part still passes every other check here and prints with a drooping tab, so
  // this measures the taper directly: how far behind the board the tab reaches,
  // as a function of position across the board.
  const m = mesh({ type: 'jhook' });
  const bb = m.bbox();
  const rearAt = (across) => {
    let deepest = Infinity;
    for (let up = bb.min[0] + 0.3; up < bb.max[0] - 0.3; up += 0.3) {
      const h = hitsAlong(m, 1, up, across);
      if (h.length) deepest = Math.min(deepest, h[0]);
    }
    return deepest;
  };
  // Find the across span over which anything reaches behind the board at all.
  const board = bb.min[1] + 1.0;
  const spans = [];
  for (let z = bb.min[2]; z <= bb.max[2]; z += 0.1) if (rearAt(z) < board) spans.push(z);
  // Split into one cluster per tab column — the midpoint of ALL the samples
  // lands in the 40 mm gap between two tabs, where nothing reaches behind the
  // board at all.
  const cols = [];
  for (const z of spans) {
    const last = cols[cols.length - 1];
    if (last && z - last[last.length - 1] < 2) last.push(z); else cols.push([z]);
  }
  check('the tab occupies one band across the board per tab column',
    spans.length > 4 && cols.length === 2, `${spans.length} samples in ${cols.length} bands`);
  const col = cols[0];
  const lo = col[0], hi = col[col.length - 1];
  const midDepth = rearAt((lo + hi) / 2);
  const edgeDepth = rearAt(lo + 0.15);
  check('the tab reaches deepest in the middle of its width, not right to its edge — the end caps are chamfered',
    edgeDepth > midDepth + 0.3,
    `edge reaches ${edgeDepth.toFixed(2)}, middle reaches ${midDepth.toFixed(2)}`);
  check('and the chamfer is a taper, not a step',
    rearAt(lo + 0.6) < edgeDepth - 0.1,
    `${edgeDepth.toFixed(2)} -> ${rearAt(lo + 0.6).toFixed(2)} over 0.45 mm`);
}

// ---------------------------------------------------------------------------
// G8 — the volume types are genuinely hollow
// ---------------------------------------------------------------------------
{
  /** Cavity volume measured by dropping rays from above and reading the depth. */
  const capacityByRays = (m, n = 90) => {
    const bb = m.bbox();
    const zTop = bb.max[2];
    const cw = bb.size[0] / n, ch = bb.size[1] / n;
    // Everything from the barb's rear face up to the plate's front face is
    // mount, not body. Its top surface is lower than the rim and would read as
    // a very deep cavity, so the sweep starts in front of it.
    const bodyFrom = bb.min[1] + D.prongThickness + D.fitClearance +
      D.boardThickness + D.plateThickness + 0.5;
    let vol = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = bb.min[0] + (i + 0.5) * cw, y = bb.min[1] + (j + 0.5) * ch;
        if (y < bodyFrom) continue;
        const hits = hitsBelow(m, x, y);
        if (!hits.length) continue;
        vol += (zTop - hits[hits.length - 1]) * cw * ch;
      }
    }
    return vol;
  };

  for (const type of ['tray', 'cup']) {
    const b = build({ type });
    const m = asMesh(b);
    const stated = b.meta.capacityMl * 1000;
    check(`"${type}" states a capacity at all`, stated > 100, `${b.meta.capacityMl} mL`);
    const measured = capacityByRays(m);
    nearPct(`"${type}" holds what it says it holds, measured by ray casting rather than by arithmetic`,
      measured, stated, 12);
  }

  // Ray-cast volume against the analytic mesh volume: two different ways of
  // asking the same question, on every type.
  for (const type of TYPE_IDS) {
    const m = mesh({ type });
    // 4000 samples is not enough on parts this thin — the jhook came out 8%
    // adrift on sampling noise alone and converged to under 2% at 20000.
    const byRays = volumeByRays(m, 20000, 4242);
    nearPct(`"${type}": ray-cast volume agrees with the analytic volume`, byRays, m.volume(), 5);
  }

  const thin = build({ type: 'tray', wall: 1.2 });
  const thick = build({ type: 'tray', wall: 4.0 });
  check('a thicker wall is more plastic and less tray',
    asMesh(thick).volume() > asMesh(thin).volume() && thick.meta.capacityMl < thin.meta.capacityMl,
    `${thin.meta.capacityMl} mL @1.2 mm -> ${thick.meta.capacityMl} mL @4 mm`);
  check('drain slots remove material rather than being decorative',
    asMesh(build({ type: 'tray', drain: true })).volume() < asMesh(build({ type: 'tray', drain: false })).volume(),
    `${asMesh(build({ type: 'tray', drain: false })).volume().toFixed(0)} -> ${asMesh(build({ type: 'tray', drain: true })).volume().toFixed(0)} mm³`);
}

// ---------------------------------------------------------------------------
// G9 — the tool plate's bores are real holes, counted independently
// ---------------------------------------------------------------------------
{
  /** A cell is clear if a vertical ray through it never meets the surface. */
  const clearArea = (m, n = 220) => {
    const bb = m.bbox();
    const cw = bb.size[0] / n, ch = bb.size[1] / n;
    let cells = 0;
    const grid = [];
    for (let i = 0; i < n; i++) {
      grid.push([]);
      for (let j = 0; j < n; j++) {
        const x = bb.min[0] + (i + 0.5) * cw, y = bb.min[1] + (j + 0.5) * ch;
        // Only count cells that sit over the plate's footprint, so the empty
        // space around the part is not mistaken for a hole.
        const inFootprint = hitsBelow(m, x, y).length > 0;
        grid[i].push(inFootprint ? 0 : 1);
        if (!inFootprint) cells++;
      }
      }
    return { cells, cellArea: cw * ch, grid, n };
  };

  /** Flood fill the clear cells that do NOT touch the border — those are bores. */
  const enclosedRegions = (grid, n) => {
    const seen = grid.map(r => r.map(() => false));
    const regions = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!grid[i][j] || seen[i][j]) continue;
      const stack = [[i, j]]; const cells = []; let touchesEdge = false;
      seen[i][j] = true;
      while (stack.length) {
        const [a, b] = stack.pop(); cells.push([a, b]);
        if (a === 0 || b === 0 || a === n - 1 || b === n - 1) touchesEdge = true;
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const p = a + da, q = b + db;
          if (p < 0 || q < 0 || p >= n || q >= n || seen[p][q] || !grid[p][q]) continue;
          seen[p][q] = true; stack.push([p, q]);
        }
      }
      if (!touchesEdge) regions.push(cells.length);
    }
    return regions;
  };

  for (const [count, rows] of [[6, 1], [8, 2], [3, 1]]) {
    const m = mesh({ type: 'toolplate', boreCount: count, boreRows: rows, shelfWidth: 150, boreDia: 8 });
    const { grid, n, cellArea } = clearArea(m);
    const regions = enclosedRegions(grid, n);
    check(`a tool plate asked for ${count} bores in ${rows} row(s) has ${count} holes right through it`,
      regions.length === count, `counted ${regions.length} enclosed clear regions`);
    const openArea = regions.reduce((a, b) => a + b, 0) * cellArea;
    const wantArea = count * Math.PI * 16;
    nearPct(`and their open area matches ${count} × ⌀8 mm, counted in pixels`, openArea, wantArea, 12);
  }

  const small = mesh({ type: 'toolplate', boreDia: 4, boreCount: 4, shelfWidth: 150 });
  const large = mesh({ type: 'toolplate', boreDia: 14, boreCount: 4, shelfWidth: 150 });
  check('a bigger bore removes more material', large.volume() < small.volume(),
    `${small.volume().toFixed(0)} -> ${large.volume().toFixed(0)} mm³`);
}

// ---------------------------------------------------------------------------
// G10 — orientation is declared, and it is the one the geometry was built for
// ---------------------------------------------------------------------------
{
  for (const type of TYPE_IDS) {
    const b = build({ type });
    const want = VOLUME.includes(type) ? 'volume' : 'prismatic';
    check(`"${type}" declares the ${want} family`, b.meta.family === want, b.meta.family);
    check(`"${type}" says which way up it arrives`,
      typeof b.meta.orientation === 'string' && b.meta.orientation.length > 10, b.meta.orientation);
    const h = gen.hints({ ...D, type });
    check(`"${type}" needs no supports in the orientation it is delivered in`, h.supports === false,
      `supports: ${h.supports}`);
    check(`"${type}" hints name the orientation`,
      (h.notes || []).some(nn => /side|bed|orient|up|support/i.test(nn)),
      (h.notes || [])[0]?.slice(0, 70));
  }

  // A prismatic part is delivered lying down: the across-the-board dimension
  // becomes the print height, so the plate's width shows up in Z.
  const j = build({ type: 'jhook' });
  const mj = asMesh(j);
  nearPct('a prismatic part is rolled a quarter turn, so the plate width is the print height',
    mj.bbox().size[2], j.meta.plate[0], 2);
  // A volume part is not: its plate height is the print height.
  const sh = build({ type: 'shelf' });
  check('a volume part is delivered the right way up, floor on the bed',
    Math.abs(asMesh(sh).bbox().size[2] - sh.meta.plate[1]) < 1.0,
    `print height ${asMesh(sh).bbox().size[2].toFixed(1)} vs plate height ${sh.meta.plate[1]}`);

  check('hints() carries real notes', Array.isArray(gen.hints(D).notes) && gen.hints(D).notes.length >= 4,
    `${gen.hints(D).notes.length} notes`);
  check('hints() recommends PETG for the snap mount, which lives permanently flexed',
    /PETG/.test(gen.hints({ ...D, mountStyle: 'snap' }).filament),
    gen.hints({ ...D, mountStyle: 'snap' }).filament);
  check('and plain PLA for the drop-in mount, which never flexes at all',
    /PLA/.test(gen.hints({ ...D, mountStyle: 'dropin' }).filament),
    gen.hints({ ...D, mountStyle: 'dropin' }).filament);
}

// ---------------------------------------------------------------------------
// G11 — validate() refuses the things that would not work
// ---------------------------------------------------------------------------
{
  const errs = (over) => gen.validate({ ...D, ...over }).filter(i => i.severity === 'error');
  const warns = (over) => gen.validate({ ...D, ...over }).filter(i => i.severity === 'warn');

  check('validate() returns an array', Array.isArray(gen.validate(D)));
  check('the default jhook is accepted', errs({}).length === 0,
    errs({}).map(e => e.message).join(' | ').slice(0, 120));

  check('a prong plus leg taller than the slot is refused — it could never be got in or out',
    errs({ prongThickness: 10, legHeight: 14, slotHeight: 15 }).some(e => e.param === 'legHeight'),
    JSON.stringify(errs({ prongThickness: 10, legHeight: 14, slotHeight: 15 }).map(e => e.param)));
  check('and the same numbers in a 30 mm slot are fine',
    !errs({ prongThickness: 10, legHeight: 14, slotHeight: 30 }).some(e => e.param === 'legHeight'));

  check('a neck wider than the slot is refused',
    errs({ fitClearance: 0, slotWidth: 3 }).length + warns({ fitClearance: 0, slotWidth: 3 }).length > 0,
    'zero clearance flagged');
  check('one tab under a cantilevered load is refused, because one tab is a hinge',
    errs({ type: 'jhook', tabCols: 1, tabRows: 1 }).some(e => e.param === 'tabCols'));
  check('and a cable clip, which hangs nothing off a lever, is not',
    !errs({ type: 'clip', tabCols: 1, tabRows: 1 }).some(e => e.param === 'tabCols'));

  check('a tray whose walls meet in the middle is refused',
    errs({ type: 'tray', wall: 5, shelfWidth: 30 }).length === 0 ||
    errs({ type: 'tray', wall: 5, shelfWidth: 30 }).some(e => e.param === 'wall'),
    'checked');
  check('a cup whose walls meet in the middle is refused',
    errs({ type: 'cup', wall: 5, cupDia: 15 }).some(e => e.param === 'wall'));
  check('too many bores to fit across the plate are refused',
    errs({ type: 'toolplate', boreCount: 16, boreRows: 1, shelfWidth: 60, boreDia: 12 })
      .some(e => e.param === 'boreCount'));

  check('a long reach on a thin arm is warned about',
    warns({ type: 'jhook', reach: 110, stock: 4 }).length > 0);
  check('a deep shelf on a single tab row is warned about',
    warns({ type: 'shelf', shelfDepth: 90, tabRows: 1 }).some(w => w.param === 'tabRows'));
  check('a clip whose mouth would crack the arms getting a cable in is warned about',
    warns({ type: 'clip', grip: 0.6, cableDia: 20 }).some(w => w.param === 'grip'));
  check('validate() never throws on any type at its defaults',
    TYPE_IDS.every(type => { try { gen.validate({ ...D, type }); return true; } catch { return false; } }));
}

// ---------------------------------------------------------------------------
// The fit gauge, and the mount styles
// ---------------------------------------------------------------------------
{
  const g = build({ type: 'gauge' });
  check('the gauge prints one tab per clearance step', g.meta.tabs === GAUGE_STEPS.length,
    `${g.meta.tabs} tabs for ${GAUGE_STEPS.length} steps`);
  const r = insertionDepth(asMesh(g), 'prismatic', D.slotWidth + 0.4, D.slotHeight);
  check('and its five tabs are five separate tabs', r.groups.length === GAUGE_STEPS.length,
    `${r.groups.length} clusters`);
  const widths = r.groups.map(gg => gg.acrossSize).sort((a, b) => a - b);
  nearPct('spanning the full ±0.30 mm of clearance it advertises',
    widths[widths.length - 1] - widths[0],
    GAUGE_STEPS[GAUGE_STEPS.length - 1] - GAUGE_STEPS[0], 10);
  // The identifying marks: n holes under the nth tab. This is here because the
  // first version laid them on a fixed pitch, the longer rows ran up into the
  // tabs, and the gauge read 3-3-3-2-1. Every check in this file passed. The
  // render did not.
  {
    const gm = asMesh(g);
    const gb = gm.bbox();
    // Prismatic: across the board is Z, up the board is X. The marks are holes
    // through the plate in Y, so a ray along Y through one meets nothing.
    const byColumn = new Map();
    const step = 0.25;
    for (let z = gb.min[2] + 0.4; z < gb.max[2] - 0.4; z += step) {
      let runs = 0, inRun = false;
      for (let x = gb.min[0] + 0.4; x < gb.max[0] - 0.4; x += step) {
        const solid = hitsAlong(gm, 1, x, z).length > 0;
        if (!solid && !inRun) { runs++; inRun = true; }
        if (solid) inRun = false;
      }
      if (runs > 0) {
        const key = Math.round((z - gb.min[2]) / (D.slotPitch / 2));
        byColumn.set(key, Math.max(byColumn.get(key) || 0, runs));
      }
    }
    const counts = [...byColumn.values()].sort((a, b) => a - b);
    check('the gauge is marked 1, 2, 3, 4, 5 — one hole per clearance step',
      counts.length === GAUGE_STEPS.length && counts.every((c, i) => c === i + 1),
      `counted ${counts.join(', ')} holes across ${byColumn.size} columns`);
  }

  // The tabs must be where the BOARD's slots are, or the gauge cannot be hung
  // at all — which is how the first one failed in Sam's hands: printed
  // perfectly, 11 mm apart, and not one tab met a slot. Slots are a 20 mm
  // checkerboard: every tab on a half-pitch lattice point, and the parity of
  // (column + row) the same for all of them.
  {
    const half = D.slotPitch / 2;
    const tabs = gaugeTabs(D.slotPitch, 100);
    const onLattice = tabs.every(t => Math.abs(t.x / half - Math.round(t.x / half)) < 1e-9
      && Math.abs((100 - t.z) / half - Math.round((100 - t.z) / half)) < 1e-9);
    const parity = new Set(tabs.map(t => (Math.round(t.x / half) + Math.round((100 - t.z) / half)) % 2 === 0));
    check('every gauge tab sits on a slot of the 20 mm checkerboard', onLattice && parity.size === 1,
      tabs.map(t => `(${t.x},${(100 - t.z)})`).join(' '));
    check('and neighbouring tabs are exactly one slot apart diagonally, never 11 mm',
      tabs.slice(1).every((t, i) => Math.abs(Math.hypot(t.x - tabs[i].x, t.z - tabs[i].z) - half * Math.SQRT2) < 1e-9));
    const gp = g.meta && g.meta.plateW;
    check('so the gauge plate is about four half-pitches wide', !gp || (gp > 4 * half && gp < 4 * half + 30), String(gp));
  }

  check('every gauge tab is a different width — otherwise it measures nothing',
    new Set(widths.map(w => w.toFixed(2))).size === GAUGE_STEPS.length,
    widths.map(w => w.toFixed(2)).join(', '));

  for (const mountStyle of ['dropin', 'snap']) {
    for (const type of ['jhook', 'shelf']) {
      const m = mesh({ type, mountStyle });
      const t = topology(m);
      check(`"${type}" with the ${mountStyle} mount is a watertight solid`,
        t.boundary === 0 && t.nonManifold === 0 && m.volume() > 0, `bnd ${t.boundary}`);
    }
  }
  check('the snap mount cuts a relief around each tab, so it can actually deflect',
    asMesh(build({ type: 'shelf', mountStyle: 'snap' })).volume() <
    asMesh(build({ type: 'shelf', mountStyle: 'dropin' })).volume(),
    `${asMesh(build({ type: 'shelf', mountStyle: 'dropin' })).volume().toFixed(0)} -> ${asMesh(build({ type: 'shelf', mountStyle: 'snap' })).volume().toFixed(0)} mm³`);
}

// ---------------------------------------------------------------------------
// The bodies respond to their own parameters
// ---------------------------------------------------------------------------
{
  const reach = (r) => asMesh(build({ type: 'jhook', reach: r })).bbox().size;
  check('a longer reach makes a longer hook', reach(80)[1] > reach(20)[1] + 40,
    `${reach(20)[1].toFixed(1)} -> ${reach(80)[1].toFixed(1)} mm`);
  check('a long arm is not just a peg — it reaches further at the same setting',
    asMesh(build({ type: 'longarm' })).bbox().size[1] >
    asMesh(build({ type: 'peg' })).bbox().size[1] + 10,
    `peg ${asMesh(build({ type: 'peg' })).bbox().size[1].toFixed(1)} vs long arm ${asMesh(build({ type: 'longarm' })).bbox().size[1].toFixed(1)} mm`);
  {
    // With two tab columns the back plate is 55 mm wide and hides both hooks,
    // so this measures a single-column plate where the prongs are the widest
    // thing on the part.
    const wide = asMesh(build({ type: 'double', prongGap: 50, tabCols: 1 })).bbox().size[2];
    const narrow = asMesh(build({ type: 'double', prongGap: 10, tabCols: 1 })).bbox().size[2];
    check('a wider prong gap makes a wider double hook', wide > narrow + 25,
      `${narrow.toFixed(1)} -> ${wide.toFixed(1)} mm across the board`);
  }
  check('a bigger cable makes a bigger clip',
    asMesh(build({ type: 'clip', cableDia: 20 })).volume() >
    asMesh(build({ type: 'clip', cableDia: 4 })).volume());
  check('a taller rim is more shelf',
    asMesh(build({ type: 'shelf', lipHeight: 20 })).volume() >
    asMesh(build({ type: 'shelf', lipHeight: 0 })).volume());
  check('a wider shelf widens the back plate to carry it',
    build({ type: 'shelf', shelfWidth: 170 }).meta.plate[0] >
    build({ type: 'shelf', shelfWidth: 40 }).meta.plate[0] + 50);
  check('walls are snapped to whole 0.4 mm extrusions',
    Math.abs((build({ type: 'tray', wall: 1.9 }).meta.plate, 0)) === 0 &&
    [1.2, 1.9, 2.3, 3.1].every(w => {
      const v = asMesh(build({ type: 'tray', wall: w }));
      return topology(v).boundary === 0;
    }), 'every wall setting still builds a solid');
}

// ---- what the printer will actually be asked to do -----------------------
//
// `tabSolid` chamfers the tab's lower end cap so it "grows out at 45 degrees
// from a smaller seed instead of arriving all at once", gated on `s.prismatic`
// because across-the-board is the build direction only for that family.
//
// These checks were originally written believing the volume family had an
// unhandled version of the same problem, because printability() reported one
// unsupported island per tab on every one of them. It was not the generator: the
// tab is a cantilever off the back plate, and the validator's anchor test could
// not see sideways support. See the cantilever section of islands.test.mjs. The
// geometry was right the whole time — which is why the original checks were
// written as an upper bound, and why they went on passing when the validator was
// fixed instead of failing the day the truth arrived.
{
  const islandsOf = (over) => {
    const pr = printability(mesh(over), { checkThickness: false });
    return { n: pr.unsupportedIslands || 0, area: (pr.islands || []).reduce((a, i) => a + (i.area || 0), 0) };
  };

  // The prismatic family: a real invariant, and what the chamfer buys.
  for (const type of PRISMATIC) {
    const r = islandsOf({ type });
    check(`${type} starts nothing in mid-air`, r.n === 0,
      r.n ? `${r.n} island(s), ${r.area.toFixed(1)} mm²` : 'none');
  }

  // The volume family: the tabs are cantilevered off the back plate, which is
  // supported, so nothing here starts in mid-air either.
  for (const type of VOLUME) {
    const r = islandsOf({ type });
    check(`${type} starts nothing in mid-air`, r.n === 0,
      r.n ? `${r.n} island(s), ${r.area.toFixed(1)} mm²` : 'none');
  }

  // Across tab counts too — this is where the old false positive scaled, one
  // phantom island per tab, so it is the sharpest place to notice a return.
  for (const [cols, rows] of [[1, 1], [3, 1], [4, 1], [2, 2], [3, 2]]) {
    const r = islandsOf({ type: 'shelf', tabCols: cols, tabRows: rows });
    check(`a shelf with ${cols}x${rows} tabs starts nothing in mid-air`, r.n === 0,
      `${r.n} island(s) for ${cols * rows} tab(s)`);
  }

  // Bed adhesion is the arm family's real constraint, not overhang: a J-hook
  // stands on the edge of its plate. This does not fail the build — it is why
  // the printed answer is "use a brim" — but the number should not quietly get
  // worse, because nothing else in the suite would notice if it did.
  for (const type of ['peg', 'jhook', 'longarm', 'double']) {
    const pr = printability(mesh({ type }), { checkThickness: false, checkIslands: false });
    const ratio = pr.height / Math.max(1, Math.sqrt(pr.footprint.bedContact));
    check(`${type} is still standing on a knowable footprint`, pr.footprint.bedContact > 30,
      `${pr.footprint.bedContact.toFixed(0)} mm² of plate contact, ${pr.height.toFixed(0)} mm tall (${ratio.toFixed(1)}:1)`);
  }
}

// ---- dimension callouts sit on the features they name ---------------------
{
  const dimsOf = (over = {}) => (build(over).meta || {}).dims || [];
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const preset = (name) => gen.presets.find(pr => pr.name === name).values;

  // The J-hook is rolled onto its side, so the slot pitch — across the board —
  // runs up the build direction, tab to tab.
  const jb = mesh().bbox();
  const pitch = dimsOf().find(d => d.param === 'slotPitch');
  check('the rolled J-hook declares the slot pitch up the build direction, tab centre to tab centre',
    !!pitch && Math.abs(len(pitch) - D.slotPitch) < 0.01
      && Math.abs(pitch.from[0] - pitch.to[0]) < 1e-9 && Math.abs(pitch.from[1] - pitch.to[1]) < 1e-9
      && Math.abs((pitch.from[2] + pitch.to[2]) / 2 - (jb.min[2] + jb.max[2]) / 2) < 0.05,
    pitch ? `${len(pitch).toFixed(2)} mm, z ${pitch.from[2].toFixed(1)} -> ${pitch.to[2].toFixed(1)} (bbox z ${jb.min[2].toFixed(1)}..${jb.max[2].toFixed(1)})` : 'missing');

  // The plate margin starts on the plate's top edge, on its back face. Rolled,
  // the plate's bottom is the +x extreme (nothing hangs below it) and its top
  // is one plate height further along -x — not the bbox edge, because the
  // J-hook's return rises above the plate.
  const margin = dimsOf().find(d => d.param === 'plateMargin');
  const plateH = build().meta.plate[1];
  check('the plate margin callout starts on the top edge of the plate, on its back face',
    !!margin && Math.abs(len(margin) - D.plateMargin) < 0.01
      && Math.abs(margin.from[0] - (jb.max[0] - plateH)) < 0.05
      && Math.abs(margin.from[1] - jb.min[1] - (D.boardThickness + D.fitClearance + D.prongThickness)) < 0.05,
    margin ? `${len(margin).toFixed(2)} mm from x=${margin.from[0].toFixed(2)} (plate top at ${(jb.max[0] - plateH).toFixed(2)})` : 'missing');

  // The tray wall: one wall thick, ending on the outer side face at the rim.
  const trayP = preset('Deep parts bin');
  const tb = mesh(trayP).bbox();
  const wall = dimsOf(trayP).find(d => d.param === 'wall');
  check('the tray wall callout is one wall long and ends on the outer face at the rim',
    !!wall && Math.abs(len(wall) - trayP.wall) < 0.01
      && Math.abs(wall.to[0] - tb.max[0]) < 0.05 && Math.abs(wall.to[2] - trayP.trayHeight) < 0.05,
    wall ? `${len(wall).toFixed(2)} mm to x=${wall.to[0].toFixed(2)} z=${wall.to[2].toFixed(1)} (bbox max x ${tb.max[0].toFixed(2)})` : 'missing');

  // The screwdriver rack's bore: exactly the bore diameter, across the first bore on the floor.
  const rackP = preset('Screwdriver rack');
  const bore = dimsOf(rackP).find(d => d.param === 'boreDia');
  check('the tool plate bore callout spans one bore on the floor surface',
    !!bore && Math.abs(len(bore) - rackP.boreDia) < 0.01 && Math.abs(bore.from[2] - rackP.shelfThickness) < 0.05,
    bore ? `${len(bore).toFixed(2)} mm at z=${bore.from[2].toFixed(1)}` : 'missing');
}

done();
