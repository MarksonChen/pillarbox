# Pillarbox — developer notes

Manifest V3, vanilla JS, no build step. Load the folder unpacked and reload it
from `chrome://extensions` after an edit. For what the extension does from a
user's point of view, see [README.md](README.md).

## Layout

```
manifest.json          extension wiring
background.js          service worker: icon click -> toggle message (+ inject fallback), zoom relay
shared/defaults.js     constants shared by all contexts
content/squeeze.js     html-margin reflow + style watcher
content/fixed-bars.js  escaping-element manager (fixed bars, vw-unit shells)
content/panels.js      shadow-DOM panels + drag handles
content/index.js       per-page state machine, storage, lifecycle
options/               options page
tools/make_icons.sh    regenerate icons/ from tools/icon-source.png (macOS sips)
test/                  test pages + end-to-end script
```

`shared/defaults.js` is loaded by every context — content scripts (first file
in the manifest list), the service worker (`importScripts`) and the options
page (`<script src>`). It uses `var` plus a guarded init so repeated evaluation
through `chrome.scripting.executeScript` is harmless.

## State

- `chrome.storage.sync['settings']` — `{theme, defaultLeft, defaultRight,
  colorLight, colorDark, showReadout, rules}`. `rules` is an ordered list of
  `{pattern, left, right}`; the first matching regex wins. Three rules ship as
  defaults until the first options save, which persists the list wholesale (so
  deleting a shipped rule sticks).
- `chrome.storage.local['page:<origin+path+query>']` — `{on, left, right, t}`
  per page. Widths are px at 100% zoom; `t` is the last-used timestamp that
  drives the 1000-page LRU cap enforced by the service worker.
- `chrome.storage.local['zoom:<origin>']` — an origin's confirmed zoom factor,
  written only while it sits ≠ 100% and removed when it returns.

Memory is per page rather than per site because usually only a few pages on a
big site need squeezing. Pages differing only in `#hash` share one record;
pages differing in query string get separate records.

## How the squeeze works

**Reflow.** Inline `margin-left/right` plus `width:auto` are set on `<html>`
through the CSSOM with `!important`. That reflows all normal-flow and sticky
content, wins over the page's own CSS (even inline `!important`), and cannot be
blocked by page CSP. A `MutationObserver` re-asserts the values if the page
rewrites its own style attribute.

**Panels.** One `<pillarbox-host>` element with an open shadow root holds both
panels, so page CSS cannot restyle them. The host also pins
`visibility:visible !important` inline, because some sites hide all undefined
custom elements as an anti-flicker guard (reddit's
`:not(:defined){visibility:hidden}`).

**Fixed bars and app shells.** `position:fixed` boxes are laid out against the
viewport, and `position:absolute` boxes with no positioned ancestor (SPA app
shells like claude.ai's `absolute inset-0` root) are anchored to the initial
containing block — both ignore the html margins. Elements of either kind that
span ≥ 90% of the viewport and visibly escape the squeeze (absolute ones must
additionally have no positioned or transformed ancestor) get inline
`left/right` insets to match. A `MutationObserver` catches bars added later or
turned fixed by a class change, and everything is restored exactly on
toggle-off. Squeezing a shell also narrows any iframe inside it, so framed
content (artifact viewers and the like) reflows like a window resize.

**Viewport-unit shells.** Normal-flow boxes escape too, by being sized with
viewport units (`width:100vw` app shells — chatgpt.com, notion.so) or pulled
out by the full-bleed idiom `margin-inline: calc(0px - (50vw - 50%))`
(reddit's header). Escaping flow boxes get `width:auto`, and their negative
margins zeroed, so they track their squeezed parent again. Each adoption is
verified and undone if it changed nothing — a table sized by unbreakable
content cannot be fixed by width overrides.

**Page zoom.** Zoom scales the CSS px unit itself, so a stored width applied
verbatim would grow on screen as the user zooms in, squeezing the content
column a second time on top of the zoom. Widths are therefore stored as px at
100% zoom and divided by the tab's zoom factor on the way into the page
(multiplied back on the way out of a drag); every clamp, panel and inset in
between stays in ordinary CSS px.

Learning the factor is latency-critical: the authoritative value lives in
`chrome.tabs`, a worker round-trip away, so the page would repaint wrong and
then snap. Instead the factor is *predicted* in-page. `devicePixelRatio` is
zoom × display scale and has already moved when the resize event fires, inside
the rendering update that paints the first zoomed frame — so dividing the old
dpr out of the new one converts the last authoritative `(zoom, dpr)` pair into
the exact new factor, applied before that first paint. Zooming is flash-free by
construction. The service worker then merely confirms (`tabs.getZoom` on
request, `tabs.onZoomChange` as a push — neither needs a permission) and only
ever corrects the one case the ratio misreads: a cross-display move, where dpr
moved but zoom did not. Confirmed non-100% factors are cached per origin, so a
zoomed page auto-restores at exact widths straight from the boot-time storage
read, with no worker on the boot path either.

**Surviving extension reloads.** Reloading or updating the extension orphans
the content script in every open tab — `chrome.runtime.id` goes undefined and
each `chrome.*` call throws "Extension context invalidated". On its next
wake-up (SPA navigation, resize, storage write, or a style re-assertion), an
orphaned script restores the page and detaches completely instead of erroring
or fighting the freshly injected script over the html margins. The next toolbar
click injects a new script that takes over from storage.

## Options page

The options page loads the real content scripts itself (Chrome injects none
into extension pages), so it runs live, adjustable pillars like any other page
and `options.js` seeds the record on first visit.

The poster is designed on a 1440px canvas. `--u` is the scale unit — 1px at
≥1440, proportionally less below — and is applied to the display type so the
whole thing shrinks as one piece; small mono text and rules keep fixed sizes.
`--u` is derived from `cqw` rather than `vw` precisely because the page runs
its own pillars: when they squeeze `<html>`, the poster has to rescale into the
inner column.

Two typographic details are easy to undo by accident:

- The giant words are pulled left by `-0.069em`, the left side bearing of this
  face's stems, so the *ink* lands on the page edge rather than the text box.
  Outlined words go the other way: half of their 4px stroke falls outside the
  glyph, so `WIDTH` steps in from the left and `TOUCH` steps 2px in from the
  right.
- The width inputs carry negative tracking, so the box the browser sizes to the
  text ends one letter-space inside the last digit — and a text field clips at
  that content edge, not at its padding box, so padding cannot buy the room
  back. An RTL start-indent can: it reserves the space at the line's end, which
  in RTL is the right. The digits stay an ordinary LTR run.

## Known limitations (by design)

- Media queries do not re-evaluate — the site keeps its desktop layout, just
  narrower. Pages with a hard `min-width` show a horizontal scrollbar because
  the content area is genuinely narrower.
- `100vw` sections narrower than 90% of the viewport, and boxes that are wide
  because of unbreakable content (code blocks, tables), still extend under the
  opaque panels.
- Fixed elements narrower than 90% of the viewport (chat buttons, side drawers)
  are not moved and may sit partly under a panel.
- Fixed bars centered with `left:50%` + `translateX(-50%)` can end up shifted.
- Apps that measure `window.innerWidth` in JavaScript and set pixel sizes from
  it (some editors and canvas UIs) lay themselves out to the real viewport; no
  in-page technique can change what `innerWidth` reports.
- Top frame only; fixed elements inside iframes are untouched.
- Running on `file://` pages requires "Allow access to file URLs" in
  `chrome://extensions`.
- Fullscreen video and elements render in the browser's top layer and are
  unaffected. Printing temporarily un-squeezes the page.

## Testing

Manual: serve the test pages, load the extension unpacked, then click the icon
on the page and walk the checklist in `test/page.html` — fixed navbar edges
move inward, sticky reflows, the FAB stays put, late and morphing bars get
adopted, print preview is clean.

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

The script launches a throwaway headless profile, toggles via the real message
path, and asserts reflow, fixed-bar insetting, per-page auto-restore after
reload, zoom-stable widths (correct in the first zoomed frame, hint
persistence, zoomed page load), per-URL width rules (first-enable widths,
rule-aware reset, options editor round-trip), live settings flips, theming, and
survival of a `style-src 'none'` CSP. Screenshots go to `$SHOT_DIR` (default:
the OS temp dir).

## Icons

`tools/icon-source.png` is the master art — square, black on transparent — kept
in `tools/` rather than `icons/` so it reads as build input rather than a
shipped asset (nothing excludes it from a zip; leave it out when packaging).
Regenerate the four sizes with:

```sh
tools/make_icons.sh tools/icon-source.png
```

The mark is black-only, so it reads well on Chrome's light toolbar and goes
low-contrast on a dark one. Chrome does not invert `action.default_icon` PNGs,
so a dark-toolbar variant would have to be a second set of files swapped at
runtime via `chrome.action.setIcon`.
