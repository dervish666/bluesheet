/**
 * glutil.js — the thin layer between the viewer and WebGL2. No DOM at module
 * scope; everything takes a `gl` it was handed.
 *
 * The point of Program is that uniform locations are looked up once, by
 * introspection, and set through one type-dispatching call. Hand-written
 * `gl.uniform3fv(gl.getUniformLocation(...))` lines are where renderers rot:
 * rename a uniform and you get a silent no-op, not an error.
 */

export class Program {
  constructor(gl, vsSource, fsSource, name = 'program') {
    this.gl = gl;
    this.name = name;
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, `${name}.vs`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, `${name}.fs`);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // Shaders can be detached and deleted immediately after a successful link;
    // holding them costs driver memory for nothing.
    gl.detachShader(p, vs);
    gl.detachShader(p, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`${name}: link failed — ${log}`);
    }
    this.program = p;
    this.uniforms = new Map();
    this.attribs = new Map();
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const base = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(base, { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size });
    }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(p, i);
      if (!info) continue;
      this.attribs.set(info.name, gl.getAttribLocation(p, info.name));
    }
  }

  use() { this.gl.useProgram(this.program); return this; }

  attrib(name) {
    const a = this.attribs.get(name);
    return a === undefined ? -1 : a;
  }

  /** Set a uniform by name, dispatching on its declared GLSL type. Unknown
   *  names are ignored on purpose — a shader branch may have optimised the
   *  uniform away, and throwing there would break perfectly good frames. */
  set(name, value) {
    const u = this.uniforms.get(name);
    if (!u) return this;
    const gl = this.gl, loc = u.loc;
    switch (u.type) {
      case gl.FLOAT: gl.uniform1f(loc, value); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, value); break;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_CUBE:
        gl.uniform1i(loc, value); break;
      case gl.INT_VEC2: gl.uniform2iv(loc, value); break;
      case gl.INT_VEC3: gl.uniform3iv(loc, value); break;
      case gl.INT_VEC4: gl.uniform4iv(loc, value); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, value); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, value); break;
      default: gl.uniform1f(loc, value); break;
    }
    return this;
  }

  setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }

  dispose() { if (this.program) { this.gl.deleteProgram(this.program); this.program = null; } }
}

export function compileShader(gl, type, source, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || '';
    gl.deleteShader(s);
    // Line numbers in the driver log are 1-based against the source we handed
    // it, so quoting the offending line saves a lot of squinting.
    const line = /ERROR:\s*\d+:(\d+)/.exec(log);
    const ctx = line ? `\n  > ${source.split('\n')[+line[1] - 1] || ''}` : '';
    throw new Error(`${name}: compile failed — ${log.trim()}${ctx}`);
  }
  return s;
}

/**
 * A GL buffer that is created once and refilled in place. Re-uploading into the
 * same buffer object (rather than deleting and recreating) is what keeps a
 * 500k-triangle rebuild from thrashing the driver's allocator.
 */
export class GLBuffer {
  constructor(gl, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
    this.gl = gl;
    this.target = target;
    this.usage = usage;
    this.buffer = gl.createBuffer();
    this.byteLength = 0;
    this.count = 0;
  }

  /** Upload data. Reuses the allocation when the new data is the same size or
   *  smaller, which is the common case while a slider is being dragged. */
  set(data, count = data.length) {
    const gl = this.gl;
    gl.bindBuffer(this.target, this.buffer);
    if (data.byteLength <= this.byteLength && this.byteLength > 0) {
      gl.bufferSubData(this.target, 0, data);
    } else {
      gl.bufferData(this.target, data, this.usage);
      this.byteLength = data.byteLength;
    }
    this.count = count;
    return this;
  }

  bind() { this.gl.bindBuffer(this.target, this.buffer); return this; }

  dispose() { if (this.buffer) { this.gl.deleteBuffer(this.buffer); this.buffer = null; this.byteLength = 0; } }
}

/** vertexAttribPointer + enable, with the divisor for instanced attributes.
 *  Must be called with the target VAO bound. */
export function setAttrib(gl, loc, buffer, size, { stride = 0, offset = 0, divisor = 0, type = gl.FLOAT, normalized = false } = {}) {
  if (loc < 0) return;
  buffer.bind();
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
  gl.vertexAttribDivisor(loc, divisor);
}

/** Index type constant for an index array — getting this wrong on a mesh that
 *  just crossed 65535 vertices draws convincing garbage. */
export function indexType(gl, indices) {
  return indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
}

/** Throws with the readable name of the current GL error. Debug builds only —
 *  it forces a pipeline flush. */
export function assertNoError(gl, where = '') {
  const e = gl.getError();
  if (e === gl.NO_ERROR) return;
  const names = {
    [gl.INVALID_ENUM]: 'INVALID_ENUM', [gl.INVALID_VALUE]: 'INVALID_VALUE',
    [gl.INVALID_OPERATION]: 'INVALID_OPERATION', [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
    [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
    [gl.CONTEXT_LOST_WEBGL]: 'CONTEXT_LOST_WEBGL',
  };
  throw new Error(`GL error ${names[e] || e}${where ? ' at ' + where : ''}`);
}
