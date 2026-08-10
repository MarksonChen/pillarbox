// Shadow-DOM sidebar panels: the visible "squeezers" plus the drag handles
// that resize them. All visible styling lives inside a shadow root so page
// CSS can't reach it; the host element itself is defended with inline
// !important styles only.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.panels ??= (() => {
  const HOST_TAG = 'pillarbox-host';
  const DRAG_THRESHOLD = 3;   // px of pointer travel before a drag starts
  const SLIDE_MS = 160;       // must match the panel transition in CSS

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
/* Dark panels get no edge line — transparent (not 0) keeps the geometry. */
:host([data-theme="dark"]) .panel.left { border-right-color: transparent; }
:host([data-theme="dark"]) .panel.right { border-left-color: transparent; }
.panel.left.offscreen { transform: translateX(-100%); }
.panel.right.offscreen { transform: translateX(100%); }
/* The other ways a side comes or goes — the dblclick collapse and restore,
   a reset, a revive, a record arriving from another tab — move the WIDTH,
   not the transform: collapsing by translating would carry the handle off
   the screen with the panel and leave nothing to grab it back by. Opt-in per
   gesture, because the continuous width changes must not lag by even a
   frame: a drag has to sit exactly under the pointer, and a resize or zoom
   re-clamp is a correction, not a movement. */
:host(.gliding) .panel { transition: transform 160ms ease-out, width 160ms ease-out; }
:host(.dragging) .panel { transition: none; }
/* The one exception inside a drag. When a modifier links the far side it
   jumps to match the dragged one, and when the modifier is let go it returns
   to where it started: both are discrete moves the pointer is not tracking,
   so both glide even though everything else in a drag must land instantly.
   Listed twice because the drag's own "transition: none" outranks a lone
   .panel.glide, while the bare selector is what still applies if the pointer
   comes up mid-glide and .dragging goes away underneath it. */
:host(.dragging) .panel.glide,
.panel.glide { transition: transform 160ms ease-out, width 160ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .panel,
  :host(.gliding) .panel,
  :host(.dragging) .panel.glide,
  .panel.glide { transition: none; }
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
/* Straddle the inner edge so the handle stays grabbable at width 0 — but
   never past the panel's OUTER edge, or the overhang lands outside the layout
   viewport and is unclickable. That overhang costs nothing on macOS, where
   overlay scrollbars put the viewport edge at the window edge and a pointer
   thrown at the edge still lands on the inner half. Windows paints a classic
   ~15px scrollbar the page can never receive events over, so the viewport
   edge sits 15px inside the window: a straddling handle spent half its width
   under that scrollbar and left a 5px target 15px in from where the gesture
   aims. Clamping the offset to (width - 10px) keeps the full 10px live and
   flush against the last reachable column. Inert while a side is wider than
   the handle, so an open panel's handle still straddles its edge as before. */
.panel { --pb-off: min(-5px, calc(var(--pb-w, 999px) - 10px)); }
.panel.left .handle { right: var(--pb-off); }
.panel.right .handle { left: var(--pb-off); }
.handle::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}
/* The visible bar rides the panel's inner EDGE, not the middle of the hit
   area — those coincide only while the handle straddles that edge. Once the
   clamp above pulls the handle inward the two part company, and a bar left in
   the middle floats a few px off the window border exactly when the side is
   collapsed and the border is all there is to aim at. Centring it on the edge
   means 9px + offset from the handle's left going one way and -1px - offset
   going the other; clamped to [0, 8] so the 2px bar stays wholly inside the
   10px handle, i.e. wholly inside the viewport, and ends up flush against the
   border rather than half beyond it. */
.panel.left .handle::after { left: clamp(0px, calc(9px + var(--pb-off)), 8px); }
.panel.right .handle::after { left: clamp(0px, calc(-1px - var(--pb-off)), 8px); }
.handle:hover::after,
.handle.active::after { background: #3b82f6; }
/* ...but never while that panel is moving under its own steam. The linked
   side's jump and its trip home carry the handle across the screen, and a
   lit bar riding along points at an edge that is not there yet. Only the
   linked side ever glides mid-drag, so only it ever goes dark. */
.panel.glide .handle::after { background: transparent; }
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
  // Width each side was last actually shown at, in CSS px: the dblclick
  // restore target. null until the side has been open at least once — a rule
  // with a zero side (youtube's 285x0) mounts one collapsed and noteWidths
  // never fills it in — and `defaults` stands in for it there.
  const lastNonZero = { left: null, right: null };
  // The user's configured default widths, in stored px (at 100% zoom) like
  // the settings they come from, so unlike lastNonZero they need no rescaling
  // when the zoom moves. Deliberately the GLOBAL defaults and not this page's
  // rule: a rule's zero side would restore that side to 0, i.e. to nothing,
  // leaving the only gesture that can reopen it doing nothing at all.
  let defaults = {
    left: SQZ.DEFAULT_SETTINGS.defaultLeft,
    right: SQZ.DEFAULT_SETTINGS.defaultRight,
  };
  // Did a drag happen inside the pair of clicks that a dblclick is
  // completing? That is the only question worth asking before treating a
  // dblclick as a gesture, because a drag can sit on EITHER click of the
  // pair — Chrome's dblclick slop is wider than DRAG_THRESHOLD, so a small
  // deliberate nudge still counts as a click. Timing cannot answer it (a
  // drag followed by a separate quick double-click looks identical), but the
  // event stream can: a click arrives immediately after the pointerup that
  // ended the drag, so the drag's own click is tagged as it goes past, while
  // any other first-of-a-pair click starts the question over.
  let dragInPair = false;
  let dragClickPending = false;
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
  // The page's own inline values are snapshotted and replayed, the same
  // contract squeeze.js and fixed-bars.js honour for everything they write.
  const SELECT_PROPS = ['user-select', '-webkit-user-select'];
  let selectionPriors = null;

  function lockSelection() {
    if (selectionLocked) return;
    selectionLocked = true;
    const style = document.documentElement.style;
    selectionPriors = SELECT_PROPS.map((prop) => ({
      prop,
      value: style.getPropertyValue(prop),
      priority: style.getPropertyPriority(prop),
    }));
    for (const prop of SELECT_PROPS) style.setProperty(prop, 'none', 'important');
  }

  function unlockSelection() {
    if (!selectionLocked) return;
    selectionLocked = false;
    const style = document.documentElement.style;
    for (const prior of selectionPriors) {
      style.removeProperty(prior.prop);
      if (prior.value) style.setProperty(prior.prop, prior.value, prior.priority);
    }
    selectionPriors = null;
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
      // Same number as a custom property: the handle's offset clamp needs it
      // in CSS, and reading it back from style.width in a calc() is not a
      // thing the cascade can do.
      els[side].panel.style.setProperty('--pb-w', widths[side] + 'px');
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

  // Let the next width change glide, then take the permission back once it
  // has played out — so a resize or drag frame arriving later is not caught
  // mid-glide and dragged along with it. Re-entrant: a second gesture inside
  // the window simply extends it. (.dragging still overrides, both ways.)
  let glideTimer = 0;

  function glide() {
    if (!host) return;
    const target = host; // an unmount mid-glide must not touch the next host
    target.classList.add('gliding');
    clearTimeout(glideTimer);
    glideTimer = setTimeout(() => {
      glideTimer = 0;
      target.classList.remove('gliding');
    }, SLIDE_MS + 60);
  }

  // `animate` marks the discrete changes — a gesture, a reset, a record
  // arriving from another tab — as opposed to tracking a drag, a resize or a
  // zoom, which must land instantly.
  function setWidths(left, right, opts) {
    if (opts?.animate) glide();
    noteWidths({ left, right });
    applyWidths();
  }

  // Pushed by the orchestrator at mount and again whenever the settings
  // change, so a side that has never been open here reopens at the width the
  // user actually configured. A non-positive default would make the gesture
  // dead, so the shipped number stands in.
  function setDefaults(left, right) {
    defaults = {
      left: left > 0 ? left : SQZ.DEFAULT_SETTINGS.defaultLeft,
      right: right > 0 ? right : SQZ.DEFAULT_SETTINGS.defaultRight,
    };
  }

  // Where a dblclick reopens a collapsed side.
  function restoreTarget(side) {
    return lastNonZero[side] ?? SQZ.storedToCss(defaults[side], zoom);
  }

  // The panels are normally driven in CSS px by the orchestrator, which has
  // already divided the zoom out, so most of this module never sees it. Three
  // things must: the readout's units, the collapse/restore memory, and the
  // live widths — every CSS-px number held here means a fixed size on screen,
  // and a zoom change moves what that costs in CSS px.
  //
  // Rescaling `widths` is redundant outside a drag (the orchestrator pushes
  // the authoritative clamped pair immediately after the factor changes), but
  // it is the only correction the non-dragged side gets DURING one: idle() is
  // false, so both of the orchestrator's re-apply paths bail, and the pair
  // reported by onDrag is what gets stored. Without it, zooming mid-drag
  // silently rewrites the other side's saved width by the zoom ratio.
  function setZoom(next) {
    if (!(next > 0) || next === zoom) return;
    const scale = zoom / next;
    for (const side of ['left', 'right']) {
      if (lastNonZero[side] !== null) lastNonZero[side] *= scale;
      widths[side] *= scale;
    }
    zoom = next;
    applyWidths();
  }

  function setVisible(visible) {
    host?.style.setProperty('display', visible ? 'block' : 'none', 'important');
  }

  // Resting on a handle with a modifier held previews the link a drag would
  // make: the far side's bar lights up too, so the gesture says what it is
  // about to do before anything moves. Inert during a drag — there the
  // pointer handler owns both bars, and pointer capture means the hover
  // never ends anyway, so the two would only fight over the same class.
  let hoverSide = null;   // handle the pointer is resting on, if any
  let dragSide = null;    // handle being dragged, if any
  let keysWatched = false;
  const KEY_OPTS = { capture: true, passive: true };

  const heldModifier = (e) => e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;

  function showLink(on) {
    if (!els || !hoverSide || dragSide) return;
    const far = hoverSide === 'left' ? 'right' : 'left';
    els[far].handle.classList.toggle('active', on);
  }

  const onKey = (e) => showLink(heldModifier(e));
  // A modifier still down when the window loses focus never delivers its
  // keyup, and the preview would sit there lit until the pointer moved.
  const onBlur = () => showLink(false);

  function watchKeys(on) {
    if (on === keysWatched) return;
    keysWatched = on;
    // Captured on window, the earliest point in the path, so a page that
    // stops key events from propagating cannot blind the preview. Passive
    // and never prevented: this reads the modifier state, it never takes
    // the key away from the page.
    const wire = on ? 'addEventListener' : 'removeEventListener';
    window[wire]('keydown', onKey, KEY_OPTS);
    window[wire]('keyup', onKey, KEY_OPTS);
    window[wire]('blur', onBlur, KEY_OPTS);
  }

  // `e` is the pointer event that carries the modifier state on the way in;
  // on the way out there is nothing to read and nothing to light.
  function setHover(next, e) {
    if (next === hoverSide) return;
    showLink(false); // still reading the side being left
    hoverSide = next;
    watchKeys(next !== null);
    if (next && e) showLink(heldModifier(e));
  }

  function wireDrag(side, handle, readout) {
    const other = side === 'left' ? 'right' : 'left';
    let pointerId = null;
    let startX = 0;
    let started = false;
    let mirroring = false; // modifier key held: the far side matches this one
    let mirrorFrom = 0;    // far width when the modifier engaged; where it goes back to
    let mirrorZoom = 1;    // the factor mirrorFrom is expressed in
    let farGlideTimer = 0;

    // Let the far panel — and only it — animate its next width change, then
    // take the permission back. The near panel must never be in here: it has
    // to sit exactly under the pointer. Timed off like the host's glide(), so
    // a pointer frame arriving later is not caught mid-transition; while the
    // window is open the far side eases toward each new width instead, which
    // is what makes the jump read as a move rather than a jump cut.
    function glideFar() {
      const panel = els?.[other].panel;
      if (!panel) return;
      panel.classList.add('glide');
      clearTimeout(farGlideTimer);
      farGlideTimer = setTimeout(() => {
        farGlideTimer = 0;
        panel.classList.remove('glide'); // the captured one: it may be off-DOM
      }, SLIDE_MS + 60);
    }

    handle.addEventListener('pointerenter', (e) => setHover(side, e));
    handle.addEventListener('pointerleave', () => setHover(null));

    handle.addEventListener('pointerdown', (e) => {
      if (!callbacks || !e.isPrimary || e.button !== 0) return;
      // One pointer at a time. A mouse and a touch contact are each "primary"
      // for their own type, so on a touchscreen a stray tap during a mouse
      // drag would otherwise take the pointerId over: the mouse's pointerup
      // no longer matches, the tap's own release exits early on !started, and
      // nothing ever runs the cleanup — leaving the page-wide selection lock
      // on and the orchestrator stuck believing a drag is still in progress.
      if (pointerId !== null) return;
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
        dragSide = side; // the hover preview stands down for the duration
        host.classList.add('dragging');
        handle.classList.add('active');
        if (appearance.showReadout) readout.classList.add('show');
        // Keep the page from selecting text while the pointer sweeps it.
        lockSelection();
        callbacks.onDragStart?.(side);
      }
      const pointerPx = side === 'left' ? e.clientX : SQZ.viewportWidth() - e.clientX;
      // Any modifier key links the far side: it takes the dragged side's own
      // width for as long as the key is held, so engaging centers the page
      // and the two move together from there (pressing/releasing mid-drag
      // both work).
      const modifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
      if (modifier !== mirroring) {
        mirroring = modifier;
        if (mirroring) {
          mirrorFrom = widths[other];
          mirrorZoom = zoom;
        } else {
          // Letting the modifier go undoes the link rather than freezing it:
          // the far side returns to the width it had when the key went down,
          // so a mirrored excursion costs nothing if it turns out not to be
          // what you wanted. Clamped on the way back — the near side has
          // moved since, and MIN_GAP outranks the width being restored.
          widths[other] = SQZ.clampDrag(mirrorFrom, widths[side]);
        }
        // Both directions are a jump the pointer is not tracking, so both
        // glide (see the .glide rule). The page itself reflows at once
        // underneath, which is the same choreography as every other glide.
        glideFar();
        els?.[other].handle.classList.toggle('active', mirroring);
        if (appearance.showReadout) {
          els?.[other].readout.classList.toggle('show', mirroring);
        }
      }
      if (mirroring) {
        // mirrorFrom is CSS px like the widths it came from, so a zoom change
        // mid-drag has to move it too (see setZoom). The live widths need no
        // such care: both are a pure function of where the pointer is now.
        if (mirrorZoom !== zoom) {
          mirrorFrom *= mirrorZoom / zoom;
          mirrorZoom = zoom;
        }
        widths[side] = widths[other] = SQZ.mirrorWidth(pointerPx);
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
      dragSide = null;
      dragClickPending = true; // the click about to fire carries this drag
      mirroring = false;
      host?.classList.remove('dragging');
      handle.classList.remove('active');
      readout.classList.remove('show');
      if (els) {
        els[other].handle.classList.remove('active');
        els[other].readout.classList.remove('show');
      }
      // Handing the far bar back to the preview: a drag that ends with the
      // modifier still down, on a handle the pointer has not left, leaves
      // the link exactly as live as it was before the drag began.
      showLink(heldModifier(e));
      unlockSelection();
      callbacks?.onDragEnd?.(side);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

  }

  // One-shot width change outside a drag (the dblclick gestures): adopt,
  // paint, and report it like a finished drag so the orchestrator squeezes
  // and persists through the usual path. The page reflows at once and the
  // panel glides over it, which is the same choreography as the toolbar
  // toggle's slide in and out.
  function setSideWidth(side, target) {
    glide();
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
    setDefaults(opts.defaults.left, opts.defaults.right);
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
      // Gesture bookkeeping for the dblclick below (handle events bubble here
      // too). A pending tag that never met its click — a pointercancel ends a
      // drag without one — dies at the next press rather than mislabelling a
      // later pair.
      panel.addEventListener('pointerdown', () => { dragClickPending = false; });
      panel.addEventListener('click', (e) => {
        if (dragClickPending) {
          dragClickPending = false;
          dragInPair = true;
        } else if (e.detail <= 1) {
          dragInPair = false; // a plain first click: this pair is a gesture
        }
      });
      // ONE dblclick gesture for the whole sidebar surface, handle
      // included (it bubbles here; the readout is pointer-events:none):
      // plain double-click collapses the side, or restores it when it is
      // collapsed — at width 0 the edge handle IS the only remaining hit
      // area, so "double-click the sliver at the screen edge" falls out
      // naturally. Any modifier restores BOTH sides to the defaults,
      // matching the drag convention (modifier = both sides).
      panel.addEventListener('dblclick', (e) => {
        if (!callbacks) return;
        if (dragInPair) {
          dragInPair = false; // this pair of clicks was a resize, not a gesture
          return;
        }
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
          callbacks.onReset?.();
        } else if (widths[side] > 0) {
          setSideWidth(side, 0);
        } else {
          const other = side === 'left' ? 'right' : 'left';
          setSideWidth(side, SQZ.clampDrag(restoreTarget(side), widths[other]));
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
    // A drag in progress dies with its handle and never fires pointerup, so
    // clean up after it here: release the selection lock, and take .dragging
    // off before the slide-out — the class suppresses transitions, and
    // finish() can no longer remove it once `host` is nulled below.
    unlockSelection();
    host.classList.remove('dragging');
    clearTimeout(glideTimer);
    glideTimer = 0;
    // The preview's window listeners are the only thing this module leaves
    // outside its own shadow root, so they go before the panels do.
    hoverSide = null;
    dragSide = null;
    watchKeys(false);
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
    setDefaults,
    setAppearance,
    setVisible,
  };
})();
