/**
 * Start-schedule ("run this stored task now") round-trip test. Run after `npm run build`:
 *   node --test scripts/start-schedule.test.mjs
 *
 * Covers MctlNav.plan_task_execute (sub_cmd=1) — a completely different message from the
 * read-only NavPlanJobSet (buildReadScheduleCommand) and from the ad-hoc route builder
 * (buildGenerateRouteCommand). See docs/SCHEDULE_START_PLAN.md for why this is the
 * maximally-faithful way to run a task exactly as configured in the official Mammotion app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStartScheduleCommand } from '../.homeybuild/lib/mammotion/commands/LubaCommands.js';
import { decodeLubaMsg } from '../.homeybuild/lib/mammotion/protocol/Codec.js';

test('start-schedule request targets NAV with plan_task_execute sub_cmd=1 (execute, not read/write)', () => {
  const b64 = buildStartScheduleCommand('12345', 'Luba-TEST', 'plan-abc-123', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.msgtype, 240, 'msgtype NAV');
  assert.equal(req.subtype, 12345, 'subtype = user account');
  assert.equal(req.nav.planTaskExecute.subCmd, 1, 'sub_cmd=1 is execute');
  assert.equal(req.nav.planTaskExecute.id, 'plan-abc-123', 'planId round-trips exactly');
});

test('start-schedule request carries only the plan id — no zone/blade/speed/angle fields', () => {
  const b64 = buildStartScheduleCommand('12345', 'Luba-TEST', 'plan-abc-123', { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  // The whole point of direct-invoke (vs. read-and-replay) is that the device applies its own
  // stored settings — we never send zones/blade height/speed/angle ourselves.
  assert.equal(req.nav.todevPlanjobSet, undefined);
  assert.equal(req.nav.bidireReqconverPath, undefined);
});

test('start-schedule request preserves a long, opaque plan id unchanged', () => {
  const longPlanId = '17813716115617657829';
  const b64 = buildStartScheduleCommand('12345', 'Luba-TEST', longPlanId, { value: 0 });
  const req = decodeLubaMsg(Buffer.from(b64, 'base64'));
  assert.equal(req.nav.planTaskExecute.id, longPlanId);
});
