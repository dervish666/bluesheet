// Stitched legs: a leg is a branch of its segment's own tube. Task 19.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, done } from './lib/assert.mjs';
import { ctx, defaults } from './lib/genconform.mjs';
import { isSolid, topology } from './lib/meshcheck.mjs';
import { shellCount, jointGateHolds, minShellGap } from './lib/gapcheck.mjs';
import { freeSwing } from './lib/swing.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { LEG_LOFTS, REACH_PAST_SPINE, segmentsOf, spineOf, partsOf, SPECIES } from '../js/gen/creature.js';

suite('gen creature legs');

const D = defaults(gen);
const R = D.bodyR;
const legged = (limbKind, over = {}) => ({ ...D, segments: 3, pose: 'straight', head: 'none', tail: 'nub', dorsal: 'none',
  limbPairs: 1, limbKind, limbAt: [0.5], segLen: 15, ...over });

// Triangle pairs that cross, sharing no vertex: the stitched legs are never
// checked by a boolean, so a crossing would ship as a solid that prints wrong.
// Falsified on two overlapping spheres while writing this (56 pairs).
function crossings(m) {
  const P = m.positions, n = m.triCount, V = i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const hits = (p0, p1, t) => {
    const d = sub(p1, p0), e1 = sub(t[1], t[0]), e2 = sub(t[2], t[0]), h = cross(d, e2), a = dot(e1, h);
    if (Math.abs(a) < 1e-12) return false;
    const f = 1 / a, s = sub(p0, t[0]), u = f * dot(s, h); if (u < 1e-7 || u > 1 - 1e-7) return false;
    const q = cross(s, e1), v = f * dot(d, q); if (v < 1e-7 || u + v > 1 - 1e-7) return false;
    const tt = f * dot(e2, q); return tt > 1e-7 && tt < 1 - 1e-7;
  };
  const cell = 1.5, grid = new Map();
  for (let i = 0; i < n; i++) {
    const pts = m.tri(i).map(V);
    const lo = [0, 1, 2].map(k => Math.floor(Math.min(...pts.map(p => p[k])) / cell));
    const hi = [0, 1, 2].map(k => Math.floor(Math.max(...pts.map(p => p[k])) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = `${x},${y},${z}`; (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
  }
  let count = 0; const seen = new Set();
  for (const list of grid.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const i = list[a], j = list[b], key = i * 1e7 + j;
    if (seen.has(key)) continue; seen.add(key);
    const ti = m.tri(i), tj = m.tri(j);
    if (ti.some(v => tj.includes(v))) continue;
    const A = ti.map(V), B = tj.map(V);
    if ([0, 1, 2].some(k => hits(A[k], A[(k + 1) % 3], B)) || [0, 1, 2].some(k => hits(B[k], B[(k + 1) % 3], A))) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Every stitched kind, both seams, every quality: the legged segment is ONE
// solid of genus 0 (Euler 2). A leg unioned on as well as stitched made
// handles and read Euler -2 while passing every other check.
// ---------------------------------------------------------------------------
for (const q of ['draft', 'normal', 'fine']) {
  const C = ctx(q);
  for (const kind of Object.keys(LEG_LOFTS)) for (const seams of ['nested', 'open']) {
    const segs = segmentsOf(legged(kind, { seams }), C);
    isSolid(`${kind}, ${seams}, ${q}`, segs[1], { euler: 2 });
    const m = Mesh.merge(segs);
    check(`${kind}, ${seams}, ${q}: 3 pieces, gap gate held`, jointGateHolds(m, 3, D.clearance),
      `${shellCount(m)} shells, ${minShellGap(m).min.toFixed(4)} mm`);
  }
}

{
  const C = ctx('normal');
  for (const kind of Object.keys(LEG_LOFTS)) {
    const p = legged(kind, { seams: 'nested' });
    const segs = segmentsOf(p, C), leg = segs[1], b = leg.bbox();
    check(`${kind}: no triangles cross`, crossings(leg) === 0);
    check(`${kind}: the feet are on the plate`, Math.abs(b.min[2]) < 1e-6, `${b.min[2]}`);
    // A straight body along x: the legs stand out beside it, inside the pad.
    const y = Math.max(-b.min[1], b.max[1]);
    check(`${kind}: the feet stand clear of the body`, y > 1.5 * R, `${(y / R).toFixed(2)} bodyR`);
    check(`${kind}: and inside the fitter's sideways pad`, y < REACH_PAST_SPINE * R, `${(y / R).toFixed(2)} bodyR`);
    // The foot on the plate: on one side, the points at z = 0 about their
    // own centre (the foot's fan centre is one of them). The toes reach well
    // past the pad's round; toes as long as the pad fail this (mutation).
    const L = LEG_LOFTS[kind], P = leg.positions, foot = [];
    for (let i = 0; i < leg.vertCount; i++) if (Math.abs(P[3 * i + 2]) < 1e-6 && P[3 * i + 1] > R) foot.push([P[3 * i], P[3 * i + 1]]);
    const cx = foot.reduce((s, q) => s + q[0], 0) / foot.length, cy = foot.reduce((s, q) => s + q[1], 0) / foot.length;
    const reach = Math.max(...foot.map(([x, yy]) => Math.hypot(x - cx, yy - cy)));
    check(`${kind}: the toes reach past the pad`, reach > (L.pad + 0.5 * (Math.max(...L.toes.map(t => t[1])) - L.pad)) * R,
      `${(reach / R).toFixed(2)} bodyR from the foot's centre, pad ${L.pad}`);
    // Legs cost no bend.
    const bare = legged(kind, { seams: 'nested', limbPairs: 0 });
    const fb = freeSwing(bare, C, 0, { max: 40 }), fl = freeSwing(p, C, 0, { max: 40 });
    check(`${kind}: joint 0 bends as far with legs as without`, fl.free >= fb.free, `${fl.free} vs ${fb.free} degrees`);
  }

  // THE GATE. A leg is stitched only where nothing else on the segment is a
  // boolean; there the segment wears its crown. On open seams (a socket to
  // carve) the leg stays the unioned part and the segment stays uncrowned.
  const top = over => segmentsOf(legged('clawed', over), C)[1].bbox().max[2];
  const flat = top({ seams: 'nested' });
  check('nested: the legged segment wears its crown', top({ seams: 'nested', dorsal: 'crown' }) > flat + 0.3 * R,
    `${top({ seams: 'nested', dorsal: 'crown' }).toFixed(2)} vs ${flat.toFixed(2)}`);
  check('FALSIFIER: open seams keep the unioned leg and no crown', Math.abs(top({ seams: 'open', dorsal: 'crown' }) - top({ seams: 'open' })) < 1e-6);
  // And the unioned fallback for a stitched kind is the clawed part, not a stub.
  const { stations } = spineOf(legged('splayed'), C);
  const spans = stations.slice(0, -1).map(() => ({ from: 0.5, to: 14 }));
  const asPart = partsOf(legged('splayed'), C, stations, spans)[1].filter(m => !m.isEmpty());
  const clawPart = partsOf(legged('clawed'), C, stations, spans)[1].filter(m => !m.isEmpty());
  check('a splayed leg that must be a part is built as the clawed part', asPart.length === 2 &&
    Math.abs(asPart[0].volume() - clawPart[0].volume()) < 1e-6, `${asPart.length} parts`);
  check('and none where the segment grows its own', partsOf(legged('splayed'), C, stations, spans, spans, new Set([1]))[1].length === 0);

  const by = Object.fromEntries(SPECIES.map(s => [s.id, s]));
  check('the dragon walks on clawed legs and the lizard on splayed ones',
    by.dragon.limbs.kind === 'clawed' && by.lizard.limbs.kind === 'splayed');
}

done();
