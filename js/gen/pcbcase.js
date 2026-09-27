// js/gen/pcbcase.js — an enclosure for a circuit board.
//
// The two numbers that decide whether a PCB case is usable are never the ones
// people tune first. They are the clearance between a standoff and the wall —
// too little and the screw boss fouls the board's edge components — and whether
// the lid actually clears the tallest thing soldered to the board. Both are
// stated outright in meta.analysis rather than left for the user to discover
// after forty minutes of printing, which is the whole reason this generator
// carries a "tallest component" parameter that contributes no geometry.
//
// Construction. The shell is CSG: a solid block minus a cavity that breaks
// through the top face, so the box is one real solid rather than a floor and a
// wall ring sharing a coincident edge loop. Standoffs and screw posts are
// tubes EMBEDDED a fraction into the floor rather than resting exactly on it —
// BSP union copes far better with a genuine overlap than with two faces at the
// same z, and the embedded depth doubles as thread engagement for a
// self-tapper. Port cutouts are boxes subtracted through the walls; they have
// to be 3D because a port is a hole at a height, not a hole through everything.
//
// The lid needs no CSG at all: its features are 2D holes in one extrusion, and
// the friction lip is an island extruded from the lid's top face — strictly
// inside the outline, so it shares no ring with it (the trap qrplaque's frame
// documents).
import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { extrude } from '../kernel/builders.js';
import { union, subtract } from '../kernel/csg.js';
import { clamp, num, segScale } from '../kernel/scalar.js';
import { FIT, fitNote } from '../kernel/fit.js';

// ---------------------------------------------------------------------------
// Boards
//
// Hole positions are in CENTRED board coordinates (millimetres from the middle
// of the board), because that is the frame the case is built in and converting
// once here is better than converting in three places later.
//
// Connector positions are the exception: they are kept in the DRAWING's frame,
// verbatim from the official Raspberry Pi mechanical drawings, so that every
// number here can be checked against its source by eye. That frame has its
// origin at the board's bottom-left corner, x along the 85 mm edge, y along
// the 56 mm edge, the GPIO header along the top edge (y = 56) and USB/Ethernet
// on the right end (x = 85). `c` is the connector's centre along its edge, `w`
// its body width along that edge, `z` its Z-height above the board's top.
// `cut` is the cutout this preset makes for it: body plus ~2 mm where only the
// receptacle passes the wall, plug-overmould sized where the plug has to enter
// the hole (micro USB, USB-C, micro HDMI, audio). presetPorts() converts to
// the case frame — board centred, USB end to +x, GPIO edge to +y ("back").
//
// `fit` is what choosing the board from the Board menu carries with it —
// the tallest component, the headroom and lid that clear it, and the ports —
// and the presets are built from the same entry, so the menu and the preset
// cannot disagree.
//
// Sources: datasheets.raspberrypi.com/rpi3/raspberry-pi-3-b-plus-mechanical-
// drawing.pdf, /rpi4/raspberry-pi-4-mechanical-drawing.pdf and
// /rpizero/raspberry-pi-zero-mechanical-drawing.pdf (read 2026-09-15).
// ---------------------------------------------------------------------------

// The micro SD card sits in a slot on the UNDERSIDE of every Pi, centred on the
// left end, and pokes out past the board edge. Its cutout therefore starts
// below the board's top surface: `drop` is how far below, board thickness plus
// the slot's ~2.5 mm.
const SD_SLOT = { name: 'micro SD slot', edge: 'left', c: 28, w: 11, z: 0, cut: [16, 4.5], drop: 4.1 };

const BOARDS = {
  pi4: {
    label: 'Raspberry Pi 4 B', L: 85, W: 56,
    // 58 × 49 mm hole pattern, 3.5 mm in from two edges.
    holes: [[-39, -24.5], [-39, 24.5], [19, -24.5], [19, 24.5]],
    ports: [
      { name: 'Ethernet',     edge: 'right', c: 45.75, w: 15.9, z: 13.5, cut: [18, 15.5] },
      { name: 'USB 3 stack',  edge: 'right', c: 27,    w: 13.1, z: 16,   cut: [15.5, 17.5] },
      { name: 'USB 2 stack',  edge: 'right', c: 9,     w: 13.1, z: 16,   cut: [15.5, 17.5] },
      { name: 'USB-C power',  edge: 'front', c: 11.2,  w: 9,    z: 3.2,  cut: [13, 8] },
      { name: 'micro HDMI 0', edge: 'front', c: 26,    w: 7.5,  z: 3,    cut: [12, 7.5] },
      { name: 'micro HDMI 1', edge: 'front', c: 39.5,  w: 7.5,  z: 3,    cut: [12, 7.5] },
      { name: 'audio jack',   edge: 'front', c: 54,    w: 6,    z: 6,    cut: [9, 8] },
      SD_SLOT,
    ],
    // Friction lid: with 1.5 mm of side clearance the corner screw posts would
    // stand inside the board. 21 mm of headroom keeps the 3 mm lip above the
    // 17.5 mm USB cutouts.
    fit: { tallest: 16, clearAbove: 21, lidStyle: 'friction' },
    note: 'Pi 4 B: 85 × 56 mm, the standard 58 × 49 mm hole pattern. Ports from the official mechanical drawing: Ethernet at the GPIO-side corner, then USB 3 and USB 2 stacks down the right end; USB-C, two micro HDMI and audio along the front.',
  },
  pi5: {
    label: 'Raspberry Pi 5', L: 85, W: 56,
    holes: [[-39, -24.5], [-39, 24.5], [19, -24.5], [19, 24.5]],
    // No connector table yet: the Pi 5 moved its ports again (Ethernet back
    // to the audio-side corner, no audio jack). Choosing it clears the port
    // list rather than keeping another board's.
    fit: { tallest: 16, clearAbove: 21, lidStyle: 'friction' },
    note: 'Pi 5: same 85 × 56 mm outline and 58 × 49 mm holes as the Pi 4, but its ports moved again and have not been tabled here — measure them, or check the Pi 5 mechanical drawing.',
  },
  pi3bplus: {
    label: 'Raspberry Pi 3 B+', L: 85, W: 56,
    // Same Model B outline and 58 x 49 mm hole pattern as the Pi 4 — every
    // Model B since the 1 B+ shares it.
    holes: [[-39, -24.5], [-39, 24.5], [19, -24.5], [19, 24.5]],
    ports: [
      { name: 'USB stack (upper)', edge: 'right', c: 47,    w: 13.1, z: 16,   cut: [15.5, 17.5] },
      { name: 'USB stack (lower)', edge: 'right', c: 29,    w: 13.1, z: 16,   cut: [15.5, 17.5] },
      { name: 'Ethernet',          edge: 'right', c: 10.25, w: 15.9, z: 13.5, cut: [18, 15.5] },
      { name: 'micro USB power',   edge: 'front', c: 10.6,  w: 7.6,  z: 3,    cut: [12, 7] },
      { name: 'HDMI',              edge: 'front', c: 32,    w: 15,   z: 6.5,  cut: [17.5, 8.5] },
      { name: 'audio jack',        edge: 'front', c: 53.5,  w: 6,    z: 6,    cut: [9, 8] },
      SD_SLOT,
    ],
    fit: { tallest: 16, clearAbove: 21, lidStyle: 'friction' },
    note: 'Pi 3 B+: the SAME 85 x 56 mm outline and 58 x 49 mm holes as the Pi 4, so the shell and standoffs are interchangeable. The PORTS are not: the Pi 4 swapped Ethernet and USB, and uses USB-C plus two micro-HDMI where the 3 B+ has micro-USB and one full-size HDMI. Both presets carry their own cutouts, taken from the official mechanical drawings.',
  },
  pizero: {
    label: 'Raspberry Pi Zero / Zero 2 W', L: 65, W: 30,
    holes: [[-29, -11.5], [-29, 11.5], [29, -11.5], [29, 11.5]],
    // Everything is on the bottom edge and the left end. The SD slot is on
    // TOP of the board here, so its cutout starts at the board top like the
    // rest. The two micro USBs are 12.6 mm apart: 11 mm cutouts leave a
    // 1.6 mm pillar between two plugs.
    ports: [
      { name: 'mini HDMI',       edge: 'front', c: 12.4, w: 10.9, z: 3.7, cut: [14, 7.5] },
      { name: 'micro USB data',  edge: 'front', c: 41.4, w: 7.6,  z: 3,   cut: [11, 7] },
      { name: 'micro USB power', edge: 'front', c: 54,   w: 7.6,  z: 3,   cut: [11, 7] },
      { name: 'micro SD slot',   edge: 'left',  c: 16.9, w: 11,   z: 1.5, cut: [16, 4] },
    ],
    // 10 mm of headroom: the 2.5 mm lip must stay above the 7.5 mm HDMI cutout.
    fit: { tallest: 6, clearAbove: 10, lidStyle: 'friction' },
    note: 'Pi Zero: 65 × 30 mm, 58 × 23 mm hole pattern. Ports from the official drawing: mini HDMI and two micro USBs along the front, SD card out of the left end. Fit a 40-pin header and the tallest component becomes 8.5 mm.',
  },
  esp32: {
    label: 'ESP32 DevKit (38-pin)', L: 55, W: 28,
    holes: [[-25, -11.5], [-25, 11.5], [25, -11.5], [25, 11.5]],
    // Not from a drawing: a USB port centred on one end is the one thing the
    // dev boards have in common.
    fit: { tallest: 14, clearAbove: 16, lidStyle: 'friction', ports: 'front:0:12:6' },
    note: 'ESP32 dev boards are NOT standardised — outlines run 48–58 mm and many have no mounting holes at all. Measure yours and use Custom if this does not match.',
  },
};

const SCREWS = {
  m2:   { label: 'M2',   pilot: 1.6, clear: 2.4, boss: 5.0 },
  m25:  { label: 'M2.5', pilot: 2.1, clear: 2.9, boss: 5.5 },
  m3:   { label: 'M3',   pilot: 2.5, clear: 3.4, boss: 6.0 },
};

function screwOf(k) { return SCREWS[k] || SCREWS.m25; }
function boardOf(k) { return BOARDS[k] || null; }

/**
 * What choosing a board brings with it: its fit values and its port list.
 * Empty for Custom, so a hand-typed board keeps whatever it had.
 */
export function boardCarries(key) {
  const b = boardOf(key);
  if (!b || !b.fit) return {};
  const { ports: fitPorts, ...fit } = b.fit;
  return { ...fit, ports: b.ports ? presetPorts(key) : (fitPorts ?? '') };
}

/**
 * The port-cutout text for a board's connector table, converted from the
 * drawing frame to the case frame. Right and left edges run along y, front
 * and back along x; the offset is from the middle of that edge.
 */
export function presetPorts(key) {
  const b = boardOf(key);
  if (!b || !b.ports) return '';
  return b.ports.map(q => {
    const off = (q.edge === 'right' || q.edge === 'left') ? q.c - b.W / 2 : q.c - b.L / 2;
    const s = `${q.edge}:${+off.toFixed(2)}:${q.cut[0]}:${q.cut[1]}`;
    return q.drop ? `${s}:${q.drop}` : s;
  }).join('; ');
}

// ---------------------------------------------------------------------------
// Text-encoded tables
//
// The parameter contract has no table type, so the hole list and the port list
// travel as text. Both parsers are total: anything they cannot read becomes no
// entry rather than an exception, because the conformance sweep feeds every
// text parameter the string "A" and a run of two dozen W's, and a generator
// that throws on those is a generator that throws on a typo.
// ---------------------------------------------------------------------------

/** "x,y; x,y" -> [[x, y], ...] in centred board millimetres. */
export function parseHoles(s, limit = 24) {
  const out = [];
  for (const part of String(s ?? '').split(/[;\n]/)) {
    const bits = part.split(',').map(t => parseFloat(t.trim()));
    if (bits.length !== 2 || !bits.every(Number.isFinite)) continue;
    out.push([bits[0], bits[1]]);
    if (out.length >= limit) break;
  }
  return out;
}

const SIDES = ['left', 'right', 'front', 'back'];

/**
 * "side:offset:width:height[:drop]; ..." -> [{side, offset, w, h, drop}, ...]
 * `drop` is how far below the board's top surface the cutout floor sits
 * (default 0): the way to reach a connector on the underside of the board.
 */
export function parsePorts(s, limit = 12) {
  const out = [];
  for (const part of String(s ?? '').split(/[;\n]/)) {
    const bits = part.split(':').map(t => t.trim());
    if (bits.length !== 4 && bits.length !== 5) continue;
    const side = bits[0].toLowerCase();
    if (!SIDES.includes(side)) continue;
    const nums = bits.slice(1).map(t => parseFloat(t));
    if (!nums.every(Number.isFinite)) continue;
    const [offset, w, h] = nums;
    const drop = nums.length === 4 ? nums[3] : 0;
    if (!(w > 0.4) || !(h > 0.4) || drop < 0) continue;
    out.push({ side, offset, w, h, drop });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan — every number the solid needs, resolved and clamped, before geometry
// ---------------------------------------------------------------------------

const EMBED = 0.4;        // how far a tube sinks into the floor, mm
const CORNER_KEEP = 1.2;  // wall left at the end of a port cutout, mm

function plan(p, ctx = {}) {
  const sf = segScale(ctx);
  const seg = Math.max(6, Math.round(16 * sf));
  const segC = Math.max(10, Math.round(28 * sf));

  const preset = boardOf(p.board);
  const boardL = clamp(preset ? preset.L : num(p.boardL, 85), 15, 170);
  const boardW = clamp(preset ? preset.W : num(p.boardW, 56), 15, 170);
  const boardT = clamp(num(p.boardT, 1.6), 0.6, 4);
  const tallest = clamp(num(p.tallest, 12), 0, 80);

  const wallT = clamp(num(p.wallT, 2.4), 0.8, 8);
  const floorT = clamp(num(p.floorT, 2), 0.8, 8);
  const clearSide = clamp(num(p.clearSide, 1.5), 0.1, 12);
  const clearAbove = clamp(num(p.clearAbove, 14), 1, 80);
  const lidT = clamp(num(p.lidT, 2), 0.8, 8);

  // Interior and exterior footprints.
  const inW = boardL + 2 * clearSide;
  const inD = boardW + 2 * clearSide;
  const outW = inW + 2 * wallT;
  const outD = inD + 2 * wallT;
  const corner = clamp(num(p.corner, 3), 0, Math.min(outW, outD) / 2 - 0.01);
  const innerCorner = Math.max(0, corner - wallT);

  const screw = screwOf(p.screw);
  const standoffH = clamp(num(p.standoffH, 4), 0.6, 25);
  // The boss cannot be wider than the space between two holes or it welds them
  // into one lump, and it cannot be narrower than its own pilot.
  const standoffOD = clamp(num(p.standoffOD, screw.boss), screw.pilot + 1.2, 16);

  const lidStyle = p.lidStyle === 'screw' ? 'screw' : 'friction';
  // A friction lid is a PRESS fit: 0.10 mm per side, measured on the printed
  // Pi 3 B+ case (the 0.25 slide default rattled). See fit.js MEASURED.
  const lidFit = clamp(num(p.lidFit, FIT.press), 0.05, 0.8);
  const lipH = clamp(num(p.lipH, 3), 0.6, Math.max(0.6, clearAbove * 0.8));
  const lipW = clamp(Math.min(wallT * 0.7, 2.4), 0.6, 3);

  // Heights.
  const zBoard = floorT + standoffH;          // underside of the board
  const zBoardTop = zBoard + boardT;          // its top surface — the port datum
  const wallTop = zBoardTop + clearAbove;     // the rim the lid sits on
  const cavityH = wallTop - floorT;

  // Mounting holes, in centred board coordinates, kept far enough inside the
  // wall that the boss is a boss and not a bump on the wall.
  const rawHoles = preset ? preset.holes : parseHoles(p.holes);
  const limX = inW / 2 - standoffOD / 2 - 0.2;
  const limY = inD / 2 - standoffOD / 2 - 0.2;
  const holes = [];
  if (limX > 0 && limY > 0) {
    for (const h of rawHoles) {
      const x = clamp(h[0], -limX, limX), y = clamp(h[1], -limY, limY);
      // Drop a hole that has been clamped onto one already placed: two tubes
      // at the same centre is a self-intersection, not a standoff.
      if (holes.some(o => Math.hypot(o[0] - x, o[1] - y) < standoffOD * 0.9)) continue;
      holes.push([x, y]);
    }
  }

  // Screw posts, one per interior corner, only where they genuinely fit.
  const postOD = clamp(standoffOD, screw.pilot + 1.2, 16);
  const postInset = postOD / 2 + Math.max(0.6, innerCorner * 0.35);
  const posts = [];
  if (lidStyle === 'screw' && postInset * 2 + 1 < Math.min(inW, inD)) {
    const px = inW / 2 - postInset, py = inD / 2 - postInset;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) posts.push([sx * px, sy * py]);
  }

  // Ports. The cutout's floor is the board's top surface, because that is
  // where a connector's body actually starts — unless the entry drops it, for
  // the SD slot on a Pi's underside. A drop never reaches into the floor slab.
  const ports = [];
  for (const q of parsePorts(p.ports)) {
    const along = (q.side === 'left' || q.side === 'right') ? inD : inW;
    const drop = clamp(q.drop, 0, Math.max(0, zBoardTop - floorT));
    const z0 = zBoardTop - drop;
    const w = clamp(q.w, 0.6, Math.max(0.6, along - 2 * CORNER_KEEP));
    const h = clamp(q.h, 0.6, Math.max(0.6, wallTop - z0 + 2));
    const lim = Math.max(0, (along - w) / 2 - CORNER_KEEP);
    const off = clamp(q.offset, -lim, lim);
    ports.push({ side: q.side, off, w, h, z0, drop });
  }

  // Vents: one row of stadium slots down the middle of the lid, inside
  // whatever the lip leaves. Count follows from the space, so the sweep cannot
  // ask for more slots than fit.
  const vents = !!p.vents;
  const ventW = clamp(num(p.ventW, 2.5), 0.8, 10);
  const ventGap = clamp(num(p.ventGap, 3), 1.2, 16);
  const ventField = lidStyle === 'friction'
    ? { w: inW - 2 * lidFit - 2 * lipW - 4, d: inD - 2 * lidFit - 2 * lipW - 4 }
    : { w: outW - 2 * wallT - 4, d: outD - 2 * wallT - 4 };
  let ventSlots = [];
  if (vents && ventField.w > ventW * 2 && ventField.d > ventW * 2) {
    const pitch = ventW + ventGap;
    const n = Math.max(0, Math.floor((ventField.w + ventGap) / pitch));
    const len = Math.max(ventW * 1.2, ventField.d * 0.7);
    const span = n * pitch - ventGap;
    for (let i = 0; i < n && i < 40; i++) {
      const x = -span / 2 + ventW / 2 + i * pitch;
      ventSlots.push({ x, len, w: ventW });
    }
    // A slot must clear the screw holes it would otherwise run through.
    if (lidStyle === 'screw' && posts.length) {
      ventSlots = ventSlots.filter(s =>
        posts.every(q => Math.abs(q[0] - s.x) > ventW / 2 + screw.clear / 2 + 1));
    }
  }

  const part = ['both', 'base', 'lid'].includes(p.part) ? p.part : 'both';

  // The two numbers the analysis column exists for.
  const standoffGap = holes.length
    ? Math.min(...holes.map(h => Math.min(inW / 2 - Math.abs(h[0]), inD / 2 - Math.abs(h[1])))) - standoffOD / 2
    : null;
  const lidClears = clearAbove - tallest;

  // A screw post runs the full height of the cavity, so it must stand clear
  // of the board's footprint or the board cannot go in. Distance from the post
  // centre to the board's rectangle, less the post's radius; negative means
  // the post is inside the board. The board's corner radius is ignored, which
  // errs on the side of flagging a graze.
  const postBoardGap = posts.length
    ? Math.min(...posts.map(([x, y]) => Math.hypot(
      Math.max(0, Math.abs(x) - boardL / 2), Math.max(0, Math.abs(y) - boardW / 2)))) - postOD / 2
    : null;
  // The side clearance at which the posts would just clear the board.
  const clearSideForPosts = postInset + postOD / 2;

  // A friction lid's lip runs right round the inside of the wall, so a cutout
  // that reaches up past the lip line has the lip landing in the hole.
  const lipLine = lidStyle === 'friction' ? wallTop - lipH : Infinity;
  const lipInCutout = ports.filter(q => q.z0 + q.h > lipLine + 1e-6)
    .map(q => ({ ...q, by: q.z0 + q.h - lipLine }));

  return {
    sf, seg, segC, preset, boardL, boardW, boardT, tallest,
    wallT, floorT, clearSide, clearAbove, lidT, corner, innerCorner,
    inW, inD, outW, outD, screw, screwKey: SCREWS[p.screw] ? p.screw : 'm25',
    standoffH, standoffOD, lidStyle, lidFit, lipH, lipW,
    zBoard, zBoardTop, wallTop, cavityH,
    holes, posts, postOD, ports, vents, ventW, ventGap, ventSlots,
    part, standoffGap, lidClears, postBoardGap, clearSideForPosts, lipInCutout,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function tube(od, id, h, z0, cx, cy, segs) {
  const rings = [P.circle(od / 2, { segs, cx, cy })];
  if (id > 0.05 && id < od - 0.4) rings.push(P.ensureCW(P.circle(id / 2, { segs, cx, cy })));
  return extrude(rings, h, { z0, check: false });
}

function buildBase(L) {
  const outer = P.roundRect(L.outW, L.outD, L.corner, { segs: L.seg });
  const inner = P.roundRect(L.inW, L.inD, L.innerCorner, { segs: L.seg });
  const embed = Math.min(EMBED, L.floorT * 0.6);

  // The cavity carries the screw posts as HOLES in its own outline, so the
  // posts are simply block material the cavity never reached. Standing them up
  // separately and unioning them put a post's top face exactly in the plane of
  // the rim, and a BSP union across coplanar faces is the one case it does not
  // survive — it tore the shell open the moment a port was subtracted next.
  const cavityShape = [inner];
  for (const [x, y] of L.posts) {
    cavityShape.push(P.ensureCW(P.circle(L.postOD / 2, { segs: L.segC, cx: x, cy: y })));
  }

  let base = subtract(
    extrude([outer], L.wallTop),
    extrude([cavityShape], L.cavityH + 5, { z0: L.floorT }),
  );

  // Standoffs are short — their tops sit well below every other face — so a
  // union is safe here in a way it was not for the full-height posts.
  const risers = [];
  for (const [x, y] of L.holes) {
    risers.push(tube(L.standoffOD, L.screw.pilot, L.standoffH + embed, L.floorT - embed, x, y, L.segC));
  }
  if (risers.length) base = union(base, Mesh.merge(risers));

  // Ports and post pilots, removed together in one pass.
  const cutters = [];
  for (const [x, y] of L.posts) {
    // Blind: it starts inside the floor and stops above the rim, so neither
    // end is coplanar with anything.
    cutters.push(extrude([P.circle(L.screw.pilot / 2, { segs: L.segC, cx: x, cy: y })],
      L.wallTop - L.floorT + embed + 2, { z0: L.floorT - embed }));
  }
  for (const q of L.ports) {
    const thick = L.wallT + 4;
    const h = Math.min(q.h, L.wallTop - q.z0 + 3);
    if (!(h > 0.05)) continue;
    let m;
    if (q.side === 'left' || q.side === 'right') {
      m = extrude([P.rect(thick, q.w, { cx: (q.side === 'right' ? 1 : -1) * (L.outW / 2 - L.wallT / 2 + 0.5), cy: q.off })], h, { z0: q.z0 });
    } else {
      m = extrude([P.rect(q.w, thick, { cx: q.off, cy: (q.side === 'back' ? 1 : -1) * (L.outD / 2 - L.wallT / 2 + 0.5) })], h, { z0: q.z0 });
    }
    cutters.push(m);
  }
  if (cutters.length) base = subtract(base, Mesh.merge(cutters));

  return base.healTJunctions();
}

function buildLid(L) {
  const outer = P.roundRect(L.outW, L.outD, L.corner, { segs: L.seg });
  const holes = [];

  if (L.lidStyle === 'screw') {
    for (const [x, y] of L.posts) {
      holes.push(P.ensureCW(P.circle(L.screw.clear / 2, { segs: L.segC, cx: x, cy: y })));
    }
  }
  for (const s of L.ventSlots) {
    const len = Math.max(s.w * 1.05, s.len);
    holes.push(P.ensureCW(P.roundRect(s.w, len, s.w / 2, { segs: Math.max(6, Math.round(L.seg / 2)), cx: s.x, cy: 0 })));
  }

  let lid = extrude([[outer, ...holes]], L.lidT, { check: false });

  // The friction lip: an island on the lid's top face, strictly inside the
  // outline, so it shares no ring with it.
  if (L.lidStyle === 'friction') {
    const lw = L.inW - 2 * L.lidFit, ld = L.inD - 2 * L.lidFit;
    const iw = lw - 2 * L.lipW, id = ld - 2 * L.lipW;
    if (lw > 2 && ld > 2 && iw > 1 && id > 1) {
      const lipRing = [
        P.roundRect(lw, ld, Math.max(0, L.innerCorner - L.lidFit), { segs: L.seg }),
        P.ensureCW(P.roundRect(iw, id, Math.max(0, L.innerCorner - L.lidFit - L.lipW), { segs: L.seg })),
      ];
      lid = Mesh.merge([lid, extrude([lipRing], L.lipH, { z0: L.lidT, check: false })]);
    }
  }
  return lid.healTJunctions();
}

/**
 * Lay the parts out flat. Stacking happens along the part's SHORTER footprint
 * axis, which keeps a wide case (a Pi 4 shell is 93 × 64 mm) inside a 180 mm
 * bed where a naive left-to-right row would run to 190 mm and fail the bed
 * check on the default build.
 */
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
    placed.push({ name: c.name, mesh: c.mesh, at: run + step / 2, step });
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
    offset: off, alongX,
  };
}

function build(p, ctx = {}) {
  const L = plan(p, ctx);

  const wanted = [];
  if (L.part !== 'lid') wanted.push({ name: 'base', mesh: buildBase(L) });
  if (L.part !== 'base') wanted.push({ name: 'lid', mesh: buildLid(L) });
  const laid = arrange(wanted);

  // Callouts are drawn on the base where there is one, otherwise on the lid.
  // They are computed in the part's own frame and then carried through
  // whatever arrange() did to it, so a callout never floats off the object.
  const host = laid.parts.find(q => q.name === 'base') || laid.parts[0];
  const src = wanted.find(q => q.name === host.name);
  const hb = src.mesh.bbox(), pb = host.mesh.bbox();
  const T = [pb.center[0] - hb.center[0], pb.center[1] - hb.center[1], pb.min[2] - hb.min[2]];
  const at = (x, y, z) => [x + T[0], y + T[1], z + T[2]];

  const dims = [];
  if (host.name === 'base') {
    const xR = L.outW / 2, yF = -L.outD / 2;
    dims.push({ param: 'wallT', from: at(xR - L.wallT, 0, L.wallTop), to: at(xR, 0, L.wallTop), offset: [0, 0, 1] });
    dims.push({ param: 'floorT', from: at(xR, yF, 0), to: at(xR, yF, L.floorT), offset: [1, -1, 0] });
    dims.push({ param: 'clearAbove', value: L.clearAbove, from: at(-xR + L.wallT, 0, L.zBoardTop), to: at(-xR + L.wallT, 0, L.wallTop), offset: [-1, 0, 0] });
    if (L.holes.length) {
      const [hx, hy] = L.holes[0];
      dims.push({ param: 'standoffH', from: at(hx, hy, L.floorT), to: at(hx, hy, L.floorT + L.standoffH), offset: [0, -1, 0] });
      dims.push({ param: 'standoffOD', label: 'Ø', from: at(hx - L.standoffOD / 2, hy, L.floorT + L.standoffH), to: at(hx + L.standoffOD / 2, hy, L.floorT + L.standoffH), offset: [0, 0, 1] });
    }
    if (!L.preset) {
      dims.push({ param: 'boardL', from: at(-L.boardL / 2, 0, L.zBoardTop), to: at(L.boardL / 2, 0, L.zBoardTop), offset: [0, 1, 0] });
    } else {
      dims.push({ label: 'board', value: `${L.boardL} × ${L.boardW}`, from: at(-L.boardL / 2, 0, L.zBoardTop), to: at(L.boardL / 2, 0, L.zBoardTop), offset: [0, 1, 0] });
    }
    if (L.corner > 0.01) {
      dims.push({ param: 'corner', label: 'R', value: L.corner, from: at(xR - L.corner, L.outD / 2 - L.corner, L.floorT), to: at(xR, L.outD / 2 - L.corner, L.floorT), offset: [0, 0, 1] });
    }
  }
  const lidPart = laid.parts.find(q => q.name === 'lid');
  if (lidPart) {
    const ls = wanted.find(q => q.name === 'lid');
    const lb = ls.mesh.bbox(), lp = lidPart.mesh.bbox();
    const U = [lp.center[0] - lb.center[0], lp.center[1] - lb.center[1], lp.min[2] - lb.min[2]];
    dims.push({ param: 'lidT', from: [L.outW / 2 + U[0], U[1], U[2]], to: [L.outW / 2 + U[0], U[1], L.lidT + U[2]], offset: [1, 0, 0] });
  }

  const analysis = [];
  if (L.standoffGap === null) {
    analysis.push('No mounting holes, so the board is a drop-in fit on the floor — nothing holds it down.');
  } else if (L.standoffGap < 0.5) {
    analysis.push(`Standoff to wall: ${L.standoffGap.toFixed(2)} mm. The boss is effectively touching the wall — widen the side clearance or use a narrower boss.`);
  } else {
    analysis.push(`Standoff to wall: ${L.standoffGap.toFixed(2)} mm of clear air between the nearest ${L.standoffOD} mm boss and the inside of the wall.`);
  }
  if (L.tallest <= 0) {
    analysis.push(`Lid clearance: ${L.clearAbove.toFixed(1)} mm above the board, with no component height given to check it against.`);
  } else if (L.lidClears < 0) {
    analysis.push(`Lid does NOT clear: a ${L.tallest} mm component needs ${(-L.lidClears).toFixed(1)} mm more headroom than the ${L.clearAbove} mm you have.`);
  } else {
    analysis.push(`Lid clears the tallest component by ${L.lidClears.toFixed(1)} mm (${L.tallest} mm part under ${L.clearAbove} mm of headroom).`);
  }
  if (L.postBoardGap !== null) {
    if (L.postBoardGap < 0) {
      analysis.push(`Screw posts stand INSIDE the board's footprint by ${(-L.postBoardGap).toFixed(1)} mm — the board cannot go in. Use the friction lid, or a side clearance of at least ${L.clearSideForPosts.toFixed(1)} mm.`);
    } else {
      analysis.push(`Screw posts clear the board's corners by ${L.postBoardGap.toFixed(1)} mm.`);
    }
  }

  return {
    mesh: laid.mesh,
    parts: laid.parts,
    meta: {
      dims,
      analysis,
      board: { length: L.boardL, width: L.boardW, thickness: L.boardT, preset: L.preset ? L.preset.label : 'Custom' },
      external: [r2(L.outW), r2(L.outD), r2(L.wallTop + (L.part === 'base' ? 0 : L.lidT))],
      internal: [r2(L.inW), r2(L.inD), r2(L.clearAbove + L.boardT + L.standoffH)],
      standoffs: L.holes.length,
      screwPosts: L.posts.length,
      ports: L.ports.length,
      vents: L.ventSlots.length,
      standoffWallGap: L.standoffGap === null ? null : r2(L.standoffGap),
      lidHeadroom: r2(L.lidClears),
      screw: L.screw.label,
      lidStyle: L.lidStyle,
    },
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------

function validate(p) {
  const issues = [];
  const L = plan(p, {});

  if (L.standoffGap !== null && L.standoffGap < 0.4) {
    issues.push({ param: 'clearSide', severity: 'warn',
      message: `A ${L.standoffOD} mm boss leaves ${L.standoffGap.toFixed(2)} mm to the wall. Board-edge components will foul it; widen the side clearance or narrow the boss.` });
  }
  if (L.tallest > 0 && L.lidClears < 0) {
    issues.push({ param: 'clearAbove', severity: 'error',
      message: `The lid will sit on a ${L.tallest} mm component: ${L.clearAbove} mm of headroom is ${(-L.lidClears).toFixed(1)} mm short.` });
  } else if (L.tallest > 0 && L.lidClears < 1) {
    issues.push({ param: 'clearAbove', severity: 'warn',
      message: `Only ${L.lidClears.toFixed(1)} mm between the tallest component and the lid — tight enough that print tolerance could close it.` });
  }
  if (!L.preset && parseHoles(p.holes).length === 0 && String(p.holes ?? '').trim()) {
    issues.push({ param: 'holes', severity: 'warn',
      message: 'No hole positions could be read. Use "x,y" pairs separated by semicolons, measured from the centre of the board — for example "-39,-24.5; 19,24.5".' });
  }
  if (String(p.ports ?? '').trim() && parsePorts(p.ports).length === 0) {
    issues.push({ param: 'ports', severity: 'warn',
      message: 'No port cutouts could be read. Each is "side:offset:width:height", for example "right:19:15.5:17.5" — side is left, right, front or back. A fifth number drops the cutout floor below the board top.' });
  }
  if (L.postBoardGap !== null && L.postBoardGap < 0) {
    issues.push({ param: 'lidStyle', severity: 'error',
      message: `The corner screw posts stand inside the board's footprint by ${(-L.postBoardGap).toFixed(1)} mm, so the board cannot go in. Use the friction lid, or widen the side clearance to at least ${L.clearSideForPosts.toFixed(1)} mm.` });
  }
  if (L.lipInCutout.length) {
    const worst = L.lipInCutout.reduce((a, b) => (b.by > a.by ? b : a));
    issues.push({ param: 'clearAbove', severity: 'warn',
      message: `The lid's lip drops ${worst.by.toFixed(1)} mm into the ${worst.side} port cutout at ${worst.off} mm — it will land on whatever is plugged in there. Add that much headroom, or shorten the cutout.` });
  }
  if (L.standoffH > 0 && L.standoffOD <= L.screw.pilot + 1) {
    issues.push({ param: 'standoffOD', severity: 'warn',
      message: `A ${L.standoffOD} mm boss around a ${L.screw.pilot} mm pilot leaves under 0.5 mm of wall — it will split when the screw goes in.` });
  }
  if (L.lidStyle === 'screw' && L.posts.length === 0) {
    issues.push({ param: 'lidStyle', severity: 'warn',
      message: 'The interior is too small for corner screw posts, so the lid has nothing to screw into. Use the friction lid at this size.' });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const L = plan(p, ctx);
  const notes = [];
  notes.push('Print both parts flat as arranged: the base sits on its floor and the lid on its outside face, so neither needs supports.');
  if (L.ports.length) {
    notes.push(`The ${L.ports.length} port cutout${L.ports.length > 1 ? 's are' : ' is'} a bridge across the top of the opening. That bridges cleanly at this span, but slow the first layer over it if the underside matters.`);
  }
  if (L.standoffH > 0 && L.holes.length) {
    notes.push(`Standoff pilots are ${L.screw.pilot} mm for self-tapping ${L.screw.label} screws straight into the plastic — no inserts, no nuts. Drill out to ${L.screw.clear} mm if you would rather use a nut underneath.`);
  }
  if (L.lidStyle === 'friction') {
    notes.push(`The lip is ${L.lidFit.toFixed(2)} mm under the opening per side. ${fitNote('press')} If it is tight, sand the lip rather than reprinting the box; if it rattles, reprint the lid alone a step tighter.`);
  } else {
    notes.push(`Four ${L.screw.clear} mm clearance holes in the lid over ${L.screw.pilot} mm pilots in the posts — ${L.screw.label} screws about ${Math.round(L.wallTop - L.floorT + L.lidT)} mm long.`);
  }
  notes.push('Three walls and 20% infill: the case wants stiffness, not mass. PETG if it will live somewhere warm, PLA otherwise.');
  return { profile: { layerH, infill: 20, walls: 3 }, supports: false, filament: 'PLA', notes };
}

// ---------------------------------------------------------------------------

export default {
  id: 'pcbcase',
  name: 'PCB Enclosure',
  category: 'Utility',
  blurb: 'A case for a circuit board: standoffs on your hole pattern, cutouts for the ports, a lid that clips or screws on.',
  description:
    'A box built around a board rather than around a number. Pick a Raspberry Pi 4, 5 or 3 B+, a Pi Zero or an ESP32 dev board and the ' +
    'outline and mounting pattern come with it; or give it your own size and a list of hole positions measured from the centre of ' +
    'the board. Standoffs rise from the floor with pilot holes for self-tapping screws, port cutouts are placed by side and offset ' +
    'with their floor at the board\'s top surface where a connector actually starts, and the lid either clips on with a friction ' +
    'lip or screws down into corner posts. The analysis names the two things that decide whether it is usable: how much air is ' +
    'left between the nearest standoff and the wall, and whether the lid clears the tallest component you told it about.',
  version: 1,
  params: [
    { key: 'board', label: 'Board', type: 'enum', def: 'pi4', group: 'Board', carries: (v) => boardCarries(v),
      options: [
        { v: 'pi4', label: 'Raspberry Pi 4 B', help: '85 × 56 mm, 58 × 49 mm holes.' },
        { v: 'pi5', label: 'Raspberry Pi 5', help: 'Same outline and holes as the Pi 4.' },
        { v: 'pi3bplus', label: 'Raspberry Pi 3 B+', help: 'Same outline and holes as the Pi 4 — but the ports are in different places. The preset has them.' },
        { v: 'pizero', label: 'Pi Zero / Zero 2 W', help: '65 × 30 mm, 58 × 23 mm holes.' },
        { v: 'esp32', label: 'ESP32 DevKit (38-pin)', help: 'Dev boards vary a lot — measure yours.' },
        { v: 'custom', label: 'Custom board', help: 'Type the size and hole positions yourself.' },
      ],
      help: 'A known board brings its outline, holes, port cutouts, tallest component and headroom with it. Wall, floor, screws and vents stay yours.' },
    { key: 'boardL', label: 'Board length', type: 'number', def: 85, min: 15, max: 170, step: 0.5, unit: 'mm', group: 'Board',
      showIf: (p) => !BOARDS[p.board], help: 'The long side of the board, X in the case.' },
    { key: 'boardW', label: 'Board width', type: 'number', def: 56, min: 15, max: 170, step: 0.5, unit: 'mm', group: 'Board',
      showIf: (p) => !BOARDS[p.board], help: 'The short side, Y in the case.' },
    { key: 'holes', label: 'Hole positions', type: 'text', def: '-39,-24.5; -39,24.5; 19,-24.5; 19,24.5', maxLength: 200, group: 'Board',
      showIf: (p) => !BOARDS[p.board],
      help: 'Mounting holes as "x,y" pairs from the CENTRE of the board, separated by semicolons. Leave empty for a board that just drops in.' },
    { key: 'boardT', label: 'Board thickness', type: 'number', def: 1.6, min: 0.6, max: 4, step: 0.1, unit: 'mm', group: 'Board',
      help: '1.6 mm is standard FR-4. It matters because the port cutouts are measured from the top of the board.' },
    { key: 'tallest', label: 'Tallest component', type: 'number', def: 12, min: 0, max: 80, step: 0.5, unit: 'mm', group: 'Board',
      help: 'Height of the tallest thing on the board, measured from its top surface. Adds no geometry — it is what the lid clearance is checked against. Zero to skip the check.' },

    { key: 'wallT', label: 'Wall thickness', type: 'number', def: 2.4, min: 0.8, max: 8, step: 0.2, unit: 'mm', group: 'Case',
      help: '2.4 mm is six passes of a 0.4 mm nozzle: stiff enough to take a screw without splitting.' },
    { key: 'floorT', label: 'Floor thickness', type: 'number', def: 2, min: 0.8, max: 8, step: 0.2, unit: 'mm', group: 'Case',
      help: 'The slab under the board. The standoff pilots sink a fraction into it for thread to bite on.' },
    { key: 'clearSide', label: 'Side clearance', type: 'number', def: 1.5, min: 0.1, max: 12, step: 0.1, unit: 'mm', group: 'Case',
      help: 'Air between the edge of the board and the inside of the wall, per side. This is what buys room for edge connectors and fingers.' },
    { key: 'clearAbove', label: 'Headroom', type: 'number', def: 14, min: 1, max: 80, step: 0.5, unit: 'mm', group: 'Case',
      help: 'Space between the top of the board and the underside of the lid. Compared against the tallest component in the analysis.' },
    { key: 'corner', label: 'Corner radius', type: 'number', def: 3, min: 0, max: 20, step: 0.5, unit: 'mm', group: 'Case',
      help: 'Rounding on the outside corners. Zero is square.' },

    { key: 'screw', label: 'Screw size', type: 'enum', def: 'm25', group: 'Mounting',
      options: [
        { v: 'm2', label: 'M2', help: '1.6 mm pilot.' },
        { v: 'm25', label: 'M2.5', help: '2.1 mm pilot — what a Pi wants.' },
        { v: 'm3', label: 'M3', help: '2.5 mm pilot.' },
      ],
      help: 'Sets the pilot hole in the standoffs and the clearance hole in the lid.' },
    { key: 'standoffH', label: 'Standoff height', type: 'number', def: 4, min: 0.6, max: 25, step: 0.5, unit: 'mm', group: 'Mounting',
      help: 'How far the board is lifted off the floor. Enough to clear whatever is soldered on the underside.' },
    { key: 'standoffOD', label: 'Standoff diameter', type: 'number', def: 5.5, min: 3, max: 16, step: 0.5, unit: 'mm', group: 'Mounting',
      help: 'Outside of the boss. Wider is stronger and eats more board area.' },

    { key: 'ports', label: 'Port cutouts', type: 'text', def: 'right:14:16:11; back:20:9:4', maxLength: 240, group: 'Ports',
      help: 'One per entry: "side:offset:width:height". Side is left, right, front or back; offset is millimetres from the middle of that side; the cutout starts at the top of the board. An optional fifth number drops its floor that far below the board top, for a connector on the underside such as a Pi\'s SD slot.' },

    { key: 'vents', label: 'Vents', type: 'bool', def: true, group: 'Ventilation',
      help: 'A row of slots down the lid. Worth it for anything that gets warm.' },
    { key: 'ventW', label: 'Slot width', type: 'number', def: 2.5, min: 0.8, max: 10, step: 0.1, unit: 'mm', group: 'Ventilation',
      showIf: (p) => !!p.vents, help: 'Across each slot. Under about 2 mm and the slicer starts closing them up.' },
    { key: 'ventGap', label: 'Slot spacing', type: 'number', def: 3, min: 1.2, max: 16, step: 0.2, unit: 'mm', group: 'Ventilation',
      showIf: (p) => !!p.vents, help: 'Solid lid between one slot and the next.' },

    { key: 'lidStyle', label: 'Lid', type: 'enum', def: 'friction', group: 'Lid',
      options: [
        { v: 'friction', label: 'Friction lip', help: 'Clips on. Nothing to lose, nothing to undo.' },
        { v: 'screw', label: 'Screwed down', help: 'Four corner posts inside the box; screws through the lid.' },
      ],
      help: 'The same two closures the box generator offers, minus the round threaded cap — a rectangular enclosure cannot use one.' },
    { key: 'lidT', label: 'Lid thickness', type: 'number', def: 2, min: 0.8, max: 8, step: 0.2, unit: 'mm', group: 'Lid' },
    { key: 'lidFit', label: 'Lip clearance', type: 'number', def: FIT.press, min: 0.05, max: 0.8, step: 0.05, unit: 'mm', group: 'Lid',
      showIf: (p) => p.lidStyle !== 'screw', help: `Gap between the lip and the inside of the box, per side. A friction lid wants a press fit: ${fitNote('press')} 0.25 rattled.` },
    { key: 'lipH', label: 'Lip depth', type: 'number', def: 3, min: 0.6, max: 12, step: 0.5, unit: 'mm', group: 'Lid',
      showIf: (p) => p.lidStyle !== 'screw', help: 'How far the lip drops into the box. Deeper holds better and needs more headroom.' },

    { key: 'part', label: 'Show', type: 'enum', def: 'both', group: 'Output',
      options: [
        { v: 'both', label: 'Base and lid' },
        { v: 'base', label: 'Base only' },
        { v: 'lid', label: 'Lid only' },
      ],
      help: 'Both are laid out flat side by side, ready to slice as one plate.' },
  ],
  presets: [
    // The board presets take their board-specific values from the board
    // table (boardCarries), so choosing the board from the menu and choosing
    // the preset agree by construction.
    { name: 'Raspberry Pi 4', values: {
      board: 'pi4', boardT: 1.6, wallT: 2.4, floorT: 2, clearSide: 1.5, corner: 3,
      screw: 'm25', standoffH: 4, standoffOD: 5.5, ...boardCarries('pi4'),
      vents: true, ventW: 2.5, ventGap: 3, lidT: 2, lidFit: FIT.press, lipH: 3, part: 'both' } },
    { name: 'Raspberry Pi 3 B+', values: {
      board: 'pi3bplus', boardT: 1.6, wallT: 2.4, floorT: 2, clearSide: 1.5, corner: 3,
      screw: 'm25', standoffH: 4, standoffOD: 5.5, ...boardCarries('pi3bplus'),
      vents: true, ventW: 2.5, ventGap: 3, lidT: 2, lidFit: FIT.press, lipH: 3, part: 'both' } },
    { name: 'Pi Zero, slim', values: {
      board: 'pizero', boardT: 1.6, wallT: 2, floorT: 1.6, clearSide: 1.2, corner: 2.5,
      screw: 'm25', standoffH: 3, standoffOD: 5, ...boardCarries('pizero'),
      vents: false, lidT: 1.6, lidFit: FIT.press, lipH: 2.5, part: 'both' } },
    { name: 'ESP32 project box', values: {
      board: 'esp32', boardT: 1.6, wallT: 2.4, floorT: 2, clearSide: 3, corner: 4,
      screw: 'm3', standoffH: 5, standoffOD: 6, ...boardCarries('esp32'),
      vents: true, ventW: 3, ventGap: 4, lidT: 2, lidFit: FIT.press, lipH: 3, part: 'both' } },
    { name: 'Blank tray, no board', values: {
      board: 'custom', boardL: 100, boardW: 70, holes: '', boardT: 1.6, tallest: 0,
      wallT: 3, floorT: 2.4, clearSide: 0.5, clearAbove: 24, corner: 6,
      screw: 'm3', standoffH: 2, standoffOD: 6, ports: '',
      vents: false, lidStyle: 'screw', lidT: 2.4, part: 'both' } },
  ],
  build,
  validate,
  hints,
};
