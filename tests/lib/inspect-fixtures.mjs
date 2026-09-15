// Deliberately broken STLs for the inspector (gate A1, G3).
//
//   node tests/lib/inspect-fixtures.mjs          writes tests/fixtures/inspect/*.stl
//
// Six small binary files, each wrong in exactly one way the report must name
// with its number: a cube missing its top (4 open edges, 1 loop); a cube wound
// inside out (negative volume, all 12 triangles reversed); a cube with a 0.5 mm
// tetrahedron floating beside it (2 shells, the stray one 4 triangles); a 300 mm
// cube (120 mm too big on every axis for a 180 mm bed); a tray with 0.3 mm walls;
// and a wedge whose underside leans 70° from vertical. Plus a clean 20 mm cube as
// the control, and — at test time only, never committed — a ~30 MB heightfield.
//
// The binary writer here is its own, not the kernel's exporter: a fixture that
// exercised the code under test to make itself would prove less.

import { writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mesh } from '../../js/kernel/mesh.js';
import { box } from '../../js/kernel/builders.js';
import { subtract } from '../../js/kernel/csg.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'fixtures', 'inspect');

export const BED = 180;
export const CUBE = 20;
export const GIANT = 300;
export const WALL = 0.3;
export const OVERHANG_DEG = 70;
export const STRAY_EDGE = 0.5;

/** Binary STL bytes from a Mesh; the header names the fixture, not Bluesheet. */
export function toBinarySTL(mesh, name) {
  const n = mesh.triCount;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(`inspect fixture: ${name}`.slice(0, 80).padEnd(80, ' '), 0, 80, 'latin1');
  buf.writeUInt32LE(n, 80);
  let o = 84;
  const p = mesh.positions, t = mesh.tris;
  for (let i = 0; i < n; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8); o += 12;
    for (const v of [a, b, c]) {
      buf.writeFloatLE(p[v], o); buf.writeFloatLE(p[v + 1], o + 4); buf.writeFloatLE(p[v + 2], o + 8); o += 12;
    }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

/** A mesh wound so its signed volume is positive, whatever order it was built in. */
function outward(m) { return m.volume() < 0 ? m.flipped() : m; }

function cube(size) { return outward(box(size, size, size)); }

export function holesCube() {
  // A 20 mm cube without its top face: the two triangles at z = size go.
  const m = cube(CUBE);
  const keep = [];
  for (let t = 0; t < m.triCount; t++) {
    const zs = [0, 1, 2].map(k => m.positions[m.tris[t * 3 + k] * 3 + 2]);
    if (zs.every(z => Math.abs(z - CUBE) < 1e-9)) continue;
    keep.push(m.tris[t * 3], m.tris[t * 3 + 1], m.tris[t * 3 + 2]);
  }
  return new Mesh(m.positions.slice(), keep);
}

export function insideOutCube() { return cube(CUBE).flipped(); }

export function strayShellCube() {
  const m = cube(CUBE);
  // A regular tetrahedron of edge 0.5 mm, 30 mm off to the side, resting on the plate.
  const e = STRAY_EDGE, h = e * Math.sqrt(2 / 3);
  const tet = new Mesh();
  const p0 = tet.addVertex(30, 0, 0), p1 = tet.addVertex(30 + e, 0, 0);
  const p2 = tet.addVertex(30 + e / 2, e * Math.sqrt(3) / 2, 0);
  const p3 = tet.addVertex(30 + e / 2, e * Math.sqrt(3) / 6, h);
  tet.addTri(p0, p2, p1); tet.addTri(p0, p1, p3); tet.addTri(p1, p2, p3); tet.addTri(p2, p0, p3);
  return Mesh.merge([m, outward(tet)]);
}

export function giantCube() { return cube(GIANT); }

export function thinWallTray() {
  // 20 × 20 × 10 mm open-top tray, 0.3 mm walls and floor.
  const outer = box(CUBE, CUBE, 10);
  const inner = box(CUBE - 2 * WALL, CUBE - 2 * WALL, 10, { z0: WALL });   // pokes out of the top: open tray
  return outward(subtract(outer, inner));
}

export function overhangWedge() {
  // Cross-section in XZ: (0,0) (10,0) (10 + 10·tan70°, 10) (0,10), extruded 10 mm in Y.
  // The face from (10,0) up to (37.5,10) has its normal pointing down and out at
  // 70° from vertical — a slicer measures overhang the same way.
  const run = 10 * Math.tan(OVERHANG_DEG * Math.PI / 180);
  const xz = [[0, 0], [10, 0], [10 + run, 10], [0, 10]];
  const m = new Mesh();
  const front = xz.map(([x, z]) => m.addVertex(x, 0, z));
  const back = xz.map(([x, z]) => m.addVertex(x, 10, z));
  m.addQuad(front[0], front[1], front[2], front[3]);
  m.addQuad(back[3], back[2], back[1], back[0]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    m.addQuad(front[j], front[i], back[i], back[j]);
  }
  return outward(m);
}

export function cleanCube() { return cube(CUBE); }

export const FIXTURES = {
  'holes-cube': holesCube,
  'inside-out-cube': insideOutCube,
  'stray-shell': strayShellCube,
  'giant-cube': giantCube,
  'thin-walls': thinWallTray,
  'overhang-wedge': overhangWedge,
  'clean-cube': cleanCube,
};

export function writeFixtures(dir = FIXTURE_DIR) {
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [name, make] of Object.entries(FIXTURES)) {
    const mesh = make();
    const path = join(dir, `${name}.stl`);
    writeFileSync(path, toBinarySTL(mesh, name));
    out[name] = { path, triCount: mesh.triCount };
  }
  return out;
}

/**
 * A closed heightfield solid of at least `minBytes`, streamed straight to disk.
 * Not committed: 30 MB of triangles is a test input, not source. Returns the
 * triangle count so the test can check the parser read every one.
 */
export function writeLarge(path, minBytes = 30_000_000) {
  const N = Math.ceil(Math.sqrt((minBytes - 84) / 50 / 2)) + 4;   // grid cells per side
  const size = 100, base = 3, amp = 2;
  const zAt = (i, j) => base + amp * (1 + Math.sin(i * 0.15) * Math.cos(j * 0.11)) / 2;
  const xAt = (i) => -size / 2 + size * i / N;
  // The bottom is a fan from the centre to every perimeter vertex, not two big
  // triangles: a long edge with wall vertices sitting on it is a T-junction,
  // and this file is meant to be big, not broken.
  const tris = N * N * 2 + N * 4 + N * 4 * 2;
  const fd = openSync(path, 'w');
  const header = Buffer.alloc(84);
  header.write('inspect fixture: large heightfield'.padEnd(80, ' '), 0, 80, 'latin1');
  header.writeUInt32LE(tris, 80);
  writeSync(fd, header);
  const CHUNK = 4096;
  const buf = Buffer.alloc(CHUNK * 50);
  let n = 0, written = 0;
  const flush = () => { writeSync(fd, buf, 0, n * 50); written += n; n = 0; };
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    let o = n * 50;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8); o += 12;
    for (const v of [a, b, c]) { buf.writeFloatLE(v[0], o); buf.writeFloatLE(v[1], o + 4); buf.writeFloatLE(v[2], o + 8); o += 12; }
    buf.writeUInt16LE(0, o);
    if (++n === CHUNK) flush();
  };
  const top = (i, j) => [xAt(i), xAt(j), zAt(i, j)];
  const bot = (i, j) => [xAt(i), xAt(j), 0];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      tri(top(i, j), top(i + 1, j), top(i + 1, j + 1));
      tri(top(i, j), top(i + 1, j + 1), top(i, j + 1));
    }
  }
  const centre = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    // The perimeter walked clockwise seen from above, so each fan triangle faces -Z.
    tri(centre, bot(i + 1, 0), bot(i, 0));          // y = min edge, x increasing
    tri(centre, bot(N, i + 1), bot(N, i));          // x = max edge, y increasing
    tri(centre, bot(N - i - 1, N), bot(N - i, N));  // y = max edge, x decreasing
    tri(centre, bot(0, N - i - 1), bot(0, N - i));  // x = min edge, y decreasing
  }
  for (let i = 0; i < N; i++) {
    // y = min edge (j = 0), facing -Y
    tri(bot(i, 0), bot(i + 1, 0), top(i + 1, 0)); tri(bot(i, 0), top(i + 1, 0), top(i, 0));
    // y = max edge (j = N), facing +Y
    tri(bot(i + 1, N), bot(i, N), top(i, N)); tri(bot(i + 1, N), top(i, N), top(i + 1, N));
    // x = min edge (i = 0), facing -X
    tri(bot(0, i + 1), bot(0, i), top(0, i)); tri(bot(0, i + 1), top(0, i), top(0, i + 1));
    // x = max edge (i = N), facing +X
    tri(bot(N, i), bot(N, i + 1), top(N, i + 1)); tri(bot(N, i), top(N, i + 1), top(N, i));
  }
  flush();
  closeSync(fd);
  if (written !== tris) throw new Error(`writeLarge: wrote ${written} triangles, header says ${tris}`);
  return { path, triCount: tris, bytes: 84 + tris * 50, grid: N };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = writeFixtures();
  for (const [name, f] of Object.entries(out)) console.log(`${name.padEnd(18)} ${String(f.triCount).padStart(5)} tris  ${f.path}`);
}
