/**
 * device_type.py port regression test (docs/CAPABILITY_DIFFERENTIATION_PLAN.md).
 * Run after `npm run build`: node --test scripts/device-type.test.mjs
 *
 * Locks down resolveDeviceType()/capabilitiesForModel() against real (deviceName,
 * productKey) pairs pulled from actual diagnostic reports and this repo's existing
 * device-routing.test.mjs fixtures. Covers the 2026-07-09 correction: mow_headlamp is gated
 * by hasHeadlamp() (any Luba/Yuka-family mower), not isMiniOrXSeries() — the latter gates an
 * unrelated manual/night-light *mode* UI upstream, not headlamp hardware presence, and had
 * wrongly stripped mow_headlamp from real LUBA_2/LUBA_VA devices (both vendor-confirmed to
 * have a headlamp).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceType, resolveDeviceType, isMiniOrXSeries, hasHeadlamp, supportsBatteryCycleCount, capabilitiesForModel,
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

test('hasHeadlamp is true for LUBA_2, LUBA_MN, LUBA_VA (all vendor-confirmed to have a headlamp)', () => {
  assert.equal(hasHeadlamp(DeviceType.LUBA_2), true);
  assert.equal(hasHeadlamp(DeviceType.LUBA_MN), true);
  assert.equal(hasHeadlamp(DeviceType.LUBA_VA), true);
});

test('hasHeadlamp is false for RTK base stations and swimming-pool robots (not mowers)', () => {
  assert.equal(hasHeadlamp(DeviceType.RTK), false);
  assert.equal(hasHeadlamp(DeviceType.RTK3A2), false);
  assert.equal(hasHeadlamp(DeviceType.SPINO), false);
  assert.equal(hasHeadlamp(DeviceType.SWIMMINGPOOL_S1), false);
  assert.equal(hasHeadlamp(DeviceType.UNKNOWN), false);
});

test('capabilitiesForModel strips measure_battery_cycles (removable pack) but keeps mow_headlamp for a Luba 2 Mini', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  const result = capabilitiesForModel(base, DeviceType.LUBA_MN);
  assert.deepEqual(result, ['onoff', 'mow_headlamp', 'mow_side_led', 'mow_rain_protection']);
});

test('capabilitiesForModel keeps every base capability for a standard Luba 2 / Luba VA — both have a headlamp and a fixed battery', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_2), base);
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_VA), base);
});

test('capabilitiesForModel keeps every base capability for a Luba 2 Pro (mini/X-series with a fixed battery)', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  assert.deepEqual(capabilitiesForModel(base, DeviceType.LUBA_VP), base);
});

test('capabilitiesForModel strips mow_headlamp for an RTK base station (not a mower)', () => {
  const base = ['onoff', 'mow_headlamp', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  const withoutHeadlamp = ['onoff', 'mow_side_led', 'measure_battery_cycles', 'mow_rain_protection'];
  assert.deepEqual(capabilitiesForModel(base, DeviceType.RTK), withoutHeadlamp);
});
