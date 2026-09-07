/**
 * MQTT broker reconnect ladder test. Run after `npm run build`:
 *   node --test scripts/mqtt-reconnect-backoff.test.mjs
 *
 * Regression coverage for USER_REPORTS_INBOX R10: a broker outage of ~30 minutes during
 * which the old linear ladder (10 s × attempt, capped at 60 s) reconnected every minute,
 * each attempt also firing three post-connect reads against the dead transport.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mqttReconnectDelayMs, MQTT_RECONNECT_BASE_MS, MQTT_RECONNECT_MAX_MS } from '../.homeybuild/lib/mammotion/mqtt/reconnectBackoff.js';

test('doubles from 10 s and holds at 5 min', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40].map((n) => mqttReconnectDelayMs(n) / 1000), [10, 20, 40, 80, 160, 300, 300, 300]);
  assert.equal(MQTT_RECONNECT_BASE_MS, 10_000);
  assert.equal(MQTT_RECONNECT_MAX_MS, 300_000);
});

test('the first step stays short so a transient blip still recovers fast', () => {
  assert.equal(mqttReconnectDelayMs(1), 10_000);
  assert.equal(mqttReconnectDelayMs(0), 10_000, 'attempt 0 is treated as attempt 1, never a zero delay');
});

test('R10 regression: a 30-minute broker outage costs ~9 attempts, not ~30', () => {
  let t = 0; let n = 0;
  while (t < 30 * 60_000) { n += 1; t += mqttReconnectDelayMs(n); }
  assert.ok(n <= 10, `${n} attempts in 30 min`);
  const old = Math.ceil((30 * 60_000 - 210_000) / 60_000) + 6; // linear ramp then 60 s flat
  assert.ok(old >= 28, `old ladder: ~${old}`);
});
