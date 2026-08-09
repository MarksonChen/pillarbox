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

// The inverse of until(): assert something KEEPS being true for a window.
// A negative check taken as one delayed snapshot proves only that the thing
// it rules out had not happened yet — on a loaded machine the boot, or the
// re-apply, it is guarding against can simply land later.
async function stays(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await fn())) throw new Error(`stopped holding: ${label}`);
    await sleep(150);
  }
  return true;
}
const holds = (fn, ms, label) => stays(fn, ms, label).then(() => true).catch(() => false);

// ---------- assertion collection ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`);
}
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

// A check whose assertion IS the wait. Polls `snap` until `pred` accepts what
// it returns and records a PASS; when the window runs out it records a FAIL
// and the run CONTINUES.
//
// That last part is the whole point. until() throws, and a throw here aborts
// the process — so one broken behaviour used to hide every result after it,
// turning a suite of 120-odd findings into a single line. A regression should
// cost you one FAIL, not the rest of the transcript.
//
// The last snapshot comes back either way, so the assertions that follow have
// something real to read (and to fail on) instead of a TypeError on undefined.
async function checkFor(name, snap, pred, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let ok = false;
  for (;;) {
    try {
      last = await snap();
      if (pred(last)) { ok = true; break; }
    } catch (e) {
      last = { error: e.message };
    }
    if (Date.now() >= deadline) break;
    await sleep(120);
  }
  check(name, ok, describe ? describe(last) : JSON.stringify(last));
  return last ?? {};
}

// A wait with no assertion of its own — a precondition some later check
// depends on (an animation settling, a navigation committing). Never throws:
// giving up is announced and the run carries on, so the checks that follow
// report what actually happened instead of vanishing with the process.
async function waitFor(fn, timeoutMs, label) {
  try {
    await until(fn, timeoutMs, label);
    return true;
  } catch (e) {
    console.log(`NOTE  gave up waiting for ${label} — later checks may fail as a result`);
    return false;
  }
}

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
      res.setHeader('content-type', name.endsWith('.css')
        ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // Second origin (the port differs) for the breakpoint-shifter tests:
  // stylesheets served from here are cross-origin to the test pages, so
  // cssRules throws and the extension has to go through the worker fetch +
  // <style> clone path. The port is hardcoded in test/mq.html.
  const PORT2 = 8124;
  const CROSS_CSS = '@import url("mq-import.css") (max-width: 1000px);\n'
    + '#x { color: rgb(10, 10, 10); }\n'
    + '@media (max-width: 1000px) { #x { color: rgb(60, 60, 60); } }\n'
    + '#xover { color: rgb(0, 0, 200); }\n'
    + '#bgprobe { background-image: url(px.gif); }\n';
  const server2 = createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/cross.css') {
      res.setHeader('content-type', 'text/css');
      res.end(CROSS_CSS);
    } else if (u === '/mq-import.css') {
      res.setHeader('content-type', 'text/css');
      res.end('#imp { color: rgb(70, 70, 70); }\n');
    } else if (u === '/px.gif') {
      res.setHeader('content-type', 'image/gif');
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    } else if (u === '/ord-a.css') {
      // Deliberately slow: the first of two sibling imports must still end up
      // first in the DOM, however late its bytes arrive.
      res.setHeader('content-type', 'text/css');
      setTimeout(() => res.end('#ord { color: rgb(1, 1, 1); }\n'), 500);
    } else if (u === '/ord-b.css') {
      res.setHeader('content-type', 'text/css');
      res.end('#ord { color: rgb(2, 2, 2); }\n');
    } else if (u === '/layered.css') {
      res.setHeader('content-type', 'text/css');
      res.end('#lay { color: rgb(130, 130, 130); }\n');
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server2.listen(PORT2, '127.0.0.1', r));

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
    server2.close();
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
    const { sw, extId, swTargetId } = await until(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const candidates = targetInfos.filter((t) => t.type === 'service_worker'
        && t.url.startsWith('chrome-extension://'));
      for (const t of candidates) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        try {
          const name = await evalIn(sessionId, 'chrome.runtime.getManifest().name');
          if (name.startsWith('Pillarbox')) {
            console.log(`extension loaded: ${new URL(t.url).host}`);
            return { sw: sessionId, extId: new URL(t.url).host, swTargetId: t.targetId };
          }
        } catch {}
        cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return null;
    }, 15000, 'extension service worker target');

    const openPage = async (url) => {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await waitFor(() => evalIn(sessionId, 'document.readyState === "complete"'),
        10000, `load of ${url}`);
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
        // Layout width, sans scrollbar. Derived from the html box + margins
        // rather than documentElement.clientWidth: while squeezed, the
        // MAIN-world hook shifts what clientWidth reports (that lie is the
        // feature), and these tests need the true width for clamp math.
        cw: Math.round(de.getBoundingClientRect().width
          + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight)),
        ml: cs.marginLeft,
        mr: cs.marginRight,
        mlPrio: de.style.getPropertyPriority('margin-left'),
        host: !!document.querySelector('pillarbox-host'),
        nav: rect('navbar'),
        fab: rect('fab'),
        sticky: rect('sticky'),
        late: rect('lateBar'),
        morph: rect('morphBar'),
        anc: rect('ancestorBar'),
        minPct: rect('minPctBar'),
        hiddenBar: rect('hiddenBar'),
        dock: rect('dockBar'),
        dockInline: document.getElementById('dockBar')?.style.left ?? null,
        dockMarker: document.getElementById('dockBar')?.style.getPropertyValue('--pillarbox') ?? null,
      };
    })()`;

    // ---------- main page ----------
    const page = await openPage(`${BASE}/page.html`);
    const pageSnap = () => evalIn(page, SNAP);
    await sleep(300); // let the (dormant) content script finish booting

    const base = await evalIn(page, SNAP);
    check('baseline: no squeeze', base.ml === '0px' && !base.host && near(base.nav.width, base.cw),
      JSON.stringify(base));

    const on = await toggleViaWorker(`${BASE}/page.html`);
    check('toggle reports on:true', on && on.on === true, JSON.stringify(on));

    // This profile has never saved settings, so the first enable lands on the
    // SHIPPED defaults. Read them from the extension rather than hardcoding:
    // they are a product decision that moves independently of the drag
    // choreography further down.
    const DEF = await evalIn(sw,
      '({ l: SQZ.DEFAULT_SETTINGS.defaultLeft, r: SQZ.DEFAULT_SETTINGS.defaultRight })');
    const inner = (v) => v.cw - DEF.l - DEF.r;

    let s = await checkFor(
      `html margins ${DEF.l}/${DEF.r}px !important (the shipped defaults)`,
      pageSnap,
      (v) => v.ml === `${DEF.l}px` && v.mr === `${DEF.r}px` && v.mlPrio === 'important',
      4000, (v) => `ml=${v.ml} mr=${v.mr} prio=${v.mlPrio}`);
    check('panels host mounted', s.host === true);
    check('fixed navbar inset to the default widths',
      s.nav && near(s.nav.left, DEF.l) && near(s.nav.width, inner(s)), JSON.stringify(s.nav));
    check('sticky subheader reflowed by margins alone',
      s.sticky && near(s.sticky.left, DEF.l) && near(s.sticky.width, inner(s)),
      JSON.stringify(s.sticky));
    check('partial-width fixed FAB untouched',
      s.fab && near(s.fab.right, base.fab.right), JSON.stringify(s.fab));

    // Late-added fixed bar (childList path) + class-morphing bar (attribute path).
    await evalIn(page, `document.getElementById('addBar').click(); document.getElementById('morphNow').click(); true`);
    s = await checkFor('late-added fixed bar inset',
      pageSnap,
      (v) => v.late && near(v.late.left, DEF.l) && near(v.late.width, inner(v)),
      4000, (v) => JSON.stringify(v.late));
    check('class-morphed fixed bar inset',
      s.morph && near(s.morph.left, DEF.l), JSON.stringify(s.morph));

    // Footer revealed by a class on <body>, not on itself. Its own attributes
    // never change, so reconsider(target) alone leaves it at full viewport
    // width running under the panels — the "doesn't resize until I scroll"
    // report (scrolling only helped because those pages ALSO touch the bar's
    // own class). Only the dirty-subtree rescan can find it.
    //
    // The settle is what makes this test mean anything: every width change
    // schedules a debounced whole-document rescan, and one of those landing
    // after the reveal would adopt the bar for the wrong reason and hide a
    // regression. Sit out any pending rescan first, so the ancestor-driven
    // subtree walk is the only mechanism left that can inset it.
    await sleep(1000);
    await evalIn(page, `document.getElementById('revealNow').click(); true`);
    s = await checkFor('footer revealed by an ancestor class is inset',
      pageSnap,
      (v) => v.anc && v.anc.width > 0 && near(v.anc.left, DEF.l) && near(v.anc.width, inner(v)),
      4000, (v) => JSON.stringify(v.anc));

    // A viewport-sized min-width outlives left/right insets: the bar keeps
    // its full width and merely shifts right, tail off screen. The percent
    // spelling of it is the one getComputedStyle does not resolve to px.
    check('fixed bar with min-width:100% is defused, not just shifted',
      s.minPct && near(s.minPct.left, DEF.l) && near(s.minPct.width, inner(s)),
      JSON.stringify(s.minPct));

    // Revealed by clearing the `hidden` attribute — no class, no style, no
    // childList mutation anywhere for anything else to notice.
    await evalIn(page, `document.getElementById('revealHidden').click(); true`);
    s = await checkFor('bar revealed by clearing the hidden attribute is inset',
      pageSnap,
      (v) => v.hiddenBar && v.hiddenBar.width > 0
        && near(v.hiddenBar.left, DEF.l) && near(v.hiddenBar.width, inner(v)),
      4000, (v) => JSON.stringify(v.hiddenBar));

    // Anchor loss with no ancestor involved: the bar swaps its OWN position
    // from fixed to absolute inside a positioned wrapper, so it stops
    // resolving against the viewport. Kept adopted, our insets would resolve
    // against the already-squeezed wrapper and squeeze it twice.
    check('scroll-dock bar adopted while fixed',
      s.dock && near(s.dock.left, DEF.l), JSON.stringify(s.dock));
    await evalIn(page, `document.getElementById('dockNow').click(); true`);
    await checkFor('bar that swaps fixed for absolute is released (squeezed once, via its wrapper)',
      pageSnap,
      (v) => v.dockInline === '' && v.dockMarker === ''
        && v.dock && near(v.dock.left, DEF.l) && near(v.dock.width, inner(v)),
      4000,
      (v) => JSON.stringify({ inline: v.dockInline, marker: v.dockMarker, rect: v.dock }));

    const settingsSet = (obj) => evalIn(sw,
      `chrome.storage.sync.set({ settings: ${JSON.stringify(obj)} })`);

    // Theme switching reaches the shadow DOM.
    const panelBg = () => evalIn(page,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot.querySelector('.panel.left')).backgroundColor`);
    const bgIs = (want) => [panelBg, (bg) => bg === want, 3000, (bg) => `panel bg ${bg}`];
    await settingsSet({ theme: 'dark', defaultLeft: 200, defaultRight: 200 });
    await checkFor('theme dark applies to panels', ...bgIs('rgb(29, 33, 38)'));
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });
    await checkFor('theme light applies to panels', ...bgIs('rgb(238, 240, 243)'));

    // Custom sidebar color reaches the panels live, then reset to default.
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200, colorLight: '#ff0000' });
    await checkFor('custom sidebar color applies to panels', ...bgIs('rgb(255, 0, 0)'));
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });
    await waitFor(async () => (await panelBg()) === 'rgb(238, 240, 243)', 3000, 'panel color reset');

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

    // Anchor loss, fixed edition. transform/filter/will-change/contain make
    // an ancestor the containing block for FIXED descendants too, not just
    // absolute ones, and our viewport insets would then resolve against that
    // (already squeezed) box and collapse the bar to nothing. It must be
    // released, and land squeezed exactly once via the ancestor.
    await evalIn(page, `document.body.style.transform = 'translateZ(0)'; true`);
    await checkFor('fixed bar released when an ancestor becomes its containing block',
      () => evalIn(page, `(() => {
        const el = document.getElementById('navbar');
        const r = el.getBoundingClientRect();
        return {
          inlineLeft: el.style.left,
          marker: el.style.getPropertyValue('--pillarbox'),
          left: r.left, width: r.width,
        };
      })()`),
      (v) => v.inlineLeft === '' && v.marker === ''
        && near(v.left, DEF.l) && near(v.width, inner(base)),
      4000);
    // The reload below rebuilds the document, dropping the transform with it.

    // Everything from here on is drag choreography at fixed coordinates, so
    // pin the record to a known 200/200 baseline — otherwise every expected
    // width below moves whenever the shipped defaults do. The reload that
    // follows applies it, and doubles as the auto-restore check.
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(PAGE_KEY)}:`
      + ` { on: true, left: 200, right: 200, t: Date.now() } })`);

    // Auto-restore after reload. Stamp the old document first so the poll
    // can't be satisfied by the pre-reload page.
    await evalIn(page, 'window.__sqzMark = 1; setTimeout(() => location.reload(), 0); true', false);
    s = await checkFor('auto-restores after reload (incl. navbar)',
      async () => (await evalIn(page, '!!window.__sqzMark')
        ? { stale: true } // still the pre-reload document
        : evalIn(page, SNAP)),
      (v) => !v.stale && v.ml === '200px' && v.host && v.nav && near(v.nav.left, 200),
      8000, (v) => JSON.stringify({ ml: v.ml, nav: v.nav }));

    // The margins apply before the panels finish their 160ms slide-in;
    // wait for the animation to settle so the handle is really at x=200.
    await waitFor(() => evalIn(page,
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
    s = await checkFor('drag resizes left side (margins + navbar follow live)',
      () => evalIn(page, SNAP),
      (v) => v.ml === '320px' && v.nav && near(v.nav.left, 320),
      3000, (v) => `ml=${v.ml}`);
    await checkFor('dragged width persisted to the page record',
      () => evalIn(sw, `chrome.storage.local.get(${JSON.stringify(PAGE_KEY)})`),
      (st) => st[PAGE_KEY]?.on === true && st[PAGE_KEY]?.left === 320,
      3000, (st) => JSON.stringify(st[PAGE_KEY] ?? null));

    // Double-click collapses the side to 0; another dblclick restores it.
    await mouse('mousePressed', 320, 450, 1); await mouse('mouseReleased', 320, 450, 1);
    await mouse('mousePressed', 320, 450, 2); await mouse('mouseReleased', 320, 450, 2);
    const collapsed = await waitFor(async () => (await evalIn(page, SNAP)).ml === '0px',
      3000, 'dblclick collapse');
    await mouse('mousePressed', 2, 450, 1); await mouse('mouseReleased', 2, 450, 1);
    await mouse('mousePressed', 2, 450, 2); await mouse('mouseReleased', 2, 450, 2);
    await checkFor('dblclick collapses and restores the left side',
      () => evalIn(page, SNAP), (v) => collapsed && v.ml === '320px',
      3000, (v) => `collapsed=${collapsed} then ml=${v.ml}`);

    // A drag can start on the SECOND press of a double-click — Chrome's
    // dblclick slop is wider than DRAG_THRESHOLD — and the dblclick that
    // follows must not undo the resize the user just made.
    await mouse('mousePressed', 320, 450, 1); await mouse('mouseReleased', 320, 450, 1);
    await mouse('mousePressed', 321, 450, 2);
    for (const x of [330, 380, 420]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 420, 450, 2);
    await sleep(400); // let any dblclick land before believing the width
    s = await evalIn(page, SNAP);
    check('a drag on the second click of a pair is not undone by the dblclick',
      s.ml === '420px', `ml=${s.ml} (0px = the dblclick collapsed it)`);
    // The mirror of it: the drag lands on the FIRST click of the pair. Time
    // alone cannot tell this apart from a drag followed by a separate quick
    // double-click — the collapse asserted further up — so both must hold.
    await mouse('mousePressed', 420, 450, 1);
    for (const x of [414, 400, 380]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 380, 450, 1);
    await mouse('mousePressed', 380, 450, 2); await mouse('mouseReleased', 380, 450, 2);
    await sleep(400);
    s = await evalIn(page, SNAP);
    check('a drag on the FIRST click of a pair is not undone by the dblclick either',
      s.ml === '380px', `ml=${s.ml} (0px = the dblclick collapsed it)`);
    await mouse('mousePressed', 380, 450, 1);
    for (const x of [370, 340, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    await waitFor(async () => (await pageSnap()).ml === '320px', 3000, 'back to 320');

    // Every clamp below is measured against the LAYOUT width, which is the
    // window width minus a classic scrollbar — and whether this Chrome gives
    // the page a classic (15px) or an overlay (0px) scrollbar varies by
    // version and platform. Read it from the page rather than assuming it,
    // or the expected widths are off by the scrollbar on half the machines.
    const LW = (await evalIn(page, SNAP)).cw;
    const FAR = LW - 60; // a drag target well past every clamp

    // Min-gap clamp: with the right side at 200 the left handle can pass the
    // middle, but must stop at layoutWidth - MIN_GAP - 200.
    const capLeft = LW - 200 - 200;
    await mouse('mousePressed', 320, 450, 1);
    for (const x of [340, 600, 900, 1200, FAR]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', FAR, 450, 1);
    await checkFor('one side passes the middle but a 200px page gap survives',
      pageSnap, (v) => v.ml === `${capLeft}px`, 3000,
      (v) => `ml=${v.ml} (layout width ${LW}, expected ${capLeft}px)`);
    await mouse('mousePressed', capLeft, 450, 1);
    for (const x of [1000, 700, 400, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    await waitFor(async () => (await pageSnap()).ml === '320px', 3000, 'drag back to 320');

    // Mirrored drag: holding any modifier while dragging moves the other
    // side by the same amount; releasing it mid-drag un-links again.
    // Shift-drag left 320 -> 420 (right follows 200 -> 300), then drop the
    // modifier and pull back to 380 (right must stay at 300).
    await mouse('mousePressed', 320, 450, 1);
    for (const x of [326, 360, 400, 420]) await mouse('mouseMoved', x, 450, 0, SHIFT);
    await mouse('mouseMoved', 380, 450);
    await mouse('mouseReleased', 380, 450, 1);
    await checkFor('modifier-drag moves both sides; releasing mid-drag un-links',
      pageSnap, (v) => v.ml === '380px' && v.mr === '300px', 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 380/300)`);

    // Mirrored min-gap clamp: both sides must stop TOGETHER when only the
    // 200px gap is left. offset = 300 - 380 = -80 and budget = LW - MIN_GAP,
    // so the near side stops at floor((budget + 80) / 2) and the far side 80
    // behind it.
    const mirrorLeft = Math.floor((LW - 200 + 80) / 2);
    const mirrorRight = mirrorLeft - 80;
    await mouse('mousePressed', 380, 450, 1);
    for (const x of [400, 800, FAR]) await mouse('mouseMoved', x, 450, 0, SHIFT);
    await mouse('mouseReleased', FAR, 450, 1);
    await checkFor('mirrored drag stops both sides at the min gap',
      pageSnap, (v) => v.ml === `${mirrorLeft}px` && v.mr === `${mirrorRight}px`, 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected ${mirrorLeft}/${mirrorRight})`);

    // Mirror works from the right handle too; shift-drag it (at LW minus the
    // right width) out to LW - 200: right lands on 200 and left follows to
    // 280, keeping the 80px offset.
    const rightHandle = LW - mirrorRight;
    await mouse('mousePressed', rightHandle, 450, 1);
    for (const x of [rightHandle + 7, rightHandle + 150, LW - 200]) {
      await mouse('mouseMoved', x, 450, 0, SHIFT);
    }
    await mouse('mouseReleased', LW - 200, 450, 1);
    await checkFor('modifier-drag mirrors from the right handle too',
      pageSnap, (v) => v.ml === '280px' && v.mr === '200px', 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 280/200)`);

    // Plain double-click on a panel's BODY (x=100, well away from the
    // handle at ~280) collapses that side — the whole sidebar is a valid
    // target, which is what makes a lone sidebar collapsible at all.
    await mouse('mousePressed', 100, 450, 1); await mouse('mouseReleased', 100, 450, 1);
    await mouse('mousePressed', 100, 450, 2); await mouse('mouseReleased', 100, 450, 2);
    await checkFor('dblclick on a sidebar\'s body collapses that side',
      pageSnap, (v) => v.ml === '0px' && v.mr === '200px', 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 0/200)`);
    await mouse('mousePressed', 2, 450, 1); await mouse('mouseReleased', 2, 450, 1);
    await mouse('mousePressed', 2, 450, 2); await mouse('mouseReleased', 2, 450, 2);
    await waitFor(async () => (await pageSnap()).ml === '280px', 3000,
      'edge handle restores the collapsed side');

    // Any modifier + double-click on a panel body resets BOTH sides to the
    // defaults (modifier = "both sides", same convention as mirrored drag).
    await mouse('mousePressed', 100, 450, 1, SHIFT); await mouse('mouseReleased', 100, 450, 1, SHIFT);
    await mouse('mousePressed', 100, 450, 2, SHIFT); await mouse('mouseReleased', 100, 450, 2, SHIFT);
    await checkFor('modifier + dblclick on a sidebar restores default widths',
      pageSnap, (v) => v.ml === '200px' && v.mr === '200px', 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 200/200)`);

    // Both sides collapsed -> the page looks un-squeezed and a toggle-off
    // would be invisible; the toolbar click must instead restore this
    // page's defaults (and report on:true, not a toggle to off).
    await mouse('mousePressed', 100, 450, 1); await mouse('mouseReleased', 100, 450, 1);
    await mouse('mousePressed', 100, 450, 2); await mouse('mouseReleased', 100, 450, 2);
    await waitFor(async () => (await pageSnap()).ml === '0px', 3000, 'left collapsed');
    await mouse('mousePressed', LW - 100, 450, 1); await mouse('mouseReleased', LW - 100, 450, 1);
    await mouse('mousePressed', LW - 100, 450, 2); await mouse('mouseReleased', LW - 100, 450, 2);
    await waitFor(async () => {
      const v = await pageSnap();
      return v.ml === '0px' && v.mr === '0px';
    }, 3000, 'both sides collapsed');
    const revive = await toggleViaWorker(`${BASE}/page.html`);
    await checkFor('toolbar click restores defaults when both sides are collapsed',
      pageSnap,
      (v) => revive?.on === true && v.ml === '200px' && v.mr === '200px' && v.host,
      3000, (v) => `on=${revive?.on} ml=${v.ml} mr=${v.mr}`);
    // Put the left side back at 320 for the persistence checks below.
    await mouse('mousePressed', 200, 450, 1);
    for (const x of [220, 280, 320]) await mouse('mouseMoved', x, 450);
    await mouse('mouseReleased', 320, 450, 1);
    await waitFor(async () => {
      const v = await pageSnap();
      return v.ml === '320px' && v.mr === '200px';
    }, 3000, 'plain drag restores 320/200');

    // The worker's LRU pruner evicting THIS page's record is housekeeping,
    // not a decision — and it evicts by last USE, which a tab left open and
    // squeezed stops refreshing. The pillars must not so much as flinch.
    await evalIn(sw, `chrome.storage.local.remove(${JSON.stringify(PAGE_KEY)})`);
    const survivedPrune = await holds(async () => {
      const v = await pageSnap();
      return v.ml === '320px' && v.mr === '200px' && v.host;
    }, 1500, 'pillars survive their record being pruned');
    check('an LRU prune of the active page leaves its pillars and widths alone',
      survivedPrune, JSON.stringify(await pageSnap()));
    // Put the record back for the sections that follow.
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(PAGE_KEY)}:`
      + ' { on: true, left: 320, right: 200, t: Date.now() } })');
    await sleep(200);

    // ---------- page zoom ----------
    // Widths are stored as px at 100% zoom, so the sidebars keep their size
    // on screen when the page is zoomed: at 2x, the 320/200 record must be
    // applied as 160/100 CSS px (and the fixed navbar follow). Zoom is
    // per-origin here (Chrome's default scope), so it must go back to 1
    // before the later sections open more pages on this origin.
    const setZoomViaWorker = (urlPrefix, factor) => viaWorker(urlPrefix,
      `await chrome.tabs.setZoom(tab.id, ${factor}); return true;`);
    const isZoomed = (v) => v.ml === '160px' && v.mr === '100px'
      && v.nav && near(v.nav.left, 160);

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
    await checkFor('2x zoom halves the CSS px widths (constant size on screen)',
      pageSnap, isZoomed, 5000,
      (v) => `ml=${v.ml} mr=${v.mr} navLeft=${v.nav?.left} cw=${v.cw} (expected 160/100)`);
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
    const zoomHint = () => evalIn(sw, `chrome.storage.local.get(${JSON.stringify(ZOOM_KEY)})`);
    await checkFor('per-origin zoom hint persisted while zoomed',
      zoomHint, (h) => h[ZOOM_KEY] === 2, 3000, (h) => JSON.stringify(h));

    // Boot path: a fresh content script on an already-zoomed origin picks
    // the factor up from the hint and auto-restores at exact widths.
    await evalIn(page, 'window.__sqzMark = 1; setTimeout(() => location.reload(), 0); true', false);
    await checkFor('auto-restore on a zoomed page load applies the same on-screen size',
      async () => (await evalIn(page, '!!window.__sqzMark')
        ? { stale: true }
        : pageSnap()),
      (v) => !v.stale && isZoomed(v), 8000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 160/100)`);

    await setZoomViaWorker(`${BASE}/page.html`, 1);
    await checkFor('back at 100% zoom the stored widths apply verbatim',
      pageSnap,
      (v) => v.ml === '320px' && v.mr === '200px' && v.nav && near(v.nav.left, 320),
      5000, (v) => `ml=${v.ml} mr=${v.mr} (expected 320/200)`);
    await checkFor('zoom hint removed when the origin returns to 100%',
      zoomHint, (h) => !(ZOOM_KEY in h), 3000, (h) => JSON.stringify(h));

    // Per-URL memory: a same-document (SPA) navigation to another URL has
    // no record and must close the sidebars; navigating back reopens them
    // with this URL's saved widths.
    await evalIn(page, `history.pushState({}, '', '/spa-elsewhere'); true`);
    await checkFor('SPA pushState to a new URL closes the sidebars',
      pageSnap, (v) => v.ml === '0px' && !v.host, 4000,
      (v) => `ml=${v.ml} host=${v.host}`);
    await evalIn(page, `history.pushState({}, '', '/page.html'); true`);
    await checkFor('SPA pushState back reopens with this URL\'s saved width',
      pageSnap, (v) => v.ml === '320px' && v.host, 4000,
      (v) => `ml=${v.ml} host=${v.host} (expected 320px)`);

    // Toggle off restores everything and persists on:false.
    const off = await toggleViaWorker(`${BASE}/page.html`);
    check('toggle reports on:false', off && off.on === false, JSON.stringify(off));
    await checkFor('toggle off restores page (margins, navbar, host removed)',
      pageSnap, (v) => v.ml === '0px' && !v.host && v.nav && near(v.nav.width, v.cw),
      4000, (v) => `ml=${v.ml} host=${v.host} nav=${JSON.stringify(v.nav)}`);
    const stored = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(PAGE_KEY)})`);
    const rec = stored[PAGE_KEY];
    check('record persisted with on:false and widths kept',
      rec && rec.on === false && rec.left === 320 && rec.right === 200, JSON.stringify(rec));

    // ---------- hostile CSP page ----------
    const csp = await openPage(`${BASE}/csp.html`);
    await sleep(300);
    const cspOn = await toggleViaWorker(`${BASE}/csp.html`);
    check('CSP page toggles on', cspOn && cspOn.on === true, JSON.stringify(cspOn));
    // 200px here also proves per-URL isolation: page.html (same origin) was
    // dragged to 320, but csp.html starts from the defaults.
    const cspState = await checkFor('CSP page: squeeze applied from defaults (record isolated per URL)',
      () => evalIn(csp, `(() => {
        const host = document.querySelector('pillarbox-host');
        if (!host) return { mounted: false };
        return {
          ml: getComputedStyle(document.documentElement).marginLeft,
          bg: getComputedStyle(host.shadowRoot.querySelector('.panel.left')).backgroundColor,
        };
      })()`),
      (v) => v.ml === '200px', 4000);
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
    const ruledSnap = () => evalIn(ruled, SNAP);
    const isRuleWidths = (v) => v.ml === '425px' && v.mr === '425px';
    const showLR = (v) => `ml=${v.ml} mr=${v.mr}`;
    await checkFor('URL rule sets first-enable widths (invalid skipped, first match wins)',
      ruledSnap, isRuleWidths, 4000, showLR);

    // Drag away from the rule widths, then modifier + double-click a panel
    // body: the reset must return to the RULE defaults, not the global 200s.
    await waitFor(() => evalIn(ruled,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot`
      + `.querySelector('.panel.left')).transform === 'none'`), 3000, 'ruled panel settled');
    await mouse('mousePressed', 425, 450, 1, 0, ruled);
    for (const x of [420, 380, 340, 300]) await mouse('mouseMoved', x, 450, 0, 0, ruled);
    await mouse('mouseReleased', 300, 450, 1, 0, ruled);
    await waitFor(async () => (await ruledSnap()).ml === '300px', 3000, 'ruled page dragged to 300');
    await mouse('mousePressed', 100, 450, 1, SHIFT, ruled);
    await mouse('mouseReleased', 100, 450, 1, SHIFT, ruled);
    await mouse('mousePressed', 100, 450, 2, SHIFT, ruled);
    await mouse('mouseReleased', 100, 450, 2, SHIFT, ruled);
    await checkFor('modifier + dblclick reset restores the rule defaults on a matching page',
      ruledSnap, isRuleWidths, 3000, showLR);
    // A rule with a zero side mounts that side collapsed, so the panels never
    // record a width for it. The dblclick that reopens it has to fall back to
    // the user's CONFIGURED default — falling back to the rule would reopen it
    // at 0 and leave the only gesture that can reopen it doing nothing.
    await settingsSet({
      theme: 'light', defaultLeft: 260, defaultRight: 260,
      rules: [{ pattern: 'zeroside=1', left: 0, right: 500 }],
    });
    const zero = await openPage(`${BASE}/page.html?zeroside=1`);
    await sleep(300);
    await toggleViaWorker(`${BASE}/page.html?zeroside=1`);
    await waitFor(async () => {
      const v = await evalIn(zero, SNAP);
      return v.ml === '0px' && v.mr === '500px';
    }, 4000, 'zero-side rule applied on first enable');
    await waitFor(() => evalIn(zero,
      `getComputedStyle(document.querySelector('pillarbox-host').shadowRoot`
      + `.querySelector('.panel.right')).transform === 'none'`), 3000, 'zero-side panels settled');
    // Double-click the sliver at the left screen edge — at width 0 the handle
    // straddling the edge is the whole hit area.
    await mouse('mousePressed', 2, 450, 1, 0, zero); await mouse('mouseReleased', 2, 450, 1, 0, zero);
    await mouse('mousePressed', 2, 450, 2, 0, zero); await mouse('mouseReleased', 2, 450, 2, 0, zero);
    await checkFor('a side collapsed since mount reopens at the configured default width',
      () => evalIn(zero, SNAP), (v) => v.ml === '260px', 3000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 260px)`);

    // Substring mode compares the pattern literally, so a URL pasted straight
    // out of the address bar works unescaped. This exact text as a REGEX would
    // not match: the ? would make the preceding l optional and the literal ?
    // in the URL is never matched.
    await settingsSet({
      theme: 'light', defaultLeft: 200, defaultRight: 200,
      rules: [{ pattern: 'page.html?ruled=2', mode: 'substring', left: 360, right: 120 }],
    });
    const sub = await openPage(`${BASE}/page.html?ruled=2`);
    await sleep(300);
    await toggleViaWorker(`${BASE}/page.html?ruled=2`);
    await checkFor('substring rule matches a URL containing regex metacharacters',
      () => evalIn(sub, SNAP), (v) => v.ml === '360px' && v.mr === '120px', 4000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 360/120)`);

    // NEW PAGE BEHAVIOR: a rule carrying autoShow opens a page that has no
    // record of its own — no toggle, no click — at that same rule's widths.
    await settingsSet({
      theme: 'light', defaultLeft: 200, defaultRight: 200,
      rules: [
        { pattern: 'autoshow=1', autoShow: true, left: 320, right: 140 },
        { pattern: 'autoshow=2', autoShow: true, left: 180, right: 60 },
      ],
    });
    const auto = await openPage(`${BASE}/page.html?autoshow=1`);
    await checkFor('SHOW PILLARS opens a new page by itself, at the rule widths',
      () => evalIn(auto, SNAP),
      (v) => v.ml === '320px' && v.mr === '140px' && v.host, 4000,
      (v) => `ml=${v.ml} mr=${v.mr} host=${v.host} (expected 320/140)`);

    // The same question is re-asked on an in-page navigation: arriving at a
    // second matching URL adopts THAT rule's widths without a reload. (The
    // do-nothing half of this — SPA nav to a recordless URL closing the
    // sidebars — is covered by the per-URL memory section above.)
    await evalIn(auto, `history.pushState({}, '', '/page.html?autoshow=2'); true`);
    await checkFor('SPA nav to another SHOW PILLARS URL adopts that rule\'s widths',
      () => evalIn(auto, SNAP),
      (v) => v.ml === '180px' && v.mr === '60px' && v.host, 4000,
      (v) => `ml=${v.ml} mr=${v.mr} (expected 180/60)`);
    await evalIn(auto, `history.pushState({}, '', '/page.html?autoshow=1'); true`);
    await waitFor(async () => (await evalIn(auto, SNAP)).ml === '320px',
      4000, 'SPA nav back to the first autoShow rule');

    // ...and writes nothing. The rule re-decides on every load, so merely
    // visiting a matching page must not mint a record and spend LRU budget.
    const autoKey = `page:${BASE}/page.html?autoshow=1`;
    const autoStored = await evalIn(sw,
      `chrome.storage.local.get(${JSON.stringify(autoKey)})`);
    check('SHOW PILLARS leaves no page record behind',
      Object.keys(autoStored).length === 0, JSON.stringify(autoStored));

    // Turning it off is a decision about THIS page, and it outranks the rule
    // — on this load and on every later one.
    const autoOff = await toggleViaWorker(`${BASE}/page.html?autoshow=1`);
    check('a SHOW PILLARS page can still be toggled off',
      autoOff && autoOff.on === false, JSON.stringify(autoOff));
    await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.local.get(${JSON.stringify(autoKey)})`);
      return st[autoKey]?.on === false;
    }, 3000, 'explicit off recorded');
    const autoAgain = await openPage(`${BASE}/page.html?autoshow=1`);
    // Held over a window rather than sampled once: a single delayed snapshot
    // passes just as happily when the rule DOES open the page a moment later.
    let reSnap = null;
    const heldOff = await holds(async () => {
      reSnap = await evalIn(autoAgain, SNAP);
      return reSnap.ml === '0px' && !reSnap.host;
    }, 2000, 'the explicit off keeps holding');
    check('an explicit off beats the rule on the next load', heldOff, JSON.stringify(reSnap));

    // Clear the rules so later sections see the plain global defaults.
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });

    // ---------- options page ----------
    const opts = await openPage(`chrome-extension://${extId}/options/options.html`);
    await sleep(400);
    // The page dogfoods the real content scripts (seeded 400/400 on first
    // visit). This doubles as the load-order canary: a content-script file
    // that throws on an extension page (e.g. a missing shared dependency in
    // the <script> list) leaves the pillars unmounted here.
    await checkFor('options: page runs its own live pillars (content scripts healthy)',
      () => evalIn(opts, `({
        ml: getComputedStyle(document.documentElement).marginLeft,
        host: !!document.querySelector('pillarbox-host'),
      })`),
      (v) => v.ml === '400px' && v.host === true, 4000);
    // The other half of that script-list contract: match-media.js must NOT be
    // loaded here. An extension page has no isolated/main world split, so its
    // width lie would feed straight back into the extension's own clamp math.
    // With 400/400 pillars up, a lie would show as a layout width ~800 short.
    const optMetrics = await evalIn(opts, `({
      iw: innerWidth,
      cw: document.documentElement.clientWidth,
      wrapped: window.matchMedia.toString().includes('[native code]'),
    })`);
    check('options: width metrics honest and matchMedia unwrapped (no MAIN-world hook here)',
      optMetrics.iw > 1000 && optMetrics.cw > 1000 && optMetrics.wrapped === true,
      JSON.stringify(optMetrics));
    const optState = await evalIn(opts, `({
      theme: document.querySelector('input[name="theme"]:checked')?.value,
      left: document.getElementById('defaultLeft').value,
      right: document.getElementById('defaultRight').value,
      readout: document.getElementById('showReadout').checked,
      colorLight: document.getElementById('colorLight').value,
      colorDark: document.getElementById('colorDark').value,
      pageTheme: document.documentElement.dataset.theme,
      ruleRows: document.querySelectorAll('#rules .rule').length,
      rule0: document.querySelector('.rule-pattern')?.value,
      rule0Left: document.querySelector('.rule-left')?.value,
      rule0Right: document.querySelector('.rule-right')?.value,
      behaviors: [...document.querySelectorAll('#rules .rule-show')].map((b) => b.textContent),
    })`);
    check('options: current settings rendered (readout defaults off)',
      optState.theme === 'light' && optState.left === '200'
        && optState.readout === false && optState.colorLight === '#eef0f3'
        && optState.colorDark === '#1d2126' && optState.pageTheme === 'light',
      JSON.stringify(optState));
    // Storage holds no `rules` key at this point, so the SHIPPED defaults
    // must be showing: nature.com/articles 535x0 first, then zhihu, youtube.
    // Only zhihu ships opening by itself — that mix is a product decision,
    // so pin it rather than let a stray edit to the defaults slip through.
    check('options: shipped default rules rendered (nature 535x0, zhihu, youtube)',
      optState.ruleRows === 3 && optState.rule0 === 'https://www\\.nature\\.com/articles'
        && optState.rule0Left === '535' && optState.rule0Right === '0',
      JSON.stringify({ rows: optState.ruleRows, rule0: optState.rule0 }));
    check('options: only the shipped zhihu rule defaults to SHOW PILLARS',
      JSON.stringify(optState.behaviors)
        === JSON.stringify(['DO NOTHING', 'SHOW PILLARS', 'DO NOTHING']),
      JSON.stringify(optState.behaviors));

    // Clicking the dark radio saves immediately and re-themes the page.
    await evalIn(opts, `document.querySelector('input[name="theme"][value="dark"]').click(); true`);
    await checkFor('options: theme change saves and re-themes the page',
      async () => ({
        stored: (await evalIn(sw, `chrome.storage.sync.get('settings')`)).settings?.theme,
        page: await evalIn(opts, `document.documentElement.dataset.theme`),
      }),
      (v) => v.stored === 'dark' && v.page === 'dark', 3000);

    // The dark theme inverts the whole poster (ink/paper swap), and the
    // tint hex readouts follow the stored colors.
    await waitFor(async () => (await evalIn(opts,
      `getComputedStyle(document.body).backgroundColor`)) === 'rgb(0, 0, 0)',
      3000, 'poster inverted by the dark theme');
    check('options: dark theme inverts the poster; tint readouts follow',
      (await evalIn(opts, `document.getElementById('colorDarkHex').textContent`)) === '#1d2126');

    // The gesture ledger renders, with this platform's modifier run filled in.
    const gestures = await evalIn(opts, `({
      rows: [...document.querySelectorAll('.gesture')].length,
      modRun: document.querySelector('.modkeys')?.textContent ?? '',
    })`);
    check('options: gesture ledger rendered with platform modifiers',
      gestures.rows === 6 && /^(⇧\/⌃\/⌥\/⌘|SHIFT\/CTRL\/ALT)$/.test(gestures.modRun),
      JSON.stringify(gestures));

    // Rules editor: remote rules render as rows; adding and removing rows
    // saves through the same save-on-change path as every other field.
    await settingsSet({
      theme: 'dark', defaultLeft: 200, defaultRight: 200,
      rules: [{ pattern: 'example\\.com/articles', left: 530, right: 0 }],
    });
    await waitFor(async () => (await evalIn(opts,
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
    await checkFor('options: adding a rule saves it',
      () => evalIn(sw, `chrome.storage.sync.get('settings')`),
      (st) => st.settings?.rules?.length === 2
        && st.settings.rules[1].pattern === 'zhihu\\.com/question'
        && st.settings.rules[1].left === 425,
      3000, (st) => JSON.stringify(st.settings?.rules ?? null));

    // MATCH BY toggles between regex and substring, saves like every other
    // edit, and re-labels itself. New rows start on regex.
    const modeState = await evalIn(opts, `(() => {
      const rows = [...document.querySelectorAll('#rules .rule')];
      const before = rows.map((r) => r.querySelector('.rule-mode').dataset.mode);
      rows[0].querySelector('.rule-mode').click();
      const btn = rows[0].querySelector('.rule-mode');
      return { before, after: btn.dataset.mode, label: btn.textContent,
        placeholder: rows[0].querySelector('.rule-pattern').placeholder };
    })()`);
    const modeSaved = await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.[0]?.mode === 'substring'
        && st.settings.rules[1].mode === 'regex';
    }, 3000, 'mode toggle saved');
    check('options: MATCH BY toggles to substring and saves (new rows are regex)',
      modeSaved && modeState.before.every((m) => m === 'regex')
        && modeState.after === 'substring'
        && modeState.label === 'SUBSTRING'
        && !modeState.placeholder.includes('\\'),
      JSON.stringify({ saved: modeSaved, ...modeState }));
    // Put it back so the reorder/remove checks below see what they expect.
    await evalIn(opts, `(document.querySelector('.rule-mode').click(), true)`);
    await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.[0]?.mode === 'regex';
    }, 3000, 'mode toggled back');

    // NEW PAGE BEHAVIOR is the same kind of self-labelling toggle, and rules
    // that predate it (neither row was saved with autoShow) must read as
    // DO NOTHING rather than as anything sticky.
    const showState = await evalIn(opts, `(() => {
      const rows = [...document.querySelectorAll('#rules .rule')];
      const before = rows.map((r) => r.querySelector('.rule-show').textContent);
      rows[0].querySelector('.rule-show').click();
      const btn = rows[0].querySelector('.rule-show');
      return { before, after: btn.textContent, flag: btn.dataset.autoShow };
    })()`);
    const showSaved = await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.[0]?.autoShow === true
        && st.settings.rules[1].autoShow === false;
    }, 3000, 'new-page behavior saved');
    check('options: NEW PAGE BEHAVIOR toggles to SHOW PILLARS and saves '
      + '(rules without the flag read as DO NOTHING)',
      showSaved && showState.before.every((t) => t === 'DO NOTHING')
        && showState.after === 'SHOW PILLARS' && showState.flag === 'true',
      JSON.stringify({ saved: showSaved, ...showState }));
    // Back to DO NOTHING: the rows below are asserted on by pattern, not by
    // behaviour, but leaving a live autoShow rule in sync storage would open
    // pillars uninvited on the pages the later sections load.
    await evalIn(opts, `(document.querySelector('.rule-show').click(), true)`);
    await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.[0]?.autoShow === false;
    }, 3000, 'new-page behavior toggled back');

    // First match wins, so order is data: moving the second rule up must
    // persist the swapped order (and the edge buttons stay disabled).
    const moveState = await evalIn(opts, `(() => {
      document.querySelectorAll('.rule-up')[1].click();
      const rows = document.querySelectorAll('#rules .rule');
      return {
        first: rows[0].querySelector('.rule-pattern').value,
        upDisabled: rows[0].querySelector('.rule-up').disabled,
        downDisabled: rows[rows.length - 1].querySelector('.rule-down').disabled,
      };
    })()`);
    const reorderSaved = await waitFor(async () => {
      const st = await evalIn(sw, `chrome.storage.sync.get('settings')`);
      return st.settings?.rules?.[0]?.pattern === 'zhihu\\.com/question';
    }, 3000, 'reorder saved');
    check('options: moving a rule up saves the new order (edge buttons disabled)',
      reorderSaved && moveState.first === 'zhihu\\.com/question'
        && moveState.upDisabled === true && moveState.downDisabled === true,
      JSON.stringify({ saved: reorderSaved, ...moveState }));
    await evalIn(opts, `(document.querySelectorAll('.rule-remove')[1].click(), true)`);
    await checkFor('options: removing a rule saves',
      () => evalIn(sw, `chrome.storage.sync.get('settings')`),
      (st) => st.settings?.rules?.length === 1,
      3000, (st) => JSON.stringify(st.settings?.rules ?? null));

    // Feedback card: the button opens the issue tracker in a new tab.
    await evalIn(opts, `(document.getElementById('openIssue').click(), true)`);
    await checkFor('options: feedback button opens the issue tracker',
      () => evalIn(sw, `chrome.tabs.query({})`),
      (tabs) => tabs.some((t) => ((t.pendingUrl || t.url) ?? '')
        .startsWith('https://github.com/MarksonChen/pillarbox/issues/new')),
      3000, (tabs) => JSON.stringify(tabs.map?.((t) => t.pendingUrl || t.url) ?? tabs));

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
    await checkFor('options: identical save does not swallow the next remote change',
      () => evalIn(opts, `document.getElementById('defaultLeft').value`),
      (v) => v === '333', 3000, (v) => `defaultLeft field reads ${v}, expected 333`);
    await settingsSet({ theme: 'dark', defaultLeft: 200, defaultRight: 200 });
    await waitFor(async () => (await evalIn(opts,
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
    await checkFor('memory silently capped at the 1000 most recent pages (real records kept)',
      async () => {
        const all = await evalIn(sw, `chrome.storage.local.get(null)`);
        return Object.keys(all).filter((k) => k.startsWith('page:'));
      },
      (pages) => pages.length === 1000
        && !pages.includes('page:http://fake.test/1')
        && pages.includes(PAGE_KEY),
      12000, (pages) => `${pages.length} page records, oldest fake kept: `
        + `${pages.includes?.('page:http://fake.test/1')}`);
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
    const shellSq = await checkFor('absolute inset-0 app shell is squeezed',
      () => evalIn(shellPage, SHELL_SNAP),
      (v) => near(v.left, 200) && v.frameW <= shellBase.frameW - 380, 5000);
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
    await checkFor('absolute shell released when an ancestor becomes its containing block',
      () => evalIn(shellPage, `(() => {
        const el = document.getElementById('shell');
        return {
          inlineLeft: el.style.left,
          marker: el.style.getPropertyValue('--pillarbox'),
          left: el.getBoundingClientRect().left,
        };
      })()`),
      (v) => v.inlineLeft === '' && v.marker === '' && near(v.left, 200), 4000);

    await toggleViaWorker(`${BASE}/appshell.html`);
    await checkFor('app shell fully restored on toggle off',
      () => evalIn(shellPage, SHELL_SNAP),
      (v) => v.ml === '0px' && v.left === 0 && near(v.frameW, shellBase.frameW), 4000);

    // ---------- viewport-unit shells (chatgpt/notion/reddit patterns) ----------
    const VW_SNAP = `(() => {
      // Same lie-immune layout width as SNAP.cw (see there).
      const decs = getComputedStyle(document.documentElement);
      const cw = Math.round(document.documentElement.getBoundingClientRect().width
        + parseFloat(decs.marginLeft) + parseFloat(decs.marginRight));
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
    const vs = await checkFor('width:100vw shells adopted (stylesheet + nested inline)',
      () => evalIn(vwPage, VW_SNAP),
      (v) => v.ml === '200px' && v.shell.left === 200 && v.shell.right === v.cw - 200
        && v.breakout.left === 200 && v.inner.left === 200 && v.inner.right === v.cw - 200,
      5000, (v) => JSON.stringify({ ml: v.ml, shell: v.shell, inner: v.inner }));
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
    await waitFor(async () => (await evalIn(vwPage, VW_SNAP)).ml === '0px', 4000, 'vw shells restored');
    const vwRestored = await evalIn(vwPage, `({
      shellW: document.getElementById('vwshell').style.width,
      innerW: document.getElementById('inner100vw').style.width,
      brkStyle: document.getElementById('breakout').getAttribute('style') ?? '',
    })`);
    check('flow adoptions fully restored (inline width:100vw prior kept)',
      vwRestored.shellW === '' && vwRestored.innerW === '100vw'
        && !vwRestored.brkStyle.includes('margin'),
      JSON.stringify(vwRestored));

    // ---------- breakpoint shifting (media queries see the squeezed width) ----------
    const MQ_URL = `${BASE}/mq.html`;
    const MQ_KEY = `page:${MQ_URL}`;
    // 1440 - (300 + 300) = 840px effective, crossing the page's 1000px
    // breakpoints. (The settings sections above left 200/200 saved.)
    await settingsSet({ theme: 'light', defaultLeft: 300, defaultRight: 300 });
    const MQ_SNAP = `(() => {
      const c = (id) => getComputedStyle(document.getElementById(id)).color;
      const link = document.getElementById('crossLink');
      const main = document.getElementById('mainCss').sheet;
      let firstMedia = null;
      for (const r of main.cssRules) {
        if (r.media) { firstMedia = r.media.mediaText; break; }
      }
      return {
        ml: getComputedStyle(document.documentElement).marginLeft,
        ih: innerHeight,
        brk: c('brk'), desk: c('desk'), nest: c('nest'), em: c('em'),
        ori: c('ori'), late: c('late'), whole: c('whole'),
        x: c('x'), imp: c('imp'), xover: c('xover'),
        bg: getComputedStyle(document.getElementById('bgprobe')).backgroundImage,
        ord: c('ord'), lay: c('lay'),
        wholeAttr: document.getElementById('wholeLink').getAttribute('media'),
        clones: document.querySelectorAll('style[data-pillarbox-mq]').length,
        crossDisabled: !!(link.sheet && link.sheet.disabled),
        firstMedia,
        // Page-world width metrics: the MAIN-world hook shifts these while
        // squeezed (innerWidth and the documentElement clientWidth, equally).
        iw: innerWidth,
        cwLied: document.documentElement.clientWidth,
        // The JS-breakpoint harness (page-held matchMedia lists, see mq.html)
        // plus a list minted fresh THIS poll — both must track the squeeze.
        mm: (() => {
          const m = window.__mm;
          return {
            q: m.q.matches,
            media: m.q.media,
            ori: m.ori.matches,
            dark: m.dark.media,
            count: m.events.length,
            kinds: [...new Set(m.events.map((e) => e[0]))].sort().join(','),
            last: m.events.length ? m.events[m.events.length - 1] : null,
            fresh: matchMedia('(min-width: 1016px)').matches,
            rz: m.rz,
          };
        })(),
      };
    })()`;
    const mqPage = await openPage(MQ_URL);
    await sleep(300);
    const mqSnap = () => evalIn(mqPage, MQ_SNAP);
    let mq = await checkFor('mq baseline: no breakpoint active at 1440px',
      mqSnap,
      (v) => v.x === 'rgb(10, 10, 10)' // cross sheet loaded
        && v.brk === 'rgb(10, 10, 10)' && v.desk === 'rgb(30, 30, 30)'
        && v.nest === 'rgb(10, 10, 10)' && v.em === 'rgb(10, 10, 10)'
        && v.ori === 'rgb(10, 10, 10)' && v.whole === 'rgb(0, 0, 0)'
        && v.imp === 'rgb(0, 0, 0)' && v.clones === 0,
      5000);
    check('mq baseline: page-held matchMedia lists native, no events, no resize pokes',
      mq.mm?.q === true && mq.mm?.count === 0 && mq.mm?.rz === 0
        && mq.mm?.dark === '(prefers-color-scheme: dark)',
      JSON.stringify(mq.mm));
    // Native width metrics before any squeeze, for the lie deltas below.
    const MQIW = mq.iw;
    const MQCW = mq.cwLied;

    const mqOn = await toggleViaWorker(MQ_URL);
    check('mq page toggles on', mqOn && mqOn.on === true, JSON.stringify(mqOn));
    mq = await checkFor(
      'inline breakpoints see the squeezed width (max off-on, min on-off, range, em, nested)',
      mqSnap,
      (v) => v.brk === 'rgb(20, 20, 20)' && v.x === 'rgb(60, 60, 60)'
        && v.desk === 'rgb(10, 10, 10)' && v.nest === 'rgb(40, 40, 40)'
        && v.em === 'rgb(45, 45, 45)',
      8000);
    // Portrait means height >= width, and the headless window loses some
    // height to browser chrome — derive the expectation from the live
    // innerHeight rather than assuming the 900px window survives intact.
    check('orientation follows the 840px effective width',
      (mq.ori === 'rgb(50, 50, 50)') === (mq.ih >= 840),
      JSON.stringify({ ori: mq.ori, ih: mq.ih }));

    // The JS side of the same squeeze: page-held matchMedia lists (minted at
    // load, before any squeeze — the YouTube situation) must read the
    // effective 840px, keep their original media text, and have heard about
    // the flip through every listener API. Lists minted while squeezed
    // (`fresh`) are born already lying.
    mq = await checkFor(
      'matchMedia: page-held and fresh lists read the effective width, media text intact',
      mqSnap,
      (v) => v.mm.q === false && v.mm.count >= 3 && v.mm.fresh === false
        && v.mm.media === '(min-width: 1016px)',
      8000, (v) => JSON.stringify(v.mm));
    check('matchMedia: flip delivered via addListener, onchange and addEventListener (untrusted)',
      mq.mm?.kinds === 'ael,legacy,onchange'
        && mq.mm?.last && mq.mm.last[1] === false && mq.mm.last[2] === false,
      JSON.stringify(mq.mm));
    check('shift change pokes a synthetic window resize (JS-measured layouts recompute)',
      mq.mm?.rz >= 1, `rz=${mq.mm?.rz}`);
    check('page-world width metrics lie by the shift (innerWidth and root clientWidth)',
      mq.iw === MQIW - 600 && mq.cwLied === MQCW - 600,
      JSON.stringify({ iw: mq.iw, cw: mq.cwLied, baseIw: MQIW, baseCw: MQCW }));

    // 400+400 leaves 640px — portrait for any usable window height. This is
    // the branch the user-visible "sites switch to their portrait layout"
    // report is about.
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(MQ_KEY)}:`
      + ' { on: true, left: 400, right: 400, t: Date.now() } })');
    mq = await checkFor('orientation reads portrait once the squeeze makes height the long side',
      mqSnap,
      (v) => v.ml === '400px' && (v.ori === 'rgb(50, 50, 50)') === (v.ih >= 640)
        && v.brk === 'rgb(20, 20, 20)',
      8000, (v) => JSON.stringify({ ml: v.ml, ori: v.ori, ih: v.ih, brk: v.brk }));
    check('matchMedia orientation tracks the effective viewport too',
      mq.mm?.ori === (mq.ih < 640),
      JSON.stringify({ mmOri: mq.mm?.ori, ih: mq.ih }));
    check('whole-sheet <link media> gate re-evaluates; the attribute is untouched',
      mq.whole === 'rgb(80, 80, 80)' && mq.wholeAttr === '(max-width: 1000px)',
      JSON.stringify({ whole: mq.whole, attr: mq.wholeAttr }));
    check('cross-origin sheet cloned (worker fetch, @import inlined, original disabled)',
      mq.imp === 'rgb(70, 70, 70)' && mq.clones === 4 && mq.crossDisabled,
      JSON.stringify({ imp: mq.imp, clones: mq.clones, disabled: mq.crossDisabled }));
    // Two cross-origin imports of one readable sheet share an anchor, and the
    // first is served 500ms slower. Clones placed when their bytes land would
    // sit in completion order and invert the cascade between them.
    check('sibling cross-origin imports keep document order, not fetch order',
      mq.ord === 'rgb(2, 2, 2)', `${mq.ord} (rgb(1, 1, 1) = the slow import landed last and won)`);
    // A clone that dropped the import's layer() would be unlayered — and
    // unlayered beats layered, so it would take over from the earlier rule.
    check('layered cross-origin import stays inside its cascade layer',
      mq.lay === 'rgb(120, 120, 120)',
      `${mq.lay} (rgb(130, 130, 130) = the clone escaped its layer)`);
    check('clone keeps cascade order (later same-origin sheet still wins)',
      mq.xover === 'rgb(200, 100, 0)', mq.xover);
    check('clone url()s absolutized against the sheet origin',
      String(mq.bg).includes(':8124/px.gif'), mq.bg);

    // shiftText unit battery, in the content-script world.
    const B = await evalIn(sw, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(MQ_URL)}));
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const t = (txt) => SQZ.mediaQueries.shiftText(txt, 600);
          return {
            classic: t('(max-width: 700px)'),
            em: t('(min-width: 40em)'),
            pair: t('screen and (min-width: 900px) and (max-width: 1600px)'),
            rangeFwd: t('(width <= 700px)'),
            rangeChain: t('(400px < width < 900px)'),
            calc: t('(min-width: calc(100px + 10em))'),
            zero: t('(max-width: 0)'),
            device: t('(max-device-width: 700px)'),
            height: t('(min-height: 500px)'),
            negated: t('not (max-width: 700px)'),
            list: t('print, (max-width: 700px)'),
            res: t('(min-resolution: 2dppx)'),
            boolWidth: t('(width)'),
          };
        },
      });
      return result;
    })()`);
    check('shiftText: width features shifted by S, everything else untouched',
      B.classic === '(max-width: calc(700px + 600px))'
        && B.em === '(min-width: calc(40em + 600px))'
        && B.pair === 'screen and (min-width: calc(900px + 600px)) and (max-width: calc(1600px + 600px))'
        && B.rangeFwd === '(width <= calc(700px + 600px))'
        && B.rangeChain === '(calc(400px + 600px) < width < calc(900px + 600px))'
        && B.calc === '(min-width: calc(calc(100px + 10em) + 600px))'
        && B.zero === '(max-width: calc(0px + 600px))'
        && B.device === '(max-device-width: 700px)'
        && B.height === '(min-height: 500px)'
        && B.negated === 'not (max-width: calc(700px + 600px))'
        && B.list === 'print, (max-width: calc(700px + 600px))'
        && B.res === '(min-resolution: 2dppx)'
        && B.boolWidth === '(width)',
      JSON.stringify(B));

    // A breakpoint the page adds via insertRule mutates no DOM node; only
    // the rescan interval can find it.
    await evalIn(mqPage, `(() => {
      const sheet = document.getElementById('mainCss').sheet;
      sheet.insertRule('@media (max-width: 1000px) { #late { color: rgb(90, 90, 90) } }',
        sheet.cssRules.length);
      return true;
    })()`);
    await checkFor('a rule added via insertRule (no DOM mutation) is shifted',
      mqSnap, (v) => v.late === 'rgb(90, 90, 90)', 8000,
      (v) => `#late is ${v.late}, expected rgb(90, 90, 90)`);

    // Width changes re-derive every shift from the saved original text —
    // a double shift would leave brk stuck on.
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(MQ_KEY)}:`
      + ' { on: true, left: 50, right: 50, t: Date.now() } })');
    mq = await checkFor(
      'width changes re-shift from originals (desktop rule back, clone follows, orientation back)',
      mqSnap,
      (v) => v.ml === '50px' && v.brk === 'rgb(10, 10, 10)' && v.x === 'rgb(10, 10, 10)'
        && v.desk === 'rgb(30, 30, 30)' && v.ori === 'rgb(10, 10, 10)'
        && v.imp === 'rgb(0, 0, 0)' && v.late === 'rgb(10, 10, 10)',
      8000);
    check('matchMedia lists flip back once the shift narrows (1340px effective)',
      mq.mm?.q === true && mq.mm?.last && mq.mm.last[1] === true,
      JSON.stringify(mq.mm));
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(MQ_KEY)}:`
      + ' { on: true, left: 300, right: 300, t: Date.now() } })');
    await checkFor('breakpoints follow width changes both ways',
      mqSnap, (v) => v.brk === 'rgb(20, 20, 20)', 8000,
      (v) => `#brk is ${v.brk}, expected rgb(20, 20, 20)`);

    // The poke stream does not stop at the first event. For a window after
    // every shift change the hook re-checks a geometry fingerprint and pokes
    // again whenever the page moved since its last look — which is what a
    // site that relayouts from a late, low-priority job (YouTube's player)
    // needs. A regression back to a single poke still satisfies rz >= 1.
    const rzBefore = (await mqSnap()).mm.rz;
    await evalIn(mqPage, `(document.body.append(Object.assign(
      document.createElement('div'),
      { id: 'pokeFiller', style: 'height:3000px' })), true)`);
    await checkFor('the resize poke keeps following the page until it settles',
      mqSnap, (v) => v.mm.rz > rzBefore, 5000,
      (v) => `resize count ${v.mm?.rz}, was ${rzBefore} before the geometry change`);
    await evalIn(mqPage, `(document.getElementById('pokeFiller').remove(), true)`);

    // The jsBreakpoints kill switch, flipped live on an active page: the JS
    // side must go back to native answers while the CSS shift stays put —
    // that split is the whole point of the escape hatch.
    await settingsSet({
      theme: 'light', defaultLeft: 300, defaultRight: 300, jsBreakpoints: false,
    });
    mq = await checkFor('jsBreakpoints off un-lies matchMedia live; CSS shift untouched',
      mqSnap,
      (v) => v.mm.q === true && v.mm.fresh === true && v.brk === 'rgb(20, 20, 20)',
      8000, (v) => JSON.stringify({ mm: v.mm?.q, brk: v.brk }));
    check('jsBreakpoints off un-lies the width metrics too',
      mq.iw === MQIW && mq.cwLied === MQCW,
      JSON.stringify({ iw: mq.iw, cw: mq.cwLied }));
    await settingsSet({ theme: 'light', defaultLeft: 300, defaultRight: 300 });
    await checkFor('jsBreakpoints back on re-shifts matchMedia live',
      mqSnap, (v) => v.mm.q === false && v.mm.fresh === false, 8000,
      (v) => JSON.stringify(v.mm));

    await toggleViaWorker(MQ_URL);
    mq = await checkFor(
      'toggle off: mediaTexts restored verbatim, clones gone, original sheet re-enabled',
      mqSnap,
      (v) => v.ml === '0px' && v.brk === 'rgb(10, 10, 10)' && v.x === 'rgb(10, 10, 10)'
        && v.firstMedia === '(max-width: 1000px)' && v.clones === 0 && !v.crossDisabled
        && v.desk === 'rgb(30, 30, 30)' && v.imp === 'rgb(0, 0, 0)',
      8000);
    check('toggle off: matchMedia fully native again (page-held and fresh lists)',
      mq.mm?.q === true && mq.mm?.fresh === true && mq.mm?.last && mq.mm.last[1] === true,
      JSON.stringify(mq.mm));
    check('toggle off: width metrics native again',
      mq.iw === MQIW && mq.cwLied === MQCW,
      JSON.stringify({ iw: mq.iw, cw: mq.cwLied }));

    // ---------- quirks mode ----------
    // WHICH element's clientWidth means "the viewport" is mode-dependent. In
    // quirks the root reports its own padding box — already narrowed by the
    // squeeze margins — so subtracting the shift there as well would lie
    // twice; <body> is the viewport metric in that mode and is the one that
    // has to move. Every assertion is against that metric's own baseline, so
    // scrollbar differences cancel.
    const QUIRKS_URL = `${BASE}/quirks.html`;
    const QUIRKS_KEY = `page:${QUIRKS_URL}`;
    const QSNAP = `({
      mode: document.compatMode,
      iw: innerWidth,
      de: document.documentElement.clientWidth,
      body: document.body.clientWidth,
      ml: getComputedStyle(document.documentElement).marginLeft,
    })`;
    const quirks = await openPage(QUIRKS_URL);
    await sleep(300);
    const qBase = await evalIn(quirks, QSNAP);
    check('quirks fixture is really in quirks mode', qBase.mode === 'BackCompat', qBase.mode);
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(QUIRKS_KEY)}:`
      + ' { on: true, left: 200, right: 200, t: Date.now() } })');
    const qOn = await checkFor('quirks: innerWidth and body.clientWidth lie once each',
      () => evalIn(quirks, QSNAP),
      (v) => v.ml === '200px' && v.iw === qBase.iw - 400 && v.body === qBase.body - 400,
      6000, (v) => JSON.stringify({ base: qBase, on: v }));
    check('quirks: the root keeps its native (already narrowed) clientWidth — no double shift',
      qOn.de === qBase.de - 400,
      `de ${qBase.de} -> ${qOn.de} (${qBase.de - 800} would be the double subtraction)`);

    // ---------- print suspend / resume ----------
    // beforeprint tears four modules down in a load-bearing order and
    // afterprint rebuilds them, re-reading a record that may have moved in
    // between. Nothing else in the suite touches that path.
    const PRINT_URL = `${BASE}/page.html?print=1`;
    const PRINT_KEY = `page:${PRINT_URL}`;
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(PRINT_KEY)}:`
      + ' { on: true, left: 260, right: 140, t: Date.now() } })');
    const pr = await openPage(PRINT_URL);
    await waitFor(async () => (await evalIn(pr, SNAP)).ml === '260px', 6000, 'print page squeezed');
    await evalIn(pr, `(dispatchEvent(new Event('beforeprint')), true)`);
    // `honest` is the layout width derived from the html box + margins, the one
    // width on the page the MAIN-world lie cannot touch. Comparing innerWidth
    // against it — and asking a query the 400px shift would actually flip — is
    // what makes this a real check that the JS side went native, rather than
    // one a stale lie would also satisfy.
    await checkFor('beforeprint un-squeezes everything: margins, bars, panels hidden, JS side native',
      () => evalIn(pr, `(() => {
        const de = document.documentElement;
        const cs = getComputedStyle(de);
        return {
          ml: cs.marginLeft,
          honest: Math.round(de.getBoundingClientRect().width
            + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight)),
          navLeft: document.getElementById('navbar').getBoundingClientRect().left,
          hostDisplay: document.querySelector('pillarbox-host')?.style.display ?? 'gone',
          mm: matchMedia('(min-width: 1200px)').matches,
          iw: innerWidth,
        };
      })()`),
      (v) => v.ml === '0px' && v.navLeft === 0 && v.hostDisplay === 'none'
        && v.mm === true && v.iw >= v.honest - 40,
      5000);
    // The record can move while width application is suspended; the resume
    // has to pick that up rather than replay what it tore down.
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(PRINT_KEY)}:`
      + ' { on: true, left: 180, right: 100, t: Date.now() } })');
    await sleep(300);
    await evalIn(pr, `(dispatchEvent(new Event('afterprint')), true)`);
    await checkFor('afterprint restores the squeeze at the record written while suspended',
      () => evalIn(pr, SNAP),
      (v) => v.ml === '180px' && v.mr === '100px' && v.host && v.nav && near(v.nav.left, 180),
      6000, (v) => JSON.stringify({ ml: v.ml, mr: v.mr, nav: v.nav }));

    // ---------- back/forward return ----------
    // The one path that re-keys KEY, re-confirms the zoom and re-reads the
    // record AND the settings together, because all three can move while the
    // page sits frozen. Whether Chrome really bfcaches here (an attached
    // debugger can prevent it) is reported rather than assumed — the record
    // must be honoured on the way back either way.
    const BF_URL = `${BASE}/page.html?bf=1`;
    const BF_KEY = `page:${BF_URL}`;
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(BF_KEY)}:`
      + ' { on: true, left: 240, right: 160, t: Date.now() } })');
    const bf = await openPage(BF_URL);
    await waitFor(async () => (await evalIn(bf, SNAP)).ml === '240px', 6000, 'bf page squeezed');
    await evalIn(bf, `(window.__bfMark = 1, addEventListener('pageshow',
      (e) => { window.__bfPersisted = e.persisted; }), true)`);
    await evalIn(bf, `location.href = ${JSON.stringify(`${BASE}/csp.html`)}`, false);
    await waitFor(() => evalIn(bf, `location.pathname === '/csp.html'`), 8000, 'navigated away');
    await evalIn(sw, `chrome.storage.local.set({ ${JSON.stringify(BF_KEY)}:`
      + ' { on: true, left: 360, right: 60, t: Date.now() } })');
    await evalIn(bf, `(history.back(), true)`, false);
    await checkFor('back-navigation returns to the record written while the page was away',
      async () => ({
        ...await evalIn(bf, SNAP),
        persisted: await evalIn(bf, `!!window.__bfPersisted`),
      }),
      (v) => v.ml === '360px' && v.mr === '60px' && v.host, 8000,
      (v) => `${JSON.stringify({ ml: v.ml, mr: v.mr })} (bfcache restore: ${v.persisted})`);

    // Restore what the orphan section below expects (200/200 defaults).
    await settingsSet({ theme: 'light', defaultLeft: 200, defaultRight: 200 });

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
    await waitFor(async () => (await evalIn(orphPage, SNAP)).ml === '200px', 4000, 'orphan page squeezed');
    // No await: the reload destroys the worker session, so no reply comes.
    cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, sw).catch(() => {});
    // Wait for the old context to be provably gone rather than guessing a
    // duration: if it were still live, the style poke below would find a
    // watcher that legitimately re-asserts, and the teardown check would hang
    // waiting for a restore that was never due.
    await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return !targetInfos.some((t) => t.targetId === swTargetId);
    }, 10000, 'the old service worker target is gone');
    await sleep(300);
    // First wake-up: a foreign write to the html style attribute. The old
    // squeeze watcher must tear the orphan down instead of re-asserting.
    await evalIn(orphPage, 'document.documentElement.style.color = "red", "poked"');
    await checkFor('orphaned script restores the page on its first wake-up',
      () => evalIn(orphPage, SNAP), (v) => v.ml === '0px' && !v.host, 4000,
      (v) => JSON.stringify({ ml: v.ml, host: v.host }));
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
