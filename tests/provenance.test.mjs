// Provenance. Small module, but it is the thing that lets a printed object be
// traced back to the numbers that made it, so it has to be exactly stable.
import { suite, check, near, done } from './lib/assert.mjs';
import { fnv1a, canonicalise, paramHash, provenance, parseProvenance, matches } from '../js/kernel/provenance.js';
import { cube } from './lib/fixtures.mjs';

suite('provenance');

// ---- the hash ------------------------------------------------------------
check('fnv1a is the published constant for the empty string', fnv1a('') === 0x811c9dc5, fnv1a('').toString(16));
check('fnv1a matches the published vector for "a"', fnv1a('a') === 0xe40c292c, fnv1a('a').toString(16));
check('fnv1a matches the published vector for "foobar"', fnv1a('foobar') === 0xbf9cf968, fnv1a('foobar').toString(16));
check('fnv1a stays a 32-bit unsigned value', fnv1a('x'.repeat(5000)) >>> 0 === fnv1a('x'.repeat(5000)));

// ---- canonicalisation ----------------------------------------------------
check('key order does not change the canonical form',
  canonicalise({ a: 1, b: 2 }) === canonicalise({ b: 2, a: 1 }), canonicalise({ b: 2, a: 1 }));
check('float noise does not change the hash',
  paramHash({ w: 0.1 + 0.2 }) === paramHash({ w: 0.3 }), `${0.1 + 0.2} vs 0.3`);
check('a real difference does change the hash', paramHash({ w: 42 }) !== paramHash({ w: 42.1 }));
check('booleans are canonical', canonicalise({ lip: true }) === 'lip=1');
check('a missing value and null agree', canonicalise({ a: null }) === canonicalise({ a: undefined }));
check('strings are quoted so 1 and "1" differ', paramHash({ a: 1 }) !== paramHash({ a: '1' }));
check('nested objects canonicalise', /\{h=2;w=1\}/.test(canonicalise({ v: { w: 1, h: 2 } })), canonicalise({ v: { w: 1, h: 2 } }));
check('arrays canonicalise in order', canonicalise({ v: [3, 1, 2] }) === 'v=[3,1,2]');
check('array order matters', paramHash({ v: [1, 2] }) !== paramHash({ v: [2, 1] }));
check('NaN does not produce a different hash each time', paramHash({ a: NaN }) === paramHash({ a: NaN }));

// ---- bulk data -----------------------------------------------------------
{
  const img = (w, h, f) => { const gray = new Float32Array(w * h); for (let i = 0; i < gray.length; i++) gray[i] = f(i); return { w, h, gray }; };
  const a = img(64, 64, i => (i % 255) / 255);
  const b = img(64, 64, i => (i % 255) / 255);
  const c = img(64, 64, i => ((i * 7) % 255) / 255);
  const d = img(32, 32, i => (i % 255) / 255);
  check('the same image hashes the same', paramHash({ photo: a }) === paramHash({ photo: b }));
  check('different image content hashes differently', paramHash({ photo: a }) !== paramHash({ photo: c }));
  check('different image size hashes differently', paramHash({ photo: a }) !== paramHash({ photo: d }));
  check('a large field is sampled, not walked, so hashing stays fast', (() => {
    const big = img(2000, 2000, i => (i % 97) / 97);
    const t = process.hrtime.bigint();
    paramHash({ photo: big });
    return Number(process.hrtime.bigint() - t) / 1e6 < 60;
  })(), 'under 60 ms for a 4-megapixel field');
  const raw = new Float32Array([1, 2, 3]);
  check('a bare typed array canonicalises', /^v=data\(3:[0-9a-f]{8}\)$/.test(canonicalise({ v: raw })), canonicalise({ v: raw }));
}

// ---- the string ----------------------------------------------------------
{
  const gen = { id: 'gridfinity', version: 1 };
  const params = { units: 2, height: 6, lip: true };
  const s = provenance(gen, params);
  check('the provenance string has the documented shape', /^gridfinity v1 #[0-9a-f]{8}$/.test(s), s);
  check('it fits an STL header with room to spare', ('Bluesheet ' + s).length <= 80, `${('Bluesheet ' + s).length} bytes`);
  const longest = provenance({ id: 'a'.repeat(60), version: 999 }, params);
  check('an absurd generator id is truncated rather than overflowing the header',
    ('Bluesheet ' + longest).length <= 80, `${('Bluesheet ' + longest).length} bytes`);
  check('a bare id works as well as a generator object', /^vase v1 #/.test(provenance('vase', params)));
}

// ---- round trip through a real STL ---------------------------------------
{
  const gen = { id: 'gridfinity', version: 1 };
  const params = { units: 2, height: 6, lip: true };
  const stl = cube(20).toSTL(provenance(gen, params));
  const p = parseProvenance(stl);
  check('provenance survives an STL round trip', p && p.gen === 'gridfinity' && p.version === 1, JSON.stringify(p));
  check('the hash survives too', p.hash === paramHash(params), `${p.hash} vs ${paramHash(params)}`);
  check('matches() confirms the same parameters', matches(stl, gen, params));
  check('matches() rejects different parameters', !matches(stl, gen, { ...params, units: 3 }));
  check('matches() rejects a different generator', !matches(stl, { id: 'vase', version: 1 }, params));
  check('matches() rejects a different version', !matches(stl, { id: 'gridfinity', version: 2 }, params));
  check('parsing accepts an ArrayBuffer', parseProvenance(stl.buffer).gen === 'gridfinity');
  check('parsing accepts the bare header string', parseProvenance('Bluesheet vase v3 #deadbeef').version === 3);
  check('a header from before the rename still parses', parseProvenance('Forge vase v3 #deadbeef').gen === 'vase');
  check('an unknown prefix does not', parseProvenance('Fusion vase v3 #deadbeef') === null);
  check('parsing accepts the string without the Bluesheet prefix', parseProvenance('vase v3 #deadbeef').gen === 'vase');
}

// ---- files that did not come from here -----------------------------------
{
  check('a foreign STL returns null, which is not an error',
    parseProvenance(cube(10).toSTL('some other program')) === null);
  check('a short buffer returns null', parseProvenance(new Uint8Array(10)) === null);
  check('rubbish returns null', parseProvenance('solid exported by SomeCAD 2019') === null);
  check('an almost-right header is still rejected', parseProvenance('Bluesheet gridfinity v1 #xyz') === null);
  check('a non-hex hash of the right length is rejected', parseProvenance('Bluesheet gridfinity v1 #gggggggg') === null);
  check('null input returns null', parseProvenance(null) === null);
  check('matches() on a foreign file is false, not a throw', matches(new Uint8Array(200), { id: 'x', version: 1 }, {}) === false);
}

done();
