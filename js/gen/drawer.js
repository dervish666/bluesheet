// Drawer and desk organisers — the generator that turns a tape measure into an
// object.
//
// The thing that makes a drawer insert hard is not the geometry, it is that the
// drawer is never a nice number. So the parameters here are the two numbers you
// actually measured plus a clearance, and everything else is derived from them.
//
// HOW THE SOLID IS BUILT
// ----------------------
// Not by cutting pockets out of a block. The cross-section of the material is a
// step function of height — it only ever loses area as you go up (a compartment
// floor opens, a wall chamfers away) — so the whole tray is a terraced prism.
// The builder walks a sorted list of z levels, emits the outer ring and every
// open compartment ring at each level, strips walls between consecutive levels,
// and drops a horizontal face in wherever a compartment's floor first appears.
// That is watertight by construction, exact in volume, and roughly twenty times
// faster than the same object through a mesh boolean. CSG is used for exactly
// one feature — the finger scoops — because a cylinder cut through a wall is a
// genuine topology change and it is what the escape hatch is for.
//
// SPLITTING
// ---------
// An organiser bigger than the 180 mm bed is divided into interlocking pieces.
// The seams are placed on compartment WALLS, never through a compartment, so
// each piece is a complete little tray rather than half of one. A seam wall is
// thickened to 2 x (joint depth + a wall) so the socket has material behind it,
// and the dovetail or dogbone profile is built straight into the piece outline
// — no boolean, no post-processing, and the two profiles are offset from one
// shared definition so they cannot drift apart.

import { Mesh } from '../kernel/mesh.js';
import { roundRect, reverse, triangulate, area } from '../kernel/poly2d.js';
import { cylinder } from '../kernel/builders.js';
import { subtractAll } from '../kernel/csg.js';
import { pack, layout as packLayout, A1_MINI_BED, DEFAULT_MARGIN } from '../kernel/pack.js';
import { clamp } from '../kernel/scalar.js';
import { FIT } from '../kernel/fit.js';

// A compartment narrower than this is not a compartment, it is a slot the
// nozzle cannot get into; the solver leaves the material there instead.
const MIN_CELL = 3;
// Flat left on top of a wall after the chamfers from both sides have eaten in.
const MIN_TOP = 0.4;
// Material left behind a joint socket, so the socket never breaks through.
const MIN_BACK = 1.2;
// Smallest plan corner radius any pocket is allowed; a printed inside corner
// carries the nozzle radius whatever the model says, so modelling it as sharp
// only ever makes the fit optimistic.
const MIN_POCKET_R = 0.4;
const EPS = 1e-9;

/** Largest outside corner radius the corner construction can build, per mm of wall. */
export const CORNER_R_PER_WALL = 2.5;

const SEP = ['.', '-', '_', ' '];

// ---------------------------------------------------------------------------
// Layout language
// ---------------------------------------------------------------------------

/**
 * Parse the little ASCII map that describes an arbitrary cell layout.
 *
 *   "aaab;ccdb|b=12 d=through"
 *
 * Rows separated by ';' (or newlines), one character per grid square, read as a
 * plan view with the FIRST row at the back of the drawer. Squares sharing a
 * letter are one compartment, so a letter repeated across two squares is a
 * compartment with a column span of two. '.' leaves that square out — no
 * compartment, the material stays solid. Everything after '|' is a legend of
 * per-compartment depths in millimetres measured down from the rim, or the word
 * `through` for a pass-through with no floor at all.
 *
 * Never throws: a letter whose squares do not form a rectangle is broken into
 * one compartment per square and noted, because a text field that erases your
 * work when you mistype one character is worse than one that guesses.
 */
export function parseLayout(text, { maxRows = 20, maxCols = 20 } = {}) {
  const raw = String(text ?? '');
  const bar = raw.indexOf('|');
  const mapPart = bar >= 0 ? raw.slice(0, bar) : raw;
  const legendPart = bar >= 0 ? raw.slice(bar + 1) : '';
  const notes = [];

  const depths = new Map();
  for (const tok of legendPart.split(/[\s,;]+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const id = tok.slice(0, eq).trim();
    const val = tok.slice(eq + 1).trim().toLowerCase();
    if (!id) continue;
    if (val === 'through' || val === 'thru' || val === 'open') depths.set(id, 'through');
    else {
      const n = Number(val);
      if (isFinite(n) && n > 0) depths.set(id, n);
    }
  }

  let lines = mapPart.split(/[;\n]/).map(s => s.trim()).filter(s => s.length);
  if (!lines.length) lines = ['a'];
  if (lines.length > maxRows) { lines = lines.slice(0, maxRows); notes.push(`layout truncated to ${maxRows} rows`); }
  let cols = 0;
  for (const l of lines) cols = Math.max(cols, l.length);
  if (cols > maxCols) { cols = maxCols; notes.push(`layout truncated to ${maxCols} columns`); }
  const rows = lines.length;

  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols).fill('.');
    for (let c = 0; c < cols; c++) {
      const ch = lines[r][c];
      row[c] = (ch === undefined || SEP.includes(ch)) ? '.' : ch;
    }
    grid.push(row);
  }

  // Group by id, in first-appearance order so the result is stable.
  const order = [];
  const seen = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = grid[r][c];
    if (id === '.') continue;
    if (!seen.has(id)) { seen.set(id, []); order.push(id); }
    seen.get(id).push([r, c]);
  }

  const cells = [];
  for (const id of order) {
    const at = seen.get(id);
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    for (const [r, c] of at) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    const boxed = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (boxed === at.length) {
      cells.push({ id, r0, r1, c0, c1, depth: depths.get(id) ?? null });
    } else {
      // Not a rectangle. One compartment per square rather than a silent lie
      // about what the user typed.
      notes.push(`"${id}" is not a rectangle — split into ${at.length} single squares`);
      for (const [r, c] of at) cells.push({ id, r0: r, r1: r, c0: c, c1: c, depth: depths.get(id) ?? null });
    }
  }
  return { rows, cols, cells, notes };
}

/**
 * Relative track sizes, e.g. "1,1,2" makes the last column twice as wide.
 * A shorter list repeats, so "1,2" on four columns alternates. Anything that is
 * not a positive number is ignored, and an empty result means equal tracks.
 */
export function parseWeights(text, n) {
  const parts = String(text ?? '').split(/[\s,;:]+/).filter(s => s.length);
  const nums = [];
  for (const p of parts) { const v = Number(p); if (isFinite(v) && v > 0) nums.push(v); }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = nums.length ? nums[i % nums.length] : 1;
  return out;
}

// ---------------------------------------------------------------------------
// Geometry solver — everything that can be decided without touching a triangle
// ---------------------------------------------------------------------------

/** How many equal cells of at least `minCell` fit, and what is left over. */
export function fillCount(inner, minCell, wall) {
  const n = Math.max(1, Math.floor((inner + wall) / (minCell + wall)));
  const leftover = inner - (n * minCell + (n - 1) * wall);
  const cell = (inner - (n - 1) * wall) / n;
  return { n, leftover, cell };
}

/** Divide `total` into `count` tracks separated by the given boundary walls. */
function tracks(total, count, weights, wx) {
  let sum = 0;
  for (const w of wx) sum += w;
  const free = total - sum;
  let wsum = 0;
  for (let i = 0; i < count; i++) wsum += weights[i];
  const size = new Array(count);
  for (let i = 0; i < count; i++) size[i] = free * (weights[i] / wsum);
  const start = new Array(count), end = new Array(count);
  let x = 0;
  for (let i = 0; i < count; i++) { x += wx[i]; start[i] = x; x += size[i]; end[i] = x; }
  return { size, start, end, free, used: sum };
}

/** Boundaries that some compartment edge lands on, and so must carry a wall. */
function usedBoundaries(count, cells, lo, hi) {
  const used = new Array(count + 1).fill(false);
  used[0] = true; used[count] = true;
  for (const c of cells) { used[c[lo]] = true; used[c[hi] + 1] = true; }
  return used;
}

/** Interior boundaries no compartment straddles — the only legal seam sites. */
function seamCandidates(count, cells, lo, hi) {
  const straddled = new Set();
  for (const c of cells) for (let j = c[lo] + 1; j <= c[hi]; j++) straddled.add(j);
  const out = [];
  for (let j = 1; j < count; j++) if (!straddled.has(j)) out.push(j);
  return out;
}

/** Spread `want` seams as evenly as possible through the candidate list. */
function chooseSeams(cand, want) {
  const chosen = [];
  const k = Math.min(want, cand.length);
  for (let i = 1; i <= k; i++) {
    let idx = Math.round((i * (cand.length + 1)) / (k + 1)) - 1;
    idx = clamp(idx, 0, cand.length - 1);
    let step = 0;
    while (chosen.includes(cand[idx]) && step < cand.length) {
      idx = (idx + 1) % cand.length; step++;
    }
    if (!chosen.includes(cand[idx])) chosen.push(cand[idx]);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Turn the parameters into a complete plan: outer size, grid, compartments,
 * pieces, seams and joints. Pure, cheap, and the single source of truth that
 * both the mesh builder and the reported metadata read from.
 */
export function solve(p, ctx = {}) {
  const segFactor = ctx.segFactor || 1;
  const bed = ctx.bed || A1_MINI_BED;
  const notes = [];

  const clearance = clamp(Number(p.clearance) || 0, 0, 10);
  const drawerW = clamp(Number(p.drawerW) || 0, 5, 2000);
  const drawerD = clamp(Number(p.drawerD) || 0, 5, 2000);
  const W = Math.max(6, drawerW - 2 * clearance);
  const D = Math.max(6, drawerD - 2 * clearance);
  const H = clamp(Number(p.height) || 0, 3, bed.z);

  const wallT = clamp(Number(p.wallT) || 0.8, 0.4, 10);
  const floorT = p.bottom === 'open' ? 0 : clamp(Number(p.floorT) || 0.6, 0.4, Math.max(0.4, H * 0.5));
  const openBottom = p.bottom === 'open';

  // ---- the grid ----------------------------------------------------------
  let rows, cols, rawCells, fill = null;
  if (p.layoutMode === 'custom') {
    const L = parseLayout(p.layout);
    rows = L.rows; cols = L.cols; rawCells = L.cells;
    for (const n of L.notes) notes.push(n);
  } else if (p.layoutMode === 'fill') {
    const minCell = clamp(Number(p.minCell) || 10, 3, 500);
    const fx = fillCount(Math.max(0.01, W - 2 * wallT), minCell, wallT);
    const fy = fillCount(Math.max(0.01, D - 2 * wallT), minCell, wallT);
    cols = fx.n; rows = fy.n;
    fill = {
      minCell,
      innerW: W - 2 * wallT, innerD: D - 2 * wallT,
      cols: fx.n, rows: fy.n,
      cellW: fx.cell, cellD: fy.cell,
      leftoverX: fx.leftover, leftoverY: fy.leftover,
    };
    rawCells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) rawCells.push({ id: `${r}${c}`, r0: r, r1: r, c0: c, c1: c, depth: null });
  } else {
    rows = clamp(Math.round(Number(p.rows) || 1), 1, 20);
    cols = clamp(Math.round(Math.max(1, Number(p.cols) || 1)), 1, 20);
    rawCells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) rawCells.push({ id: `${r}${c}`, r0: r, r1: r, c0: c, c1: c, depth: null });
  }

  const colW = parseWeights(p.layoutMode === 'grid' ? p.colWeights : '', cols);
  const rowW = parseWeights(p.layoutMode === 'grid' ? p.rowWeights : '', rows);

  // ---- splitting ---------------------------------------------------------
  const joint = ['dovetail', 'dogbone', 'butt'].includes(p.joint) ? p.joint : 'dovetail';
  const jointFit = clamp(Number(p.jointFit) ?? 0.15, 0, 1);
  const jointDepth = clamp(Number(p.jointDepth) || 1, 0.6, 12);
  const seamWall = joint === 'butt'
    ? Math.max(wallT, 2.4)
    : Math.max(wallT, 2 * (jointDepth + Math.max(MIN_BACK, wallT)));

  const candX = seamCandidates(cols, rawCells, 'c0', 'c1');
  const candY = seamCandidates(rows, rawCells, 'r0', 'r1');
  const usedX = usedBoundaries(cols, rawCells, 'c0', 'c1');
  const usedY = usedBoundaries(rows, rawCells, 'r0', 'r1');

  let nx = clamp(Math.round(Number(p.splitX) || 1), 1, candX.length + 1);
  let ny = clamp(Math.round(Math.max(1, Number(p.splitY) || 1)), 1, candY.length + 1);
  const usable = { x: bed.x - 2 * DEFAULT_MARGIN, y: bed.y - 2 * DEFAULT_MARGIN };

  const buildAxis = (total, count, weights, used, cand, want, extraOut) => {
    // Seams eat width; if they leave nothing to divide, back off one seam at a
    // time rather than emitting a tray with negative compartments.
    let n = want;
    for (;;) {
      const seams = chooseSeams(cand, n - 1);
      const wx = new Array(count + 1).fill(0);
      wx[0] = wallT; wx[count] = wallT;
      for (let j = 1; j < count; j++) wx[j] = used[j] ? wallT : 0;
      for (const j of seams) wx[j] = seamWall;
      const t = tracks(total, count, weights, wx);
      if (t.free > count * MIN_CELL || n <= 1) { extraOut.seams = seams; extraOut.wx = wx; return t; }
      n--;
    }
  };

  let ex = {}, ey = {}, tx, ty, pieces;
  for (let guard = 0; guard < 12; guard++) {
    tx = buildAxis(W, cols, colW, usedX, candX, nx, ex);
    ty = buildAxis(D, rows, rowW, usedY, candY, ny, ey);
    const seamX = ex.seams, seamY = ey.seams;
    // Piece extents, in grid-boundary terms.
    const bandsX = bands(cols, seamX), bandsY = bands(rows, seamY);
    const wMax = Math.max(...bandsX.map(b => pieceSpan(b, tx, ex.wx, W)));
    const dMax = Math.max(...bandsY.map(b => pieceSpan(b, ty, ey.wx, D)));
    const needX = p.autoSplit !== false && wMax > usable.x && (nx < candX.length + 1);
    const needY = p.autoSplit !== false && dMax > usable.y && (ny < candY.length + 1);
    if (!needX && !needY) { pieces = { bandsX, bandsY }; break; }
    if (needX) nx++;
    if (needY) ny++;
    pieces = { bandsX, bandsY };
  }
  const seamX = ex.seams, seamY = ey.seams;
  const wx = ex.wx, wy = ey.wx;

  // ---- absolute coordinates ---------------------------------------------
  // X runs left to right. Y runs front (-D/2) to back (+D/2), and the layout's
  // first text row is the BACK row, which is how a plan view reads.
  const colX0 = new Array(cols), colX1 = new Array(cols);
  for (let c = 0; c < cols; c++) { colX0[c] = -W / 2 + tx.start[c]; colX1[c] = -W / 2 + tx.end[c]; }
  const rowY1 = new Array(rows), rowY0 = new Array(rows);
  for (let r = 0; r < rows; r++) { rowY1[r] = D / 2 - ty.start[r]; rowY0[r] = D / 2 - ty.end[r]; }
  const seamXpos = seamX.map(j => -W / 2 + tx.end[j - 1] + wx[j] / 2);
  const seamYpos = seamY.map(j => D / 2 - ty.end[j - 1] - wy[j] / 2);

  // ---- compartments ------------------------------------------------------
  const chamferReq = clamp(Number(p.topChamfer) || 0, 0, 10);
  const defaultDepth = Number(p.cellDepth) || 0;
  const maxDepth = Math.max(1, H - floorT);
  const cells = [];
  for (const rc of rawCells) {
    const x0 = colX0[rc.c0], x1 = colX1[rc.c1];
    const y0 = rowY0[rc.r1], y1 = rowY1[rc.r0];
    const cw = x1 - x0, cd = y1 - y0;
    if (!(cw >= MIN_CELL && cd >= MIN_CELL)) continue;      // too small to cut
    const through = openBottom || rc.depth === 'through';
    let depth;
    if (through) depth = H;
    else {
      const want = typeof rc.depth === 'number' ? rc.depth : (defaultDepth > 0 ? defaultDepth : maxDepth);
      depth = clamp(want, 1, maxDepth);
    }
    cells.push({
      id: rc.id, r0: rc.r0, r1: rc.r1, c0: rc.c0, c1: rc.c1,
      x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: cw, d: cd,
      depth, floorZ: through ? 0 : H - depth, through,
      front: rc.r1 === rows - 1,
    });
  }

  // ---- chamfer, radii ----------------------------------------------------
  let minCellDim = Infinity, minDepth = Infinity;
  for (const c of cells) { minCellDim = Math.min(minCellDim, c.w, c.d); minDepth = Math.min(minDepth, c.depth); }
  let chamfer = chamferReq;
  chamfer = Math.min(chamfer, Math.max(0, (wallT - MIN_TOP) / 2));
  if (cells.length) chamfer = Math.min(chamfer, minCellDim / 4, minDepth * 0.45);
  chamfer = clamp(chamfer, 0, H * 0.3);
  if (chamfer < 0.05) chamfer = 0;

  let cornerR = clamp(Number(p.cornerR) || 0, 0, 200);
  if (cornerR > 0.05) {
    cornerR = clamp(Math.max(cornerR, chamfer + 0.5), 0.05, Math.min(W, D) / 2 - 0.1);
    // Measured limit, not a guess: above 2.5x the wall thickness the corner
    // construction produces a self-intersecting inner offset and the result is
    // not a solid at all — 148 open edges and triple the volume at the extreme.
    // The ratio held exactly across wall thicknesses of 1.6, 2.4, 3.2 and 4.8 mm.
    // Clamping here turns a silently broken mesh into a stated limit; validate()
    // tells the person why their number moved.
    cornerR = Math.min(cornerR, CORNER_R_PER_WALL * wallT);
  } else cornerR = 0;

  const bottomR = clamp(Number(p.bottomR) || 0, 0, 30);
  const cellRReq = clamp(Number(p.cellR) || 0, 0, 30);
  for (const c of cells) {
    let rf = c.through ? 0 : bottomR;
    rf = Math.min(rf, c.w / 2 - 0.45, c.d / 2 - 0.45, c.depth * 0.45, Math.max(0, c.depth - chamfer - 0.2));
    c.rf = Math.max(0, rf);
    const rMin = Math.max(MIN_POCKET_R, c.rf + 0.4);
    const rMax = Math.min(c.w, c.d) / 2 - 0.05;
    c.cr = clamp(Math.max(cellRReq, rMin), Math.min(rMin, rMax), rMax);
  }

  // ---- pieces ------------------------------------------------------------
  const bandsX = pieces.bandsX, bandsY = pieces.bandsY;
  const xEdges = [-W / 2, ...seamXpos, W / 2];
  const yEdgesBack = [D / 2, ...seamYpos, -D / 2];   // descending y, band order
  const list = [];
  for (let j = 0; j < bandsY.length; j++) {
    for (let i = 0; i < bandsX.length; i++) {
      const xa = xEdges[i], xb = xEdges[i + 1];
      const yb = yEdgesBack[j], ya = yEdgesBack[j + 1];
      const bx = bandsX[i], by = bandsY[j];
      const mine = cells.filter(c => c.c0 >= bx[0] && c.c1 <= bx[1] && c.r0 >= by[0] && c.r1 <= by[1]);
      list.push({
        name: bandsX.length * bandsY.length === 1 ? 'Organiser'
          : `Piece ${String.fromCharCode(65 + j)}${i + 1}`,
        ix: i, iy: j, xa, xb, ya, yb, cells: mine, bandX: bx, bandY: by,
        // Lower coordinate carries the tenons; its neighbour carries the socket.
        sides: [
          j < bandsY.length - 1 ? { mode: 'socket', axis: 'y' } : null,   // front (-Y)
          i < bandsX.length - 1 ? { mode: 'tenon', axis: 'x' } : null,    // right (+X)
          j > 0 ? { mode: 'tenon', axis: 'y' } : null,                    // back (+Y)
          i > 0 ? { mode: 'socket', axis: 'x' } : null,                    // left (-X)
        ],
      });
    }
  }

  // Joint features live in world coordinates on the seam so that both sides of
  // a seam are generated from one definition — the commonest way a printed
  // joint comes out non-complementary is two nearly-identical code paths.
  const flare = joint === 'dovetail' ? jointDepth * Math.tan(clamp(Number(p.jointAngle) || 10, 1, 40) * Math.PI / 180) : 0;
  const jointCount = clamp(Math.round(Number(p.jointCount) || 1), 1, 10);
  const relief = joint === 'dogbone' ? jointFit + 0.5 : 0;
  const jointDef = { joint, fit: jointFit, depth: jointDepth, flare, relief, angle: Math.atan2(flare, jointDepth) };

  for (const pc of list) {
    pc.sideFeats = [null, null, null, null];
    for (let s = 0; s < 4; s++) {
      const side = pc.sides[s];
      if (!side) continue;
      const along = side.axis === 'x' ? (pc.yb - pc.ya) : (pc.xb - pc.xa);
      const origin = side.axis === 'x' ? pc.ya : pc.xa;
      const feats = spaceJoints(along, jointCount, jointDef).map(f => ({ ...f, world: origin + f.u }));
      pc.sideFeats[s] = feats;
    }
  }

  const cornerSegs = Math.max(2, Math.round(6 * segFactor));
  let cellSegs = Math.max(2, Math.round(6 * segFactor));
  if (cells.length > 40) cellSegs = Math.max(2, Math.round(cellSegs / 2));
  let filletSteps = Math.max(1, Math.round(3 * segFactor));
  const distinctFloors = new Set(cells.map(c => Math.round(c.floorZ * 1000))).size;
  while (filletSteps > 1 && distinctFloors * filletSteps > 24) filletSteps--;

  const outerArea = area(roundRect(W, D, cornerR, { segs: cornerSegs }));
  let cellArea = 0;
  for (const c of cells) cellArea += area(roundRect(c.w, c.d, c.cr, { segs: cellSegs }));

  return {
    W, D, H, wallT, floorT, openBottom, clearance, drawerW, drawerD,
    rows, cols, cells, fill, notes,
    chamfer, cornerR, bottomR, cornerSegs, cellSegs, filletSteps,
    tx, ty, wx, wy, seamX, seamY, seamXpos, seamYpos, seamWall,
    pieces: list, jointDef, bandsX, bandsY, bed,
    scoops: p.scoops !== false, scoopDepth: Number(p.scoopDepth) || 0, scoopWidth: Number(p.scoopWidth) || 0,
    areas: { outer: outerArea, cells: cellArea, walls: outerArea - cellArea },
    segFactor,
  };
}

function bands(count, seams) {
  const out = [];
  let start = 0;
  for (const j of seams) { out.push([start, j - 1]); start = j; }
  out.push([start, count - 1]);
  return out;
}

function pieceSpan(band, t, wxArr, total) {
  const lo = band[0] === 0 ? 0 : t.start[band[0]] - wxArr[band[0]] / 2;
  const hi = band[1] === t.size.length - 1 ? total : t.end[band[1]] + wxArr[band[1] + 1] / 2;
  return hi - lo;
}

/** Evenly spaced joint features along a seam, backed off until they are sane. */
function spaceJoints(len, want, def) {
  if (def.joint === 'butt') return [];
  for (let n = Math.max(1, want); n >= 1; n--) {
    const pitch = len / n;
    const w = Math.min(pitch * 0.5, pitch - 3);
    const wRoot = w - 2 * def.flare;
    if (w > 0 && wRoot >= 1.6 && pitch - w >= 2.4) {
      const out = [];
      for (let k = 0; k < n; k++) out.push({ u: (k + 0.5) * pitch, w, wRoot, depth: def.depth });
      return out;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Joint profiles
// ---------------------------------------------------------------------------

function lineIntersect(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return [q[0], q[1]];
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/** The tenon outline in side-local (u along the seam, v outward) coordinates. */
export function tenonProfile(f) {
  return [
    [-f.wRoot / 2, 0], [-f.w / 2, f.depth], [f.w / 2, f.depth], [f.wRoot / 2, 0],
  ];
}

/**
 * The socket that receives it: every face of the tenon pushed out by the fit
 * clearance along its own normal, so the gap is `fit` measured perpendicular to
 * each face rather than `fit` measured along an axis — which for a dovetail
 * flank are not the same number, and getting that wrong is how a joint ends up
 * either loose at the tip or impossible at the root.
 */
export function socketProfile(f, def) {
  const t = tenonProfile(f);
  const fit = def.fit;
  const lines = [];
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i], b = t[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;              // away from the tenon body
    lines.push({ p: [a[0] + nx * fit, a[1] + ny * fit], d: [dx, dy] });
  }
  const root = { d: [1, 0] };
  const q0 = lineIntersect(lines[0].p, lines[0].d, [0, 0], root.d);
  const q1 = lineIntersect(lines[0].p, lines[0].d, lines[1].p, lines[1].d);
  const q2 = lineIntersect(lines[1].p, lines[1].d, lines[2].p, lines[2].d);
  const q3 = lineIntersect(lines[2].p, lines[2].d, [0, 0], root.d);
  let pts = [q0, q1, q2, q3];
  if (def.relief > 0) {
    const halfW = Math.abs(q1[0] - q2[0]) / 2, deep = Math.abs(q1[1]);
    const rel = Math.min(def.relief, halfW / 2.9, deep / 2.9);
    if (rel > 0.15) {
      const arcAt = (corner, din, dout, segs) => {
        const bx = dout[0] - din[0], by = dout[1] - din[1];
        const bl = Math.hypot(bx, by) || 1;
        const cx = corner[0] + rel * bx / bl, cy = corner[1] + rel * by / bl;
        const sx = -din[0] - dout[0], sy = -din[1] - dout[1];
        const a0 = Math.atan2(sy, sx);
        const out = [];
        for (let k = 0; k <= segs; k++) out.push([cx + rel * Math.cos(a0 + Math.PI * k / segs), cy + rel * Math.sin(a0 + Math.PI * k / segs)]);
        return out;
      };
      const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
      const segs = 4;
      pts = [q0,
        ...arcAt(q1, unit(q0, q1), unit(q1, q2), segs),
        ...arcAt(q2, unit(q1, q2), unit(q2, q3), segs),
        q3];
    }
  }
  return pts.map(q => [q[0], -q[1]]);            // a socket goes in, not out
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

function dedupeRing(pts, eps = 1e-7) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps) out.push([p[0], p[1]]);
  }
  while (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop(); else break;
  }
  return out;
}

/**
 * Pre-compute a per-vertex miter direction so the same ring can be offset to
 * any inset with its vertex count and correspondence untouched — which is what
 * lets a 45 degree chamfer band be a single quad strip instead of a boolean.
 */
function ringTemplate(pts) {
  const n = pts.length;
  const dirs = new Array(n);
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; };
  for (let i = 0; i < n; i++) {
    const n1 = nrm(pts[(i - 1 + n) % n], pts[i]);
    const n2 = nrm(pts[i], pts[(i + 1) % n]);
    let dx = n1[0] + n2[0], dy = n1[1] + n2[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) { dirs[i] = [n2[0], n2[1]]; continue; }
    dx /= l; dy /= l;
    const s = Math.max(0.4, dx * n1[0] + dy * n1[1]);   // cap the miter at 2.5x
    dirs[i] = [dx / s, dy / s];
  }
  return { pts, dirs };
}

function insetTemplate(tpl, t) {
  if (Math.abs(t) < 1e-12) return tpl.pts.map(p => [p[0], p[1]]);
  return tpl.pts.map((p, i) => [p[0] + tpl.dirs[i][0] * t, p[1] + tpl.dirs[i][1] * t]);
}

/** The outline of one piece: rounded where it is an outside edge, jointed where it is a seam. */
function pieceOuterRing(pc, g) {
  const V = [[pc.xa, pc.ya], [pc.xb, pc.ya], [pc.xb, pc.yb], [pc.xa, pc.yb]];
  const T = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const N = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const L = [pc.xb - pc.xa, pc.yb - pc.ya, pc.xb - pc.xa, pc.yb - pc.ya];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const prev = (i + 3) % 4;
    const plain = !pc.sides[prev] && !pc.sides[i];
    const r = plain ? Math.min(g.cornerR, L[prev] / 2 - 0.05, L[i] / 2 - 0.05) : 0;
    if (r > 0.05) {
      const cx = V[i][0] + r * (T[i][0] - N[i][0]);
      const cy = V[i][1] + r * (T[i][1] - N[i][1]);
      const a0 = Math.atan2(N[prev][1], N[prev][0]);
      for (let k = 0; k <= g.cornerSegs; k++) {
        const a = a0 + (Math.PI / 2) * (k / g.cornerSegs);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    } else {
      out.push([V[i][0], V[i][1]]);
    }
    const side = pc.sides[i];
    const feats = pc.sideFeats[i];
    if (side && feats && feats.length) {
      const ordered = feats
        .map(f => ({ f, u: (f.world - (side.axis === 'x' ? pc.ya : pc.xa)) * ((side.axis === 'x' ? T[i][1] : T[i][0]) > 0 ? 1 : -1) + ((side.axis === 'x' ? T[i][1] : T[i][0]) > 0 ? 0 : L[i]) }))
        .sort((a, b) => a.u - b.u);
      for (const { f, u } of ordered) {
        const prof = side.mode === 'tenon' ? tenonProfile(f) : socketProfile(f, g.jointDef);
        for (const [du, dv] of prof) {
          const uu = u + du;
          out.push([V[i][0] + T[i][0] * uu + N[i][0] * dv, V[i][1] + T[i][1] * uu + N[i][1] * dv]);
        }
      }
    }
  }
  return dedupeRing(out);
}

/** A compartment's opening at a given inset (positive shrinks it). */
function cellRingAt(c, t, segs) {
  const w = Math.max(0.4, c.w - 2 * t);
  const d = Math.max(0.4, c.d - 2 * t);
  const r = clamp(c.cr - t, 0.2, Math.min(w, d) / 2 - 0.05);
  return roundRect(w, d, r, { segs, cx: c.cx, cy: c.cy });
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

function addRing(m, ring, z) {
  const idx = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) idx[i] = m.addVertex(ring[i][0], ring[i][1], z);
  return idx;
}

function strip(m, lo, hi, outward) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (outward) m.addQuad(lo[i], lo[j], hi[j], hi[i]);
    else m.addQuad(lo[j], lo[i], hi[i], hi[j]);
  }
}

function addCap(m, shape, z, up) {
  const t = triangulate(shape);
  const base = m.vertCount;
  for (const p of t.points) m.addVertex(p[0], p[1], z);
  for (let i = 0; i < t.tris.length; i += 3) {
    if (up) m.addTri(base + t.tris[i], base + t.tris[i + 1], base + t.tris[i + 2]);
    else m.addTri(base + t.tris[i], base + t.tris[i + 2], base + t.tris[i + 1]);
  }
}

function buildPieceMesh(pc, g) {
  const H = g.H, c = g.chamfer;
  const tpl = ringTemplate(pieceOuterRing(pc, g));
  const cells = pc.cells;

  const raw = [0, H];
  if (c > 1e-6) raw.push(H - c);
  for (const cl of cells) {
    if (cl.through) continue;
    raw.push(cl.floorZ);
    if (cl.rf > 1e-6) {
      for (let k = 1; k <= g.filletSteps; k++) {
        const phi = (Math.PI / 2) * (1 - k / g.filletSteps);
        raw.push(cl.floorZ + cl.rf * (1 - Math.sin(phi)));
      }
    }
  }
  const zs = [];
  for (const z of raw.sort((a, b) => a - b)) {
    if (z < -1e-9 || z > H + 1e-9) continue;
    if (!zs.length || z - zs[zs.length - 1] > 1e-4) zs.push(z);
  }
  zs[0] = 0;
  zs[zs.length - 1] = H;

  const grow = (z) => (c > 0 && z > H - c ? z - (H - c) : 0);
  const filletInset = (cl, z) => {
    if (cl.rf <= 1e-9) return 0;
    const u = cl.floorZ + cl.rf - z;
    if (u <= 0) return 0;
    return cl.rf - Math.sqrt(Math.max(0, cl.rf * cl.rf - u * u));
  };

  const m = new Mesh();
  let prevOuter = null;
  let prevCells = new Map();
  for (let li = 0; li < zs.length; li++) {
    const z = zs[li];
    const oRing = insetTemplate(tpl, grow(z));
    const oIdx = addRing(m, oRing, z);
    const active = [];
    for (const cl of cells) if (z >= cl.floorZ - 1e-9) active.push(cl);
    const rings = new Map(), idxs = new Map();
    for (const cl of active) {
      const ring = cellRingAt(cl, filletInset(cl, z) - grow(z), g.cellSegs);
      rings.set(cl, ring);
      idxs.set(cl, addRing(m, ring, z));
    }
    if (li === 0) {
      addCap(m, [oRing, ...active.map(cl => reverse(rings.get(cl)))], z, false);
    } else {
      strip(m, prevOuter, oIdx, true);
      for (const cl of active) {
        if (prevCells.has(cl)) strip(m, prevCells.get(cl), idxs.get(cl), false);
        else addCap(m, [rings.get(cl)], z, true);       // this compartment's floor
      }
    }
    if (li === zs.length - 1) {
      addCap(m, [oRing, ...active.map(cl => reverse(rings.get(cl)))], z, true);
    }
    prevOuter = oIdx;
    prevCells = idxs;
  }
  return m;
}

/**
 * Finger scoops. A cylinder lying along Y, tangent nowhere, cutting down
 * through the front wall from the rim — the one place a boolean earns its cost,
 * because a notch that breaks a wall open genuinely changes the topology of
 * every cross-section it passes through.
 */
function scoopSpec(pc, g, cl) {
  if (!g.scoops) return null;
  const isFront = Math.abs(pc.ya - (-g.D / 2)) < 1e-6;
  if (!isFront || !cl.front) return null;
  let s = Math.min(g.scoopDepth, cl.depth - 1.2, g.H - 1.2);
  if (g.chamfer > 0 && Math.abs(s - g.chamfer) < 0.05) s += 0.1;   // never land on a face plane
  const w = Math.min(g.scoopWidth, cl.w - 2, g.W - 2 * g.wallT - 2);
  if (!(s > 0.8) || !(w > 2)) return null;
  const R = (w * w / 4 + s * s) / (2 * s);
  const y0 = pc.ya - 1.0;
  const y1 = cl.y0 + 1.5;
  if (y1 - y0 < 0.8) return null;
  return { s, w, R, y0, y1 };
}

function scoopCutters(pc, g) {
  const out = [];
  for (const cl of pc.cells) {
    const sp = scoopSpec(pc, g, cl);
    if (!sp) continue;
    const { s, R, y0, y1 } = sp;
    const segs = clamp(Math.round(R * 4 * g.segFactor), 16, 96);
    out.push(cylinder(R, y1 - y0, { segments: segs })
      .rotateX(-Math.PI / 2)
      .translate(cl.cx, y0, g.H + R - s));
  }
  return out;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function buildAll(p, ctx) {
  const g = solve(p, ctx);
  const parts = [];
  for (const pc of g.pieces) {
    let mesh = buildPieceMesh(pc, g);
    const cutters = scoopCutters(pc, g);
    if (cutters.length) mesh = subtractAll(mesh, cutters);
    const bb = mesh.bbox();
    parts.push({
      name: pc.name, piece: pc, mesh,
      centre: [(pc.xa + pc.xb) / 2, (pc.ya + pc.yb) / 2],
      size: [bb.size[0], bb.size[1], bb.size[2]],
    });
  }
  return { g, parts };
}

function arrangeParts(g, parts, mode) {
  // Every move a piece makes on its way to the plate is recorded, so a
  // dimension callout drawn in a piece's own coordinates can be carried to
  // exactly where that piece ended up — rotated, packed and re-centred.
  const base = parts.map(pt => { const b = pt.mesh.bbox(); return { x: -b.center[0], y: -b.center[1], z: -b.min[2] }; });
  const centred = parts.map(pt => pt.mesh.centerXY().dropToPlate());
  const placer = (moves, fin) => ({
    place: (i, q) => {
      const b = base[i], mv = moves[i];
      let x = q[0] + b.x, y = q[1] + b.y;
      const z = q[2] + b.z + fin.z;
      if (mv.rot) { const t = x; x = -y; y = t; }
      return [x + mv.x + fin.x, y + mv.y + fin.y, z];
    },
    placeDir: (i, v) => (moves[i].rot ? [-v[1], v[0], v[2]] : v.slice()),
  });
  const finish = (mesh, moves, plates, unplaced) => {
    const b = mesh.bbox();
    return { mesh: mesh.centerXY().dropToPlate(), plates, unplaced, ...placer(moves, { x: -b.center[0], y: -b.center[1], z: -b.min[2] }) };
  };
  if (parts.length === 1) return { mesh: centred[0], plates: 1, unplaced: 0, ...placer([{ rot: 0, x: 0, y: 0 }], { x: 0, y: 0, z: 0 }) };
  if (mode === 'assembled') {
    const gap = Math.max(0.2, g.jointDef.fit);
    const nx = g.bandsX.length, ny = g.bandsY.length;
    const moves = parts.map(pt => ({ rot: 0,
      x: pt.centre[0] + (pt.piece.ix - (nx - 1) / 2) * gap,
      y: pt.centre[1] + ((ny - 1) / 2 - pt.piece.iy) * gap }));
    const placed = parts.map((pt, i) => centred[i].translate(moves[i].x, moves[i].y, 0));
    return finish(Mesh.merge(placed), moves, 1, 0);
  }
  const items = parts.map((pt, i) => ({ id: `p${i}`, w: pt.size[0], d: pt.size[1] }));
  const packing = pack(items, g.bed, { gap: 3, margin: DEFAULT_MARGIN });
  const byId = {};
  parts.forEach((pt, i) => { byId[`p${i}`] = centred[i]; });
  const laid = packLayout(byId, packing);
  const moves = parts.map(() => ({ rot: 0, x: 0, y: 0 }));
  for (const pl of packing.placed) moves[Number(pl.id.slice(1))] = { rot: pl.rot ? 1 : 0, x: pl.x, y: pl.y };
  const extra = [];
  // Anything that did not fit goes in a row behind the plate rather than being
  // dropped: a preview that silently loses a piece is worse than an honest mess.
  let ox = -g.bed.x / 2;
  for (const u of packing.unplaced) {
    const i = Number(u.id.slice(1));
    moves[i] = { rot: 0, x: ox + parts[i].size[0] / 2, y: g.bed.y / 2 + 5 + parts[i].size[1] / 2 };
    extra.push(centred[i].translate(moves[i].x, moves[i].y, 0));
    ox += parts[i].size[0] + 4;
  }
  const all = [laid.mesh, ...extra].filter(mm => mm && mm.triCount);
  return finish(Mesh.merge(all), moves, packing.unplaced.length ? 2 : 1, packing.unplaced.length);
}

// ---------------------------------------------------------------------------
// Dimension callouts
//
// Drawn in a piece's own (world) coordinates and then carried through the same
// moves the piece made to the plate. Features are taken from the front-right
// piece where they can be, because that is the corner the default view looks
// at; the wall is measured on the left wall, whose inner face the view can see.
// Anything solve() clamped carries the built figure as `value`.
// ---------------------------------------------------------------------------

function drawerDims(p, g, arranged) {
  const dims = [];
  const seen = new Set();
  const K = Math.SQRT1_2;
  const H = g.H, c = g.chamfer, zTop = H - c;
  const asked = (key, def) => { const v = Number(p[key]); return Number.isFinite(v) ? v : def; };
  const push = (i, param, label, from, to, actual, want, offset) => {
    if (seen.has(param)) return;
    seen.add(param);
    const d = { param, label, from: arranged.place(i, from), to: arranged.place(i, to),
      offset: Array.isArray(offset) ? arranged.placeDir(i, offset) : offset };
    if (Math.abs(actual - want) > 1e-9) d.value = actual;
    dims.push(d);
  };
  const order = g.pieces.map((pc, i) => ({ pc, i }))
    .sort((a, b) => (b.pc.iy - a.pc.iy) || (b.pc.ix - a.pc.ix));

  for (const { pc, i } of order) {
    const isFront = Math.abs(pc.ya + g.D / 2) < 1e-6;
    const isRight = Math.abs(pc.xb - g.W / 2) < 1e-6;
    const isLeft = Math.abs(pc.xa + g.W / 2) < 1e-6;
    const yMid = (pc.ya + pc.yb) / 2;
    const cells = pc.cells;
    const solidCells = cells.filter(cl => !cl.through);

    if (isLeft) {
      const cl = cells.find(q => q.c0 === 0);
      if (cl) push(i, 'wallT', 'wall', [pc.xa, cl.cy, zTop], [cl.x0, cl.cy, zTop], cl.x0 - pc.xa, asked('wallT', 0.8), 8);
    }
    if (!g.openBottom && solidCells.length) {
      const cl = solidCells.reduce((a, b) => (b.floorZ < a.floorZ ? b : a));
      push(i, 'floorT', 'floor', [cl.cx, pc.ya, 0], [cl.cx, pc.ya, cl.floorZ], cl.floorZ, asked('floorT', 0.6), [0, -6, 0]);
    }
    if (isRight && g.clearance > 0) {
      push(i, 'clearance', 'clearance', [pc.xb, yMid, zTop], [pc.xb + g.clearance, yMid, zTop], g.clearance, asked('clearance', 0), 8);
    }
    if (isRight && c > 0) {
      push(i, 'topChamfer', 'chamfer', [pc.xb, yMid, H - c], [pc.xb, yMid, H], c, asked('topChamfer', 0), [6, 0, 0]);
    }
    if (isFront && isRight && g.cornerR > 0 && !pc.sides[0] && !pc.sides[1]) {
      const r = Math.min(g.cornerR, (pc.xb - pc.xa) / 2 - 0.05, (pc.yb - pc.ya) / 2 - 0.05);
      if (r > 0.05) {
        const cx = pc.xb - r, cy = pc.ya + r;
        push(i, 'cornerR', 'R', [cx, cy, zTop], [cx + r * K, cy - r * K, zTop], r, asked('cornerR', 0), 8);
      }
    }
    if (cells.length) {
      // The compartment's back-left corner: both faces meeting there look at the camera.
      const cl = cells[0], r = cl.cr;
      const cx = cl.x0 + r, cy = cl.y1 - r;
      push(i, 'cellR', 'R', [cx, cy, zTop], [cx - r * K, cy + r * K, zTop], r, asked('cellR', 0), 8);
    }
    const fc = solidCells.find(q => q.rf > 1e-6);
    if (fc) {
      const r = fc.rf, cx = fc.x0 + r, cz = fc.floorZ + r;
      push(i, 'bottomR', 'R', [cx, fc.cy, cz], [cx - r * K, fc.cy, cz - r * K], r, asked('bottomR', 0), 8);
    }
    const wantDepth = Number(p.cellDepth) || 0;
    if (wantDepth > 0) {
      const dep = clamp(wantDepth, 1, Math.max(1, H - g.floorT));
      const cl = solidCells.find(q => Math.abs(q.depth - dep) < 1e-9);
      if (cl) push(i, 'cellDepth', 'depth', [cl.x0 + cl.rf, cl.cy, cl.floorZ], [cl.x0 + cl.rf, cl.cy, H], cl.depth, wantDepth, 8);
    }
    for (const cl of cells) {
      const sp = scoopSpec(pc, g, cl);
      if (!sp) continue;
      push(i, 'scoopDepth', 'scoop', [cl.cx, pc.ya, H - sp.s], [cl.cx, pc.ya, H], sp.s, asked('scoopDepth', 0), [0, -6, 0]);
      push(i, 'scoopWidth', 'scoop', [cl.cx - sp.w / 2, pc.ya, H], [cl.cx + sp.w / 2, pc.ya, H], sp.w, asked('scoopWidth', 0), [0, -6, 0]);
      break;
    }
    if (g.jointDef.joint !== 'butt') {
      for (let sIdx = 1; sIdx <= 2; sIdx++) {
        const side = pc.sides[sIdx], feats = pc.sideFeats[sIdx];
        if (!side || side.mode !== 'tenon' || !feats || !feats.length) continue;
        const f = feats[0], dep = f.depth;
        const from = sIdx === 1 ? [pc.xb, f.world, H / 2] : [f.world, pc.yb, H / 2];
        const to = sIdx === 1 ? [pc.xb + dep, f.world, H / 2] : [f.world, pc.yb + dep, H / 2];
        push(i, 'jointDepth', 'tenon', from, to, dep, asked('jointDepth', 1), sIdx === 1 ? [0, -6, 0] : [6, 0, 0]);
        break;
      }
    }
  }
  return dims;
}

function build(p, ctx = {}) {
  const { g, parts } = buildAll(p, ctx);
  const arranged = arrangeParts(g, parts, p.arrange === 'assembled' ? 'assembled' : 'plate');

  const joints = [];
  for (const pc of g.pieces) {
    for (let s = 0; s < 4; s++) {
      const side = pc.sides[s];
      if (!side || side.mode !== 'tenon') continue;
      const feats = pc.sideFeats[s] || [];
      if (!feats.length) continue;
      joints.push({
        axis: side.axis, piece: pc.name, count: feats.length,
        fit: g.jointDef.fit, depth: g.jointDef.depth, flare: g.jointDef.flare,
        features: feats.map(f => ({
          at: f.world, w: f.w, wRoot: f.wRoot,
          tenon: tenonProfile(f), socket: socketProfile(f, g.jointDef),
        })),
      });
    }
  }

  return {
    mesh: arranged.mesh,
    parts: parts.map(pt => ({ name: pt.name, mesh: pt.mesh.centerXY().dropToPlate() })),
    meta: {
      outer: { w: g.W, d: g.D, h: g.H },
      drawer: { w: g.drawerW, d: g.drawerD }, clearance: g.clearance,
      wallT: g.wallT, floorT: g.floorT, chamfer: g.chamfer, cornerR: g.cornerR,
      rows: g.rows, cols: g.cols,
      cells: g.cells.map(c => ({
        id: c.id, row: [c.r0, c.r1], col: [c.c0, c.c1],
        x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, w: c.w, d: c.d,
        depth: c.depth, floorZ: c.floorZ, through: c.through, front: c.front,
        cr: c.cr, rf: c.rf,
      })),
      areas: g.areas,
      fill: g.fill,
      pieces: parts.map(pt => ({
        name: pt.name, w: pt.size[0], d: pt.size[1], h: pt.size[2],
        cells: pt.piece.cells.length,
        seams: pt.piece.sides.map((s, i) => (s ? { side: ['front', 'right', 'back', 'left'][i], mode: s.mode, axis: s.axis } : null)).filter(Boolean),
      })),
      joints, joint: g.jointDef.joint, seamWall: g.seamWall,
      split: { x: g.bandsX.length, y: g.bandsY.length, seamX: g.seamXpos, seamY: g.seamYpos },
      plates: arranged.plates, unplaced: arranged.unplaced,
      notes: g.notes,
      dims: drawerDims(p, g, arranged),
    },
  };
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const LAYOUT_HELP = [
  'A plan view of the drawer, one character per grid square, rows separated by ";".',
  'Squares sharing a letter are ONE compartment, so "aab" is a wide bin beside a narrow one',
  'and stacking "ab;ab" makes a compartment two rows deep. "." leaves a square out — no',
  'compartment there, the material stays solid. The first row is the BACK of the drawer.',
  'After a "|" you can give per-compartment depths in mm measured down from the rim, or the',
  'word "through" for a pass-through with no floor: "aaab;ccdb|b=12 d=through".',
].join(' ');

const params = [
  // ---- the space you measured
  { key: 'drawerW', label: 'Space across', type: 'number', group: 'The space', unit: 'mm',
    def: 150, min: 20, max: 600, step: 1, precision: 1,
    help: 'Measure the drawer left to right at its narrowest point — usually where the runners are.' },
  { key: 'drawerD', label: 'Space front to back', type: 'number', group: 'The space', unit: 'mm',
    def: 100, min: 20, max: 600, step: 1, precision: 1,
    help: 'Front to back. Measure past the drawer front, not the handle.' },
  { key: 'height', label: 'Height', type: 'number', group: 'The space', unit: 'mm',
    def: 30, min: 5, max: 180, step: 1, precision: 1,
    help: 'Overall height. Leave a couple of millimetres under the drawer above so it does not scrape.' },
  { key: 'clearance', label: 'Clearance per side', type: 'number', group: 'The space', unit: 'mm',
    def: FIT.drop, min: 0, max: 3, step: 0.1, precision: 2,
    help: 'Gap left on EACH side, so the finished part is 2x this smaller than the space in both directions. 0.5 mm drops in; 0 is a press fit and you will regret it.' },

  // ---- layout
  { key: 'layoutMode', label: 'Compartments', type: 'enum', group: 'Layout', def: 'grid',
    options: [
      { v: 'grid', label: 'Rows x columns', help: 'A plain grid you set with two numbers.' },
      { v: 'custom', label: 'Drawn layout', help: 'Type a little plan view with spans and per-compartment depths.' },
      { v: 'fill', label: 'Fill the space', help: 'As many equal compartments as fit at a minimum size.' },
    ],
    help: 'How the inside is divided up.' },
  { key: 'rows', label: 'Rows', type: 'int', group: 'Layout', def: 2, min: 1, max: 10, step: 1,
    showIf: (p) => p.layoutMode === 'grid',
    help: 'Compartments front to back.' },
  { key: 'cols', label: 'Columns', type: 'int', group: 'Layout', def: 3, min: 1, max: 12, step: 1,
    showIf: (p) => p.layoutMode === 'grid',
    help: 'Compartments left to right.' },
  { key: 'colWeights', label: 'Column widths', type: 'text', group: 'Layout', def: '', maxLength: 80,
    showIf: (p) => p.layoutMode === 'grid',
    help: 'Relative widths, e.g. "1,1,2" makes the last column twice as wide. A short list repeats, so "1,2" alternates. Blank means equal.' },
  { key: 'rowWeights', label: 'Row depths', type: 'text', group: 'Layout', def: '', maxLength: 80,
    showIf: (p) => p.layoutMode === 'grid',
    help: 'Relative front-to-back sizes, same idea as the column widths.' },
  { key: 'layout', label: 'Layout', type: 'text', group: 'Layout', def: 'aaab;ccdb|b=12 d=through', maxLength: 400,
    showIf: (p) => p.layoutMode === 'custom',
    help: LAYOUT_HELP },
  { key: 'minCell', label: 'Smallest compartment', type: 'number', group: 'Layout', unit: 'mm',
    def: 30, min: 8, max: 120, step: 1, precision: 1,
    showIf: (p) => p.layoutMode === 'fill',
    help: 'Fill mode packs in as many equal compartments as fit at this size, then shares the leftover out between them so nothing is wasted. The raw leftover is reported.' },
  { key: 'cellDepth', label: 'Compartment depth', type: 'number', group: 'Layout', unit: 'mm',
    def: 0, min: 0, max: 180, step: 1, precision: 1,
    help: 'Depth measured down from the rim. 0 means as deep as the tray allows. A drawn layout can override this per compartment.' },

  // ---- structure
  { key: 'wallT', label: 'Wall thickness', type: 'number', group: 'Structure', unit: 'mm',
    def: 1.6, min: 0.8, max: 6, step: 0.4, precision: 2,
    help: 'Keep it a multiple of the nozzle width (0.4) — 1.6 mm is four clean perimeters with no gap-fill down the middle of every divider.' },
  { key: 'floorT', label: 'Floor thickness', type: 'number', group: 'Structure', unit: 'mm',
    def: 1.6, min: 0.6, max: 6, step: 0.2, precision: 2,
    help: 'A multiple of the layer height. 1.6 mm is eight layers at 0.2, which is solid enough to carry a handful of bolts.' },
  { key: 'bottom', label: 'Bottom', type: 'enum', group: 'Structure', def: 'solid',
    options: [
      { v: 'solid', label: 'Solid floor', help: 'A closed tray.' },
      { v: 'open', label: 'Open (dividers only)', help: 'No floor at all: just the walls, sitting on the drawer base. Uses less filament and sweeps out.' },
    ],
    help: 'A closed tray, or a bare grid of dividers that sits on the drawer bottom.' },
  { key: 'cornerR', label: 'Outside corner radius', type: 'number', group: 'Structure', unit: 'mm',
    def: 3, min: 0, max: 12, step: 0.5, precision: 2,
    help: 'Rounds the four outside corners. Raised automatically if the top chamfer needs the room.' },
  { key: 'cellR', label: 'Compartment corner radius', type: 'number', group: 'Structure', unit: 'mm',
    def: 2, min: 0, max: 10, step: 0.5, precision: 2,
    help: 'Rounded inside corners wipe out and let small parts be pinched out of the corner instead of jamming in it.' },
  { key: 'bottomR', label: 'Radius in the bottom', type: 'number', group: 'Structure', unit: 'mm',
    def: 1.5, min: 0, max: 8, step: 0.5, precision: 2,
    help: 'A fillet where each compartment floor meets its walls, so a fingernail can get under a washer. Prints unsupported — it only ever leans inwards.' },
  { key: 'topChamfer', label: 'Top chamfer', type: 'number', group: 'Structure', unit: 'mm',
    def: 0.8, min: 0, max: 3, step: 0.1, precision: 2,
    help: 'A 45 degree break on every top edge so nothing catches going in. Clamped so the wall keeps a flat top at least one nozzle wide.' },

  // ---- scoops
  { key: 'scoops', label: 'Finger scoops', type: 'bool', group: 'Finger scoops', def: true,
    help: 'A dish cut down through the front wall of each front compartment, so you can get a fingertip under what is in it.' },
  { key: 'scoopDepth', label: 'Scoop depth', type: 'number', group: 'Finger scoops', unit: 'mm',
    def: 8, min: 2, max: 25, step: 1, precision: 1,
    showIf: (p) => p.scoops !== false,
    help: 'How far down from the rim the dish reaches. Clamped to stay above the compartment floor.' },
  { key: 'scoopWidth', label: 'Scoop width', type: 'number', group: 'Finger scoops', unit: 'mm',
    def: 25, min: 5, max: 80, step: 1, precision: 1,
    showIf: (p) => p.scoops !== false,
    help: 'Width of the dish where it meets the rim. Two fingers want about 30 mm.' },

  // ---- splitting
  { key: 'splitX', label: 'Pieces across', type: 'int', group: 'Splitting', def: 1, min: 1, max: 4, step: 1,
    help: 'Divide the organiser into this many interlocking pieces left to right. Seams always land on a divider wall, never through a compartment.' },
  { key: 'splitY', label: 'Pieces front to back', type: 'int', group: 'Splitting', def: 1, min: 1, max: 4, step: 1,
    help: 'The same, front to back. Two by two gives four pieces.' },
  { key: 'autoSplit', label: 'Split automatically', type: 'bool', group: 'Splitting', def: true,
    help: 'Add seams by itself until every piece fits the bed. Turn it off if you want to control the count.' },
  { key: 'joint', label: 'Joint', type: 'enum', group: 'Splitting', def: 'dovetail',
    options: [
      { v: 'dovetail', label: 'Dovetail', help: 'A tapered key. Slide the pieces together from above and they cannot pull apart sideways.' },
      { v: 'dogbone', label: 'Dogbone finger', help: 'A square key with relieved socket corners so it seats fully. Aligns; glue or tape holds it.' },
      { v: 'butt', label: 'Plain butt', help: 'Flat faces, no key. Fastest to print, needs glue.' },
    ],
    help: 'How the pieces hold on to each other.' },
  { key: 'jointFit', label: 'Joint clearance', type: 'number', group: 'Splitting', unit: 'mm',
    def: FIT.snug, min: 0, max: 0.6, step: 0.05, precision: 2,
    help: 'Gap on every face of the key. 0.15 mm is a firm push fit on a well-tuned A1; go to 0.25 if your first layer squashes out.' },
  { key: 'jointDepth', label: 'Joint depth', type: 'number', group: 'Splitting', unit: 'mm',
    def: 2.5, min: 1, max: 8, step: 0.5, precision: 2,
    help: 'How far the key reaches into its socket. The seam wall thickens to twice this plus a wall each side, so the socket always has material behind it.' },
  { key: 'jointCount', label: 'Keys per seam', type: 'int', group: 'Splitting', def: 2, min: 1, max: 6, step: 1,
    help: 'Reduced automatically if the seam is too short for them to be worth cutting.' },
  { key: 'jointAngle', label: 'Dovetail angle', type: 'number', group: 'Splitting', unit: 'deg',
    def: 12, min: 5, max: 25, step: 1, precision: 1,
    showIf: (p) => p.joint === 'dovetail',
    help: 'Flank angle. Under about 8 degrees it stops locking; over 20 the thin part of the key gets fragile.' },
  { key: 'arrange', label: 'Show', type: 'enum', group: 'Splitting', def: 'plate',
    options: [
      { v: 'plate', label: 'Arranged on the plate', help: 'What actually gets printed.' },
      { v: 'assembled', label: 'Assembled', help: 'The finished organiser, pieces shown a hair apart so the seams are visible.' },
    ],
    help: 'Only matters once the organiser is split.' },
];

// ---------------------------------------------------------------------------

function validate(p) {
  const issues = [];
  const g = solve(p, {});
  const bedX = A1_MINI_BED.x, bedY = A1_MINI_BED.y, bedZ = A1_MINI_BED.z;

  // The corner radius is clamped rather than refused, because a rounder corner
  // than the walls can carry is a preference the geometry cannot honour, not a
  // mistake. Say so instead of quietly moving the number.
  const askedR = Number(p.cornerR) || 0;
  const maxR = CORNER_R_PER_WALL * g.wallT;
  if (askedR > maxR + 0.05) {
    issues.push({ param: 'cornerR', severity: 'warn',
      message: `A ${askedR.toFixed(1)} mm outside radius needs a thicker wall than ${g.wallT.toFixed(1)} mm — ` +
               `it has been built at ${maxR.toFixed(1)} mm. Raise the wall to ${(askedR / CORNER_R_PER_WALL).toFixed(1)} mm ` +
               `to get the corner you asked for.` });
  }

  let worst = null;
  for (const pc of g.pieces) {
    const w = pc.xb - pc.xa, d = pc.yb - pc.ya;
    if (w > bedX || d > bedY) worst = { w, d };
  }
  if (worst) {
    issues.push({
      param: 'splitX', severity: 'error',
      message: `A piece is ${worst.w.toFixed(0)} x ${worst.d.toFixed(0)} mm and the bed is ${bedX} x ${bedY} mm. Turn on automatic splitting, raise the piece count, or make it smaller — it will not print as one part.`,
    });
  }
  // Deliberately NOT checked here: whether the arranged plate fits the bed. Each
  // piece fitting and the plate fitting are different questions, and this one
  // cannot be answered from parameters — it depends on how arrangeParts() packs,
  // and two attempts at predicting that from piece extents produced a warning
  // that fired on layouts which fit and stayed quiet on one that did not.
  // printability() answers it correctly from the built mesh, and the analysis
  // column already shows it as "Fits the bed: No". A guess here would only
  // compete with a measurement there.
  if (g.H > bedZ) {
    issues.push({ param: 'height', severity: 'error', message: `${g.H.toFixed(0)} mm is taller than the ${bedZ} mm build volume.` });
  }
  if (!g.cells.length) {
    issues.push({ param: 'layoutMode', severity: 'warn', message: 'No compartment is big enough to cut — this will print as a solid block. Fewer rows and columns, or thinner walls.' });
  }
  const nozzle = 0.4;
  const lines = g.wallT / nozzle;
  if (Math.abs(lines - Math.round(lines)) > 0.02) {
    issues.push({ param: 'wallT', severity: 'warn', message: `A ${g.wallT} mm wall is ${lines.toFixed(2)} extrusions wide, so the slicer will thread a sliver of gap-fill down the middle of every divider. Use a multiple of ${nozzle} mm.` });
  }
  if (g.wallT < 0.8) {
    issues.push({ param: 'wallT', severity: 'error', message: 'Under 0.8 mm a divider is a single extrusion with nothing holding it upright.' });
  }
  if (g.H / g.wallT > 60) {
    issues.push({ param: 'wallT', severity: 'error', message: `A ${g.wallT} mm wall ${g.H.toFixed(0)} mm tall is a ${(g.H / g.wallT).toFixed(0)}:1 fin. It will wobble away from the nozzle long before the top. Thicken the walls or lower the tray.` });
  }
  if (!g.openBottom && g.floorT < 0.6) {
    issues.push({ param: 'floorT', severity: 'error', message: 'A floor under three layers will not survive being emptied out.' });
  }
  if (g.clearance <= 0) {
    issues.push({ param: 'clearance', severity: 'warn', message: 'With no clearance the tray is exactly the size you measured, and a printed part is never exactly the size you asked for. 0.4–0.6 mm per side drops in.' });
  }
  if (g.pieces.length > 1 && g.jointDef.joint !== 'butt' && g.jointDef.fit <= 0) {
    issues.push({ param: 'jointFit', severity: 'error', message: 'A joint with zero clearance is an interference fit in a material that expands as it cools. The pieces will not go together.' });
  }
  if (g.pieces.length > 1 && g.jointDef.joint !== 'butt' && !g.meta_hasJoints && !g.pieces.some((pc, i) => (pc.sideFeats || []).some(f => f && f.length))) {
    issues.push({ param: 'jointCount', severity: 'warn', message: 'The seams are too short for a key of this depth — the pieces will butt together and need glue.' });
  }
  const scoopBad = g.scoops && g.cells.some(c => c.front && g.scoopDepth > c.depth - 1.2);
  if (scoopBad) {
    issues.push({ param: 'scoopDepth', severity: 'warn', message: 'The scoop is deeper than the compartment it opens, so it has been shortened to stop it cutting into the floor.' });
  }
  for (const n of g.notes) issues.push({ param: 'layout', severity: 'warn', message: n });
  return issues;
}

function hints(p) {
  const g = solve(p, {});
  const nozzle = 0.4;
  const perim = Math.max(2, Math.round(g.wallT / nozzle));
  const layerH = g.H > 60 ? 0.24 : 0.2;
  const notes = [
    `${layerH} mm layers. Nothing here needs finer: every surface is either vertical, a 45 degree chamfer or a floor.`,
    `${perim} perimeters — a ${g.wallT} mm divider is exactly ${(g.wallT / nozzle).toFixed(1)} extrusions, so the walls come out solid with no gap-fill seam down the middle.`,
    g.openBottom
      ? 'Open bottom: bed contact is only the wall footprint, so use a brim if a divider is longer than about 100 mm.'
      : `${Math.round(g.floorT / layerH)} layers of floor. Set top and bottom solid layers to at least 4 or the compartment floors will show pinholes.`,
    '10–15% gyroid infill. The walls are solid perimeters, so infill only fills the floor and the seam walls — pushing it higher buys nothing but time.',
    'No supports. The scoops, the chamfers and the radius in each compartment all overhang inwards at 45 degrees or less, and the compartment floors are all bridged by nothing — they sit on solid material.',
  ];
  if (g.pieces.length > 1) {
    notes.push(`Prints as ${g.pieces.length} pieces. Print them all in one go with the seam faces on the bed as they are arranged, and slide them together from above once cool — ${g.jointDef.joint === 'dovetail' ? 'the dovetail locks them sideways' : g.jointDef.joint === 'dogbone' ? 'the keys align them; a drop of glue holds them' : 'they butt, so glue them'}.`);
    notes.push(`Joint clearance is ${g.jointDef.fit} mm per face. If the first one is tight, do not sand it — raise the clearance by 0.05 and reprint one piece.`);
  }
  if (g.cells.some(c => c.through)) {
    notes.push('The pass-through compartments have no floor, so their walls start on the bed — check the first layer before you walk away.');
  }
  notes.push('PLA. PETG is tougher but strings across open compartments, and this object is nothing but open compartments.');
  return {
    profile: g.H > 60 ? '0.24 mm standard' : '0.20 mm standard',
    layerH, perimeters: perim, infill: 12, supports: false, filament: 'PLA',
    notes,
  };
}

export default {
  id: 'drawer',
  name: 'Drawer Organiser',
  category: 'Storage',
  blurb: 'Fills an awkward measured drawer with exactly the compartments you want.',
  description:
    'Give it the two numbers you measured inside the drawer and a clearance, draw the ' +
    'compartments you want as a little plan view — spans, per-compartment depths, squares ' +
    'left solid, pass-throughs — and it comes back as a tray with chamfered rims, radiused ' +
    'compartment bottoms and finger scoops on the front. Anything wider than the 180 mm bed ' +
    'is divided into interlocking pieces at a divider wall, with dovetail or dogbone keys ' +
    'cut to a clearance you set. Fill mode does the arithmetic the other way round: tell it ' +
    'the smallest compartment you will accept and it packs in as many equal ones as fit and ' +
    'reports the leftover.',
  icon: null,
  version: 1,
  params,
  presets: [
    { name: 'Desk drawer, pens and scissors', values: {
      drawerW: 150, drawerD: 100, height: 30, layoutMode: 'custom',
      layout: 'aaab;ccdb|b=12 d=through', scoops: true, scoopDepth: 9, scoopWidth: 28,
      cellR: 2.5, bottomR: 2, topChamfer: 0.8 } },
    { name: 'Bolt tin', values: {
      drawerW: 110, drawerD: 110, height: 26, layoutMode: 'grid', rows: 4, cols: 4,
      wallT: 1.6, floorT: 1.6, cellR: 1.5, bottomR: 2.5, topChamfer: 0.6,
      scoops: false, cornerR: 2 } },
    { name: 'Cutlery tray, prints in two', values: {
      drawerW: 200, drawerD: 82, height: 45, layoutMode: 'grid', rows: 1, cols: 4,
      colWeights: '1,1,1,1.4', splitX: 2, joint: 'dovetail', jointFit: 0.15,
      jointDepth: 2.5, jointCount: 2, scoops: false, cellR: 3, bottomR: 2.5,
      cornerR: 3, arrange: 'plate' } },
    { name: 'Battery bay', values: {
      drawerW: 120, drawerD: 92, height: 22, layoutMode: 'custom',
      layout: 'aabbb;aaccc;ddccc|a=16 b=8 d=8', wallT: 1.6, cellR: 1,
      bottomR: 1, topChamfer: 0.6, scoops: true, scoopDepth: 6, scoopWidth: 18 } },
    { name: 'Fill a measured drawer', values: {
      drawerW: 168, drawerD: 121, height: 34, layoutMode: 'fill', minCell: 38,
      clearance: 0.6, scoops: true, scoopDepth: 8, scoopWidth: 26, bottomR: 2 } },
    { name: 'Cable pass-through caddy', values: {
      drawerW: 140, drawerD: 90, height: 40, layoutMode: 'custom',
      layout: 'abc;abc|a=through b=through c=through', bottom: 'solid',
      wallT: 2, cellR: 4, cornerR: 4, topChamfer: 1, scoops: false } },
    { name: 'Dividers only, no floor', values: {
      drawerW: 160, drawerD: 110, height: 45, bottom: 'open', layoutMode: 'grid',
      rows: 2, cols: 4, wallT: 2, cellR: 2, topChamfer: 1, scoops: false } },
  ],
  build,
  validate,
  hints,
};
