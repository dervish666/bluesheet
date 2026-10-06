/**
 * shaders.js — GLSL ES 3.00 sources for the viewer. Strings only; nothing here
 * touches a GL context, so the module imports in Node.
 *
 * `#version 300 es` must be the very first characters of a shader, before any
 * whitespace, which is why every source below starts hard against the backtick.
 *
 * Six programs:
 *   BACKGROUND  attribute-less full-screen triangle (gradient + vignette)
 *   SOLID       the model: lit shading, overhang colouring, Z clip, cut cap
 *   BACKLIT     the model as transmitted light, thickness from a depth peel
 *   LINE        plate grid, bed outline, axes, wireframe — per-vertex colour
 *   SHADOW      the model flattened onto the plate, stencil-only
 *   TOOLPATH    instanced G-code ribbons, expanded around the segment axis
 */

// Shared lighting. Three directional lights supplied in WORLD space but derived
// each frame from the camera basis, so the key light stays over the viewer's
// shoulder however the model is turned — a model that goes black when you orbit
// behind it is unreadable. A hemisphere term keyed to world Z on top of that
// gives the "sitting under a workshop light" cue that sells scale.
const LIGHTING = `
uniform vec3 u_eye;
uniform vec3 u_keyDir;
uniform vec3 u_fillDir;
uniform vec3 u_rimDir;
uniform vec3 u_keyColor;
uniform vec3 u_fillColor;
uniform vec3 u_rimColor;
uniform vec3 u_skyColor;
uniform vec3 u_groundColor;
uniform float u_ambient;
uniform float u_gloss;

vec3 shade(vec3 n, vec3 albedo, vec3 world) {
  vec3 v = normalize(u_eye - world);
  float ndl = max(dot(n, u_keyDir), 0.0);
  float ndf = max(dot(n, u_fillDir), 0.0);
  float ndr = max(dot(n, u_rimDir), 0.0);
  // Wrapped diffuse on the fill: a hard terminator on the shadow side makes a
  // printed part look like a cutout, a slightly wrapped one keeps the form.
  ndf = ndf * 0.7 + 0.3 * max(dot(n, u_fillDir) * 0.5 + 0.5, 0.0);
  vec3 hemi = mix(u_groundColor, u_skyColor, n.z * 0.5 + 0.5) * u_ambient;
  vec3 diffuse = u_keyColor * ndl + u_fillColor * ndf * 0.45;
  vec3 h = normalize(u_keyDir + v);
  float spec = pow(max(dot(n, h), 0.0), mix(8.0, 96.0, u_gloss)) * u_gloss;
  // Rim from behind, gated on facing away from the viewer so it reads as an
  // edge highlight rather than a wash over the whole silhouette.
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 rim = u_rimColor * ndr * fres * 1.6;
  return albedo * (hemi + diffuse) + spec * mix(vec3(1.0), albedo, 0.25) + rim;
}

// Overhang angle in the printer's convention: a vertical wall is 0 degrees, a
// horizontal ceiling is 90. Keep in step with overhangDegrees() in geometry.js.
float overhangDeg(vec3 n) {
  return degrees(asin(clamp(-n.z, 0.0, 1.0)));
}
`;

const TONEMAP = `
// Filmic-ish shoulder. Without it the specular on a light filament colour
// clips to flat white and the highlight loses its shape.
vec3 tonemap(vec3 c) {
  c = max(c, vec3(0.0));
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}
`;

export const BACKGROUND_VS = `#version 300 es
out vec2 v_uv;
void main() {
  // Attribute-less full-screen triangle; z sits at the far plane so it never
  // occludes anything and needs no depth write.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

export const BACKGROUND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_top;
uniform vec3 u_bottom;
out vec4 fragColor;
void main() {
  vec3 c = mix(u_bottom, u_top, smoothstep(0.0, 1.0, v_uv.y));
  vec2 d = v_uv - 0.5;
  c *= 1.0 - 0.35 * dot(d, d);            // vignette, keeps the eye centred
  // Ordered dither: 8-bit gradients over a large canvas band visibly.
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(c + (dither - 0.5) / 255.0, 1.0);
}`;

export const SOLID_VS = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform mat3 u_normalMatrix;
out vec3 v_world;
out vec3 v_normal;
void main() {
  vec4 wp = u_model * vec4(a_position, 1.0);
  v_world = wp.xyz;
  v_normal = u_normalMatrix * a_normal;
  gl_Position = u_viewProj * wp;
}`;

export const SOLID_FS = `#version 300 es
precision highp float;
in vec3 v_world;
in vec3 v_normal;
${LIGHTING}
${TONEMAP}
uniform vec3 u_baseColor;
uniform vec3 u_cutColor;
uniform vec3 u_warnColor;
uniform vec3 u_overColor;
uniform int u_mode;            // 0 = solid, 1 = overhang, 2 = flat cut cap
uniform float u_overhangDeg;
uniform int u_clipOn;
uniform float u_clipZ;
uniform float u_interior;      // how much to darken back faces in a cut view
uniform float u_alpha;
out vec4 fragColor;

void main() {
  // The clip is a half-space on Z. Doing it with discard rather than a hardware
  // clip plane keeps one code path for the stencil cap pass, which has to see
  // exactly the same cut.
  if (u_clipOn == 1 && v_world.z > u_clipZ) discard;

  vec3 n = normalize(v_normal);
  float facing = gl_FrontFacing ? 1.0 : -1.0;
  n *= facing;                                  // interior walls of a cut solid

  vec3 albedo = u_baseColor;
  if (u_mode == 1) {
    float d = overhangDeg(n * facing);          // judge the outward normal
    float thr = u_overhangDeg;
    if (d >= thr) {
      albedo = mix(u_warnColor, u_overColor, clamp((d - thr) / max(90.0 - thr, 1.0), 0.0, 1.0));
    } else {
      // A 12 degree run-up warns before the threshold; a hard band edge reads
      // as a modelling feature instead of a measurement.
      albedo = mix(u_baseColor, u_warnColor, clamp((d - (thr - 12.0)) / 12.0, 0.0, 1.0) * 0.65);
    }
  } else if (u_mode == 2) {
    albedo = u_cutColor;
  }
  if (facing < 0.0) albedo = mix(albedo, albedo * 0.45, u_interior);

  vec3 c = shade(n, albedo, v_world);
  // Fade the last hair before the cut plane so the cap does not z-fight the
  // wall it caps at grazing angles.
  fragColor = vec4(tonemap(c), u_alpha);
}`;

export const LINE_VS = `#version 300 es
in vec3 a_position;
in vec4 a_color;
uniform mat4 u_viewProj;
uniform vec4 u_tint;
uniform float u_depthBias;     // NDC units toward the viewer
out vec4 v_color;
void main() {
  v_color = a_color * u_tint;
  vec4 p = u_viewProj * vec4(a_position, 1.0);
  p.z -= u_depthBias * p.w;
  gl_Position = p;
}`;

export const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  if (v_color.a < 0.004) discard;
  fragColor = vec4(v_color.rgb * v_color.a, v_color.a);   // premultiplied
}`;

export const SHADOW_VS = `#version 300 es
in vec3 a_position;
uniform mat4 u_viewProj;
uniform mat4 u_model;
uniform float u_shadowZ;
void main() {
  vec4 wp = u_model * vec4(a_position, 1.0);
  gl_Position = u_viewProj * vec4(wp.xy, u_shadowZ, 1.0);
}`;

export const SHADOW_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`;

export const TOOLPATH_VS = `#version 300 es
in vec2 a_corner;        // x: 0..1 along the segment, y: -1..1 across it
in vec3 a_start;
in vec3 a_end;
in vec3 a_meta;          // type index, layer index, extrusion width (mm)
uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform vec3 u_viewDir;  // target -> eye, unit
uniform int u_ortho;
uniform float u_pxScale; // px per mm at 1 mm (perspective) or absolute (ortho)
uniform float u_minPx;
uniform float u_widthScale;
uniform int u_typeMask;
uniform float u_topLayer;
uniform vec3 u_typeColors[12];
out vec3 v_normal;
out vec3 v_world;
out vec3 v_color;
out float v_top;

void main() {
  int type = int(a_meta.x + 0.5);
  // Filtering in the vertex shader rather than by rebuilding buffers: toggling
  // infill off should be instant, and it is one bit test per vertex.
  if ((u_typeMask & (1 << type)) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3 axis = a_end - a_start;
  float alen = length(axis);
  axis = alen > 1e-6 ? axis / alen : vec3(1.0, 0.0, 0.0);
  vec3 mid = mix(a_start, a_end, a_corner.x);
  vec3 toEye = (u_ortho == 1) ? u_viewDir : normalize(u_eye - mid);
  vec3 side = cross(axis, toEye);
  float sl = length(side);
  // Looking straight down the extrusion: any perpendicular will do, and the
  // segment is a dot on screen anyway.
  side = sl > 1e-4 ? side / sl : normalize(cross(axis, abs(axis.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));

  float dist = max(length(u_eye - mid), 1e-3);
  float pxPerMm = (u_ortho == 1) ? u_pxScale : u_pxScale / dist;
  float halfW = max(a_meta.z * 0.5 * u_widthScale, 0.5 * u_minPx / max(pxPerMm, 1e-6));

  vec3 p = mid + side * (a_corner.y * halfW);
  v_world = p;
  // Fake a round cross-section: cheaper than real tube geometry by a factor of
  // eight and indistinguishable at any zoom a person actually uses.
  v_normal = normalize(side * a_corner.y + toEye * sqrt(max(0.0, 1.0 - a_corner.y * a_corner.y)));
  v_color = u_typeColors[type];
  v_top = 1.0 - clamp(u_topLayer - a_meta.y, 0.0, 1.0);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

export const TOOLPATH_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_world;
in vec3 v_color;
in float v_top;
uniform vec3 u_eye;
uniform vec3 u_keyDir;
uniform float u_alpha;
uniform float u_shade;
out vec4 fragColor;
void main() {
  vec3 n = normalize(v_normal);
  float d = max(dot(n, u_keyDir), 0.0);
  vec3 v = normalize(u_eye - v_world);
  float spec = pow(max(dot(n, normalize(u_keyDir + v)), 0.0), 24.0) * 0.25;
  vec3 c = mix(v_color, v_color * (0.42 + 0.58 * d) + spec, u_shade);
  c = mix(c, min(c * 1.7 + 0.12, vec3(1.0)), v_top * 0.85);   // the layer being laid
  fragColor = vec4(c * u_alpha, u_alpha);
}`;

// BACKLIT: the model as light coming through it, two passes over the mesh.
//
// Pass 0 draws front faces only into a depth texture: the near wall's outer
// surface, per pixel. Pass 1 draws back faces with LESS depth testing and
// discards any at or in front of that depth, so what survives is the nearest
// back face BEHIND the near wall: one step of depth peeling. The two depths are
// unprojected through the same pixel and their distance is the path the light
// takes through the near wall along this view ray. Looking at a lamp shade from
// outside you see one wall's picture, not both walls stacked, and this is what
// keeps it that way.
//
// Brightness is Beer-Lambert, exp(-mu * t), offset so `u_whiteMM` reads as full
// lamp and clamped above it. Transmitted light sees only thickness, so seen
// from behind the picture is mirrored here exactly as it is on the print.
export const BACKLIT_VS = `#version 300 es
in vec3 a_position;
uniform mat4 u_viewProj;
out vec3 v_world;
void main() {
  v_world = a_position;
  gl_Position = u_viewProj * vec4(a_position, 1.0);
}`;

export const BACKLIT_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 v_world;
uniform int u_pass;            // 0 = near front faces into the depth texture, 1 = light
uniform sampler2D u_front;     // pass 0's depth, one texel per drawing-buffer pixel
uniform mat4 u_invViewProj;
uniform vec2 u_size;           // drawing buffer, px
uniform int u_clipOn;
uniform float u_clipZ;
uniform float u_mu;            // attenuation, per mm
uniform float u_whiteMM;       // thickness that reads as the bare lamp
uniform float u_floor;         // faint ambient so a thick solid is not a hole
uniform vec3 u_lamp;           // linear RGB
out vec4 fragColor;

vec3 unproject(vec2 frag, float depth) {
  vec4 p = u_invViewProj * vec4(vec3(frag / u_size, depth) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  if (u_clipOn == 1 && v_world.z > u_clipZ) discard;
  if (u_pass == 0) { fragColor = vec4(0.0); return; }
  float front = texelFetch(u_front, ivec2(gl_FragCoord.xy), 0).r;
  if (front >= 1.0) discard;               // no near wall on this ray (cut open)
  if (gl_FragCoord.z <= front) discard;    // the peel: only what lies behind it
  float t = distance(unproject(gl_FragCoord.xy, gl_FragCoord.z),
                     unproject(gl_FragCoord.xy, front));
  float T = min(exp(-u_mu * (t - u_whiteMM)), 1.0);
  vec3 c = u_lamp * (T + u_floor);
  fragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

/** Corner lattice for one instanced ribbon quad, as a triangle strip. */
export const RIBBON_CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
