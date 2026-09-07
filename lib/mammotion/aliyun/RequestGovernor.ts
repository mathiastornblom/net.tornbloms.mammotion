'use strict';

/** Aliyun's own documented limit on send_cloud_command-style invoke calls — pymammotion's
 *  `_SEND_LIMIT = 600` per rolling 12h window (see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md Stage 3).
 *  That's ~1 request/72s on average with zero margin — this app's old flat 5s poll cadence
 *  for aliyun_legacy devices sent ~14x that (confirmed root cause of the repeated "mower goes
 *  unavailable, recovers after restart" reports: 2026-07-16 log IDs 6018d080/938a4a56,
 *  2026-07-18 log ID dc1bf4f1). Applies per Mammotion account, not per device — this app
 *  supports exactly one account per install (see LubaDriver's aliyunTransport doc comment),
 *  so one governor instance shared by every aliyun_legacy device is what actually reflects
 *  the real constraint, including for multi-mower accounts where each device polling
 *  independently would otherwise multiply the account's total request rate. */
export const ALIYUN_SEND_LIMIT = 600;
export const ALIYUN_SEND_LIMIT_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Polling is the predictable, high-volume consumer of the budget — capped well short of the
 *  real limit so infrequent, important user-initiated commands (start/stop/dock/etc., which
 *  never consult pollDelayMs) always still have room. */
const POLL_SAFETY_MARGIN = 0.85;

/** The slice of the real limit that polling must never eat into, whatever tier it is in.
 *  This — not the poll cap — is the only thing that ever stops polling outright. Sized so
 *  that a full day of the slowest poll tier (see POLL_DELAY_TIERS) plus a generous handful
 *  of user commands still fits. */
export const ALIYUN_COMMAND_RESERVE = 40;

/** How polling slows down as the *poll cap* fills: `[fraction of poll cap used, interval
 *  multiplier]`, ascending. Below the first fraction the multiplier is 1. At the default
 *  120 s idle cadence this is 120 s → 240 s → 600 s → 1800 s.
 *
 *  This replaces a binary cutoff at the poll cap. Two real diagnostic reports from the same
 *  two-mower account thirteen days apart (USER_REPORTS_INBOX R5/R8) both showed the log line
 *  `90 left in the current 12h window` frozen for an hour with zero telemetry while both
 *  mowers were working. 90 is exactly 600 − 510: once the cap was hit polling stopped dead,
 *  and since skipped polls record nothing, the count could only fall as old requests aged out
 *  — up to twelve hours of silence with nothing telling the user why. Two idle devices at
 *  120 s each are 720 requests per window against a cap of 510, so any two-mower account hit
 *  this wall every single window by construction. Slowing down progressively keeps *some*
 *  telemetry flowing at every level of usage and converges instead of cliffing. */
export const POLL_DELAY_TIERS: ReadonlyArray<readonly [number, number]> = [
  [0.60, 2],
  [0.80, 5],
  [0.95, 15],
];

/** Tracks legacy-Aliyun invoke-gateway request timestamps in a rolling window and tells the
 *  poll loop how hard to back off to protect the account-wide budget — a real rate limiter,
 *  not just a fixed interval guess. One instance is shared across every aliyun_legacy device
 *  on the account (see LubaDriver). */
export class AliyunRequestGovernor {

  private timestamps: number[] = [];
  private onChange: (() => void) | null = null;

  constructor(
    private readonly maxRequests: number = ALIYUN_SEND_LIMIT,
    private readonly windowMs: number = ALIYUN_SEND_LIMIT_WINDOW_MS,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) this.timestamps.shift();
  }

  /** The most requests polling alone may hold in the window. */
  pollCap(): number {
    return Math.floor(this.maxRequests * POLL_SAFETY_MARGIN);
  }

  /** Call once for every request actually sent through the legacy invoke gateway — both
   *  polls and explicit commands share the same account-wide budget, so both must be
   *  recorded here for the rolling window to reflect true usage. */
  recordRequest(now: number = Date.now()): void {
    this.prune(now);
    this.timestamps.push(now);
    this.onChange?.();
  }

  /** Requests currently inside the rolling window. */
  used(now: number = Date.now()): number {
    this.prune(now);
    return this.timestamps.length;
  }

  /** Requests left in the current rolling window before the real Aliyun limit. */
  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  /** 0 = normal cadence; each higher tier is one step slower per POLL_DELAY_TIERS. */
  usageTier(now: number = Date.now()): number {
    const fraction = this.used(now) / this.pollCap();
    let tier = 0;
    for (const [threshold] of POLL_DELAY_TIERS) if (fraction >= threshold) tier += 1;
    return tier;
  }

  /** Whether polling must stop outright: only when nothing but the command reserve is left.
   *  Deliberately *not* "the poll cap is reached" — reaching the cap slows polling (see
   *  pollDelayMs), it no longer stops it. User commands never consult this. */
  shouldSkipPoll(now: number = Date.now()): boolean {
    return this.remaining(now) <= ALIYUN_COMMAND_RESERVE;
  }

  /** The interval the poll loop should use right now, given a base cadence: the base
   *  multiplied by the current tier's factor, or null when polling must pause entirely
   *  (shouldSkipPoll). Callers that get null should re-check after the base interval
   *  without sending anything. */
  pollDelayMs(baseMs: number, now: number = Date.now()): number | null {
    if (this.shouldSkipPoll(now)) return null;
    const tier = this.usageTier(now);
    const multiplier = tier === 0 ? 1 : POLL_DELAY_TIERS[tier - 1][1];
    return baseMs * multiplier;
  }

  /** Registers a listener fired on every recordRequest — used by the driver to persist the
   *  window (see snapshot/restore) without the governor knowing about Homey settings. */
  setChangeListener(listener: (() => void) | null): void {
    this.onChange = listener;
  }

  /** The raw window, for persistence across app restarts. Without this a restart begins
   *  with an empty window and a burst of full-cadence polling straight into an account that
   *  may already be at its limit — the same restart-then-recover-then-fail pattern the
   *  original reports described. */
  snapshot(): number[] {
    return [...this.timestamps];
  }

  /** Reloads a persisted window, dropping anything malformed or already outside it. */
  restore(timestamps: unknown, now: number = Date.now()): void {
    if (!Array.isArray(timestamps)) return;
    this.timestamps = timestamps
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t <= now)
      .sort((a, b) => a - b);
    this.prune(now);
  }
}
