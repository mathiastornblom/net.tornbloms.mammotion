'use strict';

/**
 * Judges whether a "start mowing" command actually took, from the mower's own status
 * reports in the seconds after it was sent. Pure so the verdict can be tested against the
 * exact timeline a real report showed.
 *
 * Why this exists: a diagnostic report (USER_REPORTS_INBOX R10) showed `generate_route` +
 * `start` sent eleven times in 26 minutes, every one acknowledged by the cloud with
 * `{"code":0,"msg":"Request success"}` — and the mower going mowing → paused → idle within
 * 16 s each time, never actually cutting. The user was seeing error 1417 in the official
 * app. From Homey's side every Flow action "succeeded". A cloud ack means the command was
 * delivered, not that the mower did anything with it. The only thing that says that is
 * the status that follows.
 */

export type StartOutcome = 'confirmed' | 'never_started' | 'started_then_stopped';

export interface StatusEvent {
  /** The mower_status value as this app maps it (see WorkModeStatus.ts). */
  status: string;
  /** Milliseconds after the start command was sent. */
  atMs: number;
}

/** Statuses that mean "the job is running". */
const RUNNING = new Set(['mowing']);
/** Statuses that, seen *after* running, mean the job stopped again on its own. */
const STOPPED_AFTER_RUNNING = new Set(['paused', 'idle', 'charging', 'returning', 'error']);

/**
 * `confirmed`  — the mower reported mowing and was still mowing at the end of the window.
 * `never_started` — it never reported mowing inside the window.
 * `started_then_stopped` — it reported mowing, then left that state again inside the window
 *   (R10's shape: mowing at +6 s, paused at +17 s, idle at +22 s).
 *
 * Events outside the window are ignored. Order within the array is by `atMs`.
 */
export function judgeStartOutcome(events: ReadonlyArray<StatusEvent>, windowMs: number): StartOutcome {
  let running = false;
  let stoppedAfter = false;
  for (const e of [...events].sort((a, b) => a.atMs - b.atMs)) {
    if (e.atMs < 0 || e.atMs > windowMs) continue;
    if (RUNNING.has(e.status)) { running = true; stoppedAfter = false; continue; }
    if (running && STOPPED_AFTER_RUNNING.has(e.status)) stoppedAfter = true;
  }
  if (!running) return 'never_started';
  return stoppedAfter ? 'started_then_stopped' : 'confirmed';
}
