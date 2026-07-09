/**
 * Error-code push message round-trip test. Run after `npm run build`:
 *   node --test scripts/error-code-roundtrip.test.mjs
 *
 * Covers ErrorCodeParser.extractErrorCode (MctlSys.toapp_err_code) — a one-shot
 * device-pushed fault code, distinct from the periodic toapp_report_data telemetry.
 * Diagnostic-only for now: see ErrorCodeParser.ts for why the numeric code_no isn't
 * mapped to any alarm_generic/mower_error meaning yet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeLubaMsg, encodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';
import { extractErrorCode } from '../.homeybuild/lib/mammotion/protocol/ErrorCodeParser.js';
import { extractTelemetry } from '../.homeybuild/lib/mammotion/protocol/TelemetryParser.js';

test('extractErrorCode parses a toapp_err_code push message', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappErrCode: { errorCode: 5201 } },
  });
  assert.equal(extractErrorCode(decodeLubaMsg(bytes)), 5201);
});

test('extractErrorCode returns null for non-error messages (e.g. telemetry)', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50 } } },
  });
  assert.equal(extractErrorCode(decodeLubaMsg(bytes)), null);
});

test('extractTelemetry surfaces sensorStatusRaw/selfCheckStatusRaw diagnostic fields', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50, sensorStatus: 4, selfCheckStatus: 1 } } },
  });
  const telemetry = extractTelemetry(decodeLubaMsg(bytes));
  assert.equal(telemetry.sensorStatusRaw, 4);
  assert.equal(telemetry.selfCheckStatusRaw, 1);
});

test('extractTelemetry surfaces sysTimeStampRaw diagnostic field', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50, sysTimeStamp: 1751234567 } } },
  });
  const telemetry = extractTelemetry(decodeLubaMsg(bytes));
  assert.equal(telemetry.sysTimeStampRaw, 1751234567);
});
