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

export function accessPage(urls, consumed) {
  const rows = urls.map((url) => {
    const encoded = encodeURIComponent(url);
    const address = new URL(url).host;
    return `<section class="pairing"><div class="qr" data-qr="${encoded}" aria-label="QR code for ${address}"><span>Preparing QR code…</span></div><div class="pairing-details"><strong>Scan with your phone</strong><span class="address">${address}</span><div class="link"><code>${url.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code><button type="button" data-copy="${encoded}">Copy link</button></div></div></section>`;
  }).join('');
  const pairing = consumed
    ? '<div class="notice warning">This one-time code was already used. Restart Harness Remote to pair another device.</div>'
    : rows || '<div class="notice warning">No private LAN address is available. Connect this computer to Wi-Fi or Ethernet, then restart.</div>';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Harness Remote Access</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f2f2f4;background:#111113}*{box-sizing:border-box}body{margin:0;padding:32px 20px 48px;display:grid;place-items:start center}.page{width:min(760px,100%)}header{margin-bottom:24px}h1{font-size:24px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px}p{max-width:65ch;color:#b7b7bd;line-height:1.55;margin:0}.pairing{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;align-items:center;padding:20px 0;border-top:1px solid #343438}.pairing:last-of-type{border-bottom:1px solid #343438}.qr{width:200px;aspect-ratio:1;display:grid;place-items:center;padding:10px;border-radius:12px;background:#fff;color:#4b4b52}.qr svg{display:block;width:100%;height:100%}.qr span{font-size:13px}.pairing-details{min-width:0}.pairing-details strong{display:block;font-size:15px;margin-bottom:4px}.address{display:block;color:#8d8d96;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;margin-bottom:14px}.link{display:flex;align-items:center;gap:8px;padding:7px;background:#1b1b1e;border-radius:10px}.link code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;padding-left:4px;color:#c7c7cd;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.link button,.primary{border:0;border-radius:8px;min-height:38px;padding:0 13px;font:600 13px/1 Inter,ui-sans-serif,system-ui;cursor:pointer;background:#f2f2f4;color:#151517;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}.link button:hover,.primary:hover{background:#fff}.link button:focus-visible,.primary:focus-visible{outline:2px solid #7c8cff;outline-offset:2px}.notice{padding:12px 14px;border-radius:10px;background:#202a23;color:#a9dcb2;font-size:13px;line-height:1.45;margin:20px 0}.warning{background:#2d2420;color:#e7bd98}.architecture{color:#8d8d96;font-size:12px;line-height:1.5;margin:18px 0}.actions{display:flex;gap:10px;align-items:center}@media(max-width:580px){body{padding:24px 16px 36px}.pairing{grid-template-columns:1fr;justify-items:center;gap:16px}.pairing-details{width:100%;text-align:center}.address{margin-bottom:10px}.link{text-align:left}.qr{width:min(220px,78vw)}.actions{display:grid}.primary{width:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}</style></head><body><main class="page"><header><h1>Pair your phone</h1><p>Keep your phone on the same Wi-Fi, open its camera, and scan a code. Each code contains the same short-lived, one-time pairing link.</p></header>${pairing}<div class="notice">After pairing, add Harness to the phone home screen for a standalone app window.</div><p class="architecture">Harness runs privately on <code>127.0.0.1:3080</code>. This authenticated gateway runs on port <code>${urls[0] ? new URL(urls[0]).port : '3443'}</code> and is the only part available to your local network.</p><div class="actions"><a class="primary" href="/">Open Harness on this computer</a></div></main><script src="/_bridge/qrcode.js"></script><script>for(const slot of document.querySelectorAll('[data-qr]')){try{const value=decodeURIComponent(slot.dataset.qr);const code=qrcode(0,'M');code.addData(value);code.make();slot.innerHTML=code.createSvgTag({cellSize:4,margin:16,scalable:true,title:'Scan to pair this phone with Harness',alt:'One-time Harness pairing code'})}catch{slot.innerHTML='<span>QR code unavailable. Copy the link instead.</span>'}}document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy));b.textContent='Copied';setTimeout(()=>b.textContent='Copy link',1500)}catch{b.textContent='Copy failed'}})</script></body></html>`;
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
      '/_bridge/qrcode.js': ['vendor/qrcode-generator.js', 'text/javascript; charset=utf-8'],
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
    upstream.on('error', (error) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy(error);
        return;
      }
      problem(response, 502, 'Harness unavailable', error.message);
    });
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
