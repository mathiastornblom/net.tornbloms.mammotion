'use strict';

import type { AuthSession } from '../auth/types.js';
import { probeLegacyAliyunDevices, type AliyunLegacyCredentials } from './AliyunLegacyProbe.js';
import { AliyunCircuitOpenError } from '../errors.js';

/**
 * Persisted-credentials + expiry-aware reuse + circuit breaker for the legacy Aliyun
 * handshake, scoped down from pymammotion's `pymammotion/auth/token_manager.py` (its
 * `TokenManager` class) — see docs/ALIYUN_MQTT_TRANSPORT_PLAN.md for the wider context.
 *
 * Why this exists: LubaDriver previously cached credentials only in memory, with no expiry
 * check and no persistence, so a rejected handshake (e.g. a real ETIMEDOUT/loginByOAuth
 * failure seen in a diagnostic report on 2026-07-04) meant every subsequent ~5-10s poll tick
 * re-ran the ENTIRE 6-step handshake from scratch — hammering Aliyun's servers and directly
 * contributing to the rate-limiting (HTTP 429) also observed that same day. pymammotion avoids
 * this with three things this class ports in scoped form:
 *
 *   1. Persisted, expiry-aware reuse — credentials are cached with an expiry timestamp and
 *      only refreshed once they're close to expiring, not on every call.
 *   2. A caller-supplied load/save pair so credentials survive an app restart (wired to
 *      Homey's settings storage by LubaDriver) instead of a fresh login every time.
 *   3. A circuit breaker (pymammotion's _ALIYUN_FAILURE_WINDOW/_ALIYUN_FAILURE_LIMIT) — after
 *      repeated failures within a short window, further calls fail immediately without
 *      touching the network, instead of continuing to hammer an already-struggling account.
 *
 * NOT ported: pymammotion's separate lightweight `refresh_token_v2` (a cheaper refresh than
 * a full re-login). Aliyun's refreshToken/refreshTokenExpire fields are captured but this
 * app doesn't yet call the refresh endpoint — an expired credential re-runs the full 6-step
 * probe, same as before. That's a smaller, separate piece of work (see
 * docs/ALIYUN_MQTT_TRANSPORT_PLAN.md Stage 3) — this class only fixes the "re-probe on every
 * single call" and "no circuit breaker" problems, which is what the real diagnostic reports
 * actually showed happening.
 */

/** How long before iotToken's real expiry to proactively treat it as stale — pymammotion's
 *  TokenManager uses a 1-hour buffer for its Aliyun IoT token; matched here. */
export const ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS = 60 * 60 * 1000;

/** Circuit breaker shape ported from pymammotion's TokenManager
 *  (_ALIYUN_FAILURE_WINDOW=120s / _ALIYUN_FAILURE_LIMIT=2). */
export const ALIYUN_CIRCUIT_BREAKER_WINDOW_MS = 120_000;
export const ALIYUN_CIRCUIT_BREAKER_LIMIT = 2;

/** Pure — true if credentials won't expire within the refresh buffer window. Split out from
 *  the class so it's testable without a real handshake or fake timers. */
export function isCredentialsFresh(
  expiresAt: number,
  now: number,
  bufferMs: number = ALIYUN_CREDENTIALS_REFRESH_BUFFER_MS,
): boolean {
  return expiresAt - now > bufferMs;
}

/** Pure — drops failure timestamps older than the window, keeping only ones still "recent". */
export function pruneFailures(
  failures: readonly number[],
  now: number,
  windowMs: number = ALIYUN_CIRCUIT_BREAKER_WINDOW_MS,
): number[] {
  return failures.filter((t) => now - t < windowMs);
}

/** Pure — true once `limit` failures have landed within the window (after pruning stale ones). */
export function isCircuitOpen(
  failures: readonly number[],
  now: number,
  windowMs: number = ALIYUN_CIRCUIT_BREAKER_WINDOW_MS,
  limit: number = ALIYUN_CIRCUIT_BREAKER_LIMIT,
): boolean {
  return pruneFailures(failures, now, windowMs).length >= limit;
}

/** Pure — ms until the circuit breaker would close again, given the current failure list.
 *  0 if the circuit isn't open. Used only for the error message — callers should retry
 *  whenever they next get a chance, not necessarily wait exactly this long. */
export function circuitRetryAfterMs(
  failures: readonly number[],
  now: number,
  windowMs: number = ALIYUN_CIRCUIT_BREAKER_WINDOW_MS,
): number {
  const pruned = pruneFailures(failures, now, windowMs);
  if (pruned.length === 0) return 0;
  return Math.max(0, windowMs - (now - pruned[0]));
}

export class AliyunCredentialsManager {

  private credentials: AliyunLegacyCredentials | null;
  private inFlight: Promise<AliyunLegacyCredentials> | null = null;
  private failures: number[] = [];
  private readonly load: () => AliyunLegacyCredentials | null;
  private readonly save: (credentials: AliyunLegacyCredentials | null) => void;
  private readonly log: (msg: string) => void;
  private readonly logError: (msg: string) => void;
  private readonly now: () => number;
  private readonly probe: (session: AuthSession) => Promise<{ credentials?: AliyunLegacyCredentials }>;

  constructor(opts: {
    /** Reads previously-persisted credentials (e.g. from Homey settings) — called once, at
     *  construction, so a restarted app doesn't force a fresh login on first use. */
    load: () => AliyunLegacyCredentials | null;
    /** Persists (or clears, when null) credentials whenever they're refreshed/invalidated. */
    save: (credentials: AliyunLegacyCredentials | null) => void;
    log: (msg: string) => void;
    logError: (msg: string) => void;
    /** Injectable clock for tests — defaults to Date.now. */
    now?: () => number;
    /** Injectable handshake for tests — defaults to the real probeLegacyAliyunDevices. */
    probe?: (session: AuthSession) => Promise<{ credentials?: AliyunLegacyCredentials }>;
  }) {
    this.load = opts.load;
    this.save = opts.save;
    this.log = opts.log;
    this.logError = opts.logError;
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? probeLegacyAliyunDevices;
    this.credentials = this.load();
  }

  /** Returns valid credentials, reusing the cached/persisted set if not close to expiring,
   *  otherwise running the full handshake (unless the circuit breaker is currently open).
   *  Concurrent callers share one in-flight refresh rather than each starting their own. */
  async ensure(session: AuthSession): Promise<AliyunLegacyCredentials> {
    const now = this.now();
    if (this.credentials && isCredentialsFresh(this.credentials.iotTokenExpiresAt, now)) {
      return this.credentials;
    }
    if (isCircuitOpen(this.failures, now)) {
      throw new AliyunCircuitOpenError(circuitRetryAfterMs(this.failures, now));
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh(session).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refresh(session: AuthSession): Promise<AliyunLegacyCredentials> {
    try {
      const result = await this.probe(session);
      if (!result.credentials) throw new Error('Aliyun legacy handshake succeeded but returned no credentials');
      this.credentials = result.credentials;
      this.save(this.credentials);
      this.failures = [];
      this.log(`credentials refreshed, valid until ${new Date(result.credentials.iotTokenExpiresAt).toISOString()}`);
      return result.credentials;
    } catch (err) {
      this.failures.push(this.now());
      this.logError(`Aliyun credentials refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Seeds the cache from a probe result the caller already has (e.g. pairing's list_devices,
   *  which runs the full handshake anyway) — avoids an unnecessary second handshake the
   *  moment the first newly-paired legacy device initializes. */
  seed(credentials: AliyunLegacyCredentials): void {
    this.credentials = credentials;
    this.save(credentials);
  }

  /** Drops cached/persisted credentials so the next ensure() call re-runs the handshake —
   *  call this after a command fails with an auth-expiry code (460/29003), before retrying,
   *  rather than retrying with the same stale token. Does not touch the failure/circuit
   *  breaker state — an auth-expiry rejection is expected/recoverable, not a sign of an
   *  unreachable or struggling backend. */
  invalidate(): void {
    this.credentials = null;
    this.save(null);
  }

  /** Whether a credentials refresh is currently possible without hitting the circuit
   *  breaker — exposed for diagnostics/logging, not required for normal use. */
  get isCircuitBreakerOpen(): boolean {
    return isCircuitOpen(this.failures, this.now());
  }
}
