// Stitched heads: a lofted head is rings in segment 0's own tube. Task 17.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { isSolid, topology } from './lib/meshcheck.mjs';
import { shellCount } from './lib/gapcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { HEAD_LOFTS, headRings, tubeThrough, tubeFacets, segmentsOf, fitToBed, speciesCarries } from '../js/gen/creature.js';

suite('gen creature heads');

const D = defaults(gen);
const LOFTED = Object.keys(HEAD_LOFTS);
// A station on the x axis, head growing along +x: up is z, side is -y, so the
// frame is right-handed (n x b = t) like every creature frame.
const here = r => ({ p: [0, 0, r], n: [0, 0, 1], b: [0, -1, 0], t: [1, 0, 0], r });

// ---------------------------------------------------------------------------
// The zip. Rings of different counts stitch only in whole multiples.
// ---------------------------------------------------------------------------
{
  const st = here(5), n = 24;
  const fine = headRings('dragon', st, st.t, ctx('normal'), 2 * n, 5);
  const m = tubeThrough([st, ...fine], n);
  const t = topology(m);
  check('a 24-ring zips onto a 48-ring watertight', t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0, JSON.stringify(t));
  check('and the volume is positive (the zip winds like the tube)', m.volume() > 0, `${m.volume().toFixed(1)}`);
  let threw = false;
  try { tubeThrough([st, ...headRings('dragon', st, st.t, ctx('normal'), 36, 5)], n); } catch { threw = true; }
  check('FALSIFIER: a 24-ring will not zip to a 36-ring', threw);
}

// ---------------------------------------------------------------------------
// Every lofted head, stitched on a bare body, at every quality: a solid, no
// boolean at the neck, chin on the plate, bigger than the neck.
// ---------------------------------------------------------------------------
for (const q of ['draft', 'normal', 'fine']) {
  const C = ctx(q);
  for (const head of LOFTED) {
    const p = { ...D, head, jaw: false, segments: 3, pose: 'straight', tail: 'nub', dorsal: 'none', limbPairs: 0 };
    const segs = segmentsOf(p, C);
    isSolid(`${head} head on segment 0, ${q}`, segs[0]);
    check(`${head}, ${q}: still 3 pieces`, shellCount(Mesh.merge(segs)) === 3);
  }
}
{
  const C = ctx('normal');
  for (const head of LOFTED) {
    // On the species' own body: the capybara's barrel makes its neck 0.7 of
    // bodyR, which is where a head sized off bodyR could put its chin under
    // the plate (mutation checked: drop the clamp in headRings and this fails).
    const p = { ...D, species: head, ...speciesCarries(head), jaw: false, segments: 3, pose: 'straight',
                tail: 'nub', dorsal: 'none', limbPairs: 0 };
    const bare = segmentsOf({ ...p, head: 'none' }, C)[0].bbox();
    const b = segmentsOf(p, C)[0].bbox();
    const L = HEAD_LOFTS[head], R = p.bodyR;
    const len = (L.keys.at(-1)[0] + L.nose) * R;
    // The head grows along -x from station 0 on a straight body.
    near(`${head}: reaches its loft's length ahead of the neck`, bare.min[0] - b.min[0], len, 0.02 * R);
    check(`${head}: stands on the plate, not lifted and not under it`, Math.abs(b.min[2]) < 1e-6, `${b.min[2]}`);
    check(`${head}: wider than the body`, b.size[1] > 1.15 * bare.size[1], `${b.size[1].toFixed(1)} vs ${bare.size[1].toFixed(1)} mm`);
  }

  // The features are there: at each bump's own z and angle the ring stands
  // proud of the same loft with its bumps taken off, by 40% of the bump's
  // height or more (the nearest ring can sit a little off the bump's z). (Against the neighbouring angle instead, a boxy dragon
  // section passed with no bumps at all.)
  for (const head of LOFTED) {
    const L = HEAD_LOFTS[head], R = D.bodyR, st = here(R), m = 96;
    HEAD_LOFTS.__plain = { ...L, bumps: [] };
    const ringsOf = kind => headRings(kind, st, st.t, C, m, R).filter(r => r.pts);
    const withB = ringsOf(head), plain = ringsOf('__plain');
    delete HEAD_LOFTS.__plain;
    for (const [z0, deg, h] of L.bumps) {
      // Nearest ring by its vertex 90 degrees round (the flank), which no
      // horn drags back along the axis.
      const j = withB.reduce((best, r, k) => Math.abs(r.pts[m / 4][0] - z0 * R) < Math.abs(withB[best].pts[m / 4][0] - z0 * R) ? k : best, 0);
      const i = Math.round(deg / 360 * m);
      const rho = q => Math.hypot(q[1], q[2] - R);
      const rise = rho(withB[j].pts[i]) - rho(plain[j].pts[i]);
      check(`${head}: the bump at z ${z0}, ${deg} deg stands proud`, rise > 0.4 * h * R,
        `${rise.toFixed(2)} mm for a ${(h * R).toFixed(2)} mm bump`);
    }
  }

  // The dragon's horns rake back past the neck plane, over its own segment.
  const st = here(D.bodyR);
  const behind = Math.min(...headRings('dragon', st, st.t, C, 48, D.bodyR).filter(r => r.pts).flatMap(r => r.pts.map(q => q[0])));
  check('dragon: the horn tips reach back over the neck', behind < -0.2 * D.bodyR, `${behind.toFixed(2)} mm`);
}

// ---------------------------------------------------------------------------
// The fitter measures a lofted head from its rings. Padding the nose like a
// station coiled the 169 mm dragon; it must stay diagonal, and inside the bed.
// ---------------------------------------------------------------------------
{
  const C = ctx('draft');
  for (const id of ['dragon', 'lizard', 'capybara']) {
    const p = { ...D, species: id, ...speciesCarries(id) };
    const f = fitToBed(p, C);
    check(`the ${id} keeps its diagonal`, f.pose === 'diagonal', JSON.stringify(f));
    const b = asMesh(gen.build(p, C)).bbox();
    check(`and the built ${id} is inside the bed`, b.size[0] <= 180 && b.size[1] <= 180, b.size.map(v => v.toFixed(1)).join(' x '));
  }
}

done();
