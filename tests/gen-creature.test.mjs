// Articulated creatures. Every geometric claim here is measured off the mesh,
// and every gate ships with the input that has to make it fail.
import { suite, check, near, nearVec, done, throws } from './lib/assert.mjs';
import { ctx, defaults, asMesh, conformance } from './lib/genconform.mjs';
import { shellCount, minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import { isSolid, onPlate, centredXY, deterministic } from './lib/meshcheck.mjs';
import { ballGeometry, hingeGeometry } from '../js/kernel/joint.js';
import gen, { POSES, PROFILES, spineOf, tubeThrough, segmentsOf, jointRCap, tubeFacets } from '../js/gen/creature.js';
import { nseg, segFactorOf } from '../js/kernel/builders.js';
import { GENERATOR_IDS } from '../js/gen/index.js';

suite('gen creature');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));

// ---------------------------------------------------------------------------
// The spine.
// ---------------------------------------------------------------------------
{
  // Not a count. Task 6 added the coil and left this asserting three, which is
  // how a hardcoded number fails: it goes red for the right reason and reads as
  // noise. Pin the menu against the implementation instead, so a pose added to
  // one and not the other is what fails, and the message names which.
  const poseOpts = gen.params.find(q => q.key === 'pose').options.map(o => o.v);
  check('every pose the menu offers is implemented, and no more',
    poseOpts.slice().sort().join(',') === Object.keys(POSES).slice().sort().join(','),
    `menu: ${poseOpts.join(', ')} | POSES: ${Object.keys(POSES).join(', ')}`);

  const len = 200;
  for (const [name, fn] of Object.entries(POSES)) {
    const path = fn(len, {});
    check(`${name} returns a path of at least two points`, path.length >= 2, `${path.length} points`);
    let arc = 0;
    for (let i = 1; i < path.length; i++) arc += Math.hypot(...path[i].map((v, k) => v - path[i - 1][k]));
    near(`${name} is the arc length it was asked for`, arc, len, len * 0.02);
  }

  // A curved pose has to be shorter end-to-end than a straight one of the same
  // arc length, or it buys no bed space at all — which is its only purpose.
  const span = (path) => {
    const xs = path.map(q => q[0]), ys = path.map(q => q[1]);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  check('an s-curve spans less than a straight spine of the same length',
    span(POSES.scurve(len, {})) < span(POSES.straight(len, {})),
    `${span(POSES.scurve(len, {})).toFixed(0)} vs ${span(POSES.straight(len, {})).toFixed(0)} mm`);
  check('and a coil spans less again',
    span(POSES.coil(len, {})) < span(POSES.scurve(len, {})),
    `${span(POSES.coil(len, {})).toFixed(0)} vs ${span(POSES.scurve(len, {})).toFixed(0)} mm`);

  // The stitched A side takes its LONGITUDE count from the tube and its
  // LATITUDES from joint.js, while the socket takes both from builders. Ball
  // and socket tessellated alike is the one rule joint.js says must never
  // break, and here it rests on two different `nseg` floors — this file's 8
  // and builders' 3 — happening not to bite, because 24 x the lowest legal
  // segFactor is 9.6. One step of margin is not an invariant until something
  // checks it.
  for (const q of ['draft', 'normal', 'fine']) {
    const cq = ctx(q);
    const tube = tubeFacets(cq), ball = nseg(24, segFactorOf({ ctx: cq }), 3);
    check(`${q}: the tube and the ball are cut into the same number of facets`,
      tube === ball, `tube ${tube}-gon, ball ${ball}-gon`);
  }

  const { stations } = spineOf(D, C);
  check('there is one station per segment boundary', stations.length === D.segments + 1,
    `${stations.length} stations for ${D.segments} segments`);
  check('every station carries a frame and a radius',
    stations.every(s => s.p && s.t && s.n && s.b && s.r > 0));
}

// ---------------------------------------------------------------------------
// The body, before any joint exists.
// ---------------------------------------------------------------------------
{
  // The bare body, before the joints are trimmed into it. `build()` is jointed
  // since Task 6, so the one-solid claim is made on tubeThrough itself — the
  // claim is about the loft, not about the assembled creature.
  const bare = tubeThrough(spineOf(D, C).stations, 28);
  check('with no joints the body is a single solid', shellCount(bare) === 1, `${shellCount(bare)} shells`);
  const m = build();
  check('and the assembled creature is one shell per segment', shellCount(m) === D.segments,
    `${shellCount(m)} shells for ${D.segments} segments`);
  check('the profile actually varies along the body',
    PROFILES.tapered(0.1) !== PROFILES.tapered(0.9),
    `${PROFILES.tapered(0.1)} vs ${PROFILES.tapered(0.9)}`);
  const flatSpread = Math.abs(PROFILES.flat(0.1) - PROFILES.flat(0.9));
  check('and "flat" really is flat, so the profile menu is not decorative',
    flatSpread < 1e-9, `${flatSpread}`);
}

{
  const straight = spineOf({ ...D, pose: 'straight' }, C);
  // Stations sit on the path in plan and are RAISED to their own radius, so
  // every belly lands on the plate (Task 13). Along-spine distances are
  // horizontal: the frames are level and the height is only clearance.
  const plan = q => [q[0], q[1], 0];
  nearVec('first station is the requested start, in plan', plan(straight.stations[0].p), straight.path[0]);
  nearVec('last station is the requested end, in plan', plan(straight.stations.at(-1).p), straight.path.at(-1));
  check('and every station stands at its own radius, belly on the plate',
    straight.stations.every(st => Math.abs(st.p[2] - st.r) < 1e-12),
    straight.stations.map(st => (st.p[2] - st.r).toExponential(1)).join(' '));
  for (let i = 1; i < straight.stations.length; i++) {
    near(`segment ${i} has requested length`,
      Math.hypot(straight.stations[i].p[0] - straight.stations[i-1].p[0],
                 straight.stations[i].p[1] - straight.stations[i-1].p[1]), D.segLen);
  }
  for (const pose of Object.keys(POSES)) {
    const m = build({ pose });
    isSolid(`${pose} body topology`, m);
    onPlate(`${pose} body`, m);
    centredXY(`${pose} body`, m);
  }
  deterministic('body', () => build());
}

// Topology alone cannot detect a tube wound through its neighbouring turn.
// Measure non-local centreline separation and local radius of curvature.
{
  for (const radius of [4, 9, 22]) {
    const path = POSES.coil(624, { radius, tight: 1 });
    const arc = [0];
    for (let i = 1; i < path.length; i++) arc.push(arc[i - 1] + Math.hypot(...path[i].map((v, k) => v - path[i-1][k])));
    let gap = Infinity;
    for (let i = 0; i < path.length; i++) for (let j = i + 1; j < path.length; j++) {
      if (arc[j] - arc[i] < Math.PI * radius) continue;
      gap = Math.min(gap, Math.hypot(...path[j].map((v, k) => v - path[i][k])));
    }
    check(`coil keeps ${radius}mm bodies clear of non-local turns`, gap > 2 * radius,
      `${gap.toFixed(3)}mm centreline separation`);
    for (const pose of ['scurve', 'coil']) {
      const curve = POSES[pose](168, { radius, tight: 1 });
      let curvatureR = Infinity;
      for (let i = 1; i < curve.length - 1; i++) {
        const a = curve[i - 1], b = curve[i], c = curve[i + 1];
        const ab = Math.hypot(b[0]-a[0], b[1]-a[1]), bc = Math.hypot(c[0]-b[0], c[1]-b[1]);
        const ca = Math.hypot(a[0]-c[0], a[1]-c[1]);
        const cross = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]));
        if (cross > 1e-10) curvatureR = Math.min(curvatureR, ab * bc * ca / (2 * cross));
      }
      check(`${pose} cannot fold a ${radius}mm body inside out`, curvatureR > 1.49 * radius,
        `${curvatureR.toFixed(3)}mm minimum bend radius`);
    }
  }
  for (const pose of Object.keys(POSES)) for (const profile of Object.keys(PROFILES)) {
    const m = build({ pose, profile });
    isSolid(`${pose}/${profile}`, m);
  }
}

// ---------------------------------------------------------------------------
// The catalogue contract. The creature has joints now, so it has to meet the
// same harness every other generator meets — including the parameter sweep,
// which is what forces the host-aware joint sizing below to hold at BOTH ends
// of every declared range.
// ---------------------------------------------------------------------------
conformance(gen, 'creature');

// ---------------------------------------------------------------------------
// GATE 1 — the gap. Measured off the triangles, never read back from the
// parameter that produced it.
//
// Measured on a 4-segment creature, not the 12-segment default: the gap is a
// property of the joint, and every adjacent pair is the same joint, so the
// shorter body measures the identical thing — minShellGap on the full default
// costs 40 s a call and this file has four of them to run inside run.mjs's
// 300 s budget. The count half of the gate is separately asserted at 4, 12 and
// 20 segments below, and the hard case measures a full 24-segment coil
// globally, which is where non-adjacent shells could conceivably approach.
// ---------------------------------------------------------------------------
{
  const m = build({ segments: 4 });
  const gap = minShellGap(m).min;
  check('no two segments come closer than 0.9 x the clearance asked for',
    jointGateHolds(m, 4, D.clearance), `${gap.toFixed(4)} mm against a ${D.clearance} mm nominal`);
  // A one-sided threshold cannot see a joint that is too loose — a clearance
  // applied twice reads 0.69 mm and sails through any >= 0.9 x C gate. Pin the
  // reading to the concentric-sphere figure this geometry produces (determinism
  // is asserted by the conformance contract, so the pin is stable), the same
  // style joint.test.mjs uses for the bare kernel.
  near('the ball gap is the aligned-facet figure, so the clearance was applied once',
    gap, 0.3441, 0.004);

  // GATE 2 — the falsifier. Same gate, clearance forced to zero.
  //
  // jointGateHolds, not the gap alone: segments at zero clearance WELD, so the
  // mesh collapses to fewer shells and minShellGap returns Infinity. A bare
  // `!(gap >= ...)` falsifier would pass the broken build.
  const fusedMesh = build({ segments: 4, clearance: 0 });
  check('and at zero clearance that gate fails, so it is not measuring the parameter',
    !jointGateHolds(fusedMesh, 4, D.clearance), `${shellCount(fusedMesh)} shells`);

  // Worst case for faceting: draft quality, smallest body, tightest coil — and
  // the long body, so non-adjacent shells are measured too.
  const hard = asMesh(gen.build({ ...D, bodyR: 4, segments: 24, pose: 'coil', tight: 1 }, ctx('draft')));
  check('the gap survives draft quality on the smallest body in the tightest coil',
    jointGateHolds(hard, 24, D.clearance), `${minShellGap(hard).min.toFixed(4)} mm`);

  // The hinge articulates in one plane and is measured the same way, on the
  // assembled creature rather than the two-body fixture joint.test.mjs uses.
  const hinged = build({ segments: 4, joint: 'hinge' });
  check('the hinge creature holds the same gap gate, measured assembled',
    jointGateHolds(hinged, 4, D.clearance), `${minShellGap(hinged).min.toFixed(4)} mm`);
  near('and the hinge gap reads the clearance applied once', minShellGap(hinged).min, 0.3470, 0.004);
}

// ---------------------------------------------------------------------------
// GATE 3 — captivity. The ball cannot leave through the mouth.
// ---------------------------------------------------------------------------
{
  const g = ballGeometry({ r: D.bodyR, clearance: D.clearance, swingDeg: D.swing });
  check('the socket mouth is narrower than the ball it holds',
    g.apertureR < g.ballR, `aperture ${g.apertureR.toFixed(2)} vs ball ${g.ballR.toFixed(2)} mm`);
  check('at every legal swing angle, not just the default',
    [gen.params.find(q => q.key === 'swing').min, D.swing, gen.params.find(q => q.key === 'swing').max]
      .every(s => ballGeometry({ r: D.bodyR, clearance: D.clearance, swingDeg: s }).captiveMargin > 0),
    'checked min, default and max swing');
}

// ---------------------------------------------------------------------------
// GATE 4 — shell count. One shell per segment. Off by one means two fused.
// ---------------------------------------------------------------------------
{
  for (const segs of [4, 12, 20]) {
    const m = build({ segments: segs });
    check(`a ${segs}-segment creature is ${segs} separate pieces`,
      shellCount(m) === segs, `${shellCount(m)} shells`);
  }
  // Falsifier: at zero clearance the segments weld, so the count drops.
  check('and at zero clearance the count collapses, so the check is not vacuous',
    shellCount(build({ segments: 12, clearance: 0 })) < 12,
    `${shellCount(build({ segments: 12, clearance: 0 }))} shells`);
}

// ---------------------------------------------------------------------------
// GATE 5 — the hosts. The trims at both ends of a segment come from the joint,
// and a short segment with a large body can be consumed outright: the two cut
// regions meet in the middle and the segment prints as floating pieces, or the
// trim that should clear the body fails to cover it and the neighbours fuse.
// A shell count on the merged creature cannot prove the anatomy (a severed
// stub and a detached dome can still sum to the right total), so each segment
// is measured on its own, and the joint's own geometry is what sizes it back
// until the host survives.
// ---------------------------------------------------------------------------
{
  const hostsOf = (over = {}) => {
    const parts = segmentsOf({ ...D, ...over }, C);
    return parts.map(shellCount);
  };
  const hostCheck = (label, over = {}) => {
    const counts = hostsOf(over);
    const n = over.segments ?? D.segments;
    check(`${label}: every host survives its end trims as one connected piece`,
      counts.length === n && counts.every(c => c === 1),
      `shells per segment: ${counts.join(',')}`);
    return counts;
  };

  hostCheck('a default creature');
  hostCheck('the smallest body at the shortest segment', { bodyR: 4, segLen: 6, segments: 6 });
  hostCheck('the largest body at the longest segment', { bodyR: 22, segLen: 26, segments: 6 });
  hostCheck('a body longer than its segments can host has its joints sized back, ball',
    { bodyR: 22 });
  hostCheck('and sized back, hinge', { joint: 'hinge', bodyR: 22 });
  hostCheck('a hinge creature', { joint: 'hinge' });
  hostCheck('the widest legal hinge swing', { joint: 'hinge', swing: 45 });
  hostCheck('a hinge at the shortest segment', { joint: 'hinge', segLen: 6, segments: 6 });
  hostCheck('a ball at the shortest segment', { segLen: 6, segments: 6 });
  hostCheck('a coil keeps its hosts whole', { pose: 'coil', tight: 1, segments: 12 });
  hostCheck('and so does an s-curve', { pose: 'scurve', tight: 1, segments: 12 });

  // A shell count cannot see the subtler failure: a ball whose rear pole
  // reaches into its own segment's rear socket dome. The two union into one
  // watertight piece — every count above still reads 1 — and the joint is
  // welded shut. This is a property of the joint's numbers, so it is derived
  // from ballGeometry at the radii the builder will actually use: the ball at
  // each station must clear the dome behind it.
  for (const over of [{ bodyR: 22 }, { bodyR: 22, segLen: 26, segments: 6 }, { segLen: 6, segments: 6 }]) {
    const p = { ...D, ...over };
    const { stations } = spineOf(p, C);
    const spacing = Math.hypot(...stations[1].p.map((v, k) => v - stations[0].p[k]));
    const rUsed = (st) => Math.min(st.r, jointRCap('ball', st.r, spacing, D.clearance, D.swing));
    const gAt = (st) => ballGeometry({ r: rUsed(st), clearance: D.clearance, swingDeg: D.swing });
    const clear = [];
    for (let s = 1; s + 1 < stations.length; s++) {
      const g = gAt(stations[s]), prev = gAt(stations[s - 1]);
      clear.push(g.ballR + (prev.ballR + prev.c + prev.wall) <= spacing - 0.05);
    }
    check(`at ${JSON.stringify(over)} each ball clears the socket dome behind it`,
      clear.every(Boolean), `${clear.filter(x => !x).length} of ${clear.length} stations embed`);
  }

  // The sizing is a fallback, not a rescaler: at the defaults the joint uses
  // the full radius the stations give it.
  check('the default joint is not silently shrunk to fit',
    jointRCap('ball', D.bodyR, D.segLen, D.clearance, D.swing) === D.bodyR,
    `cap ${jointRCap('ball', D.bodyR, D.segLen, D.clearance, D.swing)} for r ${D.bodyR}`);
  check('and the cap only ever shrinks, never grows, a joint',
    [4, 9, 22].every(r => jointRCap('ball', r, D.segLen, D.clearance, D.swing) <= r &&
                          jointRCap('hinge', r, D.segLen, D.clearance, D.swing) <= r),
    'checked 4, 9 and 22 mm bodies, both kinds');

  // The fat-body cases above are the falsifier for the sizing: without it a
  // 22 mm body on 14 mm segments loses one-piece hosts (the end trims meet in
  // the middle), and this check goes red. It was verified by removing the cap
  // in a scratch copy and watching exactly that happen — see task-6-report.

  // Past what any joint radius can save, the builder refuses rather than print
  // two fused lumps: the trim has to clear the body, and a 6 mm segment cannot
  // swing a trim wide enough to cover a 22 mm one.
  throws('a 6 mm segment refuses to host a 22 mm body, ball',
    () => segmentsOf({ ...D, bodyR: 22, segLen: 6, segments: 6 }, C), 'too short to host');
  throws('and hinge',
    () => segmentsOf({ ...D, joint: 'hinge', bodyR: 22, segLen: 6, segments: 6 }, C), 'too short to host');
}

// ---------------------------------------------------------------------------
// It is in the catalogue.
// ---------------------------------------------------------------------------
check('creature is registered', GENERATOR_IDS.includes('creature'));
check('and it is the first thing in Toys', gen.category === 'Toys');

done();
