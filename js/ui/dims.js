// Dimension callouts, drawn onto the model in ISO 128 style.
//
// This is an SVG overlay sitting on top of the WebGL canvas, not GL geometry.
// Text stays crisp at any zoom, arrowheads are real filled triangles, dashes and
// colours come from the stylesheet, and when nothing moves nothing is drawn.
// It re-projects on the viewer's 'camera' event and on resize, and at no other
// time.
//
// The details that separate an engineering drawing from some lines with a number
// on them, all of them from ISO 128-20 / ISO 129-1:
//
//   * extension lines start clear of the surface (they must not touch the
//     outline) and overrun the dimension line by about the same amount;
//   * the dimension line ends in solid filled arrowheads with a 15° included
//     angle — slender, not the fat 30° triangle a chart library draws;
//   * the value sits in a break in the middle of the dimension line and stays
//     horizontal however the line is angled (ISO 129-1 calls this the
//     unidirectional arrangement, and it is the one that survives a 3D view);
//   * when the dimension is too short for the arrows to fit between the
//     extension lines, the arrows go outside pointing in and the value steps
//     out with them.
//
// A parameter that is not a length — a count, a tooth number, an angle — gets a
// leader with a horizontal reference line instead, which is what a drawing does
// with a note. Inventing an edge to measure would be a lie about the object.

import { svg, clear, SVG_NS } from './dom.js';

/** ISO 129-1 arrowhead: 15° included angle, about 3 mm long on a printed sheet.
 *  96 CSS px to the inch makes 3 mm ≈ 11 px, and the half-width follows from
 *  the angle rather than from taste. */
const ARROW_LEN = 11;
const ARROW_HALF = ARROW_LEN * Math.tan(7.5 * Math.PI / 180);

const SURFACE_GAP = 2;        // extension line stands off the outline
const EXT_OVERRUN = 2;        // and overruns the dimension line
const DEFAULT_OFFSET = 30;    // dimension line clear of the outline
const VALUE_SIZE = 12;        // matches .dim-value in the stylesheet
const LABEL_SIZE = 9.5;
const MONO_ADVANCE = 0.6;     // IBM Plex Mono is a 600/1000 em monospace
const CAPS_ADVANCE = 0.52;    // Archivo Narrow, uppercase, +0.10em tracked

export class DimensionLayer {
  /**
   * @param {SVGSVGElement} root  the overlay, absolutely on top of the canvas
   * @param {object} viewer       the live Viewer (for camera and canvas size)
   */
  constructor(root, viewer) {
    this.root = root;
    this.viewer = viewer;
    this.box = null;            // current mesh bbox, world mm
    this.dims = [];             // meta.dims from the generator
    this.focus = null;          // {param, label, value, unit, type}
    this.enabled = true;
    this.animateNext = false;
    this._raf = 0;
    this._onCamera = () => this.schedule();
    this._onResize = () => this.schedule();
    viewer.on('camera', this._onCamera);
    viewer.on('render', this._onCamera);
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(root);
    } else if (typeof addEventListener === 'function') {
      addEventListener('resize', this._onResize);
    }
  }

  setBox(box) { this.box = box; this.schedule(); return this; }

  setDims(list) {
    this.dims = Array.isArray(list) ? list.filter(d => d && Array.isArray(d.from) && Array.isArray(d.to)) : [];
    this.schedule();
    return this;
  }

  /** null clears the focus and the three bounding-box dimensions come back. */
  setFocus(spec) {
    const same = (this.focus && spec && this.focus.param === spec.param && this.focus.value === spec.value);
    this.focus = spec || null;
    if (!same) this.animateNext = true;
    this.schedule();
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) clear(this.root);
    else this.schedule();
    return this;
  }

  schedule() {
    if (this._raf || this._disposed) return;
    if (typeof document !== 'undefined' && document.hidden) return;   // cupboard rule
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.viewer.off('camera', this._onCamera);
    this.viewer.off('render', this._onCamera);
    if (this._ro) this._ro.disconnect();
    else if (typeof removeEventListener === 'function') removeEventListener('resize', this._onResize);
  }

  // ---- projection --------------------------------------------------------

  _frame() {
    const el = this.root;
    const w = el.clientWidth || el.parentNode?.clientWidth || 0;
    const h = el.clientHeight || el.parentNode?.clientHeight || 0;
    if (w < 2 || h < 2) return null;
    const cam = this.viewer.camera;
    const P = (p) => cam.project(p, w, h);
    // Millimetres to pixels at the object, measured rather than assumed: it is
    // the scale bar's figure and the arrowhead sizing both come from.
    const centre = this.box ? this.box.center : [0, 0, 0];
    const b = cam.basis();
    const a0 = P(centre);
    const a1 = P([centre[0] + b.right[0], centre[1] + b.right[1], centre[2] + b.right[2]]);
    const pxPerMm = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
    return { w, h, P, pxPerMm, centre: a0 };
  }

  /** px per mm at the object's centre — the scale bar and the title block's
   *  scale figure both read this. */
  pxPerMm() {
    const f = this._frame();
    return f ? f.pxPerMm : 0;
  }

  // ---- render ------------------------------------------------------------

  render() {
    const root = this.root;
    if (!this.enabled) return;
    const f = this._frame();
    if (!f || !this.box) { clear(root); return; }

    const animate = this.animateNext;
    this.animateNext = false;
    const frag = document.createDocumentFragment();

    const spec = this.focus;
    const drawn = spec ? this._focusGroup(f, spec, animate) : null;
    if (drawn) {
      frag.appendChild(drawn);
    } else {
      for (const g of this._boxGroups(f)) frag.appendChild(g);
    }
    clear(root);
    root.appendChild(frag);
  }

  /** The three bounding-box dimensions, faint, on the edges facing the viewer. */
  _boxGroups(f) {
    const b = this.box;
    if (!b) return [];
    const out = [];
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const size = b.size;

    // Along X: the four candidate edges, pick the one lowest on screen — that is
    // the near-bottom edge, which is where a drawing puts the width.
    const xEdges = [
      [[x0, y0, z0], [x1, y0, z0]], [[x0, y1, z0], [x1, y1, z0]],
      [[x0, y0, z1], [x1, y0, z1]], [[x0, y1, z1], [x1, y1, z1]],
    ];
    const yEdges = [
      [[x0, y0, z0], [x0, y1, z0]], [[x1, y0, z0], [x1, y1, z0]],
      [[x0, y0, z1], [x0, y1, z1]], [[x1, y0, z1], [x1, y1, z1]],
    ];
    const zEdges = [
      [[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]],
      [[x0, y1, z0], [x0, y1, z1]], [[x1, y1, z0], [x1, y1, z1]],
    ];

    const pickLowest = (edges) => best(edges, e => (f.P(e[0]).y + f.P(e[1]).y) / 2);
    const pickWidest = (edges) => best(edges, e => Math.abs((f.P(e[0]).x + f.P(e[1]).x) / 2 - f.centre.x));

    const jobs = [
      { edge: pickLowest(xEdges), value: size[0] },
      { edge: pickLowest(yEdges), value: size[1] },
      { edge: pickWidest(zEdges), value: size[2] },
    ];
    // Two of the three share a corner in most views; splaying them by a step
    // keeps the arrowheads from landing on top of one another.
    let step = 0;
    for (const j of jobs) {
      if (!j.edge || j.value <= 1e-6) continue;
      const g = this._linear(f, {
        a: j.edge[0], b: j.edge[1], value: j.value, faint: true,
        offset: DEFAULT_OFFSET + step * 4,
      });
      if (g) { out.push(g); step++; }
    }
    return out;
  }

  /** The focused parameter's dimension: the generator's own if it declared one,
   *  the matching bounding-box axis if the number plainly is one, otherwise a
   *  leader note. */
  _focusGroup(f, spec, animate) {
    const declared = this.dims.find(d => d.param === spec.param);
    if (declared) {
      const g = this._linear(f, {
        a: declared.from, b: declared.to,
        value: Number.isFinite(declared.value) ? declared.value : dist3(declared.from, declared.to),
        label: declared.label || spec.label,
        param: spec.param,
        unit: declared.unit ?? spec.unit ?? 'mm',
        offset: offsetPx(declared.offset, f.pxPerMm),
        away: Array.isArray(declared.offset) ? declared.offset : null,
        animate,
      });
      if (g) return g;
      // Declared, but too short on screen to carry arrows (a chamfer, a key
      // depth, a clearance at fit zoom). A note is the right form for it — but
      // anchored on the feature it names, not on the bounding box's corner, or
      // the leader points into empty air beside the object.
      const pa = f.P(declared.from), pb = f.P(declared.to);
      if (!pa.behind && !pb.behind && [pa.x, pa.y, pb.x, pb.y].every(Number.isFinite)) {
        return this._leader(f, { ...spec, value: Number.isFinite(declared.value) ? declared.value : spec.value },
          animate, { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
      }
    }

    // No declared dimension: does this number simply *are* one of the object's
    // three sizes? If so, dimension that axis and name the parameter on it.
    if (spec.type !== 'bool' && Number.isFinite(spec.value) && this.box) {
      const axis = matchingAxis(this.box.size, spec.value);
      if (axis >= 0) {
        const edge = this._axisEdge(f, axis);
        if (edge) {
          const g = this._linear(f, {
            a: edge[0], b: edge[1], value: this.box.size[axis],
            label: spec.label, param: spec.param, unit: 'mm',
            offset: DEFAULT_OFFSET, animate,
          });
          if (g) return g;
        }
      }
    }

    // A count, an angle, a wall thickness buried inside the solid: a leader with
    // a reference line is what a drawing uses for a note, so that is what this is.
    return this._leader(f, spec, animate);
  }

  _axisEdge(f, axis) {
    const b = this.box;
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const corners = axis === 0
      ? [[[x0, y0, z0], [x1, y0, z0]], [[x0, y1, z0], [x1, y1, z0]], [[x0, y0, z1], [x1, y0, z1]], [[x0, y1, z1], [x1, y1, z1]]]
      : axis === 1
        ? [[[x0, y0, z0], [x0, y1, z0]], [[x1, y0, z0], [x1, y1, z0]], [[x0, y0, z1], [x0, y1, z1]], [[x1, y0, z1], [x1, y1, z1]]]
        : [[[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]], [[x0, y1, z0], [x0, y1, z1]], [[x1, y1, z0], [x1, y1, z1]]];
    return axis === 2
      ? best(corners, e => Math.abs((f.P(e[0]).x + f.P(e[1]).x) / 2 - f.centre.x))
      : best(corners, e => (f.P(e[0]).y + f.P(e[1]).y) / 2);
  }

  // ---- the drawing itself ------------------------------------------------

  /**
   * One linear dimension between two world points.
   * Returns null when the view has collapsed it to nothing — an edge seen
   * exactly end-on has no dimension to draw and a zero-length arrow is a NaN.
   */
  _linear(f, o) {
    const pa = f.P(o.a), pb = f.P(o.b);
    if (pa.behind || pb.behind) return null;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 6)) return null;                       // end-on: nothing to draw
    if (![pa.x, pa.y, pb.x, pb.y].every(Number.isFinite)) return null;

    const ux = dx / len, uy = dy / len;
    let nx = -uy, ny = ux;                             // screen normal
    // Push the dimension line away from the object, not through it.
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    let awayX = mid.x - f.centre.x, awayY = mid.y - f.centre.y;
    if (Array.isArray(o.away) && o.away.length === 3) {
      const q = f.P([o.a[0] + o.away[0], o.a[1] + o.away[1], o.a[2] + o.away[2]]);
      awayX = q.x - pa.x; awayY = q.y - pa.y;
    }
    if (Math.hypot(awayX, awayY) < 1e-6) { awayX = 0; awayY = 1; }
    if (nx * awayX + ny * awayY < 0) { nx = -nx; ny = -ny; }

    const off = Math.max(12, o.offset ?? DEFAULT_OFFSET);
    const A = { x: pa.x + nx * off, y: pa.y + ny * off };
    const B = { x: pb.x + nx * off, y: pb.y + ny * off };

    const faint = !!o.faint;
    const valueText = formatValue(o.value, o.unit ?? 'mm');
    const labelText = o.label ? String(o.label).toUpperCase() : '';
    const vSize = faint ? 11 : VALUE_SIZE;
    const vW = valueText.length * vSize * MONO_ADVANCE;
    const lW = labelText.length * LABEL_SIZE * CAPS_ADVANCE;
    const textW = Math.max(vW, lW);
    const textH = labelText ? vSize * 1.15 + LABEL_SIZE * 1.5 : vSize * 1.15;
    // The break has to clear a horizontal box on an arbitrarily angled line:
    // that is the box's support width along the line direction.
    const gap = Math.abs(ux) * textW + Math.abs(uy) * textH + 8;

    const g = svg('g.dim', {
      'data-dim': o.param || 'bbox',
      ...(o.param ? { 'data-param': o.param } : {}),
      class: `dim${faint ? ' dim--faint' : ''}${o.animate ? ' dim--in' : ''}`,
    });

    // Extension lines: clear of the surface, overrunning the dimension line.
    for (const [p, q] of [[pa, A], [pb, B]]) {
      const sx = p.x + nx * SURFACE_GAP, sy = p.y + ny * SURFACE_GAP;
      const ex = q.x + nx * EXT_OVERRUN, ey = q.y + ny * EXT_OVERRUN;
      const l = Math.hypot(ex - sx, ey - sy);
      g.appendChild(svg('line.dim-ext', {
        x1: r2(sx), y1: r2(sy), x2: r2(ex), y2: r2(ey),
        'stroke-dasharray': r2(l), style: `--dash:${r2(l)}`,
      }));
    }

    const inside = len >= 2 * ARROW_LEN + gap + 6;
    if (inside) {
      // The dimension line, broken for the value.
      const g2 = (len - gap) / 2;
      g.appendChild(seg(A, { x: A.x + ux * g2, y: A.y + uy * g2 }));
      g.appendChild(seg({ x: B.x - ux * g2, y: B.y - uy * g2 }, B));
      g.appendChild(arrow(A, ux, uy, nx, ny));
      g.appendChild(arrow(B, -ux, -uy, nx, ny));
      addText(g, midOf(A, B), valueText, labelText, vSize, 'middle');
    } else {
      // Too short: arrows outside pointing in, and the value steps out with
      // them rather than sitting on top of its own arrowheads.
      const stub = ARROW_LEN * 1.7;
      g.appendChild(seg({ x: A.x - ux * stub, y: A.y - uy * stub }, { x: B.x + ux * stub, y: B.y + uy * stub }));
      g.appendChild(arrow(A, -ux, -uy, nx, ny));
      g.appendChild(arrow(B, ux, uy, nx, ny));
      const side = (B.x >= A.x) ? 1 : -1;
      const anchorPt = side > 0 ? B : A;
      const su = side > 0 ? 1 : -1;
      addText(g, {
        x: anchorPt.x + ux * stub * su + su * 6,
        y: anchorPt.y + uy * stub * su,
      }, valueText, labelText, vSize, side > 0 ? 'start' : 'end');
    }
    return g;
  }

  /** A leader with a horizontal reference line: the drawing's way of writing a
   *  note about something that is not a length between two points. */
  _leader(f, spec, animate, at = null) {
    let anchor = at;
    if (!anchor) {
      const b = this.box;
      if (!b) return null;
      // Anchor on the object's silhouette: the top corner furthest to the right,
      // which is nearly always clear of both the title block and the scale bar.
      const corners = boxCorners(b).map(c => ({ c, p: f.P(c) })).filter(q => !q.p.behind);
      if (!corners.length) return null;
      const top = best(corners, q => -q.p.y + q.p.x * 0.35);
      if (!top) return null;
      anchor = top.p;
    }

    const dirX = anchor.x < f.centre.x ? -1 : 1;
    const run = 34;
    const elbow = { x: anchor.x + dirX * run, y: anchor.y - run * 0.58 };  // ~30°
    const valueText = formatValue(spec.value, spec.unit ?? '');
    const labelText = String(spec.label || spec.param).toUpperCase();
    const shelfW = Math.max(valueText.length * VALUE_SIZE * MONO_ADVANCE,
      labelText.length * LABEL_SIZE * CAPS_ADVANCE) + 8;
    const end = { x: elbow.x + dirX * shelfW, y: elbow.y };

    const g = svg('g.dim.dim--leader', {
      'data-dim': spec.param, 'data-param': spec.param,
      class: `dim dim--leader${animate ? ' dim--in' : ''}`,
    });
    g.appendChild(svg('circle.dim-arrow', { cx: r2(anchor.x), cy: r2(anchor.y), r: 2.2 }));
    g.appendChild(svg('polyline.dim-line', {
      points: `${r2(anchor.x)},${r2(anchor.y)} ${r2(elbow.x)},${r2(elbow.y)} ${r2(end.x)},${r2(end.y)}`,
    }));
    const tx = (elbow.x + end.x) / 2;
    addText(g, { x: tx, y: elbow.y - VALUE_SIZE * 0.85 }, valueText, labelText, VALUE_SIZE, 'middle');
    return g;
  }
}

// ---- small geometry helpers ---------------------------------------------

function seg(a, b) {
  return svg('line.dim-line', { x1: r2(a.x), y1: r2(a.y), x2: r2(b.x), y2: r2(b.y) });
}

/** A filled 15°-included-angle head with its point at `p`, opening along
 *  (ux,uy). `n` is the dimension line's normal, which is what gives the head
 *  its width without a second trig call. */
function arrow(p, ux, uy, nx, ny) {
  const bx = p.x + ux * ARROW_LEN, by = p.y + uy * ARROW_LEN;
  const pts = [
    [p.x, p.y],
    [bx + nx * ARROW_HALF, by + ny * ARROW_HALF],
    [bx - nx * ARROW_HALF, by - ny * ARROW_HALF],
  ];
  return svg('polygon.dim-arrow', { points: pts.map(q => `${r2(q[0])},${r2(q[1])}`).join(' ') });
}

function addText(g, at, valueText, labelText, size, anchor) {
  if (labelText) {
    g.appendChild(svg('text.dim-label', {
      x: r2(at.x), y: r2(at.y - size * 0.92), 'text-anchor': anchor, text: labelText,
    }));
  }
  const t = svg('text.dim-value', {
    x: r2(at.x), y: r2(at.y), 'text-anchor': anchor, text: valueText,
  });
  if (size !== VALUE_SIZE) t.setAttribute('font-size', String(size));
  g.appendChild(t);
}

function midOf(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function r2(v) { return Math.round(v * 100) / 100; }

function dist3(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }

function boxCorners(b) {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  return [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
}

function best(items, score) {
  let bestItem = null, bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (Number.isFinite(s) && s > bestScore) { bestScore = s; bestItem = it; }
  }
  return bestItem;
}

/** A declared offset may be a distance in millimetres or a world direction. */
function offsetPx(offset, pxPerMm) {
  if (Array.isArray(offset)) return Math.max(14, Math.hypot(...offset) * pxPerMm);
  if (Number.isFinite(offset) && offset > 0) return Math.max(14, offset * pxPerMm);
  return DEFAULT_OFFSET;
}

/** Is this number simply one of the object's three sizes? The tolerance is a
 *  hair over a nozzle width: closer than that and calling it that axis is true
 *  enough to draw, further and it is a different quantity. */
function matchingAxis(size, value) {
  let bestI = -1, bestD = 0.45;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(size[i] - value);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}

function formatValue(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 100 ? 1 : (Math.abs(a * 10 - Math.round(a * 10)) < 5e-4 ? 1 : 2);
  const n = Number.isInteger(v) && !unit ? String(v) : v.toFixed(dp);
  return unit ? `${n} ${unit}` : n;
}

export { ARROW_LEN, ARROW_HALF, SVG_NS };
