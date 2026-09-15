// The inspector: drop any STL onto Bluesheet and it tells you the truth about it.
//
// Watertight or how many open edges; wound outward or how many triangles are
// not; one shell or how many and how big the stray ones are; fits the bed or by
// how much it does not; what it weighs and what that costs; where the overhangs
// are and how thin the walls get. Every finding carries its number — the kernel
// already measures all of this for generated objects, and this is the front door
// for objects that came from somewhere else.
//
// The bytes are parsed and measured off the window thread (inspect-worker.js),
// because a 30 MB file must not freeze the page. Repair runs there too, and
// reports the counts before and after side by side, with a plain list of what it
// did and what it could not do. "Use this object" hands the mesh to the app so
// the existing export / slice / print path takes it unchanged.

import { el, clear, $, $$, trapFocus } from './dom.js';
import { size3, cm3, grams, count, deg, mm, bytes as fmtBytes, cost } from './format.js';
import { Mesh } from '../kernel/mesh.js';
import { parseProvenance } from '../kernel/provenance.js';

const SEV = { error: 0, warn: 1, info: 2, ok: 3 };

export class Inspector {
  /**
   * @param {HTMLElement} overlay [data-inspect]
   * @param {object} h {
   *   stage: HTMLElement                    the drop zone (the whole viewer)
   *   openButton: HTMLElement               the header button
   *   bed: {x,y,z}, layerH(): number, infill(): number
   *   onUse(payload)                        take the inspected mesh as the current object
   *   onOpenGenerator(genId)                reopen the generator a Bluesheet-made file names
   *   findByProvenance(str) -> entry|null   a saved design with this provenance, if any
   *   onLoadSaved(entry)
   * }
   */
  constructor(overlay, h = {}) {
    this.root = overlay;
    this.h = h;
    this.bed = h.bed || { x: 180, y: 180, z: 180 };
    this.current = null;            // { report, positions, tris, render, bbox, mesh (getter) }
    this.savedMatch = null;
    this.busy = false;
    this.mode = 'worker';
    this.jobId = 0;
    this.waiters = new Map();
    this._local = null;

    this.f = {
      name: $('[data-inspect-name]', overlay),
      intro: $('[data-inspect-intro]', overlay),
      busy: $('[data-inspect-busy]', overlay),
      facts: $('[data-inspect-facts]', overlay),
      findings: $('[data-inspect-findings]', overlay),
      prov: $('[data-inspect-prov]', overlay),
      repair: $('[data-inspect-repair]', overlay),
      repairBtn: $('[data-inspect-do-repair]', overlay),
      useBtn: $('[data-inspect-use]', overlay),
      file: $('[data-inspect-file]', overlay),
    };

    for (const b of $$('[data-close-inspect]', overlay)) b.addEventListener('click', () => this.close());
    for (const b of $$('[data-inspect-pick]', overlay)) b.addEventListener('click', () => this.pick());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
    if (this.f.repairBtn) this.f.repairBtn.addEventListener('click', () => this.repair().catch(() => {}));
    if (this.f.useBtn) this.f.useBtn.addEventListener('click', () => this.use());
    if (this.f.file) {
      this.f.file.addEventListener('change', () => {
        const file = this.f.file.files && this.f.file.files[0];
        if (file) this.inspectFile(file).catch(() => {});
        this.f.file.value = '';
      });
    }
    if (h.openButton) h.openButton.addEventListener('click', () => this.pick());
    if (h.stage) this._wireDrop(h.stage);
    this._startWorker();
  }

  get isOpen() { return !this.root.hidden; }
  get report() { return this.current ? this.current.report : null; }
  get mesh() { return this.current ? this.current.mesh : null; }

  // ---- drop zone -----------------------------------------------------------

  _wireDrop(zone) {
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    };
    zone.addEventListener('dragenter', over);
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      zone.classList.remove('is-dragover');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove('is-dragover');
      const file = e.dataTransfer.files[0];
      if (file) this.inspectFile(file).catch(() => {});
    });
    // The whole overlay too, so a second file can be dropped on the report.
    this.root.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    this.root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) this.inspectFile(file).catch(() => {});
    });
  }

  /** The hidden file input, for the header button and for a finger on an iPad. */
  pick() {
    if (this.f.file) this.f.file.click();
    else this.open();
  }

  // ---- the two requests ----------------------------------------------------

  /** A File from a drop or the picker. */
  async inspectFile(file) {
    const buf = await file.arrayBuffer();
    return this.inspectBytes(buf, file.name);
  }

  /**
   * The same path a dropped file takes, from bytes. Resolves with the report
   * (plain data: findings with their numbers, the counts, provenance) and leaves
   * the overlay open on it. A file that will not parse resolves with a report
   * whose only finding is the error, so the caller always gets an answer.
   */
  async inspectBytes(buffer, name = 'untitled.stl') {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.open();
    this.current = null;
    this.savedMatch = null;
    this._setBusy(`Reading ${fmtBytes(u8.byteLength)} of ${name}`);
    this.f.name.textContent = name;
    // A copy, so the caller's buffer is not detached by the transfer.
    const copy = new Uint8Array(u8);
    try {
      const m = await this._request({ type: 'inspect', bytes: copy, name, ...this._opts() }, [copy.buffer]);
      this._take(m);
      this.current.report.parsedIn = this.mode;
      await this._lookupProvenance();
    } catch (e) {
      // The header can still say who made it even when the body will not parse.
      let prov = null;
      try { prov = parseProvenance(u8); } catch { prov = null; }
      this.current = {
        report: {
          file: { name, bytes: u8.byteLength, format: null }, provenance: prov, error: String(e && e.message || e),
          findings: [{ code: 'UNREADABLE', severity: 'error', text: String(e && e.message || e) }],
          parsedIn: this.mode, repaired: false,
        },
        positions: null, tris: null, render: null, bbox: null, mesh: null,
      };
      await this._lookupProvenance();
    }
    this._setBusy(null);
    this.render();
    return this.current.report;
  }

  /** Weld, drop degenerates, remove stray shells, flip if inside out, close
   *  T-junctions; then measure again. Resolves with the new report, whose
   *  `repair` block holds before/after counts and the did / could-not lists. */
  async repair() {
    if (!this.current || !this.current.positions) throw new Error('nothing to repair');
    const c = this.current;
    this._setBusy(`Repairing ${c.report.file.name}`);
    const positions = Float64Array.from(c.positions);
    const tris = Uint32Array.from(c.tris);
    try {
      const m = await this._request({
        type: 'repair', positions, tris, file: c.report.file, provenance: c.report.provenance, ...this._opts(),
      }, [positions.buffer, tris.buffer]);
      const parsedIn = c.report.parsedIn;
      this._take(m);
      this.current.report.parsedIn = parsedIn;
    } finally {
      this._setBusy(null);
      this.render();
    }
    return this.current.report;
  }

  /** Hand the inspected (repaired, if repair ran) mesh to the app. */
  use() {
    const c = this.current;
    if (!c || !c.positions || !this.h.onUse) return null;
    const payload = {
      name: c.report.file.name,
      mesh: c.mesh,
      render: c.render,
      bbox: c.bbox,
      analysis: c.report.analysis,
      print: c.report.print,
      provenance: c.report.provenance,
      repaired: !!c.report.repaired,
      report: c.report,
    };
    this.close();
    this.h.onUse(payload);
    return payload;
  }

  _opts() {
    return {
      bed: this.bed,
      layerH: this.h.layerH ? this.h.layerH() : 0.2,
      infill: this.h.infill ? this.h.infill() : 1,
    };
  }

  _take(m) {
    const positions = m.positions, tris = m.tris;
    this.current = {
      report: m.report, positions, tris, render: m.render, bbox: m.bbox, _mesh: null,
      get mesh() {
        if (!this._mesh) {
          // Rehydrated lazily: the kernel Mesh is only wanted for export and slicing.
          return (this._mesh = meshFrom(positions, tris));
        }
        return this._mesh;
      },
    };
  }

  async _lookupProvenance() {
    const p = this.current && this.current.report.provenance;
    this.savedMatch = null;
    if (!p || !this.h.findByProvenance) return;
    try {
      this.savedMatch = (await this.h.findByProvenance(`${p.gen} v${p.version} #${p.hash}`)) || null;
    } catch { this.savedMatch = null; }
  }

  // ---- worker plumbing -----------------------------------------------------

  _startWorker() {
    if (typeof Worker === 'undefined') { this.mode = 'window'; return; }
    try {
      this.worker = new Worker(new URL('./inspect-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      this.mode = 'window';
      console.warn('bluesheet: no module worker for the inspector, parsing on the window thread', e);
      return;
    }
    this.worker.onmessage = (ev) => this._onMessage(ev.data || {});
    this.worker.onerror = (ev) => {
      if (this.mode !== 'worker') return;
      console.warn('bluesheet: inspector worker failed, falling back to the window thread', ev.message || ev);
      this.mode = 'window';
      try { this.worker.terminate(); } catch { /* gone */ }
      this.worker = null;
      for (const [id, w] of this.waiters) { this.waiters.delete(id); w.reject(new Error('the inspector worker failed; try again')); }
    };
    this.worker.postMessage({ type: 'ping', jobId: ++this.jobId });
  }

  _request(msg, transfer) {
    const jobId = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.waiters.set(jobId, { resolve, reject });
      const full = { ...msg, jobId };
      if (this.mode === 'worker' && this.worker) this.worker.postMessage(full, transfer || []);
      else this._runLocal(full);
    });
  }

  async _runLocal(msg) {
    try {
      if (!this._local) this._local = await import('./inspect-core.js');
      // A paint before the stall, so the busy line is on screen.
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      await this._local.handle(msg, (m) => this._onMessage(m));
    } catch (e) {
      this._onMessage({ type: 'error', jobId: msg.jobId, error: String(e && e.message || e) });
    }
  }

  _onMessage(m) {
    if (m.type === 'pong') return;
    const w = this.waiters.get(m.jobId);
    if (!w) return;
    this.waiters.delete(m.jobId);
    if (m.type === 'error') w.reject(new Error(m.error));
    else w.resolve(m);
  }

  // ---- overlay -------------------------------------------------------------

  open() {
    if (this.isOpen) return this;
    this.root.hidden = false;
    this._lastFocus = document.activeElement;
    this._untrap = trapFocus(this.root, () => this.close());
    const first = $('[data-close-inspect]', this.root);
    if (first) first.focus();
    this.render();
    return this;
  }

  close() {
    if (!this.isOpen) return this;
    this.root.hidden = true;
    if (this._untrap) { this._untrap(); this._untrap = null; }
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
    return this;
  }

  _setBusy(text) {
    this.busy = !!text;
    if (this.f.busy) { this.f.busy.hidden = !text; this.f.busy.textContent = text || ''; }
    if (this.f.repairBtn) this.f.repairBtn.disabled = this.busy || !(this.current && this.current.positions);
    if (this.f.useBtn) this.f.useBtn.disabled = this.busy || !(this.current && this.current.positions);
  }

  render() {
    const c = this.current;
    const r = c && c.report;
    this.f.intro.hidden = !!r;
    if (this.f.repairBtn) this.f.repairBtn.disabled = this.busy || !(c && c.positions);
    if (this.f.useBtn) this.f.useBtn.disabled = this.busy || !(c && c.positions);
    clear(this.f.facts);
    clear(this.f.findings);
    clear(this.f.prov);
    clear(this.f.repair);
    if (!r) { this.f.name.textContent = ''; return this; }

    this.f.name.textContent = r.file ? r.file.name : '';
    this._renderFacts(r);
    this._renderFindings(r);
    this._renderProvenance(r);
    this._renderRepair(r);
    return this;
  }

  _renderFacts(r) {
    const rows = [];
    const file = r.file || {};
    rows.push(['File', `${fmtBytes(file.bytes || 0)}${file.format ? ` · ${file.format} STL` : ''}`, null]);
    if (r.error) {
      rows.push(['Readable', 'No', 'bad']);
    } else {
      rows.push(['Triangles', count(r.triCount), null]);
      rows.push(['Watertight', r.watertight ? 'Yes' : `No — ${r.openEdges} open edge${r.openEdges === 1 ? '' : 's'}, ${r.loops} loop${r.loops === 1 ? '' : 's'}`, r.watertight ? null : 'bad']);
      rows.push(['Wound outward', r.inverted ? `No — inside out (${count(r.reversed)} reversed)` : r.flippedTris ? `${r.flippedTris} reversed` : 'Yes', (r.inverted || r.flippedTris) ? 'bad' : null]);
      rows.push(['Shells', r.shells === 1 ? '1' : `${r.shells}${r.strays.length ? ` (${r.strays.length} stray)` : ''}`, r.shells > 1 ? 'warn' : null]);
      rows.push(['Size', size3(r.size), null]);
      rows.push(['Fits the bed', r.fitsBed ? 'Yes' : `No — ${overText(r.over)}`, r.fitsBed ? null : 'bad']);
      rows.push(['Volume', cm3(Math.abs(r.volume)), null]);
      rows.push(['Mass', `${grams(r.grams)} PLA`, null]);
      rows.push(['Cost', cost(r.grams), null]);
      rows.push(['Overhang', r.overhangArea > 0 ? `${r.overhangArea.toFixed(1)} mm² · worst ${deg(r.worstOverhangDeg)}` : `none past 50° (worst ${deg(r.worstOverhangDeg)})`, r.overhangArea > 0 ? 'warn' : null]);
      if (r.deepChecked) {
        rows.push(['Thinnest wall', Number.isFinite(r.minThickness) ? `${mm(r.minThickness)} mm` : '—', Number.isFinite(r.minThickness) && r.minThickness < 0.8 ? 'warn' : null]);
      } else {
        rows.push(['Thinnest wall', 'not measured', null]);
      }
    }
    const frag = document.createDocumentFragment();
    for (const [label, value, tone] of rows) {
      frag.appendChild(el('div.fact', null, [
        el('dt.lbl', { text: label }),
        el(`dd.num${tone === 'bad' ? '.is-bad' : tone === 'warn' ? '.is-warn' : ''}`, { text: value }),
      ]));
    }
    this.f.facts.appendChild(frag);
  }

  _renderFindings(r) {
    const list = (r.findings || []).slice().sort((a, b) => (SEV[a.severity] ?? 4) - (SEV[b.severity] ?? 4));
    const frag = document.createDocumentFragment();
    for (const f of list) {
      const kind = f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warn' : 'info';
      frag.appendChild(el(`div.warn.warn--${kind}${f.severity === 'ok' ? '.warn--ok' : ''}`, { dataset: { code: f.code } }, [
        el('span.warn-code', { text: String(f.code).replace(/_/g, ' ').slice(0, 18) }),
        el('span.warn-body', { text: f.text }),
      ]));
    }
    for (const w of ((r.file && r.file.warnings) || [])) {
      frag.appendChild(el('div.warn.warn--info', null, [
        el('span.warn-code', { text: 'READ' }), el('span.warn-body', { text: w }),
      ]));
    }
    this.f.findings.appendChild(frag);
    this.f.findings.dataset.count = String(list.length);
  }

  _renderProvenance(r) {
    const p = r.provenance;
    if (!p) return;
    const box = el('div.inspect-prov', { dataset: { gen: p.gen } });
    box.appendChild(el('h3.lbl.sub', { text: `Made by Bluesheet: ${p.gen} v${p.version}` }));
    box.appendChild(el('p.prose', {
      text: `The header names the generator and carries the parameter hash #${p.hash}, not the parameters themselves. ` +
            (this.savedMatch
              ? `The library has a saved design with exactly this provenance.`
              : `Opening the generator gives you its defaults to work back from.`),
    }));
    const actions = el('div.actions');
    const openGen = el('button.btn', { type: 'button', text: `Open in generator`, dataset: { inspectOpenGen: p.gen } });
    openGen.addEventListener('click', () => { this.close(); this.h.onOpenGenerator && this.h.onOpenGenerator(p.gen); });
    actions.appendChild(openGen);
    if (this.savedMatch) {
      const openSaved = el('button.btn', { type: 'button', text: `Open saved “${this.savedMatch.name}”`, dataset: { inspectOpenSaved: this.savedMatch.id } });
      openSaved.addEventListener('click', () => { this.close(); this.h.onLoadSaved && this.h.onLoadSaved(this.savedMatch); });
      actions.appendChild(openSaved);
    }
    box.appendChild(actions);
    this.f.prov.appendChild(box);
  }

  _renderRepair(r) {
    const rp = r.repair;
    if (!rp) return;
    const box = el('div.inspect-repair');
    box.appendChild(el('h3.lbl.sub', { text: 'Repaired' }));
    const rows = [
      ['Open edges', rp.before.openEdges, rp.after.openEdges],
      ['Boundary loops', rp.before.loops, rp.after.loops],
      ['Reversed triangles', rp.before.reversed, rp.after.reversed],
      ['Shells', rp.before.shells, rp.after.shells],
      ['Degenerate', rp.before.degenerate, rp.after.degenerate],
      ['Non-manifold edges', rp.before.nonManifoldEdges, rp.after.nonManifoldEdges],
      ['Triangles', rp.before.triangles, rp.after.triangles],
      ['Volume', `${(rp.before.volume / 1000).toFixed(2)} cm³`, `${(rp.after.volume / 1000).toFixed(2)} cm³`],
    ];
    const table = el('div.inspect-diff', { role: 'table' });
    table.appendChild(el('div.inspect-diff-row.inspect-diff-head', { role: 'row' }, [
      el('span.lbl', { text: '' }), el('span.lbl', { text: 'Before' }), el('span.lbl', { text: 'After' }),
    ]));
    for (const [label, a, b] of rows) {
      const changed = String(a) !== String(b);
      table.appendChild(el(`div.inspect-diff-row${changed ? '.is-changed' : ''}`, { role: 'row' }, [
        el('span.lbl', { text: label }),
        el('span.num', { text: typeof a === 'number' ? count(a) : String(a) }),
        el('span.num', { text: typeof b === 'number' ? count(b) : String(b) }),
      ]));
    }
    box.appendChild(table);
    box.appendChild(el('h4.lbl', { text: 'What it did' }));
    box.appendChild(el('ul.inspect-did.prose', null, rp.did.map(t => el('li', { text: t }))));
    box.appendChild(el('h4.lbl', { text: rp.couldNot.length ? 'What it could not fix' : 'Nothing left unfixed' }));
    if (rp.couldNot.length) {
      box.appendChild(el('ul.inspect-did.inspect-couldnot.prose', null, rp.couldNot.map(t => el('li', { text: t }))));
    } else {
      box.appendChild(el('p.prose', { text: 'Watertight, wound outward, one solid.' }));
    }
    this.f.repair.appendChild(box);
  }
}

function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).includes('Files')) return true;
  return !!(dt.files && dt.files.length);
}

function overText(over) {
  const parts = [];
  if (over.x) parts.push(`${over.x.toFixed(1)} mm too wide`);
  if (over.y) parts.push(`${over.y.toFixed(1)} mm too deep`);
  if (over.z) parts.push(`${over.z.toFixed(1)} mm too tall`);
  return parts.join(', ');
}

/** The kernel Mesh, rehydrated only when export or slicing actually wants it. */
function meshFrom(positions, tris) {
  return Mesh.fromArrays(Array.from(positions), Array.from(tris));
}
