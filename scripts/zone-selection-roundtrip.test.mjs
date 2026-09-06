/**
 * Zone selection & plan-route-before-start round-trip tests. Run after `npm run build`:
 *   node --test scripts/zone-selection-roundtrip.test.mjs
 *
 * Covers LubaCommands.buildGetAreaNameListCommand/buildGenerateRouteCommand and
 * AreaNameParser.extractAreaHashNames — see docs/ZONE_SELECTION_PLAN.md for the real
 * diagnostic report this fixes (a bare start signal resuming an already-fully-mowed cached
 * job and returning within seconds) and the protocol research behind these commands.
 *
 * The precision tests below are the ones that matter most: zone hashes are fixed64 and
 * routinely exceed 2^53 on a real device (e.g. 1608415312719532800, seen in a real capture)
 * — losing even one bit while decoding a hash the app later sends back to select a zone
 * would reference the wrong zone or none at all. Codec.ts's decodeLubaMsg uses
 * `longs: String` specifically so this round-trips exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGetAreaNameListCommand, buildGenerateRouteCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg, encodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';
import { extractAreaHashNames } from '../.homeybuild/lib/mammotion/protocol/AreaNameParser.js';

// A real, out-of-range-for-JS-numbers zone hash captured from a live device (2026-07-14).
const REAL_LARGE_HASH = '1608415312719532800';

test('get-area-name-list request reads (rw=0) the whole list (hash=0), not a single write', () => {
  const b64 = buildGetAreaNameListCommand('12345', 'Luba-TEST', 'iot-abc123', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.msgtype, 240, 'msgtype NAV');
  assert.equal(req.subtype, 12345, 'subtype = user account');
  assert.equal(req.nav.toappMapNameMsg.rw, 0, 'rw=0 is read, not the rw=1 write used by set_area_name');
  assert.equal(req.nav.toappMapNameMsg.hash, '0', 'hash=0 means "all zones", not one specific hash');
  assert.equal(req.nav.toappMapNameMsg.deviceId, 'iot-abc123', 'device_id is the iotId, not deviceName');
});

test('extractAreaHashNames parses a device zone-list response, preserving large hashes exactly', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappAllHashName: { deviceId: 'iot-abc123', hashnames: [
      { hash: REAL_LARGE_HASH, name: 'Front lawn' },
      { hash: '42', name: 'Back lawn' },
    ] } },
  });
  const zones = extractAreaHashNames(decodeLubaMsg(bytes));
  assert.equal(zones.length, 2);
  assert.equal(zones[0].hash, REAL_LARGE_HASH, 'large fixed64 hash preserved exactly as a string, no precision loss');
  assert.equal(zones[0].name, 'Front lawn');
  assert.equal(zones[1].hash, '42');
  assert.equal(zones[1].name, 'Back lawn');
});

test('extractAreaHashNames drops zero/empty hash entries (not a real zone)', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappAllHashName: { deviceId: 'iot-abc123', hashnames: [{ hash: '0', name: '' }] } },
  });
  const zones = extractAreaHashNames(decodeLubaMsg(bytes));
  assert.deepEqual(zones, []);
});

test('extractAreaHashNames returns null for non-zone-list messages (e.g. telemetry)', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50 } } },
  });
  assert.equal(extractAreaHashNames(decodeLubaMsg(bytes)), null);
});

test('generate-route command carries the requested zone hashes and sub_cmd=0 (generate)', () => {
  const b64 = buildGenerateRouteCommand([REAL_LARGE_HASH, '42'], { bladeHeight: 40, speed: 0.5 }, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  const route = req.nav.bidireReqconverPath;
  assert.equal(req.msgtype, 240, 'msgtype NAV');
  assert.equal(route.subCmd, 0, 'sub_cmd=0 is generate; 2/3/9 are query/modify/end');
  assert.deepEqual(route.zoneHashs, [REAL_LARGE_HASH, '42'], 'zone hashes round-trip exactly, including the large one');
  assert.equal(route.knifeHeight, 40);
  assert.ok(Math.abs(route.speed - 0.5) < 1e-6);
  assert.equal(route.jobMode, 4);
  assert.equal(route.edgeMode, 1);
});

test('generate-route command reserved bytes match create_path_order for a Luba 2/3 (non-Yuka, non-Luba1)', () => {
  const b64 = buildGenerateRouteCommand(['42'], {}, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  const reserved = req.nav.bidireReqconverPath.reserved;
  const bytes = Array.from(reserved, (ch) => ch.charCodeAt(0));
  assert.deepEqual(bytes, [0, 1, 0, 0, 0, 8, 10, 0], 'border_mode=0, obstacle_laps=1, luba_pro flag=8, collect_grass_frequency=10');
});

test('generate-route command defaults bladeHeight/speed when omitted, matching reference defaults', () => {
  const b64 = buildGenerateRouteCommand(['42'], {}, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  const route = req.nav.bidireReqconverPath;
  assert.equal(route.knifeHeight, 25, 'default blade height (CLAUDE.md/StartMowOptions default) when unset');
  assert.ok(Math.abs(route.speed - 0.3) < 1e-6, 'default speed (reference OperationSettings default) when unset');
});

test('generate-route uses the caller-supplied channel width, not the fixed default', () => {
  // Report R9: a user running 8 cm spacing in the official app saw a different spacing take
  // effect when starting from Homey, because this builder hardcoded 25. The device's own
  // stored value (NavPlanJobSet.route_spacing) is now threaded through so a Homey-initiated
  // run plans the same route the official app would.
  const b64 = buildGenerateRouteCommand(['42'], { channelWidth: 8 }, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.bidireReqconverPath.channelWidth, 8);
});

test('generate-route falls back to 25 when no channel width is known', () => {
  // A device that has never reported a stored task gives us nothing to echo back, so the
  // pymammotion OperationSettings default must still apply rather than a spacing of 0.
  const b64 = buildGenerateRouteCommand(['42'], {}, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.bidireReqconverPath.channelWidth, 25);
});

test('generate-route truncates a fractional channel width to an integer field', () => {
  // channel_width is int32 on the wire; protobufjs would throw or silently mangle a float.
  const b64 = buildGenerateRouteCommand(['42'], { channelWidth: 12.7 }, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.bidireReqconverPath.channelWidth, 12);
});

test('generate-route uses the caller-supplied blade height, not the 25 mm floor', () => {
  // The start_mowing card's height range is 25–70 mm and 25 was also the fallback, so a
  // blank field meant "cut at the minimum". Two users reported the mower cutting far
  // shorter than they had set. The device's own stored height is now threaded through.
  const b64 = buildGenerateRouteCommand(['42'], { bladeHeight: 60 }, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.bidireReqconverPath.knifeHeight, 60);
});

test('generate-route falls back to 25 mm blade height only when nothing else is known', () => {
  const b64 = buildGenerateRouteCommand(['42'], {}, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.bidireReqconverPath.knifeHeight, 25);
});
