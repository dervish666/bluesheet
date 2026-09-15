// Hand-built meshes for tests, so a test never depends on the module it is
// meant to be independent of. Deliberately written with raw addVertex/addTri —
// if builders.js is broken these still work, which is the point.
import { Mesh } from '../../js/kernel/mesh.js';

const TAU = Math.PI * 2;

export function cube(s = 10, { at = [0, 0, 0] } = {}) {
  const m = new Mesh();
  const h = s / 2;
  const v = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]]
    .map(p => m.addVertex(p[0] + at[0], p[1] + at[1], p[2] + at[2]));
  for (const q of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]]) m.addQuad(...q.map(i => v[i]));
  return m;
}

export function tetra(s = 10) {
  const m = new Mesh();
  const v = [[0,0,0],[s,0,0],[0,s,0],[0,0,s]].map(p => m.addVertex(...p));
  m.addTri(v[0], v[2], v[1]); m.addTri(v[0], v[1], v[3]);
  m.addTri(v[1], v[2], v[3]); m.addTri(v[0], v[3], v[2]);
  return m;
}

/** Icosphere — genus 0, Euler 2, volume ~= 4/3 pi r^3 as subdivision rises. */
export function icosphere(r = 10, subdiv = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],
               [t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]];
  let faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
               [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map(), out = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (mid.has(key)) return mid.get(key);
      const p = [(verts[a][0]+verts[b][0])/2, (verts[a][1]+verts[b][1])/2, (verts[a][2]+verts[b][2])/2];
      verts.push(p); mid.set(key, verts.length - 1); return verts.length - 1;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = out;
  }
  const m = new Mesh();
  for (const p of verts) { const l = Math.hypot(...p); m.addVertex(p[0]/l*r, p[1]/l*r, p[2]/l*r); }
  for (const f of faces) m.addTri(f[0], f[1], f[2]);
  return m;
}

/** Torus — genus 1, Euler 0. Volume = 2 pi^2 R r^2. */
export function torus(R = 10, r = 3, major = 48, minor = 24) {
  const m = new Mesh();
  for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) {
    const u = i / major * TAU, v = j / minor * TAU;
    m.addVertex((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v));
  }
  const id = (i, j) => (i % major) * minor + (j % minor);
  for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++)
    m.addQuad(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
  return m;
}

export function cylinder(r = 5, h = 10, segments = 48) {
  const m = new Mesh();
  const bot = [], top = [];
  for (let i = 0; i < segments; i++) {
    const a = i / segments * TAU;
    bot.push(m.addVertex(Math.cos(a) * r, Math.sin(a) * r, 0));
    top.push(m.addVertex(Math.cos(a) * r, Math.sin(a) * r, h));
  }
  const cb = m.addVertex(0, 0, 0), ct = m.addVertex(0, 0, h);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    m.addQuad(bot[i], bot[j], top[j], top[i]);
    m.addTri(cb, bot[j], bot[i]);
    m.addTri(ct, top[i], top[j]);
  }
  return m;
}

/** A closed solid under a z = f(x,y) surface, walls and a flat base. */
export function heightfieldSolid(n = 20, size = 40, fn = (x, y) => 3 + 2 * Math.sin(x / 6) * Math.cos(y / 6)) {
  const m = new Mesh();
  const top = [], bot = [];
  for (let i = 0; i <= n; i++) { top.push([]); bot.push([]); }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const x = -size / 2 + size * i / n, y = -size / 2 + size * j / n;
    top[i][j] = m.addVertex(x, y, fn(x, y));
    bot[i][j] = m.addVertex(x, y, 0);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    m.addQuad(top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]);
    m.addQuad(bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]);
  }
  for (let i = 0; i < n; i++) {
    m.addQuad(top[i][0], bot[i][0], bot[i + 1][0], top[i + 1][0]);
    m.addQuad(top[i + 1][n], bot[i + 1][n], bot[i][n], top[i][n]);
    m.addQuad(bot[0][i], top[0][i], top[0][i + 1], bot[0][i + 1]);
    m.addQuad(bot[n][i + 1], top[n][i + 1], top[n][i], bot[n][i]);
  }
  return m;
}

// ---- deliberately broken meshes, for testing the validator -----------------
export function openCube(s = 10) { const m = cube(s); return new Mesh(m.positions.slice(), m.tris.slice(0, m.tris.length - 3)); }
export function flippedFaceCube(s = 10) {
  const m = cube(s), t = m.tris.slice();
  [t[3], t[4]] = [t[4], t[3]];
  return new Mesh(m.positions.slice(), t);
}
export function insideOutCube(s = 10) { return cube(s).flipped(); }
export function twoShells(s = 10, gap = 30) { return Mesh.merge([cube(s), cube(s, { at: [gap, 0, 0] })]); }
export function nonManifoldPair(s = 10) { return Mesh.merge([cube(s), cube(s, { at: [s, 0, 0] })]).weld(1e-6); }
export function degenerateCube(s = 10) {
  const m = cube(s);
  const v = m.addVertex(0, 0, 0);
  m.addTri(v, v, v);
  return m;
}

export const all = { cube, tetra, icosphere, torus, cylinder, heightfieldSolid };
