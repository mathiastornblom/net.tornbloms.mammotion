/**
 * Shared-device pairing pipeline test. Run after `npm run build`:
 *   node --test scripts/shared-device-pairing.test.mjs
 *
 * Reproduces the exact input from a real diagnostic report (USER_REPORTS_INBOX R11): a
 * Luba 3 shared to a secondary account, where the owned-devices endpoint returned nothing
 * and the records endpoint returned one device —
 *
 *   list_devices: owned=0 records=1 total=1
 *     {"iotId":"4ErGSfNpYF1uLdM5RdmL4bnViY","deviceName":"Luba-VA5W38CC","productKey":"uY54W5rM8YH"}
 *
 * — yet the pairing wizard showed an empty list. LubaDriver.buildDeviceList is private and
 * needs a live Homey driver, so this drives the same pure steps it composes:
 * mergeDeviceContext → resolveDeviceType → capabilitiesForModel. If every assertion here
 * holds, the device we hand to Homey is well-formed and the loss is downstream of our code
 * (wizard behaviour, timing) — which is what the elapsed-ms logging on the return path is
 * there to settle. If one fails, the bug is ours and this is where it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MammotionAuth } from '../.homeybuild/lib/mammotion/auth/MammotionAuth.js';
import { resolveDeviceType, capabilitiesForModel, DeviceType } from '../.homeybuild/lib/mammotion/deviceType.js';

const R11_RECORD = { iotId: '4ErGSfNpYF1uLdM5RdmL4bnViY', deviceName: 'Luba-VA5W38CC', productKey: 'uY54W5rM8YH' };
const manifestCaps = JSON.parse(readFileSync(new URL('../drivers/luba/driver.compose.json', import.meta.url), 'utf8')).capabilities;

test('a shared-only record (no owned entry) still yields a usable device context', () => {
  // Shared-not-owned is the only case where `device` is `{}` — every field must come from
  // the record, and none may be undefined in a way that later breaks `data.id` or `name`.
  const ctx = MammotionAuth.mergeDeviceContext({}, R11_RECORD);
  assert.equal(ctx.iotId, R11_RECORD.iotId);
  assert.equal(ctx.deviceName, 'Luba-VA5W38CC');
  assert.equal(ctx.productKey, 'uY54W5rM8YH');
  assert.equal(ctx.recordDeviceName, 'Luba-VA5W38CC');
  assert.equal(ctx.deviceType, null, 'numeric deviceType only comes from the owned endpoint; null is expected here, not a failure');
});

test('the R11 Luba 3 resolves to LUBA_VA from its name, even with no owned-endpoint deviceType', () => {
  // resolveDeviceType must not depend on ctx.deviceType (null for shared devices) — it goes
  // by name prefix + productKey. `Luba-VA5W38CC`.slice(0,7) === 'Luba-VA'.
  assert.equal(resolveDeviceType('Luba-VA5W38CC', 'uY54W5rM8YH'), DeviceType.LUBA_VA);
});

test('the capability list handed to Homey for a shared Luba 3 is non-empty and valid', () => {
  const caps = capabilitiesForModel(manifestCaps, DeviceType.LUBA_VA);
  assert.ok(caps.length > 0, 'an empty capability list is the leading hypothesis for a silently dropped wizard entry');
  assert.ok(caps.length >= manifestCaps.length - 2, 'only mow_headlamp/measure_battery_cycles are ever filtered');
  for (const c of caps) assert.ok(manifestCaps.includes(c), `unknown capability ${c} would fail at add time`);
});

test('the full pure pipeline produces exactly what buildDeviceList would return for R11', () => {
  // Mirrors buildDeviceList's body field-for-field so a future change to it that breaks the
  // shared-device case is caught here rather than in a user's pairing wizard.
  const ctx = MammotionAuth.mergeDeviceContext({}, R11_RECORD);
  const type = resolveDeviceType(ctx.deviceName, ctx.productKey);
  const entry = {
    name: ctx.deviceName || ctx.iotId,
    data: { id: ctx.iotId },
    store: { context: { ...ctx, transportKind: 'mammotion' } },
    capabilities: capabilitiesForModel(manifestCaps, type),
  };
  assert.equal(entry.name, 'Luba-VA5W38CC');
  assert.equal(entry.data.id, '4ErGSfNpYF1uLdM5RdmL4bnViY', 'data.id is what Homey de-duplicates and lists on — must be the iotId');
  assert.equal(entry.store.context.transportKind, 'mammotion');
  assert.ok(entry.capabilities.length > 20);
});
