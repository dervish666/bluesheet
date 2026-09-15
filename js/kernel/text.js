// js/kernel/text.js — TrueType outlines → poly2d shapes.
//
// No library, no canvas, no DOM. A nameplate generator hands this module a .ttf
// as an ArrayBuffer and gets back rings it can feed straight to
// poly2d.triangulate()/offset() and builders.extrude().
//
// Scope is deliberately narrow: `glyf` outlines only. That covers every font we
// bundle and the overwhelming majority of free faces. CFF/OTTO fonts get a clear
// error rather than a plausible-looking mess — a silently empty nameplate is a
// far worse failure than a refusal.
//
// Coordinates: font units on the way out of `Font`, millimetres on the way out
// of `layoutText`. Y is up in both, which matches both TrueType and Bluesheet.

// ---------------------------------------------------------------------------
// Errors and byte plumbing
// ---------------------------------------------------------------------------

export class FontError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FontError';
    Object.assign(this, detail);
  }
}

/**
 * A bounds-checked cursor over one table. Every read is checked because font
 * files arrive from users: a truncated upload must produce a named error, not
 * NaN coordinates that turn into a mesh nobody can slice.
 */
class Reader {
  constructor(view, start = 0, end = view.byteLength, what = 'font') {
    this.v = view; this.pos = start; this.start = start; this.end = end; this.what = what;
  }
  need(n) {
    if (this.pos < this.start || this.pos + n > this.end) {
      throw new FontError(
        `${this.what}: read of ${n} byte(s) at offset ${this.pos} runs outside the table ` +
        `(valid ${this.start}..${this.end}) — the file looks truncated or corrupt`);
    }
  }
  seek(p) { this.pos = p; return this; }
  skip(n) { this.pos += n; return this; }
  get remaining() { return this.end - this.pos; }
  u8()  { this.need(1); return this.v.getUint8(this.pos++); }
  i8()  { this.need(1); return this.v.getInt8(this.pos++); }
  u16() { this.need(2); const x = this.v.getUint16(this.pos); this.pos += 2; return x; }
  i16() { this.need(2); const x = this.v.getInt16(this.pos);  this.pos += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.pos); this.pos += 4; return x; }
  i32() { this.need(4); const x = this.v.getInt32(this.pos);  this.pos += 4; return x; }
  // F2Dot14: signed 2.14 fixed point, the composite-glyph scale format.
  f2dot14() { return this.i16() / 16384; }
  tag() {
    this.need(4);
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.v.getUint8(this.pos + i));
    this.pos += 4;
    return s;
  }
}

/** Accepts ArrayBuffer, Node Buffer, or any TypedArray/DataView. */
function toView(data) {
  if (data instanceof DataView) return data;
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new FontError('loadFont expects an ArrayBuffer, TypedArray or Buffer, got ' +
    (data === null ? 'null' : typeof data));
}

/**
 * What kind of font file is this? Cheap enough to call before loadFont, and the
 * server uses it to filter an uploads directory without parsing everything.
 * @returns {'truetype'|'ttc'|'cff'|'woff'|'woff2'|'unknown'}
 */
export function sniffFontFormat(data) {
  let v;
  try { v = toView(data); } catch { return 'unknown'; }
  if (v.byteLength < 4) return 'unknown';
  const t = v.getUint32(0);
  switch (t) {
    case 0x00010000: return 'truetype';   // the usual TrueType version stamp
    case 0x74727565: return 'truetype';   // 'true' — old Apple TrueType
    case 0x74746366: return 'ttc';        // 'ttcf' — a collection of faces
    case 0x4f54544f: return 'cff';        // 'OTTO' — CFF outlines, not glyf
    case 0x774f4646: return 'woff';       // 'wOFF'
    case 0x774f4632: return 'woff2';      // 'wOF2'
    default: return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers. Deliberately local: text.js is a leaf module and must not
// depend on poly2d.js (different owner, and this file has to import in a bare
// Node process with nothing else present). The definitions match poly2d's
// contract exactly — CCW is positive area, a ring is implicitly closed.
// ---------------------------------------------------------------------------

function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return a / 2;
}

function ringBounds(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Crossing-number point-in-ring. Boundary cases are not meaningful for glyph
 *  nesting (contours never touch), so no special-casing. */
function pointInRing(p, ring) {
  const [px, py] = p;
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py)) {
      const x = xi + (py - yi) * (xj - xi) / (yj - yi);
      if (x > px) inside = !inside;
    }
  }
  return inside;
}

/**
 * A point strictly inside a ring — used to decide nesting.
 *
 * Testing a *vertex* of the child against the parent is the cheap version and it
 * is wrong the moment two contours share a point (some fonts do this on
 * over-lapping strokes). Instead: pick a scanline that misses every vertex, take
 * the first pair of crossings, and return the midpoint. That point is interior
 * for any simple polygon.
 */
function interiorPoint(ring) {
  const ys = [...new Set(ring.map(p => p[1]))].sort((a, b) => a - b);
  if (ys.length < 2) return null;
  const y = (ys[ys.length >> 1] + ys[(ys.length >> 1) - 1]) / 2;
  const xs = [];
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  return [(xs[0] + xs[1]) / 2, y];
}

/**
 * Flatten one quadratic Bézier to line segments, adaptively.
 *
 * The segment count comes from the curve's second derivative, which for a
 * quadratic is the constant 2·(p0 − 2p1 + p2). The deviation of an n-segment
 * chord approximation is bounded by |p0 − 2p1 + p2| / (4n²), so
 * n = ceil(sqrt(|p0 − 2p1 + p2| / (4·tol))) hits the tolerance in one step with
 * no recursion and no wasted points. Because tol is expressed in the *output*
 * units, a 5 mm letter and a 100 mm letter automatically get different counts
 * (the ratio is sqrt(20) ≈ 4.5×), which is the whole point of doing this
 * adaptively rather than with a fixed segment count.
 *
 * Returns the points *after* p0, ending exactly on p2, so contour assembly can
 * concatenate without deduplicating.
 */
export function flattenQuadratic(p0, p1, p2, tol = 0.05, maxSegments = 96) {
  const dx = p0[0] - 2 * p1[0] + p2[0];
  const dy = p0[1] - 2 * p1[1] + p2[1];
  const dev = Math.hypot(dx, dy);
  let n = 1;
  if (dev > 0 && tol > 0) n = Math.ceil(Math.sqrt(dev / (4 * tol)));
  else if (tol <= 0) n = maxSegments;
  if (!isFinite(n) || n < 1) n = 1;
  if (n > maxSegments) n = maxSegments;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
              u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

/**
 * Turn a flat list of rings into poly2d shapes: outer ring first and CCW, holes
 * after it and CW.
 *
 * Nesting is decided by containment depth, *not* by the winding the font
 * happens to use. TrueType's stated convention is clockwise-outer, but mirrored
 * composite components silently reverse it and a fair number of shipped fonts
 * simply get it wrong. Depth is convention-free: even depth is solid, odd depth
 * is a hole, and that is also exactly the non-zero fill rule a rasteriser would
 * apply.
 */
export function contoursToShapes(rings, { minArea = 0 } = {}) {
  const kept = [];
  for (const r of rings) {
    if (!r || r.length < 3) continue;
    const a = ringSignedArea(r);
    if (Math.abs(a) <= minArea) continue;
    kept.push({ ring: r, area: a, abs: Math.abs(a), bounds: ringBounds(r), inside: interiorPoint(r) });
  }
  if (!kept.length) return [];
  // Largest first: a container always has larger absolute area than what it
  // contains, so the first enclosing candidate found scanning upwards is the
  // immediate parent.
  kept.sort((p, q) => q.abs - p.abs);

  for (let i = 0; i < kept.length; i++) {
    const c = kept[i];
    c.parent = -1;
    if (!c.inside) continue;
    for (let j = i - 1; j >= 0; j--) {
      const p = kept[j];
      const [x0, y0, x1, y1] = p.bounds;
      if (c.inside[0] < x0 || c.inside[0] > x1 || c.inside[1] < y0 || c.inside[1] > y1) continue;
      if (pointInRing(c.inside, p.ring)) { c.parent = j; break; }
    }
  }
  // A parent is always found at a lower index than its child, so one forward
  // pass gives every depth and the walk provably terminates.
  for (let i = 0; i < kept.length; i++) {
    kept[i].depth = kept[i].parent < 0 ? 0 : kept[kept[i].parent].depth + 1;
  }

  const shapes = [];
  const shapeOf = new Map();          // index in `kept` -> shape it owns
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i];
    if (c.depth % 2 === 0) {
      const ring = c.area > 0 ? c.ring : c.ring.slice().reverse();
      const shape = [ring];
      shapeOf.set(i, shape);
      shapes.push(shape);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i];
    if (c.depth % 2 === 0) continue;
    // A hole's immediate parent is one depth up, hence even, hence already an
    // outer shape. Depth-2 islands (the dot inside a counter) became their own
    // outer shape in the pass above, which is why no ancestor walk is needed.
    shapeOf.get(c.parent).push(c.area < 0 ? c.ring : c.ring.slice().reverse());
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// Table directory
// ---------------------------------------------------------------------------

function readTableDirectory(view, base) {
  const r = new Reader(view, base, view.byteLength, 'table directory');
  r.skip(4);                                  // sfntVersion, already sniffed
  const numTables = r.u16();
  if (numTables === 0 || numTables > 512) {
    throw new FontError(`table directory claims ${numTables} tables, which cannot be right`);
  }
  r.skip(6);                                  // searchRange, entrySelector, rangeShift
  const tables = new Map();
  const truncated = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.skip(4);                                // checksum — not verified; fonts in the
                                              // wild fail it routinely after subsetting
    const offset = r.u32(), length = r.u32();
    // A record that runs past EOF means the file was cut short. Remembering
    // which table it was turns "no outline tables found" — which sounds like the
    // font is the wrong kind — into "the file is truncated", which is the truth.
    if (offset >= view.byteLength || offset + length > view.byteLength) {
      truncated.push({ tag, offset, length });
      if (offset >= view.byteLength) continue;
    }
    tables.set(tag, { tag, offset, length: Math.min(length, view.byteLength - offset) });
  }
  return { tables, truncated };
}

const REQUIRED_TABLES = ['head', 'maxp', 'hhea', 'hmtx', 'cmap', 'loca', 'glyf'];

// ---------------------------------------------------------------------------
// cmap
// ---------------------------------------------------------------------------

// Higher score wins. Full-Unicode subtables beat BMP-only ones, which is the
// whole reason format 12 has to be here: a modern font's format 4 table stops at
// U+FFFF and often omits characters the format 12 table has.
const CMAP_SCORE = new Map([
  ['3,10', 6], ['0,6', 5], ['0,4', 5], ['3,1', 4], ['0,3', 3], ['0,2', 3],
  ['0,1', 3], ['0,0', 3], ['3,0', 2], ['1,0', 1],
]);
// 2 is legacy CJK high-byte mapping and 13/14 are fallback/variation tables —
// none of them describe a Latin nameplate, so they are simply not candidates.
const CMAP_FORMATS = new Set([0, 4, 6, 12]);

function parseCmap(view, table) {
  const r = new Reader(view, table.offset, table.offset + table.length, 'cmap');
  r.skip(2);
  const n = r.u16();
  let best = null, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const platform = r.u16(), encoding = r.u16(), offset = r.u32();
    const at = table.offset + offset;
    if (at + 4 > table.offset + table.length) continue;
    const format = view.getUint16(at);
    if (!CMAP_FORMATS.has(format)) continue;
    const score = (CMAP_SCORE.get(`${platform},${encoding}`) ?? 0) * 10 + (format === 12 ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = { platform, encoding, format, at }; }
  }
  if (!best) throw new FontError('cmap has no subtable in a format this parser can read (needs 0, 4, 6 or 12)');
  const end = table.offset + table.length;
  const sub = decodeCmapSubtable(view, best, end);
  sub.platform = best.platform; sub.encoding = best.encoding; sub.format = best.format;
  // A "symbol" cmap (3,0) puts its glyphs in the private-use block at U+F000.
  sub.symbol = best.platform === 3 && best.encoding === 0;
  return sub;
}

function decodeCmapSubtable(view, { format, at }, end) {
  const r = new Reader(view, at, end, `cmap format ${format}`);
  if (format === 0) {
    r.skip(6);
    const map = new Uint8Array(256);
    for (let i = 0; i < 256; i++) map[i] = r.u8();
    return { lookup: cp => (cp < 256 ? map[cp] : 0), count: 256 };
  }
  if (format === 6) {
    r.skip(6);
    const first = r.u16(), n = r.u16();
    const ids = new Uint16Array(n);
    for (let i = 0; i < n; i++) ids[i] = r.u16();
    return { lookup: cp => (cp >= first && cp < first + n ? ids[cp - first] : 0), count: n };
  }
  if (format === 4) {
    r.skip(6);
    const segCount = r.u16() >> 1;
    r.skip(6);
    const endCode = new Uint16Array(segCount), startCode = new Uint16Array(segCount);
    const idDelta = new Int16Array(segCount), idRangeOffset = new Uint16Array(segCount);
    for (let i = 0; i < segCount; i++) endCode[i] = r.u16();
    r.skip(2);                                            // reservedPad
    for (let i = 0; i < segCount; i++) startCode[i] = r.u16();
    for (let i = 0; i < segCount; i++) idDelta[i] = r.i16();
    const idRangeBase = r.pos;
    for (let i = 0; i < segCount; i++) idRangeOffset[i] = r.u16();
    const limit = r.end;
    return {
      count: segCount,
      lookup(cp) {
        if (cp > 0xFFFF) return 0;
        let lo = 0, hi = segCount - 1, seg = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (endCode[mid] < cp) lo = mid + 1;
          else { seg = mid; hi = mid - 1; }
        }
        if (seg < 0 || startCode[seg] > cp) return 0;
        if (idRangeOffset[seg] === 0) return (cp + idDelta[seg]) & 0xFFFF;
        // The spec's famous pointer arithmetic: the offset is measured from the
        // idRangeOffset slot itself, into glyphIdArray which follows it.
        const addr = idRangeBase + seg * 2 + idRangeOffset[seg] + (cp - startCode[seg]) * 2;
        if (addr + 2 > limit) return 0;
        const g = view.getUint16(addr);
        return g === 0 ? 0 : (g + idDelta[seg]) & 0xFFFF;
      },
    };
  }
  // format 12: sorted, non-overlapping coverage groups over the full 21-bit space.
  r.skip(12);
  const nGroups = r.u32();
  if (nGroups > 200000) throw new FontError(`cmap format 12 claims ${nGroups} groups`);
  const start = new Uint32Array(nGroups), stop = new Uint32Array(nGroups), gid = new Uint32Array(nGroups);
  for (let i = 0; i < nGroups; i++) { start[i] = r.u32(); stop[i] = r.u32(); gid[i] = r.u32(); }
  return {
    count: nGroups,
    lookup(cp) {
      let lo = 0, hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cp < start[mid]) hi = mid - 1;
        else if (cp > stop[mid]) lo = mid + 1;
        else return gid[mid] + (cp - start[mid]);
      }
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// name
// ---------------------------------------------------------------------------

function decodeNameString(view, at, len, platform) {
  let s = '';
  if (platform === 1) {                        // Macintosh: one byte per character.
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(at + i));
    return s;
  }
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(view.getUint16(at + i));
  return s;
}

function parseNames(view, table) {
  const r = new Reader(view, table.offset, table.offset + table.length, 'name');
  r.skip(2);                                   // format: 1 adds language-tag records we never need
  const count = r.u16(), stringOffset = r.u16();
  const strings = table.offset + stringOffset;
  const out = new Map();                       // nameID -> {score, text}
  for (let i = 0; i < count; i++) {
    const platform = r.u16(), encoding = r.u16(), language = r.u16();
    const nameID = r.u16(), length = r.u16(), offset = r.u16();
    const at = strings + offset;
    if (at + length > r.end) continue;
    // Prefer Windows/English, then anything Windows or Unicode, then Mac.
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1;
    const prev = out.get(nameID);
    if (prev && prev.score >= score) continue;
    let text;
    try { text = decodeNameString(view, at, length, platform); } catch { continue; }
    text = text.replace(/\0/g, '').trim();
    if (text) out.set(nameID, { score, text });
  }
  const get = id => (out.has(id) ? out.get(id).text : '');
  return {
    family: get(1), style: get(2), unique: get(3), full: get(4),
    version: get(5), postScript: get(6), licence: get(13), licenceURL: get(14),
    all: Object.fromEntries([...out].map(([k, v]) => [k, v.text])),
  };
}

// ---------------------------------------------------------------------------
// Kerning: legacy `kern` table and GPOS pair positioning
// ---------------------------------------------------------------------------

function parseKernTable(view, table) {
  const r = new Reader(view, table.offset, table.offset + table.length, 'kern');
  const pairs = new Map();
  let nTables, appleStyle = false;
  const first = r.u32();
  if (first === 0x00010000) { appleStyle = true; nTables = r.u32(); }     // Apple 1.0 header
  else { r.seek(table.offset); r.skip(2); nTables = r.u16(); }            // Microsoft 0 header
  for (let t = 0; t < nTables && r.remaining > 6; t++) {
    const subStart = r.pos;
    let length, coverage, format;
    if (appleStyle) { length = r.u32(); coverage = r.u16(); r.u16(); format = coverage & 0xFF; }
    else { r.u16(); length = r.u16(); coverage = r.u16(); format = coverage >> 8; }
    const horizontal = appleStyle ? !(coverage & 0x8000) : !!(coverage & 0x0001);
    const minimum   = appleStyle ? !!(coverage & 0x4000) : !!(coverage & 0x0002);
    const crossStream = appleStyle ? !!(coverage & 0x2000) : !!(coverage & 0x0004);
    if (format === 0 && horizontal && !minimum && !crossStream) {
      const nPairs = r.u16();
      r.skip(6);                               // searchRange/entrySelector/rangeShift
      for (let i = 0; i < nPairs && r.remaining >= 6; i++) {
        const left = r.u16(), right = r.u16(), value = r.i16();
        pairs.set(left * 65536 + right, value);
      }
    }
    if (!length || subStart + length <= subStart) break;   // malformed: stop rather than spin
    r.seek(subStart + length);
  }
  return pairs.size ? pairs : null;
}

function parseCoverage(view, at, end) {
  const r = new Reader(view, at, end, 'GPOS coverage');
  const format = r.u16();
  if (format === 1) {
    const n = r.u16();
    const glyphs = new Uint16Array(n);
    for (let i = 0; i < n; i++) glyphs[i] = r.u16();
    return gid => {
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1;
        if (glyphs[m] < gid) lo = m + 1; else if (glyphs[m] > gid) hi = m - 1; else return m; }
      return -1;
    };
  }
  if (format === 2) {
    const n = r.u16();
    const s = new Uint16Array(n), e = new Uint16Array(n), idx = new Uint16Array(n);
    for (let i = 0; i < n; i++) { s[i] = r.u16(); e[i] = r.u16(); idx[i] = r.u16(); }
    return gid => {
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1;
        if (gid < s[m]) hi = m - 1; else if (gid > e[m]) lo = m + 1; else return idx[m] + (gid - s[m]); }
      return -1;
    };
  }
  return () => -1;
}

function parseClassDef(view, at, end) {
  const r = new Reader(view, at, end, 'GPOS class definition');
  const format = r.u16();
  if (format === 1) {
    const start = r.u16(), n = r.u16();
    const cls = new Uint16Array(n);
    for (let i = 0; i < n; i++) cls[i] = r.u16();
    return gid => (gid >= start && gid < start + n ? cls[gid - start] : 0);
  }
  if (format === 2) {
    const n = r.u16();
    const s = new Uint16Array(n), e = new Uint16Array(n), c = new Uint16Array(n);
    for (let i = 0; i < n; i++) { s[i] = r.u16(); e[i] = r.u16(); c[i] = r.u16(); }
    return gid => {
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1;
        if (gid < s[m]) hi = m - 1; else if (gid > e[m]) lo = m + 1; else return c[m]; }
      return 0;
    };
  }
  return () => 0;
}

const bitCount = v => { let c = 0; while (v) { c += v & 1; v >>= 1; } return c; };
const valueRecordSize = fmt => bitCount(fmt & 0xFF) * 2;
// XAdvance is bit 2; the fields before it are XPlacement and YPlacement.
const xAdvanceOffset = fmt => ((fmt & 0x0004) ? bitCount(fmt & 0x0003) * 2 : -1);

/**
 * Pull horizontal pair kerning out of GPOS.
 *
 * Script and language filtering is skipped on purpose. For Latin text on a
 * nameplate every script system points at the same 'kern' lookups, and the
 * hundred lines of ScriptList/LangSys walking would change nothing while adding
 * a hundred lines that can be wrong. Collect every feature tagged 'kern' and
 * read its type-2 lookups.
 */
function parseGposKern(view, table) {
  const base = table.offset, end = table.offset + table.length;
  const r = new Reader(view, base, end, 'GPOS');
  r.skip(6);
  const featureListOff = r.u16(), lookupListOff = r.u16();
  if (!featureListOff || !lookupListOff) return null;

  const fr = new Reader(view, base + featureListOff, end, 'GPOS feature list');
  const featureCount = fr.u16();
  const wanted = new Set();
  for (let i = 0; i < featureCount; i++) {
    const tag = fr.tag();
    const off = fr.u16();
    if (tag !== 'kern') continue;
    const f = new Reader(view, base + featureListOff + off, end, 'GPOS feature');
    f.skip(2);                                 // featureParams
    const n = f.u16();
    for (let j = 0; j < n; j++) wanted.add(f.u16());
  }
  if (!wanted.size) return null;

  const lr = new Reader(view, base + lookupListOff, end, 'GPOS lookup list');
  const lookupCount = lr.u16();
  const offsets = [];
  for (let i = 0; i < lookupCount; i++) offsets.push(lr.u16());

  const pairs = new Map();
  const classSets = [];
  const readSubtable = (at, type, depth = 0) => {
    if (type === 9) {                          // Extension: a 32-bit hop to the real subtable
      // The spec forbids an extension pointing at another extension, so one hop
      // is all a well-formed font needs and all a corrupt one gets.
      if (depth) return;
      const x = new Reader(view, at, end, 'GPOS extension');
      x.skip(2);
      const realType = x.u16(), delta = x.u32();
      readSubtable(at + delta, realType, depth + 1);
      return;
    }
    if (type !== 2) return;                    // only pair positioning affects advance widths
    const s = new Reader(view, at, end, 'GPOS PairPos');
    const format = s.u16();
    const covOff = s.u16(), vf1 = s.u16(), vf2 = s.u16();
    const xa = xAdvanceOffset(vf1);
    if (xa < 0) return;                        // this lookup adjusts placement, not advance
    const rec1 = valueRecordSize(vf1), rec2 = valueRecordSize(vf2);
    if (format === 1) {
      const n = s.u16();
      const setOffsets = [];
      for (let i = 0; i < n; i++) setOffsets.push(s.u16());
      // Invert the coverage table so pair sets can be keyed by real glyph id.
      const firsts = coverageGlyphs(view, at + covOff, end);
      for (let i = 0; i < n && i < firsts.length; i++) {
        const p = new Reader(view, at + setOffsets[i], end, 'GPOS pair set');
        const count = p.u16();
        for (let j = 0; j < count; j++) {
          const second = p.u16();
          p.need(rec1 + rec2);                 // bounds-check before the raw read below
          const value = view.getInt16(p.pos + xa);
          p.skip(rec1 + rec2);
          if (value) pairs.set(firsts[i] * 65536 + second, value);
        }
      }
    } else if (format === 2) {
      const cd1Off = s.u16(), cd2Off = s.u16();
      const c1n = s.u16(), c2n = s.u16();
      if (c1n * c2n > 1 << 20) return;         // absurd: refuse rather than allocate
      const stride = rec1 + rec2;
      // Check the whole matrix up front: a class table that runs off the end of
      // the font is corrupt, and half of one is worse than none of it.
      if (s.pos + c1n * c2n * stride > end) return;
      const values = new Int16Array(c1n * c2n);
      for (let i = 0; i < c1n; i++) {
        for (let j = 0; j < c2n; j++) {
          values[i * c2n + j] = view.getInt16(s.pos + xa);
          s.skip(stride);
        }
      }
      classSets.push({
        coverage: parseCoverage(view, at + covOff, end),
        class1: parseClassDef(view, at + cd1Off, end),
        class2: parseClassDef(view, at + cd2Off, end),
        c2n, values,
      });
    }
  };

  for (const idx of wanted) {
    if (idx >= lookupCount) continue;
    const at = base + lookupListOff + offsets[idx];
    const l = new Reader(view, at, end, 'GPOS lookup');
    const type = l.u16();
    l.skip(2);                                 // lookupFlag
    const nSub = l.u16();
    for (let i = 0; i < nSub; i++) readSubtable(at + l.u16(), type);
  }
  if (!pairs.size && !classSets.length) return null;
  return { pairs, classSets };
}

/** The glyph ids a coverage table covers, in coverage-index order. */
function coverageGlyphs(view, at, end) {
  const r = new Reader(view, at, end, 'GPOS coverage');
  const format = r.u16();
  const out = [];
  if (format === 1) {
    const n = r.u16();
    for (let i = 0; i < n; i++) out.push(r.u16());
  } else if (format === 2) {
    const n = r.u16();
    for (let i = 0; i < n; i++) {
      const s = r.u16(), e = r.u16(), idx = r.u16();
      for (let g = s; g <= e; g++) out[idx + (g - s)] = g;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

const MAX_COMPOSITE_DEPTH = 6;
const MAX_POINTS_PER_GLYPH = 20000;

export class Font {
  /** Use loadFont(); the constructor is the parse and expects a validated directory. */
  constructor(view, tables, opts = {}) {
    this.view = view;
    this._tables = tables;
    this.tables = [...tables.keys()].sort();
    this.warnings = [];

    const head = this._table('head', true);
    const hr = new Reader(view, head.offset, head.offset + head.length, 'head');
    hr.skip(12);
    if (hr.u32() !== 0x5F0F3CF5) throw new FontError('head table magic number is wrong — this is not a valid sfnt font');
    hr.skip(2);                                                  // flags
    this.unitsPerEm = hr.u16();
    if (!this.unitsPerEm) throw new FontError('head.unitsPerEm is zero');
    hr.skip(16);                                                 // created, modified
    this.headBBox = { xMin: hr.i16(), yMin: hr.i16(), xMax: hr.i16(), yMax: hr.i16() };
    hr.skip(6);                                                  // macStyle, lowestRecPPEM, fontDirectionHint
    this.indexToLocFormat = hr.i16();

    const maxp = this._table('maxp', true);
    this.numGlyphs = new Reader(view, maxp.offset, maxp.offset + maxp.length, 'maxp').skip(4).u16();
    if (!this.numGlyphs) throw new FontError('maxp.numGlyphs is zero — the font has no glyphs');

    const hhea = this._table('hhea', true);
    const ar = new Reader(view, hhea.offset, hhea.offset + hhea.length, 'hhea');
    ar.skip(4);
    this.ascender = ar.i16();
    this.descender = ar.i16();                                   // negative, as stored
    this.lineGap = ar.i16();
    this.maxAdvance = ar.u16();
    ar.skip(22);
    this.numberOfHMetrics = ar.u16();

    this._readHmtx();
    this._readOS2();

    this.cmap = parseCmap(view, this._table('cmap', true));
    this.names = tables.has('name') ? parseNames(view, this._table('name')) : { family: '', style: '', full: '' };
    this.familyName = this.names.family || '';
    this.styleName = this.names.style || '';
    this.name = this.names.full || [this.familyName, this.styleName].filter(Boolean).join(' ') || 'Unnamed font';

    this._readLoca();
    const glyf = this._table('glyf', true);
    this._glyfStart = glyf.offset;
    this._glyfEnd = glyf.offset + glyf.length;

    // Kerning. GPOS first because that is where every font drawn this century
    // keeps it; the legacy `kern` table is the fallback. Fonts carrying both
    // agree on the numbers, so there is nothing to merge — but `kerning:'kern'`
    // forces the old table for the occasional font with a broken GPOS.
    const want = opts.kerning || 'auto';
    if (!['auto', 'gpos', 'kern', 'none'].includes(want)) {
      throw new FontError(`kerning must be auto|gpos|kern|none, got "${want}"`);
    }
    const tryGpos = (want === 'auto' || want === 'gpos') && tables.has('GPOS');
    this._gpos = tryGpos ? this._safely('GPOS', () => parseGposKern(view, this._table('GPOS'))) : null;
    const tryKern = (want === 'kern' || (want === 'auto' && !this._gpos)) && tables.has('kern');
    this._kern = tryKern ? this._safely('kern', () => parseKernTable(view, this._table('kern'))) : null;
    this.kerningSource = this._gpos ? 'GPOS' : this._kern ? 'kern' : 'none';

    this._contourCache = new Map();
    this._ringCache = new Map();
    this._cpCache = new Map();
  }

  /** Run a parse that is allowed to fail: one broken optional table must not
   *  sink a font whose outlines are perfectly good. The failure is recorded,
   *  never swallowed. */
  _safely(label, fn) {
    try { return fn(); }
    catch (e) { this.warnings.push(`${label} table could not be read (${e.message}); ignoring it`); return null; }
  }

  _table(tag, required = false) {
    const t = this._tables.get(tag);
    if (!t && required) {
      throw new FontError(`font is missing the required '${tag}' table (has: ${this.tables.join(' ')})`,
        { missingTable: tag });
    }
    return t;
  }

  hasTable(tag) { return this._tables.has(tag); }

  _readHmtx() {
    const t = this._table('hmtx', true);
    const r = new Reader(this.view, t.offset, t.offset + t.length, 'hmtx');
    const n = Math.max(1, Math.min(this.numberOfHMetrics, this.numGlyphs));
    const adv = new Uint16Array(this.numGlyphs);
    let last = 0;
    for (let i = 0; i < n; i++) {
      if (r.remaining < 4) break;              // short hmtx: keep what we read, share the last advance
      last = r.u16(); r.skip(2);               // lsb is only needed for hinting
      adv[i] = last;
    }
    for (let i = n; i < this.numGlyphs; i++) adv[i] = last;
    this._advances = adv;
  }

  _readOS2() {
    const t = this._table('OS/2');
    this.os2 = null;
    if (!t) return;
    try {
      const r = new Reader(this.view, t.offset, t.offset + t.length, 'OS/2');
      const version = r.u16();
      r.seek(t.offset + 68);
      const typoAscender = r.i16(), typoDescender = r.i16(), typoLineGap = r.i16();
      let xHeight = 0, capHeight = 0;
      if (version >= 2 && t.length >= 90) {
        r.seek(t.offset + 86);
        xHeight = r.i16(); capHeight = r.i16();
      }
      this.os2 = { version, typoAscender, typoDescender, typoLineGap, xHeight, capHeight };
    } catch { this.os2 = null; }
  }

  _readLoca() {
    const t = this._table('loca', true);
    const long = this.indexToLocFormat === 1;
    const stride = long ? 4 : 2;
    const have = Math.floor(t.length / stride);
    const want = this.numGlyphs + 1;
    if (have < want) {
      // A short loca is recoverable — glyphs past the end simply do not exist —
      // but it is worth being loud about, because it usually means a bad subset.
      this.warnings.push(
        `loca holds ${have} of ${want} offsets; glyphs above ${Math.max(0, have - 2)} will read as blank`);
    }
    const n = Math.min(have, want);
    const loca = new Uint32Array(want);
    const r = new Reader(this.view, t.offset, t.offset + t.length, 'loca');
    for (let i = 0; i < n; i++) loca[i] = long ? r.u32() : r.u16() * 2;
    for (let i = n; i < want; i++) loca[i] = n > 0 ? loca[n - 1] : 0;
    this._loca = loca;
  }

  // -- character ↔ glyph ----------------------------------------------------

  /** Code point of a character, accepting either a string or a number. */
  static codePoint(char) {
    if (typeof char === 'number') return char >>> 0;
    if (typeof char === 'string' && char.length) return char.codePointAt(0);
    throw new FontError(`expected a character or code point, got ${JSON.stringify(char)}`);
  }

  glyphIndex(char) {
    const cp = Font.codePoint(char);
    let g = this._cpCache.get(cp);
    if (g !== undefined) return g;
    g = this.cmap.lookup(cp) | 0;
    // Symbol fonts hide their glyphs in the private-use area.
    if (!g && this.cmap.symbol) g = this.cmap.lookup(0xF000 | (cp & 0xFF)) | 0;
    if (g >= this.numGlyphs) g = 0;
    this._cpCache.set(cp, g);
    return g;
  }

  hasGlyph(char) { return this.glyphIndex(char) !== 0; }

  /** Advance width in font units. */
  advance(char) { return this.advanceOfGlyph(this.glyphIndex(char)); }

  advanceOfGlyph(gid) {
    return (gid >= 0 && gid < this.numGlyphs) ? this._advances[gid] : 0;
  }

  // -- metrics --------------------------------------------------------------

  /**
   * Cap height in font units, measured from the actual 'H' outline.
   *
   * OS/2.sCapHeight is only advisory and plenty of shipped fonts get it wrong
   * by a few percent; the caller asking for "10 mm letters" will put a caliper
   * on a capital, so the capital is what we measure. OS/2 is the fallback for
   * fonts with no Latin capitals at all.
   */
  get capHeight() {
    if (this._capHeight === undefined) {
      let h = 0;
      for (const ch of 'HIEFTLX') {
        const gid = this.glyphIndex(ch);
        if (!gid) continue;
        const bb = this.glyphBBox(gid);
        if (bb && bb.yMax > 0) { h = bb.yMax; break; }
      }
      if (!h && this.os2 && this.os2.capHeight > 0) h = this.os2.capHeight;
      if (!h) h = Math.round(this.unitsPerEm * 0.7);
      this._capHeight = h;
    }
    return this._capHeight;
  }

  get xHeight() {
    if (this._xHeight === undefined) {
      let h = 0;
      const gid = this.glyphIndex('x');
      if (gid) { const bb = this.glyphBBox(gid); if (bb && bb.yMax > 0) h = bb.yMax; }
      if (!h && this.os2 && this.os2.xHeight > 0) h = this.os2.xHeight;
      if (!h) h = Math.round(this.capHeight * 0.72);
      this._xHeight = h;
    }
    return this._xHeight;
  }

  /** The bbox TrueType stores in the glyph header, or null for a blank glyph. */
  glyphBBox(gid) {
    if (gid < 0 || gid >= this.numGlyphs) return null;
    const off = this._loca[gid], end = this._loca[gid + 1];
    if (end <= off || this._glyfStart + off + 10 > this._glyfEnd) return null;
    const v = this.view, at = this._glyfStart + off;
    return { xMin: v.getInt16(at + 2), yMin: v.getInt16(at + 4),
             xMax: v.getInt16(at + 6), yMax: v.getInt16(at + 8),
             contours: v.getInt16(at) };
  }

  /** True if the glyph is built from other glyphs (accents, many quote marks). */
  isComposite(gid) {
    const bb = this.glyphBBox(gid);
    return !!bb && bb.contours < 0;
  }

  // -- outlines -------------------------------------------------------------

  /**
   * Raw contours in font units: an array of point lists, each point
   * {x, y, on}. Cached, and never handed out for mutation — callers get rings.
   */
  _contours(gid, depth = 0, chain = null) {
    if (gid < 0 || gid >= this.numGlyphs) throw new FontError(`glyph id ${gid} is out of range (0..${this.numGlyphs - 1})`);
    // Cache at every depth, not just the top: an acute accent is a component of
    // a dozen glyphs and re-parsing it per accented letter is pure waste.
    if (this._contourCache.has(gid)) return this._contourCache.get(gid);
    const off = this._loca[gid], end = this._loca[gid + 1];
    let result;
    if (end <= off) result = [];               // blank glyph: space, and it is legal
    else {
      const r = new Reader(this.view, this._glyfStart + off, Math.min(this._glyfStart + end, this._glyfEnd),
        `glyf entry for glyph ${gid}`);
      const numberOfContours = r.i16();
      r.skip(8);                               // xMin/yMin/xMax/yMax — read via glyphBBox
      result = numberOfContours >= 0
        ? readSimpleGlyph(r, numberOfContours)
        : this._readCompositeGlyph(r, gid, depth, chain);
    }
    this._contourCache.set(gid, result);
    return result;
  }

  _readCompositeGlyph(r, gid, depth, chain) {
    if (depth >= MAX_COMPOSITE_DEPTH) {
      throw new FontError(`composite glyph ${gid} nests more than ${MAX_COMPOSITE_DEPTH} deep`);
    }
    const seen = chain ? new Set(chain) : new Set();
    if (seen.has(gid)) throw new FontError(`composite glyph ${gid} refers to itself`);
    seen.add(gid);

    const out = [];
    const flat = [];                           // every point placed so far, for point-matched offsets
    let more = true;
    while (more) {
      const flags = r.u16(), componentIndex = r.u16();
      more = (flags & 0x0020) !== 0;
      const argsAreWords = (flags & 0x0001) !== 0;
      const argsAreXY = (flags & 0x0002) !== 0;
      let arg1, arg2;
      if (argsAreWords) { arg1 = argsAreXY ? r.i16() : r.u16(); arg2 = argsAreXY ? r.i16() : r.u16(); }
      else { arg1 = argsAreXY ? r.i8() : r.u8(); arg2 = argsAreXY ? r.i8() : r.u8(); }

      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 0x0008) { a = d = r.f2dot14(); }
      else if (flags & 0x0040) { a = r.f2dot14(); d = r.f2dot14(); }
      else if (flags & 0x0080) { a = r.f2dot14(); b = r.f2dot14(); c = r.f2dot14(); d = r.f2dot14(); }

      // USE_MY_METRICS (0x0200) is deliberately ignored: it redirects the
      // advance width and left side bearing during hinting, and hmtx already
      // carries the composite's own advance, which is what layout uses.
      if (componentIndex >= this.numGlyphs) continue;   // junk reference: drop the component, keep the glyph
      const child = this._contours(componentIndex, depth + 1, seen);
      // Transform first, offset second: point matching compares *placed* points.
      const placed = child.map(ct => ct.map(p => ({ x: a * p.x + c * p.y, y: b * p.x + d * p.y, on: p.on })));

      let dx, dy;
      if (argsAreXY) {
        dx = arg1; dy = arg2;
        // Apple's SCALED_COMPONENT_OFFSET puts the offset through the 2×2 too;
        // Microsoft's default (and UNSCALED_COMPONENT_OFFSET) does not.
        if ((flags & 0x0800) && !(flags & 0x1000)) {
          const ox = dx, oy = dy;
          dx = a * ox + c * oy; dy = b * ox + d * oy;
        }
      } else {
        // Point matching: arg1 indexes the points placed so far, arg2 the
        // component's own points. Rare, but silently wrong if ignored.
        const parent = flat[arg1];
        let childPt = null, seenPts = 0;
        for (const ct of placed) {
          if (arg2 < seenPts + ct.length) { childPt = ct[arg2 - seenPts]; break; }
          seenPts += ct.length;
        }
        if (parent && childPt) { dx = parent.x - childPt.x; dy = parent.y - childPt.y; }
        else { dx = 0; dy = 0; }
      }
      if (flags & 0x0004) { dx = Math.round(dx); dy = Math.round(dy); }   // ROUND_XY_TO_GRID

      for (const ct of placed) {
        const moved = ct.map(p => ({ x: p.x + dx, y: p.y + dy, on: p.on }));
        out.push(moved);
        for (const p of moved) flat.push(p);
      }
      if (flat.length > MAX_POINTS_PER_GLYPH) {
        throw new FontError(`composite glyph ${gid} expands to more than ${MAX_POINTS_PER_GLYPH} points`);
      }
    }
    return out;
  }

  /**
   * Flattened rings for a glyph, in font units, in the font's own winding.
   * `tolerance` is the maximum chord deviation, in font units.
   */
  glyphRings(gid, tolerance) {
    const tol = tolerance > 0 ? tolerance : this.unitsPerEm / 2000;
    const hit = this._ringCache.get(gid);
    if (hit && hit.tol === tol) return hit.rings;
    // The weld epsilon is tied to the em, not to the tolerance: a caller who
    // asks for a very coarse flattening still wants their outline, not a ring
    // whose points all merged into one.
    const eps = this.unitsPerEm * 1e-6;
    const rings = this._contours(gid).map(ct => contourToRing(ct, tol, eps)).filter(Boolean);
    this._ringCache.set(gid, { tol, rings });
    return rings;
  }

  /**
   * Outlines for one character as poly2d shapes.
   * @param {string|number} char
   * @param {{scale?:number, tolerance?:number}} opts  scale converts font units
   *        to output units; tolerance is the flatness limit in *output* units.
   * @returns {{shapes, advance, unitsPerEm, bbox, index, codePoint, missing}}
   */
  glyphShapes(char, { scale = 1, tolerance } = {}) {
    const cp = Font.codePoint(char);
    const gid = this.glyphIndex(cp);
    const tolOut = tolerance > 0 ? tolerance : 0.0005 * this.unitsPerEm * Math.abs(scale || 1);
    const tolUnits = Math.abs(scale) > 0 ? tolOut / Math.abs(scale) : tolOut;
    const rings = this.glyphRings(gid, tolUnits);
    const scaled = scale === 1 ? rings.map(r => r.map(p => [p[0], p[1]]))
                               : rings.map(r => r.map(p => [p[0] * scale, p[1] * scale]));
    // A ring smaller than a tenth of the flatness tolerance squared is a parsing
    // artefact, not a counter anybody can print.
    const shapes = contoursToShapes(scaled, { minArea: (tolOut * 0.5) ** 2 });
    let bbox = null;
    for (const shape of shapes) for (const p of shape[0]) {
      if (!bbox) bbox = { xMin: p[0], yMin: p[1], xMax: p[0], yMax: p[1] };
      else {
        if (p[0] < bbox.xMin) bbox.xMin = p[0]; if (p[0] > bbox.xMax) bbox.xMax = p[0];
        if (p[1] < bbox.yMin) bbox.yMin = p[1]; if (p[1] > bbox.yMax) bbox.yMax = p[1];
      }
    }
    return {
      shapes, bbox, index: gid, codePoint: cp, missing: gid === 0,
      advance: this.advanceOfGlyph(gid) * scale,
      unitsPerEm: this.unitsPerEm,
    };
  }

  // -- kerning --------------------------------------------------------------

  /** Kerning between two characters, in font units (negative pulls them together). */
  kern(a, b) {
    return this.kernByGlyph(this.glyphIndex(a), this.glyphIndex(b));
  }

  kernByGlyph(ga, gb) {
    if (!ga || !gb) return 0;
    if (this._gpos) {
      const direct = this._gpos.pairs.get(ga * 65536 + gb);
      if (direct !== undefined) return direct;
      for (const cs of this._gpos.classSets) {
        if (cs.coverage(ga) < 0) continue;
        const v = cs.values[cs.class1(ga) * cs.c2n + cs.class2(gb)];
        if (v) return v;
      }
      return 0;
    }
    if (this._kern) return this._kern.get(ga * 65536 + gb) || 0;
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Simple glyph point decoding, and the contour → ring walk
// ---------------------------------------------------------------------------

const ON_CURVE = 0x01, X_SHORT = 0x02, Y_SHORT = 0x04, REPEAT = 0x08, X_SAME = 0x10, Y_SAME = 0x20;

function readSimpleGlyph(r, numberOfContours) {
  if (numberOfContours === 0) return [];
  const ends = new Array(numberOfContours);
  for (let i = 0; i < numberOfContours; i++) {
    ends[i] = r.u16();
    if (i && ends[i] < ends[i - 1]) throw new FontError('glyph contour end points are not increasing');
  }
  const nPts = ends[numberOfContours - 1] + 1;
  if (nPts > MAX_POINTS_PER_GLYPH) throw new FontError(`glyph claims ${nPts} points`);
  r.skip(r.u16());                             // hinting instructions: irrelevant to outlines

  const flags = new Uint8Array(nPts);
  for (let i = 0; i < nPts;) {
    const f = r.u8();
    flags[i++] = f;
    if (f & REPEAT) { let n = r.u8(); while (n-- > 0 && i < nPts) flags[i++] = f; }
  }
  const xs = new Int32Array(nPts), ys = new Int32Array(nPts);
  let v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & X_SHORT) { const d = r.u8(); v += (f & X_SAME) ? d : -d; }
    else if (!(f & X_SAME)) v += r.i16();      // X_SAME on a long coordinate means "no change"
    xs[i] = v;
  }
  v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & Y_SHORT) { const d = r.u8(); v += (f & Y_SAME) ? d : -d; }
    else if (!(f & Y_SAME)) v += r.i16();
    ys[i] = v;
  }
  const contours = [];
  let start = 0;
  for (let ci = 0; ci < numberOfContours; ci++) {
    const stop = ends[ci];
    const pts = [];
    for (let i = start; i <= stop; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & ON_CURVE) !== 0 });
    if (pts.length) contours.push(pts);
    start = stop + 1;
  }
  return contours;
}

/**
 * Walk one TrueType contour into a polyline ring.
 *
 * The trap: TrueType stores quadratic B-splines, not a plain sequence of
 * curves. Two consecutive off-curve points imply an on-curve point at their
 * midpoint, and a contour is allowed to contain *no* on-curve points at all
 * (a circle is often four off-curve points). Miss either case and every round
 * letterform gains flat spots exactly where the implied points should be.
 */
function contourToRing(pts, tol, eps = Math.max(tol * 1e-3, 1e-9)) {
  const n = pts.length;
  if (n < 2) return null;

  let startPt, rest;
  const firstOn = pts.findIndex(p => p.on);
  if (firstOn >= 0) {
    startPt = { x: pts[firstOn].x, y: pts[firstOn].y };
    rest = pts.slice(firstOn + 1).concat(pts.slice(0, firstOn));
  } else {
    // No on-curve point anywhere: the implied start is the midpoint of the last
    // and first control points, and every span is an implied-midpoint span.
    startPt = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
    rest = pts.slice();
  }

  const ring = [[startPt.x, startPt.y]];
  let cur = [startPt.x, startPt.y];
  for (let i = 0; i < rest.length;) {
    const p = rest[i];
    if (p.on) { ring.push([p.x, p.y]); cur = [p.x, p.y]; i++; continue; }
    const next = i + 1 < rest.length ? rest[i + 1] : { x: startPt.x, y: startPt.y, on: true };
    let end;
    if (next.on) { end = [next.x, next.y]; i += 2; }
    else { end = [(p.x + next.x) / 2, (p.y + next.y) / 2]; i += 1; }   // the implied on-curve point
    for (const q of flattenQuadratic(cur, [p.x, p.y], end, tol)) ring.push(q);
    cur = end;
  }

  // The ring is implicitly closed, so a final point sitting on the first is a
  // duplicate; so are any coincident points left by a zero-length span.
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) <= eps && Math.abs(last[1] - p[1]) <= eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop(); else break;
  }
  return out.length >= 3 ? out : null;
}

// ---------------------------------------------------------------------------
// loadFont
// ---------------------------------------------------------------------------

/**
 * Parse a TrueType font.
 * @param {ArrayBuffer|Uint8Array|Buffer} data
 * @param {{index?:number}} opts  index picks a face out of a .ttc collection
 * @returns {Font}
 */
export function loadFont(data, opts = {}) {
  const view = toView(data);
  const format = sniffFontFormat(view);
  if (format === 'cff') {
    throw new FontError(
      'This is an OpenType/CFF font (OTTO). Bluesheet reads TrueType `glyf` outlines only, ' +
      'so it would produce an empty nameplate rather than letters. Convert it to TTF ' +
      '(fonttools: `fonttools ttf --flavor ttf font.otf`) or pick one of the bundled fonts.',
      { format });
  }
  if (format === 'woff' || format === 'woff2') {
    throw new FontError(
      `This is a ${format.toUpperCase()} web font — a compressed wrapper, not an sfnt. ` +
      'Decompress it to .ttf first (fonttools: `fonttools ttLib.woff2 decompress`).', { format });
  }
  let base = 0;
  if (format === 'ttc') {
    const r = new Reader(view, 8, view.byteLength, 'ttc header');
    const numFonts = r.u32();
    const index = opts.index || 0;
    if (index >= numFonts) throw new FontError(`font collection holds ${numFonts} face(s); index ${index} was asked for`);
    r.skip(index * 4);
    base = r.u32();
  } else if (format === 'unknown') {
    const stamp = view.byteLength >= 4 ? view.getUint32(0).toString(16).padStart(8, '0') : '(too short)';
    throw new FontError(`unrecognised font file: leading bytes 0x${stamp} match no sfnt, WOFF or collection signature`,
      { format });
  }

  const { tables, truncated } = readTableDirectory(view, base);
  const lost = truncated.find(t => REQUIRED_TABLES.includes(t.tag));
  if (lost) {
    throw new FontError(
      `the font file is truncated: the '${lost.tag}' table needs bytes ${lost.offset}–` +
      `${lost.offset + lost.length} but the file is only ${view.byteLength} bytes long`,
      { table: lost.tag, offset: lost.offset });
  }
  if (!tables.has('glyf') || !tables.has('loca')) {
    if (tables.has('CFF ') || tables.has('CFF2')) {
      throw new FontError(
        'This font stores its outlines in a CFF table, not `glyf`. Bluesheet reads TrueType ' +
        'outlines only — convert it to TTF or use one of the bundled fonts.', { format: 'cff' });
    }
    throw new FontError(
      `font has no outline tables this parser can use (needs glyf + loca; found: ${[...tables.keys()].sort().join(' ')})`);
  }
  const font = new Font(view, tables, opts);
  for (const t of truncated) {
    font.warnings.push(`the '${t.tag}' table is cut short by ${t.offset + t.length - view.byteLength} bytes`);
  }
  return font;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const ALIGNMENTS = new Set(['left', 'center', 'centre', 'right']);
const VALIGNMENTS = new Set(['baseline', 'top', 'center', 'centre', 'bottom']);

/**
 * Font units → millimetres for a given cap height.
 *
 * `size` in Bluesheet means cap height, not em. Somebody asking for 10 mm letters
 * means the capitals measure 10 mm with a caliper; em size would give them
 * roughly 7 mm capitals and a nameplate that looks wrong at a glance.
 */
export function capScaleFor(font, capHeightMm) {
  if (!(capHeightMm > 0)) throw new FontError(`size must be a positive cap height in mm, got ${capHeightMm}`);
  return capHeightMm / font.capHeight;
}

function normaliseOptions(font, opts) {
  const o = {
    size: 10, letterSpacing: 0, lineHeight: 1.4, align: 'center', vAlign: 'baseline',
    maxWidth: 0, kerning: true, tabSize: 4, onMissing: 'skip', curveTolerance: 0.02,
    ...opts,
  };
  const align = String(o.align).toLowerCase();
  if (!ALIGNMENTS.has(align)) {
    throw new FontError(`align must be one of ${[...ALIGNMENTS].join('|')}, got "${o.align}"`);
  }
  const vAlign = String(o.vAlign).toLowerCase();
  if (!VALIGNMENTS.has(vAlign)) {
    throw new FontError(`vAlign must be one of ${[...VALIGNMENTS].join('|')}, got "${o.vAlign}"`);
  }
  if (!(o.lineHeight > 0)) throw new FontError(`lineHeight must be positive, got ${o.lineHeight}`);
  if (!['skip', 'notdef', 'error'].includes(o.onMissing)) {
    throw new FontError(`onMissing must be skip|notdef|error, got "${o.onMissing}"`);
  }
  // NaN propagates silently all the way into an STL, so it is caught here where
  // the message can still name the option that was wrong.
  for (const k of ['letterSpacing', 'maxWidth', 'curveTolerance', 'lineHeight', 'size']) {
    if (typeof o[k] !== 'number' || !isFinite(o[k])) {
      throw new FontError(`${k} must be a finite number, got ${JSON.stringify(o[k])}`);
    }
  }
  if (o.maxWidth < 0) throw new FontError(`maxWidth cannot be negative, got ${o.maxWidth}`);
  o.align = align === 'centre' ? 'center' : align;
  o.vAlign = vAlign === 'centre' ? 'center' : vAlign;
  o.scale = capScaleFor(font, o.size);
  return o;
}

/**
 * Walk the string once and work out where every glyph sits. Shared by
 * layoutText and measureText so the two can never disagree about a width —
 * a measure that is a separate implementation of the layout is a measure that
 * is quietly wrong six months later.
 */
function planText(font, text, o) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const tab = ' '.repeat(Math.max(0, o.tabSize | 0));
  const rawLines = src.split('\n');
  const missing = [];
  const lines = [];
  const spaceFallback = font.unitsPerEm * 0.25;

  for (let li = 0; li < rawLines.length; li++) {
    // Trailing blanks cannot print but would shove a centred line off-axis, so
    // they go. Leading blanks are a deliberate indent and stay.
    const lineText = rawLines[li].replace(/\t/g, tab).replace(/[ \t]+$/, '');
    const glyphs = [];
    let pen = 0, prevGid = 0, prevInk = false;
    for (const ch of lineText) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;    // control characters draw tofu; drop them
      const gid = font.glyphIndex(cp);
      let advance, ink = true;
      if (gid === 0) {
        if (ch === ' ') { advance = spaceFallback; ink = false; }  // no space glyph: invent one
        else if (o.onMissing === 'error') {
          throw new FontError(`the font "${font.name}" has no glyph for ${describeChar(ch)}`,
            { char: ch, codePoint: cp });
        } else if (o.onMissing === 'skip') { missing.push(ch); continue; }
        else { missing.push(ch); advance = font.advanceOfGlyph(0); }   // 'notdef': draw the tofu box
      } else advance = font.advanceOfGlyph(gid);

      // Kerning applies between two glyphs that both made it into the line; a
      // skipped glyph must not leave its neighbours kerned against a gap.
      if (prevInk && o.kerning) pen += font.kernByGlyph(prevGid, gid) * o.scale;
      if (glyphs.length) pen += o.letterSpacing;
      glyphs.push({ char: ch, codePoint: cp, gid, x: pen, missing: gid === 0, ink });
      pen += advance * o.scale;
      prevGid = gid; prevInk = true;
    }
    lines.push({ index: li, text: lineText, glyphs, width: pen, x: 0, y: 0 });
  }

  let width = 0;
  for (const l of lines) if (l.width > width) width = l.width;

  const fit = (o.maxWidth > 0 && width > o.maxWidth && width > 0) ? o.maxWidth / width : 1;
  if (fit !== 1) {
    // Uniform shrink of the whole run — letters, letter spacing and line spacing
    // together — which is what "scale it down to fit" has to mean if the result
    // is to still look like the same text.
    for (const l of lines) { l.width *= fit; for (const g of l.glyphs) g.x *= fit; }
    width *= fit;
  }
  const scale = o.scale * fit;
  const lineStep = o.lineHeight * font.unitsPerEm * scale;
  const ascent = font.ascender * scale, descent = font.descender * scale;

  const top = ascent, bottom = -(lines.length - 1) * lineStep + descent;
  let shift = 0;
  if (o.vAlign === 'top') shift = -top;
  else if (o.vAlign === 'bottom') shift = -bottom;
  else if (o.vAlign === 'center') shift = -(top + bottom) / 2;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    l.x = o.align === 'left' ? 0 : o.align === 'right' ? -l.width : -l.width / 2;
    l.y = -i * lineStep + shift;
  }
  return {
    lines, width, height: top - bottom, fit, scale, lineStep, ascent, descent,
    missing: [...new Set(missing)], size: o.size, capHeight: font.capHeight * scale,
  };
}

function describeChar(ch) {
  const cp = ch.codePointAt(0);
  return `'${ch}' (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
}

/**
 * Advance-only metrics: how wide and tall this text will come out, without
 * building a single outline. Cheap enough to call on every keystroke in the UI.
 */
export function measureText(font, text, opts = {}) {
  const o = normaliseOptions(font, opts);
  const p = planText(font, text, o);
  return {
    width: p.width, height: p.height, scale: p.scale, fit: p.fit, size: p.size,
    lineStep: p.lineStep, ascent: p.ascent, descent: p.descent, missing: p.missing,
    lines: p.lines.map(l => ({ index: l.index, text: l.text, width: l.width, x: l.x, y: l.y,
                               glyphs: l.glyphs.length })),
  };
}

/**
 * Lay text out as poly2d shapes in millimetres, ready to extrude.
 *
 * Baseline of the first line sits at y = 0 and the text is centred on x = 0
 * unless `align` says otherwise. Everything is already positioned — the caller
 * extrudes the shapes as they are.
 *
 * @param {Font} font
 * @param {string} text                       \n splits lines
 * @param {object} opts
 * @param {number} opts.size                  cap height in mm (default 10)
 * @param {number} opts.letterSpacing         extra mm between glyphs (default 0)
 * @param {number} opts.lineHeight            baseline step as a multiple of the em (default 1.4)
 * @param {'left'|'center'|'right'} opts.align
 * @param {'baseline'|'top'|'center'|'bottom'} opts.vAlign
 * @param {number} opts.maxWidth              if set, the whole run shrinks to fit
 * @param {boolean} opts.kerning              default true
 * @param {number} opts.curveTolerance        max chord deviation in mm (default 0.02)
 * @param {'skip'|'notdef'|'error'} opts.onMissing
 * @returns {{shapes, width, height, lines, glyphs, bbox, scale, fit, missing, ...}}
 */
export function layoutText(font, text, opts = {}) {
  if (!font || typeof font.glyphIndex !== 'function') {
    throw new FontError('layoutText needs a Font from loadFont() as its first argument');
  }
  const o = normaliseOptions(font, opts);
  const plan = planText(font, text, o);
  const scale = plan.scale;
  const tolMm = o.curveTolerance > 0 ? o.curveTolerance : 0.02;
  const tolUnits = tolMm / scale;
  const minArea = (tolMm * 0.5) ** 2;

  const shapes = [];
  const glyphs = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const line of plan.lines) {
    for (const g of line.glyphs) {
      if (!g.ink) continue;                    // an invented space has no outline to fetch
      const rings = font.glyphRings(g.gid, tolUnits);
      const dx = line.x + g.x, dy = line.y;
      if (!rings.length) continue;             // spaces, and anything else with no ink
      const placed = rings.map(r => r.map(p => [p[0] * scale + dx, p[1] * scale + dy]));
      // Nesting is resolved per glyph. Two glyphs that overlap (a script 'f'
      // leaning into the next letter) stay separate solids for a union upstream
      // to merge; treating one letter's counter as a hole in its neighbour
      // would punch a real hole in the print.
      const own = contoursToShapes(placed, { minArea });
      // The bbox is measured from what survives, not from what went in, so a
      // sub-tolerance ring that gets dropped cannot inflate the reported size.
      for (const s of own) {
        shapes.push(s);
        for (const [px, py] of s[0]) {
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
      // Grouped as well as flat, so a generator can give each letter its own
      // colour or part without laying the text out a second time.
      glyphs.push({ char: g.char, codePoint: g.codePoint, gid: g.gid,
                    x: dx, y: dy, line: line.index, shapes: own });
    }
  }
  const bbox = shapes.length
    ? { min: [x0, y0], max: [x1, y1], size: [x1 - x0, y1 - y0], center: [(x0 + x1) / 2, (y0 + y1) / 2] }
    : { min: [0, 0], max: [0, 0], size: [0, 0], center: [0, 0] };

  return {
    shapes, bbox, glyphs,
    width: plan.width, height: plan.height,
    scale, fit: plan.fit, size: plan.size, capHeight: plan.capHeight,
    lineStep: plan.lineStep, ascent: plan.ascent, descent: plan.descent,
    missing: plan.missing,
    lines: plan.lines.map(l => ({ index: l.index, text: l.text, width: l.width,
                                  x: l.x, y: l.y, glyphs: l.glyphs.length })),
  };
}
