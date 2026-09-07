'use strict';

/**
 * How the legacy-Aliyun poll loop backs off after a failure, by *what* failed. Pure so the
 * ladders can be tested and simulated without a Homey device.
 *
 * Why three ladders and not one: a real diagnostic report (USER_REPORTS_INBOX R7) showed
 * `next check in 60s` repeated up to failure #1374 — a full day — alternating between
 * `rate-limited by Aliyun` and `gateway error (29004)`. One exponential ladder, capped at
 * 60 s, was being applied to every failure. That cap is right for a mower that is merely
 * powered off (someone switching it back on expects Homey to notice within a minute) and
 * wrong for everything else: retrying an account-wide 429 every 60 s is 720 requests per
 * 12 h window against Aliyun's 600 limit, so the retry loop sustained the very rate limit
 * it was retrying against. And 29004 is DEVICE_UNBOUND (see commands.ts) — the mower is no
 * longer bound to this account on Aliyun's side — which no amount of polling can fix; only
 * the user re-pairing can. Polling it every minute just burned budget and produced the 429s.
 */
export type PollFailureKind = 'device_offline' | 'account_penalty' | 'device_unbound';

/** Mower unreachable but the account is fine: keep checking often, it may come back. */
export const OFFLINE_BACKOFF_BASE_MS = 10_000;
export const OFFLINE_BACKOFF_MAX_MS = 60_000;

/** Account-wide penalty (429, gateway errors, credentials/circuit failures): the only cure
 *  is to stop asking. 60 s → 2 → 4 → 8 → 16 → 30 min, then 30 min flat. Over 12 h of a
 *  permanent penalty this sends ~26 requests instead of 720. */
export const ACCOUNT_BACKOFF_BASE_MS = 60_000;
export const ACCOUNT_BACKOFF_MAX_MS = 30 * 60_000;

/** Device unbound from the account: nothing we send will succeed until the user repairs
 *  the device, so there is no ladder to climb — check rarely, in case they already did. */
export const UNBOUND_BACKOFF_MS = 30 * 60_000;

/** Consecutive account penalties before the device shows a warning about it. Three is
 *  ~7 minutes into the ladder — long enough to rule out a single transient 429. */
export const ACCOUNT_PENALTY_WARN_AFTER = 3;

/** Consecutive unbound responses before the device is marked unavailable with a repair
 *  prompt. Two, so one stray 29004 in an otherwise-healthy session does not flip
 *  availability — but a second one 30 minutes later is not a blip. */
export const UNBOUND_UNAVAILABLE_AFTER = 2;

/** Delay before the next poll after the Nth consecutive failure of the given kind (N ≥ 1). */
export function pollBackoffMs(kind: PollFailureKind, consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  switch (kind) {
    case 'device_offline':
      // Identical to the pre-existing ladder (10 s × 2^n from n=1): 20 s, 40 s, 60 s, 60 s…
      return Math.min(OFFLINE_BACKOFF_BASE_MS * (2 ** n), OFFLINE_BACKOFF_MAX_MS);
    case 'account_penalty':
      return Math.min(ACCOUNT_BACKOFF_BASE_MS * (2 ** (n - 1)), ACCOUNT_BACKOFF_MAX_MS);
    case 'device_unbound':
      return UNBOUND_BACKOFF_MS;
    default:
      return OFFLINE_BACKOFF_MAX_MS;
  }
}

/** Composes a failure backoff with the budget governor's paced interval: the slower of the
 *  two wins. A backoff must never let a device retry *faster* than the account's budget
 *  tier allows — otherwise an offline mower on a budget-starved account would retry every
 *  60 s straight past the pacing that exists to prevent exactly that. `null` pacing means
 *  the governor has paused polling entirely; the backoff alone then decides when to
 *  re-check (the poll loop re-consults the governor before actually sending). */
export function composeWithPacing(backoffMs: number, pacedMs: number | null): number {
  return pacedMs === null ? backoffMs : Math.max(backoffMs, pacedMs);
}
