// gen lithophane — the shared contract, then the questions only this object raises.
//
// conformance() proves it is *a* solid at every extreme of every parameter.
// What follows proves it is *the* solid: that dark is thick and not thin, that
// the picture is the right way up, that a curved one is as wide as it says it
// is measured along the surface, and that a photograph is filtered rather than
// point-sampled on its way to the grid.
//
// Where a check could pass for the wrong reason, the wrong answer is computed
// too and printed beside the right one — a resampling test that does not know
// what nearest-neighbour would have produced is not a resampling test.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import {
  conformance, ctx, defaults, testImage, asMesh,
  isSolid, onPlate, centredXY, fitsBed, topology,
} from './lib/genconform.mjs';
import gen, { toneCurve, thicknessMap } from '../js/gen/lithophane.js';
import { shellsOf, analyze } from '../js/kernel/validate.js';

suite('gen lithophane');

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------
conformance(gen, 'lithophane');

// ---------------------------------------------------------------------------
// Fixtures and measuring tools
// ---------------------------------------------------------------------------

const P = { ...defaults(gen), image: testImage() };
/** Coarse grid: most domain questions do not need 250k triangles to answer. */
const FAST = { ...P, pixelPitch: 1.0 };
const C = ctx();

function img(w, h, fn) {
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = fn(x, y, w, h);
  return { w, h, gray };
}
const hGradient = (w = 64, h = 64) => img(w, h, (x, _y, ww) => x / (ww - 1));
const vGradient = (w = 64, h = 64) => img(w, h, (_x, y, _w, hh) => y / (hh - 1));
const oneTone = (v, w = 24, h = 24) => img(w, h, () => v);
const checker = (w, h) => img(w, h, (x, y) => (x + y) & 1);
const photoish = (w, h) => img(w, h, (x, y, ww, hh) =>
  0.5 + 0.35 * Math.sin(x / ww * 22) * Math.cos(y / hh * 17) + 0.1 * Math.sin(x / ww * 180));

const build = (over, quality = 'normal') => gen.build({ ...FAST, ...over }, ctx(quality));
const mesh = (over, quality) => asMesh(build(over, quality));

/** Max relief thickness at a point, read off the built mesh rather than the field. */
function thicknessNear(m, wantX, wantZ, tol) {
  const b = m.bbox();
  let best = -Infinity;
  for (let i = 0; i < m.vertCount; i++) {
    const [x, y, z] = m.vertex(i);
    if (Math.abs(x - wantX) > tol || Math.abs(z - wantZ) > tol) continue;
    if (y > best) best = y;
  }
  return best === -Infinity ? NaN : best - b.min[1];
}

function circumcentre(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const s = (q) => q[0] * q[0] + q[1] * q[1];
  return [
    (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d,
    (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d,
  ];
}

/**
 * Recover the curvature of a built arc from its vertices alone: fit the centre
 * through three points that must lie on the smooth face, then walk the surface
 * ring at one height and sum it. Nothing here reads the generator's arithmetic,
 * which is the point — a chord mistaken for an arc is invisible to a check that
 * asks the generator how wide it thinks it is.
 */
function measureArc(m, which) {
  const byZ = new Map();
  for (let i = 0; i < m.vertCount; i++) {
    const v = m.vertex(i), k = v[2].toFixed(6);
    if (!byZ.has(k)) byZ.set(k, []);
    byZ.get(k).push(v);
  }
  const bb = m.bbox(), zmid = bb.min[2] + bb.size[2] / 2;
  let level = null;
  for (const [k, pts] of byZ) {
    if (pts.length < 8) continue;
    const d = Math.abs(parseFloat(k) - zmid);
    if (!level || d < level.d) level = { d, pts };
  }
  const pts = level.pts;
  let A = pts[0], B = pts[0], D = pts[0];
  for (const q of pts) { if (q[0] > A[0]) A = q; if (q[1] > B[1]) B = q; if (q[1] < D[1]) D = q; }
  const c = circumcentre(A, B, D);
  const rad = pts.map(q => Math.hypot(q[0] - c[0], q[1] - c[1]));
  const R = which === 'outer' ? Math.max(...rad) : Math.min(...rad);
  const sel = pts.filter((_, i) => Math.abs(rad[i] - R) < 1e-6 * R + 1e-7);
  sel.sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  let poly = 0;
  for (let i = 1; i < sel.length; i++) poly += Math.hypot(sel[i][0] - sel[i - 1][0], sel[i][1] - sel[i - 1][1]);
  const first = sel[0], last = sel[sel.length - 1];
  return {
    R, poly, n: sel.length,
    chord: Math.hypot(last[0] - first[0], last[1] - first[1]),
    spanDeg: (Math.atan2(last[1] - c[1], last[0] - c[0]) - Math.atan2(first[1] - c[1], first[0] - c[0])) * 180 / Math.PI,
  };
}

/** The hanger outline, read back from the flat plate's back face. */
function hangerOutline(m) {
  const b = m.bbox(), ring = [];
  for (let i = 0; i < m.vertCount; i++) {
    const v = m.vertex(i);
    if (Math.abs(v[1] - b.min[1]) > 1e-9) continue;              // on the flat back
    if (v[2] < b.max[2] - 14) continue;                          // in the top border
    if (Math.abs(v[0]) > b.size[0] / 2 - 0.01) continue;         // not the panel's own corner
    ring.push([v[0], v[2]]);
  }
  return ring;
}
/** Shallowest angle from horizontal anywhere on a hole's ceiling: 90 = vertical. */
function ceilingAngle(ring) {
  const apex = Math.max(...ring.map(q => q[1]));
  let worst = 90;
  for (const q of ring) {
    if (q[1] > apex - 1e-9 || Math.abs(q[0]) < 1e-9) continue;
    const a = Math.atan2(apex - q[1], Math.abs(q[0])) * 180 / Math.PI;
    if (a < worst) worst = a;
  }
  return worst;
}

function spread(t) {
  let lo = Infinity, hi = -Infinity;
  for (const v of t) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo;
}

// ===========================================================================
// G4 — the mapping. Dark is thick.
// ===========================================================================
console.log('\n-- the mapping --');

near('tone curve leaves black at black', toneCurve(0, {}), 0, 1e-12);
near('tone curve leaves white at white', toneCurve(1, {}), 1, 1e-12);
near('tone curve is the identity at its defaults', toneCurve(0.37, {}), 0.37, 1e-12);

{
  const tm = thicknessMap({ ...FAST, frame: false, edgeFade: 0, overhangGuard: false }, C);
  let lo = Infinity, hi = -Infinity;
  for (const v of tm.t) { if (v < lo) lo = v; if (v > hi) hi = v; }
  near('the darkest pixel maps to the maximum thickness', hi, P.maxThickness, 1e-9);
  near('the brightest pixel maps to the minimum thickness', lo, P.minThickness, 1e-9);
  near('the thickness range equals maxThickness - minThickness',
    hi - lo, P.maxThickness - P.minThickness, 1e-6);
}
{
  // Gamma and contrast reshape the curve without moving its ends: the stretch
  // that follows would silently undo any control that only scaled it.
  const t = (g, o) => P.maxThickness - toneCurve(g, o) * (P.maxThickness - P.minThickness);
  const mid = t(0.5, {});
  check('gamma above 1 thins the midtones (a brighter picture)', t(0.5, { gamma: 1.6 }) < mid - 0.2,
    `${t(0.5, { gamma: 1.6 }).toFixed(3)} mm vs ${mid.toFixed(3)} mm at gamma 1`);
  check('gamma below 1 thickens the midtones', t(0.5, { gamma: 0.6 }) > mid + 0.2,
    `${t(0.5, { gamma: 0.6 }).toFixed(3)} mm vs ${mid.toFixed(3)} mm`);
  check('contrast above 1 pushes the quarter tones apart',
    t(0.25, { contrast: 2 }) > t(0.25, {}) + 0.1 && t(0.75, { contrast: 2 }) < t(0.75, {}) - 0.1,
    `quarter ${t(0.25, {}).toFixed(2)}->${t(0.25, { contrast: 2 }).toFixed(2)}, three-quarter ${t(0.75, {}).toFixed(2)}->${t(0.75, { contrast: 2 }).toFixed(2)} mm`);
  check('contrast below 1 pulls them together',
    t(0.25, { contrast: 0.5 }) < t(0.25, {}) - 0.1 && t(0.75, { contrast: 0.5 }) > t(0.75, {}) + 0.1,
    `quarter ${t(0.25, { contrast: 0.5 }).toFixed(2)}, three-quarter ${t(0.75, { contrast: 0.5 }).toFixed(2)} mm`);
  near('gamma leaves the black point where it was', t(0, { gamma: 2.4 }), P.maxThickness, 1e-9);
  near('contrast leaves the white point where it was', t(1, { contrast: 2.4 }), P.minThickness, 1e-9);
}
{
  for (const o of [{ gamma: 2.2 }, { contrast: 2.5 }, { contrast: 0.4, gamma: 0.5 }]) {
    const tm = thicknessMap({ ...FAST, ...o, frame: false, edgeFade: 0, overhangGuard: false }, C);
    near(`the full thickness range survives ${JSON.stringify(o)}`,
      spread(tm.t), P.maxThickness - P.minThickness, 1e-6);
  }
}
{
  const tm = thicknessMap({ ...FAST, invert: true, frame: false, edgeFade: 0, overhangGuard: false }, C);
  const plain = thicknessMap({ ...FAST, frame: false, edgeFade: 0, overhangGuard: false }, C);
  let flipped = 0;
  for (let i = 0; i < tm.t.length; i++) {
    if (Math.abs(tm.t[i] - (P.maxThickness + P.minThickness - plain.t[i])) < 1e-9) flipped++;
  }
  check('the negative is the exact reflection of the positive', flipped === tm.t.length,
    `${flipped}/${tm.t.length} samples reflect about the mid thickness`);
}
{
  // Low-contrast picture, levels off: the range must NOT be filled.
  const dull = img(32, 32, (x) => 0.45 + 0.1 * (x / 31));
  const asIs = thicknessMap({ ...FAST, image: dull, levels: 'as-is', frame: false, edgeFade: 0, overhangGuard: false }, C);
  const done_ = thicknessMap({ ...FAST, image: dull, levels: 'stretch', frame: false, edgeFade: 0, overhangGuard: false }, C);
  check('levels "as-is" leaves a flat photograph flat', spread(asIs.t) < 0.35,
    `${spread(asIs.t).toFixed(3)} mm of relief from a 0.1-wide histogram`);
  near('levels "stretch" fills the range from the same photograph',
    spread(done_.t), P.maxThickness - P.minThickness, 1e-6);
}

// The same two facts, read off the MESH rather than the field — a sign error in
// the geometry stage would leave the field above perfectly correct.
console.log('\n-- the mapping, measured on the mesh --');
{
  // Mirroring off, so world -X is the picture's left: this is the tone
  // mapping, not handedness, which has its own section below.
  const m = mesh({ image: hGradient(), mirror: 'off', frame: false, edgeFade: 0, overhangGuard: false, fit: 'crop', imageWidth: 60, imageHeight: 60 });
  const b = m.bbox();
  const zc = b.min[2] + b.size[2] / 2;
  const left = thicknessNear(m, b.min[0], zc, 0.6);
  const right = thicknessNear(m, b.max[0], zc, 0.6);
  near('black down the left edge prints at the maximum thickness', left, P.maxThickness, 5e-3);
  near('white down the right edge prints at the minimum thickness', right, P.minThickness, 5e-3);
  check('and it is that way round — dark is thick, not thin', left > right,
    `left ${left.toFixed(3)} mm vs right ${right.toFixed(3)} mm`);
}
{
  // Image row 0 is the TOP of the picture. Forgetting that prints every
  // photograph upside down and leaves every mesh check green.
  const m = mesh({ image: vGradient(), frame: false, edgeFade: 0, overhangGuard: false, fit: 'crop', imageWidth: 60, imageHeight: 60 });
  const b = m.bbox();
  const top = thicknessNear(m, 0, b.max[2], 0.6);
  const bottom = thicknessNear(m, 0, b.min[2], 0.6);
  near('the picture is the right way up: its dark first row is at the top', top, P.maxThickness, 5e-3);
  near('and its bright last row is at the bottom', bottom, P.minThickness, 5e-3);
}
{
  const m = mesh({ frame: false, edgeFade: 0, overhangGuard: false });
  nearPct('an unframed plate is exactly maxThickness deep', m.bbox().size[1], P.maxThickness, 0.01);
}

// ===========================================================================
// G5 — the four shapes
// ===========================================================================
console.log('\n-- the four shapes --');

for (const shape of ['flat', 'arc-out', 'arc-in', 'shade']) {
  const m = mesh({ shape, foot: shape !== 'shade' });
  isSolid(`shape "${shape}"`, m);
  onPlate(`shape "${shape}"`, m, 1e-6);
  centredXY(`shape "${shape}"`, m, 1e-3);
  fitsBed(`shape "${shape}"`, m);
}
{
  const m = mesh({ shape: 'flat', fit: 'crop', imageWidth: 90, imageHeight: 50, frameWidth: 7 });
  const s = m.bbox().size;
  near('a framed flat panel is picture + two borders wide', s[0], 90 + 14, 1e-6);
  near('and picture + two borders tall', s[2], 50 + 14, 1e-6);
  near('and exactly frameThickness deep', s[1], P.frameThickness, 1e-6);
}
{
  // A uniform mid-grey picture puts the whole relief surface at exactly the mean
  // thickness, which is the reference surface the arc length is defined on. Any
  // other picture would smear that surface over a millimetre of radius and make
  // the measurement approximate for no reason.
  for (const [shape, side, W, R] of [['arc-out', 'outer', 100, 60], ['arc-in', 'inner', 90, 50], ['arc-out', 'outer', 150, 55]]) {
    const m = mesh({ shape, image: oneTone(0.5), frame: false, edgeFade: 0, overhangGuard: false,
                     fit: 'crop', imageWidth: W, imageHeight: 45, radius: R, foot: false, pixelPitch: 0.5 });
    const a = measureArc(m, side);
    nearPct(`${shape} R${R}: the picture surface measures ${W} mm along the arc`, a.poly, W, 1);
    check(`${shape} R${R}: and it is an arc, not a chord`, a.chord < W * 0.98,
      `${a.spanDeg.toFixed(1)} degrees of arc; the chord across it is ${a.chord.toFixed(2)} mm, ` +
      `${(100 - 100 * a.chord / W).toFixed(1)}% short of the ${W} mm the picture wants — build to the chord and the picture is squashed by exactly that`);
    near(`${shape} R${R}: the relief sits at the radius it was asked for`,
      a.R, shape === 'arc-out' ? R + (P.minThickness + P.maxThickness) / 2 : R - (P.minThickness + P.maxThickness) / 2, 5e-3);
  }
}
{
  const m = mesh({ shape: 'arc-out', imageWidth: 60, radius: 200, fit: 'crop', imageHeight: 40 });
  const flat = mesh({ shape: 'flat', imageWidth: 60, fit: 'crop', imageHeight: 40 });
  check('a large radius is nearly flat but still curved', m.bbox().size[0] < flat.bbox().size[0],
    `chord ${m.bbox().size[0].toFixed(2)} mm against a flat ${flat.bbox().size[0].toFixed(2)} mm`);
}
{
  const t = topology(mesh({ shape: 'shade' }));
  check('the shade is a tube, not a block (Euler characteristic 0)', t.euler === 0, `chi = ${t.euler}`);
  const m = mesh({ shape: 'shade', shadeSide: 64 });
  const s = m.bbox().size;
  near('the shade is square on the outside, at the side length asked for', s[0], 64, 1e-6);
  near('on both axes', s[1], 64, 1e-6);
  check('and it is hollow', m.volume() < 0.5 * s[0] * s[1] * s[2],
    `${m.volume().toFixed(0)} mm³ inside a ${(s[0] * s[1] * s[2]).toFixed(0)} mm³ box`);
}
{
  const same = mesh({ shape: 'shade' });
  const four = mesh({ shape: 'shade', image2: hGradient(), image3: vGradient(), image4: oneTone(0.2) });
  isSolid('a shade with four different pictures', four);
  check('four different pictures make four different faces',
    Math.abs(four.volume() - same.volume()) > 1,
    `${four.volume().toFixed(0)} mm³ against ${same.volume().toFixed(0)} mm³ for the same picture repeated`);
}
{
  const bare = mesh({ shape: 'arc-out', foot: false });
  const shod = mesh({ shape: 'arc-out', foot: true, footHeight: 5, footDepth: 6 });
  isSolid('a curved panel on a foot', shod);
  check('the foot widens the footprint', shod.bbox().size[1] > bare.bbox().size[1] + 6,
    `${bare.bbox().size[1].toFixed(1)} mm deep becomes ${shod.bbox().size[1].toFixed(1)} mm`);
  near('and raises the panel by the foot height plus its taper',
    shod.bbox().size[2] - bare.bbox().size[2], 5 + 6, 1e-6);
  const flatShod = mesh({ shape: 'flat', foot: true, frame: false });
  isSolid('an unframed flat panel on a foot', flatShod);
}

// ===========================================================================
// G6 — honest image handling
// ===========================================================================
console.log('\n-- image handling --');
{
  for (const [w, h] of [[160, 120], [120, 160], [300, 100]]) {
    const r = build({ image: photoish(w, h), fit: 'aspect', imageWidth: 80 });
    near(`a ${w}x${h} photograph keeps its aspect ratio exactly`,
      r.meta.picture.widthMM / r.meta.picture.heightMM, w / h, 1e-9);
    check(`...and nothing is cropped off it`, r.meta.picture.cropped === false);
  }
  const r = build({ image: photoish(300, 100), fit: 'crop', imageWidth: 80, imageHeight: 80 });
  check('cropping to a square reports itself as a crop', r.meta.picture.cropped === true);
  near('and honours the height it was given', r.meta.picture.heightMM, 80, 1e-9);
  check('there is no "stretch" option to choose by accident',
    !gen.params.find(q => q.key === 'fit').options.some(o => /stretch/i.test(o.v + o.label)),
    gen.params.find(q => q.key === 'fit').options.map(o => o.v).join('|'));
}
{
  // levels:'as-is' on purpose — auto-levels stretches each crop back to the full
  // range, so with it on the two windows would come out identical and the check
  // would be measuring the stretch rather than the crop.
  const win = { image: vGradient(200, 200), fit: 'crop', imageWidth: 60, imageHeight: 30,
                levels: 'as-is', frame: false, edgeFade: 0, overhangGuard: false };
  const top = mesh({ ...win, cropAnchor: 'top' });
  const bot = mesh({ ...win, cropAnchor: 'bottom' });
  check('the crop anchor actually moves the window', Math.abs(top.volume() - bot.volume()) > 1,
    `top of a dark-to-light gradient gives ${top.volume().toFixed(1)} mm³, bottom ${bot.volume().toFixed(1)} mm³`);
}
{
  // The decisive resampling test. A one-pixel checkerboard reduced by ~1.8x is
  // pure Nyquist: a filter averages it to flat grey, a point sample alternates
  // between black and white and prints the full range as noise.
  const src = checker(512, 512);
  const grid = 287;
  let nnLo = Infinity, nnHi = -Infinity;
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
    const x = Math.round(i * (512 - 1) / (grid - 1)), y = Math.round(j * (512 - 1) / (grid - 1));
    const v = src.gray[y * 512 + x];
    if (v < nnLo) nnLo = v; if (v > nnHi) nnHi = v;
  }
  const nnSpread = (nnHi - nnLo) * (P.maxThickness - P.minThickness);
  check('nearest-neighbour would alias this fixture (the control)', nnSpread > 2,
    `point sampling gives ${nnSpread.toFixed(3)} mm of relief from a texture with none`);
  for (const filter of ['lanczos', 'box', 'triangle']) {
    const tm = thicknessMap({ ...P, image: src, filter, levels: 'as-is', frame: false, edgeFade: 0, overhangGuard: false }, C);
    check(`"${filter}" filters it instead of point-sampling it`, spread(tm.t) < 0.5,
      `${spread(tm.t).toFixed(3)} mm of relief against ${nnSpread.toFixed(3)} mm for nearest-neighbour`);
  }
}
{
  // At the real default pitch, not the coarse one the rest of these use: the
  // claim is about the shipped settings, and a 1 mm grid would pass it for free.
  const t0 = process.hrtime.bigint();
  const big = gen.build({ ...P, image: photoish(4000, 3000) }, C);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const small = gen.build({ ...P, image: photoish(400, 300) }, C);
  const onePerPixel = 4000 * 3000 * 2;
  check('a 4000x3000 photograph does not become a 12-million-triangle mesh',
    asMesh(big).triCount < 300000,
    `${asMesh(big).triCount} triangles, against ${(onePerPixel / 1e6).toFixed(0)} million for one vertex per pixel`);
  check('the mesh is sized by the object, not by the file',
    asMesh(big).triCount === asMesh(small).triCount,
    `${asMesh(big).triCount} triangles from 12 MP, ${asMesh(small).triCount} from 0.12 MP`);
  check(`a 12-megapixel photograph still builds quickly (${ms.toFixed(0)} ms)`, ms < 2500, `${ms.toFixed(0)} ms`);
  isSolid('the 12-megapixel build', asMesh(big));
  // And the budget holds where it is actually reached: finest pitch, widest panel.
  const worst = gen.build({ ...P, image: photoish(4000, 3000), pixelPitch: 0.15, imageWidth: 170, shape: 'arc-out' }, ctx('fine'));
  check('the triangle budget holds at the finest pitch on the widest panel',
    asMesh(worst).triCount < 320000, `${asMesh(worst).triCount} triangles`);
  isSolid('the worst-case build', asMesh(worst));
}
{
  for (const [v, want] of [[0, P.maxThickness], [0.5, (P.minThickness + P.maxThickness) / 2], [1, P.minThickness]]) {
    const r = build({ image: oneTone(v), frame: false, edgeFade: 0, overhangGuard: false });
    const m = asMesh(r);
    isSolid(`a single-tone (${v}) picture`, m);
    check(`a single-tone (${v}) picture is a flat plate, not a NaN`,
      isFinite(m.volume()) && m.volume() > 0 && r.meta.picture.flat === true,
      `volume ${m.volume().toFixed(2)} mm³`);
    near(`...at the thickness that tone maps to`, m.bbox().size[1], want, 1e-6);
  }
  const noImage = asMesh(build({ image: null }));
  isSolid('no photograph chosen yet', noImage);
}
{
  const bytes = img(16, 16, (x) => (x * 17) % 256);
  const r = build({ image: bytes, frame: false, edgeFade: 0, overhangGuard: false });
  near('0..255 pixel data is recognised and scaled, not clamped to blank white',
    asMesh(r).bbox().size[1], P.maxThickness, 1e-6);
}
{
  for (const shape of ['arc-out', 'arc-in', 'shade']) {
    check(`automatic mirroring leaves "${shape}" unflipped`, build({ shape }).meta.picture.mirrored === false);
  }
  check('automatic mirroring flips the flat plate, which is read from its relief face',
    build({ shape: 'flat' }).meta.picture.mirrored === true);
  check('and both can be overridden by hand',
    build({ shape: 'flat', mirror: 'off' }).meta.picture.mirrored === false &&
    build({ shape: 'arc-in', mirror: 'on' }).meta.picture.mirrored === true);
}

// ===========================================================================
// Handedness, from where the viewer stands
//
// Left half of the photograph white (thin), right half black (thick), read
// with rays from the viewer's real position. The viewer's right is worked out
// from where they stand (up x the direction towards them), never borrowed
// from the generator, and the side of a curve that is convex is found from
// the mesh. meta.picture.mirrored is not consulted: it is the generator's
// opinion of itself.
// ===========================================================================
console.log('\n-- handedness from the viewer --');
function rayHits(m, o, d) {
  const out = [], T = m.tris, Q = m.positions;
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    const e1 = [Q[b] - Q[a], Q[b + 1] - Q[a + 1], Q[b + 2] - Q[a + 2]];
    const e2 = [Q[c] - Q[a], Q[c + 1] - Q[a + 1], Q[c + 2] - Q[a + 2]];
    const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
    if (Math.abs(det) < 1e-12) continue;
    const t0 = [o[0] - Q[a], o[1] - Q[a + 1], o[2] - Q[a + 2]];
    const u = (t0[0] * pv[0] + t0[1] * pv[1] + t0[2] * pv[2]) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t > 1e-9) out.push(t);
  }
  out.sort((x, y) => x - y);
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-6);
}
{
  const half = img(64, 64, (x) => (x < 32 ? 1 : 0));
  const H = { image: half, edgeFade: 0, overhangGuard: false, foot: false, hanger: 'none', fit: 'crop', imageWidth: 80, imageHeight: 50, radius: 70 };
  /** Thickness seen from a viewer standing along N (horizontal, unit) from the
   *  centre, at u mm to their right. */
  const seen = (m, N, u) => {
    const b = m.bbox(), z = (b.min[2] + b.max[2]) / 2, R = [-N[1], N[0]];
    const o = [b.center[0] + 300 * N[0] + u * R[0], b.center[1] + 300 * N[1] + u * R[1], z];
    const h = rayHits(m, o, [-N[0], -N[1], 0]);
    return h.length >= 2 ? h[1] - h[0] : NaN;
  };
  const reads = (m, N) => { const l = seen(m, N, -15), r = seen(m, N, 15); return { ok: l < 1.0 && r > 2.8, l, r }; };
  for (const shape of ['arc-out', 'arc-in']) {
    const m = mesh({ ...H, shape });
    // Which way the curve bulges: the outer surface's middle stands further
    // along that direction than its two ends.
    let mid = -Infinity, end = -Infinity;
    const b = m.bbox();
    for (let i = 0; i < m.vertCount; i++) {
      const [x, y] = m.vertex(i);
      if (Math.abs(y - b.center[1]) < 2) mid = Math.max(mid, x);
      else if (Math.abs(y - b.center[1]) > b.size[1] / 2 - 2) end = Math.max(end, x);
    }
    const N = mid > end ? [1, 0] : [-1, 0];
    const r = reads(m, N);
    check(`${shape}: from outside the convex face, the bright half is on the viewer's left`, r.ok,
      `convex towards ${N[0] > 0 ? '+X' : '-X'}; left ${r.l.toFixed(2)} mm, right ${r.r.toFixed(2)} mm`);
  }
  {
    const m = mesh({ ...H, shape: 'flat' });
    const back = reads(m, [0, -1]), front = reads(m, [0, 1]);
    check('flat: reads the right way round from its front, the relief face (+Y)', front.ok,
      `left ${front.l.toFixed(2)} mm, right ${front.r.toFixed(2)} mm`);
    check('flat: and back to front from its smooth back (-Y): one reading side', !back.ok,
      `left ${back.l.toFixed(2)} mm, right ${back.r.toFixed(2)} mm`);
  }
}

// ===========================================================================
// Frame, hanger, foot
// ===========================================================================
console.log('\n-- frame and mounting --');
{
  const none = mesh({ hanger: 'none', frameWidth: 8 });
  check('with no hanger the plate is a simple solid (Euler 2)', topology(none).euler === 2, `chi = ${topology(none).euler}`);
  for (const kind of ['teardrop', 'round', 'slot']) {
    const m = mesh({ hanger: kind, hangerDia: 4, frameWidth: 8 });
    isSolid(`a ${kind} hanger`, m);
    check(`the ${kind} hanger is a hole right through (Euler 0)`, topology(m).euler === 0,
      `chi = ${topology(m).euler}`);
    check(`the ${kind} hanger removes material`, m.volume() < none.volume() - 4,
      `${(none.volume() - m.volume()).toFixed(2)} mm³ removed`);
  }
  const tear = ceilingAngle(hangerOutline(mesh({ hanger: 'teardrop', hangerDia: 4, frameWidth: 8 })));
  const round = ceilingAngle(hangerOutline(mesh({ hanger: 'round', hangerDia: 4, frameWidth: 8 })));
  check('the teardrop hanger has a 45 degree roof, so it needs no support', tear >= 44.9,
    `shallowest ceiling ${tear.toFixed(1)} degrees from horizontal`);
  check('...and the round one genuinely does not, which is why it is not the default',
    round < 20, `round ceiling ${round.toFixed(1)} degrees`);
}
{
  const m = mesh({ frameWidth: 1, hangerDia: 8, hanger: 'teardrop' });
  isSolid('a hanger too big for its frame', m);
  check('a hanger that will not fit its frame is left out rather than punched through the edge',
    topology(m).euler === 2, `chi = ${topology(m).euler}`);
  check('...and validate() says so, by name',
    gen.validate({ ...FAST, frameWidth: 1, hangerDia: 8 }).some(i => i.param === 'frameWidth' && /hanger/i.test(i.message)));
  check('a hanger with the frame turned off is refused with a reason',
    gen.validate({ ...FAST, frame: false, hanger: 'teardrop' }).some(i => i.param === 'hanger'));
}
{
  const r = build({ frameThickness: 1.6, maxThickness: 5 });
  near('a frame thinner than the picture is raised to meet it, not left to be pierced',
    asMesh(r).bbox().size[1], 5, 1e-6);
  check('...and validate() explains the change',
    gen.validate({ ...FAST, frameThickness: 1.6, maxThickness: 5 }).some(i => i.param === 'frameThickness'));
}
{
  const plain = mesh({ shape: 'flat', foot: false });
  const shod = mesh({ shape: 'flat', foot: true, footDepth: 8, footHeight: 4 });
  isSolid('a flat panel on a foot', shod);
  near('the flat foot spreads footDepth each side', shod.bbox().size[1] - plain.bbox().size[1], 16, 1e-6);
  near('and stands the panel on footHeight plus a 45 degree taper',
    shod.bbox().size[2] - plain.bbox().size[2], 4 + 8, 1e-6);
}
{
  // At source resolution, or the enlargement smooths the horizon before the
  // guard ever sees it and the check passes for the wrong reason.
  const hard = img(600, 600, (_x, y) => (y < 300 ? 0 : 1));   // black sky over a bright horizon
  const off = thicknessMap({ ...P, image: hard, overhangGuard: false, frame: false, edgeFade: 0 }, C);
  const on = thicknessMap({ ...P, image: hard, overhangGuard: true, frame: false, edgeFade: 0 }, C);
  const worstRise = (tm) => {
    const dw = tm.nu + 1, dz = tm.H / tm.nv;
    let w = 0;
    for (let j = 0; j < tm.nv; j++) for (let i = 0; i <= tm.nu; i++) {
      const r = (tm.t[(j + 1) * dw + i] - tm.t[j * dw + i]) / dz;
      if (r > w) w = r;
    }
    return w;
  };
  check('a hard horizontal edge really is an unprintable step without the guard', worstRise(off) > 2.5,
    `${worstRise(off).toFixed(2)} mm of relief per mm of height, past the 2.0 limit — at 0.1 mm layers that is ` +
    `${(worstRise(off) * 0.1).toFixed(2)} mm of unsupported offset per layer against a 0.42 mm extrusion`);
  check('the overhang guard ramps it to a printable slope', worstRise(on) <= 2.0 + 1e-6,
    `${worstRise(off).toFixed(2)} mm per mm becomes ${worstRise(on).toFixed(2)}`);
  check('and it corrects by adding material below, never by taking detail from above',
    on.t.every((v, i) => v >= off.t[i] - 1e-9));
}

// ===========================================================================
// G7 — presets worth having
// ===========================================================================
console.log('\n-- presets --');
{
  check('there are at least four presets', gen.presets.length >= 4, `${gen.presets.length}`);
  check('none of them is named after a number',
    gen.presets.every(pr => !/\b(preset\s*)?\d+\b/i.test(pr.name)),
    gen.presets.map(pr => pr.name).join(' | '));
  const shapes = new Set(gen.presets.map(pr => pr.values.shape || 'flat'));
  check('they cover at least three of the four shapes', shapes.size >= 3, [...shapes].join(', '));
  let worst = 0;
  for (const pr of gen.presets) {
    const p = { ...P, ...pr.values };
    const m = asMesh(gen.build(p, C));
    const errs = gen.validate(p).filter(i => i.severity === 'error');
    check(`preset "${pr.name}" fits the bed and validates clean`,
      errs.length === 0 && m.bbox().size.every((v, k) => v <= [180, 180, 180][k]),
      `${m.bbox().size.map(v => v.toFixed(0)).join('×')} mm${errs.length ? ', ' + errs[0].message : ''}`);
    worst = Math.max(worst, m.triCount);
  }
  check('and no preset blows the triangle budget', worst <= 300000, `worst ${worst} triangles`);
}

// ===========================================================================
// G8 — printability is thought about
// ===========================================================================
console.log('\n-- printability --');
{
  const h = gen.hints(P);
  const pitch = Math.max(...[gen.build(P, C).meta.picture.pitchMM]);
  check(`hints() recommends a layer height at or below the pixel pitch`,
    h.layerH <= pitch + 1e-9, `${h.layerH} mm layers against a ${pitch.toFixed(2)} mm pitch`);
  check('hints() asks for 100% infill', h.infill === 100, String(h.infill));
  check('hints() asks for no top solid layers', h.topLayers === 0, String(h.topLayers));
  check('hints() says no supports', h.supports === false);
  check('hints() names a filament', typeof h.filament === 'string' && /PLA/.test(h.filament), h.filament);
  check('hints() returns the mapping curve for the panel to draw',
    Array.isArray(h.mapping) && h.mapping.length === 21 &&
    Math.abs(h.mapping[0][1] - P.maxThickness) < 1e-9 &&
    Math.abs(h.mapping[20][1] - P.minThickness) < 1e-9 &&
    h.mapping.every((q, i) => i === 0 || q[1] <= h.mapping[i - 1][1] + 1e-12),
    `${h.mapping.length} samples falling monotonically from ${h.mapping[0][1].toFixed(2)} mm at black to ${h.mapping[20][1].toFixed(2)} mm at white`);
  check('hints() shows the mapping as a curve you can read in a terminal',
    h.notes.some(n => /[▁▂▃▄▅▆▇█]{5,}/.test(n)));
  const text = h.notes.join(' ');
  check('hints() explains that dark is thick, which is the error to catch', /[Dd]ark is thick/.test(text));
  check('hints() warns about the infill', /100% infill/.test(text));
  check('hints() warns about ironing, which quietly ruins the picture', /[Ii]roning/.test(text));
  check('hints() warns about the seam, which prints as blobs across the picture', /[Ss]eam/.test(text));
  check('hints() says why it is printed standing up',
    /standing/i.test(text) && /layer/i.test(text));
}
{
  const flat = gen.hints({ ...P, shape: 'flat', foot: false });
  const arc = gen.hints({ ...P, shape: 'arc-out' });
  check('a flat panel is told to use a brim; a curved one is not',
    flat.brim === true && arc.brim === false);
}
{
  // Deliberately unprintable, three different ways. Each must be caught by
  // validate() rather than turning into a solid nobody can put on the bed.
  const wide = { ...P, image: photoish(400, 120), fit: 'aspect', imageWidth: 170, frameWidth: 15 };
  const errW = gen.validate(wide).filter(i => i.severity === 'error');
  check('a panel wider than the bed is an error, naming the measurement',
    errW.length > 0 && /180/.test(errW[0].message), errW[0] ? errW[0].message.slice(0, 110) : 'no error');
  check('...and it still builds, so the refusal comes from validate() and not from a crash',
    !!asMesh(gen.build(wide, C)));
  const tall = { ...P, fit: 'crop', imageWidth: 60, imageHeight: 170, frameWidth: 15 };
  check('a panel taller than the build volume is an error',
    gen.validate(tall).some(i => i.severity === 'error'));
  const flatTone = { ...P, minThickness: 1.6, maxThickness: 1.6 };
  const errT = gen.validate(flatTone).filter(i => i.severity === 'error');
  check('a tone range with no range in it is an error', errT.length > 0 && errT[0].param === 'maxThickness',
    errT[0] ? errT[0].message.slice(0, 100) : 'no error');
  isSolid('...and that one still builds too', asMesh(gen.build(flatTone, C)));
  check('a single-tone photograph is reported before it is printed',
    gen.validate({ ...P, image: oneTone(0.4) }).some(i => i.param === 'image' && i.severity === 'warn'));
  check('an arc that would close on itself is opened out, with the reason given',
    gen.validate({ ...FAST, shape: 'arc-out', radius: 20, imageWidth: 170 })
      .some(i => i.param === 'radius' && /close/i.test(i.message)));
}

// ===========================================================================
// Determinism and quality
// ===========================================================================
console.log('\n-- determinism --');
for (const shape of ['arc-in', 'shade']) {
  const a = mesh({ shape }).toSTL('t'), b = mesh({ shape }).toSTL('t');
  let same = a.length === b.length;
  for (let i = 84; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
  check(`"${shape}" builds byte-identically twice`, same, `${a.length} bytes`);
}
{
  const im = testImage(64, 64);
  const before = Array.from(im.gray);
  gen.build({ ...FAST, image: im }, C);
  check('build() does not write into the photograph it was given',
    before.every((v, i) => v === im.gray[i]));
}
{
  const d = mesh({}, 'draft'), n = mesh({}, 'normal'), f = mesh({}, 'fine');
  check('quality scales the grid, draft through fine',
    d.triCount < n.triCount && n.triCount <= f.triCount,
    `${d.triCount} -> ${n.triCount} -> ${f.triCount} triangles`);
  isSolid('the draft build', d);
}

// ===========================================================================
// The caption
//
// Three styles that are three different solids, not three labels on one: the
// raised one adds material in front of the frame, the engraved one takes it out
// of the front, and the lit one takes it out of the BACK and mirrors the words
// on the way. Each is measured off the built mesh rather than off the plan,
// because the plan is the thing that would be wrong.
// ===========================================================================
console.log('\n-- the caption --');
{
  const base = { ...FAST, shape: 'flat', frame: true, frameWidth: 7, frameThickness: 3.6,
                 foot: false, hanger: 'none', captionHeight: 8 };
  const cap = (over) => build({ ...base, ...over });
  const nearly = (a, b, tol) => Math.abs(a - b) <= tol;
  const plain = cap({ caption: '' });
  const T = 3.6;

  /**
   * Vertices inside the caption band, with Y measured from the back of the
   * panel. build() centres the object on the origin in X and Y, so a raw Y is
   * relative to a centre that MOVES when the raised letters change the depth —
   * rebasing on the back face is what makes 0 mean "the back" in every style.
   */
  const inBand = (r) => {
    const m = asMesh(r), band = r.meta.caption.bandMM, y0 = m.bbox().min[1], out = [];
    for (let i = 0; i < m.vertCount; i++) {
      const v = m.vertex(i);
      if (v[2] < band - 1e-9) out.push([v[0], v[1] - y0, v[2]]);
    }
    return out;
  };
  /** The distinct Y planes a set of vertices sits on, to 3 decimals. */
  const yPlanes = (verts) => [...new Set(verts.map(v => r3(v[1])))].sort((a, b) => a - b);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const planesAre = (verts, want) => JSON.stringify(yPlanes(verts)) === JSON.stringify(want.map(r3));

  // ---- the band, and what it does to the picture --------------------------
  const raised = cap({ caption: 'HELLO', captionStyle: 'raised', captionRelief: 0.8 });
  check('a caption leaves the picture exactly the size it was',
    raised.meta.picture.widthMM === plain.meta.picture.widthMM &&
    raised.meta.picture.heightMM === plain.meta.picture.heightMM,
    `${raised.meta.picture.widthMM} x ${raised.meta.picture.heightMM} mm`);
  near('the panel grows by the band and by nothing else',
    asMesh(raised).bbox().size[2] - asMesh(plain).bbox().size[2],
    raised.meta.caption.bandMM - 7, 1e-6);
  check('the band is deeper than the frame it replaced',
    raised.meta.caption.bandMM > 7, `${raised.meta.caption.bandMM.toFixed(1)} mm against a 7 mm border`);
  const twoLine = cap({ caption: 'WITH LOVE\nFROM US BOTH', captionStyle: 'raised' });
  check('a second line asks for more band, not a smaller face',
    twoLine.meta.caption.bandMM > raised.meta.caption.bandMM &&
    nearly(twoLine.meta.caption.capHeightMM, raised.meta.caption.capHeightMM, 0.01),
    `${twoLine.meta.caption.bandMM.toFixed(1)} mm vs ${raised.meta.caption.bandMM.toFixed(1)} mm`);

  // ---- raised: material in front of the frame -----------------------------
  near('raised: the object is exactly the relief deeper than the frame',
    asMesh(raised).bbox().size[1], T + 0.8, 1e-6);
  {
    const m = asMesh(raised);
    let above = 0;
    for (let i = 0; i < m.vertCount; i++) {
      const v = m.vertex(i);
      const y = v[1] - m.bbox().min[1];
      if (v[2] > raised.meta.caption.bandMM + 1e-6 && y > above) above = y;
    }
    near('raised: nothing above the band stands proud of the frame', above, T, 1e-6);
  }
  check('raised: the letters are part of the panel, not fifteen loose solids on top of it',
    shellsOf(asMesh(raised)).count === 1, `${shellsOf(asMesh(raised)).count} shells`);

  // Volume against `plain` would only prove the band exists. What proves the
  // LETTERS exist is that the volume tracks the relief linearly, at a rate that
  // is the area of the ink — and that same area comes back out of the engraved
  // one, which is the check that the three styles are three treatments of one
  // piece of text rather than three separate pieces of code.
  const inkArea = (a, b, over) =>
    (asMesh(cap(a)).volume() - asMesh(cap(b)).volume()) / over;
  {
    const t8 = { caption: 'HELLO', captionStyle: 'raised', captionRelief: 0.8 };
    const t12 = { ...t8, captionRelief: 1.2 };
    const t16 = { ...t8, captionRelief: 1.6 };
    const a1 = inkArea(t12, t8, 0.4), a2 = inkArea(t16, t12, 0.4);
    nearPct('raised: the volume grows with the relief at exactly the ink area', a1, a2, 0.1);
    check('...and that area is a plausible line of type, not a rounding error',
      a1 > 20 && a1 < 2000, `${a1.toFixed(1)} mm2 of ink`);
    const e2 = { caption: 'HELLO', captionStyle: 'engraved', captionDepth: 0.2 };
    const e6 = { ...e2, captionDepth: 0.6 };
    nearPct('engraved: the same letters take the same area back out again',
      inkArea(e2, e6, 0.4), a1, 0.5);
  }

  // ---- engraved: a pocket in the front ------------------------------------
  const engraved = cap({ caption: 'HELLO', captionStyle: 'engraved', captionDepth: 0.7 });
  near('engraved: the object is no deeper than the frame', asMesh(engraved).bbox().size[1], T, 1e-6);
  check('engraved: the band sits on three planes — back, pocket floor, front',
    planesAre(inBand(engraved), [0, T - 0.7, T]),
    yPlanes(inBand(engraved)).join(', '));

  // ---- lit: a pocket in the back, mirrored --------------------------------
  const lit = cap({ caption: 'HELLO', captionStyle: 'lit', captionGlow: 0.8 });
  check('lit: the pocket is cut from the back, leaving the asked-for skin in front',
    planesAre(inBand(lit), [0, T - 0.8, T]) &&
    nearly(lit.meta.caption.remainingMM, 0.8, 1e-9),
    yPlanes(inBand(lit)).join(', '));
  check('lit: the skin left in front is thin enough to pass light',
    lit.meta.caption.remainingMM <= 1.0, `${lit.meta.caption.remainingMM.toFixed(2)} mm`);
  {
    // Reading order, from the front (+Y), for every style. "IW": a narrow
    // letter then a wide one. Standing at +Y and facing -Y, the viewer's right
    // is -X (up x towards-the-viewer), so the I, read first, must be at the
    // larger X. Each style's ink is found on its own surface: raised standing
    // proud of the frame, engraved and lit on their pocket floors.
    const inkOf = (style, r) => inBand(r).filter(v => style === 'raised'
      ? v[1] > T + 1e-6
      : v[1] > 1e-6 && v[1] < T - 1e-6);
    for (const style of ['raised', 'engraved', 'lit']) {
      const r = cap({ caption: 'IW', captionStyle: style, captionHeight: 10 });
      const xs = [...new Set(inkOf(style, r).map(v => Math.round(v[0] * 1e4) / 1e4))].sort((a, b) => a - b);
      let gap = 0, at = 0;
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; at = i; }
      const lo = xs.slice(0, at), hi = xs.slice(at);
      const width = (g) => g[g.length - 1] - g[0];
      const iAtHigherX = lo.length > 1 && hi.length > 1 && width(hi) < width(lo);
      check(`${style}: "IW" reads I then W from the front`, iAtHigherX,
        `glyph at -X ${lo.length ? width(lo).toFixed(2) : '?'} mm wide, glyph at +X ${hi.length ? width(hi).toFixed(2) : '?'} mm wide`);
    }
    // Photograph and caption on ONE plate, both from the front. "Birthday
    // card" with a half-white picture and "IW" in each style: the bright half
    // on the viewer's left from +Y, and the I read first. A plate whose photo
    // and words read from different sides fails here even if each passes alone.
    // The preset's foot is left off: it spreads the plate in Y and under the
    // caption band, which moves the reference faces and not the handedness.
    const card = gen.presets.find(pr => pr.name === 'Birthday card').values;
    const half = img(64, 64, (x) => (x < 32 ? 1 : 0));
    for (const style of ['raised', 'engraved', 'lit']) {
      const r = gen.build({ ...defaults(gen), ...card, foot: false, pixelPitch: 1.0, image: half, edgeFade: 0, overhangGuard: false,
                            caption: 'IW', captionStyle: style, captionHeight: 10 }, C);
      const m = asMesh(r), b = m.bbox();
      const zPic = b.max[2] - card.frameWidth - r.meta.picture.heightMM / 2;
      const th = (u) => {   // from +Y, u mm to the viewer's right, which is world -X
        const h = rayHits(m, [b.center[0] - u, b.max[1] + 300, zPic], [0, -1, 0]);
        return h.length >= 2 ? h[1] - h[0] : NaN;
      };
      const photoOk = th(-15) < 1.0 && th(15) > 2.8;
      const y0 = b.min[1], Tc = card.frameThickness, band = r.meta.caption.bandMM;
      const ink = [];
      for (let i = 0; i < m.vertCount; i++) {
        const v = m.vertex(i), y = v[1] - y0;
        if (v[2] >= band - 1e-9) continue;
        if (style === 'raised' ? y > Tc + 1e-6 : y > 1e-6 && y < Tc - 1e-6) ink.push(Math.round(v[0] * 1e4) / 1e4);
      }
      const xs = [...new Set(ink)].sort((a, c) => a - c);
      let gap = 0, at = 0;
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; at = i; }
      const lo = xs.slice(0, at), hi = xs.slice(at), w = (g) => g[g.length - 1] - g[0];
      const textOk = lo.length > 1 && hi.length > 1 && w(hi) < w(lo);
      check(`Birthday card, ${style}: photo and caption both read the right way round from the front (+Y)`,
        photoOk && textOk, `photo left ${th(-15).toFixed(2)} / right ${th(15).toFixed(2)} mm; text ${textOk ? 'I then W' : 'W then I'}`);
    }
  }

  // ---- refusals -----------------------------------------------------------
  {
    const curved = { ...base, shape: 'arc-out', radius: 70, caption: 'HELLO' };
    const w = gen.validate(curved).filter(i => i.param === 'caption');
    check('a caption on a curved panel is refused by name rather than half-built',
      w.length === 1 && w[0].severity === 'warn', w[0] ? w[0].message.slice(0, 80) : 'no issue raised');
    check('...and the curved panel comes out identical to the one that never asked',
      asMesh(gen.build(curved, C)).volume() === asMesh(gen.build({ ...curved, caption: '' }, C)).volume());
    const bare = { ...base, frame: false, caption: 'HELLO' };
    check('a caption with no frame to sit in is refused',
      gen.validate(bare).some(i => i.param === 'caption' && i.severity === 'warn'));
    isSolid('...and that one still builds', asMesh(gen.build(bare, C)));
  }
  {
    const a = asMesh(cap({ caption: '' })).toSTL('t');
    const b = asMesh(cap({ caption: '   ' })).toSTL('t');
    let same = a.length === b.length;
    for (let i = 84; i < a.length && same; i++) if (a[i] !== b[i]) same = false;
    check('an empty caption changes not one triangle', same, `${a.length} vs ${b.length} bytes`);
  }

  // ---- a message too big for the panel ------------------------------------
  {
    const long = cap({ caption: 'MANY HAPPY RETURNS OF THE DAY', captionHeight: 20, captionStyle: 'raised' });
    const m = asMesh(long), panelW = long.meta.picture.widthMM + 14;
    let outside = 0;
    for (let i = 0; i < m.vertCount; i++) if (Math.abs(m.vertex(i)[0]) > panelW / 2 + 1e-6) outside++;
    check('a message wider than the panel is shrunk rather than allowed to overrun',
      long.meta.caption.shrunkTo < 1 && outside === 0,
      `shrunk to ${(long.meta.caption.shrunkTo * 100).toFixed(0)}%, ${outside} vertices past the edge`);
    check('...and the shrink is reported against the letter height that was asked for',
      gen.validate({ ...base, caption: 'MANY HAPPY RETURNS OF THE DAY', captionHeight: 20 })
        .some(i => i.param === 'captionHeight'));
  }

  // ---- every style, every face, still a solid -----------------------------
  // And no zero-area triangles, counted by analyze() as the analysis panel
  // counts them. The caption's seams are closed by healTJunctions, whose plain
  // fan left 294 on "Engraved keepsake"; isSolid() only sees a triangle with a
  // repeated corner, so it passed all of them.
  for (const style of ['raised', 'engraved', 'lit']) {
    for (const font of ['LiberationSansNarrow-Regular', 'DejaVuSansMono', 'Quicksand-Bold']) {
      const m = asMesh(cap({ caption: 'With love', captionStyle: style, captionFont: font }));
      isSolid(`"With love" set ${style} in ${font.split('-')[0]}`, m);
      const d = analyze(m).degenerateTris;
      check(`"With love" set ${style} in ${font.split('-')[0]}: no degenerate triangles`, d === 0, `${d} degenerate`);
    }
  }
  for (const pr of gen.presets.filter(pr => String(pr.values.caption ?? '').trim())) {
    const a = analyze(asMesh(gen.build({ ...defaults(gen), ...pr.values }, C)));
    check(`preset "${pr.name}": no degenerate triangles, as the analysis panel counts them`,
      a.degenerateTris === 0 && a.watertight, `${a.degenerateTris} degenerate, watertight ${a.watertight}`);
  }
  check('a character the face does not have is dropped and named',
    gen.validate({ ...base, caption: 'Happy 😀 day' })
      .some(i => i.param === 'caption' && /😀/.test(i.message)));
}

done();
