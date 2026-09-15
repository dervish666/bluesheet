// Render every built-in cookie-cutter shape to one contact sheet.
//
// Topology checks prove a shape is a solid. They cannot prove it is a RABBIT.
// This is the only way to close that gate, so it exists as a tool rather than
// as something typed once into a terminal and lost.
//
//   node tools/shape-sheet.mjs [outdir]
import { withPage } from '../tests/lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPE_IDS } from '../js/gen/cookiecutter.js';

const OUT = process.argv[2] || '/tmp/cutter-shapes';
const CELL = Number(process.env.CELL || 300);
mkdirSync(OUT, { recursive: true });

await withPage(async (page) => {
  // The handle exposes setParam (singular) and no bulk setter, so each value
  // goes in on its own. It rebuilds per call, which for fourteen shapes is
  // cheaper than adding an API to the application for the sake of a tool.
  await page.eval(`__bluesheet.setGen('cookiecutter')`);
  await page.eval(`__bluesheet.setParam('source', 'shape')`);
  await page.eval(`__bluesheet.setParam('stamp', false)`);
  await page.eval(`__bluesheet.setParam('size', 60)`);
  await page.eval(`__bluesheet.setParam('height', 12)`);
  await page.eval(`__bluesheet.setParam('blade', 1)`);
  await page.eval(`__bluesheet.setParam('flangeW', 4)`);
  for (const shape of SHAPE_IDS) {
    const info = await page.eval(`(async () => {
      await __bluesheet.setParam('shape', ${JSON.stringify(shape)});
      __bluesheet.viewer.setMode('solid');
      // Top view: a silhouette is the only thing that answers "is that a rabbit".
      __bluesheet.viewer.setPreset('top');
      __bluesheet.viewer.render();
      const b = __bluesheet.mesh.bbox();
      return { url: __bluesheet.viewer.thumbnail({ size: ${CELL} }), size: b.size.map(v => +v.toFixed(1)) };
    })()`);
    writeFileSync(join(OUT, `${shape}.png`), Buffer.from(String(info.url).split(',')[1], 'base64'));
    console.log(`  ${shape.padEnd(12)} ${info.size.join(' x ')} mm`);
  }
});
console.log(`\n${SHAPE_IDS.length} shapes -> ${OUT}`);
