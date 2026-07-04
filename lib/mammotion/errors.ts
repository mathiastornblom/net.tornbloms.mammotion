'use strict';

/** Base class for all Mammotion errors. */
export class MammotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MammotionError';
  }
}

/** HTTP auth failed — wrong credentials or expired token. */
export class AuthError extends MammotionError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Token is expired and refresh also failed — user must re-login. */
export class SessionExpiredError extends AuthError {
  constructor() {
    super('Session expired — re-login required');
    this.name = 'SessionExpiredError';
  }
}

/** Device is offline on the cloud — the mower itself reported this via an MQTT invoke
 *  response's `code` field (50104), not a transport-level failure. Callers should reflect
 *  this on the Homey device's availability immediately rather than waiting for a
 *  status/telemetry signal that will never arrive from an offline device. */
export class DeviceOfflineError extends MammotionError {
  constructor(deviceName: string) {
    super(`Device ${deviceName} is offline`);
    this.name = 'DeviceOfflineError';
  }
}

/** A command sent via the primary Mammotion MQTT invoke endpoint failed with a non-zero
 *  `code` in the JSON response body that ISN'T the device-offline case (see
 *  DeviceOfflineError for that one) — e.g. an unrecognized command, a malformed payload,
 *  or a cloud-side error unrelated to device reachability. */
export class MqttCommandError extends MammotionError {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`MQTT command error ${code}: ${message}`);
    this.name = 'MqttCommandError';
    this.code = code;
  }
}

/** MQTT command timed out without a response. */
export class CommandTimeoutError extends MammotionError {
  constructor(command: string) {
    super(`Command timed out: ${command}`);
    this.name = 'CommandTimeoutError';
  }
}

/** The API returned an error response (non-zero code). */
export class ApiError extends MammotionError {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`API error ${code}: ${message}`);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** A command sent to a legacy-Aliyun-bound device via /thing/service/invoke failed —
 *  either the JSON body's `code` field was non-200 or the gateway returned HTTP 429.
 *  `code` is the raw Aliyun error code (e.g. 6205 device offline, 29004 device unbound,
 *  29003/460 auth expired, 429 rate-limited) — see pymammotion's `send_cloud_command`. */
export class AliyunCommandError extends MammotionError {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`Aliyun command error ${code}: ${message}`);
    this.name = 'AliyunCommandError';
    this.code = code;
  }
}

/** AliyunCredentialsManager's circuit breaker is open (too many recent handshake failures) —
 *  see lib/mammotion/aliyun/AliyunCredentialsManager.ts for why this exists (ported from
 *  pymammotion's TokenManager _ALIYUN_FAILURE_WINDOW/_ALIYUN_FAILURE_LIMIT). */
export class AliyunCircuitOpenError extends MammotionError {
  constructor(retryAfterMs: number) {
    super(`Aliyun legacy handshake circuit breaker open — too many recent failures, retry in ~${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'AliyunCircuitOpenError';
  }
}
