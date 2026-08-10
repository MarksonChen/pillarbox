import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ URL });
for (const file of ['shared/css-relay.js', 'shared/mq-shift.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, {
    filename: file,
  });
}

const relay = context.SQZ.cssRelay;
const shift = context.__pillarboxMqShift;

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

test('media-query transform shifts width features and leaves other features native', () => {
  const transform = (text) => shift.shiftMediaText(text, 600, 1440, 900);
  assert.equal(transform('(max-width: 700px)'), '(max-width: calc(700px + 600px))');
  assert.equal(transform('(400px < width < 900px)'),
    '(calc(400px + 600px) < width < calc(900px + 600px))');
  assert.equal(transform('(min-height: 500px)'), '(min-height: 500px)');
  assert.equal(transform('(max-device-width: 700px)'), '(max-device-width: 700px)');
});
