// Drawer organisers. The generator that turns a tape measure into an object, so
// the claims worth checking are dimensional ones.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { printability } from '../js/kernel/validate.js';
import gen from '../js/gen/drawer.js';

suite('gen drawer');
conformance(gen, 'drawer');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- it fits the space it was measured for -------------------------------
{
  for (const [w, d, h] of [[120, 90, 40], [160, 60, 25], [80, 80, 55]]) {
    const m = build({ drawerW: w, drawerD: d, height: h, clearance: 0, layoutMode: 'grid', arrange: 'assembled' });
    const s = m.bbox().size;
    check(`a ${w}×${d}×${h} organiser is no bigger than the space`,
      s[0] <= w + 0.01 && s[1] <= d + 0.01 && s[2] <= h + 0.01,
      s.map(v => v.toFixed(2)).join(' × ') + ' mm');
    nearPct(`and it uses the height it was given`, s[2], h, 1);
  }
  const tight = build({ drawerW: 120, drawerD: 90, clearance: 0, arrange: 'assembled' });
  const slack = build({ drawerW: 120, drawerD: 90, clearance: 1.5, arrange: 'assembled' });
  check('clearance shrinks the part by twice itself on each axis',
    Math.abs((tight.bbox().size[0] - slack.bbox().size[0]) - 3) < 0.05,
    `${tight.bbox().size[0].toFixed(2)} -> ${slack.bbox().size[0].toFixed(2)} mm`);
}

// ---- the cells are the cells you asked for -------------------------------
{
  for (const [rows, cols] of [[1, 1], [2, 3], [3, 3], [1, 6], [4, 2]]) {
    const m = build({ layoutMode: 'grid', rows, cols, arrange: 'assembled' });
    const t = topology(m);
    check(`a ${rows}×${cols} grid is a closed solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}`);
  }
  // More cells means more dividers means more material in the same envelope.
  const few = build({ layoutMode: 'grid', rows: 1, cols: 1, arrange: 'assembled', bottom: 'solid' });
  const many = build({ layoutMode: 'grid', rows: 4, cols: 4, arrange: 'assembled', bottom: 'solid' });
  check('a 4×4 grid uses more material than a single tray',
    many.volume() > few.volume(), `${few.volume().toFixed(0)} -> ${many.volume().toFixed(0)} mm³`);
}

// ---- the options that make it useful -------------------------------------
{
  const solid = build({ bottom: 'solid', arrange: 'assembled' });
  const open = build({ bottom: 'open', arrange: 'assembled' });
  check('an open bottom uses less material than a solid one',
    open.volume() < solid.volume(), `${solid.volume().toFixed(0)} vs ${open.volume().toFixed(0)} mm³`);
  for (const layoutMode of gen.params.find(q => q.key === 'layoutMode').options.map(o => o.v)) {
    const m = build({ layoutMode, arrange: 'assembled' });
    const t = topology(m);
    check(`layout mode "${layoutMode}" is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0, `bnd ${t.boundary}`);
  }
  const noScoop = build({ scoopDepth: 0, arrange: 'assembled' });
  const scooped = build({ scoopDepth: 8, scoopWidth: 20, arrange: 'assembled' });
  check('finger scoops remove material from the front', scooped.volume() < noScoop.volume(),
    `${noScoop.volume().toFixed(0)} -> ${scooped.volume().toFixed(0)} mm³`);
}

// ---- splitting something bigger than the bed -----------------------------
{
  // 240 mm will not fit a 180 mm plate. Split mode has to produce pieces that do.
  const big = build({ drawerW: 240, drawerD: 90, splitX: 2, arrange: 'plate' });
  const t = topology(big);
  check('a split organiser is still a closed solid', t.boundary === 0 && t.inconsistent === 0 && big.volume() > 0,
    `bnd ${t.boundary}, wind ${t.inconsistent}`);
  // Splitting one axis is not enough to make the PLATE fit, only the pieces —
  // and that is fine as long as the tool says so. printability() answers it from
  // the built mesh, which is the only place that can: whether the arrangement
  // fits depends on how the parts were packed, not on the parameters.
  const oneAxis = printability(big, {});
  check('one-axis split: the plate is honestly reported as too big',
    oneAxis.fitsBed === false && (oneAxis.warnings || []).some(w => /too deep|too wide/.test(w.message)),
    (oneAxis.warnings || []).find(w => /too deep|too wide/.test(w.message))?.message.slice(0, 110));
  const bothAxes = build({ drawerW: 240, drawerD: 90, splitX: 2, splitY: 2, arrange: 'plate' });
  check('splitting both axes gives a plate that does fit',
    printability(bothAxes, {}).fitsBed === true,
    bothAxes.bbox().size.map(v => v.toFixed(0)).join(' × ') + ' mm');
  for (const joint of gen.params.find(q => q.key === 'joint').options.map(o => o.v)) {
    const m = build({ drawerW: 240, splitX: 2, joint, arrange: 'plate' });
    const jt = topology(m);
    check(`joint "${joint}" is a closed solid`, jt.boundary === 0 && jt.inconsistent === 0 && m.volume() > 0, `bnd ${jt.boundary}`);
  }
}

// ---- what it refuses ------------------------------------------------------
{
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  const impossible = gen.validate({ ...defaults(gen), drawerW: 40, wallT: 12, cols: 4 });
  check('walls that leave no room inside are rejected', impossible.length > 0,
    impossible.length ? impossible[0].message.slice(0, 100) : 'nothing reported');
  // The outside corner radius is clamped to what the wall can carry — above
  // 2.5x the wall thickness the corner construction self-intersects and the
  // result stops being a solid. Clamping is right; saying nothing would not be.
  for (const cornerR of [6, 8, 12, 16]) {
    const m = build({ cornerR });
    const t = topology(m);
    check(`an over-large ${cornerR} mm corner radius still builds a solid`,
      t.boundary === 0 && t.nonManifold === 0 && m.volume() > 0, `bnd ${t.boundary}, nm ${t.nonManifold}`);
  }
  const clamped = gen.validate({ ...defaults(gen), cornerR: 12 });
  check('and the person is told their radius was clamped, with the fix',
    clamped.some(i => i.param === 'cornerR' && /thicker wall/.test(i.message)),
    clamped.find(i => i.param === 'cornerR')?.message.slice(0, 110));
  const h = gen.hints(defaults(gen));
  check('hints() carries real advice', (h.notes || []).some(n => n.length > 40), (h.notes || [])[0]?.slice(0, 80));
}

// ---- dimension callouts sit on the features they name ----------------------
{
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const dimsOf = (over = {}) => gen.build({ ...defaults(gen), ...over }, C).meta.dims;
  const d0 = dimsOf();
  const W = 150 - 1, D = 100 - 1;                       // 0.5 mm clearance a side
  const wall = d0.find(d => d.param === 'wallT');
  check('the wall callout crosses the left wall from the outside to the first compartment, 1.6 mm',
    !!wall && eq(wall.from[0], -W / 2) && eq(wall.to[0], -W / 2 + 1.6) && eq(wall.from[1], wall.to[1]),
    wall ? `${wall.from} → ${wall.to}` : 'missing');
  const scoop = d0.find(d => d.param === 'scoopDepth');
  check('the scoop callout drops 8 mm from the rim down the front face',
    !!scoop && eq(scoop.from[1], -D / 2) && eq(scoop.to[1], -D / 2) && eq(scoop.to[2], 30) && eq(scoop.to[2] - scoop.from[2], 8),
    scoop ? `${scoop.from} → ${scoop.to}` : 'missing');
  const two = gen.presets.find(pr => /prints in two/.test(pr.name)).values;
  const r = gen.build({ ...defaults(gen), ...two }, C);
  const tenon = r.meta.dims.find(d => d.param === 'jointDepth');
  const bb = asMesh(r).bbox();
  const inside = (q) => [0, 1, 2].every(ax => q[ax] >= bb.min[ax] - 0.01 && q[ax] <= bb.max[ax] + 0.01);
  check('on the split tray the tenon callout is 2.5 mm long and lands inside the packed plate',
    !!tenon && eq(Math.hypot(tenon.to[0] - tenon.from[0], tenon.to[1] - tenon.from[1], tenon.to[2] - tenon.from[2]), 2.5)
    && inside(tenon.from) && inside(tenon.to) && eq(tenon.from[2], 22.5),
    tenon ? `${tenon.from.map(v => v.toFixed(2))} → ${tenon.to.map(v => v.toFixed(2))}` : 'missing');
}

done();
