// Makes the page's width breakpoints see the squeezed width. The margin
// squeeze narrows the content, but media queries keep evaluating against the
// full window — so a site that would switch to its narrow layout in a
// smaller window instead keeps a desktop layout that no longer fits
// (overflowing grids, elements running under the panels). Every width
// feature in every reachable stylesheet is therefore shifted by the panels'
// total width S: `(max-width: W)` matches when V <= W, and we want the
// effective width V - S compared instead, so the breakpoint becomes
// `(max-width: calc(W + Spx))` — the same shift for min-width, exact width
// and both ends of range syntax, wrapped in calc() so em/rem breakpoints
// keep their unit (the browser resolves them against its own default font
// size, which we never need to know). orientation: and aspect-ratio:
// features cannot be shifted by a length, so they are substituted with a
// constant that holds for the effective viewport and recomputed on resize.
//
// Edits are CSSOM-only (mediaText, StyleSheet.disabled), which page CSP
// cannot block and DOM observers cannot see. Chrome normalizes what we
// write (`calc(700px + 300px)` reads back as `calc(1000px)`), so originals
// are kept in a registry and every re-shift starts from the saved text. The
// registry also remembers the normalized value we last wrote: if the page
// changes mediaText while squeezed, that new text becomes the next original
// instead of being overwritten by our stale snapshot.
//
// Cross-origin sheets guard cssRules with a SecurityError, and a content
// script cannot fetch them either (page CORS applies) — the worker can
// (host permission), so opaque sheets are fetched there (@imports inlined,
// url()s absolutized against the sheet URL) and replayed in a <style>
// clone inserted right at the owner <link>, keeping cascade order; the
// original sheet is turned off via sheet.disabled — the CSSOM flag, NOT
// link.disabled, whose attribute round-trip re-fetches the sheet
// asynchronously and would leave the page unstyled for a frame on restore.
// Sheets that are already disabled are never cloned. One consequence remains
// inherent while a live clone stands in: our disable is indistinguishable
// from the page's own, so a script that turns that sheet off through the
// CSSOM sees nothing change (the clone keeps styling).
//
// Stylesheets are only half of it: sites also ask window.matchMedia from
// JavaScript (YouTube's layout does). The MAIN-world hook in match-media.js
// covers those; this file merely announces the shift to it (see announce),
// in the same coalesced flush as the CSS edits so both flip together.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.mediaQueries ??= (() => {
  const RESCAN_MS = 2000;    // page-driven CSSOM edits have no mutation event;
                             // a periodic rule walk is the only general signal
  const COALESCE_MS = 150;   // trailing debounce for drag-driven updates
  // Marker attribute on every clone, so a later life of this content script
  // (extension reload) can find stale clones and re-enable their originals.
  const COPY_ATTR = 'data-pillarbox-mq';
  const DISABLED_ATTR = 'data-pillarbox-mq-disabled';
  // Written on the element whose sheet we turned off, not on the clone, so a
  // world that dies before restoring can be undone by element identity
  // instead of by href — two <link>s can share a URL while the page has
  // disabled exactly one of them for its own reasons.
  const OFF_ATTR = 'data-pillarbox-mq-off';
  // Stamped on every clone this build writes. Its ABSENCE is the signal that
  // matters: a clone without it comes from a life that predates OFF_ATTR and
  // always disabled whatever it shadowed, so index.js knows to fall back
  // rather than leaving that sheet dark forever.
  const CLONE_VERSION_ATTR = 'data-pillarbox-mq-v';

  let shift = null;          // left + right while running, else null
  let onApply = null;        // host callback: "match states may have moved"
  let epoch = 0;             // bumped by start/stop; stale async fetches bail
  const edited = new Map();  // MediaList -> {orig, written, sheet, top}; top is
                             // the sheet the rescan prune asks about reachability
  const copies = new Map();  // original sheet -> clone ownership/state; the
                             // entry lands synchronously before its fetch
  let failed = new Set();    // hrefs the worker could not fetch (this run)
  const textCache = new Map(); // href -> inlined text; survives stop() so a
                             // print cycle or toggle doesn't refetch anything
  let observer = null;
  let rescanTimer = 0;
  let pendTimer = 0;
  let pendWidths = null;
  let lastEnvKey = '';       // viewport fingerprint for the env substitutions
  let jsHooks = false;       // announce shifts to the MAIN-world hook?
  let announced = 0;         // last value announced (0 = the hook is inert)

  // --- media-text shifting -----------------------------------------------
  // The transform lives in shared/mq-shift.js — one implementation for this
  // file and for the MAIN-world matchMedia hook (content/match-media.js).
  const XF = globalThis.__pillarboxMqShift;
  const RX_ANY = XF.ANY;
  const shiftText = (text, s) => XF.shiftMediaText(text, s, innerWidth, innerHeight);

  // The env substitutions bake in the viewport, so a resize can move their
  // verdict even when S is unchanged; this key says "same viewport".
  const envKey = () => innerWidth + 'x' + innerHeight;

  // --- registry ----------------------------------------------------------
  // The sheet whose ownerNode says whether a registry entry is still
  // reachable: an imported sheet has none of its own (it hangs off ownerRule),
  // so keying the prune on the sheet we happened to walk would make every
  // entry inside an @import chain immortal.
  function topSheet(sheet) {
    let s = sheet;
    while (s && !s.ownerNode && s.parentStyleSheet) s = s.parentStyleSheet;
    return s;
  }

  function applyEdit(ml, entry, amount) {
    let current;
    try { current = ml.mediaText; } catch {
      edited.delete(ml);
      return false;
    }
    // Anything other than our exact last normalized write belongs to the
    // page. Rebase immediately so a later drag or stop cannot erase it.
    if (current !== entry.written) entry.orig = current;
    if (!entry.orig || !RX_ANY.test(entry.orig)) {
      edited.delete(ml);
      return false;
    }
    const next = shiftText(entry.orig, amount);
    if (next === entry.orig) {
      edited.delete(ml);
      return false;
    }
    // Steady state: the live value is exactly what our last assignment
    // normalized to, and that assignment was this very text. Testing the
    // generated text against `current` alone can never match — Chrome
    // collapses `calc(700px + 600px)` to `calc(1300px)` on the way in — so
    // the raw text assigned is remembered beside the normalized read-back.
    // Without both halves this guard never fired and the 2s rescan rewrote
    // every registered rule forever, each write forcing a style recalc.
    if (current === entry.written && next === entry.applied) return false;
    try {
      ml.mediaText = next;
      entry.applied = next;
      entry.written = ml.mediaText; // Chrome normalizes the assigned text
      return entry.written !== current;
    } catch {
      edited.delete(ml);
      return false;
    }
  }

  function maybeEdit(ml, sheet) {
    if (!ml || !shift) return false;
    const known = edited.get(ml);
    if (known) return applyEdit(ml, known, shift);
    let orig;
    try { orig = ml.mediaText; } catch { return false; }
    if (!orig || !RX_ANY.test(orig)) return false;
    const entry = { orig, written: orig, applied: null, sheet, top: topSheet(sheet) };
    edited.set(ml, entry);
    return applyEdit(ml, entry, shift);
  }

  function restoreEdits() {
    for (const [ml, entry] of edited) {
      try {
        // An edit made after our last scan is page-owned too. Leave it alone
        // rather than restoring an older value over the top of it.
        if (ml.mediaText === entry.written) ml.mediaText = entry.orig;
      } catch {}
    }
    edited.clear();
  }

  // --- walking -----------------------------------------------------------
  function walkRules(rules, sheet) {
    let changed = false;
    for (const rule of rules) {
      if (rule instanceof CSSImportRule) {
        // The import's own condition list is readable and settable even when
        // the imported sheet is cross-origin.
        changed = maybeEdit(rule.media, sheet) || changed;
        let inner = null;
        try { inner = rule.styleSheet; } catch {}
        if (inner) changed = walkSheet(inner) || changed;
      } else {
        if (rule instanceof CSSMediaRule) changed = maybeEdit(rule.media, sheet) || changed;
        // Generic recursion reaches @supports, @layer, @container, @scope
        // and nested CSS (`.sel { @media ... }` puts cssRules on style rules).
        let kids = null;
        try { kids = rule.cssRules; } catch {}
        if (kids && kids.length) changed = walkRules(kids, sheet) || changed;
      }
    }
    return changed;
  }

  function walkSheet(sheet) {
    // A disabled alternate/theme sheet remains in document.styleSheets. Its
    // media text is still worth shifting: a disabled sheet paints nothing, so
    // editing it changes no pixel, the same ownership bookkeeping restores
    // it, and the moment the page enables the sheet it is already correct
    // rather than a rescan behind. Enabling is a pure CSSOM change that fires
    // no mutation record, so "a rescan behind" means up to two seconds of
    // desktop-width layout inside the squeeze on every theme toggle.
    // What must not happen is CLONING it — adoptOpaque activates its clone,
    // and teardown would lose the page's own disabled state.
    let disabled = false;
    try { disabled = !!sheet.disabled; } catch { return false; }
    // Whole-sheet gating (<link media>/<style media>): sheet.media is
    // readable and settable even on opaque sheets, and editing it leaves
    // the DOM attribute alone (verified: the attribute keeps its value).
    let changed = maybeEdit(sheet.media, sheet);
    let rules = null;
    try { rules = sheet.cssRules; } catch {} // SecurityError: cross-origin
    if (rules) {
      changed = walkRules(rules, sheet) || changed;
    } else if (!disabled) {
      adoptOpaque(sheet);
    }
    return changed;
  }

  function scanAll() {
    let changed = false;
    // document.styleSheets misses constructed sheets the page adopted;
    // shadow roots stay out of reach (documented limitation).
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      changed = walkSheet(sheet) || changed;
    }
    return changed;
  }

  // --- opaque (cross-origin) sheets --------------------------------------
  // Where a clone must sit to keep cascade order: right after the owner
  // <link> for a top-level sheet; for a sheet pulled in by @import, right
  // BEFORE the owner node of the importing chain (import rules precede the
  // sheet's own rules).
  function ownerAnchor(sheet) {
    let s = sheet;
    let viaImport = false;
    while (s && !s.ownerNode) {
      viaImport = true;
      s = s.parentStyleSheet;
    }
    // `top` is the sheet the anchor node currently owns; the upkeep pass
    // compares it back against node.sheet to notice a swap (see maintainCopies).
    return s?.ownerNode ? { node: s.ownerNode, before: viaImport, top: s } : null;
  }

  // Everything the clone has to reproduce from the link or @import that
  // brought this sheet in. The media condition rides the clone's own `media`
  // attribute; layer()/supports() have to WRAP the text, because a clone that
  // dropped them would float out of its cascade layer (unlayered rules beat
  // layered ones) or apply rules whose supports() test the browser had
  // failed. The worker does the same job for the imports it inlines
  // (wrapImportedCss); this is the one import handled on this side.
  //
  // A top-level sheet takes its condition from the owner <link>'s attribute,
  // which we never edit — attributes stay pristine. An import's condition is
  // read from the registry's ORIGINAL text, since the live one may already
  // be shifted and walkSheet(clone) will shift the clone's copy freshly.
  function cloneConditions(sheet, anchor) {
    const plain = { media: '', wrap: (text) => text };
    if (!anchor.before) {
      return { ...plain, media: anchor.node.getAttribute?.('media') ?? '' };
    }
    let rule = null;
    try { rule = sheet.ownerRule; } catch {}
    if (!rule) return plain;
    let layer = null;
    let supports = null;
    try { layer = rule.layerName; } catch {}
    try { supports = rule.supportsText; } catch {}
    return {
      media: edited.get(rule.media)?.orig ?? rule.media.mediaText,
      wrap: (text) => {
        // Innermost first, so the nesting reads layer { supports { rules } },
        // matching how the shorthand's conditions apply.
        if (supports != null) text = `@supports ${supports} {\n${text}\n}`;
        if (layer != null) text = `@layer ${layer ? layer + ' ' : ''}{\n${text}\n}`;
        return text;
      },
    };
  }

  async function adoptOpaque(sheet) {
    // No clone while both sides are collapsed: at S=0 the clone would read
    // exactly like the original — all cost, no effect.
    if (!shift || copies.has(sheet)) return;
    try { if (sheet.disabled) return; } catch { return; }
    const href = sheet.href;
    const anchor = ownerAnchor(sheet);
    if (!href || !/^https?:/i.test(href) || !anchor || failed.has(href)) return;
    const cond = cloneConditions(sheet, anchor);
    // The <style> goes in NOW, empty, while we are still inside the
    // synchronous walk. Several cross-origin @imports of one readable sheet
    // share an anchor, so inserting on fetch completion would order the
    // clones by download speed rather than document order and silently
    // invert the cascade between them. It also dedupes concurrent walks, the
    // job the old null placeholder did.
    const el = document.createElement('style');
    el.setAttribute(COPY_ATTR, href);
    el.setAttribute(CLONE_VERSION_ATTR, '2');
    if (cond.media) el.media = cond.media;
    anchor.before ? anchor.node.before(el) : anchor.node.after(el);
    // Ownership flips only after the text lands: turning the original off
    // against an empty clone would leave the page unstyled during the fetch.
    const entry = {
      el,
      anchor: anchor.node,
      top: anchor.top,
      disabledByUs: false,
    };
    copies.set(sheet, entry);
    const startedAt = epoch;
    let text = textCache.get(href);
    if (text === undefined) {
      let res = null;
      let dropped = false;
      try {
        res = await chrome.runtime.sendMessage({ type: SQZ.MSG.FETCH_CSS, url: href });
      } catch {
        dropped = true;
        SQZ.orphanGuard?.(); // extension reloaded mid-fetch: tear down
      }
      if (epoch !== startedAt) return; // stopped (or cycled) while fetching
      if (!res?.ok || typeof res.text !== 'string') {
        // A dropped channel is not a verdict about this URL: MV3 kills an
        // idle worker after 30s and a long @import chain can outlive one, so
        // blacklisting here would cost the sheet for the page's whole life
        // when a retry would simply wake a fresh worker.
        if (!dropped) failed.add(href);
        dropCopy(sheet, entry);
        return;
      }
      text = res.text;
      textCache.set(href, text);
    }
    if (epoch !== startedAt || !el.isConnected) {
      dropCopy(sheet, entry);
      return;
    }
    el.textContent = cond.wrap(text);
    if (!el.sheet) { // e.g. a non-HTML document refusing the element
      failed.add(href);
      dropCopy(sheet, entry);
      return;
    }
    // The page may have disabled the sheet while fetch was in flight. In that
    // case its choice wins and the clone must never become active in its place.
    try {
      if (sheet.disabled) {
        dropCopy(sheet, entry);
        return;
      }
      sheet.disabled = true;
      if (!sheet.disabled) {
        dropCopy(sheet, entry);
        return;
      }
    } catch {
      dropCopy(sheet, entry);
      return;
    }
    entry.disabledByUs = true;
    el.setAttribute(DISABLED_ATTR, '');
    try { sheet.ownerNode?.setAttribute(OFF_ATTR, ''); } catch {}
    walkSheet(el.sheet);
    fireApply();
  }

  function dropCopy(sheet, entry) {
    entry.el.remove();
    // Only ever undo OUR disable: an empty/failed clone and a sheet the page
    // disabled during fetch carry no ownership flag.
    if (entry.disabledByUs) {
      try { sheet.disabled = false; } catch {}
      try { sheet.ownerNode?.removeAttribute(OFF_ATTR); } catch {}
    }
    // By identity, not by key. A slow fetch can resolve after maintainCopies
    // already dropped its clone and a later scan minted a replacement under
    // the same sheet; deleting by key there evicts the LIVE entry, leaving a
    // clone in the DOM that stop() can no longer find to remove or re-enable
    // — and the next walk mints a third on top of it.
    if (copies.get(sheet) === entry) copies.delete(sheet);
  }

  // --- change tracking ---------------------------------------------------
  function fireApply() {
    onApply?.();
  }

  // Tell the MAIN-world matchMedia hook (content/match-media.js) the current
  // shift; it re-evaluates the page's MediaQueryLists and fires synthetic
  // change events for the ones that flipped. A same-value re-announcement is
  // meaningful while shifted (the hook re-bakes its orientation/aspect
  // substitutions against the live viewport), but a page at rest is never
  // poked. Returns whether an event went out — a JS flip can restyle the
  // page with no CSS edit of ours, so callers count it as a change.
  function announce(s) {
    const value = jsHooks && s ? s : 0;
    if (!value && !announced) return false;
    announced = value;
    dispatchEvent(new CustomEvent(XF.EVENT, { detail: value }));
    return true;
  }

  function onMutations(mutations) {
    // Same orphan rule as the other watchers: never fight a fresh script.
    if (SQZ.orphanGuard?.()) return;
    if (!shift) return;
    let changed = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const own = [];
        if (node.matches?.('style, link[rel~="stylesheet" i]')) own.push(node);
        if (node.firstElementChild) {
          own.push(...node.querySelectorAll('style, link[rel~="stylesheet" i]'));
        }
        for (const el of own) {
          if (el.hasAttribute(COPY_ATTR)) continue; // our own clones
          if (el.sheet) changed = walkSheet(el.sheet) || changed;
          else if (el.localName === 'link') {
            // Not loaded yet; walk once it is. The rescan interval is the
            // backstop if the load event slips past this listener.
            el.addEventListener('load', () => {
              if (SQZ.orphanGuard?.()) return;
              if (shift && el.sheet && walkSheet(el.sheet)) fireApply();
            }, { once: true });
          }
        }
      }
    }
    if (changed) fireApply();
  }

  // Clone upkeep. Runs even at shift 0: collapsing both sides deliberately
  // keeps the clones alive (see flushUpdate), and that is exactly the state
  // in which a page unloading its <link> would be left wearing the ghost of
  // the stylesheet it just removed — visibly, since the page looks
  // un-squeezed there and nothing else would drop the clone until a side
  // reopened.
  function maintainCopies() {
    for (const [sheet, entry] of copies) {
      // The anchor no longer owning the sheet we cloned covers every way a
      // page can replace it while keeping the element: an href swap mints a
      // new CSSStyleSheet, and link.disabled = true detaches it outright.
      // Either way our clone would otherwise keep applying the old rules on
      // top of whatever replaced them.
      if (!entry.anchor.isConnected || !entry.el.isConnected
          || entry.anchor.sheet !== entry.top) {
        dropCopy(sheet, entry);
      } else if (entry.disabledByUs && !sheet.disabled) {
        try { sheet.disabled = true; } catch {} // a theme switcher re-enabled it
      }
    }
  }

  // Catches what no DOM event announces: mediaText assignment, replacement at
  // an unchanged rule count, nested insertRule (styled-components), and sheets
  // whose <link> load raced the observer. A full walk is required: no shallow
  // count can distinguish those CSSOM mutations. Registry hits are read-only
  // unless the page changed a value.
  function rescan() {
    if (SQZ.orphanGuard?.()) return;
    if (document.hidden) return;
    maintainCopies();
    if (!shift) return;
    let changed = false;
    changed = scanAll() || changed;
    // Registry entries whose sheet left the document restore nothing and
    // would pile up on a long-lived SPA; let them go. Reachability is asked
    // of the TOP-level sheet: an imported sheet has no ownerNode of its own
    // and a constructed one never has any, so keying the question on the
    // walked sheet made both kinds immortal.
    let adopted = null;
    for (const [ml, entry] of edited) {
      const top = entry.top;
      if (!top) continue;
      const node = top.ownerNode;
      let gone;
      if (node) {
        gone = !node.isConnected;
      } else {
        adopted ??= new Set(document.adoptedStyleSheets);
        gone = !adopted.has(top);
      }
      if (gone && !copies.has(entry.sheet)) edited.delete(ml);
    }
    if (changed) fireApply();
  }

  // --- lifecycle ---------------------------------------------------------
  function start(left, right, opts) {
    stop();
    epoch++;
    shift = Math.max(0, left + right);
    onApply = opts?.onApply ?? null;
    jsHooks = opts?.jsBreakpoints === true;
    lastEnvKey = envKey();
    scanAll();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, childList: true });
    rescanTimer = setInterval(rescan, RESCAN_MS);
    // Announce last. The MAIN-world hook handles it synchronously — change
    // events and a resize poke all land inside this call — and a page that
    // reacts by injecting its narrow-layout stylesheet must do so in front of
    // a watcher that already exists, or the new sheet keeps evaluating
    // against the real viewport until the 2s rescan notices it.
    announce(shift);
  }

  // Settings can flip the JS side live (the options checkbox) without
  // restarting the CSS side; a dormant page just waits for the next start().
  function setJsHooks(on) {
    on = on === true;
    if (on === jsHooks) return;
    jsHooks = on;
    if (observer) announce(shift);
  }

  // Coalesced: drags stream widths, and every flush rewrites each
  // registered rule (match flips only at discrete breakpoints, but the
  // restyle cost of the rewrite itself is real on big pages).
  function update(left, right) {
    if (!observer) return;
    pendWidths = Math.max(0, left + right);
    if (!pendTimer) pendTimer = setTimeout(flushUpdate, COALESCE_MS);
  }

  function flushUpdate() {
    pendTimer = 0;
    if (!observer) return;
    const s = pendWidths;
    const env = envKey();
    if (s === shift && env === lastEnvKey) return;
    shift = s;
    lastEnvKey = env;
    if (!s) {
      // Both sides collapsed: hand the native queries back. Clones stay
      // (their rules read exactly like the originals with no shift, and
      // keeping them saves a refetch when a side reopens).
      restoreEdits();
      announce(0);
      fireApply();
      return;
    }
    let changed = false;
    for (const [ml, entry] of edited) changed = applyEdit(ml, entry, s) || changed;
    changed = scanAll() || changed; // an S move can make fresh rules eligible
    changed = announce(s) || changed; // JS flips restyle with no CSS edit
    if (changed) fireApply();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    clearInterval(rescanTimer);
    rescanTimer = 0;
    clearTimeout(pendTimer);
    pendTimer = 0;
    epoch++;
    restoreEdits();
    announce(0);
    jsHooks = false;
    for (const [sheet, entry] of copies) dropCopy(sheet, entry);
    copies.clear();
    failed = new Set();
    shift = null;
    onApply = null;
  }

  // shiftText is exposed for the e2e unit battery only.
  return { start, update, stop, setJsHooks, shiftText };
})();
