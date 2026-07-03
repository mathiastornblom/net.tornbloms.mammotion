/**
 * Standalone diagnostic: logs in with both Mammotion accounts and reports what each
 * account's device endpoints return. Reads credentials from .env (never commit that file).
 *
 * Run `npm run build` first (this imports the compiled output, not the TS source —
 * Node's type-stripping mode can't resolve the NodeNext-style .js-suffixed imports
 * inside the source files).
 *
 * Run with: node --env-file=.env scripts/test-accounts.ts
 */

import { MammotionAuth } from '../.homeybuild/lib/mammotion/auth/MammotionAuth.js';

interface AccountConfig {
  label: string;
  email: string | undefined;
  password: string | undefined;
}

async function testAccount({ label, email, password }: AccountConfig): Promise<void> {
  console.log(`\n=== ${label} ===`);

  if (!email || !password) {
    console.log('  skipped — no credentials set for this account in .env');
    return;
  }

  try {
    const session = await MammotionAuth.login(email, password);
    console.log(`  login: ok (userId=${session.userId}, iotDomain=${session.iotDomain})`);

    const [devices, recordsResult] = await Promise.all([
      MammotionAuth.fetchDevices(session).catch((err: unknown) => {
        console.log(`  fetchDevices: FAILED — ${String(err)}`);
        return [];
      }),
      MammotionAuth.fetchDeviceRecords(session).catch((err: unknown) => {
        console.log(`  fetchDeviceRecords: FAILED — ${String(err)}`);
        return { records: [], total: null, msg: '' };
      }),
    ]);
    const records = recordsResult.records;

    console.log(`  fetchDevices (owned only): ${devices.length} device(s)`);
    for (const d of devices) console.log(`    - iotId=${d.iotId} deviceName=${d.deviceName}`);

    console.log(`  fetchDeviceRecords (owned + shared): ${records.length} record(s), server-reported total=${recordsResult.total}, msg=${JSON.stringify(recordsResult.msg)}`);
    for (const r of records) console.log(`    - iotId=${r.iotId} deviceName=${r.deviceName} productKey=${r.productKey}`);
    if (records.length === 0 && recordsResult.total !== null && recordsResult.total > 0) {
      console.log('  ⚠ total>0 but records=0 — a pagination/parsing bug, not "account has no devices"');
    }
  } catch (err) {
    console.log(`  login: FAILED — ${String(err)}`);
  }
}

async function main(): Promise<void> {
  await testAccount({
    label: 'Main account',
    email: process.env.MAIN_EMAIL,
    password: process.env.MAIN_PASSWORD,
  });

  await testAccount({
    label: 'Shared account',
    email: process.env.SHARED_EMAIL,
    password: process.env.SHARED_PASSWORD,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
