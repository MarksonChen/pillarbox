// Service worker: routes toolbar-icon clicks (and the _execute_action
// keyboard shortcut) to the content script, injecting it first into tabs
// that were already open when the extension was installed or reloaded.
// It also owns the jobs a content script cannot do itself: the one-time
// cleanup of pre-release storage, the LRU prune of page records, the
// chrome.tabs zoom relay, and the private-network-guarded fetch of
// cross-origin stylesheet text.
importScripts('shared/defaults.js', 'shared/css-relay.js');

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
// records (`t` is stamped by the content script on every toggle, drag end
// and reset, and on loading a page that already has a record — never on a
// plain window resize). Checked shortly after any new record appears.
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
const RELAY = SQZ.cssRelay;

async function fetchCssFile(url, budget, from) {
  if (!RELAY.relayable(url, from)) return null; // also covers @import targets
  let res;
  try {
    // Redirects are followed, not refused: CDN version aliases, http->https
    // upgrades and path canonicalisation all redirect, and refusing them
    // blacklists the sheet for the page's whole life. What made refusing
    // look necessary — a redirect walking the policy from a public URL to a
    // private one — is closed by re-running relayable() on res.url below,
    // which is the check that actually decides, on the URL actually fetched.
    res = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
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
  if (!res.ok || !RELAY.relayable(res.url, from)) return null;
  // Strict on purpose, and not merely a parity check with what Chrome would
  // apply: the relay hands a cross-origin body back to the page, so anything
  // it will fetch is a CORS bypass for that resource. text/css keeps that to
  // stylesheets. Parameters are dropped, so `text/css; charset=utf-8` passes.
  const mime = (res.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== 'text/css') return null;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > budget.left) return null;

  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.left -= value.byteLength;
      if (budget.left < 0) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    try { await reader.cancel(); } catch {}
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== SQZ.MSG.FETCH_CSS) return;
  if (sender.tab === undefined) return; // only content scripts ask
  const url = String(msg.url ?? '');
  // sender.origin/url is set by the browser, not by the page, so it is a
  // trustworthy answer to "who is asking" for the private-target check.
  const from = sender.origin ?? sender.url ?? '';
  if (!RELAY.relayable(url, from)) {
    sendResponse({ ok: false });
    return;
  }
  RELAY.inlineCss(url, { left: CSS_BUDGET }, CSS_IMPORT_DEPTH, new Set(), from, fetchCssFile)
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
