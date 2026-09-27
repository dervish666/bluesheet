// tests/gen-boxlid.test.mjs — the box, held to its own promises.
//
// The shared harness proves the generator returns a solid. These checks prove it
// returns the RIGHT solid, and they are written the way you would check a box you
// had just taken off the plate: measure the hole, try the lid, work the hinge.
//
// Nothing here trusts meta on its own. Where a number matters — the internal
// dimensions, the lip clearance, the thread fit, the hinge gap — it is measured
// off the triangles, by probing the solid with rays or by intersecting the two
// halves triangle against triangle. meta is then checked to agree, which makes
// it a cross-check between the declaration and the geometry rather than a
// restatement of it.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults } from './lib/genconform.mjs';
import { topology, volumeAgrees } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import {
  triGrid, rayMeshHit, pointInsideMesh, triTriIntersect, printability, analyze,
} from '../js/kernel/validate.js';
import gen, { solve, threadProfile } from '../js/gen/boxlid.js';

suite('gen-boxlid');

const C = ctx('normal');
const P0 = defaults(gen);
const build = (over = {}, q = C) => gen.build({ ...P0, ...over }, q);
const partOf = (r, name) => r.parts.find(p => p.name === name).mesh;

// ---------------------------------------------------------------------------
// Measuring instruments
// ---------------------------------------------------------------------------

const tri = (m, t) => [m.vertex(m.tris[t * 3]), m.vertex(m.tris[t * 3 + 1]), m.vertex(m.tris[t * 3 + 2])];

function triBox(v) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of v) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
  return [mn, mx];
}

/**
 * Every pair of triangles, one from each mesh, that pass through each other.
 * A uniform hash grid over B, then one query per triangle of A — deliberately a
 * second implementation rather than validate.js's selfIntersect, because that
 * one cannot tell a pair that spans the two parts from a pair inside one of
 * them, and the CSG seams inside each half produce plenty of the latter.
 */
function crossPairs(A, B, { eps = 1e-9, classify = null } = {}) {
  const bb = B.bbox();
  const cell = Math.max(0.5, Math.max(...bb.size) / 40);
  const grid = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (let t = 0; t < B.triCount; t++) {
    const [mn, mx] = triBox(tri(B, t));
    for (let i = Math.floor(mn[0] / cell); i <= Math.floor(mx[0] / cell); i++)
      for (let j = Math.floor(mn[1] / cell); j <= Math.floor(mx[1] / cell); j++)
        for (let k = Math.floor(mn[2] / cell); k <= Math.floor(mx[2] / cell); k++) {
          const kk = key(i, j, k); let a = grid.get(kk); if (!a) { a = []; grid.set(kk, a); } a.push(t);
        }
  }
  let count = 0, flagged = 0;
  const examples = [];
  for (let t = 0; t < A.triCount; t++) {
    const va = tri(A, t), [mn, mx] = triBox(va);
    const seen = new Set();
    for (let i = Math.floor(mn[0] / cell); i <= Math.floor(mx[0] / cell); i++)
      for (let j = Math.floor(mn[1] / cell); j <= Math.floor(mx[1] / cell); j++)
        for (let k = Math.floor(mn[2] / cell); k <= Math.floor(mx[2] / cell); k++) {
          const arr = grid.get(key(i, j, k)); if (!arr) continue;
          for (const u of arr) {
            if (seen.has(u)) continue; seen.add(u);
            const vb = tri(B, u);
            if (!triTriIntersect(va[0], va[1], va[2], vb[0], vb[1], vb[2], { eps })) continue;
            count++;
            if (classify && !classify(va, vb)) {
              flagged++;
              if (examples.length < 3) examples.push({ a: va.map(q => q.map(x => +x.toFixed(2))), b: vb.map(q => q.map(x => +x.toFixed(2))) });
            }
          }
        }
  }
  return { count, flagged, examples };
}

/** Rotate the lid about the hinge axis. `open` is degrees: 180 as built, 0 shut. */
function atAngle(lid, hinge, open) {
  const phi = (180 - open) * Math.PI / 180;
  return lid.translate(0, -hinge.axisY, -hinge.axisZ).rotateX(phi).translate(0, hinge.axisY, hinge.axisZ);
}

/** First surface met by a ray, as a distance from the origin. */
function hitAt(grid, origin, dir, maxT = 400) {
  const h = rayMeshHit(grid, origin, dir, { maxT });
  return h ? h.t : null;
}

/** Every surface a ray crosses, in order, as distances from the origin. */
function allHits(grid, origin, dir, maxT = 400, limit = 64) {
  const out = [];
  let base = 0;
  let o = origin.slice();
  for (let i = 0; i < limit; i++) {
    const h = rayMeshHit(grid, o, dir, { maxT: maxT - base });
    if (!h) break;
    const step = h.t + 1e-7;
    base += step;
    out.push(base - 1e-7);
    o = [o[0] + dir[0] * step, o[1] + dir[1] * step, o[2] + dir[2] * step];
  }
  return out;
}

// ---------------------------------------------------------------------------
// G2 — the shared contract, in full.
// ---------------------------------------------------------------------------
conformance(gen, 'boxlid');

// ---------------------------------------------------------------------------
// The body (G5)
// ---------------------------------------------------------------------------

{
  const p = { sizeMode: 'inner', width: 100, depth: 60, height: 35, wallT: 1.6, floorT: 2,
    part: 'box', notch: false, baseStyle: 'flat', floorFillet: 0, cornerStyle: 'square' };
  const r = build(p);
  const m = r.mesh, mt = r.meta;

  check('inner mode: the cavity is exactly the size that was asked for',
    mt.inner.w === 100 && mt.inner.d === 60 && mt.inner.h === 35,
    `${mt.inner.w} × ${mt.inner.d} × ${mt.inner.h} mm`);
  near('inner mode: outer width is the cavity plus two walls', mt.outer.w, 100 + 2 * 1.6, 1e-9);
  near('inner mode: outer height is the cavity plus the floor', mt.outer.h, 35 + 2, 1e-9);

  const b = m.bbox();
  near('the mesh really is that big in X', b.size[0], 103.2, 1e-6);
  near('the mesh really is that big in Y', b.size[1], 63.2, 1e-6);
  near('the mesh really is that tall', b.size[2], 37, 1e-6);

  // Probe the cavity: a point 0.02 mm inside each wall must be air and 0.02 mm
  // outside it must be metal. That pins every internal face to within 0.04 mm
  // without believing a single number the generator printed.
  const grid = triGrid(m);
  const zMid = 2 + 35 / 2;
  const probes = [
    ['+X wall', [50 - 0.02, 0, zMid], [50 + 0.02, 0, zMid]],
    ['-X wall', [-50 + 0.02, 0, zMid], [-50 - 0.02, 0, zMid]],
    ['+Y wall', [0, 30 - 0.02, zMid], [0, 30 + 0.02, zMid]],
    ['-Y wall', [0, -30 + 0.02, zMid], [0, -30 - 0.02, zMid]],
    ['floor', [0, 0, 2 + 0.02], [0, 0, 2 - 0.02]],
  ];
  let good = 0;
  const bad = [];
  for (const [name, air, solid] of probes) {
    const a = pointInsideMesh(grid, air), s = pointInsideMesh(grid, solid);
    if (!a && s) good++; else bad.push(`${name}: air=${a} solid=${s}`);
  }
  check('every cavity face is within 0.02 mm of where it was declared', bad.length === 0,
    bad.length ? bad.join(' | ') : `${good}/5 probes: inside is air, outside is material`);

  // and the rim is open at the top
  check('the box is open at the top', !pointInsideMesh(grid, [0, 0, 37 - 0.02]), 'point below the rim, on the axis');

  const wallVol = 103.2 * 63.2 * 37 - 100 * 60 * 35;
  nearPct('the solid volume is the shell and nothing else', m.volume(), wallVol, 0.3);
  volumeAgrees('plain box', m, 6, 3000);
}

{
  const r = build({ sizeMode: 'outer', width: 80, depth: 50, height: 30, wallT: 2, floorT: 3, part: 'box' });
  const mt = r.meta;
  check('outer mode: the footprint is exactly the size that was asked for',
    mt.outer.w === 80 && mt.outer.d === 50 && mt.outer.h === 30, `${mt.outer.w} × ${mt.outer.d} × ${mt.outer.h}`);
  near('outer mode: the cavity is the footprint less two walls', mt.inner.w, 76, 1e-9);
  near('outer mode: the cavity depth is the height less the floor', mt.inner.h, 27, 1e-9);
  near('the mesh footprint matches', r.mesh.bbox().size[0], 80, 1e-6);
}

{
  // The wall defaults to a whole number of extrusions, which is the single
  // most consequential default in the whole generator.
  const wall = gen.params.find(q => q.key === 'wallT');
  const floor = gen.params.find(q => q.key === 'floorT');
  near('the default wall is a whole number of 0.4 mm extrusions', wall.def / 0.4, Math.round(wall.def / 0.4), 1e-9);
  check('the wall steps in whole extrusions', Math.abs(wall.step - 0.4) < 1e-9, `step ${wall.step}`);
  check('the floor is settable independently of the wall', floor.key === 'floorT' && floor.def !== undefined && floor.step !== wall.step,
    `floor def ${floor.def} step ${floor.step}`);
}

{
  const base = { part: 'box', notch: false, width: 60, depth: 60, height: 25, floorFillet: 0 };
  const sq = build({ ...base, cornerStyle: 'square' }).mesh;
  const ch = build({ ...base, cornerStyle: 'chamfer', cornerR: 5 }).mesh;
  const rd = build({ ...base, cornerStyle: 'round', cornerR: 5 }).mesh;
  check('all three corner styles give the same footprint',
    Math.abs(sq.bbox().size[0] - rd.bbox().size[0]) < 1e-6 && Math.abs(ch.bbox().size[0] - rd.bbox().size[0]) < 1e-6,
    `${sq.bbox().size[0].toFixed(2)} / ${ch.bbox().size[0].toFixed(2)} / ${rd.bbox().size[0].toFixed(2)} mm`);
  check('a chamfer removes more corner than a radius, and square removes none',
    sq.volume() > rd.volume() && rd.volume() > ch.volume(),
    `square ${sq.volume().toFixed(0)} > round ${rd.volume().toFixed(0)} > chamfer ${ch.volume().toFixed(0)} mm³`);

  const f0 = build({ ...base, floorFillet: 0 }).mesh;
  const f3 = build({ ...base, floorFillet: 3 }).mesh;
  check('the inside floor radius adds material where the floor meets the wall',
    f3.volume() > f0.volume(), `${f0.volume().toFixed(0)} → ${f3.volume().toFixed(0)} mm³`);
  const gf = triGrid(f3);
  const g = solve({ ...P0, ...base, floorFillet: 3 }, {});
  check('the fillet is a quarter round, not a chamfer: it is tangent to the floor',
    pointInsideMesh(gf, [g.iw / 2 - 0.2, 0, g.floorT + 0.05]) && !pointInsideMesh(gf, [g.iw / 2 - 3.2, 0, g.floorT + 0.05]),
    `material 0.2 mm in from the wall at floor level, air 3.2 mm in (radius ${g.fillet})`);
}

{
  // The stacking spigot: it only stacks if it fits the mouth of the box below.
  const p = { part: 'box', baseStyle: 'stack', width: 70, depth: 70, height: 40, notch: false };
  const r = build(p);
  const g = solve({ ...P0, ...p }, {});
  const m = r.mesh, gr = triGrid(m);
  const spigotHalf = g.W / 2 - g.stackInset;
  const mouthHalf = g.iw / 2;
  check('the stacking spigot fits inside the mouth of another one of these boxes',
    spigotHalf + g.stackFit <= mouthHalf + 1e-9,
    `spigot ${(2 * spigotHalf).toFixed(2)} mm across, mouth ${(2 * mouthHalf).toFixed(2)} mm, clearance ${(2 * (mouthHalf - spigotHalf)).toFixed(2)} mm total`);
  check('the spigot is a real step, measured on the mesh',
    !pointInsideMesh(gr, [spigotHalf + 0.1, 0, 0.4]) && pointInsideMesh(gr, [spigotHalf - 0.1, 0, 0.4]),
    `outer face of the base is at x = ${spigotHalf.toFixed(2)}, full width is ${(g.W / 2).toFixed(2)}`);
  check('the floor is deep enough that the cavity never breaks through the spigot',
    g.floorT >= g.stackH + g.stackFit + 0.399,
    `floor ${g.floorT.toFixed(2)} mm vs spigot ${g.stackH.toFixed(2)} + flare ${g.stackFit.toFixed(2)} mm`);
  check('and the result is still one watertight solid', topology(m).boundary === 0 && m.volume() > 0);
}

{
  // The divider grid, with per-cell spans.
  const p = { part: 'box', divX: 3, divY: 2, divT: 1.2, divColW: '2,1,1', width: 100, depth: 60,
    sizeMode: 'inner', notch: false, floorFillet: 0 };
  const r = build(p);
  const cells = r.meta.cells;
  check('the grid produces one pocket per cell', cells.length === 6, `${cells.length} cells`);
  const row0 = cells.filter(c => Math.abs(c.y - cells[0].y) < 1e-6).sort((a, b) => a.x - b.x);
  nearPct('the per-cell spans are honoured: the first column is twice the second',
    row0[0].w / row0[1].w, 2, 0.5);
  const spanned = row0.reduce((s, c) => s + c.w, 0) + 2 * 1.2;
  near('the cells and the divider walls exactly fill the cavity', spanned, 100, 1e-6);
  const gr = triGrid(r.mesh);
  const wallX = -50 + row0[0].w + 0.6;      // the middle of the first column divider
  const cellY = row0[0].y;                  // inside a row, clear of the row divider
  check('there is real material in the divider wall and air either side of it',
    pointInsideMesh(gr, [wallX, cellY, 20]) &&
    !pointInsideMesh(gr, [wallX - 1.0, cellY, 20]) && !pointInsideMesh(gr, [wallX + 1.0, cellY, 20]),
    `divider centred at x = ${wallX.toFixed(2)}, ${1.2} mm thick, probed at y = ${cellY.toFixed(2)}`);
  check('a divided box holds less than an empty one of the same size',
    r.mesh.volume() > build({ ...p, divX: 1, divY: 1 }).mesh.volume(),
    `${build({ ...p, divX: 1, divY: 1 }).mesh.volume().toFixed(0)} → ${r.mesh.volume().toFixed(0)} mm³ of material`);
}

// ---------------------------------------------------------------------------
// Closure 1 — the friction fit (G4)
// ---------------------------------------------------------------------------

{
  const p = { closure: 'friction', sizeMode: 'inner', width: 80, depth: 55, height: 30,
    wallT: 1.6, clearance: 0.25, lipH: 6, lidT: 1.6, notch: false, baseStyle: 'flat',
    cornerStyle: 'square', floorFillet: 0 };
  // Built one part at a time: the plate packer is free to turn a part 90° to
  // fit it, which is right for printing and useless for measuring.
  const r = build({ ...p, part: 'box' });
  const lidR = build({ ...p, part: 'lid' });
  const box = r.mesh, lid = lidR.mesh;
  const mt = r.meta;

  near('friction: the declared gap per side is the clearance that was asked for', mt.lip.gapPerSide, 0.25, 1e-9);

  // Measure the lip and the cavity off the two meshes with rays and compare.
  const gBox = triGrid(box), gLid = triGrid(lid);
  const cavityHalf = hitAt(gBox, [0, 0, mt.floorT + 10], [1, 0, 0]);
  const lipRoot = allHits(gLid, [0, 0, mt.lidT + mt.lip.height / 2], [1, 0, 0], 100);
  const lipTip = allHits(gLid, [0, 0, mt.lidT + mt.lip.height - 0.1], [1, 0, 0], 100);
  const lipHalfX = lipRoot[lipRoot.length - 1];
  const lipTipHalfX = lipTip[lipTip.length - 1];

  near('friction: the cavity is where the box says it is', cavityHalf, 40, 1e-6);
  near('friction: the lip is exactly one clearance smaller than the cavity, measured on both meshes',
    cavityHalf - lipHalfX, 0.25, 0.005);
  check('friction: the lip is a hollow skirt, not a solid plug',
    lipRoot.length === 2 && lipRoot[1] - lipRoot[0] > 0.5,
    `lip wall ${(lipRoot[1] - lipRoot[0]).toFixed(2)} mm thick at x = ${lipRoot[0].toFixed(2)}..${lipRoot[1].toFixed(2)}`);
  check('friction: the lip has a chamfered lead-in, so it finds the box instead of catching on it',
    lipHalfX - lipTipHalfX > 0.2, `lip tapers ${(lipHalfX - lipTipHalfX).toFixed(2)} mm over the last ${mt.lip.chamfer} mm`);
  near('friction: the lid sits flush with the box, not proud of it', lid.bbox().size[0], box.bbox().size[0], 1e-6);
  near('friction: the lip reaches as far into the box as asked', mt.lip.height, 6, 1e-9);

  // The real test: assembled, the two solids must not interpenetrate.
  const asm = build({ ...p, arrange: 'assembled' });
  const ab = partOf(asm, 'box'), al = partOf(asm, 'lid');
  const cp = crossPairs(ab, al);
  check('friction: box and lid do not interpenetrate when the lid is on',
    cp.count === 0, `${cp.count} intersecting triangle pairs`);
  check('friction: the assembled object is still two clean shells',
    analyze(Mesh.merge([ab, al])).shells === 2, `${analyze(Mesh.merge([ab, al])).shells} shells`);

  // With a divider grid: the skirt drops INSIDE the walls, so dividers that ran
  // to the rim would hold the lid off. Sam found this on a screw organiser
  // (2026-09-03); the interpenetration check above had never been run with
  // dividers, so it never saw it.
  {
    const pd = { ...p, divX: 3, divY: 2 };
    const dasm = build({ ...pd, arrange: 'assembled' });
    const db = partOf(dasm, 'box'), dl = partOf(dasm, 'lid');
    const dcp = crossPairs(db, dl);
    check('friction + dividers: box and lid still do not interpenetrate when the lid is on',
      dcp.count === 0, `${dcp.count} intersecting triangle pairs`);
    const box = build({ ...pd, part: 'box' });
    const mt = box.meta;
    check('friction + dividers: meta says how far below the rim the grid stops',
      mt.grid && mt.grid.belowRim > mt.lip.height, JSON.stringify(mt.grid));
    // A ray across the cavity at y = 0: near the rim it meets only the two
    // outer walls (4 faces); lower down it also crosses the two X dividers (8).
    const gb = triGrid(box.mesh);
    const H = box.mesh.bbox().max[2];
    // y = a quarter of the depth: inside a cell row, not along the Y divider
    // that sits exactly on y = 0 with two rows.
    const yProbe = pd.depth / 4;
    const nearRim = allHits(gb, [-100, yProbe, H - 0.5], [1, 0, 0], 200).length;
    const midBox = allHits(gb, [-100, yProbe, mt.grid.top - 2], [1, 0, 0], 200).length;
    check('friction + dividers: just under the rim the cavity is one open pocket (walls only)',
      nearRim === 4, `${nearRim} faces crossed at z = H − 0.5`);
    check('friction + dividers: below the skirt the dividers are there',
      midBox === 8, `${midBox} faces crossed at z = grid.top − 2`);
    const issues = gen.validate({ ...P0, ...pd }) || [];
    check('friction + dividers: the note tells the user, with the built figure',
      issues.some(i => /stop 6\.6 mm below the rim/.test(i.message)),
      issues.map(i => i.message.slice(0, 60)).join(' | '));
    check('friction, no dividers: no such note',
      !(gen.validate({ ...P0, ...p }) || []).some(i => /below the rim/.test(i.message)));
  }

  // and a tighter clearance really does make a tighter lip
  const tight = build({ ...p, clearance: 0.15, part: 'lid' });
  const tHits = allHits(triGrid(tight.mesh), [0, 0, tight.meta.lidT + tight.meta.lip.height / 2], [1, 0, 0], 100);
  near('friction: changing the clearance moves the lip by exactly that much',
    tHits[tHits.length - 1] - lipHalfX, 0.1, 0.005);
}

// ---------------------------------------------------------------------------
// Closure 2 — the screw top (G4)
// ---------------------------------------------------------------------------

{
  const p = { closure: 'threaded', plan: 'round', sizeMode: 'inner', width: 40, height: 45,
    wallT: 1.6, lidT: 2, threadPitch: 3, threadLen: 9, clearance: 0.3, notch: false };
  const r = build({ ...p, part: 'box' });
  const capR = build({ ...p, part: 'lid' });
  const t = r.meta.thread;

  near('threaded: the minor diameter is the major less twice the thread depth',
    t.minorD, t.majorD - 2 * t.depth, 1e-9);
  check('threaded: the flanks are at 45°, which is the steepest a printer bridges',
    t.flankDeg === 45, `${t.flankDeg}°`);
  check('threaded: there are enough turns to hold', t.turns >= 2, `${t.turns.toFixed(2)} turns of ${t.pitch} mm pitch`);

  // The property that makes a printed screw cap work at all: the profile is
  // symmetric, so the female thread — which is the male one mirrored when the
  // cap is turned over to go on — still mates with it.
  let worst = 0;
  const a = t.depth / t.pitch, c = t.seatFrac - 2 * a;
  for (let i = 0; i <= 200; i++) {
    const s = i / 200;
    worst = Math.max(worst, Math.abs(threadProfile(t.seatFrac - s, a, c) - threadProfile(s, a, c)));
  }
  near('threaded: the thread profile is its own mirror about the crest — a buttress form would not go on',
    worst, 0, 1e-12);

  // Screw the cap home and measure the radial gap all the way round and up.
  const cap = capR.mesh.rotateX(Math.PI).translate(0, 0, t.seat);
  const gb = triGrid(r.mesh), gc = triGrid(cap);
  const r0 = (t.mouthD / 2 + t.minorD / 2) / 2;
  const zLo = t.seat - t.capT - t.skirt + 0.5, zHi = t.neckZ0 + t.length - t.lead - 0.5;
  let mn = Infinity, samples = 0, at = null;
  for (let zi = 0; zi <= 60; zi++) {
    const z = zLo + (zHi - zLo) * zi / 60;
    for (let ti = 0; ti < 180; ti++) {
      const th = Math.PI * 2 * ti / 180, dir = [Math.cos(th), Math.sin(th), 0];
      const o = [r0 * Math.cos(th), r0 * Math.sin(th), z];
      const hb = hitAt(gb, o, dir, 60), hc = hitAt(gc, o, dir, 60);
      if (hb === null || hc === null) continue;
      samples++;
      if (hc - hb < mn) { mn = hc - hb; at = { z: +z.toFixed(2), deg: +(th * 180 / Math.PI).toFixed(0) }; }
    }
  }
  check('threaded: the cap clears the neck everywhere it engages, measured off the two meshes',
    mn >= t.clearance * 0.9, `worst radial gap ${mn.toFixed(4)} mm over ${samples} samples (asked for ${t.clearance}), at ${JSON.stringify(at)}`);
  check('threaded: and it engages over the whole thread, not just the tip',
    zHi - zLo >= 2 * t.pitch, `${(zHi - zLo).toFixed(1)} mm of engagement, ${(2 * t.pitch).toFixed(1)} mm needed for two turns`);
  check('threaded: the cap is flush with the tin, not proud of it',
    Math.abs(cap.bbox().size[0] - r.mesh.bbox().size[0]) < 0.4,
    `cap ${cap.bbox().size[0].toFixed(2)} mm across, tin ${r.mesh.bbox().size[0].toFixed(2)} mm`);
  check('threaded: the cap has grip flutes, and an even number of them so it stays on its own axis',
    t.flutes % 2 === 0 && t.flutes >= 6, `${t.flutes} flutes`);
}

// ---------------------------------------------------------------------------
// Closure 3 — the print-in-place hinge (G4)
// ---------------------------------------------------------------------------

{
  const p = { closure: 'hinged', sizeMode: 'inner', width: 70, depth: 50, height: 18,
    wallT: 1.6, lidT: 1.4, hingeR: 3, hingeCount: 5, hingeFit: 0.4, catchOn: true, notch: false };
  const r = build(p);
  const h = r.meta.hinge;
  const box = partOf(r, 'box'), lid = partOf(r, 'lid');

  check('hinge: the two halves are separate shells — nothing is fused',
    analyze(r.mesh).shells === 2, `${analyze(r.mesh).shells} shells`);
  check('hinge: an odd number of knuckles, so the pin is carried at both ends',
    h.count % 2 === 1, `${h.count} knuckles`);
  near('hinge: the declared pin-to-socket clearance is what was asked for', h.socketR - h.pinR, 0.4, 1e-9);
  check('hinge: the pin-to-socket clearance is at or above the 0.35 mm a 0.4 mm nozzle needs',
    h.socketR - h.pinR >= 0.35 - 1e-9, `${(h.socketR - h.pinR).toFixed(3)} mm`);

  // Measured, not declared: fire rays out from the hinge axis and read off where
  // the pin ends and the socket begins.
  {
    const gb = triGrid(box), gl = triGrid(lid);
    let minGap = Infinity, n = 0;
    for (let s = 1; s < h.count; s += 2) {                  // the lid's slots
      const x = -h.span / 2 + (s + 0.5) * h.slotW;
      for (let ti = 0; ti < 120; ti++) {
        const a = Math.PI * 2 * ti / 120;
        const dir = [0, Math.cos(a), Math.sin(a)];
        const o = [x, h.axisY, h.axisZ];
        const pin = hitAt(gb, o, dir, 40), sock = hitAt(gl, o, dir, 40);
        if (pin === null || sock === null) continue;
        n++;
        if (sock - pin < minGap) minGap = sock - pin;
      }
    }
    check('hinge: measured on the meshes, the pin never comes within 0.35 mm of its socket',
      minGap >= 0.35 - 1e-6, `worst gap ${minGap.toFixed(4)} mm over ${n} rays around the pin`);
  }

  // Knuckle to knuckle along the pin: the other way a hinge fuses. Fire one ray
  // straight along the hinge axis, offset out to halfway between the pin and the
  // knuckle skin, and read off where each part's material starts and stops.
  {
    const rMid = (h.pinR + h.knuckleR) / 2;
    const gb = triGrid(box), gl = triGrid(lid);
    // Below the axis, not above: the socket is a teardrop, and its 45° roof
    // reaches out to socketR * sqrt(2) on the upper side.
    const y = h.axisY, z = h.axisZ - rMid;
    const x0 = -h.span / 2 - 5;
    const dir = [1, 0, 0];
    const spanTo = h.span + 10;
    const bh = allHits(gb, [x0, y, z], dir, spanTo).map(t => x0 + t);
    const lh = allHits(gl, [x0, y, z], dir, spanTo).map(t => x0 + t);
    const runs = [];
    for (let i = 0; i + 1 < bh.length; i += 2) runs.push({ who: 'box', a: bh[i], b: bh[i + 1] });
    for (let i = 0; i + 1 < lh.length; i += 2) runs.push({ who: 'lid', a: lh[i], b: lh[i + 1] });
    runs.sort((p1, p2) => p1.a - p2.a);
    let worst = Infinity, gaps = 0;
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].who === runs[i - 1].who) continue;
      gaps++;
      worst = Math.min(worst, runs[i].a - runs[i - 1].b);
    }
    check('hinge: the knuckles alternate box, lid, box along the pin',
      runs.length === h.count && runs.every((r2, i) => r2.who === (i % 2 === 0 ? 'box' : 'lid')),
      runs.map(r2 => `${r2.who}[${r2.a.toFixed(1)}..${r2.b.toFixed(1)}]`).join(' '));
    check('hinge: knuckle to knuckle along the pin is at least 0.35 mm too',
      gaps >= h.count - 1 && worst >= 0.35 - 1e-6,
      `${gaps} gaps, narrowest ${worst.toFixed(4)} mm, measured at radius ${rMid.toFixed(2)} mm from the axis`);
  }

  // The range of motion, checked triangle against triangle.
  const rimZ = h.axisZ;
  for (const open of [180, 90, 45]) {
    const L = atAngle(lid, h, open);
    const cp = crossPairs(box, L);
    check(`hinge: nothing touches at ${open}° open`, cp.count === 0, `${cp.count} intersecting triangle pairs`);
  }
  {
    const L = atAngle(lid, h, 0);
    const cp = crossPairs(box, L, {
      classify: (va, vb) => {
        const [amn, amx] = triBox(va), [bmn, bmx] = triBox(vb);
        return amn[2] <= rimZ + 1e-6 && amx[2] >= rimZ - 1e-6 && bmn[2] <= rimZ + 1e-6 && bmx[2] >= rimZ - 1e-6;
      },
    });
    check('hinge: shut, the two halves meet on the rim plane and nowhere else',
      cp.flagged === 0, `${cp.count} contact pairs, ${cp.flagged} of them away from z = ${rimZ.toFixed(2)}`);
    const closed = Mesh.merge([box, L]);
    near('hinge: shut, the object is exactly twice one half tall', closed.bbox().size[2], 2 * h.closedHeight / 2, 1e-6);
  }

  // The catch.
  const cat = h.catch;
  check('hinge: the snap catch stands proud enough to reach into its groove',
    cat && cat.proj > 0.2 && cat.grooveDepth > cat.proj,
    `bead ${cat.proj.toFixed(2)} mm proud, groove ${cat.grooveDepth.toFixed(2)} mm deep`);
  const noCatch = build({ ...p, catchOn: false });
  check('hinge: turning the catch off actually removes it',
    noCatch.mesh.volume() !== r.mesh.volume() && noCatch.meta.hinge.catch === null,
    `${noCatch.mesh.volume().toFixed(0)} vs ${r.mesh.volume().toFixed(0)} mm³`);

  // A clearance the machine cannot print is refused, not obeyed.
  const tight = solve({ ...P0, ...p, hingeFit: 0.2 }, {});
  near('hinge: a clearance below 0.35 mm is raised rather than built', tight.hg.fit, 0.35, 1e-9);
  check('hinge: and the user is told that it was raised',
    gen.validate({ ...P0, ...p, hingeFit: 0.2 }).some(i => i.param === 'hingeFit' && i.severity === 'error'),
    JSON.stringify(gen.validate({ ...P0, ...p, hingeFit: 0.2 }).find(i => i.param === 'hingeFit')?.message || '').slice(0, 80));
}

// ---------------------------------------------------------------------------
// The details a real box needs (G6)
// ---------------------------------------------------------------------------

{
  const p = { part: 'box', notch: true, notchW: 26, notchD: 5, width: 90, depth: 60, height: 30,
    sizeMode: 'inner', cornerStyle: 'square', baseStyle: 'flat' };
  const r = build(p);
  const g = solve({ ...P0, ...p }, {});
  const gr = triGrid(r.mesh);
  const y = -g.D / 2 + g.wallT / 2;
  check('finger notch: the front rim is cut down where the notch is',
    !pointInsideMesh(gr, [0, y, g.H - 0.2]) && pointInsideMesh(gr, [0, y, g.H - g.notchD - 0.2]),
    `rim at x = 0 is open from z = ${(g.H - g.notchD).toFixed(1)} to ${g.H}, solid below it`);
  check('finger notch: and untouched either side of it',
    pointInsideMesh(gr, [g.notchW / 2 + 4, y, g.H - 0.2]) && pointInsideMesh(gr, [-g.notchW / 2 - 4, y, g.H - 0.2]),
    `full-height rim ${(g.notchW / 2 + 4).toFixed(1)} mm off centre`);
  const plain = build({ ...p, notch: false });
  check('finger notch: it takes material away rather than adding it',
    r.mesh.volume() < plain.mesh.volume(),
    `${plain.mesh.volume().toFixed(0)} → ${r.mesh.volume().toFixed(0)} mm³`);
}

{
  const p = { part: 'box', vents: 'all', ventCount: 4, width: 90, depth: 60, height: 40,
    sizeMode: 'inner', notch: false, cornerStyle: 'square', floorFillet: 0 };
  const r = build(p);
  const g = solve({ ...P0, ...p }, {});
  const plain = build({ ...p, vents: 'none' });
  check('vents: the slots go right through the wall',
    r.mesh.volume() < plain.mesh.volume(),
    `${plain.mesh.volume().toFixed(0)} → ${r.mesh.volume().toFixed(0)} mm³ of material`);
  const gr = triGrid(r.mesh);
  const zMid = (g.floorT + Math.max(1.6, g.fillet + 0.8) + g.H - Math.max(1.6, g.wallT + 0.8)) / 2;
  const holes = [];
  for (let x = -g.W / 2; x < g.W / 2; x += 0.25) {
    if (!pointInsideMesh(gr, [x, -g.D / 2 + g.wallT / 2, zMid])) holes.push(x);
  }
  const runs = holes.reduce((acc, x) => {
    const last = acc[acc.length - 1];
    if (last && x - last.end < 0.4) { last.end = x; return acc; }
    acc.push({ start: x, end: x }); return acc;
  }, []);
  check('vents: there is a hole in the front wall for each slot asked for',
    runs.length === g.ventCount, `${runs.length} openings across the front wall, ${g.ventCount} requested`);
  check('vents: an arch, not a circle — the slots are taller than they are wide',
    r.meta.vents.mode === 'all', `mode ${r.meta.vents.mode}`);
}

{
  const p = { part: 'box', label: 'front', labelW: 44, labelH: 14, labelDepth: 0.8,
    width: 90, depth: 60, height: 34, sizeMode: 'inner', notch: false, cornerStyle: 'square' };
  const r = build(p);
  const g = solve({ ...P0, ...p }, {});
  const gr = triGrid(r.mesh);
  const zc = (function labelCentre() {
    const top = g.H - Math.max(1.5, g.wallT + 0.5), bot = g.floorT + 1.5;
    return Math.min(Math.max((top + bot) / 2, bot + g.labelH / 2), Math.max(bot + g.labelH / 2, top - g.labelH / 2));
  })();
  const inPanel = hitAt(gr, [0, -g.D / 2 - 5, zc], [0, 1, 0]);
  const beside = hitAt(gr, [g.labelW / 2 + 5, -g.D / 2 - 5, zc], [0, 1, 0]);
  near('label recess: the panel is exactly as deep as asked', inPanel - beside, 0.8, 0.02);
  check('label recess: and it does not go through the wall',
    inPanel - beside < g.wallT, `${(inPanel - beside).toFixed(2)} mm recess in a ${g.wallT} mm wall`);
  const lidLabel = build({ ...p, part: 'lid', label: 'lid' });
  check('label recess: the lid can carry it too', lidLabel.mesh.volume() < build({ ...p, part: 'lid', label: 'none' }).mesh.volume(),
    `${build({ ...p, part: 'lid', label: 'none' }).mesh.volume().toFixed(0)} → ${lidLabel.mesh.volume().toFixed(0)} mm³`);
}

{
  const p = { part: 'box', mounts: 'screws', mountDia: 3.4, floorT: 2.4, width: 80, depth: 60,
    height: 25, sizeMode: 'inner', notch: false, floorFillet: 0 };
  const r = build(p);
  const g = solve({ ...P0, ...p }, {});
  const gr = triGrid(r.mesh);
  const pts = r.meta.mounts;
  check('screw mounts: there are holes, and they are counted', pts.kind === 'screws' && pts.count >= 2, `${pts.count} holes`);
  const [mx, my] = [g.iw / 2 - (1.7 + 1.5), g.id / 2 - (1.7 + 1.5)];
  const under = hitAt(gr, [mx, my, -5], [0, 0, 1]);
  check('screw mounts: the hole goes right through the floor',
    under === null || under > 5 + g.floorT - 1e-6,
    under === null ? 'a ray straight up through the mount point meets nothing' : `first hit ${(under - 5).toFixed(2)} mm above the plate`);
  // Countersunk means the hole is wider at the top of the floor than at the
  // bottom — measure both, do not take the parameter's word for it.
  {
    const across = (z) => {
      const hits = allHits(gr, [mx - 6, my, z], [1, 0, 0], 12);
      return hits.length >= 2 ? (hits[hits.length - 1] - hits[0]) : 0;
    };
    const low = across(0.15), high = across(g.floorT - 0.15);
    check('screw mounts: countersunk, so a flat head sits flush and nothing needs support',
      high > low + 0.4 && low > 0,
      `${low.toFixed(2)} mm across at the bed, ${high.toFixed(2)} mm at the top of the floor`);
  }

  const mag = build({ ...p, mounts: 'magnets', mountDia: 8, magnetT: 2, floorT: 3.2 });
  const gm = triGrid(mag.mesh), gg = solve({ ...P0, ...p, mounts: 'magnets', mountDia: 8, magnetT: 2, floorT: 3.2 }, {});
  near('magnet mounts: the pocket is the thickness of the magnet', mag.meta.mounts.pocketDepth, 2, 1e-9);
  check('magnet mounts: the pocket opens upward into the box, so there is nothing to bridge',
    !pointInsideMesh(gm, [gg.iw / 2 - 5.5, gg.id / 2 - 5.5, gg.floorT - 0.1]) &&
    pointInsideMesh(gm, [gg.iw / 2 - 5.5, gg.id / 2 - 5.5, 0.2]),
    `air at ${(gg.floorT - 0.1).toFixed(2)} mm, material at 0.2 mm — ${(gg.floorT - 2).toFixed(2)} mm left under the magnet`);
  check('magnet mounts: at least 0.6 mm of floor is left under the magnet',
    gg.floorT - mag.meta.mounts.pocketDepth >= 0.6 - 1e-9,
    `${(gg.floorT - mag.meta.mounts.pocketDepth).toFixed(2)} mm`);
}

{
  // The plate: box beside lid, both flat, one print.
  const r = build({ closure: 'friction', arrange: 'plate', part: 'both', width: 70, depth: 50, height: 30 });
  const pl = r.meta.plate;
  check('plate: both parts are laid out on it', pl.parts.length === 2, `${pl.parts.length} parts`);
  const [a, b] = pl.parts;
  const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9 && Math.abs(a.y - b.y) < (a.d + b.d) / 2 - 1e-9;
  check('plate: the two footprints do not overlap', !overlap && !pl.overlap,
    `${a.name} ${a.w.toFixed(1)}×${a.d.toFixed(1)} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}), ${b.name} ${b.w.toFixed(1)}×${b.d.toFixed(1)} at (${b.x.toFixed(1)}, ${b.y.toFixed(1)})`);
  const s = r.mesh.bbox().size;
  check('plate: and the whole plate fits the A1 mini bed',
    pl.fitsBed && s[0] <= 180 && s[1] <= 180 && s[2] <= 180, `${s.map(v => v.toFixed(1)).join(' × ')} mm`);
  check('plate: every part is lying flat on the bed',
    r.parts.every(pt => Math.abs(pt.mesh.bbox().min[2]) < 1e-6),
    r.parts.map(pt => pt.mesh.bbox().min[2].toFixed(6)).join(', '));

  const big = build({ closure: 'friction', arrange: 'plate', part: 'both', sizeMode: 'outer', width: 170, depth: 170, height: 40 });
  const bp = big.meta.plate;
  check('plate: a box too big to share a plate with its lid is reported, not silently overlapped',
    !bp.overlap && gen.validate({ ...P0, closure: 'friction', arrange: 'plate', part: 'both', sizeMode: 'outer', width: 170, depth: 170, height: 40 })
      .some(i => i.severity === 'error'),
    `${big.mesh.bbox().size.map(v => v.toFixed(0)).join(' × ')} mm, overlap ${bp.overlap}`);
}

// ---------------------------------------------------------------------------
// Presets (G7)
// ---------------------------------------------------------------------------

{
  check('there are at least four presets', gen.presets.length >= 4, `${gen.presets.length}`);
  const named = gen.presets.every(pr => !/^preset|^\d|^[A-Z]$/i.test(pr.name.trim()) && /[a-z]/.test(pr.name) && pr.name.length > 4);
  check('every preset is named for what it is for, not for its parameters',
    named, gen.presets.map(pr => pr.name).join(' · '));
  const closures = new Set(gen.presets.map(pr => ({ ...P0, ...pr.values }).closure));
  check('the presets show off all three closures', closures.size === 3, [...closures].join(', '));
  const vols = gen.presets.map(pr => Math.round(build(pr.values).mesh.volume()));
  check('every preset is a different object', new Set(vols).size === gen.presets.length,
    vols.join(', ') + ' mm³');
  let clean = 0;
  const dirty = [];
  for (const pr of gen.presets) {
    const issues = gen.validate({ ...P0, ...pr.values }).filter(i => i.severity === 'error');
    if (issues.length) dirty.push(`${pr.name}: ${issues[0].message.slice(0, 50)}`); else clean++;
  }
  check('no preset ships with an error against it', dirty.length === 0, dirty.length ? dirty.join(' | ') : `${clean}/${gen.presets.length} clean`);
  const fits = gen.presets.every(pr => {
    const s = build(pr.values).mesh.bbox().size;
    return s[0] <= 180 && s[1] <= 180 && s[2] <= 180;
  });
  check('every preset fits on the bed as laid out', fits);
}

// ---------------------------------------------------------------------------
// Printability (G8)
// ---------------------------------------------------------------------------

{
  const h = gen.hints(P0);
  check('hints() gives a layer height, a perimeter count, an infill and a filament',
    typeof h.layerH === 'number' && typeof h.perimeters === 'number' &&
    typeof h.infill === 'number' && typeof h.filament === 'string' && typeof h.supports === 'boolean',
    `${h.layerH} mm / ${h.perimeters} walls / ${h.infill}% / ${h.filament} / supports ${h.supports}`);
  check('hints() says why, not just what', h.notes.length >= 5 && h.notes.every(n => n.length > 40),
    `${h.notes.length} notes, shortest ${Math.min(...h.notes.map(n => n.length))} chars`);
  check('hints() ties the perimeter count to the wall thickness',
    h.perimeters === Math.max(2, Math.round(P0.wallT / 0.4)), `${h.perimeters} perimeters for a ${P0.wallT} mm wall`);
  check('hints() tells you what to do when the first lid comes out tight',
    h.notes.some(n => /0\.05/.test(n) && /clearance/i.test(n)),
    h.notes.find(n => /0\.05/.test(n))?.slice(0, 80) || 'no note about adjusting the fit');
  const hh = gen.hints({ ...P0, closure: 'hinged' });
  check('hints() gives the hinge its own advice, including no supports',
    hh.supports === false && hh.notes.some(n => /flat open/i.test(n)) && hh.layerH < h.layerH,
    `${hh.layerH} mm layers, supports ${hh.supports}`);
}

{
  const bad = { ...P0, clearance: 0.05 };
  const issues = gen.validate(bad);
  check('validate() refuses a clearance that will weld the lid to the box',
    issues.some(i => i.param === 'clearance' && i.severity === 'error'),
    issues.find(i => i.param === 'clearance')?.message.slice(0, 90) || 'nothing said');
  check('...and the build still returns a solid rather than throwing',
    topology(build({ clearance: 0.05 }).mesh).boundary === 0);

  const thinWall = gen.validate({ ...P0, wallT: 0.4 });
  check('validate() refuses a wall under two extrusions',
    thinWall.some(i => i.param === 'wallT' && i.severity === 'error'),
    thinWall.find(i => i.param === 'wallT')?.message.slice(0, 80) || 'nothing said');

  const thinFloorMagnets = gen.validate({ ...P0, mounts: 'magnets', magnetT: 4, floorT: 1.6 });
  check('validate() refuses a magnet deeper than the floor it goes into',
    thinFloorMagnets.some(i => i.severity === 'error'),
    thinFloorMagnets.find(i => i.severity === 'error')?.message.slice(0, 90) || 'nothing said');

  const halfExtrusion = gen.validate({ ...P0, wallT: 1.4 });
  check('validate() warns about a wall that is not a whole number of extrusions',
    halfExtrusion.some(i => i.param === 'wallT' && i.severity === 'warn'),
    halfExtrusion.find(i => i.param === 'wallT')?.message.slice(0, 90) || 'nothing said');

  check('validate() is silent at the defaults',
    gen.validate(P0).filter(i => i.severity === 'error').length === 0,
    JSON.stringify(gen.validate(P0).map(i => i.message.slice(0, 40))));
}

{
  const r = build({ notch: true });
  const pr = printability(r.mesh, { bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2 });
  check('the default box passes printability: it fits the bed', pr.fitsBed,
    `${pr.footprint.x.toFixed(0)} × ${pr.footprint.y.toFixed(0)} × ${pr.height.toFixed(0)} mm, ${pr.estGrams.toFixed(1)} g`);
  check('the default box needs no supports: nothing overhangs past 50°',
    pr.overhangPct < 1, `${pr.overhangPct.toFixed(3)}% of the surface overhangs, worst ${pr.worstOverhangDeg.toFixed(1)}°`);
  const hinged = printability(build({ closure: 'hinged' }).mesh);
  check('the clamshell needs no supports either, printed flat open as it comes',
    hinged.overhangPct < 6, `${hinged.overhangPct.toFixed(2)}% overhanging, worst ${hinged.worstOverhangDeg.toFixed(1)}°`);
  const a = analyze(r.mesh);
  check('and the whole thing is manifold and watertight by validate.js as well',
    a.manifold && a.watertight && a.boundaryEdges === 0,
    `manifold ${a.manifold}, boundary ${a.boundaryEdges}, shells ${a.shells}`);
}

// ---- dimension callouts sit on the features they name ----------------------
{
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const len3 = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const within = (q, b, tol = 0.01) => [0, 1, 2].every(ax => q[ax] >= b.min[ax] - tol && q[ax] <= b.max[ax] + tol);
  const r0 = build();
  const notch = r0.meta.dims.find(d => d.param === 'notchW');
  const boxB = partOf(r0, 'box').bbox();
  check('the notch-width callout spans 24 mm along the box rim, at rim height, on the packed box',
    !!notch && eq(len3(notch), 24) && eq(notch.from[2], 41.6) && eq(notch.to[2], 41.6)
    && within(notch.from, boxB) && within(notch.to, boxB),
    notch ? `${notch.from.map(v => v.toFixed(2))} → ${notch.to.map(v => v.toFixed(2))}` : 'missing');
  const lip = r0.meta.dims.find(d => d.param === 'lipH');
  const lidB = partOf(r0, 'lid').bbox();
  check('the lip callout rises 5 mm from the lid plate on the face-down lid',
    !!lip && eq(len3(lip), 5) && eq(lip.from[2], 1.6) && eq(lip.to[2], 6.6) && within(lip.from, lidB) && within(lip.to, lidB),
    lip ? `${lip.from.map(v => v.toFixed(2))} → ${lip.to.map(v => v.toFixed(2))}` : 'missing');
  const jar = gen.presets.find(pr => /pill jar/.test(pr.name)).values;
  const rj = build(jar);
  const thread = rj.meta.dims.find(d => d.param === 'threadLen');
  const jarB = partOf(rj, 'box').bbox();
  check('the thread-length callout runs the 9 mm of neck below the jar rim',
    !!thread && eq(len3(thread), 9) && eq(thread.to[2], 47.6) && eq(thread.from[2], 38.6)
    && within(thread.from, jarB) && within(thread.to, jarB),
    thread ? `${thread.from.map(v => v.toFixed(2))} → ${thread.to.map(v => v.toFixed(2))}` : 'missing');
}

done();
