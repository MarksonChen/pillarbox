# Pillarbox

A Chrome extension that squeezes a page's content inward between two empty,
resizable sidebars — for sites that put their text hard-left, hard-right, or
stretched across the whole window.

The page genuinely **reflows** into the narrower column. The sidebars are not
an overlay sitting on top of the text.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the icon, then click it on any page.

## Use

| To do this | Do that |
| --- | --- |
| Turn the sidebars on or off | Click the toolbar icon, or press `Alt+Shift+S` |
| Resize one side | Drag its inner edge |
| Resize both at once | Hold any modifier key (⇧ ⌃ ⌥ ⌘) and drag |
| Collapse one side | Double-click it |
| Bring a collapsed side back | Double-click its sliver at the screen edge |
| Return to your default widths | Hold a modifier and double-click a sidebar |

One sidebar can go past the middle when the other is narrow. The only limit is
that 200px of page always stays visible between them.

## What it remembers

Each page — the exact URL, ignoring `#anchors` — remembers whether the
sidebars are on and how wide they are, and restores that on every reload and
future visit until you toggle it off. Nothing to save; it just sticks.

Sidebar widths are also zoom-stable: a sidebar stays the same size on screen
at any zoom level, so zooming resizes the page's text, not your pillars.

## Options

Right-click the icon → **Options**. You can set the default widths, the theme
(Auto / Light / Dark) and the sidebar colors, turn on a pixel readout while
dragging, and change the keyboard shortcut.

You can also write **per-URL rules**: a URL pattern gets its own default
widths, which apply the first time you enable that page and whenever you reset
it. Three ship out of the box (nature.com articles, zhihu questions, YouTube
watch pages) and are ordinary rules — edit or delete them freely.

## Good to know

- The site keeps its desktop layout, just narrower — that is the point. A page
  with a hard minimum width will show a horizontal scrollbar instead.
- Wide, unbreakable content (code blocks, wide tables) can still run under a
  sidebar.
- Small fixed elements — chat buttons, side drawers — are left where they are
  and may sit partly under a sidebar.
- Fullscreen video is unaffected, and printing temporarily un-squeezes the page
  so printouts come out clean.
- Running on `file://` pages needs "Allow access to file URLs" in
  `chrome://extensions`.

## Development

See **[DEVELOPERS.md](DEVELOPERS.md)** for the architecture, how the squeeze is
actually implemented, the storage schema, and how to run the tests.
