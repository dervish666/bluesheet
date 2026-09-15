// The scale bar along the bottom of the model space.
//
// Judging size on a screen is genuinely hard, and this is a tool whose entire
// job is dimensions — so the viewport states its own scale the way a map or a
// drawing does, rather than leaving it to be inferred from a plate grid.
//
// It is a chequered bar: alternating filled and hollow cells, ticks and a
// figure, snapping to 1 / 2 / 5 / 10 / 20 / 50 / 100 mm as the zoom changes so
// the number under it is always one a person can hold in their head. Redrawn on
// the viewer's 'camera' event and on resize, and at no other time.

import { svg, clear } from './dom.js';

const STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const MIN_PX = 74;
const MAX_PX = 210;
const CELLS = 4;

export class ScaleBar {
  /**
   * @param {SVGSVGElement} root
   * @param {object} viewer
   * @param {function():number} pxPerMm  measured at the object, not assumed
   */
  constructor(root, viewer, pxPerMm) {
    this.root = root;
    this.viewer = viewer;
    this.pxPerMm = pxPerMm;
    this.last = null;
    this._raf = 0;
    this._on = () => this.schedule();
    viewer.on('camera', this._on);
    viewer.on('render', this._on);
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._on);
      this._ro.observe(root);
    }
    this.schedule();
  }

  schedule() {
    if (this._raf || this._disposed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.viewer.off('camera', this._on);
    this.viewer.off('render', this._on);
    if (this._ro) this._ro.disconnect();
  }

  /** The step chosen for the current zoom, in mm. Exposed for the test. */
  step() {
    const ppm = this.pxPerMm();
    if (!(ppm > 0)) return null;
    for (const s of STEPS) {
      const px = s * ppm;
      if (px >= MIN_PX && px <= MAX_PX) return s;
    }
    // Nothing landed in the window: take the largest that still fits, or the
    // smallest that is at least visible. A bar is better than no bar.
    let pick = STEPS[0];
    for (const s of STEPS) if (s * ppm <= MAX_PX) pick = s;
    return pick;
  }

  render() {
    const root = this.root;
    const ppm = this.pxPerMm();
    const step = this.step();
    if (!step || !(ppm > 0)) { clear(root); return; }

    const total = step * ppm;
    const sig = `${step}|${Math.round(total)}`;
    if (sig === this.last && root.childNodes.length) return;    // nothing moved
    this.last = sig;

    const h = root.clientHeight || 34;
    const y = h - 16;
    const cellW = total / CELLS;
    const g = document.createDocumentFragment();

    // The chequer. Filled and hollow cells alternate so the eye can count them
    // without a tick under every one.
    for (let i = 0; i < CELLS; i++) {
      const x = 1 + i * cellW;
      g.appendChild(svg(i % 2 === 0 ? 'rect.sb-fill' : 'rect.sb-hollow', {
        x: r2(x), y: r2(y), width: r2(cellW), height: 6,
      }));
    }
    // Baseline and the end ticks.
    g.appendChild(svg('line.sb-rule', { x1: 1, y1: r2(y + 6.5), x2: r2(1 + total), y2: r2(y + 6.5) }));
    for (const t of [0, 0.5, 1]) {
      const x = 1 + total * t;
      g.appendChild(svg('line.sb-rule', { x1: r2(x), y1: r2(y - 4), x2: r2(x), y2: r2(y + 6) }));
    }

    g.appendChild(svg('text.sb-text', { x: 1, y: r2(y - 7), text: '0' }));
    g.appendChild(svg('text.sb-text', {
      x: r2(1 + total), y: r2(y - 7), 'text-anchor': 'end', text: `${trim(step)} mm`,
    }));
    // Half-step figure, only when there is room for it to be legible.
    if (total > 130) {
      g.appendChild(svg('text.sb-text', {
        x: r2(1 + total / 2), y: r2(y - 7), 'text-anchor': 'middle', text: trim(step / 2),
      }));
    }

    root.setAttribute('data-step', String(step));
    clear(root);
    root.appendChild(g);
  }
}

function trim(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function r2(v) { return Math.round(v * 100) / 100; }
