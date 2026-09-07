'use strict';

/** Bytes shown before truncating. Long enough to cover the LubaMsg envelope plus the start
 *  of the nested payload — the region every observed decode failure has pointed into
 *  (`invalid wire type N at offset 35`, `index out of range: 41 + 10 > 41`) — and short
 *  enough that a burst of failures can't flood a user's diagnostic report. */
const DEFAULT_MAX_BYTES = 64;

/**
 * Renders a buffer as a space-separated hex string for diagnostic logs, truncated with a
 * trailing marker naming the true length.
 *
 * Exists because protobuf decode failures were logged with the decoder's own message and
 * nothing else, which is not enough to tell a truncated frame from a misparsed length
 * prefix — the two competing explanations for the `index out of range: N + 10 > N` signature
 * that recurred across multiple users' reports with different N. Without the bytes, every
 * such report can only ever confirm that decoding failed, never why. Content is mower
 * telemetry, not credentials, and the cap bounds how much of it a report can carry.
 */
export function hexPreview(buf: Buffer, maxBytes: number = DEFAULT_MAX_BYTES): string {
  if (buf.length === 0) return '(0 bytes)';
  const shown = buf.subarray(0, maxBytes).toString('hex').replace(/(..)/g, '$1 ').trim();
  return buf.length > maxBytes ? `${shown} … (${buf.length} bytes total)` : `${shown} (${buf.length} bytes)`;
}
