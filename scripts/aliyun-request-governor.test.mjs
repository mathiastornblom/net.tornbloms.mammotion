import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AliyunRequestGovernor, ALIYUN_SEND_LIMIT, ALIYUN_SEND_LIMIT_WINDOW_MS,
} from '../.homeybuild/lib/mammotion/aliyun/RequestGovernor.js';

// Regression coverage for the repeated "mower goes unavailable daily, recovers after restart"
// reports (2026-07-16 log IDs 6018d080/938a4a56, 2026-07-18 log ID dc1bf4f1): the app's old
// flat 5s poll cadence for aliyun_legacy devices sent ~14x pymammotion's documented Aliyun
// limit (_SEND_LIMIT = 600 per rolling 12h). This governor is the actual enforcement mechanism
// behind the new mowing-aware poll interval (see device.ts's currentPollIntervalMs()).

test('remaining: full budget when nothing has been recorded', () => {
  const governor = new AliyunRequestGovernor();
  assert.equal(governor.remaining(1_000_000), ALIYUN_SEND_LIMIT);
});

test('recordRequest: reduces remaining by one per call', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  governor.recordRequest(now);
  governor.recordRequest(now + 1);
  assert.equal(governor.remaining(now + 2), ALIYUN_SEND_LIMIT - 2);
});

test('recordRequest: timestamps outside the rolling window are pruned, freeing up budget', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  governor.recordRequest(now);
  assert.equal(governor.remaining(now + ALIYUN_SEND_LIMIT_WINDOW_MS + 1), ALIYUN_SEND_LIMIT);
});

test('shouldSkipPoll: false while well under the safety margin', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  for (let i = 0; i < 10; i += 1) governor.recordRequest(now + i);
  assert.equal(governor.shouldSkipPoll(now + 10), false);
});

test('shouldSkipPoll: true once polling would push past the 85% safety margin', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const threshold = Math.floor(ALIYUN_SEND_LIMIT * 0.85);
  for (let i = 0; i < threshold; i += 1) governor.recordRequest(now + i);
  assert.equal(governor.shouldSkipPoll(now + threshold), true);
});

test('shouldSkipPoll: recovers once old requests age out of the rolling window', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const threshold = Math.floor(ALIYUN_SEND_LIMIT * 0.85);
  for (let i = 0; i < threshold; i += 1) governor.recordRequest(now + i);
  assert.equal(governor.shouldSkipPoll(now + ALIYUN_SEND_LIMIT_WINDOW_MS + threshold + 1), false);
});

test('a single legacy device polling at the new 120s idle cadence stays well under budget over 12h', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const idleIntervalMs = 120_000;
  const ticks = Math.floor(ALIYUN_SEND_LIMIT_WINDOW_MS / idleIntervalMs);
  for (let i = 0; i < ticks; i += 1) governor.recordRequest(now + i * idleIntervalMs);
  assert.ok(governor.remaining(now + ticks * idleIntervalMs) > 0,
    'idle-cadence polling alone should never exhaust the 12h budget for a single device');
});

// Regression coverage for a real diagnostic report (log 537eaf78-212d-4d80-a284-f93b2c2c5e21):
// an account with two aliyun_legacy mowers stayed pinned at "90 left" (the 85% safety margin)
// for over an hour straight, because the governor is shared account-wide but the 90s/120s poll
// interval was tuned assuming exactly one such device — see LubaDriver.getAliyunLegacyDeviceCount
// and device.ts's currentPollIntervalMs(), which now scales the interval by device count.

test('two legacy devices both idle-polling at the UNSCALED 120s interval exceed the 12h budget', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const idleIntervalMs = 120_000;
  const ticksPerDevice = Math.floor(ALIYUN_SEND_LIMIT_WINDOW_MS / idleIntervalMs);
  for (let i = 0; i < ticksPerDevice; i += 1) {
    governor.recordRequest(now + i * idleIntervalMs);
    governor.recordRequest(now + i * idleIntervalMs + 1);
  }
  assert.equal(governor.remaining(now + ticksPerDevice * idleIntervalMs), 0,
    'two devices sharing one account budget at the single-device interval should exhaust it');
});

test('two legacy devices idle-polling at the SCALED 240s interval (120s x 2) stay under budget', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const scaledIdleIntervalMs = 120_000 * 2;
  const ticksPerDevice = Math.floor(ALIYUN_SEND_LIMIT_WINDOW_MS / scaledIdleIntervalMs);
  for (let i = 0; i < ticksPerDevice; i += 1) {
    governor.recordRequest(now + i * scaledIdleIntervalMs);
    governor.recordRequest(now + i * scaledIdleIntervalMs + 1);
  }
  assert.ok(governor.remaining(now + ticksPerDevice * scaledIdleIntervalMs) > 0,
    'scaling the interval by device count should keep two devices comfortably under the 12h budget');
});
