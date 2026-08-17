/**
 * Schedule read round-trip test. Run after `npm run build`:
 *   node --test scripts/schedule-roundtrip.test.mjs
 *
 * Covers the READ-ONLY schedule path (LubaCommands.buildReadScheduleCommand +
 * ScheduleParser.extractSchedule). Write/create/edit is deliberately NOT implemented —
 * see docs/SCHEDULING_PLAN.md for why (the device's `reserved` byte encoding isn't
 * fully understood even by the pymammotion reference project).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReadScheduleCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg, encodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';
import { extractSchedule } from '../.homeybuild/lib/mammotion/protocol/ScheduleParser.js';

test('read-schedule request targets NAV with sub_cmd=2 (read, not write)', () => {
  const b64 = buildReadScheduleCommand('12345', 'Luba-TEST', 0, { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.msgtype, 240, 'msgtype NAV');
  assert.equal(req.subtype, 12345, 'subtype = user account');
  assert.equal(req.nav.todevPlanjobSet.subCmd, 2, 'sub_cmd=2 is read, never 1/3/4 (create/delete/edit)');
});

test('read-schedule request actually encodes a distinct PlanIndex per call', () => {
  // Regression test: the proto field is capitalized (`PlanIndex`, mctrl_nav.proto:286) — a
  // lowercase `planIndex` key is silently dropped by protobufjs, leaving every request
  // identical regardless of the requested index. Real-world symptom: the task picker showed
  // the exact same task N times instead of N different stored tasks.
  for (const index of [0, 1, 3, 14]) {
    const b64 = buildReadScheduleCommand('12345', 'Luba-TEST', index, { value: 0 });
    const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
    assert.equal(req.nav.todevPlanjobSet.PlanIndex, index, `PlanIndex must round-trip as ${index}`);
  }
});

test('extractSchedule parses a device echo response', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { todevPlanjobSet: {
      planId: 'p1', PlanIndex: 0, totalPlanNum: 2, taskName: 'Morning',
      startTime: '08:00', endTime: '10:00', week: 31, weeks: [1, 2, 3, 4, 5],
      knifeHeight: 30, speed: 0.4,
    } },
  });
  const schedule = extractSchedule(decodeLubaMsg(bytes));
  assert.equal(schedule.planId, 'p1');
  assert.equal(schedule.planIndex, 0);
  assert.equal(schedule.totalPlanCount, 2);
  assert.equal(schedule.taskName, 'Morning');
  assert.equal(schedule.startTime, '08:00');
  assert.equal(schedule.endTime, '10:00');
  assert.deepEqual(schedule.weeks, [1, 2, 3, 4, 5]);
  assert.equal(schedule.bladeHeightMm, 30);
  assert.ok(Math.abs(schedule.speedMs - 0.4) < 1e-6);
});

test('extractSchedule returns null for non-schedule messages (e.g. telemetry)', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50 } } },
  });
  assert.equal(extractSchedule(decodeLubaMsg(bytes)), null);
});

test('extractSchedule reads route_spacing so the generic start path can reuse it', () => {
  // The user's spacing preference lives on the device, set in the official app. Starting a
  // *task* runs entirely from that stored config, but the generic start path plans its own
  // route and used to do so at a fixed 25 — so the same lawn was cut differently depending
  // on which Flow card was used (report R9). Reading the field is what makes echoing the
  // device's own figure back possible.
  //
  // Guards the field NAME too: NavPlanJobSet calls this `route_spacing` (id 21) while the
  // route-planning message calls the same concept `channel_width`. protobufjs silently
  // drops an unknown key on encode, so reading the wrong name yields 0 forever rather than
  // an error — the identical trap the PlanIndex test above documents.
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { todevPlanjobSet: {
      planId: 'p1', PlanIndex: 0, totalPlanNum: 1, taskName: 'Front lawn',
      knifeHeight: 30, speed: 0.4, routeSpacing: 8,
    } },
  });
  assert.equal(extractSchedule(decodeLubaMsg(bytes)).routeSpacing, 8);
});

test('extractSchedule reports routeSpacing 0 when the device omits it', () => {
  // 0 is the "nothing reported" sentinel storedChannelWidth() filters on — a device that
  // never sends the field must not be read as "the user chose a spacing of zero", which
  // would otherwise plan a route at spacing 0.
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { todevPlanjobSet: { planId: 'p1', taskName: 'No width', knifeHeight: 30, speed: 0.4 } },
  });
  assert.equal(extractSchedule(decodeLubaMsg(bytes)).routeSpacing, 0);
});
