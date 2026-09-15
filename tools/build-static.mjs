// Build the public, serverless copy of Bluesheet.
//
//   node tools/build-static.mjs <outdir>
//
// The kernel, the generators, the viewer and the analysis are pure browser
// JavaScript, so they publish as static files. Everything that talks to the
// Python server — saving designs, the plate, the slicer, the printer, the Made
// log, the geocoder — cannot, so the build marks the page `is-static` and
// `css/static.css` hides those controls rather than leaving buttons that fail.
// The markup carries `data-needs-server` on exactly those controls, which is
// the whole contract between this script and index.html.
//
// Nothing is bundled or minified: the modules ship as they are, which is also
// how they are tested. The output is what the scratch-it Worker serves under
// /bluesheet/app/.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ? resolve(process.argv[2]) : null;
if (!OUT) { console.error('usage: node tools/build-static.mjs <outdir>'); process.exit(2); }
if (OUT === ROOT || ROOT.startsWith(OUT + '/')) { console.error('refusing to build over the source tree'); process.exit(2); }

const COPY = ['js', 'css', 'assets'];
const SKIP = /(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.LICENSE\.txt$|\/README\.md$/;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const dir of COPY) {
  cpSync(join(ROOT, dir), join(OUT, dir), {
    recursive: true,
    filter: (src) => !SKIP.test(src.slice(ROOT.length)),
  });
}
// Licences travel with the fonts they cover, in one file, rather than being
// skipped: the webfonts already ship theirs, the TTFs need the same.
const licences = readdirSync(join(ROOT, 'assets/fonts')).filter(f => f.endsWith('.LICENSE.txt'));
writeFileSync(join(OUT, 'assets/fonts/LICENCES.txt'),
  licences.map(f => `==== ${f.replace('.LICENSE.txt', '')} ====\n\n${readFileSync(join(ROOT, 'assets/fonts', f), 'utf8')}`).join('\n\n'));

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const before = html;
html = html.replace('<body>', '<body class="is-static">');
html = html.replace('<link rel="stylesheet" href="css/bluesheet.css">',
  '<link rel="stylesheet" href="css/bluesheet.css">\n<link rel="stylesheet" href="css/static.css">');
html = html.replace('<script type="module" src="js/app.js"></script>',
  '<script>window.BLUESHEET_STATIC = true;</script>\n<script type="module" src="js/app.js"></script>');
for (const must of ['class="is-static"', 'css/static.css', 'BLUESHEET_STATIC']) {
  if (!html.includes(must)) { console.error(`index.html transform failed: ${must} not injected`); process.exit(1); }
}
if (html === before) { console.error('index.html unchanged — anchors moved?'); process.exit(1); }
const needs = (html.match(/data-needs-server/g) || []).length;
if (needs < 4) { console.error(`only ${needs} data-needs-server marks in index.html; expected the Saved button, Save design, the plate and the slicer at least`); process.exit(1); }
writeFileSync(join(OUT, 'index.html'), html);

// Size, so a fat asset cannot slip in unnoticed.
function size(p) { const st = statSync(p); return st.isDirectory() ? readdirSync(p).reduce((a, f) => a + size(join(p, f)), 0) : st.size; }
const total = size(OUT);
console.log(`built ${OUT}: ${(total / 1024 / 1024).toFixed(2)} MB, ${needs} server-only controls hidden`);
if (total > 8 * 1024 * 1024) { console.error('output over 8 MB — something that is not the app got copied'); process.exit(1); }
