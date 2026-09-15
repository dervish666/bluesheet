/**
 * geometry.js — CPU-side buffer preparation. Pure, no GL, no DOM.
 *
 * Everything that has to walk a 500k-triangle mesh lives here rather than in
 * viewer.js, both so it can be tested headlessly and so the whole lot can be
 * moved into a worker later without touching the renderer.
 */

/** Above this many triangles, wireframe edge extraction is skipped rather than
 *  spending seconds and ~50 MB building a line set nobody can read anyway. */
export const EDGE_TRIANGLE_BUDGET = 2_000_000;

/**
 * Accept either a kernel Mesh or an already-prepared buffer set (from a worker,
 * or from a previous call). Returns {positions, normals, indices, indexCount,
 * wide, triCount, vertCount, bbox}.
 *
 * The crease angle is what makes a revolved vase smooth and a box crisp; it is
 * passed straight through to Mesh.toRenderBuffers.
 */
export function meshToBuffers(mesh, { crease = 35 } = {}) {
  if (!mesh) return null;
  let b;
  if (mesh.positions && mesh.normals && mesh.indices) {
    b = {
      positions: asFloat32(mesh.positions),
      normals: asFloat32(mesh.normals),
      indices: mesh.indices,
      indexCount: mesh.indexCount ?? mesh.indices.length,
    };
  } else if (typeof mesh.toRenderBuffers === 'function') {
    b = mesh.toRenderBuffers({ crease });
  } else {
    throw new TypeError('setMesh: expected a Mesh or {positions, normals, indices}');
  }
  const vertCount = b.positions.length / 3;
  // A mesh that has grown past 16-bit indices in a worker may still arrive as
  // Uint16Array by mistake; widening here is cheaper than a corrupt draw.
  const indices = (vertCount > 65535 && !(b.indices instanceof Uint32Array))
    ? new Uint32Array(b.indices) : b.indices;
  return {
    positions: b.positions,
    normals: b.normals,
    indices,
    indexCount: b.indexCount ?? indices.length,
    wide: indices instanceof Uint32Array,
    vertCount,
    triCount: (b.indexCount ?? indices.length) / 3,
    bbox: boundsFromPositions(b.positions),
  };
}

function asFloat32(a) { return a instanceof Float32Array ? a : new Float32Array(a); }

/** Widen an index array to Uint32 (a no-op when it already is). */
export function widenIndices(indices) {
  return indices instanceof Uint32Array ? indices : new Uint32Array(indices);
}

export function boundsFromPositions(positions) {
  const n = positions.length;
  if (!n) return { min: [0, 0, 0], max: [0, 0, 0] };
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

export function boxCorners(box) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push([(i & 1) ? box.max[0] : box.min[0],
              (i & 2) ? box.max[1] : box.min[1],
              (i & 4) ? box.max[2] : box.min[2]]);
  }
  return out;
}

export function boxUnion(a, b) {
  if (!a) return b; if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * Unique triangle edges as a line index buffer.
 *
 * Deduped with a numeric-keyed Set (a*2^26 + b stays inside the exact integer
 * range for any mesh WebGL can draw, and is roughly 4x faster than the string
 * key you reach for first). Returns null past the budget so the caller can fall
 * back rather than lock the tab up for four seconds.
 */
export function buildEdgeIndices(indices, vertCount, { budget = EDGE_TRIANGLE_BUDGET } = {}) {
  const triCount = indices.length / 3;
  if (triCount > budget) return null;
  if (vertCount > 67_108_864) return null;         // 2^26, the key packing limit
  const seen = new Set();
  const wide = vertCount > 65535;
  const out = wide ? new Uint32Array(triCount * 6) : new Uint16Array(triCount * 6);
  let n = 0;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    n = pushEdge(out, n, seen, a, b);
    n = pushEdge(out, n, seen, b, c);
    n = pushEdge(out, n, seen, c, a);
  }
  return out.subarray(0, n);
}

function pushEdge(out, n, seen, a, b) {
  if (a === b) return n;
  const lo = a < b ? a : b, hi = a < b ? b : a;
  const key = lo * 67108864 + hi;
  if (seen.has(key)) return n;
  seen.add(key);
  out[n] = lo; out[n + 1] = hi;
  return n + 2;
}

/**
 * Overhang angle of a normal, in degrees, using the printer's convention: a
 * vertical wall is 0, a horizontal ceiling is 90. Upward-facing surfaces are
 * reported as 0 rather than a negative number so a UI can bar-chart it.
 * Mirrors the GLSL in shaders.js — if you change one, change both.
 */
export function overhangDegrees(nz) {
  return nz >= 0 ? 0 : Math.asin(Math.min(1, -nz)) * 180 / Math.PI;
}

/** Fraction of surface area steeper than `threshold` degrees of overhang.
 *  Cheap enough to run on every rebuild and it is what the legend reports. */
export function overhangStats(buffers, threshold = 50) {
  const { positions, normals, indices, indexCount } = buffers;
  let total = 0, over = 0, worst = 0;
  for (let i = 0; i < indexCount; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz) / 2;
    if (!(area > 0)) continue;
    total += area;
    // Average the three shaded normals: it matches what the overhang view draws,
    // which matters on a smoothed surface where the facet normal is an artefact.
    const mz = (normals[a + 2] + normals[b + 2] + normals[c + 2]) / 3;
    const deg = overhangDegrees(mz);
    if (deg > worst) worst = deg;
    if (deg >= threshold) over += area;
  }
  return { area: total, overhangArea: over, overhangPct: total ? over / total * 100 : 0, worstDeg: worst };
}

/** Pack a #rrggbb / #rgb / [r,g,b] colour into a 0..1 triple. */
export function parseColor(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  if (typeof c !== 'string') return [1, 0, 1];
  let s = c.trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s, 16);
  if (!isFinite(v)) return [1, 0, 1];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** sRGB -> linear, so the lighting maths in the shader is done in the space it
 *  assumes. Skipping this is why hand-picked colours come out washed out. */
export function toLinear(rgb) {
  return rgb.map(v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}
