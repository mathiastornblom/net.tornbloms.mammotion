/**
 * Enumerates a mower's stored tasks ("schedules") by reading planIndex 0, 1, 2, … and
 * catching each read's echo — the pure orchestration behind LubaDevice.runScheduleRefresh,
 * with the transport injected so the timing cases can be tested.
 *
 * Written against USER_REPORTS_INBOX R14 (v2.5.62, Luba Mini 2 over MQTT: 2 of 5 tasks under
 * old names, no refresh while running, 1 of 5 after a restart). Three defects in the previous
 * loop produced every number in that report, and each is a rule here:
 *
 *  1. The echo can arrive before anyone is listening. Over MQTT the send is an HTTPS invoke
 *     call that only returns once the cloud has heard back from the device, while the
 *     device's echo is pushed over MQTT and can land first. So a waiter is opened BEFORE the
 *     send, and its timeout is armed only once the send has returned — an echo that arrives
 *     mid-send is caught, and the read window is measured from when the request is actually
 *     out, not from before it.
 *  2. A partial enumeration replaced a complete cache. mergeScheduleCache() replaces the
 *     cache only when the enumeration is complete; a partial result is merged by planId so
 *     a flaky read can never make a task disappear from the picker.
 *  3. Echoes were not matched to the index asked for. A waiter accepts the echo carrying its
 *     own planIndex; a late echo for an earlier index (its planId already collected) is
 *     rejected rather than mistaken for the current one, which is what turned one dropped
 *     echo into an off-by-one cascade. As a safety valve for firmware that might echo an
 *     index we did not ask for, a mismatched echo whose planId is NOT yet collected is still
 *     accepted when it is the only pending waiter — a duplicate is the harmful case, a new
 *     task under an odd index is not.
 */
import type { ScheduleInfo } from './ScheduleParser.js';

export interface PendingEcho {
  /** Resolves with the matching echo, or null once the armed timeout elapses. */
  readonly promise: Promise<ScheduleInfo | null>;
  /** Starts the read window. Call after the send has returned (or failed). */
  arm(timeoutMs: number): void;
  /** Withdraws the waiter without resolving it to an echo. */
  cancel(): void;
}

interface Waiter {
  planIndex: number;
  knownPlanIds: ReadonlySet<string>;
  resolve(schedule: ScheduleInfo | null): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Holds the waiters for schedule-read echoes and routes each echo to the waiter it answers. */
export class ScheduleEchoRegistry {
  private waiters: Waiter[] = [];

  /** Opens a waiter for the echo of a read of `planIndex`. `knownPlanIds` are the tasks the
   *  enumeration has already collected, used to reject late duplicates. */
  open(planIndex: number, knownPlanIds: ReadonlySet<string> = new Set()): PendingEcho {
    let settle: (schedule: ScheduleInfo | null) => void = () => {};
    const promise = new Promise<ScheduleInfo | null>((resolve) => { settle = resolve; });
    const waiter: Waiter = {
      planIndex,
      knownPlanIds,
      timer: null,
      resolve: (schedule) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        settle(schedule);
      },
    };
    this.waiters.push(waiter);
    return {
      promise,
      arm: (timeoutMs) => {
        if (!this.waiters.includes(waiter) || waiter.timer) return;
        waiter.timer = setTimeout(() => waiter.resolve(null), timeoutMs);
      },
      cancel: () => { if (this.waiters.includes(waiter)) waiter.resolve(null); },
    };
  }

  /** Routes an echo to the waiter it answers. Returns true if a waiter consumed it, false
   *  if it was unsolicited or a late duplicate — the caller decides how to log that. */
  deliver(schedule: ScheduleInfo): boolean {
    const exact = this.waiters.find((w) => w.planIndex === schedule.planIndex);
    if (exact) {
      exact.resolve(schedule);
      return true;
    }
    if (this.waiters.length === 1 && !this.waiters[0].knownPlanIds.has(schedule.planId)) {
      this.waiters[0].resolve(schedule);
      return true;
    }
    return false;
  }

  /** Number of waiters currently open — diagnostics only. */
  get pending(): number {
    return this.waiters.length;
  }
}

export interface ScheduleEnumerationDeps {
  /** Sends the read for `planIndex`. May reject; the enumeration treats that like a lost echo. */
  send(planIndex: number): Promise<void>;
  registry: ScheduleEchoRegistry;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ScheduleEnumerationOptions {
  /** Read window per attempt, measured from when the send returned. */
  readTimeoutMs: number;
  /** Extra attempts per index after the first one times out. */
  retriesPerIndex: number;
  /** Hard cap on how many indexes are read, whatever totalPlanCount says. */
  maxPlans: number;
  /** Wall-clock cap on the whole enumeration. */
  overallBudgetMs: number;
}

export interface ScheduleEnumerationResult {
  /** Tasks read, in index order, deduplicated by planId. */
  collected: ScheduleInfo[];
  /** The count the device reported, or null if not even the first read answered. */
  totalPlanCount: number | null;
  /** True when every index the device reported was read (subject to maxPlans). */
  complete: boolean;
  /** Indexes that never answered, even after retries. */
  missedIndexes: number[];
}

export const DEFAULT_SCHEDULE_ENUMERATION: ScheduleEnumerationOptions = {
  readTimeoutMs: 5_000,
  retriesPerIndex: 1,
  maxPlans: 20,
  overallBudgetMs: 20_000,
};

/** Reads every stored task the device reports, index by index, opening each waiter before
 *  its send and retrying an index that never answered. Stops at the first index that stays
 *  silent after retries, at maxPlans, or when the wall-clock budget is spent. */
export async function enumerateSchedules(
  deps: ScheduleEnumerationDeps,
  options: ScheduleEnumerationOptions = DEFAULT_SCHEDULE_ENUMERATION,
): Promise<ScheduleEnumerationResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const deadline = now() + options.overallBudgetMs;
  const collected: ScheduleInfo[] = [];
  const knownPlanIds = new Set<string>();
  const missedIndexes: number[] = [];
  let totalPlanCount: number | null = null;

  const readOnce = async (planIndex: number): Promise<ScheduleInfo | null> => {
    const pending = deps.registry.open(planIndex, knownPlanIds);
    try {
      await deps.send(planIndex);
    } catch (err) {
      log(`read_schedule:${planIndex} send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    pending.arm(options.readTimeoutMs);
    return pending.promise;
  };

  let planIndex = 0;
  while (planIndex < (totalPlanCount ?? 1) && planIndex < options.maxPlans) {
    if (now() > deadline) {
      log(`schedule enumeration stopped at index ${planIndex}: wall-clock budget spent`);
      break;
    }
    let response: ScheduleInfo | null = null;
    for (let attempt = 0; attempt <= options.retriesPerIndex && !response; attempt += 1) {
      if (attempt > 0) log(`read_schedule:${planIndex} no echo, retry ${attempt}/${options.retriesPerIndex}`);
      response = await readOnce(planIndex);
    }
    if (!response) {
      missedIndexes.push(planIndex);
      break;
    }
    if (response.totalPlanCount > 0) totalPlanCount = response.totalPlanCount;
    if (!response.planId || !knownPlanIds.has(response.planId)) {
      collected.push(response);
      if (response.planId) knownPlanIds.add(response.planId);
    }
    planIndex += 1;
  }

  const expected = totalPlanCount === null ? null : Math.min(totalPlanCount, options.maxPlans);
  const complete = expected !== null && collected.length >= expected && missedIndexes.length === 0;
  return { collected, totalPlanCount, complete, missedIndexes };
}

/** Decides what the cache becomes after an enumeration. Complete → the new list, so tasks
 *  deleted on the device disappear. Partial → previous entries updated by planId (renames
 *  land), new ones added, unread ones kept — the list never shrinks on a flaky read. Nothing
 *  read → previous unchanged. */
export function mergeScheduleCache(
  previous: ReadonlyArray<ScheduleInfo>,
  result: Pick<ScheduleEnumerationResult, 'collected' | 'complete'>,
): ScheduleInfo[] {
  if (result.complete) return [...result.collected];
  if (result.collected.length === 0) return [...previous];
  const seen = new Set(result.collected.map((s) => s.planId).filter((id) => id !== ''));
  const kept = previous.filter((s) => s.planId === '' || !seen.has(s.planId));
  return [...result.collected, ...kept];
}
