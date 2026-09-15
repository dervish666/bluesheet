// Fetch a real elevation grid and save it as a compact JSON field the terrain
// generator can use with no network at all.
//
//   node tools/fetch-terrain.mjs "Avon Gorge" 51.4549 -2.6278 4 80
//
// opentopodata.org's public endpoint allows 1 call/second and 100 locations per
// call, so an 80x80 grid is 64 calls and a bit over a minute. Be a good guest:
// the rate limit is honoured with a real delay, failures are retried once, and
// the dataset is recorded in the file so the provenance of the shape is known.
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [name, latS, lonS, spanKmS, nS = '80', dataset = 'srtm30m'] = process.argv.slice(2);
if (!name) { console.error('usage: fetch-terrain.mjs <name> <lat> <lon> <spanKm> [n] [dataset]'); process.exit(2); }
const lat = +latS, lon = +lonS, spanKm = +spanKmS, n = +nS;

// A degree of longitude shrinks with latitude; without this the grid is not
// square on the ground and every map made in Britain comes out stretched.
const dLat = spanKm / 111.32;
const dLon = spanKm / (111.32 * Math.cos(lat * Math.PI / 180));
console.log(`${name}: ${n}x${n} over ${spanKm} km at ${lat}, ${lon}`);
console.log(`  ${dLat.toFixed(4)}° lat x ${dLon.toFixed(4)}° lon (longitude is ${(Math.cos(lat * Math.PI / 180) * 100).toFixed(0)}% of latitude here)`);

const points = [];
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  points.push([lat - dLat / 2 + dLat * j / (n - 1), lon - dLon / 2 + dLon * i / (n - 1)]);
}

const data = new Array(points.length).fill(null);
const BATCH = 100;
let fetched = 0;
for (let b = 0; b < points.length; b += BATCH) {
  const chunk = points.slice(b, b + BATCH);
  const locs = chunk.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    try {
      const r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${locs}`);
      const j = await r.json();
      if (j.status !== 'OK') throw new Error(j.error || j.status);
      j.results.forEach((res, k) => { data[b + k] = res.elevation; });
      ok = true; fetched += chunk.length;
    } catch (e) {
      console.log(`  batch ${b / BATCH}: ${e.message} — retrying`);
      await sleep(3000);
    }
  }
  if (!ok) console.log(`  batch ${b / BATCH}: gave up, ${chunk.length} points left null`);
  process.stdout.write(`\r  ${fetched}/${points.length}`);
  await sleep(1100);
}
console.log();

// Voids come back as null from the API and as -32768 from raw SRTM; both must be
// interpolated or they become spikes tall enough to be the whole model.
const voids = data.filter(v => v === null || v <= -1000).length;
for (let i = 0; i < data.length; i++) if (data[i] === null || data[i] <= -1000) data[i] = null;
if (voids) {
  for (let pass = 0; pass < 8; pass++) {
    let filled = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (data[k] !== null) continue;
      const near = [];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = i + di, y = j + dj;
        if (x >= 0 && x < n && y >= 0 && y < n && data[y * n + x] !== null) near.push(data[y * n + x]);
      }
      if (near.length) { data[k] = near.reduce((a, b) => a + b, 0) / near.length; filled++; }
    }
    if (!filled) break;
  }
}
const clean = data.map(v => v === null ? 0 : Math.round(v));
const minM = Math.min(...clean), maxM = Math.max(...clean);

const out = {
  name, lat, lon, spanKm, w: n, h: n, dataset,
  minM, maxM, voids,
  fetched: 'opentopodata.org public API',
  data: clean,
};
const file = `assets/terrain/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
writeFileSync(file, JSON.stringify(out));
console.log(`  ${minM} m to ${maxM} m (${maxM - minM} m of relief), ${voids} voids filled`);
console.log(`  written ${file}  ${(JSON.stringify(out).length / 1024).toFixed(0)} kB`);
