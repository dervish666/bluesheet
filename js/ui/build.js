// The rebuild scheduler.
//
// Three jobs: keep geometry off the window thread, coalesce a finger dragging a
// value into a sensible number of builds, and never leave a stale result on the
// screen. At most one build is in flight and at most one is queued behind it —
// a drag that fires forty pointermove events must not queue forty builds.
//
// A job has two phases, and the second is pre-emptible. Once its mesh is on
// screen a job is in its analysis phase, and if the parameters have moved on by
// then the next build is posted at once rather than after the checks: the
// worker yields between the two, sees the newer request, and abandons the
// analysis nobody will read. On the ribbed vase that is the difference between
// a rebuild every 0.9 s while dragging and one every 0.1 s — the build was
// never the slow part, the census of a shape already gone was.
//
// Everything stops when the tab is hidden. This laptop lives in a cupboard next
// to a printer and has nowhere to put its heat.

import { canonicalise } from '../kernel/provenance.js';
import { Mesh } from '../kernel/mesh.js';

export const DEBOUNCE_MS = 110;
// A stepper held down fires every 70 ms, which a debounce alone would swallow
// whole: the number would tick and the shape would sit still until the finger
// lifted. Past this much continuous change, build what is wanted now.
export const MAX_WAIT_MS = 250;
const PING_TIMEOUT_MS = 4000;

export function jobKey(req) {
  return `${req.genId}|${req.quality}|${canonicalise(req.params || {})}`;
}

export class Builder {
  /**
   * @param {object} h  { onMesh, onAnalysis, onProgress, onLog, onBusy, onError }
   */
  constructor(h = {}) {
    this.h = h;
    this.desired = null;
    this.desiredKey = '';
    this.result = null;           // the last completed build, whatever its key
    this.running = null;          // { key, jobId, phase: 'build' | 'analysis' }
    this.waiters = [];
    this.jobId = 0;
    this.timer = 0;
    this._wantedAt = 0;           // when the current desire first went unbuilt
    this.disposed = false;
    this.mode = 'worker';
    this.stats = { builds: 0, lastMs: 0, lastAnalysisMs: 0 };
    this._local = null;
    this._startWorker();
    this._onVisible = () => {
      // Nothing is queued while hidden; run whatever was wanted on the way back.
      if (!document.hidden && this.desiredKey && this.desiredKey !== (this.result && this.result.key)) this._schedule(true);
    };
    document.addEventListener('visibilitychange', this._onVisible);
  }

  _startWorker() {
    if (typeof Worker === 'undefined') { this.mode = 'local'; return; }
    try {
      this.worker = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      this.mode = 'local';
      console.warn('bluesheet: no module worker, building on the window thread', e);
      return;
    }
    this.worker.onmessage = (ev) => this._onMessage(ev.data || {});
    this.worker.onerror = (ev) => {
      // A module-level failure in the worker (a bad import, no module worker
      // support) surfaces here once and then the worker is useless.
      if (this.mode !== 'worker') return;
      console.warn('bluesheet: geometry worker failed, falling back to the window thread', ev.message || ev);
      this.mode = 'local';
      try { this.worker.terminate(); } catch { /* already gone */ }
      this.worker = null;
      if (this.running) { this.running = null; this._schedule(true); }
    };
    // If the worker cannot even answer a ping, do not discover that on the
    // user's first parameter change.
    const id = ++this.jobId;
    this._pingTimer = setTimeout(() => {
      if (this.mode === 'worker' && !this._pinged) {
        console.warn('bluesheet: geometry worker did not answer; building on the window thread');
        this.mode = 'local';
      }
    }, PING_TIMEOUT_MS);
    this.worker.postMessage({ type: 'ping', jobId: id });
  }

  /** Ask for `req` to be current. Resolves when a build of exactly this request
   *  has completed, including its analysis. */
  build(req, { immediate = false } = {}) {
    const key = jobKey(req);
    this.desired = { ...req, key };
    this.desiredKey = key;
    if (this.result && this.result.key === key && this.result.done) {
      return Promise.resolve(this.result);
    }
    const p = new Promise((resolve, reject) => this.waiters.push({ key, resolve, reject }));
    if (!this._wantedAt) this._wantedAt = Date.now();
    this._schedule(immediate);
    return p;
  }

  /** Force a rebuild even if the parameters have not moved. */
  rebuild(req) {
    this.result = null;
    return this.build(req, { immediate: true });
  }

  _schedule(immediate) {
    if (this.disposed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    if (document.hidden) return;                       // cupboard rule
    if (!immediate && this._wantedAt && Date.now() - this._wantedAt >= MAX_WAIT_MS) immediate = true;
    if (immediate) this._run();
    else this.timer = setTimeout(() => { this.timer = 0; this._run(); }, DEBOUNCE_MS);
  }

  _run() {
    if (this.disposed || !this.desired) return;
    if (this.result && this.result.key === this.desiredKey && this.result.done) {
      this._settle(this.result);
      return;
    }
    if (this.running) {
      // A job still building cannot be pre-empted; one in its analysis phase
      // can, but only for a different request — if it is already building what
      // is wanted, its analysis is the thing to wait for.
      if (this.running.phase !== 'analysis' || this.running.key === this.desiredKey) return;
    }
    const jobId = ++this.jobId;
    this.running = { key: this.desiredKey, jobId, phase: 'build' };
    this._wantedAt = 0;
    this.h.onBusy && this.h.onBusy(true);
    this._post({ type: 'build', jobId, ...this.desired });
  }

  _post(msg) {
    if (this.mode === 'worker' && this.worker) this.worker.postMessage(msg);
    else this._runLocal(msg);
  }

  /** The window-thread fallback. It cannot avoid a stall inside a generator's
   *  synchronous build(), but it yields either side of it so the page paints
   *  the busy state and stays responsive between builds. */
  async _runLocal(msg) {
    try {
      if (!this._local) this._local = await import('./build-local.js');
      await this._local.run(msg, (m) => this._onMessage(m));
    } catch (e) {
      this._onMessage({ type: 'error', jobId: msg.jobId, error: String(e && e.message || e) });
    }
  }

  _onMessage(m) {
    if (this.disposed) return;
    if (m.type === 'pong') { this._pinged = true; clearTimeout(this._pingTimer); return; }
    if (m.type === 'log') { this.h.onLog && this.h.onLog(m.text); return; }
    if (m.type === 'progress') {
      if (this.running && m.jobId === this.running.jobId) this.h.onProgress && this.h.onProgress(m.t);
      return;
    }
    if (m.type === 'stl' || m.type === 'stlError') { this._onSTL(m); return; }

    const stale = !this.running || m.jobId !== this.running.jobId;

    if (m.type === 'error') {
      if (!stale) {
        this.running = null;
        this.h.onBusy && this.h.onBusy(false);
        const err = new Error(m.error);
        err.stack = m.stack || err.stack;
        this.h.onError && this.h.onError(err, this.desired);
        // Every waiter, not only this job's: a request that was superseded
        // before it ran will never be built now, and a promise nobody can ever
        // settle is a leak with a UI spinner attached to it.
        const wake = this.waiters;
        this.waiters = [];
        for (const w of wake) w.reject(err);
        this._next();
      }
      return;
    }

    if (m.type === 'mesh') {
      if (stale) return;
      this.stats.builds++;
      this.stats.lastMs = m.ms;
      // Rehydrating the kernel Mesh costs a copy of every coordinate, and only
      // the STL path and the test handle need it — so it is a getter.
      const result = {
        key: m.key, genId: m.genId, meta: m.meta, parts: m.parts, hints: m.hints,
        version: m.version, triCount: m.triCount, vertCount: m.vertCount,
        render: m.render, bbox: m.bbox, ms: m.ms, analysis: null, print: null, done: false,
        positions: m.positions, tris: m.tris, _mesh: null,
        get mesh() {
          if (!this._mesh) this._mesh = Mesh.fromArrays(Array.from(this.positions), Array.from(this.tris));
          return this._mesh;
        },
      };
      this.result = result;
      this.running.phase = 'analysis';
      this.h.onMesh && this.h.onMesh(result);
      // The worker is holding this job's analysis until told. If the
      // parameters moved on while it was building, post the next build instead
      // and the analysis nobody would read is never done.
      if (this.desiredKey !== this.running.key) this._schedule(true);
      else this._post({ type: 'analyse', jobId: this.running.jobId });
      return;
    }

    if (m.type === 'analysis') {
      // Two separate questions, and conflating them wedged the whole app.
      //
      // (a) Does this belong to the result on screen? Stages arrive after
      //     the mesh and a deep check arrives after its job has finished, so
      //     that is matched on the build KEY rather than the job id. Each
      //     stage carries only what it measured; the rest is left as it was.
      const mine = !!this.result && this.result.key === m.key;
      if (mine) {
        if (m.analysis) this.result.analysis = m.analysis;
        if (m.print) this.result.print = m.print;
        if (m.deepChecked !== undefined) this.result.deepChecked = m.deepChecked;
        if (m.done) this.result.done = true;
        this.stats.lastAnalysisMs = (m.stage === 'shape' ? 0 : this.stats.lastAnalysisMs) + (m.ms || 0);
        this.h.onAnalysis && this.h.onAnalysis(this.result, { deep: !!m.deep, stage: m.stage, done: !!m.done });
      }
      // (b) Is the job that was in flight now finished? That is a fact about the
      //     JOB, not about whatever result happens to be on screen — and the two
      //     come apart, because `rebuild()` nulls `result` to force a fresh
      //     build. Land that between a job's mesh and its analysis and the old
      //     code returned at the `mine` test, so `running` was never cleared,
      //     `_next()` never ran and every waiter hung for ever. In the UI that
      //     is a spinner that never stops: pick a generator from the catalogue,
      //     ask for a rebuild in the same breath, and Bluesheet is finished until
      //     you reload it. Only the LAST stage finishes a job; a job superseded
      //     between stages never sends one, and was replaced in `running` when
      //     the next build was posted.
      if (!stale && m.done) {
        this.running = null;
        this.h.onBusy && this.h.onBusy(false);
        if (mine) this._settle(this.result);
        this._next();                      // starts the rebuild that nulled it
      }
      return;
    }
  }

  _settle(result) {
    // Waiters for this exact build, plus any whose request has since been
    // superseded — the newest result is what "the model is up to date now"
    // means to them, and nothing else will ever arrive for their key.
    const wake = this.waiters.filter(w => w.key === result.key || w.key !== this.desiredKey);
    if (!wake.length) return;
    this.waiters = this.waiters.filter(w => !wake.includes(w));
    for (const w of wake) w.resolve(result);
  }

  _next() {
    if (this.desiredKey && (!this.result || this.result.key !== this.desiredKey)) this._schedule(true);
  }

  // ---- STL ---------------------------------------------------------------
  /** Binary STL of the current request, built where the mesh already lives. */
  stl(req, name) { return this._file('stl', req, name); }

  /** A Bambu Studio project 3mf of the current request, colour change set. */
  bambu(req, name) { return this._file('bambu', req, name); }

  _file(type, req, name) {
    const jobId = ++this.jobId;
    const msg = { type, jobId, ...req, name };
    return new Promise((resolve, reject) => {
      this._stlWaiters = this._stlWaiters || new Map();
      this._stlWaiters.set(jobId, { resolve, reject });
      this._post(msg);
    });
  }

  _onSTL(m) {
    const w = this._stlWaiters && this._stlWaiters.get(m.jobId);
    if (!w) return;
    this._stlWaiters.delete(m.jobId);
    if (m.type === 'stlError') w.reject(new Error(m.error));
    else w.resolve(m.bytes);
  }

  /** The expensive checks, on request. */
  deepCheck(req) {
    const jobId = ++this.jobId;
    this._post({ type: 'deep', jobId, ...req });
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this._onVisible);
    if (this.timer) clearTimeout(this.timer);
    clearTimeout(this._pingTimer);
    if (this.worker) { try { this.worker.terminate(); } catch { /* already gone */ } }
    for (const w of this.waiters) w.reject(new Error('builder disposed'));
    this.waiters = [];
  }
}
