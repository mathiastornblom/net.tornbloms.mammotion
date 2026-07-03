import test from 'node:test';
import assert from 'node:assert/strict';

import { checkInvokeResponse } from '../.homeybuild/lib/mammotion/mqtt/MqttClient.js';
import { DeviceOfflineError, MqttCommandError } from '../.homeybuild/lib/mammotion/errors.js';

// Regression coverage for a real user-reported gap: sending a command to a mower that's
// powered off returned {"code":50104,"msg":"The device is offline"} over MQTT, but the
// app treated any HTTP-level response as success and never reflected this on the Homey
// device's availability.

test('checkInvokeResponse returns raw unchanged on code:0 success', () => {
  const raw = '{"code":0,"data":{}}';
  assert.equal(checkInvokeResponse(raw, 'Luba-TEST'), raw);
});

test('checkInvokeResponse returns raw unchanged when code is absent', () => {
  const raw = '{"data":{}}';
  assert.equal(checkInvokeResponse(raw, 'Luba-TEST'), raw);
});

test('checkInvokeResponse returns raw unchanged for a non-JSON body', () => {
  const raw = 'not json';
  assert.equal(checkInvokeResponse(raw, 'Luba-TEST'), raw);
});

test('checkInvokeResponse throws DeviceOfflineError for code 50104', () => {
  const raw = '{"code":50104,"msg":"The device is offline"}';
  assert.throws(
    () => checkInvokeResponse(raw, 'Luba-VAZSPPU6'),
    (err) => err instanceof DeviceOfflineError && err.message.includes('Luba-VAZSPPU6'),
  );
});

test('checkInvokeResponse throws MqttCommandError for any other non-zero code', () => {
  const raw = '{"code":40000,"msg":"Something else went wrong"}';
  assert.throws(
    () => checkInvokeResponse(raw, 'Luba-TEST'),
    (err) => err instanceof MqttCommandError && err.code === 40000,
  );
});
