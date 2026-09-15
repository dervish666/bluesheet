// Slice, and then print.
//
// The progress bar here reports things that actually happened. Four phases, each
// with a real measurement behind it: building the STL (the worker says so),
// uploading it (XHR upload progress, which is why this is not fetch), the slicer
// itself (elapsed seconds against how long the last slice of this object took),
// and fetching the toolpaths back (XHR download progress). A bar that sweeps to
// 90% and waits is a lie, and on a tool that is about to move a hot nozzle it is
// the wrong habit to get into.
//
// Printing is deliberately awkward. The button does not exist until a slice
// does; pressing it opens a confirmation naming the object, its time and its
// weight; and the server then demands a token it issued for that exact job
// seconds earlier. Two independent gates, one of which is a human reading the
// name of the thing that is about to be made.

import { el, clear, $, $$, trapFocus } from './dom.js';
import { duration, grams as fmtGrams, cost } from './format.js';

const GCODE_MAX_POINTS = 260_000;
const LAST_SLICE_KEY = 'bluesheet.sliceSec';

const PHASES = [
  ['build', 0.00, 0.12],
  ['upload', 0.12, 0.30],
  ['slice', 0.30, 0.86],
  ['gcode', 0.86, 1.00],
];

export class SlicePath {
  /**
   * @param {Document|HTMLElement} scope
   * @param {object} h {
   *   stl(): Promise<Uint8Array>, objects?(): [{bytes, name, x, y, rot}] | null,
   *   name(): string, params(): object,
   *   onSliced(meta), onGcode(data), onStatus(key, message, tone), onBusy(bool)
   * }
   */
  constructor(scope, h = {}) {
    this.h = h;
    this.health = null;
    this.slice_ = null;            // the current slice meta, or null
    this.busy = false;

    this.profileEl = $('[data-slice-profile]', scope);
    this.filamentEl = $('[data-slice-filament]', scope);
    this.infillEl = $('[data-slice-infill]', scope);
    this.supportsEl = $('[data-slice-supports]', scope);
    this.progressEl = $('[data-progress]', scope);
    this.fillEl = $('[data-progress-fill]', scope);
    this.labelEl = $('[data-progress-label]', scope);
    this.sliceBtn = $('[data-slice]', scope);
    this.printBtn = $('[data-print]', scope);
    this.noteEl = $('[data-print-note]', scope);

    this.confirmEl = $('[data-confirm]', scope);
    this.cName = $('[data-confirm-name]', scope);
    this.cTime = $('[data-confirm-time]', scope);
    this.cGrams = $('[data-confirm-grams]', scope);
    this.cPrinter = $('[data-confirm-printer]', scope);
    this.cStart = $('[data-confirm-start]', scope);
    this.cClear = $('[data-confirm-clear]', scope);
    this.cPlate = $('[data-plate-check]', scope);
    this.cShot = $('[data-plate-shot]', scope);
    // The plate check appears only when a start is asked for, and the frame
    // is live: the camera service (:8131) is on the same host as this one.
    this.cStart.addEventListener('change', () => this._plateCheck(this.cStart.checked));
    this.cShot.addEventListener('click', () => this._refreshShot());
    this.cGoName = $('[data-confirm-go-name]', scope);
    this.cGo = $('[data-confirm-go]', scope);

    this.sliceBtn.addEventListener('click', () => this.run());
    this.printBtn.addEventListener('click', () => this.openConfirm());
    $('[data-confirm-cancel]', scope).addEventListener('click', () => this.closeConfirm());
    this.cGo.addEventListener('click', () => this.send());
    this.confirmEl.addEventListener('pointerdown', (e) => { if (e.target === this.confirmEl) this.closeConfirm(); });

    for (const b of $$('[data-infill-step]', scope)) {
      b.addEventListener('click', () => {
        const d = Number(b.dataset.infillStep) || 0;
        this.infillEl.value = String(clamp(Math.round((Number(this.infillEl.value) || 0) + d), 0, 100));
        this.invalidate();
      });
    }
    for (const node of [this.profileEl, this.filamentEl, this.infillEl, this.supportsEl]) {
      node.addEventListener('change', () => this.invalidate());
    }
    this.setSlice(null);
  }

  /** Populate the profile and filament lists from what the server actually has
   *  installed, rather than from a list in the page that can go stale. */
  setHealth(health) {
    this.health = health;
    const s = (health && health.slicer) || {};
    fillSelect(this.profileEl, s.profileList || [], 'standard',
      p => `${p.label}`);
    fillSelect(this.filamentEl, s.filamentList || [], 'pla', f => f.label);
    if (!s.orca) {
      this.sliceBtn.disabled = true;
      this.sliceBtn.title = 'OrcaSlicer is not installed on this machine';
      this.note('The slicer is not installed here, so Bluesheet can only export the STL.');
    }
    return this;
  }

  /** The layer height of the chosen profile, for the analysis column. */
  layerH() {
    const s = (this.health && this.health.slicer) || {};
    const hit = (s.profileList || []).find(p => p.id === this.profileEl.value);
    return (hit && Number.isFinite(hit.layerH)) ? hit.layerH : 0.2;
  }

  material() { return this.filamentEl.value || 'pla'; }

  settings() {
    return {
      profile: this.profileEl.value || 'standard',
      filament: this.filamentEl.value || 'pla',
      infill: clamp(Number(this.infillEl.value) || 0, 0, 100),
      supports: !!this.supportsEl.checked,
    };
  }

  /** The geometry or the settings moved, so any slice we hold is now of a
   *  different object. Saying so is the whole reason Print is gated on it. */
  invalidate(reason = 'The object changed since that slice.') {
    if (!this.slice_) return this;
    this.setSlice(null);
    this.note(`${reason} Slice again before printing.`);
    this.h.onSliced && this.h.onSliced(null);
    return this;
  }

  setSlice(meta) {
    this.slice_ = meta;
    this.printBtn.disabled = !meta;
    this.printBtn.title = meta ? `Send ${meta.id} to the A1 mini` : 'Slice something first';
    if (meta) this.note(`Sliced: ${meta.timeText}, ${fmtGrams(meta.grams)}, ${meta.layers} layers. Print asks to confirm.`);
    return this;
  }

  note(text) { if (this.noteEl) this.noteEl.textContent = text; }

  // ---- progress ----------------------------------------------------------

  _phase(name, t, label) {
    const p = PHASES.find(x => x[0] === name);
    if (!p) return;
    const v = p[1] + (p[2] - p[1]) * clamp(t, 0, 1);
    this.progressEl.hidden = false;
    this.fillEl.classList.remove('is-busy');
    this.fillEl.style.width = `${(v * 100).toFixed(1)}%`;
    this.labelEl.textContent = label;
  }

  _done(label) {
    this.fillEl.classList.remove('is-busy');
    this.fillEl.style.width = '100%';
    this.labelEl.textContent = label;
    setTimeout(() => { if (!this.busy) this.progressEl.hidden = true; }, 1400);
  }

  _failed(label) {
    this.fillEl.classList.remove('is-busy');
    this.labelEl.textContent = label;
  }

  // ---- the slice ---------------------------------------------------------

  async run() {
    if (this.busy) return null;
    this.busy = true;
    this.sliceBtn.disabled = true;
    this.h.onBusy && this.h.onBusy(true);
    const t0 = performance.now();
    try {
      this._phase('build', 0.1, 'Building the solid');
      // A plate is several objects at positions Bluesheet chose, sliced with the
      // slicer's own arranging switched off so the print is the preview.
      const objects = this.h.objects ? await this.h.objects() : null;
      const name = this.h.name();
      let body;
      if (objects && objects.length) {
        const total = objects.reduce((s, o) => s + o.bytes.byteLength, 0);
        this._phase('build', 1, `${objects.length} objects, ${(total / 1024).toFixed(0)} kB of STL`);
        body = JSON.stringify({
          name,
          objects: objects.map(o => ({ stl: base64(o.bytes), name: o.name, x: o.x, y: o.y, rot: o.rot || 0 })),
          settings: { ...this.settings(), arrange: false },
        });
      } else {
        const bytes = await this.h.stl();
        this._phase('build', 1, `${(bytes.byteLength / 1024).toFixed(0)} kB of STL`);
        body = JSON.stringify({ name, stl: base64(bytes), settings: this.settings() });
      }

      const est = Math.max(1.5, Number(localStorage.getItem(LAST_SLICE_KEY)) || 6);
      let ticker = 0;
      const meta = await postJSON('api/slice', body, {
        onUpload: (sent, total) => {
          this._phase('upload', total ? sent / total : 0,
            `Sending ${(sent / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB`);
        },
        onSent: () => {
          const start = performance.now();
          ticker = setInterval(() => {
            const s = (performance.now() - start) / 1000;
            this._phase('slice', Math.min(0.97, s / est),
              `Slicing — ${s.toFixed(1)} s (last one took ${est.toFixed(1)} s)`);
          }, 100);
        },
      });
      clearInterval(ticker);
      if (Number.isFinite(meta.sliceSec)) {
        try { localStorage.setItem(LAST_SLICE_KEY, String(meta.sliceSec)); } catch { /* private mode */ }
      }

      meta.profileLabel = labelOf(this.profileEl);
      this.setSlice(meta);
      this.h.onSliced && this.h.onSliced(meta);
      this._record(meta);            // the Made log; deliberately not awaited

      this._phase('gcode', 0, 'Fetching the toolpaths');
      try {
        const doc = await this._gcode(meta.id);
        this.h.onGcode && this.h.onGcode(doc);
      } catch (e) {
        // A preview that will not load does not invalidate a slice that did.
        this.h.onStatus && this.h.onStatus('Sliced', `Toolpath preview unavailable: ${e.message}`, 'warn');
      }
      this._done(`Sliced in ${((performance.now() - t0) / 1000).toFixed(1)} s — ${meta.timeText}, ${fmtGrams(meta.grams)}`);
      this.h.onStatus && this.h.onStatus('Sliced', `${meta.timeText} · ${fmtGrams(meta.grams)} · ${meta.layers} layers · ${cost(meta.grams)}`, null);
      return meta;
    } catch (e) {
      this._failed(`Slice failed: ${e.message}`);
      this.h.onStatus && this.h.onStatus('Failed', e.message, 'error');
      return null;
    } finally {
      this.busy = false;
      this.sliceBtn.disabled = false;
      this.h.onBusy && this.h.onBusy(false);
    }
  }

  /** Tell the Made log a slice happened. `h.madeRecord()` supplies what only
   *  the application knows — generator, parameters, the render — and this adds
   *  the slice id and the profile. Nothing here can fail the slice: a log that
   *  broke the thing it was logging would be the wrong trade. */
  async _record(meta) {
    if (!this.h.madeRecord) return null;
    try {
      const fields = await this.h.madeRecord(meta);
      if (!fields || !fields.gen) return null;
      const body = JSON.stringify({
        sliceId: meta.id, profileLabel: meta.profileLabel || labelOf(this.profileEl), ...fields,
      });
      const res = await postJSON('api/made', body);
      this.h.onRecorded && this.h.onRecorded(res.job || null);
      return res.job || null;
    } catch (e) {
      this.note(`Sliced, but the Made log did not record it: ${e.message}`);
      return null;
    }
  }

  async _gcode(id) {
    const doc = await getJSON(`api/slice/${encodeURIComponent(id)}/gcode?maxPoints=${GCODE_MAX_POINTS}`, {
      onProgress: (got, total) => this._phase('gcode', total ? got / total : 0,
        `Toolpaths — ${(got / 1024 / 1024).toFixed(1)} MB`),
    });
    return toPlateFrame(doc, (this.health && this.health.slicer && this.health.slicer.bed) || { x: 180, y: 180 });
  }

  // ---- the print ---------------------------------------------------------

  async openConfirm() {
    if (!this.slice_) return;
    const m = this.slice_;
    const name = this.h.name();
    this.cName.textContent = name;
    this.cGoName.textContent = name;
    this.cTime.textContent = m.timeText || duration(m.timeSec);
    this.cGrams.textContent = `${fmtGrams(m.grams)} (${cost(m.grams)})`;
    this.cStart.checked = false;
    this.cPrinter.textContent = 'asking…';
    this.confirmEl.hidden = false;
    this._lastFocus = document.activeElement;
    this._untrap = trapFocus(this.confirmEl, () => this.closeConfirm());
    this.cGo.focus();
    try {
      const state = await getJSON('api/print');
      const p = state.printer || {};
      this.cPrinter.textContent = `${p.name || 'A1 mini'} — ${p.state || (p.online === false ? 'offline' : 'unknown')}`;
      // A printer that is mid-job cannot start another; say so before the press.
      const busy = ['RUNNING', 'PREPARE', 'SLICING', 'PAUSE'].includes(p.state);
      this.cStart.disabled = busy || p.online === false;
      if (busy) this.cStart.checked = false;
    } catch (e) {
      this.cPrinter.textContent = `not reachable (${e.message})`;
      this.cStart.disabled = true;
    }
  }

  _plateCheck(show) {
    this.cPlate.hidden = !show;
    if (show) { this.cClear.checked = false; this._refreshShot(); }
  }

  _refreshShot() {
    this.cShot.src = `http://${location.hostname}:8131/snapshot.jpg?hd=0&t=${Date.now()}`;
  }

  closeConfirm() {
    this.confirmEl.hidden = true;
    this._plateCheck(false);
    if (this._untrap) { this._untrap(); this._untrap = null; }
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
  }

  async send() {
    const m = this.slice_;
    if (!m) return null;
    const start = !!this.cStart.checked && !this.cStart.disabled;
    this.cGo.disabled = true;
    const name = this.h.name();
    try {
      if (start && !(this.cClear && this.cClear.checked)) {
        this.note('Tick "the plate is clear" before starting — look at the frame first.');
        this._refreshShot();
        return null;
      }
      const bedClear = start ? true : undefined;
      let res = await postJSON('api/print', JSON.stringify({ id: m.id, name, start, bedClear }), { allow409: true });
      // A 409 that is not the token handshake is a refusal — the printer is
      // mid-job — and must not be read as a successful send.
      if (res.ok === false) throw new Error(res.error || 'the printer refused the job');
      // The server issues a single-use token for this exact job and wants it
      // back. The human confirmation already happened — this second call is the
      // machine half of the same act, not a second question.
      if (res.needsConfirm && res.confirm && start) {
        res = await postJSON('api/print', JSON.stringify({ id: m.id, name, start: true, confirm: res.confirm, bedClear: true }));
      }
      this.closeConfirm();
      const where = res.started ? 'started on the A1 mini' : 'on the printer’s SD card';
      this.h.onStatus && this.h.onStatus('Sent', `${res.name} — ${where}`, null);
      this.note(`${res.name} is ${where}.`);
      return res;
    } catch (e) {
      this.h.onStatus && this.h.onStatus('Not sent', e.message, 'error');
      this.cPrinter.textContent = e.message.slice(0, 80);
      return null;
    } finally {
      this.cGo.disabled = false;
    }
  }
}

// ---- helpers -------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function labelOf(select) {
  const o = select.selectedOptions && select.selectedOptions[0];
  return o ? o.textContent : select.value;
}

function fillSelect(select, list, fallback, label) {
  const want = select.value || fallback;
  clear(select);
  const items = list.length ? list : [{ id: fallback, label: fallback.toUpperCase() }];
  for (const it of items) select.appendChild(el('option', { value: it.id, text: label(it) }));
  select.value = items.some(i => i.id === want) ? want : items[0].id;
}

/** Binary to base64 without blowing the argument limit on a 40 MB STL. */
export function base64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}

/** XHR rather than fetch: fetch cannot report upload progress, and a 12 MB STL
 *  going over wifi is exactly where a person wants to see something moving. */
function postJSON(url, body, { onUpload, onSent, allow409 = false } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.responseType = 'text';
    if (onUpload) x.upload.onprogress = (e) => { if (e.lengthComputable) onUpload(e.loaded, e.total); };
    if (onSent) x.upload.onload = () => onSent();
    x.onerror = () => reject(new Error('the server did not answer'));
    x.ontimeout = () => reject(new Error('the server timed out'));
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && data) return resolve(data);
      if (allow409 && x.status === 409 && data) return resolve(data);
      reject(new Error((data && (data.error || data.message)) || `HTTP ${x.status}`));
    };
    x.send(body);
  });
}

function getJSON(url, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.setRequestHeader('Accept', 'application/json');
    if (onProgress) x.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    x.onerror = () => reject(new Error('the server did not answer'));
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && data) return resolve(data);
      reject(new Error((data && data.error) || `HTTP ${x.status}`));
    };
    x.send();
  });
}

/**
 * The slicer speaks the printer's frame — origin at the front-left of the bed,
 * 0…180 — and the viewer draws the plate centred on the origin. Shifting here,
 * once, is what stops the toolpath preview appearing in the far corner of the
 * plate with the object nowhere near it.
 *
 * `dim: 2` is set explicitly: a flat 2D point list whose length happens to
 * divide by three would otherwise be read as 3D and drawn as confetti.
 */
export function toPlateFrame(doc, bed) {
  const ox = (bed.x || 180) / 2, oy = (bed.y || 180) / 2;
  const layers = (doc.layers || []).map(layer => ({
    z: layer.z,
    paths: (layer.paths || []).map(p => {
      const pts = p.pts || p.points || [];
      const out = new Float32Array(pts.length);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        out[i] = pts[i] - ox;
        out[i + 1] = pts[i + 1] - oy;
      }
      return { type: p.type, width: p.width, dim: 2, pts: out };
    }),
  }));
  return { ...doc, layers };
}
