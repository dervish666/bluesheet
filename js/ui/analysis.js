// The analysis column: what the kernel knows about the object, stated plainly.
//
// Two halves. The facts are a column of measurements with the labels on the left
// and the values right-aligned in mono, so decimal points line up without a
// single alignment rule. The warnings are the sentences underneath — written by
// validate.js in full English, and reproduced here rather than reduced to an
// icon, because "three walls are 0.6 mm" is actionable and a yellow triangle is
// not.
//
// Slice results land in the same column, under the same rules, because a print
// time is a measurement of the object like its volume is.

import { el, clear } from './dom.js';
import { mm, size3, cm3, grams, count, pct, deg, duration, cost, materialName } from './format.js';

const SEVERITY_RANK = { error: 0, warn: 1, warning: 1, info: 2 };

export class AnalysisColumn {
  /**
   * @param {HTMLElement} facts     <dl data-facts>
   * @param {HTMLElement} warnings  <div data-warnings>
   * @param {HTMLElement} strip     the one-line summary shown when collapsed
   */
  constructor(facts, warnings, strip) {
    this.factsEl = facts;
    this.warnEl = warnings;
    this.stripEl = strip;
    this.state = { analysis: null, print: null, issues: [], slice: null, mesh: null, material: 'pla' };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.render();
    return this;
  }

  clearSlice() { this.state.slice = null; this.render(); return this; }

  render() {
    const { analysis: a, print: p, slice, mesh } = this.state;
    const rows = [];

    if (!a) {
      rows.push(['Status', 'Building…', null]);
    } else {
      rows.push(['Manifold', a.manifold ? 'Yes' : 'No', a.manifold ? null : 'bad']);
      if (a.boundaryEdges) rows.push(['Open edges', count(a.boundaryEdges), 'bad']);
      if (a.shells > 1) rows.push(['Loose pieces', count(a.shells), 'warn']);
      rows.push(['Triangles', count(a.triCount), null]);
    }

    const box = mesh ? mesh.bbox : (a && a.bbox);
    if (box) rows.push(['Size', size3(box.size), null]);
    if (a) rows.push(['Volume', cm3(a.volume), null]);

    if (p) {
      rows.push(['Mass', `${grams(p.estGrams)} ${materialName(p.material || this.state.material)}`, null]);
      if (Number.isFinite(p.estMetres)) rows.push(['Filament', `${p.estMetres.toFixed(2)} m`, null]);
      rows.push(['Fits the bed', p.fitsBed ? 'Yes' : 'No', p.fitsBed ? null : 'bad']);
      rows.push(['Height', `${mm(p.height)} mm`, null]);
      rows.push(['Layers', `${count(p.layers)} @ ${mm(p.layerH, 2)} mm`, null]);
      if (p.overhangPct > 0.05) {
        rows.push(['Overhang', `${pct(p.overhangPct)} · worst ${deg(p.worstOverhangDeg)}`,
          p.worstOverhangDeg > p.maxOverhang ? 'warn' : null]);
      }
      if (Number.isFinite(p.minThickness) && p.minThickness !== null) {
        rows.push(['Thinnest wall', `${mm(p.minThickness)} mm`,
          p.minThickness < p.minFeature ? 'warn' : null]);
      }
      if (p.unsupportedIslands) rows.push(['Islands', count(p.unsupportedIslands), 'warn']);
      if (p.maxBridgeSpan > 0.5) rows.push(['Longest bridge', `${mm(p.maxBridgeSpan)} mm`, null]);
    }

    if (slice) {
      rows.push(['—sep—', 'Sliced', null]);
      rows.push(['Print time', slice.timeText || duration(slice.timeSec), null]);
      rows.push(['Filament used', grams(slice.grams), slice.gramsEstimated ? 'warn' : null]);
      rows.push(['Sliced layers', count(slice.layers), null]);
      rows.push(['Cost', slice.cost ? `£${Number(slice.cost).toFixed(2)}` : cost(slice.grams), null]);
      if (slice.profileLabel) rows.push(['Profile', slice.profileLabel, null]);
    }

    const frag = document.createDocumentFragment();
    for (const [label, value, tone] of rows) {
      if (label === '—sep—') {
        frag.appendChild(el('div.fact.fact--sep', null, [
          el('dt.lbl.sub', { text: value }), el('dd', { text: '' }),
        ]));
        continue;
      }
      frag.appendChild(el('div.fact', null, [
        el('dt.lbl', { text: label }),
        el(`dd.num${tone === 'bad' ? '.is-bad' : tone === 'warn' ? '.is-warn' : ''}`, { text: value }),
      ]));
    }
    clear(this.factsEl).appendChild(frag);

    this._renderWarnings();
    this._renderStrip();
  }

  _renderWarnings() {
    const { analysis: a, print: p, issues } = this.state;
    const all = [
      ...(issues || []).map(i => ({ severity: i.severity || 'warn', code: i.param || 'PARAM', message: i.message })),
      ...((a && a.warnings) || []),
      ...((p && p.warnings) || []),
    ];
    // De-duplicate: analyze() and printability() both notice an empty mesh, and
    // saying it twice reads as two problems.
    const seen = new Set();
    const list = all.filter(w => {
      const k = `${w.code}|${w.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((x, y) => (SEVERITY_RANK[x.severity] ?? 3) - (SEVERITY_RANK[y.severity] ?? 3));

    const frag = document.createDocumentFragment();
    for (const w of list.slice(0, 24)) {
      const kind = w.severity === 'error' ? 'error' : w.severity === 'info' ? 'info' : 'warn';
      frag.appendChild(el(`div.warn.warn--${kind}`, null, [
        el('span.warn-code', { text: shortCode(w.code) }),
        el('span.warn-body', { text: w.message }),
      ]));
    }
    if (!list.length && this.state.analysis) {
      frag.appendChild(el('div.warn.warn--info', null, [
        el('span.warn-body', { text: 'Nothing to flag. It is watertight, it fits, and no wall is too thin to print.' }),
      ]));
    }
    clear(this.warnEl).appendChild(frag);
    this.warnEl.dataset.count = String(list.length);
  }

  _renderStrip() {
    if (!this.stripEl) return;
    const { analysis: a, print: p, mesh } = this.state;
    if (!a) { this.stripEl.textContent = 'Building…'; return; }
    const box = mesh ? mesh.bbox : a.bbox;
    const bits = [
      a.manifold ? 'Watertight' : 'NOT WATERTIGHT',
      box ? size3(box.size) : null,
      p ? grams(p.estGrams) : null,
      Number(this.warnEl.dataset.count) ? `${this.warnEl.dataset.count} to look at` : null,
    ].filter(Boolean);
    this.stripEl.textContent = bits.join('  ·  ');
  }
}

/** validate.js codes are SHOUTY_SNAKE; the column has 40 px for them. */
function shortCode(code) {
  return String(code || '').replace(/_/g, ' ').slice(0, 18);
}
