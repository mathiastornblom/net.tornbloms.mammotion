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
