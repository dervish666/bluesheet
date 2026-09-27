// Mesh analysis and printability.
//
// analyze() answers "is this geometry sound?". printability() answers "will the
// A1 mini in the cupboard actually make it?". Both hand back warnings[] of
// {code, message, severity}, and the messages are the product: every one carries
// its measurement in millimetres and names the fix, because "thin wall detected"
// has never once helped anybody at the printer.
//
// Read-only over a Mesh. No DOM, nothing imported but mesh.js.

import { Mesh } from './mesh.js';

/**
 * Weld tolerance for every topological question. Deliberately the same value
 * tests/lib/meshcheck.mjs uses: the two implementations are cross-checked
 * against each other, and a different tolerance would make them disagree for
 * reasons that are not bugs.
 */
export const WELD_EPS = 1e-5;

/** g/cm³, typical spool figures. Keys upper case; lookup is case-insensitive. */
export const FILAMENT_DENSITY = {
  PLA: 1.24, PETG: 1.27, TPU: 1.21, ABS: 1.04, ASA: 1.07,
  PC: 1.20, PA: 1.14, PVA: 1.23, HIPS: 1.04,
  'PLA-CF': 1.22, 'PETG-CF': 1.30, 'PA-CF': 1.19,
};

const DEG = 180 / Math.PI;
const SEV_RANK = { info: 1, warn: 2, error: 3 };
const FILAMENT_AREA = Math.PI * 0.875 * 0.875;   // 1.75 mm filament cross-section, mm²

// ---------------------------------------------------------------------------
// small shared plumbing
// ---------------------------------------------------------------------------

function asMesh(m) {
  if (!m) throw new TypeError('validate: mesh is null or undefined');
  if (typeof m.weld === 'function' && typeof m.triArea === 'function') return m;
  if (m.positions && m.tris) return new Mesh(Array.from(m.positions), Array.from(m.tris));
  throw new TypeError('validate: expected a Mesh (or {positions, tris}), got ' + typeof m);
}

// Welding is the expensive half of every topology query and analyze() +
// printability() are called back to back on the same mesh by the UI on every
// slider drag. Mesh is documented as append-only, so vertex and triangle counts
// are a sufficient staleness key: nothing but addVertex/addTri can change the
// geometry without changing them.
const weldCache = new WeakMap();
function weldedOf(mesh, eps) {
  const hit = weldCache.get(mesh);
  if (hit && hit.eps === eps && hit.vc === mesh.vertCount && hit.tc === mesh.triCount) return hit.w;
  // `near`: a verdict that moves when the mesh moves is the grid's, not the
  // mesh's (see Mesh#weld). tests/lib/meshcheck.mjs welds the same way; the
  // two are a cross-check and must agree.
  const w = mesh.weld(eps, { near: true });
  weldCache.set(mesh, { eps, vc: mesh.vertCount, tc: mesh.triCount, w });
  return w;
}

function triVol(m, t) {
  const p = m.positions, a = m.tris[t * 3] * 3, b = m.tris[t * 3 + 1] * 3, c = m.tris[t * 3 + 2] * 3;
  const ax = p[a], ay = p[a + 1], az = p[a + 2];
  const bx = p[b], by = p[b + 1], bz = p[b + 2];
  const cx = p[c], cy = p[c + 1], cz = p[c + 2];
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

function triCentroid(m, t, out) {
  const p = m.positions, a = m.tris[t * 3] * 3, b = m.tris[t * 3 + 1] * 3, c = m.tris[t * 3 + 2] * 3;
  out[0] = (p[a] + p[b] + p[c]) / 3;
  out[1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
  out[2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  return out;
}

function triMaxZ(m, t) {
  const p = m.positions;
  return Math.max(p[m.tris[t * 3] * 3 + 2], p[m.tris[t * 3 + 1] * 3 + 2], p[m.tris[t * 3 + 2] * 3 + 2]);
}
function triMinZ(m, t) {
  const p = m.positions;
  return Math.min(p[m.tris[t * 3] * 3 + 2], p[m.tris[t * 3 + 1] * 3 + 2], p[m.tris[t * 3 + 2] * 3 + 2]);
}

// Number formatting for warning text. Printing "0.6000000000000001 mm" in a
// message aimed at a person is its own kind of bug.
const f0 = (v) => (Number.isFinite(v) ? v.toFixed(0) : String(v));
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const s = (n) => (n === 1 ? '' : 's');
const isA = (n) => (n === 1 ? 'is' : 'are');

function warn(list, code, severity, message, extra) {
  const w = { code, severity, message };
  if (extra) Object.assign(w, extra);
  list.push(w);
  return w;
}

/** Highest severity present. Accepts a warnings array or a whole result object. */
export function worstSeverity(warnings) {
  const list = Array.isArray(warnings) ? warnings : (warnings && warnings.warnings) || [];
  let rank = 0;
  for (const w of list) rank = Math.max(rank, SEV_RANK[w && w.severity] || 0);
  return ['none', 'info', 'warn', 'error'][rank];
}

// ---------------------------------------------------------------------------
// edges, shells, orientation
// ---------------------------------------------------------------------------

/**
 * Half-edge census over the welded mesh. Everything topological in this file
 * starts here: an edge key is (lo * vertCount + hi), which is exact in a double
 * for any mesh under ~94 million vertices — several orders past what a printer
 * can swallow — and is far cheaper than the string keys the obvious version uses.
 *
 * `net` is the sum of traversal directions: 0 for a properly opposed pair,
 * ±2 when two triangles walk the same edge the same way (one of them is flipped).
 */
export function buildEdgeMap(mesh, { weldEps = WELD_EPS, welded = null } = {}) {
  const w = welded || weldedOf(asMesh(mesh), weldEps);
  const V = w.vertCount, T = w.triCount, tri = w.tris;
  const edges = new Map();
  let degenerateTris = 0;
  for (let t = 0; t < T; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerateTris++; continue; }
    for (let k = 0; k < 3; k++) {
      const u = tri[t * 3 + k], v = tri[t * 3 + (k + 1) % 3];
      const fwd = u < v;
      const key = (fwd ? u : v) * V + (fwd ? v : u);
      let e = edges.get(key);
      if (e === undefined) {
        e = { u: fwd ? u : v, v: fwd ? v : u, count: 0, net: 0, f0: -1, f1: -1, more: null };
        edges.set(key, e);
      }
      e.count++;
      e.net += fwd ? 1 : -1;
      if (e.f0 < 0) e.f0 = t;
      else if (e.f1 < 0) e.f1 = t;
      else (e.more || (e.more = [])).push(t);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0, maxFanning = 0;
  for (const e of edges.values()) {
    if (e.count === 1) boundaryEdges++;
    else if (e.count > 2) { nonManifoldEdges++; if (e.count > maxFanning) maxFanning = e.count; }
    else if (e.net !== 0) inconsistentEdges++;
  }
  return { welded: w, edges, edgeCount: edges.size, boundaryEdges, nonManifoldEdges,
           inconsistentEdges, degenerateTris, maxFanning, vertCount: V, triCount: T };
}

const edgeKey = (V, u, v) => (u < v ? u * V + v : v * V + u);

/**
 * Connected components by shared (welded) vertex — the definition the plan asks
 * for, so a bowtie counts as one shell and two boxes 0.01 mm apart count as two.
 * Vertices no triangle uses are not shells; they are litter, reported separately.
 */
export function shellsOf(mesh, { weldEps = WELD_EPS, welded = null } = {}) {
  const w = welded || weldedOf(asMesh(mesh), weldEps);
  const V = w.vertCount, T = w.triCount;
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let t = 0; t < T; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    join(a, b); join(b, c);
  }
  const rootToShell = new Map();
  const labels = new Int32Array(T).fill(-1);
  const shells = [];
  for (let t = 0; t < T; t++) {
    const r = find(w.tris[t * 3]);
    let idx = rootToShell.get(r);
    if (idx === undefined) {
      idx = shells.length;
      rootToShell.set(r, idx);
      shells.push({ tris: 0, volume: 0, area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    }
    labels[t] = idx;
    const sh = shells[idx];
    sh.tris++;
    sh.volume += triVol(w, t);
    sh.area += w.triArea(t);
    for (let k = 0; k < 3; k++) {
      const vi = w.tris[t * 3 + k] * 3;
      for (let ax = 0; ax < 3; ax++) {
        const val = w.positions[vi + ax];
        if (val < sh.min[ax]) sh.min[ax] = val;
        if (val > sh.max[ax]) sh.max[ax] = val;
      }
    }
  }
  // Report the biggest shell first (the messages say "largest"), which means
  // relabelling every triangle — labels that pointed at the discovery order
  // would quietly index the wrong shell after the sort.
  const order = shells.map((sh, i) => i).sort((a, b) => shells[b].tris - shells[a].tris);
  const remap = new Int32Array(shells.length);
  for (let i = 0; i < order.length; i++) remap[order[i]] = i;
  for (let t = 0; t < T; t++) labels[t] = remap[labels[t]];
  const sorted = order.map((i) => shells[i]);
  return { count: sorted.length, labels, shells: sorted, welded: w };
}

/**
 * How many triangles are wound the wrong way round, and is the whole thing
 * inside out?
 *
 * The cheap version counts inconsistent EDGES and calls it a day — one reversed
 * triangle in a cube then reports "3". This walks face adjacency instead,
 * assigning each triangle a relative orientation, and takes the smaller side of
 * the split: one reversed triangle in a cube reports exactly 1. Global inversion
 * is a separate answer (`inverted`), because "all 12 triangles are backwards" is
 * a worse description of an inside-out cube than "it is inside out".
 */
export function orientationCheck(mesh, opts = {}) {
  const em = opts.edgeMap || buildEdgeMap(mesh, opts);
  const w = em.welded, T = w.triCount, V = w.vertCount, edges = em.edges;
  const state = new Int8Array(T);              // 0 unseen, ±1 orientation relative to the seed
  const stack = [];
  let flippedTris = 0, orientedVolume = 0, nonOrientable = 0, regions = 0;
  const members = [];
  for (let seed = 0; seed < T; seed++) {
    if (state[seed] !== 0) continue;
    const a = w.tris[seed * 3], b = w.tris[seed * 3 + 1], c = w.tris[seed * 3 + 2];
    if (a === b || b === c || a === c) { state[seed] = 1; continue; }
    regions++;
    members.length = 0;
    stack.length = 0;
    stack.push(seed); state[seed] = 1;
    let minority = 0;
    while (stack.length) {
      const t = stack.pop();
      members.push(t);
      if (state[t] === -1) minority++;
      for (let k = 0; k < 3; k++) {
        const u = w.tris[t * 3 + k], v = w.tris[t * 3 + (k + 1) % 3];
        const e = edges.get(edgeKey(V, u, v));
        // Only manifold edges carry orientation. Across a 3-way junction there
        // is no "the" neighbour, so those regions are decided independently.
        if (e === undefined || e.count !== 2) continue;
        const o = e.f0 === t ? e.f1 : e.f0;
        if (o < 0 || o === t) continue;
        const sign = e.net === 0 ? state[t] : -state[t];
        if (state[o] === 0) { state[o] = sign; stack.push(o); }
        else if (state[o] !== sign) nonOrientable++;
      }
    }
    const n = members.length;
    // Adopt whichever side is the majority: that is the minimum number of
    // triangles somebody has to re-wind to make this region consistent.
    const keep = minority * 2 > n ? -1 : 1;
    flippedTris += keep === 1 ? minority : n - minority;
    for (const t of members) orientedVolume += state[t] * keep * triVol(w, t);
  }
  return {
    flippedTris,
    inconsistentEdges: em.inconsistentEdges,
    orientedVolume,
    inverted: orientedVolume < 0,
    nonOrientable,
    regions,
  };
}

/**
 * Walk the open edges into loops, so a hole can be described ("one hole, 34 mm
 * of rim, lowest point z = 0") instead of merely counted.
 */
export function boundaryLoops(mesh, opts = {}) {
  const em = opts.edgeMap || buildEdgeMap(mesh, opts);
  if (!em.boundaryEdges) return [];
  const w = em.welded, V = w.vertCount, p = w.positions;
  const outgoing = new Map();                 // u -> [v, ...] for open half-edges
  for (let t = 0; t < w.triCount; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (let k = 0; k < 3; k++) {
      const u = w.tris[t * 3 + k], v = w.tris[t * 3 + (k + 1) % 3];
      const e = em.edges.get(edgeKey(V, u, v));
      if (e && e.count === 1) {
        let l = outgoing.get(u);
        if (!l) outgoing.set(u, l = []);
        l.push(v);
      }
    }
  }
  const loops = [];
  for (const [start, list] of outgoing) {
    while (list.length) {
      const verts = [start];
      let v = list.pop(), guard = 0;
      while (v !== undefined && v !== start && guard++ <= em.boundaryEdges + 1) {
        verts.push(v);
        const nl = outgoing.get(v);
        v = nl && nl.length ? nl.pop() : undefined;
      }
      const closed = v === start;
      let length = 0, lowestZ = Infinity, highestZ = -Infinity;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i] * 3;
        lowestZ = Math.min(lowestZ, p[a + 2]);
        highestZ = Math.max(highestZ, p[a + 2]);
        const next = i + 1 < verts.length ? verts[i + 1] : (closed ? verts[0] : -1);
        if (next >= 0) length += Math.hypot(p[next * 3] - p[a], p[next * 3 + 1] - p[a + 1], p[next * 3 + 2] - p[a + 2]);
      }
      loops.push({ verts, closed, length, lowestZ, highestZ, edges: closed ? verts.length : verts.length - 1 });
    }
  }
  loops.sort((a, b) => b.length - a.length);
  return loops;
}

/**
 * Bowtie vertices: the link of a vertex (the ring of opposite edges of its
 * triangles) must be one connected piece. Two pieces means two lobes of surface
 * pinched together at a single point — legal in an STL, impossible in plastic,
 * and invisible to an edge-only manifold test.
 */
function nonManifoldVertices(w) {
  const V = w.vertCount, T = w.triCount;
  const link = new Array(V);
  for (let t = 0; t < T; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    (link[a] || (link[a] = [])).push(b, c);
    (link[b] || (link[b] = [])).push(c, a);
    (link[c] || (link[c] = [])).push(a, b);
  }
  let bad = 0;
  const local = new Map();
  const parent = [];
  for (let v = 0; v < V; v++) {
    const l = link[v];
    if (!l || l.length <= 2) continue;
    local.clear();
    parent.length = 0;
    const idOf = (x) => {
      let i = local.get(x);
      if (i === undefined) { i = parent.length; local.set(x, i); parent.push(i); }
      return i;
    };
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < l.length; i += 2) {
      const a = find(idOf(l[i])), b = find(idOf(l[i + 1]));
      if (a !== b) parent[b] = a;
    }
    let comps = 0;
    for (let i = 0; i < parent.length; i++) if (find(i) === i) comps++;
    if (comps > 1) bad++;
  }
  return bad;
}

// ---------------------------------------------------------------------------
// spatial queries — one uniform grid serves ray casting and self-intersection
// ---------------------------------------------------------------------------

/**
 * Uniform grid over triangle AABBs. A BVH would be tidier for wildly uneven
 * meshes, but printable geometry is bounded by a 180 mm cube and mostly evenly
 * tessellated, so a grid with ~3 triangles per occupied cell wins on build time
 * and has no recursion to get wrong.
 *
 * `subset` restricts indexing to a list of triangle indices (used when a huge
 * mesh is sampled rather than checked exhaustively).
 */
export function triGrid(mesh, { target = 3, maxCells = 1 << 20, subset = null } = {}) {
  const m = asMesh(mesh);
  const b = m.bbox();
  const list = subset;
  const n = list ? list.length : m.triCount;
  const span = Math.max(b.size[0], b.size[1], b.size[2]);
  // Cell edge chosen so a cubical mesh gets ~n/target cells; then grown until
  // the grid fits the cell budget, which is what saves us on a 2 mm tall plate
  // that is 180 mm wide.
  let cell = span > 0 ? Math.max(span / Math.max(1, Math.cbrt(Math.max(1, n / target))), 1e-6) : 1;
  let nx = 1, ny = 1, nz = 1;
  for (let guard = 0; guard < 64; guard++) {
    nx = Math.max(1, Math.ceil(b.size[0] / cell) || 1);
    ny = Math.max(1, Math.ceil(b.size[1] / cell) || 1);
    nz = Math.max(1, Math.ceil(b.size[2] / cell) || 1);
    if (nx * ny * nz <= maxCells) break;
    cell *= 1.6;
  }
  const min = [b.min[0], b.min[1], b.min[2]];
  const map = new Map();
  const clampi = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  const put = (t) => {
    const p = m.positions;
    const a = m.tris[t * 3] * 3, bb = m.tris[t * 3 + 1] * 3, c = m.tris[t * 3 + 2] * 3;
    for (let ax = 0; ax < 3; ax++) {
      lo[ax] = Math.min(p[a + ax], p[bb + ax], p[c + ax]);
      hi[ax] = Math.max(p[a + ax], p[bb + ax], p[c + ax]);
    }
    const x0 = clampi(Math.floor((lo[0] - min[0]) / cell), nx - 1), x1 = clampi(Math.floor((hi[0] - min[0]) / cell), nx - 1);
    const y0 = clampi(Math.floor((lo[1] - min[1]) / cell), ny - 1), y1 = clampi(Math.floor((hi[1] - min[1]) / cell), ny - 1);
    const z0 = clampi(Math.floor((lo[2] - min[2]) / cell), nz - 1), z1 = clampi(Math.floor((hi[2] - min[2]) / cell), nz - 1);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = (z * ny + y) * nx + x;
      const arr = map.get(key);
      if (arr) arr.push(t); else map.set(key, [t]);
    }
  };
  const lo = [0, 0, 0], hi = [0, 0, 0];
  if (list) for (let i = 0; i < list.length; i++) put(list[i]);
  else for (let t = 0; t < m.triCount; t++) put(t);

  const stamp = new Int32Array(m.triCount);
  let visit = 0;

  /** Every triangle whose cell overlaps the box, each reported once. */
  function query(bmin, bmax, cb) {
    visit++;
    const x0 = clampi(Math.floor((bmin[0] - min[0]) / cell), nx - 1), x1 = clampi(Math.floor((bmax[0] - min[0]) / cell), nx - 1);
    const y0 = clampi(Math.floor((bmin[1] - min[1]) / cell), ny - 1), y1 = clampi(Math.floor((bmax[1] - min[1]) / cell), ny - 1);
    const z0 = clampi(Math.floor((bmin[2] - min[2]) / cell), nz - 1), z1 = clampi(Math.floor((bmax[2] - min[2]) / cell), nz - 1);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const arr = map.get((z * ny + y) * nx + x);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (stamp[t] === visit) continue;
        stamp[t] = visit;
        cb(t);
      }
    }
  }

  /** Amanatides–Woo march: only the cells the segment actually crosses. */
  function queryRay(o, d, maxT, cb) {
    const gmax = [min[0] + nx * cell, min[1] + ny * cell, min[2] + nz * cell];
    let t0 = 0, t1 = maxT;
    for (let ax = 0; ax < 3; ax++) {
      if (Math.abs(d[ax]) < 1e-15) { if (o[ax] < min[ax] || o[ax] > gmax[ax]) return; continue; }
      let ta = (min[ax] - o[ax]) / d[ax], tb = (gmax[ax] - o[ax]) / d[ax];
      if (ta > tb) { const sw = ta; ta = tb; tb = sw; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;
    }
    let ix = clampi(Math.floor((o[0] + d[0] * t0 - min[0]) / cell), nx - 1);
    let iy = clampi(Math.floor((o[1] + d[1] * t0 - min[1]) / cell), ny - 1);
    let iz = clampi(Math.floor((o[2] + d[2] * t0 - min[2]) / cell), nz - 1);
    const step = [d[0] > 0 ? 1 : -1, d[1] > 0 ? 1 : -1, d[2] > 0 ? 1 : -1];
    const tMax = [0, 0, 0], tDelta = [0, 0, 0];
    const idx = [ix, iy, iz], nn = [nx, ny, nz];
    for (let ax = 0; ax < 3; ax++) {
      if (Math.abs(d[ax]) < 1e-15) { tMax[ax] = Infinity; tDelta[ax] = Infinity; continue; }
      const bound = min[ax] + (idx[ax] + (d[ax] > 0 ? 1 : 0)) * cell;
      tMax[ax] = (bound - o[ax]) / d[ax];
      tDelta[ax] = Math.abs(cell / d[ax]);
    }
    visit++;
    for (let guard = 0; guard < nx + ny + nz + 8; guard++) {
      const arr = map.get((iz * ny + iy) * nx + ix);
      if (arr) for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (stamp[t] === visit) continue;
        stamp[t] = visit;
        cb(t);
      }
      let ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (tMax[ax] > t1) break;
      tMax[ax] += tDelta[ax];
      if (ax === 0) { ix += step[0]; if (ix < 0 || ix >= nn[0]) break; }
      else if (ax === 1) { iy += step[1]; if (iy < 0 || iy >= nn[1]) break; }
      else { iz += step[2]; if (iz < 0 || iz >= nn[2]) break; }
    }
  }

  return { mesh: m, min, cell, nx, ny, nz, cells: map.size, map, query, queryRay,
           triCount: n, bbox: b };
}

/**
 * Nearest triangle hit along a ray, Möller–Trumbore, both faces visible.
 * `skip` drops one triangle index (the surface the ray started from).
 */
export function rayMeshHit(grid, origin, dir, { maxT = Infinity, skip = -1, eps = 1e-9 } = {}) {
  const m = grid.mesh, p = m.positions;
  let bestT = maxT, bestTri = -1;
  const test = (t) => {
    if (t === skip) return;
    const ia = m.tris[t * 3] * 3, ib = m.tris[t * 3 + 1] * 3, ic = m.tris[t * 3 + 2] * 3;
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -eps && det < eps) return;                 // ray parallel to the face
    const inv = 1 / det;
    const tx = origin[0] - p[ia], ty = origin[1] - p[ia + 1], tz = origin[2] - p[ia + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < 0 || u + v > 1) return;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > eps && tt < bestT) { bestT = tt; bestTri = t; }
  };
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const march = Number.isFinite(maxT) ? maxT : (grid.nx + grid.ny + grid.nz) * grid.cell / len + 1;
  grid.queryRay(origin, dir, march, test);
  if (bestTri < 0) return null;
  return { t: bestT, tri: bestTri,
           point: [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT] };
}

/**
 * How many times a ray crosses the surface. Triangles can appear in several grid
 * cells, so crossings are counted by triangle index rather than by callback.
 */
export function rayMeshCount(grid, origin, dir, { eps = 1e-9, merge = 1e-7, signed = false } = {}) {
  const m = grid.mesh, p = m.positions;
  // queryRay already reports each triangle once per ray (it stamps them), so
  // there is no Set to keep here. This runs tens of thousands of times per
  // analysis — once per steep face — and a Set, an array of pairs and a sort
  // per call were most of what it cost.
  let count = 0;
  const test = (t) => {
    const ia = m.tris[t * 3] * 3, ib = m.tris[t * 3 + 1] * 3, ic = m.tris[t * 3 + 2] * 3;
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -eps && det < eps) return;
    const inv = 1 / det;
    const tx = origin[0] - p[ia], ty = origin[1] - p[ia + 1], tz = origin[2] - p[ia + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < 0 || u + v > 1) return;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    // det is the ray direction dotted with the triangle normal, so its sign says
    // which way this face is turned relative to the ray. That is the difference
    // between two triangles of one flat face and two faces of two solids that
    // happen to be flush.
    if (tt > eps) {
      if (count === hitT.length) growHits();
      // Insertion sort by (distance, sign) as the hits arrive: the list is
      // almost always a handful long, and this is the order the merge below
      // needs.
      const sg = det > 0 ? 1 : -1;
      let i = count++;
      while (i > 0 && (hitT[i - 1] > tt || (hitT[i - 1] === tt && hitS[i - 1] > sg))) { hitT[i] = hitT[i - 1]; hitS[i] = hitS[i - 1]; i--; }
      hitT[i] = tt; hitS[i] = sg;
    }
  };
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  grid.queryRay(origin, dir, (grid.nx + grid.ny + grid.nz) * grid.cell / len + 1, test);
  // Count crossings, not triangles. Two things can put several triangle hits at
  // one distance, and they need opposite answers:
  //   - a ray along the diagonal where two triangles of one flat face meet: one
  //     crossing, and counting two gets the parity exactly backwards;
  //   - two solids resting flush on each other, one face pointing up and the
  //     other down: genuinely two crossings, and merging them is equally wrong.
  // The sign of the ray-normal dot separates them, so hits merge only when they
  // agree on which way the surface is turned.
  let n = 0, winding = 0;
  for (let i = 0; i < count; i++) {
    const same = i > 0 && hitT[i] - hitT[i - 1] <= merge && hitS[i] === hitS[i - 1];
    if (!same) { n++; winding += hitS[i]; }
  }
  // `signed` returns the winding sum rather than the crossing count. Parity is
  // the right answer for one closed solid and the wrong one for a union of
  // shells that interpenetrate: a point inside two overlapping solids has an
  // EVEN number of crossings and parity calls it outside. The winding sum calls
  // it inside twice, which is what a printer would find there.
  return signed ? winding : n;
}

// Scratch space for rayMeshCount's hit list, grown on demand and never freed:
// one ray's hits are consumed before the next ray is cast.
let hitT = new Float64Array(64), hitS = new Int8Array(64);
function growHits() {
  const t = new Float64Array(hitT.length * 2); t.set(hitT); hitT = t;
  const s = new Int8Array(hitS.length * 2); s.set(hitS); hitS = s;
}

// A direction with no rational relationship to any axis, so a ray is very
// unlikely to graze an edge or a vertex and be counted twice.
const SKEW = (() => { const d = [0.4467, 0.5723, 0.6875], l = Math.hypot(...d); return d.map(v => v / l); })();

/**
 * Inside the UNION of the mesh's shells, even where they interpenetrate.
 *
 * `pointInsideMesh` asks parity, which is exactly right for one closed solid and
 * wrong for two that overlap — a point inside both crosses an even number of
 * surfaces and comes back "outside", punching a phantom hole through the region
 * where a bar passes into a post. Winding counts it as inside twice.
 */
function insideUnion(grid, point, eps = 1e-9) {
  return rayMeshCount(grid, point, SKEW, { eps, signed: true }) !== 0;
}

/** Is this point inside the solid? Crossing parity along a skew ray. */
export function pointInsideMesh(grid, point, { eps = 1e-9 } = {}) {
  return (rayMeshCount(grid, point, SKEW, { eps }) & 1) === 1;
}

// --- triangle/triangle -------------------------------------------------------

function segsCross2(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function pointInTri2(p, t) {
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  const d1 = sign(p, t[0], t[1]), d2 = sign(p, t[1], t[2]), d3 = sign(p, t[2], t[0]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}
function coplanarOverlap(N, A, B) {
  // Drop the axis the normal leans on hardest; the projection keeps its area.
  const ax = Math.abs(N[0]), ay = Math.abs(N[1]), az = Math.abs(N[2]);
  let i0 = 0, i1 = 1;
  if (ax > ay && ax > az) { i0 = 1; i1 = 2; }
  else if (ay > az) { i0 = 0; i1 = 2; }
  const p2 = (v) => [v[i0], v[i1]];
  const a = [p2(A[0]), p2(A[1]), p2(A[2])], b = [p2(B[0]), p2(B[1]), p2(B[2])];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    if (segsCross2(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3])) return true;
  return pointInTri2(a[0], b) || pointInTri2(b[0], a);
}
function lineInterval(pv, d) {
  // Which vertex sits alone on one side of the other triangle's plane?
  let i = -1;
  if (d[0] * d[1] > 0) i = 2;
  else if (d[0] * d[2] > 0) i = 1;
  else if (d[1] * d[2] > 0 || d[0] !== 0) i = 0;
  else if (d[1] !== 0) i = 1;
  else if (d[2] !== 0) i = 2;
  else return null;                                  // coplanar
  const j = (i + 1) % 3, k = (i + 2) % 3;
  const t1 = pv[i] + (pv[j] - pv[i]) * (d[i] / (d[i] - d[j]));
  const t2 = pv[i] + (pv[k] - pv[i]) * (d[i] / (d[i] - d[k]));
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/**
 * Möller's triangle/triangle overlap test. Points are [x,y,z].
 *
 * Coplanar contact is off by default: two solids merged face to face are touching,
 * not crossing, and reporting every such pair as a self-intersection buries the
 * real crossings. Pass includeCoplanar:true to count them.
 */
export function triTriIntersect(a0, a1, a2, b0, b1, b2, { eps = 1e-9, includeCoplanar = false } = {}) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const norm = (n) => { const l = Math.hypot(n[0], n[1], n[2]); return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null; };

  const n2 = norm(cross(sub(b1, b0), sub(b2, b0)));
  if (!n2) return false;                              // degenerate triangle: nothing to cross
  const d2 = -dot(n2, b0);
  let da = [dot(n2, a0) + d2, dot(n2, a1) + d2, dot(n2, a2) + d2];
  for (let i = 0; i < 3; i++) if (Math.abs(da[i]) < eps) da[i] = 0;
  if ((da[0] > 0 && da[1] > 0 && da[2] > 0) || (da[0] < 0 && da[1] < 0 && da[2] < 0)) return false;

  const n1 = norm(cross(sub(a1, a0), sub(a2, a0)));
  if (!n1) return false;
  const d1 = -dot(n1, a0);
  let db = [dot(n1, b0) + d1, dot(n1, b1) + d1, dot(n1, b2) + d1];
  for (let i = 0; i < 3; i++) if (Math.abs(db[i]) < eps) db[i] = 0;
  if ((db[0] > 0 && db[1] > 0 && db[2] > 0) || (db[0] < 0 && db[1] < 0 && db[2] < 0)) return false;

  if (da[0] === 0 && da[1] === 0 && da[2] === 0) {
    return includeCoplanar ? coplanarOverlap(n1, [a0, a1, a2], [b0, b1, b2]) : false;
  }
  // Both triangles cross the line where the planes meet; compare their intervals.
  const D = cross(n1, n2);
  const pv = (v) => dot(D, v);
  const ia = lineInterval([pv(a0), pv(a1), pv(a2)], da);
  const ib = lineInterval([pv(b0), pv(b1), pv(b2)], db);
  if (!ia || !ib) return false;
  const lo = Math.max(ia[0], ib[0]), hi = Math.min(ia[1], ib[1]);
  return hi - lo > eps;
}

/**
 * Sampled self-intersection count, in pairs of triangles that pass through each
 * other. Pairs sharing a welded vertex are skipped — neighbours touch by
 * definition. Returns pair count plus honest bookkeeping about what was skipped:
 * a quadratic answer on a 200k-triangle mesh is not worth having.
 */
export function selfIntersect(mesh, {
  weldEps = WELD_EPS, maxTris = 20000, maxPairTests = 4e6, maxPairs = 64,
  includeCoplanar = false, eps = 1e-9,
} = {}) {
  const w = weldedOf(asMesh(mesh), weldEps);
  const T = w.triCount;
  let subset = null, sampled = false;
  if (T > maxTris) {
    // Deterministic stride, not a random sample: analyze() must give the same
    // answer twice or it is useless as a gate.
    const stride = Math.ceil(T / maxTris);
    subset = [];
    for (let t = 0; t < T; t += stride) subset.push(t);
    sampled = true;
  }
  const grid = triGrid(w, { target: 4, subset });
  const p = w.positions;
  const va = [0, 0, 0], vb = [0, 0, 0], vc = [0, 0, 0], vd = [0, 0, 0], ve = [0, 0, 0], vf = [0, 0, 0];
  const fill = (out, t, k) => { const i = w.tris[t * 3 + k] * 3; out[0] = p[i]; out[1] = p[i + 1]; out[2] = p[i + 2]; return out; };
  const seen = new Set();
  const pairs = [];
  let count = 0, tests = 0, truncated = false;
  for (const arr of grid.map.values()) {
    const n = arr.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = arr[i], b = arr[j];
      const key = a < b ? a * T + b : b * T + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const a0 = w.tris[a * 3], a1 = w.tris[a * 3 + 1], a2 = w.tris[a * 3 + 2];
      const b0 = w.tris[b * 3], b1 = w.tris[b * 3 + 1], b2 = w.tris[b * 3 + 2];
      if (a0 === b0 || a0 === b1 || a0 === b2 || a1 === b0 || a1 === b1 || a1 === b2 ||
          a2 === b0 || a2 === b1 || a2 === b2) continue;
      if (++tests > maxPairTests) { truncated = true; break; }
      if (triTriIntersect(fill(va, a, 0), fill(vb, a, 1), fill(vc, a, 2),
                          fill(vd, b, 0), fill(ve, b, 1), fill(vf, b, 2), { eps, includeCoplanar })) {
        count++;
        if (pairs.length < maxPairs) pairs.push([a, b]);
      }
    }
    if (truncated) break;
  }
  return { count, pairs, sampled, truncated, tested: tests,
           checkedTris: subset ? subset.length : T, totalTris: T };
}

// ---------------------------------------------------------------------------
// printability geometry
// ---------------------------------------------------------------------------

/**
 * Overhang angle of a face, measured the way a slicer measures it: 0° is a
 * vertical wall, 90° is a flat ceiling. Up-facing geometry returns 0.
 */
export function overhangAngleDeg(normal) {
  const nz = Array.isArray(normal) || ArrayBuffer.isView(normal) ? normal[2] : normal;
  if (!(nz < 0)) return 0;
  return Math.asin(Math.min(1, -nz)) * DEG;
}

/**
 * Per-face overhang census.
 *
 * Faces lying entirely within the first layer are excluded: a flat bottom has a
 * straight-down normal, and counting it would make every printable object report
 * a 90° overhang. The bed holds it up — that area is reported as `plateArea`.
 *
 * The same argument applies one layer up. A face resting flush on another part —
 * a letter on a nameplate, a lid on a box, a divider dropped into a bin — points
 * straight down and is held up by the thing underneath it. Pass a `grid` and
 * those faces are counted as `contactArea` instead of as overhang, because
 * telling someone to add supports under a face that is already touching solid
 * plastic is advice that makes the tool less trusted, not more.
 *
 * The contact test is a parity ray per steep face and there is no cheaper
 * exact answer. "Skip it when the mesh is a single shell" was tried: a shell
 * is a vertex-connectivity fact, and a single shell can still pass through
 * itself — the lithophane's frame has 4 mm² of face buried inside its own
 * panel, unanimous in six ray directions — so the shortcut was wrong on the
 * catalogue and was removed. The ray itself is what got cheaper.
 */
export function faceOverhangs(mesh, { maxOverhang = 50, layerH = 0.2, plateTol = null, z0 = null, grid = null } = {}) {
  const m = asMesh(mesh);
  const b = m.bbox();
  const base = z0 === null ? b.min[2] : z0;
  const tol = plateTol === null ? Math.max(layerH, 1e-4) : plateTol;
  const T = m.triCount;
  // Float64, not Float32: worstOverhangDeg is compared against angles[worstTri]
  // by anything that wants to highlight the face, and a 32-bit round trip makes
  // the two disagree in the seventh digit.
  const angles = new Float64Array(T);
  const areas = new Float64Array(T);
  let overhangArea = 0, downArea = 0, plateArea = 0, totalArea = 0, worst = 0, worstTri = -1;
  let contactArea = 0;
  const probe = Math.max(layerH * 0.1, 1e-3);
  const c = [0, 0, 0];
  for (let t = 0; t < T; t++) {
    const a = m.triArea(t);
    areas[t] = a;
    if (!(a > 0)) continue;
    totalArea += a;
    const n = m.faceNormal(t);
    if (!(n[2] < 0)) continue;
    if (triMaxZ(m, t) <= base + tol) { plateArea += a; continue; }
    const ang = Math.asin(Math.min(1, -n[2])) * DEG;
    if (ang > maxOverhang && grid) {
      triCentroid(m, t, c);
      if (pointInsideMesh(grid, [c[0], c[1], c[2] - probe])) { angles[t] = 0; contactArea += a; continue; }
    }
    angles[t] = ang;
    downArea += a;
    if (ang > worst) { worst = ang; worstTri = t; }
    if (ang > maxOverhang) overhangArea += a;
  }
  return { angles, areas, overhangArea, downArea, plateArea, contactArea, totalArea, worst, worstTri,
           threshold: maxOverhang, mesh: m, base };
}

/**
 * Local wall thickness by probing inward from each face along its own normal.
 *
 * The alternative — a medial axis or a voxel distance field — is both slower and
 * harder to explain; a ray from the middle of a face is exactly the measurement
 * a caliper would take, and it is bounded (`probe`) so convex solids cost nothing.
 */
export function wallThickness(mesh, {
  minFeature = 0.8, weldEps = WELD_EPS, maxSamples = 8000, probe = null, grid = null, edgeMap = null,
} = {}) {
  const w = weldedOf(asMesh(mesh), weldEps);
  const T = w.triCount;
  const reach = probe === null ? Math.max(minFeature * 3, 2) : probe;
  const g = grid || triGrid(w, { target: 3 });
  const em = edgeMap || buildEdgeMap(w, { weldEps, welded: w });
  const stride = T > maxSamples ? Math.ceil(T / maxSamples) : 1;
  const thickness = new Float64Array(T).fill(Infinity);
  const partner = new Int32Array(T).fill(-1);
  const thin = new Uint8Array(T);
  const c = [0, 0, 0], dir = [0, 0, 0];
  let measured = 0, thinArea = 0, sampledArea = 0, totalArea = 0, minThickness = Infinity;
  for (let t = 0; t < T; t++) {
    const area = w.triArea(t);
    totalArea += area;
    if (t % stride !== 0 || !(area > 0)) continue;
    sampledArea += area;
    const n = w.faceNormal(t);
    triCentroid(w, t, c);
    dir[0] = -n[0]; dir[1] = -n[1]; dir[2] = -n[2];
    // Start a hair inside so the source face cannot be its own hit even when
    // the ray leaves at a glancing angle.
    const off = 1e-6;
    const o = [c[0] + dir[0] * off, c[1] + dir[1] * off, c[2] + dir[2] * off];
    const hit = rayMeshHit(g, o, dir, { maxT: reach, skip: t });
    measured++;
    if (!hit) continue;
    const th = hit.t + off;
    thickness[t] = th;
    partner[t] = hit.tri;
    if (th < minThickness) minThickness = th;
    if (th < minFeature) { thin[t] = 1; thinArea += area; }
  }
  // Group neighbouring thin faces into walls: "3 walls are 0.6 mm thick" is a
  // sentence somebody can act on; "412 thin triangles" is not.
  const clusters = [];
  if (stride === 1) {
    const seen = new Uint8Array(T);
    const stack = [];
    const V = w.vertCount;
    for (let seed = 0; seed < T; seed++) {
      if (!thin[seed] || seen[seed]) continue;
      stack.length = 0; stack.push(seed); seen[seed] = 1;
      let area = 0, tris = 0, sum = 0, minT = Infinity, maxT = 0, nzSum = 0, lowZ = Infinity, highZ = -Infinity;
      while (stack.length) {
        const t = stack.pop();
        tris++;
        const a = w.triArea(t);
        area += a; sum += thickness[t] * a;
        if (thickness[t] < minT) minT = thickness[t];
        if (thickness[t] > maxT) maxT = thickness[t];
        nzSum += Math.abs(w.faceNormal(t)[2]) * a;
        lowZ = Math.min(lowZ, triMinZ(w, t));
        highZ = Math.max(highZ, triMaxZ(w, t));
        for (let k = 0; k < 3; k++) {
          const e = em.edges.get(edgeKey(V, w.tris[t * 3 + k], w.tris[t * 3 + (k + 1) % 3]));
          if (!e) continue;
          const nb = [e.f0, e.f1].concat(e.more || []);
          for (const o of nb) if (o >= 0 && o !== t && thin[o] && !seen[o]) { seen[o] = 1; stack.push(o); }
        }
        // The face this one measured against is the other side of the SAME wall.
        // Without this the two faces of a 0.6 mm plate come back as two separate
        // findings and the user is told about one wall twice.
        const opp = partner[t];
        if (opp >= 0 && thin[opp] && !seen[opp]) { seen[opp] = 1; stack.push(opp); }
      }
      // A cluster with no area is a knot of degenerate triangles, not a wall:
      // its thickness would compute as 0/1e-12 = 0 and the user would be told
      // "0 mm² of surface forms a wall 0.00 mm thick" (the Skådis bin did,
      // 2026-09-03). Anything under one extrusion's footprint cannot be a wall
      // worth reporting; the degenerate-triangle warning already covers it.
      if (area < 0.25) continue;
      clusters.push({ tris, area, thickness: sum / Math.max(area, 1e-12), minThickness: minT,
                      maxThickness: maxT, vertical: nzSum / Math.max(area, 1e-12) > 0.7,
                      lowZ, highZ });
    }
    clusters.sort((a, b) => a.thickness - b.thickness);
  }
  const coverage = sampledArea > 0 && totalArea > 0 ? sampledArea / totalArea : 1;
  return {
    thickness, thin, partner, clusters: stride === 1 ? clusters : null,
    thinArea: stride === 1 ? thinArea : thinArea / Math.max(coverage, 1e-6),
    minThickness: Number.isFinite(minThickness) ? minThickness : null,
    measured, sampled: stride > 1, coverage, probe: reach, minFeature,
  };
}

/**
 * How far the middle of a ceiling sits from the nearest wall holding it up.
 *
 * Sampling triangle centroids is the obvious version and it is badly wrong for a
 * coarse mesh: a bridge modelled as two big triangles has both its centroids
 * near the supported corners, so a 20 mm span measures as 15. This rasterises
 * the region's XY footprint instead and asks the worst point on it, which is the
 * point the extruder actually has to reach across nothing.
 */
function ceilingReach(w, gr, anchors) {
  const p = w.positions;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of gr.tris) for (let k = 0; k < 3; k++) {
    const i = w.tris[t * 3 + k] * 3;
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  const nearest = (x, y) => {
    let best = Infinity;
    for (const a of anchors) {
      const d = (x - a[0]) * (x - a[0]) + (y - a[1]) * (y - a[1]);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  // Fall back to the sample points when the footprint is degenerate.
  let reach = 0;
  for (const q of gr.pts) reach = Math.max(reach, nearest(q[0], q[1]));
  const wSpan = maxX - minX, hSpan = maxY - minY;
  if (!(wSpan > 0) || !(hSpan > 0)) return reach;
  const n = Math.max(6, Math.min(32, Math.floor(Math.sqrt(60000 / Math.max(1, gr.tris.length)))));
  const inside = (x, y, t) => {
    const a = w.tris[t * 3] * 3, b = w.tris[t * 3 + 1] * 3, c = w.tris[t * 3 + 2] * 3;
    const d1 = (x - p[b]) * (p[a + 1] - p[b + 1]) - (p[a] - p[b]) * (y - p[b + 1]);
    const d2 = (x - p[c]) * (p[b + 1] - p[c + 1]) - (p[b] - p[c]) * (y - p[c + 1]);
    const d3 = (x - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (y - p[a + 1]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  for (let iy = 0; iy < n; iy++) {
    const y = minY + hSpan * (iy + 0.5) / n;
    for (let ix = 0; ix < n; ix++) {
      const x = minX + wSpan * (ix + 0.5) / n;
      let hit = false;
      for (const t of gr.tris) if (inside(x, y, t)) { hit = true; break; }
      if (!hit) continue;
      const d = nearest(x, y);
      if (d > reach) reach = d;
    }
  }
  return reach;
}

/**
 * Is this floating region held up by material in its own layer?
 *
 * The `descends` test asks "does a wall go down from one of my own vertices",
 * which is the bridge case and misses the cantilever completely. The underside
 * of an arm sticking out of a post is supported — but sideways, and its own
 * vertices are the lowest thing there is, so nothing descends from them and the
 * region reports as starting in mid-air. That misfire is not an edge case: on
 * this catalogue it accounted for every island ever reported, twenty out of
 * twenty, across five generators, at ERROR severity.
 *
 * Since the question is about a layer, it is asked about the layer. Flood the
 * region of solid at this height that contains the face and see whether any part
 * of that region rests on the layer below. That is the printer's own answer:
 * material laid in one pass is continuous, and continuous material touching
 * solid anywhere is held up by it.
 *
 * Geometric rather than topological on purpose. The shapes this fires on are
 * routinely separate interpenetrating shells — a letter merged onto a plate, a
 * bar merged onto a post — with no shared edges to walk, so following the mesh
 * would answer "not connected" about two solids that are plainly one object.
 *
 * Bounded twice over: the grid is sized from the part so the sweep cannot exceed
 * ~CAP cells whatever the model, and it stops at the first supported cell.
 */
function layerAnchored(w, g, gr, { layerH = 0.2, base = 0 } = {}) {
  const CAP = 40000;
  const b = w.bbox();
  const span = Math.max(b.size[0], b.size[1], 1);
  const step = Math.max(0.4, span / 180);
  const z = gr.lowZ + layerH * 0.5;
  const below = z - layerH;
  if (below <= base) return true;      // resting on the plate is support enough

  const x0 = b.min[0] - step, y0 = b.min[1] - step;
  const nx = Math.ceil((b.size[0] + 2 * step) / step) + 1;
  const ny = Math.ceil((b.size[1] + 2 * step) / step) + 1;
  const key = (i, j) => i * ny + j;
  const solidAt = (i, j, zz) => insideUnion(g, [x0 + i * step, y0 + j * step, zz]);

  // Seed on the region itself. A group can be non-convex, so try its own face
  // centroids rather than their average, which may land in a hole.
  let seed = null;
  for (const pt of gr.pts) {
    const i = Math.round((pt[0] - x0) / step), j = Math.round((pt[1] - y0) / step);
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    if (solidAt(i, j, z)) { seed = [i, j]; break; }
  }
  // Nothing to stand on and nothing to flood: leave the verdict to the caller.
  if (!seed) return false;

  const seen = new Set([key(seed[0], seed[1])]);
  const stack = [seed];
  let visited = 0;
  while (stack.length) {
    const [i, j] = stack.pop();
    if (++visited > CAP) return true;   // a region this large is attached to the object
    if (solidAt(i, j, below)) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, c = j + dj;
      if (a < 0 || c < 0 || a >= nx || c >= ny) continue;
      const k = key(a, c);
      if (seen.has(k)) continue;
      seen.add(k);
      if (solidAt(a, c, z)) stack.push([a, c]);
    }
  }
  return false;
}

/**
 * Regions of ceiling that hang over nothing.
 *
 * A face steeper than `ceilAngle` from vertical is sampled at four points; if
 * most of them have empty air all the way down to the plate the face is
 * floating. Floating faces are then grouped, and each group is asked whether any
 * of its own edge vertices has material descending from it: none means the group
 * starts in mid-air (a true island, supports or nothing), some means it is a
 * ceiling spanning between walls (a bridge, and `span` says how far).
 */
function floatingRegions(w, g, fo, em, { layerH = 0.2, ceilAngle = 60, base = 0, minSpan = 5, minArea = 0.08 } = {}) {
  const T = w.triCount, V = w.vertCount, p = w.positions;
  const cand = [];
  for (let t = 0; t < T; t++) if (fo.angles[t] > ceilAngle) cand.push(t);
  if (!cand.length) return { islands: [], bridges: [] };

  // Which vertices have material dropping away below them? One pass over the
  // edge list answers it for the whole mesh at once.
  const descends = new Uint8Array(V);
  for (const e of em.edges.values()) {
    const zu = p[e.u * 3 + 2], zv = p[e.v * 3 + 2];
    if (zu - zv > layerH) descends[e.u] = 1;
    else if (zv - zu > layerH) descends[e.v] = 1;
  }

  const floating = new Uint8Array(T);
  // A hit further down than this is not support: the nozzle still crosses a gap.
  const gap = Math.max(layerH * 2, 0.4);
  const o = [0, 0, 0], down = [0, 0, -1];
  const bary = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
  // The nearest support each floating face found within `gap`, or Infinity.
  // The rays are cast only that far: whether a face is held up is a question
  // about the next few tenths of a millimetre, not about the whole drop to the
  // plate, and a ray that stops after one grid cell costs a tenth of one that
  // marches through thirty. The full distance is measured later, and only for
  // the regions that are actually reported — that is the only place it is read.
  const nearShort = new Float64Array(T).fill(Infinity);
  const sample = (t, bc) => {
    const ia = w.tris[t * 3] * 3, ib = w.tris[t * 3 + 1] * 3, ic = w.tris[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) o[k] = p[ia + k] * bc[0] + p[ib + k] * bc[1] + p[ic + k] * bc[2];
    o[2] -= 1e-6;
    return o[2] - base + 1;                       // how far the plate is, plus one
  };
  for (const t of cand) {
    let miss = 0, near = Infinity;
    for (const bc of bary) {
      const drop = sample(t, bc);
      if (drop <= 0) { continue; }
      const hit = rayMeshHit(g, o, down, { maxT: Math.min(drop, gap + 1e-9), skip: t });
      // A downward ray from just under the face finds support that is BELOW it —
      // but it cannot see support that is level with it or wrapped around it,
      // because the supporting surface is then at or above the ray's origin.
      // That is the ordinary case for any object assembled from parts: letters
      // sitting on a plate, a lid stacked on a box, a divider dropped into a bin.
      // Without this second question every one of those reported as starting in
      // mid-air, which is how a validator teaches people to ignore it.
      if (!hit) {
        if (!pointInsideMesh(g, [o[0], o[1], o[2] - 1e-3])) miss++;
        else near = Math.min(near, 0);
      } else if (hit.t < near) near = hit.t;
    }
    if (miss * 2 >= bary.length) { floating[t] = 1; nearShort[t] = near; }
  }
  /** Distance from a floating face to whatever is beneath it, however far. */
  const nearFull = (t) => {
    let near = nearShort[t];
    if (near !== Infinity) return near;
    for (const bc of bary) {
      const drop = sample(t, bc);
      if (drop <= 0) continue;
      const hit = rayMeshHit(g, o, down, { maxT: drop, skip: t });
      if (hit && hit.t < near) near = hit.t;
    }
    return near;
  };
  const gapOf = (gr) => { let gp = Infinity; for (const t of gr.tris) { const n = nearFull(t); if (n < gp) gp = n; } return gp; };

  // Group the floating faces (shared welded vertex) into regions.
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let t = 0; t < T; t++) if (floating[t]) { join(w.tris[t * 3], w.tris[t * 3 + 1]); join(w.tris[t * 3 + 1], w.tris[t * 3 + 2]); }
  const groups = new Map();
  for (let t = 0; t < T; t++) {
    if (!floating[t]) continue;
    const r = find(w.tris[t * 3]);
    let gr = groups.get(r);
    if (!gr) groups.set(r, gr = { tris: [], area: 0, lowZ: Infinity, gap: Infinity, anchors: [], pts: [] });
    gr.tris.push(t);
    gr.area += w.triArea(t);
    gr.lowZ = Math.min(gr.lowZ, triMinZ(w, t));
    const c = triCentroid(w, t, [0, 0, 0]);
    gr.pts.push([c[0], c[1]]);
  }
  // A region that starts within a layer or two of the plate is the flare at the
  // bottom of a sphere or a fillet, not a ceiling: every ring of it is laid on
  // the one below and the OVERHANG figure already covers it. Reporting those as
  // bridges buries the one that matters under a dozen that do not.
  const nearPlate = base + Math.max(2 * layerH, 0.4);
  const islands = [], bridges = [];
  for (const gr of groups.values()) {
    if (gr.lowZ <= nearPlate) continue;
    // A region smaller than a single extrusion's footprint is degenerate
    // geometry, not a feature: it cannot start anything in mid-air because
    // there is nothing there to start. Three of this catalogue's twenty
    // reported islands had an area of 0.00 mm2.
    if (!(gr.area > minArea)) continue;
    const verts = new Set();
    for (const t of gr.tris) { verts.add(w.tris[t * 3]); verts.add(w.tris[t * 3 + 1]); verts.add(w.tris[t * 3 + 2]); }
    for (const v of verts) if (descends[v]) gr.anchors.push([p[v * 3], p[v * 3 + 1]]);
    if (!gr.anchors.length) {
      // Nothing descends from it — so it is a bridge with no walls, OR it is a
      // cantilever whose support is sideways. Only the layer can tell them apart.
      if (layerAnchored(w, g, gr, { layerH, base })) continue;
      islands.push({ area: gr.area, lowZ: gr.lowZ, tris: gr.tris.length, anchors: 0, span: Infinity, gap: gapOf(gr) });
      continue;
    }
    const reach = ceilingReach(w, gr, gr.anchors);
    // Under a few millimetres this is a stepped overhang, not a bridge.
    if (reach * 2 < minSpan) continue;
    bridges.push({ area: gr.area, lowZ: gr.lowZ, tris: gr.tris.length, anchors: gr.anchors.length, span: reach * 2, gap: gapOf(gr) });
  }
  islands.sort((a, b) => b.area - a.area);
  bridges.sort((a, b) => b.span - a.span);
  return { islands, bridges };
}

/** Grams, centimetres cubed and metres of 1.75 mm filament for a solid volume. */
export function estimateFilament(volumeMm3, {
  material = 'PLA', infill = 1, surfaceArea = 0, wallThickness: wallT = 0,
} = {}) {
  const key = String(material).toUpperCase();
  const known = Object.prototype.hasOwnProperty.call(FILAMENT_DENSITY, key);
  const density = known ? FILAMENT_DENSITY[key] : FILAMENT_DENSITY.PLA;
  const v = Math.max(0, volumeMm3 || 0);
  let solid = v;
  if (infill < 1) {
    // Walls print solid whatever the infill says, so take them off the top
    // before scaling the core — 15 % infill on a thin-walled box is nearly all
    // wall, and multiplying the whole volume by 0.15 would be a fantasy.
    const shell = surfaceArea > 0 && wallT > 0 ? Math.min(v, surfaceArea * wallT) : 0;
    solid = shell + (v - shell) * Math.max(0, infill);
  }
  const cm3 = solid / 1000;
  return {
    cm3, grams: cm3 * density, metres: solid / FILAMENT_AREA / 1000,
    density, material: known ? key : 'PLA', known, requested: String(material),
    solidMm3: solid, volumeCm3: v / 1000,
  };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

/**
 * Full topological report. `selfIntersect: true` adds the sampled
 * triangle/triangle pass; without it `selfIntersections` is null, not 0, because
 * "we did not look" and "we looked and found none" are different answers.
 */
export function analyze(mesh, opts = {}) {
  const {
    selfIntersect: doSelf = false, weldEps = WELD_EPS, degenerateArea = 1e-10,
    triWarnAt = 150000, selfIntersectOpts = {},
  } = opts;
  const m = asMesh(mesh);
  const warnings = [];
  const vertCount = m.vertCount, triCount = m.triCount;
  const bbox = m.bbox();

  const empty = {
    vertCount, triCount, manifold: false, watertight: false, boundaryEdges: 0,
    nonManifoldEdges: 0, nonManifoldVertices: 0, degenerateTris: 0, flippedTris: 0,
    inconsistentEdges: 0, inverted: false, shells: 0, eulerChar: 0, eulerRaw: 0,
    genus: null, volume: 0, area: 0, bbox, selfIntersections: null, holes: 0,
    boundaryLength: 0, edgeCount: 0, weldedVertCount: 0, weldedTriCount: 0, solid: false,
    unreferencedVerts: 0, shellInfo: [], warnings,
  };

  if (!triCount) {
    warn(warnings, 'EMPTY', 'error', vertCount
      ? `The mesh has ${vertCount} vertices but no triangles — there is no surface to print.`
      : 'The mesh is empty: no vertices and no triangles.');
    return empty;
  }
  let badIndex = 0;
  for (let i = 0; i < m.tris.length; i++) {
    const idx = m.tris[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= vertCount) badIndex++;
  }
  if (badIndex) {
    warn(warnings, 'BAD_INDEX', 'error',
      `${badIndex} triangle corner${s(badIndex)} point outside the vertex list (0…${vertCount - 1}). ` +
      `The index buffer and the position buffer disagree — nothing else can be measured until that is fixed.`);
    return Object.assign(empty, { volume: 0, area: 0 });
  }
  let nonFinite = 0;
  for (let i = 0; i < m.positions.length; i++) if (!Number.isFinite(m.positions[i])) nonFinite++;
  if (nonFinite) {
    warn(warnings, 'NON_FINITE', 'error',
      `${nonFinite} coordinate${s(nonFinite)} ${isA(nonFinite)} NaN or Infinity — usually a divide by zero in a ` +
      `generator (a radius or a segment count of 0). Every measurement below is unreliable.`);
  }

  const w = weldedOf(m, weldEps);
  const em = buildEdgeMap(m, { weldEps, welded: w });
  const shellData = shellsOf(m, { weldEps, welded: w });
  const or = orientationCheck(m, { edgeMap: em });
  const nmv = nonManifoldVertices(w);

  let slivers = 0;
  for (let t = 0; t < w.triCount; t++) if (!(w.triArea(t) > degenerateArea)) slivers++;
  const degenerateTris = (triCount - w.triCount) + slivers;

  const referenced = new Uint8Array(w.vertCount);
  for (let i = 0; i < w.tris.length; i++) referenced[w.tris[i]] = 1;
  let usedVerts = 0;
  for (let i = 0; i < referenced.length; i++) if (referenced[i]) usedVerts++;
  const unreferencedVerts = w.vertCount - usedVerts;

  const faces = w.triCount - em.degenerateTris;
  const eulerChar = usedVerts - em.edgeCount + faces;
  const eulerRaw = w.vertCount - em.edgeCount + faces;

  const watertight = em.boundaryEdges === 0;
  // w.triCount > 0 guards the mesh that welds away to nothing: no faces means no
  // boundary edges either, and every test below would call the void manifold.
  const manifold = w.triCount > 0 && watertight && em.nonManifoldEdges === 0 &&
                   em.inconsistentEdges === 0 && or.flippedTris === 0 && nmv === 0;
  const volume = m.volume();
  const area = m.surfaceArea();
  const genus = manifold ? (2 * shellData.count - eulerChar) / 2 : null;

  const loops = watertight ? [] : boundaryLoops(m, { edgeMap: em });
  const boundaryLength = loops.reduce((acc, l) => acc + l.length, 0);

  let si = null, siReport = null;
  if (doSelf) {
    siReport = selfIntersect(m, Object.assign({ weldEps }, selfIntersectOpts));
    si = siReport.count;
  }

  // ---- warnings, worst first --------------------------------------------
  if (!watertight) {
    const lowest = loops.length ? Math.min(...loops.map((l) => l.lowestZ)) : bbox.min[2];
    warn(warnings, 'BOUNDARY_EDGES', 'error',
      `The surface is open: ${em.boundaryEdges} edge${s(em.boundaryEdges)} ${isA(em.boundaryEdges)} used by only one ` +
      `triangle, forming ${loops.length} hole${s(loops.length)} with ${f1(boundaryLength)} mm of rim ` +
      `(lowest at z = ${f1(lowest)} mm). A slicer has to guess how to close ${loops.length === 1 ? 'it' : 'them'}, ` +
      `and the wall thickness there is undefined.`,
      { holes: loops.length, boundaryEdges: em.boundaryEdges, boundaryLength });
  }
  if (em.nonManifoldEdges) {
    warn(warnings, 'NON_MANIFOLD_EDGE', 'error',
      `${em.nonManifoldEdges} edge${s(em.nonManifoldEdges)} ${isA(em.nonManifoldEdges)} shared by 3 or more triangles ` +
      `(one is used by ${em.maxFanning}) — two solids fused along a face, or a fin with no thickness. ` +
      `Union the parts with csg.union() instead of merging them, or move them ${f2(0.01)} mm apart.`,
      { count: em.nonManifoldEdges, maxFanning: em.maxFanning });
  }
  if (or.flippedTris) {
    warn(warnings, 'FLIPPED_TRIS', 'error',
      `${or.flippedTris} of ${triCount} triangles ${isA(or.flippedTris)} wound backwards, so ${or.flippedTris === 1 ? 'its normal points' : 'their normals point'} ` +
      `into the solid across ${em.inconsistentEdges} edge${s(em.inconsistentEdges)}. The slicer will read a hole there. ` +
      `Re-wind ${or.flippedTris === 1 ? 'it' : 'them'} or rebuild the face — Mesh.addQuad(a,b,c,d) keeps the order right.`,
      { count: or.flippedTris, inconsistentEdges: em.inconsistentEdges });
  }
  if (or.inverted) {
    warn(warnings, 'INVERTED', 'error',
      `The surface is inside out: consistently wound, but the normals all point inward and the signed volume is ` +
      `${f1(volume)} mm³. Call mesh.flipped() — as it stands a slicer prints the mould, not the part.`,
      { volume });
  }
  if (or.nonOrientable) {
    warn(warnings, 'NON_ORIENTABLE', 'error',
      `${or.nonOrientable} edge${s(or.nonOrientable)} cannot be given a consistent winding at all (a Möbius-like ` +
      `twist, or two surfaces meeting the wrong way round). No re-winding fixes this; the surface has to be rebuilt.`);
  }
  if (nmv) {
    warn(warnings, 'NON_MANIFOLD_VERTEX', 'warn',
      `${nmv} vertex${nmv === 1 ? '' : 'es'} pinch${nmv === 1 ? 'es' : ''} two otherwise separate sheets of surface ` +
      `together at a single point (a bowtie). It slices, but the pinch has zero thickness and will come out as a ` +
      `hole or a blob — overlap the two lobes by at least ${f1(0.4)} mm instead.`, { count: nmv });
  }
  if (degenerateTris) {
    warn(warnings, 'DEGENERATE_TRIS', 'warn',
      `${degenerateTris} triangle${s(degenerateTris)} enclose no area (corners closer together than ` +
      `${weldEps} mm, or all three on one line). They confuse normals, STL face lists and every slicer's repair ` +
      `pass — mesh.weld(${weldEps}).dropDegenerate() removes them.`, { count: degenerateTris });
  }
  if (si) {
    warn(warnings, 'SELF_INTERSECTION', 'error',
      `${si} pair${s(si)} of triangles pass through each other` +
      (siReport.sampled ? ` (found in a ${siReport.checkedTris} of ${siReport.totalTris} triangle sample)` : '') +
      `. Slicers fill crossings by even-odd or by winding and the two disagree, so expect missing walls or ` +
      `doubled perimeters. Rebuild the overlap as a proper boolean.`, { count: si, sampled: siReport.sampled });
  }
  if (shellData.count > 1) {
    const largest = shellData.shells[0];
    const cavities = shellData.shells.filter((sh) => sh.volume < 0).length;
    warn(warnings, 'SHELLS', 'info',
      `${shellData.count} separate closed shells (largest ${f1(largest.volume / 1000)} cm³` +
      (cavities ? `, ${cavities} of them ${isA(cavities)} internal ${cavities === 1 ? 'cavity' : 'cavities'}` : '') +
      `). They slice as one object but print as ${shellData.count} unconnected pieces — check that is what you meant.`,
      { count: shellData.count });
  }
  if (manifold && genus > 0) {
    warn(warnings, 'GENUS', 'info',
      `Euler characteristic ${eulerChar}: a genus ${genus} surface, i.e. ${genus} hole${s(genus)} straight through ` +
      `the solid. Expected for a ring or a handle, a surprise for a box.`, { genus });
  }
  if (watertight && manifold && !(Math.abs(volume) > 1e-9)) {
    // A closed surface with no interior: two coincident sheets, or a generator
    // handed a height, radius or thickness of 0. It slices to nothing, silently.
    warn(warnings, 'ZERO_VOLUME', 'error',
      `The surface is closed but encloses no volume (${volume.toExponential(2)} mm³) — the faces lie on top of one ` +
      `another. Usually a parameter at 0: a height, a wall thickness or a radius. There is nothing here to slice.`,
      { volume });
  }
  if (unreferencedVerts) {
    warn(warnings, 'UNUSED_VERTS', 'info',
      `${unreferencedVerts} vertex${unreferencedVerts === 1 ? '' : 'es'} ${isA(unreferencedVerts)} not used by any ` +
      `triangle. Harmless, but they inflate the file and skew Euler arithmetic — mesh.compact() drops them.`,
      { count: unreferencedVerts });
  }
  if (triCount > triWarnAt) {
    warn(warnings, 'HIGH_TRI_COUNT', 'info',
      `${triCount} triangles (${f1(triCount * 50 / 1e6)} MB of binary STL). The browser preview will crawl above ` +
      `about ${triWarnAt}; drop the quality setting or the segment count if you do not need this detail.`);
  }
  if (manifold && watertight && volume > 0 && warnings.length === 0) {
    warn(warnings, 'OK', 'info',
      `Closed, manifold, consistently wound: ${triCount} triangles, ${shellData.count} shell, ` +
      `${f1(volume / 1000)} cm³, ${f1(area / 100)} cm² of surface.`);
  }

  return {
    vertCount, triCount, manifold, watertight,
    // `manifold` is the topological property: an inside-out cube is still a
    // manifold surface. `solid` is the one a generator gate wants — closed,
    // manifold, wound outward, enclosing something.
    solid: manifold && !or.inverted && volume > 0,
    boundaryEdges: em.boundaryEdges, nonManifoldEdges: em.nonManifoldEdges,
    nonManifoldVertices: nmv, degenerateTris, flippedTris: or.flippedTris,
    inconsistentEdges: em.inconsistentEdges, inverted: or.inverted,
    nonOrientable: or.nonOrientable, shells: shellData.count,
    eulerChar, eulerRaw, genus, volume, area, bbox,
    selfIntersections: si, selfIntersectReport: siReport,
    holes: loops.length, boundaryLength, boundaryLoops: loops,
    edgeCount: em.edgeCount, weldedVertCount: w.vertCount, weldedTriCount: w.triCount,
    unreferencedVerts, orientedVolume: or.orientedVolume,
    shellInfo: shellData.shells.map((sh) => ({ tris: sh.tris, volume: sh.volume, area: sh.area, min: sh.min, max: sh.max })),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// printability
// ---------------------------------------------------------------------------

/**
 * Everything that decides whether the A1 mini can make this, in the units the
 * printer works in. Defaults are that machine: 180 mm cube, 0.4 nozzle,
 * 0.2 layers, and 50° as the angle past which PLA needs help.
 */
export function printability(mesh, opts = {}) {
  const {
    bed = { x: 180, y: 180, z: 180 }, bedName = 'A1 mini',
    nozzle = 0.4, layerH = 0.2, minFeature = 0.8, maxOverhang = 50,
    material = 'PLA', infill = 1, perimeters = 2, weldEps = WELD_EPS,
    checkThickness = true, checkIslands = true, bridgeLimit = 25, minBridge = 5,
    minBedContact = 100, ceilAngle = 60,
  } = opts;

  const m = asMesh(mesh);
  const warnings = [];
  const bbox = m.bbox();
  const size = bbox.size;
  const height = size[2];
  const volume = m.volume();
  const area = m.surfaceArea();
  const wallT = Math.max(perimeters * nozzle, nozzle);
  const est = estimateFilament(volume, { material, infill, surfaceArea: area, wallThickness: wallT });
  const fits = size[0] <= bed.x && size[1] <= bed.y && size[2] <= bed.z;
  const layers = layerH > 0 ? Math.ceil(height / layerH) : 0;

  const base = {
    fitsBed: fits,
    footprint: { x: size[0], y: size[1], area: size[0] * size[1], bedContact: 0 },
    height, layers, bbox,
    overhangArea: 0, overhangPct: 0, worstOverhangDeg: 0,
    thinWallArea: 0, thinWalls: [], minThickness: null,
    unsupportedIslands: 0, islands: [], bridges: [], maxBridgeSpan: 0,
    estVolumeCm3: volume / 1000, estGrams: est.grams, estMetres: est.metres,
    material: est.material, density: est.density, surfaceAreaCm2: area / 100,
    nozzle, layerH, minFeature, maxOverhang, bed, warnings,
  };

  if (!m.triCount) {
    warn(warnings, 'EMPTY', 'error', 'Nothing to print: the mesh has no triangles.');
    return base;
  }

  const w = weldedOf(m, weldEps);
  const em = buildEdgeMap(m, { weldEps, welded: w });
  // Built before the overhang census, not after, because the census needs it to
  // tell a face resting on another part from a face hanging over nothing.
  const grid = triGrid(w, { target: 3 });
  const fo = faceOverhangs(w, { maxOverhang, layerH, z0: bbox.min[2], grid });
  base.footprint.bedContact = fo.plateArea;
  base.overhangArea = fo.overhangArea;
  base.overhangPct = fo.totalArea > 0 ? (fo.overhangArea / fo.totalArea) * 100 : 0;
  base.worstOverhangDeg = fo.worst;
  base.contactArea = fo.contactArea || 0;

  if (checkThickness) {
    const wt = wallThickness(w, { minFeature, weldEps, grid, edgeMap: em });
    base.thinWallArea = wt.thinArea;
    base.minThickness = wt.minThickness;
    base.thinWalls = wt.clusters || [];
    base.thicknessSampled = wt.sampled;
  }
  if (checkIslands) {
    const fr = floatingRegions(w, grid, fo, em, { layerH, ceilAngle, base: bbox.min[2], minSpan: minBridge });
    base.islands = fr.islands;
    base.bridges = fr.bridges;
    base.unsupportedIslands = fr.islands.length;
    base.maxBridgeSpan = fr.bridges.length ? fr.bridges[0].span : 0;
  }

  // ---- warnings ----------------------------------------------------------
  if (!(volume > 0)) {
    warn(warnings, 'NOT_SOLID', 'error',
      `The mesh does not enclose a positive volume (signed volume ${f1(volume)} mm³), so the weight and thickness ` +
      `figures below are meaningless. Run analyze() — it is either inside out or not closed.`);
  }
  if (em.boundaryEdges > 0) {
    // printability() is what the UI calls before slicing, and every measurement
    // below assumes a closed solid. Say so here rather than letting somebody read
    // a thickness off a mesh that has a hole in it.
    warn(warnings, 'NOT_WATERTIGHT', 'error',
      `${em.boundaryEdges} edge${s(em.boundaryEdges)} of the surface ${isA(em.boundaryEdges)} open, so this is not a ` +
      `solid: the thickness, weight and overhang figures below assume it is closed and are only as good as the ` +
      `slicer's guess at the hole. Run analyze() for where it is.`, { boundaryEdges: em.boundaryEdges });
  }
  if (!fits) {
    const over = [];
    if (size[0] > bed.x) over.push(`${f1(size[0] - bed.x)} mm too wide`);
    if (size[1] > bed.y) over.push(`${f1(size[1] - bed.y)} mm too deep`);
    if (size[2] > bed.z) over.push(`${f1(size[2] - bed.z)} mm too tall`);
    const fitScale = Math.min(bed.x / size[0], bed.y / size[1], bed.z / size[2]);
    warn(warnings, 'TOO_LARGE', 'error',
      `${f1(size[0])} × ${f1(size[1])} × ${f1(size[2])} mm — ${over.join(', ')} for the ${bedName}'s ` +
      `${f0(bed.x)} × ${f0(bed.y)} × ${f0(bed.z)} mm build volume. Scale to ${f0(Math.floor(fitScale * 100))} % ` +
      `or split it into ${Math.ceil(1 / fitScale)} parts and join them after printing.`,
      { size: size.slice(), fitScale });
  } else {
    const use = Math.max(size[0] / bed.x, size[1] / bed.y, size[2] / bed.z);
    if (use > 0.9) {
      warn(warnings, 'NEAR_BED_LIMIT', 'info',
        `Uses ${f0(use * 100)} % of the ${bedName}'s build volume (${f1(size[0])} × ${f1(size[1])} × ${f1(size[2])} mm). ` +
        `It fits, but there is ${f1(Math.min(bed.x - size[0], bed.y - size[1]))} mm of clearance for a brim.`);
    }
  }
  if (Math.abs(bbox.min[2]) > 1e-4) {
    const dz = bbox.min[2];
    warn(warnings, 'OFF_PLATE', dz > 0 ? 'warn' : 'error',
      dz > 0
        ? `The model floats ${f2(dz)} mm above the plate. Most slicers drop it silently, but the preview and any ` +
          `z-dependent generator parameter will be off by that much — call mesh.dropToPlate().`
        : `The model sinks ${f2(-dz)} mm below the plate, so that much of it will be cut off at slice time. ` +
          `Call mesh.dropToPlate().`, { minZ: dz });
  }
  if (fo.overhangArea > 0) {
    warn(warnings, 'OVERHANG', 'warn',
      `${f1(fo.overhangArea)} mm² of surface (${f1(base.overhangPct)} % of the model) leans past ${f0(maxOverhang)}°, ` +
      `the worst at ${f1(fo.worst)}° from vertical. Either switch supports on, or rotate the part so those faces ` +
      `point upward — at ${f1(fo.worst)}° the extrusion has ${f0(Math.min(99, Math.sin(fo.worst / DEG) * 100))} % of ` +
      `its width hanging over air.`,
      { overhangArea: fo.overhangArea, worst: fo.worst });
  } else if (fo.worst > 0) {
    warn(warnings, 'OVERHANG_OK', 'info',
      `Steepest overhang is ${f1(fo.worst)}° from vertical, inside the ${f0(maxOverhang)}° limit — no supports needed.`,
      { worst: fo.worst });
  }
  for (const cl of base.thinWalls.slice(0, 3)) {
    const th = cl.thickness;
    if (cl.vertical) {
      const n = Math.max(1, Math.round(th / layerH));
      warn(warnings, 'THIN_SLAB', 'warn',
        `A flat section (${f0(cl.area)} mm² of surface) is only ${f2(th)} mm thick in Z — ${n} layer${s(n)} at ` +
        `${f2(layerH)} mm. It will print, but it will flex like a crisp; ${f1(minFeature)} mm (${Math.ceil(minFeature / layerH)} layers) ` +
        `is the practical floor for anything that gets handled.`, { thickness: th, area: cl.area });
    } else {
      warn(warnings, 'THIN_WALL', 'warn',
        `${f0(cl.area)} mm² of surface forms a wall ${f2(th)} mm thick — thinner than two ` +
        `${f1(nozzle)} mm extrusions (${f1(2 * nozzle)} mm), so it prints as a single fragile line with no bond ` +
        `between inside and outside. Thicken it to at least ${f1(2 * nozzle)} mm.`,
        { thickness: th, area: cl.area, tris: cl.tris });
    }
  }
  if (base.thinWalls.length > 3) {
    warn(warnings, 'THIN_WALL_MORE', 'info',
      `${base.thinWalls.length - 3} further thin region${s(base.thinWalls.length - 3)} below ${f1(minFeature)} mm ` +
      `(${f0(base.thinWallArea)} mm² of thin surface in total).`);
  }
  if (base.thicknessSampled && base.thinWallArea > 0) {
    warn(warnings, 'THICKNESS_SAMPLED', 'info',
      `Thickness was measured on a sample of the triangles because the mesh is large; the ` +
      `${f0(base.thinWallArea)} mm² figure is an estimate.`);
  }
  for (const isl of base.islands.slice(0, 3)) {
    warn(warnings, 'UNSUPPORTED_ISLAND', 'error',
      `${f0(isl.area)} mm² of the model starts in mid-air at z = ${f1(isl.lowZ)} mm — ` +
      (Number.isFinite(isl.gap)
        ? `the nearest thing below it is ${f1(isl.gap)} mm down, so that layer has nothing to land on.`
        : `there is open air all the way to the plate beneath it.`) +
      ` Without supports the nozzle extrudes into space for the whole of that layer and the strands go where they ` +
      `like. Turn supports on, or rest the feature on the plate.`, { area: isl.area, z: isl.lowZ, gap: isl.gap });
  }
  if (base.islands.length > 3) {
    warn(warnings, 'UNSUPPORTED_ISLAND_MORE', 'error',
      `${base.islands.length - 3} more region${s(base.islands.length - 3)} start in mid-air.`);
  }
  for (const br of base.bridges.slice(0, 2)) {
    if (br.span > bridgeLimit) {
      warn(warnings, 'LONG_BRIDGE', 'warn',
        `A ceiling of ${f0(br.area)} mm² at z = ${f1(br.lowZ)} mm reaches ${f1(br.span / 2)} mm from the nearest ` +
        `wall — a bridge of roughly ${f0(br.span)} mm. Unsupported bridges past ${f0(bridgeLimit)} mm sag in the ` +
        `middle: slow that layer down, add a support, or split the span.`, { span: br.span, z: br.lowZ });
    } else {
      warn(warnings, 'BRIDGE', 'info',
        `A ceiling of ${f0(br.area)} mm² at z = ${f1(br.lowZ)} mm reaches ${f1(br.span / 2)} mm from the nearest ` +
        `wall — a bridge of roughly ${f0(br.span)} mm, short enough to print unsupported.`,
        { span: br.span, z: br.lowZ });
    }
  }
  if (volume > 0 && fo.plateArea < 1) {
    warn(warnings, 'NO_BED_CONTACT', 'error',
      `Nothing flat touches the plate: the model meets it along a point or an edge (${f2(fo.plateArea)} mm² of ` +
      `first-layer area). The first layer has nothing to stick to. Rotate it onto a face, add a raft, or slice a ` +
      `flat off the bottom.`, { bedContact: fo.plateArea });
  } else if (volume > 0 && fo.plateArea < minBedContact && height > 20) {
    warn(warnings, 'BED_CONTACT', 'warn',
      `Only ${f1(fo.plateArea)} mm² touches the plate for a part ${f1(height)} mm tall — that is a ${f0(height * height / Math.max(fo.plateArea, 1e-6))}:1 ` +
      `leverage on the first layer. Add a brim, or give it a wider foot.`, { bedContact: fo.plateArea });
  }
  const foot = Math.min(size[0], size[1]);
  if (foot > 0 && height / foot > 5 && height > 40) {
    warn(warnings, 'TALL_AND_THIN', 'warn',
      `${f1(height)} mm tall on a ${f1(size[0])} × ${f1(size[1])} mm footprint (${f1(height / foot)}:1). ` +
      `Expect ringing on the top half and a real chance of the part being knocked over — print it lying down if the ` +
      `overhangs allow, or add a brim.`);
  }
  if (!est.known) {
    warn(warnings, 'UNKNOWN_FILAMENT', 'info',
      `No density on file for "${est.requested}" — assuming PLA at ${f2(est.density)} g/cm³. Known: ` +
      `${Object.keys(FILAMENT_DENSITY).join(', ')}.`);
  }
  if (volume > 0) {
    warn(warnings, 'FILAMENT', 'info',
      `About ${f1(est.grams)} g of ${est.material} — ${f1(base.estVolumeCm3)} cm³ solid` +
      (infill < 1 ? ` at ${f0(infill * 100)} % infill (${f1(est.solidMm3 / 1000)} cm³ of plastic)` : '') +
      `, ${f1(est.metres)} m of 1.75 mm filament, ${layers} layers at ${f2(layerH)} mm.`,
      { grams: est.grams, layers });
  }

  return base;
}

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

/** One-screen plain-text summary of an analyze() or printability() result. */
export function formatReport(result, { title = null } = {}) {
  if (!result || !Array.isArray(result.warnings)) throw new TypeError('formatReport: expected an analyze()/printability() result');
  const lines = [];
  const isPrint = 'fitsBed' in result;
  const head = title || (isPrint ? 'printability' : 'mesh');
  if (isPrint) {
    lines.push(`${head}: ${f1(result.footprint.x)} × ${f1(result.footprint.y)} × ${f1(result.height)} mm, ` +
      `${f1(result.estVolumeCm3)} cm³, ${f1(result.estGrams)} g ${result.material}, ` +
      `${result.fitsBed ? 'fits the bed' : 'DOES NOT FIT'}`);
    lines.push(`  overhang ${f1(result.overhangArea)} mm² (worst ${f1(result.worstOverhangDeg)}°) · ` +
      `thin ${f0(result.thinWallArea)} mm² · islands ${result.unsupportedIslands} · ` +
      `bed contact ${f1(result.footprint.bedContact)} mm²`);
  } else {
    lines.push(`${head}: ${result.triCount} triangles, ${result.vertCount} vertices, ${result.shells} shell${s(result.shells)}, ` +
      `${f1(result.volume / 1000)} cm³, ${result.manifold ? 'manifold' : 'NOT manifold'}`);
    lines.push(`  boundary ${result.boundaryEdges} · non-manifold ${result.nonManifoldEdges} edges / ` +
      `${result.nonManifoldVertices} vertices · flipped ${result.flippedTris} · degenerate ${result.degenerateTris} · ` +
      `Euler ${result.eulerChar}${result.genus !== null ? ` (genus ${result.genus})` : ''}` +
      `${result.selfIntersections === null ? '' : ` · self-intersections ${result.selfIntersections}`}`);
  }
  const order = { error: 0, warn: 1, info: 2 };
  for (const wn of result.warnings.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))) {
    lines.push(`  ${wn.severity.padEnd(5)} ${wn.code.padEnd(22)} ${wn.message}`);
  }
  return lines.join('\n');
}

export default { analyze, printability, formatReport, worstSeverity, FILAMENT_DENSITY, WELD_EPS };
