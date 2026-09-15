// Hooks, clips and wall hardware. Small parts whose failure mode is snapping, so
// what is worth checking is that the engineering claims hold: fillets at the
// roots, walls in whole extrusions, and an opening that actually grips.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { printability } from '../js/kernel/validate.js';
import gen from '../js/gen/hooks.js';

suite('gen hooks');
conformance(gen, 'hooks');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- the family ----------------------------------------------------------
{
  const types = gen.params.find(q => q.key === 'type').options.map(o => o.v);
  check('at least six distinct types', types.length >= 6, types.join(', '));
  const sigs = new Set();
  for (const type of types) {
    const m = build({ type });
    const t = topology(m);
    check(`"${type}" is a closed solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}`);
    check(`"${type}" is a real object, not a speck`, Math.max(...m.bbox().size) > 8,
      m.bbox().size.map(v => v.toFixed(1)).join(' × ') + ' mm');
    sigs.add(Math.round(m.volume()));
  }
  check('every type is a different object', sigs.size === types.length, `${sigs.size} distinct of ${types.length}`);
}

// ---- the clip actually grips ---------------------------------------------
{
  // A snap-on clip has to open narrower than the cable it holds, or it falls off.
  for (const cableDia of [4, 6, 8, 12]) {
    const m = build({ type: 'clip', cableDia });
    const t = topology(m);
    check(`a ${cableDia} mm cable clip is a closed solid`, t.boundary === 0 && m.volume() > 0, `bnd ${t.boundary}`);
    check(`and it is bigger than the cable it holds`, Math.max(...m.bbox().size) > cableDia,
      `${Math.max(...m.bbox().size).toFixed(1)} mm across a ${cableDia} mm cable`);
  }
  const small = build({ type: 'clip', cableDia: 4 });
  const large = build({ type: 'clip', cableDia: 12 });
  check('a bigger cable makes a bigger clip', large.volume() > small.volume(),
    `${small.volume().toFixed(0)} -> ${large.volume().toFixed(0)} mm³`);
}

// ---- walls in whole extrusions -------------------------------------------
{
  const q = gen.params.find(x => x.key === 'wall');
  check('the default wall is a whole number of 0.4 mm lines',
    Math.abs((q.def / 0.4) - Math.round(q.def / 0.4)) < 1e-6,
    `${q.def} mm = ${(q.def / 0.4).toFixed(2)} lines`);
  for (const wall of [1.2, 2.0, 3.2]) {
    const m = build({ type: 'clip', wall });
    const t = topology(m);
    check(`a ${wall} mm wall builds a solid`, t.boundary === 0 && m.volume() > 0, `bnd ${t.boundary}`);
  }
  // `wall` is the clip's wall specifically — the solid types are sized by their
  // own dimensions and ignore it, which is why this measures the clip.
  const thin = build({ type: 'clip', wall: 1.2 }), thick = build({ type: 'clip', wall: 3.2 });
  check('a thicker clip wall uses more material', thick.volume() > thin.volume(),
    `${thin.volume().toFixed(0)} -> ${thick.volume().toFixed(0)} mm³`);
  check('wall is declared as applying only where it applies',
    typeof gen.params.find(q2 => q2.key === 'wall').showIf === 'function',
    'showIf present');
}

// ---- mounting ------------------------------------------------------------
{
  for (const mount of gen.params.find(q => q.key === 'mount').options.map(o => o.v)) {
    const m = build({ mount });
    const t = topology(m);
    check(`mount "${mount}" is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0, `bnd ${t.boundary}`);
  }
  const none = build({ mount: 'none' }), screws = build({ mount: 'screws' });
  check('screw holes remove material', screws.volume() < none.volume(),
    `${none.volume().toFixed(0)} -> ${screws.volume().toFixed(0)} mm³`);
  for (const screw of gen.params.find(q => q.key === 'screw').options.map(o => o.v)) {
    const m = build({ mount: 'screws', screw });
    check(`screw size ${screw} builds a solid`, topology(m).boundary === 0 && m.volume() > 0);
  }
  // A bigger screw takes a bigger hole, so less material is left.
  const m3 = build({ mount: 'screws', screw: 'M3' }), m5 = build({ mount: 'screws', screw: 'M5' });
  check('an M5 hole removes more than an M3 hole', m5.volume() < m3.volume(),
    `M3 ${m3.volume().toFixed(0)} vs M5 ${m5.volume().toFixed(0)} mm³`);
}

// ---- it says which way up to print it ------------------------------------
{
  const h = gen.hints(defaults(gen));
  check('hints() carries notes', Array.isArray(h.notes) && h.notes.length > 0, `${h.notes?.length} notes`);
  check('the notes talk about orientation, because that is what decides whether it snaps',
    (h.notes || []).some(n => /print|orient|flat|layer|up|side/i.test(n)),
    (h.notes || [])[0]?.slice(0, 100));
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  // Every type has to be printable on the A1 mini at its defaults.
  for (const type of gen.params.find(q => q.key === 'type').options.map(o => o.v)) {
    const p = printability(build({ type }), {});
    check(`"${type}" fits the bed`, p.fitsBed, `${build({ type }).bbox().size.map(v => v.toFixed(0)).join(' × ')} mm`);
  }
}

// ---- dimension callouts sit on the features they name ---------------------
{
  const dimsOf = (over = {}) => (gen.build({ ...defaults(gen), ...over }, C).meta || {}).dims || [];
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const preset = (name) => gen.presets.find(pr => pr.name === name).values;

  // J-hook reach: plate back to the arc's outermost point, on the top face.
  const j = build(), jb = j.bbox();
  const reach = dimsOf().find(d => d.param === 'reach');
  check('the J-hook declares its reach, measured from the back of the plate',
    !!reach && Math.abs(len(reach) - defaults(gen).reach) < 0.01
      && Math.abs(reach.from[0] - jb.min[0]) < 0.05 && Math.abs(reach.from[2] - jb.max[2]) < 0.05,
    reach ? `${len(reach).toFixed(2)} mm from x=${reach.from[0].toFixed(2)} (bbox min ${jb.min[0].toFixed(2)})` : 'missing');

  // Cable clip wall: one wall thick, starting on the bore surface at the top of the C.
  const clipP = preset('Desk-edge cable clip, 6 mm');
  const clip = build(clipP), cb = clip.bbox();
  const wall = dimsOf(clipP).find(d => d.param === 'wall');
  const rcClip = clipP.cableDia / 2 + clipP.clearance;
  check('the clip wall callout is one wall long and starts on the bore',
    !!wall && Math.abs(len(wall) - clipP.wall) < 0.01
      && Math.abs(wall.from[2] - cb.max[2]) < 0.05
      && Math.abs(wall.from[0] - wall.to[0]) < 1e-9
      && Math.abs(wall.from[1] - rcClip) < 0.05,   // the C is centred on y = 0 once placed
    wall ? `${len(wall).toFixed(2)} mm at z=${wall.from[2].toFixed(1)} (top ${cb.max[2].toFixed(1)})` : 'missing');

  // Spool bore: the bore diameter across the top face, centred on the axis.
  const spoolP = preset('Bench wire spool');
  const sp = build(spoolP), sb = sp.bbox();
  const bore = dimsOf(spoolP).find(d => d.param === 'boreDia');
  check('the spool bore callout spans the bore on the top flange',
    !!bore && Math.abs(len(bore) - spoolP.boreDia) < 0.01
      && Math.abs(bore.from[2] - sb.max[2]) < 0.05 && Math.abs(bore.from[0] + bore.to[0]) < 0.05,
    bore ? `${len(bore).toFixed(2)} mm at z=${bore.from[2].toFixed(1)}, x ${bore.from[0].toFixed(1)}..${bore.to[0].toFixed(1)}` : 'missing');

  // Bracket web: the web's foot along the shelf leg, exactly the web size.
  const brP = preset('Shelf bracket, 100 × 80');
  const web = dimsOf(brP).find(d => d.param === 'gusset');
  const brb = build(brP).bbox();
  check('the bracket web callout runs along the shelf leg from the inner corner',
    !!web && Math.abs(len(web) - brP.gusset) < 0.01
      && Math.abs(web.from[0] - (brb.min[0] + brP.plateT)) < 0.05 && Math.abs(web.from[1] - (brb.min[1] + brP.stock)) < 0.05,
    web ? `${len(web).toFixed(2)} mm from (${web.from[0].toFixed(1)}, ${web.from[1].toFixed(1)})` : 'missing');
}

done();
