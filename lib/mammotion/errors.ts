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

/** Device is offline on the cloud. */
export class DeviceOfflineError extends MammotionError {
  constructor(deviceName: string) {
    super(`Device ${deviceName} is offline`);
    this.name = 'DeviceOfflineError';
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
