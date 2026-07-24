#!/usr/bin/env node
// End-to-end smoke test. Launches Chrome for Testing (or Chromium) headless
// with the extension loaded, drives it over the DevTools protocol, and
// asserts that the squeeze genuinely reflows the page, that fixed bars are
// inset, that state persists across reloads, and that styling survives a
// hostile CSP. No npm dependencies; needs Node >= 22 (global WebSocket).
//
//   node test/e2e.mjs [--chrome /path/to/chrome]
//
// Get a compatible browser with:
//   npx @puppeteer/browsers install chrome@stable --path .cft
// Branded Google Chrome >= 137 ignores --load-extension, so this script
// needs Chrome for Testing or Chromium. Manual testing works in any Chrome
// via chrome://extensions -> Load unpacked.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE_KEY = `page:${BASE}/page.html`;
const SHOT_DIR = process.env.SHOT_DIR || tmpdir();

if (typeof WebSocket === 'undefined') {
  console.error('This script needs Node >= 22 (global WebSocket).');
  process.exit(2);
}

function findChrome() {
  const argIdx = process.argv.indexOf('--chrome');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [];
  const cft = path.join(ROOT, '.cft', 'chrome');
  if (existsSync(cft)) {
    for (const ver of readdirSync(cft)) {
      for (const plat of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-linux64']) {
        candidates.push(path.join(
          cft, ver, plat,
          plat.startsWith('chrome-mac')
            ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
            : 'chrome',
        ));
      }
    }
  }
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  for (const c of candidates) if (existsSync(c)) return c;
  console.error('No Chrome for Testing / Chromium found.\nInstall one with:\n'
    + '  npx @puppeteer/browsers install chrome@stable --path .cft');
  process.exit(2);
}

// ---------- tiny CDP client (flat sessions) ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.onEvent?.(msg);
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket connect failed: ' + url));
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    // Commands whose target dies mid-flight can be dropped without a reply;
    // a bare await would hang the suite forever. 30s covers every legitimate
    // command (screenshots included) with a wide margin.
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 30000).unref?.();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(120);
  }
  throw new Error(`timed out waiting for: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

// ---------- assertion collection ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`);
}
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

async function main() {
  // Belt-and-braces: if anything above still manages to hang, fail loudly
  // with the transcript so far instead of blocking a CI runner forever.
  const watchdog = setTimeout(() => {
    console.error('\nE2E watchdog: suite exceeded 5 minutes; aborting.');
    process.exit(3);
  }, 300000);
  watchdog.unref?.();

  const chromeBin = findChrome();

  // Static server for the test pages.
  const server = createServer((req, res) => {
    const name = req.url === '/' ? 'page.html' : req.url.split('?')[0].slice(1);
    try {
      const data = readFileSync(path.join(ROOT, 'test', path.basename(name)));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profile = mkdtempSync(path.join(tmpdir(), 'sqz-e2e-'));
  const chrome = spawn(chromeBin, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`,
    // Chrome ships component extensions whose workers are also named
    // background.js; keep them out of the target list.
    '--disable-component-extensions-with-background-pages',
    // Keep the renderer producing frames even when the process is deemed
    // occluded or backgrounded — CSS transitions, rAF, resize dispatch and
    // screenshots all ride the BeginFrame tick and stall without these
    // (the same trio Puppeteer passes by default). Frames still starve if
    // the HOST goes to sleep mid-run; on macOS, run the suite under
    // `caffeinate -dims` when testing on a laptop that may nap.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Decouple BeginFrames from display vsync: on macOS the compositor's
    // clock (CVDisplayLink) stops with a sleeping display, freezing rAF,
    // transitions, resize dispatch and screenshots even in headless.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    server.close();
  };
  process.on('exit', cleanup);

  try {
    // Browser endpoint.
    const version = await until(async () => {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return res.ok ? res.json() : null;
    }, 20000, 'devtools endpoint');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);

    // Runtime.evaluate can be dropped without a reply if its execution
    // context dies mid-flight (a reload racing the call) — a bare await
    // would hang the suite forever. Time the call out instead; the until()
    // wrapper around every poll retries against the fresh context.
    const evalIn = async (sessionId, expression, awaitPromise = true) => {
      const r = await Promise.race([
        cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId),
        sleep(10000).then(() => { throw new Error('evaluate timed out (context destroyed?)'); }),
      ]);
      if (r.exceptionDetails) {
        throw new Error('evaluate threw: '
          + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
      }
      return r.result.value;
    };

    // Find OUR extension's service worker (verified by manifest name — the
    // browser may run other extension workers too). Attaching keeps it alive.
    const { sw, extId } = await until(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const candidates = targetInfos.filter((t) => t.type === 'service_worker'
        && t.url.startsWith('chrome-extension://'));
      for (const t of candidates) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        try {
          const name = await evalIn(sessionId, 'chrome.runtime.getManifest().name');
          if (name.startsWith('Pillarbox')) {
            console.log(`extension loaded: ${new URL(t.url).host}`);
            return { sw: sessionId, extId: new URL(t.url).host };
          }
        } catch {}
        cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return null;
    }, 15000, 'extension service worker target');

    const openPage = async (url) => {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await until(() => evalIn(sessionId, 'document.readyState === "complete"'), 10000, `load of ${url}`);
      return sessionId;
    };

    // Run `body` in the worker with `tab` bound to the tab whose URL starts
    // with the prefix (match-pattern URLs can't carry a port, so tabs are
    // filtered in JS instead).
    const viaWorker = (urlPrefix, body) => evalIn(sw, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(urlPrefix)}));
      if (!tab) throw new Error('no tab matches ' + ${JSON.stringify(urlPrefix)});
      ${body}
    })()`);
    const toggleViaWorker = (urlPrefix) => viaWorker(urlPrefix,
      `return await chrome.tabs.sendMessage(tab.id, { type: 'SQZ_TOGGLE' });`);

    const SNAP = `(() => {
      const de = document.documentElement;
      const cs = getComputedStyle(de);
      const rect = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      return {
        vw: innerWidth,
        cw: document.documentElement.clientWidth, // layout width, sans scrollbar
        ml: cs.marginLeft,
        mr: cs.marginRight,
        mlPrio: de.style.getPropertyPriority('margin-left'),
        host: !!document.querySelector('pillarbox-host'),
        nav: rect('navbar'),
        fab: rect('fab'),
        sticky: rect('sticky'),
        late: rect('lateBar'),
        morph: rect('morphBar'),
      };
    })()`;

    // ---------- main page ----------
    const page = await openPage(`${BASE}/page.html`);
    await sleep(300); // let the (dormant) content script finish booting

    const base = await evalIn(page, SNAP);
    check('baseline: no squeeze', base.ml === '0px' && !base.host && near(base.nav.width, base.cw),
      JSON.stringify(base));

    const on = await toggleViaWorker(`${BASE}/page.html`);
    check('toggle reports on:true', on && on.on === true, JSON.stringify(on));

    let s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '200px' && v.nav && near(v.nav.left, 200) ? v : null;
    }, 4000, 'squeeze applied incl. navbar');
    check('html margins 200px !important', s.ml === '200px' && s.mr === '200px' && s.mlPrio === 'important',
      `ml=${s.ml} mr=${s.mr} prio=${s.mlPrio}`);
    check('panels host mounted', s.host);
    check('fixed navbar inset (left=200, width=vw-400)',
      near(s.nav.left, 200) && near(s.nav.width, s.cw - 400), JSON.stringify(s.nav));
    check('sticky subheader reflowed by margins alone',
      near(s.sticky.left, 200) && near(s.sticky.width, s.cw - 400), JSON.stringify(s.sticky));
    check('partial-width fixed FAB untouched', near(s.fab.right, base.fab.right), JSON.stringify(s.fab));

    // Late-added fixed bar (childList path) + class-morphing bar (attribute path).
    await evalIn(page, `document.getElementById('addBar').click(); document.getElementById('morphNow').click(); true`);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.late && near(v.late.left, 200) && v.morph && near(v.morph.left, 200) ? v : null;
    }, 4000, 'late + morphed bars inset');
    check('late-added fixed bar inset', near(s.late.left, 200) && near(s.late.width, s.cw - 400), JSON.stringify(s.late));
    check('class-morphed fixed bar inset', near(s.morph.left, 200), JSON.stringify(s.morph));

    const settingsSet = (obj) => evalIn(sw,
      `chrome.storage.sync.set({ settings: ${JSON.stringify(obj)} })`);

    // Theme switching reaches the shadow DOM.
    const panelBg = () => evalIn(page,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot.querySelector('.panel.left')).backgroundColor`);
    await settingsSet({ theme: 'dark', defaultLeft: 200, defaultRight: 200 });
    await until(async () => (await panelBg()) === 'rgb(29, 33, 38)', 3000, 'dark panel color');
    check('theme dark applies to panels', true);
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });
    await until(async () => (await panelBg()) === 'rgb(238, 240, 243)', 3000, 'light panel color');
    check('theme light applies to panels', true);

    // Custom sidebar color reaches the panels live, then reset to default.
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200, colorLight: '#ff0000' });
    await until(async () => (await panelBg()) === 'rgb(255, 0, 0)', 3000, 'custom panel color');
    check('custom sidebar color applies to panels', true);
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });
    await until(async () => (await panelBg()) === 'rgb(238, 240, 243)', 3000, 'panel color reset');

    // Screenshots are for the humans — never let one sink the suite.
    const screenshot = async (sessionId, name, params = {}) => {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', ...params }, sessionId);
        const file = path.join(SHOT_DIR, name);
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log('screenshot: ' + file);
      } catch (e) {
        console.log(`screenshot ${name} skipped: ${e.message}`);
      }
    };
    await screenshot(page, 'squeeze-on.png');

    // Auto-restore after reload. Stamp the old document first so the poll
    // can't be satisfied by the pre-reload page.
    await evalIn(page, 'window.__sqzMark = 1; setTimeout(() => location.reload(), 0); true', false);
    s = await until(async () => {
      if (await evalIn(page, '!!window.__sqzMark')) return null; // old document
      const v = await evalIn(page, SNAP);
      return v.ml === '200px' && v.host && v.nav && near(v.nav.left, 200) ? v : null;
    }, 8000, 'auto-restore after reload');
    check('auto-restores after reload (incl. navbar)', true, JSON.stringify({ ml: s.ml, nav: s.nav }));

    // The margins apply before the panels finish their 160ms slide-in;
    // wait for the animation to settle so the handle is really at x=200.
    await until(() => evalIn(page,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot`
      + `.querySelector('.panel.left')).transform === 'none'`), 3000, 'panel slide-in settled');

    // Drag the left handle from 200 to 320 with synthesized mouse input
    // (the handle straddles the panel edge, so x=200 hits it).
    const mouse = (type, x, y, clickCount = 0, modifiers = 0, session = page) => cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount, pointerType: 'mouse', modifiers,
    }, session);
    const SHIFT = 8; // CDP modifier bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8
    await mouse('mousePressed', 200, 450, 1);
    for (const x of [206, 230, 270, 300, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '320px' && v.nav && near(v.nav.left, 320) ? v : null;
    }, 3000, 'drag resize applied live');
    check('drag resizes left side (margins + navbar follow live)', true, `ml=${s.ml}`);
    await until(async () => {
      const stored = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(PAGE_KEY)})`);
      return stored[PAGE_KEY]?.on === true && stored[PAGE_KEY]?.left === 320;
    }, 3000, 'dragged width persisted');
    check('dragged width persisted to the page record', true);

    // Double-click collapses the side to 0; another dblclick restores it.
    await mouse('mousePressed', 320, 450, 1); await mouse('mouseReleased', 320, 450, 1);
    await mouse('mousePressed', 320, 450, 2); await mouse('mouseReleased', 320, 450, 2);
    await until(async () => (await evalIn(page, SNAP)).ml === '0px', 3000, 'dblclick collapse');
    await mouse('mousePressed', 2, 450, 1); await mouse('mouseReleased', 2, 450, 1);
    await mouse('mousePressed', 2, 450, 2); await mouse('mouseReleased', 2, 450, 2);
    await until(async () => (await evalIn(page, SNAP)).ml === '320px', 3000, 'dblclick restore');
    check('dblclick collapses and restores the left side', true);

    // Min-gap clamp: with the right side at 200 the left handle can pass the
    // middle, but must stop at layoutWidth(1425) - MIN_GAP - 200 = 1025.
    await mouse('mousePressed', 320, 450, 1);
    for (const x of [340, 600, 900, 1200, 1380]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 1380, 450, 1);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '1025px' ? v : null;
    }, 3000, 'min-gap clamp during drag');
    check('one side passes the middle but a 200px page gap survives', true, `ml=${s.ml}`);
    await mouse('mousePressed', 1025, 450, 1);
    for (const x of [1000, 700, 400, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    await until(async () => (await evalIn(page, SNAP)).ml === '320px', 3000, 'drag back to 320');

    // Mirrored drag: holding any modifier while dragging moves the other
    // side by the same amount; releasing it mid-drag un-links again.
    // Shift-drag left 320 -> 420 (right follows 200 -> 300), then drop the
    // modifier and pull back to 380 (right must stay at 300).
    await mouse('mousePressed', 320, 450, 1);
    for (const x of [326, 360, 400, 420]) await mouse('mouseMoved', x, 450, 0, SHIFT);
    await mouse('mouseMoved', 380, 450);
    await mouse('mouseReleased', 380, 450, 1);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '380px' && v.mr === '300px' ? v : null;
    }, 3000, 'mirrored drag + mid-drag unlink');
    check('modifier-drag moves both sides; releasing mid-drag un-links', true,
      `ml=${s.ml} mr=${s.mr}`);

    // Mirrored min-gap clamp: both sides must stop TOGETHER when only the
    // 200px gap is left. offset = 300-380 = -80, budget = 1425-200 = 1225,
    // so left stops at floor((1225+80)/2) = 652 and right at 572.
    await mouse('mousePressed', 380, 450, 1);
    for (const x of [400, 800, 1380]) await mouse('mouseMoved', x, 450, 0, SHIFT);
    await mouse('mouseReleased', 1380, 450, 1);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '652px' && v.mr === '572px' ? v : null;
    }, 3000, 'mirrored min-gap clamp');
    check('mirrored drag stops both sides at the min gap', true, `ml=${s.ml} mr=${s.mr}`);

    // Mirror works from the right handle too; shift-drag it (at 1425-572 =
    // 853) out to 1225: right 572 -> 200, left follows 652 -> 280.
    await mouse('mousePressed', 853, 450, 1);
    for (const x of [860, 1000, 1225]) await mouse('mouseMoved', x, 450, 0, SHIFT);
    await mouse('mouseReleased', 1225, 450, 1);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '280px' && v.mr === '200px' ? v : null;
    }, 3000, 'mirrored drag from the right handle');
    check('modifier-drag mirrors from the right handle too', true, `ml=${s.ml} mr=${s.mr}`);

    // Double-click on a panel's empty space (x=100, well away from the
    // handle at ~280) resets both sides to the defaults (200/200).
    await mouse('mousePressed', 100, 450, 1); await mouse('mouseReleased', 100, 450, 1);
    await mouse('mousePressed', 100, 450, 2); await mouse('mouseReleased', 100, 450, 2);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '200px' && v.mr === '200px' ? v : null;
    }, 3000, 'dblclick empty space resets to defaults');
    check('dblclick on a panel\'s empty space restores default widths', true,
      `ml=${s.ml} mr=${s.mr}`);
    // Put the left side back at 320 for the persistence checks below.
    await mouse('mousePressed', 200, 450, 1);
    for (const x of [220, 280, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '320px' && v.mr === '200px';
    }, 3000, 'plain drag restores 320/200');

    // ---------- page zoom ----------
    // Widths are stored as px at 100% zoom, so the sidebars keep their size
    // on screen when the page is zoomed: at 2x, the 320/200 record must be
    // applied as 160/100 CSS px (and the fixed navbar follow). Zoom is
    // per-origin here (Chrome's default scope), so it must go back to 1
    // before the later sections open more pages on this origin.
    const setZoomViaWorker = (urlPrefix, factor) => viaWorker(urlPrefix,
      `await chrome.tabs.setZoom(tab.id, ${factor}); return true;`);
    const ZOOMED = async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '160px' && v.mr === '100px' && v.nav && near(v.nav.left, 160) ? v : null;
    };

    // Zero-flash probe: the corrected margin must be observable inside the
    // SAME rendering update that first reflects the zoomed viewport — long
    // before any worker round-trip could land. The page's resize listener
    // registers after the extension's, so its rAF runs after the
    // prediction rAF and before paint; it must already see the new margin.
    await evalIn(page, `window.__zoomProbe = new Promise((resolve) => {
      addEventListener('resize', () => requestAnimationFrame(() =>
        resolve(getComputedStyle(document.documentElement).marginLeft)), { once: true });
    }), true`, false);

    await setZoomViaWorker(`${BASE}/page.html`, 2);
    s = await until(ZOOMED, 5000, 'zoom change re-applies widths through the factor');
    check('2x zoom halves the CSS px widths (constant size on screen)', true,
      `ml=${s.ml} mr=${s.mr} navLeft=${s.nav.left} cw=${s.cw}`);
    const probed = await evalIn(page, `Promise.race([window.__zoomProbe,
      new Promise((r) => setTimeout(() => r('no resize event'), 3000))])`);
    check('corrected margin present in the first zoomed frame (no flash)',
      probed === '160px', `probe saw ${probed}`);
    const zoomed = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(PAGE_KEY)})`);
    check('zooming leaves the stored (100%-zoom) widths untouched',
      zoomed[PAGE_KEY]?.left === 320 && zoomed[PAGE_KEY]?.right === 200,
      JSON.stringify(zoomed[PAGE_KEY]));

    // The authoritative confirm persists a per-origin hint, which is what
    // lets the next boot on this origin apply exact widths straight from
    // the storage read (no service-worker round-trip on the boot path).
    const ZOOM_KEY = `zoom:${BASE}`;
    await until(async () => {
      const h = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(ZOOM_KEY)})`);
      return h[ZOOM_KEY] === 2;
    }, 3000, 'per-origin zoom hint persisted');
    check('per-origin zoom hint persisted while zoomed', true);

    // Boot path: a fresh content script on an already-zoomed origin picks
    // the factor up from the hint and auto-restores at exact widths.
    await evalIn(page, 'window.__sqzMark = 1; setTimeout(() => location.reload(), 0); true', false);
    s = await until(async () => {
      if (await evalIn(page, '!!window.__sqzMark')) return null; // old document
      return ZOOMED();
    }, 8000, 'auto-restore on a zoomed page load');
    check('auto-restore on a zoomed page load applies the same on-screen size',
      true, `ml=${s.ml} mr=${s.mr}`);

    await setZoomViaWorker(`${BASE}/page.html`, 1);
    await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '320px' && v.mr === '200px' && near(v.nav.left, 320);
    }, 5000, 'back to 100% zoom');
    check('back at 100% zoom the stored widths apply verbatim', true);
    await until(async () => {
      const h = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(ZOOM_KEY)})`);
      return !(ZOOM_KEY in h);
    }, 3000, 'zoom hint removed at 100%');
    check('zoom hint removed when the origin returns to 100%', true);

    // Per-URL memory: a same-document (SPA) navigation to another URL has
    // no record and must close the sidebars; navigating back reopens them
    // with this URL's saved widths.
    await evalIn(page, `history.pushState({}, '', '/spa-elsewhere'); true`);
    await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '0px' && !v.host ? v : null;
    }, 4000, 'SPA nav away closes sidebars');
    check('SPA pushState to a new URL closes the sidebars', true);
    await evalIn(page, `history.pushState({}, '', '/page.html'); true`);
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '320px' && v.host ? v : null;
    }, 4000, 'SPA nav back restores sidebars');
    check('SPA pushState back reopens with this URL\'s saved width', true, `ml=${s.ml}`);

    // Toggle off restores everything and persists on:false.
    const off = await toggleViaWorker(`${BASE}/page.html`);
    check('toggle reports on:false', off && off.on === false, JSON.stringify(off));
    s = await until(async () => {
      const v = await evalIn(page, SNAP);
      return v.ml === '0px' && !v.host && near(v.nav.width, v.cw) ? v : null;
    }, 4000, 'full restore after toggle off');
    check('toggle off restores page (margins, navbar, host removed)', true);
    const stored = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(PAGE_KEY)})`);
    const rec = stored[PAGE_KEY];
    check('record persisted with on:false and widths kept',
      rec && rec.on === false && rec.left === 320 && rec.right === 200, JSON.stringify(rec));

    // ---------- hostile CSP page ----------
    const csp = await openPage(`${BASE}/csp.html`);
    await sleep(300);
    const cspOn = await toggleViaWorker(`${BASE}/csp.html`);
    check('CSP page toggles on', cspOn && cspOn.on === true, JSON.stringify(cspOn));
    const cspState = await until(async () => {
      const v = await evalIn(csp, `(() => {
        const host = document.querySelector('pillarbox-host');
        if (!host) return null;
        return {
          ml: getComputedStyle(document.documentElement).marginLeft,
          bg: getComputedStyle(host.shadowRoot.querySelector('.panel.left')).backgroundColor,
        };
      })()`);
      return v && v.ml === '200px' ? v : null;
    }, 4000, 'CSP page squeezed');
    // 200px here also proves per-URL isolation: page.html (same origin) was
    // dragged to 320, but csp.html starts from the defaults.
    check('CSP page: squeeze applied from defaults (record isolated per URL)',
      cspState.ml === '200px', JSON.stringify(cspState));
    check('CSP page: shadow panel fully styled despite style-src none',
      ['rgb(238, 240, 243)', 'rgb(29, 33, 38)'].includes(cspState.bg), `bg=${cspState.bg}`);

    await screenshot(csp, 'squeeze-csp.png');

    // ---------- per-URL default-width rules ----------
    // First valid match wins; invalid regexes are skipped; the widths apply
    // on a page's FIRST enable (no saved record) and on double-click reset.
    await settingsSet({
      theme: 'light', defaultLeft: 200, defaultRight: 200,
      rules: [
        { pattern: '([', left: 999, right: 999 },      // invalid: skipped
        { pattern: 'ruled=1', left: 425, right: 425 }, // first valid match
        { pattern: 'ruled', left: 111, right: 111 },   // also matches; loses
      ],
    });
    const ruled = await openPage(`${BASE}/page.html?ruled=1`);
    await sleep(300);
    const ruledOn = await toggleViaWorker(`${BASE}/page.html?ruled=1`);
    check('ruled page toggles on', ruledOn && ruledOn.on === true, JSON.stringify(ruledOn));
    let rs = await until(async () => {
      const v = await evalIn(ruled, SNAP);
      return v.ml === '425px' && v.mr === '425px' ? v : null;
    }, 4000, 'rule widths applied on first enable');
    check('URL rule sets first-enable widths (invalid skipped, first match wins)',
      true, `ml=${rs.ml} mr=${rs.mr}`);

    // Drag away from the rule widths, then double-click a panel's empty
    // space: the reset must return to the RULE defaults, not the global 200s.
    await until(() => evalIn(ruled,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot`
      + `.querySelector('.panel.left')).transform === 'none'`), 3000, 'ruled panel settled');
    await mouse('mousePressed', 425, 450, 1, 0, ruled);
    for (const x of [420, 380, 340, 300]) await mouse('mouseMoved', x, 450, 0, 0, ruled);
    await mouse('mouseReleased', 300, 450, 1, 0, ruled);
    await until(async () => (await evalIn(ruled, SNAP)).ml === '300px', 3000, 'ruled page dragged to 300');
    await mouse('mousePressed', 100, 450, 1, 0, ruled);
    await mouse('mouseReleased', 100, 450, 1, 0, ruled);
    await mouse('mousePressed', 100, 450, 2, 0, ruled);
    await mouse('mouseReleased', 100, 450, 2, 0, ruled);
    rs = await until(async () => {
      const v = await evalIn(ruled, SNAP);
      return v.ml === '425px' && v.mr === '425px' ? v : null;
    }, 3000, 'dblclick reset returns to rule widths');
    check('double-click reset restores the rule defaults on a matching page', true,
      `ml=${rs.ml} mr=${rs.mr}`);
    // Clear the rules so later sections see the plain global defaults.
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });

    // ---------- options page ----------
    const opts = await openPage(`chrome-extension://${extId}/options/options.html`);
    await sleep(400);
    const optState = await evalIn(opts, `({
      theme: document.querySelector('input[name="theme"]:checked')?.value,
      left: document.getElementById('defaultLeft').value,
      right: document.getElementById('defaultRight').value,
      readout: document.getElementById('showReadout').checked,
      colorLight: document.getElementById('colorLight').value,
      colorDark: document.getElementById('colorDark').value,
      pageTheme: document.documentElement.dataset.theme,
    })`);
    check('options: current settings rendered (readout defaults off)',
      optState.theme === 'light' && optState.left === '200'
        && optState.readout === false && optState.colorLight === '#eef0f3'
        && optState.colorDark === '#1d2126' && optState.pageTheme === 'light',
      JSON.stringify(optState));

    // Clicking the dark radio saves immediately and re-themes the page.
    await evalIn(opts, `document.querySelector('input[name="theme"][value="dark"]').click(); true`);
    await until(async () => {
      const stored = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return stored.settings?.theme === 'dark'
        && (await evalIn(opts, `document.documentElement.dataset.theme`)) === 'dark';
    }, 3000, 'options save-on-change');
    check('options: theme change saves and re-themes the page', true);

    // The preview panels animate their color over ~150ms; wait for the end
    // state — this also verifies the live preview follows the settings.
    await until(async () => (await evalIn(opts,
      `getComputedStyle(document.getElementById('pvLeft')).backgroundColor`)) === 'rgb(29, 33, 38)',
      3000, 'preview reflects the dark sidebar color');
    check('options: live preview follows the settings', true);

    // The gesture reference renders, with platform modifier keycaps filled in.
    const gestures = await evalIn(opts, `({
      rows: [...document.querySelectorAll('.gesture')].length,
      modKeys: document.querySelectorAll('#modKeys kbd').length,
    })`);
    check('options: gesture reference rendered with modifier keycaps',
      gestures.rows === 5 && gestures.modKeys >= 3, JSON.stringify(gestures));

    // Rules editor: remote rules render as rows; adding and removing rows
    // saves through the same save-on-change path as every other field.
    await settingsSet({
      theme: 'dark', defaultLeft: 200, defaultRight: 200,
      rules: [{ pattern: 'example\\.com/articles', left: 530, right: 0 }],
    });
    await until(async () => (await evalIn(opts,
      `document.querySelectorAll('#rules .rule').length`)) === 1, 3000, 'rule row rendered');
    const row = await evalIn(opts, `({
      pattern: document.querySelector('.rule-pattern').value,
      left: document.querySelector('.rule-left').value,
      right: document.querySelector('.rule-right').value,
      invalid: document.querySelector('.rule-pattern').classList.contains('invalid'),
    })`);
    check('options: rule row renders from settings',
      row.pattern === 'example\\.com/articles' && row.left === '530'
        && row.right === '0' && row.invalid === false, JSON.stringify(row));
    await evalIn(opts, `(() => {
      document.getElementById('addRule').click();
      const rows = document.querySelectorAll('#rules .rule');
      const r = rows[rows.length - 1];
      r.querySelector('.rule-pattern').value = 'zhihu\\\\.com/question';
      r.querySelector('.rule-left').value = '425';
      r.querySelector('.rule-right').value = '425';
      r.querySelector('.rule-right').dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await until(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.length === 2
        && st.settings.rules[1].pattern === 'zhihu\\.com/question'
        && st.settings.rules[1].left === 425;
    }, 3000, 'added rule saved');
    check('options: adding a rule saves it', true);
    await evalIn(opts, `(document.querySelectorAll('.rule-remove')[1].click(), true)`);
    await until(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.length === 1;
    }, 3000, 'removed rule saved');
    check('options: removing a rule saves', true);

    await screenshot(opts, 'options.png', { captureBeyondViewport: true });

    // Echo regression: a save that changes nothing fires NO onChanged event,
    // so matching own writes by count leaks and swallows the next remote
    // change. Make an identical save, then a remote change — the form must
    // still re-render.
    await evalIn(opts, `(() => {
      const el = document.getElementById('defaultLeft');
      el.value = el.value; // unchanged -> identical settings object
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    await settingsSet({ theme: 'dark', defaultLeft: 333, defaultRight: 200 });
    await until(async () => (await evalIn(opts,
      `document.getElementById('defaultLeft').value`)) === '333',
      3000, 'options re-render after an identical save');
    check('options: identical save does not swallow the next remote change', true);
    await settingsSet({ theme: 'dark', defaultLeft: 200, defaultRight: 200 });
    await until(async () => (await evalIn(opts,
      `document.getElementById('defaultLeft').value`)) === '200',
      3000, 'default widths restored for later sections');

    // Silent LRU: only the SQZ.MAX_PAGES most recently used page records
    // are kept; the oldest are pruned by the service worker.
    await evalIn(sw, `(async () => {
      const fake = {};
      for (let i = 1; i <= 1005; i++) {
        fake['page:http://fake.test/' + i] = { on: false, left: 200, right: 200, t: i };
      }
      await chrome.storage.local.set(fake);
    })()`);
    await until(async () => {
      const all = await evalIn(sw, `chrome.storage.local.get(null)`);
      const pages = Object.keys(all).filter((k) => k.startsWith('page:'));
      return pages.length === 1000
        && !pages.includes('page:http://fake.test/1')
        && pages.includes(PAGE_KEY);
    }, 12000, 'LRU prune down to 1000 records');
    check('memory silently capped at the 1000 most recent pages (real records kept)', true);
    await evalIn(sw, `(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.includes('fake.test')));
    })()`);

    // ---------- app-shell page (nested absolute layers, artifact-viewer style) ----------
    const SHELL_SNAP = `(() => {
      const shell = document.getElementById('shell').getBoundingClientRect();
      const inner = document.getElementById('inner').getBoundingClientRect();
      return {
        ml: getComputedStyle(document.documentElement).marginLeft,
        left: shell.left,
        width: shell.width,
        innerLeft: inner.left,
        frameW: document.getElementById('frame').contentWindow.innerWidth,
      };
    })()`;
    const shellPage = await openPage(`${BASE}/appshell.html`);
    await sleep(300);
    const shellBase = await evalIn(shellPage, SHELL_SNAP);
    check('app shell baseline anchored to viewport', shellBase.left === 0 && near(shellBase.width, 1440),
      JSON.stringify(shellBase));
    const shellOn = await toggleViaWorker(`${BASE}/appshell.html`);
    check('app-shell page toggles on', shellOn && shellOn.on === true, JSON.stringify(shellOn));
    const shellSq = await until(async () => {
      const v = await evalIn(shellPage, SHELL_SNAP);
      return near(v.left, 200) && v.frameW <= shellBase.frameW - 380 ? v : null;
    }, 5000, 'absolute app shell inset');
    check('absolute inset-0 app shell is squeezed', true, JSON.stringify(shellSq));
    // Exactly ONE squeeze: the nested absolute layer must follow the shell,
    // not receive its own inset (cascade over-squeeze regression).
    check('nested absolute layer squeezed exactly once (no cascade)',
      near(shellSq.innerLeft, 200) && near(shellSq.frameW, shellBase.frameW - 400, 8),
      `innerLeft=${shellSq.innerLeft} frameW before=${shellBase.frameW} after=${shellSq.frameW}`);

    // Anchor-loss regression: a transform on <body> makes it the containing
    // block for the absolute shell, which then follows the squeezed body on
    // its own — keeping our inline insets would squeeze it twice. The
    // manager must release the shell (inline left gone, marker gone) while
    // the shell still lands at x=200 via the body.
    await evalIn(shellPage, `document.body.style.transform = 'translateZ(0)'; true`);
    const shellFreed = await until(async () => {
      const v = await evalIn(shellPage, `(() => {
        const el = document.getElementById('shell');
        return {
          inlineLeft: el.style.left,
          marker: el.style.getPropertyValue('--pillarbox'),
          left: el.getBoundingClientRect().left,
        };
      })()`);
      return v.inlineLeft === '' && v.marker === '' && near(v.left, 200) ? v : null;
    }, 4000, 'anchor-lost shell released (still single-squeezed via body)');
    check('absolute shell released when an ancestor becomes its containing block',
      true, JSON.stringify(shellFreed));

    await toggleViaWorker(`${BASE}/appshell.html`);
    await until(async () => {
      const v = await evalIn(shellPage, SHELL_SNAP);
      return v.ml === '0px' && v.left === 0 && near(v.frameW, shellBase.frameW) ? v : null;
    }, 4000, 'app shell restored');
    check('app shell fully restored on toggle off', true);

    // ---------- viewport-unit shells (chatgpt/notion/reddit patterns) ----------
    const VW_SNAP = `(() => {
      const cw = document.documentElement.clientWidth;
      const r = (id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right) };
      };
      const brk = getComputedStyle(document.getElementById('breakout'));
      const host = document.querySelector('pillarbox-host');
      const table = document.getElementById('wideTable');
      return {
        cw,
        ml: getComputedStyle(document.documentElement).marginLeft,
        shell: r('vwshell'), inner: r('inner100vw'),
        breakout: r('breakout'), table: r('wideTable'),
        brkMargin: brk.marginLeft, brkPad: brk.paddingLeft,
        hostVis: host ? getComputedStyle(host).visibility : null,
        tableMarked: table.style.getPropertyValue('--pillarbox'),
        tableInlineW: table.style.width,
      };
    })()`;
    const vwPage = await openPage(`${BASE}/vwshell.html`);
    await sleep(300);
    const vwOn = await toggleViaWorker(`${BASE}/vwshell.html`);
    check('vw-shell page toggles on', vwOn && vwOn.on === true, JSON.stringify(vwOn));
    const vs = await until(async () => {
      const v = await evalIn(vwPage, VW_SNAP);
      return v.ml === '200px' && v.shell.left === 200
        && v.shell.right === v.cw - 200 && v.breakout.left === 200 ? v : null;
    }, 5000, 'vw shells squeezed');
    check('width:100vw shells adopted (stylesheet + nested inline)',
      vs.inner.left === 200 && vs.inner.right === vs.cw - 200,
      JSON.stringify({ shell: vs.shell, inner: vs.inner }));
    check('negative-margin breakout neutralized (reddit header pattern)',
      vs.breakout.right === vs.cw - 200 && vs.brkMargin === '0px' && vs.brkPad === '0px',
      JSON.stringify({ rect: vs.breakout, margin: vs.brkMargin, pad: vs.brkPad }));
    check('panels visible despite :not(:defined) anti-FOUC rule',
      vs.hostVis === 'visible', `visibility=${vs.hostVis}`);
    check('content-sized table adoption backed out (verify-and-undo)',
      vs.tableMarked === '' && vs.tableInlineW === '' && vs.table.right > vs.cw - 200,
      JSON.stringify({ marked: vs.tableMarked, inlineW: vs.tableInlineW, rect: vs.table }));

    // Toggle off restores everything, including the inline 100vw prior.
    await toggleViaWorker(`${BASE}/vwshell.html`);
    await until(async () => (await evalIn(vwPage, VW_SNAP)).ml === '0px', 4000, 'vw shells restored');
    const vwRestored = await evalIn(vwPage, `({
      shellW: document.getElementById('vwshell').style.width,
      innerW: document.getElementById('inner100vw').style.width,
      brkStyle: document.getElementById('breakout').getAttribute('style') ?? '',
    })`);
    check('flow adoptions fully restored (inline width:100vw prior kept)',
      vwRestored.shellW === '' && vwRestored.innerW === '100vw'
        && !vwRestored.brkStyle.includes('margin'),
      JSON.stringify(vwRestored));

    // ---------- extension reload orphans the content script ----------
    // Reloading (or updating) the extension kills chrome.* in already-open
    // tabs. The orphaned script must tear itself down on its next wake-up:
    // restore the page, never call dead chrome.storage (the
    // "Extension context invalidated" console error), never fight a fresh
    // script's styles. Last section — the reload does not resurrect an
    // unpacked extension under --load-extension, so the worker is gone after.
    const orphPage = await openPage(`${BASE}/page.html?orphan`);
    await cdp.send('Runtime.enable', {}, orphPage);
    const orphExceptions = [];
    cdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.exceptionThrown' && msg.sessionId === orphPage) {
        orphExceptions.push(msg.params.exceptionDetails.exception?.description
          ?? msg.params.exceptionDetails.text);
      }
    };
    await sleep(300);
    const orphOn = await toggleViaWorker(`${BASE}/page.html?orphan`);
    check('orphan-section page toggles on', orphOn && orphOn.on === true, JSON.stringify(orphOn));
    await until(async () => (await evalIn(orphPage, SNAP)).ml === '200px', 4000, 'orphan page squeezed');
    // No await: the reload destroys the worker session, so no reply comes.
    cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sw).catch(() => {});
    await sleep(1200);
    // First wake-up: a foreign write to the html style attribute. The old
    // squeeze watcher must tear the orphan down instead of re-asserting.
    await evalIn(orphPage, 'document.documentElement.style.color = "red", "poked"');
    const orphDown = await until(async () => {
      const v = await evalIn(orphPage, SNAP);
      return v.ml === '0px' && !v.host ? v : null;
    }, 4000, 'orphan teardown restored the page');
    check('orphaned script restores the page on its first wake-up', true, JSON.stringify(
      { ml: orphDown.ml, host: orphDown.host }));
    // SPA navigation after teardown must be a no-op, not a storage call.
    await evalIn(orphPage, 'history.pushState({}, "", "/page.html?orphan2"), "pushed"');
    await sleep(600);
    check('orphan logs no "Extension context invalidated" errors',
      orphExceptions.length === 0, orphExceptions.join(' | '));
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
