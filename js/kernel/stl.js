// STL / OBJ / 3MF — getting geometry out of Bluesheet and back in, byte-exactly.
//
// Three rules shape everything here:
//
//  1. Determinism is a contract, not a nicety. Nothing in a file Bluesheet writes may
//     depend on the clock, the hostname, the locale, or Map iteration order, so
//     that `build(p)` twice gives byte-identical output and a library thumbnail
//     can be keyed on a hash. That rules out `new Date()` in the STL header and
//     in the zip's DOS timestamp, and rules out `toLocaleString` anywhere.
//
//  2. Import must survive the wild. Real STLs on the internet are truncated,
//     have "solid" at the start of a *binary* header, carry NaNs from a broken
//     exporter, disagree between their stored normal and their winding, and use
//     CRLF with random indentation. Every one of those is handled or refused
//     with an error that names the byte offset, because "invalid STL" wastes an
//     afternoon and "truncated at offset 1284, header claims 900 triangles but
//     the file holds 24" does not.
//
//  3. No DOM. This module runs in Node for the test suite and in the browser for
//     the download button, so it speaks Uint8Array/ArrayBuffer/string and lets
//     the caller wrap it in a Blob.
//
// Imports only mesh.js. No dependencies.

import { Mesh } from './mesh.js';

// A binary STL of 20M triangles is a 1 GB file. Anything past that is a
// misidentified file, not a model, and we should say so before allocating.
const DEFAULT_MAX_TRIANGLES = 20_000_000;

const TRI_BYTES = 50;      // 12 float32 + uint16 attribute
const HEADER_BYTES = 84;   // 80-byte header + uint32 count

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/** Accept anything a browser file input, fetch(), or Node fs can hand us. */
function toU8(input, who) {
  if (input instanceof Uint8Array) return input;                 // Node Buffer lands here too
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') {
    const u = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) u[i] = input.charCodeAt(i) & 0xff;
    return u;
  }
  throw new TypeError(`${who}: expected an ArrayBuffer, a typed array, or a string, got ${input === null ? 'null' : typeof input}`);
}

/** A DataView over exactly the bytes of `u8` — respects byteOffset on subarrays. */
function dvOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

/**
 * Decimal text for a coordinate, stable across engines and free of "-0".
 * 9 significant digits is the round-trip precision of a float32, which is the
 * resolution of the format we are usually writing into; more digits would only
 * make the file bigger while claiming accuracy the binary form cannot carry.
 */
export function fmtNum(v) {
  if (v === 0) return '0';                 // also normalises -0, which String() would print as "0" anyway
  const r = Number(v.toPrecision(9));      // toPrecision is spec-exact, so this is deterministic
  return String(r);
}

export function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** Printable-ASCII only, on one line — for STL headers, OBJ names, zip metadata. */
export function sanitizeName(name, fallback = 'bluesheet') {
  let s = String(name ?? '').replace(/[^\x20-\x7e]/g, ' ').trim();
  return s.length ? s : fallback;
}

/**
 * Validate the mesh once and hand each triangle's nine coordinates to `cb`.
 * Every exporter goes through here so the error messages are identical and a
 * bad index or a NaN is caught before we have written half a file.
 */
function eachTriangle(mesh, who, cb) {
  const { positions: p, tris: t } = requireMesh(mesh, who);
  const vc = p.length / 3;
  const n = t.length / 3;
  for (let i = 0; i < n; i++) {
    const a = t[i * 3], b = t[i * 3 + 1], c = t[i * 3 + 2];
    // Checked longhand rather than over a [a,b,c] array: this is the hot loop of
    // every export, and one throwaway array per triangle is a 200k-allocation
    // tax on a terrain tile.
    if (!inRange(a, vc)) badIndex(who, i, a, vc);
    if (!inRange(b, vc)) badIndex(who, i, b, vc);
    if (!inRange(c, vc)) badIndex(who, i, c, vc);
    const ao = a * 3, bo = b * 3, co = c * 3;
    const ax = p[ao], ay = p[ao + 1], az = p[ao + 2];
    const bx = p[bo], by = p[bo + 1], bz = p[bo + 2];
    const cx = p[co], cy = p[co + 1], cz = p[co + 2];
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az))) badVertex(who, a, ax, ay, az, i);
    if (!(Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz))) badVertex(who, b, bx, by, bz, i);
    if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz))) badVertex(who, c, cx, cy, cz, i);
    cb(i, ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  return n;
}

function inRange(i, vc) { return Number.isInteger(i) && i >= 0 && i < vc; }

function badIndex(who, tri, idx, vc) {
  throw new RangeError(`${who}: triangle ${tri} references vertex ${idx}, but the mesh has ${vc} vertices`);
}

function badVertex(who, v, x, y, z, tri) {
  const used = tri >= 0 ? ` (used by triangle ${tri})` : '';
  throw new Error(`${who}: vertex ${v}${used} has a non-finite coordinate (${x}, ${y}, ${z}) — a generator produced NaN or Infinity`);
}

/**
 * Index-only validation, for exporters that read the vertex buffer before they
 * ever reach eachTriangle. Without this, exportOBJ would hand a bad index to
 * Mesh#vertexNormals first, and typed-array writes past the end are silently
 * dropped — the file would come out full of NaN normals instead of throwing.
 */
function requireIndicesInRange(mesh, who) {
  const vc = mesh.positions.length / 3, t = mesh.tris;
  for (let i = 0; i < t.length; i++) if (!inRange(t[i], vc)) badIndex(who, (i / 3) | 0, t[i], vc);
}

function requireMesh(mesh, who) {
  if (!mesh || typeof mesh !== 'object' || !mesh.positions || !mesh.tris) {
    throw new TypeError(`${who}: expected a Mesh with positions and tris`);
  }
  const { positions, tris } = mesh;
  if (positions.length % 3) throw new Error(`${who}: positions.length is ${positions.length}, not a multiple of 3`);
  if (tris.length % 3) throw new Error(`${who}: tris.length is ${tris.length}, not a multiple of 3`);
  return mesh;
}

/**
 * Unit face normal from three points, written out longhand so the exporters do
 * not allocate an array per triangle. A degenerate triangle gets (0,0,0), which
 * the STL spec explicitly permits and every slicer reads as "derive from winding".
 */
function faceNormalInto(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  return out;
}

// ---------------------------------------------------------------------------
// export: binary STL
// ---------------------------------------------------------------------------

/**
 * Binary STL: 80-byte header, uint32 LE triangle count, then per triangle
 * 12 little-endian float32 (normal, then three vertices) and a uint16 attribute.
 *
 * The header is `Bluesheet <name>` space-padded — deliberately *not* starting with
 * "solid", since a binary header that begins "solid" is the single most common
 * cause of an importer mistaking a binary file for ASCII. It carries no clock
 * and no hostname: two exports of the same mesh must be byte-identical.
 *
 * Byte-for-byte identical to Mesh#toSTL for any ASCII name; the two writers are
 * independent, which is how we know the float layout is right.
 */
export function exportBinarySTL(mesh, name = 'bluesheet') {
  requireMesh(mesh, 'exportBinarySTL');
  const n = mesh.tris.length / 3;
  const bytes = HEADER_BYTES + n * TRI_BYTES;
  // ArrayBuffer allocation failure is an opaque RangeError; say what happened.
  if (bytes > 0x7fffffff) {
    throw new RangeError(`exportBinarySTL: ${n} triangles would be a ${(bytes / 1e9).toFixed(1)} GB file — refusing to allocate`);
  }
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);

  const header = `Bluesheet ${sanitizeName(name)}`.slice(0, 79);
  for (let i = 0; i < 80; i++) u8[i] = i < header.length ? header.charCodeAt(i) : 0x20;
  dv.setUint32(80, n, true);

  const nrm = [0, 0, 0];
  let o = HEADER_BYTES;
  eachTriangle(mesh, 'exportBinarySTL', (t, ax, ay, az, bx, by, bz, cx, cy, cz) => {
    faceNormalInto(nrm, ax, ay, az, bx, by, bz, cx, cy, cz);
    dv.setFloat32(o, nrm[0], true); dv.setFloat32(o + 4, nrm[1], true); dv.setFloat32(o + 8, nrm[2], true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
    dv.setUint16(o + 48, 0, true);
    o += TRI_BYTES;
  });
  return u8;
}

// ---------------------------------------------------------------------------
// export: ASCII STL
// ---------------------------------------------------------------------------

/**
 * ASCII STL. Roughly six times the size of the binary form, so it exists for
 * eyeballing and diffing, not for slicing. LF line endings and a deterministic
 * number format, so two exports diff clean.
 */
export function exportASCIISTL(mesh, name = 'bluesheet') {
  requireMesh(mesh, 'exportASCIISTL');
  const solid = sanitizeName(name);
  const parts = [];
  let chunk = `solid ${solid}\n`;
  const nrm = [0, 0, 0];
  eachTriangle(mesh, 'exportASCIISTL', (t, ax, ay, az, bx, by, bz, cx, cy, cz) => {
    faceNormalInto(nrm, ax, ay, az, bx, by, bz, cx, cy, cz);
    chunk +=
      `  facet normal ${fmtNum(nrm[0])} ${fmtNum(nrm[1])} ${fmtNum(nrm[2])}\n` +
      `    outer loop\n` +
      `      vertex ${fmtNum(ax)} ${fmtNum(ay)} ${fmtNum(az)}\n` +
      `      vertex ${fmtNum(bx)} ${fmtNum(by)} ${fmtNum(bz)}\n` +
      `      vertex ${fmtNum(cx)} ${fmtNum(cy)} ${fmtNum(cz)}\n` +
      `    endloop\n` +
      `  endfacet\n`;
    // Flush periodically: one 200 MB rope of string concatenations is what makes
    // naive ASCII writers fall over on a lithophane.
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  });
  chunk += `endsolid ${solid}\n`;
  parts.push(chunk);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// export: OBJ
// ---------------------------------------------------------------------------

/**
 * Wavefront OBJ, for dropping a Bluesheet part into Blender to check it by eye.
 *
 * The mesh is written exactly as it stands — no welding — because a Bluesheet mesh
 * is usually intentionally unwelded at hard edges, and welding here would smooth
 * a box's corners in every viewer that honours the vn lines.
 */
export function exportOBJ(mesh, name = 'bluesheet') {
  requireMesh(mesh, 'exportOBJ');
  requireIndicesInRange(mesh, 'exportOBJ');
  const obj = sanitizeName(name);
  const p = mesh.positions;
  const vc = p.length / 3;
  for (let v = 0; v < vc; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) badVertex('exportOBJ', v, x, y, z, -1);
  }
  const normals = mesh.vertexNormals();

  const parts = [];
  let chunk = `# Bluesheet ${obj}\n# ${vc} vertices, ${mesh.tris.length / 3} triangles, millimetres, Z up\no ${obj}\n`;
  for (let v = 0; v < vc; v++) {
    chunk += `v ${fmtNum(p[v * 3])} ${fmtNum(p[v * 3 + 1])} ${fmtNum(p[v * 3 + 2])}\n`;
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  }
  for (let v = 0; v < vc; v++) {
    chunk += `vn ${fmtNum(normals[v * 3])} ${fmtNum(normals[v * 3 + 1])} ${fmtNum(normals[v * 3 + 2])}\n`;
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  }
  // OBJ indices are 1-based, and v//vn shares the index because our normals are
  // per-vertex over the same buffer.
  eachTriangle(mesh, 'exportOBJ', (t) => {
    const a = mesh.tris[t * 3] + 1, b = mesh.tris[t * 3 + 1] + 1, c = mesh.tris[t * 3 + 2] + 1;
    chunk += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  });
  parts.push(chunk);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// export: 3MF (a STORED zip of three XML parts)
// ---------------------------------------------------------------------------

let CRC_TABLE = null;

/** Standard CRC-32 (reflected, poly 0xEDB88320) — what zip requires. */
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// 1980-01-01 00:00:00, the earliest representable DOS timestamp. A constant, not
// a clock, because two exports of the same model must hash the same.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;   // (1980-1980)<<9 | 1<<5 | 1

/**
 * Write a zip with every entry STORED (method 0). Deflate would need a
 * compressor and buys little on XML that a slicer reads once; STORED keeps this
 * dependency-free and is what the OPC readers in the Bambu/Orca/Prusa lineage
 * handle most happily.
 */
export function writeZipStored(files) {
  const enc = new TextEncoder();
  const recs = files.map(f => {
    const nameBytes = enc.encode(f.name);
    if (f.data.length > 0xffffffff) throw new RangeError(`writeZipStored: "${f.name}" is too large for a zip32 entry`);
    return { nameBytes, data: f.data, crc: crc32(f.data), offset: 0 };
  });

  let total = 0;
  for (const r of recs) total += 30 + r.nameBytes.length + r.data.length;
  const cdStart = total;
  for (const r of recs) total += 46 + r.nameBytes.length;
  const cdSize = total - cdStart;
  total += 22;
  if (total > 0x7fffffff) {
    throw new RangeError(`writeZipStored: the package would be ${(total / 1e9).toFixed(1)} GB — zip64 would be needed and is not implemented`);
  }

  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let o = 0;

  for (const r of recs) {
    r.offset = o;
    dv.setUint32(o, 0x04034b50, true);          // local file header
    dv.setUint16(o + 4, 20, true);              // version needed: 2.0
    dv.setUint16(o + 6, 0, true);               // flags (names are ASCII, so no UTF-8 bit)
    dv.setUint16(o + 8, 0, true);               // method: stored
    dv.setUint16(o + 10, DOS_TIME, true);
    dv.setUint16(o + 12, DOS_DATE, true);
    dv.setUint32(o + 14, r.crc, true);
    dv.setUint32(o + 18, r.data.length, true);  // compressed size
    dv.setUint32(o + 22, r.data.length, true);  // uncompressed size
    dv.setUint16(o + 26, r.nameBytes.length, true);
    dv.setUint16(o + 28, 0, true);              // extra field length
    o += 30;
    u8.set(r.nameBytes, o); o += r.nameBytes.length;
    u8.set(r.data, o); o += r.data.length;
  }

  for (const r of recs) {
    dv.setUint32(o, 0x02014b50, true);          // central directory header
    dv.setUint16(o + 4, 20, true);              // version made by
    dv.setUint16(o + 6, 20, true);              // version needed
    dv.setUint16(o + 8, 0, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, DOS_TIME, true);
    dv.setUint16(o + 14, DOS_DATE, true);
    dv.setUint32(o + 16, r.crc, true);
    dv.setUint32(o + 20, r.data.length, true);
    dv.setUint32(o + 24, r.data.length, true);
    dv.setUint16(o + 28, r.nameBytes.length, true);
    dv.setUint16(o + 30, 0, true);              // extra
    dv.setUint16(o + 32, 0, true);              // comment
    dv.setUint16(o + 34, 0, true);              // disk number start
    dv.setUint16(o + 36, 0, true);              // internal attributes
    dv.setUint32(o + 38, 0, true);              // external attributes
    dv.setUint32(o + 42, r.offset, true);
    o += 46;
    u8.set(r.nameBytes, o); o += r.nameBytes.length;
  }

  dv.setUint32(o, 0x06054b50, true);            // end of central directory
  dv.setUint16(o + 4, 0, true);                 // this disk
  dv.setUint16(o + 6, 0, true);                 // disk with the start of the CD
  dv.setUint16(o + 8, recs.length, true);
  dv.setUint16(o + 10, recs.length, true);
  dv.setUint32(o + 12, cdSize, true);
  dv.setUint32(o + 16, cdStart, true);
  dv.setUint16(o + 20, 0, true);                // comment length
  return u8;
}

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
  `</Types>\n`;

const RELS_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
  `</Relationships>\n`;

/**
 * The `   <mesh>...</mesh>\n` element of a 3MF object, every vertex moved by
 * `-shift` on the way out. Shared by export3MF and the Bambu project writer
 * (js/kernel/bambu.js), which stores its object centred on its own bounding box
 * the way Bambu Studio does. Built in 64 kB chunks so a 200k-triangle mesh is
 * not one string grown a line at a time.
 */
export function meshXml(mesh, who, shift = [0, 0, 0]) {
  requireMesh(mesh, who);
  const p = mesh.positions;
  const vc = p.length / 3;
  const [sx, sy, sz] = shift;
  const parts = [];
  let chunk = `   <mesh>\n    <vertices>\n`;
  for (let v = 0; v < vc; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) badVertex(who, v, x, y, z, -1);
    chunk += `     <vertex x="${fmtNum(x - sx)}" y="${fmtNum(y - sy)}" z="${fmtNum(z - sz)}"/>\n`;
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  }
  chunk += `    </vertices>\n    <triangles>\n`;
  eachTriangle(mesh, who, (t) => {
    chunk += `     <triangle v1="${mesh.tris[t * 3]}" v2="${mesh.tris[t * 3 + 1]}" v3="${mesh.tris[t * 3 + 2]}"/>\n`;
    if (chunk.length > 1 << 16) { parts.push(chunk); chunk = ''; }
  });
  parts.push(chunk + `    </triangles>\n   </mesh>\n`);
  return parts.join('');
}

function model3MFXml(mesh, name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    ` <metadata name="Application">Bluesheet</metadata>\n` +
    ` <metadata name="Title">${xmlEscape(name)}</metadata>\n` +
    ` <resources>\n  <object id="1" type="model" name="${xmlEscape(name)}">\n` +
    meshXml(mesh, 'export3MF') +
    `  </object>\n </resources>\n` +
    ` <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n </build>\n</model>\n`;
}

/**
 * 3MF — the format Bambu Studio actually wants. It is an OPC package: a zip
 * holding [Content_Types].xml, a relationship part pointing at the model, and
 * the model itself as XML. Unlike STL it carries units (so nothing arrives at
 * 1/25.4 scale) and shares vertices (so a 200k-triangle terrain tile is a third
 * of the size).
 *
 * [Content_Types].xml goes first because OPC readers that stream expect it there.
 */
export function export3MF(mesh, name = 'bluesheet') {
  requireMesh(mesh, 'export3MF');
  const title = sanitizeName(name);
  const enc = new TextEncoder();
  return writeZipStored([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: enc.encode(RELS_XML) },
    { name: '3D/3dmodel.model', data: enc.encode(model3MFXml(mesh, title)) },
  ]);
}

// ---------------------------------------------------------------------------
// format sniffing
// ---------------------------------------------------------------------------

function isTextPrefix(u8, limit) {
  const lim = Math.min(u8.length, limit);
  for (let i = 0; i < lim; i++) {
    const b = u8[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b > 126) return false;
  }
  return true;
}

function skipSpace(u8, i) {
  while (i < u8.length && (u8[i] === 32 || u8[i] === 9 || u8[i] === 10 || u8[i] === 13)) i++;
  return i;
}

function matchesAt(u8, i, word) {
  if (i + word.length > u8.length) return false;
  for (let k = 0; k < word.length; k++) {
    if ((u8[i + k] | 0x20) !== word.charCodeAt(k)) return false;   // ASCII case-insensitive
  }
  return true;
}

function containsWord(u8, word, limit) {
  const lim = Math.min(u8.length, limit) - word.length;
  for (let i = 0; i <= lim; i++) if (matchesAt(u8, i, word)) return true;
  return false;
}

/** A UTF-8 BOM in front of an ASCII STL is rare but real; find where text starts. */
function bomLength(u8) { return (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) ? 3 : 0; }

/**
 * Does the first triangle record look like one? A real STL normal is either a
 * unit vector or exactly zero, which is a strong, cheap plausibility test on a
 * file whose length does not match `84 + 50n` exactly.
 */
function firstNormalPlausible(u8) {
  if (u8.length < HEADER_BYTES + 12) return false;
  const dv = dvOf(u8);
  const x = dv.getFloat32(84, true), y = dv.getFloat32(88, true), z = dv.getFloat32(92, true);
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return false;
  const l = Math.hypot(x, y, z);
  return l === 0 || Math.abs(l - 1) < 1e-3;
}

/**
 * 'binary' | 'ascii' | '3mf' | 'empty' | 'unknown'.
 *
 * The classic trap is that "starts with solid" proves nothing: plenty of binary
 * exporters write a header beginning "solid" (it was a Windows-era habit meant
 * to placate ASCII-only readers), and plenty of ASCII files start with something
 * else entirely. So the *strong* signals are used first:
 *
 *   - a pure-text prefix that starts with "solid" and contains facet/endsolid
 *     is ASCII (a binary file's float payload begins at byte 84 and is
 *     essentially certain to contain a byte outside printable ASCII, so a
 *     512-byte all-printable prefix rules binary out);
 *   - otherwise `84 + 50n === byteLength` for the count at offset 80 is the
 *     definitive binary test;
 *   - a file that satisfies neither but fits `84 + 50n < byteLength` *and* whose
 *     first stored normal is unit-length is a binary STL with trailing junk,
 *     which several exporters produce. Without the normal test that branch
 *     swallows arbitrary garbage whose bytes 80-83 happen to be small.
 */
export function detectFormat(input) {
  const u8 = toU8(input, 'detectFormat');
  if (u8.length === 0) return 'empty';

  // PK\003\004 / PK\005\006 / PK\007\010 — a zip, so almost certainly a 3MF here.
  if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7)) return '3mf';

  const bom = bomLength(u8);
  const text = bom ? u8.subarray(bom) : u8;
  const start = skipSpace(text, 0);
  const textish = isTextPrefix(text, 512);
  if (textish && matchesAt(text, start, 'solid') &&
      (containsWord(text, 'facet', 8192) || containsWord(text, 'endsolid', 8192))) {
    return 'ascii';
  }

  if (u8.length >= HEADER_BYTES) {
    const n = dvOf(u8).getUint32(80, true);
    if (HEADER_BYTES + n * TRI_BYTES === u8.length) return 'binary';
    if (n > 0 && HEADER_BYTES + n * TRI_BYTES < u8.length && firstNormalPlausible(u8)) return 'binary';
  }

  // Last resort: text that looks like an STL body but whose "solid" line is
  // missing or mangled. Cheap to accept, and it beats refusing a real file.
  if (textish && containsWord(text, 'facet normal', 8192)) return 'ascii';

  return 'unknown';
}

// Magic numbers worth naming, so "unrecognised STL" does not get thrown at a
// file the user obviously picked by mistake.
const MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47], what: 'a PNG image' },
  { sig: [0xff, 0xd8, 0xff], what: 'a JPEG image' },
  { sig: [0x25, 0x50, 0x44, 0x46], what: 'a PDF' },
  { sig: [0x1f, 0x8b, 0x08], what: 'a gzip archive' },   // 3 bytes: two is thin enough to hit a real header
  { sig: [0x67, 0x6c, 0x54, 0x46], what: 'a binary glTF (.glb)' },
];

function identifyMagic(u8) {
  for (const m of MAGIC) {
    if (u8.length >= m.sig.length && m.sig.every((b, i) => u8[i] === b)) return m.what;
  }
  return null;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/**
 * Accumulates triangles, optionally welding coincident vertices as it goes.
 *
 * Welding during the parse rather than afterwards matters: an STL has no shared
 * vertices at all, so a 500k-triangle file would otherwise build a 1.5M-vertex
 * position array and then throw 80% of it away. The quantisation key is exactly
 * the one Mesh#weld uses, so `importSTL(...)` and `importSTL(..., {weld:false}).weld(eps)`
 * agree.
 */
function makeSink(weldOn, eps) {
  const inv = 1 / Math.max(eps, 1e-12);
  const map = weldOn ? new Map() : null;
  const positions = [], tris = [];
  let rawVerts = 0, degenerate = 0;

  const vertexIndex = (x, y, z) => {
    rawVerts++;
    if (!map) { positions.push(x, y, z); return positions.length / 3 - 1; }
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let i = map.get(key);
    if (i === undefined) { i = positions.length / 3; positions.push(x, y, z); map.set(key, i); }
    return i;
  };
  const addTri = (a, b, c) => {
    if (a === b || b === c || a === c) { degenerate++; return; }
    tris.push(a, b, c);
  };
  return {
    positions, tris,
    add(ax, ay, az, bx, by, bz, cx, cy, cz) {
      addTri(vertexIndex(ax, ay, az), vertexIndex(bx, by, bz), vertexIndex(cx, cy, cz));
    },
    addFlipped(ax, ay, az, bx, by, bz, cx, cy, cz) {
      addTri(vertexIndex(ax, ay, az), vertexIndex(cx, cy, cz), vertexIndex(bx, by, bz));
    },
    get stats() {
      return { rawVerts, vertices: positions.length / 3, welded: rawVerts - positions.length / 3, degenerate };
    },
  };
}

/**
 * Does the file's stored normal contradict the triangle's winding?
 *
 * Only a plausibly unit-length normal gets a vote. Files exist whose normal
 * field is uninitialised memory or a scaled-up direction; treating those as
 * evidence produces a stream of spurious "winding disagrees" warnings and, with
 * repairWinding on, would turn a correct mesh inside out.
 */
function normalContradictsWinding(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
  const len2 = nx * nx + ny * ny + nz * nz;
  if (!(len2 >= 0.25 && len2 <= 4)) return false;   // also excludes 0 and NaN
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz) < 0;
}

function decodeLatin1(u8) {
  // Latin-1 (not UTF-8) on purpose: it is a 1:1 byte-to-char map, so a character
  // index in the decoded string IS a byte offset in the file, which is what makes
  // "at byte offset 1284" in a parse error true rather than approximately true.
  try {
    return new TextDecoder('latin1').decode(u8);
  } catch {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
    }
    return s;
  }
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const isFacet = (t) => t.toLowerCase() === 'facet';
const isVertex = (t) => t.toLowerCase() === 'vertex';

function parseNum(tok, where) {
  if (!NUM_RE.test(tok)) {
    if (/^[+-]?(?:nan|inf(?:inity)?)$/i.test(tok)) {
      throw new Error(`importSTL: non-finite coordinate "${tok}" ${where}`);
    }
    throw new Error(`importSTL: expected a number, got "${tok.length > 24 ? tok.slice(0, 24) + '…' : tok}" ${where}`);
  }
  const v = Number(tok);
  if (!Number.isFinite(v)) throw new Error(`importSTL: coordinate "${tok}" overflows to ${v} ${where}`);
  return v;
}

function importBinary(u8, opts, info) {
  const dv = dvOf(u8);
  if (u8.length < HEADER_BYTES) {
    throw new Error(`importSTL: file is ${u8.length} bytes — a binary STL needs at least ${HEADER_BYTES} (80-byte header + uint32 count at offset 80)`);
  }
  const n = dv.getUint32(80, true);
  const maxTris = opts.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  if (n > maxTris) {
    throw new Error(`importSTL: triangle count ${n} read at byte offset 80 is implausible (limit ${maxTris}) — this is probably not a binary STL`);
  }
  const need = HEADER_BYTES + n * TRI_BYTES;
  if (u8.length < need) {
    const have = Math.floor((u8.length - HEADER_BYTES) / TRI_BYTES);
    throw new Error(`importSTL: truncated binary STL — the count at byte offset 80 claims ${n} triangles (${need} bytes) but the file ends at byte offset ${u8.length}, holding only ${have}`);
  }
  if (u8.length > need) {
    info.warnings.push(`${u8.length - need} trailing bytes after the last triangle (byte offset ${need}) were ignored`);
  }

  // The header is worth keeping: some exporters put the model name in it, and it
  // is the only place a binary STL can carry one.
  let header = '';
  for (let i = 0; i < 80; i++) { const b = u8[i]; if (b >= 32 && b <= 126) header += String.fromCharCode(b); }
  info.name = header.trim();
  info.triangles = n;

  const sink = makeSink(opts.weld !== false, opts.eps ?? 1e-6);
  const repair = opts.repairWinding === true;
  let flipped = 0;
  let o = HEADER_BYTES;
  for (let t = 0; t < n; t++) {
    const nx = dv.getFloat32(o, true), ny = dv.getFloat32(o + 4, true), nz = dv.getFloat32(o + 8, true);
    const ax = dv.getFloat32(o + 12, true), ay = dv.getFloat32(o + 16, true), az = dv.getFloat32(o + 20, true);
    const bx = dv.getFloat32(o + 24, true), by = dv.getFloat32(o + 28, true), bz = dv.getFloat32(o + 32, true);
    const cx = dv.getFloat32(o + 36, true), cy = dv.getFloat32(o + 40, true), cz = dv.getFloat32(o + 44, true);
    // Only the vertices are load-bearing. A NaN normal is common in files from
    // broken exporters and is harmless because we recompute normals from winding
    // anyway; a NaN vertex is unrecoverable and must stop the import.
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az) &&
          Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz) &&
          Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz))) {
      throw new Error(`importSTL: non-finite vertex coordinate in triangle ${t} at byte offset ${o + 12} — the file contains NaN or Infinity`);
    }
    if (normalContradictsWinding(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz)) {
      flipped++;
      if (repair) { sink.addFlipped(ax, ay, az, bx, by, bz, cx, cy, cz); o += TRI_BYTES; continue; }
    }
    sink.add(ax, ay, az, bx, by, bz, cx, cy, cz);
    o += TRI_BYTES;
  }
  info.flippedNormals = flipped;
  if (flipped && !repair) {
    info.warnings.push(`${flipped} of ${n} triangles have a stored normal that opposes their winding (pass {repairWinding:true} to trust the normals)`);
  }
  return sink;
}

function importASCII(u8, opts, info) {
  // A BOM is blanked to spaces rather than sliced off, so every character index
  // in `text` stays equal to its byte offset in the file and the error messages
  // below keep telling the truth.
  const text = decodeLatin1(u8).replace(/^\u00ef\u00bb\u00bf/, '   ');
  const sink = makeSink(opts.weld !== false, opts.eps ?? 1e-6);
  const repair = opts.repairWinding === true;

  let pos = 0, lineNo = 0, solids = 0, tris = 0, flipped = 0, fanned = 0;
  let loop = [], inLoop = false, fileN = null;

  const emit = (where) => {
    if (loop.length === 0) return;
    if (loop.length < 3) {
      throw new Error(`importSTL: facet loop has only ${loop.length} vertices ${where} — an STL facet needs 3`);
    }
    if (loop.length > 3) fanned++;
    // A >3-vertex loop violates the spec but appears in the wild; fanning it is
    // correct for the convex, planar polygons that actually occur.
    for (let k = 1; k + 1 < loop.length; k++) {
      const a = loop[0], b = loop[k], c = loop[k + 1];
      tris++;
      if (fileN &&
          normalContradictsWinding(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], fileN[0], fileN[1], fileN[2])) {
        flipped++;
        if (repair) { sink.addFlipped(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); continue; }
      }
      sink.add(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
    loop = [];
  };

  /** Walk the STL keywords in one line's tokens, starting at `from`. */
  const walk = (toks, from, where) => {
    let i = from;
    while (i < toks.length) {
      const w = toks[i].toLowerCase();
      if (w === 'facet') {
        i++;
        if (i < toks.length && toks[i].toLowerCase() === 'normal') {
          if (i + 3 >= toks.length) throw new Error(`importSTL: "facet normal" needs 3 numbers ${where}`);
          fileN = [parseNum(toks[i + 1], where), parseNum(toks[i + 2], where), parseNum(toks[i + 3], where)];
          i += 4;
        } else {
          fileN = null;   // "facet" with no normal is legal; we derive it from winding
        }
      } else if (w === 'outer') {
        i++;
        if (i < toks.length && toks[i].toLowerCase() === 'loop') i++;
        loop = []; inLoop = true;
      } else if (w === 'vertex') {
        if (i + 3 >= toks.length) throw new Error(`importSTL: "vertex" needs 3 numbers ${where}`);
        loop.push([parseNum(toks[i + 1], where), parseNum(toks[i + 2], where), parseNum(toks[i + 3], where)]);
        i += 4;
      } else if (w === 'endloop') {
        if (!inLoop) throw new Error(`importSTL: "endloop" without a matching "outer loop" ${where}`);
        emit(where); inLoop = false; i++;
      } else if (w === 'endfacet') {
        emit(where); inLoop = false; fileN = null; i++;
      } else {
        i++;   // colour extensions and other vendor noise
      }
    }
  };

  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    const lineStart = pos;
    const line = text.slice(pos, end);
    lineNo++;
    pos = end + 1;

    const trimmed = line.trim();
    if (trimmed) {
      const where = `at byte offset ${lineStart} (line ${lineNo})`;
      const toks = trimmed.split(/\s+/);
      const head = toks[0].toLowerCase();

      if (head === 'solid' && !(toks.some(isFacet) && toks.some(isVertex))) {
        // The name is the rest of the line, spaces and all, so it cannot be
        // tokenised — which is exactly why this parser is line-oriented.
        solids++;
        if (info.name === null) info.name = trimmed.slice(5).trim();
      } else if (head === 'solid') {
        // A "solid" line that also carries facets means the file has no usable
        // line structure — either everything is on one line, or the line endings
        // are bare CR (classic Mac) and indexOf('\n') found nothing. Take the
        // name up to the first "facet" and let the token walk have the rest,
        // rather than silently returning an empty mesh. A solid genuinely named
        // "... facet ... vertex ..." would lose part of its name; that trade is
        // worth making against a silent empty import.
        solids++;
        const cut = toks.findIndex(isFacet);
        if (info.name === null) info.name = toks.slice(1, cut).join(' ');
        walk(toks, cut, where);
      } else if (head === 'endsolid') {
        // nothing to close: emit() already ran at endloop/endfacet
      } else {
        walk(toks, 0, where);
      }
    }
    if (nl < 0) break;
  }

  if (!solids && !tris) {
    throw new Error(`importSTL: no "solid" keyword and no facets in ${u8.length} bytes — this is not an ASCII STL`);
  }
  if (inLoop) info.warnings.push(`file ends inside a facet loop at line ${lineNo} — the last facet was dropped`);
  if (fanned) info.warnings.push(`${fanned} facet loops had more than 3 vertices and were fan-triangulated`);
  if (flipped && !repair) {
    info.warnings.push(`${flipped} of ${tris} triangles have a stored normal that opposes their winding (pass {repairWinding:true} to trust the normals)`);
  }
  info.triangles = tris;
  info.solids = solids;
  info.flippedNormals = flipped;
  if (info.name === null) info.name = '';
  return sink;
}

/**
 * Parse a binary or ASCII STL into a Mesh.
 *
 * Vertices are welded by default, because an STL has no shared vertices at all
 * and an unwelded mesh fails every manifold check in validate.js for reasons
 * that have nothing to do with the model. The returned Mesh carries an
 * `importInfo` property saying what was done:
 *
 *   { format, name, bytes, triangles, solids, vertices, rawVerts, welded,
 *     degenerate, flippedNormals, warnings: [string] }
 *
 * Options: { weld = true, eps = 1e-6, maxTriangles = 20e6, repairWinding = false }.
 * `repairWinding` rewinds triangles whose stored normal opposes their vertex
 * order — off by default because the winding is the more trustworthy of the two,
 * but invaluable for files from exporters that got it backwards.
 */
export function importSTL(input, opts = {}) {
  const u8 = toU8(input, 'importSTL');
  const format = detectFormat(u8);
  const info = {
    format, name: null, bytes: u8.length, triangles: 0, solids: 0,
    vertices: 0, rawVerts: 0, welded: 0, degenerate: 0, flippedNormals: 0,
    warnings: [],
  };

  let sink;
  if (format === 'binary') {
    info.solids = 1;
    sink = importBinary(u8, opts, info);
  } else if (format === 'ascii') {
    sink = importASCII(u8, opts, info);
  } else if (format === 'empty') {
    throw new Error('importSTL: the file is empty (0 bytes)');
  } else if (format === '3mf') {
    throw new Error('importSTL: this is a zip archive (probably a 3MF or an OrcaSlicer project), not an STL');
  } else {
    const known = identifyMagic(u8);
    if (known) throw new Error(`importSTL: this file is ${known}, not an STL`);
    // Not text, so the remaining story is a binary STL whose length check
    // failed — truncated, or with a corrupt count. importBinary diagnoses that
    // precisely (naming the byte offset where the file ran out), which beats a
    // blanket "unrecognised format" by a mile. It succeeds only in the one
    // recoverable case detectFormat deliberately declines to claim: enough bytes
    // for every triangle, plus trailing junk, but an implausible first normal.
    if (!isTextPrefix(u8, 512)) {
      info.solids = 1;
      sink = importBinary(u8, opts, info);
    } else {
      const head = decodeLatin1(u8.subarray(0, 48)).replace(/[^\x20-\x7e]/g, '.');
      throw new Error(`importSTL: unrecognised format in ${u8.length} bytes — the text contains no "solid" or "facet normal", and ${HEADER_BYTES} + 50n never equals ${u8.length}. Starts: "${head}"`);
    }
  }

  const s = sink.stats;
  info.rawVerts = s.rawVerts;
  info.welded = s.welded;
  info.degenerate = s.degenerate;

  let mesh = new Mesh(sink.positions, sink.tris);
  if (s.degenerate) {
    // Dropping a degenerate triangle can orphan the vertices that only it used,
    // and an orphaned vertex makes every downstream vertex count and bbox lie.
    // Only pay for the extra pass when there was actually something to drop.
    info.warnings.push(`${s.degenerate} degenerate triangles (two or more coincident corners) were dropped`);
    mesh = mesh.compact();
  }
  info.vertices = mesh.vertCount;
  mesh.importInfo = info;
  return mesh;
}

export default { exportBinarySTL, exportASCIISTL, exportOBJ, export3MF, importSTL, detectFormat };
