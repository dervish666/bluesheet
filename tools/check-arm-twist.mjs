// Does the quarter-turn actually turn anything?
//
// A twisted arm and a flat one have the same footprint, the same part count and
// the same clean topology, so every cheap signal reads "fine" whether or not the
// twist happened at all. This measures the thing that would be missing.
//
// Nothing here is told where anything is. Both measurements work off the mesh
// as a pile of triangles projected along an axis:
//
//   HOLES. A grid point covered by no triangle has no material anywhere along
//   that line. Flood the empty points; the component reaching the border is the
//   outside world, and every other one is a through-hole. A bore along Y IS the
//   twist, so a build that quietly stopped twisting would show two Z holes and
//   no Y hole. That the same code returns 0 for a flat arm and 1 for a twisted
//   one is what stops "no holes along Y" from being a vacuous pass.
//
//   FACES. At a point covered by triangles, the largest coordinate among them is
//   the top surface. Walk a circle in the toothed annulus and that traces the
//   face you actually clamp against: it must swing between exactly two planes,
//   `teeth` times round, mirrored on the far side. This is deliberately blind to
//   vertices — an earlier version counted rim vertices and was defeated by the
//   CSG splitting edges and by the bar passing a hub radius from the axis.
import gen from '../js/gen/arm.js';
import { topology } from '../tests/lib/meshcheck.mjs';

const ctx = { quality: 'normal', segFactor: 1, bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4, layerH: 0.2, log() {}, progress() {} };
const D = {}; for (const q of gen.params) D[q.key] = typeof q.def === 'function' ? q.def() : q.def;

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const AXES = { x: [1, 2], y: [0, 2], z: [0, 1] };
const IDX = { x: 0, y: 1, z: 2 };

/**
 * The mesh seen down one axis: triangles flattened, bucketed by column, and
 * asked at a point for how much material is over it and where its surfaces are.
 */
function project(mesh, axis, cell = 2) {
  const [u, v] = AXES[axis], w = IDX[axis];
  const P = mesh.positions, T = mesh.tris, n = T.length / 3;
  const tri = new Float64Array(n * 9), bb = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const p = T[i * 3 + k] * 3;
      tri[i * 9 + k * 3] = P[p + u]; tri[i * 9 + k * 3 + 1] = P[p + v]; tri[i * 9 + k * 3 + 2] = P[p + w];
    }
    const ax = tri[i * 9], ay = tri[i * 9 + 1], bx = tri[i * 9 + 3], by = tri[i * 9 + 4], cx = tri[i * 9 + 6], cy = tri[i * 9 + 7];
    bb[i * 4] = Math.min(ax, bx, cx); bb[i * 4 + 1] = Math.max(ax, bx, cx);
    bb[i * 4 + 2] = Math.min(ay, by, cy); bb[i * 4 + 3] = Math.max(ay, by, cy);
  }
  const box = mesh.bbox();
  const u0 = box.min[u] - 3, v0 = box.min[v] - 3;
  const nu = Math.ceil((box.max[u] - u0 + 3) / cell), nv = Math.ceil((box.max[v] - v0 + 3) / cell);
  const bucket = Array.from({ length: nu * nv }, () => []);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, Math.floor((bb[i * 4] - u0) / cell)), b = Math.min(nu - 1, Math.floor((bb[i * 4 + 1] - u0) / cell));
    const c = Math.max(0, Math.floor((bb[i * 4 + 2] - v0) / cell)), d = Math.min(nv - 1, Math.floor((bb[i * 4 + 3] - v0) / cell));
    for (let x = a; x <= b; x++) for (let y = c; y <= d; y++) bucket[y * nu + x].push(i);
  }
  const at = (pu, pv) => {
    const x = Math.floor((pu - u0) / cell), y = Math.floor((pv - v0) / cell);
    if (x < 0 || y < 0 || x >= nu || y >= nv) return { n: 0, max: -Infinity, min: Infinity };
    let hits = 0, hi = -Infinity, lo = Infinity;
    for (const i of bucket[y * nu + x]) {
      if (pu < bb[i * 4] || pu > bb[i * 4 + 1] || pv < bb[i * 4 + 2] || pv > bb[i * 4 + 3]) continue;
      const ax = tri[i * 9], ay = tri[i * 9 + 1], az = tri[i * 9 + 2];
      const bx = tri[i * 9 + 3], by = tri[i * 9 + 4], bz = tri[i * 9 + 5];
      const cx = tri[i * 9 + 6], cy = tri[i * 9 + 7], cz = tri[i * 9 + 8];
      const d1 = (pu - bx) * (ay - by) - (ax - bx) * (pv - by);
      const d2 = (pu - cx) * (by - cy) - (bx - cx) * (pv - cy);
      const d3 = (pu - ax) * (cy - ay) - (cx - ax) * (pv - ay);
      if (((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))) continue;
      // Barycentric interpolation of the third coordinate at (pu, pv).
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      let z;
      if (Math.abs(den) < 1e-12) z = Math.max(az, bz, cz);          // edge-on triangle
      else {
        const l1 = ((by - cy) * (pu - cx) + (cx - bx) * (pv - cy)) / den;
        const l2 = ((cy - ay) * (pu - cx) + (ax - cx) * (pv - cy)) / den;
        z = l1 * az + l2 * bz + (1 - l1 - l2) * cz;
      }
      hits++; if (z > hi) hi = z; if (z < lo) lo = z;
    }
    return { n: hits, max: hi, min: lo };
  };
  return { at, box, u, v, w };
}

/** Every through-hole down `axis`, as the grid sees it. */
function holesAlong(mesh, axis, step = 0.3) {
  const pr = project(mesh, axis);
  const [u, v] = AXES[axis];
  const u0 = pr.box.min[u] - 2, u1 = pr.box.max[u] + 2, v0 = pr.box.min[v] - 2, v1 = pr.box.max[v] + 2;
  const nu = Math.ceil((u1 - u0) / step), nv = Math.ceil((v1 - v0) / step);
  const empty = new Uint8Array(nu * nv);
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      if (pr.at(u0 + (iu + 0.5) * step, v0 + (iv + 0.5) * step).n === 0) empty[iv * nu + iu] = 1;
    }
  }
  const seen = new Uint8Array(nu * nv);
  const stack = [];
  for (let iu = 0; iu < nu; iu++) stack.push(iu, iu + (nv - 1) * nu);
  for (let iv = 0; iv < nv; iv++) stack.push(iv * nu, iv * nu + nu - 1);
  const spread = (c, push) => {
    const iu = c % nu, iv = (c - iu) / nu;
    if (iu > 0) push(c - 1);
    if (iu < nu - 1) push(c + 1);
    if (iv > 0) push(c - nu);
    if (iv < nv - 1) push(c + nu);
  };
  while (stack.length) {
    const c = stack.pop();
    if (seen[c] || !empty[c]) continue;
    seen[c] = 1;
    spread(c, (e) => stack.push(e));
  }
  const holes = [];
  for (let c = 0; c < empty.length; c++) {
    if (!empty[c] || seen[c]) continue;
    let su = 0, sv = 0, area = 0;
    const q = [c]; seen[c] = 1;
    while (q.length) {
      const d = q.pop(), iu = d % nu, iv = (d - iu) / nu;
      su += u0 + (iu + 0.5) * step; sv += v0 + (iv + 0.5) * step; area++;
      spread(d, (e) => { if (empty[e] && !seen[e]) { seen[e] = 1; q.push(e); } });
    }
    // A grid this coarse finds specks in concave corners; a bolt hole is not one.
    const r = Math.sqrt(area * step * step / Math.PI);
    if (r > 1) holes.push({ axis, u: su / area, v: sv / area, r });
  }
  return holes.sort((a, b) => a.u - b.u);
}

/**
 * The mating face itself: walk a circle in the toothed annulus and read the
 * surface off both sides.
 *
 * Returns the two planes the face swings between, how many times round it does
 * so, and the same for the underside. Small errors in the centre do not matter
 * much — the serration is radial, so crest and root sit at the same height at
 * every radius in the annulus — but they are not free either: the centre comes
 * off a 0.3 mm grid, and being a few hundredths out means a sample lands just up
 * the flank from the true root. Hence a stated tolerance rather than exactness.
 *
 * Deliberately NOT compared sample-by-sample against the underside. A tooth
 * flank is a quad between two radial lines at different heights, which is not
 * planar, and the two faces are wound oppositely so the CSG splits that quad on
 * opposite diagonals. Mid-flank the two surfaces differ by 0.36 mm — an artefact
 * of toothedDisc that predates any of this and reads the same on every hub, flat
 * or standing. What must match, and does exactly, is where the planes are.
 */
function measureFace(mesh, centre, axis, rho, teeth) {
  const pr = project(mesh, axis);
  const [u, v] = AXES[axis];
  const n = teeth * 8;
  const top = [], bot = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI * 2 * k / n;
    const s = pr.at(centre[u] + rho * Math.cos(a), centre[v] + rho * Math.sin(a));
    if (!s.n) return null;
    top.push(s.max); bot.push(s.min);
  }
  const crest = Math.max(...top), root = Math.min(...top);
  const uCrest = Math.min(...bot), uRoot = Math.max(...bot);
  const mid = (crest + uCrest) / 2;
  const line = (crest + root) / 2;
  let rises = 0;
  for (let k = 0; k < n; k++) if (top[k] < line && top[(k + 1) % n] >= line) rises++;
  return {
    crest: crest - mid, root: root - mid, depth: crest - root, teeth: rises, mid,
    // The underside, measured the same way and expected to mirror it plane for plane.
    skew: Math.max(Math.abs((crest - mid) + (uCrest - mid)), Math.abs((root - mid) + (uRoot - mid))),
  };
}

const hubR = D.hubD / 2;
const boreR = 5.5 / 2;                                  // M5, the default bolt
const rFlat = 9.5 / 2 + 1.2;                            // clear of the M5 head
const rho = (rFlat + hubR) / 2;                         // mid-annulus, in the teeth
const wantCrest = D.coreT / 2 + D.toothH, wantRoot = D.coreT / 2;

// 0.02 mm: the centre comes off a 0.3 mm grid, so a sample can sit slightly up
// the flank from the true root. Every failure this check exists to catch — no
// twist, the wrong face, the wrong tooth count — is orders of magnitude larger.
const TOL = 0.02;
const faceOk = (f) => !!f && Math.abs(f.crest - wantCrest) < TOL && Math.abs(f.root - wantRoot) < TOL
  && Math.abs(f.depth - D.toothH) < TOL && f.teeth === D.teeth && f.skew < TOL;
const faceStr = (f) => f
  ? `crest ${f.crest.toFixed(4)} root ${f.root.toFixed(4)} (wanted ${wantCrest}/${wantRoot}), depth ${f.depth.toFixed(4)}, ${f.teeth} teeth, faces differ by ${f.skew.toFixed(4)}`
  : 'no face found';
const centreOf = (h) => { const c = []; const [u, v] = AXES[h.axis]; c[u] = h.u; c[v] = h.v; return c; };
const partsOf = (over) => gen.build({ ...D, ...over }, ctx).parts;

console.log('a flat arm: two bores, both along Z');
{
  const [arm] = partsOf({ part: 'arm', armCount: 1, armTwist: 0 });
  const z = holesAlong(arm.mesh, 'z'), y = holesAlong(arm.mesh, 'y');
  ok('two through-holes along Z', z.length === 2, `found ${z.length}`);
  ok('none along Y', y.length === 0, `found ${y.length}`);
  ok('both bores are M5', z.every(h => Math.abs(h.r - boreR) < 0.25), z.map(h => h.r.toFixed(2)).join(', '));
  ok('bores are armLength apart', z.length === 2 && Math.abs(Math.abs(z[1].u - z[0].u) - D.armLength) < 0.15,
    z.length === 2 ? `${Math.abs(z[1].u - z[0].u).toFixed(3)} mm, wanted ${D.armLength}` : 'n/a');
  const faces = z.map(h => measureFace(arm.mesh, centreOf(h), 'z', rho, D.teeth));
  ok('both hubs present a full serrated face', faces.length === 2 && faces.every(faceOk), faces.map(faceStr).join('  |  '));
}

console.log('a twisted arm: one bore along Z, one along Y');
{
  const [arm] = partsOf({ part: 'arm', armCount: 1, armTwist: 1 });
  const z = holesAlong(arm.mesh, 'z'), y = holesAlong(arm.mesh, 'y');
  ok('one through-hole along Z', z.length === 1, `found ${z.length}`);
  ok('one through-hole along Y — the twist itself', y.length === 1, `found ${y.length}`);
  ok('both are M5', [...z, ...y].every(h => Math.abs(h.r - boreR) < 0.25), [...z, ...y].map(h => h.r.toFixed(2)).join(', '));
  if (z.length === 1 && y.length === 1) {
    const flatX = z[0].u, upX = y[0].u;             // both are the X of an axis
    ok('the two axes are armLength apart along the bar', Math.abs(Math.abs(upX - flatX) - D.armLength) < 0.15,
      `${Math.abs(upX - flatX).toFixed(3)} mm, wanted ${D.armLength}`);
    const flatZ = measureFace(arm.mesh, centreOf(z[0]), 'z', rho, D.teeth).mid;
    const upZ = y[0].v;
    ok('the standing hub sits clear above the bar', upZ - flatZ > hubR, `${(upZ - flatZ).toFixed(3)} mm above the bar's mid-plane`);
    // The one that matters. Whatever bolts onto the standing hub is itself a
    // full disc of the same radius, arriving along the bolt — so if the rim dips
    // below the top face of the bar, the mating disc has to pass through the bar
    // to get there. Built with the disc resting on the plate this was 5.70 mm of
    // solid interference over a 23.5 mm chord, and every other check still passed.
    ok('a mating hub can actually reach it', (upZ - hubR) - (flatZ + D.coreT / 2) > 0,
      `rim clears the bar by ${((upZ - hubR) - (flatZ + D.coreT / 2)).toFixed(2)} mm`);
  }
  const flat = z.length === 1 ? measureFace(arm.mesh, centreOf(z[0]), 'z', rho, D.teeth) : null;
  const up = y.length === 1 ? measureFace(arm.mesh, centreOf(y[0]), 'y', rho, D.teeth) : null;
  ok('the flat hub is untouched by the twist', faceOk(flat), faceStr(flat));
  ok('the standing hub is the same face, only stood up', faceOk(up), faceStr(up));
  ok('so the two are interchangeable', flat && up && Math.abs(flat.crest - up.crest) < TOL
    && Math.abs(flat.root - up.root) < TOL && flat.teeth === up.teeth,
    flat && up ? `${flat.teeth} teeth, crest ${flat.crest.toFixed(4)} both` : 'n/a');
}

console.log('a wrist: one of each, and nothing between them but clearance');
{
  const [w] = partsOf({ part: 'wrist' });
  const z = holesAlong(w.mesh, 'z'), y = holesAlong(w.mesh, 'y');
  ok('one through-hole along Z', z.length === 1, `found ${z.length}`);
  ok('one through-hole along Y', y.length === 1, `found ${y.length}`);
  if (z.length === 1 && y.length === 1) {
    const span = Math.abs(y[0].u - z[0].u);
    ok('the hubs clear each other', span > hubR + 1, `${span.toFixed(2)} mm apart, hub radius ${hubR}`);
    ok('and are not needlessly far apart', span < 2 * hubR + 6, `${span.toFixed(2)} mm`);
    const flatZ = measureFace(w.mesh, centreOf(z[0]), 'z', rho, D.teeth).mid;
    ok('a mating hub can reach the standing one', (y[0].v - hubR) - (flatZ + D.coreT / 2) > 0,
      `rim clears the fin by ${((y[0].v - hubR) - (flatZ + D.coreT / 2)).toFixed(2)} mm`);
  }
  const a = z.length === 1 ? measureFace(w.mesh, centreOf(z[0]), 'z', rho, D.teeth) : null;
  const b = y.length === 1 ? measureFace(w.mesh, centreOf(y[0]), 'y', rho, D.teeth) : null;
  ok('the flat hub is a full mating face', faceOk(a), faceStr(a));
  ok('the standing hub is a full mating face', faceOk(b), faceStr(b));
}

console.log('the extremes, where coincident surfaces live');
{
  const sweeps = [];
  for (const teeth of [8, 60]) sweeps.push({ teeth });
  for (const hubD of [14, 70]) sweeps.push({ hubD });
  for (const coreT of [2.5, 14]) sweeps.push({ coreT });
  for (const toothH of [0.3, 4]) sweeps.push({ toothH });
  for (const armW of [6, 60]) sweeps.push({ armW });
  for (const bolt of ['m4', 'm6']) sweeps.push({ bolt });
  sweeps.push({ armLength: 30 }, { armLength: 200 }, { teeth: 17 }, { hubD: 14, coreT: 2.5, toothH: 0.3 });
  let bad = 0, minZ = Infinity;
  for (const s of sweeps) {
    let parts;
    try { parts = partsOf({ ...s, part: 'all', armCount: 1, armTwist: 1, wrist: 1 }); }
    catch (e) { console.log(`  FAIL ${JSON.stringify(s)} threw — ${e.message}`); bad++; continue; }
    if (!parts.some(p => p.name === 'wrist') || !parts.some(p => p.name === 'arm')) {
      console.log(`  FAIL ${JSON.stringify(s)} did not produce both a wrist and an arm`); bad++;
    }
    for (const p of parts) {
      const t = topology(p.mesh);
      if (t.boundary || t.nonManifold || t.inconsistent) {
        console.log(`  FAIL ${JSON.stringify(s)} ${p.name}: bnd ${t.boundary} nonman ${t.nonManifold} inc ${t.inconsistent}`);
        bad++;
      }
      minZ = Math.min(minZ, p.mesh.bbox().min[2]);
    }
  }
  ok(`every twisted set is a closed solid at the extremes (${sweeps.length} builds)`, bad === 0, `${bad} defect(s)`);
  ok('nothing dips below the plate', minZ > -1e-6, `lowest ${minZ.toFixed(6)} mm`);
}

console.log(fails ? `arm twist: ${fails} FAILED` : 'arm twist: ok');
process.exit(fails ? 1 : 0);
