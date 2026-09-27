// The Bambu Studio project writer (js/kernel/bambu.js).
//
// The archive is read back by Python's zipfile and ElementTree, not by anything
// in this repo: a reader that shares code with the writer would agree with it
// about every mistake they share. Python checks every CRC (testzip), and the
// per-layer file is parsed as XML rather than grepped.
//
// The anchor for the swap is Sam's own Bambu Studio save (~/Downloads/comics.3mf,
// 2026-09-27): a 2.0 mm plate at 0.2 mm layers came out as top_z 2.2, type 2,
// extruder 2, mode MultiAsSingle. Those numbers are pinned here as literals, and
// compared against the file itself when it is on this machine.

import { suite, check, near, throws, done } from './lib/assert.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exportBambuProject, colourChangeTopZ, BAMBU_APPLICATION } from '../js/kernel/bambu.js';
import { PROJECT_SETTINGS } from '../js/kernel/bambu-profile.js';
import { ctx, defaults } from './lib/genconform.mjs';
import comic from '../js/gen/comic.js';
import qrplaque from '../js/gen/qrplaque.js';
import vase from '../js/gen/vase.js';
import boxlid from '../js/gen/boxlid.js';
import { Mesh } from '../js/kernel/mesh.js';

suite('bambu project');

// Everything the tests need out of an archive, measured by Python.
const READER = String.raw`
import sys, json, zipfile, io, xml.etree.ElementTree as ET
data = sys.stdin.buffer.read()
z = zipfile.ZipFile(io.BytesIO(data))
out = {"names": z.namelist(), "bad": z.testzip()}
def xml(name):
    return ET.fromstring(z.read(name)) if name in out["names"] else None
C = "{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
P = "{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}"
m = xml("3D/3dmodel.model")
if m is not None:
    out["meta"] = {e.get("name"): e.text for e in m.findall(C + "metadata")}
    comp = m.find(".//" + C + "component")
    out["component"] = comp.get(P + "path") if comp is not None else None
    item = m.find(".//" + C + "item")
    out["item"] = [float(v) for v in item.get("transform").split()] if item is not None else None
for name in out["names"]:
    if name.startswith("3D/Objects/"):
        o = ET.fromstring(z.read(name))
        vs = o.findall(".//" + C + "vertex")
        out["vertices"] = len(vs)
        out["triangles"] = len(o.findall(".//" + C + "triangle"))
        xyz = [[float(v.get(k)) for k in "xyz"] for v in vs]
        out["lo"] = [min(p[i] for p in xyz) for i in range(3)]
        out["hi"] = [max(p[i] for p in xyz) for i in range(3)]
g = xml("Metadata/custom_gcode_per_layer.xml")
if g is not None:
    out["root"] = g.tag
    plate = g.find("plate")
    out["plate_id"] = plate.find("plate_info").get("id")
    out["layers"] = [dict(l.attrib) for l in plate.findall("layer")]
    out["mode"] = plate.find("mode").get("value")
if "Metadata/project_settings.config" in out["names"]:
    s = json.loads(z.read("Metadata/project_settings.config"))
    out["settings"] = {k: s.get(k) for k in ("layer_height", "initial_layer_print_height", "printer_settings_id", "filament_colour", "filament_settings_id")}
    out["settings_bytes"] = len(z.read("Metadata/project_settings.config"))
ms = xml("Metadata/model_settings.config")
if ms is not None:
    out["plater_id"] = ms.find("plate/metadata[@key='plater_id']").get("value")
    out["object_extruder"] = ms.find("object/metadata[@key='extruder']").get("value")
print(json.dumps(out))
`;

function inspect(bytes) {
  const out = execFileSync('python3', ['-c', READER], { input: Buffer.from(bytes), maxBuffer: 1 << 28 });
  const z = JSON.parse(out.toString('utf8'));
  // A missing part must read as a FAIL line, not a TypeError that hides the rest.
  return { layers: [], meta: {}, settings: {}, ...z };
}

const C = ctx();
const MINIMAL = [
  '[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', '3D/_rels/3dmodel.model.rels',
  '3D/Objects/object_1.model', 'Metadata/project_settings.config', 'Metadata/model_settings.config',
  'Metadata/custom_gcode_per_layer.xml',
];

// ---------------------------------------------------------------------------
// The layer arithmetic, against Sam's save
// ---------------------------------------------------------------------------
{
  near('a 2.0 mm plate at 0.2 mm layers swaps at top_z 2.2 (Sam\'s Bambu save)', colourChangeTopZ(2.0), 2.2, 1e-9);
  near('a 1.6 mm plate swaps at 1.8', colourChangeTopZ(1.6), 1.8, 1e-9);
  near('a change part-way through a layer (2.1) waits for the next whole layer, 2.4', colourChangeTopZ(2.1), 2.4, 1e-9);
  near('the layer height comes from the profile: 0.12 mm layers put a 1.2 mm swap at 1.32',
    colourChangeTopZ(1.2, { layer_height: '0.12', initial_layer_print_height: '0.12' }), 1.32, 1e-9);
  near('...and a thicker first layer shifts the grid: 0.3 first, 0.2 after, 2.1 -> 2.3',
    colourChangeTopZ(2.1, { layer_height: '0.2', initial_layer_print_height: '0.3' }), 2.3, 1e-9);
  check('the shipped profile is Sam\'s 0.20 mm A1 mini one',
    PROJECT_SETTINGS.layer_height === '0.2' && PROJECT_SETTINGS.printer_settings_id === 'Bambu Lab A1 mini 0.4 nozzle',
    `${PROJECT_SETTINGS.layer_height} / ${PROJECT_SETTINGS.printer_settings_id}`);
  check('...with two filaments, the second #161616',
    PROJECT_SETTINGS.filament_colour.length === 2 && PROJECT_SETTINGS.filament_colour[1] === '#161616',
    JSON.stringify(PROJECT_SETTINGS.filament_colour));
  check('the profile serialises back to the 49837 bytes Bambu wrote',
    (JSON.stringify(PROJECT_SETTINGS, null, 4) + '\n').length === 49837);
}

// ---------------------------------------------------------------------------
// The comic plaque, end to end
// ---------------------------------------------------------------------------
{
  const P = defaults(comic);
  const r = comic.build(P, C);
  const mesh = r.mesh;
  const Z = r.meta.colourChangeZ;
  const bytes = exportBambuProject(mesh, { name: 'comic test', colourChangeZ: Z });
  const z = inspect(bytes);

  check('every CRC in the archive checks out (python zipfile.testzip)', z.bad === null, String(z.bad));
  check('the archive holds exactly the minimal file set', JSON.stringify(z.names) === JSON.stringify(MINIMAL), z.names.join(', '));
  check('3dmodel.model names Bambu Studio as the application (else Bambu loads geometry only)',
    z.meta.Application === BAMBU_APPLICATION && /^BambuStudio-\d/.test(z.meta.Application), z.meta.Application);
  check('...and carries BambuStudio:3mfVersion 1', z.meta['BambuStudio:3mfVersion'] === '1');
  check('the build object is a component pointing at the sub-model', z.component === '/3D/Objects/object_1.model', z.component);

  check('the per-layer file is a custom_gcodes_per_layer document for plate 1',
    z.root === 'custom_gcodes_per_layer' && z.plate_id === '1' && z.plater_id === '1', `${z.root} ${z.plate_id} ${z.plater_id}`);
  check('it holds one swap', z.layers.length === 1, JSON.stringify(z.layers));
  const L = z.layers[0] || {};
  near(`top_z is colourChangeZ ${Z} + one 0.2 mm layer`, parseFloat(L.top_z), Z + 0.2, 1e-9);
  near('...which for the default 2 mm plate is 2.2', parseFloat(L.top_z), 2.2, 1e-9);
  check('type 2 (tool change)', L.type === '2', L.type);
  check('extruder 2 (the second AMS filament)', L.extruder === '2', L.extruder);
  check('gcode "tool_change", colour of filament 2', L.gcode === 'tool_change' && L.color === '#161616', `${L.gcode} ${L.color}`);
  check('mode MultiAsSingle', z.mode === 'MultiAsSingle', z.mode);
  check('the object prints in filament 1 until the swap', z.object_extruder === '1', z.object_extruder);
  check('project settings travel with it', z.settings.printer_settings_id === 'Bambu Lab A1 mini 0.4 nozzle' &&
    z.settings_bytes === 49837, JSON.stringify(z.settings));

  check('vertex count round-trips', z.vertices === mesh.positions.length / 3, `${z.vertices} vs ${mesh.positions.length / 3}`);
  check('triangle count round-trips', z.triangles === mesh.tris.length / 3, `${z.triangles} vs ${mesh.tris.length / 3}`);
  // Stored centred, placed by the item: object + translation is the mesh again.
  const bb = mesh.bbox();
  const t = z.item.slice(9);
  near('placed X span: min', z.lo[0] + t[0] - 90, bb.min[0], 1e-4);
  near('placed Y span: max', z.hi[1] + t[1] - 90, bb.max[1], 1e-4);
  near('the base sits on the bed (placed min Z = 0)', z.lo[2] + t[2], 0, 1e-6);
  near('the top is the relief top', z.hi[2] + t[2], r.meta.reliefTopZ, 1e-4);
  check('the item transform does not scale', JSON.stringify(z.item.slice(0, 9)) === JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1]), z.item.join(' '));

  const again = exportBambuProject(mesh, { name: 'comic test', colourChangeZ: Z });
  check('deterministic: the same mesh gives the same bytes', again.length === bytes.length && again.every((b, i) => b === bytes[i]));

  const none = inspect(exportBambuProject(mesh, { name: 'plain' }));
  check('no colourChangeZ, no per-layer file (and nothing else missing)',
    none.bad === null && JSON.stringify(none.names) === JSON.stringify(MINIMAL.slice(0, -1)), none.names.join(', '));

  throws('a swap above the top of the object is refused, not silently dropped',
    () => exportBambuProject(mesh, { colourChangeZ: r.meta.reliefTopZ }), 'never happen');
  throws('a swap at the bed is refused', () => exportBambuProject(mesh, { colourChangeZ: 0 }), 'not above the bed');
  throws('a one-filament profile cannot carry a swap',
    () => exportBambuProject(mesh, { colourChangeZ: Z, settings: { ...PROJECT_SETTINGS, filament_colour: ['#FFFFFF'] } }), 'a swap needs 2');
}

// ---------------------------------------------------------------------------
// Generic: the other generator that declares a colour change
// ---------------------------------------------------------------------------
{
  const r = qrplaque.build(defaults(qrplaque), C);
  const Z = r.meta.colourChangeZ;
  check('qrplaque declares a colour change too', Number.isFinite(Z), String(Z));
  const z = inspect(exportBambuProject(r.mesh, { name: 'qr', colourChangeZ: Z }));
  near(`qrplaque's swap lands at the first whole layer above ${Z} mm`, parseFloat((z.layers[0] || {}).top_z), colourChangeTopZ(Z), 1e-9);
  check('...one layer up when its base is on the layer grid',
    Math.abs(Z / 0.2 - Math.round(Z / 0.2)) > 1e-6 || Math.abs(parseFloat((z.layers[0] || {}).top_z) - (Z + 0.2)) < 1e-9, JSON.stringify(z.layers));
}

// ---------------------------------------------------------------------------
// No colour change: every other generator in the catalogue (the buttons show
// for all of them since 2026-09-27). The project is the same file set minus the
// per-layer file, prints in filament 1, and the geometry round-trips. A
// multi-part build ships as the one merged mesh the STL export ships
// (build-core's asMesh), so a two-part boxlid is one object here too.
// ---------------------------------------------------------------------------
{
  const rv = vase.build(defaults(vase), C);
  check('vase declares no colour change', !(rv.meta && Number.isFinite(rv.meta.colourChangeZ)), JSON.stringify(rv.meta && rv.meta.colourChangeZ));
  const z = inspect(exportBambuProject(rv.mesh, { name: 'vase' }));
  check('vase: every CRC checks out', z.bad === null, String(z.bad));
  check('vase: the archive is the minimal set without custom_gcode_per_layer.xml',
    JSON.stringify(z.names) === JSON.stringify(MINIMAL.slice(0, -1)), z.names.join(', '));
  check('vase: nothing in it is named after a swap', z.root === undefined && z.layers.length === 0, JSON.stringify(z.layers));
  check('vase: still a Bambu Studio project (Application set, so the profile loads)',
    z.meta.Application === BAMBU_APPLICATION, z.meta.Application);
  check('vase: the profile and plate 1 travel with it', z.settings_bytes === 49837 && z.plater_id === '1', `${z.settings_bytes} / ${z.plater_id}`);
  check('vase: the object prints in filament 1', z.object_extruder === '1', z.object_extruder);
  check('vase: vertex count round-trips', z.vertices === rv.mesh.positions.length / 3, `${z.vertices} vs ${rv.mesh.positions.length / 3}`);
  check('vase: triangle count round-trips', z.triangles === rv.mesh.tris.length / 3, `${z.triangles} vs ${rv.mesh.tris.length / 3}`);
  const bb = rv.mesh.bbox(), t = z.item.slice(9);
  near('vase: placed X min is the mesh\'s', z.lo[0] + t[0] - 90, bb.min[0], 1e-4);
  near('vase: placed Z max is the mesh\'s', z.hi[2] + t[2], bb.max[2], 1e-4);
  near('vase: the base sits on the bed', z.lo[2] + t[2], 0, 1e-6);

  const rb = boxlid.build(defaults(boxlid), C);
  check('boxlid builds more than one part', Array.isArray(rb.parts) && rb.parts.length > 1, String(rb.parts && rb.parts.length));
  const merged = Mesh.merge(rb.parts.map(p => p.mesh));
  const zb = inspect(exportBambuProject(merged, { name: 'boxlid' }));
  check('boxlid: all parts land in the one object', zb.triangles === rb.parts.reduce((a, p) => a + p.mesh.triCount, 0) && zb.bad === null,
    `${zb.triangles} triangles`);
  check('boxlid: no per-layer file either', !zb.names.includes('Metadata/custom_gcode_per_layer.xml'), zb.names.join(', '));
  check('boxlid: the merged mesh is what the STL export ships (same triangle count as result.mesh)',
    merged.triCount === rb.mesh.triCount, `${merged.triCount} vs ${rb.mesh.triCount}`);
}

// ---------------------------------------------------------------------------
// Against the reference save, when it is on this machine
// ---------------------------------------------------------------------------
{
  const ref = join(homedir(), 'Downloads', 'comics.3mf');
  if (!existsSync(ref)) {
    console.log(`  (reference ${ref} not on this machine: the literal 2.2 / type 2 / extruder 2 checks above stand in for it)`);
  } else {
    const refZ = inspect(readFileSync(ref));
    const mine = inspect(exportBambuProject(comic.build(defaults(comic), C).mesh, { colourChangeZ: 2 }));
    const a = refZ.layers[0] || {}, b = mine.layers[0] || {};
    near('reference and ours agree on top_z (theirs is float32 2.2000000476837158)', parseFloat(b.top_z), parseFloat(a.top_z), 1e-6);
    check('...and on type, extruder, colour, gcode', ['type', 'extruder', 'color', 'gcode', 'extra'].every(k => a[k] === b[k]),
      JSON.stringify([a, b]));
    check('...and on the mode', refZ.mode === mine.mode, `${refZ.mode} / ${mine.mode}`);
    check('...and on the project settings, byte count and key values',
      refZ.settings_bytes === mine.settings_bytes && JSON.stringify(refZ.settings) === JSON.stringify(mine.settings));
    check('every file we write is one Bambu wrote too', mine.names.every(n => refZ.names.includes(n) || n === '3D/Objects/object_1.model'),
      mine.names.filter(n => !refZ.names.includes(n)).join(', '));
  }
}

done();
