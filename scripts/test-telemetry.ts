/**
 * Standalone diagnostic: exercises both cloud transports end-to-end against real mowers —
 * logs in once, then separately (a) connects the normal Mammotion MQTT client to the account's
 * own mower and (b) runs the legacy Aliyun IoT Link handshake + its own MQTT connection to a
 * legacy-only shared mower — requesting and printing one real telemetry report from each.
 *
 * Session/credentials are cached to .cache/ (gitignored) so repeated runs while iterating
 * don't redo the full login / Aliyun 6-step handshake every time.
 *
 * Run `npm run build` first (imports compiled output, see test-accounts.ts for why).
 * Run with: node --env-file=.env scripts/test-telemetry.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { MammotionAuth } from '../.homeybuild/lib/mammotion/auth/MammotionAuth.js';
import { probeLegacyAliyunDevices } from '../.homeybuild/lib/mammotion/aliyun/AliyunLegacyProbe.js';
import { sendAliyunCloudCommand } from '../.homeybuild/lib/mammotion/aliyun/commands.js';
import { AliyunMqttTransport } from '../.homeybuild/lib/mammotion/aliyun/AliyunMqttTransport.js';
import { MqttClient } from '../.homeybuild/lib/mammotion/mqtt/MqttClient.js';
import { buildRequestIotSyncCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { extractTelemetry } from '../.homeybuild/lib/mammotion/protocol/TelemetryParser.js';
import type { AuthSession } from '../.homeybuild/lib/mammotion/auth/types.js';
import type { AliyunLegacyCredentials } from '../.homeybuild/lib/mammotion/aliyun/AliyunLegacyProbe.js';

const CACHE_DIR = new URL('../.cache/', import.meta.url);
const SESSION_CACHE_PATH = new URL('mammotion-session.json', CACHE_DIR);
const LEGACY_CACHE_PATH = new URL('aliyun-legacy-credentials.json', CACHE_DIR);
const TELEMETRY_WAIT_MS = 20_000;

function loadCache<T>(path: URL): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function saveCache(path: URL, value: unknown): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

async function getSession(email: string, password: string): Promise<AuthSession> {
  const cached = loadCache<AuthSession>(SESSION_CACHE_PATH);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    console.log(`  reusing cached session (expires ${new Date(cached.expiresAt).toISOString()})`);
    return cached;
  }
  console.log('  logging in fresh (no valid cached session)...');
  const session = await MammotionAuth.login(email, password);
  saveCache(SESSION_CACHE_PATH, session);
  return session;
}

async function getLegacyCredentials(session: AuthSession): Promise<AliyunLegacyCredentials> {
  const cached = loadCache<AliyunLegacyCredentials>(LEGACY_CACHE_PATH);
  if (cached) {
    console.log('  reusing cached legacy Aliyun credentials');
    return cached;
  }
  console.log('  running full legacy Aliyun handshake (no cached credentials)...');
  const result = await probeLegacyAliyunDevices(session);
  if (!result.credentials) throw new Error('legacy handshake succeeded but returned no credentials');
  saveCache(LEGACY_CACHE_PATH, result.credentials);
  return result.credentials;
}

/** Races an async setup against a timeout, resolving with whichever telemetry arrives first. */
function withTimeout<T>(label: string, ms: number): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    setTimeout(() => reject(new Error(`${label}: no telemetry within ${ms}ms`)), ms);
  });
  return { promise, resolve: resolveFn };
}

async function testNormalPath(session: AuthSession): Promise<void> {
  console.log('\n=== Normal path (Mammotion MQTT) ===');
  const [devices, recordsResult] = await Promise.all([
    MammotionAuth.fetchDevices(session),
    MammotionAuth.fetchDeviceRecords(session),
  ]);
  const records = recordsResult.records;
  console.log(`  records: ${records.length}`);
  if (records.length === 0) {
    console.log('  skipped — no normal-path devices on this account');
    return;
  }

  const ownedByIotId = new Map(devices.map((d) => [d.iotId, d]));
  const contexts = records.map((r) => MammotionAuth.mergeDeviceContext(ownedByIotId.get(r.iotId) ?? {}, r));
  const target = contexts[0];
  console.log(`  targeting iotId=${target.iotId} deviceName=${target.deviceName}`);

  const mqttCreds = await MammotionAuth.fetchMqttCredentials(session);
  console.log(`  MQTT credentials OK (host=${mqttCreds.host})`);

  const wait = withTimeout<[string, Record<string, unknown>]>('normal path', TELEMETRY_WAIT_MS);
  const mqtt = new MqttClient({
    onTelemetry: (iotId, state) => wait.resolve([iotId, state]),
    onStatus: (iotId, online) => console.log(`  [status] ${iotId} online=${online}`),
    onNotification: () => {},
    onClose: () => console.log('  [MQTT] connection closed'),
    log: (msg) => console.log(`  [MQTT] ${msg}`),
    logError: (msg) => console.log(`  [MQTT] ERROR: ${msg}`),
  });
  mqtt.connect(mqttCreds, contexts);

  try {
    const cmd = buildRequestIotSyncCommand(session.userAccount, false, { value: 0 });
    await mqtt.sendCommand(session, target, cmd);
    console.log('  sync request sent, waiting for telemetry...');
    const [iotId, state] = await wait.promise;
    console.log(`  ✓ telemetry received from ${iotId}:`, JSON.stringify(state));
  } catch (err) {
    console.log(`  ✗ FAILED — ${String(err)}`);
  } finally {
    mqtt.disconnect();
  }
}

async function testLegacyPath(session: AuthSession): Promise<void> {
  console.log('\n=== Legacy path (Aliyun IoT Link) ===');
  const probe = await probeLegacyAliyunDevices(session);
  console.log(`  bound=${probe.boundDevices.length} shareNotifications=${probe.shareNotifications}`);
  if (probe.boundDevices.length === 0) {
    console.log('  skipped — no legacy-bound devices on this account');
    return;
  }

  const credentials = await getLegacyCredentials(session);
  const target = probe.boundDevices[0];
  console.log(`  targeting iotId=${target.iotId} deviceName=${target.deviceName} nickName=${target.nickName ?? ''}`);

  const wait = withTimeout<[string, Record<string, unknown>]>('legacy path', TELEMETRY_WAIT_MS);
  const transport = new AliyunMqttTransport({
    config: credentials,
    log: (msg) => console.log(`  [Aliyun MQTT] ${msg}`),
    logError: (msg) => console.log(`  [Aliyun MQTT] ERROR: ${msg}`),
  });
  transport.registerDevice(
    target.iotId,
    (decoded) => {
      const telemetry = extractTelemetry(decoded);
      if (telemetry) wait.resolve([target.iotId, telemetry]);
    },
    (online) => console.log(`  [status] ${target.iotId} online=${online}`),
  );
  transport.connect();

  try {
    const cmd = buildRequestIotSyncCommand(session.userAccount, false, { value: 0 });
    const cmdBytes = Buffer.from(cmd, 'base64');
    const messageId = await sendAliyunCloudCommand(credentials, target.iotId, cmdBytes);
    console.log(`  sync request sent (messageId=${messageId}), waiting for telemetry...`);
    const [iotId, state] = await wait.promise;
    console.log(`  ✓ telemetry received from ${iotId}:`, JSON.stringify(state));
  } catch (err) {
    console.log(`  ✗ FAILED — ${String(err)}`);
  } finally {
    transport.disconnect();
  }
}

async function main(): Promise<void> {
  const email = process.env.MAIN_EMAIL;
  const password = process.env.MAIN_PASSWORD;
  if (!email || !password) {
    console.log('MAIN_EMAIL / MAIN_PASSWORD not set in .env — nothing to test');
    return;
  }

  console.log(`=== Login (${email}) ===`);
  const session = await getSession(email, password);
  console.log(`  session OK (userId=${session.userId}, iotDomain=${session.iotDomain})`);

  await testNormalPath(session);
  await testLegacyPath(session);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
