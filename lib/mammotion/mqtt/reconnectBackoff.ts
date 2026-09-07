'use strict';

/**
 * How long to wait before the Nth consecutive MQTT reconnect attempt. Pure so the ladder
 * can be tested and its per-half-hour cost stated exactly.
 *
 * Why it exists: a real diagnostic report (USER_REPORTS_INBOX R10) showed Mammotion's
 * broker refusing connections (ECONNREFUSED, then ECONNRESET, then connack timeout) for
 * about thirty minutes. The old ladder was linear — 10 s × attempt, capped at 60 s — so
 * once past attempt 6 it reconnected every minute for the rest of the outage: ~30 attempts,
 * each of which also fired three post-connect reads against the dead transport, for ~90
 * error lines that said the same thing. Nothing about a refused broker gets better by
 * asking again in a minute. The first step is kept short so a transient blip still
 * recovers fast; the cap is what changes.
 */
export const MQTT_RECONNECT_BASE_MS = 10_000;
export const MQTT_RECONNECT_MAX_MS = 5 * 60_000;

/** 10 s, 20 s, 40 s, 80 s, 160 s, then 5 min flat. Attempt numbers below 1 count as 1. */
export function mqttReconnectDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(MQTT_RECONNECT_BASE_MS * (2 ** (n - 1)), MQTT_RECONNECT_MAX_MS);
}
