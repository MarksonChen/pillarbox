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
// are kept in a registry and every re-shift starts from the saved text.
//
// Cross-origin sheets guard cssRules with a SecurityError, and a content
// script cannot fetch them either (page CORS applies) — the worker can
// (host permission), so opaque sheets are fetched there (@imports inlined,
// url()s absolutized against the sheet URL) and replayed in a <style>
// clone inserted right at the owner <link>, keeping cascade order; the
// original sheet is turned off via sheet.disabled — the CSSOM flag, NOT
// link.disabled, whose attribute round-trip re-fetches the sheet
// asynchronously and would leave the page unstyled for a frame on restore.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.mediaQueries ??= (() => {
  const RESCAN_MS = 2000;    // page-driven insertRule (styled-components) has
                             // no mutation event; a cheap length poll must do
  const COALESCE_MS = 150;   // trailing debounce for drag-driven updates
  // Marker attribute on every clone, so a later life of this content script
  // (extension reload) can find stale clones and re-enable their originals.
  const COPY_ATTR = 'data-pillarbox-mq';

  let shift = null;          // left + right while running, else null
  let onApply = null;        // host callback: "match states may have moved"
  let epoch = 0;             // bumped by start/stop; stale async fetches bail
  const edited = new Map();  // MediaList -> {orig, sheet}
  const copies = new Map();  // original CSSStyleSheet -> {el, anchor} | null (fetch in flight)
  let counts = new WeakMap();// CSSStyleSheet -> cssRules.length at last walk
  let failed = new Set();    // hrefs the worker could not fetch (this run)
  const textCache = new Map(); // href -> inlined text; survives stop() so a
                             // print cycle or toggle doesn't refetch anything
  let observer = null;
  let rescanTimer = 0;
  let pendTimer = 0;
  let pendWidths = null;
  let lastEnvKey = '';       // viewport fingerprint for the env substitutions

  // --- media-text shifting -----------------------------------------------
  // A feature VALUE: calc()/min()/max()/clamp() with up to three nesting
  // levels, or one dimension token (700px, 40em, 0). The lookbehinds keep
  // `device-width` (physical screen, must not shift) out: its `width` is
  // preceded by `-`, and `min-device-width` never parses as `min-` + width.
  const BAL2 = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
  const VALUE = String.raw`(?:(?:calc|min|max|clamp)\(${BAL2}\)|[\d.]+[a-z%]*)`;
  const OP = String.raw`(?:<=|>=|<|>|=)`;
  const RX_COLON = new RegExp(String.raw`((?<![-\w])(?:min-|max-)?width\s*:\s*)(${VALUE})`, 'gi');
  const RX_AFTER = new RegExp(String.raw`((?<![-\w])width\s*${OP}\s*)(${VALUE})`, 'gi');
  const RX_BEFORE = new RegExp(String.raw`(${VALUE})(\s*${OP}\s*width(?![-\w]))`, 'gi');
  const RX_ORIENT = /(?<![-\w])orientation\s*:\s*(portrait|landscape)(?![-\w])/gi;
  const RX_ASPECT = /(?<![-\w])(min-|max-)?aspect-ratio\s*:\s*([\d.]+)\s*(?:\/\s*([\d.]+))?/gi;
  // Cheap prefilter: anything shiftText COULD act on. Over-matching is fine
  // (device-width rules run shiftText and come back unchanged — never
  // registered); missing something here would silently skip it.
  const RX_ANY = /width|orientation|aspect-ratio/i;

  // A unitless 0 is a valid media-feature length but cannot join a calc()
  // sum as a bare number.
  const wrap = (v, s) => `calc(${/^0+(\.0*)?$/.test(v) ? v + 'px' : v} + ${s}px)`;

  // Constants must be width-free: a min-width tautology would be re-shifted
  // by the width passes (or broken by a later update); height features pass
  // through everything untouched.
  const MQ_TRUE = 'min-height: 0px';
  const MQ_FALSE = 'min-height: 999999px';

  function shiftText(text, s) {
    if (!s) return text;
    // Chain order matters only in that each pass must not create text a
    // later pass would re-match; shifted values contain no bare `width`
    // ident and the env constants are height-based.
    let out = text.replace(RX_BEFORE, (m, v, rest) => wrap(v, s) + rest);
    out = out.replace(RX_AFTER, (m, head, v) => head + wrap(v, s));
    out = out.replace(RX_COLON, (m, head, v) => head + wrap(v, s));
    // Media-query width includes the classic scrollbar, so the effective
    // width the page "should" see is innerWidth - S, not clientWidth - S:
    // the scrollbar offset between MQ width and content width exists
    // natively and sites already design around it.
    const effW = innerWidth - s;
    const portrait = innerHeight >= effW;
    out = out.replace(RX_ORIENT, (m, o) =>
      ((o.toLowerCase() === 'portrait') === portrait ? MQ_TRUE : MQ_FALSE));
    const ar = effW / Math.max(1, innerHeight);
    out = out.replace(RX_ASPECT, (m, mm, a, b) => {
      const r = parseFloat(a) / (b ? parseFloat(b) : 1);
      if (!Number.isFinite(r) || r <= 0) return m;
      const kind = (mm || '').toLowerCase();
      const ok = kind === 'min-' ? ar >= r
        : kind === 'max-' ? ar <= r
          : Math.abs(ar - r) < 1e-9;
      return ok ? MQ_TRUE : MQ_FALSE;
    });
    return out;
  }

  // The env substitutions bake in the viewport, so a resize can move their
  // verdict even when S is unchanged; this key says "same viewport".
  const envKey = () => innerWidth + 'x' + innerHeight;

  // --- registry ----------------------------------------------------------
  function maybeEdit(ml, sheet) {
    if (!ml || !shift || edited.has(ml)) return false;
    let orig;
    try { orig = ml.mediaText; } catch { return false; }
    if (!orig || !RX_ANY.test(orig)) return false;
    const next = shiftText(orig, shift);
    if (next === orig) return false;
    try { ml.mediaText = next; } catch { return false; }
    edited.set(ml, { orig, sheet });
    return true;
  }

  function restoreEdits() {
    for (const [ml, entry] of edited) {
      try { ml.mediaText = entry.orig; } catch {}
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
    // Whole-sheet gating (<link media>/<style media>): sheet.media is
    // readable and settable even on opaque sheets, and editing it leaves
    // the DOM attribute alone (verified: the attribute keeps its value).
    let changed = maybeEdit(sheet.media, sheet);
    let rules = null;
    try { rules = sheet.cssRules; } catch {} // SecurityError: cross-origin
    if (rules) {
      counts.set(sheet, rules.length);
      changed = walkRules(rules, sheet) || changed;
    } else {
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
    return s?.ownerNode ? { node: s.ownerNode, before: viaImport } : null;
  }

  // The media condition the clone must carry: the owner <link>'s attribute
  // for a top-level sheet (never edited by us — attributes stay pristine),
  // or the import rule's ORIGINAL condition (the live one may already be
  // shifted; walkSheet(clone) will shift the clone's copy freshly).
  function cloneMedia(sheet, anchor) {
    if (!anchor.before) return anchor.node.getAttribute?.('media') ?? '';
    let ownerRule = null;
    try { ownerRule = sheet.ownerRule; } catch {}
    if (!ownerRule) return '';
    return edited.get(ownerRule.media)?.orig ?? ownerRule.media.mediaText;
  }

  async function adoptOpaque(sheet) {
    // No clone while both sides are collapsed: at S=0 the clone would read
    // exactly like the original — all cost, no effect.
    if (!shift || copies.has(sheet)) return;
    const href = sheet.href;
    const anchor = ownerAnchor(sheet);
    if (!href || !/^https?:/i.test(href) || !anchor || failed.has(href)) return;
    const media = cloneMedia(sheet, anchor);
    copies.set(sheet, null); // reserve: dedupes concurrent walks
    const startedAt = epoch;
    let text = textCache.get(href);
    if (text === undefined) {
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: SQZ.MSG.FETCH_CSS, url: href });
      } catch {
        SQZ.orphanGuard?.(); // extension reloaded mid-fetch: tear down
      }
      if (epoch !== startedAt) return; // stopped (or cycled) while fetching
      if (!res?.ok || typeof res.text !== 'string') {
        failed.add(href);
        copies.delete(sheet);
        return;
      }
      text = res.text;
      textCache.set(href, text);
    }
    if (epoch !== startedAt || !anchor.node.isConnected) {
      copies.delete(sheet);
      return;
    }
    const el = document.createElement('style');
    el.setAttribute(COPY_ATTR, href);
    if (media) el.media = media;
    el.textContent = text;
    anchor.before ? anchor.node.before(el) : anchor.node.after(el);
    if (!el.sheet) { // e.g. a non-HTML document refusing the element
      el.remove();
      failed.add(href);
      copies.delete(sheet);
      return;
    }
    copies.set(sheet, { el, anchor: anchor.node });
    walkSheet(el.sheet);
    try { sheet.disabled = true; } catch {}
    fireApply();
  }

  function dropCopy(sheet, entry) {
    entry.el.remove();
    try { sheet.disabled = false; } catch {}
    copies.delete(sheet);
  }

  // --- change tracking ---------------------------------------------------
  function fireApply() {
    onApply?.();
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

  // Catches what no DOM event announces: rules added through insertRule
  // (styled-components et al) and sheets whose <link> load raced the
  // observer. A rule-count probe per sheet is near-free; a full walk runs
  // only for sheets that actually moved (the registry makes it idempotent).
  function rescan() {
    if (SQZ.orphanGuard?.()) return;
    if (!shift || document.hidden) return;
    let changed = false;
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      let n = null;
      try { n = sheet.cssRules.length; } catch {}
      if (n === null) {
        adoptOpaque(sheet); // an opaque sheet the observer missed
      } else if (counts.get(sheet) !== n) {
        changed = walkSheet(sheet) || changed;
      }
    }
    for (const [sheet, entry] of copies) {
      if (!entry) continue; // fetch in flight
      if (!entry.anchor.isConnected || !entry.el.isConnected) {
        dropCopy(sheet, entry); // the page removed its link (or our clone)
      } else if (!sheet.disabled) {
        try { sheet.disabled = true; } catch {} // a theme switcher re-enabled it
      }
    }
    // Registry entries whose sheet left the document restore nothing and
    // would pile up on a long-lived SPA; let them go.
    for (const [ml, entry] of edited) {
      const node = entry.sheet?.ownerNode;
      if (node && !node.isConnected && !copies.has(entry.sheet)) edited.delete(ml);
    }
    if (changed) fireApply();
  }

  // --- lifecycle ---------------------------------------------------------
  function start(left, right, opts) {
    stop();
    epoch++;
    shift = Math.max(0, left + right);
    onApply = opts?.onApply ?? null;
    lastEnvKey = envKey();
    scanAll();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, childList: true });
    rescanTimer = setInterval(rescan, RESCAN_MS);
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
      fireApply();
      return;
    }
    let changed = false;
    for (const [ml, entry] of edited) {
      const next = shiftText(entry.orig, s);
      try {
        if (ml.mediaText !== next) {
          ml.mediaText = next;
          changed = true;
        }
      } catch {}
    }
    changed = scanAll() || changed; // an S move can make fresh rules eligible
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
    for (const [sheet, entry] of copies) {
      if (entry) dropCopy(sheet, entry);
    }
    copies.clear();
    counts = new WeakMap();
    failed = new Set();
    shift = null;
    onApply = null;
  }

  const running = () => !!observer;

  // shiftText is exposed for the e2e unit battery only.
  return { start, update, stop, running, shiftText };
})();
