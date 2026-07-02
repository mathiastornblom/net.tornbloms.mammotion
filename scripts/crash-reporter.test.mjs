import test from 'node:test';
import assert from 'node:assert/strict';

import { scrub } from '../.homeybuild/lib/util/CrashReporter.js';

test('scrub redacts email addresses', () => {
  const out = scrub('Login failed for user.name+tag@example.co.uk during auth');
  assert.ok(!out.includes('example.co.uk'), out);
  assert.ok(out.includes('[email]'), out);
});

test('scrub redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  const out = scrub(`token refresh failed: ${jwt}`);
  assert.ok(!out.includes('SflKxwRJ'), out);
  assert.ok(out.includes('[jwt]'), out);
});

test('scrub redacts bearer tokens', () => {
  const out = scrub('request rejected: Bearer abc123.def-456');
  assert.ok(out.includes('Bearer [token]'), out);
});

test('scrub redacts long hex identifiers (iotIds, device ids)', () => {
  const out = scrub('device 3bda1dc673b1490da6fce7809650308b not reachable');
  assert.ok(!out.includes('3bda1dc6'), out);
  assert.ok(out.includes('[hex-id]'), out);
});

test('scrub leaves ordinary error text intact', () => {
  const msg = 'GATT setup timed out after 8000ms';
  assert.equal(scrub(msg), msg);
});
