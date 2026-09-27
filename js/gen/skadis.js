// js/gen/skadis.js — accessories for the IKEA Skådis pegboard.
//
// Eleven types, but only one object worth thinking hard about: THE TAB.
//
// A Skådis board is not a pegboard with round holes. Every opening is a
// vertical obround, 5 mm wide and 15 mm tall with 2.5 mm end radii, on a 40 mm
// grid with alternate columns dropped 20 mm, in a board about 5 mm thick. That
// 15 mm slot height is not styling. It IS the retention mechanism.
//
// The tab is a rounded prong with a J-shaped throat, copied from the parts that
// are known to fit this board rather than derived from first principles:
//
//        side view            \  = the board
//                             |
//      plate |___             |     BRIDGE runs out of the plate and through
//            |   |  \\        |     the slot, and its underside rests on the
//            |   |  |\\       |     slot floor — that is the load path.
//            |   |  |         |
//            |___|__|         |     LEG rises from the bridge, behind the
//                 \__/        |     board. The material ABOVE the slot sits
//                             |     in the throat between the leg and plate.
//
// Insert by lifting the part so the leg passes up through the slot, then lower
// it until the bridge is on the slot floor. Pulling the part off the wall is
// resisted by the leg bearing on the back of the board; it descending is
// resisted by the bridge on the slot floor; lifting is resisted by nothing,
// because lifting by the leg's height is how you take it off again. Two
// inequalities keep that honest, and validate() enforces both:
//
//     prongThickness + legHeight <= slotHeight   the leg can be lifted clear
//     legHeight > 0                              it is retained at all
//
// The first draft of this file had the throat the other way up — bridge at the
// top, a shallow wedge hanging below it — which is mechanically defensible and
// is not what the working parts do. Sam's photograph of a bin he has printed
// settled it. Verify the spec, not your reasoning about the spec.
//
// Those board figures are community-measured — IKEA publishes nothing — so they
// are PARAMETERS, not constants, and there is a `gauge` type that prints five
// tabs at five clearances so a board that disagrees costs one number rather
// than a rewrite.
//
// ORIENTATION, which is the other thing that decides whether any of this works.
//
// The barb is a small prong, and in most orientations it is either an
// unsupported island or a 90 degree overhang. Two families avoid both:
//
//   PRISMATIC — peg, jhook, longarm, double, clip, label, gauge.
//     A side profile in the out/up plane, extruded ACROSS the board, so the
//     part comes out lying on its side exactly as js/gen/hooks.js does. Every
//     wall is then vertical, the whole silhouette is the first layer, and the
//     bending tension at the root runs along the extrusions rather than across
//     the weak bonds between them. The tab is a prism whose ends are chamfered
//     at 45 degrees, so its sideways-facing end caps are self-supporting.
//
//   VOLUME — shelf, tray, cup, toolplate.
//     Printed as used, floor on the bed, back plate rising behind. Here the
//     barb prints FIRST, from its 45 degree tip upward, and the neck is then a
//     short bridge from the top of the barb across to the plate — the barb is
//     its own support tower. A 160 mm shelf cannot join the prismatic family:
//     that would be a 160 mm-tall print of a flat object.
//
// Nothing in this file needs support in its delivered orientation, and hints()
// says which family each type is in and which way up it arrives.
//
// CONSTRUCTION. Everything is 2D profiles plus straight extrusions along one of
// the three axes, unioned. Three helpers cover it: extrudeThroughX for anything
// prismatic across the board, extrudeThroughY for the back plate and gussets,
// and plain extrude for volume bodies drawn in plan. Fillets are morphological
// closes (offset out, offset back), which rounds internal corners without
// needing a corner-matching fillet routine.

import { Mesh } from '../kernel/mesh.js';
import {
  TAU, rect, roundRect, circle, slot, boolean, offset, bounds, shapeArea, ensureCCW,
} from '../kernel/poly2d.js';
import { extrude, loft } from '../kernel/builders.js';
import { unionAll, subtractAll } from '../kernel/csg.js';
import { DEG, clamp, num, segScale } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

// ---------------------------------------------------------------------------
// Board data. Every one of these is a default, not a law — see the header.
// ---------------------------------------------------------------------------

/** Slot geometry as measured by the community and corroborated by parts that fit. */
const BOARD = {
  slotWidth: 5,        // mm, across the board
  slotHeight: 15,      // mm, up the board — this is the drop travel
  slotPitch: 40,       // mm, centre to centre within a column and within a row
  stagger: 20,         // mm, adjacent columns are dropped by this much
  thickness: 5,        // mm
};

const NOZZLE = 0.4;
const LAYER = 0.2;
const BED = 180;

const PRISMATIC = ['peg', 'jhook', 'longarm', 'double', 'clip', 'label', 'gauge'];
const VOLUME = ['shelf', 'tray', 'cup', 'toolplate'];
const ARMS = ['peg', 'jhook', 'longarm', 'double'];
/** Types whose load hangs on a cantilever, so one tab would be a hinge. */
const CANTILEVERED = ['peg', 'jhook', 'longarm', 'double', 'shelf', 'tray', 'cup', 'toolplate', 'label'];

const TYPE_IDS = [...PRISMATIC.slice(0, 6), ...VOLUME, 'gauge'];

/** The five offsets the fit gauge prints, tightest first. */
const GAUGE_STEPS = [-0.30, -0.15, 0, 0.15, 0.30];

/**
 * Where the gauge's five tabs sit: on the board's own lattice, or it cannot be
 * hung. Skådis slots are a 20 mm checkerboard — columns half a pitch apart,
 * adjacent columns dropped by half a pitch — so the tabs walk across it
 * (0,0) (½p,-½p) (p,0) (3½p... : five tabs, ~80 mm wide, every one over a slot.
 *
 * The first gauge put them 11 mm apart to keep the print small. It printed
 * perfectly and not one tab lined up with a slot (Sam, 2026-09-03). A gauge
 * that measures a board must be shaped like the board.
 */
function gaugeTabs(pitch, zTop) {
  const half = pitch / 2;
  return GAUGE_STEPS.map((_, i) => ({
    x: (i - (GAUGE_STEPS.length - 1) / 2) * half,
    z: zTop - (i % 2 ? half : 0),
  }));
}

/** Bore presets for the tool holder, in the sizes that are actually on a bench. */
const BORE_PRESETS = {
  screwdriver: { dia: 9, label: 'screwdriver handles' },
  drillbit: { dia: 4, label: 'drill bits' },
  hexkey: { dia: 6, label: 'hex keys' },
  marker: { dia: 18, label: 'markers and pens' },
};

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Round a thickness to a whole number of extrusions, never fewer than two. */
function snapWall(v, ew = NOZZLE) { return Math.max(2, Math.round(v / ew)) * ew; }

/** Segment count for a full circle at this quality. */
function circleSegs(r, sf) { return Math.max(8, Math.min(160, Math.round(Math.max(12, r * 3) * Math.sqrt(sf)))); }

// ---------------------------------------------------------------------------
// The three extrusion helpers.
//
// Build space is the same for every type, and it is the orientation the part is
// used in, not the one it is printed in:
//
//     X  across the board          (0 at the part's centre line)
//     Y  out from the board        (0 at the board's front face, part in +Y)
//     Z  up the board              (0 at the bottom of the back plate)
//
// The board itself therefore occupies Y in [-thickness, 0], and anything a tab
// puts behind it lives at Y < -thickness.
// ---------------------------------------------------------------------------

/** A profile drawn in the X–Z plane (across × up), given depth through Y. */
function extrudeThroughY(shape, depth, y0 = 0, opts = {}) {
  return extrude(shape, depth, { ...opts, z0: -(y0 + depth) }).rotateX(Math.PI / 2);
}

/** A profile drawn in the Y–Z plane (out × up), given width through X. */
function extrudeThroughX(shape, width, x0 = 0, opts = {}) {
  return extrude(shape, width, { ...opts, z0: -width / 2 })
    .mapVerts((u, v, w) => [w + x0, u, v]);
}

/** A profile drawn in plan (X–Y), extruded up Z. Just extrude, named for symmetry. */
function extrudeUp(shape, height, z0 = 0, opts = {}) {
  return extrude(shape, height, { ...opts, z0 });
}

/**
 * Fillet every internal corner of a 2D shape by radius r — a morphological
 * close. Growing by r and shrinking back leaves convex corners where they were
 * and fills concave ones with an arc of exactly r, which is the corner that
 * decides whether a loaded root splits. Anything narrower than 2r closes up, so
 * callers clamp r against the narrowest gap they care about keeping.
 */
function filletInner(shape, r, sf = 1) {
  if (!(r > 0.05)) return shape;
  const tol = clamp(0.06 / Math.sqrt(sf), 0.01, 0.12);
  const grown = offset(shape, r, { join: 'round', arcTolerance: tol });
  if (!grown.length) return shape;
  const back = offset(grown, -r, { join: 'round', arcTolerance: tol });
  return back.length ? back : shape;
}

/** Union a list of 2D shapes pairwise. */
function union2d(shapes) {
  const live = shapes.filter(s => s && s.length);
  if (!live.length) return [];
  return live.reduce((acc, s) => boolean(acc, s, 'union'));
}

/**
 * A rectangle of thickness `t` centred on the segment a→b, with a disc at each
 * end. Thickening a path this way instead of offsetting its normals means a
 * sharp turn produces a rounded elbow rather than a miter spike that folds
 * through itself, which is what an arm profile needs.
 */
function segmentBlob(a, b, t, sf) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const h = t / 2;
  const segs = Math.max(8, Math.round(10 * Math.sqrt(sf)));
  if (len < 1e-6) return [circle(h, { segs, cx: a[0], cy: a[1] })];
  const nx = -dy / len * h, ny = dx / len * h;
  const bar = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  return union2d([[ensureCCW(bar)],
    [circle(h, { segs, cx: a[0], cy: a[1] })],
    [circle(h, { segs, cx: b[0], cy: b[1] })]]);
}

/** Thicken a polyline into a closed shape of constant width. */
function thickenPath(pts, t, sf) {
  const parts = [];
  for (let i = 0; i + 1 < pts.length; i++) parts.push(segmentBlob(pts[i], pts[i + 1], t, sf));
  return union2d(parts);
}

// ---------------------------------------------------------------------------
// Layout — every derived number in one place, clamped once.
//
// Every clamp here exists because the parameter sweep builds this generator at
// the minimum and maximum of every number independently, so combinations that
// no sane person would type still have to produce a watertight solid. A tab
// taller than the plate, a fillet wider than the arm, a lip taller than the
// tray: all of them arrive, and all of them have to come out as something.
// ---------------------------------------------------------------------------

function layout(p, ctx = {}) {
  const sf = segScale(ctx);
  const type = TYPE_IDS.includes(p.type) ? p.type : 'jhook';
  const volume = VOLUME.includes(type);

  const slotW = clamp(num(p.slotWidth, BOARD.slotWidth), 2, 12);
  const slotH = clamp(num(p.slotHeight, BOARD.slotHeight), 5, 40);
  const pitch = clamp(num(p.slotPitch, BOARD.slotPitch), 12, 80);
  const boardT = clamp(num(p.boardThickness, BOARD.thickness), 1, 20);
  const fitClear = clamp(num(p.fitClearance, 0.35), 0, 2);

  // The neck can never be wider than the slot it has to pass through, and never
  // thinner than two extrusions or it is a single unbonded thread.
  const neckW = clamp(slotW - fitClear, NOZZLE * 2, slotW);

  const plateT = clamp(num(p.plateThickness, 4), 1.6, 14);
  const margin = clamp(num(p.plateMargin, 5), 1, 25);
  // The prong's section in side view. It defaults to the slot width, so the
  // prong comes out square — near enough round once the corners are radiused,
  // which is what the moulded hooks are.
  const prongT = clamp(num(p.prongThickness, 4.5), NOZZLE * 2, 20);
  const legHeight = clamp(num(p.legHeight, 8), 1, 30);

  const tabCols = Math.round(clamp(num(p.tabCols, 2), 1, 4));
  const tabRows = Math.round(clamp(num(p.tabRows, 1), 1, 3));
  const snap = p.mountStyle === 'snap';

  const fillet = clamp(num(p.fillet, 3), 0, 20);

  const armW = snapWall(clamp(num(p.armWidth, 12), 3, 60));
  const stock = clamp(num(p.stock, 7), 2, 30);
  // A long arm is not a peg with a bigger number typed in — it is the type you
  // choose because you are hanging tape rolls and filament, so it takes its
  // reach at 1.8x and carries a lip tall enough to stop a roll walking off.
  const reachRaw = clamp(num(p.reach, 35), 5, 150);
  const reach = type === 'longarm' ? Math.min(reachRaw * 1.8, 165) : reachRaw;
  const rise = clamp(num(p.rise, 6), 0, 45);
  const returnH = clamp(num(p.returnH, 14), 0, 60);
  const bendR = clamp(num(p.bendR, 8), 0.5, 40);
  const prongGap = clamp(num(p.prongGap, 16), 2, 90);

  const cableDia = clamp(num(p.cableDia, 8), 2, 40);
  const grip = clamp(num(p.grip, 0.85), 0.5, 1);

  const cardW = clamp(num(p.cardWidth, 74), 12, BED - 6);
  const cardH = clamp(num(p.cardHeight, 30), 6, 120);
  const cardTilt = clamp(num(p.cardTilt, 20), 0, 60);

  const shelfW = clamp(num(p.shelfWidth, 120), 20, BED - 6);
  const shelfD = clamp(num(p.shelfDepth, 45), 8, 150);
  const shelfT = clamp(num(p.shelfThickness, 4), 1.2, 16);
  const lipH = clamp(num(p.lipHeight, 6), 0, 40);
  const trayH = clamp(num(p.trayHeight, 50), 6, 150);
  const wall = snapWall(clamp(num(p.wall, 2.0), 0.8, 8));
  const drain = !!p.drain;

  const cupDia = clamp(num(p.cupDia, 42), 10, 150);
  const cupH = clamp(num(p.cupHeight, 70), 10, 160);

  const boreDia = clamp(num(p.boreDia, 8), 1.5, 40);
  const boreCount = Math.round(clamp(num(p.boreCount, 6), 1, 20));
  const boreRows = Math.round(clamp(num(p.boreRows, 1), 1, 5));

  // ---- how many tabs, and where -------------------------------------------
  //
  // Two tab columns in the SAME row must be a whole pitch apart, because
  // adjacent columns on a Skådis are staggered by half a pitch and would not
  // line up. That is why the spacing here is `pitch` and never `pitch / 2`.
  const tabSpanX = (tabCols - 1) * pitch;
  const tabSpanZ = (tabRows - 1) * pitch;

  // Plate must be tall enough to carry the tab grid and the barb below it.
  const plateHMin = tabSpanZ + prongT + legHeight + margin * 2;
  // A snap mount needs a relief slot either side of every tab, and those slots
  // have to stay clear of the plate's own rounded corners or the cutter runs
  // tangentially into the arc and the CSG comes out non-manifold. Cheaper to
  // give the plate the width than to make the tongue too narrow to spring.
  const plateWMin = tabSpanX + slotW + margin * 2 + (snap ? 16 : 0);

  let plateW = plateWMin, plateH = plateHMin;
  if (type === 'label') plateW = Math.max(plateW, cardW * 0.5);
  if (type === 'shelf' || type === 'tray' || type === 'toolplate') plateW = Math.max(plateW, shelfW);
  if (type === 'cup') plateW = Math.max(plateW, Math.min(cupDia, BED - 6));
  if (type === 'tray') plateH = Math.max(plateH, trayH * 0.6);
  if (type === 'cup') plateH = Math.max(plateH, cupH * 0.55);
  if (type === 'gauge') {
    // Five tabs across the 20 mm checkerboard, the odd ones dropped half a
    // pitch: (n−1) half-pitches wide, and half a pitch taller for the stagger.
    plateW = Math.max(plateW, (GAUGE_STEPS.length - 1) * (pitch / 2) + slotW + margin * 2);
    plateH = Math.max(plateH, margin + prongT + legHeight + 30 + pitch / 2);
  }
  plateW = Math.min(plateW, BED - 4);
  plateH = Math.min(plateH, BED - 4);

  // Tab rows are laid from the top of the plate down, because the top tab is
  // the one that carries the pull-out load on a cantilevered part.
  const zTop = plateH - margin - prongT - legHeight;
  const tabZ = [];
  for (let r = 0; r < tabRows; r++) {
    const z = zTop - r * pitch;
    if (z >= 0.2) tabZ.push(z);
  }
  if (!tabZ.length) tabZ.push(clamp(plateH - prongT - legHeight - 0.2, 0.2, Math.max(0.2, plateH - prongT - legHeight)));

  const tabX = [];
  for (let c = 0; c < tabCols; c++) tabX.push(-tabSpanX / 2 + c * pitch);

  // Where the body meets the plate. Arms hang off the lower half so the plate
  // above them carries the moment into the top row of tabs.
  const armZ = clamp(type === 'label' ? margin + stock : plateH * 0.28, stock / 2 + 0.4, plateH - stock / 2 - 0.4);

  return {
    p, ctx, sf, type, volume, prismatic: !volume,
    slotW, slotH, pitch, boardT, fitClear, neckW, plateT, margin, prongT, legHeight,
    tabCols, tabRows, tabX, tabZ, snap, plateW, plateH,
    fillet, armW, stock, reach, rise, returnH, bendR, prongGap,
    cableDia, grip, cardW, cardH, cardTilt,
    shelfW, shelfD, shelfT, lipH, trayH, wall, drain, cupDia, cupH,
    boreDia, boreCount, boreRows, armZ,
    yBack: -(boardT + fitClear),
  };
}

// ---------------------------------------------------------------------------
// The tab.
//
// Drawn in the Y–Z plane and extruded across the board to `neckW`, because the
// only dimension the slot constrains is the one across the board. The profile
// is the neck rectangle unioned with the barb quad; they are given a small
// weld overlap in Z because two rectangles meeting at a single point is a
// non-manifold pinch, not a join.
// ---------------------------------------------------------------------------

function tabProfile(s, zN, clearAdj = 0) {
  // zN is the height of the slot floor the prong comes to rest on.
  const w = s.prongT;
  const r = w / 2;
  const yBack = -(s.boardT + s.fitClear + clearAdj);
  const legY = yBack - r;        // centreline of the leg running up the back
  const zc = zN + r;             // centreline of the bridge through the slot

  // Out of the plate, through the slot, then straight up the back of the board.
  // thickenPath puts a disc at the corner, so the bend comes out with a radius
  // of half the prong — which is what the moulded ones have, and what keeps the
  // highest-stress point on the part off a sharp internal corner.
  const path = [
    [s.plateT * 0.6, zc],
    [legY, zc],
    [legY, zc + s.legHeight],
  ];
  let prof = thickenPath(path, w, s.sf);

  if (s.snap) {
    // A lump on the front of the leg, near its tip. Pushing the part on drives
    // the leg back until the lump clears the board and then it springs home;
    // the U-relief cut in the plate is what lets it flex at all.
    const bump = [circle(r * 0.62, { segs: Math.max(8, Math.round(12 * Math.sqrt(s.sf))),
      cx: yBack + r * 0.3, cy: zc + s.legHeight - r * 0.8 })];
    prof = boolean(prof, bump, 'union');
  }
  return prof;
}

/**
 * A tab as a prism with both across-the-board end caps chamfered at 45 degrees.
 *
 * This matters only for the prismatic family, where across-the-board IS the
 * build direction: the tab appears part way up the print, and its lower end cap
 * is a horizontal face hanging in air over the part of the neck that reaches
 * through the board. Chamfering it means the material grows out at 45 degrees
 * from a smaller seed instead of arriving all at once.
 *
 * What gets inset is the tab profile ALONE, not the tab unioned with the
 * plate's side profile. Unioning the plate in looks like the way to keep the
 * seed anchored, and it is not: two tabs in the same column then each carry a
 * full copy of the plate, the copies land exactly on top of each other, and the
 * CSG union comes out non-manifold. The seed does not need a 2D anchor anyway —
 * most of it lies within the plate's own y range, so it is sitting on plate
 * material in 3D, and the rest grows out from there at 45 degrees.
 *
 * Any case where the inset does not come back as a single clean island — a barb
 * thinner than the chamfer, a neck narrower than twice it — falls back to a
 * plain prism rather than risking the loft.
 */
function tabSolid(s, prof, w, x0) {
  const c = Math.min(w * 0.4, 1.6);
  const one = (sh) => Array.isArray(sh) && sh.length === 1 && Array.isArray(sh[0]) && sh[0].length === 1;
  const plain = () => extrudeThroughX(prof, w, x0, { check: false });
  if (!s.prismatic || !(c > 0.1) || w <= 2 * c + 0.2) return plain();
  let inset;
  try { inset = offset(prof, -c, { join: 'round', arcTolerance: 0.06 }); } catch { return plain(); }
  if (!one(inset) || !one(prof)) return plain();
  try {
    return loft([
      { shape: inset[0], z: -w / 2 },
      { shape: prof[0], z: -w / 2 + c },
      { shape: prof[0], z: w / 2 - c },
      { shape: inset[0], z: w / 2 },
    ], { check: false }).mapVerts((u, v, wv) => [wv + x0, u, v]);
  } catch { return plain(); }
}

/** Distance to the nearest neighbouring tab column, or Infinity if it is alone. */
function neighbourGap(xs, i) {
  let best = Infinity;
  for (let j = 0; j < xs.length; j++) if (j !== i) best = Math.min(best, Math.abs(xs[j] - xs[i]));
  return best;
}

/** Every tab as one mesh, plus the relief cutters a snap mount needs. */
function mountSolids(s) {
  const solids = [], cutters = [];
  const clearAdjFor = (col) => (s.type === 'gauge' ? GAUGE_STEPS[col % GAUGE_STEPS.length] : 0);

  const gaugePos = s.type === 'gauge' ? gaugeTabs(s.pitch, s.tabZ[0]) : null;
  const xs = gaugePos ? gaugePos.map(t => t.x) : s.tabX;

  xs.forEach((x0, col) => {
    for (const zN of (gaugePos ? [gaugePos[col].z] : s.tabZ)) {
      const adj = clearAdjFor(col);
      const w = clamp(s.neckW - adj, NOZZLE * 2, s.slotW + 2);
      const prof = tabProfile(s, zN, adj);
      if (!prof.length) continue;
      solids.push(tabSolid(s, prof, w, x0));

      if (s.snap) {
        // A U cut around the tab turns it into a cantilever tongue, which is
        // the only thing that lets a snap barb deflect on the way in. Without
        // it the "snap" is an interference fit that splits the plate.
        // Two slots either side of a TONGUE, open at the top and closed at
        // the bottom, so the tongue is a cantilever rooted in the plate.
        //
        // Two things this got wrong first time round. Running the slots the
        // full height of the plate severs the tongue at BOTH ends — it is then
        // a loose strip of plastic sitting in a hole, which the CSG reports as
        // non-manifold and which would have fallen out of the print. And a
        // tongue only as wide as the prong is both too stiff to deflect and too
        // weak to survive it, so it is deliberately wider — but then on the fit
        // gauge, whose tabs are half a pitch apart, neighbouring tongues overlap and
        // the cutters run into each other. Where there is no room, there is no
        // relief: validate() says so rather than the geometry quietly failing.
        const gap = clamp(NOZZLE * 2, 0.6, 1.6);
        const room = neighbourGap(xs, col) - gap * 2 - 1.2;
        const clearOfCorner = 2 * (s.plateW / 2 - s.fillet - 1 - Math.abs(x0) - gap);
        const tongue = Math.min(w + 5, room, clearOfCorner);
        if (tongue < w + 1.2) continue;
        const zBot = Math.max(2, Math.min(...s.tabZ) - gap - 3);
        const h = s.plateH + 2 - zBot;
        const u = boolean(
          [ensureCCW(rect(tongue + gap * 2, h, { cx: x0, cy: zBot + h / 2 }))],
          [ensureCCW(rect(tongue, h, { cx: x0, cy: zBot + h / 2 }))],
          'difference');
        if (u.length) cutters.push(extrudeThroughY(u, s.plateT + 2, -1, { check: false }));
      }
    }
  });
  return { solids, cutters };
}

// ---------------------------------------------------------------------------
// The back plate
// ---------------------------------------------------------------------------

function backPlate(s) {
  const r = clamp(Math.min(s.fillet, s.plateW / 2 - 0.4, s.plateH / 2 - 0.4), 0, 20);
  const segs = Math.max(4, Math.round(8 * Math.sqrt(s.sf)));
  const shape = r > 0.2
    ? [ensureCCW(roundRect(s.plateW, s.plateH, r, { segs, cy: s.plateH / 2 }))]
    : [ensureCCW(rect(s.plateW, s.plateH, { cy: s.plateH / 2 }))];
  return { mesh: extrudeThroughY(shape, s.plateT, 0, { check: false }), shape };
}

// ---------------------------------------------------------------------------
// Prismatic bodies — all drawn in the Y–Z plane, all extruded across the board.
//
// Each returns { shape, width, x } or a list of them. The plate's own profile
// is unioned into every one of them before extrusion so that the body and the
// plate are one connected solid at every X where the body exists, rather than
// two solids touching along a face.
// ---------------------------------------------------------------------------

/** The plate as seen in the Y–Z side view: a rectangle, full height. */
function plateSideProfile(s) {
  return [ensureCCW(rect(s.plateT, s.plateH, { cx: s.plateT / 2, cy: s.plateH / 2 }))];
}

function armPath(s) {
  const y0 = s.plateT * 0.4;
  const a = s.rise * DEG;
  const pts = [[y0, s.armZ]];
  const tipY = y0 + s.reach * Math.cos(a);
  const tipZ = s.armZ + s.reach * Math.sin(a);
  pts.push([tipY, tipZ]);

  if (s.type === 'jhook' && s.returnH > 0.5) {
    // A quarter turn of radius bendR out of the arm, then a straight run up.
    const R = Math.min(s.bendR, s.returnH * 0.9 + 0.1);
    const steps = Math.max(3, Math.round(7 * Math.sqrt(s.sf)));
    const cx = tipY, cy = tipZ + R;
    for (let i = 1; i <= steps; i++) {
      const th = -Math.PI / 2 + (Math.PI / 2) * (i / steps) + a;
      pts.push([cx + R * Math.cos(th) - R * Math.cos(-Math.PI / 2 + a),
        cy + R * Math.sin(th) - R * Math.sin(-Math.PI / 2 + a)]);
    }
    const last = pts[pts.length - 1];
    const rem = Math.max(0, s.returnH - R);
    if (rem > 0.2) pts.push([last[0], last[1] + rem]);
  } else if (s.type === 'longarm' || s.type === 'peg') {
    // A short stop at the tip so a tape roll cannot walk off the end.
    const stopH = s.type === 'longarm'
      ? clamp(s.stock * 1.4, 3, 22)
      : clamp(s.stock * 0.55, 1.2, 10);
    pts.push([tipY, tipZ + stopH]);
  }
  return pts;
}

function bodySlabsPrismatic(s) {
  const plate = plateSideProfile(s);
  const out = [];

  if (ARMS.includes(s.type)) {
    const path = armPath(s);
    const arm = thickenPath(path, s.stock, s.sf);
    let shape = boolean(plate, arm, 'union');
    // The root fillet, clamped so the close cannot swallow the gap between the
    // arm and its own return.
    const rMax = s.type === 'jhook' ? Math.max(0.2, (s.reach * 0.5)) : 20;
    shape = filletInner(shape, Math.min(s.fillet, s.stock * 0.9, rMax), s.sf);
    if (s.type === 'double') {
      const g = Math.max(s.prongGap, s.armW + 1);
      out.push({ shape, width: s.armW, x: -g / 2 });
      out.push({ shape, width: s.armW, x: +g / 2 });
    } else {
      out.push({ shape, width: s.armW, x: 0 });
    }
    return out;
  }

  if (s.type === 'clip') {
    // A C that snaps over a cable. The mouth is `grip` of the cable diameter,
    // so the cable has to spread the arms to get in and is then held.
    const wall = snapWall(clamp(s.stock * 0.3, 1.2, 4));
    const rIn = s.cableDia / 2;
    const rOut = rIn + wall;
    const segs = circleSegs(rOut, s.sf);
    const cy = s.armZ + rOut;
    const cyY = s.plateT + rOut;
    const ringShape = boolean(
      [circle(rOut, { segs, cx: cyY, cy })],
      [circle(rIn, { segs, cx: cyY, cy })], 'difference');
    // Open the mouth facing away from the board.
    const mouth = clamp(s.cableDia * s.grip, NOZZLE * 2, s.cableDia * 0.98);
    const cut = [ensureCCW(rect(rOut * 2 + 2, mouth, { cx: cyY + rOut, cy }))];
    let shape = boolean(ringShape, cut, 'difference');
    shape = boolean(plate, shape, 'union');
    shape = filletInner(shape, Math.min(s.fillet, wall * 0.9, mouth * 0.4), s.sf);
    out.push({ shape, width: clamp(s.armW, NOZZLE * 3, 60), x: 0 });
    return out;
  }

  if (s.type === 'label') {
    // A tilted pocket: a floor leaning back by cardTilt, and a front lip that
    // keeps the card in. Card width is the extrusion width.
    const t = clamp(s.stock * 0.35, 1.2, 5);
    const a = (90 - s.cardTilt) * DEG;
    const y0 = s.plateT * 0.4, z0 = s.armZ;
    const spine = [[y0, z0], [y0 + s.cardH * Math.cos(a), z0 + s.cardH * Math.sin(a)]];
    const floorPts = [[y0, z0 - t], [y0 + Math.max(3, s.cardH * 0.28), z0 - t]];
    let shape = union2d([thickenPath(spine, t, s.sf), thickenPath(floorPts, t, s.sf)]);
    // The lip at the front of the floor.
    const lip = [[floorPts[1][0], floorPts[1][1]], [floorPts[1][0], floorPts[1][1] + clamp(s.cardH * 0.2, 2, 12)]];
    shape = union2d([shape, thickenPath(lip, t, s.sf)]);
    shape = boolean(plate, shape, 'union');
    shape = filletInner(shape, Math.min(s.fillet, t * 0.9), s.sf);
    out.push({ shape, width: clamp(s.cardW, NOZZLE * 3, BED - 6), x: 0 });
    return out;
  }

  // gauge — the plate alone; the tabs are the point of it.
  out.push({ shape: plate, width: Math.min(s.plateW, BED - 4), x: 0 });
  return out;
}

// ---------------------------------------------------------------------------
// Volume bodies — drawn in plan and extruded up, printed as used.
// ---------------------------------------------------------------------------

/**
 * A 45 degree haunch at the joint between the plate and a flat shelf, at each
 * tab column.
 *
 * Deliberately small. A shelf printed as used has no underside to brace from,
 * so this web stands UP off the shelf, and sized to the full depth it is not a
 * gusset but an 18 mm fin down the middle of the thing you wanted to put
 * screwdrivers on. What the joint actually needs is a haunch a couple of floor
 * thicknesses tall. Trays and cups get none at all: their own walls already
 * brace the plate, and a fin inside a bin is just something to catch on.
 */
function gussets(s, depth, height) {
  const g = clamp(Math.min(depth * 0.4, height * 0.6, s.shelfT * 2.5, 12), 0, 12);
  if (!(g > 1.5)) return [];
  const t = snapWall(clamp(s.shelfT * 0.6, 1.2, 4));
  const tri = [ensureCCW([
    [s.plateT, 0], [s.plateT + g, 0], [s.plateT, g],
  ])];
  return s.tabX.map(x => extrudeThroughX(tri, t, x, { check: false }));
}

function bodyVolume(s) {
  const solids = [], cutters = [];
  let capacity = 0;
  // Bodies start INSIDE the plate, never behind it. Starting at -y0 to
  // guarantee the union welds looks harmless and is not: the plate's front face
  // is the board's front face, so anything at negative y is material sitting
  // where the board is, and it fails the insertion test by exactly that much.
  const y0 = clamp(s.plateT * 0.5, 0.4, s.plateT - 0.2);

  if (s.type === 'shelf' || s.type === 'toolplate') {
    const d = s.shelfD;
    const r = clamp(Math.min(s.fillet, s.shelfW / 2 - 0.4, d / 2 - 0.4), 0, 20);
    const planCy = y0 + d / 2;
    const plan = r > 0.2
      ? [ensureCCW(roundRect(s.shelfW, d, r, { cy: planCy }))]
      : [ensureCCW(rect(s.shelfW, d, { cy: planCy }))];
    solids.push(extrudeUp(plan, s.shelfT, 0, { check: false }));
    solids.push(...gussets(s, d, Math.min(s.plateH - 1, d)));

    if (s.type === 'shelf' && s.lipH > 0.4) {
      // A rim around the three open sides, made by taking the plan, shrinking
      // it, and using the difference as a wall.
      const inner = offset(plan, -snapWall(clamp(s.shelfT * 0.5, 1.2, 4)), { join: 'round', arcTolerance: 0.06 });
      if (inner.length) {
        const ring = boolean(plan, inner, 'difference');
        if (ring.length) solids.push(extrudeUp(ring, s.lipH, s.shelfT - 0.01, { check: false }));
      }
    }

    if (s.type === 'toolplate') {
      // Bores, laid out on a grid inside the plate with a margin that keeps
      // two extrusions of material between neighbours.
      const rB = s.boreDia / 2;
      const cols = Math.max(1, Math.ceil(s.boreCount / s.boreRows));
      // Two extrusions of material at the plate's edge is what the arithmetic
      // allows and not what survives a screwdriver being dropped into it.
      const edge = Math.max(2.5, rB * 0.6);
      const usableW = s.shelfW - 2 * (rB + edge);
      const usableD = d - 2 * (rB + edge);
      if (usableW > 0.4 && usableD > 0.4) {
        const dx = cols > 1 ? usableW / (cols - 1) : 0;
        const dy = s.boreRows > 1 ? usableD / (s.boreRows - 1) : 0;
        const bore = [];
        let made = 0;
        for (let ry = 0; ry < s.boreRows && made < s.boreCount; ry++) {
          for (let cx = 0; cx < cols && made < s.boreCount; cx++, made++) {
            const px = cols > 1 ? -usableW / 2 + cx * dx : 0;
            const py = planCy + (s.boreRows > 1 ? -usableD / 2 + ry * dy : 0);
            // Full height, not just the floor: a gusset or a rim standing in
            // the way of a bore means the tool cannot go into it, so the bore
            // has to be clear all the way up.
            bore.push(extrudeUp([circle(rB, { segs: circleSegs(rB, s.sf), cx: px, cy: py })],
              s.plateH + s.shelfT + 4, -1, { check: false }));
          }
        }
        cutters.push(...bore);
      }
    }
    return { solids, cutters, capacity };
  }

  if (s.type === 'tray') {
    const d = s.shelfD;
    const r = clamp(Math.min(s.fillet, s.shelfW / 2 - 0.4, d / 2 - 0.4), 0, 20);
    const planCy = y0 + d / 2;
    const plan = r > 0.2
      ? [ensureCCW(roundRect(s.shelfW, d, r, { cy: planCy }))]
      : [ensureCCW(rect(s.shelfW, d, { cy: planCy }))];
    solids.push(extrudeUp(plan, s.trayH, 0, { check: false }));
    const floor = clamp(s.wall, 0.8, Math.max(0.8, s.trayH - 0.8));
    const inner = offset(plan, -s.wall, { join: 'round', arcTolerance: 0.06 });
    if (inner.length && s.trayH - floor > 0.3) {
      cutters.push(extrudeUp(inner, s.trayH - floor + 1, floor, { check: false }));
      // Capacity from the interior the cavity actually has, not from the
      // rectangle it was drawn inside — the corners are rounded and the back
      // is cut into the plate.
      capacity = shapeArea(inner) * (s.trayH - floor);
    }
    if (s.drain) {
      const n = 3, sw = clamp(s.shelfW * 0.5, 4, s.shelfW - 4);
      for (let i = 0; i < n; i++) {
        const py = planCy - d / 2 + d * ((i + 1) / (n + 1));
        cutters.push(extrudeUp([ensureCCW(slot(sw, clamp(s.wall * 0.9, 0.8, 3),
          { segs: Math.max(6, Math.round(10 * Math.sqrt(s.sf))), cy: py }))],
        floor + 2, -1, { check: false }));
      }
    }
    return { solids, cutters, capacity };
  }

  // cup
  const rOut = s.cupDia / 2;
  const cs = circleSegs(rOut, s.sf);
  // The cup is flattened where it meets the plate: the circle's centre is
  // pushed forward so a chord of it lands at y0, and the sliver between that
  // chord and the plate is filled in. Nothing reaches behind y = 0.
  const flat = clamp(rOut * 0.3, 0.2, rOut * 0.8);
  const cy = y0 + rOut - flat;
  const outerCirc = [circle(rOut, { segs: cs, cy })];
  // Truncate at y0 rather than filling forward to it. Filling leaves the back
  // of the circle sitting `flat` millimetres behind the board's front face —
  // which looks identical in the viewport and fails the insertion test by
  // exactly that much.
  const behind = [ensureCCW(rect(rOut * 4, rOut * 4, { cy: y0 - rOut * 2 }))];
  const plan = boolean(outerCirc, behind, 'difference');
  solids.push(extrudeUp(plan, s.cupH, 0, { check: false }));
  const floor = clamp(s.wall, 0.8, Math.max(0.8, s.cupH - 0.8));
  const inner = offset(plan, -s.wall, { join: 'round', arcTolerance: 0.06 });
  if (inner.length && s.cupH - floor > 0.3) {
    cutters.push(extrudeUp(inner, s.cupH - floor + 1, floor, { check: false }));
    capacity = shapeArea(inner) * (s.cupH - floor);
  }
  return { solids, cutters, capacity };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const s = layout(p, ctx);
  const notes = [];

  const solids = [];
  const cutters = [];
  let measuredCapacity = 0;

  const plate = backPlate(s);

  if (s.prismatic) {
    // Body slabs each carry the plate's own side profile, so plate and body are
    // one connected region at every X where the body exists.
    for (const slab of bodySlabsPrismatic(s)) {
      if (!slab.shape || !slab.shape.length) continue;
      solids.push(extrudeThroughX(slab.shape, slab.width, slab.x, { check: false }));
    }
    solids.push(plate.mesh);
  } else {
    solids.push(plate.mesh);
    const b = bodyVolume(s);
    solids.push(...b.solids);
    cutters.push(...b.cutters);
    measuredCapacity = b.capacity || 0;
  }

  const mounts = mountSolids(s);
  solids.push(...mounts.solids);
  cutters.push(...mounts.cutters);

  let mesh = solids.length === 1 ? solids[0] : unionAll(solids);
  if (cutters.length) mesh = subtractAll(mesh, cutters);

  // The gauge's identifying marks: n through-holes under the nth tab, so the
  // one that fits can be read off the print rather than remembered.
  if (s.type === 'gauge') {
    // n holes under the nth tab, so the tab that fits can be READ off the print
    // rather than remembered. They go in the clear band between the bottom of
    // the plate and the tip of the barb, spread to fill it. Laid out on a fixed
    // pitch from the bottom instead, the longer rows run up into the tabs and
    // the gauge silently reads 3-3-3-2-1 rather than 1-2-3-4-5 — which no test
    // caught and one look at the render did.
    const marks = [];
    const n = GAUGE_STEPS.length;
    // Each column's band runs from the plate's foot to its OWN tab, because the
    // staggered tabs sit half a pitch lower and a shared band would run the
    // longer rows of holes up into them.
    gaugeTabs(s.pitch, s.tabZ[0]).forEach(({ x: x0, z: zN }, i) => {
      const lo = 2, hi = Math.min(zN - 2, s.plateH - 2);
      const rM = clamp(Math.min(s.slotW * 0.24, (hi - lo) / (n - 1) * 0.34), 0.6, 1.8);
      if (hi - lo <= rM * 3) return;
      const step = (hi - lo) / (n - 1);
      for (let k = 0; k <= i; k++) {
        marks.push(extrudeThroughY(
          [circle(rM, { segs: Math.max(8, Math.round(12 * Math.sqrt(s.sf))), cx: x0, cy: lo + k * step })],
          s.plateT + 2, -1, { check: false }));
      }
    });
    if (marks.length) mesh = subtractAll(mesh, marks);
  }

  // heal, weld, compact — but NOT dropDegenerate(). The CSG union leaves a few
  // triangles whose area is under the degeneracy threshold and which are
  // nevertheless part of the closed shell; deleting them punches topological
  // holes in a mesh that was watertight. Measured: 23 boundary edges on the
  // peg, 173 on the tool plate, purely from that one call.
  mesh = mesh.healTJunctions().weld(1e-6).compact();

  // Delivered in its print orientation, not its use orientation. A prismatic
  // part is rolled a quarter turn so that "across the board" becomes the build
  // direction; a volume part is already the right way up.
  if (s.prismatic) mesh = mesh.rotateY(-Math.PI / 2);
  const unplaced = mesh.bbox();
  mesh = mesh.place();

  const bb = mesh.bbox();
  if (bb.size[0] > BED || bb.size[1] > BED) notes.push('This is wider than the A1 mini bed.');

  const liftToRelease = s.legHeight;
  const headroom = s.slotH - s.prongT - s.legHeight;

  return {
    mesh,
    meta: {
      family: s.prismatic ? 'prismatic' : 'volume',
      orientation: s.prismatic ? 'on its side, back plate against the bed edge' : 'as used, floor on the bed',
      tabs: s.type === 'gauge' ? GAUGE_STEPS.length : s.tabX.length * s.tabZ.length,
      tabX: s.tabX.slice(), tabZ: s.tabZ.slice(),
      neckWidth: +s.neckW.toFixed(3),
      liftToRelease: +liftToRelease.toFixed(2),
      slotHeadroom: +headroom.toFixed(2),
      plate: [+s.plateW.toFixed(1), +s.plateH.toFixed(1), +s.plateT.toFixed(1)],
      size: bb.size.map(v => +v.toFixed(2)),
      capacityMl: +(measuredCapacity / 1000).toFixed(1),
      notes,
      dims: dimCallouts(s, unplaced),
    },
  };
}

// ---------------------------------------------------------------------------
// Dimension callouts.
//
// Every point is worked out in the drawing frame the builders use — x across
// the board, y out of it, z up — from the same numbers they use, and then put
// through exactly what build() did to the mesh: the prismatic roll
// (x, y, z) -> (-z, y, x), then the shift place() applied. That last step is
// the one that shipped a tab upside down once: a callout declared in the
// drawing frame lands on the placed object only if it makes the same journey.
// ---------------------------------------------------------------------------

/** `value` is declared only where the built length is not the number asked for
 *  (a snapped wall, a clamped radius, a long arm's 1.8x reach), so the figure
 *  on the callout is always what was built and the disagreement is explicit. */
function realValue(p, key, len) {
  const asked = Number(p && p[key]);
  return Number.isFinite(asked) && Math.abs(len - asked) > 0.02 ? { value: len } : {};
}

function dimCallouts(s, ub) {
  const P = s.prismatic
    ? (x, y, z) => [-z - ub.center[0], y - ub.center[1], x - ub.min[2]]
    : (x, y, z) => [x - ub.center[0], y - ub.center[1], z - ub.min[2]];
  // Offsets are directions whose length the viewer scales to pixels at the
  // fitted zoom, so they are in tenths of the span, not millimetres. They are
  // given in the drawing frame and rolled with the points.
  const o = Math.max(ub.size[0], ub.size[1], ub.size[2]) * 0.1;
  const dir = s.prismatic ? (v) => [-v[2] * o, v[1] * o, v[0] * o] : (v) => [v[0] * o, v[1] * o, v[2] * o];
  const dims = [];
  const D = (param, label, from, to, offset) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    dims.push({ param, label, from, to, offset: dir(offset), ...realValue(s.p, param, len) });
  };
  const gauge = s.type === 'gauge';

  // ---- the mount, shared by every type --------------------------------------
  const r = s.prongT / 2;
  const x0 = gauge ? gaugeTabs(s.pitch, s.tabZ[0])[0].x : s.tabX[0];
  const neckW = gauge ? clamp(s.neckW - GAUGE_STEPS[0], NOZZLE * 2, s.slotW + 2) : s.neckW;
  const zN = s.tabZ[0];
  const zc = zN + r;
  const yBack = gauge ? -(s.boardT + s.fitClear + GAUGE_STEPS[0]) : s.yBack;
  const legY = yBack - r;
  const xe = x0 + neckW / 2;                         // the tab's end face
  const zLeg = zN + s.prongT + s.legHeight * 0.5;    // half way up the leg, clear of the bridge
  // The slot: as wide as the neck plus its clearance, drawn on the neck where
  // it passes through the board.
  D('slotWidth', 'slot', P(x0 - s.slotW / 2, -s.boardT / 2, zc), P(x0 + s.slotW / 2, -s.boardT / 2, zc), [0, -1, 0]);
  D('slotHeight', 'slot', P(xe, legY - r, zN), P(xe, legY - r, zN + s.slotH), [0, -1, 0]);
  if (s.tabX.length > 1 && !gauge) {
    D('slotPitch', 'pitch', P(s.tabX[0], legY, zc), P(s.tabX[1], legY, zc), [0, -1, 0]);
  } else if (s.tabZ.length > 1) {
    D('slotPitch', 'pitch', P(x0, legY, s.tabZ[0] + r), P(x0, legY, s.tabZ[1] + r), [0, -1, 0]);
  }
  // Behind the plate: the board's thickness, then the fit clearance between the
  // board's back face and the leg, then the leg's own thickness.
  D('boardThickness', 'board', P(xe, 0, zLeg), P(xe, -s.boardT, zLeg), [0, 0, 1]);
  D('fitClearance', 'clearance', P(xe, -s.boardT, zLeg), P(xe, yBack, zLeg), [0, 0, 1]);
  D('prongThickness', 'prong', P(xe, -s.boardT / 2, zN), P(xe, -s.boardT / 2, zN + s.prongT), [0, 0, 1]);
  D('legHeight', 'leg', P(x0, legY, zN + s.prongT), P(x0, legY, zN + s.prongT + s.legHeight), [0, -1, 0]);
  // The plate: its thickness on its top corner, its margin above the top tab,
  // and the corner radius.
  D('plateThickness', 'plate', P(s.plateW / 2, 0, s.plateH), P(s.plateW / 2, s.plateT, s.plateH), [1, 0, 0]);
  D('plateMargin', 'margin', P(x0, 0, s.plateH), P(x0, 0, s.plateH - s.margin), [0, -1, 0]);
  const rc = clamp(Math.min(s.fillet, s.plateW / 2 - 0.4, s.plateH / 2 - 0.4), 0, 20);
  if (rc > 0.2) {
    const cx = s.plateW / 2 - rc, cz = s.plateH - rc;
    D('fillet', 'R', P(cx, 0, cz), P(cx + rc * Math.SQRT1_2, 0, cz + rc * Math.SQRT1_2), [0, -1, 0]);
  }

  // ---- the arms ---------------------------------------------------------------
  if (ARMS.includes(s.type)) {
    const path = armPath(s);
    const a = s.rise * DEG;
    const [y0, z0] = path[0], [tipY, tipZ] = path[1];
    const g = s.type === 'double' ? Math.max(s.prongGap, s.armW + 1) : 0;
    const xa = (s.type === 'double' ? g / 2 : 0) + s.armW / 2;   // the arm's top face once rolled
    D('reach', 'reach', P(xa, y0, z0), P(xa, tipY, tipZ), [0, 0, 1]);
    const my = (y0 + tipY) / 2, mz = (z0 + tipZ) / 2, ny = -Math.sin(a), nz = Math.cos(a), h = s.stock / 2;
    D('stock', 'arm', P(xa, my - ny * h, mz - nz * h), P(xa, my + ny * h, mz + nz * h), [0, 1, 0]);
    D('armWidth', 'arm', P(xa - s.armW, my, mz), P(xa, my, mz), [0, 0, 1]);
    if (s.type === 'double') D('prongGap', 'gap', P(-g / 2, tipY, tipZ), P(g / 2, tipY, tipZ), [0, 1, 0]);
    if (s.type === 'jhook' && s.returnH > 0.5) {
      const R = Math.min(s.bendR, s.returnH * 0.9 + 0.1);
      const last = path[path.length - 1];
      // The return as built: from the arm's upper face at the tip to the top of
      // the upturn — its centreline runs a bend radius further than returnH.
      D('returnH', 'return', P(xa, last[0], tipZ + h), P(xa, last[0], last[1] + h), [0, 1, 0]);
      const ccy = tipY - R * Math.sin(a), ccz = tipZ + R * (1 + Math.cos(a));
      const th = -Math.PI / 2 + a + Math.PI / 4;
      D('bendR', 'R', P(xa, ccy, ccz), P(xa, ccy + R * Math.cos(th), ccz + R * Math.sin(th)), [0, 0, 1]);
    }
  }

  if (s.type === 'clip') {
    const wall = snapWall(clamp(s.stock * 0.3, 1.2, 4));
    const rIn = s.cableDia / 2, rOut = rIn + wall;
    const cy = s.armZ + rOut, cyY = s.plateT + rOut;
    D('cableDia', 'cable Ø', P(s.armW / 2, cyY, cy - rIn), P(s.armW / 2, cyY, cy + rIn), [0, 0, 1]);
  }

  if (s.type === 'label') {
    const a = (90 - s.cardTilt) * DEG;
    const y0 = s.plateT * 0.4, z0 = s.armZ;
    D('cardHeight', 'card', P(s.cardW / 2, y0, z0), P(s.cardW / 2, y0 + s.cardH * Math.cos(a), z0 + s.cardH * Math.sin(a)), [0, 0, 1]);
  }

  // ---- the volume bodies --------------------------------------------------------
  if (s.volume) {
    const y0 = clamp(s.plateT * 0.5, 0.4, s.plateT - 0.2);
    if (s.type === 'shelf' || s.type === 'toolplate' || s.type === 'tray') {
      const d = s.shelfD, hw = s.shelfW / 2, ym = y0 + d / 2;
      const top = s.type === 'tray' ? s.trayH : s.shelfT + (s.type === 'shelf' ? s.lipH : 0);
      D('shelfDepth', 'depth', P(0, y0, top), P(0, y0 + d, top), [0, 0, 1]);
      D('shelfThickness', 'floor', P(hw, ym, 0), P(hw, ym, s.shelfT), [1, 0, 0]);
      if (s.type === 'shelf' && s.lipH > 0.4) D('lipHeight', 'rim', P(hw, ym, s.shelfT), P(hw, ym, s.shelfT + s.lipH), [1, 0, 0]);
      if (s.type === 'tray') {
        D('trayHeight', 'tray', P(hw, ym, 0), P(hw, ym, s.trayH), [1, 0, 0]);
        D('wall', 'wall', P(hw - s.wall, ym, s.trayH), P(hw, ym, s.trayH), [0, 0, 1]);
      }
      if (s.type === 'toolplate') {
        const rB = s.boreDia / 2;
        const cols = Math.max(1, Math.ceil(s.boreCount / s.boreRows));
        const edge = Math.max(2.5, rB * 0.6);
        const usableW = s.shelfW - 2 * (rB + edge), usableD = d - 2 * (rB + edge);
        if (usableW > 0.4 && usableD > 0.4) {
          const dx = cols > 1 ? usableW / (cols - 1) : 0;
          const px = cols > 1 ? -usableW / 2 : 0;
          const py = ym + (s.boreRows > 1 ? -usableD / 2 : 0);
          D('boreDia', 'bore Ø', P(px - rB, py, s.shelfT), P(px + rB, py, s.shelfT), [0, -1, 0]);
          if (cols > 1) D('boreCount', 'pitch', P(px, py, s.shelfT), P(px + dx, py, s.shelfT), [0, -1, 0]);
        }
      }
    }
    if (s.type === 'cup') {
      const rOut = s.cupDia / 2;
      const flat = clamp(rOut * 0.3, 0.2, rOut * 0.8);
      const cy = y0 + rOut - flat;
      D('cupDia', 'Ø', P(-rOut, cy, s.cupH), P(rOut, cy, s.cupH), [0, 0, 1]);
      D('cupHeight', 'cup', P(rOut, cy, 0), P(rOut, cy, s.cupH), [1, 0, 0]);
      D('wall', 'wall', P(rOut - s.wall, cy, s.cupH), P(rOut, cy, s.cupH), [0, 0, 1]);
    }
  }
  return dims;
}

/** Analytic interior volume in mm³, used only for hints and cross-checking. */
function estimateCapacity(s) {
  if (s.type === 'tray') {
    const w = Math.max(0, s.shelfW - 2 * s.wall);
    const d = Math.max(0, s.shelfD + s.plateT * 0.5 - 2 * s.wall);
    const h = Math.max(0, s.trayH - s.wall);
    return w * d * h;
  }
  if (s.type === 'cup') {
    const r = Math.max(0, s.cupDia / 2 - s.wall);
    return Math.PI * r * r * Math.max(0, s.cupH - s.wall);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="2.5" y="3" width="19" height="18" rx="1.5"/>' +
  '<rect x="6" y="6" width="2" height="4.5" rx="1"/>' +
  '<rect x="11" y="8.5" width="2" height="4.5" rx="1"/>' +
  '<rect x="16" y="6" width="2" height="4.5" rx="1"/>' +
  '<path d="M7 13.5v3a2.5 2.5 0 0 0 5 0"/></svg>';

const gen = {
  id: 'skadis',
  name: 'Skådis Accessories',
  category: 'Utility',
  blurb: 'Hooks, shelves, trays, cups and tool holders for the IKEA Skådis pegboard.',
  description:
    'Eleven accessories for a Skådis board, all hanging off one mount that is engineered rather than copied. ' +
    'A Skådis opening is not a round hole — it is a 5 × 15 mm obround, and that 15 mm of height is the retention ' +
    'mechanism: a neck passes through the slot, a barb hangs below it behind the board, and the part is inserted ' +
    'at the top of the slot and dropped. Pull-off is resisted by the barb, descent by the neck on the slot floor, ' +
    'and lifting is the deliberate release. The board figures are parameters rather than constants, because IKEA ' +
    'publishes none of them, and a "fit gauge" type prints five tabs at five clearances so a board that disagrees ' +
    'costs one number. Print orientation is chosen per type so that nothing needs support: the small prismatic ' +
    'parts come out lying on their sides with the load running along the extrusions, and the shelves, trays and ' +
    'cups come out as used, where the barb prints from its 45° tip upward and is its own support tower.',
  icon: ICON,
  version: 1,

  params: [
    { key: 'type', label: 'What it is', type: 'enum', def: 'jhook', group: 'Type',
      help: 'Every type shares the same mount; they differ only in what is on the front of it.',
      options: [
        { v: 'peg', label: 'Peg', help: 'A straight arm with a small end stop. Cable coils, keys, mugs.' },
        { v: 'jhook', label: 'J-hook', help: 'An arm that turns up at the end. Bags, coats, tools with a loop.' },
        { v: 'longarm', label: 'Long arm', help: 'A peg made long, for tape rolls, wire and filament spools.' },
        { v: 'double', label: 'Double prong', help: 'Two arms with a gap between them — pliers, scissors, snips.' },
        { v: 'clip', label: 'Cable clip', help: 'A C that snaps over a cable of a stated diameter and holds it.' },
        { v: 'label', label: 'Label / card holder', help: 'A tilted pocket for a card, so a shelf can be named.' },
        { v: 'shelf', label: 'Shelf', help: 'A flat shelf with an optional rim around the three open sides.' },
        { v: 'tray', label: 'Tray / bin', help: 'A deep open box with an optional set of drain slots in the floor.' },
        { v: 'cup', label: 'Cup', help: 'A round pot for pens, bits and offcuts, flattened where it meets the board.' },
        { v: 'toolplate', label: 'Tool holder', help: 'A plate drilled with a row or grid of bores for handles, bits or keys.' },
        { v: 'gauge', label: 'Fit gauge', help: 'Five tabs at five clearances, marked 1–5. Print it once to find your board\'s number.' },
      ] },

    // ---- the board ---------------------------------------------------------
    { key: 'slotWidth', label: 'Slot width', type: 'number', def: 5, min: 3, max: 9, step: 0.1, unit: 'mm', group: 'Board',
      help: 'Across the board. 5 mm on a genuine Skådis; this is the only dimension the neck is constrained by.' },
    { key: 'slotHeight', label: 'Slot height', type: 'number', def: 15, min: 8, max: 30, step: 0.5, unit: 'mm', group: 'Board',
      help: 'Up the board. 15 mm on a Skådis. This is the drop travel — it changes nothing about the shape of the part, it is the budget the neck and the barb have to fit inside, and validate() is what enforces it.' },
    { key: 'slotPitch', label: 'Slot pitch', type: 'number', def: 40, min: 20, max: 60, step: 1, unit: 'mm', group: 'Board',
      help: 'Centre to centre within a row or a column. Adjacent columns are staggered by half of this, so two tabs side by side must be a whole pitch apart.' },
    { key: 'boardThickness', label: 'Board thickness', type: 'number', def: 5, min: 2, max: 12, step: 0.1, unit: 'mm', group: 'Board',
      help: 'How far the neck has to reach before the barb can drop behind it.' },
    { key: 'fitClearance', label: 'Fit clearance', type: 'number', def: FIT.board, min: 0, max: 1.2, step: 0.05, unit: 'mm', group: 'Board',
      help: 'Taken off the neck width and added behind the board. 0.35 mm was measured on the A1 mini in PLA on 2026-09-03 (a tray hung on the workshop board and fitted); print the fit gauge if your board disagrees.' },

    // ---- the mount ---------------------------------------------------------
    { key: 'mountStyle', label: 'Mount', type: 'enum', def: 'dropin', group: 'Mount',
      help: 'Drop-in never flexes, so it never relaxes. Snap resists being knocked upward, at the cost of a permanently strained arm.',
      options: [
        { v: 'dropin', label: 'Drop-in', help: 'Insert at the top of the slot and let it fall. Lift to release.' },
        { v: 'snap', label: 'Snap', help: 'Push straight in. Each tab is cut free as a cantilever tongue so it can deflect.' },
      ] },
    { key: 'tabCols', label: 'Tab columns', type: 'int', def: 2, min: 1, max: 4, step: 1, group: 'Mount',
      help: 'Side by side, one slot pitch apart. Two is the minimum for anything that hangs a load off an arm — one tab is a hinge.' },
    { key: 'tabRows', label: 'Tab rows', type: 'int', def: 1, min: 1, max: 3, step: 1, group: 'Mount',
      help: 'Stacked up the board, one pitch apart. A second row is what stops a heavy shelf rotating off the wall.' },
    { key: 'prongThickness', label: 'Prong thickness', type: 'number', def: 4.5, min: 2, max: 12, step: 0.5, unit: 'mm', group: 'Mount',
      help: 'The section of the prong in side view. It defaults to about the slot width, so the prong comes out square — near enough round once the bend is radiused, which is what the moulded hooks are. Its underside is what rests on the slot floor and carries the weight.' },
    { key: 'legHeight', label: 'Leg height', type: 'number', def: 8, min: 2, max: 16, step: 0.5, unit: 'mm', group: 'Mount',
      help: 'How far the leg rises behind the board — and therefore exactly how far you must lift the part to take it off. The board sits in the throat between the leg and the plate. Prong plus leg must not exceed the slot height, or the leg can never be got in or out.' },
    { key: 'plateThickness', label: 'Plate thickness', type: 'number', def: 4, min: 2, max: 10, step: 0.2, unit: 'mm', group: 'Mount',
      help: 'The back plate. Everything the part carries is reacted through this into the tabs.' },
    { key: 'plateMargin', label: 'Plate margin', type: 'number', def: 5, min: 2, max: 15, step: 0.5, unit: 'mm', group: 'Mount',
      help: 'Material around the outermost tab. Under 3 mm the plate tears out at the tab before anything else fails.' },

    // ---- arms --------------------------------------------------------------
    { key: 'reach', label: 'Reach', type: 'number', def: 35, min: 8, max: 120, step: 1, unit: 'mm', group: 'Arm',
      showIf: (p) => ARMS.includes(p.type),
      help: 'How far the arm comes off the board. Every millimetre here multiplies the load on the top tab.' },
    { key: 'stock', label: 'Arm thickness', type: 'number', def: 7, min: 3, max: 20, step: 0.5, unit: 'mm', group: 'Arm',
      showIf: (p) => ARMS.includes(p.type) || p.type === 'clip' || p.type === 'label',
      help: 'The section of the arm. Doubling this is roughly eight times the bending stiffness, so it is the cheapest strength there is.' },
    { key: 'armWidth', label: 'Arm width', type: 'number', def: 12, min: 4, max: 40, step: 1, unit: 'mm', group: 'Arm',
      showIf: (p) => ARMS.includes(p.type) || p.type === 'clip',
      help: 'Across the board — and, because this family prints on its side, also the height of the print.' },
    { key: 'rise', label: 'Rise', type: 'number', def: 6, min: 0, max: 30, step: 1, unit: '°', group: 'Arm',
      showIf: (p) => ARMS.includes(p.type),
      help: 'Tilt of the arm above horizontal, so what you hang on it stays on it.' },
    { key: 'returnH', label: 'Return height', type: 'number', def: 14, min: 0, max: 40, step: 1, unit: 'mm', group: 'Arm',
      showIf: (p) => p.type === 'jhook',
      help: 'The upturn at the end. 0 turns the J into a peg.' },
    { key: 'bendR', label: 'Bend radius', type: 'number', def: 8, min: 1, max: 30, step: 0.5, unit: 'mm', group: 'Arm',
      showIf: (p) => p.type === 'jhook',
      help: 'How tightly the arm turns up. A tight bend is a stress raiser; a generous one is stronger and easier to load.' },
    { key: 'prongGap', label: 'Prong gap', type: 'number', def: 16, min: 4, max: 60, step: 1, unit: 'mm', group: 'Arm',
      showIf: (p) => p.type === 'double',
      help: 'Centre to centre between the two arms. Set it to what the tool sits on, not to what looks even.' },

    // ---- clip and label ----------------------------------------------------
    { key: 'cableDia', label: 'Cable diameter', type: 'number', def: 8, min: 3, max: 30, step: 0.5, unit: 'mm', group: 'Clip',
      showIf: (p) => p.type === 'clip',
      help: 'The cable this holds. The clip is built around this, not scaled to it afterwards.' },
    { key: 'grip', label: 'Mouth', type: 'number', def: 0.85, min: 0.6, max: 1.0, step: 0.01, group: 'Clip',
      showIf: (p) => p.type === 'clip',
      help: 'Opening as a fraction of the cable diameter. Below 1.0 the cable has to spread the arms to get in, which is what holds it.' },
    { key: 'cardWidth', label: 'Card width', type: 'number', def: 74, min: 20, max: 150, step: 1, unit: 'mm', group: 'Card',
      showIf: (p) => p.type === 'label',
      help: 'Across the board. 74 mm holds half a business card; 90 mm holds a full one.' },
    { key: 'cardHeight', label: 'Card height', type: 'number', def: 30, min: 10, max: 90, step: 1, unit: 'mm', group: 'Card',
      showIf: (p) => p.type === 'label',
      help: 'How far up the backing goes behind the card.' },
    { key: 'cardTilt', label: 'Card tilt', type: 'number', def: 20, min: 0, max: 45, step: 1, unit: '°', group: 'Card',
      showIf: (p) => p.type === 'label',
      help: 'Lean of the pocket away from the board, so a card is readable from below rather than edge-on.' },

    // ---- shelves, trays, cups, tool plates ---------------------------------
    { key: 'shelfWidth', label: 'Width', type: 'number', def: 120, min: 30, max: 178, step: 1, unit: 'mm', group: 'Body',
      showIf: (p) => ['shelf', 'tray', 'toolplate'].includes(p.type),
      help: 'Across the board. The plate widens to match, so a wide shelf usually wants a second tab column.' },
    { key: 'shelfDepth', label: 'Depth', type: 'number', def: 45, min: 15, max: 120, step: 1, unit: 'mm', group: 'Body',
      showIf: (p) => ['shelf', 'tray', 'toolplate'].includes(p.type),
      help: 'Out from the board. This is the lever arm the tabs have to react.' },
    { key: 'shelfThickness', label: 'Floor thickness', type: 'number', def: 4, min: 2, max: 12, step: 0.5, unit: 'mm', group: 'Body',
      showIf: (p) => ['shelf', 'toolplate'].includes(p.type),
      help: 'Under 3 mm a wide flat shelf visibly sags under anything worth putting on it.' },
    { key: 'lipHeight', label: 'Rim height', type: 'number', def: 6, min: 0, max: 30, step: 0.5, unit: 'mm', group: 'Body',
      showIf: (p) => p.type === 'shelf',
      help: 'A rim around the three open sides. 0 gives a plain shelf.' },
    { key: 'trayHeight', label: 'Tray height', type: 'number', def: 50, min: 10, max: 120, step: 1, unit: 'mm', group: 'Body',
      showIf: (p) => p.type === 'tray',
      help: 'Overall height of the box.' },
    { key: 'wall', label: 'Wall', type: 'number', def: 2.0, min: 1.2, max: 5, step: 0.4, unit: 'mm', group: 'Body',
      showIf: (p) => ['tray', 'cup'].includes(p.type),
      help: 'Snapped to a whole number of 0.4 mm extrusions, because 1.6 mm is four clean perimeters and 1.5 mm is three and a gap the slicer scribbles into.' },
    { key: 'drain', label: 'Drain slots', type: 'bool', def: false, group: 'Body',
      showIf: (p) => p.type === 'tray',
      help: 'Three slots in the floor, so brushes and wet things do not sit in a puddle.' },
    { key: 'cupDia', label: 'Cup diameter', type: 'number', def: 42, min: 15, max: 120, step: 1, unit: 'mm', group: 'Body',
      showIf: (p) => p.type === 'cup', help: 'Outside diameter. The back is flattened where it meets the plate.' },
    { key: 'cupHeight', label: 'Cup height', type: 'number', def: 70, min: 15, max: 150, step: 1, unit: 'mm', group: 'Body',
      showIf: (p) => p.type === 'cup', help: 'Tall enough that a pen does not fall out, short enough to get one out.' },
    { key: 'boreDia', label: 'Bore diameter', type: 'number', def: 8, min: 2, max: 30, step: 0.5, unit: 'mm', group: 'Body',
      showIf: (p) => p.type === 'toolplate',
      help: 'What drops through each hole. Screwdriver handles ~9 mm, hex keys ~6 mm, drill bits ~4 mm, markers ~18 mm.' },
    { key: 'boreCount', label: 'Bores', type: 'int', def: 6, min: 1, max: 16, step: 1, group: 'Body',
      showIf: (p) => p.type === 'toolplate', help: 'How many, filled across the rows in order.' },
    { key: 'boreRows', label: 'Bore rows', type: 'int', def: 1, min: 1, max: 4, step: 1, group: 'Body',
      showIf: (p) => p.type === 'toolplate', help: 'Rows front to back. Two rows of six beats one row of twelve on a narrow board.' },

    // ---- finish ------------------------------------------------------------
    { key: 'fillet', label: 'Fillet', type: 'number', def: 3, min: 0, max: 12, step: 0.5, unit: 'mm', group: 'Finish',
      help: 'Radius on every internal corner. A printed part fails at the sharp corner where the arm meets the plate, and this is the cheapest thing that stops it.' },
  ],

  presets: [
    { name: 'Tool J-hook',
      values: { type: 'jhook', tabCols: 2, tabRows: 1, reach: 30, stock: 7, armWidth: 12,
        rise: 6, returnH: 14, bendR: 8, fillet: 3, mountStyle: 'dropin' } },
    { name: 'Deep parts bin',
      values: { type: 'tray', tabCols: 2, tabRows: 2, shelfWidth: 120, shelfDepth: 60,
        trayHeight: 60, wall: 2.0, drain: false, fillet: 4 } },
    { name: 'Screwdriver rack',
      values: { type: 'toolplate', tabCols: 2, tabRows: 1, shelfWidth: 140, shelfDepth: 40,
        shelfThickness: 5, boreDia: 9, boreCount: 8, boreRows: 1 } },
    { name: 'Pen cup',
      values: { type: 'cup', tabCols: 1, tabRows: 2, cupDia: 42, cupHeight: 70, wall: 2.0 } },
    { name: 'Fit gauge',
      values: { type: 'gauge', tabCols: 1, tabRows: 1, plateThickness: 4, plateMargin: 5 } },
  ],

  build,

  validate(p) {
    const out = [];
    const s = layout(p, { segFactor: 1 });

    // ---- the two inequalities that make the mount work ---------------------
    if (s.prongT + s.legHeight > s.slotH) {
      out.push({ param: 'legHeight', severity: 'error',
        message: `A ${s.prongT} mm prong and an ${s.legHeight} mm leg need ${(s.prongT + s.legHeight).toFixed(1)} mm of slot, and the slot is ${s.slotH} mm. The leg can never be lifted high enough to get it in, let alone back out. Cut the leg to ${Math.max(1, s.slotH - s.prongT).toFixed(1)} mm or thin the prong.` });
    } else if (s.slotH - s.prongT - s.legHeight < 1) {
      out.push({ param: 'legHeight', severity: 'warn',
        message: `Only ${(s.slotH - s.prongT - s.legHeight).toFixed(1)} mm of headroom in the slot. It will fit a board built exactly to the nominal figures and nothing else — print the fit gauge before you commit to this.` });
    }
    if (s.legHeight < 4) {
      out.push({ param: 'legHeight', severity: 'warn',
        message: `A ${s.legHeight} mm leg only reaches ${s.legHeight} mm up the back of the board. That is enough to hang there and not enough to survive being knocked — 7–10 mm is what the parts that work use.` });
    }
    if (s.neckW > s.slotW) {
      out.push({ param: 'fitClearance', severity: 'error',
        message: `The neck comes out ${s.neckW.toFixed(2)} mm wide and the slot is ${s.slotW} mm. It will not go in.` });
    } else if (s.slotW - s.neckW < 0.15) {
      out.push({ param: 'fitClearance', severity: 'warn',
        message: `${(s.slotW - s.neckW).toFixed(2)} mm of clearance is inside the tolerance of the printer, never mind the board. An FDM hole comes out undersize and an FDM peg comes out oversize; 0.3–0.4 mm is the usual answer.` });
    }
    if (s.neckW < NOZZLE * 2) {
      out.push({ param: 'slotWidth', severity: 'error',
        message: `A ${s.neckW.toFixed(2)} mm neck is under two ${NOZZLE} mm extrusions — the slicer will print a single unbonded thread and it will shear off the first time it is loaded.` });
    }

    if (s.snap) {
      const w = s.neckW, gap = clamp(NOZZLE * 2, 0.6, 1.6);
      if (s.tabX.length > 1 && (s.pitch - gap * 2 - 1.2) < w + 1.2) {
        out.push({ param: 'mountStyle', severity: 'error',
          message: `There is no room between tabs ${s.pitch} mm apart to cut a relief around each one, so the snap tabs cannot flex and the part will not go on. Use the drop-in mount, or fewer tab columns.` });
      }
    }

    // ---- one tab is a hinge ------------------------------------------------
    if (CANTILEVERED.includes(s.type) && s.tabX.length * s.tabZ.length < 2) {
      out.push({ param: 'tabCols', severity: 'error',
        message: 'One tab cannot hold a cantilevered load — it is a hinge, and the part will rotate until it is hanging by the corner of the barb. Use two tab columns, or two rows.' });
    }

    // ---- the moment the tabs actually have to react ------------------------
    if (ARMS.includes(s.type)) {
      const lever = s.reach + s.plateT;
      const span = Math.max((s.tabZ.length - 1) * s.pitch, s.plateH * 0.6);
      // A 5 kg hang at `lever` reacted by a couple over `span`.
      const pull = (5 * 9.81 * lever) / Math.max(span, 1);   // newtons on the top tab
      const bearing = s.neckW * s.legHeight * s.tabX.length;  // mm² of leg bearing on the board
      const stress = pull / Math.max(bearing, 0.01);
      if (stress > 12) {
        out.push({ param: 'tabRows', severity: 'warn',
          message: `A 5 kg load at ${lever.toFixed(0)} mm puts about ${(stress).toFixed(0)} MPa across ${bearing.toFixed(0)} mm² of leg. PLA yields somewhere around 40–50 MPa but creeps well below that, so this will slowly deform rather than break. A second tab row, or a shorter reach, is the fix.` });
      }
      if (s.reach > 90 && s.stock < 8) {
        out.push({ param: 'stock', severity: 'warn',
          message: `${s.reach} mm of reach on a ${s.stock} mm section is a springboard. Stiffness goes with the cube of the thickness — 10 mm is barely more plastic and roughly twice the stiffness.` });
      }
    }

    // ---- geometry that does not survive its own numbers --------------------
    if (s.type === 'clip') {
      const wall = snapWall(clamp(s.stock * 0.3, 1.2, 4));
      const strain = (s.cableDia * (1 - s.grip)) / Math.max(s.cableDia / 2 + wall, 0.1);
      if (strain > 0.06) {
        out.push({ param: 'grip', severity: 'warn',
          message: `Getting a ${s.cableDia} mm cable past a ${(s.cableDia * s.grip).toFixed(1)} mm mouth strains the arms by about ${(strain * 100).toFixed(1)}%. PLA cracks somewhere past 4–6%. 0.85 is about as tight as it survives repeatedly.` });
      }
    }
    if (s.type === 'tray' && s.wall * 2 >= s.shelfW) {
      out.push({ param: 'wall', severity: 'error',
        message: `A ${s.wall} mm wall on a ${s.shelfW} mm tray leaves no interior at all — you will get a solid block.` });
    }
    if (s.type === 'cup' && s.cupDia - s.wall * 2 < 6) {
      out.push({ param: 'wall', severity: 'error',
        message: `A ${s.wall} mm wall in a ${s.cupDia} mm cup leaves a ${(s.cupDia - s.wall * 2).toFixed(1)} mm bore. That is a hole, not a cup.` });
    }
    if (s.type === 'toolplate') {
      const rB = s.boreDia / 2;
      const edge = Math.max(2.5, rB * 0.6);
      if (s.shelfW - 2 * (rB + edge) <= 0.4 || s.shelfD - 2 * (rB + edge) <= 0.4) {
        out.push({ param: 'boreDia', severity: 'error',
          message: `A ${s.boreDia} mm bore does not fit a ${s.shelfW} × ${s.shelfD} mm plate with material left around it, so no holes are cut at all. Widen the plate or use a smaller bore.` });
      }
      const cols = Math.max(1, Math.ceil(s.boreCount / s.boreRows));
      const spacing = cols > 1 ? (s.shelfW - 2 * (rB + edge)) / (cols - 1) : Infinity;
      if (spacing < s.boreDia + NOZZLE * 4) {
        out.push({ param: 'boreCount', severity: 'error',
          message: `${s.boreCount} bores of ${s.boreDia} mm across ${s.shelfW} mm leaves under ${(NOZZLE * 4).toFixed(1)} mm between them. Widen the plate, add a row, or use fewer.` });
      }
    }
    if (s.type === 'shelf' && s.shelfD > 60 && s.tabZ.length < 2) {
      out.push({ param: 'tabRows', severity: 'warn',
        message: `A ${s.shelfD} mm shelf on a single row of tabs will nose down. A second row 40 mm below turns the load into a couple the board can actually take.` });
    }

    // ---- printability ------------------------------------------------------
    if (s.plateT < NOZZLE * 4) {
      out.push({ param: 'plateThickness', severity: 'warn',
        message: `${s.plateT} mm is under four extrusions. The plate is the only load path into the tabs; it wants to be solid perimeter.` });
    }
    if (s.margin < 3) {
      out.push({ param: 'plateMargin', severity: 'warn',
        message: `${s.margin} mm of material around the tab is where this will tear out first.` });
    }
    if (s.type === 'gauge' && (p.tabCols !== undefined && s.tabCols !== 1)) {
      out.push({ param: 'tabCols', severity: 'info',
        message: 'The gauge always prints its own five tabs at five clearances; the tab-column setting does not apply to it.' });
    }

    let built = null;
    try { built = build({ ...p }, { segFactor: 1 }); } catch (e) { built = null; }
    if (built && built.meta) {
      for (const n of built.meta.notes) out.push({ severity: 'warn', message: n });
      const size = built.meta.size;
      if (size && (size[0] > BED || size[1] > BED)) {
        out.push({ severity: 'error',
          message: `${size[0].toFixed(0)} × ${size[1].toFixed(0)} mm does not fit the A1 mini's ${BED} × ${BED} mm bed.` });
      }
    }
    return out;
  },

  hints(p) {
    const s = layout(p, { segFactor: 1 });
    const notes = [];
    let layerH = LAYER;

    if (s.prismatic) {
      notes.push('This comes off Bluesheet lying on its side, and that is how it must be sliced. The whole silhouette is the first layer, so there is enormous bed contact and no support anywhere — and, more to the point, the bending tension where the arm meets the plate then runs along the extrusions instead of across the weak bonds between them. Stand it up to print and it will snap at that corner.');
      notes.push('The tab is a prism in this orientation with both end caps chamfered in at 45°, so the faces that would otherwise arrive all at once carry themselves. Nothing here needs support.');
      notes.push(`Set the wall count high — ${Math.max(3, Math.round(s.stock / NOZZLE / 2))} or more. On a part this shape the perimeters are the structure and the infill is packing.`);
    } else {
      notes.push('This comes off Bluesheet the right way up: floor on the bed, back plate rising behind it. The prong\u2019s bridge is a short overhang off the plate with a radiused underside, and the leg then grows straight up off it — the same way the printed bins that already fit this board are made, so it needs no supports.');
      notes.push('The back plate is a tall thin wall standing on its edge. Add a brim if the plate is over about 60 mm tall, or it will get knocked off part way up.');
    }

    if (s.type === 'gauge') {
      layerH = 0.12;
      notes.push('Print the gauge at 0.12 mm. The whole point of it is a ±0.15 mm step between neighbouring tabs, and at 0.2 mm layers the printer\u2019s own variation is the same size as the thing being measured.');
    }

    // There is deliberately no edge-chamfer parameter. On the volume types the
    // bed face is the floor and a chamfer there is easy; on the prismatic types
    // the bed face is the across-the-board silhouette, cut across three
    // separately-extruded components, and doing it properly means a lofted
    // inset of every one of them. A slider that worked on four types out of
    // eleven would be worse than none, so the first layer's elephant foot is
    // left to the slicer's own compensation, which is on by default and does it
    // better than geometry can.

    notes.push(`Lift-to-release is ${s.legHeight} mm: that is exactly how far you raise the part to take it off the board, and it is the number to check against your own board before printing six of them.`);
    if (s.snap) {
      notes.push('Snap mount: the tab is a cantilever tongue and it lives permanently flexed once it is on the board. PLA creeps under sustained strain, so if this is going to hang there for a year, PETG holds its grip far better — or use the drop-in mount, which never flexes at all.');
    } else {
      notes.push('Drop-in mount: nothing in the tab is ever strained when it is hanging, so PLA is genuinely fine here. Insert at the top of the slot and let it fall.');
    }
    if (ARMS.includes(s.type) && s.reach > 60) {
      notes.push(`${s.reach} mm of reach is a long lever. Two tab columns and two rows, and treat the load rating as optimistic.`);
    }
    if (s.type === 'tray' || s.type === 'cup') {
      notes.push(`Wall is ${s.wall} mm — a whole number of ${NOZZLE} mm extrusions, so it prints as clean perimeters with nothing for the slicer to scribble into.`);
    }

    return {
      profile: layerH === LAYER ? '0.20 mm standard' : '0.12 mm fine',
      layerH,
      walls: s.prismatic ? Math.max(3, Math.round(s.stock / NOZZLE / 2)) : Math.max(3, Math.round(s.wall / NOZZLE)),
      infill: s.prismatic ? 40 : 15,
      infillPattern: 'gyroid',
      supports: false,
      brim: !s.prismatic && s.plateH > 60,
      filament: s.snap ? 'PETG (it holds a flexed arm; PLA relaxes)' : 'PLA',
      notes,
    };
  },
};

export { BOARD, GAUGE_STEPS, gaugeTabs, BORE_PRESETS, PRISMATIC, VOLUME, TYPE_IDS, layout, tabProfile, estimateCapacity };
export default gen;
