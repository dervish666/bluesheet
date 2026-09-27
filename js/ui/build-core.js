// The geometry pipeline, written once and run in two places.
//
// Everything expensive lives here: the generator's build(), the crease-aware
// render buffers, analyze(), printability() and the STL. `build-worker.js` runs
// it on a Worker thread — which is where it runs in every browser that has
// module workers — and `build-local.js` runs the identical code on the window
// thread when it does not.
//
// Two files calling the same function rather than two implementations of the
// same protocol: a fallback path that drifts from the real one is a fallback
// that has never been tested.
//
// Several replies per job, deliberately. The mesh goes back the moment it
// exists so the preview updates; the analysis follows in stages as each lands.
// Waiting for a wall-thickness pass before showing the object would make a
// 0.2 s rebuild feel like a 2 s one — and between any two stages a newer build
// is allowed to take over, so a finger on a stepper is never waiting on the
// census of a shape it has already left.

import { Mesh } from '../kernel/mesh.js';
import { analyze, printability } from '../kernel/validate.js';
import { canonicalise } from '../kernel/provenance.js';

export const SEG_FACTOR = { draft: 0.5, normal: 1, fine: 2 };

/* Past this the thickness and island passes cost more than they are worth
   during an interactive edit; they are still available on demand. */
const DEEP_CHECK_TRI_LIMIT = 120_000;

const modules = new Map();
let last = null;                 // { key, genId, mesh, meta }
let latestBuildJob = 0;          // the newest build request seen; older ones skip their analysis
const pendingGo = new Map();     // jobId -> resolve(bool): builds waiting to be told to analyse

/** Yield one task so a message that arrived during the analysis is handled first. */
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** Handle one request. `post(msg, transferables)` sends a reply. Never throws:
 *  a failure comes back as an `error` message so the caller always settles. */
export async function handle(msg, post) {
  try {
    if (msg.type === 'ping') return post({ type: 'pong', jobId: msg.jobId });
    if (msg.type === 'analyse') { const go = pendingGo.get(msg.jobId); if (go) go(true); return; }
    if (msg.type === 'build') return await doBuild(msg, post);
    if (msg.type === 'stl') return await doSTL(msg, post);
    if (msg.type === 'bambu') return await doBambu(msg, post);
    if (msg.type === 'deep') return await doDeep(msg, post);
    return post({ type: 'error', jobId: msg.jobId, error: `unknown request "${msg.type}"` });
  } catch (e) {
    // A file request's waiter listens for stlError, not error: an error reply
    // for one is dropped as stale and its promise would never settle.
    if (msg.type === 'stl' || msg.type === 'bambu') return post({ type: 'stlError', jobId: msg.jobId, error: message(e) });
    post({ type: 'error', jobId: msg.jobId, error: message(e), stack: String((e && e.stack) || '') });
  }
}

function message(e) {
  return String((e && e.message) || e || 'unknown failure');
}

async function load(genId) {
  let mod = modules.get(genId);
  if (!mod) {
    const m = await import(`../gen/${genId}.js`);
    mod = m.default;
    if (!mod || typeof mod.build !== 'function') throw new Error(`${genId} has no build()`);
    modules.set(genId, mod);
  }
  return mod;
}

function makeCtx(msg, jobId, post) {
  const quality = SEG_FACTOR[msg.quality] ? msg.quality : 'normal';
  let lastPost = 0;
  return {
    quality,
    segFactor: SEG_FACTOR[quality],
    bed: msg.bed || { x: 180, y: 180, z: 180 },
    nozzle: msg.nozzle ?? 0.4,
    layerH: msg.layerH ?? 0.2,
    log: (text) => post({ type: 'log', jobId, text: String(text).slice(0, 400) }),
    progress: (t) => {
      const now = Date.now();
      if (now - lastPost < 60) return;         // a tight loop must not flood the bus
      lastPost = now;
      post({ type: 'progress', jobId, t: Math.max(0, Math.min(1, +t || 0)) });
    },
    // Present for contract compliance. A synchronous build() cannot be
    // interrupted from outside, so this never flips mid-build; stale jobs are
    // discarded by job id on the window thread instead.
    signal: new AbortController().signal,
  };
}

function asMesh(result) {
  if (!result) return null;
  if (result instanceof Mesh) return result;
  if (result.mesh instanceof Mesh) return result.mesh;
  if (Array.isArray(result.parts) && result.parts.length) {
    return Mesh.merge(result.parts.map(p => p.mesh).filter(Boolean));
  }
  if (result.positions && result.tris) return new Mesh(Array.from(result.positions), Array.from(result.tris));
  return null;
}

/** meta travels by structured clone, which refuses functions. Reduce it to
 *  plain data rather than letting one stray callback fail the whole reply. */
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

async function build(msg, post) {
  const key = `${msg.genId}|${msg.quality}|${canonicalise(msg.params || {})}`;
  if (last && last.key === key) return { ...last, cached: true };
  const gen = await load(msg.genId);
  const ctx = makeCtx(msg, msg.jobId, post);
  const t0 = now();
  const result = gen.build(msg.params || {}, ctx);
  const mesh = asMesh(result);
  if (!mesh || !mesh.triCount) throw new Error(`${msg.genId} produced no triangles at these parameters`);
  const record = {
    key, genId: msg.genId, mesh,
    meta: plain(result && result.meta) || null,
    parts: (result && Array.isArray(result.parts))
      ? result.parts.map(p => ({ name: String(p.name || 'part'), tris: p.mesh ? p.mesh.triCount : 0 }))
      : null,
    hints: plain(typeof gen.hints === 'function' ? safe(() => gen.hints(msg.params || {})) : null),
    version: Number(gen.version ?? 1),
    ms: now() - t0,
    cached: false,
  };
  last = record;
  return record;
}

function safe(fn) { try { return fn(); } catch { return null; } }

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

async function doBuild(msg, post) {
  latestBuildJob = msg.jobId;
  // Any earlier build still waiting to be told to analyse has been superseded.
  for (const go of pendingGo.values()) go(false);
  pendingGo.clear();
  const r = await build(msg, post);
  const mesh = r.mesh;

  // Float64 rather than Float32: the window thread re-derives the bounding box
  // and the STL from these, and a float32 round trip would move a face by a
  // micron and make "rests on the plate" a coin toss.
  const positions = Float64Array.from(mesh.positions);
  const tris = Uint32Array.from(mesh.tris);
  const render = mesh.toRenderBuffers({ crease: msg.crease ?? 35 });
  // The bounding box travels with the mesh, measured on the double-precision
  // positions. Deriving it on the window thread from the render buffers would
  // measure the float32 copy instead, and the title block would state a size a
  // micron off the one the STL actually has.
  const bbox = plain(mesh.bbox());

  // Awaited: on the worker this resolves immediately, and on the window-thread
  // fallback it is the caller's chance to let the new object paint before the
  // checks take the thread again.
  await post({
    type: 'mesh', jobId: msg.jobId, key: r.key, genId: r.genId,
    positions, tris, render, bbox, meta: r.meta, parts: r.parts, hints: r.hints,
    version: r.version, triCount: mesh.triCount, vertCount: mesh.vertCount,
    ms: r.ms, cached: r.cached,
  }, [positions.buffer, tris.buffer, render.positions.buffer, render.normals.buffer, render.indices.buffer]);

  // The preview is on screen. The checks wait for the window thread to say
  // so: it answers `analyse` if this is still the shape it wants, and posts
  // the next build instead if a finger on a stepper has already moved on — in
  // which case this job's analysis would never be read, and is not done. (A
  // plain zero-delay yield was tried first and lost the race three times in
  // four: the window is still uploading the mesh when the timer fires.)
  const go = await new Promise(resolve => pendingGo.set(msg.jobId, resolve));
  pendingGo.delete(msg.jobId);
  if (!go || latestBuildJob !== msg.jobId) return;

  // The checks arrive in three stages, each posted as it lands and each a
  // point at which a newer build takes over: the shape (closed? wound right?
  // volume), then the census that decides fit, overhang and weight, then the
  // slow passes — thickness and islands — which only run under the triangle
  // limit. `done` on the last stage is what finishes the job on the window
  // thread; a job superseded between stages simply never sends it.
  const superseded = () => latestBuildJob !== msg.jobId;
  const printOpts = {
    bed: msg.bed || { x: 180, y: 180, z: 180 },
    nozzle: msg.nozzle ?? 0.4,
    layerH: msg.layerH ?? 0.2,
    material: msg.material || 'PLA',
    infill: msg.infill ?? 1,
  };
  const deep = mesh.triCount <= DEEP_CHECK_TRI_LIMIT;
  let t1 = now();
  const analysis = analyze(mesh, { selfIntersect: false });
  post({ type: 'analysis', jobId: msg.jobId, key: r.key, stage: 'shape',
         analysis: plain(analysis), done: false, ms: now() - t1 });

  await nextTask();
  if (superseded()) return;
  t1 = now();
  const shallow = printability(mesh, { ...printOpts, checkThickness: false, checkIslands: false });
  post({ type: 'analysis', jobId: msg.jobId, key: r.key, stage: 'print',
         print: plain(shallow), deepChecked: false, done: !deep, ms: now() - t1 });
  if (!deep) return;

  await nextTask();
  if (superseded()) return;
  t1 = now();
  const full = printability(mesh, { ...printOpts, checkThickness: true, checkIslands: true });
  post({ type: 'analysis', jobId: msg.jobId, key: r.key, stage: 'deep',
         print: plain(full), deepChecked: true, done: true, ms: now() - t1 });
}

async function doSTL(msg, post) {
  const r = await build(msg, post);
  const bytes = r.mesh.toSTL(msg.name || r.genId);
  const u8 = new Uint8Array(bytes.buffer ? bytes.buffer : bytes);
  post({ type: 'stl', jobId: msg.jobId, key: r.key, bytes: u8, triCount: r.mesh.triCount },
    [u8.buffer]);
}

/** A Bambu Studio project of the current request, with the generator's
 *  colour change set. Refuses a build that declares none rather than shipping a
 *  one-colour project under a two-colour name. The writer and Sam's 49 kB
 *  profile load on first use, not with the worker. */
async function doBambu(msg, post) {
  const r = await build(msg, post);
  const z = r.meta && r.meta.colourChangeZ;
  if (!Number.isFinite(z)) throw new Error(`${r.genId} declares no colour change, so there is no swap to put in a Bambu project`);
  const { exportBambuProject } = await import('../kernel/bambu.js');
  const u8 = exportBambuProject(r.mesh, { name: msg.name || r.genId, colourChangeZ: z });
  post({ type: 'stl', jobId: msg.jobId, key: r.key, bytes: u8, triCount: r.mesh.triCount }, [u8.buffer]);
}

/** The expensive checks, on request: self-intersection, and the thickness and
 *  island passes when the mesh was too big to do them inline. */
async function doDeep(msg, post) {
  const r = await build(msg, post);
  const t0 = now();
  const analysis = analyze(r.mesh, { selfIntersect: true });
  const print = printability(r.mesh, {
    bed: msg.bed || { x: 180, y: 180, z: 180 },
    nozzle: msg.nozzle ?? 0.4,
    layerH: msg.layerH ?? 0.2,
    material: msg.material || 'PLA',
    infill: msg.infill ?? 1,
    checkThickness: true,
    checkIslands: true,
  });
  post({
    type: 'analysis', jobId: msg.jobId, key: r.key, deep: true, deepChecked: true, stage: 'deep',
    analysis: plain(analysis), print: plain(print), done: false, ms: now() - t0,
  });
}
