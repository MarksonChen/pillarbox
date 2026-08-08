# Pillarbox — developer notes

Manifest V3, vanilla JS, no build step. Load the folder unpacked and reload it
from `chrome://extensions` after an edit. For what the extension does from a
user's point of view, see [README.md](README.md).

## Layout

```
manifest.json          extension wiring
background.js          service worker: icon click -> toggle message (+ inject fallback), zoom relay, cross-origin CSS fetch
shared/defaults.js     constants shared by all contexts
content/squeeze.js     html-margin reflow + style watcher
content/media-queries.js  breakpoint shifter (width media features see the squeezed width)
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
  colorLight, colorDark, showReadout, responsive, rules}`. `responsive`
  (absent means `true`) is the breakpoint shifter's switch — checked as
  `!== false`, so settings saved before it existed get the new behaviour.
  `rules` is an ordered list of
  `{pattern, mode, autoShow, left, right}`; the first match wins. `mode` is
  `'regex'` or `'substring'`, and **absent means `'regex'`**; `autoShow` opens
  the pillars on a matching page that has no record of its own, and **absent
  means `false`**. Rules saved before either field existed therefore behave
  exactly as they did, which is why `SQZ.ruleMode()` and `SQZ.ruleAutoShow()`
  normalize rather than the storage layer migrating. Three rules ship as
  defaults until the first options save, which persists the list wholesale (so
  deleting a shipped rule sticks); the zhihu one ships with `autoShow: true`.
  `SQZ.findRule()` returns the matched rule itself and `SQZ.matchRule()`
  narrows it to `{left, right}` — the narrowing is load-bearing, because
  callers spread that result straight into a page record.
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
turned fixed by a class change; because a class on an *ancestor* can reveal a
bar without touching the bar itself (`body.scrolled .footer`), a mutated
element's subtree is also re-examined, coalesced on a 300 ms timer. Everything
is restored exactly on toggle-off. Squeezing a shell also narrows any iframe inside it, so framed
content (artifact viewers and the like) reflows like a window resize.

**Viewport-unit shells.** Normal-flow boxes escape too, by being sized with
viewport units (`width:100vw` app shells — chatgpt.com, notion.so) or pulled
out by the full-bleed idiom `margin-inline: calc(0px - (50vw - 50%))`
(reddit's header). Escaping flow boxes get `width:auto`, and their negative
margins zeroed, so they track their squeezed parent again. Each adoption is
verified and undone if it changed nothing — a table sized by unbreakable
content cannot be fixed by width overrides.

**Breakpoints.** Media queries evaluate against the window, not the squeezed
content, so a site that would switch to its narrow layout in a smaller
window instead keeps a desktop layout that no longer fits. With the
`responsive` setting on (the default), every width feature in every
reachable stylesheet is shifted by the panels' total width S: a breakpoint W
becomes `calc(W + Spx)` — the same shift for min/max/plain width and both
ends of range syntax, and calc() keeps em-unit breakpoints exact without
knowing the browser's px-per-em. `orientation:` and colon-form
`aspect-ratio:` cannot be shifted by a length, so they are substituted with
a constant (`min-height: 0px` / `min-height: 999999px` — height-based so the
width passes cannot re-match it) that holds for the effective viewport,
recomputed on resize. Edits go through the CSSOM (`MediaList.mediaText`,
whole-sheet `sheet.media` for `<link media>` gates — the DOM attribute is
never touched), which page CSP cannot block. Chrome normalizes what we write
(`calc(700px + 300px)` reads back `calc(1000px)`), so a registry keeps each
rule's original text: updates re-derive from the original (never re-shift
shifted text) and toggle-off restores verbatim.

Cross-origin sheets guard `cssRules` with a SecurityError, and content
scripts cannot fetch them either (page CORS applies) — the worker can (host
permission), so opaque sheets are fetched there, `@import` chains inlined
(depth 3, cycle- and byte-capped, conditions rewritten as equivalent
`@layer`/`@supports`/`@media` wrappers) and `url()`s absolutized against the
sheet's own URL (a clone parses at the document base). The text is replayed
in a `<style>` clone inserted at the owner `<link>` — content-script-
inserted `<style>` bypasses page CSP, and the position keeps cascade order,
which `document.adoptedStyleSheets` would not (adopted sheets sort after
every document sheet and would beat later overrides). The original is turned
off via `sheet.disabled` — the CSSOM flag, NOT `link.disabled`, whose
attribute round-trip re-fetches the sheet asynchronously and leaves the page
unstyled for a moment on restore. Sheets added later are caught by a
childList observer; rules added through `insertRule` (styled-components)
mutate no DOM node, so a 2s rule-count poll covers those. A media flip can
restyle a bar without touching any attribute — invisible to the fixed-bar
observer — so every shift application nudges `fixedBars.update()`, whose
debounced rescan re-adopts whatever the new layout revealed. Printing runs
`stop()` first: print media evaluates width against the paper size, and a
shifted breakpoint would corrupt the printout.

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
click injects a new script that takes over from storage — and its stale-
artifact cleanup begins by dispatching a synthetic `resize`: isolated worlds
outlive the extension, so the orphan's guarded listener tears it down
synchronously during that dispatch. That poke is what restores the media-
query edits, which live only in the CSSOM and carry no fingerprint a new
world could find; inline styles and clone `<style data-pillarbox-mq>` nodes
are additionally stripped by hand in case the old world never runs.

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

- Pages with a hard `min-width` show a horizontal scrollbar because the
  content area is genuinely narrower.
- The breakpoint shifter reaches stylesheets, not scripts: apps that branch
  on `window.matchMedia` or `window.innerWidth` in JavaScript (some editors,
  canvas UIs, JS-measured layouts) still see the real viewport; no in-page
  technique can change what those report. `<picture>`/`srcset` selection
  also keeps using the real viewport — images may load a size larger than
  the column they land in, which is cosmetic.
- Stylesheets inside shadow roots are not shifted (web-components sites), and
  range-syntax `aspect-ratio` conditions are left alone (colon forms are
  substituted).
- `100vw` sections narrower than 90% of the viewport, and boxes that are wide
  because of unbreakable content (code blocks, tables), still extend under the
  opaque panels.
- Fixed elements narrower than 90% of the viewport (chat buttons, side drawers)
  are not moved and may sit partly under a panel.
- Fixed bars centered with `left:50%` + `translateX(-50%)` can end up shifted.
- Top frame only; fixed elements inside iframes are untouched.
- Running on `file://` pages requires "Allow access to file URLs" in
  `chrome://extensions`.
- Fullscreen video and elements render in the browser's top layer and are
  unaffected. Printing temporarily un-squeezes the page.

## Testing

Manual: serve the test pages, load the extension unpacked, then click the icon
on the page and walk the checklist in `test/page.html` — fixed navbar edges
move inward, sticky reflows, the FAB stays put, late and morphing bars get
adopted, the 1000px-breakpoint strip turns green/NARROW, print preview is
clean (and un-triggers the breakpoint).

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
persistence, zoomed page load), per-URL rules (first-enable widths, rule-aware
reset, `autoShow` opening a recordless page on load and on an in-page
navigation, an explicit off outranking the rule, options editor round-trip),
live settings flips, theming,
survival of a `style-src 'none'` CSP, and breakpoint shifting (a shiftText
unit battery plus `test/mq.html` against a second, cross-origin CSS server:
inline/nested/range/em breakpoints flip, orientation goes portrait, a
`<link media>` gate re-evaluates without touching the attribute, the
cross-origin clone inlines its `@import`, absolutizes `url()`s and keeps
cascade order, insertRule-added rules get picked up, updates re-derive from
originals, and toggle-off restores mediaTexts verbatim). Screenshots go to
`$SHOT_DIR` (default: the OS temp dir).

## Icons

`tools/icon-source.png` is the master art — a square canvas holding a white
rounded card with the mark on it — kept in `tools/` rather than `icons/` so it
reads as build input rather than a shipped asset (nothing excludes it from a
zip; leave it out when packaging). Regenerate the four sizes with:

```sh
tools/make_icons.sh tools/icon-source.png
```

The card is what makes the icon legible on a dark toolbar as well as a light
one, and that matters because there is no declarative fix available: Chrome has
no manifest key for light/dark icon variants, and `chrome.action.setIcon` only
reaches the toolbar, never the `icons` used by `chrome://extensions` and the
Web Store. Swapping at runtime would also mean an offscreen document
(`MATCH_MEDIA` reason) just to reach `matchMedia` from the worker. A mark that
carries its own background sidesteps all of it.

Keep the canvas square. Chrome renders action icons in a square 16-DIP slot and
warns that a non-square image may be distorted, so a wider-than-tall drawing
has to be padded with transparent pixels — evenly, or the mark sits visibly
off-centre. `sips` cannot pad with transparency (`--padColor` takes an opaque
hex), so that step means compositing into a zero-filled RGBA buffer rather than
a one-liner.
