import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCredentialsFresh, pruneFailures, isCircuitOpen, circuitRetryAfterMs,
  AliyunCredentialsManager,
  ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS, ALIYUN_CIRCUIT_BREAKER_WINDOW_MS, ALIYUN_CIRCUIT_BREAKER_LIMIT,
} from '../.homeybuild/lib/mammotion/aliyun/AliyunCredentialsManager.js';
import { AliyunCircuitOpenError } from '../.homeybuild/lib/mammotion/errors.js';

// Regression coverage for a real diagnostic report (2026-07-04): the driver previously cached
// Aliyun legacy credentials only in memory with no expiry check, so a failed handshake meant
// every subsequent ~5-10s poll tick re-ran the entire 6-step handshake from scratch — hammering
// Aliyun's servers and directly contributing to the HTTP 429 rate-limiting also observed that
// day. This ports pymammotion's TokenManager shape (persisted, expiry-aware reuse + a circuit
// breaker) in scoped form — see AliyunCredentialsManager.ts's header comment.

test('isCredentialsFresh: true when expiry is well beyond the buffer window', () => {
  const now = 1_000_000;
  assert.equal(isCredentialsFresh(now + ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS + 1, now), true);
});

test('isCredentialsFresh: false once inside the buffer window', () => {
  const now = 1_000_000;
  assert.equal(isCredentialsFresh(now + ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS - 1, now), false);
});

test('isCredentialsFresh: false once already expired', () => {
  const now = 1_000_000;
  assert.equal(isCredentialsFresh(now - 1, now), false);
});

test('pruneFailures: drops timestamps older than the window', () => {
  const now = 1_000_000;
  const failures = [now - ALIYUN_CIRCUIT_BREAKER_WINDOW_MS - 1, now - 1000];
  assert.deepEqual(pruneFailures(failures, now), [now - 1000]);
});

test('isCircuitOpen: false below the failure limit', () => {
  const now = 1_000_000;
  const failures = Array.from({ length: ALIYUN_CIRCUIT_BREAKER_LIMIT - 1 }, () => now - 1000);
  assert.equal(isCircuitOpen(failures, now), false);
});

test('isCircuitOpen: true once the limit is reached within the window', () => {
  const now = 1_000_000;
  const failures = Array.from({ length: ALIYUN_CIRCUIT_BREAKER_LIMIT }, () => now - 1000);
  assert.equal(isCircuitOpen(failures, now), true);
});

test('isCircuitOpen: stale failures outside the window do not count', () => {
  const now = 1_000_000;
  const failures = Array.from({ length: ALIYUN_CIRCUIT_BREAKER_LIMIT }, () => now - ALIYUN_CIRCUIT_BREAKER_WINDOW_MS - 1);
  assert.equal(isCircuitOpen(failures, now), false);
});

test('circuitRetryAfterMs: 0 when the circuit is not open', () => {
  assert.equal(circuitRetryAfterMs([], 1_000_000), 0);
});

test('circuitRetryAfterMs: positive and bounded by the window when open', () => {
  const now = 1_000_000;
  const failures = [now - 1000, now - 500];
  const retryAfter = circuitRetryAfterMs(failures, now);
  assert.ok(retryAfter > 0 && retryAfter <= ALIYUN_CIRCUIT_BREAKER_WINDOW_MS);
});

test('AliyunCircuitOpenError: message includes the retry estimate', () => {
  const err = new AliyunCircuitOpenError(45_000);
  assert.match(err.message, /45s/);
  assert.equal(err.name, 'AliyunCircuitOpenError');
});

const fakeCredentials = (expiresAt) => ({
  apiGatewayEndpoint: 'eu-central-1.api-iot.aliyuncs.com',
  regionId: 'eu-central-1',
  deviceSecret: 'secret',
  productKey: 'product',
  deviceName: 'device',
  iotToken: 'token',
  iotTokenExpiresAt: expiresAt,
});

function makeHarness({ now = 1_000_000, probeImpl } = {}) {
  let clock = now;
  let saved = null;
  const manager = new AliyunCredentialsManager({
    load: () => null,
    save: (c) => { saved = c; },
    log: () => {},
    logError: () => {},
    now: () => clock,
    probe: probeImpl,
  });
  return {
    manager,
    advance: (ms) => { clock += ms; },
    getSaved: () => saved,
  };
}

test('AliyunCredentialsManager: seed() populates cache without a handshake', () => {
  const { manager, getSaved } = makeHarness();
  const credentials = fakeCredentials(1_000_000 + ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS * 2);
  manager.seed(credentials);
  assert.deepEqual(getSaved(), credentials);
});

test('AliyunCredentialsManager: invalidate() clears the cache and persists null', () => {
  const { manager, getSaved } = makeHarness();
  manager.seed(fakeCredentials(2_000_000));
  manager.invalidate();
  assert.equal(getSaved(), null);
});

test('AliyunCredentialsManager: ensure() reuses fresh seeded credentials without probing', async () => {
  let probeCalls = 0;
  const { manager } = makeHarness({
    probeImpl: async () => { probeCalls += 1; return { credentials: fakeCredentials(9_000_000) }; },
  });
  manager.seed(fakeCredentials(1_000_000 + ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS * 5));
  const result = await manager.ensure({});
  assert.equal(result.iotToken, 'token');
  assert.equal(probeCalls, 0);
});

test('AliyunCredentialsManager: ensure() re-probes once seeded credentials are near expiry', async () => {
  let probeCalls = 0;
  const { manager } = makeHarness({
    probeImpl: async () => { probeCalls += 1; return { credentials: fakeCredentials(9_000_000) }; },
  });
  manager.seed(fakeCredentials(1_000_000 + ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS - 1));
  const result = await manager.ensure({});
  assert.equal(probeCalls, 1);
  assert.equal(result.iotTokenExpiresAt, 9_000_000);
});

test('AliyunCredentialsManager: concurrent ensure() calls share one in-flight probe', async () => {
  let probeCalls = 0;
  const { manager } = makeHarness({
    probeImpl: async () => {
      probeCalls += 1;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      return { credentials: fakeCredentials(9_000_000) };
    },
  });
  const [a, b] = await Promise.all([manager.ensure({}), manager.ensure({})]);
  assert.equal(probeCalls, 1);
  assert.equal(a.iotToken, b.iotToken);
});

test('AliyunCredentialsManager: circuit breaker opens after repeated failures within the window', async () => {
  const { manager, advance } = makeHarness({
    probeImpl: async () => { throw new Error('simulated handshake failure'); },
  });
  await assert.rejects(() => manager.ensure({}), /simulated handshake failure/);
  advance(1000);
  await assert.rejects(() => manager.ensure({}), /simulated handshake failure/);
  // Third call within the window should fail fast via the circuit breaker, not attempt
  // another handshake — verified by the distinct error type/message.
  advance(1000);
  await assert.rejects(() => manager.ensure({}), (err) => err instanceof AliyunCircuitOpenError);
});

test('AliyunCredentialsManager: a successful refresh resets the failure count', async () => {
  let callCount = 0;
  const { manager, advance } = makeHarness({
    probeImpl: async () => {
      callCount += 1;
      if (callCount <= 2) throw new Error('simulated handshake failure');
      return { credentials: fakeCredentials(9_000_000) };
    },
  });
  await assert.rejects(() => manager.ensure({}));
  advance(1000);
  // Circuit breaker limit is 2 — this call is the 2nd failure, opening the circuit.
  await assert.rejects(() => manager.ensure({}));
  advance(ALIYUN_CIRCUIT_BREAKER_WINDOW_MS + 1);
  // Window has passed, so the circuit is closed again and this attempt succeeds.
  const result = await manager.ensure({});
  assert.equal(result.iotToken, 'token');
  assert.equal(manager.isCircuitBreakerOpen, false);
});

test('AliyunCredentialsManager: resetCircuitBreaker() closes an open circuit immediately, mid-window', async () => {
  // Regression coverage for a real diagnostic report (2026-07-06): during a genuine Aliyun
  // outage, the circuit breaker kept re-opening itself indefinitely (every retry landed
  // right as the window closed, failed immediately, and re-armed it for another full
  // window) — and Repair didn't clear this at all, only a full app restart did. This is
  // the fix: a manual reset the Repair flow can call (see LubaDriver.resetAliyunConnection()).
  const { manager, advance } = makeHarness({
    probeImpl: async () => { throw new Error('simulated handshake failure'); },
  });
  await assert.rejects(() => manager.ensure({}));
  advance(1000);
  await assert.rejects(() => manager.ensure({}));
  assert.equal(manager.isCircuitBreakerOpen, true);

  manager.resetCircuitBreaker();
  assert.equal(manager.isCircuitBreakerOpen, false);

  // Immediately retries (no need to wait out the window) — still fails since the
  // underlying handshake is still broken, but as a real attempt, not a fast-fail.
  await assert.rejects(() => manager.ensure({}), /simulated handshake failure/);
});
