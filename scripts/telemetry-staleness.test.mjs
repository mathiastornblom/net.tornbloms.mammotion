/**
 * Telemetry staleness rule test. Run after `npm run build`:
 *   node --test scripts/telemetry-staleness.test.mjs
 *
 * Regression coverage for USER_REPORTS_INBOX R12.3: a device page rendering five-day-old
 * data as current, with no unavailable state and nothing for a Flow to alarm on. These
 * tests pin the rule the watchdog in device.ts applies — "three times the interval the poll
 * loop itself last scheduled, never less than ten minutes" — and, above all, that it
 * never contradicts the budget pacing (A1) or the failure backoff (A2): a device the app
 * has *deliberately* slowed to one poll per 30 minutes must not be flagged as lost 12
 * minutes later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { staleAfterMs, isTelemetryStale, STALE_FLOOR_MS, STALE_INTERVAL_MULTIPLIER } from '../.homeybuild/lib/mammotion/staleness.js';
import { AliyunRequestGovernor, ALIYUN_SEND_LIMIT } from '../.homeybuild/lib/mammotion/aliyun/RequestGovernor.js';
import { pollBackoffMs, ACCOUNT_BACKOFF_MAX_MS, UNBOUND_BACKOFF_MS } from '../.homeybuild/lib/mammotion/aliyun/pollBackoff.js';

const MIN = 60_000;

test('the floor is 10 minutes and the multiplier is 3', () => {
  assert.equal(STALE_FLOOR_MS, 10 * MIN);
  assert.equal(STALE_INTERVAL_MULTIPLIER, 3);
});

test('fast cadences get the floor: MQTT at 5s and legacy idle at 120s are both 10 min', () => {
  // 3 × 5 s and 3 × 120 s are both under the floor — a couple of missed polls plus a
  // backoff step is not yet a lost mower.
  assert.equal(staleAfterMs(5_000), 10 * MIN);
  assert.equal(staleAfterMs(120_000), 10 * MIN);
  assert.equal(staleAfterMs(200_000), 10 * MIN, '3 × 200 s = 10 min exactly meets the floor');
});

test('slow cadences scale: the threshold tracks whatever the poll loop chose', () => {
  assert.equal(staleAfterMs(600_000), 30 * MIN, 'budget tier 2 (10 min) → 30 min');
  assert.equal(staleAfterMs(1_800_000), 90 * MIN, 'budget tier 3 / penalty cap (30 min) → 90 min');
});

test('nonsense intervals fall back to the floor rather than to zero', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.equal(staleAfterMs(bad), 10 * MIN, `interval ${bad}`);
});

test('nothing received yet is never stale — the baseline at start protects a restart', () => {
  // A restart must not trip on a days-old stored last_sync before the transports have
  // even tried; the watchdog baselines lastTelemetryAt to the start time, and until then
  // (null) the rule says "not stale".
  assert.equal(isTelemetryStale(null, Date.now(), 5_000), false);
});

test('R12.3: five days of silence is stale at every cadence the app can ever schedule', () => {
  const now = 1_000_000_000;
  const fiveDaysAgo = now - 5 * 24 * 60 * MIN;
  for (const interval of [5_000, 120_000, 600_000, 1_800_000, ACCOUNT_BACKOFF_MAX_MS, UNBOUND_BACKOFF_MS]) {
    assert.equal(isTelemetryStale(fiveDaysAgo, now, interval), true, `at a ${interval / 1000}s cadence`);
  }
});

test('never contradicts A1: a device paced to one poll per 30 min is not stale 45 min in', () => {
  // Drive the real governor to its slowest tier, take the delay it hands the poll loop, and
  // check the watchdog gives that delay three full periods before calling the data stale.
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const cap = governor.pollCap();
  for (let i = 0; i < cap; i += 1) governor.recordRequest(now + i);
  const paced = governor.pollDelayMs(120_000, now + cap);
  assert.equal(paced, 1_800_000, 'precondition: tier 3 is 30 min');
  const lastHeard = now + cap;
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 45 * MIN, paced), false, '45 min: still inside 3 × 30 min');
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 89 * MIN, paced), false, '89 min: still inside');
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 91 * MIN, paced), true, '91 min: three expected polls missed — now stale');
});

test('never contradicts A2: a device in the 30-min penalty backoff is not stale until 90 min', () => {
  const backoff = pollBackoffMs('account_penalty', 6);
  assert.equal(backoff, 30 * MIN, 'precondition');
  const lastHeard = 1_000_000;
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 60 * MIN, backoff), false);
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 91 * MIN, backoff), true);
});

test('an MQTT device silent for 11 minutes is stale — 130 missed reports is not a blip', () => {
  const lastHeard = 1_000_000;
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 9 * MIN, 5_000), false);
  assert.equal(isTelemetryStale(lastHeard, lastHeard + 11 * MIN, 5_000), true);
});

test('the rule is monotonic in silence and in cadence', () => {
  const lastHeard = 0;
  for (let interval = 5_000; interval <= 2_000_000; interval *= 2) {
    let flipped = false;
    for (let t = 0; t <= 200 * MIN; t += MIN) {
      const stale = isTelemetryStale(lastHeard, t, interval);
      if (flipped) assert.equal(stale, true, `once stale at interval ${interval}, stays stale`);
      if (stale) flipped = true;
    }
    assert.equal(flipped, true, `eventually stale at interval ${interval}`);
  }
  assert.ok(staleAfterMs(1_800_000) > staleAfterMs(600_000) && staleAfterMs(600_000) > staleAfterMs(120_000) - 1);
  assert.ok(ALIYUN_SEND_LIMIT > 0);
});
