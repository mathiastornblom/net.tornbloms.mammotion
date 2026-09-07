import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AliyunRequestGovernor, ALIYUN_SEND_LIMIT, ALIYUN_SEND_LIMIT_WINDOW_MS, ALIYUN_COMMAND_RESERVE,
  POLL_DELAY_TIERS,
} from '../.homeybuild/lib/mammotion/aliyun/RequestGovernor.js';

// Regression coverage for two generations of the same problem.
//
// First: the repeated "mower goes unavailable daily, recovers after restart" reports (2026-07-16
// log IDs 6018d080/938a4a56, 2026-07-18 log ID dc1bf4f1) — the app's old flat 5s poll cadence
// for aliyun_legacy devices sent ~14x pymammotion's documented Aliyun limit (_SEND_LIMIT = 600
// per rolling 12h). This governor is the enforcement mechanism behind the slower cadence.
//
// Second: the governor's own original cutoff. Two diagnostic reports from one two-mower
// account thirteen days apart (USER_REPORTS_INBOX R5/R8) both showed `90 left in the current
// 12h window` frozen for an hour with zero telemetry while both mowers were working — 90 being
// exactly 600 − 510, the poll cap. Once the cap was hit polling stopped dead, and skipped polls
// record nothing, so the count could only fall as old requests aged out: up to twelve hours of
// silence. Two idle devices at 120 s are 720 requests per window against a cap of 510, so any
// two-mower account hit that wall every single window by construction. The tests from
// 'usageTier' down pin the replacement: polling slows in tiers and only ever *stops* when the
// command reserve is all that is left.

const IDLE_MS = 120_000;
const POLL_CAP = Math.floor(ALIYUN_SEND_LIMIT * 0.85);

function filled(count, now = 1_000_000) {
  const governor = new AliyunRequestGovernor();
  for (let i = 0; i < count; i += 1) governor.recordRequest(now + i);
  return { governor, now: now + count };
}

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

test('pollCap is 85% of the real limit', () => {
  assert.equal(new AliyunRequestGovernor().pollCap(), POLL_CAP);
});

test('usageTier: steps through 0/1/2/3 at 60/80/95% of the poll cap', () => {
  const at = (fraction) => filled(Math.ceil(POLL_CAP * fraction));
  assert.equal(at(0.10).governor.usageTier(at(0.10).now), 0);
  assert.equal(at(0.59).governor.usageTier(at(0.59).now), 0);
  assert.equal(at(0.60).governor.usageTier(at(0.60).now), 1);
  assert.equal(at(0.80).governor.usageTier(at(0.80).now), 2);
  assert.equal(at(0.95).governor.usageTier(at(0.95).now), 3);
  assert.equal(at(1.00).governor.usageTier(at(1.00).now), 3);
});

test('pollDelayMs: 120s idle cadence becomes 240/600/1800s across the tiers, never zero', () => {
  const expect = [1, ...POLL_DELAY_TIERS.map(([, m]) => m)].map((m) => IDLE_MS * m);
  assert.deepEqual(expect, [120_000, 240_000, 600_000, 1_800_000], 'tier table matches the plan (2 → 10 → 30 min)');
  for (const [fraction, delay] of [[0.1, 120_000], [0.6, 240_000], [0.8, 600_000], [0.95, 1_800_000], [1.0, 1_800_000]]) {
    const { governor, now } = filled(Math.ceil(POLL_CAP * fraction));
    assert.equal(governor.pollDelayMs(IDLE_MS, now), delay, `at ${fraction * 100}% of the poll cap`);
  }
});

test('R5/R8 regression: at exactly the poll cap polling SLOWS, it does not stop', () => {
  // This is the old 'true once polling would push past the 85% safety margin' assertion,
  // inverted on purpose. 510 used, 90 left — the exact frozen number from both reports.
  const { governor, now } = filled(POLL_CAP);
  assert.equal(governor.remaining(now), 90);
  assert.equal(governor.shouldSkipPoll(now), false, 'reaching the cap must not stop polling any more');
  assert.equal(governor.pollDelayMs(IDLE_MS, now), 1_800_000, 'it drops to the slowest tier instead');
});

test('shouldSkipPoll: true only once nothing but the command reserve is left', () => {
  const justAbove = filled(ALIYUN_SEND_LIMIT - ALIYUN_COMMAND_RESERVE - 1);
  assert.equal(justAbove.governor.shouldSkipPoll(justAbove.now), false);
  const atReserve = filled(ALIYUN_SEND_LIMIT - ALIYUN_COMMAND_RESERVE);
  assert.equal(atReserve.governor.shouldSkipPoll(atReserve.now), true);
  assert.equal(atReserve.governor.pollDelayMs(IDLE_MS, atReserve.now), null, 'callers get null, not a number, when polling must pause');
});

test('shouldSkipPoll: recovers once old requests age out of the rolling window', () => {
  const { governor, now } = filled(ALIYUN_SEND_LIMIT - ALIYUN_COMMAND_RESERVE);
  assert.equal(governor.shouldSkipPoll(now + ALIYUN_SEND_LIMIT_WINDOW_MS + 1), false);
});

test('a single legacy device polling at the 120s idle cadence stays in tier 0/1 over 12h', () => {
  const governor = new AliyunRequestGovernor();
  const now = 1_000_000;
  const ticks = Math.floor(ALIYUN_SEND_LIMIT_WINDOW_MS / IDLE_MS);
  for (let i = 0; i < ticks; i += 1) governor.recordRequest(now + i * IDLE_MS);
  assert.ok(governor.remaining(now + ticks * IDLE_MS) > ALIYUN_COMMAND_RESERVE);
  assert.ok(governor.usageTier(now + ticks * IDLE_MS) <= 1, 'one mower alone should never even reach the slow tiers');
});

/** Drives N devices through 12h of polling, each asking the shared governor for its next
 *  delay exactly as device.ts's runPollTick does. Returns per-step stats. */
function simulate(deviceCount, { paced }) {
  const governor = new AliyunRequestGovernor();
  const start = 1_000_000;
  const end = start + ALIYUN_SEND_LIMIT_WINDOW_MS;
  const next = Array.from({ length: deviceCount }, () => start); // lockstep, the worst case
  let sent = 0; let skipped = 0; let minRemaining = ALIYUN_SEND_LIMIT; let maxTier = 0;
  for (;;) {
    const i = next.indexOf(Math.min(...next));
    const t = next[i];
    if (t >= end) break;
    const delay = paced ? governor.pollDelayMs(IDLE_MS, t) : IDLE_MS;
    if (delay === null) { skipped += 1; next[i] = t + IDLE_MS; continue; }
    governor.recordRequest(t); sent += 1;
    minRemaining = Math.min(minRemaining, governor.remaining(t));
    maxTier = Math.max(maxTier, governor.usageTier(t));
    next[i] = t + delay;
  }
  return { sent, skipped, minRemaining, maxTier, governor, end };
}

test('the deterministic bug: two idle devices at 120s each overrun the poll cap in one window', () => {
  const r = simulate(2, { paced: false });
  assert.equal(r.sent, 720, '2 × 360 — this is R5/R8\'s account');
  assert.ok(r.sent > POLL_CAP, 'and it is over the 510 cap by construction, every window');
});

test('with pacing, two idle devices stay above the command reserve for the whole window and keep polling', () => {
  const r = simulate(2, { paced: true });
  assert.ok(r.minRemaining > ALIYUN_COMMAND_RESERVE, `remaining never fell to the reserve (min ${r.minRemaining})`);
  assert.equal(r.skipped, 0, 'no poll was ever refused outright — it only slowed');
  assert.ok(r.sent < 720 && r.sent > 100, `sent ${r.sent}: fewer than unpaced, far more than zero`);
  assert.ok(r.maxTier >= 2, 'the slow tiers were actually exercised, so this is not a trivial pass');
});

test('with pacing, even four devices never stop polling and never breach the reserve', () => {
  const r = simulate(4, { paced: true });
  assert.ok(r.minRemaining > ALIYUN_COMMAND_RESERVE);
  assert.equal(r.skipped, 0);
});

test('snapshot/restore round-trips the window and drops expired or malformed entries', () => {
  const { governor, now } = filled(50);
  const snap = governor.snapshot();
  assert.equal(snap.length, 50);
  const fresh = new AliyunRequestGovernor();
  fresh.restore([...snap, 'nope', NaN, now + 999_999_999, now - ALIYUN_SEND_LIMIT_WINDOW_MS - 1], now);
  assert.equal(fresh.used(now), 50, 'kept exactly the 50 valid in-window timestamps');
  fresh.restore(undefined, now);
  assert.equal(fresh.used(now), 50, 'a missing saved value is ignored, not an error');
});

test('setChangeListener fires on every recordRequest', () => {
  const governor = new AliyunRequestGovernor();
  let n = 0;
  governor.setChangeListener(() => { n += 1; });
  governor.recordRequest(1); governor.recordRequest(2);
  assert.equal(n, 2);
  governor.setChangeListener(null);
  governor.recordRequest(3);
  assert.equal(n, 2);
});
