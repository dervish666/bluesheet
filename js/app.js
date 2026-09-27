// Bluesheet — the application.
//
// This file is the wiring, and deliberately little else. Every part of the
// interface that has an opinion lives in js/ui/: the parameter panel, the ISO
// dimension overlay, the scale bar, the title block, the analysis column, the
// catalogue, the library, the slice path. What is left here is the loop that
// joins them:
//
//     a parameter moves -> the builder rebuilds (debounced, off-thread)
//         -> the viewer takes the new geometry
//         -> the title block ticks its revision
//         -> the dimensions redraw
//         -> the analysis column says what the kernel found
//
// and the handle at window.__bluesheet, which is how the browser test drives the
// application rather than clicking pixels — though the test clicks pixels too,
// because a handle that works while the buttons do not is exactly the failure
// this project is trying to avoid.

import { $, $$, el, clear, debounce, reducedMotion } from './ui/dom.js';
import { loadGenerators, defaultParams, validateParams, coerce } from './gen/index.js';
import { Builder } from './ui/build.js';
import { Viewer } from './render/viewer.js';
import { ParamPanel } from './ui/params.js';
import { DimensionLayer } from './ui/dims.js';
import { ScaleBar } from './ui/scalebar.js';
import { TitleBlock } from './ui/titleblock.js';
import { AnalysisColumn } from './ui/analysis.js';
import { Catalogue } from './ui/catalogue.js';
import { Library } from './ui/library.js';
import { SlicePath } from './ui/slice.js';
import { PlatePanel } from './ui/plate.js';
import { provenance } from './kernel/provenance.js';
import { materialFamily } from './ui/format.js';
import { Inspector } from './ui/inspect.js';
import { parseProvenance } from './kernel/provenance.js';
import { MadePanel } from './ui/made.js';
import { packParams } from './ui/library.js';

const BED = { x: 180, y: 180, z: 180 };
const LAST_GEN_KEY = 'bluesheet.gen';

const S = {
  generators: [], failures: [], gen: null, params: {}, quality: 'normal',
  result: null, health: null, mode: 'solid', gcode: null, focus: null,
  imported: null,   // an inspected STL standing in for the generator's object
};

// ---- the sheet -----------------------------------------------------------

const stage = $('[data-stage]');
const canvas = $('[data-canvas]');
const viewer = new Viewer(canvas, {
  bed: BED,
  theme: {
    // The viewport is the recessed part of the sheet, and the object is
    // unpigmented filament under cold workshop light. Both come from
    // docs/design.md rather than from the renderer's defaults.
    bgTop: '#132234', bgBottom: '#0A121B',
    object: '#C8D6E4', wire: '#7FA6C7', ghost: '#33475C',
    cut: '#FF6A1F', warn: '#F2C94C', over: '#FF6A1F',
    key: '#FFF4E8', fill: '#7FA6C7', rim: '#9DB4C9',
    sky: '#33475C', ground: '#14202E',
    shadow: '#05070A', shadowAlpha: 0.34,
  },
  // The renderer's plate defaults draw a red X axis and a green Y one. A drawing
  // has no colour-coded axes — it has centre lines in the same ink as
  // everything else — and docs/design.md has no green in it at all.
  plateTheme: {
    fill: '#0D1621', fillAlpha: 0.62,
    grid: '#33475C', gridAlpha: 0.45,
    major: '#33475C', majorAlpha: 0.95,
    outline: '#7FA6C7', outlineAlpha: 0.9,
    axisX: '#7FA6C7', axisY: '#33475C',
    origin: '#E9F2FA',
    edgeFade: 0.3,
  },
  // Toolpaths on the palette: the walls are the heat, everything structural is
  // ink, and supports are sulphur because they are the part you throw away.
  moveColors: {
    travel: '#33475C', outer: '#FF6A1F', inner: '#8A3A15', solid: '#9DB4C9',
    top: '#E9F2FA', bottom: '#7FA6C7', infill: '#33475C', support: '#F2C94C',
    bridge: '#7FA6C7', skirt: '#33475C', custom: '#9DB4C9', other: '#9DB4C9',
  },
});

const dims = new DimensionLayer($('[data-dims]'), viewer);
const scaleBar = new ScaleBar($('[data-scalebar]'), viewer, () => dims.pxPerMm());
const titleBlock = new TitleBlock($('[data-title-block]'));
const analysis = new AnalysisColumn($('[data-facts]'), $('[data-warnings]'), $('[data-analysis-strip]'));

const builder = new Builder({
  onMesh: (r) => onMesh(r),
  onAnalysis: (r) => onAnalysis(r),
  onBusy: (b) => { $('[data-busy]').hidden = !b; },
  onProgress: (t) => status('Building', `${Math.round(t * 100)}%`),
  onLog: (text) => status('Building', text),
  onError: (err) => onBuildError(err),
});

const panel = new ParamPanel($('[data-param-groups]'), {
  onChange: (key, value) => {
    S.params[key] = value;
    // An enum that carries sibling values (a board bringing its ports) applies
    // them here, on a change the user made — never on a preset or a reload,
    // which set the whole record at once.
    const q = S.gen.params.find(p => p.key === key);
    if (q && typeof q.carries === 'function') Object.assign(S.params, q.carries(value, S.params) || {});
    afterParamChange();
  },
  onFocus: (q) => setFocusParam(q),
  onCommit: () => rebuild(),
});

const catalogue = new Catalogue($('[data-catalogue]'), {
  onPick: (id) => setGen(id),
});

const library = new Library($('[data-library]'), {
  onLoad: (entry) => loadSaved(entry),
});

const inspect = new Inspector($('[data-inspect]'), {
  stage,
  openButton: $('[data-open-inspect]'),
  bed: BED,
  layerH: () => slicePath.layerH(),
  infill: () => slicePath.settings().infill / 100,
  onUse: (obj) => useImported(obj),
  onOpenGenerator: (id) => {
    if (S.generators.some(g => g.id === id)) return setGen(id);
    status('Unknown generator', `No generator "${id}" is installed here — the file was made by one this copy does not have.`, 'warn');
    return null;
  },
  findByProvenance: (p) => findByProvenance(p),
  onLoadSaved: (entry) => loadSaved(entry),
});

const made = new MadePanel($('[data-made]'), {
  // The same path a saved design takes: the generator and its exact parameters.
  onLoad: (job) => loadSaved(job),
});

const slicePath = new SlicePath(document, {
  stl: () => exportSTL(),
  objects: () => (plate.active ? plate.objects() : null),
  name: () => (plate.active ? plate.name() : objectName()),
  onSliced: (meta) => { analysis.set({ slice: meta }); if (!meta) setGcode(null); },
  madeRecord: () => madeRecord(),
  onRecorded: () => { if (made.isOpen) made.refresh(); },
  onGcode: (doc) => setGcode(doc),
  onStatus: (k, m, tone) => status(k, m, tone),
  onBusy: (b) => { $('[data-busy]').hidden = !b; },
});

const plate = new PlatePanel($('[data-plate]'), {
  bed: BED,
  generator: (id) => S.generators.find(g => g.id === id) || null,
  current: () => (S.gen && S.result && !S.imported ? {
    gen: S.gen.id, params: S.params, quality: S.quality, name: objectName(),
    version: S.gen.version ?? 1, bbox: boxOf(S.result), triCount: S.result.triCount,
  } : null),
  onShow: (view) => showPlate(view),
  onSlice: () => slicePath.run(),
  onStatus: (k, m, tone) => status(k, m, tone),
  onBusy: (b) => { $('[data-busy]').hidden = !b; },
  layerH: () => slicePath.layerH(),
  material: () => materialFamily(slicePath.material()),
  infill: () => slicePath.settings().infill / 100,
});

/** The viewer shows the packed plate instead of the object, and the sheet says
 *  so: title block, size, analysis and the slice all describe the plate until
 *  the next single build lands. */
function showPlate(view) {
  slicePath.invalidate(view ? 'The plate is what will be sliced now.' : 'Back to the single object.');
  if (!view) {
    if (S.result) onMesh(S.result);
    return;
  }
  viewer.setMesh(view.mesh);
  const box = view.bbox;
  dims.setBox(box);
  dims.setDims([]);
  titleBlock.tick();
  titleBlock.set({
    gen: 'Plate', variant: `${view.copies} object${view.copies === 1 ? '' : 's'}`,
    material: slicePath.material(), size: box.size, pxPerMm: dims.pxPerMm(),
    volume: view.analysis ? view.analysis.volume : null,
    mass: view.print ? view.print.estGrams : null,
  });
  analysis.set({ mesh: { bbox: box }, analysis: view.analysis, print: view.print, issues: [] });
  setSectionRange();
  viewer.fit();
}

// ---- status bar ----------------------------------------------------------

const statusBar = $('.statusbar');
const statusKey = $('[data-status-key]');
const statusMsg = $('[data-status-msg]');

function status(key, message = '', tone = null) {
  statusKey.textContent = key;
  statusMsg.textContent = message;
  if (tone) statusBar.dataset.tone = tone; else delete statusBar.dataset.tone;
}

// ---- the rebuild loop ----------------------------------------------------

function request() {
  return {
    genId: S.gen.id,
    params: S.params,
    quality: S.quality,
    bed: BED,
    layerH: slicePath.layerH(),
    material: materialFamily(slicePath.material()),
    infill: slicePath.settings().infill / 100,
  };
}

function rebuild({ force = false } = {}) {
  if (!S.gen) return Promise.resolve(null);
  // Any rebuild while an imported object is on screen means the generator's
  // object is wanted back — even one the builder has already finished, which it
  // would otherwise answer from cache without ever calling onMesh.
  if (S.imported) { leaveImported(); force = true; }
  const req = request();
  return (force ? builder.rebuild(req) : builder.build(req)).catch((e) => {
    // onError has already put it on screen; the caller only needs to stop
    // waiting rather than to inherit an unhandled rejection.
    onBuildError(e);
    return null;
  });
}

function afterParamChange() {
  // A parameter moving means the generator's object is wanted again, even if
  // the builder still holds a finished build of exactly these values.
  const wasImported = !!S.imported;
  leaveImported();
  slicePath.invalidate();
  const issues = validateParams(S.gen, S.params);
  analysis.set({ issues });
  panel.setValues(S.params);
  syncPresetRow();
  updateFocusDim();
  rebuild({ force: wasImported });
}

function onMesh(r) {
  leaveImported();
  S.result = r;
  plate.hide();                      // a fresh single build always takes the viewer back
  viewer.setMesh(r.render);
  const box = boxOf(r);
  dims.setBox(box);
  dims.setDims((r.meta && r.meta.dims) || []);
  titleBlock.tick();
  titleBlock.set({
    gen: S.gen.name,
    variant: variantName(),
    material: slicePath.material(),
    size: box.size,
    pxPerMm: dims.pxPerMm(),
  });
  analysis.set({ mesh: { bbox: box }, analysis: null, print: null });
  setSectionRange();
  updateFocusDim();
  syncBambu();
  if (r.hints && Array.isArray(r.hints.notes) && r.hints.notes.length) {
    status('Ready', r.hints.notes[0]);
  } else {
    status('Ready', `${S.gen.name} — ${r.triCount.toLocaleString('en-GB')} triangles in ${r.ms.toFixed(0)} ms`);
  }
}

function onAnalysis(r) {
  if (r !== S.result) return;
  analysis.set({ analysis: r.analysis, print: r.print });
  titleBlock.set({
    volume: r.analysis ? r.analysis.volume : null,
    mass: r.print ? r.print.estGrams : null,
    material: slicePath.material(),
  });
  const bad = r.analysis && !r.analysis.manifold;
  if (bad) status('Not watertight', 'This will not slice cleanly — see the analysis column.', 'error');
}

function onBuildError(err) {
  status('Failed', String(err && err.message || err), 'error');
  analysis.set({
    issues: [{ severity: 'error', param: 'BUILD', message: String(err && err.message || err) }],
  });
  $('[data-busy]').hidden = true;
}

/** The kernel's own bounding box, re-derived into plain arrays. It comes from
 *  the worker measured at double precision; the render buffers are float32 and
 *  would state a size a micron off the one the STL has. */
function boxOf(result) {
  const b = result.bbox || { min: [0, 0, 0], max: [0, 0, 0] };
  const min = Array.from(b.min), max = Array.from(b.max);
  return {
    min, max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

// ---- generators ----------------------------------------------------------

async function setGen(id, { params = null, rebuildNow = true } = {}) {
  const gen = S.generators.find(g => g.id === id);
  if (!gen) throw new Error(`no generator "${id}"`);
  leaveImported();
  S.gen = gen;
  S.params = params ? { ...defaultParams(gen), ...params } : defaultParams(gen);
  for (const q of gen.params) {
    // A saved design from an older version of a generator can carry a value the
    // parameter no longer allows; coerce rather than refuse to open it.
    if (q.type === 'number' || q.type === 'int' || q.type === 'enum' || q.type === 'bool' || q.type === 'text') {
      S.params[q.key] = coerce(q, S.params[q.key]);
    }
  }
  $('[data-crumb-cat]').textContent = gen.category;
  $('[data-crumb-gen]').textContent = gen.name;
  $('[data-gen-desc]').textContent = gen.description || gen.blurb || '';
  document.title = `${gen.name} — Bluesheet`;
  panel.setGenerator(gen, S.params);
  renderPresets(gen);
  catalogue.setActive(gen.id);
  slicePath.invalidate('A different object is loaded.');
  analysis.set({ issues: validateParams(gen, S.params), slice: null });
  dims.setDims([]);
  setGcode(null);
  try { localStorage.setItem(LAST_GEN_KEY, gen.id); } catch { /* private mode */ }
  if (location.hash.slice(1) !== gen.id) history.replaceState(null, '', `#${gen.id}`);
  if (!rebuildNow) return null;
  const r = await rebuild({ force: true });
  viewer.setPreset('iso');
  return r;
}

const CUSTOM = '__custom';

function renderPresets(gen) {
  const row = $('[data-preset-row]');
  const sel = $('[data-preset-select]');
  const list = Array.isArray(gen.presets) ? gen.presets : [];
  row.hidden = list.length === 0;
  clear(sel);
  sel.appendChild(el('option', { value: '', text: 'Defaults' }));
  for (const p of list) sel.appendChild(el('option', { value: p.name, text: p.name }));
  // A state, not a choice: the row shows it once the numbers no longer match
  // any preset, the way the title block already says Custom.
  sel.appendChild(el('option', { value: CUSTOM, text: 'Custom', disabled: true }));
  sel.value = '';
}

/** Keep the preset row honest: the preset whose values all match, Defaults
 *  if nothing has moved, otherwise Custom. */
function syncPresetRow() {
  const sel = $('[data-preset-select]');
  if (!S.gen) return;
  const hit = (S.gen.presets || []).find(p => Object.entries(p.values).every(([k, v]) => same(S.params[k], v)));
  if (hit) { sel.value = hit.name; return; }
  const d = defaultParams(S.gen);
  const atDefaults = S.gen.params.every(q => same(S.params[q.key], d[q.key]) || (S.params[q.key] === undefined && d[q.key] === undefined));
  sel.value = atDefaults ? '' : CUSTOM;
}

$('[data-preset-select]').addEventListener('change', (e) => {
  const name = e.target.value;
  if (!name) { S.params = defaultParams(S.gen); panel.setValues(S.params); afterParamChange(); return; }
  applyPreset(name);
});

async function applyPreset(name) {
  const p = (S.gen.presets || []).find(x => x.name === name);
  if (!p) throw new Error(`no preset "${name}" on ${S.gen.id}`);
  S.params = { ...defaultParams(S.gen), ...p.values };
  $('[data-preset-select]').value = name;
  panel.setValues(S.params);
  slicePath.invalidate('A preset was applied.');
  analysis.set({ issues: validateParams(S.gen, S.params) });
  return rebuild({ force: true });
}

/** The title block's variant line: the preset if the numbers match one exactly,
 *  the generator's own word for it if it supplies one, otherwise "custom" —
 *  which is the honest answer and the common one. */
function variantName() {
  const meta = S.result && S.result.meta;
  for (const p of (S.gen.presets || [])) {
    if (Object.entries(p.values).every(([k, v]) => same(S.params[k], v))) return p.name;
  }
  if (meta && typeof meta.variant === 'string') return meta.variant;
  return 'Custom';
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

function objectName() {
  if (S.imported) return S.imported.name.replace(/\.stl$/i, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Imported object';
  const variant = variantName();
  const base = variant && variant !== 'Custom' ? `${S.gen.name} ${variant}` : S.gen.name;
  return base.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ---- dimension focus -----------------------------------------------------

function setFocusParam(q) {
  S.focus = q;
  updateFocusDim();
}

function updateFocusDim() {
  const q = S.focus;
  if (!q) return dims.setFocus(null);
  const v = S.params[q.key];
  if (q.type === 'bool' || q.type === 'text' || q.type === 'image' || q.type === 'series') {
    return dims.setFocus(null);
  }
  const value = typeof v === 'number' ? v : Number(v);
  dims.setFocus({
    param: q.key,
    label: q.label || q.key,
    value: Number.isFinite(value) ? value : null,
    unit: q.unit ?? (q.type === 'int' ? '' : 'mm'),
    type: q.type,
  });
}

// ---- the viewport controls ----------------------------------------------

function setMode(mode) {
  if (mode === 'gcode' && !S.gcode) return false;
  S.mode = mode;
  viewer.setMode(mode);
  for (const b of $$('[data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
  return true;
}

for (const b of $$('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
for (const b of $$('[data-view]')) b.addEventListener('click', () => viewer.setPreset(b.dataset.view));
$('[data-fit]').addEventListener('click', () => viewer.fit());

const sectionRange = $('[data-section-range]');
const sectionToggle = $('[data-section-toggle]');
sectionToggle.addEventListener('click', () => {
  const on = sectionToggle.getAttribute('aria-pressed') !== 'true';
  sectionToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  sectionToggle.textContent = on ? 'On' : 'Off';
  viewer.setClipEnabled(on);
});
sectionRange.addEventListener('input', () => {
  const [lo, hi] = viewer.clipRange();
  viewer.setClip(lo + (hi - lo) * (Number(sectionRange.value) / 100));
});

function setSectionRange() {
  $('[data-section-tool]').classList.add('is-on');
  sectionRange.value = '100';
  viewer.setClip(viewer.clipRange()[1]);
}

function setGcode(doc) {
  S.gcode = doc;
  const btn = $('[data-mode="gcode"]');
  btn.disabled = !doc;
  viewer.setGcode(doc);
  if (!doc) {
    if (S.mode === 'gcode') setMode('solid');
    return;
  }
  setMode('gcode');
  viewer.fit();
  if (!reducedMotion()) viewer.playBuild({ secondsPerLayer: Math.min(0.05, 3 / Math.max(1, doc.layerCount || 1)) });
}

// ---- panel chrome --------------------------------------------------------

const notesBtn = $('[data-toggle-notes]');
const paramsScroll = $('[data-params-scroll]');
notesBtn.addEventListener('click', () => {
  const on = notesBtn.getAttribute('aria-pressed') !== 'true';
  notesBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  paramsScroll.dataset.notes = on ? 'on' : 'off';
});

const analysisToggle = $('[data-analysis-toggle]');
analysisToggle.addEventListener('click', () => {
  const col = $('.col--analysis');
  const on = col.dataset.expanded !== 'true';
  col.dataset.expanded = on ? 'true' : 'false';
  analysisToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  analysisToggle.textContent = on ? 'Hide' : 'Show';
});

$('[data-quality-select]').addEventListener('change', (e) => {
  S.quality = e.target.value;
  rebuild({ force: true });
});

$('[data-reset]').addEventListener('click', () => {
  S.params = defaultParams(S.gen);
  $('[data-preset-select]').value = '';
  panel.setValues(S.params);
  afterParamChange();
});

$('[data-open-catalogue]').addEventListener('click', () => catalogue.open());
$('[data-open-library]').addEventListener('click', () => library.open());
$('[data-open-made]').addEventListener('click', () => made.open());

$('[data-export]').addEventListener('click', async () => {
  try {
    const bytes = await exportSTL();
    const slug = objectName().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const name = S.imported ? `${slug}.stl` : `${S.gen.id}-${slug}.stl`;
    download(new Blob([bytes], { type: 'model/stl' }), name);
    const tris = S.imported ? S.imported.triCount : S.result.triCount;
    status('Saved', `${name} — ${(bytes.byteLength / 1024).toFixed(0)} kB, ${tris.toLocaleString('en-GB')} triangles`);
  } catch (e) {
    status('Failed', e.message, 'error');
  }
});

// ---- Bambu Studio ---------------------------------------------------------
//
// A generator that returns meta.colourChangeZ is a two-colour print, and gets a
// Bambu Studio project with Sam's A1 mini profile and the swap already on the
// layer slider (js/kernel/bambu.js). Nothing here knows which generators those
// are: the buttons follow the build's meta, and stay hidden for everything else
// (a one-colour project would be the plain 3mf again with a profile attached).
//
// "Open in Bambu Studio" parks the project on this server and hands Bambu a URL
// to it through the scheme MakerWorld uses. Bambu downloads it itself, so the
// URL is this page's own origin: the same machine or the LAN, never the
// internet. Bambu asks "not from a trusted site, open anyway?" for anything
// that is not MakerWorld; that dialog is Bambu's and cannot be skipped.

function hasColourChange() {
  const meta = !S.imported && S.result && S.result.meta;
  return !!meta && Number.isFinite(meta.colourChangeZ);
}

// Looked up on each call, not held in a const: onMesh can call this from
// anywhere in the file's order of evaluation.
function syncBambu() {
  const on = hasColourChange();
  $('[data-export-bambu]').hidden = !on;
  $('[data-open-bambu]').hidden = !on;
}

function bambuName() {
  const slug = objectName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${S.gen.id}-${slug || 'object'}`;
}

async function bambuProject() {
  if (!S.gen || !hasColourChange()) throw new Error('this object declares no colour change');
  return builder.bambu(request(), objectName());
}

$('[data-export-bambu]').addEventListener('click', async () => {
  try {
    const bytes = await bambuProject();
    const name = `${bambuName()}.3mf`;
    download(new Blob([bytes], { type: 'model/3mf' }), name);
    status('Saved', `${name}: Bambu project, filament change at ${S.result.meta.colourChangeZ} mm, ${(bytes.byteLength / 1024).toFixed(0)} kB`);
  } catch (e) {
    status('Failed', e.message, 'error');
  }
});

function base64Of(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** bambustudioopen://<url> is what Bambu registers on macOS (GUI_App::MacOpenURL);
 *  Windows and Linux take bambustudio://open?file=<url>. Both are URL-encoded. */
function bambuSchemeUrl(fileUrl) {
  const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  return /mac/i.test(plat)
    ? `bambustudioopen://${encodeURIComponent(fileUrl)}`
    : `bambustudio://open?file=${encodeURIComponent(fileUrl)}`;
}

$('[data-open-bambu]').addEventListener('click', async () => {
  try {
    status('Working', 'Building the Bambu project');
    const bytes = await bambuProject();
    const res = await fetch('/api/bambu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bambuName(), data: base64Of(bytes) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `the server said ${res.status}`);
    const fileUrl = new URL(body.url, location.origin).href;
    location.href = bambuSchemeUrl(fileUrl);
    status('Sent', `Handed to Bambu Studio. It asks whether to trust ${location.host}; the link lasts ${Math.round(body.ttl / 60)} minutes.`);
  } catch (e) {
    status('Failed', e.message, 'error');
  }
});

// Naming a design is an inline step in the panel rather than a window.prompt():
// a modal the browser draws cannot be styled, cannot be reached with a finger on
// an iPad without the keyboard covering it, and stops the page dead.
const saveRow = $('[data-save-row]');
const saveName = $('[data-save-name]');

$('[data-save]').addEventListener('click', () => {
  saveRow.hidden = false;
  saveName.value = objectName();
  saveName.focus();
  saveName.select();
});
$('[data-save-cancel]').addEventListener('click', () => { saveRow.hidden = true; });
$('[data-save-go]').addEventListener('click', () => commitSave());
saveName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitSave(); }
  if (e.key === 'Escape') { e.preventDefault(); saveRow.hidden = true; }
});

async function commitSave() {
  const name = saveName.value.trim() || objectName();
  saveRow.hidden = true;
  return saveDesign(name);
}

async function saveDesign(name) {
  try {
    const entry = await library.save({
      name: (name || objectName()).trim(),
      gen: S.gen.id,
      params: S.params,
      thumbnail: viewer.thumbnail({ size: 256, type: 'image/webp', quality: 0.85 }),
      provenance: provenance(S.gen, S.params),
      version: S.gen.version ?? 1,
    });
    status('Saved', `“${entry.name}” is in the library.`);
    return entry;
  } catch (e) {
    status('Not saved', e.message, 'error');
    throw e;
  }
}

/** What the Made log needs from the application when a slice lands: the
 *  generator, its parameters (bulk fields packed the way the library packs
 *  them), and a picture of the viewer no wider than 320 px — the server caps
 *  the render at 512 kB and a full-size PNG of the viewport is several times
 *  that. Never throws: a missing render is a poorer record, not a failed slice. */
function madeRecord() {
  if (!S.gen) return null;
  let render = null;
  try {
    viewer.render();                          // preserveDrawingBuffer is off: draw, then read, in one task
    const src = canvas;
    const scale = Math.min(1, 320 / Math.max(1, src.width));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    render = c.toDataURL('image/png');
  } catch { render = null; }
  return {
    gen: S.gen.id,
    genName: S.gen.name,
    name: plate.active ? plate.name() : objectName(),
    params: packParams(S.params).params,
    provenance: provenance(S.gen, S.params),
    version: S.gen.version ?? 1,
    render,
  };
}

async function loadSaved(entry) {
  if (!entry) return null;
  try {
    const r = await setGen(entry.gen, { params: entry.params });
    status('Opened', `“${entry.name}” — saved ${(entry.created || '').slice(0, 16).replace('T', ' ')}`);
    return r;
  } catch (e) {
    status('Failed', `That design would not open: ${e.message}`, 'error');
    return null;
  }
}

async function exportSTL() {
  if (S.imported) {
    // The file's own provenance travels with it when it had one; otherwise the
    // header names the file, which is what it always was.
    const p = S.imported.provenance;
    return S.imported.mesh.toSTL(p ? `${p.gen} v${p.version} #${p.hash}` : objectName());
  }
  if (!S.gen) throw new Error('nothing to export');
  return builder.stl(request(), provenance(S.gen, S.params));
}

// ---- imported objects (the inspector's front door) -----------------------
//
// An inspected STL can stand in for the generator's object. Nothing downstream
// changes: exportSTL() hands back its bytes, objectName() its file name, and the
// slice path, the plate and the printer see exactly what they see for a
// generated part. The first parameter change or generator pick puts the
// generator's object back.

function useImported(obj) {
  if (!obj || !obj.mesh) return null;
  S.imported = {
    name: obj.name || 'imported.stl', mesh: obj.mesh, render: obj.render, bbox: obj.bbox,
    analysis: obj.analysis || null, print: obj.print || null, provenance: obj.provenance || null,
    triCount: obj.mesh.triCount, repaired: !!obj.repaired, report: obj.report || null,
  };
  plate.hide();
  syncBambu();
  viewer.setMesh(obj.render || obj.mesh);
  const box = boxOf({ bbox: obj.bbox || obj.mesh.bbox() });
  dims.setBox(box);
  dims.setDims([]);
  dims.setFocus(null);
  titleBlock.tick();
  titleBlock.set({
    gen: 'Imported', variant: objectName(), material: slicePath.material(),
    size: box.size, pxPerMm: dims.pxPerMm(),
    volume: S.imported.analysis ? Math.abs(S.imported.analysis.volume) : null,
    mass: S.imported.print ? S.imported.print.estGrams : null,
  });
  analysis.set({ mesh: { bbox: box }, analysis: S.imported.analysis, print: S.imported.print, issues: [], slice: null });
  $('[data-crumb-cat]').textContent = 'Imported';
  $('[data-crumb-gen]').textContent = S.imported.name;
  document.title = `${S.imported.name} — Bluesheet`;
  slicePath.invalidate('An imported object is loaded.');
  setGcode(null);
  setSectionRange();
  viewer.setPreset('iso');
  viewer.fit();
  status('Imported', `${S.imported.name} — ${S.imported.triCount.toLocaleString('en-GB')} triangles` +
    (S.imported.repaired ? ', repaired' : '') + '. Export, slice and print work as for a generated object.');
  return S.imported;
}

function leaveImported() {
  if (!S.imported) return;
  S.imported = null;
  syncBambu();
  if (S.gen) {
    $('[data-crumb-cat]').textContent = S.gen.category;
    $('[data-crumb-gen]').textContent = S.gen.name;
    document.title = `${S.gen.name} — Bluesheet`;
  }
}

/** A saved design whose provenance string names the same generator, version
 *  and parameter hash as an inspected file's header — the one case where the
 *  original parameters can be recovered, because the library kept them. */
async function findByProvenance(str) {
  const want = parseProvenance(str);
  if (!want) return null;
  const entries = await library.list();
  const hit = entries.find(e => {
    const p = parseProvenance(e.provenance || '');
    return p && p.gen === want.gen && p.version === want.version && p.hash === want.hash;
  });
  return hit ? library.entry(hit.id) : null;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- the cupboard rule ---------------------------------------------------
//
// This laptop lives next to a printer with nowhere to put its heat. When the tab
// is not being looked at, nothing here runs: the viewer stops itself, the
// builder refuses to schedule, and the two SVG overlays skip their frames. On
// the way back, whatever was wanted while hidden is built once.

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    viewer.stopBuild();
    return;
  }
  viewer.requestDraw();
  dims.schedule();
  scaleBar.schedule();
});

// The scale figure in the title block follows the zoom, and only the zoom.
viewer.on('camera', debounce(() => titleBlock.setScale(dims.pxPerMm()), 120));
viewer.on('error', (e) => status('Viewer', String(e && e.message || e), 'error'));

// ---- boot ----------------------------------------------------------------

/** `?gen=vase,knob` loads exactly those modules instead of the registry. This
 *  project gains a generator every time someone has an idea, and being able to
 *  open one before it has been added to GENERATOR_IDS is the difference between
 *  a two-second loop and a two-file loop. */
function requestedIds() {
  const raw = new URLSearchParams(location.search).get('gen');
  if (!raw) return undefined;
  const ids = raw.split(',').map(s => s.trim()).filter(s => /^[a-z0-9][a-z0-9-]*$/.test(s));
  return ids.length ? ids : undefined;
}

async function boot() {
  status('Loading', 'reading the catalogue');
  const { generators, failures } = await loadGenerators(requestedIds());
  S.generators = generators;
  S.failures = failures;
  catalogue.setGenerators(generators, failures);
  // The public copy (tools/build-static.mjs) has no server behind it; asking
  // would only put two 404s in the console and, behind a SPA fallback, parse
  // an HTML page as JSON.
  if (window.BLUESHEET_STATIC) {
    slicePath.setHealth(null);
  } else {
    plate.load();
    fetch('api/health', { headers: { Accept: 'application/json' } })
      .then(r => r.json())
      .then(h => { S.health = h; slicePath.setHealth(h); })
      .catch(() => slicePath.setHealth(null));
  }

  if (failures.length) {
    console.warn('bluesheet: generators that would not load', failures);
  }

  if (!generators.length) {
    status('Empty', 'No generators are installed yet — js/gen/ has nothing in it.', 'warn');
    $('[data-crumb-gen]').textContent = 'Nothing to make';
    $('[data-gen-desc]').textContent = 'Bluesheet has no generators installed. Add one to js/gen/ and list it in GENERATOR_IDS.';
    return;
  }

  const wanted = location.hash.slice(1) || safeGet(LAST_GEN_KEY) || generators[0].id;
  const id = generators.some(g => g.id === wanted) ? wanted : generators[0].id;
  await setGen(id);
  viewer.fit();
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

// ---- the test handle -----------------------------------------------------

const api = {
  ready: false,
  get gen() { return S.gen; },
  get generators() { return S.generators; },
  get failures() { return S.failures; },
  get params() { return S.params; },
  get mesh() { return S.imported ? S.imported.mesh : S.result ? S.result.mesh : null; },
  get analysis() { return S.imported ? S.imported.analysis : S.result ? S.result.analysis : null; },
  get printability() { return S.imported ? S.imported.print : S.result ? S.result.print : null; },
  get imported() { return S.imported; },
  inspect,
  useImported: (obj) => useImported(obj),
  get meta() { return S.result ? S.result.meta : null; },
  get mode() { return S.mode; },
  get revision() { return titleBlock.rev; },
  get gcode() { return S.gcode; },
  get health() { return S.health; },
  viewer,
  builder,
  library,
  made,
  catalogue,
  panel,
  dims,
  scaleBar,
  titleBlock,
  slicePath,
  plate,
  rebuild: (opts) => rebuild({ force: true, ...opts }),
  setGen: (id) => setGen(id),
  setParam: async (key, value) => {
    const q = S.gen.params.find(p => p.key === key);
    if (!q) throw new Error(`no parameter "${key}" on ${S.gen.id}`);
    S.params[key] = (q.type === 'vec2' || q.type === 'image' || q.type === 'series') ? value : coerce(q, value);
    panel.setValues(S.params);
    syncPresetRow();
    slicePath.invalidate();
    analysis.set({ issues: validateParams(S.gen, S.params) });
    updateFocusDim();
    return rebuild();
  },
  setQuality: (q) => { S.quality = q; $('[data-quality-select]').value = q; return rebuild({ force: true }); },
  applyPreset: (name) => applyPreset(name),
  setMode: (m) => setMode(m),
  setFocusParam: (key) => {
    const q = key ? S.gen.params.find(p => p.key === key) : null;
    setFocusParam(q || null);
    dims.render();
    return !!q;
  },
  exportSTL: () => exportSTL(),
  saveDesign: (name) => saveDesign(name),
  loadSaved: (entry) => loadSaved(entry),
  slice: () => slicePath.run(),
  print: () => slicePath.openConfirm(),
  objectName: () => objectName(),
  status: () => ({ key: statusKey.textContent, message: statusMsg.textContent, tone: statusBar.dataset.tone || null }),
};

window.__bluesheet = api;

boot().then(() => {
  api.ready = true;
  document.documentElement.dataset.bluesheet = 'ready';
}).catch((e) => {
  console.error('bluesheet: boot failed', e);
  status('Failed', `Bluesheet did not start: ${e.message}`, 'error');
  api.ready = true;                 // the handle is honest about having tried
  api.bootError = String(e && e.message || e);
  document.documentElement.dataset.bluesheet = 'error';
});
