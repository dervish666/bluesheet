// The catalogue — the front door.
//
// Every registered generator as a card: name, category, one-line blurb, and a
// picture of what it actually makes. The picture is the point. A grid of names
// is a menu; a grid of objects is a workshop, and the difference is whether you
// can tell a drawer divider from a drawer front without reading.
//
// Previews are real: each card's default parameters are built in a worker and
// rendered by a second, offscreen WebGL viewer, then cached in localStorage
// against the generator's version so the second visit is instant. A placeholder
// would have been a quarter of the work and none of the value.
//
// Filtering is by category chip and by typed text at the same time, and the grid
// is arrow-key navigable with a roving tabindex, because a catalogue you cannot
// reach from the keyboard is a catalogue with a mouse-shaped lock on it.

import { el, clear, $, $$, trapFocus, debounce } from './dom.js';
import { defaultParams, CATEGORY_ORDER } from '../gen/index.js';
import { Builder } from './build.js';
import { Viewer } from '../render/viewer.js';

const THUMB_PX = 128;
const CACHE_PREFIX = 'bluesheet.thumb.';
const PREVIEW_THEME = {
  // The card previews are drawings, not photographs: cold ground, pale object,
  // and the edges left on so the form reads at 60 px.
  bgTop: '#0A121B', bgBottom: '#0A121B',
  object: '#7FA6C7', wire: '#E9F2FA', ghost: '#33475C',
  key: '#E9F2FA', fill: '#33475C', rim: '#7FA6C7',
  sky: '#33475C', ground: '#14202E',
};

export class Catalogue {
  /**
   * @param {HTMLElement} overlay  [data-catalogue]
   * @param {object} h  {onPick(id), onClose()}
   */
  constructor(overlay, h = {}) {
    this.root = overlay;
    this.h = h;
    this.generators = [];
    this.failures = [];
    this.category = 'all';
    this.query = '';
    this.activeId = null;
    this.cards = [];
    this.thumbs = new Map();
    this._queue = [];
    this._working = false;
    this._builder = null;
    this._preview = null;
    this._untrap = null;

    this.cardsEl = $('[data-cat-cards]', overlay);
    this.chipsEl = $('[data-cat-cats]', overlay);
    this.searchEl = $('[data-cat-search]', overlay);
    this.emptyEl = $('[data-cat-empty]', overlay);
    this.failEl = $('[data-cat-failures]', overlay);
    this.failListEl = $('[data-cat-failure-list]', overlay);

    const onSearch = debounce(() => { this.query = this.searchEl.value.trim().toLowerCase(); this.renderCards(); }, 90);
    this.searchEl.addEventListener('input', onSearch);
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && this.cards.length) { e.preventDefault(); this._focusCard(0); }
      if (e.key === 'Enter' && this.cards.length) { e.preventDefault(); this._pick(this.cards[0].id); }
    });
    this.cardsEl.addEventListener('keydown', (e) => this._onGridKey(e));

    for (const b of $$('[data-close-catalogue]', overlay)) b.addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
  }

  setGenerators(generators, failures = []) {
    this.generators = generators;
    this.failures = failures;
    this.renderChips();
    this.renderCards();
    this.renderFailures();
    return this;
  }

  setActive(id) {
    this.activeId = id;
    for (const c of $$('.card', this.cardsEl)) {
      c.classList.toggle('is-active', c.dataset.gen === id);
      c.setAttribute('aria-selected', c.dataset.gen === id ? 'true' : 'false');
    }
    return this;
  }

  get isOpen() { return !this.root.hidden; }

  open() {
    if (this.isOpen) return this;
    this.root.hidden = false;
    this._untrap = trapFocus(this.root, () => this.close());
    this._lastFocus = document.activeElement;
    this.searchEl.focus();
    this.searchEl.select();
    this._later();
    return this;
  }

  close() {
    if (!this.isOpen) return this;
    this.root.hidden = true;
    if (this._untrap) { this._untrap(); this._untrap = null; }
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
    this.h.onClose && this.h.onClose();
    return this;
  }

  // ---- rendering ---------------------------------------------------------

  categories() {
    const present = new Set(this.generators.map(g => g.category));
    const ordered = CATEGORY_ORDER.filter(c => present.has(c));
    for (const c of present) if (!ordered.includes(c)) ordered.push(c);
    return ordered;
  }

  renderChips() {
    const frag = document.createDocumentFragment();
    const mk = (value, label) => {
      const b = el('button.chip', {
        type: 'button', 'aria-pressed': this.category === value ? 'true' : 'false',
        dataset: { cat: value }, text: label,
      });
      b.addEventListener('click', () => {
        this.category = value;
        for (const c of $$('.chip', this.chipsEl)) c.setAttribute('aria-pressed', c.dataset.cat === value ? 'true' : 'false');
        this.renderCards();
      });
      return b;
    };
    frag.appendChild(mk('all', `All ${this.generators.length}`));
    for (const c of this.categories()) frag.appendChild(mk(c, c));
    clear(this.chipsEl).appendChild(frag);
  }

  matches() {
    const q = this.query;
    return this.generators.filter(g => {
      if (this.category !== 'all' && g.category !== this.category) return false;
      if (!q) return true;
      return `${g.name} ${g.id} ${g.category} ${g.blurb || ''} ${g.description || ''}`.toLowerCase().includes(q);
    });
  }

  renderCards() {
    const list = this.matches();
    this.cards = list;
    const frag = document.createDocumentFragment();
    list.forEach((g, i) => frag.appendChild(this._card(g, i)));
    clear(this.cardsEl).appendChild(frag);
    this.emptyEl.hidden = list.length > 0;
    this.setActive(this.activeId);
    this._queue = list.map(g => g.id).filter(id => !this.thumbs.has(id));
    if (this.isOpen) this._later();
  }

  _card(gen, index) {
    const canvas = el('canvas.card-thumb.is-pending', {
      width: THUMB_PX, height: THUMB_PX, dataset: { thumb: gen.id }, 'aria-hidden': 'true',
    });
    const card = el('button.card', {
      type: 'button', role: 'option', tabindex: index === 0 ? '0' : '-1',
      dataset: { gen: gen.id }, 'aria-selected': 'false',
      'aria-label': `${gen.name}, ${gen.category}. ${gen.blurb || ''}`,
    }, [
      el('div.card-top', null, [
        canvas,
        el('div', null, [
          el('div.card-name', { text: gen.name }),
          el('div.card-cat', { text: gen.category }),
        ]),
      ]),
      el('p.card-blurb', { text: gen.blurb || gen.description || '' }),
    ]);
    card.addEventListener('click', () => this._pick(gen.id));
    const cached = this.thumbs.get(gen.id) || readCache(gen);
    if (cached) { this.thumbs.set(gen.id, cached); paint(canvas, cached); }
    return card;
  }

  renderFailures() {
    const list = this.failures || [];
    this.failEl.hidden = list.length === 0;
    clear(this.failListEl);
    for (const f of list) {
      this.failListEl.appendChild(el('li', { text: `${f.id} — ${f.reason}` }));
    }
  }

  _pick(id) {
    this.setActive(id);
    this.close();
    this.h.onPick && this.h.onPick(id);
  }

  // ---- keyboard ----------------------------------------------------------

  _focusCard(i) {
    const nodes = $$('.card', this.cardsEl);
    if (!nodes.length) return;
    const n = Math.max(0, Math.min(nodes.length - 1, i));
    for (const c of nodes) c.tabIndex = -1;
    nodes[n].tabIndex = 0;
    nodes[n].focus();
  }

  _columns() {
    const nodes = $$('.card', this.cardsEl);
    if (nodes.length < 2) return 1;
    const top = nodes[0].offsetTop;
    let cols = 0;
    for (const n of nodes) { if (n.offsetTop === top) cols++; else break; }
    return Math.max(1, cols);
  }

  _onGridKey(e) {
    const nodes = $$('.card', this.cardsEl);
    const i = nodes.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = this._columns();
    const go = (n) => { e.preventDefault(); this._focusCard(n); };
    switch (e.key) {
      case 'ArrowRight': return go(i + 1);
      case 'ArrowLeft': return go(i - 1);
      case 'ArrowDown': return go(i + cols);
      case 'ArrowUp': return i < cols ? (e.preventDefault(), this.searchEl.focus()) : go(i - cols);
      case 'Home': return go(0);
      case 'End': return go(nodes.length - 1);
      default: return undefined;
    }
  }

  // ---- previews ----------------------------------------------------------

  /** Start the preview queue on the next task, never inside the event handler
   *  that opened the dialog. `_stage()` creates a second WebGL context, and
   *  asking for one synchronously while the browser is still dispatching a
   *  mouse event blocks the renderer until the GPU process answers — which,
   *  under a software GL stack, is long enough to look like a hang. The dialog
   *  also gets to paint before any of this starts, which is the point. */
  _later() {
    if (this._pending) return;
    this._pending = setTimeout(() => { this._pending = 0; this._pump(); }, 0);
  }

  /** Build and render one card at a time. Sequential on purpose: twelve
   *  generators kicked off at once would fight for the same worker and make the
   *  first card the slowest one. */
  async _pump() {
    if (this._working || !this._queue.length || !this.isOpen) return;
    this._working = true;
    try {
      while (this._queue.length && this.isOpen) {
        if (typeof document !== 'undefined' && document.hidden) break;   // cupboard rule
        const id = this._queue.shift();
        if (this.thumbs.has(id)) { this._apply(id); continue; }
        const gen = this.generators.find(g => g.id === id);
        if (!gen) continue;
        try {
          const url = await this._renderThumb(gen);
          if (url) { this.thumbs.set(id, url); writeCache(gen, url); this._apply(id); }
        } catch (e) {
          // One generator that will not build must not stop the other eleven
          // getting their pictures.
          console.warn(`bluesheet: no catalogue preview for ${id} —`, e.message || e);
          this.thumbs.set(id, null);
        }
      }
    } finally {
      this._working = false;
    }
  }

  _apply(id) {
    const url = this.thumbs.get(id);
    const canvas = $(`[data-thumb="${cssEscape(id)}"]`, this.cardsEl);
    if (canvas && url) paint(canvas, url);
  }

  async _renderThumb(gen) {
    const { builder, viewer } = this._stage();
    const res = await builder.build({
      genId: gen.id, params: defaultParams(gen), quality: 'draft',
    }, { immediate: true });
    viewer.setMesh(res.render);
    viewer.setPreset('iso');
    viewer.fit({ margin: 1.06 });
    return viewer.thumbnail({ size: THUMB_PX, type: 'image/webp', quality: 0.86 });
  }

  _stage() {
    if (!this._preview) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = THUMB_PX * 2;
      canvas.className = 'thumb-stage';
      // Off-screen rather than display:none: a canvas with no layout box has no
      // size for the viewer to read, and WebGL would draw a 1x1 pixel.
      canvas.style.cssText = `position:fixed;left:-4000px;top:0;width:${THUMB_PX * 2}px;height:${THUMB_PX * 2}px;pointer-events:none`;
      document.body.appendChild(canvas);
      this._preview = new Viewer(canvas, {
        plate: false, legend: false, stats: false, shadows: false,
        grid: 0, antialias: true, maxDpr: 1, keys: false, theme: PREVIEW_THEME,
      });
      this._preview.setEdges(true);
    }
    if (!this._builder) this._builder = new Builder({});
    return { builder: this._builder, viewer: this._preview };
  }

  dispose() {
    if (this._pending) { clearTimeout(this._pending); this._pending = 0; }
    if (this._preview) { this._preview.dispose(); this._preview.canvas.remove(); this._preview = null; }
    if (this._builder) { this._builder.dispose(); this._builder = null; }
  }
}

// ---- thumbnail cache -----------------------------------------------------

function cacheKey(gen) { return `${CACHE_PREFIX}${gen.id}.v${gen.version ?? 1}`; }

function readCache(gen) {
  try { return localStorage.getItem(cacheKey(gen)) || null; } catch { return null; }
}

function writeCache(gen, url) {
  try {
    localStorage.setItem(cacheKey(gen), url);
  } catch {
    // Quota, or private browsing. Drop every previous preview and try once more:
    // a stale cache is not worth an exception on every card.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(cacheKey(gen), url);
    } catch { /* nothing more to do; previews simply re-render next time */ }
  }
}

function paint(canvas, url) {
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.classList.remove('is-pending');
    canvas.dataset.painted = '1';
  };
  img.src = url;
}

function cssEscape(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
