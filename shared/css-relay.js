// Pure helpers for the service worker's cross-origin CSS relay. Kept outside
// background.js so URL policy and import traversal have fast Node regressions
// as well as the browser-level coverage in test/e2e.mjs.
var SQZ = globalThis.SQZ ??= {};

SQZ.cssRelay ??= (() => {
  function privateV4(parts) {
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
      || (a === 169 && b === 254)           // link-local, metadata services
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)) // benchmark networks
      || a >= 224;                          // multicast and reserved space
  }

  // URL() canonicalizes unusual IPv4 spellings (integer/octal/hex) and IPv6,
  // but hostname still carries brackets around IPv6 literals in Chrome, and
  // it keeps the root label's trailing dot on registrable names (it strips
  // one only from IPv4 literals). "localhost." and "localhost" name the same
  // host to DNS and to the network stack but not to ===, so recognising only
  // one of them is a private-network bypass: a public page asking for
  // https://localhost.:8443/ would otherwise classify as a public target and
  // be relayed. Every host comparison and classification goes through here.
  function canonHost(hostname) {
    return String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  }

  // Takes an already-canonical host.
  function parseIp(host) {
    if (/^\d+(?:\.\d+){3}$/.test(host)) {
      return { v4: host.split('.').map(Number), v6: null };
    }
    if (!host.includes(':')) return { v4: null, v6: null };

    const halves = host.split('::');
    if (halves.length > 2) return { v4: null, v6: null };
    // A trailing dotted quad is legal IPv6 spelling (::ffff:8.8.8.8) and is
    // worth two words, not one: parseInt('8.8.8.8', 16) quietly yields 8,
    // which shifts every later word along and made the embedded-IPv4 read
    // land on the wrong pair — classifying public mapped addresses private.
    const readHalf = (part) => {
      if (!part) return [];
      const words = part.split(':');
      const last = words[words.length - 1];
      if (!last.includes('.')) return words.map((word) => parseInt(word, 16));
      if (!/^\d+(?:\.\d+){3}$/.test(last)) return null;
      const quad = last.split('.').map(Number);
      if (quad.some((n) => n > 255)) return null;
      return [
        ...words.slice(0, -1).map((word) => parseInt(word, 16)),
        (quad[0] << 8) | quad[1],
        (quad[2] << 8) | quad[3],
      ];
    };
    const left = readHalf(halves[0]);
    const right = readHalf(halves[1] ?? '');
    if (!left || !right) return { v4: null, v6: null };
    if ([...left, ...right].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
      return { v4: null, v6: null };
    }
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
      return { v4: null, v6: null };
    }
    return { v4: null, v6: [...left, ...Array(missing).fill(0), ...right] };
  }

  function isPrivateHost(hostname) {
    const host = canonHost(hostname);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    const { v4, v6 } = parseIp(host);
    if (v4) return privateV4(v4);
    if (!v6) return false; // DNS names need the HTTPS rule in relayable().

    const allZero = v6.every((word) => word === 0);
    const loopback = v6.slice(0, 7).every((word) => word === 0) && v6[7] === 1;
    const uniqueLocal = (v6[0] & 0xfe00) === 0xfc00; // fc00::/7
    const linkLocal = (v6[0] & 0xffc0) === 0xfe80;   // fe80::/10
    const multicast = (v6[0] & 0xff00) === 0xff00;   // ff00::/8
    const embeddedV4 = v6.slice(0, 5).every((word) => word === 0)
      && (v6[5] === 0 || v6[5] === 0xffff)
      ? [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff]
      : null;
    return allZero || loopback || uniqueLocal || linkLocal || multicast
      || (embeddedV4 !== null && privateV4(embeddedV4));
  }

  function httpUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/i.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  // Loopback answers to three spellings and a dev server is routinely reached
  // by more than one of them (localhost in the address bar, 127.0.0.1 in a
  // stylesheet href). They name the same machine, so the same-host rule below
  // counts them as one host rather than refusing the pair.
  function isLoopback(hostname) {
    const host = canonHost(hostname);
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    const { v4, v6 } = parseIp(host);
    if (v4) return v4[0] === 127;
    if (v6) return v6.slice(0, 7).every((word) => word === 0) && v6[7] === 1;
    return false;
  }

  // Private pages may relay only to the same private host (a different dev
  // port is fine, and the loopback spellings all count as that same host).
  // Public pages get HTTPS targets only: TLS authentication is the
  // DNS-rebinding boundary that hostname string checks cannot provide.
  function relayable(value, from) {
    const url = httpUrl(value);
    if (!url) return false;
    const targetPrivate = isPrivateHost(url.hostname);
    const asker = httpUrl(from);
    // An asker that is not http(s) — a file:// page (a documented mode), an
    // opaque origin — is treated as public rather than refused outright: it
    // gets exactly what any public page gets, public HTTPS and nothing
    // private. Refusing it instead silently turned the relay off there.
    if (!asker) return !targetPrivate && url.protocol === 'https:';
    const askerPrivate = isPrivateHost(asker.hostname);
    if (targetPrivate) {
      return askerPrivate
        && (canonHost(url.hostname) === canonHost(asker.hostname)
          || (isLoopback(url.hostname) && isLoopback(asker.hostname)));
    }
    if (askerPrivate) return true;
    return url.protocol === 'https:';
  }

  // Rewrite url(...) references (and any @import url left behind) to be
  // absolute. Skip absolute schemes, data:/blob:, protocol-relative //, and
  // bare #fragments (same-document SVG paint servers must stay relative).
  function absolutizeCssUrls(text, baseUrl) {
    const resolve = (value) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value) || value === '') return null;
      try { return new URL(value, baseUrl).href; } catch { return null; }
    };
    text = text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
      (match, doubleQuoted, singleQuoted, bare) => {
        const absolute = resolve(doubleQuoted ?? singleQuoted ?? bare);
        return absolute === null ? match : `url("${absolute.replace(/"/g, '%22')}")`;
      });
    return text.replace(/(@import\s+)(?:"([^"]*)"|'([^']*)')/gi,
      (match, head, doubleQuoted, singleQuoted) => {
        const absolute = resolve(doubleQuoted ?? singleQuoted);
        return absolute === null ? match : `${head}"${absolute.replace(/"/g, '%22')}"`;
      });
  }

  // Only @charset, @layer statements and @import may precede ordinary rules,
  // so a small leading-rule scan is sufficient here.
  function splitCssImports(text) {
    const imports = [];
    let prefix = '';
    let index = 0;
    for (;;) {
      const whitespace = /^(?:\s+|\/\*[\s\S]*?\*\/)+/.exec(text.slice(index));
      if (whitespace) index += whitespace[0].length;
      const rest = text.slice(index);
      let match;
      if ((match = /^@charset\s+"[^"]*"\s*;/i.exec(rest))) {
        index += match[0].length; // dropped: fetch has already decoded the text
      } else if ((match = /^@layer\s+[^{;]*;/i.exec(rest))) {
        prefix += match[0] + '\n';
        index += match[0].length;
      } else if ((match = /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/i.exec(rest))) {
        imports.push({
          url: (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim(),
          tail: match[6].trim(),
          raw: match[0],
        });
        index += match[0].length;
      } else {
        break;
      }
    }
    return { prefix, imports, body: text.slice(index) };
  }

  function wrapImportedCss(text, tail) {
    let media = tail;
    const layer = /^layer(?:\(([^)]*)\))?\s*/i.exec(media);
    if (layer) media = media.slice(layer[0].length);
    const supports = /^supports\(((?:[^()]|\([^()]*\))*)\)\s*/i.exec(media);
    if (supports) media = media.slice(supports[0].length);
    media = media.trim();
    if (media && media.toLowerCase() !== 'all') text = `@media ${media} {\n${text}\n}`;
    if (supports) text = `@supports ${supports[1]} {\n${text}\n}`;
    if (layer) text = `@layer ${layer[1] ? layer[1].trim() + ' ' : ''}{\n${text}\n}`;
    return text;
  }

  // active is the current recursion path, not a global visited set. Repeating
  // one child at two cascade locations must emit it twice; only a true cycle
  // back into an ancestor is dropped. `cache` is what keeps that from costing
  // a fetch per occurrence: a design system whose every partial imports one
  // variables.css is the common shape, and refetching per occurrence goes
  // exponential in the depth — enough to outlive the MV3 worker and lose the
  // reply, while hammering the origin. Text (and a failure) is remembered for
  // the life of one relay call, so the budget is charged once per URL too.
  async function inlineCss(url, budget, depth, active, from, fetchFile, cache = new Map()) {
    if (active.has(url)) return '';
    active.add(url);
    try {
      let source;
      if (cache.has(url)) {
        source = cache.get(url);
      } else {
        source = await fetchFile(url, budget, from);
        if (source !== null) source = absolutizeCssUrls(source, url);
        cache.set(url, source);
      }
      if (source === null) return null;
      const { prefix, imports, body } = splitCssImports(source);
      let output = prefix;
      for (const imported of imports) {
        const child = depth > 0 && /^https?:/i.test(imported.url)
          ? await inlineCss(imported.url, budget, depth - 1, active, from, fetchFile, cache)
          : null;
        output += (child === null ? imported.raw : wrapImportedCss(child, imported.tail)) + '\n';
      }
      return output + body;
    } finally {
      active.delete(url);
    }
  }

  return {
    absolutizeCssUrls,
    inlineCss,
    isPrivateHost,
    relayable,
    splitCssImports,
    wrapImportedCss,
  };
})();
