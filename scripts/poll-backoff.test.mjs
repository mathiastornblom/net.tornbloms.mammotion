/**
 * Poll backoff ladder test. Run after `npm run build`:
 *   node --test scripts/poll-backoff.test.mjs
 *
 * Regression coverage for USER_REPORTS_INBOX R7: `next check in 60s` repeated to failure
 * #1374 — a day — alternating `rate-limited by Aliyun` and `gateway error (29004)`. One
 * ladder capped at 60 s was applied to every failure kind, so an account-wide 429 was
 * retried 720 times per 12 h window against a 600 limit, sustaining itself; and 29004 is
 * DEVICE_UNBOUND, which polling cannot fix at all. These tests pin the three ladders that
 * replace it and the composition rule with the budget governor's pacing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pollBackoffMs, composeWithPacing,
  OFFLINE_BACKOFF_MAX_MS, ACCOUNT_BACKOFF_BASE_MS, ACCOUNT_BACKOFF_MAX_MS, UNBOUND_BACKOFF_MS,
  ACCOUNT_PENALTY_WARN_AFTER, UNBOUND_UNAVAILABLE_AFTER,
} from '../.homeybuild/lib/mammotion/aliyun/pollBackoff.js';
import { ALIYUN_SEND_LIMIT, ALIYUN_SEND_LIMIT_WINDOW_MS } from '../.homeybuild/lib/mammotion/aliyun/RequestGovernor.js';
import { ALIYUN_INVOKE_CODE } from '../.homeybuild/lib/mammotion/aliyun/commands.js';

const MIN = 60_000;

test('device_offline keeps the pre-existing ladder: 20s, 40s, then 60s flat', () => {
  // A mower that is merely switched off should still be noticed within a minute of coming
  // back — this ladder is deliberately unchanged from before.
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => pollBackoffMs('device_offline', n)), [20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(OFFLINE_BACKOFF_MAX_MS, MIN);
});

test('account_penalty climbs 1 → 2 → 4 → 8 → 16 → 30 min and holds there', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map((n) => pollBackoffMs('account_penalty', n) / MIN), [1, 2, 4, 8, 16, 30, 30, 30]);
  assert.equal(ACCOUNT_BACKOFF_BASE_MS, MIN);
  assert.equal(ACCOUNT_BACKOFF_MAX_MS, 30 * MIN);
});

test('device_unbound is flat 30 min from the first failure — there is no ladder to climb', () => {
  for (const n of [1, 2, 5, 100]) assert.equal(pollBackoffMs('device_unbound', n), UNBOUND_BACKOFF_MS);
  assert.equal(UNBOUND_BACKOFF_MS, 30 * MIN);
});

test('a failure count below 1 is treated as the first failure, never as zero delay', () => {
  assert.equal(pollBackoffMs('account_penalty', 0), MIN);
  assert.equal(pollBackoffMs('device_offline', -3), 20_000);
});

test('29004 really is DEVICE_UNBOUND — the code the R7 log alternated with 429', () => {
  // The plan asked "what does 29004 mean?"; the answer was already in commands.ts. Pinned
  // here so the classification in device.ts cannot drift away from the constant.
  assert.equal(ALIYUN_INVOKE_CODE.DEVICE_UNBOUND, 29004);
});

test('composeWithPacing: the slower of backoff and pacing wins; null pacing yields the backoff', () => {
  assert.equal(composeWithPacing(20_000, 120_000), 120_000, 'an offline mower on a paced account may not retry faster than the tier allows');
  assert.equal(composeWithPacing(30 * MIN, 120_000), 30 * MIN, 'a long penalty backoff is not shortened by a fast tier');
  assert.equal(composeWithPacing(20_000, null), 20_000, 'when the governor has paused polling, the backoff alone schedules the re-check');
});

test('thresholds: a single transient failure never shows a warning or flips availability', () => {
  assert.ok(ACCOUNT_PENALTY_WARN_AFTER >= 2);
  assert.ok(UNBOUND_UNAVAILABLE_AFTER >= 2);
});

/** How many requests a permanently-failing account sends in one 12 h window under a ladder,
 *  starting from the first failure. This is the R7 shape: every attempt fails the same way. */
function requestsPer12h(kind) {
  let t = 0; let n = 0; let sent = 0;
  while (t < ALIYUN_SEND_LIMIT_WINDOW_MS) {
    sent += 1; n += 1;
    t += pollBackoffMs(kind, n);
  }
  return sent;
}

test('R7 regression: a day of permanent 429 no longer sends hundreds of requests', () => {
  const oldLadder = Math.floor(ALIYUN_SEND_LIMIT_WINDOW_MS / OFFLINE_BACKOFF_MAX_MS); // what the 60s cap produced
  assert.equal(oldLadder, 720, 'the old behaviour: 720 per window, above the 600 limit — R7 reached failure #1374 in about a day');
  const now = requestsPer12h('account_penalty');
  assert.ok(now < 40, `account_penalty sends ${now} per 12h — a small fraction of the limit`);
  assert.ok(now < ALIYUN_SEND_LIMIT / 10, 'well under a tenth of the budget, so a penalised account can still recover');
});

test('R7 regression: an unbound mower is checked ~24 times a day, not 1440', () => {
  const now = requestsPer12h('device_unbound');
  assert.equal(now, 24, `device_unbound sends ${now} per 12h`);
});
