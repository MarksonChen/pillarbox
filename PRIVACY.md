# Privacy Policy for Pillarbox

**Last updated: August 10, 2026**

Pillarbox does not collect, transmit, or sell your data. There is no server,
no account, no analytics, and no telemetry. The developer never receives
anything from your browser.

That is the whole policy. The rest of this document explains what the
extension stores on your own machine and the one kind of network request it
makes, so you can verify the claim rather than take it on faith.

## What Pillarbox stores

Everything below is stored by your browser, on your computer, using the
extension storage API. None of it is sent anywhere by Pillarbox.

**Your settings** (`chrome.storage.sync`) — the theme, default sidebar widths,
sidebar colors, whether the pixel readout appears while dragging, whether
JavaScript breakpoints see the squeeze, and any per-URL rules you create.
Per-URL rules contain the URL patterns *you type*, so if you write a rule for
a site, that pattern is part of your settings.

**Per-page memory** (`chrome.storage.local`) — for each page where you have
turned the sidebars on, Pillarbox remembers whether they are on and how wide
they are. The record is keyed by the page's address without the `#fragment`
(scheme, host, path, and query string). This is what makes a page come back
the way you left it. Pages you never touch are never recorded. The list is
capped at 1000 pages; beyond that, the least recently used records are
deleted automatically.

**Zoom hints** (`chrome.storage.local`) — for sites you view at a zoom level
other than 100%, Pillarbox stores the zoom factor for that site's origin so
the sidebars are the right size the instant the page loads instead of
correcting themselves a moment later. Nothing is stored for sites at 100%.

### A note on browser sync

Your settings are stored with `chrome.storage.sync`, which means your browser
will replicate them to your other signed-in browsers using your browser
account — your Google Account in Chrome, or the equivalent account if you are
running another Chromium-based browser. That transfer is performed by the
browser, not by Pillarbox, and is governed by your browser vendor's privacy
policy. The developer has no access to it and no way to read it.

Per-page memory and zoom hints use local storage and never sync.

## The one network request Pillarbox makes

Pillarbox has to read a page's stylesheets to find the width breakpoints it
needs to shift. When a stylesheet is served from a different origin than the
page, the browser's security rules hide its contents from the extension. In
that case, and only in that case, Pillarbox's background worker fetches that
same stylesheet — the one the page you are visiting already loaded — so it can
read the breakpoints.

This request is deliberately narrow:

- It goes only to a URL the page itself references in a `<link>` or `@import`.
  Pillarbox never invents a destination.
- It is sent with **`credentials: 'omit'`** — no cookies, no authorization
  headers, nothing that identifies you. The server sees an anonymous request.
- On ordinary web pages, only `https:` URLs are fetched.
- Only responses with a `text/css` content type are accepted; anything else is
  discarded unread.
- Responses are size-limited and time-limited.
- If the page you are on is on a private network or `localhost`, Pillarbox will
  only fetch from that same host, so a public web page can never use the
  extension to reach into your local network.

The fetched stylesheet text stays in the page you are viewing. It is not
stored, not logged, and not sent anywhere else.

No other network requests are made. Pillarbox has no update server, no
configuration endpoint, and no error reporting.

## Permissions, and why each one exists

- **`storage`** — to save the settings and per-page memory described above.
- **`scripting`** — so that tabs already open when you install or update the
  extension can be given the sidebars without you reloading them.
- **Access to all websites** — the sidebars work on whatever page you are
  looking at, so the extension cannot know in advance which sites it needs.
  This access is used only to resize and restyle the page you are on. Pillarbox
  does not read your page's text, forms, passwords, or browsing history.

## Deleting your data

Uninstalling Pillarbox deletes everything it stored — settings, per-page
memory, and zoom hints. Nothing survives the uninstall, because nothing was
ever kept anywhere but your own browser.

Two smaller points, stated plainly rather than glossed over: turning the
sidebars off on a page updates that page's record to "off" rather than
erasing the entry, and per-page records are removed automatically only when
the 1000-page cap prunes the least recently used ones. There is currently no
button that clears the whole per-page history in one go.

## Changes

If this policy ever changes, the updated version will be published in this
file and the date at the top will change.

## Contact

Questions or concerns: open an issue at
<https://github.com/MarksonChen/pillarbox/issues>.
