/**
 * BLE reconnect backoff test. Run after `npm run build`:
 *   node --test scripts/ble-backoff.test.mjs
 *
 * Covers a real bug: BleTransport.connect()'s "device not found in scan" branch used to
 * call scheduleReconnect() directly without going through reportFailure() first, so
 * consecutiveFailures never incremented for that path — a device that's never found (out
 * of BLE range for a long stretch, or a hub with no BLE radio at all, e.g. a Homey Pro Mini
 * without a Homey Bridge) rescanned every 15s forever instead of ever reaching the existing
 * 30-minute quiet cap meant for exactly that persistent case. Every real diagnostic report
 * seen for one specific device (never once found across many captures) showed this exact
 * pattern: "scheduling reconnect in 15s (failure #0)", repeated indefinitely, never
 * escalating. Fixed by routing "not found" through reportFailure() like every other
 * failure path.
 *
 * connect() is driven directly in a loop here rather than waiting for its internally
 * scheduled setTimeout callbacks to fire — global setTimeout is stubbed to capture the
 * delay argument without actually scheduling anything real, so this test has no timers
 * left running afterward and can't hang.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BleTransport } from '../.homeybuild/lib/mammotion/ble/BleTransport.js';

function neverFoundBleManager() {
  return {
    async discover() { return []; }, // never finds the mower
    async find() { throw new Error('not found by cached UUID'); },
  };
}

/** setupGattSession() is internally raced against an 8s GATT-setup timeout (also via
 *  setTimeout) whenever a peripheral is actually found and connected — a fixed constant,
 *  never a legitimate scheduleReconnect() backoff delay (BLE_RECONNECT_BASE_MS's doubling
 *  sequence never produces 8000), so it's filtered out of the captured delays below. */
const GATT_SETUP_TIMEOUT_MS = 8_000;

/** Calls connect() `count` times directly, capturing the delay each scheduleReconnect()
 *  call would have passed to setTimeout, without ever letting a real timer fire. */
async function collectDelays(transport, count) {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (_fn, delay) => {
    delays.push(delay);
    return {}; // truthy dummy handle — never fires, never needs clearing
  };
  try {
    for (let i = 0; i < count; i++) {
      await transport.connect();
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return delays.filter((d) => d !== GATT_SETUP_TIMEOUT_MS);
}

test('BLE backoff: "not found in scan" escalates instead of staying flat at 15s forever', async () => {
  const transport = new BleTransport({
    bleManager: neverFoundBleManager(),
    iotId: 'test-iot-id',
    deviceName: 'Luba-TEST',
    onMessage: () => {},
    onStatus: () => {},
    log: () => {},
    logError: () => {},
  });

  const delays = await collectDelays(transport, 7);

  // reportFailure() increments consecutiveFailures BEFORE scheduleReconnect() reads it, so
  // the Nth consecutive miss uses delay = min(15000 * 2^N, cap), cap = 4min (N<=5) or
  // 30min (N>5, BLE_PERSISTENT_FAILURE_THRESHOLD). Previously every entry here would have
  // been 15000 (consecutiveFailures stuck at 0 for this path).
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 240_000, 960_000, 1_800_000]);
});

test('BLE backoff: does not regress a device that is actually found (no change to that path)', async () => {
  const bleManager = {
    async discover() {
      return [{
        localName: 'Luba-TEST',
        rssi: -80,
        uuid: 'peripheral-uuid',
        connect: async () => ({
          isConnected: true,
          // No matching GATT service — setupGattSession() returns 'no-service', a
          // pre-existing failure path unrelated to this fix; still goes through
          // reportFailure() same as before.
          discoverServices: async () => [],
          disconnect: async () => {},
        }),
      }];
    },
    async find() { throw new Error('no cached uuid'); },
  };
  const transport = new BleTransport({
    bleManager,
    iotId: 'test-iot-id',
    deviceName: 'Luba-TEST',
    onMessage: () => {},
    onStatus: () => {},
    log: () => {},
    logError: () => {},
  });

  const delays = await collectDelays(transport, 2);
  assert.deepEqual(delays, [30_000, 60_000]);
});
