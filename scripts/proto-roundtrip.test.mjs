/**
 * Protobuf round-trip regression test. Run after `npm run build`:
 *   node --test scripts/proto-roundtrip.test.mjs
 *
 * Guards the LubaMsg telemetry contract (request sub list + response field paths)
 * that the hand-rolled codec got wrong. Imports the COMPILED output (.homeybuild)
 * because the source uses NodeNext .js-suffixed imports that node's type-stripping
 * cannot resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequestIotSyncCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { encodeLubaMsg, decodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';

test('report-config request encodes the correct envelope + sub list', () => {
  const req = decodeLubaMsg(Buffer.from(buildRequestIotSyncCommand('12345', false, { value: 0 }), 'base64'));
  assert.equal(req.msgtype, 244, 'msgtype EMBED_SYS');
  assert.equal(req.subtype, 12345, 'subtype = user account');
  assert.deepEqual(req.sys.todevReportCfg.sub, [0, 2, 3, 4, 1, 7, 8, 9, 10, 5], 'subscription channels');
  assert.equal(req.sys.todevReportCfg.act, 0, 'RPT_START');
});

test('telemetry response decodes from toapp_report_data field paths', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: {
      connect: { bleRssi: -55, wifiRssi: -42 },
      dev: { sysStatus: 13, chargeState: 0, batteryVal: 62 },
      rtk: { posLevel: 4, gpsStars: 21 },
      work: { progress: 37, area: 1234 },
    } },
  });
  const report = decodeLubaMsg(bytes).sys.toappReportData;
  assert.equal(report.dev.batteryVal, 62, 'battery');
  assert.equal(report.dev.sysStatus, 13, 'work mode');
  assert.equal(report.connect.wifiRssi, -42, 'wifi rssi (signed)');
  assert.equal(report.connect.bleRssi, -55, 'ble rssi (signed)');
  assert.equal(report.rtk.gpsStars, 21, 'gps stars');
  assert.equal(report.work.area, 1234, 'mowed area');
  assert.equal(report.work.progress, 37, 'progress');
});

test('work.area/work.progress are packed 16+16 values (per Mammotion-HA sensor.py)', () => {
  // area: low16 = m², high16 = progress%.  progress: low16 = total_time, high16 = left_time.
  const packedArea = (42 << 16) | 512; // progress=42%, area=512 m²
  const packedProgress = (30 << 16) | 90; // left=30 min, total=90 min -> elapsed=60 min
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { work: { area: packedArea, progress: packedProgress, manRunSpeed: 35 } } },
  });
  const work = decodeLubaMsg(bytes).sys.toappReportData.work;
  assert.equal(work.area & 0xffff, 512, 'unpacked area');
  assert.equal((work.area >>> 16) & 0xffff, 42, 'unpacked progress %');
  assert.equal(work.progress & 0xffff, 90, 'unpacked total_time');
  assert.equal((work.progress >>> 16) & 0xffff, 30, 'unpacked left_time');
  assert.equal(work.manRunSpeed / 100, 0.35, 'mowing speed (man_run_speed / 100)');
});

test('legitimate zero values survive decode (proto3 default vs. absent field)', () => {
  // Regression: defaults:false made man_run_speed=0 (mower stationary) indistinguishable
  // from "field not present", silently dropping it from the decoded object.
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { work: { manRunSpeed: 0 }, dev: { batteryVal: 0 } } },
  });
  const report = decodeLubaMsg(bytes).sys.toappReportData;
  assert.equal(typeof report.work.manRunSpeed, 'number', 'manRunSpeed=0 must be present, not dropped');
  assert.equal(report.work.manRunSpeed, 0);
  assert.equal(typeof report.dev.batteryVal, 'number', 'batteryVal=0 must be present, not dropped');
  // Absent sub-messages must stay absent (not synthesized as empty objects) — otherwise
  // a partial report (e.g. only `dev`) would spuriously report all-zero rtk/connect/work.
  assert.equal(report.rtk, null, 'absent sub-message stays null/absent');
});
