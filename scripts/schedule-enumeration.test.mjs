/**
 * Schedule enumeration test. Run after `npm run build`:
 *   node --test scripts/schedule-enumeration.test.mjs
 *
 * Drives the real enumeration and echo registry with a scripted device, against the timing
 * USER_REPORTS_INBOX R14 showed on a Luba Mini 2 over MQTT: the device's echo arriving while
 * the HTTPS invoke call is still in flight, a read that stays silent, and a partial
 * enumeration that used to overwrite a complete cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScheduleEchoRegistry,
  enumerateSchedules,
  mergeScheduleCache,
} from '../.homeybuild/lib/mammotion/protocol/ScheduleEnumeration.js';

const task = (planIndex, name, total, planId = `id-${planIndex}`) => ({
  planId,
  planIndex,
  totalPlanCount: total,
  taskName: name,
  startTime: '05:00',
  endTime: '07:00',
  week: 0,
  weeks: [],
  startDate: '',
  endDate: '',
  bladeHeightMm: 45,
  speedMs: 0.3,
  routeSpacing: 0,
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAST = { readTimeoutMs: 40, retriesPerIndex: 1, maxPlans: 20, overallBudgetMs: 5_000 };

/**
 * A scripted mower: `plan(i)` describes what happens when index i is read. Each entry may
 * set `echoBeforeSendReturns` (the R14 MQTT race), `silent` (never answers), `echoIndex`
 * (what PlanIndex the echo carries), and `sendMs` (how long the invoke call takes).
 */
function scriptedDevice(registry, tasks, script = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      registry,
      send: async (planIndex) => {
        sent.push(planIndex);
        const rule = script[planIndex] ?? {};
        const echo = () => {
          if (rule.silent) return;
          const t = tasks[planIndex];
          registry.deliver({ ...t, planIndex: rule.echoIndex ?? t.planIndex });
        };
        if (rule.echoBeforeSendReturns) {
          echo();
          await tick(rule.sendMs ?? 5);
        } else {
          await tick(rule.sendMs ?? 1);
          setTimeout(echo, rule.echoDelayMs ?? 1);
        }
      },
    },
  };
}

test('R14: an echo that lands while the invoke call is still in flight is caught, not dropped', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = ['Achtertuin', 'VoortuinA', 'Laantje', 'Zijtuin', 'Task-1'].map((n, i) => task(i, n, 5));
  // Every read answers before its own send returns — the shape the old loop lost entirely.
  const script = Object.fromEntries(tasks.map((_, i) => [i, { echoBeforeSendReturns: true, sendMs: 10 }]));
  const { deps } = scriptedDevice(registry, tasks, script);

  const result = await enumerateSchedules(deps, FAST);

  assert.equal(result.complete, true);
  assert.deepEqual(result.collected.map((s) => s.taskName), ['Achtertuin', 'VoortuinA', 'Laantje', 'Zijtuin', 'Task-1']);
  assert.equal(result.totalPlanCount, 5);
  assert.equal(registry.pending, 0);
});

test('a silent read is retried once, and the retry answering keeps the enumeration going', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = [task(0, 'A', 3), task(1, 'B', 3), task(2, 'C', 3)];
  let firstReadOfOne = true;
  const { deps, sent } = scriptedDevice(registry, tasks, {});
  const send = deps.send;
  deps.send = async (i) => {
    if (i === 1 && firstReadOfOne) {
      firstReadOfOne = false;
      sent.push(i);
      await tick(1); // send "succeeds" but no echo ever comes for this attempt
      return;
    }
    return send(i);
  };

  const result = await enumerateSchedules(deps, FAST);

  assert.equal(result.complete, true);
  assert.deepEqual(result.collected.map((s) => s.taskName), ['A', 'B', 'C']);
  assert.deepEqual(sent, [0, 1, 1, 2]);
});

test('an index that stays silent after the retry ends the enumeration as incomplete', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = [task(0, 'A', 5), task(1, 'B', 5), task(2, 'C', 5), task(3, 'D', 5), task(4, 'E', 5)];
  const { deps, sent } = scriptedDevice(registry, tasks, { 2: { silent: true } });

  const result = await enumerateSchedules(deps, FAST);

  assert.equal(result.complete, false);
  assert.deepEqual(result.collected.map((s) => s.taskName), ['A', 'B']);
  assert.deepEqual(result.missedIndexes, [2]);
  assert.equal(result.totalPlanCount, 5);
  assert.deepEqual(sent, [0, 1, 2, 2]);
});

test('a late echo for an earlier index is not mistaken for the current read', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = [task(0, 'A', 3), task(1, 'B', 3), task(2, 'C', 3)];
  const { deps } = scriptedDevice(registry, tasks, {});
  const send = deps.send;
  let deliveredLateDuplicate = false;
  deps.send = async (i) => {
    await send(i);
    if (i === 2) {
      // A stale duplicate of B (already collected) arrives while we wait for C.
      deliveredLateDuplicate = registry.deliver(task(1, 'B', 3));
    }
  };

  const result = await enumerateSchedules(deps, FAST);

  assert.equal(deliveredLateDuplicate, false, 'the duplicate must be rejected, not consumed');
  assert.deepEqual(result.collected.map((s) => s.taskName), ['A', 'B', 'C']);
  assert.equal(result.complete, true);
});

test('safety valve: a NEW task echoed under an unexpected index is still accepted when it is the only pending read', async () => {
  const registry = new ScheduleEchoRegistry();
  // Firmware that always echoes PlanIndex 0 — every answer carries index 0.
  const tasks = [task(0, 'A', 3), task(1, 'B', 3), task(2, 'C', 3)];
  const script = { 1: { echoIndex: 0 }, 2: { echoIndex: 0 } };
  const { deps } = scriptedDevice(registry, tasks, script);

  const result = await enumerateSchedules(deps, FAST);

  assert.equal(result.complete, true);
  assert.deepEqual(result.collected.map((s) => s.planId), ['id-0', 'id-1', 'id-2']);
});

test('a send that throws is treated like a lost echo: retried, then the enumeration moves on or stops', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = [task(0, 'A', 2), task(1, 'B', 2)];
  const { deps } = scriptedDevice(registry, tasks, {});
  const send = deps.send;
  let threw = false;
  deps.send = async (i) => {
    if (i === 1 && !threw) { threw = true; throw new Error('Command timeout: read_schedule:1'); }
    return send(i);
  };

  const logs = [];
  const result = await enumerateSchedules({ ...deps, log: (l) => logs.push(l) }, FAST);

  assert.equal(result.complete, true);
  assert.deepEqual(result.collected.map((s) => s.taskName), ['A', 'B']);
  assert.ok(logs.some((l) => l.includes('send failed')), 'the failure is logged, not swallowed silently');
});

test('the registry only arms its timeout once, and cancel withdraws a waiter without an echo', async () => {
  const registry = new ScheduleEchoRegistry();
  const pending = registry.open(0);
  pending.arm(20);
  pending.arm(1_000); // second arm is ignored
  assert.equal(await pending.promise, null);
  assert.equal(registry.pending, 0);

  const other = registry.open(1);
  other.cancel();
  assert.equal(await other.promise, null);
  assert.equal(registry.deliver(task(1, 'B', 2)), false, 'nothing is waiting any more');
});

test('mergeScheduleCache: a complete enumeration replaces the cache, so deleted tasks disappear', () => {
  const previous = [task(0, 'Voortuin', 5, 'p0'), task(1, 'Old', 5, 'p1')];
  const collected = [task(0, 'VoortuinA', 2, 'p0'), task(1, 'Task-1', 2, 'p9')];
  const next = mergeScheduleCache(previous, { collected, complete: true });
  assert.deepEqual(next.map((s) => [s.planId, s.taskName]), [['p0', 'VoortuinA'], ['p9', 'Task-1']]);
});

test('mergeScheduleCache: a partial enumeration renames what it reached and keeps what it did not', () => {
  // R14: 5 known tasks, a read that only reached two of them. The old code left two.
  const previous = ['p0', 'p1', 'p2', 'p3', 'p4'].map((id, i) => task(i, `T${i}`, 5, id));
  const collected = [task(0, 'T0 renamed', 5, 'p0'), task(1, 'T1', 5, 'p1')];
  const next = mergeScheduleCache(previous, { collected, complete: false });
  assert.equal(next.length, 5, 'the list never shrinks on a flaky read');
  assert.equal(next.find((s) => s.planId === 'p0').taskName, 'T0 renamed');
  assert.deepEqual(next.slice(2).map((s) => s.planId), ['p2', 'p3', 'p4']);
});

test('mergeScheduleCache: nothing read leaves the cache untouched', () => {
  const previous = [task(0, 'A', 1, 'p0')];
  const next = mergeScheduleCache(previous, { collected: [], complete: false });
  assert.deepEqual(next, previous);
  assert.notEqual(next, previous, 'a copy, not the same array');
});

test('maxPlans caps the enumeration even when the device reports more', async () => {
  const registry = new ScheduleEchoRegistry();
  const tasks = Array.from({ length: 6 }, (_, i) => task(i, `T${i}`, 6));
  const { deps, sent } = scriptedDevice(registry, tasks, {});

  const result = await enumerateSchedules(deps, { ...FAST, maxPlans: 3 });

  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(result.collected.length, 3);
  assert.equal(result.complete, true, 'complete relative to the cap, so the cache is replaced deliberately');
});
