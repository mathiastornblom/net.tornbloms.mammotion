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

// ── Failure classification and parking (USER_REPORTS_INBOX R5/R7/R8/R10) ─────────────────
//
// Three failure modes used to share one counter and one message. These drive the real
// transport with fakes for each mode and assert what gets logged, and that after ~6 h at
// the quiet cadence the transport parks at 2 h and goes quiet until something changes.

function withLogCapture(bleManager) {
  const lines = [];
  const transport = new BleTransport({
    bleManager,
    iotId: 'test-iot-id',
    deviceName: 'Luba-TEST',
    onMessage: () => {},
    onStatus: () => {},
    log: (m) => lines.push(m),
    logError: (m) => lines.push(`ERR ${m}`),
  });
  return { transport, lines };
}

const othersOnlyBleManager = () => ({
  async discover() { return [{ localName: 'Luba-OTHER', rssi: -80 }, { localName: 'Fridge', rssi: -60 }]; },
  async find() { throw new Error('no cached uuid'); },
});
const foundButUnconnectableBleManager = () => ({
  async discover() { return [{ localName: 'Luba-TEST', rssi: -85, async connect() { throw new Error('BLE Timeout'); } }]; },
  async find() { throw new Error('no cached uuid'); },
});

test('BLE classification: an empty scan is "radio silent", not "mower out of range"', async () => {
  const { transport, lines } = withLogCapture(neverFoundBleManager());
  await collectDelays(transport, 1);
  assert.ok(lines.some((l) => /no advertisements at all/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /not found in scan/.test(l)));
});

test('BLE classification: three empty scans in a row produce exactly one radio notice', async () => {
  const { transport, lines } = withLogCapture(neverFoundBleManager());
  await collectDelays(transport, 6);
  const notices = lines.filter((l) => /hub's Bluetooth radio/.test(l));
  assert.equal(notices.length, 1, lines.join('\n'));
});

test('BLE classification: others seen but not this mower is "out of range", with the count', async () => {
  const { transport, lines } = withLogCapture(othersOnlyBleManager());
  await collectDelays(transport, 1);
  assert.ok(lines.some((l) => /not found in scan \(2 other advertisement\(s\) seen\)/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /hub's Bluetooth radio/.test(l)), 'a radio that sees other devices is not silent');
});

test('BLE classification: mower seen but the link fails is "connect failed"', async () => {
  const { transport, lines } = withLogCapture(foundButUnconnectableBleManager());
  await collectDelays(transport, 1);
  assert.ok(lines.some((l) => /found Luba-TEST/.test(l)));
  assert.ok(lines.some((l) => /connect failed: BLE Timeout/.test(l)), lines.join('\n'));
});

test('BLE parking: after the persistent threshold plus 12 more failures the cadence is 2 h', async () => {
  const { transport } = withLogCapture(othersOnlyBleManager());
  const delays = await collectDelays(transport, 20);
  // Failure #1..#5: 4-min cap; #6..#17: 30-min quiet cap; #18+: parked at 2 h.
  assert.equal(delays[16], 30 * 60_000, 'failure #17 is still the quiet cadence');
  assert.equal(delays[17], 2 * 60 * 60_000, 'failure #18 is parked');
  assert.equal(delays[19], 2 * 60 * 60_000, 'and it stays parked');
});

test('BLE parking: one notice when parking, then silence until the failure kind changes', async () => {
  const { transport, lines } = withLogCapture(othersOnlyBleManager());
  await collectDelays(transport, 25);
  const parkNotices = lines.filter((l) => /parking/.test(l));
  assert.equal(parkNotices.length, 1, 'exactly one parking line');
  const perAttemptAfterPark = lines.slice(lines.findIndex((l) => /parking/.test(l)) + 1)
    .filter((l) => /scheduling reconnect|not found in scan/.test(l));
  assert.equal(perAttemptAfterPark.length, 0, `no per-attempt lines while parked, got:\n${perAttemptAfterPark.join('\n')}`);
});

test('BLE parking: a change of failure kind while parked is logged once, then quiet again', async () => {
  let mode = 'others';
  const switching = {
    async discover() { return mode === 'others' ? [{ localName: 'Luba-OTHER', rssi: -80 }] : []; },
    async find() { throw new Error('no cached uuid'); },
  };
  const { transport, lines } = withLogCapture(switching);
  await collectDelays(transport, 20); // parked, out_of_range
  const before = lines.length;
  mode = 'silent';
  await collectDelays(transport, 3); // radio_silent ×3 — the kind changed once
  const added = lines.slice(before);
  assert.equal(added.filter((l) => /no advertisements at all/.test(l)).length, 1, `one line for the change, got:\n${added.join('\n')}`);
});
