import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// The clamp helpers in defaults.js read the layout viewport off the DOM, so
// the sandbox carries the least of one that answers: a 1000px standards-mode
// viewport with a 15px classic scrollbar beside it.
const context = vm.createContext({
  URL,
  document: { compatMode: 'CSS1Compat', documentElement: { clientWidth: 1000 } },
  innerWidth: 1015,
});
for (const file of ['shared/defaults.js', 'shared/css-relay.js', 'shared/mq-shift.js']) {
  vm.runInContext(read(file), context, { filename: file });
}

const sqz = context.SQZ;
const relay = sqz.cssRelay;
const shift = context.__pillarboxMqShift;
const manifest = JSON.parse(read('manifest.json'));

// ---- the copies that must agree -------------------------------------------
// Each of these exists in more than one file because the platform leaves no
// way to share it, and drift between the copies fails silently: a script
// missing from one list simply never runs there. Nothing but a test can make
// that loud, and it costs nothing to ask on every `npm run check`.

test('the three copies of the content-script file lists agree', () => {
  const [isolated, main] = manifest.content_scripts;
  assert.deepEqual(isolated.js, [...sqz.CONTENT_FILES], 'manifest [0] vs SQZ.CONTENT_FILES');
  assert.deepEqual(main.js, [...sqz.MAIN_WORLD_FILES], 'manifest [1] vs SQZ.MAIN_WORLD_FILES');
  assert.equal(main.world, 'MAIN');
  // The options page runs live pillars on itself, so it loads the same
  // isolated-world files in the same order — and must never load the
  // MAIN-world hook, whose width lie would feed back into the clamp math.
  const scripts = [...read('options/options.html').matchAll(/<script src="\.\.\/([^"]+)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(scripts, [...sqz.CONTENT_FILES], 'options.html vs SQZ.CONTENT_FILES');
  assert.ok(!scripts.includes('content/match-media.js'), 'options.html loads match-media.js');
});

test('the version and the suggested shortcut read the same wherever they are written', () => {
  assert.equal(JSON.parse(read('package.json')).version, manifest.version);
  const suggested = /const SUGGESTED_SHORTCUT = '([^']+)'/.exec(read('options/options.js'))?.[1];
  assert.equal(suggested, manifest.commands._execute_action.suggested_key.default);
});

test('tint presets are lowercase #rrggbb, unique, and lead with the shipped default', () => {
  // Lowercase is not style: the editor marks the swatch in use by comparing
  // against <input type="color">.value, which is always lowercase, so a
  // preset spelled any other way could never show as selected.
  const block = /const TINT_PRESETS = \{([\s\S]*?)\n\};/.exec(read('options/options.js'))[1];
  for (const [side, setting] of [['light', 'colorLight'], ['dark', 'colorDark']]) {
    const list = new RegExp(`${side}: \\[([\\s\\S]*?)\\]`).exec(block)[1]
      .match(/'[^']*'/g).map((quoted) => quoted.slice(1, -1));
    for (const hex of list) assert.match(hex, /^#[0-9a-f]{6}$/, `${side}: ${hex}`);
    assert.equal(new Set(list).size, list.length, `${side}: a swatch is listed twice`);
    assert.equal(list[0], sqz.DEFAULT_SETTINGS[setting], `${side}: the default leads`);
  }
});

// ---- shared/defaults.js ----------------------------------------------------

test('rules match origin + path + query: regex by default, substring literally', () => {
  const rules = [
    { pattern: '([', left: 1, right: 1 },                       // invalid: skipped
    { pattern: '', left: 2, right: 2 },                         // empty: skipped
    { pattern: 'example.com/a?b=1', mode: 'substring', left: 3, right: 3 },
    { pattern: 'example\\.com/a', left: 4, right: 4 },          // regex, unanchored
    { pattern: 'example', left: 5, right: 5 },                  // also matches; loses
  ];
  assert.equal(sqz.findRule(rules, 'https://example.com/a?b=1#frag').left, 3);
  assert.equal(sqz.findRule(rules, 'https://example.com/a/deeper').left, 4);
  assert.equal(sqz.findRule(rules, 'https://example.org/').left, 5);
  assert.equal(sqz.findRule(rules, 'https://other.test/'), null);
  // The #hash is clipped before matching, exactly as pageKey clips it.
  assert.equal(sqz.findRule([{ pattern: 'frag' }], 'https://other.test/#frag'), null);
  assert.equal(sqz.findRule(undefined, 'https://example.com/'), null);
  assert.equal(sqz.pageKey('https://example.com/a?b=1#frag'), 'page:https://example.com/a?b=1');
});

test('a matched rule is narrowed to its two widths and nothing else', () => {
  // Callers spread this straight into a page record, so a rule's own
  // bookkeeping must not ride along into stored per-page state.
  const rule = { pattern: 'x', mode: 'substring', autoShow: true, left: '425', right: -3 };
  const widths = sqz.matchRule([rule], 'https://x.test/');
  assert.deepEqual(Object.keys(widths), ['left', 'right']);
  assert.deepEqual({ ...widths }, { left: 425, right: 0 });
  assert.equal(sqz.matchRule([rule], 'https://other.test/'), null);
});

test('fields absent from a stored rule or settings mean the pre-field behaviour', () => {
  assert.equal(sqz.ruleMode({ pattern: 'x' }), 'regex');
  assert.equal(sqz.ruleMode({ pattern: 'x', mode: 'substring' }), 'substring');
  assert.equal(sqz.ruleMode({ pattern: 'x', mode: 'glob' }), 'regex');
  assert.equal(sqz.ruleAutoShow({ pattern: 'x' }), false);
  assert.equal(sqz.ruleAutoShow({ pattern: 'x', autoShow: 'yes' }), false);
  assert.equal(sqz.ruleAutoShow({ pattern: 'x', autoShow: true }), true);
  const merged = sqz.mergeSettings({ theme: 'dark' });
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.jsBreakpoints, true);
  assert.equal(merged.defaultLeft, sqz.DEFAULT_SETTINGS.defaultLeft);
});

test('width clamps leave MIN_GAP of page and never round a px into existence', () => {
  // 1000px of layout viewport (the scrollbar's 15 excluded) minus the 200px
  // gap is an 800px budget.
  assert.deepEqual({ ...sqz.clampPair(300, 100) }, { left: 300, right: 100 });
  assert.deepEqual({ ...sqz.clampPair(600, 600) }, { left: 400, right: 400 });
  assert.deepEqual({ ...sqz.clampPair(901, 300) }, { left: 600, right: 199 });
  assert.deepEqual({ ...sqz.clampPair('junk', -5) }, { left: 0, right: 0 });
  assert.equal(sqz.clampDrag(900, 300), 500);
  assert.equal(sqz.clampDrag(-20, 300), 0);
  assert.equal(sqz.mirrorWidth(900), 400);
  // A slide conserves the pair's total: the dragged side runs from 0 to it
  // and the far side is whatever is left — never a px more, so the page
  // moves without changing width and stops at either border.
  assert.deepEqual({ ...sqz.slidePair(386, 580) }, { near: 386, far: 194 });
  assert.deepEqual({ ...sqz.slidePair(900, 580) }, { near: 580, far: 0 });
  assert.deepEqual({ ...sqz.slidePair(-5, 580) }, { near: 0, far: 580 });
  assert.deepEqual({ ...sqz.slidePair(100, 900) }, { near: 100, far: 700 }); // capped to the budget
  assert.equal(sqz.clampDefault('12.6'), 13);
  assert.equal(sqz.clampDefault(-1), 0);
  // Stored px are px at 100% zoom; the two boundary conversions round-trip.
  assert.equal(sqz.storedToCss(320, 2), 160);
  assert.equal(sqz.cssToStored(160, 2), 320);
  assert.equal(sqz.sanitizeZoom(0), 1);
});

test('the echo filter matches own writes by content and consumes them once', () => {
  const echoes = sqz.makeEchoes();
  const stamp = echoes.add({ on: true, left: 1 });
  assert.equal(echoes.own({ on: true, left: 2 }), false);
  assert.equal(echoes.own({ on: true, left: 1 }), true);
  assert.equal(echoes.own({ on: true, left: 1 }), false, 'consumed by the first match');
  echoes.drop(echoes.add({ failed: true }));
  assert.equal(echoes.own({ failed: true }), false, 'a dropped stamp matches nothing');
  assert.equal(typeof stamp, 'string');
});

// ---- shared/css-relay.js ---------------------------------------------------

test('private-address classifier covers IPv4, IPv6 ranges, and mapped IPv4', () => {
  for (const host of [
    '127.0.0.1',
    '10.2.3.4',
    '100.64.1.2',
    '169.254.169.254',
    '192.168.1.4',
    'fe90::1',
    'fd12::1',
    '::1',
    '::ffff:c0a8:101',
  ]) {
    assert.equal(relay.isPrivateHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '2001:4860:4860::8888', 'cdn.example']) {
    assert.equal(relay.isPrivateHost(host), false, host);
  }
});

test('the root label\'s trailing dot does not hide a private host', () => {
  // URL() keeps the dot on registrable names (it strips one only from IPv4
  // literals), so `localhost.` reached the classifier verbatim and was read
  // as a public DNS name — a public page could then relay to loopback.
  for (const host of ['localhost.', 'foo.localhost.', 'box.local.', '127.0.0.1.']) {
    assert.equal(relay.isPrivateHost(host), true, host);
  }
  assert.equal(
    relay.relayable('https://localhost.:8443/secret.css', 'https://evil.example/'),
    false,
  );
  assert.equal(relay.relayable('https://box.local./x.css', 'https://evil.example/'), false);
});

test('IPv6 written with an embedded dotted quad classifies by its real address', () => {
  // parseInt('8.8.8.8', 16) is 8, which used to shift every later word along
  // and make the embedded-IPv4 read land on the wrong pair.
  assert.equal(relay.isPrivateHost('::ffff:8.8.8.8'), false);
  assert.equal(relay.isPrivateHost('::ffff:1.2.3.4'), false);
  assert.equal(relay.isPrivateHost('::ffff:127.0.0.1'), true);
  assert.equal(relay.isPrivateHost('::ffff:192.168.1.1'), true);
  assert.equal(relay.isPrivateHost('64:ff9b::192.0.2.1'), false);
});

test('a non-http asker reaches public HTTPS and nothing private', () => {
  // file:// pages are a documented mode; refusing an unparseable asker
  // outright turned the relay off there entirely.
  assert.equal(relay.relayable('https://cdn.example/app.css', 'file:///tmp/page.html'), true);
  assert.equal(relay.relayable('http://cdn.example/app.css', 'file:///tmp/page.html'), false);
  assert.equal(relay.relayable('http://127.0.0.1:8124/x.css', 'file:///tmp/page.html'), false);
  assert.equal(relay.relayable('https://localhost./x.css', 'file:///tmp/page.html'), false);
});

test('loopback spellings count as one host for private relays', () => {
  assert.equal(relay.relayable('http://127.0.0.1:3000/app.css', 'http://localhost:3000/p'), true);
  assert.equal(relay.relayable('http://localhost:5173/app.css', 'http://127.0.0.1:3000/p'), true);
  assert.equal(relay.relayable('http://[::1]:3000/app.css', 'http://localhost:3000/p'), true);
  // Still no crossing between distinct private hosts.
  assert.equal(relay.relayable('http://192.168.1.10/app.css', 'http://localhost:3000/p'), false);
  assert.equal(relay.relayable('http://10.0.0.5/app.css', 'http://192.168.1.10/p'), false);
});

test('relay URL policy uses HTTPS for public pages and same-host private access', () => {
  assert.equal(relay.relayable('https://cdn.example/app.css', 'https://site.example/page'), true);
  assert.equal(relay.relayable('http://cdn.example/app.css', 'https://site.example/page'), false);
  assert.equal(relay.relayable('http://127.0.0.1:8124/app.css', 'https://site.example/page'), false);
  assert.equal(relay.relayable('http://127.0.0.1:8124/app.css', 'http://127.0.0.1:8123/page'), true);
  assert.equal(relay.relayable('http://192.168.1.1/app.css', 'http://127.0.0.1/page'), false);
  assert.equal(relay.relayable('file:///tmp/app.css', 'https://site.example/page'), false);
});

test('repeated imports are emitted separately while true cycles terminate', async () => {
  const root = 'https://cdn.example/root.css';
  const child = 'https://cdn.example/child.css';
  const files = new Map([
    [root, '@import url("child.css") layer(first);\n@import url("child.css") layer(second);'],
    [child, '#probe { color: red; }'],
  ]);
  const fetchFile = async (url) => files.get(url) ?? null;
  const output = await relay.inlineCss(
    root, { left: 10000 }, 3, new Set(), 'https://site.example/page', fetchFile,
  );
  assert.equal(output.match(/#probe/g)?.length, 2);
  assert.match(output, /@layer first/);
  assert.match(output, /@layer second/);

  files.set(root, '@import url("child.css");\n.root { color: blue; }');
  files.set(child, '@import url("root.css");\n.child { color: green; }');
  const cycle = await relay.inlineCss(
    root, { left: 10000 }, 3, new Set(), 'https://site.example/page', fetchFile,
  );
  assert.equal(cycle.match(/\.root/g)?.length, 1);
  assert.equal(cycle.match(/\.child/g)?.length, 1);
});

test('a shared partial is emitted per occurrence but fetched once', async () => {
  // The per-path cycle guard is what allows the repeat; without a cache it
  // also meant one fetch per occurrence, going exponential in the depth.
  const root = 'https://cdn.example/root.css';
  const files = new Map([
    [root, '@import url("a.css");\n@import url("b.css");'],
    ['https://cdn.example/a.css', '@import url("vars.css");\n.a{}'],
    ['https://cdn.example/b.css', '@import url("vars.css");\n.b{}'],
    ['https://cdn.example/vars.css', ':root{--x:1}'],
  ]);
  const fetched = [];
  const fetchFile = async (url) => {
    fetched.push(url);
    return files.get(url) ?? null;
  };
  const output = await relay.inlineCss(
    root, { left: 100000 }, 3, new Set(), 'https://site.example/page', fetchFile,
  );
  assert.equal(output.match(/--x:1/g)?.length, 2, 'both cascade locations emit it');
  assert.equal(fetched.filter((u) => u.endsWith('vars.css')).length, 1, 'fetched once');
});

test('CSS URL references are resolved against the stylesheet URL', () => {
  const output = relay.absolutizeCssUrls(
    '.a{background:url(../img/a.png)} .b{mask:url(#icon)}',
    'https://cdn.example/css/app.css',
  );
  assert.match(output, /https:\/\/cdn\.example\/img\/a\.png/);
  assert.match(output, /url\(#icon\)/);
});

test('protocol-relative references take the stylesheet\'s scheme, not the document\'s', async () => {
  // //host/path is relative in its scheme. Left alone, an https sheet's
  // references resolve against the DOCUMENT once the text sits in a clone —
  // downgraded to http on an http page — and an @import spelled that way
  // misses the inlining, which only follows absolute http(s) URLs.
  const output = relay.absolutizeCssUrls(
    '@import "//fonts.example/face.css";\n.a{background:url(//img.example/a.png)}',
    'https://cdn.example/css/app.css',
  );
  assert.match(output, /@import "https:\/\/fonts\.example\/face\.css"/);
  assert.match(output, /url\("https:\/\/img\.example\/a\.png"\)/);

  const files = new Map([
    ['https://cdn.example/root.css', '@import url(//cdn.example/child.css);\n.root{}'],
    ['https://cdn.example/child.css', '.child{}'],
  ]);
  const inlined = await relay.inlineCss(
    'https://cdn.example/root.css', { left: 10000 }, 3, new Set(),
    'http://localhost:3000/page', async (url) => files.get(url) ?? null,
  );
  assert.match(inlined, /\.child\{\}/);
  assert.doesNotMatch(inlined, /@import/);
});

test('media-query transform shifts width features and leaves other features native', () => {
  const transform = (text) => shift.shiftMediaText(text, 600, 1440, 900);
  assert.equal(transform('(max-width: 700px)'), '(max-width: calc(700px + 600px))');
  assert.equal(transform('(400px < width < 900px)'),
    '(calc(400px + 600px) < width < calc(900px + 600px))');
  assert.equal(transform('(min-height: 500px)'), '(min-height: 500px)');
  assert.equal(transform('(max-device-width: 700px)'), '(max-device-width: 700px)');
});
