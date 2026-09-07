'use strict';

/**
 * When silence from a mower stops being "expected" and becomes "stale". Pure so the rule
 * can be tested and simulated without a Homey device.
 *
 * Why this exists: a real diagnostic report (USER_REPORTS_INBOX R12.3) came with a screenshot
 * of the device page showing "last updated 2026-07-30" on 2026-08-04 — five days old — beside
 * "Error: No", "Status: Charging", battery cycles and RTK fix, all rendered as if current.
 * The only tell was the small "5 days ago" under the Wi-Fi value. The app was not lying, but
 * it was not telling the truth loudly enough, and the user reported "status is not updating"
 * rather than "Homey has lost the mower" — which is what had actually happened.
 *
 * The known causes of silence each carry their own signal now (budget pacing → warning,
 * account penalty → warning, unbound → unavailable, device offline → unavailable). This is
 * the catch-all for silence with *no* known cause: it does not care why, only how long.
 *
 * Why the threshold is relative and not a fixed number: on `aliyun_legacy` the poll loop
 * itself legitimately chooses intervals up to 30 min (budget tiers, penalty backoff), while
 * on MQTT telemetry arrives every few seconds. One fixed value would either flag healthy
 * throttled devices as dead or let a dead MQTT device sit for half an hour. So the rule is
 * "three times whatever interval we ourselves last scheduled", with a floor so a fast
 * cadence still gets a sensible grace period. Missing three consecutive expected updates is
 * the point at which the transport's own retry logic has clearly not recovered on its own.
 */

/** Never flag staleness sooner than this, whatever the cadence — a couple of missed polls
 *  plus one backoff step on a fast cadence is not yet a lost mower. */
export const STALE_FLOOR_MS = 10 * 60_000;

/** How many consecutive expected updates may be missed before the data is considered stale. */
export const STALE_INTERVAL_MULTIPLIER = 3;

/** Silence longer than this, given the interval the poll loop last scheduled, is stale. */
export function staleAfterMs(expectedIntervalMs: number): number {
  const interval = Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0 ? expectedIntervalMs : 0;
  return Math.max(STALE_FLOOR_MS, interval * STALE_INTERVAL_MULTIPLIER);
}

/** Whether telemetry last received at `lastTelemetryAt` is stale at `now`. A null
 *  `lastTelemetryAt` (nothing received yet since the transports started) is never stale —
 *  the caller baselines it at start so a restart does not trip on a days-old stored value
 *  before the transports have had a chance. */
export function isTelemetryStale(lastTelemetryAt: number | null, now: number, expectedIntervalMs: number): boolean {
  if (lastTelemetryAt === null) return false;
  return now - lastTelemetryAt > staleAfterMs(expectedIntervalMs);
}
