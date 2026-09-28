// Stitched heads: a lofted head is rings in segment 0's own tube. Task 17.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { isSolid, topology } from './lib/meshcheck.mjs';
import { shellCount } from './lib/gapcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import gen, { HEAD_LOFTS, headRings, headBranches, headFacets, tubeThrough, tubeFacets, segmentsOf, spineOf, fitToBed, speciesCarries } from '../js/gen/creature.js';

suite('gen creature heads');

const D = defaults(gen);
const LOFTED = Object.keys(HEAD_LOFTS);
// The species that wears each head (the bug head is the caterpillar's).
const OWNER = { bug: 'caterpillar' };
const ownerOf = head => OWNER[head] || head;
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
    const p = { ...D, species: ownerOf(head), ...speciesCarries(ownerOf(head)), jaw: false, segments: 3, pose: 'straight',
                tail: 'nub', dorsal: 'none', limbPairs: 0 };
    const bare = segmentsOf({ ...p, head: 'none' }, C)[0].bbox();
    const b = segmentsOf(p, C)[0].bbox();
    const L = HEAD_LOFTS[head], R = p.bodyR;
    const len = (L.keys.at(-1)[0] + L.nose) * R;
    // The head grows along -x from station 0 on a straight body.
    near(`${head}: reaches its loft's length ahead of the neck`, bare.min[0] - b.min[0], len, 0.02 * R);
    check(`${head}: stands on the plate, not lifted and not under it`, Math.abs(b.min[2]) < 1e-6, `${b.min[2]}`);
    // The dragon's and lizard's heads are wider than the body; the capybara's
    // is the body's own width, so head and loaf read as one animal (Sam's
    // references, 2026-09-27).
    const wider = head === 'capybara' ? 0.97 : 1.15;
    check(`${head}: ${head === 'capybara' ? 'as wide as' : 'wider than'} the body`, b.size[1] > wider * bare.size[1],
      `${b.size[1].toFixed(1)} vs ${bare.size[1].toFixed(1)} mm`);
  }

  // The features are there. Each bump is measured against the same head with
  // only that bump taken out, at its own z and angle, and must move the
  // surface by 40% of its height or more, outward for a bump and inward for a
  // dent. (Against the bare head, a socket measured at its centre read as a
  // rise, because the eye sits in it; against the neighbouring angle, a boxy
  // dragon section passed with no bumps at all.)
  for (const head of LOFTED) {
    const L = HEAD_LOFTS[head], R = D.bodyR, st = here(R), m = 96;
    const ringsOf = kind => headRings(kind, st, st.t, C, m, R).filter(r => r.pts);
    const withB = ringsOf(head);
    const rho = q => Math.hypot(q[1], q[2] - R);
    L.bumps.forEach(([z0, deg, h], k) => {
      HEAD_LOFTS.__less = { ...L, bumps: L.bumps.filter((_, i) => i !== k) };
      const less = ringsOf('__less');
      delete HEAD_LOFTS.__less;
      // Nearest ring by its bottom vertex (180 degrees round), which no bump
      // touches and no rake drags back along the axis.
      const j = withB.reduce((best, r, q) => Math.abs(r.pts[m / 2][0] - z0 * R) < Math.abs(withB[best].pts[m / 2][0] - z0 * R) ? q : best, 0);
      const i = Math.round(deg / 360 * m);
      const rise = rho(withB[j].pts[i]) - rho(less[j].pts[i]);
      check(`${head}: the ${h < 0 ? 'dent' : 'bump'} at z ${z0}, ${deg} deg ${h < 0 ? 'sinks in' : 'stands proud'}`,
        h < 0 ? rise < 0.4 * h * R : rise > 0.4 * h * R,
        `${rise.toFixed(2)} mm for a ${(h * R).toFixed(2)} mm ${h < 0 ? 'dent' : 'bump'}`);
    });
  }

  // The dragon's horns rake back past the neck plane, over its own segment.
  const st = here(D.bodyR);
  const behind = Math.min(...headRings('dragon', st, st.t, C, 48, D.bodyR).filter(r => r.pts).flatMap(r => r.pts.map(q => q[0])));
  check('dragon: the horn tips reach back over the neck', behind < -0.2 * D.bodyR, `${behind.toFixed(2)} mm`);
}

// ---------------------------------------------------------------------------
// HEAD BRANCHES: eyes and antennae grown out of the head's rings. Every one
// declared is built, on both sides, at every quality, and the head segment
// that carries them has no triangles crossing (they are never checked by a
// boolean; aimed along the radial direction instead of the rim's normal, the
// eyes dipped into the skull for 2 to 22 crossing pairs).
// ---------------------------------------------------------------------------
{
  const crossings = (m) => {
    const P = m.positions, n = m.triCount, V = i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const hits = (p0, p1, t) => {
      const d = sub(p1, p0), e1 = sub(t[1], t[0]), e2 = sub(t[2], t[0]), h = cr(d, e2), a = dt(e1, h);
      if (Math.abs(a) < 1e-12) return false;
      const f = 1 / a, s0 = sub(p0, t[0]), u = f * dt(s0, h); if (u < 1e-7 || u > 1 - 1e-7) return false;
      const q = cr(s0, e1), v = f * dt(d, q); if (v < 1e-7 || u + v > 1 - 1e-7) return false;
      const tt = f * dt(e2, q); return tt > 1e-7 && tt < 1 - 1e-7;
    };
    const cell = 1.5, grid = new Map();
    for (let i = 0; i < n; i++) {
      const pts = m.tri(i).map(V);
      const lo = [0, 1, 2].map(k => Math.floor(Math.min(...pts.map(p => p[k])) / cell)), hi = [0, 1, 2].map(k => Math.floor(Math.max(...pts.map(p => p[k])) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    }
    let count = 0; const seen = new Set();
    for (const list of grid.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const i = list[a], j = list[b], key = i * 1e7 + j; if (seen.has(key)) continue; seen.add(key);
      const ti = m.tri(i), tj = m.tri(j); if (ti.some(v => tj.includes(v))) continue;
      const A = ti.map(V), B = tj.map(V);
      if ([0, 1, 2].some(k => hits(A[k], A[(k + 1) % 3], B)) || [0, 1, 2].some(k => hits(B[k], B[(k + 1) % 3], A))) count++;
    }
    return count;
  };
  for (const q of ['draft', 'normal', 'fine']) {
    const C = ctx(q);
    for (const head of LOFTED) {
      const L = HEAD_LOFTS[head];
      if (!L.branches) continue;
      const p = { ...D, species: ownerOf(head), ...speciesCarries(ownerOf(head)) };
      const st = spineOf(p, C).stations[0], fwd = st.t.map(v => -v);
      const rings = headRings(head, st, fwd, C, headFacets(tubeFacets(C)), p.bodyR).reverse();
      const br = headBranches(L, rings, 0, st, fwd, p.bodyR);
      check(`${head}, ${q}: every branch built on both sides`, br.length === 2 * L.branches.length, `${br.length} of ${2 * L.branches.length}`);
      if (q === 'normal') {
        const seg = segmentsOf({ ...p, segments: 3, pose: 'straight', limbPairs: 0, dorsal: 'none', jaw: false }, C)[0];
        check(`${head}: no triangles cross on the head segment`, crossings(seg) === 0);
        // Each branch stands out of the head: its tip is past the rim by
        // most of the branch's own length.
        for (const b of br) {
          const T = b.tip, rimC = b.rings[0].pts.reduce((a, v) => a.map((x, k) => x + v[k] / b.rings[0].pts.length), [0, 0, 0]);
          check(`${head}: branch stands out`, Math.hypot(...T.map((v, k) => v - rimC[k])) > 0.3 * Math.min(...L.branches.map(x => x.r)) * p.bodyR);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Every ring point finite, every head, every quality, on every species' own
// neck. The capybara's nose sinks below the axis near its tip; measured from
// the axis its upper half went negative and NaN points reached the fitter,
// which coiled the animal at fine quality.
// ---------------------------------------------------------------------------
for (const q of ['draft', 'normal', 'fine']) {
  for (const head of LOFTED) {
    const p = { ...D, species: ownerOf(head), ...speciesCarries(ownerOf(head)) };
    const st = spineOf(p, ctx(q)).stations[0];
    const pts = headRings(head, st, st.t.map(v => -v), ctx(q), 48, p.bodyR).flatMap(r => r.pts || [r.p]);
    check(`${head}, ${q}: every head point is finite`, pts.every(v => v.every(Number.isFinite)),
      `${pts.filter(v => !v.every(Number.isFinite)).length} of ${pts.length} not`);
  }
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
