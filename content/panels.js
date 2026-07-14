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
  let widths = { left: 0, right: 0 };
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

  function applyWidths() {
    if (!els) return;
    for (const side of ['left', 'right']) {
      els[side].panel.style.width = widths[side] + 'px';
      els[side].readout.textContent = Math.round(widths[side]) + ' px';
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
    widths = { left, right };
    for (const side of ['left', 'right']) {
      if (widths[side] > 0) lastNonZero[side] = widths[side];
    }
    applyWidths();
  }

  function setVisible(visible) {
    host?.style.setProperty('display', visible ? 'block' : 'none', 'important');
  }

  function wireDrag(side, handle, readout) {
    let pointerId = null;
    let startX = 0;
    let started = false;

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
      const other = side === 'left' ? 'right' : 'left';
      const px = SQZ.clampDrag(
        side === 'left' ? e.clientX : SQZ.viewportWidth() - e.clientX,
        widths[other]);
      widths[side] = px;
      if (px > 0) lastNonZero[side] = px;
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
      host?.classList.remove('dragging');
      handle.classList.remove('active');
      readout.classList.remove('show');
      unlockSelection();
      callbacks?.onDragEnd?.(side);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    handle.addEventListener('dblclick', () => {
      if (!callbacks) return;
      const other = side === 'left' ? 'right' : 'left';
      const target = widths[side] > 0
        ? 0
        : SQZ.clampDrag(lastNonZero[side], widths[other]);
      widths[side] = target;
      if (target > 0) lastNonZero[side] = target;
      applyWidths();
      callbacks.onDrag?.(side, { ...widths });
      callbacks.onDragEnd?.(side);
    });
  }

  function mount(opts) {
    if (host) { // defensive: already mounted, just sync
      setWidths(opts.left, opts.right);
      setAppearance(opts.appearance);
      return;
    }
    callbacks = {
      onDragStart: opts.onDragStart,
      onDrag: opts.onDrag,
      onDragEnd: opts.onDragEnd,
    };
    widths = { left: opts.left, right: opts.right };
    for (const side of ['left', 'right']) {
      if (widths[side] > 0) lastNonZero[side] = widths[side];
    }

    host = document.createElement(HOST_TAG);
    const hs = host.style;
    hs.setProperty('position', 'fixed', 'important');
    hs.setProperty('inset', '0', 'important');
    hs.setProperty('display', 'block', 'important');
    hs.setProperty('pointer-events', 'none', 'important');
    hs.setProperty('z-index', '2147483647', 'important');

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
    setAppearance,
    setVisible,
  };
})();
