// gen comic: the shared contract, then the questions only a traced drawing raises.
//
// conformance() proves it is *a* solid at every extreme. What follows proves it
// is *the* solid: that a thin line comes out raised and widened by exactly the
// thickening, that a letter keeps its counter, that the colour change height
// is the only height between the plate and the line tops, that specks go, that
// panels are found at their gutters and printed at one shared scale.
//
// Every picture here is synthetic and built in this file. Most use four 2 px
// anchor dots in the corners so the traced box is the whole picture and the
// scale is known exactly: a 100 px picture on a 110 mm plate with 5 mm margins
// is 1 mm per pixel.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh, isSolid, onPlate, centredXY } from './lib/genconform.mjs';
import gen, { findPanels, lineWidths, planFor, THIN_LINE_MEASURED } from '../js/gen/comic.js';
import { traceContours } from '../js/kernel/trace.js';
import * as P from '../js/kernel/poly2d.js';

suite('gen comic');

conformance(gen, 'comic');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C = ctx();
const BASE = { ...defaults(gen), margin: 5, width: 110, cornerRadius: 0 };

/** A white picture with whatever `ink(x, y)` says is black, plus corner anchors. */
function picture(w, h, ink, { anchors = true, bg = 1, fg = 0 } = {}) {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = ink(x, y);
    if (anchors && (x < 2 || x >= w - 2) && (y < 2 || y >= h - 2)) on = true;
    gray[y * w + x] = on ? fg : bg;
  }
  return { w, h, gray };
}

const build = (over) => {
  const r = gen.build({ ...BASE, ...over }, C);
  return { r, m: asMesh(r) };
};

/** Every triangle whose three corners sit at height z. */
function facesAt(m, z, eps = 1e-6) {
  const out = [];
  for (let t = 0; t < m.triCount; t++) {
    const [a, b, c] = m.tri(t).map(i => m.vertex(i));
    if (Math.abs(a[2] - z) < eps && Math.abs(b[2] - z) < eps && Math.abs(c[2] - z) < eps) out.push([a, b, c]);
  }
  return out;
}
function covered(faces, x, y) {
  for (const [a, b, c] of faces) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-15) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9) return true;
  }
  return false;
}
/** toSTL() is binary: compare the bytes, not the buffer objects. */
function sameBytes(u, v) {
  if (u.length !== v.length) return false;
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}
const faceArea = (faces) => faces.reduce((s, [a, b, c]) =>
  s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);

// ---------------------------------------------------------------------------
// The default with no picture at all is still a real, valid solid
// ---------------------------------------------------------------------------
{
  const p = defaults(gen);
  const m = asMesh(gen.build(p, C));
  isSolid('no-image build (stand-in drawing)', m);
  onPlate('no-image build', m);
  centredXY('no-image build', m);
  check('the stand-in drawing has raised lines on it', facesAt(m, p.plateThickness + p.reliefHeight).length > 20);
  const v = gen.validate(p);
  check('validate() says no drawing is loaded', v.some(i => i.param === 'image' && i.severity === 'warn'),
    v.map(i => i.message).join(' | '));
}

// ---------------------------------------------------------------------------
// A 2 px line: raised, and exactly `thicken` wider
// ---------------------------------------------------------------------------
{
  const img = picture(100, 60, (x, y) => (x === 49 || x === 50) && y >= 10 && y < 50);
  for (const thicken of [0.4, 1.0]) {
    const { r, m } = build({ image: img, thicken });
    near(`scale is 1 mm per pixel (thicken ${thicken})`, r.meta.mmPerPixel, 1, 1e-9);
    isSolid(`2 px line, thicken ${thicken}`, m);
    onPlate(`2 px line, thicken ${thicken}`, m);
    centredXY(`2 px line, thicken ${thicken}`, m);
    const top = facesAt(m, BASE.plateThickness + BASE.reliefHeight).flat().filter(v => Math.abs(v[0]) < 10);
    const xs = top.map(v => v[0]);
    const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    near(`the 2 px line stands ${2 + thicken} mm wide at the top (2 mm + thicken ${thicken})`, width, 2 + thicken, 1e-3);
    check('...and it is raised: its middle is covered by the line-top face', covered(facesAt(m, BASE.plateThickness + BASE.reliefHeight), 0, 0));
  }
}

// ---------------------------------------------------------------------------
// Only three heights exist: the base, the colour change, the line tops
// ---------------------------------------------------------------------------
{
  const img = picture(100, 60, (x, y) => (x === 49 || x === 50) && y >= 10 && y < 50);
  for (const [T, R] of [[2, 0.8], [1.6, 1.2]]) {
    const { r, m } = build({ image: img, plateThickness: T, reliefHeight: R });
    const zs = new Set();
    for (let i = 0; i < m.vertCount; i++) zs.add(Math.round(m.vertex(i)[2] * 1e6) / 1e6);
    const got = [...zs].sort((a, b) => a - b);
    check(`plate ${T} + lines ${R}: vertices sit only at 0, ${T} and ${T + R}`,
      got.length === 3 && Math.abs(got[0]) < 1e-9 && Math.abs(got[1] - T) < 1e-6 && Math.abs(got[2] - (T + R)) < 1e-6,
      got.join(', '));
    near('meta states the colour change at the plate top', r.meta.colourChangeZ, T, 1e-9);
    const h = gen.hints({ ...BASE, plateThickness: T, reliefHeight: R });
    check('the first hint names the exact colour-change Z', h.notes[0].includes(`Z = ${T.toFixed(2)} mm`), h.notes[0].slice(0, 60));
    // The plate top really is the plate top: the whole plate footprint is covered
    // at z = T except where the line stands.
    near('plate top + line top cover the footprint exactly', faceArea(facesAt(m, T)) + faceArea(facesAt(m, T + R)),
      110 * 70, 1e-3);
  }
}

// ---------------------------------------------------------------------------
// A ring keeps its counter when it is big enough, and fills when it is not
// ---------------------------------------------------------------------------
{
  const ring = (ri, ro) => picture(100, 60, (x, y) => { const d = Math.hypot(x + 0.5 - 50, y + 0.5 - 30); return d >= ri && d <= ro; });
  const T = BASE.plateThickness, top = T + BASE.reliefHeight;
  {
    const { r, m } = build({ image: ring(5, 9), thicken: 0.4 });
    isSolid('an "o" with a 10 mm counter', m);
    check('the counter is open: the plate top shows at the centre', covered(facesAt(m, T), 0, 0) && !covered(facesAt(m, top), 0, 0));
    check('...and the ring itself is raised', covered(facesAt(m, top), 7, 0) && covered(facesAt(m, top), 0, -7));
    check('meta counts one counter and none filled', r.meta.counters === 1 && r.meta.countersFilled === 0, JSON.stringify([r.meta.counters, r.meta.countersFilled]));
    const v = gen.validate({ ...BASE, image: ring(5, 9), thicken: 0.4 });
    check('validate() does not report a filled counter', !v.some(i => /filled in/.test(i.message)), v.map(i => i.message).join(' | '));
  }
  {
    const img = ring(1.2, 6);
    const { r, m } = build({ image: img, thicken: 2 });
    isSolid('an "o" whose counter the thickening closes', m);
    check('the closed counter is raised at the centre', covered(facesAt(m, top), 0, 0) && !covered(facesAt(m, T), 0, 0));
    check('meta counts it as filled', r.meta.countersFilled === 1, JSON.stringify([r.meta.counters, r.meta.countersFilled]));
    const v = gen.validate({ ...BASE, image: img, thicken: 2 });
    check('validate() warns that a counter filled in', v.some(i => i.param === 'thicken' && /filled in/.test(i.message)), v.map(i => i.message).join(' | '));
  }
  {
    // A counter that survives but is narrower than two extrusions.
    const img = ring(1.9, 6);
    const v = gen.validate({ ...BASE, image: img, thicken: 3.0 });
    const plan = planFor({ ...BASE, image: img, thicken: 3.0 }, {});
    const holes = plan.raised.reduce((n, s) => n + s.length - 1, 0);
    check('a counter squeezed under 0.8 mm is still a hole in the mesh', holes === 1, `${holes} holes`);
    check('validate() warns it will close up', v.some(i => /narrower than 0\.8 mm/.test(i.message)), v.map(i => i.message).join(' | '));
  }
}

// ---------------------------------------------------------------------------
// Invert: white on black is the same drawing as black on white, inverted
// ---------------------------------------------------------------------------
{
  const draw = (x, y) => (x >= 30 && x < 34 && y >= 10 && y < 50) || (y >= 28 && y < 31 && x >= 20 && x < 80);
  const pos = picture(100, 60, draw);
  const neg = { w: 100, h: 60, gray: pos.gray.map(g => 1 - g) };
  const a = asMesh(gen.build({ ...BASE, image: pos, invert: false }, C));
  const b = asMesh(gen.build({ ...BASE, image: neg, invert: true }, C));
  check('white-on-black inverted is byte-identical to black-on-white', sameBytes(a.toSTL('x'), b.toSTL('x')),
    `${a.triCount} vs ${b.triCount} triangles`);
  const c = asMesh(gen.build({ ...BASE, image: neg, invert: false }, C));
  const top = BASE.plateThickness + BASE.reliefHeight;
  check('without invert the same negative raises the background instead', faceArea(facesAt(c, top)) > 3 * faceArea(facesAt(a, top)),
    `${faceArea(facesAt(c, top)).toFixed(0)} vs ${faceArea(facesAt(a, top)).toFixed(0)} mm²`);
  isSolid('inverted build', b);
}

// ---------------------------------------------------------------------------
// Specks under the area filter are dropped; above it they stay
// ---------------------------------------------------------------------------
{
  // A 20 px square and one lone pixel (traced as a 0.5 mm² diamond at 1 mm/px).
  const img = picture(100, 60, (x, y) => (x >= 10 && x < 30 && y >= 20 && y < 40) || (x === 70 && y === 30));
  const top = BASE.plateThickness + BASE.reliefHeight;
  const dot = [70.5 - 50, 30 - 30.5];
  const kept = build({ image: img, minSpeck: 0.3 });
  const gone = build({ image: img, minSpeck: 1.0 });
  check('a 0.5 mm² speck survives a 0.3 mm² filter', covered(facesAt(kept.m, top), dot[0], dot[1]) && kept.r.meta.specksDropped === 0,
    `dropped ${kept.r.meta.specksDropped}`);
  check('...and is dropped by a 1 mm² filter', !covered(facesAt(gone.m, top), dot[0], dot[1]) && gone.r.meta.specksDropped === 1,
    `dropped ${gone.r.meta.specksDropped}`);
  check('the square is kept either way', covered(facesAt(gone.m, top), 20 - 50, 0));
  isSolid('speck-filtered build', gone.m);
}

// ---------------------------------------------------------------------------
// Line width, measured by rays through the line
// ---------------------------------------------------------------------------
{
  const strip = [[P.rect(0.4, 10)]];
  const w1 = lineWidths(strip);
  near('a 0.4 mm strip measures 0.4 mm', w1.thinnest, 0.4, 1e-9);
  near('...along its 10 mm length', w1.thinLength, 10, 1e-9);
  const w2 = lineWidths([[P.rect(3, 10)]]);
  check('a 3 mm strip has nothing under 0.5 mm', w2.samples > 50 && w2.thinLength === 0, JSON.stringify(w2));
  const w5 = lineWidths([[P.rect(0.6, 10)]]);
  check('a 0.6 mm strip is no longer thin: 0.4-0.5 mm lines printed on the A1 mini (THIN_LINE_MEASURED)',
    w5.samples > 50 && w5.thinLength === 0, JSON.stringify(w5));
  check('the threshold is the measured 0.5 mm', THIN_LINE_MEASURED.value === 0.5 && /A1 mini/.test(THIN_LINE_MEASURED.machine),
    JSON.stringify(THIN_LINE_MEASURED));
  // An L of 2 mm arms: its inside corner is a crease, not a thin line.
  const L = [[[[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]]]];
  const w3 = lineWidths(L);
  check('a right-angle crease does not read as a thin line', w3.samples > 50 && w3.thinLength === 0, JSON.stringify(w3));
  // A thick rhombus with 80° corners: near each sharp corner a ray from one side
  // runs into the other side a fraction of a millimetre away, but that side is
  // not facing back, so it is a corner and not a line.
  const a = 80 * Math.PI / 180;
  const rh = [[[[0, 0], [10, 0], [10 + 10 * Math.cos(a), 10 * Math.sin(a)], [10 * Math.cos(a), 10 * Math.sin(a)]]]];
  const w4 = lineWidths(rh);
  check('an 80° corner of a thick block does not read as a thin line', w4.samples > 50 && w4.thinLength === 0 && w4.thinnest === null, JSON.stringify(w4));

  // Through the generator: a 1 px line at 0.4 mm/px (100 px across a 50 mm
  // plate less two 5 mm margins) is 0.4 mm; thickening 0.05 leaves it at 0.45
  // (warn), thickening 0.2 makes it 0.6 (quiet, where the old 0.8 rule warned).
  const img = picture(100, 60, (x, y) => x === 50 && y >= 5 && y < 55);
  const P0 = { ...BASE, image: img, width: 50, margin: 5 };
  const thin = gen.validate({ ...P0, thicken: 0.05 });
  const warn = thin.find(i => /under 0\.5 mm wide/.test(i.message));
  check('validate() warns about a 0.45 mm line', !!warn, thin.map(i => i.message).join(' | '));
  const m = warn && warn.message.match(/most of it about ([\d.]+) mm/);
  check('...and measures most of it at 0.45 mm', !!m && Math.abs(parseFloat(m[1]) - 0.45) < 0.01, warn ? warn.message : '');
  check('...and cites the print behind the threshold', !!warn && /printed cleanly on an A1 mini/.test(warn.message), warn ? warn.message : '');
  const lw = lineWidths(planFor({ ...P0, thicken: 0.05 }, {}).raised);
  check('the thinnest point (the chamfered stroke end) is no wider than the stroke', lw.thinnest > 0.3 && lw.thinnest <= 0.45 + 1e-6, String(lw.thinnest));
  near('...and the 20 mm stroke is reported as about 20 mm of thin line', lw.thinLength, 20, 0.6);
  const fat = gen.validate({ ...P0, thicken: 0.2 });
  check('validate() is quiet about a 0.6 mm line', !fat.some(i => /mm of line comes out under/.test(i.message)), fat.map(i => i.message).join(' | '));
}

// ---------------------------------------------------------------------------
// Marching squares: saddles are decided by the centre, deterministically
// ---------------------------------------------------------------------------
{
  const sep = traceContours([1, -1, -1, 1], 2, 2);
  check('a saddle with a dark centre stays two islands', sep.length === 2, `${sep.length} rings`);
  const joined = traceContours([1, -0.5, -0.5, 1], 2, 2);
  check('a saddle with an inked centre joins into one', joined.length === 1, `${joined.length} rings`);
  const ring = traceContours(Float32Array.from({ length: 400 }, (_, i) => {
    const x = i % 20 + 0.5 - 10, y = Math.floor(i / 20) + 0.5 - 10, d = Math.hypot(x, y);
    return d > 3 && d < 8 ? 1 : -1;
  }), 20, 20);
  check('a traced annulus is two rings, inside on the left of each', ring.length === 2 &&
    ring.some(r => P.signedArea(r) > 0) && ring.some(r => P.signedArea(r) < 0),
    ring.map(r => P.signedArea(r).toFixed(1)).join(', '));
  check('an edge-touching block closes on the picture border', (() => {
    const r = traceContours([1, 1, 1, 1], 2, 2);
    const b = r.length === 1 ? P.bounds([r[0]]) : null;
    return b && Math.abs(b.min[0]) < 0.02 && Math.abs(b.max[0] - 2) < 0.02;
  })());
}

// ---------------------------------------------------------------------------
// Panels: found at the gutters, row by row, printed at one shared scale
// ---------------------------------------------------------------------------
{
  // Three framed panels of different widths across a strip, with different
  // contents; the middle one has a caption box poking above its frame.
  const W = 220, H = 70;
  const frames = [[4, 64], [74, 150], [160, 216]];
  const ink = (x, y) => {
    for (const [a, b] of frames) {
      if (x >= a && x < b && y >= 8 && y < 66 && (x < a + 2 || x >= b - 2 || y < 10 || y >= 64)) return true;
    }
    if (x >= 20 && x < 30 && y >= 30 && y < 40) return true;              // panel 1: a block
    if (x >= 90 && x < 130 && y >= 4 && y < 14 && (y < 6 || y >= 12 || x < 92 || x >= 128)) return true; // panel 2: caption box
    if (x >= 180 && x < 200 && y === 40) return true;                      // panel 3: a line
    return false;
  };
  const img = picture(W, H, ink, { anchors: false });
  const s = Float32Array.from(img.gray, g => 0.5 - g);
  const found = findPanels(s, W, H);
  check('three panels are found in a strip', found.length === 3, JSON.stringify(found));
  check('...left to right, each spanning its frame', found.length === 3 &&
    found.every((q, i) => q.x0 === frames[i][0] && q.x1 === frames[i][1]), JSON.stringify(found));

  // A 2 × 2 grid reads row by row.
  const grid = picture(100, 100, (x, y) => {
    for (const [a, b] of [[2, 46], [54, 98]]) for (const [c, d] of [[2, 46], [54, 98]]) {
      if (x >= a && x < b && y >= c && y < d && (x < a + 2 || x >= b - 2 || y < c + 2 || y >= d - 2)) return true;
    }
    return false;
  }, { anchors: false });
  const g = findPanels(Float32Array.from(grid.gray, v => 0.5 - v), 100, 100);
  check('a 2 × 2 grid is four panels, row by row', g.length === 4 &&
    g[0].x0 === 2 && g[0].y0 === 2 && g[1].x0 === 54 && g[1].y0 === 2 && g[2].x0 === 2 && g[2].y0 === 54 && g[3].x0 === 54 && g[3].y0 === 54,
    JSON.stringify(g));

  // A speck in a gutter is not a panel and does not break the gutter's neighbours apart wrongly.
  const specked = picture(W, H, (x, y) => ink(x, y) || (x === 68 && y === 30), { anchors: false });
  const f2 = findPanels(Float32Array.from(specked.gray, v => 0.5 - v), W, H);
  check('a one-pixel speck in a gutter is not numbered as a panel', f2.length === 3, JSON.stringify(f2));

  // One plaque per panel: the same scale and the same plate for all three.
  const builds = [1, 2, 3].map(panel => gen.build({ ...BASE, image: img, panel, width: 100 }, C));
  const sizes = builds.map(b => asMesh(b).bbox().size.map(v => +v.toFixed(6)));
  check('every panel is printed at the same mm per pixel', builds.every(b => b.meta.mmPerPixel === builds[0].meta.mmPerPixel),
    builds.map(b => b.meta.mmPerPixel).join(', '));
  check('...on the same size of plate', sizes.every(sz => sz[0] === sizes[0][0] && sz[1] === sizes[0][1]),
    sizes.map(sz => sz.slice(0, 2).join('×')).join(' | '));
  near('the scale comes from the widest panel filling the plate', builds[0].meta.mmPerPixel, (100 - 10) / 76, 1e-4);
  const top = BASE.plateThickness + BASE.reliefHeight;
  const k = builds[0].meta.mmPerPixel;
  const m1 = asMesh(builds[0]);
  // Panel 1 is 60 px wide, centred; its block spans x 20..30 → 16..26 px into the panel.
  // Panels print centred; the row runs y 4..66 (panel 2's caption sets its top), so y 35 is the plate's middle.
  // Panel 1 (x 4..64, centre 34) has its block at x 20..30, y 30..40.
  check('panel 1 carries its own block and nothing of panel 3', covered(facesAt(m1, top), (25 - 34) * k, 0) &&
    builds[0].meta.panel === 1 && builds[0].meta.panels === 3);
  const m3 = asMesh(builds[2]);
  // Panel 3 (x 160..216, centre 188) has a 1 px line at y 40, x 180..199.
  check('panel 3 carries its line, not panel 1\'s block', !covered(facesAt(m3, top), (25 - 34) * k, 0) &&
    covered(facesAt(m3, top), (190 - 188) * k, (35 - 40.5) * k));
  for (const b of builds) isSolid(`panel ${b.meta.panel} plaque`, asMesh(b));
  const v = gen.validate({ ...BASE, image: img, panel: 2 });
  check('validate() names the panel count', v.some(i => i.param === 'panel' && /Found 3 panels/.test(i.message)), v.map(i => i.message).join(' | '));
  const vm = gen.validate({ ...BASE, image: img, panel: 7 });
  check('asking for a panel that is not there warns and uses the whole picture',
    vm.some(i => i.param === 'panel' && i.severity === 'warn' && /no panel 7/.test(i.message)));
}

// ---------------------------------------------------------------------------
// Border and hanging holes
// ---------------------------------------------------------------------------
{
  const img = picture(100, 60, (x, y) => (x === 49 || x === 50) && y >= 10 && y < 50);
  const { r, m } = build({ image: img, border: true, borderWidth: 3, holes: 'corners', holeDiameter: 4, margin: 10, width: 120 });
  isSolid('bordered plaque with two hanging holes', m);
  const T = BASE.plateThickness, top = T + BASE.reliefHeight;
  const b = m.bbox();
  check('the border is raised just inside the edge', covered(facesAt(m, top), b.max[0] - 1 - 1.5, 0));
  const hole = r.meta.dims.find(d => d.param === 'holeDiameter');
  check('a hole callout exists', !!hole);
  if (hole) {
    const cx = (hole.from[0] + hole.to[0]) / 2, cy = hole.from[1];
    check('the hole goes right through (no face at any height over its centre)',
      !covered(facesAt(m, 0), cx, cy) && !covered(facesAt(m, T), cx, cy) && !covered(facesAt(m, top), cx, cy));
  }
}

done();
