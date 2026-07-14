// Best-effort "squeeze" for full-width elements the <html> margins can't
// reach: position:fixed boxes (navbars, cookie banners) are laid out against
// the viewport, and position:absolute boxes with no positioned ancestor
// (SPA app shells like claude.ai's `absolute inset-0` root) are anchored to
// the initial containing block — both ignore the margin squeeze. Qualifying
// elements get inline left/right insets matching the sidebars instead.
// Sticky elements are normal flow and are never touched.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.fixedBars ??= (() => {
  const PROPS = ['left', 'right', 'width'];
  const FULL_WIDTH_RATIO = 0.9; // rect must span >= 90% of the viewport
  const INLINE_SCAN_MAX = 200;  // bigger added subtrees go to the idle queue

  const managed = new Map();    // Element -> saved inline {value, priority} per prop
  let widths = null;            // {left, right} while running, else null
  let excluded = () => false;   // predicate; the panels host must never be adopted
  let observer = null;
  let idleHandle = 0;
  let queue = [];
  let queueIndex = 0;
  let rescanTimer = 0;

  // Absolute boxes must be anchored to the initial containing block to be
  // adoptable. Anything below a positioned/transformed ancestor moves with
  // that ancestor — insetting it too would compound the squeeze (nested
  // app-shell layers would shrink the content once per level).
  function anchoredToViewport(el) {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      let cs;
      try { cs = getComputedStyle(a); } catch { return false; }
      if (cs.position !== 'static'
          || cs.transform !== 'none'
          || cs.filter !== 'none'
          || cs.perspective !== 'none'
          || /transform|perspective|filter/.test(cs.willChange || '')
          || /layout|paint|strict|content/.test(cs.contain || '')) return false;
    }
    return true;
  }

  function qualifies(el) {
    if (el.nodeType !== Node.ELEMENT_NODE
        || el === document.documentElement
        || excluded(el)) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch { return false; }
    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'absolute') return false;
    // Only full-width boxes. Narrower fixed widgets (chat buttons, side
    // drawers) are left alone and simply sit under the opaque panels.
    // <body> itself can qualify: modal scroll-locks often fix it, and since
    // fixed boxes ignore the html margins, insetting it is the correct
    // single squeeze, not a double one.
    const rect = el.getBoundingClientRect();
    const vw = SQZ.viewportWidth();
    if (rect.width < vw * FULL_WIDTH_RATIO) return false;
    // Adopt only boxes that visibly ESCAPE the squeeze (margins are applied
    // before any scan runs). Properly reflowed content — and anything that
    // follows an already-inset ancestor — starts at the margin and never
    // trips this.
    if (!(rect.left < widths.left - 1 || rect.right > vw - widths.right + 1)) return false;
    if (pos === 'fixed') return true; // viewport-anchored by definition
    return anchoredToViewport(el);
  }

  function assertOne(el) {
    const want = { left: widths.left + 'px', right: widths.right + 'px', width: 'auto' };
    for (const prop of PROPS) {
      // Write only if different so our own attribute mutations can't loop.
      if (el.style.getPropertyValue(prop) !== want[prop]
          || el.style.getPropertyPriority(prop) !== 'important') {
        el.style.setProperty(prop, want[prop], 'important');
      }
    }
  }

  function adopt(el) {
    const priors = {};
    for (const prop of PROPS) {
      priors[prop] = {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      };
    }
    managed.set(el, priors);
    assertOne(el);
  }

  function release(el) {
    const priors = managed.get(el);
    if (!priors) return;
    managed.delete(el);
    for (const prop of PROPS) {
      el.style.removeProperty(prop);
      if (priors[prop].value) el.style.setProperty(prop, priors[prop].value, priors[prop].priority);
    }
  }

  function consider(el) {
    if (!managed.has(el) && qualifies(el)) adopt(el);
  }

  function reconsider(el) {
    if (!managed.has(el)) {
      consider(el);
      return;
    }
    // Managed elements never re-run the width/escape tests: once inset,
    // their rect is (viewport - left - right) wide, which fails those checks
    // by construction and would flap adopt/release forever. They are
    // released only when they leave the DOM or stop being fixed/absolute.
    let keep = false;
    if (el.isConnected) {
      try {
        const pos = getComputedStyle(el).position;
        keep = pos === 'fixed' || pos === 'absolute';
      } catch {}
    }
    if (keep) assertOne(el); // page rewrote its inline style: re-assert
    else release(el);
  }

  function pump() {
    if (idleHandle) return;
    idleHandle = requestIdleCallback((deadline) => {
      idleHandle = 0;
      let budget = 300; // minimum progress even when the page never idles
      // Strict document order (parents before children): a parent adopted
      // first is already inset when its descendants are measured, so they
      // no longer escape the squeeze and can't be adopted on top of it.
      while (queueIndex < queue.length && (budget-- > 0 || deadline.timeRemaining() > 5)) {
        consider(queue[queueIndex++]);
      }
      if (queueIndex < queue.length) {
        pump();
      } else {
        queue = [];
        queueIndex = 0;
      }
    }, { timeout: 500 });
  }

  function scanAll() {
    queue = Array.prototype.slice.call(document.getElementsByTagName('*'));
    queueIndex = 0;
    pump();
  }

  function onMutations(mutations) {
    if (!widths) return;
    let removedAny = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        reconsider(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        consider(node);
        const kids = node.querySelectorAll('*');
        if (kids.length <= INLINE_SCAN_MAX) {
          for (const kid of kids) consider(kid);
        } else {
          // No spread into push(): a six-figure NodeList would blow the
          // engine's argument-count limit.
          for (const kid of kids) queue.push(kid);
          pump();
        }
      }
      removedAny ||= m.removedNodes.length > 0;
    }
    if (removedAny) {
      // managed is tiny (a handful of bars at most), so a full prune is cheap.
      for (const el of [...managed.keys()]) {
        if (!el.isConnected) release(el); // restoring a detached node is harmless
      }
    }
  }

  function start(left, right, isExcluded) {
    stop();
    widths = { left, right };
    excluded = isExcluded ?? (() => false);
    scanAll();
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  function update(left, right) {
    if (!widths) return;
    widths = { left, right };
    for (const el of [...managed.keys()]) {
      if (el.isConnected) assertOne(el);
      else release(el);
    }
    // Viewport resizes move the 90% threshold; rescan once things settle.
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(scanAll, 300);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (idleHandle) {
      cancelIdleCallback(idleHandle);
      idleHandle = 0;
    }
    queue = [];
    queueIndex = 0;
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    for (const el of [...managed.keys()]) release(el);
    widths = null;
  }

  return { start, update, stop };
})();
