# Pillarbox — developer notes

Manifest V3, vanilla JS, no build step. Load the folder unpacked and reload it
from `chrome://extensions` after an edit. For what the extension does from a
user's point of view, see [README.md](README.md).

## Layout

```
manifest.json          extension wiring
background.js          service worker: icon click -> toggle message (+ inject fallback), zoom relay, cross-origin CSS fetch (private-network guarded)
shared/defaults.js     constants shared by all contexts
shared/css-relay.js    pure URL policy + CSS import traversal for the worker
shared/mq-shift.js     the width-shift text transform, loaded by BOTH worlds
content/squeeze.js     html-margin reflow + style watcher
content/media-queries.js  breakpoint shifter (width media features see the squeezed width)
content/match-media.js MAIN-world matchMedia hook (JS breakpoints see it too)
content/fixed-bars.js  escaping-element manager (fixed bars, vw-unit shells)
content/panels.js      shadow-DOM panels + drag handles
content/index.js       per-page state machine, storage, lifecycle
options/               options page
tools/make_icons.sh    regenerate icons/ from tools/icon-source.png (macOS sips)
tools/make_icons.ps1   the same, on Windows (System.Drawing)
test/                  test pages (page, mq, csp, appshell, vwshell, quirks) + end-to-end script
```

`shared/defaults.js` is loaded by every context — content scripts (first file
in the manifest list), the service worker (`importScripts`) and the options
page (`<script src>`). It uses `var` plus a guarded init so repeated evaluation
through `chrome.scripting.executeScript` is harmless.

## State

- `chrome.storage.sync['settings']` — `{theme, defaultLeft, defaultRight,
  colorLight, colorDark, showReadout, jsBreakpoints, rules}`. `jsBreakpoints`
  gates the MAIN-world matchMedia hook (absent means `true` — the same
  normalize-don't-migrate convention as the rule fields). `rules` is an
  ordered list of
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

Every way a side comes or goes takes the same 160 ms: the toolbar toggle
slides the panel in and out on `transform`, and the dblclick collapse and
restore, the reset, the both-collapsed revive and a record arriving from
another tab glide the `width`. Width rather than transform for those, because
collapsing by translating would carry the handle off the screen with the
panel and leave nothing to grab it back by. In every case the page reflows at
once and the panel moves over it — the margins are never animated, which
would mean reflowing the whole document each frame. The glide is opt-in per
change (`setWidths(..., {animate: true})`, and a `.gliding` class held for the
duration) because the continuous ones must not lag by even a frame: a drag has
to sit exactly under the pointer, and a resize or zoom re-clamp is a
correction, not a movement. `.dragging` overrides it either way, and
`prefers-reduced-motion` turns all of it off.

One glide happens *inside* a drag, and it is the far side's alone: a modifier
links it to the dragged side, so it jumps to match on the way in and returns
to the width it held when the key went down on the way out. Neither move is
tracking the pointer, so both animate — a `.glide` class on that one panel,
spelled specifically enough to outrank `.dragging`. The dragged panel is never
in it. While that class is on, the panel's own handle bar goes dark: a lit bar
carried across the screen points at an edge that has not arrived yet. That the
modifier is sampled on `pointermove` also decides an edge: letting the key go
without moving the pointer again leaves the sides linked until the next move,
which is the same way engaging has always worked.

**The link preview.** Resting on a handle with a modifier held lights the far
side's bar too, before any drag — the near one is lit by `:hover` already.
Hover alone can be read off `pointerenter`, but a key pressed while the
pointer sits still cannot, so this is the one thing the module listens for
outside its own shadow root: `keydown`/`keyup`/`blur` on `window`, captured
(a page that stops key propagation must not blind it), passive, never
prevented, and wired only while a handle is actually hovered. `blur` is not
optional — a modifier still down when the window loses focus never delivers
its keyup. The preview stands down for the length of a drag, where the
pointer handler owns both bars and pointer capture means the hover never ends
anyway; `finish()` hands the bar back on the way out.

**Fixed bars and app shells.** `position:fixed` boxes are laid out against the
viewport, and `position:absolute` boxes with no positioned ancestor (SPA app
shells like claude.ai's `absolute inset-0` root) are anchored to the initial
containing block — both ignore the html margins. Elements of either kind that
span ≥ 90% of the viewport and visibly escape the squeeze get inline
`left/right` insets to match. Neither kind may sit under a
transformed/filtered/contained ancestor — that re-anchors even fixed boxes —
and absolute ones additionally not under a merely positioned one; a box that
loses its anchoring later (an ancestor gaining a transform, or the box itself
swapping `fixed` for `absolute` the way scroll-docking headers do) is released
rather than squeezed twice. A `MutationObserver` catches bars added later or
turned fixed by a class change. Containing-block detection includes the
individual `translate`/`rotate`/`scale` properties, `backdrop-filter`,
`transform-style:preserve-3d`, `content-visibility` and container containment,
not just the older `transform`/`filter`/`perspective` shorthands. Because a
class on an *ancestor* can reveal a
bar without touching the bar itself (`body.scrolled .footer`), a mutated
element's subtree is also re-examined, coalesced on a 300 ms timer. It watches
`class`, `style` and `hidden` (clearing `hidden` reveals a bar without
producing any other mutation anywhere), but skips inline-`style` writes on
`<html>` — that is the squeeze's own every-frame write during a drag, and
acting on it queues the whole document for classification three times a
second. Flow adoptions are verified by re-measuring, with transitions
suppressed for the measurement: the margin and min-width overrides animate on
any header carrying `transition: all`, and a rect read mid-transition would
report the box as unfixable and blacklist it for the rest of the run. Everything
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
window instead keeps a desktop layout that no longer fits. While squeezed,
every width feature in every
reachable stylesheet is shifted by the panels' total width S: a breakpoint W
becomes `calc(W + Spx)` — the same shift for min/max/plain width and both
ends of range syntax, and calc() keeps em-unit breakpoints exact without
knowing the browser's px-per-em. `orientation:` and `aspect-ratio` — colon
form and MQ4 range form alike — cannot be shifted by a length, so they are
substituted with a constant (`min-height: 0px` / `min-height: 999999px` — height-based so the
width passes cannot re-match it) that holds for the effective viewport,
recomputed on resize. Edits go through the CSSOM (`MediaList.mediaText`,
whole-sheet `sheet.media` for `<link media>` gates — the DOM attribute is
never touched), which page CSP cannot block. Chrome normalizes what we write
(`calc(700px + 300px)` reads back `calc(1000px)`), so a registry keeps each
rule's original text: updates re-derive from the original (never re-shift
shifted text) and toggle-off restores verbatim.

Cross-origin sheets guard `cssRules` with a SecurityError, and content
scripts cannot fetch them either (page CORS applies) — the worker can (host
permission). That reach is the reason the relay carries a private-network
guard: the fetched body lands in a `<style>` clone inside the page's own DOM,
so without one, a page the extension is active on could name an address only
the browser's host can reach (a router page, a metadata endpoint) and read the
answer back out. Public pages may relay only HTTPS sheets (TLS is the DNS-
rebinding boundary a hostname check cannot provide); a private target is
allowed only from a private page on the same host, though ports may differ for
localhost development. `sender.origin` is set by the browser, not the page.
Redirects and non-`text/css` responses are rejected, and bodies are streamed
under the shared byte budget rather than buffered before the limit. Opaque
sheets are fetched there, `@import` chains inlined
(depth 3, active-path cycle- and byte-capped, repeated imports preserved at
each cascade location, conditions rewritten as equivalent
`@layer`/`@supports`/`@media` wrappers) and `url()`s absolutized against the
sheet's own URL (a clone parses at the document base). The text is replayed
in a `<style>` clone inserted at the owner `<link>` — content-script-
inserted `<style>` bypasses page CSP (Chrome behaviour rather than documented
contract, which is why the CSP e2e pins it), and the position keeps cascade
order, which `document.adoptedStyleSheets` would not (adopted sheets sort
after every document sheet and would beat later overrides). The clone element
goes in EMPTY and synchronously, during the walk, and is filled when the
fetch lands: several cross-origin `@import`s of one readable sheet share an
anchor, so inserting on completion would order them by download speed and
invert the cascade between them. An `@import`'s own `layer()`/`supports()`
conditions are wrapped around the clone's text (the media condition rides its
`media` attribute) — dropping them would float the rules out of their cascade
layer, where unlayered beats layered. A sheet already disabled by the page is
never cloned. Otherwise the original is turned off via
`sheet.disabled` — the CSSOM flag, NOT `link.disabled`, whose attribute
round-trip re-fetches the sheet asynchronously and leaves the page unstyled
for a moment on restore — and only once the clone actually holds its text.
Upkeep drops a clone when its anchor leaves the document OR stops owning the
sheet we cloned (an `href` swap mints a new `CSSStyleSheet`; `link.disabled`
detaches it), and it runs even at shift 0, where the clones are deliberately
kept alive and a `<link>` removal would otherwise leave the page wearing a
stylesheet it had just unloaded. Sheets added later are caught by a childList
observer; rules added through `insertRule` (styled-components) and direct
`mediaText` assignments mutate no DOM node, so a 2s full rule walk covers
nested insertions and unchanged top-level counts too. Each registry entry
remembers the exact normalized text Pillarbox last wrote; a different live
value is rebased as page-owned and survives later drags and toggle-off. A
media flip can restyle a bar without touching any attribute — invisible to the fixed-bar
observer — so every shift application nudges `fixedBars.update()`, whose
debounced rescan re-adopts whatever the new layout revealed. Printing runs
`stop()` first: print media evaluates width against the paper size, and a
shifted breakpoint would corrupt the printout.

**JavaScript breakpoints.** Stylesheets are only half of how sites read the
viewport: apps also ask `window.matchMedia` — YouTube's entire layout
switching (`ytd-watch-flexy`'s two-column flag, the masthead, all of it)
hangs off Polymer `iron-media-query` elements wrapping exactly that call,
which is why YouTube used to keep its desktop layout under any squeeze. No
isolated-world edit can change what `matchMedia` reports, so a second
manifest entry runs `shared/mq-shift.js` + `content/match-media.js` in the
**MAIN world** at `document_start` on every page (`minimum_chrome_version`
111 for manifest `world`). The wrapper returns the *genuine* native
`MediaQueryList` — `instanceof`, `.media` text and every listener API stay
native — and keeps a WeakRef ledger of each width-flavored list it hands
out. While squeezed, every ledger entry gets a hidden **shadow list** for
the shifted query text: the patched prototype `matches` getters (list and
event) answer from the shadow, a shadow flip dispatches a synthetic change
event on the page's list (`dispatchEvent` reaches `addEventListener`,
`onchange` and legacy `addListener` alike — the last one is what
`iron-media-query` uses), and native events still firing at the un-shifted
thresholds carry corrected values through the same event getter. Shadows are
native lists, so window resizes fire them without any relay of ours — and
because a native `MediaQueryList` carrying a listener lives as long as the
document, they are also held in a strong, iterable set beside the WeakMap and
released through a `FinalizationRegistry` when their page list is collected.
Without that, the everyday one-shot idiom
(`matchMedia('(max-width: 768px)').matches` inside a helper) would strand a
shadow per call for the whole squeezed session.

At shift 0 the getters pass through and no shadow — and so no listener of
ours on any page object — exists. What is installed unconditionally on every
page is five patches: the wrapped `matchMedia`, the two `matches` accessors,
the two width-metric accessors, and one window listener for the announcement
event. Their behaviour at rest is native to the value; a page that looks can
still tell they were replaced, so the injection marker is deliberately not
named after the extension.

The two worlds share one transform: `shared/mq-shift.js` is loaded by both
manifest entries and hangs off its own deletable global (`var` would be
undeletable; SQZ could collide with page code) which `match-media.js`
consumes and deletes before any page script runs. Note that the CSP
exemptions the isolated world enjoys do NOT extend here — the docs are
explicit that a main-world content script runs under the page's CSP — so this
file stays CSP-neutral by construction: native calls and `defineProperty`
only, no `eval`, no injected nodes. The isolated side
announces the shift total over a `pillarbox-mq-shift` CustomEvent with a
primitive detail (primitives cross worlds), in the same coalesced flush as
the CSS edits so both flip together; a same-value re-announcement after a
resize re-bakes the orientation/aspect substitutions. Print suspension and
toggle-off announce 0. Each shift CHANGE additionally dispatches synthetic
window `resize` events — matchMedia covers the sites that ask breakpoint
questions, the pokes cover the ones that re-measure in resize handlers.
Natively these breakpoints can only ever flip DURING a real resize, a
stream of events that outlasts every late relayout, so app pipelines
legitimately lean on "another resize will come": YouTube narrows its watch
column from a low-priority job seconds after the flip, and only the next
resize re-centers the `<video>` (verified live; a poke alone repairs it).
The hook honors that contract: poke immediately, then for a ~10s watch
window re-check a cheap geometry fingerprint every 500ms, poking again
whenever the page moved since the last look. Two hard-won constraints,
both found on YouTube: the cadence must exceed fixed-bars' 300ms rescan
debounce, which every poke re-arms through the isolated world's own resize
listener (a faster stream postpones the very shell adoption it waits for),
and the fingerprint's WIDTH must come from `<body>` — the root element's
client/scroll widths are viewport-based and blind to content narrowing back
inside the margins; the root's `scrollHeight` rides along beside the body's
scroll metrics as the quickest signal that a relayout has actually landed. Same-S re-announcements never poke:
they follow a real resize the page already heard. The hook is page-lifetime and survives extension
reloads — the stale-artifact pass announces an explicit 0 in case the
orphaned world never wakes to do it itself. The toolbar-click fallback
injects the pair (`world: 'MAIN'`) before the isolated files so the first
announcement finds a listener, but that late injection cannot retrofit
lists the page already minted through the native `matchMedia` — such tabs
reflow fully only after their next reload. Gated by the `jsBreakpoints`
setting (default on; `mediaQueries.setJsHooks` flips it live).

While squeezed, the width METRICS lie as well: `window.innerWidth` and the
viewport `clientWidth` answer minus the shift. Breakpoint questions turned
out not to be enough — sizing math measures the viewport in px, and YouTube
does it the Closure-library way (`goog.dom.getViewportSize`; verified live —
the watch player takes its dimensions from a cached size of exactly those
metrics, so after the single-column flip it froze at the size computed for
the real window, and spoofing `innerWidth` alone changed nothing). Both
metrics shift by the same amount, so scrollbar arithmetic
(`innerWidth - clientWidth`) stays exact.

WHICH element's `clientWidth` means the viewport is mode-dependent (CSSOM
View): the root in standards mode, `<body>` in quirks — where the root
reports its own padding box, which the squeeze margins have ALREADY narrowed,
so lying there too would subtract the shift twice (`SQZ.viewportWidth()`
draws the same distinction on the isolated side, and `test/quirks.html` pins
it). The lie is therefore an own property on whichever element currently
carries that meaning, re-verified on every shift application because an own
property does not survive its element being replaced — `document.write()` and
`replaceChild` both do that, and in quirks `<body>` may not exist yet at
`document_start`. The getter re-checks per read as well, so a mode flip
cannot leave it lying about a padding box, and it is installed
non-enumerable so `Object.keys()` on the element still reads native. Every
other element keeps the untouched prototype getter. The isolated world has
its own bindings and always sees native values — the extension's clamp
math depends on that — and the e2e SNAPs derive layout width from the html
box + margins for the same reason. Residual honesty, by design: heights,
`visualViewport`, `screen.*` and `outerWidth` keep telling the truth
(physical/window facts, matching `device-width` staying unshifted in the
query transform); synthetic events are `isTrusted: false`; a listener that
ignores every matches value and blindly toggles state reacts to the
redundant native-threshold events.

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
construction. (The rAF-before-paint ordering is spec'd; that the dpr getter has
already moved when `resize` fires is observed Chrome behaviour, not a
documented guarantee — the e2e's "correct in the first zoomed frame" check is
what pins it, and a misprediction is corrected by the worker anyway.) The service worker then merely confirms (`tabs.getZoom` on
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
and `options.js` seeds the record on first visit. Its `<script>` list must
include `shared/mq-shift.js` (media-queries.js depends on it) but must NOT
include `content/match-media.js`: an extension page has no isolated/main
world split, so the width-metric lie would feed straight back into the
extension's own clamp math. The e2e's "options page runs its own live
pillars" check is the canary for this list drifting.

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
- The breakpoint shifter reaches stylesheets, `window.matchMedia` and the two
  width metrics — `window.innerWidth` plus the `clientWidth` of whichever
  element means the viewport in this document's mode (the MAIN-world hook) —
  but heights, `visualViewport`, `screen.*` and `outerWidth` stay honest, so a
  script measuring through those sees the real viewport.
  `<picture>`/`srcset` selection also keeps using the real viewport — images
  may load a size larger than the column they land in, which is cosmetic.
- Tabs that predate the extension load get the matchMedia hook only through
  the toolbar-click injection — too late to retrofit lists their scripts
  already made. Those pages reflow fully after their next reload.
- Stylesheets inside shadow roots are not shifted (web-components sites).
- A private-address stylesheet keeps its native breakpoints unless the page is
  itself on that exact private host. Public-page cross-origin sheets must use
  HTTPS; refused sheets remain styled natively but their breakpoints cannot be
  shifted.
- The settings object lives in one `chrome.storage.sync` item, capped at 8 KB.
  A rules list that would exceed it is refused with a message rather than
  silently dropped.
- A cross-origin sheet already disabled by the page stays disabled and is
  never cloned. While an enabled sheet is being stood in for by a clone, our
  `sheet.disabled` is indistinguishable from the page's own: a script that
  turns that stylesheet off through the CSSOM sees nothing change (the clone
  keeps styling) and reads the flag back already true. Inherent to the
  disable-and-clone design.
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
move inward, sticky reflows, the FAB stays put, late, morphing,
hidden-attribute and scroll-dock bars all behave, the 1000px-breakpoint strip
turns green/NARROW, print preview is clean (and un-triggers the breakpoint).

```sh
python3 -m http.server 8080 --directory test
open http://localhost:8080/page.html     # Windows: start http://localhost:8080/page.html
```

Automated checks need Node ≥ 22. Install the development dependencies once;
`npm run check` runs ESLint plus the fast pure-function regressions. The full
suite additionally needs Chrome for Testing — branded Chrome ≥ 137 ignores
`--load-extension`:

```sh
npm install
npm run check
npx @puppeteer/browsers install chrome@stable --path .cft   # once, ~150 MB
npm test
```

The browser commands are the same on macOS, Linux and Windows: `findChrome()` probes
every Chrome-for-Testing platform layout under `.cft` and falls back to a
locally installed **Chromium** (never branded Chrome, which would run the
suite extensionless and fail everything for the wrong reason). Point it
somewhere else with `--chrome <path>` or `CHROME_BIN`.

Every assertion is reported, never thrown: a check whose condition IS a wait
uses `checkFor()`, which polls until the condition holds and otherwise records
a FAIL and carries on, and a precondition with no assertion of its own uses
`waitFor()`, which announces giving up with a `NOTE` line. So one regression
costs one FAIL (plus whatever genuinely cascades from it, each visible) rather
than aborting the process and hiding every later result. Only the two
pre-flight waits — the devtools endpoint and finding the extension's service
worker — still throw, because nothing can run without them.

The script launches and removes a throwaway headless profile, toggles via the real message
path, and asserts reflow, fixed-bar insetting (including a percentage
`min-width`, a bar revealed by clearing `hidden`, and a scroll-dock bar
released when it swaps `fixed` for `absolute`), per-page auto-restore after
reload, an LRU prune leaving an active page's pillars alone, zoom-stable
widths (correct in the first zoomed frame, hint
persistence, zoomed page load), per-URL rules (first-enable widths, rule-aware
reset, `autoShow` opening a recordless page on load and on an in-page
navigation, an explicit off outranking the rule — asserted over a window, not
sampled once — options editor round-trip),
live settings flips, theming, the print suspend/resume cycle, a
back-navigation return, quirks-mode width metrics (`test/quirks.html`: the
root must NOT be shifted a second time),
survival of a `style-src 'none'` CSP, and breakpoint shifting (a shiftText
unit battery plus `test/mq.html` against a second, cross-origin CSS server:
inline/nested/range/em breakpoints flip, orientation goes portrait, a
`<link media>` gate re-evaluates without touching the attribute, sibling
cross-origin imports keep document order against a deliberately slow one, a
layered import's clone stays inside its cascade layer, the
cross-origin clone inlines its `@import`, preserves repeated imports,
absolutizes `url()`s and keeps cascade order, disabled sheets stay inert,
redirect/non-CSS relay responses are refused, top-level and nested
insertRule-added rules get picked up, page-written mediaTexts are rebased,
updates re-derive from originals, and toggle-off restores the latest page
text verbatim), and the MAIN-world
matchMedia hook (page-held lists minted before the squeeze flip through
addListener/onchange/addEventListener with the original media text intact,
lists minted mid-squeeze are born shifted, orientation tracks the effective
viewport, the width metrics lie by exactly the shift, the resize poke keeps
following the page while its geometry moves, the jsBreakpoints kill switch
un-lies matchMedia live while the CSS shift stays, and toggle-off goes fully
native). Screenshots go to
`$SHOT_DIR` (default: the OS temp dir).

## Icons

`tools/icon-source.png` is the master art — a square canvas holding a white
rounded card with the mark on it — kept in `tools/` rather than `icons/` so it
reads as build input rather than a shipped asset (nothing excludes it from a
zip; leave it out when packaging). Regenerate the four sizes with:

```sh
tools/make_icons.sh tools/icon-source.png              # macOS (sips)
powershell -ExecutionPolicy Bypass -File tools\make_icons.ps1 tools\icon-source.png   # Windows
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
a one-liner. Neither script pads — padding belongs to the master art; the
PowerShell one at least warns when handed a non-square source.
