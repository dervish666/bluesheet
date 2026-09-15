// The Made log — what Bluesheet actually printed.
//
// One card per job, newest first. The render the browser drew when the object
// was sliced sits beside the photograph the workshop camera took when the print
// finished; under them, what the slicer promised against what happened. The
// server (server/made.py) owns the record and the state machine; this is the
// front of it, and the only things it writes are the two a person can change —
// a note, and the weight of the real object off a scale.
//
// Numbers here are shown only when they are known. A print that has not been
// weighed says "not weighed"; a print whose start was never observed is not
// scored. Inventing a figure to fill a column would defeat the point of a log
// whose job is to say how wrong the estimates are.
//
// While a job is printing the listing is re-read every few seconds, but only
// while the sheet is open and the tab is visible: the laptop this runs on lives
// in a cupboard with a printer and nowhere to put its heat.

import { el, clear, $, $$, trapFocus } from './dom.js';
import { duration, grams as fmtGrams } from './format.js';
import { unpackParams } from './library.js';

const STATE_TEXT = {
  sliced: 'Sliced', uploaded: 'On the SD card', printing: 'Printing',
  made: 'Made', failed: 'Failed', unknown: 'Unknown',
};
const LIVE = new Set(['sliced', 'uploaded', 'printing']);

export class MadePanel {
  /**
   * @param {HTMLElement} overlay [data-made]
   * @param {object} h {onLoad({gen, params, name, genName})}
   */
  constructor(overlay, h = {}) {
    this.root = overlay;
    this.h = h;
    this.jobs = [];
    this.accuracy = null;
    this.watcher = null;
    this.refreshMs = 5000;
    this._timer = 0;
    this._untrap = null;
    this._open = new Set();          // ids whose event list is unfolded across refreshes
    this.cardsEl = $('[data-made-cards]', overlay);
    this.emptyEl = $('[data-made-empty]', overlay);
    this.summaryEl = $('[data-made-summary]', overlay);
    this.watcherEl = $('[data-made-watcher]', overlay);
    for (const b of $$('[data-close-made]', overlay)) b.addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this._stopTimer(); return; }
      if (this.isOpen) { this.refresh(); }
    });
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
    this._stopTimer();
    if (this._untrap) { this._untrap(); this._untrap = null; }
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
    return this;
  }

  // ---- server ------------------------------------------------------------

  async list() {
    const r = await fetch('api/made', { headers: { Accept: 'application/json' } });
    const body = await r.json();
    if (!r.ok || !body.ok) throw new Error(body.error || `the Made log did not answer (${r.status})`);
    this.jobs = body.jobs || [];
    this.accuracy = body.accuracy || null;
    this.watcher = body.watcher || null;
    return this.jobs;
  }

  async refresh() {
    try {
      await this.list();
      this.render();
    } catch (e) {
      clear(this.cardsEl).appendChild(el('p.prose', { text: `The Made log did not answer: ${e.message}` }));
      this.emptyEl.hidden = true;
    }
    this._schedule();
    return this.jobs;
  }

  /** The job with its full parameter set, fetched if the listing left them out. */
  async job(id) {
    let j = this.jobs.find(x => x.id === id) || null;
    if (j && j.paramsTruncated) {
      const r = await fetch(`api/made/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
      const body = await r.json();
      if (!r.ok || !body.ok) throw new Error(body.error || `job ${id} would not load`);
      j = body.job;
    }
    return j ? { ...j, params: unpackParams(j.params) } : null;
  }

  async _post(id, payload) {
    const r = await fetch(`api/made/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
    const i = this.jobs.findIndex(j => j.id === id);
    if (i >= 0 && body.job) this.jobs[i] = body.job;
    return body.job;
  }

  saveNotes(id, notes) { return this._post(id, { notes }); }
  saveGrams(id, grams) { return this._post(id, { grams, gramsSource: 'weighed' }); }
  retake(id) { return this._post(id, { event: 'retake' }); }

  // ---- the timer ---------------------------------------------------------

  get printing() { return this.jobs.some(j => j.state === 'printing'); }

  _schedule() {
    this._stopTimer();
    if (!this.isOpen || document.hidden || !this.printing) return;
    this._timer = setTimeout(() => { this._timer = 0; this.refresh(); }, this.refreshMs);
  }

  _stopTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
  }

  get refreshing() { return this._timer !== 0; }

  // ---- rendering ---------------------------------------------------------

  render() {
    this._renderHead();
    // The textarea being typed in must not be rebuilt under the cursor.
    const editing = document.activeElement && this.cardsEl.contains(document.activeElement)
      ? document.activeElement.closest('[data-job]') : null;
    const frag = document.createDocumentFragment();
    for (const j of this.jobs) {
      if (editing && editing.dataset.job === j.id) { frag.appendChild(editing); continue; }
      frag.appendChild(this._card(j));
    }
    clear(this.cardsEl).appendChild(frag);
    this.emptyEl.hidden = this.jobs.length > 0;
    return this;
  }

  _renderHead() {
    const a = this.accuracy;
    if (this.summaryEl) {
      const t = a && a.time;
      this.summaryEl.textContent = t
        ? `${a.verdict} Median ×${t.medianRatio.toFixed(2)} over ${t.n} timed ${t.n === 1 ? 'print' : 'prints'}` +
          `${t.excludedInferredStart ? `, ${t.excludedInferredStart} not scored (start not observed)` : ''}.`
        : (a ? a.verdict : '');
    }
    const w = this.watcher;
    if (this.watcherEl) {
      if (!w) { this.watcherEl.textContent = ''; return; }
      const seen = w.lastStatus ? w.lastStatus.slice(11, 16) : 'never';
      const ok = w.running && !w.lastError && !w.unreachableSince;
      this.watcherEl.textContent = ok
        ? `Printer telemetry reachable · last seen ${seen}`
        : `Printer telemetry ${w.running ? 'unreachable' : 'not watched'}` +
          (w.lastStatus ? ` · last seen ${seen}` : ' · never seen') +
          (w.lastError ? ` · ${w.lastError.slice(0, 60)}` : '');
      this.watcherEl.dataset.reachable = ok ? 'yes' : 'no';
    }
  }

  _card(job) {
    const est = job.estimate || {};
    const act = job.actual || {};
    const p = job.print || {};
    const done = !LIVE.has(job.state);

    // -- the pictures
    const pics = el('div.made-pics', null, [
      figure('Render', job.renderUrl ? el('img.made-img', {
        src: `${job.renderUrl}?v=${(job.render || {}).bytes || 0}`, alt: `Render of ${job.name}`, loading: 'lazy',
      }) : el('div.made-img.made-img--none', { text: 'no render' })),
      figure('Photograph', job.photoUrl ? el('img.made-img', {
        src: `${job.photoUrl}?v=${Math.round((job.photo || {}).at || 0)}`, alt: `Photograph of ${job.name}`, loading: 'lazy',
      }) : el('div.made-img.made-img--none', {
        text: done ? (job.photoError ? 'camera failed' : 'no photograph') : 'not yet',
        title: job.photoError || '',
      })),
    ]);

    // -- the state line
    let stateText = STATE_TEXT[job.state] || job.state;
    if (job.state === 'printing') {
      const pct = Number.isFinite(p.percent) ? `${Math.round(p.percent)}%` : '—';
      const layer = p.totalLayers ? `layer ${p.layer || 0} / ${p.totalLayers}` : (p.layer ? `layer ${p.layer}` : '');
      const left = Number.isFinite(p.remainingMin) ? `${Math.round(p.remainingMin)} min left` : '';
      stateText = ['Printing', pct, layer, left].filter(Boolean).join(' · ');
      if (p.stale) stateText += ' · telemetry stale';
    }
    const state = el('div.made-state', { dataset: { state: job.state }, text: stateText });
    const err = job.error ? el('p.made-error', { text: job.error }) : null;

    // -- estimate against actual
    const eTime = est.seconds ? (est.timeText || duration(est.seconds)) : '—';
    const aTime = act.seconds ? duration(act.seconds) : (done ? 'not timed' : 'not finished');
    const eGrams = Number.isFinite(est.grams) && est.grams ? fmtGrams(est.grams) : '—';
    const aGrams = Number.isFinite(act.grams) && act.grams !== null
      ? `${fmtGrams(act.grams)}${act.gramsSource ? ` (${act.gramsSource})` : ''}`
      : (done ? 'not weighed' : '—');
    const cmp = el('div.made-cmp', { role: 'table' }, [
      el('span.lbl', { text: '' }), el('span.lbl', { text: 'Estimate' }), el('span.lbl', { text: 'Actual' }),
      el('span.lbl', { text: 'Time' }), el('span.num', { text: eTime }), el('span.num', { text: aTime, dataset: { actualTime: '' } }),
      el('span.lbl', { text: 'Filament' }), el('span.num', { text: eGrams }), el('span.num', { text: aGrams, dataset: { actualGrams: '' } }),
    ]);
    const verdict = el('p.made-verdict', { text: verdictOf(job) });

    // -- events, folded
    const events = el('details.made-events', { open: this._open.has(job.id) || null }, [
      el('summary.lbl', { text: `Events (${(job.events || []).length})` }),
      el('ul.num', null, (job.events || []).map(ev => el('li', null, [
        el('span.made-ev-at', { text: (ev.at || '').slice(5, 16).replace('T', ' ') }),
        ` ${ev.what}`,
        ev.detail ? el('span.made-ev-detail', { text: ` — ${ev.detail}` }) : null,
      ].filter(Boolean)))),
    ]);
    events.addEventListener('toggle', () => { if (events.open) this._open.add(job.id); else this._open.delete(job.id); });

    // -- notes, saved on blur
    const notes = el('textarea.made-notes', {
      rows: 2, placeholder: 'Notes — how it came out, what to change next time',
      'aria-label': `Notes on ${job.name}`, value: job.notes || '',
    });
    notes.addEventListener('blur', async () => {
      const text = notes.value;
      if (text === (job.notes || '')) return;
      notes.disabled = true;
      try { const j = await this.saveNotes(job.id, text); job.notes = j ? j.notes : text; }
      catch (e) { notes.placeholder = `Not saved: ${e.message}`; }
      finally { notes.disabled = false; }
    });

    // -- the weight, for finished prints only: the printer cannot weigh anything
    let weigh = null;
    if (done) {
      const input = el('input.field.made-grams', {
        type: 'number', inputmode: 'decimal', min: 0, step: 0.01, placeholder: 'g',
        'aria-label': `Weighed grams for ${job.name}`,
        value: Number.isFinite(act.grams) && act.grams !== null ? String(act.grams) : '',
      });
      input.addEventListener('change', async () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) return;
        input.disabled = true;
        try { await this.saveGrams(job.id, v); this.render(); }
        catch (e) { input.value = ''; input.placeholder = e.message.slice(0, 16); }
        finally { input.disabled = false; }
      });
      weigh = el('label.made-weigh', null, [el('span.lbl', { text: 'Weighed' }), input, el('span.lbl', { text: 'g' })]);
    }

    // -- actions
    const again = el('button.card-open', {
      type: 'button', text: 'Make another', 'aria-label': `Make another ${job.name}`,
      dataset: { makeAnother: job.id },
    });
    again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        const full = await this.job(job.id);
        this.close();
        this.h.onLoad && this.h.onLoad({ gen: full.gen, params: full.params, name: full.name, genName: full.genName, id: full.id });
      } catch (e) {
        again.textContent = e.message.slice(0, 24);
      } finally {
        again.disabled = false;
      }
    });
    const foot = [again];
    if (done && !job.photoUrl) {
      const retake = el('button.card-del', { type: 'button', text: 'Take photo', dataset: { retake: job.id } });
      retake.addEventListener('click', async () => {
        retake.disabled = true;
        try { await this.retake(job.id); this.render(); }
        catch (e) { retake.textContent = e.message.slice(0, 24); retake.disabled = false; }
      });
      foot.push(retake);
    }

    return el('div.card.card--made', { dataset: { job: job.id, gen: job.gen, state: job.state } }, [
      pics,
      el('div', null, [
        el('div.card-name', { text: job.name || job.gen }),
        el('div.card-cat', { text: `${job.genName || job.gen}${job.profileLabel ? ` · ${job.profileLabel}` : ''} · ${(job.created || '').slice(0, 16).replace('T', ' ')}` }),
      ]),
      state, err, cmp, verdict, weigh, events, notes,
      el('div.card-foot', null, foot),
    ].filter(Boolean));
  }
}

function figure(label, img) {
  return el('figure.made-fig', null, [img, el('figcaption.lbl', { text: label })]);
}

/** One line on how the estimate did, in plain words, or why it cannot be said. */
export function verdictOf(job) {
  const s = job.score;
  const act = job.actual || {};
  if (!s) {
    if (LIVE.has(job.state)) return 'Not finished, so not scored yet.';
    if (!act.seconds) return 'Not timed — the print was never observed running.';
    return 'Not scored.';
  }
  const parts = [];
  if (Number.isFinite(s.timePct)) {
    if (s.timing && s.timing !== 'observed') {
      // The elapsed time here is how long Bluesheet watched, not how long the
      // object took, so it is stated as a fact and refused as a score.
      const est = (job.estimate || {}).seconds;
      parts.push(`Not scored — the start was ${s.timing}; watched for ${duration(act.seconds)}` +
        (est ? ` against an estimate of ${duration(est)}` : ''));
    } else {
      const off = Math.abs(s.timePct);
      parts.push(off < 3 ? `Time within ${off.toFixed(0)}% of the estimate`
        : s.timePct > 0 ? `Took ${off.toFixed(0)}% longer than estimated`
          : `Finished ${off.toFixed(0)}% sooner than estimated`);
    }
  }
  if (Number.isFinite(s.gramsPct)) {
    const off = Math.abs(s.gramsPct);
    parts.push(off < 3 ? `weight within ${off.toFixed(0)}%`
      : `weight ${s.gramsPct > 0 ? 'over' : 'under'} by ${off.toFixed(0)}%${s.gramsSource ? ` (${s.gramsSource})` : ''}`);
  }
  return parts.length ? parts.join('; ') + '.' : 'Not scored.';
}
