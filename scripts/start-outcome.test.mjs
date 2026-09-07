/**
 * Start-outcome judge test. Run after `npm run build`:
 *   node --test scripts/start-outcome.test.mjs
 *
 * Pins the verdict confirmStarted() draws from the mower's own status reports after a start
 * command, against the exact timeline USER_REPORTS_INBOX R10 showed: cloud ack, then mowing
 * at +6 s, paused at +17 s, idle at +22 s — eleven times, with the Flow action reporting
 * success every time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeStartOutcome } from '../.homeybuild/lib/mammotion/protocol/StartOutcome.js';

const W = 25_000;

test('R10: mowing → paused → idle inside the window is "started then stopped", not success', () => {
  const r10 = [
    { status: 'idle', atMs: 0 },
    { status: 'mowing', atMs: 6_000 },
    { status: 'paused', atMs: 17_000 },
    { status: 'idle', atMs: 22_000 },
  ];
  assert.equal(judgeStartOutcome(r10, W), 'started_then_stopped');
});

test('a mower that reports mowing and is still mowing at the end of the window is confirmed', () => {
  assert.equal(judgeStartOutcome([{ status: 'charging', atMs: 0 }, { status: 'mowing', atMs: 8_000 }], W), 'confirmed');
});

test('no mowing report at all inside the window is "never started"', () => {
  assert.equal(judgeStartOutcome([{ status: 'charging', atMs: 0 }], W), 'never_started');
  assert.equal(judgeStartOutcome([{ status: 'charging', atMs: 0 }, { status: 'returning', atMs: 5_000 }], W), 'never_started');
  assert.equal(judgeStartOutcome([], W), 'never_started');
});

test('a stop that happens after the window closes does not change the verdict', () => {
  // The verdict is about the start. A job that runs for a minute and then stops for a
  // legitimate reason is the mower_status_changed trigger's business, not this one's.
  assert.equal(judgeStartOutcome([{ status: 'mowing', atMs: 3_000 }, { status: 'paused', atMs: W + 5_000 }], W), 'confirmed');
});

test('mowing → paused → mowing again inside the window is confirmed (a brief pause is not a stop)', () => {
  assert.equal(judgeStartOutcome([
    { status: 'mowing', atMs: 4_000 }, { status: 'paused', atMs: 9_000 }, { status: 'mowing', atMs: 14_000 },
  ], W), 'confirmed');
});

test('events are judged in time order regardless of array order, and negative times are ignored', () => {
  assert.equal(judgeStartOutcome([
    { status: 'idle', atMs: 22_000 }, { status: 'mowing', atMs: 6_000 }, { status: 'paused', atMs: 17_000 }, { status: 'mowing', atMs: -5_000 },
  ], W), 'started_then_stopped');
  assert.equal(judgeStartOutcome([{ status: 'mowing', atMs: -1 }], W), 'never_started', 'the pre-start status does not count as a start');
});
