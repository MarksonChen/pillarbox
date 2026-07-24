// Shadow-DOM sidebar panels: the visible "squeezers" plus the drag handles
// that resize them. All visible styling lives inside a shadow root so page
// CSS can't reach it; the host element itself is defended with inline
// !important styles only.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.panels ??= (() => {
  const HOST_TAG = 'pillarbox-host';
  const DRAG_THRESHOLD = 3;   // px of pointer travel before a drag starts
  const FALLBACK_WIDTH = 200; // dblclick-restore when nothing better is known

  const CSS = `
:host { all: initial; }
.panel {
  position: fixed;
  top: 0;
  bottom: 0;
  pointer-events: auto;
  background: var(--pb-bg, #eef0f3); /* set on the host by applyTheme() */
  transition: transform 160ms ease-out;
}
.panel.left {
  left: 0;
  border-right: 1px solid rgba(0, 0, 0, 0.18);
  box-shadow: inset -10px 0 14px -12px rgba(0, 0, 0, 0.4);
}
.panel.right {
  right: 0;
  border-left: 1px solid rgba(0, 0, 0, 0.18);
  box-shadow: inset 10px 0 14px -12px rgba(0, 0, 0, 0.4);
}
:host([data-theme="dark"]) .panel.left { border-right-color: rgba(255, 255, 255, 0.14); }
:host([data-theme="dark"]) .panel.right { border-left-color: rgba(255, 255, 255, 0.14); }
.panel.left.offscreen { transform: translateX(-100%); }
.panel.right.offscreen { transform: translateX(100%); }
:host(.dragging) .panel { transition: none; }
@media (prefers-reduced-motion: reduce) {
  .panel { transition: none; }
}
.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
/* Straddle the inner edge so the handle stays grabbable at width 0. */
.panel.left .handle { right: -5px; }
.panel.right .handle { left: -5px; }
.handle::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}
.handle:hover::after,
.handle.active::after { background: #3b82f6; }
.readout {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px 8px;
  border-radius: 999px;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(17, 24, 39, 0.85);
  color: #f9fafb;
  white-space: nowrap;
  visibility: hidden;
  pointer-events: none;
}
:host([data-theme="dark"]) .readout {
  background: rgba(243, 244, 246, 0.9);
  color: #111827;
}
/* Float the readout in the page area next to the moving edge, so it stays
   visible no matter how narrow the panel is. */
.panel.left .readout { left: calc(100% + 12px); }
.panel.right .readout { right: calc(100% + 12px); }
.readout.show { visibility: visible; }
`;

  let host = null;
  let els = null;      // {left: {panel, handle, readout}, right: {...}}
  let callbacks = null;
  let widths = { left: 0, right: 0 };  // CSS px, as displayed
  let zoom = 1;                        // page zoom; see setZoom()
  const lastNonZero = { left: FALLBACK_WIDTH, right: FALLBACK_WIDTH };
  let appearance = {
    theme: SQZ.DEFAULT_SETTINGS.theme,
    colorLight: SQZ.DEFAULT_SETTINGS.colorLight,
    colorDark: SQZ.DEFAULT_SETTINGS.colorDark,
    showReadout: SQZ.DEFAULT_SETTINGS.showReadout,
  };
  let scheme = null;   // matchMedia('(prefers-color-scheme: dark)'), lazy
  let selectionLocked = false;

  // Text selection is suppressed page-wide during a drag; the lock must be
  // released even when the drag never finishes normally (e.g. the sidebars
  // are unmounted mid-drag by an SPA navigation or a remote toggle-off).
  function lockSelection() {
    selectionLocked = true;
    document.documentElement.style.setProperty('user-select', 'none', 'important');
    document.documentElement.style.setProperty('-webkit-user-select', 'none', 'important');
  }

  function unlockSelection() {
    if (!selectionLocked) return;
    selectionLocked = false;
    document.documentElement.style.removeProperty('user-select');
    document.documentElement.style.removeProperty('-webkit-user-select');
  }

  // Adopt a width pair and remember each side's last non-zero width — the
  // dblclick collapse/restore target. Every width change funnels through
  // here so the two can never drift apart.
  function noteWidths(next) {
    widths = next;
    for (const side of ['left', 'right']) {
      if (widths[side] > 0) lastNonZero[side] = widths[side];
    }
  }

  function applyWidths() {
    if (!els) return;
    for (const side of ['left', 'right']) {
      els[side].panel.style.width = widths[side] + 'px';
      // Report the stored (zoom-1) px, so the number matches the default
      // widths in the options page at any zoom level.
      els[side].readout.textContent = SQZ.cssToStored(widths[side], zoom) + ' px';
    }
  }

  function applyTheme() {
    if (!host) return;
    const dark = appearance.theme === 'dark'
      || (appearance.theme === 'auto' && scheme?.matches);
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    host.style.setProperty('--pb-bg',
      dark ? appearance.colorDark : appearance.colorLight, 'important');
  }

  function setAppearance(next) {
    appearance = { ...appearance, ...next };
    if (!scheme) {
      scheme = matchMedia('(prefers-color-scheme: dark)');
      scheme.addEventListener('change', applyTheme);
    }
    applyTheme();
  }

  function setWidths(left, right) {
    noteWidths({ left, right });
    applyWidths();
  }

  // The panels themselves are always driven in CSS px by the orchestrator,
  // which already divides out the zoom. Only two things here know about it:
  // the readout's units, and the collapse/restore memory — rescaling it
  // keeps a side collapsed at one zoom level coming back the same size on
  // screen at another.
  function setZoom(next) {
    if (!(next > 0) || next === zoom) return;
    for (const side of ['left', 'right']) lastNonZero[side] *= zoom / next;
    zoom = next;
    applyWidths();
  }

  function setVisible(visible) {
    host?.style.setProperty('display', visible ? 'block' : 'none', 'important');
  }

  function wireDrag(side, handle, readout) {
    const other = side === 'left' ? 'right' : 'left';
    let pointerId = null;
    let startX = 0;
    let started = false;
    let mirroring = false; // modifier key held: the far side follows
    let mirrorOffset = 0;  // far width - near width, frozen when engaging

    handle.addEventListener('pointerdown', (e) => {
      if (!callbacks || !e.isPrimary || e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      started = false;
      handle.setPointerCapture(pointerId);
      // No preventDefault here: it would suppress the dblclick that
      // collapses/restores. Selection is blocked once a drag really starts.
    });

    handle.addEventListener('pointermove', (e) => {
      if (!callbacks || !host || pointerId !== e.pointerId) return;
      if (!started) {
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
        started = true;
        host.classList.add('dragging');
        handle.classList.add('active');
        if (appearance.showReadout) readout.classList.add('show');
        // Keep the page from selecting text while the pointer sweeps it.
        lockSelection();
        callbacks.onDragStart?.(side);
      }
      const pointerPx = side === 'left' ? e.clientX : SQZ.viewportWidth() - e.clientX;
      // Any modifier key links the far side: it moves by the same amount for
      // as long as the key is held (pressing/releasing mid-drag both work).
      const modifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
      if (modifier !== mirroring) {
        mirroring = modifier;
        if (mirroring) mirrorOffset = widths[other] - widths[side];
        els?.[other].handle.classList.toggle('active', mirroring);
        if (appearance.showReadout) {
          els?.[other].readout.classList.toggle('show', mirroring);
        }
      }
      if (mirroring) {
        const pair = SQZ.mirrorPair(pointerPx, mirrorOffset);
        widths[side] = pair.near;
        widths[other] = pair.far;
      } else {
        widths[side] = SQZ.clampDrag(pointerPx, widths[other]);
      }
      noteWidths(widths);
      applyWidths();
      // Report the full displayed pair: the page must be squeezed to exactly
      // what the panels show, not to a re-clamp of stale stored values.
      callbacks.onDrag?.(side, { ...widths });
    });

    const finish = (e) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      if (!started) return;
      started = false;
      mirroring = false;
      host?.classList.remove('dragging');
      handle.classList.remove('active');
      readout.classList.remove('show');
      if (els) {
        els[other].handle.classList.remove('active');
        els[other].readout.classList.remove('show');
      }
      unlockSelection();
      callbacks?.onDragEnd?.(side);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

  }

  // One-shot width change outside a drag (the dblclick gestures): adopt,
  // paint, and report it like a finished drag so the orchestrator squeezes
  // and persists through the usual path.
  function setSideWidth(side, target) {
    widths[side] = target;
    noteWidths(widths);
    applyWidths();
    callbacks.onDrag?.(side, { ...widths });
    callbacks.onDragEnd?.(side);
  }

  function mount(opts) {
    callbacks = {
      onDragStart: opts.onDragStart,
      onDrag: opts.onDrag,
      onDragEnd: opts.onDragEnd,
      onReset: opts.onReset,
    };
    if (host) { // defensive: already mounted, just sync
      setWidths(opts.left, opts.right);
      setAppearance(opts.appearance);
      return;
    }
    noteWidths({ left: opts.left, right: opts.right });

    host = document.createElement(HOST_TAG);
    const hs = host.style;
    hs.setProperty('position', 'fixed', 'important');
    hs.setProperty('inset', '0', 'important');
    hs.setProperty('display', 'block', 'important');
    hs.setProperty('pointer-events', 'none', 'important');
    hs.setProperty('z-index', '2147483647', 'important');
    // The host is an undefined custom element; some sites hide all of those
    // as an anti-flicker guard (reddit: `:not(:defined){visibility:hidden}`).
    // Inline !important is the one thing a page stylesheet can't beat.
    hs.setProperty('visibility', 'visible', 'important');

    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      // Engine edge cases with constructed sheets across worlds; a <style>
      // inside the shadow root is equivalent.
      const styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      root.append(styleEl);
    }

    els = {};
    for (const side of ['left', 'right']) {
      const panel = document.createElement('div');
      panel.className = `panel ${side} offscreen`;
      const handle = document.createElement('div');
      handle.className = 'handle';
      const readout = document.createElement('div');
      readout.className = 'readout';
      panel.append(handle, readout);
      root.append(panel);
      els[side] = { panel, handle, readout };
      wireDrag(side, handle, readout);
      // ONE dblclick gesture for the whole sidebar surface, handle
      // included (it bubbles here; the readout is pointer-events:none):
      // plain double-click collapses the side, or restores it when it is
      // collapsed — at width 0 the edge handle IS the only remaining hit
      // area, so "double-click the sliver at the screen edge" falls out
      // naturally. Any modifier restores BOTH sides to the defaults,
      // matching the drag convention (modifier = both sides).
      panel.addEventListener('dblclick', (e) => {
        if (!callbacks) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
          callbacks.onReset?.();
        } else if (widths[side] > 0) {
          setSideWidth(side, 0);
        } else {
          const other = side === 'left' ? 'right' : 'left';
          setSideWidth(side, SQZ.clampDrag(lastNonZero[side], widths[other]));
        }
      });
    }
    applyWidths();
    setAppearance(opts.appearance);
    document.documentElement.append(host);

    // Two frames so the offscreen transform is committed before it animates.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!els) return;
      els.left.panel.classList.remove('offscreen');
      els.right.panel.classList.remove('offscreen');
    }));
  }

  function unmount() {
    if (!host) return;
    // A drag in progress dies with its handle and never fires pointerup.
    unlockSelection();
    const oldHost = host;
    const oldEls = els;
    host = null;
    els = null;
    callbacks = null;
    scheme?.removeEventListener('change', applyTheme);
    scheme = null;
    oldEls.left.panel.classList.add('offscreen');
    oldEls.right.panel.classList.add('offscreen');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      oldHost.remove();
    };
    oldEls.left.panel.addEventListener('transitionend', finish, { once: true });
    // Reduced motion and hidden tabs never fire transitionend.
    setTimeout(finish, 300);
  }

  return {
    HOST_TAG,
    mount,
    unmount,
    setWidths,
    setZoom,
    setAppearance,
    setVisible,
  };
})();
