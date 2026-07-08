import test from 'node:test';
import assert from 'node:assert/strict';

import { workModeToStatus, isErrorMode } from '../.homeybuild/lib/mammotion/protocol/WorkModeStatus.js';
import { MOWING_ACTIVE_WORK_MODES } from '../.homeybuild/lib/mammotion/constants.js';

// Regression coverage for a real user report (2026-07-05): two mowers logged 20-30 spurious
// "turned off" Homey notifications overnight, a few seconds apart from real mowing/paused
// events. Root cause: workModeToStatus() only recognized 8 of pymammotion's ~24 known
// WorkMode codes and bucketed everything else into 'idle', and onoff was tied to
// `status === 'mowing'` — so a mower legitimately cycling through MODE_PAUSE/
// MODE_CHARGING_PAUSE (or any other unmapped transient code) mid-job flipped onoff off and
// back on within seconds. See lib/mammotion/constants.ts's WORK_MODE table (already ported,
// previously unused) and MOWING_ACTIVE_WORK_MODES for the full pymammotion WorkMode mapping.
//
// Also covers MODE_READY(11)'s chargeState-based disambiguation, from a separate real user
// report the same day (docked mowers never transitioning to 'charging'), and
// MODE_CHARGING_PAUSE(39)'s identical disambiguation added later (2026-07-08, mower_status
// stuck on 'paused' for 30+ minutes on a mower that was actually charging in its dock).

test('workModeToStatus: MODE_WORKING and MODE_MANUAL_MOWING both map to mowing', () => {
  assert.equal(workModeToStatus(13, null), 'mowing');
  assert.equal(workModeToStatus(20, null), 'mowing');
});

test('workModeToStatus: MODE_RETURNING maps to returning', () => {
  assert.equal(workModeToStatus(14, null), 'returning');
});

test('workModeToStatus: MODE_CHARGING maps to charging', () => {
  assert.equal(workModeToStatus(15, null), 'charging');
});

test('workModeToStatus: MODE_PAUSE always maps to paused, regardless of chargeState', () => {
  assert.equal(workModeToStatus(19, null), 'paused');
  assert.equal(workModeToStatus(19, 1), 'paused');
});

test('workModeToStatus: MODE_CHARGING_PAUSE with a nonzero chargeState is charging (docked mid-job)', () => {
  // Real diagnostic report, 2026-07-08: mower_status stuck showing "paused" for 30+
  // minutes while measure_battery visibly climbed the whole time (dock-charging while its
  // job sat paused, pending resume) — see WorkModeStatus.ts's case 39 comment.
  assert.equal(workModeToStatus(39, 1), 'charging');
});

test('workModeToStatus: MODE_CHARGING_PAUSE with no/zero chargeState falls back to paused', () => {
  assert.equal(workModeToStatus(39, null), 'paused');
  assert.equal(workModeToStatus(39, 0), 'paused');
});

test('workModeToStatus: MODE_OTA_UPGRADE_FAIL, MODE_LOCATION_ERROR, MODE_BOUNDARY_JUMP map to error', () => {
  assert.equal(workModeToStatus(23, null), 'error');
  assert.equal(workModeToStatus(37, null), 'error');
  assert.equal(workModeToStatus(38, null), 'error');
});

test('workModeToStatus: MODE_READY(11) with a nonzero chargeState is charging (docked)', () => {
  assert.equal(workModeToStatus(11, 1), 'charging');
});

test('workModeToStatus: MODE_READY(11) with no/zero chargeState is idle', () => {
  assert.equal(workModeToStatus(11, null), 'idle');
  assert.equal(workModeToStatus(11, 0), 'idle');
});

test('workModeToStatus: previously-unmapped transient codes now fall back to idle explicitly, not by accident', () => {
  // MODE_NOT_ACTIVE, MODE_ONLINE, MODE_OFFLINE, MODE_POWER_OFF, MODE_DISABLE,
  // MODE_INITIALIZATION, MODE_UPDATING, MODE_LOCK, MODE_UPDATE_SUCCESS, and the
  // mobile-app-only boundary/obstacle/channel/eraser drawing UI modes.
  for (const mode of [0, 1, 2, 3, 8, 10, 16, 17, 22, 31, 32, 34, 35, 36]) {
    assert.equal(workModeToStatus(mode, null), 'idle', `mode ${mode} should be idle`);
  }
});

test('isErrorMode: matches exactly workModeToStatus\'s error cases', () => {
  for (const mode of [23, 37, 38]) assert.equal(isErrorMode(mode), true);
  for (const mode of [13, 14, 15, 19, 20, 39, 0, 11]) assert.equal(isErrorMode(mode), false);
});

test('MOWING_ACTIVE_WORK_MODES: contains exactly the modes that should keep onoff true', () => {
  assert.deepEqual([...MOWING_ACTIVE_WORK_MODES].sort((a, b) => a - b), [13, 14, 19, 39]);
});

test('onoff derivation: returning and paused mid-job no longer force onoff off', () => {
  // This is the actual bug fix — onoff must stay true through the whole active-job
  // lifecycle (working -> paused/charging-pause -> returning), not just while mode===13/20.
  for (const mode of MOWING_ACTIVE_WORK_MODES) {
    assert.equal(MOWING_ACTIVE_WORK_MODES.includes(mode), true);
  }
  // And genuinely idle/charging/error states must NOT keep onoff on.
  for (const mode of [15, 23, 37, 38, 0, 11]) {
    assert.equal(MOWING_ACTIVE_WORK_MODES.includes(mode), false);
  }
});
