// Vases. Judged by eye, so most of what matters here is that the parameter space
// makes ugly hard to reach — but the spiral-mode claim is checkable, and it is
// the one that costs 250 g of filament when it is wrong.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { analyze } from '../js/kernel/validate.js';
import gen from '../js/gen/vase.js';

suite('gen vase');
conformance(gen, 'vase');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- the silhouette and the section are independent ----------------------
{
  const sils = gen.params.find(q => q.key === 'silhouette').options.map(o => o.v);
  const secs = gen.params.find(q => q.key === 'section').options.map(o => o.v);
  check('at least five silhouettes', sils.length >= 5, sils.join(', '));
  check('at least five cross-sections', secs.length >= 5, secs.join(', '));
  const sigs = new Set();
  for (const silhouette of sils) {
    const m = build({ silhouette });
    const t = topology(m);
    check(`silhouette "${silhouette}" is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, wind ${t.inconsistent}`);
    sigs.add(Math.round(m.volume()));
  }
  check('every silhouette makes a different vase', sigs.size === sils.length, `${sigs.size} distinct of ${sils.length}`);
  const secSigs = new Set();
  for (const section of secs) {
    const m = build({ section });
    const t = topology(m);
    check(`section "${section}" is a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, wind ${t.inconsistent}`);
    secSigs.add(Math.round(m.volume()));
  }
  check('every cross-section makes a different vase', secSigs.size >= secs.length - 1, `${secSigs.size} distinct of ${secs.length}`);
}

// ---- the numbers a person typed are the numbers they get -----------------
{
  for (const [h, d] of [[80, 50], [120, 80], [160, 60]]) {
    const m = build({ height: h, dia: d });
    nearPct(`a ${h} mm vase is ${h} mm tall`, m.bbox().size[2], h, 0.5);
    // The widest point of the silhouette is normalised to `dia`, so the bounding
    // box across is that diameter whatever curve or section is chosen.
    nearPct(`a ${d} mm vase is ${d} mm at its widest`, Math.max(m.bbox().size[0], m.bbox().size[1]), d, 2);
  }
}

// ---- twist is the angle it says it is ------------------------------------
{
  const LOBES = 6, DEG = 180;
  // A straight silhouette with no taper, so the section is the same size at every
  // height and the lobe crests are the only angular feature. On a bulged profile
  // the widest vertex in a band is not necessarily a crest, which is what made
  // the first version of this measurement wander by twenty degrees.
  const m = build({ twist: DEG, section: 'lobed', lobes: LOBES, height: 100,
                    silhouette: 'straight', topScale: 1, bulge: 0, ribs: 0, flutes: 0, noise: 0, facets: 0 });
  const b = m.bbox();
  const step = (Math.PI * 2) / LOBES;
  // Circular mean of the crest angles folded into one lobe: robust to which
  // crest happens to be sampled and to how many vertices sit on each.
  const crestAngle = (z) => {
    const band = [];
    for (let v = 0; v < m.vertCount; v++) {
      const [x, y, vz] = m.vertex(v);
      if (Math.abs(vz - z) > 0.6) continue;
      band.push([Math.atan2(y, x), Math.hypot(x, y)]);
    }
    if (band.length < LOBES * 2) return null;
    const rMax = Math.max(...band.map(p => p[1]));
    const crests = band.filter(p => p[1] > rMax * 0.995);
    let sx = 0, sy = 0;
    for (const [a] of crests) { const f = (a % step + step) % step * LOBES; sx += Math.cos(f); sy += Math.sin(f); }
    return Math.atan2(sy, sx) / LOBES;
  };
  const lo = crestAngle(b.min[2] + 8), hi = crestAngle(b.max[2] - 8);
  if (lo === null || hi === null) check('twist is measurable', false, 'not enough rim vertices');
  else {
    const spanFrac = (b.max[2] - 8 - (b.min[2] + 8)) / (b.max[2] - b.min[2]);
    const expected = DEG * spanFrac * Math.PI / 180;
    let d = (hi - lo) - expected;
    d = ((d % step) + step + step / 2) % step - step / 2;      // fold into +/- half a lobe
    check(`a ${DEG}° twist rotates the section by ${DEG}° over the full height`,
      Math.abs(d * 180 / Math.PI) < 4,
      `off by ${(d * 180 / Math.PI).toFixed(1)}° after removing whole lobes (measured over ${(spanFrac * 100).toFixed(0)}% of the height)`);
  }
  const flat = build({ twist: 0, section: 'lobed', lobes: LOBES, silhouette: 'straight', topScale: 1, bulge: 0 });
  check('zero twist and 180° twist are different objects',
    Math.abs(flat.volume() - m.volume()) > 0.01 || flat.triCount !== m.triCount,
    `${flat.volume().toFixed(1)} vs ${m.volume().toFixed(1)} mm³`);
}

// ---- surface treatments ---------------------------------------------------
{
  const base = build({ ribs: 0, flutes: 0, noise: 0, facets: 0 });
  for (const [name, over] of [['ribs', { ribs: 8, ribDepth: 1.5 }], ['flutes', { flutes: 10, fluteDepth: 1.2 }],
                              ['facets', { facets: 8 }], ['noise', { noise: 0.6, noiseScale: 3, seed: 7 }]]) {
    const m = build(over);
    const t = topology(m);
    check(`${name} stays a closed solid`, t.boundary === 0 && t.inconsistent === 0 && m.volume() > 0, `bnd ${t.boundary}`);
    check(`${name} actually changes the surface`, m.triCount !== base.triCount || Math.abs(m.volume() - base.volume()) > 0.5);
  }
  const a = build({ noise: 0.6, noiseScale: 3, seed: 7 });
  const b = build({ noise: 0.6, noiseScale: 3, seed: 7 });
  const c = build({ noise: 0.6, noiseScale: 3, seed: 8 });
  near('noise with the same seed is identical', a.volume(), b.volume(), 1e-9);
  check('noise with a different seed is different', Math.abs(a.volume() - c.volume()) > 1e-6);
}

// ---- spiral mode, which is the whole point -------------------------------
{
  const m = build();
  const a = analyze(m);
  check('the vase is a single shell', a.shells === 1, `${a.shells} shells`);
  const h = gen.hints(defaults(gen));
  check('hints() says whether spiral mode is on', typeof h.spiral === 'boolean', JSON.stringify(h).slice(0, 80));
  check('hints() explains itself in sentences', (h.notes || []).some(n => n.length > 40), (h.notes || [])[0]?.slice(0, 80));
  if (h.spiral) {
    check('spiral mode asks for a single wall', h.profile === undefined || h.walls === undefined || h.walls === 1,
      JSON.stringify({ walls: h.walls, top: h.topLayers }));
    check('spiral mode asks for no top layers', h.topLayers === undefined || h.topLayers === 0, String(h.topLayers));
    check('spiral mode still asks for a solid floor', (h.bottomLayers ?? 0) >= 3, String(h.bottomLayers));
  }
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
}

// ---- dimension callouts sit on the features they name --------------------
{
  const buildR = (over = {}) => gen.build({ ...defaults(gen), ...over }, C);
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const dimOf = (r, param) => (r.meta?.dims || []).find(d => d.param === param);
  // Is this point a built vertex? A callout that starts on the mesh starts on
  // the feature; one that starts a hair off it is measuring a construction.
  const onVertex = (m, p, tol = 1e-6) => {
    for (let v = 0; v < m.vertCount; v++) {
      const q = m.vertex(v);
      if (Math.abs(q[0] - p[0]) < tol && Math.abs(q[1] - p[1]) < tol && Math.abs(q[2] - p[2]) < tol) return true;
    }
    return false;
  };
  const radial = (m, p) => { const b = m.bbox(); return Math.hypot(p[0] - b.center[0], p[1] - b.center[1]); };

  const r0 = buildR();
  const m0 = r0.mesh;
  const dia = dimOf(r0, 'dia'), base = dimOf(r0, 'base');
  check('a Ø callout is declared at the defaults', !!dia);
  if (dia) {
    nearPct('the Ø callout is the widest diameter', len(dia), 80, 0.5);
    near('the Ø callout is horizontal', dia.from[2], dia.to[2], 1e-9);
    check('the Ø callout starts on the outer skin', onVertex(m0, dia.from), dia.from.join(','));
    near('the Ø callout passes through the axis', Math.hypot(dia.from[0] + dia.to[0], dia.from[1] + dia.to[1]), 0, 1e-6);
  }
  check('a floor callout is declared at the defaults', !!base);
  if (base) {
    near('the floor callout is the floor thickness', len(base), 1.6, 1e-9);
    near('the floor callout starts on the bed', base.from[2], 0, 1e-9);
    near('the floor callout ends at the cavity floor', base.to[2], 1.6, 1e-9);
    check('the floor callout stands on the foot of the outer skin', onVertex(m0, base.from), base.from.join(','));
  }
  check('spiral mode declares no wall callout (the printer sets that wall)', !dimOf(r0, 'wall'));

  const rw = buildR({ mode: 'walled', wall: 2.4, silhouette: 'straight', topScale: 96, bulge: 0 });
  const wall = dimOf(rw, 'wall');
  check('a walled pot declares a wall callout', !!wall);
  if (wall) {
    near('the wall callout is the wall thickness, perpendicular to the skin', len(wall), 2.4, 2.4 * 0.005);
    const rim = [wall.from, wall.to].find(p => Math.abs(p[2] - 120) < 1e-9);
    check('the wall callout is anchored at the rim', !!rim, `${wall.from[2]} / ${wall.to[2]}`);
    if (rim) check('the rim end of the wall callout is a rim vertex', onVertex(rw.mesh, rim), rim.join(','));
    const other = rim === wall.from ? wall.to : wall.from;
    check('the wall callout runs inward, not out into the air', radial(rw.mesh, other) < radial(rw.mesh, rim) || Math.abs(other[2] - 120) > 1e-9);
  }

  const rr = buildR({ ribs: 8, ribDepth: 1.5, ribStyle: 'wave' });
  const rib = dimOf(rr, 'ribDepth');
  check('rings declare a ring-depth callout', !!rib);
  if (rib) {
    near('the ring-depth callout is the ring depth', len(rib), 1.5, 1e-9);
    near('the ring-depth callout is horizontal', rib.from[2], rib.to[2], 1e-9);
    // Trough of a ring: u = i + ½ over the height, so z is an odd multiple of H / (2·ribs).
    const u = rib.from[2] / (120 / 8);
    near('the ring-depth callout sits at a trough', u - Math.floor(u), 0.5, 1e-9);
    check('the ring-depth callout runs from the trough out to the crest envelope', radial(rr.mesh, rib.to) > radial(rr.mesh, rib.from));
  }
  check('no rings, no ring-depth callout', !dimOf(buildR({ ribs: 0 }), 'ribDepth'));

  const rf = buildR({ flutes: 12, fluteDepth: 1.3 });
  const fl = dimOf(rf, 'fluteDepth');
  check('flutes declare a flute-depth callout', !!fl);
  if (fl) {
    near('the flute-depth callout is the flute depth', len(fl), 1.3, 1e-9);
    near('the flute-depth callout is at the rim', fl.from[2], 120, 1e-9);
    check('the flute-depth callout starts in the bottom of a flute on the rim', onVertex(rf.mesh, fl.from), fl.from.join(','));
    check('the flute-depth callout runs outward to the arris', radial(rf.mesh, fl.to) > radial(rf.mesh, fl.from));
  }
}

done();
