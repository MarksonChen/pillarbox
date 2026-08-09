// The width-shift transform shared by both breakpoint shifters:
// content/media-queries.js rewrites stylesheet media text in the ISOLATED
// world, and content/match-media.js applies the same shift to
// window.matchMedia queries in the MAIN world. Both manifest entries load
// this file, so the two sides can never drift.
//
// It hangs off its own global rather than SQZ: in the main world SQZ could
// collide with the page's own code, so match-media.js consumes this global
// and deletes it before any page script runs (document_start; created by
// assignment, not `var`, so the property stays configurable/deletable). In
// the isolated world it persists alongside SQZ. Everything here is pure —
// no chrome.*, no DOM reads; the viewport is passed in.
globalThis.__pillarboxMqShift ??= (() => {
  // A feature VALUE: calc()/min()/max()/clamp() with up to three nesting
  // levels, or one dimension token (700px, 40em, 0). The lookbehinds keep
  // `device-width` (physical screen, must not shift) out: its `width` is
  // preceded by `-`, and `min-device-width` never parses as `min-` + width.
  const BAL2 = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
  const VALUE = String.raw`(?:(?:calc|min|max|clamp)\(${BAL2}\)|[\d.]+[a-z%]*)`;
  const OP = String.raw`(?:<=|>=|<|>|=)`;
  const RX_COLON = new RegExp(String.raw`((?<![-\w])(?:min-|max-)?width\s*:\s*)(${VALUE})`, 'gi');
  const RX_AFTER = new RegExp(String.raw`((?<![-\w])width\s*${OP}\s*)(${VALUE})`, 'gi');
  const RX_BEFORE = new RegExp(String.raw`(${VALUE})(\s*${OP}\s*width(?![-\w]))`, 'gi');
  const RX_ORIENT = /(?<![-\w])orientation\s*:\s*(portrait|landscape)(?![-\w])/gi;
  const RX_ASPECT = /(?<![-\w])(min-|max-)?aspect-ratio\s*:\s*([\d.]+)\s*(?:\/\s*([\d.]+))?/gi;
  // aspect-ratio also takes MQ4 range context, which Chrome parses and keeps
  // in range form. Three shapes, and the chained one must be substituted
  // FIRST: replacing either half of `(4/3 < aspect-ratio < 16/9)` on its own
  // would leave the other half comparing against a constant.
  const RATIO = String.raw`[\d.]+(?:\s*\/\s*[\d.]+)?`;
  const RX_AR_CHAIN = new RegExp(
    String.raw`(${RATIO})\s*(${OP})\s*aspect-ratio\s*(${OP})\s*(${RATIO})`, 'gi');
  const RX_AR_AFTER = new RegExp(
    String.raw`(?<![-\w])aspect-ratio\s*(${OP})\s*(${RATIO})`, 'gi');
  const RX_AR_BEFORE = new RegExp(
    String.raw`(${RATIO})\s*(${OP})\s*aspect-ratio(?![-\w])`, 'gi');

  // A media ratio is `a` or `a / b`; anything else is left alone.
  const parseRatio = (text) => {
    const m = /^([\d.]+)(?:\s*\/\s*([\d.]+))?$/.exec(text.trim());
    if (!m) return NaN;
    const b = m[2] === undefined ? 1 : parseFloat(m[2]);
    return b > 0 ? parseFloat(m[1]) / b : NaN;
  };

  const cmp = (left, op, right) => {
    switch (op) {
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      default: return Math.abs(left - right) < 1e-9;
    }
  };

  // A unitless 0 is a valid media-feature length but cannot join a calc()
  // sum as a bare number.
  const wrap = (v, s) => `calc(${/^0+(\.0*)?$/.test(v) ? v + 'px' : v} + ${s}px)`;

  // Constants must be width-free: a min-width tautology would be re-shifted
  // by the width passes (or broken by a later update); height features pass
  // through everything untouched.
  const MQ_TRUE = 'min-height: 0px';
  const MQ_FALSE = 'min-height: 999999px';

  // Shift every width feature in `text` by s px — `(max-width: W)` becomes
  // `(max-width: calc(W + Spx))`, the same shift for min-width, exact width
  // and both ends of range syntax, wrapped in calc() so em/rem breakpoints
  // keep their unit. orientation and aspect-ratio (colon and range forms
  // alike) cannot be shifted by a length, so they are substituted with a
  // constant that holds for the effective viewport; callers re-run the
  // transform on resize.
  //
  // vw/vh are the caller's innerWidth/innerHeight — innerWidth on purpose:
  // media-query width includes the classic scrollbar, so the effective width
  // the page "should" see is innerWidth - S, not clientWidth - S; the
  // scrollbar offset between MQ width and content width exists natively and
  // sites already design around it.
  function shiftMediaText(text, s, vw, vh) {
    if (!s) return text;
    // Chain order matters only in that each pass must not create text a
    // later pass would re-match; shifted values contain no bare `width`
    // ident and the env constants are height-based.
    let out = text.replace(RX_BEFORE, (m, v, rest) => wrap(v, s) + rest);
    out = out.replace(RX_AFTER, (m, head, v) => head + wrap(v, s));
    out = out.replace(RX_COLON, (m, head, v) => head + wrap(v, s));
    const effW = vw - s;
    const portrait = vh >= effW;
    out = out.replace(RX_ORIENT, (m, o) =>
      ((o.toLowerCase() === 'portrait') === portrait ? MQ_TRUE : MQ_FALSE));
    const ar = effW / Math.max(1, vh);
    out = out.replace(RX_ASPECT, (m, mm, a, b) => {
      const r = parseFloat(a) / (b ? parseFloat(b) : 1);
      if (!Number.isFinite(r) || r <= 0) return m;
      const kind = (mm || '').toLowerCase();
      const ok = kind === 'min-' ? ar >= r
        : kind === 'max-' ? ar <= r
          : Math.abs(ar - r) < 1e-9;
      return ok ? MQ_TRUE : MQ_FALSE;
    });
    // The width passes above cannot touch these (no bare `width` ident) and
    // the constants they leave behind are height-based, so range-form
    // aspect-ratio is safe to substitute last.
    out = out.replace(RX_AR_CHAIN, (m, lo, op1, op2, hi) => {
      const l = parseRatio(lo);
      const h = parseRatio(hi);
      if (!Number.isFinite(l) || !Number.isFinite(h)) return m;
      return cmp(l, op1, ar) && cmp(ar, op2, h) ? MQ_TRUE : MQ_FALSE;
    });
    out = out.replace(RX_AR_AFTER, (m, op, r) => {
      const v = parseRatio(r);
      return Number.isFinite(v) ? (cmp(ar, op, v) ? MQ_TRUE : MQ_FALSE) : m;
    });
    out = out.replace(RX_AR_BEFORE, (m, r, op) => {
      const v = parseRatio(r);
      return Number.isFinite(v) ? (cmp(v, op, ar) ? MQ_TRUE : MQ_FALSE) : m;
    });
    return out;
  }

  return {
    // isolated -> main announcement; detail is the shift total in CSS px.
    EVENT: 'pillarbox-mq-shift',
    // Cheap prefilter: anything shiftMediaText COULD act on. Over-matching
    // is fine (a device-width query runs the transform and comes back
    // unchanged); missing something here would silently skip it.
    ANY: /width|orientation|aspect-ratio/i,
    shiftMediaText,
  };
})();
