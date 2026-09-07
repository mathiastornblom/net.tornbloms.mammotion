/**
 * Standalone diagnostic: logs in with the main Mammotion account, enumerates devices, and
 * probes the camera-stream auth/entitlement path (stream token + video resource quota) for
 * each device. Reads credentials from .env (never commit that file).
 *
 * Run `npm run build` first (this imports the compiled output, not the TS source —
 * Node's type-stripping mode can't resolve the NodeNext-style .js-suffixed imports
 * inside the source files).
 *
 * Run with: node --env-file=.env scripts/test-camera-token.ts
 */

import { MammotionAuth } from '../.homeybuild/lib/mammotion/auth/MammotionAuth.js';
import type { AuthSession } from '../.homeybuild/lib/mammotion/auth/types.js';

/** Prints only the length and first/last 4 characters of a secret-like string, never the raw value. */
function redact(secret: string | undefined | null): string {
  if (!secret) return '<empty>';
  if (secret.length <= 8) return `<redacted, len=${secret.length}>`;
  return `<redacted, len=${secret.length}, ${secret.slice(0, 4)}...${secret.slice(-4)}>`;
}

/** Fetches and prints the stream token + video resource quota for a single device, with secrets redacted. */
async function probeDevice(session: AuthSession, iotId: string, deviceId: string, label: string): Promise<void> {
  console.log(`\n  --- ${label} (iotId=${iotId}) ---`);

  try {
    const videoResource = await MammotionAuth.fetchVideoResource(session, iotId);
    console.log('    fetchVideoResource: ok');
    console.log(`      id=${videoResource.id} deviceId=${videoResource.deviceId} deviceName=${videoResource.deviceName}`);
    console.log(`      cycleType=${videoResource.cycleType} usageYearMonth=${videoResource.usageYearMonth}`);
    console.log(`      totalTime=${videoResource.totalTime} availableTime=${videoResource.availableTime}`);
  } catch (err) {
    console.log(`    fetchVideoResource: FAILED — ${String(err)}`);
  }

  try {
    const streamToken = await MammotionAuth.fetchStreamToken(session, deviceId);
    console.log('    fetchStreamToken: ok');
    console.log(`      appid=${streamToken.appid} channelName=${streamToken.channelName} uid=${streamToken.uid}`);
    console.log(`      areaCode=${streamToken.areaCode} openEncrypt=${streamToken.openEncrypt} availableTime=${streamToken.availableTime ?? '<none>'}`);
    console.log(`      token: ${redact(streamToken.token)}`);
    console.log(`      license: ${streamToken.license ? redact(streamToken.license) : '<none>'}`);
    console.log(`      cameras: ${streamToken.cameras.length}`);
    for (const cam of streamToken.cameras) {
      console.log(`        - cameraId=${cam.cameraId} token=${redact(cam.token)}`);
    }
  } catch (err) {
    console.log(`    fetchStreamToken: FAILED — ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const email = process.env.MAIN_EMAIL;
  const password = process.env.MAIN_PASSWORD;

  if (!email || !password) {
    console.log('skipped — MAIN_EMAIL/MAIN_PASSWORD not set in .env');
    return;
  }

  const session = await MammotionAuth.login(email, password);
  console.log(`login: ok (userId=${session.userId}, iotDomain=${session.iotDomain})`);

  const [devices, recordsResult] = await Promise.all([
    MammotionAuth.fetchDevices(session).catch((err: unknown) => {
      console.log(`fetchDevices: FAILED — ${String(err)}`);
      return [];
    }),
    MammotionAuth.fetchDeviceRecords(session).catch((err: unknown) => {
      console.log(`fetchDeviceRecords: FAILED — ${String(err)}`);
      return { records: [], total: null, msg: '' };
    }),
  ]);
  const records = recordsResult.records;

  console.log(`\nfetchDevices (owned only): ${devices.length} device(s)`);
  for (const d of devices) {
    console.log(`  - iotId=${d.iotId} deviceId=${d.deviceId ?? '<none>'} deviceName=${d.deviceName} deviceType=${d.deviceType ?? '<none>'} series=${d.series ?? '<none>'} productSeries=${d.productSeries ?? '<none>'}`);
  }

  console.log(`\nfetchDeviceRecords (owned + shared): ${records.length} record(s)`);
  for (const r of records) {
    console.log(`  - iotId=${r.iotId} deviceId=${r.deviceId ?? '<none>'} deviceName=${r.deviceName} productKey=${r.productKey ?? '<none>'}`);
  }

  // Merge each device into a full context so we have both iotId and deviceId to probe with —
  // fetchStreamToken needs deviceId, fetchVideoResource needs iotId, and neither list alone
  // reliably has both for every device shape.
  const recordsByIotId = new Map(records.map((r) => [r.iotId, r]));
  console.log('\nProbing camera-stream endpoints for every known device:');
  for (const device of devices) {
    const record = recordsByIotId.get(device.iotId) ?? { iotId: device.iotId };
    const context = MammotionAuth.mergeDeviceContext(device, record);
    await probeDevice(session, context.iotId, context.deviceId || context.iotId, context.deviceName);
  }
  // Also probe any shared-not-owned record that wasn't already covered above.
  for (const record of records) {
    if (devices.some((d) => d.iotId === record.iotId)) continue;
    const context = MammotionAuth.mergeDeviceContext({}, record);
    await probeDevice(session, context.iotId, context.deviceId || context.iotId, context.deviceName);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
