// Gears. The most checkable generator in the catalogue: the tooth profile is a
// closed-form curve and the standard proportions are arithmetic, so there is no
// excuse for a tolerance where an equality belongs.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import gen from '../js/gen/gear.js';

suite('gen gear');
conformance(gen, 'gear');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));
const DEG = 180 / Math.PI;

// ---- the standard proportions --------------------------------------------
{
  for (const [module_, teeth] of [[1, 20], [1.5, 17], [2, 30], [0.8, 40]]) {
    const m = build({ kind: 'spur', module: module_, teeth, bore: 'none', web: 'solid', boss: false, helix: 'straight' });
    const d = m.bbox().size[0];
    // Outside diameter = pitch diameter + 2 * addendum = m(z + 2).
    nearPct(`module ${module_}, ${teeth} teeth: outside diameter is m(z+2) = ${(module_ * (teeth + 2)).toFixed(2)} mm`,
      d, module_ * (teeth + 2), 1.5);
  }
}
{
  const m = build({ kind: 'spur', module: 2, teeth: 24, faceWidth: 8, bore: 'none', web: 'solid', boss: false });
  nearPct('face width is the requested thickness', m.bbox().size[2], 8, 0.5);
  const wide = build({ kind: 'spur', module: 2, teeth: 24, faceWidth: 16, bore: 'none', web: 'solid', boss: false });
  nearPct('doubling the face width doubles the volume', wide.volume(), m.volume() * 2, 1.5);
}

// ---- teeth are actually there, and there are the right number of them -----
{
  // Sample the outline radius against angle at the mid-plane and count upward
  // crossings of the mid-radius. Counting local maxima instead sounds simpler
  // and is not: a discretised flank has plateaus and noise, and every one of
  // them reads as a maximum.
  const teeth = 19;
  const m = build({ kind: 'spur', module: 2, teeth, bore: 'none', web: 'solid', boss: false, helix: 'straight', faceWidth: 6 });
  const zMid = m.bbox().center[2];
  // No binning: collect (angle, radius) for the mid-plane vertices, sort by
  // angle, and walk it. Binning at any resolution fine enough to resolve a tooth
  // leaves empty bins on a discretised flank, and an empty bin reads as a root.
  const pts = [];
  for (let v = 0; v < m.vertCount; v++) {
    const [x, y, z] = m.vertex(v);
    if (Math.abs(z - zMid) > 3.1) continue;
    pts.push([Math.atan2(y, x), Math.hypot(x, y)]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const radii = pts.map(p => p[1]);
  const lo = Math.min(...radii), hi = Math.max(...radii);
  const mid = (lo + hi) / 2;
  let crossings = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = radii[i], c = radii[(i + 1) % pts.length];
    if (a < mid && c >= mid) crossings++;
  }
  check(`a ${teeth}-tooth gear crosses its mid-radius ${teeth} times going outward`,
    crossings === teeth, `counted ${crossings} over ${pts.length} rim points, root ${lo.toFixed(2)} mm, tip ${hi.toFixed(2)} mm`);
  nearPct('the tip radius is m(z+2)/2', hi, 2 * (teeth + 2) / 2, 1.5);
  // Dedendum is 1.25 m below the pitch circle, so the root radius is m(z-2.5)/2.
  nearPct('the root radius is m(z-2.5)/2', lo, 2 * (teeth - 2.5) / 2, 4);
}

// ---- the family ----------------------------------------------------------
{
  for (const kind of ['spur', 'ring', 'rack', 'planetary']) {
    const m = build({ kind });
    const t = topology(m);
    check(`${kind} builds as a closed solid`, t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}, vol ${m.volume().toFixed(0)}`);
  }
  const rack = build({ kind: 'rack' });
  check('a rack is long and flat, not round', rack.bbox().size[0] / rack.bbox().size[1] > 2,
    rack.bbox().size.map(v => v.toFixed(1)).join(' × '));
}

// ---- bores, and the boss that was wound backwards -------------------------
{
  for (const bore of ['none', 'round', 'd-flat', 'keyway', 'hex']) {
    const m = build({ bore, boss: true });
    const t = topology(m);
    check(`bore "${bore}" with a set-screw boss stays correctly wound`,
      t.inconsistent === 0 && t.boundary === 0 && m.volume() > 0,
      `wind ${t.inconsistent}, bnd ${t.boundary}`);
  }
  // The boss is a hole in the top face; its ring is reversed and its index array
  // must be reversed with it. When it was not, the solid stayed closed and only
  // the winding and the volume gave it away — so assert the volume too.
  const withBoss = build({ bore: 'round', boss: true, bossHeight: 8 });
  const without = build({ bore: 'round', boss: false });
  check('adding a boss adds volume rather than subtracting it',
    withBoss.volume() > without.volume(),
    `${without.volume().toFixed(0)} -> ${withBoss.volume().toFixed(0)} mm³`);
  const bored = build({ bore: 'round', boreDia: 8, boss: false, web: 'solid' });
  const solid = build({ bore: 'none', boss: false, web: 'solid' });
  check('a bore removes material', bored.volume() < solid.volume(),
    `${solid.volume().toFixed(0)} -> ${bored.volume().toFixed(0)} mm³`);
}

// ---- helical and herringbone ---------------------------------------------
{
  const straight = build({ helix: 'straight', faceWidth: 10 });
  const helical = build({ helix: 'helical', helixAngle: 20, faceWidth: 10 });
  const herring = build({ helix: 'herringbone', helixAngle: 20, faceWidth: 10 });
  check('helical teeth change the mesh', helical.triCount !== straight.triCount || Math.abs(helical.volume() - straight.volume()) > 1);
  check('herringbone differs from plain helical', Math.abs(herring.volume() - helical.volume()) > 1 || herring.triCount !== helical.triCount);
  for (const [n, m] of [['helical', helical], ['herringbone', herring]]) {
    const t = topology(m);
    check(`${n} is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0, `bnd ${t.boundary}, wind ${t.inconsistent}`);
  }
}

// ---- what it refuses -----------------------------------------------------
{
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  // Undercut: below about 17 teeth at 20 degrees a standard tooth is undercut
  // unless the profile is shifted. The generator must say so rather than
  // silently making a weak gear.
  const low = gen.validate({ ...defaults(gen), kind: 'spur', teeth: 8, pressureAngle: '20', shift: 0 });
  check('an 8-tooth gear at 20° is reported as undercut', low.length > 0,
    low.length ? low[0].message.slice(0, 90) : 'nothing reported');
  // A planetary set only assembles when ring = sun + 2*planet.
  const bad = gen.validate({ ...defaults(gen), kind: 'planetary', sunTeeth: 20, planetTeeth: 15, ringTeeth: 41 });
  check('an impossible planetary set is rejected with the arithmetic', bad.length > 0,
    bad.length ? bad[0].message.slice(0, 100) : 'nothing reported');
  const good = gen.validate({ ...defaults(gen), kind: 'planetary', sunTeeth: 20, planetTeeth: 15, ringTeeth: 50, planetCount: 5 });
  check('a valid planetary set is accepted', !good.some(i => i.severity === 'error'),
    JSON.stringify(good).slice(0, 90));
}

// ---- hints say something a person can act on -----------------------------
{
  const h = gen.hints(defaults(gen));
  check('hints() carries notes', Array.isArray(h.notes) && h.notes.length > 0, `${h.notes?.length} notes`);
  check('the notes are sentences, not labels', h.notes.every(n => n.length > 30), h.notes[0]?.slice(0, 80));
}
// ---- dimension callouts cover every kind ------------------------------------
{
  const d = defaults(gen);
  const declared = (over) => new Set(gen.build({ ...d, ...over }, ctx).meta.dims.map(x => x.param));
  const has = (name, over, want) => {
    const got = declared(over);
    const missing = want.filter(k => !got.has(k));
    check(`${name} declares callouts for ${want.join(', ')}`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${got.size} dims`);
  };
  has('a spur gear', {}, ['faceWidth', 'rimWidth', 'hubDia', 'boreDia']);
  has('a keyed bore', { bore: 'keyway' }, ['keyWidth', 'keyDepth']);
  has('a D-flat bore', { bore: 'd-flat' }, ['flatDepth']);
  has('a bossed pinion with a set screw', { boss: true, setScrew: true }, ['bossDia', 'bossHeight', 'setScrewDia']);
  has('a ring gear', { kind: 'ring' }, ['faceWidth', 'rimWidth']);
  has('a rack', { kind: 'rack' }, ['rackBase', 'faceWidth', 'rackHoleDia']);
  has('a planetary set', { kind: 'planetary' }, ['faceWidth', 'rimWidth', 'boreDia']);
  check('a solid gear with no bore declares no bore callout', !declared({ bore: 'none' }).has('boreDia'));
}

done();
