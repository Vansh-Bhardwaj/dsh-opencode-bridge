import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64url = (value) => Buffer.from(value).toString('base64url');

export function createSecret() {
  return randomBytes(32).toString('base64url');
}

export function signValue(secret, payload) {
  const encoded = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyValue(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const encoded = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('base64url'));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.exp) || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const result = Object.create(null);
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

export function isLoopback(address = '') {
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function originAllowed(origin, requestHost, secure) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === requestHost && parsed.protocol === (secure ? 'https:' : 'http:');
  } catch {
    return false;
  }
}
