// The interface, driven in real Chrome against the real server.
//
//   node tests/ui.test.mjs
//   (the service must be up on 8132)
//
// Two halves, deliberately. Half of these checks go through window.__bluesheet,
// which is how a test drives an application rather than a picture of one. The
// other half dispatch real mouse events at real pixel coordinates through the
// CDP input pipeline, because a test handle that works while the buttons do not
// is exactly the failure this project is trying to avoid.
//
// The measurements are measurements: computed styles read out of the live page,
// contrast ratios calculated from the colours the browser actually resolved,
// arrowhead geometry read off the SVG the overlay drew, and layout asserted
// after really resizing the viewport rather than by reading a media query.

import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { withPage } from './lib/cdp.mjs';

suite('ui integration');

const HEX = {
  sheet: 'rgb(13, 22, 33)',
  raised: 'rgb(20, 32, 46)',
  sunk: 'rgb(10, 18, 27)',
  line: 'rgb(127, 166, 199)',
  lineFaint: 'rgb(51, 71, 92)',
  ink: 'rgb(233, 242, 250)',
  inkDim: 'rgb(157, 180, 201)',
  heat: 'rgb(255, 106, 31)',
  heatDim: 'rgb(138, 58, 21)',
  caution: 'rgb(242, 201, 76)',
};

await withPage(async (page) => {
  const q = (expr) => page.eval(expr);

  // =====================================================================
  // G1 — it boots
  // =====================================================================
  const boot = await q(`({
    ready: __bluesheet.ready,
    keys: ['ready','gen','generators','failures','params','mesh','analysis','viewer','rebuild','setGen','setParam','applyPreset','setMode','exportSTL','slice','library'].filter(k => !(k in __bluesheet)),
    gens: __bluesheet.generators.length,
    fails: __bluesheet.failures.map(f => f.id),
    gen: __bluesheet.gen && __bluesheet.gen.id,
    title: document.title,
  })`);
  check('the page boots and window.__bluesheet.ready is true', boot.ready === true, `ready=${boot.ready}`);
  check('the handle exposes every documented key', boot.keys.length === 0, boot.keys.join(', ') || 'all present');
  check('the catalogue loaded generators', boot.gens > 0, `${boot.gens} generators`);
  check('no generator failed to load', boot.fails.length === 0, boot.fails.join(', ') || 'none');
  check('a generator is selected on load', !!boot.gen, boot.gen || 'none');
  check('the document is titled for the object', /bluesheet/i.test(boot.title), boot.title);

  if (!boot.gens) {
    check('THERE ARE NO GENERATORS TO DRIVE — the rest of this suite cannot run', false,
      'js/gen/ contains only index.js');
    return done();
  }

  const built = await q(`(async () => { await __bluesheet.rebuild(); return {
    tris: __bluesheet.mesh.triCount, manifold: __bluesheet.analysis.manifold,
    size: __bluesheet.mesh.bbox().size.map(v => +v.toFixed(3)),
  }; })()`);
  check('the selected generator builds through the interface', built.tris > 8, `${built.tris} triangles`);
  check('the analysis column has a real analysis behind it', built.manifold === true, `manifold=${built.manifold}`);

  // =====================================================================
  // G4 — the design direction, read out of the built page
  // =====================================================================
  const tokens = await q(`(() => {
    const s = getComputedStyle(document.documentElement);
    const px = (n) => s.getPropertyValue(n).trim();
    return {sheet: px('--sheet'), raised: px('--sheet-raised'), sunk: px('--sheet-sunk'),
            line: px('--line'), lineFaint: px('--line-faint'), ink: px('--ink'),
            inkDim: px('--ink-dim'), heat: px('--heat'), heatDim: px('--heat-dim'),
            caution: px('--caution')};
  })()`);
  const wanted = {
    sheet: '#0D1621', raised: '#14202E', sunk: '#0A121B', line: '#7FA6C7',
    lineFaint: '#33475C', ink: '#E9F2FA', inkDim: '#9DB4C9', heat: '#FF6A1F',
    heatDim: '#8A3A15', caution: '#F2C94C',
  };
  const wrong = Object.entries(wanted).filter(([k, v]) => tokens[k].toUpperCase() !== v);
  check('all ten palette tokens are the exact hex values from docs/design.md',
    wrong.length === 0, wrong.map(([k, v]) => `${k}=${tokens[k]} want ${v}`).join(', ') || Object.values(tokens).join(' '));

  const faces = await q(`(() => {
    const f = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).fontFamily : 'none'; };
    return {label: f('.lbl'), num: f('.num'), tbTitle: f('.tb-title'), tbValue: f('[data-tb-size]'),
            prose: f('.prose'), dimValue: f('.dim-value')};
  })()`);
  check('labels are lettered in Archivo Narrow', /Archivo Narrow/.test(faces.label), faces.label);
  check('the title block is lettered in Archivo Narrow', /Archivo Narrow/.test(faces.tbTitle), faces.tbTitle);
  check('numbers are set in IBM Plex Mono', /IBM Plex Mono/.test(faces.num), faces.num);
  check('the title block values are mono too', /IBM Plex Mono/.test(faces.tbValue), faces.tbValue);
  check('prose is IBM Plex Sans, the one proportional face', /IBM Plex Sans/.test(faces.prose), faces.prose);

  const radii = await q(`(() => {
    const bad = [];
    for (const e of document.querySelectorAll('*')) {
      const r = getComputedStyle(e);
      for (const k of ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']) {
        const v = parseFloat(r[k]);
        if (v > 2.01 && !/%/.test(r[k])) bad.push(e.className + ' ' + k + '=' + r[k]);
      }
    }
    return bad.slice(0, 6);
  })()`);
  check('nothing on the page is rounder than 2px', radii.length === 0, radii.join(' | ') || 'no radius over 2px');

  const greens = await q(`(() => {
    const hue = (r, g, b) => {
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
      if (!d) return {h: 0, s: 0, l: mx/255};
      let h = mx === r ? ((g-b)/d)%6 : mx === g ? (b-r)/d + 2 : (r-g)/d + 4;
      h *= 60; if (h < 0) h += 360;
      const l = (mx+mn)/2/255;
      return {h, s: d/255/(1 - Math.abs(2*l - 1) || 1), l};
    };
    const bad = [];
    const look = (label, v) => {
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(v || '');
      if (!m) return;
      if (m[4] !== undefined && parseFloat(m[4]) < 0.06) return;
      const c = hue(+m[1], +m[2], +m[3]);
      if (c.h > 75 && c.h < 165 && c.s > 0.15 && c.l > 0.08 && c.l < 0.95) bad.push(label + ' ' + v);
    };
    for (const e of document.querySelectorAll('*')) {
      const s = getComputedStyle(e);
      const tag = (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')).slice(0, 40);
      for (const k of ['color','backgroundColor','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','outlineColor','fill','stroke']) look(tag + ' ' + k, s[k]);
    }
    return bad.slice(0, 6);
  })()`);
  check('there is no green anywhere on the page', greens.length === 0, greens.join(' | ') || 'nothing in the green band');

  const heatUse = await q(`(() => {
    const heat = 'rgb(255, 106, 31)';
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const s = getComputedStyle(e);
      if (s.color === heat || s.backgroundColor === heat || s.borderTopColor === heat || s.fill === heat) {
        out.push((e.getAttribute('class') || e.tagName) + '|' + (e.dataset ? Object.keys(e.dataset).join(',') : ''));
      }
    }
    return out;
  })()`);
  const heatAllowed = heatUse.filter(t => !/slice|print|heat|warn--error|is-bad|status|confirm|progress/i.test(t));
  check('--heat appears only on the slice/print path and on errors',
    heatAllowed.length === 0, heatUse.join(' | ') || 'not currently painted anywhere');

  // =====================================================================
  // G5 — the title block is live
  // =====================================================================
  const tbWhere = await q(`(() => {
    const tb = document.querySelector('[data-title-block]').getBoundingClientRect();
    const st = document.querySelector('[data-stage]').getBoundingClientRect();
    return {right: st.right - tb.right, bottom: st.bottom - tb.bottom, inside: tb.left > st.left && tb.top > st.top,
            w: Math.round(tb.width), h: Math.round(tb.height)};
  })()`);
  check('the title block is anchored bottom-right inside the viewport',
    tbWhere.inside && tbWhere.right < 20 && tbWhere.bottom < 20,
    `${tbWhere.w}×${tbWhere.h} px, ${tbWhere.right.toFixed(0)} from the right and ${tbWhere.bottom.toFixed(0)} from the bottom of the model space`);

  const tb1 = await q(`(() => {
    const g = (s) => document.querySelector(s).textContent.trim();
    return {name: g('[data-tb-name]'), rev: g('[data-tb-rev]'), size: g('[data-tb-size]'),
            variant: g('[data-tb-variant]'), material: g('[data-tb-material]'),
            scale: g('[data-tb-scale]'), volume: g('[data-tb-volume]'), mass: g('[data-tb-mass]')};
  })()`);
  check('the title block names the generator', tb1.name.length > 1 && tb1.name === tb1.name.toUpperCase(), tb1.name);
  check('the title block states a variant', tb1.variant.length > 0, tb1.variant);
  check('the title block states the material', /[A-Z]/.test(tb1.material), tb1.material);
  check('the title block states the scale', /^[\d.]+:[\d.]+$/.test(tb1.scale), tb1.scale);
  check('the title block states the bounding dimensions', /\d.*×.*×.*mm/.test(tb1.size), tb1.size);
  check('the title block states the volume', /cm³/.test(tb1.volume), tb1.volume);
  check('the title block states the mass', /g$/.test(tb1.mass), tb1.mass);

  // Find a numeric parameter with room to move, on the current generator.
  const numKey = await q(`(() => {
    const p = __bluesheet.gen.params.find(p => (p.type === 'number' || p.type === 'int') && p.max > p.min);
    return p ? {key: p.key, def: __bluesheet.params[p.key], min: p.min, max: p.max, step: p.step, label: p.label} : null;
  })()`);
  check('the generator declares a numeric parameter to drive', !!numKey, numKey ? `${numKey.key} (${numKey.min}…${numKey.max})` : 'none');

  const tb2 = await q(`(async () => {
    const p = ${JSON.stringify(numKey)};
    const target = Math.abs(p.max - p.def) > Math.abs(p.def - p.min) ? p.max : p.min;
    await __bluesheet.setParam(p.key, target);
    const g = (s) => document.querySelector(s).textContent.trim();
    return {rev: g('[data-tb-rev]'), size: g('[data-tb-size]'), to: target};
  })()`);
  check('changing a parameter ticks the revision', Number(tb2.rev) > Number(tb1.rev), `${tb1.rev} -> ${tb2.rev}`);
  check('changing a parameter changes the stated dimensions', tb2.size !== tb1.size, `${tb1.size} -> ${tb2.size}`);

  // =====================================================================
  // G6 — ISO 128 dimension callouts
  // =====================================================================
  await q(`(() => { __bluesheet.setFocusParam(null); __bluesheet.dims.render(); return true; })()`);
  const bboxDims = await q(`(() => {
    const g = [...document.querySelectorAll('.dimlayer .dim')];
    return g.map(n => ({
      faint: n.classList.contains('dim--faint'),
      ext: n.querySelectorAll('.dim-ext').length,
      lines: n.querySelectorAll('.dim-line').length,
      arrows: n.querySelectorAll('polygon.dim-arrow').length,
      value: (n.querySelector('.dim-value') || {}).textContent,
      transform: (n.querySelector('.dim-value') || {}).getAttribute ? n.querySelector('.dim-value').getAttribute('transform') : null,
    }));
  })()`);
  check('with nothing focused the three bounding-box dimensions are drawn',
    bboxDims.length === 3, `${bboxDims.length} callouts`);
  check('the bounding-box dimensions are drawn faintly',
    bboxDims.length > 0 && bboxDims.every(d => d.faint), bboxDims.map(d => d.faint).join(','));
  check('each callout has two extension lines standing off the surface',
    bboxDims.length > 0 && bboxDims.every(d => d.ext === 2), bboxDims.map(d => d.ext).join(','));
  check('each callout has filled arrowheads at both ends',
    bboxDims.length > 0 && bboxDims.every(d => d.arrows === 2), bboxDims.map(d => d.arrows).join(','));
  check('each callout puts its value in a break in the line',
    bboxDims.length > 0 && bboxDims.every(d => d.lines === 2 && /\d/.test(d.value || '')),
    bboxDims.map(d => `${d.lines} segments, "${d.value}"`).join(' | '));
  check('the value stays horizontal however the line is angled',
    bboxDims.every(d => !d.transform), bboxDims.map(d => d.transform || 'no rotation').join(','));

  const arrow = await q(`(() => {
    const p = document.querySelector('.dimlayer polygon.dim-arrow');
    if (!p) return null;
    const pts = p.getAttribute('points').trim().split(/\\s+/).map(s => s.split(',').map(Number));
    const [tip, a, b] = pts;
    const mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
    const len = Math.hypot(mid[0]-tip[0], mid[1]-tip[1]);
    const half = Math.hypot(a[0]-b[0], a[1]-b[1]) / 2;
    return {n: pts.length, len, included: 2 * Math.atan2(half, len) * 180 / Math.PI, fill: getComputedStyle(p).fill};
  })()`);
  check('the arrowhead is a filled triangle', arrow && arrow.n === 3 && arrow.fill !== 'none', arrow ? `${arrow.n} points, fill ${arrow.fill}` : 'no arrow');
  nearPct('the arrowhead is about 3 mm long at 96 dpi (11 px)', arrow.len, 11, 6);
  near('the arrowhead has a 15° included angle', arrow.included, 15, 0.6);

  const focused = await q(`(async () => {
    const key = ${JSON.stringify(numKey.key)};
    __bluesheet.setFocusParam(key);
    const n = document.querySelector('.dimlayer [data-param="' + key + '"]');
    return n ? {param: n.dataset.param, faint: n.classList.contains('dim--faint'),
                label: (n.querySelector('.dim-label') || {}).textContent || '',
                value: (n.querySelector('.dim-value') || {}).textContent || '',
                arrows: n.querySelectorAll('.dim-arrow').length,
                others: document.querySelectorAll('.dimlayer .dim').length} : null;
  })()`);
  check('focusing a numeric parameter draws its own callout', !!focused, focused ? 'drawn' : 'nothing drawn');
  check('the callout is tagged with the parameter it describes', focused && focused.param === numKey.key, focused && focused.param);
  check('the callout names the focused parameter', focused && focused.label.toUpperCase() === String(numKey.label).toUpperCase(),
    `"${focused && focused.label}" vs "${numKey.label}"`);
  check('the focused callout is drawn at full strength, not faint', focused && !focused.faint, `faint=${focused && focused.faint}`);
  check('the focused callout replaces the faint bounding box', focused && focused.others === 1, `${focused && focused.others} callouts on screen`);

  // =====================================================================
  // the scale bar
  // =====================================================================
  const sb = await q(`(() => {
    const el = document.querySelector('[data-scalebar]');
    const text = [...el.querySelectorAll('text')].map(t => t.textContent);
    return {step: Number(el.dataset.step), cells: el.querySelectorAll('rect').length,
            ticks: el.querySelectorAll('line').length, text,
            pxPerMm: __bluesheet.dims.pxPerMm()};
  })()`);
  check('the scale bar snaps to a round number of millimetres',
    [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].includes(sb.step), `${sb.step} mm`);
  check('the scale bar is a chequered bar with ticks and a figure',
    sb.cells >= 4 && sb.ticks >= 3 && sb.text.some(t => /mm$/.test(t)), `${sb.cells} cells, ${sb.ticks} rules, "${sb.text.join(' ')}"`);
  check('the scale bar length agrees with the measured pixels per millimetre',
    Math.abs(sb.step * sb.pxPerMm - 74) >= 0 && sb.step * sb.pxPerMm >= 70 && sb.step * sb.pxPerMm <= 215,
    `${(sb.step * sb.pxPerMm).toFixed(0)} px for ${sb.step} mm`);

  // =====================================================================
  // G3 — driven through real pixels
  // =====================================================================
  // Scroll first, then check the pixel is actually the element's. The parameter
  // panel is 2500 px long for a generator like boxlid, so a row picked by
  // selector is usually nowhere near the viewport — the click went to empty
  // space, nothing happened, and the failure read "the toggle is broken". A
  // click helper that can silently hit nothing turns every check downstream of
  // it into a coin toss, so this one refuses.
  const clickAt = async (sel, dx = 0.5, dy = 0.5) => {
    const r = await q(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const b = e.getBoundingClientRect();
      const x = b.left + b.width * ${dx}, y = b.top + b.height * ${dy};
      const at = document.elementFromPoint(x, y);
      return {x, y, w: b.width, h: b.height,
              hits: !!at && (e === at || e.contains(at) || at.contains(e)),
              at: at ? at.tagName + '.' + at.className : 'nothing'}; })()`);
    if (!r) throw new Error(`no element ${sel}`);
    if (!r.hits) throw new Error(`${sel} is at (${Math.round(r.x)}, ${Math.round(r.y)}) but that pixel belongs to ${r.at}`);
    await page.sleep(30);                       // let the scroll settle
    await page.click(r.x, r.y);
    return r;
  };

  await clickAt('[data-open-catalogue]');
  const catOpen = await q(`(() => ({open: !document.querySelector('[data-catalogue]').hidden,
     cards: document.querySelectorAll('[data-cat-cards] .card').length,
     chips: document.querySelectorAll('[data-cat-cats] .chip').length,
     focus: document.activeElement && document.activeElement.id}))()`);
  check('clicking Catalogue opens the catalogue', catOpen.open === true, `open=${catOpen.open}`);
  check('every registered generator has a card', catOpen.cards === boot.gens, `${catOpen.cards} cards for ${boot.gens} generators`);
  check('the catalogue offers a category filter', catOpen.chips >= 2, `${catOpen.chips} chips`);
  check('opening the catalogue puts the cursor in the search box', catOpen.focus === 'cat-search', catOpen.focus);

  const cardFields = await q(`(() => {
    const c = document.querySelector('[data-cat-cards] .card');
    return {name: (c.querySelector('.card-name')||{}).textContent, cat: (c.querySelector('.card-cat')||{}).textContent,
            blurb: (c.querySelector('.card-blurb')||{}).textContent, gen: c.dataset.gen};
  })()`);
  check('a card carries the name, the category and the blurb',
    cardFields.name && cardFields.cat && cardFields.blurb && cardFields.blurb.length > 8,
    `${cardFields.name} / ${cardFields.cat} / "${String(cardFields.blurb).slice(0, 40)}…"`);

  // Type into the search box for real, one key at a time.
  const term = cardFields.name.split(/\s+/)[0].slice(0, 4).toLowerCase();
  await page.send('Input.dispatchKeyEvent', { type: 'char', text: term[0] });
  for (const ch of term.slice(1)) await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
  await page.sleep(260);
  const filtered = await q(`(() => ({n: document.querySelectorAll('[data-cat-cards] .card').length,
    value: document.querySelector('[data-cat-search]').value}))()`);
  check('typing in the catalogue filters it', filtered.n < catOpen.cards && filtered.n >= 1,
    `"${filtered.value}" leaves ${filtered.n} of ${catOpen.cards}`);

  // Clear the search, then filter by category chip.
  await q(`(() => { const s = document.querySelector('[data-cat-search]'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await page.sleep(200);
  const chip = await q(`(() => { const c = [...document.querySelectorAll('[data-cat-cats] .chip')][1];
     return {cat: c.dataset.cat, expect: __bluesheet.generators.filter(g => g.category === c.dataset.cat).length}; })()`);
  await clickAt('[data-cat-cats] .chip:nth-child(2)');
  await page.sleep(120);
  const byCat = await q(`document.querySelectorAll('[data-cat-cards] .card').length`);
  check('clicking a category chip filters the catalogue', byCat === chip.expect, `${chip.cat}: ${byCat} cards, expected ${chip.expect}`);

  await clickAt('[data-cat-cats] .chip:nth-child(1)');
  await page.sleep(120);

  // Keyboard: ArrowDown out of the search box lands on the first card.
  await q(`(() => { document.querySelector('[data-cat-search]').focus(); return true; })()`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' });
  await page.sleep(80);
  const kbd = await q(`(() => { const a = document.activeElement; return {cls: a.className, gen: a.dataset && a.dataset.gen}; })()`);
  check('the catalogue grid is reachable from the keyboard', /card/.test(kbd.cls || ''), `${kbd.cls} (${kbd.gen})`);

  // Previews: give the queue a moment and then insist on real pictures.
  await page.sleep(2500);
  const painted = await q(`(() => {
    const c = [...document.querySelectorAll('[data-cat-cards] .card-thumb')];
    return {n: c.length, painted: c.filter(x => x.dataset.painted === '1').length};
  })()`);
  check('the cards preview the generators rather than showing a placeholder',
    painted.painted >= Math.min(3, painted.n), `${painted.painted} of ${painted.n} cards rendered`);

  // Click a card that is not the current generator: the whole point of the door.
  const otherId = await q(`(() => { const c = [...document.querySelectorAll('[data-cat-cards] .card')].find(c => c.dataset.gen !== __bluesheet.gen.id); return c ? c.dataset.gen : null; })()`);
  if (otherId) {
    await clickAt(`[data-cat-cards] .card[data-gen="${otherId}"]`, 0.5, 0.3);
    await page.sleep(120);
    await q(`(async () => { await __bluesheet.rebuild(); return true; })()`);
    const after = await q(`({gen: __bluesheet.gen.id, open: !document.querySelector('[data-catalogue]').hidden, crumb: document.querySelector('[data-crumb-gen]').textContent})`);
    check('clicking a card switches the generator and closes the catalogue',
      after.gen === otherId && after.open === false, `${after.gen}, dialog open=${after.open}`);
    check('the header crumb follows the generator', after.crumb.length > 1, after.crumb);
  } else {
    check('clicking a card switches the generator and closes the catalogue', false, 'only one generator is installed');
  }

  // ---- a stepper, clicked ------------------------------------------------
  const stepTarget = await q(`(() => {
    const p = __bluesheet.gen.params.find(p => (p.type === 'number' || p.type === 'int') && __bluesheet.params[p.key] + p.step <= p.max);
    return p ? {key: p.key, before: __bluesheet.params[p.key], step: p.step} : null;
  })()`);
  check('the current generator has a number that can be stepped up', !!stepTarget, stepTarget ? stepTarget.key : 'none');
  const before = await q(`({tris: __bluesheet.mesh.triCount, size: __bluesheet.mesh.bbox().size.slice()})`);
  await clickAt(`.prow[data-param="${stepTarget.key}"] .step:last-child`);
  await page.sleep(600);
  const stepped = await q(`(async () => { await __bluesheet.rebuild(); return {v: __bluesheet.params[${JSON.stringify(stepTarget.key)}],
    tris: __bluesheet.mesh.triCount, size: __bluesheet.mesh.bbox().size.slice()}; })()`);
  check('clicking the + stepper moves the parameter',
    Math.abs(stepped.v - (stepTarget.before + stepTarget.step)) < 1e-6,
    `${stepTarget.before} -> ${stepped.v} (step ${stepTarget.step})`);
  check('moving a parameter rebuilds the geometry',
    stepped.tris !== before.tris || stepped.size.some((v, i) => Math.abs(v - before.size[i]) > 1e-6),
    `${before.tris}t ${before.size.map(v => v.toFixed(1)).join('×')} -> ${stepped.tris}t ${stepped.size.map(v => v.toFixed(1)).join('×')}`);

  // ---- a boolean, clicked ------------------------------------------------
  // A VISIBLE boolean. Picking the first bool any generator declares found
  // boxlid.catchOn, which `showIf` keeps hidden until the lid is hinged — so the
  // click landed on a zero-sized row at (0, 0), hit the body, and the failure
  // read as "the toggle is broken" rather than "the test aimed at nothing".
  const boolInfo = await q(`(async () => {
    for (const g of __bluesheet.generators) {
      await __bluesheet.setGen(g.id);
      const row = document.querySelector('.prow--boolwrap:not([hidden]) .prow--bool');
      if (row) return {gen: g.id, key: row.dataset.param};
    }
    return null;
  })()`);
  if (boolInfo) {
    if (boolInfo.gen !== (await q('__bluesheet.gen.id'))) {
      await q(`(async () => { await __bluesheet.setGen(${JSON.stringify(boolInfo.gen)}); return true; })()`);
    }
    const b0 = await q(`__bluesheet.params[${JSON.stringify(boolInfo.key)}]`);
    await clickAt(`.prow[data-param="${boolInfo.key}"] .prow--bool`, 0.2, 0.5);
    await page.sleep(500);
    const b1 = await q(`(async () => { await __bluesheet.rebuild(); return __bluesheet.params[${JSON.stringify(boolInfo.key)}]; })()`);
    check('clicking a boolean row toggles it', b1 === !b0, `${boolInfo.gen}.${boolInfo.key}: ${b0} -> ${b1}`);

    // A row hidden by showIf still has to tell the truth when it comes back.
    // The panel used to skip hidden rows when pushing values in, so a value
    // that moved while the row was off screen reappeared as the old one.
    const stale = await q(`(async () => {
      await __bluesheet.setGen('boxlid');
      await __bluesheet.setParam('closure', 'friction');     // hides catchOn
      const hidden = !!document.querySelector('.prow--boolwrap[data-param="catchOn"]').hidden;
      const was = __bluesheet.params.catchOn;
      await __bluesheet.setParam('catchOn', !was);           // moves it while hidden
      await __bluesheet.setParam('closure', 'hinged');       // reveals it again
      const box = document.getElementById('p-catchOn');
      return { hidden, model: __bluesheet.params.catchOn, shown: box.checked,
               visible: !document.querySelector('.prow--boolwrap[data-param="catchOn"]').hidden };
    })()`);
    check('a row hidden by showIf is still hidden when its rule says so', stale.hidden === true);
    check('a row that reappears shows the value the model actually holds',
      stale.visible === true && stale.shown === stale.model,
      `model ${stale.model}, checkbox ${stale.shown}`);
  } else {
    check('clicking a boolean row toggles it', false, 'no generator declares a boolean');
  }

  // ---- a preset ----------------------------------------------------------
  const presetInfo = await q(`(() => {
    for (const g of __bluesheet.generators) if ((g.presets || []).length) return {gen: g.id, name: g.presets[0].name};
    return null;
  })()`);
  if (presetInfo) {
    const pr = await q(`(async () => {
      await __bluesheet.setGen(${JSON.stringify(presetInfo.gen)});
      const a = __bluesheet.mesh.bbox().size.slice();
      await __bluesheet.applyPreset(${JSON.stringify(presetInfo.name)});
      return {a, b: __bluesheet.mesh.bbox().size.slice(), variant: document.querySelector('[data-tb-variant]').textContent.trim()};
    })()`);
    check('applying a preset changes the bounding box',
      pr.b.some((v, i) => Math.abs(v - pr.a[i]) > 1e-6),
      `${presetInfo.gen}/${presetInfo.name}: ${pr.a.map(v => v.toFixed(1)).join('×')} -> ${pr.b.map(v => v.toFixed(1)).join('×')}`);
    check('the title block names the preset as the variant',
      pr.variant === presetInfo.name.toUpperCase(), `${pr.variant} vs ${presetInfo.name.toUpperCase()}`);
  } else {
    check('applying a preset changes the bounding box', false, 'no generator declares a preset');
  }

  // ---- view modes, clicked ----------------------------------------------
  await clickAt('[data-mode="wire"]');
  await page.sleep(120);
  const wire = await q(`({mode: __bluesheet.viewer.mode, pressed: document.querySelector('[data-mode="wire"]').getAttribute('aria-pressed')})`);
  check('clicking a view mode switches the viewer', wire.mode === 'wire' && wire.pressed === 'true', `${wire.mode}, pressed=${wire.pressed}`);
  await clickAt('[data-mode="overhang"]');
  await page.sleep(120);
  check('the overhang view is reachable too', (await q('__bluesheet.viewer.mode')) === 'overhang', await q('__bluesheet.viewer.mode'));
  await clickAt('[data-mode="solid"]');
  await page.sleep(120);

  // ---- the STL ------------------------------------------------------------
  const stl = await q(`(async () => { const b = await __bluesheet.exportSTL();
    return {len: b.byteLength || b.length, tris: __bluesheet.mesh.triCount,
            header: new TextDecoder().decode(new Uint8Array(b.buffer || b).slice(0, 42))}; })()`);
  check('the exported STL is 84 + 50 × triangles', stl.len === 84 + 50 * stl.tris, `${stl.len} bytes for ${stl.tris} triangles`);
  check('the STL header carries the provenance string', /^Bluesheet [a-z0-9-]+ v\d+ #[0-9a-f]{8}/.test(stl.header), JSON.stringify(stl.header.trim()));

  // =====================================================================
  // G10 — the rebuild is debounced
  // =====================================================================
  const debounced = await q(`(async () => {
    const p = __bluesheet.gen.params.find(p => p.type === 'number' || p.type === 'int');
    const b0 = __bluesheet.builder.stats.builds;
    const span = Math.min(8, Math.max(1, Math.round((p.max - p.min) / p.step)));
    for (let i = 0; i < 8; i++) __bluesheet.setParam(p.key, p.min + (i % span) * p.step);
    await new Promise(r => setTimeout(r, 700));
    await __bluesheet.rebuild();
    return {calls: 8, builds: __bluesheet.builder.stats.builds - b0};
  })()`);
  check('eight parameter changes in a row do not become eight builds',
    debounced.builds < debounced.calls, `${debounced.builds} builds for ${debounced.calls} changes`);

  // =====================================================================
  // the elevation row: real terrain from a place name, without the network
  // =====================================================================
  const fieldRow = await q(`(async () => {
    await __bluesheet.setGen('terrain');
    await __bluesheet.setParam('source', 'field');
    const row = document.querySelector('.prow--field');
    if (!row) return { row: false };
    const r = (sel) => !!row.querySelector(sel);
    const hidden = row.hidden;
    const tall = [...row.querySelectorAll('button, input')].every(b => b.getBoundingClientRect().height >= 40);
    // A field that arrives (from a saved design, say) is shown as its caption.
    const set = __bluesheet.panel.rows.get('field');
    set.set({ w: 4, h: 4, data: new Array(16).fill(100), meta: { name: 'Test Ridge', spanKm: 2, minM: 30, maxM: 240 } });
    const caption = row.querySelector('.field-preview .help').textContent;
    return { row: true, hidden, search: r('input[type=search]'), find: r('.field-search .btn'), lat: r('[aria-label=Latitude]'),
      lon: r('[aria-label=Longitude]'), span: r('[aria-label="Square size in kilometres"]'), tall, caption };
  })()`);
  check('the terrain generator gets a real elevation row for a place, not a text box', fieldRow.row === true && fieldRow.hidden === false, JSON.stringify(fieldRow).slice(0, 100));
  check('the row has a place search, coordinates and a square size', fieldRow.search && fieldRow.find && fieldRow.lat && fieldRow.lon && fieldRow.span);
  check('every control in it is a finger-sized target', fieldRow.tall === true);
  check('a field that arrives is described, not dumped', /Test Ridge/.test(fieldRow.caption) && /2 km/.test(fieldRow.caption) && /30–240 m/.test(fieldRow.caption), fieldRow.caption);
  await q(`(async () => { await __bluesheet.setGen(${JSON.stringify(boot.gen)}); return true; })()`);

  // =====================================================================
  // G8 — slice, then print
  // =====================================================================
  const printBefore = await q(`document.querySelector('[data-print]').disabled`);
  check('Print is disabled until a slice exists', printBefore === true, `disabled=${printBefore}`);

  const slicerReady = await q(`!!(__bluesheet.health && __bluesheet.health.slicer && __bluesheet.health.slicer.orca)`);
  if (slicerReady) {
    // Slice the smallest object we have, so the suite does not spend a minute
    // on a lithophane.
    await q(`(async () => {
      let best = null;
      for (const g of __bluesheet.generators) {
        await __bluesheet.setGen(g.id);
        const v = __bluesheet.analysis ? __bluesheet.analysis.volume : Infinity;
        if (!best || v < best.v) best = {id: g.id, v};
      }
      await __bluesheet.setGen(best.id);
      return best;
    })()`);
    const sliced = await q(`(async () => { const m = await __bluesheet.slice(); return m && {id: m.id, layers: m.layers, grams: m.grams, timeText: m.timeText}; })()`);
    check('slicing returns a real job from the server', !!(sliced && sliced.layers > 0),
      sliced ? `${sliced.id}: ${sliced.layers} layers, ${sliced.grams} g, ${sliced.timeText}` : 'no slice');

    const col = await q(`document.querySelector('[data-facts]').innerText.replace(/\\s+/g,' ')`);
    // Case-insensitive because `innerText` returns RENDERED text and the fact
    // labels are `text-transform: uppercase` — the sentence-case source string
    // never appears in the DOM, so /Print time/ could not match "PRINT TIME"
    // however right the column was.
    const at = col.search(/sliced/i);
    check('the slice results land in the analysis column',
      /print time/i.test(col) && /filament used/i.test(col) && /sliced layers/i.test(col) && /cost/i.test(col),
      at >= 0 ? col.slice(at, at + 120) : `no slice facts in: ${col.slice(-120)}`);

    const gc = await q(`({mode: __bluesheet.viewer.mode, layers: __bluesheet.gcode && __bluesheet.gcode.layerCount,
      btn: document.querySelector('[data-mode="gcode"]').disabled,
      x: __bluesheet.gcode && __bluesheet.gcode.layers[0] && __bluesheet.gcode.layers[0].paths[0] ? __bluesheet.gcode.layers[0].paths[0].pts[0] : null})`);
    check('the gcode preview is switched into the viewport when the slice finishes',
      gc.mode === 'gcode' && gc.btn === false && gc.layers > 0, `mode=${gc.mode}, ${gc.layers} layers`);
    check('the toolpaths are moved into the plate frame the viewer draws in',
      gc.x !== null && Math.abs(gc.x) < 90, `first point x = ${gc.x}`);

    const printAfter = await q(`document.querySelector('[data-print]').disabled`);
    check('Print is enabled once a slice exists', printAfter === false, `disabled=${printAfter}`);

    await clickAt('[data-print]');
    await page.sleep(700);
    const confirm = await q(`(() => { const d = document.querySelector('[data-confirm]');
      return {open: !d.hidden, name: document.querySelector('[data-confirm-name]').textContent,
              expect: __bluesheet.objectName(),
              go: document.querySelector('[data-confirm-go]').textContent.replace(/\\s+/g,' ').trim(),
              time: document.querySelector('[data-confirm-time]').textContent}; })()`);
    check('pressing Print asks to confirm before anything is sent', confirm.open === true, `open=${confirm.open}`);
    check('the confirmation names the object', confirm.name === confirm.expect && confirm.name.length > 2,
      `"${confirm.name}"`);
    check('the confirm button repeats the name it is about to send', confirm.go.includes(confirm.name), confirm.go);
    await clickAt('[data-confirm-cancel]');
    await page.sleep(150);
    check('cancelling the confirmation sends nothing',
      (await q(`document.querySelector('[data-confirm]').hidden`)) === true, 'dialog closed, no request made');
  } else {
    check('slicing returns a real job from the server', false, 'OrcaSlicer is not installed on this machine');
  }

  // =====================================================================
  // G12 — saved designs
  // =====================================================================
  const saved = await q(`(async () => {
    const name = 'ui-test ' + Date.now();
    const before = __bluesheet.mesh.bbox().size.slice();
    const tris = __bluesheet.mesh.triCount;
    const entry = await __bluesheet.saveDesign(name);
    const listed = (await __bluesheet.library.list()).some(e => e.id === entry.id);
    return {id: entry.id, name: entry.name, listed, before, tris, gen: entry.gen,
            hasThumb: !!entry.thumbnail, provenance: entry.provenance};
  })()`);
  check('a design saves to the library with its name', saved.name.startsWith('ui-test '), `${saved.id} "${saved.name}"`);
  check('the saved design is listed back', saved.listed === true, `listed=${saved.listed}`);
  check('the saved design carries a thumbnail and its provenance', saved.hasThumb && /v\d+ #[0-9a-f]{8}/.test(saved.provenance || ''),
    saved.provenance);

  const reloaded = await q(`(async () => {
    const other = __bluesheet.generators.find(g => g.id !== ${JSON.stringify(saved.gen)});
    if (other) await __bluesheet.setGen(other.id);
    await __bluesheet.library.list();
    await __bluesheet.loadSaved(__bluesheet.library.entry(${JSON.stringify(saved.id)}));
    await __bluesheet.rebuild();
    return {gen: __bluesheet.gen.id, size: __bluesheet.mesh.bbox().size.slice(), tris: __bluesheet.mesh.triCount};
  })()`);
  check('loading a saved design comes back to the same generator', reloaded.gen === saved.gen, `${reloaded.gen} vs ${saved.gen}`);
  check('the rebuilt mesh matches the one that was saved',
    reloaded.tris === saved.tris && reloaded.size.every((v, i) => Math.abs(v - saved.before[i]) < 1e-6),
    `${reloaded.tris}t ${reloaded.size.map(v => v.toFixed(2)).join('×')} vs ${saved.tris}t ${saved.before.map(v => v.toFixed(2)).join('×')}`);

  const deleted = await q(`(async () => { await __bluesheet.library.remove(${JSON.stringify(saved.id)});
    const list = await __bluesheet.library.list(); return list.some(e => e.id === ${JSON.stringify(saved.id)}); })()`);
  check('deleting a saved design removes it', deleted === false, `still present=${deleted}`);

  // =====================================================================
  // G11 — the accessibility floor, measured
  // =====================================================================
  const contrast = await q(`(() => {
    const lum = (c) => {
      const [r,g,b] = c.map(v => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const rgb = (s) => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(s); return m ? [+m[1],+m[2],+m[3], m[4]===undefined?1:+m[4]] : null; };
    const bgOf = (e) => {
      for (let n = e; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0.5) return c;
      }
      return [13,22,33,1];
    };
    const out = [];
    for (const sel of ['body', '.prose', '.help', '.card-blurb', '.fact dd', '.status-msg', '.lbl', '.tb-cell b', '.warn-body']) {
      const e = document.querySelector(sel);
      if (!e) continue;
      const fg = rgb(getComputedStyle(e).color); const bg = bgOf(e);
      if (!fg) continue;
      const L1 = lum(fg.slice(0,3)), L2 = lum(bg.slice(0,3));
      out.push({sel, ratio: +(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))).toFixed(2)});
    }
    return out;
  })()`);
  const worst = contrast.reduce((a, b) => (b.ratio < a.ratio ? b : a), contrast[0]);
  check('every body-text colour clears 7:1 against its own background',
    contrast.every(c => c.ratio >= 7), contrast.map(c => `${c.sel} ${c.ratio}:1`).join(', '));
  check('the worst contrast on the page is still comfortable', worst.ratio >= 7, `${worst.sel} at ${worst.ratio}:1`);

  const labels = await q(`(() => {
    const bad = [];
    for (const e of document.querySelectorAll('input, select, textarea')) {
      if (e.type === 'hidden') continue;
      const has = (e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]')) ||
                  e.closest('label') || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
      if (!has) bad.push(e.tagName + '#' + (e.id || '?') + '.' + e.className);
    }
    return bad;
  })()`);
  check('every input has a label associated with it', labels.length === 0, labels.slice(0, 4).join(' | ') || 'all labelled');

  const namedButtons = await q(`(() => [...document.querySelectorAll('button')]
    .filter(b => b.offsetParent !== null && !b.textContent.trim() && !b.getAttribute('aria-label'))
    .map(b => b.className).slice(0, 5))()`);
  check('no control relies on hover to say what it is', namedButtons.length === 0, namedButtons.join(' | ') || 'every button is named');

  // The ring is `:focus-visible`, which is the right rule — a mouse click on a
  // button should not draw one. That means a bare `b.focus()` from script does
  // NOT match it: Chrome only treats scripted focus as keyboard focus when the
  // last real interaction was a key. Everything above this point is mouse
  // clicks, so the naive version measured a button with no ring at all and
  // reported the app was wrong when it was the test that never pressed a key.
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
  const ring = await q(`(() => {
    const b = document.querySelector('[data-open-catalogue]');
    b.focus();
    const s = getComputedStyle(b);
    return {color: s.outlineColor, width: s.outlineWidth, offset: s.outlineOffset, style: s.outlineStyle,
            visible: b.matches(':focus-visible')};
  })()`);
  check('a keyboard-focused control matches :focus-visible', ring.visible === true,
    'without this the ring measurement below is measuring nothing');
  check('keyboard focus is a 1px heat outline offset 2px',
    ring.color === HEX.heat && parseFloat(ring.width) <= 1.5 && parseFloat(ring.offset) >= 2 && ring.style === 'solid',
    `${ring.style} ${ring.width} ${ring.color} offset ${ring.offset}`);

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.sleep(120);
  const motion = await q(`(() => {
    const e = document.querySelector('[data-tb-rev]');
    e.classList.add('is-ticking');
    const d = getComputedStyle(e).animationDuration;
    e.classList.remove('is-ticking');
    return {d, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches};
  })()`);
  check('prefers-reduced-motion removes the animation', motion.reduced === true && parseFloat(motion.d) < 0.01,
    `animation-duration ${motion.d} with reduce on`);
  await page.send('Emulation.setEmulatedMedia', { features: [] });

  // =====================================================================
  // G7 — it works with a finger
  // =====================================================================
  const taps = await q(`(() => {
    const bad = [];
    for (const e of document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=file]), .prow--bool, textarea')) {
      if (e.offsetParent === null) continue;
      if (e.closest('[hidden]')) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const short = Math.min(r.width, r.height);
      if (short < 44 - 0.5) bad.push((e.getAttribute('class') || e.tagName) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
    return bad;
  })()`);
  check('every touch target is at least 44px on its short axis', taps.length === 0,
    taps.slice(0, 5).join(' | ') || 'all 44px or larger');

  const steppers = await q(`(() => {
    const rows = [...document.querySelectorAll('.prow--num')].filter(r => !r.hidden);
    return {rows: rows.length,
            complete: rows.filter(r => r.querySelectorAll('.step').length === 2 && r.querySelector('input.field')).length,
            scrub: rows.filter(r => getComputedStyle(r.querySelector('input.field')).cursor === 'ew-resize').length};
  })()`);
  check('every numeric parameter has both steppers and a field',
    steppers.rows > 0 && steppers.complete === steppers.rows, `${steppers.complete} of ${steppers.rows} rows`);
  check('the numeric field is also draggable', steppers.scrub === steppers.rows, `${steppers.scrub} of ${steppers.rows} scrub`);

  const layoutAt = async (w, h) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
    await page.sleep(320);
    return q(`(() => {
      const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return {t: Math.round(b.top), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height)}; };
      return {stage: r('.col--stage'), params: r('.col--params'), analysis: r('.col--analysis'),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              taps: [...document.querySelectorAll('button')].filter(b => b.offsetParent && Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height) < 43.5).length};
    })()`);
  };

  const ipad = await layoutAt(820, 1180);
  check('at 820px (iPad portrait) the columns stack with the viewport first',
    ipad.stage.t < ipad.analysis.t && ipad.analysis.t < ipad.params.t && ipad.stage.l === ipad.params.l,
    `stage y=${ipad.stage.t}, analysis y=${ipad.analysis.t}, params y=${ipad.params.t}`);
  check('at 820px nothing overflows sideways', ipad.overflow <= 0, `${ipad.overflow}px of horizontal overflow`);
  check('at 820px every touch target is still 44px', ipad.taps === 0, `${ipad.taps} too small`);

  const phone = await layoutAt(390, 844);
  check('at 390px (phone) the layout still stacks',
    phone.stage.t < phone.params.t && phone.stage.w <= 390, `stage ${phone.stage.w}px wide at y=${phone.stage.t}`);
  check('at 390px nothing overflows sideways', phone.overflow <= 0, `${phone.overflow}px of horizontal overflow`);
  check('at 390px every touch target is still 44px', phone.taps === 0, `${phone.taps} too small`);

  const tbNarrow = await q(`(() => { const tb = document.querySelector('[data-title-block]').getBoundingClientRect();
    const st = document.querySelector('[data-stage]').getBoundingClientRect();
    return tb.width <= st.width && tb.right <= st.right + 1; })()`);
  check('the title block still fits inside the viewport at 390px', tbNarrow === true, `fits=${tbNarrow}`);

  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.sleep(250);

  // =====================================================================
  // the console, last, so it covers everything above
  // =====================================================================
  const errs = page.errors().filter(e => !/favicon|DevTools|Download is disallowed/i.test(e));
  check('the console is clean after all of that', errs.length === 0, errs.slice(0, 3).join(' | ') || 'no errors');
});

done();
