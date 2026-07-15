// Reflows the page into the inner region by putting real margins on <html>.
// Inline styles are set through the CSSOM with priority 'important', which
// page CSP cannot block and which outranks every page rule, including the
// page's own inline !important declarations. A MutationObserver re-asserts
// the values if the page rewrites its style attribute wholesale.
var SQZ = globalThis.SQZ ??= {};

// ??= so re-injection (background's executeScript fallback racing the
// manifest injection) can't replace a live instance with a blank one while
// the booted orchestrator keeps calling through SQZ.*.
SQZ.squeeze ??= (() => {
  const PROPS = ['margin-left', 'margin-right', 'width'];

  let saved = null;    // Map prop -> {value, priority} captured before first apply
  let current = null;  // {left, right} while applied
  let observer = null;

  function targetValue(prop) {
    if (prop === 'width') return 'auto'; // defeat pages that set html{width:100%}
    return (prop === 'margin-left' ? current.left : current.right) + 'px';
  }

  // Write only when different so our own style mutations can't loop through
  // the observer.
  function assertStyles() {
    const style = document.documentElement.style;
    for (const prop of PROPS) {
      const want = targetValue(prop);
      if (style.getPropertyValue(prop) !== want
          || style.getPropertyPriority(prop) !== 'important') {
        style.setProperty(prop, want, 'important');
      }
    }
  }

  function apply(left, right) {
    if (!saved) {
      const style = document.documentElement.style;
      saved = new Map(PROPS.map((prop) => [prop, {
        value: style.getPropertyValue(prop),
        priority: style.getPropertyPriority(prop),
      }]));
    }
    current = { left, right };
    assertStyles();
  }

  function restore() {
    if (!saved) return;
    const style = document.documentElement.style;
    for (const prop of PROPS) {
      style.removeProperty(prop);
      const prior = saved.get(prop);
      if (prior.value) style.setProperty(prop, prior.value, prior.priority);
    }
    saved = null;
    current = null;
  }

  function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
      // An orphaned script (extension reloaded) must never re-assert against
      // a fresh script's margins — the guard tears this life down instead.
      if (SQZ.orphanGuard?.()) return;
      if (current) assertStyles();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
  }

  function unwatch() {
    observer?.disconnect();
    observer = null;
  }

  return { apply, update: apply, restore, watch, unwatch };
})();
