import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isLoopback, isPrivateIpv4, originAllowed, parseCookies, signValue, verifyValue } from './security.mjs';

const COOKIE = 'dsh_lan_session';
const MAX_PAIR_FAILURES = 8;
const PAIR_WINDOW_MS = 10 * 60 * 1000;

export function privateAddresses() {
  const found = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal && isPrivateIpv4(item.address)) found.add(item.address);
    }
  }
  return [...found];
}

export async function defaultRouteAddresses() {
  if (process.platform !== 'win32') return privateAddresses();
  try {
    const { stdout } = await promisify(execFile)('route.exe', ['print', '-4'], { timeout: 5_000, windowsHide: true });
    const found = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s+\d+\s*$/.exec(line);
      if (match && isPrivateIpv4(match[1])) found.add(match[1]);
    }
    return found.size ? [...found] : privateAddresses();
  } catch {
    return privateAddresses();
  }
}

function remoteIp(request) {
  return String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolveProbe) => {
    const socket = net.connect(port, host);
    const finish = (value) => { socket.destroy(); resolveProbe(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function send(response, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, {
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  response.end(payload);
}

function problem(response, status, title, detail) {
  send(response, status, JSON.stringify({
    type: `https://local.dsh/problems/${status}`,
    title,
    status,
    detail,
  }), { 'content-type': 'application/problem+json; charset=utf-8' });
}

function pairingPage(message, ok = false) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>DeepSeek Harness Remote</title><style>html{font-family:Inter,system-ui,sans-serif;color:#f2f2f4;background:#111113}body{min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}.box{width:min(420px,100%);border:1px solid #343438;border-radius:14px;background:#1b1b1e;padding:24px;box-sizing:border-box}h1{font-size:20px;margin:0 0 10px}p{color:#b7b7bd;line-height:1.5;margin:0 0 18px}.mark{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:${ok ? '#243c2b' : '#3c2626'};color:${ok ? '#76d78a' : '#ff8888'};margin-bottom:18px;font-weight:700}a{display:flex;justify-content:center;min-height:44px;align-items:center;border-radius:10px;background:#f2f2f4;color:#151517;text-decoration:none;font-weight:600}</style></head><body><main class="box"><div class="mark">${ok ? '✓' : '!'}</div><h1>${ok ? 'Phone paired' : 'Pairing failed'}</h1><p>${message}</p>${ok ? '<a href="/">Open DeepSeek Harness</a>' : ''}</main></body></html>`;
}

function accessPage(urls, consumed) {
  const rows = urls.map((url) => `<div class="link"><code>${url.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code><button type="button" data-copy="${encodeURIComponent(url)}">Copy</button></div>`).join('');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Harness Remote Access</title><style>html{font-family:Inter,system-ui,sans-serif;color:#f2f2f4;background:#111113}body{margin:0;padding:32px;display:grid;place-items:start center}.page{width:min(680px,100%)}h1{font-size:24px;margin:0 0 8px}p{color:#aaaab2;line-height:1.55;margin:0 0 22px}.link{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #343438;border-radius:10px;background:#1b1b1e;margin:8px 0}.link code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px}.link button,a{border:0;border-radius:8px;min-height:38px;padding:0 13px;font:600 13px/1 Inter,system-ui;cursor:pointer;background:#f2f2f4;color:#151517;text-decoration:none;display:inline-flex;align-items:center}.note{padding:12px 14px;border-radius:10px;background:#202a23;color:#9bd3a6;font-size:13px;margin:18px 0}.used{background:#2d2420;color:#e0b38c}</style></head><body><main class="page"><h1>Local network remote</h1><p>Open one link on your phone while it is connected to the same Wi-Fi. The link pairs one device, expires quickly, and never exposes the loopback-only DSH server itself.</p>${consumed ? '<div class="note used">This one-time link was already used. Restart Harness Remote to pair another device.</div>' : rows || '<div class="note used">No private LAN address is available. Connect this computer to Wi-Fi or Ethernet, then restart.</div>'}<div class="note">After pairing, add Harness to the phone home screen for a standalone app window.</div><a href="/">Open Harness on this computer</a></main><script>document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-copy]');if(!b)return;await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy));b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)})</script></body></html>`;
}

async function loadAsset(assetDirectory, name, contentType) {
  return { body: await readFile(new URL(`../mobile/${name}`, import.meta.url)), contentType };
}

function injectShell(html) {
  const additions = [
    '<meta name="theme-color" content="#151517">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<link rel="manifest" href="/_bridge/manifest.webmanifest">',
    '<link rel="stylesheet" href="/_bridge/mobile.css">',
    '<script defer src="/_bridge/mobile.js"></script>',
  ].join('');
  return html.includes('</head>') ? html.replace('</head>', `${additions}</head>`) : html;
}

export function createGateway(options) {
  const {
    secret,
    pairToken,
    upstreamHost = '127.0.0.1',
    upstreamPort = 3080,
    port = 3443,
    tls,
    addresses = privateAddresses(),
    logger = console,
    sessionStore = new Set(),
    onSessionsChanged = async () => {},
  } = options;
  if (!secret || !pairToken) throw new Error('Gateway secret and pairing token are required.');

  const secure = Boolean(tls);
  const sessions = sessionStore;
  const failures = new Map();
  let pairConsumed = false;
  const listeners = [];
  const allAddresses = [...new Set(['127.0.0.1', ...addresses.filter(isPrivateIpv4)])];

  function authenticated(request) {
    if (isLoopback(request.socket.remoteAddress)) return true;
    const token = parseCookies(request.headers.cookie)[COOKIE];
    const payload = verifyValue(secret, token);
    return Boolean(payload && payload.kind === 'session' && sessions.has(payload.sid));
  }

  function originIsSafe(request) {
    return originAllowed(request.headers.origin, request.headers.host, secure);
  }

  function notePairFailure(ip) {
    const now = Date.now();
    const current = failures.get(ip);
    const next = !current || current.resetAt < now
      ? { count: 1, resetAt: now + PAIR_WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
    failures.set(ip, next);
    return next.count;
  }

  function proxyHeaders(request) {
    const headers = { ...request.headers };
    headers.host = `${upstreamHost}:${upstreamPort}`;
    headers.origin = `http://${upstreamHost}:${upstreamPort}`;
    headers['sec-fetch-site'] = 'same-origin';
    delete headers.cookie;
    delete headers['accept-encoding'];
    return headers;
  }

  async function bridgeAsset(request, response, pathname) {
    const assets = {
      '/_bridge/mobile.css': ['mobile.css', 'text/css; charset=utf-8'],
      '/_bridge/mobile.js': ['mobile.js', 'text/javascript; charset=utf-8'],
      '/_bridge/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      '/_bridge/icon.svg': ['icon.svg', 'image/svg+xml'],
    };
    const entry = assets[pathname];
    if (!entry) return false;
    const asset = await loadAsset(undefined, entry[0], entry[1]);
    send(response, 200, asset.body, { 'content-type': asset.contentType, 'cache-control': 'private, max-age=300' });
    return true;
  }

  async function handle(request, response) {
    const url = new URL(request.url || '/', `${secure ? 'https' : 'http'}://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/_bridge/health') {
      const ready = await portOpen(upstreamHost, upstreamPort);
      return send(response, ready ? 200 : 503, JSON.stringify({ status: ready ? 'ok' : 'unavailable', upstream: `${upstreamHost}:${upstreamPort}` }), { 'content-type': 'application/json' });
    }
    if (url.pathname === '/_bridge/access') {
      if (!isLoopback(request.socket.remoteAddress)) return problem(response, 404, 'Not found', 'This page is available only on the computer running DSH.');
      const urls = pairingUrls({ addresses: allAddresses, port, secure, secret, pairToken });
      return send(response, 200, accessPage(urls, pairConsumed), { 'content-type': 'text/html; charset=utf-8' });
    }
    if (url.pathname === '/_bridge/pair') {
      const ip = remoteIp(request);
      const state = failures.get(ip);
      if (state && state.resetAt > Date.now() && state.count >= MAX_PAIR_FAILURES) {
        return send(response, 429, pairingPage('Too many failed attempts. Wait ten minutes and generate a fresh pairing link.'), { 'content-type': 'text/html; charset=utf-8' });
      }
      const supplied = url.searchParams.get('token');
      const pair = verifyValue(secret, supplied);
      if (pairConsumed || !pair || pair.kind !== 'pair' || pair.nonce !== pairToken) {
        notePairFailure(ip);
        return send(response, 401, pairingPage('This link is invalid or expired. Open Remote Access on the computer for a fresh link.'), { 'content-type': 'text/html; charset=utf-8' });
      }
      const sid = crypto.randomUUID();
      sessions.add(sid);
      await onSessionsChanged(sessions);
      pairConsumed = true;
      const session = signValue(secret, { kind: 'session', sid, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
      const cookie = `${COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`;
      return send(response, 200, pairingPage('This device can now use the full Harness while it stays on this local network.', true), { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookie });
    }
    if (!authenticated(request)) return problem(response, 401, 'Pairing required', 'Open the one-time pairing link shown on the computer.');
    if (!originIsSafe(request)) return problem(response, 403, 'Origin rejected', 'The request did not originate from this Harness gateway.');
    if (await bridgeAsset(request, response, url.pathname)) return;
    if (url.pathname === '/_bridge/status') {
      const ready = await portOpen(upstreamHost, upstreamPort);
      return send(response, ready ? 200 : 503, JSON.stringify({ status: ready ? 'connected' : 'upstream-unavailable', secure, address: request.headers.host }), { 'content-type': 'application/json' });
    }

    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request),
      timeout: 30_000,
    }, (upstreamResponse) => {
      const type = String(upstreamResponse.headers['content-type'] || '');
      if (request.method === 'GET' && type.includes('text/html')) {
        const chunks = [];
        upstreamResponse.on('data', (chunk) => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          const body = injectShell(Buffer.concat(chunks).toString('utf8'));
          const headers = { ...upstreamResponse.headers };
          delete headers['content-length'];
          delete headers['content-encoding'];
          // DSH's client plugin loader compiles installed plugin factories at runtime.
          // Keep eval scoped to same-origin authenticated application code.
          headers['content-security-policy'] = "default-src 'self' data: blob:; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'";
          send(response, upstreamResponse.statusCode || 502, body, headers);
        });
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', (error) => problem(response, 502, 'Harness unavailable', error.message));
    request.pipe(upstream);
  }

  function upgrade(request, socket, head) {
    if (!authenticated(request) || !originIsSafe(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const lines = [`GET ${request.url} HTTP/1.1`];
      const headers = proxyHeaders(request);
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  async function start() {
    for (const address of allAddresses) {
      const server = secure ? https.createServer(tls, (req, res) => void handle(req, res).catch((error) => problem(res, 500, 'Gateway error', error.message)))
        : http.createServer((req, res) => void handle(req, res).catch((error) => problem(res, 500, 'Gateway error', error.message)));
      server.requestTimeout = 0;
      server.headersTimeout = 65_000;
      server.on('upgrade', upgrade);
      await new Promise((resolve, reject) => server.listen(port, address, resolve).once('error', reject));
      listeners.push(server);
      logger.info?.(`DSH LAN gateway listening on ${secure ? 'https' : 'http'}://${address}:${port}`);
    }
    return allAddresses;
  }

  async function stop() {
    await Promise.all(listeners.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  }

  return { start, stop, addresses: allAddresses };
}

export function pairingUrls({ addresses, port, secure, secret, pairToken, ttlMs = 15 * 60 * 1000 }) {
  const token = signValue(secret, { kind: 'pair', nonce: pairToken, exp: Date.now() + ttlMs });
  return addresses.filter(isPrivateIpv4).map((address) => `${secure ? 'https' : 'http'}://${address}:${port}/_bridge/pair?token=${encodeURIComponent(token)}`);
}
