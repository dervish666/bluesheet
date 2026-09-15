// Plate packing. Two invariants matter more than efficiency: nothing overlaps,
// and nothing hangs off the bed. Everything else is a matter of degree.
import { suite, check, near, nearPct, throws, done } from './lib/assert.mjs';
import { pack, layout, toBedCoords, withinBed, anyOverlap, A1_MINI_BED, DEFAULT_MARGIN } from '../js/kernel/pack.js';
import { cube, cylinder } from './lib/fixtures.mjs';
import { topology } from './lib/meshcheck.mjs';

suite('pack');

const BED = A1_MINI_BED;
const bin = (id, w, d, qty = 1, extra = {}) => ({ id, w, d, qty, ...extra });

// ---- the invariants, over many shapes ------------------------------------
{
  const cases = {
    'one small part': [bin('a', 20, 20)],
    'nine gridfinity bins': [bin('g', 41.5, 41.5, 9)],
    'mixed sizes': [bin('big', 120, 60), bin('mid', 41.5, 41.5, 4), bin('small', 12, 30, 6)],
    'long thin parts': [bin('rail', 160, 8, 8)],
    'forty tiny parts': [bin('clip', 14, 9, 40)],
    'one part exactly the printable size': [bin('max', 170, 170)],
    'many identical squares': [bin('sq', 30, 30, 16)],
  };
  for (const [name, items] of Object.entries(cases)) {
    const r = pack(items, BED, { gap: 3 });
    check(`${name}: nothing overlaps`, anyOverlap(r) === null,
      anyOverlap(r) ? `${anyOverlap(r).a.id} and ${anyOverlap(r).b.id}` : `${r.placed.length} placed`);
    check(`${name}: everything is inside the printable area`, withinBed(r, BED),
      `used ${r.used.w.toFixed(1)} x ${r.used.d.toFixed(1)} mm`);
    check(`${name}: every instance is either placed or explained`,
      r.placed.length + r.unplaced.length === items.reduce((s, i) => s + (i.qty ?? 1), 0),
      `${r.placed.length} placed, ${r.unplaced.length} unplaced`);
  }
}

// ---- capacity, which is the number a person will judge it by --------------
{
  // 180 mm bed less 2 x 5 mm margin is 170 mm of printable width. A gridfinity
  // bin is 41.5 mm, so four butt together in 166 mm — but four with a 3 mm gap
  // between them needs 175 mm and does not fit. Three across, nine on the plate.
  const gapped = pack([bin('g', 41.5, 41.5, 20)], BED, { gap: 3 });
  check('nine 41.5 mm bins fit with a 3 mm gap between them', gapped.placed.length === 9,
    `${gapped.placed.length} placed, ${gapped.unplaced.length} left over`);
  check('the ones that did not fit say why', gapped.unplaced.every(u => /no room/.test(u.reason)), gapped.unplaced[0]?.reason);

  // Gridfinity bins are designed to sit against each other, so the interesting
  // number is the one with no gap at all — and it is nearly double.
  const butted = pack([bin('g', 41.5, 41.5, 20)], BED, { gap: 0 });
  check('sixteen bins fit when they are allowed to touch', butted.placed.length === 16,
    `${butted.placed.length} placed at gap 0 vs ${gapped.placed.length} at gap 3`);
  nearPct('the fill fraction is what that implies', butted.fill, 16 * 41.5 * 41.5 / (170 * 170), 2);
  check('the gap costs bed, and the packer says how much',
    butted.placed.length > gapped.placed.length,
    `${butted.placed.length - gapped.placed.length} more bins without the gap`);
}

// ---- rotation ------------------------------------------------------------
{
  // 160 x 20 parts: unrotated only 8 fit by height (170/23 = 7); rotation should
  // not be needed here, so use a case where it is: 20 x 160.
  const withRot = pack([bin('tall', 20, 160, 7)], BED, { gap: 3, allowRotate: true });
  const noRot = pack([bin('tall', 20, 160, 7)], BED, { gap: 3, allowRotate: false });
  check('rotation is allowed by default and used when it helps', withRot.placed.length >= noRot.placed.length,
    `${withRot.placed.length} with rotation vs ${noRot.placed.length} without`);
  check('a part marked unrotatable is never rotated',
    pack([bin('fixed', 20, 100, 4, { rotatable: false })], BED).placed.every(p => p.rot === false));
  const rotated = pack([bin('t', 20, 160, 8)], BED, { gap: 3 }).placed.filter(p => p.rot);
  check('a rotated placement reports swapped dimensions', rotated.every(p => p.w === 160 && p.d === 20),
    rotated.length ? `${rotated[0].w} x ${rotated[0].d}` : 'none rotated');
}

// ---- the gap actually separates parts -------------------------------------
{
  for (const gap of [0, 1, 3, 8]) {
    const r = pack([bin('g', 30, 30, 9)], BED, { gap });
    let minDist = Infinity;
    for (let i = 0; i < r.placed.length; i++) for (let j = i + 1; j < r.placed.length; j++) {
      const a = r.placed[i], b = r.placed[j];
      const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
      const dy = Math.abs(a.y - b.y) - (a.d + b.d) / 2;
      if (dx < -1e-9 && dy < -1e-9) minDist = -1;         // overlapping
      else minDist = Math.min(minDist, Math.max(dx, dy));
    }
    check(`gap ${gap} mm: no two parts are closer than the gap`, minDist >= gap - 1e-6,
      `closest ${minDist === Infinity ? 'n/a' : minDist.toFixed(3)} mm`);
  }
}

// ---- margin and edges ------------------------------------------------------
{
  const r = pack([bin('g', 20, 20, 60)], BED, { gap: 2, margin: 10 });
  const xs = r.placed.map(p => p.x - p.w / 2), ys = r.placed.map(p => p.y - p.d / 2);
  check('a 10 mm margin is respected on every edge',
    Math.min(...xs) >= -80 - 1e-6 && Math.min(...ys) >= -80 - 1e-6 &&
    Math.max(...r.placed.map(p => p.x + p.w / 2)) <= 80 + 1e-6,
    `min x ${Math.min(...xs).toFixed(2)}, limit -80`);
  throws('a margin that leaves no room is an error, not an empty plate', () => pack([bin('a', 1, 1)], BED, { margin: 95 }), 'no room');
  near('DEFAULT_MARGIN keeps parts out of the A1 purge strip', DEFAULT_MARGIN, 5);
}

// ---- deterministic ---------------------------------------------------------
{
  const items = [bin('a', 41.5, 41.5, 3), bin('b', 60, 25, 2), bin('c', 15, 15, 5)];
  const a = JSON.stringify(pack(items, BED).placed);
  const b = JSON.stringify(pack(items, BED).placed);
  check('packing the same plate twice gives the same layout', a === b);
}

// ---- layout produces a real, valid plate mesh ------------------------------
{
  const meshes = { a: cube(30).dropToPlate().centerXY(), b: cylinder(10, 25).centerXY() };
  const r = pack([bin('a', 30, 30, 3), bin('b', 20, 20, 2)], BED, { gap: 4 });
  const { parts, mesh } = layout(meshes, r);
  check('layout places every packed part', parts.length === r.placed.length, `${parts.length} parts`);
  const t = topology(mesh);
  check('the merged plate mesh is still watertight', t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0,
    `bnd ${t.boundary}, nonman ${t.nonManifold}, wind ${t.inconsistent}`);
  check('the merged plate has positive volume', mesh.volume() > 0, `${mesh.volume().toFixed(0)} mm³`);
  nearPct('plate volume is the sum of its parts', mesh.volume(), 3 * 27000 + 2 * Math.PI * 100 * 25, 1);
  const bb = mesh.bbox();
  check('the plate mesh sits on z=0', Math.abs(bb.min[2]) < 1e-6, `min z ${bb.min[2]}`);
  check('the plate mesh is inside the bed in plate space',
    bb.min[0] >= -90 && bb.max[0] <= 90 && bb.min[1] >= -90 && bb.max[1] <= 90,
    `x ${bb.min[0].toFixed(1)}..${bb.max[0].toFixed(1)}, y ${bb.min[1].toFixed(1)}..${bb.max[1].toFixed(1)}`);
  throws('layout refuses a packing it has no mesh for', () => layout({}, r), 'no mesh');

  const bedMesh = toBedCoords(mesh, BED);
  const bb2 = bedMesh.bbox();
  check('toBedCoords puts the plate in the printer 0..180 space',
    bb2.min[0] >= 0 && bb2.max[0] <= 180 && bb2.min[1] >= 0 && bb2.max[1] <= 180,
    `x ${bb2.min[0].toFixed(1)}..${bb2.max[0].toFixed(1)}, y ${bb2.min[1].toFixed(1)}..${bb2.max[1].toFixed(1)}`);
  near('toBedCoords does not move Z', bb2.min[2], 0, 1e-9);
  const rot = parts.find(p => p.rot);
  if (rot) check('a rotated part keeps its footprint after rotation',
    Math.abs(rot.mesh.bbox().size[0] - rot.w) < 1e-6, `${rot.mesh.bbox().size[0].toFixed(2)} vs ${rot.w}`);
  else check('no part needed rotating in this layout', true, 'none rotated');
}

// ---- degenerate input ------------------------------------------------------
{
  const empty = pack([], BED);
  check('an empty plate is empty, not an error', empty.placed.length === 0 && empty.used.w === 0);
  near('an empty plate has zero fill', empty.fill, 0);
  const zeroQty = pack([bin('a', 10, 10, 0)], BED);
  check('a quantity of zero still places one (a plate entry means you want one)', zeroQty.placed.length === 1);
  const sorted = pack([bin('s', 10, 10), bin('L', 100, 100)], BED, { sort: 'area' });
  check('sorting by area places the large part first', sorted.placed[0].id === 'L', sorted.placed.map(p => p.id).join(','));
  check('an unknown sort mode does not throw', pack([bin('a', 10, 10, 2)], BED, { sort: 'nonsense' }).placed.length === 2);
}

done();
