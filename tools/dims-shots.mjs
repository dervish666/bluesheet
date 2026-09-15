// One screenshot per declared dimension callout, with that parameter focused,
// so a callout can be looked at rather than trusted. Runs headless against the
// live service, like contact-sheet.mjs.
//
//   node tools/dims-shots.mjs <gen> [outdir] [--preset NAME] [--view iso|front|top]
//
// A callout that measures the right number can still sit on the wrong feature,
// hide inside the solid, or land where the view cannot read it; the conformance
// check catches the first and only a pair of eyes catches the rest.
import { withPage } from '../tests/lib/cdp.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const gen = args.find(a => !a.startsWith('--'));
if (!gen) { console.error('usage: node tools/dims-shots.mjs <gen> [outdir] [--preset NAME] [--view iso]'); process.exit(2); }
const positional = args.filter(a => !a.startsWith('--') && a !== gen && !args[args.indexOf(a) - 1]?.startsWith('--'));
const OUT = positional[0] || `/tmp/bluesheet-dims/${gen}`;
const flag = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const preset = flag('preset'), view = flag('view') || 'iso';
mkdirSync(OUT, { recursive: true });

await withPage(async (page) => {
  const info = await page.eval(`(async () => {
    await __bluesheet.setGen(${JSON.stringify(gen)});
    ${preset ? `await __bluesheet.applyPreset(${JSON.stringify(preset)});` : ''}
    await __bluesheet.rebuild();
    __bluesheet.viewer.setMode('solid');
    __bluesheet.viewer.setPreset(${JSON.stringify(view)});
    __bluesheet.viewer.fit();
    __bluesheet.viewer.render();
    const dims = (__bluesheet.meta && __bluesheet.meta.dims) || [];
    return { dims: dims.map(d => ({ param: d.param, label: d.label, len: Math.hypot(d.to[0]-d.from[0], d.to[1]-d.from[1], d.to[2]-d.from[2]) })), params: __bluesheet.params };
  })()`);
  if (!info.dims.length) { console.log(`${gen}: no meta.dims declared`); return; }
  const seen = new Set();
  for (const d of info.dims) {
    if (!d.param || seen.has(d.param)) continue;
    seen.add(d.param);
    await page.eval(`(() => { __bluesheet.setFocusParam(${JSON.stringify(d.param)}); __bluesheet.viewer.render(); __bluesheet.dims.render(); return true; })()`);
    await new Promise(r => setTimeout(r, 300));
    const file = join(OUT, `${gen}${preset ? '-' + preset.replace(/[^a-z0-9]+/gi, '_') : ''}-${d.param}.png`);
    await page.screenshot(file);
    console.log(`${file}   ${d.param} = ${info.params[d.param]}   drawn ${d.len.toFixed(2)} mm${d.label ? ` "${d.label}"` : ''}`);
  }
  await page.eval(`(() => { __bluesheet.setFocusParam(null); return true; })()`);
});
