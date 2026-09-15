// The shared scalar helpers. Small enough that the interesting part is not
// whether they work but whether they still mean what the generators that gave
// them up assumed they meant — so most of these checks pin a decision rather
// than exercise arithmetic.
import { suite, check, near, done } from './lib/assert.mjs';
import { DEG, RAD, clamp, num, segScale } from '../js/kernel/scalar.js';

suite('scalar');

// ---- the constants --------------------------------------------------------
{
  near('DEG turns 180 degrees into pi', 180 * DEG, Math.PI, 1e-15);
  near('RAD turns pi back into 180 degrees', Math.PI * RAD, 180, 1e-13);
  near('DEG and RAD are exact inverses over a round trip', 37 * DEG * RAD, 37, 1e-13);
  check('DEG matches the local definition every generator used', DEG === Math.PI / 180);
  check('RAD matches the local definition every generator used', RAD === 180 / Math.PI);
}

// ---- clamp ----------------------------------------------------------------
{
  check('a value inside the range is returned unchanged', clamp(5, 0, 10) === 5);
  check('a value below the range comes back as the low bound', clamp(-3, 0, 10) === 0);
  check('a value above the range comes back as the high bound', clamp(99, 0, 10) === 10);
  check('the bounds themselves are inside the range', clamp(0, 0, 10) === 0 && clamp(10, 0, 10) === 10);
  check('negative ranges work', clamp(-50, -20, -5) === -20);
  check('a zero-width range collapses to its one value', clamp(7, 3, 3) === 3);

  // Pinned deliberately: see the comment on clamp(). A parameter that arrives
  // NaN should stay visible, not silently become the minimum.
  check('NaN passes through rather than becoming a bound', Number.isNaN(clamp(NaN, 0, 10)));
  check('Infinity is clamped like any other large number', clamp(Infinity, 0, 10) === 10);
  check('-Infinity is clamped like any other small number', clamp(-Infinity, 0, 10) === 0);
}

// ---- num ------------------------------------------------------------------
{
  check('a number is returned as itself', num(42, 7) === 42);
  check('zero is a number, not a missing value', num(0, 7) === 0);
  check('a negative number survives', num(-4.5, 7) === -4.5);
  check('undefined falls back to the default', num(undefined, 7) === 7);
  check('null falls back to the default', num(null, 7) === 7);
  check('NaN falls back to the default', num(NaN, 7) === 7);
  check('Infinity is not finite, so it falls back', num(Infinity, 7) === 7);
  check('a non-numeric string falls back', num('banana', 7) === 7);
  check('an object falls back', num({}, 7) === 7);

  // The decision this module exists to make. Both forms agreed on everything
  // above; they disagreed only here, and the batch path in tools/bluesheet.mjs is
  // where that disagreement was reachable.
  check('a numeric string is PARSED, not rejected', num('35', 7) === 35);
  check('a decimal string is parsed', num('2.5', 7) === 2.5);
  check('a string with trailing units is parsed to its number', num('35mm', 7) === 35);
  check('an empty string falls back rather than becoming zero', num('', 7) === 7);
  check('a whitespace string falls back', num('   ', 7) === 7);
}

// ---- segScale -------------------------------------------------------------
{
  near('no context at all is normal quality', segScale(undefined), 1);
  near('an empty context is normal quality', segScale({}), 1);
  near('draft passes through', segScale({ segFactor: 0.5 }), 0.5);
  near('fine passes through', segScale({ segFactor: 2 }), 2);
  near('a silly-low factor is clamped to 0.4', segScale({ segFactor: 0.01 }), 0.4);
  near('a silly-high factor is clamped to 3', segScale({ segFactor: 500 }), 3);
  near('a garbage factor falls back to normal', segScale({ segFactor: 'lots' }), 1);
  near('null context does not throw', segScale(null), 1);
  // segScale is what stops a quality slider from being a denial of service:
  // segment counts multiply through every ring in a build.
  check('the clamped range is exactly [0.4, 3]',
    segScale({ segFactor: -99 }) === 0.4 && segScale({ segFactor: 99 }) === 3);
}

done();
