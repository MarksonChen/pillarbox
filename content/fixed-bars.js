// Best-effort "squeeze" for full-width elements the <html> margins can't
// reach. Three kinds of box escape the margin squeeze:
//   - position:fixed boxes (navbars, cookie banners) are laid out against
//     the viewport -> inset with left/right matching the sidebars.
//   - position:absolute boxes with no positioned ancestor (SPA app shells
//     like claude.ai's `absolute inset-0` root) are anchored to the initial
//     containing block -> same insets.
//   - normal-flow boxes sized with viewport units (`width:100vw` app shells:
//     chatgpt.com, notion.so) or pulled out by the full-bleed idiom
//     `margin-inline: calc(0px - (50vw - 50%))` (reddit's header). Viewport
//     units ignore every ancestor width -> override with width:auto (and
//     zero the negative margins) so the box tracks its squeezed parent.
// Sticky elements are normal flow and reflow on their own; they are only
// touched if they escape like any other flow box.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection can't replace a live instance (see squeeze.js).
SQZ.fixedBars ??= (() => {
  const FULL_WIDTH_RATIO = 0.9; // rect must span >= 90% of the viewport
  const INLINE_SCAN_MAX = 200;  // bigger added subtrees go to the idle queue
  // Inline marker on every adopted element so a later life of this content
  // script (extension reload) can find and strip stale overrides exactly.
  const MARKER = '--pillarbox';

  const managed = new Map();    // Element -> {mode, want, priors}
  let rejected = new WeakSet(); // flow candidates our overrides couldn't fix
  let widths = null;            // {left, right} while running, else null
  let excluded = () => false;   // predicate; the panels host must never be adopted
  let observer = null;
  let idleHandle = 0;
  let queue = [];
  let queueIndex = 0;
  let rescanTimer = 0;

  function escapes(rect, vw) {
    return rect.left < widths.left - 1 || rect.right > vw - widths.right + 1;
  }

  // Positioning category: fixed/absolute boxes ignore the html margins and
  // need viewport insets; anything else is normal flow and gets width
  // overrides. classify() and reconsider() must agree on this split.
  function modeOf(position) {
    return position === 'fixed' || position === 'absolute' ? 'inset' : 'flow';
  }

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

  // Decide how to adopt an element; null leaves it alone. Candidates must
  // span >= 90% of the viewport AND visibly escape the squeeze (margins are
  // applied before any scan runs, so properly reflowed content — and
  // anything below an already-adopted ancestor, thanks to the document-order
  // scan — never trips the escape test). Narrower fixed widgets (chat
  // buttons, side drawers) are left alone and sit under the opaque panels.
  function classify(el) {
    if (el.nodeType !== Node.ELEMENT_NODE
        || el === document.documentElement
        || excluded(el)) return null;
    const vw = SQZ.viewportWidth();
    const rect = el.getBoundingClientRect();
    if (rect.width < vw * FULL_WIDTH_RATIO || !escapes(rect, vw)) return null;
    let cs;
    try { cs = getComputedStyle(el); } catch { return null; }
    // <body> itself can qualify: modal scroll-locks often fix it, and since
    // fixed boxes ignore the html margins, insetting it is the correct
    // single squeeze, not a double one.
    if (modeOf(cs.position) === 'inset') {
      if (cs.position === 'absolute' && !anchoredToViewport(el)) return null;
      return { mode: 'inset' };
    }
    // Normal flow. Width overrides only make sense on HTML block-level boxes.
    if (!(el instanceof HTMLElement) || cs.display === 'inline') return null;
    const want = { width: 'auto' };
    if (parseFloat(cs.minWidth) >= vw * FULL_WIDTH_RATIO) want['min-width'] = '0px';
    for (const side of ['left', 'right']) {
      const margin = parseFloat(side === 'left' ? cs.marginLeft : cs.marginRight);
      if (margin < -0.5) {
        want['margin-' + side] = '0px';
        // The full-bleed idiom pairs the negative margin with an equal
        // padding; zeroing both restores the intended content position.
        const pad = parseFloat(side === 'left' ? cs.paddingLeft : cs.paddingRight);
        if (Math.abs(pad + margin) < 1) want['padding-' + side] = '0px';
      }
    }
    return { mode: 'flow', want };
  }

  function desired(entry) {
    const base = entry.mode === 'inset'
      ? { left: widths.left + 'px', right: widths.right + 'px', width: 'auto' }
      : entry.want;
    return { ...base, [MARKER]: '1' };
  }

  function assertOne(el, entry) {
    for (const [prop, value] of Object.entries(desired(entry))) {
      // Write only if different so our own attribute mutations can't loop.
      if (el.style.getPropertyValue(prop) !== value
          || el.style.getPropertyPriority(prop) !== 'important') {
        el.style.setProperty(prop, value, 'important');
      }
    }
  }

  function adopt(el, spec) {
    const entry = { mode: spec.mode, want: spec.want, priors: {} };
    for (const prop of Object.keys(desired(entry))) {
      entry.priors[prop] = {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      };
    }
    managed.set(el, entry);
    assertOne(el, entry);
    // Flow overrides are a guess: the box may be wide for reasons width
    // can't fix (a table sized by unbreakable content, say). Verify, and
    // back out of adoptions that changed nothing.
    if (entry.mode === 'flow'
        && escapes(el.getBoundingClientRect(), SQZ.viewportWidth())) {
      release(el);
      rejected.add(el);
    }
  }

  function release(el) {
    const entry = managed.get(el);
    if (!entry) return;
    managed.delete(el);
    for (const [prop, prior] of Object.entries(entry.priors)) {
      el.style.removeProperty(prop);
      if (prior.value) el.style.setProperty(prop, prior.value, prior.priority);
    }
  }

  function consider(el) {
    if (managed.has(el) || rejected.has(el)) return;
    const spec = classify(el);
    if (spec) adopt(el, spec);
  }

  function reconsider(el) {
    const entry = managed.get(el);
    if (!entry) {
      // NB: rejected elements stay rejected (until the next start()). The
      // adopt -> verify -> release round-trip mutates the style attribute,
      // so clearing the flag here would re-adopt in the observer callback
      // and loop forever.
      consider(el);
      return;
    }
    // Managed elements never re-run the width/escape tests: once adopted,
    // their rect no longer escapes by construction, which would flap
    // adopt/release forever. They are released only when they leave the DOM
    // or change positioning category (inset <-> flow).
    if (!el.isConnected) {
      release(el);
      return;
    }
    let pos = null;
    try { pos = getComputedStyle(el).position; } catch {}
    const mode = pos ? modeOf(pos) : null;
    if (mode === entry.mode) {
      assertOne(el, entry); // page rewrote its inline style: re-assert
    } else {
      release(el);
      if (mode) consider(el); // e.g. a bar just turned fixed: adopt fresh
    }
  }

  // A class/style change anywhere can turn an element into the containing
  // block (positioned/transformed) of a managed absolute box. Its insets
  // would then resolve against that ancestor — which the html margins
  // already squeeze — and compound. Release such boxes; classify() refuses
  // non-anchored absolutes, so nothing re-adopts them.
  function recheckAnchors(changedEls) {
    for (const [el, entry] of managed) {
      if (entry.mode !== 'inset') continue;
      let pos = null;
      try { pos = getComputedStyle(el).position; } catch {}
      if (pos !== 'absolute') continue;
      let underChanged = false;
      for (const changed of changedEls) {
        if (changed !== el && changed.contains(el)) { underChanged = true; break; }
      }
      if (underChanged && !anchoredToViewport(el)) release(el);
    }
  }

  function pump() {
    if (idleHandle) return;
    idleHandle = requestIdleCallback((deadline) => {
      idleHandle = 0;
      let budget = 300; // minimum progress even when the page never idles
      // Strict document order (parents before children): a parent adopted
      // first is already squeezed when its descendants are measured, so they
      // no longer escape and can't be adopted on top of it.
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
    // Same orphan rule as the squeeze watcher: never fight a fresh script.
    if (SQZ.orphanGuard?.()) return;
    if (!widths) return;
    let removedAny = false;
    let attrTargets = null;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        reconsider(m.target);
        (attrTargets ??= new Set()).add(m.target);
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
    if (attrTargets) recheckAnchors(attrTargets);
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
    rejected = new WeakSet();
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
      if (el.isConnected) assertOne(el, managed.get(el));
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
