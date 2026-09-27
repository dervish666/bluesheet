// A Bambu Studio project 3mf: the object, Sam's printer and filament profile,
// and the filament swap already set on the layer slider.
//
// Any generator whose build() returns `meta.colourChangeZ` (the height where the
// second colour starts: comic's plate top, qrplaque's base) gets one. The
// reference is a project Sam saved from Bambu Studio 02.05.00.66 with the swap
// set by hand (~/Downloads/comics.3mf, 2026-09-27). Its per-layer file reads
//
//   <layer top_z="2.2000000476837158" type="2" extruder="2" color="#161616"
//          extra="" gcode="tool_change"/>  <mode value="MultiAsSingle"/>
//
// for a 2.0 mm plate at 0.2 mm layers. top_z is the print_z of the FIRST layer
// in the new colour, i.e. the plate top plus one layer, not the plate top.
// Writing 2.0 there changes filament one layer early and the plate's top skin
// comes out in the line colour. colourChangeTopZ() derives it from the layer
// heights in the profile this file ships, so a 0.12 mm profile moves it too.
//
// The file set is the smallest one that Bambu Studio's own importer
// (src/libslic3r/Format/bbs_3mf.cpp, _load_model_from_file) needs to load the
// swap, read from its source rather than guessed:
//
//   [Content_Types].xml, _rels/.rels     OPC plumbing, or nothing opens at all
//   3D/3dmodel.model                     must carry <metadata name="Application">
//                                        BambuStudio-x.y.z.w</metadata>. Without it
//                                        the importer sets dont_load_config and
//                                        skips project_settings.config AND the
//                                        per-layer file: geometry only, no swap.
//                                        The version is Sam's own; a newer one
//                                        raises the "newer 3mf" dialog.
//   3D/_rels/3dmodel.model.rels,         the object as a production-extension
//   3D/Objects/object_1.model            sub-model, the layout Bambu writes
//   Metadata/project_settings.config     printer, process, both filaments
//   Metadata/model_settings.config       the object's filament and plate 1, which
//                                        the per-layer file's plate_info id="1" names
//   Metadata/custom_gcode_per_layer.xml  the swap itself
//
// Left out of Sam's file: the five thumbnail PNGs (and the model_settings keys
// and .rels entries that point at them), plate_1.json (a sliced plate's bbox
// for the thumbnail), slice_info.config (the header of a sliced result),
// filament_sequence.json (empty) and cut_information.xml (cut-tool bookkeeping).
// None of them gates the config or the per-layer load in the importer.
//
// Deterministic, like every writer in stl.js: no clock, fixed UUIDs, STORED zip.
// No DOM, so it runs in the build worker, the static site and Node.

import { writeZipStored, meshXml, xmlEscape, sanitizeName, fmtNum } from './stl.js';
import { PROJECT_SETTINGS } from './bambu-profile.js';

/** The Bambu Studio that saved the profile. The importer only loads a project's
 *  config when Application starts "BambuStudio-"; a newer version than the
 *  running app gets a dialog, so this is Sam's installed version, not a guess. */
export const BAMBU_APPLICATION = 'BambuStudio-02.05.00.66';

const OBJECT_ID = 2;     // the build object (holds a component); Bambu numbers it after the mesh
const MESH_ID = 1;       // the mesh object inside 3D/Objects/object_1.model
const OBJECT_PATH = '3D/Objects/object_1.model';
const TOOL_CHANGE = 2;   // CustomGCode::Type::ToolChange in Bambu's enum: ColorChange, PausePrint, ToolChange
const SECOND_FILAMENT = 2;

function num(v, what) {
  const x = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(x) || x <= 0) throw new Error(`exportBambuProject: the profile's ${what} is ${JSON.stringify(v)}, not a positive number`);
  return x;
}

/**
 * The print_z Bambu wants in `top_z` for a colour that starts at `changeZ`:
 * the top of the first layer that lies wholly above it. Layers top out at
 * first, first + h, first + 2h, ...; the answer is the first of those that is at
 * least one layer above changeZ. For a change on a layer boundary that is
 * exactly changeZ + h (2.0 -> 2.2 at 0.2 mm). A change part-way through a layer
 * rounds up, so the whole mixed layer stays colour 1 rather than half the
 * plate's top skin printing in colour 2.
 */
export function colourChangeTopZ(changeZ, settings = PROJECT_SETTINGS) {
  const h = num(settings.layer_height, 'layer_height');
  const first = num(settings.initial_layer_print_height, 'initial_layer_print_height');
  if (!Number.isFinite(changeZ) || changeZ <= 0) throw new RangeError(`colourChangeTopZ: colour change at ${changeZ} mm is not above the bed`);
  const eps = 1e-6;
  // Smallest n >= 0 with first + n*h >= changeZ + h.
  const n = Math.max(0, Math.ceil((changeZ + h - first) / h - eps));
  return Math.round((first + n * h) * 1e6) / 1e6;
}

function bedCentre(settings) {
  const pts = (settings.printable_area || []).map(s => String(s).split('x').map(Number));
  if (!pts.length || pts.some(p => p.length !== 2 || !p.every(Number.isFinite))) return [90, 90];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function bbox(mesh) {
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < lo[k]) lo[k] = p[i + k];
      if (p[i + k] > hi[k]) hi[k] = p[i + k];
    }
  }
  return { lo, hi };
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  ` <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  ` <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
  `</Types>\n`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  ` <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>\n`;

const MODEL_RELS =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  ` <Relationship Target="/${OBJECT_PATH}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>\n`;

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
  'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
  'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

/**
 * The project 3mf as bytes.
 *
 *   mesh           a kernel Mesh in generator coordinates (centred, base on z=0)
 *   name           the object's name in Bambu's object list
 *   colourChangeZ  where the second filament starts, mm; omit for no swap
 *   settings       project_settings.config as an object (default: Sam's)
 *
 * Throws on a swap at or above the top of the object: it would never fire, and
 * a project that silently prints in one colour is the failure being avoided.
 */
export function exportBambuProject(mesh, { name = 'bluesheet', colourChangeZ = null, settings = PROJECT_SETTINGS } = {}) {
  const who = 'exportBambuProject';
  if (!mesh || !mesh.positions || !mesh.tris || !mesh.tris.length) throw new TypeError(`${who}: expected a non-empty Mesh`);
  const title = sanitizeName(name);
  const { lo, hi } = bbox(mesh);
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const [bx, by] = bedCentre(settings);
  // The object is stored centred on its own box and placed by the build item,
  // which is how Bambu writes its own. Its base stays at the mesh's own lowest
  // Z, so a generator's z=0 plate is Bambu's bed.
  const place = `1 0 0 0 1 0 0 0 1 ${fmtNum(bx + c[0])} ${fmtNum(by + c[1])} ${fmtNum(c[2])}`;
  const faces = mesh.tris.length / 3;

  let swap = null;
  if (colourChangeZ !== null && colourChangeZ !== undefined) {
    const z = Number(colourChangeZ);
    if (!Number.isFinite(z) || z <= lo[2]) throw new RangeError(`${who}: colour change at ${colourChangeZ} mm is not above the bed`);
    const topZ = colourChangeTopZ(z, settings);
    if (topZ > hi[2] + 1e-6) throw new RangeError(`${who}: colour change at ${z} mm starts at layer ${topZ} mm, above the object's ${fmtNum(hi[2])} mm top, so it would never happen`);
    const colours = settings.filament_colour || [];
    if (colours.length < SECOND_FILAMENT) throw new Error(`${who}: the profile has ${colours.length} filament(s); a swap needs ${SECOND_FILAMENT}`);
    swap = { topZ, colour: String(colours[SECOND_FILAMENT - 1]) };
  }

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ${NS}>\n` +
    ` <metadata name="Application">${BAMBU_APPLICATION}</metadata>\n` +
    ` <metadata name="BambuStudio:3mfVersion">1</metadata>\n` +
    ` <metadata name="Title">${xmlEscape(title)}</metadata>\n` +
    ` <resources>\n` +
    `  <object id="${OBJECT_ID}" p:UUID="00000002-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n` +
    `   <components>\n` +
    `    <component p:path="/${OBJECT_PATH}" objectid="${MESH_ID}" p:UUID="00020000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n` +
    `   </components>\n` +
    `  </object>\n` +
    ` </resources>\n` +
    ` <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n` +
    `  <item objectid="${OBJECT_ID}" p:UUID="00000002-b1ec-4553-aec9-835e5b724bb4" transform="${place}" printable="1"/>\n` +
    ` </build>\n` +
    `</model>\n`;

  const object =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ${NS}>\n` +
    ` <metadata name="BambuStudio:3mfVersion">1</metadata>\n` +
    ` <resources>\n` +
    `  <object id="${MESH_ID}" p:UUID="00020000-81cb-4c03-9d28-80fed5dfa1dc" type="model">\n` +
    meshXml(mesh, who, c) +
    `  </object>\n` +
    ` </resources>\n` +
    ` <build/>\n` +
    `</model>\n`;

  const n = xmlEscape(title);
  const modelSettings =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    `  <object id="${OBJECT_ID}">\n` +
    `    <metadata key="name" value="${n}"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    `    <metadata face_count="${faces}"/>\n` +
    `    <part id="${MESH_ID}" subtype="normal_part">\n` +
    `      <metadata key="name" value="${n}"/>\n` +
    `      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
    `      <mesh_stat face_count="${faces}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n` +
    `    </part>\n` +
    `  </object>\n` +
    `  <plate>\n` +
    `    <metadata key="plater_id" value="1"/>\n` +
    `    <metadata key="plater_name" value=""/>\n` +
    `    <metadata key="locked" value="false"/>\n` +
    `    <metadata key="filament_map_mode" value="Auto For Flush"/>\n` +
    `    <metadata key="filament_maps" value="1 1"/>\n` +
    `    <model_instance>\n` +
    `      <metadata key="object_id" value="${OBJECT_ID}"/>\n` +
    `      <metadata key="instance_id" value="0"/>\n` +
    `      <metadata key="identify_id" value="100"/>\n` +
    `    </model_instance>\n` +
    `  </plate>\n` +
    `  <assemble>\n` +
    `   <assemble_item object_id="${OBJECT_ID}" instance_id="0" transform="${place}" offset="0 0 0" />\n` +
    `  </assemble>\n` +
    `</config>\n`;

  const files = [
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: '3D/3dmodel.model', text: model },
    { name: '3D/_rels/3dmodel.model.rels', text: MODEL_RELS },
    { name: OBJECT_PATH, text: object },
    { name: 'Metadata/project_settings.config', text: JSON.stringify(settings, null, 4) + '\n' },
    { name: 'Metadata/model_settings.config', text: modelSettings },
  ];
  if (swap) {
    files.push({
      name: 'Metadata/custom_gcode_per_layer.xml',
      text:
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n` +
        `<layer top_z="${fmtNum(swap.topZ)}" type="${TOOL_CHANGE}" extruder="${SECOND_FILAMENT}" ` +
        `color="${xmlEscape(swap.colour)}" extra="" gcode="tool_change"/>\n` +
        `<mode value="MultiAsSingle"/>\n</plate>\n</custom_gcodes_per_layer>\n`,
    });
  }
  const enc = new TextEncoder();
  return writeZipStored(files.map(f => ({ name: f.name, data: enc.encode(f.text) })));
}

export default { exportBambuProject, colourChangeTopZ, BAMBU_APPLICATION };
