# Pillarbox

A Chrome extension (Manifest V3, vanilla JS, no build step) that squeezes
page content inward between two empty, resizable sidebars. For pages that
put their content hard-left, hard-right, or across the full window width.

- **Click the toolbar icon** (or press `Alt+Shift+S`) to toggle the sidebars
  on the current site. The page content genuinely **reflows** into the inner
  region — it is not just covered.
- **Drag** a sidebar's inner edge to resize it; left and right are
  independent. Hold **any modifier key** (⇧ ⌃ ⌥ ⌘) while dragging to move
  both sidebars together by the same amount — press or release the key
  mid-drag to link/unlink. **Double-click** a handle to collapse/restore
  that side, or double-click a sidebar's empty space to restore both sides
  to your default widths. A sidebar can go past the middle when the other side is narrow
  — the only limit is that at least 200px of page always stays visible
  between them.
- **Zoom-stable**: sidebar widths are kept in pixels at 100% page zoom, so
  a sidebar stays the same size on screen at any zoom level — zooming
  changes the size of the page's text, not the width of the pillars.
- **Per-page memory with auto-restore**: each exact URL (path + query; the
  hash is ignored) remembers whether the sidebars are on and how wide they
  are, and re-applies that on every reload and future visit until you toggle
  them off. Same-document (SPA) navigations switch records live — leaving a
  remembered page closes the sidebars, coming back reopens them. Usually
  only a few pages on a big site need squeezing, so memory is deliberately
  narrow. Memory is automatic and capped at the 1000 most recently used
  pages (older records are silently pruned).
- Full-width `position:fixed` bars (navbars, cookie banners, fixed app
  shells) are **also squeezed**, best-effort and always on; sticky elements
  reflow on their own. So are app shells pinned to the viewport with
  `width:100vw` (chatgpt.com, notion.so) and full-bleed bars that break out
  with viewport-relative negative margins (reddit's header).
- **Options page**: live preview, theme (Auto/Light/Dark), sidebar colors
  for the light and dark themes, default widths, the pixel readout while
  resizing (off by default), a gesture reference, and the current keyboard
  shortcut with a jump to Chrome's shortcut editor (Chrome offers no API to
  set shortcuts from an extension page).

## Install (any Chrome)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** → select this folder.
3. Pin the icon; click it on any page.

## How it works

- **Reflow**: inline `margin-left/right` + `width:auto` are set on `<html>`
  through the CSSOM with `!important`. That reflows all normal-flow and
  sticky content, wins over the page's own CSS (even inline `!important`),
  and cannot be blocked by page CSP. A `MutationObserver` re-asserts the
  values if the page rewrites its own style attribute.
- **Panels**: one `<pillarbox-host>` element with an open shadow root
  holds both panels, so page CSS can't restyle them.
- **Fixed bars & app shells**: `position:fixed` boxes are laid out against
  the viewport, and `position:absolute` boxes with no positioned ancestor
  (SPA app shells like claude.ai's `absolute inset-0` root) are anchored to
  the initial containing block — both ignore the html margins. Elements of
  either kind that span ≥ 90% of the viewport and visibly escape the squeeze
  (absolute ones additionally must have no positioned/transformed ancestor)
  get inline `left/right` insets to match. A
  `MutationObserver` catches bars added later or turned fixed by a class
  change; everything is restored exactly on toggle-off. Squeezing the shell
  also narrows any iframe inside it, so framed content (e.g. artifact
  viewers) reflows like a window resize.
- **Viewport-unit shells**: normal-flow boxes can escape too, by being
  sized with viewport units (`width:100vw` app shells — chatgpt.com,
  notion.so) or pulled out by the full-bleed idiom
  `margin-inline: calc(0px - (50vw - 50%))` (reddit's header). Escaping
  flow boxes get `width:auto` (and their negative margins zeroed) so they
  track their squeezed parent again. Each adoption is verified and undone
  if it changed nothing (a table sized by unbreakable content can't be
  fixed by width overrides). The panel host also pins
  `visibility:visible !important` inline, because some sites hide all
  undefined custom elements as an anti-flicker guard (reddit's
  `:not(:defined){visibility:hidden}`).
- **Page zoom**: zoom scales the CSS px unit itself, so a stored width
  applied verbatim would grow on screen as the user zooms in — squeezing
  the content column a second time on top of the zoom. Widths are stored as
  px at 100% zoom and divided by the tab's zoom factor on the way into the
  page (multiplied back on the way out of a drag); every clamp, panel and
  inset in between stays in ordinary CSS px. The factor itself lives in
  `chrome.tabs`, which content scripts can't reach, so the service worker
  relays it — on request at boot and after a bfcache return, and as a push
  from `tabs.onZoomChange`. Neither member needs a permission. A resize
  whose `devicePixelRatio` moved is the cheap in-page hint that the zoom may
  have changed, and the only thing that triggers a re-query.
- **Surviving extension reloads**: reloading or updating the extension
  orphans the content script in every open tab — `chrome.runtime.id` goes
  undefined and each `chrome.*` call throws "Extension context invalidated".
  On its next wake-up (SPA navigation, resize, storage write, or a style
  re-assertion), an orphaned script restores the page and detaches
  completely instead of erroring or fighting the freshly injected script
  over the html margins; the next toolbar click injects a new script that
  takes over from storage.

## Known limitations (by design)

- Media queries don't re-evaluate — the site keeps its desktop layout, just
  narrower (that's the point). Pages with a hard `min-width` show a
  horizontal scrollbar because the content area is genuinely narrower.
- `100vw` sections narrower than 90% of the viewport, and boxes that are
  wide because of unbreakable content (code blocks, tables), still extend
  under the (opaque) panels.
- Fixed elements narrower than 90% of the viewport (chat buttons, side
  drawers) are not moved and may sit partly under a panel.
- Fixed bars centered with `left:50% + translateX(-50%)` can end up shifted.
- Apps that measure `window.innerWidth` in JavaScript and set pixel sizes
  from it (some editors / canvas UIs) lay themselves out to the real
  viewport; no in-page technique can change what `innerWidth` reports.
- Top frame only; fixed elements inside iframes are untouched.
- Pages that differ only in their `#hash` share one record; pages that
  differ in query string get separate records.
- Running on `file://` pages requires "Allow access to file URLs" in
  `chrome://extensions`.
- Fullscreen video/elements render in the browser's top layer and are
  unaffected. Printing temporarily un-squeezes the page so printouts are
  clean.

## Development

```
manifest.json          extension wiring
background.js          service worker: icon click -> toggle message (+ inject fallback), zoom relay
shared/defaults.js     constants shared by all contexts
content/squeeze.js     html-margin reflow + style watcher
content/fixed-bars.js  escaping-element manager (fixed bars, vw-unit shells)
content/panels.js      shadow-DOM panels + drag handles
content/index.js       per-page state machine, storage, lifecycle
options/               options page
tools/make_icons.sh    regenerate icons/ from source art (macOS sips)
test/                  test pages + end-to-end script
```

State: `chrome.storage.sync['settings']` holds `{theme, defaultLeft,
defaultRight, colorLight, colorDark, showReadout}`;
`chrome.storage.local['page:<origin+path+query>']` holds `{on, left, right, t}`
per page (widths in px at 100% zoom; `t` is the last-used timestamp driving
the 1000-page LRU cap).

### Testing

Manual: serve the test pages and load the extension unpacked, then click the
icon on the page and walk the checklist in `test/page.html` (fixed navbar
edges move inward, sticky reflows, FAB stays put, late/morphing bars get
adopted, print preview is clean):

```sh
python3 -m http.server 8080 --directory test
open http://localhost:8080/page.html
```

Automated (needs Node ≥ 22 and Chrome for Testing — branded Chrome ≥ 137
ignores `--load-extension`):

```sh
npx @puppeteer/browsers install chrome@stable --path .cft   # once, ~150 MB
node test/e2e.mjs
```

The script launches a throwaway headless profile, toggles via the real
message path, and asserts reflow, fixed-bar insetting, per-page auto-restore
after reload, zoom-stable widths (change + zoomed page load), live settings
flips, theming, and survival of a `style-src 'none'` CSP. It writes screenshots to `$SHOT_DIR` (default: OS
temp dir).
