// Mesh — the one type every part of Bluesheet speaks.
//
// Flat arrays, millimetres, Z up, counter-clockwise seen from outside. A mesh is
// grown by addVertex/addTri and thereafter treated as read-mostly: every
// transform returns a new Mesh so a generator can build a part once and place
// twenty copies without worrying about aliasing.
//
// No DOM, no imports. This file is the bottom of the stack.

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

// Integer-triple hashing for weld(). The quantised coordinates are exact
// integers in doubles and can exceed 32 bits (a 180 mm part at eps 1e-9 is
// 1.8e11), so both halves go into the hash. `same` treats NaN as equal to NaN,
// which is what the old string keys did ("NaN" === "NaN").
const lo32 = (q) => q | 0;
const hi32 = (q) => (q / 4294967296) | 0;
function hash3(x, y, z) {
  let h = Math.imul(lo32(x), 0x9E3779B1) ^ Math.imul(lo32(y), 0x85EBCA77) ^ Math.imul(lo32(z), 0xC2B2AE3D)
        ^ Math.imul(hi32(x) * 3 + hi32(y) * 5 + hi32(z) * 7, 0x27D4EB2F);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12;
  return h >>> 0;
}
const same = (a, b) => a === b || (a !== a && b !== b);

export class Mesh {
  constructor(positions = [], tris = []) {
    this.positions = Array.isArray(positions) ? positions : Array.from(positions);
    this.tris = Array.isArray(tris) ? tris : Array.from(tris);
  }

  static fromArrays(positions, tris) { return new Mesh(positions, tris); }

  static merge(meshes) {
    const out = new Mesh();
    for (const m of meshes) {
      if (!m || !m.triCount) continue;
      const base = out.vertCount;
      for (let i = 0; i < m.positions.length; i++) out.positions.push(m.positions[i]);
      for (let i = 0; i < m.tris.length; i++) out.tris.push(m.tris[i] + base);
    }
    return out;
  }

  /** Convex polygon from explicit 3D points, fan-triangulated. */
  static polygon(points) {
    const m = new Mesh();
    for (const p of points) m.addVertex(p[0], p[1], p[2]);
    for (let i = 1; i + 1 < points.length; i++) m.addTri(0, i, i + 1);
    return m;
  }

  get vertCount() { return this.positions.length / 3; }
  get triCount() { return this.tris.length / 3; }

  addVertex(x, y, z) { this.positions.push(x, y, z); return this.positions.length / 3 - 1; }
  addVertices(pts) { const out = []; for (const p of pts) out.push(this.addVertex(p[0], p[1], p[2])); return out; }
  addTri(i0, i1, i2) { this.tris.push(i0, i1, i2); return this; }
  addQuad(a, b, c, d) { this.tris.push(a, b, c, a, c, d); return this; }

  /** Fan-triangulate a convex ring of existing vertex indices. */
  addFace(indices) {
    for (let i = 1; i + 1 < indices.length; i++) this.tris.push(indices[0], indices[i], indices[i + 1]);
    return this;
  }

  /** Append another mesh into this one (mutating). */
  append(other) {
    const base = this.vertCount;
    for (let i = 0; i < other.positions.length; i++) this.positions.push(other.positions[i]);
    for (let i = 0; i < other.tris.length; i++) this.tris.push(other.tris[i] + base);
    return this;
  }

  vertex(i) { return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]]; }
  tri(t) { return [this.tris[t * 3], this.tris[t * 3 + 1], this.tris[t * 3 + 2]]; }

  clone() { return new Mesh(this.positions.slice(), this.tris.slice()); }

  isEmpty() { return this.tris.length === 0; }

  // ---- transforms ---------------------------------------------------------
  /** m is column-major 16 (WebGL order). Winding is flipped when det < 0. */
  transform(m) {
    const p = this.positions, n = p.length, out = new Array(n);
    for (let i = 0; i < n; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      out[i]     = m[0] * x + m[4] * y + m[8]  * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) -
      m[4] * (m[1] * m[10] - m[2] * m[9]) +
      m[8] * (m[1] * m[6]  - m[2] * m[5]);
    const mesh = new Mesh(out, this.tris.slice());
    return det < 0 ? mesh.flipped() : mesh;
  }

  mapVerts(fn) {
    const p = this.positions, out = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const r = fn(p[i], p[i + 1], p[i + 2], i / 3);
      out[i] = r[0]; out[i + 1] = r[1]; out[i + 2] = r[2];
    }
    return new Mesh(out, this.tris.slice());
  }

  translate(x, y = 0, z = 0) {
    if (Array.isArray(x)) { z = x[2] || 0; y = x[1] || 0; x = x[0] || 0; }
    const p = this.positions, out = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) { out[i] = p[i] + x; out[i + 1] = p[i + 1] + y; out[i + 2] = p[i + 2] + z; }
    return new Mesh(out, this.tris.slice());
  }

  scale(sx, sy = sx, sz = sx) {
    const p = this.positions, out = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) { out[i] = p[i] * sx; out[i + 1] = p[i + 1] * sy; out[i + 2] = p[i + 2] * sz; }
    const m = new Mesh(out, this.tris.slice());
    return (sx * sy * sz) < 0 ? m.flipped() : m;
  }

  rotateX(a) { const c = Math.cos(a), s = Math.sin(a); return this.mapVerts((x, y, z) => [x, c * y - s * z, s * y + c * z]); }
  rotateY(a) { const c = Math.cos(a), s = Math.sin(a); return this.mapVerts((x, y, z) => [c * x + s * z, y, -s * x + c * z]); }
  rotateZ(a) { const c = Math.cos(a), s = Math.sin(a); return this.mapVerts((x, y, z) => [c * x - s * y, s * x + c * y, z]); }

  /** Mirror across a plane through the origin. axis: 'x' | 'y' | 'z' */
  mirror(axis = 'x') {
    const s = { x: [-1, 1, 1], y: [1, -1, 1], z: [1, 1, -1] }[axis];
    if (!s) throw new Error(`mirror: bad axis "${axis}"`);
    return this.scale(s[0], s[1], s[2]);
  }

  flipped() {
    const t = this.tris, out = new Array(t.length);
    for (let i = 0; i < t.length; i += 3) { out[i] = t[i]; out[i + 1] = t[i + 2]; out[i + 2] = t[i + 1]; }
    return new Mesh(this.positions.slice(), out);
  }

  centerXY() { const b = this.bbox(); return this.translate(-b.center[0], -b.center[1], 0); }
  center() { const b = this.bbox(); return this.translate(-b.center[0], -b.center[1], -b.center[2]); }
  dropToPlate() { const b = this.bbox(); return this.translate(0, 0, -b.min[2]); }
  /** Centre in X/Y and rest on z=0 — the contract every generator must satisfy. */
  place() { const b = this.bbox(); return this.translate(-b.center[0], -b.center[1], -b.min[2]); }

  // ---- topology -----------------------------------------------------------
  /** Merge vertices closer than eps, drop resulting degenerate triangles. */
  weld(eps = 1e-6) {
    const inv = 1 / Math.max(eps, 1e-12);
    const P = this.positions, V = this.vertCount;
    // Quantise every coordinate to an integer number of eps. These are exact
    // integers held in doubles, so two vertices weld together exactly when all
    // three integers agree — the same rule as before, when the three were
    // joined into a string and looked up in a Map. The string form cost more
    // than everything else in this method put together: on a 300k-triangle
    // lithophane it was a quarter of a second of building keys that were read
    // once and thrown away. An open-addressing table over the integers does the
    // same lookups with no allocation per vertex.
    const qx = new Float64Array(V), qy = new Float64Array(V), qz = new Float64Array(V);
    for (let v = 0, i = 0; v < V; v++, i += 3) {
      qx[v] = Math.round(P[i] * inv); qy[v] = Math.round(P[i + 1] * inv); qz[v] = Math.round(P[i + 2] * inv);
    }
    let cap = 16;
    while (cap < V * 2) cap *= 2;
    const mask = cap - 1;
    const table = new Int32Array(cap).fill(-1);
    const wx = new Float64Array(V), wy = new Float64Array(V), wz = new Float64Array(V);
    const remap = new Int32Array(V);
    const pos = [];
    let n = 0;
    for (let v = 0; v < V; v++) {
      const x = qx[v], y = qy[v], z = qz[v];
      let h = hash3(x, y, z) & mask;
      for (;;) {
        const idx = table[h];
        if (idx < 0) {
          table[h] = n;
          wx[n] = x; wy[n] = y; wz[n] = z;
          pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          remap[v] = n++;
          break;
        }
        if (same(wx[idx], x) && same(wy[idx], y) && same(wz[idx], z)) { remap[v] = idx; break; }
        h = (h + 1) & mask;
      }
    }
    const tris = [];
    for (let t = 0; t < this.triCount; t++) {
      const a = remap[this.tris[t * 3]], b = remap[this.tris[t * 3 + 1]], c = remap[this.tris[t * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      tris.push(a, b, c);
    }
    return new Mesh(pos, tris);
  }

  /** Drop zero-area triangles without touching vertex identity. */
  dropDegenerate(areaEps = 1e-12) {
    const tris = [];
    for (let t = 0; t < this.triCount; t++) {
      const a = this.tris[t * 3], b = this.tris[t * 3 + 1], c = this.tris[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      if (this.triArea(t) <= areaEps) continue;
      tris.push(a, b, c);
    }
    return new Mesh(this.positions.slice(), tris);
  }

  /** Remove vertices no triangle references. */
  compact() {
    const used = new Int32Array(this.vertCount).fill(-1);
    for (const i of this.tris) used[i] = 0;
    const pos = [];
    for (let v = 0; v < this.vertCount; v++) {
      if (used[v] === 0) { used[v] = pos.length / 3; pos.push(this.positions[v * 3], this.positions[v * 3 + 1], this.positions[v * 3 + 2]); }
    }
    return new Mesh(pos, this.tris.map(i => used[i]));
  }

  /**
   * Close T-junctions: boundary edges that are open only because one side of a
   * shared line was subdivided and the other was not.
   *
   * This is the commonest way an otherwise-correct solid ends up leaking. Two
   * regions of one flat face are built by different code paths — a cap and a
   * pocket wall, say — and a boolean has put an extra point along their shared
   * edge. Both halves are geometrically right and the seam still does not close,
   * because a long edge on one side has no partner on the other.
   *
   * The repair is to split the long edge at the vertices sitting on it, fanning
   * the triangle that owns it. Only boundary edges are touched, so a mesh with
   * no holes is returned unchanged and this is safe to call unconditionally.
   */
  healTJunctions(eps = 1e-5) {
    const w = this.weld(eps);
    const edges = new Map();
    for (let t = 0; t < w.triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const u = w.tris[t * 3 + k], v = w.tris[t * 3 + (k + 1) % 3];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        const e = edges.get(key);
        if (e) e.n++; else edges.set(key, { n: 1, u, v, t });
      }
    }
    const open = [...edges.values()].filter(e => e.n === 1);
    if (!open.length) return w;

    // Candidate splitters: only vertices that are themselves on a boundary.
    const onBoundary = new Set();
    for (const e of open) { onBoundary.add(e.u); onBoundary.add(e.v); }

    const splits = new Map();               // triangle -> [{edgeK, mids:[idx]}]
    for (const e of open) {
      const a = w.vertex(e.u), b = w.vertex(e.v);
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const len2 = abx * abx + aby * aby + abz * abz;
      if (len2 < eps * eps) continue;
      const hits = [];
      for (const c of onBoundary) {
        if (c === e.u || c === e.v) continue;
        const p = w.vertex(c);
        const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const dx = a[0] + abx * t - p[0], dy = a[1] + aby * t - p[1], dz = a[2] + abz * t - p[2];
        if (dx * dx + dy * dy + dz * dz > eps * eps) continue;
        hits.push({ c, t });
      }
      if (!hits.length) continue;
      hits.sort((x, y) => x.t - y.t);
      splits.set(`${e.t}:${e.u},${e.v}`, { t: e.t, u: e.u, v: e.v, mids: hits.map(h => h.c) });
    }
    if (!splits.size) return w;

    const perTri = new Map();
    for (const s of splits.values()) {
      if (!perTri.has(s.t)) perTri.set(s.t, []);
      perTri.get(s.t).push(s);
    }
    const tris = [];
    for (let t = 0; t < w.triCount; t++) {
      const list = perTri.get(t);
      const [i0, i1, i2] = [w.tris[t * 3], w.tris[t * 3 + 1], w.tris[t * 3 + 2]];
      if (!list) { tris.push(i0, i1, i2); continue; }
      // Walk the triangle's three corners, inserting any splitters found on each
      // side, then fan the resulting polygon. Winding is preserved because the
      // walk follows the original corner order.
      const poly = [];
      const corners = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        const u = corners[k], v = corners[(k + 1) % 3];
        poly.push(u);
        const hit = list.find(s => (s.u === u && s.v === v) || (s.u === v && s.v === u));
        if (hit) {
          const mids = (hit.u === u) ? hit.mids : hit.mids.slice().reverse();
          for (const m of mids) poly.push(m);
        }
      }
      for (let k = 1; k + 1 < poly.length; k++) tris.push(poly[0], poly[k], poly[k + 1]);
    }
    return new Mesh(w.positions.slice(), tris);
  }

  // ---- measurement --------------------------------------------------------
  bbox() {
    if (!this.positions.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = this.positions[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
             center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] };
  }

  /** Signed volume in mm³ (positive when normals point out). Kahan-summed. */
  volume() {
    const p = this.positions, t = this.tris;
    let sum = 0, comp = 0;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      const y = v - comp, s = sum + y;
      comp = (s - sum) - y;
      sum = s;
    }
    return sum;
  }

  triArea(t) {
    const p = this.positions;
    const a = this.tris[t * 3] * 3, b = this.tris[t * 3 + 1] * 3, c = this.tris[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return Math.hypot(nx, ny, nz) / 2;
  }

  surfaceArea() { let s = 0; for (let t = 0; t < this.triCount; t++) s += this.triArea(t); return s; }

  faceNormal(t) {
    const p = this.positions;
    const a = this.tris[t * 3] * 3, b = this.tris[t * 3 + 1] * 3, c = this.tris[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }

  /** Area-weighted normals over the CURRENT index buffer (flat if unwelded). */
  vertexNormals() {
    const n = new Float32Array(this.vertCount * 3);
    for (let t = 0; t < this.triCount; t++) {
      const nrm = this.faceNormal(t), w = this.triArea(t);
      for (let k = 0; k < 3; k++) {
        const v = this.tris[t * 3 + k] * 3;
        n[v] += nrm[0] * w; n[v + 1] += nrm[1] * w; n[v + 2] += nrm[2] * w;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
  }

  /**
   * GPU-ready buffers with crease-aware smoothing: faces meeting at less than
   * `crease` degrees share a normal, sharper joins get split vertices. This is
   * what makes a revolved vase look round and a box look like a box.
   */
  toRenderBuffers({ crease = 35, weldEps = 1e-5 } = {}) {
    const w = this.weld(weldEps);
    const P = w.positions, TR = w.tris, T = w.triCount, V = w.vertCount;
    const cosC = Math.cos(crease * Math.PI / 180);

    // Face normals and areas, computed once into flat arrays. This is exactly
    // faceNormal(t) and triArea(t) — the same expressions on the same operands,
    // so the numbers are identical — without one fresh array per face.
    const fn = new Float64Array(T * 3), fa = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const a = TR[t * 3] * 3, b = TR[t * 3 + 1] * 3, c = TR[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const h = Math.hypot(nx, ny, nz);
      const l = h || 1;
      fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
      fa[t] = h / 2;
    }

    // Incident faces per vertex in CSR form, in ascending face order — the
    // order the smoothing sum runs in, which has to stay fixed for the result
    // to stay bit-for-bit what it was.
    const start = new Int32Array(V + 1);
    for (let i = 0; i < TR.length; i++) start[TR[i] + 1]++;
    for (let v = 0; v < V; v++) start[v + 1] += start[v];
    const cursor = start.slice(0, V);
    const inc = new Int32Array(TR.length);
    for (let t = 0; t < T; t++) {
      inc[cursor[TR[t * 3]]++] = t; inc[cursor[TR[t * 3 + 1]]++] = t; inc[cursor[TR[t * 3 + 2]]++] = t;
    }

    // Every corner could in principle need its own render vertex, so that is
    // the capacity; the buffers are trimmed to what was used at the end.
    const capN = TR.length;
    const positions = new Float32Array(capN * 3);
    const normals = new Float32Array(capN * 3);
    const tris = new Uint32Array(TR.length);
    // Dedupe by (vertex, quantised normal): two faces at the same vertex with
    // the same smoothed normal reuse one render vertex. Instead of a string key
    // per corner, each mesh vertex keeps a short chain of the render vertices
    // already emitted for it, tagged with their quantised normal.
    const head = new Int32Array(V).fill(-1);
    const next = new Int32Array(capN);
    const kx = new Int32Array(capN), ky = new Int32Array(capN), kz = new Int32Array(capN);
    let n = 0;
    const emit = (v, t) => {
      const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2];
      let nx = 0, ny = 0, nz = 0;
      for (let i = start[v], e = start[v + 1]; i < e; i++) {
        const o = inc[i] * 3;
        const ox = fn[o], oy = fn[o + 1], oz = fn[o + 2];
        if (ox * fx + oy * fy + oz * fz >= cosC) {
          const a = fa[inc[i]];
          nx += ox * a; ny += oy * a; nz += oz * a;
        }
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const qx = Math.round(nx * 512), qy = Math.round(ny * 512), qz = Math.round(nz * 512);
      for (let e = head[v]; e >= 0; e = next[e]) {
        if (kx[e] === qx && ky[e] === qy && kz[e] === qz) return e;
      }
      const idx = n++;
      positions[idx * 3] = P[v * 3]; positions[idx * 3 + 1] = P[v * 3 + 1]; positions[idx * 3 + 2] = P[v * 3 + 2];
      normals[idx * 3] = nx; normals[idx * 3 + 1] = ny; normals[idx * 3 + 2] = nz;
      kx[idx] = qx; ky[idx] = qy; kz[idx] = qz;
      next[idx] = head[v]; head[v] = idx;
      return idx;
    };
    for (let t = 0; t < T; t++) {
      tris[t * 3] = emit(TR[t * 3], t);
      tris[t * 3 + 1] = emit(TR[t * 3 + 1], t);
      tris[t * 3 + 2] = emit(TR[t * 3 + 2], t);
    }
    const wide = n > 65535;
    return {
      positions: positions.slice(0, n * 3),
      normals: normals.slice(0, n * 3),
      indices: wide ? tris : Uint16Array.from(tris),
      indexCount: tris.length,
      wide,
    };
  }

  // ---- export -------------------------------------------------------------
  /** Binary STL. Deterministic: the header is the name, space padded, no clock. */
  toSTL(name = 'bluesheet') {
    const n = this.triCount;
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    const header = `Bluesheet ${name}`.slice(0, 79);
    for (let i = 0; i < 80; i++) u8[i] = i < header.length ? header.charCodeAt(i) & 0x7f : 0x20;
    dv.setUint32(80, n, true);
    let o = 84;
    const p = this.positions;
    for (let t = 0; t < n; t++) {
      const nrm = this.faceNormal(t);
      dv.setFloat32(o, nrm[0], true); dv.setFloat32(o + 4, nrm[1], true); dv.setFloat32(o + 8, nrm[2], true);
      o += 12;
      for (let k = 0; k < 3; k++) {
        const v = this.tris[t * 3 + k] * 3;
        dv.setFloat32(o, p[v], true); dv.setFloat32(o + 4, p[v + 1], true); dv.setFloat32(o + 8, p[v + 2], true);
        o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Uint8Array(buf);
  }

  toString() {
    const b = this.bbox();
    return `Mesh(${this.vertCount}v ${this.triCount}t ${b.size.map(v => v.toFixed(1)).join('×')}mm ${this.volume().toFixed(1)}mm³)`;
  }
}

// ---- small 4×4 helpers (column-major, WebGL order) ------------------------
export const mat4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  translate: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  scale: (x, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1],
  rotX: (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
  rotY: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  rotZ: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  mul: (a, b) => {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
};

export default Mesh;
