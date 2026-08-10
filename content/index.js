// Orchestrator: owns the per-page state, storage IO and the enable/disable
// lifecycle. Loaded last in the content-script list; the boot guard makes
// re-injection through chrome.scripting.executeScript a no-op.
var SQZ = globalThis.SQZ ??= {};

if (!SQZ.booted) {
  SQZ.booted = true;

  (() => {
    let KEY = SQZ.pageKey(location.href);

    let phase = 'loading'; // 'loading' | 'dormant' | 'active'
    let suspended = false; // printing: page temporarily un-squeezed
    let busy = false;      // drops overlapping toggles (one net transition)
    let dragging = false;  // ignore cross-tab width sync mid-drag
    let resizeRaf = 0;
    let torndown = false;  // orphaned (extension reloaded); everything detached
    let recEpoch = 0;      // bumped on every local rec write; stale async reads bail
    let zoom = 1;          // page zoom factor; rec holds px at zoom 1
    let zoomDpr = devicePixelRatio; // the dpr observed when `zoom` was learned
    let zoomConfirmed = false; // an authoritative (worker-sourced) factor arrived
    let zoomConfirm = null;    // in-flight GET_ZOOM round-trip, deduped
    let zoomHintWritten = null; // last value persisted under ZKEY (null = absent)
    let dprMq = null;          // matchMedia probe that fires when the dpr moves
    const ZKEY = SQZ.zoomKey(location.origin);
    let settings = SQZ.mergeSettings(null);
    let rec = null;        // {on, left, right} | null — source of truth, stored unclamped
    const echoes = SQZ.makeEchoes(); // our own storage writes, by content

    // Listeners are registered synchronously so a toolbar click arriving
    // while storage is still loading finds a receiver (the message handler
    // awaits `ready` before acting). The chrome.* listeners die with the
    // extension context on their own; the DOM listeners live in one table,
    // each wrapped with the orphan check, so registration and the orphan
    // teardown can't drift apart.
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    // Memory is per URL, so same-document (SPA) navigations must switch to
    // the new URL's record. The navigation API sees pushState/replaceState;
    // popstate/hashchange are belt-and-braces for back/forward.
    const onNav = guarded(onUrlChanged);
    const domListeners = [
      [globalThis, 'pageshow', guarded(onPageShow)],
      [globalThis, 'beforeprint', guarded(onBeforePrint)],
      [globalThis, 'afterprint', guarded(onAfterPrint)],
      [globalThis, 'resize', guarded(onResize)],
      [globalThis, 'popstate', onNav],
      [globalThis, 'hashchange', onNav],
      ...(globalThis.navigation?.addEventListener
        ? [[navigation, 'navigatesuccess', onNav]]
        : []),
    ];
    for (const [target, type, fn] of domListeners) target.addEventListener(type, fn);

    // The observers in squeeze.js / fixed-bars.js / media-queries.js probe
    // this before re-asserting styles. Without it, an orphaned script's watcher and a
    // freshly injected script's watcher would each "correct" the other's
    // html margins in an unbounded microtask chain the moment they disagree.
    SQZ.orphanGuard = () => {
      if (!orphaned()) return false;
      teardown();
      return true;
    };

    const ready = init();

    // One orphan-guarded storage read: the given local keys, plus the sync
    // settings when asked. Returns null when the read died because the
    // extension reloaded out from under us (teardown has already run).
    async function readState(localKeys, withSettings) {
      try {
        const [syncRaw, localRaw] = await Promise.all([
          withSettings ? chrome.storage.sync.get(SQZ.SETTINGS_KEY) : null,
          chrome.storage.local.get(localKeys),
        ]);
        return { syncRaw, localRaw };
      } catch (e) {
        if (orphaned()) {
          teardown();
          return null;
        }
        throw e;
      }
    }

    async function init() {
      cleanupStaleArtifacts();
      const state = await readState([KEY, ZKEY], true);
      if (!state || torndown) return; // orphaned during the read
      const { syncRaw, localRaw } = state;
      // The zoom hint rides the storage read we make anyway (no service-
      // worker wake), so a zoomed page boots at its exact widths with no
      // extra latency. Chrome remembers zoom per origin, so a hint written
      // by any tab covers them all; the worker later confirms it (lazily
      // for dormant pages — their widths aren't applied anywhere).
      const hint = localRaw[ZKEY];
      zoomHintWritten = typeof hint === 'number' ? hint : null;
      adoptZoom(typeof hint === 'number' ? SQZ.sanitizeZoom(hint) : null);
      watchDpr();
      settings = SQZ.mergeSettings(syncRaw[SQZ.SETTINGS_KEY]);
      const stored = localRaw[KEY] ?? null;
      rec = stored;
      // No record at all means this page is new to us, and a rule may say to
      // open it anyway. Nothing is written for that: the rule re-decides on
      // every load, and minting a record per page merely visited would churn
      // the LRU cap for no gain. Only a deliberate act — drag, reset,
      // toggle — makes this page's state its own.
      if (stored?.on || (!stored && autoShowsHere())) {
        enable();
        if (stored) persist({}); // refresh the record's LRU timestamp
        confirmZoom(); // verify the hint off the boot path
      } else {
        phase = 'dormant';
      }
    }

    function cleanupStaleArtifacts() {
      // An extension reload orphans the previous content script's DOM edits.
      // A leftover host proves the current squeeze styles are ours; strip
      // them before squeeze.apply() snapshots the "prior" inline styles.
      // (squeeze-sidebars-host is the pre-0.3 host tag.)
      const stale = document.querySelector(`${SQZ.panels.HOST_TAG}, squeeze-sidebars-host`);
      if (!stale) return;
      // Wake the orphaned previous life before touching anything: its DOM
      // listeners still fire (isolated worlds outlive the extension), and
      // the guarded handler tears it down synchronously DURING this
      // dispatch — restoring the html margins, the fixed-bar overrides and,
      // crucially, its media-query edits, which live only in the CSSOM and
      // carry no DOM fingerprint this life could find. The manual strips
      // below stay as belt-and-braces for a world that never got to run.
      dispatchEvent(new Event('resize'));
      // The MAIN-world matchMedia hook is page-lifetime and survives the
      // reload; a still-running old world just announced shift 0 during the
      // poke above, but if that world never woke, this explicit 0 is what
      // un-lies matchMedia. Harmless when already at rest.
      const mqEvent = globalThis.__pillarboxMqShift?.EVENT;
      if (mqEvent) dispatchEvent(new CustomEvent(mqEvent, { detail: 0 }));
      stale.remove();
      const style = document.documentElement.style;
      // Priority alone is not a fingerprint. A page may ship its own
      // `html { margin-left: 0 !important }` inline — and the resize poke
      // above has just made the orphaned life restore exactly that, value and
      // priority — so stripping on priority would delete the page's own
      // declaration, permanently: the fresh squeeze.apply() below snapshots
      // the stripped state as "prior", and toggle-off never brings it back.
      // Only strip what squeeze.js writes AS A SET, the same joint-
      // fingerprint reasoning the fixed-bar loop below uses.
      const squeezeProps = ['margin-left', 'margin-right', 'width'];
      const pxValue = /^-?[\d.]+px$/;
      if (squeezeProps.every((prop) => style.getPropertyPriority(prop) === 'important')
          && style.getPropertyValue('width') === 'auto'
          && pxValue.test(style.getPropertyValue('margin-left'))
          && pxValue.test(style.getPropertyValue('margin-right'))) {
        for (const prop of squeezeProps) style.removeProperty(prop);
      }
      // The drag lock (a reload mid-drag) carries its own fingerprint: the
      // value is always none, and panels.js is the only writer.
      for (const prop of ['user-select', '-webkit-user-select']) {
        if (style.getPropertyValue(prop) === 'none'
            && style.getPropertyPriority(prop) === 'important') {
          style.removeProperty(prop);
        }
      }
      // The previous life's fixed-bar overrides also survive on page
      // elements, and a fresh manager could never re-adopt them: an already
      // squeezed box no longer escapes. Adopted elements carry an inline
      // --pillarbox marker; strip everything the manager could have written.
      // (Lives before the marker existed left the inset fingerprint
      // left + right + width:auto, all !important.) Only elements with a
      // style attribute can carry either — skip the rest of the DOM.
      for (const el of document.querySelectorAll('[style]')) {
        const s = el.style;
        if (s.getPropertyValue('--pillarbox')) {
          for (const prop of ['--pillarbox', 'left', 'right', 'width', 'min-width',
            'margin-left', 'margin-right', 'padding-left', 'padding-right']) {
            s.removeProperty(prop);
          }
        } else if (s.getPropertyValue('width') === 'auto'
            && s.getPropertyPriority('width') === 'important'
            && s.getPropertyPriority('left') === 'important'
            && s.getPropertyPriority('right') === 'important') {
          for (const prop of ['left', 'right', 'width']) s.removeProperty(prop);
        }
      }
      // A dead previous world's cross-origin clones: remove each and re-enable
      // its sheet only when the clone records that the old life disabled it.
      // Empty/failed clones never own the page's disabled state. (In-place
      // mediaText edits are unrecoverable without that world's registry — the
      // resize poke above makes the old life restore those itself.)
      for (const el of document.querySelectorAll('style[data-pillarbox-mq]')) {
        const href = el.getAttribute('data-pillarbox-mq');
        if (el.hasAttribute('data-pillarbox-mq-disabled')) {
          for (const sheet of document.styleSheets) {
            if (sheet.href === href && sheet.disabled) sheet.disabled = false;
          }
        }
        el.remove();
      }
    }

    // The page can absorb width changes only while it is visibly squeezed
    // and nothing else owns the widths right now — not a drag in progress,
    // not the print suspension.
    function idle() {
      return phase === 'active' && !suspended && !dragging;
    }

    // rec holds "px at 100% zoom"; the page works in CSS px, whose size on
    // screen is itself scaled by the zoom factor. Dividing here (and
    // multiplying back in onDrag) is what keeps a sidebar the same width on
    // screen at every zoom level. The clamps run on the CSS px, so the
    // minimum page gap stays a real gap in the zoomed layout.
    function effWidths() {
      return SQZ.clampPair(SQZ.storedToCss(rec.left, zoom),
        SQZ.storedToCss(rec.right, zoom));
    }

    // --- zoom tracking ---------------------------------------------------
    // The authoritative factor lives in chrome.tabs, a worker round-trip
    // away — far too slow to wait for while the user zooms (the page has
    // already repainted by then, sidebars scaled wrong, then snapping back).
    // What makes zooming flash-free instead: devicePixelRatio is
    // zoom × display scale, and it has already moved by the time the resize
    // event fires — inside the same rendering update that will paint the
    // first zoomed frame. Dividing the old dpr out of the new one turns the
    // last authoritative (zoom, dpr) pair into the exact new factor,
    // synchronously; the worker is only asked to confirm afterwards, and
    // only ever corrects the one case the ratio misreads (the window
    // landing on a display with a different scale — dpr moved, zoom
    // didn't). That correction is a rare async touch-up; the common path
    // never waits on a message.

    // Adopt a factor; returns whether it actually changed. Always
    // re-anchors zoomDpr, keeping the pair consistent for the next ratio.
    // The epsilon swallows float noise from predicted ratios (e.g.
    // 1.1000000000000001 vs the worker's exact 1.1), which would otherwise
    // churn styles for invisible differences.
    function adoptZoom(next) {
      zoomDpr = devicePixelRatio;
      if (next === null || Math.abs(next - zoom) < 1e-6) return false;
      zoom = next;
      SQZ.panels.setZoom(zoom);
      return true;
    }

    // Worker-sourced values additionally refresh the per-origin hint that
    // makes the next boot on this origin exact without waiting for anyone.
    // Only ≠100% is worth remembering; at 1 the key is removed.
    function adoptConfirmed(v) {
      zoomConfirmed = true;
      if (adoptZoom(v) && idle()) applyWidthsToPage();
      const hintValue = Math.abs(zoom - 1) < 1e-6 ? null : zoom;
      if (hintValue !== zoomHintWritten) {
        zoomHintWritten = hintValue;
        (hintValue === null
          ? chrome.storage.local.remove(ZKEY)
          : chrome.storage.local.set({ [ZKEY]: hintValue })).catch(() => {});
      }
    }

    // Ask the worker for the real factor. Deduped while in flight; callers
    // that need certainty (first enable on a page) await it, everyone else
    // fires and forgets. A reply raced by a newer prediction is fine: the
    // worker reads the factor when the message arrives, and onZoomChange
    // pushes the final word regardless.
    function confirmZoom() {
      zoomConfirm ??= (async () => {
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: SQZ.MSG.GET_ZOOM });
        } catch {
          if (orphaned()) teardown();
          return;
        } finally {
          zoomConfirm = null;
        }
        if (!torndown && res) adoptConfirmed(SQZ.sanitizeZoom(res.zoom));
      })();
      return zoomConfirm;
    }

    // Fires whenever devicePixelRatio changes for any reason — zoom changes
    // included, since media-query change events are dispatched before the
    // animation frame callbacks where the prediction re-anchors zoomDpr, so
    // the ratio still looks stale from here. The confirmZoom that follows is
    // deduped against the prediction's own, leaving one worker round-trip
    // either way. What this path alone catches is the window moving to a
    // display with a different scale (macOS: no resize event) — same zoom,
    // new dpr — which must re-anchor the pair so a later prediction doesn't
    // misread the ratio.
    const onDprChange = guarded(() => {
      watchDpr();
      if (devicePixelRatio !== zoomDpr) confirmZoom();
    });

    // The probe matches the current dpr exactly, so any change unmatches
    // it; re-armed against the new value on every firing.
    function watchDpr() {
      dprMq?.removeEventListener('change', onDprChange);
      dprMq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      dprMq.addEventListener('change', onDprChange);
    }

    function appearanceFromSettings() {
      return {
        theme: settings.theme,
        colorLight: SQZ.sanitizeColor(settings.colorLight, SQZ.DEFAULT_SETTINGS.colorLight),
        colorDark: SQZ.sanitizeColor(settings.colorDark, SQZ.DEFAULT_SETTINGS.colorDark),
        showReadout: settings.showReadout === true,
      };
    }

    // The panels' own fallback when a side has never been open on this page.
    // Global, not defaultWidths(): see the note on `defaults` in panels.js.
    function defaultsFromSettings() {
      return { left: settings.defaultLeft, right: settings.defaultRight };
    }

    function startFixedBars() {
      const { left, right } = effWidths();
      SQZ.fixedBars.start(left, right, (el) => el.localName === SQZ.panels.HOST_TAG);
    }

    // Breakpoint shifting (media-queries.js). A shift application can flip
    // the page into a different layout whose bars the fixed-bar observer
    // never sees coming (a media flip changes computed styles without
    // touching any attribute), so every apply nudges the manager — its
    // update() schedules the debounced whole-document rescan.
    function startMediaShift() {
      const { left, right } = effWidths();
      SQZ.mediaQueries.start(left, right, {
        jsBreakpoints: settings.jsBreakpoints !== false,
        onApply: () => {
          if (!idle()) return;
          const w = effWidths();
          SQZ.fixedBars.update(w.left, w.right); // no-op before fixedBars.start
        },
      });
    }

    // Default widths for THIS page: the first matching per-URL rule wins,
    // otherwise the global defaults. Consulted when a page has no saved
    // widths yet, by the modifier + double-click reset, and by the toolbar
    // click that revives a page whose sides are both collapsed.
    function defaultWidths() {
      return SQZ.matchRule(settings.rules, location.href)
        ?? { left: settings.defaultLeft, right: settings.defaultRight };
    }

    // Does a rule tell this URL to open its pillars unprompted? Only ever
    // asked about a page with no record — a stored on:false is a decision
    // the user made here, and it outranks the rule every time.
    function autoShowsHere() {
      return SQZ.ruleAutoShow(SQZ.findRule(settings.rules, location.href));
    }

    function enable() {
      const dw = defaultWidths();
      rec = {
        on: true,
        left: rec?.left ?? dw.left,
        right: rec?.right ?? dw.right,
      };
      const { left, right } = effWidths();
      SQZ.squeeze.apply(left, right);
      SQZ.squeeze.watch();
      startMediaShift(); // before the fixed-bar scan sees the page
      SQZ.panels.mount({
        left,
        right,
        appearance: appearanceFromSettings(),
        defaults: defaultsFromSettings(),
        onDragStart,
        onDrag,
        onDragEnd,
        onReset,
      });
      startFixedBars();
      phase = 'active';
    }

    function disable() {
      SQZ.mediaQueries.stop(); // native queries back before bars release
      SQZ.fixedBars.stop();
      SQZ.panels.unmount();
      SQZ.squeeze.unwatch();
      SQZ.squeeze.restore();
      suspended = false;
      // A drag interrupted by the unmount never fires onDragEnd; without
      // this reset, width syncs and resize re-clamps would stay ignored.
      dragging = false;
      phase = 'dormant';
    }

    function orphaned() {
      // Reloading, updating or removing the extension orphans this script:
      // chrome.runtime.id comes back undefined and every chrome.* call throws
      // "Extension context invalidated". No toggle can ever reach us again.
      return !chrome.runtime?.id;
    }

    // Wraps a DOM event handler with the orphan check: once the extension
    // context is gone, any wake-up tears the script down instead of running.
    function guarded(fn) {
      return (...args) => (orphaned() ? teardown() : fn(...args));
    }

    // Detected lazily — on the first DOM event, storage call or style
    // re-assertion that would have failed — the orphan restores the page and
    // detaches completely. The next toolbar click injects a fresh script
    // that takes over from storage.
    function teardown() {
      if (torndown) return;
      torndown = true;
      SQZ.orphanGuard = () => true;
      for (const [target, type, fn] of domListeners) {
        target.removeEventListener(type, fn);
      }
      dprMq?.removeEventListener('change', onDprChange);
      if (phase === 'active') disable();
      else phase = 'dormant';
    }

    // `animate` is passed by the callers whose change is a discrete decision
    // — a reset, a revive, a record arriving from another tab — and withheld
    // by the ones correcting for something continuous (a zoom, a window
    // resize), where a gliding panel would visibly trail what it is tracking.
    function applyWidthsToPage(opts) {
      const { left, right } = effWidths();
      SQZ.panels.setWidths(left, right, opts);
      SQZ.squeeze.update(left, right);
      SQZ.mediaQueries.update(left, right); // no-op when off; coalesces itself
      SQZ.fixedBars.update(left, right);
    }

    function onMessage(msg, _sender, sendResponse) {
      if (msg?.type === SQZ.MSG.ZOOM) {
        ready.then(() => {
          if (torndown) return;
          // Mid-drag the pointer is already dictating the widths; the next
          // pointermove converts through the new factor on its own.
          adoptConfirmed(SQZ.sanitizeZoom(msg.zoom));
        });
        return; // nothing to respond
      }
      if (msg?.type !== SQZ.MSG.TOGGLE) return;
      (async () => {
        await ready;
        if (!busy) {
          busy = true;
          try {
            const dw = defaultWidths();
            if (phase === 'active' && !rec.left && !rec.right && (dw.left || dw.right)) {
              // Both sides collapsed: the page already looks un-squeezed,
              // so a plain toggle-off would be invisible and the button
              // would feel dead. Make the click mean "bring the sidebars
              // back" — this page's defaults, rule or global. Unless those
              // are 0/0 as well: reviving to nothing would leave the button
              // with no reachable off state at all, so fall through instead.
              await persist({ on: true, ...dw });
              if (idle()) applyWidthsToPage({ animate: true });
            } else if (phase === 'active') {
              disable();
              await persist({ on: false });
            } else {
              // First enable in this life: the factor may still be the boot
              // hint (or the default 1). The worker is provably awake — this
              // toggle came from it — so certainty costs one fast round-trip
              // instead of a visible width correction.
              if (!zoomConfirmed) await confirmZoom();
              if (!torndown) {
                enable();
                await persist({ on: true });
              }
            }
          } finally {
            busy = false;
          }
        }
        try {
          sendResponse({ on: phase === 'active' });
        } catch {
          // The tab navigated while we worked; nobody is listening anymore.
        }
      })();
      return true; // keep the channel open for the async response
    }

    async function persist(patch) {
      recEpoch++;
      rec = {
        ...rec, // never null here: every caller is past enable() or holds one
        ...patch,
        t: Date.now(), // LRU timestamp; the service worker prunes the oldest
      };
      const stamp = echoes.add(rec);
      try {
        await chrome.storage.local.set({ [KEY]: rec });
      } catch {
        echoes.drop(stamp);
        if (orphaned()) teardown();
      }
    }

    function onStorageChanged(changes, area) {
      if (torndown) return;
      if (phase === 'loading') {
        // init()'s read may or may not already include this write (it could
        // have landed after the read resolved). Re-run once boot settles —
        // applying it is idempotent if the read did see it.
        ready.then(() => onStorageChanged(changes, area));
        return;
      }
      if (area === 'local' && KEY in changes) {
        const next = changes[KEY].newValue ?? null;
        if (next && echoes.own(next)) return; // our own write bouncing back
        // A REMOVAL is housekeeping, never a decision. Nothing in the UI
        // deletes a page record; the one thing that does is the worker's LRU
        // pruner, and it evicts by last-USE — which a tab left open and
        // squeezed for weeks stops refreshing, because only toggles, drags
        // and loads stamp `t`. Adopting the null would close the pillars
        // under someone mid-read and lose the widths they had set. Keep the
        // record in memory and write nothing: a write here would defeat the
        // prune it is reacting to.
        if (!next && rec?.on && phase === 'active') return;
        // Mid-drag the pointer owns the widths. Adopting another tab's pair
        // here would leave the panels showing this drag while onDragEnd
        // persisted the other tab's numbers. An `on` flip still lands, so a
        // remote toggle-off keeps working.
        if (dragging && next?.on && rec?.on) return;
        recEpoch++;
        rec = next;
        applyRecord();
      } else if (area === 'sync' && SQZ.SETTINGS_KEY in changes) {
        settings = SQZ.mergeSettings(changes[SQZ.SETTINGS_KEY].newValue);
        applySettings();
      }
    }

    function applyRecord() {
      // Same new-page question init() asks, re-asked wherever the record can
      // change underfoot: an in-page navigation to a fresh URL, a bfcache
      // return, or the worker's LRU pruner dropping this page's record while
      // nothing of ours is on screen. (A prune against an ACTIVE page never
      // gets this far — onStorageChanged keeps that record instead of
      // adopting the null.) Held in memory only — see init(); a write here
      // would defeat the pruner it is reacting to.
      if (!rec && autoShowsHere()) rec = { on: true, ...defaultWidths() };
      if (!rec?.on) {
        if (phase === 'active') disable();
        else phase = 'dormant';
      } else if (phase === 'dormant') {
        enable();
      } else if (idle()) {
        // A record that moved elsewhere (another tab, an SPA navigation to a
        // URL with its own widths) is a decision, not a correction.
        applyWidthsToPage({ animate: true });
      }
    }

    function applySettings() {
      if (phase !== 'active') return;
      SQZ.panels.setAppearance(appearanceFromSettings());
      const dw = defaultsFromSettings();
      SQZ.panels.setDefaults(dw.left, dw.right);
      SQZ.mediaQueries.setJsHooks(settings.jsBreakpoints !== false);
    }

    function onDragStart() {
      dragging = true;
    }

    function onDrag(_side, pair) {
      // The panels report their full displayed pair (mutually clamped for
      // this viewport); adopt it verbatim. Re-clamping against a stale
      // stored other side would rescale both and desync page from panels.
      recEpoch++;
      rec = {
        ...rec,
        on: true,
        left: SQZ.cssToStored(pair.left, zoom),
        right: SQZ.cssToStored(pair.right, zoom),
      };
      SQZ.squeeze.update(pair.left, pair.right);
      SQZ.mediaQueries.update(pair.left, pair.right); // coalesced internally
      SQZ.fixedBars.update(pair.left, pair.right);
    }

    function onDragEnd() {
      dragging = false;
      persist({ on: true });
    }

    function onReset() {
      // Modifier + double-click anywhere on a sidebar (the handle bubbles
      // there too): both sides back to this page's defaults (URL rule or
      // global). A plain double-click collapses or restores just that side
      // and never reaches here. persist() updates rec synchronously before
      // writing.
      persist({ on: true, ...defaultWidths() });
      applyWidthsToPage({ animate: true });
    }

    function onResize() {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!idle()) return;
        // A zoom change resizes the layout viewport with devicePixelRatio
        // already moved, and this rAF still runs inside the rendering
        // update that paints the first zoomed frame (resize steps precede
        // animation callbacks, which precede paint). Predicting the factor
        // from the dpr ratio and applying it here is what makes zooming
        // flash-free: the first zoomed frame already carries the corrected
        // widths. The worker confirms afterwards and only ever overrides
        // the rare misread (a cross-display drag that resized the window).
        if (devicePixelRatio !== zoomDpr) {
          adoptZoom(zoom * (devicePixelRatio / zoomDpr));
          confirmZoom();
        }
        // Re-clamp for the new viewport; rec itself stays unclamped so a
        // temporarily small window doesn't permanently shrink saved widths.
        applyWidthsToPage();
      });
    }

    // Re-read the current KEY's record (and, for bfcache returns, the
    // settings too) and apply it. Bails if a newer navigation OR a local
    // write (a toggle landing while the read was in flight) has already
    // superseded this snapshot.
    async function refreshRecord(withSettings) {
      const key = KEY;
      const epoch = recEpoch;
      const state = await readState(key, withSettings);
      if (!state || KEY !== key || recEpoch !== epoch) return;
      if (withSettings) settings = SQZ.mergeSettings(state.syncRaw[SQZ.SETTINGS_KEY]);
      rec = state.localRaw[key] ?? null;
      applyRecord();
      if (withSettings) applySettings();
    }

    async function onUrlChanged() {
      await ready;
      const key = SQZ.pageKey(location.href);
      if (key === KEY) return;
      // Adopt the new key immediately, so a user action during the read
      // below persists under the page they are looking at. Accepted edge: a
      // toggle in that sub-100ms window writes the OLD record's widths under
      // this key (the epoch bump then discards our stale read — the user's
      // write wins deliberately, and the next drag overwrites the widths).
      KEY = key;
      await refreshRecord(false);
    }

    async function onPageShow(e) {
      if (!e.persisted) return;
      await ready;
      // Back from the bfcache; storage, the URL and the tab's zoom level
      // may all have moved on while the page was frozen.
      KEY = SQZ.pageKey(location.href);
      await confirmZoom();
      await refreshRecord(true);
    }

    function onBeforePrint() {
      if (phase !== 'active' || suspended) return;
      suspended = true;
      // Print media evaluates width features against the paper size; a
      // shifted breakpoint would corrupt the printout, so restore fully.
      SQZ.mediaQueries.stop();
      SQZ.fixedBars.stop();
      SQZ.squeeze.unwatch();
      SQZ.squeeze.restore();
      SQZ.panels.setVisible(false);
    }

    function onAfterPrint() {
      if (!suspended) return;
      suspended = false;
      if (phase !== 'active') return;
      const { left, right } = effWidths();
      SQZ.squeeze.apply(left, right);
      SQZ.squeeze.watch();
      startMediaShift();
      // rec may have moved (cross-tab sync) while width application was
      // suspended for printing — re-sync the panels too.
      SQZ.panels.setWidths(left, right);
      SQZ.panels.setVisible(true);
      startFixedBars();
    }
  })();
}
