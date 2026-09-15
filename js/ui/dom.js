// The four DOM helpers the rest of the interface needs, and nothing else.
// A framework would be a build step, and a build step is the one thing this
// project has ruled out.

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** el('div.card', {role:'listitem'}, [child, 'text']) */
export function el(spec, attrs = null, children = null) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  apply(node, attrs);
  add(node, children);
  return node;
}

/** The same, in the SVG namespace, where className is read-only. */
export function svg(spec, attrs = null, children = null) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElementNS(SVG_NS, tag || 'g');
  if (classes.length) node.setAttribute('class', classes.join(' '));
  apply(node, attrs, true);
  add(node, children);
  return node;
}

function apply(node, attrs, isSvg = false) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') { node.textContent = String(v); continue; }
    if (k === 'html') { node.innerHTML = v; continue; }
    if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); continue; }
    if (k === 'dataset') { Object.assign(node.dataset, v); continue; }
    if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2), v); continue; }
    if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden')) { node[k] = v; continue; }
    node.setAttribute(k, v === true ? '' : String(v));
  }
}

function add(node, children) {
  if (children === null || children === undefined) return;
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Coalesce repeated calls into one, on a timer. Exposes .now() and .cancel(). */
export function debounce(fn, ms) {
  let t = 0, lastArgs = null;
  const run = () => { t = 0; const a = lastArgs; lastArgs = null; fn(...(a || [])); };
  const d = (...args) => { lastArgs = args; if (t) clearTimeout(t); t = setTimeout(run, ms); };
  d.cancel = () => { if (t) clearTimeout(t); t = 0; lastArgs = null; };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.pending = () => t !== 0;
  return d;
}

/** True when the viewer should hold still: reduced motion is a preference, not
 *  a hint, and the dimension draw-in and the g-code build both honour it. */
export function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Focus trap + Escape for the modal sheets. Returns a teardown function. */
export function trapFocus(container, onEscape) {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onEscape && onEscape(); return; }
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(selector)].filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}
