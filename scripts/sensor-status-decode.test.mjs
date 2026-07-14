/**
 * sensor_status bit-decode test. Run after `npm run build`:
 *   node --test scripts/sensor-status-decode.test.mjs
 *
 * Covers decodeBumperState/decodeBladeActive (TelemetryParser.ts) — confirmed directly
 * against pymammotion's data/model/report_info.py bumper_state/blade_state properties
 * (sourced from the official Mammotion Android app per that file's own comments), not
 * inferred from our own diagnostic captures. See
 * docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md for the investigation this closed one part of:
 * a "+512" sensorStatusRaw change in a real capture that looked like a possible
 * wheel-lift/fault signal turned out to be blade_state turning on as mowing resumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeLubaMsg, encodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';
import {
  decodeBumperState, decodeBladeActive, extractTelemetry,
} from '../.homeybuild/lib/mammotion/protocol/TelemetryParser.js';

test('decodeBumperState: 0=ok, 1=warning, 2+=error (clamped)', () => {
  assert.equal(decodeBumperState(0), 'ok');
  assert.equal(decodeBumperState(1), 'warning');
  assert.equal(decodeBumperState(2), 'error');
  assert.equal(decodeBumperState(7), 'error');
});

test('decodeBumperState only reads bits 0-2, ignoring higher bits (e.g. blade_state)', () => {
  // 513 = 0b1000000001: bumper bits (0-2) = 1, blade bit (9) also set — bumper decode
  // must not be affected by the blade bits being set.
  assert.equal(decodeBumperState(513), 'warning');
});

test('decodeBladeActive: false when bits 9-11 are zero, true otherwise', () => {
  assert.equal(decodeBladeActive(0), false);
  assert.equal(decodeBladeActive(1), false); // bumper bit set, blade bits still 0
  assert.equal(decodeBladeActive(512), true); // bit 9 only
  assert.equal(decodeBladeActive(513), true); // bumper bit 0 + blade bit 9
});

test('extractTelemetry decodes bumperState/bladeActive from a real captured sequence', () => {
  // Real diagnostic values (2026-07-08): sensorStatusRaw went 1 -> 513 as a mower resumed
  // mowing after a stop. This is the blade turning back on, not a fault.
  const stopped = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50, sensorStatus: 1 } } },
  });
  const stoppedTelemetry = extractTelemetry(decodeLubaMsg(stopped));
  assert.equal(stoppedTelemetry.bumperState, 'warning');
  assert.equal(stoppedTelemetry.bladeActive, false);

  const resumed = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 2, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50, sensorStatus: 513 } } },
  });
  const resumedTelemetry = extractTelemetry(decodeLubaMsg(resumed));
  assert.equal(resumedTelemetry.bumperState, 'warning');
  assert.equal(resumedTelemetry.bladeActive, true);
});

test('extractTelemetry reads mileage (int64, decoded as string) and workTime (int32, stays a number)', () => {
  // Regression test: mctrl_sys.proto's maintain.mileage is int64, so Codec.ts's
  // longs:String setting decodes it as a string (e.g. "26721"), while maintain.workTime is
  // int32 and decodes as a plain number (e.g. 97140) — confirmed against a real diagnostic
  // report (2026-07-14) showing exactly that split in the raw JSON. extractTelemetry must
  // accept mileage as a string and convert it, not just check typeof === 'number' (that
  // silently dropped every mileage update from the moment longs:String shipped).
  const msg = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 3, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { maintain: { mileage: 26721, workTime: 97140 } } },
  });
  const telemetry = extractTelemetry(decodeLubaMsg(msg));
  assert.equal(telemetry.mileage, 26721);
  assert.equal(telemetry.workTime, 97140);
});
