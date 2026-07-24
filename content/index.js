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
    let zoomHintWritten;       // last value persisted under ZKEY (null = absent)
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

    // The observers in squeeze.js / fixed-bars.js probe this before
    // re-asserting styles. Without it, an orphaned script's watcher and a
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
      rec = localRaw[KEY] ?? null;
      if (rec?.on) {
        enable();
        persist({}); // refresh the record's LRU timestamp
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
      stale.remove();
      const style = document.documentElement.style;
      // user-select covers a reload that happened mid-drag.
      for (const prop of ['margin-left', 'margin-right', 'width',
        'user-select', '-webkit-user-select']) {
        if (style.getPropertyPriority(prop) === 'important') style.removeProperty(prop);
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

    // Fires whenever devicePixelRatio changes for any reason. Zoom changes
    // come with a resize and are predicted there; what this alone catches
    // is the window moving to a display with a different scale (macOS: no
    // resize event) — same zoom, new dpr — which must re-anchor the pair so
    // a later prediction doesn't misread the ratio.
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

    function startFixedBars() {
      const { left, right } = effWidths();
      SQZ.fixedBars.start(left, right, (el) => el.localName === SQZ.panels.HOST_TAG);
    }

    // Default widths for THIS page: the first matching per-URL rule wins,
    // otherwise the global defaults. Consulted when a page has no saved
    // widths yet, and by the double-click reset.
    function defaultWidths() {
      return SQZ.matchRule(settings.rules, location.href)
        ?? { left: settings.defaultLeft, right: settings.defaultRight };
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
      SQZ.panels.mount({
        left,
        right,
        appearance: appearanceFromSettings(),
        onDragStart,
        onDrag,
        onDragEnd,
        onReset,
      });
      startFixedBars();
      phase = 'active';
    }

    function disable() {
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

    function applyWidthsToPage() {
      const { left, right } = effWidths();
      SQZ.panels.setWidths(left, right);
      SQZ.squeeze.update(left, right);
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
            if (phase === 'active') {
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
        ...(rec ?? { on: false, ...defaultWidths() }),
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
        recEpoch++;
        rec = next;
        applyRecord();
      } else if (area === 'sync' && SQZ.SETTINGS_KEY in changes) {
        settings = SQZ.mergeSettings(changes[SQZ.SETTINGS_KEY].newValue);
        applySettings();
      }
    }

    function applyRecord() {
      if (!rec?.on) {
        if (phase === 'active') disable();
        else phase = 'dormant';
      } else if (phase === 'dormant') {
        enable();
      } else if (idle()) {
        applyWidthsToPage();
      }
    }

    function applySettings() {
      if (phase !== 'active') return;
      SQZ.panels.setAppearance(appearanceFromSettings());
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
      SQZ.fixedBars.update(pair.left, pair.right);
    }

    function onDragEnd() {
      dragging = false;
      persist({ on: true });
    }

    function onReset() {
      // Double-click on a panel's empty space: both sides back to this
      // page's defaults (URL rule or global). persist() updates rec
      // synchronously before writing.
      persist({ on: true, ...defaultWidths() });
      applyWidthsToPage();
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
      // rec may have moved (cross-tab sync) while width application was
      // suspended for printing — re-sync the panels too.
      SQZ.panels.setWidths(left, right);
      SQZ.panels.setVisible(true);
      startFixedBars();
    }
  })();
}
