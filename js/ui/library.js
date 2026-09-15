// Saved designs.
//
// A design is a generator id plus a parameter set plus a picture of it. The
// server keeps one JSON file per entry; this is the front of that.
//
// The one thing worth care here is bulk parameters. A lithophane's picture is a
// Float32Array of a quarter of a million samples, which is neither JSON nor
// small, and the server refuses a parameter set over 256 kB — quite rightly. So
// a grey field is packed to base64 bytes on the way out and unpacked on the way
// back, downsampled if it has to be, and the entry records that it was. Losing
// the picture silently and reloading a flat slab would be the failure that
// matters.

import { el, clear, $, $$, trapFocus } from './dom.js';

const MAX_FIELD_EDGE = 320;      // 320² bytes ≈ 137 kB of base64, inside the cap
const FIELD_TAG = 'bluesheet.gray/1';

export class Library {
  /**
   * @param {HTMLElement} overlay [data-library]
   * @param {object} h {onLoad(entry), current():{gen,params,provenance}, thumbnail():string}
   */
  constructor(overlay, h = {}) {
    this.root = overlay;
    this.h = h;
    this.entries = [];
    this.cardsEl = $('[data-lib-cards]', overlay);
    this.emptyEl = $('[data-lib-empty]', overlay);
    this._untrap = null;
    for (const b of $$('[data-close-library]', overlay)) b.addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
  }

  get isOpen() { return !this.root.hidden; }

  async open() {
    this.root.hidden = false;
    this._lastFocus = document.activeElement;
    this._untrap = trapFocus(this.root, () => this.close());
    const first = $('button, input', this.root);
    if (first) first.focus();
    await this.refresh();
    return this;
  }

  close() {
    if (!this.isOpen) return this;
    this.root.hidden = true;
    if (this._untrap) { this._untrap(); this._untrap = null; }
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
    return this;
  }

  // ---- server ------------------------------------------------------------

  async list() {
    const r = await fetch('api/library?thumbs=1', { headers: { Accept: 'application/json' } });
    const body = await r.json();
    if (!r.ok || !body.ok) throw new Error(body.error || `library listing failed (${r.status})`);
    this.entries = body.entries || [];
    return this.entries;
  }

  async refresh() {
    try {
      await this.list();
      this.render();
    } catch (e) {
      clear(this.cardsEl).appendChild(el('p.prose', { text: `The library did not answer: ${e.message}` }));
      this.emptyEl.hidden = true;
    }
    return this.entries;
  }

  /** @returns the stored entry. */
  async save({ name, gen, params, thumbnail, provenance, notes, sliceId, version }) {
    const packed = packParams(params);
    const r = await fetch('api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gen, name, params: packed.params, thumbnail: thumbnail || null,
        provenance: provenance || '', notes: notes || packed.note || '',
        sliceId: sliceId || null, version: version || 1,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || `save failed (${r.status})`);
    await this.refresh();
    return body.entry;
  }

  async remove(id) {
    const r = await fetch(`api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || `delete failed (${r.status})`);
    this.entries = this.entries.filter(e => e.id !== id);
    this.render();
    return true;
  }

  /** The entry with its bulk parameters turned back into what a generator wants. */
  entry(id) {
    const e = this.entries.find(x => x.id === id);
    return e ? { ...e, params: unpackParams(e.params) } : null;
  }

  // ---- rendering ---------------------------------------------------------

  render() {
    const frag = document.createDocumentFragment();
    for (const e of this.entries) frag.appendChild(this._card(e));
    clear(this.cardsEl).appendChild(frag);
    this.emptyEl.hidden = this.entries.length > 0;
    return this;
  }

  _card(entry) {
    const thumb = entry.thumbnail
      ? el('img.card-thumb', { src: entry.thumbnail, alt: '', width: 60, height: 60 })
      : el('div.card-thumb', { 'aria-hidden': 'true' });

    const load = el('button.card-open', {
      type: 'button', text: 'Open',
      'aria-label': `Open ${entry.name}`,
    });
    load.addEventListener('click', () => {
      this.close();
      this.h.onLoad && this.h.onLoad(this.entry(entry.id));
    });

    // Two steps, because the undo for this one is "build it again from memory".
    const del = el('button.card-del', { type: 'button', text: 'Delete', 'aria-label': `Delete ${entry.name}` });
    let armed = false;
    let disarm = 0;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Really?';
        del.classList.add('is-armed');
        disarm = setTimeout(() => { armed = false; del.textContent = 'Delete'; del.classList.remove('is-armed'); }, 4000);
        return;
      }
      clearTimeout(disarm);
      del.disabled = true;
      try { await this.remove(entry.id); }
      catch (e) { del.disabled = false; del.textContent = e.message.slice(0, 24); }
    });

    return el('div.card.card--saved', { dataset: { entry: entry.id, gen: entry.gen } }, [
      el('div.card-top', null, [
        thumb,
        el('div', null, [
          el('div.card-name', { text: entry.name }),
          el('div.card-cat', { text: `${entry.gen} · ${(entry.created || '').slice(0, 16).replace('T', ' ')}` }),
        ]),
      ]),
      entry.notes ? el('p.card-blurb', { text: entry.notes }) : null,
      el('div.card-foot', null, [load, del]),
    ].filter(Boolean));
  }
}

// ---- bulk parameter packing ---------------------------------------------

/** Turn anything that is not JSON into something that is. */
export function packParams(params) {
  const out = {};
  let note = '';
  for (const [k, v] of Object.entries(params || {})) {
    const field = asField(v);
    if (!field) { out[k] = v; continue; }
    const packed = packField(field);
    out[k] = packed.value;
    if (packed.reduced) {
      note = `The ${k} picture was saved at ${packed.value.w} × ${packed.value.h} — the library holds ${MAX_FIELD_EDGE} px at most.`;
    }
  }
  return { params: out, note };
}

export function unpackParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    out[k] = (v && typeof v === 'object' && v.__bluesheet === FIELD_TAG) ? unpackField(v) : v;
  }
  return out;
}

function asField(v) {
  if (!v || typeof v !== 'object') return null;
  const bulk = v.gray || v.data;
  if (!ArrayBuffer.isView(bulk) || !Number.isFinite(v.w) || !Number.isFinite(v.h)) return null;
  return { w: v.w, h: v.h, bulk, key: v.gray ? 'gray' : 'data' };
}

/** 0..1 grey samples to base64 bytes, box-filtered down if the field is large.
 *  Eight bits per sample is 1/256 of the range — under one layer of a
 *  lithophane's thickness, so nothing visible is lost to the quantisation. */
function packField(f) {
  const scale = Math.min(1, MAX_FIELD_EDGE / Math.max(f.w, f.h));
  const w = Math.max(1, Math.round(f.w * scale));
  const h = Math.max(1, Math.round(f.h * scale));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.bulk.length; i++) {
    const v = f.bulk[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  const span = (hi - lo) || 1;
  const bytes = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * f.h / h), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * f.h / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * f.w / w), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * f.w / w));
      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) { sum += f.bulk[sy * f.w + sx]; n++; }
      }
      bytes[y * w + x] = Math.max(0, Math.min(255, Math.round(((sum / (n || 1)) - lo) / span * 255)));
    }
  }
  return {
    reduced: w !== f.w || h !== f.h,
    value: { __bluesheet: FIELD_TAG, key: f.key, w, h, lo, hi, b64: toBase64(bytes) },
  };
}

function unpackField(p) {
  const bytes = fromBase64(p.b64);
  const span = (p.hi - p.lo) || 1;
  const arr = new Float32Array(p.w * p.h);
  for (let i = 0; i < arr.length && i < bytes.length; i++) arr[i] = p.lo + (bytes[i] / 255) * span;
  return p.key === 'data' ? { w: p.w, h: p.h, data: arr } : { w: p.w, h: p.h, gray: arr };
}

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;                    // apply() has an argument-count limit
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
