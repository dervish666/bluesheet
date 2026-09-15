/**
 * gcode.js — toolpath preview: normalise sliced layer data, pack it into one
 * instance buffer, and draw a layer range of it as shaded ribbons.
 *
 * Segments are stored in print order (layer by layer, and within a layer in the
 * order the head moves), which is what makes both the layer slider and the
 * bottom-up build animation a contiguous instance range rather than a per-frame
 * rebuild. Extrusions and travels live in separate buffers so hiding travels —
 * the first thing anyone does — costs nothing at all.
 *
 * The wire format is the one the server promises in PLAN.md:
 *     { layers: [ { z, paths: [ { type, pts, width? } ] } ] }
 * `pts` may be a flat number array or an array of [x,y(,z)] tuples, 2D or 3D.
 * A raw G-code string is accepted too and parsed here, which is the fallback
 * when all we have is the file.
 */

import { GLBuffer, setAttrib } from './glutil.js';
import { parseColor } from './geometry.js';

/** Index order must match u_typeColors[12] in shaders.js. */
export const MOVE_TYPES = ['travel', 'outer', 'inner', 'solid', 'top', 'bottom',
                           'infill', 'support', 'bridge', 'skirt', 'custom', 'other'];

export const MOVE_LABELS = {
  travel: 'Travel', outer: 'Outer wall', inner: 'Inner wall', solid: 'Solid infill',
  top: 'Top surface', bottom: 'Bottom surface', infill: 'Sparse infill',
  support: 'Support', bridge: 'Bridge', skirt: 'Skirt / brim', custom: 'Custom',
  other: 'Other',
};

export const MOVE_COLORS = {
  travel: '#5b6b7c', outer: '#ff8a3d', inner: '#ffc861', solid: '#e0574d',
  top: '#b98cff', bottom: '#5fc8ff', infill: '#c0453e', support: '#4ade80',
  bridge: '#38bdf8', skirt: '#9aa7b4', custom: '#f0abfc', other: '#94a3b8',
};

/** Default extrusion width per type, used when the slicer data does not say. */
const DEFAULT_WIDTH = {
  travel: 0, outer: 0.42, inner: 0.45, solid: 0.45, top: 0.42, bottom: 0.42,
  infill: 0.45, support: 0.38, bridge: 0.42, skirt: 0.42, custom: 0.42, other: 0.42,
};

const TYPE_INDEX = Object.fromEntries(MOVE_TYPES.map((t, i) => [t, i]));

// Longest-and-most-specific first: "top solid infill" must not match "solid".
const TYPE_PATTERNS = [
  [/travel|move/, 'travel'],
  [/top\s*(solid|surface)|topsurface|top$/, 'top'],
  [/bottom/, 'bottom'],
  [/bridge/, 'bridge'],
  [/support/, 'support'],
  [/skirt|brim/, 'skirt'],
  [/(outer|external)\s*(wall|perimeter)|wall-outer|overhang\s*wall/, 'outer'],
  [/(inner|internal)\s*(wall|perimeter)|wall-inner/, 'inner'],
  [/solid|skin/, 'solid'],
  [/sparse|infill|fill/, 'infill'],
  // A bare "Perimeter" is PrusaSlicer's INNER wall — it names the outer one
  // "External perimeter" — so the unqualified fallback must not be 'outer'.
  [/perimeter|wall/, 'inner'],
  [/custom|prime|wipe/, 'custom'],
];

/** Slicer type name -> canonical type key. Unknown names become 'other' rather
 *  than being dropped: an uncoloured path is still a path you want to see. */
export function normaliseType(name) {
  if (name == null) return 'other';
  if (typeof name === 'number') return MOVE_TYPES[name] || 'other';
  const s = String(name).toLowerCase().trim();
  if (TYPE_INDEX[s] !== undefined) return s;
  for (const [re, key] of TYPE_PATTERNS) if (re.test(s)) return key;
  return 'other';
}

export function typeIndex(name) { return TYPE_INDEX[normaliseType(name)]; }

/** Bit mask for the shader's u_typeMask from a list of visible type keys. */
export function typeMask(visible) {
  let m = 0;
  for (const t of visible) {
    const i = TYPE_INDEX[normaliseType(t)];
    if (i !== undefined) m |= (1 << i);
  }
  return m;
}

export const ALL_TYPES_MASK = typeMask(MOVE_TYPES);

// ---- normalising the wire format ---------------------------------------
/**
 * A flat [x,y,z,x,y,z,...] of length 6 is indistinguishable from a flat
 * [x,y,x,y,x,y] — so a path may carry an explicit `dim`. Without one, 3 is
 * assumed when the length divides by 3, because that is what both our own
 * parser and the server emit; the layer's z fills in for 2D data.
 */
function toPoints(pts, z, dim) {
  const out = [];
  if (!pts || !pts.length) return out;
  if (typeof pts[0] === 'number') {
    const stride = (dim === 2 || dim === 3) ? dim : (pts.length % 3 === 0 ? 3 : 2);
    for (let i = 0; i + stride - 1 < pts.length; i += stride) {
      out.push([pts[i], pts[i + 1], stride === 3 ? pts[i + 2] : z]);
    }
  } else {
    for (const p of pts) out.push([p[0], p[1], p.length > 2 ? p[2] : z]);
  }
  return out;
}

/**
 * Pack layer data into GPU-ready instance buffers.
 * @returns {{extrude:Pack, travel:Pack, layerZ:Float32Array, layerCount:number,
 *            bbox:{min:number[],max:number[]}, segmentCount:number,
 *            typeCounts:Record<string,number>}}
 *          where Pack = {data:Float32Array, count:number, layerStart:Uint32Array}
 */
export function buildToolpathBuffers(input, opts = {}) {
  const data = typeof input === 'string' ? parseGcodeText(input, opts) : input;
  const layers = (data && data.layers) || [];
  const maxSegments = opts.maxSegments ?? 4_000_000;

  const ex = { xs: [], layerStart: [0] };
  const tr = { xs: [], layerStart: [0] };
  const layerZ = new Float32Array(layers.length);
  const typeCounts = {};
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let segments = 0, truncated = false;

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li] || {};
    const z = Number.isFinite(layer.z) ? layer.z : li * (opts.layerHeight ?? 0.2);
    layerZ[li] = z;
    for (const path of (layer.paths || [])) {
      const key = normaliseType(path.type);
      const ti = TYPE_INDEX[key];
      const w = Number.isFinite(path.width) ? path.width : DEFAULT_WIDTH[key];
      const pts = toPoints(path.pts || path.points, z, path.dim);
      const sink = key === 'travel' ? tr.xs : ex.xs;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        // Zero-length segments would make the ribbon's axis a NaN; the slicer
        // emits them at retractions and they carry no information.
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
        if (segments >= maxSegments) { truncated = true; break; }
        sink.push(a[0], a[1], a[2], b[0], b[1], b[2], ti, li, w);
        segments++;
        typeCounts[key] = (typeCounts[key] || 0) + 1;
        for (let k = 0; k < 3; k++) {
          if (a[k] < min[k]) min[k] = a[k];
          if (a[k] > max[k]) max[k] = a[k];
          if (b[k] < min[k]) min[k] = b[k];
          if (b[k] > max[k]) max[k] = b[k];
        }
      }
      if (truncated) break;
    }
    ex.layerStart.push(ex.xs.length / 9);
    tr.layerStart.push(tr.xs.length / 9);
    if (truncated) {
      // Keep the layer index table the right length so the slider still maps.
      for (let j = li + 1; j < layers.length; j++) {
        ex.layerStart.push(ex.xs.length / 9);
        tr.layerStart.push(tr.xs.length / 9);
      }
      break;
    }
  }

  if (!segments) min = max = [0, 0, 0];
  return {
    extrude: { data: new Float32Array(ex.xs), count: ex.xs.length / 9, layerStart: new Uint32Array(ex.layerStart) },
    travel: { data: new Float32Array(tr.xs), count: tr.xs.length / 9, layerStart: new Uint32Array(tr.layerStart) },
    layerZ, layerCount: layers.length, bbox: { min, max }, segmentCount: segments,
    typeCounts, truncated,
  };
}

/**
 * Instance range for a print that has got as far as `progress`.
 *
 * `progress` is a continuous count of layers laid down from the bottom, NOT a
 * layer index: 0 draws nothing, 1 draws layer 0 complete, 2.5 draws layers 0
 * and 1 complete plus half of layer 2. One monotonic number covers both the
 * slider and the build animation; the index-based public API in viewer.js
 * converts (an inclusive top index i is progress i + 1).
 */
export function layerRange(pack, lo, progress) {
  const nLayers = pack.layerStart.length - 1;
  if (nLayers <= 0) return { first: 0, count: 0 };
  const l = Math.max(0, Math.min(nLayers - 1, Math.floor(lo)));
  const p = Math.max(0, Math.min(nLayers, progress));
  const full = Math.floor(p);
  const frac = p - full;
  const first = pack.layerStart[l];
  const base = pack.layerStart[Math.min(full, nLayers)];
  const next = pack.layerStart[Math.min(full + 1, nLayers)];
  const end = base + Math.round(frac * (next - base));
  return { first, count: Math.max(0, end - first) };
}

// ---- raw G-code ---------------------------------------------------------
/**
 * Parse a G-code file into the same {layers:[{z,paths:[{type,pts}]}]} shape the
 * server hands back. Understands the `;TYPE:` / `;WIDTH:` comment convention
 * that Orca, Prusa and Cura all emit, `;LAYER_CHANGE` / `;LAYER:n`, absolute
 * and relative positioning (G90/G91, M82/M83) and G92. Anything it does not
 * recognise becomes a travel or an 'other' path rather than being dropped.
 *
 * A layer boundary is a Z-only move or a layer comment. Spiral-vase G-code has
 * neither — Z rises continuously inside the XY moves — so a vase parses as one
 * tall layer. That is honest rather than wrong: there are no discrete layers to
 * slider through, and every segment still draws.
 */
export function parseGcodeText(text, opts = {}) {
  const lines = String(text).split(/\r?\n/);
  const layers = [];
  let layer = null, path = null;
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = true;
  let type = 'other', width = NaN;
  const layerHeight = opts.layerHeight ?? 0.2;

  const newLayer = (nz) => {
    layer = { z: nz, paths: [] };
    layers.push(layer);
    path = null;
  };
  // Start a run at the point the head is already at, so consecutive moves of
  // the same type join into one polyline instead of N two-point paths.
  const startPathAt = (sx, sy, sz, t, w) => {
    if (!layer) newLayer(sz || layerHeight);
    path = { type: t, pts: [sx, sy, sz], dim: 3 };
    if (Number.isFinite(w) && w > 0) path.width = w;
    layer.paths.push(path);
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const semi = raw.indexOf(';');
    if (semi >= 0) {
      const c = raw.slice(semi + 1).trim();
      const lower = c.toLowerCase();
      if (lower.startsWith('type:')) { type = normaliseType(c.slice(5)); path = null; }
      else if (lower.startsWith('width:')) { width = parseFloat(c.slice(6)); path = null; }
      else if (lower.startsWith('layer_change') || lower.startsWith('layer:') || /^layer\b/.test(lower)) { layer = null; path = null; }
    }
    const code = semi >= 0 ? raw.slice(0, semi) : raw;
    if (!code.trim()) continue;
    // M82/M83 pick the extruder's addressing mode, and getting it wrong turns
    // every extrusion after the first into a travel — silently, and the preview
    // just looks empty.
    const mm = /^\s*M(8[23])\b/i.exec(code);
    if (mm) { absE = mm[1] === '82'; continue; }
    const m = /^\s*G(\d+)/i.exec(code);
    if (!m) continue;
    const g = +m[1];
    if (g === 90) { absXYZ = true; continue; }
    if (g === 91) { absXYZ = false; continue; }
    if (g === 92) {
      const ev = axis(code, 'E'); if (ev !== null) e = ev;
      const zv = axis(code, 'Z'); if (zv !== null) z = zv;
      continue;
    }
    if (g !== 0 && g !== 1) continue;

    const nx = axis(code, 'X'), ny = axis(code, 'Y'), nz = axis(code, 'Z'), ne = axis(code, 'E');
    const px = x, py = y, pz = z;
    if (nx !== null) x = absXYZ ? nx : x + nx;
    if (ny !== null) y = absXYZ ? ny : y + ny;
    if (nz !== null) z = absXYZ ? nz : z + nz;
    let de = 0;
    if (ne !== null) {
      if (absE) { de = ne - e; e = ne; } else { de = ne; e += ne; }
    }

    if (nz !== null && z !== pz && (nx === null && ny === null)) {
      // A pure Z move is a layer change even without the comment marker.
      newLayer(z);
      continue;
    }
    if (nx === null && ny === null) continue;

    const moving = x !== px || y !== py || z !== pz;
    if (!moving) continue;
    const extruding = de > 1e-9;
    const wantType = extruding ? type : 'travel';
    if (!layer) newLayer(z);
    if (!path || path.type !== wantType || !continuous(path, px, py, pz)) {
      startPathAt(px, py, pz, wantType, extruding ? width : 0);
    }
    path.pts.push(x, y, z);
  }

  return { layers, source: 'gcode' };
}

function continuous(path, px, py, pz) {
  const n = path.pts.length;
  return n >= 3 && path.pts[n - 3] === px && path.pts[n - 2] === py && path.pts[n - 1] === pz;
}

function axis(code, letter) {
  const i = code.indexOf(letter);
  const j = i < 0 ? code.indexOf(letter.toLowerCase()) : i;
  if (j < 0) return null;
  const v = parseFloat(code.slice(j + 1));
  return isFinite(v) ? v : null;
}

// ---- GL ------------------------------------------------------------------
const STRIDE = 9 * 4;

/** One instanced ribbon pack (extrusions or travels) on the GPU. */
class Pack {
  constructor(gl, program, corners) {
    this.gl = gl;
    this.program = program;
    this.vao = gl.createVertexArray();
    this.instances = new GLBuffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    this.count = 0;
    this.layerStart = new Uint32Array([0]);
    this._first = -1;
    gl.bindVertexArray(this.vao);
    setAttrib(gl, program.attrib('a_corner'), corners, 2);
    gl.bindVertexArray(null);
  }

  set(pack) {
    this.count = pack.count;
    this.layerStart = pack.layerStart;
    this._first = -1;
    if (pack.count) this.instances.set(pack.data);
    return this;
  }

  /** Re-point the instanced attributes at instance `first`. WebGL2 has no
   *  baseInstance, but the attribute offset does the same job for free. */
  _point(first) {
    const gl = this.gl, off = first * STRIDE;
    setAttrib(gl, this.program.attrib('a_start'), this.instances, 3, { stride: STRIDE, offset: off, divisor: 1 });
    setAttrib(gl, this.program.attrib('a_end'), this.instances, 3, { stride: STRIDE, offset: off + 12, divisor: 1 });
    setAttrib(gl, this.program.attrib('a_meta'), this.instances, 3, { stride: STRIDE, offset: off + 24, divisor: 1 });
    this._first = first;
  }

  drawRange(first, count) {
    if (count <= 0 || !this.count || first >= this.count) return 0;
    // Never let a stale slider run the instance window off the end of the
    // buffer: a negative instance count is a GL error, and an over-long one
    // reads attributes past the allocation.
    const n = Math.min(count, this.count - first);
    if (n <= 0) return 0;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (first !== this._first) this._point(first);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    return n;
  }

  dispose() {
    this.instances.dispose();
    this.gl.deleteVertexArray(this.vao);
    this.vao = null;
  }
}

export class ToolpathRenderer {
  /** @param {WebGL2RenderingContext} gl @param {import('./glutil.js').Program} program */
  constructor(gl, program, cornerBuffer) {
    this.gl = gl;
    this.program = program;
    this.extrude = new Pack(gl, program, cornerBuffer);
    this.travel = new Pack(gl, program, cornerBuffer);
    this.built = null;
  }

  set(built) {
    this.built = built;
    this.extrude.set(built.extrude);
    this.travel.set(built.travel);
    return this;
  }

  get layerCount() { return this.built ? this.built.layerCount : 0; }

  /** Draw the extrusions of layers [lo, hi]; hi may be fractional so the build
   *  animation can stop part way along the layer currently being laid. */
  drawExtrusions(lo, hi) {
    if (!this.built) return 0;
    const r = layerRange(this.extrude, lo, hi);
    return this.extrude.drawRange(r.first, r.count);
  }

  /** Travels are a separate pack and a separate draw so they can be blended,
   *  unshaded and toggled without a branch in the hot shader. */
  drawTravels(lo, hi) {
    if (!this.built) return 0;
    const r = layerRange(this.travel, lo, hi);
    return this.travel.drawRange(r.first, r.count);
  }

  /** Forget the current print without tearing down the GL objects — the packs
   *  are reused for the next slice. */
  clear() {
    const empty = { data: new Float32Array(0), count: 0, layerStart: new Uint32Array([0]) };
    this.extrude.set(empty);
    this.travel.set(empty);
    this.built = null;
    return this;
  }

  dispose() { this.extrude.dispose(); this.travel.dispose(); this.built = null; }
}

/** Type colours as a flat Float32Array for u_typeColors[12]. */
export function typeColorArray(overrides = {}) {
  const out = new Float32Array(MOVE_TYPES.length * 3);
  MOVE_TYPES.forEach((t, i) => {
    const c = parseColor(overrides[t] || MOVE_COLORS[t]);
    out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
  });
  return out;
}
