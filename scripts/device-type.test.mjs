/**
 * device_type.py port regression test (docs/CAPABILITY_DIFFERENTIATION_PLAN.md).
 * Run after `npm run build`: node --test scripts/device-type.test.mjs
 *
 * Locks down resolveDeviceType()/capabilitiesForModel() against real (deviceName,
 * productKey) pairs pulled from actual diagnostic reports and this repo's existing
 * device-routing.test.mjs fixtures, so a Luba 2 Mini stops being handed a headlamp toggle
 * its hardware doesn't have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceType, resolveDeviceType, isMiniOrXSeries, supportsBatteryCycleCount, capabilitiesForModel,
} from '../.homeybuild/lib/mammotion/deviceType.js';

test('Shaun\'s Luba 2 Mini (Luba-MNJR4AS3 / a1dCWYFLROK) resolves to LUBA_MN', () => {
  assert.equal(resolveDeviceType('Luba-MNJR4AS3', 'a1dCWYFLROK'), DeviceType.LUBA_MN);
});

test('a real Luba VA device (Luba-VAZSPPU6 / uY54W5rM8YH) resolves to LUBA_VA', () => {
  assert.equal(resolveDeviceType('Luba-VAZSPPU6', 'uY54W5rM8YH'), DeviceType.LUBA_VA);
});

test('a legacy Luba 1 (Luba-ABC123 / a1UBFdq6nNz) resolves to LUBA', () => {
  assert.equal(resolveDeviceType('Luba-ABC123', 'a1UBFdq6nNz'), DeviceType.LUBA);
});

test('a standard Luba 2 name prefix (Luba-VS...) resolves to LUBA_2 without a product key', () => {
  assert.equal(resolveDeviceType('Luba-VS1234', undefined), DeviceType.LUBA_2);
});

test('unknown name and product key resolves to UNKNOWN', () => {
  assert.equal(resolveDeviceType('', ''), DeviceType.UNKNOWN);
  assert.equal(resolveDeviceType('Whatever9999', 'totallyUnknownKey123'), DeviceType.UNKNOWN);
});

test('isMiniOrXSeries is true for LUBA_MN, LUBA_VP, LUBA_LD and false for LUBA_2/LUBA_VA', () => {
  assert.equal(isMiniOrXSeries(DeviceType.LUBA_MN), true);
  assert.equal(isMiniOrXSeries(DeviceType.LUBA_VP), true);
  assert.equal(isMiniOrXSeries(DeviceType.LUBA_LD), true);
  assert.equal(isMiniOrXSeries(DeviceType.LUBA_2), false);
  assert.equal(isMiniOrXSeries(DeviceType.LUBA_VA), false);
});

test('supportsBatteryCycleCount is false for LUBA_MN/LUBA_LD/LUBA_LA/LUBA_MB and true for LUBA_2/LUBA_VA', () => {
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_MN), false);
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_LD), false);
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_LA), false);
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_MB), false);
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_2), true);
  assert.equal(supportsBatteryCycleCount(DeviceType.LUBA_VA), true);
});

test('capabilitiesForModel strips measure_battery_cycles (removable pack) but keeps mow_headlamp (mini/X-series) for a Luba 2 Mini', () => {
  // Matches Mammotion-HA's switch.py exactly: MINI_AND_X_SERIES_CONFIG_SWITCH_ENTITIES
  // (manual_light/night_light) is added for is_mini_or_x_series(), which includes LUBA_MN —
  // see docs/CAPABILITY_DIFFERENTIATION_PLAN.md's 2026-07-05 decision for why this is kept
  // despite one conflicting real-world report of a Luba 2 Mini with no physical headlamp.
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  const result = capabilitiesForModel(base, DeviceType.LUBA_MN);
  assert.deepEqual(result, ['onoff', 'mow_headlamp', 'mow_side_led', 'mow_rain_protection']);
});

test('capabilitiesForModel strips only mow_headlamp (not battery cycles) for a standard Luba 2 / Luba VA — neither is mini/X-series, but both have a fixed battery', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  const withoutHeadlamp = ['onoff', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_2), withoutHeadlamp);
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_VA), withoutHeadlamp);
});

test('capabilitiesForModel keeps every base capability for a Luba 2 Pro (mini/X-series with a fixed battery)', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_VP), base);
});
