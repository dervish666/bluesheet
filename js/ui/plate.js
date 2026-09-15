// The plate.
//
// Slicing one object at a time is a toy: half of what this printer is for is
// making six of something, or one of each of four things in a single hour's
// print. The plate is a list of objects with quantities — the generator and its
// parameters, never a mesh — packed onto the bed by js/kernel/pack.js, shown in
// the viewer as the layout that will actually print, and sliced as separate
// objects at the positions Bluesheet chose, so the preview and the print agree.
//
// It lives on the server (/api/plate) so closing the tab does not lose a layout
// you were halfway through arranging, and putting an object on it registers
// its provenance hash, so the STL that comes off the plate can be traced back
// to the numbers that made it without anyone having pressed Save.
//
// Meshes are rebuilt here on the window thread rather than through the worker.
// Showing or slicing the plate is a deliberate press, not a slider drag, and a
// plate of six bins builds in the time the busy state takes to paint; the
// results are cached by parameter hash so pressing again costs nothing.

import { el, clear, $ } from './dom.js';
import { pack, layout, anyOverlap, withinBed, A1_MINI_BED } from '../kernel/pack.js';
import { Mesh } from '../kernel/mesh.js';
import { analyze, printability } from '../kernel/validate.js';
import { paramHash } from '../kernel/provenance.js';
import { SEG_FACTOR } from './build-core.js';

const SAVE_DEBOUNCE_MS = 400;
const MAX_QTY = 64;

export class PlatePanel {
  /**
   * @param {HTMLElement} root  the [data-plate] box
   * @param {object} h {
   *   generator(id) -> module | null,
   *   current() -> { gen, params, quality, name, bbox, triCount } | null,
   *   onShow(view | null)   view = { mesh, packing, bbox, analysis, print, copies, items }
   *   onStatus(key, message, tone), onBusy(bool),
   *   bed, layerH(), material()
   * }
   */
  constructor(root, h = {}) {
    this.root = root;
    this.h = h;
    this.bed = h.bed || A1_MINI_BED;
    this.items = [];
    this.gap = 3;
    this.rotate = true;
    this.active = false;             // the viewer is showing the plate
    this.view = null;                // the last built layout
    this.limits = { items: 32, copies: 64, gap: 25 };
    this._meshes = new Map();        // `${hash}|${quality}` -> Mesh
    this._saveTimer = 0;
    this._loaded = false;

    this.summaryEl = $('[data-plate-summary]', root);
    this.listEl = $('[data-plate-list]', root);
    this.addBtn = $('[data-plate-add]', root);
    this.showBtn = $('[data-plate-show]', root);
    this.clearBtn = $('[data-plate-clear]', root);
    this.sliceBtn = $('[data-plate-slice]', root);
    this.gapRow = $('[data-plate-gap-row]', root);
    this.gapEl = $('[data-plate-gap]', root);
    this.toolsEl = $('[data-plate-tools]', root);
    this.rotateEl = $('[data-plate-rotate]', root);

    this.addBtn.addEventListener('click', () => this.add(1));
    this.showBtn.addEventListener('click', () => (this.active ? this.hide() : this.show()));
    this.clearBtn.addEventListener('click', () => this.clearAll());
    this.sliceBtn.addEventListener('click', async () => { if (await this.show()) this.h.onSlice && this.h.onSlice(); });
    for (const b of root.querySelectorAll('[data-plate-gap-step]')) {
      b.addEventListener('click', () => this.setGap(this.gap + Number(b.dataset.plateGapStep)));
    }
    this.gapEl.addEventListener('change', () => this.setGap(Number(this.gapEl.value)));
    this.rotateEl.addEventListener('change', () => { this.rotate = !!this.rotateEl.checked; this._changed(); });
    this.render();
  }

  // ---- persistence -------------------------------------------------------

  async load() {
    try {
      const r = await fetch('api/plate', { headers: { Accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      this.items = Array.isArray(j.plate.items) ? j.plate.items : [];
      this.gap = Number.isFinite(j.plate.gap) ? j.plate.gap : 3;
      this.rotate = j.plate.rotate !== false;
      if (j.limits) this.limits = { ...this.limits, ...j.limits };
      this._loaded = true;
    } catch (e) {
      this.summaryEl.textContent = `The plate could not be loaded: ${e.message}`;
    }
    this.render();
    return this.items;
  }

  _changed({ save = true } = {}) {
    this.view = null;
    if (this.active) this.hide();
    this.render();
    if (save) this._scheduleSave();
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  async save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = 0;
    const body = JSON.stringify({ items: this.items, gap: this.gap, rotate: this.rotate });
    try {
      const r = await fetch('api/plate', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j.plate;
    } catch (e) {
      this.h.onStatus && this.h.onStatus('Plate not saved', e.message, 'warn');
      return null;
    }
  }

  // ---- editing -----------------------------------------------------------

  /** Put the current object on the plate. The same object again just adds to
   *  its quantity — the key is the generator and the parameter hash. */
  add(qty = 1) {
    const cur = this.h.current && this.h.current();
    if (!cur || !cur.bbox) { this.h.onStatus && this.h.onStatus('Plate', 'Build something first.', 'warn'); return null; }
    const hash = paramHash(cur.params);
    const key = `${cur.gen}-${hash}`;
    const size = cur.bbox.size;
    let item = this.items.find(i => i.key === key);
    const copies = this.copies();
    if (copies + qty > this.limits.copies) {
      this.h.onStatus && this.h.onStatus('Plate', `A plate holds at most ${this.limits.copies} copies.`, 'warn');
      return null;
    }
    if (item) {
      item.qty = Math.min(MAX_QTY, item.qty + qty);
    } else {
      if (this.items.length >= this.limits.items) {
        this.h.onStatus && this.h.onStatus('Plate', `A plate holds at most ${this.limits.items} different objects.`, 'warn');
        return null;
      }
      item = {
        // A copy, not the live parameter object: the panel goes on mutating
        // that one, and the plate must hold what was added, not what came next.
        key, gen: cur.gen, name: cur.name || cur.gen, qty, params: JSON.parse(JSON.stringify(cur.params)),
        quality: cur.quality || 'normal', hash, version: cur.version ?? 1,
        w: +size[0].toFixed(4), d: +size[1].toFixed(4), h: +size[2].toFixed(4),
        tris: cur.triCount || 0, rotatable: true,
      };
      this.items.push(item);
    }
    this._changed();
    this.h.onStatus && this.h.onStatus('Plate', `${item.name} ×${item.qty} — ${this.copies()} object${this.copies() === 1 ? '' : 's'} on the plate.`);
    return item;
  }

  setQty(key, qty) {
    const item = this.items.find(i => i.key === key);
    if (!item) return;
    qty = Math.round(qty);
    if (qty <= 0) return this.remove(key);
    item.qty = Math.min(MAX_QTY, qty);
    this._changed();
  }

  remove(key) {
    this.items = this.items.filter(i => i.key !== key);
    this._changed();
  }

  clearAll() {
    this.items = [];
    this._changed();                 // saved like any other edit, so it cannot race a later save
  }

  setGap(mm) {
    if (!Number.isFinite(mm)) return;
    this.gap = Math.max(0, Math.min(this.limits.gap, Math.round(mm * 2) / 2));
    this._changed();
  }

  copies() { return this.items.reduce((s, i) => s + i.qty, 0); }

  name() {
    const n = this.copies();
    if (this.items.length === 1) return `${this.items[0].name} ×${n}`.slice(0, 60);
    return `Plate of ${n}`;
  }

  // ---- building ----------------------------------------------------------

  _ctx(quality) {
    const q = SEG_FACTOR[quality] ? quality : 'normal';
    return {
      quality: q, segFactor: SEG_FACTOR[q], bed: this.bed, nozzle: 0.4,
      layerH: this.h.layerH ? this.h.layerH() : 0.2,
      log: () => {}, progress: () => {}, signal: new AbortController().signal,
    };
  }

  _meshOf(item) {
    const k = `${item.hash}|${item.quality}`;
    let m = this._meshes.get(k);
    if (m) return m;
    const gen = this.h.generator(item.gen);
    if (!gen) throw new Error(`no generator "${item.gen}" for ${item.name}`);
    const r = gen.build(item.params, this._ctx(item.quality));
    m = r instanceof Mesh ? r : (r && r.mesh instanceof Mesh ? r.mesh
      : (r && Array.isArray(r.parts) ? Mesh.merge(r.parts.map(p => p.mesh)) : null));
    if (!m || !m.triCount) throw new Error(`${item.name} built no triangles`);
    // The cache is bounded by forgetting everything when it grows past a plate's
    // worth of distinct objects; a plate is at most 32 of them.
    if (this._meshes.size > 40) this._meshes.clear();
    this._meshes.set(k, m);
    return m;
  }

  /** Pack and lay the plate out. Throws if nothing is on it. */
  build() {
    if (!this.items.length) throw new Error('nothing on the plate');
    const meshes = {};
    const spec = this.items.map(item => {
      const m = this._meshOf(item);
      meshes[item.key] = m;
      const b = m.bbox();
      // Measured from the mesh, not the stored footprint: a generator may have
      // changed since the plate was saved and the mesh is what gets printed.
      return { id: item.key, w: b.size[0], d: b.size[1], qty: item.qty, rotatable: item.rotatable !== false,
               meta: { h: b.size[2], name: item.name, gen: item.gen } };
    });
    const packing = pack(spec, this.bed, { gap: this.gap, allowRotate: this.rotate });
    const lay = layout(meshes, packing);
    const overlap = anyOverlap(packing);
    if (overlap) throw new Error(`the packer overlapped ${overlap.a.id} and ${overlap.b.id} — this is a bug`);
    const mesh = lay.mesh;
    const view = {
      mesh, parts: lay.parts, packing, bbox: mesh.bbox(),
      copies: packing.placed.length, unplaced: packing.unplaced, items: this.items.length,
      withinBed: withinBed(packing, this.bed),
      analysis: null, print: null,
    };
    this.view = view;
    return view;
  }

  /** Build, analyse and put the plate in the viewer. Resolves true if shown. */
  async show() {
    if (!this.items.length) { this.h.onStatus && this.h.onStatus('Plate', 'Nothing on the plate yet.', 'warn'); return false; }
    this.h.onBusy && this.h.onBusy(true);
    this.showBtn.disabled = true;
    try {
      // Let the busy state paint before the window thread goes quiet building.
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      const view = this.view || this.build();
      if (!view.analysis) {
        view.analysis = analyze(view.mesh, { selfIntersect: false });
        view.print = printability(view.mesh, {
          bed: this.bed, layerH: this.h.layerH ? this.h.layerH() : 0.2,
          material: this.h.material ? this.h.material() : 'PLA',
          infill: this.h.infill ? this.h.infill() : 1,
          checkThickness: false, checkIslands: false,
        });
      }
      this.active = true;
      this.showBtn.setAttribute('aria-pressed', 'true');
      this.showBtn.textContent = 'Show object';
      this.h.onShow && this.h.onShow(view);
      const dropped = view.unplaced.length ? ` — ${view.unplaced.length} did not fit` : '';
      this.h.onStatus && this.h.onStatus('Plate',
        `${view.copies} object${view.copies === 1 ? '' : 's'} packed, ${(view.packing.fill * 100).toFixed(0)} % of the bed, ` +
        `${view.packing.used.w.toFixed(0)} × ${view.packing.used.d.toFixed(0)} mm used${dropped}.`, view.unplaced.length ? 'warn' : null);
      this.render();
      return true;
    } catch (e) {
      this.h.onStatus && this.h.onStatus('Plate', e.message, 'error');
      return false;
    } finally {
      this.showBtn.disabled = false;
      this.h.onBusy && this.h.onBusy(false);
    }
  }

  /** Back to the single object. Called by the app whenever a fresh single build lands. */
  hide() {
    if (!this.active) return;
    this.active = false;
    this.showBtn.setAttribute('aria-pressed', 'false');
    this.showBtn.textContent = 'Show plate';
    this.h.onShow && this.h.onShow(null);
    this.render();
  }

  /** What the slicer gets: one STL per placed copy, already rotated, with its
   *  centre in plate coordinates, for `arrange: false`. */
  objects() {
    const view = this.view || this.build();
    const names = new Map();
    return view.parts.map(p => {
      const n = (names.get(p.id) || 0) + 1;
      names.set(p.id, n);
      const item = this.items.find(i => i.key === p.id);
      // The layout already applied the rotation and the offset; the slicer
      // wants the object at the origin plus its position, so undo the offset.
      const local = p.mesh.translate(-p.x, -p.y, 0);
      return {
        bytes: local.toSTL(`${item ? item.gen : p.id} v${item ? item.version : 1} #${item ? item.hash : '00000000'}`),
        name: `${item ? item.name : p.id}${item && item.qty > 1 ? ` ${n}` : ''}`.slice(0, 60),
        x: p.x, y: p.y, rot: 0,
      };
    });
  }

  // ---- the list ----------------------------------------------------------

  render() {
    const n = this.copies();
    const has = this.items.length > 0;
    this.toolsEl.hidden = !has;
    this.gapRow.hidden = !has;
    this.showBtn.hidden = !has;
    this.gapEl.value = String(this.gap);
    this.rotateEl.checked = this.rotate;
    if (!has) {
      this.summaryEl.textContent = 'Nothing on the plate. Add the current object to print several things in one go.';
    } else {
      const v = this.view;
      this.summaryEl.textContent = v
        ? `${v.copies} of ${n} placed · ${(v.packing.fill * 100).toFixed(0)} % of the bed · ${v.packing.used.w.toFixed(0)} × ${v.packing.used.d.toFixed(0)} mm` +
          (v.unplaced.length ? ` · ${v.unplaced.length} did not fit` : '')
        : `${n} object${n === 1 ? '' : 's'} across ${this.items.length} design${this.items.length === 1 ? '' : 's'}. Show plate packs them.`;
    }
    clear(this.listEl);
    for (const item of this.items) {
      const minus = el('button.step', { type: 'button', 'aria-label': `One fewer ${item.name}`, text: '−' });
      const plus = el('button.step', { type: 'button', 'aria-label': `One more ${item.name}`, text: '+' });
      const qty = el('input.num.field', { type: 'text', inputmode: 'numeric', value: String(item.qty), 'aria-label': `Copies of ${item.name}` });
      const del = el('button.btn.btn--ghost.plate-del', { type: 'button', 'aria-label': `Remove ${item.name}`, text: '×' });
      minus.addEventListener('click', () => this.setQty(item.key, item.qty - 1));
      plus.addEventListener('click', () => this.setQty(item.key, item.qty + 1));
      qty.addEventListener('change', () => this.setQty(item.key, Number(qty.value) || item.qty));
      del.addEventListener('click', () => this.remove(item.key));
      const row = el('div.plate-item', { dataset: { plateKey: item.key } }, [
        el('div.plate-item-main', null, [
          el('span.plate-item-name', { text: item.name }),
          el('span.plate-item-size.num', { text: `${item.w.toFixed(0)} × ${item.d.toFixed(0)} × ${item.h.toFixed(0)} mm` }),
        ]),
        el('div.stepper.stepper--small', null, [minus, qty, plus]),
        del,
      ]);
      this.listEl.appendChild(row);
    }
  }
}
