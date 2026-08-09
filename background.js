// Service worker: routes toolbar-icon clicks (and the _execute_action
// keyboard shortcut) to the content script, injecting it first into tabs
// that were already open when the extension was installed or reloaded.
importScripts('shared/defaults.js');

// Pre-release builds stored one record per origin under 'site:'; the schema
// is now one record per page URL under 'page:'. Drop the dead data once.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(SQZ.LEGACY_SITE_PREFIX));
  if (stale.length) await chrome.storage.local.remove(stale);

  // Fixed-bar squeezing and breakpoint shifting are always on; a stored
  // `squeezeFixed: false` / `responsive: false` from a pre-release build
  // must not linger (nothing reads them, but a stale flag in storage
  // invites confusion).
  const raw = await chrome.storage.sync.get(SQZ.SETTINGS_KEY);
  const settings = raw[SQZ.SETTINGS_KEY];
  const dead = ['squeezeFixed', 'responsive'].filter((k) => settings && k in settings);
  if (dead.length) {
    for (const k of dead) delete settings[k];
    await chrome.storage.sync.set({ [SQZ.SETTINGS_KEY]: settings });
  }
});

// Silent LRU cap: keep only the SQZ.MAX_PAGES most recently used page
// records (`t` is stamped by the content script on every toggle/resize/
// restore). Checked shortly after any new record appears.
let pruneTimer = null;

async function prunePages() {
  const all = await chrome.storage.local.get(null);
  const pages = Object.entries(all).filter(([k]) => k.startsWith(SQZ.PAGE_PREFIX));
  if (pages.length <= SQZ.MAX_PAGES) return;
  pages.sort((a, b) => (a[1]?.t ?? 0) - (b[1]?.t ?? 0));
  const evict = pages.slice(0, pages.length - SQZ.MAX_PAGES).map(([k]) => k);
  await chrome.storage.local.remove(evict);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const addedNew = Object.entries(changes).some(([key, change]) =>
    key.startsWith(SQZ.PAGE_PREFIX) && change.newValue && !change.oldValue);
  if (!addedNew) return;
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => prunePages().catch(() => {}), 3000);
});

// Page zoom lives in chrome.tabs, which a content script cannot reach, so
// the worker relays it: the exact factor on request (boot, bfcache return)
// and a push on every change. Neither member needs a permission — they are
// not among the chrome.tabs features gated on "tabs" or host access, so
// this costs no new install warning.
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  chrome.tabs.sendMessage(tabId, { type: SQZ.MSG.ZOOM, zoom: newZoomFactor })
    .catch(() => {}); // no content script there (chrome://, PDF viewer, ...)
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== SQZ.MSG.GET_ZOOM) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return; // not from a tab; nothing to measure
  chrome.tabs.getZoom(tabId)
    .then((zoom) => sendResponse({ zoom }))
    .catch(() => sendResponse({ zoom: 1 })); // tab gone mid-flight
  return true; // keep the channel open for the async response
});

// --- cross-origin CSS relay ------------------------------------------------
// The breakpoint shifter (content/media-queries.js) cannot read a
// cross-origin stylesheet (cssRules throws) nor fetch it (content scripts
// follow the page's CORS); the worker can, thanks to host_permissions. The
// text is prepared for replay inside a <style> clone at the DOCUMENT's base
// URL, so every relative url() is absolutized against the sheet's own URL
// and @import chains are inlined (a clone's imports would be fetched by the
// page and land back in cross-origin darkness, unshiftable).

const CSS_FETCH_TIMEOUT = 15000;
const CSS_BUDGET = 8 * 1024 * 1024; // total bytes across one import tree
const CSS_IMPORT_DEPTH = 3;

// Is this host on the private side of the network? The relay fetches with the
// extension's <all_urls> reach, so without a guard a page Pillarbox is active
// on could point a <link rel=stylesheet> at something only the browser's host
// can see — a router admin page, a cloud metadata endpoint — and then read the
// response back out of the <style> clone, which lives in the page's own DOM.
// Literal matching cannot follow a rebinding DNS name, so this is hardening
// rather than a boundary.
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host.startsWith('::ffff:127.')) return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 0 || a === 127 || a === 10
    || (a === 169 && b === 254)               // link-local, metadata services
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31);
}

// `from` is the URL of the page that asked. A private target is allowed only
// when that page is itself on a private address: a localhost dev site or an
// intranet app linking its own stylesheets is the ordinary case and has to
// keep working, and it can already read those origins' own responses. What
// this refuses is the escalation — a PUBLIC page reaching into the LAN, or
// into the loopback interface, through our host permission.
function relayable(url, from) {
  let u = null;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/i.test(u.protocol)) return false;
  if (!isPrivateHost(u.hostname)) return true;
  let asker = null;
  try { asker = new URL(from); } catch { return false; }
  return isPrivateHost(asker.hostname);
}

async function fetchCssFile(url, budget, from) {
  if (!relayable(url, from)) return null; // also covers @import targets
  let res;
  try {
    res = await fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(CSS_FETCH_TIMEOUT),
    });
  } catch {
    return null;
  } finally {
    // Touching an extension API resets the worker's 30s idle timer; a plain
    // fetch() does not. An @import chain of slow sheets can add up to more
    // than that, and a worker killed mid-relay never sends its reply — the
    // content script then sees only a dead channel.
    chrome.runtime.getPlatformInfo().catch(() => {});
  }
  if (!res.ok) return null;
  const text = await res.text().catch(() => null);
  if (text === null) return null;
  budget.left -= text.length;
  return budget.left < 0 ? null : text;
}

// Rewrite url(...) references (and any @import url we leave behind) to be
// absolute. Skips absolute schemes, data:/blob:, protocol-relative //, and
// bare #fragments (same-document SVG paint servers must stay relative).
function absolutizeCssUrls(text, baseUrl) {
  const resolve = (v) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v) || v === '') return null;
    try { return new URL(v, baseUrl).href; } catch { return null; }
  };
  text = text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
    (m, dq, sq, bare) => {
      const abs = resolve(dq ?? sq ?? bare);
      return abs === null ? m : `url("${abs.replace(/"/g, '%22')}")`;
    });
  // String-form @import ('@import "x.css";') for the chains left in place
  // when the depth or byte budget runs out.
  text = text.replace(/(@import\s+)(?:"([^"]*)"|'([^']*)')/gi, (m, head, dq, sq) => {
    const abs = resolve(dq ?? sq);
    return abs === null ? m : `${head}"${abs.replace(/"/g, '%22')}"`;
  });
  return text;
}

// Split the leading import statements off a stylesheet: only @charset,
// @layer statements and @import may precede other rules, so a small scan
// from the top is exact enough. Comments between them are skipped; the body
// is left untouched.
function splitCssImports(text) {
  const imports = [];
  let prefix = '';
  let i = 0;
  for (;;) {
    const ws = /^(?:\s+|\/\*[\s\S]*?\*\/)+/.exec(text.slice(i));
    if (ws) i += ws[0].length;
    const rest = text.slice(i);
    let m;
    if ((m = /^@charset\s+"[^"]*"\s*;/i.exec(rest))) {
      i += m[0].length; // dropped: the text is already decoded
    } else if ((m = /^@layer\s+[^{;]*;/i.exec(rest))) {
      prefix += m[0] + '\n'; // layer-order statement: keep, order matters
      i += m[0].length;
    } else if ((m = /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/i.exec(rest))) {
      imports.push({
        url: (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim(),
        tail: m[6].trim(),
        raw: m[0],
      });
      i += m[0].length;
    } else {
      break;
    }
  }
  return { prefix, imports, body: text.slice(i) };
}

// An import's condition tail becomes equivalent wrapper blocks around the
// inlined text: layer(name)/layer -> @layer, supports(...) -> @supports,
// the rest is a media query -> @media.
function wrapImportedCss(text, tail) {
  let media = tail;
  const layer = /^layer(?:\(([^)]*)\))?\s*/i.exec(media);
  if (layer) media = media.slice(layer[0].length);
  const sup = /^supports\(((?:[^()]|\([^()]*\))*)\)\s*/i.exec(media);
  if (sup) media = media.slice(sup[0].length);
  media = media.trim();
  if (media && media.toLowerCase() !== 'all') text = `@media ${media} {\n${text}\n}`;
  if (sup) text = `@supports ${sup[1]} {\n${text}\n}`;
  if (layer) text = `@layer ${layer[1] ? layer[1].trim() + ' ' : ''}{\n${text}\n}`;
  return text;
}

async function inlineCss(url, budget, depth, seen, from) {
  if (seen.has(url)) return ''; // import cycle: drop the repeat
  seen.add(url);
  let text = await fetchCssFile(url, budget, from);
  if (text === null) return null;
  text = absolutizeCssUrls(text, url);
  const { prefix, imports, body } = splitCssImports(text);
  let out = prefix;
  for (const imp of imports) {
    // Recurse while depth and budget allow; otherwise keep the (already
    // absolutized) @import — the page fetches it natively, styled but
    // unshifted, which beats dropping the rules wholesale.
    const child = depth > 0 && /^https?:/i.test(imp.url)
      ? await inlineCss(imp.url, budget, depth - 1, seen, from)
      : null;
    out += (child === null ? imp.raw : wrapImportedCss(child, imp.tail)) + '\n';
  }
  return out + body;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== SQZ.MSG.FETCH_CSS) return;
  if (sender.tab === undefined) return; // only content scripts ask
  const url = String(msg.url ?? '');
  // sender.origin/url is set by the browser, not by the page, so it is a
  // trustworthy answer to "who is asking" for the private-target check.
  const from = sender.origin ?? sender.url ?? '';
  if (!relayable(url, from)) {
    sendResponse({ ok: false });
    return;
  }
  inlineCss(url, { left: CSS_BUDGET }, CSS_IMPORT_DEPTH, new Set(), from)
    .then((text) => sendResponse(text === null ? { ok: false } : { ok: true, text }))
    .catch(() => sendResponse({ ok: false }));
  return true; // keep the channel open for the async response
});

// One pending clear per tab, tracked like pruneTimer above: without this an
// earlier click's timer erases the ✕ a later click just painted.
const badgeTimers = new Map();

function clearBadge(tabId) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

function flashBadge(tabId) {
  // Signal "can't run here" (chrome://, Web Store, PDF viewer, ...).
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' })
    .then(() => chrome.action.setBadgeText({ tabId, text: '✕' }))
    .catch(() => {});
  // The worker outlives the click event long enough for a short timer.
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => clearBadge(tabId), 1600));
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (tabId === undefined || tabId === chrome.tabs.TAB_ID_NONE) return;
  // A ✕ from an earlier click sticks around if the worker was killed before
  // flashBadge's clear timer fired; wipe the slate on every click.
  clearBadge(tabId);
  const toggle = () => chrome.tabs.sendMessage(tabId, { type: SQZ.MSG.TOGGLE });
  try {
    await toggle();
    return;
  } catch {
    // No receiver: the tab predates this extension load. Inject and retry.
  }
  try {
    // The MAIN-world hook first — the isolated scripts announce the squeeze
    // to it, so it must be listening before they boot. Injected this late it
    // cannot retrofit MediaQueryLists the page already minted through the
    // native matchMedia (those follow only after a reload), so it is
    // best-effort and never fatal: the CSS shift works without it.
    //
    // Both calls also rely on files[] executing in order (mq-shift.js defines
    // what match-media.js consumes; defaults.js before everything). The
    // manifest key and registerContentScripts document that guarantee;
    // executeScript's own files[] does not spell it out, though Chromium
    // injects sequentially — worth knowing if a future Chrome ever differs.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...SQZ.MAIN_WORLD_FILES],
      world: 'MAIN',
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...SQZ.CONTENT_FILES],
    });
    await toggle();
  } catch {
    flashBadge(tabId);
  }
});
