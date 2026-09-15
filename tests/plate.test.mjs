// The plate, driven in real Chrome against the real server.
//
//   node tests/plate.test.mjs
//   (the service must be up on 8132)
//
// Gates P1 G3–G6: add objects from two generators with quantities, pack them,
// see the packed plate in the viewer with exactly the triangles of its parts,
// survive a reload, register provenance, and — when the slicer is installed —
// slice for real and get a 3mf whose objects sit where Bluesheet put them.
//
// The plate on the server is shared state. The suite saves whatever is there,
// replaces it with its own, and puts the original back at the end, so running
// the tests does not throw away a layout somebody was arranging.

import { suite, check, near, done } from './lib/assert.mjs';
import { withPage } from './lib/cdp.mjs';

suite('plate');

const BASE = process.env.BLUESHEET_URL || 'http://127.0.0.1:8132/';
const saved = await (await fetch(BASE + 'api/plate')).json().catch(() => null);

async function restore() {
  if (!saved || !saved.ok) return;
  if (!saved.plate.items.length) { await fetch(BASE + 'api/plate', { method: 'DELETE' }); return; }
  await fetch(BASE + 'api/plate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: saved.plate.items, gap: saved.plate.gap, rotate: saved.plate.rotate }) });
}

try {
  await withPage(async (page) => {
    const q = (expr) => page.eval(expr);

    // ---- G3: add, pack, show -------------------------------------------
    const first = await q(`(async () => {
      __bluesheet.plate.clearAll();
      await __bluesheet.setGen('gridfinity');
      await __bluesheet.applyPreset('Magnet-mount SMD bin 1×2×3');
      const single = __bluesheet.mesh.triCount;
      const item = __bluesheet.plate.add(2);
      const again = __bluesheet.plate.add(1);            // same object: quantity, not a new row
      await __bluesheet.setGen('coaster');
      await __bluesheet.rebuild();
      const coaster = __bluesheet.mesh.triCount;
      const item2 = __bluesheet.plate.add(1);
      const rows = [...document.querySelectorAll('.plate-item')].map(r => ({
        key: r.dataset.plateKey, qty: r.querySelector('input').value, name: r.querySelector('.plate-item-name').textContent }));
      const shown = await __bluesheet.plate.show();
      const v = __bluesheet.plate.view;
      return { single, coaster, items: __bluesheet.plate.items.length, copies: __bluesheet.plate.copies(), sameKey: item && again && item.key === again.key,
        rows, shown, viewCopies: v && v.copies, tris: v && v.mesh.triCount, fill: v && v.packing.fill, withinBed: v && v.withinBed,
        unplaced: v && v.unplaced.length, active: __bluesheet.plate.active,
        title: document.querySelector('[data-tb-name]').textContent, variant: document.querySelector('[data-tb-variant]').textContent,
        viewerTris: __bluesheet.viewer.stats.tris, manifold: v && v.analysis && v.analysis.manifold, shells: v && v.analysis && v.analysis.shells,
        hash: item && item.hash, gen: item && item.gen,
        placed: v && v.packing.placed.map(p => ({ x: p.x, y: p.y, w: p.w, d: p.d })) };
    })()`);
    check('adding the same object twice adds to its quantity, not the list', first.sameKey && first.items === 2 && first.copies === 4,
      `${first.items} designs, ${first.copies} copies`);
    check('the list shows each design with its quantity', first.rows.length === 2 && first.rows[0].qty === '3' && first.rows[1].qty === '1',
      JSON.stringify(first.rows));
    check('Show plate packs and shows it', first.shown === true && first.active === true, `shown=${first.shown}`);
    // MaxRects is a heuristic: it may leave a copy off that would have fitted.
    // What must hold is that every copy is accounted for and what is shown is
    // exactly what was placed.
    check('every copy is either placed or reported unplaced', first.viewCopies + first.unplaced === 4 && first.viewCopies >= 3,
      `${first.viewCopies} placed, ${first.unplaced} unplaced`);
    check('the plate mesh is exactly the placed parts, no more, no less',
      first.tris === (first.viewCopies - 1) * first.single + first.coaster, `${first.tris} for ${first.viewCopies} copies`);
    check('the viewer is drawing the plate', first.viewerTris === first.tris, `viewer ${first.viewerTris}, plate ${first.tris}`);
    check('the packing keeps every part inside the bed', first.withinBed === true);
    check('no two parts overlap', (() => {
      const p = first.placed;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
        const a = p[i], b = p[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.y - b.y) < (a.d + b.d) / 2 - 1e-6) return false;
      }
      return true;
    })(), JSON.stringify(first.placed));
    check('the title block names the plate and counts the objects', /plate/i.test(first.title) && /4 objects/i.test(first.variant),
      `${first.title} / ${first.variant}`);
    check('the plate is analysed as one closed solid of several shells', first.manifold === true && first.shells === first.viewCopies, `manifold=${first.manifold} shells=${first.shells}`);

    // A parameter change takes the viewer back to the single object.
    const back = await q(`(async () => {
      const p = __bluesheet.gen.params.find(x => x.type === 'number');
      await __bluesheet.setParam(p.key, __bluesheet.params[p.key] === p.min ? p.max : p.min);
      return { active: __bluesheet.plate.active, tris: __bluesheet.viewer.stats.tris, single: __bluesheet.mesh.triCount,
        btn: document.querySelector('[data-plate-show]').getAttribute('aria-pressed') };
    })()`);
    check('changing a parameter returns the viewer to the object', back.active === false && back.tris === back.single && back.btn === 'false',
      `active=${back.active}, viewer ${back.tris}, object ${back.single}`);

    // The gap setting reaches the packer: every copy is still placed at both ends of it.
    const gaps = await q(`(async () => {
      const at = async (g) => { __bluesheet.plate.setGap(g); await __bluesheet.plate.show(); return __bluesheet.plate.view.packing.placed.length; };
      const wide = await at(6), tight = await at(0);
      __bluesheet.plate.setGap(3);
      return { wide, tight };
    })()`);
    check('a smaller gap never places fewer copies', gaps.tight >= gaps.wide && gaps.tight >= 3, JSON.stringify(gaps));

    // ---- G5: provenance ---------------------------------------------------
    await new Promise(r => setTimeout(r, 700));                       // the save is debounced
    const prov = await (await fetch(`${BASE}api/provenance/${first.hash}?gen=${first.gen}`)).json();
    check('putting an object on the plate registers its provenance hash', prov.ok === true && !!prov.entry && prov.entry.gen === first.gen,
      JSON.stringify(prov).slice(0, 120));
    const stored = await (await fetch(BASE + 'api/plate')).json();
    check('the plate is stored on the server with its quantities', stored.ok && stored.plate.items.length === 2 && stored.plate.copies === 4,
      `${stored.plate.items.length} items, ${stored.plate.copies} copies`);

    // ---- G6: survives a reload --------------------------------------------
    const after = await q(`(async () => {
      location.reload();
      return true;
    })()`).catch(() => true);
    await new Promise(r => setTimeout(r, 2500));
    const reloaded = await q(`(async () => {
      while (!(window.__bluesheet && __bluesheet.ready)) await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < 30 && !__bluesheet.plate.items.length; i++) await new Promise(r => setTimeout(r, 100));
      return { items: __bluesheet.plate.items.length, copies: __bluesheet.plate.copies(), gap: __bluesheet.plate.gap,
        rows: document.querySelectorAll('.plate-item').length };
    })()`);
    check('the plate survives a reload', reloaded.items === 2 && reloaded.copies === 4 && reloaded.rows === 2,
      `${reloaded.items} items, ${reloaded.copies} copies, ${reloaded.rows} rows`);
    near('the gap survives a reload', reloaded.gap, 3, 1e-9);

    // ---- G4: a real slice, when the slicer is here ------------------------
    const orca = await q(`!!(__bluesheet.health && __bluesheet.health.slicer && __bluesheet.health.slicer.orca)`);
    if (orca) {
      const sliced = await q(`(async () => {
        const shown = await __bluesheet.plate.show();
        const meta = await __bluesheet.slice();
        return meta && { shown, id: meta.id, layers: meta.layers, objects: (meta.objects || []).length, bbox: meta.bbox,
          verified: (meta.verified || []).length, gcode: !!__bluesheet.gcode, mode: __bluesheet.mode, grams: meta.grams,
          name: document.querySelector('[data-print-note]').textContent };
      })()`);
      check('the plate slices as several objects in one job', !!sliced && sliced.objects === 4 && sliced.layers > 0,
        sliced ? `${sliced.objects} objects, ${sliced.layers} layers, ${sliced.grams} g` : 'slice failed');
      if (sliced) {
        const b = sliced.bbox;
        check('the sliced plate sits inside the bed where Bluesheet placed it',
          b.min[0] >= -90 && b.max[0] <= 90 && b.min[1] >= -90 && b.max[1] <= 90 && b.size[0] > 100,
          `${b.min.map(v => v.toFixed(1))} .. ${b.max.map(v => v.toFixed(1))}`);
        check('the requested settings were verified inside the 3mf', sliced.verified >= 3, `${sliced.verified} verified`);
        check('the toolpath preview loaded for the plate', sliced.gcode === true && sliced.mode === 'gcode', `mode=${sliced.mode}`);
      }
    } else {
      check('slicer not installed here — the real slice is skipped, not faked', true, 'no OrcaSlicer');
    }

    const errs = await page.errors();
    check('the console is clean after all of that', errs.length === 0, errs.slice(0, 3).join(' | ') || 'no errors');
  });
} finally {
  await restore();
}

done();
