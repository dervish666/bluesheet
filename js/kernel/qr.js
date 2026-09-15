// QR Code Model 2 encoder, ISO/IEC 18004, written from the specification.
//
// Pure: no DOM, no state between calls, no randomness. The same text and the
// same options give the same matrix every time, which the generator tests rely
// on and which a printable object has to be anyway — you cannot hand somebody a
// plaque that reads differently from the preview.
//
// Scope: versions 1–40, error-correction levels L/M/Q/H, numeric, alphanumeric
// and byte (UTF-8) modes, all eight masks with the four penalty rules for the
// automatic choice, format and version information, the finder, alignment and
// timing patterns. Kanji mode is not implemented: UTF-8 in byte mode carries
// any text, and every phone reads it. Micro QR is out of scope.
//
// The algorithm follows the structure of Nayuki's public-domain reference
// implementation (segment → bit stream → block interleave → placement → mask),
// which is the clearest published description of the standard; the tables are
// the standard's own. Everything here is cross-checked in tests/qr.test.mjs
// against published vectors, against an independent encoder (segno) module for
// module, and against an independent decoder (zbar).

// ---------------------------------------------------------------------------
// Error-correction levels
// ---------------------------------------------------------------------------

/** Order used by the version tables. `bits` is the 2-bit code in the format information. */
export const ECC_LEVELS = {
  L: { ordinal: 0, bits: 1, name: 'L', recovers: 7 },
  M: { ordinal: 1, bits: 0, name: 'M', recovers: 15 },
  Q: { ordinal: 2, bits: 3, name: 'Q', recovers: 25 },
  H: { ordinal: 3, bits: 2, name: 'H', recovers: 30 },
};

function eccOf(level) {
  const e = ECC_LEVELS[String(level || 'M').toUpperCase()];
  if (!e) throw new Error(`qr: unknown error-correction level "${level}" (L|M|Q|H)`);
  return e;
}

// Rows: L, M, Q, H. Columns: version 0 (unused) .. 40. ISO/IEC 18004 table 9.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

function checkVersion(v) {
  if (!Number.isInteger(v) || v < MIN_VERSION || v > MAX_VERSION) throw new Error(`qr: version must be 1..40, got ${v}`);
}

/** Side length in modules. */
export function sizeOf(version) { checkVersion(version); return version * 4 + 17; }

/**
 * Modules available for data + error correction after the function patterns
 * are drawn (ISO 18004 table 1). Derived rather than tabled: the finders,
 * separators, timing tracks and format areas are the same shape for every
 * version, and only the alignment count and the version-information blocks
 * change.
 */
export function numRawDataModules(version) {
  checkVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) at a version and level: everything that is not error correction. */
export function numDataCodewords(version, level) {
  const e = eccOf(level);
  return Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[e.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[e.ordinal][version];
}

/** The block structure at a version and level. */
export function blockInfo(version, level) {
  const e = eccOf(level);
  checkVersion(version);
  return { blocks: NUM_ERROR_CORRECTION_BLOCKS[e.ordinal][version], eccPerBlock: ECC_CODEWORDS_PER_BLOCK[e.ordinal][version] };
}

/**
 * Centre coordinates of the alignment patterns along one axis. The spacing rule
 * is the standard's: evenly spread between 6 and size-7, rounded to even, with
 * version 32 the one documented exception.
 */
export function alignmentPositions(version) {
  checkVersion(version);
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = sizeOf(version);
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------------------
// GF(256) and Reed–Solomon
// ---------------------------------------------------------------------------

// The field is GF(2^8) modulo the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
// (0x11D), generator α = 2. Multiplication is done by log/antilog tables built
// once, which is what makes encoding a version-40 symbol cheap.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

/** α^n in GF(256). */
export function gfExp(n) { return GF_EXP[((n % 255) + 255) % 255]; }
/** log_α(x); undefined for 0, which has no logarithm. */
export function gfLog(x) { if (x === 0) throw new Error('qr: log(0) is undefined'); return GF_LOG[x & 0xFF]; }

/** Multiply in GF(256). */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * The Reed–Solomon generator polynomial of the given degree: the product
 * (x - α^0)(x - α^1)…(x - α^(degree-1)), as coefficients of descending powers
 * including the leading 1, so `rsGenerator(7)` has eight entries and `[0]` is 1.
 */
export function rsGenerator(degree) {
  if (!Number.isInteger(degree) || degree < 1 || degree > 255) throw new Error(`qr: RS degree out of range: ${degree}`);
  // Start with the polynomial "1" and multiply by (x - α^i) each round.
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i];
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                       // × x
      next[j + 1] ^= gfMul(poly[j], root);      // × α^i
    }
    poly = next;
  }
  return poly;
}

/**
 * Error-correction codewords for a block of data: the remainder of
 * data(x)·x^degree divided by the generator polynomial.
 */
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export const MODES = {
  numeric: { bits: 0x1, countBits: [10, 12, 14] },
  alphanumeric: { bits: 0x2, countBits: [9, 11, 13] },
  byte: { bits: 0x4, countBits: [8, 16, 16] },
  eci: { bits: 0x7, countBits: [0, 0, 0] },
};

function charCountBits(mode, version) {
  return MODES[mode].countBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];
}

export function isNumeric(text) { return /^[0-9]*$/.test(text); }
export function isAlphanumeric(text) {
  for (const ch of text) if (ALPHANUMERIC_CHARSET.indexOf(ch) < 0) return false;
  return true;
}

/** UTF-8 bytes of a string, without TextEncoder so it runs anywhere. */
export function utf8Bytes(text) {
  const out = [];
  for (const ch of String(text)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return out;
}

class BitBuffer {
  constructor() { this.bits = []; }
  get length() { return this.bits.length; }
  append(value, count) {
    if (count < 0 || count > 31 || (value >>> count) !== 0) throw new Error(`qr: value ${value} does not fit in ${count} bits`);
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  appendBits(bits) { for (const b of bits) this.bits.push(b); }
}

/**
 * A segment: one run of text in one mode. `numChars` is what the character
 * count field carries (characters for numeric/alphanumeric, BYTES for byte).
 */
export function makeSegment(text, mode = null) {
  const s = String(text);
  const chosen = mode || (isNumeric(s) ? 'numeric' : isAlphanumeric(s) ? 'alphanumeric' : 'byte');
  const buf = new BitBuffer();
  if (chosen === 'numeric') {
    if (!isNumeric(s)) throw new Error('qr: numeric mode needs digits only');
    for (let i = 0; i < s.length; i += 3) {
      const chunk = s.slice(i, i + 3);
      buf.append(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
    return { mode: chosen, numChars: s.length, bits: buf.bits };
  }
  if (chosen === 'alphanumeric') {
    if (!isAlphanumeric(s)) throw new Error('qr: alphanumeric mode cannot encode this text');
    let i = 0;
    for (; i + 2 <= s.length; i += 2) {
      buf.append(ALPHANUMERIC_CHARSET.indexOf(s[i]) * 45 + ALPHANUMERIC_CHARSET.indexOf(s[i + 1]), 11);
    }
    if (i < s.length) buf.append(ALPHANUMERIC_CHARSET.indexOf(s[i]), 6);
    return { mode: chosen, numChars: s.length, bits: buf.bits };
  }
  if (chosen === 'byte') {
    const bytes = utf8Bytes(s);
    for (const b of bytes) buf.append(b, 8);
    return { mode: chosen, numChars: bytes.length, bits: buf.bits };
  }
  throw new Error(`qr: unknown mode "${chosen}"`);
}

/** Total bits the segments occupy at a version, or Infinity if a count field overflows. */
export function segmentsBits(segments, version) {
  let total = 0;
  for (const seg of segments) {
    const cc = charCountBits(seg.mode, version);
    if (seg.numChars >= (1 << cc)) return Infinity;
    total += 4 + cc + seg.bits.length;
  }
  return total;
}

/**
 * How many characters of `mode` fit at a version and level. Numeric and
 * alphanumeric count characters; byte counts UTF-8 bytes.
 */
export function capacity(version, level, mode = 'byte') {
  const dataBits = numDataCodewords(version, level) * 8;
  const avail = dataBits - 4 - charCountBits(mode, version);
  if (avail <= 0) return 0;
  if (mode === 'numeric') {
    // Groups of three digits cost 10 bits; a trailing 1 or 2 cost 4 or 7.
    const groups = Math.floor(avail / 10);
    const rest = avail - groups * 10;
    return Math.min((1 << charCountBits(mode, version)) - 1, groups * 3 + (rest >= 7 ? 2 : rest >= 4 ? 1 : 0));
  }
  if (mode === 'alphanumeric') {
    const pairs = Math.floor(avail / 11);
    const rest = avail - pairs * 11;
    return Math.min((1 << charCountBits(mode, version)) - 1, pairs * 2 + (rest >= 6 ? 1 : 0));
  }
  return Math.min((1 << charCountBits(mode, version)) - 1, Math.floor(avail / 8));
}

// ---------------------------------------------------------------------------
// Format and version information
// ---------------------------------------------------------------------------

/** The 15-bit format string: level and mask, BCH(15,5) protected, masked with 0x5412. */
export function formatBits(level, mask) {
  const e = eccOf(level);
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error(`qr: mask must be 0..7, got ${mask}`);
  const data = (e.bits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18-bit version string for versions 7 and up: version number, BCH(18,6) protected. */
export function versionBits(version) {
  checkVersion(version);
  if (version < 7) return null;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (version << 12) | rem;
}

// ---------------------------------------------------------------------------
// Masks and penalties
// ---------------------------------------------------------------------------

/** True where mask `mask` inverts module (x, y). */
export function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new Error(`qr: mask must be 0..7, got ${mask}`);
  }
}

const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

/**
 * The four penalty rules of ISO 18004 §7.8.3.1, scored on a finished symbol.
 * Rule 3 (finder-like 1:1:3:1:1 runs with four light modules beside them) is
 * the one implementations disagree about; this follows the reading where the
 * area outside the symbol counts as light, so a pattern against the edge is
 * still penalised.
 */
export function penaltyScore(modules, size) {
  let result = 0;
  const at = (x, y) => modules[y * size + x] === 1;

  // Rules 1 and 3 along rows, then columns.
  const runHistory = new Int32Array(7);
  const addHistory = (len) => {
    if (runHistory[0] === 0) len += size;   // a leading light run reaches off the edge
    runHistory.copyWithin(1, 0, 6);
    runHistory[0] = len;
  };
  const countPatterns = () => {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
         + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  };
  const terminateAndCount = (runColor, runLength) => {
    if (runColor) { addHistory(runLength); runLength = 0; }
    runLength += size;                       // a trailing light run reaches off the edge
    addHistory(runLength);
    return countPatterns();
  };

  for (let y = 0; y < size; y++) {
    let runColor = false, runX = 0;
    runHistory.fill(0);
    for (let x = 0; x < size; x++) {
      if (at(x, y) === runColor) {
        runX++;
        if (runX === 5) result += PENALTY_N1;
        else if (runX > 5) result++;
      } else {
        addHistory(runX);
        if (!runColor) result += countPatterns() * PENALTY_N3;
        runColor = at(x, y);
        runX = 1;
      }
    }
    result += terminateAndCount(runColor, runX) * PENALTY_N3;
  }
  for (let x = 0; x < size; x++) {
    let runColor = false, runY = 0;
    runHistory.fill(0);
    for (let y = 0; y < size; y++) {
      if (at(x, y) === runColor) {
        runY++;
        if (runY === 5) result += PENALTY_N1;
        else if (runY > 5) result++;
      } else {
        addHistory(runY);
        if (!runColor) result += countPatterns() * PENALTY_N3;
        runColor = at(x, y);
        runY = 1;
      }
    }
    result += terminateAndCount(runColor, runY) * PENALTY_N3;
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += PENALTY_N2;
    }
  }

  // Rule 4: dark proportion away from 50%, in 5% steps.
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

/**
 * Encode text.
 *
 * @param {string} text
 * @param {object} opts
 * @param {'L'|'M'|'Q'|'H'} opts.ecc        minimum error-correction level (default 'M')
 * @param {number} opts.minVersion           default 1
 * @param {number} opts.maxVersion           default 40
 * @param {number} opts.mask                 0..7 to force a mask; -1 (default) chooses by penalty
 * @param {boolean} opts.boostEcc            raise the level when it costs no extra version (default true)
 * @param {string|null} opts.mode            force 'numeric'|'alphanumeric'|'byte'; null picks the densest that fits
 * @returns {{version, ecc, mask, size, modules: Uint8Array, mode, dataBits, capacityBits, penalty}}
 *   `modules` is row-major, `modules[y * size + x]`, 1 = dark. Thrown if the
 *   text does not fit at `maxVersion`.
 */
export function encode(text, opts = {}) {
  const seg = makeSegment(text, opts.mode || null);
  return encodeSegments([seg], opts);
}

export function encodeSegments(segments, opts = {}) {
  const { minVersion = MIN_VERSION, maxVersion = MAX_VERSION, mask = -1, boostEcc = true } = opts;
  let ecc = eccOf(opts.ecc || 'M');
  checkVersion(minVersion); checkVersion(maxVersion);
  if (minVersion > maxVersion) throw new Error(`qr: minVersion ${minVersion} > maxVersion ${maxVersion}`);
  if (!Number.isInteger(mask) || mask < -1 || mask > 7) throw new Error(`qr: mask must be -1..7, got ${mask}`);

  // The smallest version that holds the data at the requested level.
  let version = -1, dataUsedBits = 0;
  for (let v = minVersion; v <= maxVersion; v++) {
    const cap = numDataCodewords(v, ecc.name) * 8;
    const used = segmentsBits(segments, v);
    if (used <= cap) { version = v; dataUsedBits = used; break; }
  }
  if (version < 0) {
    const err = new Error(`qr: data does not fit in version ${maxVersion} at level ${ecc.name}`);
    err.code = 'TOO_LONG';
    throw err;
  }
  // A short payload gets stronger correction for free: the symbol is the same
  // size either way, and a printed code wants every bit of robustness.
  if (boostEcc) {
    for (const lv of ['M', 'Q', 'H']) {
      const e = ECC_LEVELS[lv];
      if (e.ordinal > ecc.ordinal && dataUsedBits <= numDataCodewords(version, lv) * 8) ecc = e;
    }
  }

  // Bit stream: segments, terminator, byte alignment, pad codewords.
  const bb = new BitBuffer();
  for (const seg of segments) {
    bb.append(MODES[seg.mode].bits, 4);
    bb.append(seg.numChars, charCountBits(seg.mode, version));
    bb.appendBits(seg.bits);
  }
  const capacityBits = numDataCodewords(version, ecc.name) * 8;
  bb.append(0, Math.min(4, capacityBits - bb.length));
  bb.append(0, (8 - bb.length % 8) % 8);
  for (let pad = 0xEC; bb.length < capacityBits; pad ^= 0xEC ^ 0x11) bb.append(pad, 8);

  const dataCodewords = new Uint8Array(bb.length / 8);
  for (let i = 0; i < bb.bits.length; i++) dataCodewords[i >>> 3] |= bb.bits[i] << (7 - (i & 7));

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecc.name);

  // Draw.
  const size = sizeOf(version);
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);
  drawFunctionPatterns(modules, isFunction, size, version);
  drawCodewords(modules, isFunction, size, allCodewords);

  let chosen = mask, penalty = Infinity;
  if (chosen === -1) {
    for (let m = 0; m < 8; m++) {
      applyMask(modules, isFunction, size, m);
      drawFormatBits(modules, isFunction, size, ecc, m);
      const score = penaltyScore(modules, size);
      if (score < penalty) { penalty = score; chosen = m; }
      applyMask(modules, isFunction, size, m);    // XOR twice restores the unmasked symbol
    }
  }
  applyMask(modules, isFunction, size, chosen);
  drawFormatBits(modules, isFunction, size, ecc, chosen);
  if (penalty === Infinity) penalty = penaltyScore(modules, size);

  return {
    version, ecc: ecc.name, mask: chosen, size, modules,
    mode: segments.length === 1 ? segments[0].mode : 'mixed',
    dataBits: dataUsedBits, capacityBits, penalty,
    dataCodewords, codewords: allCodewords,
  };
}

/**
 * Split the data codewords into blocks, append the Reed–Solomon codewords to
 * each, then interleave so a burst of damage spreads across blocks.
 */
export function addEccAndInterleave(data, version, level) {
  const { blocks: numBlocks, eccPerBlock } = blockInfo(version, level);
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  if (data.length !== rawCodewords - numBlocks * eccPerBlock) throw new Error('qr: wrong number of data codewords');
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - eccPerBlock + (i < numShortBlocks ? 0 : 1);
    const dat = Array.from(data.subarray(k, k + len));
    k += len;
    const ecc = rsRemainder(dat, eccPerBlock);
    if (i < numShortBlocks) dat.push(-1);     // placeholder keeps every block the same length for the interleave
    blocks.push(dat.concat(Array.from(ecc)));
  }

  const result = new Uint8Array(rawCodewords);
  let n = 0;
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i === shortBlockLen - eccPerBlock && j < numShortBlocks) continue;
      result[n++] = blocks[j][i];
    }
  }
  return result;
}

function setFn(modules, isFunction, size, x, y, dark) {
  modules[y * size + x] = dark ? 1 : 0;
  isFunction[y * size + x] = 1;
}

function drawFunctionPatterns(modules, isFunction, size, version) {
  for (let i = 0; i < size; i++) {
    setFn(modules, isFunction, size, 6, i, i % 2 === 0);
    setFn(modules, isFunction, size, i, 6, i % 2 === 0);
  }
  drawFinder(modules, isFunction, size, 3, 3);
  drawFinder(modules, isFunction, size, size - 4, 3);
  drawFinder(modules, isFunction, size, 3, size - 4);

  const pos = alignmentPositions(version);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The three that would sit on a finder are left out.
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(modules, isFunction, size, pos[i], pos[j]);
    }
  }

  // Reserve the format and version areas so data placement skips them; the
  // real bits are drawn once the mask is known.
  drawFormatBits(modules, isFunction, size, ECC_LEVELS.L, 0);
  drawVersion(modules, isFunction, size, version);
}

function drawFinder(modules, isFunction, size, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(modules, isFunction, size, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(modules, isFunction, size, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(modules, isFunction, size, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(modules, isFunction, size, ecc, mask) {
  const bits = formatBits(ecc.name, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) setFn(modules, isFunction, size, 8, i, bit(i));
  setFn(modules, isFunction, size, 8, 7, bit(6));
  setFn(modules, isFunction, size, 8, 8, bit(7));
  setFn(modules, isFunction, size, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(modules, isFunction, size, 14 - i, 8, bit(i));
  // Split between the other two finders.
  for (let i = 0; i < 8; i++) setFn(modules, isFunction, size, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFn(modules, isFunction, size, 8, size - 15 + i, bit(i));
  setFn(modules, isFunction, size, 8, size - 8, true);    // the module that is always dark
}

function drawVersion(modules, isFunction, size, version) {
  const bits = versionBits(version);
  if (bits === null) return;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = size - 11 + i % 3, b = Math.floor(i / 3);
    setFn(modules, isFunction, size, a, b, bit);
    setFn(modules, isFunction, size, b, a, bit);
  }
}

/** Codewords snake up and down in two-module columns from the right, skipping the timing column. */
function drawCodewords(modules, isFunction, size, data) {
  let i = 0;
  const total = data.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y * size + x] && i < total) {
          modules[y * size + x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
  // Remainder bits (up to 7) stay light, which is what a zero-initialised array gives.
}

function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!isFunction[i] && maskBit(mask, x, y)) modules[i] ^= 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Render-free dumps, for tests and for eyes
// ---------------------------------------------------------------------------

/** The matrix as lines of text. Two characters per module keeps it square in a monospace font. */
export function toText(qr, { dark = '##', light = '  ', quiet = 0 } = {}) {
  const { size, modules } = qr;
  const lines = [];
  const blank = light.repeat(size + quiet * 2);
  for (let i = 0; i < quiet; i++) lines.push(blank);
  for (let y = 0; y < size; y++) {
    let row = light.repeat(quiet);
    for (let x = 0; x < size; x++) row += modules[y * size + x] ? dark : light;
    lines.push(row + light.repeat(quiet));
  }
  for (let i = 0; i < quiet; i++) lines.push(blank);
  return lines.join('\n');
}

/**
 * A portable bitmap (PBM, P1) of the symbol with `scale` pixels per module and
 * a quiet zone of `quiet` modules — the plainest image format there is, so a
 * test can hand the symbol to an external decoder with no image library.
 */
export function toPBM(qr, { scale = 8, quiet = 4 } = {}) {
  const { size, modules } = qr;
  const px = (size + quiet * 2) * scale;
  const rows = [`P1`, `${px} ${px}`];
  for (let py = 0; py < px; py++) {
    const y = Math.floor(py / scale) - quiet;
    let row = '';
    for (let mx = 0; mx < size + quiet * 2; mx++) {
      const x = mx - quiet;
      const dark = (y >= 0 && y < size && x >= 0 && x < size) ? modules[y * size + x] : 0;
      row += (dark ? '1' : '0').repeat(scale);
    }
    rows.push(row);
  }
  return rows.join('\n') + '\n';
}

export default { encode, encodeSegments, makeSegment, capacity, toText, toPBM, ECC_LEVELS, MIN_VERSION, MAX_VERSION };
