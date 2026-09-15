import { suite, check, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, isSolid } from './lib/genconform.mjs';
import gen from '../js/gen/arm.js';
suite('gen arm');
conformance(gen, 'arm');

// --- the quarter turn ------------------------------------------------------
//
// The contract-level claims only. That the twist is REAL — a bore running along
// Y, a face that still mates, a rim that a mating hub can actually reach — is
// measured off the mesh by tools/check-arm-twist.mjs, which is where that kind
// of work belongs.
const c = ctx();
const D = defaults(gen);
const build = (over) => gen.build({ ...D, ...over }, c);
const names = (r) => r.parts.map(p => p.name);
const count = (r, pre) => names(r).filter(n => n === pre || n.startsWith(pre + ' ')).length;

{
  const flat = build({});
  check('planar by default — no standing hubs unless asked for', flat.meta.verticalHubs === 0, `${flat.meta.verticalHubs}`);
  check('and the default set is unchanged: base, two arms, head, three knobs',
    count(flat, 'arm') === 2 && count(flat, 'knob') === 3 && count(flat, 'wrist') === 0 && flat.parts.length === 7,
    names(flat).join(', '));
}

for (const [armCount, armTwist, wrist] of [[2, 1, 0], [1, 0, 1], [3, 3, 2], [1, 1, 1]]) {
  const r = build({ armCount, armTwist, wrist });
  const where = `arms ${armCount}, twisted ${armTwist}, wrists ${wrist}`;
  check(`${where}: ${armTwist + wrist} standing hubs`, r.meta.verticalHubs === armTwist + wrist, `${r.meta.verticalHubs}`);
  // A wrist is a joint, so it brings its own bolt and knob with it.
  check(`${where}: one knob per joint`, count(r, 'knob') === armCount + wrist + 1, `${count(r, 'knob')} knobs`);
  check(`${where}: every part is a closed solid`, r.parts.every(p => {
    try { isSolid(`${where} ${p.name}`, p.mesh); return true; } catch { return false; }
  }));
}

{
  // The standing hub has to sit a clear diameter up, or the disc that bolts to
  // it cannot get past the bar. Reported so it can be checked rather than assumed.
  const r = build({ armTwist: 1 });
  check('the standing hub leaves the mating disc room to arrive', r.meta.hubClear > 0, `${r.meta.hubClear} mm`);
  const flat = build({ part: 'arm', armCount: 1, armTwist: 0 }).parts[0].mesh.bbox();
  const tw = build({ part: 'arm', armCount: 1, armTwist: 1 }).parts[0].mesh.bbox();
  check('a twisted arm stands a hub taller than a flat one',
    tw.size[2] - flat.size[2] > D.hubD * 0.9, `${(tw.size[2] - flat.size[2]).toFixed(1)} mm taller`);
  check('and takes up no more of the plate', tw.size[0] <= flat.size[0] + 1e-6 && tw.size[1] <= flat.size[1] + 1e-6,
    `${tw.size[0].toFixed(1)} x ${tw.size[1].toFixed(1)} vs ${flat.size[0].toFixed(1)} x ${flat.size[1].toFixed(1)}`);
}

{
  const issues = (p) => gen.validate({ ...D, ...p }).map(i => i.param);
  check('asking to twist more arms than exist is clamped, and said so', issues({ armCount: 2, armTwist: 3 }).includes('armTwist'));
  check('twisting exactly as many as exist is not a complaint', !issues({ armCount: 2, armTwist: 2 }).includes('armTwist'));
  check('a planar arm draws no twist warnings', !issues({}).includes('armTwist'));
  const notes = (p) => gen.hints({ ...D, ...p }, c).notes.join(' ');
  check('the overhang under a standing hub is declared, not discovered', /nothing beneath it/.test(notes({ wrist: 1 })));
  check('and not mentioned when there is no standing hub', !/nothing beneath it/.test(notes({})));
}

done();
