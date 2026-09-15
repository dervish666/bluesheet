// Nameplates. The proof that the TrueType parser earned its place: these are
// real outlines, so the checkable claims are typographic ones.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { analyze } from '../js/kernel/validate.js';
import gen from '../js/gen/nameplate.js';

suite('gen nameplate');
conformance(gen, 'nameplate');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- the letters are real outlines ---------------------------------------
{
  // Cap height is measured on FLAT-TOPPED letters. Round letters optically
  // overshoot the cap line — "O" at a 10 mm request measures about 10.29 — and
  // that is correct typography, not a bug. Asserting 10 mm on a string
  // containing O, G, S or C would fail a correct implementation.
  // With no plate the letters are tied together by a rail, so the bounding box is
  // the letters PLUS a constant. Measuring differences removes it and turns the
  // claim into an equality rather than a tolerance.
  const hAt = (capHeight) => build({ text: 'EFHI', capHeight, mode: 'raised', plateShape: 'none' }).bbox().size[1];
  const h8 = hAt(8), h12 = hAt(12), h20 = hAt(20);
  near('raising the cap height by 4 mm makes the letters 4 mm taller', h12 - h8, 4, 0.05);
  near('raising it by 12 mm makes them 12 mm taller', h20 - h8, 12, 0.05);
  check('the rail adds a constant, not a proportion',
    Math.abs((h8 - 8) - (h20 - 20)) < 0.05, `rail adds ${(h8 - 8).toFixed(2)} mm at cap 8 and ${(h20 - 20).toFixed(2)} mm at cap 20`);
  const flat = build({ text: 'EFHI', capHeight: 12, mode: 'raised', plateShape: 'none' });
  const round = build({ text: 'OOOO', capHeight: 12, mode: 'raised', plateShape: 'none' });
  check('round letters overshoot the cap line, as they should',
    round.bbox().size[1] > flat.bbox().size[1] && round.bbox().size[1] < flat.bbox().size[1] * 1.06,
    `flat ${flat.bbox().size[1].toFixed(3)} mm vs round ${round.bbox().size[1].toFixed(3)} mm`);
  const desc = build({ text: 'gjpqy', capHeight: 12, mode: 'raised', plateShape: 'none' });
  check('descenders drop below the baseline',
    desc.bbox().size[1] > flat.bbox().size[1] + 12 * 0.1,
    `${desc.bbox().size[1].toFixed(2)} mm against ${flat.bbox().size[1].toFixed(2)} mm for cap-height-only letters`);
}
{
  // Wider text is wider; letter spacing widens it further.
  const a = build({ text: 'AB', plateShape: 'none', mode: 'raised' });
  const b = build({ text: 'ABCD', plateShape: 'none', mode: 'raised' });
  check('four letters are wider than two', b.bbox().size[0] > a.bbox().size[0] * 1.5,
    `${a.bbox().size[0].toFixed(1)} -> ${b.bbox().size[0].toFixed(1)} mm`);
  const spaced = build({ text: 'ABCD', letterSpacing: 3, plateShape: 'none', mode: 'raised' });
  check('letter spacing widens the run', spaced.bbox().size[0] > b.bbox().size[0] + 6,
    `${b.bbox().size[0].toFixed(1)} -> ${spaced.bbox().size[0].toFixed(1)} mm`);
  // On a plate, where auto-shrink is actually used: the text must fit the plate.
  const auto = build({ text: 'A VERY LONG DOOR SIGN INDEED', autoShrink: true, maxWidth: 90,
                       plateShape: 'rect', plateWidth: 100, mode: 'raised' });
  check('auto-shrink keeps the sign on its plate', auto.bbox().size[0] <= 100.5,
    `${auto.bbox().size[0].toFixed(1)} mm on a 100 mm plate`);
  const unshrunk = build({ text: 'A VERY LONG DOOR SIGN INDEED', autoShrink: false, capHeight: 20,
                           plateShape: 'none', mode: 'raised' });
  const shrunk = build({ text: 'A VERY LONG DOOR SIGN INDEED', autoShrink: true, maxWidth: 60, capHeight: 20,
                         plateShape: 'none', mode: 'raised' });
  check('auto-shrink actually shrinks', shrunk.bbox().size[0] < unshrunk.bbox().size[0],
    `${unshrunk.bbox().size[0].toFixed(1)} -> ${shrunk.bbox().size[0].toFixed(1)} mm`);
}

// ---- every mode, and the one everybody ships broken ----------------------
{
  const modes = gen.params.find(q => q.key === 'mode').options.map(o => o.v);
  check('at least four modes', modes.length >= 4, modes.join(', '));
  for (const mode of modes) {
    const m = build({ mode, text: 'Bluesheet 8' });
    const t = topology(m);
    check(`mode "${mode}" is a closed solid`, t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}`);
  }
  // A stencil with unbridged counters falls apart: the middle of an O, the bowl
  // of an a, the eye of an e are all islands unless something holds them.
  const stencil = build({ mode: 'stencil', text: 'ABOQRabdegopq 0689', capHeight: 14 });
  const st = analyze(stencil);
  check('a stencil of every counter-bearing glyph stays in one piece', st.shells === 1,
    `${st.shells} shells — anything above 1 is a counter that fell out`);
  const raised = build({ mode: 'raised', text: 'OO' });
  const engraved = build({ mode: 'engraved', text: 'OO' });
  check('engraving removes material where raising adds it', engraved.volume() < raised.volume(),
    `raised ${raised.volume().toFixed(0)} vs engraved ${engraved.volume().toFixed(0)} mm³`);
}

// ---- the plate ------------------------------------------------------------
{
  const shapes = gen.params.find(q => q.key === 'plateShape').options.map(o => o.v);
  for (const plateShape of shapes) {
    const m = build({ plateShape });
    const t = topology(m);
    check(`plate shape "${plateShape}" is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0, `bnd ${t.boundary}`);
  }
  // holeDiameter alone does nothing: the hole has to be positioned. That is a
  // sensible default (no hole unless asked) and it caught this test out first.
  const plain = build({ plateShape: 'rect', holePosition: 'none' });
  const holed = build({ plateShape: 'rect', holePosition: 'left', holeDiameter: 5 });
  check('a keyring hole removes material', holed.volume() < plain.volume(),
    `${plain.volume().toFixed(0)} -> ${holed.volume().toFixed(0)} mm³`);
  for (const t of [1.6, 3, 5]) {
    const m = build({ plateShape: 'rect', plateThickness: t, mode: 'engraved' });
    nearPct(`a ${t} mm plate is ${t} mm thick`, m.bbox().size[2], t, 3);
  }
}

// ---- it refuses what it cannot make --------------------------------------
{
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  const tooDeep = gen.validate({ ...defaults(gen), mode: 'engraved', plateThickness: 1.2, engraveDepth: 3 });
  check('engraving deeper than the plate is rejected', tooDeep.length > 0,
    tooDeep.length ? tooDeep[0].message.slice(0, 90) : 'nothing reported');
  const empty = build({ text: '   ' });
  check('a blank string still produces a printable plate rather than nothing',
    empty && empty.triCount > 8 && empty.volume() > 0, `${empty?.triCount} triangles`);
  const h = gen.hints(defaults(gen));
  check('hints() carries real advice', (h.notes || []).some(n => n.length > 40), (h.notes || [])[0]?.slice(0, 80));
}

// ---- dimension callouts: pinned to the features they measure ---------------
{
  const C0 = ctx('normal');
  const r = gen.build(defaults(gen), C0);
  const dims = r.meta.dims || [];
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const T = defaults(gen).plateThickness;
  const thick = dims.find(d => d.param === 'plateThickness');
  check('plateThickness callout exists, measures the plate, and stands on its front edge',
    !!thick && Math.abs(len(thick) - T) < 1e-6 && Math.abs(thick.from[2]) < 1e-6 && Math.abs(thick.to[2] - T) < 1e-6
      && Math.abs(thick.from[1] - r.mesh.bbox().min[1]) < 1e-6,
    thick ? `${len(thick).toFixed(3)} mm from z=${thick.from[2]} at y=${thick.from[1].toFixed(2)}` : 'missing');
  const relief = dims.find(d => d.param === 'reliefHeight');
  check('reliefHeight callout runs from the plate top to the letter top on a letter',
    !!relief && Math.abs(len(relief) - defaults(gen).reliefHeight) < 1e-6
      && Math.abs(relief.from[2] - T) < 1e-6 && Math.abs(relief.to[2] - r.mesh.bbox().max[2]) < 1e-6,
    relief ? `${len(relief).toFixed(3)} mm, z ${relief.from[2]} -> ${relief.to[2].toFixed(3)}` : 'missing');
  // A tag with a hole: the diameter callout spans the hole, centred where the hole was cut.
  const tagP = { ...defaults(gen), ...gen.presets.find(pr => pr.name === 'Keyring tag').values };
  const tag = gen.build(tagP, C0);
  const hole = (tag.meta.dims || []).find(d => d.param === 'holeDiameter');
  const kh = tag.meta.keyringHole;
  check('holeDiameter callout spans the keyring hole through its centre',
    !!hole && !!kh && Math.abs(len(hole) - tagP.holeDiameter) < 1e-6
      // The tag outline spans ±w/2, so the placed frame is the plan frame here.
      && Math.abs((hole.from[0] + hole.to[0]) / 2 - kh.x) < 1e-6 && Math.abs(hole.from[1] - kh.y) < 1e-6
      && Math.abs(hole.from[1] - hole.to[1]) < 1e-9,
    hole ? `${len(hole).toFixed(2)} mm at x=${((hole.from[0] + hole.to[0]) / 2).toFixed(2)} (hole cut at ${kh && kh.x.toFixed(2)})` : 'missing');
}

done();
