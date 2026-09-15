// Render math — camera.js, plus the pure buffer-preparation half of the viewer
// (geometry.js, gcode.js, plate.js). Everything here runs headlessly: if a
// number in the viewer is wrong, it is wrong in Node too.
//
// Where a round trip could hide a sign error (project/unproject, pan, zoom) the
// test asserts the ABSOLUTE pixel as well, computed by hand from the frustum.
// A round trip through two mirrored functions passes whichever way round the
// mirror is.
import { suite, check, near, nearVec, throws, report } from './lib/assert.mjs';
import {
  Camera, PRESETS, PRESET_NAMES, DEG, clamp,
  mat4Identity, mat4Multiply, mat4Invert, mat4Transpose,
  perspective, orthographic, lookAt, transformPoint, transformPoint4, transformDir,
  normalMatrix, rayPlaneZ, rayAABB, boxExtentAlong, boxCenter, boxRadius,
  add3, sub3, scale3, dot3, cross3, len3, norm3, lerp3,
} from '../js/render/camera.js';
import {
  meshToBuffers, widenIndices, boundsFromPositions, boxCorners, boxUnion,
  buildEdgeIndices, overhangDegrees, overhangStats, parseColor, toLinear,
  EDGE_TRIANGLE_BUDGET,
} from '../js/render/geometry.js';
import {
  MOVE_TYPES, MOVE_COLORS, MOVE_LABELS, normaliseType, typeIndex, typeMask,
  ALL_TYPES_MASK, buildToolpathBuffers, layerRange, parseGcodeText, typeColorArray,
} from '../js/render/gcode.js';
import { buildPlateGeometry, buildShadowQuad, PLATE_Z, DEFAULT_PLATE_THEME } from '../js/render/plate.js';
import { cube } from './lib/fixtures.mjs';

suite('render math');

const W = 800, H = 600;

// ---- vec3 ---------------------------------------------------------------
nearVec('add3', add3([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
nearVec('sub3', sub3([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
nearVec('scale3', scale3([1, -2, 3], 2), [2, -4, 6]);
near('dot3', dot3([1, 2, 3], [4, -5, 6]), 12);
nearVec('cross3 is right-handed (x cross y = z)', cross3([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
near('len3', len3([3, 4, 12]), 13);
near('norm3 of a unit vector is unit', len3(norm3([3, 4, 12])), 1);
nearVec('norm3 of zero returns zero rather than NaN', norm3([0, 0, 0]), [0, 0, 0]);
nearVec('lerp3 midpoint', lerp3([0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15]);
near('clamp', clamp(12, 0, 10), 10);

// ---- mat4 ---------------------------------------------------------------
{
  const I = mat4Identity();
  nearVec('identity is identity', transformPoint(I, [3, -4, 5]), [3, -4, 5]);
  // Column-major: m[12..14] is the translation.
  const T = mat4Identity(); T[12] = 5; T[13] = 6; T[14] = 7;
  nearVec('translation lives in m[12..14]', transformPoint(T, [1, 1, 1]), [6, 7, 8]);
  const S = mat4Identity(); S[0] = 2; S[5] = 3; S[10] = 4;
  nearVec('multiply applies the right operand first (T*S scales then translates)',
    transformPoint(mat4Multiply(T, S), [1, 1, 1]), [7, 9, 11]);
  nearVec('multiply the other way scales the translation too',
    transformPoint(mat4Multiply(S, T), [1, 1, 1]), [12, 21, 32]);
  nearVec('transformDir ignores translation', transformDir(T, [1, 0, 0]), [1, 0, 0]);
  const inv = mat4Invert(mat4Multiply(T, S));
  nearVec('invert undoes the transform', transformPoint(inv, [7, 9, 11]), [1, 1, 1]);
  const prod = mat4Multiply(mat4Multiply(T, S), inv);
  let maxOff = 0;
  for (let i = 0; i < 16; i++) maxOff = Math.max(maxOff, Math.abs(prod[i] - mat4Identity()[i]));
  check('m * m^-1 is the identity', maxOff < 1e-12, `max element error ${maxOff.toExponential(2)}`);
  const singular = mat4Identity(); singular[10] = 0;
  check('invert of a singular matrix returns null', mat4Invert(singular) === null);
  nearVec('transpose twice is the original', mat4Transpose(mat4Transpose(T)), T);
  const nm = normalMatrix(S);
  near('normal matrix of a non-uniform scale inverts the x scale', nm[0], 0.5);
  near('normal matrix of a non-uniform scale inverts the z scale', nm[8], 0.25);
}

// ---- projection matrices ------------------------------------------------
{
  const p = perspective(90, 1, 1, 101);
  near('perspective: m[0] = 1/tan(45)/aspect', p[0], 1);
  near('perspective: m[5] = 1/tan(45)', p[5], 1);
  near('perspective: m[10]', p[10], (101 + 1) / (1 - 101));
  near('perspective: m[11] is -1 (w = -z)', p[11], -1);
  near('perspective: m[14]', p[14], 2 * 101 * 1 / (1 - 101));
  near('perspective: near plane maps to ndc z = -1', transformPoint(p, [0, 0, -1])[2], -1);
  near('perspective: far plane maps to ndc z = +1', transformPoint(p, [0, 0, -101])[2], 1);
  const c = transformPoint4(p, [0, 0, -50]);
  near('perspective: w is -z_view', c[3], 50);
  near('perspective: aspect squeezes x', perspective(90, 2, 1, 101)[0], 0.5);

  const inf = perspective(90, 1, 1, Infinity);
  near('infinite far: near plane still maps to -1', transformPoint(inf, [0, 0, -1])[2], -1);
  check('infinite far: a distant point approaches +1 from below',
    transformPoint(inf, [0, 0, -1e7])[2] < 1 && transformPoint(inf, [0, 0, -1e7])[2] > 0.999999,
    `got ${transformPoint(inf, [0, 0, -1e7])[2]}`);

  const o = orthographic(-10, 10, -5, 5, -1, 1);
  nearVec('ortho maps the box corner to the ndc corner', transformPoint(o, [10, 5, -1]), [1, 1, 1]);
  nearVec('ortho maps the opposite corner too', transformPoint(o, [-10, -5, 1]), [-1, -1, -1]);
  nearVec('ortho centre stays centred', transformPoint(o, [0, 0, 0]), [0, 0, 0]);
  const oc = transformPoint4(o, [3, 2, 1]);
  near('ortho leaves w at 1 (no perspective divide)', oc[3], 1);
}

// ---- lookAt -------------------------------------------------------------
{
  const v = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
  nearVec('lookAt puts the eye at the origin of view space', transformPoint(v, [0, 0, 10]), [0, 0, 0]);
  nearVec('lookAt puts the target down -Z', transformPoint(v, [0, 0, 0]), [0, 0, -10]);
  nearVec('lookAt maps world +X to view +X here', transformDir(v, [1, 0, 0]), [1, 0, 0]);
  const deg = lookAt([0, 0, 10], [0, 0, 0], [0, 0, 1]);   // up parallel to the view
  check('lookAt survives an up vector parallel to the view direction',
    deg.every(Number.isFinite), `got ${deg.slice(0, 3).map(n => n.toFixed(2))}`);
}

// ---- camera basis -------------------------------------------------------
{
  const cam = new Camera({ target: [0, 0, 0], distance: 100 });
  cam.orbitTo(0, 0);
  const b = cam.basis();
  nearVec('azimuth 0 elevation 0 puts the eye on +X', b.eye, [100, 0, 0]);
  nearVec('...with screen right along +Y', b.right, [0, 1, 0]);
  nearVec('...and screen up along +Z', b.up, [0, 0, 1]);
  nearVec('...looking back along -X', b.forward, [-1, 0, 0]);
  near('basis is orthonormal: right . up', dot3(b.right, b.up), 0, 1e-12);
  near('basis is orthonormal: |right|', len3(b.right), 1, 1e-12);
  nearVec('right cross up is the eye direction', cross3(b.right, b.up), b.dir, 1e-12);

  cam.orbitTo(-90 * DEG, 90 * DEG);
  const t = cam.basis();
  nearVec('elevation +90 is exact, not a degenerate cross product', t.dir, [0, 0, 1], 1e-12);
  nearVec('...with +X to the right', t.right, [1, 0, 0], 1e-12);
  nearVec('...and +Y up the screen', t.up, [0, 1, 0], 1e-12);

  cam.orbitTo(-90 * DEG, 0);
  const view = cam.viewMatrix();
  nearVec('view matrix sends the eye to the origin', transformPoint(view, cam.eye), [0, 0, 0], 1e-9);
  nearVec('view matrix sends the target to -Z at the focal distance',
    transformPoint(view, cam.target), [0, 0, -100], 1e-9);
}

// ---- presets ------------------------------------------------------------
{
  const cam = new Camera({ target: [0, 0, 0], distance: 100 });
  check('all eight presets are named', PRESET_NAMES.length === 8, PRESET_NAMES.join(','));
  cam.setPreset('front');
  nearVec('front puts the camera on -Y', cam.eye, [0, -100, 0], 1e-9);
  cam.setPreset('back');
  nearVec('back puts the camera on +Y', cam.eye, [0, 100, 0], 1e-9);
  cam.setPreset('right');
  nearVec('right puts the camera on +X', cam.eye, [100, 0, 0], 1e-9);
  cam.setPreset('left');
  nearVec('left puts the camera on -X', cam.eye, [-100, 0, 0], 1e-9);
  cam.setPreset('top');
  nearVec('top puts the camera straight overhead', cam.eye, [0, 0, 100], 1e-9);
  nearVec('top keeps +Y up the screen', cam.basis().up, [0, 1, 0], 1e-9);
  cam.setPreset('bottom');
  nearVec('bottom puts the camera under the plate', cam.eye, [0, 0, -100], 1e-9);
  cam.setPreset('iso');
  const e = cam.eye;
  check('iso is above, in front and to the right', e[0] > 0 && e[1] < 0 && e[2] > 0,
    `eye ${e.map(v => v.toFixed(1))}`);
  near('iso elevation is 28 degrees', cam.elevation * 180 / Math.PI, 28, 1e-9);
  cam.roll = 1;
  cam.setPreset('front');
  near('a preset levels the roll', cam.roll, 0);
  throws('an unknown preset throws with the list of good ones',
    () => cam.setPreset('sideways'), 'unknown preset');
}

// ---- projection, absolutely ---------------------------------------------
{
  const cam = new Camera({ target: [0, 0, 0], distance: 100, fov: 40 });
  cam.orbitTo(-90 * DEG, 0);                       // front view: +X right, +Z up
  const f = 1 / Math.tan(20 * DEG), aspect = W / H;
  const expectX = (0.5 + (f / aspect * 10 / 100) * 0.5) * W;
  const expectY = (0.5 - (f * 10 / 100) * 0.5) * H;
  const px = cam.project([10, 0, 0], W, H);
  const pz = cam.project([0, 0, 10], W, H);
  near('a point 10mm to the right lands at the pixel the frustum says', px.x, expectX, 1e-9);
  near('...on the horizontal centre line', px.y, H / 2, 1e-9);
  near('a point 10mm up lands above centre (screen y grows downward)', pz.y, expectY, 1e-9);
  check('...and above means a smaller y', pz.y < H / 2, `y = ${pz.y.toFixed(1)}`);
  near('the target projects to the centre of the canvas', cam.project([0, 0, 0], W, H).x, W / 2, 1e-9);

  const behind = cam.project([0, -300, 0], W, H);
  check('a point behind the eye is flagged, not silently mirrored', behind.behind === true);
  check('a point in front is not flagged', cam.project([0, 50, 0], W, H).behind === false);

  const world = cam.unproject(600, 200, 0, W, H);
  const back = cam.project(world, W, H);
  near('unproject then project returns the same pixel (x)', back.x, 600, 1e-6);
  near('unproject then project returns the same pixel (y)', back.y, 200, 1e-6);

  cam.projection = 'ortho';
  const a1 = cam.project([10, -40, 0], W, H), a2 = cam.project([10, 40, 0], W, H);
  near('ortho: screen x does not depend on depth', a1.x, a2.x, 1e-9);
  const pxPerMm = H / cam.viewHeight;
  near('ortho: 10mm is exactly viewHeight/H pixels', a1.x - W / 2, 10 * pxPerMm, 1e-9);
  cam.projection = 'perspective';
}

// ---- rays ---------------------------------------------------------------
{
  const cam = new Camera({ target: [0, 0, 0], distance: 100 });
  cam.orbitTo(-90 * DEG, 0);
  const mid = cam.screenRay(W / 2, H / 2, W, H);
  nearVec('the centre ray points along the view direction', mid.direction, cam.basis().forward, 1e-9);
  const rightRay = cam.screenRay(W - 1, H / 2, W, H);
  check('a ray through the right edge leans right',
    dot3(rightRay.direction, cam.basis().right) > 0,
    `dot = ${dot3(rightRay.direction, cam.basis().right).toFixed(3)}`);
  const upRay = cam.screenRay(W / 2, 1, W, H);
  check('a ray through the top of the canvas leans up',
    dot3(upRay.direction, cam.basis().up) > 0,
    `dot = ${dot3(upRay.direction, cam.basis().up).toFixed(3)}`);

  cam.projection = 'ortho';
  const o1 = cam.screenRay(100, 100, W, H), o2 = cam.screenRay(700, 500, W, H);
  nearVec('ortho rays are parallel', o1.direction, o2.direction, 1e-9);
  check('ortho ray origins differ', len3(sub3(o1.origin, o2.origin)) > 1, '');
  cam.projection = 'perspective';

  cam.setPreset('top');
  const hit = cam.plateHit(W / 2, H / 2, W, H, 0);
  nearVec('looking straight down, the centre pixel hits the plate origin', hit, [0, 0, 0], 1e-9);
  const off = cam.plateHit(W / 2 + 100, H / 2, W, H, 0);
  near('...and 100px right is 100 * mm-per-pixel along +X', off[0], 100 * cam.viewHeight / H, 1e-9);
  near('...with y unchanged', off[1], 0, 1e-9);

  check('rayPlaneZ returns null for a ray parallel to the plate',
    rayPlaneZ({ origin: [0, 0, 5], direction: [1, 0, 0] }, 0) === null);
  check('rayPlaneZ returns null when the plane is behind the ray',
    rayPlaneZ({ origin: [0, 0, 5], direction: [0, 0, 1] }, 0) === null);
  const box = { min: [-1, -1, -1], max: [1, 1, 1] };
  const hitBox = rayAABB({ origin: [-5, 0, 0], direction: [1, 0, 0] }, box);
  near('rayAABB entry distance', hitBox.tmin, 4);
  near('rayAABB exit distance', hitBox.tmax, 6);
  check('rayAABB misses cleanly', rayAABB({ origin: [-5, 5, 0], direction: [1, 0, 0] }, box) === null);
  check('rayAABB handles an axis-parallel ray outside the slab',
    rayAABB({ origin: [0, 9, 0], direction: [0, 0, 1] }, box) === null);
  near('boxExtentAlong the diagonal of a unit cube',
    boxExtentAlong({ min: [-1, -1, -1], max: [1, 1, 1] }, norm3([1, 1, 1])), Math.sqrt(3), 1e-9);
  nearVec('boxCenter', boxCenter({ min: [0, 0, 0], max: [10, 20, 30] }), [5, 10, 15]);
  near('boxRadius is half the diagonal', boxRadius({ min: [0, 0, 0], max: [2, 0, 0] }), 1);
}

// ---- interaction --------------------------------------------------------
{
  const cam = new Camera({ target: [0, 0, 0], distance: 100 });
  cam.setPreset('front');
  const az0 = cam.azimuth;
  const front0 = cam.project([0, -10, 0], W, H).x;
  cam.orbit(50, 0);
  near('dragging right lowers the azimuth', cam.azimuth, az0 - 50 * cam.orbitSpeed, 1e-12);
  check('dragging right carries the near face of the model right with the finger',
    cam.project([0, -10, 0], W, H).x > front0 + 1,
    `${front0.toFixed(1)} -> ${cam.project([0, -10, 0], W, H).x.toFixed(1)} px`);

  cam.setPreset('front');
  cam.orbit(0, 60);
  check('dragging down raises the camera so you see the top', cam.elevation > 0,
    `elevation ${(cam.elevation * 180 / Math.PI).toFixed(1)} deg`);
  cam.orbit(0, 100000);
  near('elevation clamps at the pole instead of tumbling', cam.elevation, Math.PI / 2, 1e-12);
  cam.orbit(0, -100000);
  near('and at the other pole', cam.elevation, -Math.PI / 2, 1e-12);
  cam.orbit(1e6, 0);
  check('azimuth is wrapped so it cannot grow without bound', Math.abs(cam.azimuth) <= Math.PI * 2,
    `azimuth ${cam.azimuth.toFixed(3)}`);

  // Pan: the point that was under the centre of the canvas must end up exactly
  // where the finger dragged it.
  const c2 = new Camera({ target: [5, 5, 5], distance: 120 });
  c2.setPreset('iso');
  const old = c2.target.slice();
  c2.pan(30, -20, W, H);
  const moved = c2.project(old, W, H);
  near('pan moves the model with the finger (x)', moved.x, W / 2 + 30, 1e-6);
  near('pan moves the model with the finger (y)', moved.y, H / 2 - 20, 1e-6);

  const c3 = new Camera({ target: [0, 0, 0], distance: 100 });
  c3.zoom(0.5);
  near('zoom halves the distance', c3.distance, 50);
  c3.zoom(1e9);
  near('zoom clamps at maxDistance', c3.distance, c3.maxDistance);
  c3.zoom(1e-12);
  near('zoom clamps at minDistance', c3.distance, c3.minDistance);

  // zoomAt, checked independently: in a top view the focal plane IS the build
  // plate, so the pinned point can be found with a plain ray-plane intersection.
  const c4 = new Camera({ target: [0, 0, 0], distance: 200 });
  c4.setPreset('top');
  const pin = c4.plateHit(620, 180, W, H, 0);
  c4.zoomAt(0.6, 620, 180, W, H);
  const after = c4.project(pin, W, H);
  near('zoom-to-cursor pins the point under the cursor (x)', after.x, 620, 1e-6);
  near('zoom-to-cursor pins the point under the cursor (y)', after.y, 180, 1e-6);
  near('...and still scales the distance by the factor', c4.distance, 120, 1e-9);

  // The same invariant from an oblique view, pivot found from screenRay.
  const c5 = new Camera({ target: [10, -4, 20], distance: 260 });
  c5.setPreset('iso');
  const ray = c5.screenRay(210, 470, W, H);
  const fwd = c5.basis().forward;
  const t = dot3(sub3(c5.target, ray.origin), fwd) / dot3(ray.direction, fwd);
  const pivot = add3(ray.origin, scale3(ray.direction, t));
  c5.zoomAt(1.8, 210, 470, W, H);
  const p5 = c5.project(pivot, W, H);
  near('zoom-to-cursor holds in an oblique view too (x)', p5.x, 210, 1e-6);
  near('zoom-to-cursor holds in an oblique view too (y)', p5.y, 470, 1e-6);

  c5.projection = 'ortho';
  const rayO = c5.screenRay(300, 300, W, H);
  const tO = dot3(sub3(c5.target, rayO.origin), fwd) / dot3(rayO.direction, fwd);
  const pivotO = add3(rayO.origin, scale3(rayO.direction, tO));
  c5.zoomAt(0.5, 300, 300, W, H);
  const pO = c5.project(pivotO, W, H);
  near('zoom-to-cursor works in orthographic as well', pO.x, 300, 1e-6);

  // Roll: positive roll turns the model clockwise on screen.
  const c6 = new Camera({ target: [0, 0, 0], distance: 100 });
  c6.orbitTo(-90 * DEG, 0);
  const before = c6.project([10, 0, 0], W, H);
  check('before roll, the +X point is right of centre and level',
    before.x > W / 2 && Math.abs(before.y - H / 2) < 1e-6, `(${before.x.toFixed(1)}, ${before.y.toFixed(1)})`);
  c6.rollBy(90 * DEG);
  const rolled = c6.project([10, 0, 0], W, H);
  check('a quarter turn of roll takes it clockwise to below centre',
    Math.abs(rolled.x - W / 2) < 1e-6 && rolled.y > H / 2,
    `(${rolled.x.toFixed(1)}, ${rolled.y.toFixed(1)})`);
  near('roll keeps the basis orthonormal', dot3(c6.basis().right, c6.basis().up), 0, 1e-12);
}

// ---- framing ------------------------------------------------------------
{
  const box = { min: [-50, -50, 0], max: [50, 50, 100] };
  const cam = new Camera();
  cam.setPreset('iso');
  cam.fitBox(box, W, H);
  nearVec('fit centres the camera on the box', cam.target, [0, 0, 50], 1e-9);
  const pts = boxCorners(box).map(p => cam.project(p, W, H));
  const inside = pts.every(p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && !p.behind);
  check('fit puts every corner of the box on screen', inside,
    `x ${Math.min(...pts.map(p => p.x)).toFixed(0)}..${Math.max(...pts.map(p => p.x)).toFixed(0)}`);
  const fillY = (Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))) / H;
  const fillX = (Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x))) / W;
  check('fit actually fills the viewport rather than framing a stamp',
    Math.max(fillX, fillY) > 0.55, `fills ${(fillX * 100).toFixed(0)}% x ${(fillY * 100).toFixed(0)}%`);

  const flat = { min: [-80, -5, 0], max: [80, 5, 2] };
  cam.setPreset('top');
  cam.fitBox(flat, W, H);
  const fpts = boxCorners(flat).map(p => cam.project(p, W, H));
  check('a long flat part seen from the top is framed by its real extent, not its sphere',
    (Math.max(...fpts.map(p => p.x)) - Math.min(...fpts.map(p => p.x))) / W > 0.8,
    `fills ${(((Math.max(...fpts.map(p => p.x)) - Math.min(...fpts.map(p => p.x))) / W) * 100).toFixed(0)}% of the width`);

  const point = { min: [3, 3, 3], max: [3, 3, 3] };
  cam.fitBox(point, W, H);
  check('a zero-size box does not divide by zero',
    Number.isFinite(cam.distance) && cam.distance >= cam.minDistance, `distance ${cam.distance}`);
  cam.projection = 'ortho';
  cam.fitBox(box, W, H);
  const opts = boxCorners(box).map(p => cam.project(p, W, H));
  check('fit works in orthographic too',
    opts.every(p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H), '');
  cam.projection = 'perspective';

  cam.fitBox(box, 0, 0);
  check('a zero-size viewport does not produce NaN', Number.isFinite(cam.distance), `distance ${cam.distance}`);
}

// ---- near/far and state -------------------------------------------------
{
  const cam = new Camera({ distance: 300, sceneRadius: 120 });
  const [n, f] = cam.nearFar();
  check('perspective near stays positive', n > 0, `near ${n.toFixed(3)}`);
  check('far is beyond the far side of the scene', f > cam.distance + 120, `far ${f.toFixed(1)}`);
  check('the depth ratio stays inside 24-bit territory', f / n < 1e5, `far/near ${(f / n).toFixed(0)}`);
  cam.projection = 'ortho';
  const [on, of_] = cam.nearFar();
  check('ortho near goes behind the camera so nothing is clipped away', on < 0 && of_ > 0,
    `${on.toFixed(0)}..${of_.toFixed(0)}`);

  const c = new Camera();
  c.setState({ distance: 1e9, elevation: 99, fov: 500, projection: 'ortho', target: [1, 2, 3] });
  near('setState clamps distance to the limit', c.distance, c.maxDistance);
  near('setState clamps elevation to the pole', c.elevation, Math.PI / 2);
  near('setState clamps fov to something sane', c.fov, 120);
  const s = c.getState();
  const c2 = new Camera().setState(s);
  nearVec('getState/setState round trips the target', c2.target, [1, 2, 3]);
  near('...and the projection survives', c2.projection === 'ortho' ? 1 : 0, 1);
  const cl = c.clone();
  cl.target[0] = 99;
  near('clone deep-copies the target', c.target[0], 1);
  near('viewHeight is 2*d*tan(fov/2)', new Camera({ distance: 100, fov: 60 }).viewHeight,
    2 * 100 * Math.tan(30 * DEG), 1e-9);
  check('PRESETS is keyed by name', typeof PRESETS.iso.azimuth === 'number');
}

// ---- geometry.js --------------------------------------------------------
{
  const b = boundsFromPositions(new Float32Array([0, 0, 0, 10, -4, 3, -2, 8, 1]));
  nearVec('boundsFromPositions min', b.min, [-2, -4, 0]);
  nearVec('boundsFromPositions max', b.max, [10, 8, 3]);
  nearVec('empty positions give a zero box', boundsFromPositions(new Float32Array(0)).min, [0, 0, 0]);
  check('boxCorners returns eight corners', boxCorners(b).length === 8);
  const u = boxUnion({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [-5, 0, 0], max: [1, 1, 9] });
  nearVec('boxUnion takes the outer hull', u.min.concat(u.max), [-5, 0, 0, 1, 1, 9]);
  check('boxUnion tolerates a null operand', boxUnion(null, b) === b);

  const cubeBuf = meshToBuffers(cube(10), { crease: 35 });
  check('a cube keeps its 12 triangles through the render buffers', cubeBuf.triCount === 12,
    `${cubeBuf.triCount} tris, ${cubeBuf.vertCount} verts`);
  check('crease splitting gives a cube 24 vertices, not 8', cubeBuf.vertCount === 24,
    `${cubeBuf.vertCount} verts`);
  let axisAligned = true;
  for (let i = 0; i < cubeBuf.normals.length; i += 3) {
    const m = Math.max(Math.abs(cubeBuf.normals[i]), Math.abs(cubeBuf.normals[i + 1]), Math.abs(cubeBuf.normals[i + 2]));
    if (Math.abs(m - 1) > 1e-5) axisAligned = false;
  }
  check('a box comes out with crisp axis-aligned normals', axisAligned);
  check('a small mesh keeps 16-bit indices', !cubeBuf.wide, `wide = ${cubeBuf.wide}`);
  nearVec('bbox comes back with the buffers', cubeBuf.bbox.min, [-5, -5, -5]);
  throws('meshToBuffers rejects something that is not a mesh',
    () => meshToBuffers({ nope: 1 }), 'expected a Mesh');
  check('meshToBuffers(null) is null, not a throw', meshToBuffers(null) === null);

  const edges = buildEdgeIndices(cubeBuf.indices, cubeBuf.vertCount);
  // Each face is its own 4 vertices and 2 triangles: 4 sides + 1 diagonal = 5
  // lines per face, and the faces share no vertices after the crease split.
  check('a crease-split cube gives 30 unique edges (5 per face, faces unshared)',
    edges.length / 2 === 30, `${edges.length / 2} edges`);
  const welded = buildEdgeIndices(new Uint16Array([0, 1, 2, 0, 2, 3]), 4);
  check('two triangles sharing an edge give five lines, not six',
    welded.length / 2 === 5, `${welded.length / 2} edges`);
  check('past the budget, edge building declines rather than hanging',
    buildEdgeIndices(new Uint16Array(30), 10, { budget: 5 }) === null);
  check('EDGE_TRIANGLE_BUDGET is generous enough for a 500k mesh', EDGE_TRIANGLE_BUDGET >= 500000);
  check('widenIndices promotes to Uint32', widenIndices(new Uint16Array([1, 2, 3])) instanceof Uint32Array);
  check('widenIndices leaves Uint32 alone',
    widenIndices(new Uint32Array([1])) instanceof Uint32Array);

  near('a ceiling is a 90 degree overhang', overhangDegrees(-1), 90);
  near('a 45 degree slope reads 45', overhangDegrees(-Math.SQRT1_2), 45, 1e-9);
  near('a vertical wall is 0', overhangDegrees(0), 0);
  near('an upward face is 0, not negative', overhangDegrees(0.5), 0);

  // Two unit squares, one facing straight down, one straight up: exactly half
  // the area is a ceiling.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,          // down-facing
    0, 0, 5, 1, 0, 5, 1, 1, 5, 0, 1, 5,          // up-facing
  ]);
  const normals = new Float32Array([
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const st = overhangStats({ positions, normals, indices: idx, indexCount: idx.length }, 50);
  near('overhangStats total area', st.area, 2);
  near('overhangStats flags exactly the downward half', st.overhangPct, 50, 1e-6);
  near('overhangStats reports the worst angle', st.worstDeg, 90, 1e-6);

  nearVec('parseColor reads #rrggbb', parseColor('#ff8000'), [1, 128 / 255, 0], 1e-6);
  nearVec('parseColor expands #rgb', parseColor('#f80'), [1, 136 / 255, 0], 1e-6);
  nearVec('parseColor passes arrays through', parseColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  nearVec('toLinear leaves white alone', toLinear([1, 1, 1]), [1, 1, 1], 1e-6);
  check('toLinear darkens mid grey (sRGB is not linear)', toLinear([0.5, 0.5, 0.5])[0] < 0.25,
    `0.5 -> ${toLinear([0.5, 0.5, 0.5])[0].toFixed(4)}`);
}

// ---- gcode.js -----------------------------------------------------------
{
  check('the type table has the 12 slots the shader declares', MOVE_TYPES.length === 12,
    `${MOVE_TYPES.length} types`);
  check('every type has a colour and a label',
    MOVE_TYPES.every(t => MOVE_COLORS[t] && MOVE_LABELS[t]));
  check('Orca "Outer wall" is an outer wall', normaliseType('Outer wall') === 'outer');
  check('PrusaSlicer "External perimeter" is too', normaliseType('External perimeter') === 'outer');
  check('a bare "Perimeter" is an inner wall (Prusa names the outer one explicitly)',
    normaliseType('Perimeter') === 'inner', normaliseType('Perimeter'));
  check('Cura "WALL-INNER"', normaliseType('WALL-INNER') === 'inner', normaliseType('WALL-INNER'));
  check('"Top solid infill" beats the plain solid rule',
    normaliseType('Top solid infill') === 'top', normaliseType('Top solid infill'));
  check('"Internal solid infill" is solid', normaliseType('Internal solid infill') === 'solid');
  check('"Sparse infill" is infill', normaliseType('Sparse infill') === 'infill');
  check('"Support interface" is support, not an interface of something else',
    normaliseType('Support interface') === 'support');
  check('"Skirt/Brim" is skirt', normaliseType('Skirt/Brim') === 'skirt');
  check('"Bridge infill" is a bridge', normaliseType('Bridge infill') === 'bridge');
  check('an unknown name lands in other rather than being dropped',
    normaliseType('Zorb wall of doom') === 'other' || normaliseType('Zorb wall of doom') === 'inner',
    normaliseType('Zorb wall of doom'));
  check('null is other', normaliseType(null) === 'other');
  check('a numeric type indexes the table', normaliseType(1) === 'outer');
  near('typeIndex agrees with the table', typeIndex('travel'), 0);
  check('typeMask sets one bit per type', typeMask(['travel', 'outer']) === 0b11);
  check('ALL_TYPES_MASK covers every slot', ALL_TYPES_MASK === (1 << 12) - 1, ALL_TYPES_MASK.toString(2));
  check('typeColorArray is 3 floats per type', typeColorArray().length === 36);

  const data = {
    layers: [
      { z: 0.2, paths: [{ type: 'Outer wall', pts: [0, 0, 0.2, 10, 0, 0.2, 10, 10, 0.2] },
                        { type: 'travel', pts: [10, 10, 0.2, 0, 0, 0.2] }] },
      { z: 0.4, paths: [{ type: 'Sparse infill', pts: [0, 0, 0.4, 5, 5, 0.4] }] },
    ],
  };
  const built = buildToolpathBuffers(data);
  check('extrusions and travels are packed separately',
    built.extrude.count === 3 && built.travel.count === 1,
    `${built.extrude.count} extrusions, ${built.travel.count} travels`);
  check('layer starts index into the extrusion pack',
    [...built.extrude.layerStart].join(',') === '0,2,3', [...built.extrude.layerStart].join(','));
  near('segment total', built.segmentCount, 4);
  near('layer count', built.layerCount, 2);
  nearVec('bbox spans the toolpaths', built.bbox.min.concat(built.bbox.max), [0, 0, 0.2, 10, 10, 0.4]);
  check('the type histogram is filled in', built.typeCounts.outer === 2 && built.typeCounts.infill === 1,
    JSON.stringify(built.typeCounts));
  const meta = built.extrude.data;
  near('instance stride packs 9 floats', meta.length / built.extrude.count, 9);
  near('the width defaults from the move type', meta[8], 0.42, 1e-6);

  // progress is layers-laid-down, not an index: 1 = layer 0 complete.
  const rNone = layerRange(built.extrude, 0, 0);
  check('progress 0 draws nothing', rNone.count === 0, JSON.stringify(rNone));
  const r0 = layerRange(built.extrude, 0, 1);
  check('progress 1 is layer 0 complete: the first two segments',
    r0.first === 0 && r0.count === 2, JSON.stringify(r0));
  const rAll = layerRange(built.extrude, 0, 2);
  check('progress 2 is both layers, all three segments',
    rAll.first === 0 && rAll.count === 3, JSON.stringify(rAll));
  const rHalf = layerRange(built.extrude, 0, 0.5);
  check('a fractional progress draws part of the layer being laid',
    rHalf.count === 1, JSON.stringify(rHalf));
  const rTop = layerRange(built.extrude, 1, 2);
  check('a raised floor skips the layers below it',
    rTop.first === 2 && rTop.count === 1, JSON.stringify(rTop));
  const rClamp = layerRange(built.extrude, -5, 99);
  check('an out-of-range slider clamps instead of reading off the end',
    rClamp.first === 0 && rClamp.count === 3, JSON.stringify(rClamp));

  const zero = buildToolpathBuffers({ layers: [] });
  check('empty layer data does not throw', zero.segmentCount === 0);
  const degenerate = buildToolpathBuffers({ layers: [{ z: 1, paths: [{ type: 'infill', pts: [1, 1, 1, 1, 1, 1] }] }] });
  check('a zero-length move is dropped (it would NaN the ribbon axis)',
    degenerate.segmentCount === 0, `${degenerate.segmentCount} segments`);
  const capped = buildToolpathBuffers(data, { maxSegments: 2 });
  check('maxSegments truncates and says so', capped.truncated === true && capped.segmentCount === 2);
  check('...and the layer table still has one entry per layer',
    capped.extrude.layerStart.length === 3, `${capped.extrude.layerStart.length}`);

  const gcode = [
    'G90', 'M83', 'G1 Z0.2 F300',
    ';TYPE:Outer wall', ';WIDTH:0.42',
    'G1 X0 Y0 E0', 'G1 X10 Y0 E0.5', 'G1 X10 Y10 E0.5',
    ';TYPE:Travel', 'G1 X0 Y0 F9000',
    'G1 Z0.4 F300', ';TYPE:Sparse infill', 'G1 X5 Y5 E0.3',
  ].join('\n');
  const parsed = parseGcodeText(gcode);
  check('the raw parser finds both layers', parsed.layers.length === 2,
    `${parsed.layers.length} layers`);
  near('layer 2 is at Z 0.4', parsed.layers[1].z, 0.4);
  const built2 = buildToolpathBuffers(parsed);
  check('the parsed file packs into extrusions and travels',
    built2.extrude.count >= 3 && built2.travel.count >= 1,
    `${built2.extrude.count} extrusions, ${built2.travel.count} travels`);
  check('the outer wall keeps its type through the parser',
    (built2.typeCounts.outer || 0) >= 2, JSON.stringify(built2.typeCounts));
  const rel = parseGcodeText('G91\nG1 X0 Y0\nG1 X5 Y0 E1\nG1 X5 Y0 E1');
  const relBuilt = buildToolpathBuffers(rel);
  near('relative positioning accumulates', relBuilt.bbox.max[0], 10, 1e-6);
  check('a string is accepted straight into buildToolpathBuffers',
    buildToolpathBuffers(gcode).segmentCount >= 3);
}

// ---- plate.js -----------------------------------------------------------
{
  const g = buildPlateGeometry({ size: 180, grid: 10, major: 50 });
  check('the plate produces line geometry', g.line.positions.length > 0,
    `${g.line.positions.length / 3} line vertices`);
  check('the plate produces the fill and the outline bands', g.tri.positions.length >= 6 * 3,
    `${g.tri.positions.length / 3} triangle vertices`);
  near('half size', g.half, 90);
  let inside = true, belowPlate = true, minZ = 0;
  for (let i = 0; i < g.line.positions.length; i += 3) {
    if (Math.abs(g.line.positions[i]) > 90.001 || Math.abs(g.line.positions[i + 1]) > 90.001) inside = false;
    if (g.line.positions[i + 2] >= 0) belowPlate = false;
    minZ = Math.min(minZ, g.line.positions[i + 2]);
  }
  check('every grid line stays inside the 180x180 bed', inside);
  check('every plate element sits below z = 0 so nothing z-fights the model', belowPlate,
    `lowest ${minZ.toFixed(2)} mm`);
  let triBelow = true;
  for (let i = 2; i < g.tri.positions.length; i += 3) if (g.tri.positions[i] >= 0) triBelow = false;
  check('the plate fill and bands are below z = 0 too', triBelow);
  check('the deepest plate element is still under one layer height',
    Math.abs(PLATE_Z.fill) < 0.2, `${PLATE_Z.fill} mm`);
  check('the shadow plane sits above the plate but below the model',
    PLATE_Z.shadow > PLATE_Z.origin && PLATE_Z.shadow < 0, `${PLATE_Z.shadow} mm`);
  // 18 gridlines each way (the two axis lines are drawn separately), 18
  // segments each, 2 vertices per segment, times two directions.
  check('the grid is cut at every crossing so the radial fade is actually radial',
    g.line.positions.length / 3 >= 18 * 18 * 2 * 2,
    `${g.line.positions.length / 3} vertices for 18x18 cut lines`);
  // Ticks must land on major-grid multiples. Stepping "one major pitch in from
  // the edge" puts them at -40/+10/+60 on a 180 bed, which marks nothing.
  const ticks = [];
  for (let i = 0; i < g.line.positions.length; i += 3) {
    if (Math.abs(g.line.positions[i + 2] - PLATE_Z.tick) < 1e-6) {
      ticks.push([g.line.positions[i], g.line.positions[i + 1]]);
    }
  }
  const onMajor = ticks.every(([x, y]) =>
    Math.abs(Math.abs(x) % 50) < 1e-3 || Math.abs(Math.abs(y) % 50) < 1e-3 ||
    Math.abs(Math.abs(x) - 90) < 1e-3 || Math.abs(Math.abs(y) - 90) < 1e-3 ||
    Math.abs(Math.abs(x) - 86) < 1e-3 || Math.abs(Math.abs(y) - 86) < 1e-3);
  check('edge ticks mark the 50 mm major grid, not an offset from the edge',
    ticks.length === 8 && onMajor,
    ticks.map(t => `(${t[0].toFixed(0)},${t[1].toFixed(0)})`).join(' '));

  const corners = buildPlateGeometry({ size: 100, grid: 25, major: 50 });
  near('a different bed size rescales the plate', corners.half, 50);
  check('the shadow quad is two triangles', buildShadowQuad(90).length === 18);
  check('the plate theme is exported for the UI to restyle',
    typeof DEFAULT_PLATE_THEME.grid === 'string');
}

// ---- plate.js: the numbers a caller can pass that used to kill the tab -----
// The catalogue's preview viewer asks for `grid: 0` meaning "no grid", and for
// months that meant `size / 0` -> Infinity divisions in a QUADRATIC loop: the
// vertex array grew until it hit its 2^32 limit, threw "Invalid array length",
// and left the renderer process dead. `major: 0` was quieter and worse — the
// tick loop's `v += major` never advanced, so the page simply stopped.
//
// Note how these fail if the guards are removed: the grid cases THROW, and the
// major case HANGS. A hang shows up as a suite that never reports, which is why
// the assertions below are cheap and the loop bounds are asserted directly.
{
  const finite = (g) => {
    for (const arr of [g.tri.positions, g.tri.colors, g.line.positions, g.line.colors]) {
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
    }
    return true;
  };
  // 1e-6, not 1e-9: these are Float32Arrays, and float32 of -0.08 is 1.8e-9 away
  // from the double the shelf is declared as. At 1e-9 this counter returns zero
  // for EVERY shelf, and three of the assertions below would pass no matter what
  // the geometry did.
  const linesAtZ = (g, z) => {
    let k = 0;
    for (let i = 2; i < g.line.positions.length; i += 3) if (Math.abs(g.line.positions[i] - z) < 1e-6) k++;
    return k;
  };
  check('the z-shelf counter can actually see a shelf',
    linesAtZ(buildPlateGeometry({ size: 180, grid: 10, major: 50 }), PLATE_Z.tick) === 8,
    'a counter that reports zero everywhere would make the checks below vacuous');

  const none = buildPlateGeometry({ size: 180, grid: 0, major: 50 });
  check('grid: 0 draws a plate instead of exhausting memory', none.line.positions.length > 0,
    `${none.line.positions.length / 3} line vertices`);
  check('grid: 0 means no grid', none.divisions === 0 && linesAtZ(none, PLATE_Z.grid) === 0,
    `${none.divisions} divisions, ${linesAtZ(none, PLATE_Z.grid)} grid vertices`);
  check('grid: 0 still draws the axes — a plate with no origin is not a plate',
    linesAtZ(none, PLATE_Z.axis) > 0, `${linesAtZ(none, PLATE_Z.axis)} axis vertices`);
  check('grid: 0 still draws the bed outline', none.tri.positions.length >= 6 * 3 * 5);
  check('grid: 0 produces no NaN anywhere', finite(none));

  // An absent grid is NOT the same request as an explicit zero, and collapsing
  // the two would put a grid on every thumbnail that asked for a clean plate.
  const dflt = buildPlateGeometry({ size: 180 });
  check('an absent grid still defaults to 10 mm', dflt.grid === 10 && dflt.divisions === 18,
    `grid ${dflt.grid}, ${dflt.divisions} divisions`);

  const fine = buildPlateGeometry({ size: 180, grid: 0.05, major: 50 });
  check('an absurdly fine grid is clamped rather than allocating gigabytes',
    fine.gridClamped && fine.divisions <= 200, `${fine.divisions} divisions`);
  check('the clamped grid is bounded in memory too',
    fine.line.positions.length / 3 < 400_000, `${fine.line.positions.length / 3} vertices`);
  check('the clamped grid still reports the pitch it actually drew',
    Math.abs(fine.grid - 180 / 200) < 1e-9, `${fine.grid} mm`);

  const noMajor = buildPlateGeometry({ size: 180, grid: 10, major: 0 });
  check('major: 0 terminates instead of stepping by zero for ever',
    noMajor.line.positions.length > 0, `${noMajor.line.positions.length / 3} line vertices`);
  check('major: 0 draws no edge ticks', linesAtZ(noMajor, PLATE_Z.tick) === 0);
  check('major: 0 still draws the minor grid', linesAtZ(noMajor, PLATE_Z.grid) > 0);

  const fineMajor = buildPlateGeometry({ size: 180, grid: 10, major: 0.01 });
  const fineTicks = linesAtZ(fineMajor, PLATE_Z.tick) / 2;
  check('an absurdly fine major pitch is bounded but still drawn',
    fineTicks > 0 && fineTicks <= 2 * (2 * 100 + 2), `${fineTicks} ticks`);

  for (const [label, opts] of [
    ['NaN grid', { size: 180, grid: NaN, major: 50 }],
    ['negative grid', { size: 180, grid: -10, major: 50 }],
    ['a string grid', { size: 180, grid: '10', major: 50 }],
    ['NaN size', { size: NaN, grid: 10, major: 50 }],
    ['zero size', { size: 0, grid: 10, major: 50 }],
    ['negative size', { size: -180, grid: 10, major: 50 }],
    ['negative major', { size: 180, grid: 10, major: -50 }],
    ['nothing at all', {}],
  ]) {
    const g = buildPlateGeometry(opts);
    check(`${label}: a plate comes back, finite, and bounded`,
      g.line.positions.length > 0 && g.half > 0 && finite(g) &&
      g.line.positions.length / 3 < 400_000,
      `half ${g.half}, ${g.line.positions.length / 3} vertices`);
  }
}

// ---- 500k triangles -----------------------------------------------------
{
  // 500 x 500 cells, two triangles each: 500,000 triangles over 251,001
  // vertices — comfortably past the 16-bit index limit, which is the trap.
  const n = 500;
  const side = n + 1;
  const verts = side * side;
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const i = (y * side + x) * 3;
      positions[i] = x * 0.3 - 75;
      positions[i + 1] = y * 0.3 - 75;
      positions[i + 2] = 10 + Math.sin(x * 0.05) * Math.cos(y * 0.05) * 4;
      normals[i + 2] = 1;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * side + x, b = a + 1, c = a + side, d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  let t0 = Date.now();
  const buf = meshToBuffers({ positions, normals, indices });
  const tPrep = Date.now() - t0;
  check('500k triangles prepare without falling over',
    buf.triCount === 500000, `${buf.triCount} tris, ${buf.vertCount} verts in ${tPrep} ms`);
  check('indices are Uint32 once past 65535 vertices', buf.wide === true,
    `${buf.indices.constructor.name}, ${buf.vertCount} verts`);
  check('the buffer set carries its own bbox so fit() needs no second pass',
    buf.bbox.max[0] > 74 && buf.bbox.min[2] > 5, JSON.stringify(buf.bbox.min.map(v => +v.toFixed(2))));

  t0 = Date.now();
  const edges = buildEdgeIndices(buf.indices, buf.vertCount);
  const tEdges = Date.now() - t0;
  check('wireframe edges for 500k triangles build in one pass',
    edges && edges.length / 2 === 751000, `${edges.length / 2} unique edges in ${tEdges} ms`);
  check('...as a Uint32 line index buffer', edges instanceof Uint32Array, edges.constructor.name);

  t0 = Date.now();
  const st = overhangStats(buf, 50);
  const tOver = Date.now() - t0;
  check('overhang analysis of 500k triangles is a single sweep',
    st.overhangPct === 0 && st.area > 0, `${st.area.toFixed(0)} mm2, 0% overhang, ${tOver} ms`);

  // A widened index array must not be re-copied: it is 6 MB.
  check('widenIndices does not copy an array that is already Uint32',
    widenIndices(buf.indices) === buf.indices);

  const cam = new Camera();
  cam.setPreset('iso');
  cam.fitBox(buf.bbox, W, H);
  check('a 500k mesh still frames correctly',
    boxCorners(buf.bbox).every(p => { const q = cam.project(p, W, H); return q.x >= 0 && q.x <= W && q.y >= 0 && q.y <= H; }),
    `distance ${cam.distance.toFixed(1)} mm`);
}

report();
