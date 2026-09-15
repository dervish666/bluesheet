// The inspector's pipeline, written once and run in two places.
//
// `inspect-worker.js` runs it on a Worker thread, which is where a 30 MB STL
// must be parsed if the page is to keep painting; `inspect.js` runs the same
// function on the window thread only when the browser has no module workers.
// Same shape as build-core.js, for the same reason: a fallback that drifts from
// the real path is a fallback nobody has tested.
//
// Two requests. `inspect` takes the bytes of a file and answers with the truth
// about it — every finding carries its number, because "problems detected" has
// never once helped anybody at the printer. `repair` takes a mesh back, does
// the four things that can honestly be done to a broken STL (weld, drop
// degenerate triangles, remove stray shells, turn an inside-out solid right
// side out, close T-junctions), measures it again, and says what it did and
// what it could not.

import { Mesh } from '../kernel/mesh.js';
import { importSTL } from '../kernel/stl.js';
import { analyze, printability, shellsOf, estimateFilament, WELD_EPS } from '../kernel/validate.js';
import { parseProvenance } from '../kernel/provenance.js';
import { size3, cm3, grams, cost, count, pct } from './format.js';

/** Past this the thickness and island passes are skipped and the report says so. */
export const DEEP_TRI_LIMIT = 120_000;
/** A shell this small next to the main body is litter, not a part. */
export const STRAY_MIN_TRIS = 50;
export const STRAY_VOL_FRACTION = 0.01;
export const MIN_FEATURE = 0.8;
export const MAX_OVERHANG = 50;

const f0 = (v) => (Number.isFinite(v) ? v.toFixed(0) : String(v));
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const area = (v) => (Number.isFinite(v) ? v.toFixed(v < 10 ? 2 : 0) : String(v));
const s = (n) => (n === 1 ? '' : 's');
const isA = (n) => (n === 1 ? 'is' : 'are');
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export async function handle(msg, post) {
  try {
    if (msg.type === 'ping') return post({ type: 'pong', jobId: msg.jobId });
    if (msg.type === 'inspect') return doInspect(msg, post);
    if (msg.type === 'repair') return doRepair(msg, post);
    return post({ type: 'error', jobId: msg.jobId, error: `unknown request "${msg.type}"` });
  } catch (e) {
    post({ type: 'error', jobId: msg.jobId, error: String((e && e.message) || e || 'unknown failure') });
  }
}

/** meta by structured clone: no functions, typed arrays to plain arrays. */
export function plain(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol') return undefined;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.map(v => plain(v, depth + 1)).filter(v => v !== undefined);
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = plain(v, depth + 1);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return undefined;
}

// ---- inspect ---------------------------------------------------------------

function doInspect(msg, post) {
  const t0 = now();
  const u8 = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
  const provenance = parseProvenance(u8);
  const imported = importSTL(u8);              // throws a specific message on a bad file
  const info = imported.importInfo || {};
  // The file is measured where it will print: centred on the plate at z = 0.
  // Size, overhang, thickness and topology do not change under a translation;
  // the move itself is reported so nothing is hidden.
  const b0 = imported.bbox();
  const offset = [-b0.center[0], -b0.center[1], -b0.min[2]];
  const mesh = offset.some(v => Math.abs(v) > 1e-9) ? imported.place() : imported;
  const report = measure(mesh, msg);
  report.offset = offset;
  if (offset.some(v => Math.abs(v) > 1e-4)) {
    report.findings.push({
      code: 'PLACED', severity: 'info',
      text: `The file had the object at x ${f1(b0.center[0])}, y ${f1(b0.center[1])}, z ${f1(b0.min[2])} mm; ` +
            `it is measured and shown centred on the plate at z = 0.`,
    });
  }
  report.file = {
    name: msg.name || 'untitled.stl', bytes: u8.byteLength, format: info.format || null,
    solids: info.solids || 0, degenerateDropped: info.degenerate || 0, welded: info.welded || 0,
    warnings: (info.warnings || []).slice(),
  };
  report.provenance = provenance;
  report.repaired = false;
  report.ms = now() - t0;
  reply(post, 'inspected', msg.jobId, mesh, report);
}

/** Everything the report says, from one mesh. Plain data only. */
export function measure(mesh, opts = {}) {
  const bed = opts.bed || { x: 180, y: 180, z: 180 };
  const layerH = opts.layerH ?? 0.2;
  const infill = Number.isFinite(opts.infill) ? opts.infill : 1;
  const deep = mesh.triCount <= DEEP_TRI_LIMIT;
  const a = analyze(mesh, { selfIntersect: false });
  const p = printability(mesh, {
    bed, layerH, material: 'PLA', infill, minFeature: MIN_FEATURE, maxOverhang: MAX_OVERHANG,
    checkThickness: deep, checkIslands: deep,
  });
  const size = a.bbox.size;
  const findings = [];

  // --- closed? ---------------------------------------------------------------
  const loops = (a.boundaryLoops || []).map(l => ({
    edges: l.edges, length: l.length, lowestZ: l.lowestZ, highestZ: l.highestZ, closed: l.closed,
  }));
  if (a.watertight) {
    findings.push({ code: 'WATERTIGHT', severity: 'ok',
      text: `Watertight: all ${count(a.edgeCount)} edges are shared by exactly two triangles.` });
  } else {
    const lowest = loops.length ? Math.min(...loops.map(l => l.lowestZ)) : a.bbox.min[2];
    findings.push({ code: 'OPEN', severity: 'error', openEdges: a.boundaryEdges, loops: a.holes,
      text: `Not watertight: ${a.boundaryEdges} open edge${s(a.boundaryEdges)} forming ` +
            `${a.holes} boundary loop${s(a.holes)} (${f1(a.boundaryLength)} mm of rim, lowest at z = ${f1(lowest)} mm). ` +
            `A slicer has to guess how to close ${a.holes === 1 ? 'it' : 'them'}.` });
  }
  if (a.nonManifoldEdges) {
    findings.push({ code: 'NON_MANIFOLD', severity: 'error', edges: a.nonManifoldEdges,
      text: `${a.nonManifoldEdges} edge${s(a.nonManifoldEdges)} ${isA(a.nonManifoldEdges)} shared by three or more triangles — ` +
            `two solids fused along a face, or a fin with no thickness.` });
  }

  // --- wound the right way? --------------------------------------------------
  if (a.inverted) {
    findings.push({ code: 'INSIDE_OUT', severity: 'error', volume: a.volume, reversed: a.triCount,
      text: `Inside out: all ${count(a.triCount)} triangles face inward and the signed volume is ${f1(a.volume)} mm³. ` +
            `As it stands a slicer prints the mould, not the part. Repair flips it.` });
  } else if (a.flippedTris) {
    findings.push({ code: 'REVERSED', severity: 'error', reversed: a.flippedTris,
      text: `${a.flippedTris} of ${count(a.triCount)} triangles ${isA(a.flippedTris)} wound backwards, across ` +
            `${a.inconsistentEdges} edge${s(a.inconsistentEdges)}. The slicer reads a hole there.` });
  } else if (a.triCount) {
    findings.push({ code: 'ORIENTED', severity: 'ok',
      text: `Consistently wound: 0 reversed triangles, normals point outward.` });
  }
  if (a.nonOrientable) {
    findings.push({ code: 'NON_ORIENTABLE', severity: 'error', edges: a.nonOrientable,
      text: `${a.nonOrientable} edge${s(a.nonOrientable)} cannot be given a consistent winding at all; re-winding will not fix this.` });
  }
  if (a.degenerateTris) {
    findings.push({ code: 'DEGENERATE', severity: 'warn', tris: a.degenerateTris,
      text: `${a.degenerateTris} triangle${s(a.degenerateTris)} enclose${a.degenerateTris === 1 ? 's' : ''} no area ` +
            `(corners closer than ${WELD_EPS} mm, or collinear). Repair drops them.` });
  }
  if (a.nonManifoldVertices) {
    findings.push({ code: 'BOWTIE', severity: 'warn', vertices: a.nonManifoldVertices,
      text: `${a.nonManifoldVertices} vertex${a.nonManifoldVertices === 1 ? '' : 'es'} pinch${a.nonManifoldVertices === 1 ? 'es' : ''} ` +
            `two sheets of surface together at a point — zero thickness there.` });
  }

  // --- how many pieces? ------------------------------------------------------
  const shells = (a.shellInfo || []).map(sh => ({
    tris: sh.tris, volume: sh.volume, area: sh.area,
    size: [sh.max[0] - sh.min[0], sh.max[1] - sh.min[1], sh.max[2] - sh.min[2]],
    min: sh.min.slice(), max: sh.max.slice(),
  }));
  const largest = shells[0] || null;
  const strays = shells.slice(1).map((sh, i) => ({ ...sh, index: i + 1 }))
    .filter(sh => isStray(sh, largest));
  if (shells.length <= 1) {
    if (shells.length) findings.push({ code: 'ONE_SHELL', severity: 'ok', shells: 1,
      text: `One shell of ${count(shells[0].tris)} triangles.` });
  } else {
    const strayText = strays.length
      ? ` ${strays.length} of them ${isA(strays.length)} stray: ` +
        strays.slice(0, 3).map(sh => `${sh.tris} triangle${s(sh.tris)}, ${size3(sh.size)}, ${f2(Math.abs(sh.volume))} mm³`).join('; ') +
        (strays.length > 3 ? `; and ${strays.length - 3} more` : '') + `. Repair removes ${strays.length === 1 ? 'it' : 'them'}.`
      : ' None is small enough to call litter; they print as separate pieces.';
    findings.push({ code: 'SHELLS', severity: strays.length ? 'warn' : 'info', shells: shells.length, strays: strays.length,
      text: `${shells.length} separate shells: the largest is ${count(largest.tris)} triangles (${cm3(Math.abs(largest.volume))}).` + strayText });
  }

  // --- does it fit? ----------------------------------------------------------
  const over = { x: Math.max(0, size[0] - bed.x), y: Math.max(0, size[1] - bed.y), z: Math.max(0, size[2] - bed.z) };
  if (p.fitsBed) {
    const use = Math.max(size[0] / bed.x, size[1] / bed.y, size[2] / bed.z);
    findings.push({ code: 'FITS', severity: 'ok', size: size.slice(),
      text: `Fits the ${f0(bed.x)} × ${f0(bed.y)} × ${f0(bed.z)} mm bed: ${size3(size)} uses ${f0(use * 100)} % of it.` });
  } else {
    const parts = [];
    if (over.x) parts.push(`${f1(over.x)} mm too wide`);
    if (over.y) parts.push(`${f1(over.y)} mm too deep`);
    if (over.z) parts.push(`${f1(over.z)} mm too tall`);
    const fitScale = Math.min(bed.x / size[0], bed.y / size[1], bed.z / size[2]);
    findings.push({ code: 'TOO_LARGE', severity: 'error', size: size.slice(), over, fitScale,
      text: `Does not fit the ${f0(bed.x)} × ${f0(bed.y)} × ${f0(bed.z)} mm bed: ${size3(size)} is ${parts.join(', ')}. ` +
            `Scale to ${f0(Math.floor(fitScale * 100))} % or split it.` });
  }

  // --- what will it weigh? ---------------------------------------------------
  // The headline mass is the solid one — a property of the object, like its
  // volume. The slicer's infill setting gives a second figure when it is less
  // than 100 %, and the two are stated side by side rather than one silently
  // standing in for the other.
  const solidVolume = Math.abs(a.volume);
  const est = estimateFilament(solidVolume, { material: 'PLA', infill: 1 });
  const atInfill = infill < 1 ? estimateFilament(solidVolume, { material: 'PLA', infill, surfaceArea: a.area, wallThickness: 0.8 }) : null;
  const unreliable = !a.watertight;
  findings.push({ code: 'FILAMENT', severity: 'info', grams: est.grams, cost: costOf(est.grams), volume: solidVolume,
    gramsAtInfill: atInfill ? atInfill.grams : est.grams,
    text: `${grams(est.grams)} of PLA solid (${cm3(solidVolume)}), about ${cost(est.grams)}` +
          (atInfill ? `; at ${f0(infill * 100)} % infill roughly ${grams(atInfill.grams)}, ${cost(atInfill.grams)}` : '') +
          (a.inverted ? ' — measured on the flipped surface.' : unreliable ? ' — an estimate: the surface is open, so the volume is a guess.' : '.') });

  // --- overhangs -------------------------------------------------------------
  if (p.overhangArea > 0) {
    findings.push({ code: 'OVERHANG', severity: 'warn', area: p.overhangArea, pct: p.overhangPct, worst: p.worstOverhangDeg,
      text: `${f1(p.overhangArea)} mm² of surface (${pct(p.overhangPct)}) leans past ${MAX_OVERHANG}°, the worst at ` +
            `${f1(p.worstOverhangDeg)}° from vertical. Supports, or turn it over.` });
  } else if (p.worstOverhangDeg > 0) {
    findings.push({ code: 'OVERHANG_OK', severity: 'ok', worst: p.worstOverhangDeg,
      text: `Steepest overhang ${f1(p.worstOverhangDeg)}° from vertical — inside the ${MAX_OVERHANG}° limit.` });
  } else {
    findings.push({ code: 'OVERHANG_OK', severity: 'ok', worst: 0,
      text: `No overhangs: nothing faces downward above the first layer.` });
  }

  // --- thin walls, islands ---------------------------------------------------
  const thin = (p.thinWalls || []).map(cl => ({
    thickness: cl.thickness, minThickness: cl.minThickness, area: cl.area, tris: cl.tris,
    vertical: cl.vertical, lowZ: cl.lowZ, highZ: cl.highZ,
  }));
  if (!deep) {
    findings.push({ code: 'THICKNESS_SKIPPED', severity: 'info',
      text: `Wall thickness and islands were not measured: ${count(a.triCount)} triangles is over the ` +
            `${count(DEEP_TRI_LIMIT)} limit for the inline pass.` });
  } else if (thin.length) {
    for (const cl of thin.slice(0, 3)) {
      findings.push({ code: cl.vertical ? 'THIN_SLAB' : 'THIN_WALL', severity: 'warn', thickness: cl.thickness, area: cl.area,
        text: (cl.vertical
          ? `A flat section of ${area(cl.area)} mm² is only ${f2(cl.thickness)} mm thick in Z`
          : `A wall of ${area(cl.area)} mm² is ${f2(cl.thickness)} mm thick`) +
          ` (between z = ${f1(cl.lowZ)} and ${f1(cl.highZ)} mm) — under the ${f1(MIN_FEATURE)} mm floor.` });
    }
    if (thin.length > 3) findings.push({ code: 'THIN_MORE', severity: 'info', more: thin.length - 3,
      text: `${thin.length - 3} further region${s(thin.length - 3)} under ${f1(MIN_FEATURE)} mm (${f0(p.thinWallArea)} mm² thin in total).` });
  } else {
    findings.push({ code: 'WALLS_OK', severity: 'ok', minThickness: p.minThickness,
      text: Number.isFinite(p.minThickness)
        ? `No wall under ${f1(MIN_FEATURE)} mm; the thinnest measured is ${f2(p.minThickness)} mm.`
        : `No wall under ${f1(MIN_FEATURE)} mm.` });
  }
  for (const isl of (p.islands || []).slice(0, 3)) {
    findings.push({ code: 'ISLAND', severity: 'error', area: isl.area, z: isl.lowZ,
      text: `${f0(isl.area)} mm² starts in mid-air at z = ${f1(isl.lowZ)} mm` +
            (Number.isFinite(isl.gap) ? ` with ${f1(isl.gap)} mm of nothing beneath it.` : ' with open air to the plate.') });
  }

  return {
    triCount: a.triCount, vertCount: a.vertCount,
    bbox: { min: a.bbox.min.slice(), max: a.bbox.max.slice(), size: size.slice(), center: a.bbox.center.slice() },
    size: size.slice(),
    watertight: a.watertight, manifold: a.manifold, solid: a.solid,
    openEdges: a.boundaryEdges, loops: a.holes, boundaryLength: a.boundaryLength, boundaryLoops: loops,
    reversed: a.inverted ? a.triCount : a.flippedTris, inverted: a.inverted, flippedTris: a.flippedTris,
    nonManifoldEdges: a.nonManifoldEdges, degenerate: a.degenerateTris,
    shells: shells.length, shellInfo: shells, strays,
    volume: a.volume, area: a.area,
    fitsBed: p.fitsBed, over, bed: { x: bed.x, y: bed.y, z: bed.z },
    grams: est.grams, cost: costOf(est.grams), costText: cost(est.grams), infill,
    gramsAtInfill: atInfill ? atInfill.grams : est.grams,
    overhangArea: p.overhangArea, overhangPct: p.overhangPct, worstOverhangDeg: p.worstOverhangDeg,
    minThickness: p.minThickness, thinWalls: thin, thinWallArea: p.thinWallArea, deepChecked: deep,
    islands: (p.islands || []).length,
    findings,
    analysis: plain(stripLoops(a)),
    print: plain(p),
  };
}

function isStray(sh, largest) {
  if (!largest) return false;
  if (sh.tris < STRAY_MIN_TRIS) return true;
  const ref = Math.abs(largest.volume);
  return ref > 0 && Math.abs(sh.volume) < ref * STRAY_VOL_FRACTION;
}

function costOf(g) {
  return Number.isFinite(g) ? (g / 1000) * 18 : null;   // FILAMENT_PRICE_PER_KG, in pounds
}

/** boundaryLoops carry every rim vertex; the report does not need them twice. */
function stripLoops(a) {
  const { boundaryLoops, selfIntersectReport, ...rest } = a;
  return rest;
}

// ---- repair ----------------------------------------------------------------

function doRepair(msg, post) {
  const t0 = now();
  let m = Mesh.fromArrays(Array.from(msg.positions), Array.from(msg.tris));
  const before = measure(m, msg);
  const did = [];

  // 1. weld
  const v0 = m.vertCount, t1 = m.triCount;
  m = m.weld(WELD_EPS);
  const welded = v0 - m.vertCount;
  let degenerate = t1 - m.triCount;
  if (welded) did.push(`Welded ${count(welded)} duplicate vertices (within ${WELD_EPS} mm) into shared ones.`);

  // 2. degenerate triangles
  const t2 = m.triCount;
  m = m.dropDegenerate();
  degenerate += t2 - m.triCount;
  if (degenerate) did.push(`Dropped ${degenerate} degenerate triangle${s(degenerate)} that enclosed no area.`);

  // 3. stray shells
  const sh = shellsOf(m, { welded: m });
  if (sh.count > 1) {
    const largest = sh.shells[0];
    const strayIdx = new Set();
    for (let i = 1; i < sh.shells.length; i++) if (isStray(sh.shells[i], largest)) strayIdx.add(i);
    if (strayIdx.size) {
      const keep = [];
      let removedTris = 0, removedVol = 0;
      for (let t = 0; t < m.triCount; t++) {
        if (strayIdx.has(sh.labels[t])) { removedTris++; continue; }
        keep.push(m.tris[t * 3], m.tris[t * 3 + 1], m.tris[t * 3 + 2]);
      }
      for (const i of strayIdx) removedVol += Math.abs(sh.shells[i].volume);
      m = new Mesh(m.positions.slice(), keep).compact();
      did.push(`Removed ${strayIdx.size} stray shell${s(strayIdx.size)} (${removedTris} triangle${s(removedTris)}, ${f2(removedVol)} mm³ in all).`);
    }
  }

  // 4. inside out
  let a = analyze(m, { selfIntersect: false });
  if (a.inverted) {
    m = m.flipped();
    did.push(`Flipped the surface right side out: signed volume ${f1(a.volume)} mm³ → ${f1(-a.volume)} mm³.`);
    a = analyze(m, { selfIntersect: false });
  }

  // 5. T-junctions
  if (a.boundaryEdges) {
    const openBefore = a.boundaryEdges;
    const healed = m.healTJunctions(WELD_EPS);
    const a2 = analyze(healed, { selfIntersect: false });
    if (a2.boundaryEdges < openBefore) {
      m = healed;
      a = a2;
      did.push(`Closed ${openBefore - a2.boundaryEdges} open edge${s(openBefore - a2.boundaryEdges)} at T-junctions.`);
    }
  }
  m = m.compact();

  const after = measure(m, msg);
  const couldNot = [];
  if (after.openEdges) {
    couldNot.push(`${after.openEdges} open edge${s(after.openEdges)} in ${after.loops} loop${s(after.loops)} ` +
      `(${f1(after.boundaryLength)} mm of rim) remain. A missing face cannot be invented here; close it in the model that made this.`);
  }
  if (after.flippedTris) {
    couldNot.push(`${after.flippedTris} triangle${s(after.flippedTris)} ${isA(after.flippedTris)} still wound against ` +
      `${after.flippedTris === 1 ? 'its' : 'their'} neighbours; only a whole inside-out solid is flipped here.`);
  }
  if (after.nonManifoldEdges) {
    couldNot.push(`${after.nonManifoldEdges} edge${s(after.nonManifoldEdges)} still ${isA(after.nonManifoldEdges)} shared by three or more triangles.`);
  }
  const bowties = after.analysis.nonManifoldVertices || 0;
  if (bowties) couldNot.push(`${bowties} bowtie vert${bowties === 1 ? 'ex remains' : 'ices remain'} — zero-thickness pinches that need the model reworked.`);
  if (!did.length) did.push('Nothing needed changing: no duplicate vertices, no degenerate triangles, no stray shells, wound outward.');

  const report = after;
  report.repaired = true;
  report.repair = {
    did, couldNot,
    before: summary(before), after: summary(after),
    ms: now() - t0,
  };
  report.file = msg.file || null;
  report.provenance = msg.provenance || null;
  report.offset = [0, 0, 0];
  reply(post, 'repaired', msg.jobId, m, report);
}

function summary(r) {
  return {
    triangles: r.triCount, vertices: r.vertCount, openEdges: r.openEdges, loops: r.loops,
    reversed: r.reversed, shells: r.shells, degenerate: r.degenerate, nonManifoldEdges: r.nonManifoldEdges,
    volume: r.volume, watertight: r.watertight, manifold: r.manifold, solid: r.solid,
  };
}

// ---- reply -----------------------------------------------------------------

function reply(post, type, jobId, mesh, report) {
  const positions = Float64Array.from(mesh.positions);
  const tris = Uint32Array.from(mesh.tris);
  const render = mesh.toRenderBuffers({ crease: 35 });
  post({
    type, jobId, report, positions, tris, render,
    bbox: plain(mesh.bbox()), triCount: mesh.triCount, vertCount: mesh.vertCount,
  }, [positions.buffer, tris.buffer, render.positions.buffer, render.normals.buffer, render.indices.buffer]);
}
