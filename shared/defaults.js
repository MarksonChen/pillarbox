// Shared constants and helpers, loaded by every extension context: content
// scripts (first file in the manifest list), the service worker (via
// importScripts) and the options page (via <script src>).
//
// `var` + guarded init so repeated evaluation (e.g. re-injection through
// chrome.scripting.executeScript) is harmless in the shared isolated world.
var SQZ = globalThis.SQZ ??= {};

SQZ.DEFAULT_SETTINGS = Object.freeze({
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  defaultLeft: 200,         // px, used the first time a page is enabled
  defaultRight: 200,        // px
  colorLight: '#eef0f3',    // panel color when the light theme is active
  colorDark: '#1d2126',     // panel color when the dark theme is active
  showReadout: false,       // px readout bubble while dragging a handle
});

// Silent cap on remembered pages: the least recently used records beyond
// this are pruned by the service worker. Deliberately not a setting.
SQZ.MAX_PAGES = 1000;

SQZ.sanitizeColor = (value, fallback) =>
  (/^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value : fallback);

SQZ.SETTINGS_KEY = 'settings';      // chrome.storage.sync
SQZ.PAGE_PREFIX = 'page:';          // chrome.storage.local, one key per page URL
SQZ.LEGACY_SITE_PREFIX = 'site:';   // pre-0.2 per-origin records, cleaned on install
SQZ.MSG = Object.freeze({ TOGGLE: 'SQZ_TOGGLE' });
SQZ.MAX_WIDTH = 800;                // cap for the default-width inputs in options

// Must mirror manifest.json content_scripts[0].js exactly (same files, same
// order); background.js re-injects this list into tabs that were already
// open when the extension was installed or reloaded.
SQZ.CONTENT_FILES = Object.freeze([
  'shared/defaults.js',
  'content/squeeze.js',
  'content/fixed-bars.js',
  'content/panels.js',
  'content/index.js',
]);

// Memory is per PAGE: origin + path + query. The hash is ignored (in-page
// anchors, and it can change without a navigation the user would think of
// as "a different page").
SQZ.pageKey = (url) => {
  const u = new URL(url);
  return SQZ.PAGE_PREFIX + u.origin + u.pathname + u.search;
};

SQZ.mergeSettings = (raw) => ({ ...SQZ.DEFAULT_SETTINGS, ...(raw ?? {}) });

// The sidebars may never leave less than this much page visible between
// them. There is no per-side cap: one sidebar can sit at the page border
// (width 0) while the other goes past the middle.
SQZ.MIN_GAP = 200;

// Layout-viewport width, excluding a classic scrollbar — the space fixed
// boxes, the panels and pointer clientX coordinates actually share
// (innerWidth includes the scrollbar and would skew drag math by its
// width). Quirks-mode pages fall back to innerWidth: there the root's
// clientWidth reports the squeezed <html> box, not the viewport.
// Content-script contexts only (needs a window + document).
SQZ.viewportWidth = () => (document.compatMode === 'CSS1Compat'
  ? document.documentElement.clientWidth
  : innerWidth);

// Clamp one side while it is being dragged, given the other side's width.
SQZ.clampDrag = (px, otherSide) => {
  const cap = Math.max(0, SQZ.viewportWidth() - SQZ.MIN_GAP - Math.max(0, otherSide));
  return Math.max(0, Math.min(Math.round(Number(px)) || 0, cap));
};

// Clamp a stored pair for the current viewport (loads, resizes, cross-tab
// sync). If both sides together crowd out the minimum gap — e.g. the window
// shrank since the widths were saved — scale them down proportionally.
SQZ.clampPair = (left, right) => {
  left = Math.max(0, Math.round(Number(left)) || 0);
  right = Math.max(0, Math.round(Number(right)) || 0);
  const budget = Math.max(0, SQZ.viewportWidth() - SQZ.MIN_GAP);
  const total = left + right;
  if (total > budget) {
    const scale = budget / total;
    left = Math.floor(left * scale);
    right = Math.floor(right * scale);
  }
  return { left, right };
};
