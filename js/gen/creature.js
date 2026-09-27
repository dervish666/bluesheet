// js/gen/creature.js — print-in-place articulated creatures.
//
// A body lofted along a spine, cut into segments, with a joint between each
// pair. It comes off the plate in one print and bends.
//
// THE POSE IS NOT THE SHAPE. Because every joint moves, the curve the creature
// is printed along is only how it fits the bed — a coiled dragon straightens
// out in your hand. So the pose is a parameter, and when the chosen pose
// overflows the bed the fitter tightens it rather than shortening the animal.
import { Mesh, TAU } from '../kernel/mesh.js';
import { sphere, capsule, cylinder, cone, box, roundedBox, extrude, parallelFrames } from '../kernel/builders.js';
import { union, unionAll, subtract, intersect } from '../kernel/csg.js';
import { clamp, num, segScale, DEG } from '../kernel/scalar.js';
import { joint, ballGeometry, hingeGeometry, nestedSeam, toFrame, JOINT_KINDS } from '../kernel/joint.js';
import { fit, fitNote } from '../kernel/fit.js';
import { loadFont, layoutText } from '../kernel/text.js';

// The gauge prints its numbers, so this generator loads one face at module
// load (build() must stay synchronous), the same pattern coaster, datasculpt,
// lithophane and cookiecutter each carry. DejaVu Sans Mono: even stroke weight
// is what survives at a 3 mm cap height on a 0.4 mm nozzle. A face that will
// not load costs the gauge its numbers, never the catalogue its creature.
let GAUGE_FONT = null, GAUGE_FONT_ERROR = null;
{
  try {
    const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    const url = new URL('../../assets/fonts/DejaVuSansMono.ttf', import.meta.url);
    let bytes;
    if (isNode) {
      const [{ readFileSync }, { fileURLToPath }] = await Promise.all([import('node:fs'), import('node:url')]);
      bytes = readFileSync(fileURLToPath(url));
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    }
    GAUGE_FONT = loadFont(bytes);
  } catch (e) {
    GAUGE_FONT_ERROR = String((e && e.message) || e);
  }
}

// Local, deliberately not hoisted to scalar.js — see docs/writing-a-generator.md.
const lerp = (a, b, t) => a + (b - a) * t;
const nseg = (n, sf) => Math.max(8, Math.round(n * sf));

// ---------------------------------------------------------------------------
// Poses. Each returns a path of the requested ARC LENGTH, centred on the
// origin, in the z = 0 plane. The fitter varies `tight` to trade span for
// curvature; 0 is the loosest form of each pose and 1 the tightest.
// ---------------------------------------------------------------------------
export const POSES = {
  straight(len, { samples = 128 } = {}) {
    const out = [];
    for (let i = 0; i <= samples; i++) out.push([lerp(-len / 2, len / 2, i / samples), 0, 0]);
    return out;
  },

  // A straight creature laid corner to corner. A 180 mm bed is 254 mm across
  // its diagonal, so this is the pose that prints the longest animal, and it
  // is the DEFAULT for that reason: it costs nothing, it bends the same in the
  // hand, and it lets the head and tail be the size they should be instead of
  // the size that fits along one edge.
  diagonal(len, opts = {}) {
    return POSES.straight(len, opts).map(([x, y, z]) => [x * Math.SQRT1_2, x * Math.SQRT1_2, z]);
  },

  scurve(len, { tight = 0.5, samples = 256, radius = 9, segLen = 14 } = {}) {
    // Limit curvature before sampling: a thick tube cannot follow an arbitrarily
    // sharp sine without folding inside out. The minimum radius also leaves room
    // for later joint placement (the pose fitter will use the declared limit).
    const minR = Math.max(1.5 * radius, segLen * 2.5);
    let low = 0, high = lerp(0.08, 0.28, clamp(tight, 0, 1));
    const at = amp => arcNormalised(samples, u => [u - 0.5, amp * Math.sin(TAU * u), 0], len);
    for (let i = 0; i < 24; i++) {
      const amp = (low + high) / 2, trial = at(amp);
      const span = trial.at(-1)[0] - trial[0][0];
      if (span / (amp * TAU * TAU) >= minR) low = amp; else high = amp;
    }
    const path = at(low);
    return path;
  },

  coil(len, { tight = 0.5, samples = 512, radius = 9, segLen = 14 } = {}) {
    // Fixed physical pitch prevents neighbouring turns from passing through
    // each other. Scaling a fixed-turn spiral to length also scales its pitch;
    // the brief's 2.4-turn default leaves only ~5 mm between 18 mm bodies.
    const pitch = 2 * radius + 2;
    const inner = Math.max(1.5 * radius, segLen * 2.5) * lerp(1.5, 1, clamp(tight, 0, 1));
    const point = theta => [(inner + pitch * theta / TAU) * Math.cos(theta),
                            (inner + pitch * theta / TAU) * Math.sin(theta), 0];
    const sample = angle => Array.from({ length: samples + 1 }, (_, i) => point(angle * i / samples));
    const length = path => path.slice(1).reduce((sum, p, i) => sum +
      Math.hypot(...p.map((v, k) => v - path[i][k])), 0);
    let low = 0, high = len / inner;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (length(sample(mid)) < len) low = mid; else high = mid;
    }
    const path = sample((low + high) / 2);
    const c = [0, 1, 2].map(k => path.reduce((sum, p) => sum + p[k], 0) / path.length);
    return path.map(p => p.map((v, k) => v - c[k]));
  },
};

/** Sample a unit-ish parametric curve, then scale it so its arc length is `len`
 *  and its centroid is the origin. Keeps every pose honest about its length. */
function arcNormalised(samples, f, len) {
  const raw = [];
  for (let i = 0; i <= samples; i++) raw.push(f(i / samples));
  let arc = 0;
  for (let i = 1; i < raw.length; i++) arc += Math.hypot(...raw[i].map((v, k) => v - raw[i - 1][k]));
  const s = len / arc;
  const c = [0, 1, 2].map(k => raw.reduce((t, q) => t + q[k], 0) / raw.length);
  return raw.map(q => [(q[0] - c[0]) * s, (q[1] - c[1]) * s, (q[2] - c[2]) * s]);
}

// ---------------------------------------------------------------------------
// Body profiles: a multiplier on bodyR as a function of u along the spine.
// ---------------------------------------------------------------------------
export const PROFILES = {
  // 0.45, not 0.62: a steeper taper starves the last joint of socket wall. At
  // 0.62 the dragon's own tail station leaves -0.13 mm of wall and the default
  // creature fails its own validate() rule.
  tapered: (u) => 1 - 0.45 * u * u,
  barrel:  (u) => 0.70 + 0.42 * Math.sin(Math.PI * clamp(u, 0, 1)),
  flat:    () => 1,
  ribbed:  (u) => (1 - 0.30 * u) * (1 + 0.10 * Math.sin(TAU * 6 * u)),
  // A capybara: full at the head end so the head sits on the body instead of
  // on a neck (the barrel pinches to 0.70 there), fattest a third of the way
  // back, rounding to 0.95 at the rump.
  loaf:    (u) => 0.95 + 0.17 * Math.sin(Math.PI * (0.2 + 0.8 * clamp(u, 0, 1))),
};

/** The spine and its stations — one station per segment boundary. */
export function spineOf(p, ctx) {
  const segments = Math.max(2, Math.round(num(p.segments, 10)));
  const segLen = num(p.segLen, 14);
  if (segLen <= 0 || num(p.bodyR, 9) <= 0) throw new Error('creature: segment length and body radius must be positive');
  const len = segments * segLen;
  const pose = POSES[p.pose] ? p.pose : 'straight';
  const bodyR = num(p.bodyR, 9);
  const prof = PROFILES[p.profile] || PROFILES.tapered;
  const maxR = bodyR * Math.max(...Array.from({ length: 129 }, (_, i) => prof(i / 128)));
  const path = POSES[pose](len, { tight: num(p.tight, 0.5), radius: maxR, segLen });
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(...path[i].map((v, k) => v - path[i - 1][k])));
  const total = cum.at(-1);
  const points = [];
  let i = 1;
  for (let s = 0; s <= segments; s++) {
    const want = total * s / segments;
    while (i < cum.length - 1 && cum[i] < want) i++;
    const u = (want - cum[i - 1]) / (cum[i] - cum[i - 1]);
    points.push(path[i - 1].map((v, k) => lerp(v, path[i][k], u)));
  }
  const frames = parallelFrames(points, { upHint: [0, 0, 1] });
  // THE BELLY IS ON THE PLATE, EVERY SEGMENT. Each station is raised to its
  // own radius, so the underside of every segment lands on z = 0 whatever the
  // taper. With the whole spine at one height the tail of a tapered body
  // floated 3.6 mm (dragon), and each floating segment is a loose piece the
  // printer starts in mid-air.
  //
  // RAISED, NOT TILTED. The frames stay level and only the centres move, so
  // every joint is the geometry it was, translated, and the tube between two
  // stations is a slightly sheared frustum. Tilting the spine to follow the
  // belly moved every joint by a fraction of a degree, and the B-side boolean
  // is a dice roll per joint (ruling 29): it re-rolled rows that had been
  // measured clean. Distances ALONG the spine are therefore horizontal — see
  // `run` — which is exactly what they were when every station sat at z = 0.
  const stations = frames.map((f, i) => {
    const r = bodyR * prof(i / segments);
    return { ...f, p: [f.p[0], f.p[1], r], r };
  });
  return { path, frames, stations, len, pose };
}

/** A tube through a run of stations: rings stitched directly into a Mesh, with
 *  flat caps at each end.
 *
 *  NOT loft(). loft() takes sections carrying a 2D `shape`, requires strictly
 *  monotonic section z, and accepts one island per section — none of which fits
 *  a spine. Every station of a coiled pose sits at z = 0, so loft() throws on
 *  the coil outright. Stitching rings is also exact, CSG-free and a tenth of
 *  the triangles, which is what docs/writing-a-generator.md asks for. */
/**
 * How many facets a body ring is cut into. 24, not the 28 it was, so the tube,
 * the stalk and the ball share ONE count and the shoulder between them is a
 * plain annulus instead of a 28-to-24 zip. The ball's count is the one that
 * cannot move — socket and ball must be tessellated alike or the measured gap
 * halves (joint.js's opening comment) — so the body yields. It costs 0.0770 mm
 * of radial faceting at bodyR 9 against the 28-gon's 0.0566, and a 0.4 mm
 * nozzle expresses neither. Ruling 35.
 *
 * Exported so the suite can pin it against `sphere()`'s own count rather than
 * recompute this formula and agree with itself. The two agree by ONE STEP:
 * this file's `nseg` floors at 8 and builders' floors at 3, and 24 x the
 * lowest legal segFactor (0.4) is 9.6. Drop the 24 to 16 and draft quality
 * silently gives the tube more facets than the ball, which is the gap-halving
 * bug wearing a new hat. The test is the guard.
 */
export function tubeFacets(ctx) { return nseg(24, segScale(ctx)); }

export function tubeThrough(stations, n, branches = []) {
  const m = new Mesh();
  // A station of radius zero is a POLE: one vertex, and the band beside it is a
  // triangle fan rather than a strip of quads. That is what lets a segment run
  // from its own tube, in through the joint's shoulder, up the stalk and over
  // the ball as ONE stitched mesh — see segmentsOf. The windings below are the
  // degenerate cases of the quad above them, not new conventions: collapse
  // a[i] and a[i+1] into the pole and the quad's surviving triangle is
  // (pole, b[i+1], b[i]); collapse b's pair and it is (a[i], a[i+1], pole).
  //
  // A station may instead carry `pts`, its own ring (a head's section), in the
  // same angular order as ring(): point i at TAU i / pts.length from n towards
  // b. Its count may be any whole multiple of its neighbour's; the band between
  // is then ZIPPED, k triangles fanned off each coarse point, which is the
  // quad's two triangles when k is 1.
  const POLE = 1e-9;
  const rings = stations.map(st => st.pts
    ? { pole: false, idx: st.pts.map(q => m.addVertex(q[0], q[1], q[2])) }
    : st.r <= POLE
    ? { pole: true, idx: [m.addVertex(st.p[0], st.p[1], st.p[2])] }
    : { pole: false, idx: ring(st, st.r, n).map(q => m.addVertex(q[0], q[1], q[2])) });
  // BRANCHES (Task 19, the legs). A branch leaves a hole in the tube, the
  // quads i0..i1-1 of every band from ring s0 to ring s1, and a tube of its
  // own is stitched to the hole's rim: no boolean where a leg meets a flank.
  const skipped = (s, i) => branches.some(br => s >= br.s0 && s < br.s1 && i >= br.i0 && i < br.i1);
  const stitch = (a, b, s = -1) => {
    if (a.pole && b.pole) return;
    const A = a.idx, B = b.idx, na = A.length, nb = B.length;
    if (a.pole) { for (let i = 0; i < nb; i++) m.addTri(A[0], B[(i + 1) % nb], B[i]); return; }
    if (b.pole) { for (let i = 0; i < na; i++) m.addTri(A[i], A[(i + 1) % na], B[0]); return; }
    if (na === nb) {
      for (let i = 0; i < na; i++) if (!skipped(s, i)) m.addQuad(A[i], A[(i + 1) % na], B[(i + 1) % na], B[i]);
    } else if (nb > na) {
      if (nb % na) throw new Error(`tubeThrough: a ${na}-ring cannot zip to a ${nb}-ring`);
      const k = nb / na;
      for (let i = 0; i < na; i++) {
        for (let j = k * i; j < k * (i + 1); j++) m.addTri(A[i], B[(j + 1) % nb], B[j]);
        m.addTri(A[i], A[(i + 1) % na], B[(k * (i + 1)) % nb]);
      }
    } else {
      if (na % nb) throw new Error(`tubeThrough: a ${na}-ring cannot zip to a ${nb}-ring`);
      const k = na / nb;
      for (let i = 0; i < nb; i++) {
        for (let j = k * i; j < k * (i + 1); j++) m.addTri(A[j], A[(j + 1) % na], B[i]);
        m.addTri(A[(k * (i + 1)) % na], B[(i + 1) % nb], B[i]);
      }
    }
  };
  for (let s = 0; s + 1 < rings.length; s++) stitch(rings[s], rings[s + 1], s);
  // Each branch's rim, walked the way the removed patch's own quads ran:
  // along ring s0 from i0 to i1, up the i1 column, back along ring s1, down
  // the i0 column. The branch's first ring must list its points in the same
  // order, and its tube then winds like the body's.
  for (const br of branches) {
    const R = rings.map(r => r.idx);
    const rim = [];
    for (let i = br.i0; i <= br.i1; i++) rim.push(R[br.s0][i]);
    for (let s = br.s0 + 1; s < br.s1; s++) rim.push(R[s][br.i1]);
    for (let i = br.i1; i >= br.i0; i--) rim.push(R[br.s1][i]);
    for (let s = br.s1 - 1; s > br.s0; s--) rim.push(R[s][br.i0]);
    let prev = { pole: false, idx: rim };
    for (const q of br.rings) {
      const next = { pole: false, idx: q.pts.map(v => m.addVertex(v[0], v[1], v[2])) };
      stitch(prev, next);
      prev = next;
    }
    const c = m.addVertex(br.tip[0], br.tip[1], br.tip[2]), k = prev.idx.length;
    for (let i = 0; i < k; i++) m.addTri(prev.idx[i], prev.idx[(i + 1) % k], c);
  }

  const capFan = (r, st, flip) => {
    if (r.pole) return;   // a pole closes itself
    const c = m.addVertex(st.p[0], st.p[1], st.p[2]), k = r.idx.length;
    for (let i = 0; i < k; i++) {
      const u = r.idx[i], v = r.idx[(i + 1) % k];
      if (flip) m.addTri(c, v, u); else m.addTri(c, u, v);
    }
  };
  capFan(rings[0], stations[0], true);
  capFan(rings[rings.length - 1], stations[stations.length - 1], false);
  // The bracket points inside each hole belong to no triangle now.
  return branches.length ? m.compact() : m;
}

/** Distance along the spine between two stations: horizontal, because the
 *  frames are level and a station's height is only its belly clearance. */
const run = (a, b) => Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);

/** A closed ring of `n` points of radius r on a station's frame. */
function ring(st, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    out.push([st.p[0] + st.n[0] * ca + st.b[0] * sa,
              st.p[1] + st.n[1] * ca + st.b[1] * sa,
              st.p[2] + st.n[2] * ca + st.b[2] * sa]);
  }
  return out;
}

/**
 * Where parts stand: 0.02 mm above the belly line, never on it. The belly's
 * lowest ring vertices lie exactly on z = 0 and a union with a face in the
 * same plane is a coin flip; a slicer samples the first layer at half its
 * height, so a foot 0.02 mm up still prints on the bed.
 *
 * The belly itself is NOT flattened. A shaved flat was tried and it broke the
 * socket boolean on segments with no parts on them at all (dragon 5, snake 1),
 * and the round-bellied gauge printed first time once the filament changed,
 * so the flat was buying nothing.
 */
export const FLOOR = 0;
export const PART_LIFT = 0.02;

/** Raise whole meshes, together, until the lowest is on the parts' flat. For
 *  heads and tails, whose undersides are not safe to flatten: a tapered tail
 *  whose tip droops below the plate has upward-facing surface down there, and
 *  squashing it folded three triangles over on the default creature. */
function liftOnto(meshes) {
  const lo = Math.min(...meshes.filter(m => !m.isEmpty()).map(m => m.bbox().min[2]));
  const d = FLOOR + PART_LIFT - lo;
  return d > 0 && Number.isFinite(d) ? meshes.map(m => m.isEmpty() ? m : m.translate(0, 0, d)) : meshes;
}


// ---------------------------------------------------------------------------
// Joints. One joint at every interior station, sized by the joint's own
// geometry and trimmed into the segments around it.
//
// THE SIZING IS THE PART THAT BITES. A joint's trims are proportional to its
// radius (a ball needs `ballR + c + wall + c` of A cut away, and `ballR + c`
// of socket depth in B; a hinge needs `face` from each host), while the
// segment length is whatever the user asked for. On a fat, short body the two
// end trims meet in the middle and the segment prints as floating pieces —
// topology stays watertight, the shell count on the merged creature can even
// stay right, and a four-hour print proves it was wrong. So the joint is
// sized back until the host survives, the way gear.js sizes conflicts: in
// build(), reported by validate(). The floors inside ballGeometry are measured
// and are not moved to make a fit.
// ---------------------------------------------------------------------------

/** The radius a joint of `kind` may use on a segment of `segLen` mm, solved
 *  from the joint's own geometry rather than a hand rule. Returns `r` when the
 *  host fits as asked; otherwise the largest radius whose trims leave the host
 *  connected. Throws only when even the smallest legal joint cannot fit. */
export function jointRCap(kind, r, segLen, clearance, swingDeg) {
  const budget = segLen - 0.5;                       // leave the host a visible sliver
  const need = (rr) => {
    if (kind === 'ball') {
      const g = ballGeometry({ r: rr, clearance, swingDeg });
      return Math.abs(g.faceZ) + 0.1 + g.ballR + g.c;   // pulled-back cut + socket depth
    }
    return 2 * hingeGeometry({ r: rr, clearance, swingDeg }).face;
  };
  const probe = Math.min(r, 1);
  if (need(probe) > budget) {
    throw new Error(`creature: a ${segLen.toFixed(1)} mm segment cannot host even the smallest ` +
      `${kind} joint (its trims need ${need(probe).toFixed(1)} mm) — lengthen the segments`);
  }
  if (need(r) <= budget) return r;
  let lo = probe, hi = r;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) <= budget) lo = mid; else hi = mid;
  }
  return lo;
}

/** One mesh per segment, already jointed. Each is a separate solid. Exported
 *  for the tests. */
export function segmentsOf(p, ctx) {
  p = asBuilt(p);
  const { stations } = spineOf(p, ctx);
  const n = tubeFacets(ctx);
  // 24/12, not 32/16: the sphere build cost is superlinear in the count (270 ms
  // against 60 ms per joint at 12 joints) and 24/12 measures the same aligned
  // gap — 0.3441 against 0.3467 at 32/16, both comfortably over the gate. The
  // rule that matters is that ball and socket share counts, whatever they are.
  const sphereSegs = 24, sphereRings = 12; // joint builders apply ctx quality once
  const kind = JOINT_KINDS.includes(p.joint) ? p.joint : 'ball';
  const c = num(p.clearance, fit('free'));
  // One clearance for a creature; five for the gauge, joint i taking step i.
  const steps = p.species === 'gauge' ? gaugeSteps(p) : null;
  const cOf = (i) => (steps ? steps[Math.min(i, steps.length - 1)] : c);
  const swingDeg = num(p.swing, 25);

  const count = stations.length - 1;
  const joints = [], trims = [];
  for (let i = 0; i < count - 1; i++) {
    const here = stations[i + 1];
    const spacing = run(stations[i], here);
    const ci = cOf(i);
    const cap = jointRCap(kind, here.r, spacing, ci, swingDeg);

    // The cut must clear the body, not just the joint. cutA (ball) is a disc
    // of radius 2r+4 around the capped station; the hinge's trim box reaches
    // 2r + face + 2 to each side. Cover less than the body's widest radius
    // here and the trim leaves a standing ring that fuses into the neighbour.
    const tubeR = Math.max(stations[i].r, here.r);
    const faceH = kind === 'hinge' ? hingeGeometry({ r: cap, clearance: ci, swingDeg }).face : 0;
    const cover = kind === 'ball' ? 2 * cap + 4 : 2 * cap + faceH + 2;
    if (cover < tubeR + 0.5) {
      throw new Error(`creature: a ${spacing.toFixed(1)} mm segment is too short to host a ` +
        `${kind} joint for a ${tubeR.toFixed(1)} mm body — the joint's trim cannot clear the ` +
        `body without severing it. Lengthen the segments or slim the body.`);
    }

    joints.push(joint(kind, {
      a: { ...here, r: Math.min(here.r, cap) }, b: { ...here, r: Math.min(here.r, cap) },
      clearance: ci, swingDeg, segments: sphereSegs, rings: sphereRings, ctx,
    }));
    // What the trims take off each host at this joint, along the spine: the
    // ball cuts A back to its (pulled-back) face and leaves B's tube whole
    // (the socket is internal); the hinge takes `face` from both.
    const rr = Math.min(here.r, cap);
    // What the joint takes off each host along the spine. The ball's A side is
    // stitched now, not cut, so it stops exactly on the face plane — ruling
    // 23's 0.1 mm setback existed to keep a cut face off the stalk's base and
    // there is no cut face any more.
    trims.push(kind === 'ball'
      ? { a: -ballGeometry({ r: rr, clearance: ci, swingDeg }).faceZ, b: 0 }
      : { a: faceH, b: faceH });
  }

  // NESTED SEAMS (Task 15, opt-in until the strip prints). Joint i's shell is
  // sized from the segment it cuts into: segment i's cup reaches Rs + c back
  // from pivot i+1 along the axis, and must stop short of segment i's OWN rear
  // socket and its wall. Target 1.15 r (a seam about 0.8 mm on the skin);
  // a joint too short for a shell wider than the body keeps the open seam.
  const seams = joints.map(() => null);
  if (kind === 'ball' && p.seams === 'nested') {
    for (let i = 0; i < count - 1; i++) {
      const g = joints[i].geometry, here = stations[i + 1];
      const rear = i > 0 ? joints[i - 1].geometry : null;
      const need = rear ? rear.ballR + rear.c + rear.wall : 0;
      const Rs = Math.min(1.15 * here.r, run(stations[i], here) - need - 0.5 - g.c);
      if (Rs > 1.01 * here.r && Rs - (g.ballR + g.c) > 0.8) {
        seams[i] = nestedSeam(g, { r: here.r, Rs, rings: sphereRings, ctx });
        // Parts stay out of both keep-outs: the cup, Rs + c back from this
        // pivot inside segment i, and the socket with its wall, ahead of it
        // inside segment i+1. With the open seam B needed no trim (its socket
        // sat in the gap); here a stub leg's root reached the socket cavity
        // and touched the ball (capybara, 0.0002 mm).
        trims[i] = { a: seams[i].Rc + 0.4, b: g.ballR + g.c + g.wall + 0.5 };
      }
    }
  }

  // Each segment's SAFE SPAN — the stretch of its tube the joints leave alone,
  // measured from its rear station — is where parts may sit. Half a millimetre
  // of margin each end keeps a part's root off the trim face.
  const spans = [];
  for (let i = 0; i < count; i++) {
    const l = run(stations[i], stations[i + 1]);
    const from = (i > 0 ? trims[i - 1].b : 0) + 0.5;
    const to = l - (i < count - 1 ? trims[i].a : 0) - 0.5;
    spans.push({ from, to: Math.max(to, from + 0.5) });
  }
  // SKIN SPANS, for parts that only sink a little way in from the surface
  // (dorsal pieces, the gauge's numbers). With open seams they are the same
  // spans. With nested seams the keep-outs above are about roots near the
  // AXIS, and applying them to a spike on the back shrank every dragon spike
  // to a stub; a surface part only has to stay behind the point where the
  // cup undercuts the skin at its own depth (0.3 r in).
  const skin = spans.map((sp, i) => {
    const l = run(stations[i], stations[i + 1]);
    const back = i > 0 && seams[i - 1], front = i < count - 1 && seams[i];
    if (!back && !front) return sp;
    const depth = (st) => Math.sqrt(Math.max(0, front.Rc ** 2 - (0.7 * st.r) ** 2));
    const from = back ? back.seamB + 0.5 : sp.from;
    const to = front ? l - depth(stations[i + 1]) - 0.5 : sp.to;
    return { from, to: Math.max(to, from + 0.5) };
  });
  const loft = HEAD_LOFTS[p.head] ? p.head : null;
  const crown = CROWNS[p.dorsal] ? CROWNS[p.dorsal] : null;
  const legLoft = LEG_LOFTS[p.limbKind] || null, R0 = num(p.bodyR, 9);
  // Not on a segment that carries unioned legs: a boolean over a crowned
  // segment's extra triangles is ruling 29's dice several times over.
  const pairs = clamp(Math.round(num(p.limbPairs, 0)), 0, 8);
  const legged = new Set(pairs > 0 ? limbPositions(p).map(u => clamp(Math.floor(clamp(u, 0, 0.999999) * count), 0, count - 1)) : []);
  // STITCHED LEGS ONLY WHERE NOTHING ELSE IS A BOOLEAN (Task 19): a ball
  // joint nested at both ends (no socket to carve), no unioned head or tail
  // on the segment (a lofted head without a jaw is stitched), no unioned back. Anywhere else the leg stays the unioned
  // part it was, measured and pinned by the limbs suite; stitched rings under
  // a boolean took "everything on" rows to dozens of open edges.
  const stitchable = i => !!legLoft && kind === 'ball' &&
    (i === 0 ? p.head === 'none' || (!!loft && !p.jaw) : !!seams[i - 1]) &&
    (i === count - 1 ? p.tail === 'taper' || !!TAIL_LOFTS[p.tail] : !!seams[i]) &&
    !(DORSAL[p.dorsal] && p.dorsal !== 'none');
  const stitchLegs = new Set([...legged].filter(stitchable));
  const parts = partsOf(p, ctx, stations, spans, skin, stitchLegs);
  // The crown's run on segment i: its skin span, never behind its own station
  // (a nested seam's skin starts behind it, over the dome, and rings there
  // fold back across the station's), and on segment 0 clear of where a
  // lofted head's horns rake back over the neck (their rings would cross).
  const hornReach = loft ? Math.max(0, ...HEAD_LOFTS[loft].bumps.map(b => b[6] || 0)) * num(p.bodyR, 9) : 0;
  const crownSpan = i => ({ from: Math.max(skin[i].from, 0.5, i === 0 ? hornReach + 1 : 0), to: skin[i].to });

  const out = [];
  for (let i = 0; i < count; i++) {
    // THE A SIDE IS BUILT, NOT CARVED (ball only). One ring list: up the tube
    // to the joint's face plane, in across the shoulder, along the stalk and
    // over the ball to its pole. No boolean, so none of the seams a boolean
    // can collapse — which is the whole of Task 7c. The hinge still carves:
    // its tongues interleave and there is no profile of revolution to stitch.
    const frontBall = (i < count - 1 && kind === 'ball') ? joints[i] : null;
    // A joint's own frame at its pivot, carrying a profile {z, r} along it.
    const along = (st, q) => ({ p: st.p.map((v, k) => v + q.z * st.t[k]), n: st.n, b: st.b, t: st.t, r: q.r });
    // The head, if it is lofted, runs on from the nose pole into segment 0's
    // own first ring: one stitched mesh, no boolean at the neck (Task 17).
    const rear = i === 0 && loft
      ? headRings(p.head, stations[0], stations[0].t.map(v => -v), ctx, headFacets(n), num(p.bodyR, 9)).reverse()
      : i > 0 && seams[i - 1] ? seams[i - 1].profileB.map(q => along(stations[i], q)) : [];
    // A stitched crown or crest (Task 18) runs as extra rings between this
    // station and the next body ring, inside the segment's skin span.
    // Between this station and the next body ring: a stitched leg stretch
    // (Task 19) and then the crown, or the crown alone, or nothing.
    let branches = [];
    const crownTo = next => {
      if (stitchLegs.has(i)) {
        // The leg only touches the skin, which runs from this station to the
        // next ring, so it is placed on that band, not in the joints' axis
        // keep-outs: on a nested segment those are shorter than the leg, and
        // bracket rings past the cup's first ring folded the tube back.
        const len = Math.hypot(...next.p.map((v, k) => v - stations[i].p[k]));
        const hw = Math.min(0.4 * R0, (len - 1) / 2), sp = spans[i];
        const shrink = hw / (0.4 * R0);                                  // a short band gets a thinner leg
        const zc = clamp((sp.from + sp.to) / 2, hw + 0.5, len - hw - 0.5);
        const brackets = Array.from({ length: LEG_BANDS + 1 }, (_, j) => zc - hw + 2 * hw * j / LEG_BANDS);
        // One run of rings: the crown's tooth and the leg's brackets together,
        // at the leg's resolution (the hole needs it, and nothing is unioned
        // onto a stitched-leg segment to choke on the zip).
        const mids = crownRings(crown, stations[i], next, crownSpan(i), ctx, LEG_RING, brackets);
        const j0 = mids.findIndex(q => Math.abs(q.z - brackets[0]) < 1e-6), j1 = mids.findIndex(q => Math.abs(q.z - brackets.at(-1)) < 1e-6);
        const L = shrink < 1 ? { ...legLoft, thigh: legLoft.thigh * shrink, shin: legLoft.shin * shrink } : legLoft;
        branches = legStretch(L, mids, j0, j1, stations[i], next, zc, rear.length + 1, R0);
        return mids;
      }
      return crown && !legged.has(i) ? crownRings(crown, stations[i], next, crownSpan(i), ctx, n) : [];
    };
    let body;
    if (frontBall && seams[i]) {
      const A = seams[i].profileA.map(q => along(stations[i + 1], q));
      const mids = crownTo(A[0]);
      body = tubeThrough([...rear, stations[i], ...mids, ...A], n, branches);
    } else if (frontBall) {
      const st = stations[i + 1];
      const span = run(stations[i], st);
      const at = (z, r) => ({
        p: [st.p[0] + z * st.t[0], st.p[1] + z * st.t[1], st.p[2] + z * st.t[2]],
        n: st.n, b: st.b, t: st.t, r,
      });
      const fz = frontBall.geometry.faceZ;
      // The body radius where the tube stops: interpolated along the segment,
      // because a plane cut through a frustum gives the interpolated radius
      // and this has to be the same solid the boolean used to produce.
      const shoulderR = lerp(st.r, stations[i].r, span > 0 ? Math.min(1, -fz / span) : 0);
      // And its centre sits at that radius too, so the belly runs level to
      // the shoulder instead of dipping under the plate by the taper (0.12 mm
      // on the dragon, 0.55 on the capybara's barrel). The shift is along n,
      // inside the face plane, so the face and the gap it leaves do not move.
      const shoulder = at(fz, shoulderR);
      shoulder.p = shoulder.p.map((v, k) => v + (shoulderR - st.r) * st.n[k]);
      const mids = crownTo(shoulder);
      body = tubeThrough([...rear, stations[i], ...mids, shoulder, ...frontBall.profileA.map(q => at(q.z, q.r))], n, branches);
    } else {
      const tk = TAILS[p.tail] ? p.tail : 'taper';
      const tail = i !== count - 1 ? []
        : tk === 'taper' ? taperRings(stations[i + 1], ctx)
        : tk === 'spike' ? spikeRings(stations[i + 1])
        : TAIL_LOFTS[tk] ? tailLoftRings(tk, stations[i + 1], n) : [];
      const mids = crownTo(stations[i + 1]);
      body = tubeThrough([...rear, stations[i], ...mids, stations[i + 1], ...tail], n, branches);
    }
    // THE JAW on a lofted head: split segment 0 itself, in the head's frame.
    // splitHead cuts nothing behind its pivot, which sits a millimetre and
    // more ahead of the neck, so the tube, its joint and its parts are
    // untouched; the mandible goes out as its own piece.
    if (i === 0 && loft && p.jaw && JAW_HEADS.includes(loft)) {
      const hf = outward(stations[0]);
      // The mandible is cut from the head alone, built in the same frame: ahead
      // of the neck it is the same surface as segment 0, and it gives the
      // boolean a tenth of the triangles. Cut from the whole segment, the
      // crown's rings re-rolled the mandible to two bad edges at draft.
      const here = { p: [0, 0, 0], n: [1, 0, 0], b: [0, 1, 0], t: [0, 0, 1], r: stations[0].r };
      const { cranium, mandible } = splitHead(fromFrame(body, hf), HEAD_R * stations[0].r, p, HEADS[loft](here, p, ctx));
      body = toFrame(cranium, hf);
      parts.free.push(toFrame(mandible, hf));
    }
    // CUT BEFORE ADD, on both sides. Task 3 measured the other order: it eats
    // the ball, leaving a stump — segment A tops out at the cut face instead of
    // at the ball — and the result is STILL two watertight shells, so it passes
    // a shell-count check and looks healthy. Do not reorder these.
    //
    // THE CUT IS PULLED BACK 0.1 mm, ball joints only. The ball's stalk is born
    // exactly on the cut face, and a union of two solids sharing a coplanar
    // face is a coin flip: measured at 24 segments it left two non-manifold
    // edges where the two faces' triangulations nearly but not quite agreed.
    // Sliding the CUT (never the feature — the ball would come off its socket
    // centre, which reads as a 0.28 mm gap) a tenth forward leaves the stalk
    // standing inside the host, where the seam is an ordinary transversal
    // crossing. The hinge's tongues already reach 1 mm into their host, and its
    // cut must NOT move: a tube nosing into the knuckle band would bury it.
    //
    // THE JOINT'S FOUR OPERATIONS STAY IN TASK 6'S ORDER, AND THE PARTS ARE
    // ONE FIFTH UNION. Five orderings were measured on a 25-row matrix (both
    // presets, the defaults, both joints, the tightest poses with a pair of
    // legs on every segment, the 4 mm body with a dragon's two pairs): joint
    // cuts grouped into one subtract and adds into one union broke the bare
    // Long snake coil at segment 18; parts unioned into the raw tube before
    // the joint left a sliver on the cut face that came back non-manifold;
    // sequential adds broke the fully dressed coil. This order fails three
    // rows; every other order fails four to nine. The parts are combined among
    // themselves first (disjoint parts merge exactly, no BSP; the legs of a
    // pair are rooted apart for this, see LIMBS) so the body is split once for
    // them. The three that remain, and the bare one that predates this task,
    // are in task-7-report.md.
    if (i < count - 1 && !frontBall) {
      const j = joints[i];
      body = subtract(body, j.cutA);
      body = union(body, j.addA);
    }
    if (i > 0 && !seams[i - 1]) {
      const j = joints[i - 1];
      if (j.cutB) body = subtract(body, j.cutB);
      if (!j.addB.isEmpty()) body = union(body, j.addB);
    }
    const extra = parts[i].filter(m => !m.isEmpty());
    if (extra.length) body = union(body, unionAll(extra));
    out.push(body);
  }
  out.push(...parts.free);
  return out;
}

// ---------------------------------------------------------------------------
// The parts kit. Heads, tails, limbs and dorsal rows, every one FUSED to the
// segment it sits on, so the piece count never changes. A limb that becomes
// its own shell is a limb that arrives loose in the bag.
//
// PART FRAMES. Every part is built about the origin in a local frame where
// +Z points OUT of the body (a head: away from the tail; a tail: away from the
// head; a limb or dorsal piece: along the spine towards the tail), +X is up
// off the plate and +Y is the creature's side. toFrame() maps local (x, y, z)
// onto the station's (n, b, t); parallelFrames is seeded with upHint +Z, so n
// is up in EVERY pose and b is sideways. That was measured, not assumed — the
// parts suite asserts it. A head therefore rides a reversed frame, (n, -b, -t):
// b and t both flip, so the frame stays right-handed and nothing is mirrored.
//
// Parts are placed at the centre of a segment's SAFE SPAN, never on a boundary
// station, because the boundary station is where the joint is: a spike or a
// limb root straddling it bridges the gap and welds two segments into one.
// The span is what the joint's own trims leave of the tube (see segmentsOf).
// ---------------------------------------------------------------------------

/** Mesh quality for parts: one figure per ctx, shared so every part facets alike. */
function partQ(ctx) {
  const sf = segScale(ctx);
  return { n: nseg(24, sf), rings: nseg(12, sf) };
}
const toUp = m => m.rotateY(Math.PI / 2);     // a +Z primitive now points +X (up)
const toDown = m => m.rotateY(-Math.PI / 2);  // ... or -X (down)
const asPart = (mesh, st) => toFrame(mesh, st);
/** toFrame's inverse: world into a station's local (n, b, t) frame. */
function fromFrame(mesh, { p, t, n, b }) {
  const d = v => -(v[0] * p[0] + v[1] * p[1] + v[2] * p[2]);
  return mesh.transform([
    n[0], b[0], t[0], 0,
    n[1], b[1], t[1], 0,
    n[2], b[2], t[2], 0,
    d(n), d(b), d(t), 1,
  ]);
}

/** A station facing away from the body: b and t flipped together. */
export function outward(st) {
  return { ...st, b: st.b.map(v => -v), t: st.t.map(v => -v) };
}

// Thin features get a floor so a 4 mm creature still has antennae that are
// solids and not slivers the validator throws out as degenerate.
const thin = (v, floor = 0.6) => Math.max(v, floor);

// A head is built on a radius slightly LARGER than the station it sits on, and
// rooted well inside the body. 0.96 was measured and is wrong twice over: it
// leaves a 0.36 mm lip where the dome meets the tube (the body is wider than
// its own head), and a shrunk part still shares a tangent circle with the end
// ring, which is the coincidence it was trying to avoid. A part that strictly
// overhangs its host crosses the surface transversally, which is what the
// boolean wants, and a head a little wider than the neck is what an animal
// looks like.
const HEAD_R = 1.05, TAIL_R = 1.05;

/**
 * STITCHED HEADS (Task 17). A head is a run of sections along its own axis,
 * stitched into the first segment's tube like the taper tail, so there is no
 * boolean where it meets the neck and nothing to lift: every section's
 * underside is measured from the station's axis, and `bot` 1 is the plate.
 *
 * All figures are in units of bodyR, so a creature's head is the same size
 * whatever its taper does to the neck. `keys` are sections
 * [z, top, bot, w, e]: half-height above and below the axis, half-width, and a
 * superellipse exponent (2 round, higher boxier). z 0 is the neck ring, a
 * plain circle the size of the station, so the first key is just [0]. Past the last key a
 * NOSE closes the section to a pole over `nose` radii, shrinking towards a
 * point `anchor` of the way from its centre to its underside: 1 keeps the chin
 * on the plate (the capybara), 0 is a rounded nose on the axis.
 *
 * `bumps` are the features, radial swellings of the rings: [z, angle from up
 * (mirrored to both sides), height, z spread, angle spread], a Gaussian in
 * both. Eyes, brows, ears, nostrils and horns are all bumps, not unioned
 * primitives, so a face costs no booleans. `sweep` > 0 turns a bump into a
 * ridge that grows from nothing at z + sweep to full height at z and stops
 * there: a horn raked back towards the neck.
 */
export const HEAD_LOFTS = {
  dragon: {
    // A skull a little wider than the body, a brow that steps down to a long
    // low snout, and the chin flat on the plate for most of its length.
    keys: [[0], [0.4, 1.12, 1, 1.25, 2.6], [1.0, 1.1, 1, 1.32, 3],
           [1.45, 0.9, 1, 1.05, 3], [1.85, 0.64, 0.97, 0.8, 3], [2.9, 0.5, 0.86, 0.66, 2.6]],
    nose: 0.4, anchor: 0.3,
    bumps: [
      [1.3, 60, 0.3, 0.16, 12],               // eyes
      [1.18, 38, 0.2, 0.2, 11],               // brow ridge over them
      [0.35, 24, 0.75, 0.11, 8, 1.05, 0.7],   // horns: a ridge off the brow, raked back over the neck
      [3.0, 24, 0.08, 0.08, 9],               // nostrils
    ],
  },
  lizard: {
    keys: [[0], [0.4, 0.98, 1, 1.28, 2.4], [1.0, 0.86, 1, 1.35, 2.6],
           [1.75, 0.6, 0.95, 0.98, 2.4], [2.35, 0.44, 0.85, 0.66, 2.2]],
    nose: 0.32, anchor: 0.3,
    bumps: [
      [1.05, 50, 0.38, 0.18, 15],             // eyes, big and high
      [2.45, 22, 0.06, 0.06, 9],              // nostrils
    ],
  },
  capybara: {
    keys: [[0], [0.45, 1.25, 1, 1.2, 3], [1.3, 1.3, 1, 1.28, 3.4],
           [2.1, 1.14, 1, 1.18, 3.6], [2.5, 1.04, 1, 1.1, 3.4]],
    nose: 0.45, anchor: 1,
    bumps: [
      [0.6, 44, 0.4, 0.14, 11],               // ears
      [1.3, 62, 0.16, 0.1, 9],                // eyes
      [2.65, 28, 0.07, 0.08, 10],             // nostrils
    ],
  },
};

const smooth = t => t * t * (3 - 2 * t);

/** A head's section at z, interpolated between its keys. */
function headSection(L, z, k0) {
  const k = [[0, k0, k0, k0, 2], ...L.keys.slice(1)];
  if (z <= k[0][0]) return k[0].slice(1);
  for (let i = 1; i < k.length; i++) {
    if (z <= k[i][0]) {
      const u = smooth((z - k[i - 1][0]) / (k[i][0] - k[i - 1][0]));
      return k[i].slice(1).map((v, j) => lerp(k[i - 1][j + 1], v, u));
    }
  }
  return k[k.length - 1].slice(1);
}

/** How far a head's bumps swell the section at (z, a), a from up, radians,
 *  and how far they drag it back towards the neck: { r, back }. */
function headBump(L, z, a) {
  let r = 0, back = 0;
  for (const [z0, deg, h, sz, sa, sweep = 0, rake = 0] of L.bumps) {
    let dz;
    if (sweep > 0) {
      if (z < z0) dz = (z - z0) / sz;                          // the tip: falls off fast
      else if (z > z0 + sweep) dz = (z - z0 - sweep) / sz;     // beyond its root
      else dz = 0;
    } else dz = (z - z0) / sz;
    const grow = sweep > 0 ? clamp(1 - (z - z0) / sweep, 0, 1) : 1;
    // Mirrored: the nearer of the two sides.
    const da = (Math.abs(Math.abs(a) - deg * DEG)) / (sa * DEG);
    const wgt = grow * Math.exp(-dz * dz - da * da);
    r += h * wgt;
    back = Math.max(back, rake * wgt);
  }
  return { r, back };
}

/**
 * The head's rings for `tubeThrough`, in order from the neck out to the nose
 * pole, NOT including the neck ring itself (that is the station). `fwd` is the
 * direction the head grows along; the rings use the station's own n and b, so
 * a ring zips point for point onto the tube behind it. `m` points per ring.
 */
export function headRings(kind, st, fwd, ctx, m, R = st.r) {
  const L = HEAD_LOFTS[kind], s = R, k0 = st.r / R;
  const zEnd = L.keys[L.keys.length - 1][0], zTip = zEnd + L.nose;
  const count = Math.max(10, Math.round(24 * segScale(ctx)));
  const out = [];
  const at = (z, x, y) => st.p.map((v, k) => v + s * (z * fwd[k] + x * st.n[k] + y * st.b[k]));
  for (let j = 1; j <= count; j++) {
    const z = zTip * j / count;
    let [top, bot, w, e] = headSection(L, Math.min(z, zEnd), k0);
    bot = Math.min(bot, k0);                        // the plate: the neck's axis is k0 up
    // THE NOSE: a quarter ellipse, the section shrinking about a point
    // `anchor` of the way down from its centre to its underside.
    let f = 1, cx = 0;
    if (z > zEnd) {
      const u = (z - zEnd) / L.nose;
      f = Math.sqrt(Math.max(0, 1 - u * u));
      const mid = (top - bot) / 2;                  // the section's centre, up of the axis
      cx = lerp(mid, -bot, L.anchor);
      top = cx + (top - cx) * f; bot = -(cx + (-bot - cx) * f); w *= f;
    }
    if (j === count || f < 1e-6) { const c = z > zEnd ? cx : 0; out.push({ p: at(zTip, c, 0), r: 0 }); break; }
    const pts = [];
    for (let i = 0; i < m; i++) {
      const a = TAU * i / m, ca = Math.cos(a), sa = Math.sin(a);
      const A = ca >= 0 ? top : bot;
      let rho = 1 / Math.pow(Math.pow(Math.abs(ca) / A, e) + Math.pow(Math.abs(sa) / w, e), 1 / e);
      // Features ride the upper half and the flanks; never under the chin.
      const ang = Math.atan2(sa, ca);
      let back = 0;
      if (ca > -0.2) { const bmp = headBump(L, z, ang); rho += bmp.r * f; back = bmp.back; }
      pts.push([rho * ca, rho * sa, z - back]);
    }
    out.push({ pts: pts.map(([x, y, zz]) => at(zz, x, y)) });
  }
  return out;
}

/** Points round a head ring: 48 at every quality, a whole multiple of the
 *  tube's so it zips. The features need about that many to read, and no
 *  more: 96 at fine gave the jaw's split twice the triangles to cut and it
 *  rolled two non-manifold edges on the mouth line (ruling 76). */
export function headFacets(n) { return n * Math.max(1, Math.round(48 / n)); }

/** A stitched head standing alone on its station, capped at the neck, for
 *  the parts suite and the jaw's split. */
function loftHead(kind) {
  return (st, p, ctx) => {
    const n = tubeFacets(ctx);
    return tubeThrough([st, ...headRings(kind, st, st.t, ctx, headFacets(n), num(p.bodyR, st.r))], n);
  };
}

/** A tail cone that is exactly `r0` wide WHERE IT CROSSES THE STATION PLANE,
 *  buried `root` deep, and `tipR` at its far end `len` out.
 *
 *  Sizing a cone by its buried base instead is what broke every curved pose:
 *  the cone narrows as it comes forward, so a base 3% wider than the body
 *  arrives at the station plane 9% NARROWER, grazing the tube's end ring at
 *  almost exactly its own radius. Two surfaces that meet at a hair's breadth
 *  give the boolean slivers — two bad edges on the last segment, every time,
 *  on the S-curve and the coil and never when straight (where the end ring is
 *  square to the cone and they cross cleanly). Solving for the base from the
 *  radius we actually care about makes the crossing unambiguous at every
 *  pose. */
function tailCone(r0, tipR, len, root, segments) {
  const baseR = r0 + root * (r0 - tipR) / len;
  return cylinder(baseR, len + root, { segments, z0: -root, r2: tipR });
}

/**
 * The taper tail as rings running on from the last station to a rounded tip,
 * for `segmentsOf` to stitch onto the last segment's own tube.
 *
 * NOT A PART. It was a cone unioned on, 5% wider than the body where they
 * cross so the crossing stays transversal, which left it 0.05 r below the
 * belly. Lifting it onto the plate lifted it by exactly that much and put the
 * two circles back at tangency, the one crossing a boolean cannot do: two bad
 * edges on the folded 16-segment animal. Stitched, there is no crossing, and
 * every ring rests on the plate, so the tail lies on the bed all the way to
 * its tip instead of being bridged back to the body.
 *
 * Heights go along the station's n (up, in every built pose), so the same
 * rings stand correctly on the parts suite's test frame.
 */
export function taperRings(last, ctx) {
  const r0 = last.r, tipR = 0.22 * r0, zc = 1.8 * r0 - tipR;
  const at = (z, r, h) => ({
    p: last.p.map((v, k) => v + z * last.t[k] + (h - r0) * last.n[k]),
    n: last.n, b: last.b, t: last.t, r,
  });
  // A straight frustum whose underside stays level (centre height = radius),
  // then a quarter sphere resting on the plate, closing to a pole.
  const out = [at(zc, tipR, tipR)];
  const m = Math.max(3, partQ(ctx).rings >> 1);
  for (let k = 1; k <= m; k++) {
    const a = (Math.PI / 2) * k / m;
    out.push(at(zc + tipR * Math.sin(a), k === m ? 0 : tipR * Math.cos(a), tipR));
  }
  return out;
}

/**
 * LOFTED TAILS (Task 18's tails). Sections along the tail from the last
 * station, stitched on like the taper, the underside of every one on the
 * plate: [z, half width, half height], in units of the last station's radius,
 * ending in a pole at the last z. No barbs, no boolean on the last segment.
 * A whip for the lizard; a shaft that flattens into an arrowhead spade for the
 * dragon, lying on the bed where it prints without support.
 */
export const TAIL_LOFTS = {
  whip:  [[0.3, 0.92, 0.92], [1.2, 0.62, 0.6], [2.2, 0.38, 0.36], [3.1, 0.22, 0.2], [3.8, 0.13, 0.12], [4.1, 0, 0]],
  spade: [[0.3, 0.88, 0.88], [1.0, 0.55, 0.52], [1.6, 0.36, 0.34], [1.9, 0.8, 0.32], [2.3, 1.5, 0.3],
          [2.75, 0.95, 0.26], [3.2, 0.35, 0.18], [3.45, 0, 0]],
};

/** A lofted tail's rings for `tubeThrough`, after the last station. `n`
 *  points a ring, the tube's own, so it meets the body without a zip. */
export function tailLoftRings(kind, last, n) {
  const r0 = last.r;
  return TAIL_LOFTS[kind].map(([z, w, h]) => {
    const c = last.p.map((v, k) => v + z * r0 * last.t[k] + (h - 1) * r0 * last.n[k]);   // underside on the plate
    if (w === 0) return { p: c, r: 0, n: last.n, b: last.b, t: last.t };
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = TAU * i / n;
      pts.push(c.map((v, k) => v + h * r0 * Math.cos(a) * last.n[k] + w * r0 * Math.sin(a) * last.b[k]));
    }
    return { pts, p: c, r: Math.max(w, h) * r0 };
  });
}

/** The spike tail's shaft: a cone to a point, underside level on the plate
 *  (centre height = radius), stitched on for the same reason as taperRings. */
export function spikeRings(last) {
  const r0 = last.r, len = 2.2 * r0;
  return [{ p: last.p.map((v, k) => v + len * last.t[k] - r0 * last.n[k]), n: last.n, b: last.b, t: last.t, r: 0 }];
}

/** Three barbs raked back along the spike's shaft: up and to either side.
 *  The first set spaced them 120 degrees round the axis, which put two under
 *  the shaft and through the plate. Rooted on the shaft's descending centre
 *  line, 0.6 r0 along, where it is 0.73 r0 thick. */
function spikeBarbs(last, ctx) {
  const r0 = last.r, z = 0.6 * r0, drop = -r0 * z / (2.2 * r0);
  const barb = a => cone(thin(0.16 * r0), 0.7 * r0, { segments: 8 })
    .rotateY(40 * DEG).rotateZ(a * DEG)
    .translate(Math.cos(a * DEG) * 0.55 * r0 + drop, Math.sin(a * DEG) * 0.55 * r0, z);
  return asPart(unionAll([barb(0), barb(90), barb(-90)]), last);
}

export const HEADS = {
  none: () => new Mesh(),

  blunt: (st, p, ctx) => {
    const r = HEAD_R * st.r, { n } = partQ(ctx);
    // The brief's 1.6 r capsule, restored: the dome that replaced it to save
    // 8 mm of bed is no longer needed now the default pose is the diagonal.
    // 2.3 r overall (a capsule's height includes both hemispherical ends and
    // must be at least its own diameter), rooted 0.7 r inside: 1.6 r of head
    // stands proud of the station, which is the brief's number.
    return asPart(capsule(r, 2.3 * r, { segments: n, z0: -0.7 * r }), st);
  },

  dragon: loftHead('dragon'),

  lizard: loftHead('lizard'),

  fish: (st, p, ctx) => {
    const r = HEAD_R * st.r, { n, rings } = partQ(ctx);
    const root = Math.min(0.9 * r, st.reach ?? 0.9 * r);
    // Narrow and deep: squeezed in Y (side), kept full height. 0.62 and 1.08,
    // not 0.6 and 1.05: at the tighter squeeze the flattened skull grazes the
    // tube's end ring on the STRAIGHT pose only (where the ring is square to
    // the head), for 2 boundary and 1 non-manifold edge. A hair more clearance
    // either side of the body radius and the crossing is unambiguous.
    const skull = capsule(r, Math.max(2.02 * r, root + 1.3 * r), { segments: n, z0: -root }).scale(1.08, 0.62, 1);
    const snout = union(
      cylinder(0.5 * r, 0.7 * r, { segments: n, z0: 1.0 * r, r2: 0.18 * r }),
      sphere(0.18 * r, { segments: n, rings, z0: -0.18 * r }).translate(0, 0, 1.64 * r)).scale(1, 0.62, 1);
    const eye = side => sphere(0.16 * r, { segments: Math.max(8, n >> 1), rings: Math.max(6, rings >> 1), z0: -0.16 * r })
      .translate(0.35 * r, side * 0.55 * r, 0.7 * r);
    return asPart(unionAll([skull, snout, eye(1), eye(-1)]), st);
  },

  bug: (st, p, ctx) => {
    const r = HEAD_R * st.r, { n, rings } = partQ(ctx);
    const root = Math.min(0.9 * r, st.reach ?? 0.9 * r);
    const head = sphere(1.08 * r, { segments: n, rings, z0: -1.08 * r }).translate(0, 0, 1.08 * r - root);
    // Antennae: raked forward and up from the brow, one each side.
    const antenna = side => cylinder(thin(0.09 * r), 1.4 * r, { segments: 8 })
      .rotateY(35 * DEG).rotateZ(side * 20 * DEG)
      .translate(0.7 * r, side * 0.4 * r, 1.4 * r - root);
    return asPart(unionAll([head, antenna(1), antenna(-1)]), st);
  },

  capybara: loftHead('capybara'),

};

export const TAILS = {
  // Stitched, not unioned: see taperRings. Standalone it is the same rings
  // closed with a cap at the station, for the parts suite to hold alone.
  taper: (st, p, ctx) => tubeThrough([st, ...taperRings(st, ctx)], tubeFacets(ctx)),

  // The shaft is stitched like the taper tail (see spikeRings); standalone it
  // is the same shaft closed at the station, with its barbs.
  spike: (st, p, ctx) => union(tubeThrough([st, ...spikeRings(st)], tubeFacets(ctx)), spikeBarbs(st, ctx)),
  whip:  (st, p, ctx) => tubeThrough([st, ...tailLoftRings('whip', st, tubeFacets(ctx))], tubeFacets(ctx)),
  spade: (st, p, ctx) => tubeThrough([st, ...tailLoftRings('spade', st, tubeFacets(ctx))], tubeFacets(ctx)),

  fan: (st, p, ctx) => {
    const r = TAIL_R * st.r, { n } = partQ(ctx);
    const root = Math.min(0.3 * r, st.reach ?? 0.3 * r);
    // A half-disc standing in the up–outward plane, thin across the body.
    // Profile is drawn in (x = up, y = -outward): extrude thickens along Z and
    // the rotateX(-90) below carries that thickness onto Y (the side).
    const R = 1.4 * r, pts = [];
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + Math.PI * i / n;
      pts.push([Math.sin(a) * R, -Math.cos(a) * R]);
    }
    pts.push([R, root], [-R, root]);
    const t = 0.35 * r;
    return asPart(extrude(pts, t, { z0: -t / 2 }).rotateX(-Math.PI / 2), st);
  },

  sting: (st, p, ctx) => {
    const r = TAIL_R * st.r, { n } = partQ(ctx);
    const root = Math.min(0.3 * r, st.reach ?? 0.3 * r);
    const shaft = tailCone(r, 0.28 * r, 1.4 * r, root, n);
    // The sting itself: a cone on the end, swept 40 degrees upward.
    const tip = cone(0.3 * r, 1.1 * r, { segments: Math.max(8, n >> 1) })
      .rotateY(40 * DEG).translate(0, 0, 1.15 * r);
    return asPart(union(shaft, tip), st);
  },

  nub: (st, p, ctx) => {
    const r = TAIL_R * st.r, { n, rings } = partQ(ctx);
    // Half-buried: centred on the station, so half of it is inside the body.
    return asPart(sphere(0.45 * r, { segments: n, rings, z0: -0.45 * r }), st);
  },
};

/** Limbs: `(st, side, p, ctx)`, side +1 or -1 along the station's b. Built
 *  along +Z, then turned to point down (-X) and tilted out to the side.
 *
 *  ROOTED INSIDE THE BODY ON ITS OWN SIDE. Each leg starts at axis height,
 *  a third of a radius towards its own side, so the two legs of a pair never
 *  touch: two mirror-image solids that overlap meet exactly in their mirror
 *  plane, and that plane also carries the tube's belly seam (the ring vertex
 *  at b = 0). Coincident curves in a union came back non-manifold, measured
 *  at segment 0 on a straight body with stub legs. Kept apart, each leg meets
 *  only the tube, transversally. */
/**
 * How far a limb reaches ALONG THE SPINE, per millimetre of body radius, from
 * the station it is rooted on. Negative is towards the head.
 *
 * Measured off the built meshes at bodyR 6, 9 and 13, flat to three digits —
 * `tests/gen-creature-limbs.test.mjs` pins these against the real geometry,
 * so reshaping a limb fails there rather than silently fusing a joint. Why it
 * matters: the first fin reached 1.16 r towards the tail and put the DEFAULT
 * creature 0.0006 mm from its next segment (ruling 43). Re-measured for the
 * plate-standing limbs, 2026-09-23.
 */
export const LIMB_SPINE_REACH = {
  clawed: { back: 0.97, fwd: 0.24 },   // the paw's toes reach towards the head
  fin:    { back: 0.30, fwd: 0.70 },
  stub:   { back: 0.42, fwd: 0.42 },
};

/**
 * The body radius a limb may size itself from, so that it does not reach into
 * a neighbouring segment. `st.ahead` and `st.behind` are how much clear run
 * the pseudo-station has each way (partsOf works them out from the joint's own
 * trims); 0.4 mm is a printable margin over the 0.315 mm the gap gate wants.
 *
 * This is a CLAMP, not a refusal, in gear.js's clamp-and-report tradition: a
 * short segment gets a small leg rather than an error. It is only half the
 * story: a limb rooted near the axis on a SHORT FAT body fouled the
 * neighbour's socket sideways, which no along-spine rule can see. Task 13
 * fixed that by rooting limbs low on the flank (see LIMBS), not here.
 */
function limbR(st, kind) {
  const reach = LIMB_SPINE_REACH[kind];
  if (!reach || !(st.ahead > 0) || !(reach.fwd > 0)) return st.r;
  // FORWARD ONLY, deliberately. Every measured failure that an along-spine
  // rule explains is a limb reaching towards the TAIL: the fin sweeps back
  // 1.16 r against 0.15 r forward, and on a hinge both sides are trimmed the
  // same so the forward case binds first. A backward cap was tried and shrank
  // limbs that measure clean, which is a cost with nothing bought.
  //
  // The floor keeps `capsule` buildable: it refuses a height under its own
  // diameter, and an unfloored cap drove the stub to 0.4 mm and threw.
  return Math.max(0.2 * st.r, Math.min(st.r, Math.max(0, st.ahead - 0.4) / reach.fwd));
}

/** A capsule whose two sphere centres are A and B, in whatever frame A and B
 *  are given in. */
function strut(A, B, rad, segments) {
  const d = B.map((v, k) => v - A[k]), L = Math.hypot(...d);
  const t = d.map(v => v / L);
  const up = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dot = up[0] * t[0] + up[1] * t[1] + up[2] * t[2];
  let n = up.map((v, k) => v - dot * t[k]);
  const nl = Math.hypot(...n); n = n.map(v => v / nl);
  const b = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  return toFrame(capsule(rad, L + 2 * rad, { segments, z0: -rad }), { p: A, t, n, b });
}

/** Lift every vertex of a part-local mesh whose up (local x) is under `h`. */
function floorClampLocal(mesh, h) {
  const v = mesh.positions;
  for (let i = 0; i < v.length; i += 3) if (v[i] < h) v[i] = h;
  return mesh;
}

/** Where the plate is, in a limb's local frame: the belly is `st.r` below the
 *  axis, and a part's flat sits PART_LIFT above the body's. */
const plateX = st => -st.r + FLOOR + PART_LIFT;

/**
 * Limbs: `(st, side, p, ctx)`, side +1 or -1 along the station's b, built in
 * the part frame (x up, y the creature's side, z along the spine towards the
 * tail) and carried on by asPart.
 *
 * EVERY LIMB STANDS ON THE PLATE. The first set hung 1.2 r below the belly,
 * so the whole body printed 6.5 mm (dragon) to 14 mm (capybara) up in the air
 * on supports. Now the belly is on the plate (spineOf) and every foot is
 * flattened onto the same plane, so a creature prints with nothing under it
 * but the bed. Sizes follow `limbR` (the spine-reach cap); where the plate is
 * follows the real body radius, `st.r`, because the belly is where it is
 * whatever size the leg came out.
 *
 * ROOTED APART. The two legs of a pair start on their own side of the axis:
 * mirror-image solids that overlap meet exactly in the mirror plane, which
 * also carries the tube's belly seam, and that came back non-manifold.
 *
 * FLATTENING IS SAFE BECAUSE NOTHING BELOW THE PLANE FACES UP. Every foot is
 * a sphere or a horizontal cone whose centre line sits above the plane, so
 * only downward-facing surface is lifted and nothing folds.
 */
export const LIMBS = {
  // Sprawled like a lizard: the upper leg runs out from the flank to an elbow
  // above the axis, the shin drops straight down to a foot pad, three toes
  // lie forward on the plate. The upper leg is a bridge between the flank and
  // the shin, which a printer spans; a shin that leans is an overhang, which
  // it does not, so it is vertical.
  clawed: (st, side, p, ctx) => {
    const R = st.r, r = limbR(st, 'clawed'), { n } = partQ(ctx);
    const segs = Math.max(8, n >> 1);
    const ru = thin(0.24 * r, 0.9), rl = thin(0.2 * r, 0.8), rf = thin(0.3 * r, 1.0);
    const xf = plateX(st), hp = thin(0.25 * r, 0.8);
    // Rooted low on the flank, 0.56 R off the axis, like the stub and for
    // the same reason: at 0.3 R the root reached the neighbour's socket on a
    // short fat body (0.0004 mm at bodyR 13, segLen 16).
    const root = [-0.25 * R, side * 0.5 * R, 0];
    const knee = [0.2 * R, side * (R + 0.35 * r), 0];
    const fy = side * (R + 0.5 * r), fz = -0.1 * r;
    // THE PAW IS ONE FLAT OUTLINE, extruded up off the plate: a pad with three
    // toes fanned forward and out. Toes were cones flattened onto the plate,
    // which left slivers the body union choked on at draft quality on every
    // leg segment of the dragon and the lizard. The shin's end ball sinks
    // half the paw's thickness into it, so nothing is flattened and no face
    // lies in another's plane.
    const toes = [-1, 0, 1].map(k => (180 + k * 30 - side * 15) * DEG);   // angle in (side, along): 180 at the head, below 180 outward on the right
    const pts = [];
    for (let q = 0; q < 16; q++) {
      const a = TAU * q / 16;
      pts.push([Math.cos(a) * rf, Math.sin(a) * rf]);
      for (const ta of toes) {
        const next = TAU * (q + 1) / 16;
        const t = ((ta % TAU) + TAU) % TAU;
        if (t > a && t < next) pts.push([Math.cos(t) * (rf + 0.6 * r), Math.sin(t) * (rf + 0.6 * r)]);
      }
    }
    // Outline (u, w) is (side, along) about the foot; carried so u -> y, w -> z
    // and the extrusion rises along x. (y, z, x) is right-handed.
    const paw = toFrame(extrude(pts.map(([c, sn]) => [sn, c]).reverse(), hp),
      { p: [xf, fy, fz], n: [0, 1, 0], b: [0, 0, 1], t: [1, 0, 0] });
    const foot = [xf + 0.5 * hp + rl, fy, fz];
    return asPart(unionAll([strut(root, knee, ru, segs), strut(knee, foot, rl, segs), paw]), st);
  },

  // A flipper lying flat on the plate, swept back towards the tail and rooted
  // in the lower flank. It used to stand off the body at 35 degrees, which is
  // a thin sheet cantilevered into the air.
  fin: (st, side, p, ctx) => {
    const R = st.r, r = limbR(st, 'fin');
    const t = thin(0.25 * r, 0.8), y0 = 0.35 * R;
    // Outline in (side, along), counter-clockwise for the right-hand fin.
    let pts = [[y0, -0.3 * r], [y0 + 0.9 * r, -0.1 * r], [y0 + 1.25 * r, 0.45 * r], [y0 + 0.6 * r, 0.7 * r], [y0, 0.4 * r]];
    // Mirroring one axis reverses the winding, so the left fin runs backwards.
    pts = side > 0 ? pts : pts.map(([y, z]) => [-y, z]).reverse();
    // extrude builds in (X, Y) and rises along Z: carry X to side, Y to along
    // the spine and Z to up. (y, z, x) is right-handed, so nothing mirrors.
    const sheet = toFrame(extrude(pts, t), { p: [plateX(st), 0, 0], n: [0, 1, 0], b: [0, 0, 1], t: [1, 0, 0] });
    return asPart(sheet, st);
  },

  // A short thick leg from the flank down to a foot just outside the belly:
  // what a capybara or a caterpillar has, and what prints without help.
  stub: (st, side, p, ctx) => {
    const R = st.r, r = limbR(st, 'stub'), { n } = partQ(ctx);
    const rs = thin(0.42 * r, 1.0), xf = plateX(st);
    // Rooted low on the flank, 0.61 R off the axis. At 0.4 R the root sphere
    // crossed the spine and reached the neighbour's socket cavity: 0.0000 mm
    // on the default body, measured.
    const root = [-0.35 * R, side * 0.5 * R, 0];
    const foot = [xf + 0.55 * rs, side * (0.8 * R + 0.2 * rs), 0];
    return asPart(floorClampLocal(strut(root, foot, rs, Math.max(8, n >> 1)), xf), st);
  },
};

/**
 * STITCHED LEGS (Task 19). A leg is a branch of its segment's own tube: a
 * hole in the flank between a few plain BRACKET rings, and a tube stitched to
 * the hole's rim, swept from the hip out and up to the knee and straight down
 * to the ankle, ending in a foot lofted from the shin down to a flat pad on the
 * plate. No boolean anywhere on the segment, so it can wear its crown too.
 *
 * Figures in units of bodyR. `toes` are [angle, length]: angle in degrees
 * from straight out towards the head (90 points forward), length from the
 * foot's centre. `pad` is the pad's radius between toes, `width` a toe's
 * half width in degrees.
 */
export const LEG_LOFTS = {
  clawed:  { toes: [[35, 0.55], [65, 0.65], [95, 0.55]], pad: 0.32, width: 11, thigh: 0.28, shin: 0.22 },
  splayed: { toes: [[-70, 0.5], [-25, 0.5], [15, 0.5], [55, 0.6], [95, 0.5]], pad: 0.3, width: 9, thigh: 0.26, shin: 0.2 },
  // A capybara's: short and thick, a round pad with three blunt toes forward.
  stub:    { toes: [[30, 0.44], [60, 0.46], [90, 0.44]], pad: 0.34, width: 16, thigh: 0.3, shin: 0.28 },
};

const LEG_RING = 48;        // bracket and leg rings: a whole multiple of the tube's
const LEG_BANDS = 4;        // bands between the bracket rings

/**
 * The two legs of a segment, as branches for `tubeThrough`. `rings` is the
 * segment's run of rings between station `a` and ring `next` (the crown's and
 * the leg's brackets together); `j0`..`j1` are the brackets, between which
 * each leg cuts its hole, and `s0` is where `rings[0]` sits in the tube's
 * list. `zc` is the hip, mm along the band.
 */
export function legStretch(L, rings, j0, j1, a, next, zc, s0, R) {
  const len = Math.hypot(...next.p.map((v, k) => v - a.p[k]));
  const m = rings[j0].pts.length;
  const nrm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const add = (...vs) => vs.reduce((acc, v) => acc.map((x, k) => x + v[k]));
  const mul = (v, k) => v.map(x => x * k);
  const sub = (u, v) => u.map((x, k) => x - v[k]);
  // The frame at the hip: interpolated like the crown's, t along the band.
  const u = zc / len, c = a.p.map((v, k) => lerp(v, next.p[k], u)), r = lerp(a.r, next.r, u);
  const n = nrm(a.n.map((v, k) => lerp(v, next.n[k], u)));
  let bb = a.b.map((v, k) => lerp(v, next.b[k], u));
  bb = nrm(bb.map((v, k) => v - dot(bb, n) * n[k]));
  const t = cross(n, bb);                                   // towards the tail
  const pad = Math.max(0.8, 0.1 * R), step = TAU / m;
  return [-1, 1].map(side => {
    const d = mul(bb, side);
    // Centred 100 degrees round from up, just below the side: the hole starts
    // at 74, clear of the crown's lowest tooth (60 +- 13).
    const ac = (side > 0 ? 100 : 260) * DEG;
    const i0 = Math.round((ac - 26 * DEG) / step), i1 = Math.round((ac + 26 * DEG) / step);
    // The rim, in tubeThrough's order.
    const P = rings.map(q => q.pts), rim = [];
    for (let i = i0; i <= i1; i++) rim.push(P[j0][i]);
    for (let s = j0 + 1; s < j1; s++) rim.push(P[s][i1]);
    for (let i = i1; i >= i0; i--) rim.push(P[j1][i]);
    for (let s = j1 - 1; s > j0; s--) rim.push(P[s][i0]);
    const root = mul(add(...rim), 1 / rim.length);
    // THE PATH, in the (d, n) plane: a straight thigh leaving the flank 15
    // degrees up, a knee that is an arc of radius KNEE turning down, and a
    // straight vertical shin to the ankle. A cubic through the same points put
    // its two inner controls nearly on top of each other, and the rings
    // crossed on the inside of the corner (self-intersecting, 40 pairs). The
    // arc's radius is 1.2 x the thigh's, so no two ring planes meet inside
    // the tube.
    const KNEE = 1.2 * L.thigh * R, L1 = 0.2 * R, up = 15 * DEG;
    const dirAt = th => add(mul(d, Math.cos(th)), mul(n, Math.sin(th)));
    const Pa = add(root, mul(dirAt(up), L1));
    const Cn = add(Pa, mul(d, KNEE * Math.sin(up)), mul(n, -KNEE * Math.cos(up)));   // the knee's centre
    const knee = th => add(Cn, mul(dirAt(th + Math.PI / 2), KNEE));          // on the arc, heading th
    const shinTop = knee(-Math.PI / 2);
    const ankle = add(c, mul(n, -r + pad + 0.3 * R), mul(d, dot(shinTop.map((v, k) => v - c[k]), d)));
    const path = [];                                                 // [point, tangent]
    path.push([add(root, mul(dirAt(up), 0.6 * L1)), dirAt(up)], [Pa, dirAt(up)]);
    for (let q = 1; q <= 6; q++) { const th = up - (up + Math.PI / 2) * q / 6; path.push([knee(th), dirAt(th)]); }
    for (let q = 1; q <= 3; q++) path.push([add(shinTop, mul(sub(ankle, shinTop), q / 3)), mul(n, -1)]);
    // Each rim point's angle round the leg's start, kept for every ring after
    // it, with the frame carried along the path so the tube never twists.
    let T = path[0][1], U = nrm(t.map((v, k) => v - dot(t, T) * T[k])), V = cross(T, U);
    let phi = rim.map(q => { const w = q.map((v, k) => v - root[k]); return Math.atan2(dot(w, V), dot(w, U)); });
    for (let j = 1; j < phi.length; j++) { while (phi[j] - phi[j - 1] > Math.PI) phi[j] -= TAU; while (phi[j] - phi[j - 1] < -Math.PI) phi[j] += TAU; }
    const out = [];
    path.forEach(([cc, Tk], k) => {
      T = Tk; U = nrm(U.map((v, kk) => v - dot(U, T) * T[kk])); V = cross(T, U);
      const rr = lerp(L.thigh, L.shin, k / (path.length - 1)) * R * (k === 0 ? 1.15 : 1);
      out.push({ pts: phi.map(f => add(cc, mul(U, rr * Math.cos(f)), mul(V, rr * Math.sin(f)))) });
    });
    // THE FOOT: the shin's ring, then rings at four times the points, flaring
    // to the toes at the pad's top and dropping straight to the plate.
    const fine = [];
    for (let j = 0; j < phi.length; j++) {
      const f0 = phi[j], f1 = j + 1 < phi.length ? phi[j + 1] : phi[0] + (phi[phi.length - 1] > phi[0] ? TAU : -TAU);
      for (let q = 0; q < 4; q++) fine.push(lerp(f0, f1, q / 4));
    }
    const foot = add(c, mul(n, -r), mul(d, dot(sub(ankle, c), d)));
    const fwd = mul(t, -1);
    const starR = f => {
      const dir = add(mul(U, Math.cos(f)), mul(V, Math.sin(f)));
      const th = Math.atan2(dot(dir, fwd), dot(dir, d)) / DEG;
      let rho = L.pad;
      for (const [ta, tl] of L.toes) rho = Math.max(rho, L.pad + (tl - L.pad) * Math.max(0, 1 - Math.abs(th - ta) / L.width));
      return { dir, rho: rho * R };
    };
    const flat = (h, star, rad) => ({ pts: fine.map(f => { const { dir, rho } = starR(f); return add(foot, mul(n, h), mul(dir, star ? rho : rad)); }) });
    out.push(flat(pad + 0.12 * R, false, 1.15 * L.shin * R), flat(pad, true), flat(0, true));
    return { s0: s0 + j0, s1: s0 + j1, i0, i1, rings: out, tip: foot };
  });
}

/** Dorsal rows: `(st, p, ctx)` per SEGMENT station (the centre of its safe
 *  span). `st.len` is the span the piece may occupy along the spine. */
/**
 * STITCHED CROWNS (Task 18). The dorsal spikes as ring modulations of each
 * segment's own tube, like the heads: no cone unioned onto the back, so no
 * boolean and nothing to weld across a joint.
 *
 * Each spike is a TOOTH: a long front slope rising along the segment to a
 * sharp back face at the end of its skin span, which is what reads as raked
 * back. In angle it is a tent (pointed), not a Gaussian (a bump). `spikes`
 * are [angle from up, height], heights in units of the station radius and
 * mirrored to both sides when the angle is not 0. `width` is the tent's half
 * width in degrees. Kept above 60 degrees from up: a spike further round the
 * flank overhangs its own underside. Angles are multiples of 30 degrees so
 * every spike lands on a ring point at every quality (draft rings have 12).
 * `over` (station radii) is how far the
 * tallest tooth's tip is dragged back past the end of its span, out over the
 * seam, the way the heads rake their horns: the crown hides the gap. Only the
 * peak ring moves, in proportion to each point's height, so every angle's
 * profile is a hook that never crosses itself.
 */
export const CROWNS = {
  crown: { spikes: [[0, 0.95], [30, 0.7], [60, 0.42]], width: 13, over: 0.6 },
  crest: { spikes: [[0, 0.85]], width: 16, over: 0.5 },
};

/** The crown's height at ring angle a (radians from up), before the tooth's
 *  profile along the segment scales it. */
function crownAt(C, a) {
  let h = 0;
  for (const [deg, ht] of C.spikes) {
    for (const sgn of deg ? [1, -1] : [1]) {
      const da = Math.abs(a - sgn * deg * DEG) / (C.width * DEG);
      h = Math.max(h, ht * Math.max(0, 1 - da));
    }
  }
  return h;
}

/**
 * The crown's rings between two rings of the tube: `a`, the segment's own
 * station, and `b`, the NEXT ring the tube stitches to (the shoulder, the
 * nested cup's first ring or the next station). Every crown point lies on the
 * straight band the plain tube would have drawn between them, point i of a to
 * point i of b, and then stands out from it. On a curve the two end rings are
 * tilted apart, and rings on level frames of their own crossed the tilted one:
 * self-intersecting, and every boolean on that segment afterwards rolled bad
 * edges (lizard S-curve, 23 at fine).
 *
 * `span` is in mm along the band from a. A plain ring at each end of it, the
 * tooth rising between, its peak a fraction of a millimetre before the back
 * so the back face is near vertical. `m` points a ring: the TUBE'S OWN
 * count. At 48 zipped onto the tube's 24, the legs unioned onto a crowned
 * segment rolled bad edges on every curve (lizard S-curve, 30 at fine); at
 * 24 the same builds are clean. The raw stitched mesh was sound either way,
 * checked for self-intersection; it is the boolean that cannot take the zip.
 */
export function crownRings(C, a, b, span, ctx, m, extra = []) {
  const len = Math.hypot(...b.p.map((v, k) => v - a.p[k]));
  const from = span.from, to = Math.min(span.to, 0.95 * len);
  const tooth = C && to - from > 2;
  if (!tooth && !extra.length) return [];
  const A = ring(a, a.r, m), B = ring(b, b.r, m);
  const nrm = v => { const L = Math.hypot(...v); return v.map(x => x / L); };
  const gen = A.map((q, i) => nrm(B[i].map((v, k) => v - q[k])));      // each point's line along the band
  const back = Math.min(0.4, 0.1 * (to - from)), peak = to - back;
  const steps = Math.max(3, Math.round(6 * segScale(ctx)));
  let zs = [];
  if (tooth) {
    zs.push(from);
    for (let j = 1; j <= steps; j++) zs.push(from + (peak - from) * j / steps);
    zs.push(to);
  }
  // `extra` rings (a leg's brackets) join the same run, so a legged segment
  // wears the whole tooth with the leg's hole in its flank.
  zs = [...zs, ...extra].sort((x, y) => x - y).filter((z, j, l) => j === 0 || z - l[j - 1] > 1e-6);
  const rise = z => !tooth || z <= from || z >= to ? 0 : z <= peak ? (z - from) / (peak - from) : (to - z) / back;
  return zs.map(z => {
    const u = z / len, c = a.p.map((v, k) => lerp(v, b.p[k], u)), r = lerp(a.r, b.r, u);
    const rz = rise(z), atPeak = tooth && Math.abs(z - peak) < 1e-6;   // the tooth: 0 up to 1, then the back face
    const pts = A.map((q, i) => {
      const base = q.map((v, k) => lerp(v, B[i][k], u));
      if (!tooth) return base;
      const out = nrm(base.map((v, k) => v - c[k]));
      const ang = TAU * i / m, h = crownAt(C, Math.atan2(Math.sin(ang), Math.cos(ang)));
      // The peak ring's tips rake back over the seam, along the band.
      const drag = atPeak ? (C.over || 0) * r * h / C.spikes[0][1] : 0;
      return base.map((v, k) => v + rz * h * r * out[k] + drag * gen[i][k]);
    });
    return { pts, p: c, r, z };
  });
}

export const DORSAL = {
  none: () => new Mesh(),

  spikes: (st, p, ctx) => {
    const r = st.r, { n } = partQ(ctx);
    const h = Math.min(0.8 * r, 0.9 * (st.len ?? r));
    // Base sunk 0.25 r into the body; raked back 20 degrees towards the tail.
    const spike = cone(thin(0.28 * r, 0.9), h + 0.25 * r, { segments: Math.max(8, n >> 1), z0: -0.25 * r });
    return asPart(toUp(spike).rotateY(-20 * DEG).translate(r - 0.1 * r, 0, 0), st);
  },

  fin: (st, p, ctx) => {
    const r = st.r;
    const L = 0.8 * (st.len ?? r), h = Math.min(0.9 * r, L);
    // Sail: rounded on top, sunk 0.2 r into the back. Profile in (x = up, y = -back).
    const pts = [[-0.2 * r, L / 2], [-0.2 * r, -L / 2], [h * 0.9, -L * 0.3], [h, 0], [h * 0.85, L * 0.35]];
    const t = thin(0.3 * r, 0.8);
    return asPart(extrude(pts, t, { z0: -t / 2 }).rotateX(-Math.PI / 2).translate(r - 0.05 * r, 0, 0), st);
  },

  plates: (st, p, ctx) => {
    const r = st.r;
    const L = Math.min(0.55 * (st.len ?? r), 1.1 * r), h = Math.min(0.9 * r, L), t = thin(0.25 * r, 0.8);
    // A rounded plate standing up out of the back, leaning 15 degrees back.
    const plate = roundedBox(L, t, h + 0.25 * r, Math.min(0.12 * r, t * 0.45), { z0: -0.25 * r });
    return asPart(toUp(plate).rotateY(-15 * DEG).translate(r - 0.1 * r, 0, 0), st);
  },
};

/** The heads with a muzzle to split. Any other head asked for a jaw is a
 *  validate() error rather than a silently solid face (the spec's words). */
export const JAW_HEADS = ['dragon', 'lizard', 'fish'];

/**
 * The jaw's numbers, in the HEAD'S OWN FRAME (before asPart): +Z out along the
 * muzzle, +X up, +Y across. `rh` is the head radius, HEAD_R x the body's.
 *
 *   xj     the mouth line, a little below the axis so the mandible reads as a
 *          lower jaw and the horns, brows and eyes all stay on the skull
 *   zc     the pivot, set so the socket behind it clears station 0 — where the
 *          body tube ends — by a full millimetre. Put it nearer and the tube,
 *          unioned into the same segment, refills the back of the socket.
 *   Rk     the barrel the mandible turns on, hw its half-length across
 *   front  where the mandible's body starts: the barrel plus a clearance clear
 *          of the pivot, so the only thing crossing that gap is the neck
 */
export function jawGeometry(rh, c) {
  const Rk = 0.28 * rh, hw = 0.3 * rh, xj = -0.15 * rh;
  const zc = Rk + c + 1.0;
  return { Rk, hw, xj, zc, neck: 0.6 * Rk, front: zc + Rk + c, c };
}

/**
 * The head, split into a cranium that stays fused to the first segment and a
 * mandible that turns on a hinge at the jaw corner. Both in the head's own
 * frame; the caller carries them onto the station.
 *
 * WHY NOT joint('hinge'). The spec says "a hinge between them", and this is
 * one — a single axis, across the head. But `hingeJoint` is built to join two
 * tube segments end to end: its `cutA` and `cutB` are unbounded half-spaces
 * (4 x rMax on a side) that would slice the entire head in two, skull and all,
 * and its knuckles then need relief cut round them in a head that is mostly
 * not there. So the jaw is the same one-axis joint built for the case in
 * hand: a BARREL on the back of the mandible, captive in a cylindrical SOCKET
 * in the skull, with the clearance applied once, by growing the socket — the
 * rule joint.js follows too. Everything is cut in this frame with axis-aligned
 * boxes and one cylinder, which is the configuration the kernel's arithmetic
 * survives (ruling 30), and it costs four booleans on one part rather than
 * four per joint down the spine.
 *
 * Captivity is geometric, not frictional. The skull keeps everything behind
 * the pivot and everything above the mouth line, so the socket wraps the
 * barrel through about 270 degrees; the open quadrant, forward and down, has a
 * chord of sqrt(2) x (Rk + c), which is less than the barrel's 2 Rk whenever
 * Rk > 2.4 c — at the 0.35 mm default any head over about 3 mm. The jaw opens
 * downward until the mandible's rear corner meets the skull behind the pivot,
 * roughly 20 degrees on a dragon: a gape, not a yawn.
 */
export function splitHead(head, rh, p, jawFrom = head) {
  const c = Math.max(0, num(p.clearance, fit('free')));
  const g = jawGeometry(rh, c);
  const big = 8 * rh;
  // A half-space as a big box: below the plane x = top, ahead of z = from.
  const below = (top, from) => box(big, big, big, { z0: from }).translate(top - big / 2, 0, 0);
  const acrossY = (r, half) => cylinder(r, 2 * half, { segments: 32, z0: -half })
    .rotateX(Math.PI / 2).translate(g.xj, 0, g.zc);

  // The skull loses the mouth and the socket. The mouth is the half-space
  // below the jaw line PLUS the clearance, so the mandible, which keeps
  // everything below the line itself, sits exactly `c` under the skull.
  const socket = acrossY(g.Rk + c, g.hw + c);
  const cranium = subtract(head, union(below(g.xj + c, g.zc), socket));

  // `jawFrom` is the same head surface ahead of the pivot, when the caller
  // has a smaller mesh of it than `head` (a lofted head's whole segment).
  const body = intersect(jawFrom, below(g.xj, g.front));
  const barrel = acrossY(g.Rk, g.hw);
  // The neck ties the barrel to the jaw. Its top is flush with the jaw line,
  // so it too sits `c` under the skull; it runs 1 mm into the jaw's body so
  // the union is a crossing, never a coplanar face.
  const neck = box(g.neck, 2 * g.hw, g.front + 1 - g.zc, { z0: g.zc }).translate(g.xj - g.neck / 2, 0, 0);
  const mandible = union(body, union(barrel, neck));
  return { cranium, mandible, geometry: g };
}

// ---------------------------------------------------------------------------
// Fitting the plate.
// ---------------------------------------------------------------------------

export const BED = { x: 180, y: 180, z: 180 };

/** How far a built creature reaches past its own spine's bbox, per side in XY,
 *  per mm of body radius. MEASURED: the worst of 35 dressed builds — every
 *  species in every pose, and every tail with every limb kind under a capybara
 *  head — was 1.87 (the capybara, straight). 2.1 is that plus 12%, so the
 *  fitter can bisect on the spine, which costs milliseconds, instead of
 *  rebuilding the whole animal fourteen times. The fit suite holds the real
 *  mesh to it. Ruling 56. */
export const REACH_PAST_SPINE = 2.1;

/** What the fitter measures: the stations, which it pads by REACH_PAST_SPINE,
 *  and a lofted head's or tail's own ring points, which it does not. A lofted head runs
 *  3 bodyR and more out along the spine (Task 17). Padding its nose like a
 *  station called a 169 mm dragon 195 mm and coiled it; its rings are exact
 *  and cost a few hundred points. */
export function reachPoints(p, ctx) {
  const { stations } = spineOf(p, ctx);
  const { head, tail } = asBuilt(p), st = stations[0], last = stations[stations.length - 1];
  const exact = HEAD_LOFTS[head]
    ? headRings(head, st, st.t.map(v => -v), ctx, tubeFacets(ctx), num(p.bodyR, 9)).flatMap(q => q.pts || [q.p])
    : [];
  // A lofted tail likewise: the whip runs 4 station radii past its station.
  const tailExact = TAIL_LOFTS[tail] ? tailLoftRings(tail, last, tubeFacets(ctx)).flatMap(q => q.pts || [q.p]) : [];
  return { stations, exact: [...exact, ...tailExact], headLofted: exact.length > 0, tailLofted: tailExact.length > 0 };
}

/**
 * The pad goes where parts reach, in each station's own frame: sideways along
 * b at every station (legs, the capybara's 1.87 bodyR), and as a single point
 * on along t past each end (heads and tails, which are narrow there). Padding
 * along the bed's axes charged a diagonal animal 1/cos 45 of its real reach
 * sideways. No corners: a rectangle turned 45 degrees has a bigger box than
 * the one it replaced, which is what padding each end's corners did. A
 * straight animal measures exactly as it did.
 */
function spineFits(p, ctx, bed) {
  const { stations, exact, headLofted, tailLofted } = reachPoints(p, ctx), pad = REACH_PAST_SPINE * num(p.bodyR, 9);
  const last = stations.length - 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const grow = (q, d = [0, 0], s = 0) => {
    const x = q[0] + s * d[0], y = q[1] + s * d[1];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  stations.forEach((st, i) => {
    grow(st.p, st.b, pad); grow(st.p, st.b, -pad);
    if (i === last && !tailLofted) grow(st.p, st.t, pad);
    if (i === 0 && !headLofted) grow(st.p, st.t, -pad);
  });
  for (const q of exact) grow(q);
  return x1 - x0 <= bed.x && y1 - y0 <= bed.y;
}

/**
 * Fold the creature onto the plate. The number of segments asked for is the
 * one thing that is not negotiable: the POSE gives way instead. Keep the pose
 * asked for if it fits; wind a curved pose tighter by bisection if that is
 * enough; otherwise fall through to a more compact pose, loosest first,
 * because a looser curve prints better.
 *
 * Bounded (12 halvings a pose), deterministic, and cheap: it measures the
 * spine, padded by REACH_PAST_SPINE, never the built mesh.
 */
export function fitToBed(p, ctx, bed = BED) {
  const asked = POSES[p.pose] ? p.pose : 'diagonal';
  const t0 = clamp(num(p.tight, 0.5), 0, 1);
  const order = { straight: ['straight', 'scurve', 'coil'], diagonal: ['diagonal', 'scurve', 'coil'],
                  scurve: ['scurve', 'coil'], coil: ['coil'] }[asked];
  const fits = (pose, tight) => spineFits({ ...p, pose, tight }, ctx, bed);
  for (const pose of order) {
    const curved = pose === 'scurve' || pose === 'coil';
    if (!curved) { if (fits(pose, t0)) return { pose, tight: t0, tightened: false, fits: true }; continue; }
    const from = pose === asked ? t0 : 0;           // our own curve starts where asked; a fallback starts loose
    if (fits(pose, from)) return { pose, tight: from, tightened: pose !== asked, fits: true };
    if (!fits(pose, 1)) continue;
    let lo = from, hi = 1;
    for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fits(pose, mid)) hi = mid; else lo = mid; }
    return { pose, tight: Math.round(hi * 1000) / 1000, tightened: true, fits: true };
  }
  return { pose: 'coil', tight: 1, tightened: true, fits: false };
}

/** The most segments that fit the plate at all — the tightest coil, everything
 *  else as asked. What validate() names when nothing fits. */
function segmentsThatFit(p, ctx, bed = BED) {
  for (let n = Math.round(num(p.segments, 12)) - 1; n >= 3; n--) {
    if (spineFits({ ...p, segments: n, pose: 'coil', tight: 1 }, ctx, bed)) return n;
  }
  return 0;
}

/** The anatomy for one creature: which part goes on which segment. Limb
 *  positions come from the species row (`p.limbAt`, fractions of the spine)
 *  or fall back to evenly spaced. Returns, per segment, a list of world-space
 *  meshes to union in. `spans[i]` is each segment's safe span along the spine
 *  (what the joint trims leave of it), measured from its rear station. */
export function partsOf(p, ctx, stations, spans, skin = spans, stitched = new Set()) {
  const count = stations.length - 1;
  const per = Array.from({ length: count }, () => []);
  const head = HEADS[p.head] ? p.head : 'blunt';
  const tail = TAILS[p.tail] ? p.tail : 'taper';
  const dorsal = DORSAL[p.dorsal] ? p.dorsal : 'none';
  // A stitched kind that has to be a part on some segment is built as the
  // clawed part there (`stitched` names the segments that grow their own).
  const limbKind = LIMBS[p.limbKind] ? p.limbKind : LEG_LOFTS[p.limbKind] ? 'clawed' : 'stub';
  const hinged = p.joint === 'hinge';
  const pairs = clamp(Math.round(num(p.limbPairs, 0)), 0, 8);

  const chord = (i) => {
    const a = stations[i], b = stations[i + 1];
    const d = [b.p[0] - a.p[0], b.p[1] - a.p[1], 0], l = Math.hypot(...d);
    return { t: d.map(v => v / l), l };
  };
  // A pseudo-station at the centre of segment i's safe span, on the chord
  // between its two boundary stations (that is the tube's true axis; the
  // boundary tangents lean slightly on a curve). n is the real up; b follows.
  const midIn = (spans) => (i) => {
    const a = stations[i], b = stations[i + 1], { t, l } = chord(i);
    const { from, to } = spans[i];
    const d = (from + to) / 2, u = d / l;
    const n = a.n;
    const bb = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    // How much clear run the part has each way before it meets a neighbour.
    // The joint's own trims say it: whatever the joint takes off the NEXT
    // segment's rear is material that reaches back past the station, so it
    // comes off the run ahead (a hinge's knuckles interleave, a ball's socket
    // does not). Same the other way.
    // `trim` is what the joint takes off the NEXT segment's rear. For a ball
    // that is nothing, and the void ahead of this station is genuinely free at
    // the flank where a limb sits — the socket dome is a narrow thing on the
    // axis. For a hinge it is `face`, and the knuckles fill exactly that space
    // and then some, so it comes OFF the run instead of onto it. That sign is
    // the whole difference between the two joints here, and getting it the
    // other way round shrank the default creature's legs for nothing.
    const trim = i + 1 < count ? spans[i + 1].from - 0.5 : 0;
    const ahead = i + 1 < count
      ? (l - d) + (hinged ? -trim : trim)
      : Infinity;                       // the last segment has no neighbour ahead
    return { p: a.p.map((v, k) => lerp(v, b.p[k], u)), t, n, b: bb, r: lerp(a.r, b.r, u), len: to - from, ahead };
  };
  const mid = midIn(spans), midSkin = midIn(skin);

  // Pieces that belong to no segment: today, only a mandible. They are their
  // own shells, so they go out beside the segments rather than into one.
  per.free = [];
  // A lofted head is stitched into segment 0's tube by segmentsOf, not added.
  if (head !== 'none' && !HEAD_LOFTS[head]) {
    const st = { ...outward(stations[0]), reach: Math.max(0.5, spans[0].to - 0.5) };
    if (p.jaw && JAW_HEADS.includes(head)) {
      // Build the head in its own frame — an identity station with the same
      // radius and reach — split it there, then carry both halves on together.
      const here = { p: [0, 0, 0], n: [1, 0, 0], b: [0, 1, 0], t: [0, 0, 1], r: st.r, reach: st.reach };
      const { cranium, mandible } = splitHead(HEADS[head](here, p, ctx), HEAD_R * st.r, p);
      // One lift for both halves, or the jaw leaves its socket.
      const [c, m] = liftOnto([asPart(cranium, st), asPart(mandible, st)]);
      per[0].push(c);
      per.free.push(m);
    } else {
      per[0].push(...liftOnto([HEADS[head](st, p, ctx)]));
    }
  }
  {
    const last = stations[count], { l } = chord(count - 1);
    const st = { ...last, reach: Math.max(0.5, l - spans[count - 1].from - 0.5) };
    // Taper, whip and spade tails and the spike's shaft are stitched into the
    // last segment's tube by segmentsOf; only the spike's barbs are a part.
    if (tail === 'spike') per[count - 1].push(spikeBarbs(st, ctx));
    else if (tail !== 'taper' && !TAIL_LOFTS[tail]) per[count - 1].push(...liftOnto([TAILS[tail](st, p, ctx)]));
  }
  if (dorsal !== 'none') for (let i = 0; i < count; i++) per[i].push(DORSAL[dorsal](midSkin(i), p, ctx));
  // The gauge's numbers: step i on segment i, the segment just behind the
  // joint it names, so reading along the strip each number sits before its gap.
  if (p.species === 'gauge') {
    const steps = gaugeSteps(p);
    for (let i = 0; i < Math.min(steps.length, count - 1); i++) {
      const label = gaugeLabel(midSkin(i), steps[i].toFixed(2));
      if (!label.isEmpty()) per[i].push(label);
    }
  }
  if (pairs > 0) {
    for (const u of limbPositions(p)) {
      const i = clamp(Math.floor(clamp(u, 0, 0.999999) * count), 0, count - 1);
      if (stitched.has(i)) continue;
      const st = mid(i);
      per[i].push(LIMBS[limbKind](st, 1, p, ctx), LIMBS[limbKind](st, -1, p, ctx));
    }
  }
  return per;
}

/**
 * Each row is a whole animal. Adding one is a row, not an afternoon — which is
 * the entire point of the parts kit underneath.
 *
 * `articulate` names what MOVES. 'spine' is the body joints; anything else is a
 * part that gains a joint of its own. Wings are deliberately absent: small
 * print-in-place limb joints weld shut more often than they work, and one risky
 * joint should not decide whether five species ship.
 *
 * The dragon and lizard wear stitched crowns on NESTED seams (Task 18). With
 * open seams every crowned segment also carries the socket's two booleans, and
 * the crown's extra triangles took the S-curve and coil to 25 to 150 bad
 * edges; nested, with the crown left off the segments that carry legs, the
 * same 18 builds are clean at every quality. The nested gauge printed with
 * all five joints moving, which is what nested seams were waiting on.
 *
 * EVERY ROW HERE WAS BUILT AND MEASURED BEFORE IT WAS WRITTEN DOWN, because
 * there are no inherently safe body numbers — a joint is a dice roll and a
 * limb has to fit the segment it sits on (rulings 29, 46, 48). The capybara is
 * the one that argued: 6 x 16 at bodyR 13 is a bodyR/segLen of 0.81, and above
 * about 0.75 a limb fouls the neighbouring ball sideways. 6 x 20 keeps it fat
 * and short-bodied — 120 mm of animal — and reads 0.344 mm at the joint.
 */
export const SPECIES = [
  // 13, not the spec's 14. Fully dressed, every 14-segment row measured
  // (14 x 14, 14 x 15, 14 x 16) comes back with 6-7 bad edges at FINE quality
  // — the B-side boolean residue of ruling 41 — and 14 x 16 overflows the bed
  // at 182 mm. 13 x 15 is clean at draft, normal and fine and sits at 162 mm
  // on the diagonal. The defaults ARE this row, so it has to be clean. Ruling 50.
  { id: 'dragon', name: 'Dragon', joint: 'ball', segments: 13, segLen: 15, bodyR: 9,
    profile: 'tapered', head: 'dragon', tail: 'spade', dorsal: 'crown', seams: 'nested',
    limbs: { pairs: 2, kind: 'clawed', at: [0.25, 0.55] }, articulate: ['spine', 'jaw'] },

  { id: 'snake', name: 'Snake', joint: 'ball', segments: 18, segLen: 11, bodyR: 7,
    profile: 'tapered', head: 'blunt', tail: 'taper', dorsal: 'none',
    limbs: { pairs: 0, kind: 'stub', at: [] }, articulate: ['spine'] },

  { id: 'caterpillar', name: 'Caterpillar', joint: 'hinge', segments: 10, segLen: 13, bodyR: 10,
    profile: 'ribbed', head: 'bug', tail: 'nub', dorsal: 'none',
    limbs: { pairs: 5, kind: 'stub', at: [0.15, 0.3, 0.45, 0.6, 0.75] }, articulate: ['spine'] },

  // 4 x 28 on nested seams (Task 20): one loaf cut in four fat slices, as the
  // MakerWorld capybaras are. At 6 x 20 nested welded its legs into the next
  // slice; 3 x 32, 4 x 26, 4 x 30 and 5 x 24 all measured clean, and 4 x 28
  // keeps the old length. Clean at every pose and quality, 0.2949 mm at normal.
  { id: 'capybara', name: 'Capybara', joint: 'ball', segments: 4, segLen: 28, bodyR: 13,
    profile: 'loaf', head: 'capybara', tail: 'nub', dorsal: 'none', seams: 'nested',
    limbs: { pairs: 2, kind: 'stub', at: [0.22, 0.72] }, articulate: ['spine'] },

  { id: 'lizard', name: 'Lizard', joint: 'ball', segments: 12, segLen: 14, bodyR: 8,
    profile: 'tapered', head: 'lizard', tail: 'whip', dorsal: 'crest', seams: 'nested',
    limbs: { pairs: 2, kind: 'splayed', at: [0.2, 0.6] }, articulate: ['spine'] },
];

/**
 * The gauge: not an animal but a measuring instrument that happens to be the
 * same machine. Six segments, five joints, five clearances.
 *
 * bodyR 9, NOT the brief's 6. This strip exists to settle FIT.free for the
 * creatures, and how much clearance a joint needs depends on the joint: at
 * bodyR 6 the ball is 1.8 mm, at the default body's 9 it is 2.7 mm. Gauge the
 * joint the creatures actually have. It costs size — 66 mm rather than the
 * spec's "roughly 40", because six 11 mm segments is the shortest strip whose
 * joints clear their own floor at this radius. Ruling 54.
 */
SPECIES.push({ id: 'gauge', name: 'Joint gauge', joint: 'ball', segments: 6, segLen: 11, bodyR: 9,
  profile: 'flat', head: 'none', tail: 'nub', dorsal: 'none',
  limbs: { pairs: 0, kind: 'stub', at: [] }, articulate: ['spine'] });

const SPECIES_BY_ID = new Map(SPECIES.map(s => [s.id, s]));

/** The five clearances the gauge prints, centred on the current one: two steps
 *  of 0.05 either side, SHIFTED rather than clipped when that would leave the
 *  parameter's range, because a gauge with two identical gaps measures nothing. */
export function gaugeSteps(p) {
  const min = 0.15, max = 0.6, step = 0.05, n = 5;
  const lo = clamp(num(p.clearance, fit('free')) - 2 * step, min, max - (n - 1) * step);
  return Array.from({ length: n }, (_, i) => Math.round((lo + i * step) * 1000) / 1000);
}

/** What the gauge IS, whatever else is set. The species is the one parameter
 *  that changes the build rather than only carrying values, and only here: a
 *  coiled gauge is a worse instrument, a head is in the way, and five gaps need
 *  exactly six pieces. Segment length, radius, joint kind and the centre
 *  clearance stay the user's. */
function asBuilt(p) {
  return p.species === 'gauge'
    ? { ...p, segments: 6, pose: 'straight', head: 'none', tail: 'nub', limbPairs: 0, dorsal: 'none', jaw: false }
    : p;
}

/** A number, embossed on the crown of a segment and reading ACROSS it. Along
 *  the spine a segment offers 5.6 mm of span and "0.25" at a 3 mm cap is 9.3 mm
 *  long, so it runs across the 18 mm body instead. The top is flat, 0.6 mm
 *  proud of the crown — three layers — and the base is sunk 1.6 mm, deep
 *  enough to meet the tube where the crown curves away under the ends of the
 *  text. */
function gaugeLabel(st, text) {
  if (!GAUGE_FONT) return new Mesh();
  const lay = layoutText(GAUGE_FONT, text, { size: 3, align: 'center', vAlign: 'baseline' });
  if (!lay.shapes || !lay.shapes.length) return new Mesh();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const sh of lay.shapes) for (const ring of sh) for (const [x, y] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const shapes = lay.shapes.map(sh => sh.map(ring => ring.map(([x, y]) => [x - cx, y - cy])));
  const sink = 1.6, proud = 0.6;
  // Text is laid out in XY and extruded along Z. In a part's frame +X is up,
  // +Y across, +Z along the spine: reading goes across (+Y), the glyphs stand
  // towards the tail (+Z), and the extrusion points up (+X). (X,Y,Z)->(Z,X,Y)
  // is a cyclic permutation, a proper rotation, so the winding survives.
  const solid = extrude(shapes, sink + proud, { z0: st.r - sink }).mapVerts((x, y, z) => [z, x, y]);
  return asPart(solid, st);
}

/**
 * What picking a species sets. ONE function behind both the enum's `carries`
 * and the presets, so a menu that sets one thing and a preset that sets
 * another — the commonest way a table like this rots — cannot happen.
 *
 * `jaw` is carried but the PARAMETER's own default stays false: Task 6's gate
 * builds from `defaults(gen)` and asserts one shell per segment, and a jaw in
 * the defaults adds a shell and turns a correct gate into a failing one for
 * the wrong reason. Ruling 1.
 */
export function speciesCarries(id) {
  const s = SPECIES_BY_ID.get(id);
  if (!s) return {};
  return {
    joint: s.joint, segments: s.segments, segLen: s.segLen, bodyR: s.bodyR,
    profile: s.profile, head: s.head, tail: s.tail, dorsal: s.dorsal, seams: s.seams || 'open',
    // Each seam its own measured gap: nested printed perfect at 0.30.
    clearance: fit(s.seams === 'nested' ? 'nested' : 'free'),
    limbPairs: s.limbs.pairs, limbKind: s.limbs.kind,
    jaw: s.articulate.includes('jaw'),
  };
}

/** Where the limb pairs sit along the spine: the species row's own positions
 *  when it has the right number of them, `p.limbAt` when a caller passes one,
 *  else evenly spaced. */
export function limbPositions(p) {
  const n = clamp(Math.round(num(p.limbPairs, 0)), 0, 8);
  if (Array.isArray(p.limbAt) && p.limbAt.length >= n) return p.limbAt.slice(0, n);
  const s = SPECIES_BY_ID.get(p.species);
  if (s && s.limbs.at.length === n) return s.limbs.at;
  return Array.from({ length: n }, (_, k) => (k + 1) / (n + 1));
}

/** Dimension callouts, in the placed mesh's coordinates. `segLen` measures
 *  exactly between two stations; the radius callout names `bodyR` and carries
 *  its measured value whenever the profile's widest point is not exactly that
 *  (the barrel's is 1.12x) — the same convention gear.js uses. */
function creatureDims(p, stations, shift) {
  const dims = [];
  const at = (st, extra = [0, 0, 0]) =>
    [st.p[0] + shift[0] + extra[0], st.p[1] + shift[1] + extra[1], st.p[2] + shift[2] + extra[2]];
  dims.push({ param: 'segLen', label: 'seg', from: at(stations[0]), to: at(stations[1]), offset: 10 });
  const wi = stations.reduce((best, st, i) => (st.r > stations[best].r ? i : best), 0);
  const wst = stations[wi];
  const len = wst.r;
  dims.push({
    param: 'bodyR', label: 'R',
    from: at(wst),
    to: at(wst, [wst.n[0] * len, wst.n[1] * len, wst.n[2] * len]),
    offset: 10,
    ...(Math.abs(len - p.bodyR) > 0.02 ? { value: len } : {}),
  });
  return dims;
}

export default {
  id: 'creature',
  name: 'Articulated Creature',
  category: 'Toys',
  blurb: 'A print-in-place creature that comes off the plate in one piece and bends.',
  description:
    'A body lofted along a spine and cut into segments, with a ball-and-socket or ' +
    'pin-hinge joint between each pair, all printed in one go with no supports and ' +
    'no assembly. Pick a species for a whole animal, then change anything you like — ' +
    'the species is only a set of starting numbers. The pose is how it prints, not ' +
    'how it lives: every joint moves, so a coiled dragon straightens out in your hand.',
  version: 1,
  params: [
    // The species DEFAULTS to the dragon but the body parameters do NOT carry
    // it: they stay the bare 12 x 14 body every structural test was measured
    // against. Dressing the defaults put a head, a tail, two pairs of legs and
    // a spined back on every pose and profile the suites build, and each part
    // is another boolean per segment — at about 1% a joint, some of those
    // cells always came up with 1-6 bad edges (ruling 41's residue). Picking
    // Dragon from the menu, or its preset, dresses it. Ruling 50.
    { key: 'species', label: 'Species', type: 'enum', def: 'dragon', group: 'Species',
      options: SPECIES.map(s => ({ v: s.id, label: s.name })),
      carries: speciesCarries,
      help: 'A whole animal in one pick. Everything it sets stays editable afterwards — ' +
            'a dragon in one click and a dragon-headed caterpillar in four.' },
    { key: 'segments', label: 'Segments', type: 'int', min: 3, max: 24, step: 1, def: 12, group: 'Body',
      help: 'How many pieces the body is cut into. One joint between each pair.' },
    { key: 'segLen', label: 'Segment length', type: 'number', unit: 'mm',
      min: 6, max: 26, step: 0.5, def: 14, group: 'Body',
      help: 'Along the spine. Shorter segments curl more tightly and print slower.' },
    { key: 'bodyR', label: 'Body radius', type: 'number', unit: 'mm',
      min: 4, max: 22, step: 0.5, def: 9, group: 'Body',
      help: 'At the thickest point. The joint sizes itself from this.' },
    { key: 'profile', label: 'Body shape', type: 'enum', def: 'tapered', group: 'Body',
      options: [
        { v: 'tapered', label: 'Tapered' }, { v: 'barrel', label: 'Barrel' },
        { v: 'flat', label: 'Even' }, { v: 'ribbed', label: 'Ribbed' }, { v: 'loaf', label: 'Loaf' },
      ],
      help: 'How the radius changes from head to tail.' },
    { key: 'pose', label: 'Print pose', type: 'enum', def: 'diagonal', group: 'Plate',
      options: [
        { v: 'diagonal', label: 'Diagonal' }, { v: 'straight', label: 'Straight' },
        { v: 'scurve', label: 'S-curve' }, { v: 'coil', label: 'Coiled' },
      ],
      help: 'How it is laid out on the plate. Only affects printing — it bends either way. ' +
            'Diagonal is the default because a square bed is 41% longer corner to corner.' },
    { key: 'tight', label: 'Curve tightness', type: 'number',
      min: 0, max: 1, step: 0.05, def: 0.5, group: 'Plate',
      showIf: (p) => p.pose !== 'straight' && p.pose !== 'diagonal',
      help: 'How hard the S or the coil is wound. Raised automatically if it overflows the bed.' },
    { key: 'joint', label: 'Joint', type: 'enum', def: 'ball', group: 'Joint',
      options: [{ v: 'ball', label: 'Ball and socket' }, { v: 'hinge', label: 'Pin hinge' }],
      help: 'Ball curls in every direction; a hinge bends in one plane and is much stronger.' },
    { key: 'clearance', label: 'Joint clearance', type: 'number', unit: 'mm',
      min: 0.15, max: 0.6, step: 0.05, def: fit('free'), group: 'Joint',
      help: 'The gap that stops the joint fusing as it prints. ' + fitNote('free') },
    { key: 'seams', label: 'Seams', type: 'enum', def: 'open', group: 'Joint', showIf: (p) => p.joint !== 'hinge',
      options: [{ v: 'open', label: 'Open' }, { v: 'nested', label: 'Nested' }],
      help: 'Nested hides the gap between segments: each one cups the next around the ball, leaving a seam about 1 mm wide instead of a 4 mm gap. Printed and measured: every gap from 0.25 moves, 0.30 is best. ' + fitNote('nested') },
    { key: 'swing', label: 'Swing per joint', type: 'number', unit: 'deg',
      min: 8, max: 35, step: 1, def: 25, group: 'Joint',
      help: 'How far each joint moves. Past about 40 degrees a default-size ball is no longer captive — it would lift out of its socket — so the range stops short of that.' },
    { key: 'head', label: 'Head', type: 'enum', def: 'blunt', group: 'Anatomy',
      options: [{ v: 'none', label: 'None' }, { v: 'blunt', label: 'Blunt' }, { v: 'dragon', label: 'Dragon' },
                { v: 'lizard', label: 'Lizard' }, { v: 'fish', label: 'Fish' }, { v: 'bug', label: 'Bug' },
                { v: 'capybara', label: 'Capybara' }],
      help: 'Fused to the first segment. Purely cosmetic unless the jaw articulates.' },
    { key: 'tail', label: 'Tail', type: 'enum', def: 'taper', group: 'Anatomy',
      options: [{ v: 'taper', label: 'Taper' }, { v: 'spike', label: 'Spike' }, { v: 'fan', label: 'Fan' },
                { v: 'sting', label: 'Sting' }, { v: 'nub', label: 'Nub' },
                { v: 'whip', label: 'Whip' }, { v: 'spade', label: 'Spade' }],
      help: 'Fused to the last segment. Taper, whip and spade grow out of it and lie on the plate.' },
    { key: 'limbPairs', label: 'Leg pairs', type: 'int', min: 0, max: 8, step: 1, def: 0, group: 'Anatomy',
      help: 'Fused, not articulated. Small print-in-place limb joints weld shut more often than they work.' },
    { key: 'limbKind', label: 'Leg type', type: 'enum', def: 'stub', group: 'Anatomy',
      options: [{ v: 'clawed', label: 'Clawed' }, { v: 'splayed', label: 'Splayed' }, { v: 'fin', label: 'Fin' }, { v: 'stub', label: 'Stub' }],
      showIf: (p) => p.limbPairs > 0,
      help: 'Clawed (three toes forward) for dragons, splayed (five-toed star feet) for lizards, fins for fish, ' +
            'stubs for grubs and capybaras. Clawed and splayed legs grow out of the body itself.' },
    // RULING 1: this parameter lands with the species table because
    // `speciesCarries` names it, and conformance rejects a `carries` naming a
    // parameter that does not exist. Task 9 gives it behaviour; build() ignores
    // it today. Its default stays FALSE even though the Dragon row carries
    // true, because Task 6's gate builds from `defaults(gen)` and asserts one
    // shell per segment — a jaw adds a shell.
    { key: 'jaw', label: 'Opening jaw', type: 'bool', def: false, group: 'Anatomy',
      showIf: (p) => p.head === 'dragon' || p.head === 'lizard' || p.head === 'fish',
      help: 'Splits the head into cranium and mandible on a hinge. Only the dragon, ' +
            'lizard and fish heads have a jaw corner to pivot at.' },
    { key: 'dorsal', label: 'Back', type: 'enum', def: 'none', group: 'Anatomy',
      options: [{ v: 'none', label: 'Plain' }, { v: 'spikes', label: 'Spikes' }, { v: 'fin', label: 'Fin' }, { v: 'plates', label: 'Plates' },
                { v: 'crown', label: 'Spike crown' }, { v: 'crest', label: 'Crest' }],
      help: 'Runs along the top of every segment, one piece per segment so the joints stay free. ' +
            'The crown (a fan of spikes) and the crest (one row) are part of the body itself.' },
  ],
  // One preset per species, built from the SAME function the menu's `carries`
  // uses, so the two cannot drift. The caterpillar deliberately does not ship
  // `tight: 1`: it holds 0.3470 mm on the diagonal and 0.2318 wound to the
  // stop, which is under the gate.
  // The nested gauge is the strip print Task 15 waits on: the gauge's five
  // clearances, now on the ball AND the big dome/cup faces, at 15 mm segments
  // because a shell wider than a 9 mm body needs about 1.5 r of segment.
  presets: [
    ...SPECIES.map(s => ({ name: s.name, values: { species: s.id, ...speciesCarries(s.id) } })),
    { name: 'Joint gauge, nested seams', values: { species: 'gauge', ...speciesCarries('gauge'), seams: 'nested', segLen: 15 } },
  ],
  validate(p) {
    const out = [];
    const ctx = { segFactor: 1 };
    const c = num(p.clearance, fit('free'));

    // Nested seams need room: the cup reaches about 1.15 r + c back from each
    // pivot and the socket keep-out about ballR + c + wall forward. A segment
    // shorter than both leaves legs nowhere to root, and they weld into a
    // neighbour (capybara at 20 mm on a 13 mm body, measured).
    if (p.seams === 'nested' && p.joint !== 'hinge' && num(p.limbPairs, 0) > 0) {
      const R = num(p.bodyR, 9), g = ballGeometry({ r: R, clearance: c, swingDeg: num(p.swing, 25) });
      const need = 1.15 * R + c + 0.4 + g.ballR + g.c + g.wall + 0.5 + 1;
      if (num(p.segLen, 14) < need) {
        out.push({ param: 'segLen', severity: 'warning',
          message: `Nested seams on ${num(p.segLen, 14)} mm segments leave legs no room to root between the joints; ` +
                   `they can weld into a neighbour. Lengthen the segments to at least ${need.toFixed(0)} mm, or use open seams.` });
      }
    }

    // A stitched crown on open seams: every crowned segment also carries the
    // socket's booleans, which rolled 25 to 150 bad edges a sweep (ruling 80).
    if (CROWNS[p.dorsal] && p.seams !== 'nested' && p.joint !== 'hinge') {
      out.push({ param: 'seams', severity: 'warning',
        message: `The ${p.dorsal === 'crest' ? 'crest' : 'spike crown'} is built for nested seams; on open seams ` +
                 `curled poses can come out with broken edges. Switch Seams to Nested.` });
    }

    // A clearance under the parameter's own floor is under what a printed
    // gap can hold open at all; the joint welds on the first layer.
    if (c < 0.15) {
      out.push({ param: 'clearance', severity: 'error',
        message: `A ${c.toFixed(2)} mm clearance is narrower than a printer can hold open — the joint ` +
                 `will print welded. 0.15 mm is the floor; the gauge measures what your printer needs.` });
    }

    // Wall round the socket, at the thinnest JOINT-BEARING station. Joints sit
    // at stations 1..segments-1; the nose and the tail tip carry no socket,
    // and a tapered tail tip would otherwise veto every creature. The ball has
    // a 1.6 mm floor (ruling 2), so a thin tapered body runs out of wall at its
    // narrow end while the joint itself is perfectly happy.
    const prof = PROFILES[p.profile] || PROFILES.tapered;
    const segs = Math.max(2, Math.round(num(p.segments, 12)));
    let rMin = Infinity;
    for (let i = 1; i <= segs - 1; i++) rMin = Math.min(rMin, num(p.bodyR, 9) * prof(i / segs));
    if (p.joint !== 'hinge') {
      const g = ballGeometry({ r: rMin, clearance: c, swingDeg: num(p.swing, 25) });
      const wallLeft = rMin - (g.ballR + g.c + g.wall);
      if (wallLeft < 0.8) {
        out.push({ param: 'bodyR', severity: 'error',
          message: `The thinnest jointed part of the body is ${rMin.toFixed(1)} mm in radius, which leaves ` +
                   `${wallLeft.toFixed(2)} mm of wall around a ${g.ballR.toFixed(1)} mm socket. Two ` +
                   `perimeters need 0.8 mm — raise the body radius or choose a flatter profile.` });
      }
      if (g.captiveMargin <= 0) {
        out.push({ param: 'swing', severity: 'error',
          message: `At ${g.swingDeg.toFixed(0)} degrees of swing the socket mouth opens to ` +
                   `${(g.apertureR * 2).toFixed(1)} mm against a ${(g.ballR * 2).toFixed(1)} mm ball — the ` +
                   `ball is not captive and will escape. Narrow the swing or thicken the body.` });
      }
      // Ruling 32: a segment loses |faceZ| at its front and the socket's depth
      // at its rear. Shorter than both and the two edits meet in the middle,
      // which is where the boolean failures were eleven times likelier.
      const gb = ballGeometry({ r: num(p.bodyR, 9), clearance: c, swingDeg: num(p.swing, 25) });
      const floor = -gb.faceZ + (gb.ballR + gb.c + gb.wall + 2);
      if (p.species !== 'gauge' && num(p.segLen, 14) < floor) {
        out.push({ param: 'segLen', severity: 'warning',
          message: `${num(p.segLen, 14)} mm segments are shorter than the ${floor.toFixed(1)} mm the ` +
                   `joint at each end takes from them; the two meet in the middle. Expect the odd ` +
                   `rough seam — lengthen the segments to be safe.` });
      }
    }

    // Ruling 48: a limb rooted on the axis of a short fat segment fouled the
    // neighbouring ball sideways, failing at 0.81. Task 13 rooted limbs low on
    // the flank and that body is now clean for every limb kind, but it is one
    // body; the warning stays until an envelope sweep says where the new edge is.
    if (num(p.limbPairs, 0) > 0 && num(p.bodyR, 9) / num(p.segLen, 14) > 0.75) {
      out.push({ param: 'limbPairs', severity: 'warning',
        message: `Legs on segments this short for their girth (radius ${num(p.bodyR, 9)} on ` +
                 `${num(p.segLen, 14)} mm) can touch the neighbouring joint and weld it. Lengthen the ` +
                 `segments to at least ${(num(p.bodyR, 9) / 0.75).toFixed(1)} mm, or slim the body.` });
    }

    // Too long for any pose: name the count that would fit, never shorten it
    // silently.
    if (p.species !== 'gauge' && !fitToBed(p, ctx).fits) {
      const n = segmentsThatFit(p, ctx);
      out.push({ param: 'segments', severity: 'error',
        message: `${segs} segments of ${num(p.segLen, 14)} mm will not fit a ${BED.x} mm bed in any ` +
                 `pose, even coiled to the stop. ` +
                 (n ? `${n} would.` : 'Shorten the segments or slim the body.') });
    }

    // The spec's words: a species or a user asking for a jaw on a head with no
    // muzzle gets an error, not a silently solid face. build() fuses the head
    // whole in that case, so the object is still sound — just not what was
    // asked for, which is exactly what validate() is for.
    if (p.jaw && !JAW_HEADS.includes(p.head)) {
      out.push({ param: 'jaw', severity: 'error',
        message: `A ${p.head} head has no muzzle to split — an opening jaw needs a ` +
                 `dragon, lizard or fish head.` });
    }
    return out;
  },
  hints(p) {
    const notes = [];
    if (p.species === 'gauge') {
      const steps = gaugeSteps(p);
      notes.push(`Prints five joints at ${steps.map(v => v.toFixed(2)).join(', ')} mm. Flex each ` +
                 `gently; the tightest one that turns freely is your clearance. Note the slicer ` +
                 `quality with it — the gap on the model is a little under the number at draft.`);
      return { notes };
    }
    const f = fitToBed(p, { segFactor: 1 });
    const asked = POSES[p.pose] ? p.pose : 'diagonal';
    const name = { straight: 'straight', diagonal: 'diagonal', scurve: 'S-curve', coil: 'coil' };
    if (!f.fits) {
      notes.push(`Too long for the bed in any pose — see the error on Segments.`);
    } else if (f.pose !== asked) {
      notes.push(`The ${name[asked]} pose overflows the ${BED.x} mm bed, so it prints as a ` +
                 `${name[f.pose]}${f.pose === 'coil' || f.pose === 'scurve' ? ` at tightness ${f.tight.toFixed(2)}` : ''}. ` +
                 `It straightens in the hand.`);
    } else if (f.tightened) {
      notes.push(`Tightened from ${num(p.tight, 0.5).toFixed(2)} to ${f.tight.toFixed(2)} to fit the bed.`);
    }
    notes.push(`The joint clearance is ${num(p.clearance, fit('free')).toFixed(2)} mm. ` + fitNote('free'));
    notes.push('Flex every joint through its range once, gently, before playing with it — it frees ' +
               'any whisker of stringing across the gaps.');
    return { notes };
  },
  build(p, ctx) {
    p = asBuilt(p);
    // The gauge is already a fixed straight strip; everything else is folded
    // onto the plate if it has to be. segmentsOf itself stays literal — tests
    // and the envelope tool ask it for exact poses and must get them.
    // When nothing fits, change nothing: winding an animal to the stop buys no
    // bed and costs geometry, and validate() is already carrying the error.
    if (p.species !== 'gauge') { const f = fitToBed(p, ctx); if (f.fits) p = { ...p, pose: f.pose, tight: f.tight }; }
    const parts = segmentsOf(p, ctx);
    const merged = Mesh.merge(parts);
    const b = merged.bbox();
    const shift = [-b.center[0], -b.center[1], -b.min[2]];
    const mesh = merged.translate(...shift);
    // The callouts are drawn in the placed mesh's coordinates, so they ride
    // the same shift the parts did.
    const { stations } = spineOf(p, ctx);
    return { mesh, meta: { dims: creatureDims(p, stations, shift) } };
  },
};
