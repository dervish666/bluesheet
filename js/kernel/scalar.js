// The small numeric helpers every generator reaches for.
//
// Before this module `clamp` was defined in twelve of the thirteen generator
// files, `num` in nine and `DEG` in six. None of that was expensive, but it did
// mean there was no single place to be right — and one of them was in fact not
// the same function as the others (see `num`).
//
// What is deliberately NOT here: `lerp`, `int`, `nseg` and `smoothstep`. Each of
// those also appears in several generators, and each appears in forms that are
// NOT equivalent:
//
//   lerp        terrain writes `a * (1 - t) + b * t` and says in a comment that
//               its tile seams depend on the result being exact at t = 0 and
//               t = 1; datasculpt writes `a + (b - a) * t`, which is not.
//   int         gridfinity's coerces through num() and clamps to a range;
//               terrain's only rounds, and takes two arguments rather than four.
//   nseg        three different signatures, one of which has a different arity.
//   smoothstep  datasculpt's clamps its input to [0, 1]; lithophane's `smooth`
//               does not, and is only ever handed values already in range.
//
// Hoisting those would mean picking one implementation and silently changing the
// behaviour of the others. They stay local until someone reconciles them on
// purpose, with tests that say which answer is the right one.
//
// `TAU` is not here either: mesh.js already exports it (so does poly2d.js).
// A third definition would make the problem worse rather than better.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * Hold `v` between `lo` and `hi`.
 *
 * NaN passes straight through — `NaN < lo` and `NaN > hi` are both false — which
 * is deliberate. A NaN here means a parameter arrived broken, and quietly
 * turning it into `lo` would hide that at the point it is cheapest to see.
 */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * A finite number, or `d` if there isn't one.
 *
 * Strings are parsed. Two variants of this existed across the generators: one
 * that rejected anything not already typed as a number, and one that ran
 * parseFloat first. Through the interface and the CLI the difference is
 * invisible, because both route every parameter through `coerce()` in
 * js/gen/index.js before build() is called. It shows up on the batch path in
 * tools/bluesheet.mjs, which spreads a JSON file's params straight into build():
 * there a written `"35"` reached the strict generators and silently became the
 * default, while skadis and hooks read it as 35.
 *
 * Parsing is the superset — every value that worked under the strict form still
 * gives the same answer — so that is the form that survived.
 */
export function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : d;
}

/** Render quality out of the build context: 0.5 draft, 1 normal, 2 fine. */
export function segScale(ctx) { return clamp(num(ctx && ctx.segFactor, 1), 0.4, 3); }
