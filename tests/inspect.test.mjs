// The inspector, driven in real Chrome against its own copy of the server.
//
//   cd ~/explorer/projects/bluesheet && node tests/inspect.test.mjs
//
// This suite starts a private Bluesheet on an ephemeral port — the one on :8132
// may be tracking a real print and is never touched — with the Made watcher
// pointed at a scratch directory and an unreachable printer, so a test run can
// never move a real job. Fixtures come from tests/lib/inspect-fixtures.mjs; the
// 30 MB one is written to a temp directory at test time and removed after.
//
// Files reach the page two ways, both real: through the hidden <input type=file>
// via CDP's DOM.setFileInputFiles (the same handler a drop or the picker runs),
// and through __bluesheet.inspect.inspectBytes() for the direct handle. Every
// assertion about a defect is about a number the report states, not a verdict.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { suite, check, near, done } from './lib/assert.mjs';
import { writeFixtures, writeLarge, FIXTURE_DIR, CUBE, GIANT, BED, WALL, OVERHANG_DEG } from './lib/inspect-fixtures.mjs';

suite('inspector');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(every);
  }
  return null;
}

// ---- a private server -------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'bluesheet-inspect-'));
const port = await freePort();
const cdpPort = await freePort();
const server = spawn('python3', [join(root, 'server.py')], {
  cwd: root,
  env: {
    ...process.env,
    BLUESHEET_PORT: String(port),
    BLUESHEET_MADE_DIR: join(tmp, 'made'),
    BLUESHEET_GLADYS_API: 'http://127.0.0.1:9',      // discard port: nothing answers
    BLUESHEET_CAMERA_URL: 'http://127.0.0.1:9/none.jpg',
    BLUESHEET_MADE_POLL: '3600',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', d => { serverErr += d; });
const stopServer = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.once('exit', () => { stopServer(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stopServer(); process.exit(130); });

const health = await until(async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  return r.ok ? r.json() : null;
}, 20000, 150);
check('a private Bluesheet server starts on an ephemeral port', !!health && health.ok === true,
  health ? `port ${health.port}` : `no health after 20 s: ${serverErr.slice(-300)}`);
if (!health) { stopServer(); done(); process.exit(1); }

process.env.BLUESHEET_URL = `http://127.0.0.1:${port}/`;
process.env.BLUESHEET_CDP_PORT = String(cdpPort);
const { withPage } = await import('./lib/cdp.mjs');

// ---- fixtures ----------------------------------------------------------------

const fixtures = writeFixtures(FIXTURE_DIR);
const large = writeLarge(join(tmp, 'large-heightfield.stl'), 30_000_000);
check('the large fixture is at least 30 MB', large.bytes >= 30_000_000 && statSync(large.path).size === large.bytes,
  `${(large.bytes / 1e6).toFixed(1)} MB, ${large.triCount.toLocaleString('en-GB')} triangles`);

try {
  await withPage(async (page) => {
    const q = (expr) => page.eval(expr);

    // Feed a file through the real <input type=file> handler and wait for its report.
    async function feedFile(path, name) {
      await q(`(() => { __bluesheet.inspect.current = null; return true; })()`);
      const doc = await page.send('DOM.getDocument', { depth: 1 });
      const node = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '[data-inspect-file]' });
      await page.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [path] });
      const r = await until(() => q(`(() => { const i = __bluesheet.inspect; const r = i.report;
        return (r && r.file && r.file.name === ${JSON.stringify(name)} && !i.busy) ? r : null; })()`), 90000, 150);
      if (!r) throw new Error(`no report for ${name} within 90 s`);
      return r;
    }
    // The direct handle: bytes in, report out.
    async function feedBytes(path, name) {
      const b64 = readFileSync(path).toString('base64');
      return q(`(async () => { const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return __bluesheet.inspect.inspectBytes(u.buffer, ${JSON.stringify(name)}); })()`);
    }
    const finding = (r, code) => (r.findings || []).find(f => f.code === code) || null;

    // =====================================================================
    // wiring
    // =====================================================================
    const wiring = await q(`({
      handle: typeof __bluesheet.inspect === 'object' && typeof __bluesheet.inspect.inspectBytes === 'function',
      overlay: !!document.querySelector('[data-inspect]'),
      hiddenAtStart: document.querySelector('[data-inspect]').hidden,
      button: (document.querySelector('[data-open-inspect]') || {}).textContent,
      input: !!document.querySelector('[data-inspect-file]'),
      css: [...document.styleSheets].some(s => /inspect\\.css/.test(s.href || '')),
      mode: __bluesheet.inspect.mode,
    })`);
    check('the handle exposes inspect.inspectBytes()', wiring.handle === true);
    check('the [data-inspect] overlay exists and starts hidden', wiring.overlay && wiring.hiddenAtStart === true);
    check('the header has an Inspect button with a file input behind it', /inspect/i.test(wiring.button || '') && wiring.input, `"${(wiring.button || '').trim()}"`);
    check('css/inspect.css is linked', wiring.css === true);
    check('the inspector parses in a Worker', wiring.mode === 'worker', `mode=${wiring.mode}`);

    // The drop zone: a synthetic dragover with a Files type marks the stage.
    const drag = await q(`(() => {
      const st = document.querySelector('[data-stage]');
      const dt = new DataTransfer();
      try { dt.items.add(new File([new Uint8Array(4)], 'x.stl')); } catch (e) {}
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      const prevented = !st.dispatchEvent(ev);
      const on = st.classList.contains('is-dragover');
      st.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
      return { prevented, on, off: !st.classList.contains('is-dragover'), types: [...dt.types] };
    })()`);
    check('dragging a file over the viewer is accepted and marks the drop zone', drag.prevented && drag.on && drag.off,
      `prevented=${drag.prevented} on=${drag.on} off=${drag.off} types=${drag.types}`);

    // =====================================================================
    // G3 — the six broken fixtures, each named with its number
    // =====================================================================
    const holes = await feedFile(fixtures['holes-cube'].path, 'holes-cube.stl');
    check('holes: the report counts 4 open edges', holes.openEdges === 4, `openEdges=${holes.openEdges}`);
    check('holes: the report counts 1 boundary loop', holes.loops === 1, `loops=${holes.loops}`);
    const openF = finding(holes, 'OPEN');
    check('holes: the finding says "4 open edges" and "1 boundary loop" in words',
      !!openF && /4 open edges/.test(openF.text) && /1 boundary loop\b/.test(openF.text) && /80\.0 mm of rim/.test(openF.text),
      openF ? openF.text : 'no OPEN finding');
    check('holes: the overlay opened on the report and shows the open-edge count',
      await q(`(() => { const o = document.querySelector('[data-inspect]'); return !o.hidden && /4 open edge/.test(o.textContent); })()`));

    const inside = await feedFile(fixtures['inside-out-cube'].path, 'inside-out-cube.stl');
    const insideF = finding(inside, 'INSIDE_OUT');
    check('inside-out: the signed volume is negative', inside.inverted === true && inside.volume < 0, `volume=${inside.volume}`);
    check('inside-out: all 12 triangles are reported reversed, with the volume',
      !!insideF && insideF.reversed === 12 && /all 12 triangles/.test(insideF.text) && /-8000\.0 mm³/.test(insideF.text),
      insideF ? insideF.text : 'no INSIDE_OUT finding');

    const stray = await feedFile(fixtures['stray-shell'].path, 'stray-shell.stl');
    const strayF = finding(stray, 'SHELLS');
    check('stray shell: 2 shells are counted', stray.shells === 2, `shells=${stray.shells}`);
    check('stray shell: the small one is identified as 4 triangles', stray.strays.length === 1 && stray.strays[0].tris === 4,
      JSON.stringify(stray.strays.map(s => s.tris)));
    check('stray shell: the finding gives its triangle count and size',
      !!strayF && /1 of them is stray: 4 triangles, 0\.50 × 0\.43 × 0\.41 mm/.test(strayF.text), strayF ? strayF.text : 'no SHELLS finding');

    const giant = await feedBytes(fixtures['giant-cube'].path, 'giant-cube.stl');
    const giantF = finding(giant, 'TOO_LARGE');
    check('300 mm cube: does not fit the bed', giant.fitsBed === false);
    check('300 mm cube: the report says by how much on each axis',
      !!giantF && giant.over.x === GIANT - BED && /120\.0 mm too wide, 120\.0 mm too deep, 120\.0 mm too tall/.test(giantF.text),
      giantF ? giantF.text : 'no TOO_LARGE finding');
    check('300 mm cube: the report is honest about the weight of 27 litres of PLA', Math.abs(giant.grams - 27000 * 1.24) < 1,
      `${giant.grams} g`);

    const thin = await feedBytes(fixtures['thin-walls'].path, 'thin-walls.stl');
    const thinF = finding(thin, 'THIN_WALL');
    check('thin walls: a wall under 0.8 mm is found', !!thinF && thinF.thickness < 0.8, thinF ? thinF.text : 'no THIN_WALL finding');
    check('thin walls: it measures 0.30 mm, which is what was built', !!thinF && Math.abs(thinF.thickness - WALL) < 0.02 && /0\.30 mm thick/.test(thinF.text),
      thinF ? `${thinF.thickness}` : '—');

    const wedge = await feedFile(fixtures['overhang-wedge'].path, 'overhang-wedge.stl');
    const wedgeF = finding(wedge, 'OVERHANG');
    near('overhang wedge: the worst angle is 70° from vertical', wedge.worstOverhangDeg, OVERHANG_DEG, 0.5);
    check('overhang wedge: the finding states the area and the angle',
      !!wedgeF && /70\.0° from vertical/.test(wedgeF.text) && wedgeF.area > 290 && wedgeF.area < 295, wedgeF ? wedgeF.text : 'no OVERHANG finding');

    const clean = await feedBytes(fixtures['clean-cube'].path, 'clean-cube.stl');
    check('clean cube: watertight, wound outward, one shell, fits',
      clean.watertight && !clean.inverted && clean.flippedTris === 0 && clean.shells === 1 && clean.fitsBed);
    near('clean cube: 8 cm³ of PLA is 9.92 g', clean.grams, 8 * 1.24, 0.01);
    check('clean cube: the cost is stated in pence', clean.costText === '18 p', clean.costText);
    check('clean cube: no finding is worse than info', (clean.findings || []).every(f => f.severity === 'ok' || f.severity === 'info'),
      clean.findings.map(f => f.code).join(','));

    // a file that is not an STL
    const junk = await q(`(async () => { const u = new TextEncoder().encode('%PDF-1.4 not a mesh at all, sorry'); return __bluesheet.inspect.inspectBytes(u.buffer, 'notes.pdf'); })()`);
    check('a PDF is refused with a message naming what it is', !!junk.error && /PDF/.test(junk.error) && junk.findings[0].code === 'UNREADABLE', junk.error);

    // =====================================================================
    // G4 — repair says what it did, with counts before and after
    // =====================================================================
    await feedBytes(fixtures['inside-out-cube'].path, 'inside-out-cube.stl');
    const rep1 = await q(`__bluesheet.inspect.repair()`);
    check('repair flips an inside-out solid: volume −8000 → +8000 mm³',
      rep1.repair.before.volume < 0 && rep1.repair.after.volume > 0 && Math.abs(rep1.repair.after.volume - 8000) < 1e-6,
      `${rep1.repair.before.volume} → ${rep1.repair.after.volume}`);
    check('repair lists the flip among what it did', rep1.repair.did.some(t => /Flipped the surface right side out/.test(t)), rep1.repair.did.join(' | '));
    check('repair reports reversed triangles 12 → 0', rep1.repair.before.reversed === 12 && rep1.repair.after.reversed === 0);
    check('after the flip nothing is left unfixed', rep1.repair.couldNot.length === 0 && rep1.solid === true, rep1.repair.couldNot.join(' | '));

    await feedBytes(fixtures['stray-shell'].path, 'stray-shell.stl');
    const rep2 = await q(`__bluesheet.inspect.repair()`);
    check('repair removes the stray shell: shells 2 → 1, triangles 16 → 12',
      rep2.repair.before.shells === 2 && rep2.repair.after.shells === 1 && rep2.repair.after.triangles === 12,
      `shells ${rep2.repair.before.shells}→${rep2.repair.after.shells}, tris ${rep2.repair.before.triangles}→${rep2.repair.after.triangles}`);
    check('repair names the stray shell it removed, with its triangle count', rep2.repair.did.some(t => /Removed 1 stray shell \(4 triangles/.test(t)), rep2.repair.did.join(' | '));

    await feedBytes(fixtures['holes-cube'].path, 'holes-cube.stl');
    const rep3 = await q(`__bluesheet.inspect.repair()`);
    check('repair cannot invent a missing face and says so plainly: 4 open edges in 1 loop remain',
      rep3.repair.after.openEdges === 4 && rep3.repair.couldNot.some(t => /4 open edges in 1 loop/.test(t)), rep3.repair.couldNot.join(' | '));
    check('the repair block shows before and after side by side in the overlay',
      await q(`(() => { const o = document.querySelector('[data-inspect-repair]'); const rows = o.querySelectorAll('.inspect-diff-row');
        return rows.length >= 8 && /Before/.test(o.textContent) && /After/.test(o.textContent) && /could not fix/i.test(o.textContent); })()`));

    // =====================================================================
    // G5 — provenance
    // =====================================================================
    const made = await q(`(async () => { const b = await __bluesheet.exportSTL(); const u = new Uint8Array(b.buffer || b);
      const r = await __bluesheet.inspect.inspectBytes(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), 'exported.stl');
      return { gen: __bluesheet.gen.id, version: __bluesheet.gen.version ?? 1, prov: r.provenance,
               shown: document.querySelector('[data-inspect-prov]').textContent,
               btn: !!document.querySelector('[data-inspect-open-gen="' + __bluesheet.gen.id + '"]') }; })()`);
    check('a Bluesheet-made STL is recognised by its header', !!made.prov && made.prov.gen === made.gen && made.prov.version === made.version,
      JSON.stringify(made.prov));
    check('the overlay says "Made by Bluesheet: <gen> v<n>" and that only the hash is in the header',
      new RegExp(`Made by Bluesheet: ${made.gen} v${made.version}`).test(made.shown) && /hash #[0-9a-f]{8}, not the parameters/.test(made.shown), made.shown.slice(0, 160));
    check('an "Open in generator" button is offered', made.btn === true);

    // Open in generator: switch to another generator first so the click has something to do.
    const other = await q(`__bluesheet.generators.map(g => g.id)`);
    const target = made.gen;
    const alt = other.find(id => id !== target);
    if (alt) {
      // The report for `target`'s export is still on screen. Move the app to a
      // different generator, then press the button the header earned.
      await q(`__bluesheet.setGen(${JSON.stringify(alt)})`);
      const opened = await q(`(async () => {
        const moved = __bluesheet.gen.id;
        const btn = document.querySelector('[data-inspect-open-gen="${target}"]');
        if (btn) btn.click();
        await new Promise(res => setTimeout(res, 50));
        return { moved, gen: __bluesheet.gen.id, closed: document.querySelector('[data-inspect]').hidden }; })()`);
      check('"Open in generator" reopens the generator the header names and closes the inspector',
        opened.moved === alt && opened.gen === target && opened.closed === true, `moved to ${opened.moved}, now ${opened.gen}, closed=${opened.closed}`);
      await until(() => q(`__bluesheet.mesh && __bluesheet.mesh.triCount > 0 && !document.querySelector('[data-busy]').offsetParent`), 30000, 200);
    }

    // The library: a saved design whose provenance matches the header is offered.
    const lib = await q(`(async () => { const entries = await __bluesheet.library.list(); const e = entries.find(x => x.provenance); if (!e) return { none: true };
      const header = ('Bluesheet ' + e.provenance).padEnd(80, ' ');
      const u = new Uint8Array(84); for (let i = 0; i < 80; i++) u[i] = header.charCodeAt(i);
      try { await __bluesheet.inspect.inspectBytes(u.buffer, 'from-library.stl'); } catch (err) {}
      const m = __bluesheet.inspect.savedMatch;
      return { want: e.provenance, name: e.name, match: m && { id: m.id, name: m.name, provenance: m.provenance },
               btn: !!document.querySelector('[data-inspect-open-saved="' + e.id + '"]') }; })()`);
    if (lib.none) {
      check('library lookup by provenance (skipped: the library has no entry with provenance)', true, 'nothing to match against');
    } else {
      check('a saved design with the same provenance is found and offered by name',
        !!lib.match && lib.match.provenance === lib.want && lib.btn === true, `want ${lib.want}, got ${JSON.stringify(lib.match)}, button=${lib.btn}`);
    }

    // =====================================================================
    // G1 — the 30 MB file, without the page freezing
    // =====================================================================
    await q(`(() => { window.__ticks = 0; window.__tickStop = false; const f = () => { if (window.__tickStop) return; window.__ticks++; requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
    const t0 = Date.now();
    const big = await feedFile(large.path, 'large-heightfield.stl');
    const wall = Date.now() - t0;
    const ticks = await q(`(() => { window.__tickStop = true; return window.__ticks; })()`);
    check('the 30 MB STL parses and every triangle is counted', big.triCount === large.triCount,
      `${big.triCount} of ${large.triCount} in ${wall} ms`);
    check('it was parsed in the worker, not on the window thread', big.parsedIn === 'worker', big.parsedIn);
    check('requestAnimationFrame kept ticking throughout the parse', ticks >= Math.min(20, Math.floor(wall / 100)),
      `${ticks} frames in ${wall} ms`);
    check('the big file is measured honestly: watertight, one shell, thickness pass skipped and said so',
      big.watertight && big.shells === 1 && big.deepChecked === false && !!finding(big, 'THICKNESS_SKIPPED'),
      `watertight=${big.watertight} shells=${big.shells} deep=${big.deepChecked}`);
    check('no page error during the big parse', page.errors().filter(e => !/favicon|Download is disallowed/i.test(e)).length === 0,
      page.errors().slice(0, 2).join(' | ') || 'clean');

    // =====================================================================
    // G6 — the front door: "Use this object"
    // =====================================================================
    await feedBytes(fixtures['inside-out-cube'].path, 'inside-out-cube.stl');
    await q(`__bluesheet.inspect.repair()`);
    const used = await q(`(async () => {
      const genBefore = __bluesheet.gen.id, trisBefore = __bluesheet.mesh.triCount;
      document.querySelector('[data-inspect-use]').click();
      const m = __bluesheet.mesh;
      const b = await __bluesheet.exportSTL();
      const u = new Uint8Array(b.buffer || b);
      const stlBytes = await __bluesheet.slicePath.h.stl();
      const su = new Uint8Array(stlBytes.buffer || stlBytes);
      return {
        genBefore, trisBefore, closed: document.querySelector('[data-inspect]').hidden,
        tris: m.triCount, volume: m.volume(), imported: !!__bluesheet.imported, repaired: __bluesheet.imported && __bluesheet.imported.repaired,
        exportLen: u.byteLength, sliceLen: su.byteLength, same: u.byteLength === su.byteLength && u.every((v, i) => v === su[i]),
        name: __bluesheet.objectName(), title: __bluesheet.titleBlock.text(), crumb: document.querySelector('[data-crumb-gen]').textContent,
        status: __bluesheet.status(), analysis: __bluesheet.analysis && __bluesheet.analysis.manifold,
        plateCurrent: __bluesheet.plate.h.current(),
      }; })()`);
    check('"Use this object" makes the imported (repaired) mesh the current one: 12 triangles, +8000 mm³',
      used.imported && used.tris === 12 && Math.abs(used.volume - 8000) < 1e-6 && used.repaired === true, `tris=${used.tris} vol=${used.volume}`);
    check('exportSTL() now hands back that mesh: 84 + 50 × 12 bytes', used.exportLen === 84 + 50 * 12, `${used.exportLen} bytes`);
    check('the slice path\'s stl() returns the very same bytes', used.same === true && used.sliceLen === used.exportLen);
    check('the title block and breadcrumb name the file', /INSIDE-OUT-CUBE/.test(used.title) && used.crumb === 'inside-out-cube.stl' && used.name === 'inside-out-cube',
      `${used.title.slice(0, 80)} | ${used.crumb} | ${used.name}`);
    check('the analysis column shows the imported object\'s own analysis', used.analysis === true && used.closed === true);
    check('the plate does not offer the stale generator object while an import is current', used.plateCurrent === null);

    const back = await q(`(async () => { const q0 = __bluesheet.gen.params.find(p => p.type === 'number' || p.type === 'int');
      if (q0) { await __bluesheet.setParam(q0.key, __bluesheet.params[q0.key]); } else { await __bluesheet.rebuild(); }
      return { imported: !!__bluesheet.imported, tris: __bluesheet.mesh.triCount, crumb: document.querySelector('[data-crumb-gen]').textContent, gen: __bluesheet.gen.name }; })()`);
    check('a parameter change puts the generator\'s object back', back.imported === false && back.tris !== 12 && back.crumb === back.gen,
      `imported=${back.imported} tris=${back.tris} crumb=${back.crumb}`);

    // =====================================================================
    // the console, last
    // =====================================================================
    const errs = page.errors().filter(e => !/favicon|DevTools|Download is disallowed/i.test(e));
    check('the console is clean after all of that', errs.length === 0, errs.slice(0, 3).join(' | ') || 'no errors');
  }, { timeout: 90000 });
} finally {
  stopServer();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }
}

done();
