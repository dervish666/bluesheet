# Gates: K5 — js/kernel/stl.js (binary + ASCII STL, import)

Scope: getting geometry out of the browser and back in, byte-exactly.

- [x] G1: suite passes
  CHECK: node tests/stl.test.mjs 2>&1 | tail -3
  EXPECT: RESULT: PASS
  EVIDENCE: `K5 stl: 172/172 passed` / `RESULT: PASS`

- [x] G2: every export exercised
  CHECK: node tests/coverage.mjs js/kernel/stl.js tests/stl.test.mjs 2>&1 | tail -2
  EXPECT: missing: none
  EVIDENCE: `COVERAGE: 6/6 exports covered` / `missing: none`
  (the six: exportBinarySTL, exportASCIISTL, exportOBJ, export3MF, importSTL, detectFormat)

- [x] G3: at least 25 checks
  CHECK: node tests/stl.test.mjs 2>&1 | grep -c '^  ok '
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9]+)$/
  EVIDENCE: `172`

- [x] G4: byte-level correctness, not just a round trip. A round trip cannot see
      a consistent sign error, so assert the actual bytes: header is 80 bytes and
      contains no clock or hostname, tri count at offset 80 little-endian, the
      first triangle's 12 floats read back at the exact expected offsets, total
      length is 84 + 50n.
  EVIDENCE: the expected bytes are computed from IEEE-754 by hand, not from my
  own writer (10.0 is 0x41200000, so LE `00 00 20 41`), and the test pins that
  anchor first. Deciding lines, for a triangle (0,0,0)/(10,0,0)/(0,20,0):
    `ok  triangle record at offset 84 matches the hand-computed bytes  —
        00000000 00000000 0000803f | 00000000 00000000 00000000 |
        00002041 00000000 00000000 | 00000000 0000a041 00000000 | 0000`
    `ok  length is 84 + 50n  — 134 bytes for 1 triangle`
    `ok  triangle count bytes at offset 80 are 01 00 00 00 (uint32 LE)  — 01000000`
    `ok  header contains no digits (so: no clock, no version stamp)  — Bluesheet tri`
    `ok  header contains no hostname  — hostname is "<host>"`
    `ok  uint16 attribute at offset 132 is 0`
    `ok  exportBinarySTL is byte-identical to the independently written Mesh#toSTL — 134 vs 134 bytes`
  Confirmed a third time out-of-band by Python's `struct`, which shares no code
  with this project:
    `header (repr): 'Bluesheet tri' + 71 spaces`
    `count @80: 1   84+50n == 134 == len: True`
    `normal: (0.0, 0.0, 1.0)   v0 v1 v2: (0,0,0) (10,0,0) (0,20,0)   attribute: 0`
  Cube (12 tris): `count 12 len 684 exact: True`, i.e. 84 + 50*12.

- [x] G5: import is verified against a fixture written by something other than
      exportBinarySTL — hand-assemble the byte buffer in the test, then import it
      and assert the mesh matches. Also: an ASCII STL parsed by importSTL, a file
      with a bogus triangle count rejected with a clear error, an empty mesh, and
      a >65535 triangle mesh.
  EVIDENCE: every import fixture is built by `handBinary()` in the test, a writer
  assembled from the format description with a raw DataView; its own output is
  first pinned against the IEEE-754 table. Deciding lines:
    `ok  the hand-assembled fixture has the ground-truth bytes for its first vertex — 000000000000000000000000`
    `ok  import: 2 triangles` / `ok import: welded to 4 vertices — 4`
    `ok  importInfo reports 6 raw vertices welded down to 4 — raw 6, welded 2, left 4`
    `ok  a binary file with a "solid" header imports as binary, not as broken ASCII — 1 tris, binary`
    `ok  ASCII: one triangle — 1` (plus 2.0E1/1.0e+001 exponents, CRLF, bare-CR,
        BOM, two solids, a 4-vertex loop fanned, a facet on one line)
    `ok  an empty binary STL (n=0, 84 bytes) imports as an empty mesh — 84 bytes`
    `ok  big mesh: 81920 triangles (past the uint16 ceiling) — 81920`
    `ok  big mesh: count is stored as uint32 (byte 82 is non-zero) — bytes 00400100`
    `ok  big mesh: re-imports with all 81920 triangles — 81920`
  Rejections, each naming a byte offset:
    `bogus count  → "truncated binary STL — the count at byte offset 80 claims 900
                     triangles (45084 bytes) but the file ends at byte offset 134,
                     holding only 1"`
    `absurd count → "triangle count 4294967295 read at byte offset 80 is
                     implausible (limit 20000000) — this is probably not a binary STL"`
    `truncated    → "...claims 2 triangles (184 bytes) but the file ends at byte
                     offset 120, holding only 0"`
    `NaN vertex   → "non-finite vertex coordinate in triangle 0 at byte offset 96"`
    also: empty file, a 3MF ("this is a zip archive"), a PNG (named as a PNG),
    non-STL text, ASCII "nan", a missing coordinate ("line 4"), a 2-vertex loop.

- [x] G6: exports are deterministic across two calls and across a process restart
  CHECK: node -e "import('./js/kernel/stl.js').then(async S=>{const {sphere}=await import('./js/kernel/builders.js').catch(()=>({}));const {Mesh}=await import('./js/kernel/mesh.js');const m=new Mesh();const v=[[0,0,0],[9,0,0],[0,7,0],[0,0,5]].map(p=>m.addVertex(...p));m.addTri(v[0],v[2],v[1]);m.addTri(v[0],v[1],v[3]);m.addTri(v[1],v[2],v[3]);m.addTri(v[0],v[3],v[2]);const a=S.exportBinarySTL(m,'x');const b=S.exportBinarySTL(m,'x');console.log('same:',Buffer.compare(Buffer.from(a),Buffer.from(b))===0, 'sha:', require('crypto').createHash('sha1').update(Buffer.from(a)).digest('hex').slice(0,12))})" 2>&1 | tail -1
  EXPECT: same: true
  EVIDENCE: `same: true sha: c815be747827`
  Across a process restart, a 1.2 s wall-clock gap, and a changed TZ + locale
  (TZ=Pacific/Auckland LC_ALL=de_DE.UTF-8), all four writers hash identically:
    run1: stl 57465e53cbaabe3a  3mf e82009110fe2b9b4  obj bc26b2fd7baa612f  ascii b5b1bb9f4f42349f
    run2: stl 57465e53cbaabe3a  3mf e82009110fe2b9b4  obj bc26b2fd7baa612f  ascii b5b1bb9f4f42349f
    run3: stl 57465e53cbaabe3a  3mf e82009110fe2b9b4  obj bc26b2fd7baa612f  ascii b5b1bb9f4f42349f
  The two places a clock normally leaks in are pinned: the STL header is
  `Bluesheet <name>` space-padded, and the zip DOS timestamp is the fixed 1980-01-01
  epoch (`date 0x21, time 0x0` on every entry).

## Beyond the gates

3MF was NOT abandoned. `export3MF` writes a real OPC package — a hand-built
STORED (uncompressed) zip holding `[Content_Types].xml`, `_rels/.rels` and
`3D/3dmodel.model`. Verified three ways: a zip reader written separately from the
writer inside the test (walks the EOCD and both directories, and reads each
payload through the *local* header so the two cannot disagree unnoticed); an
independent bit-at-a-time CRC-32 in the test, itself anchored to the published
check value 0xCBF43926 for "123456789"; and out-of-band by `unzip -t` and
Python's `zipfile`:
  `unzip -t cube.3mf  →  No errors detected in compressed data of cube.3mf.`
  `zipfile.testzip()  →  None`  (i.e. every CRC verifies)
  `entries: [('[Content_Types].xml','STORED',319,(1980,1,1,0,0,0)),
             ('_rels/.rels','STORED',260,...), ('3D/3dmodel.model','STORED',1221,...)]`
  `model: vertices: 8  triangles: 12  unit: millimeter`

`exportOBJ` is also real: `v`/`vn`/`f` with 1-based `v//vn` indices, unwelded so
hard edges survive the trip to Blender.

Nothing ABANDONed.
