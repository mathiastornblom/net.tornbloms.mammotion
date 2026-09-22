/**
 * Aliyun connectivity result test. Run after `npm run build`:
 *   node --test scripts/aliyun-connectivity.test.mjs
 *
 * Covers isAliyunReachable(), the pure predicate that decides whether the pairing handler
 * blames "network can't reach Aliyun" versus "account genuinely has no devices". Pinned
 * against the three literal strings checkAliyunConnectivity() actually produces (see that
 * function) — including USER_REPORTS_INBOX R16's exact "TIMEOUT after 5006ms", the first
 * real report where this check itself failed rather than the handshake logic downstream of
 * it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAliyunReachable } from '../.homeybuild/lib/mammotion/aliyun/connectivityCheck.js';

test('a successful TLS handshake is reachable', () => {
  assert.equal(isAliyunReachable('OK after 831ms'), true);
  assert.equal(isAliyunReachable('OK after 1358ms'), true);
});

test('R16: a timed-out check is not reachable', () => {
  assert.equal(isAliyunReachable('TIMEOUT after 5006ms'), false);
});

test('an active reject/reset is not reachable', () => {
  assert.equal(isAliyunReachable('FAILED (ECONNREFUSED) after 12ms'), false);
  assert.equal(isAliyunReachable('FAILED (ENETUNREACH) after 3ms'), false);
});

test('the defensive fallback for an unexpected throw is not reachable', () => {
  // driver.ts's .catch() synthesizes this exact shape if checkAliyunConnectivity ever
  // rejects (it never does today, but the fallback must still read as "not reachable").
  assert.equal(isAliyunReachable('FAILED (Error: boom)'), false);
});

test('does not mistake a result that merely contains "OK" elsewhere for success', () => {
  // Guards against a naive substring check — only a leading "OK " counts, not "OK"
  // appearing anywhere in the string (e.g. inside an error code like "BROKEN").
  assert.equal(isAliyunReachable('FAILED (BROKEN) after 1ms'), false);
});
