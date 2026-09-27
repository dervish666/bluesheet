// PCB enclosure. The generic checks are the conformance sweep; the specific
// ones ask the two assembly questions a case for a real board has to answer:
// does the board go in, and do its connectors come out. Both are asked of the
// MESH, with the connector positions taken from the official Raspberry Pi
// mechanical drawings and converted to the case frame here, independently of
// whatever the generator's own preset table says.
//
// Drawings (datasheets.raspberrypi.com): rpi3/raspberry-pi-3-b-plus-mechanical-
// drawing.pdf and rpi4/raspberry-pi-4-mechanical-drawing.pdf. Their frame:
// origin at the board's bottom-left corner, x along the 85 mm edge, y along
// the 56 mm edge, the GPIO header along the top edge (y = 56), USB and
// Ethernet on the right end (x = 85). Z-heights are above the board's top.
import { suite, check, near, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh } from './lib/genconform.mjs';
import { triGrid, pointInsideMesh } from '../js/kernel/validate.js';
import gen, { parsePorts, presetPorts } from '../js/gen/pcbcase.js';
import { FIT } from '../js/kernel/fit.js';

suite('gen pcbcase');
conformance(gen, 'pcbcase');

const C = ctx('normal');
const presetNamed = (frag) => {
  const p = gen.presets.find(q => q.name.includes(frag));
  if (!p) throw new Error(`no preset matching "${frag}"`);
  return { ...defaults(gen), ...p.values };
};
const buildBase = (p) => asMesh(gen.build({ ...p, part: 'base' }, C));
const prober = (mesh) => { const g = triGrid(mesh); return (x, y, z) => pointInsideMesh(g, [x, y, z]); };

// Every number the probes need, derived from the parameters the same way a
// person reading the help text would — not from the generator's plan().
function frame(p, B = PI_B) {
  const inW = B.L + 2 * p.clearSide, inD = B.W + 2 * p.clearSide;
  const outW = inW + 2 * p.wallT, outD = inD + 2 * p.wallT;
  const zBoard = p.floorT + p.standoffH;
  const zBoardTop = zBoard + p.boardT;
  const wallTop = zBoardTop + p.clearAbove;
  return { inW, inD, outW, outD, zBoard, zBoardTop, wallTop };
}

// Connectors in the DRAWING frame. c = centre along the edge (mm from the
// drawing origin), w = body width along the edge, z = Z-height above the board.
const PI3_PORTS = [
  { name: 'USB stack (upper)', edge: 'right', c: 47,    w: 13.1, z: 16 },
  { name: 'USB stack (lower)', edge: 'right', c: 29,    w: 13.1, z: 16 },
  { name: 'Ethernet',          edge: 'right', c: 10.25, w: 15.9, z: 13.5 },
  { name: 'micro USB power',   edge: 'front', c: 10.6,  w: 7.6,  z: 3 },
  { name: 'HDMI',              edge: 'front', c: 32,    w: 15,   z: 6.5 },
  { name: 'audio jack',        edge: 'front', c: 53.5,  w: 6,    z: 6 },
];
const PI4_PORTS = [
  { name: 'Ethernet',          edge: 'right', c: 45.75, w: 15.9, z: 13.5 },
  { name: 'USB 3 stack',       edge: 'right', c: 27,    w: 13.1, z: 16 },
  { name: 'USB 2 stack',       edge: 'right', c: 9,     w: 13.1, z: 16 },
  { name: 'USB-C power',       edge: 'front', c: 11.2,  w: 9,    z: 3.2 },
  { name: 'micro HDMI 0',      edge: 'front', c: 26,    w: 7.5,  z: 3 },
  { name: 'micro HDMI 1',      edge: 'front', c: 39.5,  w: 7.5,  z: 3 },
  { name: 'audio jack',        edge: 'front', c: 54,    w: 6,    z: 6 },
];
// rpizero/raspberry-pi-zero-mechanical-drawing.pdf: 65 × 30, same frame
// (GPIO along the top edge). Everything is on the bottom edge and the left end.
const PIZERO_PORTS = [
  { name: 'mini HDMI',        edge: 'front', c: 12.4, w: 10.9, z: 3.7 },
  { name: 'micro USB data',   edge: 'front', c: 41.4, w: 7.6,  z: 3 },
  { name: 'micro USB power',  edge: 'front', c: 54,   w: 7.6,  z: 3 },
];
// Boards: outline, and the four mounting holes 3.5 mm in from two edges.
const PI_B = { L: 85, W: 56, holes: [[3.5, 3.5], [3.5, 52.5], [61.5, 3.5], [61.5, 52.5]] };
const PI_ZERO = { L: 65, W: 30, holes: [[3.5, 3.5], [3.5, 26.5], [61.5, 3.5], [61.5, 26.5]] };

/** Drawing frame -> case frame: the board is centred, USB end to +x, GPIO to +y. */
const toCaseOf = (B) => (x, y) => [x - B.L / 2, y - B.W / 2];
const toCase = toCaseOf(PI_B);

function checkBoard(label, p, portsInDrawing, B = PI_B) {
  const F = frame(p, B);
  const toCase = toCaseOf(B);
  const m = buildBase(p);
  const solid = prober(m);
  const b = m.bbox();
  near(`${label}: base is ${F.outW} mm long`, b.size[0], F.outW, 0.05);
  near(`${label}: base is ${F.outD} mm wide`, b.size[1], F.outD, 0.05);

  // 1. The board goes in: at mid-thickness, every point of an 85 × 56 outline
  //    with 3 mm corners is void. A screw post standing in a corner, or a
  //    standoff that reaches the board's plane, would show up here.
  let hits = 0, tested = 0;
  const zMid = F.zBoard + p.boardT / 2;
  for (let x = -(B.L / 2 - 0.5); x <= B.L / 2 - 0.5; x += 1) for (let y = -(B.W / 2 - 0.5); y <= B.W / 2 - 0.5; y += 1) {
    const cx = Math.max(0, Math.abs(x) - (B.L / 2 - 3)), cy = Math.max(0, Math.abs(y) - (B.W / 2 - 3));
    if (Math.hypot(cx, cy) > 3) continue;           // outside the rounded corner
    tested++;
    if (solid(x, y, zMid)) hits++;
  }
  check(`${label}: the board's own volume is empty (${hits} of ${tested} points solid)`, hits === 0 && tested > B.L * B.W * 0.8);

  // 2. Standoffs: a boss under each drawing hole, with a pilot down its middle.
  for (const [hx, hy] of B.holes) {
    const [x, y] = toCase(hx, hy);
    const zTop = F.zBoard - 0.3;
    check(`${label}: boss under hole (${hx}, ${hy})`, solid(x + 2, y, zTop) && solid(x, y + 2, zTop));
    check(`${label}: pilot in boss (${hx}, ${hy})`, !solid(x, y, zTop));
  }

  // 3. Connectors come out. For each, probe the middle of the wall's
  //    thickness: void across the connector's body and height, solid a little
  //    way beyond it on either side so the cutout is a port and not a missing
  //    wall. Where the connector nearly reaches the rim, the cutout is allowed
  //    to run out through it, so "solid above" is only asked when there is
  //    room for a bridge.
  const wallMid = { right: { x: F.outW / 2 - p.wallT / 2 }, front: { y: -(F.outD / 2 - p.wallT / 2) } };
  for (const q of portsInDrawing) {
    const along = q.edge === 'right' ? toCase(0, q.c)[1] : toCase(q.c, 0)[0];
    const at = (u, z) => q.edge === 'right' ? solid(wallMid.right.x, u, z) : solid(u, wallMid.front.y, z);
    const zLo = F.zBoardTop + 0.4, zHi = F.zBoardTop + q.z - 0.4;
    const inner = [along - q.w / 2 + 0.3, along, along + q.w / 2 - 0.3];
    const bodyClear = inner.every(u => !at(u, zLo) && !at(u, zHi));
    check(`${label}: ${q.name} passes the wall (centre ${q.c} mm on the ${q.edge})`, bodyClear);
    const flankSolid = at(along - q.w / 2 - 2.5, (zLo + zHi) / 2) && at(along + q.w / 2 + 2.5, (zLo + zHi) / 2);
    check(`${label}: wall stands either side of the ${q.name}`, flankSolid);
    // 6 mm above the body: plug-sized cutouts (USB-C, micro HDMI) run up to
    // 5 mm taller than the receptacle so the plug's overmould can enter.
    if (F.zBoardTop + q.z + 6 < F.wallTop - 1) {
      check(`${label}: wall bridges over the ${q.name}`, at(along, F.zBoardTop + q.z + 6));
    }
  }
  return { solid, F };
}

{
  const p3 = presetNamed('Pi 3 B+');
  const { solid, F } = checkBoard('Pi 3 B+', p3, PI3_PORTS);
  // The micro SD card lives on the UNDERSIDE of the board and pokes out of the
  // left end, so its slot has to be cut below the board's top surface — which
  // is why a port entry can carry a fifth field.
  const y = toCase(0, 28)[1], x = -(F.outW / 2 - p3.wallT / 2);
  check('Pi 3 B+: SD card slot is open under the board', !solid(x, y, F.zBoard - 1) && !solid(x, y - 5, F.zBoard - 1));
  check('Pi 3 B+: SD slot does not reach the floor', solid(x, y, p3.floorT + 0.3));
}
{
  const p4 = presetNamed('Pi 4');
  checkBoard('Pi 4', p4, PI4_PORTS);
}
{
  const pz = presetNamed('Pi Zero');
  const { solid, F } = checkBoard('Pi Zero', pz, PIZERO_PORTS, PI_ZERO);
  // The Zero's SD slot is on TOP of the board at the left end, centred 16.9 mm
  // from the bottom edge, so its cutout starts at the board top like any other.
  const y = toCaseOf(PI_ZERO)(0, 16.9)[1], x = -(F.outW / 2 - pz.wallT / 2);
  check('Pi Zero: SD card slot is open at the left end', !solid(x, y, F.zBoardTop + 0.5) && !solid(x, y + 4, F.zBoardTop + 0.5));
  check('Pi Zero: the SD slot does not reach under the board', solid(x, y, F.zBoard - 0.5));
}

// Choosing a board from the Board menu has to bring the same bundle the
// board's preset does — that is the whole point of the menu carrying values.
{
  const board = gen.params.find(q => q.key === 'board');
  check('board param carries values', typeof board.carries === 'function');
  const D = defaults(gen);
  for (const [v, presetFrag] of [['pi4', 'Pi 4'], ['pi3bplus', 'Pi 3 B+'], ['pizero', 'Pi Zero'], ['esp32', 'ESP32']]) {
    const carried = board.carries(v, { ...D, board: v });
    const preset = presetNamed(presetFrag);
    const keys = ['ports', 'tallest', 'clearAbove', 'lidStyle'];
    check(`board=${v} carries ${keys.join('/')}`, keys.every(k => k in carried));
    check(`board=${v} carries what its preset sets`, keys.every(k => carried[k] === preset[k]),
      keys.map(k => `${k}: ${JSON.stringify(carried[k])} vs ${JSON.stringify(preset[k])}`).join('; '));
  }
  check('board=custom carries nothing', Object.keys(board.carries('custom', { ...D, board: 'custom' })).length === 0);
  const pi5 = board.carries('pi5', { ...D, board: 'pi5' });
  check('board=pi5 carries an empty port list rather than the Pi 4\'s', pi5.ports === '' && pi5.lidStyle === 'friction');
  // A board's carried ports must be exactly what its preset uses — one source.
  check('the Pi 4 preset text is the board table\'s', presetNamed('Pi 4').ports === presetPorts('pi4'));
}

// The friction lid is a press fit — 0.10 mm per side measured on the printed
// Pi 3 B+ case on 2026-09-15 (the 0.25 "slide" default rattled) — and every
// friction preset, the parameter default and the print note all say so.
{
  const lidFit = gen.params.find(q => q.key === 'lidFit');
  check('lidFit defaults to the press fit', lidFit.def === FIT.press && FIT.press === 0.10, String(lidFit.def));
  for (const pr of gen.presets.filter(p => p.values.lidStyle === 'friction')) {
    check(`${pr.name}: friction preset uses the press fit`, pr.values.lidFit === FIT.press, String(pr.values.lidFit));
  }
  const notes = gen.hints(presetNamed('Pi 3 B+'), ctx('normal')).notes.join(' ');
  check('the print note says the lip clearance was measured', /measured on/.test(notes) && /0\.10 mm/.test(notes), notes.slice(0, 200));
}

// The fifth field: how far below the board's top the cutout floor sits.
{
  const one = parsePorts('left:0:16:4.5:4.1');
  check('parsePorts: five fields parse', one.length === 1 && one[0].drop === 4.1);
  const four = parsePorts('right:19:15.5:17.5');
  check('parsePorts: four fields still parse, drop defaults to 0', four.length === 1 && four[0].drop === 0);
  check('parsePorts: a sixth field is rejected', parsePorts('right:1:2:3:4:5').length === 0);
  check('parsePorts: a non-numeric drop is rejected', parsePorts('right:1:8:8:x').length === 0);
}

// validate() names the two collisions the presets had to be designed around.
{
  const p3 = presetNamed('Pi 3 B+');
  const screwed = gen.validate({ ...p3, lidStyle: 'screw' });
  check('validate: screw posts inside the board footprint are an error',
    screwed.some(i => i.severity === 'error' && /post/i.test(i.message) && /board/i.test(i.message)));
  const clean = gen.validate(p3);
  check(`validate: the Pi 3 B+ preset itself is clean (${clean.map(i => i.message).join(' | ')})`, clean.length === 0);
  const lowLid = gen.validate({ ...p3, clearAbove: 17 });
  check('validate: a friction lip landing in a port cutout is flagged',
    lowLid.some(i => /lip/i.test(i.message) && /cutout|port/i.test(i.message)));
}

done();
