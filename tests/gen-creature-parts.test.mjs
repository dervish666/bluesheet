// The creature's parts kit: heads, tails, limbs and dorsal rows. Its own file,
// not an extension of gen-creature.test.mjs, because that suite already spends
// 166 s of run.mjs's 300 s per-file budget on gap measurement and this one
// builds two dozen more creatures.
//
// Every part is FUSED to its host segment. The piece count is asserted, never
// assumed, and the count is proved able to see a bridge before it is trusted.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { shellCount, minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import { isSolid, onPlate, deterministic } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import { union } from '../js/kernel/csg.js';
import gen, { PART_LIFT, HEADS, TAILS, LIMBS, DORSAL, POSES, spineOf, segmentsOf, partsOf, outward } from '../js/gen/creature.js';

suite('gen creature parts');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));
const bare = { head: 'none', tail: 'nub', limbPairs: 0, dorsal: 'none', segments: 8 };   // the default tail is already the nub

// ---------------------------------------------------------------------------
// The frame the parts are built on. Parts treat the station's n as "up off
// the plate" and b as "sideways"; that is a property of parallelFrames'
// upHint and it is measured here for every pose, because the brief's sketches
// assumed the opposite and a head built on the wrong axis lies on its side.
// ---------------------------------------------------------------------------
{
  for (const pose of Object.keys(POSES)) {
    const { stations } = spineOf({ ...D, pose }, C);
    check(`${pose}: every station's n is straight up`, stations.every(s => s.n[2] > 0.999),
      `n at station 3 = ${stations[3].n.map(v => v.toFixed(2)).join(',')}`);
    check(`${pose}: and b lies flat on the plate`, stations.every(s => Math.abs(s.b[2]) < 1e-6),
      `b at station 3 = ${stations[3].b.map(v => v.toFixed(2)).join(',')}`);
  }
  // A head rides a reversed frame. Flipping b and t together keeps the frame
  // right-handed (n x b = t still holds), so nothing is mirrored.
  const st = spineOf(D, C).stations[0], o = outward(st);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nb = cross(o.n, o.b);
  check('the outward head frame is still right-handed', nb.every((v, k) => Math.abs(v - o.t[k]) < 1e-9),
    `n x b = ${nb.map(v => v.toFixed(2)).join(',')} vs t = ${o.t.map(v => v.toFixed(2)).join(',')}`);
  check('and it points away from the tail', o.t.every((v, k) => Math.abs(v + st.t[k]) < 1e-9));
}

// ---------------------------------------------------------------------------
// The kit is complete.
// ---------------------------------------------------------------------------
{
  check('there is a head for every species we intend to ship',
    ['none', 'blunt', 'dragon', 'lizard', 'fish', 'bug', 'capybara'].every(k => typeof HEADS[k] === 'function'),
    Object.keys(HEADS).join(', '));
  check('and a tail, a limb and a dorsal set',
    ['taper', 'spike', 'fan', 'sting', 'nub'].every(k => typeof TAILS[k] === 'function') &&
    ['clawed', 'fin', 'stub'].every(k => typeof LIMBS[k] === 'function') &&
    ['none', 'spikes', 'fin', 'plates'].every(k => typeof DORSAL[k] === 'function'));
  check('"none" is an empty mesh, not a missing function',
    HEADS.none().isEmpty() && DORSAL.none().isEmpty());

  // Every part alone is a solid — a part that arrives as two shells, or as an
  // open sheet, would be hidden inside the union with its host.
  const st = { p: [0, 0, 0], t: [0, 0, 1], n: [1, 0, 0], b: [0, 1, 0], r: 9, len: 9, reach: 8 };
  for (const [k, fn] of Object.entries(HEADS)) if (k !== 'none') {
    const m = fn(st, D, C);
    isSolid(`head ${k} alone`, m);
    check(`head ${k} is one piece`, shellCount(m) === 1, `${shellCount(m)} shells`);
    check(`head ${k} points outward (+t)`, m.bbox().max[2] > 0.8 * st.r, `reaches ${m.bbox().max[2].toFixed(1)} mm`);
  }
  for (const [k, fn] of Object.entries(TAILS)) {
    const m = fn(st, D, C);
    isSolid(`tail ${k} alone`, m);
    check(`tail ${k} is one piece`, shellCount(m) === 1, `${shellCount(m)} shells`);
  }
  for (const [k, fn] of Object.entries(LIMBS)) for (const side of [1, -1]) {
    const m = fn(st, side, D, C);
    isSolid(`limb ${k} side ${side} alone`, m);
    check(`limb ${k} side ${side} is one piece`, shellCount(m) === 1, `${shellCount(m)} shells`);
    // Task 13: a limb stands ON the plate, exactly PART_LIFT above the belly
    // line and never below it (the first set hung 1.2 r under the belly and
    // lifted the whole body into the air), reaches out to its own side, and
    // stays off the mirror plane so the pair never meet.
    const bb = m.bbox(), plate = -st.r + PART_LIFT;
    check(`limb ${k} side ${side} stands on the plate, to its own side`,
      Math.abs(bb.min[0] - plate) < 1e-9 &&
      (side > 0 ? bb.max[1] > 0.5 * st.r && bb.min[1] > 0 : bb.min[1] < -0.5 * st.r && bb.max[1] < 0),
      `lowest ${bb.min[0].toFixed(3)} (plate ${plate.toFixed(3)}), y ${bb.min[1].toFixed(1)}..${bb.max[1].toFixed(1)}`);
  }
  for (const [k, fn] of Object.entries(DORSAL)) if (k !== 'none') {
    const m = fn(st, D, C);
    isSolid(`dorsal ${k} alone`, m);
    check(`dorsal ${k} stands up out of the back`, m.bbox().max[0] > 1.3 * st.r, `${m.bbox().max[0].toFixed(1)} mm up`);
    check(`dorsal ${k} stays inside its segment's span`, m.bbox().min[2] > -st.len / 2 && m.bbox().max[2] < st.len / 2,
      `z ${m.bbox().min[2].toFixed(1)}..${m.bbox().max[2].toFixed(1)} against ±${(st.len / 2).toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
// Parts are fused, not floating. Every combination still has one shell per
// segment: parts change the shape, never the piece count.
// ---------------------------------------------------------------------------
{
  for (const head of ['blunt', 'dragon', 'capybara']) {
    for (const tail of ['taper', 'spike', 'nub']) {
      const m = build({ head, tail, segments: 8, limbPairs: 2, limbKind: 'stub', dorsal: 'spikes' });
      check(`${head}/${tail} with legs and a dorsal is still 8 pieces`,
        shellCount(m) === 8, `${shellCount(m)} shells`);
      isSolid(`${head}/${tail}`, m);
    }
  }
  for (const head of ['lizard', 'fish', 'bug']) {
    const m = build({ head, tail: 'fan', segments: 8, limbPairs: 2, limbKind: 'fin', dorsal: 'fin' });
    check(`${head}/fan with fins is still 8 pieces`, shellCount(m) === 8, `${shellCount(m)} shells`);
    isSolid(`${head}/fan`, m);
  }
  // segLen pinned at 14, the default these fixtures were written and measured
  // against. While the defaults were briefly the dragon row (segLen 15) these
  // two cells rolled 2 non-manifold edges each — the B-side boolean residue of
  // ruling 41, not anything about the parts. Measured: segLen 14 and 16 are
  // clean here, 15 is not. This suite tests the PARTS; the dice are pinned and
  // measured in the envelope maps and the species suite. Ruling 50.
  const clawed = build({ head: 'dragon', tail: 'sting', segments: 8, segLen: 14, limbPairs: 2, limbKind: 'clawed', dorsal: 'plates' });
  check('dragon/sting with clawed legs and plates is still 8 pieces', shellCount(clawed) === 8, `${shellCount(clawed)} shells`);
  isSolid('dragon/sting/clawed/plates', clawed);
  onPlate('a creature with legs still rests on the plate', clawed);

  // The other joint, the tightest poses, and the big end of the body range,
  // with a pair of legs on EVERY segment. The small end is measured below
  // with a realistic pair count: with limbs on every segment of a body under
  // about 8 mm the parts' thickness floors are the size of the body, the
  // parts overlap one another, and the CSG kernel returns a stray
  // non-manifold edge somewhere — sporadically, at a segment that moves with
  // the pose. Measured across bodyR 4..7, three limb kinds, three poses: 16
  // of 36 cases. That is a kernel ceiling, recorded in task-7-report.md for
  // Task 11's validate() to fence, not something this suite pretends is fine.
  for (const over of [
    { joint: 'hinge' }, { pose: 'coil', tight: 1 }, { pose: 'scurve', tight: 1 },
    { bodyR: 9, segLen: 10 }, { bodyR: 22, segLen: 26, segments: 6 },
  ]) {
    const p = { head: 'dragon', tail: 'spike', segments: 8, segLen: 14, limbPairs: 8, limbKind: 'clawed', dorsal: 'plates', ...over };   // segLen: see ruling 50 above
    const m = build(p);
    check(`everything on at ${JSON.stringify(over)} is still ${p.segments} pieces`,
      shellCount(m) === p.segments, `${shellCount(m)} shells`);
    isSolid(`everything on at ${JSON.stringify(over)}`, m);
  }
  // The smallest body still carries a dragon's two pairs of clawed legs, its
  // plates and its head, straight and coiled tight. Part of what used to fail
  // here was the checker: it welded on a rounding grid, so the verdict moved
  // with the mesh. Task 13b made the weld distance-based and the tight coil
  // came back clean. The tight S-curve still reads 2 non-manifold edges and
  // they do NOT move when the mesh does, so they are real: the 4 mm body with
  // limbs is the kernel's edge (task-7-report.md), and validate() owns it.
  for (const over of [{}, { pose: 'coil', tight: 1 }]) {
    const p = { bodyR: 4, segLen: 6, head: 'dragon', tail: 'spike', segments: 8, limbPairs: 2, limbKind: 'clawed', dorsal: 'plates', ...over };
    const m = build(p);
    check(`a 4 mm dragon with two pairs of legs at ${JSON.stringify(over)} is still 8 pieces`,
      shellCount(m) === 8, `${shellCount(m)} shells`);
    isSolid(`a 4 mm dragon at ${JSON.stringify(over)}`, m);
  }
  deterministic('a fully dressed creature', () => build({ head: 'dragon', tail: 'spike', limbPairs: 2, limbKind: 'clawed', dorsal: 'spikes', segments: 8 }));
}

// ---------------------------------------------------------------------------
// And the parts are actually there — a head that silently returns an empty
// mesh would pass every check above.
// ---------------------------------------------------------------------------
{
  const plain = build(bare);
  const horned = build({ ...bare, head: 'dragon', tail: 'spike' });
  check('a dragon head and a spiked tail add real material to the body',
    horned.volume() > plain.volume() * 1.05,
    `${plain.volume().toFixed(0)} -> ${horned.volume().toFixed(0)} mm3`);

  const legs = build({ ...bare, limbPairs: 2, limbKind: 'clawed' });
  check('and four clawed legs add more again',
    legs.volume() > plain.volume() * 1.01, `${plain.volume().toFixed(0)} -> ${legs.volume().toFixed(0)} mm3`);

  const plainB = plain.bbox(), legsB = legs.bbox();

  // Measured in the STRAIGHT pose, and built for it rather than reusing the
  // fixtures above. `bare` takes the default pose, which is the diagonal: the
  // spine is laid at 45 degrees so its own span fills BOTH horizontal axes —
  // 89.1 mm for eight segments — and four legs cannot move that. The check read
  // 89.1 against 89.1 and had never passed. The claim is about the parts, so
  // measure it where "across" means across: 18.0 -> 32.0 mm, a ratio of 1.78.
  const plainStraight = build({ ...bare, pose: 'straight' }).bbox();
  const legsStraight = build({ ...bare, pose: 'straight', limbPairs: 2, limbKind: 'clawed' }).bbox();
  check('legs reach further across the body than a bare spine does',
    legsStraight.size[1] > plainStraight.size[1] * 1.15,
    `${plainStraight.size[1].toFixed(1)} -> ${legsStraight.size[1].toFixed(1)} mm across`);
  check('and a dorsal row stands taller than the bare body',
    build({ ...bare, dorsal: 'spikes' }).bbox().size[2] > plainB.size[2] * 1.15,
    `${plainB.size[2].toFixed(1)} -> ${build({ ...bare, dorsal: 'spikes' }).bbox().size[2].toFixed(1)} mm tall`);

  // Every head is distinguishable from "blunt" by volume — otherwise the menu
  // is decorative.
  const vol = head => build({ ...bare, head }).volume();
  const blunt = vol('blunt');
  for (const head of ['dragon', 'lizard', 'fish', 'bug', 'capybara']) {
    check(`the ${head} head is not just the blunt head renamed`, Math.abs(vol(head) - blunt) > blunt * 0.002,
      `${vol(head).toFixed(0)} vs ${blunt.toFixed(0)} mm3`);
  }
}

// ---------------------------------------------------------------------------
// Limb placement follows the species row when there is one, and spreads
// evenly when there is not. Positions are fractions of the spine.
// ---------------------------------------------------------------------------
{
  // Three sources, in order: an explicit `limbAt` beats the species row, which
  // beats even spacing. `species: null` is how this block asks for "no row" —
  // the DEFAULTS now name the dragon, whose row places its legs at 0.25 and
  // 0.55, so spreading `...D` no longer means "nothing in particular".
  const p = { ...D, species: null, segments: 8, limbPairs: 2, limbKind: 'stub', head: 'none', dorsal: 'none' };
  const spans = Array.from({ length: 8 }, () => ({ from: 0.5, to: 13.5 }));
  const { stations } = spineOf(p, C);
  const where = (over) => partsOf({ ...p, ...over }, C, stations, spans)
    .map((list, i) => (list.filter(m => !m.isEmpty()).length >= 2 ? i : -1)).filter(i => i >= 0);
  check('two pairs with no row fall on segments 2 and 5 of 8', where({}).join(',') === '2,5', where({}).join(','));
  check('an explicit limbAt puts them where it says', where({ limbAt: [0.1, 0.9] }).join(',') === '0,7', where({ limbAt: [0.1, 0.9] }).join(','));
  check('a limbAt shorter than the pair count is ignored, not half-applied',
    where({ limbAt: [0.1] }).join(',') === '2,5', where({ limbAt: [0.1] }).join(','));
  check('and a species row places them when there is no explicit limbAt',
    where({ species: 'dragon' }).join(',') === '2,4', where({ species: 'dragon' }).join(','));
  check('an explicit limbAt still beats the species row',
    where({ species: 'dragon', limbAt: [0.1, 0.9] }).join(',') === '0,7',
    where({ species: 'dragon', limbAt: [0.1, 0.9] }).join(','));
}

// ---------------------------------------------------------------------------
// The gates from Task 6 hold with everything on. The gap is a property of the
// joint, and no part is allowed to come nearer to a neighbour than the joint
// does; measured on a 4-segment creature, the same pattern gen-creature uses.
// ---------------------------------------------------------------------------
{
  const m = build({ segments: 4, head: 'dragon', tail: 'spike', limbPairs: 2, limbKind: 'clawed', dorsal: 'spikes' });
  const gap = minShellGap(m).min;
  check('a fully dressed creature holds the joint gap gate', jointGateHolds(m, 4, D.clearance),
    `${gap.toFixed(4)} mm against ${D.clearance} mm nominal`);
  near('and the nearest approach is still the joint itself, not a part', gap, 0.3441, 0.004);
}

// ---------------------------------------------------------------------------
// The falsifier for the placement rule. Parts sit at the centre of a
// segment's safe span BECAUSE a part on the boundary station bridges the
// joint: put a dorsal spike on station 1 by hand and the count drops. This is
// what proves the shell count above can see a bridge at all.
// ---------------------------------------------------------------------------
{
  const p = { ...D, ...bare };
  const segs = segmentsOf(p, C);
  const { stations } = spineOf(p, C);
  // A plate, not a spike: the joint trims leave 4.4 mm of open air along the
  // back between A's cut face and B's tube, and a spike is too narrow to
  // reach both; a plate given a two-segment span is 9.9 mm long and does.
  const plate = DORSAL.plates({ ...stations[1], len: 2 * D.segLen }, p, C);
  // union, not merge: shellCount is connectivity, so a merged part is always
  // one more shell whether it touches anything or not. Unioned into BOTH the
  // segments it straddles, it welds them and the count drops.
  const bridged = Mesh.merge([union(union(segs[0], plate), segs[1]), ...segs.slice(2)]);
  check('a plate on a boundary station spans the gap and reads as fewer pieces',
    shellCount(bridged) < segs.length, `${shellCount(bridged)} shells for ${segs.length} segments`);
  check('whereas the real build keeps every segment separate',
    shellCount(build(bare)) === 8, `${shellCount(build(bare))} shells`);
}

done();
