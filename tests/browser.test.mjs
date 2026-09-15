// The integration test: not "does a module work" but "does Bluesheet work".
// Boots the real page in real Chrome against the real server, drives it through
// the whole journey a person takes, and fails on anything in the console.
//
//   node tests/browser.test.mjs
// (the service must be up on 8132)
import { suite, check, near, done } from './lib/assert.mjs';
import { withPage } from './lib/cdp.mjs';

suite('browser integration');

await withPage(async (page) => {
  // ---- boot -------------------------------------------------------------
  const boot = await page.eval('({gen: __bluesheet.gen && __bluesheet.gen.id, count: __bluesheet.generators.length, failures: __bluesheet.failures.length})');
  // The catalogue SIZE is the root gate R2's business, not this suite's. What
  // matters here is that whatever is registered actually loads and drives — a
  // count assertion in two places means fixing it in two places.
  check('the page boots and loads the catalogue', boot.count >= 1, `${boot.count} generators, ${boot.failures} failed to load`);
  check('no generator failed to load', boot.failures === 0, `${boot.failures} failures`);
  check('a generator is selected on load', !!boot.gen, boot.gen);

  const title = await page.eval('document.title');
  check('the page is titled', /bluesheet/i.test(title), title);

  // ---- every generator builds through the UI -----------------------------
  const ids = await page.eval('__bluesheet.generators.map(g => g.id)');
  const built = [];
  for (const id of ids) {
    const r = await page.eval(`(async () => {
      await __bluesheet.setGen(${JSON.stringify(id)});
      await __bluesheet.rebuild();
      const m = __bluesheet.mesh, a = __bluesheet.analysis;
      return {id: ${JSON.stringify(id)}, tris: m ? m.triCount : 0,
              size: m ? m.bbox().size.map(v => +v.toFixed(2)) : null,
              manifold: a ? a.manifold : null, vol: a ? +a.volume.toFixed(1) : null};
    })()`);
    built.push(r);
    check(`${id}: builds in the browser`, r.tris > 8, `${r.tris} triangles`);
    check(`${id}: analysis says it is manifold`, r.manifold === true, `manifold=${r.manifold}, volume=${r.vol}`);
    check(`${id}: has real dimensions`, r.size && Math.max(...r.size) > 5 && Math.max(...r.size) <= 180, r.size ? r.size.join(' × ') + ' mm' : 'none');
  }
  check('every generator produced a distinct object', new Set(built.map(b => `${b.tris}|${b.vol}`)).size === built.length,
    `${new Set(built.map(b => `${b.tris}|${b.vol}`)).size} distinct of ${built.length}`);

  // ---- a parameter actually changes the object ---------------------------
  const change = await page.eval(`(async () => {
    await __bluesheet.setGen(__bluesheet.generators[0].id);
    await __bluesheet.rebuild();
    const before = {tris: __bluesheet.mesh.triCount, size: __bluesheet.mesh.bbox().size.slice()};
    const numeric = __bluesheet.gen.params.find(p => p.type === 'number' || p.type === 'int');
    const target = numeric.def === numeric.max ? numeric.min : numeric.max;
    await __bluesheet.setParam(numeric.key, target);
    await __bluesheet.rebuild();
    return {key: numeric.key, from: numeric.def, to: target, before,
            after: {tris: __bluesheet.mesh.triCount, size: __bluesheet.mesh.bbox().size.slice()}};
  })()`);
  check('changing a parameter changes the geometry',
    change.after.tris !== change.before.tris || change.after.size.some((v, i) => Math.abs(v - change.before.size[i]) > 1e-6),
    `${change.key} ${change.from} -> ${change.to}: ${change.before.tris}t ${change.before.size.map(v=>v.toFixed(1)).join('×')} -> ${change.after.tris}t ${change.after.size.map(v=>v.toFixed(1)).join('×')}`);

  // ---- the title block is live -------------------------------------------
  const tb = await page.eval(`(() => {
    const el = document.querySelector('[data-title-block]') || document.querySelector('.title-block');
    return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
  })()`);
  check('the title block exists and names the part', tb && tb.length > 10, tb || 'not found');

  // ---- export -------------------------------------------------------------
  const stl = await page.eval(`(async () => { const b = await __bluesheet.exportSTL(); return {len: b.byteLength || b.length, tris: __bluesheet.mesh.triCount, header: new TextDecoder().decode(new Uint8Array(b.buffer || b).slice(0, 40))}; })()`);
  check('STL export length is 84 + 50 x triangles', stl.len === 84 + 50 * stl.tris, `${stl.len} bytes for ${stl.tris} triangles`);
  check('the STL header carries provenance', /Bluesheet \w/.test(stl.header), JSON.stringify(stl.header.trim()));

  // ---- the catalogue actually opens ---------------------------------------
  // This is where Bluesheet died in front of its first real user: the preview
  // viewer asks for `grid: 0` meaning "no grid", plate.js divided the bed by it,
  // and the resulting Infinity divisions in a quadratic loop pushed vertices
  // until the renderer process was killed. The unit test in render-math covers
  // the arithmetic; this covers the thing a person does — open the drawer and
  // look at the pictures — because the arithmetic was only ever reached through
  // a code path no unit test was exercising.
  const cat = await page.eval(`(async () => {
    __bluesheet.catalogue.open();
    const c = __bluesheet.catalogue;
    const t0 = performance.now();
    while ((c._queue.length || c._working) && performance.now() - t0 < 20000) {
      await new Promise(r => setTimeout(r, 100));
    }
    const cards = Array.from(document.querySelectorAll('[data-thumb]'));
    const painted = cards.filter(cv => {
      const g = cv.getContext('2d');
      if (!g) return false;
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
      return false;
    }).length;
    const nulls = Array.from(c.thumbs.entries()).filter(([, v]) => !v).map(([k]) => k);
    return { open: c.isOpen, cards: cards.length, painted, nulls,
             gens: __bluesheet.generators.length, ms: Math.round(performance.now() - t0) };
  })()`);
  check('the catalogue opens and stays open', cat.open === true);
  check('the catalogue shows a card per generator', cat.cards === cat.gens,
    `${cat.cards} cards for ${cat.gens} generators`);
  check('every card gets a rendered preview', cat.nulls.length === 0 && cat.painted === cat.cards,
    `${cat.painted}/${cat.cards} painted${cat.nulls.length ? ', failed: ' + cat.nulls.join(', ') : ''} in ${cat.ms} ms`);
  // The crash killed the renderer, so the proof it is gone is that the page can
  // still answer a question afterwards.
  const alive = await page.eval('({tabs: __bluesheet.generators.length, title: document.title.slice(0, 20)})');
  check('the page is still alive after the catalogue has run', alive.tabs > 0, JSON.stringify(alive));
  await page.eval('(() => { __bluesheet.catalogue.close(); return 1 })()');

  // ---- the rebuild race ---------------------------------------------------
  // A build reports twice: the mesh, then the analysis. `rebuild()` nulls
  // `result` to force a fresh build, and landing that in the gap between the two
  // used to make the arriving analysis unrecognisable — so the job never
  // finished, the queue never advanced, and every promise waiting on the builder
  // hung for ever. It cost this suite's sibling, ui.test.mjs, its entire second
  // half, and it is the kind of race that never shows up in a unit test because
  // it needs a real worker and real message ordering.
  //
  // Deterministic because the ordering is: mesh always precedes its analysis.
  const race = await page.eval(`(async () => {
    const { Builder } = await import('/js/ui/build.js');
    const b = new Builder({});
    const req = { genId: __bluesheet.generators[0].id, quality: 'draft', params: {} };
    const om = b._onMessage.bind(b);
    let raced = false;
    b._onMessage = (m) => {
      const out = om(m);
      // The moment the mesh lands and before its analysis can: the exact gap.
      if (m.type === 'mesh' && !raced) { raced = true; b.rebuild(req); }
      return out;
    };
    const settled = await Promise.race([
      b.build(req, { immediate: true }).then(r => ({ ok: true, key: r.key })),
      new Promise(r => setTimeout(() => r({ ok: false, why: 'builder never settled' }), 20000)),
    ]);
    const state = { running: !!b.running, waiters: b.waiters.length };
    b.dispose();
    return { ...settled, raced, ...state };
  })()`);
  check('a rebuild during a build still settles', race.ok === true && race.raced === true,
    race.ok ? `raced=${race.raced}, key ${String(race.key).slice(0, 20)}…` : race.why);
  check('and leaves nothing in flight behind it',
    race.running === false && race.waiters === 0,
    `running=${race.running}, ${race.waiters} waiters`);

  // ---- clean console ------------------------------------------------------
  const errs = page.errors().filter(e => !/favicon|DevTools/i.test(e));
  check('the console is clean', errs.length === 0, errs.slice(0, 3).join(' | ') || 'no errors');
});

done();
