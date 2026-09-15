// The parameter panel.
//
// Every generator declares its own parameters, so this builds itself from the
// declaration rather than from a per-generator template. Three rules shape it:
//
//   * A number is a stepper — minus, a field, plus — because it is driven from a tablet
//     and a bare drag-slider on a touch screen cannot be nudged by one. The
//     field itself also scrubs sideways under a finger, which is the fast way,
//     but nothing depends on that being discovered.
//   * Rows are built once per generator and then updated in place. Rebuilding
//     the panel on every keystroke would take the focus away mid-edit and would
//     take the dimension callout with it.
//   * Focusing a numeric parameter is what draws its dimension on the model, so
//     focus is a first-class output of this module, not an incidental.

import { el, clear, $ } from './dom.js';
import { coerce, groupParams } from '../gen/index.js';

const SCRUB_START_PX = 4;       // a tap must still be a tap
const SCRUB_PX_PER_STEP = 7;
const HOLD_FIRST_MS = 420;
const HOLD_REPEAT_MS = 70;

export class ParamPanel {
  /**
   * @param {HTMLElement} root      [data-param-groups]
   * @param {object} h  {onChange(key,value), onFocus(param|null), onCommit()}
   */
  constructor(root, h = {}) {
    this.root = root;
    this.h = h;
    this.gen = null;
    this.values = {};
    this.rows = new Map();        // key -> {q, row, set(v), setSoft(bool)}
    this.focusKey = null;
    this._blurTimer = 0;
  }

  setGenerator(gen, values) {
    this.gen = gen;
    this.values = { ...values };
    this.rows.clear();
    this.focusKey = null;
    clear(this.root);
    if (!gen) return this;

    // Groups are laid out in declaration order, and every parameter gets a row
    // whether or not showIf currently allows it — hiding is a class toggle, so
    // a parameter appearing does not rebuild the panel under the user's finger.
    const groups = groupOrder(gen);
    for (const [name, params] of groups) {
      const body = el('div');
      const section = el('section.group', null, [
        el('div.group-head', null, [el('h3.lbl', { text: name })]),
        body,
      ]);
      for (const q of params) {
        const built = this._row(q);
        if (!built) continue;
        this.rows.set(q.key, built);
        body.appendChild(built.row);
      }
      this.root.appendChild(section);
    }
    this.setValues(values);
    return this;
  }

  /** Push new values into the existing rows and re-evaluate visibility. */
  setValues(values) {
    this.values = { ...values };
    if (!this.gen) return this;
    const visible = new Set(groupParams(this.gen, this.values).flatMap(g => g.params.map(p => p.key)));
    for (const [key, r] of this.rows) {
      const on = visible.has(key);
      if (r.row.hidden === on) r.row.hidden = !on;
      // Hidden rows are synced too. `showIf` decides what is on SCREEN, not what
      // is true, and the value under a hidden row moves all the time — a preset,
      // a saved design, a clamp applied by a parameter it depends on. Skipping
      // them meant the row reappeared showing whatever it held when it was last
      // visible: switch a box to a hinged lid and "Snap catch" would come back
      // unticked on a box that has one. The panel is a picture of the model or
      // it is worthless, and re-setting forty fields costs nothing.
      // Never overwrite the field the user is typing in.
      if (key !== this.focusKey || !r.isEditing || !r.isEditing()) r.set(this.values[key]);
      if (r.setSoft) r.setSoft(isSoft(r.q, this.values[key]));
    }
    return this;
  }

  /** Mark a row as the one the callouts are describing. */
  highlight(key) {
    for (const [k, r] of this.rows) r.row.classList.toggle('prow--focus', k === key);
  }

  focusedParam() {
    const r = this.focusKey ? this.rows.get(this.focusKey) : null;
    return r ? r.q : null;
  }

  // ---- plumbing ----------------------------------------------------------

  _emit(q, value) {
    const v = coerce(q, value);
    if (Object.is(this.values[q.key], v)) return;
    this.values[q.key] = v;
    this.h.onChange && this.h.onChange(q.key, v);
  }

  _focus(q) {
    if (this._blurTimer) { clearTimeout(this._blurTimer); this._blurTimer = 0; }
    this.focusKey = q ? q.key : null;
    this.highlight(this.focusKey);
    this.h.onFocus && this.h.onFocus(q || null);
  }

  _blur(q) {
    if (this.focusKey !== q.key) return;
    // A stepper press moves focus from the field to the button and back; a beat
    // of tolerance stops the callout flickering off and on between the two.
    if (this._blurTimer) clearTimeout(this._blurTimer);
    this._blurTimer = setTimeout(() => {
      this._blurTimer = 0;
      if (this.focusKey !== q.key) return;
      this.focusKey = null;
      this.highlight(null);
      this.h.onFocus && this.h.onFocus(null);
    }, 140);
  }

  // ---- row builders ------------------------------------------------------

  _row(q) {
    switch (q.type) {
      case 'number': case 'int': return this._numberRow(q);
      case 'bool': return this._boolRow(q);
      case 'enum': return this._enumRow(q);
      case 'vec2': return this._vec2Row(q);
      case 'image': return this._imageRow(q);
      case 'field': return this._fieldRow(q);
      case 'series': return this._seriesRow(q);
      case 'color': return this._colorRow(q);
      default: return this._textRow(q);
    }
  }

  _head(q, forId) {
    const kids = [el('label.lbl', { for: forId, text: q.label || q.key })];
    if (q.unit) kids.push(el('span.unit.num', { text: q.unit }));
    return el('div.prow-head', null, kids);
  }

  _help(q) {
    return q.help ? el('p.help', { id: `help-${q.key}`, text: q.help }) : null;
  }

  _numberRow(q) {
    const id = `p-${q.key}`;
    const step = Number.isFinite(q.step) ? q.step : (q.type === 'int' ? 1 : 0.1);
    const input = el('input.num.field', {
      id, type: 'text', inputmode: q.type === 'int' ? 'numeric' : 'decimal',
      autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': q.help ? `help-${q.key}` : null,
    });
    const minus = el('button.step', { type: 'button', 'aria-label': `Decrease ${q.label || q.key}`, text: '−' });
    const plus = el('button.step', { type: 'button', 'aria-label': `Increase ${q.label || q.key}`, text: '+' });
    const stepper = el('div.stepper', null, [minus, input, plus]);
    const row = el('div.prow.prow--num', { dataset: { param: q.key } },
      [this._head(q, id), stepper, this._help(q)]);

    const current = () => {
      const v = parseFloat(input.value);
      return Number.isFinite(v) ? v : (Number.isFinite(this.values[q.key]) ? this.values[q.key] : q.def);
    };
    const nudge = (mult) => {
      const next = coerce(q, current() + step * mult);
      input.value = fmtNum(next, q);
      this._emit(q, next);
    };

    // Press and hold repeats, which is how you get from 10 to 60 with a thumb.
    for (const [btn, sign] of [[minus, -1], [plus, 1]]) {
      let t1 = 0, t2 = 0;
      const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = 0; };
      btn.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        e.preventDefault();
        this._focus(q);
        nudge(sign);
        t1 = setTimeout(() => { t2 = setInterval(() => nudge(sign), HOLD_REPEAT_MS); }, HOLD_FIRST_MS);
        btn.setPointerCapture && btn.setPointerCapture(e.pointerId);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop);
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._focus(q); nudge(sign); }
      });
      btn.addEventListener('focus', () => this._focus(q));
      btn.addEventListener('blur', () => this._blur(q));
    }

    input.addEventListener('focus', () => { input.select(); this._focus(q); });
    input.addEventListener('blur', () => { input.value = fmtNum(this.values[q.key], q); this._blur(q); });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      // Live while it parses, so the model follows the typing; the field is not
      // rewritten until blur so "1." and "-" survive being half-typed.
      if (Number.isFinite(v)) this._emit(q, v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); nudge(e.shiftKey ? 10 : 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -10 : -1); }
      else if (e.key === 'Enter') { input.value = fmtNum(this.values[q.key], q); input.blur(); }
    });

    // Sideways scrub. Deliberately does not start until the pointer has moved,
    // so a tap is still a tap and the field can be typed into.
    let drag = null;
    input.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.pointerType === 'mouse' && e.buttons !== 1) return;
      drag = { x: e.clientX, base: current(), active: false, id: e.pointerId };
    });
    input.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      if (!drag.active) {
        if (Math.abs(dx) < SCRUB_START_PX) return;
        drag.active = true;
        input.setPointerCapture && input.setPointerCapture(e.pointerId);
        this._focus(q);
      }
      e.preventDefault();
      const fine = e.shiftKey ? 0.2 : 1;
      const next = coerce(q, drag.base + Math.round(dx / SCRUB_PX_PER_STEP) * step * fine);
      input.value = fmtNum(next, q);
      this._emit(q, next);
    });
    const endDrag = (e) => {
      if (!drag) return;
      if (drag.active) { input.value = fmtNum(this.values[q.key], q); this.h.onCommit && this.h.onCommit(); }
      try { input.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
      drag = null;
    };
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);

    return {
      q, row,
      set: (v) => { input.value = fmtNum(v, q); },
      setSoft: (on) => row.classList.toggle('prow--soft', on),
      isEditing: () => document.activeElement === input,
    };
  }

  _boolRow(q) {
    const id = `p-${q.key}`;
    const input = el('input.check', {
      id, type: 'checkbox',
      'aria-describedby': q.help ? `help-${q.key}` : null,
    });
    const label = el('label.prow--bool', { for: id, dataset: { param: q.key } }, [
      el('span.lbl', { text: q.label || q.key }),
      input,
      el('span.box', { 'aria-hidden': 'true' }),
    ]);
    const wrap = el('div.prow.prow--boolwrap', { dataset: { param: q.key } },
      [label, this._help(q)]);
    input.addEventListener('change', () => this._emit(q, input.checked));
    input.addEventListener('focus', () => this._focus(q));
    input.addEventListener('blur', () => this._blur(q));
    return { q, row: wrap, set: (v) => { input.checked = !!v; } };
  }

  _enumRow(q) {
    const id = `p-${q.key}`;
    const sel = el('select.field.select', { id, 'aria-describedby': q.help ? `help-${q.key}` : null });
    for (const o of q.options || []) sel.appendChild(el('option', { value: String(o.v), text: o.label ?? String(o.v) }));
    const row = el('div.prow.prow--enum', { dataset: { param: q.key } },
      [this._head(q, id), sel, this._help(q)]);
    sel.addEventListener('change', () => this._emit(q, sel.value));
    sel.addEventListener('focus', () => this._focus(q));
    sel.addEventListener('blur', () => this._blur(q));
    return { q, row, set: (v) => { sel.value = String(v); } };
  }

  _textRow(q) {
    const id = `p-${q.key}`;
    const input = el('input.field.num', {
      id, type: 'text', autocomplete: 'off', spellcheck: 'false',
      maxlength: q.maxLength ?? 128,
      'aria-describedby': q.help ? `help-${q.key}` : null,
    });
    const row = el('div.prow.prow--text', { dataset: { param: q.key } },
      [this._head(q, id), input, this._help(q)]);
    input.addEventListener('input', () => this._emit(q, input.value));
    input.addEventListener('focus', () => this._focus(q));
    input.addEventListener('blur', () => this._blur(q));
    return { q, row, set: (v) => { if (document.activeElement !== input) input.value = v ?? ''; },
      isEditing: () => document.activeElement === input };
  }

  _vec2Row(q) {
    const id = `p-${q.key}`;
    const mk = (suffix, aria) => el('input.num.field', {
      id: `${id}-${suffix}`, type: 'text', inputmode: 'decimal',
      autocomplete: 'off', 'aria-label': `${q.label || q.key} ${aria}`,
    });
    const ax = mk('x', 'X'), ay = mk('y', 'Y');
    const row = el('div.prow.prow--vec2', { dataset: { param: q.key } }, [
      this._head(q, `${id}-x`),
      el('div.vec2', null, [ax, ay]),
      this._help(q),
    ]);
    const push = () => {
      const v = [numOr(ax.value, 0), numOr(ay.value, 0)];
      this.values[q.key] = v;
      this.h.onChange && this.h.onChange(q.key, v);
    };
    for (const f of [ax, ay]) {
      f.addEventListener('input', push);
      f.addEventListener('focus', () => this._focus(q));
      f.addEventListener('blur', () => this._blur(q));
    }
    return {
      q, row,
      set: (v) => {
        const a = Array.isArray(v) ? v : [0, 0];
        if (document.activeElement !== ax) ax.value = trimNum(a[0]);
        if (document.activeElement !== ay) ay.value = trimNum(a[1]);
      },
      isEditing: () => document.activeElement === ax || document.activeElement === ay,
    };
  }

  _colorRow(q) {
    const id = `p-${q.key}`;
    const input = el('input', { id, type: 'color' });
    const readout = el('span.num', { text: '' });
    const row = el('div.prow.prow--color', { dataset: { param: q.key } }, [
      this._head(q, id),
      el('div.swatch-row', null, [input, readout]),
      this._help(q),
    ]);
    input.addEventListener('input', () => { readout.textContent = input.value.toUpperCase(); this._emit(q, input.value); });
    input.addEventListener('focus', () => this._focus(q));
    input.addEventListener('blur', () => this._blur(q));
    return { q, row, set: (v) => { input.value = String(v || '#cccccc'); readout.textContent = input.value.toUpperCase(); } };
  }

  _seriesRow(q) {
    const id = `p-${q.key}`;
    const area = el('textarea.field', {
      id, rows: 4, spellcheck: 'false',
      placeholder: '12, 18, 7, 24 …',
      'aria-describedby': q.help ? `help-${q.key}` : null,
    });
    const count = el('span.unit.num', { text: '' });
    const head = el('div.prow-head', null, [
      el('label.lbl', { for: id, text: q.label || q.key }), count,
    ]);
    const row = el('div.prow.prow--series', { dataset: { param: q.key } }, [head, area, this._help(q)]);
    const push = () => {
      const v = parseSeries(area.value);
      count.textContent = `${v.length} value${v.length === 1 ? '' : 's'}`;
      this.values[q.key] = v;
      this.h.onChange && this.h.onChange(q.key, v);
    };
    area.addEventListener('input', push);
    area.addEventListener('focus', () => this._focus(q));
    area.addEventListener('blur', () => this._blur(q));
    return {
      q, row,
      set: (v) => {
        const a = Array.isArray(v) ? v : [];
        count.textContent = `${a.length} value${a.length === 1 ? '' : 's'}`;
        if (document.activeElement !== area) area.value = a.map(trimNum).join(', ');
      },
      isEditing: () => document.activeElement === area,
    };
  }

  _imageRow(q) {
    const id = `p-${q.key}`;
    const file = el('input', { id, type: 'file', accept: 'image/*' });
    const thumb = el('canvas.thumb', { width: 56, height: 56, 'aria-hidden': 'true' });
    const caption = el('span.help', { text: 'Drop a picture, or tap to choose one' });
    const zone = el('label.dropzone', { for: id }, [thumb, caption]);
    const row = el('div.prow.prow--image', { dataset: { param: q.key } }, [
      el('div.prow-head', null, [el('label.lbl', { for: id, text: q.label || q.key })]),
      zone, file, this._help(q),
    ]);

    const take = async (f) => {
      if (!f) return;
      try {
        const field = await imageToGray(f, q.maxSize ?? 512);
        this.values[q.key] = field;
        this.h.onChange && this.h.onChange(q.key, field);
        drawThumb(thumb, field);
        caption.textContent = `${f.name.slice(0, 22)} — ${field.w} × ${field.h}`;
      } catch (e) {
        caption.textContent = `That file would not open as a picture (${e.message})`;
      }
    };
    file.addEventListener('change', () => take(file.files && file.files[0]));
    file.addEventListener('focus', () => this._focus(q));
    file.addEventListener('blur', () => this._blur(q));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    return {
      q, row,
      set: (v) => {
        if (v && v.w && (v.gray || v.data)) {
          drawThumb(thumb, v);
          if (!/×/.test(caption.textContent)) caption.textContent = `${v.w} × ${v.h}`;
        }
      },
    };
  }

  /**
   * Elevation for a place. Type somewhere — a name, a postcode, "51.45, -2.6" —
   * pick the match, set how big a square, and fetch; the server samples real
   * terrain and the value that lands in the parameter is a {w, h, data, meta}
   * heightfield the terrain generator already knows how to read. Everything
   * here is a button or a field a finger can use.
   */
  _fieldRow(q) {
    const id = `p-${q.key}`;
    const search = el('input.field', { id, type: 'search', placeholder: 'Place, postcode, or "lat, lon"',
      autocomplete: 'off', spellcheck: 'false', 'aria-describedby': q.help ? `help-${q.key}` : null });
    const find = el('button.btn', { type: 'button', text: 'Find' });
    const results = el('div.field-results', { role: 'listbox', 'aria-label': 'Matching places' });
    results.hidden = true;
    const lat = el('input.num.field', { type: 'text', inputmode: 'decimal', 'aria-label': 'Latitude', placeholder: 'lat' });
    const lon = el('input.num.field', { type: 'text', inputmode: 'decimal', 'aria-label': 'Longitude', placeholder: 'lon' });
    const span = el('input.num.field', { type: 'text', inputmode: 'decimal', 'aria-label': 'Square size in kilometres' });
    const spanMinus = el('button.step', { type: 'button', 'aria-label': 'Smaller square', text: '−' });
    const spanPlus = el('button.step', { type: 'button', 'aria-label': 'Bigger square', text: '+' });
    const fetchBtn = el('button.btn.btn--wide', { type: 'button', text: 'Fetch elevation' });
    const thumb = el('canvas.thumb', { width: 56, height: 56, 'aria-hidden': 'true' });
    const caption = el('span.help', { text: 'No elevation loaded yet — find a place and fetch it.' });
    const preview = el('div.field-preview', null, [thumb, caption]);
    const row = el('div.prow.prow--field', { dataset: { param: q.key } }, [
      el('div.prow-head', null, [el('label.lbl', { for: id, text: q.label || q.key })]),
      el('div.field-search', null, [search, find]),
      results,
      el('div.field-coords', null, [
        el('label.lbl', { text: 'Lat' }), lat, el('label.lbl', { text: 'Lon' }), lon,
      ]),
      el('div.field-span', null, [
        el('label.lbl', { text: 'Square' }),
        el('div.stepper', null, [spanMinus, span, spanPlus]),
        el('span.unit.num', { text: 'km' }),
      ]),
      fetchBtn, preview, this._help(q),
    ]);
    span.value = '3';
    let picked = null;                     // the geocoder hit the coordinates came from

    const num = (input) => { const v = parseFloat(input.value); return Number.isFinite(v) ? v : null; };
    const say = (text, bad = false) => { caption.textContent = text; caption.classList.toggle('is-bad', bad); };
    const nudgeSpan = (mult) => {
      const v = num(span) ?? 3;
      const step = v < 2 ? 0.25 : v < 10 ? 0.5 : 2;
      span.value = String(Math.max(0.25, Math.min(60, Math.round((v + step * mult) / 0.25) * 0.25)));
    };
    spanMinus.addEventListener('click', () => nudgeSpan(-1));
    spanPlus.addEventListener('click', () => nudgeSpan(1));

    const choose = (hit) => {
      picked = hit;
      lat.value = hit.lat.toFixed(5);
      lon.value = hit.lon.toFixed(5);
      if (Number.isFinite(hit.spanKm)) span.value = String(hit.spanKm);
      results.hidden = true;
      say(`${shortName(hit.name)} — ${lat.value}, ${lon.value}. Fetch to load it.`);
    };
    const lookUp = async () => {
      const text = search.value.trim();
      if (!text) return;
      find.disabled = true;
      say('Looking it up…');
      try {
        const r = await fetch(`api/geocode?q=${encodeURIComponent(text)}`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
        clear(results);
        if (!j.results.length) { results.hidden = true; say(`Nothing called “${text}” — try a town or a postcode.`, true); return; }
        for (const hit of j.results) {
          const b = el('button.btn.btn--wide.field-hit', { type: 'button', role: 'option', text: shortName(hit.name), title: hit.name });
          b.addEventListener('click', () => choose(hit));
          results.appendChild(b);
        }
        results.hidden = false;
        if (j.results.length === 1) choose(j.results[0]);
        else say(`${j.results.length} matches — pick one.`);
      } catch (e) {
        say(`Could not look that up: ${e.message}`, true);
      } finally {
        find.disabled = false;
      }
    };
    find.addEventListener('click', lookUp);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookUp(); } });

    const fetchField = async () => {
      const la = num(lat), lo = num(lon), km = num(span);
      if (la === null || lo === null) { say('Find a place first, or type a latitude and longitude.', true); return; }
      fetchBtn.disabled = true;
      say(`Fetching ${km ?? 3} km of terrain around ${la.toFixed(4)}, ${lo.toFixed(4)}…`);
      try {
        const r = await fetch(`api/elevation?lat=${la}&lon=${lo}&km=${km ?? 3}&n=128`, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
        const name = picked && Math.abs(picked.lat - la) < 1e-4 && Math.abs(picked.lon - lo) < 1e-4
          ? shortName(picked.name) : `${la.toFixed(4)}, ${lo.toFixed(4)}`;
        const field = {
          w: j.w, h: j.h, data: j.data,
          meta: { name, lat: la, lon: lo, spanKm: j.spanKm, minM: j.min, maxM: j.max, bounds: j.bounds,
                  metresPerSample: j.metresPerSample, dataset: j.source || 'Terrarium', fetched: new Date().toISOString().slice(0, 10) },
        };
        this.values[q.key] = field;
        this.h.onChange && this.h.onChange(q.key, field);
        show(field);
      } catch (e) {
        say(`The terrain did not arrive: ${e.message}`, true);
      } finally {
        fetchBtn.disabled = false;
      }
    };
    fetchBtn.addEventListener('click', fetchField);
    for (const node of [search, lat, lon, span]) {
      node.addEventListener('focus', () => this._focus(q));
      node.addEventListener('blur', () => this._blur(q));
    }

    const show = (v) => {
      drawThumb(thumb, v);
      const m = v.meta || {};
      const bits = [];
      if (m.name) bits.push(m.name);
      if (Number.isFinite(m.spanKm)) bits.push(`${m.spanKm} km square`);
      if (Number.isFinite(m.minM) && Number.isFinite(m.maxM)) bits.push(`${Math.round(m.minM)}–${Math.round(m.maxM)} m`);
      bits.push(`${v.w} × ${v.h}`);
      say(bits.join(' · '));
      if (Number.isFinite(m.lat) && !lat.value) lat.value = Number(m.lat).toFixed(5);
      if (Number.isFinite(m.lon) && !lon.value) lon.value = Number(m.lon).toFixed(5);
      if (Number.isFinite(m.spanKm)) span.value = String(m.spanKm);
    };

    return {
      q, row,
      set: (v) => { if (v && v.w && v.data) show(v); },
    };
  }
}

/** The first two comma-separated parts of a geocoder display name: "Cheddar
 *  Gorge & Caves, Cliff Road" rather than the whole postal address. */
function shortName(name) {
  const parts = String(name || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join(', ').slice(0, 48) || String(name || '');
}

// ---- helpers -------------------------------------------------------------

/** Declaration order, but every parameter present — including ones showIf is
 *  currently hiding, so revealing one is a class toggle rather than a rebuild. */
function groupOrder(gen) {
  const groups = new Map();
  for (const q of gen.params) {
    const g = q.group || 'Parameters';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(q);
  }
  return [...groups.entries()];
}

function isSoft(q, v) {
  if (!q || q.soft !== true || !Number.isFinite(v)) return false;
  return v < q.min || v > q.max;
}

function fmtNum(v, q) {
  if (!Number.isFinite(v)) return '';
  if (q.type === 'int') return String(Math.round(v));
  const dp = q.precision ?? decimalsOf(q.step);
  return v.toFixed(dp);
}

function decimalsOf(step) {
  if (!Number.isFinite(step)) return 2;
  const s = String(step), i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
}

function trimNum(v) {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1e6) / 1e6);
}

function numOr(s, d) { const v = parseFloat(s); return Number.isFinite(v) ? v : d; }

export function parseSeries(text) {
  return String(text || '')
    .split(/[^0-9eE+.\-]+/)
    .map(s => parseFloat(s))
    .filter(Number.isFinite);
}

/** A picture becomes {w, h, gray:Float32Array} in 0..1 — the shape PLAN.md
 *  promises a generator. Rec.709 luma, because a lithophane's thickness is
 *  perceived brightness and the naive average makes red skin go black. */
export async function imageToGray(file, maxSize = 512) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    }
    return { w, h, gray };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('not an image this browser can decode'));
    img.src = url;
  });
}

function drawThumb(canvas, field) {
  const src = field.gray || field.data;
  if (!src || !field.w || !field.h) return;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(field.w, field.h);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < src.length; i++) { if (src[i] < lo) lo = src[i]; if (src[i] > hi) hi = src[i]; }
  const span = hi - lo || 1;
  for (let i = 0, p = 0; i < src.length; i++, p += 4) {
    const v = Math.round(((src[i] - lo) / span) * 255);
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  const off = document.createElement('canvas');
  off.width = field.w; off.height = field.h;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = Math.min(canvas.width / field.w, canvas.height / field.h);
  const dw = field.w * s, dh = field.h * s;
  ctx.drawImage(off, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}
