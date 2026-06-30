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

    const [devices, records] = await Promise.all([
      MammotionAuth.fetchDevices(session).catch((err: unknown) => {
        console.log(`  fetchDevices: FAILED — ${String(err)}`);
        return [];
      }),
      MammotionAuth.fetchDeviceRecords(session).catch((err: unknown) => {
        console.log(`  fetchDeviceRecords: FAILED — ${String(err)}`);
        return [];
      }),
    ]);

    console.log(`  fetchDevices (owned only): ${devices.length} device(s)`);
    for (const d of devices) console.log(`    - iotId=${d.iotId} deviceName=${d.deviceName}`);

    console.log(`  fetchDeviceRecords (owned + shared): ${records.length} record(s)`);
    for (const r of records) console.log(`    - iotId=${r.iotId} deviceName=${r.deviceName} productKey=${r.productKey}`);
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
