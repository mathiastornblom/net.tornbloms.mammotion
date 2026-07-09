'use strict';

/**
 * Extracts a device-pushed fault code — MctlSys.toapp_err_code (mctrl_sys.proto's
 * SysDevErrCode, oneof field 7). This is a distinct oneof branch from the periodic
 * toapp_report_data telemetry TelemetryParser.ts reads: per its position alongside the
 * other one-shot toapp_* pushes in MctlSys's oneof (not the repeating report cycle), the
 * mower raises this as its own message when a fault occurs, not as part of the 5s
 * telemetry report.
 *
 * Diagnostic-only for now: pymammotion's numeric code_no → fault meaning table isn't
 * ported yet (e.g. a wheel-lift/emergency-stop's exact value is unconfirmed against a
 * real device) — logged via device.ts so a real fault event's raw value can be collected
 * before mapping it to alarm_generic/mower_error. See docs/ROADMAP.md.
 */
export function extractErrorCode(msg: Record<string, unknown>): number | null {
  const sys = msg.sys as Record<string, unknown> | undefined;
  const err = sys?.toappErrCode as Record<string, unknown> | undefined;
  if (!err || typeof err.errorCode !== 'number') return null;
  return err.errorCode;
}

/**
 * Extracts MctlSys.systemUpdateBuf (mctrl_sys.proto's systemUpdateBuf_msg, oneof field
 * 27) — a completely undecoded message on our side until now. It's a flat
 * `repeated int64 update_buf_data`; per pymammotion's own handling of this same message
 * type, the first element is a "buf_id" tag distinguishing what the rest of the array
 * means, with different ids used for different device classes (confirmed: id 2 is
 * Spino/pool-cleaner-specific there, carrying an error_count + (code, timestamp) pair
 * list — but the mower-side id(s) were NOT confirmed before this was shelved, see
 * docs/WHEEL_LIFT_FAULT_DIAGNOSTIC_PLAN.md). Diagnostic-only: returns the raw array
 * unconditionally, whatever its first element is, so a real fault capture on an actual
 * mower can tell us empirically what this device class actually sends here — the one
 * candidate channel in the whole investigation that's never been observed at all yet.
 */
export function extractUpdateBuf(msg: Record<string, unknown>): number[] | null {
  const sys = msg.sys as Record<string, unknown> | undefined;
  const buf = sys?.systemUpdateBuf as Record<string, unknown> | undefined;
  const data = buf?.updateBufData;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(Number);
}
