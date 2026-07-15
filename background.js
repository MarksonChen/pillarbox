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

  // Fixed-bar squeezing is always on; a stored `squeezeFixed: false` from a
  // pre-release build must not linger (nothing reads it, but a stale flag
  // in storage invites confusion).
  const raw = await chrome.storage.sync.get(SQZ.SETTINGS_KEY);
  const settings = raw[SQZ.SETTINGS_KEY];
  if (settings && 'squeezeFixed' in settings) {
    delete settings.squeezeFixed;
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

function flashBadge(tabId) {
  // Signal "can't run here" (chrome://, Web Store, PDF viewer, ...).
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' })
    .then(() => chrome.action.setBadgeText({ tabId, text: '✕' }))
    .catch(() => {});
  // The worker outlives the click event long enough for a short timer.
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }, 1600);
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (tabId === undefined || tabId === chrome.tabs.TAB_ID_NONE) return;
  // A ✕ from an earlier click sticks around if the worker was killed before
  // flashBadge's clear timer fired; wipe the slate on every click.
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  const toggle = () => chrome.tabs.sendMessage(tabId, { type: SQZ.MSG.TOGGLE });
  try {
    await toggle();
    return;
  } catch {
    // No receiver: the tab predates this extension load. Inject and retry.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...SQZ.CONTENT_FILES],
    });
    await toggle();
  } catch {
    flashBadge(tabId);
  }
});
