import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIpv4, originAllowed, parseCookies, signValue, verifyValue } from '../gateway/lib/security.mjs';
import { withoutGatewayCookie } from '../gateway/lib/gateway.mjs';

test('signed values reject tampering and expiry', () => {
  const secret = 'test-secret';
  const token = signValue(secret, { kind: 'session', exp: Date.now() + 1000 });
  assert.equal(verifyValue(secret, token).kind, 'session');
  assert.equal(verifyValue(secret, `${token}x`), null);
  assert.equal(verifyValue(secret, signValue(secret, { exp: 1 })), null);
});

test('private IPv4 matching excludes loopback and public addresses', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.10.4']) assert.equal(isPrivateIpv4(address), true);
  for (const address of ['127.0.0.1', '172.32.0.1', '8.8.8.8', '::1', 'bad']) assert.equal(isPrivateIpv4(address), false);
});

test('cookie and origin parsing is strict', () => {
  assert.deepEqual({ ...parseCookies('a=1; session=hello%20world') }, { a: '1', session: 'hello world' });
  assert.equal(originAllowed('http://192.168.1.5:3443', '192.168.1.5:3443', false), true);
  assert.equal(originAllowed('https://evil.test', '192.168.1.5:3443', false), false);
});

test('gateway authentication cookie is stripped without deleting DSH cookies', () => {
  assert.equal(
    withoutGatewayCookie('theme=dark; dsh_lan_session=signed-gateway-value; dsh_session=server-login'),
    'theme=dark; dsh_session=server-login',
  );
  assert.equal(withoutGatewayCookie('dsh_lan_session=only-value'), '');
});
