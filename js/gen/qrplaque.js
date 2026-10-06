// QR plaque: a printable QR code on a plate, with a caption and a hole to hang
// it by. Wi-Fi details for the spare room, a link on a coaster, a label on a
// drawer that opens the inventory page.
//
// Everything that matters for whether a phone reads it happens in two places:
// the encoder (js/kernel/qr.js, checked against an independent decoder in the
// tests) and the module geometry here. The modules are ONE 2D shape — every
// dark region traced as a polygon with its holes — extruded once, rather than
// thousands of small boxes unioned in 3D. That keeps the default build in the
// tens of milliseconds and the mesh a real solid at every size.
//
// Contrast on a single-nozzle printer without an AMS is a filament change at
// the height where the modules start; hints() names the layer.
import { Mesh } from '../kernel/mesh.js';
import * as P from '../kernel/poly2d.js';
import { extrude } from '../kernel/builders.js';
import { loadFont, layoutText } from '../kernel/text.js';
import { clamp, num, segScale } from '../kernel/scalar.js';
import { encode, capacity, utf8Bytes, MAX_VERSION, ECC_LEVELS } from '../kernel/qr.js';

// ---------------------------------------------------------------------------
// Fonts: parsed once at module load so build() can stay synchronous. Same
// files and ids as nameplate, loaded independently so a fault in one generator
// cannot take the other down with it.
// ---------------------------------------------------------------------------

const FONT_FILES = [
  { id: 'LiberationSansNarrow-Regular', file: 'LiberationSansNarrow-Regular.ttf', label: 'Sans Narrow',
    help: 'Condensed; fits the most characters under a code.' },
  { id: 'DejaVuSansMono', file: 'DejaVuSansMono.ttf', label: 'Sans Mono',
    help: 'Fixed pitch, even stroke — the safest face for small captions.' },
  { id: 'Quicksand-Bold', file: 'Quicksand-Bold.ttf', label: 'Rounded Bold',
    help: 'Heavy and rounded; reads well in relief.' },
];
const DEFAULT_FONT = 'LiberationSansNarrow-Regular';
const FONTS = new Map();
const FONT_ERRORS = new Map();

function fontFor(id) {
  return FONTS.get(id) || FONTS.get(DEFAULT_FONT) || FONTS.values().next().value || null;
}

async function loadBundledFonts() {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const dir = new URL('../../assets/fonts/', import.meta.url);
  for (const f of FONT_FILES) {
    try {
      let bytes;
      if (isNode) {
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([import('node:fs'), import('node:url')]);
        bytes = readFileSync(fileURLToPath(new URL(f.file, dir)));
      } else {
        const res = await fetch(new URL(f.file, dir));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      }
      FONTS.set(f.id, loadFont(bytes));
    } catch (e) {
      // A missing face is a missing caption, not a broken generator.
      FONT_ERRORS.set(f.id, String((e && e.message) || e));
    }
  }
}
await loadBundledFonts();

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * The de-facto Wi-Fi string (the ZXing "WIFI:" scheme every phone understands).
 * Backslash, semicolon, comma, quote and colon are escaped with a backslash;
 * the hidden flag is only written when set, and an open network carries no
 * password field at all.
 */
export function wifiString({ ssid = '', password = '', security = 'WPA', hidden = false } = {}) {
  const esc = (s) => String(s).replace(/([\\;,":])/g, '\\$1');
  const t = security === 'nopass' ? 'nopass' : security === 'WEP' ? 'WEP' : 'WPA';
  let s = `WIFI:T:${t};S:${esc(ssid)};`;
  if (t !== 'nopass') s += `P:${esc(password)};`;
  if (hidden) s += 'H:true;';
  return s + ';';
}

/** The exact text the code carries for a set of parameters. */
export function payloadFor(p) {
  if (p.content === 'wifi') {
    return wifiString({ ssid: p.ssid, password: p.password, security: p.security, hidden: !!p.hidden });
  }
  return String(p.text ?? '');
}

// The largest payload the sweep or a user can ask for: version 40 at level L
// in byte mode. Longer than that is refused by validate(); build() truncates so
// the preview still shows something rather than a blank viewport.
const MAX_TEXT = capacity(MAX_VERSION, 'L', 'byte');

function fitPayload(text, ecc) {
  const bytes = utf8Bytes(text);
  let level = ecc, truncated = false;
  const cap = (lv) => capacity(MAX_VERSION, lv, 'byte');
  if (bytes.length > cap(level)) {
    // Step down through the levels before cutting characters: a longer message
    // at L is still the message; a shorter one at H is not.
    for (const lv of ['Q', 'M', 'L']) if (ECC_LEVELS[lv].ordinal < ECC_LEVELS[level].ordinal && bytes.length <= cap(lv)) { level = lv; break; }
  }
  if (bytes.length > cap(level)) {
    level = 'L';
    truncated = true;
    let out = '';
    let used = 0;
    for (const ch of text) {
      const n = utf8Bytes(ch).length;
      if (used + n > cap('L')) break;
      out += ch; used += n;
    }
    text = out;
  }
  return { text, level, truncated };
}

// ---------------------------------------------------------------------------
// Module geometry: trace the dark cells of a grid as polygons
// ---------------------------------------------------------------------------

/**
 * Outline every connected dark region of an n×n grid as a shape (outer ring
 * plus holes), in grid units with (0,0) at the bottom-left corner of cell
 * (0, 0). Cells are 4-connected; two dark cells that meet only at a corner are
 * different regions.
 *
 * That corner is the one degenerate case in the whole thing. Two squares that
 * share a single point are two rings sharing a vertex, and extruding those
 * gives two wall strips on one vertical edge — four triangles on an edge, which
 * is not a manifold. So at every such corner each region's vertex is pulled
 * `nudge` grid units into its own cell along the diagonal, which turns the
 * touch into a gap a few hundredths of a millimetre wide: invisible to the
 * nozzle, decisive for the mesh. The same corner seen from the light side
 * joins two light cells through the gap, so a hole ring that passed through
 * the point twice now passes each side once and stays simple.
 *
 * @param {number} n           grid side
 * @param {(i:number, j:number) => boolean} dark   j counts up from the BOTTOM row
 * @param {number} nudge       diagonal pull-in at corner touches, grid units
 * @returns {Array<Array<Array<[number, number]>>>}   shape[]
 */
export function traceGrid(n, dark, nudge = 0.02) {
  const at = (i, j) => i >= 0 && j >= 0 && i < n && j < n && dark(i, j);

  // Label each dark cell with its 4-connected region so a hole can be handed
  // to the outer ring that surrounds it without any point-in-polygon search.
  const label = new Int32Array(n * n).fill(-1);
  let regions = 0;
  const stack = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!at(i, j) || label[j * n + i] >= 0) continue;
      const id = regions++;
      stack.push(i, j);
      label[j * n + i] = id;
      while (stack.length) {
        const cj = stack.pop(), ci = stack.pop();
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di, nj = cj + dj;
          if (at(ni, nj) && label[nj * n + ni] < 0) { label[nj * n + ni] = id; stack.push(ni, nj); }
        }
      }
    }
  }
  if (!regions) return [];

  // Boundary edges, directed so the dark cell is on the left: outer rings come
  // out counter-clockwise and holes clockwise without a second pass.
  const vkey = (i, j) => j * (n + 1) + i;
  const outgoing = new Map();
  const edges = [];
  const addEdge = (x0, y0, x1, y1, ci, cj) => {
    const e = { x0, y0, x1, y1, ci, cj, used: false };
    edges.push(e);
    const k = vkey(x0, y0);
    const list = outgoing.get(k);
    if (list) list.push(e); else outgoing.set(k, [e]);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) addEdge(i, j, i + 1, j, i, j);
      if (!at(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1, i, j);
      if (!at(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1, i, j);
      if (!at(i - 1, j)) addEdge(i, j + 1, i, j, i, j);
    }
  }

  const byRegion = new Map();
  for (const start of edges) {
    if (start.used) continue;
    const ring = [];
    let e = start;
    let guard = edges.length + 1;
    while (e && !e.used && guard-- > 0) {
      e.used = true;
      const cands = outgoing.get(vkey(e.x1, e.y1)) || [];
      let next = null;
      if (cands.length === 1) next = cands[0];
      else {
        // A corner touch: two ways on, and the one that keeps to this edge's
        // own cell keeps the two regions apart.
        for (const c of cands) if (!c.used && c.ci === e.ci && c.cj === e.cj) { next = c; break; }
      }
      // The vertex is the END of this edge; pull it into the cell at a corner touch.
      let vx = e.x1, vy = e.y1;
      if (cands.length > 1) {
        vx += nudge * Math.sign(e.ci + 0.5 - vx);
        vy += nudge * Math.sign(e.cj + 0.5 - vy);
      }
      ring.push([vx, vy]);
      e = next;
    }
    const simplified = dropCollinear(ring);
    if (simplified.length < 3) continue;
    const id = label[start.cj * n + start.ci];
    let g = byRegion.get(id);
    if (!g) { g = { outer: null, holes: [] }; byRegion.set(id, g); }
    if (P.signedArea(simplified) > 0) g.outer = simplified; else g.holes.push(simplified);
  }

  const shapes = [];
  for (const g of byRegion.values()) if (g.outer) shapes.push([g.outer, ...g.holes]);
  return shapes;
}

function dropCollinear(ring) {
  const n = ring.length;
  if (n < 4) return ring;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n], b = ring[i], c = ring[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  return out;
}

function scaleShapes(shapes, k, dx, dy) {
  return shapes.map(s => s.map(r => r.map(pt => [pt[0] * k + dx, pt[1] * k + dy])));
}

function shiftShapes(shapes, dx, dy) {
  return shapes.map(s => s.map(r => r.map(pt => [pt[0] + dx, pt[1] + dy])));
}

// ---------------------------------------------------------------------------
// Caption ink
// ---------------------------------------------------------------------------

const MIN_RING_AREA = 1e-5;

function dropSpecks(shapes) {
  const out = [];
  for (const s of shapes) {
    if (!s.length || s[0].length < 3 || P.area(s[0]) < MIN_RING_AREA) continue;
    out.push([s[0], ...s.slice(1).filter(r => r.length >= 3 && P.area(r) >= MIN_RING_AREA)]);
  }
  return out;
}

function ringBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Fold overlapping glyph outlines into disjoint shapes. Pairs are unioned one
 * at a time and only where their boxes touch: poly2d.boolean is exact for two
 * distinct operands and letters that cannot overlap never need to meet it.
 * Glyphs that touch at exactly one point (a run of monospace W's does) get a
 * microscopic square dropped on the contact so the extrusion has a neck there
 * rather than a shared edge.
 */
function unionInk(shapes) {
  const kept = dropSpecks(shapes);
  if (kept.length < 2) return kept;
  const boxes = kept.map(s => ringBox(s[0]));
  const parent = kept.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const EPS = 2e-5;
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[2] < b[0] - EPS || b[2] < a[0] - EPS || a[3] < b[1] - EPS || b[3] < a[1] - EPS) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const groups = new Map();
  for (let i = 0; i < kept.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(kept[i]);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    let acc = [g[0]];
    for (let i = 1; i < g.length; i++) acc = dropSpecks(P.boolean(acc, [g[i]], 'union'));
    for (const bridge of contactBridges(acc)) acc = dropSpecks(P.boolean(acc, [bridge], 'union'));
    for (const s of acc) out.push(s);
  }
  return out;
}

function contactBridges(shapes) {
  if (shapes.length < 2) return [];
  const EPS = 2e-5, HALF = 4e-3;
  const seen = new Map();
  const found = [];
  const claimed = new Set();
  for (let i = 0; i < shapes.length; i++) {
    for (const ring of shapes[i]) {
      for (const pt of ring) {
        const k = `${Math.round(pt[0] / EPS)},${Math.round(pt[1] / EPS)}`;
        const owner = seen.get(k);
        if (owner === undefined) seen.set(k, i);
        else if (owner !== i && !claimed.has(k)) { claimed.add(k); found.push(pt); }
      }
    }
  }
  return found.map(pt => [P.ensureCCW(P.rect(HALF * 2, HALF * 2, { cx: pt[0], cy: pt[1] }))]);
}

function inkBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const p of s[0]) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  if (!isFinite(x0)) return null;
  return { min: [x0, y0], max: [x1, y1], size: [x1 - x0, y1 - y0], center: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const CAP_PAD = 1.5;       // mm of air around the caption
const HOLE_CLEAR = 1.5;    // mm from the hanging hole to anything else
const MIN_MODULE = 1.2;    // mm — a 0.4 mm nozzle draws nothing finer with any confidence

/** Everything the solid needs, as numbers, before a single triangle is made. */
function plan(p, ctx) {
  const sf = segScale(ctx);
  const size = num(p.size, 70);
  const plate = num(p.plate, 2);
  const style = p.style === 'recessed' ? 'recessed' : 'raised';
  // A recess that reached the bottom of the plate would be a hole; keep a floor
  // under it whatever the numbers say (validate() tells the user the same thing).
  const relief = style === 'recessed' ? clamp(num(p.relief, 0.8), 0.2, Math.max(0.2, plate - 0.6)) : num(p.relief, 0.8);
  const quiet = clamp(Math.round(num(p.quiet, 4)), 1, 8);
  const frame = !!p.frame;
  const frameW = frame ? clamp(num(p.frameWidth, 2.5), 0.6, size / 4) : 0;
  const corner = clamp(num(p.corner, 4), 0, size / 2);

  const fit = fitPayload(payloadFor(p), ECC_LEVELS[p.ecc] ? p.ecc : 'M');
  const qr = encode(fit.text, { ecc: fit.level, boostEcc: true });
  const n = qr.size;

  const inner = size - 2 * frameW;
  const pitch = inner / (n + 2 * quiet);

  const caption = String(p.caption ?? '').trim();
  const captionH = num(p.captionHeight, 6);
  const captionBand = caption ? captionH * 1.45 + 2 * CAP_PAD : 0;

  const hang = !!p.hang;
  const holeD = hang ? clamp(num(p.holeDia, 4.5), 1.5, Math.max(1.5, inner / 3)) : 0;
  const hangBand = hang ? holeD + 2 * HOLE_CLEAR : 0;

  const H = size + hangBand + captionBand;
  const top = H / 2;
  const codeTop = top - frameW - hangBand - quiet * pitch;
  const codeBottom = codeTop - n * pitch;
  const captionTop = codeBottom - quiet * pitch;
  const captionMid = captionTop - captionBand / 2;
  const holeC = hang ? [0, top - frameW - hangBand / 2] : null;

  // Caption ink, centred in its band and shrunk to fit its width.
  let ink = [], captionScale = 1, missing = [];
  const font = fontFor(p.captionFont);
  if (caption && font) {
    const maxW = Math.max(4, inner - 2 * CAP_PAD);
    const maxH = captionBand - 2 * CAP_PAD;
    const tol = clamp(0.03 / sf, 0.01, 0.08);
    let lay = layoutText(font, caption, { size: captionH, align: 'center', vAlign: 'baseline', maxWidth: maxW, curveTolerance: tol, onMissing: 'skip' });
    let k = lay.fit || 1;
    if (lay.bbox.size[1] > maxH) {
      k *= maxH / lay.bbox.size[1];
      lay = layoutText(font, caption, { size: captionH * k, align: 'center', vAlign: 'baseline', curveTolerance: tol, onMissing: 'skip' });
    }
    captionScale = k;
    missing = lay.missing || [];
    const box = lay.bbox;
    if (box.size[0] > 1e-6 && box.size[1] > 1e-6) {
      ink = unionInk(shiftShapes(lay.shapes, -box.center[0], captionMid - box.center[1]));
    }
  }

  return {
    sf, size, H, plate, relief, style, quiet, frame, frameW, corner, pitch, n, qr, fit,
    codeLeft: -n * pitch / 2, codeTop, codeBottom, captionBand, captionMid, captionScale, caption, ink, missing,
    hang, holeD, holeC, hangBand, inner,
  };
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

function build(p, ctx = {}) {
  const L = plan(p, ctx);
  const segs = Math.max(4, Math.round(10 * L.sf));

  // The plate outline, with the hanging hole cut in 2D (a hole ring, no CSG).
  const outer = P.roundRect(L.size, L.H, L.corner, { segs });
  const plateShape = [outer];
  if (L.hang) plateShape.push(P.ensureCW(P.circle(L.holeD / 2, { segs: Math.max(12, Math.round(32 * L.sf)), cx: L.holeC[0], cy: L.holeC[1] })));

  // The modules: one traced shape set in grid units, scaled onto the plate.
  const { n, qr } = L;
  const nudge = Math.min(0.02, L.pitch / 10) / L.pitch;
  const cells = traceGrid(n, (i, j) => qr.modules[(n - 1 - j) * n + i] === 1, nudge);
  const modules = scaleShapes(cells, L.pitch, L.codeLeft, L.codeBottom);

  // The frame is a ring on top of the plate in both styles.
  // Its outer ring is a hair inside the plate's, not the plate's own: a
  // ring shared between the plate's top face and the frame's foot welds
  // into an edge with four triangles on it, and the frame reads as a wall
  // that starts nowhere. 0.05 mm is one twentieth of a line width.
  let frameShape = null;
  if (L.frame) {
    const INSET = 0.05;
    const innerR = Math.max(0, L.corner - L.frameW);
    frameShape = [P.roundRect(L.size - 2 * INSET, L.H - 2 * INSET, Math.max(0, L.corner - INSET), { segs }),
                  P.ensureCW(P.roundRect(L.size - 2 * L.frameW, L.H - 2 * L.frameW, innerR, { segs }))];
  }

  let plateMesh, codeMesh;
  if (L.style === 'raised') {
    plateMesh = extrude(plateShape, L.plate);
    const islands = [...modules, ...L.ink];
    if (frameShape) islands.push(frameShape);
    codeMesh = extrude(islands, L.relief, { z0: L.plate, check: false });
  } else {
    // Recessed: the plate is a thinner slab and the top layer is the plate
    // outline with the modules (and the caption) cut out of it in 2D.
    const floor = L.plate - L.relief;
    plateMesh = extrude(plateShape, floor);
    const cutters = [...modules, ...L.ink];
    // Inset a hair from the slab's outline (and hole), for the reason the
    // frame is: a ring shared with the slab's top face welds non-manifold.
    const base = P.offset([plateShape], -0.05, { join: 'round' });
    const top = dropSpecks(P.boolean(base, cutters, 'difference'));
    codeMesh = extrude(top, L.relief, { z0: floor, check: false });
    if (frameShape) codeMesh = Mesh.merge([codeMesh, extrude([frameShape], L.relief, { z0: L.plate })]);
  }

  // The traced outlines carry collinear vertices where a corner touch was
  // nudged; the cap triangulation drops them and the walls keep them, which
  // is a T-junction on every such run. Heal rather than avoid: the kernel has
  // the fix and it is the same class of defect the coaster and the data
  // sculpture had.
  codeMesh = codeMesh.healTJunctions(1e-5, { clean: true });
  const mesh = Mesh.merge([plateMesh, codeMesh]);

  // Centre by construction is exact for the outline; the mesh's bbox is the
  // outline's, so this is a no-op that costs nothing and proves it.
  const b = mesh.bbox();
  const dx = -b.center[0], dy = -b.center[1], dz = -b.min[2];
  const placed = (m) => (dx || dy || dz) ? m.translate(dx, dy, dz) : m;

  // A dark module to hang the relief callout on, and its neighbour for pitch.
  const moduleAt = (i, j) => qr.modules[(n - 1 - j) * n + i] === 1;
  let mi = Math.floor(n / 2), mj = Math.floor(n / 2);
  outer: for (let r = 0; r < n; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
    const a = Math.floor(n / 2) + i, c = Math.floor(n / 2) + j;
    if (a >= 0 && c >= 0 && a < n && c < n && moduleAt(a, c)) { mi = a; mj = c; break outer; }
  }
  const mx = L.codeLeft + (mi + 0.5) * L.pitch + dx, my = L.codeBottom + (mj + 0.5) * L.pitch + dy;
  const zTop = L.plate + (L.style === 'raised' ? L.relief : 0);
  const zBase = L.style === 'raised' ? L.plate : L.plate - L.relief;
  const yTop = L.H / 2 + dy, xR = L.size / 2 + dx;
  const dims = [
    { param: 'size', from: [-L.size / 2 + dx, yTop, L.plate], to: [xR, yTop, L.plate], offset: 8 },
    { param: 'plate', from: [xR, -L.H / 2 + dy, 0], to: [xR, -L.H / 2 + dy, L.plate], offset: [1, -1, 0] },
    { param: 'relief', from: [mx, my, zBase], to: [mx, my, zBase + L.relief], offset: [0, -1, 0] },
    { label: 'pitch', from: [mx, my, zTop], to: [mx + L.pitch, my, zTop], offset: [0, 0, 1] },
    { param: 'quiet', label: 'quiet zone', value: L.quiet, unit: 'modules',
      from: [L.codeLeft + dx, L.codeTop + dy, zTop], to: [L.codeLeft - L.quiet * L.pitch + dx, L.codeTop + dy, zTop], offset: [0, 1, 0] },
  ];
  if (L.frame) dims.push({ param: 'frameWidth', from: [xR - L.frameW, 0 + dy, zTop], to: [xR, 0 + dy, zTop], offset: [0, 0, 1] });
  if (L.corner > 0) dims.push({ param: 'corner', label: 'R', from: [xR - L.corner, yTop - L.corner, L.plate], to: [xR - L.corner, yTop, L.plate], offset: [0, 0, 1] });
  if (L.hang) dims.push({ param: 'holeDia', label: 'Ø', from: [L.holeC[0] - L.holeD / 2 + dx, L.holeC[1] + dy, L.plate], to: [L.holeC[0] + L.holeD / 2 + dx, L.holeC[1] + dy, L.plate], offset: [0, 1, 0] });
  if (L.caption && L.ink.length) {
    const ib = inkBox(L.ink);
    dims.push({ param: 'captionHeight', value: Math.round(L.captionScale * num(p.captionHeight, 6) * 100) / 100,
      from: [ib.max[0] + dx, ib.min[1] + dy, zTop], to: [ib.max[0] + dx, ib.max[1] + dy, zTop], offset: [1, 0, 0] });
  }

  return {
    mesh: placed(mesh),
    parts: [
      { name: 'plate', mesh: placed(plateMesh) },
      { name: 'code', mesh: placed(codeMesh) },
    ],
    meta: {
      dims,
      qr: { version: qr.version, ecc: qr.ecc, mask: qr.mask, modules: qr.size, mode: qr.mode },
      payload: L.fit.text,
      truncated: L.fit.truncated,
      eccUsed: qr.ecc,
      pitch: Math.round(L.pitch * 1000) / 1000,
      plaque: [Math.round(L.size * 100) / 100, Math.round(L.H * 100) / 100],
      colourChangeZ: Math.round(zBase * 1000) / 1000,
      captionScale: Math.round(L.captionScale * 1000) / 1000,
      missingGlyphs: L.missing,
    },
  };
}

function validate(p) {
  const issues = [];
  const payload = payloadFor(p);
  const bytes = utf8Bytes(payload).length;
  const ecc = ECC_LEVELS[p.ecc] ? p.ecc : 'M';
  const capAt = capacity(MAX_VERSION, ecc, 'byte');
  const where = p.content === 'wifi' ? 'ssid' : 'text';
  if (bytes === 0) {
    issues.push({ param: where, severity: 'warn', message: 'The code is empty — it will scan, but to nothing.' });
  } else if (bytes > capAt) {
    const capL = capacity(MAX_VERSION, 'L', 'byte');
    issues.push({ param: where, severity: 'error',
      message: `${bytes} bytes will not fit: a QR code holds at most ${capAt} bytes at level ${ecc} ` +
               (bytes <= capL ? `(${capL} at level L). Drop the error correction or shorten the text.`
                              : `(${capL} even at level L). Shorten the text.`) });
  }
  if (p.content === 'wifi' && p.security !== 'nopass' && !String(p.password ?? '').length) {
    issues.push({ param: 'password', severity: 'warn', message: 'A WPA/WEP network with no password: phones will offer to join and then fail.' });
  }
  if (p.content === 'url' && String(p.text ?? '').length && !/^[a-z][a-z0-9+.-]*:/i.test(String(p.text))) {
    issues.push({ param: 'text', severity: 'warn', message: 'No scheme — start with https:// so a phone opens it as a link rather than showing it as text.' });
  }

  // Module size is the whole game for a printed code.
  try {
    const fit = fitPayload(payload, ecc);
    const qr = encode(fit.text, { ecc: fit.level, boostEcc: true });
    const frameW = p.frame ? num(p.frameWidth, 2.5) : 0;
    const quiet = clamp(Math.round(num(p.quiet, 4)), 1, 8);
    const pitch = (num(p.size, 70) - 2 * frameW) / (qr.size + 2 * quiet);
    if (pitch < MIN_MODULE) {
      const need = Math.ceil(MIN_MODULE * (qr.size + 2 * quiet) + 2 * frameW);
      const lower = ECC_LEVELS[ecc].ordinal > 0
        ? ` Level ${['L', 'M', 'Q'][ECC_LEVELS[ecc].ordinal - 1]} would need fewer modules.` : '';
      issues.push({ param: 'size', severity: pitch < MIN_MODULE * 0.6 ? 'error' : 'warn',
        message: `Modules come out ${pitch.toFixed(2)} mm — a 0.4 mm nozzle cannot resolve under ${MIN_MODULE} mm. ` +
                 `This version-${qr.version} code (${qr.size} modules) wants a plaque at least ${need} mm wide.${lower}` });
    }
  } catch (e) {
    issues.push({ param: where, severity: 'error', message: `Cannot encode: ${e.message}` });
  }

  if (p.style === 'recessed' && num(p.relief, 0.8) >= num(p.plate, 2) - 0.6 + 1e-9) {
    issues.push({ param: 'relief', severity: 'error',
      message: `A ${p.relief} mm recess in a ${p.plate} mm plate leaves no floor — keep it under ${(num(p.plate, 2) - 0.6).toFixed(1)} mm or thicken the plate.` });
  }
  if (p.frame && num(p.frameWidth, 2.5) * 2 >= num(p.size, 70) / 2) {
    issues.push({ param: 'frameWidth', severity: 'error', message: `A ${p.frameWidth} mm frame on a ${p.size} mm plaque leaves no room for the code.` });
  }
  if (String(p.caption ?? '').trim() && !fontFor(p.captionFont)) {
    issues.push({ param: 'caption', severity: 'warn', message: `No typeface could be loaded (${[...FONT_ERRORS.values()].join('; ') || 'none registered'}); the caption is left off.` });
  }
  return issues;
}

function hints(p, ctx = {}) {
  const layerH = num(ctx.layerH, 0.2);
  const plate = num(p.plate, 2);
  const style = p.style === 'recessed' ? 'recessed' : 'raised';
  const relief = style === 'recessed' ? clamp(num(p.relief, 0.8), 0.2, Math.max(0.2, plate - 0.6)) : num(p.relief, 0.8);
  const z = style === 'raised' ? plate : plate - relief;
  const layer = Math.round(z / layerH) + 1;       // layer 1 is the first layer; the change happens before this one starts
  const exact = Math.abs(z / layerH - Math.round(z / layerH)) < 1e-6;
  const notes = [];
  if (style === 'raised') {
    notes.push(`Two colours without an AMS: print the plate in the light colour, then change to the dark filament at ` +
               `${z.toFixed(2)} mm — layer ${layer} at ${layerH} mm layers — so every module above it comes out dark on a light ground. ` +
               `In the slicer, right-click the layer slider at that height and add a colour change (or a pause).`);
  } else {
    notes.push(`Two colours without an AMS: print the plate in the DARK colour, then change to the light filament at ` +
               `${z.toFixed(2)} mm — layer ${layer} at ${layerH} mm layers. The top layer prints light and the recesses show the ` +
               `dark floor as the modules. In the slicer, right-click the layer slider at that height and add a colour change.`);
  }
  if (!exact) {
    notes.push(`${z.toFixed(2)} mm is not a whole number of ${layerH} mm layers, so the change lands a fraction of a layer off; ` +
               `set the plate thickness to a multiple of the layer height for a clean edge.`);
  }
  if (relief < layerH * 2) {
    notes.push(`A ${relief} mm relief is under two layers at ${layerH} mm; a phone reads the colour, not the height, so it will ` +
               `still scan, but the edges of the modules will be softer.`);
  }
  notes.push('Print flat, code up, no supports. One wall and 15% infill is plenty; the plate is the strength.');
  notes.push('Matt filament scans better than silk or glossy — reflections read as light modules.');
  return { profile: { layerH, infill: 15, walls: 2 }, supports: false, notes };
}

export default {
  id: 'qrplaque',
  name: 'QR Plaque',
  category: 'Data',
  blurb: 'A QR code you can print: Wi-Fi details, a link or a note, on a plate with a caption.',
  description:
    'A scannable QR code in relief on a plate, with an optional caption below and a hole to hang it by. ' +
    'Choose what it carries — a Wi-Fi network (phones join it straight from the camera), a link or plain text — and ' +
    'the size of the plaque; the code picks the smallest version that holds the payload at the error-correction level ' +
    'you ask for. The modules are raised on the plate or recessed into it; either way a filament change at the height ' +
    'the hints name gives a two-colour code from a single nozzle. Keep modules above about 1.2 mm — that is the one ' +
    'thing that decides whether a camera can read it.',
  version: 1,
  params: [
    { key: 'content', label: 'Content', type: 'enum', def: 'wifi', group: 'Content',
      options: [
        { v: 'wifi', label: 'Wi-Fi network', help: 'Phones offer to join the network when they scan it.' },
        { v: 'url', label: 'Link', help: 'Opens in the browser. Include https://.' },
        { v: 'text', label: 'Text', help: 'Shown as a note when scanned.' },
      ],
      help: 'What the code carries. Wi-Fi builds the standard WIFI: string for you.' },
    { key: 'text', label: 'Text', type: 'text', def: 'https://bluesheet.local/', maxLength: MAX_TEXT, group: 'Content',
      showIf: (p) => p.content !== 'wifi',
      help: `The link or note. Up to ${MAX_TEXT} bytes at the lowest error correction; short is better, because fewer modules means bigger ones.` },
    { key: 'ssid', label: 'Network name', type: 'text', def: 'Guest WiFi', maxLength: 32, group: 'Content',
      showIf: (p) => p.content === 'wifi', help: 'The SSID exactly as the router broadcasts it — case matters.' },
    { key: 'password', label: 'Password', type: 'text', def: 'letmein123', maxLength: 63, group: 'Content',
      showIf: (p) => p.content === 'wifi' && p.security !== 'nopass', help: 'The network key. Special characters are escaped for you.' },
    { key: 'security', label: 'Security', type: 'enum', def: 'WPA', group: 'Content',
      options: [
        { v: 'WPA', label: 'WPA / WPA2 / WPA3' },
        { v: 'WEP', label: 'WEP' },
        { v: 'nopass', label: 'Open (no password)' },
      ],
      showIf: (p) => p.content === 'wifi', help: 'Almost every home network is WPA. WEP is for very old kit.' },
    { key: 'hidden', label: 'Hidden network', type: 'bool', def: false, group: 'Content',
      showIf: (p) => p.content === 'wifi', help: 'Set if the router does not broadcast the name.' },

    { key: 'ecc', label: 'Error correction', type: 'enum', def: 'M', group: 'Code',
      options: [
        { v: 'L', label: 'L — 7% recoverable', help: 'Fewest modules, so the biggest ones.' },
        { v: 'M', label: 'M — 15% recoverable', help: 'The usual choice.' },
        { v: 'Q', label: 'Q — 25% recoverable' },
        { v: 'H', label: 'H — 30% recoverable', help: 'Survives a chipped corner or a thumb over it, at the cost of finer modules.' },
      ],
      help: 'How much damage the code survives. The minimum: a short payload gets a higher level free where it costs no extra modules.' },
    { key: 'quiet', label: 'Quiet zone', type: 'int', def: 4, min: 1, max: 8, step: 1, unit: 'modules', group: 'Code',
      help: 'Blank margin around the code, in modules. The standard says 4; cameras cope with 2 but the frame must not crowd it.' },
    { key: 'style', label: 'Modules', type: 'enum', def: 'raised', group: 'Code',
      options: [
        { v: 'raised', label: 'Raised', help: 'Modules stand up from the plate. Dark filament from the plate height up.' },
        { v: 'recessed', label: 'Recessed', help: 'Modules are sunk into the plate. Light filament for the top layer, the dark floor shows through.' },
      ],
      help: 'Raised prints the modules in the second colour; recessed prints everything BUT the modules in it.' },
    { key: 'relief', label: 'Relief', type: 'number', def: 0.8, min: 0.2, max: 3, step: 0.1, unit: 'mm', group: 'Code',
      help: 'How far the modules stand up (or sink in). 0.8 mm is four layers: enough to catch the light, not enough to snag.' },

    { key: 'size', label: 'Width', type: 'number', def: 70, min: 30, max: 150, step: 1, unit: 'mm', group: 'Plaque',
      help: 'Across the plaque. The height follows: the same plus room for the caption and the hole. Bigger is easier to scan.' },
    { key: 'plate', label: 'Plate thickness', type: 'number', def: 2, min: 1.2, max: 6, step: 0.2, unit: 'mm', group: 'Plaque',
      help: 'The slab under the code. A multiple of your layer height puts the colour change on a clean layer.' },
    { key: 'corner', label: 'Corner radius', type: 'number', def: 4, min: 0, max: 20, step: 0.5, unit: 'mm', group: 'Plaque',
      help: 'Rounding on the plate corners. Zero is square.' },
    { key: 'frame', label: 'Frame', type: 'bool', def: true, group: 'Plaque',
      help: 'A raised border in the second colour around the edge.' },
    { key: 'frameWidth', label: 'Frame width', type: 'number', def: 2.5, min: 1, max: 8, step: 0.5, unit: 'mm', group: 'Plaque',
      showIf: (p) => !!p.frame, help: 'Width of the border. It sits outside the quiet zone, so a wide frame shrinks the code.' },

    { key: 'caption', label: 'Caption', type: 'text', def: 'Guest Wi-Fi', maxLength: 40, group: 'Caption',
      help: 'Letters under the code, in the second colour. Leave empty for none.' },
    { key: 'captionHeight', label: 'Letter height', type: 'number', def: 6, min: 3, max: 15, step: 0.5, unit: 'mm', group: 'Caption',
      showIf: (p) => !!String(p.caption ?? '').trim(),
      help: 'Cap height of the caption. Shrinks automatically if the line would overrun the plaque.' },
    { key: 'captionFont', label: 'Typeface', type: 'enum', def: DEFAULT_FONT, group: 'Caption',
      options: FONT_FILES.map(f => ({ v: f.id, label: f.label, help: f.help })),
      showIf: (p) => !!String(p.caption ?? '').trim(), help: 'The three faces bundled with Bluesheet.' },

    { key: 'hang', label: 'Hanging hole', type: 'bool', def: false, group: 'Mounting',
      help: 'A hole through the plate above the code, for a nail or a screw.' },
    { key: 'holeDia', label: 'Hole diameter', type: 'number', def: 4.5, min: 2, max: 8, step: 0.5, unit: 'mm', group: 'Mounting',
      showIf: (p) => !!p.hang, help: '4.5 mm clears a No. 8 screw head\'s shank; 6 mm hangs on a picture hook.' },
  ],
  presets: [
    { name: 'Guest Wi-Fi', values: {
      content: 'wifi', ssid: 'Guest WiFi', password: 'letmein123', security: 'WPA', hidden: false,
      ecc: 'M', size: 70, plate: 2, relief: 0.8, quiet: 4, style: 'raised', corner: 4, frame: true, frameWidth: 2.5,
      caption: 'Guest Wi-Fi', captionHeight: 6, captionFont: DEFAULT_FONT, hang: true, holeDia: 4.5 } },
    { name: 'Link coaster', values: {
      content: 'url', text: 'https://bluesheet.local/', ecc: 'Q', size: 90, plate: 3, relief: 0.6, quiet: 4,
      style: 'recessed', corner: 45, frame: false, caption: '', hang: false } },
    { name: 'Text tag', values: {
      content: 'text', text: 'M3 × 12 cap screws', ecc: 'L', size: 34, plate: 1.6, relief: 0.6, quiet: 2,
      style: 'raised', corner: 3, frame: true, frameWidth: 1.5, caption: 'M3 × 12', captionHeight: 4,
      captionFont: 'DejaVuSansMono', hang: true, holeDia: 3 } },
  ],
  build,
  validate,
  hints,
};
