// Print-in-place joints.
//
// A joint here is not a shape, it is a pair of edits per side: something to CUT
// from the segment's body and something to ADD to it, such that the two
// segments come off the plate as separate shells that cannot be pulled apart.
// Keeping it in the kernel rather than in the creature generator is deliberate
// — it is the one piece that can be wrong in a way you only discover four hours
// into a print, and it is testable here with no creature around it.
//
// THE RULE THAT MAKES IT WORK. The ball and its socket are built with the SAME
// `segments` and `rings`. sphere() fixes its seam at angle 0 and nseg() is a
// pure function of (count, segFactor), so equal counts put every facet of the
// socket parallel to the facet of the ball facing it, and the faceting error
// cancels out of the gap instead of adding to it. Scaling the socket's
// resolution to its own radius — the obvious thing to do — drops the measured
// minimum gap on bare concentric spheres from 0.337 mm to 0.179 mm at draft
// quality on a 0.35 mm nominal, and on this joint from 0.3369 to 0.2580, under
// the 0.315 gate. Half the gap, and a fused joint on a 0.4 mm nozzle.
// tests/joint.test.mjs calibrates the first and mutation-tests the second.
//
// CLEARANCE IS APPLIED BY GROWING THE CUT, NEVER BY SHRINKING THE BALL. One
// direction, one place, so there is never a question about whether a gap got
// applied twice or not at all.
//
// `clearance` MUST BE POSITIVE. Zero is out of contract, and so is a negative,
// which becomes zero here. At zero the ball and the socket are the same
// surface: each segment is still individually watertight and manifold, but the
// two coincident surfaces in the MERGED model are not — 73 non-manifold edges
// at draft quality on a 9 mm body, 560 at normal. There is deliberately no
// floor clamping it up to something safe, because the zero-clearance case is
// the falsifier that proves the gap gate can fail: a floor would stop it
// welding, and it would stop proving anything.
//
// HOW THE FOUR MESHES GO TOGETHER. One rule, the same on both sides:
//
//     A = union(subtract(bodyA, cutA), addA)
//     B = union(subtract(bodyB, cutB), addB)
//
// Cut the body first, then grow the feature. The order is not cosmetic. `cutA`
// is a trim solid that clears the WHOLE joint region out of segment A's body,
// so applying it after `addA` would eat the ball it exists to make room for.
// Writing it the other way round is silent — you get a stump where the ball
// was and a socket with nothing in it — so the recipe lives here, and
// tests/joint.test.mjs assembles exactly this way.
//
// The upside of a trim solid is that the caller does not have to stop SEGMENT
// A's body in the right place. A creature's body is a lofted tube; ending a
// loft exactly on a plane is fiddly and getting it wrong by a tenth of a
// millimetre fuses the joint. Lofting straight through and letting the joint
// cut is exact.
//
// THAT UPSIDE IS A'S ALONE. `cutB` is the cavity and nothing else — it does not
// trim B's body back to anything, because B has no face to cut to: its material
// is what holds the ball in. So segment B must START at the station. Loft B
// straight through the way you can loft A, and its body fills the space behind
// the ball: measured, the gap goes to 0.0000 mm and jointGateHolds is false.
import { sphere, cylinder, cone, box, nseg, segFactorOf } from './builders.js';
import { union, subtract } from './csg.js';
import { clamp, num, DEG, RAD } from './scalar.js';
import { fit } from './fit.js';

export const JOINT_KINDS = ['ball', 'hinge'];

/** Past this the mouth is wider than a hemisphere: the cone has no radius to
 *  build from (tan goes negative at 90) and nothing is captive long before it. */
const MAX_MOUTH_DEG = 89;

/**
 * The numbers behind a ball joint, without building anything.
 *
 * Exported so validate() can ask the captivity question at parameter-change
 * time rather than after a four-second rebuild.
 *
 * `r` is the radius of the thinner of the two bodies the joint sits between.
 */
export function ballGeometry({ r, clearance = fit('free'), swingDeg = 25, stalkFrac = 0.42 } = {}) {
  const rBody = num(r, 8);

  // The floors are not arbitrary. They are the largest values at which every
  // shipped species keeps real wall around its thinnest socket: the binding
  // case is the snake's last joint at r = 4.19 mm, which needs
  // 1.6 + 0.35 + 1.0 + 0.8 = 3.75 mm and has 0.44 mm to spare. Raising either
  // puts the snake — and the dragon's tail — into validate() errors at their
  // own defaults.
  //
  // clamp(v, lo, hi) returns `lo` when v < lo EVEN IF that exceeds hi (see
  // scalar.js), so on a very thin body the ball can come out larger than
  // 0.42 x r. That is deliberate: the build stays watertight and validate() is
  // what reports it. A Math.min here instead would quietly produce a 0.3 mm
  // ball on a 1 mm body and print a blob.
  const ballR = clamp(0.30 * rBody, 1.6, 0.42 * rBody);
  const stalkR = clamp(num(stalkFrac, 0.42), 0.05, 0.95) * ballR;
  const wall = Math.max(1.0, 0.35 * ballR);
  const c = Math.max(0, num(clearance, fit('free')));

  // Below 1 degree the mouth cone is tangent to the stalk and the two weld;
  // above 80 nothing this shape can hold is captive. That is the legal range,
  // and it is clamped rather than rejected because a species sweeping its swing
  // parameter should bottom out, not throw.
  //
  // THE CLAMP IS SILENT, SO READ IT BACK. A caller sweeping swingDeg and asking
  // `captiveMargin > 0` at swing 0 is being answered about a 1-degree joint, and
  // nothing in the return value says so unless you look: the clamped value comes
  // back as `swingDeg` here and as `limit.deg` from joint(), and those — not the
  // number you passed — are what the joint was built to. Same for `stalkFrac`,
  // clamped to [0.05, 0.95] above and readable back as `stalkR / ballR`.
  const swing = clamp(num(swingDeg, 25), 1, 80);

  // THE ONE DERIVATION THAT MATTERS. The cone that lets the stalk swing must
  // clear the swing angle AND the stalk's own half-angle as seen from the ball
  // centre. Choosing the mouth angle directly instead of deriving it is how a
  // ball joint ends up with almost no movement: with ballR = 2.7, stalkR = 1.13
  // and c = 0.35 the stalk alone subtends 21.8 degrees, so a chosen 28 leaves
  // 6.2 degrees of swing where the derived 46.8 gives the full 25. Measured, by
  // swinging the built ball against the built socket: a joint asked for 25
  // degrees and given a fixed 28-degree mouth is shut at 15.
  const stalkHalf = Math.asin(clamp(stalkR / (ballR + c), 0, 1)) * RAD;
  const mouthDeg = swing + stalkHalf;

  // CAPTIVITY FALLS OUT OF THE SAME ARITHMETIC. The ball leaves through the
  // circle where the mouth cone crosses the socket sphere. Narrower than the
  // ball means it stays in.
  //
  // Past 90 degrees that circle is no longer the narrow one — the mouth has
  // swallowed the equator, so the widest section the ball must pass is the
  // socket's own equator and the joint is open. Writing this as plain
  // sin(mouthDeg) would report an 137-degree mouth as CAPTIVE, because sine
  // comes back down the far side: a wide-open socket wearing a healthy number.
  const apertureR = mouthDeg >= 90 ? (ballR + c) : (ballR + c) * Math.sin(mouthDeg * DEG);
  const captiveMargin = ballR - apertureR;

  // How much air the stalk has at the narrowest point of the mouth — the
  // aperture rim. This is NOT bought by the derivation above, which only makes
  // the mouth tangent to the stalk at zero swing; it is bought by the swing
  // angle. At the defaults it is 1.09 mm, but a 1-degree swing leaves 0.05 mm
  // and prints as one lump. validate() is what should say so; reported here so
  // it can, without building a mesh.
  const mouthGap = apertureR - stalkR;

  // Where the socket's outermost material can reach (its south pole, when the
  // mouth is too narrow to have eaten it), and where segment A's body has to
  // stop to leave a clearance behind it.
  const rearZ = -(ballR + c + wall);
  const faceZ = rearZ - c;

  return { ballR, stalkR, wall, c, swingDeg: swing, stalkHalf, mouthDeg,
           apertureR, captiveMargin, mouthGap, rearZ, faceZ };
}

/** Carry a mesh built along +Z onto the frame (n, b, t) at p.
 *
 *  mesh.transform() takes COLUMN-MAJOR 16 (WebGL order) — see mesh.js:84. The
 *  frame axes are therefore the first three COLUMNS, not the first three rows.
 *  Writing this row-major transposes an orthonormal frame, which is its
 *  inverse: the geometry lands somewhere plausible-looking and completely
 *  wrong, and an axis-aligned test frame cannot see the difference, because
 *  the identity is its own transpose. */
export function toFrame(mesh, { p, t, n, b }) {
  return mesh.transform([
    n[0], n[1], n[2], 0,
    b[0], b[1], b[2], 0,
    t[0], t[1], t[2], 0,
    p[0], p[1], p[2], 1,
  ]);
}

/**
 * Ball and socket, built along +Z about the ball centre and carried onto the
 * two stations' frames.
 *
 *         segment A body            gap          segment B body (socket dome)
 *     ......................|                |...............................
 *                           |<-- c -->|      |
 *                           |    stalk  ( O )| ball centre at z = 0
 *                           |          \____/|
 *                        z = faceZ          z = rearZ
 *
 * `a` and `b` are the SAME station seen from each side, so they are normally
 * identical; they are taken separately only so a generator can hand each side
 * its own frame without the joint having to guess which one is authoritative.
 */
function ballJoint({ a, b, clearance = fit('free'), swingDeg = 25, stalkFrac = 0.42,
                     segments = 48, rings = 24, ctx = null } = {}) {
  if (!a || !b) throw new Error("joint('ball'): needs both stations a and b");
  const rMin = Math.min(num(a.r, 8), num(b.r, 8));
  const g = ballGeometry({ r: rMin, clearance, swingDeg, stalkFrac });
  const { ballR, stalkR, wall, c, mouthDeg, faceZ } = g;

  if (mouthDeg >= MAX_MOUTH_DEG) {
    throw new Error(
      `joint('ball'): a ${g.swingDeg.toFixed(1)}deg swing on a ${stalkR.toFixed(2)} mm stalk ` +
      `needs a ${mouthDeg.toFixed(1)}deg mouth, which is wider than the socket's own equator — ` +
      `the ball would fall out (captive margin ${g.captiveMargin.toFixed(2)} mm). ` +
      `Narrow the swing or the stalk; ballGeometry() answers this without building.`);
  }

  // Quality travels with the build context, and it travels to BOTH spheres
  // identically or the facets stop being parallel and the gap halves.
  const q = { segments, rings, ctx };

  // ---- A owns the ball ---------------------------------------------------
  // The stalk runs from A's cut face up to the ball centre; the ball sits on
  // the centre. sphere() translates by z0 + r, so z0 = -ballR lands the centre
  // on the origin.
  const stalk = cylinder(stalkR, -faceZ, { segments, ctx, z0: faceZ });
  const ball = sphere(ballR, { ...q, z0: -ballR });
  const addA = toFrame(union(stalk, ball), a);

  // Everything of A's body from the face plane forward is B's business. A
  // generous disc rather than a tight one: the caller's body is whatever shape
  // the station describes, and a trim that only just covers it is a trim that
  // stops covering it the first time a species gets fatter.
  const cutR = 2 * Math.max(num(a.r, 8), num(b.r, 8)) + 4;
  const cutA = toFrame(cylinder(cutR, 2 * cutR, { segments, ctx, z0: faceZ }), a);

  // ---- B owns the socket -------------------------------------------------
  // The cavity: the socket sphere — the ball grown by the clearance, which is
  // the whole of how the gap is applied — plus the mouth cone that lets the
  // stalk swing, run well past the rear so it breaks out cleanly rather than
  // leaving a film.
  //
  // cone() is cylinder(r, h, { r2: 0 }) (builders.js:1265), so its apex is at
  // z0 + h. Built at z0 = -depth with height depth, the apex lands exactly on
  // the ball centre and the wide end breaks out behind the socket.
  const socket = sphere(ballR + c, { ...q, z0: -(ballR + c) });
  const depth = ballR + c + wall + 2;
  const mouth = cone(depth * Math.tan(mouthDeg * DEG), depth, { segments, ctx, z0: -depth });
  const cavity = union(socket, mouth);
  const cutB = toFrame(cavity, b);

  // The dome: `wall` of material outside the socket everywhere, hollowed by the
  // same cavity so the two surfaces are the same surface. Its rear is cut by
  // the mouth cone, not by a plane — which is why rearZ is a bound on how far
  // back it can reach rather than where it actually ends.
  const addB = toFrame(subtract(sphere(ballR + c + wall, { ...q, z0: -(ballR + c + wall) }), cavity), b);

  // ---- A again, as a profile instead of a pair of edits ------------------
  //
  // `addA`/`cutA` make the ball by carving: truncate the host's tube on the
  // face plane, union the stalk back on. The stalk crosses that plane, and
  // that crossing is the seam that collapses — measured at roughly 5.7% of
  // ball joints, on the same cells that are clean when the model is laid on
  // the plate at a different angle (sdd-workspace/task-7b-report.md).
  //
  // `profileA` is the same solid described as radii up the joint's own axis,
  // from the face plane to the pole, so a caller that already stitches rings
  // into a tube can carry on through the shoulder, the stalk and the ball
  // without a boolean anywhere. It starts at `faceZ` — no setback, because
  // there is no longer a cut face for a feature to be coplanar with, which is
  // ruling 23's 0.1 mm deleted rather than retuned.
  //
  // THE BALL'S LATITUDES ARE `sphere()`'S OWN, and that is the rule at the top
  // of this file, not a detail: socket and ball must be tessellated alike or
  // the measured gap halves. Hence `nseg` imported from builders rather than
  // rewritten here. The one ring that is NOT a sphere latitude is the stalk
  // junction, and it is safe because it sits at `asin(stalkR/ballR)` off the
  // south pole — inside the mouth cone, where the socket has no surface for it
  // to be parallel to.
  //
  // The caller owns the ring where the body meets the shoulder: this file does
  // not know how fat the host is. Prepend `{ z: faceZ, r: <body radius> }`.
  const nr = nseg(rings, segFactorOf({ ctx }), 2);
  const zJoin = -Math.sqrt(Math.max(0, ballR * ballR - stalkR * stalkR));
  const profileA = [{ z: faceZ, r: stalkR }, { z: zJoin, r: stalkR }];
  for (let j = nr - 1; j >= 1; j--) {
    const phi = Math.PI * j / nr;
    const z = ballR * Math.cos(phi);
    if (z > zJoin + 1e-9) profileA.push({ z, r: ballR * Math.sin(phi) });
  }
  profileA.push({ z: ballR, r: 0 });   // the pole, which a stitcher caps as a fan

  return { addA, cutA, addB, cutB, profileA, limit: { deg: g.swingDeg, axes: 'any' }, geometry: g };
}

/**
 * The NESTED SEAM: the two segments of a ball joint separated by one thin
 * spherical shell about the ball centre, instead of a flat face 4.4 mm back
 * with the stalk showing through the gap.
 *
 *              A (cup, radius Rs + c)    B (dome, radius Rs)
 *       ........\                    /........   skin
 *                 \    c      ______/
 *                  |  |  | /  ( ball )   socket radius ballR + c
 *                 /    stalk  \______
 *       ......../                    \........
 *
 * B's rear is a dome of radius Rs with the socket inside it and the mouth
 * cone carried out through it; A's front is a cup of radius Rs + c around
 * the dome. Every surface is concentric with the pivot, so turning B about the
 * ball keeps the shell's gap exactly c: nothing on either side can meet
 * anything on the other except the stalk against the mouth, which is the
 * joint's designed stop. With Rs larger than the body radius the sphere
 * crosses the whole section and the seam on the skin is a line about 1 mm
 * wide (c * Rs / sqrt(Rs^2 - r^2)), not a gap.
 *
 * AND IT IS ALL STITCHED. Socket, mouth, dome and cup are surfaces of
 * revolution about the joint axis, so both sides come back as ring profiles
 * for a stitcher, like `profileA` already is. That deletes the B side's
 * boolean, which is where every remaining joint defect lived (ruling 41).
 * The socket's rings sit on the ball's own latitudes, so the facets stay in
 * step and the measured gap is the aligned figure.
 *
 * Profiles are {z, r} along the joint axis from the pivot, +z towards B.
 * `profileB` runs from inside the socket (its front pole) back round the
 * socket to the mouth, out along the mouth cone, and over the dome to the
 * seam ring at radius `r`: prepend it to B's body rings. `profileA` runs from
 * the rim at radius `r` in along the cup to the stalk, then up the stalk and
 * over the ball to its pole: append it to A's body rings.
 */
export const NESTED_LATITUDES = 18;

export function nestedSeam(g, { r, Rs, rings = 12, ctx = null }) {
  const { ballR, stalkR, c, mouthDeg } = g;
  const R = ballR + c, Rc = Rs + c, M = mouthDeg * DEG;
  if (!(Rs > r)) throw new Error(`nestedSeam(): the shell (Rs ${Rs}) must be wider than the body (r ${r}) to cross it`);
  if (!(Rs - R > 0.8)) throw new Error(`nestedSeam(): the dome must leave wall round the socket (Rs ${Rs}, socket ${R})`);
  // The ball's latitude step, so socket rings land on the ball's latitudes.
  // At least NESTED_LATITUDES round the half-turn at any quality: a faceted
  // dome turned inside a faceted cup cuts into the gap by the facets' sag,
  // and draft's 6 latitudes (30 degrees; 0.5 mm of sag on a 16 mm dome, more
  // than the whole gap) stopped the capybara bending at 4 degrees.
  const nr = Math.max(NESTED_LATITUDES, nseg(rings, segFactorOf({ ctx }), 2));
  const step = Math.PI / nr;
  // Dome and cup break at the SAME angles wherever both exist, so their
  // facets are parallel and the shell between them is c thick throughout,
  // the same rule as ball and socket. Each side's end angles go in the other.
  const aDome = Math.asin(r / Rs), aCup = Math.asin(r / Rc);
  const extra = [M, aDome, aCup];
  const grid = (a0, a1) => {
    const out = [a0];
    for (let k = Math.floor(a0 / step) + 1; k * step < a1 - 1e-9; k++) out.push(k * step);
    for (const e of extra) if (e > a0 + 1e-9 && e < a1 - 1e-9) out.push(e);
    out.sort((x, y) => x - y);
    out.push(a1);
    return out.filter((a, i) => i === 0 || a - out[i - 1] > 1e-9);
  };
  // Angles are measured from the axis BEHIND the pivot (towards A).
  const at = (rad, a) => ({ z: -rad * Math.cos(a), r: rad * Math.sin(a) });
  const socket = grid(M, Math.PI).reverse().map(a => at(R, a));
  socket[0] = { z: R, r: 0 };                                   // the front pole, exactly
  const dome = grid(M, aDome).map(a => at(Rs, a));  // starts on the mouth cone
  const aStalk = Math.asin(Math.min(1, stalkR / Rc));
  const cup = grid(aStalk, aCup).reverse().map(a => at(Rc, a));
  // The stalk and ball, as ballJoint builds them, from where the stalk
  // leaves the ball; the cup's last ring is the stalk's start.
  const zJoin = -Math.sqrt(Math.max(0, ballR * ballR - stalkR * stalkR));
  const ball = [{ z: zJoin, r: stalkR }];
  for (let j = nr - 1; j >= 1; j--) {
    const phi = Math.PI * j / nr, z = ballR * Math.cos(phi);
    if (z > zJoin + 1e-9) ball.push({ z, r: ballR * Math.sin(phi) });
  }
  ball.push({ z: ballR, r: 0 });
  return {
    profileA: [...cup, ...ball], profileB: [...socket, ...dome],
    Rs, Rc, seamA: -Math.sqrt(Rc * Rc - r * r), seamB: -Math.sqrt(Rs * Rs - r * r),
    seamWidth: Math.sqrt(Rc * Rc - r * r) - Math.sqrt(Rs * Rs - r * r),
  };
}

/** Dimensions of the interleaved hinge. face is the body setback on BOTH sides.
 * The declared swing is guaranteed clearance, not an exact mechanical stop:
 * body/body needs r*tan(swing/2), while body/knuckle needs knuckleR.
 * The larger bound wins. Tongues occupy disjoint bands along the pin. */
export function hingeGeometry({ r = 8, clearance = fit('free'), pinFrac = 0.22,
                                swingDeg = 40 } = {}) {
  const radius = num(r, 8);
  const c = Math.max(0, num(clearance, fit('free')));
  const swing = clamp(num(swingDeg, 40), 1, 80);
  const width = 1.6 * radius;
  const leaf = (width - 2 * c) / 3;
  const pinR = Math.max(1.2, num(pinFrac, 0.22) * radius);
  const knuckleR = pinR + Math.max(1.0, 0.8 * pinR);
  if (radius <= 0 || leaf <= 0 || pinR + c >= knuckleR) {
    throw new Error('hingeGeometry(): radius and clearance must leave positive leaves and bore wall');
  }
  const face = Math.max(knuckleR, radius * Math.tan(swing * DEG / 2)) + c;
  return { pinR, knuckleR, width, leaf, c, face, swingDeg: swing };
}

function hingeJoint({ a, b, clearance = fit('free'), swingDeg = 40, pinFrac = 0.22,
                      axis = 'b', segments = 48, ctx = null } = {}) {
  if (!a || !b) throw new Error("joint('hinge'): needs both stations a and b");
  if (axis !== 'b' && axis !== 'n') throw new Error("joint('hinge'): axis must be 'b' or 'n'");
  const rMin = Math.min(num(a.r, 8), num(b.r, 8));
  const rMax = Math.max(num(a.r, 8), num(b.r, 8));
  const g = hingeGeometry({ r: rMin, clearance, swingDeg, pinFrac });
  // The larger host sets the swing envelope even when leaves use the smaller.
  g.face = Math.max(g.knuckleR, rMax * Math.tan(g.swingDeg * DEG / 2)) + g.c;
  const { pinR, knuckleR, width, leaf, c, face } = g;
  const along = mesh => axis === 'n' ? mesh : mesh.rotateZ(Math.PI / 2);
  const place = (mesh, frame) => toFrame(along(mesh), frame);
  const axial = (x, w, r) => cylinder(r, w, { segments, ctx })
    .rotateY(Math.PI / 2).translate(x, 0, 0);
  // Each knuckle has a tongue reaching INTO the recessed host, not merely
  // touching it. Without these, the brief's three leaves are detached shells.
  const tongue = (x, positive) => box(leaf, 2 * pinR, face + 1,
    { z0: positive ? 0 : -face - 1 }).translate(x + leaf / 2, 0, 0);
  const left = -width / 2, right = width / 2 - leaf;
  const outer = union(union(axial(left, leaf, knuckleR), tongue(left, false)),
                      union(axial(right, leaf, knuckleR), tongue(right, false)));
  const bore = axial(-width / 2 - 1, width + 2, pinR + c);
  const addA = place(subtract(outer, bore), a);
  const centre = union(axial(-leaf / 2, leaf, knuckleR), tongue(-leaf / 2, true));
  const addB = place(union(centre, axial(-width / 2, width, pinR)), b);
  // Trim both hosts before adding either feature. The plan's central relief
  // alone leaves body material across the pin and welds the assembly together.
  const extent = 4 * rMax + 2 * face + 4;
  const cutA = place(box(extent, extent, extent, { z0: -face }), a);
  const cutB = place(box(extent, extent, extent, { z0: face - extent }), b);
  return { addA, cutA, addB, cutB, geometry: g,
    limit: { deg: g.swingDeg, axes: 'one', axis } };
}

export function joint(kind, opts = {}) {
  switch (kind) {
    case 'ball': return ballJoint(opts);
    case 'hinge': return hingeJoint(opts);
    default: throw new Error(`joint(): unknown kind ${JSON.stringify(kind)}`);
  }
}

export default { joint, ballGeometry, hingeGeometry, nestedSeam, JOINT_KINDS };
