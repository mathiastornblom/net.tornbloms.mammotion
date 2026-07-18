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
 *  always bypass this check, see shouldSkipPoll's doc comment) always still have room. */
const POLL_SAFETY_MARGIN = 0.85;

/** Tracks legacy-Aliyun invoke-gateway request timestamps in a rolling window and tells the
 *  poll loop when to back off to protect the account-wide budget — a real rate limiter, not
 *  just a fixed interval guess. One instance is shared across every aliyun_legacy device on
 *  the account (see LubaDriver). */
export class AliyunRequestGovernor {

  private timestamps: number[] = [];

  constructor(
    private readonly maxRequests: number = ALIYUN_SEND_LIMIT,
    private readonly windowMs: number = ALIYUN_SEND_LIMIT_WINDOW_MS,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) this.timestamps.shift();
  }

  /** Call once for every request actually sent through the legacy invoke gateway — both
   *  polls and explicit commands share the same account-wide budget, so both must be
   *  recorded here for the rolling window to reflect true usage. */
  recordRequest(now: number = Date.now()): void {
    this.prune(now);
    this.timestamps.push(now);
  }

  /** Whether the poll loop should skip this tick to preserve budget for commands. Never
   *  applied to explicit user commands — those are rare and important enough to always go
   *  through; they still call recordRequest() so subsequent polls see the reduced budget. */
  shouldSkipPoll(now: number = Date.now()): boolean {
    this.prune(now);
    return this.timestamps.length >= Math.floor(this.maxRequests * POLL_SAFETY_MARGIN);
  }

  /** Requests left in the current rolling window — for logging/diagnostics only. */
  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }
}
