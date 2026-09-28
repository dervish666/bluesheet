// The articulated jaw: the one entry in a species' `articulate` list that
// changes a part rather than freeing it. The head splits into a cranium,
// fused to the first segment, and a mandible that turns on a barrel captive
// in a socket at the jaw corner.
//
// Its own file for run.mjs's 300 s per-file budget.
import { suite, check, near, done } from './lib/assert.mjs';
import { ctx, defaults, asMesh } from './lib/genconform.mjs';
import { shellCount, minShellGap, jointGateHolds } from './lib/gapcheck.mjs';
import { isSolid } from './lib/meshcheck.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import { intersect } from '../js/kernel/csg.js';
import gen, { HEADS, JAW_HEADS, splitHead, jawGeometry } from '../js/gen/creature.js';

suite('gen creature jaw');

const C = ctx('normal');
const D = defaults(gen);
const build = (over = {}) => asMesh(gen.build({ ...D, ...over }, C));
const HEAD_R = 1.05;
const here = (r) => ({ p: [0, 0, 0], n: [1, 0, 0], b: [0, 1, 0], t: [0, 0, 1], r, reach: 0.9 * r });

// ---------------------------------------------------------------------------
// Exactly one more piece, and the gate still holds, on every head that has one.
// ---------------------------------------------------------------------------
for (const head of JAW_HEADS) {
  const shut = build({ head, jaw: false, segments: 4 });
  const open = build({ head, jaw: true, segments: 4 });
  check(`${head}: a fused jaw leaves the piece count alone`, shellCount(shut) === 4, `${shellCount(shut)} shells`);
  check(`${head}: an articulated one adds exactly one piece`, shellCount(open) === 5, `${shellCount(open)} shells`);
  check(`${head}: every gap still clears the gate, the jaw's included`,
    jointGateHolds(open, 5, D.clearance), `${minShellGap(open).min.toFixed(4)} mm`);
  isSolid(`${head} with an opening jaw`, open);
}

// ---------------------------------------------------------------------------
// The jaw's OWN gap, measured on the two halves alone. On a whole creature the
// minimum is the spine joint's 0.3441 mm, which would hide a jaw welded shut
// behind a healthy number — so split the head and measure the pair directly.
// ---------------------------------------------------------------------------
for (const head of JAW_HEADS) {
  const r = 9, rh = HEAD_R * r;
  const { cranium, mandible } = splitHead(HEADS[head](here(r), D, C), rh, D);
  const pair = Mesh.merge([cranium, mandible]);
  check(`${head}: the split head is exactly two pieces`, shellCount(pair) === 2, `${shellCount(pair)}`);
  near(`${head}: skull and jaw are one clearance apart, not more, not less`,
    minShellGap(pair).min, D.clearance, 0.01);
  isSolid(`${head} cranium`, cranium);
  isSolid(`${head} mandible`, mandible);

  // It is a LOWER jaw: all of it below the pivot's top and ahead of its back.
  const g = jawGeometry(rh, D.clearance), bb = mandible.bbox();
  check(`${head}: the mandible hangs below the mouth line and ahead of the socket`,
    bb.max[0] <= g.xj + g.Rk + 1e-6 && bb.min[2] >= g.zc - g.Rk - 1e-6,
    `x up to ${bb.max[0].toFixed(2)}, z from ${bb.min[2].toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// CAPTIVE, not merely separate. Two shells a clearance apart could simply fall
// off each other; the barrel has to be locked in its socket. Pull the mandible
// a whole barrel radius in each way it could try to leave — forward, down, and
// diagonally out through the open quadrant — and it must run into the skull.
// ---------------------------------------------------------------------------
{
  const r = 9, rh = HEAD_R * r;
  const { cranium, mandible, geometry: g } = splitHead(HEADS.dragon(here(r), D, C), rh, D);
  const s = Math.SQRT1_2;
  for (const [way, dx, dz] of [['forward', 0, 1], ['down', -1, 0], ['forward and down, through the opening', -s, s]]) {
    const moved = mandible.translate(dx * g.Rk, 0, dz * g.Rk);
    const hit = intersect(moved, cranium);
    check(`the jaw cannot be pulled out ${way}`, !hit.isEmpty() && hit.volume() > 1e-3,
      `${hit.isEmpty() ? 'no' : hit.volume().toFixed(2) + ' mm3 of'} overlap after ${g.Rk.toFixed(2)} mm`);
  }
  // The arithmetic behind the last one, for every body this generator allows.
  const tight = [4, 9, 22].every(br => {
    const q = jawGeometry(HEAD_R * br, D.clearance);
    return 2 * q.Rk > Math.SQRT2 * (q.Rk + D.clearance);
  });
  check('the opening is narrower than the barrel at bodyR 4, 9 and 22', tight);
}

// ---------------------------------------------------------------------------
// A head with no muzzle must say so rather than quietly ignoring the request.
// ---------------------------------------------------------------------------
{
  const said = (over) => gen.validate({ ...D, ...over }).filter(i => i.param === 'jaw');
  check('asking a capybara to open its jaw is an error, not a silent no-op',
    said({ head: 'capybara', jaw: true }).some(i => i.severity === 'error'),
    JSON.stringify(said({ head: 'capybara', jaw: true })));
  for (const head of ['blunt', 'bug', 'none']) {
    check(`and so is asking a ${head} head`, said({ head, jaw: true }).length === 1);
  }
  for (const head of JAW_HEADS) {
    check(`the same request on a ${head} is fine`, said({ head, jaw: true }).length === 0);
  }
  check('and a capybara with its jaw left shut is not an error', said({ head: 'capybara', jaw: false }).length === 0);
  const capy = build({ head: 'capybara', jaw: true, segments: 4 });
  check('the capybara still builds, head fused, when asked anyway', shellCount(capy) === 4, `${shellCount(capy)}`);
}

// ---------------------------------------------------------------------------
// A small head at a wide clearance cannot hold its jaw: the socket's open
// quadrant is wider than the barrel. Pulled out through that quadrant, forward
// and down in the head's frame, the mandible never touches the skull at
// bodyR 4.5 and catches at 9. validate() has to agree with the pull.
// ---------------------------------------------------------------------------
{
  const c = 0.6;
  const pulledFree = (r) => {
    const rh = HEAD_R * r, g = jawGeometry(rh, c);
    const { cranium, mandible } = splitHead(HEADS.dragon(here(r), { clearance: c }, C), rh, { clearance: c });
    let worst = 0;
    for (let k = 1; k <= 8; k++) {
      const s = k * 0.25 * g.Rk / Math.SQRT2;
      worst = Math.max(worst, intersect(cranium, mandible.clone().translate(-s, 0, s)).volume());
    }
    return worst < 1e-6;
  };
  const jawErr = (bodyR) => gen.validate({ ...D, bodyR, profile: 'flat', head: 'dragon', jaw: true, clearance: c, limbPairs: 0 })
    .some(i => i.param === 'jaw' && i.severity === 'error');
  check('at bodyR 4.5 and 0.6 mm the mandible pulls straight out of the skull', pulledFree(4.5));
  check('and validate() calls that an error', jawErr(4.5));
  check('at bodyR 9 the same pull catches on the skull', !pulledFree(9));
  check('and validate() lets it through', !jawErr(9));
  check('the default clearance holds a jaw on the smallest body', !gen.validate({ ...D, bodyR: 4, head: 'dragon', jaw: true })
    .some(i => i.param === 'jaw'));
}

done();
