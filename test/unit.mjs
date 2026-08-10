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
