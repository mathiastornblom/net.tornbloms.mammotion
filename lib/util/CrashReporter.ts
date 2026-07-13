'use strict';

import https from 'https';
import { randomBytes } from 'crypto';
import { HOMEY_ENV } from './homeyEnv.js';

/**
 * Minimal crash-only Sentry reporter.
 *
 * Deliberately NOT the @sentry/node SDK: that package is ~10 MB and hooks deep
 * into the runtime, while all this app needs is a single HTTPS POST of a Sentry
 * envelope when the process is about to die. Homey hubs are memory-constrained
 * (Homey 3s), so the dependency weight matters.
 *
 * Scope is crashes ONLY — uncaught exceptions and unhandled promise rejections
 * that would terminate the app anyway. Handled/expected errors (BLE out of
 * range, cloud hiccups) are never sent; those belong in user-submitted
 * diagnostic reports.
 *
 * Privacy: reporting is controlled by the `crashReporting` app setting
 * (default on, disclosed in the App Store description). Messages and stack
 * traces are scrubbed of emails, JWTs, bearer tokens and long hex identifiers
 * before sending, and no hostname/server_name is included. The Sentry project
 * lives in the EU region (ingest.de.sentry.io).
 */

/** Ingest key — supplied via env.json (see lib/util/homeyEnv.ts), never committed to the repo. */
const SENTRY_KEY: string = HOMEY_ENV.SENTRY_KEY;
const SENTRY_HOST = 'o4507681623769088.ingest.de.sentry.io';
const SENTRY_PROJECT_ID = '4511667443859537';

/** How long to wait for the crash report to flush before letting the process die. */
const SEND_TIMEOUT_MS = 3_000;

interface InstallOptions {
  /** Sentry release string, e.g. "net.tornbloms.mammotion@2.3.0". */
  release: string;
  /** Homey firmware version, sent as a tag for triage. */
  homeyVersion: string;
  /** Read the user's crash-reporting consent at crash time (app setting, default on). */
  isEnabled: () => boolean;
  /** App logger for the local record of the crash (always logged, even when reporting is off). */
  log: (msg: string) => void;
}

/** Redacts likely-personal or secret substrings from crash text before it leaves the hub. */
export function scrub(text: string): string {
  return text
    // Email addresses (account names)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    // JWTs (access/refresh tokens are JWTs in this app)
    .replace(/eyJ[\w-]{8,}\.[\w-]{4,}\.[\w-]{4,}/g, '[jwt]')
    // Authorization header remnants
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [token]')
    // Long hex blobs (iotIds, device ids, MQTT client ids, session keys)
    .replace(/\b[A-Fa-f0-9]{20,}\b/g, '[hex-id]');
}

/** Converts a V8 stack trace into Sentry stacktrace frames (innermost last, per spec). */
function parseStack(stack: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|([^)]+))\)?\s*$/.exec(line);
    if (!m || (!m[2] && !m[5])) continue;
    frames.unshift({
      function: m[1] ?? '<anonymous>',
      filename: scrub(m[2] ?? m[5] ?? ''),
      lineno: m[3] ? Number(m[3]) : undefined,
      colno: m[4] ? Number(m[4]) : undefined,
      in_app: (m[2] ?? m[5] ?? '').includes('node_modules') === false,
    });
  }
  return frames;
}

/** POSTs one event envelope to Sentry; resolves when sent, failed, or timed out — never rejects. */
function sendEvent(event: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const eventId = event.event_id as string;
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');

    const req = https.request({
      hostname: SENTRY_HOST,
      path: `/api/${SENTRY_PROJECT_ID}/envelope/`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'Content-Length': Buffer.byteLength(envelope),
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=mammotion-homey/1.0, sentry_key=${SENTRY_KEY}`,
      },
      timeout: SEND_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(envelope);
    req.end();
  });
}

/** Builds the Sentry event payload for a fatal error, with all text scrubbed. */
function buildEvent(err: Error, opts: InstallOptions, mechanism: string): Record<string, unknown> {
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'fatal',
    release: opts.release,
    environment: 'production',
    tags: {
      homey_version: opts.homeyVersion,
      mechanism,
    },
    exception: {
      values: [{
        type: err.name || 'Error',
        value: scrub(err.message || String(err)),
        stacktrace: err.stack ? { frames: parseStack(err.stack) } : undefined,
        mechanism: { type: mechanism, handled: false },
      }],
    },
  };
}

/**
 * Installs process-level crash handlers that report to Sentry and then exit(1),
 * preserving Homey's normal crash/restart semantics. Call once from App.onInit.
 */
export function installCrashReporter(opts: InstallOptions): void {
  let crashing = false;

  const handle = (raw: unknown, mechanism: 'onuncaughtexception' | 'onunhandledrejection'): void => {
    // The process is terminating either way — exiting explicitly (rather than
    // throwing) preserves Homey's crash/restart semantics after the report is
    // flushed, and these timers die with the process.
    /* eslint-disable no-process-exit, homey-app/global-timers */

    // A second failure while reporting the first must not loop — die immediately.
    if (crashing) process.exit(1);
    crashing = true;

    const err = raw instanceof Error ? raw : new Error(String(raw));
    opts.log(`FATAL (${mechanism}): ${err.stack ?? err.message}`);

    const finish = (): void => process.exit(1);
    if (!opts.isEnabled()) {
      finish();
      return;
    }
    // Belt and braces: exit even if sendEvent's own timeout somehow never fires.
    const failsafe = setTimeout(finish, SEND_TIMEOUT_MS + 1_000);
    failsafe.unref();
    sendEvent(buildEvent(err, opts, mechanism)).then(finish, finish);
    /* eslint-enable no-process-exit, homey-app/global-timers */
  };

  process.on('uncaughtException', (err) => handle(err, 'onuncaughtexception'));
  process.on('unhandledRejection', (reason) => handle(reason, 'onunhandledrejection'));
}
