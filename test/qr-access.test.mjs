import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { accessPage, injectShell } from '../gateway/lib/gateway.mjs';

const pairingUrl = 'http://192.168.1.4:3443/_bridge/pair?token=example-signed-one-time-token';

test('access page renders a local QR target and hides it after consumption', () => {
  const ready = accessPage([pairingUrl], false);
  assert.match(ready, /data-qr=/);
  assert.match(ready, /_bridge\/qrcode\.js/);
  assert.match(ready, /127\.0\.0\.1:3080/);
  assert.match(ready, /port <code>3443<\/code>/);

  const consumed = accessPage([pairingUrl], true);
  assert.doesNotMatch(consumed, /data-qr=/);
  assert.doesNotMatch(consumed, /example-signed-one-time-token/);
});

test('vendored QR generator encodes a complete pairing URL as SVG', async () => {
  const source = await readFile(new URL('../gateway/mobile/vendor/qrcode-generator.js', import.meta.url), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  const code = context.qrcode(0, 'M');
  code.addData(pairingUrl);
  code.make();
  const svg = code.createSvgTag({ scalable: true, margin: 16 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /<path/);
  assert.ok(code.getModuleCount() > 20);
});

test('mobile shell exposes the sessions drawer without the old status pill', async () => {
  const [script, stylesheet] = await Promise.all([
    readFile(new URL('../gateway/mobile/mobile.js', import.meta.url), 'utf8'),
    readFile(new URL('../gateway/mobile/mobile.css', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /Open chats and sessions/);
  assert.match(script, /data-shell-overlay/);
  assert.match(stylesheet, /data-dsh-mobile-sidebar-open/);
  assert.match(stylesheet, /safe-area-inset-top/);
  assert.doesNotMatch(`${script}\n${stylesheet}`, /Local remote|dsh-lan-status/);
});

test('mobile bootstrap supplies secure RFC 4122 UUIDs before DSH starts', async () => {
  const source = await readFile(new URL('../gateway/mobile/bootstrap.js', import.meta.url), 'utf8');
  const context = {
    crypto: {
      getRandomValues(array) {
        return webcrypto.getRandomValues(array);
      },
    },
    Uint8Array,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  assert.equal(typeof context.crypto.randomUUID, 'function');
  const first = context.crypto.randomUUID();
  const second = context.crypto.randomUUID();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);

  const shell = injectShell('<!doctype html><html><head data-theme="dark"><script id="dsh"></script></head><body></body></html>');
  assert.ok(shell.indexOf('/_bridge/bootstrap.js') < shell.indexOf('id="dsh"'));
  assert.match(shell, /_bridge\/mobile\.css/);
  assert.match(shell, /_bridge\/mobile\.js/);
});
