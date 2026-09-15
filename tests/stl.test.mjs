// K5 — STL / OBJ / 3MF, tested at the byte.
//
// The discipline here: a round trip through my own exporter and importer cannot
// see a consistent sign error, a swapped axis pair, or a big-endian mistake,
// because both halves would make it identically. So the anchor for every format
// claim is a value known outside this codebase:
//
//   * float32 bit patterns computed from IEEE-754 by hand (10.0 is 0x41200000,
//     so its little-endian bytes are 00 00 20 41 — no code of mine produced that);
//   * the published CRC-32 check value for "123456789" (0xCBF43926);
//   * the zip local/central header layouts from APPNOTE.TXT, parsed by a reader
//     written separately from the writer;
//   * Mesh#toSTL, written by a different author in a different file, which must
//     agree with exportBinarySTL byte for byte.
//
// Import fixtures are hand-assembled buffers, never exporter output, so a bug
// shared by both directions has nowhere to hide.

import { suite, check, near, nearVec, throws, done } from './lib/assert.mjs';
import { Mesh } from '../js/kernel/mesh.js';
import { icosphere, cube, tetra } from './lib/fixtures.mjs';
import {
  exportBinarySTL, exportASCIISTL, exportOBJ, export3MF, importSTL, detectFormat,
} from '../js/kernel/stl.js';
import { hostname } from 'node:os';

suite('K5 stl');

// ---------------------------------------------------------------------------
// test-local tools, deliberately not sharing an implementation with the module
// ---------------------------------------------------------------------------

const hex = (u8, from = 0, to = u8.length) =>
  Array.from(u8.subarray(from, to), b => b.toString(16).padStart(2, '0')).join('');

const latin1 = (u8, from = 0, to = u8.length) =>
  Array.from(u8.subarray(from, to), b => String.fromCharCode(b)).join('');

/**
 * A binary STL assembled by hand from the format description, not by calling the
 * module. `count` may be forced to a lie, which together with slicing the result
 * short is how the rejection paths get exercised with realistic corruption.
 */
function handBinary(headerText, triangles, { count = null, attr = 0 } = {}) {
  const n = triangles.length;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  for (let i = 0; i < 80; i++) u8[i] = i < headerText.length ? headerText.charCodeAt(i) & 0xff : 0x20;
  dv.setUint32(80, count === null ? n : count, true);
  let o = 84;
  for (const t of triangles) {
    for (const c of (t.n || [0, 0, 0])) { dv.setFloat32(o, c, true); o += 4; }
    for (const v of t.v) for (const c of v) { dv.setFloat32(o, c, true); o += 4; }
    dv.setUint16(o, attr, true); o += 2;
  }
  return u8;
}

/** CRC-32 the slow way, one bit at a time — no shared table with the module. */
function crc32Bitwise(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal zip reader: EOCD, then the central directory, per APPNOTE.TXT. */
function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const files = [];
  let o = cdOffset;
  for (let e = 0; e < entries; e++) {
    if (dv.getUint32(o, true) !== 0x02014b50) throw new Error(`bad central header at ${o}`);
    const method = dv.getUint16(o + 10, true);
    const time = dv.getUint16(o + 12, true);
    const date = dv.getUint16(o + 14, true);
    const crc = dv.getUint32(o + 16, true);
    const csize = dv.getUint32(o + 20, true);
    const usize = dv.getUint32(o + 24, true);
    const fnLen = dv.getUint16(o + 28, true);
    const exLen = dv.getUint16(o + 30, true);
    const cmLen = dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    const name = latin1(u8, o + 46, o + 46 + fnLen);
    // Read the payload through the LOCAL header, so a writer that disagrees with
    // itself between the two directories is caught.
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lFnLen = dv.getUint16(local + 26, true);
    const lExLen = dv.getUint16(local + 28, true);
    const lCsize = dv.getUint32(local + 18, true);
    const start = local + 30 + lFnLen + lExLen;
    files.push({
      name, method, time, date, crc, csize, usize, local, lCsize,
      data: u8.subarray(start, start + lCsize),
    });
    o += 46 + fnLen + exLen + cmLen;
  }
  return { entries, cdSize, cdOffset, eocd, files };
}

const triMesh = (verts, tris) => {
  const m = new Mesh();
  for (const v of verts) m.addVertex(v[0], v[1], v[2]);
  for (const t of tris) m.addTri(t[0], t[1], t[2]);
  return m;
};

// The reference triangle used throughout: CCW seen from +Z, so its normal is
// exactly (0,0,1) and every one of its float32 bit patterns is hand-computable.
const REF = triMesh([[0, 0, 0], [10, 0, 0], [0, 20, 0]], [[0, 1, 2]]);

// Ground truth, straight from IEEE-754: sign 0, exponent 127+e, 23-bit mantissa.
//   0.0 -> 00000000    1.0 -> 3f800000    10.0 -> 41200000    20.0 -> 41a00000
// little-endian, so each is byte-reversed below.
const F32 = { 0: '00000000', 1: '0000803f', '-1': '000080bf', 2.5: '00002040', 10: '00002041', 20: '0000a041' };

// ---------------------------------------------------------------------------
console.log('\n-- the ground-truth anchors themselves --');
// ---------------------------------------------------------------------------
{
  // If these are wrong every byte assertion below is meaningless, so pin them
  // against values published outside this project.
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, 10, true);
  check('IEEE-754: float32 10.0 little-endian is 00 00 20 41', hex(b) === F32[10], hex(b));
  new DataView(b.buffer).setFloat32(0, -1, true);
  check('IEEE-754: float32 -1.0 little-endian is 00 00 80 bf', hex(b) === F32['-1'], hex(b));
  check('CRC-32 check value for "123456789" is 0xCBF43926',
    crc32Bitwise(new TextEncoder().encode('123456789')) === 0xcbf43926,
    '0x' + crc32Bitwise(new TextEncoder().encode('123456789')).toString(16));
}

// ---------------------------------------------------------------------------
console.log('\n-- binary STL export: exact bytes (G4) --');
// ---------------------------------------------------------------------------
{
  const out = exportBinarySTL(REF, 'tri');
  check('length is 84 + 50n', out.length === 84 + 50 * 1, `${out.length} bytes for 1 triangle`);

  const header = latin1(out, 0, 80);
  check('the header occupies exactly bytes 0..79, with the count starting at 80',
    out.length === 80 + 4 + 50 * 1, `${out.length} = 80 + 4 + 50`);
  check('header is "Bluesheet tri" space-padded to 80',
    header === 'Bluesheet tri' + ' '.repeat(80 - 'Bluesheet tri'.length), JSON.stringify(header));
  check('header contains no digits (so: no clock, no version stamp)', !/[0-9]/.test(header), header.trim());
  check('header contains no hostname',
    hostname().length < 3 || !header.toLowerCase().includes(hostname().toLowerCase()), `hostname is "${hostname()}"`);
  check('header does not start with "solid" (the classic mis-sniff bait)',
    !header.toLowerCase().startsWith('solid'), header.slice(0, 5));

  check('triangle count bytes at offset 80 are 01 00 00 00 (uint32 LE)',
    hex(out, 80, 84) === '01000000', hex(out, 80, 84));
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  check('uint32 LE at offset 80 reads back as 1', dv.getUint32(80, true) === 1);

  // The 50-byte record, byte for byte, from the IEEE-754 table above:
  //   normal (0,0,1) | v0 (0,0,0) | v1 (10,0,0) | v2 (0,20,0) | attr 0
  const expect =
    F32[0] + F32[0] + F32[1] +
    F32[0] + F32[0] + F32[0] +
    F32[10] + F32[0] + F32[0] +
    F32[0] + F32[20] + F32[0] +
    '0000';
  check('triangle record at offset 84 matches the hand-computed bytes',
    hex(out, 84, 134) === expect, hex(out, 84, 134));
  check('normal at offsets 84/88/92 is (0,0,1) — winding is CCW-from-outside',
    dv.getFloat32(84, true) === 0 && dv.getFloat32(88, true) === 0 && dv.getFloat32(92, true) === 1,
    `(${dv.getFloat32(84, true)}, ${dv.getFloat32(88, true)}, ${dv.getFloat32(92, true)})`);
  nearVec('vertex floats at offsets 96..131 are the authored vertices',
    [96, 100, 104, 108, 112, 116, 120, 124, 128].map(o => dv.getFloat32(o, true)),
    [0, 0, 0, 10, 0, 0, 0, 20, 0]);
  check('uint16 attribute at offset 132 is 0', dv.getUint16(132, true) === 0);
}

{
  // A 12-triangle mesh proves the count is not being confused with a byte or a
  // uint16, and that the stride is exactly 50.
  const c = cube(10);
  const out = exportBinarySTL(c, 'cube');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  check('cube: 12 triangles, count bytes 0c 00 00 00', hex(out, 80, 84) === '0c000000', hex(out, 80, 84));
  check('cube: length is 84 + 50*12 = 684', out.length === 684, `${out.length}`);
  check('cube: last triangle record ends exactly at EOF',
    84 + 12 * 50 === out.length && dv.getUint16(out.length - 2, true) === 0);
}

{
  // Two independently written binary writers agreeing is the strongest evidence
  // available that the layout is right — mesh.js is not my file.
  const mine = exportBinarySTL(REF, 'tri');
  const theirs = REF.toSTL('tri');
  check('exportBinarySTL is byte-identical to the independently written Mesh#toSTL',
    mine.length === theirs.length && mine.every((b, i) => b === theirs[i]),
    `${mine.length} vs ${theirs.length} bytes`);
}

{
  const a = exportBinarySTL(REF, 'tri'), b = exportBinarySTL(REF, 'tri');
  check('deterministic: two exports are byte-identical', a.every((v, i) => v === b[i]));
  const empty = exportBinarySTL(new Mesh(), 'nothing');
  check('empty mesh exports as an 84-byte file with count 0',
    empty.length === 84 && hex(empty, 80, 84) === '00000000', `${empty.length} bytes, ${hex(empty, 80, 84)}`);
  const long = exportBinarySTL(REF, 'x'.repeat(200));
  check('an over-long name still leaves an exactly-80-byte header', long.length === 134);
  check('an over-long name is truncated, not wrapped into the count',
    hex(long, 80, 84) === '01000000', hex(long, 80, 84));
  const rude = exportBinarySTL(REF, 'naïve\nname ');
  check('a name with newlines/NULs/accents is sanitised to printable ASCII',
    /^[\x20-\x7e]{80}$/.test(latin1(rude, 0, 80)), JSON.stringify(latin1(rude, 0, 80).trim()));
}

{
  // Negative and fractional coordinates, checked against the same IEEE-754 table.
  const m = triMesh([[-1, 0, 0], [2.5, 0, 0], [0, 2.5, 0]], [[0, 1, 2]]);
  const out = exportBinarySTL(m, 'signs');
  check('negative float32 -1.0 is written as 00 00 80 bf', hex(out, 96, 100) === F32['-1'], hex(out, 96, 100));
  check('fractional float32 2.5 is written as 00 00 20 40', hex(out, 108, 112) === F32[2.5], hex(out, 108, 112));
}

throws('export rejects a NaN coordinate, naming the vertex',
  () => exportBinarySTL(triMesh([[0, 0, 0], [NaN, 0, 0], [0, 1, 0]], [[0, 1, 2]]), 'bad'), 'vertex 1');
throws('export rejects an out-of-range triangle index',
  () => exportBinarySTL(triMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 7]]), 'bad'), 'vertex 7');
throws('export rejects a non-mesh', () => exportBinarySTL({ nope: true }, 'bad'), 'expected a Mesh');

// ---------------------------------------------------------------------------
console.log('\n-- ASCII STL export --');
// ---------------------------------------------------------------------------
{
  const txt = exportASCIISTL(REF, 'tri');
  const want =
    'solid tri\n' +
    '  facet normal 0 0 1\n' +
    '    outer loop\n' +
    '      vertex 0 0 0\n' +
    '      vertex 10 0 0\n' +
    '      vertex 0 20 0\n' +
    '    endloop\n' +
    '  endfacet\n' +
    'endsolid tri\n';
  check('ASCII output matches the expected text exactly', txt === want, JSON.stringify(txt.slice(0, 40)));
  check('ASCII ends with a newline', txt.endsWith('\n'));
  check('ASCII uses LF only, never CRLF', !txt.includes('\r'));

  const c = exportASCIISTL(cube(10), 'cube');
  const facets = (c.match(/facet normal/g) || []).length;
  const verts = (c.match(/^\s*vertex /gm) || []).length;
  check('cube: 12 facet blocks', facets === 12, `${facets}`);
  check('cube: 36 vertex lines (3 per facet)', verts === 36, `${verts}`);
  check('cube: exactly one solid/endsolid pair',
    (c.match(/^solid /gm) || []).length === 1 && (c.match(/^endsolid /gm) || []).length === 1);
  check('no "-0" ever reaches the file', !/[\s]-0(\s|$)/.test(c), 'checked every token');
  check('ASCII export is deterministic', exportASCIISTL(cube(10), 'cube') === c);
}
throws('ASCII export rejects a NaN coordinate',
  () => exportASCIISTL(triMesh([[0, 0, 0], [0, NaN, 0], [0, 1, 0]], [[0, 1, 2]]), 'bad'), 'non-finite');

// ---------------------------------------------------------------------------
console.log('\n-- detectFormat: the sniffing traps --');
// ---------------------------------------------------------------------------
{
  const asciiText = exportASCIISTL(REF, 'tri');
  const binBuf = handBinary('Bluesheet tri', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);

  check('binary buffer is detected as binary', detectFormat(binBuf) === 'binary', detectFormat(binBuf));
  check('ASCII text is detected as ascii', detectFormat(asciiText) === 'ascii', detectFormat(asciiText));

  // THE trap: a binary file whose 80-byte header begins "solid". Real, common,
  // and the reason "starts with solid" is not a test.
  const trap = handBinary('solid ExportedByAnOldCADPackage', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  check('a BINARY file whose header starts with "solid" is still detected as binary',
    detectFormat(trap) === 'binary', detectFormat(trap));
  check('...and its length really does satisfy 84 + 50n', trap.length === 84 + 50);

  // The other half of the trap: ASCII that does not lead with "solid" on byte 0.
  check('ASCII with a leading blank line and CRLF is detected as ascii',
    detectFormat('\r\n\r\n' + asciiText.replace(/\n/g, '\r\n')) === 'ascii');
  check('ASCII behind a UTF-8 BOM is detected as ascii',
    detectFormat('ï»¿' + asciiText) === 'ascii');
  check('an empty ASCII solid (no facets) is detected as ascii',
    detectFormat('solid empty\nendsolid empty\n') === 'ascii');

  check('zero bytes is "empty"', detectFormat(new Uint8Array(0)) === 'empty');
  const zip = export3MF(REF, 'tri');
  check('a zip is detected as 3mf', detectFormat(zip) === '3mf', detectFormat(zip));
  const junk = new Uint8Array(300).map((_, i) => (i * 37 + 11) & 0xff);
  check('arbitrary binary junk is "unknown", not silently "binary"',
    detectFormat(junk) === 'unknown', detectFormat(junk));
  check('prose is "unknown"', detectFormat('the quick brown fox '.repeat(20)) === 'unknown');

  const padded = new Uint8Array(binBuf.length + 6);
  padded.set(binBuf); // six zero bytes of trailing pad
  check('a binary STL with trailing pad bytes is still binary', detectFormat(padded) === 'binary');

  const ab = binBuf.slice().buffer;
  check('the same bytes sniff identically as ArrayBuffer, Uint8Array, Buffer and string',
    detectFormat(ab) === 'binary' && detectFormat(new Uint8Array(ab)) === 'binary' &&
    detectFormat(Buffer.from(ab)) === 'binary' && detectFormat(latin1(binBuf)) === 'binary');
  throws('detectFormat rejects a nonsense argument', () => detectFormat(42), 'expected an ArrayBuffer');
}

// ---------------------------------------------------------------------------
console.log('\n-- importSTL: hand-assembled binary fixtures (G5) --');
// ---------------------------------------------------------------------------
{
  // Two triangles sharing the edge (10,0,0)-(0,20,0): six raw vertices, four
  // after welding. Assembled from the format spec, never from my exporter.
  const buf = handBinary('hand-made', [
    { n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] },
    { n: [0, 0, 1], v: [[10, 0, 0], [10, 20, 0], [0, 20, 0]] },
  ]);
  check('the hand-assembled fixture has the ground-truth bytes for its first vertex',
    hex(buf, 96, 108) === F32[0] + F32[0] + F32[0], hex(buf, 96, 108));

  const m = importSTL(buf);
  check('import: 2 triangles', m.triCount === 2, `${m.triCount}`);
  check('import: welded to 4 vertices', m.vertCount === 4, `${m.vertCount}`);
  nearVec('import: vertex 0 is exactly (0,0,0)', m.vertex(0), [0, 0, 0]);
  nearVec('import: vertex 1 is exactly (10,0,0)', m.vertex(1), [10, 0, 0]);
  nearVec('import: vertex 2 is exactly (0,20,0)', m.vertex(2), [0, 20, 0]);
  nearVec('import: triangle 0 keeps its authored winding', m.tri(0), [0, 1, 2]);
  near('import: the two triangles cover 200 mm² of area', m.surfaceArea(), 200, 1e-4);

  const info = m.importInfo;
  check('importInfo.format is "binary"', info.format === 'binary', info.format);
  check('importInfo.triangles is 2', info.triangles === 2);
  check('importInfo reports 6 raw vertices welded down to 4', info.rawVerts === 6 && info.welded === 2,
    `raw ${info.rawVerts}, welded ${info.welded}, left ${info.vertices}`);
  check('importInfo recovers the header text as the name', info.name === 'hand-made', JSON.stringify(info.name));
  check('importInfo.bytes matches the file length', info.bytes === buf.length);
  check('a clean file produces no warnings', info.warnings.length === 0, JSON.stringify(info.warnings));

  const raw = importSTL(buf, { weld: false });
  check('weld:false keeps all 6 vertices', raw.vertCount === 6 && raw.triCount === 2, `${raw.vertCount}v`);
  check('weld:false reports welded: 0', raw.importInfo.welded === 0);
}

{
  const trap = handBinary('solid NotReallyAscii', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  const m = importSTL(trap);
  check('a binary file with a "solid" header imports as binary, not as broken ASCII',
    m.triCount === 1 && m.importInfo.format === 'binary', `${m.triCount} tris, ${m.importInfo.format}`);
  nearVec('...with its vertices intact', m.vertex(1), [10, 0, 0]);

  const coloured = handBinary('with colour', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }], { attr: 0x8421 });
  check('a non-zero attribute word (vendor colour) is tolerated', importSTL(coloured).triCount === 1);

  const empty = handBinary('empty', []);
  const em = importSTL(empty);
  check('an empty binary STL (n=0, 84 bytes) imports as an empty mesh',
    em.triCount === 0 && em.vertCount === 0 && em.importInfo.triangles === 0, `${empty.length} bytes`);

  const padded = new Uint8Array(trap.length + 8);
  padded.set(trap);
  const pm = importSTL(padded);
  check('trailing bytes are ignored but reported',
    pm.triCount === 1 && pm.importInfo.warnings.some(w => /trailing/.test(w)),
    JSON.stringify(pm.importInfo.warnings));
}

{
  // A triangle whose stored normal contradicts its winding — the file is lying,
  // and we should notice rather than silently pick one.
  const bad = handBinary('backwards', [{ n: [0, 0, -1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  const m = importSTL(bad);
  check('a normal that opposes the winding is counted', m.importInfo.flippedNormals === 1);
  check('...and warned about', m.importInfo.warnings.some(w => /oppose/.test(w)),
    JSON.stringify(m.importInfo.warnings));
  nearVec('by default the WINDING wins (normal stays +Z)', m.faceNormal(0), [0, 0, 1]);
  const fixed = importSTL(bad, { repairWinding: true });
  nearVec('repairWinding:true rewinds the triangle to match the file normal', fixed.faceNormal(0), [0, 0, -1]);
  // Vertex *indices* are assigned in first-seen order, so the repaired triangle
  // is still 0,1,2 — what moved is which authored point each index holds.
  nearVec('...by visiting the authored third corner second',
    fixed.vertex(fixed.tri(0)[1]), [0, 20, 0]);
  nearVec('...and the authored second corner third',
    fixed.vertex(fixed.tri(0)[2]), [10, 0, 0]);

  // A normal that is not plausibly unit-length is uninitialised memory, not a
  // claim about winding. Voting on it produces spurious warnings, and with
  // repairWinding on it would turn a correct mesh inside out.
  const junkN = handBinary('junk normals', [
    { n: [-1e-30, 0, 0], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] },
    { n: [0, 0, -400], v: [[0, 0, 0], [10, 0, 0], [0, 20, 5]] },
  ]);
  const jm = importSTL(junkN);
  check('an implausible (non-unit) stored normal gets no vote on winding',
    jm.importInfo.flippedNormals === 0, `${jm.importInfo.flippedNormals} counted`);
  check('...so no spurious warning is raised', jm.importInfo.warnings.length === 0,
    JSON.stringify(jm.importInfo.warnings));
  check('...and repairWinding leaves such triangles alone',
    importSTL(junkN, { repairWinding: true }).faceNormal(0)[2] === 1);
  const zeroN = handBinary('zero normals', [{ n: [0, 0, 0], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  check('a (0,0,0) normal — legal STL for "derive from winding" — is not a contradiction',
    importSTL(zeroN).importInfo.flippedNormals === 0);
}

{
  const dup = handBinary('degenerate', [
    { n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] },
    { n: [0, 0, 0], v: [[5, 5, 0], [5, 5, 0], [5, 5, 0]] },
  ]);
  const m = importSTL(dup);
  check('a zero-area triangle is dropped by welding', m.triCount === 1, `${m.triCount}`);
  check('...and reported in importInfo.degenerate', m.importInfo.degenerate === 1);
  check('...leaving no orphaned vertex behind', m.vertCount === 3, `${m.vertCount} vertices`);
  check('...with importInfo.vertices matching the mesh', m.importInfo.vertices === m.vertCount);
  check('...and a warning', m.importInfo.warnings.some(w => /degenerate/.test(w)),
    JSON.stringify(m.importInfo.warnings));
}

{
  // fs.readFileSync hands back a Buffer from a shared pool, so byteOffset is
  // almost never 0. A DataView built on `.buffer` without honouring byteOffset
  // reads someone else's bytes — the sort of bug that only shows up on real files.
  const src = handBinary('offset test', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  const pool = new Uint8Array(src.length + 32).fill(0xab);
  pool.set(src, 7);
  const view = pool.subarray(7, 7 + src.length);
  check('a view with byteOffset 7 sniffs as binary', detectFormat(view) === 'binary', detectFormat(view));
  const m = importSTL(view);
  check('a view with byteOffset 7 imports correctly', m.triCount === 1, `${m.triCount}`);
  nearVec('...with the right coordinates, not the surrounding pool bytes', m.vertex(1), [10, 0, 0]);
  const buf = Buffer.from(src);
  check('a Node Buffer imports identically', importSTL(buf).triCount === 1);
}

{
  // > 65535 triangles: the count must be a real uint32, and nothing may wrap.
  const big = icosphere(20, 6);
  const out = exportBinarySTL(big, 'big');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  check('big mesh: 81920 triangles (past the uint16 ceiling)', big.triCount === 81920, `${big.triCount}`);
  check('big mesh: count is stored as uint32 (byte 82 is non-zero)',
    dv.getUint32(80, true) === 81920 && out[82] === 0x01, `bytes ${hex(out, 80, 84)}`);
  check('big mesh: file length is 84 + 50*81920', out.length === 84 + 50 * 81920, `${out.length}`);
  const back = importSTL(out);
  check('big mesh: re-imports with all 81920 triangles', back.triCount === 81920, `${back.triCount}`);
  check('big mesh: welds back to the original vertex count',
    back.vertCount === big.vertCount, `${back.vertCount} vs ${big.vertCount}`);
  near('big mesh: volume survives the round trip to float32', back.volume(), big.volume(), 1);
}

// ---------------------------------------------------------------------------
console.log('\n-- importSTL: rejections name the byte offset --');
// ---------------------------------------------------------------------------
{
  const full = handBinary('truncated', [
    { n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] },
    { n: [0, 0, 1], v: [[10, 0, 0], [10, 20, 0], [0, 20, 0]] },
  ]);
  const cut = full.slice(0, 120);   // header says 2 triangles; only 36 bytes of one survive
  throws('a truncated binary STL is rejected as truncated',
    () => importSTL(cut), 'truncated');
  throws('...and the message names the byte offset where the file ends',
    () => importSTL(cut), 'byte offset 120');

  const liar = handBinary('liar', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }], { count: 900 });
  throws('a bogus triangle count is rejected with the claim and the reality',
    () => importSTL(liar), '900 triangles');

  const absurd = handBinary('absurd', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }], { count: 0xffffffff });
  throws('an absurd triangle count is called implausible', () => importSTL(absurd), 'implausible');
  throws('...naming byte offset 80 where it was read', () => importSTL(absurd), 'byte offset 80');
  check('the limit is configurable', (() => {
    try { importSTL(handBinary('x', [{ v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }]), { maxTriangles: 0 }); return false; }
    catch (e) { return /implausible \(limit 0\)/.test(e.message); }
  })());

  throws('a file too short to be a binary STL is rejected',
    () => importSTL(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])), 'at least 84');

  // NaN in a vertex, planted as the float32 quiet-NaN bit pattern 0x7fc00000.
  const nanBuf = handBinary('nan', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  new DataView(nanBuf.buffer).setUint32(96 + 4, 0x7fc00000, true);
  throws('a NaN vertex coordinate is rejected', () => importSTL(nanBuf), 'non-finite');
  throws('...naming the byte offset of the triangle record', () => importSTL(nanBuf), 'byte offset 96');
  const nanNormal = handBinary('nan-normal', [{ n: [0, 0, 1], v: [[0, 0, 0], [10, 0, 0], [0, 20, 0]] }]);
  new DataView(nanNormal.buffer).setUint32(84, 0x7fc00000, true);
  check('a NaN in the NORMAL is survivable — normals are recomputed from winding',
    importSTL(nanNormal).triCount === 1);

  throws('an empty file is rejected', () => importSTL(new Uint8Array(0)), 'empty');
  throws('a 3MF handed to importSTL says so', () => importSTL(export3MF(REF, 'x')), 'zip archive');
  const png = new Uint8Array(200); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  throws('a PNG is identified by name rather than mis-parsed', () => importSTL(png), 'PNG');
  throws('unrecognised text is rejected with what it actually saw',
    () => importSTL('{"this":"is json","and":"not an stl at all, really not"}'), 'unrecognised format');
}

// ---------------------------------------------------------------------------
console.log('\n-- importSTL: ASCII --');
// ---------------------------------------------------------------------------
{
  const text =
    'solid My Model Name\n' +
    'facet normal 0 0 1\n' +
    ' outer loop\n' +
    '  vertex 0 0 0\n' +
    '  vertex 1.0e+001 0 0\n' +
    '  vertex 0 2.0E1 0\n' +
    ' endloop\n' +
    'endfacet\n' +
    'endsolid My Model Name\n';
  const m = importSTL(text);
  check('ASCII: one triangle', m.triCount === 1, `${m.triCount}`);
  nearVec('ASCII: "1.0e+001" parses as 10', m.vertex(1), [10, 0, 0]);
  nearVec('ASCII: "2.0E1" parses as 20', m.vertex(2), [0, 20, 0]);
  check('ASCII: the solid name keeps its spaces', m.importInfo.name === 'My Model Name',
    JSON.stringify(m.importInfo.name));
  check('ASCII: importInfo.format is "ascii"', m.importInfo.format === 'ascii');
  check('ASCII: one solid counted', m.importInfo.solids === 1);

  const crlf = importSTL(text.replace(/\n/g, '\r\n').replace(/ /g, '\t '));
  check('ASCII: CRLF and tab indentation parse the same', crlf.triCount === 1);
  nearVec('...with identical coordinates', crlf.vertex(1), [10, 0, 0]);

  const bom = importSTL('ï»¿' + text);
  check('ASCII: a UTF-8 BOM does not break the parse', bom.triCount === 1);

  const two = importSTL(text + text.replace(/My Model Name/g, 'Second'));
  check('ASCII: two solids in one file are merged', two.triCount === 2 && two.importInfo.solids === 2,
    `${two.triCount} tris, ${two.importInfo.solids} solids`);

  const emptySolid = importSTL('solid nothing\nendsolid nothing\n');
  check('ASCII: an empty solid imports as an empty mesh', emptySolid.triCount === 0);

  const quad =
    'solid quad\nfacet normal 0 0 1\nouter loop\n' +
    'vertex 0 0 0\nvertex 10 0 0\nvertex 10 10 0\nvertex 0 10 0\n' +
    'endloop\nendfacet\nendsolid quad\n';
  const q = importSTL(quad);
  check('ASCII: a 4-vertex loop is fan-triangulated into 2 triangles', q.triCount === 2, `${q.triCount}`);
  check('...and reported as a deviation', q.importInfo.warnings.some(w => /fan-triangulated/.test(w)),
    JSON.stringify(q.importInfo.warnings));
  near('...covering the full 100 mm² quad', q.surfaceArea(), 100, 1e-9);

  const headless = importSTL(
    'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n');
  check('ASCII: facets without a "solid" line still parse', headless.triCount === 1);

  const oneLine = importSTL(
    'solid x\nfacet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet\nendsolid x\n');
  check('ASCII: a facet crammed onto one line parses', oneLine.triCount === 1);

  // Bare-CR line endings (classic Mac, and some CAM post-processors) mean the
  // whole file arrives as one "line" that starts with "solid" — the case that
  // silently produced an empty mesh before the solid-line split.
  const crOnly = importSTL(text.replace(/\n/g, '\r'));
  check('ASCII: a file with bare-CR line endings still yields its triangle',
    crOnly.triCount === 1, `${crOnly.triCount}`);
  nearVec('...with correct coordinates', crOnly.vertex(1), [10, 0, 0]);
  const whole = importSTL(text.replace(/\n/g, ' '));
  check('ASCII: an entire STL on a single line still parses', whole.triCount === 1, `${whole.triCount}`);
  check('...and keeps the solid name up to the first facet', whole.importInfo.name === 'My Model Name',
    JSON.stringify(whole.importInfo.name));

  throws('ASCII: "nan" as a coordinate is rejected',
    () => importSTL('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex nan 0 0\nvertex 0 1 0\nendloop\nendfacet\n'),
    'non-finite');
  throws('ASCII: a missing coordinate is rejected with the line and byte offset',
    () => importSTL('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0\nendloop\nendfacet\n'),
    'line 4');
  throws('ASCII: a truncated loop is rejected',
    () => importSTL('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\n'),
    'only 2 vertices');
  throws('ASCII: garbage where a number belongs is rejected',
    () => importSTL('solid x\nfacet normal 0 0 1\nouter loop\nvertex zero 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n'),
    'expected a number');
}

{
  // Cross-format agreement: the ASCII writer and the binary writer must describe
  // the same solid, checked through the importer rather than by eye.
  const src = tetra(8);
  const viaAscii = importSTL(exportASCIISTL(src, 'tetra'));
  const viaBinary = importSTL(exportBinarySTL(src, 'tetra'));
  check('ASCII and binary exports of one mesh import to the same triangle count',
    viaAscii.triCount === viaBinary.triCount && viaAscii.triCount === 4, `${viaAscii.triCount}`);
  near('...and the same volume as the source', viaAscii.volume(), src.volume(), 1e-4);
  near('...binary too', viaBinary.volume(), src.volume(), 1e-4);
}

// ---------------------------------------------------------------------------
console.log('\n-- OBJ export --');
// ---------------------------------------------------------------------------
{
  const obj = exportOBJ(REF, 'tri');
  const lines = obj.split('\n').filter(Boolean);
  check('OBJ: 3 v lines', lines.filter(l => l.startsWith('v ')).length === 3);
  check('OBJ: 3 vn lines', lines.filter(l => l.startsWith('vn ')).length === 3);
  check('OBJ: 1 f line', lines.filter(l => l.startsWith('f ')).length === 1);
  check('OBJ: face indices are 1-based v//vn', lines.find(l => l.startsWith('f ')) === 'f 1//1 2//2 3//3',
    lines.find(l => l.startsWith('f ')));
  check('OBJ: the object is named', obj.includes('\no tri\n'));

  const c = exportOBJ(cube(10), 'cube');
  const faces = c.split('\n').filter(l => l.startsWith('f '));
  const maxIdx = Math.max(...faces.flatMap(l => l.slice(2).split(' ').map(s => +s.split('//')[0])));
  check('OBJ: cube writes 12 faces', faces.length === 12, `${faces.length}`);
  check('OBJ: no face index exceeds the vertex count', maxIdx === 8, `max index ${maxIdx}`);
  check('OBJ: no index is 0 (OBJ is 1-based)',
    !faces.some(l => /\b0\/\//.test(l)));
  check('OBJ export is deterministic', exportOBJ(cube(10), 'cube') === c);
}
throws('OBJ export rejects a NaN coordinate',
  () => exportOBJ(triMesh([[0, 0, 0], [1, 0, 0], [0, Infinity, 0]], [[0, 1, 2]]), 'bad'), 'non-finite');
// Must throw rather than write NaN normals: exportOBJ reads the vertex buffer
// through Mesh#vertexNormals before it ever walks the triangles.
throws('OBJ export rejects an out-of-range index before computing normals',
  () => exportOBJ(triMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 9]]), 'bad'), 'vertex 9');

// ---------------------------------------------------------------------------
console.log('\n-- 3MF export: a STORED zip, parsed back by hand --');
// ---------------------------------------------------------------------------
{
  const z = export3MF(cube(10), 'cube');
  check('3MF starts with the local-file-header signature PK\\x03\\x04', hex(z, 0, 4) === '504b0304', hex(z, 0, 4));

  const zip = readZip(z);
  check('3MF: the end-of-central-directory record parses', zip.entries === 3, `${zip.entries} entries`);
  check('3MF: the three OPC parts are present and in order',
    zip.files.map(f => f.name).join('|') === '[Content_Types].xml|_rels/.rels|3D/3dmodel.model',
    zip.files.map(f => f.name).join(', '));
  check('3MF: [Content_Types].xml is first, as OPC streaming readers require',
    zip.files[0].name === '[Content_Types].xml');
  check('3MF: every entry is STORED (method 0)', zip.files.every(f => f.method === 0));
  check('3MF: compressed size equals uncompressed size for every entry',
    zip.files.every(f => f.csize === f.usize && f.csize === f.data.length));
  check('3MF: local and central headers agree on every size',
    zip.files.every(f => f.lCsize === f.csize));
  check('3MF: every CRC-32 matches an independently computed one',
    zip.files.every(f => crc32Bitwise(f.data) === f.crc),
    zip.files.map(f => '0x' + f.crc.toString(16)).join(' '));
  check('3MF: the DOS timestamp is the fixed 1980-01-01 epoch, not the clock',
    zip.files.every(f => f.date === 0x0021 && f.time === 0x0000),
    `date 0x${zip.files[0].date.toString(16)}, time 0x${zip.files[0].time.toString(16)}`);
  check('3MF: the central directory offset and size are self-consistent',
    zip.cdOffset + zip.cdSize === zip.eocd, `${zip.cdOffset}+${zip.cdSize} vs ${zip.eocd}`);

  const model = latin1(zip.files[2].data);
  check('3MF: the model declares millimetres', model.includes('unit="millimeter"'));
  check('3MF: the model uses the 3MF core namespace',
    model.includes('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'));
  check('3MF: 8 vertices for a cube', (model.match(/<vertex /g) || []).length === 8);
  check('3MF: 12 triangles for a cube', (model.match(/<triangle /g) || []).length === 12);
  check('3MF: a known corner is present at the right coordinates',
    model.includes('<vertex x="-5" y="-5" z="-5"/>'));
  check('3MF: triangle indices are 0-based and reference real vertices',
    (model.match(/v1="(\d+)"/g) || []).every(s => +s.slice(4, -1) < 8));
  check('3MF: a build item places the object', model.includes('<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'));
  check('3MF: the relationship part points at the model',
    latin1(zip.files[1].data).includes('Target="/3D/3dmodel.model"'));
  check('3MF: content types declare the 3dmodel part',
    latin1(zip.files[0].data).includes('application/vnd.ms-package.3dmanufacturing-3dmodel+xml'));

  const z2 = export3MF(cube(10), 'cube');
  check('3MF export is deterministic (no timestamp, no ordering wobble)',
    z.length === z2.length && z.every((b, i) => b === z2[i]), `${z.length} vs ${z2.length} bytes`);
  check('3MF escapes XML metacharacters in the model name',
    latin1(readZip(export3MF(REF, 'a & b <c>')).files[2].data).includes('name="a &amp; b &lt;c&gt;"'));
  check('3MF of an empty mesh is still a valid zip',
    readZip(export3MF(new Mesh(), 'nothing')).entries === 3);
}

done();
