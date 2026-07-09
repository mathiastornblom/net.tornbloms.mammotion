'use strict';

/**
 * Extracts a human-readable message from a thrown/rejected value. Uses duck-typing (a
 * string `message` property) instead of `instanceof Error` — a real production capture
 * showed `fetchDevices` rejections logged as the useless `MQTT connect failed: fetchDevices:
 * [object Object]`, which only happens if the rejection value fails `instanceof Error` in
 * the catching realm (e.g. a Node core module surfacing a error-shaped object across an
 * async boundary) and therefore falls through to `String(err)`. Reading `.message` directly
 * survives that mismatch since it's a plain property access, not a prototype check.
 */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
