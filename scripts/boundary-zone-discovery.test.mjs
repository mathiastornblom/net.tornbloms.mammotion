/**
 * Boundary-zone-discovery (unnamed-zone fallback) round-trip tests. Run after `npm run build`:
 *   node --test scripts/boundary-zone-discovery.test.mjs
 *
 * Covers LubaCommands.buildGetBoundaryHashListCommand/buildGetHashResponseCommand/
 * buildSynchronizeHashDataCommand/buildRegionalDataAckCommand and
 * BoundaryHashParser.extractRootHashList/extractCommDataAck/synthesizeAreaZoneNames — see
 * docs/ZONE_BOUNDARY_FALLBACK_PLAN.md for the real diagnostic report this fixes (a device
 * with an unnamed default boundary whose get_area_name_list returns hashnames: [] forever,
 * even though it holds real, mowable boundary data).
 *
 * As with zone-selection-roundtrip.test.mjs, the precision tests matter most: hashes are
 * fixed64/int64 and routinely exceed 2^53 on a real device — losing even one bit would
 * reference the wrong zone (or classify the wrong hash) entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGetBoundaryHashListCommand,
  buildGetHashResponseCommand,
  buildSynchronizeHashDataCommand,
  buildRegionalDataAckCommand,
} from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg, encodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';
import {
  extractRootHashList,
  extractCommDataAck,
  synthesizeAreaZoneNames,
} from '../.homeybuild/lib/mammotion/protocol/BoundaryHashParser.js';

// A real, out-of-range-for-JS-numbers zone hash (reused from zone-selection-roundtrip.test.mjs).
const REAL_LARGE_HASH = '1608415312719532800';

// ─── Command builders ────────────────────────────────────────────────────────

test('get-boundary-hash-list request is sub_cmd=0 (root list), pver=1', () => {
  const b64 = buildGetBoundaryHashListCommand('12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.msgtype, 240, 'msgtype NAV');
  assert.equal(req.subtype, 12345, 'subtype = user account');
  assert.equal(req.nav.todevGethash.pver, 1);
  assert.equal(req.nav.todevGethash.subCmd, 0, 'sub_cmd=0 is the root boundary/obstacle/path manifest');
});

test('get-hash-response ack is sub_cmd=2 and echoes the exact frame counters', () => {
  const b64 = buildGetHashResponseCommand(7, 3, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.todevGethash.subCmd, 2, 'sub_cmd=2 is the frame ack, distinct from the sub_cmd=0 request');
  assert.equal(req.nav.todevGethash.currentFrame, 3);
  assert.equal(req.nav.todevGethash.totalFrame, 7);
});

test('synchronize-hash-data probe carries action=8, sub_cmd=1, and the hash as an exact decimal string', () => {
  const b64 = buildSynchronizeHashDataCommand(REAL_LARGE_HASH, '12345', 'Luba-TEST', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.todevGetCommondata.action, 8);
  assert.equal(req.nav.todevGetCommondata.subCmd, 1);
  assert.equal(req.nav.todevGetCommondata.hash, REAL_LARGE_HASH, 'large fixed64/int64 hash round-trips exactly');
});

test('regional-data drain-ack (get_regional_data) echoes action/type/hash/frame counters with sub_cmd=2', () => {
  const b64 = buildRegionalDataAckCommand(
    { action: 8, type: 0, hash: REAL_LARGE_HASH, totalFrame: 4, currentFrame: 2 },
    '12345', 'Luba-TEST', { value: 0 },
  );
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  const ack = req.nav.todevGetCommondata;
  assert.equal(ack.subCmd, 2, 'sub_cmd=2 is the drain ack, distinct from the sub_cmd=1 classify request');
  assert.equal(ack.action, 8);
  assert.equal(ack.type, 0);
  assert.equal(ack.hash, REAL_LARGE_HASH);
  assert.equal(ack.totalFrame, 4);
  assert.equal(ack.currentFrame, 2);
});

// ─── extractRootHashList ──────────────────────────────────────────────────────

test('extractRootHashList reads a sub_cmd=0 frame, preserving large hashes exactly as strings', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGethashAck: { subCmd: 0, totalFrame: 2, currentFrame: 1, dataCouple: [REAL_LARGE_HASH, '42'] } },
  });
  const frame = extractRootHashList(decodeLubaMsg(bytes));
  assert.ok(frame);
  assert.equal(frame.subCmd, 0);
  assert.equal(frame.totalFrame, 2);
  assert.equal(frame.currentFrame, 1);
  assert.deepEqual(frame.dataCouple, [REAL_LARGE_HASH, '42']);
});

test('extractRootHashList ignores sub_cmd=3 — MowPathSaga\'s line-hash list, not zone discovery', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGethashAck: { subCmd: 3, totalFrame: 1, currentFrame: 1, dataCouple: ['999'] } },
  });
  assert.equal(extractRootHashList(decodeLubaMsg(bytes)), null);
});

test('extractRootHashList returns null for non-hash-list messages (e.g. telemetry)', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50 } } },
  });
  assert.equal(extractRootHashList(decodeLubaMsg(bytes)), null);
});

// ─── extractCommDataAck ───────────────────────────────────────────────────────

test('extractCommDataAck reads the capitalized Hash field (fixed64), not the lowercase hash request field', () => {
  const bytes = encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 5, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGetCommondataAck: { subCmd: 1, action: 8, type: 0, Hash: REAL_LARGE_HASH, totalFrame: 1, currentFrame: 1 } },
  });
  const frame = extractCommDataAck(decodeLubaMsg(bytes));
  assert.ok(frame);
  assert.equal(frame.hash, REAL_LARGE_HASH, 'reads capital Hash, preserved exactly as a string');
  assert.equal(frame.type, 0);
  assert.equal(frame.action, 8);
  assert.equal(frame.totalFrame, 1);
  assert.equal(frame.currentFrame, 1);
});

test('extractCommDataAck returns null for non-classification messages', () => {
  const bytes = encodeLubaMsg({
    msgtype: 244, sender: 1, rcver: 7, msgattr: 3, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    sys: { toappReportData: { dev: { batteryVal: 50 } } },
  });
  assert.equal(extractCommDataAck(decodeLubaMsg(bytes)), null);
});

// ─── Ack-loop termination / AREA-type filter ──────────────────────────────────
// These mirror the exact predicates LubaDevice.collectRootHashList/probeHashIsArea use on
// a real decoded frame (`frame.currentFrame >= frame.totalFrame` to stop the ack loop,
// `ack.type === 0` to keep a hash) — testing them against real round-tripped frames confirms
// the parser hands back fields of the right type/shape for those comparisons to be correct,
// not just a re-assertion of the comparison operator itself.

test('root-hash-list ack loop: currentFrame >= totalFrame signals the last frame', () => {
  const notLastFrame = extractRootHashList(decodeLubaMsg(encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGethashAck: { subCmd: 0, totalFrame: 3, currentFrame: 1, dataCouple: ['1'] } },
  })));
  const lastFrame = extractRootHashList(decodeLubaMsg(encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 2, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGethashAck: { subCmd: 0, totalFrame: 3, currentFrame: 3, dataCouple: ['3'] } },
  })));
  assert.equal(notLastFrame.currentFrame >= notLastFrame.totalFrame, false, 'frame 1/3 — loop must continue');
  assert.equal(lastFrame.currentFrame >= lastFrame.totalFrame, true, 'frame 3/3 — loop must stop');
});

test('per-hash classification: type===0 (AREA) is kept, any other PathType is rejected', () => {
  const areaAck = extractCommDataAck(decodeLubaMsg(encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 1, version: 1, subtype: 0, timestamp: Date.now(),
    nav: { toappGetCommondataAck: { subCmd: 1, action: 8, type: 0, Hash: '111', totalFrame: 1, currentFrame: 1 } },
  })));
  const obstacleAck = extractCommDataAck(decodeLubaMsg(encodeLubaMsg({
    msgtype: 240, sender: 1, rcver: 7, msgattr: 2, seqs: 2, version: 1, subtype: 0, timestamp: Date.now(),
    // PathType.OBSTACLE = 1 — a synthetic non-area frame that must never be treated as a
    // mowable zone (see docs/ZONE_BOUNDARY_FALLBACK_PLAN.md's Option C rejection).
    nav: { toappGetCommondataAck: { subCmd: 1, action: 8, type: 1, Hash: '222', totalFrame: 1, currentFrame: 1 } },
  })));
  assert.equal(areaAck.type === 0, true, 'PathType.AREA must be kept');
  assert.equal(obstacleAck.type === 0, false, 'PathType.OBSTACLE must be rejected, never fed to zone_hashs');
});

// ─── synthesizeAreaZoneNames ───────────────────────────────────────────────────

test('synthesizeAreaZoneNames names sequentially "Area 1", "Area 2", ... in numeric hash order', () => {
  const zones = synthesizeAreaZoneNames(['42', '7']);
  assert.deepEqual(zones, [
    { hash: '7', name: 'Area 1' },
    { hash: '42', name: 'Area 2' },
  ]);
});

test('synthesizeAreaZoneNames sorts numerically via BigInt, not lexically (would misorder "10" before "9")', () => {
  const zones = synthesizeAreaZoneNames(['10', '9']);
  assert.deepEqual(zones.map((z) => z.hash), ['9', '10'], 'numeric order, not string order');
});

test('synthesizeAreaZoneNames sorts fixed64-scale hashes exactly, beyond Number.MAX_SAFE_INTEGER', () => {
  const bigger = '9223372036854775800'; // exceeds Number.MAX_SAFE_INTEGER (2^53-1)
  const zones = synthesizeAreaZoneNames([bigger, REAL_LARGE_HASH]);
  assert.deepEqual(zones, [
    { hash: REAL_LARGE_HASH, name: 'Area 1' },
    { hash: bigger, name: 'Area 2' },
  ]);
});

test('synthesizeAreaZoneNames dedupes exact-duplicate hashes', () => {
  const zones = synthesizeAreaZoneNames(['5', '5', '3']);
  assert.deepEqual(zones, [
    { hash: '3', name: 'Area 1' },
    { hash: '5', name: 'Area 2' },
  ]);
});
