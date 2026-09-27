// Shelf-edge hanger. A clip that saddles a shelf's front edge and hangs a
// hairbrush off the front of it by the head.
//
// Everything here is measured off the MESH, never off the parameters or the
// meta block: a generator that reports what it meant rather than what it built
// is exactly the failure this catalogue has been bitten by before. The clip's
// throat is gauged by probing the solid, and the two claims that matter — "a
// 17.5 mm shelf goes in" and "the brush hangs on a ledge" — are asked as
// assembly questions, by intersecting the part with a virtual shelf and a
// virtual brush and looking at the volume that comes back.
import { suite, check, near, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { triGrid, pointInsideMesh, faceOverhangs } from '../js/kernel/validate.js';
import { intersect, subtractAll } from '../js/kernel/csg.js';
import { box } from '../js/kernel/builders.js';
import gen from '../js/gen/shelfclip.js';

suite('gen shelfclip');
conformance(gen, 'shelfclip');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));
const D = defaults(gen);

// ---------------------------------------------------------------------------
// Probing. One grid per mesh, then solid/void runs along a line.
// ---------------------------------------------------------------------------

function prober(mesh) {
  const grid = triGrid(mesh);
  return (x, y, z) => pointInsideMesh(grid, [x, y, z]);
}

/** Solid runs along `axis` between a and b, at `step` resolution. */
function runs(solid, axis, from, to, at, step = 0.05) {
  const pt = (v) => (axis === 'x' ? [v, at[0], at[1]] : axis === 'y' ? [at[0], v, at[1]] : [at[0], at[1], v]);
  const out = [];
  let open = null;
  for (let v = from; v <= to + 1e-9; v += step) {
    const s = solid(...pt(v));
    if (s && open === null) open = v;
    if (!s && open !== null) { out.push([open, v - step]); open = null; }
  }
  if (open !== null) out.push([open, to]);
  return out;
}

/** Void runs are the complement of the solid ones inside [from, to]. */
function voids(solid, axis, from, to, at, step = 0.05) {
  const s = runs(solid, axis, from, to, at, step);
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) out.push([s[i][1], s[i + 1][0]]);
  return out;
}

// ---------------------------------------------------------------------------
// It clips the shelf.
// ---------------------------------------------------------------------------
{
  const m = build();
  const b = m.bbox();
  const solid = prober(m);
  const zMid = (b.min[2] + b.max[2]) / 2;

  // At the very back of the part only the two clip legs exist, so a line up
  // through them finds solid, void, solid — and the void is the throat. The
  // bead sits further forward, so this gauges the jaw, not the grip.
  const back = b.min[0] + 2;
  const gaps = voids(solid, 'y', b.min[1], b.max[1], [back, zMid], 0.02);
  check('the back of the clip is two legs with one throat between them', gaps.length === 1,
    `${gaps.length} voids at x=${back.toFixed(1)}`);

  const throat = gaps.length === 1 ? gaps[0][1] - gaps[0][0] : NaN;
  near('the throat is the board plus its clearance, measured off the mesh',
    throat, D.boardT + D.clear, 0.06);

  // The joint, not the part. A virtual shelf, filling the throat and stopping
  // at the spine, is pushed in and the interference is weighed.
  const midThroat = (gaps[0][0] + gaps[0][1]) / 2;
  const spineRuns = runs(solid, 'x', b.min[0] - 1, b.max[0], [midThroat, zMid], 0.02);
  check('forward of the throat there is one spine and nothing else', spineRuns.length === 1,
    `${spineRuns.length} solid runs across the throat`);
  const xSpine = spineRuns[0][0];

  // How far the shelf can actually go in. The root fillets are material at the
  // inside of both corners, so the board seats against them rather than against
  // the spine — which is fine, and is a number worth stating rather than
  // assuming. Found by walking in along the board's own top face.
  const faceY = midThroat + D.boardT / 2;
  const firstSolid = runs(solid, 'x', b.min[0] - 1, b.max[0], [faceY, zMid], 0.02)[0];
  const xEngage = firstSolid ? firstSolid[0] : xSpine;
  const engage = xEngage - b.min[0];
  check('the clip swallows a useful depth of shelf, not just its lip',
    engage > 20 && engage >= D.legBot - D.fillet - 1, `${engage.toFixed(1)} mm of a ${D.legBot} mm leg`);

  const shelfAt = (t, x1 = xEngage - 0.02) => {
    const x0 = b.min[0] - 5, lz = b.size[2] + 20;
    return box(x1 - x0, t, lz).translate((x0 + x1) / 2, midThroat, zMid - lz / 2);
  };
  const smooth = asMesh(gen.build({ ...D, gripH: 0 }, C));
  const slides = intersect(smooth, shelfAt(D.boardT)).volume();
  check('with the bead off, a shelf of the stated thickness slides in to that depth',
    slides < 2, `${slides.toFixed(2)} mm³ of interference`);

  const bites = intersect(m, shelfAt(D.boardT)).volume();
  check('with the bead on, the same shelf is gripped — a little, and only at the bead',
    bites > 3 && bites < 120, `${bites.toFixed(1)} mm³ of interference`);

  const tooThick = intersect(smooth, shelfAt(D.boardT + 1.5)).volume();
  check('and a shelf 1.5 mm thicker fouls the jaw, so the gauge can fail',
    tooThick > 300, `${tooThick.toFixed(0)} mm³ of interference`);
}

// ---------------------------------------------------------------------------
// It hangs a brush.
//
// A paddle brush has no hanging hole, so the only thing holding it up is the
// step from neck to head landing on the plate. That is an assembly question,
// and it is asked here with a virtual brush rather than by reading the slot's
// nominal width back out of the parameters. Everything is located by walking
// the mesh, because the plate rakes and the slot's root is round: neither the
// resting height nor the seating depth is a number you can assume.
// ---------------------------------------------------------------------------

/** Locate the plate on a built mesh: its raked top face, and the hole in it.
 *  Nothing here may assume the slot reaches the nose — on a closed hole it does
 *  not, which is the entire point of it. */
function rig(mesh) {
  const b = mesh.bbox();
  const solid = prober(mesh);
  const zOut = b.min[2] + 2;                        // a solid ledge, clear of the slot
  const topAt = (x) => { let t = null; for (let y = b.min[1]; y < b.min[1] + 16; y += 0.01) if (solid(x, y, zOut)) t = y; return t; };

  // Walk in from the nose until a gap appears across the plate: that station is
  // inside the opening, whatever shape it is.
  let xIn = null, gap = null;
  for (let x = b.max[0] - 0.5; x > b.min[0]; x -= 0.4) {
    const ty = topAt(x);
    if (ty === null) continue;
    const g = voids(solid, 'z', b.min[2], b.max[2], [x, ty - 0.3], 0.05);
    if (g.length === 1) { xIn = x; gap = g[0]; break; }
  }
  const zc = gap ? (gap[0] + gap[1]) / 2 : (b.min[2] + b.max[2]) / 2;
  const found = !!gap;

  // How far the opening runs, at a given offset from its centreline.
  const openAt = (zOff) => {
    let back = xIn, front = xIn;
    for (let x = xIn; x > b.min[0]; x -= 0.05) { const ty = topAt(x); if (ty === null || solid(x, ty - 0.3, zc + zOff)) break; back = x; }
    for (let x = xIn; x < b.max[0]; x += 0.05) { const ty = topAt(x); if (ty === null || solid(x, ty - 0.3, zc + zOff)) break; front = x; }
    return { back, front, len: front - back };
  };
  // Where a body `w` wide comes to rest against the back of the opening.
  const seat = (w) => Math.max(openAt(-w / 2).back, openAt(0).back, openAt(w / 2).back) + 0.5;
  const restOn = (x0, depth) => { let t = -Infinity; for (let x = x0; x <= Math.min(x0 + depth, b.max[0] - 0.3); x += 0.5) t = Math.max(t, topAt(x)); return t; };
  return { b, solid, topAt, zc, openAt, seat, restOn, found, xIn };
}

{
  const m = build();
  const R = rig(m);
  check('the plate has exactly one opening through it', R.found, 'one gap across the plate');

  const depth = R.openAt(0).len;
  check('the opening is deep enough to swallow a handle, not just nick it',
    depth >= D.slotDepth - 1.5, `${depth.toFixed(1)} mm back to front on the centreline`);

  // The virtual brush. A fat handle and the narrowest head worth supporting.
  const NECK_W = 24, NECK_T = 14, HEAD_W = 55, HEAD_T = 20;
  const xNeck = R.seat(NECK_W);
  const prism = (mesh, zc, w, t, h, x0, y0) => box(t, h, w).translate(x0 + t / 2, y0 + h / 2, zc - w / 2);

  const fouls = intersect(m, prism(m, R.zc, NECK_W, NECK_T, R.b.size[1] + 20, xNeck, R.b.min[1] - 10)).volume();
  check('a 24 x 14 mm handle drops through where it comes to rest against the back',
    fouls < 2, `${fouls.toFixed(2)} mm³ of interference`);

  const yRest = R.restOn(xNeck, HEAD_T);
  const restsOn = intersect(m, prism(m, R.zc, HEAD_W, HEAD_T, 40, xNeck, yRest + 0.2)).volume();
  check('a 55 mm head clears the plate when it is resting on it',
    restsOn < 2, `${restsOn.toFixed(2)} mm³ of interference`);
  const pressed = intersect(m, prism(m, R.zc, HEAD_W, HEAD_T, 40, xNeck, yRest - 3)).volume();
  check('and lands on a real ledge — 3 mm lower and it is inside the plate',
    pressed > 200, `${pressed.toFixed(0)} mm³ of interference`);

  // The falsification, shipped next to the assertion so it cannot pass
  // vacuously: widen the slot past the head, locate it exactly the same way,
  // and the head has to fall straight through.
  const wide = asMesh(gen.build({ ...D, slotW: HEAD_W + 6 }, C));
  const W = rig(wide);
  const xw = W.seat(NECK_W);
  const escapes = intersect(wide, prism(wide, W.zc, HEAD_W, HEAD_T, 40, xw, W.restOn(xw, HEAD_T) + 0.2)).volume();
  check('a slot wider than the head catches nothing, so the ledge check is not vacuous',
    escapes < 1, `${escapes.toFixed(1)} mm³ with a ${HEAD_W + 6} mm slot under a ${HEAD_W} mm head`);
}

// ---------------------------------------------------------------------------
// It holds on to the brush.
//
// The first print slid straight off: an open-fronted slot only holds what is
// pushed into it, and a brush whose head fouls the shelf above levers its own
// neck forward out of the mouth. A closed hole cannot be levered out of, which
// is the whole reason for it, so the check is not "is there a hole" but "can
// the brush get out".
// ---------------------------------------------------------------------------
{
  const m = build();
  const R = rig(m);
  const b = R.b;

  // The nose of the plate is unbroken all the way across.
  const front = b.max[0] - 1.5;
  const acrossNose = voids(R.solid, 'z', b.min[2], b.max[2], [front, R.topAt(front) - 0.3], 0.02);
  check('the plate\'s nose is solid across its full width — the hole is closed',
    acrossNose.length === 0, `${acrossNose.length} gaps at the nose`);

  // The whole handle now passes through, not just the neck: you thread it.
  const HAND_W = 32, HAND_T = 18, HEAD_W = 55;
  const holeZc = R.zc;
  const o = R.openAt(HAND_W / 2);                    // the opening where the handle's edge sits
  const xHole = o.back + (o.len - HAND_T) / 2;       // the handle, centred in it
  const thread = (w, t, x0) => box(t, b.size[1] + 20, w).translate(x0 + t / 2, b.min[1] - 10 + (b.size[1] + 20) / 2, holeZc - w / 2);
  const passes = intersect(m, thread(HAND_W, HAND_T, xHole)).volume();
  check('a 32 x 18 mm handle threads straight down through the hole',
    passes < 2, `${passes.toFixed(2)} mm³ of interference`);

  // And the head still cannot.
  const yRest = R.restOn(xHole, HAND_T);
  const caught = intersect(m, box(HAND_T, 40, HEAD_W).translate(xHole + HAND_T / 2, yRest - 3 + 20, holeZc - HEAD_W / 2)).volume();
  check('a 55 mm head still lands on the plate rather than following it through',
    caught > 200, `${caught.toFixed(0)} mm³ of interference 3 mm below resting`);

  // The claim that matters: it cannot be walked out of the front.
  const shoved = intersect(m, thread(HAND_W, HAND_T, xHole + o.len)).volume();
  check('and a handle shoved forward by a slot-length hits the nose — it is captive',
    shoved > 100, `${shoved.toFixed(0)} mm³ of interference when pushed ${o.len.toFixed(0)} mm forward`);

  // The open-fronted variant is still available, and is still open.
  const open = asMesh(gen.build({ ...D, mouth: 'open' }, C));
  const ob = open.bbox();
  const oSolid = prober(open);
  const oTop = (x) => { let t = null; for (let y = ob.min[1]; y < ob.min[1] + 16; y += 0.01) if (oSolid(x, y, ob.min[2] + 2)) t = y; return t; };
  const ofront = ob.max[0] - 1.5;
  check('mouth:open still reaches the front edge, so the two really are different',
    voids(oSolid, 'z', ob.min[2], ob.max[2], [ofront, oTop(ofront) - 0.3], 0.02).length === 1,
    'one gap at the nose');
}

// ---------------------------------------------------------------------------
// It prints without supports.
//
// The whole reason the part is built as an extruded side profile. The one
// feature that crosses the extrusion — the slot — would put a flat ceiling over
// itself if it were cut square, so its far wall is raked. The positive control
// below is a slab with a square pocket in it: the same census, on the shape
// this generator refuses to make, has to go red, or the check above is
// measuring nothing.
// ---------------------------------------------------------------------------
{
  const naive = subtractAll(box(30, 6, 60), [box(20, 8, 40).translate(6, 0, 10)]);
  const control = faceOverhangs(naive, { maxOverhang: 45 });
  check('the overhang census does flag a square pocket cut across the build direction',
    control.overhangArea > 10, `${control.overhangArea.toFixed(0)} mm² over 45°, worst ${control.worst.toFixed(0)}°`);

  // CSG leaves the odd collinear sliver behind — triangles of 1e-14 mm² that no
  // slicer will ever see a layer of. They are excluded by area, not by angle,
  // so a real ceiling cannot hide behind the same exemption: the flat pocket
  // above is 114 mm², seven orders of magnitude the other side of the line.
  const worstRealFace = (m) => {
    const fo = faceOverhangs(m, { maxOverhang: 45 });
    let worst = 0;
    for (let t = 0; t < m.triCount; t++) if (fo.areas[t] > 1e-6 && fo.angles[t] > worst) worst = fo.angles[t];
    return { worst, area: fo.overhangArea };
  };
  for (const pr of [{ name: 'defaults', values: {} }, ...gen.presets]) {
    const m = build(pr.values);
    const { worst, area } = worstRealFace(m);
    check(`"${pr.name}" has no face of any printable size past 45°`, worst <= 45 && area < 0.01,
      `worst real face ${worst.toFixed(1)}°, ${area.toExponential(1)} mm² total past 45°`);
  }
}

// ---------------------------------------------------------------------------
// Which way things slope.
//
// Sam caught all three of these on a render before anything was printed, and
// none of them had a test: the rake tipped the brush towards the open mouth,
// the slot was at its widest exactly where the head bears, and only one side
// of it was chamfered. A direction is a claim, and a claim wants a check.
// ---------------------------------------------------------------------------
{
  const m = build();
  const b = m.bbox();
  const solid = prober(m);
  const zOut = b.min[2] + 2;                          // clear of the slot
  const topAt = (x) => { let t = null; for (let y = b.min[1]; y < b.min[1] + 14; y += 0.005) if (solid(x, y, zOut)) t = y; return t; };
  const botAt = (x) => { for (let y = b.min[1]; y < b.min[1] + 14; y += 0.005) if (solid(x, y, zOut)) return y; return null; };

  // The plate's own top face, sampled clear of both the spine and the nose
  // fillet. A brush resting on it must slide towards the slot, not away.
  const xa = b.max[0] - D.slotDepth + 2, xb = b.max[0] - 4;
  const rise = topAt(xb) - topAt(xa);
  check('the plate rakes UP towards its nose, so a brush slides back into the slot',
    rise > 0, `nose is ${rise.toFixed(2)} mm ${rise > 0 ? 'higher' : 'lower'} over ${(xb - xa).toFixed(0)} mm`);
  near('and rakes by the angle it says it does',
    Math.atan(rise / (xb - xa)) * 180 / Math.PI, D.rake, 0.6);

  // Slot width through the plate's thickness, measured at a station known to be
  // inside the opening — with a closed hole the nose is solid, so "6 mm back
  // from the front edge" is not a place the slot exists.
  const xm = rig(m).xIn, yb = botAt(xm), yt = topAt(xm);
  const walls = (y) => {
    const g = voids(solid, 'z', b.min[2], b.max[2], [xm, y], 0.01);
    return g.length === 1 ? g[0] : null;
  };
  const wTop = walls(yt - 0.15), wBot = walls(yb + 0.15);
  check('there is one slot at both faces', !!wTop && !!wBot);
  const wideTop = wTop[1] - wTop[0], wideBot = wBot[1] - wBot[0];
  check('the slot is NARROWEST at the face the head bears on',
    wideTop < wideBot - 1, `${wideTop.toFixed(2)} mm at the top face, ${wideBot.toFixed(2)} mm at the underside`);
  near('and that narrowest width is the one the parameter names',
    wideTop, D.slotW, 0.35);

  // Both walls have to move by the same amount, or the slot is a wedge.
  const nearMove = Math.abs(wTop[0] - wBot[0]), farMove = Math.abs(wTop[1] - wBot[1]);
  check('both walls are chamfered, by the same amount — the slot is symmetric',
    nearMove > 1 && Math.abs(nearMove - farMove) < 0.35,
    `near wall ${nearMove.toFixed(2)} mm, far wall ${farMove.toFixed(2)} mm`);
  const zc = (wTop[0] + wTop[1]) / 2;
  check('and the slot is centred in the plate',
    Math.abs(zc - (b.min[2] + b.max[2]) / 2) < 0.3, `slot centre ${zc.toFixed(2)}, plate centre ${((b.min[2]+b.max[2])/2).toFixed(2)}`);

  // The root is round: the opening reaches further back on the centreline than
  // it does near the walls. Measured through rig(), which finds the opening
  // wherever it is rather than assuming it breaks out at the nose.
  const RG = rig(m);
  const dMid = RG.openAt(0).len, dOff = RG.openAt(D.slotW / 2 - 3).len;
  check('the slot root is rounded — deepest on the centreline, so it cradles and centres',
    dMid > dOff + 1.5, `${dMid.toFixed(1)} mm deep at the centre, ${dOff.toFixed(1)} mm near the wall`);
}

done();
