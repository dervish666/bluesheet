// Free swing: how far a joint bends before the two segments collide. Task 14.
//
// Every other check measures a creature at rest. A spike that clears its
// neighbour straight and welds to it at 15 degrees is invisible to all of
// them, and Task 15's crowns and nested faces are exactly that kind of
// feature. So this turns segment i+1 about its joint and measures the pair.
//
// NOT "the print gap holds while it bends". The 0.35 mm gap is a PRINT-TIME
// requirement, at rest. Bent, the ball and socket facets fall out of step and
// the gap dips (0.3441 at rest, 0.3239 at 4 degrees, 0.2258 at 20, measured
// at the ball, 1.5 to 2.5 mm off the pivot), and that is harmless: a printed
// joint is allowed to touch while it moves. What is not allowed is to JAM. So
// the gate is collision, with TOUCH mm of allowance for faceting, and a
// decorated joint is judged by whether it bends as far as the same joint bare.
// A first version gated on 0.9 x clearance and reported every dragon joint
// free to only 6 to 14 degrees, the faceting and nothing else.
export const TOUCH = 0.05;
import { Mesh } from '../../js/kernel/mesh.js';
import { minShellGap } from './gapcheck.mjs';
import { segmentsOf, spineOf } from '../../js/gen/creature.js';

/** Column-major rotation by `deg` about the unit axis `u` through point `p`. */
function rotAbout(p, u, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const [x, y, z] = u;
  const R = [
    t * x * x + c,     t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c,     t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ];
  // Columns of R, then the translation that keeps p fixed: p - R p.
  const Rp = [0, 1, 2].map(r => R[r] * p[0] + R[3 + r] * p[1] + R[6 + r] * p[2]);
  return [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0,
          p[0] - Rp[0], p[1] - Rp[1], p[2] - Rp[2], 1];
}

/** The directions a joint bends: a ball both ways about up and about the
 *  side; the creature's hinge pin runs along the side, so only about that. */
function directions(p, st) {
  const out = [['side+', st.b, 1], ['side-', st.b, -1]];
  if (p.joint !== 'hinge') out.push(['yaw+', st.n, 1], ['yaw-', st.n, -1]);
  return out;
}

/**
 * For joint `i` (between segments i and i+1), the smallest angle in any
 * direction at which the pair collides (gap under TOUCH), scanned in `step`
 * degree steps up to `max`. Returns { free, dir }.
 */
export function freeSwing(p, ctx, i, { step = 2, max = 60, gate = TOUCH, segs = null } = {}) {
  const pieces = segs || segmentsOf(p, ctx);
  const st = spineOf(p, ctx).stations[i + 1];
  let free = max, worst = null;
  for (const [name, axis, sign] of directions(p, st)) {
    for (let a = step; a <= max; a += step) {
      const moved = pieces[i + 1].transform(rotAbout(st.p, axis, sign * a));
      // One shell means the pair has welded: minShellGap reads Infinity for
      // it, which a bare `g >= gate` would call wide open.
      const r = minShellGap(Mesh.merge([pieces[i], moved]));
      if (r.shells < 2 || !(r.min >= gate)) {
        if (a - step < free) { free = a - step; worst = name; }
        break;
      }
    }
  }
  return { free, dir: worst };
}
