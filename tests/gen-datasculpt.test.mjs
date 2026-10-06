// Data as a printed object. The statistical treatment matters more than the
// shape here — a savagely skewed series rendered with the wrong normalisation
// comes out as a corn cob, which is what happened to the original Core Sample
// twice before anyone worked out why.
import { suite, check, near, nearPct, done } from './lib/assert.mjs';
import { conformance, ctx, defaults, asMesh, testSeries } from './lib/genconform.mjs';
import { topology } from './lib/meshcheck.mjs';
import { analyze, printability } from '../js/kernel/validate.js';
import gen from '../js/gen/datasculpt.js';

suite('gen datasculpt');
conformance(gen, 'datasculpt');

const C = ctx('normal');
const build = (over = {}) => asMesh(gen.build({ ...defaults(gen), ...over }, C));

// ---- every form, and every awkward series --------------------------------
{
  for (const form of gen.params.find(q => q.key === 'form').options.map(o => o.v)) {
    const m = build({ form });
    const t = topology(m);
    check(`form "${form}" is a closed solid`,
      t.boundary === 0 && t.nonManifold === 0 && t.inconsistent === 0 && m.volume() > 0,
      `bnd ${t.boundary}, nm ${t.nonManifold}, wind ${t.inconsistent}`);
  }
  const flat = new Array(40).fill(50);
  const spike = [...new Array(39).fill(3), 9000];
  const tiny = [1, 2, 3];
  const long = testSeries(2000);
  for (const [name, series] of [['3 points', tiny], ['2000 points', long],
                                ['all identical', flat], ['one huge outlier', spike]]) {
    for (const form of ['column', 'ring']) {
      const m = build({ form, series });
      const t = topology(m);
      check(`${form} with ${name}: closed solid`,
        m && t.boundary === 0 && t.nonManifold === 0 && m.volume() > 0,
        `bnd ${t?.boundary}, nm ${t?.nonManifold}`);
    }
  }
}

// ---- the finding that took three iterations the first time ---------------
{
  // Rank normalisation maps ranks uniformly onto the radius range, so the middle
  // half of the DATA occupies about half the band by construction; log parks a
  // skewed series in the middle and uses much less. Sample one radius per data
  // point — measuring per vertex weights the answer by how many triangles each
  // layer happens to have, which is what made the first version of this useless.
  // The clean measurement is the volume. Rank maps ranks uniformly onto the
  // radius range, so a savagely skewed series uses the whole range and comes out
  // fattest; linear puts almost everything at the bottom of the range because one
  // outlier owns the top. An earlier version of this test tried to measure the
  // spread of radii directly and could not tell them apart — the geometry is
  // weighted by triangle count, and the volume is not.
  const skew = Array.from({ length: 120 }, (_, i) => (i % 17 === 0 ? 4000 + i * 30 : 45 + (i % 13) * 8));
  const vol = (over) => build({ form: 'column', series: skew, outliers: 'keep', ...over }).volume();
  const rank = vol({ normalise: 'rank' }), linear = vol({ normalise: 'linear' }),
        log = vol({ normalise: 'log' }), clipped = vol({ normalise: 'clipped' });
  check('rank uses more of the radius range than linear on a skewed series',
    rank > linear * 1.5,
    `rank ${rank.toFixed(0)} mm³ against linear ${linear.toFixed(0)} — ${(rank / linear).toFixed(2)}x`);
  check('rank uses more of it than log, too',
    rank > log * 1.2, `rank ${rank.toFixed(0)} against log ${log.toFixed(0)} mm³`);
  check('all four normalisations give genuinely different objects',
    new Set([rank, linear, log, clipped].map(v => Math.round(v))).size === 4,
    [rank, linear, log, clipped].map(v => v.toFixed(0)).join(' / '));
  check('rank is the default, because it is the one that works',
    gen.params.find(q => q.key === 'normalise').def === 'rank',
    String(gen.params.find(q => q.key === 'normalise').def));

  for (const normalise of gen.params.find(q => q.key === 'normalise').options.map(o => o.v)) {
    const m = build({ normalise, series: skew });
    check(`normalisation "${normalise}" builds a solid`, topology(m).boundary === 0 && m.volume() > 0);
  }
  // Trimming outliers changes a LINEAR sculpture and leaves a RANK one alone —
  // rank is immune to an outlier by construction, which is exactly why it is the
  // default. A test that expected trimming to matter under rank would be
  // asserting that the good default does not work.
  // ONE value far out, not eight. The fence is q3 + 3*IQR and the parameter is
  // described as being for "a value so far out that it sets the range on its
  // own" — eight of a hundred and twenty is a cluster, not an outlier, and a
  // test built on eight of them concludes the feature does nothing.
  const oneOut = [...Array.from({ length: 59 }, (_, i) => 40 + (i % 11) * 3), 9000];
  const volOf = (over) => build({ form: 'column', series: oneOut, ...over }).volume();
  const linKept = volOf({ normalise: 'linear', outliers: 'keep' });
  const linTrim = volOf({ normalise: 'linear', outliers: 'trim' });
  check('fencing off a lone extreme value changes a linear sculpture',
    linTrim > linKept * 2,
    `keeping it ${linKept.toFixed(0)} mm³, fencing it ${linTrim.toFixed(0)} — ${(linTrim / linKept).toFixed(1)}x`);
  check('and leaves a rank sculpture untouched, because rank is outlier-immune',
    Math.abs(volOf({ normalise: 'rank', outliers: 'keep' }) - volOf({ normalise: 'rank', outliers: 'trim' })) < 1,
    `${volOf({ normalise: 'rank', outliers: 'keep' }).toFixed(0)} mm³ either way`);
}

// ---- it respects the printer's physics -----------------------------------
{
  // The original object's honesty came from the overhang limit: a single busy
  // day after a long silence physically cannot build back to full width.
  const jumpy = [2, 2, 2, 100, 2, 2, 100, 2];
  for (const maxOverhang of [45, 60, 75]) {
    const m = build({ form: 'column', series: jumpy, maxOverhang, overhangFix: 'ramp' });
    const p = printability(m, { maxOverhang });
    check(`with a ${maxOverhang}° limit the object stays inside it`,
      p.worstOverhangDeg <= maxOverhang + 6,
      `worst measured ${p.worstOverhangDeg.toFixed(1)}°`);
  }
  const h = gen.hints({ ...defaults(gen), series: jumpy });
  check('hints() mentions what it had to do to the data', (h.notes || []).some(n => n.length > 40),
    (h.notes || [])[0]?.slice(0, 90));
}

// ---- the series is the subject, so it must change the object -------------
{
  const a = build({ series: testSeries(60) });
  // Reordered, not rescaled. Under RANK normalisation a monotone transform of the
  // data is the same object by definition — v*0.5+10 gives an identical sculpture,
  // which is the normalisation working, not a bug. It has to be a different
  // ordering to be a different shape.
  const b = build({ series: testSeries(60).slice().reverse() });
  check('a differently ordered series makes a different object',
    Math.abs(a.volume() - b.volume()) > 1 || a.triCount !== b.triCount,
    `${a.volume().toFixed(0)} vs ${b.volume().toFixed(0)} mm³`);
  const rescaled = build({ series: testSeries(60).map(v => v * 0.5 + 10) });
  near('and a monotone rescale gives the same object, because rank is rank',
    a.volume(), rescaled.volume(), 1e-9);
  const same = build({ series: testSeries(60) });
  near('the same series makes the same object', a.volume(), same.volume(), 1e-9);
  check('validate() returns an array', Array.isArray(gen.validate(defaults(gen))));
  check('the default build is one connected piece', analyze(build()).shells === 1,
    `${analyze(build()).shells} shells`);
}

// ---- dimension callouts: pinned to the features they measure ---------------
{
  const len = (d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
  const P = defaults(gen);
  const r = gen.build(P, C);
  const foot = (r.meta.dims || []).find(d => d.param === 'baseHeight');
  check('baseHeight callout rises from the bed by the disc height at the foot\'s widest point',
    !!foot && Math.abs(len(foot) - P.baseHeight) < 1e-6 && Math.abs(foot.from[2]) < 1e-6
      && Math.hypot(foot.from[0], foot.from[1]) > P.dia * 0.3,
    foot ? `${len(foot).toFixed(2)} mm at r=${Math.hypot(foot.from[0], foot.from[1]).toFixed(2)}` : 'missing');
  const dia = (r.meta.dims || []).find(d => d.param === 'dia');
  check('dia callout crosses the axis at the widest row and measures the widest diameter',
    !!dia && dia.value === undefined && Math.abs(len(dia) - P.dia) < P.dia * 0.02
      && Math.abs(dia.from[2] - dia.to[2]) < 1e-9
      && Math.abs(dia.from[0] + dia.to[0]) < 0.05 && Math.abs(dia.from[1] + dia.to[1]) < 0.05,
    dia ? `${len(dia).toFixed(2)} mm at z=${dia.from[2].toFixed(1)}` : 'missing');
  // A caption promotes the disc to a pedestal; the depth callout goes down the pocket wall.
  const rc = gen.build({ ...P, caption: 'GIT CHURN' }, C);
  const eng = (rc.meta.dims || []).find(d => d.param === 'captionDepth');
  const ped = (rc.meta.dims || []).find(d => d.param === 'baseHeight');
  check('captionDepth callout is cut into the pedestal top by the engraving depth',
    !!eng && !!ped && Math.abs(len(eng) - P.captionDepth) < 1e-6
      && Math.abs(eng.to[2] - P.baseHeight) < 1e-6 && eng.from[2] < eng.to[2]
      && Math.abs(ped.from[1] - rc.mesh.bbox().min[1]) < 1e-6,
    eng ? `${len(eng).toFixed(2)} mm from z=${eng.from[2].toFixed(2)} to ${eng.to[2].toFixed(2)}` : 'missing');
}

// ---- no zero-area triangles at the defaults or any preset -----------------
// analyze() is the analysis panel's own count. healTJunctions() with
// { clean: true } fans each split triangle from a corner whose edges are whole;
// the plain fan from corner 0 laid slivers flat along the split edge (378 on Four seasons, side by side).
// The ear clipper's own slivers (a near-collinear run of cap vertices clipped
// as a ~1e-15 mm² triangle) went to 0 with the 2026-10-06 poly2d fix, and the
// counts here were pinned until then; any nonzero count is a regression.
{
  for (const [name, values] of [['defaults', {}], ...gen.presets.map(p => [p.name, p.values])]) {
    const n = analyze(build(values)).degenerateTris;
    check(`${name}: no zero-area triangles`, n === 0, `${n} degenerate`);
  }
}

done();
