// Render every generator's default object to a PNG and lay them out as one
// contact sheet. Runs headless against the live service.
//
//   node tools/contact-sheet.mjs [outdir]
//
// The point is not decoration: a catalogue you cannot see all of at once is a
// catalogue you cannot judge. This is how you find the generator whose default
// preset is embarrassing.
import { withPage } from '../tests/lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || '/tmp/bluesheet-contact-sheet';
const CELL = Number(process.env.CELL || 460);
mkdirSync(OUT, { recursive: true });

const shots = [];
await withPage(async (page) => {
  const gens = await page.eval('__bluesheet.generators.map(g => ({id: g.id, name: g.name, category: g.category, blurb: g.blurb}))');
  console.log(`${gens.length} generators`);
  for (const g of gens) {
    const info = await page.eval(`(async () => {
      await __bluesheet.setGen(${JSON.stringify(g.id)});
      await __bluesheet.rebuild();
      __bluesheet.viewer.setMode('solid');
      __bluesheet.viewer.setPreset('iso');
      __bluesheet.viewer.fit();
      __bluesheet.viewer.render();
      const url = __bluesheet.viewer.thumbnail({ size: ${CELL} });
      const b = __bluesheet.mesh.bbox();
      return { url, tris: __bluesheet.mesh.triCount,
               size: b.size.map(v => +v.toFixed(1)),
               vol: +(__bluesheet.mesh.volume() / 1000).toFixed(1) };
    })()`);
    const png = Buffer.from(String(info.url).split(',')[1], 'base64');
    const file = join(OUT, `${g.id}.png`);
    writeFileSync(file, png);
    shots.push({ ...g, ...info, file });
    console.log(`  ${g.id.padEnd(12)} ${String(info.tris).padStart(7)} tris  ${info.size.join(' × ')} mm  ${info.vol} cm³`);
  }
});

// An HTML sheet rather than a stitched bitmap: it renders at any size, it can
// carry the labels, and a browser can print it to a PDF if anyone ever wants one.
const html = `<!doctype html><meta charset="utf-8"><title>Bluesheet — the catalogue</title>
<style>
 body{margin:0;background:#0D1621;color:#E9F2FA;font:13px/1.45 'IBM Plex Mono',ui-monospace,monospace;padding:28px}
 h1{font:600 20px/1 'Archivo Narrow',system-ui;letter-spacing:.1em;text-transform:uppercase;color:#7FA6C7;margin:0 0 22px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
 figure{margin:0;border:1px solid #33475C;background:#14202E}
 img{display:block;width:100%;background:#0A121B}
 figcaption{padding:9px 11px;border-top:1px solid #33475C}
 .n{font:600 13px/1 'Archivo Narrow',system-ui;letter-spacing:.08em;text-transform:uppercase}
 .c{color:#7FA6C7;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
 .d{color:#9DB4C9;font-size:11px;margin-top:5px}
</style>
<h1>Bluesheet — ${shots.length} generators</h1>
<div class="grid">
${shots.map(s => `<figure><img src="${s.id}.png" alt="${s.name}"><figcaption>
<div class="n">${s.name}</div><div class="c">${s.category}</div>
<div class="d">${s.size.join(' × ')} mm · ${s.vol} cm³ · ${s.tris.toLocaleString()} tris</div>
</figcaption></figure>`).join('\n')}
</div>`;
writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(join(OUT, 'catalogue.json'), JSON.stringify(shots.map(({ url, ...r }) => r), null, 2));
console.log(`\ncontact sheet: ${join(OUT, 'index.html')}  (${shots.length} objects)`);
