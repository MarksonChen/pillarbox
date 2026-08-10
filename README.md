<h1 align="center">Pillarbox</h1>

<p align="center">A Chrome extension that squeezes a page's content left/right/inward using two resizable sidebars.</p>


<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/MarksonChen/pillarbox" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependencies">
</p>

<img src="assets/left_right_inward.gif" alt="Dragging, centering, collapsing, and restoring the Pillarbox sidebars" width="1000">

## Gestures

<img src="assets/gestures.gif" alt="Gestures to control the sidebars" width="1000">

| To do this                            | Try                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Turn the sidebars on or off           | **Click** the toolbar icon, or **press** `Alt+Shift+S` (rebind it at `chrome://extensions/shortcuts`) |
| Resize one side                       | **Drag** the sidebar edge                                                                        |
| Center the page and resize both sides | **Hold** any modifier key (Shift, Ctrl, Alt or ⌘) and **drag**                                      |
| Collapse one side                     | **Double-click** it                                                                              |
| Bring a collapsed side back           | **Drag** from the page edge or double-click the edge                                             |
| Bring both collapsed sides back       | **Click** the toolbar icon                                                                       |
| Return to your default widths         | **Hold** any modifier key and **double-click** a sidebar                                             |

## Install From Source

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Pin the icon, then click it on any page.

## Good to know

> [!NOTE]
> Each page remembers itself — the exact URL, `#anchors` ignored. Whether the
> sidebars are on and how wide they are comes back on every visit until you
> toggle it off. The oldest records fall away past a thousand pages.

> [!NOTE]
> Widths are zoom-stable: a sidebar keeps its size on screen at any zoom, so
> zooming resizes the page's text, not your pillars.

> [!NOTE]
> Settings follow your Chrome profile to your other machines; what each page
> remembers stays local. The same page open in two tabs keeps in step.

> [!TIP]
> Right-click the icon → **Options** for the default widths, the theme, the
> sidebar colors, a pixel readout while dragging, and the shortcut. **SHIFT
> JAVASCRIPT BREAKPOINTS** is what makes YouTube-style apps reshape under the
> squeeze — leave it on unless a site's scripts misbehave.

> [!TIP]
> **Per-URL rules** give a pattern its own default widths. **MATCH BY** picks
> how it is compared: **substring**, where a URL pasted from the address bar
> just works, or **regex**. Three ship out of the box as ordinary rules — edit
> or delete them freely.

> [!TIP]
> A rule's **NEW PAGE BEHAVIOR** can open pages by itself: **SHOW PILLARS**
> squeezes every matching page you have not touched yet (the shipped zhihu rule
> works this way). Resize or toggle a page once and its own answer wins for good.

> [!NOTE]
> Sites reflow into the layout they would use in a window that narrow — media
> queries, `matchMedia` and the widths scripts measure all see the squeeze. A
> page with a hard minimum width gets a horizontal scrollbar instead.

> [!WARNING]
> Some things escape: unbreakable content (code blocks, wide tables), small
> fixed elements like chat buttons, bars centered by hand rather than by layout,
> breakpoints inside web components, and cross-origin stylesheets served over
> plain HTTP. Heights and screen size stay honest.

> [!WARNING]
> Only the top frame is squeezed — fixed elements inside an iframe are left
> alone. Tabs already open when you install or update the extension still
> toggle, but reshape fully only after a reload.

> [!NOTE]
> Fullscreen video is unaffected, and printing temporarily un-squeezes the page
> so printouts come out clean.

> [!WARNING]
> `chrome://` pages, the Web Store and the PDF viewer are Chrome's own — the
> icon flashes a red ✕ there. `file://` pages need "Allow access to file URLs"
> in `chrome://extensions`.

## Development

See **[DEVELOPERS.md](DEVELOPERS.md)** for the architecture, how the squeeze is
actually implemented, the storage schema, and how to run the tests.

