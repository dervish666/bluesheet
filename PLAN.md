# Bluesheet — parametric printable-object foundry

**Port 8132 · started 2026-08-21 21:50 BST**

## What it is

A browser workshop for objects that are tedious to model by hand but trivial to
describe with numbers: gridfinity bins, lithophanes, threaded jars, terrain
tiles, nameplates, drawer dividers, data sculptures. You pick a generator, move
some numbers, watch the solid rebuild live in 3D, then slice it on this laptop
and send it to [[projects/Gladys]] — the A1 mini two metres away — without a
desktop CAD package or a Mac in the loop.

It is deliberately **not** a general CAD tool. There is no sketch plane and no
constraint solver. Every object is a function from parameters to a watertight
mesh, and the value is in the catalogue of those functions.

## Hard constraints (non-negotiable, all leaves)

1. **No build step, no npm dependencies, no frameworks.** Vanilla ES modules
   loaded by the browser directly and importable by Node 22 for tests. Anything
   in `js/kernel/`, `js/gen/` must import cleanly in Node with **no DOM access
   at module scope** — tests run headless.
2. **Millimetres. Z up.** Every generator returns a mesh already resting on the
   build plate: `bbox().min[2] === 0` (within 1e-6) and centred in X/Y about the
   origin unless the generator's own docs say otherwise.
3. **Winding is counter-clockwise seen from outside** (right-hand rule, normals
   point out). `mesh.volume()` of any correct solid is **positive**.
4. **Watertight or it is a bug.** Every generator's output must pass
   `analyze(mesh).manifold === true && .boundaryEdges === 0` at every corner of
   its parameter space that the generator declares legal.
5. **Deterministic.** `build(p)` twice with the same params gives byte-identical
   STL. Randomness only via an explicit `seed` param.
6. **Touch-first UI.** It is driven from an iPad. Every control must work with a finger:
   number fields with steppers, not bare drag-sliders; nothing that needs hover.
7. **`ThreadingHTTPServer`**, JSON files for state, no database.
8. Bed is the **A1 mini: 180 × 180 × 180 mm**. Refuse-with-a-warning, never
   silently scale.

## Kernel contract

### `js/kernel/mesh.js` — owned by the driver, written first
```js
class Mesh {
  constructor(positions = [], tris = [])   // flat arrays: [x,y,z,...] and [i,i,i,...]
  static fromArrays(positions, tris)
  static merge(meshes)                     // -> Mesh (index-offset concat)
  static polygon(points)                   // convex fan from [[x,y,z],...] -> Mesh
  get vertCount() / get triCount()
  addVertex(x, y, z) -> index
  addTri(i0, i1, i2)                       // indices
  addFace(indices)                         // fan-triangulates a convex ring of indices
  addQuad(a, b, c, d)
  clone()
  transform(m4)        -> Mesh   // new mesh; flips winding if det < 0
  translate(x, y, z)   -> Mesh
  scale(sx, sy, sz)    -> Mesh
  rotateX/Y/Z(radians) -> Mesh
  centerXY()           -> Mesh   // centres bbox on x=0,y=0
  dropToPlate()        -> Mesh   // translates so bbox.min[2] === 0
  flipped()            -> Mesh
  weld(eps = 1e-6)     -> Mesh
  bbox()               -> {min:[3], max:[3], size:[3], center:[3]}
  volume()             -> mm³ (signed, positive for correct solids)
  surfaceArea()        -> mm²
  vertexNormals()      -> Float32Array (angle-weighted smooth normals)
  faceNormal(i)        -> [x,y,z]
  toSTL(name)          -> Uint8Array  (binary STL)
}
```
Positions are `number[]` (grown by push) until `freeze()`; treat as read-mostly.
`Mesh` never mutates in place except through `addVertex`/`addTri`/`addFace`.

### `js/kernel/poly2d.js` — 2D rings
A **ring** is `[[x,y], ...]`, implicitly closed, no repeated last point.
A **shape** is `[ring, ...]`: index 0 outer (CCW), the rest holes (CW).
```js
area(ring) signedArea(ring) isCCW(ring) ensureCCW(ring) ensureCW(ring)
bounds(shape) -> {min:[x,y], max:[x,y], size:[w,h], center:[x,y]}
centroid(ring) perimeter(ring) pointInRing(pt, ring) pointInShape(pt, shape)
triangulate(shape) -> {points:[[x,y],...], tris:[i,i,i,...]}   // earcut, holes supported
offset(shape, delta, {join='round', arcTolerance=0.05, miterLimit=2}) -> shape[]
boolean(a /*shape[]*/, b /*shape[]*/, op) -> shape[]   // 'union'|'difference'|'intersection'|'xor'
resample(ring, maxSegLen) simplify(ring, eps) reverse(ring)
transformRing(ring, {tx,ty,rot,sx,sy})
// ring constructors
rect(w,h,{cx=0,cy=0}) roundRect(w,h,r,{segs}) circle(r,{segs,cx,cy})
ellipse(rx,ry,{segs}) regularPolygon(n,r,{rot}) star(n,rOuter,rInner)
slot(len,r,{segs}) roundedPath(points, r, {segs}) superformula(opts)
chamferRect(w,h,c) dogboneRect(w,h,r,toolR)
```
`offset` and `boolean` return an **array of shapes** (a boolean can split a
solid into several islands, each with its own holes).

### `js/kernel/builders.js` — 2D → 3D
```js
extrude(shape, height, {z0=0, twist=0, twistSteps, scaleTop=1, scaleTopY,
        capBottom=true, capTop=true, steps=1, easing}) -> Mesh
revolve(profile /*ring in [r, z]*/, {segments=96, from=0, to=TAU, capEnds=true,
        closed}) -> Mesh
loft(sections /*[{shape, z, rot, scale}]*/, {capBottom=true, capTop=true,
        closed=false}) -> Mesh
sweep(shape, path /*[[x,y,z],...]*/, {twist=0, capEnds=true, upHint, closed}) -> Mesh
heightfield(field /*{w,h,data:Float32Array|number[]}*/, {sx, sy, baseZ=0,
        skirt=true, solid=true, zScale=1}) -> Mesh
helixPath({r, pitch, turns, segments, r2, z0}) -> [[x,y,z],...]
// primitives (all return solids resting where documented)
box(w,d,h,{center=true, z0=0}) roundedBox(w,d,h,r,{segs})
cylinder(r,h,{segments=64, r2, z0=0, capped=true}) cone(r,h,{segments})
sphere(r,{segments=48, rings=24}) capsule(r,h,{segments})
torus(R, r, {major=64, minor=24}) tube(rOuter, rInner, h, {segments})
prism(n, r, h, {rot}) wedge(w,d,h) pyramid(w,d,h)
chamferCylinder(r, h, c, {segments}) filletCylinder(r,h,f,{segments})
```

### `js/kernel/csg.js` — mesh booleans (BSP)
```js
union(a, b) subtract(a, b) intersect(a, b)
unionAll(meshes) subtractAll(base, meshes)
```
Prefer direct construction; CSG is the escape hatch. Every generator that uses
CSG must still pass the manifold gate.

### `js/kernel/validate.js`
```js
analyze(mesh, {selfIntersect=false}) -> {
  vertCount, triCount, manifold, watertight, boundaryEdges, nonManifoldEdges,
  degenerateTris, flippedTris, shells, eulerChar, volume, area, bbox,
  selfIntersections, warnings: [{code, message, severity}]
}
printability(mesh, {bed={x:180,y:180,z:180}, nozzle=0.4, layerH=0.2,
  minFeature=0.8, maxOverhang=50}) -> {
  fitsBed, footprint, height, overhangArea, overhangPct, worstOverhangDeg,
  thinWallArea, unsupportedIslands, estVolumeCm3, estGrams, warnings:[...]
}
```

### `js/kernel/stl.js`
```js
exportBinarySTL(mesh, name) -> Uint8Array
exportASCIISTL(mesh, name) -> string
importSTL(arrayBuffer) -> Mesh
```

### `js/kernel/text.js` — TTF outlines (own leaf)
```js
loadFont(arrayBuffer) -> Font
Font.glyphShapes(char) -> {shapes: shape[][], advance, unitsPerEm}
layoutText(font, text, {size, letterSpacing, lineHeight, align, maxWidth})
  -> {shapes: shape[], width, height, lines}
```

## Generator module contract — `js/gen/<id>.js`

```js
export default {
  id: 'gridfinity',              // === filename, [a-z0-9-]
  name: 'Gridfinity Bin',
  category: 'Storage',           // Storage | Decor | Utility | Data | Toys | Kitchen
  blurb: 'one sentence, shown on the card',
  description: 'a paragraph, shown in the panel',
  icon: '<svg …>' | null,
  version: 1,
  params: [ /* see below */ ],
  presets: [ { name, values: { … } } ],
  build(p, ctx) -> Mesh,         // or { mesh, parts: [{name, mesh}], meta }
  validate?(p) -> [{ param, message, severity }],
  hints?(p) -> { profile, notes: [string], filament, supports: bool }
}
```
Param entry:
```js
{ key, label, type, def, group?, help?, unit?, showIf?(p),
  // number: min, max, step, precision, soft (allow beyond min/max with warning)
  // enum:   options: [{ v, label, help? }]
  // bool, text (maxLength), image (-> {w,h,gray:Float32Array}), series (-> number[]),
  // vec2:   min/max/step apply per component
}
```
`ctx = { quality: 'draft'|'normal'|'fine', segFactor, bed, nozzle, layerH,
         log(msg), progress(0..1), signal }`.
`ctx.segFactor` is 0.5 / 1 / 2 — multiply your segment counts by it.

`build` **must** be pure, deterministic, DOM-free, and finish under ~2 s at
`normal` for default params on an i7-1165G7.

## Server contract — `server/` (Python, ThreadingHTTPServer, port 8132)

```
GET  /                      static
GET  /api/health            {ok, version, slicer, printer}
POST /api/slice             {stl: base64, settings:{profile, layerH, infill,
                              supports, spiral, filament, plate}} ->
                            {id, timeText, timeSec, grams, layers, bbox, log}
GET  /api/slice/<id>/gcode  parsed toolpaths {layers:[{z, paths:[{type, pts}]}]}
GET  /api/slice/<id>/3mf    the sliced file
POST /api/print             {id, start:false} -> uploads to SD via gladys/sdcard.py
GET  /api/library           saved designs
POST /api/library           {gen, name, params, thumbnail}
DELETE /api/library/<id>
GET  /api/elevation?...     terrain proxy (cached to assets/elev/)
GET  /api/fonts             bundled font list
```
Never trust the slicer exit code — re-read the 3mf and assert settings landed
(see `[[topics/Headless slicing for Bambu printers]]`, `inspect3mf.py`).

## File ownership (disjoint — a leaf touches only its own files)

| Leaf | Owns |
|---|---|
| driver | `js/kernel/mesh.js`, `tests/lib/*`, `tests/run.mjs`, `js/gen/index.js`, `index.html`, `PLAN.md`, `GATES.md` |
| K1 poly2d | `js/kernel/poly2d.js`, `tests/poly2d.test.mjs` |
| K2 builders | `js/kernel/builders.js`, `tests/builders.test.mjs` |
| K3 csg | `js/kernel/csg.js`, `tests/csg.test.mjs` |
| K4 validate | `js/kernel/validate.js`, `tests/validate.test.mjs` |
| K5 stl | `js/kernel/stl.js`, `tests/stl.test.mjs` |
| K6 text | `js/kernel/text.js`, `tests/text.test.mjs`, `assets/fonts/*` |
| G* | `js/gen/<id>.js`, `tests/gen-<id>.test.mjs` |
| R1 viewer | `js/render/*.js` |
| U1 ui | `js/ui/*.js`, `css/bluesheet.css` |
| S1 server | `server/*.py`, `server.py` |

## Status log
- [21:52] Plan + contract written. Kernel `mesh.js` and the test harness next.

## Decisions taken while the kernel was building

**Provenance in the STL header.** A binary STL's 80-byte header is dead space in
every other tool. Bluesheet writes `Bluesheet <gen> v<n> #<paramhash>` into it, and the
server can read it back, so any file — or any printed object you still have the
file for — can be traced to the generator and parameters that made it and
regenerated exactly. Costs nothing, changes no geometry, and needs no kernel
change: the app simply passes the provenance string as `mesh.toSTL(name)`.
The same string goes into the 3MF metadata and the library entry.

Rejected the physical version of this (engraving a mark into the object's base):
an engraved bottom face fights the first layer, and a raised one makes the part
rock. Not worth the risk on every object for a mark almost nobody would read.

**The plate.** Slicing one object at a time is a toy. Bluesheet keeps a *plate* — a
list of built objects with positions — and slices the whole plate at once, so
four gridfinity bins are one print rather than four. OrcaSlicer's `--arrange 1`
does the packing; the viewer draws the plate outline it has to fit inside. Added
as a wave-3 leaf rather than bolted onto the UI leaf, so the UI's own gates stay
about the interface.

## Status log
- [21:52] Plan + contract written.
- [22:05] mesh.js, test harness, fixtures, coverage checker, conformance harness,
  CDP driver written and verified. mesh 135/135, registry 31/31.
- [22:10] Wave 1 dispatched: 7 leaves (poly2d, csg, validate, stl, text, render,
  server) in parallel, then builders, then two independent verification agents.
- [22:19] Slicing toolchain re-verified end to end outside the build: a 20 mm
  cube from the Bluesheet kernel sliced to 100 layers / 28m11s / 20.00 mm in 0.5 s.
- [22:19] stl leaf landed: 156/156 including a hand-rolled 3MF writer.
- [22:25] Wave 3 scoped while wave 1 ran: the plate (P1), the Made log (M1 — every
  job remembered with its render beside a photograph of the real print from the
  workshop camera), and the inspector (A1 — drop any STL in and be told the truth
  about it). Gates written for all three.

## What gets printed

**A sampler plate**, not a single object: a small piece from several different
generators packed onto one 180 mm plate — a meshing gear pair, a BLUESHEET nameplate,
a cable clip, a 1x1 gridfinity bin. One print of about an hour, and a physical
contact sheet of the catalogue. It also exercises the plate feature end to end,
which a single object would not.

PLA from the AMS (white in slot 2, purple in slot 4) rather than PETG: PLA is the
forgiving one for an unattended print, and this laptop has a documented PETG
stringing baseline it does not need to fight at 2am.
- [22:35] Driver work while builders was blocked behind the server leaf:
  `js/kernel/pack.js` (MaxRects plate packing, 52 checks),
  `js/kernel/provenance.js` (the STL-header trace, 39 checks),
  `tools/bluesheet.mjs` (the whole catalogue on the command line), and
  `tests/lib/raster2d.mjs` + `tests/crosscheck.test.mjs` — a second, deliberately
  different implementation of the same questions.
- [22:42] **The cross-check earned itself immediately.** poly2d's booleans agree
  with pixel counting to 0.000% on nine shape pairs including holes, splits and
  identical inputs. And it caught a real disagreement: validate.js reports
  `manifold=false` for a cube with one reversed triangle while the independent
  edge walk called it closed. Both were right — `watertight` is edge closure,
  `manifold` also requires consistent orientation — and my first version of the
  check conflated them. It passed on eleven meshes and disagreed on exactly the
  one that mattered.
- [22:42] 1210 checks green across 9 suites. Only `browser.test.mjs` red, because
  there is no page yet.
- [22:48] Real elevation fetched for the terrain generator so it never depends on
  the network: three 80×80 SRTM 30 m grids — Avon Gorge (4 km, 0–141 m, and the
  gorge is plainly visible in an ASCII dump of it), Snowdon (8 km, 58–1052 m) and
  Cheddar Gorge (5 km, 3–276 m). `tools/fetch-terrain.mjs`, with the latitude
  correction applied so the grid is square on the ground rather than in degrees.
- [22:50] **Plate → slice proved end to end before the UI existed.** Five fixture
  solids packed, merged, converted to printer coordinates and sliced: 150 layers,
  1 h 20 m. Two facts came out of it that the vault did not have:
  `--arrange 1` re-arranges the plate and makes the preview a lie (a plate placed
  at Y 5–25 came out spread to Y 137), and the A1's purge extrudes along Y ≈ −2.5
  across X −13.5–113 **after** the first `;LAYER_CHANGE`, so a gcode bounding-box
  check has to filter `Y < 1` rather than just skip the start block.
- [22:52] The server's own slice API returns the same thing correctly: 1.1 s,
  bbox exactly where Bluesheet placed it, 150 layers, 9.38 g, and a `verified` array
  proving each requested setting actually landed in the 3mf. The gcode preview
  endpoint returns 150 typed layers in 827 kB from a 3 MB gcode.
- [22:53] Static surface probed: traversal, `%2e%2e`, `/server.py`, `/PLAN.md`,
  `/gates/*`, `/.gitignore`, `/server/util.py` all correctly 404. One real gap —
  `assets/terrain/*.json` also 404s, because the allowlist predates the terrain
  fields. Recorded in the integration checklist.
- [22:56] Interface leaf launched as its own workflow rather than waiting behind
  builders — it needs the registry and the viewer, neither of which is blocked.

## The interruption

- [23:05] **Usage limit.** Five agents were killed mid-flight: the server leaf, the
  CSG leaf, both verification agents, the interface leaf, and the builders leaf
  which had not started. Nothing was lost from disk — the killed agents had
  already written their files and, in most cases, their gate evidence; what they
  had not done was flip the checkboxes.
- [02:01] Resumed. Re-established state before restarting anything: 1,748 checks
  green across 11 suites, the server still live on 8132.
  Dispatched builders and the interface immediately, in parallel, since both are
  on the critical path.
- [02:07] Certified the seven wave-1 leaves myself by re-running every CHECK —
  the parent-verification layer doing its job rather than a shortcut round it.
  **48 gates met**: K1 poly2d 7/7, K2 pending, K3 csg 7/7, K4 validate 7/7,
  K5 stl 6/6, K6 text 7/7, R1 render 6/6, S1 server 8/8. One mechanical fix was
  needed: several agents had written their evidence on the line *after*
  `EVIDENCE:`, where the checker cannot see it, so a run that was genuinely
  finished reported as pending.
- [02:19] **builders.js landed** — 27 exports, the last kernel module. Verified
  independently before dispatching anything: nineteen builders and primitives all
  watertight, correctly wound and positive-volume, including extrude-with-a-hole
  at 180° twist, a revolve touching its axis, a loft from a 4-gon to a 64-gon, a
  helical sweep and a closed-path sweep. Volumes within 0.6% of analytic; pyramid,
  wedge and tapered extrude exact to the last digit.
- [02:20] Fired wave 2a (six core generators) and wave 2b (six more) as two
  concurrent workflows rather than one, then wave 5 (eight more) on top: twenty
  generator agents plus the interface, at 0.5 load. They are API-bound, not
  CPU-bound, and running one workflow at a time was leaving half the wall clock
  on the floor.
- [02:24] Built a BLUESHEET nameplate by hand from text.js → poly2d → mesh — the
  first time those three had been used together — and **it found a bug no test
  would have**: the validator called the letters "starting in mid-air" while they
  sat flush on their own plate. Fixed, with a second fix for the same class of
  error in the overhang census. `tests/islands.test.mjs`, 29 checks.
- [02:26] Nameplate sliced (9m 11s, 3.35 g, 18 layers, six settings verified
  inside the 3mf), uploaded to the SD card, byte-count verified, plate confirmed
  clear on camera.
- [02:27] **The harness declined the request that starts the printer.** Recorded
  as an ABANDON on R8 with the reasoning rather than routed around: the guard is
  a second, independent check on an irreversible physical action, and "the user
  said yes four hours ago" is exactly the argument that would make it useless.
  Flagged to the owner; the file is staged and needs one tap.
- [02:31] Closed the last integration gap found earlier: `assets/terrain/*.json`
  now serves, through a narrow exception for `assets/` rather than adding `.json`
  to the extension allowlist — configuration files are overwhelmingly `.json` and
  a blanket allow is how a service ends up serving its own settings. Security
  probe still 55/55, server suite 214/214.

## Morning

- [02:40] **Weekly limit.** Twenty-six agents killed at once, mid-write. Six
  generator files survived in various states; three of them had no default export
  because they were cut off part-way through writing.
- [07:01] Resumed. State first, again: kernel complete and green including
  `builders.test.mjs` at 800 checks — **2,577 checks across 13 suites** plus 305
  on the Python side. vase (7/7 presets solid) and drawer (8/8) complete;
  nameplate 4/7 with three broken presets, measured precisely so the repair brief
  could name them; boxlid, datasculpt and gear as partial files.
- [07:07] Relaunched with the survivors carved out — vase and drawer removed from
  the waves entirely so nothing clobbers working code, and the nameplate leaf
  rewritten as a repair job with the three failures quoted by number.
- [07:11] **The interface is real**, driven headlessly: an ogee vase at 47,304
  triangles with dimension callouts on the model, a live title block, the scale
  bar, and an analysis column whose prose is better than the brief asked for —
  it says which figures are sampled rather than exact.
- [07:13] Wave 3 dispatched with one change: no leaf may edit `js/app.js`. Three
  panels all wanting to add a mount call to the same file is a merge conflict
  waiting to happen, so each exports `mount(root, bluesheet)` and the driver wires
  them in. The conflict is removed rather than coordinated.
