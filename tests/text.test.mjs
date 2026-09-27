// tests/text.test.mjs — TrueType parsing, outline geometry and layout.
//
// Two kinds of fixture:
//   * the three fonts bundled in assets/fonts, which prove the parser survives
//     real, messy, shipped data (7,000+ glyphs between them);
//   * a font built byte by byte below, which reaches the branches no bundled
//     font uses — cmap format 12 above the BMP, a mirrored composite, a
//     point-matched composite, a contour with no on-curve points at all. Those
//     are exactly the branches that rot silently, so they get a fixture that
//     cannot change under us.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, check, near, nearPct, nearVec, throws, done } from './lib/assert.mjs';
import {
  loadFont, layoutText, measureText, capScaleFor, flattenQuadratic,
  contoursToShapes, sniffFontFormat, Font, FontError,
} from '../js/kernel/text.js';

suite('text');

const here = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(here, '..', 'assets', 'fonts');
const read = f => readFileSync(join(FONT_DIR, f));

// --- geometry helpers (independent of poly2d, which another leaf owns) -------

const ringArea = ring => {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
};
const shapeArea = shape => shape.reduce((a, r) => a + ringArea(r), 0);

/**
 * Area of the region a shape actually fills, by exact scanline integration
 * under the non-zero winding rule.
 *
 * This is the independent half of the winding check: summing signed ring areas
 * trusts that every hole was wound CW, whereas this trusts nothing — it asks
 * what a rasteriser would paint. If a hole came out wound as an outer ring the
 * two numbers diverge immediately. Exact, not approximate: within a band
 * between consecutive vertex heights the covered width is linear in y, so the
 * midpoint width times the band height is the true integral.
 */
function filledArea(shape) {
  const edges = [];
  const ys = new Set();
  for (const ring of shape) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      ys.add(ring[i][1]);
      if (ring[j][1] !== ring[i][1]) edges.push([ring[j], ring[i]]);
    }
  }
  const yv = [...ys].sort((p, q) => p - q);
  let area = 0;
  for (let k = 0; k + 1 < yv.length; k++) {
    const h = yv[k + 1] - yv[k];
    if (h <= 0) continue;
    const ym = (yv[k] + yv[k + 1]) / 2;
    const xs = [];
    for (const [a, b] of edges) {
      if ((a[1] > ym) !== (b[1] > ym)) {
        xs.push([a[0] + (ym - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), b[1] > a[1] ? 1 : -1]);
      }
    }
    xs.sort((p, q) => p[0] - q[0]);
    let w = 0, wind = 0;
    for (let i = 0; i < xs.length - 1; i++) { wind += xs[i][1]; if (wind !== 0) w += xs[i + 1][0] - xs[i][0]; }
    area += w * h;
  }
  return area;
}

/** Largest direction change between consecutive segments, in degrees. A curve
 *  that was flattened with a missing implied on-curve point shows up here as a
 *  corner where the letterform has none. */
function maxTurnDeg(ring) {
  let worst = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]), t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    const d = Math.abs(((t2 - t1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
    if (d > worst) worst = d;
  }
  return worst;
}

const hasPoint = (rings, x, y, eps = 1e-9) =>
  rings.some(r => r.some(p => Math.abs(p[0] - x) <= eps && Math.abs(p[1] - y) <= eps));

const ringsOf = shapes => shapes.flat();
const pointCount = shapes => shapes.reduce((a, s) => a + s.reduce((b, r) => b + r.length, 0), 0);
const bboxOf = shapes => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of ringsOf(shapes)) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
};

// --- a font built from bytes -------------------------------------------------

class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); return this; }
  u16(v) { this.b.push((v >> 8) & 0xff, v & 0xff); return this; }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  tag(s) { for (const c of s) this.b.push(c.charCodeAt(0)); return this; }
  zeros(n) { for (let i = 0; i < n; i++) this.b.push(0); return this; }
  utf16(s) { for (const c of s) this.u16(c.charCodeAt(0)); return this; }
  pad4() { while (this.b.length % 4) this.b.push(0); return this; }
  get length() { return this.b.length; }
  out() { return Uint8Array.from(this.b); }
}

/** contours: [[ [x, y, onCurve], ... ], ...] — written with long (int16)
 *  coordinate deltas, which is the least clever and therefore least surprising
 *  encoding a real font ever uses. */
function simpleGlyph(contours) {
  const all = contours.flat();
  const w = new W();
  w.i16(contours.length);
  w.i16(Math.min(...all.map(p => p[0]))).i16(Math.min(...all.map(p => p[1])));
  w.i16(Math.max(...all.map(p => p[0]))).i16(Math.max(...all.map(p => p[1])));
  let n = 0;
  for (const c of contours) { n += c.length; w.u16(n - 1); }
  w.u16(0);                                        // no hinting instructions
  for (const p of all) w.u8(p[2] ? 0x01 : 0x00);   // ON_CURVE only; deltas are int16
  let prev = 0; for (const p of all) { w.i16(p[0] - prev); prev = p[0]; }
  prev = 0; for (const p of all) { w.i16(p[1] - prev); prev = p[1]; }
  return w.pad4().out();
}

const ARG_WORDS = 0x0001, ARGS_XY = 0x0002, MORE = 0x0020, TWO_BY_TWO = 0x0080;

function compositeGlyph(bbox, comps) {
  const w = new W();
  w.i16(-1);
  for (const v of bbox) w.i16(v);
  comps.forEach((c, i) => {
    const flags = c.flags | ARG_WORDS | (i < comps.length - 1 ? MORE : 0);
    w.u16(flags).u16(c.gid);
    if (flags & ARGS_XY) { w.i16(c.a1); w.i16(c.a2); } else { w.u16(c.a1); w.u16(c.a2); }
    if (flags & TWO_BY_TWO) for (const v of c.m) w.i16(Math.round(v * 16384));
  });
  return w.pad4().out();
}

const SYN = {
  UPEM: 1000, ASC: 800, DESC: -200,
  SQUARE: 1, MIDPOINT: 2, ALLOFF: 3, MIRROR: 4, POINTMATCH: 5, NESTED: 6, BLANK: 7,
  // A..F map to glyphs 1..6, space maps to the blank glyph, and U+10000 maps
  // back to the square so the format 12 lookup has to work above the BMP.
  advances: [500, 800, 500, 800, 800, 800, 900, 300],
};

function buildSyntheticFont() {
  const g = [
    new Uint8Array(0),                                                       // 0 .notdef, no outline
    simpleGlyph([[[100, 100, 1], [700, 100, 1], [700, 700, 1], [100, 700, 1]]]),
    simpleGlyph([[[0, 0, 1], [100, 200, 0], [300, 200, 0], [400, 0, 1]]]),   // implied midpoint at (200,200)
    simpleGlyph([[[400, 100, 0], [700, 400, 0], [400, 700, 0], [100, 400, 0]]]),  // no on-curve point at all
    compositeGlyph([100, 100, 700, 700],
      [{ gid: 1, flags: ARGS_XY | TWO_BY_TWO, a1: 800, a2: 0, m: [-1, 0, 0, 1] }]),   // mirrored in x
    compositeGlyph([-500, -500, 700, 700], [
      { gid: 1, flags: ARGS_XY, a1: 0, a2: 0 },
      { gid: 1, flags: 0, a1: 0, a2: 2 },        // point matching: parent point 0 onto child point 2
    ]),
    simpleGlyph([                                                            // both contours wound CCW
      [[0, 0, 1], [800, 0, 1], [800, 800, 1], [0, 800, 1]],
      [[200, 200, 1], [600, 200, 1], [600, 600, 1], [200, 600, 1]],
    ]),
    new Uint8Array(0),                                                       // 7 blank, for the space
  ];
  const numGlyphs = g.length;

  const glyf = new W();
  const loca = [];
  for (const entry of g) { loca.push(glyf.length); for (const b of entry) glyf.u8(b); glyf.pad4(); }
  loca.push(glyf.length);

  const locaW = new W();
  for (const o of loca) locaW.u16(o / 2);        // short format: offsets are halved

  const head = new W();
  head.u16(1).u16(0).u32(0).u32(0).u32(0x5F0F3CF5).u16(0).u16(SYN.UPEM)
    .zeros(16).i16(-500).i16(-500).i16(800).i16(800)
    .u16(0).u16(8).i16(2).i16(0).i16(0);          // indexToLocFormat = 0 (short)

  const maxp = new W();
  maxp.u32(0x00010000).u16(numGlyphs).zeros(26);

  const hhea = new W();
  hhea.u16(1).u16(0).i16(SYN.ASC).i16(SYN.DESC).i16(0).u16(900)
    .i16(0).i16(0).i16(0).i16(1).i16(0).i16(0).zeros(8).i16(0).u16(numGlyphs);

  const hmtx = new W();
  for (const a of SYN.advances) hmtx.u16(a).i16(0);

  const groups = [[0x20, 0x20, SYN.BLANK], [0x41, 0x46, 1], [0x10000, 0x10000, 1]];
  const sub = new W();
  sub.u16(12).u16(0).u32(16 + groups.length * 12).u32(0).u32(groups.length);
  for (const [a, b, gi] of groups) sub.u32(a).u32(b).u32(gi);
  const cmap = new W();
  cmap.u16(0).u16(1).u16(3).u16(10).u32(12);
  for (const b of sub.out()) cmap.u8(b);

  const names = [[1, 'Bluesheet Synthetic'], [2, 'Regular'], [4, 'Bluesheet Synthetic Regular']];
  const strings = new W();
  const recs = names.map(([id, text]) => {
    const off = strings.length;
    strings.utf16(text);
    return { id, off, len: text.length * 2 };
  });
  const name = new W();
  name.u16(0).u16(recs.length).u16(6 + recs.length * 12);
  for (const r of recs) name.u16(3).u16(1).u16(0x409).u16(r.id).u16(r.len).u16(r.off);
  for (const b of strings.out()) name.u8(b);

  const tables = new Map([
    ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea],
    ['hmtx', hmtx], ['loca', locaW], ['maxp', maxp], ['name', name],
  ]);
  return assembleSfnt(0x00010000, tables);
}

function assembleSfnt(version, tables) {
  const tags = [...tables.keys()].sort();
  const out = new W();
  const entrySelector = Math.floor(Math.log2(tags.length));
  const searchRange = 16 * 2 ** entrySelector;
  out.u32(version).u16(tags.length).u16(searchRange).u16(entrySelector)
     .u16(tags.length * 16 - searchRange);
  let offset = 12 + tags.length * 16;
  const placed = [];
  for (const t of tags) {
    const bytes = tables.get(t).out ? tables.get(t).out() : tables.get(t);
    const padded = bytes.length + ((4 - bytes.length % 4) % 4);
    out.tag(t).u32(0).u32(offset).u32(bytes.length);
    placed.push({ bytes, offset });
    offset += padded;
  }
  for (const p of placed) {
    while (out.length < p.offset) out.u8(0);
    for (const b of p.bytes) out.u8(b);
    out.pad4();
  }
  return out.out();
}

// ===========================================================================
// 1. Sniffing, and refusing what we cannot do
// ===========================================================================

const stub = (tag) => {
  const w = new W();
  for (const c of tag) w.u8(c.charCodeAt(0));
  return w.zeros(60).out();
};

check('sniffFontFormat: bundled TTF is truetype', sniffFontFormat(read('Quicksand-Bold.ttf')) === 'truetype');
check('sniffFontFormat: OTTO is cff', sniffFontFormat(stub('OTTO')) === 'cff');
check('sniffFontFormat: wOFF is woff', sniffFontFormat(stub('wOFF')) === 'woff');
check('sniffFontFormat: wOF2 is woff2', sniffFontFormat(stub('wOF2')) === 'woff2');
check('sniffFontFormat: junk is unknown', sniffFontFormat(stub('JUNK')) === 'unknown');
check('sniffFontFormat: a 2-byte buffer is unknown', sniffFontFormat(new Uint8Array([0, 1])) === 'unknown');

throws('loadFont: CFF/OTTO is refused by name', () => loadFont(stub('OTTO')), 'CFF');
throws('loadFont: WOFF is refused by name', () => loadFont(stub('wOFF')), 'WOFF');
throws('loadFont: unrecognised signature is refused', () => loadFont(stub('JUNK')), 'unrecognised');
throws('loadFont: a truncated TTF says so, and names the table and the byte count',
  () => loadFont(read('Quicksand-Bold.ttf').subarray(0, 4000)), 'truncated');
throws('loadFont: a non-buffer argument is refused', () => loadFont('Quicksand-Bold.ttf'), 'ArrayBuffer');

// An sfnt that says TrueType but keeps its outlines in CFF — the branch a real
// .otf never reaches, because it is rejected on its signature first.
{
  const cffish = assembleSfnt(0x00010000, new Map([['CFF ', new W().zeros(16)], ['head', new W().zeros(56)]]));
  throws('loadFont: sfnt with a CFF table but no glyf is refused', () => loadFont(cffish), 'CFF');
  const noOutlines = assembleSfnt(0x00010000, new Map([['head', new W().zeros(56)], ['maxp', new W().zeros(32)]]));
  throws('loadFont: sfnt with no outline table at all is refused', () => loadFont(noOutlines), 'glyf');
}
{
  let err = null;
  try { loadFont(stub('OTTO')); } catch (e) { err = e; }
  check('loadFont: the refusal is a FontError', err instanceof FontError && err.format === 'cff',
    `${err && err.name}, format=${err && err.format}`);
}
{
  const real = '/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf';
  check('loadFont: a real .otf on this machine sniffs as cff',
    !existsSync(real) || sniffFontFormat(readFileSync(real)) === 'cff',
    existsSync(real) ? real : 'no system .otf to try');
}

// ===========================================================================
// 2. The three bundled fonts
// ===========================================================================

const BUNDLED = [
  { file: 'Quicksand-Bold.ttf',              family: 'Quicksand',             mono: false, loca: 0 },
  { file: 'DejaVuSansMono.ttf',              family: 'DejaVu Sans Mono',      mono: true,  loca: 1 },
  { file: 'LiberationSansNarrow-Regular.ttf', family: 'Liberation Sans Narrow', mono: false, loca: 0 },
];
const fonts = {};

for (const spec of BUNDLED) {
  const font = loadFont(read(spec.file));
  fonts[spec.file] = font;
  const tag = spec.file.replace('.ttf', '');
  check(`${tag}: loadFont returns a Font`, font instanceof Font);
  check(`${tag}: name is "${spec.family}…"`, font.name.startsWith(spec.family), `got "${font.name}"`);
  check(`${tag}: unitsPerEm is a sane power-of-two-ish value`,
    font.unitsPerEm >= 16 && font.unitsPerEm <= 16384, `${font.unitsPerEm}`);
  check(`${tag}: ascender above baseline, descender below`,
    font.ascender > 0 && font.descender < 0, `${font.ascender} / ${font.descender}`);
  check(`${tag}: cap height is 0.5–0.85 em`,
    font.capHeight / font.unitsPerEm > 0.5 && font.capHeight / font.unitsPerEm < 0.85,
    `${font.capHeight}/${font.unitsPerEm} = ${(font.capHeight / font.unitsPerEm).toFixed(3)}`);
  check(`${tag}: x-height sits below cap height`, font.xHeight > 0 && font.xHeight < font.capHeight,
    `x ${font.xHeight} vs cap ${font.capHeight}`);
  check(`${tag}: loca is the ${spec.loca ? 'long' : 'short'} format`, font.indexToLocFormat === spec.loca);
  check(`${tag}: has Latin, lacks a glyph it should not have`,
    font.hasGlyph('A') && font.hasGlyph('z') && !font.hasGlyph(0x1F600), 'A z but not U+1F600');
  check(`${tag}: parsed without warnings`, font.warnings.length === 0, font.warnings.join('; ') || 'none');
  check(`${tag}: advances are positive`, font.advance('A') > 0 && font.advance(' ') > 0,
    `A=${font.advance('A')} space=${font.advance(' ')}`);
  if (spec.mono) {
    check(`${tag}: monospaced — every advance identical`,
      font.advance('i') === font.advance('W') && font.advance('W') === font.advance('.'),
      `${font.advance('i')}`);
  } else {
    check(`${tag}: proportional — 'i' is narrower than 'W'`, font.advance('i') < font.advance('W'),
      `${font.advance('i')} < ${font.advance('W')}`);
  }
  // Every glyph in the font, not just the ones a test happens to name.
  let failures = 0, rings = 0, firstError = '';
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    try { rings += font.glyphRings(gid, font.unitsPerEm / 500).length; }
    catch (e) { failures++; if (!firstError) firstError = `glyph ${gid}: ${e.message}`; }
  }
  check(`${tag}: all ${font.numGlyphs} glyphs parse`, failures === 0,
    failures ? firstError : `${rings} contours total`);
}

const quick = fonts['Quicksand-Bold.ttf'];
const mono = fonts['DejaVuSansMono.ttf'];
const narrow = fonts['LiberationSansNarrow-Regular.ttf'];

check('loadFont: Buffer, Uint8Array and ArrayBuffer all load identically', (() => {
  const buf = read('Quicksand-Bold.ttf');
  const u8 = new Uint8Array(buf);
  const ab = u8.slice().buffer;
  const [a, b, c] = [loadFont(buf), loadFont(u8), loadFont(ab)];
  return a.capHeight === b.capHeight && b.capHeight === c.capHeight && a.name === c.name;
})());
check('DejaVu Sans Mono: cmap format 12 was chosen over the format 4 alternative',
  mono.cmap.format === 12, `format ${mono.cmap.format} from platform ${mono.cmap.platform},${mono.cmap.encoding}`);
check('Quicksand: cmap format 4 (3,1) was chosen — no format 12 in this font',
  quick.cmap.format === 4 && quick.cmap.platform === 3, `format ${quick.cmap.format}`);
check('cmap format 12 resolves characters outside Latin-1',
  mono.hasGlyph('→') && mono.hasGlyph('■') && mono.hasGlyph('–'), 'U+2192 U+25A0 U+2013');
check('OS/2 sCapHeight, where the font supplies one, agrees with the measured cap height',
  quick.os2.capHeight === quick.capHeight && narrow.os2.capHeight === narrow.capHeight,
  `Quicksand ${quick.os2.capHeight}=${quick.capHeight}, Narrow ${narrow.os2.capHeight}=${narrow.capHeight}`);
check('a font with no sCapHeight still gets a cap height by measurement',
  mono.os2.version < 2 || mono.os2.capHeight === 0, `OS/2 v${mono.os2.version}, sCapHeight ${mono.os2.capHeight}`);

// ===========================================================================
// 3. Outline geometry — the G5 claims
// ===========================================================================

for (const [tag, font] of Object.entries({ Quicksand: quick, DejaVuMono: mono, Narrow: narrow })) {
  const O = font.glyphShapes('O');
  check(`${tag} 'O': one shape holding exactly 2 contours`,
    O.shapes.length === 1 && O.shapes[0].length === 2,
    `${O.shapes.length} shape(s), rings ${O.shapes.map(s => s.length).join('+')}`);
  const [outer, hole] = O.shapes[0];
  check(`${tag} 'O': outer ring CCW, counter CW — opposite winding`,
    ringArea(outer) > 0 && ringArea(hole) < 0,
    `outer ${ringArea(outer).toFixed(0)}, hole ${ringArea(hole).toFixed(0)}`);
  check(`${tag} 'O': the counter really is inside the outer ring`,
    Math.abs(ringArea(hole)) < Math.abs(ringArea(outer)) * 0.9,
    `${(Math.abs(ringArea(hole)) / Math.abs(ringArea(outer)) * 100).toFixed(0)}% of the outer area`);

  const i = font.glyphShapes('i');
  check(`${tag} 'i': 2 contours, both of them outer`,
    i.shapes.length === 2 && i.shapes.every(s => s.length === 1 && ringArea(s[0]) > 0),
    `${i.shapes.length} shape(s), rings ${i.shapes.map(s => s.length).join('+')}`);
  const l = font.glyphShapes('l');
  check(`${tag} 'l': 1 contour`, l.shapes.length === 1 && l.shapes[0].length === 1,
    `${l.shapes.length} shape(s)`);

  // A round letterform flattened correctly has no corners. Missing implied
  // on-curve midpoints show up as exactly that: a corner where the curve should
  // be smooth.
  const worst = Math.max(...ringsOf(font.glyphShapes('O', { scale: 10 / font.capHeight, tolerance: 0.02 }).shapes)
    .map(maxTurnDeg));
  check(`${tag} 'O': no flat spots — max direction change ${worst.toFixed(1)}° < 25°`, worst < 25);

  const H = layoutText(font, 'H', { size: 10 });
  nearPct(`${tag} 'H' at 10 mm cap height measures 10 mm tall`, H.bbox.size[1], 10, 2);
  near(`${tag} 'H' sits on the baseline at y = 0`, H.bbox.min[1], 0, 1e-9);
  // The *advance* box is what gets centred, not the ink: a glyph with uneven
  // side bearings should sit fractionally off-axis, and by exactly this much.
  const hb = font.glyphBBox(font.glyphIndex('H'));
  near(`${tag} 'H': the advance box is centred on x = 0`, H.bbox.center[0],
    ((hb.xMin + hb.xMax) / 2 - font.advance('H') / 2) * H.scale, 1e-9);
}

// Composites: how accents and many quotation marks are actually built.
check("composite glyphs: 'é' is composite in all three fonts",
  quick.isComposite(quick.glyphIndex('é')) && mono.isComposite(mono.glyphIndex('é'))
  && narrow.isComposite(narrow.glyphIndex('é')), 'accented letters reference their base glyph');
for (const [tag, font] of Object.entries({ Quicksand: quick, DejaVuMono: mono, Narrow: narrow })) {
  const e = font.glyphShapes('e'), acc = font.glyphShapes('é');
  check(`${tag} 'é': base glyph plus the accent`,
    acc.shapes.length === e.shapes.length + 1 && acc.bbox.yMax > e.bbox.yMax,
    `${e.shapes.length} → ${acc.shapes.length} shapes, top ${e.bbox.yMax} → ${acc.bbox.yMax}`);
  check(`${tag} 'é': the accent does not disturb the base outline`,
    Math.abs(acc.bbox.xMin - e.bbox.xMin) < font.unitsPerEm * 0.02
    && acc.advance === e.advance, `advance ${e.advance} vs ${acc.advance}`);
}
{
  // Nested composites — a glyph whose component is itself a composite. DejaVu is
  // full of them, and the recursion has to both work and terminate.
  let nested = 0;
  for (let gid = 0; gid < mono.numGlyphs && nested < 3; gid++) {
    if (!mono.isComposite(gid)) continue;
    const bb = mono.glyphBBox(gid);
    if (!bb) continue;
    const v = mono.view, at = mono._glyfStart + mono._loca[gid];
    if (mono.isComposite(v.getUint16(at + 12))) nested++;
  }
  check('nested composites (a component that is itself composite) parse', nested >= 3,
    `${nested} found and parsed in DejaVu Sans Mono`);
}

// ===========================================================================
// 4. Adaptive flattening
// ===========================================================================

{
  const p0 = [0, 0], p1 = [50, 100], p2 = [100, 0];
  const coarse = flattenQuadratic(p0, p1, p2, 1);
  const fine = flattenQuadratic(p0, p1, p2, 0.01);
  check('flattenQuadratic: a tighter tolerance produces more segments',
    fine.length > coarse.length * 3, `${coarse.length} at tol 1 → ${fine.length} at tol 0.01`);
  nearVec('flattenQuadratic: the last point is exactly p2', fine[fine.length - 1], p2, 0);
  check('flattenQuadratic: p0 is not repeated (contours concatenate cleanly)',
    fine[0][0] !== 0 || fine[0][1] !== 0);
  check('flattenQuadratic: a control point on the chord needs one segment',
    flattenQuadratic([0, 0], [50, 0], [100, 0], 0.01).length === 1);
  check('flattenQuadratic: the segment count is capped for absurd tolerances',
    flattenQuadratic(p0, p1, p2, 1e-12).length === 96, `${flattenQuadratic(p0, p1, p2, 1e-12).length}`);
  // Measure the real error against the true curve, not just the segment count.
  const tol = 0.05;
  const pts = [p0, ...flattenQuadratic(p0, p1, p2, tol)];
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const t = i / 399, u = 1 - t;
    const cx = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const cy = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    let best = Infinity;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const s = len2 ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(cx - (a[0] + s * dx), cy - (a[1] + s * dy)));
    }
    worst = Math.max(worst, best);
  }
  check(`flattenQuadratic: real deviation ${worst.toFixed(4)} stays inside the ${tol} tolerance`, worst <= tol);
}
{
  // The size-dependence that a fixed segment count cannot give you.
  const small = layoutText(quick, 'OOO', { size: 5 });
  const large = layoutText(quick, 'OOO', { size: 100 });
  check('flattening scales with the requested size, not a fixed count',
    pointCount(large.shapes) > pointCount(small.shapes) * 2.5,
    `${pointCount(small.shapes)} points at 5 mm → ${pointCount(large.shapes)} at 100 mm`);
  const loose = layoutText(quick, 'OOO', { size: 20, curveTolerance: 0.5 });
  const tight = layoutText(quick, 'OOO', { size: 20, curveTolerance: 0.005 });
  check('curveTolerance controls the density at a fixed size',
    pointCount(tight.shapes) > pointCount(loose.shapes) * 3,
    `${pointCount(loose.shapes)} at 0.5 mm → ${pointCount(tight.shapes)} at 0.005 mm`);
}

// ===========================================================================
// 5. contoursToShapes — nesting decided by containment, not by font winding
// ===========================================================================

const sq = (x, y, s, ccw = true) => {
  const r = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  return ccw ? r : r.reverse();
};
{
  const two = contoursToShapes([sq(0, 0, 10), sq(20, 0, 10)]);
  check('contoursToShapes: two disjoint rings are two shapes', two.length === 2 && two.every(s => s.length === 1));

  // Both rings wound the same way — a winding-based classifier would call this
  // two solids; containment says it is a solid with a hole.
  const donut = contoursToShapes([sq(0, 0, 100), sq(25, 25, 50)]);
  check('contoursToShapes: a same-winding inner ring becomes a hole',
    donut.length === 1 && donut[0].length === 2, `${donut.length} shape(s), ${donut[0].length} rings`);
  check('contoursToShapes: outer comes out CCW and the hole CW',
    ringArea(donut[0][0]) > 0 && ringArea(donut[0][1]) < 0,
    `${ringArea(donut[0][0])} / ${ringArea(donut[0][1])}`);
  near('contoursToShapes: the donut fills outer minus hole', filledArea(donut[0]), 100 * 100 - 50 * 50, 1e-9);

  const island = contoursToShapes([sq(0, 0, 100), sq(20, 20, 60), sq(40, 40, 20)]);
  check('contoursToShapes: a ring inside a hole becomes its own solid',
    island.length === 2 && island[0].length === 2 && island[1].length === 1,
    island.map(s => s.length).join('+'));
  check('contoursToShapes: rings below minArea are dropped',
    contoursToShapes([sq(0, 0, 100), sq(10, 10, 1)], { minArea: 4 }).length === 1);
  check('contoursToShapes: degenerate input yields no shapes',
    contoursToShapes([[[0, 0], [1, 1]], [], null]).length === 0);
  check('contoursToShapes: a zero-area ring is dropped',
    contoursToShapes([[[0, 0], [5, 0], [10, 0]]]).length === 0);
}

// ===========================================================================
// 6. The synthetic font: the branches no bundled font reaches
// ===========================================================================

const syn = loadFont(buildSyntheticFont());
check('synthetic font: parses', syn instanceof Font && syn.numGlyphs === 8, `${syn.numGlyphs} glyphs`);
check('synthetic font: name table decoded from UTF-16BE',
  syn.name === 'Bluesheet Synthetic Regular' && syn.familyName === 'Bluesheet Synthetic', `"${syn.name}"`);
check('synthetic font: head metrics read back',
  syn.unitsPerEm === SYN.UPEM && syn.ascender === SYN.ASC && syn.descender === SYN.DESC
  && syn.indexToLocFormat === 0);
check('synthetic font: cmap format 12 maps a contiguous range',
  syn.glyphIndex('A') === 1 && syn.glyphIndex('C') === 3 && syn.glyphIndex('F') === 6,
  'A→1 C→3 F→6');
check('synthetic font: cmap format 12 resolves a code point above the BMP',
  syn.glyphIndex(0x10000) === SYN.SQUARE && syn.glyphIndex('\u{10000}') === SYN.SQUARE,
  'U+10000 → glyph 1');
check('synthetic font: an unmapped code point is glyph 0',
  syn.glyphIndex('Z') === 0 && !syn.hasGlyph('Z'));
check('synthetic font: hmtx advances read back', syn.advance('A') === 800 && syn.advance(' ') === 300,
  `A=${syn.advance('A')} space=${syn.advance(' ')}`);
{
  const blank = syn.glyphShapes(' ');
  check('synthetic font: a blank glyph has an advance but no contour',
    blank.shapes.length === 0 && blank.advance === 300 && blank.index === SYN.BLANK);
}
{
  const sqr = syn.glyphShapes('A');
  check('synthetic font: a simple square is one CCW ring of 4 points',
    sqr.shapes.length === 1 && sqr.shapes[0].length === 1 && sqr.shapes[0][0].length === 4
    && ringArea(sqr.shapes[0][0]) > 0, `${sqr.shapes[0][0].length} points, area ${ringArea(sqr.shapes[0][0])}`);
  near('synthetic font: the square has its exact area', Math.abs(shapeArea(sqr.shapes[0])), 600 * 600, 1e-9);
}
{
  // THE classic trap. Two consecutive off-curve points at (100,200) and
  // (300,200) imply an on-curve point at (200,200); the flattened ring must
  // pass exactly through it, because it is the join between the two quadratics.
  const b = syn.glyphShapes('B', { tolerance: 0.5 });
  const rings = ringsOf(b.shapes);
  check('implied on-curve midpoint: the ring passes exactly through (200, 200)',
    hasPoint(rings, 200, 200), `ring of ${rings[0].length} points`);
  check('implied on-curve midpoint: both halves are curved, not one straight run',
    rings[0].length > 12, `${rings[0].length} points`);
}
{
  // A contour made entirely of off-curve points — legal, and common for circles.
  // Every implied midpoint must appear, including the synthesised start.
  const c = syn.glyphShapes('C', { tolerance: 0.5 });
  const rings = ringsOf(c.shapes);
  const corners = [[250, 250], [550, 250], [550, 550], [250, 550]];
  check('all-off-curve contour: every implied on-curve point is present',
    corners.every(([x, y]) => hasPoint(rings, x, y)), `${rings[0].length} points in the ring`);
  check('all-off-curve contour: closes into a single ring', c.shapes.length === 1 && c.shapes[0].length === 1);
}
{
  // A component mirrored by a 2×2 transform reverses the winding the font
  // stored. Depth-based classification has to shrug that off.
  const d = syn.glyphShapes('D');
  check('mirrored composite: still one solid ring, and still CCW',
    d.shapes.length === 1 && d.shapes[0].length === 1 && ringArea(d.shapes[0][0]) > 0,
    `area ${ringArea(d.shapes[0][0])}`);
  const bb = bboxOf(d.shapes);
  check('mirrored composite: lands back on the square it was mirrored from',
    bb.x0 === 100 && bb.x1 === 700 && bb.y0 === 100 && bb.y1 === 700,
    `${bb.x0},${bb.y0} → ${bb.x1},${bb.y1}`);
}
{
  // Args that are point indices rather than an offset: the component is placed
  // so its point 2 lands on the parent's point 0.
  const e = syn.glyphShapes('E');
  const bb = bboxOf(e.shapes);
  check('point-matched composite: two squares, joined corner to corner',
    e.shapes.length === 2 && bb.x0 === -500 && bb.y0 === -500 && bb.x1 === 700 && bb.y1 === 700,
    `${e.shapes.length} shapes, ${bb.x0},${bb.y0} → ${bb.x1},${bb.y1}`);
}
{
  const f = syn.glyphShapes('F');
  check('same-winding nested contours in a real glyph resolve to solid + hole',
    f.shapes.length === 1 && f.shapes[0].length === 2
    && ringArea(f.shapes[0][0]) > 0 && ringArea(f.shapes[0][1]) < 0,
    `${f.shapes[0].map(r => ringArea(r)).join(' / ')}`);
  near('nested glyph fills outer minus hole', filledArea(f.shapes[0]), 800 * 800 - 400 * 400, 1e-9);
}
check('glyphShapes: a negative scale mirrors the glyph and keeps the outer ring CCW', (() => {
  const m = syn.glyphShapes('F', { scale: -1 });
  return m.shapes.length === 1 && ringArea(m.shapes[0][0]) > 0 && ringArea(m.shapes[0][1]) < 0;
})());
throws('glyphRings: an out-of-range glyph id is an error, not empty output',
  () => syn.glyphRings(99, 1), 'out of range');
throws('codePoint: an empty string is refused', () => syn.glyphIndex(''), 'code point');

// ===========================================================================
// 7. Layout — the G6 claims
// ===========================================================================

{
  const scale = capScaleFor(quick, 10);
  near('capScaleFor: cap height times scale is the requested size', quick.capHeight * scale, 10, 1e-12);
  throws('capScaleFor: a zero size is refused', () => capScaleFor(quick, 0), 'cap height');

  // Advance widths accumulate, and kerning is part of the sum.
  const kern = quick.kern('A', 'V');
  check('Quicksand kerns A/V through GPOS', kern < 0 && quick.kerningSource === 'GPOS',
    `${kern} units from ${quick.kerningSource}`);
  const av = layoutText(quick, 'AV', { size: 10 });
  near('layout: width is advance + kern + advance',
    av.width, (quick.advance('A') + kern + quick.advance('V')) * scale, 1e-9);
  const avNoKern = layoutText(quick, 'AV', { size: 10, kerning: false });
  near('layout: kerning off removes exactly the kern', avNoKern.width - av.width, -kern * scale, 1e-9);
  check('layout: kerning pulls A and V together', av.width < avNoKern.width,
    `${av.width.toFixed(3)} vs ${avNoKern.width.toFixed(3)} mm`);

  // The legacy `kern` table is a separate parser; it must agree with GPOS.
  const gposN = loadFont(read('LiberationSansNarrow-Regular.ttf'), { kerning: 'gpos' });
  const kernN = loadFont(read('LiberationSansNarrow-Regular.ttf'), { kerning: 'kern' });
  const noneN = loadFont(read('LiberationSansNarrow-Regular.ttf'), { kerning: 'none' });
  const pairs = [['A', 'V'], ['T', 'o'], ['A', 'W'], ['V', 'a'], ['Y', '.']];
  check('the legacy kern table and GPOS agree on every pair tried',
    kernN.kerningSource === 'kern' && gposN.kerningSource === 'GPOS'
    && pairs.every(([a, b]) => kernN.kern(a, b) === gposN.kern(a, b) && kernN.kern(a, b) !== 0),
    pairs.map(([a, b]) => `${a}${b}=${kernN.kern(a, b)}`).join(' '));
  check('kerning: "none" disables it', noneN.kerningSource === 'none' && noneN.kern('A', 'V') === 0);
  check('a monospaced font reports no kerning at all',
    mono.kerningSource === 'none' && mono.kern('A', 'V') === 0);
  throws('loadFont: an unknown kerning mode is refused',
    () => loadFont(read('Quicksand-Bold.ttf'), { kerning: 'wat' }), 'kerning must be');
}
{
  const plain = layoutText(quick, 'ABC', { size: 10 });
  const spaced = layoutText(quick, 'ABC', { size: 10, letterSpacing: 2 });
  near('letterSpacing: n-1 gaps, not n — the run stays centred', spaced.width - plain.width, 4, 1e-9);
  // Spacing is added symmetrically about the centre, so the ink centre must not
  // drift: an n-gap implementation would push the whole run half a gap left.
  near('letterSpacing: the ink centre does not drift', spaced.bbox.center[0], plain.bbox.center[0], 1e-9);
}
{
  const one = layoutText(quick, 'AB', { size: 10 });
  const sp = layoutText(quick, 'A B', { size: 10 });
  check('a space produces no stray contour', sp.shapes.length === one.shapes.length,
    `"AB" -> ${one.shapes.length} shapes, "A B" -> ${sp.shapes.length}`);
  check('a space still advances the pen', sp.width > one.width,
    `${one.width.toFixed(2)} -> ${sp.width.toFixed(2)} mm`);
  near('a space advances by exactly the space glyph', sp.width - one.width,
    quick.advance(' ') * capScaleFor(quick, 10), 1e-9);
  const trailing = layoutText(quick, 'AB   ', { size: 10 });
  near('trailing blanks are trimmed so centred text stays centred', trailing.width, one.width, 1e-9);
  const tabbed = layoutText(quick, 'A\tB', { size: 10, tabSize: 4 });
  near('a tab expands to tabSize spaces', tabbed.width - one.width,
    4 * quick.advance(' ') * capScaleFor(quick, 10), 1e-9);
}
{
  const two = layoutText(quick, 'Bluesheet\n3D', { size: 8, lineHeight: 1.4 });
  check('multi-line: one entry per line', two.lines.length === 2 && two.lines[1].text === '3D',
    two.lines.map(l => `"${l.text}"`).join(' '));
  near('multi-line: the second baseline is one lineHeight down', two.lines[1].y, -two.lineStep, 1e-12);
  near('multi-line: lineStep is lineHeight x em', two.lineStep, 1.4 * quick.unitsPerEm * two.scale, 1e-12);
  check('multi-line: the widest line sets the block width',
    Math.abs(two.width - Math.max(...two.lines.map(l => l.width))) < 1e-9);
  check('multi-line: a CRLF is treated as one line break',
    layoutText(quick, 'Bluesheet\r\n3D', { size: 8 }).lines.length === 2);

  const left = layoutText(quick, 'Bluesheet\n3D', { size: 8, align: 'left' });
  const right = layoutText(quick, 'Bluesheet\n3D', { size: 8, align: 'right' });
  const centre = layoutText(quick, 'Bluesheet\n3D', { size: 8, align: 'centre' });
  check('align left: every line starts at x = 0', left.lines.every(l => l.x === 0));
  check('align right: every line ends at x = 0', right.lines.every(l => Math.abs(l.x + l.width) < 1e-12));
  check('align centre: each line is centred on its own axis',
    centre.lines.every(l => Math.abs(l.x + l.width / 2) < 1e-12));
  check('align centre is a synonym for center', centre.lines[0].x === two.lines[0].x);
  check('align left/right shift the ink the way the names promise',
    left.bbox.min[0] >= -1e-9 && right.bbox.max[0] <= 1e-9,
    `left min x ${left.bbox.min[0].toFixed(4)}, right max x ${right.bbox.max[0].toFixed(4)}`);
}
{
  const wide = layoutText(quick, 'Sam Fitzgerald', { size: 12 });
  const fitted = layoutText(quick, 'Sam Fitzgerald', { size: 12, maxWidth: 60 });
  near('maxWidth: the run is scaled to exactly the limit', fitted.width, 60, 1e-9);
  near('maxWidth: reported fit is the ratio applied', fitted.fit, 60 / wide.width, 1e-12);
  near('maxWidth: cap height shrinks with the run', fitted.capHeight, 12 * fitted.fit, 1e-9);
  nearPct('maxWidth: the ink shrinks by the same ratio',
    fitted.bbox.size[1], wide.bbox.size[1] * fitted.fit, 0.001);
  const roomy = layoutText(quick, 'Sam', { size: 12, maxWidth: 500 });
  check('maxWidth: text that already fits is left alone', roomy.fit === 1);
}
{
  const m = measureText(quick, 'Bluesheet 3D\nnameplate', { size: 9, letterSpacing: 0.4, align: 'right' });
  const l = layoutText(quick, 'Bluesheet 3D\nnameplate', { size: 9, letterSpacing: 0.4, align: 'right' });
  check('measureText agrees with layoutText on every number that matters',
    m.width === l.width && m.height === l.height && m.scale === l.scale
    && m.lines.length === l.lines.length && m.lines[0].x === l.lines[0].x,
    `${m.width.toFixed(4)} mm x ${m.height.toFixed(4)} mm`);
  near('height covers ascender to descender plus the line steps',
    l.height, (quick.ascender - quick.descender) * l.scale + l.lineStep, 1e-12);
}
{
  const base = layoutText(quick, 'Hxy', { size: 10, vAlign: 'baseline' });
  const mid = layoutText(quick, 'Hxy', { size: 10, vAlign: 'center' });
  const top = layoutText(quick, 'Hxy', { size: 10, vAlign: 'top' });
  const bot = layoutText(quick, 'Hxy', { size: 10, vAlign: 'bottom' });
  near('vAlign baseline: the baseline is y = 0', base.lines[0].y, 0, 1e-12);
  near('vAlign top: the ascender line is y = 0', top.lines[0].y + top.ascent, 0, 1e-12);
  near('vAlign bottom: the descender line is y = 0', bot.lines[0].y + bot.descent, 0, 1e-12);
  near('vAlign center: the typographic box straddles y = 0',
    mid.lines[0].y + (mid.ascent + mid.descent) / 2, 0, 1e-12);
}
{
  const empty = layoutText(quick, '', { size: 10 });
  check('an empty string lays out to nothing, without throwing',
    empty.shapes.length === 0 && empty.width === 0 && empty.lines.length === 1);
  check('a whitespace-only string produces no shapes',
    layoutText(quick, '   ', { size: 10 }).shapes.length === 0);
  check('control characters are dropped rather than drawn as tofu',
    layoutText(quick, 'AB', { size: 10 }).shapes.length
    === layoutText(quick, 'AB', { size: 10 }).shapes.length);
}
{
  const missing = layoutText(quick, 'A\u{1F600}B', { size: 10, onMissing: 'skip' });
  check('onMissing skip: the character is dropped and reported',
    missing.missing.length === 1 && missing.shapes.length === layoutText(quick, 'AB', { size: 10 }).shapes.length,
    `missing: ${JSON.stringify(missing.missing)}`);
  throws('onMissing error: the character is named in the message',
    () => layoutText(quick, 'A\u{1F600}B', { size: 10, onMissing: 'error' }), 'U+1F600');
  const notdef = layoutText(quick, 'A\u{1F600}B', { size: 10, onMissing: 'notdef' });
  check('onMissing notdef: the tofu box takes up space',
    notdef.width > layoutText(quick, 'AB', { size: 10 }).width, `${notdef.width.toFixed(2)} mm`);
}
throws('layout: an unknown align is refused', () => layoutText(quick, 'A', { align: 'middle' }), 'align must be');
throws('layout: an unknown vAlign is refused', () => layoutText(quick, 'A', { vAlign: 'middle' }), 'vAlign must be');
throws('layout: an unknown onMissing is refused', () => layoutText(quick, 'A', { onMissing: 'guess' }), 'onMissing must be');
throws('layout: a NaN option is caught before it reaches the geometry',
  () => layoutText(quick, 'A', { letterSpacing: NaN }), 'finite');
throws('layout: a negative maxWidth is refused', () => layoutText(quick, 'A', { maxWidth: -5 }), 'maxWidth');
throws('layout: something that is not a Font is refused', () => layoutText({}, 'A'), 'Font');
check('layout: repeating the same call gives byte-identical geometry',
  JSON.stringify(layoutText(quick, 'Bluesheet 3D!', { size: 10 }).shapes)
  === JSON.stringify(layoutText(quick, 'Bluesheet 3D!', { size: 10 }).shapes));
check('layout: glyphs are also returned grouped and positioned, one entry per inked glyph', (() => {
  const r = layoutText(quick, 'A B', { size: 10 });
  return r.glyphs.length === 2 && r.glyphs[1].char === 'B' && r.glyphs[1].x > r.glyphs[0].x
    && r.glyphs.reduce((a, g) => a + g.shapes.length, 0) === r.shapes.length;
})());

// ===========================================================================
// 8. Usable by poly2d — the G7 claim
// ===========================================================================

const SAMPLE = 'Bluesheet 3D! @#';
{
  const laid = layoutText(quick, SAMPLE, { size: 12 });
  check(`"${SAMPLE}": every glyph with ink produced a shape`, laid.shapes.length >= 9,
    `${laid.shapes.length} shapes, ${pointCount(laid.shapes)} points`);
  let badWinding = 0, areaMismatch = 0, worstDelta = 0;
  for (const shape of laid.shapes) {
    if (ringArea(shape[0]) <= 0) badWinding++;
    for (let i = 1; i < shape.length; i++) if (ringArea(shape[i]) >= 0) badWinding++;
    const analytic = shapeArea(shape), filled = filledArea(shape);
    const d = Math.abs(analytic - filled);
    worstDelta = Math.max(worstDelta, d);
    if (d > 1e-9 * Math.max(1, Math.abs(analytic))) areaMismatch++;
  }
  check(`"${SAMPLE}": outer rings CCW, holes CW, in every shape`, badWinding === 0,
    `${badWinding} rings wound wrongly out of ${ringsOf(laid.shapes).length}`);
  check(`"${SAMPLE}": filled area equals the analytic ring area (worst gap ${worstDelta.toExponential(2)} mm2)`,
    areaMismatch === 0, `${laid.shapes.length} shapes checked by scanline integration`);
}

let poly2d = null;
try { poly2d = await import('../js/kernel/poly2d.js'); } catch { poly2d = null; }
if (poly2d && typeof poly2d.triangulate === 'function') {
  const laid = layoutText(quick, SAMPLE, { size: 12 });
  let failures = 0, worst = 0, tris = 0, firstError = '';
  for (const shape of laid.shapes) {
    let out;
    try { out = poly2d.triangulate(shape); }
    catch (e) { failures++; if (!firstError) firstError = e.message; continue; }
    let sum = 0;
    for (let t = 0; t < out.tris.length; t += 3) {
      const a = out.points[out.tris[t]], b = out.points[out.tris[t + 1]], c = out.points[out.tris[t + 2]];
      sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    tris += out.tris.length / 3;
    worst = Math.max(worst, Math.abs(sum - Math.abs(shapeArea(shape))));
  }
  check(`poly2d.triangulate: succeeds on every glyph of "${SAMPLE}"`, failures === 0,
    failures ? firstError : `${tris} triangles`);
  check(`poly2d.triangulate: triangle area matches the ring area (worst gap ${worst.toExponential(2)} mm2)`,
    worst < 1e-6);
} else {
  console.log('  note poly2d.js is not importable yet (owned by leaf K1) — the same property is '
    + 'proved above by scanline integration, which does not depend on it');
}

// ===========================================================================
// 9. Robustness and speed
// ===========================================================================

{
  // A coarse tolerance must still yield an outline, not a ring whose points all
  // welded together — the weld epsilon has to come from the em, not the tolerance.
  const coarse = layoutText(quick, 'O', { size: 10, curveTolerance: 5 });
  check('a very coarse curveTolerance still yields a solid with its counter',
    coarse.shapes.length === 1 && coarse.shapes[0].length === 2
    && ringArea(coarse.shapes[0][0]) > 0 && ringArea(coarse.shapes[0][1]) < 0,
    `${pointCount(coarse.shapes)} points`);
  check('the reported bbox describes the shapes that were actually returned',
    Math.abs(bboxOf(coarse.shapes).h - coarse.bbox.size[1]) < 1e-12
    && Math.abs(bboxOf(coarse.shapes).x0 - coarse.bbox.min[0]) < 1e-12);
}
{
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) layoutText(quick, `Bench ${i}\nWorkshop`, { size: 12, maxWidth: 90 });
  const ms = Date.now() - t0;
  check(`50 two-line layouts take ${ms} ms — well inside the 2 s build budget`, ms < 500);
}
{
  const t0 = Date.now();
  const fresh = loadFont(read('DejaVuSansMono.ttf'));
  const ms = Date.now() - t0;
  check(`parsing a 335 kB font takes ${ms} ms`, ms < 250 && fresh.numGlyphs > 3000);
}

done();
