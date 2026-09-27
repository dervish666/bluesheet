// Render every creature preset from a few angles, for judging how they LOOK.
//
// The creature suites prove a creature is a sound solid that stands on the
// plate. They cannot prove it looks like a dragon. This is the before/after
// record for the looks work: run it before a change, run it after, compare.
//
//   node tools/creature-sheet.mjs [outdir]        (needs the service on 8132)
//   OVERRIDE='{"seams":"nested"}' ONLY=Dragon,gauge  VIEWS=iso,top,left  CELL=460
import { withPage } from '../tests/lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import gen from '../js/gen/creature.js';

const OUT = process.argv[2] || '/tmp/creature-sheet';
const CELL = Number(process.env.CELL || 460);
const VIEWS = (process.env.VIEWS || 'iso,top,left').split(',');
const OVERRIDE = JSON.parse(process.env.OVERRIDE || '{}');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(s => s.toLowerCase()) : null;
const presets = gen.presets.filter(pr => !ONLY || ONLY.some(o => pr.name.toLowerCase().includes(o)));
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
mkdirSync(OUT, { recursive: true });

await withPage(async (page) => {
  await page.eval(`__bluesheet.setGen('creature')`);
  for (const pr of presets) {
    // The handle has no bulk setter; each preset value goes in on its own,
    // species first so its own `carries` cannot overwrite what follows.
    const values = { ...pr.values, ...OVERRIDE };
    for (const [k, v] of Object.entries(values)) {
      await page.eval(`__bluesheet.setParam(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
    }
    await page.eval(`__bluesheet.rebuild()`);
    for (const view of VIEWS) {
      const info = await page.eval(`(async () => {
        __bluesheet.viewer.setMode('solid');
        __bluesheet.viewer.setPreset(${JSON.stringify(view)});
        __bluesheet.viewer.fit();
        __bluesheet.viewer.render();
        const b = __bluesheet.mesh.bbox();
        return { url: __bluesheet.viewer.thumbnail({ size: ${CELL} }), size: b.size.map(v => +v.toFixed(1)) };
      })()`);
      writeFileSync(join(OUT, `${slug(pr.name)}-${view}.png`), Buffer.from(String(info.url).split(',')[1], 'base64'));
      if (view === VIEWS[0]) console.log(`  ${pr.name.padEnd(26)} ${info.size.join(' x ')} mm`);
    }
  }
});
console.log(`\n${presets.length} presets x ${VIEWS.length} views -> ${OUT}`);
