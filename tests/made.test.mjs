// The Made panel, driven in real Chrome against its own server.
//
//   node tests/made.test.mjs
//
// This suite does not touch the service on :8132. It starts a second server.py
// on an ephemeral port with BLUESHEET_MADE_DIR pointed at a scratch directory,
// seeds that directory with one job in every state the log knows — with a real
// PNG render and a real JPEG photograph beside the finished one — and points the
// printer telemetry at a port nothing listens on, so the watcher can only ever
// say "unreachable" and cannot move the seeded printing job. Then it opens the
// panel with a real click and reads the cards back out of the DOM.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { suite, check, done } from './lib/assert.mjs';

suite('made panel');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- an isolated server ----------------------------------------------------

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const port = await freePort();
const madeDir = mkdtempSync(join(tmpdir(), 'bluesheet-made-'));
mkdirSync(join(madeDir, 'renders'));
mkdirSync(join(madeDir, 'photos'));

// Real image bytes, because the check on the card is "the browser decoded it".
const img = spawnSync('python3', ['-c', `
from PIL import Image, ImageDraw
import sys
r = Image.new('RGB', (160, 120), (13, 22, 33)); ImageDraw.Draw(r).rectangle([30, 20, 130, 100], outline=(127, 166, 199), width=3)
r.save(sys.argv[1] + '/renders/E.png')
p = Image.new('RGB', (320, 240), (90, 80, 70)); ImageDraw.Draw(p).ellipse([80, 40, 240, 200], fill=(200, 190, 180))
p.save(sys.argv[1] + '/photos/E.jpg', quality=80)
`, madeDir], { encoding: 'utf8' });
if (img.status !== 0) throw new Error(`could not make test images: ${img.stderr}`);

const T0 = 1_780_000_000;
const ev = (t, what, detail = '') => ({ t, at: new Date(t * 1000).toISOString().slice(0, 19), what, detail });
const base = (id, state, created, extra = {}) => ({
  id, sliceId: `s${id.toLowerCase()}0000000000000`.slice(0, 16), state,
  createdAt: created, created: new Date(created * 1000).toISOString().slice(0, 19),
  updatedAt: created, updated: new Date(created * 1000).toISOString().slice(0, 19),
  gen: 'gridfinity', genName: 'Gridfinity bin', name: `Job ${id}`, params: { units: 2 },
  provenance: 'gridfinity v1 #test', version: 1, settings: {}, profileLabel: 'Standard · 0.20 mm',
  estimate: { seconds: 3600, minutes: 60, timeText: '1h 0m 0s', totalSeconds: 3700, grams: 12.5, gramsEstimated: false, layers: 200, filamentMm: 4000 },
  actual: { seconds: null, minutes: null, grams: null, gramsSource: null, layers: null, timing: null },
  sd: null, photo: null, photoError: null, render: null, print: {}, error: null, notes: '',
  events: [ev(created, 'sliced', '1h 0m 0s · 12.50 g · 200 layers')], objects: [`job-${id}`],
  ...extra,
});

const jobs = [
  base('A', 'sliced', T0 + 10),
  base('B', 'uploaded', T0 + 20, { sd: { name: 'job-b-sb00000000000000.gcode.3mf', bytes: 1000, at: T0 + 21 } }),
  base('C', 'failed', T0 + 30, {
    error: 'the printer reported the print failed at 31%',
    print: { startedAt: T0 + 31, startedAtSource: 'observed', percent: 31, layer: 60, endedAt: T0 + 1200 },
    actual: { seconds: 1169, minutes: 19.48, grams: null, gramsSource: null, layers: 60, timing: 'observed' },
  }),
  base('D', 'unknown', T0 + 40, {
    error: 'the printer stopped reporting this print at 12% (it now reports IDLE)',
    print: { startedAt: T0 + 41, startedAtSource: 'observed', percent: 12, layer: 24, endedAt: T0 + 500 },
    actual: { seconds: 459, minutes: 7.65, grams: null, gramsSource: null, layers: 24, timing: 'unobserved' },
  }),
  base('E', 'made', T0 + 50, {
    gen: 'coaster', genName: 'Coaster', name: 'Flower coaster',
    params: { size: 123, outline: 'circle' },
    render: { file: 'E.png', bytes: 1, type: 'image/png' },
    photo: { file: 'E.jpg', bytes: 1, at: T0 + 4000, width: 320, height: 240, source: 'test' },
    print: { startedAt: T0 + 60, startedAtSource: 'observed', percent: 100, layer: 200, endedAt: T0 + 60 + 4320 },
    actual: { seconds: 4320, minutes: 72, grams: null, gramsSource: null, layers: 200, timing: 'observed' },
    events: [ev(T0 + 50, 'sliced'), ev(T0 + 55, 'uploaded', 'flower-coaster.gcode.3mf'), ev(T0 + 60, 'printing', 'at 0%'),
      ev(T0 + 4380, 'made', '1 h 12 m against an estimate of 1 h 00 m'), ev(T0 + 4381, 'photographed', '320×240, 4 kB')],
  }),
  base('F', 'printing', T0 + 60, {
    sd: { name: 'job-f-sf00000000000000.gcode.3mf', bytes: 2000, at: T0 + 61 },
    print: { startedAt: T0 + 70, startedAtSource: 'observed', percent: 42, layer: 57, totalLayers: 541, remainingMin: 88, lastSeenAt: T0 + 2000, stale: false },
  }),
];
for (const j of jobs) writeFileSync(join(madeDir, `${j.id}.json`), JSON.stringify(j, null, 1));
const NEWEST_FIRST = jobs.slice().sort((a, b) => b.createdAt - a.createdAt).map(j => j.id);

const server = spawn('python3', [join(ROOT, 'server.py')], {
  cwd: ROOT,
  env: {
    ...process.env,
    BLUESHEET_PORT: String(port),
    BLUESHEET_MADE_DIR: madeDir,
    BLUESHEET_GLADYS_API: 'http://127.0.0.1:1',       // nothing listens: the watcher stays "unreachable"
    BLUESHEET_CAMERA_URL: 'http://127.0.0.1:1/none.jpg',
    BLUESHEET_MADE_POLL: '3600',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const stopServer = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } try { rmSync(madeDir, { recursive: true, force: true }); } catch { /* fine */ } };
process.once('exit', stopServer);

const URL_ = `http://127.0.0.1:${port}/`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  up = await fetch(`${URL_}api/health`).then(r => r.ok).catch(() => false);
  if (!up) await sleep(100);
}
check('a private server starts on an ephemeral port with its own Made dir', up, `${URL_} (${madeDir})`);
if (!up) { console.log(serverLog.slice(-800)); stopServer(); done(); process.exit(1); }

const seeded = await fetch(`${URL_}api/made`).then(r => r.json());
check('the seeded jobs are what the API lists, newest first',
  seeded.ok && seeded.jobs.map(j => j.id).join('') === NEWEST_FIRST.join(''),
  seeded.jobs.map(j => `${j.id}:${j.state}`).join(' '));

// The CDP helper reads its URL at import time, so set it before importing.
process.env.BLUESHEET_URL = URL_;
process.env.BLUESHEET_CDP_PORT = process.env.BLUESHEET_CDP_PORT || '9337';
const { withPage } = await import('./lib/cdp.mjs');

try {
  await withPage(async (page) => {
    const q = (expr) => page.eval(expr);
    const clickAt = async (sel) => {
      const r = await q(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' });
        const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const at = document.elementFromPoint(x, y);
        return {x, y, hits: !!at && (e === at || e.contains(at) || at.contains(e)), at: at ? at.tagName + '.' + at.className : 'nothing'}; })()`);
      if (!r) throw new Error(`no element ${sel}`);
      if (!r.hits) throw new Error(`${sel} is covered by ${r.at}`);
      await page.sleep(30);
      await page.click(r.x, r.y);
      return r;
    };
    const until = async (expr, ms = 8000) => {
      const end = Date.now() + ms;
      let v;
      while (Date.now() < end) { v = await q(expr).catch(() => false); if (v) return v; await page.sleep(120); }
      return v;
    };

    // ---- the page and the button --------------------------------------
    const head = await q(`(() => { const b = document.querySelector('[data-open-made]');
      return { present: !!b, text: b && b.textContent.trim(), made: 'made' in __bluesheet,
               overlayHidden: document.querySelector('[data-made]').hidden }; })()`);
    check('the header has a Made button', head.present && head.text === 'Made', head.text);
    check('window.__bluesheet exposes the made panel', head.made === true);
    check('the Made overlay starts hidden', head.overlayHidden === true);

    // Count the listing fetches from here on: the refresh-timer checks need it.
    await q(`(() => { window.__madeFetches = 0; const f = window.fetch;
      window.fetch = function (u, ...rest) { if (String(u).includes('api/made')) window.__madeFetches++; return f.call(this, u, ...rest); }; return true; })()`);

    await clickAt('[data-open-made]');
    const opened = await until(`document.querySelectorAll('[data-made-cards] .card').length === ${jobs.length} && !document.querySelector('[data-made]').hidden`);
    check('clicking Made opens the panel with one card per job', opened === true,
      `${await q(`document.querySelectorAll('[data-made-cards] .card').length`)} cards`);

    // ---- the cards -----------------------------------------------------
    const cards = await q(`[...document.querySelectorAll('[data-made-cards] .card')].map(c => ({
      id: c.dataset.job, state: c.dataset.state, name: c.querySelector('.card-name').textContent,
      cat: c.querySelector('.card-cat').textContent, stateText: c.querySelector('.made-state').textContent,
      err: (c.querySelector('.made-error') || {}).textContent || '',
      aTime: c.querySelector('[data-actual-time]').textContent, aGrams: c.querySelector('[data-actual-grams]').textContent,
      nums: [...c.querySelectorAll('.made-cmp .num')].map(n => n.textContent),
      verdict: c.querySelector('.made-verdict').textContent,
      events: c.querySelectorAll('.made-events li').length, eventsOpen: c.querySelector('.made-events').open,
      imgs: [...c.querySelectorAll('img.made-img')].map(i => i.getAttribute('src')),
      none: [...c.querySelectorAll('.made-img--none')].map(n => n.textContent),
      again: !!c.querySelector('[data-make-another]'), notes: !!c.querySelector('.made-notes'),
      weigh: !!c.querySelector('.made-grams'), retake: !!c.querySelector('[data-retake]'),
    }))`);
    const byId = Object.fromEntries(cards.map(c => [c.id, c]));
    check('cards are in order, newest first', cards.map(c => c.id).join('') === NEWEST_FIRST.join(''), cards.map(c => c.id).join(' '));
    check('every card carries the generator name and the object name',
      cards.every(c => c.name.length && c.cat.includes(jobs.find(j => j.id === c.id).genName)), `${byId.E.name} / ${byId.E.cat}`);
    check('every card has a Make another button and a notes field', cards.every(c => c.again && c.notes));

    const F = byId.F;
    check('the printing card shows the live percentage', /42%/.test(F.stateText), F.stateText);
    check('the printing card shows the layer count', /layer 57 \/ 541/.test(F.stateText), F.stateText);
    check('the printing card says it is not finished rather than inventing an actual', F.aTime === 'not finished' && F.aGrams === '—', `${F.aTime} / ${F.aGrams}`);
    check('the printing card has no photograph yet and says so', F.none.includes('not yet') && F.imgs.length === 0, F.none.join(', '));

    const E = byId.E;
    check('the made card shows the estimate', E.nums[0] === '1h 0m 0s' && E.nums[2] === '12.5 g', E.nums.join(' | '));
    check('the made card shows the actual time against it', E.aTime === '1 h 12 m', E.aTime);
    check('the made card says "not weighed" rather than inventing grams', E.aGrams === 'not weighed', E.aGrams);
    check('the made card scores the estimate in plain words', /Took 20% longer/.test(E.verdict), E.verdict);
    check('the made card has a render and a photograph side by side',
      E.imgs.length === 2 && E.imgs[0].startsWith('/api/made/E/render') && E.imgs[1].startsWith('/api/made/E/photo.jpg'), E.imgs.join(' , '));
    const decoded = await until(`(() => { const im = [...document.querySelectorAll('[data-job="E"] img.made-img')];
      return im.length === 2 && im.every(i => i.complete && i.naturalWidth > 0) ? im.map(i => i.naturalWidth + 'x' + i.naturalHeight) : false; })()`);
    check('both images decode in the browser (real bytes, real src)', Array.isArray(decoded) && decoded[0] === '160x120' && decoded[1] === '320x240', JSON.stringify(decoded));
    check('a finished print offers a weight input; a live one does not', E.weigh && byId.C.weigh && !F.weigh && !byId.A.weigh);
    check('the events list is present, collapsed, and complete', E.events === 5 && E.eventsOpen === false, `${E.events} events, open=${E.eventsOpen}`);

    check('the failed card shows the state and the printer\'s reason', byId.C.state === 'failed' && /failed at 31%/.test(byId.C.err), byId.C.err);
    check('the unknown card keeps the last percentage seen', byId.D.state === 'unknown' && /12%/.test(byId.D.err), byId.D.err);
    check('an unobserved print is not scored, and says why', /Not timed|not scored|Not scored/.test(byId.D.verdict), byId.D.verdict);
    check('a finished print with no photograph offers to take one', byId.C.retake && byId.D.retake && !E.retake);
    check('sliced and uploaded cards are honest about having no actual', byId.A.aTime === 'not finished' && byId.B.state === 'uploaded', `${byId.A.aTime} / ${byId.B.stateText}`);

    // ---- the header line ------------------------------------------------
    const headLine = await q(`({ summary: document.querySelector('[data-made-summary]').textContent,
      watcher: document.querySelector('[data-made-watcher]').textContent,
      reachable: document.querySelector('[data-made-watcher]').dataset.reachable })`);
    check('the header states the running accuracy: median ratio and sample count',
      /×0\.76/.test(headLine.summary) && /over 2 timed prints/.test(headLine.summary), headLine.summary);
    check('the header states the watcher is unreachable when it is', headLine.reachable === 'no' && /unreachable/.test(headLine.watcher), headLine.watcher);

    // ---- notes round-trip ----------------------------------------------
    await q(`(() => { const t = document.querySelector('[data-job="E"] .made-notes'); t.focus(); t.value = 'Came out well; brim was a nuisance.'; t.blur(); return true; })()`);
    const notes = await until(`fetch('api/made/E').then(r => r.json()).then(b => b.job.notes === 'Came out well; brim was a nuisance.' ? b.job.notes : false)`);
    check('notes save on blur and come back from the server', notes === 'Came out well; brim was a nuisance.', String(notes));
    const notesKept = await q(`(async () => { await __bluesheet.made.refresh(); return document.querySelector('[data-job="E"] .made-notes').value; })()`);
    check('the saved note survives a refresh of the listing', notesKept === 'Came out well; brim was a nuisance.', notesKept);

    // ---- weighing ----------------------------------------------------------
    await q(`(() => { const i = document.querySelector('[data-job="E"] .made-grams'); i.value = '13.4'; i.dispatchEvent(new Event('change')); return true; })()`);
    const weighed = await until(`(() => { const t = document.querySelector('[data-job="E"] [data-actual-grams]').textContent; return /13\\.4 g \\(weighed\\)/.test(t) ? t : false; })()`);
    check('a weighed figure is recorded with its source and scored', /13\.4 g \(weighed\)/.test(String(weighed)), String(weighed));
    const gramsVerdict = await q(`document.querySelector('[data-job="E"] .made-verdict').textContent`);
    check('the verdict now covers weight too', /weight over by 7%/.test(gramsVerdict), gramsVerdict);

    // ---- the refresh timer ------------------------------------------------
    check('the refresh interval defaults to five seconds', await q(`__bluesheet.made.refreshMs`) === 5000);
    check('a printing job arms the refresh timer while the panel is open', await q(`__bluesheet.made.refreshing`) === true);
    await q(`(() => { __bluesheet.made.refreshMs = 250; window.__madeFetches = 0; return __bluesheet.made.refresh(); })()`);
    await page.sleep(1100);
    const ticking = await q(`window.__madeFetches`);
    check('the listing is re-read on the timer while a job is printing', ticking >= 3, `${ticking} fetches in 1.1 s at 250 ms`);

    await q(`__bluesheet.made.close()`);
    const afterClose = await q(`({ hidden: document.querySelector('[data-made]').hidden, timer: __bluesheet.made.refreshing, n: window.__madeFetches })`);
    await page.sleep(1000);
    const later = await q(`window.__madeFetches`);
    check('closing the panel stops the timer', afterClose.hidden === true && afterClose.timer === false);
    check('no listing fetch happens after close (would FAIL if the timer kept running)', later === afterClose.n, `${afterClose.n} -> ${later} over 1 s`);

    // ---- Escape ----------------------------------------------------------
    await clickAt('[data-open-made]');
    await until(`!document.querySelector('[data-made]').hidden && document.querySelector('[data-made]').contains(document.activeElement)`);
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
    const esc = await until(`document.querySelector('[data-made]').hidden === true && __bluesheet.made.refreshing === false`);
    check('Escape closes the panel and stops the timer', esc === true);

    // ---- Make another ------------------------------------------------------
    await q(`__bluesheet.made.open()`);
    await until(`document.querySelector('[data-make-another="E"]')`);
    const before = await q(`__bluesheet.gen.id`);
    await clickAt('[data-make-another="E"]');
    const loaded = await until(`__bluesheet.gen.id === 'coaster' && __bluesheet.params.size === 123 && document.querySelector('[data-made]').hidden
      ? ({ gen: __bluesheet.gen.id, size: __bluesheet.params.size, outline: __bluesheet.params.outline, status: __bluesheet.status().key }) : false`, 15000);
    check('Make another switches the editor to that generator', loaded && loaded.gen === 'coaster', `${before} -> ${loaded && loaded.gen}`);
    check('Make another restores those exact parameters', loaded && loaded.size === 123 && loaded.outline === 'circle', JSON.stringify(loaded));
    const rebuilt = await until(`__bluesheet.mesh && __bluesheet.mesh.triCount > 8 ? __bluesheet.mesh.triCount : false`, 20000);
    check('the reloaded object builds', rebuilt > 8, `${rebuilt} triangles`);

    // ---- the slice hook -------------------------------------------------------
    const rec = await q(`(async () => { const f = await __bluesheet.slicePath.h.madeRecord();
      const im = new Image(); im.src = f.render; await im.decode();
      return { gen: f.gen, genName: f.genName, name: f.name, keys: Object.keys(f.params).length, prov: f.provenance,
               w: im.naturalWidth, h: im.naturalHeight, kb: Math.round(f.render.length / 1024) }; })()`);
    check('the slice path can ask the app for the Made record fields', rec.gen === 'coaster' && rec.genName && rec.name && rec.keys > 0 && /coaster/.test(rec.prov), `${rec.gen} "${rec.name}" ${rec.keys} params`);
    check('the render is a decodable PNG no wider than 320 px and under the server cap', rec.w > 0 && rec.w <= 320 && rec.kb < 512, `${rec.w}×${rec.h}, ${rec.kb} kB`);

    // If the slicer is installed, a real slice must land in the log.
    const health = await q(`__bluesheet.health`);
    if (health && health.slicer && health.slicer.orca) {
      const sliced = await q(`(async () => { const m = await __bluesheet.slice(); return m && m.id; })()`);
      const landed = sliced && await until(`fetch('api/made').then(r => r.json()).then(b => { const j = b.jobs.find(j => j.sliceId === ${JSON.stringify(sliced)}); return j ? ({ state: j.state, gen: j.gen, render: !!j.renderUrl }) : false; })`, 20000);
      check('a real slice records a job in the Made log with its render', landed && landed.state === 'sliced' && landed.gen === 'coaster' && landed.render, JSON.stringify(landed));
    } else {
      console.log('  (the slicer is not installed here, so the real-slice check is skipped)');
    }

    const errs = page.errors().filter(e => !/favicon/.test(e));
    check('the page threw no errors while all this happened', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
  }, { timeout: 90000 });
} finally {
  stopServer();
}

done();
