// MAIN-world counterpart of media-queries.js: stylesheets are only half of
// how sites read the viewport — apps also ask window.matchMedia from
// JavaScript (YouTube's whole layout hangs off iron-media-query elements
// wrapping exactly that) and no isolated-world edit can reach what those
// report. This file runs in the page's own world at document_start, before
// any page script, and wraps window.matchMedia.
//
// The wrapper returns the GENUINE native MediaQueryList — instanceof, the
// .media text and every listener API stay untouched — and keeps a WeakRef
// ledger of each width-flavored list it hands out. While squeezed, every
// ledger entry gets a hidden "shadow" list for the shifted query text:
// the patched prototype `matches` getters (list and event) answer from the
// shadow, a shadow flip dispatches a synthetic change event on the page's
// list (dispatchEvent reaches addEventListener, onchange and legacy
// addListener alike), and native events firing at the un-shifted thresholds
// carry corrected values through the same event getter.
//
// At shift 0 every getter passes through to the native one and no shadow
// list exists, so nothing of ours listens on any page object. What IS
// installed unconditionally on every page, squeezed or not, is five patches:
// the wrapped matchMedia, the two `matches` accessors, the two width-metric
// accessors, plus one window listener for the announcement event. Their
// BEHAVIOUR at rest is native to the value; a page that goes looking can
// still tell they were replaced.
//
// The isolated world announces the shift total over the __pillarboxMqShift
// EVENT (a CustomEvent with a primitive detail — primitives cross worlds);
// same-value re-announcements while shifted re-bake the orientation/
// aspect-ratio substitutions against the live viewport. The page could
// listen for (or spoof) that event, but it only ever lies to itself.
//
// While squeezed the width METRICS lie too: window.innerWidth and
// document.documentElement.clientWidth answer minus the shift (see the
// window-width section at the bottom for why and for what stays honest).
//
// Known residual honesty, accepted by design: synthetic events are
// isTrusted:false; a listener that ignores every matches value and blindly
// toggles state reacts to the redundant native-threshold events; and
// heights, visualViewport, screen.* and outerWidth keep telling the truth.
(() => {
  'use strict';
  const XF = globalThis.__pillarboxMqShift;
  // The handoff global must not outlive this script in the page's world —
  // delete before any early return can leave it dangling.
  try { delete globalThis.__pillarboxMqShift; } catch {}
  if (!XF || typeof window.matchMedia !== 'function'
    || !window.MediaQueryList || !window.MediaQueryListEvent) return;

  // Marker stamped on the accessors we later have to recognise: the list
  // `matches` getter (the double-injection guard just below) and the width
  // metrics (how a re-stamp tells our own getter from the native one). The
  // MediaQueryListEvent `matches` getter goes in unstamped — nothing ever
  // has to identify it again. Deliberately
  // not named after the extension — a page can always detect THAT matchMedia
  // was wrapped, but it should not learn by whom from a name we chose.
  const MARK = '__shimmed';

  const MQL_PROTO = MediaQueryList.prototype;
  const EVT_PROTO = MediaQueryListEvent.prototype;
  const mDesc = Object.getOwnPropertyDescriptor(MQL_PROTO, 'matches');
  const eDesc = Object.getOwnPropertyDescriptor(EVT_PROTO, 'matches');
  if (!mDesc?.get || !eDesc?.get) return;
  if (mDesc.get[MARK]) return; // injected twice: the first life is live
  const nativeMatches = mDesc.get;
  const nativeEventMatches = eDesc.get;
  const nativeMatchMedia = window.matchMedia;

  let shift = 0;     // current squeeze total; 0 = fully inert
  let refs = [];     // WeakRef per shiftable list handed to the page
  let sweepAt = 64;  // ledger length that triggers a dead-ref sweep
  const seen = new WeakSet();
  // page list -> { sq: shadow list for the shifted text, on: our listener }.
  // The WeakMap is the lookup the getters use — weak so it never pins a list
  // the page dropped, and sh.on reaches back to the page list through a
  // WeakRef only. allShadows is the strong, iterable other half, and it is
  // load-bearing: a native MediaQueryList carrying a listener lives as long
  // as the document, so a shadow whose page list has been collected can no
  // longer be reached through the WeakMap and would keep its listener
  // forever. That is the common case, not an exotic one — the one-shot
  // `matchMedia('(max-width: 768px)').matches` idiom inside a scroll or
  // render helper mints (and drops) a list per call. The registry reclaims
  // each shadow as soon as its page list goes; teardown sweeps the rest.
  let shadows = new WeakMap();
  const allShadows = new Set();
  const reclaim = new FinalizationRegistry(releaseShadow);

  const effective = (mql) => {
    const sh = shadows.get(mql);
    return nativeMatches.call(sh ? sh.sq : mql);
  };

  function fire(mql) {
    let ev;
    try {
      ev = new MediaQueryListEvent('change',
        { media: mql.media, matches: effective(mql) });
    } catch {
      ev = new Event('change');
    }
    try { mql.dispatchEvent(ev); } catch {}
  }

  // Idempotent: a reclaim callback can land after a teardown already swept
  // the same record, and a shadow may unhook itself (see sh.on) first.
  function releaseShadow(sh) {
    sh.sq.removeEventListener('change', sh.on);
    allShadows.delete(sh);
  }

  function dropAllShadows() {
    for (const sh of allShadows) releaseShadow(sh);
    allShadows.clear();
    shadows = new WeakMap(); // a WeakMap cannot be cleared; a fresh one is the reset
  }

  function buildShadow(mql) {
    let media;
    try { media = mql.media; } catch { return; }
    // realWidth, not innerWidth: our own width lie (below) must never feed
    // the transform, or the shift would be subtracted twice.
    const shifted = XF.shiftMediaText(media, shift, realWidth(), innerHeight);
    if (shifted === media) return; // device-width & co: native is already right
    let sq;
    try { sq = nativeMatchMedia.call(window, shifted); } catch { return; }
    const ref = new WeakRef(mql);
    const sh = { sq, on: null };
    sh.on = () => {
      const target = ref.deref();
      if (!target) { releaseShadow(sh); return; }
      fire(target);
    };
    // The shadow is a native list of THIS realm: the browser fires it at
    // real crossings of the shifted thresholds, so resizes need no manual
    // relay of ours.
    sq.addEventListener('change', sh.on);
    shadows.set(mql, sh);
    allShadows.add(sh);
    reclaim.register(mql, sh, mql);
  }

  // Compact the ledger and return the survivors.
  function liveLists() {
    const live = [];
    for (const ref of refs) {
      const mql = ref.deref();
      if (mql) live.push(mql);
    }
    refs = live.map((mql) => new WeakRef(mql));
    sweepAt = Math.max(64, live.length * 2);
    return live;
  }

  function apply(s) {
    if (!s && !shift) return; // announcements at rest must not touch the page
    const moved = s !== shift;
    const live = liveLists();
    const before = live.map(effective);
    shift = s;
    // Rebuild rather than diff: a same-S announcement exists precisely to
    // re-bake the orientation/aspect substitutions after a resize.
    dropAllShadows();
    if (s) for (const mql of live) buildShadow(mql);
    // The width lie lives on whichever element currently means "the
    // viewport", and that element can be swapped out from under an own
    // property; re-verify while we are here anyway.
    stampClientWidth();
    // Events go out only after the whole world is consistent, so a listener
    // reading some OTHER list's matches sees the new state, not a mix.
    live.forEach((mql, i) => {
      if (effective(mql) !== before[i]) fire(mql);
    });
    if (moved) poke();
  }

  // --- resize pokes -------------------------------------------------------
  // Synthetic window resizes per shift CHANGE — matchMedia covers the sites
  // that ask breakpoint questions; this covers the ones that re-MEASURE in
  // resize handlers (YouTube's player recenters its <video> in exactly such
  // a handler, and stays visibly stale without it). Same-S re-announcements
  // never poke: those follow a real resize the page already heard.
  //
  // One poke is not enough. Natively, the breakpoints these apps watch can
  // ONLY flip during a real resize — a stream of events that outlasts every
  // late relayout — so their pipelines legitimately lean on "another resize
  // will come" (YouTube narrows its watch column from a low-priority job
  // seconds after the flip, and only the next resize re-centers the video).
  // A squeeze change must honor that contract: poke immediately, then for a
  // fixed window re-check a cheap geometry fingerprint, poking again
  // whenever the page moved since the last look. Two hard-won constraints:
  // the cadence must exceed fixed-bars' 300ms rescan debounce, which every
  // poke re-arms through the isolated world's own resize listener (a faster
  // stream postpones the very adoption it waits for), and the WIDTH in the
  // fingerprint has to come from <body> — the root's client/scroll widths are
  // viewport-based and blind to content narrowing back inside the margins.
  // (The root's scrollHeight still earns its place: page height is the
  // quickest signal that a relayout has actually landed.)
  const POKE_MS = 500;   // > fixed-bars' 300ms rescan debounce
  const POKE_TICKS = 20; // watch window per shift change, ~10s
  let pokeTimer = 0;
  let pokeLeft = 0;
  let pokeFp = '';

  function fingerprint() {
    try {
      const de = document.documentElement;
      const b = document.body;
      return de.scrollHeight + '|' + (b ? b.scrollWidth + 'x' + b.scrollHeight : '');
    } catch {
      return '';
    }
  }

  function dispatchResize() {
    try { dispatchEvent(new Event('resize')); } catch {}
  }

  function poke() {
    dispatchResize();
    pokeFp = fingerprint();
    pokeLeft = POKE_TICKS;
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(pokeTick, POKE_MS);
  }

  function pokeTick() {
    pokeTimer = 0;
    const fp = fingerprint();
    if (fp !== pokeFp) {
      pokeFp = fp;
      dispatchResize();
    }
    if (--pokeLeft > 0) pokeTimer = setTimeout(pokeTick, POKE_MS);
  }

  addEventListener(XF.EVENT, (e) => {
    const s = Math.round(Number(e?.detail) || 0);
    apply(s > 0 ? s : 0);
  });

  const wrapped = function matchMedia(query) {
    // Named, and with one declared parameter it never reads, so .name and
    // .length still report what the native function does — turning this into
    // an arrow or dropping the parameter would silently change both. `this`
    // passes through verbatim, so an exotic receiver misbehaves exactly as it
    // would natively.
    const mql = nativeMatchMedia.apply(this, arguments);
    try {
      if (mql && !seen.has(mql) && XF.ANY.test(String(mql.media))) {
        seen.add(mql);
        refs.push(new WeakRef(mql));
        if (refs.length >= sweepAt) liveLists();
        if (shift) buildShadow(mql);
      }
    } catch {}
    return mql;
  };
  window.matchMedia = wrapped;

  const pbMatches = function () {
    if (shift) {
      const sh = shadows.get(this);
      if (sh) return nativeMatches.call(sh.sq);
    }
    return nativeMatches.call(this);
  };
  // The stamp doubles as the double-injection guard above.
  Object.defineProperty(pbMatches, MARK, { value: true });
  Object.defineProperty(MQL_PROTO, 'matches', { ...mDesc, get: pbMatches });

  // Event objects answer like their list: native change events keep firing
  // at the un-shifted thresholds while squeezed (harmless, values unchanged)
  // and must not hand the page the un-shifted verdict.
  const pbEventMatches = function () {
    if (shift) {
      const sh = shadows.get(this.target);
      if (sh) return nativeMatches.call(sh.sq);
    }
    return nativeEventMatches.call(this);
  };
  Object.defineProperty(EVT_PROTO, 'matches', { ...eDesc, get: pbEventMatches });

  // --- window-width metrics ----------------------------------------------
  // Breakpoint questions are not the only way scripts read the viewport:
  // sizing math measures it in px, through window.innerWidth or — the
  // Closure-library way YouTube actually uses (goog.dom.getViewportSize) —
  // the clientWidth of whichever element carries the viewport meaning.
  // Verified live: YouTube's watch player takes its dimensions from a cached
  // {width, height} of exactly those metrics, so after the single-column flip
  // it kept the size computed for the REAL window and froze there. While
  // squeezed both answer minus the shift — by the same amount, so scrollbar
  // arithmetic (innerWidth - clientWidth) stays exact. Heights are honest
  // (the squeeze never changes them), as are visualViewport, screen.* and
  // outerWidth (physical/window facts, matching device-width staying
  // unshifted in the query transform). The isolated world has its own
  // bindings and always sees native values — the extension's clamp math
  // depends on that. At shift 0 both getters return native values exactly.
  const accessor = (obj, name) => {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  };

  const iwDesc = accessor(window, 'innerWidth');
  const nativeIW = iwDesc?.get;
  const realWidth = () => (nativeIW ? nativeIW.call(window) : innerWidth);
  if (nativeIW) {
    const pbInnerWidth = function () {
      const v = nativeIW.call(this ?? window);
      return shift ? Math.max(0, v - shift) : v;
    };
    Object.defineProperty(pbInnerWidth, MARK, { value: true });
    // innerWidth is natively a [Replaceable] own accessor of window: keeping
    // it enumerable and handing back the native setter preserves both the
    // shape and the assignment semantics (a page's `innerWidth = x` still
    // replaces the property with a data property, as it would natively).
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      enumerable: true,
      get: pbInnerWidth,
      set: iwDesc.set,
    });
  }

  // WHICH element's clientWidth means "the viewport" is mode-dependent
  // (CSSOM View): the root element in standards mode, <body> in quirks. In
  // quirks the root reports its own padding box instead — which the squeeze
  // margins have ALREADY narrowed — so lying there would subtract the shift
  // twice. SQZ.viewportWidth() draws the same distinction on the isolated
  // side, for the same reason.
  const viewportEl = () => (document.compatMode === 'CSS1Compat'
    ? document.documentElement
    : document.body);

  const cwDesc = accessor(Element.prototype, 'clientWidth');
  const nativeCW = cwDesc?.get;
  const pbClientWidth = function () {
    const v = nativeCW.call(this);
    // Re-checked per read rather than trusted from stamp time: document.write
    // can flip the compat mode and leave this accessor on an element whose
    // clientWidth has become a padding box.
    return shift && this === viewportEl() ? Math.max(0, v - shift) : v;
  };
  Object.defineProperty(pbClientWidth, MARK, { value: true });

  // The lie is an own property on ONE element, so it does not survive that
  // element being replaced — document.open()/write() and replaceChild both do
  // that, and the successor answers from the pristine prototype getter — nor
  // can it be installed at document_start on a <body> that does not exist
  // yet. Every shift application re-verifies it. Without that, innerWidth
  // would go on lying while clientWidth told the truth: the frozen-layout bug
  // this override exists to fix, plus a negative scrollbar width. Left
  // non-enumerable so Object.keys() on the element still reads native.
  function stampClientWidth() {
    if (!nativeCW) return;
    const el = viewportEl();
    if (!el || Object.getOwnPropertyDescriptor(el, 'clientWidth')?.get?.[MARK]) return;
    try {
      Object.defineProperty(el, 'clientWidth', {
        configurable: true,
        enumerable: false,
        get: pbClientWidth,
      });
    } catch {}
  }
  stampClientWidth();
})();
