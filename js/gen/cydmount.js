// js/gen/cydmount.js — mounts for a "Cheap Yellow Display".
//
// The CYD (an ESP32-2432S028R and its many near-relatives) is a 2.8" ILI9341
// panel soldered to a yellow ESP32 board, and the reason it needs its own
// generator rather than a row in the enclosure's board list is that nobody
// wants to put one in a box. They want it ON something: propped on a desk,
// screwed to a wall, hung off a monitor arm, or let into a panel.
//
// ONE NUMBER YOU MUST CHECK. The active area — 43.2 × 57.6 mm — is arithmetic:
// 240 × 320 pixels at the ILI9341's 0.18 mm pitch, and it is the same on every
// one of these panels. The BOARD outline and the mounting-hole positions are
// not. This family is cloned by a dozen sellers and the holes move between
// revisions, so the defaults here are a starting point to be checked with
// calipers, not a specification. validate() says so, in those words, until the
// user changes them.
//
// Construction. Everything is islands extruded from the face of one flat plate
// — the pattern qrplaque established — so the cradle needs no CSG at all and
// cannot come apart under the parameter sweep. The stand's foot is the one
// exception and it is still 2D: the angled slot is a boolean cut in the side
// PROFILE before the profile is extruded across the width, which is both
// simpler and more robust than rotating a box and subtracting it in 3D.
import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { extrude } from '../kernel/builders.js';
import { clamp, num, segScale } from '../kernel/scalar.js';
import { FIT, fitNote } from '../kernel/fit.js';

const DEG = Math.PI / 180;

// The panel's active area is fixed by the controller, not by the seller:
// 240 × 320 at the ILI9341's 0.18 mm pixel pitch. The long axis lies along the
// long axis of the board.
const ACTIVE_LONG = 57.6;
const ACTIVE_SHORT = 43.2;

const VESA = { v75: 75, v100: 100 };

// ---------------------------------------------------------------------------

function plan(p, ctx = {}) {
  const sf = segScale(ctx);
  const seg = Math.max(6, Math.round(16 * sf));
  const segC = Math.max(10, Math.round(28 * sf));

  const boardL = clamp(num(p.boardL, 86), 30, 180);
  const boardW = clamp(num(p.boardW, 50), 20, 180);
  const boardT = clamp(num(p.boardT, 1.6), 0.6, 5);
  const backD = clamp(num(p.backD, 12), 1, 60);

  // Active area, clamped so it can never be larger than the board it sits on.
  const screenL = clamp(num(p.screenL, ACTIVE_LONG), 5, boardL - 2);
  const screenW = clamp(num(p.screenW, ACTIVE_SHORT), 5, boardW - 2);
  const screenOffL = clamp(num(p.screenOffL, 0), -(boardL - screenL) / 2, (boardL - screenL) / 2);
  const screenOffW = clamp(num(p.screenOffW, 0), -(boardW - screenW) / 2, (boardW - screenW) / 2);

  const clear = clamp(num(p.clear, 0.4), 0.05, 3);
  const bezelT = clamp(num(p.bezelT, 2.4), 1, 8);
  // The lip cannot eat more than a third of the panel or there is no screen
  // left to look at.
  const lip = clamp(num(p.lip, 1.5), 0, Math.min(screenL, screenW) / 3);
  const rimT = clamp(num(p.rimT, 2), 0.8, 6);
  const flange = clamp(num(p.flange, 3), 1, 20);

  const holeInsetL = clamp(num(p.holeInsetL, 3.5), 1.5, boardL / 2 - 2);
  const holeInsetW = clamp(num(p.holeInsetW, 3.5), 1.5, boardW / 2 - 2);
  const bossOD = clamp(num(p.bossOD, 5), 2.5, 12);
  const pilot = clamp(num(p.pilot, 2.1), 1, Math.max(1, bossOD - 1.2));
  const standoffH = clamp(num(p.standoffH, 1.2), 0, 12);

  const mount = ['stand', 'wall', 'vesa', 'panel'].includes(p.mount) ? p.mount : 'stand';
  const angle = clamp(num(p.angle, 55), 15, 85);      // from horizontal
  const fit = clamp(num(p.fit, FIT.slide), 0.05, 0.8);

  // Pocket the board drops into, and the window cut through the bezel.
  const pocketL = boardL + 2 * clear;
  const pocketW = boardW + 2 * clear;
  const winL = Math.max(2, screenL - 2 * lip);
  const winW = Math.max(2, screenW - 2 * lip);

  // Plate. Wall mounts grow a strip top and bottom to carry the keyholes;
  // VESA grows until the bolt circle fits with a margin around it.
  let plateL = pocketL + 2 * (rimT + flange);
  let plateW = pocketW + 2 * (rimT + flange);
  const strip = mount === 'wall' ? clamp(num(p.strip, 18), 6, 40) : 0;
  if (mount === 'wall') plateW += 2 * strip;
  const vesaSize = VESA[p.vesa] || 75;
  if (mount === 'vesa') {
    const need = vesaSize + 2 * 7;
    plateL = Math.max(plateL, need);
    plateW = Math.max(plateW, need);
  }
  const corner = clamp(num(p.corner, 3), 0, Math.min(plateL, plateW) / 2 - 0.01);

  // Screw bosses, pulled inside the pocket so a boss can never straddle the rim.
  const bl = Math.max(0, pocketL / 2 - bossOD / 2 - 0.2);
  const bw = Math.max(0, pocketW / 2 - bossOD / 2 - 0.2);
  const bosses = [];
  if (bl > 0 && bw > 0 && standoffH > 0) {
    const hx = clamp(boardL / 2 - holeInsetL, -bl, bl);
    const hy = clamp(boardW / 2 - holeInsetW, -bw, bw);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = sx * hx, y = sy * hy;
      if (bosses.some(o => Math.hypot(o[0] - x, o[1] - y) < bossOD * 0.9)) continue;
      // A boss that would sit inside the window would be a post across the screen.
      const inWindow = Math.abs(x - screenOffL) < winL / 2 + bossOD / 2 && Math.abs(y - screenOffW) < winW / 2 + bossOD / 2;
      if (inWindow) continue;
      bosses.push([x, y]);
    }
  }

  // Keyholes. BOTH point head-up, slot-down, because that is the only way two
  // of them hang on two screws — which means the lower one needs its whole
  // slot INSIDE the strip below it, not just its head. Sizing the strip to the
  // head alone let the bottom slot run out through the plate's own edge: the
  // hole stopped being a hole, and the cap triangulated open. Fit the keyhole
  // to the strip, then place it by its full extent rather than by its centre.
  const KEY_MARGIN = 1.2;
  let keyD = clamp(num(p.keyD, 8), 4, 16);
  const keyExtent = (d) => d / 2 + Math.max(d * 1.1, Math.sqrt(Math.max(1e-6, d * d / 4 - (d * 0.25) ** 2)) + d * 0.5 + 1);
  const keys = [];
  if (mount === 'wall') {
    // Shrink the keyhole until it fits the strip it has to live in.
    while (keyD > 4 && keyExtent(keyD) + 2 * KEY_MARGIN > strip) keyD -= 0.5;
  }
  const keySlot = clamp(keyD * 0.5, 2, keyD - 1.5);
  const keyFits = mount === 'wall' && keyExtent(keyD) + 2 * KEY_MARGIN <= strip;
  if (keyFits) {
    const R = keyD / 2, H = keyExtent(keyD), drop = H - R;
    for (const sy of [-1, 1]) {
      const mid = sy * (plateW / 2 - strip / 2);
      keys.push([0, mid + (drop - R) / 2]);
    }
  }

  // VESA bolt pattern, kept off the window.
  const vesaHoles = [];
  if (mount === 'vesa') {
    const h = vesaSize / 2;
    if (h + 4 < plateL / 2 && h + 4 < plateW / 2) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) vesaHoles.push([sx * h, sy * h]);
    }
  }

  // Panel screws: one per corner of the plate, inside the flange.
  const panelHoles = [];
  if (mount === 'panel') {
    const px = plateL / 2 - Math.max(3, flange / 2 + 1);
    const py = plateW / 2 - Math.max(3, flange / 2 + 1);
    if (px > pocketL / 2 + 1 && py > pocketW / 2 + 1) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) panelHoles.push([sx * px, sy * py]);
    }
  }

  // The stand's tongue and the foot it slides into.
  const tongueW = clamp(num(p.tongueW, 30), 8, Math.max(8, plateL * 0.7));
  const tongueL = clamp(num(p.tongueL, 14), 4, 40);
  const footD = clamp(num(p.footD, 52), 18, 140);
  const footW = clamp(num(p.footW, 34), 12, 140);
  const footH = clamp(num(p.footH, 24), 8, 90);
  const part = ['both', 'cradle', 'foot'].includes(p.part) ? p.part : 'both';

  const rimH = standoffH + boardT + clamp(num(p.shroud, 1.5), 0, 20);

  return {
    sf, seg, segC, boardL, boardW, boardT, backD, screenL, screenW, screenOffL, screenOffW,
    clear, bezelT, lip, rimT, flange, holeInsetL, holeInsetW, bossOD, pilot, standoffH,
    mount, angle, fit, pocketL, pocketW, winL, winW, plateL, plateW, corner, strip,
    bosses, keys, keyD, keySlot, vesaHoles, vesaSize, panelHoles,
    tongueW, tongueL, footD, footW, footH, part, rimH,
    custom: !!(p.boardL !== 86 || p.boardW !== 50 || p.holeInsetL !== 3.5 || p.holeInsetW !== 3.5),
  };
}

// ---------------------------------------------------------------------------

/**
 * A keyhole: a round head with a narrower slot running down from it, built as
 * ONE ring by walking the outline rather than by unioning a circle with a
 * rectangle.
 *
 * The boolean route looks obviously right and is a trap twice over. Capping
 * the slot with a radius of half its width makes that cap exactly internally
 * tangent to the head — centres d/4 apart, radii d/2 and d/4 — so the outlines
 * touch at a single point and the union pinches there. Squaring the slot off
 * fixes the tangency, and the union is then clean and simple and still comes
 * out of extrude() with eight boundary edges, because the cap triangulator
 * quietly drops four triangles around the neck it produces. The ring was never
 * the problem; feeding a hand-walked outline avoids ever asking the question.
 */
function keyholeRing(cx, cy, d, slotW, segs) {
  const R = d / 2;
  const w = clamp(slotW / 2, 0.4, R * 0.8);          // half the slot width
  const j = Math.sqrt(Math.max(1e-6, R * R - w * w)); // junction, below centre
  // The straight flanks must have positive length, whatever was asked for.
  const drop = Math.max(d * 1.1, j + 2 * w + 1);
  const yJ = cy - j;
  const yB = cy - drop;
  const cap = yB + w;
  const n = Math.max(6, Math.round(segs));

  const pts = [];
  const tJ = Math.atan2(-j, w);                       // negative: right junction
  const sweep = (Math.PI - tJ) - tJ;                  // CCW around the head
  for (let i = 0; i <= n; i++) {
    const a = tJ + sweep * (i / n);
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  pts.push([cx - w, cap]);                            // down the left flank
  const m = Math.max(4, Math.round(n / 2));
  for (let i = 0; i <= m; i++) {                      // left -> bottom -> right
    const a = Math.PI + Math.PI * (i / m);
    pts.push([cx + w * Math.cos(a), cap + w * Math.sin(a)]);
  }
  pts.push([cx + w, yJ]);                             // up the right flank
  return P.ensureCW(pts);                             // a hole
}

function buildCradle(L) {
  const holes = [];
  holes.push(P.ensureCW(P.roundRect(L.winL, L.winW, Math.min(L.winL, L.winW) * 0.06,
    { segs: L.seg, cx: L.screenOffL, cy: L.screenOffW })));
  for (const [x, y] of L.keys) holes.push(keyholeRing(x, y, L.keyD, L.keySlot, L.segC));
  for (const [x, y] of L.vesaHoles) holes.push(P.ensureCW(P.circle(2.6, { segs: L.segC, cx: x, cy: y })));
  for (const [x, y] of L.panelHoles) holes.push(P.ensureCW(P.circle(2.2, { segs: L.segC, cx: x, cy: y })));

  // The plate outline, with the stand's tongue grown onto its bottom edge as
  // part of the same outline rather than glued on as a second solid.
  let outline = P.roundRect(L.plateL, L.plateW, L.corner, { segs: L.seg });
  if (L.mount === 'stand' && L.tongueL > 0.5) {
    const t = P.rect(L.tongueW, L.tongueL * 2, { cx: 0, cy: -L.plateW / 2 });
    const merged = P.boolean([[outline]], [[t]], 'union');
    if (merged.length === 1 && merged[0].length >= 1) outline = merged[0][0];
  }

  let m = extrude([[outline, ...holes]], L.bezelT, { check: false });

  // Rim and bosses: islands standing on the plate's back face, strictly inside
  // its outline, so neither shares a ring with it.
  const parts = [m];
  if (L.rimT > 0 && L.rimH > 0.05) {
    const ro = P.roundRect(L.pocketL + 2 * L.rimT, L.pocketW + 2 * L.rimT, Math.max(0, L.corner - L.flange), { segs: L.seg });
    const ri = P.ensureCW(P.roundRect(L.pocketL, L.pocketW, Math.max(0, L.corner - L.flange - L.rimT), { segs: L.seg }));
    parts.push(extrude([[ro, ri]], L.rimH, { z0: L.bezelT, check: false }));
  }
  for (const [x, y] of L.bosses) {
    const rings = [P.circle(L.bossOD / 2, { segs: L.segC, cx: x, cy: y })];
    if (L.pilot > 0.05 && L.pilot < L.bossOD - 0.4) rings.push(P.ensureCW(P.circle(L.pilot / 2, { segs: L.segC, cx: x, cy: y })));
    parts.push(extrude([rings], L.standoffH, { z0: L.bezelT, check: false }));
  }
  return Mesh.merge(parts).healTJunctions();
}

/**
 * The foot: a triangular side profile with the cradle's slot cut into it in
 * 2D, extruded across the width and then turned upright by a cyclic axis
 * permutation (which is a rotation, so winding survives it).
 */
function buildFoot(L) {
  const d = L.footD, h = L.footH;
  const tri = [[0, 0], [d, 0], [0, h]];

  // The slot: a rectangle standing at `angle` from horizontal, its mouth at
  // the sloping face, sunk `tongueL` deep. Placed a third of the way back so
  // it never runs out of either end of the triangle.
  const slotT = L.bezelT + L.fit;
  const depth = Math.min(L.tongueL + 1, Math.hypot(d, h) * 0.55);
  const a = L.angle * DEG;
  const mouthX = d * 0.42, mouthY = h * (1 - 0.42);
  const ux = Math.cos(a), uy = Math.sin(a);          // up the slot
  const px = -uy, py = ux;                            // across it
  const rect = [
    [mouthX + px * slotT / 2 + ux * 2, mouthY + py * slotT / 2 + uy * 2],
    [mouthX - px * slotT / 2 + ux * 2, mouthY - py * slotT / 2 + uy * 2],
    [mouthX - px * slotT / 2 - ux * depth, mouthY - py * slotT / 2 - uy * depth],
    [mouthX + px * slotT / 2 - ux * depth, mouthY + py * slotT / 2 - uy * depth],
  ];
  let shape = [[P.ensureCCW(tri)]];
  const cut = P.boolean(shape, [[P.ensureCCW(rect)]], 'difference');
  if (cut.length) shape = cut;

  const prism = extrude(shape, L.footW, { check: false });
  // (x, y, z) -> (z, x, y): profile depth becomes Y, profile height becomes Z,
  // and the extrusion becomes the width in X.
  return prism.mapVerts((x, y, z) => [z, x, y]).place().healTJunctions();
}

function arrange(meshes) {
  const centred = meshes.map(m => ({ name: m.name, mesh: m.mesh.centerXY().dropToPlate() }));
  if (centred.length === 1) {
    const m = centred[0].mesh.place();
    return { mesh: m, parts: [{ name: centred[0].name, mesh: m }] };
  }
  const b = centred[0].mesh.bbox();
  const alongX = b.size[0] <= b.size[1];
  const gap = 4;
  let run = 0;
  const placed = [];
  for (const c of centred) {
    const s = c.mesh.bbox().size;
    const step = alongX ? s[0] : s[1];
    placed.push({ name: c.name, mesh: c.mesh, at: run + step / 2 });
    run += step + gap;
  }
  const total = run - gap;
  const parts = placed.map(q => ({
    name: q.name,
    mesh: alongX ? q.mesh.translate(q.at - total / 2, 0, 0) : q.mesh.translate(0, q.at - total / 2, 0),
  }));
  const merged = Mesh.merge(parts.map(q => q.mesh));
  const bb = merged.bbox();
  const off = [-bb.center[0], -bb.center[1], -bb.min[2]];
  return {
    mesh: merged.translate(off[0], off[1], off[2]),
    parts: parts.map(q => ({ name: q.name, mesh: q.mesh.translate(off[0], off[1], off[2]) })),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

function build(p, ctx = {}) {
  const L = plan(p, ctx);

  const wanted = [];
  if (L.part !== 'foot') wanted.push({ name: 'cradle', mesh: buildCradle(L) });
  if (L.mount === 'stand' && L.part !== 'cradle') wanted.push({ name: 'foot', mesh: buildFoot(L) });
  if (!wanted.length) wanted.push({ name: 'cradle', mesh: buildCradle(L) });
  const laid = arrange(wanted);

  const host = laid.parts.find(q => q.name === 'cradle') || laid.parts[0];
  const src = wanted.find(q => q.name === host.name);
  const hb = src.mesh.bbox(), pb = host.mesh.bbox();
  const T = [pb.center[0] - hb.center[0], pb.center[1] - hb.center[1], pb.min[2] - hb.min[2]];
  const at = (x, y, z) => [x + T[0], y + T[1], z + T[2]];

  const dims = [];
  if (host.name === 'cradle') {
    dims.push({ param: 'bezelT', from: at(L.plateL / 2, 0, 0), to: at(L.plateL / 2, 0, L.bezelT), offset: [1, 0, 0] });
    dims.push({ label: 'window', value: `${r2(L.winL)} × ${r2(L.winW)}`,
      from: at(L.screenOffL - L.winL / 2, L.screenOffW, L.bezelT), to: at(L.screenOffL + L.winL / 2, L.screenOffW, L.bezelT), offset: [0, 0, 1] });
    dims.push({ param: 'boardL', value: L.boardL, from: at(-L.boardL / 2, -L.pocketW / 2, L.bezelT), to: at(L.boardL / 2, -L.pocketW / 2, L.bezelT), offset: [0, -1, 0] });
    dims.push({ param: 'rimT', from: at(L.pocketL / 2, 0, L.bezelT + L.rimH), to: at(L.pocketL / 2 + L.rimT, 0, L.bezelT + L.rimH), offset: [0, 0, 1] });
    if (L.bosses.length) {
      const [bx, by] = L.bosses[0];
      dims.push({ param: 'standoffH', value: L.standoffH, from: at(bx, by, L.bezelT), to: at(bx, by, L.bezelT + L.standoffH), offset: [0, -1, 0] });
    }
    if (L.mount === 'wall' && L.keys.length) {
      dims.push({ param: 'keyD', label: 'Ø', value: L.keyD, from: at(-L.keyD / 2, L.keys[0][1], L.bezelT), to: at(L.keyD / 2, L.keys[0][1], L.bezelT), offset: [0, 1, 0] });
    }
  }
  const footPart = laid.parts.find(q => q.name === 'foot');
  if (footPart) {
    const fs = wanted.find(q => q.name === 'foot');
    const fb = fs.mesh.bbox(), fp = footPart.mesh.bbox();
    dims.push({ param: 'footD', value: r2(fb.size[1]),
      from: [fp.center[0], fp.min[1], fp.min[2]], to: [fp.center[0], fp.max[1], fp.min[2]], offset: [0, 0, -1] });
  }

  const analysis = [];
  analysis.push(`Panel window ${r2(L.winL)} × ${r2(L.winW)} mm — the ${r2(L.screenL)} × ${r2(L.screenW)} mm active area with a ${L.lip} mm lip overlapping it on every side.`);
  if (L.bosses.length === 4) {
    analysis.push(`Four ${L.bossOD} mm bosses on a ${r2(L.boardL - 2 * L.holeInsetL)} × ${r2(L.boardW - 2 * L.holeInsetW)} mm pattern, ${L.pilot} mm pilots.`);
  } else {
    analysis.push(`Only ${L.bosses.length} of the four bosses could be placed — the rest fall inside the window or outside the pocket. Check the hole insets against the board.`);
  }
  if (L.mount === 'stand') {
    analysis.push(`Stand: the cradle sits at ${L.angle}° from horizontal in a ${r2(L.bezelT + L.fit)} mm slot. Two parts, both flat on the plate.`);
  } else if (L.mount === 'wall') {
    analysis.push(`Wall: two ${L.keyD} mm keyholes ${r2(L.plateW - L.strip)} mm apart, centre to centre. Drive the screws, leave ${r2(L.keyD * 0.4)} mm of head proud, hang it on.`);
  } else if (L.mount === 'vesa') {
    analysis.push(`VESA ${L.vesaSize} × ${L.vesaSize} mm on a ${r2(L.plateL)} × ${r2(L.plateW)} mm plate, M4 clearance.`);
  } else {
    analysis.push(`Panel: cut an aperture ${r2(L.pocketL + 2 * L.rimT + 0.4)} × ${r2(L.pocketW + 2 * L.rimT + 0.4)} mm; the flange covers it and takes four M4 screws.`);
  }

  return {
    mesh: laid.mesh,
    parts: laid.parts,
    meta: {
      dims, analysis,
      mount: L.mount,
      vesaPitch: L.mount === 'vesa' ? L.vesaSize : null,
      plate: [r2(L.plateL), r2(L.plateW)],
      window: [r2(L.winL), r2(L.winW)],
      pocket: [r2(L.pocketL), r2(L.pocketW)],
      panelAperture: [r2(L.pocketL + 2 * L.rimT + 0.4), r2(L.pocketW + 2 * L.rimT + 0.4)],
      bosses: L.bosses.length,
      holePattern: [r2(L.boardL - 2 * L.holeInsetL), r2(L.boardW - 2 * L.holeInsetW)],
      dimensionsVerified: false,
    },
  };
}

function validate(p) {
  const issues = [];
  const L = plan(p, {});

  // The honest one. It fires on the defaults deliberately.
  if (!L.custom) {
    issues.push({ param: 'boardL', severity: 'warn',
      message: 'The board outline and hole insets here are a STARTING POINT, not a specification — CYD clones vary between sellers and revisions. ' +
               'Measure your board with calipers and set them before you print. The 43.2 × 57.6 mm active area is fixed by the controller and does not need checking.' });
  }
  if (L.bosses.length < 4) {
    issues.push({ param: 'holeInsetL', severity: 'warn',
      message: `Only ${L.bosses.length} of four mounting bosses fit — the others land inside the screen window or outside the board pocket. Check the hole insets.` });
  }
  if (L.lip <= 0.2) {
    issues.push({ param: 'lip', severity: 'warn',
      message: 'With no lip the window is the full active area, so the panel has nothing to sit against and will fall forward out of the bezel.' });
  }
  if (L.lip > 3.5) {
    issues.push({ param: 'lip', severity: 'warn',
      message: `A ${L.lip} mm lip covers ${r2(2 * L.lip / L.screenW * 100)}% of the short axis of the screen. Touch targets near the edge get hard to reach.` });
  }
  if (L.mount === 'wall' && L.keys.length < 2) {
    issues.push({ param: 'strip', severity: 'warn', message: 'The mounting strip is too narrow for the keyhole — widen it or use a smaller keyhole.' });
  }
  if (L.mount === 'vesa' && L.vesaHoles.length < 4) {
    issues.push({ param: 'vesa', severity: 'error', message: `The plate is too small for a ${L.vesaSize} mm VESA pattern. Use 75 mm, or widen the flange.` });
  }
  if (L.standoffH > 0 && L.standoffH < 0.6) {
    issues.push({ param: 'standoffH', severity: 'warn', message: 'A standoff under 0.6 mm is thinner than three layers and will not survive a screw.' });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const L = plan(p, ctx);
  const notes = [];
  notes.push('Print the cradle bezel-face DOWN. The window, the rim and the bosses all grow upward from that face, so nothing overhangs and the visible front comes off the smooth plate.');
  if (L.mount === 'stand') {
    notes.push(`The foot prints on its side — the triangular profile is the shape you see from the plate — so the slot needs no support either. Slide the cradle's tongue in; ${fitNote('slide')}`);
  }
  if (L.mount === 'wall') {
    notes.push('Keyholes want the round end UP so the screw head drops in and the display hangs down onto the slot. That is how they are drawn.');
  }
  notes.push(`Screws into the ${L.pilot} mm pilots are self-tapping — M2.5 × 6 is about right. Do not force them; the boss is only ${r2((L.bossOD - L.pilot) / 2)} mm of wall.`);
  notes.push('Three walls and 20% infill. A bezel is seen, so if the first layer matters use a smooth plate and slow the first layer down.');
  return { profile: { layerH, infill: 20, walls: 3 }, supports: false, filament: 'PLA', notes };
}

// ---------------------------------------------------------------------------

export default {
  id: 'cydmount',
  name: 'CYD Display Mount',
  category: 'Utility',
  blurb: 'Desk stand, wall plate, VESA arm or panel bezel for a 2.8" Cheap Yellow Display.',
  description:
    'Four ways to mount an ESP32 "Cheap Yellow Display" and its clones: a two-part desk stand that props it at an angle, a wall ' +
    'plate with keyholes, a VESA 75 or 100 plate for a monitor arm, and a panel bezel with the aperture size worked out for you. ' +
    'The cradle is the same in all four — a bezel with a window cut for the panel, a rim the board drops into and four screw ' +
    'bosses — so the only thing that changes is what is behind it. The 43.2 × 57.6 mm active area is fixed by the ILI9341 and is ' +
    'right by construction; the board outline and hole positions vary between sellers, so measure yours and type them in. Every ' +
    'part prints flat with no supports.',
  version: 1,
  params: [
    { key: 'mount', label: 'Mounting', type: 'enum', def: 'stand', group: 'Mounting',
      options: [
        { v: 'stand', label: 'Desk stand', help: 'Two parts: a cradle with a tongue and a wedge foot it slots into.' },
        { v: 'wall', label: 'Wall plate', help: 'Keyholes top and bottom; hangs on two screws.' },
        { v: 'vesa', label: 'VESA plate', help: 'For a monitor arm or a TV bracket.' },
        { v: 'panel', label: 'Panel bezel', help: 'Let into a cut-out; the flange covers the edges.' },
      ],
      help: 'What goes behind the display. The cradle itself does not change.' },
    { key: 'angle', label: 'Stand angle', type: 'number', def: 55, min: 15, max: 85, step: 1, unit: '°', group: 'Mounting',
      showIf: (p) => p.mount === 'stand', help: 'From horizontal. 55° reads well on a desk; 75° is nearly upright for a shelf.' },
    { key: 'vesa', label: 'VESA pattern', type: 'enum', def: 'v75', group: 'Mounting',
      options: [{ v: 'v75', label: '75 × 75 mm' }, { v: 'v100', label: '100 × 100 mm' }],
      showIf: (p) => p.mount === 'vesa', help: 'The plate grows to whichever you pick.' },
    { key: 'strip', label: 'Keyhole strip', type: 'number', def: 18, min: 6, max: 40, step: 1, unit: 'mm', group: 'Mounting',
      showIf: (p) => p.mount === 'wall', help: 'Extra plate above and below the display to put the keyholes in.' },
    { key: 'keyD', label: 'Keyhole diameter', type: 'number', def: 8, min: 4, max: 16, step: 0.5, unit: 'mm', group: 'Mounting',
      showIf: (p) => p.mount === 'wall', help: 'The round part, which must clear the screw HEAD. The slot below is half of it.' },

    { key: 'boardL', label: 'Board length', type: 'number', def: 86, min: 30, max: 180, step: 0.1, unit: 'mm', group: 'Display',
      help: 'MEASURE THIS. The long side of the PCB. 86 mm is typical of an ESP32-2432S028R but clones differ.' },
    { key: 'boardW', label: 'Board width', type: 'number', def: 50, min: 20, max: 180, step: 0.1, unit: 'mm', group: 'Display',
      help: 'MEASURE THIS. The short side of the PCB.' },
    { key: 'boardT', label: 'Board thickness', type: 'number', def: 1.6, min: 0.6, max: 5, step: 0.1, unit: 'mm', group: 'Display',
      help: 'The PCB alone — 1.6 mm is standard FR-4. The panel glued to the front is accounted for by the lip.' },
    { key: 'backD', label: 'Depth behind', type: 'number', def: 12, min: 1, max: 60, step: 0.5, unit: 'mm', group: 'Display',
      help: 'How far the tallest thing on the back stands off the PCB — the ESP32 module and the pin headers. Reported, not enclosed.' },
    { key: 'screenL', label: 'Active area, long', type: 'number', def: ACTIVE_LONG, min: 5, max: 180, step: 0.1, unit: 'mm', group: 'Display',
      help: '57.6 mm: 320 pixels at the ILI9341\'s 0.18 mm pitch. Fixed by the controller — you should not need to change this.' },
    { key: 'screenW', label: 'Active area, short', type: 'number', def: ACTIVE_SHORT, min: 5, max: 180, step: 0.1, unit: 'mm', group: 'Display',
      help: '43.2 mm: 240 pixels at 0.18 mm.' },
    { key: 'screenOffL', label: 'Screen offset, long', type: 'number', def: 0, min: -40, max: 40, step: 0.1, unit: 'mm', group: 'Display',
      help: 'MEASURE THIS if the panel is not centred on the board — most are offset toward the USB end.' },
    { key: 'screenOffW', label: 'Screen offset, short', type: 'number', def: 0, min: -40, max: 40, step: 0.1, unit: 'mm', group: 'Display',
      help: 'The same across the short axis.' },
    { key: 'holeInsetL', label: 'Hole inset, long', type: 'number', def: 3.5, min: 1.5, max: 40, step: 0.1, unit: 'mm', group: 'Display',
      help: 'MEASURE THIS. Centre of a corner mounting hole in from the short edge.' },
    { key: 'holeInsetW', label: 'Hole inset, short', type: 'number', def: 3.5, min: 1.5, max: 40, step: 0.1, unit: 'mm', group: 'Display',
      help: 'MEASURE THIS. And in from the long edge.' },

    { key: 'lip', label: 'Bezel lip', type: 'number', def: 1.5, min: 0, max: 8, step: 0.1, unit: 'mm', group: 'Bezel',
      help: 'How far the bezel overlaps the active area on each side. This is what holds the panel in — zero and it falls out of the front.' },
    { key: 'bezelT', label: 'Bezel thickness', type: 'number', def: 2.4, min: 1, max: 8, step: 0.2, unit: 'mm', group: 'Bezel',
      help: 'The face plate. Thicker looks better and recesses the screen further.' },
    { key: 'clear', label: 'Board clearance', type: 'number', def: 0.4, min: 0.05, max: 3, step: 0.05, unit: 'mm', group: 'Bezel',
      help: 'Air around the board inside the rim, per side.' },
    { key: 'rimT', label: 'Rim thickness', type: 'number', def: 2, min: 0.8, max: 6, step: 0.2, unit: 'mm', group: 'Bezel',
      help: 'The wall standing up around the board pocket.' },
    { key: 'shroud', label: 'Rim height over board', type: 'number', def: 1.5, min: 0, max: 20, step: 0.5, unit: 'mm', group: 'Bezel',
      help: 'How far the rim stands proud of the back of the PCB. Enough to locate it, not so much that the headers foul.' },
    { key: 'flange', label: 'Flange', type: 'number', def: 3, min: 1, max: 20, step: 0.5, unit: 'mm', group: 'Bezel',
      help: 'Plate that shows outside the rim. On a panel mount this is what covers the cut edge.' },
    { key: 'corner', label: 'Corner radius', type: 'number', def: 3, min: 0, max: 20, step: 0.5, unit: 'mm', group: 'Bezel' },

    { key: 'bossOD', label: 'Boss diameter', type: 'number', def: 5, min: 2.5, max: 12, step: 0.5, unit: 'mm', group: 'Fixings',
      help: 'Outside of each screw boss.' },
    { key: 'pilot', label: 'Pilot hole', type: 'number', def: 2.1, min: 1, max: 6, step: 0.1, unit: 'mm', group: 'Fixings',
      help: '2.1 mm takes a self-tapping M2.5 straight into the plastic.' },
    { key: 'standoffH', label: 'Standoff height', type: 'number', def: 1.2, min: 0, max: 12, step: 0.2, unit: 'mm', group: 'Fixings',
      help: 'How far the board is held off the bezel. Small — the panel wants to sit against the lip.' },
    { key: 'fit', label: 'Slot clearance', type: 'number', def: FIT.slide, min: 0.05, max: 0.8, step: 0.05, unit: 'mm', group: 'Fixings',
      showIf: (p) => p.mount === 'stand', help: `Gap between the cradle's tongue and the foot's slot. ${fitNote('slide')}` },

    { key: 'tongueW', label: 'Tongue width', type: 'number', def: 30, min: 8, max: 120, step: 1, unit: 'mm', group: 'Stand',
      showIf: (p) => p.mount === 'stand', help: 'How wide the spigot under the cradle is.' },
    { key: 'tongueL', label: 'Tongue length', type: 'number', def: 14, min: 4, max: 40, step: 0.5, unit: 'mm', group: 'Stand',
      showIf: (p) => p.mount === 'stand', help: 'How far it goes into the foot. Longer is steadier.' },
    { key: 'footD', label: 'Foot depth', type: 'number', def: 52, min: 18, max: 140, step: 1, unit: 'mm', group: 'Stand',
      showIf: (p) => p.mount === 'stand', help: 'Front to back. This is what stops it tipping backwards.' },
    { key: 'footW', label: 'Foot width', type: 'number', def: 34, min: 12, max: 140, step: 1, unit: 'mm', group: 'Stand',
      showIf: (p) => p.mount === 'stand' },
    { key: 'footH', label: 'Foot height', type: 'number', def: 24, min: 8, max: 90, step: 1, unit: 'mm', group: 'Stand',
      showIf: (p) => p.mount === 'stand' },

    { key: 'part', label: 'Show', type: 'enum', def: 'both', group: 'Output',
      options: [{ v: 'both', label: 'All parts' }, { v: 'cradle', label: 'Cradle only' }, { v: 'foot', label: 'Foot only' }],
      help: 'Laid out flat side by side, ready to slice as one plate.' },
  ],
  presets: [
    { name: 'Desk stand, 55°', values: {
      mount: 'stand', angle: 55, lip: 1.5, bezelT: 2.4, flange: 3, corner: 3,
      standoffH: 1.2, bossOD: 5, pilot: 2.1, tongueW: 30, tongueL: 14, footD: 52, footW: 34, footH: 24, part: 'both' } },
    { name: 'Wall plate, keyholes', values: {
      mount: 'wall', strip: 18, keyD: 8, lip: 1.5, bezelT: 2.4, flange: 3, corner: 4,
      standoffH: 1.2, bossOD: 5, pilot: 2.1, part: 'both' } },
    { name: 'VESA 75 arm plate', values: {
      mount: 'vesa', vesa: 'v75', lip: 1.5, bezelT: 3, flange: 4, corner: 4,
      standoffH: 1.2, bossOD: 5.5, pilot: 2.1, part: 'both' } },
    { name: 'Panel bezel', values: {
      mount: 'panel', lip: 2, bezelT: 3, flange: 8, corner: 2, rimT: 2.4,
      shroud: 3, standoffH: 1.2, bossOD: 5, pilot: 2.1, part: 'both' } },
  ],
  build,
  validate,
  hints,
};
