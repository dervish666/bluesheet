// Shared mesh assertions — the four things every generator must get right.
// Kept separate from assert.mjs so it can import the kernel without making the
// primitives depend on it.
import { check, near, nearPct } from './assert.mjs';
import { Mesh } from '../../js/kernel/mesh.js';

// Topology check that does not depend on validate.js — the two must agree, which
// is itself a cross-check between two independently written implementations.
export function topology(mesh) {
  const w = mesh.weld(1e-5);
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < w.triCount; t++) {
    const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const dir = u < v ? 1 : -1;
      const e = edges.get(key) || { count: 0, net: 0 };
      e.count++; e.net += dir;
      edges.set(key, e);
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const e of edges.values()) {
    if (e.count === 1) boundary++;
    else if (e.count > 2) nonManifold++;
    else if (e.net !== 0) inconsistent++;   // both halves same direction => flipped neighbour
  }
  return { boundary, nonManifold, inconsistent, degenerate, edges: edges.size,
           verts: w.vertCount, tris: w.triCount,
           euler: w.vertCount - edges.size + w.triCount };
}

export function isSolid(label, mesh, opts = {}) {
  const t = topology(mesh);
  let ok = true;
  ok &= check(`${label}: watertight (no boundary edges)`, t.boundary === 0, `${t.boundary} boundary edges of ${t.edges}`);
  ok &= check(`${label}: manifold (no edge shared by >2 tris)`, t.nonManifold === 0, `${t.nonManifold} non-manifold edges`);
  ok &= check(`${label}: consistent winding`, t.inconsistent === 0, `${t.inconsistent} inconsistently wound edges`);
  ok &= check(`${label}: no degenerate triangles`, t.degenerate === 0, `${t.degenerate} degenerate`);
  ok &= check(`${label}: positive volume (normals point out)`, mesh.volume() > 0, `volume ${mesh.volume().toFixed(3)} mm³`);
  if (opts.euler !== undefined) ok &= check(`${label}: Euler characteristic ${opts.euler}`, t.euler === opts.euler, `got ${t.euler}`);
  return !!ok;
}

export function onPlate(label, mesh, tol = 1e-6) {
  const b = mesh.bbox();
  return check(`${label}: rests on the build plate`, Math.abs(b.min[2]) <= tol, `min z = ${b.min[2]}`);
}

export function centredXY(label, mesh, tol = 1e-3) {
  const b = mesh.bbox();
  return check(`${label}: centred in X/Y`,
    Math.abs(b.center[0]) <= tol && Math.abs(b.center[1]) <= tol,
    `centre (${b.center[0].toFixed(4)}, ${b.center[1].toFixed(4)})`);
}

export function fitsBed(label, mesh, bed = { x: 180, y: 180, z: 180 }) {
  const s = mesh.bbox().size;
  return check(`${label}: fits the A1 mini bed`,
    s[0] <= bed.x && s[1] <= bed.y && s[2] <= bed.z,
    `${s.map(v => v.toFixed(1)).join(' × ')} mm`);
}

export function deterministic(label, buildFn) {
  const a = buildFn(), b = buildFn();
  const sa = a.toSTL('t'), sb = b.toSTL('t');
  let same = sa.length === sb.length;
  if (same) for (let i = 84; i < sa.length; i++) if (sa[i] !== sb[i]) { same = false; break; }
  return check(`${label}: deterministic (identical STL across two builds)`, same,
    `${sa.length} vs ${sb.length} bytes`);
}

// Monte-Carlo volume: shoot rays and integrate, independent of the signed-volume
// formula, so a sign or winding error cannot pass both.
export function volumeByRays(mesh, samples = 4000, seed = 12345) {
  const b = mesh.bbox();
  let rng = seed >>> 0;
  const rnd = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
  const tris = mesh.triCount;
  let inside = 0;
  for (let s = 0; s < samples; s++) {
    const px = b.min[0] + rnd() * b.size[0];
    const py = b.min[1] + rnd() * b.size[1];
    const pz = b.min[2] + rnd() * b.size[2];
    let hits = 0;
    for (let t = 0; t < tris; t++) {
      const i0 = mesh.tris[t * 3] * 3, i1 = mesh.tris[t * 3 + 1] * 3, i2 = mesh.tris[t * 3 + 2] * 3;
      const p = mesh.positions;
      // ray +Z from (px,py,pz): 2D point-in-triangle in XY, then z of the plane
      const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2];
      const bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2];
      const cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const zh = l1 * az + l2 * bz + l3 * cz;
      if (zh > pz) hits++;
    }
    if (hits & 1) inside++;
  }
  return (inside / samples) * b.size[0] * b.size[1] * b.size[2];
}

export function volumeAgrees(label, mesh, tolPct = 6, samples = 4000) {
  const analytic = mesh.volume();
  const mc = volumeByRays(mesh, samples);
  const d = Math.abs(analytic - mc) / Math.max(1e-9, analytic) * 100;
  return check(`${label}: signed volume agrees with ray-cast volume`, d <= tolPct,
    `signed ${analytic.toFixed(2)} vs raycast ${mc.toFixed(2)} mm³ (${d.toFixed(1)}% apart)`);
}

export { Mesh };
