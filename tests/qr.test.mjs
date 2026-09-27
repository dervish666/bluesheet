// The QR encoder, held to a scanner rather than to itself.
//
// zbarimg (zbar-tools) is an independent decoder. Every matrix the encoder
// makes is rasterised to a PBM and read back; the payload must come back
// byte for byte. A corrupted finder pattern must NOT decode, which proves the
// decoder is really being consulted rather than a test that cannot fail.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, check, throws, done } from './lib/assert.mjs';
import { encode, sizeOf, gfExp, gfLog, MAX_VERSION } from '../js/kernel/qr.js';
import { wifiString } from '../js/gen/qrplaque.js';

suite('qr');

const dir = mkdtempSync(join(tmpdir(), 'bluesheet-qr-'));
function decode(r, name = 'x') {
  const S = 6, Q = 4, W = (r.size + 2 * Q) * S;
  let pbm = `P1\n${W} ${W}\n`;
  for (let y = 0; y < W; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const mx = Math.floor(x / S) - Q, my = Math.floor(y / S) - Q;
      row += (mx >= 0 && my >= 0 && mx < r.size && my < r.size && r.modules[my * r.size + mx]) ? '1' : '0';
    }
    pbm += row + '\n';
  }
  const f = join(dir, `${name}.pbm`);
  writeFileSync(f, pbm);
  try { return execFileSync('zbarimg', ['-q', '--raw', f], { encoding: 'utf8' }).replace(/\n$/, ''); }
  catch { return null; }
}

check('GF(256): exp and log are inverses', [1, 2, 37, 128, 254].every(v => gfExp(gfLog(v)) === v));
check('GF(256): 2^8 = 0x1d (the QR primitive polynomial)', gfExp(8) === 0x1d, gfExp(8));
check('version 1 is 21 modules, version 40 is 177', sizeOf(1) === 21 && sizeOf(40) === 177);
throws('version 41 does not exist', () => sizeOf(41));

const payloads = [
  ['HELLO WORLD', 1], ['https://bluesheet.local/#qrplaque', 2], [wifiString({ ssid: 'Sam;Net', password: 'pa:ss,word', security: 'WPA' }), 3],
  ['Yr Wyddfa — 1,085 m ☕', 3], ['x'.repeat(220), 10], ['0123456789'.repeat(9), 4],
  ['A much longer piece of text, the kind a plaque might carry: opening hours, a phone number, and a line saying please ring the bell twice.'.repeat(3), 15],
];
let decoded = 0, tried = 0;
for (const [text, minV] of payloads) for (const ecc of ['L', 'M', 'Q', 'H']) {
  tried++;
  const r = encode(text, { ecc });
  const out = decode(r, `p${tried}`);
  if (out === text) decoded++;
  else check(`decodes ${ecc} v${r.version} ${JSON.stringify(text.slice(0, 24))}`, false, JSON.stringify(out && out.slice(0, 40)));
}
check(`zbarimg reads back every payload at every ECC level (${decoded}/${tried})`, decoded === tried);
check('the Wi-Fi string escapes ; : , and survives the round trip',
  decode(encode(wifiString({ ssid: 'Sam;Net', password: 'pa:ss,word' }), { ecc: 'Q' }), 'wifi') === 'WIFI:T:WPA;S:Sam\\;Net;P:pa\\:ss\\,word;;');

// Falsification: a broken finder must fail to decode.
const bad = encode('HELLO WORLD', { ecc: 'M' });
for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) bad.modules[j * bad.size + i] = (i + j) & 1;
check('a corrupted finder pattern does NOT decode (the decoder is real)', decode(bad, 'bad') !== 'HELLO WORLD');

check('encoding is deterministic', JSON.stringify(Array.from(encode('abc', { ecc: 'M' }).modules)) === JSON.stringify(Array.from(encode('abc', { ecc: 'M' }).modules)));
check('a forced mask is honoured', encode('abc', { ecc: 'M', mask: 5 }).mask === 5);
throws('a payload past version 40 is refused', () => encode('z'.repeat(3000), { ecc: 'H' }));
check('MAX_VERSION is 40', MAX_VERSION === 40);
done();
