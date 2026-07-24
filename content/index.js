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
    let zoomDpr = devicePixelRatio; // the dpr that went with `zoom`
    let settings = SQZ.mergeSettings(null);
    let rec = null;        // {on, left, right} | null — source of truth, stored unclamped
    const echoes = new Set(); // JSON stamps of our own storage writes

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

    async function init() {
      cleanupStaleArtifacts();
      let syncRaw, localRaw, zoomRaw;
      try {
        [syncRaw, localRaw, zoomRaw] = await Promise.all([
          chrome.storage.sync.get(SQZ.SETTINGS_KEY),
          chrome.storage.local.get(KEY),
          fetchZoom(), // the origin may carry a remembered zoom level
        ]);
      } catch (e) {
        if (orphaned()) return teardown(); // reload raced the boot
        throw e;
      }
      if (torndown) return; // orphaned while the read was in flight
      setZoom(zoomRaw);
      settings = SQZ.mergeSettings(syncRaw[SQZ.SETTINGS_KEY]);
      rec = localRaw[KEY] ?? null;
      if (rec?.on) {
        enable();
        persist({}); // refresh the record's LRU timestamp
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
      // left + right + width:auto, all !important.)
      for (const el of document.getElementsByTagName('*')) {
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

    // rec holds "px at 100% zoom"; the page works in CSS px, whose size on
    // screen is itself scaled by the zoom factor. Dividing here (and
    // multiplying back in onDrag) is what keeps a sidebar the same width on
    // screen at every zoom level. The clamps run on the CSS px, so the
    // minimum page gap stays a real gap in the zoomed layout.
    function effWidths() {
      return SQZ.clampPair(SQZ.storedToCss(rec.left, zoom),
        SQZ.storedToCss(rec.right, zoom));
    }

    // The tab's zoom factor lives in chrome.tabs, out of reach here; the
    // service worker answers with it. Null on failure (worker torn down mid
    // extension reload) — the caller then keeps the last known factor.
    async function fetchZoom() {
      try {
        const res = await chrome.runtime.sendMessage({ type: SQZ.MSG.GET_ZOOM });
        return res ? SQZ.sanitizeZoom(res.zoom) : null;
      } catch {
        return null;
      }
    }

    // Adopt a new factor; returns whether it actually changed. Re-anchors
    // the dpr that onResize compares against, so learning a zoom level and
    // noticing one can't fight each other.
    function setZoom(next) {
      zoomDpr = devicePixelRatio;
      if (next === null || SQZ.sanitizeZoom(next) === zoom) return false;
      zoom = SQZ.sanitizeZoom(next);
      SQZ.panels.setZoom(zoom);
      return true;
    }

    // Re-query the authoritative factor and re-apply if it moved. A dpr
    // change alone is not proof of a zoom change (the window may have moved
    // to a display with a different scale), so the worker gets the last word.
    async function syncZoom() {
      const next = await fetchZoom();
      if (torndown) return;
      if (setZoom(next) && phase === 'active' && !suspended && !dragging) {
        applyWidthsToPage();
      }
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

    function enable() {
      rec = {
        on: true,
        left: rec?.left ?? settings.defaultLeft,
        right: rec?.right ?? settings.defaultRight,
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
          if (setZoom(msg.zoom) && phase === 'active' && !suspended && !dragging) {
            applyWidthsToPage();
          }
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
              enable();
              await persist({ on: true });
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
        ...(rec ?? { on: false, left: settings.defaultLeft, right: settings.defaultRight }),
        ...patch,
        t: Date.now(), // LRU timestamp; the service worker prunes the oldest
      };
      const stamp = JSON.stringify(rec);
      echoes.add(stamp);
      if (echoes.size > 16) echoes.delete(echoes.values().next().value);
      try {
        await chrome.storage.local.set({ [KEY]: rec });
      } catch {
        echoes.delete(stamp);
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
        if (next && echoes.delete(JSON.stringify(next))) return; // our own write
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
      } else if (phase === 'active' && !dragging && !suspended) {
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
      // Double-click on a panel's empty space: both sides back to the
      // defaults. persist() updates rec synchronously before writing.
      persist({ on: true, left: settings.defaultLeft, right: settings.defaultRight });
      applyWidthsToPage();
    }

    function onResize() {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (phase !== 'active' || suspended || dragging) return;
        // A zoom change arrives here too (the layout viewport resizes), and
        // devicePixelRatio — zoom times the display scale — has already
        // moved with it. That makes it a free filter for "the zoom may have
        // changed": ordinary window resizes leave it alone, so the worker is
        // only asked when there is something to ask about.
        if (devicePixelRatio !== zoomDpr) {
          zoomDpr = devicePixelRatio; // don't re-ask on every frame of the reflow
          syncZoom();
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
      let syncRaw, localRaw;
      try {
        [syncRaw, localRaw] = await Promise.all([
          withSettings ? chrome.storage.sync.get(SQZ.SETTINGS_KEY) : null,
          chrome.storage.local.get(key),
        ]);
      } catch (e) {
        if (orphaned()) return teardown(); // reload raced the event's guard
        throw e;
      }
      if (KEY !== key || recEpoch !== epoch) return;
      if (withSettings) settings = SQZ.mergeSettings(syncRaw[SQZ.SETTINGS_KEY]);
      rec = localRaw[key] ?? null;
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
      await syncZoom();
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
