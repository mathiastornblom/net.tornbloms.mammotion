/**
 * Device-routing (Luba Pro / DEV_NAVIGATION vs DEV_MAINCTL) regression test.
 * Run after `npm run build`: node --test scripts/device-routing.test.mjs
 *
 * Guards against a real bug: isLubaProDevice() originally string-matched the
 * device's user-editable display name for "luba pro", which never matches real
 * device names like "Luba-VAZSPPU6" — silently misrouting NAV commands (start/
 * dock/pause/stop/schedule-read) to the wrong receiver address for every modern
 * mower. Fixed to use productKey (always present, even for shared-not-owned
 * devices) against pymammotion's authoritative product-key-to-DeviceType mapping.
 * Cross-checked against DNAngelX/ioBroker.mammotion's independently-generated list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskControlCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';

function rcverFor(deviceName, productKey) {
  const b64 = buildTaskControlCommand('dock', '0', deviceName, { value: 0 }, productKey);
  return decodeLubaMsg(Buffer.from(b64, 'base64')).rcver;
}

test('a real LubaVA device (productKey uY54W5rM8YH) routes to DEV_NAVIGATION regardless of display name', () => {
  // This is the exact productKey confirmed live against a real paired device this session.
  // LUBA_VA = device type 15, >= LUBA_2 (2) => is_luba_pro() == true per pymammotion.
  assert.equal(rcverFor('Luba-VAZSPPU6', 'uY54W5rM8YH'), 17, 'DEV_NAVIGATION');
  assert.equal(rcverFor('My Garden Mower', 'uY54W5rM8YH'), 17, 'still DEV_NAVIGATION regardless of display name');
});

test('a legacy Luba 1 productKey routes to DEV_MAINCTL', () => {
  assert.equal(rcverFor('Luba-ABC123', 'a1UBFdq6nNz'), 1, 'DEV_MAINCTL for original Luba 1');
});

test('an unrecognized productKey still routes as modern (Luba 2+) by default', () => {
  assert.equal(rcverFor('Whatever', 'totallyUnknownKey123'), 17, 'unknown keys assumed Luba 2+, matching pymammotion devices being newer than Luba 1');
});

test('without any productKey, falls back to the (unreliable) name heuristic', () => {
  assert.equal(rcverFor('Luba-VAZSPPU6', undefined), 1, 'name fallback misses this real device — productKey should always be passed when available');
  assert.equal(rcverFor('My Luba Pro Mower', undefined), 17, 'name fallback only catches literal "pro" in the name');
});
