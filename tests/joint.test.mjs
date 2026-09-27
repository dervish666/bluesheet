// The joint kernel, with no creature around it.
//
// The first thing proved here is not a joint. It is the instrument: a gap gate
// that cannot report a fused joint as fused would greenlight every generator
// built on it. The two sphere cases below are the calibration, and their
// numbers were measured before they were written down (see the spec).
import { suite, check, near, throws, done } from './lib/assert.mjs';
import { minShellGap, shellCount, jointGateHolds } from './lib/gapcheck.mjs';
import { sphere, box } from '../js/kernel/builders.js';
import { Mesh } from '../js/kernel/mesh.js';

suite('joint');

// ---------------------------------------------------------------------------
// Calibrating the instrument.
//
// Two concentric spheres, r = 5 and r = 5.35, are a joint's gap with nothing
// else in the way. Built with the SAME segments and rings their facets are
// parallel and the gap holds; built with the socket's resolution scaled to its
// own radius — which is what a naive implementation does — the facets beat
// against each other and half the gap disappears at draft quality.
// ---------------------------------------------------------------------------
{
  const C = 0.35, R = 5;
  const concentric = (segments, rings) =>
    Mesh.merge([sphere(R, { segments, rings }),
                sphere(R + C, { segments, rings: rings }).translate(0, 0, -C)]);

  check('two concentric spheres are two shells', shellCount(concentric(32, 16)) === 2,
    String(shellCount(concentric(32, 16))));

  const aligned = minShellGap(concentric(32, 16)).min;
  near('aligned facets hold the nominal gap at normal quality', aligned, 0.3467, 0.004);

  const alignedDraft = minShellGap(concentric(16, 8)).min;
  near('and still hold it at draft quality', alignedDraft, 0.3369, 0.004);
  check('which is comfortably over a 0.9 x nominal gate', alignedDraft > 0.9 * C,
    `${alignedDraft.toFixed(4)} vs ${(0.9 * C).toFixed(4)}`);

  // The falsifier. If this passes the gate, the gate is measuring nothing.
  const misaligned = Mesh.merge([
    sphere(R, { segments: 16, rings: 8 }),
    sphere(R + C, { segments: Math.round(16 * (R + C) / R), rings: Math.round(8 * (R + C) / R) }).translate(0, 0, -C),
  ]);
  const bad = minShellGap(misaligned).min;
  near('a socket whose resolution follows its own radius loses half the gap', bad, 0.1790, 0.010);
  check('and the 0.9 x nominal gate rejects it — so the gate can fail',
    bad < 0.9 * C, `${bad.toFixed(4)} vs ${(0.9 * C).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// The instrument's own failure modes, each with the case that would catch it.
//
// Everything above measures two spheres whose facets are a fraction of a
// millimetre. These are the shapes that broke the first version of the grid,
// and the answers are known without a model: a box is a box.
// ---------------------------------------------------------------------------
{
  // Facets far larger than a grid cell. Centroid bucketing put the two near
  // faces in cells five apart and never compared them, so a 0.4 mm gap read as
  // Infinity — a silent pass, and the exact shape of a creature's body tube.
  const cubes = (L, gap) => Mesh.merge([box(L, L, L), box(L, L, L).translate(L + gap, 0, 0)]);
  for (const L of [4, 12, 20, 40]) {
    const r = minShellGap(cubes(L, 0.4));
    near(`two ${L} mm cubes 0.4 mm apart measure 0.4 whatever the facet size`, r.min, 0.4, 1e-9);
  }
  near('and the reading follows the gap, not the box', minShellGap(cubes(20, 0.15)).min, 0.15, 1e-9);

  // Crossing facets are measured where they cross, not at their vertices:
  // vertex-only sampling answers 10.0075 on this pair.
  const plate = (pts) => { const m = new Mesh();
    const v = pts.map((p) => m.addVertex(...p));
    m.addTri(v[0], v[1], v[2]); m.addTri(v[0], v[2], v[3]); return m; };
  // Two thin plates crossing `gap` apart, each shifted by `off` so the crossing
  // can be moved on or off the sampler's own points.
  const crossPlates = (L, gap, off = 0) => Mesh.merge([
    plate([[-L, -0.002 + off, 0], [L, -0.002 + off, 0], [L, 0.002 + off, 0], [-L, 0.002 + off, 0]]),
    plate([[-0.002 + off, -L, gap], [0.002 + off, -L, gap], [0.002 + off, L, gap], [-0.002 + off, L, gap]]),
  ]);
  const crossing = Mesh.merge([
    plate([[-10, -0.005, 0], [10, -0.005, 0], [10, 0.005, 0], [-10, 0.005, 0]]),
    plate([[-0.005, -10, 0.5], [0.005, -10, 0.5], [0.005, 10, 0.5], [-0.005, 10, 0.5]]),
  ]);
  near('crossing facets are measured where they cross, not at their vertices',
    minShellGap(crossing).min, 0.5, 1e-9);

  // ---- Sampling density, at the creature's own draft geometry ----
  //
  // This block used to claim it proved "seven points rather than three".
  // Subdivision subsumed that claim and the test should stop making it: the
  // sampler now picks its order from the facet, the fixed seven-point set
  // survives only as the order-2 fast path, and the crossing above cannot tell
  // the two apart — it lands on an edge midpoint, the sampler's BEST case, and
  // reads 0.5000 with subdivision or without.
  //
  // What varies now is whether the order rises with the facet. These plates are
  // 4.04 mm across — the draft coil chord, which is Task 6's hardest gate —
  // crossing 0.05 mm apart, which in PLA is fused. The crossing is offset to L/2,
  // which falls BETWEEN the order-2 sample points — that is what makes the
  // falsifier below bite.
  //
  // Only a bound is asserted, never the true gap. At the shipped spacing this
  // offset happens to land exactly on a grid node at order 12 and reads 0.0500,
  // but that is a coincidence of one tuning: offset 1.05 reads 0.0628, and a
  // SAMPLE_EDGE of 0.30 or 0.50 reads 0.1508 or 0.1210. Pinning the exact value
  // would make this file red on a retune its own doc comment invites — and
  // asserting a best case is the criticism this block levelled at the test it
  // replaced.
  const DRAFT_CHORD = 4.04, FUSED = 0.05, GATE = 0.9 * 0.35;
  const fusedCoil = crossPlates(DRAFT_CHORD / 2, FUSED, DRAFT_CHORD / 4);
  const measured = minShellGap(fusedCoil, { cutoff: 5 }).min;
  check('a fused joint across draft-quality facets stays well under the gate',
    measured < GATE, `${measured.toFixed(4)} vs ${GATE.toFixed(4)}`);
  check('and is not merely scraping under it', measured < GATE / 2,
    `${measured.toFixed(4)} vs ${(GATE / 2).toFixed(4)}`);

  // The falsifier for subdivision itself. Same mesh, sampler pinned to order 2
  // by a threshold nothing can exceed — which is what this file measured before
  // ruling 10 — and the fused joint sails through.
  const unsubdivided = minShellGap(fusedCoil, { cutoff: 5, sampleEdge: 1e9 }).min;
  check('FALSIFIER: pinned to one sample order, the same fused joint passes the gate',
    unsubdivided > GATE, `${unsubdivided.toFixed(4)} vs ${GATE.toFixed(4)}`);
  check('and subdivision is what closes the gap between those two readings',
    unsubdivided / measured > 2, `${unsubdivided.toFixed(4)} vs ${measured.toFixed(4)}`);

  // The error stops scaling with facet size — the property ruling 10 bought.
  // Same fused 0.05 mm gap at three facet sizes spanning the creature's quality
  // range (fine, normal, draft). The readings are NOT exact: sampling still
  // over-estimates where a crossing falls between points, and asserting the
  // true gap here would be claiming more than subdivision delivers. What it
  // does deliver is a bound — every reading stays under the gate instead of
  // growing with the facet until it clears it.
  const chords = [1.01, 2.02, 4.04];
  for (const chord of chords) {
    const g = minShellGap(crossPlates(chord / 2, FUSED, chord / 4), { cutoff: 5 }).min;
    check(`a ${chord} mm facet keeps a fused joint under the gate`, g < GATE,
      `${g.toFixed(4)} vs ${GATE.toFixed(4)}`);
  }
  // The falsifier: pin the order and the same three readings climb with the
  // facet until the coarsest one is through the gate.
  const unsub = chords.map((c) =>
    minShellGap(crossPlates(c / 2, FUSED, c / 4), { cutoff: 5, sampleEdge: 1e9 }).min);
  check('FALSIFIER: pinned to one order, the reading climbs with the facet and breaches',
    unsub[0] < GATE && unsub[2] > GATE, chords.map((c, i) => `${c}mm:${unsub[i].toFixed(4)}`).join('  '));

  throws('sampleEdge is validated too', () => minShellGap(crossing, { sampleEdge: 0 }),
    'sampleEdge must be a positive finite number');

  // A gap wider than the cutoff is not a wide gap, it is an unmeasured one.
  throws('two shells with nothing inside the cutoff throws rather than returning Infinity',
    () => minShellGap(cubes(10, 5)), 'no gap was measured');
  near('and the same pair measures fine when the cutoff is told to reach that far',
    minShellGap(cubes(10, 5), { cutoff: 8 }).min, 5, 1e-9);

  // One shell keeps returning Infinity: no pair exists, and the shell count is
  // what catches a fused lump. This is the failure the gap gate cannot see.
  const fused = Mesh.merge([sphere(5, { segments: 16, rings: 8 }), sphere(5, { segments: 16, rings: 8 })]);
  check('coincident bodies weld into one shell', shellCount(fused) === 1, String(shellCount(fused)));
  const r = minShellGap(fused);
  check('which reports Infinity — so a gap gate alone would pass a fused lump',
    r.min === Infinity && r.shells === 1, `min=${r.min}, shells=${r.shells}`);
  check('and the gap alone would wave it through, Infinity >= 0.315',
    r.min >= 0.9 * 0.35, `${r.min} >= ${(0.9 * 0.35).toFixed(4)}`);
  check('while jointGateHolds rejects it, because it asks the shell count first',
    jointGateHolds(fused, 2, 0.35) === false, String(jointGateHolds(fused, 2, 0.35)));

  // A bad cutoff should blame the caller, not the geometry.
  for (const bad of [0, -1, NaN, 'wide']) {
    throws(`cutoff ${typeof bad === "number" ? String(bad) : JSON.stringify(bad)} is rejected as an argument, not as shell separation`,
      () => minShellGap(cubes(4, 0.4), { cutoff: bad }), 'cutoff must be a positive finite number');
  }

  // `worst` is part of the produced interface, so it gets asserted rather than
  // assumed. Note what `at` is NOT: on the crossing plates the two shells
  // approach at the origin, but `at` is the near facet's CENTROID, 3.33 mm away.
  const w = minShellGap(crossing).worst;
  check('worst names the two shells that came closest',
    w !== null && w.a === 0 && w.b === 1, w && `a=${w.a}, b=${w.b}`);
  check('and carries a finite 3-vector',
    !!w && Array.isArray(w.at) && w.at.length === 3 && w.at.every(Number.isFinite),
    w ? JSON.stringify(w.at) : 'worst was null');
  check('which is the near facet\'s centroid, NOT the near point — 3.33 mm off here',
    !!w && Array.isArray(w.at) && Math.abs(w.at[0]) > 3,
    w && w.at ? `at.x = ${w.at[0].toFixed(4)}, shells actually approach at x = 0` : 'worst was null');
}

// ---------------------------------------------------------------------------
// jointGateHolds — both halves of the question, in the order that makes the
// answer safe.
//
// The gap alone cannot fail on a fused mesh, because fusing removes the pair it
// would have measured. The shell count alone cannot fail on a mesh that is two
// bodies 0.02 mm apart. Each falsifier below is a mesh that the OTHER half
// would pass.
// ---------------------------------------------------------------------------
{
  const C = 0.35, R = 5;
  const good = Mesh.merge([sphere(R, { segments: 32, rings: 16 }),
                           sphere(R + C, { segments: 32, rings: 16 }).translate(0, 0, -C)]);
  check('a sound joint holds the gate', jointGateHolds(good, 2, C) === true, String(jointGateHolds(good, 2, C)));

  // Falsifier 1 — wrong count, right-looking gap. This is the mesh that broke
  // the three plan falsifiers: fused, so minShellGap says Infinity, so a gate
  // written on the gap alone passes it at the moment it should fire.
  const fused = Mesh.merge([sphere(R, { segments: 32, rings: 16 }), sphere(R, { segments: 32, rings: 16 })]);
  check('a fused joint is one shell', shellCount(fused) === 1, String(shellCount(fused)));
  check('its gap alone passes the gate', minShellGap(fused).min >= 0.9 * C, String(minShellGap(fused).min));
  check('FALSIFIER: jointGateHolds rejects it anyway', jointGateHolds(fused, 2, C) === false,
    String(jointGateHolds(fused, 2, C)));

  // Falsifier 2 — right count, wrong gap. Two shells, so a gate written on the
  // shell count alone passes it, but 0.02 mm of air is one lump in PLA.
  const tooClose = Mesh.merge([sphere(R, { segments: 32, rings: 16 }),
                               sphere(R + 0.02, { segments: 32, rings: 16 }).translate(0, 0, -0.02)]);
  check('a too-close joint is still two shells', shellCount(tooClose) === 2, String(shellCount(tooClose)));
  check('so the shell count alone passes it', shellCount(tooClose) === 2, String(shellCount(tooClose)));
  check('FALSIFIER: jointGateHolds rejects it anyway', jointGateHolds(tooClose, 2, C) === false,
    `gap ${minShellGap(tooClose).min.toFixed(4)} vs ${(0.9 * C).toFixed(4)}`);

  // The factor is the caller's to set, and the boundary is exactly where it
  // says. Derived from the measured gap rather than hard-coded, so this pins
  // the factor's semantics and not the sphere's tessellation — a hard-coded
  // boundary here would be tighter than the ±0.004 the calibration allows, and
  // would flip on a change the calibration deliberately tolerates.
  const g = minShellGap(good).min;
  check('a factor the gap clears holds', jointGateHolds(good, 2, C, (g / C) * 0.999) === true,
    `${g.toFixed(4)} vs ${(g * 0.999).toFixed(4)}`);
  check('and a factor it misses by a hair rejects it', jointGateHolds(good, 2, C, (g / C) * 1.001) === false,
    `${g.toFixed(4)} vs ${(g * 1.001).toFixed(4)}`);
  check('a full-clearance factor rejects it, since facets always cut the chord',
    jointGateHolds(good, 2, C, 1.0) === false, `${g.toFixed(4)} vs ${C.toFixed(4)}`);

  // A fused mesh must never reach minShellGap, or the count of 1 would make it
  // return Infinity; a wrong count is an answer, not an error.
  check('the shell count short-circuits, so a fused mesh never trips the throw',
    jointGateHolds(fused, 5, C) === false, String(jointGateHolds(fused, 5, C)));

  // ...but that check cannot see the ORDER, which is the part that matters, and
  // it took a review to notice. Rewrite jointGateHolds gap-first and the whole
  // file still passed: `fused` is ONE shell, so minShellGap returns Infinity
  // early instead of throwing, Infinity < 0.315 is false, control falls through
  // to the count, and both orders answer false. A falsifier aimed at a mesh
  // where the thing it negates cannot fire — which is the exact shape of the
  // plan bug that made jointGateHolds necessary, reappearing in its own test.
  //
  // This pair does discriminate: two 10 mm cubes 5 mm apart, further than the
  // 1.0 mm cutoff, asked for three shells. Count-first answers false. Gap-first
  // reaches minShellGap on a TWO-shell mesh with nothing inside the cutoff, and
  // throws before it ever looks at the count.
  const farApart = Mesh.merge([box(10, 10, 10), box(10, 10, 10).translate(15, 0, 0)]);
  check('GUARDS THE ORDER: a wrong count is answered even when the gap is unmeasurable',
    jointGateHolds(farApart, 3, C) === false, String(jointGateHolds(farApart, 3, C)));

  for (const [label, args] of [['expectedShells 0', [0, C]], ['expectedShells 1.5', [1.5, C]],
                               ['clearance 0', [2, 0]], ['clearance NaN', [2, NaN]]]) {
    throws(`${label} is rejected as an argument`, () => jointGateHolds(good, ...args), 'must be a positive');
  }
}

// ===========================================================================
// THE BALL JOINT ITSELF.
//
// Everything above proved the instrument. What follows is the first joint the
// instrument measures, built with no creature around it: two plain cylinders
// with a ball between them.
// ===========================================================================
import { joint, ballGeometry, hingeGeometry, JOINT_KINDS } from '../js/kernel/joint.js';
import { subtract, union, intersect } from '../js/kernel/csg.js';
import { cylinder } from '../js/kernel/builders.js';
import { isSolid, topology, deterministic } from './lib/meshcheck.mjs';

// ---------------------------------------------------------------------------
// The derivation, before any mesh exists.
// ---------------------------------------------------------------------------
{
  const g = ballGeometry({ r: 9, clearance: 0.35, swingDeg: 25, stalkFrac: 0.42 });
  check('the mouth clears the swing AND the stalk, not just the swing',
    g.mouthDeg > 25 + 15, `${g.mouthDeg.toFixed(1)}deg for 25deg of swing`);
  check('the ball is captive — the aperture is narrower than the ball',
    g.captiveMargin > 0, `aperture ${g.apertureR.toFixed(2)} vs ball ${g.ballR.toFixed(2)} mm`);
  check('and captive by a margin worth trusting, not by a rounding error',
    g.captiveMargin > 0.05 * g.ballR, `${g.captiveMargin.toFixed(3)} mm margin`);

  // Falsifier: a fat stalk widens the mouth until the ball can walk out. If
  // this still reports captive, the captivity arithmetic is decorative.
  const fat = ballGeometry({ r: 9, clearance: 0.35, swingDeg: 55, stalkFrac: 0.8 });
  check('FALSIFIER: a fat stalk and a wide swing are NOT captive, so the check can fail',
    fat.captiveMargin <= 0, `${fat.captiveMargin.toFixed(3)} mm margin`);

  // Falsifier for the >= 90 branch, which is the one a plain sin(mouthDeg)
  // gets wrong. Sine comes back DOWN past 90, so a 137deg mouth — a socket
  // with no lower half at all — reports an aperture of 2.07 mm against a
  // 2.70 mm ball and calls itself captive with a healthy 0.63 mm margin.
  // Past 90 the narrowest section the ball must pass is the socket's own
  // equator, and nothing is captive through that.
  const gaping = ballGeometry({ r: 9, clearance: 0.35, swingDeg: 80, stalkFrac: 0.95 });
  check('a mouth past 90deg has swallowed the equator', gaping.mouthDeg > 90,
    `${gaping.mouthDeg.toFixed(1)}deg`);
  check('FALSIFIER: and is reported open, not captive by the far side of the sine',
    gaping.captiveMargin <= 0,
    `${gaping.captiveMargin.toFixed(3)} mm margin; a plain sine would say ` +
    `+${(gaping.ballR - (gaping.ballR + gaping.c) * Math.sin(gaping.mouthDeg * Math.PI / 180)).toFixed(3)}`);

  // The size floors. These are the largest values at which every shipped
  // species keeps real wall around its thinnest socket, and the binding case
  // is the snake's last joint.
  const snake = ballGeometry({ r: 4.19 });
  const needs = snake.ballR + snake.c + snake.wall + 0.8;
  check('the snake\'s last joint at r = 4.19 still fits, which is what sets the floors',
    needs <= 4.19, `needs ${needs.toFixed(2)} mm of ${4.19} — ${(4.19 - needs).toFixed(2)} mm to spare`);
  check('and it is the FLOOR that binds there, not 0.30 x r',
    snake.ballR === 1.6 && 0.30 * 4.19 < 1.6, `ballR ${snake.ballR} vs 0.30 x r = ${(0.30 * 4.19).toFixed(3)}`);

  // clamp(v, lo, hi) returns lo when v < lo even if that exceeds hi, so on a
  // very thin body the ball deliberately comes out larger than 0.42 x r. A
  // Math.min here would put a 0.3 mm ball on a 1 mm body.
  const thin = ballGeometry({ r: 2 });
  check('on a very thin body the floor wins and the ball exceeds 0.42 x r',
    thin.ballR === 1.6 && thin.ballR > 0.42 * 2, `ballR ${thin.ballR} vs 0.42 x r = ${(0.42 * 2).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// The built joint. Two plain cylindrical segments, one ball between them.
//
// Assembly is CUT THE BODY, THEN GROW THE FEATURE, on both sides — the recipe
// joint.js documents. cutA clears the whole joint region out of A's body, so
// applying it after addA would eat the ball; the order is checked on its own
// further down.
// ---------------------------------------------------------------------------
function twoSegments({ clearance = 0.35, swingDeg = 25, stalkFrac = 0.42,
                       segments = 32, rings = 16, R = 9 } = {}) {
  const L = Math.max(16, 2 * R);
  const f = () => ({ p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: R });
  const j = joint('ball', { a: f(), b: f(), clearance, swingDeg, stalkFrac, segments, rings });
  const A = union(subtract(cylinder(R, L, { z0: -L, segments }), j.cutA), j.addA);
  const B = union(subtract(cylinder(R, L, { z0: 0, segments }), j.cutB), j.addB);
  return { mesh: Mesh.merge([A, B]), j, A, B, g: j.geometry };
}

{
  const C = 0.35;
  const { mesh, j } = twoSegments();
  isSolid('a ball joint between two segments', mesh);
  check('it is two shells, not one fused lump and not three pieces',
    shellCount(mesh) === 2, `${shellCount(mesh)} shells`);

  // Gate with jointGateHolds, never with the gap alone: at zero clearance the
  // joint WELDS into one shell, minShellGap has no pair left to measure and
  // returns Infinity, and `Infinity >= 0.315` sails through a gap-only gate at
  // exactly the moment it should fire.
  check('the joint gate holds — two shells AND 0.9 x the clearance asked for',
    jointGateHolds(mesh, 2, C), `gap ${minShellGap(mesh).min.toFixed(4)} mm vs ${(0.9 * C).toFixed(4)}`);
  near('and the gap is the concentric-sphere figure this file calibrated, not a new number',
    minShellGap(mesh).min, 0.3467, 0.004);

  check('the limit reports the swing it was asked for, about any axis',
    j.limit.deg === 25 && j.limit.axes === 'any', JSON.stringify(j.limit));
  check('ball is a known kind', JOINT_KINDS.includes('ball'));
}

{
  const C = 0.35;
  // Draft quality, where facet error is worst. Ball and socket share segment
  // and ring counts, so the facets stay parallel and the error cancels out of
  // the gap instead of adding to it.
  const draft = twoSegments({ segments: 16, rings: 8 });
  isSolid('the same joint at draft quality', draft.mesh);
  check('draft quality still holds the gate, because ball and socket share counts',
    jointGateHolds(draft.mesh, 2, C), `${minShellGap(draft.mesh).min.toFixed(4)} mm`);
  near('and reads the draft concentric figure', minShellGap(draft.mesh).min, 0.3369, 0.004);

  // FALSIFIER: ask for no clearance at all. The gate has to reject it, and the
  // reason it can is the shell count — the gap alone says Infinity here.
  const fused = twoSegments({ clearance: 0, segments: 16, rings: 8 });
  check('at zero clearance the ball welds to its socket: ONE shell',
    shellCount(fused.mesh) === 1, `${shellCount(fused.mesh)} shells`);
  check('its gap alone would pass the gate, which is why the gap alone is not the gate',
    minShellGap(fused.mesh).min >= 0.9 * C, String(minShellGap(fused.mesh).min));
  check('FALSIFIER: the same gate fails on it — it is measuring the mesh',
    jointGateHolds(fused.mesh, 2, C) === false, `${shellCount(fused.mesh)} shells`);

  // The snake's last joint, the case that sets the floors. Smallest joint the
  // catalogue ships, so the most likely to fuse.
  const snake = twoSegments({ R: 4.19, segments: 16, rings: 8 });
  isSolid('the snake\'s last joint at r = 4.19 mm', snake.mesh);
  check('and it holds the gate at the size that binds the floors',
    jointGateHolds(snake.mesh, 2, C),
    `ballR ${snake.g.ballR} mm, gap ${minShellGap(snake.mesh).min.toFixed(4)} mm`);
}

// ---------------------------------------------------------------------------
// mouthGap is a real millimetre, not a decoration.
//
// The derivation makes the mouth TANGENT to the stalk at zero swing; all the
// air between the stalk and the rim is bought by the swing angle. So a joint
// with almost no swing prints as one lump even though every other number looks
// healthy, and mouthGap is the number that says so without building anything.
// ---------------------------------------------------------------------------
{
  const tight = twoSegments({ swingDeg: 1, segments: 16, rings: 8 });
  isSolid('a 1-degree-swing joint is still a watertight build', tight.mesh);
  check('it is still two shells, so a shell-count gate would pass it',
    shellCount(tight.mesh) === 2, `${shellCount(tight.mesh)} shells`);
  check('and still captive, so the captivity gate would pass it too',
    tight.g.captiveMargin > 0, `${tight.g.captiveMargin.toFixed(3)} mm margin`);
  near('mouthGap predicts the measured gap, which is the stalk against the rim',
    minShellGap(tight.mesh).min, tight.g.mouthGap, 0.01);
  check('FALSIFIER: and it is far under the clearance, so the joint gate rejects it',
    jointGateHolds(tight.mesh, 2, 0.35) === false,
    `mouthGap ${tight.g.mouthGap.toFixed(4)} mm against a 0.35 mm nominal`);
}

// ---------------------------------------------------------------------------
// The cut face clears the socket by a clearance, at every mouth angle.
//
// The socket dome's outer surface is a sphere of radius ballR + c + wall about
// the ball centre, so a cut face at -(ballR + wall + c) is EXACTLY TANGENT to
// it — zero gap by construction. At the defaults that never shows, because a
// 47-degree mouth has already eaten the dome's whole lower half and its real
// rearmost point is 1.3 mm short of the face. Narrow the mouth and the dome
// grows back down towards its south pole, and the tangency arrives.
//
// So the face is put a clearance behind the dome's REACH rather than behind
// its actual rim: faceZ = rearZ - c. This is the case that tells the two
// apart — the whole-assembly gap cannot, because a mouth this narrow has
// already collapsed the stalk-to-rim gap and that is what minShellGap returns.
// ---------------------------------------------------------------------------
{
  const narrow = twoSegments({ swingDeg: 1, stalkFrac: 0.15, segments: 16, rings: 8 });
  const behind = narrow.B.bbox().min[2] - narrow.g.faceZ;
  // Where the mouth cone crosses the dome's outer sphere, which is as far back
  // as the socket can reach. Measured off vertices, so it reads a facet chord
  // short of the analytic figure.
  const reach = narrow.g.rearZ * Math.cos(narrow.g.mouthDeg * Math.PI / 180);
  near('the narrowest legal mouth leaves the dome nearly a whole sphere',
    narrow.B.bbox().min[2], reach, 0.1);
  check('and the cut face still sits a full clearance behind it',
    behind >= 0.9 * narrow.g.c,
    `${behind.toFixed(3)} mm behind the socket, against a ${narrow.g.c.toFixed(2)} mm nominal`);
}

// ---------------------------------------------------------------------------
// It swings the angle it claims — the only test here that the derivation
// cannot satisfy by being self-consistent.
//
// Every assertion above about mouthDeg is downstream of the same formula, so
// all of them would still pass if the formula were wrong. This one is not: the
// ball and stalk are rotated about the ball centre and measured against the
// real socket mesh. The gap has to survive most of the claimed swing and
// collapse just past it, and the angle where it collapses has to FOLLOW
// swingDeg — a chosen mouth angle would close at the same place whatever swing
// was asked for.
//
// The gap at a swung pose is smaller than the printed 0.3369 mm even where
// nothing is near contact: off the as-built pose the ball's facets no longer
// line up with the socket's, which is the same effect the equal-counts rule
// exists to avoid. That is a fact about a faceted ball in a faceted socket,
// not about the derivation, so this gates on the collapse and not on 0.9 x C.
//
// THE BRACKET HAS TO BE TIGHT, AND ONE DEGREE IS WHAT IT COSTS. A loose
// bracket — open at 0.6 x swing, shut at swing + 8, which is what this pair
// asked first — cannot see a mouth derived 10% narrow. Measured:
// `mouthDeg = swing * 0.9 + stalkHalf` leaves the whole file green, and
// `* 0.8` turns exactly one check red. The joint would then move 22.5 degrees
// while `limit.deg` told every later task 25, and a creature posed by that
// number would be posed into its own socket.
//
// So the limit is bracketed at +/- 1 degree instead, which the 1-degree sweep
// says is free: the gap is monotone and well separated either side of contact.
// One degree short reads 0.0268 / 0.0418 / 0.0464 mm at 10 / 25 / 45 degrees
// (0.0458 / 0.0460 / 0.0480 at normal quality, converging on the analytic
// 0.0451 as the facets fine down), and one degree past reads under 0.001. The
// 0.01 mm threshold sits 2.7x under the tightest honest reading and 17x over
// the loudest mutated one: at * 0.9 the same three checks read 0.0006 / 0.0002
// / 0.0001 and all three go red. Same number of minShellGap calls as the loose
// pair it replaces.
//
// Ten degrees is the case that sets the resolution. A 10% error there is one
// degree, so probing two degrees short would miss it — at swing - 2 the honest
// and mutated readings are 0.0943 and 0.0447, only 1.65x apart.
// ---------------------------------------------------------------------------
{
  const R = 9, L = 16, segments = 16, rings = 8;
  const swungGap = (swingDeg, atDeg) => {
    const f = () => ({ p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: R });
    const j = joint('ball', { a: f(), b: f(), swingDeg, segments, rings });
    const B = union(subtract(cylinder(R, L, { z0: 0, segments }), j.cutB), j.addB);
    return minShellGap(Mesh.merge([j.addA.rotateX(atDeg * Math.PI / 180), B])).min;
  };
  for (const swing of [10, 25, 45]) {
    const open = swungGap(swing, swing - 1);
    const shut = swungGap(swing, swing + 1);
    check(`a ${swing}deg joint still has air one degree short of its limit`,
      open > 0.01, `${open.toFixed(4)} mm at ${swing - 1}deg`);
    check(`FALSIFIER: and none one degree past it, so the limit IS ${swing}deg`,
      shut < 0.01, `${shut.toFixed(4)} mm at ${swing + 1}deg`);
  }
}

// ---------------------------------------------------------------------------
// Captivity in the mesh, not only in the arithmetic.
//
// The ball is captive when segment B has material below the ball's equator
// closer to the axis than the ball's own radius. Measured off B's vertices,
// which sit on chords inside the true aperture circle, so this reads very
// slightly narrower than apertureR — conservative in the direction that
// flatters captivity, hence the analytic margin is asserted alongside it.
// ---------------------------------------------------------------------------
{
  const narrowestBelow = (mesh, z) => {
    let m = Infinity;
    for (let i = 0; i < mesh.vertCount; i++) {
      const v = mesh.vertex(i);
      if (v[2] < z) m = Math.min(m, Math.hypot(v[0], v[1]));
    }
    return m;
  };
  const held = twoSegments({ segments: 16, rings: 8 });
  const rim = narrowestBelow(held.B, -0.01);
  check('B closes in under the ball: its narrowest ring below the equator is inside ballR',
    rim < held.g.ballR, `rim ${rim.toFixed(3)} mm vs ball ${held.g.ballR.toFixed(3)} mm`);
  near('and that ring is the aperture the arithmetic predicted', rim, held.g.apertureR, 0.05);

  // FALSIFIER: widen the swing and the mouth opens past the ball. The socket
  // is still a socket, still watertight, still two shells — and the ball can
  // be lifted straight out of it.
  const open = twoSegments({ swingDeg: 55, segments: 16, rings: 8 });
  isSolid('a 55-degree-swing socket is still a clean build', open.mesh);
  check('FALSIFIER: but its rim is wider than the ball, so it is not captive',
    narrowestBelow(open.B, -0.01) > open.g.ballR && open.g.captiveMargin <= 0,
    `rim ${narrowestBelow(open.B, -0.01).toFixed(3)} mm vs ball ${open.g.ballR.toFixed(3)} mm, ` +
    `margin ${open.g.captiveMargin.toFixed(3)} mm`);
}

// ---------------------------------------------------------------------------
// The assembly order, which is silent when you get it wrong.
//
// cutA clears the WHOLE joint region out of segment A's body — it has to, or
// the body fills the socket. Apply it after addA, as the obvious
// subtract(union(body, add), cut) reading would, and it eats the ball too,
// leaving a stump facing an empty socket.
//
// How loudly that fails depends on the mouth, which is why it is checked here
// on the geometry rather than left to the gap gate. At these defaults the stump
// sits 1.645 mm from the dome, past minShellGap's 1.0 mm cutoff, so the gate
// THROWS — loud, but for the wrong reason. Narrow the mouth to a 10-degree
// swing and the dome reaches down to 1.0232 mm, inside the cutoff, and
// jointGateHolds returns TRUE on a joint with no ball in it.
// ---------------------------------------------------------------------------
{
  const R = 9, L = 16, segments = 16;
  const f = () => ({ p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: R });
  const j = joint('ball', { a: f(), b: f(), segments, rings: 8 });
  const body = () => cylinder(R, L, { z0: -L, segments });
  const right = union(subtract(body(), j.cutA), j.addA);
  const wrong = subtract(union(body(), j.addA), j.cutA);
  near('cut then add: the ball stands proud of the cut face, on the ball centre',
    right.bbox().max[2], j.geometry.ballR, 1e-6);
  check('FALSIFIER: add then cut leaves a stump — the cut eats the ball it made room for',
    Math.abs(wrong.bbox().max[2] - j.geometry.faceZ) < 1e-6,
    `top of A is ${wrong.bbox().max[2].toFixed(3)} mm, the cut face, not ${j.geometry.ballR} mm`);
}

// ---------------------------------------------------------------------------
// The frame is honoured.
//
// Every check above uses an axis-aligned frame, where the frame matrix is the
// identity — and the identity is its own transpose, so a row-major/column-major
// slip is INVISIBLE to all of them. mesh.transform() takes column-major
// (mesh.js:84). This is the check that can see the difference.
//
// Note what does NOT see it: on this frame the transposed matrix produces a
// bounding box of exactly the same SIZE (5.4 x 7.1 x 5.4 mm) as the correct
// one, because transposing swaps which end of the long axis the stalk hangs
// off rather than which axis is long. A size comparison here is a check that
// cannot fail. It is min/max that discriminates, so that is what is asserted.
// ---------------------------------------------------------------------------
{
  const R = 9;
  const axis = { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: R };
  // A frame rotated 90 degrees about X: the joint's axis now runs along +Y.
  const f = { p: [0, 0, 0], t: [0, 1, 0], n: [1, 0, 0], b: [0, 0, -1], r: R };
  const q = { segments: 16, rings: 8 };
  const local = joint('ball', { a: axis, b: axis, ...q }).addA;
  const got = joint('ball', { a: f, b: f, ...q }).addA;
  const g = ballGeometry({ r: R });

  const bb = got.bbox();
  near('the stalk reaches back along -t from the ball centre, to the cut face',
    bb.min[1], g.faceZ, 1e-6);
  near('and the ball tops out a ball radius along +t', bb.max[1], g.ballR, 1e-6);
  check('the ball and stalk run along the frame tangent, not along +Z',
    bb.size[1] > bb.size[0] && bb.size[1] > bb.size[2],
    `addA is ${bb.size.map(v => v.toFixed(1)).join(' x ')} mm — long axis should be Y`);

  // FALSIFIER: the same mesh carried by the transposed matrix. If joint() is
  // written row-major this is what it produces, and the two are not the same
  // solid.
  const col = local.transform([f.n[0], f.n[1], f.n[2], 0, f.b[0], f.b[1], f.b[2], 0,
                               f.t[0], f.t[1], f.t[2], 0, 0, 0, 0, 1]);
  const row = local.transform([f.n[0], f.b[0], f.t[0], 0, f.n[1], f.b[1], f.t[1], 0,
                               f.n[2], f.b[2], f.t[2], 0, 0, 0, 0, 1]);
  near('joint() lands exactly where the column-major frame puts it',
    bb.min[1] - col.bbox().min[1], 0, 1e-9);
  check('FALSIFIER: the row-major frame puts the stalk the other way up, and would pass a size check',
    Math.abs(row.bbox().min[1] - g.ballR * -1) < 1e-6 &&
    row.bbox().size.every((v, i) => Math.abs(v - bb.size[i]) < 1e-6),
    `row-major y spans ${row.bbox().min[1].toFixed(2)} to ${row.bbox().max[1].toFixed(2)}, ` +
    `same size ${row.bbox().size.map(v => v.toFixed(1)).join(' x ')} mm`);
}

// ---------------------------------------------------------------------------
// Watertight at every legal value, and loud at the illegal ones.
// ---------------------------------------------------------------------------
{
  for (const o of [{ R: 1 }, { R: 4.19 }, { R: 20 }, { clearance: 0.6 },
                   { stalkFrac: 0.15 }, { stalkFrac: 0.9 }, { swingDeg: 45 }]) {
    const t = topology(twoSegments({ ...o, segments: 16, rings: 8 }).mesh);
    check(`watertight at ${JSON.stringify(o)}`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && t.degenerate === 0,
      `${t.boundary} boundary, ${t.nonManifold} non-manifold, ${t.inconsistent} wound wrong, ${t.degenerate} degenerate`);
  }
  // A 1 mm body gets a 1.6 mm ball, because the floor wins. That is the case
  // validate() is meant to complain about, and it still has to BUILD.
  check('even a 1 mm body, where the ball is bigger than the segment, builds',
    ballGeometry({ r: 1 }).ballR === 1.6, `ballR ${ballGeometry({ r: 1 }).ballR} mm on r = 1 mm`);

  // The clamps are silent, and a later task sweeping a user's swing parameter
  // and asking `captiveMargin > 0` at swing 0 is being answered about a
  // 1-degree joint. The clamped value is readable back, and these say where.
  check('swingDeg is clamped to [1, 80], and the clamped value is what comes back',
    ballGeometry({ r: 9, swingDeg: 0 }).swingDeg === 1 &&
    ballGeometry({ r: 9, swingDeg: -5 }).swingDeg === 1 &&
    ballGeometry({ r: 9, swingDeg: 100 }).swingDeg === 80,
    `0 -> ${ballGeometry({ r: 9, swingDeg: 0 }).swingDeg}, 100 -> ${ballGeometry({ r: 9, swingDeg: 100 }).swingDeg}`);
  check('stalkFrac is clamped to [0.05, 0.95], readable back as stalkR / ballR',
    Math.abs(ballGeometry({ r: 9, stalkFrac: 0 }).stalkR / 2.7 - 0.05) < 1e-9 &&
    Math.abs(ballGeometry({ r: 9, stalkFrac: 2 }).stalkR / 2.7 - 0.95) < 1e-9,
    `0 -> ${(ballGeometry({ r: 9, stalkFrac: 0 }).stalkR / 2.7).toFixed(3)}, ` +
    `2 -> ${(ballGeometry({ r: 9, stalkFrac: 2 }).stalkR / 2.7).toFixed(3)}`);
  // And the swing the joint was BUILT to is what limit.deg advertises, not the
  // number that was asked for.
  const clamped = joint('ball', { a: { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: 9 },
                                  b: { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: 9 },
                                  swingDeg: 0, segments: 16, rings: 8 });
  check('and limit.deg reports the clamped swing, not the one asked for',
    clamped.limit.deg === 1, `asked 0, got ${clamped.limit.deg}`);

  const st = () => ({ p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: 9 });
  throws('a mouth past 90 degrees is refused rather than built',
    () => joint('ball', { a: st(), b: st(), swingDeg: 80, stalkFrac: 0.9 }), 'would fall out');
  throws('an unknown kind is refused', () => joint('wobble', { a: st(), b: st() }), 'unknown kind');

  deterministic('the ball joint', () => twoSegments({ segments: 16, rings: 8 }).mesh);
}

// Starting B at the joint is safe. Lofting all the way through A is not.
{
  const good = twoSegments({ segments: 16, rings: 8 });
  const through = union(subtract(cylinder(9, 27, { z0: -9, segments: 16 }), good.j.cutB), good.j.addB);
  check('FALSIFIER: lofting B through A destroys ball clearance',
    !jointGateHolds(Mesh.merge([good.A, through]), 2, 0.35));
}

// Hinge assembly uses the same cut-before-add contract as the ball.
function hingeSegments({ R = 9, clearance = 0.35, swingDeg = 40,
                         axis = 'b', segments = 32, ctx = null } = {}) {
  const f = { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: R };
  const j = joint('hinge', { a: f, b: f, clearance, swingDeg, axis, segments, ctx });
  const L = Math.max(20, 3 * R);
  const A = union(subtract(cylinder(R, L, { segments, z0: -L }), j.cutA), j.addA);
  const B = union(subtract(cylinder(R, L, { segments }), j.cutB), j.addB);
  return { A, B, j, mesh: Mesh.merge([A, B]) };
}
{
  const h = hingeSegments();
  isSolid('hinge with both bodies', h.mesh);
  check('hinge has two connected bodies', shellCount(h.mesh) === 2);
  check('hinge holds the print gap', jointGateHolds(h.mesh, 2, 0.35));
  near('hinge clearance is applied once', minShellGap(h.mesh).min, 0.35, 0.004);
  // The overall minimum stays 0.35 at the side faces even if the bore is
  // enlarged twice. Measure the radial mating surface independently.
  let boreR = Infinity;
  for (let i = 0; i < h.A.vertCount; i++) {
    const [x, , z] = h.A.vertex(i);
    boreR = Math.min(boreR, Math.hypot(x, z));
  }
  near('hinge bore receives clearance once independently of leaf side gaps',
    boreR, h.j.geometry.pinR + 0.35, 0.02);
  check('hinge declares its axis and swing', h.j.limit.axes === 'one' &&
    h.j.limit.axis === 'b' && h.j.limit.deg === 40);
  const fused = hingeSegments({ clearance: 0, segments: 16 });
  check('FALSIFIER: zero-clearance hinge fails the gate', !jointGateHolds(fused.mesh, 2, 0.35));
}

{
  for (const axis of ['b', 'n']) {
    for (const swing of [10, 40, 65]) {
      const h = hingeSegments({ axis, swingDeg: swing, segments: 16 });
      const rotate = (mesh, deg) => axis === 'n' ? mesh.rotateX(deg * Math.PI / 180)
                                               : mesh.rotateY(deg * Math.PI / 180);
      for (const at of [-swing, -swing / 2, swing / 2, swing]) {
        const overlap = intersect(h.A, rotate(h.B, at)).volume();
        check(`${axis} hinge bodies clear at ${at}deg of declared ${swing}deg`,
          Math.abs(overlap) < 1e-6, `${overlap.toFixed(6)} mm³ overlap`);
      }
      const blocked = axis === 'n' ? h.B.rotateY(Math.PI / 6) : h.B.rotateX(Math.PI / 6);
      check(`FALSIFIER: ${axis} hinge blocks rotation across its pin`,
        intersect(h.A, blocked).volume() > 0.1);
    }
  }
  for (const axis of ['b', 'n']) {
    const h = hingeSegments({ axis, segments: 16 });
    const dir = axis === 'n' ? [1, 0, 0] : [0, 1, 0];
    for (const sign of [-1, 1]) {
      const moved = h.B.translate(...dir.map(v => v * sign * 0.7));
      check(`hinge is captive along ${sign > 0 ? '+' : '-'}${axis}: centre hits outer leaf`,
        intersect(h.A, moved).volume() > 0.1);
    }
    near(`${axis} pin follows requested frame axis`,
      h.j.addB.bbox().size[axis === 'n' ? 0 : 1], h.j.geometry.width, 1e-6);
  }
  for (const opts of [{ ctx: { segFactor: 0.5 } }, { R: 4.19 }, { R: 20 },
                       { clearance: 0.15 }, { clearance: 0.6 }]) {
    const h = hingeSegments({ ...opts, segments: 32 });
    isSolid(`hinge ${JSON.stringify(opts)}`, h.mesh);
    check(`hinge gate ${JSON.stringify(opts)}`, jointGateHolds(h.mesh, 2, opts.clearance ?? 0.35));
  }
  const draft = hingeSegments({ ctx: { segFactor: 0.5 } });
  check('hinge honours ctx quality', draft.j.addB.triCount < hingeSegments().j.addB.triCount);
  throws('hinge rejects unknown axis', () => hingeSegments({ axis: 'x' }), 'axis must');
  throws('hinge requires two stations', () => joint('hinge'), 'both stations');
  throws('hinge rejects leaves consumed by clearance',
    () => hingeGeometry({ r: 1, clearance: 1 }), 'positive leaves');
  near('hinge swing reads back its upper clamp', hingeGeometry({ swingDeg: 100 }).swingDeg, 80);
  deterministic('hinge', () => hingeSegments({ segments: 16 }).mesh);
}

done();
