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
  rules: Object.freeze([]), // [{pattern, left, right}] per-URL default widths
});

// Silent cap on remembered pages: the least recently used records beyond
// this are pruned by the service worker. Deliberately not a setting.
SQZ.MAX_PAGES = 1000;

SQZ.sanitizeColor = (value, fallback) =>
  (/^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value : fallback);

SQZ.SETTINGS_KEY = 'settings';      // chrome.storage.sync
SQZ.PAGE_PREFIX = 'page:';          // chrome.storage.local, one key per page URL
SQZ.LEGACY_SITE_PREFIX = 'site:';   // pre-0.2 per-origin records, cleaned on install
SQZ.ZOOM_PREFIX = 'zoom:';          // chrome.storage.local, per-origin zoom hint
                                    // (only written while an origin sits ≠ 100%)
SQZ.MSG = Object.freeze({
  TOGGLE: 'SQZ_TOGGLE',
  ZOOM: 'SQZ_ZOOM',         // worker -> content: the tab's zoom factor changed
  GET_ZOOM: 'SQZ_GET_ZOOM', // content -> worker: what is this tab's zoom?
});
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

// Chrome's page zoom is itself remembered per origin, so the hint that
// makes a zoomed boot exact-and-instant follows the same shape.
SQZ.zoomKey = (origin) => SQZ.ZOOM_PREFIX + origin;

SQZ.mergeSettings = (raw) => ({ ...SQZ.DEFAULT_SETTINGS, ...(raw ?? {}) });

// Clamp a width setting to a sane stored value (options inputs, URL rules).
SQZ.clampDefault = (value) =>
  Math.max(0, Math.min(SQZ.MAX_WIDTH, Math.round(Number(value)) || 0));

// First matching per-URL rule, or null. Patterns are regexes tested against
// origin + path + query — the #hash is ignored, mirroring pageKey — and an
// unanchored plain prefix like "https://www.example.com/articles" works as
// expected. Invalid or empty patterns are skipped. Rule widths are px at
// 100% zoom, like every stored width.
SQZ.matchRule = (rules, url) => {
  if (!Array.isArray(rules)) return null;
  const u = new URL(url);
  const target = u.origin + u.pathname + u.search;
  for (const rule of rules) {
    if (typeof rule?.pattern !== 'string' || rule.pattern === '') continue;
    try {
      if (!new RegExp(rule.pattern).test(target)) continue;
    } catch {
      continue; // invalid regex: the options page flags it, we skip it
    }
    return { left: SQZ.clampDefault(rule.left), right: SQZ.clampDefault(rule.right) };
  }
  return null;
};

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

// Page zoom scales the CSS px unit itself, so a width applied verbatim
// grows on screen as the user zooms in — and the content column, already
// narrowed by the zoom, gets squeezed a second time. Widths are therefore
// stored as "px at 100% zoom" and converted at the two boundaries below;
// everything in between (clamps, panels, margins, insets) stays in CSS px.
SQZ.sanitizeZoom = (z) => (Number.isFinite(z) && z > 0 ? z : 1);
SQZ.storedToCss = (px, zoom) => px / zoom;
SQZ.cssToStored = (px, zoom) => Math.round(px * zoom);

// Clamp one side while it is being dragged, given the other side's width.
SQZ.clampDrag = (px, otherSide) => {
  const cap = Math.max(0, SQZ.viewportWidth() - SQZ.MIN_GAP - Math.max(0, otherSide));
  return Math.max(0, Math.min(Math.round(Number(px)) || 0, cap));
};

// Mirrored drag: the far side keeps a fixed offset from the dragged (near)
// side, so both move by the same amount and backtracking retraces the same
// widths. The pair is clamped jointly: both sides stop together at the
// MIN_GAP limit, and neither goes below 0.
SQZ.mirrorPair = (px, offset) => {
  const budget = Math.max(0, SQZ.viewportWidth() - SQZ.MIN_GAP);
  let near = Math.max(0, Math.min(Math.round(px) || 0, budget));
  const over = near + Math.max(0, near + offset) - budget;
  if (over > 0) near = Math.max(0, near - Math.ceil(over / 2));
  const far = Math.min(Math.max(0, near + offset), budget - near);
  return { near, far };
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
