// js/gen/shelfclip.js — a clip that saddles a shelf's front edge and hangs
// something off the front of it.
//
// The thing it was built for is a hairbrush, which is a harder object to hang
// than it looks. A paddle brush has no hole in it, its handle is fat and
// tapered, and the only feature you can trust is the step where the neck opens
// out into the head. So the brush is not gripped at all: the handle drops
// through a HOLE and the head sits on the plate around it, which works on any
// brush whose head is wider than the hole and whose handle is narrower. One
// hole fits a whole drawer of them.
//
// It was an open-fronted slot first, and the first print slid straight off.
// An open slot only holds what is pushed into it, and a brush whose head fouls
// the shelf above levers its own neck out of the mouth — the rake is the only
// thing resisting that, and four degrees is well inside the friction angle, so
// it never actually pushes anything back. Closed, it cannot be levered out.
// The price is that you thread the handle through, and the WHOLE handle has to
// pass, fat end included, not just the neck.
//
// WHICH WAY UP IT PRINTS is the decision everything else follows from, and it
// is the same decision hooks.js makes for the same reason. The part is a 2D
// SIDE PROFILE in the XY plane extruded along Z: X is the distance out from
// the unit's front face, Y is up, Z is the part's width — and Z is the build
// direction. Printed on its side, the whole silhouette is the first layer, the
// clip's throat becomes a straight slot with two vertical walls instead of a
// horizontal roof needing support, and the bending at the plate's root runs
// along the extrusions rather than across the bonds between them.
//
// That leaves exactly one feature that crosses the extrusion: the brush slot,
// which is bounded in Z because the head catches across its 65 mm width and not
// across its 20 mm thickness. Cut as a plain pocket it would put a flat ceiling
// over itself, so both its walls CHAMFER at 42.9 degrees across the plate's
// thickness — narrow at the top face, opening out underneath. Three things
// about that, all of them learned the hard way and all of them now tested:
//
//   * It closes DOWNWARD. Closing upward puts the widest part of the slot
//     exactly where the head is supposed to catch, which is the one place it
//     must not be. slotW therefore names the width at the TOP face, where the
//     head bears and the handle passes — one number, both constraints.
//   * BOTH walls chamfer. Only the far one has to: on the near side material is
//     disappearing as the print rises, and that never needs support. Chamfering
//     it too costs nothing but width and the slot is symmetric.
//   * The chamfer is referenced to the PLATE'S OWN FACES, not to a horizontal
//     plane, because the plate is raked. Referenced flat it was slotW wide at
//     the nose and three millimetres wider at the root.
//
// THE OTHER RULES:
//   * The clip is a slide fit on the board plus ONE grip bead on the inside of
//     the lower leg. A whole-throat interference fit was the alternative and is
//     worse: it needs the shelf to be the thickness you typed, and PLA creeps,
//     so in a month it is a loose fit everywhere instead of a tight one
//     somewhere. A bead is local, forgiving of a shelf half a millimetre out,
//     and goes on with a push.
//   * The plate rakes NOSE UP. A brush resting on a level plate can be nudged
//     forward out of an open-fronted slot; nose up, gravity walks it back
//     against the root. Nose DOWN — which is how this shipped first — walks it
//     out of the mouth, and it took a person looking at a render to notice,
//     because no test asked which way anything sloped.
//   * The slot's root is round IN PLAN, blended tangentially into two 42.9
//     degree flanks so the curve never turns past what the printer will carry.
//     Round across the plate's THICKNESS is not available at any price: an arc
//     tangent to both faces passes through vertical, and vertical is a ceiling.
//   * Every corner of the profile carries a radius, applied once, at the end.

import * as P from '../kernel/poly2d.js';
import { extrude, loft } from '../kernel/builders.js';
import { subtractAll } from '../kernel/csg.js';
import { DEG, clamp, num, segScale } from '../kernel/scalar.js';
import { FIT, fitNote } from '../kernel/fit.js';

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Layout. Every number the profile and the cutter need, worked out once.
//
// The origin is the top front corner of the shelf: y = 0 is the shelf's top
// face, x = 0 is the plane of the unit's front, the shelf is behind and below.
// ---------------------------------------------------------------------------

function plan(p, ctx = {}) {
  const sf = segScale(ctx);

  const boardT = clamp(num(p.boardT, 17.5), 5, 45);
  const clear = clamp(num(p.clear, FIT.push), 0, 1.5);
  const gripH = clamp(num(p.gripH, 0.5), 0, 1.5);
  const wall = clamp(num(p.wall, 3.2), 1.2, 10);
  const legTop = clamp(num(p.legTop, 30), 6, 90);
  const legBot = clamp(num(p.legBot, 30), 6, 90);
  const spineT = clamp(num(p.spineT, 4), 1.6, 12);
  const drop = clamp(num(p.drop, 105), 0, 140);
  const plateT = clamp(num(p.plateT, 5), 2, 15);
  const rake = clamp(num(p.rake, 4), 0, 20);
  const fillet = clamp(num(p.fillet, 2.5), 0, 12);

  const slotW = clamp(num(p.slotW, 40), 8, 120);
  const sideWall = clamp(num(p.sideWall, 6), 2, 40);
  const slotBack = clamp(num(p.slotBack, 6), 1, 60);
  const slotDepth = clamp(num(p.slotDepth, 26), 4, 80);
  const mouth = p.mouth === 'open' ? 'open' : 'hole';
  const noseWall = clamp(num(p.noseWall, 6), 0, 40);

  const rootR = clamp(num(p.rootR, 24), 0, slotW * 1.5);

  const throat = boardT + clear;                 // the gap the shelf sits in
  const xDeep = spineT + slotBack;               // the slot's deepest point
  const xFront = xDeep + slotDepth;              // and its forward end
  // A closed hole keeps a nose of material in front of it. An open slot does
  // not, and the first printed one slid straight off the front: a brush whose
  // head fouls the shelf above levers its own neck out of an open mouth.
  const plateD = mouth === 'hole' ? xFront + noseWall : xFront;
  const tanR = Math.tan(rake * DEG);
  const rise = plateD * tanR;                    // the nose stands this much PROUD of the root

  const yShelfBot = -throat;                     // underside of the shelf
  // The plate's top face at its ROOT: where the head comes to rest, because the
  // rake tips the nose UP and gravity walks the brush back against the slot.
  const yPlateTop = yShelfBot - drop;
  const yPlateLow = yPlateTop - plateT;          // lowest point of the whole part

  // The grip bead: a round bar across the inside of the lower leg, near the
  // tip, standing gripH proud of the throat. Kept inside the leg it grows from.
  const beadR = clamp(Math.min(1.2, wall / 2.4 + gripH / 2), 0.3, 4);
  const beadX = -legBot + Math.min(6, legBot / 3);
  const beadY = yShelfBot - beadR + gripH;

  // ---- the slot ----------------------------------------------------------
  //
  // OVERHANG_SLOPE is the one number here that is a printing decision rather
  // than a fitting one: rise over run for every sloped face the slot leaves
  // behind, so each sits at atan(0.93) = 42.9 degrees from vertical, inside the
  // 45 every slicer calls self-supporting. Nothing clamps it and nothing may —
  // the part gets WIDER when the plate thickens, never steeper.
  const OVERHANG_SLOPE = 0.93;
  const over = 0.8;                              // cutter overshoot past the plate

  // The plate is raked, so the chamfer is referenced to the PLATE'S OWN FACES
  // rather than to a horizontal plane. Referenced flat, the slot came out
  // slotW wide at the nose and 3 mm wider at the root — which is to say, the
  // parameter named a width the object had at exactly one station. Following
  // the rake also takes slotDepth and rake out of the climb entirely: what the
  // chamfer has to cross is the plate's THICKNESS, and that is constant.
  const yTopOf = (x) => yPlateTop + x * tanR;              // the plate's top face
  const yBotOf = (x) => yTopOf(x) - plateT;                // and its underside

  const slotTopAt = (x, zo) => yTopOf(x) + over - OVERHANG_SLOPE * Math.max(0, Math.abs(zo) - zFlat);
  const slotBotAt = (x) => yBotOf(x) - over;
  // The hole's forward wall is FLAT. Rounding it would cost depth the same way
  // the root does — the 0.93 flanks converge from both sides at 1.86 mm per
  // millimetre of offset — and a hole has to pass the whole handle, fat end
  // included, not just the neck.
  const holeFront = () => (mouth === 'hole' ? xFront : plateD + over);
  // What actually passes: the opening's front-to-back clearance at a given
  // offset from the centreline. The rounded back eats into it going outwards,
  // which is the number that decides whether a fat handle threads through.
  const clearAt = (zo) => (mouth === 'hole' ? xFront : plateD) - rootBack(zo);

  // The chamfer runs BOTH ways and closes DOWNWARD: slotW at the top face,
  // where the head bears and the handle passes, opening out underneath where
  // nothing has to fit. Closing upward — which is what this did first — put the
  // widest part of the slot exactly where the head was supposed to catch, and
  // left the other side of it flat.
  const slotHalf = slotW / 2;
  const zFlat = slotHalf - over / OVERHANG_SLOPE;          // chamfer starts here
  const climb = (plateT + 2 * over - 0.02) / OVERHANG_SLOPE;
  const halfMax = zFlat + climb;                           // half-width at the underside
  const width = 2 * halfMax + 2 * sideWall;
  const zMid = width / 2;

  // The root is round in PLAN, where round is free: a vertical wall whatever
  // angle it turns through. It blends TANGENTIALLY into two 0.93 flanks at the
  // point where the arc itself reaches that slope, so the curve never turns
  // past what the printer will carry — a circle's own tangent goes horizontal
  // at its widest, which is a ceiling. Round across the plate's THICKNESS is
  // not available at any price, for the same reason.
  const rootTan = rootR * OVERHANG_SLOPE / Math.sqrt(1 + OVERHANG_SLOPE * OVERHANG_SLOPE);
  // rootBack is clamped against xFront below, so a root radius larger than the
  // slot is deep simply flattens rather than turning the cutter inside out.
  const xRootC = xDeep + rootR;
  const rootBack = (zo) => {
    if (rootR < 0.02) return xDeep;
    const a = Math.min(Math.abs(zo), rootTan);
    const x = xRootC - Math.sqrt(Math.max(0, rootR * rootR - a * a));
    return Math.min(x + OVERHANG_SLOPE * Math.max(0, Math.abs(zo) - rootTan), xFront - 0.6);
  };

  return {
    sf, boardT, clear, gripH, wall, legTop, legBot, spineT, drop, plateT, rake, fillet,
    slotW, sideWall, slotBack, slotDepth, mouth, noseWall, xFront, holeFront, clearAt,
    throat, plateD, yShelfBot, yPlateTop, rise, yPlateLow,
    beadR, beadX, beadY,
    rootR, over, tanR, xDeep, yTopOf, yBotOf,
    slotHalf, zFlat, climb, halfMax, width, zMid, rootTan, xRootC, rootBack, slotTopAt, slotBotAt,
    overhangDeg: Math.atan(OVERHANG_SLOPE) / DEG, slope: OVERHANG_SLOPE,
    raw: p,
  };
}

// ---------------------------------------------------------------------------
// The slot: the only feature that crosses the extrusion.
//
// A loft along Z of four-cornered sections. Two things vary with height: the
// slot's back, which walks forward along the rounded root, and the slot's top,
// which walks down once the chamfer starts. Both close the cutter before the
// far side of the slot, so the plate above the slot is carried by the plate
// below it and nothing needs a support.
//
// A loft rather than a rotated box, because align:'index' between sections of
// the same four corners is exact and needs no weld — and because rotating a
// cutter is how you end up with a slot mirrored about the wrong plane the
// first time someone changes the rake.
// ---------------------------------------------------------------------------

function slotCutter(L) {
  // Four corners, not a rectangle: top and bottom both follow the rake, so the
  // slot is the width it says it is at every station along the plate.
  const quad = (zo) => {
    const x0 = L.rootBack(zo), x1 = L.holeFront();
    return P.ensureCCW([
      [x0, L.slotBotAt(x0)], [x1, L.slotBotAt(x1)],
      [x1, L.slotTopAt(x1, zo)], [x0, L.slotTopAt(x0, zo)],
    ]);
  };

  // Breakpoints first, then fill: the arc's tangent point and the start of the
  // chamfer are corners of the surface, and a loft that steps over a corner
  // rounds it off by however far it stepped.
  const n = Math.max(10, Math.round(18 * Math.sqrt(L.sf)));
  const offs = new Set([0, L.rootTan, L.zFlat, L.halfMax]);
  for (let i = 1; i < n; i++) offs.add(L.rootTan * i / n);
  for (let i = 1; i < n; i++) offs.add(L.rootTan + (L.halfMax - L.rootTan) * i / n);
  const half = [...offs].filter(v => v >= 0 && v <= L.halfMax).sort((a, b) => a - b);
  const all = [...half.slice(1).reverse().map(v => -v), ...half];

  // A section thinner than a fraction of a millimetre is not a cutter, it is a
  // crack for the CSG to fall into: at slotW=max and slotDepth=min the plan and
  // the chamfer close on each other and the sweep went non-manifold. The loft
  // stops at the last section that is still a real quadrilateral, symmetrically
  // on both sides, and its end cap closes the solid.
  const ok = (zo) => (L.holeFront() - L.rootBack(zo)) > 0.4 && (L.slotTopAt(L.plateD, zo) - L.slotBotAt(L.plateD)) > 0.02;
  let last = L.halfMax;
  for (const zo of half) { if (!ok(zo)) { last = zo; break; } }
  const kept = all.filter(zo => Math.abs(zo) <= last);
  if (kept.length < 2) throw new Error('shelfclip: the slot closed before it opened');
  const secs = kept.map(zo => ({ shape: [quad(zo)], z: L.zMid + zo }));
  return loft(secs, { align: 'index', check: false });
}

// ---------------------------------------------------------------------------
// The side profile.
// ---------------------------------------------------------------------------

function profile(L) {
  const rect = (x0, y0, x1, y1) => P.rect(x1 - x0, y1 - y0, { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });

  const pieces = [
    rect(-L.legTop, 0, L.spineT, L.wall),                                  // leg on the shelf
    rect(-L.legBot, L.yShelfBot - L.wall, L.spineT, L.yShelfBot),          // leg under the shelf
    rect(0, L.yPlateTop - L.plateT, L.spineT, L.wall),                     // spine down the front
    [[0, L.yPlateTop], [L.plateD, L.yPlateTop + L.rise],                   // the plate, nose UP
     [L.plateD, L.yPlateTop + L.rise - L.plateT], [0, L.yPlateTop - L.plateT]],
  ];

  let acc = [[P.ensureCCW(pieces[0])]];
  for (let i = 1; i < pieces.length; i++) acc = P.boolean(acc, [[P.ensureCCW(pieces[i])]], 'union');
  acc.sort((a, b) => Math.abs(P.signedArea(b[0])) - Math.abs(P.signedArea(a[0])));
  if (!acc.length || !acc[0][0] || acc[0][0].length < 3) throw new Error('shelfclip: the profile came out empty');
  let ring = P.ensureCCW(acc[0][0]);

  // One fillet pass over every corner. Held below half the narrowest gap in the
  // profile, or the radius closes the throat the shelf has to go into.
  const f = Math.min(L.fillet, L.throat / 2 - 0.2, L.wall * 0.9, L.plateT * 0.9, L.spineT * 0.9);
  if (f > 0.05) ring = P.roundedPath(ring, f, { segs: Math.max(2, Math.round(3 * Math.sqrt(L.sf))) });

  // The bead goes on afterwards: a 2.5 mm fillet would otherwise swallow a
  // 0.5 mm bump whole.
  if (L.gripH > 0.02) {
    const bead = P.circle(L.beadR, { segs: Math.max(10, Math.round(20 * Math.sqrt(L.sf))), cx: L.beadX, cy: L.beadY });
    const merged = P.boolean([[ring]], [[P.ensureCCW(bead)]], 'union');
    if (merged.length === 1 && merged[0][0] && merged[0][0].length >= 3) ring = P.ensureCCW(merged[0][0]);
  }
  return ring;
}

// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const L = plan(p, ctx);
  const body = subtractAll(extrude([profile(L)], L.width, { check: false }), [slotCutter(L)]);
  const mesh = body.place();

  const b0 = body.bbox();
  const T = [-b0.center[0], -b0.center[1], -b0.min[2]];
  const at = (x, y, z) => [x + T[0], y + T[1], z + T[2]];
  const zc = L.zMid;

  const dims = [
    { param: 'boardT', from: at(-L.legTop + 2, L.yShelfBot + L.clear / 2, zc), to: at(-L.legTop + 2, L.yShelfBot + L.clear / 2 + L.boardT, zc), offset: [-1, 0, 0] },
    { param: 'legTop', from: at(-L.legTop, L.wall, zc), to: at(0, L.wall, zc), offset: [0, 1, 0] },
    { param: 'slotDepth', from: at(L.xDeep, L.yTopOf(L.xFront), zc), to: at(L.xFront, L.yTopOf(L.xFront), zc), offset: [0, 0, 1] },
    { label: 'reach', value: r2(L.plateD), from: at(0, L.yPlateTop, zc), to: at(L.plateD, L.yPlateTop, zc), offset: [0, -1, 0] },
    { param: 'slotW', from: at(L.plateD - 2, L.yTopOf(L.plateD - 2), zc - L.slotHalf), to: at(L.plateD - 2, L.yTopOf(L.plateD - 2), zc + L.slotHalf), offset: [0, 1, 0] },
  ];
  // A zero drop is a legal shape — the head then stands up in front of the
  // shelf — but a callout of zero length is not, so it only appears when there
  // is something to measure.
  if (L.rootR > 0.5) dims.push({ param: 'rootR', label: 'root R', from: at(L.xRootC, L.yTopOf(L.xRootC), zc), to: at(L.xDeep, L.yTopOf(L.xRootC), zc), offset: [0, 1, 0] });
  if (L.drop > 0.5) dims.push({ param: 'drop', from: at(0, L.yShelfBot, zc), to: at(0, L.yPlateTop, zc), offset: [1, 0, 0] });

  const analysis = [
    `Clips a ${r2(L.boardT)} mm shelf: a ${r2(L.throat)} mm throat with a ${r2(L.gripH)} mm bead on the lower leg, so it goes on with a push and grips on one line rather than along the whole jaw. It seats to within a fillet of the spine — ${r2(Math.max(L.legTop, L.legBot) - L.fillet)} mm of board in the jaw.`,
    `The plate lands ${r2(L.drop)} mm below the shelf, reaches ${r2(L.plateD)} mm out from the front, and rakes ${r2(L.rake)}° NOSE UP so that whatever is hanging on it settles back against the back of the opening.`,
    `The opening is ${r2(L.slotW)} mm across the face the head bears on and opens out to ${r2(L.slotW + 2 * L.plateT / L.slope)} mm at the underside, where nothing has to fit. Anything with a head wider than ${r2(L.slotW)} mm and a handle narrower than it hangs on the ${r2(L.zMid - L.slotHalf)} mm of ledge each side.`,
    L.mouth === 'hole'
      ? `Closed hole: ${r2(L.slotDepth)} mm front to back on the centreline, ${r2(L.clearAt((L.slotW - 8) / 2))} mm at the edge of a ${r2(L.slotW - 8)} mm handle, with ${r2(L.noseWall)} mm of nose in front of it. Thread the handle down through — the WHOLE handle passes, fat end included, so measure the widest part of yours rather than the neck.`
      : `Open slot: pushed in from the front, ${r2(L.slotDepth)} mm deep. Quicker to load and easier to knock back out; the rake is all that holds it in.`,
    L.rootR > 0.5
      ? `The back is a ${r2(L.rootR)} mm radius in plan, so a handle settles to the middle instead of wandering along a flat wall.`
      : 'The back is square in plan — a handle can slide along it from side to side.',
    `Nothing on the part overhangs past ${r2(L.overhangDeg)}°, printed on its side.`,
  ];

  return {
    mesh,
    meta: {
      dims, analysis,
      throat: r2(L.throat),
      width: r2(L.width),
      plateD: r2(L.plateD),
      slotNarrow: r2(L.slotW),
      slotWide: r2(L.slotW + 2 * L.plateT / L.slope),
      ledge: r2(L.zMid - L.slotHalf),
      overhangDeg: r2(L.overhangDeg),
      dropTotal: r2(L.throat + L.drop + L.plateT),
    },
  };
}

function validate(p) {
  const L = plan(p, {});
  const issues = [];

  // The bed is checked in the orientation the part actually prints in: the side
  // profile lies down, the width stands up.
  const tall = L.wall + L.throat + L.drop + L.plateT;
  const deep = L.legTop + L.plateD;
  if (tall > 180) {
    issues.push({ param: 'drop', severity: 'error',
      message: `At ${r2(tall)} mm from the top of the clip to the nose of the plate, this will not lie down on a 180 mm bed. Shorten the drop by ${r2(tall - 180)} mm.` });
  }
  if (deep > 180) {
    issues.push({ param: 'slotDepth', severity: 'error',
      message: `${r2(deep)} mm from the back of the legs to the nose of the plate is longer than the bed. Shorten the legs or the slot.` });
  }
  if (L.width > 180) {
    issues.push({ param: 'slotW', severity: 'error',
      message: `The part is ${r2(L.width)} mm wide, which is how tall it prints, and the bed is 180 mm. A thicker plate or a steeper rake both make it wider, because the slot's ramp has to be longer.` });
  }

  if (L.gripH >= L.clear + 0.9) {
    issues.push({ param: 'gripH', severity: 'warn',
      message: `A ${r2(L.gripH)} mm bead in a ${r2(L.clear)} mm clearance is ${r2(L.gripH - L.clear)} mm of interference. It will go on, but it will take a shove and may mark the shelf.` });
  }
  if (L.gripH <= L.clear) {
    issues.push({ param: 'gripH', severity: 'warn',
      message: `A ${r2(L.gripH)} mm bead inside a ${r2(L.clear)} mm clearance never touches the shelf. The clip will slide along the edge and can be knocked off.` });
  }
  if (L.slotW > 48) {
    issues.push({ param: 'slotW', severity: 'warn',
      message: `A ${r2(L.slotW)} mm slot at the bearing face is getting close to the head it has to catch — a hairbrush head is 55-70 mm across. Measure the narrowest one you want it to hold.` });
  }
  const clearEdge = L.clearAt((L.slotW - 8) / 2);
  if (clearEdge < 14) {
    issues.push({ param: 'slotDepth', severity: 'warn',
      message: `At the edge of a ${r2(L.slotW - 8)} mm handle the opening is only ${r2(clearEdge)} mm front to back — most hairbrush handles are 15-20 mm thick there. Deepen it, or make the root radius LARGER: a large arc stays shallow near the centre, a small one starts flanking sooner and costs more depth.` });
  }
  if (L.mouth === 'hole' && L.noseWall < 2) {
    issues.push({ param: 'noseWall', severity: 'warn',
      message: `${r2(L.noseWall)} mm of nose in front of the hole is barely more than a perimeter. It is the only thing stopping the brush coming out of the front.` });
  }
  if (L.rake < 1) {
    issues.push({ param: 'rake', severity: 'warn',
      message: 'With no rake the plate is level and the slot is open at the front, so anything hanging on it can be walked forward and off. Two or three degrees is enough to hold it back.' });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const L = plan(p, ctx);
  return {
    profile: { layerH, infill: 25, walls: 3 },
    supports: false,
    filament: 'PETG',
    notes: [
      'Print it ON ITS SIDE — the side profile flat on the plate, exactly as it comes out of Bluesheet. That is what turns the clip\'s throat into a slot with vertical walls instead of a roof, and it is why the part needs no supports anywhere.',
      `The bead makes the throat ${r2(L.gripH - L.clear)} mm tight at one line. Push it on square; if the shelf is thicker than you typed, it is the bead that gives.`,
      'It goes on the shelf with the long leg UNDER the board and the plate hanging outside the unit. The plate rakes nose-up, which is what keeps a brush sitting against the back of the opening.',
      L.mouth === 'hole'
        ? 'To hang one: hold the brush above the plate, handle down, and thread the handle through the hole until the head sits on the plate. It cannot be pushed off the front.'
        : 'To hang one: push the handle into the slot from the front until it seats against the back.',
      `Nothing on it overhangs past ${r2(L.overhangDeg)}°, so no supports and no brim — the whole silhouette is the first layer, which is about as much bed contact as a part this shape can have.`,
      'PETG over PLA if you have it: the clip is a spring that lives at room temperature for years, and PLA creeps under a constant strain. Three walls, 25% infill.',
    ],
  };
}

export default {
  id: 'shelfclip',
  name: 'Shelf-edge Hanger',
  category: 'Utility',
  blurb: 'Clips over a shelf\'s front edge and hangs a hairbrush — or anything with a head — through a hole in a plate.',
  description:
    'A C-clip that saddles the front edge of a shelf, a spine down the outside of the unit, and a plate at the bottom with a ' +
    'hole in it. Whatever you hang threads its handle through the hole and sits on the plate by its head, so nothing has to ' +
    'grip and nothing needs drilling — one hole suits every handle narrower than it and every head wider. An open-fronted ' +
    'slot is offered too and is quicker to load, but it can be knocked back out, which is how the first printed one failed. The clip is a slide fit with a single grip bead on the lower leg, which holds better than an interference fit ' +
    'across the whole jaw and forgives a shelf that is not quite the thickness you measured. It prints on its side with no ' +
    'supports: the throat comes out as a straight slot, and the one feature that crosses the extrusion has its far wall raked ' +
    'back so nothing in the part overhangs past 45°.',
  version: 1,
  params: [
    { key: 'boardT', label: 'Shelf thickness', type: 'number', def: 17.5, min: 5, max: 45, step: 0.1, unit: 'mm', group: 'Shelf',
      help: 'MEASURE THIS. The board the clip saddles. Everything else is forgiving; this is not.' },
    { key: 'clear', label: 'Throat clearance', type: 'number', def: FIT.push, min: 0, max: 1.5, step: 0.05, unit: 'mm', group: 'Shelf',
      help: `How much wider than the board the throat is cut before the bead is added. ${fitNote('push')}` },
    { key: 'gripH', label: 'Grip bead', type: 'number', def: 0.5, min: 0, max: 1.5, step: 0.1, unit: 'mm', group: 'Shelf',
      help: 'How far the bead on the lower leg stands into the throat. This minus the clearance is the interference that actually holds it on. Zero prints a clip that slides.' },
    { key: 'legTop', label: 'Leg on the shelf', type: 'number', def: 30, min: 6, max: 90, step: 1, unit: 'mm', group: 'Shelf',
      help: 'How far the upper leg reaches back across the top of the shelf. Anything standing on the shelf sits on top of it.' },
    { key: 'legBot', label: 'Leg under the shelf', type: 'number', def: 30, min: 6, max: 90, step: 1, unit: 'mm', group: 'Shelf',
      help: 'And underneath. This is the leg that carries the bead and does most of the gripping.' },
    { key: 'wall', label: 'Leg thickness', type: 'number', def: 3.2, min: 1.2, max: 10, step: 0.4, unit: 'mm', group: 'Shelf',
      help: '3.2 mm is eight 0.4 mm lines — a whole number of extrusions, which is stronger than a thicker wall the slicer has to fill with a zigzag.' },

    { key: 'drop', label: 'Drop below the shelf', type: 'number', def: 105, min: 0, max: 140, step: 1, unit: 'mm', group: 'Hanger',
      help: 'From the underside of the shelf to the face the head rests on. At 105 mm a brush with a 10 cm head finishes level with the shelf top; at 0 the head stands up in front of it and the part is a quarter of the size.' },
    { key: 'spineT', label: 'Spine thickness', type: 'number', def: 4, min: 1.6, max: 12, step: 0.4, unit: 'mm', group: 'Hanger',
      help: 'The web down the front face. It is in bending over the whole drop, so do not starve it.' },
    { key: 'plateT', label: 'Plate thickness', type: 'number', def: 5, min: 2, max: 15, step: 0.5, unit: 'mm', group: 'Hanger',
      help: 'The shelf the head sits on. Also sets how long the slot\'s raked wall has to be.' },
    { key: 'rake', label: 'Plate rake', type: 'number', def: 4, min: 0, max: 20, step: 1, unit: '°', group: 'Hanger',
      help: 'Tips the plate\'s nose down so gravity holds whatever is hanging against the back of the slot instead of letting it walk forward. Zero is a level plate and will need a nudge to stay put.' },
    { key: 'fillet', label: 'Corner radius', type: 'number', def: 2.5, min: 0, max: 12, step: 0.5, unit: 'mm', group: 'Hanger',
      help: 'Applied to every corner of the profile at once, then clamped so it can never close the throat.' },

    { key: 'mouth', label: 'Mouth', type: 'enum', def: 'hole', group: 'Slot',
      options: [
        { v: 'hole', label: 'Closed hole', help: 'Thread the handle down through it. Nothing can walk out of the front.' },
        { v: 'open', label: 'Open slot', help: 'Push it in from the front. Quicker to load, and it can be knocked back out.' },
      ],
      help: 'An open slot only holds what is pushed into it — the first one printed slid off, because a brush whose head fouls the shelf above levers its own neck out of the mouth. A closed hole cannot be levered out of; the price is that you thread the handle through it, and the whole handle has to fit, fat end included.' },
    { key: 'noseWall', label: 'Nose in front of the hole', type: 'number', def: 6, min: 0, max: 40, step: 1, unit: 'mm', group: 'Slot',
      showIf: (q) => q.mouth !== 'open',
      help: 'Material between the hole and the front edge of the plate. This is what the brush cannot get past.' },
    { key: 'slotW', label: 'Slot width', type: 'number', def: 40, min: 8, max: 120, step: 1, unit: 'mm', group: 'Slot',
      help: 'Across the plate, at the face the head bears on. Wider than the fattest handle, narrower than the narrowest head — for hairbrushes there is a lot of room between those two: handles run 20-32 mm, heads 55-70 mm.' },
    { key: 'slotDepth', label: 'Slot depth', type: 'number', def: 26, min: 4, max: 80, step: 1, unit: 'mm', group: 'Slot',
      help: 'Front to back. On a closed hole this has to clear the THICKNESS of the handle with room to spare, because the rounded back eats into it away from the centreline.' },
    { key: 'rootR', label: 'Root radius', type: 'number', def: 24, min: 0, max: 60, step: 1, unit: 'mm', group: 'Slot',
      help: 'Rounds the back of the slot in plan, so a handle settles to the middle instead of sliding along a flat wall. A LARGE radius costs less depth than a small one: the arc has to blend into 43° flanks before it turns too far for the printer, and a small arc starts flanking sooner. Zero gives a square back.' },
    { key: 'slotBack', label: 'Material behind the slot', type: 'number', def: 6, min: 1, max: 60, step: 1, unit: 'mm', group: 'Slot',
      help: 'Between the spine and the back of the slot. It is also what holds the head clear of the front of the unit.' },
    { key: 'sideWall', label: 'Plate either side', type: 'number', def: 6, min: 2, max: 40, step: 1, unit: 'mm', group: 'Slot',
      help: 'The ledge the head actually rests on, each side of the slot. Two of these plus the slot is the width of the whole part.' },
  ],
  presets: [
    { name: 'Hairbrush, 17.5 mm shelf, closed hole', values: {
      boardT: 17.5, clear: FIT.push, gripH: 0.5, legTop: 30, legBot: 30, wall: 3.2,
      drop: 105, spineT: 4, plateT: 5, rake: 4, fillet: 2.5,
      slotW: 40, slotDepth: 26, slotBack: 6, sideWall: 6, rootR: 24, mouth: 'hole', noseWall: 6 } },
    { name: 'Short — head above the shelf', values: {
      boardT: 17.5, clear: FIT.push, gripH: 0.5, legTop: 30, legBot: 30, wall: 3.2,
      drop: 0, spineT: 4, plateT: 5, rake: 4, fillet: 2.5,
      slotW: 40, slotDepth: 26, slotBack: 6, sideWall: 6, rootR: 24, mouth: 'hole', noseWall: 6 } },
    { name: 'Thin 12 mm shelf, deep drop', values: {
      boardT: 12, clear: FIT.push, gripH: 0.4, legTop: 24, legBot: 24, wall: 2.8,
      drop: 135, spineT: 4, plateT: 5, rake: 4, fillet: 2,
      slotW: 34, slotDepth: 24, slotBack: 5, sideWall: 5, rootR: 22, mouth: 'hole', noseWall: 5 } },
    { name: 'Open slot, wide — for a tool you grab often', values: {
      boardT: 22, clear: FIT.push, gripH: 0.6, legTop: 40, legBot: 40, wall: 4,
      drop: 60, spineT: 5, plateT: 6, rake: 6, fillet: 3,
      slotW: 46, slotDepth: 28, slotBack: 8, sideWall: 8, rootR: 26, mouth: 'open' } },
  ],
  build,
  validate,
  hints,
};
