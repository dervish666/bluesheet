/**
 * plate.js — the build plate: 10 mm grid, the A1 mini's 180 x 180 outline,
 * axis marks and an origin marker.
 *
 * Two decisions worth knowing about:
 *
 * 1. Everything is drawn BELOW z = 0 (see PLATE_Z), each element on its own
 *    shelf a few hundredths of a millimetre down. A generator's mesh rests with
 *    bbox.min.z exactly 0, so a plate drawn at z = 0 would be coplanar with the
 *    object's bottom face and z-fight it into a shimmering mess on every orbit.
 *    The whole ladder fits inside one 0.2 mm layer, which is invisible at any
 *    zoom, and it removes the problem by construction rather than by fiddling
 *    with polygonOffset. The shelves are 0.01-0.04 mm apart — roughly two
 *    hundred times the depth-buffer resolution at this scene scale.
 *
 * 2. The bed outline and the origin marker are thin ribbons of triangles, not
 *    GL_LINES. WebGL clamps lineWidth to 1 on every desktop driver worth
 *    naming, and a one-pixel bed outline disappears on a retina iPad.
 *
 * buildPlateGeometry() is pure; PlateRenderer is the GL half.
 */

import { GLBuffer, setAttrib } from './glutil.js';
import { parseColor } from './geometry.js';

export const PLATE_Z = {
  fill: -0.18,
  grid: -0.14,
  major: -0.12,
  outline: -0.09,
  tick: -0.08,
  axis: -0.05,
  origin: -0.03,
  shadow: -0.01,
};

export const DEFAULT_PLATE_THEME = {
  fill: '#1b2027', fillAlpha: 0.82,
  grid: '#3a4552', gridAlpha: 0.55,
  major: '#55647a', majorAlpha: 0.8,
  outline: '#8ea4bd', outlineAlpha: 0.95,
  axisX: '#e05c5c', axisY: '#5ce07a',
  origin: '#e8eef6',
  edgeFade: 0.35,          // alpha of the grid at the bed edge
};

/**
 * @param {object} o
 * @param {number} o.size    bed size in mm (square; 180 for the A1 mini)
 * @param {number} o.grid    minor grid pitch, mm
 * @param {number} o.major   major grid pitch, mm
 * @returns {{tri:{positions:Float32Array,colors:Float32Array},
 *            line:{positions:Float32Array,colors:Float32Array},
 *            size:number, half:number}}
 */
/** Grid divisions across the bed, capped because the grid loop is quadratic. */
const MAX_GRID_DIVISIONS = 200;
/** Edge ticks across the bed, capped for the same reason at one dimension. */
const MAX_TICKS = 100;

/** A positive, finite number, or `def` when the caller supplied nothing, or
 *  `bad` when they supplied something that is not one. The two fallbacks are
 *  separate on purpose: an absent `grid` means "the usual 10 mm", while an
 *  explicit `grid: 0` means "none", and collapsing them would draw a grid on
 *  every thumbnail that asked for a clean plate. */
function positive(v, def, bad = def) {
  if (v === undefined || v === null) return def;
  return (typeof v === 'number' && isFinite(v) && v > 0) ? v : bad;
}

export function buildPlateGeometry(o = {}) {
  // All three numbers arrive from a caller, and all three have a value that
  // turns this function into a memory bomb. `grid: 0` reads as "no grid" at a
  // call site — the catalogue's preview viewer passes exactly that — but
  // `size / 0` is Infinity and the grid loop below is QUADRATIC in n, so it
  // pushed vertices until the array hit its 2^32 limit and took the whole tab
  // with it. `major: 0` is worse: the tick loop's `v += major` never advances
  // and never throws, so the page just stops. So the numbers are normalised
  // once, here, and every loop below is finite by construction rather than by
  // the caller's good manners.
  const size = positive(o.size, 180);
  const half = size / 2;
  // 0 (or anything not a positive number) means no grid, which is a real thing
  // to want: a 96 px thumbnail cannot resolve a 10 mm grid anyway.
  let grid = positive(o.grid, 10, 0);
  // The grid loop is O(n^2) in the number of divisions: a 0.1 mm grid on a
  // 180 mm bed is 3.24 M cells, about 2.6 GB of vertices. 200 divisions is
  // finer than anyone can read off a screen and costs about 8 MB.
  const gridClamped = grid > 0 && size / grid > MAX_GRID_DIVISIONS;
  if (gridClamped) grid = size / MAX_GRID_DIVISIONS;
  const major = positive(o.major, 50, 0);
  const th = { ...DEFAULT_PLATE_THEME, ...(o.theme || {}) };

  const cFill = parseColor(th.fill), cGrid = parseColor(th.grid), cMajor = parseColor(th.major);
  const cOut = parseColor(th.outline), cX = parseColor(th.axisX), cY = parseColor(th.axisY);
  const cOrigin = parseColor(th.origin);

  const triP = [], triC = [], lineP = [], lineC = [];

  const quad = (a, b, c, d, col, alpha) => {
    for (const v of [a, b, c, a, c, d]) { triP.push(v[0], v[1], v[2]); triC.push(col[0], col[1], col[2], alpha); }
  };
  // A thick "line" as a ribbon in the plate plane.
  const band = (x0, y0, x1, y1, z, w, col, alpha) => {
    const dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l * w / 2, ny = dx / l * w / 2;
    quad([x0 + nx, y0 + ny, z], [x0 - nx, y0 - ny, z], [x1 - nx, y1 - ny, z], [x1 + nx, y1 + ny, z], col, alpha);
  };
  const seg = (x0, y0, x1, y1, z, col, a0, a1) => {
    lineP.push(x0, y0, z, x1, y1, z);
    lineC.push(col[0], col[1], col[2], a0, col[0], col[1], col[2], a1);
  };

  // Radial fade so the plate reads as a surface with a centre rather than a
  // hard sheet of graph paper. Lines are cut at every grid crossing so the fade
  // is actually radial and not a linear ramp between the two far ends.
  const fadeAt = (x, y, base) => {
    const t = Math.min(1, Math.hypot(x, y) / half);
    return base * (1 - (1 - th.edgeFade) * Math.pow(t, 1.6));
  };

  // ---- plate fill -------------------------------------------------------
  quad([-half, -half, PLATE_Z.fill], [half, -half, PLATE_Z.fill],
       [half, half, PLATE_Z.fill], [-half, half, PLATE_Z.fill], cFill, th.fillAlpha);

  // ---- grid -------------------------------------------------------------
  const n = grid > 0 ? Math.round(size / grid) : 0;
  for (let i = 0; i <= n && grid > 0; i++) {
    const v = -half + i * grid;
    const isMajor = major > 0 && Math.abs(v % major) < 1e-6;
    const isAxis = Math.abs(v) < 1e-6;
    const col = isMajor ? cMajor : cGrid;
    const base = isMajor ? th.majorAlpha : th.gridAlpha;
    const z = isMajor ? PLATE_Z.major : PLATE_Z.grid;
    if (isAxis) continue;                     // the axes are drawn separately
    for (let j = 0; j < n; j++) {
      const a = -half + j * grid, b = a + grid;
      seg(v, a, v, b, z, col, fadeAt(v, a, base), fadeAt(v, b, base));
      seg(a, v, b, v, z, col, fadeAt(a, v, base), fadeAt(b, v, base));
    }
  }

  // ---- axes through the origin -----------------------------------------
  // Negative halves in the major-grid colour, positive halves coloured, so you
  // can tell +X from -X at a glance without any text.
  // The axes are subdivided so their fade is radial rather than a linear ramp,
  // and they are drawn whether or not there is a grid to borrow a pitch from.
  const axisStep = grid > 0 ? grid : size / 24;
  const an = Math.max(1, Math.round(size / axisStep));
  for (let j = 0; j < an; j++) {
    const a = -half + j * axisStep, b = a + axisStep;
    const px = a >= -1e-6, colX = px ? cX : cMajor, colY = px ? cY : cMajor;
    const aA = fadeAt(a, 0, px ? 0.95 : th.majorAlpha), aB = fadeAt(b, 0, px ? 0.95 : th.majorAlpha);
    seg(a, 0, b, 0, PLATE_Z.axis, colX, aA, aB);
    seg(0, a, 0, b, PLATE_Z.axis, colY, aA, aB);
  }

  // ---- bed outline + corner ticks --------------------------------------
  const w = Math.max(size * 0.0035, 0.4);      // ~0.63 mm on a 180 bed
  band(-half, -half, half, -half, PLATE_Z.outline, w, cOut, th.outlineAlpha);
  band(half, -half, half, half, PLATE_Z.outline, w, cOut, th.outlineAlpha);
  band(half, half, -half, half, PLATE_Z.outline, w, cOut, th.outlineAlpha);
  band(-half, half, -half, -half, PLATE_Z.outline, w, cOut, th.outlineAlpha);

  // Ticks mark the major-grid multiples, not "one major pitch in from the
  // edge" — on a 180 bed with a 50 mm major those are different sets, and the
  // second one is meaningless.
  const tick = size * 0.022;
  // A tick pitch of zero would leave `v += pitch` standing still for ever, and
  // a tiny one would draw more ticks than the bed has pixels. Both are bounded
  // here rather than trusted.
  const tickPitch = major > 0 ? Math.max(major, size / MAX_TICKS) : 0;
  const firstTick = tickPitch > 0 ? -Math.floor(half / tickPitch) * tickPitch : 1;
  for (let v = firstTick; tickPitch > 0 && v <= half - 1e-6; v += tickPitch) {
    if (Math.abs(v) < 1e-6) continue;             // the axis already marks zero
    seg(v, -half, v, -half + tick, PLATE_Z.tick, cOut, 0.9, 0.0);
    seg(-half, v, -half + tick, v, PLATE_Z.tick, cOut, 0.9, 0.0);
  }

  // ---- origin marker ----------------------------------------------------
  const r = Math.max(size * 0.017, 1.5);
  const ow = w * 0.8;
  band(-r, -r, r, -r, PLATE_Z.origin, ow, cOrigin, 0.9);
  band(r, -r, r, r, PLATE_Z.origin, ow, cOrigin, 0.9);
  band(r, r, -r, r, PLATE_Z.origin, ow, cOrigin, 0.9);
  band(-r, r, -r, -r, PLATE_Z.origin, ow, cOrigin, 0.9);
  band(-r * 0.45, 0, r * 0.45, 0, PLATE_Z.origin, ow, cOrigin, 0.75);
  band(0, -r * 0.45, 0, r * 0.45, PLATE_Z.origin, ow, cOrigin, 0.75);

  return {
    tri: { positions: new Float32Array(triP), colors: new Float32Array(triC) },
    line: { positions: new Float32Array(lineP), colors: new Float32Array(lineC) },
    size, half,
    // What was actually drawn, which is not always what was asked for.
    grid, major, divisions: n, gridClamped,
    bbox: { min: [-half, -half, PLATE_Z.fill], max: [half, half, 0] },
  };
}

/** Geometry for the ground-shadow quad — the plate footprint at shadow height.
 *  Kept separate because it is drawn through the stencil, not with the plate. */
export function buildShadowQuad(half, z = PLATE_Z.shadow) {
  return new Float32Array([
    -half, -half, z, half, -half, z, half, half, z,
    -half, -half, z, half, half, z, -half, half, z,
  ]);
}

export class PlateRenderer {
  /** @param {WebGL2RenderingContext} gl @param {import('./glutil.js').Program} lineProgram */
  constructor(gl, lineProgram, opts = {}) {
    this.gl = gl;
    this.program = lineProgram;
    this.triVao = gl.createVertexArray();
    this.lineVao = gl.createVertexArray();
    this.triPos = new GLBuffer(gl);
    this.triCol = new GLBuffer(gl);
    this.linePos = new GLBuffer(gl);
    this.lineCol = new GLBuffer(gl);
    this.triCount = 0;
    this.lineCount = 0;
    this.geometry = null;
    this.set(opts);
  }

  set(opts = {}) {
    const gl = this.gl;
    const g = buildPlateGeometry(opts);
    this.geometry = g;
    const aPos = this.program.attrib('a_position');
    const aCol = this.program.attrib('a_color');

    gl.bindVertexArray(this.triVao);
    this.triPos.set(g.tri.positions);
    setAttrib(gl, aPos, this.triPos, 3);
    this.triCol.set(g.tri.colors);
    setAttrib(gl, aCol, this.triCol, 4);

    gl.bindVertexArray(this.lineVao);
    this.linePos.set(g.line.positions);
    setAttrib(gl, aPos, this.linePos, 3);
    this.lineCol.set(g.line.colors);
    setAttrib(gl, aCol, this.lineCol, 4);
    gl.bindVertexArray(null);

    this.triCount = g.tri.positions.length / 3;
    this.lineCount = g.line.positions.length / 3;
    return this;
  }

  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.LINES, 0, this.lineCount);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const b of [this.triPos, this.triCol, this.linePos, this.lineCol]) b.dispose();
    gl.deleteVertexArray(this.triVao);
    gl.deleteVertexArray(this.lineVao);
    this.triVao = this.lineVao = null;
  }
}
