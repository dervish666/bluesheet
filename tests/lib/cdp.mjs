// Minimal CDP driver — open the page in real Chrome, run JS in it, read the answer
// back. Node 22 ships a global WebSocket, so this needs no npm packages at all.
// Adapted from the Sandbox 3D harness, with console/error capture added: a page
// that renders but throws in the console is not working, and a test that cannot
// see the console cannot tell the difference.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.BLUESHEET_CDP_PORT || 9334);
const URL_ = process.env.BLUESHEET_URL || 'http://127.0.0.1:8132/';

export async function withPage(fn, { readyExpr = 'typeof window.__bluesheet !== "undefined" && window.__bluesheet.ready === true', timeout = 60000, size = '1400,900' } = {}) {
  const headed = process.env.BLUESHEET_HEADED === '1';
  const chrome = spawn('google-chrome', [
    ...(headed ? [] : ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-dev-shm-usage', `--window-size=${size}`,
    ...(headed ? ['--new-window', '--no-first-run', '--user-data-dir=/tmp/bluesheet-headed-profile'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let stderr = '';
  chrome.stderr.on('data', d => { stderr += d; });

  // `finally` below does not run when the whole node process is killed — which is
  // exactly what `timeout` does to a slow test — and each orphan is a headless
  // Chrome holding a few hundred megabytes. Sixty-two of them accumulated on this
  // laptop in one morning before anyone noticed, which is also why the later
  // tests were timing out. So the kill is registered at the process level too.
  const reap = () => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } };
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { reap(); process.exit(130); });
  process.once('uncaughtException', (e) => { reap(); throw e; });

  const consoleLines = [], pageErrors = [];
  try {
    const target = await waitForTarget();
    const ws = new WebSocket(target);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
        consoleLines.push({ level: m.params.type, text });
        if (m.params.type === 'error') pageErrors.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(d.exception?.description || d.text);
      }
    };
    const send = (method, params = {}) => new Promise(res => {
      const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: URL_ });

    const ready = await poll(async () => (await evaluate(send, readyExpr)) === true, timeout);
    if (!ready) {
      const err = await evaluate(send, 'document.body ? document.body.innerText.slice(0,400) : "no body"').catch(() => '?');
      throw new Error(`page never became ready (${readyExpr})\nbody: ${err}\nerrors: ${pageErrors.slice(0, 5).join('\n')}\n${stderr.slice(-1200)}`);
    }

    const page = {
      eval: expr => evaluate(send, expr),
      send,
      consoleLines, pageErrors,
      errors: () => pageErrors.slice(),
      /** Dispatch a real mouse event through the input pipeline, not a synthetic JS event. */
      async click(x, y) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(60);
      },
      async drag(x0, y0, x1, y1, steps = 8) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left' });
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
        await sleep(60);
      },
      async screenshot(path) {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path, Buffer.from(r.result.data, 'base64'));
        return path;
      },
      sleep,
    };
    return await fn(page);
  } finally {
    reap();
    process.removeListener('exit', reap);
  }
}

async function evaluate(send, expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({__err: String(e && e.stack || e)}); } })()`,
    awaitPromise: true, returnByValue: true,
  });
  const v = r.result?.result?.value;
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error((d.exception?.description || d.exception?.value || d.text) + ' :: ' + String(expr).slice(0, 200));
  }
  if (v === undefined) return undefined;
  const parsed = JSON.parse(v);
  if (parsed && parsed.__err) throw new Error(parsed.__err + ' :: ' + String(expr).slice(0, 200));
  return parsed;
}

async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(250); }
  return false;
}

async function waitForTarget() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('chrome debug port never opened');
}
