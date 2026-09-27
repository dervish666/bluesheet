// Tests for js/kernel/poly2d.js — the 2D layer.
//
// Structure: fundamentals, then the three hard algorithms (triangulate,
// boolean, offset) checked against areas computed analytically rather than
// against the module's own output, then the constructors, then a seeded fuzz
// run. Areas are the workhorse assertion throughout: a triangulation that drops
// an ear, a boolean that keeps a stale hole and an offset that returns an
// inverted ring all show up as an area that is wrong by a specific, meaningful
// amount.
import { suite, check, near, nearPct, nearVec, throws, done } from './lib/assert.mjs';
import {
  TAU, signedArea, area, isCCW, ensureCCW, ensureCW, reverse,
  bounds, centroid, perimeter, pointInRing, pointInShape, shapeArea, asShape,
  triangulate, offset, boolean, union, difference, intersection,
  resample, simplify, transformRing,
  rect, roundRect, circle, ellipse, regularPolygon, star, slot, roundedPath,
  superformula, SUPERFORMULA_PRESETS, chamferRect, dogboneRect, arcRing,
} from '../js/kernel/poly2d.js';

suite('poly2d');

const SQ = [[0, 0], [10, 0], [10, 10], [0, 10]];                 // CCW unit-ish square
const totalArea = (shapes) => shapes.reduce((t, s) => t + shapeArea(s), 0);
const allFinite = (shapes) => shapes.every(s => s.every(r => r.every(p => isFinite(p[0]) && isFinite(p[1]))));

// ---------------------------------------------------------------------------
console.log('\n-- ring fundamentals --');

near('signedArea CCW square', signedArea(SQ), 100);
near('signedArea CW square is negative', signedArea(reverse(SQ)), -100);
near('area is unsigned', area(reverse(SQ)), 100);
check('isCCW agrees with the sign', isCCW(SQ) === true && isCCW(reverse(SQ)) === false);
near('signedArea is translation-stable at 900 mm', signedArea(SQ.map(p => [p[0] + 900, p[1] + 900])), 100, 1e-9);
near('degenerate ring has zero area', signedArea([[0, 0], [1, 1], [2, 2]]), 0);
check('two-point ring has no area', signedArea([[0, 0], [1, 1]]) === 0);

check('ensureCCW leaves a CCW ring alone', isCCW(ensureCCW(SQ)));
check('ensureCCW flips a CW ring', isCCW(ensureCCW(reverse(SQ))));
check('ensureCW flips a CCW ring', !isCCW(ensureCW(SQ)));
check('ensureCCW copies rather than aliases', ensureCCW(SQ)[0] !== SQ[0]);
check('reverse does not mutate its input', (() => { const r = reverse(SQ); r[0][0] = 999; return SQ[0][0] === 0; })());

nearVec('bounds of a ring', [...bounds(SQ).min, ...bounds(SQ).max], [0, 0, 10, 10]);
nearVec('bounds size and centre', [...bounds(SQ).size, ...bounds(SQ).center], [10, 10, 5, 5]);
nearVec('bounds accepts a shape[]', [...bounds([[SQ], [rect(4, 4, { cx: 20, cy: 0 })]]).max], [22, 10]);
nearVec('centroid of a square', centroid(SQ), [5, 5]);
nearVec('centroid of a triangle', centroid([[0, 0], [9, 0], [0, 9]]), [3, 3]);
nearVec('centroid falls back to the vertex mean when there is no area', centroid([[0, 0], [4, 0]]), [2, 0]);
near('perimeter of a square', perimeter(SQ), 40);
near('perimeter of a 3-4-5 triangle', perimeter([[0, 0], [3, 0], [0, 4]]), 12);

check('pointInRing: inside', pointInRing([5, 5], SQ));
check('pointInRing: outside', !pointInRing([15, 5], SQ));
check('pointInRing: on an edge counts as in', pointInRing([10, 5], SQ));
check('pointInRing: on a vertex counts as in', pointInRing([0, 0], SQ));
check('pointInRing: a vertex-height ray does not double count', !pointInRing([-1, 10], SQ));
check('pointInShape: inside the solid part', pointInShape([1, 5], [SQ, reverse([[3, 3], [7, 3], [7, 7], [3, 7]])]));
check('pointInShape: inside a hole is not in the shape', !pointInShape([5, 5], [SQ, reverse([[3, 3], [7, 3], [7, 7], [3, 7]])]));
near('shapeArea subtracts holes', shapeArea([SQ, reverse([[3, 3], [7, 3], [7, 7], [3, 7]])]), 84);
near('shapeArea ignores input orientation', shapeArea([reverse(SQ), [[3, 3], [7, 3], [7, 7], [3, 7]]]), 84);
check('asShape promotes a bare ring', asShape(SQ).length === 1 && asShape(SQ)[0] === SQ);
check('asShape passes a shape through', asShape([SQ, [[1, 1], [2, 1], [1, 2]]]).length === 2);
near('TAU is a full turn', TAU, Math.PI * 2);

const resampled = resample(SQ, 2.5);
check('resample: every edge is within the limit', (() => {
  for (let i = 0; i < resampled.length; i++) {
    const a = resampled[i], b = resampled[(i + 1) % resampled.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 2.5 + 1e-9) return false;
  }
  return true;
})(), `${resampled.length} points`);
near('resample preserves area', signedArea(resampled), 100, 1e-9);
check('resample keeps the original vertices', SQ.every(p => resampled.some(q => q[0] === p[0] && q[1] === p[1])));
check('resample with a nonsense length is a no-op copy', resample(SQ, 0).length === 4);

const noisy = [[0, 0], [5, 0.02], [10, 0], [10, 10], [5, 9.99], [0, 10]];
check('simplify drops points inside the tolerance', simplify(noisy, 0.1).length === 4, `${simplify(noisy, 0.1).length} points`);
check('simplify keeps points outside the tolerance', simplify(noisy, 0.001).length === 6);
check('simplify returns [] when the ring collapses', simplify([[0, 0], [10, 0], [10, 0.001], [0, 0.001]], 1).length === 0);
near('simplify preserves area within tolerance', area(simplify(noisy, 0.1)), 100, 1);

nearVec('transformRing translates', transformRing(SQ, { tx: 5, ty: -2 })[0], [5, -2]);
near('transformRing scales area by sx*sy', area(transformRing(SQ, { sx: 2, sy: 3 })), 600);
nearVec('transformRing rotates a quarter turn', transformRing([[1, 0]], { rot: Math.PI / 2 })[0], [0, 1]);
check('transformRing preserves winding through a mirror', isCCW(transformRing(SQ, { sx: -1 })));

// ---------------------------------------------------------------------------
console.log('\n-- triangulation (G4) --');

/** Sum of signed triangle areas, and whether every triangle sits in the shape. */
function triAudit(shape) {
  const { points, tris } = triangulate(shape);
  let sum = 0, outside = 0, flipped = 0, badIndex = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t], ib = tris[t + 1], ic = tris[t + 2];
    if (ia >= points.length || ib >= points.length || ic >= points.length) { badIndex++; continue; }
    const a = points[ia], b = points[ib], c = points[ic];
    const s = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    sum += s;
    if (s <= 0) flipped++;
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    if (!pointInShape(cen, shape)) outside++;
  }
  return { sum, outside, flipped, badIndex, count: tris.length / 3 };
}

const holeIn = (ring) => reverse(ring);
const CASES = [
  ['square', [SQ]],
  ['concave L', [[[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]]]],
  ['5-point star', [star(5, 20, 8)]],
  ['square with one hole', [SQ, holeIn([[3, 3], [7, 3], [7, 7], [3, 7]])]],
  ['L with two holes', [[[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]],
                        holeIn([[1, 1], [3, 1], [3, 3], [1, 3]]), holeIn([[10, 1], [14, 1], [14, 4], [10, 4]])]],
  ['hole touching the outer ring at a point', [SQ, holeIn([[0, 0], [7, 3], [3, 7]])]],
  ['collinear runs', [[[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]]],
  ['CW outer ring given by mistake', [reverse(SQ)]],
  ['disc with an off-centre hole', [circle(20, { segs: 96 }), holeIn(circle(5, { segs: 48, cx: 8 }))]],
  ['2000-vertex superformula', [superformula({ preset: 'flower6', r: 40, segs: 2000 })]],
];
for (const [name, shape] of CASES) {
  const a = triAudit(shape);
  near(`triangulate ${name}: area is exact`, a.sum, shapeArea(shape), 1e-9);
  check(`triangulate ${name}: no triangle outside the shape`, a.outside === 0, `${a.outside} of ${a.count} outside`);
  check(`triangulate ${name}: all triangles CCW and non-degenerate`, a.flipped === 0 && a.badIndex === 0,
        `${a.flipped} flipped, ${a.badIndex} bad indices`);
}
check('triangulate of an empty shape is empty', triangulate([]).tris.length === 0);
check('triangulate of a 2-point ring is empty', triangulate([[[0, 0], [1, 1]]]).tris.length === 0);
check('triangulate is deterministic', JSON.stringify(triangulate([SQ])) === JSON.stringify(triangulate([SQ])));
const bigT = Date.now(), bigTri = triangulate([superformula({ preset: 'flower6', r: 40, segs: 2000 })]);
check('triangulate 2000 vertices in under 500 ms', Date.now() - bigT < 500, `${Date.now() - bigT} ms, ${bigTri.tris.length / 3} triangles`);

// ---------------------------------------------------------------------------
console.log('\n-- booleans (G5) --');

const A10 = rect(10, 10);
const B10 = rect(10, 10, { cx: 5 });
near('union of two half-overlapping squares', totalArea(union([A10], [B10])), 150, 1e-9);
near('intersection of two half-overlapping squares', totalArea(intersection([A10], [B10])), 50, 1e-9);
near('difference of two half-overlapping squares', totalArea(difference([A10], [B10])), 50, 1e-9);
near('xor of two half-overlapping squares', totalArea(boolean([A10], [B10], 'xor')), 100, 1e-9);

// Overlapping circles: the analytic lens area, against polygons fine enough
// that discretisation is smaller than the tolerance.
const C1 = circle(10, { segs: 720 }), C2 = circle(10, { segs: 720, cx: 10 });
const lens = 2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(300);
nearPct('overlapping circles: intersection is the analytic lens', totalArea(intersection([C1], [C2])), lens, 0.05);
nearPct('overlapping circles: union is 2πr² minus the lens', totalArea(union([C1], [C2])), 2 * area(C1) - lens, 0.05);
nearPct('overlapping circles: difference is πr² minus the lens', totalArea(difference([C1], [C2])), area(C1) - lens, 0.05);
check('overlapping circles: union is one island with no holes',
      union([C1], [C2]).length === 1 && union([C1], [C2])[0].length === 1);

const split = difference([rect(30, 10)], [rect(6, 20)]);
check('rectangle minus a bar gives two islands', split.length === 2, `${split.length} islands`);
near('...with the right total area', totalArea(split), 240, 1e-9);
check('...each island is CCW', split.every(s => isCCW(s[0])));

const holed = difference([rect(20, 20)], [rect(6, 6)]);
check('difference that creates a hole: one island, two rings', holed.length === 1 && holed[0].length === 2);
near('...with the right area', totalArea(holed), 364, 1e-9);
check('...hole is wound clockwise', signedArea(holed[0][1]) < 0);

check('intersection of disjoint shapes is empty', intersection([rect(4, 4, { cx: -20 })], [rect(4, 4, { cx: 20 })]).length === 0);
check('intersection that only touches at an edge is empty',
      totalArea(intersection([rect(10, 10)], [rect(10, 10, { cx: 10 })])) < 1e-9);
near('union of edge-touching squares is one 20x10', totalArea(union([rect(10, 10)], [rect(10, 10, { cx: 10 })])), 200, 1e-9);
check('difference of identical shapes is empty', difference([A10], [A10]).length === 0);
near('union of identical shapes is the shape', totalArea(union([A10], [A10])), 100, 1e-9);
check('xor of identical shapes is empty', boolean([A10], [A10], 'xor').length === 0);

// Self-touching input: a bowtie-free ring that pinches to a point, and a shape
// whose hole touches its outer wall.
const pinch = [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]];
near('self-touching (pinched) input keeps its area through a union', totalArea(union([pinch], [rect(1, 1, { cx: -5 })])), area(pinch) + 1, 1e-9);
const touching = [SQ, holeIn([[0, 0], [6, 2], [2, 6]])];
nearPct('shape with a hole touching the outer ring survives a difference',
        totalArea(difference([touching], [rect(2, 2, { cx: 9, cy: 9 })])), shapeArea(touching) - 4, 0.001);

near('difference with a vertex of one polygon exactly on an edge of the other',
     totalArea(difference([rect(10, 10, { cx: 5, cy: 5 })], [[[0, 0], [10, 0], [5, 10]]])), 50, 1e-9);
// An annulus clipped to the band |y| <= 10: analytically the disc-band slice
// 2(h√(R²−h²) + R²·asin(h/R)) less the inner disc, which sits wholly inside.
const bandSlice = 2 * (10 * Math.sqrt(400 - 100) + 400 * Math.asin(0.5)) - Math.PI * 100;
nearPct('boolean over a shape with a hole matches the analytic slice',
        totalArea(intersection([[circle(20, { segs: 720 }), holeIn(circle(10, { segs: 720 }))]], [rect(60, 20)])),
        bandSlice, 0.1);
// Pinch points: two boundaries crossing at exactly one point put four result
// edges on one vertex, and picking the wrong one there traces a contour that
// crosses itself and reports half the area.
const xorCross = boolean([rect(20, 4)], [rect(4, 20)], 'xor');
near('xor of two crossing rectangles has the right area', totalArea(xorCross), 80 + 80 - 2 * 16, 1e-9);
check('...and comes out as four separate arms', xorCross.length === 4, `${xorCross.length} islands`);
check('...each wound counter-clockwise', xorCross.every(s => signedArea(s[0]) > 0));
near('union of the same cross', totalArea(union([rect(20, 4)], [rect(4, 20)])), 144, 1e-9);
near('xor of a shape wholly containing another leaves a hole',
     totalArea(boolean([rect(20, 10)], [rect(4, 8)], 'xor')), 200 - 32, 1e-9);
check('...as one island with two rings', boolean([rect(20, 10)], [rect(4, 8)], 'xor')[0].length === 2);
near('union of corner-touching squares keeps both',
     totalArea(union([rect(10, 10)], [rect(10, 10, { cx: 10, cy: 10 })])), 200, 1e-9);
throws('boolean rejects an unknown op', () => boolean([A10], [B10], 'squish'), 'unknown op');
check('boolean accepts a bare ring on either side', totalArea(union(A10, B10)) > 149.9);
check('boolean is deterministic', JSON.stringify(union([C1], [C2])) === JSON.stringify(union([C1], [C2])));
check('boolean output is finite', allFinite(union([C1], [C2])));

// ---------------------------------------------------------------------------
console.log('\n-- offset (G6) --');

const disc = circle(10, { segs: 512 });
for (const d of [0.5, 2, 5]) {
  nearPct(`circle offset +${d} has area π(r+d)²`, totalArea(offset([disc], d, { arcTolerance: 0.005 })), Math.PI * (10 + d) ** 2, 0.5);
}
for (const d of [1, 3, 7]) {
  nearPct(`circle offset -${d} has area π(r-d)²`, totalArea(offset([disc], -d, { arcTolerance: 0.005 })), Math.PI * (10 - d) ** 2, 0.5);
}
check('circle offset by 0 is the shape back, orientation-normalised',
      Math.abs(totalArea(offset([reverse(disc)], 0)) - area(disc)) < 1e-9 && isCCW(offset([disc], 0)[0][0]));

// A rectangle grown outward gains a band: perimeter × d plus the corner joins.
const R2010 = rect(20, 10);
near('rectangle +2 with miter joins gains the full corner squares',
     totalArea(offset([R2010], 2, { join: 'miter' })), 24 * 14, 1e-6);
nearPct('rectangle +2 with round joins gains perimeter·d + πd²',
        totalArea(offset([R2010], 2, { arcTolerance: 0.0005 })), 200 + perimeter(R2010) * 2 + Math.PI * 4, 0.05);
check('rectangle +2 with square joins lies between bevel and miter', (() => {
  const sq = totalArea(offset([R2010], 2, { join: 'square' }));
  const bev = totalArea(offset([R2010], 2, { join: 'bevel' }));
  const mit = totalArea(offset([R2010], 2, { join: 'miter' }));
  return bev < sq && sq < mit;
})(), `bevel ${totalArea(offset([R2010], 2, { join: 'bevel' })).toFixed(2)} < square ${totalArea(offset([R2010], 2, { join: 'square' })).toFixed(2)} < miter ${totalArea(offset([R2010], 2, { join: 'miter' })).toFixed(2)}`);
near('rectangle -3 shrinks to 14 × 4', totalArea(offset([R2010], -3, { join: 'miter' })), 14 * 4, 1e-6);
nearVec('rectangle -3 has the right bounds', [...bounds(offset([R2010], -3, { join: 'miter' })).size], [14, 4], 1e-6);

check('inward offset that annihilates the shape returns []', offset([rect(10, 10)], -5).length === 0);
check('inward offset past annihilation returns []', offset([rect(10, 10)], -50).length === 0);
check('inward offset of a circle past its radius returns []', offset([disc], -11).length === 0);
check('an over-shrunk circle does not come back as a phantom disc', offset([disc], -10.5).length === 0);
check('an offset just short of annihilation still returns a sliver', (() => {
  const o = offset([rect(10, 10)], -4.999, { join: 'miter' });
  return o.length === 1 && Math.abs(totalArea(o) - 0.002 * 0.002) < 1e-9;
})(), `area ${totalArea(offset([rect(10, 10)], -4.999, { join: 'miter' })).toExponential(3)}`);
check('offset never returns an inverted outer ring', (() => {
  for (let d = -6; d <= 6; d += 0.37) {
    for (const s of offset([[[0, 0], [12, 0], [12, 10], [9, 10], [9, 3], [3, 3], [3, 10], [0, 10]]], d)) {
      if (signedArea(s[0]) <= 0) return false;
      for (let i = 1; i < s.length; i++) if (signedArea(s[i]) >= 0) return false;
    }
  }
  return true;
})());
{
  // A frame with an island in its hole: a comic panel with a figure in it. The
  // hole's probe point used to be the centroid of its largest ear, which lands
  // on the island, so the island's material voted the whole hole shut and the
  // frame came back filled solid. Exact answer, miter joins: outer 41², hole
  // 35², island 17².
  const frame = [rect(40, 40), reverse(rect(36, 36))];
  const island = [rect(16, 16)];
  const o = offset([frame, island], 0.5, { join: 'miter' });
  near('an island in a hole does not fill the hole (frame + island grown 0.5)',
    totalArea(o), 41 * 41 - 35 * 35 + 17 * 17, 1e-6);
}

// A U whose arms merge, and the same U eroded until it dies. Rectilinear, so
// the mitered areas are exact: A ± P·d + d²(convex − reflex).
const U = [[0, 0], [12, 0], [12, 10], [9, 10], [9, 3], [3, 3], [3, 10], [0, 10]];
// Tolerance is 1e-6, not 1e-9: the sweep snaps its input to a ~1e-9 relative
// grid, so an area assertion inherits perimeter × half-a-grid of slack. The
// formula itself is exact.
near('U outward +1.6 (mitered, exact)', totalArea(offset([U], 1.6, { join: 'miter' })), 78 + perimeter(U) * 1.6 + 1.6 ** 2 * 4, 1e-6);
near('U inward -1.4 (mitered, exact)', totalArea(offset([U], -1.4, { join: 'miter' })), 78 - perimeter(U) * 1.4 + 1.4 ** 2 * 4, 1e-6);
check('U inward -1.6 collapses to nothing', offset([U], -1.6, { join: 'miter' }).length === 0);
check('U outward +3 has closed the slot', offset([U], 3, { join: 'miter' })[0].length === 1);

const washer = [circle(20, { segs: 360 }), reverse(circle(10, { segs: 360 }))];
nearPct('washer -1 shrinks the disc and grows the hole', totalArea(offset([washer], -1, { arcTolerance: 0.002 })), Math.PI * (19 ** 2 - 11 ** 2), 0.5);
nearPct('washer +5 grows the disc and shrinks the hole', totalArea(offset([washer], 5, { arcTolerance: 0.002 })), Math.PI * (25 ** 2 - 5 ** 2), 0.5);
check('washer +11 closes the hole entirely', offset([washer], 11, { arcTolerance: 0.002 })[0].length === 1);
check('two shapes that grow into each other merge into one',
      offset([[rect(10, 10, { cx: -6 })], [rect(10, 10, { cx: 6 })]], 1.5, { join: 'miter' }).length === 1);
near('...with the union area, not the sum', totalArea(offset([[rect(10, 10, { cx: -6 })], [rect(10, 10, { cx: 6 })]], 1.5, { join: 'miter' })), 2 * 169 - 13, 1e-6);
check('offset accepts a bare ring', offset(rect(10, 10), 1, { join: 'miter' }).length === 1);
check('offset of an empty input is empty', offset([], 1).length === 0);
check('offset output is finite', allFinite(offset([U], 2)));
check('offset is deterministic', JSON.stringify(offset([U], 2)) === JSON.stringify(offset([U], 2)));
check('a tighter arcTolerance uses more points',
      offset([disc], 3, { arcTolerance: 0.5 })[0][0].length <= offset([disc], 3, { arcTolerance: 0.001 })[0][0].length);
check('miterLimit falls back to a bevel on a sharp spike', (() => {
  const spike = [[0, 0], [20, 0], [10, 0.6]];
  const tight = totalArea(offset([spike], 1, { join: 'miter', miterLimit: 1.2 }));
  const loose = totalArea(offset([spike], 1, { join: 'miter', miterLimit: 40 }));
  return tight < loose;
})());
throws('offset rejects an unknown join', () => offset([SQ], 1, { join: 'wobbly' }), 'unknown join');
throws('offset rejects a non-finite delta', () => offset([SQ], NaN), 'finite');
throws('offset rejects a zero arcTolerance', () => offset([SQ], 1, { arcTolerance: 0 }), 'arcTolerance');
throws('offset rejects a miterLimit below 1', () => offset([SQ], 1, { miterLimit: 0.2 }), 'miterLimit');

// ---------------------------------------------------------------------------
console.log('\n-- ring constructors --');

near('rect area', area(rect(20, 10)), 200);
check('rect is CCW and centred', isCCW(rect(20, 10)) && Math.abs(bounds(rect(20, 10)).center[0]) < 1e-12);
nearVec('rect honours cx/cy', bounds(rect(20, 10, { cx: 5, cy: -3 })).center, [5, -3]);
nearPct('roundRect area is w·h − (4−π)r²', area(roundRect(20, 10, 3, { segs: 128 })), 200 - (4 - Math.PI) * 9, 0.05);
check('roundRect clamps r to half the short side', Math.abs(area(roundRect(20, 10, 99, { segs: 128 })) - area(slot(20, 5, { segs: 256 }))) < 0.1);
check('roundRect with r=0 is a rect', roundRect(20, 10, 0).length === 4);
nearPct('circle area', area(circle(10, { segs: 1024 })), Math.PI * 100, 0.01);
check('circle segs are honoured', circle(10, { segs: 17 }).length === 17);
nearPct('ellipse area is π·rx·ry', area(ellipse(10, 5, { segs: 1024 })), Math.PI * 50, 0.01);
near('regularPolygon hexagon area', area(regularPolygon(6, 10)), 6 * 0.5 * 100 * Math.sin(TAU / 6), 1e-9);
check('regularPolygon rot turns the first vertex', Math.abs(regularPolygon(4, 10, { rot: Math.PI / 4 })[0][0] - 10 * Math.SQRT1_2) < 1e-9);
near('star area is 2n triangles', area(star(5, 10, 5)), 10 * 0.5 * 10 * 5 * Math.sin(Math.PI / 5), 1e-9);
check('star has 2n vertices and is CCW', star(6, 10, 4).length === 12 && isCCW(star(6, 10, 4)));
nearPct('slot area is the stadium formula', area(slot(20, 2, { segs: 256 })), 16 * 4 + Math.PI * 4, 0.05);
nearVec('slot length is the overall length', bounds(slot(20, 2, { segs: 64 })).size, [20, 4], 1e-9);
throws('slot rejects a length shorter than its width', () => slot(3, 2), 'shorter than');
nearPct('roundedPath rounds every corner', area(roundedPath([[0, 0], [20, 0], [20, 10], [0, 10]], 2, { segs: 64 })), 200 - (4 - Math.PI) * 4, 0.05);
check('roundedPath clamps the radius to the shortest edge', isFinite(area(roundedPath([[0, 0], [2, 0], [2, 2], [0, 2]], 50, { segs: 16 }))));
check('roundedPath with r=0 returns the polygon', roundedPath([[0, 0], [10, 0], [0, 10]], 0).length === 3);
check('roundedPath handles a reflex corner', area(roundedPath([[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]], 1.5, { segs: 32 })) > 0);
near('chamferRect area is w·h − 2c²', area(chamferRect(20, 10, 2)), 200 - 2 * 4, 1e-9);
check('chamferRect has 8 corners', chamferRect(20, 10, 2).length === 8);
near('dogboneRect adds four corner bulges', area(dogboneRect(20, 10, 1.5, 1, { segs: 128 })), 200 + 4 * (Math.PI * 2.25 / 2 - 2.25), 0.01);
check('dogboneRect is never smaller than the tool that cuts it',
      area(dogboneRect(20, 10, 0.2, 2, { segs: 64 })) > area(dogboneRect(20, 10, 0.2, 0.5, { segs: 64 })));
check('dogboneRect is CCW and simple', isCCW(dogboneRect(20, 10, 1.5, 1, { segs: 32 })));
nearPct('arcRing quarter pie is πr²/4', area(arcRing(10, 0, 0, Math.PI / 2, { segs: 2048 })), Math.PI * 25, 0.05);
nearPct('arcRing half band is half the annulus', area(arcRing(10, 5, 0, Math.PI, { segs: 2048 })), Math.PI * 75 / 2, 0.05);
nearPct('arcRing full bridged annulus measures as an annulus', area(arcRing(10, 5, 0, TAU, { segs: 1024 })), Math.PI * 75, 0.05);
check('arcRing normalises a negative sweep to CCW', isCCW(arcRing(10, 0, Math.PI / 2, 0, { segs: 64 })));
throws('arcRing rejects rInner >= rOuter', () => arcRing(10, 10), 'rInner');
throws('circle rejects a non-positive radius', () => circle(0), 'positive radius');
throws('regularPolygon rejects fewer than 3 sides', () => regularPolygon(2, 5), 'at least 3');
throws('rect rejects a non-positive size', () => rect(0, 5), 'positive');

check('superformula presets are all usable', Object.keys(SUPERFORMULA_PRESETS).every(k => {
  const r = superformula({ preset: k, r: 20, segs: 240 });
  return r.length === 240 && isCCW(r) && area(r) > 0 && r.every(p => isFinite(p[0]) && isFinite(p[1]));
}), `${Object.keys(SUPERFORMULA_PRESETS).length} presets`);
nearPct('superformula circle preset is a circle', area(superformula({ preset: 'circle', r: 20, segs: 720 })), Math.PI * 400, 0.05);
check('superformula normalises the widest point to the requested radius', (() => {
  const r = superformula({ preset: 'star5', r: 20, segs: 720 });
  const maxR = Math.max(...r.map(p => Math.hypot(p[0], p[1])));
  return Math.abs(maxR - 20) < 1e-9;
})());
check('superformula m=0 does not divide by zero', area(superformula({ m: 0, n1: 1, n2: 1, n3: 1, r: 5, segs: 64 })) > 0);
check('superformula explicit params override the preset',
      Math.abs(area(superformula({ preset: 'circle', m: 4, n1: 8, n2: 8, n3: 8, r: 20, segs: 360 })) - Math.PI * 400) > 1);
throws('superformula rejects an unknown preset', () => superformula({ preset: 'nope' }), 'unknown superformula preset');

// ---------------------------------------------------------------------------
console.log('\n-- randomised polygon sweep (G7) --');
//
// 500 pseudorandom polygons, seed 20260821, through triangulate → offset →
// boolean. Deterministic: the same seed gives the same 500 polygons every run,
// so a failure here is reproducible by re-running the file.
//
// Four families, because they break different things: star-shaped rings are
// provably simple and so have a known area (the strongest oracle); scribbles
// self-intersect and are what actually crashes a sweep line; degenerate rings
// carry duplicate points and collinear runs; and shapes with holes exercise
// bridging and hole nesting. The area oracle only applies to the families that
// are guaranteed simple — a self-intersecting ring has no area to compare to.
//
// "Sorted by angle" is NOT enough to guarantee a simple ring: if the vertices
// happen to cluster in half the plane the centre falls outside and the closing
// edge cuts back across the fan. Each vertex therefore gets its own angular
// sector, which bounds every gap below 180° and makes the ring star-shaped
// about the origin by construction. (This cost three fuzz failures before it
// was the generator that turned out to be wrong, not the kernel.)

const SEED = 20260821;

function makeCases(seed) {
  let st = seed >>> 0;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rrange = (lo, hi) => lo + rnd() * (hi - lo);

  const starShaped = (n, rMin, rMax, cx = 0, cy = 0) => {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = TAU * (i + rnd() * 0.6) / n;         // one vertex per sector
      const r = rrange(rMin, rMax);
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return ring;
  };
  const scribble = (n, size) => {
    const ring = [];
    for (let i = 0; i < n; i++) ring.push([rrange(-size, size), rrange(-size, size)]);
    return ring;
  };
  const degenerate = (base) => {
    const ring = [];
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      ring.push([a[0], a[1]]);
      if (rnd() < 0.3) ring.push([a[0], a[1]]);                          // exact duplicate
      if (rnd() < 0.3) ring.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); // collinear midpoint
    }
    return ring;
  };

  const cases = [];
  for (let i = 0; i < 500; i++) {
    const family = i % 4;
    if (family === 0) cases.push({ shape: [starShaped(4 + Math.floor(rnd() * 20), 2, 18)], simple: true, family });
    else if (family === 1) cases.push({ shape: [scribble(4 + Math.floor(rnd() * 14), 15)], simple: false, family });
    else if (family === 2) cases.push({ shape: [degenerate(starShaped(4 + Math.floor(rnd() * 10), 4, 16))], simple: true, family });
    else {
      // Outer vertices sit at r >= 10 with gaps under 96°, so the outer boundary
      // never comes within 10·cos48° = 6.7 mm of the origin; the hole never
      // reaches past 3.5 mm. The hole is therefore always strictly inside.
      const outer = starShaped(6 + Math.floor(rnd() * 12), 10, 18);
      const hole = reverse(starShaped(5 + Math.floor(rnd() * 8), 0.5, 2.5, rrange(-1, 1), rrange(-1, 1)));
      cases.push({ shape: [outer, hole], simple: true, family });
    }
  }
  return cases;
}

// --- the oracles -----------------------------------------------------------
const finiteShapes = (shapes) =>
  Array.isArray(shapes) && shapes.every(s => Array.isArray(s) && s.every(r =>
    Array.isArray(r) && r.length >= 3 && r.every(p => p.length === 2 && isFinite(p[0]) && isFinite(p[1]))));

const orientedShapes = (shapes) => shapes.every(s => {
  if (signedArea(s[0]) <= 0) return false;                                     // outer must be CCW
  for (let i = 1; i < s.length; i++) if (signedArea(s[i]) >= 0) return false;  // holes CW
  return true;
});

// A green oracle that cannot go red is not a test. Prove each one rejects the
// exact corruption the fuzz hunts for before trusting 500 passes of it.
check('fuzz oracle rejects a NaN coordinate', !finiteShapes([[[[NaN, 0], [1, 0], [0, 1]]]]));
check('fuzz oracle rejects an inverted outer ring', !orientedShapes([[reverse(SQ)]]));
check('fuzz oracle rejects a counter-clockwise hole', !orientedShapes([[SQ, [[3, 3], [7, 3], [7, 7], [3, 7]]]]));

const cases = makeCases(SEED);
check('fuzz: the case set is reproducible from its seed',
      JSON.stringify(makeCases(SEED)) === JSON.stringify(cases) &&
      JSON.stringify(makeCases(SEED + 1)) !== JSON.stringify(cases),
      `seed ${SEED}, ${cases.length} cases, first ring ${cases[0].shape[0].length} points`);

const CLIP = rect(18, 12, { cx: 2, cy: 1 });
let threw = 0, nonFinite = 0, misoriented = 0, areaOff = 0, worstArea = 0, empties = 0, ops = 0;
let firstFailure = null;
const t0 = Date.now();

for (const { shape, simple, family } of cases) {
  try {
    const { points, tris } = triangulate(shape);
    let sum = 0, bad = false;
    for (let t = 0; t < tris.length; t += 3) {
      const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
      if (!a || !b || !c) { bad = true; break; }
      sum += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    ops++;
    if (bad || !isFinite(sum)) { nonFinite++; firstFailure = firstFailure || `triangulate family ${family}`; }
    if (simple) {
      const want = shapeArea(shape);
      const err = Math.abs(sum - want);
      if (err > worstArea) worstArea = err;
      if (err > Math.max(1e-9, want * 1e-12)) { areaOff++; firstFailure = firstFailure || `triangulated area off by ${err}`; }
    }

    for (const d of [0.6, -0.6, 2.5]) {
      const o = offset(shape, d, { join: d > 0 ? 'round' : 'miter', arcTolerance: 0.05 });
      ops++;
      if (!finiteShapes(o)) { nonFinite++; firstFailure = firstFailure || `offset ${d}, family ${family}`; }
      else if (!orientedShapes(o)) { misoriented++; firstFailure = firstFailure || `offset orientation ${d}, family ${family}`; }
      if (!o.length) empties++;
    }

    for (const op of ['union', 'difference', 'intersection', 'xor']) {
      const b = boolean(shape, [CLIP], op);
      ops++;
      if (!finiteShapes(b)) { nonFinite++; firstFailure = firstFailure || `${op}, family ${family}`; }
      else if (!orientedShapes(b)) { misoriented++; firstFailure = firstFailure || `${op} orientation, family ${family}`; }
    }
  } catch (e) {
    threw++;
    firstFailure = firstFailure || `${e.message} (family ${family})`;
  }
}
const fuzzMs = Date.now() - t0;

check('fuzz: 500 seeded polygons complete without throwing', threw === 0,
      `seed ${SEED}, ${ops} operations, ${threw} threw${firstFailure ? ` — first: ${firstFailure}` : ''}, ${fuzzMs} ms`);
check('fuzz: no NaN or infinite coordinate in any result', nonFinite === 0, `${nonFinite} non-finite results`);
check('fuzz: every returned ring is wound correctly (outer CCW, holes CW)', misoriented === 0,
      `${misoriented} misoriented, ${empties} legitimately empty offsets`);
check('fuzz: triangulated area matches the shape area for the simple families', areaOff === 0,
      `${areaOff} mismatches, worst ${worstArea.toExponential(2)} mm²`);

const finiteShapesEarly = (shapes) => shapes.every(s => s.every(r => r.every(p => isFinite(p[0]) && isFinite(p[1]))));

// ---------------------------------------------------------------------------
console.log('\n-- hostile input --');
//
// None of these are things a generator should do, but all of them are things a
// generator will do at 2am with a slider at its minimum, and a kernel that
// throws or hangs here takes the whole UI down with it.

check('triangulate: points come back in input order', (() => {
  const shape = [SQ, reverse([[3, 3], [7, 3], [7, 7], [3, 7]])];
  const { points } = triangulate(shape);
  const flat = [...shape[0], ...shape[1]];
  return points.length === flat.length && points.every((p, i) => p[0] === flat[i][0] && p[1] === flat[i][1]);
})());
check('triangulate: a hole identical to the outer ring gives no area', (() => {
  const t = triangulate([SQ, reverse(SQ)]);
  let sum = 0;
  for (let i = 0; i < t.tris.length; i += 3) {
    const a = t.points[t.tris[i]], b = t.points[t.tris[i + 1]], c = t.points[t.tris[i + 2]];
    sum += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return Math.abs(sum) < 1e-9;
})());
check('triangulate: a zero-area ring produces no triangles', triangulate([[[0, 0], [5, 5], [10, 10]]]).tris.length === 0);
check('triangulate: duplicated vertices do not wedge the ear loop', (() => {
  const t = triangulate([[[0, 0], [0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 10]]]);
  let sum = 0;
  for (let i = 0; i < t.tris.length; i += 3) {
    const a = t.points[t.tris[i]], b = t.points[t.tris[i + 1]], c = t.points[t.tris[i + 2]];
    sum += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return Math.abs(sum - 100) < 1e-9;
})());
check('boolean: empty subject, union returns the clip', totalArea(union([], [A10])) === 100);
check('boolean: empty clip, difference returns the subject', totalArea(difference([A10], [])) === 100);
check('boolean: empty both ways is empty', boolean([], [], 'intersection').length === 0);
check('boolean: a degenerate zero-area operand is ignored', totalArea(union([A10], [[[0, 0], [1, 1], [2, 2]]])) === 100);
check('offset: a shape whose hole touches its outer ring survives', (() => {
  const o = offset([[SQ, reverse([[0, 0], [6, 2], [2, 6]])]], -0.5, { join: 'miter' });
  return finiteShapesEarly(o) && o.every(sh => signedArea(sh[0]) > 0);
})());
check('offset: a 2-point ring is ignored, not crashed on', offset([[[0, 0], [1, 1]]], 1).length === 0);
check('pointInShape: a point outside everything is not in the shape', !pointInShape([100, 100], [SQ]));
check('bounds of nothing is a zero box', bounds([]).size[0] === 0 && bounds([]).size[1] === 0);
check('centroid of an empty ring is the origin', centroid([])[0] === 0);
check('asShape of an empty input is empty', asShape([]).length === 0);

done();
