/**
 * camera.js — every number the viewer needs, before it touches a canvas.
 *
 * Conventions, all three of which bite if you get them wrong:
 *
 *  - Matrices are column-major 4x4 in WebGL order (m[12..14] is the
 *    translation), the same convention as js/kernel/mesh.js, so a matrix can
 *    cross that boundary without transposing.
 *  - World is millimetres, Z up — the same space the generators build in, so a
 *    click on the plate is a millimetre coordinate with no conversion.
 *  - Screen coordinates are CSS pixels with y pointing DOWN, because that is
 *    what pointer events hand us. NDC has y up. The flip happens in exactly two
 *    places, project() and screenRay(), and nowhere else.
 *
 * The camera is a turntable, not a free arcball: azimuth about world Z,
 * elevation from the XY plane, plus an explicit roll driven by the two-finger
 * twist gesture. A print previewer whose build plate can end up upside-down is
 * one nobody can navigate — every slicer on earth has reached the same
 * conclusion. Roll is kept as a separate term so the gesture is reversible
 * (setRoll(0) is always exactly level again), which a quaternion arcball cannot
 * promise after a few hundred drags of accumulated float error.
 *
 * The basis is built analytically instead of via lookAt() so elevation ±90°
 * (the top and bottom presets) is an exact, non-degenerate orientation rather
 * than a cross product of two parallel vectors.
 *
 * Pure: no DOM, no GL, no imports. Everything here is unit-tested headlessly in
 * tests/render-math.test.mjs.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---- vec3 ---------------------------------------------------------------
export function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len3(a) { return Math.hypot(a[0], a[1], a[2]); }
export function norm3(a) { const l = len3(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
export function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// ---- mat4 ---------------------------------------------------------------
export function mat4Identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

/** a * b — b is applied to the vector first. */
export function mat4Multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  return o;
}

export function mat4Transpose(m) {
  return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13],
          m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
}

/** Full 4x4 inverse; null when singular (callers must handle it — a degenerate
 *  viewport or a zero-size canvas gets here more often than you would think). */
export function mat4Invert(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !isFinite(det)) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** Right-handed perspective. far === Infinity gives the infinite-far variant. */
export function perspective(fovyDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovyDeg * DEG / 2);
  const m = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -2 * near, 0];
  if (far !== Infinity && isFinite(far)) {
    const nf = 1 / (near - far);
    m[10] = (far + near) * nf;
    m[14] = 2 * far * near * nf;
  }
  return m;
}

export function orthographic(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
  return [-2 * lr, 0, 0, 0, 0, -2 * bt, 0, 0, 0, 0, 2 * nf, 0,
          (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1];
}

/** World -> camera. Degenerate when eye-target is parallel to up; the Camera
 *  class does not use it for that reason, but generators of light rigs do. */
export function lookAt(eye, target, up = [0, 0, 1]) {
  const z = norm3(sub3(eye, target));
  let x = cross3(up, z);
  if (len3(x) < 1e-9) x = cross3(Math.abs(z[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], z);
  x = norm3(x);
  const y = cross3(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
          -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1];
}

/** Point through a matrix with the perspective divide. */
export function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1;
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
          (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
          (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw];
}

/** Point through a matrix keeping w — needed to tell "behind the eye" from
 *  "far away", which the divide throws away. */
export function transformPoint4(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
          m[3] * x + m[7] * y + m[11] * z + m[15]];
}

/** Direction through a matrix (translation ignored, no divide). */
export function transformDir(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [m[0] * x + m[4] * y + m[8] * z,
          m[1] * x + m[5] * y + m[9] * z,
          m[2] * x + m[6] * y + m[10] * z];
}

/** Upper-left 3x3 of inverse-transpose, for normals under a non-uniform model
 *  matrix. Bluesheet only ever uses identity model matrices, but the shader takes
 *  it and a wrong normal matrix is a silent shading bug, so it is exact. */
export function normalMatrix(m) {
  const inv = mat4Invert(m);
  if (!inv) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]];
}

// ---- rays ---------------------------------------------------------------
/** Ray vs the horizontal plane z = planeZ. null when parallel or behind. */
export function rayPlaneZ(ray, planeZ = 0) {
  const dz = ray.direction[2];
  if (Math.abs(dz) < 1e-9) return null;
  const t = (planeZ - ray.origin[2]) / dz;
  if (t < 0) return null;
  return add3(ray.origin, scale3(ray.direction, t));
}

/** Slab test. Returns {tmin, tmax} (tmin may be negative if the origin is
 *  inside) or null. Used to cheaply reject clicks that miss the model. */
export function rayAABB(ray, box) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = ray.direction[i], o = ray.origin[i];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[i] || o > box.max[i]) return null;
      continue;
    }
    const inv = 1 / d;
    let t0 = (box.min[i] - o) * inv, t1 = (box.max[i] - o) * inv;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  return { tmin, tmax };
}

/** Half-extent of an axis-aligned box measured along an arbitrary unit axis —
 *  the support function. This is what makes fit() exact instead of a guess
 *  based on the bounding sphere, which wastes a third of the viewport. */
export function boxExtentAlong(box, axis) {
  const sx = (box.max[0] - box.min[0]) / 2;
  const sy = (box.max[1] - box.min[1]) / 2;
  const sz = (box.max[2] - box.min[2]) / 2;
  return Math.abs(sx * axis[0]) + Math.abs(sy * axis[1]) + Math.abs(sz * axis[2]);
}

export function boxCenter(box) {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

export function boxRadius(box) {
  return 0.5 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
}

// ---- presets ------------------------------------------------------------
// Azimuth is measured from +X about +Z; elevation from the XY plane. The eye
// sits at target + distance * [cos(el)cos(az), cos(el)sin(az), sin(el)].
export const PRESETS = {
  front:   { azimuth: -90 * DEG, elevation: 0 },
  back:    { azimuth: 90 * DEG, elevation: 0 },
  right:   { azimuth: 0, elevation: 0 },
  left:    { azimuth: 180 * DEG, elevation: 0 },
  top:     { azimuth: -90 * DEG, elevation: 90 * DEG },
  bottom:  { azimuth: -90 * DEG, elevation: -90 * DEG },
  iso:     { azimuth: -60 * DEG, elevation: 28 * DEG },
  isoLeft: { azimuth: -120 * DEG, elevation: 28 * DEG },
};

export const PRESET_NAMES = Object.keys(PRESETS);

const MAX_EL = Math.PI / 2;

export class Camera {
  constructor(opts = {}) {
    this.target = (opts.target || [0, 0, 20]).slice();
    this.distance = opts.distance ?? 320;
    this.azimuth = opts.azimuth ?? PRESETS.iso.azimuth;
    this.elevation = opts.elevation ?? PRESETS.iso.elevation;
    this.roll = opts.roll ?? 0;
    this.fov = opts.fov ?? 40;                 // vertical, degrees
    this.projection = opts.projection || 'perspective';
    this.minDistance = opts.minDistance ?? 0.5;
    this.maxDistance = opts.maxDistance ?? 20000;
    // Drives near/far. Too small clips the model; too large wastes depth
    // precision and the plate grid starts to shimmer against the object.
    this.sceneRadius = opts.sceneRadius ?? 160;
    this.orbitSpeed = opts.orbitSpeed ?? 0.0075;   // radians per pixel
    this._cacheKey = '';
    this._cache = null;
  }

  clone() { const c = new Camera(); c.setState(this.getState()); return c; }

  getState() {
    return {
      target: this.target.slice(), distance: this.distance, azimuth: this.azimuth,
      elevation: this.elevation, roll: this.roll, fov: this.fov,
      projection: this.projection, sceneRadius: this.sceneRadius,
    };
  }

  setState(s = {}) {
    if (s.target) this.target = s.target.slice();
    if (Number.isFinite(s.distance)) this.distance = clamp(s.distance, this.minDistance, this.maxDistance);
    if (Number.isFinite(s.azimuth)) this.azimuth = s.azimuth;
    if (Number.isFinite(s.elevation)) this.elevation = clamp(s.elevation, -MAX_EL, MAX_EL);
    if (Number.isFinite(s.roll)) this.roll = s.roll;
    if (Number.isFinite(s.fov)) this.fov = clamp(s.fov, 5, 120);
    if (s.projection) this.projection = s.projection;
    if (Number.isFinite(s.sceneRadius)) this.sceneRadius = Math.max(1e-3, s.sceneRadius);
    return this;
  }

  /** Height of the view frustum at the target plane, in mm. Ortho reuses it so
   *  that flipping projection keeps the framing identical — a switch that
   *  changes the zoom level feels broken. */
  get viewHeight() { return 2 * this.distance * Math.tan(this.fov * DEG / 2); }

  /** {right, up, forward, eye} — orthonormal, exact at the poles. */
  basis() {
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const dir = [ce * ca, ce * sa, se];                 // target -> eye
    let right = [-sa, ca, 0];                           // never degenerate
    let up = [-se * ca, -se * sa, ce];
    if (this.roll) {
      const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
      const r2 = [right[0] * cr + up[0] * sr, right[1] * cr + up[1] * sr, right[2] * cr + up[2] * sr];
      const u2 = [up[0] * cr - right[0] * sr, up[1] * cr - right[1] * sr, up[2] * cr - right[2] * sr];
      right = r2; up = u2;
    }
    return {
      right, up, forward: [-dir[0], -dir[1], -dir[2]], dir,
      eye: add3(this.target, scale3(dir, this.distance)),
    };
  }

  get eye() { return this.basis().eye; }

  /** near/far chosen from the scene radius. Kept as tight as is safe: the plate
   *  grid sits 0.3 mm under the model and a sloppy near plane makes it flicker. */
  nearFar() {
    const r = Math.max(this.sceneRadius, 1e-3);
    if (this.projection === 'ortho') {
      const span = this.distance + r * 2 + 10;
      return [-span, span];
    }
    const far = this.distance + r * 3 + 10;
    // Keep the ratio under ~1e5 or 24-bit depth starts to band on the plate.
    const near = Math.max(this.distance - r * 1.5, this.distance * 0.005, far / 1e5, 0.02);
    return [near, far];
  }

  viewMatrix() {
    const b = this.basis();
    const z = b.dir, x = b.right, y = b.up, e = b.eye;
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -dot3(x, e), -dot3(y, e), -dot3(z, e), 1];
  }

  projectionMatrix(w, h) {
    const aspect = (w > 0 && h > 0) ? w / h : 1;
    const [near, far] = this.nearFar();
    if (this.projection === 'ortho') {
      const hh = this.viewHeight / 2, hw = hh * aspect;
      return orthographic(-hw, hw, -hh, hh, near, far);
    }
    return perspective(this.fov, aspect, near, far);
  }

  /** Cached because the viewer asks for this and its inverse several times per
   *  frame and the pointer handler asks again per move event. Keyed on the
   *  actual state so a caller poking `cam.distance = 5` directly cannot get a
   *  stale matrix back. */
  viewProjection(w, h) {
    const key = `${this.target[0]},${this.target[1]},${this.target[2]},${this.distance},${this.azimuth},${this.elevation},${this.roll},${this.fov},${this.projection},${this.sceneRadius},${w},${h}`;
    if (key === this._cacheKey && this._cache) return this._cache.vp;
    const view = this.viewMatrix();
    const proj = this.projectionMatrix(w, h);
    const vp = mat4Multiply(proj, view);
    this._cacheKey = key;
    this._cache = { view, proj, vp, inv: mat4Invert(vp) };
    return vp;
  }

  inverseViewProjection(w, h) {
    this.viewProjection(w, h);
    return this._cache.inv;
  }

  // ---- interaction ------------------------------------------------------
  /** Drag deltas in CSS pixels, y down. The model follows the finger: drag
   *  right and the object turns right, drag down and its top tips toward you. */
  orbit(dxPx, dyPx, speed = this.orbitSpeed) {
    this.azimuth -= dxPx * speed;
    this.elevation = clamp(this.elevation + dyPx * speed, -MAX_EL, MAX_EL);
    // Keep azimuth in (-2pi, 2pi) so the cache key and any UI readout stay
    // small after ten minutes of spinning.
    if (Math.abs(this.azimuth) > Math.PI * 2) this.azimuth %= Math.PI * 2;
    return this;
  }

  orbitTo(azimuth, elevation, roll = this.roll) {
    this.azimuth = azimuth;
    this.elevation = clamp(elevation, -MAX_EL, MAX_EL);
    this.roll = roll;
    return this;
  }

  /** Positive roll turns the model clockwise on screen. */
  rollBy(radians) { this.roll += radians; return this; }

  /** Screen-space pan at the target's depth: the point under the finger stays
   *  under the finger, which is the only pan that feels right on a touchscreen. */
  pan(dxPx, dyPx, w, h) {
    if (!(h > 0)) return this;
    const perPixel = this.viewHeight / h;
    const b = this.basis();
    this.target = add3(this.target,
      add3(scale3(b.right, -dxPx * perPixel), scale3(b.up, dyPx * perPixel)));
    return this;
  }

  /** factor < 1 moves closer. */
  zoom(factor) {
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
    return this;
  }

  /**
   * Zoom toward a screen point. Scaling the whole camera about the world point
   * under the cursor keeps that point pinned: eye' = p + s(eye - p) leaves the
   * eye->p direction unchanged, so p projects to the same pixel, and it works
   * unmodified in ortho because there the screen offset is (p - target)·right
   * over the view height and both halves scale by s.
   */
  zoomAt(factor, x, y, w, h) {
    // The pivot must be found with the camera as it is NOW: the near plane, and
    // therefore the ray origin, moves with the distance.
    const ray = this.screenRay(x, y, w, h);
    if (!ray) return this.zoom(factor);
    const fwd = this.basis().forward;
    const denom = dot3(ray.direction, fwd);
    if (Math.abs(denom) < 1e-6) return this.zoom(factor);
    const t = dot3(sub3(this.target, ray.origin), fwd) / denom;
    const pivot = add3(ray.origin, scale3(ray.direction, t));

    const d0 = this.distance;
    this.zoom(factor);
    const s = this.distance / d0;
    if (s === 1) return this;
    this.target = add3(pivot, scale3(sub3(this.target, pivot), s));
    return this;
  }

  // ---- projection helpers ----------------------------------------------
  /** World -> {x, y} in CSS pixels (y down), plus ndc depth and a behind flag. */
  project(p, w, h) {
    const c = transformPoint4(this.viewProjection(w, h), p);
    const behind = c[3] <= 1e-9;
    const iw = Math.abs(c[3]) > 1e-12 ? 1 / c[3] : 0;
    return {
      x: (c[0] * iw * 0.5 + 0.5) * w,
      y: (0.5 - c[1] * iw * 0.5) * h,
      depth: c[2] * iw,
      behind,
    };
  }

  /** Screen pixel + ndc depth -> world point. */
  unproject(x, y, ndcZ, w, h) {
    const inv = this.inverseViewProjection(w, h);
    if (!inv) return null;
    return transformPoint(inv, [(x / w) * 2 - 1, 1 - (y / h) * 2, ndcZ]);
  }

  /** {origin, direction} through a screen pixel. In ortho the origin moves and
   *  the direction is constant; in perspective the reverse. */
  screenRay(x, y, w, h) {
    const inv = this.inverseViewProjection(w, h);
    if (!inv) return null;
    const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
    const a = transformPoint(inv, [nx, ny, -1]);
    const b = transformPoint(inv, [nx, ny, 1]);
    const d = norm3(sub3(b, a));
    if (!d[0] && !d[1] && !d[2]) return null;
    return { origin: a, direction: d };
  }

  /** Where a screen pixel lands on the build plate, or null if it misses. */
  plateHit(x, y, w, h, planeZ = 0) {
    const ray = this.screenRay(x, y, w, h);
    return ray ? rayPlaneZ(ray, planeZ) : null;
  }

  // ---- framing ----------------------------------------------------------
  setSceneBounds(box) {
    if (!box) return this;
    this.sceneRadius = Math.max(boxRadius(box), 1);
    return this;
  }

  /**
   * Frame a box exactly. Measures the box along the camera's own right/up/
   * forward axes rather than using its bounding sphere, so a long flat part
   * seen from the top fills the viewport instead of floating in a third of it.
   */
  fitBox(box, w, h, opts = {}) {
    const margin = opts.margin ?? 1.15;
    const aspect = (w > 0 && h > 0) ? w / h : 1;
    const b = this.basis();
    const ex = boxExtentAlong(box, b.right);
    const ey = boxExtentAlong(box, b.up);
    const ez = boxExtentAlong(box, b.dir);
    const r = boxRadius(box);
    this.target = boxCenter(box);
    this.sceneRadius = Math.max(r, 1);
    // A zero-size box (an empty scene, a single point) must not divide by zero
    // or leave the camera inside the near plane.
    const halfH = Math.max(ey, ex / Math.max(aspect, 1e-6), 1e-3) * margin;
    const tan = Math.tan(this.fov * DEG / 2);
    let d = halfH / tan;
    if (this.projection === 'perspective') d += ez;
    this.distance = clamp(d, this.minDistance, this.maxDistance);
    return this;
  }

  /** Named view. Passing a box refits after turning, which is what the UI
   *  buttons want — a preset that leaves the object off-screen is useless. */
  setPreset(name, box = null, w = 1, h = 1, opts = {}) {
    const p = PRESETS[name];
    if (!p) throw new Error(`camera: unknown preset "${name}" (have ${PRESET_NAMES.join(', ')})`);
    this.azimuth = p.azimuth;
    this.elevation = p.elevation;
    this.roll = 0;
    if (box) this.fitBox(box, w, h, opts);
    return this;
  }
}

export default Camera;
