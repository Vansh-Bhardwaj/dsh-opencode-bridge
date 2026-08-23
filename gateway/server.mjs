import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGateway, defaultRouteAddresses, pairingUrls } from './lib/gateway.mjs';
import { createSecret } from './lib/security.mjs';

const configRoot = process.env.DSH_LAN_HOME || join(homedir(), '.dsh', 'lan-gateway');
const port = Number(process.env.DSH_LAN_PORT || 3443);
const upstreamPort = Number(process.env.DSH_WEB_PORT || 3080);
await mkdir(configRoot, { recursive: true });

async function persistentSecret() {
  const path = join(configRoot, 'secret');
  try { return (await readFile(path, 'utf8')).trim(); }
  catch {
    const value = createSecret();
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return value;
  }
}

const secret = await persistentSecret();
const pairToken = randomBytes(18).toString('base64url');
const devicesPath = join(configRoot, 'devices.json');
let knownDevices = [];
try {
  const parsed = JSON.parse(await readFile(devicesPath, 'utf8'));
  if (Array.isArray(parsed)) knownDevices = parsed.filter((value) => typeof value === 'string');
} catch { /* First run or a safely ignored damaged cache. */ }
const sessionStore = new Set(knownDevices);
async function persistSessions(sessions) {
  const temporary = `${devicesPath}.tmp`;
  await writeFile(temporary, JSON.stringify([...sessions], null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, devicesPath);
}
let tls;
if (process.env.DSH_LAN_CERT && process.env.DSH_LAN_KEY) {
  tls = {
    cert: await readFile(process.env.DSH_LAN_CERT),
    key: await readFile(process.env.DSH_LAN_KEY),
  };
}

const gateway = createGateway({
  secret, pairToken, port, upstreamPort, tls,
  addresses: await defaultRouteAddresses(),
  sessionStore,
  onSessionsChanged: persistSessions,
});
const addresses = await gateway.start();
const urls = pairingUrls({ addresses, port, secure: Boolean(tls), secret, pairToken });
await writeFile(join(configRoot, 'pairing.json'), JSON.stringify({ createdAt: new Date().toISOString(), expiresInMinutes: 15, urls }, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify({ ready: true, port, urls })}\n`);

const shutdown = async () => {
  await gateway.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
