// Coasters and trivets. Simple enough that the only way to make it interesting is
// to make it exact, so these check the numbers rather than the look.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { analyze } from '../js/kernel/validate.js';
import gen from '../js/gen/coaster.js';

suite('gen coaster');
conformance(gen, 'coaster');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- the size you asked for ----------------------------------------------
{
  for (const size of [70, 95, 130]) {
    const m = build({ size, outline: 'circle' });
    nearPct(`a ${size} mm coaster measures ${size} mm across`, Math.max(m.bbox().size[0], m.bbox().size[1]), size, 1);
  }
  for (const baseThickness of [2, 3.2, 5]) {
    const m = build({ baseThickness, lipHeight: 0, surface: 'none', text: '' });
    nearPct(`a ${baseThickness} mm base is ${baseThickness} mm thick`, m.bbox().size[2], baseThickness, 4);
  }
  const flat = build({ lipHeight: 0 }), lipped = build({ lipHeight: 4 });
  check('a lip makes it taller', lipped.bbox().size[2] > flat.bbox().size[2] + 3,
    `${flat.bbox().size[2].toFixed(2)} -> ${lipped.bbox().size[2].toFixed(2)} mm`);
  check('a lip adds material', lipped.volume() > flat.volume(),
    `${flat.volume().toFixed(0)} -> ${lipped.volume().toFixed(0)} mm³`);
}

// ---- every outline and every surface -------------------------------------
{
  for (const outline of gen.params.find(q => q.key === 'outline').options.map(o => o.v)) {
    const m = build({ outline });
    const t = topology(m);
    check(`outline "${outline}" is a closed solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}`);
  }
  for (const surface of gen.params.find(q => q.key === 'surface').options.map(o => o.v)) {
    const m = build({ surface });
    const t = topology(m);
    check(`surface "${surface}" is a closed solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}`);
  }
  const plain = build({ surface: 'none' });
  const patterned = build({ surface: 'rings', grooveDepth: 1 });
  check('a surface pattern removes material', patterned.volume() < plain.volume(),
    `${plain.volume().toFixed(0)} -> ${patterned.volume().toFixed(0)} mm³`);
}

// ---- engraving is actually recessed --------------------------------------
{
  const blank = build({ text: '', surface: 'none' });
  const cut = build({ text: 'CHEERS', engraveDepth: 1, surface: 'none' });
  check('engraved text removes material', cut.volume() < blank.volume(),
    `${blank.volume().toFixed(0)} -> ${cut.volume().toFixed(0)} mm³`);
  const deep = build({ text: 'CHEERS', engraveDepth: 2, surface: 'none' });
  check('deeper engraving removes more', deep.volume() < cut.volume(),
    `1 mm ${cut.volume().toFixed(0)} vs 2 mm ${deep.volume().toFixed(0)} mm³`);
  check('engraving does not change the outside dimensions',
    Math.abs(cut.bbox().size[0] - blank.bbox().size[0]) < 0.01,
    `${blank.bbox().size[0].toFixed(3)} vs ${cut.bbox().size[0].toFixed(3)} mm`);
  // Text over a surface pattern is the case that used to leave the top face open:
  // the clear-zone cut puts a point on the groove that the cap did not have.
  const both = build({ text: 'CHEERS', surface: 'rings', engraveDepth: 1 });
  const t = topology(both);
  check('engraving on top of a surface pattern still closes',
    t.boundary === 0 && t.nonManifold === 0, `bnd ${t.boundary}, nm ${t.nonManifold}`);
}

// ---- the trivet is a different object, not a bigger coaster --------------
{
  const trivet = build({ variant: 'trivet' });
  const t = topology(trivet);
  check('the trivet is a closed solid', t.boundary === 0 && t.inconsistent === 0 && trivet.volume() > 0, `bnd ${t.boundary}`);
  check('the trivet is one connected piece, not a scatter of bars',
    analyze(trivet).shells === 1, `${analyze(trivet).shells} shells`);
  const coaster = build({ variant: 'coaster' });
  check('the trivet is genuinely a different shape', Math.abs(trivet.volume() - coaster.volume()) > 100,
    `${coaster.volume().toFixed(0)} vs ${trivet.volume().toFixed(0)} mm³`);
}

// ---- what it refuses ------------------------------------------------------
{
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  const tooDeep = gen.validate({ ...defaults(gen), baseThickness: 2, engraveDepth: 3, text: 'X' });
  check('engraving deeper than the base is caught', tooDeep.length > 0,
    tooDeep.length ? tooDeep[0].message.slice(0, 100) : 'nothing reported');
  const h = gen.hints(defaults(gen));
  check('hints() carries real advice', (h.notes || []).some(n => n.length > 40), (h.notes || [])[0]?.slice(0, 80));
}

done();
