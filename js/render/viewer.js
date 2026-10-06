/**
 * viewer.js — Bluesheet's WebGL2 preview.
 *
 * ┌── API ─────────────────────────────────────────────────────────────────┐
 * │ const v = new Viewer(canvas, opts)                                      │
 * │                                                                         │
 * │ v.setMesh(mesh | {positions, normals, indices} | null)                  │
 * │        Accepts a kernel Mesh (crease-aware normals are computed here via │
 * │        mesh.toRenderBuffers) or a buffer set already built in a worker.  │
 * │ v.setGcode(data | gcodeText | null)   {layers:[{z, paths:[{type,pts}]}]} │
 * │ v.setMode('solid' | 'overhang' | 'wire' | 'gcode' | 'backlit')          │
 * │ v.setClip(z | null)              cross-section plane on Z; null = off    │
 * │ v.clipRange()                 -> [minZ, maxZ] for the slider            │
 * │ v.setOverhangThreshold(deg)      overhang view threshold, default 50     │
 * │ v.setLayerRange(lo, hi)          G-code layer window, inclusive indices   │
 * │ v.playBuild({secondsPerLayer})   bottom-up build animation               │
 * │ v.stopBuild()                                                            │
 * │ v.setTravels(bool)  v.setTypeVisibility({infill:false, ...})            │
 * │ v.fit()                          frame the current object                │
 * │ v.setPreset('front'|'back'|'left'|'right'|'top'|'bottom'|'iso'|'isoLeft')│
 * │ v.setEdges(bool)                 wireframe overlay on the solid          │
 * │ v.setTheme({...})  v.setColor('#rrggbb')  v.setOptions({...})           │
 * │ v.requestDraw()  v.render()      on-demand / forced synchronous draw     │
 * │ v.thumbnail({size})           -> data URL, for the library card          │
 * │ v.plateHit(ev|{x,y})          -> [x,y,0] mm on the build plate           │
 * │ v.on('camera'|'mode'|'render'|'error', fn)  v.off(...)                   │
 * │ v.stats                       -> {tris, verts, segments, ms, calls}      │
 * │ v.dispose()                                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Interaction, mouse and touch alike (the iPad is the primary target, so
 * nothing here needs a scroll wheel or a hover):
 *   one finger / left drag      orbit          two fingers / right drag  pan
 *   pinch                       zoom           two-finger twist          roll
 *   double tap / double click   fit            wheel                     zoom
 *   1..6 presets · F fit · W wire · O overhang · B backlit · S solid · R level
 *
 * Rendering is on demand. A frame is drawn when something actually changed;
 * there is no idle loop, and `document.hidden` stops the viewer dead. This
 * laptop lives in a cupboard next to a printer and has nowhere to put its heat.
 */

import { Camera, PRESETS, DEG, norm3, add3, scale3, mat4Identity } from './camera.js';
import { Program, GLBuffer, setAttrib, indexType } from './glutil.js';
import * as S from './shaders.js';
import { PlateRenderer, buildShadowQuad, PLATE_Z } from './plate.js';
import { ToolpathRenderer, buildToolpathBuffers, typeColorArray, typeMask, MOVE_TYPES, MOVE_COLORS, MOVE_LABELS } from './gcode.js';
import { meshToBuffers, buildEdgeIndices, boxUnion, parseColor, toLinear, overhangStats } from './geometry.js';

export const MODES = ['solid', 'overhang', 'wire', 'gcode', 'backlit'];

// The backlit view's model of white PLA. Chosen, not measured: 1.8 per mm puts
// lithophane's default 0.8 mm at the bare lamp and its 3.0 mm at 2% of it
// (about 17% grey once gamma-encoded), with the midtones landing dark the way
// lithophane's "raise the gamma to about 1.3" note says real PLA does.
export const BACKLIT_PLA = Object.freeze({ mu: 1.8, whiteMM: 0.8, floor: 0.01 });

export const DEFAULT_THEME = {
  // surfaces
  bgTop: '#232a34', bgBottom: '#11151b',
  object: '#c9d0d8',        // unpigmented-PLA grey: shows form without fighting
  cut: '#e8a13c',           // the cross-section face
  warn: '#f2c14e', over: '#e0473f',
  wire: '#8fd0ff', ghost: '#2a323d',
  shadow: '#05070a', shadowAlpha: 0.38,
  // the light rig: warm key over the shoulder, cool fill, cool rim, and a
  // hemisphere of workshop-ceiling above / workbench below
  key: '#fff6ea', fill: '#8fa4c4', rim: '#9ec5ff',
  sky: '#6b7a92', ground: '#2a2521',
  // backlit: a warm-white bulb (about 3000 K) in a dark room
  lamp: '#ffd6a5', nightTop: '#0b0e12', nightBottom: '#030405',
};

const DEFAULTS = {
  bed: { x: 180, y: 180, z: 180 },
  grid: 10,
  majorGrid: 50,
  layerH: 0.2,
  crease: 35,
  overhangDeg: 50,
  maxDpr: 2,
  antialias: true,
  shadows: true,
  shadowTriBudget: 260_000,
  edgeTriBudget: 2_000_000,
  keys: true,
  twist: true,
  ambient: 0.55,
  gloss: 0.35,
  minToolpathPx: 1.6,
  plate: true,
  legend: true,
  stats: false,
  legendContainer: null,
};

export class Viewer {
  constructor(canvas, opts = {}) {
    if (!canvas || !canvas.getContext) throw new TypeError('new Viewer(canvas): needs a <canvas>');
    this.canvas = canvas;
    this.opts = { ...DEFAULTS, ...opts };
    this.theme = { ...DEFAULT_THEME, ...(opts.theme || {}) };
    this.camera = new Camera({
      target: [0, 0, this.opts.bed.z * 0.12],
      distance: this.opts.bed.x * 1.9,
      sceneRadius: this.opts.bed.x,
      ...(opts.camera || {}),
    });

    this._mode = 'solid';
    this._edgesWanted = false;      // the overlay the UI asked for, independent
                                    // of wire mode, which always shows edges
    this._clipOn = false;
    this._clipZ = 0;
    this._overhangDeg = this.opts.overhangDeg;
    this._buffers = null;          // CPU-side mesh buffers, kept for context loss
    this._sourceMesh = null;
    this._meshBox = null;
    this._edgeIndices = null;
    this._edgesTried = false;
    this._gcode = null;            // packed toolpaths
    this._layerLo = 0;
    // Continuous "layers laid down from the bottom", not an index: 0 draws
    // nothing, layerCount draws the finished print. One monotonic number serves
    // both the slider and the build animation — see layerRange() in gcode.js.
    this._progress = 0;
    this._travels = false;
    this._typeMask = typeMask(MOVE_TYPES.filter(t => t !== 'travel'));
    this._anim = null;
    this._listeners = new Map();
    this._pointers = new Map();
    this._gesture = null;
    this._lastTap = 0;
    this._raf = 0;
    this._dirty = true;
    this._capDirty = true;
    this._disposed = false;
    this._lost = false;
    this._w = 1; this._h = 1;
    this._colCache = new Map();
    this.stats = { tris: 0, verts: 0, segments: 0, layers: 0, ms: 0, calls: 0, dpr: 1 };

    this._tick = this._tick.bind(this);
    this._initGL();
    this._bindEvents();
    this._makeLegend();
    this._resize();
    this.requestDraw();
  }

  // ---- GL setup ---------------------------------------------------------
  _initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: this.opts.antialias,
      depth: true,
      stencil: true,               // the cross-section cap and the ground shadow
      premultipliedAlpha: true,
      // false, because preserving it costs a full-frame copy every frame; the
      // thumbnail path draws synchronously and reads back in the same task,
      // which is valid without it.
      preserveDrawingBuffer: false,
      powerPreference: 'default',  // "high-performance" wakes the dGPU; there isn't one
    });
    if (!gl) {
      const e = new Error('WebGL2 is not available — Bluesheet needs it for the 3D view. ' +
        'A very old browser, a blocked GPU process, or hardware acceleration turned off.');
      this._emit('error', e);
      throw e;
    }
    this.gl = gl;
    this.hasStencil = !!(gl.getContextAttributes() || {}).stencil;

    this.programs = {
      bg: new Program(gl, S.BACKGROUND_VS, S.BACKGROUND_FS, 'background'),
      solid: new Program(gl, S.SOLID_VS, S.SOLID_FS, 'solid'),
      line: new Program(gl, S.LINE_VS, S.LINE_FS, 'line'),
      shadow: new Program(gl, S.SHADOW_VS, S.SHADOW_FS, 'shadow'),
      path: new Program(gl, S.TOOLPATH_VS, S.TOOLPATH_FS, 'toolpath'),
      backlit: new Program(gl, S.BACKLIT_VS, S.BACKLIT_FS, 'backlit'),
    };
    this._peel = null;             // backlit's depth target, made on first use

    // Buffers are created once and refilled; nothing here is reallocated per
    // frame, which is the whole trick to surviving a 500k-triangle model.
    this.buf = {
      pos: new GLBuffer(gl),
      nrm: new GLBuffer(gl),
      idx: new GLBuffer(gl, gl.ELEMENT_ARRAY_BUFFER),
      edge: new GLBuffer(gl, gl.ELEMENT_ARRAY_BUFFER),
      cap: new GLBuffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW),
      capNrm: new GLBuffer(gl),
      shadowQuad: new GLBuffer(gl),
      shadowCol: new GLBuffer(gl),
      corners: new GLBuffer(gl),
    };
    this.buf.corners.set(S.RIBBON_CORNERS);

    this.vao = {
      bg: gl.createVertexArray(),
      mesh: gl.createVertexArray(),
      edge: gl.createVertexArray(),
      shadow: gl.createVertexArray(),
      cap: gl.createVertexArray(),
      shadowQuad: gl.createVertexArray(),
      backlit: gl.createVertexArray(),
    };

    // Cap quad: 6 vertices, normals all +Z, positions rewritten when the clip
    // plane or the model moves.
    const capN = new Float32Array(18);
    for (let i = 0; i < 6; i++) capN[i * 3 + 2] = 1;
    gl.bindVertexArray(this.vao.cap);
    this.buf.cap.set(new Float32Array(18));
    setAttrib(gl, this.programs.solid.attrib('a_position'), this.buf.cap, 3);
    this.buf.capNrm.set(capN);
    setAttrib(gl, this.programs.solid.attrib('a_normal'), this.buf.capNrm, 3);
    gl.bindVertexArray(null);

    const half = this.opts.bed.x / 2;
    const sq = buildShadowQuad(half);
    const sc = new Float32Array(24);
    const shadowRGB = parseColor(this.theme.shadow);
    for (let i = 0; i < 6; i++) {
      sc[i * 4] = shadowRGB[0]; sc[i * 4 + 1] = shadowRGB[1];
      sc[i * 4 + 2] = shadowRGB[2]; sc[i * 4 + 3] = this.theme.shadowAlpha;
    }
    gl.bindVertexArray(this.vao.shadowQuad);
    this.buf.shadowQuad.set(sq);
    setAttrib(gl, this.programs.line.attrib('a_position'), this.buf.shadowQuad, 3);
    this.buf.shadowCol.set(sc);
    setAttrib(gl, this.programs.line.attrib('a_color'), this.buf.shadowCol, 4);
    gl.bindVertexArray(null);

    this.plate = new PlateRenderer(gl, this.programs.line, {
      size: this.opts.bed.x, grid: this.opts.grid, major: this.opts.majorGrid,
      theme: this.opts.plateTheme,
    });
    this.paths = new ToolpathRenderer(gl, this.programs.path, this.buf.corners);
    this._typeColors = typeColorArray(this.opts.moveColors);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearDepth(1);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Re-upload everything after a context loss. The CPU-side arrays are kept
   *  precisely so this is possible without asking the UI to rebuild the mesh. */
  _restore() {
    this._initGL();
    if (this._buffers) this._uploadMesh(this._buffers);
    if (this._gcode) this.paths.set(this._gcode);
    // The edge index buffer lived on the dead context; drop the CPU copy too so
    // _ensureEdges rebuilds and re-uploads instead of short-circuiting.
    this._edgeIndices = null;
    this._edgesTried = false;
    this._capDirty = true;
    this._dirty = true;
    this.requestDraw();
  }

  // ---- public API -------------------------------------------------------
  /** @param {object|null} mesh a kernel Mesh, a prepared buffer set, or null. */
  setMesh(mesh) {
    if (!mesh) {
      this._buffers = null; this._meshBox = null; this._edgeIndices = null;
      this._sourceMesh = null;
      this._edgesTried = false; this._overhang = null;
      this.stats.tris = 0; this.stats.verts = 0;
      this._updateLegend();
      return this._changed();
    }
    const b = meshToBuffers(mesh, { crease: this.opts.crease });
    // Held so a later crease-angle change can rebuild the normals; it is the
    // caller's object, not a copy, and setMesh(null) drops it.
    this._sourceMesh = mesh;
    this._buffers = b;
    this._meshBox = b.bbox;
    this._edgeIndices = null;
    this._edgesTried = false;
    this._uploadMesh(b);
    this.stats.tris = b.triCount;
    this.stats.verts = b.vertCount;
    this.camera.setSceneBounds(boxUnion(b.bbox, this._plateBox()));
    // A new object usually means a new clip range; keep the plane inside it.
    const [lo, hi] = this.clipRange();
    if (this._clipZ < lo || this._clipZ > hi) this._clipZ = hi;
    this._capDirty = true;
    this._overhang = null;
    this._updateLegend();
    return this._changed();
  }

  _uploadMesh(b) {
    const gl = this.gl;
    if (!gl || this._lost) return;
    // An ELEMENT_ARRAY_BUFFER binding is VAO state: uploading indices while
    // someone else's VAO is bound would silently rewire their draw.
    gl.bindVertexArray(null);
    this.buf.pos.set(b.positions);
    this.buf.nrm.set(b.normals);
    this.buf.idx.set(b.indices, b.indexCount);
    this._indexType = indexType(gl, b.indices);

    gl.bindVertexArray(this.vao.mesh);
    setAttrib(gl, this.programs.solid.attrib('a_position'), this.buf.pos, 3);
    setAttrib(gl, this.programs.solid.attrib('a_normal'), this.buf.nrm, 3);
    this.buf.idx.bind();
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.vao.shadow);
    setAttrib(gl, this.programs.shadow.attrib('a_position'), this.buf.pos, 3);
    this.buf.idx.bind();
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.vao.backlit);
    setAttrib(gl, this.programs.backlit.attrib('a_position'), this.buf.pos, 3);
    this.buf.idx.bind();
    gl.bindVertexArray(null);
  }

  setGcode(data) {
    if (!data) {
      this._gcode = null; this.stats.segments = 0; this.stats.layers = 0;
      this.paths.clear();
      this._updateLegend();
      return this._changed();
    }
    const built = buildToolpathBuffers(data, { layerHeight: this.opts.layerH });
    this._gcode = built;
    this.paths.set(built);
    this.stats.segments = built.segmentCount;
    this.stats.layers = built.layerCount;
    this._layerLo = 0;
    this._progress = built.layerCount;
    this._updateLegend();
    return this._changed();
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`setMode: unknown mode "${mode}" (have ${MODES.join(', ')})`);
    this._mode = mode;
    if (this._showEdges) this._ensureEdges();
    this._emit('mode', mode);
    this._updateLegend();
    return this._changed();
  }

  get mode() { return this._mode; }

  setEdges(on) {
    this._edgesWanted = !!on;
    if (this._edgesWanted) this._ensureEdges();
    return this._changed();
  }

  get _showEdges() { return this._edgesWanted || this._mode === 'wire'; }

  /** z in mm, or null to switch the cross-section off. */
  setClip(z) {
    if (z == null || !Number.isFinite(z)) { this._clipOn = false; return this._changed(); }
    const [lo, hi] = this.clipRange();
    this._clipZ = Math.min(hi, Math.max(lo, z));
    this._clipOn = true;
    this._capDirty = true;
    return this._changed();
  }

  setClipEnabled(on) { this._clipOn = !!on; return this._changed(); }
  get clipZ() { return this._clipZ; }

  /** [minZ, maxZ] of the current object — what the section slider should span. */
  clipRange() {
    const b = this._meshBox || (this._gcode && this._gcode.bbox) || { min: [0, 0, 0], max: [0, 0, this.opts.bed.z] };
    return [b.min[2], b.max[2]];
  }

  setOverhangThreshold(deg) {
    this._overhangDeg = Math.min(89, Math.max(1, +deg || 0));
    this._overhang = null;
    this._updateLegend();
    return this._changed();
  }

  get overhangThreshold() { return this._overhangDeg; }

  /** Measured overhang for the current mesh at the current threshold. Computed
   *  lazily — it is a full pass over the triangles, so not on every frame. */
  overhang() {
    if (!this._buffers) return null;
    if (!this._overhang) this._overhang = overhangStats(this._buffers, this._overhangDeg);
    return this._overhang;
  }

  setLayerRange(lo, hi) {
    const n = this._gcode ? this._gcode.layerCount : 0;
    if (n <= 0) { this._layerLo = 0; this._progress = 0; return this._changed(); }
    this._layerLo = Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(lo ?? 0)));
    const top = Math.min(n - 1, hi ?? (n - 1));
    this._progress = Math.max(this._layerLo, top) + 1;
    return this._changed();
  }

  get layerCount() { return this._gcode ? this._gcode.layerCount : 0; }
  /** Inclusive layer indices currently drawn, as a UI slider wants them. */
  get layerRange() { return [this._layerLo, Math.max(this._layerLo, Math.ceil(this._progress) - 1)]; }

  /** The continuous build position, in layers. */
  get progress() { return this._progress; }

  setTravels(on) { this._travels = !!on; return this._changed(); }

  /** @param {Record<string, boolean>} vis e.g. {infill:false, support:true} */
  setTypeVisibility(vis) {
    const visible = MOVE_TYPES.filter(t => (t in vis ? vis[t] : (this._typeMask & (1 << MOVE_TYPES.indexOf(t))) !== 0));
    this._typeMask = typeMask(visible);
    return this._changed();
  }

  /** Bottom-up build animation. Resolves when it finishes or is stopped. */
  playBuild({ secondsPerLayer = 0.06, from = 0, loop = false } = {}) {
    if (!this._gcode || !this._gcode.layerCount) return Promise.resolve();
    this.stopBuild();
    return new Promise(resolve => {
      this._anim = { t0: 0, base: from, layer: from, rate: 1 / Math.max(1e-3, secondsPerLayer), loop, resolve };
      this._layerLo = 0;
      this._progress = from;
      this.requestDraw();
    });
  }

  stopBuild() {
    if (this._anim) { const r = this._anim.resolve; this._anim = null; r && r(); }
    return this;
  }

  get playing() { return !!this._anim; }

  fit(opts = {}) {
    const box = this._focusBox();
    this.camera.fitBox(box, this._w, this._h, opts);
    this.camera.setSceneBounds(boxUnion(box, this._plateBox()));
    this._emit('camera', this.camera);
    return this._changed();
  }

  setPreset(name, { fit = true } = {}) {
    if (!PRESETS[name]) {
      throw new Error(`setPreset: unknown preset "${name}" (have ${Object.keys(PRESETS).join(', ')})`);
    }
    this.camera.setPreset(name);
    if (fit) return this.fit();
    this._emit('camera', this.camera);
    return this._changed();
  }

  setProjection(kind) {
    this.camera.projection = kind === 'ortho' ? 'ortho' : 'perspective';
    this._emit('camera', this.camera);
    return this._changed();
  }

  setColor(c) { this.theme.object = c; return this._changed(); }

  setTheme(patch) {
    Object.assign(this.theme, patch || {});
    // The plate and the shadow bake their colours into vertex buffers.
    if (this.plate) this._rebuildPlate();
    this._reuploadShadowColor();
    return this._changed();
  }

  setOptions(patch) {
    const crease = this.opts.crease;
    Object.assign(this.opts, patch || {});
    // `!== undefined`, not truthiness: `setOptions({ grid: 0 })` is a real
    // request — turn the grid off — and testing it for truth silently ignores
    // it, leaving the old grid on the plate.
    if (patch && ['bed', 'grid', 'majorGrid', 'plateTheme'].some(k => patch[k] !== undefined)) {
      this._rebuildPlate();
    }
    // Crease angle is baked into the vertex normals, so changing it means
    // rebuilding the render buffers from the mesh we were handed.
    if (patch && patch.crease !== undefined && patch.crease !== crease && this._sourceMesh) {
      this.setMesh(this._sourceMesh);
    }
    return this._changed();
  }

  _rebuildPlate() {
    this.plate.set({
      size: this.opts.bed.x, grid: this.opts.grid, major: this.opts.majorGrid,
      theme: this.opts.plateTheme,
    });
    // The ground-shadow quad is the plate footprint; a new bed size moves it.
    this.buf.shadowQuad.set(buildShadowQuad(this.opts.bed.x / 2));
    return this;
  }

  /** Where a pointer event lands on the build plate, in millimetres. */
  plateHit(ev) {
    const p = this._localPoint(ev);
    return this.camera.plateHit(p.x, p.y, this._w, this._h, 0);
  }

  /** PNG data URL of the current view. Draws synchronously first so it works
   *  without preserveDrawingBuffer (which costs a full-frame copy every frame). */
  thumbnail({ size = 256, type = 'image/png', quality = 0.92 } = {}) {
    this.render();
    if (!size) return this.canvas.toDataURL(type, quality);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const src = this.canvas;
    const s = Math.min(src.width, src.height);
    ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL(type, quality);
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    const s = this._listeners.get(event);
    if (s) s.delete(fn);
    return this;
  }

  _emit(event, arg) {
    const s = this._listeners.get(event);
    if (!s) return;
    for (const fn of s) {
      try { fn(arg, this); } catch (e) { console.error(`viewer: listener for "${event}" threw`, e); }
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stopBuild();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._unbindEvents();
    if (this._legend && this._legend.parentNode) this._legend.parentNode.removeChild(this._legend);
    const gl = this.gl;
    if (gl) {
      this.plate && this.plate.dispose();
      this.paths && this.paths.dispose();
      for (const k in this.buf) this.buf[k].dispose();
      for (const k in this.vao) gl.deleteVertexArray(this.vao[k]);
      for (const k in this.programs) this.programs[k].dispose();
      if (this._peel) { gl.deleteFramebuffer(this._peel.fbo); gl.deleteTexture(this._peel.tex); }
      // Free the drawing buffer immediately rather than waiting for GC; the
      // UI creates and destroys viewers when the user switches generator.
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    this.gl = null;
    this._listeners.clear();
  }

  // ---- scheduling -------------------------------------------------------
  /** Mark the frame stale and schedule one. Calling it ten times in a row still
   *  costs one frame: the rAF handle is the coalescing point. */
  requestDraw() { this._dirty = true; return this._schedule(); }

  _changed() { return this.requestDraw(); }

  _schedule() {
    if (this._disposed || this._lost || this._raf) return this;
    if (typeof document !== 'undefined' && document.hidden) return this;   // cupboard rule
    this._raf = requestAnimationFrame(this._tick);
    return this;
  }

  /** Draw right now, off the rAF schedule (thumbnails, tests). */
  render() {
    if (this._disposed || this._lost) return this;
    this._resize();
    this._draw();
    return this;
  }

  _tick(now) {
    this._raf = 0;
    if (this._disposed || this._lost) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this._anim) {
      const a = this._anim;
      // t0 is rebased on resume from a hidden tab, so the build does not jump
      // forward by however long the laptop lid was shut.
      if (!a.t0) { a.t0 = now; a.base = a.layer; }
      const layers = this._gcode ? this._gcode.layerCount : 0;
      a.layer = a.base + (now - a.t0) / 1000 * a.rate;
      if (a.layer >= layers) {
        if (a.loop) { a.t0 = now; a.base = 0; a.layer = 0; }
        else { this._progress = layers; this.stopBuild(); }
      }
      if (this._anim) { this._progress = a.layer; this.requestDraw(); }
    }
    this._resize();
    if (this._dirty) this._draw();
  }

  _resize() {
    const canvas = this.canvas;
    const dpr = Math.min(this.opts.maxDpr, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    let cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) {                     // detached, or display:none
      cssW = canvas.width || 1; cssH = canvas.height || 1;
    }
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    this._w = cssW; this._h = cssH;
    this.stats.dpr = dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      this._dirty = true;
    }
  }

  // ---- drawing ----------------------------------------------------------
  _plateBox() {
    const h = this.opts.bed.x / 2;
    return { min: [-h, -h, 0], max: [h, h, 0] };
  }

  _focusBox() {
    if (this._mode === 'gcode' && this._gcode && this._gcode.segmentCount) return this._gcode.bbox;
    if (this._meshBox) return this._meshBox;
    if (this._gcode && this._gcode.segmentCount) return this._gcode.bbox;
    const h = this.opts.bed.x / 2;
    return { min: [-h, -h, 0], max: [h, h, this.opts.bed.z * 0.25] };
  }

  /** Theme colour as linear RGB, memoised on the colour string itself so a
   *  theme change needs no invalidation and a frame allocates nothing. */
  _col(name) {
    const v = this.theme[name];
    let c = this._colCache.get(v);
    if (!c) { c = new Float32Array(toLinear(parseColor(v))); this._colCache.set(v, c); }
    return c;
  }

  _lightRig() {
    const b = this.camera.basis();
    // View-space directions, rotated into world so the rig follows the camera:
    // a key over the left shoulder, a cool fill low on the right, a rim behind.
    const toWorld = (v) => norm3(add3(add3(scale3(b.right, v[0]), scale3(b.up, v[1])), scale3(b.dir, v[2])));
    return {
      key: toWorld([-0.40, 0.62, 0.68]),
      fill: toWorld([0.72, -0.18, 0.32]),
      rim: toWorld([0.10, 0.38, -0.92]),
    };
  }

  _draw() {
    const gl = this.gl;
    if (!gl || this._lost) return;
    const t0 = performance.now();
    this._dirty = false;
    this.stats.calls = 0;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.stencilMask(0xff);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const vp = this.camera.viewProjection(this._w, this._h);
    const eye = this.camera.eye;
    const lights = this._lightRig();

    const backlit = this._mode === 'backlit';
    this._drawBackground(backlit);
    if (this.opts.plate && !backlit) this._drawPlate(vp);

    const showMesh = this._buffers && this._mode !== 'gcode';
    if (showMesh && backlit) {
      this._drawBacklit(vp);
    } else {
      if (showMesh && this.opts.shadows && this._buffers.triCount <= this.opts.shadowTriBudget && this.hasStencil) {
        this._drawShadow(vp);
      }
      if (showMesh) this._drawSolid(vp, eye, lights);
    }
    if (this._mode === 'gcode') this._drawToolpaths(vp, eye, lights);

    this.stats.ms = performance.now() - t0;
    if (this._statsEl) this._updateStats();
    this._emit('render', this.stats);
  }

  _drawBackground(night = false) {
    const gl = this.gl;
    const p = this.programs.bg.use();
    p.set('u_top', this._col(night ? 'nightTop' : 'bgTop'));
    p.set('u_bottom', this._col(night ? 'nightBottom' : 'bgBottom'));
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao.bg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    this.stats.calls++;
  }

  _drawPlate(vp) {
    const gl = this.gl;
    const p = this.programs.line.use();
    p.set('u_viewProj', vp);
    p.set('u_tint', [1, 1, 1, 1]);
    p.set('u_depthBias', 0);
    gl.enable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.plate.draw();
    gl.disable(gl.BLEND);
    this.stats.calls += 2;
  }

  /**
   * Ground shadow: the model flattened onto the plate, stamped into the stencil
   * and then filled once with a single blended quad. Going through the stencil
   * is what stops overlapping triangles from darkening each other into a black
   * blob — the naive version looks like an oil slick.
   */
  _drawShadow(vp) {
    const gl = this.gl;
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const sp = this.programs.shadow.use();
    sp.set('u_viewProj', vp);
    sp.set('u_model', mat4Identity());
    sp.set('u_shadowZ', PLATE_Z.shadow);
    gl.bindVertexArray(this.vao.shadow);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindVertexArray(null);

    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.enable(gl.BLEND);
    const lp = this.programs.line.use();
    lp.set('u_viewProj', vp);
    lp.set('u_tint', [1, 1, 1, 1]);
    lp.set('u_depthBias', 0);
    gl.bindVertexArray(this.vao.shadowQuad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    this.stats.calls += 2;
  }

  /** Depth-only target the size of the drawing buffer. DEPTH_COMPONENT32F is
   *  core WebGL2, so this needs no extension; NEAREST because a depth texture
   *  cannot be filtered and the shader texelFetches it anyway. */
  _ensurePeel() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (this._peel && this._peel.w === w && this._peel.h === h) return this._peel;
    if (this._peel) { gl.deleteFramebuffer(this._peel.fbo); gl.deleteTexture(this._peel.tex); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      throw new Error(`backlit: depth target incomplete (0x${status.toString(16)})`);
    }
    this._peel = { fbo, tex, w, h };
    return this._peel;
  }

  /**
   * Backlit view: two passes, see BACKLIT_FS. Pass 0 keeps the nearest front
   * face per pixel in a depth texture; pass 1 draws back faces into the canvas,
   * discarding every one not behind it, and LESS keeps the nearest survivor.
   * The near wall's thickness along the ray is the distance between the two.
   */
  _drawBacklit(vp) {
    const gl = this.gl;
    const peel = this._ensurePeel();
    const p = this.programs.backlit.use();
    p.set('u_viewProj', vp);
    p.set('u_invViewProj', this.camera.inverseViewProjection(this._w, this._h));
    p.set('u_size', [peel.w, peel.h]);
    p.set('u_clipOn', this._clipOn ? 1 : 0);
    p.set('u_clipZ', this._clipZ);
    p.set('u_mu', BACKLIT_PLA.mu);
    p.set('u_whiteMM', BACKLIT_PLA.whiteMM);
    p.set('u_floor', BACKLIT_PLA.floor);
    p.set('u_lamp', this._col('lamp'));
    gl.bindVertexArray(this.vao.backlit);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, peel.fbo);
    gl.viewport(0, 0, peel.w, peel.h);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.cullFace(gl.BACK);
    p.set('u_pass', 0);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.cullFace(gl.FRONT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, peel.tex);
    p.set('u_front', 0);
    p.set('u_pass', 1);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindVertexArray(null);
    gl.cullFace(gl.BACK);
    gl.disable(gl.CULL_FACE);
    gl.depthFunc(gl.LEQUAL);
    this.stats.calls += 2;
  }

  _solidUniforms(vp, eye, lights, mode) {
    const p = this.programs.solid.use();
    p.set('u_viewProj', vp);
    p.set('u_model', mat4Identity());
    p.set('u_normalMatrix', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    p.set('u_eye', eye);
    p.set('u_keyDir', lights.key);
    p.set('u_fillDir', lights.fill);
    p.set('u_rimDir', lights.rim);
    p.set('u_keyColor', this._col('key'));
    p.set('u_fillColor', this._col('fill'));
    p.set('u_rimColor', this._col('rim'));
    p.set('u_skyColor', this._col('sky'));
    p.set('u_groundColor', this._col('ground'));
    p.set('u_ambient', this.opts.ambient);
    p.set('u_gloss', this.opts.gloss);
    p.set('u_baseColor', this._col(mode === 'ghost' ? 'ghost' : 'object'));
    p.set('u_cutColor', this._col('cut'));
    p.set('u_warnColor', this._col('warn'));
    p.set('u_overColor', this._col('over'));
    p.set('u_mode', mode === 'overhang' ? 1 : (mode === 'cap' ? 2 : 0));
    p.set('u_overhangDeg', this._overhangDeg);
    p.set('u_clipOn', this._clipOn ? 1 : 0);
    p.set('u_clipZ', this._clipZ);
    p.set('u_interior', this._clipOn ? 1 : 0);
    p.set('u_alpha', 1);
    return p;
  }

  _drawSolid(vp, eye, lights) {
    const gl = this.gl;
    const wire = this._mode === 'wire';
    const shade = wire ? 'ghost' : (this._mode === 'overhang' ? 'overhang' : 'solid');

    if (this._clipOn) {
      if (this.hasStencil) this._drawCutCap(vp, eye, lights);
      else this._drawBackfaceCap(vp, eye, lights);
    }

    this._solidUniforms(vp, eye, lights, shade);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // A cut solid must show its interior walls, so back faces stay in and the
    // fragment shader flips their normal and darkens them.
    if (this._clipOn) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
    gl.bindVertexArray(this.vao.mesh);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindVertexArray(null);
    this.stats.calls++;

    if (this._showEdges) this._drawEdges(vp, wire);
    gl.disable(gl.CULL_FACE);
  }

  /**
   * Cross-section cap. Counts front and back faces of the clipped solid into
   * the stencil with no depth test; a pixel whose ray enters the solid through
   * the cut has an unmatched back face and ends up non-zero. Then one quad at
   * the cut plane fills exactly those pixels. Without this the section looks
   * like a hollow shell, which reads as a broken model rather than a slice.
   */
  _drawCutCap(vp, eye, lights) {
    const gl = this.gl;
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.INCR_WRAP);

    this._solidUniforms(vp, eye, lights, 'solid');
    gl.bindVertexArray(this.vao.mesh);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindVertexArray(null);

    if (this._capDirty) this._updateCapQuad();
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    const p = this._solidUniforms(vp, eye, lights, 'cap');
    p.set('u_clipOn', 0);
    p.set('u_interior', 0);
    gl.bindVertexArray(this.vao.cap);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.STENCIL_TEST);
    this.stats.calls += 2;
  }

  /** Fallback for a context that came back without a stencil buffer: paint
   *  every back face in the cut colour first, so the hole the clip plane opens
   *  is filled by the far wall rather than showing the background through it.
   *  Coarser than the stencil cap — concave models cap at the wrong depth — but
   *  an unfilled section reads as a broken model, and this never does. */
  _drawBackfaceCap(vp, eye, lights) {
    const gl = this.gl;
    this._solidUniforms(vp, eye, lights, 'cap');
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.bindVertexArray(this.vao.mesh);
    gl.drawElements(gl.TRIANGLES, this._buffers.indexCount, this._indexType, 0);
    gl.bindVertexArray(null);
    gl.cullFace(gl.BACK);
    this.stats.calls++;
  }

  _updateCapQuad() {
    const b = this._meshBox || this._plateBox();
    const m = 1;                                   // 1 mm of slop round the model
    const z = this._clipZ;
    const x0 = b.min[0] - m, x1 = b.max[0] + m, y0 = b.min[1] - m, y1 = b.max[1] + m;
    this.buf.cap.set(new Float32Array([
      x0, y0, z, x1, y0, z, x1, y1, z,
      x0, y0, z, x1, y1, z, x0, y1, z,
    ]));
    this._capDirty = false;
  }

  _ensureEdges() {
    if (this._edgeIndices || this._edgesTried || !this._buffers) return;
    this._edgesTried = true;
    const idx = buildEdgeIndices(this._buffers.indices, this._buffers.vertCount,
      { budget: this.opts.edgeTriBudget });
    if (!idx) {
      console.warn(`viewer: ${this._buffers.triCount} triangles is past the wireframe budget; edges skipped`);
      return;
    }
    this._edgeIndices = idx;
    const gl = this.gl;
    gl.bindVertexArray(null);
    this.buf.edge.set(idx, idx.length);
    this._edgeIndexType = indexType(gl, idx);
    gl.bindVertexArray(this.vao.edge);
    setAttrib(gl, this.programs.line.attrib('a_position'), this.buf.pos, 3);
    // The wireframe colour is a uniform, so a_color is left as a disabled
    // generic attribute — no per-vertex colour buffer for 1.5M edges.
    const aCol = this.programs.line.attrib('a_color');
    if (aCol >= 0) gl.disableVertexAttribArray(aCol);
    this.buf.edge.bind();
    gl.bindVertexArray(null);
  }

  _drawEdges(vp, wire) {
    this._ensureEdges();
    if (!this._edgeIndices) return;
    const gl = this.gl;
    const c = parseColor(this.theme.wire);
    const p = this.programs.line.use();
    p.set('u_viewProj', vp);
    p.set('u_tint', [c[0], c[1], c[2], wire ? 0.95 : 0.3]);
    // Generic attribute values are context state, not VAO state, so this is set
    // per draw rather than once when the VAO is built.
    const aCol = this.programs.line.attrib('a_color');
    if (aCol >= 0) gl.vertexAttrib4f(aCol, 1, 1, 1, 1);
    // Pull the lines a hair toward the viewer so they sit on the surface rather
    // than stitching through it.
    p.set('u_depthBias', 0.00015);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(this.vao.edge);
    gl.drawElements(gl.LINES, this._edgeIndices.length, this._edgeIndexType, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    p.set('u_depthBias', 0);
    this.stats.calls++;
  }

  _drawToolpaths(vp, eye, lights) {
    if (!this._gcode || !this._gcode.segmentCount) return;
    const gl = this.gl;
    const cam = this.camera;
    const p = this.programs.path.use();
    p.set('u_viewProj', vp);
    p.set('u_eye', eye);
    p.set('u_viewDir', cam.basis().dir);
    p.set('u_ortho', cam.projection === 'ortho' ? 1 : 0);
    // px per mm: at unit distance for perspective, absolute for ortho.
    p.set('u_pxScale', cam.projection === 'ortho'
      ? this._h / Math.max(cam.viewHeight, 1e-6)
      : (this._h / 2) / Math.tan(cam.fov * DEG / 2));
    p.set('u_minPx', this.opts.minToolpathPx);
    p.set('u_widthScale', 1);
    p.set('u_typeMask', this._typeMask);
    // The layer being laid right now is highlighted; at rest that is the top one.
    p.set('u_topLayer', Math.max(0, Math.ceil(this._progress) - 1));
    p.set('u_typeColors', this._typeColors);
    p.set('u_keyDir', lights.key);
    p.set('u_alpha', 1);
    p.set('u_shade', 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    this.paths.drawExtrusions(this._layerLo, this._progress);
    if (this._travels) {
      // Travels are hairlines, unshaded and translucent, and they do not write
      // depth: they are an overlay on the print, not part of it.
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      p.set('u_alpha', 0.5);
      p.set('u_shade', 0);
      p.set('u_widthScale', 0);
      this.paths.drawTravels(this._layerLo, this._progress);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    this.stats.calls += this._travels ? 2 : 1;
  }

  _reuploadShadowColor() {
    if (!this.gl) return;
    const c = parseColor(this.theme.shadow);
    const sc = new Float32Array(24);
    for (let i = 0; i < 6; i++) {
      sc[i * 4] = c[0]; sc[i * 4 + 1] = c[1]; sc[i * 4 + 2] = c[2]; sc[i * 4 + 3] = this.theme.shadowAlpha;
    }
    this.buf.shadowCol.set(sc);
  }

  // ---- input ------------------------------------------------------------
  _bindEvents() {
    const c = this.canvas;
    c.style.touchAction = 'none';               // or the browser eats the gestures
    if (this.opts.keys && !c.hasAttribute('tabindex')) c.tabIndex = 0;

    this._handlers = {
      pointerdown: (e) => this._onDown(e),
      pointermove: (e) => this._onMove(e),
      pointerup: (e) => this._onUp(e),
      pointercancel: (e) => this._onUp(e),
      wheel: (e) => this._onWheel(e),
      contextmenu: (e) => e.preventDefault(),
      dblclick: () => this.fit(),
      keydown: (e) => this._onKey(e),
      webglcontextlost: (e) => { e.preventDefault(); this._lost = true; if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; },
      webglcontextrestored: () => { this._lost = false; this._restore(); },
    };
    // Anything that calls preventDefault MUST be registered non-passive, or the
    // browser ignores the call and logs a warning instead — which is how a
    // viewer ends up scrolling the page while you try to orbit it.
    const active = new Set(['pointerdown', 'wheel', 'contextmenu', 'keydown', 'webglcontextlost']);
    for (const [k, fn] of Object.entries(this._handlers)) {
      c.addEventListener(k, fn, { passive: !active.has(k) });
    }
    this._onVisibility = () => {
      if (document.hidden) {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (this._anim) this._anim.t0 = 0;      // resume without a jump
      } else {
        this.requestDraw();
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.requestDraw());
      this._ro.observe(c);
    } else {
      this._onWinResize = () => this.requestDraw();
      addEventListener('resize', this._onWinResize);
    }
  }

  _unbindEvents() {
    const c = this.canvas;
    if (this._handlers) for (const [k, fn] of Object.entries(this._handlers)) c.removeEventListener(k, fn);
    if (typeof document !== 'undefined' && this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._ro) this._ro.disconnect();
    if (this._onWinResize) removeEventListener('resize', this._onWinResize);
    this._handlers = null;
  }

  _localPoint(e) {
    if (typeof e.offsetX === 'number' && e.target === this.canvas) return { x: e.offsetX, y: e.offsetY };
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX ?? 0) - r.left, y: (e.clientY ?? 0) - r.top };
  }

  _onDown(e) {
    e.preventDefault();
    if (this.opts.keys) this.canvas.focus({ preventScroll: true });
    const p = this._localPoint(e);
    this._pointers.set(e.pointerId, { x: p.x, y: p.y, button: e.button, t: performance.now() });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pen/mouse quirks */ }
    if (this._pointers.size >= 2) this._beginTwoFinger();
    else {
      const pan = e.button === 1 || e.button === 2 || e.shiftKey;
      this._gesture = { mode: pan ? 'pan' : 'orbit', moved: 0 };
    }
  }

  _twoFingerState() {
    const [a, b] = [...this._pointers.values()];
    const dx = b.x - a.x, dy = b.y - a.y;
    return {
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      dist: Math.max(1e-3, Math.hypot(dx, dy)),
      angle: Math.atan2(dy, dx),
    };
  }

  _beginTwoFinger() {
    this._gesture = { mode: 'two', ...this._twoFingerState(), twisted: false };
  }

  _onMove(e) {
    const rec = this._pointers.get(e.pointerId);
    if (!rec) return;
    const p = this._localPoint(e);
    const dx = p.x - rec.x, dy = p.y - rec.y;
    rec.x = p.x; rec.y = p.y;
    const g = this._gesture;
    if (!g) return;

    if (g.mode === 'two' && this._pointers.size >= 2) {
      const s = this._twoFingerState();
      this.camera.pan(s.cx - g.cx, s.cy - g.cy, this._w, this._h);
      if (Math.abs(s.dist - g.dist) > 0.01) {
        this.camera.zoomAt(g.dist / s.dist, s.cx, s.cy, this._w, this._h);
      }
      if (this.opts.twist) {
        let da = s.angle - g.angle;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        // A deadzone, or every two-finger pan comes out slightly tilted.
        if (g.twisted || Math.abs(da) > 0.06) { g.twisted = true; this.camera.rollBy(-da); }
      }
      Object.assign(g, s);
    } else if (g.mode === 'pan') {
      this.camera.pan(dx, dy, this._w, this._h);
    } else if (g.mode === 'orbit') {
      this.camera.orbit(dx, dy);
    }
    g.moved += Math.abs(dx) + Math.abs(dy);
    this._emit('camera', this.camera);
    this._changed();
  }

  _onUp(e) {
    const rec = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (this._pointers.size >= 2) {
      this._beginTwoFinger();          // three fingers down to two: re-baseline
    } else if (this._pointers.size === 1) {
      // Dropped from two fingers to one: re-baseline so the survivor does not
      // yank the model across the screen.
      this._gesture = { mode: 'orbit', moved: 999 };
    } else if (this._pointers.size === 0) {
      const g = this._gesture;
      this._gesture = null;
      if (rec && g && g.moved < 8 && performance.now() - rec.t < 350) {
        const now = performance.now();
        if (now - this._lastTap < 320) { this._lastTap = 0; this.fit(); }
        else this._lastTap = now;
      }
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
    const d = e.deltaY * unit;
    const p = this._localPoint(e);
    // Exponential so the feel is the same at every scale, clamped so a coarse
    // wheel (or a trackpad flick) cannot teleport the camera.
    this.camera.zoomAt(Math.exp(Math.max(-2, Math.min(2, d * 0.0016))), p.x, p.y, this._w, this._h);
    this._emit('camera', this.camera);
    this._changed();
  }

  _onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || typeof e.key !== 'string') return;
    const presets = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'iso', 7: 'bottom' };
    const k = e.key.toLowerCase();
    if (presets[k]) { this.setPreset(presets[k]); }
    else if (k === 'f') this.fit();
    else if (k === 'w') this.setMode(this._mode === 'wire' ? 'solid' : 'wire');
    else if (k === 'o') this.setMode(this._mode === 'overhang' ? 'solid' : 'overhang');
    else if (k === 'b') this.setMode(this._mode === 'backlit' ? 'solid' : 'backlit');
    else if (k === 's') this.setMode('solid');
    else if (k === 'r') { this.camera.roll = 0; this._changed(); }
    else if (k === 'escape') this.stopBuild();
    else return;
    e.preventDefault();
  }

  // ---- legend -----------------------------------------------------------
  /** The legend is a small DOM overlay the viewer owns, so the UI leaf does not
   *  have to know the overhang ramp or the move-type palette. Styled inline —
   *  it must not depend on a stylesheet another leaf owns. */
  _makeLegend() {
    if (!this.opts.legend || typeof document === 'undefined') return;
    const host = this.opts.legendContainer || this.canvas.parentElement;
    if (!host) return;
    if (host !== document.body && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';        // documented: we anchor to it
    }
    const base = [
      'position:absolute', 'pointer-events:none',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#dfe6ef', 'background:rgba(12,16,22,.72)', 'padding:8px 10px',
      'border:1px solid rgba(255,255,255,.10)', 'border-radius:8px',
      'backdrop-filter:blur(6px)', 'max-width:44%', 'z-index:3',
    ].join(';');
    const el = document.createElement('div');
    el.className = 'bluesheet-viewer-legend';
    el.style.cssText = `${base};right:10px;bottom:10px;display:none`;
    this._legend = el;
    host.appendChild(el);
    if (this.opts.stats) {
      const s = document.createElement('div');
      s.className = 'bluesheet-viewer-stats';
      s.style.cssText = `${base};left:10px;top:10px;display:block`;
      this._statsEl = s;
      host.appendChild(s);
    }
    this._updateLegend();
  }

  _updateLegend() {
    const el = this._legend;
    if (!el) return;
    if (this._mode === 'overhang') {
      const o = this.overhang();
      const t = this._overhangDeg;
      el.style.display = 'block';
      el.innerHTML =
        `<div style="margin-bottom:5px">overhang &gt; ${t}&deg;</div>` +
        `<div style="height:8px;border-radius:4px;background:linear-gradient(90deg,${this.theme.object},${this.theme.warn} 45%,${this.theme.over})"></div>` +
        `<div style="display:flex;justify-content:space-between;opacity:.75"><span>0&deg;</span><span>${t}&deg;</span><span>90&deg;</span></div>` +
        (o ? `<div style="margin-top:4px;opacity:.9">${o.overhangPct.toFixed(1)}% of area · worst ${o.worstDeg.toFixed(0)}&deg;</div>` : '');
    } else if (this._mode === 'backlit') {
      const { mu, whiteMM } = BACKLIT_PLA;
      const at = (t) => Math.min(1, Math.exp(-mu * (t - whiteMM)));
      el.style.display = 'block';
      el.innerHTML =
        `<div style="margin-bottom:5px">backlit · white PLA, &mu; ${mu}/mm</div>` +
        `<div style="height:8px;border-radius:4px;background:linear-gradient(90deg,${this.theme.lamp},#000)"></div>` +
        `<div style="display:flex;justify-content:space-between;opacity:.75"><span>${whiteMM} mm</span><span>${(whiteMM + 1).toFixed(1)} mm ${Math.round(at(whiteMM + 1) * 100)}%</span><span>3 mm ${Math.round(at(3) * 100)}%</span></div>` +
        `<div style="margin-top:4px;opacity:.9">near wall only, along the view ray</div>`;
    } else if (this._mode === 'gcode' && this._gcode) {
      const counts = this._gcode.typeCounts || {};
      const rows = MOVE_TYPES.filter(t => counts[t]).map(t =>
        `<div style="display:flex;gap:6px;align-items:center">` +
        `<i style="width:10px;height:10px;border-radius:2px;background:${MOVE_COLORS[t]};display:inline-block"></i>` +
        `<span>${MOVE_LABELS[t]}</span></div>`).join('');
      el.style.display = rows ? 'block' : 'none';
      el.innerHTML = rows +
        `<div style="margin-top:5px;opacity:.7">${this._gcode.layerCount} layers · ${fmtCount(this._gcode.segmentCount)} moves</div>`;
    } else {
      el.style.display = 'none';
      el.innerHTML = '';
    }
  }

  _updateStats() {
    const s = this.stats;
    this._statsEl.textContent =
      `${fmtCount(s.tris)} tris · ${s.calls} calls · ${s.ms.toFixed(1)} ms · ${this._w}x${this._h}@${s.dpr}`;
  }
}

function fmtCount(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
}

export default Viewer;
