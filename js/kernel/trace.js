// trace: closed iso-contours of a sampled scalar field (marching squares).
//
// Hand it a w × h grid of samples and a predicate "inside where s > 0", and it
// returns every boundary between inside and outside as a closed ring of points,
// with no open ends anywhere: the field is treated as surrounded by one extra
// row and column of "outside" on every side, so a region touching the edge of
// the picture is closed half a sample beyond it rather than left open.
//
// Coordinates are in sample units with sample (i, j) at (i + 0.5, j + 0.5), so
// a w × h picture spans exactly [0, w] × [0, h] and a full-contrast pixel on the
// border closes on the border line. Rows run the way they are stored (y down,
// as in every image format); the caller flips them.
//
// Crossing points are placed by linear interpolation along the cell edge, so an
// anti-aliased line comes out with sub-pixel edges rather than a staircase.
// The interpolation parameter is held inside [0.01, 0.99]: a sample sitting
// exactly on the iso value would otherwise put two crossings from neighbouring
// edges on the same point, and a zero-length edge is a degenerate triangle two
// steps later.
//
// Saddles (two inside corners diagonally opposite) are decided by the mean of
// the four corners, the cell's bilinear centre: above zero the two inside
// corners are joined through the middle, otherwise they are separate. That is
// a pure function of the samples, so the result never depends on scan order.
//
// Winding: every ring has the inside on its LEFT in the raw (y-down)
// coordinates. After a y-flip that becomes inside-on-the-right, so a caller
// that flips should nest by containment (text.js contoursToShapes) rather than
// trust the sign. Rings are returned in a deterministic order (scan order of
// their first crossing).
//
// No DOM, no dependencies.

const T_MIN = 0.01, T_MAX = 0.99;

/**
 * traceContours(s, w, h) -> ring[]
 * `s` is any indexable of length w*h, row-major. Inside is s > 0.
 */
export function traceContours(s, w, h) {
  w = Math.floor(w); h = Math.floor(h);
  if (!(w >= 1 && h >= 1) || !s || s.length < w * h) return [];
  const nx = w + 2, ny = h + 2;                    // padded sample grid
  const v = new Float64Array(nx * ny).fill(-1);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = +s[j * w + i];
      v[(j + 1) * nx + (i + 1)] = x > 0 ? x : (x === x ? Math.min(x, -1e-12) : -1);
    }
  }
  const inside = (i, j) => v[j * nx + i] > 0;

  // Edge ids: horizontal edge from (i,j) to (i+1,j), then vertical from (i,j) to (i,j+1).
  const nH = (nx - 1) * ny;
  const hId = (i, j) => j * (nx - 1) + i;
  const vId = (i, j) => nH + j * nx + i;
  const nE = nH + nx * (ny - 1);
  const next = new Int32Array(nE).fill(-1);
  const px = new Float64Array(nE), py = new Float64Array(nE);

  // Position of the crossing on an edge between samples a and b (padded coords),
  // converted to sample-unit output coords (pixel centre at +0.5, pad at -0.5).
  const cross = (id, ia, ja, ib, jb) => {
    const sa = v[ja * nx + ia], sb = v[jb * nx + ib];
    let t = sa / (sa - sb);
    if (!(t >= T_MIN)) t = T_MIN; else if (t > T_MAX) t = T_MAX;
    px[id] = ia + (ib - ia) * t - 0.5;
    py[id] = ja + (jb - ja) * t - 0.5;
  };

  const link = (e1, e2, cx, cy, refInside) => {
    // Orient e1 -> e2 so that the inside lies on the left: the reference corner
    // (cx, cy) is on the left if the cross product is positive, and it is inside
    // or outside as the caller says.
    const ax = px[e1], ay = py[e1], bx = px[e2], by = py[e2];
    const c = (bx - ax) * (cy - 0.5 - ay) - (by - ay) * (cx - 0.5 - ax);
    const left = c > 0;
    if (left === refInside) next[e1] = e2; else next[e2] = e1;
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = inside(i, j), tr = inside(i + 1, j), br = inside(i + 1, j + 1), bl = inside(i, j + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = hId(i, j), bottom = hId(i, j + 1), left = vId(i, j), right = vId(i + 1, j);
      if (tl !== tr) cross(top, i, j, i + 1, j);
      if (bl !== br) cross(bottom, i, j + 1, i + 1, j + 1);
      if (tl !== bl) cross(left, i, j, i, j + 1);
      if (tr !== br) cross(right, i + 1, j, i + 1, j + 1);
      // Corner positions in padded coords: tl (i,j) tr (i+1,j) br (i+1,j+1) bl (i,j+1).
      switch (code) {
        case 8: case 7:  link(top, left, i, j, tl); break;             // tl cut off
        case 4: case 11: link(top, right, i + 1, j, tr); break;        // tr cut off
        case 2: case 13: link(right, bottom, i + 1, j + 1, br); break; // br cut off
        case 1: case 14: link(bottom, left, i, j + 1, bl); break;      // bl cut off
        case 12: case 3: link(left, right, i, j, tl); break;           // top half vs bottom half
        case 6: case 9:  link(top, bottom, i + 1, j, tr); break;       // right half vs left half
        case 10: case 5: {                                             // saddle
          const mean = (v[j * nx + i] + v[j * nx + i + 1] + v[(j + 1) * nx + i + 1] + v[(j + 1) * nx + i]) / 4;
          if (mean > 0) {
            // Centre inside: the two OUTSIDE corners are the ones cut off.
            if (code === 10) { link(top, right, i + 1, j, tr); link(bottom, left, i, j + 1, bl); }
            else { link(top, left, i, j, tl); link(right, bottom, i + 1, j + 1, br); }
          } else {
            // Centre outside: the two INSIDE corners are cut off, separately.
            if (code === 10) { link(top, left, i, j, tl); link(right, bottom, i + 1, j + 1, br); }
            else { link(top, right, i + 1, j, tr); link(bottom, left, i, j + 1, bl); }
          }
          break;
        }
      }
    }
  }

  const rings = [];
  const seen = new Uint8Array(nE);
  for (let e = 0; e < nE; e++) {
    if (next[e] < 0 || seen[e]) continue;
    const ring = [];
    let k = e, guard = nE + 1;
    while (!seen[k] && guard-- > 0) {
      seen[k] = 1;
      ring.push([px[k], py[k]]);
      k = next[k];
      if (k < 0) break;               // cannot happen on a consistent field; never loop on it
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}
