// Provenance.
//
// A binary STL's 80-byte header is dead space in every other tool. Bluesheet writes
// `Bluesheet <gen> v<n> #<hash>` into it, so a file — or a printed object you still
// have the file for — can be traced back to the generator and parameters that
// made it, and regenerated exactly. It costs nothing, changes no geometry, and
// travels with the file into slicers and file managers that know nothing about
// Bluesheet.
//
// The hash is FNV-1a over a canonicalised parameter object. That is an
// identifier, not a signature: it exists to answer "is this the same object?",
// and it is not, and does not need to be, resistant to anyone constructing a
// collision on purpose.

const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;

export function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable text form of a parameter set.
 * Keys sorted; numbers rounded to 6 decimals so 0.30000000000000004 and 0.3 are
 * the same object; bulk data (an uploaded image, an elevation field) reduced to
 * its dimensions plus a checksum, because embedding a megapixel in a hash input
 * is slow and embedding nothing would make every photo the same object.
 */
export function canonicalise(params) {
  const parts = [];
  for (const key of Object.keys(params).sort()) {
    parts.push(`${key}=${canonValue(params[key])}`);
  }
  return parts.join(';');
}

function canonValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : 'nan';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return `data(${v.length}:${checksum(v)})`;
  if (Array.isArray(v)) return `[${v.map(canonValue).join(',')}]`;
  if (typeof v === 'object') {
    // The bulk types: {w,h,gray} images and {w,h,data} fields.
    const bulk = v.gray || v.data;
    if (ArrayBuffer.isView(bulk)) return `field(${v.w}x${v.h}:${checksum(bulk)})`;
    return `{${canonicalise(v)}}`;
  }
  return String(v);
}

// Every element, every byte of it. This key is the build cache's key, and it
// used to take every 64th value of a 512 x 512 field and the low 16 bits of
// each: a comic edit that missed the sample, or a terrain whose heights moved
// by a multiple of 16 m, got the previous mesh back. The full walk is about
// 11 ms on a 4-megapixel field.
function checksum(arr) {
  let h = FNV_OFFSET;
  for (let i = 0; i < arr.length; i++) {
    const q = Math.round(arr[i] * 4096) | 0;
    h ^= q & 0xff; h = Math.imul(h, FNV_PRIME) >>> 0;
    h ^= (q >>> 8) & 0xff; h = Math.imul(h, FNV_PRIME) >>> 0;
    h ^= (q >>> 16) & 0xff; h = Math.imul(h, FNV_PRIME) >>> 0;
    h ^= q >>> 24; h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  h ^= arr.length; h = Math.imul(h, FNV_PRIME) >>> 0;
  return hex8(h);
}

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

export function paramHash(params) { return hex8(fnv1a(canonicalise(params))); }

/**
 * The string handed to mesh.toSTL(). mesh.toSTL prefixes "Bluesheet ", so the header
 * reads "Bluesheet gridfinity v1 #a3f9c2e1" and still fits the 80 bytes with room to
 * spare for a long generator id.
 */
export function provenance(gen, params) {
  const id = String(gen.id ?? gen).slice(0, 40);
  const version = Number(gen.version ?? 1);
  return `${id} v${version} #${paramHash(params)}`;
}

// "Forge" is the name this tool had until 2026-09-03; STLs written before then
// carry it in their header and must still be recognised.
const RE = /^(?:(?:Bluesheet|Forge)\s+)?([a-z0-9][a-z0-9-]*)\s+v(\d+)\s+#([0-9a-f]{8})/i;

/**
 * Read provenance back out of an STL header, a Uint8Array/ArrayBuffer of a whole
 * STL file, or a bare string. Returns null when the file was not made here,
 * which is the common case and is not an error.
 */
export function parseProvenance(input) {
  let text = null;
  if (typeof input === 'string') text = input;
  else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const u8 = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (u8.length < 80) return null;
    text = new TextDecoder('latin1').decode(u8.subarray(0, 80));
  }
  if (!text) return null;
  const m = RE.exec(text.trim());
  return m ? { gen: m[1], version: Number(m[2]), hash: m[3].toLowerCase() } : null;
}

/** Does this file claim to have come from this generator and these parameters? */
export function matches(input, gen, params) {
  const p = parseProvenance(input);
  if (!p) return false;
  return p.gen === String(gen.id ?? gen) && p.version === Number(gen.version ?? 1) && p.hash === paramHash(params);
}
