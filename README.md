# Pillarbox

A Chrome extension that squeezes a page's content left/right/inward using two resizable sidebars.

(Video)

## Install From Source

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the icon, then click it on any page.

## Gestures

(Video)

| To do this | Do that |
| --- | --- |
| Turn the sidebars on or off | Click the toolbar icon, or press your custom shortcut |
| Resize one side | Drag the sidebar edge |
| Resize both sides at once     | Hold any modifier key (⇧ ⌃ ⌥ ⌘) and drag              |
| Collapse one side | Double-click it |
| Bring a collapsed side back | Drag from the page edge or double-click the edge |
| Return to your default widths | Hold a modifier and double-click a sidebar |
|  |  |





## What it remembers

Each page — the exact URL, ignoring `#anchors` — remembers whether the
sidebars are on and how wide they are, and restores that on every reload and
future visit until you toggle it off. Nothing to save; it just sticks.

Sidebar widths are also zoom-stable: a sidebar stays the same size on screen
at any zoom level, so zooming resizes the page's text, not your pillars.

## Options

Right-click the icon → **Options**. You can set the default widths, the theme
(Auto / Light / Dark) and the sidebar colors, turn on a pixel readout while
dragging, decide whether squeezing **triggers site breakpoints** (on by
default: pages adapt as if the window shrank), and change the keyboard
shortcut.

You can also write **per-URL rules**: a URL pattern gets its own default
widths, which apply the first time you enable that page and whenever you reset
it. Click a rule's **MATCH BY** cell to choose how its pattern is compared —
**substring**, where you can paste a URL straight out of the address bar, or
**regex** for anything cleverer. Three ship out of the box (nature.com
articles, zhihu questions, YouTube watch pages) and are ordinary rules — edit
or delete them freely.

**NEW PAGE BEHAVIOR** decides what a matching page does on its own. Leave it on
**DO NOTHING** and the page waits for you to open it; switch it to **SHOW
PILLARS** and every matching page you have not touched yet opens with its
pillars already in place, at that rule's widths. "Not touched yet" is the whole
of it — the moment you resize or toggle a page, that page remembers its own
answer and the rule stops deciding for it. Turning the pillars off on a page
sticks, rule or no rule.

The shipped zhihu rule comes set to **SHOW PILLARS**, so zhihu question pages
open squeezed out of the box; the other two ship on **DO NOTHING**. Switch it
off — or delete the rule — if you would rather nothing opened by itself.

## Good to know

- Sites adapt to the squeeze: their responsive breakpoints see the narrowed
  width, so a page reflows into the same layout it would use in a window of
  that size instead of overflowing. Prefer the untouched desktop layout,
  just narrower? Turn **trigger site breakpoints** off in Options. Either
  way, a page with a hard minimum width shows a horizontal scrollbar.
- Wide, unbreakable content (code blocks, wide tables) can still run under a
  sidebar, and apps that lay themselves out from JavaScript may ignore the
  squeeze entirely.
- Small fixed elements — chat buttons, side drawers — are left where they are
  and may sit partly under a sidebar.
- Fullscreen video is unaffected, and printing temporarily un-squeezes the page
  so printouts come out clean.
- Running on `file://` pages needs "Allow access to file URLs" in
  `chrome://extensions`.

## Development

See **[DEVELOPERS.md](DEVELOPERS.md)** for the architecture, how the squeeze is
actually implemented, the storage schema, and how to run the tests.
