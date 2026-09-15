// Screenshot a page after a REAL wait, so CSS animations and IntersectionObserver reveals have run.
// (--virtual-time-budget does not advance CSS animations, and headless window widths under ~500 are clamped;
//  use --emulate for phone widths.) Used to verify the public landing page, 2026-09-13.
//
// shot.mjs <url> <width> <height> <waitMs> <out.png> [--full] [--rm] [--scroll]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const [url, w, h, wait, out, ...flags] = process.argv.slice(2);
const PORT = 9336;
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-dev-shm-usage', `--window-size=${w},${h}`, '--hide-scrollbars', ...(flags.includes('--rm') ? ['--force-prefers-reduced-motion'] : []), 'about:blank'], { stdio: ['ignore','ignore','ignore'] });
const reap = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.once('exit', reap);
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!target) await sleep(200); }
  const ws = new WebSocket(target); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalp = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Page.enable'); if (flags.includes('--emulate')) await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: true }); await send('Page.navigate', { url });
  await sleep(Number(wait));
  if (flags.includes('--scroll')) { // walk the page so IntersectionObserver reveals fire, then return to top
    const H = await evalp('document.documentElement.scrollHeight');
    for (let y = 0; y < H; y += 500) { await evalp(`(window.scrollTo(0, ${y}), true)`); await sleep(120); }
    await sleep(1200); await evalp('(window.scrollTo(0, 0), true)'); await sleep(300);
  }
  let params = { format: 'png' };
  if (flags.includes('--full')) { const H = await evalp('document.documentElement.scrollHeight'); params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Number(w), height: H, scale: 1 } }; }
  const r = await send('Page.captureScreenshot', params);
  writeFileSync(out, Buffer.from(r.result.data, 'base64')); console.log('wrote', out);
} finally { reap(); }
